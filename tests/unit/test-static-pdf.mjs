import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { copyRuntimeAssets, createDependencyGraph } from "../../scripts/vendor/assets.mjs";
import { hardenPdfSource } from "../../scripts/vendor/pdfjs.mjs";
import { textPdf } from "../support/text-pdf.mjs";

const root = await mkdtemp(join(tmpdir(), "qz-static-pdf-"));
const previous = globalThis.pdfjsWorker;
try {
  await copyRuntimeAssets(root, createDependencyGraph());
  for (const file of ["pdf.mjs", "pdf.worker.mjs"]) {
    const text = await readFile(join(root, "vendor", file), "utf8");
    assert.doesNotMatch(text, /LT \+ SCRIPT|new Function|\beval\(|await import\(|createCDNWrapper|WebAssembly\./);
    const upstream = await readFile(new URL(`../../node_modules/pdfjs-dist/build/${file}`, import.meta.url), "utf8");
    assert.throws(() => hardenPdfSource(`${upstream}\n`, file), /input changed/);
  }
  const pdf = await import(pathToFileURL(join(root, "vendor/pdf.mjs")));
  globalThis.pdfjsWorker = await import(pathToFileURL(join(root, "vendor/pdf.worker.mjs")));
  pdf.GlobalWorkerOptions.workerSrc = "https://never-load.example/worker.mjs";
  assert.equal(pdf.FeatureTest.isEvalSupported, false);
  // Force the capability helper path used by Chrome versions predating Promise.withResolvers.
  const withResolvers = Promise.withResolvers;
  Promise.withResolvers = undefined;
  try {
    const task = pdf.getDocument({ data: new Uint8Array(textPdf(["First compressed page", "Second compressed page"])), isEvalSupported: true });
    try {
      const document = await task.promise;
      assert.equal(document.numPages, 2);
      for (const [index, text] of ["First compressed page", "Second compressed page"].entries()) {
        const page = await document.getPage(index + 1);
        assert.match((await page.getTextContent()).items.map(item => item.str).join(" "), new RegExp(text));
      }
    } finally { await task.destroy(); }
  } finally { Promise.withResolvers = withResolvers; }
  const malformed = pdf.getDocument({ data: new TextEncoder().encode("not a PDF") });
  await assert.rejects(malformed.promise, /Invalid PDF/);
  await malformed.destroy();
  const cancelled = pdf.getDocument({ data: new Uint8Array(textPdf()) });
  const settled = cancelled.promise.catch(() => undefined);
  await cancelled.destroy();
  await settled;
  const retry = pdf.getDocument({ data: new Uint8Array(textPdf()) });
  assert.equal((await retry.promise).numPages, 1);
  await retry.destroy();
} finally {
  globalThis.pdfjsWorker = previous;
  await rm(root, { recursive: true, force: true });
}
console.log("static PDF reader: compressed pages, malformed input, cancellation and recovery passed");
