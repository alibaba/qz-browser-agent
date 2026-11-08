import { t } from "../../shared/i18n/backend.js";
import { createSkillStateRepository, sameSkillRecord, skillWriteConflict } from "./skill-repository.js";
import { listSkills, validateSkillMcpConfig, validateSkillManifest } from "./runtime.js";
import { isBuiltinSkillName, mergeBuiltinSkills } from "../../shared/skills/builtin-skills.js";
import { modernSkillValuesFromRecord, normalizeModernSkill, normalizeSkillLookup, normalizeSkill, skillEntriesByIdentity } from "../../shared/skills/skill-utils.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import type { SkillRecord } from "../../shared/skills/skill-utils.js";
import type { SkillWorkspaceSnapshot, SkillWorkspaceResult } from "../../shared/contracts/skill-workspace.js";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const keys = ["_skills"];
interface WorkspaceOptions {
  repository?: ReturnType<typeof createSkillStateRepository>;
  prepare?(): Promise<unknown>;
  validate?(skill: SkillRecord): Promise<unknown>;
  onChanged(reason: string, change: { skillName: string; previousSkillName: string }): Promise<unknown>;
}

/** User edits carry the snapshot they were based on, independently of unrelated Skill writes. */
export function createSkillWorkspaceService({
  repository = createSkillStateRepository(), prepare = listSkills,
  validate = async skill => { validateSkillManifest(skill); await validateSkillMcpConfig(skill); },
  onChanged,
}: WorkspaceOptions) {
  async function read(): Promise<SkillWorkspaceSnapshot> {
    await prepare();
    const stored = await repository.read(keys);
    return {
      skills: mergeBuiltinSkills(modernSkillValuesFromRecord(stored._skills)),
    };
  }
  async function mutate(action: "save" | "import" | "delete", input: unknown): Promise<SkillWorkspaceResult> {
    const request = fields(input);
    await prepare();
    const snapshot = await repository.read();
    const next = { ...snapshot._skills };
    const name = String(request.name || "");
    const rows = action === "import"
      ? (Array.isArray(request.skills) ? request.skills : []).map(normalizeModernSkill)
      : action === "save" ? [normalizeModernSkill(request.skill)] : [];
    if (action !== "delete" && (!rows.length || rows.some(skill => !skill.name))) throw new Error(t("skill.nothingToSave"));
    const names = action === "delete" ? [name] : rows.map(skill => skill.name);
    if (!names.every(Boolean)) throw new Error(t("skill.nameMissing"));
    if (new Set(names.map(normalizeSkillLookup)).size !== names.length) throw new Error(t("skill.duplicateNames"));
    for (const candidate of [name, ...names].filter(Boolean)) {
      if (isBuiltinSkillName(candidate)) throw Object.assign(new Error(t("skill.builtinReadOnly", { name: String(candidate) })), { code: "SKILL_READ_ONLY" });
    }
    const readSet = new Set([name, ...names].filter(Boolean));
    const find = (key: string) => {
      const entry = skillEntriesByIdentity(snapshot._skills, key)[0];
      return entry ? normalizeSkill(entry.skill) : null;
    };
    const remove = (name: string) => {
      for (const { key } of skillEntriesByIdentity(next, name)) {
        readSet.add(key);
        delete next[key];
      }
    };
    const expectations = action === "import" ? fields(request.expected) : { [name]: request.expected };
    for (const target of action === "import" ? names : [name]) {
      if (!Object.hasOwn(expectations, target) || expectations[target] === undefined) throw new TypeError("Skill writes require an expected record");
      const expected = expectations[target] === null ? null : normalizeModernSkill(expectations[target]);
      if (!sameSkillRecord(find(target), expected)) throw skillWriteConflict(target);
    }
    let saved: SkillRecord | undefined;
    if (action === "delete") remove(name);
    for (const row of rows) {
      const previous = find(action === "save" ? name : row.name);
      const conflict = find(row.name);
      if (action === "save" && conflict && conflict.name !== previous?.name) throw skillWriteConflict(row.name);
      const now = nowBeijingDateTime();
      saved = normalizeModernSkill({ ...previous, ...row, createdAt: previous?.createdAt || row.createdAt || now, updatedAt: now });
      await validate(saved);
      if (action === "save") remove(name);
      remove(row.name);
      next[saved.name] = saved;
    }
    await repository.commit(snapshot, { _skills: next }, { _skills: [...readSet] });
    let registryReady = true;
    try {
      await onChanged(`ui_skill_${action}`, { skillName: names.length === 1 ? names[0] : "", previousSkillName: action === "save" ? name : "" });
    } catch (_error) {
      // Persisted packages remain usable; the canonical registry boundary retries its dirty state.
      registryReady = false;
    }
    return { ...(await read()), ok: true, count: names.length, names, registryReady, ...(action === "save" ? { skill: saved } : {}) };
  }
  return Object.freeze({ read, save: (input: unknown) => mutate("save", input), import: (input: unknown) => mutate("import", input), remove: (input: unknown) => mutate("delete", input) });
}
