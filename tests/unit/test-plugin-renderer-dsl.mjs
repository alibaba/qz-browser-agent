import assert from "node:assert/strict";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
  normalizeSkillManifest,
} from "../../src/shared/skills/skill-manifest.js";
import {
  buildSkillRendererReturnContract,
  getSkillRendererPresentationLane,
  listSkillRendererDefinitions,
} from "../../src/shared/skills/skill-renderers.js";
import { createDeclarativeRenderer } from "../../src/sidepanel/tools/primitives/declarative-renderer.js";
import { withLanguage } from "../../src/shared/i18n/index.js";

const diagnostics = [];
const plugin = normalizeSkillManifest({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "renderer-dsl-test",
  displayName: "Renderer DSL Test",
  version: "0.1.0",
  tools: [{
    name: "inspect",
    title: "Inspect",
    description: "Exercise the renderer compiler",
    runtime: "inner",
    script: "scripts/inspect.js",
    renderer: {
      type: "summary",
      fields: [
        { label: "状态", path: "status" },
        { label: "缓存", value: false, format: "boolean" },
        { label: "配置", value: { keep: 1, omitted: undefined } },
        { label: "歧义", path: "ignored", value: 0 },
      ],
      layout: {
        type: "stack",
        blocks: [{
          type: "table",
          sourcePath: "data",
          itemsPath: "rows",
          totalPath: "totalRows",
          truncatedPath: "truncated",
          columns: [{ label: "ID", path: "id" }],
        }, {
          type: "code",
          title: "SQL",
          source: "args",
          valuePath: "sql",
          language: "sql",
        }],
      },
    },
  }, {
    name: "article",
    title: "Article",
    description: "Exercise article renderer fields",
    runtime: "inner",
    script: "scripts/article.js",
    renderer: {
      type: "article",
      titlePath: "headline",
      authorPath: "byline.name",
      timePath: "publishedAt",
      sourceNamePath: "site.name",
      urlPath: "canonicalUrl",
      bodyPath: "content.markdown",
      bodyFormat: "markdown",
      metaFields: [{ label: "点赞", path: "stats.likes" }],
      commentsPath: "answers",
      commentsTitle: "回答区",
      commentTitlePath: "title",
      commentAuthorPath: "author.name",
      commentBodyPath: "content",
      commentTimePath: "createdAt",
      commentMeta: [{ label: "身份", path: "role" }],
      maxBodyChars: 4096,
      maxComments: 8,
    },
  }],
}, {
  name: "renderer-dsl-test",
  displayName: "Renderer DSL Test",
  scope: "global",
}, diagnostics);

const renderer = plugin.tools[0].renderer;
assert.deepEqual(renderer, JSON.parse(JSON.stringify(renderer)), "compiled Renderer IR must survive a JSON wire round-trip exactly");
assert.equal(Object.prototype.hasOwnProperty.call(renderer, "maxItems"), false, "undefined optional values must not enter Renderer IR");
assert.deepEqual(renderer.fields[0], { label: "状态", path: "status" });
assert.deepEqual(renderer.fields[1], { label: "缓存", value: false, format: "boolean" });
assert.deepEqual(renderer.fields[2], { label: "配置", value: { keep: 1 } });
assert.deepEqual(renderer.fields[3], { label: "歧义", value: 0 }, "literal value has deterministic precedence over path");
assert.equal(diagnostics.length, 1);
assert.match(diagnostics[0].message, /cannot use both path and value/);

const article = plugin.tools[1].renderer;
assert.deepEqual(article, JSON.parse(JSON.stringify(article)), "article Renderer IR must also be JSON-safe");
assert.equal(article.sourcePath, "", "sourcePath remains reserved for selecting a layout block's data");
assert.equal(article.sourceNamePath, "site.name");
assert.equal(article.bodyPath, "content.markdown");
assert.equal(article.bodyFormat, "markdown");
assert.deepEqual(article.metaFields, [{ label: "点赞", path: "stats.likes" }]);
assert.deepEqual(article.commentMeta, [{ label: "身份", path: "role" }]);
assert.equal(article.maxBodyChars, 4096);
assert.equal(article.maxComments, 8);

const table = renderer.layout.blocks[0];
assert.equal(table.totalPath, "totalRows");
assert.equal(table.truncatedPath, "truncated");
const inputCode = renderer.layout.blocks[1];
assert.equal(inputCode.source, "args");
assert.equal(inputCode.valuePath, "sql");
assert.equal(inputCode.language, "sql");
assert.equal(getSkillRendererPresentationLane(renderer), "wide", "nested table primitives must make the complete layout wide");
assert.equal(getSkillRendererPresentationLane({ type: "summary", fields: [] }), "detail");
assert.equal(getSkillRendererPresentationLane({ type: "image_grid" }), "wide");
assert.equal(getSkillRendererPresentationLane({ type: "diff" }), "wide");

const contract = buildSkillRendererReturnContract(table);
assert.match(contract, /totalRows 表示完整结果行数/);
assert.match(contract, /truncated 表示当前 rows 是否被截断/);
const layoutContract = buildSkillRendererReturnContract(renderer);
assert.match(layoutContract, /工具输入 args\.sql: renderer=code/);
assert.doesNotMatch(layoutContract, /字段 sql: renderer=code/, "args-backed blocks must not become script return requirements");
const inputContract = buildSkillRendererReturnContract(inputCode);
assert.match(inputContract, /不要求脚本把输入复制到 return/);

// Public primitive descriptions, compiled IR, return guidance and layout agree for every primitive.
const defaultHints = {
  summary: "", compact: "", metrics: "", fields: "", chips: "chips", note: "note", text: "text",
  article: "title, author, publishedAt/time, source/site/platform, url/link/href, body/text/content, meta, comments/replies/answers, comments[].meta",
  list: "title, url", selection: "items, id, title", table: "rows", records: "records", image_grid: "images", tree: "nodes/lines",
  diff: "patch/diff/changes", markdown: "markdown", json: "", code: "code, language, filename", skill: "",
};
const publicDefinitions = listSkillRendererDefinitions();
assert.deepEqual(publicDefinitions.map(item => item.type).sort(), Object.keys(defaultHints).sort());
assert.deepEqual(publicDefinitions, JSON.parse(JSON.stringify(publicDefinitions)), "public discovery must not leak implementation callbacks");
for (const { type } of publicDefinitions) {
  const primitive = normalizeSkillManifest({
    format: SKILL_MANIFEST_FORMAT, schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    id: "primitive-test", displayName: "Primitive test", version: "0.1.0",
    tools: [{ name: "inspect", description: "Inspect data", runtime: "inner", script: "scripts/inspect.js", renderer: { type } }],
  }, { name: "primitive-test", scope: "global" }).tools[0].renderer;
  assert.equal(primitive.type, type, `compiler must retain ${type}`);
  const nested = { type: "summary", layout: { type: "stack", blocks: [primitive] } };
  const hints = buildSkillRendererReturnContract(nested).split("\n").find(line => line.startsWith("  建议字段：")) || "";
  assert.equal(hints, defaultHints[type] ? `  建议字段：${defaultHints[type]}。` : "", `${type} default paths`);
  assert.equal(getSkillRendererPresentationLane(nested), ["table", "image_grid", "diff"].includes(type) ? "wide" : "detail", `${type} lane`);
}
assert.equal(buildSkillRendererReturnContract({
  type: "table", itemsPath: "records", totalPath: "count", truncatedPath: "partial",
  columns: [{ label: "ID", path: "id" }, { label: "ID again", path: "id" }, { label: "Constant", value: 0 }],
}), [
  "返回格式契约：该工具配置了 UI renderer，脚本最终 return 必须匹配以下 JSON 形状，不要把主要数据包在 result 字段里。",
  "- renderer=table: 展示结构化行列数据。",
  "- 默认 return { rows: [...] }；如果 renderer 配置了 itemsPath/valuePath，则该路径必须是数组。",
  "- 集合元数据：count 表示完整结果行数；partial 表示当前 rows 是否被截断。",
  "- rows 每项至少包含字段：id, Constant。",
  "- 不要 return 大段 raw JSON 字符串；需要调试信息放 trace 或少量 debug 字段。",
].join("\n"), "configured metadata, literal labels and duplicate paths keep their existing text and order");
assert.equal(buildSkillRendererReturnContract({ type: "unknown", fields: [{ label: "State", path: "state" }] }),
  buildSkillRendererReturnContract({ type: "summary", fields: [{ label: "State", path: "state" }] }), "unknown historical types retain the summary contract");
const cyclicLayout = { type: "summary", layout: { type: "stack", blocks: [] } };
cyclicLayout.layout.blocks.push(cyclicLayout);
assert.equal(getSkillRendererPresentationLane(cyclicLayout), "detail", "malformed recursive input cannot loop forever");
cyclicLayout.layout.blocks.push({ type: "table" });
assert.equal(getSkillRendererPresentationLane(cyclicLayout), "wide", "a cyclic branch cannot hide a later wide block");

const invalidSourceDiagnostics = [];
const invalidSourcePlugin = normalizeSkillManifest({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "renderer-source-test",
  displayName: "Renderer Source Test",
  version: "0.1.0",
  tools: [{
    name: "inspect",
    title: "Inspect",
    description: "Reject unknown renderer sources",
    runtime: "inner",
    script: "scripts/inspect.js",
    renderer: { type: "code", source: "session", valuePath: "sql" },
  }],
}, {
  name: "renderer-source-test",
  displayName: "Renderer Source Test",
  scope: "global",
}, invalidSourceDiagnostics);
assert.equal(invalidSourcePlugin.tools[0].renderer.source, undefined);
assert.equal(invalidSourceDiagnostics.length, 1);
assert.match(invalidSourceDiagnostics[0].message, /source ignored because it is unknown: session/);

const previousDocument = globalThis.document;
globalThis.document = { createElement: () => fakeRendererParent() };
const structuredRenderer = createDeclarativeRenderer({ genericRenderer: {} });

const completedSelectionParent = fakeRendererParent();
assert.equal(structuredRenderer.render(completedSelectionParent, {
  type: "selection", sourcePath: "payload", itemsPath: "jobs", itemTitlePath: "company", itemSubtitlePath: "role",
}, { selectedIds: ["selected"], selectedItems: [{ id: "selected", company: "Chosen company", role: "Engineer" }], totalItems: 3 }), true);
assert.match(completedSelectionParent.children[0].innerHTML, /Chosen company/,
  "completed selections render their compact data independently of original source and collection paths");
assert.match(completedSelectionParent.children[0].innerHTML, /1.*3/);

for (const language of ["en", "zh-CN"]) for (const totalItems of [0, 3]) {
  const emptySelectionParent = fakeRendererParent();
  assert.equal(withLanguage(language, () => structuredRenderer.render(emptySelectionParent, {
    type: "selection", required: totalItems === 0, sourcePath: "payload", itemsPath: "jobs",
  }, { selectedIds: [], selectedItems: [], totalItems })), true);
  assert.equal(emptySelectionParent.childElementCount, 1,
    "empty candidates and optional empty selections retain their completion summary");
  assert.ok(emptySelectionParent.children[0].innerHTML.includes(language === "en"
    ? `Selected 0 of ${totalItems}` : `已选择 0 / ${totalItems} 项`));
  assert.ok(emptySelectionParent.children[0].innerHTML.includes(language === "en" ? "No items." : "没有条目。"));
}

const authoredEmptySelectionParent = fakeRendererParent();
structuredRenderer.render(authoredEmptySelectionParent, {
  type: "selection", required: false, empty: "No roles selected.",
}, { selectedIds: [], selectedItems: [], totalItems: 3 });
assert.match(authoredEmptySelectionParent.children[0].innerHTML, /No roles selected\./,
  "selection completion preserves authored empty-state copy");

const allMissingParent = fakeRendererParent();
assert.equal(
  structuredRenderer.render(allMissingParent, {
    type: "summary",
    layout: {
      blocks: [
        { type: "text", sourcePath: "missingText" },
        { type: "table", sourcePath: "missingTable" },
      ],
    },
  }, { other: true }),
  false,
  "a composite with no applicable block must fall through to the generic renderer",
);
assert.equal(allMissingParent.childElementCount, 0, "optional missing blocks must not leave placeholder UI behind");

const partialParent = fakeRendererParent();
assert.equal(
  structuredRenderer.render(partialParent, {
    type: "summary",
    layout: {
      blocks: [
        { type: "text", sourcePath: "present" },
        { type: "table", sourcePath: "missing" },
      ],
    },
  }, { present: { text: "rendered" } }),
  true,
  "a composite should remain handled when at least one block renders",
);
assert.equal(partialParent.childElementCount, 1);
assert.match(partialParent.children[0].innerHTML, /rendered/, "the actual text primitive must render the applicable block");

const requiredMissingParent = fakeRendererParent();
assert.equal(
  structuredRenderer.render(requiredMissingParent, { type: "text", sourcePath: "missing" }, { other: true }),
  true,
  "a non-composite schema mismatch should render its diagnostic instead of falling through",
);
assert.equal(requiredMissingParent.children[0].dataset.rendererDiagnosticCode, "PLUGIN_RENDERER_COLLECTION_MISSING");
assert.equal(requiredMissingParent.children[0].dataset.rendererPath, "missing");

globalThis.document = previousDocument;
console.log("plugin Renderer DSL tests passed");

function fakeRendererParent() {
  const parent = {
    children: [], dataset: {}, className: "", _html: "",
    set textContent(value) { this._html = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; },
    appendChild(child) { this.children.push(child); return child; },
    get childElementCount() {
      return this.children.length;
    },
    get lastElementChild() {
      return this.children.at(-1) || null;
    },
  };
  return parent;
}
