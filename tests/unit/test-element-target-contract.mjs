import "../support/default-locale.mjs";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT, VISUAL_SCREEN_ACTION_RULE } from "../../src/background/agent/prompts.js";
import { registerAccessibilityTools } from "../../src/capabilities/accessibility/tools.js";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { Agent } from "../../src/background/agent/agent.js";
import { createTestAgentOptions } from "../support/agent-services.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = path => {
  const sourcePath = existsSync(join(root, path)) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(join(root, sourcePath), "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code : source;
};
const toolsRuntime = read("src/background/tools/runtime.js");
const pageElementTools = read("src/capabilities/page/tools.js");
const mediaTools = read("src/capabilities/media/tools.js");
const screenActionRuntime = read("src/capabilities/media/screen-action-runtime.js");
const accessibilityTools = read("src/capabilities/accessibility/tools.js");
const elementRuntime = read("src/background/tools/element-runtime.js");
const tools = [toolsRuntime, elementRuntime, pageElementTools, mediaTools, accessibilityTools].join("\n");
const waitTools = read("src/capabilities/wait/tools.ts");
const prompt = SYSTEM_PROMPT;
globalThis.chrome ||= {};
const { resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
const browserOperationsRenderer = ["page", "bookmarks", "sessions", "diagnostics", "tabs", "wait"]
  .map(name => read(`src/capabilities/${name}/browser-operations.ts`)).join("\n");
const localization = read("src/shared/tools/tool-error-localization.ts") + read("src/shared/i18n/backend-messages.ts");
const contentScript = read("src/content/content-script.js");

assertTargetInfrastructure();
assertElementToolSchemasUseTarget();
assertSelectorFieldsAcceptTargetSyntax();
await assertPromptAndUiUseTarget();
assertElementActionClickContract();
assertElementActionRoutingContract();
assertAxTreeCompactContract();
assertFileInputHandoffContract();
assertFindElementsFilterContract();
assertNavigationWaitContract();
assertScreenshotDestinationContract();
assertScreenActionContract();
assertImageCandidateTargetContract();

console.log("element target contract tests passed");

function assertTargetInfrastructure() {
  assert.match(tools, /const ELEMENT_TARGET_GRAMMAR = 'target = "uid:" <element_uid> \| "css:" <css_selector>'/, "target grammar should be centralized");
  assert.match(tools, /function parseElementTarget\(target = ""\)/, "target parser should exist");
  assert.match(tools, /function resolveSelectorTarget\(tabId, selector = "", index = 0, context = \{\}\)/, "selector target compatibility helper should exist");
  assert.match(tools, /if \(!isElementTarget\(raw\)\) return \{ tabId, selector: raw \};/, "raw CSS selectors should remain valid selector arguments");
  assert.match(tools, /const ref = await resolveElementReference\(tabId, \{ target: raw, index \}, context\);/, "uid: selector arguments should resolve through the target resolver");
  assert.doesNotMatch(tools, /async function resolveElementReference\(tabId, \{[^}]*uid[^}]*selector/, "element resolver should not keep the old uid/selector argument pair");
}

function assertElementToolSchemasUseTarget() {
  assertToolUsesTargetOnly("inspect_element", { required: /\brequired: \["target"\]/ });
  assertToolUsesTargetOnly("act_on_element", { required: /\brequired: \["target", "action"\]/ });
  assertToolUsesTargetOnly("scroll_page");
  assertToolUsesTargetOnly("screenshot");
  assertToolUsesTargetOnly("read_image");
  const readImage = toolBlock("read_image");
  assert.match(resolveToolDefinition("read_image").description, /url 或 target 二选一/, "read_image should state its simple alternative-input contract");
  assert.doesNotMatch(readImage, /\banyOf\b/, "read_image should expose a provider-safe object schema");
}

function assertToolUsesTargetOnly(name, { required = null } = {}) {
  const block = toolBlock(name);
  assert.match(block, /\btarget: \{ type: "string"/, `${name} should expose target`);
  assert.doesNotMatch(block, /\buid: \{ type: "string"/, `${name} should not expose uid as a tool argument`);
  assert.doesNotMatch(block, /\bselector: \{ type: "string"/, `${name} should not expose selector as an element argument`);
  if (required) assert.match(block, required, `${name} should enforce target requirements`);
}

function assertSelectorFieldsAcceptTargetSyntax() {
  for (const name of ["read_article", "read_dom", "find_elements", "list_images"]) {
    const block = toolBlock(name);
    assert.match(resolveToolDefinition(name).parameters.properties.selector.description, /target 格式 css:\.\.\. \/ uid:\.\.\./, `${name} selector should document target syntax compatibility`);
  }
}

async function assertPromptAndUiUseTarget() {
  assert.match(prompt, /target = "uid:" <element_uid> \| "css:" <css_selector>/, "system prompt should teach the target grammar");
  assert.match(prompt, /target 不是自然语言/, "system prompt should warn against natural-language targets");
  assert.match(prompt, /\[css: <css_selector>\] 是用户通过鼠标点选页面元素生成的显式页面区域引用/, "system prompt should recognize user-picked page regions");
  assert.match(prompt, /把它作为当前关注范围：[\s\S]*inspect_element[\s\S]*get_ax_tree[\s\S]*read_article\/read_dom/, "system prompt should inspect the picked region before answering or acting");
  assert.match(prompt, /不要只凭 selector 字符串猜测，也不要无故把注意力转向全页其他区域/, "system prompt should keep attention on the picked region");
  assert.match(prompt, /selector 时表示 CSS 范围(?:\/|或)过滤条件，可传原始 CSS，也可传 target 格式/, "system prompt should define selector compatibility");
  assert.match(prompt, /点击或按 Enter 后用 pageAfter\/urlChanged\/titleChanged，或重新读取页面状态确认结果/, "system prompt should require page evidence to confirm click or Enter results");
  assert.match(prompt, /already_complete 只说明调用时页面已加载/, "system prompt should clarify wait_for_navigation already_complete");
  assert.doesNotMatch(read("src/background/agent/prompts/zh-CN.js"), /`(?:uid:|css:)/, "target examples in ESM template strings should avoid raw Markdown backticks");
  const registry = createToolRegistry();
  registerAccessibilityTools({ registerTool: registry.defineTool, elementTargetGrammar: "target" });
  const result = {
    snapshotId: "snapshot-1", nodes: [{ uid: "private-node" }],
    _display: { title: "UI-only tree" }, _debug: "internal", _rawCdp: { nodes: [] },
    actions: [{ target: "uid:button-1", uid: "button-1", role: "button", name: "Continue", text: "Continue" }],
  };
  const original = structuredClone(result);
  const projected = registry.get("get_ax_tree").model.projectResult(result);
  assert.equal(projected.actions[0].target, "uid:button-1", "registered AX projection preserves actionable target");
  assert.equal(Object.hasOwn(projected.actions[0], "uid"), false, "model actions do not expose bare uid");
  assert.equal(Object.hasOwn(projected, "nodes"), false, "the full AX tree stays outside model results");
  assert.equal(projected.snapshotId, "snapshot-1");
  assert.deepEqual(result, original, "model projection must preserve the UI's complete result");
  const requests = [];
  const agent = new Agent("ax-model-projection", createTestAgentOptions({
    tools: { getSchemas: () => [], getIdentity: () => ({}),
      getModelPolicy: name => registry.get(name)?.model || {}, execute: async () => result },
    llm: {
      async *chatStream(messages) {
        requests.push(structuredClone(messages));
        yield { type: "done", message: requests.length === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "ax-call", type: "function", function: { name: "get_ax_tree", arguments: "{}" } }] }
          : { role: "assistant", content: "done" } };
      },
      async chat() { throw new Error("Unexpected fallback"); },
    },
  }));
  await agent.prompt("Inspect available actions", {});
  const modelResult = JSON.parse(requests[1].find(message => message.role === "tool").content);
  assert.deepEqual(modelResult, { snapshotId: "snapshot-1", actions: [{ target: "uid:button-1", role: "button", name: "Continue", text: "Continue" }] },
    "Agent applies the registered projection and strips chat-only display and diagnostic fields");
  assert.deepEqual(result, original, "Agent sanitization must not modify the UI result");
  assert.match(browserOperationsRenderer, /data\.target \|\| args\.target/, "tool renderer should display target first");
  assert.match(localization, /缺少元素引用：请提供 target/, "localized errors should tell users to provide target");
}

function assertElementActionClickContract() {
  assert.match(tools, /scrollElementIntoView/, "act_on_element should scroll before clicking offscreen targets");
  assert.match(tools, /function clickPointReady\(inspection = \{\}\)/, "act_on_element should validate click readiness");
  assert.match(tools, /clickablePointInViewport/, "click readiness should check viewport-safe points");
  assert.match(tools, /clickDispatched: true/, "click result should expose clickDispatched");
  assert.match(tools, /pageBefore/, "click result should expose before page state");
  assert.match(tools, /pageAfter/, "click result should expose after page state");
  assert.match(tools, /urlChanged/, "click result should expose urlChanged");
  assert.match(tools, /CLICK_POINT_OUT_OF_VIEWPORT/, "click should fail clearly when the target remains offscreen");
}

function assertElementActionRoutingContract() {
  assert.match(tools, /sendToContent\(tabId, "actOnElement", \{ selector, index, elementAction: normalizedAction/, "act_on_element should not let element actions overwrite the content message route");
  assert.match(tools, /sendToContent\(tabId, "prepareElementFill"/, "fill should prepare the resolved editing surface before trusted input");
  assert.match(tools, /sendToContent\(tabId, "readElementActionState"/, "element mutations should read back the page's actual state");
  assert.match(tools, /sendToContent\(tabId, "actOnElement", \{ selector, index, elementAction: "press"/, "press fallback should use the elementAction payload field");
  assert.match(contentScript, /actOnElement\(\{ selector, index = 0, action, elementAction = ""/, "content actOnElement should read an explicit elementAction payload");
  assert.match(contentScript, /const op = String\(elementAction \|\| action \|\| ""\)\.trim\(\)/, "content actOnElement should keep direct handler compatibility");
  assert.match(contentScript, /if \(op === "select"\)/, "content actOnElement should support native select");
  assert.match(contentScript, /if \(op === "check" \|\| op === "uncheck"\)/, "content actOnElement should support checkable controls");
}

function assertAxTreeCompactContract() {
  const block = toolBlock("get_ax_tree");
  assert.match(resolveToolDefinition("get_ax_tree").description, /target（形如 uid:\.\.\.）原样传给 act_on_element/, "get_ax_tree should say that uid targets go to act_on_element unchanged");
  assert.match(resolveToolDefinition("get_ax_tree").description, /其下还有 N 行未展开/, "get_ax_tree should explain that N is unexpanded lines");
  assert.doesNotMatch(resolveToolDefinition("get_ax_tree").description, /t5493|保底|不计入 limit/, "get_ax_tree should not spell out uid format or budget exceptions");
  assert.match(resolveToolDefinition("get_ax_tree").description, /canvases\(name\/rect\/inViewport\/bitmapSize\)/, "get_ax_tree should advertise large Canvas discovery");
  assert.match(resolveToolDefinition("get_ax_tree").description, /视觉操作坐标必须以 screenshot\(\{actionable:true\}\) 返回的原始图片为准/, "get_ax_tree should distinguish CSS canvas hints from screen coordinates");
  assert.doesNotMatch(resolveToolDefinition("get_ax_tree").description, /actions\(target\/selector/, "get_ax_tree should not advertise selectors in actions");
  assert.doesNotMatch(resolveToolDefinition("get_ax_tree").description, /同时返回 actions/, "get_ax_tree should not advertise a separate actions list");
  assert.match(block, /root: \{ type: "string"/, "get_ax_tree should expose a root parameter for subtree expansion");
  assert.match(resolveToolDefinition("get_ax_tree").description, /root="root" 查看整页/, "get_ax_tree should document root=root");
  assert.match(resolveToolDefinition("get_ax_tree").description, /limit 使用 BFS 分配节点预算/, "get_ax_tree should document BFS budget semantics");
  assert.match(resolveToolDefinition("get_ax_tree").description, /\(truncated, N more\)/, "get_ax_tree should document truncated branch markers");
  assert.match(block, /resolveElementReference\(tabId, \{ target: requestedRoot \}/, "get_ax_tree should resolve uid/css roots through the target resolver");
  assert.match(block, /backendNodeIdForSelector\(targetTabId, overviewSelector, context\)/, "get_ax_tree should resolve css roots to backend nodes within the current run context");
  assert.match(block, /rootBackendNodeId/, "get_ax_tree should pass the resolved AX root into snapshot construction");
  assert.match(block, /const fetchDepth = snapshotScope === "viewport" \? (?:undefined|void 0) : rootBackendNodeId \? 40 : axDepth/, "get_ax_tree should search deep enough to find requested roots");
  assert.match(block, /maxDepth: axDepth/, "get_ax_tree subtree output should still respect the requested depth");
  assert.match(block, /selector: overviewSelector \|\| "body"/, "get_ax_tree actions/headings should be scoped to the requested root");
  assert.doesNotMatch(block, /actions: compactAxActionsForModel\(actions\)/, "get_ax_tree should not return a separate actions list");
  assert.doesNotMatch(block, /headings: compactAxHeadingsForModel/, "get_ax_tree should not return a headings list");
  assert.match(block, /canvases: compactAxCanvasesForModel/, "get_ax_tree should compact canvas summaries before returning to the model");
  assert.doesNotMatch(block, /nodes: ax\.nodes/, "get_ax_tree should not return the full node array");
  assert.match(tools, /function backendNodeIdForSelector\(tabId, selector, context = \{\}\)/, "css roots should be convertible to backend nodes within the current run");
  assert.match(tools, /send\("DOM\.querySelectorAll"[\s\S]*nodeIds\.length === 1[\s\S]*send\("DOM\.describeNode"/, "a non-unique selector must not bind the first node");
  assert.match(tools, /function buildAccessibilitySnapshot\(rawNodes, \{[\s\S]*rootBackendNodeId = 0/, "AX snapshot should support subtree roots");
  assert.match(tools, /function selectSemanticNodesByBreadth\(roots, limit, required\)/, "AX snapshot limit should use BFS budget selection");
  assert.match(tools, /selectSemanticNodesByBreadth\(semanticRoots, limit, required\)/, "AX snapshot should apply BFS selection before rendering");
  assert.match(tools, /\(truncated, \$\{omitted\} more\)/, "AX snapshot lines should expose omitted descendant counts");
  assert.match(tools, /truncatedNodeCount/, "AX snapshot should report omitted semantic node count");
  assert.doesNotMatch(tools, /function compactAxActionsForModel/, "get_ax_tree should not keep a separate action compactor");
  assert.doesNotMatch(tools, /function compactAxHeadingsForModel/, "get_ax_tree should not keep a headings compactor");
  const mergeStart = tools.indexOf("function mergeAction(node, action)");
  const mergeEnd = tools.indexOf("function hasFlag", mergeStart);
  assert.notEqual(mergeStart, -1, "missing action merge");
  const merge = tools.slice(mergeStart, mergeEnd);
  assert.doesNotMatch(merge, /\.\.\.action/, "AX action merge should whitelist fields instead of spreading selector-bearing action objects");
  assert.doesNotMatch(merge, /\bselector\b/, "AX action merge should not expose CSS selectors");
  assert.match(merge, /action\?\.name \|\| action\?\.text/, "AX action merge should preserve visible text");
  assert.match(merge, /typeof action\?\.checked === "boolean"/, "AX action merge should preserve checkbox state");
  assert.match(contentScript, /pageOverview\(\{ limit = 40, selector = "body" \}\)/, "pageOverview should accept a selector scope for AX subtree actions");
  assert.match(contentScript, /const actionElements = \[/, "pageOverview should collect root-scoped actions");
  assert.match(contentScript, /const canvasElements = \[/, "pageOverview should collect root-scoped canvases");
  assert.match(contentScript, /Math\.min\(rect\.width, rect\.height\) < 120 \|\| renderedArea < (?:40000|4e4)/, "pageOverview should ignore canvases that are small at rendered CSS size");
  assert.match(contentScript, /\.slice\(0, 8\)[\s\S]*\.map\(\(\{ renderedArea: _renderedArea, \.\.\.canvas \}\) => canvas\)/, "pageOverview should bound canvas summaries and remove internal ranking data");
  assertOrderedSubstrings(VISUAL_SCREEN_ACTION_RULE, [
    'get_ax_tree({root:"root"})',
    "act_on_element",
    "screenshot({actionable:true})",
    "act_on_screen",
  ], "system prompt should expose one ordered visual-action route");
  assert.doesNotMatch(tools, /context_store/, "get_ax_tree should not depend on context_store");
}

function assertOrderedSubstrings(value, expected, message) {
  let cursor = -1;
  for (const item of expected) {
    const index = value.indexOf(item, cursor + 1);
    assert.notEqual(index, -1, `${message}: missing ${item}`);
    assert.ok(index > cursor, `${message}: ${item} is out of order`);
    cursor = index;
  }
}

function assertFileInputHandoffContract() {
  const actBlock = toolBlock("act_on_element");
  assert.match(prompt, /任务需要上传本地文件时.*调用 wait_for_user/, "file handoff should be conditioned on the current task requiring a local file");
  assert.match(prompt, /检查 selectedFileCount 或页面反馈/, "the model should verify file selection after the user resumes");
  assert.match(resolveToolDefinition("wait_for_user").description, /本地文件选择等必须亲自操作的步骤/, "wait_for_user should cover user-owned local file selection");
  assert.match(resolveToolDefinition("act_on_element").description, /本地文件选择通过 wait_for_user 交给用户完成/, "act_on_element should route local file selection to wait_for_user");

  assert.match(contentScript, /type: item\.type/, "pageOverview actions should retain the input type");
  assert.match(contentScript, /selectedFileCount: item\.selectedFileCount/, "pageOverview actions should retain selected file count");
  const implicitRoles = read("src/content/implicit-aria-role.ts");
  assert.match(`${contentScript}\n${implicitRoles}`, /if \(type === "file"\) return "button"/, "file inputs should not be presented as textboxes");
  assert.match(contentScript, /String\(el\.type \|\| ""\)\.toLowerCase\(\) !== "file"/, "file inputs should not be presented as editable text fields");
  assert.match(tools, /inputType && inputType !== String\(compact\.role \|\| ""\)/, "AX snapshot should keep a useful input type");
  assert.match(tools, /Number\.isFinite\(Number\(action\?\.selectedFileCount\)\)/, "AX snapshot should keep file selection state");
}

function assertFindElementsFilterContract() {
  const block = toolBlock("find_elements");
  assert.doesNotMatch(block, /required: \["pattern"\]/, "find_elements should not require pattern when selector/tags/roles can list candidates");
  assert.doesNotMatch(resolveToolDefinition("find_elements").description, /可操作候选元素/, "find_elements should not describe the candidate set as action-only");
  assert.match(resolveToolDefinition("find_elements").description, /pattern 是可选过滤条件：不传 pattern 时会列出 selector\/tags\/roles\/types 命中的候选/, "find_elements should explain selector-first candidate discovery");
  assert.match(resolveToolDefinition("find_elements").description, /actionable\/inViewport/, "find_elements should document rank signals returned in summaries");
  assert.match(block, /pattern = ""/, "find_elements runtime should default pattern to an empty filter");
  assert.doesNotMatch(contentScript, /MISSING_PATTERN/, "content findElements should not reject empty pattern");
  assert.match(contentScript, /const patternText = String\(pattern \|\| ""\)\.trim\(\)/, "content findElements should normalize optional pattern");
  assert.match(contentScript, /const maxResults = clampNumber\(limit, 1, 100, 20\)/, "content findElements should clamp result limit");
  assert.match(contentScript, /eachElementWithinOpenShadow\(scope,\s*\(element\)\s*=>\s*\{\s*candidates\.push\(element\);\s*\}\)/, "content findElements should keep a broad DOM candidate set");
  assert.match(contentScript, /matchElementSearch\(regex, getElementSearchParts\(el, summary\)\)/, "content findElements should classify field-level matches");
  assert.match(contentScript, /\.sort\(compareElementCandidates\)/, "content findElements should rank candidates before returning");
  assert.match(contentScript, /matchKind/, "content findElements should expose matchKind");
  assert.match(contentScript, /score: Math\.round\(score\)/, "content findElements should expose a rounded score");
  assert.match(contentScript, /cssEscapeIdent\(current\.id\)/, "absolute selectors should escape element ids");
  assert.match(contentScript, /cssEscapeIdent\(cls\)/, "absolute selectors should escape class names");
  assert.match(contentScript, /summary\.actionable = isActionableElement\(el\)/, "find element summaries should expose actionability");
  assert.match(contentScript, /summary\.inViewport = isRectInViewport\(summary\.rect\)/, "find element summaries should expose viewport visibility");
}

function assertNavigationWaitContract() {
  assert.match(resolveToolDefinition("wait_for_navigation").description, /already_complete 只表示调用时页面已完成加载，不证明上一动作成功或失败/, "wait_for_navigation should not overstate already_complete");
  assert.match(waitTools, /fromUrl: \{ type: "string"/, "wait_for_navigation should accept fromUrl");
  assert.match(waitTools, /fromTitle: \{ type: "string"/, "wait_for_navigation should accept fromTitle");
  assert.match(waitTools, /waited: false/, "wait_for_navigation should expose waited=false when it did not wait");
  assert.match(waitTools, /urlChanged/, "wait_for_navigation should expose urlChanged from input state");
  assert.match(waitTools, /titleChanged/, "wait_for_navigation should expose titleChanged from input state");
}

function assertScreenshotDestinationContract() {
  const screenshotBlock = toolBlock("screenshot");
  const collectBlock = toolBlock("collect_images");
  assert.match(screenshotBlock, /destination: \{ type: "string"/, "screenshot should accept a flat destination parameter");
  assert.match(resolveToolDefinition("screenshot").description, /始终以图片形式返回给 LLM/, "screenshot should keep returning images to model context");
  assert.match(screenshotBlock, /saveScreenshotToImageCollection/, "screenshot should save through the image collection path when destination is present");
  assert.match(tools, /async function saveScreenshotToImageCollection/, "screenshot destination should use a dedicated save helper");
  assert.match(tools, /_image: shot\.dataUrl/, "screenshot should always return the image to context");
  assert.doesNotMatch(collectBlock, /"screenshot"/, "collect_images should not own screenshot collection mode");
  assert.match(collectBlock, /dedupField: \{ type: "string"/, "collect_images should expose dedupField for image collection upserts");
  assert.doesNotMatch(collectBlock, /keyField/, "collect_images should not expose the old keyField name");
  assert.doesNotMatch(tools, /captureImageCollectionScreenshot/, "collect_images should not keep screenshot-specific runtime");
  assert.match(prompt, /完成首次页面结构观察后，screenshot 可用于视觉确认并为 act_on_screen 提供坐标依据，传 destination 时会额外把截图保存为图集资产/, "system prompt should teach screenshot destination after structural observation");
  assert.match(prompt, /直接调用 screenshot 并传 destination=图集表名/, "system prompt should route screenshot saving to screenshot");
}

function assertScreenActionContract() {
  const screenshotBlock = toolBlock("screenshot");
  const actionBlock = toolBlock("act_on_screen");
  assert.match(screenshotBlock, /actionable: \{ type: "boolean"/, "viewport screenshots should opt into a coordinate context explicitly");
  assert.match(resolveToolDefinition("act_on_screen").description, /原始像素坐标/, "screen actions should use coordinates directly from the returned image");
  assert.match(resolveToolDefinition("act_on_screen").description, /coordinateSpace\.width\/height/, "screen actions should state the current image bounds");
  assert.match(actionBlock, /"long_press"/, "screen actions should expose long press as one atomic action");
  assert.match(actionBlock, /durationMs: \{ type: "number", minimum: 300, maximum: (?:5000|5e3)/, "long press should expose one bounded duration parameter");
  assert.match(actionBlock, /repeat: \{ type: "number", minimum: 1, maximum: 20/, "scroll should expose one bounded repeat count");
  assert.match(resolveToolDefinition("act_on_screen").description, /调用必须串行/, "screen actions should serialize physical input without making coordinates one-use");
  assert.match(actionBlock, /returnScreenshot: \{ type: "boolean"/, "screen actions should expose one explicit screenshot-return decision");
  assert.match(resolveToolDefinition("act_on_screen").description, /不带 x\/y 时无需预先截图：press\/type 操作当前焦点，scroll 在当前视口中心滚动/, "coordinate-free input should not require an input screenshot");
  assert.match(resolveToolDefinition("act_on_screen").description, /传 x\/y 时按截图坐标定位，type 先点击再输入/, "screen typing should make its optional focus coordinates explicit");
  assert.match(resolveToolDefinition("act_on_screen").description, /replace=true 且 text 为空表示清空/, "screen typing should expose clear as an intentional replace operation");
  assert.doesNotMatch(toolsRuntime, /type:\s*\["x",\s*"y"\]/, "the public preflight must not reintroduce coordinates for focused typing");
  assert.match(actionBlock, /required: \["action", "returnScreenshot"\]/, "screen actions should require the screenshot-return decision");
  assert.doesNotMatch(screenActionRuntime, /POST_ACTION_CAPTURE_SETTLE_MS|settleAfterDispatchedInput|waitForInputAcknowledgements/, "screen actions must not hide fixed sleeps or an unbounded acknowledgement barrier");
  assert.match(resolveToolDefinition("act_on_screen").parameters.properties.returnScreenshot.description, /需要观察本次操作结果时传 true；已验证且无需逐步观察的连续操作传 false/, "screen action screenshot choice should be stated as an Agent decision");
  assert.match(resolveToolDefinition("act_on_screen").description, /viewportChange 客观记录浏览器视口变化/, "screen actions should expose observable viewport facts");
  assert.match(resolveToolDefinition("act_on_screen").description, /coordinateBasisReady 表示当前坐标空间能否继续使用/, "screen action results should expose coordinate recovery state");
  assert.doesNotMatch(actionBlock, /\banyOf\b/, "screen actions should keep a provider-safe flat schema");
  assert.doesNotMatch(actionBlock, /\btarget: \{ type: "string"/, "screen actions should not depend on DOM targets");
  assert.doesNotMatch(actionBlock, /screenshotId: \{ type: "string"/, "screen actions should not make the model copy fragile frame ids");
  assert.match(resolveToolDefinition("act_on_screen").description, /最近一次 screenshot\(actionable=true\) 或 act_on_screen\(returnScreenshot:true\) 建立的坐标状态/, "screen actions should select the current scoped frame implicitly");
  assert.match(actionBlock, /screenActions\.act\(args, signal, context\)/, "the public tool should delegate to one screen-action runtime");
  assert.match(screenActionRuntime, /const coordinateIndependent = \["press", "type", "scroll"\]\.includes\(action\) && validated\.x == null/, "actions without screenshot coordinates should be independent of input screenshots");
  assert.match(screenActionRuntime, /const snapshot = coordinateIndependent \? null : resolve\(tabId, context\)/, "only coordinate-dependent screen actions should resolve the latest scoped frame");
  assert.match(screenActionRuntime, /requiredReturnScreenshot\(args\.returnScreenshot, ToolExecutionError\)/, "the runtime should reject omitted screenshot-return decisions before consuming a frame");
  assert.match(screenActionRuntime, /staleReason: stateChange\(expected, current\)/, "screen actions should reject changed viewports before dispatch");
  assert.match(screenActionRuntime, /const animate = context\.source !== "run_script"/, "only direct screen actions should produce animation frames");
  assert.match(screenActionRuntime, /if \(returnScreenshot\) \{[\s\S]*observation = await capture\(tabId,/, "only explicit observations should capture model feedback");
  assert.match(screenActionRuntime, /if \(animate && !afterImage\) \{[\s\S]*capturePresentationFrame/, "direct model-silent actions should still capture their animation post-frame");
  assert.match(screenActionRuntime, /_image: observation\.shot\.dataUrl/, "only observation results should enter the model media channel");
  assert.match(screenActionRuntime, /imageActionDisplay\(performed\.marker, \{[\s\S]*beforeImage,[\s\S]*afterImage/, "direct screen action animations should use one before/action/after projection");
  assert.match(mediaTools, /const SCREEN_ACTION_PREVIEW_MAX_EDGE = 960;[\s\S]*createScreenActionPreview[\s\S]*resizeDataUrlToMaxSize/, "screen action animation frames should reuse the bounded image resize path");
  assert.doesNotMatch(screenActionRuntime, /\b(?:annotate|markerCross|markerRendered)\b/, "screen actions must not burn action marks into model-visible image pixels");
  assert.match(screenActionRuntime, /function releaseRun\(sessionId, runId\)[\s\S]*snapshotsByScope\.delete\(key\)/, "run teardown should release retained coordinate and display frames");
  assert.match(mediaTools, /releaseRun:\s*runtime\.releaseRunScreenState/, "media capability should contribute screen-state cleanup to the run boundary");
  assert.match(toolsRuntime, /const \{ releaseRun, \.\.\.bridges \} = setup\(Object\.freeze\([\s\S]*if \(releaseRun\) capabilityRunCleanup\.push\(releaseRun\)/, "discovered capability cleanup should be registered by the tool runtime");
  const releaseRun = toolsRuntime.match(/async function releaseRunCdp\(sessionId, runId\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(releaseRun, "screen state and CDP leases should share the existing run resource boundary");
  assert.match(releaseRun, /for \(const \[index, release\] of capabilityRunCleanup\.entries\(\)\) \{\s*try \{\s*release\(sessionId, runId\);\s*\} catch \(error\) \{\s*try \{\s*diagnosticTrace\([^\n]+\);\s*\} catch \{\s*\}\s*\}\s*\}\s*return await releaseRunDebuggerConnections\(sessionId, runId\);\s*\}$/, "each extension cleanup and its diagnostics must be isolated before releasing CDP leases");
  assert.doesNotMatch(screenActionRuntime, /ATTACH_SETTLE_DELAYS_MS/, "capture stabilization should not introduce fixed waits");
  assert.match(screenActionRuntime, /const DEFAULT_LONG_PRESS_MS = 800;/, "long press should have a predictable default hold duration");
  assert.match(screenActionRuntime, /for \(let index = 0; index < prepared\.repeat; index \+= 1\)/, "scroll repeat should stay one bounded atomic screen action");
  assert.match(screenActionRuntime, /viewportChange: describeViewportChange\(current, actionStateAfter\)/, "screen actions should report observed viewport movement on every result path");
  assert.match(actionBlock, /"long_press"[^\n]*requireToolFields\("act_on_screen", args, \["x",\s*"y"\]/, "long press should require coordinates before reaching the runtime");
  assert.match(prompt, /没有可靠 target.*screenshot\(\{actionable:true\}\)/, "the prompt should reserve screen actions for visual-only controls");
  assert.match(prompt, /视觉动作序列遵循“验证后批量”/, "the prompt should teach one general verify-then-batch visual principle");
  assert.match(prompt, /效果符合预期、后续坐标可预测且浏览器视口稳定/, "the prompt should gate batching on evidence rather than action names");
  assert.match(prompt, /每步检查 coordinateBasisReady/, "the prompt should make visual batch recovery explicit");
  assert.match(prompt, /run_script 返回按执行顺序最后产生的观察图/, "the prompt should explain ordered last-observation feedback");
}

function assertImageCandidateTargetContract() {
  const listBlock = toolBlock("list_images");
  const collectBlock = toolBlock("collect_images");
  const capabilityHostStart = toolsRuntime.indexOf("const capabilityHost = Object.freeze({");
  assert.notEqual(capabilityHostStart, -1, "tool runtime should provide a shared capability host");
  const capabilityHostEnd = toolsRuntime.indexOf("\n});", capabilityHostStart);
  assert.notEqual(capabilityHostEnd, -1, "capability host should have an explicit dependency boundary");
  const capabilityHost = toolsRuntime.slice(capabilityHostStart, capabilityHostEnd);
  assert.match(capabilityHost, /\bgetSecurityGuardrails,/, "media tools should receive the security-rule reader from the composition root");
  assert.match(mediaTools, /registerMediaTools\(\{ \.\.\.host, \.\.\.host\.element \}\)/, "media capability should forward the shared host dependencies to its registrar");
  assert.match(mediaTools, /\bgetSecurityGuardrails,\n\s+assertTabAllowed:/, "media URL reads should declare their security-rule dependency");
  assert.match(resolveToolDefinition("list_images").description, /绑定当前 session、标签页、页面和图片地址的 target/, "list_images should return identity-bound image targets");
  assert.match(resolveToolDefinition("list_images").description, /index\/rank 仅用于阅读/, "list_images should keep ordinals display-only");
  assert.match(listBlock, /registerElementRef\(\{[\s\S]*imageSrc: item\.currentSrc \|\| item\.src/, "list_images should bind targets to the listed image source");
  assert.match(listBlock, /imageDiscoveryResultItem\(item, elementTargetForUid\(uid\)\)/, "list_images should expose registered uid targets through a bounded public projection");
  assert.match(mediaTools, /function imageDiscoveryResultItem[\s\S]*function imageSourceResultFields/, "list_images should project browser metadata through one bounded result path");
  assert.match(mediaTools, /function imageDiscoveryTextContext[\s\S]*const limits = \{[\s\S]*nearbyText: 400/, "image candidate context should use one bounded allowlisted projection");
  assert.match(contentScript, /context: getImageTextContext\(img\)/, "list_images should extract semantic context beside each image");
  assert.match(contentScript, /pageContext: getImagePageContext\(\)/, "list_images should expose page context once instead of repeating it per image");
  assert.match(mediaTools, /sourceKind: "embedded"[\s\S]*sourceOmitted: true/, "list_images should keep embedded image bytes behind the target reference");
  assert.doesNotMatch(listBlock, /return \{ \.\.\.item,/, "list_images should not copy raw srcset or data URLs into the model result");
  assert.match(collectBlock, /targets: \{ type: "array", items: \{ type: "string" \}/, "collect_images should accept explicit targets");
  assert.match(collectBlock, /urls: \{ type: "array", items: \{ type: "string" \}/, "collect_images should accept explicit URLs");
  assert.doesNotMatch(collectBlock, /\bindexes: \{/, "collect_images should not expose ordinal collection");
  assert.doesNotMatch(collectBlock, /\bselector: \{ type: "string"/, "collect_images should not expose selector scanning");
  assert.doesNotMatch(collectBlock, /\btabId: \{ type: "number"/, "collect_images should not expose a page-wide tab entry point");
  assert.doesNotMatch(collectBlock, /\b(?:minWidth|minHeight|visibleOnly|limit): \{/, "collect_images should not expose page scan controls");
  assert.match(collectBlock, /for \(const selectedTarget of targetList\)[\s\S]*resolveSelectedImageTarget\(selectedTarget, tabId, context\)[\s\S]*for \(const candidate of candidates\)/, "collect_images should resolve all targets before processing candidates for storage");
  assert.match(collectBlock, /resolveSelectedImageTarget\(selectedTarget, tabId, context\)/, "collect_images should resolve each explicit target");
  assert.match(collectBlock, /IMAGE_COLLECTION_ALL_FAILED/, "collect_images should report an all-failed selection as a tool failure");
  assert.match(collectBlock, /commitImageCollection\(tableName, readyRows\.map\(imageCollectionStoredRow\)/, "collect_images should only persist successfully saved image rows");
  assert.doesNotMatch(collectBlock, /rows\.push\(row\)/, "collect_images should not persist failed diagnostic attempts as gallery rows");
  assert.match(tools, /matched\.length !== 1[\s\S]*IMAGE_TARGET_NOT_SINGLE/, "target collection should require exactly one image");
  assert.match(tools, /function assertSelectedImageSource[\s\S]*currentSrc === expectedSrc[\s\S]*STALE_IMAGE_TARGET/, "target collection should reject changed image identity");
  assert.match(tools, /assertSelectedImageSource\(candidate, canvasResult \|\| \{\}\)/, "collection should recheck image identity after the page read");
  const readBlock = toolBlock("read_image");
  assert.match(readBlock, /assertSelectedImageSource\(\{[\s\S]*expectedSrc: String\(ref\.ref\?\.imageSrc/, "read_image should verify the listed image source before returning pixels");
  assert.doesNotMatch(readBlock, /if\s*\(\s*!Number\(ref\.ref\?\.backendNodeId/, "a backend node id must not skip the listed image source check");
  assert.match(contentScript, /let rawIndex = 0;/, "content script should track raw image indexes");
  assert.match(contentScript, /const candidateIndex = rawIndex\+\+;/, "raw image index should advance before filters");
  assert.match(contentScript, /index: candidateIndex,\n\s+rank: images\.length,/, "list_images should expose raw index and filtered rank");
  assert.match(contentScript, /scanned: rawIndex,/, "list_images should report scanned raw image count");
  assert.match(collectBlock, /required: \["table"\]/, "collect_images should require table in its model-facing schema");
  assert.match(collectBlock, /defaultableFields: \["table"\]/, "collect_images should tolerate missing table at runtime for legacy/edge calls");
  assert.match(collectBlock, /const tableName = resolveImageCollectionTableName\(table\)/, "collect_images should resolve missing table through a system default");
  assert.match(tools, /function defaultImageCollectionTableName\(\)/, "collect_images should generate a random default table name");
  assert.match(collectBlock, /tableDefaulted/, "collect_images result should expose whether the table name was defaulted");
}

function toolBlock(name) {
  const match = new RegExp(`^([ \t]*)registerTool\\(\\{\\s*name:\\s*"${name}"`, "m").exec(tools);
  assert.ok(match, `missing ${name} tool block`);
  const start = match.index;
  const end = tools.indexOf(`\n${match[1]}});`, start);
  assert.notEqual(end, -1, `unterminated ${name} tool block`);
  return tools.slice(start, end);
}
