import assert from "node:assert/strict";
import test from "node:test";
import { discoverSkillManifests } from "../../src/shared/skills/skill-manifest.js";
import { createSkillSettingsService } from "../../src/background/skills/skill-settings.js";
import { enrichSkillToolIdentity, setSkillToolUiCatalog } from "../../src/sidepanel/tools/skill-tool-ui-registry.js";
import { appendErrorSection } from "../../src/sidepanel/tools/generic-result-renderer.js";

// Literal installed-package data deliberately does not derive its protocol from the current constants.
const installedSkill = {
  format: "qingzhou.skill", schemaVersion: 2, name: "research-kit", scope: "resident",
  resources: [{
    path: "plugin.json", type: "json", content: JSON.stringify({
      format: "qingzhou.plugin", schemaVersion: 1, id: "legacy-namespace",
      settings: { fields: [{ key: "endpoint", type: "url", required: true }] },
      tools: [{ name: "inspect", runtime: "inner", script: "scripts/inspect.js", rendererId: "plugin-script" }],
    }),
  }, { path: "scripts/inspect.js", type: "script", content: "async () => ({ ok: true })" }],
};

test("Skill naming retains the installed manifest format and namespace-based tool identity", () => {
  const { plugins, diagnostics } = discoverSkillManifests([installedSkill]);
  assert.deepEqual(diagnostics, []);
  assert.equal(plugins.length, 1);
  const manifest = plugins[0];
  assert.equal(manifest.skillName, "research-kit");
  assert.equal(manifest.id, "legacy-namespace");
  assert.equal(manifest.tools[0].name, "legacy_namespace__inspect");
  assert.equal(manifest.tools[0].pluginId, "legacy-namespace");
  assert.equal(manifest.tools[0].rendererId, "plugin-script");
});

test("page control migration preserves non-page fields, nested schemas, defaults and authored prose", () => {
  const schema = {
    type: "object", properties: {
      tabId: { type: "integer", minimum: 10, enum: [999], description: "Selected tabId" },
      payload: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] },
    }, required: ["tabId", "payload"],
    anyOf: [{ required: ["tabId"] }, false],
    allOf: [{ properties: { tabId: { type: "integer" } }, required: ["tabId"] }],
    oneOf: [{ anyOf: [{ required: ["tabId", "tabRef"] }] }, { type: "null" }, true],
    $defs: { record: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] } },
    default: { tabId: "authored default" },
  };
  const skill = structuredClone(installedSkill);
  const manifest = JSON.parse(skill.resources[0].content);
  manifest.tools = [
    { name: "page", runtime: "page" }, { name: "default_page" },
    { name: "host_page", runtime: "host", needsPage: true },
    { name: "no_page", runtime: "page", needsPage: false },
    { name: "host", runtime: "host" }, { name: "inner", runtime: "inner" },
  ].map(tool => ({ ...tool, script: "scripts/inspect.js", parameters: schema,
    description: "Return payload.tabId exactly as authored", args: { tabId: 999 } }));
  skill.resources[0].content = JSON.stringify(manifest);
  const before = JSON.stringify(skill);
  const discovered = discoverSkillManifests([skill]);
  assert.deepEqual(discovered.diagnostics, []);
  for (const tool of discovered.plugins[0].tools) {
    assert.equal(tool.description, "Return payload.tabId exactly as authored");
    assert.deepEqual(tool.args, { tabId: 999 });
    assert.deepEqual(tool.parameters.properties.payload, schema.properties.payload);
    assert.deepEqual(tool.parameters.$defs, schema.$defs);
    assert.deepEqual(tool.parameters.default, schema.default);
    if (tool.needsPage) {
      assert.equal(tool.parameters.properties.tabId, undefined);
      assert.deepEqual(tool.parameters.properties.tabRef, { type: ["integer", "string"] });
      assert.deepEqual(tool.parameters.required, ["tabRef", "payload"]);
      assert.deepEqual(tool.parameters.anyOf, [{ required: ["tabRef"] }, false]);
      assert.deepEqual(tool.parameters.allOf, [{ properties: { tabRef: { type: ["integer", "string"] } }, required: ["tabRef"] }]);
      assert.deepEqual(tool.parameters.oneOf, [{ anyOf: [{ required: ["tabRef"] }] }, { type: "null" }, true]);
    } else assert.deepEqual(tool.parameters, schema);
  }
  assert.equal(JSON.stringify(skill), before, "discovery must not rewrite an installed package");
});

test("Skill settings read and update the existing compound identity without a storage migration", async () => {
  const manifest = discoverSkillManifests([installedSkill]).plugins[0];
  const state = {
    _qz_skill_settings_v1: { version: 1, records: {
      "research-kit::legacy-namespace": {
        pluginId: "legacy-namespace", skillName: "research-kit",
        values: { endpoint: "https://before.example.test" }, updatedAt: "2026-01-01T00:00:00.000Z",
      },
    } },
  };
  const writes = [];
  const service = createSkillSettingsService({
    storage: {
      async get(key) { return { [key]: structuredClone(state[key]) }; },
      async set(value) { writes.push(structuredClone(value)); Object.assign(state, value); },
      async remove(key) { delete state[key]; },
    },
    listSkillManifests: () => [manifest],
    now: () => "2026-01-02T00:00:00.000Z",
  });
  const { settings } = await service.list();
  assert.equal(settings[0].id, "research-kit::legacy-namespace");
  assert.equal(settings[0].pluginId, "legacy-namespace");
  assert.equal(settings[0].fields[0].value, "https://before.example.test");
  assert.equal(writes.length, 0, "reading a legacy record must not rewrite it");
  await service.save({
    pluginId: settings[0].pluginId, skillName: settings[0].skillName,
    values: { endpoint: "https://after.example.test" },
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(state), ["_qz_skill_settings_v1"]);
  assert.deepEqual(Object.keys(state._qz_skill_settings_v1.records), ["research-kit::legacy-namespace"]);
  assert.equal(state._qz_skill_settings_v1.records[settings[0].id].values.endpoint, "https://after.example.test");
});

test("historical Skill result envelopes still restore renderer identity without a live catalog", () => {
  setSkillToolUiCatalog({});
  for (const result of [
    { _plugin: { rendererId: "plugin-script", title: "历史工具" } },
    { result: { _plugin: { rendererId: "plugin-script", title: "历史工具" } } },
  ]) {
    const tool = enrichSkillToolIdentity({ name: "legacy_namespace__inspect", result });
    assert.equal(tool.rendererId, "plugin-script");
    assert.equal(tool.title, "历史工具");
  }
});

test("Skill error details display historical and current tool names with stable precedence", t => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({
      innerHTML: "",
      set textContent(value) {
        this.innerHTML = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      },
    }) },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  for (const [details, expected] of [
    [{ pluginToolName: "legacy_namespace__inspect" }, "legacy_namespace__inspect"],
    [{ skillToolName: "current_namespace__inspect" }, "current_namespace__inspect"],
    [{ skillToolName: "current", pluginToolName: "legacy" }, "current"],
    [{ tool: "explicit", skillToolName: "current", pluginToolName: "legacy" }, "explicit"],
    [{ tool: "", skillToolName: "", pluginToolName: "legacy" }, "legacy"],
  ]) {
    const sections = [];
    appendErrorSection({ appendChild: section => sections.push(section) }, {
      code: "PLUGIN_TOOL_EXECUTION_FAILED", error: "Skill 工具执行失败", details,
    });
    assert.equal(sections.length, 1);
    assert.equal(sections[0].className, "tool-friendly-section tool-error-section");
    assert.equal(sections[0].innerHTML.match(/<span>工具<\/span>\s*<b>([^<]*)<\/b>/)?.[1], expected);
  }
});
