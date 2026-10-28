#!/usr/bin/env python3
from pathlib import Path
from tempfile import TemporaryDirectory
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
import json
import os
import shutil
import subprocess
import sys
import threading
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import LoopbackHTTPServer, extension_directory


ROOT = Path(__file__).resolve().parents[2]
EXTENSION = extension_directory()
HTML_PATH = Path("/tmp/轻舟-两篇论文关系分析.html")
SCREENSHOT_PATH = Path("/tmp/qingzhou-session-export-smoke.png")
NIGHT_SCREENSHOT_PATH = Path("/tmp/qingzhou-session-export-smoke-night.png")
MOBILE_SCREENSHOT_PATH = Path("/tmp/qingzhou-session-export-smoke-mobile.png")
BRIDGE_SCREENSHOT_PATH = Path("/tmp/qingzhou-session-export-import-cta.png")
PAGES_ALLOWED_SCREENSHOT_PATH = Path("/tmp/qingzhou-pages-import-allowed.png")
PAGES_DENIED_SCREENSHOT_PATH = Path("/tmp/qingzhou-pages-import-denied.png")
OWNED_TAB_URLS = [
    "https://workspace.example.test/search?q=42",
    "https://workspace.example.test/project/42#resume",
    "https://workspace.example.test/reference/42",
]
WORKING_TAB_URL = OWNED_TAB_URLS[1]


def chrome_executable(bundled=""):
    candidates = [
        os.environ.get("CHROME_EXECUTABLE", ""),
        bundled,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        str(Path(os.environ["LOCALAPPDATA"]) / "Google/Chrome/Application/chrome.exe")
        if os.environ.get("LOCALAPPDATA") else "",
        str(Path(os.environ["PROGRAMFILES"]) / "Google/Chrome/Application/chrome.exe")
        if os.environ.get("PROGRAMFILES") else "",
        str(Path(os.environ["PROGRAMFILES(X86)"]) / "Google/Chrome/Application/chrome.exe")
        if os.environ.get("PROGRAMFILES(X86)") else "",
    ]
    return next((path for path in candidates if path and Path(path).exists()), "")


def extension_id(context, user_data_dir, extension_dir):
    workers = [worker for worker in context.service_workers if worker.url.startswith("chrome-extension://")]
    if workers:
        return workers[0].url.split("/")[2]
    try:
        worker = context.wait_for_event(
            "serviceworker",
            predicate=lambda item: item.url.startswith("chrome-extension://"),
            timeout=3000,
        )
        return worker.url.split("/")[2]
    except Exception:
        pass
    for _ in range(40):
        for relative in (Path("Default/Preferences"), Path("Preferences")):
            preferences = Path(user_data_dir) / relative
            if not preferences.exists():
                continue
            try:
                settings = json.loads(preferences.read_text(encoding="utf-8")).get("extensions", {}).get("settings", {})
                for ext_id, record in settings.items():
                    path = record.get("path") or record.get("manifest", {}).get("path") or ""
                    if path and Path(path).resolve() == extension_dir.resolve():
                        return ext_id
            except (OSError, ValueError):
                pass
        time.sleep(0.25)
    raise RuntimeError("Unable to resolve loaded extension id")


@contextmanager
def serve_export_html(html):
    body = html.encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format, *_args):
            return

    server = LoopbackHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/session.html"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def open_routed_export(context, html):
    page = context.new_page()
    page.route(
        "https://alibaba.github.io/**",
        lambda route: route.fulfill(
            status=200,
            content_type="text/html; charset=utf-8",
            body=html,
        ),
    )
    page.route("https://registry.npmmirror.com/**", lambda route: route.abort())
    return page


def expected_import_label(page):
    lang = (page.locator("html").get_attribute("lang") or "").lower()
    if lang.startswith("zh"):
        return "导入轻舟继续对话"
    if lang.startswith("en"):
        return "Continue in qz"
    raise AssertionError(f"unexpected export language {lang!r}")


def assert_allowlisted_https_page_offers_import(context, html):
    allowed_url = "https://alibaba.github.io/qz-browser-agent/examples/travel/"
    allowed = open_routed_export(context, html)
    try:
        allowed_errors = []
        allowed.on("pageerror", lambda error: allowed_errors.append(str(error)))
        allowed.on("console", lambda message: allowed_errors.append(message.text) if message.type == "error" else None)
        allowed.goto(allowed_url, wait_until="domcontentloaded")
        allowed.wait_for_selector("#qingzhou-session-cta[data-qingzhou-session-import]", timeout=10000)
        assert allowed.locator("#qingzhou-session-cta").text_content() == expected_import_label(allowed)
        allowed.screenshot(path=str(PAGES_ALLOWED_SCREENSHOT_PATH))
        assert allowed_errors == [], json.dumps(allowed_errors, ensure_ascii=False)
    finally:
        allowed.close()


def assert_unlisted_https_origin_hides_import(context, extension_page, html):
    denied_url = "https://alibaba.github.io/other-repo/session.html"
    denied = open_routed_export(context, html)
    try:
        denied_errors = []
        denied.on("pageerror", lambda error: denied_errors.append(str(error)))
        denied.on("console", lambda message: denied_errors.append(message.text) if message.type == "error" else None)
        denied.goto(denied_url, wait_until="domcontentloaded")
        denied.wait_for_selector("#qingzhou-session-cta", state="attached", timeout=10000)
        observation = denied.evaluate(
            """() => new Promise(resolve => {
              let results = 0;
              const onMessage = event => {
                if (event.source !== window || event.data?.type !== "qingzhou:session-export:result") return;
                results += 1;
              };
              window.addEventListener("message", onMessage);
              window.postMessage({
                type: "qingzhou:session-export:probe",
                requestId: "allowlist-denied",
              }, location.origin);
              setTimeout(() => {
                window.removeEventListener("message", onMessage);
                const cta = document.getElementById("qingzhou-session-cta");
                resolve({
                  results,
                  importable: Boolean(cta?.hasAttribute("data-qingzhou-session-import")),
                  hidden: cta?.hidden === true,
                  text: cta?.textContent || "",
                });
              }, 500);
            })"""
        )
        bridge = extension_page.evaluate(
            """async url => {
              const tabs = await chrome.tabs.query({});
              const tab = tabs.find(item => item.url === url);
              if (!tab?.id) return { found: false, urls: tabs.map(item => item.url || "") };
              const [injected] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => window.__QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION || "",
              });
              return { found: true, version: injected?.result || "" };
            }""",
            denied_url,
        )
        assert bridge["found"], json.dumps(bridge, ensure_ascii=False)
        assert bridge["version"], json.dumps(bridge, ensure_ascii=False)
        assert observation["results"] == 0, observation
        assert observation["importable"] is False, observation
        assert observation["hidden"] is True, observation
        assert observation["text"] == "", observation
        assert denied.locator("#qingzhou-session-cta[data-qingzhou-session-import]").count() == 0
        denied.screenshot(path=str(PAGES_DENIED_SCREENSHOT_PATH))
        assert denied_errors == [], json.dumps(denied_errors, ensure_ascii=False)
    finally:
        denied.close()


def run():
    with TemporaryDirectory(prefix="qingzhou-session-exchange-") as temporary_dir, sync_playwright() as playwright:
        user_data_dir = Path(temporary_dir) / "profile"
        extension_dir = Path(temporary_dir) / "extension"
        shutil.copytree(EXTENSION, extension_dir)
        subprocess.run([
            "node", str(ROOT / "tests/support/benchmark-assets.mjs"),
            str(extension_dir), str(extension_dir / "sidepanel"), "--extension",
        ], cwd=ROOT, check=True)
        executable = chrome_executable(playwright.chromium.executable_path)
        if not executable:
            raise RuntimeError("Session exchange E2E requires Chrome or CHROME_EXECUTABLE")
        context = playwright.chromium.launch_persistent_context(
            user_data_dir,
            headless=os.environ.get("SESSION_EXCHANGE_HEADLESS", "1") != "0",
            locale="zh-CN",
            executable_path=executable,
            ignore_default_args=["--disable-extensions"],
            viewport={"width": 980, "height": 860},
            args=[
                "--lang=zh-CN",
                f"--disable-extensions-except={extension_dir}",
                f"--load-extension={extension_dir}",
                "--disable-extensions-file-access-check",
            ],
        )
        try:
            context.route(
                "https://workspace.example.test/**",
                lambda route: route.fulfill(
                    status=200,
                    content_type="text/html; charset=utf-8",
                    body="<title>导出的工作页</title><main>restored workspace</main>",
                ),
            )
            ext_id = extension_id(context, user_data_dir, extension_dir)
            page = context.new_page()
            page.add_init_script("window.__QZ_CONVERSATION_BENCHMARK__ = true")
            sidepanel_errors = []
            heavy_requests = []
            page.on("request", lambda request: heavy_requests.append(request.url)
                    if any(part in request.url for part in ("/vendor/mathjax/", "/data-grid-vendor.js", "xlsx.")) else None)
            page.on("pageerror", lambda error: sidepanel_errors.append(str(error)))
            page.on("console", lambda message: sidepanel_errors.append(message.text) if message.type == "error" else None)
            page.goto(f"chrome-extension://{ext_id}/sidepanel/sidepanel.html")
            page.evaluate("() => chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: false } })")
            page.locator("[data-consent-accept]").click()
            try:
                page.wait_for_function("() => Boolean(window.qingzhouConversationBenchmark?.renderSessionDocument)")
            except Exception:
                raise AssertionError(json.dumps(sidepanel_errors, ensure_ascii=False, indent=2))
            session_id = "session-exchange-visual"
            page.evaluate(
                """async ({ sessionId }) => {
                  const codec = await import(chrome.runtime.getURL("shared/session/session-codec.js"));
                  const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5xkAAAAASUVORK5CYII=";
                  const conversation = codec.serializeConversation([
                    {
                      role: "user",
                      content: [
                        { type: "text", text: "整理这批网页资料，并保留公式与代码。" },
                        { type: "image_url", image_url: { url: imageDataUrl, detail: "auto" } },
                      ],
                    },
                    { role: "assistant", content: "我先检查页面，再整理结果。" },
                    { role: "assistant", content: "## 结果\\n\\n公式：$E=mc^2$\\n\\n```js\\nconst ok = true;\\n```" },
                  ]);
                  const transcript = [
                    {
                      type: "user",
                      text: "整理这批网页资料，并保留公式与代码。",
                      images: [{ dataUrl: imageDataUrl, name: "fixture.png", type: "image/png" }],
                      timestamp: "2026-07-10 10:00:00",
                    },
                    { type: "thinking", text: "先确认页面结构。", timestamp: "2026-07-10 10:00:01", runId: "run_1" },
                    { type: "thinking", text: "再提取正文。", timestamp: "2026-07-10 10:00:02", runId: "run_1" },
                    {
                      type: "tool", name: "missing_skill__inspect", toolCallId: "call_1",
                      args: {
                        target: "root",
                        _pageUrl: "https://workspace.example.test/search?q=42",
                      },
                      result: {
                        ok: true,
                        nodes: 8,
                      },
                      phase: "done", argsState: "final", isRunning: false, isError: false,
                      timestamp: "2026-07-10 10:00:03", endedAt: "2026-07-10 10:00:04", runId: "run_1",
                    },
                    {
                      type: "tool", name: "missing_skill__collect", toolCallId: "call_2",
                      args: { limit: 3 }, result: { ok: true, rows: [{ title: "A" }, { title: "B" }] },
                      phase: "done", argsState: "final", isRunning: false, isError: false,
                      timestamp: "2026-07-10 10:00:05", endedAt: "2026-07-10 10:00:06", runId: "run_1",
                    },
                    { type: "assistant", content: "## 结果\\n\\n公式：$E=mc^2$\\n\\n```js\\nconst ok = true;\\n```", timestamp: "2026-07-10 10:00:07", runId: "run_1" },
                  ];
                  window.__sessionExchangeFixture = {
                    session: { id: sessionId, title: "同构导出测试" },
                    conversation,
                    transcript,
                    runtime: {
                      status: "completed",
                      ownedTabs: [
                        {
                          id: 403,
                          windowId: 9,
                          title: "检索页",
                          url: "https://workspace.example.test/search?q=42",
                          working: false,
                        },
                        {
                          id: 404,
                          windowId: 9,
                          title: "导出的工作页",
                          url: "https://workspace.example.test/project/42#resume",
                          working: true,
                        },
                        {
                          id: 405,
                          windowId: 9,
                          title: "参考资料",
                          url: "https://workspace.example.test/reference/42",
                          working: false,
                        },
                        {
                          id: 406,
                          windowId: 9,
                          title: "用户手动导航后的页面",
                          url: "https://manual.example.test/private",
                          working: false,
                        },
                      ],
                      loadedPluginSkillNames: ["fixture-skill"],
                      goal: {
                        status: "complete",
                        objective: "整理网页资料",
                        criteria: "保留公式与代码",
                        progress: "已完成",
                        next: "",
                        checkpoint: "rows=2",
                        version: 3,
                        createdAt: "2026-07-10 09:59:00",
                        updatedAt: "2026-07-10 10:00:07",
                      },
                    },
                  };
                }""",
                {"sessionId": session_id},
            )
            assert heavy_requests == [], f"Fresh panel unexpectedly loaded heavy features: {heavy_requests}"
            assert page.evaluate("typeof window.MathJax?.typesetPromise") == "undefined"
            exported_document = page.evaluate(
                "() => window.qingzhouConversationBenchmark.renderSessionDocument(window.__sessionExchangeFixture)",
            )
            unexpected_heavy = [url for url in heavy_requests if "/vendor/mathjax/" not in url]
            assert unexpected_heavy == [], f"Static export loaded non-math panel libraries: {unexpected_heavy}"
            assert any("/vendor/mathjax/startup.js" in url for url in heavy_requests), heavy_requests
            html = exported_document["html"]
            assert "registry.npmmirror.com/mathjax/" not in html
            assert "chrome-extension://" not in html
            assert "moz-extension://" not in html
            assert "<script src" not in html.lower()
            assert "<svg" in html
            assert 'id="qingzhou-session-exchange"' in html
            assert 'id="messages"' in html
            assert 'class="msg msg-user"' in html
            assert 'class="msg msg-thinking-group' in html
            assert 'class="msg msg-tool msg-tool-timeline' in html
            assert 'class="msg msg-assistant"' in html
            assert 'class="timeline"' not in html
            assert 'session-export-cta" hidden' in html
            assert 'class="tab-btn active"' not in html
            assert 'class="session-export-logo"' in html
            assert "data:image/png;base64," in html
            assert '<link rel="icon" type="image/png" href="data:image/png;base64,' in html

            reskinned_html = page.evaluate(
                """async () => {
                  const link = document.getElementById('qingzhou-sidepanel-skin');
                  link.dataset.qingzhouSkin = 'e2e-active';
                  const loaded = new Promise(resolve => {
                    link.addEventListener('load', resolve, { once: true });
                    setTimeout(resolve, 1000);
                  });
                  link.href = chrome.runtime.getURL('sidepanel/sidepanel.css?skin=e2e-active');
                  await loaded;
                  return (await window.qingzhouConversationBenchmark.renderSessionDocument(
                    window.__sessionExchangeFixture
                  )).html;
                }"""
            )
            assert 'data-qingzhou-skin="e2e-active"' in reskinned_html
            assert 'data-qingzhou-skin-path="sidepanel/sidepanel.css"' in reskinned_html
            assert "--bg-primary" in reskinned_html

            roundtrip = page.evaluate(
                """async ({ payload }) => {
                  const port = chrome.runtime.connect({ name: 'sidepanel' });
                  const request = (type, body = {}) => new Promise((resolve, reject) => {
                    const requestId = `exchange_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                    const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 15000);
                    const listener = event => {
                      if (event?.requestId !== requestId) return;
                      clearTimeout(timer);
                      port.onMessage.removeListener(listener);
                      if (event.type === 'error') reject(new Error(event.message || `${type} failed`));
                      else resolve(event);
                    };
                    port.onMessage.addListener(listener);
                    port.postMessage({ type, requestId, ...body });
                  });
                  try {
                    const imported = await request('import_session_exchange', { payload });
                    const runtimeKey = `_session_runtime_${imported.session.id}`;
                    const runtimeStore = await chrome.storage.local.get(runtimeKey);
                    const importedRuntime = runtimeStore[runtimeKey] || null;
                    const ownedTabs = [];
                    for (const tabId of importedRuntime?.ownedTabIds || []) {
                      let tab = null;
                      for (let attempt = 0; attempt < 100; attempt += 1) {
                        tab = await chrome.tabs.get(tabId);
                        if (tab.status === 'complete') break;
                        await new Promise(resolve => setTimeout(resolve, 25));
                      }
                      ownedTabs.push(tab);
                    }
                    const workingTab = ownedTabs.find(tab => tab?.id === importedRuntime?.workingTabId) || null;
                    const exported = await request('export_session_exchange', { sessionId: imported.session.id });
                    port.postMessage({ type: 'delete_session', sessionId: imported.session.id });
                    return {
                      imported,
                      importedRuntime,
                      ownedTabs,
                      workingTab,
                      exported: exported.payload,
                    };
                  } finally {
                    port.disconnect();
                  }
                }""",
                {"payload": exported_document["payload"]},
            )
            original_payload = exported_document["payload"]
            imported_session_id = roundtrip["imported"]["session"]["id"]
            reexported_payload = roundtrip["exported"]
            assert imported_session_id != original_payload["source"]["sessionId"]
            assert reexported_payload["source"]["sessionId"] == imported_session_id
            assert reexported_payload["session"]["title"] == original_payload["session"]["title"]
            assert reexported_payload["session"]["conversation"] == original_payload["session"]["conversation"]
            assert reexported_payload["session"]["transcript"] == original_payload["session"]["transcript"]
            assert reexported_payload["runtime"]["status"] == original_payload["runtime"]["status"]
            assert reexported_payload["runtime"]["goal"] == original_payload["runtime"]["goal"]
            assert [tab["url"] for tab in reexported_payload["runtime"]["ownedTabs"]] == OWNED_TAB_URLS
            assert [tab["working"] for tab in reexported_payload["runtime"]["ownedTabs"]] == [False, True, False]
            assert reexported_payload["dependencies"] == original_payload["dependencies"]
            assert roundtrip["importedRuntime"]["loadedPluginSkillNames"] == ["fixture-skill"]
            assert roundtrip["imported"]["ownedTabsRestore"]["restored"] is True
            assert roundtrip["imported"]["ownedTabsRestore"]["restoredCount"] == len(OWNED_TAB_URLS)
            assert roundtrip["imported"]["ownedTabsRestore"]["workingTabRestored"] is True
            assert [
                tab.get("url") or tab.get("pendingUrl")
                for tab in roundtrip["ownedTabs"]
            ] == OWNED_TAB_URLS
            assert (roundtrip["workingTab"].get("url") or roundtrip["workingTab"].get("pendingUrl")) == WORKING_TAB_URL, json.dumps(
                roundtrip["workingTab"],
                ensure_ascii=False,
                indent=2,
            )
            assert roundtrip["importedRuntime"]["workingUrl"] == WORKING_TAB_URL
            assert roundtrip["importedRuntime"]["workingTabId"] in roundtrip["importedRuntime"]["ownedTabIds"]

            with serve_export_html(html) as bridge_url:
                bridge = context.new_page()
                bridge.route("https://registry.npmmirror.com/**", lambda route: route.abort())
                bridge_errors = []
                bridge.on("pageerror", lambda error: bridge_errors.append(str(error)))
                bridge.on("console", lambda message: bridge_errors.append(message.text) if message.type == "error" else None)
                bridge.goto(bridge_url, wait_until="domcontentloaded")
                bridge.wait_for_selector("#qingzhou-session-cta[data-qingzhou-session-import]", timeout=10000)
                bridge_cta = bridge.locator("#qingzhou-session-cta")
                assert bridge_cta.text_content() == expected_import_label(bridge)
                bridge.screenshot(path=str(BRIDGE_SCREENSHOT_PATH), full_page=True)
                bridge_cta.click()
                bridge.wait_for_function(
                    "document.getElementById('qingzhou-session-cta')?.textContent === '已导入'",
                    timeout=20000,
                )
                bridge_session_id = bridge_cta.get_attribute("data-qingzhou-imported-session-id")
                assert bridge_session_id
                bridge_session = page.evaluate(
                    """async sessionId => {
                      const stored = await chrome.storage.local.get('_sessions');
                      return stored._sessions?.[sessionId] || null;
                    }""",
                    bridge_session_id,
                )
                assert bridge_session and bridge_session["title"] == original_payload["session"]["title"]
                assert bridge_errors == [], json.dumps(bridge_errors, ensure_ascii=False)
                bridge.close()

            assert_allowlisted_https_page_offers_import(context, html)
            assert_unlisted_https_origin_hides_import(context, page, html)

            HTML_PATH.write_text(html, encoding="utf-8")
            exported = context.new_page()
            exported.set_viewport_size({"width": 1440, "height": 900})
            exported.emulate_media(color_scheme="light")
            page_errors = []
            exported.on("pageerror", lambda error: page_errors.append(str(error)))
            exported.on("console", lambda message: page_errors.append(message.text) if message.type == "error" else None)
            exported.add_init_script(
                """(() => {
                  window.__qzCtaReadyAt = null;
                  const recordCta = () => {
                    const cta = document.getElementById('qingzhou-session-cta');
                    if (cta?.hasAttribute('data-qingzhou-session-import') && window.__qzCtaReadyAt == null) {
                      window.__qzCtaReadyAt = performance.now();
                    }
                  };
                  new MutationObserver(recordCta).observe(document, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['data-qingzhou-session-import'],
                  });
                })();"""
            )
            exported.route("https://registry.npmmirror.com/**", lambda route: route.abort())
            file_access_allowed = page.evaluate(
                "() => new Promise(resolve => chrome.extension.isAllowedFileSchemeAccess(resolve))"
            )
            assert file_access_allowed is True
            exported.goto(HTML_PATH.as_uri(), wait_until="domcontentloaded")
            exported.wait_for_selector("#qingzhou-session-cta[data-qingzhou-session-import]", timeout=10000)
            bridge_timing = exported.evaluate("() => window.__qzCtaReadyAt")
            assert bridge_timing is not None, bridge_timing
            assert exported.locator("#messages svg").count() >= 1
            assert exported.locator("script[src]").count() == 0

            exported_cta = exported.locator("#qingzhou-session-cta")
            assert exported_cta.text_content() == expected_import_label(exported)
            exported_cta.click()
            exported.wait_for_function(
                "document.getElementById('qingzhou-session-cta')?.textContent === '已导入'",
                timeout=20000,
            )
            exported_session_id = exported_cta.get_attribute("data-qingzhou-imported-session-id")
            assert exported_session_id
            exported_session = page.evaluate(
                """async sessionId => {
                  const stored = await chrome.storage.local.get('_sessions');
                  return stored._sessions?.[sessionId] || null;
                }""",
                exported_session_id,
            )
            assert exported_session and exported_session["title"] == original_payload["session"]["title"]
            exported.wait_for_selector("#messages .msg-user")
            assert exported.locator(".timeline").count() == 0
            assert exported.locator(".msg-tool-timeline > .tool-timeline-details.hidden").count() == 1
            assert exported.locator("#messages .msg-images img").count() == 1
            exported.locator("#messages .msg-images img").click()
            assert exported.locator(".image-lightbox").count() == 1
            assert exported.locator(".image-lightbox img").get_attribute("src").startswith("data:image/png;base64,")
            exported.locator(".image-lightbox-close").click()
            assert exported.locator(".image-lightbox").count() == 0
            exported.locator(".msg-tool-timeline > .tool-timeline-summary").click()
            assert exported.locator(".msg-tool-timeline > .tool-timeline-details.hidden").count() == 0
            assert exported.locator(".tool-timeline-slot-body").count() == 1
            assert page_errors == [], json.dumps(page_errors, ensure_ascii=False)
            assert exported.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
            exported.locator(".msg-tool-timeline > .tool-timeline-summary").click()
            light_theme = exported.evaluate(
                """() => ({
                  background: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
                  logo: [...document.querySelectorAll('.session-export-logo img')]
                    .find(node => getComputedStyle(node).display !== 'none')?.src || '',
                })"""
            )
            exported.screenshot(path=str(SCREENSHOT_PATH), full_page=True)
            exported.emulate_media(color_scheme="dark")
            dark_theme = exported.evaluate(
                """() => ({
                  background: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
                  logo: [...document.querySelectorAll('.session-export-logo img')]
                    .find(node => getComputedStyle(node).display !== 'none')?.src || '',
                })"""
            )
            assert light_theme["background"] == "#ffffff"
            assert dark_theme["background"] == "#181818"
            assert light_theme["logo"] != dark_theme["logo"]
            exported.screenshot(path=str(NIGHT_SCREENSHOT_PATH), full_page=True)
            exported.set_viewport_size({"width": 390, "height": 844})
            exported.emulate_media(color_scheme="light")
            assert exported.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
            exported.evaluate("window.scrollTo(0, 0)")
            title_alignment = exported.evaluate(
                """() => {
                  const shell = document.querySelector('.session-export-shell').getBoundingClientRect();
                  const bar = document.querySelector('.session-title-bar').getBoundingClientRect();
                  const title = document.getElementById('current-session-title').getBoundingClientRect();
                  const cta = document.getElementById('qingzhou-session-cta').getBoundingClientRect();
                  const center = rect => rect.top + rect.height / 2;
                  return {
                    shellTop: shell.top,
                    barTop: bar.top,
                    barRight: bar.right,
                    barCenter: center(bar),
                    titleRight: title.right,
                    titleCenter: center(title),
                    ctaLeft: cta.left,
                    ctaRight: cta.right,
                    ctaCenter: center(cta),
                  };
                }"""
            )
            assert abs(title_alignment["barTop"] - title_alignment["shellTop"]) <= 1, title_alignment
            assert abs(title_alignment["titleCenter"] - title_alignment["barCenter"]) <= 1, title_alignment
            assert abs(title_alignment["ctaCenter"] - title_alignment["barCenter"]) <= 1, title_alignment
            assert 7 <= title_alignment["barRight"] - title_alignment["ctaRight"] <= 9, title_alignment
            assert title_alignment["titleRight"] <= title_alignment["ctaLeft"] - 7, title_alignment
            exported.locator(".msg-thinking-group > .thinking-group-summary").click()
            sticky_geometry = exported.evaluate(
                """() => {
                  const title = document.querySelector('.session-title-bar');
                  const group = document.querySelector('.msg-thinking-group');
                  const summary = group?.querySelector(':scope > .thinking-group-summary');
                  const groupTop = group.getBoundingClientRect().top + window.scrollY;
                  window.scrollTo(0, Math.max(0, groupTop + 2));
                  const titleRect = title.getBoundingClientRect();
                  const summaryRect = summary.getBoundingClientRect();
                  return {
                    titleBottom: titleRect.bottom,
                    summaryTop: summaryRect.top,
                    offset: getComputedStyle(summary).top,
                  };
                }"""
            )
            assert sticky_geometry["summaryTop"] >= sticky_geometry["titleBottom"] - 1, sticky_geometry
            assert sticky_geometry["offset"] == "30px", sticky_geometry
            exported.screenshot(path=str(MOBILE_SCREENSHOT_PATH), full_page=True)
            print(
                "session exchange extension e2e passed: "
                f"{HTML_PATH} {SCREENSHOT_PATH} {NIGHT_SCREENSHOT_PATH} {MOBILE_SCREENSHOT_PATH} {BRIDGE_SCREENSHOT_PATH} "
                f"{PAGES_ALLOWED_SCREENSHOT_PATH} {PAGES_DENIED_SCREENSHOT_PATH}"
            )
            return 0
        finally:
            context.close()


if __name__ == "__main__":
    raise SystemExit(run())
