import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ensureTestExtension } from '../support/extension-build.mjs';
import { acceptDataDisclosure } from '../support/data-consent.mjs';
const extension = await ensureTestExtension();
const profile = await mkdtemp(join(tmpdir(), 'qz-image-conversion-'));
const context = await chromium.launchPersistentContext(profile, {
  locale: 'zh-CN',
  headless: true, executablePath: chromium.executablePath(),
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--lang=zh-CN', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(new URL("/sidepanel/sidepanel.html", worker.url()).href);
  await acceptDataDisclosure(page);
  const results = await page.evaluate(async () => {
    const { resolveToolDefinition } = await import('../background/tools/runtime.js');
    const read = (url, options = {}) => resolveToolDefinition('read_image').execute({ url, ...options }, undefined, {});
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18"><rect width="12" height="18" fill="red"/></svg>');
    const outputs = await Promise.all([read(svg), read(svg)]);
    const image = outputs[0];
    const bitmap = await createImageBitmap(await (await fetch(image._image)).blob());
    const canvas = new OffscreenCanvas(24, 18);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = [Array.from(ctx.getImageData(1, 1, 1, 1).data), Array.from(ctx.getImageData(20, 1, 1, 1).data)];
    const invalid = [];
    for (const url of ['data:image/png;base64,YmFk', 'data:image/svg+xml;base64,YmFk', 'data:image/heic;base64,YmFk']) {
      try { await read(url); invalid.push('accepted'); }
      catch (error) { invalid.push(error.code); }
    }
    const bmp = await read('data:image/bmp;base64,Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAADEDgAAxA4AAAAAAAAAAAAAAAD/AAD/AAAAAP8AAP8AAA==');
    if (bmp.mimeType !== 'image/png') throw new Error('BMP did not convert');
    const gifUrl = 'data:image/gif;base64,R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7';
    if ((await read(gifUrl))._image !== gifUrl) throw new Error('GIF animation changed');
    const png = await read(image._image);
    const summarize = async result => {
      const decoded = await createImageBitmap(await (await fetch(result._image)).blob());
      const dimensions = [decoded.width, decoded.height]; decoded.close();
      return { dimensions, reported: [result.width, result.height], natural: [result.naturalWidth, result.naturalHeight],
        resized: result.resized === true, mime: result.mimeType, bytes: result.bytes,
        canonical: result._image.startsWith(`data:${result.mimeType};base64,`) };
    };
    const largeSvg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2000"><rect width="4000" height="2000" fill="red"/></svg>');
    const large = await summarize(await read(largeSvg));
    const smaller = await summarize(await read(largeSvg, { maxWidth: 960, maxHeight: 480, format: 'webp', quality: 0.6 }));
    const parameterizedPng = image._image.replace(';base64,', ';charset=utf-8;base64,');
    const parameterized = await read(parameterizedPng).then(summarize, error => ({ error: error.code }));
    return { mime: image.mimeType, dimensions: [image.width, image.height], pixels, invalid, preserved: png._image === image._image,
      concurrent: outputs.every(x => x.mimeType === 'image/png'), large, smaller, parameterized };
  });
  assert.equal(results.mime, 'image/png');
  assert.deepEqual(results.dimensions, [24, 18]);
  assert.deepEqual(results.pixels, [[255, 0, 0, 255], [0, 0, 0, 0]]);
  assert.deepEqual(results.invalid, Array(3).fill('IMAGE_DECODE_FAILED'));
  assert.equal(results.preserved, true);
  assert.equal(results.concurrent, true);
  for (const [result, dimensions, mime] of [[results.large, [2048, 1024], 'image/png'], [results.smaller, [960, 480], 'image/webp']]) {
    assert.deepEqual(result.natural, [4000, 2000], 'offscreen conversion must retain original SVG dimensions');
    assert.deepEqual(result.dimensions, dimensions);
    assert.deepEqual(result.reported, dimensions);
    assert.equal(result.resized, true);
    assert.equal(result.mime, mime);
    assert.ok(result.bytes > 0 && result.bytes <= 2 * 1024 * 1024);
  }
  assert.deepEqual(results.parameterized.dimensions, [24, 18], 'MIME parameters must not invalidate a readable PNG');
  assert.equal(results.parameterized.canonical, true);
  console.log('image conversion E2E passed: SVG pixels/transparency/source dimensions, bounded caller format/size, parameterized Data URLs, concurrent offscreen startup, PNG/GIF preservation, invalid input rejection');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
