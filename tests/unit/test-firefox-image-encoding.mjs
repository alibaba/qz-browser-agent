import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64 } from "../../src/background/firefox/pdf-raster.js";
import { cropDataUrl } from "../../src/background/firefox/screenshot-image.js";

test("Firefox base64 stays byte-identical across padding/chunk boundaries and multi-MiB captures", () => {
  for (const size of [0, 1, 2, 3, 32767, 32768, 32769, 2 * 1024 * 1024 + 1]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  }
});

test("cropped Firefox screenshots encode the canvas Blob without changing capture bytes", async t => {
  const bytes = Uint8Array.from({ length: 65537 }, (_, index) => index % 251);
  const previousBitmap = globalThis.createImageBitmap, previousCanvas = globalThis.OffscreenCanvas;
  t.after(() => { globalThis.createImageBitmap = previousBitmap; globalThis.OffscreenCanvas = previousCanvas; });
  let closed = 0, drawn = 0;
  globalThis.createImageBitmap = async () => ({ width: 640, height: 480, close() { closed++; } });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { assert.equal(width, 320); assert.equal(height, 240); }
    getContext() { return { drawImage() { drawn++; } }; }
    async convertToBlob(options) { assert.equal(options.type, "image/png"); return new Blob([bytes]); }
  };
  const actual = await cropDataUrl("data:image/png;base64,AAAA", { x: 0, y: 0, width: 320, height: 240, scale: 1 }, 640, 480, "png");
  assert.equal(actual, Buffer.from(bytes).toString("base64"));
  assert.equal(closed, 1);
  assert.equal(drawn, 1);
});
