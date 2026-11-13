import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import { sameElementGeometry, waitForElementReady } from "./element-readiness.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import { isElementReply, elementLocatorSchema, elementNthSchema, locatorReferences, validateElementLocator, type ElementLocator, type ElementReply } from "#sdk/shared/browser";
import type { SecurityGuardrails } from "#sdk/shared/security";
import type { CdpCommand, ElementTarget, PageState, PreparedNavigation } from "#sdk/background/browser";
import type { ToolContext } from "#sdk/background";
import { bindToolResultPresentation, requireToolFields, toolError, pageWaitTimeout, pollState, runWaitWithTrigger, validateElementInput, waitDelay } from "#sdk/background/tools";
export type { PageState, PreparedNavigation, PageNavigationHost } from "#sdk/background/browser";
type PageElementHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "sendToContent" | "clickPointReady"
  | "clickNotReadyResult" | "sendCdp" | "withDebugger"
  | "getPageContext" | "getTabPageState"
  | "prepareKnownPageNavigation" | "commitObservedPageNavigation"> & Pick<ToolExtensionAPI["element"],
  "resolveSelectorTarget" | "resolveElementReference" | "resolveElementInput" | "resolveLocatorTarget" | "findLocatorElements" | "countLocatorMatches" | "addElementTargetsToFindResult"
  | "elementTargetForSelector" | "elementTargetGrammar" | "getElementTargetDescription" | "useElement" | "readMainDocumentId">;
import { getSecurityGuardrails } from "#sdk/shared/security";
import { waitForParsedDocument, armPageInputReceipt, beginPageNavigationObservation, ensurePageSurface, frameContentOrigin, isCdpFallbackForbiddenError, openChildFrame, pageInputDelivered, readPageInputReceipt } from "#sdk/background/browser";
import { createCdpKeyboard, createCdpTouch } from "#sdk/background/browser";

interface PageViewport { width: number; height: number }
interface FrameOrigin { x: number; y: number }

/** Iframe content scripts report iframe-local points. Shift them by the iframe content origin only at dispatch. */
async function framedPagePoint(send: CdpCommand, point: { x: number; y: number }, frameId: string) {
  if (!frameId) return point;
  const origin = await frameContentOrigin(send, frameId);
  if (!origin) throw new Error("The iframe content origin is unavailable");
  return { x: point.x + origin.x, y: point.y + origin.y };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Root layout viewport in CSS pixels, the same space as Input.dispatchMouseEvent. */
async function readPageViewport(send: CdpCommand): Promise<PageViewport | null> {
  try {
    const metrics = asRecord(await send("Page.getLayoutMetrics"));
    const viewport = asRecord(metrics.cssLayoutViewport || metrics.layoutViewport);
    const width = Number(viewport.clientWidth);
    const height = Number(viewport.clientHeight);
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function readRect(value: unknown): { x: number; y: number; w: number; h: number } | null {
  const box = asRecord(value);
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x, y, w, h };
}

function pointInPageViewport(point: { x: number; y: number } | null | undefined, viewport: PageViewport): boolean {
  return !!point && point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height;
}

function rectInPageViewport(rect: { x: number; y: number; w: number; h: number }, origin: FrameOrigin, viewport: PageViewport) {
  const left = rect.x + origin.x;
  const top = rect.y + origin.y;
  return top + rect.h >= 0 && left + rect.w >= 0 && top <= viewport.height && left <= viewport.width;
}

/**
 * Content scripts measure the iframe document. Callers that trust inViewport need the root page.
 * A mouse point outside that viewport is not delivered to the framed element; dispatch can still
 * hit the root document, so the input receipt must not turn that miss into success.
 */
function applyFramePageViewport(element: ElementReply, origin: FrameOrigin | null, viewport: PageViewport | null): ElementReply {
  if (!element || element.error || !origin || !viewport) return element;
  const rect = readRect(element.rect);
  const local = element.clickablePoint;
  const shifted = local ? { x: local.x + origin.x, y: local.y + origin.y } : null;
  const clickablePointInViewport = pointInPageViewport(shifted, viewport);
  // The click lands at the point. A point inside the page viewport is in view even when a rounded rect misses it.
  const inViewport = clickablePointInViewport || (rect ? rectInPageViewport(rect, origin, viewport) : false);
  element.inViewport = inViewport;
  element.state = { ...(element.state || {}), inViewport, clickablePointInViewport };
  return element;
}

function framePointMissesPage(element: ElementReply, origin: FrameOrigin | null, viewport: PageViewport | null) {
  const point = element.clickablePoint;
  if (!origin || !viewport || !point) return false;
  return !pointInPageViewport({ x: point.x + origin.x, y: point.y + origin.y }, viewport);
}

/** Cross-site iframe input uses that frame's viewport, the same space as the content-script point. */
async function remoteFrameInput(send: CdpCommand, frameId: string): Promise<CdpCommand | null> {
  const opened = await openChildFrame(send, frameId);
  return opened?.sessionId ? opened.send : null;
}

/** Registers page reading, element inspection/action, and scrolling tools. */
export function registerPageElementTools({
  registerTool,
  ToolExecutionError,
  sendToContent: sendContent,
  resolveSelectorTarget,
  resolveElementReference,
  resolveElementInput,
  resolveLocatorTarget,
  findLocatorElements,
  countLocatorMatches,
  useElement,
  readMainDocumentId,
  addElementTargetsToFindResult,
  elementTargetForSelector,
  elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
  getElementTargetDescription,
  getTabPageState,
  prepareKnownPageNavigation,
  commitObservedPageNavigation,
  clickPointReady,
  clickNotReadyResult,
  sendCdp,
  withDebugger,
  getPageContext,
}: PageElementHost) {
async function sendToContent(tabId: number | undefined, action: string, params: Record<string, unknown>, call?: (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, context?: ToolContext): Promise<ElementReply> {
  const result = await (call ? call(action, params) : sendContent(tabId, action, params, context));
  if (!isElementReply(result)) throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED", t("contentScriptReturnedAnInvalidResponse", { action: String(action) }), { action });
  return result;
}
const elementInputChoice = [{ required: ["target"], not: { required: ["locator"] } }, { required: ["locator"], not: { required: ["target"] } }];
function inputNotDelivered(details: Record<string, unknown>) {
  return { ...toolError("INPUT_NOT_DELIVERED", t("inputNotDelivered"), {
    hint: "Use find_elements to refresh the target before retrying the action.",
    details: { ...details, clickDispatched: true, inputDelivered: false },
  }) };
}
async function inputWasDelivered(tabId: number, receiptId = "") {
  // An unreadable receipt is not evidence the input missed the page.
  if (!receiptId) return true;
  const count = await readPageInputReceipt(tabId, receiptId);
  return count == null || count > 0;
}
function scopedSelector(binding: ElementTarget, fallback = "body") {
  const selector = String(binding.selector || "").trim();
  // A uid with no selector must not widen into the whole page.
  if (binding.uid) return selector;
  return selector || fallback;
}
function rethrowStaleElement(err: unknown): void {
  if (err instanceof ToolExecutionError && String(err.code || "").startsWith("STALE_ELEMENT_UID")) throw err;
}
function readBound<T>(binding: ElementTarget, context: ToolContext, fn: (call?: (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>) {
  if (!binding.uid) return fn();
  return useElement(binding.tabId, binding, context, call => fn(call));
}
async function observeElementNavigation(tabId: number, pageBefore: PageState, prepared: PreparedNavigation | null,
  guardrails: SecurityGuardrails, observation: Awaited<ReturnType<typeof beginPageNavigationObservation>>) {
  const { pageBefore: dispatchPage, pageAfter, navigationCommitted, navigationPending } = await observation.finish(pageBefore);
  if (navigationCommitted) commitObservedPageNavigation({ pageBefore: dispatchPage, pageAfter, prepared, guardrails, toolName: "act_on_element", tabId });
  return {
    ...(navigationCommitted ? { navigated: true, url: pageAfter.url } : {}),
    ...(navigationPending ? { navigationPending: true } : {}),
  };
}
const keyboard = createCdpKeyboard({ sendCdp, ToolExecutionError });
const touch = createCdpTouch({ ToolExecutionError });
// ===========================================================================
// Page content
// ===========================================================================

registerTool({
  name: "read_article",
  argumentValueAliases: { source: { selector: "target" } },
  argumentAliases: { selector: "target" },
  behavior: { targetLookup: "light", parallelRead: true, uidTargets: args => locatorReferences(args.locator), timeoutResult: args => args.locator ? undefined : { kind: "read", pending: "article extraction" } },
  get description() { return toolT("readArticleDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"], description: toolT("readArticleTabId") },
      source: { type: "string", enum: ["auto", "selection", "article", "target", "body"], description: toolT("readArticleSource") },
      target: { type: "string", description: toolT("readArticleSelector") },
      locator: elementLocatorSchema,
      offset: { type: "number", description: toolT("readArticleOffset") },
      limit: { type: "number", description: toolT("readArticleLimit") },
    },
    required: ["limit", "tabRef"],
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  validateArgs: args => {
    if (args.locator !== undefined && args.source !== "target") throw new ToolExecutionError("INVALID_ELEMENT_LOCATOR", "Use source: target when reading a locator.");
    if (args.source === "target") validateElementInput(args);
  },
  execute: async ({ tabId, source = "auto", target: selector = "", locator, offset = 0, limit }, _signal, context = {}) => {
    const target = locator ? await resolveElementInput(tabId, { locator }, context)
      : selector ? await resolveSelectorTarget(tabId, selector, 0, context) : { tabId, selector };
    if (!selector && !locator && target.tabId) await waitForParsedDocument(target.tabId, context);
    const mode = source === "target" || (source === "auto" && selector) ? "selector" : source;
    return readBound(target, context, async call => {
      const article = await sendToContent(target.tabId, "readArticle", { source: mode, selector: target.selector, offset, limit }, call, context);
      if (article.error) return { ...toolError(String(article.code || "ARTICLE_READ_FAILED"), String(article.error), {
        hint: "Use find_elements to refresh the target, then retry read_article.", details: 'target' in target ? { target: target.target } : undefined,
      }) };
      const { _display, ...content } = article;
      return bindToolResultPresentation(mode === 'selector' && 'target' in target ? { ...content, target: target.target } : content, { _display });
    });
  },
});

registerTool({
  name: "read_dom",
  argumentAliases: { selector: "target" },
  behavior: { targetLookup: "light", uidTargets: args => locatorReferences(args.locator), timeoutResult: args => args.locator ? undefined : { kind: "read", pending: "DOM extraction" } },
  get description() { return toolT("readDomDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"], description: toolT("readArticleTabId") },
      offset: { type: "number", description: toolT("readDomOffset") },
      limit: { type: "number", description: toolT("readDomLimit") },
      target: { type: "string", description: toolT("readDomSelector") },
      locator: elementLocatorSchema,
    },
    required: ["tabRef"],
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  validateArgs: args => validateElementInput(args, { required: false }),
  execute: async ({ tabId, offset = 1, limit = 200, target: selector = "", locator }, _signal, context = {}) => {
    const target = locator ? await resolveElementInput(tabId, { locator }, context) : await resolveSelectorTarget(tabId, selector || "body", 0, context);
    if (!selector && !locator && target.tabId) await waitForParsedDocument(target.tabId, context);
    return readBound(target, context, async call => {
      const result = await sendToContent(target.tabId, "readDom", { offset, limit, selector: scopedSelector(target) }, call, context);
      if (result.error) return { ...toolError(String(result.code || "DOM_READ_FAILED"), String(result.error), {
        hint: "Use find_elements to refresh the target, then retry read_dom.", details: { target: target.target },
      }) };
      return { ...result, target: target.target };
    });
  },
});

const findElementsAliases = { target: "within", selector: "within", scope: "within" };
const findElementsCompatArgs = ({ waitFor, ...args }: Record<string, unknown>) => waitFor === "match" && args.waitForMatch === undefined ? { ...args, waitForMatch: true } : waitFor === undefined ? args : { ...args, waitFor };
const findElementsBehavior = { parallelRead: true, targetLookup: "openShadow", passiveWait: (args: Readonly<Record<string, unknown>>) => args.waitForMatch === true,
  uidTargets: (args: Readonly<Record<string, unknown>>) => locatorReferences(args.locator),
  timeoutResult: (args: Readonly<Record<string, unknown>>) => args.waitForMatch === true || args.locator ? undefined : { kind: "read" as const, pending: "element scan" } } as const;
const findElementsParameters = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    tabRef: { type: ["integer", "string"], description: toolT("readArticleTabId") },
    name: elementLocatorSchema.properties.name,
    text: elementLocatorSchema.properties.text,
    exact: elementLocatorSchema.properties.exact,
    pattern: { type: "string", description: toolT("findElementsPattern") },
    flags: { type: "string", description: toolT("findElementsFlags") },
    within: { type: "string", description: toolT("findElementsWithin") },
    locator: elementLocatorSchema,
    countOnly: { type: "boolean", description: "With locator, return only the current match count." },
    role: { type: "string", description: toolT("findElementsRole") },
    roles: { type: "array", items: { type: "string" }, description: toolT("findElementsRoles") },
    tag: { type: "string", description: toolT("findElementsTag") },
    tags: { type: "array", items: { type: "string" }, description: toolT("findElementsTags") },
    type: { type: "string", description: toolT("findElementsType") },
    types: { type: "array", items: { type: "string" }, description: toolT("findElementsTypes") },
    limit: { type: "number", description: toolT("findElementsLimit") },
    includeHidden: { type: "boolean", description: toolT("findElementsIncludeHidden") },
    waitForMatch: { type: "boolean", description: toolT("findElementsWaitForMatch") },
    timeout: { type: "number", exclusiveMinimum: 0, maximum: 300, description: toolT("findElementsTimeout") },
  },
  required: ["tabRef"],
} as const);
const findElementsTimeout = (args: Record<string, unknown>) => args.waitForMatch === true ? { ...pageWaitTimeout(args), maxMs: 300000 } : { defaultMs: 30000, maxMs: 300000 };
function validateFindElementsArgs(args: Record<string, unknown>): undefined {
  for (const [single, plural] of [["role", "roles"], ["tag", "tags"], ["type", "types"]]) {
    if (args[single] !== undefined && args[plural] !== undefined) {
      throw toolError("INVALID_ARGUMENTS", toolT("findElementsFilterConflict", { single, plural }),
        { details: { invalidFields: [single, plural] } });
    }
  }
  const literal = ["name", "text", "exact"].filter(key => args[key] !== undefined);
  const regex = ["pattern", "flags"].filter(key => args[key] !== undefined);
  if (literal.length && regex.length) {
    throw toolError("INVALID_ARGUMENTS", toolT("findElementsMatchConflict"), { details: { invalidFields: [...literal, ...regex] } });
  }
  for (const field of ["name", "text"]) {
    if (typeof args[field] === "string" && !args[field].trim()) {
      throw toolError("INVALID_ARGUMENTS", toolT("findElementsEmptyQuery", { field }), { details: { invalidFields: [field] } });
    }
  }
  if (args.locator !== undefined) {
    try { validateElementLocator(args.locator); }
    catch (error) { throw new ToolExecutionError("INVALID_ELEMENT_LOCATOR", String((error as Error).message)); }
    if (["within", "name", "text", "exact", "pattern", "flags", "role", "roles", "tag", "tags", "type", "types", "includeHidden"].some(key => Object.hasOwn(args, key))) {
      throw toolError("INVALID_ARGUMENTS", toolT("findElementsLocatorConflict"));
    }
  } else if (args.countOnly === true) {
    throw new ToolExecutionError("INVALID_ARGUMENTS", "countOnly requires locator.");
  }
}
interface FindElementsInput {
  tabId: number; name?: string; text?: string; exact?: boolean; pattern?: string; flags?: string; within?: string;
  locator?: unknown; countOnly?: boolean; role?: string; roles?: readonly string[]; tag?: string; tags?: readonly string[];
  type?: string; types?: readonly string[]; limit?: number; includeHidden?: boolean; waitForMatch?: boolean; timeout?: number;
}
/** all returns every match as {results}, capped only by an explicit limit; otherwise the find_elements result. */
async function findElements({ tabId, name, text, exact, pattern = "", flags = "i", within: selector = "", locator, countOnly = false, role, roles = [], tag, tags = [], type, types = [], limit, includeHidden = false, waitForMatch = false, timeout = 10 }: FindElementsInput,
  signal: AbortSignal | undefined, context: ToolContext, all: boolean) {
  const waiting = waitForMatch === true;
  if (waiting && pattern) {
    try { new RegExp(pattern, flags); }
    catch { throw Object.assign(new ToolExecutionError("INVALID_REGEX", toolT("findElementsInvalidRegex"), { pattern, flags }),
      { hint: toolT("findElementsInvalidRegexHint") }); }
  }
  const scan = async (observing: ToolContext) => {
    observing.signal?.throwIfAborted();
    if (locator) {
      const query = locator as ElementLocator;
      if (countOnly) {
        const count = await countLocatorMatches(tabId, query, observing);
        observing.signal?.throwIfAborted();
        return waiting && count === 0 ? undefined : { count };
      }
      const { count, results } = await findLocatorElements(tabId, query, observing, Math.max(1, Math.min(100, Number(limit) || 20)));
      observing.signal?.throwIfAborted();
      return waiting && count === 0 ? undefined : { results, total: count, truncated: count > results.length };
    }
    const target = await resolveSelectorTarget(tabId, selector || "body", 0, observing);
    if (!selector && target.tabId) await waitForParsedDocument(target.tabId, observing);
    const result = await readBound(target, observing, call => sendToContent(target.tabId, "findElements", {
      ...Object.fromEntries(Object.entries({ name, text, exact }).filter(([, value]) => value !== undefined)),
      pattern, flags, selector: scopedSelector(target), roles: role === undefined ? roles : [role],
      tags: tag === undefined ? tags : [tag], types: type === undefined ? types : [type], includeHidden,
      ...(all ? { all, ...(limit === undefined ? {} : { limit }) } : { limit: limit ?? 20 }),
    }, call, observing));
    observing.signal?.throwIfAborted();
    if (waiting) {
      if (result.code || result.error) throw result;
      if (!Array.isArray(result.results)) throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", "Invalid element search response.");
      if (!result.results.length) return undefined;
    }
    const { matches, resultTruncated, ...found } = asRecord(await addElementTargetsToFindResult(result, target.tabId, observing, target.ref));
    if (all) return found;
    return Array.isArray(found.results) ? { ...found, total: Number(matches) || found.results.length, truncated: resultTruncated === true } : found;
  };
  if (!waiting) return scan(context);
  return runWaitWithTrigger({ tool: all ? "find_all_elements" : "find_elements", timeoutMs: timeout * 1000, signal, context,
    details: { ...(context.requestedTabRef == null ? {} : { tabRef: context.requestedTabRef }),
      ...(selector ? { within: selector } : {}), ...(pattern ? { pattern } : {}) },
  }, current => {
    const observing = Object.assign(Object.create(context), { signal: current });
    return pollState(current, async () => {
      try { return await scan(observing); }
      catch (error) {
        if (current.aborted || isCdpFallbackForbiddenError(error)) throw error;
        const code = String(asRecord(error).code || "");
        if ((code === "ELEMENT_NOT_FOUND" && !selector.trim().startsWith("uid:"))
          || ["CONTENT_SCRIPT_NOT_READY", "CONTENT_SCRIPT_MESSAGE_FAILED", "EMPTY_CONTENT_RESPONSE"].includes(code)) return undefined;
        throw error;
      }
    });
  });
}

registerTool({
  name: "find_elements",
  argumentAliases: findElementsAliases,
  compatArgs: findElementsCompatArgs,
  behavior: findElementsBehavior,
  get description() { return toolT("findElementsDescription"); },
  get parameters() { return findElementsParameters(); },
  page: "readOnly",
  timeout: findElementsTimeout,
  validateArgs: validateFindElementsArgs,
  execute: (args, signal, context = {}) => findElements(args, signal, context, false),
});

// The script SDK's page.find: the find_elements query without its result limit or count fields.
registerTool({
  name: "find_all_elements",
  hidden: true,
  requires: { tools: ["find_elements"] },
  argumentAliases: findElementsAliases,
  compatArgs: findElementsCompatArgs,
  behavior: findElementsBehavior,
  description: "Return every element matching a find_elements query, in locator nth order, as {results}. limit optionally caps the list.",
  get parameters() {
    const { locator: _locator, countOnly: _countOnly, limit: _limit, ...properties } = findElementsParameters().properties;
    return { type: "object", additionalProperties: false, properties: { ...properties,
      limit: { type: "integer", minimum: 1, description: "Optional maximum number of matches to return." } }, required: ["tabRef"] } as const;
  },
  page: "readOnly",
  timeout: findElementsTimeout,
  validateArgs: args => {
    if (args.limit !== undefined && !(Number.isInteger(args.limit) && Number(args.limit) >= 1)) {
      throw toolError("INVALID_ARGUMENTS", toolT("findAllElementsLimit"), { details: { invalidFields: ["limit"] } });
    }
    return validateFindElementsArgs(args);
  },
  execute: (args, signal, context = {}) => findElements(args, signal, context, true),
});

registerTool({
  name: "inspect_element",
  argumentAliases: { selector: "target", index: "nth" },
  behavior: { targetLookup: "light", uidTargets: args => locatorReferences(args.locator), timeoutResult: args => args.locator ? undefined : { kind: "read", pending: "element inspection" } },
  get description() { return toolT("inspectElementDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"], description: toolT("readArticleTabId") },
      target: { type: "string", description: getElementTargetDescription() },
      locator: elementLocatorSchema,
      nth: elementNthSchema,
    },
    required: ["tabRef"], oneOf: elementInputChoice,
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  validateArgs: args => validateElementInput(args),
  execute: async ({ tabId, target = "", locator, nth = 0 }, _signal, context = {}) => {
    const ref = await resolveElementInput(tabId, { target, locator, nth }, context);
    return readBound(ref, context, async call => {
      const inspection = await sendToContent(ref.tabId, "inspectElement", { selector: ref.selector, index: ref.index }, call, context);
      const frameId = String(ref.ref?.frameId || "");
      if (frameId && ref.tabId && !inspection.error) {
        try {
          await withDebugger(ref.tabId, async (_target, send) => {
            applyFramePageViewport(inspection, await frameContentOrigin(send, frameId), await readPageViewport(send));
          }, context);
        } catch (error) {
          if (isCdpFallbackForbiddenError(error)) throw error;
        }
      }
      const result = await addElementTargetsToFindResult({ ...inspection, selector: inspection?.selector || ref.selector }, ref.tabId, context, ref.ref);
      return result;
    });
  },
});

// ===========================================================================
// Page interaction
// ===========================================================================

registerTool({
  name: "act_on_element",
  argumentAliases: { selector: "target", index: "nth" },
  compatArgs: args => args.action === "press" && args.key === undefined && typeof args.value === "string"
    ? Object.fromEntries(Object.entries({ ...args, key: args.value }).filter(([field]) => field !== "value")) : args,
  behavior: { targetLookup: "light", parallelTab: true,
    uidTargets: args => [args.target, ...locatorReferences(args.locator), ...(args.action === "drag"
      ? [asRecord(args.destination).target, ...locatorReferences(asRecord(args.destination).locator)] : [])],
    mayOpenPopup: true, reportsExecution: true, timeoutResult: { kind: "action", pending: "action outcome confirmation" }, mayUnloadPage: args => {
    const action = String(args.action || "").trim().toLowerCase();
    const key = String(args.key || args.value || "").trim().toLowerCase();
    return ["click", "double_click", "drag"].includes(action) || (action === "fill" && args.submit === true)
      || (action === "press" && ["enter", "return", "space"].includes(key));
  } },
  effects: (_args, result) => result && typeof result === "object" && "navigated" in result && result.navigated === true
    ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("actOnElementDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"], description: toolT("readArticleTabId") },
      target: { type: "string", description: getElementTargetDescription() },
      locator: elementLocatorSchema,
      nth: elementNthSchema,
      action: { type: "string", enum: ["click", "double_click", "hover", "drag", "fill", "press", "select", "check", "uncheck", "scroll"] },
      destination: { type: "object", properties: { target: { type: "string", description: getElementTargetDescription() }, locator: elementLocatorSchema }, oneOf: elementInputChoice, description: toolT("actOnElementDestination") },
      value: { type: "string", description: toolT("actOnElementValue") },
      key: { type: "string", description: toolT("actOnElementKey") },
      submit: { type: "boolean", description: toolT("actOnElementSubmit") },
    },
    required: ["action", "tabRef"], oneOf: elementInputChoice,
  } as const; },
  page: "owned",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  validateArgs: args => {
    validateElementInput(args);
    if (args.action === "drag") {
      requireToolFields("act_on_element", args, ["destination"], { action: "drag" });
      validateElementInput(asRecord(args.destination));
    }
    const field = args.action === "fill" || args.action === "select" ? "value" : args.action === "press" ? "key" : "";
    if (field && typeof args[field] !== "string") {
      throw toolError("MISSING_REQUIRED_ARGUMENTS", toolT("actOnElementMissingField", { action: String(args.action), field }),
        { details: { missing: [field], action: args.action } });
    }
  },
  execute: async (input, _signal, context = {}) => {
    let { tabId, target = "", nth: index = 0, action, destination, value = "", key = "", submit = false } = input;
    const locator = input.locator, requestedTabId = tabId, requestedIndex = index;
    let actionDispatched = false;
    const timeout = Number(asRecord(input).timeout);
    const requestedTimeoutMs = timeout > 0 ? Math.min(timeout * 1000, 120000)
      : Number(input.timeoutMs) > 0 ? Math.min(Number(input.timeoutMs), 120000) : undefined;
    const startedAt = Date.now();
    const deadline = context.deadlineAt ?? startedAt + (requestedTimeoutMs ?? 20000);
    const readinessDeadline = !locator && !destination?.locator && requestedTimeoutMs === undefined ? Math.min(deadline, startedAt + 5000) : deadline;
    const dispatchedAction = () => { actionDispatched = true; context.operation?.dispatch(); };
    const normalizedAction = String(action || "").trim().toLowerCase();
    const allowed = new Set(["click", "double_click", "hover", "drag", "fill", "press", "select", "check", "uncheck", "scroll"]);
    if (!allowed.has(normalizedAction)) {
      return { ...toolError("UNSUPPORTED_ELEMENT_ACTION", `Unsupported act_on_element action: ${action}`, {
        hint: "Use click, double_click, hover, drag, fill, press, select, check, uncheck, or scroll.", details: { target },
      }) };
    }

    const dynamicQuery = (query?: ElementLocator) => query && !/^uid:/i.test(String(query.target || ""));
    const queryBindings = new Set<string>();
    const retryable = (error: unknown) => {
      const failure = asRecord(error), details = asRecord(failure.details);
      return !actionDispatched && failure.code === "STALE_ELEMENT_UID" && details.reason === "node_unavailable"
        && typeof details.target === "string" && queryBindings.has(details.target);
    };
    const locateForAction = async (query: ElementLocator) => {
      for (;;) {
        _signal?.throwIfAborted();
        if (Date.now() >= deadline) throw Object.assign(new ToolExecutionError("ELEMENT_NOT_READY", "The locator did not become ready before the action deadline."), {
          hint: "Inspect the page and refine the locator or timeout before retrying.",
        });
        try {
          const ref = await resolveLocatorTarget(requestedTabId, query, context);
          if (ref) {
            if (dynamicQuery(query) && ref.target) queryBindings.add(ref.target);
            return ref;
          }
        } catch (error) {
          const failure = asRecord(error);
          if (!dynamicQuery(query) || actionDispatched || failure.code !== "STALE_ELEMENT_UID"
            || asRecord(failure.details).reason !== "locator_match_changed") throw error;
        }
        await waitDelay(Math.min(50, Math.max(0, deadline - Date.now())), _signal);
      }
    };
    for (;;) {
      _signal?.throwIfAborted();
      if (Date.now() >= deadline) throw Object.assign(new ToolExecutionError("ELEMENT_NOT_READY", "The locator did not become ready before the action deadline."), {
        hint: "Inspect the page and refine the locator or timeout before retrying.",
      });
      // Scope/reference errors are not retries: only a query's newly selected node may be replaced.
      queryBindings.clear();
      const ref = locator ? await locateForAction(locator)
        : await resolveElementReference(requestedTabId, { target, index: requestedIndex }, context);
      if (ref) {
        try {
          const result = await performBound(ref);
          if (!retryable(result)) return result;
        } catch (error) { if (!retryable(error)) throw error; }
      }
      await waitDelay(Math.min(50, Math.max(0, deadline - Date.now())), _signal);
    }
    async function performBound(ref: ElementTarget) {
    const selector = ref.selector;
    index = ref.index ?? 0;
    const resolvedTarget = ref.target || elementTargetForSelector(selector);
    if (!ref.tabId) throw new ToolExecutionError("TAB_REF_REQUIRED", "Pass tabRef for the page containing the element.", { target: resolvedTarget });
    tabId = ref.tabId;
    const toolArgsForUpdates = { tabId, ...(locator ? { locator } : { target }), index, action, value, key, submit };
    let bound: ((action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
    const fillToken = normalizedAction === "fill" && ref.uid
      ? `${ref.uid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}` : "";
    if (ref.uid) {
      return useElement(tabId, ref, context, async call => {
        bound = (actionName, params = {}) => call(actionName, normalizedAction === "fill" ? { ...params, editingHost: true, fillToken } : params);
        try {
          return await perform();
        } finally {
          if (fillToken && Number(ref.ref?.backendNodeId || 0) > 0) {
            try { await call("releaseFillRoot", { fillToken }); }
            catch { /* A missed release must not change the fill result. */ }
          }
          bound = undefined;
        }
      });
    }
    return perform();
    async function perform() {
    const frameId = String(ref.ref?.frameId || "");

    const inspect = (clickTarget = false) => sendToContent(tabId, "inspectElement", { selector, index, ...(clickTarget ? { clickTarget } : {}) }, bound, context);
    const readReadiness = (params: Record<string, unknown> = {}) => sendToContent(tabId, "readElementReadiness", { selector, index, ...params }, bound, context);
    const ready = await waitForElementReady({ inspect: readReadiness, target: resolvedTarget, signal: _signal, deadline: readinessDeadline,
      readiness: element => {
        if (normalizedAction === "scroll" || normalizedAction === "hover") return;
        if (element.disabled === true) return "element is disabled";
        if (["fill", "press"].includes(normalizedAction) && element.visible === false) return "element is hidden";
        if (normalizedAction === "fill" && element.editable !== false && element.type !== "file") {
          if (element.readOnly === true) return "element is readonly";
        }
      },
    });
    if (ready.error) return withElementActionHelp(ready, normalizedAction, resolvedTarget);
    const inspected = await inspect();
    if (inspected.error) return withElementActionHelp(inspected, normalizedAction, resolvedTarget);
    const complete = async (navigation: Record<string, unknown> = {}, fill?: unknown, uncertain = false) => {
      const richText = asRecord(asRecord(fill).richText);
      if (!uncertain && !richText.warning) context.operation?.confirm();
      const popups = await context.observedPopups?.();
      return bindToolResultPresentation({ ...navigation, ...(popups?.length ? { popups } : {}), ...(uncertain || richText.warning ? {
        confirmationRequired: true, hint: "Verify the editor saved the value before continuing.",
      } : {}) }, {
        _display: { elementAction: {
          element: { role: inspected.role, name: inspected.name, text: inspected.text },
          structure: richText.structure || asRecord(fill).structure,
        } },
      });
    };

    let pointerDocument: string | undefined;
    const checkPointerDocument = async () => {
      if (_signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("elementActionCancelled"), { target: resolvedTarget });
      const current = await readMainDocumentId?.(tabId);
      if (pointerDocument && current !== pointerDocument) throw new ToolExecutionError("STALE_ELEMENT_UID", "The page changed during pointer preparation.", { target: resolvedTarget });
      pointerDocument ??= current || "";
    };
    const pointerObservation = async (send: CdpCommand, read: () => Promise<ElementReply>, frame = frameId) => {
      const current = await read();
      if (current.error || !frame) return current;
      const origin = await frameContentOrigin(send, frame), viewport = await readPageViewport(send);
      const observed = applyFramePageViewport({ ...current }, origin, viewport);
      if (!origin) throw new ToolExecutionError("ELEMENT_NOT_READY", "The iframe position is unavailable.", { target: resolvedTarget });
      const rect = readRect(current.rect), point = current.clickablePoint;
      return { ...observed, ...(rect ? { rect: { ...rect, x: rect.x + origin.x, y: rect.y + origin.y } } : {}),
        clickablePoint: point ? { x: point.x + origin.x, y: point.y + origin.y } : null };
    };
    const preparePointer = (send: CdpCommand, read: () => Promise<ElementReply>, frame = frameId, move = true, hover = false) => {
      const observe = () => pointerObservation(send, read, frame);
      // Pointer acknowledgement can take seconds in a background tab;
      // it shares the remaining action deadline, including the final readiness check.
      return waitForElementReady({ inspect: observe, target: resolvedTarget, signal: _signal, deadline, stable: true,
        readiness: element => clickPointReady(hover ? { ...element, disabled: false } : element) ? undefined : "element is hidden, disabled, or obscured",
        ...(move ? { confirm: async (element: ElementReply) => {
          await checkPointerDocument();
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...element.clickablePoint!, button: "none", buttons: 0 });
          const confirmed = await observe();
          await checkPointerDocument();
          return confirmed;
        } } : {}),
      });
    };

    if (["hover", "double_click", "drag"].includes(normalizedAction)) {
      const endRef = normalizedAction === "drag"
        ? destination?.locator ? await locateForAction(destination.locator)
          : await resolveElementReference(tabId, { target: destination?.target || "", index: 0 }, context) : null;
      if (endRef && endRef.tabId !== tabId) throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", "Drag targets must belong to the same page.", { target: endRef.target });
      const pointerReady = (element: ElementReply) => clickPointReady(normalizedAction === "hover" ? { ...element, disabled: false } : element);
      const withDestination = <T>(run: (call?: typeof bound) => Promise<T>) => endRef ? readBound(endRef, context, run) : run();
      return withDestination(async endCall => withDebugger(tabId, async (_target, send) => {
        const sourceFrame = String(ref.ref?.frameId || "");
        const endFrame = String(endRef?.ref?.frameId || "");
        const point = async (binding: ElementTarget, call: typeof bound, prepare = true) => {
          const frame = String(binding.ref?.frameId || "");
          const params = { selector: binding.selector, index: binding.index || 0 };
          const element = await waitForElementReady({
            inspect: () => sendToContent(tabId, "readElementReadiness", params, call, context),
            ...(prepare ? { prepare: (current: ElementReply) => pointerReady(current) ? Promise.resolve(current)
              : sendToContent(tabId, "scrollElementIntoView", { ...params, block: "center" }, call, context) } : {}),
            readiness: current => pointerReady(current) ? undefined : "element is hidden, disabled, or obscured",
            target: binding.target || resolvedTarget, signal: _signal, deadline: readinessDeadline, stable: true,
          });
          if (element.error) throw Object.assign(new ToolExecutionError(String(element.code || "ELEMENT_NOT_READY"), String(element.error), { target: binding.target }), { hint: "Observe the element again before retrying." });
          const position = await framedPagePoint(send, element.clickablePoint!, frame);
          const viewport = await readPageViewport(send);
          if (viewport && !pointInPageViewport(position, viewport)) throw Object.assign(new ToolExecutionError("CLICK_POINT_OUT_OF_VIEWPORT", "The element is outside the page viewport.", { target: binding.target }), { hint: "Bring the containing iframe and element into view before retrying." });
          return position;
        };
        await ensurePageSurface(tabId, send, { frameId: sourceFrame });
        if (endRef) {
          await ensurePageSurface(tabId, send, { frameId: endFrame });
          await point(endRef, endCall);
        }
        let start = await point(ref, bound);
        let end = start;
        const check = async () => {
          await checkPointerDocument();
          // Keep using the captured node objects; an iframe can navigate without changing the main document.
          for (const [binding, call] of [[ref, bound], [endRef, endCall]] as const) {
            if (!binding || !call) continue;
            const presence = await call("elementPresence", { visibleOnly: false, queryOnly: true });
            if (presence.found !== true) throw new ToolExecutionError("STALE_ELEMENT_UID", "The element changed during the pointer action.", { target: binding.target, mayHaveTakenEffect: true });
          }
        };
        const pageBefore = await getTabPageState(tabId);
        const guardrails = await getSecurityGuardrails();
        const prepared = normalizedAction === "double_click" ? await prepareKnownPageNavigation({
          url: inspected.href || "", pageBefore, guardrails, context, signal: _signal,
          toolName: "act_on_element", toolArgs: toolArgsForUpdates, tabId, source: "href",
        }) : null;
        const observation = normalizedAction === "hover" ? null : await beginPageNavigationObservation(tabId, _signal, { deadlineAt: deadline });
        let held = false;
        const mouse = async (type: string, position: { x: number; y: number }, clickCount = 1) => {
          await check();
          return send("Input.dispatchMouseEvent", { type, ...position,
            button: type === "mouseMoved" && !held ? "none" : "left", buttons: type === "mouseReleased" ? 0 : held ? 1 : 0, clickCount });
        };
        try {
          let preparedPointer: ElementReply;
          for (;;) {
            preparedPointer = await preparePointer(send, readReadiness, sourceFrame, normalizedAction !== "hover", normalizedAction === "hover");
            if (preparedPointer.error) return withElementActionHelp(preparedPointer, normalizedAction, resolvedTarget);
            if (!endRef) break;
            // Waiting for the destination must not leave a stale source point before the first press.
            end = await point(endRef, endCall, false);
            const current = await pointerObservation(send, readReadiness, sourceFrame);
            if (!current.error && pointerReady(current) && sameElementGeometry(preparedPointer, current)) break;
          }
          start = preparedPointer.clickablePoint!;
          if (normalizedAction === "hover") { dispatchedAction(); await mouse("mouseMoved", start); }
          if (normalizedAction === "double_click") {
            for (const clickCount of [1, 2]) {
              if (clickCount === 2) {
                const current = await pointerObservation(send, readReadiness, sourceFrame);
                if (current.error || !pointerReady(current) || !sameElementGeometry(preparedPointer, current)) {
                  throw new ToolExecutionError("ELEMENT_NOT_READY", "The element changed after the first click.", { target: resolvedTarget, mayHaveTakenEffect: true });
                }
              }
              dispatchedAction();
              held = true;
              await mouse("mousePressed", start, clickCount);
              await mouse("mouseReleased", start, clickCount);
              held = false;
            }
          } else if (normalizedAction === "drag") {
            dispatchedAction();
            held = true;
            await mouse("mousePressed", start);
            for (let step = 1; step <= 8; step++) await mouse("mouseMoved", {
              x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8,
            });
            await mouse("mouseReleased", end);
            held = false;
          }
          context.operation?.confirm();
          return complete(observation ? await observeElementNavigation(tabId, pageBefore, prepared, guardrails, observation) : {});
        } finally {
          if (held) {
            try {
              if (send.cancelPointer) await send.cancelPointer();
              else await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: -1, y: -1, button: "left", buttons: 0, clickCount: 1 });
            } catch { /* The original connection may already have been released. */ }
          }
          observation?.dispose();
        }
      }, context));
    }

    if (normalizedAction === "click") {
      const pageBefore = await getTabPageState(tabId);
      const securityGuardrails = await getSecurityGuardrails();
      let current = inspected;
      let pointSelector = selector;
      let pointIndex = index;
      let resolved: ElementReply | null = null;

      if (!clickPointReady(current)) {
        const scrolled = await sendToContent(tabId, "scrollElementIntoView", { selector, index, block: "center" }, bound, context);
        if (scrolled.error) return withElementActionHelp(scrolled, normalizedAction, resolvedTarget);
        current = scrolled;
      }

      if (!clickPointReady(current)) {
        resolved = await sendToContent(tabId, "resolveClickTarget", { selector, index }, bound, context);
        if (resolved.error && !["NO_CLICKABLE_TARGET", "ELEMENT_NOT_FOUND"].includes(String(resolved.code))) return withElementActionHelp(resolved, normalizedAction, resolvedTarget);
        if (resolved.resolvedSelector) {
          const resolvedInspection = await sendToContent(tabId, "scrollElementIntoView", {
            selector,
            index,
            clickTarget: true,
            block: "center",
          }, bound, context);
          if (!resolvedInspection.error) {
            current = resolvedInspection;
            pointSelector = resolved.resolvedSelector;
            pointIndex = 0;
          }
        } else if (resolved.clickablePoint) {
          current = {
            ...current,
            clickablePoint: resolved.clickablePoint,
            href: resolved.href || current.href,
          };
        }
      }

      const preparedNavigation = await prepareKnownPageNavigation({
        url: current.href || resolved?.href || "",
        pageBefore,
        guardrails: securityGuardrails,
        context,
        signal: _signal,
        toolName: "act_on_element",
        toolArgs: toolArgsForUpdates,
        tabId,
        source: "href",
      });
      let observation: Awaited<ReturnType<typeof beginPageNavigationObservation>> | undefined;
      let touchInput = false;
      let receiptId = "";
      let dispatched = false;
      let frameFailure: ElementReply | null = null;
      let frameViewportBlocked = false;
      let movedFrameIntoPage = false;
      try {
        await withDebugger(tabId, async (_target, send) => {
          await ensurePageSurface(tabId, send, { frameId });
          const sameTarget = pointSelector === selector && pointIndex === index;
          const refreshed = await waitForElementReady({ inspect: () => readReadiness(!sameTarget ? { clickTarget: true } : {}), target: resolvedTarget,
            signal: _signal, deadline: readinessDeadline, stable: true,
            prepare: element => clickPointReady(element) ? Promise.resolve(element)
              : sendToContent(tabId, "scrollElementIntoView", { selector, index, block: "center", ...(!sameTarget ? { clickTarget: true } : {}) }, bound, context),
            readiness: element => clickPointReady(element) ? undefined : "element is hidden, disabled, or obscured",
          });
          if (refreshed.error) { frameFailure = refreshed; return; }
          current = refreshed;
          if (frameId) {
            const readGeometry = async () => ({
              origin: await frameContentOrigin(send, frameId),
              viewport: await readPageViewport(send),
            });
            let geometry = await readGeometry();
            // Retain the pre-scroll geometry while preparing the frame for dispatch.
            applyFramePageViewport(inspected, geometry.origin, geometry.viewport);
            applyFramePageViewport(current, geometry.origin, geometry.viewport);
            if (framePointMissesPage(current, geometry.origin, geometry.viewport)) {
              const scrolled = await sendToContent(tabId, "scrollElementIntoView", { selector, index,
                ...(pointSelector !== selector || pointIndex !== index ? { clickTarget: true } : {}), block: "center" }, bound, context);
              if (scrolled.error) { frameFailure = scrolled; return; }
              current = scrolled;
              movedFrameIntoPage = true;
              geometry = await readGeometry();
              applyFramePageViewport(current, geometry.origin, geometry.viewport);
            }
            if (framePointMissesPage(current, geometry.origin, geometry.viewport)) {
              frameViewportBlocked = true;
              return;
            }
          }
          if (!clickPointReady(current)) return;
          // The preparatory capture can run while this frame is still outside the page viewport.
          if (movedFrameIntoPage) await ensurePageSurface(tabId, send, { frameId });
          const point = await framedPagePoint(send, current.clickablePoint, frameId);
          if (frameId) {
            const viewport = await readPageViewport(send);
            if (viewport && !pointInPageViewport(point, viewport)) {
              current.inViewport = false;
              current.state = { ...(current.state || {}), inViewport: false, clickablePointInViewport: false };
              frameViewportBlocked = true;
              return;
            }
          }
          const localPoint = current.clickablePoint;
          const remoteSend = movedFrameIntoPage && localPoint ? await remoteFrameInput(send, frameId) : null;
          const dispatchSend = remoteSend || send;
          touchInput = getPageContext(tabId).pageMode === "mobile";
          receiptId = await armPageInputReceipt(tabId, { observeSubmission: true });
          observation = await beginPageNavigationObservation(tabId, _signal, { deadlineAt: deadline });
          const confirmed = await preparePointer(send, async () => {
            current = await readReadiness(!sameTarget ? { clickTarget: true } : {});
            return current;
          }, frameId, !touchInput);
          if (confirmed.error) { frameFailure = confirmed; return; }
          const dispatchPoint = remoteSend ? current.clickablePoint! : confirmed.clickablePoint!;
          if (_signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("elementActionCancelled"), { target: resolvedTarget });
          dispatched = true;
          dispatchedAction();
          if (touchInput) { await touch(dispatchSend, dispatchPoint, { signal: _signal }); }
          else {
            await dispatchSend("Input.dispatchMouseEvent", {
              type: "mousePressed", x: dispatchPoint.x, y: dispatchPoint.y, button: "left", clickCount: 1,
            });
            await dispatchSend("Input.dispatchMouseEvent", {
              type: "mouseReleased", x: dispatchPoint.x, y: dispatchPoint.y, button: "left", clickCount: 1,
            });
          }
          context.operation?.confirm();
        }, context);
        if (frameFailure) return withElementActionHelp(frameFailure, normalizedAction, resolvedTarget);
        if (frameViewportBlocked || !clickPointReady(current)) {
          return clickNotReadyResult({
            target: resolvedTarget,
            selector,
            index,
            inspection: current,
            originalInspection: inspected,
            resolved,
          });
        }
        // Default actions can submit or navigate even when an earlier page listener
        // hid every pointer event. Keep the receipt alive through this bounded observation.
        const navigation = await observeElementNavigation(tabId, pageBefore, preparedNavigation, securityGuardrails, observation!);
        const receipt = receiptId ? await readPageInputReceipt(tabId, receiptId) : null;
        receiptId = "";
        if (_signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("elementActionCancelled"), { target: resolvedTarget });
        if (!pageInputDelivered({ receipt, committed: navigation.navigated === true })) {
          return inputNotDelivered({ action: "click", target: resolvedTarget, nth: index });
        }
        return complete(navigation);
      } catch (err) {
        rethrowStaleElement(err);
        if (_signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("elementActionCancelled"), { target: resolvedTarget });
        if (frameId || dispatched || touchInput || asRecord(err).code === "ELEMENT_NOT_READY" || isCdpFallbackForbiddenError(err)) throw err;
        observation ??= await beginPageNavigationObservation(tabId, _signal, { deadlineAt: deadline });
        dispatchedAction();
        const fallback = await sendToContent(tabId, "actOnElement", { selector, index, elementAction: normalizedAction, value, key, submit }, bound, context);
        if (fallback.error) return withElementActionHelp(fallback, normalizedAction, resolvedTarget);
        context.operation?.confirm();
        return complete(await observeElementNavigation(tabId, pageBefore, preparedNavigation, securityGuardrails, observation));
      } finally {
        observation?.dispose();
        if (receiptId) await readPageInputReceipt(tabId, receiptId);
      }
    }

    const identity = { action: normalizedAction, target: resolvedTarget, nth: index };
    const assertActive = () => {
      if (_signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("elementActionCancelled"), identity);
    };
    if (normalizedAction === "fill") {
      assertActive();
      const pageBefore = submit ? await getTabPageState(tabId) : null;
      const guardrails = submit ? await getSecurityGuardrails() : null;
      return withDebugger(tabId, async (_target, send): Promise<Record<string, unknown>> => {
        assertActive();
        // Hidden Chrome tabs may accept insertText without a composited keyboard
        // input surface. Prepare it without activating the tab or clicking the field.
        if (submit) await ensurePageSurface(tabId, send, { frameId });
        dispatchedAction();
        const prepared = await sendToContent(tabId, "prepareElementFill", { selector, index, value,
          ...(submit ? { submit } : {}) }, bound, context);
        assertActive();
        if (prepared.error) return withElementActionHelp(prepared, normalizedAction, resolvedTarget);
        if (typeof prepared.expectedValue !== "string" || typeof prepared._elementRef !== "string") throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED",
          t("contentScriptReturnedAnInvalidResponse", { action: "prepareElementFill" }));
        const expectedValue = prepared.expectedValue;
        // Preparation may resolve an inherited contenteditable child to its editing host.
        const field = { ...(prepared.selector ? { selector: prepared.selector, index: 0 } : { selector, index }),
          elementRefs: [prepared._elementRef] };
        const focused = await sendToContent(tabId, "verifyElementFocus", { elementRefs: field.elementRefs, retainRef: true }, bound, context);
        assertActive();
        if (focused.error) return withElementActionHelp(focused, normalizedAction, resolvedTarget);
        const textInput = prepared.fillMode === "text";
        const inputKeyboard = createCdpKeyboard({ ToolExecutionError, sendCdp: (_tabId, method, params) => {
          if (params.type !== "keyUp") assertActive();
          return send(method, params);
        } });
        let fill: unknown;
        if (textInput) {
          assertActive();
          if (expectedValue) await send("Input.insertText", { text: expectedValue });
          else await inputKeyboard.press(tabId, "Backspace", context);
          assertActive();
        } else {
          // Rich-text paragraphs and non-keyboard fields retain their specialized writer.
          const result = await sendToContent(tabId, "actOnElement", { ...field, elementAction: "fill", value: expectedValue, submit: false }, bound, context);
          if (result.error) return withElementActionHelp(result, normalizedAction, resolvedTarget);
          fill = result.fill;
        }
        const observation = submit ? await beginPageNavigationObservation(tabId, _signal, { deadlineAt: deadline }) : null;
        try {
          assertActive();
          const actual = await sendToContent(tabId, "readElementActionState", { ...field, value: expectedValue, retainRef: submit }, bound, context);
          assertActive();
          if (actual.error) return withElementActionHelp(actual, normalizedAction, resolvedTarget);
          if (actual.valueMatches !== true && actual.valueMatches !== null) return { ...toolError("ELEMENT_VALUE_MISMATCH", t("elementValueMismatch"), {
            hint: "Inspect the target and verify its current value before retrying.", details: { ...identity, value: actual.value, submitDispatched: false },
          }) };
          if (actual.valueMatches === null || asRecord(asRecord(fill).richText).warning) return complete({}, fill, true);
          if (submit) {
            if (!actual.focused) return { ...toolError("ELEMENT_FOCUS_FAILED", t("elementFocusLost"), {
              hint: "Inspect the target and restore focus before submitting.", details: { ...identity, filled: true, value: actual.value, submitDispatched: false },
            }) };
            const confirmed = await sendToContent(tabId, "verifyElementFocus", { elementRefs: field.elementRefs }, bound, context);
            assertActive();
            if (confirmed.error) return withElementActionHelp(confirmed, normalizedAction, resolvedTarget);
            // Enter preserves page key handlers and native form validation. Never replay after a CDP failure.
            await inputKeyboard.press(tabId, "Enter", context);
            assertActive();
          }
          context.operation?.confirm();
          const navigation = pageBefore && guardrails && observation
            ? await observeElementNavigation(tabId, pageBefore, null, guardrails, observation) : null;
          assertActive();
          return complete(navigation || {}, fill);
        } finally { observation?.dispose(); }
      }, context);
    }

    if (normalizedAction === "check" || normalizedAction === "uncheck") {
      assertActive();
      const desired = normalizedAction === "check";
      if (inspected.tag !== "input" || !["checkbox", "radio"].includes(String(inspected.type))) {
        return { ...toolError("NOT_CHECKABLE_ELEMENT", t("elementNotCheckable"), { hint: "Use find_elements to choose a checkbox or radio target.", details: identity }) };
      }
      if (inspected.checked === desired) return complete();
      if (inspected.type === "radio" && !desired) {
        return { ...toolError("ELEMENT_CHECK_STATE_MISMATCH", t("radioCannotBeUnchecked"), { hint: "Select another radio option to change this group.", details: identity }) };
      }
      return withDebugger(tabId, async (_target, send): Promise<Record<string, unknown>> => {
        assertActive();
        await ensurePageSurface(tabId, send, { frameId });
        let prepared = false;
        let current: ElementReply = inspected;
        const readCheck = async () => {
          const candidate = prepared ? await readReadiness({ elementAction: normalizedAction })
            : await sendToContent(tabId, "resolveCheckTarget", { selector, index }, bound, context);
          prepared = true;
          if (candidate.code === "ELEMENT_DISABLED") return { disabled: true };
          current = candidate;
          return !candidate.disabled && isElementReply(candidate.element) ? candidate.element : candidate;
        };
        const confirmed = await preparePointer(send, readCheck, frameId, getPageContext(tabId).pageMode !== "mobile");
        assertActive();
        if (confirmed.error) return withElementActionHelp(confirmed, normalizedAction, resolvedTarget);
        if (current.tag !== "input" || current.type !== inspected.type) {
          return { ...toolError("NOT_CHECKABLE_ELEMENT", t("elementNotCheckable"), { hint: "Use find_elements to choose a checkbox or radio target.", details: identity }) };
        }
        if (current.checked === desired) return complete();
        const clickTarget = !current.disabled && isElementReply(current.element) ? current.element : current;
        if (!clickPointReady(clickTarget)) return clickNotReadyResult({ target: resolvedTarget, selector, index,
          inspection: clickTarget, originalInspection: current, resolved: null }) as Record<string, unknown>;
        const point = confirmed.clickablePoint!;
        const receiptId = await armPageInputReceipt(tabId);
        let delivered = false;
        try {
          dispatchedAction();
          if (getPageContext(tabId).pageMode === "mobile") {
            await touch(send, point, { signal: _signal });
          } else {
            let released = false;
            try {
              await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
              assertActive();
              await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
              released = true;
            } finally {
              if (!released) {
                // Release a possibly held button outside the control without completing its click.
                try {
                  if (send.cancelPointer) await send.cancelPointer();
                  else await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: -1, y: -1, button: "left", clickCount: 1 });
                } catch { /* The run may have lost its lease. */ }
              }
            }
          }
        } finally { delivered = await inputWasDelivered(tabId, receiptId); }
        assertActive();
        if (!delivered) return inputNotDelivered(identity);
        const actual = await sendToContent(tabId, "readElementActionState", { selector, index }, bound, context);
        assertActive();
        if (actual.error) return withElementActionHelp(actual, normalizedAction, resolvedTarget);
        if (actual.tag !== "input" || actual.type !== inspected.type || actual.checked !== desired) return { ...toolError("ELEMENT_CHECK_STATE_MISMATCH", t("elementCheckStateMismatch"), {
          hint: "Inspect the target’s checked state before retrying.", details: { ...identity, checked: actual.checked },
        }) };
        return complete();
      }, context);
    }

    if (normalizedAction === "press") {
      const pressedKey = key || value;
      if (!pressedKey) return { ...toolError("MISSING_KEY", "key is required for press action", {
        hint: "Pass key, for example Enter, Escape, or Tab.", details: { target: resolvedTarget },
      }) };
      const preparedKey = keyboard.normalize(pressedKey);
      const observeNavigation = preparedKey.key === "Enter" && preparedKey.modifiers === 0;
      const pageBefore = observeNavigation ? await getTabPageState(tabId) : null;
      const guardrails = observeNavigation ? await getSecurityGuardrails() : null;
      let observation: Awaited<ReturnType<typeof beginPageNavigationObservation>> | undefined;
      const startObservation = async () => {
        observation ??= await beginPageNavigationObservation(tabId!, _signal, { deadlineAt: deadline });
        assertActive();
      };
      const finishPress = async () => complete(pageBefore && guardrails && observation
        ? await observeElementNavigation(tabId!, pageBefore, null, guardrails, observation) : {});
      try {
        return await withDebugger(tabId, async (_target, send) => {
          await ensurePageSurface(tabId, send, { frameId });
          if (observeNavigation) await startObservation();
          await checkPointerDocument();
          dispatchedAction();
          const focused = await sendToContent(tabId, "prepareElementPress", { selector, index }, bound, context);
          assertActive();
          if (focused.error) return withElementActionHelp(focused, normalizedAction, resolvedTarget);
          await checkPointerDocument();
          // Verify the exact focused node, including CSS targets that a focus handler could replace.
          const confirmed = await sendToContent(tabId, "verifyElementFocus", { elementRefs: [focused._elementRef] }, bound, context);
          assertActive();
          if (confirmed.error) return withElementActionHelp(confirmed, normalizedAction, resolvedTarget);
          const guardedKeyboard = createCdpKeyboard({ ToolExecutionError, sendCdp: (_id, method, params) => {
            if (params.type !== "keyUp") assertActive();
            return send(method, params);
          } });
          await guardedKeyboard.press(tabId!, preparedKey, context);
          context.operation?.confirm();
          assertActive();
          return await finishPress();
        }, context);
      } finally { observation?.dispose(); }
    }

    const contentAction = async () => {
      dispatchedAction();
      const fallback = await sendToContent(tabId, "actOnElement", { selector, index, elementAction: normalizedAction, value, key, submit }, bound, context);
      if (fallback.error) return withElementActionHelp(fallback, normalizedAction, resolvedTarget);
      return complete();
    };
    return contentAction();
    }
    }
  },
});

function withElementActionHelp(result: ElementReply, action: string, target: string) {
  return { ...toolError(String(result.code || "ELEMENT_ACTION_FAILED"), String(result.error || result.message || "Element action failed"), {
    hint: "Use find_elements to refresh targets, inspect_element to verify the target, then act_on_element with one of: click/fill/press/select/check/uncheck/scroll.",
    details: { target, action },
  }) };
}

registerTool({
  name: "scroll_page",
  argumentAliases: { selector: "target", index: "nth" },
  behavior: { targetLookup: "light", uidTargets: args => locatorReferences(args.locator), timeoutResult: { kind: "action", pending: "scroll outcome confirmation" } },
  get description() { return toolT("scrollPageDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"] },
      direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      pixels: { type: "number", description: toolT("scrollPagePixels") },
      target: { type: "string", description: toolT("scrollPageTarget", { targetDescription: getElementTargetDescription() }) },
      locator: elementLocatorSchema,
      nth: elementNthSchema,
    },
    required: ["tabRef"],
  } as const; },
  page: "owned",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  validateArgs: args => validateElementInput(args, { required: false }),
  execute: async ({ tabId, direction = "down", pixels = 500, target = "", locator, nth = 0 }, _signal, context = {}) => {
    const ref = locator || String(target || "").trim() ? await resolveElementInput(tabId, { target, locator, nth }, context) : null;
    const scrolled = ref
      ? await readBound(ref, context, call => sendToContent(ref.tabId, "scrollPage", { direction, pixels, selector: ref.selector }, call, context))
      : await sendToContent(tabId, "scrollPage", { direction, pixels }, undefined, context);
    if (scrolled.error) return { ...toolError(String(scrolled.code || "SCROLL_FAILED"), String(scrolled.error), {
      hint: "Use find_elements to refresh the target, then retry scroll_page.", details: ref ? { target: ref.target } : undefined,
    }) };
    return ref ? { ...scrolled, target: ref.target, ...(ref.index ? { nth: ref.index } : {}) } : scrolled;
  },
});


}


export default ((host) => { registerPageElementTools({ ...host, ...host.element }); }) satisfies ToolExtension;
