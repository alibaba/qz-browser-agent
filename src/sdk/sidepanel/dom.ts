/** Supported dom helpers; mutable host state is accessed through extension ports. */
export { LIVE_HIGHLIGHT_MAX_LENGTH, highlightCode, highlightMarkdownDocument, normalizeCodeLanguage } from "../../sidepanel/ui/code-highlighter.js";
export { patchAttributes } from "../../sidepanel/ui/dom-morph.js";
export { createListExitTransition, createListLayoutMotion } from "../../sidepanel/ui/list-layout-motion.js";
export { createImageAssetUrls } from "../../sidepanel/ui/image-asset-urls.js";
export { openImageGallery } from "../../sidepanel/ui/image-lightbox.js";
export { renderResultChoice } from "../../sidepanel/ui/result-choice.js";
export { appendHtmlSection, copyPlainText, escapeHtml, escapeHtmlAttribute, hashText, safeFilename } from "../../sidepanel/ui/ui-utils.js";

/** A result choice uses native form semantics; its owner handles selection and submission. */
export interface ResultChoiceOptions {
  id: string;
  name: string;
  value: string;
  label: string;
  description?: string;
  meta?: readonly string[];
  imageUrl?: string;
  url?: string;
  multiple: boolean;
  checked: boolean;
  disabled?: boolean;
}
