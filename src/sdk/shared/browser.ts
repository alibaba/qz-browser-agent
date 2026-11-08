/** Public browser contracts and operations, independent of extension implementation paths. */
export { createElementObservation, toRect } from "../../shared/contracts/element-observation.js";
export type { Rect, ElementObservation, ImageObservation, CanvasObservation } from "../../shared/contracts/element-observation.js";
export { elementLocatorSchema, locatorReferences, validateElementLocator } from "../../shared/contracts/element-locator.js";
export type { ElementLocator } from "../../shared/contracts/element-locator.js";
export { pageReferenceForResult } from "../../shared/tab-reference.js";
export { bindCreatedTabResult, createdTabResultId, copyCreatedTabResult } from "../../shared/contracts/page-observation.js";
export type { PageObservation } from "../../shared/contracts/page-observation.js";
export { isElementReply, isPageOverview } from "../../shared/contracts/page-content.js";
export type { ElementReply, PageAction, PageCanvas, PageOverview } from "../../shared/contracts/page-content.js";
export { wrapRunScriptSource, isRunScriptCallableExpression } from "../../shared/run-script-source.js";
export { filterWebTabs, formatTab, isWebTab, isPageTab, isPageTabUrl, isLocalFileUrl } from "../../shared/tab-utils.js";
export type { TabReference } from "../../shared/tab-utils.js";
