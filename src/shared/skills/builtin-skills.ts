import contributions from "#capabilities/skills";
import { createEmbeddedSkillRegistry } from "./embedded-skill-registry.js";
import { getSkillDisplayName, isModernSkillRecord, normalizeSkill, normalizeSkillLookup } from "./skill-utils.js";
import { getLanguage, withLanguage } from "../i18n/index.js";

const registries = new Map<string, ReturnType<typeof createEmbeddedSkillRegistry>>();
function builtinRegistry(language = getLanguage()) {
  let registry = registries.get(language);
  if (!registry) {
    registry = withLanguage(language, () => createEmbeddedSkillRegistry(contributions));
    registries.set(language, registry);
  }
  return registry;
}
const BUILTIN_SKILL_SOURCE = "system";

export function listBuiltinSkills(language = getLanguage()) {
  return builtinRegistry(language).list();
}

export function findBuiltinSkill(name: string, language = getLanguage()) {
  return builtinRegistry(language).get(name);
}

export function isBuiltinSkillName(name: string) {
  return Boolean(findBuiltinSkill(name));
}

export function isBuiltinSkill(skill: { builtin?: unknown; readOnly?: unknown; source?: unknown } = {}) {
  return skill?.builtin === true || skill?.readOnly === true || String(skill?.source || "") === BUILTIN_SKILL_SOURCE;
}

export function mergeBuiltinSkills(storedSkills: readonly object[] = [], language = getLanguage()) {
  const registry = builtinRegistry(language);
  const builtins = registry.list();
  const seen = new Set(builtins.flatMap(skill => [skill.name, getSkillDisplayName(skill)].map(normalizeSkillLookup)));
  const rows = [];
  for (const skill of Array.isArray(storedSkills) ? storedSkills : []) {
    if (!isModernSkillRecord(skill)) continue;
    const normalized = normalizeSkill(skill);
    const key = normalizeSkillLookup(normalized.name);
    if (!key || seen.has(key) || registry.get(normalized.name)) continue;
    if (registry.get(getSkillDisplayName(normalized))) continue;
    seen.add(key);
    rows.push(normalized);
  }
  return [...builtins, ...rows];
}
