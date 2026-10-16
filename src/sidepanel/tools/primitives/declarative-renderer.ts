import { t, tHtml } from "../../i18n/index.js";
import { appendChanges } from "./diff-renderer.js";
import * as presentation from "../generic-result-renderer.js";
import { appendHtmlSection } from "../../ui/ui-utils.js";
import { record } from "../renderer-input.js";
import type { createGenericResultRenderer } from "../generic-result-renderer.js";
import type { createDataTableRenderer } from "./data-table-renderer.js";
import type { createImageGridRenderer } from "./image-grid-renderer.js";

type Data = Record<string, unknown>;
interface Collection { state: "ready" | "empty" | "missing" | "invalid"; items: unknown[]; path: string }
interface DisplayField { label: string; value: unknown }
interface StructuredHelpers {
  genericRenderer: Pick<ReturnType<typeof createGenericResultRenderer>, "appendJsonCodeBlock">;
  dataTableRenderer?: ReturnType<typeof createDataTableRenderer>;
  browserContentProfiles?: { renderPageTree(parent: HTMLElement, name: string, args: Data, value: unknown): unknown } & ReturnType<typeof createImageGridRenderer>;
}

import { escapeHtml } from "../../ui/ui-utils.js";
import { highlightCode } from "../../ui/code-highlighter.js";
import { rendererT } from "../../../shared/skills/renderer-messages.js";
import {
  normalizeSkillRendererSource,
  normalizeSkillRendererType,
} from "../../../shared/skills/skill-renderers.js";

export function createDeclarativeRenderer(helpers: StructuredHelpers) {
  const {
    genericRenderer,
    dataTableRenderer,
    browserContentProfiles,
  } = helpers;
  const { appendJsonCodeBlock } = genericRenderer;
  const appendDataRowsTable = dataTableRenderer?.appendRowsTable;
  const appendImageGrid = browserContentProfiles?.appendImageGrid;
  const appendPageTreeProfile = browserContentProfiles?.renderPageTree;

function appendSkillRenderer(parent: HTMLElement, renderer: Data, data: unknown, plugin: Data | null, context: { args?: unknown } = {}) {
  const layout = record(renderer.layout);
  const blocks = Array.isArray(layout.blocks) && layout.blocks.length ? layout.blocks.map(record) : [renderer];
  const isComposite = Array.isArray(layout.blocks) && layout.blocks.length > 0;
  let handled = false;
  for (const block of blocks) {
    handled = appendSkillRendererBlock(parent, block, data, plugin, {
      optionalSource: isComposite,
      args: context.args,
    }) || handled;
  }
  return handled;
}

function appendSkillInputRenderers(parent: HTMLElement, renderer: Data, args: unknown = {}, plugin: Data | null) {
  const layout = record(renderer.layout);
  const blocks = Array.isArray(layout.blocks) && layout.blocks.length ? layout.blocks.map(record) : [renderer];
  const inputBlocks = blocks.filter(block => normalizeSkillRendererSource(String(block?.source || "")) === "args");
  const childCount = parent.childElementCount;
  for (const block of inputBlocks) {
    appendSkillRendererBlock(parent, block, undefined, plugin, { optionalSource: true, args });
  }
  return parent.childElementCount > childCount;
}

function appendSkillRendererBlock(parent: HTMLElement, renderer: Data, data: unknown, plugin: Data | null, { optionalSource = false, args = {} }: { optionalSource?: boolean; args?: unknown } = {}) {
  const type = normalizeSkillRendererType(String(renderer.type || "summary"));
  const blockData = skillRendererBlockData(renderer, data, args);
  if (blockData.state === "missing") {
    if (optionalSource) return false;
    appendSkillShapeDiagnostic(parent, renderer, "source_missing", renderer.sourcePath);
    return true;
  }
  const append = SKILL_RENDERER_APPENDERS.get(type);
  return append ? append(parent, renderer, blockData.value, plugin) : false;
}

const SKILL_RENDERER_APPENDERS = new Map<string, (parent: HTMLElement, renderer: Data, data: unknown, plugin: Data | null) => boolean>([
  ["summary", (parent, renderer, data) => appendSkillSummaryBlock(parent, renderer, data)],
  ["compact", (parent, renderer, data) => appendSkillSummaryBlock(parent, renderer, data)],
  ["metrics", (parent, renderer, data) => appendSkillSummaryBlock(parent, renderer, data)],
  ["fields", (parent, renderer, data) => appendSkillFieldsBlock(parent, renderer, data)],
  ["chips", (parent, renderer, data) => appendSkillChipsBlock(parent, renderer, data)],
  ["note", (parent, renderer, data) => appendSkillNoteBlock(parent, renderer, data)],
  ["text", (parent, renderer, data) => appendSkillTextBlock(parent, renderer, data)],
  ["article", (parent, renderer, data) => appendSkillArticleBlock(parent, renderer, data)],
  ["list", (parent, renderer, data) => appendSkillListBlock(parent, renderer, data)],
  ["selection", (parent, renderer, data) => {
    const selected = record(data).selectedIds;
    return appendSkillListBlock(parent, { ...renderer, itemsPath: "selectedItems",
      title: rendererT("selectionCompleted", { count: Array.isArray(selected) ? selected.length : 0, total: Number(record(data).totalItems) || 0 }),
      empty: renderer.empty || t("noItems"),
    }, data);
  }],
  ["table", (parent, renderer, data) => appendSkillTableBlock(parent, renderer, data)],
  ["records", (parent, renderer, data) => appendSkillRecordsBlock(parent, renderer, data)],
  ["image_grid", (parent, renderer, data) => appendSkillImageGridBlock(parent, renderer, data)],
  ["tree", (parent, renderer, data) => appendSkillTreeBlock(parent, renderer, data)],
  ["diff", (parent, renderer, data) => appendSkillDiffBlock(parent, renderer, data)],
  ["markdown", (parent, renderer, data, plugin) => appendSkillMarkdownBlock(parent, renderer, data, plugin)],
  ["json", (parent, renderer, data) => appendSkillJsonBlock(parent, renderer, data)],
  ["code", (parent, renderer, data) => appendSkillCodeBlock(parent, renderer, data)],
]);

function skillRendererBlockData(renderer: Data = {}, data: unknown, args: unknown = {}) {
  const source = normalizeSkillRendererSource(String(renderer.source || ""));
  const sourceData = source === "args" ? args : data;
  const sourcePath = renderer.type === "selection" ? "" : String(renderer.sourcePath || "").trim();
  if (!sourcePath) return { state: "ready", value: sourceData };
  const resolved = skillValueAtPathState(sourceData, sourcePath);
  return resolved.exists
    ? { state: "ready", value: resolved.value }
    : { state: "missing", value: undefined };
}

function appendSkillSummaryBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const fields = resolveSkillRendererFields(renderer.fields, data);
  const titleValue = skillRendererValueAtOptionalPath(data, renderer.titlePath);
  const subtitleValue = skillRendererValueAtOptionalPath(data, renderer.subtitlePath);
  if (titleValue != null || subtitleValue != null) {
    presentation.appendCompactLine(parent, {
      title: formatSkillRendererValue(titleValue ?? renderer.title ?? t("result"), renderer.titleFormat),
      subtitle: formatSkillRendererValue(subtitleValue ?? renderer.subtitle ?? "", renderer.subtitleFormat),
      meta: [],
    });
    if (fields.length) presentation.appendStatGrid(parent, fields);
    return true;
  }
  if (fields.length) {
    presentation.appendStatGrid(parent, fields);
    return true;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    presentation.appendKeyValueSection(parent, renderer.title || t("result"), presentation.pickReadableFields(data, ["_plugin", "trace", "details"]), { compact: true });
    return true;
  }
  if (data != null && data !== "") {
    presentation.appendTextSection(parent, renderer.title || t("result"), String(data));
    return true;
  }
  if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("result"), renderer.empty);
  return Boolean(renderer.empty);
}

function appendSkillFieldsBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const fields = resolveSkillRendererFields(renderer.fields, data);
  if (fields.length) {
    presentation.appendKeyValueSection(parent, renderer.title || t("fields"), Object.fromEntries(fields.map(field => [field.label, field.value])), { compact: true });
    return true;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    presentation.appendKeyValueSection(parent, renderer.title || t("fields"), presentation.pickReadableFields(data, ["_plugin", "trace", "details"]), { compact: true });
    return true;
  }
  if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("fields"), renderer.empty);
  return Boolean(renderer.empty);
}

function appendSkillChipsBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const collection = resolveSkillRendererCollection(renderer, data, ["chips", "items", "values"]);
  if (collection.state !== "ready") return appendSkillCollectionFallback(parent, renderer, collection, t("tags"));
  const items = collection.items;
  const chips = items.map(item => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return presentation.firstNonEmpty([record(item).label, record(item).title, record(item).name, record(item).value, record(item).text]) || presentation.summarizeValue(item, 80);
    }
    return item;
  }).filter(item => item != null && item !== "");
  if (chips.length) {
    presentation.appendChipRow(parent, chips);
    return true;
  }
  return appendSkillCollectionFallback(parent, renderer, { ...collection, state: "empty" }, t("tags"));
}

function appendSkillNoteBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const text = skillRendererTextValue(renderer, data, ["note", "message", "error", "text", "content"]);
  if (text) {
    presentation.appendNoteSection(parent, renderer.title || t("note"), text);
    return true;
  }
  if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("note"), renderer.empty);
  return Boolean(renderer.empty);
}

function appendSkillTextBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const text = skillRendererTextValue(renderer, data, ["text", "content", "body", "summary", "message"]);
  if (text) {
    presentation.appendTextSection(parent, renderer.title || t("text"), text);
    return true;
  }
  if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("text"), renderer.empty);
  return Boolean(renderer.empty);
}

function appendSkillArticleBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const article = normalizeSkillArticleData(renderer, data);
  if (!article.title && !article.body && !article.comments.length) {
    presentation.appendNoteSection(parent, renderer.title || t("article"), renderer.empty || t("articleShapeMismatch"));
    return true;
  }

  const meta = [
    article.author,
    article.time,
    article.source,
    article.url,
    ...article.meta,
  ].filter(Boolean);
  const body = presentation.clipDisplayText(article.body, article.maxBodyChars);
  appendHtmlSection(parent, "tool-friendly-section tool-plugin-article", `
    <article class="tool-plugin-article-shell">
      <header class="tool-plugin-article-head">
        <h3 class="tool-plugin-article-title">${presentation.linkifyText(presentation.summarizeValue(article.title || renderer.title || t("article"), 280))}</h3>
        ${meta.length ? `<div class="tool-plugin-article-meta">${meta.map(item => `<span>${presentation.linkifyText(presentation.summarizeValue(item, 120))}</span>`).join("")}</div>` : ""}
      </header>
      ${body ? `<div class="tool-plugin-article-body ${article.bodyFormat === "markdown" ? "tool-plugin-markdown-body" : ""}">${renderSkillArticleBodyHtml(body, article.bodyFormat)}</div>` : ""}
      ${String(article.body || "").length > body.length ? `<div class="tool-more-hint">${tHtml("shownCharacters", { count: body.length })}</div>` : ""}
      ${article.comments.length ? renderSkillArticleComments(article) : ""}
    </article>
  `);
  return true;
}

function appendSkillListBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const collection = resolveSkillRendererCollection(renderer, data, ["items", "rows"]);
  if (collection.state !== "ready") return appendSkillCollectionFallback(parent, renderer, collection, t("resultList"));
  const items = collection.items;
  presentation.appendSlimList(parent, renderer.title || t("resultList"), items, item => ({
    title: skillValueAtPath(item, renderer.itemTitlePath) || record(item).title || record(item).name || record(item).url || presentation.summarizeValue(item, 120),
    subtitle: skillValueAtPath(item, renderer.itemSubtitlePath) || record(item).description || record(item).url || "",
    meta: resolveSkillRendererFields(renderer.itemMeta, item).map(field => `${field.label}: ${field.value}`),
  }));
  return true;
}

function appendSkillTableBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const collection = resolveSkillRendererCollection(renderer, data, ["rows", "items"]);
  if (collection.state !== "ready") return appendSkillCollectionFallback(parent, renderer, collection, t("dataTable"));
  const rows = collection.items;
  const projectedRows = Array.isArray(renderer.columns) && renderer.columns.length
    ? rows.map(row => Object.fromEntries(resolveSkillRendererFields(renderer.columns, row).map(field => [field.label, field.value])))
    : rows;
  const appended = appendDataRowsTable?.(parent, String(renderer.title || t("dataTable")), projectedRows, {
    totalRows: skillRendererTotalRows(data, renderer.totalPath),
    truncated: skillRendererTruncated(data, renderer.truncatedPath),
  });
  if (!appended) appendSkillShapeDiagnostic(parent, renderer, "invalid", renderer.itemsPath || renderer.valuePath || "rows", t("dataTable"));
  return true;
}

function appendSkillRecordsBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const collection = resolveSkillRendererCollection(renderer, data, ["records", "items", "rows"]);
  if (collection.state !== "ready") return appendSkillCollectionFallback(parent, renderer, collection, t("records"));
  presentation.appendRecordsSection(parent, renderer.title || t("records"), collection.items);
  return true;
}

function appendSkillImageGridBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const collection = resolveSkillRendererCollection(renderer, data, ["images", "items", "assets", "sample"]);
  if (collection.state !== "ready") return appendSkillCollectionFallback(parent, renderer, collection, t("images"));
  return appendImageGrid?.(parent, renderer.title || t("images"), collection.items, { maxItems: Number(renderer.maxItems || 60) }) || false;
}

function appendSkillTreeBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const value = renderer.valuePath ? skillValueAtPath(data, renderer.valuePath) : data;
  const treeData = Array.isArray(value)
    ? { title: renderer.title || t("tree"), nodes: value }
    : (value && typeof value === "object" ? { title: renderer.title || record(value).title, ...value } : null);
  if (treeData && appendPageTreeProfile?.(parent, "plugin_tree", {}, treeData)) return true;
  if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("tree"), renderer.empty);
  return Boolean(renderer.empty);
}

function appendSkillDiffBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const value = renderer.valuePath ? skillValueAtPath(data, renderer.valuePath) : data;
  const changes = skillDiffChanges(value);
  if (changes.length) {
    appendChanges(parent, changes, { title: String(renderer.title || t("changes")) });
    return true;
  }
  if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("changes"), renderer.empty);
  return Boolean(renderer.empty);
}

function skillRendererValueAtOptionalPath(data: unknown, path: unknown = "") {
  const text = String(path || "").trim();
  return text ? skillValueAtPath(data, text) : null;
}

function appendSkillMarkdownBlock(parent: HTMLElement, renderer: Data, data: unknown, plugin: Data | null) {
  const value = (renderer.valuePath ? skillValueAtPath(data, renderer.valuePath) : undefined)
    ?? record(data).markdown
    ?? record(data).content
    ?? record(data).text;
  const text = String(value || "").trim();
  if (!text) {
    if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || "Markdown", renderer.empty);
    return Boolean(renderer.empty);
  }
  appendHtmlSection(parent, "tool-friendly-section tool-plugin-markdown", `
    <div class="tool-section-title">${escapeHtml(renderer.title || plugin?.title || "Markdown")}</div>
    <div class="tool-plugin-markdown-body">${renderSkillMarkdownHtml(text)}</div>
  `);
  return true;
}

function appendSkillJsonBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const value = renderer.valuePath ? skillValueAtPath(data, renderer.valuePath) : data;
  if (value == null || value === "") {
    if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || "JSON", renderer.empty);
    return Boolean(renderer.empty);
  }
  appendJsonCodeBlock(parent, String(renderer.title || "JSON"), value);
  return true;
}

function appendSkillCodeBlock(parent: HTMLElement, renderer: Data, data: unknown) {
  const value = renderer.valuePath ? skillValueAtPath(data, renderer.valuePath) : data;
  const code = typeof value === "string"
    ? value
    : presentation.firstNonEmpty([record(value).code, record(value).content, record(value).text, record(value).source]);
  if (!code) {
    if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || t("code"), renderer.empty);
    return Boolean(renderer.empty);
  }
  const language = renderer.language
    || skillRendererValueAtOptionalPath(value, renderer.languagePath)
    || record(value).language
    || presentation.codeLanguageForFilename(skillRendererValueAtOptionalPath(value, renderer.filenamePath) || record(value).filename || renderer.title || "");
  appendHighlightedCodeSection(parent, renderer.title || record(value).filename || t("code"), String(code), language);
  return true;
}

function normalizeSkillArticleData(renderer: Data = {}, data: unknown) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? record(data) : { body: data };
  const title = skillArticleTextAt(source, renderer.titlePath, ["title", "headline", "subject", "name"]);
  const author = skillArticleTextAt(source, renderer.authorPath, ["author", "authorName", "user", "creator", "nickname", "owner"]);
  const time = presentation.formatDateLike(skillArticleTextAt(source, renderer.timePath, ["publishedAt", "publishTime", "publish_time", "time", "date", "createdAt", "updatedAt"]));
  const sourceName = skillArticleTextAt(source, renderer.sourceNamePath, ["source", "site", "platform", "forum", "community"]);
  const url = skillArticleTextAt(source, renderer.urlPath, ["url", "link", "href"]);
  const body = skillArticleTextAt(source, renderer.bodyPath || renderer.valuePath, ["body", "text", "content", "markdown", "article", "answer", "review", "post"]);
  const comments = skillArticleComments(renderer, source);
  const meta = [
    ...skillArticleMetaValues(source.meta || source.metadata),
    ...resolveSkillRendererFields(renderer.metaFields, source).map(field => `${field.label}: ${field.value}`),
  ];
  return {
    title,
    author,
    time,
    source: sourceName,
    url,
    body,
    bodyFormat: String(renderer.bodyFormat || renderer.format || "").trim().toLowerCase(),
    maxBodyChars: clampPositiveInt(renderer.maxBodyChars, 6000),
    comments,
    commentsTitle: renderer.commentsTitle || articleCommentsTitle(source),
    maxComments: clampPositiveInt(renderer.maxComments, 6),
    meta,
  };
}

function skillArticleComments(renderer: Data = {}, source: Data = {}) {
  const explicit = renderer.commentsPath ? skillValueAtPath(source, renderer.commentsPath) : undefined;
  const rows = Array.isArray(explicit)
    ? explicit
    : firstArrayValue(source, ["comments", "replies", "answers", "reviews", "discussions"]);
  return rows.map((item: unknown, index: number) => normalizeSkillArticleComment(renderer, item, index)).filter(item => item.body || item.title);
}

function normalizeSkillArticleComment(renderer: Data = {}, item: unknown, index: number) {
  const source = item && typeof item === "object" && !Array.isArray(item) ? record(item) : { body: item };
  const title = skillArticleTextAt(source, renderer.commentTitlePath, ["title", "subject", "name"]);
  const author = skillArticleTextAt(source, renderer.commentAuthorPath, ["author", "authorName", "user", "creator", "nickname", "owner"]);
  const time = presentation.formatDateLike(skillArticleTextAt(source, renderer.commentTimePath, ["publishedAt", "publishTime", "publish_time", "time", "date", "createdAt", "updatedAt"]));
  const body = skillArticleTextAt(source, renderer.commentBodyPath, ["body", "text", "content", "comment", "answer", "reply", "review"]);
  const meta = [
    ...skillArticleMetaValues(source.meta || source.metadata),
    ...resolveSkillRendererFields(renderer.commentMeta, source).map(field => `${field.label}: ${field.value}`),
  ];
  return {
    title,
    author,
    time,
    body,
    meta,
    index,
  };
}

function renderSkillArticleComments(article: ReturnType<typeof normalizeSkillArticleData>) {
  const rows = article.comments.slice(0, article.maxComments);
  return `
    <section class="tool-plugin-article-comments">
      <div class="tool-plugin-article-comments-title">${escapeHtml(article.commentsTitle || t("comments"))}${article.comments.length > rows.length ? `<span class="tool-section-count">${tHtml("shownOf", { shown: rows.length, total: article.comments.length })}</span>` : ""}</div>
      <div class="tool-plugin-article-comment-list">
        ${rows.map(comment => renderSkillArticleComment(comment)).join("")}
      </div>
    </section>
  `;
}

function renderSkillArticleComment(comment: ReturnType<typeof normalizeSkillArticleComment>) {
  const meta = [comment.author, comment.time, ...comment.meta].filter(Boolean);
  return `
    <article class="tool-plugin-article-comment">
      ${comment.title ? `<div class="tool-plugin-article-comment-title">${presentation.linkifyText(presentation.summarizeValue(comment.title, 180))}</div>` : ""}
      ${meta.length ? `<div class="tool-plugin-article-comment-meta">${meta.map(item => `<span>${presentation.linkifyText(presentation.summarizeValue(item, 96))}</span>`).join("")}</div>` : ""}
      ${comment.body ? `<div class="tool-plugin-article-comment-body">${presentation.linkifyText(presentation.clipDisplayText(comment.body, 900))}</div>` : ""}
    </article>
  `;
}

function renderSkillArticleBodyHtml(text: unknown = "", format = "") {
  return format === "markdown" ? renderSkillMarkdownHtml(text) : presentation.linkifyText(text);
}

function skillArticleTextAt(source: Data, path: unknown = "", keys: string[] = []) {
  const explicit = path ? skillValueAtPath(source, path) : undefined;
  const value = explicit != null && explicit !== "" ? explicit : firstKeyValue(source, keys);
  return skillArticleTextValue(value);
}

function skillArticleTextValue(value: unknown): unknown {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(item => skillArticleTextValue(item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return presentation.firstNonEmpty([
      record(value).name,
      record(value).displayName,
      record(value).nickname,
      record(value).title,
      record(value).text,
      record(value).content,
      record(value).body,
      record(value).value,
      record(value).url,
    ]) || presentation.summarizeValue(value, 240);
  }
  return String(value);
}

function skillArticleMetaValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (item == null || item === "") return "";
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return presentation.summarizeValue(item, 120);
    if (!item || typeof item !== "object" || Array.isArray(item)) return presentation.summarizeValue(item, 120);
    const label = presentation.firstNonEmpty([item.label, item.name, item.key, item.title]);
    const rawValue = Object.prototype.hasOwnProperty.call(item, "value")
      ? item.value
      : presentation.firstNonEmpty([item.text, item.content, item.body]);
    if (label && rawValue != null && rawValue !== "") return `${label}: ${presentation.summarizeValue(rawValue, 80)}`;
    return presentation.firstNonEmpty([item.text, item.content, item.body, item.value]) || presentation.summarizeValue(item, 120);
  }).filter(Boolean);
}

function articleCommentsTitle(source: Data = {}) {
  if (Array.isArray(source.answers)) return t("answers");
  if (Array.isArray(source.replies)) return t("replies");
  if (Array.isArray(source.reviews)) return t("reviews");
  return t("comments");
}

function firstArrayValue(source: Data = {}, keys: string[] = []): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstKeyValue(source: Data = {}, keys: string[] = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function clampPositiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveSkillRendererCollection(renderer: Data = {}, data: unknown, defaultKeys: string[] = []): Collection {
  const explicitPath = String(renderer.itemsPath || renderer.valuePath || "").trim();
  if (explicitPath) {
    const resolved = skillValueAtPathState(data, explicitPath);
    if (!resolved.exists) return { state: "missing", items: [], path: explicitPath };
    return skillRendererCollectionFromValue(resolved.value, explicitPath);
  }
  if (Array.isArray(data)) return skillRendererCollectionFromValue(data, "");
  if (!data || typeof data !== "object") return { state: "invalid", items: [], path: "" };
  for (const key of defaultKeys) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    return skillRendererCollectionFromValue(record(data)[key], key);
  }
  return { state: "missing", items: [], path: defaultKeys.join("|") };
}

function skillRendererCollectionFromValue(value: unknown, path: string): Collection {
  if (!Array.isArray(value)) return { state: "invalid", items: [], path };
  if (!value.length) return { state: "empty", items: [], path };
  return { state: "ready", items: value, path };
}

function appendSkillCollectionFallback(parent: HTMLElement, renderer: Data, collection: Collection, defaultTitle: string) {
  if (collection.state === "empty") {
    if (renderer.empty) presentation.appendNoteSection(parent, renderer.title || defaultTitle, renderer.empty);
    return true;
  }
  appendSkillShapeDiagnostic(parent, renderer, collection.state, collection.path, defaultTitle);
  return true;
}

function appendSkillShapeDiagnostic(parent: HTMLElement, renderer: Data, state: string, path: unknown = "", defaultTitle = t("result")) {
  const previous = parent.lastElementChild;
  presentation.appendNoteSection(parent, renderer.title || defaultTitle, t("resultUnavailable"));
  const section = parent.lastElementChild;
  if (!section || section === previous || !("dataset" in section)) return;
  const dataset = record(section.dataset);
  dataset.rendererDiagnosticCode = state === "invalid"
    ? "PLUGIN_RENDERER_COLLECTION_INVALID"
    : "PLUGIN_RENDERER_COLLECTION_MISSING";
  dataset.rendererExpected = state === "source_missing" ? "value" : "array";
  if (path) dataset.rendererPath = String(path);
}

function skillRendererTotalRows(data: unknown, path: unknown = "") {
  const resolved = skillValueAtPathState(data, path);
  if (!path || !resolved.exists) return undefined;
  const totalRows = Number(resolved.value);
  return Number.isFinite(totalRows) && totalRows >= 0 ? Math.floor(totalRows) : undefined;
}

function skillRendererTruncated(data: unknown, path: unknown = "") {
  const resolved = skillValueAtPathState(data, path);
  return path && resolved.exists ? resolved.value === true : false;
}

function skillRendererTextValue(renderer: Data = {}, data: unknown, defaultKeys: string[] = []) {
  const explicit = renderer.valuePath ? skillValueAtPath(data, renderer.valuePath) : undefined;
  if (explicit != null && explicit !== "") return String(explicit);
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    for (const key of defaultKeys) {
      const value = record(data)[key];
      if (value != null && value !== "") return String(value);
    }
  }
  return "";
}

function skillDiffChanges(value: unknown): Data[] {
  if (typeof value === "string") return [{ path: "diff", patchPreview: value }];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === "string") return { path: `diff ${index + 1}`, patchPreview: item };
      const preview = record(item).preview || record(item).patchPreview || record(item).patch || record(item).diff || record(item).text || record(item).content || "";
      return {
        path: record(item).path || record(item).file || record(item).name || `change ${index + 1}`,
        patchPreview: preview,
        kind: record(item).kind || record(item).action || "",
        firstChangedLine: record(item).firstChangedLine,
      };
    }).filter(item => item.patchPreview);
  }
  if (Array.isArray(record(value).changes)) return skillDiffChanges(record(value).changes);
  const preview = record(value).patch || record(value).diff || record(value).preview || record(value).text || record(value).content || "";
  return preview ? [{ path: record(value).path || record(value).file || "diff", patchPreview: preview, kind: record(value).kind || record(value).action || "" }] : [];
}

function appendHighlightedCodeSection(parent: HTMLElement, label: unknown, code: unknown, language: unknown = "") {
  const text = String(code || "");
  const highlighted = highlightCode(text, String(language || ""), { autoDetect: !language && text.length <= 20000 });
  const section = document.createElement("div");
  section.className = "tool-detail-section";
  const labelEl = document.createElement("div");
  labelEl.className = "tool-detail-label";
  labelEl.textContent = String(label || t("code"));
  const pre = document.createElement("pre");
  pre.className = "code-block hljs";
  if (highlighted.language) pre.classList.add(`language-${highlighted.language}`);
  pre.innerHTML = highlighted.html;
  section.append(labelEl, presentation.createCopyableCodeBlock(pre, text));
  parent.appendChild(section);
}

function resolveSkillRendererFields(fields: unknown = [], data: unknown): DisplayField[] {
  return (Array.isArray(fields) ? fields : [])
    .map((input: unknown): DisplayField | null => {
      const field = record(input);
      const label = String(field?.label || field?.path || "").trim();
      const hasLiteral = Object.prototype.hasOwnProperty.call(field || {}, "value")
        && field.value !== undefined
        && field.value !== null;
      const rawValue = hasLiteral
        ? field.value
        : skillValueAtPath(data, field?.path);
      const value = formatSkillRendererValue(rawValue, field?.format);
      if (!label || value == null || value === "") return null;
      return { label, value };
    })
    .filter((field): field is DisplayField => field !== null);
}

function formatSkillRendererValue(value: unknown, format: unknown = "") {
  if (format === "count") {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
  }
  if (format === "boolean") return value ? t("yes") : t("no");
  return value;
}

function skillValueAtPath(source: unknown, path: unknown = "") {
  return skillValueAtPathState(source, path).value;
}

function skillValueAtPathState(source: unknown, path: unknown = "") {
  const text = String(path || "").trim();
  if (!text) return { exists: true, value: source };
  const parts = text.replace(/\[(\d+)\]/g, ".$1").split(".").map(part => part.trim()).filter(Boolean);
  let value = source;
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(Object(value), part)) {
      return { exists: false, value: undefined };
    }
    value = (Object(value) as Data)[part];
  }
  return { exists: true, value };
}

function renderSkillMarkdownHtml(text: unknown = "") {
  const lines = String(text || "").split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderSkillMarkdownInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      html.push(`<h${heading[1].length}>${renderSkillMarkdownInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderSkillMarkdownInline(bullet[1])}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  return html.join("");
}

function renderSkillMarkdownInline(text: unknown = "") {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

  return {
    render: appendSkillRenderer,
    renderInputs: appendSkillInputRenderers,
  };
}
