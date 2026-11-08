import assert from "node:assert/strict";
import test from "node:test";
import { downloadBytes } from "../../src/background/services/file-download.js";
import { registerFilesDocumentsTools } from "../../src/capabilities/documents/tools.js";

function withoutObjectUrls(t) {
  const descriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(URL, "createObjectURL", descriptor));
}

test("service worker downloads preserve binary bytes in data URLs", async t => {
  withoutObjectUrls(t);
  const storage = new Uint8Array([9, 0, 127, 255, 8]);
  const id = await downloadBytes(storage.subarray(1, 4), "application/octet-stream", { filename: "binary.bin", saveAs: false }, {
    async download(options) {
      assert.deepEqual(options, { url: "data:application/octet-stream;base64,AH//", filename: "binary.bin", saveAs: false });
      return 4;
    },
  });
  assert.equal(id, 4);
});

test("background page URLs remain live through download acceptance and are revoked afterwards", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const revoke = t.mock.method(URL, "revokeObjectURL");
  const bytes = new Uint8Array([9, 0, 127, 255, 8]).subarray(1, 4);
  let url, accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const pending = downloadBytes(bytes, "application/octet-stream", { filename: "binary.bin", saveAs: true }, {
    async download(options) {
      url = options.url;
      assert.match(url, /^blob:/);
      return accepted;
    },
  });
  t.mock.timers.tick(120_000);
  assert.equal(revoke.mock.callCount(), 0, "a save dialog must not expire its source URL");
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), bytes);
  accept(7);
  assert.equal(await pending, 7);
  t.mock.timers.tick(59_999);
  assert.equal(revoke.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(revoke.mock.callCount(), 1);
  assert.deepEqual(revoke.mock.calls[0].arguments, [url]);
  await assert.rejects(fetch(url));
});

test("rejected downloads immediately revoke their blob URL and preserve the error", async t => {
  const revoke = t.mock.method(URL, "revokeObjectURL");
  const failure = new Error("Download cancelled");
  let url;
  await assert.rejects(downloadBytes(new Uint8Array(), "text/plain", { filename: "empty.txt" }, {
    async download(options) { url = options.url; throw failure; },
  }), error => error === failure);
  assert.deepEqual(revoke.mock.calls.map(call => call.arguments), [[url]]);
  await assert.rejects(fetch(url));
});

for (const background of ["service worker", "background page"]) {
  test(`save_file preserves Unicode in a ${background}`, async t => {
    if (background === "service worker") withoutObjectUrls(t);
    else t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = globalThis.chrome;
    t.after(() => { globalThis.chrome = original; });
    const content = "# 轻舟\n杭州 🌿";
    globalThis.chrome = { downloads: { async download(options) {
      assert.equal(options.filename, "report.md");
      assert.match(options.url, background === "service worker" ? /^data:/ : /^blob:/);
      assert.equal(await (await fetch(options.url)).text(), content);
      return 9;
    } } };
    const tools = new Map();
    registerFilesDocumentsTools({ registerTool: tool => tools.set(tool.name, tool) });
    assert.deepEqual(await tools.get("save_file").execute({ filename: "report.md", content }),
      { downloadId: 9, filename: "report.md", mimeType: "text/markdown", size: content.length });
    if (background === "background page") t.mock.timers.tick(60_000);
  });
}
