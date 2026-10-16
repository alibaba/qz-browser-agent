import {
  listDataTables, queryDataRows, clearDataTable,
  type DataTable, type DataRow,
} from "../../shared/data-store.js";
import { getImageAsset } from "../../shared/asset-store.js";
import { createDocumentBytes } from "../../shared/documents/document-codecs.js";
import { createZipBytes } from "../../shared/zip-bytes.js";
import { downloadMcpFile, listMcpDownloads, safeMcpFilename } from "./file-download.js";

type Params = Record<string, unknown>;
interface ResourceDependencies {
  listTables: typeof listDataTables;
  queryRows: typeof queryDataRows;
  clearTable: typeof clearDataTable;
  getImage: typeof getImageAsset;
  encodeDocument: typeof createDocumentBytes;
  download: typeof downloadMcpFile;
  queryDownloads: typeof listMcpDownloads;
}
const PAGE_SIZE = 100_000;
const encoder = new TextEncoder();
const MIME = { csv: "text/csv;charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

/** Resource operations use the same stores and document codecs as the workspace. */
export function createMcpResourceRuntime(overrides: Partial<ResourceDependencies> = {}) {
  const deps: ResourceDependencies = {
    listTables: listDataTables, queryRows: queryDataRows, clearTable: clearDataTable,
    getImage: getImageAsset, encodeDocument: createDocumentBytes, download: downloadMcpFile, queryDownloads: listMcpDownloads,
    ...overrides,
  };

  async function requireTable(value: unknown, collection = false) {
    // Match the stored name exactly before calling the store (which normalizes/truncates names).
    if (typeof value !== "string" || !value.trim()) fail("INVALID_ARGUMENTS", `${collection ? "collection" : "table"} is required.`);
    const table = (await deps.listTables()).find(table => table.name === value);
    if (!table) fail("RESOURCE_NOT_FOUND", `No ${collection ? "image collection" : "data table"} named ${value}.`);
    if (collection && !isImageCollection(table)) fail("INVALID_RESOURCE_KIND", `${value} is a data table, not an image collection.`);
    return table;
  }

  async function allRows(table: DataTable) {
    const rows: DataRow[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    do {
      const page = await deps.queryRows({ table: table.name, limit: PAGE_SIZE, offset: rows.length });
      if (total !== undefined && total !== page.totalMatched) fail("RESOURCE_CHANGED", "The table changed during export. Retry after its task finishes.");
      total = page.totalMatched;
      for (const row of page.rows) {
        if (row.table !== table.name || seen.has(row.id)) fail("RESOURCE_CHANGED", "The table changed during export. Retry after its task finishes.");
        seen.add(row.id);
        rows.push(row);
      }
      if (!page.rows.length && rows.length < total) fail("RESOURCE_CHANGED", "The table changed during export. Retry after its task finishes.");
    } while (rows.length < total);
    return rows;
  }

  async function listTables() { return { tables: await deps.listTables() }; }
  async function listImageCollections() { return { collections: (await deps.listTables()).filter(isImageCollection) }; }

  async function deleteTable(params: Params = {}) {
    const table = await requireTable(params.table);
    return deps.clearTable(table.name);
  }

  async function deleteImageCollection(params: Params = {}) {
    const table = await requireTable(params.collection, true);
    const result = await deps.clearTable(table.name);
    // Asset blobs can be referenced by other tables and Session transcripts. The owning asset
    // store retains them, matching workspace whole-collection deletion; this is not a GC entry.
    return { collection: table.name, ...result, retainedAssets: true };
  }

  async function exportTable(params: Params = {}) {
    const format = params.format ?? "xlsx";
    if (format !== "csv" && format !== "xlsx") fail("INVALID_ARGUMENTS", "format must be csv or xlsx.");
    const table = await requireTable(params.table);
    const rows = await allRows(table);
    const columns = exportColumns(table, rows);
    const bytes = await spreadsheet(format, table.name, columns, rows.map(row => row.data));
    const download = await deps.download({ bytes, filename: exportFilename(params.filename, table.name, format), mimeType: MIME[format] });
    return { table: table.name, format, rows: rows.length, columns, ...download };
  }

  async function exportImageCollection(params: Params = {}) {
    const table = await requireTable(params.collection, true);
    const rows = await allRows(table);
    const columns = exportColumns(table, rows);
    const files: { name: string; data: string | Uint8Array }[] = [];
    const metadata: Record<string, unknown>[] = [];
    const names = new Set<string>();
    let missingImages = 0;
    for (const [index, row] of rows.entries()) {
      const assetId = typeof row.data.assetId === "string" ? row.data.assetId.trim() : "";
      const asset = assetId && assetId.length <= 180 ? await deps.getImage(assetId, { touch: false }) : null;
      let imageFile = "";
      if (asset?.blob) {
        const extension = imageExtension(asset.mimeType || asset.blob.type);
        const suggested = String(row.data.title || row.data.alt || assetId || `image-${index + 1}`);
        const stem = safeMcpFilename(suggested).replace(/\.[a-z\d]{2,8}$/i, "");
        let name = `${stem}.${extension}`;
        for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${stem}-${suffix}.${extension}`;
        names.add(name.toLowerCase());
        imageFile = `images/${name}`;
        files.push({ name: imageFile, data: new Uint8Array(await asset.blob.arrayBuffer()) });
      } else {
        missingImages++;
      }
      // Archive path is authoritative and cannot be replaced by an imported metadata field.
      metadata.push({ ...row.data, imageFile });
    }
    const metadataColumns = ["imageFile", ...columns.filter(column => column !== "imageFile")];
    files.unshift({ name: "metadata.xlsx", data: await spreadsheet("xlsx", table.name, metadataColumns, metadata) });
    files.unshift({ name: "manifest.json", data: JSON.stringify({
      collection: table.name, kind: "image_collection", exportedAt: new Date().toISOString(),
      rows: rows.length, images: rows.length - missingImages, missingImages,
    }, null, 2) });
    const bytes = createZipBytes(files, text => encoder.encode(text), new Date());
    const download = await deps.download({ bytes, filename: exportFilename(params.filename, table.name, "zip"), mimeType: "application/zip" });
    return { collection: table.name, format: "zip", rows: rows.length, images: rows.length - missingImages, missingImages, ...download };
  }

  function spreadsheet(format: "csv" | "xlsx", name: string, columns: string[], rows: Record<string, unknown>[]) {
    return deps.encodeDocument({ format, title: name, sheets: [{
      name: safeSheetName(name), columns,
      rows: rows.map(row => Object.fromEntries(columns.map(column => [column, cellValue(row[column])]))),
    }] });
  }

  return { listDataTables: listTables, deleteDataTable: deleteTable, exportDataTable: exportTable,
    listImageCollections, deleteImageCollection, exportImageCollection,
    listDownloads: (params: Params = {}) => deps.queryDownloads(params) };
}

function isImageCollection(table: DataTable) { return table.kind === "image_collection" || table.assetKind === "image"; }
function exportColumns(table: DataTable, rows: DataRow[]) {
  const columns = new Set((table.columns || []).filter(column => typeof column === "string"));
  for (const row of rows) for (const key of Object.keys(row.data)) columns.add(key);
  return [...columns];
}
function cellValue(value: unknown) { return value != null && typeof value === "object" ? JSON.stringify(value) : value ?? ""; }
function safeSheetName(name: string) { return name.replace(/[:\\/?*[\]]/g, " ").replace(/^'+|'+$/g, "").slice(0, 31) || "Data"; }
function exportFilename(value: unknown, fallback: string, extension: string) {
  if (value != null && typeof value !== "string") fail("INVALID_ARGUMENTS", "filename must be a string.");
  const stem = safeMcpFilename(String(value || fallback)).replace(/\.(csv|xlsx|zip)$/i, "");
  return `${stem.slice(0, 170)}.${extension}`;
}
function imageExtension(mimeType: string) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff" } as Record<string, string>)[mimeType] || "bin";
}
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
