#!/usr/bin/env python3
from argparse import ArgumentParser
from pathlib import Path
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import serve_repository


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
SIDEPANEL_PATH = "/extension/sidepanel/sidepanel.html"


serve_repo = serve_repository


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


def run(args):
    result = {"assertions": 0, "failures": [], "pageErrors": [], "consoleErrors": []}

    def check(condition, message):
        result["assertions"] += 1
        if not condition:
            result["failures"].append(message)

    def capture(page, stage):
        if not args.screenshot:
            return
        page.wait_for_timeout(220)
        target = Path(args.screenshot)
        suffix = target.suffix or ".png"
        path = target.with_name(f"{target.stem}-{stage}{suffix}")
        page.screenshot(path=str(path), full_page=True)

    with serve_repo() as base_url, sync_playwright() as p:
        browser = p.chromium.launch(
            headless=not args.headed,
            channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"),
        )
        page = browser.new_page(
            locale="zh-CN",
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=1,
            color_scheme=args.color_scheme,
        )
        page.on("pageerror", lambda exc: result["pageErrors"].append(str(exc)))
        page.on("console", lambda msg: result["consoleErrors"].append(f"{msg.text} ({msg.location.get('url', 'unknown source')})") if msg.type == "error" else None)
        page.add_init_script("""
        (() => {
          const listeners = { message: [], disconnect: [], changed: [] };
          const session = { id: 'sess-chat-search', title: '搜索测试任务', parentSessionId: 'root' };
          const storage = {
            qz_data_consent: { version: 1, acceptedAt: 1 },
            _sessions: {},
            _skills: {
              'search-smoke-skill': {
                name: 'search-smoke-skill',
                displayName: 'Skill 搜索测试',
                description: '验证详情页搜索快捷键，并覆盖站点规则、资源编辑与完整源码同步。',
                content: [
                  '# Skill 搜索测试',
                  '',
                  '正文命中词出现在这里，后面还会再次出现正文命中词。',
                  '',
                  '```js',
                  'const codeNeedle = "代码也能搜索";',
                  '```',
                  '',
                  '$$\\mathrm{FormulaOnlyNeedle} = 1$$',
                  '',
                  ...Array.from({ length: 48 }, (_, index) => `编辑器长文第 ${index + 1} 行：${'用于验证自动折行与滚动位置。'.repeat(5)}`),
                ].join('\\n'),
                scope: 'site',
                status: 'active',
                license: 'Internal',
                compatibility: 'Qingzhou 0.4+',
                'allowed-tools': 'page_read page_click',
                domains: ['example.com', 'www.example.com'],
                urlPatterns: [
                  'https://example.com/search/**',
                  'https://example.com/video/**',
                  'https://www.example.com/user/**',
                ],
                excludePatterns: ['https://example.com/private/**'],
                resources: [
                  {
                    path: 'scripts/extract.mjs',
                    type: 'script',
                    description: '页面结构提取',
                    content: '// Editor geometry comment\\nexport async function extract(page) { const deliberatelyLongIdentifierForWrappingVerification = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789"; return `${deliberatelyLongIdentifierForWrappingVerification}:${page.title()}`; }',
                  },
                  {
                    path: 'plugin.json',
                    type: 'json',
                    description: '插件声明',
                    content: JSON.stringify({
                      format: 'qingzhou.plugin',
                      schemaVersion: 1,
                      id: 'search-smoke-plugin',
                      displayName: 'Skill 搜索测试',
                      description: '验证详情页搜索快捷键',
                      mcpServers: {
                        rendertron: {
                          type: 'remote',
                          url: 'https://example.com/mcp',
                          enabled: true,
                        },
                      },
                      tools: [],
                    }, null, 2),
                  },
                ],
                format: 'qingzhou.skill',
                schemaVersion: 2,
                createdAt: '2026-07-10 10:00:00',
                updatedAt: '2026-07-10 10:00:00',
              },
            },
          };
          let gitSources = [];
          window.__gitSourceRequests = [];
          window.__skillWorkbenchStorage = storage;
          const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
          const emit = (event) => listeners.message.slice().forEach(fn => fn(event));
          const workspaceSnapshot = async () => {
            const { mergeBuiltinSkills } = await import('/extension/shared/skills/builtin-skills.js');
            return { skills: mergeBuiltinSkills(Object.values(clone(storage._skills))), installStates: {} };
          };
          const storageGet = async (keys) => {
            if (typeof keys === 'string') return { [keys]: clone(storage[keys]) };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
            if (keys && typeof keys === 'object') {
              return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(storage[key] ?? fallback)]));
            }
            return clone(storage);
          };
          const port = {
            onMessage: { addListener(fn) { listeners.message.push(fn); } },
            onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
            postMessage(msg) {
              if (!msg) return;
              if (msg.type === 'get_config') {
                setTimeout(() => emit({
                  type: 'config',
                  config: { provider: 'openai', model: 'gpt-test', apiKey: 'test', modelProvider: 'openai' },
                  presets: [],
                }), 0);
                return;
              }
              if (msg.type === 'create_ui_session' && msg.requestId) {
                storage._sessions[session.id] = session;
                setTimeout(() => emit({ requestId: msg.requestId, session }), 0);
                return;
              }
              if (msg.type === 'list_sessions' && msg.requestId) {
                setTimeout(() => emit({ requestId: msg.requestId, sessions: Object.values(storage._sessions) }), 0);
                return;
              }
              if (msg.type === 'get_messages') {
                setTimeout(() => emit({
                  requestId: msg.requestId,
                  type: 'messages',
                  sessionId: msg.sessionId || session.id,
                  transcript: window.__chatSearchTranscript || [],
                  save: false,
                }), 0);
                return;
              }
              if (msg.type === 'get_state') {
                setTimeout(() => emit({ requestId: msg.requestId, type: 'state', sessionId: msg.sessionId || session.id, runtime: {} }), 0);
                return;
              }
              if (msg.type === 'get_session_artifacts') {
                setTimeout(() => emit({ requestId: msg.requestId, artifacts: {} }), 0);
                return;
              }
              if (msg.type === 'get_skill_workspace') {
                void workspaceSnapshot().then(snapshot => emit({ requestId: msg.requestId, type: 'skill_workspace', ...snapshot }));
                return;
              }
              if (msg.type === 'save_workspace_skill') {
                const error = String(window.__skillMcpValidationError || '');
                if (error) {
                  setTimeout(() => emit({ requestId: msg.requestId, type: 'error', message: error }), 0);
                } else {
                  delete storage._skills[msg.name];
                  storage._skills[msg.skill.name] = clone(msg.skill);
                  void workspaceSnapshot().then(snapshot => emit({ requestId: msg.requestId, type: 'skill_workspace_saved', ok: true, registryReady: true, skill: clone(msg.skill), ...snapshot }));
                }
                return;
              }
              if (msg.type === 'validate_skill_mcp' && msg.requestId) {
                const error = String(window.__skillMcpValidationError || '');
                setTimeout(() => emit({
                  requestId: msg.requestId,
                  type: 'skill_mcp_validated',
                  ok: !error,
                  ...(error ? { error } : {}),
                }), 0);
                return;
              }
              if (msg.type === 'list_git_skill_sources' && msg.requestId) {
                setTimeout(() => emit({ requestId: msg.requestId, type: 'git_skill_sources', sources: clone(gitSources) }), 0);
                return;
              }
              if (msg.type === 'bind_git_skill_source' && msg.requestId) {
                window.__gitSourceRequests.push(clone(msg));
                const repositoryUrl = String(msg.repositoryUrl || '');
                gitSources = [{
                  id: 'git-opencli-skills',
                  repositoryUrl: 'https://github.com/jackwener/OpenCLI',
                  browseUrl: repositoryUrl,
                  host: 'github.com',
                  namespace: 'jackwener',
                  name: 'OpenCLI',
                  ref: 'main',
                  subpath: 'skills',
                  branch: 'main',
                  revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  skillNames: ['search-smoke-skill'],
                  checkedAt: '2026-07-12 23:40:00',
                  updatedAt: '2026-07-12 23:40:00',
                  missingCount: 0,
                  modifiedCount: 0,
                }];
                setTimeout(() => emit({
                  requestId: msg.requestId,
                  type: 'git_skill_source_synced',
                  ok: true,
                  action: 'bound',
                  changed: true,
                  count: 1,
                  names: ['search-smoke-skill'],
                  source: clone(gitSources[0]),
                }), 0);
                return;
              }
              if (msg.type === 'check_git_skill_source' && msg.requestId) {
                window.__gitSourceRequests.push(clone(msg));
                setTimeout(() => emit({
                  requestId: msg.requestId,
                  type: 'git_skill_source_checked',
                  ok: true,
                  action: 'checked',
                  updateAvailable: true,
                  remoteChanged: true,
                  repairAvailable: false,
                  checkedAt: '2026-07-13 00:10:00',
                  source: clone(gitSources[0]),
                }), 0);
                return;
              }
              if (msg.type === 'update_git_skill_source' && msg.requestId) {
                window.__gitSourceRequests.push(clone(msg));
                setTimeout(() => emit({
                  requestId: msg.requestId,
                  type: 'git_skill_source_synced',
                  ok: true,
                  action: 'current',
                  changed: false,
                  count: 1,
                  names: ['search-smoke-skill'],
                  source: clone(gitSources[0]),
                }), 0);
                return;
              }
              if (msg.type === 'remove_git_skill_source' && msg.requestId) {
                window.__gitSourceRequests.push(clone(msg));
                gitSources = [];
                setTimeout(() => emit({ requestId: msg.requestId, type: 'git_skill_source_removed', ok: true, action: 'unbound_and_cleaned', deletedCount: 1, preservedModifiedCount: 0 }), 0);
                return;
              }
              if (msg.type === 'save_session_record') return;
              if (msg.type === 'prompt') window.__lastPromptMessage = msg;
            },
          };
          window.__emitPortMessage = emit;
          window.chrome = {
            runtime: {
              connect() { return port; },
              getURL(path) { return '/extension/' + path; },
              sendMessage() {},
            },
            storage: {
              local: {
                get: storageGet,
                async set(values) { Object.assign(storage, clone(values || {})); },
                async remove(keys) {
                  (Array.isArray(keys) ? keys : [keys]).filter(Boolean).forEach(key => delete storage[key]);
                },
              },
              onChanged: { addListener(fn) { listeners.changed.push(fn); } },
            },
            downloads: { async download() {}, async search() { return []; }, open() {}, show() {} },
            tabs: { async query() { return []; }, async create() { return {}; } },
            desktopCapture: { chooseDesktopMedia() {} },
          };
        })();
        """)

        try:
            page.goto(f"{base_url}{SIDEPANEL_PATH}", wait_until="domcontentloaded")
            page.wait_for_selector("#input", timeout=args.timeout)
            page.fill("#input", "构造搜索测试对话")
            page.click("#btn-send")
            page.wait_for_function("window.__lastPromptMessage && document.querySelectorAll('.msg-user').length === 1", timeout=args.timeout)
            page.evaluate("""
            () => {
              const sessionId = 'sess-chat-search';
              const runId = 'run-chat-search';
              const filler = Array.from({ length: 24 }, (_, index) => `铺垫段落 ${index + 1}：这是一段用来拉开消息高度的普通内容。`).join('\\n\\n');
              const assistant = [
                '好的，下面是一些数学内容。',
                filler,
                '## 基础',
                '勾股定理',
                '$$a^2 + b^2 = c^2$$',
                '一元二次方程求根',
                '$$x = \\\\frac{-b \\\\pm \\\\sqrt{b^2 - 4ac}}{2a}$$',
                '## 微积分',
                '牛顿-莱布尼茨公式',
                '$$\\\\int_a^b f(x) dx = F(b) - F(a)$$',
                '$$\\\\mathrm{FormulaOnlyNeedle} = 1$$',
                '```js',
                'const codeNeedle = "代码块也应该能被搜索";',
                '```',
              ].join('\\n\\n');
              window.__chatSearchTranscript = [
                { type: 'user', text: '构造搜索测试对话', clientMessageId: 'u1', deliveryStatus: 'accepted' },
                {
                  type: 'tool',
                  name: 'read_article',
                  toolCallId: 'tool-search-1',
                  runId,
                  args: { url: 'https://example.com/article' },
                  result: { title: '工具命中标题', text: '工具命中正文' },
                },
                { type: 'assistant', content: assistant },
              ];
              window.__emitPortMessage({ type: 'transcript_replace', sessionId, transcript: window.__chatSearchTranscript });
              window.__emitPortMessage({ type: 'agent_end', sessionId, runId });
            }
            """)
            page.wait_for_function("document.querySelectorAll('.msg-assistant').length === 1 && document.querySelector('.msg-tool')", timeout=args.timeout)
            page.wait_for_timeout(250)

            page.keyboard.press("Control+F")
            page.wait_for_function("!document.querySelector('#chat-search-bar')?.classList.contains('hidden')", timeout=args.timeout)
            page.wait_for_function("document.activeElement === document.querySelector('#chat-search-input')", timeout=args.timeout)
            check(page.locator("#chat-search-input").evaluate("node => document.activeElement === node"), "Ctrl-F should focus the internal chat search input")

            page.fill("#chat-search-input", "方程")
            page.keyboard.press("Enter")
            page.wait_for_function("document.querySelector('#chat-search-count')?.textContent === '1/1'", timeout=args.timeout)
            metrics = page.evaluate("""
            () => {
              const messages = document.querySelector('#messages');
              const assistant = document.querySelector('.msg-assistant.chat-search-active');
              const mark = assistant?.querySelector('mark.chat-search-hit');
              const msgRect = messages.getBoundingClientRect();
              const markRect = mark?.getBoundingClientRect();
              const assistantStyle = assistant ? getComputedStyle(assistant) : null;
              return {
                count: document.querySelector('#chat-search-count')?.textContent || '',
                markText: mark?.textContent || '',
                markCenter: markRect ? (markRect.top + markRect.bottom) / 2 : 0,
                viewportTop: msgRect.top,
                viewportBottom: msgRect.bottom,
                assistantOutlineWidth: assistantStyle ? parseFloat(assistantStyle.outlineWidth || '0') : -1,
                assistantOutlineStyle: assistantStyle?.outlineStyle || '',
              };
            }
            """)
            check(metrics["count"] == "1/1", f"ordinary message query should have one match {metrics}")
            check(metrics["markText"] == "方程", f"ordinary message should highlight the concrete text hit {metrics}")
            check(metrics["viewportTop"] + 40 < metrics["markCenter"] < metrics["viewportBottom"] - 40, f"search navigation should scroll to the highlighted text, not just the message card {metrics}")
            check(metrics["assistantOutlineWidth"] == 0 or metrics["assistantOutlineStyle"] == "none", f"ordinary assistant messages should not draw an active search frame {metrics}")

            page.fill("#chat-search-input", "FormulaOnlyNeedle")
            page.wait_for_function("document.querySelector('#chat-search-count')?.textContent === '0/0'", timeout=args.timeout)
            formula_metrics = page.evaluate("""
            () => ({
              count: document.querySelector('#chat-search-count')?.textContent || '',
              formulaMarks: document.querySelectorAll('.math-formula mark.chat-search-hit, mjx-container mark.chat-search-hit').length,
              allMarks: document.querySelectorAll('mark.chat-search-hit').length,
            })
            """)
            check(formula_metrics["count"] == "0/0", f"raw TeX-only text should not produce phantom search matches {formula_metrics}")
            check(formula_metrics["formulaMarks"] == 0 and formula_metrics["allMarks"] == 0, f"math internals should not receive highlight marks {formula_metrics}")

            page.fill("#chat-search-input", "codeNeedle")
            page.keyboard.press("Enter")
            page.wait_for_function("document.querySelector('#chat-search-count')?.textContent === '1/1'", timeout=args.timeout)
            code_metrics = page.evaluate("""
            () => {
              const mark = document.querySelector('.markdown-code-block mark.chat-search-hit, pre mark.chat-search-hit, code mark.chat-search-hit');
              return {
                count: document.querySelector('#chat-search-count')?.textContent || '',
                markText: mark?.textContent || '',
              };
            }
            """)
            check(code_metrics["count"] == "1/1" and code_metrics["markText"] == "codeNeedle", f"code blocks should stay searchable and highlightable {code_metrics}")

            page.fill("#chat-search-input", "采集正文")
            page.keyboard.press("Enter")
            page.wait_for_function("document.querySelector('#chat-search-count')?.textContent === '1/1'", timeout=args.timeout)
            tool_metrics = page.evaluate("""
            () => {
              const tool = document.querySelector('.msg-tool.chat-search-active, .msg-tool-timeline.chat-search-active');
              const style = tool ? getComputedStyle(tool) : null;
              return {
                count: document.querySelector('#chat-search-count')?.textContent || '',
                markText: tool?.querySelector('mark.chat-search-hit')?.textContent || '',
                text: tool?.textContent?.replace(/\\s+/g, ' ').trim() || '',
                outlineWidth: style ? parseFloat(style.outlineWidth || '0') : 0,
                outlineStyle: style?.outlineStyle || '',
              };
            }
            """)
            check(tool_metrics["count"] == "1/1", f"tool query should have one match {tool_metrics}")
            check("采集正文" in tool_metrics["text"], f"tool card should expose the matched summary text {tool_metrics}")
            check(tool_metrics["outlineWidth"] > 0 and tool_metrics["outlineStyle"] != "none", f"tool/thinking cards should keep an active search frame {tool_metrics}")

            page.keyboard.press("Escape")
            page.wait_for_function("document.querySelector('#chat-search-bar')?.classList.contains('hidden')", timeout=args.timeout)
            check(page.locator("mark.chat-search-hit").count() == 0, "closing search should clear highlight marks")

            page.click('[data-tab="skills"]')
            page.wait_for_selector('.skill-card[data-name="search-smoke-skill"]', timeout=args.timeout)
            skill_list_default = page.evaluate("""
            () => ({
              filters: [...document.querySelectorAll('.skill-filter-btn')].map(button => ({
                label: button.textContent.trim(),
                pressed: button.getAttribute('aria-pressed'),
              })),
              names: [...document.querySelectorAll('#skills-list .skill-card')].map(card => card.dataset.name),
              builtinBadges: document.querySelectorAll('#skills-list .skill-system-badge').length,
            })
            """)
            check(skill_list_default["filters"] == [
                {"label": "我的", "pressed": "true"},
                {"label": "内置", "pressed": "false"},
            ], f"Skill list should expose only the two source views {skill_list_default}")
            check(skill_list_default["names"] == ["search-smoke-skill"] and skill_list_default["builtinBadges"] == 0, f"My Skills should own the default first screen {skill_list_default}")

            page.set_viewport_size({"width": 390, "height": 844})
            narrow_skill_layout = page.evaluate("""
            () => {
              const toolbar = document.querySelector('.skills-toolbar');
              const filters = document.querySelector('.skills-filters');
              const actions = document.querySelector('.skills-package-actions');
              const toolbarRect = toolbar.getBoundingClientRect();
              const filtersRect = filters.getBoundingClientRect();
              const actionsRect = actions.getBoundingClientRect();
              return {
                pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                filtersInside: filtersRect.left >= toolbarRect.left && filtersRect.right <= toolbarRect.right,
                actionsInside: actionsRect.left >= toolbarRect.left && actionsRect.right <= toolbarRect.right,
              };
            }
            """)
            check(narrow_skill_layout == {"pageOverflow": 0, "filtersInside": True, "actionsInside": True}, f"Two source filters should remain compact at side-panel width {narrow_skill_layout}")

            page.click("#btn-import-skills")
            page.click("#btn-import-skills-git")
            page.wait_for_selector("#git-skill-sources-panel:not(.hidden)", timeout=args.timeout)
            check(page.locator("#skills-list.hidden").count() == 1 and page.locator(".skills-toolbar.hidden").count() == 1, "Git sources should use the Skill workbench viewport without stacking another card")
            check(page.locator("#git-skill-sources-list .git-skill-source-empty").inner_text() == "还没有绑定仓库", "Empty Git sources should remain compact")
            example_repository = "https://github.com/jackwener/OpenCLI/tree/main/skills"
            page.fill("#git-skill-source-url", example_repository)
            page.click("#btn-bind-git-skill-source")
            page.wait_for_selector('.git-skill-source-row[data-source-id="git-opencli-skills"]', timeout=args.timeout)
            page.wait_for_function("document.querySelector('#git-skill-sources-status')?.textContent.includes('已绑定')", timeout=args.timeout)
            git_source_metrics = page.evaluate("""
            () => {
              const panel = document.querySelector('#git-skill-sources-panel');
              const row = panel.querySelector('.git-skill-source-row');
              const title = row.querySelector('.git-skill-source-title a');
              const branch = row.querySelector('.git-skill-source-title span');
              const actions = [...row.querySelectorAll('.git-skill-source-action')];
              return {
                summary: document.querySelector('#git-skill-sources-summary')?.textContent || '',
                title: title?.textContent || '',
                branch: branch?.textContent || '',
                location: row.querySelector('.git-skill-source-location')?.textContent || '',
                subpath: row.querySelector('.git-skill-source-subpath')?.textContent || '',
                href: title?.href || '',
                actions: actions.map(button => button.getAttribute('title')),
                actionWidths: actions.map(button => button.getBoundingClientRect().width),
                panelOverflow: panel.scrollWidth - panel.clientWidth,
                nestedCards: panel.querySelectorAll('.skill-card').length,
              };
            }
            """)
            check(git_source_metrics["summary"] == "1 个来源" and git_source_metrics["title"] == "OpenCLI" and git_source_metrics["branch"] == "main", f"Bound repository should render a concise identity row {git_source_metrics}")
            check(git_source_metrics["location"] == "github.com / jackwener" and git_source_metrics["subpath"] == "目录 skills" and git_source_metrics["href"] == example_repository, f"Directory binding should keep its visible repository selector {git_source_metrics}")
            check(git_source_metrics["actions"] == ["检查更新", "解除绑定"], f"Repository row should expose stable semantic actions {git_source_metrics}")
            check(git_source_metrics["actionWidths"] == [26, 26] and git_source_metrics["panelOverflow"] == 0 and git_source_metrics["nestedCards"] == 0, f"Repository source controls should stay aligned and unframed {git_source_metrics}")
            check(page.evaluate("window.__gitSourceRequests[0]?.repositoryUrl") == example_repository, "Git binding should forward the repository page URL without asking for SHA")
            capture(page, "git-sources")
            page.click('[data-git-source-action="check"]')
            page.wait_for_selector('[data-git-source-action="update"]', timeout=args.timeout)
            check(page.evaluate("window.__gitSourceRequests[1]?.sourceId") == "git-opencli-skills", "Repository check should use the persisted source identity")
            page.click('[data-git-source-action="update"]')
            page.wait_for_function("document.querySelector('#git-skill-sources-status')?.textContent.includes('已是最新')", timeout=args.timeout)
            check(page.evaluate("window.__gitSourceRequests[2]?.sourceId") == "git-opencli-skills", "Repository update should use the persisted source identity")
            page.click('[data-git-source-action="remove"]')
            page.wait_for_selector("#qz-decision-dialog[open]", timeout=args.timeout)
            check(page.locator("#qz-decision-message").inner_text() == "当前来源包含 1 个已安装 Skill。", "Unbind should explain the safe cleanup choice")
            capture(page, "git-source-remove")
            page.click('[data-qz-decision-value="delete"]')
            page.wait_for_function("document.querySelector('#git-skill-sources-status')?.textContent.includes('清除 1 个 Skill')", timeout=args.timeout)
            check(page.evaluate("window.__gitSourceRequests[3]?.deleteUnmodifiedSkills") is True, "Repository cleanup should request deletion of unchanged Skills only")
            page.click("#btn-close-git-skill-sources")
            page.wait_for_selector("#git-skill-sources-panel", state="hidden", timeout=args.timeout)
            check(page.locator('.skill-card[data-name="search-smoke-skill"]').count() == 1, "Returning from Git sources should restore the user's Skill list")
            page.set_viewport_size({"width": args.width, "height": args.height})

            page.click('[data-skill-filter="builtin"]')
            page.wait_for_function("document.querySelectorAll('#skills-list .skill-card').length > 0", timeout=args.timeout)
            builtin_view = page.evaluate("""
            () => ({
              names: [...document.querySelectorAll('#skills-list .skill-card')].map(card => card.dataset.name),
              cards: document.querySelectorAll('#skills-list .skill-card').length,
              badges: document.querySelectorAll('#skills-list .skill-system-badge').length,
              minePressed: document.querySelector('[data-skill-filter="mine"]')?.getAttribute('aria-pressed'),
              builtinPressed: document.querySelector('[data-skill-filter="builtin"]')?.getAttribute('aria-pressed'),
            })
            """)
            check("search-smoke-skill" not in builtin_view["names"] and builtin_view["cards"] == builtin_view["badges"], f"Builtin view should contain only system skills {builtin_view}")
            check(builtin_view["minePressed"] == "false" and builtin_view["builtinPressed"] == "true", f"Source filter accessibility state should follow selection {builtin_view}")

            page.fill("#skills-search", "search-smoke-skill")
            check(page.locator("#skills-list .skill-card").count() == 0, "search should not leak a user Skill into the builtin view")
            page.fill("#skills-search", "")
            page.click('[data-skill-filter="mine"]')
            page.wait_for_selector('.skill-card[data-name="search-smoke-skill"]', timeout=args.timeout)
            page.click('.skill-card[data-name="search-smoke-skill"]')
            page.wait_for_function("!document.querySelector('#skill-detail')?.classList.contains('hidden')", timeout=args.timeout)

            page.keyboard.press("Control+F")
            page.wait_for_function("!document.querySelector('#skill-search-bar')?.classList.contains('hidden')", timeout=args.timeout)
            page.wait_for_function("document.activeElement === document.querySelector('#skill-search-input')", timeout=args.timeout)
            skill_surface = page.evaluate("""
            () => {
              const search = document.querySelector('#skill-search-bar');
              const style = getComputedStyle(search);
              return {
                focused: document.activeElement === document.querySelector('#skill-search-input'),
                sharedClass: search.classList.contains('chat-search-bar'),
                position: style.position,
                top: style.top,
                right: style.right,
              };
            }
            """)
            check(skill_surface["focused"], f"Ctrl-F should focus Skill detail search {skill_surface}")
            check(skill_surface["sharedClass"] and skill_surface["position"] == "absolute", f"Skill search should reuse the Chat floating surface {skill_surface}")
            check(skill_surface["top"] == "98px" and skill_surface["right"] == "12px", f"Skill search should sit below the unified workbench tabs {skill_surface}")

            page.fill("#skill-search-input", "正文命中词")
            page.wait_for_function("document.querySelector('#skill-search-count')?.textContent === '1/2'", timeout=args.timeout)
            skill_matches = page.evaluate("""
            () => ({
              count: document.querySelector('#skill-search-count')?.textContent || '',
              marks: document.querySelectorAll('#skill-detail-content mark.chat-search-hit').length,
              active: document.querySelectorAll('#skill-detail-content mark.skill-search-active').length,
            })
            """)
            check(skill_matches == {"count": "1/2", "marks": 2, "active": 1}, f"Skill search should index every visible occurrence {skill_matches}")
            page.keyboard.press("Enter")
            page.wait_for_function("document.querySelector('#skill-search-count')?.textContent === '2/2'", timeout=args.timeout)
            page.keyboard.press("Shift+Enter")
            page.wait_for_function("document.querySelector('#skill-search-count')?.textContent === '1/2'", timeout=args.timeout)

            page.fill("#skill-search-input", "codeNeedle")
            page.wait_for_function("document.querySelector('#skill-search-count')?.textContent === '1/1'", timeout=args.timeout)
            check(page.locator("#skill-detail-content code mark.chat-search-hit").count() == 1, "Skill code blocks should remain searchable")

            page.fill("#skill-search-input", "FormulaOnlyNeedle")
            page.wait_for_function("document.querySelector('#skill-search-count')?.textContent === '0/0'", timeout=args.timeout)
            check(page.locator("#skill-detail-content mark.chat-search-hit").count() == 0, "Skill search should skip rendered math internals")

            page.fill("#skill-search-input", "正文命中词")
            page.click("#skill-detail-content")
            page.keyboard.press("Escape")
            page.wait_for_function("document.querySelector('#skill-search-bar')?.classList.contains('hidden')", timeout=args.timeout)
            check(page.locator("#skill-detail-content mark.chat-search-hit").count() == 0, "Escape outside the search input should clear Skill highlights first")
            preview_syntax_metrics = page.evaluate("""
            () => {
              const wrapper = document.querySelector('#skill-detail-content .markdown-code-block');
              const keyword = wrapper?.querySelector('.hljs-keyword');
              return {
                vendor: wrapper?.dataset.highlighter || '',
                language: wrapper?.dataset.language || '',
                keywordColor: keyword ? getComputedStyle(keyword).color : '',
                legacyTokens: document.querySelectorAll('[class*="md-yaml"], .md-heading, .js-keyword, .json-key').length,
              };
            }
            """)
            check(preview_syntax_metrics["vendor"] == "highlight.js" and preview_syntax_metrics["language"] == "javascript" and preview_syntax_metrics["keywordColor"], f"Rendered Markdown code should use the unified highlighter {preview_syntax_metrics}")
            check(preview_syntax_metrics["legacyTokens"] == 0, f"Legacy syntax token systems should be absent {preview_syntax_metrics}")
            check(page.locator(".skill-workbench-toolbar").count() == 0, "Skill panels should not restore duplicate narrow toolbars")
            check(page.locator(".skill-context-action-slot .skill-context-action:visible").get_attribute("id") == "btn-edit-skill", "Content preview should expose the edit command in the stable header slot")

            page.click("#btn-edit-skill")
            page.wait_for_function("!document.querySelector('#skill-editor')?.classList.contains('hidden')", timeout=args.timeout)
            check(page.locator(".skill-context-action-slot .skill-context-action:visible").get_attribute("id") == "btn-preview-skill", "Content editing should replace edit with preview in the same header slot")
            page.keyboard.press("Control+F")
            check(page.locator("#skill-search-bar:not(.hidden)").count() == 0, "Skill editor should keep native find instead of opening detail search")

            body_source = page.locator("#skill-body-text").input_value()
            check(body_source.startswith("# Skill 搜索测试") and not body_source.startswith("---"), "Content editor should hide YAML frontmatter")
            check(page.locator("#skill-body-text").get_attribute("wrap") == "soft", "Content editor should wrap long lines")
            body_editor_metrics = page.evaluate("""
            () => {
              const surface = document.querySelector('.skill-body-editor');
              const textarea = document.querySelector('#skill-body-text');
              const highlight = document.querySelector('#skill-body-highlight');
              const style = getComputedStyle(textarea);
              const surfaceStyle = getComputedStyle(surface);
              const rootStyle = getComputedStyle(document.body);
              const textareaRect = textarea.getBoundingClientRect();
              const highlightRect = highlight.getBoundingClientRect();
              return {
                background: surfaceStyle.backgroundColor,
                rootBackground: rootStyle.backgroundColor,
                paddingLeft: style.paddingLeft,
                paddingRight: style.paddingRight,
                scrollTop: textarea.scrollTop,
                selectionStart: textarea.selectionStart,
                scrollable: textarea.scrollHeight > textarea.clientHeight,
                noHorizontalScroll: textarea.scrollWidth <= textarea.clientWidth + 1,
                overlayAligned: Math.abs(textareaRect.left - highlightRect.left) < 0.5
                  && Math.abs(textareaRect.right - highlightRect.right) < 0.5,
                highlighter: highlight.dataset.highlighter || '',
                markdownTokens: highlight.querySelectorAll('.hljs-section, .hljs-code, .hljs-bullet').length,
              };
            }
            """)
            check(body_editor_metrics["background"] == body_editor_metrics["rootBackground"], f"Content editor should use the workbench background {body_editor_metrics}")
            check(body_editor_metrics["paddingLeft"] == "16px" and body_editor_metrics["paddingRight"] == "16px", f"Content editor should use symmetric 16px gutters {body_editor_metrics}")
            check(body_editor_metrics["scrollable"] and body_editor_metrics["scrollTop"] == 0 and body_editor_metrics["selectionStart"] <= 1, f"Content editor should open at the beginning {body_editor_metrics}")
            check(body_editor_metrics["noHorizontalScroll"] and body_editor_metrics["overlayAligned"], f"Content editor should wrap without desynchronizing highlight {body_editor_metrics}")
            check(body_editor_metrics["highlighter"] == "highlight.js" and body_editor_metrics["markdownTokens"] > 0, f"Content editor should use highlight.js Markdown tokens {body_editor_metrics}")
            capture(page, "body-editor")

            page.click("#skill-tab-resources")
            page.wait_for_selector(".skill-resource-list-row", timeout=args.timeout)
            check(page.locator(".skill-context-action-slot .skill-context-action:visible").get_attribute("id") == "btn-add-skill-resource", "Resources should expose add resource in the stable header slot")
            check(page.locator(".skill-resource-list-row").count() == 2, "Resource tab should show every package file in order")
            resource_icon_metrics = page.evaluate("""
            () => {
              const rows = [...document.querySelectorAll('.skill-resource-list-row')];
              const scriptIcon = rows[0]?.querySelector('.skill-list-type-icon svg');
              const jsonIcon = rows[1]?.querySelector('.skill-list-type-icon svg');
              return {
                scriptPaths: scriptIcon?.querySelectorAll('path').length || 0,
                scriptWidth: scriptIcon ? getComputedStyle(scriptIcon).width : '',
                jsonPaths: jsonIcon?.querySelectorAll('path').length || 0,
                jsonText: rows[1]?.querySelector('.skill-list-type-icon')?.textContent.trim() || '',
              };
            }
            """)
            check(resource_icon_metrics["scriptPaths"] == 2 and resource_icon_metrics["scriptWidth"] == "17px", f"Script resources should use the stable file-code icon {resource_icon_metrics}")
            check(resource_icon_metrics["jsonPaths"] == 2 and resource_icon_metrics["jsonText"] == "", f"JSON resources should use a spaced braces icon instead of text punctuation {resource_icon_metrics}")
            capture(page, "resources")
            page.click('[data-skill-resource-action="open"][data-index="0"]')
            page.wait_for_selector(".skill-resource-edit-shell", timeout=args.timeout)
            check(page.locator(".skill-resource-detail-name").inner_text() == "scripts/extract.mjs", "Resource row should open its detail editor")
            check(page.locator(".skill-resource-edit-path").count() == 0, "Resource detail should not keep a separate rename field")
            page.dblclick(".skill-resource-detail-name")
            page.wait_for_selector(".skill-resource-inline-name", timeout=args.timeout)
            capture(page, "resource-rename")
            selected_resource_name = page.evaluate("""
            () => {
              const input = document.querySelector('.skill-resource-inline-name');
              return input.value.slice(input.selectionStart, input.selectionEnd);
            }
            """)
            check(selected_resource_name == "extract", f"Inline rename should select the basename without its extension {selected_resource_name}")
            page.fill(".skill-resource-inline-name", "scripts/extract-renamed.mjs")
            page.keyboard.press("Enter")
            page.wait_for_selector(".skill-resource-inline-name", state="detached", timeout=args.timeout)
            check(page.locator(".skill-resource-detail-name").inner_text() == "scripts/extract-renamed.mjs", "Enter should commit the inline resource rename")
            check(page.locator(".skill-resource-code-editor").get_attribute("data-resource-path") == "scripts/extract-renamed.mjs", "Renaming should update the resource highlighter language source")
            page.dblclick(".skill-resource-detail-name")
            page.fill(".skill-resource-inline-name", "plugin.json")
            page.keyboard.press("Enter")
            check(page.locator(".skill-resource-inline-name").get_attribute("aria-invalid") == "true", "Duplicate resource paths should remain in rename mode")
            page.keyboard.press("Escape")
            page.wait_for_selector(".skill-resource-inline-name", state="detached", timeout=args.timeout)
            check(page.locator(".skill-resource-detail-name").inner_text() == "scripts/extract-renamed.mjs", "Escape should cancel an inline resource rename")
            check(page.locator(".skill-resource-edit-content").get_attribute("wrap") == "soft", "Resource editor should wrap long lines")
            resource_editor_metrics = page.evaluate("""
            () => {
              const surface = document.querySelector('.skill-resource-code-editor');
              const textarea = document.querySelector('.skill-resource-edit-content');
              const highlight = document.querySelector('.skill-resource-edit-highlight');
              const style = getComputedStyle(textarea);
              const textareaRect = textarea.getBoundingClientRect();
              const highlightRect = highlight.getBoundingClientRect();
              const keyword = highlight.querySelector('.hljs-keyword');
              const comment = highlight.querySelector('.hljs-comment');
              return {
                background: getComputedStyle(surface).backgroundColor,
                paddingLeft: style.paddingLeft,
                paddingRight: style.paddingRight,
                noHorizontalScroll: textarea.scrollWidth <= textarea.clientWidth + 1,
                overlayAligned: Math.abs(textareaRect.left - highlightRect.left) < 0.5
                  && Math.abs(textareaRect.right - highlightRect.right) < 0.5,
                highlighter: highlight.dataset.highlighter || '',
                keywordColor: keyword ? getComputedStyle(keyword).color : '',
                commentStyle: comment ? getComputedStyle(comment).fontStyle : '',
              };
            }
            """)
            check(resource_editor_metrics["background"] == body_editor_metrics["background"], f"Resource and Markdown editors should share one surface {resource_editor_metrics}")
            check(resource_editor_metrics["paddingLeft"] == body_editor_metrics["paddingLeft"] and resource_editor_metrics["paddingRight"] == body_editor_metrics["paddingRight"], f"Resource and Markdown editor gutters should align {resource_editor_metrics}")
            check(resource_editor_metrics["noHorizontalScroll"] and resource_editor_metrics["overlayAligned"], f"Resource editor should wrap without desynchronizing highlight {resource_editor_metrics}")
            check(resource_editor_metrics["highlighter"] == "highlight.js" and resource_editor_metrics["keywordColor"] == preview_syntax_metrics["keywordColor"], f"Rendered and editable code should share one syntax theme {resource_editor_metrics}")
            check(resource_editor_metrics["commentStyle"] == "normal", f"Editor token typography should preserve caret geometry {resource_editor_metrics}")
            capture(page, "resource-detail")
            page.click('[data-skill-resource-action="back"]')
            check(page.locator(".skill-resource-list-row").count() == 2, "Resource detail should return to the complete list")
            check(page.locator(".skill-resource-list-row").first.locator(".skill-list-row-title").inner_text() == "scripts/extract-renamed.mjs", "Resource list should immediately reflect an inline rename")

            page.click("#skill-tab-mcp")
            page.wait_for_selector(".skill-mcp-list-row", timeout=args.timeout)
            check(page.locator(".skill-context-action-slot .skill-context-action:visible").get_attribute("id") == "btn-add-skill-mcp", "MCP should expose add MCP in the stable header slot")
            check(page.locator(".skill-mcp-list-row").count() == 1, "MCP tab should render manifest connections")
            check(page.locator(".skill-mcp-list-row .skill-list-type-label").evaluate("node => getComputedStyle(node).fontSize") == "10px", "MCP icon text should stay compact")
            check(page.locator(".skill-mcp-list-row .skill-mcp-connected").inner_text() == "已启用", "MCP list should use the settled enabled label")
            page.click('[data-skill-mcp-action="open"][data-index="0"]')
            page.wait_for_selector(".skill-mcp-edit-item", timeout=args.timeout)
            check(page.locator(".skill-mcp-edit-id").input_value() == "rendertron", "MCP row should open its detail editor")
            mcp_header_metrics = page.evaluate("""
            () => {
              const header = document.querySelector('.skill-mcp-detail-header');
              const title = header?.querySelector('strong');
              const status = header?.querySelector('.skill-mcp-enabled');
              const titleRect = title?.getBoundingClientRect();
              const statusRect = status?.getBoundingClientRect();
              return {
                statusText: status?.querySelector('.skill-mcp-enabled-text')?.textContent || '',
                statusInHeader: Boolean(status && header?.contains(status)),
                statusInForm: Boolean(document.querySelector('.skill-mcp-form-section .skill-mcp-enabled')),
                titleGap: titleRect && statusRect ? statusRect.left - titleRect.right : -1,
              };
            }
            """)
            check(mcp_header_metrics["statusText"] == "已启用" and mcp_header_metrics["statusInHeader"] and not mcp_header_metrics["statusInForm"], f"MCP enabled state should live beside the detail title {mcp_header_metrics}")
            check(0 <= mcp_header_metrics["titleGap"] <= 12, f"MCP status should stay visually attached to the title {mcp_header_metrics}")
            page.click(".skill-mcp-detail-header .skill-mcp-enabled")
            page.wait_for_function("document.querySelector('.skill-mcp-enabled-text')?.textContent === '已停用'", timeout=args.timeout)
            check(page.locator(".skill-mcp-enabled-text").inner_text() == "已停用", "MCP detail should use the settled disabled label")
            page.click(".skill-mcp-detail-header .skill-mcp-enabled")
            page.wait_for_function("document.querySelector('.skill-mcp-enabled-text')?.textContent === '已启用'", timeout=args.timeout)
            test_button_width = page.locator('[data-skill-mcp-action="test"]').bounding_box()["width"]
            page.click('[data-skill-mcp-action="test"]')
            page.wait_for_function("document.querySelector('.skill-mcp-test-result')?.textContent === '连接正常'", timeout=args.timeout)
            check(page.locator(".skill-mcp-test-result").inner_text() == "连接正常", "MCP detail should validate the current connection without saving")
            mcp_success_metrics = page.evaluate("""
            () => {
              const row = document.querySelector('.skill-mcp-test-row');
              const result = row?.querySelector('.skill-mcp-test-result');
              const style = getComputedStyle(result);
              const dotStyle = getComputedStyle(result, '::before');
              return {
                success: result?.classList.contains('success') === true,
                display: style.display,
                background: style.backgroundColor,
                width: result?.getBoundingClientRect().width || 0,
                dotWidth: dotStyle.width,
              };
            }
            """)
            check(mcp_success_metrics["success"] and mcp_success_metrics["display"] in {"flex", "inline-flex"} and mcp_success_metrics["background"] == "rgba(0, 0, 0, 0)" and mcp_success_metrics["width"] < 100 and mcp_success_metrics["dotWidth"] == "6px", f"MCP success should be a compact unframed status {mcp_success_metrics}")
            capture(page, "mcp-detail")
            page.evaluate("""
            window.__skillMcpValidationError = 'MCP 校验失败: rendertron - Streamable HTTP error: Error POSTing to endpoint: {"error":{"message":"Invalid session id.","request_id":"874edacb-fd11-4ad6-ba74-95c419ccfe86"}}';
            """)
            page.click('[data-skill-mcp-action="test"]')
            page.wait_for_selector(".skill-mcp-test-result.error", timeout=args.timeout)
            mcp_error_metrics = page.evaluate(r"""
            () => {
              const row = document.querySelector('.skill-mcp-test-row');
              const button = row?.querySelector('[data-skill-mcp-action="test"]');
              const result = row?.querySelector('.skill-mcp-test-result');
              const buttonRect = button?.getBoundingClientRect();
              const resultRect = result?.getBoundingClientRect();
              return {
                buttonWidth: buttonRect?.width || 0,
                buttonHeight: buttonRect?.height || 0,
                buttonWhiteSpace: button ? getComputedStyle(button).whiteSpace : '',
                resultSeparated: resultRect.top >= buttonRect.bottom - 0.5,
                rowNoOverflow: row.scrollWidth <= row.clientWidth + 1,
                resultNoOverflow: result.scrollWidth <= result.clientWidth + 1,
                resultText: result.textContent || '',
              };
            }
            """)
            check(abs(mcp_error_metrics["buttonWidth"] - test_button_width) < 0.5 and mcp_error_metrics["buttonHeight"] == 34 and mcp_error_metrics["buttonWhiteSpace"] == "nowrap", f"Long MCP errors should not collapse the test button {mcp_error_metrics}")
            check(mcp_error_metrics["resultSeparated"] and mcp_error_metrics["rowNoOverflow"] and mcp_error_metrics["resultNoOverflow"], f"MCP errors should wrap in an independent result surface {mcp_error_metrics}")
            check("Invalid session id" in mcp_error_metrics["resultText"], f"MCP error details should remain available {mcp_error_metrics}")
            capture(page, "mcp-detail-error")
            page.evaluate("window.__skillMcpValidationError = ''")

            page.click("#skill-tab-content")
            page.wait_for_function("document.querySelector('#btn-preview-skill')?.getAttribute('aria-pressed') === 'true'", timeout=args.timeout)
            check(page.locator("#skill-content-preview:not(.hidden)").count() == 1, "Returning to Content should default to preview")

            page.click("#btn-skill-actions")
            page.wait_for_selector("#skill-actions-menu:not(.hidden)", timeout=args.timeout)
            page.click("#btn-skill-settings")
            page.wait_for_selector("#skill-settings-view:not(.hidden)", timeout=args.timeout)
            page.wait_for_timeout(300)
            check(page.locator("#skill-config-allowed-tools, #skill-config-compatibility, #skill-config-license").count() == 0, "Advanced runtime metadata should stay out of basic settings")
            settings_metrics = page.evaluate("""
            () => {
              const scroll = document.querySelector('.skill-settings-scroll');
              const scrollRect = scroll.getBoundingClientRect();
              const advancedRect = document.querySelector('.skill-config-advanced').getBoundingClientRect();
              const visibleTextareas = Array.from(document.querySelectorAll('#skill-settings-view textarea'))
                .filter(field => field.offsetParent !== null);
              return {
                hasOuterScrollbar: scroll.scrollHeight > scroll.clientHeight + 1,
                hasNestedScrollbar: visibleTextareas.some(field => field.scrollHeight > field.clientHeight + 1),
                advancedVisible: advancedRect.bottom <= scrollRect.bottom + 1,
                identityColumns: getComputedStyle(document.querySelector('.skill-config-identity-grid')).gridTemplateColumns.split(' ').length,
                sectionCount: document.querySelectorAll('#skill-settings-view .skill-config-section').length,
                enabledWidth: getComputedStyle(document.querySelector('#skill-config-enabled')).width,
                textareaSizes: visibleTextareas.map(field => ({
                  id: field.id,
                  clientHeight: field.clientHeight,
                  scrollHeight: field.scrollHeight,
                  styleHeight: field.style.height,
                })),
              };
            }
            """)
            check(not settings_metrics["hasOuterScrollbar"] and not settings_metrics["hasNestedScrollbar"], f"Compact settings should avoid outer and nested scrollbars {settings_metrics}")
            check(settings_metrics["advancedVisible"] and settings_metrics["identityColumns"] == 2 and settings_metrics["sectionCount"] == 3, f"Settings should keep a compact complete hierarchy {settings_metrics}")
            check(settings_metrics["enabledWidth"] == "30px", f"Enabled state should use the compact neutral switch {settings_metrics}")
            page.fill("#skill-config-display-name", "Skill 工作台测试")
            check(page.locator("#btn-save-skill-edit-top").is_enabled(), "Structured config changes should enable Save")
            capture(page, "settings")
            page.click("#btn-open-skill-source")
            page.wait_for_selector("#skill-source-view:not(.hidden)", timeout=args.timeout)
            page.wait_for_function("""
            () => {
              const editor = document.querySelector('#skill-editor-text');
              return editor && editor.scrollHeight > editor.clientHeight && editor.scrollTop === 0 && editor.selectionStart === 0;
            }
            """, timeout=args.timeout)
            full_source = page.locator("#skill-editor-text").input_value()
            check('displayName: "Skill 工作台测试"' in full_source, "Structured config should synchronize into full SKILL.md")
            check('license: "Internal"' in full_source, "Hidden runtime metadata should pass through to full SKILL.md")
            check(page.locator("#skill-editor-text").get_attribute("wrap") == "soft", "Full source editor should wrap long lines")
            source_editor_metrics = page.evaluate("""
            () => {
              const surface = document.querySelector('.skill-source-editor .markdown-editor');
              const textarea = document.querySelector('#skill-editor-text');
              const highlight = document.querySelector('#skill-editor-highlight');
              const style = getComputedStyle(textarea);
              const textareaRect = textarea.getBoundingClientRect();
              const highlightRect = highlight.getBoundingClientRect();
              return {
                background: getComputedStyle(surface).backgroundColor,
                paddingLeft: style.paddingLeft,
                paddingRight: style.paddingRight,
                scrollTop: textarea.scrollTop,
                selectionStart: textarea.selectionStart,
                scrollable: textarea.scrollHeight > textarea.clientHeight,
                noHorizontalScroll: textarea.scrollWidth <= textarea.clientWidth + 1,
                overlayAligned: Math.abs(textareaRect.left - highlightRect.left) < 0.5
                  && Math.abs(textareaRect.right - highlightRect.right) < 0.5,
                highlighter: highlight.dataset.highlighter || '',
                yamlTokens: highlight.querySelectorAll('.hljs-attr, .hljs-string, .hljs-meta').length,
                markdownTokens: highlight.querySelectorAll('.hljs-section, .hljs-code, .hljs-bullet').length,
              };
            }
            """)
            check(source_editor_metrics["background"] == body_editor_metrics["background"], f"Full source and body editors should share one surface {source_editor_metrics}")
            check(source_editor_metrics["paddingLeft"] == body_editor_metrics["paddingLeft"] and source_editor_metrics["paddingRight"] == body_editor_metrics["paddingRight"], f"Full source and body editor gutters should align {source_editor_metrics}")
            check(source_editor_metrics["scrollable"] and source_editor_metrics["scrollTop"] == 0 and source_editor_metrics["selectionStart"] == 0, f"Full source should open at the beginning {source_editor_metrics}")
            check(source_editor_metrics["noHorizontalScroll"] and source_editor_metrics["overlayAligned"], f"Full source should wrap without desynchronizing highlight {source_editor_metrics}")
            check(source_editor_metrics["highlighter"] == "highlight.js" and source_editor_metrics["yamlTokens"] > 0 and source_editor_metrics["markdownTokens"] > 0, f"Full source should compose YAML and Markdown with one highlighter {source_editor_metrics}")
            capture(page, "source")
            page.click("#btn-close-skill-source")
            page.click("#btn-close-skill-settings")
            page.click("#btn-save-skill-edit-top")
            page.wait_for_function("document.querySelector('#btn-save-skill-edit-top')?.textContent.includes('已保存')", timeout=args.timeout)
            saved_visual = page.evaluate("""
            () => {
              const save = document.querySelector('#btn-save-skill-edit-top');
              const visible = element => Boolean(element && element.offsetParent !== null);
              return {
                saved: save?.classList.contains('saved') === true,
                disabled: save?.disabled === true,
                label: save?.textContent.trim() || '',
                dots: document.querySelectorAll('.skill-save-state-dot').length,
                menus: document.querySelectorAll('#btn-skill-actions, #skill-actions-menu').length,
                exportVisible: visible(document.querySelector('#btn-export-skill')),
                deleteVisible: visible(document.querySelector('#btn-delete-skill')),
              };
            }
            """)
            check(saved_visual == {"saved": True, "disabled": True, "label": "已保存", "dots": 0, "menus": 2, "exportVisible": False, "deleteVisible": False}, f"Low-frequency Skill actions should stay in the shared closed overflow menu {saved_visual}")
            saved_skill = page.evaluate("window.__skillWorkbenchStorage._skills['search-smoke-skill']")
            check(saved_skill.get("metadata", {}).get("displayName") == "Skill 工作台测试", "Saving should persist structured displayName")
            check(saved_skill.get("license") == "Internal", "Saving should silently preserve license metadata")
            check(saved_skill.get("compatibility") == "Qingzhou 0.4+", "Saving should silently preserve compatibility metadata")
            check(saved_skill.get("allowed-tools") == "page_read page_click", "Saving should silently preserve allowed-tools metadata")
            check(saved_skill.get("resources", [])[0].get("path") == "scripts/extract-renamed.mjs", "Saving should persist an inline resource rename")
            layout = page.evaluate("""
            () => ({
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              workbenchWidth: document.querySelector('.skill-workbench-body')?.clientWidth || 0,
            })
            """)
            check(layout["clientWidth"] == layout["scrollWidth"] and layout["workbenchWidth"] > 0, f"Skill workbench should not overflow the side panel {layout}")

            if args.screenshot:
                page.screenshot(path=args.screenshot, full_page=True)
        finally:
            page.close()
            browser.close()

    ok = not result["failures"] and not result["pageErrors"] and not result["consoleErrors"]
    if args.json or not ok:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"chat search smoke PASS assertions={result['assertions']} failures=0")
    return 0 if ok else 1


def main():
    parser = ArgumentParser(description="Run sidepanel chat search smoke tests in headless Chromium.")
    parser.add_argument("--headed", action="store_true", help="Run Chromium headed.")
    parser.add_argument("--json", action="store_true", help="Print full test payload as JSON.")
    parser.add_argument("--screenshot", help="Optional screenshot path.")
    parser.add_argument("--width", type=int, default=980, help="Browser viewport width.")
    parser.add_argument("--height", type=int, default=900, help="Browser viewport height.")
    parser.add_argument("--color-scheme", choices=("light", "dark"), default="light", help="Preferred color scheme.")
    parser.add_argument("--timeout", type=int, default=20000, help="Playwright wait timeout in ms.")
    raise SystemExit(run(parser.parse_args()))


if __name__ == "__main__":
    main()
