// Compare the main-branch get_ax_tree payload with this branch on local pages.
// Run: node --import tsx scripts/compare-ax-snapshots.mjs
// Token estimate is Math.ceil(JSON chars / 4). Char counts are measured.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(root, "tests/fixtures/ax-snapshot");
const routes = new Map([
  ["/forms/post", "pizza-form.html"],
  ["/", "books-home.html"],
  ["/catalogue/page-2.html", "books-catalogue.html"],
  ["/list", "long-list.html"],
  ["/modal", "form-modal.html"],
]);
const pages = [
  ["pizza form", "/forms/post"],
  ["books home", "/"],
  ["books catalogue", "/catalogue/page-2.html"],
  ["long list", "/list"],
  ["form modal", "/modal"],
];
const TAB_ID = 955493525;
let pageUrl = "";
globalThis.chrome = {
  runtime: { id: "extension-id" },
  tabs: { async get() { return { id: TAB_ID, url: pageUrl }; } },
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
};

const { createElementRuntime } = await import("../src/background/tools/element-runtime.js");
const { registerAccessibilityTools } = await import("../src/capabilities/accessibility/tools.js");
const { ToolExecutionError } = await import("../src/background/tools/arguments.js");
const { buildLegacyModelResult } = await import("./ax-snapshot-baseline.mjs");

const server = createServer(async (request, response) => {
  const file = routes.get(new URL(request.url || "/", "http://127.0.0.1").pathname);
  if (!file) { response.writeHead(404); response.end("missing"); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(await readFile(join(fixtureDir, file)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const refs = [];
const element = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies: () => ({
    sessions: {
      async resolveTargetTab() { return { ok: true }; },
      listOwnedTabIds: () => [TAB_ID],
    },
  }),
  makeSessionTabTargetError: (code, details) => new ToolExecutionError(code, code, details),
  async assertTabAllowed() {},
  async sendToContent() { return {}; },
  async withDebugger(_tabId, callback) { return callback({ tabId: TAB_ID }, async () => ({})); },
});
let overview = {};
let axNodes = [];
let bound = { loaderId: "", ids: [] };
let client = null;
let definition;
registerAccessibilityTools({
  registerTool: value => { definition = value; },
  ToolExecutionError,
  clampLimit: (value, min, max) => Math.max(min, Math.min(max, Math.floor(Number(value)))),
  makeSnapshotId: element.makeSnapshotId,
  makeElementUid: element.makeElementUid,
  elementTargetForUid: element.elementTargetForUid,
  registerElementRef: ref => { refs.push(ref); element.registerElementRef(ref); },
  resolveElementReference: element.resolveElementReference,
  backendNodeIdForSelector: async () => 0,
  bindBackendNodes: async () => bound,
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  sendToContent: async () => overview,
  callElement: async () => overview,
  withDebugger: async (_id, fn) => fn({}, async (method, params) => {
    if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
    return client.send(method, params || {});
  }),
  elementTargetGrammar: "target grammar",
});
const context = { sessionId: "compare", runId: "run" };

function collectOverview(limit) {
  const max = Math.max(5, Math.min(80, Number(limit) || 40));
  const actionSelector = "a[href],button,input,textarea,select,summary,[role],[onclick],[tabindex],[contenteditable='true']";
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const roleOf = el => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "file"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return "";
  };
  const useful = item => {
    if (item.disabled) return true;
    const roles = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "tab", "switch", "slider"]);
    if (item.editable || item.href || roles.has(item.role)) return true;
    if (item.tag === "button" || item.tag === "summary" || item.tag === "select") return true;
    if (item.role) return false;
    return Boolean(item.name || item.text || item.placeholder || item.value);
  };
  const selectorFor = el => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      const parent = current.parentElement;
      const same = parent ? [...parent.children].filter(child => child.tagName === current.tagName) : [];
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${Math.max(1, same.indexOf(current) + 1)})`);
      current = parent;
    }
    return parts.join(" > ");
  };
  const summary = el => {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    const labelled = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : "";
    const item = {
      selector: selectorFor(el),
      tag,
      role: roleOf(el),
      type,
      name: clean(el.getAttribute("aria-label") || el.getAttribute("alt") || "") || labelled,
      text: clean(el.textContent || "").slice(0, 160),
      value: "value" in el ? clean(el.value).slice(0, 160) : "",
      placeholder: el.getAttribute("placeholder") || "",
      href: el instanceof HTMLAnchorElement ? el.href : "",
      disabled: el.matches(":disabled"),
      editable: el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes((el.type || "").toLowerCase())) || el.isContentEditable,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    if ("checked" in el && (el.type === "checkbox" || el.type === "radio")) item.checked = !!el.checked;
    if (el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "file") {
      item.accept = el.accept || "";
      item.multiple = !!el.multiple;
      item.selectedFileCount = el.files?.length || 0;
    }
    item.inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    return item;
  };
  const actions = [...document.querySelectorAll(actionSelector)]
    .filter(visible)
    .map(summary)
    .filter(useful)
    .sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x))
    .slice(0, max)
    .map((item, index) => ({
      i: index, selector: item.selector, role: item.role || item.tag, type: item.type, name: item.name, text: item.text,
      value: item.value, placeholder: item.placeholder, href: item.href, disabled: !!item.disabled, editable: !!item.editable,
      checked: item.checked, accept: item.accept, multiple: item.multiple, selectedFileCount: item.selectedFileCount,
      rect: item.rect, inViewport: item.inViewport,
    }));
  const headings = [...document.querySelectorAll("h1,h2,h3,[role='heading']")]
    .filter(visible)
    .slice(0, 24)
    .map(el => ({
      level: Number(el.getAttribute("aria-level")) || Number(el.tagName.slice(1)) || null,
      text: clean(el.textContent).slice(0, 160),
    }))
    .filter(item => item.text);
  return {
    title: document.title,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight },
    headings,
    actions,
    canvases: [],
  };
}

async function bindSelectors(selectors) {
  const frame = await client.send("Page.getFrameTree");
  const loaderId = String(frame.frameTree?.frame?.loaderId || "");
  const doc = await client.send("DOM.getDocument", { depth: 0, pierce: true });
  const documentNodeId = Number(doc.root?.nodeId || 0);
  const ids = [];
  for (const selector of selectors) {
    if (!documentNodeId || !selector) { ids.push(0); continue; }
    const all = await client.send("DOM.querySelectorAll", { nodeId: documentNodeId, selector });
    const nodeIds = (all.nodeIds || []).map(Number).filter(id => id > 0);
    const nodeId = nodeIds.length === 1 ? nodeIds[0] : 0;
    if (!nodeId) { ids.push(0); continue; }
    const described = await client.send("DOM.describeNode", { nodeId });
    ids.push(Number(described.node?.backendNodeId || 0));
  }
  return { loaderId, ids };
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function measure(payload) {
  const json = JSON.stringify(payload);
  const snapshot = String(payload.snapshot || "");
  const uidChars = [...snapshot.matchAll(/uid:\S+/g)].reduce((sum, match) => sum + match[0].length, 0);
  return {
    chars: json.length,
    tokens: Math.ceil(json.length / 4),
    nodes: Number(payload.returnedNodeCount || 0),
    uidChars,
    uidShare: snapshot ? Number((uidChars / snapshot.length).toFixed(4)) : 0,
    truncatedLines: (snapshot.match(/\(truncated/g) || []).length,
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const rows = [];
try {
  for (const [name, path] of pages) {
    refs.length = 0;
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    overview = await page.evaluate(collectOverview, 40);
    pageUrl = overview.url;
    client = await page.context().newCDPSession(page);
    await client.send("Accessibility.enable");
    const ax = await client.send("Accessibility.getFullAXTree");
    axNodes = ax.nodes || [];
    bound = await bindSelectors((overview.actions || []).map(action => action.selector || ""));
    const legacyId = `t${TAB_ID}_${Date.now().toString(36)}`;
    const legacy = buildLegacyModelResult({
      rawNodes: axNodes,
      actions: overview.actions,
      headings: overview.headings,
      canvases: overview.canvases,
      tabId: TAB_ID,
      pageUrl: overview.url,
      title: overview.title,
      viewport: overview.viewport,
      snapshotId: legacyId,
      limit: 120,
      depth: 16,
    });
    const fresh = await definition.execute({ tabId: TAB_ID, limit: 120, depth: 16, actionsLimit: 40 }, null, context);
    const projected = definition.model.projectResult(fresh);
    const used = new Set();
    for (const [index, action] of (overview.actions || []).entries()) {
      const backend = Number(bound.ids[index] || 0);
      const text = clean(action.name || action.text || action.value);
      const ref = refs.find(item => !used.has(item.uid) && backend && Number(item.backendNodeId) === backend)
        || refs.find(item => !used.has(item.uid) && text && clean(item.name) === text);
      if (!ref) throw new Error(`${name}: action ${index} ${text || action.selector} is missing from the new tree`);
      used.add(ref.uid);
      const resolved = await element.resolveElementReference(TAB_ID, { target: `uid:${ref.uid}` }, context);
      if (resolved.uid !== ref.uid) throw new Error(`${name}: ${ref.uid} did not resolve`);
    }
    const main = measure(legacy.payload);
    const next = measure(projected);
    rows.push({
      page: name,
      actions: overview.actions.length,
      mainChars: main.chars,
      mainTokens: main.tokens,
      newChars: next.chars,
      newTokens: next.tokens,
      mainNodes: main.nodes,
      newNodes: next.nodes,
      mainUidShare: main.uidShare,
      newUidShare: next.uidShare,
      outOfTreeActions: legacy.outOfTreeActions,
      mainTruncatedLines: main.truncatedLines,
      newTruncatedLines: next.truncatedLines,
      legacyTruncatedNodes: legacy.truncatedNodeCount,
    });
    await client.detach();
    client = null;
  }
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

const header = "| Page | Main chars | Main tokens | New chars | New tokens | Saved chars | Main nodes | New nodes | Main uid share | New uid share | Main _a | Main truncated lines | New truncated lines |";
const divider = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
const body = rows.map(row => `| ${row.page} | ${row.mainChars} | ${row.mainTokens} | ${row.newChars} | ${row.newTokens} | ${row.mainChars - row.newChars} | ${row.mainNodes} | ${row.newNodes} | ${row.mainUidShare} | ${row.newUidShare} | ${row.outOfTreeActions} | ${row.mainTruncatedLines} | ${row.newTruncatedLines} |`);
const markdown = [header, divider, ...body].join("\n");
console.log(markdown);
console.log("Token estimate is Math.ceil(chars / 4). Char counts are the JSON payload returned to the model.");
const artifactDir = "/opt/cursor/artifacts";
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "ax-snapshot-compare.md"), `${markdown}\n`);
await writeFile(join(artifactDir, "ax-snapshot-compare.json"), JSON.stringify({ tokenEstimate: "Math.ceil(chars / 4)", rows }, null, 2));
