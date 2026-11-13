import type { ToolContext } from "../background.js";
import type { ElementReference } from "../../background/tools/element-runtime.js";
import type { ElementLocator } from "../../shared/contracts/element-locator.js";
export type { ElementReference } from "../../background/tools/element-runtime.js";
export interface CdpCommand {
  (method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Flattened child debugger session. Test doubles that only drive the page target omit it. */
  inSession?(sessionId: string): CdpCommand;
  /** Owning page tab. Present on commands from the debugger runtime. */
  tabId?: number;
  /** Changes when the page debugger reconnects. */
  connectionId?: number;
  /** Release a held pointer on this captured connection only, including after call cancellation. */
  cancelPointer?(): Promise<void>;
}
type CdpOperation<T> = (target: chrome.debugger.Debuggee, send: CdpCommand) => T | Promise<T>;
/** Run identity is checked by the host before accessing a debugger lease. */
export interface BrowserDebugger {
  sendCdp(tabId: unknown, method: string, params?: Record<string, unknown>, context?: ToolContext): Promise<unknown>;
  withDebugger<T>(tabId: unknown, fn: CdpOperation<T>, context?: ToolContext): Promise<T>;
  withTemporaryDebugger<T>(tabId: unknown, fn: CdpOperation<T>, label?: string): Promise<T>;
  evaluateCdpScript(tabId: unknown, params?: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<unknown>;
}
export interface ElementTarget {
  tabId?: number; selector: string; index?: number; target?: string; uid?: string; ref?: ElementReference;
}
export interface ElementAccess {
  readonly elementTargetGrammar: string;
  getElementTargetDescription(): string;
  makeSnapshotId(tabId: number, context?: ToolContext): string;
  makeElementUid(snapshotId: string, seq: number, mark?: string): string;
  registerElementRef(ref: ElementReference): void;
  registerElementBinding(ref: ElementReference): ElementReference & { target: string };
  bindElementReferences(tabId: number, candidates: readonly ElementReference[], context?: ToolContext, scope?: ElementReference, mode?: "bestEffort" | "required"): Promise<(ElementReference & { target: string })[]>;
  elementTargetForUid(uid: unknown): string;
  elementTargetForSelector(selector: unknown): string;
  elementTargetForRef(ref?: ElementReference): string;
  /** The one tab every value's uid is registered to; null for unknown uids or a set spanning tabs. */
  elementUidTabId(values: readonly unknown[]): number | null;
  isUidElementTarget(value: unknown): boolean;
  resolveSelectorTarget(tabId?: number, selector?: string, index?: number, context?: ToolContext): Promise<ElementTarget>;
  resolveElementReference(tabId: number | undefined, options?: { target?: string; index?: number; readOnly?: boolean }, context?: ToolContext): Promise<ElementTarget & { index: number }>;
  /** One element input: a target string with an optional nth, or a locator; a locator with no match throws ELEMENT_NOT_FOUND. */
  resolveElementInput(tabId: number | undefined, options?: { target?: string; locator?: ElementLocator; nth?: number; readOnly?: boolean }, context?: ToolContext): Promise<ElementTarget & { index?: number }>;
  resolveLocatorTarget(tabId: number | undefined, locator: ElementLocator, context?: ToolContext): Promise<ElementTarget | null>;
  countLocatorMatches(tabId: number | undefined, locator: ElementLocator, context?: ToolContext): Promise<number>;
  findLocatorElements(tabId: number | undefined, locator: ElementLocator, context?: ToolContext, limit?: number): Promise<{ results: unknown[]; count: number }>;
  addElementTargetsToFindResult(value: unknown, tabId?: number, context?: ToolContext, scope?: ElementReference): Promise<unknown>;
  backendNodeIdForSelector(tabId: number, selector: string, context?: ToolContext): Promise<number>;
  /** Bind unique selectors in one document; a frame scope also rejects a changed loader. */
  bindBackendNodes(tabId: number, selectors: string[], context?: ToolContext, scope?: Pick<ElementReference, "frameId" | "loaderId">): Promise<{ loaderId: string; ids: number[] }>;
  callElement(tabId: number | undefined, binding: ElementTarget, action: string, params?: Record<string, unknown>, context?: ToolContext): Promise<Record<string, unknown>>;
  useElement<T>(tabId: number | undefined, binding: ElementTarget, context: ToolContext, run: (
    call: (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<T>): Promise<T>;
  readMainDocumentId(tabId: number): Promise<string>;
}
export { assertHtmlPage } from "../../background/tools/page-access.js";
export { waitForParsedDocument, waitForPageCommit } from "../../background/tools/document-readiness.js";
export { ensureOffscreenDocument } from "../../background/services/offscreen-document.js";
export { createCdpKeyboard, primaryModifierForContext } from "../../background/tools/cdp-keyboard.js";
export { createCdpTouch } from "../../background/tools/cdp-touch.js";
export type { MappedKey } from "../../background/tools/cdp-keyboard.js";
export { isCdpFallbackForbiddenError } from "../../background/tools/cdp-runtime.js";
export type { PageNavigationHost, PageState, PreparedNavigation } from "../../background/tools/page-navigation.js";
export { beginPageNavigationObservation, observeNextPageNavigation } from "../../background/tools/page-navigation.js";
export type { PageObservationHost, Screenshot, ScreenshotOptions } from "../../background/tools/page-observation.js";
export { elementPageFunction } from "../../background/tools/page-scripts.js";
export { armPageInputReceipt, ensurePageSurface, readPageInputReceipt } from "../../background/tools/page-surface.js";
export { pageInputDelivered } from "../../background/tools/page-input-delivery.js";
export type { PageInputDelivery } from "../../background/tools/page-input-delivery.js";
export { isRunScriptInnerTargetArgs, resolveRunScriptTargetTabId } from "../../background/tools/script-policy.js";
export { directChildFrames, openChildFrame, frameContentOrigin } from "../../background/tools/child-frames.js";
