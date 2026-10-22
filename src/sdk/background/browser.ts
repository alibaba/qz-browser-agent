import type { ToolContext } from "../background.js";
import type { ElementReference } from "../../background/tools/element-runtime.js";
export type { ElementReference } from "../../background/tools/element-runtime.js";
export type CdpCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
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
  elementTargetForUid(uid: unknown): string;
  elementTargetForSelector(selector: unknown): string;
  elementTargetForRef(ref?: ElementReference): string;
  isUidElementTarget(value: unknown): boolean;
  resolveSelectorTarget(tabId?: number, selector?: string, index?: number, context?: ToolContext): Promise<ElementTarget>;
  resolveElementReference(tabId: number | undefined, options?: { target?: string; index?: number; allowBackendOnly?: boolean; readOnly?: boolean }, context?: ToolContext): Promise<ElementTarget & { index: number }>;
  addElementTargetsToFindResult(value: unknown): unknown;
  backendNodeIdForSelector(tabId: number, selector: string, context?: ToolContext): Promise<number>;
  bindBackendNodes(tabId: number, selectors: string[], context?: ToolContext): Promise<{ loaderId: string; ids: number[] }>;
  callElement(tabId: number | undefined, binding: ElementTarget, action: string, params?: Record<string, unknown>, context?: ToolContext): Promise<Record<string, unknown>>;
  useElement<T>(tabId: number | undefined, binding: ElementTarget, context: ToolContext, run: (
    call: (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<T>): Promise<T>;
  readMainDocumentId(tabId: number): Promise<string>;
}
export { ensureOffscreenDocument } from "../../background/services/offscreen-document.js";
export { createCdpKeyboard, primaryModifierForContext } from "../../background/tools/cdp-keyboard.js";
export { createCdpTouch } from "../../background/tools/cdp-touch.js";
export type { MappedKey } from "../../background/tools/cdp-keyboard.js";
export { isCdpFallbackForbiddenError } from "../../background/tools/cdp-runtime.js";
export type { PageNavigationHost, PageState, PreparedNavigation } from "../../background/tools/page-navigation.js";
export type { PageObservationHost, Screenshot, ScreenshotOptions } from "../../background/tools/page-observation.js";
export { elementPageFunction } from "../../background/tools/page-scripts.js";
export { armPageInputReceipt, ensurePageSurface, readPageInputReceipt } from "../../background/tools/page-surface.js";
export { isRunScriptInnerTargetArgs, resolveRunScriptTargetTabId } from "../../background/tools/script-policy.js";
