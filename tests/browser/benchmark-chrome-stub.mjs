export function installBenchmarkChromeStub(options = {}) {
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  // addInitScript serializes this function; mirror the two generated Chrome message shapes here.
  const nativeText = value => {
    if (typeof value?.message !== "string") return "";
    if (value.message !== "$QZ_LITERAL$") return value.placeholders === undefined ? value.message : "";
    const content = value.placeholders?.qz_literal?.content;
    return typeof content === "string" ? content.replace(/\${2,}/g, dollars => dollars.slice(1)) : "";
  };
  // Ordinary workspace fixtures represent a user who has completed first-use consent.
  const storage = clone({ qz_data_consent: { version: 1, acceptedAt: 1 }, ...options.localStorage });
  if (options.dataConsent === false) storage.qz_data_consent = JSON.parse(localStorage.getItem("__qz_test_consent") || "null");
  const storageListeners = new Set();
  let consentSaveFailures = Number(options.consentSaveFailures || 0);
  const sessionStoragePrefix = "__qz_test_chrome_session__:";
  const localGetDelayMs = Math.max(0, Number(options.localGetDelayMs) || 0);
  const sessionGetDelayMs = Math.max(0, Number(options.sessionGetDelayMs) || 0);
  const stateResponseDelayMs = Math.max(0, Number(options.stateResponseDelayMs) || 0);
  let sessionSetFailuresRemaining = Math.max(0, Number(options.sessionSetFailures) || 0);
  const portMessageListeners = new Set();
  const portDisconnectListeners = new Set();
  const sidePanelOpenedListeners = new Set();
  const submittedFollowUpsBySession = new Map();
  window.__qzPostedMessages = [];
  window.__qzCreatedTabs = [];
  window.__qzCommands = clone(options.commands || [
    { name: "_execute_action", shortcut: "Ctrl+Shift+K" },
    { name: "open-model-preset-switcher", shortcut: "Ctrl+Shift+M" },
  ]);
  window.__qzCommandsGetAllCount = 0;
  window.__qzSessionSetAttempts = 0;
  window.__qzEmitPortMessage = message => {
    for (const listener of portMessageListeners) listener(clone(message));
  };
  window.__qzEmitSidePanelOpened = info => {
    for (const listener of sidePanelOpenedListeners) listener(clone(info));
  };
  window.__QZ_CONVERSATION_BENCHMARK__ = options.benchmark !== false;
  for (const [key, value] of Object.entries(options.sessionStorage || {})) {
    const storageKey = `${sessionStoragePrefix}${key}`;
    if (localStorage.getItem(storageKey) === null) localStorage.setItem(storageKey, JSON.stringify(value));
  }
  window.chrome = {
    i18n: {
      getUILanguage: () => options.uiLanguage || navigator.language,
      getMessage: key => nativeText(options.localeMessages?.[key]),
    },
    runtime: {
      async sendMessage(message) {
        if (message.type !== "accept_data_consent") throw new Error("Unexpected runtime message");
        if (consentSaveFailures-- > 0) return { ok: false };
        const value = { version: message.version, acceptedAt: Date.now() };
        storage.qz_data_consent = value;
        localStorage.setItem("__qz_test_consent", JSON.stringify(value));
        for (const listener of storageListeners) listener({ qz_data_consent: { newValue: value } }, "local");
        return { ok: true, accepted: true };
      },
      connect() {
        return {
          postMessage(message) {
            window.__qzPostedMessages.push(clone(message));
            if (message?.type === "sidepanel_attach" && message.requestId) {
              queueMicrotask(() => {
                for (const event of options.attachMessages || []) window.__qzEmitPortMessage(event);
                window.__qzEmitPortMessage({
                  type: "sidepanel_attached",
                  requestId: message.requestId,
                  windowId: message.windowId,
                });
              });
            }
            if (message?.type === "get_skill_workspace" && message.requestId) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "skill_workspace", requestId: message.requestId,
                skills: Object.values(storage._skills || {}), installStates: {},
              }));
            }
            if (message?.type === "get_config") {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "config",
                ...(message.requestId ? { requestId: message.requestId } : {}),
                config: {
                  provider: "custom",
                  model: "test-model",
                  debugMode: false,
                  providers: window.__qzProviderMenus?.[document.documentElement.lang] || window.__qzProviderMenus?.en,
                  ...(options.config || {}),
                },
              }));
            }
            if (message?.type === "match_model_capabilities" && message.requestId) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "model_capabilities", requestId: message.requestId,
                match: options.modelCapabilityMatch || { matched: false },
              }));
            }
            if (message?.type === "list_models" && message.requestId && options.listModelsError) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "error",
                requestId: message.requestId,
                code: "MODEL_LIST_UNAVAILABLE",
                message: String(options.listModelsError),
              }));
            }
            if (message?.type === "list_sessions" && message.requestId) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "list_sessions_result",
                requestId: message.requestId,
                sessions: [],
              }));
            }
            if (message?.type === "get_state" && (message.requestId || options.respondToStateWithoutRequestId)) {
              const respond = () => window.__qzEmitPortMessage({
                type: "state",
                ...(message.requestId ? { requestId: message.requestId } : {}),
                sessionId: message.sessionId,
                status: "idle",
                runtime: { sessionId: message.sessionId, status: "idle", running: false },
                ...clone(options.stateResponse || {}),
              });
              if (stateResponseDelayMs) setTimeout(respond, stateResponseDelayMs);
              else queueMicrotask(respond);
            }
            if (message?.type === "get_composer_draft" && message.requestId) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "get_composer_draft_result",
                requestId: message.requestId,
                sessionId: message.sessionId,
                draft: null,
              }));
            }
            if (message?.type === "prompt" && message.requestId) {
              const acceptance = window.__qzPromptAcceptance && typeof window.__qzPromptAcceptance === "object"
                ? clone(window.__qzPromptAcceptance)
                : {};
              if (acceptance.disposition === "queued") {
                const pendingFollowUps = submittedFollowUpsBySession.get(message.sessionId) || [];
                if (!pendingFollowUps.some(item => item.clientMessageId === message.clientMessageId)) {
                  pendingFollowUps.push({
                    clientMessageId: message.clientMessageId,
                    text: message.text || "",
                    imageCount: Array.isArray(message.images) ? message.images.length : 0,
                    attachmentCount: Array.isArray(message.documents) ? message.documents.length : 0,
                    index: pendingFollowUps.length,
                  });
                }
                submittedFollowUpsBySession.set(message.sessionId, pendingFollowUps);
                queueMicrotask(() => window.__qzEmitPortMessage({
                  type: "queue_update",
                  sessionId: message.sessionId,
                  pendingSteerings: [],
                  pendingFollowUps: clone(pendingFollowUps),
                }));
              }
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "prompt_accepted",
                requestId: message.requestId,
                accepted: true,
                sessionId: message.sessionId,
                clientMessageId: message.clientMessageId,
                ...acceptance,
              }));
            }
            if (message?.type === "list_plugin_contributions" && message.requestId) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "plugin_contributions",
                requestId: message.requestId,
                contributions: {},
              }));
            }
            if (message?.type === "steer_follow_up" && message.requestId) {
              queueMicrotask(() => window.__qzEmitPortMessage({
                type: "follow_up_steered",
                requestId: message.requestId,
                sessionId: message.sessionId,
                moved: true,
              }));
            }
            if (message?.type === "rename_session" && message.requestId) {
              if (window.__qzRenameSessionFailure === true) {
                queueMicrotask(() => window.__qzEmitPortMessage({
                  type: "error",
                  requestId: message.requestId,
                  code: "RENAME_FAILED",
                  message: "模拟保存失败",
                }));
                return;
              }
              const sessionId = String(message.sessionId || "").trim();
              const sessions = storage._sessions || {};
              const session = {
                ...(sessions[sessionId] || {}),
                id: sessionId,
                title: String(message.title || "").trim(),
                titleSource: "manual",
              };
              storage._sessions = { ...sessions, [sessionId]: session };
              queueMicrotask(() => {
                window.__qzEmitPortMessage({
                  type: "rename_session_result",
                  requestId: message.requestId,
                  renamed: true,
                  sessionId,
                  session,
                });
                window.__qzEmitPortMessage({
                  type: "sessions_changed",
                  action: "title",
                  sessionId,
                  session,
                });
              });
            }
            if (message?.type === "compact_context" && message.requestId) {
              if (window.__qzCompactFailure && typeof window.__qzCompactFailure === "object") {
                const failure = window.__qzCompactFailure;
                queueMicrotask(() => window.__qzEmitPortMessage({
                  type: "error",
                  requestId: message.requestId,
                  code: String(failure.code || "CONTEXT_COMPACTION_FAILED"),
                  message: String(failure.message || "模拟压缩失败"),
                }));
                return;
              }
              const lifecycle = window.__qzCompactLifecycle;
              if (lifecycle && typeof lifecycle === "object") {
                const compactId = String(lifecycle.compactId || "compact-manual");
                queueMicrotask(() => window.__qzEmitPortMessage({
                  type: "context_compaction_start",
                  sessionId: message.sessionId,
                  compactId,
                  eventSeq: Number(lifecycle.startEventSeq || 1),
                  inputTokensBefore: 4200,
                  contextWindow: 1_000_000,
                  sourceMessageCount: 6,
                  retainedMessageCount: 2,
                  trigger: "slash_command",
                }));
                setTimeout(() => {
                  window.__qzEmitPortMessage({
                    type: "context_compaction_end",
                    sessionId: message.sessionId,
                    compactId,
                    eventSeq: Number(lifecycle.endEventSeq || 2),
                    status: "done",
                    summary: String(lifecycle.summary || "手动压缩已经完成。"),
                    inputTokensBefore: 4200,
                    inputTokensAfter: 1200,
                    contextWindow: 1_000_000,
                    sourceMessageCount: 6,
                    retainedMessageCount: 2,
                    trigger: "slash_command",
                  });
                  window.__qzEmitPortMessage({
                    type: "state",
                    sessionId: message.sessionId,
                    status: "completed",
                    isStreaming: false,
                    runtime: {
                      sessionId: message.sessionId,
                      status: "completed",
                      running: false,
                      pendingStart: false,
                      runId: null,
                    },
                  });
                  window.__qzEmitPortMessage({
                    type: "compact_context_result",
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    compacted: true,
                    instructionApplied: Boolean(message.instruction),
                    inputTokensBefore: 4200,
                    inputTokensAfter: 1200,
                  });
                }, Math.max(0, Number(lifecycle.delayMs) || 0));
              } else {
                const result = window.__qzCompactResult && typeof window.__qzCompactResult === "object"
                  ? window.__qzCompactResult
                  : {};
                queueMicrotask(() => window.__qzEmitPortMessage({
                  type: "compact_context_result",
                  requestId: message.requestId,
                  sessionId: message.sessionId,
                  compacted: true,
                  instructionApplied: Boolean(message.instruction),
                  inputTokensBefore: 4200,
                  inputTokensAfter: 1200,
                  ...result,
                }));
              }
            }
          },
          disconnect() {
            for (const listener of portDisconnectListeners) listener();
          },
          onDisconnect: {
            addListener(listener) { portDisconnectListeners.add(listener); },
            removeListener(listener) { portDisconnectListeners.delete(listener); },
          },
          onMessage: {
            addListener(listener) { portMessageListeners.add(listener); },
            removeListener(listener) { portMessageListeners.delete(listener); },
          },
        };
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (localGetDelayMs) await new Promise(resolve => setTimeout(resolve, localGetDelayMs));
          if (keys == null) return clone(storage);
          if (typeof keys === "string") return { [keys]: clone(storage[keys]) };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
          return Object.fromEntries(Object.entries(keys || {}).map(([key, fallback]) => [
            key,
            storage[key] === undefined ? clone(fallback) : clone(storage[key]),
          ]));
        },
        async set(values = {}) { Object.assign(storage, clone(values)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; },
        async clear() { for (const key of Object.keys(storage)) delete storage[key]; },
      },
      session: {
        async get(keys) {
          if (sessionGetDelayMs) await new Promise(resolve => setTimeout(resolve, sessionGetDelayMs));
          const read = key => {
            const value = localStorage.getItem(`${sessionStoragePrefix}${key}`);
            return value === null ? undefined : JSON.parse(value);
          };
          if (keys == null) {
            const result = {};
            for (let index = 0; index < localStorage.length; index += 1) {
              const key = localStorage.key(index);
              if (!key?.startsWith(sessionStoragePrefix)) continue;
              result[key.slice(sessionStoragePrefix.length)] = JSON.parse(localStorage.getItem(key));
            }
            return result;
          }
          if (typeof keys === "string") return { [keys]: read(keys) };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, read(key)]));
          return Object.fromEntries(Object.entries(keys || {}).map(([key, fallback]) => [
            key,
            read(key) === undefined ? clone(fallback) : read(key),
          ]));
        },
        async set(values = {}) {
          window.__qzSessionSetAttempts += 1;
          if (sessionSetFailuresRemaining > 0) {
            sessionSetFailuresRemaining -= 1;
            throw new Error("forced session storage write failure");
          }
          for (const [key, value] of Object.entries(values)) {
            localStorage.setItem(`${sessionStoragePrefix}${key}`, JSON.stringify(clone(value)));
          }
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            localStorage.removeItem(`${sessionStoragePrefix}${key}`);
          }
        },
      },
      onChanged: {
        addListener(listener) { storageListeners.add(listener); },
        removeListener(listener) { storageListeners.delete(listener); },
      },
    },
    commands: {
      async getAll() {
        window.__qzCommandsGetAllCount += 1;
        return clone(window.__qzCommands);
      },
    },
    downloads: { async download() { return 1; }, async search() { return []; }, open() {}, show() {} },
    tabs: {
      async create(input = {}) {
        window.__qzCreatedTabs.push(clone(input));
        return { id: 1, ...clone(input) };
      },
      async query() { return []; },
    },
    windows: { async getCurrent() { return { id: Number(options.windowId) || 1 }; } },
    sidePanel: {
      onOpened: {
        addListener(listener) { sidePanelOpenedListeners.add(listener); },
        removeListener(listener) { sidePanelOpenedListeners.delete(listener); },
      },
    },
    desktopCapture: { chooseDesktopMedia() { return null; } },
  };
}
