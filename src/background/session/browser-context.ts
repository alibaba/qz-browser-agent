import {
  annotateSecurityGuardrailTab,
  annotateSecurityGuardrailTabs,
  getSecurityGuardrails,
} from "../../shared/security-guardrails.js";
import { formatTab, isPageTab, isLocalFileUrl } from "../../shared/tab-utils.js";
import { normalizeSessionGoal, normalizeSessionTracker } from "./task-state.js";

import type { TabReference } from "../../shared/tab-utils.js";
import type { DynamicContext } from "../agent/agent.js";
interface AgentBrowserOptions {
  scripting?: Pick<typeof chrome.scripting, "executeScript">;
  tabs?: Pick<typeof chrome.tabs, "get">;
  selectionReadTimeoutMs?: number;
}
interface BrowserCollectorOptions {
  ready?(): Promise<unknown>;
  tabs?: Pick<typeof chrome.tabs, "query">;
  isAllowedFileSchemeAccess?(): Promise<boolean>;
  normalizeSessionId?(value: unknown): string;
  supervisor?: { getRuntime?(sessionId: string): { tracker?: unknown; goal?: unknown } | null };
  canUseSessionGoal?(sessionId: string): Promise<boolean>;
  getOwnedTabContexts?(sessionId: string, guardrails: Awaited<ReturnType<typeof getSecurityGuardrails>>, options: { titleLimit: number }): Promise<TabReference[]>;
  findOwnedTabOwner?(tabId: number): { sessionId: string } | null;
  ownsTab?(sessionId: string, tabId: number): boolean;
  getWorkingTabContext?(sessionId: string): Promise<TabReference | null>;
  getRuntime?(sessionId: string): { visitedTaskSites?: TabReference[] };
}

const DEFAULT_SELECTION_READ_TIMEOUT_MS = 1000;

/** Narrow Chrome I/O adapter used by Agent context collection. */
export function createAgentBrowserContext({
  scripting = globalThis.chrome?.scripting,
  tabs = globalThis.chrome?.tabs,
  selectionReadTimeoutMs = DEFAULT_SELECTION_READ_TIMEOUT_MS,
}: AgentBrowserOptions = {}) {
  async function readSelectedText(tabId: unknown) {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0 || !scripting?.executeScript) return "";
    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const frames = await Promise.race([
        Promise.resolve().then(() => scripting.executeScript({
          target: { tabId: id },
          func: () => String((globalThis as { getSelection?(): unknown }).getSelection?.() || "").trim().slice(0, 4000),
        })).catch(() => []),
        new Promise<chrome.scripting.InjectionResult<string>[]>(resolve => {
          const timeoutMs = Math.max(1, Number(selectionReadTimeoutMs) || DEFAULT_SELECTION_READ_TIMEOUT_MS);
          timeoutId = setTimeout(() => resolve([]), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timeoutId));
      return String(frames?.[0]?.result || "");
    } catch (_error) {
      return "";
    }
  }

  async function getTab(tabId: unknown) {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0 || !tabs?.get) return null;
    try {
      return await tabs.get(id);
    } catch (_error) {
      return null;
    }
  }

  return Object.freeze({ readSelectedText, getTab });
}

/** Builds the immutable browser/task context captured at the start of an Agent run. */
export function createSessionBrowserContextCollector({
  ready = async () => {},
  tabs = globalThis.chrome?.tabs,
  isAllowedFileSchemeAccess = async () => await globalThis.chrome?.extension?.isAllowedFileSchemeAccess?.() ?? false,
  normalizeSessionId = value => String(value || "").trim(),
  supervisor,
  canUseSessionGoal = async () => true,
  getOwnedTabContexts = async () => [],
  findOwnedTabOwner = () => null,
  ownsTab = () => false,
  getWorkingTabContext = async () => null,
  getRuntime = () => ({}),
}: BrowserCollectorOptions = {}) {
  async function collect(sessionId = "", { sourceWindowId = null }: { sourceWindowId?: number | string | null } = {}) {
    await ready();
    const id = normalizeSessionId(sessionId);
    const context: DynamicContext = { fileAccessAllowed: false };
    try { context.fileAccessAllowed = await isAllowedFileSchemeAccess(); } catch { /* Treat an unavailable grant as disabled. */ }
    const sourceId = sourceWindowId === null || sourceWindowId === undefined || sourceWindowId === ""
      ? NaN
      : Number(sourceWindowId);
    if (Number.isInteger(sourceId) && sourceId >= 0) context.sourceWindowId = sourceId;
    const tracker = normalizeSessionTracker(supervisor?.getRuntime?.(id)?.tracker);
    if (tracker) context.tracker = { ...tracker };
    if (await canUseSessionGoal(id)) {
      const goal = normalizeSessionGoal(supervisor?.getRuntime?.(id)?.goal);
      if (goal && goal.status !== "complete") context.goal = { ...goal };
    }

    try {
      const guardrails = await getSecurityGuardrails();
      const ownedTabs = await getOwnedTabContexts(id, guardrails, { titleLimit: 80 });
      if (ownedTabs.length) context.tabs = ownedTabs;

      try {
        const [visibleTab] = Number.isInteger(sourceId) && sourceId >= 0
          ? await tabs?.query?.({ active: true, windowId: sourceId }) || []
          : [];
        if (visibleTab && isPageTab(visibleTab)) {
          const formattedVisible = annotateSecurityGuardrailTab(formatTab(visibleTab, { titleLimit: 120 }), guardrails);
          const visibleTabId = Number(formattedVisible.id);
          const owner = findOwnedTabOwner(visibleTabId);
          context.userVisibleTab = {
            ...formattedVisible,
            ownedByCurrentTask: ownsTab(id, visibleTabId),
            ownerSessionId: owner?.sessionId || "",
            readOnlyUsable: !formattedVisible.securityGuardrailBlocked
              && (!isLocalFileUrl(formattedVisible.url) || context.fileAccessAllowed === true),
          };
        }
      } catch (_error) {
        // The user-visible tab is optional read-only context.
      }

      let workingTab = await getWorkingTabContext(id);
      if (workingTab) workingTab = annotateSecurityGuardrailTab(workingTab, guardrails);
      if (workingTab) {
        context.workingTab = workingTab;
        context.pageTitle = workingTab.title;
        context.pageUrl = workingTab.url;
      }
      const runtime = getRuntime(id);
      const taskSites = annotateSecurityGuardrailTabs(runtime.visitedTaskSites || [], guardrails)
        .filter(site => site?.url && !site.securityGuardrailBlocked);
      if (taskSites.length) context.taskSiteTabs = taskSites;
    } catch (_error) {
      // Browser context is best-effort and must not prevent a text-only run.
    }
    return context;
  }

  return Object.freeze({ collect });
}
