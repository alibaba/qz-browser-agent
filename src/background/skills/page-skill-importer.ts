import { t } from "../../shared/i18n/backend.js";
import { isBuiltinSkillName } from "../../shared/skills/builtin-skills.js";
import { withoutGitSkillOrigin } from "../../shared/skills/git-skill-sources.js";
import { importSkillsZip } from "../../shared/skills/skill-package.js";
import {
  normalizeModernSkill,
  normalizeSkillLookup,
  skillEntriesByIdentity,
} from "../../shared/skills/skill-utils.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import { downloadGitArchiveFromTab, resolveDownloadDebuggerScope } from "./git-skill-sources.js";

import type { SkillRecord } from "../../shared/skills/skill-utils.js";
import type { createGitSkillSourceRepository } from "./git-skill-source-repository.js";
import type { GitDebuggerScopes, GitRuntime } from "./git-skill-sources.js";
type Fields = Record<string, unknown>;
interface PageImportOptions extends GitDebuggerScopes {
  repository: ReturnType<typeof createGitSkillSourceRepository>;
  importZip?: typeof importSkillsZip;
  validateSkill?(skill: SkillRecord, options: { refresh: boolean; signal?: AbortSignal }): Promise<unknown>;
  onSkillsChanged?(event: { action: string; names: string[] }): Promise<unknown>;
  now?(): string;
  downloadFromTab?(tabId: number, url: string, runtime: GitRuntime): Promise<ArrayBuffer>;
  downloadTimeoutMs?: number; maxArchiveBytes?: number;
}
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export class PageSkillImportError extends Error {
  constructor(readonly code: string, message: string, readonly details: Fields = {}) {
    super(message);
    this.name = "PageSkillImportError";
  }
}

export function createPageSkillImportService(options: PageImportOptions) {
  const repository = options.repository;
  if (!repository?.readSnapshot || !repository?.commitSnapshot) {
    throw new TypeError("Page skill importer requires a repository");
  }
  const importZip = options.importZip || importSkillsZip;
  const validateSkill = options.validateSkill || (async () => ({ ok: true }));
  const onSkillsChanged = options.onSkillsChanged || (async () => {});
  const now = options.now || nowBeijingDateTime;
  const downloadFromTab = options.downloadFromTab || ((tabId: number, url: string, runtime: GitRuntime = {}) => downloadGitArchiveFromTab(tabId, url, {
    withDebugger: resolveDownloadDebuggerScope(options, runtime.context),
    timeoutMs: options.downloadTimeoutMs,
    maxBytes: options.maxArchiveBytes,
    signal: runtime.signal,
  }));
  let operationQueue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>) {
    const run = operationQueue.then(operation, operation);
    operationQueue = run.catch(() => {});
    return run;
  }

  function importFromPage(input: Fields = {}, runtime: GitRuntime = {}) {
    return enqueue(async () => {
      throwIfAborted(runtime.signal);
      const tabId = positiveTabId(input.tabId);
      if (!tabId) {
        throw new PageSkillImportError(
          "PAGE_SKILL_ZIP_TAB_REQUIRED",
          t("skill.pageZipTabRequired"),
        );
      }
      const url = normalizeDownloadUrl(input.url || input.downloadUrl);
      if (!url) {
        throw new PageSkillImportError(
          "PAGE_SKILL_ZIP_URL_INVALID",
          t("skill.pageZipUrlInvalid"),
        );
      }

      let archive;
      try {
        archive = await downloadFromTab(tabId, url, { signal: runtime.signal, context: runtime.context });
        throwIfAborted(runtime.signal);
      } catch (error) {
        rethrowCancellation(error, runtime.signal);
        throw new PageSkillImportError(
          "PAGE_SKILL_ZIP_DOWNLOAD_FAILED",
          t("skill.pageZipAuthenticatedFailure", { reason: String(errorMessage(error)) }),
          {
            url,
            tabId,
            originalCode: record(error).code || "",
          },
        );
      }

      let imported;
      try {
        imported = await importZip(archive);
        throwIfAborted(runtime.signal);
      } catch (error) {
        rethrowCancellation(error, runtime.signal);
        throw new PageSkillImportError(
          "PAGE_SKILL_ZIP_INVALID",
          t("skill.pageZipInvalid", { reason: String(errorMessage(error)) }),
          { url, tabId },
        );
      }

      const rows = (Array.isArray(imported) ? imported : [])
        .map(skill => withoutGitSkillOrigin(normalizeModernSkill(skill)))
        .filter(skill => skill.name);
      if (!rows.length) {
        throw new PageSkillImportError(
          "PAGE_SKILL_ZIP_EMPTY",
          t("skill.pageZipNoSkill"),
          { url, tabId },
        );
      }
      const duplicateName = findDuplicateSkillName(rows);
      if (duplicateName) {
        throw new PageSkillImportError(
          "PAGE_SKILL_ZIP_DUPLICATE",
          t("skill.pageZipDuplicate", { name: String(duplicateName) }),
          { name: duplicateName, url, tabId },
        );
      }
      const builtinName = rows.find(skill => isBuiltinSkillName(skill.name))?.name;
      if (builtinName) {
        throw new PageSkillImportError(
          "SKILL_READ_ONLY",
          t("skill.pageZipBuiltin", { name: String(builtinName) }),
          { name: builtinName, url, tabId },
        );
      }

      const snapshot = await repository.readSnapshot();
      const existingSkills = Object.values(snapshot.skills || {})
        .map(skill => normalizeModernSkill(skill))
        .filter(skill => skill.name);
      const conflicts = rows
        .filter(incoming => existingSkills.some(existing => (
          normalizeSkillLookup(existing.name) === normalizeSkillLookup(incoming.name)
        )))
        .map(skill => ({ name: skill.name, reason: "name_conflict" }));
      if (conflicts.length && input.overwrite !== true) {
        return {
          ok: false,
          action: "conflict",
          code: "SKILL_IMPORT_NAME_CONFLICT",
          error: t("skill.pageZipConflict"),
          count: rows.length,
          names: rows.map(skill => skill.name),
          conflicts,
          url,
          tabId,
        };
      }

      for (const skill of rows) {
        throwIfAborted(runtime.signal);
        await validateSkill(skill, { refresh: true, signal: runtime.signal });
      }

      const updatedAt = now();
      const nextSkills = { ...snapshot.skills };
      for (const skill of rows) {
        const previous = existingSkills.find(existing => (
          normalizeSkillLookup(existing.name) === normalizeSkillLookup(skill.name)
        ));
        for (const { key } of skillEntriesByIdentity(nextSkills, skill.name)) delete nextSkills[key];
        nextSkills[skill.name] = normalizeModernSkill({
          ...skill,
          createdAt: previous?.createdAt || skill.createdAt || updatedAt,
          updatedAt,
        });
      }
      throwIfAborted(runtime.signal);
      await repository.commitSnapshot({ expected: snapshot, skills: nextSkills, sources: snapshot.sources });
      await onSkillsChanged({ action: "page_zip_import", names: rows.map(skill => skill.name) });
      return {
        ok: true,
        action: "imported",
        count: rows.length,
        names: rows.map(skill => skill.name),
        overwrittenCount: conflicts.length,
        overwrittenNames: conflicts.map(item => item.name),
        url,
        tabId,
        updatedAt,
      };
    });
  }

  return Object.freeze({ import: importFromPage });
}

function positiveTabId(value: unknown) {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : 0;
}

function normalizeDownloadUrl(value: unknown = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function findDuplicateSkillName(skills: readonly SkillRecord[] = []) {
  const seen = new Set();
  for (const skill of skills) {
    const lookup = normalizeSkillLookup(skill?.name);
    if (!lookup) continue;
    if (seen.has(lookup)) return skill.name;
    seen.add(lookup);
  }
  return "";
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new PageSkillImportError("OPERATION_ABORTED", t("skill.pageZipAborted"));
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined) {
  throwIfAborted(signal);
  if (record(error).name === "AbortError" || record(error).code === "OPERATION_ABORTED") throw error;
}
