import assert from "node:assert/strict";
import test from "node:test";
import { registerFilesDocumentsTools } from "../../src/capabilities/documents/tools.js";

test("exact download lookup provides a usable file URL without exposing paths in recent lists", async t => {
  const originalChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = originalChrome; });
  let query;
  let item = { id: 42, filename: "/Users/test/Downloads/杭州 #1? 100%.html", url: "https://example.test/report", state: "complete", exists: true, startTime: "2026-01-01T00:00:00Z" };
  globalThis.chrome = {
    downloads: { search: async value => { query = value; return [{ ...item }]; } },
    storage: { local: { get: async () => ({}) } },
  };
  const tools = new Map();
  registerFilesDocumentsTools({ registerTool: tool => tools.set(tool.name, tool) });
  const lookup = args => tools.get("list_downloads").execute(args);
  let [result] = await lookup({ id: 42 });
  assert.deepEqual(query, { id: 42 });
  assert.equal(result.fileUrl, "file:///Users/test/Downloads/%E6%9D%AD%E5%B7%9E%20%231%3F%20100%25.html");
  assert.equal(result.filename, "杭州 #1? 100%.html");

  for (const args of [{}, { query: "杭州" }, { id: null }, { id: -1 }, { id: 4.2 }]) {
    [result] = await lookup(args);
    assert.equal(Object.hasOwn(result, "fileUrl"), false);
    assert.equal(result.filename.includes("/"), false);
  }
  for (const patch of [{ state: "in_progress" }, { state: "interrupted" }, { exists: false }, { exists: undefined }, { id: 43 }]) {
    const saved = item;
    item = { ...item, ...patch };
    assert.equal(Object.hasOwn((await lookup({ id: 42 }))[0], "fileUrl"), false);
    item = saved;
  }
  for (const [filename, expected] of [
    ["C:\\Users\\test\\Downloads\\report #1%.html", "file:///C:/Users/test/Downloads/report%20%231%25.html"],
    ["\\\\server\\share\\report #1.html", "file://server/share/report%20%231.html"],
    ["/tmp/with\\backslash.html", "file:///tmp/with%5Cbackslash.html"],
    ["relative.html", undefined],
    ["/tmp/invalid\0.html", undefined],
  ]) {
    item.filename = filename;
    assert.equal((await lookup({ id: 42 }))[0].fileUrl, expected);
  }
  globalThis.chrome.downloads.search = async () => [];
  assert.deepEqual(await lookup({ id: 999 }), []);
});
