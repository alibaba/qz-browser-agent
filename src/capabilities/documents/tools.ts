import { modelT } from "./model-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { ToolContext, ToolErrorConstructor, ToolParameter } from '#sdk/background';
import type { GetToolRuntimeDependencies } from '#sdk/background';
import type { DocumentArtifact, SavedDocumentModel } from '#sdk/shared/documents';
import type { DocumentBlock, DocumentSheet, DocumentContent, DocumentSignal } from '#sdk/shared/documents';
type DocumentToolsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies" | "assertUrlAllowed"
  | "withTemporaryDebugger">;
interface DocumentOrigin { sessionId?: string; runId?: string; sourceTool?: string; id?: string; fileId?: string; docModelId?: string; artifactId?: string }
type ContentSummary = ReturnType<typeof summarizeDocumentContent>;
import {
  getDocumentArtifact,
  getDocumentFile,
  getDocumentModel,
  listDocumentArtifacts,
  saveDocumentArtifact,
  saveDocumentFile,
  saveDocumentModel,
} from "#sdk/shared/documents";
import {
  base64ToBytes,
  buildDocumentHtml,
  bytesToBase64,
  normalizeBlocks,
  normalizeSheets,
} from "./document-utils.js";
import { createDocumentBytes, inferDocumentFormat, mimeTypeForFormat, parseDocumentBytes } from "#sdk/background/documents";

import {
  DocumentReadProjectionError,
  projectDocumentRead,
} from "#sdk/shared/documents";
import { DOCUMENT_BLOCK_EXAMPLES, DOCUMENT_BLOCK_INPUT_SCHEMA, DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA, DOCUMENT_OUTPUT_FORMATS, DOCUMENT_SHEET_INPUT_SCHEMA, summarizeDocumentContent, validateDirectDocumentCreateInput } from "#sdk/background/documents";

import { QINGZHOU_DOCUMENT_TOOL_SPECS } from "./skill-contract.js";
import { getSecurityGuardrails, matchBlockedUrl } from "#sdk/shared/security";
import { nowBeijingDateTime } from "#sdk/shared/format";

const DOCUMENT_CREATE_PROPERTIES: Readonly<Record<string, ToolParameter>> = QINGZHOU_DOCUMENT_TOOL_SPECS.document_create.parameters.properties;

/** Registers user downloads and the session-owned document pipeline. */
export function registerFilesDocumentsTools({
  registerTool,
  ToolExecutionError,
  getToolRuntimeDependencies,
  assertUrlAllowed,
  withTemporaryDebugger,
}: DocumentToolsHost) {
registerTool({
  name: "save_file",
  get description() { return modelT("saveFile"); },
  get parameters() { return {
    type: "object",
    properties: {
      filename: { type: "string", description: modelT("saveFilename") },
      mimeType: { type: "string", description: modelT("saveMimeType") },
      content: { type: "string", description: modelT("saveContent") },
    },
    required: ["content"],
  } as const; },
  timeout: { defaultMs: 15000, maxMs: 120000 },
  execute: async ({ filename = "", content, mimeType }) => {
    const text = String(content ?? "");
    mimeType = resolveSaveFileMimeType(filename, mimeType, text);
    filename = resolveSaveFileFilename(filename, mimeType);
    // Use a data URL because Service Workers lack URL.createObjectURL.
    const base64 = btoa(unescape(encodeURIComponent(text)));
    const url = `data:${mimeType};base64,${base64}`;
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    return { downloadId: id, filename, mimeType, size: text.length };
  },
});

const SAVE_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  xml: "text/xml",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
});

const SAVE_FILE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  "application/json": "json",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/xml": "xml",
  "application/xml": "xml",
  "text/javascript": "js",
  "application/javascript": "js",
  "text/css": "css",
  "image/svg+xml": "svg",
  "text/plain": "txt",
});

function resolveSaveFileMimeType(filename = "", mimeType = "", content = "") {
  const explicit = String(mimeType || "").trim();
  if (explicit) return explicit;
  const ext = String(filename || "").split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();
  if (ext && ext !== String(filename || "").toLowerCase()) return SAVE_FILE_MIME_BY_EXTENSION[ext] || "text/plain";
  return inferSaveFileMimeTypeFromContent(content);
}

function inferSaveFileMimeTypeFromContent(content = "") {
  const trimmed = String(content || "").trim();
  if (/^<svg[\s>]/i.test(trimmed)) return "image/svg+xml";
  if (/^(?:<!doctype\s+html|<html[\s>])/i.test(trimmed)) return "text/html";
  if (/^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "application/json";
    } catch (_err) {}
  }
  return "text/plain";
}

function resolveSaveFileFilename(filename = "", mimeType = "") {
  const clean = String(filename || "").replace(/^[\\/]+/, "").trim();
  if (clean) return clean;
  const stamp = nowBeijingDateTime().replace(/\D/g, "").slice(0, 14) || String(Date.now());
  return `qingzhou-output-${stamp}.${extensionForSaveFileMimeType(mimeType)}`;
}

function extensionForSaveFileMimeType(mimeType = "") {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return SAVE_FILE_EXTENSION_BY_MIME[normalized] || "txt";
}

function downloadFileUrl(filename: string) {
  const windowsPath = /^[a-z]:[\\/]/i.test(filename) || filename.startsWith("\\\\");
  const path = windowsPath ? filename.replace(/\\/g, "/") : filename;
  if (path.includes("\0") || (!path.startsWith("/") && !/^[a-z]:\//i.test(path))) return undefined;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    return new URL(filename.startsWith("\\\\")
      ? `file:${encoded}`
      : `file://${path.startsWith("/") ? "" : "/"}${encoded.replace(/^([a-z])%3A\//i, "$1:/")}`).href;
  } catch { return undefined; }
}

registerTool({
  name: "list_downloads",
  get description() { return modelT("listDownloads"); },
  get parameters() { return {
    type: "object",
    properties: {
      id: { type: "number", description: modelT("downloadId") },
      limit: { type: "number", description: modelT("downloadLimit") },
      query: { type: "string", description: modelT("downloadQuery") },
    },
  } as const; },
  timeout: { defaultMs: 15000, maxMs: 120000 },
  execute: async ({ id, limit = 10, query }) => {
    const searchOpts: chrome.downloads.DownloadQuery = {};
    if (typeof id === "number" && Number.isInteger(id) && id >= 0) searchOpts.id = id;
    if (query) searchOpts.filenameRegex = query;
    const items = await chrome.downloads.search(searchOpts);
    const guardrails = await getSecurityGuardrails();
    // Return the newest entries by start time, up to the requested limit.
    items.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    const visibleItems = items.filter(item => !matchBlockedUrl(item.url, guardrails)).slice(0, limit);
    return visibleItems.map(d => ({
      id: d.id,
      filename: d.filename?.split(/[\\/]/).pop() || d.filename,
      ...(searchOpts.id === d.id && d.state === "complete" && d.exists === true
        ? { fileUrl: downloadFileUrl(d.filename) } : {}),
      url: d.url?.slice(0, 100),
      state: d.state,           // in_progress | complete | interrupted
      paused: d.paused,
      bytesReceived: d.bytesReceived,
      totalBytes: d.totalBytes,
      startTime: d.startTime,
      endTime: d.endTime || null,
      error: d.error || null,
    }));
  },
});

registerTool({
  name: "download_url",
  get description() { return modelT("downloadUrl"); },
  get parameters() { return {
    type: "object",
    properties: {
      url: { type: "string", description: modelT("fileUrl") },
      filename: { type: "string", description: modelT("fileDownloadName") },
    },
    required: ["url"],
  } as const; },
  timeout: { defaultMs: 15000, maxMs: 120000 },
  execute: async ({ url, filename }, _signal, context = {}) => {
    const opts: chrome.downloads.DownloadOptions = { url };
    if (filename) opts.filename = filename;
    const id = await chrome.downloads.download(opts);
    return {
      downloadId: id,
      url,
      filename,
      artifactRecorded: Boolean(context.sessionId),
      note: context.sessionId
        ? t("downloadRegisteredAsAFileArtifactForThisTask", { id: String(id) })
        : t("downloadStartedUseListDownloadsIdToCheckIts", { id: String(id) }),
    };
  },
});

// ===========================================================================
// Document input and output
// ===========================================================================

registerTool({
  name: "document_fetch",
  get description() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_fetch.description; },
  get parameters() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_fetch.parameters; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  execute: async ({ url, filename = "", mimeType = "" }, _signal, context = {}) => {
    const fetched = await fetchDocumentUrl(url, { filename, mimeType });
    const summary = await saveDocumentFile({
      ...fetched,
      ...documentToolMeta(context, "document_fetch"),
    });
    return {
      ...summary,
      format: inferDocumentFormat(summary),
      note: modelT("fileFetched"),
    };
  },
});

registerTool({
  name: "document_parse",
  get description() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_parse.description; },
  get parameters() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_parse.parameters; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  execute: async ({ fileId, chunkSize = 6000 }, _signal, context = {}) => {
    const file = await getDocumentFile(fileId);
    if (!file) throw new ToolExecutionError("DOCUMENT_FILE_NOT_FOUND", t("documentFileNotFound", { path: String(fileId) }), { fileId });
    assertDocumentOwnedBySession(file, context, "document_parse");
    const bytes = base64ToBytes(file.base64);
    const parsed = await parseDocumentBytes(bytes, {
      filename: file.filename,
      mimeType: file.mimeType,
      chunkSize,
    });
    const model = await saveDocumentModel({
      ...parsed,
      fileId,
      ...documentToolMeta(context, "document_parse", file),
    });
    return {
      ...model,
      note: modelT("fileParsed"),
    };
  },
});

registerTool({
  name: "document_read_chunk",
  get description() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_read_chunk.description; },
  get parameters() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_read_chunk.parameters; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  execute: async ({ docModelId, chunkIndex = 0, tableId = "", sheetName = "", offset = 0, limit = 50 }, _signal, context = {}) => {
    const model = await getDocumentModel(docModelId);
    if (!model) throw new ToolExecutionError("DOCUMENT_MODEL_NOT_FOUND", t("documentModelNotFound", { id: String(docModelId) }), { docModelId });
    assertDocumentOwnedBySession(model, context, "document_read_chunk");
    try {
      return projectDocumentRead(model, { chunkIndex, tableId, sheetName, offset, limit });
    } catch (error) {
      if (error instanceof DocumentReadProjectionError) {
        throw new ToolExecutionError(error.code, error.message, error.details);
      }
      throw error;
    }
  },
});

registerTool({
  name: "document_create",
  get description() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_create.description; },
  get parameters() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_create.parameters; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  validateArgs: input => {
    assertDocumentCreateControlArgs(input);
    if (!DOCUMENT_OUTPUT_FORMATS.includes(String(input.format || "").trim().toLowerCase())) {
      throw new ToolExecutionError("DOCUMENT_FORMAT_UNSUPPORTED", t("unsupportedDocumentOutputFormat", { format: String(input.format) }), {
        format: input.format,
        expected: DOCUMENT_CREATE_PROPERTIES.format,
        retry: documentCreateRetry(input),
      });
    }
    const validation = validateDirectDocumentCreateInput({
      blocks: input.blocks === undefined ? [] : input.blocks,
      sheets: input.sheets === undefined ? [] : input.sheets,
    });
    if (!validation.valid) throwDocumentCreateInputError(validation, input);
  },
  execute: async (input, _signal, context = {}) => {
    const normalizedFormat = String(input.format || "").trim().toLowerCase();
    const filename = input.filename || "";
    let title = input.title || "";
    const docModelId = input.docModelId || "";
    const directBlocks = input.blocks ?? [];
    const directSheets = input.sheets ?? [];
    let blocks: DocumentBlock[];
    let sheets: DocumentSheet[];
    const download = input.download === undefined ? true : input.download;
    const saveAs = input.saveAs === undefined ? false : input.saveAs;
    const retry = documentCreateRetry(input);

    if (docModelId && (directBlocks.length || directSheets.length)) {
      throw new ToolExecutionError("DOCUMENT_SOURCE_CONFLICT", t("documentCreateCannotCombineDocmodelidWithDirectBlocksOr"), {
        docModelId,
        blockCount: directBlocks.length,
        sheetCount: directSheets.length,
        recommended: t("useDocmodelidOrRemoveItAndPassBlocksSheets"),
        retry: { ...retry, replacePaths: ["docModelId", "blocks", "sheets"] },
      });
    }

    assertDirectDocumentPayloadAllowed(directBlocks, directSheets, retry);
    let sourceModel: SavedDocumentModel | undefined;
    if (docModelId) {
      sourceModel = await getDocumentModel(docModelId);
      if (!sourceModel) throw new ToolExecutionError("DOCUMENT_MODEL_NOT_FOUND", t("documentModelNotFound", { id: String(docModelId) }), { docModelId });
      assertDocumentOwnedBySession(sourceModel, context, "document_create");
      title = title || sourceModel.title || "";
      blocks = sourceModel.sheets?.length && ["xlsx", "csv"].includes(String(sourceModel.type || "").toLowerCase())
        ? []
        : (sourceModel.blocks || []);
      sheets = sourceModel.sheets || [];
    } else {
      blocks = normalizeBlocks(directBlocks);
      sheets = normalizeSheets(directSheets);
    }

    const contentSummary = summarizeDocumentContent({ title, blocks, sheets });
    assertDocumentContentForFormat(normalizedFormat, { blocks, sheets, contentSummary, retry });
    await assertDocumentImageUrlsAllowed(blocks);

    const outputFilename = ensureDocumentFilename(filename || title || "document", normalizedFormat);
    const mimeType = mimeTypeForFormat(normalizedFormat);
    const bytes = await createDocumentBytes({ format: normalizedFormat, title, blocks, sheets }, {
      signal: _signal,
      printPdf: async (content, signal) => {
        const windowId = await resolveDocumentWindowId(context, getToolRuntimeDependencies, ToolExecutionError);
        const pdf = await createPdfBase64FromDocument(content, withTemporaryDebugger, windowId, signal);
        assertPdfBase64(pdf);
        return base64ToBytes(pdf);
      },
    });
    assertDocumentBytes(normalizedFormat, bytes);
    const base64 = bytesToBase64(bytes);
    const size = bytes.length;

    const artifact = await saveDocumentArtifact({
      filename: outputFilename,
      mimeType,
      format: normalizedFormat,
      size,
      sourceFileId: sourceModel?.fileId || "",
      sourceDocModelId: sourceModel?.id || docModelId || "",
      base64,
      ...documentToolMeta(context, "document_create", sourceModel),
    });
    let downloaded = null;
    if (download !== false) downloaded = await downloadDocumentArtifactRecord({ ...artifact, base64 }, { filename: outputFilename, saveAs });
    return {
      ...artifact,
      downloaded,
      contentSummary: publicDocumentContentSummary(contentSummary),
      note: downloaded ? t("fileCreatedAndAddedToChromeDownloads") : t("localArtifactCreatedUseTheDocumentDownloadToolTo"),
    };
  },
});

registerTool({
  name: "document_download",
  get description() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_download.description; },
  get parameters() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_download.parameters; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  execute: async ({ artifactId, filename = "", saveAs = false }, _signal, context = {}) => {
    const artifact = await getDocumentArtifact(artifactId);
    if (!artifact) throw new ToolExecutionError("DOCUMENT_ARTIFACT_NOT_FOUND", t("documentArtifactNotFound", { id: String(artifactId) }), { artifactId });
    assertDocumentOwnedBySession(artifact, context, "document_download");
    return downloadDocumentArtifactRecord(artifact, { filename, saveAs });
  },
});

registerTool({
  name: "document_list_artifacts",
  get description() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_list_artifacts.description; },
  get parameters() { return QINGZHOU_DOCUMENT_TOOL_SPECS.document_list_artifacts.parameters; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  execute: async ({ limit = 20 }, _signal, context = {}) => listDocumentArtifacts({ limit, sessionId: context.sessionId || "" }),
});

function documentToolMeta(context: ToolContext = {}, sourceTool = "", source: DocumentOrigin = {}) {
  return {
    sessionId: String(context.sessionId || source.sessionId || "").slice(0, 120),
    runId: String(context.runId || source.runId || "").slice(0, 120),
    toolCallId: String(context.toolCallId || "").slice(0, 120),
    sourceTool: String(sourceTool || source.sourceTool || "").slice(0, 120),
  };
}

function assertDocumentOwnedBySession(record: DocumentOrigin = {}, context: ToolContext = {}, toolName = "") {
  const ownerSessionId = String(record.sessionId || "").trim();
  const sessionId = String(context.sessionId || "").trim();
  if (!ownerSessionId || !sessionId || ownerSessionId === sessionId) return;
  throw new ToolExecutionError("DOCUMENT_SESSION_FOREIGN", t("thisDocumentBelongsToAnotherTaskAndCannotBe"), {
    toolName,
    ownerSessionId,
    sessionId,
    recordId: record.id || record.fileId || record.docModelId || record.artifactId || "",
  });
}

async function fetchDocumentUrl(url: string, { filename = "", mimeType = "" } = {}) {
  const targetUrl = String(url || "").trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new ToolExecutionError("INVALID_DOCUMENT_URL", t("documentFetchRequiresAnHttpSUrl"), { url });
  }
  assertUrlAllowed(targetUrl, await getSecurityGuardrails(), { tool: "document_fetch", source: "url" });
  const response = await fetch(targetUrl, {
    credentials: "include",
    redirect: "follow",
  });
  if (!response.ok) {
    throw new ToolExecutionError("DOCUMENT_FETCH_FAILED", t("failedToFetchDocumentHttp", { status: String(response.status) }), {
      url: targetUrl,
      status: response.status,
      statusText: response.statusText,
    });
  }
  assertUrlAllowed(response.url || targetUrl, await getSecurityGuardrails(), { tool: "document_fetch", source: "response_url" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const responseMimeType = String(response.headers.get("content-type") || "").split(";")[0].trim();
  const contentDisposition = response.headers.get("content-disposition") || "";
  const resolvedFilename = sanitizeDocumentFilename(
    filename
      || filenameFromContentDisposition(contentDisposition)
      || filenameFromUrl(response.url || targetUrl)
      || "document",
  );
  const resolvedMimeType = String(mimeType || responseMimeType || mimeTypeForFormat(inferDocumentFormat({ filename: resolvedFilename }))).trim();
  return {
    filename: resolvedFilename,
    mimeType: resolvedMimeType,
    extension: inferDocumentFormat({ filename: resolvedFilename, mimeType: resolvedMimeType }),
    size: bytes.length,
    sourceUrl: targetUrl,
    base64: bytesToBase64(bytes),
  };
}

function filenameFromContentDisposition(header = "") {
  const text = String(header || "");
  const encoded = text.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/["']/g, "")); } catch(_e) {}
  }
  return text.match(/filename="?([^";]+)"?/i)?.[1] || "";
}

function filenameFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(name);
  } catch(_e) {
    return String(url || "").split("?")[0].split("#")[0].split("/").pop() || "";
  }
}

function sanitizeDocumentFilename(filename = "") {
  const clean = String(filename || "document")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return clean || "document";
}

function ensureDocumentFilename(filename = "", format = "") {
  const clean = sanitizeDocumentFilename(filename || "document");
  const ext = String(format || "").toLowerCase();
  if (!ext) return clean;
  return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean.replace(/\.[^.]+$/, "")}.${ext}`;
}

function assertDocumentCreateControlArgs(input: Record<string, unknown> = {}) {
  const retry = documentCreateRetry(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("INVALID_ARGUMENTS", t("documentCreateExpectsAnObject"), {
      receivedType: Array.isArray(input) ? "array" : input === null ? "null" : typeof input,
      retry,
    });
  }
  if (input.format == null || String(input.format).trim() === "") {
    throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", t("documentCreateRequiresFormat"), {
      name: "document_create",
      missing: ["format"],
      expected: { format: DOCUMENT_CREATE_PROPERTIES.format },
      retry,
    });
  }

  const issues = [];
  for (const [key, schema] of Object.entries(DOCUMENT_CREATE_PROPERTIES)) {
    const value = input[key];
    if (value === undefined || documentInputMatchesType(value, schema.type)) continue;
    issues.push({
      path: key,
      keyword: "type",
      message: t("mustBe", { field: String(key), type: String(documentInputTypeLabel(schema.type)) }),
      expectedType: schema.type,
      receivedType: documentInputType(value),
    });
  }
  const allowedKeys = new Set([...Object.keys(DOCUMENT_CREATE_PROPERTIES), "timeout", "timeoutMs"]);
  const unexpectedKeys = Object.keys(input).filter(key => !allowedKeys.has(key));
  if (unexpectedKeys.length) {
    issues.push({
      path: "$",
      keyword: "additionalProperties",
      message: t("documentCreateContainsUnsupportedFields", { fields: String(unexpectedKeys.join(", ")) }),
      unexpectedKeys: unexpectedKeys.slice(0, 20),
    });
  }
  if (!issues.length) return;
  const expected = Object.fromEntries(issues
    .map(issue => String(issue.path || "").match(/^[^.[\]]+/)?.[0] || "")
    .filter(key => DOCUMENT_CREATE_PROPERTIES[key])
    .map(key => [key, DOCUMENT_CREATE_PROPERTIES[key]]));
  throw new ToolExecutionError("DOCUMENT_CREATE_SCHEMA_INVALID", t("documentCreateArgumentsDoNotMatchTheSchema"), {
    issueCount: issues.length,
    issues,
    ...(Object.keys(expected).length
      ? { expected }
      : {
        expectedSchema: QINGZHOU_DOCUMENT_TOOL_SPECS.document_create.parameters,
        allowedFields: [...allowedKeys],
      }),
    retry,
  });
}

function documentInputMatchesType(value: unknown, type?: ToolParameter["type"]) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function documentInputType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function documentInputTypeLabel(type?: ToolParameter["type"]) {
  const labels: Record<string, string> = { array: t("anArray"), boolean: t("aBoolean"), number: t("number"), object: t("anObject"), string: t("aString") };
  return labels[String(type)] || ` ${type}`;
}

function throwDocumentCreateInputError(validation: ReturnType<typeof validateDirectDocumentCreateInput>, input: Record<string, unknown> = {}) {
  const invalidBlocks = validation.invalidFields?.includes("blocks");
  const invalidSheets = validation.invalidFields?.includes("sheets");
  const code = invalidBlocks && !invalidSheets
    ? "DOCUMENT_BLOCK_SCHEMA_INVALID"
    : invalidSheets && !invalidBlocks
      ? "DOCUMENT_SHEET_SCHEMA_INVALID"
      : "DOCUMENT_CREATE_SCHEMA_INVALID";
  const label = invalidBlocks && invalidSheets ? "blocks/sheets" : invalidBlocks ? "blocks" : "sheets";
  const replacePaths = [invalidBlocks ? "blocks" : "", invalidSheets ? "sheets" : ""].filter(Boolean);
  throw new ToolExecutionError(code, t("containsSchemaIssueSNoDocumentWasCreated", { path: String(label), count: String(validation.issueCount) }), {
    schemaVersion: 1,
    issueCount: validation.issueCount,
    issues: validation.issues,
    omittedIssueCount: validation.omittedIssueCount,
    invalidFields: validation.invalidFields,
    expectedSchema: invalidBlocks && !invalidSheets
      ? DOCUMENT_BLOCK_INPUT_SCHEMA
      : invalidSheets && !invalidBlocks
        ? DOCUMENT_SHEET_INPUT_SCHEMA
        : DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA,
    ...(invalidBlocks ? { examples: DOCUMENT_BLOCK_EXAMPLES } : {}),
    retry: { ...documentCreateRetry(input), replacePaths },
  });
}

function assertDocumentContentForFormat(format: string, { blocks, sheets, contentSummary, retry }: { blocks: DocumentBlock[]; sheets: DocumentSheet[]; contentSummary: ContentSummary; retry: Record<string, unknown> }) {
  if (!contentSummary.meaningful) {
    throw new ToolExecutionError("DOCUMENT_CONTENT_EMPTY", t("documentCreateReceivedNoMeaningfulDocumentContent"), {
      contentSummary: publicDocumentContentSummary(contentSummary),
      recommended: t("provideAtLeastOneBlockWithContentOrA"),
      retry: { ...retry, replacePaths: ["blocks", "sheets"] },
    });
  }
  if (!["xlsx", "csv"].includes(format)) return;

  const tableBlocks = blocks.filter(block => block?.type === "table");
  const nonTableBlockPaths = blocks
    .map((block, index) => block?.type === "table" ? "" : `blocks[${index}]`)
    .filter(Boolean);
  if (nonTableBlockPaths.length) {
    throw new ToolExecutionError("DOCUMENT_TABULAR_CONTENT_REQUIRED", t("outputCannotPreserveNonTableBlocks", { format: String(format) }), {
      format,
      nonTableBlockPaths: nonTableBlockPaths.slice(0, 20),
      recommended: t("forXlsxCsvPassOnlyTableBlocksOrSheets"),
      retry: { ...retry, replacePaths: ["format", "blocks", "sheets"] },
    });
  }
  if (!tableBlocks.length && !sheets.length) {
    throw new ToolExecutionError("DOCUMENT_TABULAR_CONTENT_REQUIRED", t("outputRequiresAtLeastOneTableOrSheet", { format: String(format) }), {
      format,
      recommended: t("provideATableBlockSheetOrUseDocxPdf"),
      retry: { ...retry, replacePaths: ["format", "blocks", "sheets"] },
    });
  }
  if (tableBlocks.length && sheets.length) {
    throw new ToolExecutionError("DOCUMENT_TABULAR_SOURCE_CONFLICT", t("outputCannotCombineTableBlocksAndSheetsWithoutDropping", { format: String(format) }), {
      format,
      tableCount: tableBlocks.length,
      sheetCount: sheets.length,
      recommended: t("putAllTablesInEitherBlocksOrSheets"),
      retry: { ...retry, replacePaths: ["blocks", "sheets"] },
    });
  }
  const tabularSourceCount = tableBlocks.length + sheets.length;
  if (format === "csv" && tabularSourceCount !== 1) {
    throw new ToolExecutionError("DOCUMENT_CSV_MULTIPLE_TABLES", t("csvOutputSupportsExactlyOneTableOrSheet"), {
      tableCount: tableBlocks.length,
      sheetCount: sheets.length,
      recommended: t("keepASingleTableSheetOrUseXlsxFor"),
      retry: { ...retry, replacePaths: ["format", "blocks", "sheets"] },
    });
  }
}

async function assertDocumentImageUrlsAllowed(blocks: readonly DocumentBlock[] = []) {
  const urls = [...new Set(blocks
    .filter(block => block?.type === "image" && /^https?:\/\//i.test(String(block.url || "")))
    .map(block => String(block.url || "").trim()))];
  if (!urls.length) return;
  const guardrails = await getSecurityGuardrails();
  urls.forEach(url => assertUrlAllowed(url, guardrails, { tool: "document_create", source: "blocks.image.url" }));
}

function assertPdfBase64(base64 = "") {
  const clean = String(base64 || "").replace(/\s+/g, "");
  let prefix = "";
  try {
    prefix = atob(clean.slice(0, 16));
  } catch (_error) {
    // Report the stable PDF contract below.
  }
  if (!prefix.startsWith("%PDF-")) {
    throw new ToolExecutionError("PDF_PRINT_FAILED", t("chromePagePrinttopdfReturnedInvalidPdfData"), {
      base64Chars: clean.length,
    });
  }
}

function assertDocumentBytes(format: string, bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new ToolExecutionError("DOCUMENT_OUTPUT_EMPTY", t("generatedDocumentIsEmpty", { format: String(format) }), { format });
  }
  if (["docx", "xlsx"].includes(format) && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) {
    throw new ToolExecutionError("DOCUMENT_OUTPUT_INVALID", t("generatedDocumentIsNotAValidZipContainer", { format: String(format) }), {
      format,
      prefix: [...bytes.slice(0, 4)],
    });
  }
}

function documentCreateRetry(input: Record<string, unknown> = {}) {
  const preservedArgs: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(DOCUMENT_CREATE_PROPERTIES)) {
    if (!["string", "number", "boolean"].includes(String(schema.type))) continue;
    const value = input?.[key];
    if (
      documentInputMatchesType(value, schema.type)
      && (!Array.isArray(schema.enum) || schema.enum.some(entry => Object.is(entry, value)))
      && (typeof value !== "string" || value.length <= 500)
    ) {
      preservedArgs[key] = value;
    }
  }
  return { preservedArgs };
}

function publicDocumentContentSummary(summary: ContentSummary) {
  const { meaningful: _meaningful, ...publicSummary } = summary || {};
  return publicSummary;
}

function assertDirectDocumentPayloadAllowed(blocks: readonly unknown[] = [], sheets: readonly unknown[] = [], retry: Record<string, unknown> = {}) {
  let payloadChars = 0;
  try {
    payloadChars = JSON.stringify({ blocks, sheets }).length;
  } catch(error) {
    throw new ToolExecutionError("DOCUMENT_CREATE_SCHEMA_INVALID", t("directBlocksSheetsMustBeJsonSerializable"), {
      reason: String(error instanceof Error ? error.message : error || "serialization_failed").slice(0, 500),
      expectedSchema: DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA,
      retry: { ...retry, replacePaths: ["blocks", "sheets"] },
    });
  }
  if (payloadChars <= 200000) return;
  throw new ToolExecutionError(
    "DOCUMENT_DIRECT_PAYLOAD_TOO_LARGE",
    t("directBlocksSheetsPayloadIsTooLargeSaveOr"),
    {
      payloadChars,
      recommended: "load_skill(\"qingzhou-documents\") and follow its parse -> create flow with docModelId",
    },
  );
}

async function createPdfBase64FromDocument({ title = "", blocks = [], sheets = [] }: DocumentContent, withTemporaryDebugger: DocumentToolsHost["withTemporaryDebugger"], windowId: number, signal?: DocumentSignal) {
  if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "PDF generation was cancelled");
  const html = buildDocumentHtml({ title, blocks, sheets });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const tab = await chrome.tabs.create({ windowId, url, active: false });
  const tabId = tab.id;
  if (!tabId) throw new ToolExecutionError("PDF_TAB_CREATE_FAILED", t("failedToCreateTemporaryPdfRenderTab"), {});
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const onAbort = () => {
    void chrome.tabs.remove(tabId).catch(() => {});
    rejectAbort(new ToolExecutionError("OPERATION_ABORTED", "PDF generation was cancelled", { tabId }));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const command = <T>(operation: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "PDF generation was cancelled");
    return Promise.race([operation(), aborted]);
  };
  try {
    if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "PDF generation was cancelled");
    await waitForTabComplete(tabId, 30000, signal);
    if (typeof withTemporaryDebugger !== "function") {
      throw new ToolExecutionError("DEBUGGER_UNAVAILABLE", t("temporaryPdfRenderingRequiresTheChromeDebuggerRuntime"), { tabId });
    }
    const result = await withTemporaryDebugger(tabId, async (_target, send) => {
      await command(() => send("Page.enable", {}));
      return await command(() => send("Page.printToPDF", {
        printBackground: true,
        preferCSSPageSize: true,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      }));
    }, "document_pdf");
    if (!result || typeof result !== "object" || !("data" in result) || typeof result.data !== "string" || !result.data) {
      throw new ToolExecutionError("PDF_PRINT_FAILED", t("chromePagePrinttopdfReturnedEmptyData"), { tabId });
    }
    return result.data;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await chrome.tabs.remove(tabId); } catch(_e) {}
  }
}

async function resolveDocumentWindowId(context: ToolContext, getToolRuntimeDependencies: GetToolRuntimeDependencies, ToolExecutionError: ToolErrorConstructor) {
  const resolver = getToolRuntimeDependencies(context).windowTarget?.resolveForNewTab;
  if (typeof resolver !== "function") {
    throw new ToolExecutionError("BROWSER_WINDOW_TARGET_UNAVAILABLE", "Browser window target resolver is unavailable");
  }
  return await resolver({
    anchorTabId: context?.workingTabId,
    sourceWindowId: context?.sourceWindowId,
  });
}

function waitForTabComplete(tabId: number, timeoutMs = 30000, signal?: DocumentSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ToolExecutionError("OPERATION_ABORTED", "PDF generation was cancelled", { tabId }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const complete = () => {
      cleanup();
      resolve();
    };
    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") complete();
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new ToolExecutionError("TAB_LOAD_TIMEOUT", t("temporaryTabDidNotFinishLoading", { tabId: String(tabId) }), { tabId, timeoutMs }));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") complete();
    }).catch(() => {});
  });
}

async function downloadDocumentArtifactRecord(artifact: Partial<DocumentArtifact> & { artifactId?: string }, { filename = "", saveAs = false } = {}) {
  const resolvedFilename = ensureDocumentFilename(filename || artifact.filename || "document", artifact.format || "");
  const base64 = artifact.base64 || "";
  if (!base64) {
    const stored = await getDocumentArtifact(artifact.artifactId || artifact.id || "");
    if (!stored?.base64) throw new ToolExecutionError("DOCUMENT_ARTIFACT_EMPTY", t("documentArtifactHasNoContent"), { artifactId: artifact.artifactId || artifact.id });
    artifact = stored;
  }
  const url = `data:${artifact.mimeType || mimeTypeForFormat(artifact.format || "")};base64,${artifact.base64}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename: resolvedFilename,
    saveAs: Boolean(saveAs),
  });
  return {
    downloadId,
    filename: resolvedFilename,
    state: "in_progress",
  };
}
}


export default registerFilesDocumentsTools satisfies ToolExtension;
