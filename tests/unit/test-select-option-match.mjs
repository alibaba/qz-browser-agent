import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "src/content/content-script.ts"), "utf8");
const toolMessages = readFileSync(join(root, "src/capabilities/page/tool-messages.ts"), "utf8");
const browserSpec = readFileSync(join(root, "tests/browser/select-option-match.spec.mjs"), "utf8");

test("select matches untrimmed option.value first, then trimmed option.label", () => {
  assert.match(source, /option\.value === rawWanted/);
  assert.match(source, /String\(option\.label \|\| ""\)\.trim\(\) === labelWanted/);
  assert.match(source, /OPTION_NOT_FOUND/);
  assert.match(source, /No <option> matched value or label/);
  const valueIdx = source.indexOf("option.value === rawWanted");
  const labelIdx = source.indexOf('String(option.label || "").trim() === labelWanted');
  assert.ok(valueIdx > 0 && labelIdx > valueIdx, "value match must come before label fallback");
});

test("select assigns by selectedIndex and returns selected value plus label", () => {
  assert.match(source, /el\.selectedIndex = matchIndex/);
  assert.doesNotMatch(source, /el\.value = match/);
  assert.match(source, /selectedLabel:/);
  assert.match(source, /selectedOption \? selectedOption\.value/);
});

test("tool descriptions document value-or-label select matching with value priority", () => {
  assert.match(toolMessages, /精确匹配 option\.value/);
  assert.match(toolMessages, /可见 label/);
  assert.match(toolMessages, /exact option\.value first/i);
  assert.match(toolMessages, /visible label/i);
  assert.match(toolMessages, /exact value takes priority/i);
});

test("browser select tests call actOnElement with elementAction, not action", () => {
  assert.match(browserSpec, /elementAction:\s*"select"/);
  // Ensure the happy-path helper does not pass action:"select" into the message route.
  assert.match(browserSpec, /async function callSelect/);
  assert.doesNotMatch(
    browserSpec.replace(/select with action instead of elementAction[\s\S]*$/, ""),
    /elementAction:\s*"select"[\s\S]*action:\s*"select"/,
  );
});
