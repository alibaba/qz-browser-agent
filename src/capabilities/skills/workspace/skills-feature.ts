import { t, getLocale } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { readSkillYamlString, readSkillYamlStringList } from "#sdk/shared/skills";
import type { SkillWorkspaceSnapshot } from "#sdk/shared/skills";
import type { ClientRuntime, SessionViewEvent } from "#sdk/sidepanel/sessions";
import {
  modernSkillValuesFromRecord,
  getSkillDisplayName,
  isValidAgentSkillName,
  normalizeModernSkill,
  normalizeSkill,
  skillMatchesName,
  skillEntriesByIdentity,
  normalizeSkillLookup,
  SKILL_SCOPE_GLOBAL,
  SKILL_SCOPE_RESIDENT,
  SKILL_SCOPE_SITE,
  type SkillRecord, type SkillResource,
} from "#sdk/shared/skills";
import { isBuiltinSkill, isBuiltinSkillName } from "#sdk/shared/skills";
import {
  findSkillManifestResource,
  parseSkillManifest,
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "#sdk/shared/skills";
import {
  exportSkillsZip,
  importSkillsFromFileList,
  importSkillsZip,
  parseSkillMarkdownFrontmatter,
  skillToSkillMarkdown,
  type ImportFile,
} from "#sdk/shared/skills";
import {
  compareBeijingDateTimeDesc,
  formatDisplayDateTime,
  nowBeijingDateTime,
} from "#sdk/shared/format";
import {
  highlightCode,
  highlightMarkdownDocument,
  LIVE_HIGHLIGHT_MAX_LENGTH,
  normalizeCodeLanguage,
} from "#sdk/sidepanel/dom";
import { escapeHtml, escapeHtmlAttribute, safeFilename } from "#sdk/sidepanel/dom";
import {
  captureSkillDraftSave,
  classifySkillDraftSave,
  createSkillDraft,
  type SkillDraft,
} from "./skill-draft.js";
import {
  filterSkillsForList,
  normalizeSkillListFilter,
  SKILL_LIST_FILTER_BUILTIN,
  SKILL_LIST_FILTER_MINE,
} from "./skill-list-filter.js";
import { createGitSkillSourcesPanel } from "./git-skill-sources-panel.js";

type Fields = Record<string, unknown>;
type ResourceDraft = Pick<SkillResource, "path"> & Partial<SkillResource>;
interface McpDraft { id: string; url: string; enabled: boolean; headersText: string; timeoutMs: unknown; callTimeoutMs: unknown }
interface McpServerDraft { id: string; url: string; enabled: boolean; headers: Fields; timeoutMs?: number; callTimeoutMs?: number }
interface GitPublishTarget extends Fields { available?: boolean; name?: string; namespace?: string; ref?: string; subpath?: string }
interface SkillReply extends GitPublishTarget, Partial<SkillWorkspaceSnapshot> {
  registryReady?: boolean; skill?: SkillRecord;
  ok?: boolean; type?: string; message?: string; error?: string; count?: number;
  conflicts?: Fields[]; shortId?: string; commitId?: string; fileCount?: number; reopenedTab?: boolean;
}
interface SkillsOptions {
  signal?: AbortSignal;
  root?: Document | HTMLElement; initialSkill?: string | null;
  request(type: string, payload: Fields, timeout: number): Promise<Fields>;
  send?(message: Fields): unknown; isActive?(): boolean; getCurrentSessionId?(): string | null;
  getSessionRuntime?(id: string | null): Partial<ClientRuntime>; updateSessionRuntime?(id: string, event: SessionViewEvent): unknown;
  isCurrentSession?(id: string): boolean; renderMarkdown?(value: string): string;
  clearMathTypeset?(element: HTMLElement): void; scheduleMathTypeset?(element: HTMLElement): void;
  highlightSearchText?(element: HTMLElement, query: string): void;
  confirm?: UiExtensionAPI["dialogs"]["confirm"];
  choose?: UiExtensionAPI["dialogs"]["choose"];
  showToast?: UiExtensionAPI["showToast"];
  hideToast?: UiExtensionAPI["hideToast"];
  onStableViewChange?(): void;
}
interface DirectoryHandle {
  kind: "directory"; name: string;
  entries(): AsyncIterable<[string, DirectoryHandle | FileSystemFileHandle]>;
}

export function createSkillsFeature(options: SkillsOptions) {
  const lifetime = new AbortController();
  const lifecycleSignal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  lifecycleSignal?.throwIfAborted();
  if (typeof options.request !== "function") throw new Error("skills request adapter is required");
  let disposed = false;
  const root = options.root || document;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const request = async (type: string, payload: Fields, timeout: number): Promise<SkillReply> => {
    lifecycleSignal?.throwIfAborted();
    const result = await options.request(type, payload, timeout);
    lifecycleSignal?.throwIfAborted();
    return result;
  };
  const send = options.send || (() => {});
  const isActive = () => !lifecycleSignal?.aborted && (options.isActive?.() ?? false);
  const getCurrentSessionId = options.getCurrentSessionId || (() => "");
  const getSessionRuntime = options.getSessionRuntime || ((): Partial<ClientRuntime> => ({}));
  const updateSessionRuntime = options.updateSessionRuntime || (() => {});
  const renderMarkdown = options.renderMarkdown || (value => escapeHtml(value));
  const clearMathTypeset = options.clearMathTypeset || (() => {});
  const scheduleMathTypeset = options.scheduleMathTypeset || (() => {});
  const highlightSearchText = options.highlightSearchText || (() => {});
  const confirmAction = options.confirm || (async () => false);
  const chooseAction = options.choose || (async () => null);
  const showToast = options.showToast || (() => {});
  const hideToast = options.hideToast || (() => false);

  const skillSearchBar = $("#skill-search-bar");
  const skillSearchInput = $<HTMLInputElement>("#skill-search-input");
  const skillSearchCount = $("#skill-search-count");
  const skillSearchPrev = $<HTMLButtonElement>("#skill-search-prev");
  const skillSearchNext = $<HTMLButtonElement>("#skill-search-next");
  const skillSearchClose = $<HTMLButtonElement>("#skill-search-close");
  const skillDetailContent = $("#skill-detail-content");

  const skillsPanel = $("#skills-panel");
  const skillsList = $("#skills-list");
  const skillsToolbar = $("#skills-panel .skills-toolbar");
  const skillDetail = $("#skill-detail");
  const skillsSearch = $<HTMLInputElement>("#skills-search");
  const skillFilterBtns = root.querySelectorAll<HTMLElement>(".skill-filter-btn");
  const btnImportSkills = $<HTMLButtonElement>("#btn-import-skills");
  const btnExportSkills = $<HTMLButtonElement>("#btn-export-skills");
  const skillsImportFile = $<HTMLInputElement>("#skills-import-file");
  const skillsImportMenu = $("#skills-import-menu");
  const btnImportSkillsZip = $<HTMLButtonElement>("#btn-import-skills-zip");
  const btnImportSkillsDir = $<HTMLButtonElement>("#btn-import-skills-dir");
  const btnImportSkillsGit = $<HTMLButtonElement>("#btn-import-skills-git");
  const skillContentPreview = $("#skill-content-preview");
  const skillBodyText = $<HTMLTextAreaElement>("#skill-body-text");
  const skillBodyHighlight = $("#skill-body-highlight");
  const skillResourcesList = $("#skill-resources-list");
  const skillMcpList = $("#skill-mcp-list");
  const skillEditorStatus = $("#skill-editor-status");
  const pendingSyntaxHighlightFrames = new Map<HTMLElement, number>();
  const skillSettingsView = $("#skill-settings-view");
  const skillSourceView = $("#skill-source-view");
  const skillSourceStatus = $("#skill-source-status");
  const btnEditSkill = $<HTMLButtonElement>("#btn-edit-skill");
  const btnPreviewSkill = $<HTMLButtonElement>("#btn-preview-skill");
  const btnSkillActions = $<HTMLButtonElement>("#btn-skill-actions");
  const skillActionsMenu = $("#skill-actions-menu");
  const btnSkillSettings = $<HTMLButtonElement>("#btn-skill-settings");
  const btnCloseSkillSettings = $<HTMLButtonElement>("#btn-close-skill-settings");
  const btnOpenSkillSource = $<HTMLButtonElement>("#btn-open-skill-source");
  const btnCloseSkillSource = $<HTMLButtonElement>("#btn-close-skill-source");
  const btnAddSkillResource = $<HTMLButtonElement>("#btn-add-skill-resource");
  const btnAddSkillMcp = $<HTMLButtonElement>("#btn-add-skill-mcp");
  const btnPublishSkillGit = $<HTMLButtonElement>("#btn-publish-skill-git");
  const btnSaveSkillEditTop = $<HTMLButtonElement>("#btn-save-skill-edit-top");
  const btnExportSkill = $<HTMLButtonElement>("#btn-export-skill");
  const skillGitPublishConfirm = $("#skill-git-publish-confirm");
  const skillGitPublishRepository = $("#skill-git-publish-repository");
  const skillGitPublishPath = $("#skill-git-publish-path");
  const skillGitPublishMeta = $("#skill-git-publish-meta");
  const skillGitPublishMessage = $<HTMLInputElement>("#skill-git-publish-message");
  const skillGitPublishStatus = $("#skill-git-publish-status");
  const btnConfirmSkillGitPublish = $<HTMLButtonElement>("#btn-confirm-skill-git-publish");

  let allSkillsCache: SkillRecord[] = [];
  let currentSkillName: string | null = null;
  let isEditingSkill = false;
  let isSavingSkillEdit = false;
  let skillWorkbenchSection = "content";
  let skillContentMode = "preview";
  let currentSkillDraft: SkillDraft | null = null;
  let skillResourceDrafts: ResourceDraft[] = [];
  let activeSkillResourceIndex = -1;
  let skillMcpDrafts: McpDraft[] = [];
  let skillMcpDraftsDirty = false;
  let activeSkillMcpIndex = -1;
  let isTestingSkillMcp = false;
  let skillListFilter = SKILL_LIST_FILTER_MINE;
  let gitPublishTarget: GitPublishTarget | null = null;
  let gitPublishConfirmTarget: GitPublishTarget | null = null;
  let isInspectingGitPublishTarget = false;
  let isPublishingSkillToGit = false;
  let gitPublishInspectGeneration = 0;
  let gitPublishRefreshTimer = 0;
  let pendingInitialSkill = String(options.initialSkill || "").trim() || null;

  const gitSkillSourcesPanel = createGitSkillSourcesPanel({
    signal: lifecycleSignal,
    root,
    request,
    async beforeOpen() {
      if (!await closeSkillDetail()) return false;
      hideSkillsListShell();
      return true;
    },
    onClose: showSkillsListShell,
    onSkillsChanged: loadSkillsList,
    confirm: confirmAction,
    choose: chooseAction,
    toast: showToast,
  });


  const skillSearchState = {
    open: false,
    query: "",
    matches: [] as HTMLElement[],
    activeIndex: -1,
  };



  document.addEventListener("keydown", handleSkillSearchGlobalKeydown, { capture: true, signal: lifecycleSignal });
  skillSearchInput?.addEventListener("input", handleSkillSearchInput, { signal: lifecycleSignal });
  skillSearchInput?.addEventListener("keydown", handleSkillSearchKeydown, { signal: lifecycleSignal });
  skillSearchPrev?.addEventListener("click", () => jumpSkillSearch(-1), { signal: lifecycleSignal });
  skillSearchNext?.addEventListener("click", () => jumpSkillSearch(1), { signal: lifecycleSignal });
  skillSearchClose?.addEventListener("click", () => closeSkillSearch(), { signal: lifecycleSignal });

  skillFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      skillListFilter = normalizeSkillListFilter(btn.dataset.skillFilter);
      skillFilterBtns.forEach((item) => {
        const selected = item === btn;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      applySkillFilters();
    }, { signal: lifecycleSignal });
  });

  btnImportSkills?.addEventListener("click", () => {
    skillsImportMenu?.classList.toggle("hidden");
  }, { signal: lifecycleSignal });
  btnImportSkillsZip?.addEventListener("click", () => {
    skillsImportMenu?.classList.add("hidden");
    skillsImportFile.value = "";
    skillsImportFile.click();
  }, { signal: lifecycleSignal });
  btnImportSkillsDir?.addEventListener("click", () => {
    skillsImportMenu?.classList.add("hidden");
    importSkillsDirectoryPicker();
  }, { signal: lifecycleSignal });
  btnImportSkillsGit?.addEventListener("click", () => {
    skillsImportMenu?.classList.add("hidden");
    gitSkillSourcesPanel.open();
  }, { signal: lifecycleSignal });
  document.addEventListener("click", (event) => {
    if (!skillsImportMenu || skillsImportMenu.classList.contains("hidden")) return;
    const target = event.target;
    if (target instanceof Node && !btnImportSkills?.contains(target) && !skillsImportMenu.contains(target)) {
      skillsImportMenu.classList.add("hidden");
    }
  }, { signal: lifecycleSignal });
  btnSkillActions?.addEventListener("click", () => {
    const open = skillActionsMenu?.classList.contains("hidden");
    setSkillActionsMenuOpen(open, { restoreFocus: false });
    if (open) requestAnimationFrame(() => skillActionsMenu?.querySelector<HTMLElement>(".qz-menu-item")?.focus({ preventScroll: true }));
  }, { signal: lifecycleSignal });
  skillActionsMenu?.addEventListener("click", (event) => {
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".qz-menu-item")) setSkillActionsMenuOpen(false, { restoreFocus: false });
  }, { signal: lifecycleSignal });
  document.addEventListener("click", (event) => {
    if (!isElementVisible(skillActionsMenu)) return;
    const target = event.target;
    if (target instanceof Node && !btnSkillActions?.contains(target) && !skillActionsMenu?.contains(target)) {
      setSkillActionsMenuOpen(false, { restoreFocus: false });
    }
  }, { signal: lifecycleSignal });
  skillActionsMenu?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setSkillActionsMenuOpen(false);
  }, { signal: lifecycleSignal });
  btnExportSkills?.addEventListener("click", exportSkillsPackage, { signal: lifecycleSignal });
  skillsImportFile?.addEventListener("change", async () => {
    const file = skillsImportFile.files?.[0];
    if (file) await importSkillsPackageFile(file);
  }, { signal: lifecycleSignal });

  btnPublishSkillGit?.addEventListener("click", openSkillGitPublishConfirm, { signal: lifecycleSignal });
  btnConfirmSkillGitPublish?.addEventListener("click", publishCurrentSkillToGit, { signal: lifecycleSignal });
  skillGitPublishConfirm?.addEventListener("click", (event) => {
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>('[data-skill-git-publish-action="cancel"]')) closeSkillGitPublishConfirm();
  }, { signal: lifecycleSignal });
  skillGitPublishMessage?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      publishCurrentSkillToGit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSkillGitPublishConfirm();
    }
  }, { signal: lifecycleSignal });
  const onTabActivated = () => {
    gitPublishTarget = null;
    syncGitPublishButtonState();
    scheduleGitPublishTargetRefresh(80);
  };
  const onTabUpdated = (_tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo = {}) => {
    if (changeInfo.url) {
      gitPublishTarget = null;
      syncGitPublishButtonState();
    }
    if (changeInfo.url || changeInfo.status === "complete") scheduleGitPublishTargetRefresh(180);
  };
  chrome.tabs?.onActivated?.addListener(onTabActivated);
  chrome.tabs?.onUpdated?.addListener(onTabUpdated);



  async function activate() {
    lifecycleSignal?.throwIfAborted();
    currentSkillName = null;
    skillDetail.classList.add("hidden");
    closeSkillGitPublishConfirm({ force: true });
    gitPublishTarget = null;
    syncGitPublishButtonState();
    gitSkillSourcesPanel.close({ restoreList: false });
    showSkillsListShell();
    await loadSkillsList();
    const initialSkill = pendingInitialSkill;
    pendingInitialSkill = null;
    if (initialSkill) showSkillDetail(initialSkill);
  }

  function deactivate() {
    closeSkillSearch({ restoreFocus: false });
  }

  function closeTopmostTransientUi() {
    if (isElementVisible(skillActionsMenu)) {
      setSkillActionsMenuOpen(false);
      return true;
    }
    if (isElementVisible(skillsImportMenu)) {
      skillsImportMenu.classList.add("hidden");
      return true;
    }
    if (skillSearchState.open) {
      closeSkillSearch();
      return true;
    }
    if (gitSkillSourcesPanel.isOpen()) {
      gitSkillSourcesPanel.close();
      return true;
    }
    if (isElementVisible(skillDetail)) {
      closeSkillDetail();
      return true;
    }
    return false;
  }

  function showSkillsListShell() {
    skillsList?.classList.remove("hidden");
    skillsToolbar?.classList.remove("hidden");
  }

  function hideSkillsListShell() {
    skillsList?.classList.add("hidden");
    skillsToolbar?.classList.add("hidden");
  }



  function isSkillSearchShortcut(event: KeyboardEvent) {
    return Boolean(
      isActive()
      && isElementVisible(skillDetail)
      && !isEditingSkill
      && !event.defaultPrevented
      && !event.altKey
      && (event.metaKey || event.ctrlKey)
      && String(event.key || "").toLowerCase() === "f"
    );
  }

  function handleSkillSearchGlobalKeydown(event: KeyboardEvent) {
    if (!isSkillSearchShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openSkillSearch();
  }

  function openSkillSearch() {
    if (!isActive() || !isElementVisible(skillDetail) || isEditingSkill) return;
    skillSearchState.open = true;
    skillSearchBar?.classList.remove("hidden");
    updateSkillSearchMatches({ preserveActive: true });
    requestAnimationFrame(() => {
      skillSearchInput?.focus({ preventScroll: true });
      skillSearchInput?.select();
    });
  }

  function closeSkillSearch({ restoreFocus = true } = {}) {
    if (!skillSearchState.open && !skillSearchState.query) return;
    skillSearchState.open = false;
    skillSearchState.query = "";
    skillSearchState.matches = [];
    skillSearchState.activeIndex = -1;
    if (skillSearchInput) skillSearchInput.value = "";
    skillSearchBar?.classList.add("hidden");
    clearSkillSearchDomState();
    updateSkillSearchControls();
    if (restoreFocus && isActive()) $<HTMLButtonElement>("#btn-back-skills")?.focus?.({ preventScroll: true });
  }

  function handleSkillSearchInput() {
    skillSearchState.query = String(skillSearchInput?.value || "");
    updateSkillSearchMatches({ preserveActive: false });
  }

  function handleSkillSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSkillSearch();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      jumpSkillSearch(event.shiftKey ? -1 : 1);
    }
  }

  function jumpSkillSearch(delta: number) {
    const total = skillSearchState.matches.length;
    if (!total) return;
    const current = skillSearchState.activeIndex >= 0 ? skillSearchState.activeIndex : (delta < 0 ? 0 : -1);
    skillSearchState.activeIndex = (current + delta + total) % total;
    applySkillSearchActive({ scroll: true });
    updateSkillSearchControls();
  }

  function updateSkillSearchMatches({ preserveActive = true } = {}) {
    const previousIndex = preserveActive ? skillSearchState.activeIndex : 0;
    clearSkillSearchDomState();
    skillSearchState.matches = [];
    const query = skillSearchState.query.trim();
    if (!skillSearchState.open || !query || !skillDetailContent) {
      skillSearchState.activeIndex = -1;
      updateSkillSearchControls();
      return;
    }

    highlightSearchText(skillDetailContent, query);
    skillSearchState.matches = Array.from(skillDetailContent.querySelectorAll<HTMLElement>("mark.chat-search-hit"));
    skillSearchState.activeIndex = skillSearchState.matches.length
      ? Math.min(Math.max(previousIndex, 0), skillSearchState.matches.length - 1)
      : -1;
    applySkillSearchActive({ scroll: false });
    updateSkillSearchControls();
  }

  function applySkillSearchActive({ scroll = false } = {}) {
    skillSearchState.matches.forEach(mark => mark.classList.remove("skill-search-active"));
    const active = skillSearchState.matches[skillSearchState.activeIndex];
    if (!active) return;
    active.classList.add("skill-search-active");
    if (scroll) active.scrollIntoView({ block: "center", inline: "nearest" });
  }

  function clearSkillSearchDomState() {
    if (!skillDetailContent) return;
    for (const mark of Array.from(skillDetailContent.querySelectorAll<HTMLElement>("mark.chat-search-hit"))) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize?.();
    }
  }

  function updateSkillSearchControls() {
    const total = skillSearchState.matches.length;
    const active = total && skillSearchState.activeIndex >= 0 ? skillSearchState.activeIndex + 1 : 0;
    if (skillSearchCount) skillSearchCount.textContent = `${active}/${total}`;
    if (skillSearchPrev) skillSearchPrev.disabled = !total;
    if (skillSearchNext) skillSearchNext.disabled = !total;
  }



  function applyWorkspace(snapshot: SkillReply) {
    if (!Array.isArray(snapshot.skills)) throw new Error(t("invalidSkillListResponsePleaseTryAgain"));
    allSkillsCache = snapshot.skills.map(normalizeModernSkill).sort(compareSkillsForDisplay);
  }

  async function loadSkillsList() {
    applyWorkspace(await request("get_skill_workspace", {}, 10000));
    applySkillFilters();
  }

  function compareSkillsForDisplay(a: SkillRecord, b: SkillRecord) {
    const aBuiltin = isBuiltinSkill(a);
    const bBuiltin = isBuiltinSkill(b);
    if (aBuiltin !== bBuiltin) return aBuiltin ? -1 : 1;
    return compareBeijingDateTimeDesc(a.updatedAt, b.updatedAt) || String(a.name || "").localeCompare(String(b.name || ""), getLocale());
  }

  async function exportSkillsPackage() {
    await loadSkillsList();
    const rows = allSkillsCache.filter(skill => !isBuiltinSkill(skill))
      .sort((a, b) => a.name.localeCompare(b.name));
    await downloadSkillsZip(rows, `skills-${safeFilename(nowBeijingDateTime())}.zip`);
  }

  async function exportCurrentSkillPackage() {
    const skill = allSkillsCache.find(item => skillMatchesName(item, currentSkillName || ""));
    if (!skill) return;
    if (isBuiltinSkill(skill)) {
      setSkillsStatus(t("builtInSkillsCannotBeExported"), "error");
      return;
    }
    await downloadSkillsZip([skill], `${safeFilename(skill.name)}.zip`);
  }

  async function downloadSkillsZip(skills: SkillRecord[], filename: string) {
    const blob = await exportSkillsZip(skills);
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  async function importSkillsPackageFile(file: File) {
    let imported = [];
    try {
      if (!/\.zip$/i.test(file.name || "")) {
        throw new Error(t("importAnAgentSkillsZipPackage"));
      }
      imported = await importSkillsZip(await file.arrayBuffer());
    } catch (err) {
      setSkillsStatus(t("importFailed", { reason: String((err instanceof Error ? err.message : err)) }), "error");
      return;
    }
    await upsertImportedSkills(imported);
  }

  const SKILL_DIRECTORY_SCAN_MAX_FILES = 2000;
  const SKILL_DIRECTORY_SCAN_MAX_TEXT_FILES = 500;
  const SKILL_DIRECTORY_SCAN_MAX_DEPTH = 8;
  const SKILL_DIRECTORY_TEXT_EXTENSIONS = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  const SKILL_DIRECTORY_SKIP_DIRS = new Set([
    ".cache",
    ".git",
    ".hg",
    ".next",
    ".svn",
    "build",
    "coverage",
    "dist",
    "node_modules",
  ]);

  async function importSkillsDirectoryPicker() {
    const picker = (window as Window & { showDirectoryPicker?(options: { mode: "read" }): Promise<DirectoryHandle> }).showDirectoryPicker;
    if (typeof picker !== "function") {
      setSkillsStatus(t("thisChromeVersionDoesNotSupportSecureDirectoryImportImport"), "error");
      return;
    }

    let directoryHandle;
    try {
      directoryHandle = await picker.call(window, { mode: "read" });
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        setSkillsStatus(t("couldNotSelectDirectory", { reason: String((err instanceof Error ? err.message : err)) }), "error");
      }
      return;
    }

    try {
      setSkillsStatus(t("scanningDirectory"));
      const files = await collectSkillDirectoryFiles(directoryHandle);
      await importSkillsDirectoryFiles(files);
    } catch (err) {
      setSkillsStatus(t("importFailed", { reason: String((err instanceof Error ? err.message : err)) }), "error");
    }
  }

  async function collectSkillDirectoryFiles(directoryHandle: DirectoryHandle) {
    const files: ImportFile[] = [];
    let scannedFiles = 0;

    async function walk(handle: DirectoryHandle, prefixParts: string[] = [], depth = 0) {
      if (depth > SKILL_DIRECTORY_SCAN_MAX_DEPTH) {
        throw new Error(t("directoryNestingIsTooDeep", { path: String(prefixParts.join("/") || directoryHandle.name) }));
      }
      for await (const [name, child] of handle.entries()) {
        if (child.kind === "directory") {
          if (shouldSkipSkillDirectory(name)) continue;
          await walk(child, [...prefixParts, name], depth + 1);
          continue;
        }
        if (child.kind !== "file") continue;

        scannedFiles += 1;
        if (scannedFiles > SKILL_DIRECTORY_SCAN_MAX_FILES) {
          throw new Error(t("tooManyDirectoryFilesSelectASkillDirectoryOrUse"));
        }

        const relativePath = [...prefixParts, name].join("/");
        if (!isPotentialSkillDirectoryResource(relativePath)) continue;
        const file = await child.getFile();
        files.push({
          path: relativePath,
          name: file.name,
          size: file.size,
          text: () => file.text(),
          arrayBuffer: () => file.arrayBuffer(),
        });
        if (files.length > SKILL_DIRECTORY_SCAN_MAX_TEXT_FILES) {
          throw new Error(t("tooManyTextResourcesSelectASmallerSkillDirectoryOr"));
        }
      }
    }

    await walk(directoryHandle);
    return files;
  }

  function shouldSkipSkillDirectory(name: string) {
    const clean = String(name || "").trim();
    return !clean || SKILL_DIRECTORY_SKIP_DIRS.has(clean);
  }

  function isPotentialSkillDirectoryResource(path: string) {
    const clean = String(path || "").replace(/\\/g, "/");
    if (!clean || clean.endsWith("/")) return false;
    if (clean.split("/").some(part => shouldSkipSkillDirectory(part))) return false;
    if (clean === "SKILL.md" || clean.endsWith("/SKILL.md")) return true;
    const lower = clean.toLowerCase();
    const dot = lower.lastIndexOf(".");
    return dot >= 0 && SKILL_DIRECTORY_TEXT_EXTENSIONS.has(lower.slice(dot));
  }

  async function importSkillsDirectoryFiles(fileList: Parameters<typeof importSkillsFromFileList>[0]) {
    let imported = [];
    try {
      imported = await importSkillsFromFileList(fileList);
    } catch (err) {
      setSkillsStatus(t("importFailed", { reason: String((err instanceof Error ? err.message : err)) }), "error");
      return;
    }
    await upsertImportedSkills(imported);
  }

  async function upsertImportedSkills(imported: unknown[]) {
    const rows = (Array.isArray(imported) ? imported : []).map(normalizeModernSkill).filter(skill => skill.name);
    if (!rows.length) {
      setSkillsStatus(t("noSkillsToImport"), "error");
      return { ok: false as const, count: 0, names: [] };
    }

    const snapshot = await request("get_skill_workspace", {}, 10000);
    if (!Array.isArray(snapshot.skills)) throw new Error(t("invalidSkillListResponsePleaseTryAgain"));
    const builtinNames = rows.filter(skill => isBuiltinSkillName(skill.name)).map(skill => skill.name);
    if (builtinNames.length) {
      setSkillsStatus(t("importFailedIsABuiltInSkillAndCannotBe", { name: String(builtinNames[0]) }), "error");
      return { ok: false as const, count: 0, names: [] };
    }
    const existingModern = Object.fromEntries(snapshot.skills.map(skill => [skill.name, skill]));
    const expected = Object.fromEntries(rows.map(skill => [skill.name, skillEntriesByIdentity(existingModern, skill.name)[0]?.skill || null]));
    const conflictNames = rows
      .filter(skill => expected[skill.name])
      .map(skill => skill.name);
    if (conflictNames.length) {
      const sample = conflictNames.slice(0, 6).join(", ");
      const suffix = conflictNames.length > 6 ? t("andOthersTotal", { count: String(conflictNames.length) }) : "";
      if (!await confirmAction({
        title: t("overwriteExistingSkills"),
        message: t("theFollowingSkillsWillBeOverwritten", { names: String(sample), more: String(suffix) }),
        confirmLabel: t("continueImport"),
        tone: "danger",
      })) {
        return { ok: false as const, count: 0, names: [], cancelled: true };
      }
    }

    let result: SkillReply;
    try {
      result = await request("import_workspace_skills", { skills: rows, expected }, 60000);
      applyWorkspace(result);
      applySkillFilters();
    } catch (error) {
      setSkillsStatus(t("importFailed", { reason: String(error instanceof Error ? error.message : error) }), "error");
      return { ok: false as const, count: 0, names: [] };
    }
    const registryReady = result.registryReady === true;
    if (registryReady) {
      setSkillsStatus("");
    } else {
      setSkillsStatus(t("importedSkillsToolsWillRefreshAutomaticallyForTheNextTask", { count: String(rows.length) }), "error");
    }
    return { ok: true as const, count: rows.length, names: rows.map(skill => skill.name), registryReady };
  }

  function normalizeSkillResourceContents(resources: ResourceDraft[] = []): ResourceDraft[] {
    return (Array.isArray(resources) ? resources : [])
      .map(resource => {
        const path = cleanSkillResourcePath(resource?.path || "");
        if (!path || path.includes("..")) return null;
        const title = String(resource?.title || "").trim();
        const defaultTitle = path.split("/").pop() || path;
        const description = String(resource?.description || "").trim();
        return {
          path,
          type: String(resource?.type || inferSkillResourceType(path)).trim() || "asset",
          ...(title && title !== defaultTitle ? { title } : {}),
          ...(description ? { description } : {}),
          ...(resource?.encoding === "base64" ? { encoding: "base64" } : {}),
          ...(resource?.mimeType ? { mimeType: String(resource.mimeType) } : {}),
          ...(Number.isFinite(Number(resource?.size)) ? { size: Math.max(0, Math.floor(Number(resource.size))) } : {}),
          content: typeof resource?.content === "string" ? resource.content : "",
        };
      })
      .filter(resource => resource !== null);
  }

  function inferSkillResourceType(path = "") {
    const lower = String(path).toLowerCase();
    if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "script";
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
    return "asset";
  }

  function setSkillsStatus(message: string, tone = "") {
    if (disposed) return;
    const text = String(message || "").trim();
    if (!text) {
      hideToast({ key: "skills-status" });
      return;
    }
    const normalizedTone = tone === "error" ? "error" : tone === "success" ? "success" : "info";
    showToast(text, {
      tone: normalizedTone,
      durationMs: normalizedTone === "error" ? 6000 : normalizedTone === "success" ? 2600 : 0,
      key: "skills-status",
    });
  }

  function renderSkillsList(skills: SkillRecord[]) {
    if (!isElementVisible(skillDetail) && !gitSkillSourcesPanel.isOpen()) {
      showSkillsListShell();
    }
    if (!skills.length) {
      const { title: emptyTitle, description: emptyDesc } = skillListEmptyState();
      skillsList.innerHTML = `
        <div class="skills-empty">
          <p>${emptyTitle}</p>
          ${emptyDesc ? `<p>${emptyDesc}</p>` : ""}
        </div>
      `;
      return;
    }

    skillsList.innerHTML = skills.map(renderSkillCard).join("");

    skillsList.querySelectorAll<HTMLElement>(".skill-card").forEach(card => {
      card.addEventListener("click", () => showSkillDetail(card.dataset.name || ""), { signal: lifecycleSignal });
    });
  }

  function skillListEmptyState() {
    if (skillsSearch.value.trim()) {
      return { title: t("noMatchingSkills"), description: t("tryAnotherKeyword") };
    }
    if (skillListFilter === SKILL_LIST_FILTER_BUILTIN) {
      return { title: t("noBuiltInSkills"), description: "" };
    }
    return {
      title: t("noPersonalSkillsYet"),
      description: t("importASkillPackageOrAskQingzhouToTurnA"),
    };
  }

  function renderSkillCard(skill: SkillRecord) {
    const s = normalizeSkill(skill);
    const displayName = getSkillDisplayName(s) || s.name;
    const isSite = s.scope === SKILL_SCOPE_SITE;
    const builtin = isBuiltinSkill(s);
    const domain = isSite ? skillCardDomainText(s) : "";
    const resourcesCount = s.resources.length;
    const mcpCount = skillMcpServers(s).length;
    const scopeMeta = skillScopeDisplay(s.scope);
    const title = displayName === s.name ? s.name : `${displayName} · ${s.name}`;
    return `
      <div class="skill-card ${builtin ? "readonly" : ""}" data-name="${escapeHtmlAttribute(s.name)}" title="${escapeHtmlAttribute(title)}">
        <div class="skill-card-name">${escapeHtml(displayName)}</div>
        <div class="skill-card-desc">${escapeHtml(s.description)}</div>
        <div class="skill-card-meta">
          ${builtin ? `<span class="skill-system-badge">${escapeHtml(t("builtIn"))}</span>` : ""}
          <span class="skill-scope-badge ${scopeMeta.className}">${scopeMeta.label}</span>
          ${domain ? `<span class="skill-card-domain">${escapeHtml(domain)}</span>` : ""}
          ${resourcesCount ? `<span>${escapeHtml(t("resourceCountLabel", { count: String(resourcesCount) }))}</span>` : ""}
          ${mcpCount ? `<span>${escapeHtml(t("mcpServers", { count: String(mcpCount) }))}</span>` : ""}
          <span>${escapeHtml(formatDisplayDateTime(s.updatedAt))}</span>
        </div>
      </div>
    `;
  }

  function skillScopeDisplay(scope: string) {
    if (scope === SKILL_SCOPE_RESIDENT) return { label: t("resident"), className: "resident" };
    if (scope === SKILL_SCOPE_SITE) return { label: t("site"), className: "site" };
    return { label: t("global"), className: "" };
  }

  function skillCardDomainText(skill: SkillRecord) {
    const domain = skill.domains?.[0] || "";
    const pattern = skill.urlPatterns?.[0] || "";
    return [domain, pattern].filter(Boolean).join(" ");
  }

  async function getCurrentWebPageUrl() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = String(tab?.url || "");
      return /^https?:\/\//i.test(url) ? url : "";
    } catch(_e) {
      return "";
    }
  }

  async function resolveCurrentSkillSiteUrls({ fresh = false } = {}) {
    const runtime = fresh ? await refreshCurrentSessionRuntimeForSkills() : getSessionRuntime(getCurrentSessionId());
    const urls = collectSkillSiteUrlsFromRuntime(runtime);
    if (urls.length) return urls;
    const activeUrl = await getCurrentWebPageUrl();
    return activeUrl ? [activeUrl] : [];
  }

  async function refreshCurrentSessionRuntimeForSkills() {
    const id = normalizeSessionIdValue(getCurrentSessionId());
    if (!id) return getSessionRuntime(id);
    try {
      const event = await request("get_state", { sessionId: id }, 1800);
      if (event?.type === "state") updateSessionRuntime(id, { ...event, type: "state" });
    } catch(_e) {
      // Skills tab can still render from cached runtime or active tab fallback.
    }
    return getSessionRuntime(id);
  }

  function collectSkillSiteUrlsFromRuntime(runtime: Partial<ClientRuntime> = {}) {
    const urls = [];
    const seen = new Set();
    const candidates = [
      ...(Array.isArray(runtime.visitedTaskSites) ? runtime.visitedTaskSites : []),
      runtime.workingTab,
    ];
    for (const item of candidates) {
      const url = normalizeSkillSiteUrl(item?.url || "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    return urls;
  }

  function normalizeSkillSiteUrl(value = "") {
    try {
      const url = new URL(String(value || ""));
      if (!/^https?:$/i.test(url.protocol)) return "";
      url.hash = "";
      return url.href;
    } catch(_e) {
      return "";
    }
  }

  function safeUrlHost(value = "") {
    try {
      return new URL(String(value || "")).hostname.toLowerCase();
    } catch(_e) {
      return "";
    }
  }

  function showSkillDetail(name: string) {
    const rawSkill = allSkillsCache.find(s => s.name === name) || allSkillsCache.find(s => skillMatchesName(s, name));
    if (!rawSkill) return false;
    const skill = normalizeSkill(rawSkill);
    const displayName = getSkillDisplayName(skill) || skill.name;
    const readonly = isBuiltinSkill(skill);
    closeSkillSearch({ restoreFocus: false });

    currentSkillName = skill.name;
    currentSkillExpected = skill;
    skillDetail.dataset.readonly = readonly ? "true" : "false";
    $("#skill-detail-name").textContent = displayName;
    $("#skill-detail-name").title = displayName === skill.name ? skill.name : `${displayName} · ${skill.name}`;
    $("#skill-detail-desc").textContent = skill.description;
    const scope = skillScopeDisplay(skill.scope).label;
    const domain = skill.scope === SKILL_SCOPE_SITE && skill.domains.length ? ` · ${skill.domains.join(", ")}` : "";
    const builtinPrefix = readonly ? t("builtInPrefix") : "";
    $("#skill-detail-time").textContent = t("updated", { prefix: String(builtinPrefix), time: String(formatDisplayDateTime(skill.updatedAt) || t("system")), scope: String(scope), domains: String(domain) });
    clearMathTypeset(skillDetailContent);
    skillDetailContent.innerHTML = renderMarkdown(skill.content || "");
    scheduleMathTypeset(skillDetailContent);
    setSkillEditorValue(skillToSkillMarkdown(skill));
    setSkillResourcesEditorValue(skill.resources || []);
    setSkillMcpEditorValue(skill);
    resetCurrentSkillDraft(skill);
    renderSkillResources(skill);
    setSkillEditorStatus("");
    setSkillDraftClean();
    setSkillWorkbenchSection("content", { resetSubview: true });
    setSkillEditMode(false);
    hideSkillsListShell();
    skillDetail.classList.remove("hidden");
    gitPublishTarget = null;
    syncGitPublishButtonState();
    void refreshGitPublishTarget();
    options.onStableViewChange?.();
    return true;
  }

  function setSkillEditMode(editing: boolean) {
    const readonly = skillDetail?.dataset.readonly === "true";
    if (editing && readonly) return;
    if (editing) closeSkillSearch({ restoreFocus: false });
    if (editing && getSkillDocumentAuthority() === "source" && !syncSkillStructuredEditorsFromSource({ showError: true })) return;
    skillContentMode = editing ? "edit" : "preview";
    skillContentPreview?.classList.toggle("hidden", editing);
    $("#skill-editor").classList.toggle("hidden", !editing);
    btnEditSkill?.setAttribute("aria-pressed", editing ? "true" : "false");
    btnPreviewSkill?.setAttribute("aria-pressed", editing ? "false" : "true");
    syncSkillHeaderContextAction();
    if (!editing) renderSkillDraftPreview();
    syncSkillEditingState();
    if (editing) skillBodyText?.focus({ preventScroll: true });
  }

  function setSkillWorkbenchSection(section: string, { resetSubview = true } = {}) {
    const next = ["content", "resources", "mcp"].includes(section) ? section : "content";
    if (!skillSourceView?.classList.contains("hidden") && !syncSkillStructuredEditorsFromSource({ showError: true })) return false;
    syncActiveSkillResourceDraft();
    syncActiveSkillMcpDraft();
    if (resetSubview) {
      skillSettingsView?.classList.add("hidden");
      skillSourceView?.classList.add("hidden");
    }
    if (next === "content") {
      setSkillEditMode(false);
    } else {
      closeSkillSearch({ restoreFocus: false });
      activeSkillResourceIndex = -1;
      activeSkillMcpIndex = -1;
      if (next === "resources") renderSkillResourcesEditor();
      if (next === "mcp") renderSkillMcpEditor();
    }
    skillWorkbenchSection = next;
    document.querySelectorAll<HTMLElement>("[data-skill-section]").forEach(button => {
      const active = button.dataset.skillSection === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll<HTMLElement>("[data-skill-section-panel]").forEach(panel => {
      panel.classList.toggle("active", panel.dataset.skillSectionPanel === next);
    });
    syncSkillHeaderContextAction();
    syncSkillEditingState();
    return true;
  }

  function syncSkillHeaderContextAction() {
    const contentActive = skillWorkbenchSection === "content";
    const editingContent = contentActive && skillContentMode === "edit";
    btnEditSkill?.classList.toggle("hidden", !contentActive || editingContent);
    btnPreviewSkill?.classList.toggle("hidden", !editingContent);
    btnAddSkillResource?.classList.toggle("hidden", skillWorkbenchSection !== "resources");
    btnAddSkillMcp?.classList.toggle("hidden", skillWorkbenchSection !== "mcp");
  }

  function syncSkillEditingState() {
    const subviewOpen = !skillSettingsView?.classList.contains("hidden") || !skillSourceView?.classList.contains("hidden");
    isEditingSkill = skillWorkbenchSection !== "content" || skillContentMode === "edit" || subviewOpen;
  }

  function renderSkillDraftPreview() {
    if (!skillDetailContent || !skillBodyText) return;
    clearMathTypeset(skillDetailContent);
    skillDetailContent.innerHTML = renderMarkdown(skillBodyText.value || "");
    scheduleMathTypeset(skillDetailContent);
    const config = readSkillConfigEditor();
    if (config) {
      $("#skill-detail-desc").textContent = config.description;
    }
    $("#skill-content-status").textContent = isSkillDraftDirty() ? t("previewIncludesUnsavedChanges") : t("previewIsUpToDate");
  }

  function skillMcpServers(skill: Partial<SkillRecord> = {}) {
    const manifestResource = findSkillManifestResource(skill.resources || []);
    if (!manifestResource) return [];
    const parsed = parseSkillManifest(manifestResource.content || "", skill);
    const plugin = parsed.plugin;
    return Array.isArray(plugin?.mcpServers) ? plugin.mcpServers : [];
  }

  function renderSkillResources(skill: Partial<SkillRecord> = {}) {
    const resources = normalizeSkillResourceContents(skill.resources || []);
    const mcpCount = skillMcpServers(skill).length;
    const resourceCount = resources.length;
    const resourceTabCount = $("#skill-tab-resource-count");
    const mcpTabCount = $("#skill-tab-mcp-count");
    if (resourceTabCount) resourceTabCount.textContent = String(resourceCount);
    if (mcpTabCount) mcpTabCount.textContent = String(mcpCount);
    if ($("#skill-content-summary")) {
      const parts = [];
      if (resourceCount) parts.push(t("resourceCountLabel", { count: String(resourceCount) }));
      if (mcpCount) parts.push(t("mcpServers", { count: String(mcpCount) }));
      $("#skill-content-summary").textContent = parts.join(" · ");
    }
    skillDetail?.classList.toggle("has-resources", resourceCount > 0 || mcpCount > 0);
  }

  function normalizeResourceType(type = "") {
    const value = String(type || "").trim().toLowerCase();
    return value || "asset";
  }

  function resourceTypeLabel(type = "") {
    switch (normalizeResourceType(type)) {
      case "script": return t("script");
      case "json": return "JSON";
      case "markdown": return t("document");
      default: return t("resources");
    }
  }

  function formatByteSize(bytes: unknown) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function scheduleGitPublishTargetRefresh(delay = 120) {
    clearTimeout(gitPublishRefreshTimer);
    gitPublishRefreshTimer = setTimeout(() => {
      gitPublishRefreshTimer = 0;
      if (isActive() && isElementVisible(skillDetail)) void refreshGitPublishTarget({ preserve: true });
    }, delay);
  }

  async function refreshGitPublishTarget({ preserve = false } = {}) {
    const skillName = currentSkillName;
    const skill = allSkillsCache.find(item => skillMatchesName(item, skillName || ""));
    if (!skillName || !skill || isBuiltinSkill(skill) || !isElementVisible(skillDetail)) {
      gitPublishInspectGeneration += 1;
      gitPublishTarget = null;
      isInspectingGitPublishTarget = false;
      syncGitPublishButtonState();
      return null;
    }
    const generation = ++gitPublishInspectGeneration;
    if (!preserve) gitPublishTarget = null;
    isInspectingGitPublishTarget = true;
    syncGitPublishButtonState();
    try {
      const result = await request("inspect_git_skill_publish_target", {}, 6000);
      if (generation !== gitPublishInspectGeneration || currentSkillName !== skillName) return null;
      gitPublishTarget = result?.available === true ? result : null;
      return gitPublishTarget;
    } catch (err) {
      if (generation === gitPublishInspectGeneration) {
        gitPublishTarget = null;
        console.debug("[轻舟] inspect Git publish target failed:", (err instanceof Error ? err.message : err));
      }
      return null;
    } finally {
      if (generation === gitPublishInspectGeneration) {
        isInspectingGitPublishTarget = false;
        syncGitPublishButtonState();
      }
    }
  }

  async function openSkillGitPublishConfirm() {
    if (isPublishingSkillToGit || isSavingSkillEdit) return;
    if (isSkillDraftDirty()) {
      showToast(t("saveYourChangesBeforeCommittingToGit"), {
        title: t("saveTheSkillFirst"),
        tone: "error",
        durationMs: 6000,
        key: "skill-git-save-first",
      });
      return;
    }
    const target = await refreshGitPublishTarget({ preserve: true });
    if (!target) {
      showToast(t("openAGitRepositoryDirectoryPageFirst"), {
        title: t("noGitDirectoryAvailableForCommitting"),
        tone: "error",
        durationMs: 6000,
        key: "skill-git-target-missing",
      });
      return;
    }
    const skill = allSkillsCache.find(item => skillMatchesName(item, currentSkillName || ""));
    if (!skill || isBuiltinSkill(skill)) return;
    gitPublishConfirmTarget = Object.freeze({ ...target });
    const repositoryLabel = [target.namespace, target.name].filter(Boolean).join("/") || target.name || t("gitRepository");
    const targetPath = [target.subpath, skill.name].filter(Boolean).join("/");
    const fileCount = 1 + (Array.isArray(skill.resources) ? skill.resources.length : 0);
    if (skillGitPublishRepository) skillGitPublishRepository.textContent = repositoryLabel;
    if (skillGitPublishPath) {
      skillGitPublishPath.textContent = targetPath;
      skillGitPublishPath.title = targetPath;
    }
    if (skillGitPublishMeta) skillGitPublishMeta.textContent = t("files", { branch: String(target.ref), count: String(fileCount) });
    if (skillGitPublishMessage) skillGitPublishMessage.value = `feat(skill): publish ${skill.name}`;
    setSkillGitPublishStatus("");
    skillGitPublishConfirm?.classList.remove("hidden");
    syncGitPublishConfirmState();
    requestAnimationFrame(() => {
      skillGitPublishMessage?.focus({ preventScroll: true });
      skillGitPublishMessage?.select();
    });
  }

  function closeSkillGitPublishConfirm({ force = false } = {}) {
    if (isPublishingSkillToGit && !force) return;
    skillGitPublishConfirm?.classList.add("hidden");
    gitPublishConfirmTarget = null;
    setSkillGitPublishStatus("");
  }

  async function publishCurrentSkillToGit() {
    if (isPublishingSkillToGit) return;
    if (isSkillDraftDirty()) {
      setSkillGitPublishStatus(t("theSkillHasChangedSaveItAndConfirmTheCommit"), "error");
      return;
    }
    const skill = allSkillsCache.find(item => skillMatchesName(item, currentSkillName || ""));
    const target = gitPublishConfirmTarget;
    if (!skill || isBuiltinSkill(skill)) {
      setSkillGitPublishStatus(t("thisSkillCanNoLongerBeCommittedCloseTheDialog"), "error");
      return;
    }
    if (!target?.available) {
      setSkillGitPublishStatus(t("theCommitTargetHasExpiredCloseTheDialogAndConfirm"), "error");
      return;
    }
    const commitMessage = String(skillGitPublishMessage?.value || "").trim();
    if (!commitMessage) {
      setSkillGitPublishStatus(t("enterACommitMessage"), "error");
      skillGitPublishMessage?.focus({ preventScroll: true });
      return;
    }
    isPublishingSkillToGit = true;
    syncGitPublishButtonState();
    syncGitPublishConfirmState();
    setSkillGitPublishStatus(t("connectingToCodeCheckingAndCommittingAtomically"), "loading");
    try {
      const result = await request("publish_skill_to_git", {
        skill,
        target,
        commitMessage,
      }, 90000);
      if (!result?.ok) throw new Error(result?.message || t("couldNotCommitSkill"));
      const commitLabel = result.shortId || String(result.commitId || "").slice(0, 8);
      closeSkillGitPublishConfirm({ force: true });
      const summary = t("commitFilesSummary", { action: String(result.reopenedTab ? t("reopenedRepositoryAndCommitted") : t("committed")), count: String(result.fileCount || 0), commit: String(commitLabel ? ` · ${commitLabel}` : "") });
      setSkillEditorStatus(summary, "success", { toast: true });
      setSkillsStatus(summary, "success");
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err));
      setSkillGitPublishStatus(message, "error");
      showToast(message, {
        title: t("gitCommitIncomplete"),
        tone: "error",
        durationMs: 6000,
        key: "skill-git-publish-error",
        actionLabel: t("retry"),
        onAction: () => void publishCurrentSkillToGit(),
      });
    } finally {
      isPublishingSkillToGit = false;
      syncGitPublishButtonState();
      syncGitPublishConfirmState();
    }
  }

  function setSkillGitPublishStatus(message = "", tone = "") {
    if (disposed) return;
    if (!skillGitPublishStatus) return;
    skillGitPublishStatus.textContent = message;
    skillGitPublishStatus.dataset.tone = tone;
  }

  function syncGitPublishButtonState() {
    if (disposed) return;
    if (!btnPublishSkillGit) return;
    const skill = allSkillsCache.find(item => skillMatchesName(item, currentSkillName || ""));
    const available = Boolean(gitPublishTarget?.available && skill && !isBuiltinSkill(skill));
    const dirty = isSkillDraftDirty();
    btnPublishSkillGit.classList.toggle("hidden", !available);
    btnPublishSkillGit.disabled = !available || dirty || isSavingSkillEdit || isInspectingGitPublishTarget || isPublishingSkillToGit;
    btnPublishSkillGit.setAttribute("aria-busy", isInspectingGitPublishTarget || isPublishingSkillToGit ? "true" : "false");
    if (dirty) btnPublishSkillGit.title = t("saveTheSkillBeforeCommittingToGit");
    else if (isPublishingSkillToGit) btnPublishSkillGit.title = t("committingToCode");
    else if (isInspectingGitPublishTarget) btnPublishSkillGit.title = t("checkingGitDirectory");
    else btnPublishSkillGit.title = available ? t("commitToCurrentGitDirectory") : t("theCurrentTabIsNotAGitRepositoryDirectory");
  }

  function syncGitPublishConfirmState() {
    if (disposed) return;
    if (btnConfirmSkillGitPublish) {
      btnConfirmSkillGitPublish.disabled = isPublishingSkillToGit;
      btnConfirmSkillGitPublish.textContent = isPublishingSkillToGit ? t("committing") : t("commitToCode");
      btnConfirmSkillGitPublish.setAttribute("aria-busy", isPublishingSkillToGit ? "true" : "false");
    }
    if (skillGitPublishMessage) skillGitPublishMessage.disabled = isPublishingSkillToGit;
    skillGitPublishConfirm?.querySelectorAll<HTMLButtonElement>('[data-skill-git-publish-action="cancel"]').forEach(button => {
      button.disabled = isPublishingSkillToGit;
    });
  }

  async function closeSkillDetail({ force = false } = {}) {
    if (!force && isSkillDraftDirty() && !isSavingSkillEdit && !await confirmAction({
      title: t("discardUnsavedChanges"),
      message: t("returningToTheSkillListWillDiscardYourUnsavedChanges"),
      confirmLabel: t("discardChanges"),
      tone: "danger",
    })) return false;
    closeSkillGitPublishConfirm({ force: true });
    setSkillActionsMenuOpen(false, { restoreFocus: false });
    gitPublishInspectGeneration += 1;
    gitPublishTarget = null;
    syncGitPublishButtonState();
    closeSkillSearch({ restoreFocus: false });
    setSkillEditMode(false);
    currentSkillName = null;
    currentSkillDraft = null;
    if (skillDetail) skillDetail.dataset.readonly = "false";
    skillDetail.classList.add("hidden");
    showSkillsListShell();
    options.onStableViewChange?.();
    return true;
  }

  $<HTMLButtonElement>("#btn-back-skills").addEventListener("click", () => { void closeSkillDetail(); }, { signal: lifecycleSignal });

  btnEditSkill?.addEventListener("click", () => {
    const skill = allSkillsCache.find(s => skillMatchesName(s, currentSkillName || ""));
    if (!skill) return;
    if (isBuiltinSkill(skill)) {
      setSkillsStatus(t("builtInSkillsAreReadOnly"), "error");
      return;
    }
    setSkillEditMode(true);
  }, { signal: lifecycleSignal });

  btnPreviewSkill?.addEventListener("click", () => setSkillEditMode(false), { signal: lifecycleSignal });

  function setSkillActionsMenuOpen(open: boolean, { restoreFocus = true } = {}) {
    const next = Boolean(open && skillActionsMenu && btnSkillActions);
    skillActionsMenu?.classList.toggle("hidden", !next);
    btnSkillActions?.setAttribute("aria-expanded", String(next));
    if (!next && restoreFocus) btnSkillActions?.focus({ preventScroll: true });
  }

  document.querySelectorAll<HTMLElement>("[data-skill-section]").forEach(button => {
    button.addEventListener("click", () => setSkillWorkbenchSection(button.dataset.skillSection || ""), { signal: lifecycleSignal });
  });

  btnSkillSettings?.addEventListener("click", () => {
    if (skillDetail?.dataset.readonly === "true") return;
    if (getSkillDocumentAuthority() === "source" && !syncSkillStructuredEditorsFromSource({ showError: true })) return;
    closeSkillSearch({ restoreFocus: false });
    skillSourceView?.classList.add("hidden");
    skillSettingsView?.classList.remove("hidden");
    const settingsScroll = skillSettingsView?.querySelector<HTMLElement>(".skill-settings-scroll");
    if (settingsScroll) settingsScroll.scrollTop = 0;
    queueSkillConfigTextareaAutosize();
    syncSkillEditingState();
  }, { signal: lifecycleSignal });

  btnCloseSkillSettings?.addEventListener("click", () => {
    skillSettingsView?.classList.add("hidden");
    renderSkillDraftPreview();
    syncSkillEditingState();
  }, { signal: lifecycleSignal });

  btnOpenSkillSource?.addEventListener("click", () => {
    if (getSkillDocumentAuthority() !== "source") syncSkillSourceFromStructuredEditors();
    skillSourceView?.classList.remove("hidden");
    updateSkillSourceValidationState();
    syncSkillEditingState();
    requestAnimationFrame(focusSkillSourceAtStart);
  }, { signal: lifecycleSignal });

  function focusSkillSourceAtStart() {
    const editor = $<HTMLTextAreaElement>("#skill-editor-text");
    const highlight = $("#skill-editor-highlight");
    if (!editor) return;
    editor.setSelectionRange(0, 0);
    editor.focus({ preventScroll: true });
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    if (highlight) {
      highlight.scrollTop = 0;
      highlight.scrollLeft = 0;
    }
  }

  btnCloseSkillSource?.addEventListener("click", () => {
    if (!syncSkillStructuredEditorsFromSource({ showError: true })) return;
    skillSourceView?.classList.add("hidden");
    skillSettingsView?.classList.remove("hidden");
    queueSkillConfigTextareaAutosize();
    syncSkillEditingState();
  }, { signal: lifecycleSignal });

  document.querySelectorAll<HTMLElement>("[data-skill-scope]").forEach(button => {
    button.addEventListener("click", () => {
      setSkillConfigScope(button.dataset.skillScope);
      markSkillDraftDirty("structured");
    }, { signal: lifecycleSignal });
  });

  skillSettingsView?.addEventListener("input", event => {
    if (!(event.target instanceof Element) || !event.target.matches("input, textarea")) return;
    if (event.target.matches("textarea")) queueSkillConfigTextareaAutosize();
    markSkillDraftDirty("structured");
  }, { signal: lifecycleSignal });

  window.addEventListener("resize", () => {
    if (!skillSettingsView?.classList.contains("hidden")) queueSkillConfigTextareaAutosize();
  }, { signal: lifecycleSignal });

  btnExportSkill?.addEventListener("click", () => {
    exportCurrentSkillPackage();
  }, { signal: lifecycleSignal });

  btnSaveSkillEditTop?.addEventListener("click", saveCurrentSkillEdit, { signal: lifecycleSignal });

  document.addEventListener("keydown", event => {
    if (
      !isActive()
      || !isElementVisible(skillDetail)
      || event.defaultPrevented
      || event.altKey
      || event.shiftKey
      || !(event.metaKey || event.ctrlKey)
      || String(event.key || "").toLowerCase() !== "s"
    ) return;
    event.preventDefault();
    event.stopPropagation();
    saveCurrentSkillEdit();
  }, { capture: true, signal: lifecycleSignal });

  let currentSkillExpected: SkillRecord | null = null;

  async function saveCurrentSkillEdit() {
    if (!currentSkillName || isSavingSkillEdit || !isSkillDraftDirty()) return;
    const current = allSkillsCache.find(s => skillMatchesName(s, currentSkillName || ""));
    if (isBuiltinSkill(current)) {
      setSkillEditorStatus(t("builtInSkillsAreReadOnly"), "error", { toast: true });
      return;
    }
    if (getSkillDocumentAuthority() !== "source") syncSkillSourceFromStructuredEditors();
    syncActiveSkillResourceDraft();
    syncSkillMcpDraftsFromDom();
    const sourceSnapshot = $<HTMLTextAreaElement>("#skill-editor-text").value;
    const parsedResources = readSkillResourcesEditor();
    const mcpDraftsSnapshot = skillMcpDrafts.map(draft => ({ ...draft }));
    const mcpDraftsDirtySnapshot = skillMcpDraftsDirty;
    const savingSkillName = currentSkillName;
    const expected = currentSkillExpected;
    const saveSnapshot = captureSkillDraftSave(currentSkillDraft, savingSkillName);
    if (!parsedResources.ok) {
      setSkillEditorStatus(t("couldNotSave", { reason: String(parsedResources.error) }), "error", { toast: true, target: "resources" });
      return;
    }
    setSkillSavingState(true);
    setSkillEditorStatus(t("saving"));
    try {
      const skill = expected;
      if (!skill) throw new Error(t("currentSkillNotFound"));

      const parsed = parseSkillMarkdownDocument(sourceSnapshot);
      const validated = validateSkillMarkdownDocument(parsed, allSkillsCache);
      if (!validated.ok) {
        setSkillEditorStatus(t("couldNotSave", { reason: String(validated.error) }), "error", { toast: true, target: "markdown" });
        return;
      }
      const previousName = savingSkillName;
      const nextName = validated.value.name || previousName;
      const resourcesWithMcp = applySkillMcpEditorToResources(parsedResources.value, {
        name: nextName,
        displayName: validated.value.metadata?.displayName || nextName,
        description: validated.value.description,
      }, mcpDraftsSnapshot, { dirty: mcpDraftsDirtySnapshot });
      if (!resourcesWithMcp.ok) {
        setSkillEditorStatus(t("couldNotSave", { reason: String(resourcesWithMcp.error) }), "error", { toast: true, target: "mcp" });
        return;
      }
      const now = nowBeijingDateTime();
      const updatedSkill = normalizeModernSkill({
        ...skill,
        name: nextName,
        metadata: validated.value.metadata || skill.metadata,
        description: validated.value.description,
        license: validated.value.license,
        compatibility: validated.value.compatibility,
        "allowed-tools": validated.value["allowed-tools"],
        content: validated.value.content,
        scope: validated.value.scope,
        status: validated.value.status,
        domains: validated.value.domains,
        urlPatterns: validated.value.urlPatterns,
        excludePatterns: validated.value.excludePatterns,
        resources: resourcesWithMcp.value,
        updatedAt: now,
      });

      setSkillEditorStatus(t("validatingAndSaving"));
      const result = await request("save_workspace_skill", { name: previousName, skill: updatedSkill, expected }, 60000);
      applyWorkspace(result);
      const savedSkill = result.skill;
      if (!savedSkill) throw new Error(t("theSaveResponseContainsNoSkillRefreshAndTryAgain"));

      const { editorStillCurrent, saveIsCurrent } = classifySkillDraftSave(
        saveSnapshot,
        currentSkillDraft,
        currentSkillName,
      );
      if (editorStillCurrent) {
        currentSkillExpected = savedSkill;
        applySavedSkillToUi(savedSkill, { preserveDraft: !saveIsCurrent });
      } else {
        applySkillFilters();
      }
      if (saveIsCurrent) {
        resetCurrentSkillDraft(savedSkill);
        setSkillDraftClean(savedSkill);
        setSkillEditorStatus("");
      } else if (editorStillCurrent) {
        setSkillEditorStatus(t("savedChangesMadeWhileSavingWerePreserved"), "muted");
      }
      const registryReady = result.registryReady === true;
      setSkillsStatus(
        registryReady ? t("skillSaved") : t("skillSavedToolsWillRefreshAutomaticallyForTheNextTask"),
        registryReady ? "success" : "error",
      );
    } catch (err) {
      setSkillEditorStatus(t("couldNotSave", { reason: String((err instanceof Error ? err.message : err)) }), "error", { toast: true, target: "markdown" });
    } finally {
      setSkillSavingState(false);
    }
  }

  function applySavedSkillToUi(updated: SkillRecord, { preserveDraft = false } = {}) {
    applySkillFilters();
    currentSkillName = updated.name;
    const displayName = getSkillDisplayName(updated) || updated.name;
    $("#skill-detail-name").textContent = displayName;
    $("#skill-detail-name").title = displayName === updated.name ? updated.name : `${displayName} · ${updated.name}`;
    $("#skill-detail-desc").textContent = updated.description;
    const updatedScope = skillScopeDisplay(updated.scope).label;
    const updatedDomain = updated.scope === SKILL_SCOPE_SITE && updated.domains.length ? ` · ${updated.domains.join(", ")}` : "";
    $("#skill-detail-time").textContent = t("updatedAtSummary", { time: String(formatDisplayDateTime(updated.updatedAt) || t("unknown")), scope: String(updatedScope), domains: String(updatedDomain) });
    if (preserveDraft) return;
    renderSkillResources(updated);
    const skillContentEl = $("#skill-detail-content");
    clearMathTypeset(skillContentEl);
    skillContentEl.innerHTML = renderMarkdown(updated.content || "");
    scheduleMathTypeset(skillContentEl);
    setSkillEditorValue(skillToSkillMarkdown(updated));
    setSkillResourcesEditorValue(updated.resources || []);
    setSkillMcpEditorValue(updated);
  }

  function setSkillSavingState(saving: boolean) {
    if (disposed) return;
    isSavingSkillEdit = Boolean(saving);
    const editor = $("#skill-editor");
    editor?.classList.toggle("is-saving", isSavingSkillEdit);
    syncSkillSaveState();
    if (btnAddSkillResource) btnAddSkillResource.disabled = isSavingSkillEdit;
    if (btnAddSkillMcp) btnAddSkillMcp.disabled = isSavingSkillEdit;
  }

  function resetCurrentSkillDraft(skill: Partial<SkillRecord> = {}) {
    currentSkillDraft = createSkillDraft(skillDraftValue(skill), {
      parse(source, snapshot) {
        const parsed = parseSkillMarkdownDocument(source);
        return {
          metadata: {
            ...(snapshot.metadata || {}),
            name: parsed.name || snapshot.metadata?.name || "",
            displayName: parsed.displayName || "",
            description: parsed.description || "",
            scope: parsed.scope || SKILL_SCOPE_GLOBAL,
            status: parsed.status || "active",
            domains: Array.isArray(parsed.domains) ? parsed.domains : [],
            urlPatterns: Array.isArray(parsed.urlPatterns) ? parsed.urlPatterns : [],
            excludePatterns: Array.isArray(parsed.excludePatterns) ? parsed.excludePatterns : [],
          },
          body: parsed.content ?? source,
          resources: snapshot.resources,
          mcp: snapshot.mcp,
        };
      },
      serialize(snapshot) {
        return snapshot.sourceText || $<HTMLTextAreaElement>("#skill-editor-text")?.value || snapshot.body || "";
      },
    });
  }

  function ensureCurrentSkillDraft() {
    if (currentSkillDraft) return currentSkillDraft;
    const skill = allSkillsCache.find(item => skillMatchesName(item, currentSkillName || "")) || {};
    resetCurrentSkillDraft(skill);
    return currentSkillDraft;
  }

  function skillDraftValue(skill: Partial<SkillRecord> = {}) {
    const normalized = normalizeSkill(skill);
    return {
      metadata: {
        ...(isPlainYamlObject(normalized.metadata) ? normalized.metadata : {}),
        name: normalized.name || currentSkillName || "",
        displayName: getSkillDisplayName(normalized) || "",
        description: normalized.description || "",
        scope: normalized.scope || SKILL_SCOPE_GLOBAL,
        status: normalized.status || "active",
        domains: normalized.domains || [],
        urlPatterns: normalized.urlPatterns || [],
        excludePatterns: normalized.excludePatterns || [],
      },
      body: normalized.content || "",
      resources: normalized.resources || [],
      mcp: extractSkillMcpDrafts(normalized),
      sourceText: $<HTMLTextAreaElement>("#skill-editor-text")?.value || skillToSkillMarkdown(normalized),
      authority: "structured",
    };
  }

  function readStructuredSkillDraft() {
    const config = readSkillConfigEditor();
    return {
      metadata: { ...config },
      body: skillBodyText?.value || "",
      resources: skillResourceDrafts.map(resource => ({ ...resource })),
      mcp: skillMcpDrafts.map(server => ({ ...server })),
      sourceText: $<HTMLTextAreaElement>("#skill-editor-text")?.value || "",
    };
  }

  function isSkillDraftDirty() {
    return currentSkillDraft?.dirty === true;
  }

  function getSkillDocumentAuthority() {
    return currentSkillDraft?.authority || "structured";
  }

  function markSkillDraftDirty(authority = "structured") {
    if (skillDetail?.dataset.readonly === "true") return;
    ensureCurrentSkillDraft();
    if (authority === "source") {
      currentSkillDraft?.replaceFromSource($<HTMLTextAreaElement>("#skill-editor-text")?.value || "");
    } else {
      currentSkillDraft?.update(readStructuredSkillDraft(), { authority: "structured" });
    }
    syncSkillSaveState();
    if (skillContentMode === "preview") $("#skill-content-status").textContent = t("previewIncludesUnsavedChanges");
  }

  function setSkillDraftClean(savedSkill: SkillRecord | null = null) {
    if (currentSkillDraft) currentSkillDraft.markSaved(savedSkill ? skillDraftValue(savedSkill) : null);
    syncSkillSaveState();
    if ($("#skill-content-status")) $("#skill-content-status").textContent = t("previewIsUpToDate");
  }

  function syncSkillSaveState() {
    const saved = !isSkillDraftDirty() && !isSavingSkillEdit;
    const buttons = [btnSaveSkillEditTop].filter(Boolean);
    for (const button of buttons) {
      const labelTarget = button.querySelector<HTMLElement>("span:last-child") || button;
      labelTarget.textContent = isSavingSkillEdit ? t("savingStatus") : (saved ? t("saved") : t("save"));
      button.classList.toggle("saved", saved);
      button.disabled = isSavingSkillEdit || saved;
      button.title = isSavingSkillEdit ? t("savingSkill") : (saved ? t("skillSavedStatus") : t("saveSkill"));
      button.setAttribute("aria-busy", isSavingSkillEdit ? "true" : "false");
    }
    syncGitPublishButtonState();
  }

  $<HTMLTextAreaElement>("#skill-editor-text").addEventListener("input", () => {
    updateMarkdownHighlight($<HTMLTextAreaElement>("#skill-editor-text").value, { defer: true });
    markSkillDraftDirty("source");
    updateSkillSourceValidationState();
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  skillBodyText?.addEventListener("input", () => {
    updateSkillBodyHighlight({ defer: true });
    markSkillDraftDirty("structured");
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  skillResourcesList?.addEventListener("input", (event) => {
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".skill-resource-inline-name")) return;
    syncActiveSkillResourceDraft();
    syncActiveSkillResourceHeading();
    markSkillDraftDirty();
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  skillResourcesList?.addEventListener("click", (event) => {
    const button = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("button[data-skill-resource-action]");
    if (!button || !skillResourcesList.contains(button)) return;
    const action = button.dataset.skillResourceAction;
    if (action === "open") {
      const index = Number(button.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < skillResourceDrafts.length) {
        activeSkillResourceIndex = index;
        renderSkillResourcesEditor();
      }
      return;
    }
    if (action === "back") {
      syncActiveSkillResourceDraft();
      activeSkillResourceIndex = -1;
      renderSkillResourcesEditor();
      return;
    }
    if (action === "delete") {
      const index = Number(button.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < skillResourceDrafts.length) {
        skillResourceDrafts.splice(index, 1);
        activeSkillResourceIndex = -1;
        renderSkillResourcesEditor();
      }
      markSkillDraftDirty();
      setSkillEditorStatus("");
    }
  }, { signal: lifecycleSignal });

  skillMcpList?.addEventListener("input", () => {
    syncSkillMcpDraftsFromDom();
    skillMcpDraftsDirty = true;
    syncSkillResourcesEditorMeta();
    markSkillDraftDirty();
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  skillMcpList?.addEventListener("change", (event) => {
    const enabledInput = (event.target instanceof Element ? event.target : null)?.closest<HTMLInputElement>(".skill-mcp-edit-enabled");
    if (enabledInput && skillMcpList.contains(enabledInput)) syncSkillMcpEnabledLabel(enabledInput);
    syncSkillMcpDraftsFromDom();
    skillMcpDraftsDirty = true;
    syncSkillResourcesEditorMeta();
    markSkillDraftDirty();
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  skillMcpList?.addEventListener("click", async (event) => {
    const button = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>("button[data-skill-mcp-action]");
    if (!button || !skillMcpList.contains(button)) return;
    const action = button.dataset.skillMcpAction;
    if (action === "open") {
      const index = Number(button.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < skillMcpDrafts.length) {
        activeSkillMcpIndex = index;
        renderSkillMcpEditor();
      }
      return;
    }
    if (action === "back") {
      syncActiveSkillMcpDraft();
      activeSkillMcpIndex = -1;
      renderSkillMcpEditor();
      return;
    }
    if (action === "test") {
      await testActiveSkillMcpDraft(button);
      return;
    }
    if (action === "delete") {
      syncSkillMcpDraftsFromDom();
      const index = Number(button.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < skillMcpDrafts.length) {
        skillMcpDrafts.splice(index, 1);
        skillMcpDraftsDirty = true;
        activeSkillMcpIndex = -1;
        renderSkillMcpEditor();
      }
      markSkillDraftDirty();
      setSkillEditorStatus("");
    }
  }, { signal: lifecycleSignal });

  async function testActiveSkillMcpDraft(button: HTMLButtonElement) {
    if (isTestingSkillMcp || activeSkillMcpIndex < 0) return;
    syncActiveSkillMcpDraft();
    const resultEl = skillMcpList?.querySelector<HTMLElement>(".skill-mcp-test-result");
    const draft = skillMcpDrafts[activeSkillMcpIndex];
    const normalized = normalizeSkillMcpDraftsForManifest(draft ? [draft] : []);
    if (!normalized.ok || !normalized.value.length) {
      setSkillMcpTestResult(resultEl, normalized.error || t("enterAValidMcpConfigurationFirst"), true);
      return;
    }
    isTestingSkillMcp = true;
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = t("testing");
    setSkillMcpTestResult(resultEl, "");
    try {
      const current = normalizeSkill(allSkillsCache.find(skill => skillMatchesName(skill, currentSkillName || "")) || {});
      const resources = readSkillResourcesEditor();
      if (!resources.ok) throw new Error(resources.error);
      const previousDirty = skillMcpDraftsDirty;
      skillMcpDraftsDirty = true;
      const resourcesWithMcp = applySkillMcpEditorToResources(resources.value, current);
      skillMcpDraftsDirty = previousDirty;
      if (!resourcesWithMcp.ok) throw new Error(resourcesWithMcp.error);
      await validateSkillMcpBeforeSave(normalizeModernSkill({ ...current, resources: resourcesWithMcp.value }));
      setSkillMcpTestResult(resultEl, t("connected"));
    } catch (err) {
      setSkillMcpTestResult(resultEl, (err instanceof Error ? err.message : String(err)), true);
    } finally {
      isTestingSkillMcp = false;
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }

  function setSkillMcpTestResult(target: HTMLElement | null, message = "", error = false) {
    if (disposed) return;
    if (!target) return;
    const text = String(message || "");
    target.textContent = text;
    target.classList.toggle("error", Boolean(error && text));
    target.classList.toggle("success", Boolean(!error && text));
    if (error && text) target.title = text;
    else target.removeAttribute("title");
  }

  btnAddSkillResource?.addEventListener("click", () => {
    syncActiveSkillResourceDraft();
    skillResourceDrafts.push({
      path: nextSkillResourcePath(),
      type: "markdown",
      title: "",
      description: "",
      content: "",
    });
    activeSkillResourceIndex = skillResourceDrafts.length - 1;
    renderSkillResourcesEditor();
    markSkillDraftDirty();
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  btnAddSkillMcp?.addEventListener("click", () => {
    syncSkillMcpDraftsFromDom();
    skillMcpDrafts.push({
      id: nextSkillMcpId(),
      url: "",
      enabled: true,
      headersText: "{}",
      timeoutMs: "",
      callTimeoutMs: "",
    });
    skillMcpDraftsDirty = true;
    activeSkillMcpIndex = skillMcpDrafts.length - 1;
    renderSkillMcpEditor();
    markSkillDraftDirty();
    setSkillEditorStatus("");
  }, { signal: lifecycleSignal });

  $<HTMLTextAreaElement>("#skill-editor-text").addEventListener("scroll", () => {
    const editor = $<HTMLTextAreaElement>("#skill-editor-text");
    const highlight = $("#skill-editor-highlight");
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }, { signal: lifecycleSignal });

  skillBodyText?.addEventListener("scroll", () => {
    if (!skillBodyHighlight) return;
    skillBodyHighlight.scrollTop = skillBodyText.scrollTop;
    skillBodyHighlight.scrollLeft = skillBodyText.scrollLeft;
  }, { signal: lifecycleSignal });

  function setSkillEditorValue(value: string) {
    const source = String(value || "");
    const sourceEditor = $<HTMLTextAreaElement>("#skill-editor-text");
    const sourceHighlight = $("#skill-editor-highlight");
    sourceEditor.value = source;
    sourceEditor.setSelectionRange(0, 0);
    sourceEditor.scrollTop = 0;
    sourceEditor.scrollLeft = 0;
    if (sourceHighlight) {
      sourceHighlight.scrollTop = 0;
      sourceHighlight.scrollLeft = 0;
    }
    updateMarkdownHighlight(source);
    const parsed = parseSkillMarkdownDocument(source);
    if (!parsed.yamlErrors?.length) {
      if (skillBodyText) {
        skillBodyText.value = parsed.content || "";
        skillBodyText.setSelectionRange(0, 0);
        skillBodyText.scrollTop = 0;
        skillBodyText.scrollLeft = 0;
      }
      setSkillConfigEditor(parsed);
    } else if (skillBodyText) {
      skillBodyText.value = source;
    }
    updateSkillBodyHighlight();
    updateSkillSourceValidationState();
  }

  function setSkillResourcesEditorValue(resources: ResourceDraft[] = []) {
    skillResourceDrafts = normalizeSkillResourceContents(resources).map(resource => ({ ...resource }));
    activeSkillResourceIndex = -1;
    renderSkillResourcesEditor();
  }

  function setSkillMcpEditorValue(skill: Partial<SkillRecord> = {}) {
    skillMcpDrafts = extractSkillMcpDrafts(skill).map(draft => ({ ...draft }));
    skillMcpDraftsDirty = false;
    activeSkillMcpIndex = -1;
    renderSkillMcpEditor();
  }

  function updateSkillBodyHighlight({ defer = false } = {}) {
    if (!skillBodyText || !skillBodyHighlight) return;
    renderSyntaxHighlight(skillBodyHighlight, () => highlightCode(
      skillBodyText.value || "",
      "markdown",
      { autoDetect: false, maxLength: LIVE_HIGHLIGHT_MAX_LENGTH },
    ), { defer });
    skillBodyHighlight.scrollTop = skillBodyText.scrollTop;
    skillBodyHighlight.scrollLeft = skillBodyText.scrollLeft;
  }

  function renderSyntaxHighlight(target: HTMLElement | null, createResult: () => ReturnType<typeof highlightCode>, { defer = false } = {}) {
    if (!target || typeof createResult !== "function") return;
    const pendingFrame = pendingSyntaxHighlightFrames.get(target);
    if (pendingFrame) cancelAnimationFrame(pendingFrame);

    const commit = () => {
      pendingSyntaxHighlightFrames.delete(target);
      if (lifecycleSignal?.aborted) return;
      const result = createResult();
      target.innerHTML = `${result.html}\n`;
      target.dataset.highlighter = result.vendor || "plain";
      target.dataset.language = result.language || "";
      for (const className of Array.from(target.classList)) {
        if (className.startsWith("language-")) target.classList.remove(className);
      }
      if (result.language) target.classList.add(`language-${result.language}`);
      target.classList.toggle("syntax-highlight-plain", result.vendor !== "highlight.js");
    };

    if (!defer) {
      commit();
      return;
    }
    pendingSyntaxHighlightFrames.set(target, requestAnimationFrame(commit));
  }

  function setSkillConfigEditor(parsed: Fields = {}) {
    const metadata = isPlainYamlObject(parsed.metadata) ? parsed.metadata : {};
    const setValue = (selector: string, value: unknown) => {
      const field = $<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (field) field.value = value == null ? "" : String(value);
    };
    setValue("#skill-config-display-name", parsed.displayName ?? metadata.displayName ?? "");
    setValue("#skill-config-name", parsed.name ?? currentSkillName ?? "");
    setValue("#skill-config-description", parsed.description ?? "");
    setValue("#skill-config-domains", skillConfigListText(parsed.domains));
    setValue("#skill-config-url-patterns", skillConfigListText(parsed.urlPatterns));
    setValue("#skill-config-exclude-patterns", skillConfigListText(parsed.excludePatterns));
    const enabled = $<HTMLInputElement>("#skill-config-enabled");
    if (enabled) enabled.checked = String(parsed.status || "active").toLowerCase() !== "disabled";
    setSkillConfigScope(String(parsed.scope || SKILL_SCOPE_GLOBAL));
    queueSkillConfigTextareaAutosize();
  }

  function readSkillConfigEditor() {
    const value = (selector: string) => String($<HTMLInputElement | HTMLTextAreaElement>(selector)?.value || "").trim();
    const activeScope = document.querySelector<HTMLElement>("[data-skill-scope].active")?.dataset.skillScope || SKILL_SCOPE_GLOBAL;
    return {
      displayName: value("#skill-config-display-name"),
      name: value("#skill-config-name"),
      description: value("#skill-config-description"),
      scope: activeScope,
      status: $<HTMLInputElement>("#skill-config-enabled")?.checked === false ? "disabled" : "active",
      domains: parseSkillConfigList(value("#skill-config-domains")),
      urlPatterns: parseSkillConfigList(value("#skill-config-url-patterns")),
      excludePatterns: parseSkillConfigList(value("#skill-config-exclude-patterns")),
    };
  }

  function setSkillConfigScope(scope = SKILL_SCOPE_GLOBAL) {
    const next = [SKILL_SCOPE_RESIDENT, SKILL_SCOPE_GLOBAL, SKILL_SCOPE_SITE].includes(scope) ? scope : SKILL_SCOPE_GLOBAL;
    document.querySelectorAll<HTMLElement>("[data-skill-scope]").forEach(button => {
      const active = button.dataset.skillScope === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    $(".skill-config-scope-fields")?.classList.toggle("hidden", next !== SKILL_SCOPE_SITE);
    queueSkillConfigTextareaAutosize();
  }

  let skillConfigAutosizeFrame = 0;

  function queueSkillConfigTextareaAutosize() {
    cancelAnimationFrame(skillConfigAutosizeFrame);
    skillConfigAutosizeFrame = requestAnimationFrame(() => {
      skillConfigAutosizeFrame = 0;
      skillSettingsView?.querySelectorAll<HTMLElement>(".skill-config-grid textarea").forEach(textarea => {
        if (textarea.offsetParent === null) return;
        const minHeight = textarea.id === "skill-config-description" ? 40 : 31;
        textarea.style.height = "auto";
        const borderHeight = textarea.offsetHeight - textarea.clientHeight;
        textarea.style.height = `${Math.max(minHeight, textarea.scrollHeight + borderHeight)}px`;
      });
    });
  }

  function skillConfigListText(value: unknown) {
    return (Array.isArray(value) ? value : []).map(item => String(item || "").trim()).filter(Boolean).join("\n");
  }

  function parseSkillConfigList(value = "") {
    const seen = new Set();
    const out = [];
    for (const item of String(value || "").split(/[\n,]/)) {
      const text = item.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  function syncSkillSourceFromStructuredEditors() {
    const currentSource = $<HTMLTextAreaElement>("#skill-editor-text")?.value || "";
    const parsed = parseSkillMarkdownDocument(currentSource);
    const current = normalizeSkill(allSkillsCache.find(skill => skillMatchesName(skill, currentSkillName || "")) || {});
    const config = readSkillConfigEditor();
    const metadata = {
      ...(isPlainYamlObject(current.metadata) ? current.metadata : {}),
      ...(isPlainYamlObject(parsed.metadata) ? parsed.metadata : {}),
    };
    if (config.displayName && config.displayName !== config.name) metadata.displayName = config.displayName;
    else delete metadata.displayName;
    metadata.scope = config.scope;
    metadata.status = config.status;
    metadata.domains = config.domains;
    metadata.urlPatterns = config.urlPatterns;
    metadata.excludePatterns = config.excludePatterns;
    const draft = {
      ...current,
      ...(isPlainYamlObject(parsed.frontmatter) ? parsed.frontmatter : {}),
      name: config.name,
      displayName: config.displayName,
      description: config.description,
      metadata,
      scope: config.scope,
      status: config.status,
      domains: config.domains,
      urlPatterns: config.urlPatterns,
      excludePatterns: config.excludePatterns,
      content: skillBodyText?.value || "",
    };
    let source = skillToSkillMarkdown(draft);
    source = source.replace(/^name:\s*.*$/m, `name: ${JSON.stringify(config.name)}`);
    $<HTMLTextAreaElement>("#skill-editor-text").value = source;
    updateMarkdownHighlight(source);
    currentSkillDraft?.setAuthority("structured");
    updateSkillSourceValidationState();
    return source;
  }

  function syncSkillStructuredEditorsFromSource({ showError = false } = {}) {
    const source = $<HTMLTextAreaElement>("#skill-editor-text")?.value || "";
    const parsed = parseSkillMarkdownDocument(source);
    if (!parsed.hasFrontmatter || parsed.yamlErrors?.length) {
      updateSkillSourceValidationState();
      if (showError) setSkillEditorStatus(t("fixTheYamlFrontmatterInSkillMdFirst"), "error", { toast: true, target: "markdown" });
      return false;
    }
    if (skillBodyText) skillBodyText.value = parsed.content || "";
    setSkillConfigEditor(parsed);
    updateSkillBodyHighlight();
    renderSkillDraftPreview();
    currentSkillDraft?.setAuthority("source");
    updateSkillSourceValidationState();
    return true;
  }

  function updateSkillSourceValidationState() {
    if (!skillSourceStatus) return;
    const parsed = parseSkillMarkdownDocument($<HTMLTextAreaElement>("#skill-editor-text")?.value || "");
    const valid = parsed.hasFrontmatter && !(parsed.yamlErrors || []).length;
    skillSourceStatus.textContent = valid ? t("validYaml") : t("invalidYaml");
    skillSourceStatus.classList.toggle("error", !valid);
  }

  function extractSkillMcpDrafts(skill: Partial<SkillRecord> = {}) {
    const manifestResource = findSkillManifestResource(skill.resources || []);
    if (!manifestResource) return [];
    const manifest = parseJsonObject(manifestResource.content || "");
    if (!manifest) return [];
    const rawServers = manifest.mcpServers ?? (isPlainYamlObject(manifest.connections) ? manifest.connections.mcpServers : undefined);
    const entries = [];
    if (Array.isArray(rawServers)) {
      rawServers.forEach((server, index) => entries.push([server?.id || server?.name || `mcp-${index + 1}`, server]));
    } else if (rawServers && typeof rawServers === "object") {
      for (const [id, server] of Object.entries(rawServers)) entries.push([id, server]);
    }
    return entries
      .map(([id, server]) => normalizeMcpDraft(id, server))
      .filter(server => server !== null);
  }

  function normalizeMcpDraft(id: unknown = "", value: unknown = {}): McpDraft | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const server = value as Fields;
    const headers = server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? server.headers : {};
    return {
      id: String(server.id || server.name || id || "mcp").trim(),
      url: String(server.url || server.endpoint || server.baseUrl || "").trim(),
      enabled: server.enabled !== false,
      headersText: JSON.stringify(headers, null, 2),
      timeoutMs: server.timeoutMs ?? server.timeout ?? "",
      callTimeoutMs: server.callTimeoutMs ?? "",
    };
  }

  function renderSkillMcpEditor() {
    if (!skillMcpList) return;
    syncSkillResourcesEditorMeta();
    if (activeSkillMcpIndex < 0 || activeSkillMcpIndex >= skillMcpDrafts.length) {
      activeSkillMcpIndex = -1;
      if (!skillMcpDrafts.length) {
        skillMcpList.innerHTML = `<div class="skill-list-empty">${escapeHtml(t("noMcpServers"))}</div>`;
        return;
      }
      skillMcpList.innerHTML = skillMcpDrafts.map((draft, index) => {
        const id = String(draft.id || `mcp-${index + 1}`);
        const host = safeUrlHost(draft.url) || String(draft.url || t("urlNotConfigured"));
        const status = draft.enabled === false ? t("disabledStatus") : t("enabled");
        return `
          <button class="skill-mcp-list-row" type="button" data-skill-mcp-action="open" data-index="${index}">
            <span class="skill-list-type-icon" aria-hidden="true"><span class="skill-list-type-label">MCP</span></span>
            <span class="skill-list-row-main">
              <span class="skill-list-row-title">${escapeHtml(id)}</span>
              <span class="skill-list-row-subtitle" title="${escapeHtmlAttribute(draft.url || "")}">${escapeHtml(host)}</span>
            </span>
            <span class="${draft.enabled === false ? "skill-list-row-meta" : "skill-mcp-connected"}">${escapeHtml(status)}</span>
            <span class="skill-list-row-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></span>
          </button>
        `;
      }).join("");
      return;
    }
    skillMcpList.innerHTML = renderSkillMcpDraft(skillMcpDrafts[activeSkillMcpIndex], activeSkillMcpIndex);
  }

  function renderSkillMcpDraft(draft: McpDraft, index = 0) {
    const readonly = skillDetail?.dataset.readonly === "true";
    const readOnlyAttr = readonly ? " readonly" : "";
    const disabledAttr = readonly ? " disabled" : "";
    return `
      <div class="skill-mcp-edit-item qz-scroll" data-index="${index}">
        <div class="skill-mcp-detail-header">
          <button class="qz-icon-btn qz-icon-btn--md icon-btn" type="button" title="${escapeHtmlAttribute(t("backToMcpServers"))}" aria-label="${escapeHtmlAttribute(t("backToMcpServers"))}" data-skill-mcp-action="back">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <strong>${escapeHtml(draft.id || `mcp-${index + 1}`)}</strong>
          <label class="skill-mcp-enabled" title="${escapeHtmlAttribute(draft.enabled === false ? t("clickToEnableMcp") : t("clickToDisableMcp"))}">
            <input class="qz-switch skill-mcp-edit-enabled" type="checkbox" aria-label="${escapeHtmlAttribute(draft.enabled === false ? t("disabledClickToEnableMcp") : t("enabledClickToDisableMcp"))}"${draft.enabled === false ? "" : " checked"}${disabledAttr}>
            <span class="skill-mcp-enabled-text">${draft.enabled === false ? t("disabledStatus") : t("enabled")}</span>
          </label>
          ${readonly ? "" : `
            <button class="qz-icon-btn qz-icon-btn--sm qz-icon-btn--danger icon-btn skill-mcp-delete-btn" type="button" title="${escapeHtmlAttribute(t("deleteMcp"))}" aria-label="${escapeHtmlAttribute(t("deleteMcp"))}" data-skill-mcp-action="delete" data-index="${index}">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>
            </button>
          `}
        </div>
        <section class="skill-mcp-form-section">
          <label>
            <span>ID</span>
            <input class="qz-field qz-field--sm qz-field--mono skill-mcp-edit-id" type="text" value="${escapeHtmlAttribute(draft.id || "")}" placeholder="context7"${readOnlyAttr}>
          </label>
          <label>
            <span>${escapeHtml(t("remoteUrl"))}</span>
            <input class="qz-field qz-field--sm qz-field--mono skill-mcp-edit-url" type="url" value="${escapeHtmlAttribute(draft.url || "")}" placeholder="https://example.com/mcp"${readOnlyAttr}>
          </label>
          <div class="skill-mcp-timeout-row">
            <label>
              <span>${escapeHtml(t("connectionTimeout"))}</span>
              <input class="qz-field qz-field--sm qz-field--mono skill-mcp-edit-timeout" type="number" min="1000" step="1000" value="${escapeHtmlAttribute(draft.timeoutMs || "")}" placeholder="30000 ms"${readOnlyAttr}>
            </label>
            <label>
              <span>${escapeHtml(t("callTimeout"))}</span>
              <input class="qz-field qz-field--sm qz-field--mono skill-mcp-edit-call-timeout" type="number" min="1000" step="1000" value="${escapeHtmlAttribute(draft.callTimeoutMs || "")}" placeholder="${escapeHtmlAttribute(t("sameAsConnectionTimeout"))}"${readOnlyAttr}>
            </label>
          </div>
        </section>
        <section class="skill-mcp-form-section">
          <label>
            <span>Headers JSON</span>
            <textarea class="qz-field qz-field--sm qz-field--mono skill-mcp-edit-headers" spellcheck="false" wrap="soft" rows="5"${readOnlyAttr}>${escapeHtml(draft.headersText || "{}")}</textarea>
          </label>
        </section>
        <div class="skill-mcp-test-row">
          <button class="qz-btn qz-btn--secondary qz-btn--sm " type="button" data-skill-mcp-action="test" data-index="${index}">${escapeHtml(t("testConnection"))}</button>
          <span class="skill-mcp-test-result" role="status" aria-live="polite"></span>
        </div>
      </div>
    `;
  }

  function syncSkillMcpDraftsFromDom() {
    syncActiveSkillMcpDraft();
  }

  function syncActiveSkillMcpDraft() {
    if (!skillMcpList || activeSkillMcpIndex < 0 || activeSkillMcpIndex >= skillMcpDrafts.length) return;
    const item = skillMcpList.querySelector<HTMLElement>(".skill-mcp-edit-item");
    if (!item) return;
    skillMcpDrafts[activeSkillMcpIndex] = {
      ...skillMcpDrafts[activeSkillMcpIndex],
      id: item.querySelector<HTMLInputElement>(".skill-mcp-edit-id")?.value || "",
      url: item.querySelector<HTMLInputElement>(".skill-mcp-edit-url")?.value || "",
      enabled: item.querySelector<HTMLInputElement>(".skill-mcp-edit-enabled")?.checked !== false,
      headersText: item.querySelector<HTMLTextAreaElement>(".skill-mcp-edit-headers")?.value || "{}",
      timeoutMs: item.querySelector<HTMLInputElement>(".skill-mcp-edit-timeout")?.value || "",
      callTimeoutMs: item.querySelector<HTMLInputElement>(".skill-mcp-edit-call-timeout")?.value || "",
    };
    const title = skillMcpList.querySelector<HTMLElement>(".skill-mcp-detail-header strong");
    if (title) title.textContent = skillMcpDrafts[activeSkillMcpIndex].id || `mcp-${activeSkillMcpIndex + 1}`;
  }

  function syncSkillMcpEnabledLabel(input: HTMLInputElement | null) {
    const label = input?.closest<HTMLElement>(".skill-mcp-enabled");
    const text = label?.querySelector<HTMLElement>(".skill-mcp-enabled-text");
    if (!input || !label || !text) return;
    const enabled = input.checked !== false;
    text.textContent = enabled ? t("enabled") : t("disabledStatus");
    label.title = enabled ? t("clickToDisableMcp") : t("clickToEnableMcp");
    input.setAttribute("aria-label", enabled ? t("enabledClickToDisableMcp") : t("disabledClickToEnableMcp"));
  }

  function nextSkillMcpId() {
    const existing = new Set(skillMcpDrafts.map(item => normalizeSkillMcpId(item.id)).filter(Boolean));
    for (let index = 1; index < 100; index += 1) {
      const id = `mcp-${index}`;
      if (!existing.has(id)) return id;
    }
    return `mcp-${Date.now().toString(36)}`;
  }

  function applySkillMcpEditorToResources(
    resources: ResourceDraft[] = [],
    skill: { name?: unknown; displayName?: unknown; description?: unknown } = {},
    drafts = skillMcpDrafts,
    { dirty = skillMcpDraftsDirty } = {},
  ) {
    if (!dirty) return { ok: true as const, value: resources };
    if (drafts === skillMcpDrafts) syncSkillMcpDraftsFromDom();
    const normalized = normalizeSkillMcpDraftsForManifest(drafts);
    if (!normalized.ok) return normalized;
    const existingResources = normalizeSkillResourceContents(resources);
    const manifestIndex = existingResources.findIndex(resource => cleanSkillResourcePath(resource.path) === "plugin.json");
    let manifest = manifestIndex >= 0 ? parseJsonObject(existingResources[manifestIndex].content || "") : null;
    if (manifestIndex >= 0 && !manifest) return { ok: false as const, error: t("pluginJsonIsNotValidJsonMcpSettingsCannotBe") };
    if (!manifest) {
      if (!normalized.value.length) return { ok: true as const, value: existingResources };
      manifest = {
        format: SKILL_MANIFEST_FORMAT,
        schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
        id: normalizeSkillMcpManifestId(String(skill.name || currentSkillName || "skill")),
        displayName: String(skill.displayName || skill.name || currentSkillName || "").trim(),
        description: String(skill.description || "").trim(),
        tools: [],
      };
    }
    if (normalized.value.length) {
      manifest.mcpServers = Object.fromEntries(normalized.value.map(server => [server.id, serializeMcpServerDraft(server)]));
    } else {
      delete manifest.mcpServers;
    }
    const nextResource = {
      ...(manifestIndex >= 0 ? existingResources[manifestIndex] : {}),
      path: "plugin.json",
      type: "json",
      title: "plugin.json",
      description: t("skillToolManifest"),
      content: JSON.stringify(manifest, null, 2),
    };
    if (manifestIndex >= 0) existingResources[manifestIndex] = nextResource;
    else existingResources.unshift(nextResource);
    return { ok: true as const, value: normalizeSkillResourceContents(existingResources) };
  }

  function normalizeSkillMcpDraftsForManifest(drafts: McpDraft[] = []) {
    const out = [];
    const seen = new Set();
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index] || {};
      const id = normalizeSkillMcpId(draft.id);
      const url = String(draft.url || "").trim();
      const hasAnyValue = [id, url, draft.headersText, draft.timeoutMs, draft.callTimeoutMs]
        .some(value => String(value || "").trim() && String(value || "").trim() !== "{}");
      if (!hasAnyValue) continue;
      if (!id) return { ok: false as const, error: t("mcpEntryHasNoId", { index: String(index + 1) }) };
      if (seen.has(id)) return { ok: false as const, error: t("duplicateMcpId", { id: String(id) }) };
      seen.add(id);
      if (!isHttpUrl(url)) return { ok: false as const, error: t("mcpEntryRequiresAnHttpSUrl", { index: String(index + 1) }) };
      const headers = parseJsonObject(draft.headersText || "{}");
      if (!headers) return { ok: false as const, error: t("mcpEntryHeadersMustBeAJsonObject", { index: String(index + 1) }) };
      out.push({
        id,
        url,
        enabled: draft.enabled !== false,
        headers,
        timeoutMs: normalizeOptionalPositiveNumber(draft.timeoutMs),
        callTimeoutMs: normalizeOptionalPositiveNumber(draft.callTimeoutMs),
      });
    }
    return { ok: true as const, value: out };
  }

  function serializeMcpServerDraft(server: McpServerDraft) {
    const out: { type: string; url: string; enabled: boolean; headers?: Fields; timeoutMs?: number; callTimeoutMs?: number } = {
      type: "remote",
      url: server.url,
      enabled: server.enabled !== false,
    };
    if (server.headers && Object.keys(server.headers).length) out.headers = server.headers;
    if (server.timeoutMs) out.timeoutMs = server.timeoutMs;
    if (server.callTimeoutMs) out.callTimeoutMs = server.callTimeoutMs;
    return out;
  }

  function normalizeSkillMcpId(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  function normalizeSkillMcpManifestId(value = "") {
    return normalizeSkillMcpId(value) || "skill-mcp";
  }

  function normalizeOptionalPositiveNumber(value: unknown) {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  }

  function parseJsonObject(content = ""): Fields | null {
    try {
      const parsed = JSON.parse(String(content || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_err) {
      return null;
    }
  }

  function isHttpUrl(value = "") {
    try {
      return /^https?:$/i.test(new URL(String(value || "").trim()).protocol);
    } catch (_err) {
      return false;
    }
  }

  async function validateSkillMcpBeforeSave(skill: Partial<SkillRecord> = {}) {
    const result = await request("validate_skill_mcp", { skill, refresh: true }, 60000);
    if (result?.ok === false || result?.error) throw new Error(result.error || t("mcpValidationFailed"));
    return result;
  }

  function readSkillResourcesEditor() {
    syncActiveSkillResourceDraft();
    if (!skillResourceDrafts.length) return { ok: true as const, value: [] };
    const rows = [];
    const seen = new Set();
    for (let index = 0; index < skillResourceDrafts.length; index += 1) {
      const draft = skillResourceDrafts[index] || {};
      const path = cleanSkillResourcePath(draft.path || "");
      const content = draft.content || "";
      const hasAnyValue = [
        path,
        content,
        draft.description,
      ].some(value => String(value || "").trim());
      if (!hasAnyValue) continue;
      if (!path) return { ok: false as const, error: t("resourceHasNoPath", { index: String(index + 1) }) };
      if (!isValidSkillResourcePath(path)) return { ok: false as const, error: t("resourceHasAnInvalidPath", { index: String(index + 1) }) };
      const lookup = path.toLowerCase();
      if (seen.has(lookup)) return { ok: false as const, error: t("duplicateResourcePath", { path: String(path) }) };
      seen.add(lookup);
      rows.push({
        path,
        type: inferSkillResourceType(path),
        description: String(draft.description || "").trim(),
        ...(draft.encoding === "base64" ? { encoding: "base64" } : {}),
        ...(draft.mimeType ? { mimeType: String(draft.mimeType) } : {}),
        ...(Number.isFinite(Number(draft.size)) ? { size: Math.max(0, Math.floor(Number(draft.size))) } : {}),
        content,
      });
    }
    return { ok: true as const, value: normalizeSkillResourceContents(rows) };
  }

  function renderSkillResourcesEditor() {
    if (!skillResourcesList) return;
    syncSkillResourcesEditorMeta();
    const readonly = skillDetail?.dataset.readonly === "true";
    if (activeSkillResourceIndex < 0 || activeSkillResourceIndex >= skillResourceDrafts.length) {
      activeSkillResourceIndex = -1;
      if (!skillResourceDrafts.length) {
        skillResourcesList.innerHTML = `<div class="skill-list-empty">${escapeHtml(t("noResources"))}</div>`;
        return;
      }
      skillResourcesList.innerHTML = skillResourceDrafts.map((resource, index) => {
        const path = cleanSkillResourcePath(resource.path || "") || t("untitled", { index: String(index + 1) });
        const type = inferSkillResourceType(path);
        const description = String(resource.description || "").trim() || resourceTypeLabel(type);
        const size = formatByteSize(
          resource.encoding === "base64" && Number.isFinite(Number(resource.size))
            ? Number(resource.size)
            : String(resource.content || "").length,
        );
        return `
          <button class="skill-resource-list-row" type="button" data-skill-resource-action="open" data-index="${index}">
            <span class="skill-list-type-icon" aria-hidden="true">${skillResourceTypeIcon(type)}</span>
            <span class="skill-list-row-main">
              <span class="skill-list-row-title" title="${escapeHtmlAttribute(path)}">${escapeHtml(path)}</span>
              <span class="skill-list-row-subtitle">${escapeHtml(description)}</span>
            </span>
            <span class="skill-list-row-meta">${escapeHtml(size)}</span>
            <span class="skill-list-row-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></span>
          </button>
        `;
      }).join("");
      return;
    }
    const active = skillResourceDrafts[activeSkillResourceIndex] || {};
    const activePath = active.path || t("untitled", { index: String(activeSkillResourceIndex + 1) });
    skillResourcesList.innerHTML = "";
    const shell = document.createElement("div");
    shell.className = "skill-resource-edit-shell";

    const detailHeader = document.createElement("div");
    detailHeader.className = "skill-resource-detail-header";
    detailHeader.innerHTML = `
      <button class="qz-icon-btn qz-icon-btn--md icon-btn" type="button" title="${escapeHtmlAttribute(t("backToResources"))}" aria-label="${escapeHtmlAttribute(t("backToResources"))}" data-skill-resource-action="back">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <strong class="skill-resource-detail-name" title="${escapeHtmlAttribute(readonly ? activePath : t("doubleClickToRename"))}"${readonly ? "" : ` tabindex="0" role="button" aria-label="${escapeHtmlAttribute(t("renameResourceFile"))}"`}>${escapeHtml(activePath)}</strong>
      ${readonly ? "" : `
        <button class="qz-icon-btn qz-icon-btn--sm qz-icon-btn--danger icon-btn skill-resource-delete-btn" type="button" title="${escapeHtmlAttribute(t("deleteResource"))}" aria-label="${escapeHtmlAttribute(t("deleteResource"))}" data-skill-resource-action="delete" data-index="${activeSkillResourceIndex}">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>
        </button>
      `}
    `;
    shell.appendChild(detailHeader);
    const detailName = detailHeader.querySelector<HTMLElement>(".skill-resource-detail-name");
    if (!readonly && detailName) {
      detailName.addEventListener("dblclick", event => {
        event.preventDefault();
        beginSkillResourceRename(detailName);
      }, { signal: lifecycleSignal });
      detailName.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== "F2") return;
        event.preventDefault();
        beginSkillResourceRename(detailName);
      }, { signal: lifecycleSignal });
    }

    const item = document.createElement("div");
    item.className = "skill-resource-edit-item";
    const binary = active.encoding === "base64";

    const content = document.createElement("textarea");
    content.className = "skill-resource-edit-content";
    content.spellcheck = false;
    content.wrap = "soft";
    content.value = binary ? "" : (active.content || "");
    content.placeholder = binary
      ? t("binaryDocumentsAreReadThroughTheDocumentPipelineByLoad")
      : t("resourceContent");
    content.readOnly = readonly || binary;
    const contentHighlight = document.createElement("pre");
    contentHighlight.className = "skill-resource-edit-highlight hljs";
    contentHighlight.setAttribute("aria-hidden", "true");
    const contentEditor = document.createElement("div");
    contentEditor.className = "skill-resource-code-editor";
    contentEditor.dataset.resourcePath = active.path || "";
    contentEditor.append(contentHighlight, content);
    content.addEventListener("scroll", () => syncSkillResourceEditHighlightScroll(contentEditor), { signal: lifecycleSignal });
    content.addEventListener("input", () => updateSkillResourceEditHighlight(contentEditor, { defer: true }), { signal: lifecycleSignal });

    item.append(contentEditor);
    updateSkillResourceEditHighlight(contentEditor);
    shell.appendChild(item);
    skillResourcesList.appendChild(shell);
  }

  function beginSkillResourceRename(nameElement: HTMLElement | null) {
    if (!nameElement?.isConnected || skillDetail?.dataset.readonly === "true") return;
    const index = activeSkillResourceIndex;
    const draft = skillResourceDrafts[index];
    if (!draft || nameElement.parentElement?.querySelector<HTMLElement>(".skill-resource-inline-name")) return;

    const previousPath = cleanSkillResourcePath(draft.path || "");
    const input = document.createElement("input");
    input.className = "skill-resource-inline-name";
    input.type = "text";
    input.value = previousPath;
    input.spellcheck = false;
    input.setAttribute("aria-label", t("resourceFilePath"));
    let settled = false;

    const restoreName = (path = previousPath) => {
      if (settled) return;
      settled = true;
      nameElement.textContent = path || t("untitled", { index: String(index + 1) });
      nameElement.title = t("doubleClickToRename");
      input.replaceWith(nameElement);
    };

    const rejectRename = (message: string) => {
      input.classList.add("invalid");
      input.setAttribute("aria-invalid", "true");
      input.title = message;
      setSkillEditorStatus(message, "error", { toast: true, target: "resources" });
      input.focus({ preventScroll: true });
    };

    const commitRename = () => {
      const nextPath = cleanSkillResourcePath(input.value);
      if (!nextPath) {
        rejectRename(t("resourcePathCannotBeEmpty"));
        return;
      }
      if (!isValidSkillResourcePath(nextPath)) {
        rejectRename(t("invalidResourcePath"));
        return;
      }
      const lookup = nextPath.toLowerCase();
      const duplicate = skillResourceDrafts.some((resource, resourceIndex) => (
        resourceIndex !== index
        && cleanSkillResourcePath(resource?.path || "").toLowerCase() === lookup
      ));
      if (duplicate) {
        rejectRename(t("duplicateResourcePath", { path: String(nextPath) }));
        return;
      }

      draft.path = nextPath;
      draft.type = inferSkillResourceType(nextPath);
      const contentEditor = skillResourcesList?.querySelector<HTMLElement>(".skill-resource-code-editor");
      if (contentEditor) {
        contentEditor.dataset.resourcePath = nextPath;
        updateSkillResourceEditHighlight(contentEditor);
      }
      restoreName(nextPath);
      setSkillEditorStatus("");
      if (nextPath !== previousPath) markSkillDraftDirty();
    };

    input.addEventListener("input", () => {
      input.classList.remove("invalid");
      input.removeAttribute("aria-invalid");
      input.title = "";
      setSkillEditorStatus("");
    }, { signal: lifecycleSignal });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restoreName();
        nameElement.focus({ preventScroll: true });
        setSkillEditorStatus("");
      }
    }, { signal: lifecycleSignal });
    input.addEventListener("blur", () => restoreName(), { signal: lifecycleSignal });

    nameElement.replaceWith(input);
    input.focus({ preventScroll: true });
    const slashIndex = previousPath.lastIndexOf("/");
    const extensionIndex = previousPath.lastIndexOf(".");
    const start = slashIndex + 1;
    const end = extensionIndex > start ? extensionIndex : previousPath.length;
    input.setSelectionRange(start, end);
  }

  function skillResourceTypeIcon(type = "") {
    switch (normalizeResourceType(type)) {
      case "script":
        return `<svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35"/>
          <path d="M14 2v5a1 1 0 0 0 1 1h5M5 16l-3 3 3 3M9 22l3-3-3-3"/>
        </svg>`;
      case "json":
        return `<svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/>
          <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>
        </svg>`;
      case "markdown": return `<span class="skill-list-type-label">MD</span>`;
      default: return `<span class="skill-list-type-label">FILE</span>`;
    }
  }

  function updateSkillResourceEditHighlight(editor: HTMLElement | null, { defer = false } = {}) {
    if (!editor) return;
    const textarea = editor.querySelector<HTMLTextAreaElement>(".skill-resource-edit-content");
    const highlight = editor.querySelector<HTMLElement>(".skill-resource-edit-highlight");
    if (!textarea || !highlight) return;
    renderSyntaxHighlight(highlight, () => {
      const path = editor.dataset.resourcePath || skillResourceDrafts[activeSkillResourceIndex]?.path || "";
      const language = skillResourceHighlightLanguage(path);
      return highlightCode(textarea.value || "", language, {
        autoDetect: false,
        maxLength: LIVE_HIGHLIGHT_MAX_LENGTH,
      });
    }, { defer });
    syncSkillResourceEditHighlightScroll(editor);
  }

  function syncSkillResourceEditHighlightScroll(editor: HTMLElement | null) {
    if (!editor) return;
    const textarea = editor.querySelector<HTMLTextAreaElement>(".skill-resource-edit-content");
    const highlight = editor.querySelector<HTMLElement>(".skill-resource-edit-highlight");
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }

  function skillResourceHighlightLanguage(path = "") {
    const clean = cleanSkillResourcePath(path).toLowerCase();
    const ext = clean.includes(".") ? clean.split(".").pop() : "";
    return normalizeCodeLanguage(ext === "md" ? "markdown" : ext || inferSkillResourceType(clean));
  }

  function syncActiveSkillResourceHeading() {
    const title = skillResourcesList?.querySelector<HTMLElement>(".skill-resource-detail-name");
    const active = skillResourceDrafts[activeSkillResourceIndex];
    if (title && active) title.textContent = active.path || t("untitled", { index: String(activeSkillResourceIndex + 1) });
    syncSkillResourcesEditorMeta();
  }

  function syncActiveSkillResourceDraft() {
    if (!skillResourceDrafts.length) return;
    const item = skillResourcesList?.querySelector<HTMLElement>(".skill-resource-edit-item");
    if (!item) return;
    const draft = skillResourceDrafts[activeSkillResourceIndex];
    if (!draft) return;
    if (draft.encoding === "base64") return;
    draft.content = item.querySelector<HTMLTextAreaElement>(".skill-resource-edit-content")?.value || "";
  }

  function syncSkillResourcesEditorMeta() {
    const resourceCount = skillResourceDrafts.length || 0;
    const mcpCount = skillMcpDrafts.length || 0;
    if ($("#skill-tab-resource-count")) $("#skill-tab-resource-count").textContent = String(resourceCount);
    if ($("#skill-tab-mcp-count")) $("#skill-tab-mcp-count").textContent = String(mcpCount);
    const parts = [];
    if (resourceCount) parts.push(t("resourceCountLabel", { count: String(resourceCount) }));
    if (mcpCount) parts.push(t("mcpServers", { count: String(mcpCount) }));
    if ($("#skill-content-summary")) $("#skill-content-summary").textContent = parts.join(" · ");
  }

  function cleanSkillResourcePath(value = "") {
    return String(value || "").trim().replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/+/g, "/");
  }

  function isValidSkillResourcePath(path = "") {
    const clean = cleanSkillResourcePath(path);
    return Boolean(clean) && !clean.split("/").some(part => part === ".." || part === "");
  }

  function nextSkillResourcePath() {
    const existing = new Set(
      skillResourceDrafts
        .map(item => cleanSkillResourcePath(item?.path || "").toLowerCase())
        .filter(Boolean),
    );
    const base = "references/new-resource";
    for (let index = 1; index < 100; index += 1) {
      const path = `${base}${index === 1 ? "" : `-${index}`}.md`;
      if (!existing.has(path.toLowerCase())) return path;
    }
    return `${base}-${Date.now()}.md`;
  }

  function setSkillEditorStatus(message: string, tone = "", { toast = false, target = "markdown" } = {}) {
    if (disposed) return;
    if (!skillEditorStatus) return;
    const isError = tone === "error" && Boolean(message);
    const showInline = !toast;
    skillEditorStatus.textContent = showInline ? (message || "") : "";
    skillEditorStatus.classList.toggle("error", showInline && tone === "error");
    skillEditorStatus.classList.toggle("success", showInline && tone === "success");
    skillDetail?.classList.toggle("has-error", isError && target !== "resources" && target !== "mcp");
    skillDetail?.classList.toggle("has-resource-error", isError && target === "resources");
    skillDetail?.classList.toggle("has-mcp-error", isError && target === "mcp");
    if (!message || !toast) {
      hideToast({ key: "skill-editor-status" });
      return;
    }
    showToast(message, {
      tone: tone === "error" || tone === "success" ? tone : "info",
      durationMs: tone === "error" ? 5200 : 2600,
      key: "skill-editor-status",
    });
  }

  function updateMarkdownHighlight(value: string, { defer = false } = {}) {
    const target = $("#skill-editor-highlight");
    renderSyntaxHighlight(target, () => highlightMarkdownDocument(value, {
      maxLength: LIVE_HIGHLIGHT_MAX_LENGTH,
    }), { defer });
  }

  function parseSkillMarkdownDocument(source: string) {
    const text = String(source ?? "");
    const fallback = (hasFrontmatter: boolean, yamlErrors: string[]) => ({
        frontmatter: undefined, metadata: undefined, displayName: undefined,
        hasFrontmatter,
        yamlErrors,
        name: currentSkillName || "",
        description: $("#skill-detail-desc").textContent || "",
        scope: SKILL_SCOPE_GLOBAL,
        status: "active",
        domains: [],
        urlPatterns: [],
        excludePatterns: [],
        content: text,
    });
    if ((text.replace(/^\uFEFF/, "").split("\n")[0] || "").trim() !== "---") return fallback(false, []);

    try {
      const parsed = parseSkillMarkdownFrontmatter(text);
      const frontmatter = parsed?.frontmatter || {};
      const metadata = isPlainYamlObject(frontmatter.metadata) ? frontmatter.metadata : {};
      return {
        hasFrontmatter: true,
        yamlErrors: [],
        frontmatter,
        metadata,
        name: frontmatter.name,
        description: frontmatter.description,
        displayName: metadata.displayName ?? frontmatter.displayName,
        scope: metadata.scope ?? frontmatter.scope,
        status: metadata.status ?? frontmatter.status,
        domains: metadata.domains ?? frontmatter.domains,
        urlPatterns: metadata.urlPatterns ?? frontmatter.urlPatterns,
        excludePatterns: metadata.excludePatterns ?? frontmatter.excludePatterns,
        content: parsed?.content || "",
      };
    } catch (_err) {
      return fallback(true, [t("invalidYamlFormat")]);
    }
  }

  function validateSkillMarkdownDocument(parsed: ReturnType<typeof parseSkillMarkdownDocument>, skills: SkillRecord[] | Fields = []) {
    const errors = [...(parsed.yamlErrors || [])];
    const frontmatter = isPlainYamlObject(parsed.frontmatter) ? parsed.frontmatter : {};
    const hasFrontmatter = parsed.hasFrontmatter === true;
    const metadataProvided = hasFrontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "metadata");
    const metadata = isPlainYamlObject(parsed.metadata) ? parsed.metadata : {};

    if (hasFrontmatter && !metadataProvided) {
      errors.push(t("yamlMetadataCannotBeEmpty"));
    } else if (metadataProvided && !isPlainYamlObject(frontmatter.metadata)) {
      errors.push(t("yamlMetadataMustBeAnObject"));
    }

    const name = readSkillYamlString("name", parsed.name, errors, { required: true });
    const description = readSkillYamlString("description", parsed.description, errors, { required: true });
    const displayName = readSkillYamlString("metadata.displayName", parsed.displayName, errors, { required: false });
    const scope = readSkillYamlString("metadata.scope", parsed.scope, errors, { required: hasFrontmatter }).toLowerCase();
    const status = readSkillYamlString("metadata.status", parsed.status, errors, { required: hasFrontmatter }).toLowerCase();
    const domains = readSkillYamlStringList("metadata.domains", parsed.domains, errors, { required: hasFrontmatter });
    const urlPatterns = readSkillYamlStringList("metadata.urlPatterns", parsed.urlPatterns, errors, { required: hasFrontmatter });
    const excludePatterns = readSkillYamlStringList("metadata.excludePatterns", parsed.excludePatterns, errors, { required: hasFrontmatter });
    const license = readSkillYamlString("license", frontmatter.license, errors);
    const compatibility = readSkillYamlString("compatibility", frontmatter.compatibility, errors);
    const allowedTools = readSkillYamlString("allowed-tools", frontmatter["allowed-tools"], errors);

    if (!name) errors.push(t("yamlNameCannotBeEmpty"));
    if (name && !isValidAgentSkillName(name)) {
      errors.push(t("yamlNameMustContainOnlyLowercaseLettersNumbersAndHyphens"));
    }
    if (name && name !== currentSkillName && isBuiltinSkillName(name)) {
      errors.push(t("yamlNameCannotUseTheBuiltInSkillName", { name: String(name) }));
    }
    const existingNames = Array.isArray(skills) ? skills.map(skill => skill.name) : modernSkillValuesFromRecord(skills).map(skill => skill.name);
    if (name && name !== currentSkillName && existingNames.some(item => normalizeSkillLookup(item) === normalizeSkillLookup(name))) {
      errors.push(t("yamlNameConflictsWithExistingSkill", { name: String(name) }));
    }
    if (![SKILL_SCOPE_GLOBAL, SKILL_SCOPE_SITE, SKILL_SCOPE_RESIDENT].includes(scope)) {
      errors.push(t("yamlScopeMustBeResidentGlobalOrSite"));
    }
    if (!["active", "disabled"].includes(status)) {
      errors.push(t("yamlStatusMustBeActiveOrDisabled"));
    }
    if (scope === SKILL_SCOPE_SITE && domains.length === 0) {
      errors.push(t("siteSkillsRequireAtLeastOneDomain"));
    }
    validateSkillDomains(domains, errors);
    validateSkillPatterns("urlPatterns", urlPatterns, errors);
    validateSkillPatterns("excludePatterns", excludePatterns, errors);

    if (errors.length) return { ok: false as const, error: errors[0] };
    const nextMetadata = { ...metadata };
    if (displayName) nextMetadata.displayName = displayName;
    else delete nextMetadata.displayName;
    nextMetadata.scope = scope;
    nextMetadata.status = status;
    nextMetadata.domains = domains;
    nextMetadata.urlPatterns = urlPatterns;
    nextMetadata.excludePatterns = excludePatterns;

    return {
      ok: true as const,
      value: {
        name,
        metadata: nextMetadata,
        description,
        license,
        compatibility,
        "allowed-tools": allowedTools,
        scope,
        status,
        domains,
        urlPatterns,
        excludePatterns,
        content: parsed.content || "",
      },
    };
  }

  function isPlainYamlObject(value: unknown): value is Fields {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function validateSkillDomains(domains: string[], errors: string[]) {
    domains.forEach((domain, index) => {
      const text = String(domain || "").trim();
      if (/\s/.test(text)) {
        errors.push(t("yamlDomainsEntryMustNotContainWhitespace", { index: String(index + 1) }));
        return;
      }
      const host = text.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^\*\./, "");
      if (!host || host.includes("*") || !/^[a-z0-9.-]+$/i.test(host) || !host.includes(".")) {
        errors.push(t("yamlDomainsEntryIsNotAValidDomain", { index: String(index + 1) }));
      }
    });
  }

  function validateSkillPatterns(key: string, patterns: string[], errors: string[]) {
    patterns.forEach((pattern, index) => {
      const text = String(pattern || "").trim();
      if (!text) return;
      let source = "";
      if (text.startsWith("regex:")) source = text.slice(6);
      else if (text.startsWith("/") && text.endsWith("/") && text.length > 2) source = text.slice(1, -1);
      if (!source) return;
      try {
        new RegExp(source);
      } catch (err) {
        errors.push(t("yamlEntryHasAnInvalidRegularExpression", { field: String(key), index: String(index + 1), reason: String((err instanceof Error ? err.message : err)) }));
      }
    });
  }

  $<HTMLButtonElement>("#btn-delete-skill").addEventListener("click", async () => {
    const name = currentSkillName || $("#skill-detail-name").textContent;
    const current = allSkillsCache.find(s => s.name === name);
    if (isBuiltinSkill(current)) {
      setSkillsStatus(t("builtInSkillsCannotBeDeleted"), "error");
      return;
    }
    const displayName = current ? (getSkillDisplayName(current) || current.name) : name;
    if (!await confirmAction({
      title: t("deleteSkillConfirmation", { name: String(displayName) }),
      message: t("thisSkillAndItsLocalResourcesWillBeRemovedThis"),
      confirmLabel: t("delete"),
      tone: "danger",
    })) return;

    let registryReady = false;
    try {
      const result = await request("delete_workspace_skill", { name, expected: current || null }, 60000);
      applyWorkspace(result);
      registryReady = result.registryReady === true;
    } catch (error) {
      setSkillsStatus(t("couldNotDelete", { reason: String(error instanceof Error ? error.message : error) }), "error");
      return;
    }

    currentSkillName = null;
    currentSkillDraft = null;
    setSkillEditMode(false);
    skillDetail.classList.add("hidden");
    showSkillsListShell();
    await loadSkillsList();
    options.onStableViewChange?.();
    if (!registryReady) setSkillsStatus(t("skillDeletedToolsWillRefreshAutomaticallyForTheNextTask"), "error");
  }, { signal: lifecycleSignal });

  // Search filter
  skillsSearch.addEventListener("input", () => {
    applySkillFilters();
  }, { signal: lifecycleSignal });

  function applySkillFilters() {
    const filtered = filterSkillsForList(allSkillsCache, {
      filter: skillListFilter,
      query: skillsSearch.value,
    });
    renderSkillsList(filtered);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    chrome.tabs?.onActivated?.removeListener?.(onTabActivated);
    chrome.tabs?.onUpdated?.removeListener?.(onTabUpdated);
    clearTimeout(gitPublishRefreshTimer);
    cancelAnimationFrame(skillConfigAutosizeFrame);
    for (const frame of pendingSyntaxHighlightFrames.values()) cancelAnimationFrame(frame);
    pendingSyntaxHighlightFrames.clear();
    gitPublishInspectGeneration += 1;
    deactivate();
  }
  lifecycleSignal?.addEventListener("abort", dispose, { once: true });

  return {
    panel: skillsPanel,
    dispose,
    restore: async (skill: string | null) => { pendingInitialSkill = skill; await activate(); },
    activate,
    deactivate,
    refresh: loadSkillsList,
    showDetail: showSkillDetail,
    getCurrentSkill: () => currentSkillName,
    list: async () => { await loadSkillsList(); return allSkillsCache.slice(); },
    resolveCurrentSiteUrls: resolveCurrentSkillSiteUrls,
    normalizeSiteUrl: normalizeSkillSiteUrl,
    safeUrlHost,
    closeTopmostTransientUi,
  };
}

function normalizeSessionIdValue(sessionId: unknown) {
  const id = sessionId == null ? "" : String(sessionId).trim();
  return id || null;
}

function isElementVisible(element: HTMLElement | null) {
  return Boolean(element && !element.classList.contains("hidden"));
}

function formatBytes(value = 0) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}
