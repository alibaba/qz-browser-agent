import assert from "node:assert/strict";

import { normalizeModernSkill, skillMatchesName } from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import { localizeToolFailureCode, localizeToolFailureText } from "../../src/shared/tools/tool-error-localization.js";

const validManifest = JSON.stringify({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "manifest-lint-demo",
  tools: [{ name: "demo", script: "scripts/demo.js" }],
}, null, 2);

const storage = {
  _skills: {
    "Manifest 校验": normalizeModernSkill({
      name: "Manifest 校验",
      description: "验证 plugin.json 保存边界",
      content: "正文",
      scope: "global",
      resources: [
        { path: "plugin.json", type: "json", content: validManifest },
        { path: "scripts/demo.js", type: "script", content: "async () => ({ ok: true })" },
      ],
    }),
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        return { ...storage };
      },
      async set(value) {
        Object.assign(storage, value);
      },
    },
  },
};

const skills = await import("../../src/background/skills/runtime.js");

function storedManifest(name = "Manifest 校验") {
  const skill = Object.values(storage._skills || {}).find(item => skillMatchesName(item, name));
  assert.ok(skill, `expected stored skill ${name}`);
  return skill.resources.find(resource => resource.path === "plugin.json")?.content || "";
}

const beforeInvalidJson = storedManifest();
await assert.rejects(
  () => skills.updateSkill("Manifest 校验", {
    resourceEdits: [{
      action: "replace",
      path: "plugin.json",
      oldText: '  "tools": [',
      newText: '  \\"tools\\": [',
    }],
  }),
  err => err?.code === "SKILL_PLUGIN_JSON_INVALID"
    && err.details?.path === "plugin.json"
    && err.details?.line > 0
    && /没有写入存储/.test(err.details?.recommendedAction || ""),
);
assert.equal(storedManifest(), beforeInvalidJson, "invalid JSON must not mutate storage");

await assert.rejects(
  () => skills.updateSkill("Manifest 校验", {
    resourceEdits: [{
      action: "set",
      path: "plugin.json",
      content: JSON.stringify({ id: "missing-schema" }),
    }],
  }),
  err => err?.code === "SKILL_PLUGIN_MANIFEST_INVALID"
    && err.details?.diagnostics?.length > 0,
);
assert.equal(storedManifest(), beforeInvalidJson, "invalid manifest schema must not mutate storage");

const invalidOutput = JSON.parse(validManifest);
invalidOutput.tools[0].outputSchema = { type: 'object', required: ['body'], examples: [{ text: 'Wrong field.' }] };
await assert.rejects(
  () => skills.updateSkill("Manifest 校验", {
    resourceEdits: [{ action: 'set', path: 'plugin.json', content: JSON.stringify(invalidOutput) }],
  }),
  err => err?.code === 'SKILL_PLUGIN_MANIFEST_INVALID'
    && err.details?.diagnostics?.some(item => item.message.includes('outputSchema')),
);
assert.equal(storedManifest(), beforeInvalidJson, 'an example violating its output contract must not mutate storage');

await assert.rejects(
  () => skills.saveSkill("新坏插件", "不应写入", "正文", {
    resources: [{ path: "plugin.json", type: "json", content: "{ bad json" }],
  }),
  err => err?.code === "SKILL_PLUGIN_JSON_INVALID",
);
assert.equal(Object.values(storage._skills || {}).some(item => skillMatchesName(item, "新坏插件")), false);

const repaired = await skills.updateSkill("Manifest 校验", {
  resourceEdits: [{
    action: "set",
    path: "plugin.json",
    content: validManifest.replace("manifest-lint-demo", "manifest-lint-repaired"),
  }],
});
assert.equal(repaired.updated, true);
assert.equal(JSON.parse(storedManifest()).id, "manifest-lint-repaired");

assert.equal(localizeToolFailureCode("SKILL_PLUGIN_JSON_INVALID"), "Skill 工具清单 JSON 无效");
assert.match(localizeToolFailureText("raw", {
  code: "SKILL_PLUGIN_JSON_INVALID",
  details: { line: 8, column: 3 },
}), /第 8 行.*第 3 列/);

console.log("skill plugin manifest validation tests passed");
