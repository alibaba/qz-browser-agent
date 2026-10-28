import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import { createPageModeRuntime, pageModeStates } from "./page-mode.js";
import { navigateTab } from "./navigation.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { TabReference } from '#sdk/shared/browser';
import type { ToolContext } from '#sdk/background';
type TabsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies" | "makeSessionTabTargetError"
  | "assertTabAllowed" | "assertUrlAllowed" | "assertPageUrlAccessible" | "enablePreNavigationNetworkWatch"
  | "withDebugger" | "getDebuggerConnectionId" | "setDebuggerRetention" | "releaseDebugger"> & { defaultNetworkLimit?: number };
interface UsableTab extends TabReference {
  usable?: boolean; ownedByCurrentTask?: boolean; securityGuardrailBlocked?: boolean;
  unusableCode?: string; unusableReason?: string; claimRequired?: boolean;
  isWorkingTab?: boolean; readOnlyUsable?: boolean; ownerSessionId?: string;
}
import { formatTab, isPageTab } from "#sdk/shared/browser";
import {
  annotateSecurityGuardrailTab,
  annotateSecurityGuardrailTabs,
  getSecurityGuardrails,
} from "#sdk/shared/security";

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
    properties: {},
  } as const; },
  execute: async (_args, _signal, context = {}) => {
    const tabs = await chrome.tabs.query({});
    const guardrails = await getSecurityGuardrails();
    const formatted = tabs.filter(isPageTab).map((tab) => ({ ...formatTab(tab), ...modes.describePage(Number(tab.id)) }));
    const annotated = annotateSecurityGuardrailTabs(formatted, guardrails);
    return await annotateTabsWithSessionUsability(annotated, context);
  },
});

async function annotateTabsWithSessionUsability(tabs: UsableTab[] = [], context: ToolContext = {}) {
  const sessionId = typeof context?.sessionId === "string" ? context.sessionId.trim() : "";
  const workingTabId = Number(context?.workingTabId);
  const out = [];
  for (const tab of tabs) {
    const item: UsableTab = {
      ...tab,
      usable: false,
      ownedByCurrentTask: false,
    };
    if (!sessionId) {
      item.unusableCode = "SESSION_TAB_TARGET_REQUIRED";
      item.unusableReason = "missing_session";
      out.push(item);
      continue;
    }
    const tabId = Number(tab?.id);
    if (!Number.isFinite(tabId) || tabId <= 0) {
      item.unusableCode = "SESSION_TAB_UNAVAILABLE";
      item.unusableReason = "invalid_tab";
      out.push(item);
      continue;
    }
    const resolved = await getToolRuntimeDependencies(context).sessions?.resolveTargetTab?.({
      sessionId,
      tabId,
      source: "tool:list_tabs:usability",
      checkOnly: true,
    });
    if (resolved?.ok) {
      item.ownedByCurrentTask = resolved.ownedByCurrentTask !== false;
      item.claimRequired = resolved.claimRequired === true;
      item.isWorkingTab = Number.isFinite(workingTabId) && workingTabId > 0 && tabId === workingTabId;
      if (item.securityGuardrailBlocked) {
        item.usable = false;
        item.readOnlyUsable = false;
        item.unusableCode = "SECURITY_GUARDRAIL_BLOCKED";
        item.unusableReason = "security_guardrail_blocked";
      } else {
        item.usable = true;
        item.readOnlyUsable = true;
      }
    } else {
      item.unusableCode = resolved?.code || "SESSION_TAB_UNOWNED";
      item.unusableReason = resolved?.reason || "not_owned_by_current_task";
      if (resolved?.ownerSessionId) item.ownerSessionId = resolved.ownerSessionId;
      item.readOnlyUsable = !item.securityGuardrailBlocked && resolved?.code === "SESSION_TAB_FOREIGN";
    }
    out.push(item);
  }
  return out;
}

registerTool({
  name: "get_working_tab",
  get description() { return toolT("getWorkingTabDescription"); },
  get parameters() { return { type: "object", properties: {} } as const; },
  execute: async (_args, _signal, context = {}) => {
    const tabId = Number(context?.workingTabId);
    if (!Number.isFinite(tabId) || tabId <= 0) {
      return { hasWorkingTab: false };
    }
    const resolved = await getToolRuntimeDependencies(context).sessions?.resolveTargetTab?.({
      sessionId: context?.sessionId || "",
      tabId,
      source: "tool:get_working_tab",
    });
    if (!resolved?.ok) {
      throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
        toolName: "get_working_tab",
        sessionId: context?.sessionId || "",
        tabId,
        ownerSessionId: resolved?.ownerSessionId || "",
        reason: resolved?.reason || "",
        message: resolved?.error || "",
      });
    }
    const tab = resolved.tab || await chrome.tabs.get(tabId);
    if (!isPageTab(tab)) {
      throw new ToolExecutionError("NO_WORKING_WEB_TAB", t("currentSessionWorkingTabIsNotAWebPage"), {
        tab: formatTab(tab),
      });
    }
    return {
      hasWorkingTab: true,
      ...annotateSecurityGuardrailTab(formatTab(tab), await getSecurityGuardrails()),
      ...modes.describePage(tabId),
    };
  },
});

registerTool({
  name: "open_tab",
  behavior: { parallelOpen: true, timeoutResult: { kind: "navigation", pending: "navigation commit" } },
  workingTab: "created",
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
  execute: async ({ url, mode = "desktop", watchNetwork = false, resetNetwork = true, networkMaxRecords = DEFAULT_NETWORK_LIMIT }, signal, context = {}) => {
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
      context.reportPartial?.({ id: tabId, tabId, requestedUrl: url, ...modes.describePage(tabId) }, "navigation commit");
      // Preserve the host's private runtime bindings when allowing setup on the new blank tab.
      if (mode === "mobile") await modes.change(tabId, mode, signal,
        Object.assign(Object.create(context), { allowPreNavigationBlank: true }), false);
      const networkWatch = watchNetwork ? await enablePreNavigationNetworkWatch(tabId, {
        resetNetwork,
        networkMaxRecords,
        allowPreNavigationBlank: true,
      }, context) : null;
      if (signal?.aborted) {
        throw new ToolExecutionError("OPERATION_ABORTED", watchNetwork
          ? "Operation aborted before navigating tab" : "Operation aborted while opening tab", { url, tabId });
      }
      await navigateTab(tabId, url, assertTabAllowedBySecurityGuardrails, signal);
      return { id: tabId, url,
        ...modes.describePage(tabId), ...(watchNetwork ? { networkWatch } : {}) };
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
  model: { pageContext: "working" },
  effects: (_args, result: { changed: boolean }) => result.changed ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("setPageModeDescription"); },
  get parameters() { return { type: "object", properties: {
    mode: { type: "string", enum: ["desktop", "mobile"], description: toolT("pageMode") },
    tabId: { type: "number", description: toolT("navigateTabId") },
  }, required: ["mode"] } as const; },
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
  workingTab: "clear",
  model: { pageContext: "explicit" },
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("closeTabDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("closeTabTabId") },
    },
    required: ["tabId"],
  } as const; },
  page: "tab",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ tabId }) => {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },
});

registerTool({
  name: "use_tab",
  workingTab: "claim",
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("useTabDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("closeTabTabId") },
    },
    required: ["tabId"],
  } as const; },
  page: "owned",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ tabId }) => {
    const before = await chrome.tabs.get(tabId);
    await assertTabAllowedBySecurityGuardrails(tabId, { tool: "use_tab", source: "tab" });
    if (!isPageTab(before)) {
      throw new ToolExecutionError("NOT_WEB_TAB", t("tabIsNotAWebPageAndCannotBe", { tabId: String(tabId) }), {
        tab: formatTab(before),
      });
    }

    return {
      tabId,
      active: Boolean(before.active),
      visibleChanged: false,
      title: before.title || "",
      url: before.url || "",
      windowId: before.windowId,
      focusedWindow: false,
      note: toolT("workingTabSelected"),
      ...modes.describePage(tabId),
    };
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
      tabId: { type: "number", description: toolT("navigateTabId") },
      watchNetwork: { type: "boolean", description: toolT("navigateWatchNetwork") },
      resetNetwork: { type: "boolean", description: toolT("openTabResetNetwork") },
      networkMaxRecords: { type: "number", description: toolT("openTabNetworkMaxRecords") },
    },
    required: ["url"],
  } as const; },
  page: "tab",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ url, tabId, watchNetwork = false, resetNetwork = true, networkMaxRecords = DEFAULT_NETWORK_LIMIT }, signal, context = {}) => {
    await assertPageUrlAccessible(url);
    assertUrlAllowedBySecurityGuardrails(url, await getSecurityGuardrails(), { tool: "navigate", source: "url" });
    if (!tabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "navigate" });
    context.reportPartial?.({ tabId, requestedUrl: url, ...modes.describePage(tabId) }, "navigation commit");
    await modes.preparePage(tabId, "navigate", signal, context);
    const networkWatch = watchNetwork
      ? await enablePreNavigationNetworkWatch(tabId, { resetNetwork, networkMaxRecords }, context)
      : null;
    if (signal?.aborted) {
      throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before navigation", { url, tabId });
    }
    await navigateTab(tabId, url, assertTabAllowedBySecurityGuardrails, signal);
    return {
      tabId,
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
    throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before claiming created tab", { sessionId, tabId });
  }
  if (!sessionId) return tabId;
  if (context.deferCreatedTabSelection) return tabId; // Authorized by the host's private execution permit.
  if (typeof sessions?.updateWorkingTab !== "function") {
    throw new ToolExecutionError(
      "CDP_SESSION_RUNTIME_UNAVAILABLE",
      t("openingAnAgentOwnedTabRequiresTheCurrentSession"),
      { sessionId, tabId: Number(tab?.id) || null },
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
