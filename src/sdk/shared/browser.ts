/** Public browser contracts and operations, independent of extension implementation paths. */
export { isElementReply, isPageOverview } from "../../shared/contracts/page-content.js";
export type { ElementReply, PageAction, PageCanvas, PageOverview } from "../../shared/contracts/page-content.js";
export { wrapRunScriptSource } from "../../shared/run-script-source.js";
export { filterWebTabs, formatTab, isWebTab, isPageTab, isPageTabUrl, isLocalFileUrl } from "../../shared/tab-utils.js";
export type { TabReference } from "../../shared/tab-utils.js";
