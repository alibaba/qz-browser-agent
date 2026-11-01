import { t } from "../../shared/i18n/backend.js";
import { isBuiltinSkillName } from "../../shared/skills/builtin-skills.js";
import {
  getGitSkillOrigin,
  GIT_REPOSITORY_PROVIDER_GITHUB,
  gitRepositoryIdentity,
  gitRepositoryLocator,
  gitRepositoryProvider,
  gitSkillBelongsToSource,
  gitSkillSourceId,
  normalizeGitRepositoryUrl,
  normalizeGitSkillSource,
  sanitizeGitArchiveUrl,
  withGitSkillOrigin,
  withoutGitSkillOrigin,
} from "../../shared/skills/git-skill-sources.js";
import { importSkillsZip, skillToSkillMarkdown } from "../../shared/skills/skill-package.js";
import {
  skillEntriesByIdentity,
  modernSkillValuesFromRecord,
  normalizeModernSkill,
  normalizeSkillLookup,
} from "../../shared/skills/skill-utils.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";

import type { SkillRecord } from "../../shared/skills/skill-utils.js";
import type { GitSkillSource } from "../../shared/skills/git-skill-sources.js";
import type { createGitSkillSourceRepository } from "./git-skill-source-repository.js";
import type { NewTabTarget } from "../services/chrome-window-target.js";
type Fields = Record<string, unknown>;
export type GitExecutionContext = { sessionId?: string; runId?: string | null; workingTabId?: number | null; sourceWindowId?: number | null };
export type DebuggerCommand = (method: string, params?: Fields) => Promise<unknown>;
export type DebuggerOperation<T> = (target: chrome.debugger.Debuggee, send: DebuggerCommand) => T | Promise<T>;
export type DebuggerScope = <T>(tabId: number, operation: DebuggerOperation<T>) => Promise<T>;
export interface GitDebuggerScopes {
  withTemporaryDebugger?: DebuggerScope;
  withRunDebugger?<T>(tabId: number, context: GitExecutionContext, operation: DebuggerOperation<T>): Promise<T>;
}
export interface GitRuntime { signal?: AbortSignal; context?: GitExecutionContext }
interface ProbeOptions {
  tabs?: Pick<typeof chrome.tabs, "query" | "create" | "get" | "update">;
  scripting?: Pick<typeof chrome.scripting, "executeScript">;
  sleep?(ms: number): Promise<unknown>;
  timeoutMs?: number; pollIntervalMs?: number; tabId?: number; anchorTabId?: number | null; sourceWindowId?: number | null;
  windowTarget?: { resolveForNewTab(options: NewTabTarget): Promise<number> };
  signal?: AbortSignal;
}
interface RepositoryProbe { repositoryUrl?: string; currentUrl?: string; archiveUrl?: string; branch?: string; revision?: string; projectId?: string; tabId?: number }
interface GitSourceOptions extends GitDebuggerScopes, Pick<ProbeOptions, "tabs" | "scripting" | "windowTarget" | "sleep"> {
  repository: ReturnType<typeof createGitSkillSourceRepository>;
  importZip?: typeof importSkillsZip;
  validateSkill?(skill: SkillRecord, options: { refresh: boolean; signal?: AbortSignal }): Promise<unknown>;
  onSkillsChanged?(event: { action: string; sourceId: string; names: string[] }): Promise<unknown>;
  now?(): string;
  digest?(bytes: ArrayBuffer | Uint8Array): Promise<string>;
  repositoryProbe?(url: string, options: ProbeOptions): Promise<RepositoryProbe>;
  downloadFromTab?(tabId: number, url: string, runtime: GitRuntime): Promise<ArrayBuffer>;
  probeTimeoutMs?: number; pollIntervalMs?: number; archiveTimeoutMs?: number; maxArchiveBytes?: number;
}
interface GitSourceInput extends Fields { tabId?: number; sourceWindowId?: number | null }
interface SynchronizeOptions extends GitRuntime {
  repositoryUrl: string; browseUrl?: string; ref?: string; subpath?: string; tabId?: number; sourceId: string;
  overwrite: boolean; apply?: boolean; sourceWindowId?: number | null;
}
export interface GitArchiveOptions { withDebugger?: DebuggerScope | null; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }
interface PageElement {
  getAttribute(name: string): string | null; textContent?: string | null; title?: string;
  dataset?: Record<string, string | undefined>; content?: string;
}
interface GitPageScope {
  location: { href: string };
  document: { title: string; scripts: ArrayLike<PageElement>; querySelector(selector: string): PageElement | null; querySelectorAll(selector: string): ArrayLike<PageElement> };
}
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const DEFAULT_ARCHIVE_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 700;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

export class GitSkillSourceError extends Error {
  constructor(readonly code: string, message: string, readonly details: Fields = {}) {
    super(message);
    this.name = "GitSkillSourceError";
  }
}

export function createGitSkillSourceService(options: GitSourceOptions) {
  const repository = options.repository;
  if (!repository?.readSnapshot || !repository?.commitSnapshot) {
    throw new TypeError("Git skill source service requires a repository");
  }
  const tabs = options.tabs || globalThis.chrome?.tabs;
  const scripting = options.scripting || globalThis.chrome?.scripting;
  const windowTarget = options.windowTarget;
  const importZip = options.importZip || importSkillsZip;
  const validateSkill = options.validateSkill || (async () => ({ ok: true }));
  const onSkillsChanged = options.onSkillsChanged || (async () => {});
  const now = options.now || nowBeijingDateTime;
  const digest = options.digest || sha256Hex;
  const sleep = options.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const repositoryProbe = options.repositoryProbe || ((repositoryUrl: string, probeOptions: ProbeOptions = {}) => discoverGitRepository(repositoryUrl, {
    tabs,
    scripting,
    sleep,
    timeoutMs: options.probeTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    tabId: probeOptions.tabId,
    anchorTabId: probeOptions.anchorTabId,
    sourceWindowId: probeOptions.sourceWindowId,
    windowTarget,
    signal: probeOptions.signal,
  }));
  const downloadFromTab = options.downloadFromTab || ((tabId: number, archiveUrl: string, runtime: GitRuntime = {}) => downloadGitArchiveFromTab(tabId, archiveUrl, {
    withDebugger: resolveDownloadDebuggerScope(options, runtime.context),
    timeoutMs: options.archiveTimeoutMs,
    maxBytes: options.maxArchiveBytes,
    signal: runtime.signal,
  }));
  let operationQueue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>) {
    const run = operationQueue.then(operation, operation);
    operationQueue = run.catch(() => {});
    return run;
  }

  async function list() {
    const snapshot = await repository.readSnapshot();
    const skills = modernSkillValuesFromRecord(snapshot.skills);
    const sources = [];
    for (const source of Object.values(snapshot.sources)) {
      const owned = skills.filter(skill => gitSkillBelongsToSource(skill, source.id));
      const ownedNames = new Set(owned.map(skill => getGitSkillOrigin(skill)?.skillName || skill.name));
      const missingCount = source.skillNames.filter(name => !ownedNames.has(name)).length;
      let modifiedCount = 0;
      for (const skill of owned) {
        const origin = getGitSkillOrigin(skill);
        const expected = source.skillDigests[origin?.skillName || skill.name] || "";
        if (expected && await skillDigest(skill, digest) !== expected) modifiedCount += 1;
      }
      sources.push(publicGitSource(source, { missingCount, modifiedCount }));
    }
    return { sources: sources.sort(compareGitSources) };
  }

  function bind(input: GitSourceInput = {}, runtime: GitRuntime = {}) {
    return enqueue(async () => {
      throwIfAborted(runtime.signal);
      const locator = gitRepositoryLocator(input.repositoryUrl || input.url);
      if (!locator?.repositoryUrl) {
        throw new GitSkillSourceError("GIT_REPOSITORY_URL_INVALID", t("git.enterRepositoryUrl"));
      }
      assertSupportedGitRepository(locator.repositoryUrl);
      const snapshot = await repository.readSnapshot();
      const existing = Object.values(snapshot.sources).find(source => source.repositoryUrl === locator.repositoryUrl) || null;
      const sameSelection = existing
        && String(existing.ref || "") === locator.ref
        && String(existing.subpath || "") === locator.subpath;
      if (existing && !sameSelection) {
        const currentScope = existing.subpath ? t("git.directory", { path: String(existing.subpath) }) : t("git.entireRepository");
        throw new GitSkillSourceError(
          "GIT_REPOSITORY_ALREADY_BOUND",
          t("git.alreadyBound", { scope: String(currentScope) }),
          { source: publicGitSource(existing) },
        );
      }
      return synchronize({
        repositoryUrl: locator.repositoryUrl,
        browseUrl: locator.browseUrl,
        ref: locator.ref,
        subpath: locator.subpath,
        tabId: input.tabId,
        sourceWindowId: input.sourceWindowId ?? runtime.context?.sourceWindowId,
        signal: runtime.signal,
        context: runtime.context,
        sourceId: existing?.id || gitSkillSourceId(locator.repositoryUrl, locator),
        overwrite: input.overwrite === true,
      });
    });
  }

  function update(input: GitSourceInput = {}) {
    return enqueue(async () => {
      const sourceId = String(input.sourceId || input.id || "").trim();
      const source = sourceId ? await repository.getSource(sourceId) : null;
      if (!source) throw new GitSkillSourceError("GIT_SKILL_SOURCE_NOT_FOUND", t("git.bindingMissing"));
      return synchronize({
        repositoryUrl: source.repositoryUrl,
        browseUrl: source.browseUrl,
        ref: source.ref,
        subpath: source.subpath,
        sourceId: source.id,
        overwrite: input.overwrite === true,
        sourceWindowId: input.sourceWindowId,
      });
    });
  }

  function check(input: GitSourceInput = {}) {
    return enqueue(async () => {
      const sourceId = String(input.sourceId || input.id || "").trim();
      const source = sourceId ? await repository.getSource(sourceId) : null;
      if (!source) throw new GitSkillSourceError("GIT_SKILL_SOURCE_NOT_FOUND", t("git.bindingMissing"));
      return synchronize({
        repositoryUrl: source.repositoryUrl,
        browseUrl: source.browseUrl,
        ref: source.ref,
        subpath: source.subpath,
        sourceId: source.id,
        overwrite: false,
        apply: false,
        sourceWindowId: input.sourceWindowId,
      });
    });
  }

  function remove(input: GitSourceInput = {}) {
    return enqueue(async () => {
      const sourceId = String(input.sourceId || input.id || "").trim();
      const snapshot = await repository.readSnapshot();
      const source = snapshot.sources[sourceId];
      if (!source) throw new GitSkillSourceError("GIT_SKILL_SOURCE_NOT_FOUND", t("git.bindingMissing"));

      const nextSkills = { ...snapshot.skills };
      const deleteUnmodifiedSkills = input.deleteUnmodifiedSkills === true;
      let detachedCount = 0;
      let deletedCount = 0;
      let preservedModifiedCount = 0;
      for (const [key, value] of Object.entries(nextSkills)) {
        if (!gitSkillBelongsToSource(value, sourceId)) continue;
        const origin = getGitSkillOrigin(value);
        const sourceSkillName = origin?.skillName || String(record(value).name || key);
        const expectedDigest = source.skillDigests?.[sourceSkillName] || "";
        const unchanged = expectedDigest && await skillDigest(value, digest) === expectedDigest;
        if (deleteUnmodifiedSkills && unchanged) {
          delete nextSkills[key];
          deletedCount += 1;
          continue;
        }
        nextSkills[key] = withoutGitSkillOrigin(value, sourceId);
        detachedCount += 1;
        if (deleteUnmodifiedSkills) preservedModifiedCount += 1;
      }
      const nextSources = { ...snapshot.sources };
      delete nextSources[sourceId];
      await repository.commitSnapshot({ expected: snapshot, skills: nextSkills, sources: nextSources });
      const action = deleteUnmodifiedSkills ? "unbound_and_cleaned" : "unbound";
      await onSkillsChanged({ action, sourceId, names: source.skillNames });
      return { ok: true, action, sourceId, detachedCount, deletedCount, preservedModifiedCount };
    });
  }

  async function synchronize({ repositoryUrl, browseUrl, ref, subpath, tabId: requestedTabId, sourceId, overwrite, apply = true, sourceWindowId = null, signal, context = {} }: SynchronizeOptions) {
    throwIfAborted(signal);
    const identity = gitRepositoryIdentity(repositoryUrl);
    if (!identity || !sourceId) throw new GitSkillSourceError("GIT_REPOSITORY_URL_INVALID", t("git.invalidUrl"));
    assertSupportedGitRepository(identity.repositoryUrl);
    const probe = await repositoryProbe(browseUrl || identity.repositoryUrl, {
      tabId: requestedTabId,
      anchorTabId: context?.workingTabId,
      sourceWindowId: sourceWindowId ?? context?.sourceWindowId,
      signal,
    });
    throwIfAborted(signal);
    const resolved = resolveGitRepositoryProbe(identity.repositoryUrl, {
      ...probe,
      branch: String(ref || probe?.branch || "").trim(),
    });
    if (!resolved.archiveUrl) {
      throw new GitSkillSourceError("GIT_ARCHIVE_NOT_FOUND", t("git.zipUrlMissing"), {
        repositoryUrl: identity.repositoryUrl,
      });
    }

    const tabId = Number(probe?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new GitSkillSourceError(
        "GIT_REPOSITORY_TAB_CLOSED",
        t("git.tabUnavailableRetry"),
      );
    }
    const archive = await downloadFromTab(tabId, resolved.archiveUrl, { signal, context });
    throwIfAborted(signal);
    let archiveDigest = await digest(archive);
    let imported;
    try {
      imported = await importZip(archive, { subpath });
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      if (record(error).code === "OPERATION_ABORTED" || record(error).name === "AbortError") throw error;
      throw new GitSkillSourceError("GIT_ARCHIVE_INVALID", t("git.invalidSkillZip", { reason: String(errorMessage(error)) }));
    }
    const rows = (Array.isArray(imported) ? imported : [])
      .map(normalizeModernSkill)
      .filter(skill => skill.name);
    if (!rows.length) {
      const location = subpath ? t("git.directory", { path: String(subpath) }) : t("git.repository");
      throw new GitSkillSourceError("GIT_ARCHIVE_NO_SKILLS", t("git.noSkillInLocation", { location: String(location) }));
    }
    const duplicateName = findDuplicateSkillName(rows);
    if (duplicateName) {
      throw new GitSkillSourceError(
        "GIT_ARCHIVE_DUPLICATE_SKILL",
        t("git.duplicateSkill", { name: String(duplicateName) }),
      );
    }
    const builtinName = rows.find(skill => isBuiltinSkillName(skill.name))?.name;
    if (builtinName) {
      throw new GitSkillSourceError("GIT_ARCHIVE_BUILTIN_CONFLICT", t("git.builtinSkill", { name: String(builtinName) }));
    }

    const checkedAt = now();
    const snapshot = await repository.readSnapshot();
    const previousSource = snapshot.sources[sourceId] || null;
    const incomingDigests: Record<string, string> = {};
    for (const skill of rows) incomingDigests[skill.name] = await skillDigest(skill, digest);
    if (subpath) {
      const selectionBytes = new TextEncoder().encode(JSON.stringify(Object.entries(incomingDigests).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
      archiveDigest = await digest(selectionBytes.buffer);
    }
    const sourceDraft = requireGitSkillSource({
      ...previousSource,
      id: sourceId,
      repositoryUrl: identity.repositoryUrl,
      browseUrl,
      name: identity.name,
      ref,
      subpath,
      branch: resolved.branch,
      revision: resolved.revision,
      archiveUrl: resolved.archiveUrl,
      archiveDigest,
      skillNames: rows.map(skill => skill.name),
      skillDigests: incomingDigests,
      createdAt: previousSource?.createdAt || checkedAt,
      importedAt: checkedAt,
      checkedAt,
      updatedAt: checkedAt,
    });
    const existingSkills = modernSkillValuesFromRecord(snapshot.skills);
    const ownedSkills = existingSkills.filter(skill => gitSkillBelongsToSource(skill, sourceId));
    const ownedKeys = new Set(ownedSkills.map(skill => normalizeSkillLookup(skill.name)));
    const nameConflicts = [];
    for (const incoming of rows) {
      const existing = existingSkills.find(candidate => (
        normalizeSkillLookup(candidate.name) === normalizeSkillLookup(incoming.name)
        && !ownedKeys.has(normalizeSkillLookup(candidate.name))
      ));
      if (!existing) continue;
      const [existingPackageDigest, incomingPackageDigest] = await Promise.all([
        portableSkillDigest(existing, digest),
        portableSkillDigest(incoming, digest),
      ]);
      if (existingPackageDigest !== incomingPackageDigest) {
        nameConflicts.push({ name: incoming.name, reason: "name_conflict" });
      }
    }
    const localChanges = [];
    for (const skill of ownedSkills) {
      const origin = getGitSkillOrigin(skill);
      const sourceSkillName = origin?.skillName || skill.name;
      const expectedDigest = previousSource?.skillDigests?.[sourceSkillName] || "";
      if (expectedDigest && await skillDigest(skill, digest) !== expectedDigest) {
        localChanges.push({ name: skill.name, sourceSkillName, reason: "local_changes" });
      }
    }
    const conflicts = [...nameConflicts, ...localChanges];
    const incomingNames = new Set(rows.map(skill => skill.name));
    const ownedSourceNames = new Set(ownedSkills.map(skill => getGitSkillOrigin(skill)?.skillName || skill.name));
    const missingCount = rows.filter(skill => !ownedSourceNames.has(skill.name)).length;
    const extraCount = ownedSkills.filter(skill => !incomingNames.has(getGitSkillOrigin(skill)?.skillName || skill.name)).length;
    const sameArchive = Boolean(previousSource?.archiveDigest && previousSource.archiveDigest === archiveDigest);
    if (!apply) {
      const localMissingCount = previousSource?.skillNames?.filter(name => !ownedSourceNames.has(name)).length || 0;
      const remoteChanged = !sameArchive;
      const updateAvailable = remoteChanged
        || missingCount > 0
        || extraCount > 0
        || localChanges.length > 0
        || nameConflicts.length > 0;
      return {
        ok: true,
        action: "checked",
        changed: updateAvailable,
        updateAvailable,
        remoteChanged,
        repairAvailable: !remoteChanged && updateAvailable,
        count: rows.length,
        names: rows.map(skill => skill.name),
        conflicts,
        checkedAt,
        remoteRevision: sourceDraft.revision,
        changes: {
          addedCount: missingCount,
          removedCount: extraCount,
          localModifiedCount: localChanges.length,
          nameConflictCount: nameConflicts.length,
        },
        source: publicGitSource(previousSource, {
          missingCount: localMissingCount,
          modifiedCount: localChanges.length,
        }),
        candidateSource: publicGitSource(sourceDraft),
      };
    }
    if (conflicts.length && !overwrite) {
      return {
        ok: false,
        code: localChanges.length ? "local_changes" : "name_conflict",
        message: localChanges.length ? t("git.localChanges") : t("git.nameConflict"),
        conflicts,
        source: publicGitSource(sourceDraft),
      };
    }

    for (const skill of rows) {
      throwIfAborted(signal);
      await validateSkill(skill, { refresh: true, signal });
    }
    if (previousSource && sameArchive && !missingCount && !extraCount && !localChanges.length && !nameConflicts.length) {
      const currentSource = requireGitSkillSource({
        ...sourceDraft,
        skillDigests: previousSource.skillDigests,
      });
      const nextSources = { ...snapshot.sources, [sourceId]: currentSource };
      throwIfAborted(signal);
      await repository.commitSnapshot({ expected: snapshot, skills: snapshot.skills, sources: nextSources });
      return {
        ok: true,
        action: "current",
        changed: false,
        count: rows.length,
        names: rows.map(skill => skill.name),
        source: publicGitSource(currentSource),
      };
    }

    const nextSkills = { ...snapshot.skills };
    const removedNames = [];
    for (const [key, skill] of Object.entries(nextSkills)) {
      if (!gitSkillBelongsToSource(skill, sourceId)) continue;
      removedNames.push(String(record(skill).name || key));
      delete nextSkills[key];
    }
    const installedDigests: Record<string, string> = {};
    for (const skill of rows) {
      for (const { key } of skillEntriesByIdentity(nextSkills, skill.name)) delete nextSkills[key];
      const installed = withGitSkillOrigin(skill, sourceDraft, {
        skillName: skill.name,
        importedAt: checkedAt,
      });
      nextSkills[skill.name] = installed;
      installedDigests[skill.name] = await skillDigest(installed, digest);
    }
    const installedSource = requireGitSkillSource({
      ...sourceDraft,
      skillDigests: installedDigests,
    });
    const nextSources = { ...snapshot.sources, [sourceId]: installedSource };
    throwIfAborted(signal);
    await repository.commitSnapshot({ expected: snapshot, skills: nextSkills, sources: nextSources });
    const action = previousSource ? (sameArchive ? "repaired" : "updated") : "bound";
    await onSkillsChanged({ action, sourceId, names: rows.map(skill => skill.name) });
    return {
      ok: true,
      action,
      changed: true,
      count: rows.length,
      names: rows.map(skill => skill.name),
      removedNames: removedNames.filter(name => !incomingNames.has(name)),
      source: publicGitSource(installedSource),
    };
  }

  return Object.freeze({ list, bind, check, update, remove });
}

function findDuplicateSkillName(skills: readonly SkillRecord[] = []) {
  const seen = new Set();
  for (const skill of skills) {
    const lookup = normalizeSkillLookup(record(skill).name);
    if (!lookup) continue;
    if (seen.has(lookup)) return skill.name;
    seen.add(lookup);
  }
  return "";
}

function assertSupportedGitRepository(repositoryUrl: string) {
  if (gitRepositoryProvider(repositoryUrl)) return;
  throw new GitSkillSourceError(
    "GIT_REPOSITORY_HOST_UNSUPPORTED",
    t("git.unsupportedRepository"),
    { repositoryUrl },
  );
}

export async function discoverGitRepository(repositoryUrl: string, options: ProbeOptions = {}) {
  const tabs = options.tabs || globalThis.chrome?.tabs;
  const scripting = options.scripting || globalThis.chrome?.scripting;
  if (!tabs?.query || !tabs?.create || !tabs?.get || !tabs?.update || !scripting?.executeScript) {
    throw new GitSkillSourceError("GIT_BROWSER_UNAVAILABLE", t("git.browserUnavailable"));
  }
  throwIfAborted(options.signal);
  const locator = gitRepositoryLocator(repositoryUrl);
  const normalized = locator?.repositoryUrl || "";
  if (!locator || !normalized) throw new GitSkillSourceError("GIT_REPOSITORY_URL_INVALID", t("git.invalidUrl"));
  assertSupportedGitRepository(normalized);
  const requestedTabId = Number(options.tabId);
  let existing: chrome.tabs.Tab | null = null;
  if (Number.isInteger(requestedTabId) && requestedTabId > 0) {
    try { existing = await tabs.get(requestedTabId); } catch (_error) { existing = null; }
    if (!existing) {
      throw new GitSkillSourceError("GIT_REPOSITORY_TAB_CLOSED", t("git.taskTabClosed"));
    }
  } else {
    existing = (await tabs.query({})).find(tab => normalizeGitRepositoryUrl(tab?.url) === normalized) || null;
  }
  throwIfAborted(options.signal);
  const existingLocator = gitRepositoryLocator(existing?.url || existing?.pendingUrl);
  const sameSelection = existingLocator
    && existingLocator.repositoryUrl === normalized
    && existingLocator.ref === locator.ref
    && existingLocator.subpath === locator.subpath;
  let tab;
  if (existing?.id) {
    tab = await tabs.update(existing.id, { active: true, ...(sameSelection ? {} : { url: locator.browseUrl }) });
  } else {
    const resolver = options.windowTarget?.resolveForNewTab;
    if (typeof resolver !== "function") {
      throw new GitSkillSourceError("GIT_BROWSER_WINDOW_UNAVAILABLE", t("git.windowUnknown"));
    }
    const windowId = await resolver({
      anchorTabId: options.anchorTabId,
      sourceWindowId: options.sourceWindowId,
    });
    tab = await tabs.create({ windowId, url: locator.browseUrl, active: true });
  }
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new GitSkillSourceError("GIT_REPOSITORY_TAB_FAILED", t("git.tabOpenFailed"));
  }

  const timeoutMs = clampNumber(options.timeoutMs, 5_000, 300_000, DEFAULT_PROBE_TIMEOUT_MS);
  const pollIntervalMs = clampNumber(options.pollIntervalMs, 100, 5_000, DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    let current;
    try {
      current = await tabs.get(tabId);
    } catch (_error) {
      throw new GitSkillSourceError("GIT_REPOSITORY_TAB_CLOSED", t("git.tabClosed"));
    }
    if (current?.status === "complete") {
      try {
        const [{ result } = {}] = await scripting.executeScript({
          target: { tabId },
          func: inspectGitRepositoryPage,
          args: [normalized],
        });
        const resolved = resolveGitRepositoryProbe(normalized, {
          ...(result || {}),
          branch: locator.ref || result?.branch || "",
        });
        if (resolved.archiveUrl) return { ...resolved, tabId, browseUrl: locator.browseUrl, ref: locator.ref, subpath: locator.subpath };
      } catch (_error) {
        // Login and browser-internal pages are not scriptable; keep waiting for the repository page.
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new GitSkillSourceError(
    "GIT_REPOSITORY_PROBE_TIMEOUT",
    t("git.loginTimeout"),
    { repositoryUrl: normalized, tabId },
  );
}

export function inspectGitRepositoryPage(repositoryUrl = "") {
  // Chrome executes this self-contained function in the page, not the worker.
  const { document, location } = globalThis as unknown as GitPageScope;
  const absolute = (value: unknown) => {
    try { return new URL(String(value || ""), location.href).href; } catch (_error) { return ""; }
  };
  const repository = absolute(repositoryUrl);
  const repositoryOrigin = (() => {
    try { return new URL(repository).origin; } catch (_error) { return ""; }
  })();
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const archiveCandidates = anchors
    .map(anchor => ({
      url: absolute(anchor.getAttribute("href")),
      text: String(anchor.textContent || anchor.title || anchor.getAttribute("aria-label") || "").trim(),
    }))
    .filter(item => {
      if (!item.url) return false;
      try {
        const url = new URL(item.url);
        return url.origin === repositoryOrigin
          && (/\/repository\/archive(?:\.zip)?/iu.test(url.pathname) || /\/-\/archive\//u.test(url.pathname) || /\.zip$/iu.test(url.pathname));
      } catch (_error) {
        return false;
      }
    })
    .sort((left, right) => archiveScore(right) - archiveScore(left));

  const branchElement = document.querySelector(
    "[data-default-branch], [data-branch], .js-project-refs-dropdown button, .js-branch-dropdown button, [data-testid='ref-selector']",
  );
  const branchMeta = document.querySelector("meta[name='project:default_branch'], meta[name='default_branch'], meta[name='octolytics-dimension-repository_default_branch']");
  const scriptText = Array.from(document.scripts)
    .map(script => script.textContent || "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_500_000);
  const branchMatch = scriptText.match(/(?:default_branch|defaultBranch|selected_ref)["']?\s*[:=]\s*["']([^"']+)["']/iu)
    || scriptText.match(/["']defaultBranchRef["']\s*:\s*\{[^{}]*["']name["']\s*:\s*["']([^"']+)["']/iu);
  const branch = String(
    branchElement?.dataset?.defaultBranch
      || branchElement?.dataset?.branch
      || branchMeta?.content
      || branchMatch?.[1]
      || "",
  ).trim();
  const projectNode = document.querySelector("[data-project-id]");
  const projectMatch = scriptText.match(/(?:current_project_id|project_id|projectId)["']?\s*[:=]\s*["']?(\d+)/u);
  const projectId = String(projectNode?.dataset?.projectId || projectMatch?.[1] || "").trim();
  const revisionNode = document.querySelector("[data-commit-sha], [data-commit-id], meta[name='current_revision']");
  const revisionHref = anchors.map(anchor => anchor.getAttribute("href") || "").find(href => /\/commit\/[a-f\d]{7,64}(?:[/?#]|$)/iu.test(href)) || "";
  const revisionMatch = String(
    revisionNode?.dataset?.commitSha
      || revisionNode?.dataset?.commitId
      || revisionNode?.content
      || revisionHref.match(/\/commit\/([a-f\d]{7,64})/iu)?.[1]
      || scriptText.match(/(?:commit_sha|commitSha|current_revision)["']?\s*[:=]\s*["']([a-f\d]{7,64})["']/iu)?.[1]
      || "",
  ).trim();
  return {
    currentUrl: location.href,
    title: document.title || "",
    archiveUrl: archiveCandidates[0]?.url || "",
    branch,
    revision: revisionMatch,
    projectId,
  };

  function archiveScore(item: { url: string; text: string }) {
    let score = 0;
    if (/\/repository\/archive\.zip/iu.test(item.url)) score += 8;
    if (/\/-\/archive\//u.test(item.url)) score += 6;
    if (/zip/iu.test(item.text)) score += 4;
    if (/download|下载/iu.test(item.text)) score += 2;
    return score;
  }
}

export function resolveGitRepositoryProbe(repositoryUrl = "", probe: RepositoryProbe = {}) {
  const identity = gitRepositoryIdentity(repositoryUrl);
  if (!identity) return { repositoryUrl: "", archiveUrl: "", branch: "", revision: "" };
  const currentRepositoryUrl = normalizeGitRepositoryUrl(probe.currentUrl);
  const pageMatchesRepository = currentRepositoryUrl === identity.repositoryUrl;
  const hasRepositorySignal = Boolean(probe.archiveUrl || probe.projectId || pageMatchesRepository);
  if (!hasRepositorySignal) {
    return { repositoryUrl: identity.repositoryUrl, archiveUrl: "", branch: "", revision: "" };
  }
  const branchFromArchive = archiveBranch(probe.archiveUrl);
  const branch = String(probe.branch || branchFromArchive || "main").trim();
  let archiveUrl = sanitizeGitArchiveUrl(probe.archiveUrl, identity.repositoryUrl);
  if (!archiveUrl) {
    const url = new URL(identity.repositoryUrl);
    const projectId = String(probe.projectId || "").trim();
    if (projectId && /^\d+$/u.test(projectId)) {
      const derived = new URL(`/api/v3/projects/${projectId}/repository/archive.zip`, url.origin);
      derived.searchParams.set("sha", branch);
      derived.searchParams.set("path", "");
      archiveUrl = sanitizeGitArchiveUrl(derived.href, identity.repositoryUrl);
    } else if (gitRepositoryProvider(identity.repositoryUrl) === GIT_REPOSITORY_PROVIDER_GITHUB) {
      archiveUrl = sanitizeGitArchiveUrl(`${identity.repositoryUrl}/archive/refs/heads/${encodeURIComponent(branch)}.zip`, identity.repositoryUrl);
    } else {
      const filename = `${identity.name}-${branch}.zip`;
      archiveUrl = sanitizeGitArchiveUrl(`${identity.repositoryUrl}/-/archive/${encodeURIComponent(branch)}/${encodeURIComponent(filename)}`, identity.repositoryUrl);
    }
  }
  return {
    repositoryUrl: identity.repositoryUrl,
    archiveUrl,
    branch,
    revision: String(probe.revision || "").trim(),
  };
}

export async function downloadGitArchiveFromTab(tabId: unknown, archiveUrl: string, options: GitArchiveOptions = {}) {
  const withDebugger = typeof options.withDebugger === "function" ? options.withDebugger : null;
  if (!withDebugger) {
    throw new GitSkillSourceError("GIT_AUTHENTICATED_DOWNLOAD_UNAVAILABLE", t("git.authenticatedDownloadUnavailable"));
  }
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw new GitSkillSourceError("GIT_REPOSITORY_TAB_CLOSED", t("git.tabUnavailable"));
  const timeoutMs = clampNumber(options.timeoutMs, 1_000, 180_000, DEFAULT_ARCHIVE_TIMEOUT_MS);
  const maxBytes = clampNumber(options.maxBytes, 1_024, 128 * 1024 * 1024, MAX_ARCHIVE_BYTES);
  const signal = options.signal;
  throwIfAborted(signal);
  const deadline = Date.now() + timeoutMs;
  try {
    return await withDebugger(id, async (_target, send) => {
      let stream = "";
      try {
        const frameTree = await cdpCommand(send, "Page.getFrameTree", {}, deadline);
        throwIfAborted(signal);
        const frameId = String(record(record(frameTree.frameTree).frame).id || "").trim();
        if (!frameId) throw new GitSkillSourceError("GIT_AUTHENTICATED_DOWNLOAD_FAILED", t("git.frameMissing"));
        const loaded = await cdpCommand(send, "Network.loadNetworkResource", {
          frameId,
          url: archiveUrl,
          options: { disableCache: true, includeCredentials: true },
        }, deadline);
        throwIfAborted(signal);
        const resource = record(loaded.resource);
        const status = Number(resource.httpStatusCode || 0);
        if (!resource.success || (status && (status < 200 || status >= 300))) {
          throw new GitSkillSourceError(
            "GIT_AUTHENTICATED_DOWNLOAD_FAILED",
            status ? t("git.zipHttpFailure", { status: String(status) }) : t("git.zipDownloadFailed"),
            { status },
          );
        }
        stream = String(resource.stream || "").trim();
        if (!stream) throw new GitSkillSourceError("GIT_AUTHENTICATED_DOWNLOAD_FAILED", t("git.zipStreamUnavailable"));

        const chunks = [];
        let totalBytes = 0;
        let eof = false;
        while (!eof) {
          throwIfAborted(signal);
          const chunk = await cdpCommand(send, "IO.read", {
            handle: stream,
            size: Math.min(512 * 1024, maxBytes - totalBytes + 1),
          }, deadline);
          const bytes = decodeCdpChunk(String(chunk.data || ""), chunk.base64Encoded === true);
          totalBytes += bytes.byteLength;
          if (totalBytes > maxBytes) throw new GitSkillSourceError("GIT_ARCHIVE_TOO_LARGE", t("git.zipTooLarge"));
          if (bytes.byteLength) chunks.push(bytes);
          eof = chunk.eof === true;
        }
        const buffer = joinByteChunks(chunks, totalBytes);
        throwIfAborted(signal);
        assertZipBytes(buffer);
        return buffer;
      } finally {
        if (stream) {
          try { await send("IO.close", { handle: stream }); } catch (_error) {}
        }
      }
    });
  } catch (error) {
    if (error instanceof GitSkillSourceError) throw error;
    throw new GitSkillSourceError("GIT_AUTHENTICATED_DOWNLOAD_FAILED", t("git.zipAuthenticatedFailure", { reason: String(errorMessage(error)) }));
  }
}

export function resolveDownloadDebuggerScope(options: GitDebuggerScopes = {}, context: GitExecutionContext = {}): DebuggerScope | null {
  const sessionId = String(context?.sessionId || "").trim();
  const runId = String(context?.runId || "").trim();
  if (sessionId || runId) {
    if (!sessionId || !runId || typeof options.withRunDebugger !== "function") return null;
    return (tabId, operation) => options.withRunDebugger!(tabId, context, operation);
  }
  return typeof options.withTemporaryDebugger === "function" ? options.withTemporaryDebugger : null;
}

function publicGitSource(source: GitSkillSource | null, status: { missingCount?: number; modifiedCount?: number } = {}) {
  if (!source) throw new GitSkillSourceError("GIT_SKILL_SOURCE_NOT_FOUND", t("git.bindingMissing"));
  return {
    id: source.id,
    repositoryUrl: source.repositoryUrl,
    browseUrl: source.browseUrl,
    host: source.host,
    namespace: source.namespace,
    name: source.name,
    ref: source.ref,
    subpath: source.subpath,
    branch: source.branch,
    revision: source.revision,
    skillNames: [...source.skillNames],
    createdAt: source.createdAt,
    importedAt: source.importedAt,
    checkedAt: source.checkedAt,
    updatedAt: source.updatedAt,
    missingCount: Number(status.missingCount || 0),
    modifiedCount: Number(status.modifiedCount || 0),
  };
}

async function cdpCommand(send: DebuggerCommand, method: string, params: Fields, deadline: number): Promise<Fields> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new GitSkillSourceError("GIT_ARCHIVE_TIMEOUT", t("git.zipTimeout"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      send(method, params).then(record),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GitSkillSourceError("GIT_ARCHIVE_TIMEOUT", t("git.zipTimeout"))), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function decodeCdpChunk(data: string, base64Encoded: boolean) {
  if (!data) return new Uint8Array();
  if (!base64Encoded) return new TextEncoder().encode(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function joinByteChunks(chunks: readonly Uint8Array[], totalBytes: number) {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function assertZipBytes(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new GitSkillSourceError("GIT_ARCHIVE_AUTH_REQUIRED", t("git.notZip"));
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new GitSkillSourceError("OPERATION_ABORTED", t("git.aborted"));
}

async function skillDigest(skill: unknown, digest: NonNullable<GitSourceOptions["digest"]>) {
  const detached = withoutGitSkillOrigin(normalizeModernSkill(skill));
  const comparable = { ...detached };
  delete comparable.createdAt;
  delete comparable.updatedAt;
  return digest(new TextEncoder().encode(stableJson(comparable)).buffer);
}

async function portableSkillDigest(skill: unknown, digest: NonNullable<GitSourceOptions["digest"]>) {
  const detached = withoutGitSkillOrigin(normalizeModernSkill(skill));
  const files = [
    { path: "SKILL.md", content: skillToSkillMarkdown(detached) },
    ...(detached.resources || []).map(resource => ({
      path: String(resource.path || ""),
      content: String(resource.content || ""),
      encoding: String(resource.encoding || ""),
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  return digest(new TextEncoder().encode(stableJson(files)).buffer);
}

async function sha256Hex(value: ArrayBuffer | Uint8Array) {
  const buffer = value instanceof ArrayBuffer
    ? value
    : ArrayBuffer.isView(value)
      ? Uint8Array.from(value).buffer
      : new TextEncoder().encode(String(value || "")).buffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(record(value)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function archiveBranch(value: unknown = "") {
  try {
    const url = new URL(String(value || ""));
    return url.searchParams.get("sha") || url.searchParams.get("ref") || "";
  } catch (_error) {
    return "";
  }
}

function compareGitSources(left: { updatedAt?: string; name?: string }, right: { updatedAt?: string; name?: string }) {
  return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
    || String(left.name || "").localeCompare(String(right.name || ""), "zh-CN");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function requireGitSkillSource(input: unknown): GitSkillSource {
  const source = normalizeGitSkillSource(input);
  if (!source) throw new GitSkillSourceError("GIT_REPOSITORY_URL_INVALID", t("git.invalidUrl"));
  return source;
}
