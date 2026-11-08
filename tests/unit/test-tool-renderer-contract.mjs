import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
const stripTypes = source => stripTypeScriptTypes(source, { mode: "transform" });
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getCoreToolMetadata } from "../../src/shared/tools/tool-metadata.js";
import { resolveFamilyTimelineTarget } from "../../src/sidepanel/tools/timeline-navigation.js";
import { record } from "../../src/sidepanel/tools/renderer-input.js";
import { skillResultData, skillResultEnvelope } from "../../src/sidepanel/tools/primitives/skill-result-data.js";
import { formatLiveElapsedMs } from "../../src/sidepanel/features/sessions/session-format.js";
import { capabilityUiAssets, discoverCapabilities } from "../../scripts/capability-catalog.mjs";
import {
  isToolResultErrorLike,
  resolveToolState,
} from "../../src/sidepanel/tools/tool-model.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = path => stripTypes(readFileSync(join(root, "src", path), "utf8"));
const capabilityProfiles = (names, file) => names.map(name => stripTypeScriptTypes(
  readFileSync(join(root, `src/capabilities/${name}/${file}.ts`), "utf8"),
)).join("\n");
const renderer = [source("sidepanel/tools/tool-renderer.ts"), ...["tree-renderer", "diff-renderer", "skill-result-data"].map(name => source(`sidepanel/tools/primitives/${name}.ts`)), source("sidepanel/tools/primitives/profile-helpers.ts"),
  ...discoverCapabilities(join(root, "src")).renderers.map(path => stripTypes(readFileSync(path, "utf8"))),
].join("\n");
const timelineRenderer = stripTypes(readFileSync(join(root, "src/sidepanel/tools/tool-timeline-renderer.ts"), "utf8"));
const scriptProfile = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/script/profile.ts"), "utf8"));
const pluginProfile = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/ui/skill-tool-profile.ts"), "utf8"));
const mcpProfile = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/mcp/profile.ts"), "utf8"));
const browserContentProfile = capabilityProfiles(["wait", "tabs", "accessibility", "documents", "media"], "browser-content");
const browserOperationsProfile = capabilityProfiles(["page", "bookmarks", "sessions", "diagnostics", "tabs", "wait"], "browser-operations");
const skillsProfile = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/skills/profile.ts"), "utf8"));
const genericResultRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/tools/generic-result-renderer.ts"), "utf8"));
const toolRuntimeDetails = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/tools/tool-runtime-details.ts"), "utf8"));
const toolSources = [
  ...["sidepanel/tools/tool-args-preview.ts", "sidepanel/tools/skill-renderer-context.ts", "capabilities/sessions/session-details.ts", "sidepanel/tools/primitives/text-utils.ts", "capabilities/documents/preview.ts"]
    .map(path => stripTypes(readFileSync(join(root, "src", path), "utf8"))),
  capabilityProfiles(["skills", "tabs", "sessions", "settings", "page"], "presentation"),
  renderer,
  scriptProfile,
  pluginProfile,
  mcpProfile,
  browserContentProfile,
  browserOperationsProfile,
  skillsProfile,
  genericResultRenderer,
  toolRuntimeDetails,
].join("\n");
const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
const chatScrollFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-scroll-feature.ts"), "utf8"), { mode: "transform" });
const artifactFeature = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/sessions/artifacts/artifacts-feature.ts"), "utf8"), { mode: "transform" });
const sessionNavigationFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/sessions/session-navigation-feature.ts"), "utf8"), { mode: "transform" });
const appShellFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/app-shell-feature.ts"), "utf8"), { mode: "transform" });
const transcriptReconcileFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/recovery.ts"), "utf8"), { mode: "transform" });
const skillsFeature = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/skills/workspace/skills-feature.ts"), "utf8"), { mode: "transform" });
const toolPresentationStateSource = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/presentation-state.ts"), "utf8"), { mode: "transform" });
const sidepanel = [
  transcriptRenderer,
  chatScrollFeature,
  artifactFeature,
  sessionNavigationFeature,
  appShellFeature,
  transcriptReconcileFeature,
  skillsFeature,
].join("\n");
const sidepanelHtml = ["src/sidepanel/sidepanel.html", "src/capabilities/skills/ui.html"].map(path => readFileSync(join(root, path), "utf8")).join("\n");
const skinAssets = await capabilityUiAssets(join(root, "src"));
const css = [join(root, "src/sidepanel/sidepanel.css"), ...[...skinAssets.resources]
  .filter(path => path.startsWith(join(root, "src/capabilities/")) && path === join(dirname(path), "ui.css"))]
  .map(path => readStylesheetSource(path)).join("\n");
const visualTest = readFileSync(join(root, "tests/tool-timeline/visual-test.js"), "utf8");

testRunScriptRendererStaysQuiet();
testSkillBusinessMetadataBoundary();
testReadImagePreviewKeepsTransparentImagesReadable();
testStreamingDiffBlocksDoNotStretchSparseRows();
testToolDetailsStayLazyWhenCollapsed();
testMcpResultsUseSharedRendererShapes();
testPluginPreparingUiStaysUserFacing();
testStatGridLongValuesStayContained();
testToolUrlsDecodeDisplayOnly();
testTimelineSlotsRenderOnceAfterExpandPaint();
testTimelineRenderSignaturesGuardNoopPatches();
testToolPresentationStateOwnsDisclosure();
testToolStatusUsesSharedSemanticState();
testToolTimelinePagerUsesStableMenuColumn();
testToolTimelineNavigationModesStayDistinct();
testToolTimelineBatchesPreserveCallOrder();
testLongTimelineSummaryStaysCompact();
testResolvedWaitCardsUseSummaryLane();
testChatLaneWidthsAreSemantic();
testToolCardHeadersStickWhileScrolling();
testToolStickyHeadersUseRealElements();
testCollapsibleHeadersPreserveScrollAnchor();
testArtifactEntryStaysStableBeforeHydration();
testChatOpeningAvoidsIntermediateLayoutJumps();
testLiveChatRenderingAvoidsFullTranscriptWork();
testLiveTailIncludesOlderStreamingToolAfterUserAppend();
testChatBackfillYieldsToUserScroll();
testSkillEditorsWrapLongLines();
testSkillDocumentResourcesStayBinarySafe();
testToolCodeBlocksDoNotSoftWrapLongLines();
testRawToolDataKeepsOrdinaryFields();
testReadArticleUsesCanonicalMarkdownRenderer();
testReadDomUsesRawHtmlRenderer();
testAxTreeRendererKeepsSnapshotHierarchy();
testMinuteLevelTimersDropSubseconds();

console.log("tool renderer contract tests passed");

function testRunScriptRendererStaysQuiet() {
  const body = extractFunctionFromSource(scriptProfile, "render");

  assert.match(body, /appendScriptFeedback\(parent,\s*valueOnly \? source : envelope\)/, "run_script should read trace from its trusted host envelope");
  const feedback = [];
  const appendFeedback = vm.runInNewContext(`(${extractFunctionFromSource(scriptProfile, "appendScriptFeedback")})`, {
    presentation: {
      getResultEnvelope: value => value,
      record,
      appendScriptTrace: (_parent, trace) => feedback.push(["trace", trace]),
      appendCompactLine: (_parent, { title }) => feedback.push(["hint", title]),
    },
  });
  appendFeedback({}, { ok: true, result: 7, trace: ["complete"] });
  appendFeedback({}, { code: "SCRIPT_EVALUATION_FAILED", message: "Failed", details: { trace: ["failed"] }, hint: "Inspect the page." });
  appendFeedback({}, { error: "Historical error", trace: ["historical"] });
  appendFeedback({}, { result: { hint: "Business hint", trace: ["business"] }, _display: { script: { valueOnly: true, trace: ["host"] } } });
  assert.deepEqual(feedback, [["trace", ["complete"]], ["trace", ["failed"]], ["hint", "Inspect the page."], ["trace", ["historical"]], ["trace", ["host"]]]);
  assert.match(body, /genericRenderer\.appendJsonCodeBlock\(parent,\s*"result",\s*value\)/, "run_script should keep result rendering");
  assert.doesNotMatch(body, /appendScriptMeta|buildScriptResultMeta|tool-script-meta/, "run_script should not render low-value meta pills");
  assert.doesNotMatch(toolSources, /function appendScriptMeta|function buildScriptResultMeta/, "obsolete script meta helpers should be removed");
  assert.doesNotMatch(css, /\.tool-script-meta\b/, "obsolete script meta pill styles should be removed");
}

function testSkillBusinessMetadataBoundary() {
  const data = { _plugin: { title: "Business title" }, nested: { _plugin: "nested data" }, rows: [{ _plugin: 7 }] };
  const host = { ok: true, result: data, trace: [{ message: "Finished" }], _plugin: { title: "Host title", runtime: "inner" } };
  const before = structuredClone(host);
  for (const original of [host, { result: host }]) {
    assert.equal(skillResultData(data, original), data, "business data is not traversed or copied");
    assert.deepEqual(skillResultEnvelope(data, original), { ok: true, result: data, trace: host.trace });
  }
  assert.deepEqual(host, before, "presentation reads never mutate the stored transcript");
  for (const noEnvelope of [{ result: { _plugin: { value: "ordinary business data" } } }, { code: "business", result: 42 },
    { _plugin: { value: "raw business metadata" }, rows: data.rows }, { engine: "diesel", result: 7 }]) {
    assert.deepEqual(skillResultData(noEnvelope, noEnvelope), noEnvelope, "ordinary result/code fields do not create a host envelope");
    assert.deepEqual(skillResultEnvelope(noEnvelope, noEnvelope), noEnvelope);
  }
  assert.equal(skillResultData(0, { ok: true, result: 0, _plugin: host._plugin }), 0);
  const jsonText = '{"_plugin":"business","count":1}';
  assert.equal(skillResultData(JSON.parse(jsonText), { ok: true, result: jsonText, _plugin: host._plugin }), jsonText,
    "declarative data preserves the type of the script's returned string");
  const failure = { code: "SKILL_FAILED", message: "Could not read data", hint: "Try again", details: { line: 2 } };
  assert.equal(skillResultData(failure, failure), failure, "canonical failures remain failures");
  assert.equal(skillResultEnvelope(failure, failure), failure);
}

function testReadImagePreviewKeepsTransparentImagesReadable() {
  assert.equal(getCoreToolMetadata("read_image_asset").mediaPresentation, "asset", "image asset presentation should be declared centrally");
  assert.equal(getCoreToolMetadata("read_image").mediaPresentation, "asset", "read image presentation should be declared centrally");
  assert.match(renderer, /getToolMediaPresentation\(view\)[\s\S]*mediaPresentation === "asset"/, "image preview styling should consume shared presentation metadata");
  assert.doesNotMatch(renderer, /\.name === "read_image"|\.name === "read_image_asset"/, "renderer should not infer image presentation from tool names");
  assert.match(renderer, /tool-image-preview/, "read image tools should use a dedicated preview surface");
  assert.match(css, /\.tool-image-preview\s*\{[\s\S]*background-image:/, "read image preview should expose transparent images on a neutral surface");
}

function testStreamingDiffBlocksDoNotStretchSparseRows() {
  const diffBlock = css.match(/\.tool-diff-block\s*\{[\s\S]*?\n\}/);
  assert.ok(diffBlock, "should find shared diff preview block styles");
  assert.doesNotMatch(
    diffBlock[0],
    /display:\s*grid/,
    "streaming skill diff previews should not use grid rows, because fixed-height streaming blocks stretch sparse rows",
  );
  assert.match(
    css,
    /\.tool-details-streaming\.tool-details-update_skill \.tool-diff-block[\s\S]*?height:\s*clamp/,
    "update_skill streaming previews should keep their fixed viewport while line rows stay stable",
  );
  assert.match(
    css,
    /\.tool-details-update_skill \.tool-diff-block[\s\S]*?max-height:\s*clamp\(150px,\s*28vh,\s*240px\)/,
    "update_skill expanded previews should use the same compact scroll viewport as other streaming code panes",
  );
}

function testToolDetailsStayLazyWhenCollapsed() {
  assert.match(renderer, /const\s+toolEventStateByRoot\s*=\s*new\s+WeakMap\(\)/, "tool renderer should keep per-card render state outside the DOM");
  const renderBody = extractFunction("renderToolEvent");
  assert.match(renderBody, /const\s+view\s*=\s*createToolEventView\(tool,\s*options\)/, "renderToolEvent should build a lightweight view model first");
  assert.match(renderBody, /shouldRenderToolDetailsImmediately\(view\)/, "collapsed tool details should not render eagerly");

  const eagerBody = extractFunction("shouldRenderToolDetailsImmediately");
  assert.match(
    eagerBody,
    /return\s+view\.initiallyExpanded\s*\|\|\s*view\.options\.lazyDetails\s*===\s*false/,
    "only expanded tools or explicit opt-out should render details immediately",
  );

  const patchBody = extractFunction("patchToolEvent");
  assert.doesNotMatch(
    patchBody,
    /renderToolEvent\(tool\)/,
    "patchToolEvent should not build a complete replacement tool DOM before deciding what changed",
  );
  assert.match(
    patchBody,
    /if\s*\(shouldExpand\)\s*\{[\s\S]*renderToolDetailsInto\(details,\s*view/,
    "expanded tools should update the existing detail host",
  );
  assert.match(
    patchBody,
    /details\.dataset\.toolDetailsLazy\s*=\s*"true"/,
    "collapsed changed details should be marked stale and rendered on the next expand",
  );
}

function testMcpResultsUseSharedRendererShapes() {
  const profileBody = extractFunction("appendSkillToolProfile");
  assert.match(profileBody, /skillResultData\(result,\s*originalResult,\s*plugin\)/, "MCP renderer normalization should use catalog metadata even when an old transcript has no result metadata");
  const fallbackBody = extractFunction("appendMcpRendererFallback");
  assert.match(fallbackBody, /inferMcpStructuredRenderer\(data\.structuredContent\)/, "undeclared MCP structured results should enter the shared renderer selector");
  const inferBody = extractFunction("inferMcpStructuredRenderer");
  for (const type of ["markdown", "code", "image_grid", "tree", "diff", "article", "fields"]) {
    assert.match(inferBody, new RegExp(`type:\\s*["']${type}["']`), `MCP structured fallback should support ${type}`);
  }
  const arrayBody = extractFunction("inferMcpArrayRenderer");
  for (const type of ["chips", "image_grid", "tree", "list", "table", "records"]) {
    assert.match(arrayBody, new RegExp(`type:\\s*["']${type}["']`), `MCP array fallback should support ${type}`);
  }
  const spacingRule = extractCssRule(".tool-compact-line + .tool-friendly-section");
  assert.match(spacingRule, /margin-top:\s*8px/, "MCP fallback titles should receive the same top rhythm as their bottom title spacing");
  assert.match(spacingRule, /animation:\s*none/, "MCP fallback title spacing should stay balanced on every animation frame");
}

function testPluginPreparingUiStaysUserFacing() {
  const body = extractFunctionFromSource(pluginProfile, "appendSkillPreparingRenderer");
  assert.match(body, /status\.title/, "running Skill tools should keep the current semantic state");
  assert.match(body, /record\(plugin\?\.category\)\.label/, "running Skill tools should retain their business category");
  assert.match(body, /appendCompactParams/, "already parsed tool parameters should remain readable");
  assert.doesNotMatch(body, /展示契约|summarizeSkillRendererContract|rendererType/, "tool cards should not expose renderer implementation details");
  assert.doesNotMatch(body, /rawArgsText|参数片段|字符/, "tool cards should not expose raw streaming fragments or character counts");
}

function testStatGridLongValuesStayContained() {
  const body = extractFunctionFromSource(genericResultRenderer, "appendStatGrid");
  assert.match(body, /const\s+fullValue\s*=\s*summarizeValue\(item\.value,\s*1000\)/, "stat summaries should retain a complete hover value");
  assert.match(body, /<b title="\$\{escapeHtmlAttribute\(fullValue\)\}">/, "stat summaries should escape the complete hover value for an HTML attribute");
  const valueRule = extractCssRule(".tool-stat-item b");
  assert.match(valueRule, /max-width:\s*100%/, "stat values should stay within their grid cell");
  assert.match(valueRule, /overflow:\s*hidden/, "stat values should clip painted text at the cell boundary");
  assert.match(valueRule, /text-overflow:\s*ellipsis/, "stat values should signal clipped content");
  assert.match(valueRule, /white-space:\s*nowrap/, "stat values should keep compact one-line metrics");
}

function testToolUrlsDecodeDisplayOnly() {
  const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  const runtime = vm.runInNewContext(`
    ${extractFunction("decodeToolUrlForDisplay")}
    ${extractFunction("linkifyText")}
    ({ decodeToolUrlForDisplay, linkifyText });
  `, { String, decodeURI, escapeHtml });
  const rawUrl = "https://www.baidu.com/s?wd=%E6%9B%B2%E9%99%A2%E9%A3%8E%E8%8D%B7%26safe%3D1&src=qingzhou";
  const html = runtime.linkifyText(`页面已跳转 ${rawUrl}`);
  assert.match(html, /曲院风荷%26safe%3D1/, "tool URL labels should decode readable text without decoding structural delimiters");
  assert.match(html, /href="https:\/\/www\.baidu\.com\/s\?wd=%E6%9B%B2[^\"]*&amp;src=qingzhou"/, "tool URL hrefs should preserve their original encoded address");
  assert.equal(
    runtime.decodeToolUrlForDisplay("https://example.com/%E6%B5%8B%E8%AF%95/%E4%A"),
    "https://example.com/测试/%E4%A",
    "one malformed escape should not prevent other URL segments from becoming readable",
  );
}

function testTimelineSlotsRenderOnceAfterExpandPaint() {
  assert.match(
    timelineRenderer,
    /renderToolEvent\(activeTool,\s*\{\s*standaloneFooter:\s*false,\s*lazyDetails:\s*false,\s*deferMount:\s*true/,
    "tool timeline active slots should plan details without mounting disposable replacement instances",
  );
  const ensureBody = extractFunctionFromSource(timelineRenderer, "ensureToolTimelineActiveSlot");
  assert.match(
    ensureBody,
    /slot\.dataset\.toolTimelineSlotSignature\s*===\s*signature[\s\S]*return/,
    "tool timeline slots should reuse detail DOM while the group and active tool signatures stay unchanged",
  );
  assert.match(
    ensureBody,
    /if\s*\(!afterPaint\)[\s\S]*renderToolTimelineActiveSlot[\s\S]*requestAnimationFrame[\s\S]*setTimeout/,
    "first user expansion should let the expanded shell paint before rendering heavy detail content",
  );
  const handlerBody = extractFunctionFromSource(timelineRenderer, "attachToolTimelineGroupHandlers");
  assert.match(
    handlerBody,
    /ensureToolTimelineActiveSlot\([^;]+\{\s*afterPaint:\s*true\s*\}\)/,
    "tool timeline summary expansion should use the after-paint detail path",
  );
  const renderBody = extractFunctionFromSource(timelineRenderer, "renderToolTimelineActiveSlot");
  assert.match(
    renderBody,
    /delete\s+rawPanel\.dataset\.rawToolRendered[\s\S]*rawPanel\.replaceChildren\(\)/,
    "switching timeline steps should invalidate the previous raw panel materialization",
  );
}

function testTimelineRenderSignaturesGuardNoopPatches() {
  const toolPatchBody = extractFunctionFromSource(timelineRenderer, "patchToolTimelineGroupElement");
  assert.match(
    toolPatchBody,
    /const\s+nextSignature\s*=\s*toolTimelineGroupSignature\(entry\)[\s\S]*dataset\.toolTimelineSignature\s*===\s*nextSignature[\s\S]*rememberToolTimelineGroupRenderState\(el,\s*entry,\s*nextSignature,\s*options\)[\s\S]*return\s+true/,
    "tool timeline patching should skip unchanged render signatures before rebuilding expanded active slots",
  );
  assert.ok(
    toolPatchBody.indexOf("dataset.toolTimelineSignature === nextSignature") < toolPatchBody.indexOf("createToolTimelineGroupElement(entry"),
    "tool timeline no-op check should run before constructing a replacement timeline DOM",
  );

  const thinkingPatchBody = extractFunctionFromSource(timelineRenderer, "patchThinkingTimelineGroupElement");
  assert.match(
    thinkingPatchBody,
    /const\s+nextSignature\s*=\s*thinkingTimelineGroupSignature\(entry\)[\s\S]*dataset\.thinkingTimelineSignature\s*===\s*nextSignature[\s\S]*rememberThinkingTimelineGroupRenderState\(el,\s*entry,\s*nextSignature\)[\s\S]*return\s+true/,
    "thinking timeline patching should skip unchanged render signatures before rebuilding expanded active slots",
  );

  const toolSignatureBody = extractFunctionFromSource(timelineRenderer, "toolTimelineToolSignature");
  for (const field of [
    "statusText",
    "rateLimit",
    "argsState",
    "argsGenerating",
    "isError",
    "timestamp",
    "endedAt",
  ]) {
    assert.match(
      toolSignatureBody,
      new RegExp(`${field}:\\s*(?:Boolean\\()?entry\\.${field}`),
      `tool timeline render signature should include ${field}`,
    );
  }

  const thinkingSignatureBody = extractFunctionFromSource(timelineRenderer, "thinkingTimelineGroupSignature");
  for (const field of ["phase", "status", "isError", "endedAt"]) {
    assert.match(
      thinkingSignatureBody,
      new RegExp(`${field}:\\s*(?:Boolean\\()?thought\\?\\.${field}`),
      `thinking timeline render signature should include ${field}`,
    );
  }
}

function testToolPresentationStateOwnsDisclosure() {
  assert.match(toolPresentationStateSource, /const\s+aliasesBySession\s*=\s*new\s+Map\(\)/, "tool disclosure state should live outside transient DOM");
  assert.match(toolPresentationStateSource, /function\s+resolve\(sessionId,\s*entry\)[\s\S]*userToggled[\s\S]*expanded[\s\S]*activeToolKey/, "presentation state should resolve the complete disclosure model");
  assert.match(toolPresentationStateSource, /function\s+update\(sessionId,\s*entry,\s*patch\s*=\s*\{\}\)/, "presentation state should accept explicit user changes");
  assert.match(toolPresentationStateSource, /toolPresentationAliases[\s\S]*`turn:\$\{turnAnchor\}`[\s\S]*`tool:\$\{key\}`/, "standalone tools and upgraded timelines should share stable aliases");
  assert.match(toolPresentationStateSource, /resolveToolPresentationActiveKey[\s\S]*isActiveTool[\s\S]*entries\[entries\.length\s*-\s*1\]/, "a missing active tool should fall back to the running or latest tool");
  assert.match(transcriptRenderer, /const\s+toolPresentationState\s*=\s*createToolPresentationState\(\)/, "the transcript renderer should own one presentation state store");
  assert.match(transcriptRenderer, /const\s+presentationState\s*=\s*toolPresentationState\.resolve\(sessionId,\s*entry\)[\s\S]*onPresentationChange:\s*\(?patch\)?\s*=>\s*toolPresentationState\.update/, "single tools and timelines should receive controlled presentation state");
  assert.match(timelineRenderer, /const\s+presentationState\s*=\s*options\.presentationState[\s\S]*presentationState\.userToggled[\s\S]*presentationState\.expanded/, "timeline creation should derive disclosure from controlled state");
  assert.doesNotMatch(transcriptRenderer, /captureToolGroupTransitionState|toolGroupTransitionState/, "the refactor should not copy the legacy DOM handoff patch");
}

function testToolStatusUsesSharedSemanticState() {
  assert.equal(resolveToolState({ result: { ok: false, error: "failed" } }), "error");
  assert.equal(resolveToolState({ result: { code: "MISSING_REQUIRED_ARGUMENTS", message: "missing rows" } }), "error");
  assert.equal(resolveToolState({ isError: true, result: { ok: true } }), "error");
  assert.equal(resolveToolState({ isRunning: true, result: { ok: true } }), "running");
  assert.equal(resolveToolState({ phase: "aborted", result: { ok: false } }), "aborted");
  assert.equal(resolveToolState({ result: { ok: true, code: "OK" } }), "success");
  assert.equal(isToolResultErrorLike({ code: "SUCCESS", message: "done" }), false);
  assert.equal(isToolResultErrorLike({ code: "INVALID_ARGUMENTS", message: "bad input" }), true);
  assert.equal(resolveToolState({ result: { code: "BUSINESS_CONFLICT", message: "Retry with fresh data" } }), "error");

  assert.match(
    renderer,
    /resolveToolState\(tool/,
    "standalone tool cards should use the shared single-tool state resolver",
  );
  assert.match(toolRuntimeDetails, /toolPresentationRegistry\.project\("resultIsError"/,
    "result semantics should come from the capability-owned presentation contract");
  assert.doesNotMatch(toolRuntimeDetails, /profileFamily === "script"|isSuccessfulRunScriptEnvelopeForStatus/,
    "the runtime shell must not interpret one concrete capability's payload");
  // Success-envelope, explicit-failure and abort behavior are exercised in test-tool-result-presentation.mjs.
  assert.doesNotMatch(
    renderer,
    /function\s+isErrorLike\(/,
    "tool renderer should not keep a private error-like detector",
  );
  assert.match(
    timelineRenderer,
    /function\s+resolveTimelineToolState\(tool\)[\s\S]*resolveToolState\(tool\)/,
    "timeline pills should derive each single tool state from the shared resolver",
  );
  assert.match(
    timelineRenderer,
    /function\s+toolTimelineTone\(tools\)[\s\S]*toolTimelineToneFromTool\(latestTimelineTool\(tools\)\)/,
    "timeline group tone should still be based on the latest tool, not error-priority aggregation",
  );
  assert.doesNotMatch(
    timelineRenderer,
    /function\s+toolTimelineStepState\(/,
    "timeline should not keep a second single-tool state implementation",
  );
}

function testToolTimelinePagerUsesStableMenuColumn() {
  const familyTrace = extractFunctionFromSource(timelineRenderer, "renderToolTimelineFamilyTrace");
  const familyPanel = extractFunctionFromSource(timelineRenderer, "renderToolFamilyPanel");
  const familyNav = extractFunctionFromSource(timelineRenderer, "updateToolTimelineFamilyPanelNav");
  const thinkingNav = extractFunctionFromSource(timelineRenderer, "renderThinkingTimelineSlotNav");
  const toolNav = extractFunctionFromSource(timelineRenderer, "renderToolTimelineSlotNav");

  assert.match(familyTrace, /tool-family-submenu[\s\S]*tool-family-panels[\s\S]*tool-family-panel-nav/, "family mode should keep one persistent submenu pager host");
  assert.doesNotMatch(familyPanel, /tool-family-panel-head|tool-family-panel-nav/, "individual family panels should only render variable batch content");
  assert.match(familyNav, /querySelector\("\.tool-family-submenu > \.tool-family-panel-nav"\)/, "family navigation should update the persistent pager host");
  assert.doesNotMatch(familyNav, /querySelectorAll|activePanel/, "family navigation should not migrate between active panels");

  assert.match(extractCssRule(".tool-timeline-slot-head"), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--tool-timeline-pager-width\)/, "regular tool menus should reserve a stable pager column");
  assert.match(extractCssRule(".tool-family-submenu"), /position:\s*relative/, "family submenus should anchor one stable pager without reserving a full-height column");
  assert.match(extractCssRule(".tool-family-panel-nav"), /position:\s*absolute[\s\S]*top:\s*7px[\s\S]*right:\s*1px/, "family pager should occupy only the first submenu row");
  assert.match(extractCssRule(".tool-family-primary-batch"), /padding-right:\s*calc\(var\(--tool-timeline-pager-width\) \+ 8px\)/, "only the first batch row should reserve pager space");
  assert.match(thinkingNav, /timeline-pager thinking-group-slot-nav[\s\S]*qz-icon-btn qz-icon-btn--secondary qz-icon-btn--xs timeline-pager-btn thinking-group-nav-btn/, "thinking navigation should use the shared pager and compact icon primitive");
  assert.match(toolNav, /timeline-pager tool-timeline-slot-nav[\s\S]*qz-icon-btn qz-icon-btn--secondary qz-icon-btn--xs timeline-pager-btn tool-timeline-nav-btn/, "both levels of tool navigation should use the shared pager and compact icon primitive");
  assert.match(extractCssRule(".timeline-pager"), /grid-template-columns:\s*22px\s+30px\s+22px[\s\S]*gap:\s*4px[\s\S]*width:\s*82px/, "all pagers should share one fixed geometry");
  assert.match(css, /--control-height-xs:\s*22px/, "pager geometry should come from the shared compact control token");
  assert.match(css, /\.qz-icon-btn--xs\s*\{[\s\S]*?--qz-control-size:\s*var\(--control-height-xs\)/, "compact icon geometry should have one primitive definition");
  assert.doesNotMatch(timelineRenderer, /timelinePagerCounterWidth|--timeline-pager-counter-width/, "pager spacing should not vary with the current counter length");
  assert.doesNotMatch(css, /\.thinking-group-nav-btn\s*\{[\s\S]*?width:/, "thinking navigation should not keep a private geometry implementation");
  assert.doesNotMatch(css, /\.tool-timeline-nav-btn\s*\{[\s\S]*?width:/, "tool navigation should not keep a private geometry implementation");
  assert.match(extractCssRule(".tool-family-batch > span,\n.tool-family-batch > b"), /flex:\s*0 0 auto[\s\S]*white-space:\s*nowrap/, "batch tool names and counts should stay readable while parameters truncate");
  assert.match(extractCssRule("#messages"), /scrollbar-gutter:\s*stable/, "tool detail height changes should not resize the chat lane");
}

function testToolTimelineNavigationModesStayDistinct() {
  const navRuntime = vm.runInNewContext(`
    ${extractFunctionFromSource(timelineRenderer, "resolveToolTimelineNavTarget")}
    ({ resolveToolTimelineNavTarget });
  `, {
    Math,
    Number,
    resolveFamilyTimelineTarget,
    toolFamilyInfo: (toolOrName = "") => {
      const key = String(toolOrName?.name || toolOrName || "");
      if (key === "read_article" || key === "screenshot") return { id: "collect" };
      if (key === "run_script" || key === "network_body") return { id: "process" };
      return { id: "other" };
    },
  });
  const tools = [
    { name: "read_article" },
    { name: "run_script" },
    { name: "screenshot" },
    { name: "network_body" },
  ];
  assert.equal(navRuntime.resolveToolTimelineNavTarget(tools, 0, 1, "steps"), 1, "first-level timeline navigation should follow call order");
  assert.equal(navRuntime.resolveToolTimelineNavTarget(tools, 2, -1, "steps"), 1, "first-level previous navigation should follow call order");
  assert.equal(navRuntime.resolveToolTimelineNavTarget(tools, 0, 1, "family"), 2, "family navigation should prefer the next item in the same family");
  assert.equal(navRuntime.resolveToolTimelineNavTarget(tools, 2, 1, "family"), 1, "family navigation should cross boundaries in the same order as the family UI");
  assert.equal(navRuntime.resolveToolTimelineNavTarget(tools, 1, -1, "family"), 2, "family previous navigation should cross to the previous UI family");
  assert.equal(navRuntime.resolveToolTimelineNavTarget(tools, 0, 1), 2, "omitted navigation mode should preserve legacy family-aware behavior");

  assert.equal(resolveFamilyTimelineTarget([], 4, 1), 4, "an empty projection must not invent a selection");
  assert.equal(resolveFamilyTimelineTarget(["a", "b", "a", "b"], 0, -1), 0, "first family boundary stays put");
  assert.equal(resolveFamilyTimelineTarget(["a", "b", "a", "b"], 3, 1), 3, "last family boundary stays put");
  assert.equal(resolveFamilyTimelineTarget(["a", "b"], 0.5, 1), 0.5, "invalid fractional selection does not jump families");
  assert.equal(resolveFamilyTimelineTarget(["a", "b"], 1, 0), 1, "zero direction keeps the active item");

  const toolNav = extractFunctionFromSource(timelineRenderer, "renderToolTimelineSlotNav");
  assert.match(toolNav, /data-timeline-mode="\$\{escapeHtml\(familyMode \? "family" : "steps"\)\}"/, "each pager should carry its own navigation mode");
  assert.match(toolNav, /resolveToolTimelineNavTarget\(tools,\s*index,\s*-1,\s*mode\)/, "tool pager should pass render mode into previous navigation");
  assert.match(toolNav, /resolveToolTimelineNavTarget\(tools,\s*index,\s*1,\s*mode\)/, "tool pager should pass render mode into next navigation");
  const handlerBody = extractFunctionFromSource(timelineRenderer, "attachToolTimelineGroupHandlers");
  assert.match(
    handlerBody,
    /const\s+navHost\s*=\s*nav\.closest\("\.tool-timeline-slot-nav"\)[\s\S]*navHost\?\.dataset\.timelineMode \|\| details\?\.dataset\.timelineMode \|\| "family"/,
    "tool pager click handler should prefer the clicked pager mode and preserve family-aware fallback",
  );
  assert.match(
    handlerBody,
    /resolveToolTimelineNavTarget\(tools,\s*current,\s*direction,\s*navMode\)/,
    "tool pager click handler should pass the resolved pager mode into navigation",
  );
  const buildFamilies = extractFunctionFromSource(timelineRenderer, "buildToolTimelineFamilies");
  assert.match(buildFamilies, /indexes:\s*\[\]/, "family batches should keep every raw timeline index");
  assert.match(buildFamilies, /batch\.indexes\.push\(index\)/, "family batches should record each raw member index");
  const renderBatch = extractFunctionFromSource(timelineRenderer, "renderToolFamilyBatch");
  assert.match(renderBatch, /toolFamilyBatchIndexes\(batch\)/, "family batches should render from the full member index list");
  assert.match(renderBatch, /data-tool-timeline-indexes="\$\{escapeHtml\(indexes\.join\(","\)\)\}"/, "family batches should expose their member indexes for live active-state updates");
  const activeSlot = extractFunctionFromSource(timelineRenderer, "renderToolTimelineActiveSlot");
  assert.match(activeSlot, /timelineIndexListIncludes\(item\.dataset\.toolTimelineIndexes \|\| item\.dataset\.toolTimelineIndex,\s*index\)/, "family batch active state should stay on while paging within a merged batch");
}

function testToolTimelineBatchesPreserveCallOrder() {
  const buildFamilies = vm.runInNewContext(`(${extractFunctionFromSource(timelineRenderer, "buildToolTimelineFamilies")})`, {
    toolFamilyInfo: tool => ({ id: tool.family, label: tool.family, shortLabel: tool.family }),
    rawStepTarget: tool => tool.target,
  });
  const tools = [
    { name: "navigate", family: "arrival", target: "A" },
    { name: "read", family: "collect", target: "A" },
    { name: "navigate", family: "arrival", target: "A" },
    { name: "navigate", family: "arrival", target: "B" },
    { name: "navigate", family: "arrival", target: "A" },
  ];
  const families = JSON.parse(JSON.stringify(buildFamilies(tools)));
  assert.deepEqual(families.map(family => family.id), ["arrival", "collect"]);
  assert.deepEqual(families[0].batches.map(batch => ({ target: batch.target, indexes: batch.indexes, count: batch.count })), [
    { target: "A", indexes: [0, 2], count: 2 },
    { target: "B", indexes: [3], count: 1 },
    { target: "A", indexes: [4], count: 1 },
  ], "a return visit must remain after the intervening target; other families do not interrupt family traversal");
  assert.equal(families[0].latestIndex, 4, "opening the family still selects its newest call");
  assert.deepEqual(families[0].batches.flatMap(batch => batch.indexes), [0, 2, 3, 4], "visible batch order and paging order must agree");
}

function testResolvedWaitCardsUseSummaryLane() {
  // Concrete active/terminal lane behavior is exercised by waiting-card.spec.mjs.
  assert.match(extractFunctionFromSource(sidepanel, "createTranscriptElement"),
    /waitingCards\.create\(entry,\s*normalizeSessionId\(sessionId\)\)/, "wait creation belongs to the card boundary");
  assert.match(extractFunctionFromSource(sidepanel, "patchTranscriptElement"),
    /waitingCards\.patch\(el,\s*entry,\s*normalizeSessionId\(sessionId\)\)/, "live wait updates reuse the same card boundary");
}

function testChatLaneWidthsAreSemantic() {
  assert.match(css, /--lane-summary-width:\s*520px/, "summary lanes should have one shared maximum width");
  assert.match(css, /--lane-detail-width:\s*820px/, "expanded lanes should have one shared maximum width");
  assert.match(
    extractCssRule('.msg[data-chat-lane]'),
    /width:\s*min\(100%,\s*var\(--chat-lane-max\)\)[\s\S]*min-width:\s*0[\s\S]*max-width:\s*100%/,
    "outer transcript lanes should own width constraints",
  );
  assert.match(extractCssRule('.msg[data-chat-lane="summary"]'), /--chat-lane-max:\s*var\(--lane-summary-width\)/, "summary state should map to the summary token");
  assert.match(extractCssRule('.msg[data-chat-lane="detail"]'), /--chat-lane-max:\s*var\(--lane-detail-width\)/, "expanded state should map to the detail token");
  assert.match(extractCssRule('.msg[data-chat-lane="wide"]'), /--chat-lane-max:\s*100%/, "wide state should use the full conversation lane");

  for (const selector of [
    ".msg-tool.tool-expanded",
    ".msg-tool-timeline.tool-timeline-expanded",
    ".msg-thinking-group.thinking-group-expanded",
    ".thinking-group-details",
    ".compact-node",
    ".msg-artifacts",
  ]) {
    assert.doesNotMatch(extractCssRule(selector), /width:\s*min\(100%,\s*(?:520|620|640|720|820)px\)/, `${selector} should not own a private lane width`);
  }

  const laneMode = extractFunctionFromSource(renderer, "toolEventLaneMode");
  assert.match(laneMode, /if\s*\(!expanded\)\s*return\s*"summary"/, "collapsed tools should use summary lanes");
  assert.match(laneMode, /getToolDetailLayout\(identifiedTool\) === "wide"[\s\S]*getSkillRendererPresentationLane\(renderer \|\| \{\}\) === "wide"[\s\S]*\?\s*"wide"[\s\S]*:\s*"detail"/, "expanded tools should derive wide lanes from the complete shared renderer tree");
  assert.doesNotMatch(renderer, /WIDE_PLUGIN_RENDERER_TYPES/, "plugin lane policy should not be duplicated in the Side Panel renderer");
  assert.doesNotMatch(renderer, /WIDE_TOOL_NAMES/, "wide core tools should not be duplicated in the renderer");
  const timelineLane = extractFunctionFromSource(timelineRenderer, "toolTimelineLaneMode");
  assert.match(timelineLane, /some\(\(?tool\)?\s*=>\s*toolEventLaneMode\(tool,\s*true\)\s*===\s*"wide"\)/, "tool groups should choose one stable width from the complete group");
}

function testLongTimelineSummaryStaysCompact() {
  const summary = extractFunctionFromSource(timelineRenderer, "toolTimelineSummaryText");
  assert.match(
    summary,
    /options\.mode === "family"[\s\S]*title:\s*t\("toolExecutionOverview"\)[\s\S]*t\("toolFamilySteps",\s*\{\s*steps:\s*tools\.length,\s*families:\s*buildToolTimelineFamilies\(tools\)\.length/,
    "collapsed long timelines should summarize scale without repeating family labels",
  );
  assert.ok(
    summary.indexOf('options.mode === "family"') < summary.indexOf("toolTimelineEvidenceSummary(tools, activeTool)"),
    "family summaries should bypass the verbose evidence list",
  );
}

function testToolCardHeadersStickWhileScrolling() {
  assert.match(
    css,
    /\.msg-tool\.tool-expanded\s*\{[\s\S]*?overflow:\s*visible/,
    "expanded single tool cards should allow sticky headers to escape the card body",
  );
  assert.match(
    extractCssRule(".msg-tool.tool-expanded > .tool-summary"),
    /background:\s*color-mix\(in srgb,\s*var\(--bg-secondary\) 88%,\s*var\(--bg-primary\)\)/,
    "expanded single tool sticky headers should keep the established surface",
  );
  const stickyHeaderRule = css.match(/\.msg-tool\.tool-expanded > \.tool-summary,\s*\.msg-tool-timeline\.tool-timeline-expanded > \.tool-timeline-summary,\s*\.msg-thinking-group\.thinking-group-expanded > \.thinking-group-summary\s*\{[\s\S]*?\n\}/);
  assert.ok(stickyHeaderRule, "single tool, tool timeline, and thinking headers should share one real sticky rule");
  assert.match(stickyHeaderRule[0], /position:\s*sticky/, "expanded headers should stick using their real DOM nodes");
  assert.match(css, /--chat-sticky-offset:\s*0px/, "normal chat should keep the sticky offset at the scrollport top");
  assert.match(stickyHeaderRule[0], /top:\s*var\(--chat-sticky-offset\)/, "expanded headers should use the shared chat/export sticky offset");
  const stickyHeaderZ = Number(stickyHeaderRule[0].match(/z-index:\s*(\d+)/)?.[1] || 0);
  assert.ok(stickyHeaderZ > 4, "expanded headers should layer above sticky table cells in their body content");
  assert.match(
    extractCssRule(".tool-timeline-nav-area"),
    /position:\s*relative/,
    "tool group chip navigation should keep a neutral base position",
  );
  const timelineNavStickyRule = extractCssRule(".msg-tool-timeline.tool-timeline-expanded .tool-timeline-nav-area");
  assert.match(
    timelineNavStickyRule,
    /position:\s*sticky/,
    "expanded tool group chip navigation should also use its real DOM node for sticking",
  );
  assert.match(
    timelineNavStickyRule,
    /top:\s*calc\(var\(--chat-sticky-offset\)\s*\+\s*var\(--lane-header-height\)\)/,
    "tool group chips should stick below the real sticky header instead of sliding underneath it",
  );
  const timelineNavZ = Number(timelineNavStickyRule.match(/z-index:\s*(\d+)/)?.[1] || 0);
  assert.ok(timelineNavZ > 4, "tool group chips should layer above sticky table cells in the active detail body");
  assert.ok(timelineNavZ < stickyHeaderZ, "tool group chips should stay below the main sticky tool header layer");
}

function testToolStickyHeadersUseRealElements() {
  assert.match(
    extractCssRule("#messages"),
    /padding:\s*0 10px var\(--chat-tail-safe-bottom\)/,
    "messages top gap should not be padding, otherwise real sticky headers stop below the viewport top",
  );
  assert.match(
    extractCssRule("#messages::before"),
    /height:\s*calc\([\s\S]*--messages-top-gap[\s\S]*--viewport-anchor-before-space/,
    "messages should keep visual top breathing room through a spacer before content",
  );
  assert.doesNotMatch(
    css,
    /tool-sticky-summary-(?:proxy|source)/,
    "sticky tool headers should not use an overlay proxy or hide the real source header",
  );
  assert.doesNotMatch(
    sidepanel,
    /scheduleToolStickySummarySync|syncToolStickySummaryProxy|findToolStickySummaryTarget|shouldHideStickySummaryPreview|toolStickySummary/,
    "sidepanel should not run JS scroll synchronization for sticky headers",
  );
}

function testCollapsibleHeadersPreserveScrollAnchor() {
  assert.match(
    sidepanel,
    /messagesEl\.addEventListener\("click",\s*handleViewportAnchorClick,\s*\{\s*capture:\s*true\s*\}\)/,
    "collapsible headers should capture click position before component handlers run",
  );
  assert.match(sidepanel, /function\s+captureInteractionViewportAnchor\(\w+\)/, "sidepanel should capture anchors for viewport-changing interactions");
  assert.match(sidepanel, /function\s+captureViewportAnchorForElement\(\w+,\s*options\s*=\s*\{\}\)/, "real controls should capture anchors from the real element");
  assert.match(sidepanel, /function\s+restoreViewportAnchor\(\w+\)/, "sidepanel should restore viewport anchors through one shared algorithm");
  assert.doesNotMatch(sidepanel, /stickySummaryProxyVisualTopFor|suppressCollapsibleHeaderScrollAnchorCapture/, "scroll anchoring should not know about a sticky proxy");
  const resolveBody = extractFunctionFromSource(sidepanel, "resolveInteractionViewportAnchor");
  assert.match(resolveBody, /\.msg-tool > \.tool-summary/, "single tool summaries should be scroll anchors");
  assert.match(resolveBody, /\.msg-tool-timeline > \.tool-timeline-summary/, "tool timeline summaries should be scroll anchors");
  assert.match(resolveBody, /\.msg-thinking-group > \.thinking-group-summary/, "thinking summaries should be scroll anchors");
  assert.match(resolveBody, /\.tool-family-row/, "sticky timeline family rows should anchor their chip header while toggling");
  assert.match(resolveBody, /\.tool-timeline-nav-area/, "sticky timeline chip toggles should anchor the nav area");
  assert.match(resolveBody, /\.tool-timeline-slot-nav/, "tool timeline navigation should be eligible as a viewport anchor");
  assert.match(resolveBody, /findTranscriptElement\(transcriptKey\)[\s\S]*\.tool-timeline-slot-nav/, "anchors should survive card and detail DOM replacement");
  assert.match(resolveBody, /querySelectorAll\("\.msg-tool-timeline"\)[\s\S]*timelineGroupTools[\s\S]*activeToolKey/, "anchors should survive a streaming group key transition");
  assert.doesNotMatch(resolveBody, /lockScrollTop|kind:/, "control mapping should only select an anchor element, not an anchoring strategy");

  const clickBody = extractFunctionFromSource(sidepanel, "handleViewportAnchorClick");
  assert.match(clickBody, /setChatTailFollowing\(false\)[\s\S]*cancelScheduledChatTailScroll\(\)[\s\S]*acquireViewportLease\(anchor\)/, "every anchored interaction should acquire the same viewport lease");
  assert.doesNotMatch(clickBody, /isTimelinePager|holdTimelinePagerViewportAnchor/, "anchor behavior should not branch on a component name");

  const acquireBody = extractFunctionFromSource(sidepanel, "acquireViewportLease");
  assert.match(acquireBody, /releaseViewportLease\(\)[\s\S]*viewportLease = \{[\s\S]*anchor,[\s\S]*settling: true/, "acquiring an anchor should replace the previous lease atomically");
  const maintainBody = extractFunctionFromSource(sidepanel, "maintainViewportLease");
  assert.match(maintainBody, /!anchorElement[\s\S]*VIEWPORT_ANCHOR_MAX_SETTLE_MS[\s\S]*scheduleViewportLeaseFrame/, "temporary DOM replacement should retry the stable anchor resolver within the bounded settle window");
  assert.match(maintainBody, /restoreViewportAnchor\(lease\.anchor\)[\s\S]*VIEWPORT_ANCHOR_STABLE_FRAMES/, "the generic lease should restore geometry until layout settles");
  const releaseBody = extractFunctionFromSource(sidepanel, "releaseViewportLease");
  assert.match(releaseBody, /cancelViewportLeaseFrame\(viewportLease\)[\s\S]*setViewportAnchorBeforeSpace\(0\)[\s\S]*setViewportAnchorAfterSpace\(0\)/, "releasing a lease should cancel work and remove both range compensations");
  assert.doesNotMatch(chatScrollFeature, /lockScrollTop|kind:\s*"(?:reading|pager)"|TIMELINE_PAGER_ANCHOR|holdTimelinePagerViewportAnchor|maintainTimelinePagerViewportAnchor/, "the scroll owner should not contain component-specific policies");
  assert.match(css, /#messages::before\s*\{[\s\S]*var\(--viewport-anchor-before-space\)/, "the chat scroller should expose generic before-space compensation");
  assert.match(css, /#messages::after\s*\{[\s\S]*height:\s*var\(--viewport-anchor-after-space\)/, "the chat scroller should expose generic after-space compensation");
  assert.match(extractFunctionFromSource(sidepanel, "beginChatUserScroll"), /releaseViewportLease\(\)/, "direct user scrolling should release anchoring immediately");

  const timelinePatchBody = extractFunctionFromSource(sidepanel, "patchToolTimelineGroupTranscriptElement");
  assert.match(timelinePatchBody, /withToolTimelineViewportAnchor\(el,[\s\S]*patchToolTimelineGroupElement\(el,\s*entry,\s*toolPresentationOptions\(sessionId,\s*entry\)\)/, "streaming timeline patches should preserve the active viewport anchor");
  const patchAnchorBody = extractFunctionFromSource(sidepanel, "withToolTimelineViewportAnchor");
  assert.match(patchAnchorBody, /details\.dataset\.userToggled !== "true" \|\| scroll\.shouldFollowTail\(\)/, "automatic timeline patches should only anchor after explicit user interaction away from the chat tail");
  assert.match(patchAnchorBody, /scroll\.captureAnchorForElement\(navigation[\s\S]*scroll\.restoreAnchor\(anchor\)/, "streaming patches should reuse the shared viewport anchor primitive");
  const restoreAnchorBody = extractFunctionFromSource(sidepanel, "restoreViewportAnchor");
  assert.match(
    restoreAnchorBody,
    /const expectedScrollTop = Math\.max\(0, Number\(anchor\.scrollTop\)[\s\S]*Math\.abs\(elementDelta\) < 0\.5[\s\S]*expectedScrollTop/,
    "the same algorithm should recover scroll-range clamping when the anchor element itself did not move",
  );
  assert.match(restoreAnchorBody, /rawNextTop < 0[\s\S]*setViewportAnchorBeforeSpace/, "any anchor should receive before-space compensation at the top boundary");
  assert.match(
    restoreAnchorBody,
    /const currentTop = messagesEl\.scrollTop \|\| 0[\s\S]*currentTop \+ elementDelta[\s\S]*const nextTop = Math\.max\(0, rawNextTop\)[\s\S]*ensureViewportAnchorScrollRange\(nextTop\)[\s\S]*messagesEl\.scrollTop = nextTop/,
    "collapsing a block should compensate scrollTop by the header movement delta",
  );
  assert.match(
    extractFunctionFromSource(sidepanel, "syncScrollPosition"),
    /viewportLease\?\.anchor[\s\S]*viewportLease\.anchor\.scrollTop = chatLastScrollTop/,
    "intentional programmatic movement should advance the active lease baseline instead of being mistaken for browser clamping",
  );
  const rangeBody = extractFunctionFromSource(sidepanel, "ensureViewportAnchorScrollRange");
  assert.match(rangeBody, /setViewportAnchorAfterSpace[\s\S]*messagesEl\.clientHeight/, "short conversations should reserve enough generic after-space to avoid scroll clamping");

  const captureResizeAnchorBody = extractFunctionFromSource(chatScrollFeature, "captureViewportCenterAnchor");
  assert.match(captureResizeAnchorBody, /transcriptKey[\s\S]*findTranscriptElement\(transcriptKey\)/, "resize anchors should retain a stable transcript fallback");
  const beginResizeBody = extractFunctionFromSource(chatScrollFeature, "beginViewportResizeLease");
  assert.match(beginResizeBody, /viewportResizeLease\?\.anchor \|\| viewportCenterAnchor[\s\S]*lastWidthChangeAt/, "one resize transaction should retain one anchor while refreshing its quiet deadline");
  const maintainResizeBody = extractFunctionFromSource(chatScrollFeature, "maintainViewportResizeLease");
  assert.match(maintainResizeBody, /restoreViewportCenterAnchor\(lease\.anchor\)[\s\S]*lastWidthChangeAt[\s\S]*VIEWPORT_RESIZE_SETTLE_MS/, "resize anchoring should settle only after width changes become quiet");
  assert.doesNotMatch(chatScrollFeature, /VIEWPORT_RESIZE_(?:STABLE_FRAMES|MAX_SETTLE_MS)/, "continuous resize must not replace its anchor on an intermediate frame or absolute timeout");
}

function testArtifactEntryStaysStableBeforeHydration() {
  const body = extractFunctionFromSource(sidepanel, "withArtifactsTranscriptEntry");
  assert.match(
    body,
    /const\s+localSummary\s*=\s*model\.collectSessionArtifacts\(id,\s*base\)/,
    "artifact transcript entry should be derived synchronously from local transcript before runtime hydration",
  );
  assert.match(
    body,
    /if\s*\(!localSummary\.total\)\s*return\s+base;\s*return\s+\[\s*\.\.\.base,\s*createArtifactsTranscriptEntry\(id,\s*localSummary\)\s*\]/,
    "missing runtime hydration should not remove an already-known artifact card",
  );
  assert.match(
    body,
    /const\s+summary\s*=\s*getMergedSessionArtifactSummary\(id,\s*localSummary\)/,
    "hydrated artifacts should merge into the local transcript summary rather than replace the first paint contract",
  );
  assert.doesNotMatch(
    body,
    /requestSessionArtifactHydration\(/,
    "artifact transcript derivation should stay pure and never issue hydration requests while rendering",
  );
}

function testChatOpeningAvoidsIntermediateLayoutJumps() {
  assert.doesNotMatch(
    sidepanel,
    /chatLayoutCoordinator|createChatLayoutCoordinator|beginChatSessionTransition|syncMainTabState|加载对话|chat-session-loading|currentSessionTitleText/,
    "session opening should not depend on coordinator, loading copy, or split tab/title state",
  );

  const renderBody = extractFunctionFromSource(sidepanel, "renderChatTranscript");
  assert.match(
    renderBody,
    /const\s+renderIntent\s*=\s*resolveTranscriptRenderIntent\(id,\s*history,\s*\{\s*force,\s*intent\s*\}\)/,
    "transcript rendering should resolve a single explicit render intent after reading history",
  );
  assert.match(
    renderBody,
    /const\s+patched\s*=\s*!plan\.partial\s*&&\s*renderIntent\s*===\s*"tail"\s*&&\s*patchLiveTranscriptDomTail\(id,\s*renderedHistory\)/,
    "live rendering should try the insert/update-only tail path after deriving the visible transcript",
  );
  assert.match(
    renderBody,
    /createTranscriptRenderPlan\(id,\s*history,\s*\{\s*intent:\s*renderIntent\s*\}\)/,
    "full reconciliation and partial rendering should share the same render intent",
  );
  assert.doesNotMatch(
    renderBody,
    /if\s*\(renderIntent\s*===\s*"tail"\)\s*scheduleMissingSessionArtifactHydration\(id\)/,
    "transcript rendering should not schedule artifact hydration and cause unrelated structural renders",
  );

  const intentBody = extractFunctionFromSource(sidepanel, "resolveTranscriptRenderIntent");
  assert.match(
    intentBody,
    /if\s*\(intent\)\s*return\s+normalizeTranscriptRenderIntent\(intent\)/,
    "explicit render intent should win",
  );
  assert.match(
    intentBody,
    /if\s*\(force\s*&&\s*isWorkspaceBooting\(\)\)\s*return\s+"opening"/,
    "boot-time forced renders should preserve the opening tail",
  );
  const bootForceIndex = intentBody.indexOf("force && isWorkspaceBooting()");
  const snapshotForceIndex = intentBody.indexOf('if (force) return "snapshot"');
  assert.ok(
    bootForceIndex >= 0 && snapshotForceIndex > bootForceIndex,
    "the boot-time opening exception should precede the general forced snapshot fallback",
  );
  assert.match(
    intentBody,
    /return\s+isLiveTranscriptActive\(sessionId,\s*history\)\s*\?\s*"tail"\s*:\s*"snapshot"/,
    "implicit non-forced renders should use tail mode only for live sessions",
  );
  const normalizeIntentBody = extractFunctionFromSource(sidepanel, "normalizeTranscriptRenderIntent");
  assert.match(
    normalizeIntentBody,
    /value\s*===\s*"tail"\s*\|\|\s*value\s*===\s*"opening"/,
    "session opening should have an explicit render intent separate from live tail updates and snapshots",
  );

  const planBody = extractFunctionFromSource(sidepanel, "createTranscriptRenderPlan");
  const tailIndex = planBody.indexOf('if (renderIntent === "tail")');
  const snapshotIndex = planBody.indexOf('if (renderIntent === "snapshot")');
  assert.ok(tailIndex >= 0 && snapshotIndex > tailIndex, "tail plans should be considered before snapshot fallback");
  assert.match(
    planBody,
    /if\s*\(renderIntent\s*===\s*"tail"\)\s*\{[\s\S]*projection\.assignKeys\(id,\s*history\);[\s\S]*projection\.uiHistory\(history,\s*\{\s*sessionId:\s*id\s*\|\|\s*""\s*\}\)/,
    "live tail plans should derive directly from the canonical visible transcript",
  );
  assert.doesNotMatch(
    planBody,
    /createIncrementalTailTranscriptRenderPlan|liveTranscriptSourcePatchStart|previousPlan/,
    "live planning should not keep a second cached UI plan authority",
  );
  assert.match(
    planBody,
    /clearPartialTranscriptRender\(id\);\s*return\s+\{\s*history:\s*visibleHistory,\s*prefiltered:\s*true,\s*partial:\s*false\s*\}/,
    "snapshot renders should clear partial state and render the full UI plan",
  );
  const existingPartialIndex = planBody.indexOf("const existingPartial", snapshotIndex);
  const tailFirstIndex = planBody.indexOf("shouldTailFirstRenderTranscript", existingPartialIndex);
  assert.ok(
    existingPartialIndex > snapshotIndex && tailFirstIndex > existingPartialIndex,
    "opening plans should reuse partial state or start from the tail after snapshot handling",
  );

  const resetBody = extractFunctionFromSource(transcriptRenderer, "resetUi");
  assert.match(resetBody, /function\s+resetUi\(\)/, "resetUi should stay a simple chat reset");
  assert.match(resetBody, /messagesEl\.innerHTML\s*=\s*welcomeHTML/, "resetUi should not introduce an intermediate loading state");
  assert.match(resetBody, /messagesEl\.innerHTML\s*=\s*welcomeHTML;\s*showWelcome\(\);/u, "resetUi must restore the explicit landing presentation state");

  const transitionBody = extractFunctionFromSource(sessionNavigationFeature, "transitionToSession");
  assert.match(
    transitionBody,
    /await\s+Promise\.all\([\s\S]*options\.composer\?\.prepareSession\(next\)[\s\S]*mergeSessionRecord\?\.\(session\)[\s\S]*setCurrentSessionId\(next,\s*\{\s*composerDraft\s*\}\)/,
    "a Session transition should hydrate its Composer and source metadata before committing the visible identity",
  );
  const switchSessionBody = extractFunctionFromSource(sessionNavigationFeature, "switchToSession");
  assert.match(
    switchSessionBody,
    /const\s+switchEpoch\s*=[\s\S]*beginSessionTransition\(\);[\s\S]*if\s*\(!await\s+transitionToSession\(targetId,\s*\{\s*epoch:\s*switchEpoch,\s*signal\s*\}\)\)\s*return;[\s\S]*await\s+options\.perfTraceAsync\?\.\("session\.switch\.storageRecord"/,
    "session switching should hydrate its Composer before committing the latest selection and reading transcript storage",
  );
  assert.match(switchSessionBody, /if\s*\(signal\?\.aborted\s*\|\|\s*!isLatestSwitch\(switchEpoch,\s*targetId\)\)\s*return/, "stale session switch continuations should be discarded");
  assert.match(switchSessionBody, /options\.transcriptRenderer\.seedFromStorage\(targetId,\s*transcript\)/, "stored session history should only seed an empty target transcript");
  assert.match(switchSessionBody, /const\s+hasCachedTranscript\s*=\s*options\.transcriptRenderer\.hasTranscript\(targetId\)/, "session opening should distinguish warm in-memory navigation from cold storage hydration");
  assert.match(switchSessionBody, /if\s*\(pendingSessionRevealId\s*===\s*targetId\)\s*return/, "repeat clicks should not reveal a cold session before its first transcript is ready");
  assert.match(switchSessionBody, /if\s*\(hasCachedTranscript\)\s*revealSessionChat\(targetId\)/, "warm sessions should still open immediately");
  assert.doesNotMatch(switchSessionBody, /resetUi\(/, "cold session switching should never commit the welcome DOM directly");
  const hydrateIndex = switchSessionBody.indexOf("options.transcriptRenderer.seedFromStorage(targetId, transcript)");
  const deferredRevealIndex = switchSessionBody.indexOf("if (!hasCachedTranscript)", hydrateIndex);
  assert.ok(hydrateIndex >= 0 && deferredRevealIndex > hydrateIndex, "cold sessions should reveal Chat only after storage hydration has seeded the transcript");

  const revealBody = extractFunctionFromSource(sessionNavigationFeature, "revealSessionChat");
  assert.match(
    revealBody,
    /options\.resetUi\?\.\(\)[\s\S]*options\.switchToChatTab\?\.\(\{\s*refresh:\s*false\s*\}\)[\s\S]*refreshCurrentSessionTitle\(\)[\s\S]*options\.transcriptRenderer\.renderCurrent\(\{\s*intent:\s*"opening"\s*\}\)/,
    "session reveal should switch without an eager snapshot, restore its title, and render the opening tail atomically",
  );

  const switchTabBody = extractFunctionFromSource(appShellFeature, "switchTab");
  assert.match(
    switchTabBody,
    /if\s*\(tab\s*===\s*currentTab\)\s*return\s+false/,
    "tab switching should keep a single source of truth for active tab state",
  );
  assert.match(
    switchTabBody,
    /renderTab\(tab,\s*\{\s*refresh\s*\}\)/,
    "session reveal should be able to suppress the tab's eager transcript snapshot",
  );
  assert.doesNotMatch(
    switchTabBody,
    /markChatViewSettling|CHAT_VIEW_SETTLE|chatViewSettle/,
    "opening the chat tab should not depend on a timed settle window",
  );

  const hydrateBody = extractFunctionFromSource(artifactFeature, "requestSessionArtifactHydration");
  assert.doesNotMatch(
    hydrateBody,
    /chatViewSettleDelay|scheduleTranscriptCacheRender\(id,\s*\{\s*delay/,
    "artifact hydration should not wait on an opening settle timer",
  );

  const statusBody = extractFunctionFromSource(chatScrollFeature, "settleChatTailAfterDockLayout");
  assert.match(
    statusBody,
    /scrollToBottom\(\{\s*immediate:\s*true,\s*settle:\s*true/,
    "status and dock layout changes should use the shared tail scroll helper",
  );
}

function testLiveChatRenderingAvoidsFullTranscriptWork() {
  const renderBody = extractFunctionFromSource(sidepanel, "renderChatTranscript");
  assert.match(
    renderBody,
    /const\s+plan\s*=\s*perfTrace\("chat\.renderTranscript\.plan"[\s\S]*createTranscriptRenderPlan\(id,\s*history,\s*\{\s*intent:\s*renderIntent\s*\}\)/,
    "chat transcript rendering should first derive a complete UI plan",
  );
  assert.match(
    renderBody,
    /const\s+patched\s*=\s*!plan\.partial\s*&&\s*renderIntent\s*===\s*"tail"\s*&&\s*patchLiveTranscriptDomTail\(id,\s*renderedHistory\)/,
    "live rendering should use the visible transcript as the only UI plan",
  );
  assert.match(
    renderBody,
    /if\s*\(!patched\)\s*perfTrace\("chat\.renderTranscript\.reconcile"/,
    "live tail patch should fall back to a full reconcile when its anchor is invalid",
  );

  const liveTailBody = extractFunctionFromSource(sidepanel, "patchLiveTranscriptDomTail");
  assert.match(
    liveTailBody,
    /history\.findIndex\(isLiveVisibleTranscriptEntry\)/,
    "live tail patching should anchor around the first live visible node",
  );
  assert.match(
    liveTailBody,
    /for\s*\(let\s+index\s*=\s*patchStart;\s*index\s*<\s*history\.length/,
    "live tail patching should only walk the active tail",
  );
  assert.match(
    liveTailBody,
    /collectTranscriptDomByKey\(\)/,
    "live tail patching should still reuse keyed DOM nodes",
  );
  assert.match(
    liveTailBody,
    /isLivePatchDomCompatible\(history,\s*patchStart,\s*existingByKey\)/,
    "live tail patching should fall back to full reconcile when its DOM projection is stale",
  );
  const shapeFallbackBody = extractFunctionFromSource(sidepanel, "isLivePatchDomCompatible");
  assert.match(
    shapeFallbackBody,
    /existingKeys\[index\]\s*!==\s*desiredKeys\[index\]/,
    "live tail compatibility should require an exact stable prefix",
  );
  assert.match(
    shapeFallbackBody,
    /desiredTail[\s\S]*existingKeys\.slice\(start\)\.every/,
    "live tail compatibility should reject stale keys for every projection shape",
  );
  assert.doesNotMatch(
    liveTailBody,
    /retireTranscriptElement|removeStale|querySelectorAll\("\[data-transcript-key\]"\)|while\s*\(node\)/,
    "live tail patching should not delete transcript DOM nodes",
  );

  const mutateBody = extractFunctionFromSource(sidepanel, "mutateSessionTranscript");
  assert.doesNotMatch(
    mutateBody,
    /\.slice\(\)|setSessionTranscript\(id,\s*history\)/,
    "streaming transcript mutations should not copy and reset the whole transcript on every event",
  );
  assert.match(
    mutateBody,
    /markSessionTranscriptChanged\(id\)/,
    "streaming transcript mutations should still update transcript freshness markers",
  );
}

function testLiveTailIncludesOlderStreamingToolAfterUserAppend() {
  const activeBody = extractFunctionFromSource(sidepanel, "isLiveTranscriptActive");
  assert.match(
    activeBody,
    /history\.some\(projection\.isLiveEntry\)/,
    "live transcript detection should use the shared live-entry predicate",
  );

  const liveTailBody = extractFunctionFromSource(sidepanel, "patchLiveTranscriptDomTail");
  assert.match(
    liveTailBody,
    /Math\.max\(0,\s*firstLive\s*-\s*1\)/,
    "live tail patching should keep one stable anchor before the live node",
  );
  assert.match(
    liveTailBody,
    /isLiveVisibleTranscriptEntry/,
    "live tail patching should handle grouped live tool/thinking entries",
  );
  assert.doesNotMatch(
    sidepanel,
    /transcriptUiPlanHistoryBySessionId|transcriptUiPlanSnapshotBySessionId|patchChatTranscriptDomSuffix/,
    "live correctness should not depend on a second cached UI plan",
  );
  assert.doesNotMatch(
    sidepanel,
    /function\s+liveTranscriptTailStartIndex/,
    "live correctness should no longer depend on raw transcript tail-start math",
  );
}

function testChatBackfillYieldsToUserScroll() {
  const scrollBody = extractFunctionFromSource(sidepanel, "handleMessagesScroll");
  assert.match(
    scrollBody,
    /hasExplicitChatScrollIntent\(\)[\s\S]*beginChatUserScroll\(\)/,
    "only explicit chat scrolling should mark a short user-scroll window",
  );
  assert.match(
    extractFunctionFromSource(sidepanel, "beginChatUserScroll"),
    /releaseViewportLease\(\)[\s\S]*markChatUserScrollActive\(\)/,
    "manual chat scrolling should release anchoring before marking the user-scroll window",
  );

  const backfillBody = extractFunctionFromSource(sidepanel, "backfillPartialTranscript");
  assert.match(
    backfillBody,
    /scroll\.isUserScrolling\(\)\s*\|\|\s*isLiveTranscriptActive\(id,\s*sessionTranscript\(id\)\)/,
    "partial transcript backfill should yield while the user scrolls or a live run is updating",
  );
  assert.match(
    transcriptRenderer,
    /backfill\s*\(id\)\s*\{[\s\S]*catch\s*\(error\)\s*\{[\s\S]*clearPartialTranscriptRender\(id\);[\s\S]*scheduleTranscriptCacheRender\(id,\s*\{\s*delay:\s*0\s*\}\)/,
    "a failed backfill should discard presentation-only partial state and schedule snapshot recovery",
  );

  const reconcileBody = extractFunctionFromSource(transcriptReconcileFeature, "scheduleForCurrentSession");
  assert.match(
    reconcileBody,
    /options\.isUserScrolling\?\.\(\)\s*\?\s*Number\(options\.userScrollIdleMs\)\s*\|\|\s*400\s*:\s*400/,
    "runtime transcript reconcile should avoid interrupting active scrolling",
  );
}

function testMinuteLevelTimersDropSubseconds() {
  const parseBeijingDateTime = value => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  };
  const sidepanelTimers = { formatLiveElapsedMs };

  assert.equal(sidepanelTimers.formatLiveElapsedMs(59_900), "59.9s");
  assert.equal(sidepanelTimers.formatLiveElapsedMs(83_200), "1m 23s");
  assert.equal(sidepanelTimers.formatLiveElapsedMs(3_723_400), "1h 02m 03s");

  const timelineTimers = vm.runInNewContext(`
    ${extractFunctionFromSource(timelineRenderer, "firstPositiveNumber")}
    ${extractFunctionFromSource(timelineRenderer, "toolResultDurationSeconds")}
    ${extractFunctionFromSource(timelineRenderer, "toolTimelineResultDurationSeconds")}
    ${extractFunctionFromSource(timelineRenderer, "formatToolTimelineDurationSeconds")}
    ${extractFunctionFromSource(timelineRenderer, "toolTimelineDurationText")}
    ({ formatToolTimelineDurationSeconds, toolTimelineDurationText });
  `, { Date, Math, Number, String, parseBeijingDateTime, record, isToolAwaitingHuman: () => false });

  assert.equal(timelineTimers.formatToolTimelineDurationSeconds(9.4), "9.4s");
  assert.equal(timelineTimers.formatToolTimelineDurationSeconds(83.2), "1m 23s");
  assert.equal(
    timelineTimers.toolTimelineDurationText([
      { timestamp: "2026-06-30T00:00:00.000Z" },
      { timestamp: "2026-06-30T00:01:23.200Z", endedAt: "2026-06-30T00:01:23.200Z" },
    ]),
    "1m 23s",
  );
  assert.equal(
    timelineTimers.toolTimelineDurationText([
      {
        timestamp: "2026-06-30T00:00:00.000Z",
        endedAt: "2026-06-30T00:00:00.000Z",
        result: { ok: true, elapsedMs: 715, result: { ok: false } },
      },
    ]),
    "0.7s",
  );
  assert.equal(
    timelineTimers.toolTimelineDurationText([
      { result: { elapsedMs: 400 } },
      { result: { elapsedMs: 600 } },
    ]),
    "1.0s",
  );
}

function testSkillEditorsWrapLongLines() {
  assert.match(
    sidepanelHtml,
    /<textarea\s+id="skill-editor-text"[^>]*\bwrap="soft"/,
    "skill markdown editor textarea should wrap within the side panel",
  );
  const markdownEditorRule = css.match(/\.markdown-editor textarea,\s*\.markdown-editor pre\s*\{[\s\S]*?\n\}/);
  assert.ok(markdownEditorRule, "should find shared markdown editor code rule");
  assert.match(markdownEditorRule[0], /white-space:\s*pre-wrap;/, "skill markdown editor should preserve whitespace while wrapping lines");
  assert.match(markdownEditorRule[0], /overflow-wrap:\s*anywhere;/, "skill markdown editor should wrap long tokens");

  const resourceEditorRule = css.match(/\.skill-resource-edit-content,\s*\.skill-resource-edit-highlight\s*\{[\s\S]*?\n\}/);
  assert.ok(resourceEditorRule, "should find shared skill resource code rule");
  assert.match(resourceEditorRule[0], /white-space:\s*pre-wrap;/, "skill resource editor should preserve whitespace while wrapping lines");
  assert.match(resourceEditorRule[0], /overflow-wrap:\s*anywhere;/, "skill resource editor should wrap long tokens");
  assert.match(
    sidepanel,
    /\.wrap\s*=\s*"soft"/,
    "skill resource editor textarea should wrap within the side panel",
  );
}

function testSkillDocumentResourcesStayBinarySafe() {
  assert.match(
    skillsFeature,
    /const binary = active\.encoding === "base64"[\s\S]*content\.value = binary \? ""/,
    "skill editor should not expose a binary document's base64 payload as editable text",
  );
  assert.match(
    skillsFeature,
    /if \(draft\.encoding === "base64"\) return;/,
    "skill editor synchronization should preserve binary document bytes",
  );
  assert.match(
    skillsProfile,
    /documentInfo && Array\.isArray\(data\.rows\)[\s\S]*appendDataRowsTable\(parent, String\(data\.sheetName \|\| t\("tablePreview"\)\), data\.rows\)/,
    "load_skill_resource should render parsed spreadsheets through the shared table presentation",
  );
  assert.match(
    skillsProfile,
    /documentInfo && content[\s\S]*appendTextSection\(parent, t\("documentPreview"\), content\)/,
    "load_skill_resource should render parsed documents through the shared text presentation",
  );
  assert.match(
    skillsProfile,
    /docModelId[\s\S]*t\("docmodelidLoadQingzhouDocumentsThenUseDocumentReadChunkTo",\s*\{\s*id:/,
    "truncated skill documents should show the existing document continuation path",
  );
}

function testToolCodeBlocksDoNotSoftWrapLongLines() {
  const codeLikeRule = css.match(/\.tool-detail-section \.copyable-code-block pre,\s*\.tool-json-code-section \.copyable-code-block pre,\s*\.tool-raw-details \.copyable-code-block pre,\s*\.tool-timeline-raw-panel \.copyable-code-block pre,\s*\.tool-event-raw-panel \.copyable-code-block pre\s*\{[\s\S]*?\n\}/);
  assert.ok(codeLikeRule, "should find shared tool code block rule");
  assert.match(codeLikeRule[0], /white-space:\s*pre;/, "tool code/json/raw blocks should preserve long lines");
  assert.match(codeLikeRule[0], /word-break:\s*normal;/, "tool code/json/raw blocks should not break long tokens");
  assert.match(codeLikeRule[0], /overflow-wrap:\s*normal;/, "tool code/json/raw blocks should not soft-wrap long lines");
  assert.match(codeLikeRule[0], /overflow:\s*auto;/, "tool code/json/raw blocks should scroll within the card");
}

function testRawToolDataKeepsOrdinaryFields() {
  const rawContentBody = extractFunction("createRawToolContent");
  const compactBody = extractFunction("compactRawToolValue");
  assert.match(
    rawContentBody,
    /compactRawToolValue\(rawArgsText\)/,
    "raw tool args text should pass through the same bounded preview logic as structured values",
  );
  assert.doesNotMatch(
    compactBody,
    /isSensitiveRawDisplayKey|isRedactedDisplayValue|api.?key|authorization|password|secret|access.?token|refresh.?token/i,
    "raw tool data should not branch on credential-shaped field names or values",
  );
  assert.match(
    compactBody,
    /out\[key\] = compactRawToolValue\(item, depth \+ 1, key\)/,
    "raw tool objects should keep every ordinary field in the bounded preview",
  );
  assert.match(
    compactBody,
    /depth >= 4\) return summarizeValue\(value/,
    "deep raw values may still use the generic size-bounded summary",
  );
  assert.doesNotMatch(css, /\.tool-(?:secret|redacted)\b/, "credential-shaped fields should not introduce a separate visual system");
}

function testReadArticleUsesCanonicalMarkdownRenderer() {
  const articleBody = extractFunction("appendArticleBody");
  const sanitizer = extractFunction("sanitizeArticleMarkdownHtml");
  assert.match(
    renderer,
    /import \{ renderMarkdown as renderMarkdownHtml \} from "\.\.\/features\/chat\/markdown-feature\.js";/,
    "read_article should reuse the existing QZ Markdown renderer",
  );
  assert.match(
    renderer,
    /const renderMarkdown = \(?value\)?\s*=>\s*renderMarkdownHtml\(value,\s*\{\s*math: false\s*\}\)/,
    "article Markdown should disable math heuristics while using the shared renderer",
  );
  assert.match(articleBody, /tool-article-body qz-markdown/, "article details should opt into the shared Markdown skin");
  assert.match(articleBody, /sanitizeArticleMarkdownHtml\(rendered\)/, "article HTML should be sanitized after Markdown rendering");
  assert.doesNotMatch(articleBody, /\.format|format\s*===/, "article rendering should not branch on a format field");
  assert.match(sanitizer, /ARTICLE_MARKDOWN_ALLOWED_TAGS/, "article sanitizer should use an explicit element allowlist");
  assert.match(sanitizer, /ARTICLE_MARKDOWN_DROP_TAGS/, "active content should be removed rather than unwrapped");
  assert.match(browserOperationsProfile, /sanitizeArticleMarkdownUrl[\s\S]*"http:", "https:"/, "article URLs should be protocol filtered");
  assert.match(css, /:is\(\.msg-assistant \.msg-content, \.qz-markdown\) table/, "tool articles should share chat Markdown table styling");
  assert.match(css, /\.tool-article-body\.qz-markdown table[\s\S]*max-width:\s*none/, "wide article tables should scroll inside the bounded article surface");
}

function testReadDomUsesRawHtmlRenderer() {
  assert.equal(getCoreToolMetadata("read_dom").profileFamily, "domRaw", "read_dom should use raw HTML presentation");
  assert.ok(!getCoreToolMetadata("read_dom").sets.includes("pageTree"), "read_dom should not use pageTree presentation");
  assert.match(
    source("capabilities/page/renderers.ts"),
    /"domRaw":\s*resultProfile\(\(parent,\s*tool,\s*result,\s*originalResult\)\s*=>\s*page\.renderDomRaw\(parent,\s*tool\.args,\s*result\)/,
    "read_dom should use a dedicated DOM raw profile renderer",
  );
  assert.match(
    extractFunction("profileCapability"),
    /for \(const \[id,\s*projection\] of Object\.entries\(create\(createProfileHelpers\(host\),\s*host\)\)\)\s*\{\s*host\.registerRenderer\(host\.project\(id,\s*projection\)\)/,
    "capability profile maps should retain their exact ids and projections when registered",
  );
  const body = extractFunction("appendDomRawProfile");
  assert.match(body, /appendDomRawContent\(parent,\s*content\)/, "read_dom should render returned content as a code block");
  assert.match(body, /data\.showing[\s\S]*data\.totalLines[\s\S]*data\.hasMore/, "read_dom summary should expose line range and continuation state");
  assert.match(browserOperationsProfile, /className = "code-block tool-dom-content-block/, "read_dom DOM content should use a dedicated code block class");
  assert.match(css, /\.tool-details-read_dom \.tool-dom-content-block/, "read_dom code block should have bounded scroll styling");
  assert.match(visualTest, /function sampleDomResult/, "visual fixtures should use realistic read_dom line content");
}

function testAxTreeRendererKeepsSnapshotHierarchy() {
  const treeBody = extractFunction("buildTreeLines");
  const statsBody = extractFunction("formatPageTreeStats");
  const outlineIndex = treeBody.indexOf("const outline = result.snapshot");
  const actionsIndex = treeBody.indexOf("result.actions");
  assert.notEqual(outlineIndex, -1, "AX tree renderer should read snapshot/outlines");
  assert.equal(actionsIndex, -1, "AX tree renderer should not flatten the main tree from actions");
  assert.match(treeBody, /treeLineFromSnapshotText/, "snapshot lines should be parsed into tree rows");
  assert.match(statsBody, /truncatedNodeCount/, "AX tree renderer should expose truncated node count in compact stats");
  const snapshotLineBody = extractFunction("treeLineFromSnapshotText");
  const nodeMetaBody = extractFunction("formatTreeNodeMeta");
  assert.doesNotMatch(snapshotLineBody, /backendMatch/, "AX tree snapshot UI should not carry backend node ids into meta");
  assert.doesNotMatch(nodeMetaBody, /backendNodeId|#\$\{node\.backendNodeId\}/, "AX tree node meta should hide backend node ids");

  const profileBody = extractFunction("createTreeProfiles");
  assert.match(profileBody, /tree\.render\(parent,\s*args,\s*value,[\s\S]*appendDetails:\s*name === "get_ax_tree"\s*\?\s*\(section,\s*result\)\s*=>\s*appendAxActionsProfile\(section,\s*result\.actions\)/, "get_ax_tree actions should render as a separate summary through the generic tree extension");
  const actionsBody = extractFunction("appendAxActionsProfile");
  assert.match(actionsBody, /tool-ax-actions-table/, "AX actions should use a compact table shell");
  assert.match(actionsBody, /<th>\$\{escapeHtml\(t\("element"\)\)\}<\/th>[\s\S]*<th>target<\/th>[\s\S]*<th>\$\{escapeHtml\(t\("attributes"\)\)\}<\/th>/, "AX actions table should keep compact action columns");
  assert.doesNotMatch(actionsBody, /action\.href \? "链接"/, "AX action attributes should not duplicate link role with a generic link flag");
  assert.doesNotMatch(actionsBody, /appendSlimList/, "AX actions should not render as a tall slim list");
  assert.match(css, /\.tool-tree-panel > \.tool-ax-actions-table\s*\{[\s\S]*border-top:\s*1px solid var\(--border\)/, "AX actions table should be visually separated from the tree");
}

function extractFunction(name) {
  return extractFunctionFromSource(toolSources, name);
}

function extractCssRule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule ${selector}`);
  const braceStart = css.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated CSS rule ${selector}`);
}

function extractFunctionFromSource(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const parenStart = source.indexOf("(", start);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.notEqual(parenEnd, -1, `unterminated signature for ${name}`);
  const braceStart = source.indexOf("{", parenEnd);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}
