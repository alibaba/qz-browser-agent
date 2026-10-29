import assert from "node:assert/strict";
import { storedSessionKey } from "../../src/shared/session/session-store.js";
import {
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import { SKILL_SETTINGS_STORAGE_KEY } from "../../src/background/skills/skill-settings.js";

const storageData = {};
storageData._qingzhou_mcp_bridge = { enabled: false };
const postedMessages = [];
const COVERAGE_PLUGIN_SKILL_NAME = "coverage-plugin-skill";
const COVERAGE_PLUGIN_TOOL_NAME = "coverage_helper__ping";
const state = {
  runtimeOnConnect: [],
  runtimeOnMessage: [],
  storageOnChanged: [],
  tabsOnRemoved: [],
  tabsOnUpdated: [],
  alarmsOnAlarm: [],
  notificationsOnClicked: [],
  commandsOnCommand: [],
  actionOnClicked: [],
  sidePanelOpens: [],
  clearedNotifications: [],
  windowUpdates: [],
  tabs: [
    {
      id: 3,
      windowId: 1,
      title: "Smoke Page",
      url: "https://smoke.example/page",
      active: true,
      pinned: false,
      status: "complete",
    },
  ],
  tabUpdates: [],
  alarms: new Map(),
  llmFetches: [],
  networkRequests: [],
  llmFetchGate: null,
  bridgeListToolsSessionId: "",
  bridgePolls: 0,
  bridgeResults: [],
  skillStorageReads: 0,
  skillStorageGetFailures: 1,
  skillStorageGetGate: null,
  skillSettingsSetFailure: null,
  skillSettingsSetGate: null,
};

storageData._telemetry_config = { enabled: true, updatesEnabled: true, endpoint: "https://analytics.example.test", apiKey: "legacy-test-key" };

storageData.llmConfig = {
  provider: "custom",
  customProtocol: "openai",
  customEndpoint: "https://llm-smoke.test/chat/completions",
  apiKey: "test-key",
  model: "smoke-model",
  contextWindow: 128000,
  trimOldToolResults: true,
  vision: false,
  debugMode: false,
};
storageData._skills = {
  [COVERAGE_PLUGIN_SKILL_NAME]: {
    name: COVERAGE_PLUGIN_SKILL_NAME,
    description: "Coverage-only global plugin Skill",
    content: "Load this Skill before using its plugin tool.",
    metadata: {},
    scope: "global",
    status: "active",
    domains: [],
    urlPatterns: [],
    excludePatterns: [],
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    createdAt: "2026-07-14 10:00:00",
    updatedAt: "2026-07-14 10:00:00",
    resources: [
      {
        path: "plugin.json",
        type: "json",
        content: JSON.stringify({
          format: SKILL_MANIFEST_FORMAT,
          schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
          id: "coverage-helper",
          name: "Coverage Helper",
          version: "1.0.0",
          settings: {
            title: "Coverage settings",
            fields: [{ key: "token", type: "secret", label: "Token", required: true }],
          },
          tools: [{
            name: "ping",
            title: "Coverage ping",
            description: "Only visible after the owning Skill is loaded",
            script: "scripts/ping.js",
            parameters: { type: "object", properties: {} },
          }],
        }),
      },
      {
        path: "scripts/ping.js",
        type: "script",
        content: "async () => ({ ok: true })",
      },
    ],
  },
};

const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;
function shouldSuppressPdfWarning(args) {
  const text = args.map(item => String(item)).join(" ");
  return /Cannot load "@napi-rs\/canvas"|Cannot polyfill `(DOMMatrix|ImageData|Path2D)`/.test(text);
}
function shouldSuppressRoutineLog(args) {
  const text = args.map(item => String(item)).join(" ");
  return /^\[LLM\]/.test(text)
    || /^\[轻舟\] Service Worker started/.test(text)
    || /^\[轻舟\] setPanelBehavior OK/.test(text);
}
console.warn = (...args) => {
  if (shouldSuppressPdfWarning(args)) return;
  originalConsoleWarn(...args);
};
console.log = (...args) => {
  if (shouldSuppressPdfWarning(args) || shouldSuppressRoutineLog(args)) return;
  originalConsoleLog(...args);
};

globalThis.chrome = createChromeMock();
globalThis.fetch = createFetchMock([
  openAiSse([
    {
      id: "chatcmpl-smoke-1",
      object: "chat.completion.chunk",
      model: "smoke-model",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_use_tab",
            type: "function",
            function: {
              name: "use_tab",
              arguments: "{\"tabId\":3}",
            },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-smoke-1",
      object: "chat.completion.chunk",
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]),
  openAiSse([
    {
      id: "chatcmpl-smoke-2",
      object: "chat.completion.chunk",
      model: "smoke-model",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "done" },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-smoke-2",
      object: "chat.completion.chunk",
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]),
  openAiTextResponse("history marker acknowledged", "exchange-seed"),
  openAiTextResponse("continuation acknowledged", "exchange-source"),
  openAiTextResponse("continuation acknowledged", "exchange-imported"),
]);

try {
  await import("../../src/background/service-worker.js");
  const pluginRuntime = await import("../../src/background/skills/skill-tool-runtime.js");

  assert.equal(state.alarmsOnAlarm.length, 1, "only the automation alarm router should register before data consent");
  const consentReply = await new Promise(resolve => state.runtimeOnMessage[0](
    { type: "accept_data_consent", version: 1 },
    { id: chrome.runtime.id, url: chrome.runtime.getURL("sidepanel/sidepanel.html") }, resolve,
  ));
  assert.equal(consentReply.ok, true);
  assert.equal(storageData.qz_data_consent.version, 1);

  assert.equal(state.alarmsOnAlarm.length, 2, "data consent should add the MCP reconnect listener alongside the automation router");
  for (const name of ["unrelated-alarm", "qingzhou-mcp-bridge-reconnect"]) {
    for (const listener of state.alarmsOnAlarm) listener({ name });
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.bridgePolls, 0, "alarm delivery must not enable a disabled MCP bridge");
  assert.equal(state.alarms.has("qingzhou-mcp-bridge-reconnect"), false, "a disabled bridge must not schedule reconnect alarms");
  assert.equal(state.commandsOnCommand.length, 1, "service worker should register one custom command router");
  const sidePanelOpenCount = state.sidePanelOpens.length;
  state.commandsOnCommand[0]("unrelated-command", state.tabs[0]);
  assert.equal(state.sidePanelOpens.length, sidePanelOpenCount, "unrelated commands must remain untouched");
  state.commandsOnCommand[0]("open-model-preset-switcher", {});
  assert.equal(state.sidePanelOpens.length, sidePanelOpenCount, "commands without a source window must be ignored");
  const shortcutOpen = globalThis.chrome.sidePanel.open;
  let rejectedWithoutPanel = false;
  globalThis.chrome.sidePanel.open = async () => {
    rejectedWithoutPanel = true;
    throw "simulated non-Error side panel rejection";
  };
  state.commandsOnCommand[0]("open-model-preset-switcher", state.tabs[0]);
  await waitFor(() => rejectedWithoutPanel);
  await new Promise(resolve => setTimeout(resolve, 0));
  globalThis.chrome.sidePanel.open = shortcutOpen;
  state.commandsOnCommand[0]("open-model-preset-switcher", state.tabs[0]);
  await waitFor(() => state.sidePanelOpens.length === sidePanelOpenCount + 1);
  assert.deepEqual(state.sidePanelOpens.at(-1), { windowId: 1 });
  // Finish the native-open promise while no panel is attached, so this exercises
  // buffered delivery instead of racing a direct send against connectPort below.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(postedMessages.some(msg => msg.type === "model_preset_switcher_requested"), false,
    "a shortcut without an attached panel must remain buffered until attachment");
  const port = createPort("sidepanel");
  assert.equal(state.runtimeOnConnect.length, 2, "service worker should register separate Side Panel and runtime request port listeners");
  const unrelatedPort = createPort("unrelated");
  connectPort(unrelatedPort);
  assert.equal(unrelatedPort.onMessage._listeners.length, 0, "both adapters must ignore unrelated ports");
  connectPort(port);
  assert.equal(port.onMessage._listeners.length, 1, "only the Side Panel adapter must handle a Side Panel port");
  await sendPortMessage(port, {
    type: "sidepanel_attach",
    requestId: "attach-window-1",
    windowId: 1,
  }, msg => msg.type === "sidepanel_attached" && msg.requestId === "attach-window-1");
  assert.ok(
    postedMessages.some(msg => msg.type === "model_preset_switcher_requested" && msg.source === "shortcut"),
    "a shortcut fired before Side Panel attachment should reveal the preset switcher after attachment",
  );
  assert.equal(
    postedMessages.filter(msg => msg.type === "model_preset_switcher_requested" && msg.source === "shortcut").length,
    1,
    "a rejected shortcut must not leave a phantom switcher request for a later Side Panel attachment",
  );
  assert.equal(
    postedMessages.some(msg => msg.type === "state" && !msg.sessionId),
    false,
    "connecting sidepanel must not invent an unscoped idle state",
  );

  const visibleShortcutStart = postedMessages.length;
  state.commandsOnCommand[0]("open-model-preset-switcher", state.tabs[0]);
  await waitFor(() => state.sidePanelOpens.length === sidePanelOpenCount + 2);
  await waitFor(() => postedMessages.slice(visibleShortcutStart).some(msg => (
    msg.type === "model_preset_switcher_requested" && msg.source === "shortcut"
  )));
  assert.equal(
    state.sidePanelOpens.length,
    sidePanelOpenCount + 2,
    "an already-connected Side Panel should still pass through Chrome's native open path before revealing the switcher",
  );

  const shortcutOpenGate = deferred();
  const connectedShortcutStart = postedMessages.length;
  globalThis.chrome.sidePanel.open = (options = {}) => {
    state.sidePanelOpens.push({ ...options });
    return shortcutOpenGate.promise;
  };
  state.commandsOnCommand[0]("open-model-preset-switcher", state.tabs[0]);
  await waitFor(() => state.sidePanelOpens.length === sidePanelOpenCount + 3);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    postedMessages.slice(connectedShortcutStart).some(msg => msg.type === "model_preset_switcher_requested"),
    false,
    "an already-connected panel should not open the switcher before sidePanel.open settles",
  );
  shortcutOpenGate.resolve();
  await waitFor(() => postedMessages.slice(connectedShortcutStart).some(msg => (
    msg.type === "model_preset_switcher_requested" && msg.source === "shortcut"
  )));
  globalThis.chrome.sidePanel.open = shortcutOpen;

  const rejectedShortcutStart = postedMessages.length;
  const rejectedOpenCount = state.sidePanelOpens.length;
  globalThis.chrome.sidePanel.open = async (options = {}) => {
    state.sidePanelOpens.push({ ...options });
    throw new Error("simulated side panel open rejection");
  };
  state.commandsOnCommand[0]("open-model-preset-switcher", state.tabs[0]);
  await waitFor(() => state.sidePanelOpens.length === rejectedOpenCount + 1);
  await waitFor(() => postedMessages.slice(rejectedShortcutStart).some(msg => (
    msg.type === "model_preset_switcher_requested" && msg.source === "shortcut"
  )));
  globalThis.chrome.sidePanel.open = shortcutOpen;

  const initialSettings = await sendPortMessage(port, {
    type: "list_skill_settings",
    requestId: "list-coverage-settings",
  }, msg => msg.type === "skill_settings" && msg.requestId === "list-coverage-settings");
  assert.equal(initialSettings.settings?.[0]?.skillName, COVERAGE_PLUGIN_SKILL_NAME);
  assert.equal(state.skillStorageGetFailures, 0, "the startup registry read should exercise the injected failure");
  assert.ok(state.skillStorageReads >= 2, "the first consumer should retry a failed startup initialization");
  assert.ok(pluginRuntime.getSkillToolRegistrySnapshot().refreshedAt > 0, "the retry should commit a usable registry");

  const previousSkillName = "coverage-plugin-skill-before-rename";
  const previousIdentity = `${previousSkillName}::coverage-helper`;
  const nextIdentity = `${COVERAGE_PLUGIN_SKILL_NAME}::coverage-helper`;
  storageData[SKILL_SETTINGS_STORAGE_KEY] = {
    version: 1,
    records: {
      [previousIdentity]: {
        pluginId: "coverage-helper",
        skillName: previousSkillName,
        values: { token: "rename-preserved-secret" },
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    },
  };
  const registryEventStart = postedMessages.length;
  await sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-after-skill-rename",
    reason: "coverage_skill_rename",
    skillName: COVERAGE_PLUGIN_SKILL_NAME,
    previousSkillName,
  }, msg => msg.type === "skill_registry_refreshed" && msg.requestId === "refresh-after-skill-rename");
  assert.equal(
    storageData[SKILL_SETTINGS_STORAGE_KEY]?.records?.[nextIdentity]?.values?.token,
    "rename-preserved-secret",
    "the composition root should migrate Plugin settings through the shared registry refresh boundary",
  );
  assert.equal(
    storageData[SKILL_SETTINGS_STORAGE_KEY]?.records?.[previousIdentity],
    undefined,
    "the old Skill identity should not retain a duplicate secret record after rename",
  );
  const registryEvents = postedMessages.slice(registryEventStart).filter(message => (
    message.type === "plugin_registry_update" || message.type === "skill_registry_update"
  ));
  assert.deepEqual(
    registryEvents.map(message => message.type),
    ["plugin_registry_update"],
    "one Skill registry commit should publish exactly one canonical event",
  );
  assert.equal(registryEvents[0].previousSkillName, previousSkillName);
  assert.equal(registryEvents[0].skillName, COVERAGE_PLUGIN_SKILL_NAME);

  const atomicBaseline = pluginRuntime.getSkillToolRegistrySnapshot();
  const failedPluginSkillName = "failed-refresh-plugin-skill";
  storageData._skills[failedPluginSkillName] = testPluginSkill(failedPluginSkillName, "failed-refresh-plugin");
  storageData[SKILL_SETTINGS_STORAGE_KEY].records["removed-skill::removed-plugin"] = {
    pluginId: "removed-plugin",
    skillName: "removed-skill",
    values: { obsolete: "value" },
    updatedAt: "2026-07-17T00:01:00.000Z",
  };
  state.skillSettingsSetFailure = new Error("forced settings reconcile failure");
  const failedRefreshEventStart = postedMessages.length;
  const failedRefresh = await sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-settings-failure",
    reason: "coverage_settings_failure",
  }, msg => msg.type === "request_failed" && msg.requestId === "refresh-settings-failure");
  assert.match(failedRefresh.message, /forced settings reconcile failure/);
  assert.equal(failedRefresh.requestType, "refresh_skill_registry");
  assert.equal(postedMessages.slice(failedRefreshEventStart).some(message => message.type === "error"), false,
    "request failures must not become Agent lifecycle errors");
  assert.deepEqual(
    pluginRuntime.getSkillToolRegistrySnapshot(),
    atomicBaseline,
    "settings reconciliation failure must not expose the prepared Plugin candidate",
  );
  assert.equal(
    postedMessages.slice(failedRefreshEventStart).some(message => message.type === "plugin_registry_update"),
    false,
    "a failed transaction must not publish a registry event",
  );
  assert.equal(
    pluginRuntime.getSkillToolRegistrySnapshot().plugins.some(plugin => plugin.id === "failed-refresh-plugin"),
    false,
  );
  const recoveryWriteStarted = deferred();
  const recoveryWriteRelease = deferred();
  state.skillSettingsSetFailure = new Error("forced recovery reconcile failure");
  state.skillSettingsSetGate = {
    started: recoveryWriteStarted.resolve,
    release: recoveryWriteRelease.promise,
  };
  const fallbackEventStart = postedMessages.length;
  const fallbackRequest = sendPortMessage(port, {
    type: "list_plugin_contributions",
    requestId: "fallback-settings-failure",
  }, msg => msg.type === "plugin_contributions" && msg.requestId === "fallback-settings-failure");
  await recoveryWriteStarted.promise;
  const recoveryRequest = sendPortMessage(port, {
    type: "list_plugin_contributions",
    requestId: "recover-settings-failure",
  }, msg => msg.type === "plugin_contributions" && msg.requestId === "recover-settings-failure");
  await new Promise(resolve => setTimeout(resolve, 5));
  recoveryWriteRelease.resolve();
  const [fallbackContributions, recoveredContributions] = await Promise.all([fallbackRequest, recoveryRequest]);
  assert.equal(
    fallbackContributions.plugins?.some(plugin => plugin.id === "failed-refresh-plugin"),
    false,
    "a failed recovery should serve the last committed registry instead of a partial candidate",
  );
  assert.equal(
    recoveredContributions.plugins?.some(plugin => plugin.id === "failed-refresh-plugin"),
    true,
    "the next registry consumer should retry the dirty persisted source",
  );
  assert.equal(
    storageData[SKILL_SETTINGS_STORAGE_KEY].records["removed-skill::removed-plugin"],
    undefined,
    "the recovery retry should finish the interrupted settings reconciliation",
  );
  const recoveryEvents = postedMessages.slice(fallbackEventStart).filter(message => message.type === "plugin_registry_update");
  assert.deepEqual(recoveryEvents.map(message => message.reason), ["platform_contributions"]);
  assert.deepEqual(recoveryEvents.map(message => message.version), [atomicBaseline.version + 1]);
  delete storageData._skills[failedPluginSkillName];
  await sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-failure-cleanup",
    reason: "coverage_failure_cleanup",
  }, msg => msg.type === "skill_registry_refreshed" && msg.requestId === "refresh-failure-cleanup");

  const firstConcurrentSkillName = "concurrent-plugin-a-skill";
  const secondConcurrentSkillName = "concurrent-plugin-b-skill";
  storageData._skills[firstConcurrentSkillName] = testPluginSkill(firstConcurrentSkillName, "concurrent-plugin-a");
  storageData[SKILL_SETTINGS_STORAGE_KEY].records["queue-stale-skill::queue-stale-plugin"] = {
    pluginId: "queue-stale-plugin",
    skillName: "queue-stale-skill",
    values: { obsolete: "value" },
    updatedAt: "2026-07-17T00:02:00.000Z",
  };
  const settingsWriteStarted = deferred();
  const settingsWriteRelease = deferred();
  state.skillSettingsSetGate = {
    started: settingsWriteStarted.resolve,
    release: settingsWriteRelease.promise,
  };
  const concurrentBaseline = pluginRuntime.getSkillToolRegistrySnapshot();
  const concurrentReadStart = state.skillStorageReads;
  const concurrentEventStart = postedMessages.length;
  const firstRefresh = sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-concurrent-a",
    reason: "coverage_concurrent_a",
  }, msg => msg.type === "skill_registry_refreshed" && msg.requestId === "refresh-concurrent-a");
  await settingsWriteStarted.promise;
  assert.deepEqual(
    pluginRuntime.getSkillToolRegistrySnapshot(),
    concurrentBaseline,
    "the registry must remain stable while settings reconciliation is pending",
  );
  delete storageData._skills[firstConcurrentSkillName];
  storageData._skills[secondConcurrentSkillName] = testPluginSkill(secondConcurrentSkillName, "concurrent-plugin-b");
  const secondRefresh = sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-concurrent-b",
    reason: "coverage_concurrent_b",
  }, msg => msg.type === "skill_registry_refreshed" && msg.requestId === "refresh-concurrent-b");
  const concurrentRead = sendPortMessage(port, {
    type: "list_plugin_contributions",
    requestId: "read-during-concurrent-refresh",
  }, msg => msg.type === "plugin_contributions" && msg.requestId === "read-during-concurrent-refresh");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    state.skillStorageReads,
    concurrentReadStart + 1,
    "the second transaction must not prepare against storage until the first transaction finishes",
  );
  assert.equal(
    postedMessages.slice(concurrentEventStart).some(message => message.type === "plugin_registry_update"),
    false,
    "no candidate may publish before its full transaction commits",
  );
  assert.equal(
    postedMessages.slice(concurrentEventStart).some(message => (
      message.type === "plugin_contributions" && message.requestId === "read-during-concurrent-refresh"
    )),
    false,
    "readiness consumers must wait for every transaction already queued",
  );
  settingsWriteRelease.resolve();
  await Promise.all([firstRefresh, secondRefresh, concurrentRead]);
  const concurrentEvents = postedMessages.slice(concurrentEventStart).filter(message => message.type === "plugin_registry_update");
  assert.deepEqual(
    concurrentEvents.map(message => message.reason),
    ["coverage_concurrent_a", "coverage_concurrent_b"],
    "concurrent commits and their events must preserve request order",
  );
  assert.deepEqual(
    concurrentEvents.map(message => message.version),
    [concurrentBaseline.version + 1, concurrentBaseline.version + 2],
    "each successful transaction should publish one consecutive registry version",
  );
  assert.equal(state.skillStorageReads, concurrentReadStart + 2);
  const concurrentFinal = pluginRuntime.getSkillToolRegistrySnapshot();
  assert.equal(concurrentFinal.plugins.some(plugin => plugin.id === "concurrent-plugin-a"), false);
  assert.equal(concurrentFinal.plugins.some(plugin => plugin.id === "concurrent-plugin-b"), true);
  const concurrentContribution = postedMessages.slice(concurrentEventStart).find(message => (
    message.type === "plugin_contributions" && message.requestId === "read-during-concurrent-refresh"
  ));
  assert.equal(concurrentContribution?.plugins?.some(plugin => plugin.id === "concurrent-plugin-a"), false);
  assert.equal(concurrentContribution?.plugins?.some(plugin => plugin.id === "concurrent-plugin-b"), true);
  delete storageData._skills[secondConcurrentSkillName];
  await sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-concurrent-cleanup",
    reason: "coverage_concurrent_cleanup",
  }, msg => msg.type === "skill_registry_refreshed" && msg.requestId === "refresh-concurrent-cleanup");

  const registryReadStarted = deferred();
  const registryReadRelease = deferred();
  state.skillStorageGetGate = {
    started: registryReadStarted.resolve,
    release: registryReadRelease.promise,
  };
  const settingsLifecycleEventStart = postedMessages.length;
  const refreshBeforeSettingsSave = sendPortMessage(port, {
    type: "refresh_skill_registry",
    requestId: "refresh-before-settings-save",
    reason: "coverage_settings_serialization",
  }, msg => msg.type === "skill_registry_refreshed" && msg.requestId === "refresh-before-settings-save");
  await registryReadStarted.promise;
  const concurrentSettingsSave = sendPortMessage(port, {
    type: "save_skill_settings",
    requestId: "save-during-registry-prepare",
    pluginId: "coverage-helper",
    skillName: COVERAGE_PLUGIN_SKILL_NAME,
    values: { token: "serialized-secret" },
  }, msg => msg.type === "skill_settings_saved" && msg.requestId === "save-during-registry-prepare");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    postedMessages.slice(settingsLifecycleEventStart).some(message => (
      message.type === "skill_settings_saved" && message.requestId === "save-during-registry-prepare"
    )),
    false,
    "settings writes must wait outside their own write queue while a registry transaction is preparing",
  );
  registryReadRelease.resolve();
  await settleWithin(
    Promise.all([refreshBeforeSettingsSave, concurrentSettingsSave]),
    "registry refresh and concurrent settings save",
  );
  const settingsLifecycleEvents = postedMessages.slice(settingsLifecycleEventStart);
  const registryCommitIndex = settingsLifecycleEvents.findIndex(message => (
    message.type === "plugin_registry_update" && message.reason === "coverage_settings_serialization"
  ));
  const settingsSavedIndex = settingsLifecycleEvents.findIndex(message => (
    message.type === "skill_settings_saved" && message.requestId === "save-during-registry-prepare"
  ));
  assert.ok(registryCommitIndex >= 0 && settingsSavedIndex > registryCommitIndex,
    "registry commit and settings save should share one ordered lifecycle boundary");
  assert.equal(
    storageData[SKILL_SETTINGS_STORAGE_KEY]?.records?.[nextIdentity]?.values?.token,
    "serialized-secret",
    "the serialized settings request should persist after the registry transaction commits",
  );

  const created = await sendPortMessage(port, {
    type: "create_ui_session",
    requestId: "create-smoke",
    title: "",
    firstMessage: "",
  }, msg => msg.type === "create_ui_session_result" && msg.requestId === "create-smoke");
  const sessionId = created.session?.id;
  assert.ok(sessionId, "create_ui_session should create a session id");
  const renamed = await sendPortMessage(port, {
    type: "rename_session",
    requestId: "rename-smoke",
    sessionId,
    title: "手工 Smoke 标题",
  }, msg => msg.type === "rename_session_result" && msg.requestId === "rename-smoke");
  assert.equal(renamed.session?.title, "手工 Smoke 标题", "Side Panel rename should persist through the Background API");
  assert.equal(renamed.session?.titleSource, "manual");
  assert.equal(storageData._sessions?.[sessionId]?.title, "手工 Smoke 标题");
  const listedAfterRename = await sendPortMessage(port, {
    type: "list_sessions",
    requestId: "list-after-rename",
  }, msg => msg.type === "list_sessions_result" && msg.requestId === "list-after-rename");
  assert.equal(
    listedAfterRename.sessions?.find(session => session.id === sessionId)?.title,
    "手工 Smoke 标题",
    "the task list query should observe the same persisted title",
  );

  let releaseFirstProviderFetch;
  state.llmFetchGate = new Promise(resolve => {
    releaseFirstProviderFetch = resolve;
  });
  const agentEndPromise = sendPortMessage(port, {
    type: "prompt",
    sessionId,
    text: "Use tab 3, then finish.",
    clientMessageId: "user-smoke",
  }, msg => msg.type === "agent_end" && msg.sessionId === sessionId);
  let nestedToolListBeforeLoad;
  let nestedSkillLoad;
  let nestedToolListAfterLoad;
  try {
    const agentStart = await waitForPostedMessage(
      msg => msg.type === "agent_start" && msg.sessionId === sessionId,
    );
    nestedToolListBeforeLoad = await invokeRuntimeMessage({
      type: "run_script_tool_call",
      toolName: "__list_tools__",
      sessionId,
      runId: agentStart.runId,
    });
    nestedSkillLoad = await invokeRuntimeMessage({
      type: "run_script_tool_call",
      toolName: "load_skill",
      args: { name: COVERAGE_PLUGIN_SKILL_NAME },
      sessionId,
      runId: agentStart.runId,
    });
    nestedToolListAfterLoad = await invokeRuntimeMessage({
      type: "run_script_tool_call",
      toolName: "__list_tools__",
      sessionId,
      runId: agentStart.runId,
    });
  } finally {
    state.llmFetchGate = null;
    releaseFirstProviderFetch?.();
  }
  const agentEnd = await agentEndPromise;
  assert.equal(agentEnd.status, "completed", "agent run should complete");
  assert.equal(nestedToolListBeforeLoad.ok, true, "active run should expose its frozen tool context to run_script");
  assert.equal(
    nestedToolListBeforeLoad.result?.tools?.some(tool => tool.name === COVERAGE_PLUGIN_TOOL_NAME),
    false,
    "an unloaded global Skill tool should not appear in the active Agent snapshot",
  );
  assert.equal(nestedSkillLoad.ok, true, "run_script should execute load_skill through the active Agent");
  assert.equal(nestedSkillLoad.result?.name, COVERAGE_PLUGIN_SKILL_NAME);
  assert.equal(
    nestedToolListAfterLoad.result?.tools?.some(tool => tool.name === COVERAGE_PLUGIN_TOOL_NAME),
    true,
    "the active Agent should expose a dynamically loaded Skill tool to the same run_script",
  );
  const idleAgentToolList = await invokeRuntimeMessage({
    type: "run_script_tool_call",
    toolName: "__list_tools__",
    sessionId,
  });
  assert.equal(
    idleAgentToolList.ok,
    true,
    "run_script should fall back to runtime context after the live Agent run completes",
  );
  const idleNestedSkillLoad = await invokeRuntimeMessage({
    type: "run_script_tool_call",
    toolName: "load_skill",
    args: { name: COVERAGE_PLUGIN_SKILL_NAME },
    sessionId,
  });
  assert.equal(idleNestedSkillLoad.ok, true, "an idle nested tool call should still use persisted runtime context");
  assert.equal(
    state.llmFetches.filter(request => request.kind !== "title").length,
    2,
    "mock Agent LLM should be called once before and once after the tool call",
  );
  assert.ok(
    postedMessages.some(msg => msg.type === "agent_start" && msg.sessionId === sessionId),
    "agent_start should be broadcast for the smoke run",
  );
  assert.ok(
    postedMessages.some(msg => msg.type === "tool_execution_start" && msg.sessionId === sessionId && msg.toolName === "use_tab"),
    "agent should execute the mocked use_tab tool call",
  );
  assert.ok(
    postedMessages.some(msg => msg.type === "tool_execution_end" && msg.sessionId === sessionId && msg.toolName === "use_tab" && msg.isError === false),
    "use_tab tool execution should finish successfully",
  );

  const runtimeState = await sendPortMessage(port, {
    type: "get_state",
    sessionId,
  }, msg => msg.type === "state" && msg.sessionId === sessionId);
  assert.equal(runtimeState.runtime?.workingTabId, 3, "service worker runtime should record the working tab");
  assert.equal(runtimeState.runtime?.workingUrl, "https://smoke.example/page");
  assert.equal(runtimeState.runtime?.workingTitle, "Smoke Page");
  assert.equal(runtimeState.runtime?.ownedTabIds?.includes(3), true, "use_tab should claim the tab for the session");

  const stoppedState = await sendPortMessage(port, {
    type: "stop_session", sessionId, requestId: "stop-runtime-route",
  }, msg => msg.requestId === "stop-runtime-route");
  assert.equal(stoppedState.type, "state", "the public stop route must resolve its business command");
  assert.equal(stoppedState.sessionId, sessionId);
  assert.equal(stoppedState.isStreaming, false);

  state.bridgeListToolsSessionId = sessionId;
  await setMcpBridgeEnabled(true);
  try {
    await waitFor(() => state.bridgeResults.some(result => result.requestId === "coverage-list-tools"));
    const bridgeResult = state.bridgeResults.find(result => result.requestId === "coverage-list-tools");
    assert.equal(bridgeResult.ok, true, "MCP list_tools should complete through the service worker transport");
    assert.ok(
      bridgeResult.result?.tools?.some(tool => tool.name === COVERAGE_PLUGIN_TOOL_NAME),
      "MCP list_tools should refresh the registry and preserve the loaded Skill tool",
    );
    assert.equal(state.alarms.has("qingzhou-mcp-bridge-reconnect"), true, "a connected bridge should schedule its reconnect alarm");
  } finally {
    state.bridgeListToolsSessionId = "";
    await setMcpBridgeEnabled(false);
  }
  assert.equal(state.alarms.has("qingzhou-mcp-bridge-reconnect"), false, "disabling the bridge should clear its reconnect alarm");

  await waitFor(() => storageData[`_session_runtime_${sessionId}`]?.workingTabId === 3);
  assert.equal(
    storageData[`_session_runtime_${sessionId}`]?.workingTabId,
    3,
    "persisted per-session runtime should include the working tab",
  );

  const exchangeSource = await sendPortMessage(port, {
    type: "create_ui_session",
    requestId: "create-exchange-source",
    title: "",
    firstMessage: "",
  }, msg => msg.type === "create_ui_session_result" && msg.requestId === "create-exchange-source");
  const exchangeSourceId = exchangeSource.session?.id;
  assert.ok(exchangeSourceId, "exchange source session should be created");

  const seedEnd = await sendPortMessage(port, {
    type: "prompt",
    sessionId: exchangeSourceId,
    text: "Remember the exact marker EXCHANGE_ALPHA.",
    clientMessageId: "exchange-seed-user",
  }, msg => msg.type === "agent_end" && msg.sessionId === exchangeSourceId);
  assert.equal(seedEnd.status, "completed", "exchange source history should complete before export");

  const exported = await sendPortMessage(port, {
    type: "export_session_exchange",
    requestId: "export-exchange-source",
    sessionId: exchangeSourceId,
  }, msg => msg.type === "export_session_exchange_result" && msg.requestId === "export-exchange-source");
  assert.ok(exported.payload?.session?.conversation, "export should contain the provider conversation history");

  const imported = await sendPortMessage(port, {
    type: "import_session_exchange",
    requestId: "import-exchange-copy",
    payload: exported.payload,
  }, msg => msg.type === "import_session_exchange_result" && msg.requestId === "import-exchange-copy");
  const importedSessionId = imported.session?.id;
  assert.ok(importedSessionId, "exchange payload should import as a new session");
  assert.notEqual(importedSessionId, exchangeSourceId, "import should allocate a new local session id");

  await sendPortMessage(port, {
    type: "restore_session",
    sessionId: importedSessionId,
    session: storageData[storedSessionKey(importedSessionId)]?.conversation,
  }, msg => msg.type === "session_restored" && msg.sessionId === importedSessionId);

  const providerRequestStart = state.llmFetches.length;
  const continuationText = "Continue from EXCHANGE_ALPHA and answer with one short sentence.";
  const sourceEnd = await sendPortMessage(port, {
    type: "prompt",
    sessionId: exchangeSourceId,
    text: continuationText,
    clientMessageId: "exchange-source-continuation",
  }, msg => msg.type === "agent_end" && msg.sessionId === exchangeSourceId);
  assert.equal(sourceEnd.status, "completed", "source continuation should complete");

  const importedEnd = await sendPortMessage(port, {
    type: "prompt",
    sessionId: importedSessionId,
    text: continuationText,
    clientMessageId: "exchange-imported-continuation",
  }, msg => msg.type === "agent_end" && msg.sessionId === importedSessionId);
  assert.equal(importedEnd.status, "completed", "imported continuation should complete");

  const continuationRequests = state.llmFetches
    .slice(providerRequestStart)
    .map(parseProviderRequest)
    .filter(request => requestContainsUserText(request, continuationText));
  assert.equal(continuationRequests.length, 2, "source and imported sessions should each issue one continuation request");
  const [sourceRequest, importedRequest] = continuationRequests;
  assert.ok(Array.isArray(sourceRequest.messages) && sourceRequest.messages.length > 0, "source provider request should contain messages");
  assert.ok(Array.isArray(sourceRequest.tools) && sourceRequest.tools.length > 0, "source provider request should contain tool schemas");
  const importCapsules = importedRequest.messages.filter(isSessionExchangeImportCapsuleMessage);
  assert.equal(importCapsules.length, 1, "the restored provider request should contain one external-session capsule");
  assert.match(importCapsules[0].content, /原环境中的技能、工具、数据表、图集、文件/u);
  assert.deepEqual(
    normalizeProviderRequest(withoutSessionExchangeImportCapsule(importedRequest)),
    normalizeProviderRequest(sourceRequest),
    "apart from the intentional import capsule, an imported session must produce the same provider request body as its source",
  );

  const connectedNotificationId = `qz_alert_session_${sessionId}_connected`;
  state.notificationsOnClicked[0](connectedNotificationId);
  assert.deepEqual(
    state.sidePanelOpens.at(-1),
    { tabId: 3 },
    "notification click must reopen the panel even while an existing panel port is connected",
  );
  await waitFor(() => postedMessages.some(message => (
    message.type === "session_reveal_requested" && message.sessionId === sessionId
  )));
  await waitFor(() => state.clearedNotifications.includes(connectedNotificationId));

  const movedWindowPort = createPort("sidepanel");
  connectPort(movedWindowPort);
  await sendPortMessage(movedWindowPort, {
    type: "sidepanel_attach",
    requestId: "attach-window-2",
    windowId: 2,
  }, msg => msg.type === "sidepanel_attached" && msg.requestId === "attach-window-2");
  const oldWindowRevealStart = port.messages.length;
  const movedWindowRevealStart = movedWindowPort.messages.length;
  const movedWindowFocusStart = state.windowUpdates.length;
  state.tabs.find(tab => tab.id === 3).windowId = 2;
  const movedWindowNotificationId = `qz_alert_session_${sessionId}_moved`;
  state.notificationsOnClicked[0](movedWindowNotificationId);
  assert.deepEqual(
    state.sidePanelOpens.at(-1),
    { tabId: 3 },
    "a moved working tab must still open synchronously by tab id",
  );
  await waitFor(() => movedWindowPort.messages.slice(movedWindowRevealStart).some(message => (
    message.type === "session_reveal_requested" && message.sessionId === sessionId
  )));
  assert.equal(
    port.messages.slice(oldWindowRevealStart).some(message => message.type === "session_reveal_requested"),
    false,
    "a moved working tab must not reveal its Session in the stale window",
  );
  await waitFor(() => state.windowUpdates.slice(movedWindowFocusStart).some(update => update.windowId === 2));
  assert.equal(
    state.windowUpdates.slice(movedWindowFocusStart).some(update => update.windowId === 1),
    false,
    "a moved working tab must not refocus the stale window",
  );
  await waitFor(() => state.clearedNotifications.includes(movedWindowNotificationId));
  for (const listener of movedWindowPort.onDisconnect._listeners.slice()) listener();
  state.tabs.find(tab => tab.id === 3).windowId = 1;

  for (const listener of port.onDisconnect._listeners.slice()) listener();
  const revealStart = postedMessages.length;
  const notificationId = `qz_alert_session_${sessionId}_smoke`;
  assert.equal(state.notificationsOnClicked.length, 1, "service worker should register one notification click router");
  state.notificationsOnClicked[0](notificationId);
  assert.deepEqual(
    state.sidePanelOpens.at(-1),
    { tabId: 3 },
    "notification click must synchronously open the side panel on the Session working tab",
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    postedMessages.slice(revealStart).some(message => message.type === "session_reveal_requested"),
    false,
    "a closed panel should retain its Session reveal until the matching window reconnects",
  );
  const reconnectedPort = createPort("sidepanel");
  connectPort(reconnectedPort);
  await sendPortMessage(reconnectedPort, {
    type: "sidepanel_attach",
    requestId: "reattach-window-1",
    windowId: 1,
  }, msg => msg.type === "sidepanel_attached" && msg.requestId === "reattach-window-1");
  await waitFor(() => postedMessages.slice(revealStart).some(message => (
    message.type === "session_reveal_requested" && message.sessionId === sessionId
  )));
  await waitFor(() => state.clearedNotifications.includes(notificationId));

  const originalSidePanelOpen = globalThis.chrome.sidePanel.open;
  try {
    const windowFallbackId = "qz_alert_session_missing_window";
    state.notificationsOnClicked[0](windowFallbackId);
    assert.deepEqual(
      state.sidePanelOpens.at(-1),
      { windowId: 1 },
      "notification click must fall back to the last known Chrome window when the Session has no working tab",
    );
    await waitFor(() => state.clearedNotifications.includes(windowFallbackId));

    globalThis.chrome.sidePanel.open = undefined;
    const connectedPanelFallbackId = "qz_alert_session_missing_connected";
    state.notificationsOnClicked[0](connectedPanelFallbackId);
    await waitFor(() => state.clearedNotifications.includes(connectedPanelFallbackId));
    assert.ok(
      postedMessages.some(message => (
        message.type === "session_reveal_requested" && message.sessionId === "missing"
      )),
      "a connected panel must still receive Session navigation when the sidePanel API is unavailable",
    );

    globalThis.chrome.sidePanel.open = () => {
      throw new Error("forced synchronous side panel failure");
    };
    const syncFailureId = "qz_alert_session_syncfailure_notice";
    state.notificationsOnClicked[0](syncFailureId);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(
      state.clearedNotifications.includes(syncFailureId),
      false,
      "a notification must remain available when opening the side panel throws synchronously",
    );

    globalThis.chrome.sidePanel.open = async () => {
      throw new Error("forced asynchronous side panel failure");
    };
    const asyncFailureId = "qz_alert_session_asyncfailure_notice";
    state.notificationsOnClicked[0](asyncFailureId);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(
      state.clearedNotifications.includes(asyncFailureId),
      false,
      "a notification must remain available when opening the side panel rejects asynchronously",
    );

    globalThis.chrome.sidePanel.open = originalSidePanelOpen;
    const missingWorkingTabId = `qz_alert_session_${sessionId}_missingtab`;
    const workingTabIndex = state.tabs.findIndex(tab => tab.id === 3);
    const [missingWorkingTab] = state.tabs.splice(workingTabIndex, 1);
    state.notificationsOnClicked[0](missingWorkingTabId);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(
      state.clearedNotifications.includes(missingWorkingTabId),
      false,
      "a notification must remain available when its Session working tab has disappeared",
    );
    globalThis.chrome.sidePanel.open = undefined;
    const unavailableTargetId = `qz_alert_session_${sessionId}_unavailable`;
    const unavailableRevealStart = postedMessages.length;
    state.notificationsOnClicked[0](unavailableTargetId);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(state.clearedNotifications.includes(unavailableTargetId), false,
      "without the sidePanel API or a live working tab, keep the notification available for retry");
    assert.equal(postedMessages.slice(unavailableRevealStart).some(message => message.type === "session_reveal_requested"), false,
      "an unavailable notification target must not reveal the Session in another window");
    state.tabs.splice(workingTabIndex, 0, missingWorkingTab);
    state.notificationsOnClicked[0](unavailableTargetId);
    await waitFor(() => state.clearedNotifications.includes(unavailableTargetId));
    assert.ok(postedMessages.slice(unavailableRevealStart).some(message => (
      message.type === "session_reveal_requested" && message.sessionId === sessionId
    )), "retry should reveal the Session in its connected panel once the working tab is available again");

    globalThis.chrome.sidePanel.open = () => {
      throw "forced synchronous non-Error side panel failure";
    };
    state.notificationsOnClicked[0]("qz_alert_session_syncstring_notice");
    await new Promise(resolve => setTimeout(resolve, 0));

    globalThis.chrome.sidePanel.open = () => Promise.reject("forced asynchronous non-Error side panel failure");
    state.notificationsOnClicked[0]("qz_alert_session_asyncstring_notice");
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    globalThis.chrome.sidePanel.open = originalSidePanelOpen;
  }

  const updateNotificationId = "qz_update_coverage_notice";
  state.notificationsOnClicked[0](updateNotificationId);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.clearedNotifications.includes(updateNotificationId), false, "obsolete update notifications have no handler");

  const originalGetManifest = globalThis.chrome.runtime.getManifest;
  try {
    globalThis.chrome.runtime.getManifest = () => ({});
    const versionlessExport = await sendPortMessage(reconnectedPort, {
      type: "export_session_exchange",
      requestId: "export-without-app-version",
      sessionId: exchangeSourceId,
    }, msg => msg.type === "export_session_exchange_result" && msg.requestId === "export-without-app-version");
    assert.equal(versionlessExport.payload?.app?.version, "", "exchange export should tolerate a missing manifest version");
  } finally {
    globalThis.chrome.runtime.getManifest = originalGetManifest;
  }

  const messagesBeforeLegacyCalls = postedMessages.length;
  const storageBeforeLegacyCalls = JSON.stringify(storageData);
  const networkBeforeLegacyCalls = state.networkRequests.length;
  for (const type of ["track_event", "flush_telemetry", "get_telemetry_config", "save_telemetry_config", "check_updates", "list_update_notices", "install_official_skill_package"]) {
    await dispatchPortMessage(reconnectedPort, { type, requestId: `obsolete-${type}`, config: { enabled: true }, eventName: "ui.tab.chat" });
  }
  assert.equal(postedMessages.length, messagesBeforeLegacyCalls, "removed remote-service actions do not produce success replies");
  assert.equal(JSON.stringify(storageData), storageBeforeLegacyCalls, "removed remote-service actions cannot mutate persisted configuration");
  assert.equal(state.networkRequests.length, networkBeforeLegacyCalls, "removed actions cannot start network requests");
  assert.equal([...state.alarms.keys()].some(name => /telemetry|update/i.test(name)), false, "startup never schedules removed remote services");
  assert.equal(state.networkRequests.some(url => /analytics\.example\.test|\/v1\/telemetry|\/v1\/updates|\/v1\/public\/skills/.test(url)), false, "legacy stored settings never reactivate collection or a directory service");

  console.log("service worker agent runtime smoke tests passed");
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
}

function createChromeMock() {
  return {
    declarativeNetRequest: {
      async getSessionRules() { return []; },
      async updateSessionRules() {},
    },
    storage: {
      onChanged: makeEvent(state.storageOnChanged),
      local: {
        async get(key) {
          if (key === "_skills" || (Array.isArray(key) && key.includes("_skills"))) {
            state.skillStorageReads += 1;
            if (state.skillStorageGetFailures > 0) {
              state.skillStorageGetFailures -= 1;
              throw new Error("forced startup registry read failure");
            }
            if (state.skillStorageGetGate) {
              const gate = state.skillStorageGetGate;
              state.skillStorageGetGate = null;
              gate.started();
              await gate.release;
            }
          }
          if (typeof key === "string") {
            return { [key]: storageData[key] };
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map(item => [item, storageData[item]]));
          }
          if (key && typeof key === "object") {
            return Object.fromEntries(
              Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
            );
          }
          return { ...storageData };
        },
        async set(values) {
          if (Object.prototype.hasOwnProperty.call(values || {}, SKILL_SETTINGS_STORAGE_KEY)) {
            if (state.skillSettingsSetGate) {
              const gate = state.skillSettingsSetGate;
              state.skillSettingsSetGate = null;
              gate.started();
              await gate.release;
            }
            if (state.skillSettingsSetFailure) {
              const error = state.skillSettingsSetFailure;
              state.skillSettingsSetFailure = null;
              throw error;
            }
          }
          Object.assign(storageData, values || {});
        },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete storageData[item];
        },
      },
    },
    runtime: {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      async getPlatformInfo() { return { os: "mac", arch: "arm64", nacl_arch: "arm" }; },
      lastError: null,
      getManifest() {
        return { version: "0.4.1" };
      },
      getURL(path) {
        return `chrome-extension://qingzhou/${path}`;
      },
      onStartup: makeEvent(),
      onInstalled: makeEvent(),
      onConnect: makeEvent(state.runtimeOnConnect),
      onMessage: makeEvent(state.runtimeOnMessage),
      sendMessage() {},
    },
    tabs: {
      onRemoved: makeEvent(state.tabsOnRemoved),
      onUpdated: makeEvent(state.tabsOnUpdated),
      async query(query = {}) {
        let tabs = state.tabs.slice();
        if (query.active) tabs = tabs.filter(tab => tab.active);
        if (query.currentWindow) tabs = tabs.filter(tab => tab.currentWindow !== false);
        if (query.windowId != null) tabs = tabs.filter(tab => Number(tab.windowId) === Number(query.windowId));
        if (query.url) {
          const patterns = Array.isArray(query.url) ? query.url : [query.url];
          tabs = tabs.filter(tab => patterns.some(pattern => matchChromeUrlPattern(pattern, tab.url)));
        }
        return tabs.map(tab => ({ ...tab }));
      },
      async get(tabId) {
        const tab = state.tabs.find(item => Number(item.id) === Number(tabId));
        if (!tab) throw new Error(`missing tab ${tabId}`);
        return { ...tab };
      },
      async update(tabId, patch = {}) {
        const tab = state.tabs.find(item => Number(item.id) === Number(tabId));
        if (!tab) throw new Error(`missing tab ${tabId}`);
        Object.assign(tab, patch);
        state.tabUpdates.push({ tabId: Number(tabId), patch: { ...patch } });
        return { ...tab };
      },
      async create(props = {}) {
        const nextId = Math.max(0, ...state.tabs.map(tab => Number(tab.id) || 0)) + 1;
        const tab = {
          id: nextId,
          windowId: props.windowId || 1,
          title: "",
          url: props.url || "",
          active: props.active === true,
          pinned: false,
          status: "complete",
        };
        state.tabs.push(tab);
        return { ...tab };
      },
      async remove(tabId) {
        const index = state.tabs.findIndex(item => Number(item.id) === Number(tabId));
        if (index >= 0) state.tabs.splice(index, 1);
      },
      async sendMessage() {
        return { ok: true };
      },
      async group() {
        return 1;
      },
      async ungroup() {},
    },
    tabGroups: {
      async get(groupId) {
        return { id: groupId, title: "轻舟" };
      },
      async update(groupId, patch = {}) {
        return { id: groupId, ...patch };
      },
    },
    windows: {
      onFocusChanged: makeEvent(),
      async getAll() {
        return [{ id: 1, focused: true, type: "normal" }];
      },
      async getLastFocused() {
        return { id: 1, focused: true, type: "normal" };
      },
      async update(windowId, patch = {}) {
        state.windowUpdates.push({ windowId: Number(windowId), patch: { ...patch } });
        return { id: windowId, ...patch };
      },
    },
    alarms: {
      onAlarm: makeEvent(state.alarmsOnAlarm),
      async get(name) {
        return state.alarms.get(name) || null;
      },
      async create(name, info = {}) {
        state.alarms.set(name, { name, ...info });
      },
      async clear(name) {
        return state.alarms.delete(name);
      },
    },
    notifications: {
      onClicked: makeEvent(state.notificationsOnClicked),
      create(notificationId, options, callback) {
        callback?.(notificationId);
      },
      clear(_notificationId, callback) {
        state.clearedNotifications.push(_notificationId);
        callback?.(true);
      },
      getPermissionLevel(callback) {
        callback?.("granted");
      },
    },
    commands: {
      onCommand: makeEvent(state.commandsOnCommand),
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
      async open(options = {}) {
        state.sidePanelOpens.push({ ...options });
      },
    },
    action: {
      onClicked: makeEvent(state.actionOnClicked),
    },
    offscreen: {},
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
    },
    downloads: {},
    bookmarks: {},
    history: {},
  };
}

function connectPort(port) {
  for (const listener of state.runtimeOnConnect.slice()) listener(port);
}

function createPort(name) {
  const messages = [];
  const port = {
    name,
    messages,
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    postMessage(message) {
      messages.push(message);
      postedMessages.push(message);
      if (message?.type === "dynamic_context_request" && message.requestId) {
        queueMicrotask(() => {
          for (const listener of port.onMessage._listeners.slice()) {
            listener({
              type: "dynamic_context_response",
              requestId: message.requestId,
              context: {},
            });
          }
        });
      }
    },
  };
  return port;
}

function makeEvent(target = []) {
  const listeners = target;
  return {
    addListener(fn) {
      if (typeof fn === "function" && !listeners.includes(fn)) listeners.push(fn);
    },
    removeListener(fn) {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener(fn) {
      return listeners.includes(fn);
    },
    _listeners: listeners,
  };
}

async function sendPortMessage(port, message, predicate) {
  const before = postedMessages.length;
  await dispatchPortMessage(port, message);
  return await waitForPostedMessage(predicate, before);
}

async function dispatchPortMessage(port, message) {
  const listeners = port.onMessage._listeners.slice();
  assert.ok(listeners.length, "test port should have a message listener");
  await Promise.all(listeners.map(listener => listener(message)));
}

async function waitForPostedMessage(predicate, startIndex = 0, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = postedMessages.slice(startIndex).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const tail = postedMessages.slice(Math.max(startIndex, postedMessages.length - 12));
  throw new Error(`timed out waiting for posted message after index ${startIndex}; received ${JSON.stringify(tail)}`);
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for condition");
}

function createFetchMock(responses = []) {
  const queue = responses.slice();
  let bridgeIdentity;
  return async function fetchMock(url, init = {}) {
    const href = String(url || "");
    state.networkRequests.push(href);
    if (href === "chrome-extension://qingzhou/rules/provider-headers.json") return Response.json([]);
    if (href === "https://llm-smoke.test/chat/completions") {
      const request = JSON.parse(String(init.body || "{}"));
      const titleRequest = isTitleGenerationRequest(request);
      state.llmFetches.push({ url: href, init, kind: titleRequest ? "title" : "agent" });
      if (state.llmFetchGate) await state.llmFetchGate;
      if (titleRequest) {
        return Response.json({
          id: "chatcmpl-smoke-title",
          object: "chat.completion",
          model: "smoke-model",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Smoke title" },
            finish_reason: "stop",
          }],
        });
      }
      const body = queue.shift();
      if (body == null) return new Response("{}", { status: 500 });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (href === "http://127.0.0.1:18765/health") {
      return Response.json({ service: "qz-browser-agent", protocolVersion: 1, features: { browserPairing: 1 }, instanceId: "smoke-instance" });
    }
    if (href === "http://127.0.0.1:18765/v1/qingzhou/pair") {
      const paired = JSON.parse(String(init.body || "{}"));
      bridgeIdentity = { clientId: paired.clientId, name: paired.name, connectionId: paired.connectionId, instanceId: paired.instanceId };
      return Response.json({ ok: true, ...paired });
    }
    if (href === "http://127.0.0.1:18765/v1/qingzhou/disconnect") return Response.json({ ok: true });
    if (href === "http://127.0.0.1:18765/v1/qingzhou/poll") {
      state.bridgePolls += 1;
      const requests = state.bridgePolls === 1 && state.bridgeListToolsSessionId
        ? [{
            id: "coverage-list-tools",
            method: "list_tools",
            params: {
              sessionId: state.bridgeListToolsSessionId,
              loadedPluginSkillNames: [COVERAGE_PLUGIN_SKILL_NAME],
            },
          }]
        : [];
      return Response.json({ requests, ...bridgeIdentity });
    }
    if (href === "http://127.0.0.1:18765/v1/qingzhou/result") {
      state.bridgeResults.push(JSON.parse(String(init.body || "{}")));
      return Response.json({ ok: true });
    }
    return new Response("{}", { status: 404 });
  };
}

function isTitleGenerationRequest(request = {}) {
  const [system, source] = request.messages || [];
  if (request.stream !== false || request.messages?.length !== 2 || system?.role !== "system" || source?.role !== "user") return false;
  try { return typeof JSON.parse(String(source.content)).source_text === "string"; }
  catch { return false; }
}

async function invokeRuntimeMessage(message, sender = {}) {
  const listener = state.runtimeOnMessage[0];
  assert.equal(typeof listener, "function", "service worker should register a runtime-message listener");
  let resolveResponse;
  const responsePromise = new Promise(resolve => {
    resolveResponse = resolve;
  });
  const keepChannelOpen = listener(message, sender, resolveResponse);
  if (!keepChannelOpen) return await Promise.race([
    responsePromise,
    Promise.resolve(undefined),
  ]);
  let timeoutId;
  try {
    return await Promise.race([
      responsePromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`runtime message timed out: ${message?.type || "unknown"}`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function setMcpBridgeEnabled(enabled) {
  const response = await invokeRuntimeMessage({
    type: enabled ? "mcp_connection_connect" : "mcp_connection_disconnect",
    endpoint: "http://127.0.0.1:18765",
    name: "coverage-client",
  }, { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html` });
  assert.equal(response.ok, true);
  assert.equal(response.result?.state, enabled ? "connected" : "disconnected", "the bridge fixture must complete the requested connection transition");
}

function openAiSse(chunks = []) {
  return [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
}

function openAiTextResponse(content, suffix) {
  return openAiSse([
    {
      id: `chatcmpl-${suffix}`,
      object: "chat.completion.chunk",
      model: "smoke-model",
      choices: [{
        index: 0,
        delta: { role: "assistant", content },
        finish_reason: null,
      }],
    },
    {
      id: `chatcmpl-${suffix}`,
      object: "chat.completion.chunk",
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
}

function parseProviderRequest(fetchCall) {
  assert.ok(fetchCall?.init?.body, "provider fetch should contain a request body");
  return JSON.parse(String(fetchCall.init.body));
}

function normalizeProviderRequest(request) {
  const normalized = structuredClone(request);
  for (const message of normalized.messages || []) {
    if (typeof message?.content === "string") {
      message.content = message.content.replace(/^系统时间: .*$/gmu, "系统时间: <dynamic>");
    }
  }
  return normalized;
}

function requestContainsUserText(request, text) {
  return (request?.messages || []).some(message => message?.role === "user" && message?.content === text);
}

function isSessionExchangeImportCapsuleMessage(message) {
  return message?.role === "user"
    && typeof message.content === "string"
    && message.content.startsWith("[外部会话 capsule]\n");
}

function withoutSessionExchangeImportCapsule(request) {
  return {
    ...request,
    messages: (request?.messages || []).filter(message => !isSessionExchangeImportCapsuleMessage(message)),
  };
}

function matchChromeUrlPattern(pattern = "", url = "") {
  const source = String(pattern || "");
  const escaped = source
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(String(url || ""));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleWithin(promise, label, timeoutMs = 2000) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function testPluginSkill(name, id) {
  return {
    name,
    description: `Test Plugin ${id}`,
    content: "",
    metadata: {},
    scope: "resident",
    status: "active",
    domains: [],
    urlPatterns: [],
    excludePatterns: [],
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    createdAt: "2026-07-17 00:00:00",
    updatedAt: "2026-07-17 00:00:00",
    resources: [
      {
        path: "plugin.json",
        type: "json",
        content: JSON.stringify({
          format: SKILL_MANIFEST_FORMAT,
          schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
          id,
          name: id,
          version: "1.0.0",
          tools: [{
            name: "ping",
            title: "Ping",
            description: "Test transaction ordering",
            script: "scripts/ping.js",
            parameters: { type: "object", properties: {} },
          }],
        }),
      },
      { path: "scripts/ping.js", type: "script", content: "async () => ({ ok: true })" },
    ],
  };
}
