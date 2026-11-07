import assert from "node:assert/strict";
import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import {
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import {
  commitSkillToolRegistryCandidate,
  executeSkillTool,
  getActiveSkillToolSchemasSync,
  prepareSkillToolRegistryFromSkills,
} from "../../src/background/skills/skill-tool-runtime.js";

const manifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "runtime-example",
  displayName: "Runtime Example",
  settings: {
    fields: [
      { key: "endpoint", type: "url", required: true },
      { key: "token", type: "secret", required: true },
    ],
  },
  network: {
    allowedOrigins: [{ setting: "endpoint" }],
    allowedMethods: ["GET"],
  },
  tools: [
    {
      name: "inner_query",
      title: "Inner query",
      runtime: "inner",
      script: "scripts/runtime.js",
      parameters: { type: "object", properties: { value: { type: "string" }, tabId: { type: "string", description: "External record tabId" } } },
    },
    {
      name: "page_check",
      title: "Page check",
      runtime: "page",
      script: "scripts/runtime.js",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "script_query",
      runtime: "script",
      script: "scripts/runtime.js",
      parameters: { type: "object", properties: { tabRef: { type: ["integer", "string"] } }, required: ["tabRef"] },
    },
    { name: "legacy_page", script: "scripts/runtime.js" },
  ],
};

const storedSkill = {
  name: "runtime-example-skill",
  displayName: "Runtime Example Skill",
  description: "runtime contract",
  scope: "resident",
  format: QINGZHOU_SKILL_FORMAT,
  schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: "plugin.json", type: "json", content: JSON.stringify(manifest) },
    { path: "scripts/runtime.js", type: "script", content: "async () => ({ ok: true })" },
  ],
};
globalThis.chrome = { storage: { local: { async get() { return { _skills: { "runtime-example-skill": storedSkill } }; }, async set() {} } } };
commitSkillToolRegistryCandidate(prepareSkillToolRegistryFromSkills([storedSkill]));

const schemas = getActiveSkillToolSchemasSync({ language: "zh-CN" });
const innerSchema = schemas.find(item => item.function.name === "runtime_example__inner_query");
assert.ok(innerSchema);
assert.deepEqual(innerSchema.function.parameters.properties.tabId, manifest.tools[0].parameters.properties.tabId);
assert.equal(Object.hasOwn(innerSchema.function.parameters.properties, "tabRef"), false);
assert.match(innerSchema.function.description, /脚本在页面外执行[\s\S]*显式传 tabRef[\s\S]*DOM 求值使用 tools\.evaluate/);
assert.doesNotMatch(innerSchema.function.description, /内部 Worker|\$plugin|runtime:/);
const pageSchema = schemas.find(item => item.function.name === "runtime_example__page_check");
assert.ok(pageSchema.function.parameters.required.includes("tabRef"), "page Skill tools require an explicit public page reference");

const configCalls = [];
const dispatches = [];
const skillSettings = {
  async getExecutionConfig(_plugin, options) {
    configCalls.push(options);
    return options.includeSecrets
      ? { endpoint: "https://api.example.test", token: "private-token" }
      : { endpoint: "https://api.example.test" };
  },
};
const dispatch = async (name, args, signal, context) => {
  dispatches.push({ name, args, signal, context });
  return { ok: true, result: { executed: true } };
};

const innerResult = await executeSkillTool(
  "runtime_example__inner_query",
  { timeout: 20, value: "hello", tabId: "business-record" },
  null,
  { sessionId: "session-1" },
  dispatch,
  { skillSettings },
);
assert.equal(configCalls[0].includeSecrets, true);
assert.equal(dispatches[0].name, "run_skill_script");
assert.equal(dispatches[0].args.target, "inner");
assert.equal(Object.hasOwn(dispatches[0].args, "tabId"), false);
assert.equal(dispatches[0].args.args.value, "hello");
assert.equal(dispatches[0].args.args.tabId, "business-record", "a non-page Skill field is not a page control");
assert.deepEqual(dispatches[0].args.args.$plugin.config, {
  endpoint: "https://api.example.test",
  token: "private-token",
});
assert.equal(dispatches[0].context.skillExecution.plugin.id, "runtime-example");
assert.equal(dispatches[0].context.skillExecution.config.token, "private-token");
assert.equal(getToolResultPresentation(innerResult)._plugin.runtime, "inner");
assert.deepEqual(innerResult, { ok: true, result: { executed: true } }, "internal execution settings do not wrap the public business result");

await executeSkillTool(
  "runtime_example__page_check",
  { timeout: 10, tabId: 42 },
  null,
  { sessionId: "session-1" },
  dispatch,
  { skillSettings },
);
assert.equal(configCalls[1].includeSecrets, false);
assert.equal(dispatches[1].args.tabId, 42);
assert.equal(Object.hasOwn(dispatches[1].args, "target"), false);
assert.deepEqual(dispatches[1].args.args.$plugin.config, { endpoint: "https://api.example.test" });
assert.equal(Object.hasOwn(dispatches[1].context, "skillExecution"), false);

const scriptSchema = schemas.find(item => item.function.name === "runtime_example__script_query");
assert.deepEqual(scriptSchema.function.parameters.required, ["tabRef"]);
await executeSkillTool("runtime_example__script_query", { timeout: 10, tabRef: "research" }, null,
  { sessionId: "session-1" }, dispatch, { skillSettings });
assert.equal(configCalls[2].includeSecrets, true);
assert.equal(dispatches[2].name, "run_script", "new Skill scripts share the public executor");
assert.equal(dispatches[2].args.target, undefined);
assert.equal(dispatches[2].args.tabId, undefined, "outer scripts do not inherit a page execution context");
assert.equal(dispatches[2].args.args.tabRef, "research", "the caller's alias reaches the script unchanged");
assert.equal(dispatches[2].context.skillExecution.config.token, "private-token");
assert.equal(dispatches[2].context.skillExecution.resultMode, "receipt");

const legacySchema = schemas.find(item => item.function.name === "runtime_example__legacy_page");
assert.ok(legacySchema.function.parameters.required.includes("tabRef"));
await executeSkillTool("runtime_example__legacy_page", { timeout: 10, tabId: 42 }, null,
  { sessionId: "session-1" }, dispatch, { skillSettings });
assert.equal(configCalls[3].includeSecrets, false);
assert.equal(dispatches[3].args.target, undefined, "an omitted runtime keeps installed page scripts on their original runner");
assert.equal(dispatches[3].args.tabId, 42);
assert.equal(dispatches[3].context.skillExecution, undefined);

await assert.rejects(
  executeSkillTool(
    "runtime_example__inner_query",
    { timeout: 10 },
    null,
    {},
    dispatch,
  ),
  error => error?.code === "SKILL_SETTINGS_UNAVAILABLE",
);

console.log("plugin inner runtime tests passed");
