import { promptT } from "./prompt-messages.js";
import { t } from "../../shared/i18n/backend.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { createSkillStateRepository } from "./skill-repository.js";
import type { SkillRecord, SkillResource } from "../../shared/skills/skill-utils.js";
type Fields = Record<string, unknown>;
type TextEdit = { oldText: string; newText: string };
type PatchMatch = TextEdit & { index: number; start: number; end: number };
type ReplacementCandidate = { start: number; end: number; search: string; source: string; score: number };
type CandidateDescription = { startLine: number; endLine: number; score: number; source: string;
  oldText?: string; oldTextPreview?: string; oldTextLength?: number; truncated?: boolean };
type ReplacementMatch = { found: boolean; indexes: number[]; occurrences: number; search: string;
  bestCandidate?: CandidateDescription; rankedCandidates?: CandidateDescription[]; rejectedReason?: string };
const fields = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};
const errorMessage = (error: unknown) => String(fields(error).message || error);

/** Skill summaries enter the system prompt; full instructions load on demand from local storage. */

import { nowBeijingDateTime } from "../../shared/time-utils.js";
import {
  findBuiltinSkill,
  isBuiltinSkillName,
  mergeBuiltinSkills,
} from "../../shared/skills/builtin-skills.js";
import {
  isBase64SkillResource,
  isModernSkillRecord,
  modernSkillValuesFromRecord,
  normalizeModernSkill,
  matchSiteSkillsForUrls as matchSiteSkillsForUrlList,
  getSkillDisplayName,
  normalizeSkill,
  normalizeSkillLookup,
  normalizeSkillResourcePath,
  normalizeSkillResources,
  normalizeStringList,
  skillMatchesName,
  skillEntriesByIdentity,
  SKILL_SCOPE_GLOBAL,
  SKILL_SCOPE_RESIDENT,
  SKILL_SCOPE_SITE,
} from "../../shared/skills/skill-utils.js";
import {
  findSkillManifestResource,
  parseSkillManifest,
  SKILL_MANIFEST_PATH,
} from "../../shared/skills/skill-manifest.js";
import {
  listMcpServerTools,
  mcpServerResult,
} from "../mcp/mcp-client.js";

const STORAGE_KEY = "_skills";
const EDIT_PREVIEW_LIMIT = 220;
const EDIT_CANDIDATE_LIMIT = 3;
const EDIT_PATCH_PREVIEW_LIMIT = 5000;
const EDIT_RETRY_CANDIDATE_LIMIT = 12000;
const REPLACE_SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const REPLACE_MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;
const REPLACE_FUZZY_CANDIDATE_MARGIN = 0.08;

class SkillEditError extends Error {
  constructor(readonly code: string, message: string, readonly details: Fields = {}) {
    super(message);
    this.name = "SkillEditError";
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Read and migrate the stored package records before mutation. */
async function _getAll() {
  const repository = createSkillStateRepository();
  const stored = await repository.read();
  const migrated = migrateLegacySkillsOnLoad(stored[STORAGE_KEY]);
  if (!migrated.changed) return migrated.skills;
  return (await repository.commit(stored, { [STORAGE_KEY]: migrated.skills }))[STORAGE_KEY];
}

async function _saveAll(skills: Fields, expected: Fields) {
  await createSkillStateRepository().commit({ [STORAGE_KEY]: expected }, { [STORAGE_KEY]: skills });
}

/** List Skill names and descriptions for discovery. */
export async function listSkills(language = getLanguage()) {
  const skills = await _getAll();
  return mergeBuiltinSkills(modernSkillValuesFromRecord(skills), language);
}

/** Load the complete Skill content. */
export async function loadSkill(name = "", language = getLanguage()) {
  const builtin = findBuiltinSkill(name, language);
  if (builtin) return builtin;
  const skills = await _getAll();
  const found = withLanguage(language, () => findSkillEntry(skills, name));
  return found ? normalizeSkill(found.skill) : null;
}

/** Find an existing user Skill by storage identity, never by display name. */
export async function loadSkillByIdentity(name = "") {
  const skills = await _getAll();
  const found = skillEntriesByIdentity(skills, normalizeModernSkill({ name }).name)
    .find(({ skill }) => isModernSkillRecord(skill));
  return found ? normalizeSkill(found.skill) : null;
}

/** Create or update a Skill. */
export async function saveSkill(name = "", description: string, content: string, metadata: Fields = {}) {
  if (isBuiltinSkillName(name)) {
    throw new SkillEditError("SKILL_READ_ONLY", t("skill.builtinOverwrite", { name: String(name) }), { name });
  }
  const skills = await _getAll();
  const expected = structuredClone(skills);
  const now = nowBeijingDateTime();
  const existing = skillEntriesByIdentity(skills, normalizeModernSkill({ name }).name)[0]?.skill || null;
  const cleanMetadata = Object.fromEntries(
    Object.entries(metadata || {}).filter(([, value]) => value !== undefined),
  );
  const draft = normalizeModernSkill({
    ...existing,
    ...cleanMetadata,
    name,
    description,
    content,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  if (skillManifestContentChanged(existing, draft)) validateSkillManifest(draft);
  await validateSkillMcpConfig(draft, { refresh: true });
  for (const { key } of skillEntriesByIdentity(skills, draft.name)) delete skills[key];
  skills[draft.name] = draft;
  await _saveAll(skills, expected);
  return draft;
}

/** Edit Skill text with exact replacements and apply resource operations. */
export async function updateSkill(name = "", patch: Fields = {}) {
  if (isBuiltinSkillName(name)) {
    throw new SkillEditError("SKILL_READ_ONLY", t("skill.builtinModify", { name: String(name) }), { name });
  }
  const skills = await _getAll();
  const expected = structuredClone(skills);
  const found = findSkillEntry(skills, name);
  if (!found) return null;

  const now = nowBeijingDateTime();
  const previous = normalizeSkill(found.skill);
  const changes: Fields[] = [];
  const diagnostics: Fields[] = [];
  const draft = { ...previous };

  const targetName = typeof patch.renameTo === "string" && patch.renameTo.trim()
    ? patch.renameTo.trim()
    : draft.name;
  if (targetName !== draft.name) {
    if (isBuiltinSkillName(targetName)) {
      throw new SkillEditError("SKILL_READ_ONLY", t("skill.builtinRename", { name: String(targetName) }), { name, targetName });
    }
    const targetDraft = normalizeModernSkill({ ...draft, name: targetName });
    const conflict = skillEntriesByIdentity(skills, targetDraft.name).find(entry => entry.key !== found.key);
    if (conflict) {
      throw new Error(`Skill "${targetName}" already exists`);
    }
    changes.push({ field: "name", from: draft.name, to: targetName });
    draft.name = targetDraft.name;
    draft.metadata = targetDraft.metadata;
    draft.displayName = getSkillDisplayName(targetDraft);
  }

  applyScalarUpdate(draft, patch, "description", changes);
  applyDisplayNameUpdate(draft, patch, changes);
  applyScalarUpdate(draft, patch, "scope", changes);
  applyScalarUpdate(draft, patch, "status", changes);
  applyArrayUpdate(draft, patch, "domains", changes);
  applyArrayUpdate(draft, patch, "urlPatterns", changes);
  applyArrayUpdate(draft, patch, "excludePatterns", changes);

  const contentEdits = normalizeTextEdits(patch.contentEdits, "contentEdits");
  const hasTopLevelContentEdit = patch.oldText !== undefined || patch.newText !== undefined;
  const hasBlankTopLevelContentEdit = patch.oldText === "" && patch.newText === "";
  if (hasTopLevelContentEdit && !hasBlankTopLevelContentEdit) {
    if (typeof patch.oldText !== "string" || typeof patch.newText !== "string") {
      throw new Error("Both oldText and newText are required for a top-level content replacement");
    }
    contentEdits.push({ oldText: patch.oldText, newText: patch.newText });
  }
  if (contentEdits.length > 0) {
    const next = applyExactTextEdits(draft.content || "", contentEdits, `${previous.name}.content`);
    diagnostics.push(...next.diagnostics.map(item => ({ ...item, field: "content" })));
    if (next.changed) {
      draft.content = next.text;
      changes.push({
        field: "content",
        action: "replace",
        count: next.count,
        applied: next.appliedCount,
        alreadyApplied: next.alreadyAppliedCount || undefined,
        firstChangedLine: next.firstChangedLine,
        lineEnding: next.lineEnding,
        patchPreview: next.patchPreview,
      });
    }
  }

  if (typeof patch.prependContent === "string" && patch.prependContent) {
    draft.content = `${patch.prependContent}${draft.content || ""}`;
    changes.push({ field: "content", action: "prepend", size: patch.prependContent.length });
  }
  if (typeof patch.appendContent === "string" && patch.appendContent) {
    draft.content = `${draft.content || ""}${patch.appendContent}`;
    changes.push({ field: "content", action: "append", size: patch.appendContent.length });
  }

  const resourceEdits = Array.isArray(patch.resourceEdits) ? patch.resourceEdits : [];
  if (resourceEdits.length > 0) {
    draft.resources = applyResourceEdits(draft.resources || [], resourceEdits, previous.name, changes, diagnostics);
  }

  if (changes.length === 0) {
    return { skill: previous, changes, diagnostics, updated: false };
  }

  const updated = normalizeModernSkill({
    ...draft,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  });
  if (skillManifestContentChanged(previous, updated)) validateSkillManifest(updated);
  await validateSkillMcpConfig(updated, { refresh: true });
  if (found.key !== updated.name) delete skills[found.key];
  skills[updated.name] = updated;
  await _saveAll(skills, expected);
  return { skill: updated, changes, diagnostics, updated: true };
}

export function validateSkillManifest(skill: unknown = {}) {
  const normalized = normalizeSkill(skill);
  const manifestResource = findSkillManifestResource(normalized.resources || []);
  if (!manifestResource) return { ok: true, diagnostics: [] };

  const content = String(manifestResource.content || "");
  try {
    JSON.parse(content || "{}");
  } catch (err) {
    const location = skillManifestJsonErrorLocation(content, err);
    const where = location.line
      ? t("skill.jsonLocation", { line: String(location.line), column: String(location.column ? t("toolFailure.jsonColumn", { column: String(location.column) }) : "") })
      : "";
    throw new SkillEditError(
      "SKILL_PLUGIN_JSON_INVALID",
      t("skill.jsonSyntax", { location: String(where), reason: String(errorMessage(err)) }),
      {
        skillName: normalized.name,
        path: SKILL_MANIFEST_PATH,
        ...location,
        recommendedAction: t("skill.fixJson"),
      },
    );
  }

  const parsed = parseSkillManifest(content, normalized);
  const diagnostics = (parsed.diagnostics || [])
    .filter(item => !/MCP/i.test(String(item?.message || "")));
  if (!parsed.plugin || diagnostics.length) {
    const first = diagnostics.find(item => item?.message) || parsed.diagnostics?.[0] || {};
    const reason = first?.message ? `：${first.message}` : "";
    throw new SkillEditError(
      "SKILL_PLUGIN_MANIFEST_INVALID",
      t("skill.manifestInvalid", { reason: String(reason) }),
      {
        skillName: normalized.name,
        path: SKILL_MANIFEST_PATH,
        diagnostics,
        recommendedAction: t("skill.fixManifest"),
      },
    );
  }
  return { ok: true, plugin: parsed.plugin, diagnostics: parsed.diagnostics || [] };
}

export async function validateSkillMcpConfig(skill: unknown = {}, { refresh = true } = {}) {
  const normalized = normalizeSkill(skill);
  const manifestResource = findSkillManifestResource(normalized.resources || []);
  if (!manifestResource) return { ok: true, count: 0, servers: [] };
  const rawManifest = parseSkillManifestJson(manifestResource.content || "");
  if (!rawManifest || !manifestDeclaresMcp(rawManifest)) return { ok: true, count: 0, servers: [] };
  const parsed = parseSkillManifest(manifestResource.content || "", normalized);
  const plugin = parsed.plugin;
  const mcpWarnings = (parsed.diagnostics || [])
    .filter(item => /MCP/i.test(String(item?.message || "")));
  if (!plugin || mcpWarnings.length) {
    throw new SkillEditError("SKILL_MCP_CONFIG_INVALID", formatMcpValidationError(normalized, mcpWarnings), {
      skillName: normalized.name,
      diagnostics: mcpWarnings,
    });
  }
  const servers = Array.isArray(plugin.mcpServers) ? plugin.mcpServers : [];
  const enabledServers = servers.filter(server => server.enabled !== false);
  const results = [];
  for (const server of enabledServers) {
    try {
      const tools = await listMcpServerTools(server, { refresh });
      results.push({
        ...mcpServerResult(server),
        toolCount: Array.isArray(tools) ? tools.length : 0,
      });
    } catch (err) {
      throw new SkillEditError("SKILL_MCP_VALIDATE_FAILED", t("skill.mcpValidation", { server: String(server.name || server.id || "default"), reason: String(errorMessage(err)) }), {
        skillName: normalized.name,
        server: mcpServerResult(server),
        causeCode: fields(err).code || "",
      });
    }
  }
  return {
    ok: true,
    count: servers.length,
    validatedCount: enabledServers.length,
    servers: results,
  };
}

/** Delete a Skill. */
export async function deleteSkill(name = "") {
  if (isBuiltinSkillName(name)) {
    throw new SkillEditError("SKILL_READ_ONLY", t("skill.builtinDelete", { name: String(name) }), { name });
  }
  const skills = await _getAll();
  const expected = structuredClone(skills);
  const found = findSkillEntry(skills, name);
  if (!found) return false;
  delete skills[found.key];
  await _saveAll(skills, expected);
  return true;
}

function findSkillEntry(skills: Fields, name: unknown) {
  const rawName = String(name || "").trim();
  if (!rawName) return null;
  if (skills[rawName] && isModernSkillRecord(skills[rawName])) {
    return { key: rawName, skill: fields(skills[rawName]) };
  }
  const keys = Object.keys(skills).filter(item => {
    if (!isModernSkillRecord(skills[item])) return false;
    return skillMatchesName(fields(skills[item]), rawName) || normalizeSkillLookup(item) === normalizeSkillLookup(rawName);
  });
  if (keys.length > 1) {
    const candidates = keys.map(key => {
      const skill = normalizeSkill(skills[key]);
      return { name: skill.name, displayName: getSkillDisplayName(skill) };
    });
    throw new SkillEditError("SKILL_NAME_AMBIGUOUS", t("toolFailure.skillNameAmbiguous", {
      name: rawName, names: candidates.map(candidate => candidate.name).join(", "),
    }), { name: rawName, candidates });
  }
  const key = keys[0];
  return key ? { key, skill: fields(skills[key]) } : null;
}

function parseSkillManifestJson(content = "") {
  try {
    const value: unknown = JSON.parse(String(content || "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? fields(value) : null;
  } catch (_err) {
    return null;
  }
}

function skillManifestContentChanged(previousSkill: unknown = null, nextSkill: unknown = null) {
  return skillManifestContent(previousSkill) !== skillManifestContent(nextSkill);
}

function skillManifestContent(skill: unknown = null) {
  if (!skill) return null;
  const manifest = findSkillManifestResource(normalizeSkill(skill).resources || []);
  return manifest ? String(manifest.content || "") : null;
}

function skillManifestJsonErrorLocation(content = "", err: unknown = null) {
  const message = String(errorMessage(err) || "");
  const direct = message.match(/line\s+(\d+)(?:\s+column\s+(\d+))?/i);
  if (direct) {
    return {
      line: Number(direct[1]) || 0,
      column: Number(direct[2]) || 0,
    };
  }
  const positioned = message.match(/position\s+(\d+)/i);
  if (!positioned) return { line: 0, column: 0 };
  const offset = Math.max(0, Math.min(String(content || "").length, Number(positioned[1]) || 0));
  const before = String(content || "").slice(0, offset);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines[lines.length - 1] || "").length + 1,
  };
}

function manifestDeclaresMcp(manifest: Fields = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  if (manifest.mcpServers !== undefined) return true;
  if (manifest.connections && typeof manifest.connections === "object" && !Array.isArray(manifest.connections) && fields(manifest.connections).mcpServers !== undefined) return true;
  const runtime = manifest.runtime && typeof manifest.runtime === "object" && !Array.isArray(manifest.runtime)
    ? fields(manifest.runtime)
    : {};
  if (String(runtime.type || "").trim().toLowerCase() === "mcp") return true;
  return Array.isArray(manifest.tools) && manifest.tools.some(tool => fields(tool).runtime === "mcp" || fields(tool).mcp || fields(tool).mcpTool);
}

function formatMcpValidationError(skill: Partial<SkillRecord> = {}, diagnostics: { message?: string }[] = []) {
  const first = diagnostics.find(item => item?.message) || diagnostics[0] || {};
  const message = first?.message ? `：${first.message}` : "";
  return t("skill.mcpSaveInvalid", { name: String(skill.name || ""), message: String(message) });
}

function migrateLegacySkillsOnLoad(skills: unknown = {}) {
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return { skills: {}, changed: false };
  let changed = false;
  const next = { ...fields(skills) };
  const now = nowBeijingDateTime();
  for (const [key, raw] of Object.entries(fields(skills))) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rawSkill = fields(raw);
    if (isBuiltinSkillName(String(rawSkill.name || key))) continue;
    const legacy = normalizeSkill({ ...rawSkill, name: rawSkill.name || key });
    if (!legacy.name) continue;
    const migrated = normalizeModernSkill({
      ...legacy,
      resources: legacy.resources,
      createdAt: legacy.createdAt || legacy.updatedAt || now,
      updatedAt: legacy.updatedAt || now,
    });
    const current = normalizeSkill(rawSkill);
    const needsMigration = !isModernSkillRecord(rawSkill)
      || key !== migrated.name
      || current.name !== migrated.name
      || JSON.stringify(current.metadata || {}) !== JSON.stringify(migrated.metadata || {});
    if (!needsMigration) continue;
    if (key !== migrated.name) delete next[key];
    next[migrated.name] = migrated;
    changed = true;
  }
  return { skills: next, changed };
}

function applyScalarUpdate(draft: SkillRecord, patch: Fields, field: "description" | "scope" | "status", changes: Fields[]) {
  if (!Object.prototype.hasOwnProperty.call(patch, field) || patch[field] === undefined) return;
  const next = String(patch[field] ?? "");
  if (String(draft[field] ?? "") === next) return;
  changes.push({ field, from: draft[field], to: next });
  draft[field] = next;
}

function applyDisplayNameUpdate(draft: SkillRecord, patch: Fields, changes: Fields[]) {
  if (!Object.prototype.hasOwnProperty.call(patch, "displayName") || patch.displayName === undefined) return;
  const next = String(patch.displayName || "").trim();
  const prev = getSkillDisplayName(draft);
  if (prev === next) return;
  changes.push({ field: "displayName", from: prev, to: next });
  draft.displayName = next || draft.name;
  const metadata = { ...(draft.metadata || {}) };
  if (next && next !== draft.name) {
    metadata.displayName = next;
  } else {
    delete metadata.displayName;
  }
  if (metadata.qingzhou?.displayName) {
    delete metadata.qingzhou.displayName;
    if (!Object.keys(metadata.qingzhou).length) delete metadata.qingzhou;
  }
  draft.metadata = metadata;
}

function applyArrayUpdate(draft: SkillRecord, patch: Fields, field: "domains" | "urlPatterns" | "excludePatterns", changes: Fields[]) {
  if (!Object.prototype.hasOwnProperty.call(patch, field) || patch[field] === undefined) return;
  const next = normalizeStringList(patch[field]);
  const prev = normalizeStringList(draft[field]);
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  changes.push({ field, from: prev, to: next });
  draft[field] = next;
}

function normalizeTextEdits(value: unknown, label = "edits") {
  if (!Array.isArray(value)) return [];
  return value.map((edit, index) => {
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      throw new Error(`${label}[${index}] requires oldText and newText strings`);
    }
    return { oldText: edit.oldText, newText: edit.newText };
  });
}

function applyExactTextEdits(original: string, edits: TextEdit[], label: string) {
  const { bom, text: content } = stripBom(String(original ?? ""));
  const lineEnding = detectLineEnding(content);
  const normalizedContent = normalizePatchText(content);
  const normalizedEdits = edits.map(edit => ({
    oldText: normalizePatchText(edit.oldText),
    newText: normalizePatchText(edit.newText),
  }));
  const contentHashBefore = stableTextHash(normalizedContent);
  const diagnostics: Fields[] = [];
  const matches: PatchMatch[] = [];

  for (let index = 0; index < normalizedEdits.length; index += 1) {
    const { oldText, newText } = normalizedEdits[index];
    if (!oldText) {
      throw new SkillEditError("SKILL_EDIT_EMPTY_OLD_TEXT", `oldText must not be empty in ${label}.`, {
        label,
        editIndex: index,
      });
    }

    const replacementMatch = findReplacementMatch(normalizedContent, oldText);
    if (replacementMatch.occurrences > 1) {
      throw new SkillEditError(
        "SKILL_EDIT_OLD_TEXT_NOT_UNIQUE",
        `Found ${replacementMatch.occurrences} occurrences of edits[${index}].oldText in ${label}. Add context so it is unique.`,
        {
          label,
          editIndex: index,
          occurrences: replacementMatch.occurrences,
          oldTextPreview: compactEditText(oldText),
          candidateLines: replacementMatch.indexes.slice(0, 8).map(offset => lineNumberAtOffset(normalizedContent, offset)),
          ...(replacementMatch.rankedCandidates?.length
            ? { rankedCandidates: replacementMatch.rankedCandidates }
            : {}),
          recommendedAction: "Include one or two surrounding lines in oldText, or merge nearby edits into one larger replacement.",
        },
      );
    }
    if (!replacementMatch.found) {
      const alreadyAppliedIndexes = newText ? findAllIndexes(normalizedContent, newText) : [];
      if (alreadyAppliedIndexes.length === 1) {
        diagnostics.push({
          code: "SKILL_EDIT_ALREADY_APPLIED",
          label,
          editIndex: index,
          line: lineNumberAtOffset(normalizedContent, alreadyAppliedIndexes[0]),
          message: `edits[${index}] appears to be already applied in ${label}.`,
          oldTextPreview: compactEditText(oldText),
          newTextPreview: compactEditText(newText),
        });
        continue;
      }

      throw new SkillEditError(
        "SKILL_EDIT_OLD_TEXT_NOT_FOUND",
        `Could not find edits[${index}].oldText in ${label}. oldText must match the current content after line-ending normalization.`,
        {
          label,
          editIndex: index,
          totalEdits: normalizedEdits.length,
          contentLength: normalizedContent.length,
          contentHash: contentHashBefore,
          oldTextLength: oldText.length,
          oldTextPreview: compactEditText(oldText),
          newTextPreview: compactEditText(newText),
          newTextOccurrences: alreadyAppliedIndexes.length,
          candidates: findCandidateSnippets(normalizedContent, oldText),
          ...(replacementMatch.bestCandidate
            ? { bestCandidate: replacementMatch.bestCandidate }
            : {}),
          ...(replacementMatch.rejectedReason ? { rejectedReason: replacementMatch.rejectedReason } : {}),
          recommendedAction: replacementMatch.bestCandidate?.oldText
            ? "Retry once using bestCandidate.oldText verbatim as oldText. If it is not the intended block, reload the resource and copy a small unique span from the current content."
            : "Use load_skill to list resources, then load_skill_resource(name,path) to reload the current resource. Retry using a smaller unique oldText. If replacing a whole resource, use resourceEdits action:'set' with content.",
        },
      );
    }

    matches.push({
      index,
      start: replacementMatch.indexes[0],
      end: replacementMatch.indexes[0] + replacementMatch.search.length,
      oldText: replacementMatch.search,
      newText,
    });
  }

  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].start < matches[i - 1].end) {
      throw new SkillEditError(
        "SKILL_EDIT_OVERLAP",
        `Overlapping edits in ${label}; merge nearby edits into one replacement.`,
        {
          label,
          editIndexes: [matches[i - 1].index, matches[i].index],
          recommendedAction: "Merge these edits into a single oldText/newText replacement that covers the whole touched block.",
        },
      );
    }
  }

  let cursor = 0;
  let normalizedText = "";
  let changed = false;
  for (const match of matches) {
    normalizedText += normalizedContent.slice(cursor, match.start);
    normalizedText += match.newText;
    cursor = match.end;
    if (match.oldText !== match.newText) changed = true;
  }
  normalizedText += normalizedContent.slice(cursor);

  const text = bom + restoreLineEndings(normalizedText, lineEnding);
  const firstChangedLine = matches.length ? lineNumberAtOffset(normalizedContent, matches[0].start) : undefined;
  const patchPreview = matches.length ? buildPatchPreview(label, normalizedContent, matches) : "";
  return {
    text,
    changed: changed && text !== String(original ?? ""),
    count: edits.length,
    appliedCount: matches.length,
    alreadyAppliedCount: diagnostics.filter(item => item.code === "SKILL_EDIT_ALREADY_APPLIED").length,
    diagnostics,
    firstChangedLine,
    lineEnding,
    patchPreview,
    contentHashBefore,
    contentHashAfter: stableTextHash(normalizedText),
  };
}

function normalizePatchText(value: unknown) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function stripBom(value: unknown) {
  const text = String(value ?? "");
  return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

function detectLineEnding(value: unknown) {
  const text = String(value ?? "");
  const crlf = text.indexOf("\r\n");
  const lf = text.indexOf("\n");
  return lf >= 0 && crlf >= 0 && crlf <= lf ? "\r\n" : "\n";
}

function restoreLineEndings(value: unknown, ending: string) {
  return ending === "\r\n" ? String(value ?? "").replace(/\n/g, "\r\n") : String(value ?? "");
}

function findAllIndexes(content: string, needle: string) {
  const indexes = [];
  let offset = 0;
  while (offset <= content.length) {
    const idx = content.indexOf(needle, offset);
    if (idx < 0) break;
    indexes.push(idx);
    offset = idx + Math.max(needle.length, 1);
  }
  return indexes;
}

function findReplacementMatch(content: string, oldText: string): ReplacementMatch {
  const exactIndexes = findAllIndexes(content, oldText);
  if (exactIndexes.length === 1) {
    return { found: true, indexes: exactIndexes, occurrences: 1, search: oldText };
  }
  if (exactIndexes.length > 1) {
    const candidates = exactIndexes.map(start => createReplacementCandidate(content, start, start + oldText.length, {
      source: "exact",
      score: 1,
    }));
    return ambiguousReplacementMatch(content, candidates);
  }

  const equivalent = collectEquivalentReplacementCandidates(content, oldText);
  if (equivalent.candidates.length > 0) {
    const strongestScore = Math.max(...equivalent.candidates.map(candidate => candidate.score));
    const strongest = equivalent.candidates.filter(candidate => candidate.score === strongestScore);
    if (strongest.length === 1) return successfulReplacementMatch(content, strongest[0]);
    return ambiguousReplacementMatch(content, strongest);
  }

  const fuzzy = collectFuzzyReplacementCandidates(content, oldText);
  if (fuzzy.candidates.length === 0) {
    return {
      found: false,
      indexes: [],
      occurrences: 0,
      search: "",
      ...(equivalent.rejectedReason ? { rejectedReason: equivalent.rejectedReason } : {}),
    };
  }

  const ranked = [...fuzzy.candidates].sort(compareReplacementCandidates);
  const best = ranked[0];
  const threshold = ranked.length > 1
    ? REPLACE_MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD
    : REPLACE_SINGLE_CANDIDATE_SIMILARITY_THRESHOLD;
  if (best.score < threshold) {
    return failedReplacementMatch(content, ranked, `best candidate score ${formatCandidateScore(best.score)} is below ${formatCandidateScore(threshold)}`);
  }
  const second = ranked[1];
  if (second && best.score - second.score < REPLACE_FUZZY_CANDIDATE_MARGIN) {
    return ambiguousReplacementMatch(content, ranked.filter(candidate => best.score - candidate.score < REPLACE_FUZZY_CANDIDATE_MARGIN));
  }
  return successfulReplacementMatch(content, best);
}

function collectEquivalentReplacementCandidates(content: string, oldText: string) {
  const candidates = new Map<string, ReplacementCandidate>();
  let rejectedReason = "";
  const rules = [
    { source: "line_trimmed", score: 0.995, generate: lineTrimmedReplacementCandidates },
    { source: "indentation_flexible", score: 0.99, generate: indentationFlexibleReplacementCandidates },
    { source: "whitespace_normalized", score: 0.985, generate: whitespaceNormalizedReplacementCandidates },
    { source: "escape_normalized", score: 0.98, generate: escapeNormalizedReplacementCandidates },
    { source: "trimmed_boundary", score: 0.975, generate: trimmedBoundaryReplacementCandidates },
  ];

  for (const rule of rules) {
    const seenSearches = new Set();
    for (const search of rule.generate(content, oldText)) {
      if (!search || seenSearches.has(search)) continue;
      seenSearches.add(search);
      if (isDisproportionateReplacementMatch(search, oldText)) {
        rejectedReason ||= "matched span is much larger than oldText";
        continue;
      }
      for (const start of findAllIndexes(content, search)) {
        addReplacementCandidate(candidates, createReplacementCandidate(content, start, start + search.length, {
          source: rule.source,
          score: rule.score,
        }));
      }
    }
  }
  return { candidates: [...candidates.values()], rejectedReason };
}

function collectFuzzyReplacementCandidates(content: string, oldText: string) {
  const contentLines = String(content || "").split("\n");
  const searchLines = String(oldText || "").split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length < 3 || contentLines.length < searchLines.length - 1) return { candidates: [] };

  const candidates = new Map<string, ReplacementCandidate>();
  const firstLine = searchLines[0].trim();
  const lastLine = searchLines[searchLines.length - 1].trim();
  const maxLineDelta = Math.max(1, Math.floor(searchLines.length * 0.25));
  for (let startLine = 0; startLine < contentLines.length; startLine += 1) {
    if (contentLines[startLine].trim() !== firstLine) continue;
    const minEndLine = Math.max(startLine + 2, startLine + searchLines.length - 1 - maxLineDelta);
    const maxEndLine = Math.min(contentLines.length - 1, startLine + searchLines.length - 1 + maxLineDelta);
    for (let endLine = minEndLine; endLine <= maxEndLine; endLine += 1) {
      if (contentLines[endLine].trim() !== lastLine) continue;
      const search = contentLines.slice(startLine, endLine + 1).join("\n");
      if (!search || isDisproportionateReplacementMatch(search, oldText)) continue;
      const score = replacementBlockSimilarity(contentLines, searchLines, { startLine, endLine });
      for (const start of findAllIndexes(content, search)) {
        addReplacementCandidate(candidates, createReplacementCandidate(content, start, start + search.length, {
          source: "boundary_anchor",
          score,
        }));
      }
    }
  }
  return { candidates: [...candidates.values()] };
}

function createReplacementCandidate(content: string, start: number, end: number, metadata: Partial<Pick<ReplacementCandidate, "source" | "score">> = {}) {
  return {
    start,
    end,
    search: String(content || "").slice(start, end),
    source: metadata.source || "candidate",
    score: Number.isFinite(metadata.score) ? Number(metadata.score) : 0,
  };
}

function addReplacementCandidate(candidates: Map<string, ReplacementCandidate>, candidate: ReplacementCandidate) {
  if (!candidate.search) return;
  const key = `${candidate.start}:${candidate.end}`;
  const current = candidates.get(key);
  if (!current) {
    candidates.set(key, candidate);
    return;
  }
  if (candidate.score > current.score) candidates.set(key, candidate);
}

function compareReplacementCandidates(left: ReplacementCandidate, right: ReplacementCandidate) {
  return right.score - left.score || left.start - right.start || left.end - right.end;
}

function successfulReplacementMatch(content: string, candidate: ReplacementCandidate) {
  return {
    found: true,
    indexes: [candidate.start],
    occurrences: 1,
    search: candidate.search,
    bestCandidate: describeReplacementCandidate(content, candidate),
  };
}

function ambiguousReplacementMatch(content: string, candidates: ReplacementCandidate[]) {
  const ranked = [...candidates].sort(compareReplacementCandidates);
  return {
    found: false,
    indexes: ranked.map(candidate => candidate.start),
    occurrences: Math.max(2, ranked.length),
    search: "",
    bestCandidate: ranked[0] ? describeReplacementCandidate(content, ranked[0]) : undefined,
    rankedCandidates: ranked.slice(0, EDIT_CANDIDATE_LIMIT).map(candidate => describeReplacementCandidate(content, candidate, { includeText: false })),
  };
}

function failedReplacementMatch(content: string, candidates: ReplacementCandidate[], rejectedReason = "") {
  const best = candidates[0];
  return {
    found: false,
    indexes: [],
    occurrences: 0,
    search: "",
    ...(best ? { bestCandidate: describeReplacementCandidate(content, best) } : {}),
    ...(rejectedReason ? { rejectedReason } : {}),
  };
}

function describeReplacementCandidate(content: string, candidate: ReplacementCandidate, { includeText = true } = {}) {
  const text = candidate.search || "";
  const details: CandidateDescription = {
    startLine: lineNumberAtOffset(content, candidate.start),
    endLine: lineNumberAtOffset(content, Math.max(candidate.start, candidate.end - 1)),
    score: Number(formatCandidateScore(candidate.score)),
    source: candidate.source,
  };
  if (!includeText) return details;
  if (text.length <= EDIT_RETRY_CANDIDATE_LIMIT) details.oldText = text;
  else {
    details.oldTextPreview = compactEditText(text, EDIT_PREVIEW_LIMIT);
    details.oldTextLength = text.length;
    details.truncated = true;
  }
  return details;
}

function formatCandidateScore(value: unknown) {
  return Math.max(0, Math.min(1, Number(value) || 0)).toFixed(3);
}

function* lineTrimmedReplacementCandidates(content: string, find: string) {
  const originalLines = String(content || "").split("\n");
  const searchLines = String(find || "").split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();

  for (let i = 0; i <= originalLines.length - searchLines.length; i += 1) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j += 1) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    yield originalLines.slice(i, i + searchLines.length).join("\n");
  }
}

function replacementBlockSimilarity(originalLines: string[], searchLines: string[], candidate: { startLine: number; endLine: number }) {
  const actualBlockSize = candidate.endLine - candidate.startLine + 1;
  const linesToCheck = Math.min(searchLines.length - 2, actualBlockSize - 2);
  if (linesToCheck <= 0) return 1;
  let similarity = 0;
  let comparedWeight = 0;
  for (let j = 1; j < searchLines.length - 1 && j < actualBlockSize - 1; j += 1) {
    const originalLine = originalLines[candidate.startLine + j].trim();
    const searchLine = searchLines[j].trim();
    const maxLen = Math.max(originalLine.length, searchLine.length);
    if (maxLen === 0) {
      similarity += 1;
      comparedWeight += 1;
      continue;
    }
    similarity += Math.max(0, 1 - levenshteinDistance(originalLine, searchLine) / maxLen);
    comparedWeight += 1;
  }
  const lineCoverage = Math.min(searchLines.length, actualBlockSize) / Math.max(searchLines.length, actualBlockSize);
  return comparedWeight > 0 ? (similarity / comparedWeight) * lineCoverage : lineCoverage;
}

function* whitespaceNormalizedReplacementCandidates(content: string, find: string) {
  const normalizeWhitespace = (text: string) => String(text || "").replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);
  const lines = String(content || "").split("\n");

  for (const line of lines) {
    const normalizedLine = normalizeWhitespace(line);
    if (normalizedLine === normalizedFind) {
      yield line;
      continue;
    }
    if (!normalizedLine.includes(normalizedFind)) continue;
    const words = String(find || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    try {
      const match = line.match(new RegExp(pattern));
      if (match) yield match[0];
    } catch (_err) {
      // Ignore invalid fallback regexes.
    }
  }

  const findLines = String(find || "").split("\n");
  if (findLines.length <= 1) return;
  for (let i = 0; i <= lines.length - findLines.length; i += 1) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (normalizeWhitespace(block) === normalizedFind) yield block;
  }
}

function* indentationFlexibleReplacementCandidates(content: string, find: string) {
  const normalizedFind = removeCommonIndentation(find);
  const contentLines = String(content || "").split("\n");
  const findLines = String(find || "").split("\n");
  for (let i = 0; i <= contentLines.length - findLines.length; i += 1) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeCommonIndentation(block) === normalizedFind) yield block;
  }
}

function removeCommonIndentation(value: unknown) {
  const lines = String(value || "").split("\n");
  const nonEmptyLines = lines.filter(line => line.trim().length > 0);
  if (nonEmptyLines.length === 0) return String(value || "");
  const minIndent = Math.min(...nonEmptyLines.map(line => {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }));
  return lines.map(line => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
}

function* escapeNormalizedReplacementCandidates(content: string, find: string) {
  const unescapedFind = unescapeReplacementString(find);
  if (String(content || "").includes(unescapedFind)) yield unescapedFind;
  const lines = String(content || "").split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i += 1) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeReplacementString(block) === unescapedFind) yield block;
  }
}

function unescapeReplacementString(value: unknown) {
  return String(value || "").replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
    switch (capturedChar) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "'": return "'";
      case "\"": return "\"";
      case "`": return "`";
      case "\\": return "\\";
      case "\n": return "\n";
      case "$": return "$";
      default: return match;
    }
  });
}

function* trimmedBoundaryReplacementCandidates(content: string, find: string) {
  const trimmedFind = String(find || "").trim();
  if (trimmedFind === find) return;
  if (String(content || "").includes(trimmedFind)) yield trimmedFind;
  const lines = String(content || "").split("\n");
  const findLines = String(find || "").split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i += 1) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) yield block;
  }
}

function levenshteinDistance(a: string, b: string) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === "" || right === "") return Math.max(left.length, right.length);
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

function isDisproportionateReplacementMatch(search: string, oldText: string) {
  const oldLines = String(oldText || "").split("\n").length;
  const searchLines = String(search || "").split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  const oldLength = String(oldText || "").trim().length;
  return String(search || "").trim().length > Math.max(oldLength + 500, oldLength * 4);
}

function applyResourceEdits(resources: SkillResource[], operations: unknown[], skillName: string, changes: Fields[], diagnostics: Fields[]) {
  let nextResources = normalizeSkillResources(resources);
  for (const operation of operations) {
    const raw = fields(operation);
    const action = resolveResourceEditAction(raw);
    const path = cleanResourcePath(raw?.path);
    if (!path) throw new Error("resourceEdits[].path is required");

    if (action === "upsert" || action === "set") {
      const idx = nextResources.findIndex(item => item.path === path);
      const previous = idx >= 0 ? nextResources[idx] : null;
      if (previous && isBase64SkillResource(previous) && Object.hasOwn(raw, "content")) {
        throw binaryResourceEditError(skillName, path);
      }
      const [updated] = normalizeSkillResources([{ ...previous, ...pickResourceFields(raw), path }]);
      if (!updated) throw new Error(`Invalid resource path: ${path}`);
      if (previous && JSON.stringify(previous) === JSON.stringify(updated)) continue;
      if (idx >= 0) nextResources[idx] = updated;
      else nextResources.push(updated);
      changes.push({ field: "resources", action: previous ? "upsert" : "add", path });
      continue;
    }

    const idx = nextResources.findIndex(item => item.path === path);
    if (idx < 0) throw new Error(`Skill resource not found: ${skillName}/${path}`);

    if (action === "delete" || action === "remove") {
      nextResources.splice(idx, 1);
      changes.push({ field: "resources", action: "delete", path });
      continue;
    }

    if (action === "rename") {
      const newPath = cleanResourcePath(raw?.newPath);
      if (!newPath) throw new Error(`resourceEdits[].newPath is required for rename: ${path}`);
      const exists = nextResources.some((item, itemIndex) => item.path === newPath && itemIndex !== idx);
      if (exists) throw new Error(`Skill resource already exists: ${skillName}/${newPath}`);
      const [renamed] = normalizeSkillResources([{ ...nextResources[idx], ...pickResourceFields(raw), path: newPath }]);
      nextResources[idx] = renamed;
      changes.push({ field: "resources", action: "rename", path, newPath });
      continue;
    }

    if (action === "append" || action === "prepend") {
      const resource = nextResources[idx];
      if (isBase64SkillResource(resource)) throw binaryResourceEditError(skillName, path);
      const content = typeof resource.content === "string" ? resource.content : "";
      const text = action === "append"
        ? (raw.appendText ?? raw.content ?? raw.text)
        : (raw.prependText ?? raw.content ?? raw.text);
      if (typeof text !== "string") {
        throw new Error(`resource ${action} requires ${action}Text or content: ${skillName}/${path}`);
      }
      const nextContent = action === "append" ? content + text : text + content;
      if (nextContent !== content) {
        nextResources[idx] = { ...resource, content: nextContent };
        changes.push({
          field: "resources",
          action,
          path,
          firstChangedLine: action === "append" ? content.split("\n").length : 1,
        });
      }
      continue;
    }

    if (action === "replace" || action === "patch" || action === "edit") {
      const edits = normalizeTextEdits(raw.edits, `resourceEdits[${path}].edits`);
      if (raw.oldText !== undefined || raw.newText !== undefined) {
        if (typeof raw.oldText !== "string" || typeof raw.newText !== "string") {
          throw new Error(`Both oldText and newText are required for resource edit: ${skillName}/${path}`);
        }
        edits.push({ oldText: raw.oldText, newText: raw.newText });
      }
      if (edits.length === 0) throw new Error(`resource edit requires oldText/newText or edits[]: ${skillName}/${path}`);
      const resource = nextResources[idx];
      if (isBase64SkillResource(resource)) throw binaryResourceEditError(skillName, path);
      const content = typeof resource.content === "string" ? resource.content : "";
      const edited = applyExactTextEdits(content, edits, `${skillName}/${path}`);
      diagnostics.push(...edited.diagnostics.map(item => ({ ...item, field: "resources", path })));
      if (edited.changed) {
        nextResources[idx] = { ...resource, content: edited.text };
        changes.push({
          field: "resources",
          action: "replace",
          path,
          count: edited.count,
          applied: edited.appliedCount,
          alreadyApplied: edited.alreadyAppliedCount || undefined,
          firstChangedLine: edited.firstChangedLine,
          lineEnding: edited.lineEnding,
          patchPreview: edited.patchPreview,
        });
      }
      continue;
    }

    throw new Error(`Unsupported resource edit action: ${action}`);
  }
  return normalizeSkillResources(nextResources);
}

function binaryResourceEditError(skillName: string, path: string) {
  return Object.assign(new Error(t("skill.binaryTextEdit", { name: String(skillName), path: String(path) })), {
    code: "SKILL_BINARY_RESOURCE_TEXT_EDIT_UNSUPPORTED", details: { name: skillName, path },
  });
}

function resolveResourceEditAction(raw: Fields = {}) {
  const explicit = String(raw?.action || "").trim().toLowerCase();
  if (explicit) return explicit;
  const hasContent = Object.prototype.hasOwnProperty.call(raw, "content") && raw.content !== undefined;
  const hasReplacement = raw.oldText !== undefined || raw.newText !== undefined || Array.isArray(raw.edits);
  return hasContent && !hasReplacement ? "set" : "replace";
}

function cleanResourcePath(value: unknown) {
  return normalizeSkillResourcePath(value);
}

function pickResourceFields(raw: Fields = {}) {
  const out: Fields = {};
  for (const field of ["type", "title", "description", "content"]) {
    if (Object.prototype.hasOwnProperty.call(raw, field) && raw[field] !== undefined) out[field] = raw[field];
  }
  return out;
}

function compactEditText(value: unknown, limit = EDIT_PREVIEW_LIMIT) {
  const text = String(value ?? "").replace(/\t/g, "\\t");
  const oneLine = text.replace(/\n/g, "\\n");
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

function lineNumberAtOffset(content: string, offset: number) {
  const text = String(content ?? "");
  const end = Math.max(0, Math.min(text.length, Number(offset) || 0));
  let line = 1;
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findCandidateSnippets(content: string, oldText: string) {
  const anchors = String(oldText || "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length >= 8)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  if (!anchors.length) return [];
  const lines = String(content || "").split("\n");
  const out = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const probe = anchor.slice(0, 120);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(probe)) continue;
      const key = `${index}:${lines[index]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        line: index + 1,
        text: compactEditText(lines[index], 180),
      });
      if (out.length >= EDIT_CANDIDATE_LIMIT) return out;
    }
  }
  return out;
}

function stableTextHash(value: unknown) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildPatchPreview(label: string, originalContent: string, matches: PatchMatch[], contextLines = 3) {
  const originalLines = String(originalContent || "").split("\n");
  const hunks = [];
  for (const match of matches.slice(0, 12)) {
    const startLine = lineNumberAtOffset(originalContent, match.start);
    const oldLines = splitPatchLines(match.oldText);
    const newLines = splitPatchLines(match.newText);
    const beforeStart = Math.max(1, startLine - contextLines);
    const afterStart = startLine + oldLines.length;
    const afterEnd = Math.min(originalLines.length, afterStart + contextLines - 1);
    const rows = [`@@ ${label}:${startLine} @@`];
    for (let line = beforeStart; line < startLine; line += 1) {
      rows.push(` ${originalLines[line - 1] ?? ""}`);
    }
    for (const line of oldLines) rows.push(`-${line}`);
    for (const line of newLines) rows.push(`+${line}`);
    for (let line = afterStart; line <= afterEnd; line += 1) {
      rows.push(` ${originalLines[line - 1] ?? ""}`);
    }
    hunks.push(rows.join("\n"));
  }
  const text = hunks.join("\n");
  if (text.length <= EDIT_PATCH_PREVIEW_LIMIT) return text;
  return `${text.slice(0, EDIT_PATCH_PREVIEW_LIMIT - 40)}\n... patch preview truncated ...`;
}

function splitPatchLines(value: unknown) {
  const lines = String(value ?? "").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export async function matchSiteSkillsForUrls(urls: unknown, { limit = 5, language = getLanguage() } = {}) {
  const skills = await listSkills(language);
  return matchSiteSkillsForUrlList(skills, urls, { limit });
}

export async function loadSkillScript(name: string, scriptPath: string, language = getLanguage()) {
  const loaded = await loadSkillResource(name, scriptPath, language);
  if (!loaded) return null;
  const { skill, resource, path: cleanPath } = loaded;
  if (!resource) {
    throw new Error(`Skill resource not found: ${skill.name}/${cleanPath}`);
  }
  if (resource.type !== "script") {
    throw new Error(`Skill resource is not executable script: ${skill.name}/${cleanPath}`);
  }
  if (typeof resource.content !== "string" || !resource.content.trim()) {
    throw new Error(`Skill script has no content: ${skill.name}/${cleanPath}`);
  }
  return resource.content;
}

export async function loadSkillResource(name: string, resourcePath: string, language = getLanguage()) {
  const skill = await loadSkill(name, language);
  if (!skill) return null;
  const cleanPath = cleanResourcePath(resourcePath);
  const resource = skill.resources.find(item => item.path === cleanPath) || null;
  return { skill, resource, path: cleanPath };
}

// ---------------------------------------------------------------------------
// Progressive Skill disclosure in the system prompt
// ---------------------------------------------------------------------------

/** Include resident Skills in full and expose global/site Skills through summaries. */
export async function buildSkillPromptSection(language = getLanguage()) {
  const skills = await listSkills(language);
  return withLanguage(language, () => formatSkillPromptSection(skills));
}

function formatSkillPromptSection(skills: SkillRecord[]) {
  const activeSkills = skills.filter(s => s.status !== "disabled");
  const residentSkills = activeSkills.filter(s => s.scope === SKILL_SCOPE_RESIDENT);
  const globalSkills = activeSkills.filter(s => s.scope === SKILL_SCOPE_GLOBAL);
  const siteSkillCount = activeSkills.filter(s => s.scope === SKILL_SCOPE_SITE).length;
  if (residentSkills.length === 0 && globalSkills.length === 0 && siteSkillCount === 0) return "";

  const residentSection = residentSkills.length
    ? promptT("residents", { skills: residentSkills.map(formatResidentSkillForPrompt).join("\n\n") })
    : "";

  const list = globalSkills.map(formatSkillListItemForPrompt).join("\n");
  const globalSection = list
    ? promptT("globals", { skills: list })
    : promptT("noGlobals");
  const siteNote = siteSkillCount > 0
    ? promptT("sites", { count: siteSkillCount })
    : "";
  return `${residentSection}
${promptT("available")}
${globalSection}${siteNote}
`;
}

function formatResidentSkillForPrompt(skill: SkillRecord) {
  const displayName = getSkillDisplayName(skill);
  const label = displayName && displayName !== skill.name ? promptT("label", { name: skill.name, displayName }) : skill.name;
  const header = [`### ${label}`];
  if (skill.description) header.push(promptT("description", { text: skill.description }));
  const content = String(skill.content || "").trim();
  const resources = (skill.resources || [])
    .filter(resource => resource?.path)
    .map(resource => `- ${resource.path}${resource.title ? promptT("resourceTitle", { title: resource.title }) : ""}`)
    .join("\n");
  const resourceSection = resources
    ? promptT("resources", { resources })
    : "";
  return `${header.join("\n")}\n\n${content || promptT("empty")}${resourceSection}`;
}

function formatSkillListItemForPrompt(skill: SkillRecord) {
  const displayName = getSkillDisplayName(skill);
  const label = displayName && displayName !== skill.name ? promptT("label", { name: skill.name, displayName }) : skill.name;
  return `- **${label}**: ${skill.description}`;
}

export { SKILL_SCOPE_GLOBAL, SKILL_SCOPE_RESIDENT, SKILL_SCOPE_SITE };
