import assert from "node:assert/strict";
import test from "node:test";
import { createToolRuntimeDetails } from "../../src/sidepanel/tools/tool-runtime-details.js";
import { toolPresentationRegistry } from "../../src/sidepanel/tools/tool-presentation.js";
import { presentations } from "../../src/capabilities/script/presentation.js";
import { createScriptProfile } from "../../src/capabilities/script/profile.js";
import { resolveToolState } from "../../src/sidepanel/tools/tool-model.js";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { createSessionRecord, readSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";

const details = createToolRuntimeDetails({ genericRenderer: {} });

test("partial timeout results stay incomplete without masking running, errors or cancellation", () => {
  const result = { tabId: 1, status: "loading", loading: true, incomplete: { reason: "timeout", pending: "navigation commit" } };
  for (const name of ["open_tab", "navigate", "read_article", "find_elements"]) {
    const tool = { name, hasResult: true, phase: "done", result };
    assert.equal(resolveToolState(tool), "incomplete");
    assert.equal(details.project(tool).state, "incomplete");
    assert.equal(details.project(tool).status.tone, "incomplete");
    assert.equal(resolveToolState({ ...tool, isRunning: true }), "running");
    assert.equal(resolveToolState({ ...tool, isError: true }), "error");
    assert.equal(resolveToolState({ ...tool, phase: "aborted" }), "aborted");
    assert.equal(resolveToolState({ ...tool, result: { ...result, code: "TOOL_TIMEOUT", error: "Action not confirmed" } }), "error");
    assert.equal(resolveToolState({ ...tool, result: { status: "loading", loading: true } }), "success");
    assert.equal(resolveToolState({ ...tool, result: { ok: true, result } }), "success", "nested returned data is not runtime metadata");
    assert.equal(details.project({ ...tool, result: { status: "complete" } }).state, "completed");
  }
  for (const [language, title] of [["zh-CN", "未完成"], ["en", "Incomplete"]]) {
    withLanguage(language, () => assert.equal(details.project({ name: "open_tab", hasResult: true, result }).status.title, title));
  }
});

test("script successful outer envelopes preserve returned error-like data without masking execution failure", () => {
  const unregister = presentations({ pageDisplayTarget: () => "" }).map(definition => toolPresentationRegistry.register(definition));
  try {
    const tool = { name: "run_script", hasResult: true, args: {}, result: { ok: true, result: { ok: false, error: "business data" } } };
    assert.equal(details.project(tool).state, "completed");
    assert.equal(details.project({ ...tool, isError: true }).state, "error");
    assert.equal(details.project({ ...tool, phase: "aborted" }).state, "aborted");
    assert.equal(details.project({ ...tool, result: { ok: false, error: "execution failed" } }).state, "error");
    assert.equal(details.project({ ...tool, result: { result: { error: "unknown envelope" } } }).state, "completed");
    assert.equal(details.project({ ...tool, result: { ok: true, error: "contradictory failure", result: 1 } }).state, "error");
  } finally { unregister.forEach(dispose => dispose()); }
});

test("explicit execution success preserves error-shaped script values across card states", () => {
  const business = { ok: false, code: "TOOL_ABORTED", message: "Business status", error: "authored error", interrupted: true,
    result: { value: 7 }, _display: { script: { valueOnly: true, trace: ["authored trace"] } } };
  for (const name of ["run_script", "evaluate"]) {
    const tool = { name, hasResult: true, isError: false, result: business };
    assert.equal(resolveToolState(tool), "success", "header and timeline honor the execution event");
    assert.equal(details.project(tool).state, "completed", "details honor the same execution event");
    assert.equal(resolveToolState({ ...tool, isRunning: true }), "running");
    assert.equal(resolveToolState({ ...tool, phase: "aborted" }), "aborted");
    assert.equal(resolveToolState({ ...tool, isError: true, result: { code: "SCRIPT_EVALUATION_FAILED", message: "Failed" } }), "error");
  }
  assert.equal(resolveToolState({ name: "read_article", isError: false,
    result: { incomplete: { reason: "timeout", pending: "article content" } } }), "incomplete",
  "successful partial page receipts keep their observed timeout status");
});

test("script host envelopes preserve the exact returned value and type", () => {
  const rendered = [];
  const profile = createScriptProfile({ appendJsonCodeBlock: (_parent, _label, value) => rendered.push(value) });
  const values = [null, false, 0, "", '{"result":7}', ["value"],
    { ok: false, error: "business", result: { _display: "authored" }, _display: { script: { valueOnly: true } } }];
  for (const value of values) {
    const host = { result: value, _display: { script: { valueOnly: true, trace: [] } } };
    assert.equal(profile.render({}, {}, host, host), true);
    assert.equal(rendered.at(-1), value, "the renderer only unwraps the host-owned layer");
  }
});

test("session history retains explicit execution status and legacy missing status", () => {
  const result = { code: "SCRIPT_EVALUATION_FAILED", message: "Authored or historical value", error: "value" };
  const transcript = [
    { type: "tool", name: "run_script", result },
    { type: "tool", name: "run_script", result, isError: false },
    { type: "tool", name: "run_script", result, isError: true },
  ];
  const saved = createSessionRecord(serializeConversation([]), transcript);
  const restored = readSessionRecord(JSON.parse(JSON.stringify(saved))).transcript;
  assert.equal(Object.hasOwn(restored[0], "isError"), false, "missing historical status stays eligible for legacy recovery");
  assert.equal(restored[1].isError, false, "successful authored error fields keep the host's status after JSON persistence");
  assert.equal(restored[2].isError, true);
  assert.deepEqual(restored.map(resolveToolState), ["error", "success", "error"]);
});

test("an arbitrary renderer can declare result semantics and unregister back to the default", () => {
  const tool = { name: "ledger", rendererId: "ledger", hasResult: true, args: {}, result: { ok: true, result: { error: "not an execution failure" } } };
  const unregister = toolPresentationRegistry.register({ id: "ledger", resultIsError: () => false });
  assert.equal(details.project(tool).state, "completed");
  assert.equal(details.project({ ...tool, isError: true }).state, "error");
  unregister();
  assert.equal(details.project(tool).state, "error");
  const forceError = toolPresentationRegistry.register({ id: "ledger", resultIsError: () => true });
  assert.equal(details.project({ ...tool, result: { value: 3 } }).state, "error");
  forceError();
});

test("broken or asynchronous result interpreters fall back to the normal failure classifier", async () => {
  const tool = { name: "broken", hasResult: true, args: {}, result: { ok: true, result: { error: "failure" } } };
  for (const resultIsError of [() => { throw new Error("projection"); }, () => "false", async () => false, async () => { throw new Error("async"); }]) {
    const unregister = toolPresentationRegistry.register({ id: "broken", resultIsError });
    assert.equal(details.project(tool).state, "error");
    unregister();
    await Promise.resolve();
  }
});
