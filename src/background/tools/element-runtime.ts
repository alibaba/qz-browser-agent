import { toolError, isToolFailure, pageErrorDetails } from "../../shared/contracts/tool-error.js";
import type { ToolContext, ToolErrorConstructor } from '../../sdk/background.js';
import type { CdpCommand } from '../../sdk/background/browser.js';
import type { GetToolRuntimeDependencies } from '../../sdk/background/services.js';
import type { createCdpRuntime } from './cdp-runtime.js';
import { openChildFrame } from './child-frames.js';
import { waitForParsedDocument } from './document-readiness.js';
import { createElementObservation, type ElementObservation } from "../../shared/contracts/element-observation.js";
import { validateElementLocator, type ElementLocator } from "../../shared/contracts/element-locator.js";
import type { ElementTarget } from "../../sdk/background/browser.js";

export interface ElementReference {
  uid?: string; selector?: string; tabId?: number; sessionId?: string; pageUrl?: string;
  index?: number; imageSrc?: string; imageIndex?: number;   backendNodeId?: number; role?: string; name?: string; createdAt?: number;
  loaderId?: string; documentId?: string; frameId?: string;
  [field: string]: unknown;
}
interface ElementRuntimeHost {
  ToolExecutionError: ToolErrorConstructor;
  getToolRuntimeDependencies: GetToolRuntimeDependencies;
  makeSessionTabTargetError(code: string, details: Record<string, unknown>, context?: ToolContext): Error;
  assertTabAllowed(tabId: number, details: Record<string, unknown>): Promise<unknown>;
  withDebugger: ReturnType<typeof createCdpRuntime>['withDebugger'];
  sendToContent(tabId: number | undefined, action: string, params?: Record<string, unknown>, context?: ToolContext): Promise<unknown>;
  initializeContentScript(tabId: number, context?: ToolContext): Promise<void>;
  isReadOnlyAccess?(tabId: number, context: ToolContext): boolean;
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
  isReadOnlyAccess = () => false,
}: ElementRuntimeHost) {
// ---------------------------------------------------------------------------
// Page snapshot element refs
// ---------------------------------------------------------------------------

const elementRefRegistry = new Map<string, ElementReference>();
const nodeRefRegistry = new Map<string, string>();
let elementSequence = 0;
const ELEMENT_REF_TTL_MS = 30 * 60 * 1000;
const ELEMENT_REF_MAX = 5000;
const ELEMENT_TARGET_GRAMMAR = 'target = "uid:" <element_uid> | "css:" <css_selector>';
function getElementTargetExamples() {
return [
  "uid:t5493.000001.12",
  "uid:t5493.000001.13",
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

function nodeKey(ref: ElementReference) {
  return [ref.sessionId || "", ref.tabId, ref.frameId || "", ref.loaderId || ref.documentId || "", ref.snapshotId || "", ref.backendNodeId].join("\n");
}

function registerElementRef(ref: ElementReference) {
  if (!ref?.uid) return;
  cleanupElementRefs();
  const previous = elementRefRegistry.get(ref.uid);
  if (previous && nodeRefRegistry.get(nodeKey(previous)) === ref.uid) nodeRefRegistry.delete(nodeKey(previous));
  elementRefRegistry.set(ref.uid, { ...ref, createdAt: Date.now() });
  if (Number(ref.backendNodeId) > 0) nodeRefRegistry.set(nodeKey(ref), ref.uid);
}

/** All producers use this registration path; a CSS fallback is never advertised as a node UID. */
function registerElementBinding(ref: ElementReference): ElementReference & { target: string } {
  const backendNodeId = Number(ref.backendNodeId);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    return { ...ref, uid: undefined, target: elementTargetForSelector(ref.selector) };
  }
  cleanupElementRefs();
  const snapshotId = String(ref.snapshotId || makeSnapshotId(Number(ref.tabId), { sessionId: ref.sessionId }));
  const scoped = { ...ref, snapshotId };
  const existing = nodeRefRegistry.get(nodeKey(scoped));
  const uid = existing || makeElementUid(snapshotId, ++elementSequence);
  registerElementRef({ ...scoped, backendNodeId, uid });
  return { ...scoped, backendNodeId, uid, target: elementTargetForUid(uid) };
}

function cleanupElementRefs() {
  const now = Date.now();
  for (const [uid, ref] of elementRefRegistry.entries()) {
    if (now - Number(ref.createdAt || 0) > ELEMENT_REF_TTL_MS) {
      elementRefRegistry.delete(uid);
      if (nodeRefRegistry.get(nodeKey(ref)) === uid) nodeRefRegistry.delete(nodeKey(ref));
    }
  }
  while (elementRefRegistry.size > ELEMENT_REF_MAX) {
    const first = elementRefRegistry.keys().next().value;
    if (!first) break;
    const ref = elementRefRegistry.get(first)!;
    elementRefRegistry.delete(first);
    if (nodeRefRegistry.get(nodeKey(ref)) === first) nodeRefRegistry.delete(nodeKey(ref));
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
  if (kind !== "uid" && kind !== "css") return { uid: "", selector: raw };
  throw new ToolExecutionError("INVALID_ELEMENT_TARGET", `Invalid element target: ${raw}`, {
    target: raw,
    expected: ELEMENT_TARGET_GRAMMAR,
    examples: getElementTargetExamples(),
  });
}

async function addElementTargetsToFindResult(result: unknown, tabId?: number, context: ToolContext = {}, scope?: ElementReference) {
  if (!isRecord(result)) return result;
  if (isToolFailure(result)) return toolError(String(result.code || "ELEMENT_QUERY_FAILED"), String(result.message || result.error), {
    hint: typeof result.hint === "string" ? result.hint : "Pass a valid target. Use get_ax_tree or find_elements to refresh element references before retrying.",
    ...(typeof record(result.details).target === "string" ? { details: { target: record(result.details).target } } : {}),
  });
  if (!tabId) return result;
  const items = Array.isArray(result.results) ? result.results : Array.isArray(result.elements) ? result.elements : [result];
  const candidates = items.filter(isRecord).flatMap(item => [item, ...[item.parent, item.form].filter(isRecord)]);
  const bindings = await bindElementReferences(tabId, candidates, context, scope);
  const byItem = new Map(candidates.map((item, index) => [item, bindings[index]]));
  const addTarget = (item: unknown): ElementObservation | null => {
    if (!isRecord(item)) return null;
    const target = byItem.get(item)?.target;
    const observation = createElementObservation(item, target);
    if (!target) observation.actionable = false;
    if (Object.hasOwn(item, 'parent')) observation.parent = addTarget(item.parent);
    if (Object.hasOwn(item, 'form')) observation.form = addTarget(item.form);
    return observation;
  };
  if (Array.isArray(result.results)) return { ...result, results: result.results.map(addTarget) };
  if (Array.isArray(result.elements)) return { ...result, elements: result.elements.map(addTarget) };
  return addTarget(result);
}

/** One binding/registration pipeline for Content observations, image candidates and AX anchors. */
async function bindElementReferences(tabId: number, candidates: readonly ElementReference[], context: ToolContext = {}, scope?: ElementReference, mode: "bestEffort" | "required" = "bestEffort") {
  context.signal?.throwIfAborted();
  if (!candidates.length) return [];
  if (mode === "required" && candidates.some(item => !item._elementRef && !(Number(item.backendNodeId) > 0))) {
    throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "The element observation has no node binding.", pageErrorDetails(context));
  }
  const documentId = scope?.documentId || await readMainDocumentId(tabId);
  let pageUrl = scope?.pageUrl || "";
  try { if (!pageUrl) pageUrl = getEffectiveTabUrl(await chrome.tabs.get(tabId)); } catch { /* Binding enforces access separately. */ }
  const tokens = [...new Set(candidates.map(item => item._elementRef).filter((value): value is string => typeof value === "string" && Boolean(value)))];
  const bound = tokens.length ? await bindContentElementRefs(tabId, tokens, context, scope, mode) : new Map<string, ElementReference>();
  const selectorCandidates = candidates.filter(item => !item._elementRef && !Number(item.backendNodeId) && item.selector);
  let selected = { loaderId: scope?.loaderId || "", ids: [] as number[] };
  if (selectorCandidates.length) {
    try { selected = await bindBackendNodes(tabId, selectorCandidates.map(item => String(item.selector)), context, scope); }
    catch (error) {
      if (!["SESSION_TAB_UNOWNED", "SESSION_TAB_FOREIGN"].includes(String(record(error).code || ""))) throw error;
    }
  }
  const selectorBindings = new Map(selectorCandidates.map((item, index) => [item, selected.ids[index] || 0]));
  context.signal?.throwIfAborted();
  const snapshotId = makeSnapshotId(tabId, context);
  return candidates.map(item => {
    const binding = typeof item._elementRef === "string" ? bound.get(item._elementRef) : null;
    return registerElementBinding({ ...item, ...binding, tabId, sessionId: context.sessionId, pageUrl, documentId, snapshotId,
      frameId: binding?.frameId || scope?.frameId,
      loaderId: binding?.loaderId || item.loaderId || selected.loaderId,
      backendNodeId: mode === "required" && item._elementRef ? binding?.backendNodeId
        : binding?.backendNodeId || item.backendNodeId || selectorBindings.get(item) || undefined });
  });
}

async function bindContentElementRefs(tabId: number, tokens: string[], context: ToolContext, scope?: ElementReference, mode: "bestEffort" | "required" = "bestEffort") {
  const objectGroup = `${OBJECT_GROUP}-find-${makeSnapshotId(tabId, context)}`;
  try {
    return await withDebugger(tabId, async (_target, send) => {
      const child = scope?.frameId ? await openChildFrame(send, scope.frameId) : null;
      if (scope?.frameId && !child) throw staleElement(scope.uid || scope.target);
      const nodeSend = child?.send || send;
      const frame = child || record(record(record(await send("Page.getFrameTree")).frameTree).frame);
      const frameId = String(frame.id || "");
      const loaderId = String(frame.loaderId || "");
      if (scope?.loaderId && scope.loaderId !== loaderId) throw staleElement(scope.uid || scope.target);
      const contextId = await contentContextId(tabId, nodeSend, frameId, child?.sessionId || "", context);
      const bound = new Map<string, ElementReference>();
      try {
        for (let offset = 0; offset < tokens.length; offset += 100) {
          context.signal?.throwIfAborted();
          const chunk = tokens.slice(offset, offset + 100);
          const remote = record(await nodeSend("Runtime.callFunctionOn", {
            executionContextId: contextId, objectGroup, awaitPromise: true, returnByValue: false,
            functionDeclaration: ISOLATED_CONTENT_INVOKE,
            arguments: [{ value: { action: "resolveElementRefs", elementRefs: chunk } }],
          }));
          if (remote.exceptionDetails) throw staleElement(chunk[0]);
          const object = record(remote.result);
          if (object.subtype !== "array" || !object.objectId) {
            if (mode === "required") throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Element binding returned an invalid node list.", pageErrorDetails(context));
            continue;
          }
          const properties = record(await nodeSend("Runtime.getProperties", { objectId: object.objectId, ownProperties: true }));
          const entries = (Array.isArray(properties.result) ? properties.result : []).map(record);
          if (mode === "required" && chunk.some((_token, index) => {
            const value = record(entries.find(property => property.name === String(index))?.value);
            return value.subtype !== "null" && !(value.subtype === "node" && typeof value.objectId === "string" && value.objectId);
          })) throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Element binding returned an invalid node reference.", pageErrorDetails(context));
          const nodes = entries
            .filter(property => /^\d+$/.test(String(property.name)) && record(property.value).subtype === "node");
          // One context and one object group per batch; at most eight node descriptions in flight.
          for (let start = 0; start < nodes.length; start += 8) await Promise.all(nodes.slice(start, start + 8).map(async property => {
            const token = chunk[Number(property.name)];
            if (!token) return;
            const described = record(await nodeSend("DOM.describeNode", { objectId: record(property.value).objectId }));
            const backendNodeId = Number(record(described.node).backendNodeId || 0);
            if (mode === "required" && (!Number.isInteger(backendNodeId) || backendNodeId <= 0)) {
              throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Element binding returned an invalid node identity.", pageErrorDetails(context));
            }
            if (backendNodeId) bound.set(token, { backendNodeId, loaderId, ...(child ? { frameId } : {}) });
          }));
        }
        if (await frameLoaderId(nodeSend, frameId) !== loaderId) throw staleElement(frameId);
        return bound;
      } finally {
        try { await nodeSend("Runtime.releaseObjectGroup", { objectGroup }); } catch { /* The document may be gone. */ }
      }
    }, context);
  } catch (error) {
    const code = String(record(error).code || "");
    if (mode === "required" || (isCdpFallbackForbiddenError(error) && !["SESSION_TAB_UNOWNED", "SESSION_TAB_FOREIGN"].includes(code)) || code.startsWith("STALE_ELEMENT_UID")) throw error;
    return new Map<string, ElementReference>();
  }
}

/** Existing CSS targets are usable during parsing; a missing target waits before any action starts. */
async function prepareCssTargets(tabId: number, targets: unknown[],
  { index = 0, includeShadow = false }: { index?: number; includeShadow?: boolean }, context: ToolContext) {
  if (!Number.isInteger(index) || index < 0) return;
  for (const target of new Set(targets.map(value => String(value || "").trim()))) {
    const { selector } = parseElementTarget(target);
    if (!selector) continue;
    const presence = record(await sendToContent(tabId, "elementPresence", {
      selector, index, visibleOnly: false, includeShadow, queryOnly: true,
    }, context));
    // Invalid selectors keep their normal tool error; no action has been dispatched.
    if (presence.error || presence.code) return;
    if (presence.found === false) {
      await waitForParsedDocument(tabId, context);
      return;
    }
  }
}

async function resolveSelectorTarget(tabId: number | undefined, selector = "", index = 0, context: ToolContext = {}) {
  const raw = String(selector || "").trim();
  if (!raw) return { tabId, selector: "" };
  if (!isElementTarget(raw)) return { tabId, selector: raw, target: elementTargetForSelector(raw) };
  const parsed = parseElementTarget(raw);
  if (parsed.selector) return { tabId, selector: parsed.selector, target: elementTargetForSelector(parsed.selector) };
  const ref = await resolveElementReference(tabId, { target: raw, index }, context);
  return { tabId: ref.tabId, selector: ref.selector, index: ref.index, target: ref.target, uid: ref.uid, ref: ref.ref };
}

/** A single query in its bound document; callers own retries and the operation deadline. */
async function scanLocator(tabId: number | undefined, locator: ElementLocator, context: ToolContext, options: { countOnly?: boolean; all?: boolean; limit?: number } = {}) {
  try { validateElementLocator(locator); }
  catch (error) {
    throw Object.assign(new ToolExecutionError("INVALID_ELEMENT_LOCATOR", String(record(error).message || error), pageErrorDetails(context)), {
      hint: "Pass a CSS/UID target or a role, name, or text query; use scope to narrow the search.",
    });
  }
  context.signal?.throwIfAborted();
  if (!Number.isInteger(tabId) || Number(tabId) <= 0) {
    throw new ToolExecutionError("TAB_REF_REQUIRED", "Pass tabRef for the page containing the element.", pageErrorDetails(context));
  }
  const id = Number(tabId);
  const pinned = isUidElementTarget(locator.target);
  const root = pinned ? await resolveElementReference(id, { target: locator.target }, context)
    : isUidElementTarget(locator.scope) ? await resolveElementReference(id, { target: locator.scope }, context) : null;
  if (pinned && !options.countOnly && !options.all && !locator.role && !locator.name && !locator.text) {
    return { id, pinned, root, matched: 1, element: undefined, results: [] as unknown[] };
  }
  // CSS scopes are resolved strictly in the same Content scan. Only UID roots need host binding.
  const queryInput = { ...locator };
  if (root) delete queryInput.scope;
  if (pinned) delete queryInput.target;
  const params = { locator: queryInput, ...options, ...(pinned ? { matchSelf: true } : {}) };
  let response: Record<string, unknown>;
  try {
    response = record(await (root ? callElement(id, root, "resolveLocator", params, context)
      : sendToContent(id, "resolveLocator", params, context)));
  } catch (error) {
    if (pinned && record(error).code === "STALE_ELEMENT_UID" && record(record(error).details).reason === "node_unavailable") {
      return { id, pinned, root, matched: 0, element: undefined, results: [] as unknown[] };
    }
    throw error;
  }
  context.signal?.throwIfAborted();
  if (response.code || response.error) throw Object.assign(new ToolExecutionError(
    String(response.code || "ELEMENT_QUERY_FAILED"), String(response.message || response.error || "Element query failed."),
    { ...pageErrorDetails(context, typeof record(response.details).target === "string" ? String(record(response.details).target) : locator.target),
      ...(typeof record(response.details).matched === "number" ? { matched: record(response.details).matched } : {}) },
  ), typeof response.hint === "string" ? { hint: response.hint } : {});
  if (!Number.isInteger(response.matched) || Number(response.matched) < 0) {
    throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Element query returned an invalid match count.", pageErrorDetails(context));
  }
  if (options.all && !Array.isArray(response.results)) {
    throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Element query returned an invalid candidate list.", pageErrorDetails(context));
  }
  return { id, pinned, root, matched: Number(response.matched), element: response.element,
    results: Array.isArray(response.results) ? response.results : [] };
}

/** Count attached matches, including hidden nodes. An explicit nth selects at most one. */
async function countLocatorMatches(tabId: number | undefined, locator: ElementLocator, context: ToolContext = {}) {
  const { matched } = await scanLocator(tabId, locator, context, { countOnly: true });
  return locator.nth === undefined ? matched : locator.nth < matched ? 1 : 0;
}

/** Discovery uses the same field matcher as actions, while retaining a list result. */
async function findLocatorElements(tabId: number | undefined, locator: ElementLocator, context: ToolContext = {}, limit = 20) {
  const scanned = await scanLocator(tabId, locator, context, { all: true, limit });
  const count = locator.nth === undefined ? scanned.matched : locator.nth < scanned.matched ? 1 : 0;
  const candidates = scanned.results.filter(isRecord);
  const results = scanned.pinned
    ? candidates.map(item => createElementObservation(item, scanned.root?.target))
    : record(await addElementTargetsToFindResult({ results: candidates }, scanned.id, context, scanned.root?.ref)).results;
  return { results: Array.isArray(results) ? results : [], count };
}

/** A strict query binds its selected node once; it never falls back to re-querying CSS. */
async function resolveLocatorTarget(tabId: number | undefined, locator: ElementLocator, context: ToolContext = {}): Promise<ElementTarget | null> {
  const { id, pinned, root, matched, element } = await scanLocator(tabId, locator, context);
  if (matched === 0 || locator.nth !== undefined && locator.nth >= matched) return null;
  if (matched > 1 && locator.nth === undefined) throw Object.assign(
    new ToolExecutionError("AMBIGUOUS_ELEMENT", "The locator matches more than one element.", { ...pageErrorDetails(context, locator.target), matched }),
    { hint: "Narrow the locator or its scope, or select an explicit nth match." },
  );
  if (pinned) return root;
  if (!isRecord(element)) throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Element query returned no selected node.", pageErrorDetails(context));
  const [binding] = await bindElementReferences(id, [element], context, root?.ref, "required");
  context.signal?.throwIfAborted();
  // A disappearing node must not silently become a CSS re-query of its replacement.
  if (!binding?.uid || !Number(binding.backendNodeId)) throw Object.assign(
    new ToolExecutionError("STALE_ELEMENT_UID", "The matched element changed before it could be bound.", { ...pageErrorDetails(context, locator.target), reason: "locator_match_changed" }),
    { hint: "Retry the query before dispatching an action; an explicit UID cannot be retargeted." },
  );
  return resolveElementReference(id, { target: binding.target }, context);
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
  const observationOnly = readOnly === true || isReadOnlyAccess(Number(ref.tabId), context);
  const suffix = (/^t(\d+)\./.exec(requestedUid) || [])[1] || "";
  if (suffix) {
    const listed = taskTabIds(context);
    // A read-only uid may name a tab this session does not own. Check that
    // suffix against the registered tab alone so it cannot collide with an owned tab.
    const candidates = observationOnly
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
      throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", "Element target belongs to a different page. Get a fresh target from this page.", pageErrorDetails(context, elementTargetForUid(requestedUid)));
    }
  }

  const currentSessionId = String(context.sessionId || "").trim();
  const refSessionId = String(ref.sessionId || "").trim();
  if (currentSessionId && refSessionId && currentSessionId !== refSessionId) {
    throw new ToolExecutionError(
      "ELEMENT_UID_SESSION_MISMATCH",
      `Element target belongs to another session. Take a fresh get_ax_tree snapshot in this session, then retry.`,
      pageErrorDetails(context, elementTargetForUid(requestedUid)),
    );
  }

  // Reject an explicit mismatch before resolving ownership can select or claim that tab.
  if (tabId && Number(tabId) !== Number(ref.tabId)) {
    throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", "Element target belongs to a different page. Get a fresh target from this page.", pageErrorDetails(context, elementTargetForUid(requestedUid)));
  }
  const resolvedTabId = Number(ref.tabId);
  if (!Number.isFinite(resolvedTabId) || resolvedTabId <= 0) {
    throw new ToolExecutionError("MISSING_TAB_REF", `Element target has no usable page reference: uid:${requestedUid}`, pageErrorDetails(context, elementTargetForUid(requestedUid)));
  }
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (currentSessionId && typeof sessions?.resolveTargetTab === "function") {
    const target = {
      sessionId: currentSessionId,
      runId: context.runId,
      signal: context.signal,
      tabId: resolvedTabId,
      source: "element_uid_reference",
      checkOnly: context.preserveWorkingTab === true || context.deferToolCommit === true,
      readOnly: observationOnly,
    };
    let resolved = await sessions.resolveTargetTab(target);
    if (resolved?.ok && resolved.claimRequired && !resolved.readOnlyAccess && context.preserveWorkingTab !== true) {
      resolved = await sessions.resolveTargetTab({ ...target, checkOnly: false });
    }
    if (!resolved?.ok) {
      throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
        toolName: "element",
        target: elementTargetForUid(requestedUid),
        reason: resolved?.reason || "",
        message: resolved?.error || "",
      }, context);
    }
    if ((context.preserveWorkingTab || context.deferToolCommit) && resolved.claimRequired && !resolved.readOnlyAccess) {
      throw makeSessionTabTargetError("SESSION_TAB_UNOWNED", {
        toolName: "element", target: elementTargetForUid(requestedUid),
      }, context);
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
  const previousPageError = () => new ToolExecutionError('STALE_ELEMENT_UID_PAGE_CHANGED',
    'Element target belongs to a previous page state. Take a fresh get_ax_tree snapshot, then retry.',
    pageErrorDetails(context, elementTargetForUid(requestedUid)));
  const storedDocumentId = String(ref.documentId || "");
  if (storedDocumentId) {
    const currentDocumentId = await readMainDocumentId(resolvedTabId);
    // A title redirect or history.replaceState keeps the document; a real navigation replaces it.
    if (currentDocumentId && currentDocumentId !== storedDocumentId) {
      if (urlChanged) throw previousPageError();
      throw staleElement(requestedUid);
    }
    // A changed URL string is positive evidence the page changed; only a matching live
    // document disproves it. A missing probe cannot, so the strict verdict stands.
    if (urlChanged && !currentDocumentId) throw previousPageError();
  } else if (urlChanged) throw previousPageError();
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

function assertKnownElementUid(target: unknown) {
  cleanupElementRefs();
  const uid = normalizeElementUid(parseElementTarget(String(target || "")).uid);
  if (!uid || !elementRefRegistry.has(uid)) throw staleElement(target);
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
    return asElementReply(await sendToContent(binding.tabId || tabId, action, { ...params, selector, index }, context), action, context, binding.target);
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
  if (!Number.isInteger(id) || id <= 0) throw new ToolExecutionError("MISSING_TAB_REF", "Element target has no usable page reference", { target: binding.target || "" });
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
      return await run(nodeSend, (action, params = {}) => invokeBound(nodeSend, objectId, action, params, objectGroup, context, binding.target));
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
    if (!objectId) throw staleElement(binding.target || "", "node_unavailable");
    return objectId;
  } catch (err) {
    if (isCdpFallbackForbiddenError(err)) throw err;
    const message = String(record(err).message || err);
    if (/no node with|could not find node|node.*(?:detached|not found)/i.test(message)) throw staleElement(binding.target || "", "node_unavailable");
    if (err instanceof ToolExecutionError) throw err;
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
          && value.extensionId === chrome.runtime.id && value.bridge === true && value.elementRefs === true
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
  if (!id) throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "The page script is not ready to read or interact with this page.", pageErrorDetails(context));
  return id;
}

async function invokeBound(send: CdpCommand, objectId: string, action: string, params: Record<string, unknown>, objectGroup: string, context: ToolContext, target?: string) {
  const finishPhase = context.measurePhase?.("extraction");
  try {
    const remote = record(await send("Runtime.callFunctionOn", {
      objectId, objectGroup, awaitPromise: true, returnByValue: true,
      functionDeclaration: ISOLATED_CONTENT_INVOKE,
      arguments: [{ value: { ...params, action } }],
    }));
    const details = record(remote.exceptionDetails);
    if (details.text || details.exception) {
      throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", String(details.text || "Content script call failed"), pageErrorDetails(context));
    }
    return asElementReply(record(remote.result).value, action, context, target);
  } finally { finishPhase?.(); }
}

function asElementReply(value: unknown, action: string, context: ToolContext = {}, target?: string) {
  const reply = record(value);
  const code = String(reply.code || "");
  if (code === "STALE_ELEMENT_UID" || code === "STALE_ELEMENT_UID_PAGE_CHANGED") {
    throw new ToolExecutionError(code, String(reply.error || code), { ...pageErrorDetails(context, target),
      ...(record(reply.details).reason === "node_unavailable" ? { reason: "node_unavailable" } : {}) });
  }
  if (!isElementReply(reply)) throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED", `Content script returned an invalid response for ${action}`, pageErrorDetails(context));
  return reply;
}

function staleElement(target: unknown, reason = "") {
  const value = String(target || '');
  const handle = /^(uid|css):/.test(value) ? value : value ? `uid:${value}` : undefined;
  return new ToolExecutionError("STALE_ELEMENT_UID", "Element target is stale or unknown. Take a fresh get_ax_tree snapshot, then retry.", { target: handle, ...(reason ? { reason } : {}) });
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
    registerElementBinding,
    bindElementReferences,
    elementTargetForUid,
    elementTargetForSelector,
    elementTargetForRef,
    elementUidTabId,
    assertKnownElementUid,
    isUidElementTarget,
    prepareCssTargets,
    resolveSelectorTarget,
    resolveElementReference,
    resolveLocatorTarget,
    countLocatorMatches,
    findLocatorElements,
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
