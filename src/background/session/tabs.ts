import { t } from "../../shared/i18n/backend.js";
import { productText } from "../../shared/product-text.js";
import type { StorageAdapter } from "../internal/storage.js";
import type { TabReference } from "../../shared/tab-utils.js";
import type { PortableSessionTab } from "../../shared/session/session-exchange.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import type { SecurityGuardrails } from "../../shared/security-guardrails.js";
import type { NewTabTarget } from "../services/chrome-window-target.js";
type Fields = Record<string, unknown>;
type WorkingTab = NonNullable<ReturnType<typeof normalizeWorkingTab>>;
interface GroupWindow { groupId: number; tabIds: number[] }
type GroupStore = Record<string, { windows: Record<string, GroupWindow> }>;
interface SessionTabsOptions {
  supervisor: { getRuntime(id: string): Fields | null; setRuntime(id: string, runtime: Fields): unknown; runtimeEntries(): [string, Fields][]; isRunCurrent(sessionId: string, runId: string): boolean };
  tabsApi: Pick<typeof chrome.tabs, "get" | "create" | "remove" | "query" | "update" | "ungroup">;
  tabGroupsApi?: Pick<typeof chrome.tabGroups, "get">;
  windowsApi?: Pick<typeof chrome.windows, "update">;
  windowTarget?: { resolveForNewTab(target: NewTabTarget): Promise<number> };
  storage: StorageAdapter;
  ready?: () => Promise<unknown>;
  getSessions(): Promise<Record<string, SessionMetadata>>;
  isAutomationSessionFamily(id: string, sessions: Record<string, SessionMetadata>): boolean;
  setRuntime(id: string, patch: Fields): Fields | null;
  persistRuntime(id?: string): Promise<unknown>;
  broadcast?(event: Fields): unknown;
  now?(): string | number;
  ensureTabGroupForWindow(ids: number[], options: { preferredGroupId: number | null; color: NonNullable<chrome.tabGroups.UpdateProperties["color"]>; collapsed: boolean }): Promise<{ groupId: number } | null>;
  annotateGuardrailTab?(tab: ReturnType<typeof formatTab>, guardrails: SecurityGuardrails): TabReference;
  loadSecurityGuardrails?: typeof getSecurityGuardrails;
  normalizeSessionId?(value: unknown): string;
  rootSessionId?: string;
  logger?: Pick<Console, "warn" | "debug">;
}
interface TabClaim { source?: string; toolName?: string; action?: string; explicitClaim?: boolean; createdTab?: boolean; clonedTab?: boolean }
interface RunAuthority { runId?: string | null; signal?: AbortSignal }
interface WorkingTabUpdate extends TabClaim, RunAuthority { sessionId?: unknown; tab?: unknown; owned?: boolean; claim?: boolean; createdTabReservation?: object }
interface TargetTabOptions extends RunAuthority { sessionId?: unknown; tabId?: unknown; source?: string; checkOnly?: boolean; readOnly?: boolean; tabOnly?: boolean; allowPreNavigationBlank?: boolean; createdTabReservation?: object }
type RestoreFailure = { ok: false; index: number; code: string; reason: string; error?: string };
type RestoreSuccess = { ok: true; index: number; portable: PortableSessionTab; tab: WorkingTab };
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown, fallback: string): string => String(object(error).code || fallback);
import { formatTab, getEffectiveTabUrl, isPageTab, isPageTabUrl, isLocalFileUrl } from "../../shared/tab-utils.js";
import {
  getSecurityGuardrails,
  matchBlockedUrl,
} from "../../shared/security-guardrails.js";
import { assertPageUrlAccessible } from "../tools/page-access.js";
import { normalizePortableSessionOwnedTabs } from "../../shared/session/session-exchange.js";

export const OWNED_TAB_SCHEMA_VERSION = 1;

const VISITED_TASK_SITE_LIMIT = 32;
const AGENT_TAB_GROUPS_KEY = "_agent_tab_groups";
const SESSION_TAB_GROUPS_KEY = "_session_tab_groups";
const GLOBAL_SESSION_TAB_GROUP_ID = "__agent_owned_tabs__";
const CREATED_TAB_TOOLS = new Set(["open_tab"]);
const MUTATING_TAB_TOOLS = new Set(["navigate", "act_on_screen"]);
const MUTATING_ELEMENT_ACTIONS = new Set(["click", "fill", "press", "select", "check", "uncheck"]);

export function createSessionTabs({
  supervisor,
  tabsApi,
  tabGroupsApi,
  windowsApi,
  windowTarget,
  storage,
  ready = async () => {},
  getSessions,
  isAutomationSessionFamily,
  setRuntime,
  persistRuntime,
  broadcast = () => {},
  now,
  ensureTabGroupForWindow,
  annotateGuardrailTab = value => value,
  loadSecurityGuardrails = getSecurityGuardrails,
  normalizeSessionId = defaultNormalizeSessionId,
  rootSessionId = "0",
  logger = console,
}: SessionTabsOptions) {
  if (!supervisor || typeof supervisor.getRuntime !== "function" || typeof supervisor.runtimeEntries !== "function") {
    throw new TypeError("session tabs require a supervisor");
  }
  if (!tabsApi || typeof tabsApi.get !== "function") throw new TypeError("session tabs require tabsApi");
  if (!storage || typeof storage.get !== "function") throw new TypeError("session tabs require storage");
  if (typeof setRuntime !== "function" || typeof persistRuntime !== "function") {
    throw new TypeError("session tabs require runtime persistence commands");
  }

  const pendingTabs = new Map<number, { token: object; sessionId: string; runId?: string | null; tab: WorkingTab }>();
  const groupSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const timestamp = () => String(now?.() || "");

  function findOwner(tabId: unknown, { excludeSessionId = "" } = {}) {
    const target = Number(tabId);
    const excluded = normalizeSessionId(excludeSessionId);
    if (!Number.isFinite(target) || target <= 0) return null;
    for (const [sessionId, runtime] of supervisor.runtimeEntries()) {
      const id = normalizeSessionId(sessionId);
      if (excluded && id === excluded) continue;
      if (getOwnedTabIds(runtime).includes(target)) return { sessionId: id, runtime };
    }
    return null;
  }

  function owns(sessionId: unknown, tabId: unknown) {
    const id = normalizeSessionId(sessionId);
    const target = Number(tabId);
    if (!id || !Number.isFinite(target) || target <= 0) return false;
    return getOwnedTabIds(supervisor.getRuntime(id)).includes(target);
  }

  async function reserveCreatedTab({ sessionId, runId, signal, tab }: Pick<WorkingTabUpdate, "sessionId" | "runId" | "signal" | "tab">) {
    const id = normalizeSessionId(sessionId);
    if (signal?.aborted || (runId && !supervisor.isRunCurrent(id, runId))) return { ok: false, code: "OPERATION_ABORTED" };
    const created = normalizeWorkingTab(tab);
    if (!id || !created) return { ok: false, code: "SESSION_TAB_UNAVAILABLE" };
    if (findOwner(created.id) || pendingTabs.has(created.id)) return { ok: false, code: "SESSION_TAB_FOREIGN" };
    const token = Object.freeze({});
    pendingTabs.set(created.id, { token, sessionId: id, runId, tab: created });
    return { ok: true, reservation: token };
  }

  async function discardCreatedTab(reservation: object) {
    const pending = [...pendingTabs.values()].find(entry => entry.token === reservation);
    if (!pending) return;
    // Keep the reservation while closing so another task cannot claim an uncommitted tab.
    try { await tabsApi.remove(pending.tab.id); } catch {
      let exists = false;
      try { await tabsApi.get(pending.tab.id); exists = true; } catch { /* Already closed. */ }
      if (exists) await tabsApi.remove(pending.tab.id); // Retry a transient failure; retain the permit if closing still fails.
    }
    if (pendingTabs.get(pending.tab.id) === pending) pendingTabs.delete(pending.tab.id);
  }

  async function commitCreatedTab({ sessionId, runId, signal, reservation }: RunAuthority & { sessionId: string; reservation: object }) {
    const pending = [...pendingTabs.values()].find(entry => entry.token === reservation);
    const id = normalizeSessionId(sessionId);
    const current = () => !signal?.aborted && (!runId || supervisor.isRunCurrent(id, runId));
    if (!pending || pending.sessionId !== id || pending.runId !== runId) return { ok: false, code: "SESSION_TAB_UNAVAILABLE" };
    if (!current()) return { ok: false, code: "OPERATION_ABORTED" };
    let tab;
    try { tab = await tabsApi.get(pending.tab.id); } catch { return { ok: false, code: "SESSION_TAB_UNAVAILABLE" }; }
    if (!current()) return { ok: false, code: "OPERATION_ABORTED" };
    if (pendingTabs.get(pending.tab.id) !== pending || findOwner(pending.tab.id)) return { ok: false, code: "SESSION_TAB_FOREIGN" };
    // A navigation timeout retains its blank tab under the originally validated destination.
    const publication = updateWorkingTab({ sessionId: id, runId, signal,
      tab: isPageTab(tab) ? tab : { ...tab, url: pending.tab.url },
      source: "tool:open_tab", toolName: "open_tab", createdTab: true, claim: true, createdTabReservation: reservation });
    // The runtime patch is synchronous. Retire its cleanup permit before yielding to stop/delete.
    if (owns(id, pending.tab.id)) pendingTabs.delete(pending.tab.id);
    await publication;
    return owns(id, pending.tab.id) ? { ok: true } : { ok: false, code: current() ? "SESSION_TAB_UNAVAILABLE" : "OPERATION_ABORTED" };
  }

  async function updateWorkingTab({
    sessionId,
    runId,
    signal,
    tab,
    source = "",
    owned = false,
    toolName = "",
    action = "",
    createdTab = false,
    claim = undefined,
    createdTabReservation,
  }: WorkingTabUpdate = {}) {
    const id = normalizeSessionId(sessionId);
    if (signal?.aborted || (runId && !supervisor.isRunCurrent(id, runId))) return supervisor.getRuntime(id);
    const workingTab = normalizeWorkingTab(tab);
    if (!workingTab) return null;
    const reservation = pendingTabs.get(workingTab.id);
    if (reservation && reservation.token !== createdTabReservation) return null;
    const explicitClaim = claim === true || owned === true;
    const ownership = shouldClaimTabForTask({
      source,
      toolName,
      action,
      explicitClaim,
      createdTab,
      clonedTab: false,
    });
    const owner = findOwner(workingTab.id);
    if (owner && owner.sessionId !== id) {
      logger.warn?.("[轻舟] refused to assign foreign tab as session working tab", {
        sessionId: id,
        ownerSessionId: owner.sessionId,
        tabId: workingTab.id,
        source,
      });
      return supervisor.getRuntime(id) || null;
    }
    const runtime = supervisor.getRuntime(id) || {};
    const patch: Fields = {
      workingTab,
      workingTabId: workingTab.id,
      workingUrl: workingTab.url,
      workingTitle: workingTab.title,
      workingTabSource: source,
      workingTabConflictSessionId: "",
      workingTabClaimedFromTabId: null,
      workingTabUpdatedAt: timestamp(),
      visitedTaskSites: addVisitedTaskSite(runtime, workingTab, timestamp()),
    };
    if (ownership.claim) patch.ownedTabIds = addOwnedTabId(runtime, workingTab.id);
    return setRuntime(id, patch);
  }

  async function resolveTargetTab({
    sessionId,
    runId,
    signal,
    tabId,
    source = "",
    checkOnly = false,
    readOnly = false,
    tabOnly = false,
    allowPreNavigationBlank = false,
    createdTabReservation,
  }: TargetTabOptions = {}) {
    const id = normalizeSessionId(sessionId);
    const isCurrent = () => !signal?.aborted && (!runId || supervisor.isRunCurrent(id, runId));
    const aborted = () => ({ ok: false, code: "OPERATION_ABORTED", reason: "stale_or_cancelled_run",
      error: t("browser.runEnded"), sessionId: id, tabId: null });
    await ready();
    if (!isCurrent()) return aborted();
    const runtime = supervisor.getRuntime(id) || {};
    const explicitTabId = Number(tabId);
    const targetTabId = Number.isFinite(explicitTabId) && explicitTabId > 0
      ? explicitTabId
      : Number(runtime.workingTabId);
    if (!id || !Number.isFinite(targetTabId) || targetTabId <= 0) {
      return {
        ok: false,
        code: "SESSION_TAB_TARGET_REQUIRED",
        reason: "missing_target_tab",
        error: t("browser.noWorkingTab"),
        sessionId: id,
        tabId: null,
      };
    }

    let tab = null;
    try {
      tab = await tabsApi.get(targetTabId);
    } catch (error) {
      if (!isCurrent()) return aborted();
      return {
        ok: false,
        code: "SESSION_TAB_UNAVAILABLE",
        reason: "tab_unavailable",
        error: errorMessage(error),
        sessionId: id,
        tabId: targetTabId,
      };
    }

    if (!isCurrent()) return aborted();
    const pending = pendingTabs.get(targetTabId);
    if (pending && (pending.token !== createdTabReservation || pending.sessionId !== id || pending.runId !== runId))
      return { ok: false, code: "SESSION_TAB_UNAVAILABLE", reason: "pending_creation", sessionId: id, tabId: targetTabId };
    const owner = findOwner(targetTabId);
    const formatted = formatTab(tab, { titleLimit: 120 });
    const tabUrl = String(tab?.url || tab?.pendingUrl || "").trim();
    const isOwnedPreNavigationBlank = allowPreNavigationBlank === true
      && tabUrl === "about:blank"
      && (owner?.sessionId === id || Boolean(pending));
    if (!isPageTab(tab) && !isOwnedPreNavigationBlank && !(tabOnly && owner?.sessionId === id)) {
      return {
        ok: false,
        code: "SESSION_TAB_NOT_WEB",
        reason: "not_web_tab",
        error: t("browser.targetNotWeb"),
        sessionId: id,
        tabId: targetTabId,
        tab: formatted,
      };
    }

    if (!tabOnly && isLocalFileUrl(formatted.url)) {
      try { await assertPageUrlAccessible(formatted.url); }
      catch (error) {
        return { ok: false, code: errorCode(error, "FILE_ACCESS_REQUIRED"), reason: "file_access_required",
          error: errorMessage(error), sessionId: id, tabId: targetTabId, tab: formatted };
      }
      if (!isCurrent()) return aborted();
    }

    if (pending) return { ok: true, sessionId: id, tabId: targetTabId, tab: formatted, ownedByCurrentTask: true };
    if (!owner) {
      if (tabOnly) return { ok: false, code: "SESSION_TAB_UNOWNED", reason: "tab_not_owned_by_current_session",
        error: t("browser.tabUnowned"), sessionId: id, tabId: targetTabId };
      if (readOnly) {
        return {
          ok: true,
          reason: "readonly_unowned_tab",
          sessionId: id,
          tabId: targetTabId,
          tab: formatted,
          ownedByCurrentTask: false,
          readOnlyAccess: true,
          claimRequired: true,
        };
      }
      if (checkOnly) {
        return {
          ok: true,
          reason: "claimable_unowned_tab",
          sessionId: id,
          tabId: targetTabId,
          tab: formatted,
          ownedByCurrentTask: false,
          claimRequired: true,
        };
      }
      const updated = await updateWorkingTab({
        sessionId: id,
        runId,
        signal,
        tab: formatted,
        source: source || "resolve_session_target",
        claim: true,
      });
      if (!isCurrent()) return aborted();
      return {
        ok: true,
        reason: "claimed_unowned_tab",
        sessionId: id,
        tabId: targetTabId,
        tab: normalizeWorkingTab(updated?.workingTab) || formatted,
        ownedByCurrentTask: true,
        claimed: true,
      };
    }
    if (owner.sessionId !== id) {
      if (readOnly) {
        return {
          ok: true,
          reason: "readonly_foreign_tab",
          sessionId: id,
          ownerSessionId: owner.sessionId,
          tabId: targetTabId,
          tab: formatted,
          ownedByCurrentTask: false,
          readOnlyAccess: true,
        };
      }
      return {
        ok: false,
        code: "SESSION_TAB_FOREIGN",
        reason: "tab_owned_by_another_session",
        error: t("browser.foreignTab"),
        sessionId: id,
        ownerSessionId: owner.sessionId,
        tabId: targetTabId,
      };
    }

    const updated = checkOnly ? null : await updateWorkingTab({
      sessionId: id,
      runId,
      signal,
      tab: formatted,
      source: source || "resolve_session_target",
    });
    if (!isCurrent()) return aborted();
    return {
      ok: true,
      reason: "owned_session_tab",
      sessionId: id,
      tabId: targetTabId,
      tab: normalizeWorkingTab(updated?.workingTab) || formatted,
      ownedByCurrentTask: true,
    };
  }

  async function clearWorkingTab({ sessionId, tabId, source = "", runId, signal }: { sessionId?: unknown; tabId?: unknown; source?: string } & RunAuthority = {}) {
    const id = normalizeSessionId(sessionId);
    if (signal?.aborted || (runId && !supervisor.isRunCurrent(id, runId))) return supervisor.getRuntime(id);
    const runtime = supervisor.getRuntime(id) || {};
    const targetTabId = Number(tabId);
    if (Number.isFinite(targetTabId) && runtime.workingTabId && Number(runtime.workingTabId) !== targetTabId) {
      return runtime;
    }
    return setRuntime(id, {
      workingTab: null,
      workingTabId: null,
      workingUrl: "",
      workingTitle: "",
      workingTabSource: source,
      workingTabConflictSessionId: "",
      workingTabClaimedFromTabId: null,
      workingTabUpdatedAt: timestamp(),
    });
  }

  async function restoreOwnedTabs({ sessionId, tabs, source = "session_import", sourceWindowId = null }: { sessionId?: unknown; tabs?: unknown; source?: string; sourceWindowId?: number | null } = {}) {
    await ready();
    const id = normalizeSessionId(sessionId);
    const portableTabs = normalizePortableSessionOwnedTabs(tabs);
    if (!id || portableTabs.length === 0) {
      return {
        restored: false,
        code: "SESSION_OWNED_TABS_RESTORE_INVALID",
        reason: !id ? "missing_session" : "invalid_owned_tabs",
        requested: portableTabs.length,
        restoredCount: 0,
        failedCount: portableTabs.length,
        workingTabRestored: false,
      };
    }
    if (typeof tabsApi.create !== "function") {
      return {
        restored: false,
        code: "SESSION_OWNED_TABS_RESTORE_UNAVAILABLE",
        reason: "tabs_create_unavailable",
        requested: portableTabs.length,
        restoredCount: 0,
        failedCount: portableTabs.length,
        workingTabRestored: false,
      };
    }

    let guardrails;
    try {
      guardrails = await loadSecurityGuardrails();
    } catch (error) {
      logger.debug?.("[轻舟] load guardrails for imported tabs failed:", errorMessage(error));
      return {
        restored: false,
        code: errorCode(error, "SESSION_OWNED_TABS_RESTORE_FAILED"),
        reason: "guardrails_unavailable",
        requested: portableTabs.length,
        restoredCount: 0,
        failedCount: portableTabs.length,
        workingTabRestored: false,
      };
    }

    let windowId: number;
    try {
      const targetWindow = await windowTarget?.resolveForNewTab?.({ sourceWindowId });
      if (targetWindow === undefined) throw new Error("No normal browser window");
      windowId = targetWindow;
      if (!Number.isInteger(windowId) || windowId < 0) throw new Error("No normal browser window");
    } catch (error) {
      return {
        restored: false,
        code: errorCode(error, "NO_NORMAL_BROWSER_WINDOW"),
        reason: "window_unavailable",
        requested: portableTabs.length,
        restoredCount: 0,
        failedCount: portableTabs.length,
        workingTabRestored: false,
      };
    }

    const results = await Promise.all(portableTabs.map((portable, index) => (
      openImportedOwnedTab({ portable, index, guardrails, windowId })
    )));
    const failures = results.filter(result => !result.ok);
    const opened = [];
    for (const result of results) {
      if (!result.ok) continue;
      const owner = findOwner(result.tab.id);
      if (owner && owner.sessionId !== id) {
        await closeImportedTab(result.tab.id);
        failures.push({
          ok: false,
          index: result.index,
          code: "SESSION_TAB_FOREIGN",
          reason: "tab_owned_by_another_session",
        });
        continue;
      }
      opened.push(result);
    }
    if (opened.length === 0) {
      return {
        restored: false,
        code: failures[0]?.code || "SESSION_OWNED_TABS_RESTORE_FAILED",
        reason: "no_tabs_restored",
        requested: portableTabs.length,
        restoredCount: 0,
        failedCount: failures.length,
        workingTabRestored: false,
        failures: failures.map(formatRestoreFailure),
      };
    }

    const previous = supervisor.getRuntime(id) || {};
    const restoredAt = timestamp();
    let visitedTaskSites = normalizeVisitedTaskSites(previous.visitedTaskSites);
    for (const result of opened) {
      visitedTaskSites = addVisitedTaskSite(
        { visitedTaskSites },
        result.tab,
        restoredAt,
      );
    }
    const working = opened.find(result => result.portable.working) || null;
    const patch = {
      ownedTabIds: normalizeSessionTabIds([
        ...getOwnedTabIds(previous),
        ...opened.map(result => result.tab.id),
      ]),
      visitedTaskSites,
      ...(working
        ? {
            workingTab: working.tab,
            workingTabId: working.tab.id,
            workingUrl: working.tab.url,
            workingTitle: working.tab.title,
            workingTabSource: source,
            workingTabConflictSessionId: "",
            workingTabClaimedFromTabId: null,
            workingTabUpdatedAt: restoredAt,
          }
        : {}),
    };

    let committed = false;
    try {
      const runtime = setRuntime(id, patch);
      committed = true;
      const ownedTabIds = getOwnedTabIds(runtime);
      if (!opened.every(result => ownedTabIds.includes(result.tab.id))) {
        throw new Error("Imported tab ownership was not committed");
      }
      if (working && Number(runtime?.workingTabId) !== working.tab.id) {
        throw new Error("Imported working tab was not committed");
      }
      await persistRuntime(id);
      scheduleGroupSync(id);
      return {
        restored: true,
        requested: portableTabs.length,
        restoredCount: opened.length,
        failedCount: failures.length,
        workingTabRestored: Boolean(working),
        tabs: opened.map(result => result.tab),
        failures: failures.map(formatRestoreFailure),
      };
    } catch (error) {
      if (committed) {
        setRuntime(id, {
          ownedTabIds: getOwnedTabIds(previous),
          visitedTaskSites: normalizeVisitedTaskSites(previous.visitedTaskSites),
          workingTab: previous.workingTab || null,
          workingTabId: previous.workingTabId || null,
          workingUrl: previous.workingUrl || "",
          workingTitle: previous.workingTitle || "",
          workingTabSource: previous.workingTabSource || "",
          workingTabConflictSessionId: previous.workingTabConflictSessionId || "",
          workingTabClaimedFromTabId: previous.workingTabClaimedFromTabId || null,
          workingTabUpdatedAt: previous.workingTabUpdatedAt || "",
        });
      }
      await Promise.all(opened.map(result => closeImportedTab(result.tab.id)));
      logger.debug?.("[轻舟] restore imported owned tabs failed:", errorMessage(error));
      return {
        restored: false,
        code: errorCode(error, "SESSION_OWNED_TABS_RESTORE_FAILED"),
        reason: "ownership_commit_failed",
        requested: portableTabs.length,
        restoredCount: 0,
        failedCount: portableTabs.length,
        workingTabRestored: false,
        error: errorMessage(error),
      };
    }
  }

  async function openImportedOwnedTab({ portable, index, guardrails, windowId }: { portable: PortableSessionTab; index: number; guardrails: SecurityGuardrails; windowId: number }): Promise<RestoreFailure | RestoreSuccess> {
    const blocked = matchBlockedUrl(portable.url, guardrails);
    if (blocked) {
      return {
        ok: false,
        index,
        code: "SECURITY_GUARDRAIL_BLOCKED",
        reason: "security_guardrail_blocked",
      };
    }

    let opened = null;
    try {
      // chrome.tabs.create resolves once Chrome has created the tab. Page loading
      // continues independently and is deliberately not part of Session import.
      opened = await tabsApi.create({ windowId, url: portable.url, active: false });
      const tab = normalizeWorkingTab({
        ...opened,
        title: opened?.title || portable.title,
        url: opened?.url || opened?.pendingUrl || portable.url,
      });
      if (!tab) throw new Error(productText("Chrome did not return a restorable web tab", "Firefox did not return a restorable web tab"));
      return { ok: true, index, portable, tab };
    } catch (error) {
      await closeImportedTab(opened?.id);
      return {
        ok: false,
        index,
        code: errorCode(error, "SESSION_TAB_RESTORE_FAILED"),
        reason: "open_failed",
        error: errorMessage(error),
      };
    }
  }

  async function closeImportedTab(tabId: unknown) {
    const id = Number(tabId);
    if (!Number.isFinite(id) || id <= 0) return;
    try { await tabsApi.remove(id); } catch (_error) {}
  }

  function formatRestoreFailure(result: RestoreFailure) {
    return {
      index: result.index,
      code: result.code,
      reason: result.reason,
    };
  }

  async function discardPendingTabs(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    for (const pending of pendingTabs.values()) if (pending.sessionId === id) await discardCreatedTab(pending.token);
  }

  async function closeOwnedTabsAfterTerminal(sessionId: unknown, source = "terminal") {
    await discardPendingTabs(sessionId);
    if (!(await shouldAutoCloseOwnedTabs(sessionId))) return { closed: [], skipped: true };
    return closeOwnedTabs(sessionId, { source });
  }

  async function shouldAutoCloseOwnedTabs(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    const sessions = await getSessions();
    const session = sessions[id];
    if (!session) return false;
    if (isAutomationSessionFamily(id, sessions)) return true;
    return String(session.parentSessionId || rootSessionId) !== String(rootSessionId);
  }

  async function closeOwnedTabs(sessionId: unknown, { source = "" } = {}) {
    await discardPendingTabs(sessionId);
    const id = normalizeSessionId(sessionId);
    const runtime = supervisor.getRuntime(id) || {};
    const ownedTabIds = getOwnedTabIds(runtime);
    if (!ownedTabIds.length) {
      scheduleGroupSync(id);
      return { closed: [], skipped: false };
    }

    const closed = [];
    for (const tabId of ownedTabIds) {
      try {
        await tabsApi.remove(tabId);
        closed.push(tabId);
      } catch (_error) {}
    }

    const workingTabWasOwned = ownedTabIds.includes(Number(runtime.workingTabId));
    setRuntime(id, {
      ...(workingTabWasOwned
        ? {
            workingTab: null,
            workingTabId: null,
            workingUrl: "",
            workingTitle: "",
            workingTabSource: source || "owned_tabs_closed",
            workingTabUpdatedAt: timestamp(),
          }
        : {}),
      ownedTabIds: [],
      ownedTabsClosedAt: timestamp(),
      ownedTabsCloseSource: source || "terminal",
    });
    broadcast({ type: "sessions_changed", action: "session_tabs", sessionId: id });
    return { closed, skipped: false };
  }

  async function getWorkingTabContext(sessionId: unknown, { readOnly = false } = {}) {
    await ready();
    const id = normalizeSessionId(sessionId);
    const persisted = supervisor.getRuntime(id) || {};
    const workingTab = normalizeWorkingTab(persisted.workingTab) || (
      persisted.workingUrl
        ? normalizeWorkingTab({
            id: persisted.workingTabId,
            title: persisted.workingTitle,
            url: persisted.workingUrl,
          })
        : null
    );
    const tabId = Number(workingTab?.id || persisted.workingTabId);

    if (Number.isFinite(tabId) && tabId > 0) {
      if (!owns(id, tabId)) {
        if (!readOnly) await clearWorkingTab({ sessionId: id, tabId, source: "working_tab_not_owned" });
        return null;
      }
      try {
        const tab = await tabsApi.get(tabId);
        if (isPageTab(tab)) {
          const formatted = formatTab(tab, { titleLimit: 120 });
          if (readOnly) return formatted;
          const runtime = await updateWorkingTab({
            sessionId: id,
            tab: formatted,
            source: "hydrate_working_tab",
          });
          return normalizeWorkingTab(runtime?.workingTab) || formatted;
        }
      } catch (_error) {
        // Closed tabs are pruned by the group sync path.
      }
    }
    return workingTab && owns(id, workingTab.id) ? workingTab : null;
  }

  async function getOwnedTabContexts(sessionId: unknown, guardrails: SecurityGuardrails | null = null, { titleLimit = 80 } = {}) {
    await ready();
    const id = normalizeSessionId(sessionId);
    const runtime = supervisor.getRuntime(id) || {};
    const out = [];
    const seen = new Set();
    for (const tabId of getOwnedTabIds(runtime)) {
      if (seen.has(tabId)) continue;
      seen.add(tabId);
      try {
        const tab = await tabsApi.get(tabId);
        if (!isPageTab(tab)) continue;
        const formatted = formatTab(tab, { titleLimit });
        out.push(guardrails ? annotateGuardrailTab(formatted, guardrails) : formatted);
      } catch (_error) {}
    }
    return out;
  }

  async function activateWorkingTab(sessionId: unknown, { focusWindow = false } = {}) {
    await ready();
    const id = normalizeSessionId(sessionId);
    const workingTab = await getWorkingTabContext(id);
    const tabId = Number(workingTab?.id);
    if (!Number.isFinite(tabId) || tabId <= 0) return { activated: false, reason: "no_working_tab" };

    try {
      const tab = await tabsApi.get(tabId);
      if (!isPageTab(tab)) return { activated: false, reason: "not_web_tab", tabId };
      const [activeInWindow] = await tabsApi.query({ active: true, windowId: tab.windowId });
      const alreadyActive = activeInWindow?.id === tabId;
      const updated = alreadyActive ? tab : await tabsApi.update(tabId, { active: true });
      let focusedWindow = false;
      if (focusWindow && Number.isFinite(Number(tab.windowId))) {
        try {
          await windowsApi?.update(tab.windowId, { focused: true });
          focusedWindow = true;
        } catch (_error) {}
      }
      return {
        activated: true,
        alreadyActive,
        tab: formatTab(updated || tab, { titleLimit: 120 }),
        focusedWindow,
      };
    } catch (error) {
      return {
        activated: false,
        reason: "working_tab_unavailable",
        tabId,
        error: errorMessage(error),
      };
    }
  }

  async function handleTabRemoved(tabId: unknown) {
    let changed = false;
    const groupSyncSessionIds = new Set<string>();
    for (const [sessionId, runtime] of supervisor.runtimeEntries()) {
      const ownedTabIds = getOwnedTabIds(runtime);
      const nextTabIds = removeOwnedTabId(runtime, tabId);
      const removedOwnedTab = !sameTabIdSet(ownedTabIds, nextTabIds);
      const removedWorkingTab = Number(runtime?.workingTabId) === Number(tabId);
      if (!removedWorkingTab && !removedOwnedTab) continue;
      supervisor.setRuntime(sessionId, {
        ...runtime,
        ...(removedWorkingTab
          ? {
              workingTab: null,
              workingTabId: null,
              workingUrl: "",
              workingTitle: "",
              workingTabSource: "tab_closed",
              workingTabUpdatedAt: timestamp(),
            }
          : {}),
        ownedTabIds: nextTabIds,
        sessionTabIds: nextTabIds,
        ownedTabSchemaVersion: OWNED_TAB_SCHEMA_VERSION,
        updatedAt: timestamp(),
      });
      if (removedOwnedTab) groupSyncSessionIds.add(sessionId);
      changed = true;
      broadcast({
        type: "sessions_changed",
        action: removedWorkingTab ? "working_tab" : "session_tabs",
        sessionId,
      });
    }
    if (changed) await persistRuntime();
    for (const sessionId of groupSyncSessionIds) scheduleGroupSync(sessionId);
    return changed;
  }

  function scheduleGroupSync(sessionId: string) {
    const id = GLOBAL_SESSION_TAB_GROUP_ID;
    if (groupSyncTimers.has(id)) clearTimeout(groupSyncTimers.get(id));
    const timer = setTimeout(() => {
      groupSyncTimers.delete(id);
      syncGroup(sessionId).catch((error) => {
        logger.debug?.("[轻舟] sync agent tab group failed:", errorMessage(error));
      });
    }, 350);
    groupSyncTimers.set(id, timer);
  }

  async function syncGroup(_sessionId = "") {
    await ready();
    const validTabs = [];
    const groupedTabIds = new Set();
    let runtimeChanged = false;
    for (const [runtimeSessionId, runtime] of supervisor.runtimeEntries()) {
      const validTabIds = [];
      const ownedTabIds = getOwnedTabIds(runtime);
      for (const tabId of ownedTabIds) {
        try {
          const tab = await tabsApi.get(tabId);
          if (!isPageTab(tab)) continue;
          const normalizedTabId = Number(tab.id);
          validTabIds.push(normalizedTabId);
          if (!groupedTabIds.has(normalizedTabId)) {
            groupedTabIds.add(normalizedTabId);
            validTabs.push(tab);
          }
        } catch (_error) {}
      }
      if (!sameTabIdSet(ownedTabIds, validTabIds)) {
        supervisor.setRuntime(runtimeSessionId, {
          ...runtime,
          ownedTabIds: validTabIds,
          sessionTabIds: validTabIds,
          ownedTabSchemaVersion: OWNED_TAB_SCHEMA_VERSION,
          updatedAt: timestamp(),
        });
        runtimeChanged = true;
      }
    }
    if (runtimeChanged) await persistRuntime();

    const store = await getGroupStore();
    const previous = store[GLOBAL_SESSION_TAB_GROUP_ID] || { windows: {} };
    const next: { windows: Record<string, GroupWindow> } = { windows: {} };
    const tabsByWindow = new Map<number, number[]>();
    for (const tab of validTabs) {
      const windowId = Number(tab.windowId);
      if (!Number.isFinite(windowId)) continue;
      if (!tabsByWindow.has(windowId)) tabsByWindow.set(windowId, []);
      tabsByWindow.get(windowId)!.push(Number(tab.id));
    }

    for (const [windowId, tabIds] of tabsByWindow.entries()) {
      const previousWindow = previous.windows?.[String(windowId)] || null;
      const sortedTabIds = normalizeSessionTabIds(tabIds).sort((a, b) => a - b);
      const group = await reconcileManagedGroupWindow(previousWindow, sortedTabIds);
      if (group) next.windows[String(windowId)] = group;
    }
    for (const [windowId, previousWindow] of Object.entries(previous.windows || {})) {
      if (!tabsByWindow.has(Number(windowId))) await cleanupManagedGroupWindow(previousWindow, []);
    }
    for (const [key, previousEntry] of Object.entries(store)) {
      if (key === GLOBAL_SESSION_TAB_GROUP_ID) continue;
      for (const previousWindow of Object.values(previousEntry?.windows || {})) {
        await cleanupManagedGroupWindow(previousWindow, []);
      }
    }
    const nextStore: GroupStore = {};
    if (Object.keys(next.windows).length > 0) nextStore[GLOBAL_SESSION_TAB_GROUP_ID] = next;
    await storage.set({ [SESSION_TAB_GROUPS_KEY]: nextStore });
    return nextStore;
  }

  async function reconcileManagedGroupWindow(previousWindow: GroupWindow | null, tabIds: unknown) {
    const desiredTabIds = normalizeSessionTabIds(tabIds).sort((a, b) => a - b);
    if (desiredTabIds.length < 1) {
      await cleanupManagedGroupWindow(previousWindow, desiredTabIds);
      return null;
    }
    const existingGroupId = await getManagedGroupId(previousWindow);
    const previousTabIds = normalizeSessionTabIds(previousWindow?.tabIds);
    const removedTabIds = previousTabIds.filter(tabId => !desiredTabIds.includes(tabId));
    if (existingGroupId != null && removedTabIds.length) {
      await cleanupManagedGroupWindow({ groupId: existingGroupId, tabIds: removedTabIds }, []);
    }
    try {
      const group = await ensureTabGroupForWindow(desiredTabIds, {
        preferredGroupId: existingGroupId,
        color: "cyan",
        collapsed: false,
      });
      return group ? { groupId: group.groupId, tabIds: desiredTabIds } : null;
    } catch (error) {
      logger.debug?.("[轻舟] reconcile session tab group failed:", errorMessage(error));
      if (existingGroupId != null) await cleanupManagedGroupWindow(previousWindow, desiredTabIds);
      return null;
    }
  }

  async function getManagedGroupId(groupWindow: GroupWindow | null) {
    const groupId = Number(groupWindow?.groupId);
    if (!Number.isFinite(groupId) || groupId < 0) return null;
    try {
      await tabGroupsApi?.get(groupId);
      return groupId;
    } catch (_error) {
      return null;
    }
  }

  async function getGroupStore(): Promise<GroupStore> {
    try {
      const { [SESSION_TAB_GROUPS_KEY]: stored = {} } = await storage.get(SESSION_TAB_GROUPS_KEY);
      return normalizeGroupStore(stored);
    } catch (_error) {
      return {};
    }
  }

  async function cleanupManagedGroupWindow(groupWindow: GroupWindow | null, fallbackTabIds: number[] = []) {
    const groupId = Number(groupWindow?.groupId);
    const hasGroupId = Number.isFinite(groupId) && groupId >= 0;
    const tabIds = normalizeSessionTabIds([
      ...(Array.isArray(groupWindow?.tabIds) ? groupWindow.tabIds : []),
      ...fallbackTabIds,
    ]);
    if (tabIds.length === 0) return;
    const valid = [];
    for (const tabId of tabIds) {
      try {
        const tab = await tabsApi.get(tabId);
        if (hasGroupId && Number(tab?.groupId) !== groupId) continue;
        valid.push(tabId);
      } catch (_error) {}
    }
    if (valid.length) {
      try {
        await tabsApi.ungroup([valid[0], ...valid.slice(1)]);
      } catch (_error) {}
    }
  }

  async function cleanupLegacyGroups() {
    const { [AGENT_TAB_GROUPS_KEY]: stored = {} } = await storage.get(AGENT_TAB_GROUPS_KEY);
    const staleTabs = [];
    for (const item of Object.values(object(stored))) {
      for (const tabId of normalizeSessionTabIds(object(item).tabIds)) staleTabs.push(tabId);
    }
    const valid = [];
    for (const tabId of staleTabs) {
      try {
        await tabsApi.get(tabId);
        valid.push(tabId);
      } catch (_error) {}
    }
    if (valid.length) {
      try {
        await tabsApi.ungroup([valid[0], ...valid.slice(1)]);
      } catch (_error) {}
    }
    await storage.remove(AGENT_TAB_GROUPS_KEY);
  }

  return Object.freeze({
    reserveCreatedTab,
    commitCreatedTab,
    discardCreatedTab,
    updateWorkingTab,
    resolveTargetTab,
    clearWorkingTab,
    restoreOwnedTabs,
    closeOwnedTabsAfterTerminal,
    closeOwnedTabs,
    getWorkingTabContext,
    getOwnedTabContexts,
    activateWorkingTab,
    handleTabRemoved,
    scheduleGroupSync,
    syncGroup,
    cleanupLegacyGroups,
    findOwner,
    owns,
  });
}

export function normalizeWorkingTab(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const tab = object(input);
  const id = Number(tab.id);
  const url = getEffectiveTabUrl({ url: String(tab.url || ""), pendingUrl: String(tab.pendingUrl || "") });
  if (!Number.isFinite(id) || id <= 0 || !isPageTabUrl(url)) return null;
  return {
    id,
    title: String(tab.title || "").slice(0, 120),
    url,
    active: !!tab.active,
    pinned: !!tab.pinned,
    windowId: Number.isFinite(Number(tab.windowId)) ? Number(tab.windowId) : null,
  };
}

export function normalizeVisitedTaskSites(sites: unknown) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(sites) ? sites : []) {
    const site = normalizeVisitedTaskSite(item);
    if (!site || seen.has(site.url)) continue;
    seen.add(site.url);
    out.push(site);
    if (out.length >= VISITED_TASK_SITE_LIMIT) break;
  }
  return out;
}

export function normalizeSessionTabIds(tabIds: unknown) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(tabIds) ? tabIds : []) {
    const tabId = Number(value);
    if (!Number.isFinite(tabId) || tabId <= 0 || seen.has(tabId)) continue;
    seen.add(tabId);
    out.push(tabId);
  }
  return out;
}

export function hasOwnedTabPatch(patch: Fields = {}) {
  return Object.prototype.hasOwnProperty.call(patch, "ownedTabIds")
    || Object.prototype.hasOwnProperty.call(patch, "sessionTabIds");
}

export function getOwnedTabIds(runtime: Fields | null = {}) {
  return normalizeSessionTabIds(
    Object.prototype.hasOwnProperty.call(runtime || {}, "ownedTabIds")
      ? runtime?.ownedTabIds
      : runtime?.sessionTabIds,
  );
}

export function sameTabIdSet(left: unknown = [], right: unknown = []) {
  const a = normalizeSessionTabIds(left).sort((x, y) => x - y);
  const b = normalizeSessionTabIds(right).sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeVisitedTaskSite(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const site = object(input);
  const url = normalizeVisitedTaskSiteUrl(site.url || site.pendingUrl);
  if (!url) return null;
  const tabId = Number(site.tabId ?? site.id);
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_error) {}
  return {
    id: Number.isFinite(tabId) && tabId > 0 ? tabId : null,
    tabId: Number.isFinite(tabId) && tabId > 0 ? tabId : null,
    title: String(site.title || "").slice(0, 120),
    url,
    host,
    visitedAt: String(site.visitedAt || site.updatedAt || ""),
  };
}

function normalizeVisitedTaskSiteUrl(value: unknown = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function addVisitedTaskSite(runtime: Fields = {}, tab: Fields = {}, visitedAt = "") {
  const site = normalizeVisitedTaskSite({ ...tab, tabId: tab.tabId ?? tab.id, visitedAt });
  if (!site) return normalizeVisitedTaskSites(runtime?.visitedTaskSites);
  return normalizeVisitedTaskSites([
    site,
    ...normalizeVisitedTaskSites(runtime?.visitedTaskSites).filter(item => item.url !== site.url),
  ]);
}

function addOwnedTabId(runtime: Fields = {}, tabId: unknown) {
  return normalizeSessionTabIds([...getOwnedTabIds(runtime), tabId]);
}

function removeOwnedTabId(runtime: Fields = {}, tabId: unknown) {
  const target = Number(tabId);
  return getOwnedTabIds(runtime).filter(id => id !== target);
}

function shouldClaimTabForTask({
  source = "",
  toolName = "",
  action = "",
  explicitClaim = false,
  createdTab = false,
  clonedTab = false,
}: TabClaim = {}) {
  if (explicitClaim) return { claim: true, reason: "explicit_claim" };
  if (createdTab) return { claim: true, reason: "created_tab" };
  if (clonedTab) return { claim: true, reason: "cloned_tab" };
  const parsed = parseToolSource(source);
  const name = String(toolName || parsed.toolName || "").trim();
  if (!name) return { claim: false, reason: "no_tool" };
  if (parsed.phase === "preflight") return { claim: false, reason: "preflight" };
  if (CREATED_TAB_TOOLS.has(name)) return { claim: true, reason: `tool:${name}:created` };
  if (MUTATING_TAB_TOOLS.has(name)) return { claim: true, reason: `tool:${name}:mutated` };
  if (name === "act_on_element" && MUTATING_ELEMENT_ACTIONS.has(String(action || "").trim().toLowerCase())) {
    return { claim: true, reason: "tool:act_on_element:mutated" };
  }
  return { claim: false, reason: `tool:${name}:observed` };
}

function parseToolSource(source = "") {
  const match = String(source || "").trim().match(/^tool:([^:]+)(?::([^:]+))?/);
  return { toolName: match ? match[1] : "", phase: match ? (match[2] || "") : "" };
}

function defaultNormalizeSessionId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function normalizeGroupStore(value: unknown): GroupStore {
  const store: GroupStore = {};
  for (const [key, entry] of Object.entries(object(value))) {
    const windows: Record<string, GroupWindow> = {};
    for (const [id, raw] of Object.entries(object(object(entry).windows))) {
      const window = object(raw);
      windows[id] = { groupId: Number(window.groupId), tabIds: normalizeSessionTabIds(window.tabIds) };
    }
    store[key] = { windows };
  }
  return store;
}
