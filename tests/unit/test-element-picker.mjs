import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { transformSync } from "esbuild";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = path => {
  const sourcePath = existsSync(join(root, path)) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(join(root, sourcePath), "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code : source;
};
const manifest = JSON.parse(read("src/manifest.json"));
const html = read("src/sidepanel/sidepanel.html");
const css = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url));
const elementPicker = read("src/sidepanel/features/chat/element-picker-feature.js");
const transcriptRenderer = read("src/sidepanel/features/chat/transcript/renderer.js");
const sidepanel = `${elementPicker}\n${transcriptRenderer}`;
const content = read("src/content/content-script.js");
const articleExtractor = read("src/content/article-extractor.js");
const tools = read("src/background/tools/runtime.js");
const serviceWorker = read("src/background/service-worker.js");
const platformCommands = read("src/background/services/platform-commands.js");
const sidepanelTransport = read("src/background/transports/sidepanel.js");
assert.match(content, /QZ_CONTENT_VERSION = "2026-10-22-iframe-frame"/);
const contentScripts = manifest.content_scripts?.find(entry => entry.js?.includes("content/content-script.js"))?.js;
assert.deepEqual(contentScripts, ["content/article-extractor.js", "content/content-script.js"], "manifest needs only self-contained first-party entry points");
assert.match(tools, /files:\s*\["content\/article-extractor\.js", "content\/content-script\.js"\]/);
for (const dependency of ["@mozilla/readability", "turndown", "turndown-plugin-gfm", "@medv/finder"]) {
  assert.ok(content.includes(`from "${dependency}"`), `${dependency} must be a compiler-resolved dependency`);
}
assert.match(articleExtractor, /from "@mozilla\/readability"/);
assert.match(articleExtractor, /QingzhouArticleExtractor = Object\.freeze\(\{ extract \}\)/);
assert.match(content, /extractor\?\.extract\?\.\(document, \{ complete \}\)/);

const pickerMarkup = html.match(/<button id="btn-pick-element"[\s\S]*?<\/button>/u)?.[0] || "";
assert.match(pickerMarkup, /class="qz-icon-btn qz-icon-btn--sm element-picker-btn hidden"[\s\S]*aria-pressed="false"/);
assert.match(pickerMarkup, /M12\.034 12\.681/, "picker should keep the dashed-box pointer icon");
assert.doesNotMatch(pickerMarkup, /<circle cx="12" cy="12" r="3"/, "picker should not reuse the goal crosshair icon");
assert.match(css, /\.input-wrapper\s*\{[\s\S]*?align-items:\s*center;/, "composer controls should share one vertical axis");
const pickerCss = css.match(/\.element-picker-btn\s*\{[\s\S]*?(?=\n\.send-btn\s*\{)/)?.[0] || "";
assert.ok(pickerCss, "picker button styles should exist");
assert.doesNotMatch(pickerCss, /var\(--green\)|#[0-9a-f]{6}/i, "picker states should stay neutral and theme-driven");
assert.match(pickerCss, /\.element-picker-btn\.is-active[\s\S]*background:\s*var\(--bg-tertiary\)/);

assert.match(sidepanel, /sendRequest\("start_element_picker", \{ tabId: tab\.id \}, (?:65000|65e3)\)/);
assert.match(sidepanel, /function isElementPickerTabSupported\(tab\)[\s\S]*?url\.protocol !== "http:"[\s\S]*?chromewebstore\.google\.com/);
assert.match(sidepanel, /function installElementPickerAvailabilityTracking\(\)[\s\S]*?tabs\?\.onActivated[\s\S]*?tabs\?\.onUpdated[\s\S]*?syncElementPickerAvailability\(\)/);
assert.match(sidepanel, /button\.classList\.toggle\("hidden", !available\)/);
assert.doesNotMatch(sidepanel, /当前页面不支持选择元素|无法读取当前页面/);
assert.match(sidepanel, /button\.title = active \? t\("confirmSelectionHint"\)/);
assert.match(sidepanel, /if \(elementPickerRequest\) \{[\s\S]*?await confirmActiveElementPicker\(\);[\s\S]*?return;/);
assert.match(sidepanel, /createElementReferenceToken\(\{[\s\S]*?selector: value/);
assert.match(sidepanel, /findElementReferenceTokens\(source\)/);
assert.match(sidepanel, /resource-ref-pill element/);
assert.match(sidepanel, /resource-ref-kind">\$\{tHtml\("selectedElement"\)\}<\/span>/);
assert.match(sidepanel, /truncateElementReferenceSelector\(token\.selector\)/);
assert.match(sidepanel, /function truncateElementReferenceSelector\(value, maxLength = 5\)/);
assert.match(css, /\.resource-ref-pill\.element\s*\{/);
assert.match(sidepanel, /input\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
assert.match(
  sidepanel,
  /const hasLiveSelection = document\.hasFocus\(\) && document\.activeElement === input;[\s\S]*?: input\.value\.length;[\s\S]*?: start;/,
  "page-driven selections should append instead of trusting a stale textarea caret",
);
assert.match(sidepanel, /focusComposerAt\(caret\)/);
assert.match(
  sidepanel,
  /function focusComposerAt\(caret\)[\s\S]*?input\.setSelectionRange\(position, position\)[\s\S]*?if \(!document\.hasFocus\(\)\) return;[\s\S]*?input\.focus\(\{ preventScroll: true \}\)/,
);
assert.doesNotMatch(sidepanel, /window\.focus\(\)/, "the side panel cannot reclaim browser focus from a page WebContents");
assert.match(sidepanel, /button\?\.addEventListener\("click", toggleElementPicker\)/);
assert.match(
  sidepanel,
  /document\.addEventListener\("keydown",[\s\S]*?event\.key === "Enter"[\s\S]*?event\.key === "Escape"[\s\S]*?confirmActiveElementPicker\(\)[\s\S]*?cancelActiveElementPicker\(\)[\s\S]*?\}, true\);/,
  "Enter should confirm and Escape should cancel while sidepanel focus is preserved",
);
assert.doesNotMatch(sidepanel, /pendingElementReference|elementReferencePayload/, "the picker should only add visible composer text");

assert.match(content, /startElementPicker,/);
assert.match(content, /confirmElementPicker,/);
assert.match(content, /cancelElementPicker,/);
assert.match(content, /event\.stopImmediatePropagation\(\)/, "selection clicks should not trigger the page action");
assert.match(content, /function confirmElementPicker\(\)[\s\S]*?state\.renderedTarget\?\.isConnected[\s\S]*?selectElementPickerTarget\(target\)/);
assert.match(content, /function selectElementPickerTarget\(target\)[\s\S]*?status: "selected"[\s\S]*?generatePickedSelector\(target\)[\s\S]*?finishElementPicker\(result\)/);
assert.doesNotMatch(content, /element_picker_refocus_side_panel|requestElementPickerSidePanelFocus/);
assert.match(content, /document\.querySelectorAll\(selector\)/, "picked selectors should be verified against the current page");
assert.doesNotMatch(content, /border:1px solid rgba\(86,94,105,\.48\)/, "the focus window should not draw a frame");
assert.match(content, /ELEMENT_PICKER_FOG_COLOR = "rgba\(216,220,225,\.62\)"/);
assert.match(content, /ELEMENT_PICKER_MOTION_MS = 240/);
assert.match(content, /ELEMENT_PICKER_HOVER_INTENT_MS = 55/);
assert.match(content, /fogCorners/);
assert.match(content, /radial-gradient\(circle at \$\{origin\},transparent 70%/);
assert.match(content, /scheduleElementPickerOverlay\(state\.target, true\)/, "scroll and resize should stay attached to the target");
assert.match(content, /queueElementPickerHoverIntent\(state, target\)/);
assert.match(content, /state\.hoverCandidate !== target[\s\S]*?scheduleElementPickerOverlay\(target\)/);
assert.match(content, /state\.renderedTarget !== target[\s\S]*?moveElementPickerFocus\(state, focusRect, true\)/);
assert.match(content, /const eased = progress \* progress \* \(3 - 2 \* progress\)/);
assert.match(content, /`background:\$\{ELEMENT_PICKER_FOG_COLOR\}`/, "picker mode should visibly fog the page");
assert.doesNotMatch(
  content.match(/const fogPanels = Array[\s\S]*?const fogCorners/)?.[0] || "",
  /contain:strict/,
  "animated fog panels must not trigger isolated-layer compositor artifacts",
);
assert.doesNotMatch(
  content.match(/function startElementPicker[\s\S]*?(?=\n  function cancelElementPicker)/)?.[0] || "",
  /backdrop-filter/,
  "the picker fog must not invoke a full-page live blur",
);
assert.match(
  content,
  /stage\.animate\(\s*\[\{ opacity: 0 \}, \{ opacity: 1 \}\],[\s\S]*?duration: 280,[\s\S]*?cubic-bezier\(\.4,0,\.2,1\)/,
  "the fog should enter through compositor-friendly opacity keyframes",
);
assert.match(content, /function updateElementPickerFog\(state, targetRect = null\)/);
assert.match(content, /updateElementPickerFog\(state, targetRect\)/, "the hovered element should be cut out of the fog");
assert.doesNotMatch(content.match(/function startElementPicker[\s\S]*?(?=\n  const handlers)/)?.[0] || "", /green|#24845d/i);

assert.match(sidepanelTransport, /start_element_picker: \{ method: "ui\.startElementPicker", [^\n]*args: \(message\) => \[message\.tabId\]/);
assert.match(sidepanelTransport, /confirm_element_picker: \{ method: "ui\.confirmElementPicker", [^\n]*args: \(message\) => \[message\.tabId\]/);
assert.match(sidepanelTransport, /cancel_element_picker: \{ method: "ui\.cancelElementPicker", [^\n]*args: \(message\) => \[message\.tabId\]/);
assert.match(platformCommands, /function runElementPicker[\s\S]*sendToContent\(tab\.id, action\)/);
assert.doesNotMatch(serviceWorker, /element_picker_refocus_side_panel|element_picker_refocus/);
assert.match(sidepanel, /function confirmActiveElementPicker\(\)[\s\S]*sendRequest\("confirm_element_picker"/);


console.log("element picker tests passed");
