import assert from "node:assert/strict";
import test from "node:test";
import { createMcpResourceRuntime } from "../../src/background/mcp/resource-runtime.js";
import { downloadMcpFile, listMcpDownloads, safeMcpFilename } from "../../src/background/mcp/file-download.js";
import { parseDocumentBytes } from "../../src/shared/documents/document-codecs.js";
import { openZip } from "../../src/shared/zip-bytes.js";

const table = (name, columns = [], extra = {}) => ({ name, columns, count: 0, createdAt: "", updatedAt: "", ...extra });
const row = (table, id, data) => ({ id: String(id), table, data, createdAt: "", updatedAt: "" });
function harness(tables, rows = [], options = {}) {
  const downloads = [];
  const cleared = [];
  const offsets = [];
  const runtime = createMcpResourceRuntime({
    listTables: async () => tables,
    queryRows: async ({ table, offset = 0, limit }) => {
      offsets.push(offset);
      const selected = rows.filter(row => row.table === table);
      return { rows: selected.slice(offset, offset + Math.min(limit, options.pageSize || limit)), totalMatched: selected.length, offset, limit };
    },
    clearTable: async name => { cleared.push(name); return { table: name, deleted: rows.filter(row => row.table === name).length }; },
    getImage: async id => options.assets?.get(id) || null,
    download: async input => {
      downloads.push(input);
      return { downloadId: downloads.length, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes.byteLength, state: "in_progress" };
    },
    ...options.deps,
  });
  return { runtime, downloads, cleared, offsets };
}

test("resource lists retain table metadata and identify both gallery metadata forms", async () => {
  const tables = [table("data"), table("photos", [], { kind: "image_collection" }), table("legacy", [], { assetKind: "image" })];
  const { runtime } = harness(tables);
  assert.deepEqual((await runtime.listDataTables()).tables, tables);
  assert.deepEqual((await runtime.listImageCollections()).collections.map(item => item.name), ["photos", "legacy"]);
});

test("deletion resolves an exact existing name and never clears unrelated tables or assets", async () => {
  const { runtime, cleared } = harness([table("data"), table("gallery", [], { kind: "image_collection" })]);
  for (const value of [undefined, "", " ", "data ", "data".repeat(40), "*"]) {
    await assert.rejects(runtime.deleteDataTable({ table: value }), error => ["INVALID_ARGUMENTS", "RESOURCE_NOT_FOUND"].includes(error.code));
  }
  await assert.rejects(runtime.deleteImageCollection({ collection: "data" }), { code: "INVALID_RESOURCE_KIND" });
  assert.deepEqual(cleared, []);
  assert.deepEqual(await runtime.deleteDataTable({ table: "data" }), { table: "data", deleted: 0 });
  assert.deepEqual(await runtime.deleteImageCollection({ collection: "gallery" }), { table: "gallery", collection: "gallery", deleted: 0, retainedAssets: true });
  assert.deepEqual(cleared, ["data", "gallery"]);
});

test("CSV and XLSX export every page, explicit empty columns, nested values and column order", async () => {
  const name = "Research/杭州";
  const rows = Array.from({ length: 1105 }, (_, index) => row(name, index, { id: index, label: index === 0 ? 'quote, "line"\n杭州' : `row ${index}`, nested: { index } }));
  const { runtime, downloads, offsets } = harness([table(name, ["label", "id", "empty"])], rows, { pageSize: 250 });
  for (const format of ["csv", "xlsx"]) {
    const result = await runtime.exportDataTable({ table: name, format, filename: "../../unsafe:name" });
    assert.equal(result.rows, 1105);
    assert.deepEqual(result.columns, ["label", "id", "empty", "nested"]);
    assert.doesNotMatch(result.filename, /[\\/:]/);
    assert.equal(Object.hasOwn(result, "base64"), false);
    const model = await parseDocumentBytes(downloads.at(-1).bytes, { filename: result.filename });
    assert.deepEqual(model.sheets[0].columns, result.columns);
    assert.equal(model.sheets[0].rows.length, 1105);
    assert.equal(model.sheets[0].rows[0].label, 'quote, "line"\n杭州');
    assert.equal(model.sheets[0].rows.at(-1).id, "1104");
    assert.equal(model.sheets[0].rows.at(-1).nested, '{"index":1104}');
  }
  assert.deepEqual(offsets, [0, 250, 500, 750, 1000, 0, 250, 500, 750, 1000]);
});

test("empty tables export declared headers and no synthetic data row", async () => {
  const { runtime, downloads } = harness([table("Empty", ["title", "url"])]);
  for (const format of ["csv", "xlsx"]) {
    const result = await runtime.exportDataTable({ table: "Empty", format });
    assert.equal(result.rows, 0);
    const model = await parseDocumentBytes(downloads.at(-1).bytes, { filename: result.filename });
    assert.deepEqual(model.sheets[0].columns, ["title", "url"]);
    assert.deepEqual(model.sheets[0].rows, []);
  }
  await assert.rejects(runtime.exportDataTable({ table: "Empty", format: "html" }), { code: "INVALID_ARGUMENTS" });
});

test("a changed page fails explicitly instead of returning a truncated or duplicate export", async () => {
  const name = "changing";
  const { runtime, downloads } = harness([table(name)], [], { deps: {
    queryRows: async ({ offset }) => ({ rows: [row(name, "same", { value: 1 })], totalMatched: offset ? 3 : 2 }),
  } });
  await assert.rejects(runtime.exportDataTable({ table: name }), { code: "RESOURCE_CHANGED" });
  assert.equal(downloads.length, 0);
});

test("gallery ZIP preserves metadata for missing assets and uses unique safe image paths", async () => {
  const name = "Photo collection";
  const rows = [
    row(name, 1, { assetId: "a", title: "../image", imageFile: "../../override" }),
    row(name, 2, { assetId: "a", title: "../image" }),
    row(name, 3, { assetId: "missing", title: "Missing bytes" }),
    row(name, 4, { status: "failed", title: "Capture failed" }),
  ];
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const { runtime, downloads } = harness([table(name, ["title", "assetId"], { kind: "image_collection" })], rows, { assets: new Map([["a", { blob, mimeType: "image/png" }]]) });
  const result = await runtime.exportImageCollection({ collection: name });
  assert.equal(result.rows, 4);
  assert.equal(result.images, 2);
  assert.equal(result.missingImages, 2);
  const zip = openZip(downloads[0].bytes, { decode: bytes => new TextDecoder().decode(bytes) });
  assert.equal(zip.entries.length, 4);
  assert.deepEqual(zip.entries.map(entry => entry.name), ["manifest.json", "metadata.xlsx", "images/_image.png", "images/_image-2.png"]);
  const manifest = JSON.parse(new TextDecoder().decode(await zip.read(zip.entries[0], 10_000)));
  assert.equal(manifest.missingImages, 2);
  const metadata = await parseDocumentBytes(await zip.read(zip.entries[1], 100_000), { filename: "metadata.xlsx" });
  assert.equal(metadata.sheets[0].rows[0].imageFile, "images/_image.png");
  assert.equal(metadata.sheets[0].rows[2].imageFile, "");
  assert.equal(metadata.sheets[0].rows[3].title, "Capture failed");
  assert.deepEqual([...await zip.read(zip.entries[2], 100)], [1, 2, 3]);
});

test("download metadata returns the real local file URL without opening the file or exposing bytes", async () => {
  const requests = [];
  const result = await downloadMcpFile({ bytes: new Uint8Array([1, 2]), filename: "../bad:name.csv", mimeType: "text/csv" }, {
    download: async options => { requests.push(options); return 42; },
    search: async query => { assert.deepEqual(query, { id: 42 }); return [{ filename: "/Users/example/Downloads/中文 #.csv", state: "complete" }]; },
  });
  assert.deepEqual(requests, [{ url: "data:text/csv;base64,AQI=", filename: "_bad_name.csv", saveAs: false }]);
  assert.equal(result.state, "complete");
  assert.equal(result.fileUrl, "file:///Users/example/Downloads/%E4%B8%AD%E6%96%87%20%23.csv");
  assert.equal(result.bytes, 2);
  assert.equal(Object.hasOwn(result, "url"), false);
  assert.equal(safeMcpFilename("CON.txt"), "_CON.txt");
});

test("downloads distinguish interrupted from accepted but unfinished downloads", async () => {
  const input = { bytes: new Uint8Array(), filename: "empty.csv", mimeType: "text/csv" };
  const pending = await downloadMcpFile(input, { download: async () => 1, search: async () => [] }, { waitMs: 0 });
  assert.equal(pending.state, "in_progress");
  assert.equal(pending.fileUrl, undefined);
  assert.match(pending.hint, /chrome:\/\/downloads/);
  await assert.rejects(downloadMcpFile(input, { download: async () => 2, search: async () => [{ state: "interrupted", error: "FILE_FAILED" }] }),
    error => error.code === "DOWNLOAD_INTERRUPTED" && error.details.downloadId === 2 && error.details.reason === "FILE_FAILED");
  const windows = await downloadMcpFile(input, { download: async () => 3, search: async () => [{ state: "complete", filename: "C:\\Users\\Example\\中文.csv" }] });
  assert.equal(windows.fileUrl, "file:///C:/Users/Example/%E4%B8%AD%E6%96%87.csv");
});

test("download completion waits for the same accepted ID and never repeats export", async () => {
  let started = 0;
  let polled = 0;
  const input = { bytes: new Uint8Array([1]), filename: "report.csv", mimeType: "text/csv" };
  const ready = await downloadMcpFile(input, {
    download: async () => { started++; return 17; },
    search: async ({ id }) => {
      assert.equal(id, 17);
      polled++;
      return polled < 3 ? [{ state: "in_progress" }] : [{ state: "complete", filename: "/tmp/report.csv" }];
    },
  }, { waitMs: 500, pollMs: 1 });
  assert.equal(started, 1);
  assert.equal(polled, 3);
  assert.equal(ready.state, "complete");
  assert.equal(ready.fileUrl, "file:///tmp/report.csv");
  assert.equal(ready.hint, undefined);
});

test("download lookup uses exact IDs or a bounded recent list and keeps source bytes private", async () => {
  const queries = [];
  const api = { search: async query => {
    queries.push(query);
    return [{ id: 9, filename: "/tmp/杭州.csv", state: "complete", fileSize: 23, bytesReceived: 23, url: "data:secret" }];
  } };
  const result = await listMcpDownloads({ id: 9 }, api);
  assert.deepEqual(result.downloads, [{ downloadId: 9, filename: "杭州.csv", filepath: "/tmp/杭州.csv", fileUrl: "file:///tmp/%E6%9D%AD%E5%B7%9E.csv", state: "complete", bytes: 23 }]);
  await listMcpDownloads({}, api);
  assert.deepEqual(queries, [{ id: 9 }, { limit: 20, orderBy: ["-startTime"] }]);
  for (const params of [{ id: -1 }, { id: "9" }, { id: 1.5 }, { limit: 101 }, { limit: 0 }]) {
    await assert.rejects(listMcpDownloads(params, api), { code: "INVALID_ARGUMENTS" });
  }
  assert.equal(queries.length, 2);
  assert.deepEqual(await listMcpDownloads({ id: 99 }, { search: async () => [] }), { downloads: [] });
});
