import { rendererT } from "./renderer-messages.js";
import type { JsonValue } from '../contracts/json.js';

export type SkillRendererField = { label: string; format?: string } & (
  { path: string; value?: never } | { value: JsonValue; path?: never }
);
type RendererTextKey = "type" | "source" | "action" | "title" | "subtitle" | "titlePath" | "subtitlePath"
  | "titleFormat" | "subtitleFormat" | "sourcePath" | "empty" | "valuePath" | "format" | "itemsPath"
  | "totalPath" | "truncatedPath" | "itemTitlePath" | "itemSubtitlePath" | "authorPath" | "timePath"
  | "sourceNamePath" | "urlPath" | "bodyPath" | "bodyFormat" | "commentsPath" | "commentsTitle"
  | "commentTitlePath" | "commentAuthorPath" | "commentBodyPath" | "commentTimePath"
  | "language" | "languagePath" | "filenamePath" | "itemIdPath" | "itemImagePath" | "submitLabel";
export interface SkillRenderer extends Partial<Record<RendererTextKey, string>> {
  fields?: SkillRendererField[]; columns?: SkillRendererField[]; itemMeta?: SkillRendererField[];
  metaFields?: SkillRendererField[]; commentMeta?: SkillRendererField[];
  maxItems?: number; maxBodyChars?: number; maxComments?: number;
  states?: Record<string, { title: string; subtitle: string; empty: string; fields: SkillRendererField[] }>;
  layout?: SkillRendererLayout;
  selectionMode?: "single" | "multiple";
  required?: boolean;
}
export interface SkillRendererLayout { type: string; title?: string; subtitle?: string; blocks: SkillRenderer[] }

interface PrimitiveDescriptor {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly returnShape: string;
  readonly defaultPaths: readonly string[];
  readonly lane?: "wide";
  readonly pathHints?: (renderer: SkillRenderer) => readonly (string | undefined)[];
  readonly returnLines?: readonly (string | ((renderer: SkillRenderer) => string))[];
}

export const SKILL_RENDERER_DEFINITIONS = Object.freeze([
  Object.freeze<PrimitiveDescriptor>({
    type: "summary",
    title: rendererT("summaryTitle"),
    description: rendererT("summaryDescription"),
    returnShape: "{ title?: string, subtitle?: string, ...fields }",
    defaultPaths: ["titlePath", "subtitlePath", "fields[].path"],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "compact",
    title: rendererT("compactTitle"),
    description: rendererT("compactDescription"),
    returnShape: "{ title?: string, subtitle?: string, ...fields }",
    defaultPaths: ["titlePath", "subtitlePath", "fields[].path"],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "metrics",
    title: rendererT("metricsTitle"),
    description: rendererT("metricsDescription"),
    returnShape: "{ ...fields }",
    defaultPaths: ["fields[].path"],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "fields",
    title: rendererT("fieldsTitle"),
    description: rendererT("fieldsDescription"),
    returnShape: "{ ...fields }",
    defaultPaths: ["fields[].path"],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "chips",
    title: rendererT("chipsTitle"),
    description: rendererT("chipsDescription"),
    returnShape: "{ chips: Array<string | number> }",
    defaultPaths: ["itemsPath", "valuePath"],
    pathHints: renderer => [renderer.itemsPath || renderer.valuePath || "chips"],
    returnLines: [rendererT("chipsReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "note",
    title: rendererT("noteTitle"),
    description: rendererT("noteDescription"),
    returnShape: "{ note: string }",
    defaultPaths: ["valuePath"],
    pathHints: renderer => [renderer.valuePath || "note"],
    returnLines: [renderer => renderer.valuePath
      ? rendererT("notePath", { path: renderer.valuePath })
      : rendererT("noteReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "text",
    title: rendererT("textTitle"),
    description: rendererT("textDescription"),
    returnShape: "{ text: string }",
    defaultPaths: ["valuePath"],
    pathHints: renderer => [renderer.valuePath || "text"],
    returnLines: [renderer => renderer.valuePath
      ? rendererT("textPath", { path: renderer.valuePath })
      : rendererT("textReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "article",
    title: rendererT("articleTitle"),
    description: rendererT("articleDescription"),
    returnShape: "{ title?: string, author?: string, publishedAt?: string, body?: string, meta?: Array<string | { label, value }>, comments?: Array<object> }",
    defaultPaths: ["titlePath", "authorPath", "timePath", "sourceNamePath", "urlPath", "bodyPath", "metaFields[].path", "commentsPath", "commentAuthorPath", "commentBodyPath", "commentTimePath", "commentMeta[].path"],
    pathHints: renderer => [
      renderer.titlePath || "title", renderer.authorPath || "author", renderer.timePath || "publishedAt/time",
      renderer.sourceNamePath || "source/site/platform", renderer.urlPath || "url/link/href", renderer.bodyPath || "body/text/content",
      renderer.metaFields?.length ? "metaFields[].path" : "meta", renderer.commentsPath || "comments/replies/answers",
      renderer.commentMeta?.length ? "commentMeta[].path" : "comments[].meta",
    ],
    returnLines: [
      rendererT("articleReturn"),
      rendererT("articleMetadata"),
      renderer => configuredPathLine(rendererT("configuredPathsLabel"), [
        renderer.titlePath, renderer.authorPath, renderer.timePath, renderer.sourceNamePath, renderer.urlPath,
        renderer.bodyPath, ...fieldPaths(renderer.metaFields), renderer.commentsPath, renderer.commentAuthorPath,
        renderer.commentBodyPath, renderer.commentTimePath, ...fieldPaths(renderer.commentMeta),
      ]),
    ],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "list",
    title: rendererT("listTitle"),
    description: rendererT("listDescription"),
    returnShape: "{ items: Array<object> }",
    defaultPaths: ["items", "itemTitlePath", "itemSubtitlePath", "itemMeta[].path"],
    pathHints: renderer => [renderer.itemTitlePath, renderer.itemSubtitlePath, ...fieldPaths(renderer.itemMeta)],
    returnLines: [
      rendererT("listReturn"),
      renderer => configuredPathLine(rendererT("listFieldsLabel"), [renderer.itemTitlePath, renderer.itemSubtitlePath, ...fieldPaths(renderer.itemMeta)]),
    ],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "selection",
    title: rendererT("selectionTitle"),
    description: rendererT("selectionDescription"),
    returnShape: "{ items: Array<{ id: string, title: string, ...fields }> }",
    defaultPaths: ["itemsPath", "itemIdPath", "itemTitlePath", "itemSubtitlePath", "itemMeta[].path", "itemImagePath", "urlPath"],
    pathHints: renderer => [renderer.itemsPath || "items", renderer.itemIdPath || "id", renderer.itemTitlePath || "title"],
    returnLines: [rendererT("selectionReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "table",
    title: rendererT("tableTitle"),
    description: rendererT("tableDescription"),
    returnShape: "{ rows: Array<object>, totalRows?: number, truncated?: boolean }",
    defaultPaths: ["itemsPath", "columns[].path", "totalPath", "truncatedPath"],
    lane: "wide",
    pathHints: renderer => [renderer.itemsPath || renderer.valuePath || "rows", ...fieldPaths(renderer.columns), renderer.totalPath, renderer.truncatedPath],
    returnLines: [
      rendererT("tableReturn"),
      renderer => renderer.totalPath || renderer.truncatedPath
        ? rendererT("collectionMetadata", {
          total: renderer.totalPath ? rendererT("collectionTotal", { path: renderer.totalPath }) : "",
          separator: renderer.totalPath && renderer.truncatedPath ? rendererT("metadataSeparator") : "",
          truncated: renderer.truncatedPath ? rendererT("collectionTruncated", { path: renderer.truncatedPath }) : "",
        })
        : "",
      renderer => configuredPathLine(rendererT("tableFieldsLabel"), fieldPaths(renderer.columns)),
    ],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "records",
    title: rendererT("recordsTitle"),
    description: rendererT("recordsDescription"),
    returnShape: "{ records: Array<object> }",
    defaultPaths: ["itemsPath", "valuePath"],
    pathHints: renderer => [renderer.itemsPath || renderer.valuePath || "records"],
    returnLines: [rendererT("recordsReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "image_grid",
    title: rendererT("imageGridTitle"),
    description: rendererT("imageGridDescription"),
    returnShape: "{ images: Array<{ url?: string, src?: string, title?: string, width?: number, height?: number }> }",
    defaultPaths: ["itemsPath", "valuePath"],
    lane: "wide",
    pathHints: renderer => [renderer.itemsPath || renderer.valuePath || "images"],
    returnLines: [rendererT("imageGridReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "tree",
    title: rendererT("treeTitle"),
    description: rendererT("treeDescription"),
    returnShape: rendererT("treeShape"),
    defaultPaths: ["itemsPath", "valuePath"],
    pathHints: renderer => [renderer.itemsPath || renderer.valuePath || "nodes/lines"],
    returnLines: [rendererT("treeReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "diff",
    title: rendererT("diffTitle"),
    description: rendererT("diffDescription"),
    returnShape: rendererT("diffShape"),
    defaultPaths: ["valuePath"],
    lane: "wide",
    pathHints: renderer => [renderer.valuePath || "patch/diff/changes"],
    returnLines: [rendererT("diffReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "markdown",
    title: "Markdown",
    description: rendererT("markdownDescription"),
    returnShape: "{ markdown: string }",
    defaultPaths: ["valuePath"],
    pathHints: renderer => [renderer.valuePath || "markdown"],
    returnLines: [renderer => renderer.valuePath
      ? rendererT("markdownPath", { path: renderer.valuePath })
      : rendererT("markdownReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "json",
    title: "JSON",
    description: rendererT("jsonDescription"),
    returnShape: "object",
    defaultPaths: ["valuePath"],
    pathHints: renderer => [renderer.valuePath],
    returnLines: [renderer => renderer.valuePath
      ? rendererT("jsonPath", { path: renderer.valuePath })
      : rendererT("jsonReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "code",
    title: rendererT("codeTitle"),
    description: rendererT("codeDescription"),
    returnShape: "{ code: string, language?: string, filename?: string }",
    defaultPaths: ["valuePath", "languagePath", "filenamePath"],
    pathHints: renderer => [renderer.valuePath || "code", renderer.languagePath || "language", renderer.filenamePath || "filename"],
    returnLines: [renderer => renderer.valuePath
      ? rendererT("codePath", { path: renderer.valuePath })
      : rendererT("codeReturn")],
  }),
  Object.freeze<PrimitiveDescriptor>({
    type: "skill",
    title: rendererT("skillTitle"),
    description: rendererT("skillDescription"),
    returnShape: "{ action: string, name: string, saved?: boolean, updated?: boolean, deleted?: boolean }",
    defaultPaths: ["action", "name"],
    returnLines: [rendererT("skillReturn")],
  }),
]);

export const SKILL_RENDERER_TYPES = new Set<string>(SKILL_RENDERER_DEFINITIONS.map(item => item.type));
export const SKILL_LAYOUT_COMPONENT_TYPES = new Set(["stack", ...[...SKILL_RENDERER_TYPES].filter(type => type !== "selection")]);
export const SKILL_RENDERER_SOURCES = new Set(["result", "args"]);

export function listSkillRendererDefinitions() {
  return SKILL_RENDERER_DEFINITIONS.map(item => ({
    type: item.type,
    title: item.title,
    description: item.description,
    returnShape: item.returnShape,
    defaultPaths: [...item.defaultPaths],
  }));
}

export function getSkillRendererDefinition(type: unknown = "") {
  const normalized = normalizeSkillRendererType(type);
  return SKILL_RENDERER_DEFINITIONS.find(item => item.type === normalized) || SKILL_RENDERER_DEFINITIONS[0];
}

export function normalizeSkillRendererType(type: unknown = "") {
  const raw = String(type || "summary").trim();
  return SKILL_RENDERER_TYPES.has(raw) ? raw : "summary";
}

export function normalizeSkillRendererSource(source: unknown = "") {
  const raw = String(source || "result").trim();
  return SKILL_RENDERER_SOURCES.has(raw) ? raw : "result";
}

/**
 * Derive the presentation lane from the complete renderer tree. A composite
 * renderer is wide when any nested primitive needs horizontal room.
 */
export function getSkillRendererPresentationLane(renderer: unknown = {}) {
  return skillRendererTreeNeedsWideLane(renderer, new Set()) ? "wide" : "detail";
}

function skillRendererTreeNeedsWideLane(value: unknown, visited: Set<object>): boolean {
  const renderer = value && typeof value === "object" ? value as SkillRenderer : null;
  if (!renderer || typeof renderer !== "object" || visited.has(renderer)) return false;
  visited.add(renderer);
  if (getSkillRendererDefinition(renderer.type).lane === "wide") return true;
  const blocks = Array.isArray(renderer.layout?.blocks) ? renderer.layout.blocks : [];
  return blocks.some(block => skillRendererTreeNeedsWideLane(block, visited));
}

export function buildSkillRendererReturnContract(renderer: SkillRenderer = {}) {
  const blocks = Array.isArray(renderer?.layout?.blocks) ? renderer.layout.blocks.filter(Boolean) : [];
  if (blocks.length) return buildSkillLayoutReturnContract(blocks);
  const definition = getSkillRendererDefinition(renderer?.type);
  if (normalizeSkillRendererSource(renderer?.source) === "args") {
    return buildSkillInputRendererContract(renderer, definition);
  }
  return buildSingleSkillRendererReturnContract(renderer, definition, {
    prefix: rendererT("returnContract"),
  });
}

function buildSkillLayoutReturnContract(blocks: SkillRenderer[] = []) {
  const resultBlocks = blocks.filter(block => normalizeSkillRendererSource(block?.source) === "result");
  const inputBlocks = blocks.filter(block => normalizeSkillRendererSource(block?.source) === "args");
  const lines = resultBlocks.length
    ? [rendererT("layoutReturnContract")]
    : [rendererT("layoutInputContract")];
  for (const block of resultBlocks) {
    const definition = getSkillRendererDefinition(block?.type);
    const sourcePath = String(block?.sourcePath || "").trim();
    const target = sourcePath ? rendererT("fieldTarget", { path: sourcePath }) : rendererT("rootObject");
    lines.push(rendererT("layoutResultBlock", { target, type: definition.type, description: definition.description, shape: definition.returnShape }));
    const hints = (definition.pathHints || summaryPaths)(block).filter(Boolean);
    if (hints.length) lines.push(rendererT("suggestedFields", { fields: hints.join(", ") }));
  }
  for (const block of inputBlocks) {
    const definition = getSkillRendererDefinition(block?.type);
    lines.push(rendererT("layoutInputBlock", { target: skillRendererInputTarget(block), type: definition.type }));
  }
  if (resultBlocks.length) {
    lines.push(rendererT("layoutExample"));
  }
  lines.push(rendererT("avoidRawJson"));
  return lines.join("\n");
}

function buildSkillInputRendererContract(renderer: SkillRenderer = {}, definition = getSkillRendererDefinition(renderer?.type)) {
  return [
    rendererT("inputContract"),
    rendererT("inputBlock", { target: skillRendererInputTarget(renderer), type: definition.type, description: definition.description }),
    rendererT("inputReturn"),
  ].join("\n");
}

function skillRendererInputTarget(renderer: SkillRenderer = {}) {
  const path = [renderer.sourcePath, renderer.valuePath]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join(".");
  return path ? `args.${path}` : "args";
}

function buildSingleSkillRendererReturnContract(renderer: SkillRenderer = {}, definition = getSkillRendererDefinition(renderer?.type), options: { prefix?: string } = {}) {
  const lines = [
    options.prefix || rendererT("defaultReturnContract"),
    `- renderer=${definition.type}: ${definition.description}`,
  ];
  const returnLines = definition.returnLines || [summaryReturnLine];
  lines.push(...returnLines.map(line => typeof line === "function" ? line(renderer) : line).filter(Boolean));
  lines.push(rendererT("avoidRawJson"));
  return lines.join("\n");
}

function fieldPaths(fields: readonly SkillRendererField[] = []) {
  return fields.map(field => field.path || field.label);
}

function summaryPaths(renderer: SkillRenderer) {
  return [renderer.titlePath, renderer.subtitlePath, ...fieldPaths(renderer.fields)];
}

function configuredPathLine(label: string, paths: readonly (string | undefined)[]) {
  return paths.some(Boolean) ? rendererT("configuredPathLine", { label, paths: uniqueStrings(paths.filter(Boolean)).join(", ") }) : "";
}

function summaryReturnLine(renderer: SkillRenderer) {
  return configuredPathLine(rendererT("summaryFieldsLabel"), summaryPaths(renderer))
    || rendererT("summaryReturn");
}

export function summarizeSkillRendererContract(renderer: SkillRenderer = {}) {
  return buildSkillRendererReturnContract(renderer)
    .split("\n")
    .slice(1, 4)
    .join(" ");
}

function uniqueStrings(items: readonly unknown[] = []) {
  return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))];
}
