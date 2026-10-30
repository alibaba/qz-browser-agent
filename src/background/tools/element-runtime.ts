import type { ToolContext, ToolErrorConstructor } from '../../sdk/background.js';
import type { CdpCommand } from '../../sdk/background/browser.js';
import type { GetToolRuntimeDependencies } from '../../sdk/background/services.js';
import type { createCdpRuntime } from './cdp-runtime.js';
import { openChildFrame } from './child-frames.js';
export interface ElementReference {
  uid?: string; selector?: string; tabId?: number; sessionId?: string; pageUrl?: string;
  index?: number; imageSrc?: string; imageIndex?: number;   backendNodeId?: number; role?: string; name?: string; createdAt?: number;
  loaderId?: string; documentId?: string; frameId?: string;
  [field: string]: unknown;
}
interface ElementRuntimeHost {
  ToolExecutionError: ToolErrorConstructor;
  getToolRuntimeDependencies: GetToolRuntimeDependencies;
  makeSessionTabTargetError(code: string, details: Record<string, unknown>): Error;
  assertTabAllowed(tabId: number, details: Record<string, unknown>): Promise<unknown>;
  withDebugger: ReturnType<typeof createCdpRuntime>['withDebugger'];
  sendToContent(tabId: number | undefined, action: string, params?: Record<string, unknown>): Promise<unknown>;
  initializeContentScript(tabId: number, context?: ToolContext): Promise<void>;
}
import { isCdpFallbackForbiddenError } from "./cdp-runtime.js";
import { ISOLATED_CONTENT_INVOKE, ISOLATED_CONTENT_PROBE } from "./isolated-page-calls.js";
import { forgetIsolatedContexts, isolatedByTab, type IsolatedContext } from "./isolated-contexts.js";
import { isElementReply } from "../../shared/contracts/page-content.js";
import { getEffectiveTabUrl } from "../../shared/tab-utils.js";
import { getLanguage } from "../../shared/i18n/index.js";
import { t } from "./messages.js";

const OBJECT_GROUP = "qz-uid";
// One table per tab while its debugger connection is alive. A same-process frame
// is keyed by its CDP frame id. A cross-process frame is keyed by session id plus
// frame id. Detach of a child session drops that session's keys and unique ids.
function contextKey(sessionId: string, frameId: string) {
  return sessionId ? `session:${sessionId}\n${frameId}` : frameId;
}
function contextIdentity(context: IsolatedContext) {
  return context.uniqueId ? `uid:${context.uniqueId}` : `id:${context.id}`;
}
function scopedContextKeys(map: Map<string, Map<string, IsolatedContext>>, sessionId: string) {
  const prefix = sessionId ? `session:${sessionId}\n` : "";
  return [...map.keys()].filter(key => sessionId ? key.startsWith(prefix) : !key.startsWith("session:"));
}
function noteExecutionContext(source: { tabId?: number; sessionId?: string } | undefined, method: string, params: unknown) {
  const tabId = Number(source?.tabId);
  const sessionId = String(source?.sessionId || "");
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const current = () => isolatedByTab.get(tabId);
  if (method === "Target.detachedFromTarget") {
    const map = current();
    if (!map) return;
    const detached = String(record(params).sessionId || sessionId);
    if (!detached) return;
    for (const key of scopedContextKeys(map, detached)) map.delete(key);
    if (!map.size) isolatedByTab.delete(tabId);
    return;
  }
  if (method === "Runtime.executionContextsCleared") {
    const map = current();
    if (!map) return;
    for (const key of scopedContextKeys(map, sessionId)) map.delete(key);
    if (!map.size) isolatedByTab.delete(tabId);
    return;
  }
  if (method === "Runtime.executionContextDestroyed") {
    const id = Number(record(params).executionContextId);
    const map = current();
    if (!map) return;
    for (const key of scopedContextKeys(map, sessionId)) {
      const candidates = map.get(key);
      if (!candidates) continue;
      for (const [identity, candidate] of candidates) {
        if (candidate.id === id) candidates.delete(identity);
      }
      if (!candidates.size) map.delete(key);
    }
    if (!map.size) isolatedByTab.delete(tabId);
    return;
  }
  if (method !== "Runtime.executionContextCreated") return;
  const context = record(record(params).context);
  const aux = record(context.auxData);
  if (context.origin !== `chrome-extension://${chrome.runtime?.id || ""}` || aux.type !== "isolated") return;
  const id = Number(context.id), frameId = String(aux.frameId || "");
  const uniqueId = typeof context.uniqueId === "string" ? context.uniqueId : "";
  if (!Number.isInteger(id) || id <= 0 || !frameId) return;
  const map = current() || new Map<string, Map<string, IsolatedContext>>();
  const key = contextKey(sessionId, frameId);
  const candidates = map.get(key) || new Map<string, IsolatedContext>();
  const next: IsolatedContext = { id, uniqueId };
  const identity = contextIdentity(next);
  for (const [existingIdentity, existing] of candidates) {
    if (existing.id === id && existingIdentity !== identity) candidates.delete(existingIdentity);
  }
  candidates.set(identity, next);
  map.set(key, candidates);
  isolatedByTab.set(tabId, map);
}
globalThis.chrome?.debugger?.onEvent?.addListener((source, method, params) => noteExecutionContext(source, method, params));
globalThis.chrome?.debugger?.onDetach?.addListener(source => {
  forgetIsolatedContexts(Number(source?.tabId));
});
type ElementCaller = (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Owns stable element references and page/tab/session validation. */
export function createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies,
  makeSessionTabTargetError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  withDebugger,
  sendToContent,
  initializeContentScript,
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
  "uid:t5493.000001.12",
  "uid:t5493.000001.i3",
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

let lastSnapshotSerial = 0;
function makeSnapshotId(tabId: number, context: ToolContext = {}) {
  const id = Number(tabId);
  const peers = taskTabIds(context);
  const ids = peers.includes(id) ? peers : [...peers, id];
  const suffix = uniqueTabSuffix(id, ids);
  // A monotonic clock serial keeps the established six-character format within a worker.
  lastSnapshotSerial = Math.max(Date.now(), lastSnapshotSerial + 1);
  const serial = (lastSnapshotSerial % (36 ** 6)).toString(36).padStart(6, "0");
  return `t${suffix}.${serial}`;
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

async function addElementTargetsToFindResult(result: unknown, tabId?: number, context: ToolContext = {}, scope?: Pick<ElementReference, "frameId" | "loaderId">) {
  if (!isRecord(result)) return result;
  const items = Array.isArray(result.results) ? result.results : Array.isArray(result.elements) ? result.elements : [result];
  const tokens = items.filter(isRecord).map(item => item._elementRef).filter((token): token is string => typeof token === "string" && !!token);
  const bound = tokens.length && tabId ? await bindFindElementRefs(tabId, tokens, context, scope) : new Map<string, ElementReference>();
  const snapshotId = bound.size && tabId ? makeSnapshotId(tabId, context) : "";
  let sequence = 0;
  const addTarget = (item: unknown) => {
    if (!isRecord(item)) return item;
    let candidate = item;
    if (typeof item._elementRef === "string") {
      const { _elementRef, ...summary } = item;
      const ref = bound.get(_elementRef);
      if (!ref) return { ...summary, actionable: false };
      const uid = makeElementUid(snapshotId, ++sequence);
      registerElementRef({ ...ref, uid, tabId, sessionId: context.sessionId });
      candidate = { ...summary, uid };
    }
    const target = candidate.target || elementTargetForUid(candidate.uid) || elementTargetForSelector(candidate.selector);
    return target ? { ...candidate, target } : candidate;
  };
  if (Array.isArray(result.results)) {
    return { ...result, results: result.results.map(addTarget) };
  }
  if (Array.isArray(result.elements)) {
    return { ...result, elements: result.elements.map(addTarget) };
  }
  return addTarget(result);
}

async function bindFindElementRefs(tabId: number, tokens: string[], context: ToolContext, scope?: Pick<ElementReference, "frameId" | "loaderId">) {
  const objectGroup = `${OBJECT_GROUP}-find-${makeSnapshotId(tabId, context)}`;
  try {
    return await withDebugger(tabId, async (_target, send) => {
      const child = scope?.frameId ? await openChildFrame(send, scope.frameId) : null;
      if (scope?.frameId && !child) throw staleElement(scope.frameId);
      const nodeSend = child?.send || send;
      const frame = child || record(record(record(await send("Page.getFrameTree")).frameTree).frame);
      const frameId = String(frame.id || "");
      const loaderId = String(frame.loaderId || "");
      if (scope?.loaderId && scope.loaderId !== loaderId) throw staleElement(scope.frameId);
      const contextId = await contentContextId(tabId, nodeSend, frameId, child?.sessionId || "", context);
      const bound = new Map<string, ElementReference>();
      try {
        for (const token of tokens) {
          const remote = record(await nodeSend("Runtime.callFunctionOn", {
            executionContextId: contextId, objectGroup, awaitPromise: true, returnByValue: false,
            functionDeclaration: ISOLATED_CONTENT_INVOKE,
            arguments: [{ value: { action: "resolveFindElement", elementRef: token } }],
          }));
          const object = record(remote.result);
          if (remote.exceptionDetails || object.subtype !== "node" || !object.objectId) continue;
          const described = record(await nodeSend("DOM.describeNode", { objectId: object.objectId }));
          const backendNodeId = Number(record(described.node).backendNodeId || 0);
          if (backendNodeId) bound.set(token, { backendNodeId, loaderId, ...(child ? { frameId } : {}) });
        }
        if (await frameLoaderId(nodeSend, frameId) !== loaderId) throw staleElement(frameId);
        return bound;
      } finally {
        try { await nodeSend("Runtime.releaseObjectGroup", { objectGroup }); } catch { /* The document may be gone. */ }
      }
    }, context);
  } catch (error) {
    if (isCdpFallbackForbiddenError(error)) throw error;
    // Do not advertise an actionable hit when its original node cannot be bound.
    return new Map<string, ElementReference>();
  }
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

async function resolveElementReference(tabId: number | undefined, { target = "", index = 0, readOnly = false } = {}, context: ToolContext = {}) {
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
  const selectorFallback = !Number(ref.backendNodeId || 0) && Boolean(String(ref.selector || "").trim());
  const suffix = (/^t(\d+)\./.exec(requestedUid) || [])[1] || "";
  if (suffix) {
    const listed = taskTabIds(context);
    // A read-only selector uid may name a tab this session does not own. Check that
    // suffix against the registered tab alone so it cannot collide with an owned tab.
    const candidates = readOnly === true && selectorFallback
      ? [Number(ref.tabId)]
      : (listed.length ? listed : [Number(ref.tabId)]);
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

  // Reject an explicit mismatch before resolving ownership can select or claim that tab.
  if (tabId && Number(tabId) !== Number(ref.tabId)) {
    throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", `Element target belongs to tab ${ref.tabId}, not tab ${tabId}`, {
      target: elementTargetForUid(requestedUid),
      tabId,
      refTabId: ref.tabId,
    });
  }
  const resolvedTabId = Number(ref.tabId);
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
      runId: context.runId,
      signal: context.signal,
      tabId: resolvedTabId,
      source: "element_uid_reference",
      checkOnly: context.preserveWorkingTab === true || context.deferToolCommit === true,
      // Selector fallback is a content-script read. Node-backed uids keep the ownership check.
      readOnly: readOnly === true && selectorFallback,
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
    if ((context.preserveWorkingTab || context.deferToolCommit) && resolved.claimRequired && !resolved.readOnlyAccess) {
      throw makeSessionTabTargetError("SESSION_TAB_UNOWNED", {
        toolName: "element_uid_reference", sessionId: currentSessionId, tabId: resolvedTabId,
      });
    }
  }
  // Security guardrails gate before any page probe, including the read-only document id.
  await assertTabAllowedBySecurityGuardrails(resolvedTabId, { tool: "element_target", source: "uid_target" });
  let currentUrl = "";
  if (ref.pageUrl) {
    try {
      const tab = await chrome.tabs.get(resolvedTabId);
      currentUrl = getEffectiveTabUrl(tab);
    } catch(_e) {
      currentUrl = "";
    }
  }
  const urlChanged = Boolean(ref.pageUrl && currentUrl && !samePageUrl(currentUrl, ref.pageUrl));
  const storedDocumentId = String(ref.documentId || "");
  if (storedDocumentId) {
    const currentDocumentId = await readMainDocumentId(resolvedTabId);
    // A title redirect or history.replaceState keeps the document; a real navigation replaces it.
    if (currentDocumentId && currentDocumentId !== storedDocumentId) {
      if (urlChanged) {
        throw new ToolExecutionError(
          "STALE_ELEMENT_UID_PAGE_CHANGED",
          `Element target belongs to a previous page state. Take a fresh get_ax_tree snapshot, then retry.`,
          { target: elementTargetForUid(requestedUid), tabId: resolvedTabId, currentUrl, snapshotUrl: ref.pageUrl },
        );
      }
      throw staleElement(requestedUid);
    }
    // A changed URL string is positive evidence the page changed; only a matching live
    // document disproves it. A missing probe cannot, so the strict verdict stands.
    if (urlChanged && !currentDocumentId) {
      throw new ToolExecutionError(
        "STALE_ELEMENT_UID_PAGE_CHANGED",
        `Element target belongs to a previous page state. Take a fresh get_ax_tree snapshot, then retry.`,
        { target: elementTargetForUid(requestedUid), tabId: resolvedTabId, currentUrl, snapshotUrl: ref.pageUrl },
      );
    }
  } else if (urlChanged) {
    throw new ToolExecutionError(
      "STALE_ELEMENT_UID_PAGE_CHANGED",
      `Element target belongs to a previous page state. Take a fresh get_ax_tree snapshot, then retry.`,
      { target: elementTargetForUid(requestedUid), tabId: resolvedTabId, currentUrl, snapshotUrl: ref.pageUrl },
    );
  }
  const backendNodeId = Number(ref.backendNodeId || 0);
  return {
    tabId: resolvedTabId,
    selector: backendNodeId ? "" : String(ref.selector || "").trim(),
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
  const match = value.match(/\bt\d+\.[0-9a-z]{6}\.[0-9a-z]*\d+\b/i);
  return match ? match[0] : value;
}

/**
 * The one tab every value's uid is registered to, or null when any value is not a
 * known uid or the set spans tabs. Null tells callers to fall back to conservative
 * targeting; the registry is the only authority on a uid's tab.
 */
function elementUidTabId(values: readonly unknown[]) {
  let shared = 0;
  for (const value of values || []) {
    let uid = "";
    try {
      uid = normalizeElementUid(parseElementTarget(typeof value === "string" ? value : "").uid);
    } catch {
      return null;
    }
    const ref = uid ? elementRefRegistry.get(uid) : undefined;
    const tabId = Number(ref?.tabId);
    if (!ref || !Number.isInteger(tabId) || tabId <= 0) return null;
    if (!shared) shared = tabId;
    else if (shared !== tabId) return null;
  }
  return shared || null;
}

async function backendNodeIdForSelector(tabId: number, selector: string, context: ToolContext = {}) {
  const bound = await bindBackendNodes(tabId, [selector], context);
  return bound.ids[0] || 0;
}

async function bindBackendNodes(tabId: number, selectors: string[], context: ToolContext = {}, scope?: Pick<ElementReference, "frameId" | "loaderId">) {
  try {
    return await withDebugger(tabId, async (_target, send) => {
      if (!scope?.frameId) return describeSelectors(send, selectors);
      const frame = await openChildFrame(send, scope.frameId);
      if (!frame || (scope.loaderId && frame.loaderId !== scope.loaderId)) throw staleElement(scope.frameId);
      const bound = await describeSelectors(frame.send, selectors, frame.sessionId ? "" : frame.id);
      if (await frameLoaderId(frame.send, frame.id) !== frame.loaderId) throw staleElement(scope.frameId);
      return { ...bound, loaderId: frame.loaderId };
    }, context);
  } catch (err) {
    if (isCdpFallbackForbiddenError(err) || (err instanceof ToolExecutionError && err.code === "STALE_ELEMENT_UID")) throw err;
    return { loaderId: scope?.loaderId || "", ids: selectors.map(() => 0) };
  }
}

async function describeSelectors(send: CdpCommand, selectors: string[], localFrameId = "") {
  const frame = record(record(record(await send("Page.getFrameTree")).frameTree).frame);
  const root = record(await send("DOM.getDocument", { depth: 0, pierce: true }));
  let documentNodeId = Number(record(root.root).nodeId || 0);
  if (localFrameId) {
    const owner = record(await send("DOM.getFrameOwner", { frameId: localFrameId }));
    const described = record(await send("DOM.describeNode", { backendNodeId: owner.backendNodeId, depth: 1, pierce: true }));
    const document = record(record(described.node).contentDocument);
    const pushed = document.backendNodeId
      ? record(await send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [document.backendNodeId] })) : {};
    documentNodeId = Array.isArray(pushed.nodeIds) ? Number(pushed.nodeIds[0] || 0) : 0;
  }
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

type ElementBinding = { tabId?: number; selector?: string; index?: number; uid?: string; target?: string; ref?: ElementReference };

function hasBackendNode(binding: ElementBinding) {
  return Number(binding.ref?.backendNodeId || 0) > 0;
}

function selectorRoute(binding: ElementBinding) {
  // A uid keeps the selector stored with it. A css target already carries its own selector.
  const selector = binding.uid
    ? String(binding.selector || binding.ref?.selector || "").trim()
    : String(binding.selector || "");
  const explicitIndex = Number(binding.index);
  const storedIndex = Number(binding.ref?.index);
  const index = Number.isInteger(explicitIndex) && explicitIndex >= 0
    ? explicitIndex
    : Number.isInteger(storedIndex) && storedIndex >= 0 ? storedIndex : 0;
  return { selector, index };
}

/** One decision for every uid: the bound node, its selector, or an explicit stale target. */
async function useElement<T>(tabId: number | undefined, binding: ElementBinding, context: ToolContext, run: (call: ElementCaller) => Promise<T>) {
  if (binding.uid && hasBackendNode(binding)) {
    return withElement(tabId, binding, context, (_send, call) => run(call));
  }
  const route = selectorRoute(binding);
  if (binding.uid && !route.selector) throw staleElement(binding.target || binding.uid);
  const call: ElementCaller = async (action, params = {}) => {
    const requested = String(params.selector || "").trim();
    const selector = requested || route.selector;
    const requestedIndex = Number(params.index);
    const index = Number.isInteger(requestedIndex) && requestedIndex >= 0 ? requestedIndex : route.index;
    return asElementReply(await sendToContent(binding.tabId || tabId, action, { ...params, selector, index }), action);
  };
  return run(call);
}

async function callElement(tabId: number | undefined, binding: ElementBinding, action: string, params: Record<string, unknown> = {}, context: ToolContext = {}) {
  return useElement(tabId, binding, context, call => call(action, params));
}

/** Chrome's main-frame document id, without a navigation permission. Empty when the probe is unavailable. */
async function readMainDocumentId(tabId: number) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return "";
  try {
    const scripting = chrome.scripting;
    if (!scripting?.executeScript) return "";
    const [result] = await scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      injectImmediately: true,
      func: () => null,
    });
    return String(result?.documentId || "");
  } catch {
    return "";
  }
}

async function withElement<T>(tabId: number | undefined, binding: { tabId?: number; uid?: string; target?: string; ref?: ElementReference }, context: ToolContext, run: (send: CdpCommand, call: ElementCaller) => Promise<T>) {
  const id = Number(binding.tabId || tabId);
  if (!Number.isInteger(id) || id <= 0) throw new ToolExecutionError("MISSING_TAB_ID", "Element target has no usable tabId", { target: binding.target || "" });
  const objectGroup = `${OBJECT_GROUP}-${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return withDebugger(id, async (_target, send) => {
    const requestedFrameId = String(binding.ref?.frameId || "");
    let nodeSend: CdpCommand = send;
    let cdpFrameId = "";
    let sessionId = "";
    let loaderId = "";
    if (requestedFrameId) {
      const opened = await openChildFrame(send, requestedFrameId);
      if (!opened) throw staleElement(binding.uid || binding.target || "");
      if (binding.ref?.loaderId && opened.loaderId && binding.ref.loaderId !== opened.loaderId) throw staleElement(binding.uid || binding.target || "");
      nodeSend = opened.send;
      cdpFrameId = opened.id;
      sessionId = opened.sessionId;
      loaderId = opened.loaderId;
    } else {
      const frame = record(record(record(await send("Page.getFrameTree")).frameTree).frame);
      cdpFrameId = String(frame.id || "");
      loaderId = String(frame.loaderId || "");
      if (binding.ref?.loaderId && loaderId && binding.ref.loaderId !== loaderId) throw staleElement(binding.uid || binding.target || "");
    }
    const contextId = await contentContextId(id, nodeSend, cdpFrameId, sessionId, context);
    if (requestedFrameId) {
      if ((await frameLoaderId(nodeSend, cdpFrameId)) !== loaderId) throw staleElement(binding.uid || binding.target || "");
    } else {
      // Selection may initialize Content while a navigation replaces the document.
      const current = record(record(record(await send("Page.getFrameTree")).frameTree).frame);
      if (current.id !== cdpFrameId || current.loaderId !== loaderId) throw staleElement(binding.uid || binding.target || "");
    }
    const objectId = await objectFromBackend(nodeSend, binding, objectGroup, contextId);
    try {
      return await run(nodeSend, (action, params = {}) => invokeBound(nodeSend, objectId, action, params, objectGroup, context));
    } finally {
      try { await nodeSend("Runtime.releaseObjectGroup", { objectGroup }); } catch { /* The node may already be gone. */ }
    }
  }, context);
}

async function objectFromBackend(send: CdpCommand, binding: { target?: string; ref?: ElementReference }, objectGroup: string, contextId: number) {
  const backendNodeId = Number(binding.ref?.backendNodeId || 0);
  if (!backendNodeId) throw staleElement(binding.target || "");
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

function isolatedContexts(tabId: number, sessionId: string) {
  const map = isolatedByTab.get(tabId);
  if (!map) return undefined;
  return { get: (frameId: string) => map.get(contextKey(sessionId, frameId)) };
}

async function frameLoaderId(send: CdpCommand, frameId: string) {
  let tree: unknown;
  try { tree = await send("Page.getFrameTree"); }
  catch (error) {
    if (isCdpFallbackForbiddenError(error)) throw error;
    return "";
  }
  const root = record(record(tree).frameTree);
  const main = record(root.frame);
  if (String(main.id || "") === frameId) return String(main.loaderId || "");
  for (const entry of Array.isArray(root.childFrames) ? root.childFrames : []) {
    const frame = record(record(entry).frame);
    if (String(frame.id || "") === frameId) return String(frame.loaderId || "");
  }
  return "";
}

async function contentContextId(tabId: number, send: CdpCommand, frameId: string, sessionId = "", context: ToolContext = {}) {
  const select = async () => {
    const candidates = isolatedContexts(tabId, sessionId)?.get(frameId);
    if (!candidates?.size) return 0;
    for (const candidate of [...candidates.values()]) {
      try {
        const probe: Record<string, unknown> = {
          returnByValue: true,
          expression: ISOLATED_CONTENT_PROBE,
        };
        // uniqueContextId is the context identity. A reused numeric id must not
        // satisfy this probe. Reports that omit uniqueId keep the numeric id.
        if (candidate.uniqueId) probe.uniqueContextId = candidate.uniqueId;
        else probe.contextId = candidate.id;
        const result = record(await send("Runtime.evaluate", probe));
        const value = record(record(result.result).value);
        const current = isolatedContexts(tabId, sessionId)?.get(frameId);
        const still = current?.get(contextIdentity(candidate));
        const selected = !result.exceptionDetails && Boolean(chrome.runtime.id)
          && value.extensionId === chrome.runtime.id && value.bridge === true
          && current === candidates && still?.id === candidate.id && still.uniqueId === candidate.uniqueId;
        if (selected) return candidate.id;
      } catch (error) {
        if (isCdpFallbackForbiddenError(error) || !/Cannot find context|Execution context (?:was destroyed|is not available)/i.test(String(error))) throw error;
      }
    }
    return 0;
  };
  // Leave Runtime enabled and keep the contexts already reported. A fresh
  // enable reports contexts only when the domain was off, and that transition
  // replays cached console calls into read_console_messages.
  const discover = async () => {
    await send("Runtime.enable");
  };
  if (!isolatedContexts(tabId, sessionId)?.get(frameId)?.size) await discover();
  let id = await select();
  if (id) return id;
  // The reported worlds have no bridge. Initialize Content once, then validate
  // again; no action has been dispatched on this path.
  await initializeContentScript(tabId, context);
  await discover();
  id = await select();
  if (!id) throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "The page script is not ready to read or interact with this page.", { tabId });
  return id;
}

async function invokeBound(send: CdpCommand, objectId: string, action: string, params: Record<string, unknown>, objectGroup: string, context: ToolContext) {
  const finishPhase = context.measurePhase?.("extraction");
  try {
    const remote = record(await send("Runtime.callFunctionOn", {
      objectId, objectGroup, awaitPromise: true, returnByValue: true,
      functionDeclaration: ISOLATED_CONTENT_INVOKE,
      arguments: [{ value: { ...params, action } }],
    }));
    const details = record(remote.exceptionDetails);
    if (details.text || details.exception) {
      throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", String(details.text || "Content script call failed"), { action });
    }
    return asElementReply(record(remote.result).value, action);
  } finally { finishPhase?.(); }
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
    elementUidTabId,
    isUidElementTarget,
    resolveSelectorTarget,
    resolveElementReference,
    addElementTargetsToFindResult,
    backendNodeIdForSelector,
    bindBackendNodes,
    callElement,
    useElement,
    readMainDocumentId,
    taskTabIds,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
