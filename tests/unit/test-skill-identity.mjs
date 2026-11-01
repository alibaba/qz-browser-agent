import assert from "node:assert/strict";
import { listBuiltinSkills } from "../../src/shared/skills/builtin-skills.js";
import {
  getSkillDisplayName,
  isValidAgentSkillName,
  normalizeModernSkill,
  toAgentSkillName,
} from "../../src/shared/skills/skill-utils.js";

const prefix = "qzb-shared-".padEnd(64, "a");
const alpha = `${prefix}-alpha`;
const beta = `${prefix}-beta`;

function legacyHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

function legacyBasicSlug(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/^-|-$/g, "");
}

function legacyTrim(value) {
  let text = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (text.length > 64) text = text.slice(0, 64).replace(/-+$/g, "");
  if (!isValidAgentSkillName(text)) text = `skill-${legacyHash(text || "skill")}`;
  return text;
}

function legacyAgentSkillName(value, fallback = "skill") {
  const raw = String(value || "").trim();
  const fallbackSlug = legacyBasicSlug(fallback) || "skill";
  const slug = legacyBasicSlug(raw);
  const hasNonAscii = /[^\x00-\x7F]/.test(raw);
  if (slug && isValidAgentSkillName(slug) && !hasNonAscii) return slug;
  const hash = legacyHash(raw || fallbackSlug);
  return legacyTrim(`${slug || fallbackSlug}-${hash}`);
}

assert.equal(prefix.length, 64);
assert.equal(isValidAgentSkillName(prefix), true);
assert.equal(legacyAgentSkillName(alpha), prefix);
assert.equal(legacyAgentSkillName(beta), prefix, "the old 64-character cut mapped distinct names onto one prefix");
assert.notEqual(toAgentSkillName(alpha), toAgentSkillName(beta));
assert.notEqual(toAgentSkillName(alpha), prefix);
assert.notEqual(toAgentSkillName(beta), prefix);
assert.equal(toAgentSkillName(alpha), toAgentSkillName(alpha));
assert.equal(isValidAgentSkillName(toAgentSkillName(alpha)), true);
assert.equal(isValidAgentSkillName(toAgentSkillName(beta)), true);
assert.ok(toAgentSkillName(alpha).length <= 64);
assert.ok(toAgentSkillName(alpha).endsWith(`-${legacyHash(alpha)}`));
assert.ok(toAgentSkillName(beta).endsWith(`-${legacyHash(beta)}`));
assert.equal(toAgentSkillName(prefix), prefix);
assert.equal(toAgentSkillName("travel-booking"), "travel-booking");
assert.equal(toAgentSkillName("travel-booking"), legacyAgentSkillName("travel-booking"));
assert.equal(toAgentSkillName("B站视频搜索"), legacyAgentSkillName("B站视频搜索"));
assert.equal(toAgentSkillName("Host 插件技能"), legacyAgentSkillName("Host 插件技能"));

// Pin IDs across the empty, fallback, Unicode and suffix-truncation paths.
for (const [value, fallback, expected] of [
  ["", undefined, "skill-1k2kmd2"],
  ["!!!", undefined, "skill-ckr8de"],
  ["视频", undefined, "skill-q79se0"],
  ["Crème brûlée", undefined, "creme-brulee-1f3f833"],
  ["", "Fallback Name", "fallback-name-11xlzah"],
  ["", "?!", "skill-1k2kmd2"],
  ["", "x".repeat(80), `${"x".repeat(57)}-ss38cl`],
  [`${"a".repeat(56)}-${"b".repeat(20)}`, undefined, `${"a".repeat(56)}-oi93mw`],
]) {
  const id = toAgentSkillName(value, fallback);
  assert.equal(id, expected);
  assert.equal(isValidAgentSkillName(id), true);
}

const mixedAlpha = `${prefix}视频甲`;
const mixedBeta = `${prefix}视频乙`;
assert.notEqual(toAgentSkillName(mixedAlpha), toAgentSkillName(mixedBeta));
assert.ok(toAgentSkillName(mixedAlpha).endsWith(`-${legacyHash(mixedAlpha)}`));
assert.ok(toAgentSkillName(mixedBeta).endsWith(`-${legacyHash(mixedBeta)}`));

const normalizedAlpha = normalizeModernSkill({ name: alpha, description: "alpha", content: "alpha body" });
assert.equal(normalizedAlpha.name, toAgentSkillName(alpha));
assert.equal(getSkillDisplayName(normalizedAlpha), alpha);

const storage = {
  _skills: {
    [prefix]: normalizeModernSkill({
      name: prefix,
      description: "existing prefix",
      content: "prefix-original",
      createdAt: "2026-01-01 00:00:00",
      updatedAt: "2026-01-01 00:00:00",
    }),
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storage[item]]));
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
const tools = await import("../../src/background/tools/runtime.js");
const toolRuntime = tools.createToolRuntime({
  skills: {
    async refreshRegistry() {
      return { version: 1 };
    },
  },
});
const host = { source: "plugin_host" };

const before = await skills.listSkills();
const seeded = before.find(skill => skill.name === prefix);
assert.equal(seeded.content, "prefix-original");
const seededUpdatedAt = seeded.updatedAt;

const createdAlpha = await toolRuntime.execute("manage_skill", {
  action: "create",
  name: alpha,
  description: "alpha skill",
  content: "alpha body",
}, undefined, host);
const createdBeta = await toolRuntime.execute("manage_skill", {
  action: "create",
  name: beta,
  description: "beta skill",
  content: "beta body",
}, undefined, host);
assert.equal(createdAlpha.saved, true);
assert.equal(createdBeta.saved, true);
assert.equal(createdAlpha.name, toAgentSkillName(alpha));
assert.equal(createdBeta.name, toAgentSkillName(beta));
assert.equal(createdAlpha.displayName, alpha);
assert.equal(createdBeta.displayName, beta);
assert.notEqual(createdAlpha.name, createdBeta.name);
assert.equal(storage._skills[prefix].content, "prefix-original");
assert.equal(storage._skills[prefix].updatedAt, seededUpdatedAt);
assert.equal(storage._skills[createdAlpha.name].content, "alpha body");
assert.equal(storage._skills[createdBeta.name].content, "beta body");

const listed = await toolRuntime.execute("manage_skill", {
  action: "list_skills",
  scope: "all",
}, undefined, host);
assert.equal(listed.action, "list_skills");
assert.equal(listed.names.includes(prefix), true);
assert.equal(listed.names.includes(createdAlpha.name), true);
assert.equal(listed.names.includes(createdBeta.name), true);
assert.equal(listed.names.includes(alpha), false);
assert.equal(listed.names.includes(beta), false);
assert.equal(listed.items.every(item => typeof item.name === "string" && typeof item.displayName === "string" && item.displayName), true);
assert.equal(listed.items.find(item => item.name === createdAlpha.name).displayName, alpha);
assert.equal(listed.items.find(item => item.name === createdBeta.name).displayName, beta);
assert.equal(listed.items.find(item => item.name === prefix).displayName, prefix);
const listedAfter = await skills.listSkills();
assert.equal(listedAfter.find(skill => skill.name === prefix).content, "prefix-original");
assert.equal(listedAfter.find(skill => skill.name === prefix).updatedAt, seededUpdatedAt);

const shared = ["rt1", "rt2"].map(name => normalizeModernSkill({
  name, displayName: "Shared title", description: name, content: name,
  resources: [{ path: "notes.md", content: name }],
}));
const candidates = shared.map(({ name, displayName }) => ({ name, displayName }));
const seed = rows => { storage._skills = Object.fromEntries(rows.map(row => [row.name, structuredClone(row)])); };
const create = name => toolRuntime.execute("manage_skill", {
  action: "create", name, description: "new skill", content: "new body",
}, undefined, { ...host, language: "zh-CN" });
const rt6 = normalizeModernSkill({
  name: "rt6", displayName: "rt5", description: "existing skill", content: "keep rt6",
  metadata: { privateMarker: "rt6-only" }, createdAt: "2026-01-01 00:00:00",
  resources: [{ path: "notes.md", content: "rt6 resource" }],
});
seed([rt6]);
const createdRt5 = await create("rt5");
assert.equal(createdRt5.saved, true);
assert.equal(createdRt5.name, "rt5");
assert.deepEqual(storage._skills.rt6, rt6);
assert.equal(storage._skills.rt5.content, "new body");
assert.equal(storage._skills.rt5.description, "new skill");
assert.deepEqual(storage._skills.rt5.metadata, {});
assert.deepEqual(storage._skills.rt5.resources, []);
assert.notEqual(storage._skills.rt5.createdAt, rt6.createdAt);
const afterCreate = structuredClone(storage._skills);
for (const name of ["rt6", "R T 6", "rt-6", "RT_6"]) {
  assert.deepEqual(await create(name), {
    action: "create", error: "技能已存在：rt5，请改用更新技能或编辑技能资源。", code: "SKILL_ALREADY_EXISTS",
    details: { name: "rt6", displayName: "rt5", originalCode: "SKILL_ALREADY_EXISTS", originalError: `技能已存在：${name}` },
    codeLabel: "技能已存在",
  });
  assert.deepEqual(storage._skills, afterCreate);
}
for (const rows of [shared, [...shared].reverse()]) {
  seed(rows);
  assert.equal((await create("Shared title")).saved, true);
  assert.equal(storage._skills["shared-title"].content, "new body");
  assert.deepEqual(storage._skills["shared-title"].resources, []);
  for (const row of rows) assert.deepEqual(storage._skills[row.name], row);
}
// Repeated non-canonical names must check the same identity saveSkill writes.
seed([]);
assert.equal((await create(alpha)).saved, true);
assert.equal((await create(alpha)).code, "SKILL_ALREADY_EXISTS");
const beforeBuiltinCreate = structuredClone(storage._skills);
const builtinName = listBuiltinSkills()[0].name;
assert.equal((await create(builtinName)).code, "SKILL_READ_ONLY");
assert.deepEqual(storage._skills, beforeBuiltinCreate);

const ambiguous = name => error => {
  assert.equal(error.code, "SKILL_NAME_AMBIGUOUS");
  assert.deepEqual(error.details, { name, candidates });
  return true;
};
seed(shared);
const unchanged = structuredClone(storage._skills);
for (const operation of [
  () => skills.loadSkill("Shared title"),
  () => skills.loadSkillResource("Shared title", "notes.md"),
  () => skills.updateSkill("Shared title", { appendContent: "changed" }),
  () => skills.updateSkill("Shared title", { renameTo: "renamed" }),
  () => skills.deleteSkill("Shared title"),
]) {
  await assert.rejects(operation, ambiguous("Shared title"));
  assert.deepEqual(storage._skills, unchanged);
}
for (const [tool, args] of [
  ["load_skill", { name: "Shared title" }],
  ["load_skill_resource", { name: "Shared title", path: "notes.md" }],
  ["manage_skill", { action: "update", name: "Shared title", appendContent: "changed" }],
  ["manage_skill", { action: "delete", name: "Shared title" }],
]) {
  await assert.rejects(toolRuntime.execute(tool, args, undefined, host), error => {
    assert.equal(error.code, "SKILL_NAME_AMBIGUOUS");
    assert.equal(error.details.name, "Shared title");
    assert.deepEqual(error.details.candidates, candidates);
    return true;
  });
  assert.deepEqual(storage._skills, unchanged);
}

// Exact IDs win over both shared titles and a sibling title equal to that ID.
for (const name of ["rt1", "rt2"]) {
  const sibling = normalizeModernSkill({ name: "sibling", displayName: name, content: "untouched" });
  seed([...shared, sibling]);
  assert.equal((await skills.loadSkill(name)).name, name);
  assert.equal((await toolRuntime.execute("load_skill", { name }, undefined, host)).name, name);
  assert.equal((await skills.updateSkill(name, { appendContent: " updated" })).skill.content, `${name} updated`);
  for (const row of [...shared, sibling].filter(row => row.name !== name)) assert.deepEqual(storage._skills[row.name], row);
  assert.equal(await skills.deleteSkill(name), true);
  assert.equal(storage._skills[name], undefined);
  for (const row of [...shared, sibling].filter(row => row.name !== name)) assert.deepEqual(storage._skills[row.name], row);
}

// Rename conflicts are identity-only, independent of shared titles and storage order.
for (const rows of [shared, [...shared].reverse()]) {
  seed(rows);
  const renamed = await skills.updateSkill("rt1", { renameTo: "rt9" });
  assert.equal(renamed.updated, true);
  assert.equal(renamed.skill.name, "rt9");
  assert.equal(renamed.skill.displayName, "Shared title");
  assert.equal(renamed.skill.content, "rt1");
  assert.equal(storage._skills.rt1, undefined);
  assert.deepEqual(storage._skills.rt9, renamed.skill);
  assert.deepEqual(storage._skills.rt2, shared[1]);
}

seed(shared);
for (const renameTo of ["rt2", "rt-2"]) {
  await assert.rejects(() => skills.updateSkill("rt1", { renameTo }), {
    message: `Skill "${renameTo}" already exists`,
  });
  assert.deepEqual(storage._skills, unchanged);
}

const renameSibling = normalizeModernSkill({ name: "rt2", displayName: "rt9", content: "untouched" });
seed([renameSibling, shared[0]]);
const renamedToSiblingTitle = await skills.updateSkill("rt1", { renameTo: "rt9" });
assert.equal(renamedToSiblingTitle.skill.name, "rt9");
assert.equal(renamedToSiblingTitle.skill.content, "rt1");
assert.equal(storage._skills.rt1, undefined);
assert.deepEqual(storage._skills.rt9, renamedToSiblingTitle.skill);
assert.deepEqual(storage._skills.rt2, renameSibling);

seed([shared[0]]);
assert.equal((await skills.loadSkill("Shared title")).name, "rt1");
assert.equal((await skills.updateSkill("Shared title", { appendContent: " updated" })).skill.name, "rt1");
assert.equal(await skills.deleteSkill("Shared title"), true);
assert.deepEqual(storage._skills, {});

seed([normalizeModernSkill({ name: "r-t", content: "one" }), normalizeModernSkill({ name: "rt", content: "two" })]);
for (const operation of [skills.loadSkill, skills.updateSkill, skills.deleteSkill]) {
  await assert.rejects(() => operation("R T"), error => {
    assert.equal(error.code, "SKILL_NAME_AMBIGUOUS");
    assert.deepEqual(error.details.candidates.map(row => row.name), ["r-t", "rt"]);
    return true;
  });
}
assert.equal((await skills.loadSkill("rt")).content, "two");
assert.equal(Object.keys(storage._skills).length, 2);

const builtin = listBuiltinSkills()[0];
seed([normalizeModernSkill({ name: "user-builtin-title", displayName: getSkillDisplayName(builtin), content: "user body" })]);
assert.equal((await skills.loadSkill(getSkillDisplayName(builtin))).name, builtin.name);
assert.equal((await skills.loadSkill(builtin.name)).builtin, true);
assert.equal((await skills.loadSkill("user-builtin-title")).content, "user body");
for (const operation of [
  () => skills.saveSkill(builtin.name, "no", "no"),
  () => skills.updateSkill(builtin.name, { appendContent: "no" }),
  () => skills.deleteSkill(builtin.name),
]) await assert.rejects(operation, { code: "SKILL_READ_ONLY" });

// save used to borrow metadata from the display-name match and then delete it.
const neighbours = [
  normalizeModernSkill({ name: "sibling", displayName: "target", content: "keep", metadata: { privateMarker: "sibling-only" }, createdAt: "old-sibling" }),
  normalizeModernSkill({ name: "same-title", displayName: "Shared title", content: "keep too" }),
];
seed(neighbours);
const saved = await skills.saveSkill("target", "new", "new body", { displayName: "Shared title" });
assert.equal(saved.metadata.privateMarker, undefined);
assert.notEqual(saved.createdAt, "old-sibling");
for (const row of neighbours) assert.deepEqual(storage._skills[row.name], row);
const overwritten = await skills.saveSkill("target", "newer", "newer body");
assert.equal(overwritten.createdAt, saved.createdAt);
assert.equal(overwritten.displayName, "Shared title");
for (const row of neighbours) assert.deepEqual(storage._skills[row.name], row);
assert.equal(Object.keys(storage._skills).length, 3);

seed([normalizeModernSkill({ name: "target-id", content: "old", createdAt: "original" }), ...neighbours]);
await skills.saveSkill("Target Id", "overwrite", "replacement");
assert.equal(storage._skills["target-id"].createdAt, "original");
assert.equal(storage._skills["target-id"].content, "replacement");
for (const row of neighbours) assert.deepEqual(storage._skills[row.name], row);
