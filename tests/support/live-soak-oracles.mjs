import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

/** Verify browser-created artifacts on disk; neither helper seeds or changes source data. */
export async function verifyTable({ environment, mcp, cli, table, minRows = 1, downloadDirectory, artifactDirectory }) {
  const listed = await cli(["data", "list"]);
  const found = listed.tables.find(item => item.name === table);
  assert.ok(found, `Expected exact table ${table}`);
  assert.ok(found.count >= minRows, `${table} requires at least ${minRows} rows, found ${found.count}`);
  const exports = [];
  let expected;
  for (const format of ["csv", "xlsx"]) {
    const result = await cli(["data", "export", table, "--format", format]);
    assert.equal(result.rows, found.count);
    const file = await downloadFile({ environment, id: result.downloadId, filename: result.filename, downloadDirectory, artifactDirectory });
    const parsed = await environment.page.evaluate(async ({ bytes, filename }) => {
      const { parseDocumentBytes } = await import(chrome.runtime.getURL("shared/documents/document-codecs.js"));
      return parseDocumentBytes(new Uint8Array(bytes), { filename });
    }, { bytes: [...file.buffer], filename: file.filename });
    const sheet = parsed.sheets[0];
    assert.equal(sheet.rows.length, found.count, "all saved rows survive export");
    if (expected) {
      assert.deepEqual(sheet.columns, expected.columns);
      assert.deepEqual(sheet.rows.map(row => sheet.columns.map(key => String(row[key] ?? ""))),
        expected.rows.map(row => expected.columns.map(key => String(row[key] ?? ""))), "CSV and XLSX contain the same values");
    } else expected = sheet;
    if (mcp) {
      const known = await mcp("qingzhou_list_downloads", { id: result.downloadId });
      assert.equal(known.downloads[0].state, "complete");
      assert.equal(known.downloads[0].filepath, file.filepath);
    }
    exports.push({ format, downloadId: result.downloadId, filename: file.filename, bytes: file.buffer.length,
      ...(file.savedPath ? { savedPath: file.savedPath } : {}) });
  }
  return { table, rows: expected.rows, columns: expected.columns, count: expected.rows.length, exports };
}

export async function verifyDownloads({ environment, mcp, since, downloadDirectory, artifactDirectory }) {
  const lowerBound = typeof since === "number" ? since : Date.parse(since);
  assert.ok(Number.isFinite(lowerBound), "download verification needs the task start time");
  const listed = await mcp("qingzhou_list_downloads", { limit: 100 });
  const downloads = [];
  for (const summary of listed.downloads) {
    if (!/\.(?:md|markdown|txt)$/i.test(summary.filename)) continue;
    const metadata = await environment.page.evaluate(async id => (await chrome.downloads.search({ id }))[0], summary.downloadId);
    if (!metadata || Date.parse(metadata.startTime) < lowerBound) continue;
    const file = await downloadFile({ environment, id: summary.downloadId, downloadDirectory, artifactDirectory });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
    assert.ok(text.trim().length > 30, "the new Markdown artifact contains substantive text");
    assert.equal(text.includes("\u0000"), false);
    downloads.push({ downloadId: summary.downloadId, filename: file.filename, filepath: file.filepath,
      bytes: file.buffer.length, text, ...(file.savedPath ? { savedPath: file.savedPath } : {}) });
  }
  assert.ok(downloads.length, "the task must create a new completed Markdown/text download");
  return { downloads };
}

async function downloadFile({ environment, id, filename: logicalFilename, downloadDirectory, artifactDirectory }) {
  assert.ok(Number.isInteger(id), "export supplies a stable download ID");
  let item;
  const deadline = Date.now() + 20_000;
  do {
    item = await environment.page.evaluate(async id => (await chrome.downloads.search({ id }))[0], id);
    if (["complete", "interrupted"].includes(item?.state)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(item?.state, "complete", `download ${id} must complete`);
  const root = realpathSync(downloadDirectory);
  const filepath = realpathSync(item.filename);
  const within = relative(root, filepath);
  assert.ok(within && !within.startsWith("..") && !isAbsolute(within), "read only downloads in the isolated test directory");
  const size = statSync(filepath).size;
  assert.ok(size > 0 && size <= 32 * 1024 * 1024, "artifact size is nonzero and within the test read budget");
  const buffer = readFileSync(filepath);
  const filename = basename(logicalFilename || filepath);
  let savedPath;
  if (artifactDirectory) {
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    savedPath = join(artifactDirectory, `${id}-${filename}`);
    copyFileSync(filepath, savedPath);
  }
  return { filename, filepath: item.filename, buffer, savedPath };
}
