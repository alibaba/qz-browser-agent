import { t } from "../i18n/index.js";
import { toolPresentationRegistry } from "./tool-presentation.js";
import { findSkillManifestResource, parseSkillManifest } from "../../shared/skills/skill-manifest.js";
import * as presentation from "./generic-result-renderer.js";
import { record, type ToolEvent } from "./renderer-input.js";

type Data = Record<string, unknown>;

interface ArgsPreviewOptions {
  normalizeToolResult?: (value: unknown) => unknown;
  streamParseCharLimit?: number;
}
interface PageTargetOptions { maxLength?: number; fallbackToTabId?: boolean; fallbackLabel?: string }
interface ParsedArgs { ok: boolean; value: unknown; incomplete: boolean }

import { parse as parsePartialJson } from "partial-json";
import {
  getToolProfileFamily,
  isPageContextToolName,
  toolKey,
} from "./tool-model.js";

export function createToolArgsPreview(options: ArgsPreviewOptions) {
  const normalizeToolResult = options.normalizeToolResult || (value => value);
  const STREAM_ARGS_PARSE_CHAR_LIMIT = Number(options.streamParseCharLimit || 300000);

function normalizeToolArgsForRender(tool: ToolEvent) {
  const rawText = typeof tool.argsText === "string" ? tool.argsText : "";
  const parsed = rawText ? parseStreamingJson(rawText) : { ok: false, value: null, incomplete: false };
  const objectArgs = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args)
    ? record(tool.args)
    : null;
  const parsedObject = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? record(parsed.value)
    : null;
  const value = objectArgs && !presentation.isEmptyJsonObject(objectArgs)
    ? objectArgs
    : (parsedObject || objectArgs || {});
  return {
    value,
    rawText,
    incomplete: Boolean(tool.argsIncomplete || tool.argsComplete === false || parsed.incomplete),
  };
}

function formatToolArgs(value: unknown, rawText = "", toolOrName: ToolEvent | string = "", result: unknown = undefined) {
  const toolName = toolKey(toolOrName);
  if (!value || typeof value !== "object") {
    return rawText ? t("argumentCharacters", { count: rawText.length }) : "";
  }
  const args = record(value);
  const summary = toolPresentationRegistry.project("argsSummary", toolOrName, args, normalizeToolResult(result), rawText);
  if (summary !== undefined) return summary;
  if (isPageContextToolName(toolOrName)) {
    const pagePreview = formatPageContextArgsPreview(args, result, rawText, toolName);
    if (pagePreview) return pagePreview;
  }
  const keys = Object.keys(args).filter(key => !shouldHideArgInSummary(key, toolName));
  if (keys.length === 0) return rawText ? t("argumentCharacters", { count: rawText.length }) : "";
  const preview = keys.slice(0, 2).map((k) => {
    return `${k}=${formatToolArgPreviewValue(args[k])}`;
  }).join(", ");
  return `(${preview})`;
}

function shouldHideArgInSummary(key: string, toolName = "") {
  if (!isPageContextToolName(toolName)) return false;
  return /^_?tabid$/i.test(String(key || ""));
}

function formatPageContextArgsPreview(args: Record<string, unknown>, result: unknown, rawText = "", toolName = "") {
  const normalizedResult = normalizeToolResult(result);
  const target = pageDisplayTarget(args, normalizedResult, { maxLength: 42, fallbackToTabId: false });
  if (target) return `(${target})`;
  if (shouldUsePageContextFallback(toolName, args)) {
    const fallbackTarget = pageDisplayTarget(args, normalizedResult, {
      maxLength: 42,
      fallbackToTabId: false,
      fallbackLabel: pageContextFallbackLabel(toolName),
    }) || pageContextFallbackLabel(toolName);
    if (fallbackTarget) return `(${fallbackTarget})`;
  }
  return rawText ? t("argumentCharacters", { count: rawText.length }) : "";
}

function readArticleDisplayTarget(args: unknown = {}, result: unknown = {}, { maxLength = 48, fallbackToTabId = true }: PageTargetOptions = {}) {
  return pageDisplayTarget(args, result, { maxLength, fallbackToTabId });
}

function pageDisplayTarget(args: unknown = {}, result: unknown = {}, { maxLength = 48, fallbackToTabId = true, fallbackLabel = "" }: PageTargetOptions = {}) {
  const resultObject = record(result);
  const argsObject = record(args);
  const nestedResult = record(resultObject.result);
  const nestedValue = record(resultObject.value);
  const details = record(resultObject.details);
  const title = presentation.firstNonEmpty([
    resultObject._pageTitle,
    resultObject.pageTitle,
    resultObject.tabTitle,
    nestedResult._pageTitle,
    nestedResult.pageTitle,
    nestedResult.tabTitle,
    nestedValue._pageTitle,
    nestedValue.pageTitle,
    nestedValue.tabTitle,
    details._pageTitle,
    details.pageTitle,
    details.tabTitle,
    argsObject._pageTitle,
    argsObject.pageTitle,
    argsObject.tabTitle,
    resultObject.siteName && resultObject.title ? `${resultObject.siteName} · ${resultObject.title}` : "",
    resultObject.title,
    nestedResult.siteName && nestedResult.title ? `${nestedResult.siteName} · ${nestedResult.title}` : "",
    nestedResult.title,
    nestedValue.siteName && nestedValue.title ? `${nestedValue.siteName} · ${nestedValue.title}` : "",
    nestedValue.title,
    details.title,
    record(details.tab).title,
  ]);
  if (title) return presentation.summarizeValue(title, maxLength);
  const url = presentation.firstNonEmpty([
    resultObject._pageUrl,
    resultObject.url,
    resultObject.pageUrl,
    nestedResult._pageUrl,
    nestedResult.url,
    nestedResult.pageUrl,
    nestedValue._pageUrl,
    nestedValue.url,
    nestedValue.pageUrl,
    details._pageUrl,
    details.url,
    details.pageUrl,
    record(details.tab).url,
    argsObject._pageUrl,
    argsObject.pageUrl,
    argsObject.url,
  ]);
  if (url) return presentation.summarizeValue(url, maxLength);
  const tabRef = presentation.firstNonEmpty([argsObject.tabRef, resultObject.tabRef, nestedResult.tabRef]);
  if (tabRef !== "") return presentation.summarizeValue(t("tabNamed", { name: String(tabRef) }), maxLength);
  const tabId = presentation.firstNonEmpty([
    resultObject._tabId,
    nestedResult._tabId,
    nestedValue._tabId,
    details._tabId,
    resultObject.tabId,
    nestedResult.tabId,
    nestedValue.tabId,
    argsObject._tabId,
    argsObject.tabId,
  ]);
  if (fallbackLabel) return presentation.summarizeValue(fallbackLabel, maxLength);
  if (fallbackToTabId && tabId !== "") return t("tabNamed", { name: String(tabId) });
  return "";
}

function pageContextFallbackLabel(toolName = "") {
  if (!isPageContextToolName(toolName)) return "";
  return getToolProfileFamily(toolName) === "navigation" ? t("targetPage") : t("currentPage");
}

function shouldUsePageContextFallback(toolName = "", args: unknown = {}) {
  const argsObject = record(args);
  const visibleKeys = Object.keys(argsObject).filter(item => !shouldHideArgInSummary(item, toolName));
  return visibleKeys.length === 0 && Boolean(pageContextFallbackLabel(toolName));
}

function formatToolArgPreviewValue(value: unknown) {
  if (Array.isArray(value)) return value.length ? "[...]" : "[]";
  if (value && typeof value === "object") return Object.keys(value).length ? "{...}" : "{}";
  if (typeof value === "string") return value.length > 30 ? `${value.slice(0, 30)}…` : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return value == null ? "" : String(value);
}

function parseStreamingJson(text: string): ParsedArgs {
  const raw = String(text || "");
  const source = raw.length > STREAM_ARGS_PARSE_CHAR_LIMIT
    ? raw.slice(0, STREAM_ARGS_PARSE_CHAR_LIMIT)
    : raw;
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, value: {}, incomplete: false };
  try {
    return { ok: true, value: JSON.parse(trimmed), incomplete: raw.length > STREAM_ARGS_PARSE_CHAR_LIMIT };
  } catch (_err) {
    try {
      return { ok: true, value: parsePartialJson(trimmed), incomplete: true };
    } catch (_partialErr) {
      try {
        return { ok: true, value: parsePartialJson(presentation.escapeJsonControlCharsInStrings(trimmed)), incomplete: true };
      } catch (_repairErr) {
        return { ok: false, value: {}, incomplete: true };
      }
    }
  }
}

  return {
    normalize: normalizeToolArgsForRender,
    format: formatToolArgs,
    readArticleDisplayTarget,
    pageDisplayTarget,
  };
}

