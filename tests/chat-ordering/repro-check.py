#!/usr/bin/env python3
from pathlib import Path
import argparse
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


def transcript_dom(page):
    return page.evaluate(r"""
    () => Array.from(document.querySelectorAll('#messages [data-transcript-key]')).map(el => ({
      key: el.dataset.transcriptKey || '',
      type: el.dataset.transcriptType || '',
      live: el.dataset.transcriptLive || '',
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }))
    """)


def render_trace(page):
    return page.evaluate("""
    () => {
      return {
        traces: (window.__qingzhouPerf || [])
          .filter(entry => ['chat.renderTranscript', 'chat.renderTranscript.reconcile', 'chat.livePatchTail'].includes(entry.name))
          .slice(-12)
          .map(entry => ({ name: entry.name, meta: entry.meta || {}, ms: entry.ms || 0 })),
      };
    }
    """)


def run(verbose=False):
    result = {
        "probe": "live-tail-filtered-wait",
        "bugReproduced": False,
        "playbackOverlapReproduced": False,
        "interruptedReplayReproduced": False,
        "sessionSwitchSnapshotReproduced": False,
        "lateRunEventAccepted": False,
        "rapidSessionSwitchReproduced": False,
        "before": [],
        "during": [],
        "afterTerminal": [],
        "traceBefore": {},
        "traceDuring": {},
        "traceAfterTerminal": {},
        "playbackStates": [],
        "interruptedBeforeState": {},
        "interruptedAfterState": {},
        "interruptedAfterReturn": {},
        "interruptedAfterReturnDom": [],
        "switchBeforeSnapshot": [],
        "switchAfterSnapshot": [],
        "lateRunDom": [],
        "rapidSwitchFinal": {},
        "authoritativeEmptyDom": [],
        "pageErrors": [],
        "consoleErrors": [],
    }

    with serve_repo() as base_url, sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"),
        )
        page = browser.new_page(locale="zh-CN", viewport={"width": 1100, "height": 900})
        page.on("pageerror", lambda exc: result["pageErrors"].append(str(exc)))
        page.on("console", lambda msg: result["consoleErrors"].append(msg.text) if msg.type == "error" else None)
        page.add_init_script("""
        (() => {
          const listeners = { message: [], disconnect: [], changed: [] };
          const session = { id: 'sess-ordering-probe', title: 'Ordering probe', parentSessionId: 'root' };
          const storage = { qz_data_consent: { version: 1, acceptedAt: 1 }, _sessions: {} };
          const runtimes = {};
          const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
          const storageDelay = async keys => {
            const values = Array.isArray(keys) ? keys : [keys];
            const delay = Math.max(0, ...values.map(key => Number(window.__orderingStorageDelays?.[key] || 0)));
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          };
          const emit = event => {
            const eventSessionId = event?.sessionId || session.id;
            if (event?.type === 'agent_start') {
              runtimes[eventSessionId] = { status: 'running', running: true, runId: event.runId || null };
            } else if (event?.type === 'state') {
              const previous = runtimes[eventSessionId] || {};
              runtimes[eventSessionId] = clone(event.runtime || {
                ...previous,
                status: event.status || previous.status || 'idle',
                running: event.isStreaming === true,
                runId: event.runId || previous.runId || null,
              });
            } else if (['agent_end', 'aborted', 'error'].includes(event?.type)) {
              const previous = runtimes[eventSessionId] || {};
              runtimes[eventSessionId] = {
                status: event.type === 'agent_end' ? 'completed' : event.type,
                running: false,
                runId: event.runId || previous.runId || null,
              };
            }
            listeners.message.slice().forEach(fn => fn(event));
          };
          const storageGet = async keys => {
            await storageDelay(keys);
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
                  config: { provider: 'openai', model: 'gpt-test', apiKey: 'test', modelProvider: 'openai', debugMode: true },
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
                const messageSessionId = msg.sessionId || session.id;
                if (window.__orderingBlockedSnapshots?.has(messageSessionId)) return;
                const delay = Number(window.__orderingSnapshotDelays?.[messageSessionId] || 0);
                const transcript = clone(window.__orderingSnapshots?.[messageSessionId] || []);
                setTimeout(() => emit({ type: 'messages', sessionId: messageSessionId, transcript, save: false }), delay);
                return;
              }
              if (msg.type === 'get_state') {
                const stateSessionId = msg.sessionId || session.id;
                const runtime = runtimes[stateSessionId] || { status: 'idle', running: false, runId: null };
                setTimeout(() => emit({
                  type: 'state',
                  sessionId: stateSessionId,
                  isStreaming: runtime.running,
                  runId: runtime.runId,
                  status: runtime.status,
                  runtime: clone(runtime),
                }), 0);
                return;
              }
              if (msg.type === 'get_composer_draft' && msg.requestId) {
                setTimeout(() => emit({
                  type: 'get_composer_draft_result',
                  requestId: msg.requestId,
                  sessionId: msg.sessionId,
                  draft: null,
                }), 0);
                return;
              }
              if (msg.type === 'get_session_artifacts') {
                setTimeout(() => emit({ requestId: msg.requestId, artifacts: {} }), 0);
                return;
              }
              if (msg.type === 'prompt') window.__lastPromptMessage = msg;
            },
          };
          window.__orderingStorage = storage;
          window.__orderingSnapshots = {};
          window.__orderingBlockedSnapshots = new Set();
          window.__orderingSnapshotDelays = {};
          window.__orderingStorageDelays = {};
          window.__emitPortMessage = emit;
          window.__emitStorageChange = (changes, area = 'local') => {
            listeners.changed.slice().forEach(fn => fn(changes, area));
          };
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

        page.goto(f"{base_url}{SIDEPANEL_PATH}", wait_until="domcontentloaded")
        page.wait_for_selector("#input", timeout=10000)
        page.fill("#input", "Run ordering probe")
        page.click("#btn-send")
        page.wait_for_function("window.__lastPromptMessage && document.querySelectorAll('.msg-user').length === 1")

        page.evaluate("""
        () => {
          const sessionId = 'sess-ordering-probe';
          const runId = 'run-ordering-probe';
          window.__emitPortMessage({ type: 'agent_start', sessionId, runId });
          window.__emitPortMessage({
            type: 'tool_execution_start', sessionId, runId, eventSeq: 1,
            spanId: 'tool:call-wait', toolCallId: 'call-wait', toolName: 'wait', args: { seconds: 2 },
          });
          window.__emitPortMessage({
            type: 'tool_execution_end', sessionId, runId, eventSeq: 2,
            spanId: 'tool:call-wait', toolCallId: 'call-wait', toolName: 'wait', args: { seconds: 2 }, result: { waited: 2 },
          });
        }
        """)
        page.wait_for_function("Array.from(document.querySelectorAll('[data-transcript-key]')).some(el => el.dataset.transcriptKey.includes('call-wait'))")
        result["before"] = transcript_dom(page)
        result["traceBefore"] = render_trace(page)

        page.evaluate("""
        () => {
          const sessionId = 'sess-ordering-probe';
          const runId = 'run-ordering-probe';
          window.__emitPortMessage({
            type: 'tool_execution_start', sessionId, runId, eventSeq: 3,
            spanId: 'tool:call-read', toolCallId: 'call-read', toolName: 'read_article', args: { url: 'https://example.com' },
          });
        }
        """)
        page.wait_for_function("Array.from(document.querySelectorAll('[data-transcript-key]')).some(el => el.dataset.transcriptKey.includes('call-read'))")
        page.wait_for_timeout(120)
        result["during"] = transcript_dom(page)
        result["traceDuring"] = render_trace(page)

        wait_present_during = any("call-wait" in item["key"] for item in result["during"])
        read_present_during = any("call-read" in item["key"] for item in result["during"])
        result["bugReproduced"] = wait_present_during and read_present_during

        page.evaluate("""
        () => window.__emitPortMessage({
          type: 'agent_end', sessionId: 'sess-ordering-probe', runId: 'run-ordering-probe', eventSeq: 4,
        })
        """)
        page.wait_for_function("!Array.from(document.querySelectorAll('[data-transcript-key]')).some(el => el.dataset.transcriptKey.includes('call-wait'))")
        result["afterTerminal"] = transcript_dom(page)
        result["traceAfterTerminal"] = render_trace(page)

        page.evaluate("""
        () => {
          const sessionId = 'sess-ordering-probe';
          const runId = 'run-playback-probe';
          window.__emitPortMessage({ type: 'agent_start', sessionId, runId });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 1, spanId: 'llm-playback-1',
            message: { role: 'user', content: 'Continue playback probe', clientMessageId: 'playback-user' },
            clientMessageId: 'playback-user', deliveryStatus: 'accepted',
          });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 2, spanId: 'llm-playback-1',
            message: { role: 'assistant', content: '' },
          });
          window.__playbackFirst = Array.from({ length: 240 }, (_, index) => `First response paragraph ${index + 1}.`).join(' ');
          window.__emitPortMessage({
            type: 'message_update', sessionId, runId, eventSeq: 3, spanId: 'llm-playback-1',
            content: window.__playbackFirst,
          });
        }
        """)
        page.wait_for_function("document.querySelector('[data-transcript-key*=\"llm-playback-1\"]')?.dataset.transcriptLive === 'true'")
        page.wait_for_timeout(35)

        page.evaluate("""
        () => {
          const sessionId = 'sess-ordering-probe';
          const runId = 'run-playback-probe';
          window.__emitPortMessage({
            type: 'message_end', sessionId, runId, eventSeq: 4, spanId: 'llm-playback-1',
            message: { role: 'assistant', content: window.__playbackFirst },
          });
          window.__emitPortMessage({
            type: 'tool_execution_start', sessionId, runId, eventSeq: 5,
            spanId: 'tool:call-fast', toolCallId: 'call-fast', toolName: 'get_current_tab', args: {},
          });
          window.__emitPortMessage({
            type: 'tool_execution_end', sessionId, runId, eventSeq: 6,
            spanId: 'tool:call-fast', toolCallId: 'call-fast', toolName: 'get_current_tab', args: {}, result: { id: 1 },
          });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 7, spanId: 'llm-playback-2',
            message: { role: 'assistant', content: '' },
          });
          window.__playbackSecond = Array.from({ length: 80 }, (_, index) => `Second response paragraph ${index + 1}.`).join(' ');
          window.__emitPortMessage({
            type: 'message_update', sessionId, runId, eventSeq: 8, spanId: 'llm-playback-2',
            content: window.__playbackSecond,
          });
        }
        """)
        page.wait_for_function("document.querySelector('[data-transcript-key*=\"llm-playback-2\"]')?.dataset.transcriptLive === 'true'")
        page.wait_for_timeout(45)
        result["playbackStates"] = page.evaluate("""
        () => Array.from(document.querySelectorAll('.msg-assistant')).map(el => ({
          key: el.dataset.transcriptKey || '',
          live: el.dataset.transcriptLive || '',
          visibleChars: (el.dataset.content || '').length,
          finalChars: (el.dataset.finalContent || '').length,
          visuallyPlaying: el.dataset.transcriptLive === 'true'
            || Boolean(el.dataset.finalContent && el.dataset.content !== el.dataset.finalContent),
        })).filter(item => item.key.includes('llm-playback-'))
        """)
        result["playbackOverlapReproduced"] = sum(1 for item in result["playbackStates"] if item["visuallyPlaying"]) >= 2

        page.evaluate("""
        () => window.__emitPortMessage({
          type: 'agent_end', sessionId: 'sess-ordering-probe', runId: 'run-playback-probe', eventSeq: 9,
        })
        """)

        # Exported badcase: storage is one turn behind while the Side Panel still owns a partial live turn.
        page.evaluate("""
        () => {
          const sourceId = 'sess-interrupted-replay';
          const otherId = 'sess-interrupted-other';
          const savedAt = '2026-07-15 15:14:05';
          const makeSession = (id, title, updatedAt) => ({
            id,
            title,
            parentSessionId: '0',
            createdAt: '2026-07-15 15:11:59',
            updatedAt,
          });
          const makeRecord = transcript => ({
            type: 'qz-browser-agent-session',
            version: 4,
            conversation: { type: 'conversation', version: 1, entries: [] },
            transcript,
            savedAt,
          });
          const staleTranscript = [
            {
              type: 'user',
              text: 'Fork Subagent 是否真正调用 Linux fork？',
              clientMessageId: 'interrupted-history-user',
              timestamp: '2026-07-15 15:11:59',
            },
            {
              type: 'assistant',
              content: '上一轮已经完整结束的回答。',
              spanId: 'interrupted-history-assistant',
              runId: 'run-interrupted-history',
              timestamp: '2026-07-15 15:13:54',
              endedAt: savedAt,
            },
          ];
          window.__orderingStorage._sessions[sourceId] = makeSession(
            sourceId,
            'Interrupted replay source',
            '2026-07-15 15:22:07',
          );
          window.__orderingStorage._sessions[otherId] = makeSession(
            otherId,
            'Interrupted replay detour',
            '2026-07-15 15:21:00',
          );
          window.__orderingStorage[`_session_${sourceId}`] = makeRecord(staleTranscript);
          window.__orderingStorage[`_session_${otherId}`] = makeRecord([
            {
              type: 'user',
              text: '临时切换到另一个任务。',
              clientMessageId: 'interrupted-detour-user',
              timestamp: '2026-07-15 15:20:00',
            },
            {
              type: 'assistant',
              content: '另一个任务的回答。',
              spanId: 'interrupted-detour-assistant',
              runId: 'run-interrupted-detour',
              timestamp: '2026-07-15 15:20:01',
              endedAt: '2026-07-15 15:20:02',
            },
          ]);
          window.__orderingSnapshots[sourceId] = staleTranscript;
          window.__orderingSnapshots[otherId] = window.__orderingStorage[`_session_${otherId}`].transcript;
          // The worker restart drops the in-flight transcript request; get_state still reconnects.
          window.__orderingBlockedSnapshots.add(sourceId);
          window.__emitPortMessage({ type: 'sessions_changed' });
        }
        """)
        page.click('[data-tab="sessions"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-interrupted-replay"]')
        page.click('[role="treeitem"][data-id="sess-interrupted-replay"]')
        page.wait_for_function("document.querySelector('#current-session-title')?.textContent === 'Interrupted replay source'")

        page.evaluate("""
        () => {
          const sessionId = 'sess-interrupted-replay';
          const runId = 'run-interrupted-live';
          const spanId = 'llm-interrupted-partial';
          window.__interruptedPartial = [
            '好问题！我来把源码里这套完成通知机制讲清楚。',
            ...Array.from({ length: 80 }, (_, index) => `这是中断前已经收到的第 ${index + 1} 段正文。`),
          ].join('');
          window.__emitPortMessage({ type: 'agent_start', sessionId, runId });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 1,
            message: {
              role: 'user',
              content: '父 Agent 如何等待 Fork Subagent 完成？',
              clientMessageId: 'interrupted-live-user',
            },
            clientMessageId: 'interrupted-live-user',
            deliveryStatus: 'accepted',
          });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 2, spanId,
            message: { role: 'assistant', content: '' },
          });
          window.__emitPortMessage({
            type: 'message_update', sessionId, runId, eventSeq: 3, spanId,
            content: window.__interruptedPartial,
          });
        }
        """)
        page.wait_for_function("""
        () => {
          const el = document.querySelector('[data-stream-trace-id="llm-interrupted-partial"]');
          return el?.dataset.transcriptLive === 'true' && (el.dataset.content || '').length >= 40;
        }
        """, timeout=3000)
        result["interruptedBeforeState"] = page.evaluate("""
        () => {
          const el = document.querySelector('[data-stream-trace-id="llm-interrupted-partial"]');
          return {
            live: el?.dataset.transcriptLive || '',
            visibleChars: (el?.dataset.content || '').length,
            finalChars: (el?.dataset.finalContent || '').length,
            targetChars: (window.__interruptedPartial || '').length,
          };
        }
        """)

        page.evaluate("""
        () => window.__emitPortMessage({
          type: 'state',
          sessionId: 'sess-interrupted-replay',
          runId: 'run-interrupted-live',
          isStreaming: false,
          status: 'interrupted',
          hasHistory: true,
          runtime: {
            status: 'interrupted',
            running: false,
            runId: 'run-interrupted-live',
            reason: 'service_worker_restarted',
          },
        })
        """)
        page.wait_for_timeout(120)
        result["interruptedAfterState"] = page.evaluate("""
        () => {
          const el = document.querySelector('[data-stream-trace-id="llm-interrupted-partial"]');
          return {
            live: el?.dataset.transcriptLive || '',
            visibleChars: (el?.dataset.content || '').length,
            finalChars: (el?.dataset.finalContent || '').length,
            targetChars: (window.__interruptedPartial || '').length,
          };
        }
        """)

        page.click('[data-tab="sessions"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-interrupted-other"]')
        page.click('[role="treeitem"][data-id="sess-interrupted-other"]')
        page.wait_for_function("document.querySelector('#current-session-title')?.textContent === 'Interrupted replay detour'")
        page.click('[data-tab="sessions"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-interrupted-replay"]')
        page.click('[role="treeitem"][data-id="sess-interrupted-replay"]')
        page.wait_for_function("document.querySelector('#current-session-title')?.textContent === 'Interrupted replay source'")
        result["interruptedAfterReturnDom"] = transcript_dom(page)
        result["interruptedAfterReturn"] = page.evaluate("""
        () => {
          const el = document.querySelector('[data-stream-trace-id="llm-interrupted-partial"]');
          return {
            live: el?.dataset.transcriptLive || '',
            visibleChars: (el?.dataset.content || '').length,
            finalChars: (el?.dataset.finalContent || '').length,
            targetChars: (window.__interruptedPartial || '').length,
          };
        }
        """)
        result["interruptedReplayReproduced"] = (
            result["interruptedAfterReturn"]["live"] == "true"
            and result["interruptedAfterReturn"]["visibleChars"] < result["interruptedAfterReturn"]["targetChars"]
        )

        page.evaluate("""
        () => {
          const sessionId = 'sess-switch-target';
          const runId = 'run-switch-live';
          const staleTranscript = [];
          for (let index = 0; index < 6; index += 1) {
            staleTranscript.push({
              type: 'user',
              text: `Historical request ${index + 1}`,
              timestamp: `2026-07-10 10:0${index}:00`,
            });
            staleTranscript.push({
              type: 'assistant',
              content: `Historical answer ${index + 1}`,
              timestamp: `2026-07-10 10:0${index}:01`,
            });
          }
          window.__orderingStorage._sessions[sessionId] = {
            id: sessionId,
            title: 'Running snapshot target',
            parentSessionId: '0',
            createdAt: '2026-07-10 10:00:00',
            updatedAt: '2026-07-11 12:00:00',
          };
          window.__orderingStorage[`_session_${sessionId}`] = {
            type: 'qz-browser-agent-session',
            version: 4,
            conversation: { type: 'conversation', version: 1, entries: [] },
            transcript: staleTranscript,
            savedAt: '2026-07-10 10:10:00',
          };
          const liveUser = {
            type: 'user', text: 'Current target request', clientMessageId: 'switch-user', deliveryStatus: 'accepted',
            runId, eventSeq: 1, timestamp: '2026-07-11 12:00:01',
          };
          const liveAssistant = {
            type: 'assistant', content: 'Current live assistant content', streaming: true,
            spanId: 'llm-switch-live', runId, eventSeq: 2, timestamp: '2026-07-11 12:00:02',
          };
          window.__orderingSnapshots[sessionId] = [...staleTranscript, liveUser, liveAssistant];
          window.__orderingSnapshotDelays[sessionId] = 800;

          window.__emitPortMessage({ type: 'agent_start', sessionId, runId });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 1,
            message: { role: 'user', content: liveUser.text, clientMessageId: liveUser.clientMessageId },
            clientMessageId: liveUser.clientMessageId, deliveryStatus: 'accepted',
          });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 2, spanId: liveAssistant.spanId,
            message: { role: 'assistant', content: '' },
          });
          window.__emitPortMessage({
            type: 'message_update', sessionId, runId, eventSeq: 3, spanId: liveAssistant.spanId,
            content: liveAssistant.content,
          });
          window.__emitPortMessage({ type: 'sessions_changed', sessionId, session: window.__orderingStorage._sessions[sessionId] });
        }
        """)
        page.click('[data-tab="sessions"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-switch-target"]')
        page.click('[role="treeitem"][data-id="sess-switch-target"]')
        page.wait_for_function("document.querySelector('#messages')?.textContent.includes('Current target request')")
        result["switchBeforeSnapshot"] = transcript_dom(page)
        live_before = any("llm-switch-live" in item["key"] for item in result["switchBeforeSnapshot"])

        page.wait_for_function("document.querySelector('[data-transcript-key*=\"llm-switch-live\"]')?.dataset.transcriptLive === 'true'", timeout=3000)
        result["switchAfterSnapshot"] = transcript_dom(page)
        live_after = any("llm-switch-live" in item["key"] for item in result["switchAfterSnapshot"])
        result["sessionSwitchSnapshotReproduced"] = (not live_before) and live_after

        page.evaluate("""
        () => {
          const sessionId = 'sess-switch-target';
          window.__emitPortMessage({
            type: 'message_end', sessionId, runId: 'run-switch-live', eventSeq: 4, spanId: 'llm-switch-live',
            message: { role: 'assistant', content: 'Current live assistant content' },
          });
          window.__emitPortMessage({ type: 'agent_end', sessionId, runId: 'run-switch-live', eventSeq: 5 });

          const runId = 'run-switch-next';
          window.__emitPortMessage({ type: 'agent_start', sessionId, runId });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 1,
            message: { role: 'user', content: 'Next run request', clientMessageId: 'next-run-user' },
            clientMessageId: 'next-run-user', deliveryStatus: 'accepted',
          });
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 2, spanId: 'llm-next-run',
            message: { role: 'assistant', content: '' },
          });
          window.__emitPortMessage({
            type: 'message_update', sessionId, runId, eventSeq: 3, spanId: 'llm-next-run',
            content: 'Next run is streaming now',
          });
        }
        """)
        page.wait_for_function("document.querySelector('[data-transcript-key*=\"llm-next-run\"]')?.dataset.transcriptLive === 'true'")

        page.evaluate("""
        () => {
          const sessionId = 'sess-switch-target';
          const runId = 'run-switch-live';
          window.__emitPortMessage({
            type: 'message_start', sessionId, runId, eventSeq: 99, spanId: 'llm-late-old-run',
            message: { role: 'assistant', content: '' },
          });
          window.__emitPortMessage({
            type: 'message_update', sessionId, runId, eventSeq: 100, spanId: 'llm-late-old-run',
            content: 'Late event from the previous run',
          });
        }
        """)
        page.wait_for_timeout(180)
        result["lateRunDom"] = transcript_dom(page)
        next_index = next((index for index, item in enumerate(result["lateRunDom"]) if "llm-next-run" in item["key"]), -1)
        late_index = next((index for index, item in enumerate(result["lateRunDom"]) if "llm-late-old-run" in item["key"]), -1)
        result["lateRunEventAccepted"] = next_index >= 0 and late_index > next_index

        page.evaluate("""
        () => {
          const makeRecord = (id, label) => ({
            type: 'qz-browser-agent-session',
            version: 4,
            conversation: { type: 'conversation', version: 1, entries: [] },
            transcript: [
              { type: 'user', text: `${label} request`, timestamp: '2026-07-11 13:00:00' },
              { type: 'assistant', content: `${label} answer`, timestamp: '2026-07-11 13:00:01' },
            ],
            savedAt: '2026-07-11 13:00:02',
          });
          for (const [id, title] of [
            ['sess-switch-a', 'Slow first click'],
            ['sess-switch-b', 'Fast last click'],
            ['sess-switch-double', 'Delayed double click'],
          ]) {
            window.__orderingStorage._sessions[id] = {
              id,
              title,
              parentSessionId: '0',
              createdAt: '2026-07-11 13:00:00',
              updatedAt: id.endsWith('b') ? '2026-07-11 13:01:00' : '2026-07-11 13:00:00',
            };
            window.__orderingStorage[`_session_${id}`] = makeRecord(id, title);
          }
          window.__orderingStorageDelays['_session_sess-switch-a'] = 520;
          window.__orderingStorageDelays['_session_sess-switch-b'] = 45;
          window.__orderingStorageDelays['_session_sess-switch-double'] = 320;
          window.__emitPortMessage({ type: 'sessions_changed' });
        }
        """)
        page.click('[data-tab="sessions"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-switch-double"]')
        page.evaluate("""
        () => {
          document.querySelector('[role="treeitem"][data-id="sess-switch-double"]')?.click();
          setTimeout(() => document.querySelector('[role="treeitem"][data-id="sess-switch-double"]')?.click(), 20);
        }
        """)
        page.wait_for_timeout(480)
        result["sameSessionDoubleClick"] = page.evaluate(r"""
        () => ({
          title: document.querySelector('#current-session-title')?.textContent || '',
          assistantTexts: Array.from(document.querySelectorAll('.msg-assistant')).map(el => (el.textContent || '').trim()),
        })
        """)
        result["sameSessionDoubleClickTrace"] = page.evaluate("""
        () => (window.__qingzhouPerf || [])
          .filter(entry => entry.name.startsWith('session.switch') && entry.meta?.sessionId === 'sess-switch-double')
          .map(entry => ({ name: entry.name, meta: entry.meta || {}, ms: entry.ms || 0 }))
        """)

        page.click('[data-tab="sessions"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-switch-a"]')
        page.wait_for_selector('[role="treeitem"][data-id="sess-switch-b"]')
        page.evaluate("""
        () => {
          document.querySelector('[role="treeitem"][data-id="sess-switch-a"]')?.click();
          setTimeout(() => document.querySelector('[role="treeitem"][data-id="sess-switch-b"]')?.click(), 20);
        }
        """)
        page.wait_for_timeout(750)
        result["rapidSwitchFinal"] = page.evaluate(r"""
        () => ({
          title: document.querySelector('#current-session-title')?.textContent || '',
          text: (document.querySelector('#messages')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        })
        """)
        result["rapidSessionSwitchReproduced"] = result["rapidSwitchFinal"]["title"] == "Slow first click"

        page.evaluate("""
        () => {
          const sessionId = 'sess-switch-b';
          window.__emitPortMessage({ type: 'transcript_replace', sessionId, transcript: [] });
          window.__emitStorageChange({
            [`_active_conversation_${sessionId}`]: {
              newValue: {
                type: 'conversation', version: 1,
                entries: [{
                  type: 'message', id: 'stale-user', parentId: null,
                  timestamp: '2026-07-11 14:10:00',
                  message: { role: 'user', content: 'Stale storage must not reseed' },
                }],
              },
            },
          });
        }
        """)
        page.wait_for_timeout(120)
        result["authoritativeEmptyDom"] = transcript_dom(page)
        browser.close()

    summary = {
        "waitDomResidue": result["bugReproduced"],
        "playbackOverlap": result["playbackOverlapReproduced"],
        "interruptedReplay": result["interruptedReplayReproduced"],
        "interruptedBeforeState": result["interruptedBeforeState"],
        "interruptedAfterState": result["interruptedAfterState"],
        "interruptedAfterReturn": result["interruptedAfterReturn"],
        "runningSessionSnapshotDrop": result["sessionSwitchSnapshotReproduced"],
        "lateRunEventAccepted": result["lateRunEventAccepted"],
        "rapidSessionSwitchRace": result["rapidSessionSwitchReproduced"],
        "waitDuringKeys": [item["key"] for item in result["during"]],
        "playbackStates": result["playbackStates"],
        "switchLiveBefore": any("llm-switch-live" in item["key"] for item in result["switchBeforeSnapshot"]),
        "switchLiveAfter": any("llm-switch-live" in item["key"] for item in result["switchAfterSnapshot"]),
        "rapidSwitchFinalTitle": result["rapidSwitchFinal"].get("title", ""),
        "sameSessionDoubleClickLoaded": (
            result["sameSessionDoubleClick"].get("title") == "Delayed double click"
            and "Delayed double click answer" in result["sameSessionDoubleClick"].get("assistantTexts", [])
        ),
        "authoritativeEmptyStayedEmpty": len(result["authoritativeEmptyDom"]) == 0,
        "pageErrors": result["pageErrors"],
        "consoleErrors": result["consoleErrors"],
    }
    print(json.dumps(result if verbose else summary, ensure_ascii=False, indent=2))
    if result["pageErrors"] or result["consoleErrors"]:
        raise SystemExit(2)
    if (
        result["bugReproduced"]
        or result["playbackOverlapReproduced"]
        or result["interruptedReplayReproduced"]
        or result["sessionSwitchSnapshotReproduced"]
        or result["lateRunEventAccepted"]
        or result["rapidSessionSwitchReproduced"]
        or not summary["switchLiveBefore"]
        or not summary["switchLiveAfter"]
        or summary["rapidSwitchFinalTitle"] != "Fast last click"
        or not summary["sameSessionDoubleClickLoaded"]
        or not summary["authoritativeEmptyStayedEmpty"]
        or result["interruptedAfterState"].get("live") != "false"
        or result["interruptedAfterState"].get("finalChars") != result["interruptedAfterState"].get("targetChars")
        or result["interruptedAfterReturn"].get("live") != "false"
        or result["interruptedAfterReturn"].get("visibleChars") != result["interruptedAfterReturn"].get("targetChars")
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verbose", action="store_true")
    run(verbose=parser.parse_args().verbose)
