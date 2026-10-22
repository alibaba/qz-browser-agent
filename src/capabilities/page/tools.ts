import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import { isElementReply, type ElementReply } from "#sdk/shared/browser";
import type { SecurityGuardrails } from "#sdk/shared/security";
import type { ElementTarget, PageState, PreparedNavigation } from "#sdk/background/browser";
import type { ToolContext } from "#sdk/background";
export type { PageState, PreparedNavigation, PageNavigationHost } from "#sdk/background/browser";
type PageElementHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "sendToContent" | "clickPointReady"
  | "clickNotReadyResult" | "sendCdp" | "withDebugger" | "getPageContext" | "getTabPageState" | "pageStateDelta"
  | "prepareKnownPageNavigation" | "commitObservedPageNavigation"> & Pick<ToolExtensionAPI["element"],
  "resolveSelectorTarget" | "resolveElementReference" | "addElementTargetsToFindResult" | "elementTargetForRef"
  | "elementTargetForSelector" | "elementTargetGrammar" | "getElementTargetDescription" | "useElement">;
import { getSecurityGuardrails } from "#sdk/shared/security";
import { armPageInputReceipt, ensurePageSurface, isCdpFallbackForbiddenError, readPageInputReceipt } from "#sdk/background/browser";
import { createCdpKeyboard, createCdpTouch } from "#sdk/background/browser";

/** Registers page reading, element inspection/action, and scrolling tools. */
export function registerPageElementTools({
  registerTool,
  ToolExecutionError,
  sendToContent: sendContent,
  resolveSelectorTarget,
  resolveElementReference,
  useElement,
  addElementTargetsToFindResult,
  elementTargetForRef,
  elementTargetForSelector,
  elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
  getElementTargetDescription,
  getTabPageState,
  pageStateDelta,
  prepareKnownPageNavigation,
  commitObservedPageNavigation,
  clickPointReady,
  clickNotReadyResult,
  sendCdp,
  withDebugger,
  getPageContext,
}: PageElementHost) {
async function sendToContent(tabId: number | undefined, action: string, params: Record<string, unknown>, call?: (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<ElementReply> {
  const result = await (call ? call(action, params) : sendContent(tabId, action, params));
  if (!isElementReply(result)) throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED", t("contentScriptReturnedAnInvalidResponse", { action: String(action) }), { tabId, action });
  return result;
}
function inputNotDelivered(details: Record<string, unknown>) {
  return {
    ...details,
    error: t("inputNotDelivered"),
    code: "INPUT_NOT_DELIVERED",
    clickDispatched: true,
    inputDelivered: false,
  };
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
async function observeElementNavigation(tabId: number, pageBefore: PageState, prepared: PreparedNavigation | null, guardrails: SecurityGuardrails) {
  await new Promise(resolve => setTimeout(resolve, 180));
  const pageAfter = await getTabPageState(tabId);
  return {
    pageDelta: pageStateDelta(pageBefore, pageAfter),
    observedNavigation: commitObservedPageNavigation({ pageBefore, pageAfter, prepared, guardrails, toolName: "act_on_element", tabId }),
  };
}
const keyboard = createCdpKeyboard({ sendCdp, ToolExecutionError });
const touch = createCdpTouch({ ToolExecutionError });
// ===========================================================================
// Page content
// ===========================================================================

registerTool({
  name: "read_article",
  get description() { return toolT("readArticleDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readArticleTabId") },
      source: { type: "string", enum: ["auto", "selection", "article", "selector", "body"], description: toolT("readArticleSource") },
      selector: { type: "string", description: toolT("readArticleSelector") },
      offset: { type: "number", description: toolT("readArticleOffset") },
      limit: { type: "number", description: toolT("readArticleLimit") },
    },
    required: ["limit"],
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, source = "auto", selector = "", offset = 0, limit }, _signal, context = {}) => {
    if (source === "selector" && !String(selector || "").trim()) {
      throw new ToolExecutionError(
        "MISSING_SELECTOR",
        t("readArticleRequiresASelectorWhenSourceSelector"),
        { source, required: "selector" },
      );
    }
    const target = source === "selector"
      ? await resolveSelectorTarget(tabId, selector, 0, context)
      : { tabId, selector };
    return readBound(target, context, call => sendToContent(target.tabId, "readArticle", { source, selector: target.selector, offset, limit }, call));
  },
});

registerTool({
  name: "read_dom",
  get description() { return toolT("readDomDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readArticleTabId") },
      offset: { type: "number", description: toolT("readDomOffset") },
      limit: { type: "number", description: toolT("readDomLimit") },
      selector: { type: "string", description: toolT("readDomSelector") },
    },
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, offset = 1, limit = 200, selector = "body" }, _signal, context = {}) => {
    const target = await resolveSelectorTarget(tabId, selector, 0, context);
    return readBound(target, context, call => sendToContent(target.tabId, "readDom", { offset, limit, selector: scopedSelector(target) }, call));
  },
});

registerTool({
  name: "find_elements",
  get description() { return toolT("findElementsDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readArticleTabId") },
      pattern: { type: "string", description: toolT("findElementsPattern") },
      flags: { type: "string", description: toolT("findElementsFlags") },
      selector: { type: "string", description: toolT("findElementsSelector") },
      roles: { type: "array", items: { type: "string" }, description: toolT("findElementsRoles") },
      tags: { type: "array", items: { type: "string" }, description: toolT("findElementsTags") },
      types: { type: "array", items: { type: "string" }, description: toolT("findElementsTypes") },
      limit: { type: "number", description: toolT("findElementsLimit") },
      includeHidden: { type: "boolean", description: toolT("findElementsIncludeHidden") },
    },
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, pattern = "", flags = "i", selector = "body", roles = [], tags = [], types = [], limit = 20, includeHidden = false }, _signal, context = {}) => {
    const target = await resolveSelectorTarget(tabId, selector, 0, context);
    const result = await readBound(target, context, call => sendToContent(target.tabId, "findElements", {
      pattern, flags, selector: scopedSelector(target), roles, tags, types, limit, includeHidden,
    }, call));
    return addElementTargetsToFindResult(result);
  },
});

registerTool({
  name: "inspect_element",
  get description() { return toolT("inspectElementDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readArticleTabId") },
      target: { type: "string", description: getElementTargetDescription() },
      index: { type: "number", description: toolT("inspectElementIndex") },
    },
    required: ["target"],
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, target = "", index = 0 }, _signal, context = {}) => {
    const ref = await resolveElementReference(tabId, { target, index }, context);
    return readBound(ref, context, async call => {
      const inspection = await sendToContent(ref.tabId, "inspectElement", { selector: ref.selector, index: ref.index }, call);
      return {
        ...inspection,
        tabId: ref.tabId,
        target: ref.target || elementTargetForRef(inspection) || elementTargetForSelector(ref.selector),
        uid: ref.uid || undefined,
        selector: inspection?.selector || ref.selector,
      };
    });
  },
});

// ===========================================================================
// Page interaction
// ===========================================================================

registerTool({
  name: "act_on_element",
  behavior: { mayUnloadPage: args => {
    const action = String(args.action || "").trim().toLowerCase();
    const key = String(args.key || args.value || "").trim().toLowerCase();
    return action === "click" || (action === "fill" && args.submit === true)
      || (action === "press" && ["enter", "return", "space"].includes(key));
  } },
  effects: (_args, result) => result && typeof result === "object"
    && (("navigated" in result && result.navigated === true) || ("href" in result && Boolean(result.href)) || ("url" in result && Boolean(result.url)))
    ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("actOnElementDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readArticleTabId") },
      target: { type: "string", description: getElementTargetDescription() },
      index: { type: "number", description: toolT("inspectElementIndex") },
      action: { type: "string", enum: ["click", "fill", "press", "select", "check", "uncheck", "scroll"] },
      value: { type: "string", description: toolT("actOnElementValue") },
      key: { type: "string", description: toolT("actOnElementKey") },
      submit: { type: "boolean", description: toolT("actOnElementSubmit") },
    },
    required: ["target", "action"],
  } as const; },
  page: "owned",
  timeout: args => String(args.action || "").trim().toLowerCase() === "click" ? { defaultMs: 1800000, maxMs: 7200000 } : { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ tabId, target = "", index = 0, action, value = "", key = "", submit = false }, _signal, context = {}) => {
    const normalizedAction = String(action || "").trim().toLowerCase();
    const allowed = new Set(["click", "fill", "press", "select", "check", "uncheck", "scroll"]);
    if (!allowed.has(normalizedAction)) {
      return {
        error: `Unsupported act_on_element action: ${action}`,
        code: "UNSUPPORTED_ELEMENT_ACTION",
        details: {
          action,
          allowedActions: [...allowed],
          examples: [
            { target: "css:input[name=\"q\"]", action: "fill", value: t("searchTerms") },
            { target: "css:input[name=\"q\"]", action: "press", key: "Enter" },
            { target: "uid:t5493.000001.12", action: "click" },
          ],
        },
      };
    }

    const ref = await resolveElementReference(tabId, { target, index }, context);
    tabId = ref.tabId;
    const selector = ref.selector;
    index = ref.index;
    const resolvedTarget = ref.target || elementTargetForSelector(selector);
    const toolArgsForUpdates = { tabId, target, index, action, value, key, submit };
    if (!tabId) throw new ToolExecutionError("NO_ACTIVE_TAB", t("noActiveTabIsAvailable"), { target: resolvedTarget, selector, action });
    let bound: ((action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
    const fillToken = ref.uid && normalizedAction === "fill" ? `${ref.uid}:${Date.now().toString(36)}` : "";
    if (ref.uid) {
      return useElement(tabId, ref, context, async call => {
        bound = (actionName, params = {}) => call(actionName, normalizedAction === "fill" ? { ...params, editingHost: true, fillToken } : params);
        try { return await perform(); } finally { bound = undefined; }
      });
    }
    return perform();
    async function perform() {
    if (!tabId) throw new ToolExecutionError("NO_ACTIVE_TAB", t("noActiveTabIsAvailable"), { target: resolvedTarget, selector, action });

    const inspected = await sendToContent(tabId, "inspectElement", { selector, index }, bound);
    if (inspected.error) return withElementActionHelp(inspected, normalizedAction);

    if (normalizedAction === "click") {
      const pageBefore = await getTabPageState(tabId);
      const securityGuardrails = await getSecurityGuardrails();
      let current = inspected;
      let pointSelector = selector;
      let pointIndex = index;
      let resolved: ElementReply | null = null;

      if (!clickPointReady(current)) {
        const scrolled = await sendToContent(tabId, "scrollElementIntoView", { selector, index, block: "center" }, bound);
        if (scrolled.error) return withElementActionHelp(scrolled, normalizedAction);
        current = scrolled;
      }

      if (!clickPointReady(current)) {
        resolved = await sendToContent(tabId, "resolveClickTarget", { selector, index }, bound);
        if (resolved.error) return withElementActionHelp(resolved, normalizedAction);
        if (resolved.navigateUrl) {
          const preparedNavigation = await prepareKnownPageNavigation({
            url: resolved.navigateUrl,
            pageBefore,
            guardrails: securityGuardrails,
            context,
            signal: _signal,
            toolName: "act_on_element",
            toolArgs: toolArgsForUpdates,
            tabId,
            source: "resolved_href",
          });
          const navigationUrl = preparedNavigation?.url || resolved.navigateUrl;
          await chrome.tabs.update(tabId, { url: navigationUrl });
          const { pageDelta, observedNavigation } = await observeElementNavigation(tabId, pageBefore, preparedNavigation, securityGuardrails);
          return {
            action: "click",
            target: resolvedTarget,
            selector,
            uid: ref.uid || undefined,
            index,
            tabId,
            clickDispatched: false,
            navigated: pageDelta.urlChanged,
            method: "href_navigation",
            href: navigationUrl,
            ...pageDelta,
            ...(observedNavigation ? { observedNavigation } : {}),
            element: resolved.element || current,
            originalElement: inspected,
          };
        }
        if (resolved.resolvedSelector) {
          const resolvedInspection = await sendToContent(tabId, "scrollElementIntoView", {
            selector: resolved.resolvedSelector,
            index: 0,
            block: "center",
          });
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

      if (!clickPointReady(current)) {
        return clickNotReadyResult({
          target: resolvedTarget,
          selector,
          index,
          inspection: current,
          originalInspection: inspected,
          resolved,
        });
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
      let touchInput = false;
      let delivered = false;
      try {
        await withDebugger(tabId, async (_target, send) => {
          await ensurePageSurface(tabId, send);
          const sameTarget = pointSelector === selector && pointIndex === index;
          const refreshed = await sendToContent(tabId, "inspectElement", { selector: pointSelector, index: pointIndex }, sameTarget ? bound : undefined);
          if (!refreshed.error && clickPointReady(refreshed)) current = refreshed;
          if (!clickPointReady(current)) return;
          const point = current.clickablePoint;
          touchInput = getPageContext(tabId).pageMode === "mobile";
          const receiptId = await armPageInputReceipt(tabId);
          if (touchInput) { await touch(send, point, { signal: _signal }); }
          else {
            await send("Input.dispatchMouseEvent", {
              type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
            });
            await send("Input.dispatchMouseEvent", {
              type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
            });
          }
          delivered = await inputWasDelivered(tabId, receiptId);
        }, context);
        if (!clickPointReady(current)) {
          return clickNotReadyResult({
            target: resolvedTarget,
            selector,
            index,
            inspection: current,
            originalInspection: inspected,
            resolved,
          });
        }
        if (!delivered) return inputNotDelivered({ action: "click", target: resolvedTarget, selector, uid: ref.uid || undefined, index, tabId });
        const { pageDelta, observedNavigation } = await observeElementNavigation(tabId, pageBefore, preparedNavigation, securityGuardrails);
        return {
          action: "click",
          target: resolvedTarget,
          selector,
          uid: ref.uid || undefined,
          index,
          tabId,
          clickDispatched: true,
          inputDelivered: true,
          navigated: pageDelta.urlChanged,
          method: pointSelector !== selector ? "cdp_resolved" : "cdp",
          href: current.href || resolved?.href || undefined,
          clickedSelector: pointSelector,
          clickedIndex: pointIndex,
          ...pageDelta,
          ...(observedNavigation ? { observedNavigation } : {}),
          element: current,
          originalElement: current !== inspected ? inspected : undefined,
        };
      } catch (err) {
        rethrowStaleElement(err);
        if (touchInput || isCdpFallbackForbiddenError(err)) throw err;
        const fallback = await sendToContent(tabId, "actOnElement", { selector, index, elementAction: normalizedAction, value, key, submit }, bound);
        const { pageDelta, observedNavigation } = await observeElementNavigation(tabId, pageBefore, preparedNavigation, securityGuardrails);
        return {
          ...fallback,
          target: resolvedTarget,
          selector,
          uid: ref.uid || undefined,
          index,
          tabId,
          clickDispatched: fallback.error ? false : Boolean(fallback.clicked || fallback.navigated),
          navigated: Boolean(fallback.navigated) || pageDelta.urlChanged,
          method: fallback.error ? "content_failed" : "content_fallback",
          cdpError: err instanceof Error ? err.message : String(err),
          ...pageDelta,
          ...(observedNavigation ? { observedNavigation } : {}),
        };
      }
    }

    const identity = { action: normalizedAction, target: resolvedTarget, selector, uid: ref.uid || undefined, index, tabId };
    const assertActive = () => {
      if (_signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("elementActionCancelled"), identity);
    };
    if (normalizedAction === "fill") {
      assertActive();
      const pageBefore = submit ? await getTabPageState(tabId) : null;
      const guardrails = submit ? await getSecurityGuardrails() : null;
      return withDebugger(tabId, async (_target, send) => {
        assertActive();
        const prepared = await sendToContent(tabId, "prepareElementFill", { selector, index, value }, bound);
        assertActive();
        if (prepared.error) return withElementActionHelp(prepared, normalizedAction);
        // Preparation may resolve an inherited contenteditable child to its editing host.
        const field = prepared.selector ? { selector: prepared.selector, index: 0 } : { selector, index };
        const textInput = prepared.fillMode === "text";
        const inputKeyboard = createCdpKeyboard({ ToolExecutionError, sendCdp: (_tabId, method, params) => {
          if (params.type !== "keyUp") assertActive();
          return send(method, params);
        } });
        let fill: unknown;
        if (textInput) {
          if (value) await send("Input.insertText", { text: value });
          else await inputKeyboard.press(tabId, "Backspace", context);
        } else {
          // Rich-text paragraphs and non-keyboard fields retain their specialized writer.
          const result = await sendToContent(tabId, "actOnElement", { ...field, elementAction: "fill", value, submit: false }, bound);
          if (result.error) return withElementActionHelp(result, normalizedAction);
          fill = result.fill;
        }
        assertActive();
        const actual = await sendToContent(tabId, "readElementActionState", field, bound);
        assertActive();
        if (actual.error) return withElementActionHelp(actual, normalizedAction);
        // Chromium uses NBSP to preserve boundary spaces in contenteditable text.
        const equivalentText = (text: string) => prepared.contentEditable ? text.replace(/\u00a0/g, " ") : text;
        if (textInput && (typeof actual.value !== "string"
          || equivalentText(actual.value) !== equivalentText(value.replace(/\r\n?/g, "\n")))) {
          return { ...identity, error: t("elementValueMismatch"), code: "ELEMENT_VALUE_MISMATCH",
            filled: false, value: actual.value, submitDispatched: false, element: actual };
        }
        if (submit) {
          if (!actual.focused) return { ...identity, error: t("elementFocusLost"), code: "ELEMENT_FOCUS_FAILED",
            filled: true, value: actual.value, submitDispatched: false, element: actual };
          // Enter preserves page key handlers and native form validation. Never replay after a CDP failure.
          await inputKeyboard.press(tabId, "Enter", context);
          assertActive();
        }
        const navigation = pageBefore && guardrails
          ? await observeElementNavigation(tabId, pageBefore, null, guardrails) : null;
        assertActive();
        return { ...identity, filled: true, value: actual.value, fill, submitDispatched: submit,
          method: textInput ? "cdp" : "content", element: actual,
          ...(navigation ? { ...navigation.pageDelta, navigated: navigation.pageDelta.urlChanged,
            ...(navigation.observedNavigation ? { observedNavigation: navigation.observedNavigation } : {}) } : {}) };
      }, context);
    }

    if (normalizedAction === "check" || normalizedAction === "uncheck") {
      assertActive();
      const desired = normalizedAction === "check";
      if (inspected.tag !== "input" || !["checkbox", "radio"].includes(String(inspected.type))) {
        return { ...identity, error: t("elementNotCheckable"), code: "NOT_CHECKABLE_ELEMENT", element: inspected };
      }
      if (inspected.checked === desired) return { ...identity, checked: desired, changed: false, element: inspected };
      if (inspected.type === "radio" && !desired) {
        return { ...identity, error: t("radioCannotBeUnchecked"), code: "ELEMENT_CHECK_STATE_MISMATCH", element: inspected };
      }
      return withDebugger(tabId, async (_target, send) => {
        assertActive();
        await ensurePageSurface(tabId, send);
        const current = await sendToContent(tabId, "resolveCheckTarget", { selector, index }, bound);
        assertActive();
        if (current.error) return withElementActionHelp(current, normalizedAction);
        if (current.tag !== "input" || current.type !== inspected.type) {
          return { ...identity, error: t("elementNotCheckable"), code: "NOT_CHECKABLE_ELEMENT", element: current };
        }
        if (current.checked === desired) return { ...identity, checked: desired, changed: false, element: current };
        const clickTarget = !current.disabled && isElementReply(current.element) ? current.element : current;
        if (!clickPointReady(clickTarget)) return clickNotReadyResult({ target: resolvedTarget, selector, index,
          inspection: clickTarget, originalInspection: current, resolved: null });
        const point = clickTarget.clickablePoint;
        const receiptId = await armPageInputReceipt(tabId);
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
              try { await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: -1, y: -1, button: "left", clickCount: 1 }); } catch { /* The run may have lost its lease. */ }
            }
          }
        }
        assertActive();
        if (!await inputWasDelivered(tabId, receiptId)) return inputNotDelivered(identity);
        const actual = await sendToContent(tabId, "readElementActionState", { selector, index }, bound);
        assertActive();
        if (actual.error) return withElementActionHelp(actual, normalizedAction);
        if (actual.tag !== "input" || actual.type !== inspected.type || actual.checked !== desired) return { ...identity, error: t("elementCheckStateMismatch"),
          code: "ELEMENT_CHECK_STATE_MISMATCH", checked: actual.checked, element: actual };
        return { ...identity, checked: desired, changed: true, method: "cdp", inputDelivered: true, element: actual };
      }, context);
    }

    if (normalizedAction === "press") {
      const pressedKey = key || value;
      if (!pressedKey) {
        return {
          error: "key is required for press action",
          code: "MISSING_KEY",
          details: { target: resolvedTarget, selector, index, action: "press", examples: [{ key: "Enter" }, { key: "Escape" }, { key: "Tab" }] },
          element: inspected,
        };
      }
      const preparedKey = keyboard.normalize(pressedKey);
      try {
        let delivered = !inspected.clickablePoint;
        if (inspected.clickablePoint) {
          await withDebugger(tabId, async (_target, send) => {
            await ensurePageSurface(tabId, send);
            const refreshed = await sendToContent(tabId, "inspectElement", { selector, index }, bound);
            const point = !refreshed.error && clickPointReady(refreshed) ? refreshed.clickablePoint : inspected.clickablePoint;
            if (!point) return;
            const receiptId = await armPageInputReceipt(tabId);
            await send("Input.dispatchMouseEvent", {
              type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
            });
            await send("Input.dispatchMouseEvent", {
              type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
            });
            delivered = await inputWasDelivered(tabId, receiptId);
          }, context);
          if (!delivered) return inputNotDelivered({ action: "press", target: resolvedTarget, selector, uid: ref.uid || undefined, index, tabId, key: pressedKey });
        }
        await keyboard.press(tabId, preparedKey, context);
        return { action: "press", target: resolvedTarget, selector, uid: ref.uid || undefined, index, tabId, key: pressedKey, pressed: true, method: "cdp", inputDelivered: true, element: inspected };
      } catch (err) {
        rethrowStaleElement(err);
        if (isCdpFallbackForbiddenError(err)) throw err;
        const fallback = await sendToContent(tabId, "actOnElement", { selector, index, elementAction: "press", value, key: pressedKey, submit }, bound);
        return { ...fallback, target: resolvedTarget, selector, uid: ref.uid || undefined, index, tabId, method: fallback.error ? "content_failed" : "content_fallback", cdpError: err instanceof Error ? err.message : String(err), element: fallback.element || inspected };
      }
    }

    const fallback = await sendToContent(tabId, "actOnElement", { selector, index, elementAction: normalizedAction, value, key, submit }, bound);
    return {
      ...fallback,
      target: resolvedTarget,
      selector,
      uid: ref.uid || undefined,
      index,
      tabId,
      method: fallback.error ? "content_failed" : "content",
      element: fallback.element || inspected,
    };
    }
  },
});

function withElementActionHelp(result: ElementReply, action: string) {
  if (!result || !result.error) return result;
  return {
    ...result,
    hint: "Use find_elements to refresh selectors, inspect_element to verify the target, then act_on_element with one of: click/fill/press/select/check/uncheck/scroll.",
    requestedAction: action,
  };
}

registerTool({
  name: "scroll_page",
  get description() { return toolT("scrollPageDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number" },
      direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      pixels: { type: "number", description: toolT("scrollPagePixels") },
      target: { type: "string", description: toolT("scrollPageTarget", { targetDescription: getElementTargetDescription() }) },
      index: { type: "number", description: toolT("scrollPageIndex") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: async ({ tabId, direction = "down", pixels = 500, target = "", index = 0 }, _signal, context = {}) => {
    if (!String(target || "").trim()) return sendToContent(tabId, "scrollPage", { direction, pixels });
    const ref = await resolveElementReference(tabId, { target, index }, context);
    const scrolled = await readBound(ref, context, call => sendToContent(ref.tabId, "scrollPage", { direction, pixels, selector: ref.selector }, call));
    return {
      ...scrolled,
      tabId: ref.tabId,
      target: ref.target,
      selector: ref.selector,
      index: ref.index,
    };
  },
});


}


export default ((host) => { registerPageElementTools({ ...host, ...host.element }); }) satisfies ToolExtension;
