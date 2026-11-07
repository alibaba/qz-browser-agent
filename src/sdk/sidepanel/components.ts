/** Supported components helpers; mutable host state is accessed through extension ports. */
export type { createDataTableRenderer } from "../../sidepanel/tools/primitives/data-table-renderer.js";
export type { createDeclarativeRenderer } from "../../sidepanel/tools/primitives/declarative-renderer.js";
export { appendChanges, changePreview } from "../../sidepanel/tools/primitives/diff-renderer.js";
export { createImageGridRenderer } from "../../sidepanel/tools/primitives/image-grid-renderer.js";
export type { ProfileHelpers } from "../../sidepanel/tools/primitives/profile-helpers.js";
export { createProfileHelpers, profileCapability, resultProfile } from "../../sidepanel/tools/primitives/profile-helpers.js";
export { normalizeMcpRendererData, skillResultData, skillResultEnvelope, stripSkillMeta } from "../../sidepanel/tools/primitives/skill-result-data.js";
export { createStructuredRenderer } from "../../sidepanel/tools/primitives/structured-renderer.js";
export { formatDurationMsForUi, formatMcpHeadersMeta, prefixLines } from "../../sidepanel/tools/primitives/text-utils.js";
export { createTreeRenderer } from "../../sidepanel/tools/primitives/tree-renderer.js";
