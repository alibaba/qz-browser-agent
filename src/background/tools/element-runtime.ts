import type { ToolContext, ToolErrorConstructor } from '../../sdk/background.js';
import type { GetToolRuntimeDependencies } from '../../sdk/background/services.js';
import type { createCdpRuntime } from './cdp-runtime.js';
export interface ElementReference {
  uid?: string; selector?: string; tabId?: number; sessionId?: string; pageUrl?: string;
  index?: number; imageSrc?: string; imageIndex?: number; backendNodeId?: number; role?: string; name?: string; createdAt?: number;
  loaderId?: string;
  [field: string]: unknown;
}
interface ElementRuntimeHost {
  ToolExecutionError: ToolErrorConstructor;
  getToolRuntimeDependencies: GetToolRuntimeDependencies;
  makeSessionTabTargetError(code: string, details: Record<string, unknown>): Error;
  assertTabAllowed(tabId: number, details: Record<string, unknown>): Promise<unknown>;
  withDebugger: ReturnType<typeof createCdpRuntime>['withDebugger'];
  sendToContent(tabId: number | undefined, action: string, params?: Record<string, unknown>): Promise<unknown>;
}
import { isCdpFallbackForbiddenError } from "./cdp-runtime.js";
import { isElementReply } from "../../shared/contracts/page-content.js";
import { getEffectiveTabUrl } from "../../shared/tab-utils.js";
import { getLanguage } from "../../shared/i18n/index.js";
import { t } from "./messages.js";

const OBJECT_GROUP = "qz-uid";
const isolatedByTab = new Map<number, Map<string, number>>();
function noteExecutionContext(source: { tabId?: number } | undefined, method: string, params: unknown) {
  const tabId = Number(source?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  if (method === "Runtime.executionContextsCleared") { isolatedByTab.delete(tabId); return; }
  if (method === "Runtime.executionContextDestroyed") {
    const id = Number(record(params).executionContextId);
    const frames = isolatedByTab.get(tabId);
    if (frames) for (const [frameId, known] of frames) if (known === id) frames.delete(frameId);
    return;
  }
  if (method !== "Runtime.executionContextCreated") return;
  const context = record(record(params).context);
  const aux = record(context.auxData);
  if (context.origin !== `chrome-extension://${chrome.runtime?.id || ""}` || aux.type !== "isolated") return;
  const frames = isolatedByTab.get(tabId) || new Map<string, number>();
  frames.set(String(aux.frameId || ""), Number(context.id));
  isolatedByTab.set(tabId, frames);
}
globalThis.chrome?.debugger?.onEvent?.addListener((source, method, params) => noteExecutionContext(source, method, params));
globalThis.chrome?.debugger?.onDetach?.addListener(source => {
  const tabId = Number(source?.tabId);
  if (Number.isInteger(tabId)) isolatedByTab.delete(tabId);
});
type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type ElementCaller = (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Owns stable element references and page/tab/session validation. */
export function createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies,
  makeSessionTabTargetError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  withDebugger,
  sendToContent,
}: ElementRuntimeHost) {
// ---------------------------------------------------------------------------
// Page snapshot element refs
// ---------------------------------------------------------------------------

const elementRefRegistry = new Map<string, ElementReference>();
const ELEMENT_REF_TTL_MS = 30 * 60 * 1000;
const ELEMENT_REF_MAX = 5000;
const ELEMENT_TARGET_GRAMMAR = 'target = "uid:" <element_uid> | "css:" <css_selector>';
function getElementTargetExamples() {
return [
  "uid:t5493.00001.12",
  "uid:t5493.00001.i3",
  `css:button[aria-label="${t("nextPageSelector")}"]`,
  'css:a[href*="page=2"]',
  'css:input[name="q"]',
  `css:textarea[placeholder*="${t("commentSelector")}"]`,
  'css:[data-testid="submit"]',
];
}
function getElementTargetDescription() {
return t("elementReference", {
  grammar: ELEMENT_TARGET_GRAMMAR,
  examples: getElementTargetExamples().join(getLanguage() === "zh-CN" ? "；" : "; "),
});

}

const snapshotSerial = new Map<number, number>();

function taskTabIds(context: ToolContext = {}) {
  const sessionId = String(context.sessionId || "").trim();
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (!sessionId || typeof sessions?.listOwnedTabIds !== "function") return [];
  const listed = sessions.listOwnedTabIds(sessionId);
  return Array.isArray(listed) ? listed.map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
}

function matchTabSuffix(suffix: string, tabIds: readonly number[]) {
  const matches = tabIds.filter(id => String(id).endsWith(suffix));
  if (matches.length === 1) return matches[0];
  const exact = matches.filter(id => String(id) === suffix);
  return exact.length === 1 ? exact[0] : null;
}

function uniqueTabSuffix(tabId: number, peerTabIds: readonly number[]) {
  const self = String(tabId);
  const ids = [...new Set([tabId, ...peerTabIds].map(Number))].filter(id => Number.isInteger(id) && id > 0);
  for (let length = Math.min(4, self.length); length <= self.length; length += 1) {
    const suffix = self.slice(-length);
    if (matchTabSuffix(suffix, ids) === tabId) return suffix;
  }
  return self;
}

function makeSnapshotId(tabId: number, context: ToolContext = {}) {
  const id = Number(tabId);
  const peers = taskTabIds(context);
  const ids = peers.includes(id) ? peers : [...peers, id];
  const suffix = uniqueTabSuffix(id, ids);
  const next = (snapshotSerial.get(id) || 0) + 1;
  snapshotSerial.set(id, next);
  return `t${suffix}.${next.toString(36).padStart(5, "0")}`;
}

function makeElementUid(snapshotId: string, seq: number, mark = "") {
  return `${snapshotId}.${mark}${seq}`;
}

function registerElementRef(ref: ElementReference) {
  if (!ref?.uid) return;
  cleanupElementRefs();
  elementRefRegistry.set(ref.uid, {
    ...ref,
    createdAt: Date.now(),
  });
}

function cleanupElementRefs() {
  const now = Date.now();
  for (const [uid, ref] of elementRefRegistry.entries()) {
    if (now - Number(ref.createdAt || 0) > ELEMENT_REF_TTL_MS) {
      elementRefRegistry.delete(uid);
    }
  }
  while (elementRefRegistry.size > ELEMENT_REF_MAX) {
    const first = elementRefRegistry.keys().next().value;
    if (!first) break;
    elementRefRegistry.delete(first);
  }
}

function elementTargetForUid(uid: unknown) {
  const value = normalizeElementUid(uid);
  return value ? `uid:${value}` : "";
}

function elementTargetForSelector(selector: unknown) {
  const value = String(selector || "").trim();
  return value ? `css:${value}` : "";
}

function elementTargetForRef(ref: ElementReference = {}) {
  return elementTargetForUid(ref.uid) || elementTargetForSelector(ref.selector);
}

function isElementTarget(value: unknown) {
  return /^(uid|css):/i.test(String(value || "").trim());
}

function isUidElementTarget(value: unknown) {
  return /^uid:/i.test(String(value || "").trim());
}

function parseElementTarget(target = "") {
  const raw = String(target || "").trim();
  if (!raw) return { uid: "", selector: "" };
  const separator = raw.indexOf(":");
  const kind = separator >= 0 ? raw.slice(0, separator).trim().toLowerCase() : "";
  const value = separator >= 0 ? raw.slice(separator + 1).trim() : "";
  if (kind === "uid" && value) return { uid: value, selector: "" };
  if (kind === "css" && value) return { uid: "", selector: value };
  throw new ToolExecutionError("INVALID_ELEMENT_TARGET", `Invalid element target: ${raw}`, {
    target: raw,
    expected: ELEMENT_TARGET_GRAMMAR,
    examples: getElementTargetExamples(),
  });
}

function addElementTargetsToFindResult(result: unknown) {
  if (!isRecord(result)) return result;
  const addTarget = (item: unknown) => {
    if (!isRecord(item)) return item;
    const target = item.target || elementTargetForUid(item.uid) || elementTargetForSelector(item.selector);
    return target ? { ...item, target } : item;
  };
  if (Array.isArray(result.results)) {
    return { ...result, results: result.results.map(addTarget) };
  }
  if (Array.isArray(result.elements)) {
    return { ...result, elements: result.elements.map(addTarget) };
  }
  return addTarget(result);
}

async function resolveSelectorTarget(tabId: number | undefined, selector = "", index = 0, context: ToolContext = {}) {
  const raw = String(selector || "").trim();
  if (!raw) return { tabId, selector: "" };
  if (!isElementTarget(raw)) return { tabId, selector: raw };
  const parsed = parseElementTarget(raw);
  if (parsed.selector) return { tabId, selector: parsed.selector };
  const ref = await resolveElementReference(tabId, { target: raw, index }, context);
  return { tabId: ref.tabId, selector: ref.selector, index: ref.index, target: ref.target, uid: ref.uid, ref: ref.ref };
}

async function resolveElementReference(tabId: number | undefined, { target = "", index = 0, allowBackendOnly = false } = {}, context: ToolContext = {}) {
  void allowBackendOnly;
  const normalized = parseElementTarget(target);
  const requestedUid = normalizeElementUid(normalized.uid);
  const requestedSelector = String(normalized.selector || "").trim();
  if (!requestedUid && !requestedSelector) {
    throw new ToolExecutionError("MISSING_ELEMENT_REFERENCE", "Element reference requires target: uid:<element_uid> or css:<css_selector>", {
      target,
      expected: ELEMENT_TARGET_GRAMMAR,
      examples: getElementTargetExamples(),
    });
  }

  if (!requestedUid) {
    return { tabId, selector: requestedSelector, index, target: elementTargetForSelector(requestedSelector) };
  }

  cleanupElementRefs();
  const ref = elementRefRegistry.get(requestedUid);
  if (!ref) {
    throw new ToolExecutionError(
      "STALE_ELEMENT_UID",
      `Element target is stale or unknown: uid:${requestedUid}. Take a fresh get_ax_tree snapshot, then retry with a new target.`,
      { target: elementTargetForUid(requestedUid) },
    );
  }
  const suffix = (/^t(\d+)\./.exec(requestedUid) || [])[1] || "";
  if (suffix) {
    const listed = taskTabIds(context);
    const candidates = listed.length ? listed : [Number(ref.tabId)];
    const matched = matchTabSuffix(suffix, candidates);
    if (matched == null) {
      throw new ToolExecutionError(
        "STALE_ELEMENT_UID",
        `Element target is stale or unknown: uid:${requestedUid}. Its tab suffix does not match a tab owned by this task. Take a fresh get_ax_tree snapshot, then retry.`,
        { target: elementTargetForUid(requestedUid) },
      );
    }
    if (Number(matched) !== Number(ref.tabId)) {
      throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", `Element target belongs to tab ${ref.tabId}, not tab ${matched}`, {
        target: elementTargetForUid(requestedUid),
        tabId: matched,
        refTabId: ref.tabId,
      });
    }
  }

  const currentSessionId = String(context.sessionId || "").trim();
  const refSessionId = String(ref.sessionId || "").trim();
  if (currentSessionId && refSessionId && currentSessionId !== refSessionId) {
    throw new ToolExecutionError(
      "ELEMENT_UID_SESSION_MISMATCH",
      `Element target belongs to another session. Take a fresh get_ax_tree snapshot in this session, then retry.`,
      { target: elementTargetForUid(requestedUid), sessionId: currentSessionId, refSessionId },
    );
  }

  const resolvedTabId = Number(tabId || ref.tabId);
  if (!Number.isFinite(resolvedTabId) || resolvedTabId <= 0) {
    throw new ToolExecutionError("MISSING_TAB_ID", `Element target has no usable tabId: uid:${requestedUid}`, {
      target: elementTargetForUid(requestedUid),
      refTabId: ref.tabId,
    });
  }
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (currentSessionId && typeof sessions?.resolveTargetTab === "function") {
    const resolved = await sessions.resolveTargetTab({
      sessionId: currentSessionId,
      tabId: resolvedTabId,
      source: "element_uid_reference",
    });
    if (!resolved?.ok) {
      throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
        toolName: "element_uid_reference",
        sessionId: currentSessionId,
        tabId: resolvedTabId,
        ownerSessionId: resolved?.ownerSessionId || "",
        reason: resolved?.reason || "",
        message: resolved?.error || "",
      });
    }
  }
  if (ref.pageUrl) {
    let currentUrl = "";
    try {
      const tab = await chrome.tabs.get(resolvedTabId);
      currentUrl = getEffectiveTabUrl(tab);
    } catch(_e) {
      currentUrl = "";
    }
    if (currentUrl && !samePageUrl(currentUrl, ref.pageUrl)) {
      throw new ToolExecutionError(
        "STALE_ELEMENT_UID_PAGE_CHANGED",
        `Element target belongs to a previous page state. Take a fresh get_ax_tree snapshot, then retry.`,
        { target: elementTargetForUid(requestedUid), tabId: resolvedTabId, currentUrl, snapshotUrl: ref.pageUrl },
      );
    }
  }
  if (tabId && Number(tabId) !== Number(ref.tabId)) {
    throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", `Element target belongs to tab ${ref.tabId}, not tab ${tabId}`, {
      target: elementTargetForUid(requestedUid),
      tabId,
      refTabId: ref.tabId,
    });
  }
  await assertTabAllowedBySecurityGuardrails(resolvedTabId, { tool: "element_target", source: "uid_target" });
  return {
    tabId: resolvedTabId,
    selector: "",
    index: requestedSelector ? index : Number(ref.index || 0),
    uid: requestedUid,
    target: elementTargetForUid(requestedUid),
    ref,
  };
}

function normalizeElementUid(uid: unknown) {
  const value = String(uid || "").trim();
  if (!value) return "";
  if (elementRefRegistry.has(value)) return value;
  const match = value.match(/\bt\d+\.[0-9a-z]{5,}\.[0-9a-z]*\d+\b/i);
  return match ? match[0] : value;
}

async function backendNodeIdForSelector(tabId: number, selector: string, context: ToolContext = {}) {
  const bound = await bindBackendNodes(tabId, [selector], context);
  return bound.ids[0] || 0;
}

async function bindBackendNodes(tabId: number, selectors: string[], context: ToolContext = {}) {
  try {
    return await withDebugger(tabId, async (_target, send) => describeSelectors(send, selectors), context);
  } catch (err) {
    if (isCdpFallbackForbiddenError(err)) throw err;
    return { loaderId: "", ids: selectors.map(() => 0) };
  }
}

async function describeSelectors(send: CdpSend, selectors: string[]) {
  const frame = record(record(record(await send("Page.getFrameTree")).frameTree).frame);
  const root = record(await send("DOM.getDocument", { depth: 0, pierce: true }));
  const documentNodeId = Number(record(root.root).nodeId || 0);
  const ids: number[] = [];
  for (const selector of selectors) {
    if (!documentNodeId || !selector) { ids.push(0); continue; }
    const all = record(await send("DOM.querySelectorAll", { nodeId: documentNodeId, selector }));
    const nodeIds = Array.isArray(all.nodeIds) ? all.nodeIds.map(id => Number(id)).filter(id => id > 0) : [];
    const nodeId = nodeIds.length === 1 ? nodeIds[0] : 0;
    if (!nodeId) { ids.push(0); continue; }
    const described = record(await send("DOM.describeNode", { nodeId }));
    ids.push(Number(record(described.node).backendNodeId || record(described.node).backendDOMNodeId || 0));
  }
  return { loaderId: String(frame.loaderId || ""), ids };
}

async function callElement(tabId: number | undefined, binding: { tabId?: number; selector?: string; index?: number; uid?: string; target?: string; ref?: ElementReference }, action: string, params: Record<string, unknown> = {}, context: ToolContext = {}) {
  if (!binding.uid) {
    const index = Number.isInteger(binding.index) && Number(binding.index) >= 0 ? Number(binding.index) : 0;
    return asElementReply(await sendToContent(binding.tabId || tabId, action, { ...params, selector: binding.selector || "", index }), action);
  }
  return withElement(tabId, binding, context, (_send, call) => call(action, params));
}

async function withElement<T>(tabId: number | undefined, binding: { tabId?: number; uid?: string; target?: string; ref?: ElementReference }, context: ToolContext, run: (send: CdpSend, call: ElementCaller) => Promise<T>) {
  const id = Number(binding.tabId || tabId);
  if (!Number.isInteger(id) || id <= 0) throw new ToolExecutionError("MISSING_TAB_ID", "Element target has no usable tabId", { target: binding.target || "" });
  const objectGroup = `${OBJECT_GROUP}-${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return withDebugger(id, async (_target, send) => {
    const loaderId = String(record(record(record(await send("Page.getFrameTree")).frameTree).frame).loaderId || "");
    if (binding.ref?.loaderId && loaderId && binding.ref.loaderId !== loaderId) throw staleElement(binding.uid || binding.target || "");
    const objectId = await objectFromBackend(id, send, binding, objectGroup);
    try {
      return await run(send, (action, params = {}) => invokeBound(send, objectId, action, params, objectGroup));
    } finally {
      try { await send("Runtime.releaseObjectGroup", { objectGroup }); } catch { /* The node may already be gone. */ }
    }
  }, context);
}

async function objectFromBackend(tabId: number, send: CdpSend, binding: { target?: string; ref?: ElementReference }, objectGroup: string) {
  const backendNodeId = Number(binding.ref?.backendNodeId || 0);
  if (!backendNodeId) throw staleElement(binding.target || "");
  const contextId = await contentContextId(tabId, send);
  try {
    const resolved = record(await send("DOM.resolveNode", { backendNodeId, executionContextId: contextId, objectGroup }));
    const objectId = String(record(resolved.object).objectId || "");
    if (!objectId) throw staleElement(binding.target || "");
    return objectId;
  } catch (err) {
    if (isCdpFallbackForbiddenError(err) || err instanceof ToolExecutionError) throw err;
    throw staleElement(binding.target || "");
  }
}

async function contentContextId(tabId: number, send: CdpSend) {
  const main = String(record(record(record(await send("Page.getFrameTree")).frameTree).frame).id || "");
  const known = () => {
    const frames = isolatedByTab.get(tabId);
    if (!frames?.size) return 0;
    if (main && frames.has(main)) return Number(frames.get(main));
    return frames.size === 1 ? Number([...frames.values()][0]) : 0;
  };
  if (!known()) {
    try { await send("Runtime.disable"); } catch (err) { if (isCdpFallbackForbiddenError(err)) throw err; }
    await send("Runtime.enable");
  }
  const id = known();
  if (!id) throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "The page script is not ready to read or interact with this page.", { tabId });
  return id;
}

async function invokeBound(send: CdpSend, objectId: string, action: string, params: Record<string, unknown>, objectGroup: string) {
  const remote = record(await send("Runtime.callFunctionOn", {
    objectId, objectGroup, awaitPromise: true, returnByValue: true,
    functionDeclaration: "function(payload){return globalThis.__qzInvoke(this,payload)}",
    arguments: [{ value: { ...params, action } }],
  }));
  const details = record(remote.exceptionDetails);
  if (details.text || details.exception) {
    throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", String(details.text || "Content script call failed"), { action });
  }
  return asElementReply(record(remote.result).value, action);
}

function asElementReply(value: unknown, action: string) {
  const reply = record(value);
  const code = String(reply.code || "");
  if (code === "STALE_ELEMENT_UID" || code === "STALE_ELEMENT_UID_PAGE_CHANGED") {
    throw new ToolExecutionError(code, String(reply.error || code), { action });
  }
  if (!isElementReply(reply)) throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED", `Content script returned an invalid response for ${action}`, { action });
  return reply;
}

function staleElement(target: unknown) {
  return new ToolExecutionError("STALE_ELEMENT_UID", "Element target is stale or unknown. Take a fresh get_ax_tree snapshot, then retry.", { target });
}

function samePageUrl(a: unknown, b: unknown) {
  const left = String(a || "").split("#")[0];
  const right = String(b || "").split("#")[0];
  return !!left && !!right && left === right;
}


  return Object.freeze({
    elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
    getElementTargetDescription,
    makeSnapshotId,
    makeElementUid,
    registerElementRef,
    elementTargetForUid,
    elementTargetForSelector,
    elementTargetForRef,
    isUidElementTarget,
    resolveSelectorTarget,
    resolveElementReference,
    addElementTargetsToFindResult,
    backendNodeIdForSelector,
    bindBackendNodes,
    callElement,
    withElement,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
