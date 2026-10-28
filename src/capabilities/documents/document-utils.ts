import { t } from "./i18n.js";
export { bytesToBase64, base64ToBytes } from "#sdk/shared/format";
import { createZipBytes, openZip } from "#sdk/shared/format";
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import { WorkerMessageHandler as pdfJsWorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";
import { CODE_FILENAMES, isCodeDocumentExtension, isCodeDocumentMime } from "#sdk/shared/documents";
import {
  buildDocumentContentChunks,
} from "#sdk/shared/documents";

import type { DocumentContent, DocumentModel, DocumentBlock, DocumentSheet, DocumentOptions } from '#sdk/shared/documents';
import type { ZipSignal } from '#sdk/shared/format';

type Data = Record<string, unknown>;
interface ListItem { text: string; children: ListItem[] }
interface Block extends DocumentBlock {
  text?: string; name?: string; level?: number; columns?: string[]; rows?: Data[]; items?: ListItem[];
  ordered?: boolean; url?: string; caption?: string; alt?: string; language?: string;
  _pageNumber?: number; _fontSize?: number;
}
interface PdfLine { pageNumber: number; x: number; y: number; size: number; text: string }
interface PdfRawLine extends Omit<PdfLine, 'text'> { items: { text: string; x: number; width: number; size: number }[] }
type PdfTextItem = Awaited<ReturnType<pdfjsLib.PDFPageProxy["getTextContent"]>>["items"][number];
const record = (value: unknown): Data => value && typeof value === "object" ? value as Data : {};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const WORD_PAGE_WIDTH = 11906;
const WORD_PAGE_HEIGHT = 16838;
const WORD_PAGE_MARGIN = 1440;
const WORD_CONTENT_WIDTH = WORD_PAGE_WIDTH - WORD_PAGE_MARGIN * 2;
const WORD_BODY_FONT = "Aptos";
const WORD_EAST_ASIA_FONT = "PingFang SC";

export function createHtmlBytes(content: DocumentContent) { return encoder.encode(buildDocumentHtml(content)); }
export function createTextBytes({ blocks = [], sheets = [] }: DocumentContent = {}) { return encoder.encode(blocksToPlainText(blocks, sheets)); }
export function createCsvBytes({ blocks = [], sheets = [] }: DocumentContent = {}) { return encoder.encode(sheetsToCsv(sheets.length ? sheets : tablesToSheets(blocks))); }
export function createWorkbookBytes({ title = "", blocks = [], sheets = [] }: DocumentContent = {}) { return createXlsxBytes({ title, sheets: sheets.length ? sheets : tablesToSheets(blocks) }); }

export function buildDocumentHtml({ title = "", blocks = [], sheets = [] }: DocumentContent = {}) {
  const body = [];
  const safeTitle = escapeHtml(title || firstText(blocks) || "Document");
  body.push("<!doctype html><html><head><meta charset=\"utf-8\">");
  body.push(`<title>${safeTitle}</title>`);
  body.push("<style>");
  body.push(`
    @page { size: A4; margin: 18mm 16mm; }
    body { color: #171717; font: 14px/1.72 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    h1, h2, h3 { line-height: 1.25; margin: 22px 0 10px; page-break-after: avoid; }
    h1 { font-size: 26px; } h2 { font-size: 21px; } h3 { font-size: 17px; }
    p { margin: 8px 0; white-space: pre-wrap; }
    a { color: #1d4ed8; text-decoration: none; }
    img { max-width: 100%; height: auto; margin: 10px 0; }
    figure { margin: 14px 0; } figcaption { color: #737373; font-size: 12px; }
    pre { margin: 12px 0 16px; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #f8fafc; overflow: auto; white-space: pre; }
    code { font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    table { width: 100%; border-collapse: collapse; margin: 14px 0 20px; page-break-inside: auto; }
    th, td { border: 1px solid #d6d6d6; padding: 7px 9px; text-align: left; vertical-align: top; word-break: break-word; }
    th { background: #f5f5f5; font-weight: 700; }
    .sheet-title { margin-top: 26px; color: #525252; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
  `);
  body.push("</style></head><body>");
  for (const block of normalizeBlocks(blocks)) body.push(blockToHtml(block));
  for (const sheet of normalizeSheets(sheets)) {
    body.push(`<h2 class="sheet-title">${escapeHtml(sheet.name || "Sheet")}</h2>`);
    body.push(tableToHtml(sheet.columns, sheet.rows));
  }
  body.push("</body></html>");
  return body.join("");
}

export function normalizeBlocks(blocks: unknown = []): Block[] {
  return Array.isArray(blocks) ? blocks.filter(block => block && typeof block === "object").map(normalizeBlock) : [];
}

export function normalizeSheets(sheets: unknown = []): DocumentSheet[] {
  return Array.isArray(sheets) ? sheets.map((raw, index) => {
    const sheet = record(raw);
    const normalizedTable = normalizeTableBlock({
      columns: sheet?.columns,
      rows: sheet?.rows,
      header: sheet?.header,
    });
    return {
      name: String(sheet?.name || `Sheet${index + 1}`).slice(0, 31),
      columns: normalizedTable.columns,
      rows: normalizedTable.rows,
    };
  }) : [];
}

export async function parseDocxToModel(bytes: Uint8Array, { filename = "", chunkSize = 6000, signal }: DocumentOptions = {}): Promise<DocumentModel> {
  const zip = unzip(bytes, signal);
  const documentXml = await zip.text("word/document.xml");
  if (!documentXml) throw new Error(t("docxDocumentXmlNotFound"));
  const blocks = extractDocxBlocks(documentXml);
  const title = firstHeading(blocks) || firstText(blocks) || stripExtension(filename) || "DOCX Document";
  return {
    type: "docx",
    title,
    blocks,
    sheets: [],
    chunks: buildBlockChunks(blocks, chunkSize),
    outline: buildOutline(blocks),
    warnings: [],
  };
}

export async function parseXlsxToModel(bytes: Uint8Array, { filename = "", signal }: DocumentOptions = {}): Promise<DocumentModel> {
  const zip = unzip(bytes, signal);
  const workbookXml = await zip.text("xl/workbook.xml");
  if (!workbookXml) throw new Error(t("xlsxWorkbookXmlNotFound"));
  const relsXml = await zip.text("xl/_rels/workbook.xml.rels");
  const rels = parseWorkbookRels(relsXml);
  const sharedStrings = parseSharedStrings(await zip.text("xl/sharedStrings.xml"));
  const sheets: DocumentSheet[] = [];
  const sheetRe = /<sheet\b([^>]*?)\/>/g;
  let match;
  while ((match = sheetRe.exec(workbookXml))) {
    const attrs = parseAttrs(match[1]);
    const name = attrs.name || `Sheet${sheets.length + 1}`;
    const rid = attrs["r:id"] || attrs.id || "";
    let target = rels[rid] || `worksheets/sheet${sheets.length + 1}.xml`;
    target = target.replace(/^\/?xl\//, "");
    const xml = await zip.text(`xl/${target}`);
    if (!xml) continue;
    sheets.push(parseWorksheetXml(xml, name, sharedStrings));
  }
  return {
    type: "xlsx",
    title: stripExtension(filename) || "Workbook",
    blocks: [],
    sheets,
    chunks: [],
    outline: sheets.map(sheet => ({ level: 1, text: sheet.name })),
    warnings: [],
  };
}

export function parseCsvToModel(bytes: Uint8Array, { filename = "" }: DocumentOptions = {}): DocumentModel {
  const text = decoder.decode(bytes);
  const rows = parseCsvRows(text);
  const columns = uniqueColumnLabels(rows[0]?.map((value, index) => String(value || `Column ${index + 1}`)) || []);
  const sheetRows = rows.slice(1).map(row => normalizeRow(Object.fromEntries(columns.map((column, index) => [column, row[index] || ""])), columns));
  const sheets = [{ name: stripExtension(filename) || "CSV", columns, rows: sheetRows }];
  return {
    type: "csv",
    title: stripExtension(filename) || "CSV",
    blocks: [],
    sheets,
    chunks: [],
    outline: [],
    warnings: [],
  };
}

export function parseHtmlToModel(bytes: Uint8Array, { filename = "", chunkSize = 6000 }: DocumentOptions = {}): DocumentModel {
  const html = decoder.decode(bytes);
  const title = decodeXmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || stripExtension(filename) || "HTML");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return textToModel(text, { title, type: "html", chunkSize });
}

export function parseTextToModel(bytes: Uint8Array, { filename = "", mimeType = "", chunkSize = 6000 }: DocumentOptions = {}): DocumentModel {
  const text = decoder.decode(bytes);
  if (isCodeDocumentExtension(filename) || isCodeDocumentMime(mimeType)) {
    return codeToModel(text, {
      title: stripExtension(filename) || filename || "Code",
      language: inferCodeLanguage(filename) || inferCodeLanguageFromMime(mimeType),
      chunkSize,
    });
  }
  return textToModel(text, { title: stripExtension(filename) || "Text", type: "txt", chunkSize });
}

export async function parsePdfToModel(bytes: Uint8Array, { filename = "", chunkSize = 6000, signal }: DocumentOptions = {}): Promise<DocumentModel> {
  const fallbackBytes = bytes instanceof Uint8Array
    ? bytes.slice()
    : new Uint8Array(bytes || []).slice();
  let parserError: unknown = null;
  try {
    const parsed = await parsePdfWithPdfJs(bytes, { filename, chunkSize, signal });
    if (parsed.blocks.length && parsed.blocks.some(block => typeof block.text === "string" && block.text.length > 20)) return parsed;
  } catch (error) {
    if (signal?.aborted) throw documentAborted();
    parserError = error;
    console.warn("[document-utils] PDF.js parse failed, falling back to minimal PDF text extraction", error);
  }

  const raw = latin1Decode(fallbackBytes);
  const pageCount = Math.max(0, (raw.match(/\/Type\s*\/Page\b/g) || []).length);
  const snippets = [];
  const textRe = /\(([^()]{2,300})\)\s*Tj/g;
  let match;
  while ((match = textRe.exec(raw)) && snippets.length < 200) {
    snippets.push(decodePdfLiteral(match[1]));
  }
  const text = snippets.join("\n").trim();
  const model = textToModel(text || `PDF file: ${filename || "document.pdf"}`, {
    title: stripExtension(filename) || "PDF",
    type: "pdf",
    chunkSize,
  });
  model.warnings = [
    `PDF.js parsing failed${parserError ? `: ${parserError instanceof Error ? parserError.message : String(parserError)}` : ""}. Fell back to minimal PDF text extraction; output may be incomplete.`,
  ];
  model.outline = pageCount ? [{ level: 1, text: `${pageCount} pages`, blockIndex: 0 }] : [];
  return model;
}

async function parsePdfWithPdfJs(bytes: Uint8Array, { filename = "", chunkSize = 6000, signal }: DocumentOptions = {}): Promise<DocumentModel> {
  if (signal?.aborted) throw documentAborted();
  configurePdfJs();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: pdfjsLib.VerbosityLevel?.ERRORS,
  });
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ||= loadingTask.destroy();
  const onAbort = () => { void dispose().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw documentAborted();
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (signal?.aborted) throw documentAborted();
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push({
        pageNumber,
        lines: pdfTextItemsToLines(textContent.items || [], pageNumber),
      });
      page.cleanup?.();
    }

    const blocks = pdfPagesToBlocks(pages);
    const title = firstHeading(blocks) || inferPdfTitle(blocks) || stripExtension(filename) || "PDF";
    return {
      type: "pdf",
      title,
      blocks,
      sheets: [],
      chunks: buildBlockChunks(blocks, chunkSize),
      outline: buildOutline(blocks),
      warnings: [],
      pageCount: pdf.numPages,
      parser: "pdfjs",
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await dispose();
  }
}

function documentAborted() {
  return Object.assign(new Error("Document operation cancelled"), { name: "AbortError", code: "ABORT_ERR" });
}

function configurePdfJs() {
  const host = globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler: typeof pdfJsWorkerMessageHandler } };
  // The packaged PDF engine accepts this local handler only; it has no Worker URL fallback.
  host.pdfjsWorker ||= { WorkerMessageHandler: pdfJsWorkerMessageHandler };
}

function pdfTextItemsToLines(items: readonly PdfTextItem[] = [], pageNumber = 1) {
  const lines = [];
  let current: PdfRawLine | null = null;
  for (const item of items) {
    if (!("str" in item)) continue;
    const text = String(item.str || "");
    if (!text.trim()) continue;
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const size = Math.max(1, Number(item.height) || Math.abs(Number(transform[3]) || 0) || Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0) || 10);
    const yTolerance = Math.max(2, size * 0.55);
    if (!current || Math.abs(current.y - y) > yTolerance) {
      if (current) lines.push(finalizePdfLine(current));
      current = { pageNumber, y, x, size, items: [] };
    }
    current.items.push({ text, x, width: Number(item.width) || 0, size });
    current.size = Math.max(current.size, size);
    current.x = Math.min(current.x, x);
  }
  if (current) lines.push(finalizePdfLine(current));
  return lines.filter(line => line.text);
}

function finalizePdfLine(line: PdfRawLine): PdfLine {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  let text = "";
  let prevEnd: number | null = null;
  for (const item of items) {
    const value = item.text.replace(/\s+/g, " ");
    if (!value) continue;
    if (prevEnd != null) {
      const gap = item.x - prevEnd;
      if (gap > item.size * 0.25 && text && !/\s$/.test(text) && !/^\s/.test(value)) text += " ";
    }
    text += value;
    prevEnd = item.x + Math.max(0, item.width);
  }
  return {
    pageNumber: line.pageNumber,
    x: line.x,
    y: line.y,
    size: line.size,
    text: normalizePdfText(text),
  };
}

function pdfPagesToBlocks(pages: { pageNumber: number; lines: PdfLine[] }[] = []): Block[] {
  const allLines = pages.flatMap(page => page.lines || []);
  const medianSize = median(allLines.map(line => line.size).filter(Boolean)) || 10;
  const blocks: Block[] = [];
  let paragraph: PdfLine[] = [];

  function flushParagraph() {
    const text = joinPdfParagraphLines(paragraph.map(line => line.text));
    paragraph = [];
    if (text) blocks.push({ type: "paragraph", text });
  }

  let previousLine: PdfLine | null = null;
  for (const page of pages) {
    for (const line of page.lines || []) {
      const text = line.text;
      if (!text || isLikelyPdfNoiseLine(text, line.pageNumber)) continue;
      const headingLevel = pdfHeadingLevel(line, medianSize, blocks.length);
      const pageChanged = previousLine && previousLine.pageNumber !== line.pageNumber;
      const verticalGap = previousLine && !pageChanged ? Math.abs(previousLine.y - line.y) : 0;
      const paragraphBreak = pageChanged || verticalGap > Math.max(medianSize * 1.55, 16) || shouldBreakPdfParagraph(previousLine?.text || "", text);
      if (headingLevel) {
        flushParagraph();
        blocks.push({ type: "heading", level: headingLevel, text, _pageNumber: line.pageNumber, _fontSize: line.size });
      } else {
        if (paragraphBreak) flushParagraph();
        paragraph.push(line);
      }
      previousLine = line;
    }
    flushParagraph();
  }
  return cleanupPdfBlocks(blocks.length ? blocks : [{ type: "paragraph", text: `PDF file: ${pages.length || "unknown"} pages` }]);
}

function cleanupPdfBlocks(blocks: Block[] = []) {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      const last = out[out.length - 1];
      if (canMergePdfHeading(last, block, out.length)) {
        last.text = normalizePdfText(`${last.text} ${block.text}`);
        last.level = Math.min(last.level || 2, block.level || 2);
        last._fontSize = Math.max(last._fontSize || 0, block._fontSize || 0);
        continue;
      }
    }
    out.push({ ...block });
  }
  return out.map(({ _pageNumber, _fontSize, ...block }) => block);
}

function canMergePdfHeading(previous: Block | undefined, current: Block, outputIndex: number): previous is Block {
  if (!previous || previous.type !== "heading" || current.type !== "heading") return false;
  if (previous._pageNumber !== current._pageNumber) return false;
  const previousSize = Number(previous._fontSize) || 0;
  const currentSize = Number(current._fontSize) || 0;
  const similarSize = previousSize && currentSize ? Math.abs(previousSize - currentSize) <= Math.max(1.5, previousSize * 0.16) : true;
  if (!similarSize) return false;
  const prevText = String(previous.text || "").trim();
  const currText = String(current.text || "").trim();
  if (!prevText || !currText) return false;
  if (/[.!?。！？:：]$/.test(prevText)) return false;
  if (outputIndex <= 1 && previous._pageNumber === 1) return true;
  if (/^\d+\s+/.test(prevText) && !/^\d+(?:\.\d+)*\s+/.test(currText)) return true;
  if (previous.level === current.level && prevText.length < 80 && currText.length < 80 && /^[A-Z(]/.test(currText)) return true;
  return false;
}

function pdfHeadingLevel(line: PdfLine, medianSize: number, blockCount: number) {
  const text = line.text.trim();
  if (!text || text.length > 180) return 0;
  if (blockCount === 0 && line.pageNumber === 1 && line.size >= medianSize * 1.25) return 1;
  if (/^(abstract|introduction|conclusion|conclusions|references|acknowledg(e)?ments)$/i.test(text)) return 2;
  if (/^\d+\s+[A-Z][\w\s,;:'’“”()-]{2,}$/.test(text)) return 2;
  if (/^\d+(?:\.\d+)+\s+/.test(text)) return 3;
  if (line.size >= medianSize * 1.35 && text.length < 120) return blockCount === 0 ? 1 : 2;
  return 0;
}

function shouldBreakPdfParagraph(previous: string, current: string) {
  if (!previous) return false;
  if (/[-‐‑‒–—]$/.test(previous.trim())) return false;
  if (/[.!?。！？:：]$/.test(previous.trim()) && /^[A-Z0-9(]/.test(current.trim())) return true;
  return false;
}

function joinPdfParagraphLines(lines: readonly string[] = []) {
  let text = "";
  for (const line of lines) {
    const value = String(line || "").trim();
    if (!value) continue;
    if (!text) {
      text = value;
    } else if (/[-‐‑‒–—]$/.test(text)) {
      text = text.replace(/[-‐‑‒–—]$/, "") + value;
    } else if (/^[,.;:!?，。；：！？)]/.test(value)) {
      text += value;
    } else {
      text += " " + value;
    }
  }
  return normalizePdfText(text);
}

function normalizePdfText(text: unknown) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?，。；：！？)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .trim();
}

function isLikelyPdfNoiseLine(text: string, pageNumber: number) {
  const value = text.trim();
  if (!value) return true;
  if (value === String(pageNumber)) return true;
  if (/^arXiv:\d{4}\.\d{4,5}/i.test(value)) return true;
  return false;
}

function inferPdfTitle(blocks: readonly Block[] = []) {
  const first = blocks.find(block => block.type === "paragraph" && block.text);
  return first?.text?.slice(0, 120) || "";
}

function median(values: readonly number[] = []) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function textToModel(text: unknown, { title = "Document", type = "txt", chunkSize = 6000 } = {}): DocumentModel {
  const blocks = String(text || "")
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(text => ({ type: "paragraph", text }));
  return {
    type,
    title,
    blocks,
    sheets: [],
    chunks: buildBlockChunks(blocks, chunkSize),
    outline: buildOutline(blocks),
    warnings: [],
  };
}

function codeToModel(text: unknown, { title = "Code", language = "", chunkSize = 6000 } = {}): DocumentModel {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const maxChars = Math.max(1000, Math.min(50000, Number(chunkSize) || 6000));
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let startLine = 1;
  let current: string[] = [];
  let chars = 0;

  function flush(endLine: number) {
    if (!current.length && blocks.length) return;
    const blockText = current.join("\n");
    if (!blockText && !blocks.length && !source) return;
    blocks.push({
      type: "code",
      language,
      text: blockText,
      startLine,
      endLine,
    });
    current = [];
    chars = 0;
    startLine = endLine + 1;
  }

  lines.forEach((line, index) => {
    const lineChars = line.length + 1;
    if (current.length && chars + lineChars > maxChars) flush(index);
    current.push(line);
    chars += lineChars;
  });
  if (current.length) flush(lines.length);

  return {
    type: "code",
    title,
    blocks,
    sheets: [],
    chunks: buildBlockChunks(blocks, chunkSize),
    outline: [],
    warnings: [],
  };
}

function inferCodeLanguage(filename = "") {
  const cleanName = String(filename || "").split("?")[0].split("#")[0];
  const lowerName = cleanName.split(/[\\/]/).pop()?.toLowerCase() || "";
  const ext = cleanName.includes(".") ? cleanName.split(".").pop()?.toLowerCase() || "" : lowerName;
  if (CODE_FILENAMES.has(lowerName)) {
    if (lowerName === "dockerfile") return "dockerfile";
    if (lowerName === "makefile") return "makefile";
    if (lowerName === "cmakelists.txt") return "cmake";
    return lowerName;
  }
  const map: Readonly<Record<string, string>> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    pyw: "python",
    ipynb: "json",
    rb: "ruby",
    php: "php",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    cs: "csharp",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    go: "go",
    rs: "rust",
    swift: "swift",
    sh: "bash",
    bash: "bash",
    zsh: "zsh",
    fish: "fish",
    ps1: "powershell",
    bat: "batch",
    cmd: "batch",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    json: "json",
    jsonl: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    svg: "xml",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
    graphql: "graphql",
    gql: "graphql",
    proto: "protobuf",
    dockerfile: "dockerfile",
    makefile: "makefile",
    mk: "makefile",
    r: "r",
    lua: "lua",
    dart: "dart",
    scala: "scala",
    groovy: "groovy",
    gradle: "groovy",
    tf: "hcl",
    tfvars: "hcl",
    sol: "solidity",
  };
  return map[ext] || ext || "";
}

function inferCodeLanguageFromMime(mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("typescript")) return "typescript";
  if (mime.includes("javascript")) return "javascript";
  if (mime.includes("json")) return "json";
  if (mime.includes("xml")) return "xml";
  if (mime.includes("yaml") || mime.includes("x-yaml")) return "yaml";
  if (mime.includes("toml")) return "toml";
  if (mime.includes("graphql")) return "graphql";
  if (mime.includes("sql")) return "sql";
  if (mime.includes("python")) return "python";
  if (mime.includes("ruby")) return "ruby";
  if (mime.includes("php")) return "php";
  if (mime.includes("java-source")) return "java";
  if (mime.includes("c++")) return "cpp";
  if (mime.includes("csrc")) return "c";
  if (mime.includes("go")) return "go";
  if (mime.includes("rust")) return "rust";
  if (mime.includes("shellscript") || mime.includes("x-sh")) return "bash";
  return "";
}

function extractDocxBlocks(documentXml: string): Block[] {
  const body = documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/)?.[1] || documentXml;
  const blocks: Block[] = [];
  let index = 0;
  while (index < body.length) {
    const pIndex = body.indexOf("<w:p", index);
    const tblIndex = body.indexOf("<w:tbl", index);
    if (pIndex < 0 && tblIndex < 0) break;
    if (tblIndex >= 0 && (pIndex < 0 || tblIndex < pIndex)) {
      const end = body.indexOf("</w:tbl>", tblIndex);
      if (end < 0) break;
      const xml = body.slice(tblIndex, end + 8);
      const table = parseDocxTable(xml);
      if (table.rows.length) blocks.push({ type: "table", columns: table.columns, rows: table.rows });
      index = end + 8;
    } else {
      const end = body.indexOf("</w:p>", pIndex);
      if (end < 0) break;
      const xml = body.slice(pIndex, end + 6);
      const text = extractWordText(xml);
      if (text.trim()) {
        const style = xml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] || "";
        const level = headingLevelFromStyle(style);
        blocks.push(level ? { type: "heading", level, text } : { type: "paragraph", text });
      }
      index = end + 6;
    }
  }
  return blocks;
}

function parseDocxTable(xml: string) {
  const rawRows = [];
  const rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[0]))) {
      cells.push(extractWordText(cellMatch[0]));
    }
    if (cells.some(Boolean)) rawRows.push(cells);
  }
  const columns = uniqueColumnLabels(rawRows[0]?.map((value, index) => value || `Column ${index + 1}`) || []);
  const rows = rawRows.slice(1).map(row => normalizeRow(Object.fromEntries(columns.map((column, index) => [column, row[index] || ""])), columns));
  return { columns, rows };
}

function extractWordText(xml: string) {
  return xml
    .replace(/<w:tab\s*\/>/g, " ")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, text) => decodeXmlEntities(text))
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function headingLevelFromStyle(style: unknown) {
  const text = String(style || "");
  if (/^(Title|标题)$/i.test(text.trim())) return 1;
  const match = text.match(/(?:Heading|heading|Title|标题)\s*([1-6])|([1-6])$/);
  if (!match) return 0;
  return Math.max(1, Math.min(6, Number(match[1] || match[2]) || 0));
}

function parseWorkbookRels(xml = "") {
  const out: Record<string, string> = {};
  const re = /<Relationship\b([^>]*?)\/>/g;
  let match;
  while ((match = re.exec(xml || ""))) {
    const attrs = parseAttrs(match[1]);
    if (attrs.Id && attrs.Target) out[attrs.Id] = attrs.Target;
  }
  return out;
}

function parseSharedStrings(xml = "") {
  const strings = [];
  const siRe = /<si\b[\s\S]*?<\/si>/g;
  let match;
  while ((match = siRe.exec(xml || ""))) strings.push(extractExcelText(match[0]));
  return strings;
}

function parseWorksheetXml(xml: string, name: string, sharedStrings: readonly string[]): DocumentSheet {
  const matrix = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const row = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = parseAttrs(cellMatch[1]);
      const colIndex = columnNameToIndex(String(attrs.r || "").match(/^[A-Z]+/)?.[0] || "");
      row[colIndex >= 0 ? colIndex : row.length] = parseExcelCellValue(cellMatch[0], attrs, sharedStrings);
    }
    if (row.some(value => value != null && value !== "")) matrix.push(row.map(value => value ?? ""));
  }
  const columns = uniqueColumnLabels(matrix[0]?.map((value, index) => String(value || `Column ${index + 1}`)) || []);
  const rows = matrix.slice(1).map(row => normalizeRow(Object.fromEntries(columns.map((column, index) => [column, row[index] || ""])), columns));
  return { name, columns, rows };
}

function parseExcelCellValue(xml: string, attrs: Record<string, string>, sharedStrings: readonly string[]) {
  if (attrs.t === "s") {
    const index = Number(xml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || 0);
    return sharedStrings[index] || "";
  }
  if (attrs.t === "inlineStr") return extractExcelText(xml);
  return decodeXmlEntities(xml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || "");
}

function extractExcelText(xml: string) {
  const parts = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = re.exec(xml || ""))) parts.push(decodeXmlEntities(match[1]));
  return parts.join("");
}

export async function createDocxBytes({ title = "", blocks = [], sheets = [] }: DocumentContent = {}) {
  const normalizedBlocks = [...normalizeBlocks(blocks), ...sheetsToBlocks(normalizeSheets(sheets))];
  const body = normalizedBlocks.map((block, index) => blockToWordXml(block, index)).join("");
  const files = [
    { name: "[Content_Types].xml", data: contentTypesXml("docx") },
    { name: "_rels/.rels", data: rootRelsXml("docx") },
    { name: "docProps/core.xml", data: corePropsXml(title) },
    { name: "docProps/app.xml", data: appPropsXml() },
    { name: "word/document.xml", data: wordDocumentXml(body) },
    { name: "word/styles.xml", data: wordStylesXml() },
    { name: "word/numbering.xml", data: wordNumberingXml() },
    { name: "word/settings.xml", data: wordSettingsXml() },
    { name: "word/_rels/document.xml.rels", data: wordDocumentRelsXml() },
  ];
  return createZipBytes(files, text => encoder.encode(text));
}

async function createXlsxBytes({ title = "", sheets = [] }: DocumentContent = {}) {
  const normalizedSheets = normalizeSheets(sheets);
  const safeSheets = normalizedSheets.length ? normalizedSheets : [{ name: title || "Sheet1", columns: ["Value"], rows: [] }];
  const files = [
    { name: "[Content_Types].xml", data: contentTypesXml("xlsx", safeSheets.length) },
    { name: "_rels/.rels", data: rootRelsXml("xlsx") },
    { name: "docProps/core.xml", data: corePropsXml(title) },
    { name: "docProps/app.xml", data: appPropsXml() },
    { name: "xl/workbook.xml", data: workbookXml(safeSheets) },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelsXml(safeSheets) },
    { name: "xl/styles.xml", data: workbookStylesXml() },
  ];
  safeSheets.forEach((sheet, index) => {
    files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: worksheetXml(sheet) });
  });
  return createZipBytes(files, text => encoder.encode(text));
}

function blockToWordXml(block: Block, index = 0) {
  if (block.type === "heading") {
    const level = Math.max(1, Math.min(6, Number(block.level) || 1));
    const style = index === 0 && level === 1 ? "Title" : `Heading${level}`;
    const outlineLevel = style === "Title" ? 0 : level - 1;
    return wordParagraphXml(block.text, style, `<w:keepNext/><w:keepLines/><w:outlineLvl w:val="${outlineLevel}"/>`);
  }
  if (block.type === "table") {
    const columns = Array.isArray(block.columns) && block.columns.length ? block.columns.map(String) : inferSheetColumns(block.rows || []);
    const headerRow = Object.fromEntries(columns.map(column => [column, column]));
    const rows = [headerRow, ...(block.rows || [])];
    const widths = wordColumnWidths(columns, block.rows || []);
    return [
      "<w:tbl>",
      "<w:tblPr>",
      `<w:tblW w:w="${WORD_CONTENT_WIDTH}" w:type="dxa"/>`,
      "<w:tblLayout w:type=\"fixed\"/>",
      "<w:tblCellMar><w:top w:w=\"120\" w:type=\"dxa\"/><w:left w:w=\"140\" w:type=\"dxa\"/><w:bottom w:w=\"120\" w:type=\"dxa\"/><w:right w:w=\"140\" w:type=\"dxa\"/></w:tblCellMar>",
      "<w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"D7DEE8\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"D7DEE8\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"D7DEE8\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"D7DEE8\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"E5E7EB\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"E5E7EB\"/></w:tblBorders>",
      "<w:tblLook w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"0\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/>",
      "</w:tblPr>",
      `<w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`,
      rows.map((row, rowIndex) => wordTableRowXml(columns, row, rowIndex === 0, widths)).join(""),
      "</w:tbl>",
      wordParagraphXml("", "Normal", "<w:spacing w:before=\"80\" w:after=\"40\"/>"),
    ].join("");
  }
  if (block.type === "list") {
    return (block.items || []).map(item => wordListItemXml(item, Boolean(block.ordered), 0)).join("");
  }
  if (block.type === "link") {
    const text = `${block.text || block.url || ""}${block.url ? ` (${block.url})` : ""}`;
    return wordParagraphXml(text, "Normal");
  }
  if (block.type === "image") {
    const text = block.caption || block.alt || block.url || "[image]";
    return wordParagraphXml(text, "Caption");
  }
  if (block.type === "code") {
    return wordParagraphXml(block.text || "", "Normal");
  }
  return wordParagraphXml(block.text || "", "Normal");
}

function wordParagraphXml(text: unknown, styleId = "Normal", extraPPr = "", runProps = "") {
  const style = styleId ? `<w:pStyle w:val="${escapeAttr(styleId)}"/>` : "";
  return `<w:p><w:pPr>${style}${extraPPr}</w:pPr>${wordRuns(text, runProps)}</w:p>`;
}

function wordRuns(text: unknown, runProps = "") {
  const rPr = runProps ? `<w:rPr>${runProps}</w:rPr>` : "";
  return String(text || "").split(/\n/).map((line, index) => {
    const br = index > 0 ? "<w:br/>" : "";
    return `<w:r>${rPr}${br}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
  }).join("");
}

function wordListItemXml(item: ListItem | string, ordered = false, level = 0): string {
  const numId = ordered ? 2 : 1;
  const ilvl = Math.max(0, Math.min(5, Number(level) || 0));
  const text = typeof item === "string" ? item : item?.text;
  const children = typeof item === "object" && Array.isArray(item.children) ? item.children : [];
  return [
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${wordRuns(text || "")}</w:p>`,
    children.map(child => wordListItemXml(child, ordered, ilvl + 1)).join(""),
  ].join("");
}

function wordTableRowXml(columns: readonly string[], row: Data, isHeader = false, widths: readonly number[] = []) {
  return `<w:tr>${isHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${columns.map((column, index) => wordTableCellXml(valueToText(row?.[column]), isHeader, widths[index])).join("")}</w:tr>`;
}

function wordTableCellXml(text: string, isHeader = false, width = 1200) {
  const shade = isHeader ? "<w:shd w:fill=\"F3F6FA\" w:val=\"clear\"/>" : "";
  const runProps = isHeader ? "<w:b/><w:color w:val=\"111827\"/>" : "<w:color w:val=\"374151\"/>";
  return [
    "<w:tc>",
    `<w:tcPr><w:tcW w:w="${Math.max(480, Math.floor(width || 1200))}" w:type="dxa"/><w:vAlign w:val="center"/>${shade}</w:tcPr>`,
    "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"300\" w:lineRule=\"auto\"/></w:pPr>",
    wordRuns(text, runProps),
    "</w:p></w:tc>",
  ].join("");
}

function wordColumnWidths(columns: readonly string[] = [], rows: readonly Data[] = []) {
  if (!columns.length) return [];
  const weights = columns.map(column => {
    const samples = [column, ...rows.slice(0, 40).map(row => valueToText(row?.[column]))];
    const longest = samples.reduce((max, text) => Math.max(max, visualTextLength(text)), 0);
    return Math.max(6, Math.min(34, longest));
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0) || columns.length;
  let widths = weights.map(weight => Math.max(760, Math.floor((WORD_CONTENT_WIDTH * weight) / total)));
  let sum = widths.reduce((acc, width) => acc + width, 0);
  while (sum > WORD_CONTENT_WIDTH) {
    const index = widths.indexOf(Math.max(...widths));
    widths[index] -= 1;
    sum -= 1;
  }
  widths[widths.length - 1] += WORD_CONTENT_WIDTH - sum;
  return widths;
}

function visualTextLength(value: unknown) {
  return String(value || "").split("").reduce((total, char) => total + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
}

function blockToHtml(block: Block) {
  if (block.type === "heading") {
    const level = Math.max(1, Math.min(6, Number(block.level) || 1));
    return `<h${level}>${escapeHtml(block.text || "")}</h${level}>`;
  }
  if (block.type === "table") return tableToHtml(block.columns, block.rows);
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    return `<${tag}>${(block.items || []).map(item => listItemToHtml(item, tag)).join("")}</${tag}>`;
  }
  if (block.type === "link") {
    const url = String(block.url || "");
    const text = block.text || url;
    return `<p><a href="${escapeAttr(url)}">${escapeHtml(text)}</a></p>`;
  }
  if (block.type === "image" && block.url) {
    return `<figure><img src="${escapeAttr(block.url)}" alt="${escapeAttr(block.alt || block.caption || "")}">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
  }
  if (block.type === "code") {
    const language = block.language ? ` class="language-${escapeAttr(block.language)}"` : "";
    return `<pre><code${language}>${escapeHtml(block.text || "")}</code></pre>`;
  }
  return `<p>${escapeHtml(block.text || "")}</p>`;
}

function tableToHtml(columnsInput: readonly string[] = [], rowsInput: readonly Data[] = []) {
  const columns = Array.isArray(columnsInput) && columnsInput.length ? columnsInput.map(String) : inferSheetColumns(rowsInput);
  const rows = Array.isArray(rowsInput) ? rowsInput : [];
  return `<table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(valueToText(row?.[column]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function listItemToHtml(item: ListItem | string, parentTag: string): string {
  const text = typeof item === "string" ? item : item?.text || "";
  const children = typeof item === "object" && Array.isArray(item.children) ? item.children : [];
  const childTag = parentTag === "ol" ? "ol" : "ul";
  const childHtml = children.length ? `<${childTag}>${children.map(child => listItemToHtml(child, childTag)).join("")}</${childTag}>` : "";
  return `<li>${escapeHtml(text)}${childHtml}</li>`;
}

function worksheetXml(sheet: DocumentSheet) {
  const columns = sheet.columns || [];
  const rows = [Object.fromEntries(columns.map(column => [column, column])), ...(sheet.rows || [])];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${columns.map((column, colIndex) => inlineStringCell(colIndex, rowIndex, valueToText(row?.[column]))).join("")}</row>`).join("")}</sheetData></worksheet>`;
}

function inlineStringCell(colIndex: number, rowIndex: number, value: unknown) {
  const ref = `${indexToColumnName(colIndex)}${rowIndex + 1}`;
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function workbookXml(sheets: readonly DocumentSheet[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeAttr(sheet.name || `Sheet${index + 1}`)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
}

function workbookRelsXml(sheets: readonly DocumentSheet[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function workbookStylesXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Arial\"/></font></fonts><fills count=\"1\"><fill><patternFill patternType=\"none\"/></fill></fills><borders count=\"1\"><border/></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs></styleSheet>";
}

function wordDocumentXml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="${WORD_PAGE_WIDTH}" w:h="${WORD_PAGE_HEIGHT}"/><w:pgMar w:top="${WORD_PAGE_MARGIN}" w:right="${WORD_PAGE_MARGIN}" w:bottom="${WORD_PAGE_MARGIN}" w:left="${WORD_PAGE_MARGIN}"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;
}

function wordStylesXml() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:docDefaults><w:rPrDefault><w:rPr>",
    wordFontXml(),
    "<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/><w:color w:val=\"1F2937\"/>",
    "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"360\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>",
    "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:before=\"0\" w:after=\"140\" w:line=\"360\" w:lineRule=\"auto\"/></w:pPr><w:rPr>",
    wordFontXml(),
    "<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/><w:color w:val=\"1F2937\"/></w:rPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"10\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"0\" w:after=\"260\"/><w:outlineLvl w:val=\"0\"/></w:pPr><w:rPr>",
    wordFontXml(),
    "<w:b/><w:sz w:val=\"40\"/><w:szCs w:val=\"40\"/><w:color w:val=\"111827\"/></w:rPr></w:style>",
    [1, 2, 3, 4, 5, 6].map(wordHeadingStyleXml).join(""),
    "<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"0\" w:after=\"80\" w:line=\"340\" w:lineRule=\"auto\"/></w:pPr><w:rPr>",
    wordFontXml(),
    "<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:style>",
    "<w:style w:type=\"paragraph\" w:styleId=\"Caption\"><w:name w:val=\"Caption\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"40\" w:after=\"120\"/></w:pPr><w:rPr>",
    wordFontXml(),
    "<w:i/><w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/><w:color w:val=\"6B7280\"/></w:rPr></w:style>",
    "</w:styles>",
  ].join("");
}

function wordHeadingStyleXml(level: number) {
  const sizes: Readonly<Record<number, number>> = { 1: 34, 2: 29, 3: 25, 4: 23, 5: 22, 6: 22 };
  const before: Readonly<Record<number, number>> = { 1: 360, 2: 280, 3: 220, 4: 160, 5: 120, 6: 120 };
  const after: Readonly<Record<number, number>> = { 1: 160, 2: 130, 3: 90, 4: 70, 5: 60, 6: 60 };
  const colors: Readonly<Record<number, string>> = { 1: "111827", 2: "1F2937", 3: "374151", 4: "4B5563", 5: "4B5563", 6: "4B5563" };
  return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${level + 8}"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before[level]}" w:after="${after[level]}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr>${wordFontXml()}<w:b/><w:sz w:val="${sizes[level]}"/><w:szCs w:val="${sizes[level]}"/><w:color w:val="${colors[level]}"/></w:rPr></w:style>`;
}

function wordFontXml() {
  return `<w:rFonts w:ascii="${WORD_BODY_FONT}" w:hAnsi="${WORD_BODY_FONT}" w:eastAsia="${WORD_EAST_ASIA_FONT}" w:cs="${WORD_BODY_FONT}"/>`;
}

function wordNumberingXml() {
  const bulletLevels = Array.from({ length: 6 }, (_, level) => {
    const left = 720 + level * 360;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="300"/></w:pPr><w:rPr>${wordFontXml()}<w:sz w:val="22"/></w:rPr></w:lvl>`;
  }).join("");
  const decimalLevels = Array.from({ length: 6 }, (_, level) => {
    const left = 720 + level * 360;
    const marker = Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join(".") + ".";
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${marker}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr><w:rPr>${wordFontXml()}<w:sz w:val="22"/></w:rPr></w:lvl>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1">${bulletLevels}</w:abstractNum><w:abstractNum w:abstractNumId="2">${decimalLevels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`;
}

function wordSettingsXml() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    "<w:view w:val=\"print\"/>",
    "<w:zoom w:percent=\"100\"/>",
    "<w:defaultTabStop w:val=\"720\"/>",
    "<w:characterSpacingControl w:val=\"doNotCompress\"/>",
    "<w:compat><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat>",
    "</w:settings>",
  ].join("");
}

function wordDocumentRelsXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings\" Target=\"settings.xml\"/></Relationships>";
}

function contentTypesXml(kind: string, sheetCount = 1) {
  if (kind === "xlsx") {
    const sheets = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  }
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/><Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/></Types>";
}

function rootRelsXml(kind: string) {
  const office = kind === "xlsx" ? "xl/workbook.xml" : "word/document.xml";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${office}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function corePropsXml(title = "") {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title || "Document")}</dc:title><dc:creator>qz</dc:creator><cp:lastModifiedBy>qz</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

function appPropsXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>qz</Application></Properties>";
}

function unzip(bytes: Uint8Array, signal?: ZipSignal) {
  const zip = openZip(bytes, {
    decode: value => decoder.decode(value),
    inflate: typeof DecompressionStream === "function"
      ? value => new Blob([Uint8Array.from(value)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader() : undefined,
    signal,
  });
  const entries = new Map(zip.entries.map(entry => [entry.name, entry]));
  const cache = new Map<string, string>();
  let remainingBytes = 128 * 1024 * 1024;
  return { async text(name: string) {
    if (cache.has(name)) return cache.get(name)!;
    const entry = entries.get(name);
    if (!entry) return "";
    const data = await zip.read(entry, Math.min(64 * 1024 * 1024, remainingBytes));
    remainingBytes -= data.length;
    const value = decoder.decode(data);
    cache.set(name, value);
    return value;
  } };
}

function buildBlockChunks(blocks: readonly DocumentBlock[], chunkSize = 6000) {
  return buildDocumentContentChunks(blocks, { chunkSize }).map(chunk => ({
    chunkIndex: chunk.index,
    chars: chunk.content.length,
    preview: chunk.content.replace(/\s+/g, " ").slice(0, 200),
  }));
}

function buildOutline(blocks: readonly Block[]) {
  return blocks
    .map((block, blockIndex) => block?.type === "heading" ? { level: block.level || 1, text: String(block.text || "").slice(0, 160), blockIndex } : null)
    .filter(Boolean)
    .slice(0, 100);
}

function sheetsToBlocks(sheets: unknown = []): Block[] {
  return normalizeSheets(sheets).flatMap(sheet => [
    { type: "heading", level: 2, text: sheet.name },
    { type: "table", columns: sheet.columns, rows: sheet.rows },
  ]);
}

function tablesToSheets(blocks: unknown = []) {
  return normalizeBlocks(blocks)
    .filter(block => block.type === "table")
    .map((block, index) => ({
      name: block.name || `Table${index + 1}`,
      columns: block.columns || [],
      rows: block.rows || [],
    }));
}

function sheetsToCsv(sheets: unknown = []) {
  const sheet = normalizeSheets(sheets)[0] || { columns: [], rows: [] };
  const lines = [sheet.columns.map(csvCell).join(",")];
  for (const row of sheet.rows) lines.push(sheet.columns.map(column => csvCell(valueToText(row[column]))).join(","));
  return `\uFEFF${lines.join("\r\n")}`;
}

function parseCsvRows(text: string) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === "\"" && next === "\"") {
        cell += "\"";
        i++;
      } else if (ch === "\"") quoted = false;
      else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  row.push(cell);
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function blocksToPlainText(blocks: unknown = [], sheets: unknown = []) {
  const parts = normalizeBlocks(blocks).map(blockPlainText);
  for (const sheet of normalizeSheets(sheets)) {
    parts.push(`## ${sheet.name}`);
    parts.push([sheet.columns.join("\t"), ...sheet.rows.map(row => sheet.columns.map(column => valueToText(row[column])).join("\t"))].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

function blockPlainText(block: Block) {
  if (!block) return "";
  if (block.type === "heading") return `${"#".repeat(Math.max(1, Number(block.level) || 1))} ${block.text || ""}`;
  if (block.type === "table") {
    const columns = Array.isArray(block.columns) && block.columns.length ? block.columns : inferSheetColumns(block.rows || []);
    return [columns.join("\t"), ...(block.rows || []).map(row => columns.map(column => valueToText(row?.[column])).join("\t"))].join("\n");
  }
  if (block.type === "list") return (block.items || []).map((item, index) => listItemPlainText(item, Boolean(block.ordered), 0, index)).join("\n");
  if (block.type === "link") return `${block.text || block.url || ""} ${block.url || ""}`.trim();
  if (block.type === "image") return block.caption || block.alt || block.url || "";
  if (block.type === "code") return String(block.text || "");
  return String(block.text || "");
}

function normalizeBlock(input: unknown): Block {
  const block = record(input);
  if (block.type === "heading") return { type: "heading", level: Math.max(1, Math.min(6, Number(block.level) || 1)), text: String(block.text || "") };
  if (block.type === "table") return normalizeTableBlock(block);
  if (block.type === "list") return normalizeListBlock(block);
  if (block.type === "link") return { type: "link", text: String(block.text || ""), url: String(block.url || "") };
  if (block.type === "image") return { type: "image", url: String(block.url || ""), alt: String(block.alt || ""), caption: String(block.caption || "") };
  if (block.type === "code") {
    return {
      type: "code",
      language: String(block.language || ""),
      text: String(block.text ?? block.content ?? ""),
      startLine: Number(block.startLine) || undefined,
      endLine: Number(block.endLine) || undefined,
    };
  }
  return { type: "paragraph", text: String(block.text ?? block.content ?? "") };
}

function normalizeTableBlock(block: Data = {}) {
  const inputRows = Array.isArray(block?.rows) ? block.rows : [];
  const hasArrayRows = inputRows.some(Array.isArray);
  let columns = normalizeColumnDescriptors(block?.columns);
  let dataRows = inputRows;

  if (hasArrayRows) {
    const maxWidth = inputRows.reduce((max, row) => Array.isArray(row) ? Math.max(max, row.length) : max, columns.length);
    if (!columns.length && inputRows.length && Array.isArray(inputRows[0]) && block.header !== false) {
      columns = uniqueColumnLabels(inputRows[0].map((cell, index) => labelFromValue(cell) || `Column ${index + 1}`));
      dataRows = inputRows.slice(1);
    } else {
      if (columns.length < maxWidth) {
        const missing = Array.from({ length: maxWidth - columns.length }, (_, index) => `Column ${columns.length + index + 1}`);
        columns = uniqueColumnLabels([...columns, ...missing]);
      }
      if (block.header === true && rowLooksLikeHeader(inputRows[0], columns)) dataRows = inputRows.slice(1);
    }
  } else if (!columns.length) {
    columns = inferSheetColumns(inputRows);
  }

  return {
    type: "table",
    name: String(block?.name || ""),
    header: block?.header !== false,
    columns,
    rows: dataRows.map(row => normalizeRow(row, columns)),
  };
}

function normalizeListBlock(block: Data = {}) {
  const items = Array.isArray(block.items) ? block.items.map(normalizeListItem).filter(item => item.text || item.children.length) : [];
  const ordered = block.ordered === true || block.style === "ordered" || block.kind === "ordered";
  return { type: "list", ordered, items };
}

function normalizeListItem(input: unknown): ListItem {
  if (typeof input === "string") return { text: input, children: [] };
  const item = record(input);
  return {
    text: String(item.text ?? item.title ?? item.content ?? ""),
    children: Array.isArray(item.children) ? item.children.map(normalizeListItem).filter(child => child.text || child.children.length) : [],
  };
}

function normalizeColumnDescriptors(columns: unknown = []) {
  if (!Array.isArray(columns)) return [];
  return uniqueColumnLabels(columns.map((column, index) => labelFromValue(column) || `Column ${index + 1}`));
}

function labelFromValue(value: unknown) {
  const descriptor = maybeParseColumnDescriptor(value);
  if (descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)) {
    const value = record(descriptor);
    const label = value.label ?? value.name ?? value.key ?? value.title ?? value.id ?? value.field;
    if (label != null && String(label).trim()) return String(label).trim();
    return "";
  }
  if (descriptor == null) return "";
  return String(descriptor).trim();
}

function maybeParseColumnDescriptor(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function uniqueColumnLabels(labels: readonly unknown[] = []) {
  const used = new Set();
  const out = [];
  for (let index = 0; index < labels.length; index++) {
    const base = String(labels[index] || `Column ${index + 1}`).trim() || `Column ${index + 1}`;
    let label = base;
    let suffix = 2;
    while (used.has(label)) label = `${base} ${suffix++}`;
    used.add(label);
    out.push(label);
  }
  return out;
}

function rowLooksLikeHeader(row: unknown, columns: readonly string[] = []) {
  if (!Array.isArray(row) || !columns.length) return false;
  const cells = row.map(cell => labelFromValue(cell));
  const width = Math.min(cells.length, columns.length);
  if (!width) return false;
  let matches = 0;
  for (let index = 0; index < width; index++) {
    if (cells[index] && cells[index] === columns[index]) matches++;
  }
  return matches === width;
}

function listItemPlainText(item: ListItem | string, ordered: boolean, level: number, index: number): string {
  const text = typeof item === "string" ? item : item?.text || "";
  const children = typeof item === "object" && Array.isArray(item.children) ? item.children : [];
  const marker = ordered ? `${index + 1}.` : "-";
  const lines = [`${"  ".repeat(level)}${marker} ${text}`];
  children.forEach((child, childIndex) => lines.push(listItemPlainText(child, ordered, level + 1, childIndex)));
  return lines.join("\n");
}

function normalizeRow(row: unknown, columns: readonly string[]): Data {
  if (Array.isArray(row)) return Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]));
  if (row && typeof row === "object") return Object.fromEntries(columns.map(column => [column, record(row)[column] ?? ""]));
  return Object.fromEntries(columns.map(column => [column, ""]));
}

function inferSheetColumns(rows: readonly unknown[] = []) {
  const keys = new Set<string>();
  for (const row of rows) {
    if (Array.isArray(row)) row.forEach((_, index) => keys.add(`Column ${index + 1}`));
    else if (row && typeof row === "object") Object.keys(row).forEach(key => keys.add(key));
  }
  return [...keys];
}

function firstHeading(blocks: readonly DocumentBlock[]) {
  return String(blocks.find(block => block.type === "heading" && block.text)?.text || "");
}

function firstText(blocks: readonly DocumentBlock[]) {
  return String(blocks.find(block => block.text)?.text || "");
}

function valueToText(value: unknown) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseAttrs(text = "") {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(text))) attrs[match[1]] = decodeXmlEntities(match[2]);
  return attrs;
}

function columnNameToIndex(name: string) {
  if (!name) return -1;
  let index = 0;
  for (const ch of name) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function indexToColumnName(index: number) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function stripExtension(filename = "") {
  return (String(filename || "").split("/").pop() || "").replace(/\.[^.]+$/, "");
}

function latin1Decode(bytes: Uint8Array) {
  let out = "";
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const chunkSize = 0x8000;
  for (let i = 0; i < input.length; i += chunkSize) {
    out += String.fromCharCode(...input.subarray(i, i + chunkSize));
  }
  return out;
}

function decodePdfLiteral(text: unknown) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1");
}

function escapeXml(value: unknown) {
  return sanitizeXmlText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeXmlText(value: unknown) {
  return Array.from(String(value ?? "")).filter(char => {
    const code = char.codePointAt(0)!;
    return code === 0x09 || code === 0x0A || code === 0x0D || (code >= 0x20 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF);
  }).join("");
}

function escapeAttr(value: unknown) {
  return escapeXml(value).replace(/"/g, "&quot;");
}

function escapeHtml(value: unknown) {
  return escapeAttr(value);
}

function decodeXmlEntities(value: unknown) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
