import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutomationRuntime, AUTOMATION_SCHEDULER_ALARM } from "../../src/background/automation/runtime.ts";
import { installFirefoxHost } from "../../src/background/firefox/host.ts";
import { getAgentPrompts, sessionAutomationPromptSuffix } from "../../src/background/agent/prompts.ts";
import { registerSessionTools } from "../../src/capabilities/sessions/tools.ts";
import { createSessionsFeature } from "../../src/capabilities/sessions/sessions-feature.ts";
import { removeSessionAutomationControls } from "../../src/capabilities/sessions/automations/availability.ts";
import { sessionAutomationsEnabled } from "../../src/shared/session-automations.ts";
import { installSidepanelFirefoxHost } from "../../src/sidepanel/firefox/host.ts";
import { rewriteFirefoxSidepanelHtml } from "../../scripts/firefox-manifest.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const RECONNECT_ALARM = readFileSync(join(repoRoot, "src/shared/reconnect-alarm.ts"), "utf8")
  .match(/export const RECONNECT_ALARM = "([^"]+)"/)[1];

test("the firefox boot does not arm session automations and chrome still does", async () => {
  assert.notEqual(RECONNECT_ALARM, AUTOMATION_SCHEDULER_ALARM);
  assert.equal(sessionAutomationsEnabled({}), true);
  assert.equal(sessionAutomationsEnabled({ qzSessionAutomationsEnabled: false }), false);

  const armed = [];
  let listed = 0;
  const chromeRuntime = createAutomationRuntime({
    repository: { async listDefinitions() { listed += 1; return []; } },
    sessions: { async create() { throw new Error("created"); }, getRuntime() { return {}; }, async getConversation() { return []; } },
    alarms: {
      async get() { return null; },
      async create(name) { armed.push(name); },
    },
    ready: async () => {},
    logger: { warn() {}, debug() {} },
  });
  assert.equal(await chromeRuntime.start(), true);
  await chromeRuntime.flush();
  assert.deepEqual(armed, [AUTOMATION_SCHEDULER_ALARM]);
  assert.equal(listed, 1);
  assert.equal(chromeRuntime.handleAlarm({ name: RECONNECT_ALARM }), false);

  const previous = globalThis.chrome;
  globalThis.chrome = { qzSessionAutomationsEnabled: false };
  let disabled;
  try {
    disabled = createAutomationRuntime({
      repository: { listDefinitions() { throw new Error("listed stored automations"); } },
      sessions: { create() { throw new Error("started a stored automation"); } },
      alarms: { create() { throw new Error("armed the scheduler"); } },
    });
  } finally {
    globalThis.chrome = previous;
  }
  assert.equal(await disabled.start(), false);
  assert.equal(disabled.handleAlarm({ name: AUTOMATION_SCHEDULER_ALARM }), false);
  assert.equal(disabled.handleAlarm({ name: RECONNECT_ALARM }), false);
  assert.equal(await disabled.syncSessionOutcome("session"), false);
  assert.equal(disabled.consumeNotificationSession("qz_auto"), "");
  await assert.rejects(disabled.run("stored"), error => error.code === "AUTOMATION_DISABLED");
  await assert.rejects(disabled.list(), error => error.code === "AUTOMATION_DISABLED");

  const created = [];
  const cleared = [];
  const browser = {
    alarms: {
      create(name, info) { created.push({ name, info }); return Promise.resolve(); },
      clear(name) { cleared.push(name); return Promise.resolve(true); },
    },
    runtime: { id: "qz-browser-agent@heleifz.github.io", getURL: path => `moz-extension://uuid/${path}` },
  };
  installFirefoxHost(browser);
  assert.equal(browser.qzSessionAutomationsEnabled, false);
  assert.equal(browser.qzFirefoxMcpWake, true);
  assert.deepEqual(cleared, [AUTOMATION_SCHEDULER_ALARM]);
  await browser.alarms.create(AUTOMATION_SCHEDULER_ALARM, { periodInMinutes: 1 });
  await browser.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  assert.deepEqual(created, [{ name: RECONNECT_ALARM, info: { periodInMinutes: 0.5 } }]);
});

test("the firefox sidebar drops automation controls and the chrome source keeps them", () => {
  const sessions = readFileSync(join(repoRoot, "src/capabilities/sessions/ui.html"), "utf8");
  assert.match(sessions, /data-sessions-mode="automation"/);
  assert.match(sessions, /id="btn-new-automation"/);
  assert.match(sessions, /id="automations-panel"/);
  const page = `<head></head><body>${sessions}<script type="module" src="sidepanel.js"></script></body>`;
  const firefox = rewriteFirefoxSidepanelHtml(page);
  assert.match(firefox, /src="firefox-boot\.js"/);
  assert.match(firefox, /href="firefox-sidebar\.css"/);
  assert.equal(firefox.includes('data-sessions-mode="automation"'), false);
  assert.equal(firefox.includes("btn-new-automation"), false);
  assert.equal(firefox.includes('id="automations-panel"'), false);
  assert.equal(firefox.includes('id="automation-editor"'), false);
  assert.match(firefox, /data-sessions-mode="manual"/);
  assert.match(firefox, /id="sessions-search"/);
  assert.match(firefox, /id="sessions-list"/);
  assert.match(firefox, /id="artifacts-panel"/);
  assert.match(readFileSync(join(repoRoot, "src/capabilities/sessions/ui.html"), "utf8"), /data-sessions-mode="automation"/);

  const nodes = Object.fromEntries(["[data-sessions-mode=\"automation\"]", "#btn-new-automation", "#automations-panel"].map(selector => {
    const node = { removed: false, remove() { node.removed = true; } };
    return [selector, node];
  }));
  const root = { querySelector: selector => nodes[selector] || null };
  const panel = { qzSessionAutomationsEnabled: true };
  installSidepanelFirefoxHost(panel, undefined, root);
  assert.equal(panel.qzSessionAutomationsEnabled, false);
  assert.equal(nodes["[data-sessions-mode=\"automation\"]"].removed, true);
  assert.equal(nodes["#btn-new-automation"].removed, true);
  assert.equal(nodes["#automations-panel"].removed, true);
  removeSessionAutomationControls(root);
  assert.equal(nodes["#automations-panel"].removed, true);
});

test("firefox manage_sessions refuses automation actions and chrome still accepts them", async () => {
  const calls = [];
  function host() {
    const definitions = new Map();
    registerSessionTools({
      registerTool: ({ name, description, parameters, execute }) => definitions.set(name, { description, parameters, execute }),
      ToolExecutionError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
      secondsToMs: value => value * 1000,
      getToolRuntimeDependencies: () => ({ sessions: {
        saveAutomation: async args => { calls.push(args); return { automation: args.automation }; },
        runAutomation: async () => { throw new Error("ran"); },
      } }),
    });
    return definitions.get("manage_sessions");
  }

  const enabled = host();
  assert.equal(enabled.parameters.properties.action.enum.includes("create_automation"), true);
  assert.match(enabled.description, /create_automation/);
  const context = { sessionId: "parent", runId: "run", toolCallId: "call" };
  const created = await enabled.execute({
    action: "create_automation", title: "Collect", instruction: "Save rows",
  }, null, context);
  assert.equal(created.created, true);
  assert.equal(calls.length, 1);

  const previous = globalThis.chrome;
  globalThis.chrome = { qzSessionAutomationsEnabled: false };
  let disabled;
  let refused;
  try {
    disabled = host();
    refused = disabled.execute({
      action: "run_automation", automationId: "stored",
    }, null, context);
  } finally {
    globalThis.chrome = previous;
  }
  assert.equal(disabled.parameters.properties.action.enum.includes("create_automation"), false);
  assert.equal(disabled.parameters.properties.action.enum.includes("run_automation"), false);
  assert.equal(disabled.description.includes("create_automation"), false);
  const result = await refused;
  assert.equal(result.code, "AUTOMATION_DISABLED");
  assert.match(result.error, /Firefox/);
  assert.equal(calls.length, 1);
});

test("a disabled task list stays on ordinary tasks and an enabled list can show automations", () => {
  const root = { querySelector() { return null; }, querySelectorAll() { return []; } };
  const base = {
    root,
    request: async () => ({}),
    sessionState: {},
    artifactsFeature: {},
    sessionExportFeature: { exportSession: async () => {}, isPreparing: () => false },
  };
  const firefox = createSessionsFeature({ ...base, automationsEnabled: false, initialMode: "automation" });
  assert.equal(firefox.getMode(), "manual");
  assert.equal(firefox.setMode("automation"), false);
  assert.equal(firefox.getMode(), "manual");
  const chrome = createSessionsFeature({ ...base, automationsEnabled: true, initialMode: "automation" });
  assert.equal(chrome.getMode(), "automation");
});

test("the firefox prompt says scheduled tasks are unavailable and the chrome prompt does not gain that sentence", () => {
  assert.equal(sessionAutomationPromptSuffix("en"), "");
  assert.equal(getAgentPrompts("en").SYSTEM_PROMPT.includes("Session automations are unavailable"), false);
  assert.equal(getAgentPrompts("zh-CN").SYSTEM_PROMPT.includes("本 Firefox 包不提供定时任务"), false);
  const previous = globalThis.chrome;
  globalThis.chrome = { qzSessionAutomationsEnabled: false };
  try {
    assert.match(sessionAutomationPromptSuffix("en"), /Session automations are unavailable/);
    assert.match(sessionAutomationPromptSuffix("zh-CN"), /定时任务/);
  } finally {
    globalThis.chrome = previous;
  }
  assert.equal(sessionAutomationPromptSuffix("en"), "");
  const agent = readFileSync(join(repoRoot, "src/background/agent/agent.ts"), "utf8");
  assert.match(agent, /sessionAutomationPromptSuffix\(language\)/);
});
