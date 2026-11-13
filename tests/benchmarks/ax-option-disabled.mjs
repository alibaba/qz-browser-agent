// Exact production correction function over real CDP, not overview/selector-binding or simulated IPC.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadOptionCorrection } from '../support/ax-option-correction.mjs';
const output = process.env.QZ_OPTION_OUTPUT;
if (!output) throw new Error('Set QZ_OPTION_OUTPUT to a new evidence directory');
const baseline = process.env.QZ_OPTION_BASELINE || 'd9db57cbf4e7d604755bf328023e459e4b62fa07';
const afterOnly = process.env.QZ_OPTION_AFTER_ONLY === '1';
const before = afterOnly ? null : await loadOptionCorrection(baseline), after = await loadOptionCorrection();
const browser = await chromium.launch({ headless: true });
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
await mkdir(output, { recursive: true });
console.log(JSON.stringify({ node: process.version, browser: browser.version(), baseline, afterOnly, timing: 'correction function only; real CDP; no artificial delay',
  repeats: 'before 500/1000: warmup + 3; before 5000: 1 without warmup; after: warmup + 5 each' }));
try {
  for (const size of [500, 1000, 5000]) {
    const page = await browser.newPage();
    await page.setContent('<select size="20">' + Array.from({ length: size }, (_, i) => `<option ${i % 2 ? 'disabled' : ''}>Item ${i}</option>`).join('') + '</select>');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Runtime.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const candidates = nodes.filter(n => ['option', 'optgroup'].includes(n.role?.value));
    assert.equal(candidates.length, size);
    // Deterministic stale AX input; the actual DOM and backend IDs are unchanged.
    for (const node of candidates) node.properties = [...(node.properties || []).filter(p => p.name !== 'disabled'), { name: 'disabled', value: { value: true } }];
    let expectedDigest;
    const phases = [...(afterOnly ? [] : [['before', before, size === 5000 ? 1 : 3, size !== 5000]]), ['after', after, 5, true]];
    for (const [phase, correct, repeats, warmup] of phases) {
      const samples = [];
      for (let trial = warmup ? -1 : 0; trial < repeats; trial++) {
        const input = structuredClone(nodes), counts = {};
        const send = async (method, params) => { counts[method] = (counts[method] || 0) + 1; return cdp.send(method, params); };
        const start = performance.now(); await correct(send, input); const elapsed = performance.now() - start;
        for (const node of input.filter(n => n.role?.value === 'option')) {
          const index = Number(node.name.value.match(/^Item (\d+)$/)[1]);
          assert.equal(node.properties.some(p => p.name === 'disabled'), index % 2 === 1, node.name.value);
        }
        const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        expectedDigest ||= digest; assert.equal(digest, expectedDigest, 'all fields, flags, identities and order match the baseline');
        if (trial >= 0) samples.push({ elapsedMs: elapsed, counts, digest });
      }
      const result = { phase, size, repeats, warmup: Number(warmup), medianMs: median(samples.map(s => s.elapsedMs)), samples };
      results.push(result); console.log(JSON.stringify(result));
      await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
    }
    await page.close();
  }
} finally { await browser.close(); }
