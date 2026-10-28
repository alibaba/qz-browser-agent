// Node allocation proxy, not a Firefox RSS measurement. The baseline is the
// committed HEAD; run before committing the fix, or pass IMAGE_BASELINE_COMMIT.
// node --expose-gc --import tsx tests/benchmarks/image-memory.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { bytesToBase64 } from "../../src/background/firefox/pdf-raster.js";

const mode = process.argv[2];
if (!mode) {
  for (const name of ["before", "after"]) {
    process.stdout.write(execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), name], { encoding: "utf8" }));
  }
} else {
  let encode = bytesToBase64;
  if (mode === "before") {
    const revision = process.env.IMAGE_BASELINE_COMMIT || "HEAD";
    const original = execFileSync("git", ["show", `${revision}:src/background/firefox/pdf-raster.ts`], { encoding: "utf8" });
    const { code } = transformSync(original, { loader: "ts", format: "esm" });
    encode = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)).bytesToBase64;
  }
  const bytes = Buffer.alloc(2 * 1024 * 1024, 123);
  globalThis.gc();
  const startMemory = process.memoryUsage();
  const start = performance.now();
  const encoded = encode(bytes);
  const elapsedMs = performance.now() - start;
  const encodedMemory = process.memoryUsage();
  assert.equal(encoded, bytes.toString("base64"));
  console.log("FIREFOX_BASE64_PROXY", JSON.stringify({ mode, bytes: bytes.length, elapsedMs: +elapsedMs.toFixed(2),
    heapDeltaBytes: encodedMemory.heapUsed - startMemory.heapUsed,
    rssDeltaBytes: encodedMemory.rss - startMemory.rss, outputChars: encoded.length }));
}
