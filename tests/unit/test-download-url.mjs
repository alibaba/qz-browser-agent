import assert from "node:assert/strict";
import { createDownloadUrl } from "../../src/shared/download-url.ts";

// Chrome's Service Worker has no URL.createObjectURL: data: URL, as before.
assert.equal(createDownloadUrl("text/markdown", { text: "# é" }, {}).url, "data:text/markdown;base64,IyDDqQ==");
assert.equal(createDownloadUrl("text/csv", { base64: "AQI=" }, {}).url, "data:text/csv;base64,AQI=");

// Firefox rejects data: URLs in downloads.download, so it gets a blob: URL with the same bytes.
const blobs = [];
const urlApi = { createObjectURL: blob => { blobs.push(blob); return `blob:test/${blobs.length}`; }, revokeObjectURL() {} };
assert.equal(createDownloadUrl("text/markdown", { text: "# é" }, urlApi).url, "blob:test/1");
assert.equal(await blobs[0].text(), "# é");
assert.equal(blobs[0].type, "text/markdown");
createDownloadUrl("text/csv", { base64: "AQI=" }, urlApi);
assert.deepEqual([...new Uint8Array(await blobs[1].arrayBuffer())], [1, 2]);
console.log("download url tests passed");
