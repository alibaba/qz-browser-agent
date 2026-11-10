import assert from "node:assert/strict";
import test from "node:test";
import { streamInWorker } from "../support/openai-stream.mjs";

const ENVELOPE = JSON.stringify({ error: { code: "UPSTREAM_ERROR", message: "upstream request failed" } });

// Each case scans assistant content whose earliest "\n{" is at index 0.
const ordinaryContent = {
  "a delta that starts a JSON block with \\n{": ["Config:\n```json", "\n{", "\n  \"a\": 1\n", "}\n```"],
  "content that is a newline and a non-envelope object": ["\n{\"a\":1}"],
  "content with several newline-prefixed objects": ["\n{\"a\":1}\n{\"b\":2}"],
};

const trailingEnvelope = {
  "text followed by an error envelope": [`Partial answer\n${ENVELOPE}`],
  "a leading object followed by an error envelope": [`\n{"a":1}\n${ENVELOPE}`],
};

for (const provider of ["deepseek", "opencodego"]) {
  for (const [name, deltas] of Object.entries(ordinaryContent)) {
    test(`${provider} stream keeps ${name}`, async () => {
      const result = await streamInWorker(provider, deltas);
      assert.equal(result.error, null);
      assert.equal(result.text, deltas.join(""));
      assert.equal(result.content, deltas.join(""));
    });
  }

  for (const [name, deltas] of Object.entries(trailingEnvelope)) {
    test(`${provider} stream reports ${name}`, async () => {
      const result = await streamInWorker(provider, deltas);
      assert.equal(result.error?.name, "LlmProviderError");
      assert.equal(result.error?.code, "UPSTREAM_ERROR");
      assert.match(result.error?.message, /upstream request failed/);
    });
  }
}
