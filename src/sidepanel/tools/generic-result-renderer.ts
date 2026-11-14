import { stripInvisibleTitlePrefix } from "../../shared/unicode-utils.js";
import { t, tHtml } from "../i18n/index.js";
import { toolPresentationRegistry } from "./tool-presentation.js";
import { createCodeCopyButton, appendHtmlSection, escapeHtml, escapeHtmlAttribute } from "../ui/ui-utils.js";
import { record, type ToolEvent } from "./renderer-input.js";
import type { ToolView } from "../../sdk/sidepanel/renderers.js";

type Data = Record<string, unknown>;
interface Summary { title?: unknown; subtitle?: unknown; meta?: unknown[] }
interface RawToolData { args?: unknown; rawArgsText?: string; result?: unknown }
interface ParsedValue { ok: boolean; value: unknown }
interface GenericOptions {
  createValueView(value: unknown): { kind: string; html: string };
  normalizeToolResult(value: unknown): unknown;
  pageDisplayTarget(args: unknown, result: unknown, options?: { maxLength?: number; fallbackToTabId?: boolean }): string;
  formatToolHeaderLabel(tool: ToolEvent | string, args: Data, result: unknown): string;
  renderMarkdown?: (source: string) => string;
}

import { highlightCode } from "../ui/code-highlighter.js";
import {
  formatActionLabel,
  formatToolActionTitle,
} from "../../shared/tools/tool-metadata.js";
import {
  isPageContextToolName,
  isToolResultErrorLike as isErrorLike,
  toolKey,
} from "./tool-model.js";
import {
  localizeToolDiagnostic,
  localizeToolFailureCode,
  localizeToolFailurePayload,
  localizeToolFailureText,
} from "../../shared/tools/tool-error-localization.js";

const RAW_TOOL_PREVIEW_CHAR_LIMIT = 50000;
const RAW_TOOL_ARRAY_PREVIEW_LIMIT = 20;
const RAW_FAILURE_DEBUG_KEYS = new Set(["originalCode", "originalError", "originalMessage", "originalCategory"]);

const FIELD_LABELS: Record<string, string> = {
  action: t("action"),
  active: t("active"),
  article_id: t("contentId"),
  author: t("author"),
  code: t("code"),
  columns: t("fields"),
  count: t("count"),
  contextWindow: t("context"),
  deleted: t("delete"),
  description: t("description"),
  debugMode: t("debugMode"),
  requestRateLimit: t("rateLimit"),
  error: t("error"),
  filename: t("filename"),
  folder: t("folder"),
  hasResult: t("hasReturnValue"),
  hasApiKey: "AK",
  activePresetId: t("currentPreset"),
  apiKey: "API Key",
  id: "ID",
  ids: "ID",
  index: "#",
  inserted: t("inserted"),
  dedupField: t("dedupeField"),
  limit: t("limit"),
  line: "L",
  message: t("message"),
  method: "method",
  model: t("model"),
  modelParameters: t("modelParameters"),
  name: t("name"),
  offset: t("offset"),
  ok: t("status"),
  parentId: t("parent"),
  pattern: t("pattern"),
  provider: t("provider"),
  providerLabel: t("provider"),
  providerApiKeyProviders: t("savedApiKey"),
  providerApiKeys: "Provider API Keys",
  prompt: "Prompt",
  query: t("query"),
  recursive: t("recursive"),
  request: t("requiredUserAction"),
  result: t("result"),
  saved: t("save"),
  securityGuardrails: t("safetyGuardrails"),
  observation: t("observeAfterResume"),
  row: t("records"),
  rows: t("records"),
  clickablePoint: t("clickablePoints"),
  rect: t("position"),
  role: t("role"),
  uid: "UID",
  form: t("form"),
  src: "src",
  sample: t("sample"),
  script: t("script"),
  selector: t("selector"),
  sessionId: t("task"),
  sessionIds: t("task"),
  skill: t("skills"),
  source: t("source"),
  tabId: t("tab"),
  table: t("table"),
  title: t("title"),
  target: t("target"),
  trimOldToolResults: t("trimOldResults"),
  firstMessage: t("firstMessage"),
  instructions: t("instruction"),
  total: t("total"),
  totalBytes: t("size"),
  totalLines: t("totalRows"),
  totalMatched: t("pattern"),
  totalRows: t("totalRows"),
  type: t("type"),
  updated: t("updated"),
  url: t("url"),
  value: t("value"),
  vision: t("vision"),
  waitFor: t("waiting"),
};

const RESULT_METRIC_KEYS = [
  "inserted",
  "updated",
  "deleted",
  "changed",
  "written",
  "totalRows",
  "totalMatched",
  "total",
  "count",
  "matches",
  "limit",
  "offset",
];

export function summarizeValue(value: unknown, max = 80) {
  let text;
  if (typeof value === "boolean") text = value ? t("yes") : t("no");
  else if (value == null) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else {
    try { text = JSON.stringify(value); }
    catch(_e) { text = String(value); }
  }
  text = String(text ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function createGenericResultRenderer(options: GenericOptions) {
  const createValueView = options.createValueView;
  const normalizeToolResult = options.normalizeToolResult;
  const pageDisplayTarget = options.pageDisplayTarget;
  const formatToolHeaderLabel = options.formatToolHeaderLabel;
  const renderMarkdown = options.renderMarkdown || null;
  const rawToolSourceByNode = new WeakMap<Element, RawToolData>();

function appendGenericCompactView(parent: HTMLElement, tool: ToolView, result: unknown, originalResult: unknown, status: ToolView["status"], { compact = true } = {}) {
  const description = describeToolRun(tool, tool.args, result, tool.hasResult);
  const meta = collectResultMetrics(result).map(item => `${item.value} ${item.label}`);
  if (status.tone !== "success" || description || meta.length) {
    appendCompactLine(parent, {
      title: status.tone === "success" ? (description || formatToolHeaderLabel(tool, tool.args, result)) : status.title,
      subtitle: status.tone === "success" ? "" : description,
      meta,
    });
  }
  appendCompactParams(parent, tool, tool.args);
  if (tool.hasResult && result != null && result !== "") {
    appendReadableResult(parent, tool.name, result, originalResult, compact);
  }
}

function appendMarkdownSection(parent: HTMLElement, title: unknown, text: unknown) {
  const source = String(text || "");
  const clipped = clipDisplayText(source, 12000);
  const safeSource = clipped.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rendered = typeof renderMarkdown === "function"
    ? renderMarkdown(safeSource)
    : linkifyText(clipped);
  appendHtmlSection(parent, "tool-friendly-section", `
    <div class="tool-section-title">${escapeHtml(title)}</div>
    <div class="tool-article-body qz-markdown" data-tool-scroll-surface="markdown-${escapeHtmlAttribute(title)}">${rendered}</div>
    ${source.length > clipped.length ? `<div class="tool-more-hint">${tHtml("shownCharacters", { count: clipped.length })}</div>` : ""}
  `);
}

function appendRawToolData(parent: HTMLElement, { args, rawArgsText = "", result }: RawToolData) {
  if (!hasRawToolData({ args, rawArgsText, result })) return;

  const section = document.createElement("details");
  section.className = "tool-raw-details";
  const summary = document.createElement("summary");
  summary.textContent = t("viewRawData");
  section.append(summary, createRawToolSourceNode({ args, rawArgsText, result }));
  parent.appendChild(section);
}

function createRawToolSourceNode(source: RawToolData) {
  const node = document.createElement("span");
  node.className = "tool-raw-lazy-source hidden";
  node.setAttribute("aria-hidden", "true");
  rawToolSourceByNode.set(node, source);
  return node;
}

function ensureToolRawPanelRendered(panel: HTMLElement) {
  if (!panel || panel.dataset.rawToolRendered === "true") return false;
  const sourceNode = panel.querySelector(":scope > .tool-raw-lazy-source");
  if (!sourceNode) {
    panel.dataset.rawToolRendered = "true";
    return false;
  }
  const source = rawToolSourceByNode.get(sourceNode);
  if (!source) {
    panel.dataset.rawToolRendered = "true";
    sourceNode.remove();
    return false;
  }
  panel.replaceChildren(createRawToolContent(source));
  panel.dataset.rawToolRendered = "true";
  return true;
}

function createRawToolContent({ args, rawArgsText = "", result }: RawToolData) {
  const payload: Data = {};
  if (!isEmptyJsonObject(args)) payload.args = compactRawToolValue(args);
  if (rawArgsText) payload.rawArgsText = compactRawToolValue(rawArgsText);
  if (result !== undefined && result !== "") payload.result = compactRawToolValue(result, 0, "result");
  const pre = document.createElement("pre");
  const view = createValueView(payload);
  pre.className = `json-block ${view.kind === "text" ? "json-block-text" : "hljs language-json"}`;
  pre.innerHTML = view.html;
  return createCopyableCodeBlock(pre);
}

function describeToolRun(toolOrName: ToolEvent | string | undefined, args: Data = {}, result: unknown, _hasResult: boolean) {
  const toolName = toolKey(toolOrName);
  const actionLabel = args.action
    ? (formatActionLabel(args.action, toolName) || fieldLabel(args.action))
    : "";
  const action = actionLabel ? `${actionLabel} · ` : "";
  const pageTarget = isPageContextToolName(toolName)
    ? pageDisplayTarget(args, normalizeToolResult(result), { maxLength: 60, fallbackToTabId: false })
    : "";
  const target = firstNonEmpty([
    args.table && t("tableNamed", { name: String(args.table) }),
    args.query && t("queryText", { text: String(args.query) }),
    args.pattern && t("matchText", { text: String(args.pattern) }),
    args.selector && t("selectorText", { text: String(args.selector) }),
    pageTarget,
    args.url,
    args.filename,
    args.skill && args.script ? `${args.skill}/${args.script}` : "",
    args.skill,
    args.sessionId && t("taskNamed", { name: String(args.sessionId) }),
    !isPageContextToolName(toolName) && args.tabId && t("tabNamed", { name: String(args.tabId) }),
  ]);
  if (isErrorLike(result)) {
    const localized = record(localizeToolFailurePayload(result, { toolName }));
    return localized.error || localized.message || localized.codeLabel || t("toolReturnedError");
  }
  const description = toolPresentationRegistry.project("describeRun", toolOrName || "", args, result);
  if (description !== undefined) return description;
  if (target) return `${action}${target}`;
  return "";
}

function appendJsonCodeBlock(parent: HTMLElement, label: string, value: unknown) {
  const section = document.createElement("div");
  section.className = "tool-json-code-section";
  const labelEl = document.createElement("div");
  labelEl.className = "tool-detail-label";
  labelEl.textContent = label;
  const pre = document.createElement("pre");
  const view = createValueView(value);
  pre.className = `json-block tool-result-json-block ${view.kind === "text" ? "json-block-text" : "hljs language-json"}`;
  pre.innerHTML = view.html;
  section.append(labelEl, createCopyableCodeBlock(pre));
  parent.appendChild(section);
}

  return {
    appendGenericCompactView,
    appendMarkdownSection,
    appendRawToolData,
    describeToolRun,
    appendJsonCodeBlock,
    ensureRawPanel: ensureToolRawPanelRendered,
  };
}

export function appendCompactParams(parent: HTMLElement, toolOrName: ToolEvent | string | undefined, args: unknown) {
  const toolName = toolKey(toolOrName);
  const value = toolPresentationRegistry.project("compactParams", toolOrName || "", args) || record(args);
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .slice(0, 8);
  if (!entries.length) return;
  appendHtmlSection(parent, "tool-chip-row", entries.map(([key, item]) => `
    <span class="tool-chip"><b>${escapeHtml(fieldLabel(key))}</b>${formatFriendlyValueHtml(compactToolParamValue(toolName, key, item))}</span>
  `).join(""));
}

function compactToolParamValue(toolName: string | undefined, key: string, value: unknown) {
  if (key === "action") return formatActionLabel(value, toolName) || value;
  if (Array.isArray(value)) {
    const label = /url/i.test(String(key || "")) ? "URL" : t("itemUnit");
    const preview = value.slice(0, 2).map(item => summarizeValue(item, 42)).filter(Boolean);
    return preview.length
      ? t("collectionSummary", { count: value.length, noun: label, detail: preview.join(" · "), suffix: value.length > preview.length ? " …" : "" })
      : t("collectionCount", { count: value.length, noun: label });
  }
  return value;
}

export function appendCompactLine(parent: HTMLElement, { title, subtitle = "", meta = [] }: Summary) {
  appendHtmlSection(parent, "tool-compact-line", `
    <div class="tool-compact-title">${linkifyText(summarizeValue(title, 260))}</div>
    ${subtitle ? `<div class="tool-compact-subtitle">${linkifyText(summarizeValue(subtitle, 420))}</div>` : ""}
    ${meta.length ? `<div class="tool-compact-meta">${meta.map(item => `<span>${escapeHtml(summarizeValue(item, 80))}</span>`).join("")}</div>` : ""}
  `);
}

export function appendStatGrid(parent: HTMLElement, stats: {label?: unknown; value?: unknown}[]) {
  const rows = (Array.isArray(stats) ? stats : [])
    .filter(item => item && item.value !== undefined && item.value !== null && item.value !== "");
  if (!rows.length) return;
  appendHtmlSection(parent, "tool-stat-grid", rows.map(item => {
    const fullValue = summarizeValue(item.value, 1000);
    return `
      <span class="tool-stat-item">
        <b title="${escapeHtmlAttribute(fullValue)}">${escapeHtml(summarizeValue(item.value, 24))}</b>
        <em>${escapeHtml(item.label || "")}</em>
      </span>
    `;
  }).join(""));
}

export function appendChipRow(parent: HTMLElement, items: unknown[]) {
  const chips = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!chips.length) return;
  appendHtmlSection(parent, "tool-chip-row", chips.map(item => `<span class="tool-chip">${escapeHtml(summarizeValue(item, 80))}</span>`).join(""));
}

export function appendSlimList<T>(parent: HTMLElement, title: unknown, items: T[], mapper: (item: T, index: number) => Summary | undefined) {
  const rows = (Array.isArray(items) ? items : []).slice(0, 12);
  appendHtmlSection(parent, "tool-slim-list", `
    <div class="tool-slim-title">${escapeHtml(title)}${items.length > rows.length ? `<span>${tHtml("shownOf", { shown: rows.length, total: items.length })}</span>` : ""}</div>
    ${rows.map((item, index) => {
      const row = mapper(item, index) || {};
      // Drop invisible title prefixes before whitespace folding and truncation; keep in-text joiners.
      const displayTitle = typeof row.title === "string"
        ? stripInvisibleTitlePrefix(row.title)
        : row.title;
      const meta = Array.isArray(row.meta) ? row.meta.filter(Boolean) : [];
      return `
        <div class="tool-slim-row">
          <div class="tool-slim-main">${linkifyText(summarizeValue(displayTitle, 180))}</div>
          ${row.subtitle ? `<div class="tool-slim-sub">${linkifyText(summarizeValue(row.subtitle, 260))}</div>` : ""}
          ${meta.length ? `<div class="tool-slim-meta">${meta.map(item => `<span>${escapeHtml(summarizeValue(item, 80))}</span>`).join("")}</div>` : ""}
        </div>
      `;
    }).join("")}
  `);
}

/** Unknown renderers use data shape only; tool-specific presentation lives in the registry. */
function appendReadableResult(parent: HTMLElement, toolName: string, result: unknown, originalResult: unknown, compact: boolean) {
  if (isErrorLike(result) || isErrorLike(originalResult)) {
    appendErrorSection(parent, result || originalResult);
  } else if (result == null || result === "") {
    return;
  } else if (Array.isArray(result)) {
    if (compact) {
      appendSlimList(parent, result.length ? t("resultList") : t("result"), result, item => ({
        title: record(item).title || record(item).name || record(item).url || summarizeValue(item, 100),
        subtitle: record(item).url || record(item).description || "",
      }));
    } else appendRecordsSection(parent, t("result"), result);
  } else if (typeof result === "object") {
    if (compact) appendCompactParams(parent, toolName, pickReadableFields(result, ["details", "rows", "sample"]));
    else appendKeyValueSection(parent, t("result"), result, { compact: true });
  } else {
    appendTextSection(parent, t("result"), result);
  }
}

export function appendErrorSection(parent: HTMLElement, value: unknown) {
  const input = value && typeof value === "object" ? value : { error: String(value || t("unknownError")) };
  const error = record(localizeToolFailurePayload(input, { isError: true }));
  const message = String(error.error || error.message || t("toolFailed"));
  const codeLabel = error.codeLabel || localizeToolFailureCode(error.code);
  const rawCode = String(error.code || "").trim();
  const codeText = codeLabel || rawCode;
  appendHtmlSection(parent, "tool-friendly-section tool-error-section", `
    <div class="tool-section-title">${tHtml("error")}</div>
    <div class="tool-error-message">${escapeHtml(message || t("toolFailed"))}</div>
    ${codeText ? `<div class="tool-error-code">${escapeHtml(codeText)}</div>` : ""}
    ${renderDiagnosticHtml(error.diagnostic)}
    ${renderToolErrorDetailsHtml(error.details)}
  `);
  const source = record(input);
  const trace = record(record(source._display).script).trace ?? record(source.details).trace ?? source.trace;
  if (Array.isArray(trace)) appendScriptTrace(parent, trace);
  if (typeof error.hint === "string" && error.hint.trim()) appendCompactLine(parent, { title: error.hint });
}

function renderToolErrorDetailsHtml(input: unknown) {
  const details = record(input);
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const rows = [
    [t("extension"), details.pluginId],
    ["Skill", details.skillName],
    [t("tool"), details.tool || details.skillToolName || details.pluginToolName],
    [t("script"), details.script],
  ].filter(([, value]) => value != null && value !== "");
  if (!rows.length) return "";
  return `
    <div class="tool-error-diagnostic">
      ${rows.map(([label, value]) => `
        <div class="tool-error-diagnostic-row">
          <span>${escapeHtml(label)}</span>
          <b>${escapeHtml(summarizeValue(value, 96))}</b>
        </div>
      `).join("")}
    </div>
  `;
}

function renderDiagnosticHtml(input: unknown) {
  const diagnostic = record(localizeToolDiagnostic(input));
  if (!diagnostic || typeof diagnostic !== "object") return "";
  const rows = [
    [t("diagnostics"), diagnostic.category],
    [t("possibleCause"), diagnostic.likelyCause],
    [t("suggestion"), diagnostic.suggestedNextStep],
  ].filter(([, value]) => value != null && value !== "");
  if (!rows.length) return "";
  return `
    <div class="tool-error-diagnostic">
      ${rows.map(([label, value]) => `
        <div class="tool-error-diagnostic-row">
          <span>${escapeHtml(label)}</span>
          <b>${escapeHtml(String(value))}</b>
        </div>
      `).join("")}
    </div>
  `;
}

export function appendNoteSection(parent: HTMLElement, title: unknown, text: unknown) {
  appendHtmlSection(parent, "tool-friendly-section", `
    <div class="tool-section-title">${escapeHtml(title)}</div>
    <div class="tool-text-preview" data-tool-scroll-surface="text-${escapeHtmlAttribute(title)}">${escapeHtml(text)}</div>
  `);
}

export function appendTextSection(parent: HTMLElement, title: unknown, text: unknown) {
  const clipped = clipDisplayText(text, 2400);
  appendHtmlSection(parent, "tool-friendly-section", `
    <div class="tool-section-title">${escapeHtml(title)}</div>
    <div class="tool-text-preview" data-tool-scroll-surface="text-${escapeHtmlAttribute(title)}">${linkifyText(clipped)}</div>
    ${String(text || "").length > clipped.length ? `<div class="tool-more-hint">${tHtml("shownCharacters", { count: clipped.length })}</div>` : ""}
  `);
}

export function appendKeyValueSection(parent: HTMLElement, title: unknown, value: unknown, { compact = false } = {}) {
  const entries = Object.entries(value || {})
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .filter(([key]) => compact ? key !== "details" : true)
    .slice(0, compact ? 12 : 24);
  if (!entries.length) return;

  appendHtmlSection(parent, "tool-friendly-section", `
    <div class="tool-section-title">${escapeHtml(title)}</div>
    <div class="tool-kv-grid">
      ${entries.map(([key, item]) => `
        <div class="tool-kv-item">
          <div class="tool-kv-label">${escapeHtml(fieldLabel(key))}</div>
          <div class="tool-kv-value">${formatFriendlyValueHtml(item)}</div>
        </div>
      `).join("")}
    </div>
  `);
}

export function appendRecordsSection(parent: HTMLElement, title: unknown, records: unknown[]) {
  const rows = Array.isArray(records) ? records.filter(item => item != null).slice(0, 8) : [];
  if (!rows.length) {
    appendNoteSection(parent, title, t("noItems"));
    return;
  }
  appendHtmlSection(parent, "tool-friendly-section", `
    <div class="tool-section-title">${escapeHtml(title)}${records.length > rows.length ? `<span class="tool-section-count">${tHtml("shownOf", { shown: rows.length, total: records.length })}</span>` : ""}</div>
    <div class="tool-record-list">
      ${rows.map((item, index) => renderRecordCard(item, index)).join("")}
    </div>
  `);
}

function renderRecordCard(item: unknown, index: number) {
  if (!item || typeof item !== "object") {
    return `<div class="tool-record-card"><div class="tool-record-title">${escapeHtml(String(item ?? ""))}</div></div>`;
  }
  const source = record(item);
  const data = source.data && typeof source.data === "object" ? { ...source, ...record(source.data) } : source;
  const title = data.title || data.name || data.filename || data.url || data.id || t("itemNumber", { number: index + 1 });
  const subtitle = data.description || data.abstract || data.text || data.snippet || data.message || data.url || "";
  const metaKeys = ["table", "query", "author", "type", "status", "state", "createdAt", "updatedAt", "publish_time", "tabId", "id"];
  const meta = metaKeys
    .filter(key => data[key] != null && data[key] !== "" && data[key] !== title)
    .slice(0, 4)
    .map(key => `<span>${escapeHtml(fieldLabel(key))}: ${escapeHtml(summarizeValue(data[key], 48))}</span>`)
    .join("");
  return `
    <div class="tool-record-card">
      <div class="tool-record-title">${linkifyText(summarizeValue(title, 120))}</div>
      ${subtitle && subtitle !== title ? `<div class="tool-record-subtitle">${linkifyText(summarizeValue(subtitle, 180))}</div>` : ""}
      ${meta ? `<div class="tool-record-meta">${meta}</div>` : ""}
    </div>
  `;
}

function hasRawToolData({ args, rawArgsText = "", result }: RawToolData) {
  return !isEmptyJsonObject(args)
    || Boolean(rawArgsText)
    || (result !== undefined && result !== "");
}

/**
 * A failure localizes its own text once, with its code and details. Other records fall back to
 * text localization; recorded script trace rows stay verbatim.
 */
function localizeRecordText(value: object, key: string): object {
  if (isErrorLike(value)) return localizeToolFailurePayload(value, { isError: true }) as object;
  const source = record(value);
  if (key === "trace") return source;
  const out = { ...source };
  for (const field of ["error", "message"]) {
    if (typeof source[field] === "string") out[field] = localizeToolFailureText(source[field]);
  }
  return out;
}

function compactRawToolValue(value: unknown, depth = 0, key = ""): unknown {
  const keyText = String(key || "");
  if (keyText === "code" && typeof value === "string") return localizeToolFailureCode(value) || value;
  if (typeof value === "string") {
    if (value.length <= RAW_TOOL_PREVIEW_CHAR_LIMIT) return value;
    return `${value.slice(0, RAW_TOOL_PREVIEW_CHAR_LIMIT)}\n… omitted ${value.length - RAW_TOOL_PREVIEW_CHAR_LIMIT} chars`;
  }
  if (Array.isArray(value)) {
    const rows = value.slice(0, RAW_TOOL_ARRAY_PREVIEW_LIMIT).map(item => compactRawToolValue(item, depth + 1, keyText));
    if (value.length > rows.length) {
      rows.push({ _omittedItems: value.length - rows.length });
    }
    return rows;
  }
  if (!value || typeof value !== "object") return value;
  value = localizeRecordText(value, keyText);
  if (depth >= 4) return summarizeValue(value, 240);
  const out: Data = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (RAW_FAILURE_DEBUG_KEYS.has(key)) continue;
    out[key] = compactRawToolValue(item, depth + 1, key);
  }
  return out;
}

export function localizeToolDisplayValue(value: unknown, depth = 0, key = ""): unknown {
  const keyText = String(key || "");
  if (keyText === "code" && typeof value === "string") return localizeToolFailureCode(value) || value;
  if (Array.isArray(value)) {
    return value.map(item => localizeToolDisplayValue(item, depth + 1, keyText));
  }
  if (!value || typeof value !== "object") return value;
  const source = localizeRecordText(value, keyText);
  const out: Data = {};
  for (const [childKey, childValue] of Object.entries(record(source))) {
    if (RAW_FAILURE_DEBUG_KEYS.has(childKey)) continue;
    out[childKey] = depth > 8
      ? childValue
      : localizeToolDisplayValue(childValue, depth + 1, childKey);
  }
  return out;
}

export function normalizeFriendlyValue(value: unknown) {
  const parsed = parseJsonish(value);
  return parsed.ok ? parsed.value : value;
}

export function unwrapResultValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, envelope: null };
  const valueOnly = record(record(record(value)._display).script).valueOnly === true;
  const hasEnvelopeShape = valueOnly || Object.prototype.hasOwnProperty.call(value, "ok")
    && (Object.prototype.hasOwnProperty.call(value, "result")
      || Object.prototype.hasOwnProperty.call(value, "hasResult")
      || Object.prototype.hasOwnProperty.call(value, "resultType"));
  if (!hasEnvelopeShape) return { value, envelope: null };
  return {
    value: valueOnly ? record(value).result : normalizeFriendlyValue(record(value).result),
    envelope: record(value),
  };
}

function collectResultMetrics(result: unknown) {
  const data = record(result);
  const metrics: { label: string; value: string | number }[] = [];
  if (Array.isArray(result)) {
    metrics.push({ label: t("items"), value: result.length });
    return metrics;
  }
  if (!result || typeof result !== "object") return metrics;
  for (const key of RESULT_METRIC_KEYS) {
    if (data[key] == null || data[key] === "") continue;
    if (Array.isArray(data[key])) continue;
    metrics.push({ label: fieldLabel(key), value: summarizeValue(data[key], 18) });
  }
  if (Array.isArray(data.rows)) metrics.unshift({ label: t("returned"), value: data.rows.length });
  if (Array.isArray(data.sample)) metrics.push({ label: t("sample"), value: data.sample.length });
  if (Array.isArray(data.tables)) metrics.push({ label: t("table"), value: data.tables.length });
  if (Array.isArray(data.columns)) metrics.push({ label: t("fields"), value: data.columns.length });
  return metrics.slice(0, 6);
}

export function fieldLabel(key: unknown) {
  const text = String(key ?? "");
  const actionLabel = formatActionLabel(text);
  if (actionLabel) return actionLabel;
  if (FIELD_LABELS[text]) return FIELD_LABELS[text];
  return text
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

export function pickReadableFields(value: unknown, omitKeys: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const omit = new Set(omitKeys);
  const out: Data = {};
  for (const [key, item] of Object.entries(value)) {
    if (omit.has(key)) continue;
    if (item == null || item === "") continue;
    if (Array.isArray(item) && item.length > 6) {
      out[key] = t("itemCount", { count: item.length });
    } else if (typeof item === "object" && !Array.isArray(item)) {
      const keys = Object.keys(item);
      out[key] = keys.length ? t("fieldCount", { count: keys.length }) : "{}";
    } else {
      out[key] = item;
    }
  }
  return out;
}

function formatFriendlyValueHtml(value: unknown) {
  if (Array.isArray(value)) {
    if (!value.length) return `<span class="tool-empty-value">${tHtml("none")}</span>`;
    return escapeHtml(value.map(item => summarizeValue(item, 32)).join(", "));
  }
  if (value && typeof value === "object") {
    const data = record(value);
    if (data.url || data.href) return linkifyText(data.url || data.href);
    if (data.title || data.name) return escapeHtml(summarizeValue(data.title || data.name, 120));
    return escapeHtml(summarizeValue(value, 160));
  }
  return linkifyText(summarizeValue(value, 180));
}

export function basename(value: unknown) {
  const text = String(value || "").replace(/\\/g, "/");
  const clean = text.split("?")[0].split("#")[0].replace(/\/+$/, "");
  return decodeSafe(clean.split("/").pop() || text || t("file"));
}

function decodeSafe(value: unknown) {
  try { return decodeURIComponent(String(value || "")); }
  catch(_e) { return String(value || ""); }
}

export function formatBytesProgress(item: Data = {}) {
  const received = Number(item.bytesReceived);
  const total = Number(item.totalBytes);
  if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
    return `${formatBytes(received)} / ${formatBytes(total)}`;
  }
  if (Number.isFinite(total) && total > 0) return formatBytes(total);
  if (Number.isFinite(received) && received > 0) return formatBytes(received);
  return "";
}

export function formatBytes(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatTextSize(value: unknown) {
  const text = typeof value === "string" ? value : summarizeValue(value, 1000000);
  const bytes = typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(text).length
    : String(text || "").length;
  return formatBytes(bytes) || t("characterCount", { count: String(text || "").length });
}

export function formatDateLike(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace("T", " ").replace(/\.\d{3}Z?$/, "").replace(/Z$/, "");
}

export function clipDisplayText(value: unknown, max = 1200) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function decodeToolUrlForDisplay(value: unknown) {
  const url = String(value || "");
  try {
    return decodeURI(url);
  } catch (_error) {
    return url.replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
      try { return decodeURI(encoded); }
      catch (_decodeError) { return encoded; }
    });
  }
}

export function linkifyText(value: unknown) {
  const text = String(value ?? "");
  const pattern = /(https?:\/\/[^\s<>"']+)/g;
  let cursor = 0;
  let html = "";
  for (const match of text.matchAll(pattern)) {
    const url = match[0];
    html += escapeHtml(text.slice(cursor, match.index));
    html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(decodeToolUrlForDisplay(url))}</a>`;
    cursor = match.index + url.length;
  }
  return html + escapeHtml(text.slice(cursor));
}

export function firstNonEmpty(values: unknown[]) {
  return values.find(value => value != null && String(value).trim() !== "") || "";
}

export function appendCodeDetail(parent: HTMLElement, label: string, code: unknown) {
  const section = document.createElement("div");
  section.className = "tool-detail-section";

  const labelEl = document.createElement("div");
  labelEl.className = "tool-detail-label";
  labelEl.textContent = label;

  const pre = document.createElement("pre");
  pre.className = "code-block js-code-block hljs language-javascript";
  pre.dataset.toolScrollSurface = "code";
  pre.dataset.toolStreamSurface = "50";
  pre.innerHTML = highlightCode(
    formatJavaScriptCode(code),
    "javascript",
    { autoDetect: false },
  ).html;

  section.append(labelEl, createCopyableCodeBlock(pre));
  parent.appendChild(section);
}

export function codeLanguageForFilename(filename: unknown = "") {
  const ext = String(filename || "").split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    csv: "plaintext",
    html: "html",
    htm: "html",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    ts: "typescript",
    tsx: "typescript",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext] || "";
}

export function createCopyableCodeBlock(pre: HTMLElement, copyText?: unknown) {
  const wrap = document.createElement("div");
  wrap.className = "copyable-code-block";
  if (copyText !== undefined) wrap.dataset.copyText = String(copyText);
  const button = createCodeCopyButton();
  wrap.append(pre, button);
  return wrap;
}

export function formatJavaScriptCode(code: unknown) {
  const raw = String(code ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return "";
  if (raw.includes("\n")) {
    return raw.split("\n").map(line => line.replace(/\s+$/g, "")).join("\n");
  }
  return formatSingleLineJavaScript(raw);
}

function formatSingleLineJavaScript(code: string) {
  let out = "";
  let indent = 0;
  let inString = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  const appendIndent = () => { out += "  ".repeat(Math.max(0, indent)); };
  const newline = () => {
    out = out.replace(/[ \t]+$/g, "");
    if (!out.endsWith("\n")) out += "\n";
    appendIndent();
  };

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const next = code[i + 1] || "";

    if (inLineComment) {
      out += ch;
      if (ch === "\n") {
        inLineComment = false;
        appendIndent();
      }
      continue;
    }

    if (inBlockComment) {
      out += ch;
      if (ch === "*" && next === "/") {
        out += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = "";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      out += ch + next;
      i += 1;
      inLineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      out += ch + next;
      i += 1;
      inBlockComment = true;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      out += ch;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      out += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      out += ch;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      out += ch;
      continue;
    }
    if (ch === "{") {
      out = out.replace(/[ \t]+$/g, "");
      out += " {";
      indent += 1;
      newline();
      continue;
    }
    if (ch === "}") {
      indent = Math.max(0, indent - 1);
      out = out.replace(/[ \t]+$/g, "");
      if (!out.endsWith("\n")) out += "\n";
      appendIndent();
      out += "}";
      if (next && next !== ";" && next !== "," && next !== ")" && next !== ".") newline();
      continue;
    }
    if (ch === ";") {
      out += ";";
      if (parenDepth === 0) newline();
      continue;
    }
    if (ch === ",") {
      out += ",";
      if (next === " " || bracketDepth > 0) continue;
      out += " ";
      continue;
    }
    out += ch;
  }

  return out.split("\n").map(line => line.replace(/\s+$/g, "")).join("\n").trim();
}

export function parseJsonish(value: unknown): ParsedValue {
  if (value == null || value === "") return { ok: false, value: null };
  if (typeof value !== "string") return { ok: true, value };

  let text = value.trim();
  for (let i = 0; i < 2; i += 1) {
    if (!/^[\[{"]/.test(text)) return { ok: false, value };
    const parsed = parseJsonText(text);
    if (!parsed.ok) return { ok: false, value };
    if (typeof parsed.value !== "string") return parsed;
    text = parsed.value.trim();
  }
  return { ok: false, value };
}

function parseJsonText(text: string): ParsedValue {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch(_e) {
    try {
      return { ok: true, value: JSON.parse(escapeJsonControlCharsInStrings(text)) };
    } catch(_ignored) {
      return { ok: false, value: null };
    }
  }
}

export function escapeJsonControlCharsInStrings(text: string) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of String(text)) {
    if (!inString) {
      out += ch;
      if (ch === "\"") inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === "\"") {
      out += ch;
      inString = false;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }

  return out;
}

export function isEmptyJsonObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function isLikelyIncompleteJsonText(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^[\[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return false;
  } catch(_e) {
    return true;
  }
}

export function cloneDisplayValue(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)); }
  catch(_e) { return String(value); }
}

export function getResultEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hasEnvelopeField = ["ok", "hasResult", "resultType", "engine", "reason", "error", "code"]
    .some(key => Object.prototype.hasOwnProperty.call(value, key));
  return hasEnvelopeField ? record(value) : null;
}

export function appendScriptTrace(parent: HTMLElement, trace: unknown[]) {
  const rows = (Array.isArray(trace) ? trace : [])
    .map(item => item && typeof item === "object" ? record(item) : { message: String(item ?? "") })
    .filter(item => String(item.message || "").trim())
    .slice(-80);
  if (!rows.length) return;
  const body = rows.map(item => {
    const level = String(item.level || "trace");
    const time = String(item.time || "").replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/\.\d{3}Z$/, "");
    const message = String(item.message || "") || localizeToolFailureCode(item.code || "") || "";
    return `<div class="tool-script-trace-row">
      <span class="tool-script-trace-level">${escapeHtml(level)}</span>
      <span class="tool-script-trace-message">${escapeHtml(message || String(item.message || ""))}</span>
      ${time ? `<span class="tool-script-trace-time">${escapeHtml(time)}</span>` : ""}
    </div>`;
  }).join("");
  appendHtmlSection(parent, "tool-script-trace", `
    <div class="tool-detail-label">trace</div>
    <div class="tool-script-trace-body" data-tool-scroll-surface="trace">${body}</div>
  `);
}
