import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import assert from "node:assert/strict";
import { SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from "../../src/shared/skills/skill-manifest.js";
import { QINGZHOU_SKILL_FORMAT, QINGZHOU_SKILL_SCHEMA_VERSION } from "../../src/shared/skills/skill-utils.js";
import { enrichSkillToolIdentity, setSkillToolUiCatalog } from "../../src/sidepanel/tools/skill-tool-ui-registry.js";
import { normalizeToolIdentitySnapshot, toolIdentityEventFields } from "../../src/shared/tools/tool-identity.js";

globalThis.chrome = { storage: { local: { async get() { return {}; } } } };
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
const declarations = [
  { name: "table", rendererId: " table " },
  { name: "unavailable", rendererId: "unavailable-extension" },
  { name: "legacy", renderer: { type: "table", sourcePath: "rows" } },
  { name: "invalid", rendererId: { code: "untrusted" } },
];
const manifest = {
  format: SKILL_MANIFEST_FORMAT, schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION, id: "renderer-contract", version: "1.0.0",
  tools: declarations.map(tool => ({ ...tool, description: tool.name, runtime: "inner", script: `scripts/${tool.name}.js`, parameters: { type: "object", properties: {} } })),
};
const candidate = runtime.prepareSkillToolRegistryFromSkills([{
  name: "renderer-contract", description: "Renderer contract", content: "", scope: "resident", status: "active",
  format: QINGZHOU_SKILL_FORMAT, schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: "plugin.json", type: "json", content: JSON.stringify(manifest) },
    ...declarations.map(tool => ({ path: `scripts/${tool.name}.js`, type: "script", content: "return { rows: [] };" })),
  ],
}]);
assert.equal(candidate.plugins.length, 1, JSON.stringify(candidate.diagnostics));
runtime.commitSkillToolRegistryCandidate(candidate);
const catalog = await runtime.listSkillContributions();
setSkillToolUiCatalog(catalog);
for (const declaration of declarations) {
  const tool = candidate.plugins[0].tools.find(tool => tool.localName === declaration.name);
  assert.ok(tool);
  const expected = typeof declaration.rendererId === "string" ? declaration.rendererId.trim() : undefined;
  assert.equal(tool.rendererId, expected, "normalization preserves only a renderer identifier");
  assert.equal(catalog.plugins[0].tools.find(item => item.name === tool.name).rendererId, expected);
  const result = await runtime.executeSkillTool(tool.name, { timeout: 5 }, undefined, {}, async (name, _args, _signal, context) => {
    assert.equal(name, "run_skill_script");
    assert.equal(context.skillToolName, tool.name);
    return { result: { rows: [] } };
  });
  assert.equal(getToolResultPresentation(result)._plugin.rendererId, expected);
  assert.deepEqual(result, { result: { rows: [] } }, "renderer identity stays outside script data");
  assert.equal(enrichSkillToolIdentity({ name: tool.name, result: { ...result, ...getToolResultPresentation(result) } }).rendererId, expected || "");
  const fields = toolIdentityEventFields(tool);
  assert.equal(normalizeToolIdentitySnapshot({}, fields).rendererId, expected, "event persistence keeps the same trusted registry reference");
  if (!expected) assert.equal(Object.hasOwn(getToolResultPresentation(result)._plugin, "rendererId"), false, "old or malformed declarations do not gain an empty field");
}
assert.equal(candidate.plugins[0].tools.find(tool => tool.localName === "legacy").renderer.type, "table");
assert.equal(candidate.plugins[0].tools.find(tool => tool.localName === "legacy").renderer.sourcePath, "rows");
setSkillToolUiCatalog({});
console.log("plugin renderer identity pipeline tests passed");
