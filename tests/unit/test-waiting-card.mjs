import assert from "node:assert/strict";
import { test } from "node:test";
import { isWaitingTranscriptActive, normalizeWaitingForm } from "../../src/sidepanel/features/chat/transcript/waiting-card.js";
import { createSessionUserInput } from "../../src/background/session/user-input.js";

test("historical and malformed form payloads normalize at the boundary", () => {
  for (const input of [null, [], true, 4, "legacy", { fields: {} }]) {
    assert.deepEqual(normalizeWaitingForm(input), { title: "", submitLabel: "提交", fields: [] });
  }
  const form = normalizeWaitingForm({ fields: [
    null, { id: "fallback", type: "single_choice", options: [] },
    { id: "unknown", type: "unrecognized", required: false, defaultValue: 42 },
    { id: " ", label: "ignored" },
  ] });
  assert.deepEqual(form.fields.map(field => [field.id, field.type, field.defaultValue, field.required]), [
    ["field_1", "text", "", true], ["fallback", "text", "", true], ["unknown", "text", "42", false],
  ]);
});

test("choice defaults stay scalar or plural and all historical aliases keep their priority", () => {
  const fields = normalizeWaitingForm({ fields: [
    { type: "single_choice", options: ["a", { label: "B", value: "b" }], defaultValue: " b ", default: "a" },
    { type: "multi_choice", options: ["a", "b"], defaultValues: [" a ", "", "b"] },
    { type: "multi_choice", options: ["a"], value: "a" },
    { type: "textarea", default: " old value " },
    { type: "text", defaultValue: null, default: "must not override explicit null" },
  ] }).fields;
  assert.equal(fields[0].defaultValue, " b ");
  assert.deepEqual(fields[1].defaultValue, [" a ", "b"]);
  assert.deepEqual(fields[2].defaultValue, ["a"]);
  assert.equal(fields[3].defaultValue, "old value");
  assert.equal(fields[4].defaultValue, "");
});

test("choice values and matching defaults retain whitespace through live form validation", async () => {
  const options = [{ label: " Europe ", value: " Europe " }, { label: "Europe (exact)", value: "Europe" }];
  const form = { fields: [
    { id: "region", type: "single_choice", required: true, options, defaultValue: " Europe " },
    { id: "regions", type: "multi_choice", required: true, presentation: "cards", options, defaultValues: [" Europe ", "Europe"] },
  ] };
  const fields = normalizeWaitingForm(form).fields;
  assert.equal(fields[0].options[0].label, "Europe");
  assert.deepEqual(fields[0].options.map(option => option.value), [" Europe ", "Europe"]);
  assert.equal(fields[0].options.find(option => option.value === fields[0].defaultValue)?.value, " Europe ");
  assert.deepEqual(fields[1].options.filter(option => fields[1].defaultValue.includes(option.value)).map(option => option.value), [" Europe ", "Europe"]);
  assert.equal(normalizeWaitingForm({ fields: [{ type: "single_choice", options: [" Europe "], default: " Europe " }] }).fields[0].options[0].value, " Europe ");

  const wait = { sessionId: "s", waitId: "w", runId: "r" };
  const resolved = [];
  const api = createSessionUserInput({
    getWait: () => wait, getRuntime: () => ({ ...wait, waitForm: form }),
    resolve: result => { resolved.push(result); return true; }, reject: () => false,
    hasBrowserPermission: async () => false,
    locationConsent: { isAccepted: async () => false, acceptExternal: async () => {} },
  });
  const missing = await api.respond({ ...wait, action: "submit", answers: { region: "", regions: [] } });
  assert.deepEqual(missing.fieldErrors.map(error => [error.fieldId, error.code]), [["region", "REQUIRED"], ["regions", "REQUIRED"]]);
  assert.equal(resolved.length, 0);
  const answers = Object.fromEntries(fields.map(field => [field.id, field.defaultValue]));
  assert.equal((await api.respond({ ...wait, action: "submit", answers })).accepted, true);
  assert.deepEqual(resolved[0].payload.answers, { region: " Europe ", regions: [" Europe ", "Europe"] });
});

test("only waiting and legacy empty status are active", () => {
  for (const entry of [{}, { status: "" }, { status: "waiting" }, null]) assert.equal(isWaitingTranscriptActive(entry), true);
  for (const status of ["submitted", "cancelled", "aborted", "superseded", "stale", "unknown-terminal"]) {
    assert.equal(isWaitingTranscriptActive({ status }), false);
  }
});

test("card choice metadata survives restored waits without changing ordinary choices", () => {
  const [cards, ordinary] = normalizeWaitingForm({ fields: [
    { id: "jobs", type: "multi_choice", presentation: "cards", defaultValues: ["job-1"], options: [
      { value: "job-1", label: "Backend engineer", description: "Distributed systems", meta: ["Remote", 2, "EU"], imageUrl: "https://example.com/logo.png", url: "https://example.com/jobs/1" },
    ] },
    { id: "mode", type: "single_choice", presentation: "unknown", options: ["a"] },
  ] }).fields;
  assert.equal(cards.presentation, "cards");
  assert.deepEqual(cards.defaultValue, ["job-1"]);
  assert.deepEqual(cards.options[0], { value: "job-1", label: "Backend engineer", description: "Distributed systems", meta: ["Remote", "EU"], imageUrl: "https://example.com/logo.png", url: "https://example.com/jobs/1" });
  assert.equal(ordinary.presentation, undefined);
});
