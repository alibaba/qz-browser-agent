import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import { createPageModeRuntime, pageModeStates } from "./page-mode.js";
import { navigateTab } from "./navigation.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { TabReference, PageObservation, TabListing, TabOwnership } from '#sdk/shared/browser';
import type { ToolContext } from '#sdk/background';
type TabsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies" | "makeSessionTabTargetError"
  | "assertTabAllowed" | "assertUrlAllowed" | "assertPageUrlAccessible" | "enablePreNavigationNetworkWatch"
  | "withDebugger" | "getDebuggerConnectionId" | "setDebuggerRetention" | "releaseDebugger"> & { defaultNetworkLimit?: number };
import { formatTab, isPageTab, pageReferenceForResult, bindCreatedTabResult } from "#sdk/shared/browser";
import { getSecurityGuardrails } from "#sdk/shared/security";

/** Registers tab discovery, ownership, creation, and navigation tools. */
export function registerTabsNavigationTools({
  registerTool,
  ToolExecutionError,
  getToolRuntimeDependencies,
  makeSessionTabTargetError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  assertUrlAllowed: assertUrlAllowedBySecurityGuardrails,
  assertPageUrlAccessible,
  enablePreNavigationNetworkWatch,
  withDebugger, getDebuggerConnectionId, setDebuggerRetention, releaseDebugger,
  defaultNetworkLimit: DEFAULT_NETWORK_LIMIT = 200,
}: TabsHost) {
const modes = createPageModeRuntime({ withDebugger, getDebuggerConnectionId, setDebuggerRetention, releaseDebugger, ToolExecutionError }, pageModeStates);
// ===========================================================================
// Tab operations
// ===========================================================================

registerTool({
  name: "list_tabs",
  get description() { return toolT("listTabsDescription"); },
  get parameters() { return {
    type: "object",
    properties: { scope: { type: "string", enum: ["owned", "all"], description: toolT("listTabsScope") } },
  } as const; },
  execute: async ({ scope }, _signal, context = {}) => {
    const tabs = (await chrome.tabs.query({})).filter(isPageTab).map(tab => formatTab(tab));
    const sessionId = String(context.sessionId || "").trim();
    const aliases = getToolRuntimeDependencies(context).sessions?.getTabAliases?.(sessionId) || {};
    const listed: TabListing[] = [];
    let foreign = 0;
    for (const tab of tabs) {
      const ownership = await listedTabOwnership(sessionId, Number(tab.id), context);
      if (!ownership) continue;
      if (ownership === "foreign") foreign += 1;
      if (scope === "all" || ownership === "owned" || (scope !== "owned" && ownership === "unclaimed")) {
        listed.push({ ...describeToolTab(tab, Object.keys(aliases).find(alias => aliases[alias] === Number(tab.id))), ownership });
      }
    }
    return { tabs: listed, count: listed.length, foreign };
  },
});

/** Classifies through the claim gate without claiming, so each row predicts its tab's first mutating use. */
async function listedTabOwnership(sessionId: string, tabId: number, context: ToolContext): Promise<TabOwnership | null> {
  if (!sessionId) return null;
  const resolved = await getToolRuntimeDependencies(context).sessions?.resolveTargetTab?.({
    sessionId, tabId, source: "tool:list_tabs", checkOnly: true, tabOnly: true,
  });
  if (resolved?.ok && resolved.ownedByCurrentTask !== false) return "owned";
  if (resolved?.ok && resolved.claimRequired === true) return "unclaimed";
  return resolved?.code === "SESSION_TAB_FOREIGN" ? "foreign" : null;
}

function describeToolTab(tab: TabReference, requested?: string | number): PageObservation {
  return {
    tabRef: pageReferenceForResult(requested, Number(tab.id)),
    title: String(tab.title || ""), url: String(tab.url || ""), active: Boolean(tab.active),
  };
}

registerTool({
  name: "open_tab",
  behavior: { parallelOpen: true, timeoutResult: { kind: "navigation", pending: "navigation commit" } },
  tabLifecycle: "created",
  model: { pageContext: false, omitArguments: ["active"] },
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("openTabDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      url: { type: "string", description: toolT("openTabUrl") },
      tabAlias: { type: "string", description: toolT("openTabAlias") },
      mode: { type: "string", enum: ["desktop", "mobile"], description: toolT("pageMode") },
      watchNetwork: { type: "boolean", description: toolT("openTabWatchNetwork") },
      resetNetwork: { type: "boolean", description: toolT("openTabResetNetwork") },
      networkMaxRecords: { type: "number", description: toolT("openTabNetworkMaxRecords") },
    },
    required: ["url"],
  } as const; },
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ url, tabAlias, mode = "desktop", watchNetwork = false, resetNetwork = true, networkMaxRecords = DEFAULT_NETWORK_LIMIT }, signal, context = {}) => {
    await assertPageUrlAccessible(url);
    assertUrlAllowedBySecurityGuardrails(url, await getSecurityGuardrails(), { tool: "open_tab", source: "url" });
    if (signal?.aborted) {
      throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before opening tab", { url });
    }

    const windowId = await resolveNewTabWindowId(context);
    let tab: chrome.tabs.Tab | null = null;
    let claimed = false;
    try {
      tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
      if (context.deferCreatedTabSelection) {
        if (!context.prepareCreatedTab) throw makeSessionTabTargetError("CDP_SESSION_RUNTIME_UNAVAILABLE", { toolName: "open_tab" });
        context = await context.prepareCreatedTab({ ...tab, url, pendingUrl: url });
      }
      const tabId = await claimCreatedTab(tab, url, context, signal);
      claimed = true;
      context.reportPartial?.(bindCreatedTabResult({ ...describeToolTab({ ...tab, id: tabId, url }, tabAlias) }, tabId), "navigation commit");
      // Preserve the host's private runtime bindings when allowing setup on the new blank tab.
      if (mode === "mobile") await modes.change(tabId, mode, signal,
        Object.assign(Object.create(context), { allowPreNavigationBlank: true }), false);
      if (watchNetwork) await enablePreNavigationNetworkWatch(tabId, {
        resetNetwork,
        networkMaxRecords,
        allowPreNavigationBlank: true,
      }, context);
      if (signal?.aborted) {
        throw new ToolExecutionError("OPERATION_ABORTED", watchNetwork
          ? "Operation aborted before navigating tab" : "Operation aborted while opening tab", { url, tabRef: tabAlias });
      }
      await navigateTab(tabId, url, assertTabAllowedBySecurityGuardrails, signal);
      const opened = await chrome.tabs.get(tabId).catch(() => {
        throw Object.assign(new ToolExecutionError("SESSION_TAB_UNAVAILABLE", "The opened tab is no longer available.", {
          ...(tabAlias ? { tabRef: tabAlias } : {}),
        }), { hint: "Use list_tabs to choose an available tabRef, then retry." });
      });
      return bindCreatedTabResult(describeToolTab({ ...opened, url: opened.url || url }, tabAlias), tabId);
    } catch (error) {
      const timedOut = signal?.aborted && signal.reason?.code === "TOOL_TIMEOUT";
      if (tab?.id != null && !(claimed && timedOut)) {
        try { await chrome.tabs.remove(tab.id); } catch (_error) {}
      }
      throw error;
    }
  },
});

registerTool({
  name: "set_page_mode",
  page: "owned",
  behavior: { mayUnloadPage: true },
  model: { pageContext: "explicit" },
  effects: (_args, result: { changed: boolean }) => result.changed ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("setPageModeDescription"); },
  get parameters() { return { type: "object", properties: {
    mode: { type: "string", enum: ["desktop", "mobile"], description: toolT("pageMode") },
    tabRef: { type: ["integer", "string"], description: toolT("navigateTabId") },
  }, required: ["mode", "tabRef"] } as const; },
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ mode, tabId }, signal, context = {}) => {
    if (!tabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "set_page_mode" });
    return modes.change(tabId, mode, signal, context);
  },
});

async function resolveNewTabWindowId(context: ToolContext = {}) {
  const resolver = getToolRuntimeDependencies(context).windowTarget?.resolveForNewTab;
  if (typeof resolver !== "function") {
    throw new ToolExecutionError("BROWSER_WINDOW_TARGET_UNAVAILABLE", "Browser window target resolver is unavailable");
  }
  return await resolver({
    anchorTabId: context.workingTabId,
    sourceWindowId: context.sourceWindowId,
  });
}

registerTool({
  name: "close_tab",
  behavior: { mayUnloadPage: true },
  tabLifecycle: "clear",
  model: { pageContext: "explicit" },
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("closeTabDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"], description: toolT("closeTabTabId") },
    },
    required: ["tabRef"],
  } as const; },
  page: "tab",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ tabId }, _signal, context = {}) => {
    try { await chrome.tabs.remove(tabId); }
    catch { throw Object.assign(new ToolExecutionError("SESSION_TAB_UNAVAILABLE", "The requested tab is no longer available.", {
      ...(context.requestedTabRef == null ? {} : { tabRef: context.requestedTabRef }),
    }), { hint: "Use list_tabs to choose an available tabRef, then retry." }); }
    return { closed: true };
  },
});

registerTool({
  name: "navigate",
  behavior: { parallelTab: true, mayUnloadPage: true, timeoutResult: { kind: "navigation", pending: "navigation commit" } },
  model: { pageUrlArgument: "url" },
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("navigateDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      url: { type: "string", description: toolT("navigateUrl") },
      tabRef: { type: ["integer", "string"], description: toolT("navigateTabId") },
      watchNetwork: { type: "boolean", description: toolT("navigateWatchNetwork") },
      resetNetwork: { type: "boolean", description: toolT("openTabResetNetwork") },
      networkMaxRecords: { type: "number", description: toolT("openTabNetworkMaxRecords") },
    },
    required: ["url", "tabRef"],
  } as const; },
  page: "tab",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ url, tabId, watchNetwork = false, resetNetwork = true, networkMaxRecords = DEFAULT_NETWORK_LIMIT }, signal, context = {}) => {
    await assertPageUrlAccessible(url);
    assertUrlAllowedBySecurityGuardrails(url, await getSecurityGuardrails(), { tool: "navigate", source: "url" });
    if (!tabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "navigate" });
    context.reportPartial?.({ requestedUrl: url, ...modes.describePage(tabId) }, "navigation commit");
    await modes.preparePage(tabId, "navigate", signal, context);
    const networkWatch = watchNetwork
      ? await enablePreNavigationNetworkWatch(tabId, { resetNetwork, networkMaxRecords }, context)
      : null;
    if (signal?.aborted) {
      throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before navigation", { url,
        ...(context.requestedTabRef == null ? {} : { tabRef: context.requestedTabRef }),
      });
    }
    await navigateTab(tabId, url, assertTabAllowedBySecurityGuardrails, signal);
    return {
      url,
      ...modes.describePage(tabId),
      ...(networkWatch ? { networkWatch } : {}),
    };
  },
});

async function claimCreatedTab(tab: chrome.tabs.Tab, intendedUrl: string, context: ToolContext = {}, signal?: AbortSignal) {
  const tabId = tab.id;
  if (typeof tabId !== "number") throw makeSessionTabTargetError("SESSION_TAB_UNAVAILABLE", { toolName: "open_tab" });
  const sessionId = String(context.sessionId || "").trim();
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (signal?.aborted || (sessionId && context.runId && sessions?.isRunCurrent?.(sessionId, context.runId) === false)) {
    throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before claiming created tab", { sessionId });
  }
  if (!sessionId) return tabId;
  if (context.deferCreatedTabSelection) return tabId; // Authorized by the host's private execution permit.
  if (typeof sessions?.updateWorkingTab !== "function") {
    throw new ToolExecutionError(
      "CDP_SESSION_RUNTIME_UNAVAILABLE",
      t("openingAnAgentOwnedTabRequiresTheCurrentSession"),
      { sessionId },
    );
  }
  await sessions.updateWorkingTab({
    sessionId,
    runId: context.runId,
    signal,
    tab: {
      ...tab,
      id: Number(tab?.id),
      url: String(intendedUrl || tab?.pendingUrl || tab?.url || ""),
      pendingUrl: String(intendedUrl || tab?.pendingUrl || ""),
    },
    source: "tool:open_tab:created",
    toolName: "open_tab",
    createdTab: true,
    claim: true,
  });
  return tabId;
}
return { preparePage: modes.preparePage, describePage: modes.describePage };
}


export default registerTabsNavigationTools satisfies ToolExtension;
