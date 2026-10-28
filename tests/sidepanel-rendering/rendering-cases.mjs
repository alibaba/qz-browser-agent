import assert from "node:assert/strict";
import { compileEmbeddedScript } from "../../scripts/build-extension.mjs";
import { capabilityUiAssets, discoverCapabilities } from "../../scripts/capability-catalog.mjs";
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createToolPresentationState, resolveToolPresentationActiveKey } from "../../src/sidepanel/features/chat/transcript/presentation-state.js";
import { buildSessionExportHtml, createSessionExportFeature } from "../../src/sidepanel/features/export/session-export-feature.js";
import { enrichSkillToolIdentity, getSkillToolUiMetaBySkillScript, setSkillToolUiCatalog } from "../../src/sidepanel/tools/skill-tool-ui-registry.js";
import { getToolDetailLayout, getToolDisplayName, getToolProfileFamily, getToolTimelineFamilyInfo } from "../../src/sidepanel/tools/tool-model.js";
import { groupConsecutiveToolTranscriptEntries } from "../../src/sidepanel/tools/tool-timeline-renderer.js";
import { createDeferred, waitFor } from "./helpers.mjs";

export function testToolPresentationState() {
  const state = createToolPresentationState();
  const first = toolEntry("turn:tool:1", "tool-1");
  const second = toolEntry("turn:tool:2", "tool-2", { isRunning: true });
  const [single] = groupConsecutiveToolTranscriptEntries([first]);
  const [grouped] = groupConsecutiveToolTranscriptEntries([first, second]);
  assert.equal(single._toolPresentationAnchor, grouped._toolPresentationAnchor);
  assert.deepEqual(state.resolve("session-1", single), {
    anchor: single._toolPresentationAnchor,
    userToggled: false,
    expanded: false,
    activeToolKey: "",
  });
  assert.equal(state.inspect("session-1", single), null, "default presentation must not allocate state");

  state.update("session-1", single, {
    userToggled: true,
    expanded: true,
    activeToolKey: first._uiKey,
  });
  assert.equal(state.resolve("session-other", single).userToggled, false, "presentation state must be session scoped");
  assert.deepEqual(state.resolve("session-1", grouped), {
    anchor: single._toolPresentationAnchor,
    userToggled: true,
    expanded: true,
    activeToolKey: "turn:tool:1",
  });

  state.update("session-1", grouped, { expanded: false, activeToolKey: "turn:tool:1" });
  const rebuilt = {
    ...grouped,
    entries: grouped.entries.map(tool => ({ ...tool })),
  };
  assert.equal(state.resolve("session-1", rebuilt).expanded, false);
  assert.equal(state.resolve("session-1", rebuilt).userToggled, true);
  state.forgetSession("session-1");
  assert.equal(state.resolve("session-1", rebuilt).userToggled, false);
}

export function testToolPresentationFallbacks() {
  const state = createToolPresentationState();
  const first = toolEntry("tool-key-1", "tool-1");
  state.update("session-2", first, { expanded: true, activeToolKey: first._uiKey });
  const groupedWithoutTurnAnchor = {
    type: "tool-group",
    entries: [first, toolEntry("tool-key-2", "tool-2")],
  };
  assert.equal(state.resolve("session-2", groupedWithoutTurnAnchor).expanded, true);
  assert.equal(state.resolve("session-2", groupedWithoutTurnAnchor).activeToolKey, first._uiKey);

  const runningFallback = [
    toolEntry("tool-key-2", "tool-2"),
    toolEntry("tool-key-3", "tool-3", { isRunning: true }),
    toolEntry("tool-key-4", "tool-4"),
  ];
  assert.equal(resolveToolPresentationActiveKey(runningFallback, first._uiKey), "tool-key-3");
  const latestFallback = runningFallback.map(tool => ({ ...tool, isRunning: false }));
  assert.equal(resolveToolPresentationActiveKey(latestFallback, first._uiKey), "tool-key-4");

  const anchored = createToolPresentationState();
  const original = {
    type: "tool-group",
    _toolPresentationAnchor: "stable-turn",
    entries: [toolEntry("removed-key", "removed")],
  };
  anchored.update("session-3", original, { expanded: true, activeToolKey: "removed-key" });
  const withRunningFallback = {
    type: "tool-group",
    _toolPresentationAnchor: "stable-turn",
    entries: runningFallback,
  };
  assert.equal(anchored.resolve("session-3", withRunningFallback).activeToolKey, "tool-key-3");
  const withLatestFallback = {
    ...withRunningFallback,
    entries: latestFallback.filter(tool => tool._uiKey !== "tool-key-3"),
  };
  assert.equal(anchored.resolve("session-3", withLatestFallback).activeToolKey, "tool-key-4");
}

function toolEntry(uiKey, toolCallId, extra = {}) {
  return {
    type: "tool",
    _uiKey: uiKey,
    toolCallId,
    runId: "run-1",
    name: "read_page",
    ...extra,
  };
}

export function testToolMetadataRegistry() {
  setSkillToolUiCatalog({
    plugins: [{
      id: "demo-plugin",
      skillName: "demo-skill",
      displayName: "示例扩展",
      tools: [{
        name: "demo__lookup",
        title: "查询示例",
        familyId: "research",
        familyTitle: "调研",
        profileFamily: "network",
        resultFamily: "table",
        detailLayout: "summary",
        script: "scripts/lookup.js",
      }],
    }],
  });
  try {
    const enriched = enrichSkillToolIdentity({ name: "demo__lookup", result: {} });
    assert.equal(getToolDisplayName(enriched), "查询示例");
    assert.equal(getToolProfileFamily(enriched), "network");
    assert.equal(getToolDetailLayout(enriched), "summary");
    assert.deepEqual(getToolTimelineFamilyInfo(enriched), { id: "research", label: "调研", shortLabel: "调研" });
    assert.equal(getSkillToolUiMetaBySkillScript("demo-skill", "/scripts\\lookup.js")?.tool.name, "demo__lookup");
  } finally {
    setSkillToolUiCatalog({});
  }
}

export async function testStaticDomContract() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sidepanelRoot = join(root, "src/sidepanel");
  const { overrides } = await capabilityUiAssets(join(root, "src"));
  const html = overrides.get(join(sidepanelRoot, "sidepanel.html")) || readFileSync(join(sidepanelRoot, "sidepanel.html"), "utf8");
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicateIds, []);

  // Counting template bodies with the active document also checks the identity set
  // after every package template is cloned once. Real mount/remount is covered in browser.
  const htmlIds = new Set(ids);
  const capabilities = discoverCapabilities(join(root, "src"));
  const product = JSON.parse(readFileSync(join(root, "src/products/manifest.json"), "utf8")).defaultProduct;
  const directories = [sidepanelRoot, join(root, `src/products/${product}/sidepanel`),
    ...new Set([...capabilities.ui, ...capabilities.renderers].map(dirname))];
  const sources = [...new Set(directories.flatMap(listJavaScriptFiles))].map(file => {
    const text = readFileSync(file, "utf8");
    return [file, file.endsWith(".ts") ? stripTypeScriptTypes(text, { mode: "transform" }) : text];
  });
  assert.ok(sources.some(([file]) => file.endsWith(".ts")), "the selector contract must scan actual TypeScript implementations");
  for (const [, source] of sources) {
    for (const match of source.matchAll(/(?:\bid\s*=\s*["']|\.id\s*=\s*["'])([A-Za-z][\w-]*)["']/g)) htmlIds.add(match[1]);
  }
  const missing = new Map();
  for (const [file, source] of sources) {
    for (const selectorMatch of source.matchAll(/(?:querySelector(?:All)?|\$|select)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (selectorMatch[1].includes("${")) continue; // Dynamic section/tool IDs are checked after real browser mounting.
      for (const idMatch of selectorMatch[1].matchAll(/#([A-Za-z][\w-]*)/g)) {
        if (!htmlIds.has(idMatch[1])) missing.set(idMatch[1], file);
      }
    }
  }
  assert.deepEqual([...missing.entries()], []);
}

function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(path));
    else if (entry.isFile() && /\.(?:js|ts)$/.test(path) && !/\.(?:min\.js|d\.ts)$/.test(path)) files.push(path);
  }
  return files;
}

export async function testSessionExportFeature() {
  const originalRuntimeSource = globalThis.SESSION_EXPORT_RUNTIME_SOURCE;
  globalThis.SESSION_EXPORT_RUNTIME_SOURCE = await compileEmbeddedScript({
    sourceDir: resolve("src"), entry: "sidepanel/features/export/session-export-runtime.ts",
  });
  const originalDocument = globalThis.document;
  const currentButton = createFakeButton();
  const listButton = createFakeButton({ id: "session-1" });
  const skinLink = {
    href: "https://extension.test/sidepanel/sidepanel.css",
    dataset: { qingzhouSkin: "default" },
    getAttribute: name => name === "href" ? "sidepanel.css" : null,
  };
  const root = {
    baseURI: "https://extension.test/sidepanel/sidepanel.html",
    createElement: createEscapingElement,
    querySelector(selector) {
      if (selector === "#btn-export-session") return currentButton;
      if (selector === "#qingzhou-sidepanel-skin") return skinLink;
      return null;
    },
    querySelectorAll(selector) {
      return selector === ".session-export-btn[data-id]" ? [listButton] : [];
    },
  };
  globalThis.document = root;

  const pendingRequest = createDeferred();
  const flashes = [];
  const feature = createSessionExportFeature({
    root,
    runtime: {
      getManifest: () => ({ version: "0.3.6" }),
      getURL: resource => {
        if (!resource) return "https://extension.test/";
        if (resource.startsWith("sidepanel/")) return `https://extension.test/${resource}`;
        return "data:image/png;base64,";
      },
    },
    fetchStylesheet: async url => ({
      ok: true,
      status: 200,
      text: async () => url.includes("custom")
        ? ".msg{color:teal}/* alternate-skin */"
        : ".msg{color:black}/* default-skin */",
    }),
    downloads: { download: async () => 1 },
    request: () => pendingRequest.promise,
    getCurrentSessionId: () => "session-1",
    renderChatHtml: () => '<article class="msg">静态消息</article>',
    flashAction: (_button, label) => flashes.push(label),
  });

  try {
    const documentResult = await feature.createDocumentFromSnapshot({
      session: { id: "session-1", title: "任务 / <导出>" },
      transcript: [{ type: "assistant", content: "完成" }],
      exportedAt: "2026-07-11 12:00:00",
    });
    assert.equal(documentResult.filename, "任务 导出.html");
    assert.match(documentResult.html, /<title>任务 \/ &lt;导出&gt;<\/title>/u);
    assert.match(documentResult.html, /<article class="msg">静态消息<\/article>/u);
    assert.match(documentResult.html, /data-qingzhou-skin="default"/u);
    assert.match(documentResult.html, /default-skin/u);
    assert.match(documentResult.html, /id="qingzhou-session-exchange"/u);
    const exportCtaIndex = documentResult.html.indexOf('id="qingzhou-session-cta"');
    const exchangePayloadIndex = documentResult.html.indexOf('id="qingzhou-session-exchange"');
    const exportBridgeIndex = documentResult.html.indexOf('qingzhou:session-export:probe');
    const messagesIndex = documentResult.html.indexOf('<main id="messages">');
    assert.ok(exportCtaIndex < exchangePayloadIndex);
    assert.ok(exchangePayloadIndex < exportBridgeIndex);
    assert.ok(exportBridgeIndex < messagesIndex, "export import bridge must initialize before the transcript body");
    assert.doesNotMatch(documentResult.html, /registry\.npmmirror\.com|chrome-extension:|moz-extension:|<script\s[^>]*\bsrc=/iu);
    const mathDocument = buildSessionExportHtml(
      { title: "公式导出" },
      documentResult.payload,
      {
        chatHtml: '<span class="math-formula math-inline">\\(E=mc^2\\)</span>',
        stylesheet: '.welcome-icon{background:url("../icons/logo-day.png") center / contain no-repeat}',
        brandAssets: { day: "data:image/png;base64,DAY", night: "data:image/png;base64,NIGHT", favicon: "data:image/png;base64,ICON" },
      },
    );
    assert.doesNotMatch(mathDocument, /registry\.npmmirror\.com|cdn\.jsdelivr\.net|<script\s[^>]*\bsrc=|chrome-extension:|moz-extension:|logo-day\.png/iu);
    assert.match(mathDocument, /url\("data:image\/png;base64,DAY"\)/u);
    assert.match(mathDocument, /\\\(E=mc\^2\\\)/u);
    assert.match(mathDocument, /id="qingzhou-session-exchange"/u);
    assert.match(mathDocument, /"format":"qingzhou\.session"/u);
    assert.match(mathDocument, /"version":1/u);
    assert.equal(documentResult.payload.app.version, "0.3.6");

    skinLink.href = "https://extension.test/sidepanel/sidepanel-custom.css";
    skinLink.dataset.qingzhouSkin = "custom";
    const reskinned = await feature.createDocumentFromSnapshot({
      session: { id: "session-1", title: "换肤导出" },
      transcript: [{ type: "assistant", content: "完成" }],
    });
    assert.match(reskinned.html, /data-qingzhou-skin="custom"/u);
    assert.match(reskinned.html, /data-qingzhou-skin-path="sidepanel\/sidepanel-custom\.css"/u);
    assert.match(reskinned.html, /alternate-skin/u);
    assert.doesNotMatch(reskinned.html, /default-skin/u);

    const exporting = feature.exportSession("session-1");
    await waitFor(() => currentButton.disabled && listButton.disabled);
    assert.equal(feature.isPreparing("session-1"), true);
    assert.equal(await feature.exportSession("session-1"), false, "duplicate exports must be coalesced");
    pendingRequest.reject(new Error("network failed"));
    await assert.rejects(exporting, /network failed/u);
    assert.equal(feature.isPreparing("session-1"), false);
    assert.equal(currentButton.disabled, false);
    assert.equal(listButton.disabled, false);

    currentButton.click();
    await waitFor(() => flashes.includes("导出失败"));
  } finally {
    feature.dispose();
    globalThis.document = originalDocument;
    if (originalRuntimeSource === undefined) delete globalThis.SESSION_EXPORT_RUNTIME_SOURCE;
    else globalThis.SESSION_EXPORT_RUNTIME_SOURCE = originalRuntimeSource;
  }
}

function createFakeButton(dataset = {}) {
  const attributes = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    dataset: { ...dataset },
    disabled: false,
    title: "",
    classList: {
      toggle(name, active) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    click() { for (const listener of listeners.get("click") || []) listener({ currentTarget: this }); },
  };
}

function createEscapingElement() {
  let text = "";
  return {
    get textContent() { return text; },
    set textContent(value) {
      text = String(value ?? "");
      this.innerHTML = text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    },
    innerHTML: "",
  };
}
