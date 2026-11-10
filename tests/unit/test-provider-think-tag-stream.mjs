import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

const TABLE = `| PROPERTY | TEST METHOD | TYPICAL VALUE* | SPECIFICATION** |
| :--- | :--- | :--- | :--- |
| **PHYSICAL** | | | |
| Color | Visual | **White, Gray, Black** | --- |
| Thickness, mm (inches) | Internal | **1.59 - 25.40**<br>**(0.063 - 1.000)** | --- |
| Density, kg/m³ (lb/ft³) | Internal | 192<br>(12) | **156 - 316**<br>**(9.8 - 19.7)** |
| Compression Force Deflection, kPa (psi) | ASTM D1056 | 16.5<br>(2.4) | **7 - 35**<br>**(1 - 5)** |
| Compression Set, % | ASTM D1056<br>100°C (212°F) / 22 hrs / 50% | 1.7 | < 5 |
| Tensile Strength, kPa (psi) | ASTM D412 | 262<br>(38) | **> 138**<br>**(> 20)** |
| Elongation, % | ASTM D412 | 86 | **> 60** |
| Water Absorption, % | Internal<br>2" below water surface / 24 hrs /<br>change in weight | 1.4 | < 10 |
| **FLAMMABILITY** | | | |
| Flame Resistance | UL 94 (File E83967) | Meets | V-0; HF-1 |
| Flame Spread Index (Is) | ASTM E162 | Meets | Flaming Mode < 35 |
| Smoke Density (Ds) | ASTM E662 | Meets | 1.5 min, Flaming Mode < 100<br>4.0 min, Flaming Mode < 200 |
| Burn Length | FMVSS 302 | Meets | < 100 mm/min |
| **THERMAL** | | | |
| Temperature Range, °C (°F) | Internal | -55 to +200<br>(-67 to +392) | --- |
| Thermal Conductivity, W/m °K | ASTM C518 | 0.048 | --- |
| Low Temperature Flex | ASTM D1056<br>-55°C (-67°F) / 5 hrs | Pass | --- |
| Low Temperature Brittleness | ASTM D746<br>-55°C (-67°F) / 3 min | Pass | --- |

*Specification values in bold are tested on a batch basis.*
`;
const THINKING = "先核对表格，再原样输出。";
const SOURCE = `<think>${THINKING}</think>${TABLE}`;
const STREAM_DEADLINE_MS = 10_000;

function cycleChunks(text, sizes) {
  const points = Array.from(text);
  const chunks = [];
  for (let index = 0, step = 0; index < points.length; step += 1) {
    const size = sizes[step % sizes.length];
    chunks.push(points.slice(index, index + size).join(""));
    index += size;
  }
  return chunks;
}

// Provider chunk boundaries are arbitrary; these put a '<', '**' or '|' at the start of a delta.
const chunkings = {
  "1-character deltas": cycleChunks(SOURCE, [1]),
  "2-character deltas": cycleChunks(SOURCE, [2]),
  "3-character deltas": cycleChunks(SOURCE, [3]),
  "1-2-3 character deltas": cycleChunks(SOURCE, [1, 2, 3]),
  "deltas split before markup": SOURCE.split(/(?=<|\*\*|\|)/),
};

function streamInWorker(provider, deltas) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../support/openai-stream-worker.mjs", import.meta.url), { workerData: { provider, deltas } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`stream did not finish within ${STREAM_DEADLINE_MS}ms`));
    }, STREAM_DEADLINE_MS);
    worker.once("message", result => { clearTimeout(timer); void worker.terminate(); resolve(result); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

for (const [name, deltas] of Object.entries(chunkings)) {
  test(`OpenCode think-tag stream completes a table with ${name}`, async () => {
    assert.equal(deltas.join(""), SOURCE);
    const result = await streamInWorker("opencodego", deltas);
    assert.equal(result.text, TABLE);
    assert.equal(result.content, TABLE);
    assert.equal(result.thinking, THINKING);
    assert.equal(result.messageThinking, THINKING);
  });
}
