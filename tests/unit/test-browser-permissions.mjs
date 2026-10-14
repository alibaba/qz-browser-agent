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
    execute: (name = "__permission_probe", args = {}) => runtime.execute(name, args, controller.signal, context),
    wait: () => events.findLast(event => event.type === "waiting_for_user" && event.sessionId === sessionId),
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
const heldTask = held.execute();
const heldCard = await waitFor(held);
await assert.rejects(held.execute(), error => error.code === "BROWSER_PERMISSION_REQUIRED");
assert.equal(supervisor.isWaitingForUser(held.context.sessionId), true, "another request must preserve the existing wait");
const independent = await fixture();
const independentTask = independent.execute();
const independentCard = await waitFor(independent);
settle(independentCard, true);
await independentTask;
assert.equal(supervisor.isWaitingForUser(held.context.sessionId), true, "each Session owns its approval");
settle(heldCard, true);
await heldTask;
console.log("Browser permission boundaries: grant, denial, revocation, retry, cancellation and lazy APIs passed");
