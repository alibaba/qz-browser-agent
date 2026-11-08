import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";

const manifest = JSON.parse(await readFile(new URL("../../src/manifest.json", import.meta.url)));
assert.ok(manifest.permissions.includes("geolocation"));
assert.ok(manifest.permissions.includes("downloads"));
assert.deepEqual(manifest.optional_permissions.toSorted(), ["bookmarks", "desktopCapture", "downloads.open", "history"]);
assert.ok(manifest.optional_permissions.every(permission => !manifest.permissions.includes(permission)));
const grants = new Set();
globalThis.chrome = {
  permissions: { contains: async ({ permissions }) => permissions.every(p => grants.has(p)) },
  runtime: { getURL: path => `chrome-extension://test/${path}`, lastError: null },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
};
// Optional API namespaces become available only after tool registration.
const tools = await import("../../src/background/tools/runtime.js");
let executions = 0;
tools.defineTool({ name: "__permission_probe", description: "Permission timeout probe", requires: { browserPermission: "history" },
  parameters: { type: "object", properties: {} }, timeout: 10, execute: () => ++executions });
const events = [];
const supervisor = createSessionSupervisor({ createAgent: () => ({ subscribe(emit) { this.emit = emit; } }) });
const runtime = tools.createToolRuntime({ sessions: supervisor, emit: event => events.push(event) });
async function fixture(sessionId = crypto.randomUUID()) {
  const agent = await supervisor.getAgent(sessionId);
  const runId = crypto.randomUUID();
  agent.emit({ type: "agent_start", runId });
  const controller = new AbortController();
  const context = { sessionId, runId, language: "en" };
  return { context, controller,
    execute: (name = "__permission_probe", args = {}, signal = controller.signal) => runtime.execute(name, args, signal, context),
    wait: () => events.findLast(event => event.type === "waiting_for_user" && event.sessionId === sessionId && event.runId === runId),
  };
}
async function waitFor(f) {
  for (let n = 0; n < 100; n++) { if (f.wait()) return f.wait(); await delay(1); }
  assert.fail("permission card was not emitted");
}
function settle(wait, granted) {
  if (granted) grants.add(wait.form.browserPermission);
  supervisor.resolveUserWait(wait);
}

const first = await fixture();
const pending = first.execute();
const wait = await waitFor(first);
assert.equal(wait.form.browserPermission, "history");
await delay(25);
assert.equal(executions, 0, "waiting must neither execute nor consume the 10ms tool deadline");
settle(wait, true);
assert.equal(await pending, 1);
assert.equal(supervisor.isWaitingForUser(first.context.sessionId), false);
assert.equal(events.at(-1).type, "user_wait_resolved");
const eventCount = events.length;
assert.equal(await first.execute(), 2);
assert.equal(events.length, eventCount, "existing grants skip the card");

for (const [name, permission, args] of [
  ["manage_bookmarks", "bookmarks", { action: "list" }],
  ["browse_history", "history", { action: "recent" }],
]) {
  grants.delete(permission);
  const f = await fixture();
  const task = f.execute(name, args);
  const card = await waitFor(f);
  chrome.bookmarks = { getTree: async () => [{ id: "1", title: "Saved", url: "https://example.com" }] };
  chrome.history = { search: async () => [{ id: "2", title: "Visited", url: "https://example.com" }] };
  settle(card, true);
  assert.equal((await task).length, 1, "grant takes effect without reloading the runtime");
}

for (const action of ["ungranted", "cancel", "abort", "revoke"]) {
  grants.delete("history");
  const f = await fixture();
  const task = f.execute();
  const expected = { ungranted: "BROWSER_PERMISSION_DENIED", cancel: "USER_CANCELLED_WAIT", abort: "OPERATION_ABORTED", revoke: "OPERATION_ABORTED" }[action];
  const rejected = assert.rejects(task, error => error.code === expected);
  const card = await waitFor(f);
  if (action === "ungranted") settle(card, false);
  if (action === "cancel") supervisor.rejectUserWait(card);
  if (action === "abort") f.controller.abort();
  if (action === "revoke") await supervisor.revoke(f.context.sessionId);
  await rejected;
  assert.equal(supervisor.isWaitingForUser(f.context.sessionId), false);
  assert.equal(supervisor.resolveUserWait(card), false, "late approval cannot revive a settled wait");
}
assert.equal(executions, 2, "denied, aborted and stale requests never run");

const retry = await fixture();
const retryTask = retry.execute();
settle(await waitFor(retry), true);
assert.equal(await retryTask, 3);
grants.delete("history");
await assert.rejects(runtime.execute("__permission_probe", {}), error => error.code === "BROWSER_PERMISSION_REQUIRED");
const stale = await fixture();
await supervisor.revoke(stale.context.sessionId);
grants.add("history");
await assert.rejects(stale.execute(), error => error.code === "STALE_RUN");
assert.equal(executions, 3);
grants.delete("history");
const held = await fixture();
const executeFromFacade = () => tools.createToolRuntime({ sessions: { ...supervisor }, emit: event => events.push(event) })
  .execute("__permission_probe", {}, held.controller.signal, held.context);
const heldTask = executeFromFacade();
const heldCard = await waitFor(held);
const joinedTask = executeFromFacade();
grants.delete("bookmarks");
await assert.rejects(held.execute("manage_bookmarks", { action: "list" }), error => error.code === "BROWSER_PERMISSION_REQUIRED");
assert.equal(events.filter(event => event.type === "waiting_for_user" && event.sessionId === held.context.sessionId).length, 1,
  "per-call Session facades share one permission card; a different permission cannot replace it");
const independent = await fixture();
const independentTask = independent.execute();
const independentCard = await waitFor(independent);
settle(independentCard, true);
await independentTask;
assert.equal(supervisor.isWaitingForUser(held.context.sessionId), true, "each Session owns its approval");
settle(heldCard, true);
await Promise.all([heldTask, joinedTask]);

// Page-code access is a host requirement, so Chrome and non-page scripts never prompt.
let pageExecutions = 0;
tools.defineTool({ name: "__page_permission_probe", description: "Page script permission probe",
  requires: { pageScript: args => args.page !== false },
  parameters: { type: "object", properties: { page: { type: "boolean" } } },
  timeout: 10, execute: () => ++pageExecutions });
const chromePage = await fixture();
assert.equal(await chromePage.execute("__page_permission_probe"), 1);
assert.equal(chromePage.wait(), undefined);
chrome.runtime.getURL = path => `moz-extension://test/${path}`;
const nonPage = await fixture();
assert.equal(await nonPage.execute("__page_permission_probe", { page: false }), 2);
assert.equal(nonPage.wait(), undefined);

const firefoxPage = await fixture();
const firefoxPending = firefoxPage.execute("__page_permission_probe");
const firefoxCard = await waitFor(firefoxPage);
assert.equal(firefoxCard.form.browserPermission, "userScripts");
await delay(25);
assert.equal(pageExecutions, 2, "the userScript permission wait is outside the 10ms tool deadline");
settle(firefoxCard, true);
assert.equal(await firefoxPending, 3);
const grantedEvents = events.length;
assert.equal(await firefoxPage.execute("__page_permission_probe"), 4);
assert.equal(events.length, grantedEvents, "a new page operation reuses the browser's permission grant");

for (const action of ["ungranted", "cancel", "abort", "revoke"]) {
  grants.delete("userScripts");
  const f = await fixture();
  const task = f.execute("__page_permission_probe");
  const expected = { ungranted: "BROWSER_PERMISSION_DENIED", cancel: "USER_CANCELLED_WAIT", abort: "OPERATION_ABORTED", revoke: "OPERATION_ABORTED" }[action];
  const rejected = assert.rejects(task, error => error.code === expected);
  const card = await waitFor(f);
  assert.equal(card.form.browserPermission, "userScripts", "revoking a grant causes the next call to request it again");
  if (action === "ungranted") settle(card, false);
  if (action === "cancel") supervisor.rejectUserWait(card);
  if (action === "abort") f.controller.abort();
  if (action === "revoke") await supervisor.revoke(f.context.sessionId);
  await rejected;
  assert.equal(supervisor.resolveUserWait(card), false, "late approval never dispatches page code");
}
assert.equal(pageExecutions, 4);
await assert.rejects(runtime.execute("__page_permission_probe", {}), error => error.code === "BROWSER_PERMISSION_REQUIRED");

// A branch can leave a shared approval without cancelling siblings; the last branch owns cleanup.
for (const cancelLast of [false, true]) {
  grants.delete("userScripts");
  const f = await fixture();
  const firstTask = f.execute("__page_permission_probe");
  const firstRejected = assert.rejects(firstTask, { code: "OPERATION_ABORTED" });
  const card = await waitFor(f);
  const siblingController = new AbortController();
  const siblingTask = f.execute("__page_permission_probe", {}, siblingController.signal);
  const siblingResult = cancelLast ? assert.rejects(siblingTask, { code: "OPERATION_ABORTED" }) : siblingTask;
  await delay(0);
  f.controller.abort();
  await firstRejected;
  assert.equal(supervisor.isWaitingForUser(f.context.sessionId), true, "the first caller does not own a sibling's approval");
  if (cancelLast) siblingController.abort();
  else settle(card, true);
  await siblingResult;
  assert.equal(supervisor.isWaitingForUser(f.context.sessionId), false);
  assert.equal(supervisor.resolveUserWait(card), false);
}
assert.equal(pageExecutions, 5, "only the surviving granted branch executes");

grants.delete("userScripts");
const previousRun = await fixture();
const previousTask = previousRun.execute("__page_permission_probe");
const previousRejected = assert.rejects(previousTask, { code: "OPERATION_ABORTED" });
const previousCard = await waitFor(previousRun);
await supervisor.revoke(previousRun.context.sessionId);
await previousRejected;
const nextRun = await fixture(previousRun.context.sessionId);
const nextTask = nextRun.execute("__page_permission_probe");
const nextCard = await waitFor(nextRun);
assert.notEqual(nextCard.waitId, previousCard.waitId, "a new run owns a fresh permission wait");
assert.equal(supervisor.resolveUserWait(previousCard), false);
await assert.rejects(previousRun.execute("__page_permission_probe"), { code: "STALE_RUN" });
settle(nextCard, true);
await nextTask;
assert.equal(pageExecutions, 6);

for (const name of ["evaluate", "wait_for_function"]) assert.equal(tools.resolveToolDefinition(name).requires.pageScript, true, name);
assert.equal(tools.resolveToolDefinition("run_script").requires?.pageScript, undefined, "outer scripts request permission only if they evaluate page code");
const legacyPermission = tools.resolveToolDefinition("run_skill_script").requires.pageScript;
assert.equal(legacyPermission({}), true);
assert.equal(legacyPermission({ target: "page" }), true);
assert.equal(legacyPermission({ target: "inner" }), false);
for (const [runtimeKind, needsPage, expected] of [
  [undefined, undefined, true], ["page", true, true], ["page", false, undefined],
  ["script", false, undefined], ["inner", false, undefined], ["host", true, undefined],
]) {
  const tool = { name: "legacy__probe", script: "scripts/probe.js", runtime: runtimeKind, needsPage };
  const plugin = { id: "legacy", skillName: "legacy", renderers: { tools: {} } };
  const definition = tools.resolveToolDefinition(tool.name, { skillToolRegistrySnapshot: {
    plugins: [plugin], toolIndex: new Map([[tool.name, { plugin, tool }]]),
  } });
  assert.equal(definition.requires?.pageScript, expected, `Skill runtime=${runtimeKind}, needsPage=${needsPage}`);
}
console.log("Browser permission boundaries: grant, denial, revocation, retry, cancellation and lazy APIs passed");
