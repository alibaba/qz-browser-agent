import assert from "node:assert/strict";
import test from "node:test";
import { registerWaitTools } from "../../src/capabilities/wait/tools.js";

function createHarness(beginUserWait) {
  const definitions = new Map();
  const events = [];
  registerWaitTools({
    registerTool: definition => definitions.set(definition.name, definition),
    getToolRuntimeDependencies: () => ({
      emit: event => events.push(event),
      sessions: {
        beginUserWait,
        resolveUserWait() {}, rejectUserWait() {}, isWaitingForUser() {},
      },
    }),
  });
  return { tool: definitions.get("ask_user"), events };
}

test("result cards retain stable values and use the existing user-wait lifecycle", async () => {
  const signal = new AbortController().signal;
  const deferred = Promise.withResolvers();
  let wait;
  const { tool, events } = createHarness((sessionId, options) => {
    wait = { sessionId, ...options };
    return deferred.promise;
  });
  const pending = tool.execute({ message: "Choose roles to research", submitLabel: "Research selected roles", fields: [{
    id: "roles", label: "Roles", type: "multi_choice", presentation: "cards", defaultValues: ["role-b"],
    options: [
      { label: " Backend engineer ", value: "role-a", description: " Rust services ", meta: [" Remote ", "EU"], url: "https://example.com/jobs/a", imageUrl: "https://example.com/logo.png" },
      { label: "Platform engineer", value: "role-b", description: "Infrastructure" },
    ],
  }] }, signal, { sessionId: "selection-session", runId: "selection-run" });

  assert.equal(tool.timeout, 0);
  assert.equal(tool.parameters["x-disableCommonTimeout"], true);
  assert.equal(wait.sessionId, "selection-session");
  assert.equal(wait.runId, "selection-run");
  assert.equal(wait.signal, signal);
  assert.equal(events[0].waitId, wait.waitId);
  const field = events[0].form.fields[0];
  assert.equal(field.presentation, "cards");
  assert.deepEqual(field.defaultValue, ["role-b"]);
  assert.deepEqual(field.options[0], {
    label: "Backend engineer", value: "role-a", description: "Rust services",
    meta: ["Remote", "EU"], url: "https://example.com/jobs/a", imageUrl: "https://example.com/logo.png",
  });
  assert.deepEqual(field.options[1], { label: "Platform engineer", value: "role-b", description: "Infrastructure" });

  wait.onSettled("submitted");
  deferred.resolve({ submitted: true, reason: "submitted", answers: { roles: ["role-b"] } });
  assert.deepEqual(await pending, { submitted: true, reason: "submitted", answers: { roles: ["role-b"] } });
  assert.deepEqual(events[1], {
    type: "user_wait_resolved", sessionId: "selection-session", runId: "selection-run", waitId: wait.waitId, reason: "submitted",
  });
});

test("card presentation bounds visible metadata and excludes unsafe URLs without changing option IDs", async () => {
  const stableId = "candidate-" + "x".repeat(300);
  const { tool, events } = createHarness(async () => ({ submitted: false, reason: "cancelled", answers: {} }));
  const result = await tool.execute({ message: "Select", fields: [{
    id: "candidates", label: "Candidates", type: "single_choice", presentation: "cards", defaultValue: stableId,
    options: [
      { value: stableId, label: "A".repeat(400), description: "D".repeat(1200), meta: [null, {}, "", ...Array(8).fill("M".repeat(100))], url: "javascript:alert(1)", imageUrl: "data:image/svg+xml,<svg/>" },
      { value: "credentials", label: "Credentials", url: "https://user:password@example.com/private", imageUrl: "https://user@example.com/image.png" },
      { value: "oversized", label: "Oversized URL", url: "https://example.com/" + "a".repeat(4096), meta: { a: "ignored" } },
    ],
  }] }, undefined, { sessionId: "selection-session", runId: "selection-run" });
  const field = events[0].form.fields[0];
  assert.equal(field.defaultValue, stableId);
  assert.equal(field.options[0].value, stableId);
  assert.equal(field.options[0].label.length, 240);
  assert.equal(field.options[0].description.length, 1000);
  assert.deepEqual(field.options[0].meta, Array(6).fill("M".repeat(80)));
  for (const option of field.options) {
    assert.equal(Object.hasOwn(option, "url"), false);
    assert.equal(Object.hasOwn(option, "imageUrl"), false);
  }
  assert.equal(Object.hasOwn(field.options[2], "meta"), false);
  assert.deepEqual(result, { submitted: false, reason: "cancelled", answers: {} });
});

test("oversized card lists fail before waiting while ordinary choice fields retain their format", async () => {
  let waits = 0;
  const { tool, events } = createHarness(async () => { waits += 1; return { answers: {} }; });
  const options = Array.from({ length: 51 }, (_, index) => ({ label: `Role ${index}`, value: `role-${index}` }));
  await assert.rejects(tool.execute({ message: "Select", fields: [{ id: "roles", type: "multi_choice", presentation: "cards", options }] }), error => {
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.deepEqual(error.details, { fieldId: "roles", maxOptions: 50 });
    return true;
  });
  assert.equal(waits, 0);
  assert.equal(events.length, 0);

  await tool.execute({ message: "Ordinary fields", fields: [
    { id: "roles", type: "multi_choice", options },
    { id: "notes", type: "text", presentation: "cards", defaultValue: "Notes" },
    { id: "empty", type: "single_choice", presentation: "cards", options: [] },
    { id: "plain", type: "single_choice", options: [{ label: "P".repeat(400), value: "stable", description: "D".repeat(1200), meta: ["ignored"], url: "https://example.com/" }] },
  ] });
  const [roles, notes, empty, plain] = events[0].form.fields;
  assert.equal(waits, 1);
  assert.equal(roles.options.length, 51);
  for (const field of [roles, notes, empty, plain]) assert.equal(Object.hasOwn(field, "presentation"), false);
  assert.equal(empty.type, "text");
  assert.deepEqual(plain.options, [{ label: "P".repeat(400), value: "stable", description: "D".repeat(1200) }]);
});
