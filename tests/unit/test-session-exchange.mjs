import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeConversation } from "../../src/shared/session/session-codec.js";
import {
  appendSessionExchangeImportCapsule,
  createSessionExchangePayload,
  extractSessionExchangePayload,
  normalizeSessionExchangePayload,
  renderSessionExchangeScript,
  SESSION_EXCHANGE_IMPORT_CAPSULE_REASON,
  settleImportedTranscript,
  stripSessionExchangeImportCapsules,
  SESSION_EXCHANGE_FORMAT,
  SESSION_EXCHANGE_SCRIPT_ID,
  SESSION_EXCHANGE_VERSION,
} from "../../src/shared/session/session-exchange.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = path => {
  const sourcePath = existsSync(join(root, path)) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(join(root, sourcePath), "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code : source;
};

assertRoundTrip();
assertImportCapsuleLifecycle();
assertEscaping();
assertInterruptedStateSettles();
assertValidation();
assertSourceContracts();

function assertRoundTrip() {
  const conversation = serializeConversation([
    { role: "user", content: "继续处理这份数据" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_missing_tool",
        type: "function",
        function: { name: "missing_skill__collect", arguments: "{\"page\":2}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_missing_tool",
      content: "{\"ok\":true,\"rows\":3,\"_pageUrl\":\"https://example.test/search?q=42\"}",
    },
    { role: "assistant", content: "已完成。" },
  ]);
  const transcript = [
    { type: "user", text: "继续处理这份数据", timestamp: "2026-07-10 10:00:00" },
    {
      type: "tool",
      toolCallId: "call_missing_tool",
      name: "missing_skill__collect",
      args: { page: 2 },
      result: {
        ok: true,
        rows: 3,
        _pageUrl: "https://example.test/search?q=42",
        _display: {
          type: "imageWithAction",
          action: "click",
          kind: "point",
          x: 0.5,
          y: 0.5,
          beforeImage: "data:image/png;base64,YmVmb3Jl",
          afterImage: "data:image/png;base64,YWZ0ZXI=",
        },
      },
      isError: false,
      isRunning: false,
      phase: "done",
      timestamp: "2026-07-10 10:00:01",
      endedAt: "2026-07-10 10:00:02",
    },
    { type: "assistant", content: "已完成。", timestamp: "2026-07-10 10:00:03" },
  ];
  const payload = createSessionExchangePayload({
    session: {
      id: "source-session",
      parentSessionId: "0",
      title: "数据整理",
      createdAt: "2026-07-10 09:59:00",
      updatedAt: "2026-07-10 10:00:03",
    },
    conversation,
    transcript,
    runtime: {
      status: "running",
      ownedTabs: [
        {
          id: 90,
          windowId: 7,
          title: "查询页",
          url: "https://example.test/search?q=42",
        },
        {
          id: 91,
          windowId: 7,
          title: "数据工作台",
          url: "https://example.test/workbench?task=42#result",
          working: true,
        },
      ],
      loadedPluginSkillNames: ["missing-skill", "missing-skill"],
      goal: {
        status: "active",
        objective: "整理数据",
        criteria: "输出三行",
        progress: "已读取",
        next: "继续去重",
        checkpoint: "table=data",
        version: 2,
      },
    },
    appVersion: "0.4.1",
    exportedAt: "2026-07-10 10:01:00",
  });

  assert.equal(payload.format, SESSION_EXCHANGE_FORMAT);
  assert.equal(payload.version, SESSION_EXCHANGE_VERSION);
  assert.equal(payload.source.sessionId, "source-session");
  assert.equal(payload.session.title, "数据整理");
  assert.equal(payload.session.conversation.entries.length, 4);
  assert.equal(payload.session.transcript.length, 3);
  assert.equal(
    payload.session.transcript[1].result._display.beforeImage,
    "data:image/png;base64,YmVmb3Jl",
    "screen-action source frames are durable export presentation data",
  );
  assert.equal(
    payload.session.transcript[1].result._display.afterImage,
    "data:image/png;base64,YWZ0ZXI=",
    "screen-action result previews are durable export presentation data",
  );
  assert.deepEqual(payload.dependencies.skills, ["missing-skill"]);
  assert.deepEqual(payload.dependencies.tools, ["missing_skill__collect"]);
  assert.equal(payload.runtime.goal.objective, "整理数据");
  assert.equal(payload.runtime.status, "interrupted");
  assert.deepEqual(payload.runtime.ownedTabs, [
    {
      url: "https://example.test/search?q=42",
      title: "查询页",
      working: false,
    },
    {
      url: "https://example.test/workbench?task=42#result",
      title: "数据工作台",
      working: true,
    },
  ]);
  assert.equal(Object.hasOwn(payload.runtime.ownedTabs[0], "id"), false);
  assert.equal(Object.hasOwn(payload.runtime.ownedTabs[0], "windowId"), false);

  const drifted = createSessionExchangePayload({
    session: { title: "手动切页过滤" },
    conversation,
    transcript: [
      ...transcript,
      {
        type: "tool",
        name: "navigate",
        args: { url: "https://manual.example.test/private" },
        result: { error: "navigation failed" },
        phase: "done",
        isError: true,
        isRunning: false,
      },
      {
        type: "tool",
        name: "read_dom",
        args: { _pageUrl: "https://context.example.test/article" },
        result: { ok: true },
        phase: "done",
        isError: false,
        isRunning: false,
      },
    ],
    runtime: {
      ownedTabs: [
        {
          title: "任务页面",
          url: "https://example.test/another-path",
          working: true,
        },
        {
          title: "用户后来手动打开的页面",
          url: "https://manual.example.test/private",
        },
        {
          title: "工具上下文页面",
          url: "https://context.example.test/continued",
        },
      ],
    },
  });
  assert.deepEqual(drifted.runtime.ownedTabs, [
    {
      url: "https://example.test/another-path",
      title: "任务页面",
      working: true,
    },
    {
      url: "https://context.example.test/continued",
      title: "工具上下文页面",
      working: false,
    },
  ], "export should keep same-host pages used by the Session and omit manually navigated domains");

  const filteredCap = createSessionExchangePayload({
    session: { title: "先过滤再限制" },
    conversation,
    transcript: [{
      type: "tool",
      name: "read_dom",
      args: { _pageUrl: "https://allowed.example/page/1" },
      result: { ok: true },
      phase: "done",
      isError: false,
      isRunning: false,
    }],
    runtime: {
      ownedTabs: [
        ...Array.from({ length: 10 }, (_item, index) => ({
          title: `手动页面 ${index + 1}`,
          url: `https://manual.example/page/${index + 1}`,
        })),
        ...Array.from({ length: 35 }, (_item, index) => ({
          title: `任务页面 ${index + 1}`,
          url: `https://allowed.example/page/${index + 1}`,
          working: index === 34,
        })),
      ],
    },
  }).runtime.ownedTabs;
  assert.equal(filteredCap.length, 30, "manual domains must not consume the 30-tab export limit");
  assert.equal(filteredCap[0].url, "https://allowed.example/page/1");
  assert.equal(filteredCap.at(-1).url, "https://allowed.example/page/35");
  assert.equal(filteredCap.at(-1).working, true);

  const html = `<!doctype html><html><body>${renderSessionExchangeScript(payload)}</body></html>`;
  const imported = extractSessionExchangePayload(html);
  assert.equal(imported.session.title, payload.session.title);
  assert.deepEqual(imported.session.conversation, payload.session.conversation);
  assert.deepEqual(imported.session.transcript, payload.session.transcript);
  assert.deepEqual(imported.dependencies, payload.dependencies);
  assert.equal(imported.runtime.goal.checkpoint, "table=data");
  assert.deepEqual(imported.runtime.ownedTabs, payload.runtime.ownedTabs);

  const reexported = createSessionExchangePayload({
    session: imported.session,
    conversation: imported.session.conversation,
    transcript: settleImportedTranscript(imported.session.transcript),
    runtime: {
      status: imported.runtime.status,
      goal: imported.runtime.goal,
      ownedTabs: imported.runtime.ownedTabs,
      exchangeDependencies: imported.dependencies,
    },
    appVersion: imported.app.version,
    exportedAt: imported.exportedAt,
  });
  assert.equal(reexported.session.title, imported.session.title);
  assert.deepEqual(reexported.session.conversation, imported.session.conversation);
  assert.deepEqual(reexported.session.transcript, imported.session.transcript);
  assert.deepEqual(reexported.runtime, imported.runtime);
  assert.deepEqual(reexported.dependencies, imported.dependencies);
}

function assertEscaping() {
  const payload = createSessionExchangePayload({
    session: { title: "escape" },
    conversation: serializeConversation([
      { role: "user", content: "</script><script>globalThis.pwned = true</script>\u2028下一行" },
    ]),
    transcript: [{
      type: "user",
      text: "</script><script>globalThis.pwned = true</script>\u2028下一行",
      timestamp: "2026-07-10 10:00:00",
    }],
  });
  const script = renderSessionExchangeScript(payload);
  assert.match(script, new RegExp(`id="${SESSION_EXCHANGE_SCRIPT_ID}"`));
  assert.equal(script.includes("</script><script>globalThis.pwned"), false);
  assert.match(script, /\\u003c\/script>/u);
  assert.equal(extractSessionExchangePayload(script).session.transcript[0].text.includes("globalThis.pwned"), true);
}

function assertImportCapsuleLifecycle() {
  const conversation = serializeConversation([
    { role: "user", content: "原始问题" },
    { role: "assistant", content: "原始回答" },
  ]);
  const imported = appendSessionExchangeImportCapsule(conversation, "2026-07-10 10:30:00");
  const capsule = imported.entries.at(-1);
  assert.equal(capsule.message._contextCapsule.reason, SESSION_EXCHANGE_IMPORT_CAPSULE_REASON);
  assert.match(capsule.message.content, /本对话由外部导出的轻舟会话加载/u);
  assert.match(capsule.message.content, /技能、工具、数据表、图集、文件/u);

  const reexported = createSessionExchangePayload({
    session: { id: "imported-session", title: "外部会话" },
    conversation: imported,
  });
  assert.deepEqual(
    reexported.session.conversation,
    conversation,
    "the import-only capsule must not leak into a subsequent export",
  );

  const continued = {
    ...imported,
    entries: [
      ...imported.entries,
      {
        type: "message",
        id: "after_import",
        parentId: capsule.id,
        timestamp: "2026-07-10 10:31:00",
        message: { role: "user", content: "继续工作" },
      },
    ],
  };
  const stripped = stripSessionExchangeImportCapsules(continued);
  assert.equal(stripped.entries.length, conversation.entries.length + 1);
  assert.equal(stripped.entries.at(-1).parentId, conversation.entries.at(-1).id);
}

function assertInterruptedStateSettles() {
  const settled = settleImportedTranscript([
    {
      type: "tool",
      name: "unknown_tool",
      args: {},
      argsState: "executing",
      phase: "running",
      isRunning: true,
      result: null,
      streaming: true,
    },
    { type: "thinking", text: "处理中", streaming: true },
    { type: "wait", waitId: "wait_1", message: "请登录", status: "waiting" },
  ], "2026-07-10 11:00:00");
  assert.equal(settled[0].isRunning, false);
  assert.equal(settled[0].isError, true);
  assert.equal(settled[0].phase, "aborted");
  assert.equal(settled[0].result.code, "IMPORTED_TOOL_INTERRUPTED");
  assert.equal(Object.hasOwn(settled[0], "streaming"), false);
  assert.equal(settled[1].phase, "aborted");
  assert.equal(Object.hasOwn(settled[1], "streaming"), false);
  assert.equal(settled[2].status, "interrupted");
}

function assertValidation() {
  assert.throws(
    () => extractSessionExchangePayload("<html><body>普通网页</body></html>"),
    err => err?.code === "MISSING_SESSION_EXCHANGE_PAYLOAD",
  );
  assert.throws(
    () => normalizeSessionExchangePayload({ format: SESSION_EXCHANGE_FORMAT, version: 99 }),
    err => err?.code === "UNSUPPORTED_SESSION_EXCHANGE_VERSION",
  );
  assert.throws(
    () => normalizeSessionExchangePayload({
      format: SESSION_EXCHANGE_FORMAT,
      version: SESSION_EXCHANGE_VERSION,
      session: {},
    }),
    err => err?.code === "EMPTY_SESSION_EXCHANGE",
  );
  const conversation = serializeConversation([{ role: "user", content: "继续" }]);
  const withoutOwnedTabs = normalizeSessionExchangePayload({
    format: SESSION_EXCHANGE_FORMAT,
    version: SESSION_EXCHANGE_VERSION,
    session: { conversation },
  });
  assert.deepEqual(withoutOwnedTabs.runtime.ownedTabs, [], "legacy v1 files should remain importable");
  const legacyRuntimeFields = createSessionExchangePayload({
    session: { title: "旧运行态字段" },
    conversation,
    transcript: [{
      type: "tool",
      name: "navigate",
      args: { url: "https://example.test/legacy#state" },
      result: { ok: true, _pageUrl: "https://example.test/legacy#state" },
      phase: "done",
      isError: false,
      isRunning: false,
    }],
    runtime: {
      workingUrl: "https://example.test/legacy#state",
      workingTitle: "旧工作页",
    },
  });
  assert.deepEqual(legacyRuntimeFields.runtime.ownedTabs, [{
    url: "https://example.test/legacy#state",
    title: "旧工作页",
    working: true,
  }]);
  const legacyWorkingTab = normalizeSessionExchangePayload({
    format: SESSION_EXCHANGE_FORMAT,
    version: SESSION_EXCHANGE_VERSION,
    session: { conversation },
    runtime: {
      workingTab: {
        title: "旧版工作页",
        url: "https://example.test/legacy-working",
      },
    },
  });
  assert.deepEqual(legacyWorkingTab.runtime.ownedTabs, [{
    url: "https://example.test/legacy-working",
    title: "旧版工作页",
    working: true,
  }], "the earlier singular workingTab exchange field should import as one owned working tab");
  const unsafeOwnedTabs = normalizeSessionExchangePayload({
    format: SESSION_EXCHANGE_FORMAT,
    version: SESSION_EXCHANGE_VERSION,
    session: { conversation },
    runtime: {
      ownedTabs: [
        { title: "本地脚本", url: "javascript:alert(1)", working: true },
        { title: "合法页", url: "https://safe.example/path", working: true },
        { title: "重复页", url: "https://safe.example/path", working: true },
      ],
    },
  });
  assert.deepEqual(unsafeOwnedTabs.runtime.ownedTabs, [
    { title: "合法页", url: "https://safe.example/path", working: true },
    { title: "重复页", url: "https://safe.example/path", working: false },
  ], "unsafe URLs are removed, duplicate tabs are preserved, and only one tab remains working");

  const cappedOwnedTabs = normalizeSessionExchangePayload({
    format: SESSION_EXCHANGE_FORMAT,
    version: SESSION_EXCHANGE_VERSION,
    session: { conversation },
    runtime: {
      ownedTabs: Array.from({ length: 35 }, (_item, index) => ({
        title: `页面 ${index + 1}`,
        url: `https://tabs.example/page/${index + 1}`,
        working: index === 34,
      })),
    },
  }).runtime.ownedTabs;
  assert.equal(cappedOwnedTabs.length, 30, "an imported workspace must open at most 30 tabs");
  assert.equal(cappedOwnedTabs.at(-1).url, "https://tabs.example/page/35");
  assert.equal(cappedOwnedTabs.at(-1).working, true, "the exported working tab is retained across the cap");
}

function assertSourceContracts() {
  const manifest = JSON.parse(read("src/manifest.json"));
  const sidepanelHtml = read("src/sidepanel/sidepanel.html") + read("src/capabilities/sessions/ui.html");
  const sessionsFeature = read("src/capabilities/sessions/sessions-feature.js");
  const sessionExportFeature = read("src/sidepanel/features/export/session-export-feature.ts");
  const eventRouter = read("src/sidepanel/features/app/sidepanel-event-router.js");
  const imageLightbox = read("src/sidepanel/ui/image-lightbox.ts");
  const exportRuntime = read("src/sidepanel/features/export/session-export-runtime.ts");
  const sidepanelJs = [sessionsFeature, read("src/capabilities/sessions/ui.ts"), sessionExportFeature, exportRuntime, eventRouter, imageLightbox].join("\n");
  const sidepanelCss = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url)) + read("src/capabilities/sessions/ui.css");
  const contentScript = read("src/content/content-script.ts");
  const sessionExportBridge = read("src/content/session-export-bridge.ts");
  const agentJs = transformSync(read("src/background/agent/agent.ts"), { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code;
  const serviceWorker = read("src/background/service-worker.js");
  const sessionCommands = read("src/background/session/commands.js");
  const sessionAgentHost = read("src/background/session/agent-host.js");
  const sidepanelTransport = read("src/background/transports/sidepanel.js");
  const runtimeMessageTransport = read("src/background/transports/runtime-message.js");
  const exchangeBridge = read("src/background/services/session-exchange-bridge.js");
  const runtimeReducer = read("src/background/session/runtime-reducer.js");
  const sessionTabs = read("src/background/session/tabs.js");
  assert.match(sidepanelHtml, /id="btn-import-session"/u);
  assert.match(sidepanelHtml, /M4 22h14a2 2 0 0 0 2-2V7l-5-5H6/u);
  assert.match(sidepanelHtml, /id="session-import-file"[^>]+accept="\.html,text\/html"/u);
  assert.match(sidepanelJs, /extractSessionExchangePayload\(await file\.text\(\)\)/u);
  assert.match(sidepanelJs, /request\("import_session_exchange"/u);
  assert.match(sidepanelJs, /request\("export_session_exchange"/u);
  assert.doesNotMatch(sidepanelJs, /showCaseToast\("会话已导入，可以继续工作。"\)/u);
  assert.match(sidepanelJs, /showCaseToast\(errorMessage\(err, t\("couldNotImportConversation"\)\), \{\s*tone: "error",\s*durationMs: 5(?:000|e3),?\s*\}\);/u);
  assert.match(sidepanelJs, /renderSessionExchangeScript\(exchangePayload\)/u);
  assert.match(sidepanelHtml, /id="qingzhou-sidepanel-skin"[^>]+data-qingzhou-skin="default"/u);
  assert.match(sidepanelJs, /loadActiveSidepanelSkin/u);
  assert.doesNotMatch(sidepanelJs, /getURL\("sidepanel\/sidepanel\.css"\)/u);
  assert.match(sidepanelJs, /id="qingzhou-session-cta" class="qz-btn qz-btn--primary qz-btn--xs session-export-cta"/u);
  assert.match(sidepanelJs, /\.session-export-continuation\s*\{[\s\S]*?gap:\s*7px/u);
  assert.doesNotMatch(sidepanelJs, /qingzhou-session-cta-copy|continueConversationHint/u);
  assert.match(sidepanelJs, /SESSION_EXPORT_RUNTIME_SOURCE/u);
  assert.match(sidepanelJs, /qingzhou:session-export:probe/u);
  assert.match(sidepanelJs, /button\.setAttribute\("data-qingzhou-session-import", ""\)/u);
  assert.match(sidepanelJs, /button\.textContent = t\("importQingzhou"\)/u);
  assert.match(sidepanelJs, /cta\.textContent = t\("importing"\)/u);
  assert.match(sidepanelJs, /cta\.textContent = t\("imported"\)/u);
  assert.match(sidepanelJs, /event.type === "session_imported_from_export"/u);
  assert.match(sidepanelJs, /switchToSession\(sessionId, \{ source: "export_import" \}\)/u);
  assert.match(sidepanelJs, /function showOwnedTabsRestoreNotice\(input\)[\s\S]*const result = fields\(input\)[\s\S]*result\.failedCount/u);
  const bridgeContentScript = manifest.content_scripts.find(entry => (
    Array.isArray(entry.js) && entry.js.includes("content/session-export-bridge.js")
  ));
  assert.equal(bridgeContentScript?.run_at, "document_start");
  assert.deepEqual(bridgeContentScript?.js, ["content/session-export-bridge.js"]);
  assert.match(sessionExportBridge, /document\.addEventListener\("click", handleImportClick, true\)/u);
  assert.match(sessionExportBridge, /if \(!event\.isTrusted\) return;/u);
  assert.match(sessionExportBridge, /document\.getElementById\(QINGZHOU_SESSION_EXCHANGE_SCRIPT_ID\)/u);
  assert.match(sessionExportBridge, /type: "session_export_import_request"/u);
  assert.match(sessionExportBridge, /location\.protocol === "file:"/u);
  assert.match(sessionExportBridge, /const targetOrigin = location\.protocol === "file:" \|\| location\.origin === "null"\s*\?\s*"\*"\s*:\s*location\.origin;/u);
  assert.doesNotMatch(sessionExportBridge, /event\.data\?\.payload/u);
  assert.doesNotMatch(contentScript, /session_export_import_request/u);
  assert.match(sidepanelJs, /openImageLightbox\(previewImage\.dataset\.fullSrc \|\| previewImage\.currentSrc \|\| previewImage\.src/u);
  assert.doesNotMatch(sidepanelJs, /function positionAssistantDownloadMenu\(menu, btn\)/u);
  assert.match(sidepanelJs, /M14\.5 2H6[\s\S]*M12 12v6/u);
  assert.match(sidepanelCss, /\.session-title-export-btn\s*\{/u);
  assert.match(sidepanelCss, /--chat-sticky-offset:\s*0px/u);
  assert.match(sidepanelCss, /\.msg-thinking-group\.thinking-group-expanded > \.thinking-group-summary\s*\{[\s\S]*?top:\s*var\(--chat-sticky-offset\)/u);
  assert.match(sidepanelCss, /\.msg-tool-timeline\.tool-timeline-expanded \.tool-timeline-nav-area\s*\{[\s\S]*?top:\s*calc\(var\(--chat-sticky-offset\) \+ var\(--lane-header-height\)\)/u);
  assert.match(sidepanelJs, /--chat-sticky-offset:\s*var\(--session-export-title-height\)/u);
  assert.match(sidepanelJs, /height:\s*var\(--session-export-title-height\)/u);
  assert.match(sidepanelJs, /buildStaticSessionChatHtml\(\s*session,\s*transcript,\s*\{/u);
  assert.match(sidepanelJs, /renderToolEvent\(entry, \{ expanded: false, lazyDetails: false, static: true \}\)/u);
  assert.match(sidepanelJs, /createToolTimelineGroupElement\(entry, \{ expanded: true, static: true \}\)/u);
  assert.doesNotMatch(sidepanelJs, /function createExportTimeline/u);
  assert.doesNotMatch(sidepanelJs, /class=["']timeline["']/u);
  assert.doesNotMatch(sessionExportFeature, /registry\.npmmirror\.com/u);
  assert.doesNotMatch(sessionExportFeature, /cdn\.jsdelivr\.net\/npm\/mathjax/u);
  assert.doesNotMatch(sessionExportFeature, /fontCache:\s*"none"/u);
  assert.doesNotMatch(sessionExportFeature, /<script[^>]*\bsrc=/u);
  assert.doesNotMatch(sessionExportFeature, /chrome-extension:\/\//u);
  assert.doesNotMatch(sessionExportFeature, /moz-extension:\/\//u);
  assert.match(sessionExportFeature, /function inlineSessionExportMath\(chatHtml = ""/u);
  assert.match(sessionExportFeature, /renderMathSvg\b/u);
  assert.match(sessionExportFeature, /"format":\s*SESSION_EXCHANGE_FORMAT|renderSessionExchangeScript\(exchangePayload\)/u);
  assert.match(sidepanelTransport, /case "export_session_exchange"/u);
  assert.match(sidepanelTransport, /import_session_exchange:\s*\{\s*method: "exchange.import"/u);
  assert.match(runtimeMessageTransport, /type === "session_export_import_request"/u);
  assert.match(exchangeBridge, /normalizeSessionExchangePayload\(message\.payload\)/u);
  assert.match(exchangeBridge, /openSidePanel\(sender\?\.tab\?\.windowId\)/u);
  assert.match(exchangeBridge, /type: "session_imported_from_export"/u);
  assert.match(exchangeBridge, /ownedTabsRestore: result\.ownedTabsRestore \|\| null/u);
  assert.match(exchangeBridge, /isAllowedSessionExportSource\(sender\?\.tab\?\.url\)/u);
  assert.match(sessionCommands, /appendSessionExchangeImportCapsule\(payload\.session\.conversation\)/u);
  // Runtime export/import and owner-port wiring are exercised by test-session-commands-runtime.mjs.
  assert.match(sessionCommands, /loadedPluginSkillNames: payload\.dependencies\.skills/u);
  assert.match(sessionTabs, /async function restoreOwnedTabs\([\s\S]*Promise\.all\(portableTabs\.map/u);
  assert.match(sessionTabs, /tabsApi\.create\(\{ windowId, url: portable\.url, active: false \}\)/u);
  assert.doesNotMatch(sessionTabs, /tabsApi\.onUpdated|status\s*===\s*["']complete["']|enforceOpenRateLimit/u);
  assert.match(sessionTabs, /ownedTabIds: normalizeSessionTabIds\(\[[\s\S]*opened\.map\(\(?result\)? => result\.tab\.id\)/u);
  assert.match(sessionAgentHost, /const runtime = supervisor\.getRuntime\(id\) \|\| \{\};[\s\S]*agent\.restoreLoadedSkillToolNames\(runtime\.loadedPluginSkillNames \|\| \[\]\)/u);
  assert.match(agentJs, /restoreLoadedSkillToolNames\(names = \[\]\)/u);
  assert.match(runtimeReducer, /case "reset":[\s\S]+status: SESSION_STATUS\.IDLE[\s\S]+pendingFollowUpMessages: \[\]/u);
}

console.log("session exchange tests passed");
