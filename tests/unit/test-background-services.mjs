import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serializeConversation } from "../../src/shared/session/session-codec.js";
import { createSessionExchangePayload } from "../../src/shared/session/session-exchange.js";
import { createConfigRuntime } from "../../src/background/services/config-runtime.js";
import { createLlmGateway, createProviderRegistry } from "../../src/background/llm/index.js";
import { deterministicProvider } from "../fixtures/capabilities/example/deterministic-provider.js";
import {
  createChromeNotificationService,
  createSessionCompletionNotifier,
} from "../../src/background/services/chrome-notifications.js";
import { createOffscreenKeepalive } from "../../src/background/services/offscreen-keepalive.js";
import { createPlatformCommands } from "../../src/background/services/platform-commands.js";
import { createBackgroundApi } from "../../src/background/background-api.js";
import {
  createSessionExchangeBridge,
  isAllowedSessionExportSource,
} from "../../src/background/services/session-exchange-bridge.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";
import { createSidepanelChannel } from "../../src/background/transports/sidepanel-channel.js";
import { createSidepanelEventRouter } from "../../src/sidepanel/features/app/sidepanel-event-router.js";

await configRuntimeKeepsPersistedAndLiveStateInLockstep();
await configRuntimePreservesCancellationThroughModelValidationAndGuardrails();
await chromeNotificationAdaptersHandlePermissionAndCallbackErrors();
await completionNotifierHandlesRootsSuppressionDeduplicationAndClicks();
await notificationRevealEventsSelectTheRelatedSession();
await llmRetryStatusUsesExistingTransportFacts();
await offscreenKeepaliveIsSingleFlightAndRetryable();
await sessionExchangeBridgeEnforcesSourceBoundariesAndDeliverySemantics();
await sessionExchangeRevealOpensThePanelWithoutImporting();
await platformCommandsRequireExplicitTabs();
await sidepanelChannelOwnsPortsPendingDeliveryAndDynamicContext();

console.log("background service boundary tests passed");

async function configRuntimeKeepsPersistedAndLiveStateInLockstep() {
  let live = null;
  let clears = 0;
  let savedGuardrails = null;
  const gateway = createLlmGateway({ rateGovernor: null, protocolRegistry: createProviderRegistry({ native: deterministicProvider }) });
  const customProtocols = [{ id: "native", label: "native" }];
  const runtime = createConfigRuntime({
    listCustomProtocols: gateway.listCustomProtocols,
    getConfig: async () => ({ provider: "deepseek", model: "m1" }),
    saveConfig: async config => ({ provider: config.provider || "deepseek", model: config.model || "m1" }),
    saveModelPreset: async preset => ({ provider: preset.provider, model: preset.model, preset: "saved" }),
    applyModelPreset: async presetId => ({ provider: "deepseek", model: presetId, preset: "applied" }),
    deleteModelPreset: async presetId => ({ provider: "deepseek", model: "fallback", deletedPresetId: presetId }),
    clearProviderAuth: async provider => { assert.equal(provider, "example-local"); return { authenticated: false }; },
    getSecurityGuardrails: async () => ({ rules: [{ id: "stored" }] }),
    saveSecurityGuardrails: async guardrails => {
      savedGuardrails = guardrails;
      return { ...guardrails, normalized: true };
    },
    getCurrentRuntimeConfig: () => live,
    setCurrentRuntimeConfig: config => { live = structuredClone(config); },
    clearContextUsage: async () => { clears += 1; },
  });

  assert.deepEqual(await runtime.get(), {
    provider: "deepseek",
    model: "m1",
    securityGuardrails: { rules: [{ id: "stored" }] },
    customProtocols,
  });
  assert.deepEqual(runtime.getRuntime(), live);

  const saved = await runtime.save({ provider: "deepseek", model: "m2", securityGuardrails: { rules: [{ id: "new" }] } });
  assert.deepEqual(saved.securityGuardrails, { rules: [{ id: "new" }], normalized: true });
  assert.deepEqual(saved.customProtocols, customProtocols);
  assert.deepEqual(savedGuardrails, { rules: [{ id: "new" }] });
  assert.equal(clears, 1);

  assert.equal((await runtime.savePreset({ provider: "deepseek", model: "m3" })).preset, "saved");
  assert.equal((await runtime.applyPreset("m4")).preset, "applied");
  assert.deepEqual(live.customProtocols, customProtocols);
  assert.equal((await runtime.deletePreset("old")).deletedPresetId, "old");
  assert.equal(clears, 3, "save/apply preset invalidate context usage; deleting an inactive preset does not");
  const logout = await runtime.logoutProvider("example-local");
  assert.equal(logout.authStatus.authenticated, false);
  assert.equal(clears, 4);
  const refreshed = await runtime.refresh();
  assert.equal(refreshed.provider, "deepseek");
  assert.deepEqual(refreshed.customProtocols, customProtocols);
  assert.equal(clears, 5);
}

async function configRuntimePreservesCancellationThroughModelValidationAndGuardrails() {
  for (const stage of ["validation", "committed", "preset"]) {
    const controller = new AbortController(), entered = deferred(), resume = deferred();
    const reason = new Error(`cancelled during ${stage}`);
    let persisted = { model: "original" }, live = persisted, guardrailWrites = 0;
    const guardedSave = async (next, signal) => {
      assert.equal(signal, controller.signal);
      if (stage === "committed") persisted = next;
      entered.resolve(); await resume.promise;
      if (stage !== "committed") { signal.throwIfAborted(); persisted = next; }
      return { ...persisted };
    };
    const runtime = createConfigRuntime({
      getConfig: async () => persisted,
      saveConfig: guardedSave,
      saveModelPreset: async () => persisted,
      applyModelPreset: (id, signal) => guardedSave({ model: id }, signal),
      deleteModelPreset: async () => persisted,
      clearProviderAuth: async () => {},
      getSecurityGuardrails: async () => ({ rules: [] }),
      saveSecurityGuardrails: async () => { guardrailWrites++; return { rules: [] }; },
      getCurrentRuntimeConfig: async () => live,
      setCurrentRuntimeConfig: config => { live = config; },
    });
    const pending = stage === "preset" ? runtime.applyPreset("new", controller.signal)
      : runtime.save({ model: "new", securityGuardrails: { rules: [{ id: "late" }] } }, controller.signal);
    const rejected = assert.rejects(pending, error => error === reason);
    await entered.promise; controller.abort(reason); resume.resolve(); await rejected;
    assert.equal(guardrailWrites, 0, "a cancelled second write cannot alter security settings");
    assert.equal(persisted.model, stage === "committed" ? "new" : "original");
    assert.equal(live.model, persisted.model, "an admitted model write still updates its live snapshot");
    if (stage === "committed") assert.deepEqual(live.securityGuardrails, { rules: [] });
  }
}

async function chromeNotificationAdaptersHandlePermissionAndCallbackErrors() {
  const created = [];
  const cleared = [];
  const runtime = { lastError: null };
  let permission = "granted";
  let focusChanged = null;
  let windowRemoved = null;
  const service = createChromeNotificationService({
    notifications: {
      getPermissionLevel: callback => callback(permission),
      create: (id, options, callback) => {
        created.push({ id, options });
        callback(`${id}-created`);
      },
      clear: (id, callback) => {
        cleared.push(id);
        callback(true);
      },
    },
    runtime,
    windows: {
      getAll: async () => [{ id: 4, type: "normal", focused: false }, { id: 7, type: "normal", focused: true }],
      get: async id => ({ id, type: id === 10 ? "popup" : "normal" }),
      getLastFocused: async () => ({ id: 7, type: "normal", focused: true }),
      onFocusChanged: { addListener: listener => { focusChanged = listener; } },
      onRemoved: { addListener: listener => { windowRemoved = listener; } },
    },
  });
  assert.equal(await service.create("n1", { title: "title" }), "n1-created");
  assert.deepEqual(created.map(item => item.id), ["n1"]);
  assert.equal(await service.clear("n1-created"), true);
  assert.deepEqual(cleared, ["n1-created"]);
  assert.equal(await service.isChromeVisuallyFocused(), true);
  assert.equal(service.getLastKnownWindowId(), 7);
  focusChanged?.(9);
  await Promise.resolve();
  assert.equal(service.getLastKnownWindowId(), 9, "window cache should track a focused normal window before notification clicks");
  focusChanged?.(10);
  await Promise.resolve();
  assert.equal(service.getLastKnownWindowId(), 9, "popup focus must not replace the normal notification target");
  windowRemoved?.(9);
  assert.equal(service.getLastKnownWindowId(), null);

  permission = "denied";
  await assert.rejects(() => service.create("n2", {}), /permission is denied/);
  permission = "granted";
  runtime.lastError = { message: "callback failed" };
  await assert.rejects(() => service.create("n3", {}), /callback failed/);
}

async function completionNotifierHandlesRootsSuppressionDeduplicationAndClicks() {
  const created = [];
  const cleared = [];
  const activated = [];
  const opened = [];
  const patches = [];
  const runtimes = new Map([
    ["root", { status: "completed", running: false, runId: "run-1" }],
    ["alert", { status: "completed", running: false, runId: "run-2" }],
    ["child", { status: "completed", running: false, runId: "run-3" }],
    ["automation", { status: "completed", running: false, runId: "run-4" }],
  ]);
  const checkpoints = new Map();
  const sessions = {
    root: { id: "root", title: "Root", parentSessionId: "0" },
    alert: { id: "alert", title: "Alert", parentSessionId: "0" },
    child: { id: "child", title: "Child", parentSessionId: "root-parent" },
    automation: { id: "automation", title: "Automation", source: "automation" },
  };
  let focused = false;
  let revealAllowed = true;
  const notifier = createSessionCompletionNotifier({
    notifications: {
      isChromeVisuallyFocused: async () => focused,
      create: async (id, options) => {
        created.push({ id, options });
        return id;
      },
      clear: async id => {
        cleared.push(id);
        return true;
      },
    },
    iconUrl: "icon.png",
    normalizeSessionId: value => String(value || "").trim(),
    getRuntime: id => runtimes.get(id) || {},
    getRuntimeCheckpoint: id => checkpoints.get(id) || {},
    getSessions: async () => sessions,
    getTranscript: async id => id === "alert" ? [{ type: "tool", name: "send_alert" }] : [],
    getLastToolName: transcript => transcript.at(-1)?.name || "",
    setRuntime: (id, patch) => {
      patches.push({ id, patch });
      checkpoints.set(id, { ...(checkpoints.get(id) || {}), ...patch });
    },
    activateWorkingTab: async (id, options) => {
      activated.push({ id, options });
      return { activated: false, reason: "no_working_tab" };
    },
    openSession: async (id, input) => {
      opened.push({ id, input });
      return revealAllowed;
    },
    getAutomationRuntime: () => ({
      consumeNotificationSession: id => id === "automation-notice" ? "automation" : "",
    }),
    now: () => "2026-07-12 12:00:00",
  });

  assert.equal(await notifier.notifyCompleted("root"), true);
  assert.equal(await notifier.notifyCompleted("root"), false, "the same run may notify only once");
  assert.equal(await notifier.notifyCompleted("alert"), false);
  assert.equal(patches.find(item => item.id === "alert")?.patch.completionNotificationSuppressedReason, "last_send_alert");
  assert.equal(await notifier.notifyCompleted("child"), false);
  assert.equal(await notifier.notifyCompleted("automation"), false);
  focused = true;
  runtimes.set("focused", { status: "completed", running: false, runId: "run-5" });
  sessions.focused = { id: "focused", parentSessionId: "0" };
  assert.equal(await notifier.notifyCompleted("focused"), false);
  assert.equal(created.length, 1);

  const automationClick = notifier.handleClick("automation-notice");
  assert.equal(opened[0].id, "automation", "panel reveal must start synchronously in the notification user gesture");
  assert.equal(await automationClick, true);
  assert.equal(await notifier.handleClick(created[0].id), true);
  assert.deepEqual(cleared, ["automation-notice", created[0].id]);
  assert.deepEqual(activated, [
    { id: "automation", options: { focusWindow: true } },
    { id: "root", options: { focusWindow: true } },
  ]);
  assert.equal(opened[1].id, "root");

  assert.equal(await notifier.handleClick("qz_alert_session_root_123_notice"), true);
  assert.equal(await notifier.handleClick("qz_auto_root_run-2"), true, "automation IDs should survive a worker restart without the in-memory map");
  assert.equal(await notifier.handleClick("qz_completed_root_run-6"), true, "completion IDs should restore their Session without the in-memory map");
  assert.deepEqual(cleared, [
    "automation-notice",
    created[0].id,
    "qz_alert_session_root_123_notice",
    "qz_auto_root_run-2",
    "qz_completed_root_run-6",
  ]);

  revealAllowed = false;
  assert.equal(await notifier.handleClick("qz_alert_session_missing_124_notice"), false);
  assert.equal(cleared.includes("qz_alert_session_missing_124_notice"), false, "an unaddressed notification must stay visible");
  assert.equal(await notifier.handleClick("qz_alert_1234_legacy"), false, "legacy alerts without a Session destination stay inert");
  assert.equal(await notifier.handleClick("unknown"), false);
}

async function notificationRevealEventsSelectTheRelatedSession() {
  assert.throws(
    () => createSidepanelEventRouter({}),
    /requires switchToSession/,
    "the production composition must wire Session navigation into notification reveal handling",
  );
  const switches = [];
  const router = createSidepanelEventRouter({
    switchToSession: async (sessionId, options) => switches.push({ sessionId, options }),
  });
  router.handle({ type: "session_reveal_requested", sessionId: "session42" });
  assert.deepEqual(switches, [{ sessionId: "session42", options: { source: "notification" } }]);
}

async function llmRetryStatusUsesExistingTransportFacts() {
  const statuses = [];
  const router = createSidepanelEventRouter({
    switchToSession() {},
    runController: {
      makeLive() {},
      showStatus: status => statuses.push(status),
    },
  });
  router.handle({ type: "llm_retry", maxRetries: 5, delayMs: 15_250 });
  router.handle({ type: "llm_retry", reason: "context_overflow" });
  assert.deepEqual(statuses, ["模型请求未完成，16 秒后重试…", "重试中..."]);
}

async function offscreenKeepaliveIsSingleFlightAndRetryable() {
  const gate = deferred();
  let creates = 0;
  const keepalive = createOffscreenKeepalive({
    offscreen: {
      Reason: { BLOBS: "BLOBS" },
      hasDocument: async () => false,
      async createDocument() {
        creates += 1;
        await gate.promise;
      },
    },
    runtime: { getURL: path => `chrome-extension://id/${path}` },
    clients: { matchAll: async () => [] },
  });
  const first = keepalive.ensure();
  const second = keepalive.ensure();
  await tick();
  assert.equal(creates, 1);
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);

  let attempts = 0;
  const retryable = createOffscreenKeepalive({
    offscreen: {
      hasDocument: async () => false,
      async createDocument() {
        attempts += 1;
        if (attempts === 1) throw new Error("first failed");
      },
    },
    runtime: { getURL: path => path },
    clients: { matchAll: async () => [] },
  });
  await assert.rejects(() => retryable.ensure(), /first failed/);
  assert.equal(await retryable.ensure(), true);
  assert.equal(attempts, 2);

  const existingClient = createOffscreenKeepalive({
    offscreen: { createDocument: async () => { throw new Error("must not create"); } },
    runtime: { getURL: path => `chrome-extension://id/${path}` },
    clients: { matchAll: async () => [{ url: "chrome-extension://id/offscreen.html" }] },
  });
  assert.equal(await existingClient.ensure(), true);
}

async function sessionExchangeBridgeEnforcesSourceBoundariesAndDeliverySemantics() {
  for (const url of [
    "file:///tmp/export.html",
    "http://localhost:8080/export",
    "https://alibaba.github.io/qz-browser-agent/",
  ]) assert.equal(isAllowedSessionExportSource(url), true, url);
  for (const url of [
    "chrome-extension://id/export",
    "https://example.invalid/export",
    "https://alibaba.github.io/other-repo/",
    "http://alibaba.github.io/qz-browser-agent/",
    "bad url",
  ]) assert.equal(isAllowedSessionExportSource(url), false, url);

  const broadcasts = [];
  const remembered = [];
  const opened = [];
  let hasPorts = false;
  const bridge = createSessionExchangeBridge({
    sidePanel: { open: async input => opened.push(input) },
    importSessionExchange: async payload => ({
      session: { id: "imported", title: payload.session.title },
      ownedTabsRestore: { restored: true, restoredCount: 2, failedCount: 1 },
    }),
    channel: {
      hasPorts: () => hasPorts,
      broadcast: event => broadcasts.push(event),
      remember: (key, event) => remembered.push({ key, event }),
      clearPending() {},
    },
    logger: { debug() {} },
  });

  await assert.rejects(
    () => bridge.importFromPage({ payload: {} }, { tab: { url: "https://evil.test/", id: 1 } }),
    error => error?.code === "SESSION_EXPORT_SOURCE_NOT_ALLOWED",
  );
  const payload = validSessionExchangePayload("Imported");
  const imported = await bridge.importFromPage({ payload }, {
    tab: { url: "http://localhost:8080/export", id: 9, windowId: 7 },
  });
  assert.equal(imported.session.id, "imported");
  assert.equal(remembered.at(-1)?.key, "session_export_import");
  assert.equal(remembered.at(-1)?.event?.ownedTabsRestore?.failedCount, 1);
  assert.deepEqual(opened.at(-1), { windowId: 7 });

  const focused = [];
  const windowed = [];
  const focusedBridge = createSessionExchangeBridge({
    sidePanel: { open: async input => focused.push(input) },
    importSessionExchange: async () => ({ session: { id: "existing", title: "杭州三日游" }, ownedTabsRestore: null }),
    channel: {
      hasPorts: () => true,
      broadcast() { throw new Error("window delivery should not broadcast to every panel"); },
      remember: (...args) => windowed.push(args),
      sendToWindow: async () => false,
    },
    logger: { debug() {} },
  });
  await focusedBridge.importFromPage({ payload }, {
    tab: { url: "http://127.0.0.1/export.html", id: 4, windowId: 7 },
  });
  assert.deepEqual(focused, [{ windowId: 7 }]);
  assert.equal(windowed[0]?.[0], "session_export_import");
  assert.equal(windowed[0]?.[1]?.sessionId, "existing");
  assert.equal(windowed[0]?.[2], 15_000);
  assert.deepEqual(windowed[0]?.[3], { windowId: 7 });

  const rememberedBeforePages = remembered.length;
  await assert.rejects(
    () => bridge.importFromPage({ payload }, { tab: { url: "https://alibaba.github.io/other-repo/session.html", id: 12, windowId: 4 } }),
    error => error?.code === "SESSION_EXPORT_SOURCE_NOT_ALLOWED",
  );
  assert.equal(remembered.length, rememberedBeforePages);
  const pagesImported = await bridge.importFromPage({ payload }, {
    tab: { url: "https://alibaba.github.io/qz-browser-agent/examples/travel/", id: 11, windowId: 4 },
  });
  assert.equal(pagesImported.session.id, "imported");
  assert.deepEqual(opened.at(-1), { windowId: 4 });

  hasPorts = true;
  await bridge.importFromPage({ payload }, {
    tab: { url: "http://localhost:8080/export", id: 10, windowId: 8 },
  });
  assert.ok(broadcasts.some(event => event.type === "session_imported_from_export"));
  assert.equal(broadcasts.some(event => event.type === "skill_registry_update"), false);
}

async function sessionExchangeRevealOpensThePanelWithoutImporting() {
  const content = readFileSync(new URL("../../src/content/session-export-bridge.ts", import.meta.url), "utf8");
  const transportSource = readFileSync(new URL("../../src/background/transports/runtime-message.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("../../src/background/service-worker.ts", import.meta.url), "utf8");
  const bridgeSource = readFileSync(new URL("../../src/background/services/session-exchange-bridge.ts", import.meta.url), "utf8");
  const revealAt = content.indexOf("session_export_reveal_consent");
  const workingAt = content.indexOf('status: "working"');
  assert.ok(revealAt >= 0 && workingAt > revealAt, "consent check happens before the importing state");
  assert.match(content, /needsConsent !== false/u);
  assert.doesNotMatch(content, /Acceptance resolves this same click/u);
  assert.match(transportSource, /type === "session_export_reveal_consent"/u);
  assert.doesNotMatch(transportSource, /respondAsync\(\s*\(\) => call\("exchange\.revealForImport"/u);
  assert.doesNotMatch(transportSource, /object\(value\)/u);
  assert.match(workerSource, /"exchange\.revealForImport"/u);
  assert.doesNotMatch(workerSource, /whenConsented:/u);
  assert.doesNotMatch(workerSource, /importConsentPanelOpen/u);
  assert.doesNotMatch(bridgeSource, /whenConsented|continueAfterConsent|panelOpen/u);

  const opened = [];
  const imported = [];
  let accepted = false;
  const bridge = createSessionExchangeBridge({
    sidePanel: { open(input) { opened.push(input); return Promise.resolve(); } },
    importSessionExchange: async payload => {
      imported.push(payload);
      return { session: { id: "imported", title: payload.session.title } };
    },
    channel: { hasPorts: () => false, broadcast() {}, remember() {} },
    logger: { debug() {} },
    consentAccepted: () => accepted,
  });
  const sender = { tab: { id: 3, windowId: 9, url: "http://127.0.0.1/export.html" } };
  assert.deepEqual(bridge.revealForImport({}), { needsConsent: true });
  assert.deepEqual(opened, []);
  assert.deepEqual(bridge.revealForImport(sender), { needsConsent: true });
  assert.deepEqual(opened, [{ windowId: 9 }]);
  assert.equal(imported.length, 0);

  const denied = Object.assign(new Error("consent"), { code: "DATA_CONSENT_REQUIRED" });
  const api = createBackgroundApi({
    exchange: {
      revealForImport: bridge.revealForImport,
      importFromPage() { imported.push("api"); },
    },
  }, path => {
    if (path === "exchange.revealForImport") return;
    if (!accepted) throw denied;
  });
  const transport = createRuntimeMessageTransport(api);
  const first = dispatchSync(transport, { type: "session_export_reveal_consent" }, sender);
  assert.equal(first.returned, false);
  assert.deepEqual(first.response, { ok: true, needsConsent: true });
  assert.deepEqual(opened, [{ windowId: 9 }, { windowId: 9 }]);
  assert.equal(imported.length, 0);
  const blocked = await new Promise(resolve => {
    transport.listener({ type: "session_export_import_request" }, sender, resolve);
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "DATA_CONSENT_REQUIRED");
  assert.equal(imported.length, 0);

  accepted = true;
  assert.deepEqual(bridge.revealForImport(sender), { needsConsent: false });
  const second = dispatchSync(transport, { type: "session_export_reveal_consent" }, sender);
  assert.deepEqual(second.response, { ok: true, needsConsent: false });
  assert.deepEqual(opened, [{ windowId: 9 }, { windowId: 9 }, { windowId: 9 }, { windowId: 9 }], "an accepted import click still opens the side panel on the gesture");
  assert.equal(imported.length, 0);

  const failClosedOpened = [];
  const failClosed = createSessionExchangeBridge({
    sidePanel: { open() { failClosedOpened.push(true); return Promise.resolve(); } },
    importSessionExchange: async () => { throw new Error("must not import"); },
    channel: { hasPorts: () => false, broadcast() {}, remember() {} },
    logger: { debug() {} },
  });
  assert.deepEqual(failClosed.revealForImport(sender), { needsConsent: true });
  assert.deepEqual(failClosedOpened, [true]);
  assert.equal(typeof failClosed.revealForImport(sender).then, "undefined", "an unconsented click does not wait for later acceptance");
}

function dispatchSync(transport, message, sender) {
  let response;
  let sync = false;
  const returned = transport.listener(message, sender, value => {
    sync = true;
    response = value;
  });
  assert.equal(sync, true, message.type);
  return { returned, response };
}

async function platformCommandsRequireExplicitTabs() {
  const sent = [];
  const refreshes = [];
  const readinessReasons = [];
  let readinessFailure = null;
  const tabs = new Map([
    [1, { id: 1, url: "https://one.test/", active: false }],
    [2, { id: 2, url: "https://two.test/", active: true }],
    [3, { id: 3, url: "chrome://settings", active: true }],
  ]);
  const commands = createPlatformCommands({
    sessionSupervisor: { size: () => 3 },
    getBridgeConfig: async () => ({ enabled: true }),
    tabs: {
      get: async id => tabs.get(id),
      query: async () => { assert.fail("background element picker must not infer the active window"); },
    },
    sendToContent: async (tabId, action) => {
      sent.push({ tabId, action });
      return { selected: true };
    },
    ensureSkillToolRegistryReady(reason) {
      readinessReasons.push(reason);
      if (readinessFailure) throw readinessFailure;
      return Promise.resolve();
    },
    listSkillContributions: context => ({ context }),
    buildSkillUiContext: async sessionId => ({ sessionId }),
    commitSkillRegistryChange: async (reason, details) => {
      refreshes.push({ reason, details });
      return { reason };
    },
  });
  assert.equal((await commands.ping()).sessions, 3);
  assert.deepEqual(await commands.startElementPicker(1), { tabId: 1, selected: true });
  assert.deepEqual(await commands.confirmElementPicker(2), { tabId: 2, selected: true });
  assert.deepEqual(sent.map(item => item.action), ["startElementPicker", "confirmElementPicker"]);
  await assert.rejects(() => commands.cancelElementPicker(3), /不支持选择元素/);
  await assert.rejects(() => commands.cancelElementPicker(), /请选择要操作的页面/);
  assert.deepEqual(await commands.contributions("s1"), { context: { sessionId: "s1" } });
  assert.deepEqual(readinessReasons, ["platform_contributions"]);
  readinessFailure = new Error("optional registry unavailable");
  assert.deepEqual(
    await commands.contributions("s2"),
    { context: { sessionId: "s2" } },
    "contribution listing should degrade to the last committed registry when readiness fails",
  );
  await commands.refreshSkills({
    reason: "ui_skill_save",
    skillName: "renamed-skill",
    previousSkillName: "original-skill",
  });
  assert.deepEqual(refreshes, [{
    reason: "ui_skill_save",
    details: { skillName: "renamed-skill", previousSkillName: "original-skill" },
  }], "the registry boundary should receive explicit rename identity for settings migration");
}

async function sidepanelChannelOwnsPortsPendingDeliveryAndDynamicContext() {
  const connectListeners = new Set();
  const runtime = {
    onConnect: {
      addListener: listener => connectListeners.add(listener),
      removeListener: listener => connectListeners.delete(listener),
    },
  };
  const channel = createSidepanelChannel({
    normalizeSessionId: value => String(value || "").trim(),
    getRuntime: sessionId => ({ sessionId, status: "running", running: true }),
  });
  channel.remember("pending", { type: "session_imported_from_export", sessionId: "imported" }, 10_000);
  const port = fakePort("sidepanel");
  const unregister = channel.register(runtime, async message => {
    if (message.type === "boom") throw new Error("dispatch failed");
    if (message.type === "dynamic_context_response") channel.acceptDynamicContextResponse(message);
  });
  assert.equal(connectListeners.size, 1);
  connectListeners.values().next().value(port);
  assert.equal(channel.size(), 1);
  assert.equal(port.sent.some(message => message.type === "state"), false, "a new port must not receive an unscoped synthetic runtime state");
  assert.ok(port.sent.some(message => message.type === "session_imported_from_export"));

  const enriched = channel.broadcast({ type: "message_update", sessionId: " s1 ", content: "x" });
  assert.equal(enriched.sessionId, "s1");
  assert.equal(enriched.runtime.status, "running");
  assert.equal(port.sent.at(-1).runtime.status, "running");

  port.emitMessage({ type: "sidepanel_attach", windowId: 7 });
  const locationPromise = channel.requestLocation({ timeoutMs: 100, windowId: 7 });
  const request = port.sent.at(-1);
  assert.equal(request.type, "dynamic_context_request");
  port.emitMessage({
    type: "dynamic_context_response",
    requestId: request.requestId,
    context: { location: { href: "https://page.test/" } },
  });
  assert.deepEqual(await locationPromise, { href: "https://page.test/" });

  port.emitMessage({ type: "boom", requestId: "req-1", sessionId: "s1" });
  await tick();
  assert.deepEqual(port.sent.at(-1), {
    type: "request_failed",
    sessionId: "s1",
    requestId: "req-1",
    requestType: "boom",
    code: "TRANSPORT_SEND_FAILED",
    message: "dispatch failed",
    details: {},
  });
  port.emitDisconnect();
  assert.equal(channel.size(), 0);
  await assert.rejects(channel.requestLocation({ timeoutMs: 1, windowId: 7 }), { code: "LOCATION_PANEL_UNAVAILABLE" });
  unregister();
  assert.equal(connectListeners.size, 0);
}

function validSessionExchangePayload(title) {
  return createSessionExchangePayload({
    session: { id: "source", title },
    conversation: serializeConversation([{ role: "user", content: "import me" }]),
    transcript: [],
    exportedAt: "2026-07-12 12:00:00",
  });
}

function fakePort(name) {
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  return {
    name,
    sent: [],
    postMessage(message) { this.sent.push(message); },
    onMessage: { addListener: listener => messageListeners.add(listener), removeListener: listener => messageListeners.delete(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.add(listener), removeListener: listener => disconnectListeners.delete(listener) },
    emitMessage(message) { for (const listener of messageListeners) listener(message); },
    emitDisconnect() { for (const listener of disconnectListeners) listener(); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
