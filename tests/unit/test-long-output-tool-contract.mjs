import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const toolsSource = readFileSync(join(root, "src/background/tools/runtime.ts"), "utf8");
const filesDocumentsToolsSource = readFileSync(join(root, "src/capabilities/documents/tools.ts"), "utf8");
const toolErrorLocalizationSource = readFileSync(join(root, "src/shared/tools/tool-error-localization.ts"), "utf8");
const { createTranslator } = await import("../../src/shared/i18n/index.js");
const { default: documentMessages } = await import("../../src/capabilities/documents/messages.js");
const { QINGZHOU_DOCUMENT_TOOL_SPECS } = await import("../../src/capabilities/documents/skill-contract.js");

globalThis.chrome ||= {};
globalThis.chrome.i18n = { getUILanguage: () => "zh-CN" };
const { resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
const { SKILL_AUTHOR_TOOL_PARAMETERS } = await import("../../src/capabilities/skills/workbench.js");
const saveFile = resolveToolDefinition("save_file");
assert.deepEqual(saveFile.parameters.required, ["content"], "save_file should only require content");
assert.equal(saveFile.parameters.required.includes("filename"), false, "save_file should not fail when filename is omitted");
assert.equal(Object.hasOwn(saveFile.parameters, "anyOf"), false, "save_file should not depend on provider-sensitive anyOf");
assertPropertyOrder(saveFile.parameters, ["filename", "mimeType", "content"], "save_file should put long content after small file metadata");
assert.match(saveFile.description, /自动生成文件名/, "save_file should document automatic filename fallback");
assert.match(filesDocumentsToolsSource, /function resolveSaveFileFilename\(/, "save_file should have an execution-time filename fallback");

const downloadUrl = toolBlock("download_url");
assert.match(downloadUrl, /artifactRecorded:\s*Boolean\(context\.sessionId\)/, "download_url should expose whether the task artifact path is active");
const listDownloads = resolveToolDefinition("list_downloads");
assert.equal(listDownloads.parameters.properties.id.type, "number", "list_downloads should accept the stable id returned by download_url");
for (const key of ["downloadRegisteredAsAFileArtifactForThisTask", "downloadStartedUseListDownloadsIdToCheckIts"]) {
  assert.ok(downloadUrl.includes(key), "download_url must use the exact-download recovery message");
  assert.match(createTranslator(documentMessages)(key, { id: "42" }), /list_downloads\(\{id:42\}\)/, "download_url should tell the model how to verify the exact download");
}

const runScript = resolveToolDefinition("run_script");
assert.deepEqual(runScript.parameters.required, ["code"], "outer scripts should use the default timeout when omitted");
assertPropertyOrder(runScript.parameters, ["timeout", "args", "code"], "outer scripts should keep long code last and page selection on nested calls");
assert.equal(runScript.page, false, "outer scripts must not require or implicitly select a page");
assert.match(runScript.parameters.properties.code.description, /顶层 await 和 return/, "outer scripts should explain their asynchronous return surface");
assert.doesNotThrow(() => runScript.validateArgs({ code: "return 1" }), "an omitted timeout must remain executable");
const evaluate = resolveToolDefinition("evaluate");
assert.deepEqual(evaluate.parameters.required, ["tabRef", "code"], "page evaluation should require its explicit page and callable code");
assert.equal(evaluate.page, "owned");

const readArticle = resolveToolDefinition("read_article");
assert.deepEqual(readArticle.parameters.required, ["limit", "tabRef"], "read_article should require an explicit context budget limit");
assertPropertyOrder(readArticle.parameters, ["tabRef", "source", "target", "offset", "limit"], "read_article should keep a small flat parameter surface");
assert.doesNotMatch(Object.keys(readArticle.parameters.properties).join(" "), /includeHtml|includeLinks/, "read_article should not expose HTML or link-list toggles");
assert.match(readArticle.description, /返回 \{text,totalChars,hasMore,nextOffset,target,linkCount,outline\}/, "read_article should return one target and link count for follow-up tools");
assert.match(readArticle.description, /outline.*offset\/endOffset\/charCount/, "read_article outline should expose chapter ranges through the existing offset model");

const dataStore = resolveToolDefinition("data_store");
assertPropertyOrder(
  dataStore.parameters,
  ["action", "table", "rowId", "field", "value", "expectedValue", "revision", "dedupField", "columns", "filter", "limit", "offset", "row", "rows", "data"],
  "data_store should put target/control fields before long write payloads",
);
assert.match(dataStore.parameters.properties.action.description, /create_table 需 table \+ columns/, "data_store should document explicit table creation");
for (const [name, input, missing] of [
  ["data_store", { action: "create_table" }, ["table", "columns"]],
  ["data_store", { action: "upsert", table: "rows" }, ["rows or row"]],
  ["data_store", { action: "replace" }, ["rowId", "revision", "data"]],
  ["manage_bookmarks", { action: "update", id: "1" }, ["title or url"]],
]) assert.throws(() => resolveToolDefinition(name).validateArgs(input), error =>
  error.code === "MISSING_REQUIRED_ARGUMENTS" && JSON.stringify(error.details.missing) === JSON.stringify(missing));
assert.doesNotMatch(toolsSource, /assertDirectDataStorePayloadAllowed|DATA_STORE_DIRECT_PAYLOAD_TOO_LARGE/, "data_store should not block large direct write payloads after args are generated");
assert.doesNotMatch(toolErrorLocalizationSource, /DATA_STORE_DIRECT_PAYLOAD_TOO_LARGE|直接写入 Data 表的数据过大/, "removed data_store direct payload guard should not have a localized error message");

assert.deepEqual(
  Object.keys(QINGZHOU_DOCUMENT_TOOL_SPECS.document_create.parameters.properties),
  ["format", "filename", "title", "docModelId", "download", "saveAs", "blocks", "sheets"],
  "document_create should put long blocks/sheets last",
);

const validateToolArgs = extractFunctionBody(toolsSource, "validateToolArgs");
assert.doesNotMatch(validateToolArgs, /\bargs,\s*(?:\n|\})/, "missing-argument errors should not echo full tool args");
assert.doesNotMatch(validateToolArgs, /compactToolArgShape/, "missing-argument errors expose public recovery fields only");

const createSchema = SKILL_AUTHOR_TOOL_PARAMETERS.create;
assertPropertyOrder(createSchema, ["name", "displayName", "description", "scope", "domains", "urlPatterns", "excludePatterns", "content"], "create_skill should put long content after metadata");
assert.match(createSchema.properties.content.description, /最后填写/, "create_skill content should explicitly be filled last");

const editResourceSchema = SKILL_AUTHOR_TOOL_PARAMETERS.editResource;
assertPropertyOrder(editResourceSchema, ["name", "path", "action", "newPath", "type", "title", "description", "oldText", "newText", "appendText", "prependText", "content"], "edit_skill_resource should put full content replacement last");
assert.match(editResourceSchema.properties.content.description, /一次调用只改一个资源/, "edit_skill_resource should discourage bundled long edits");

assert.doesNotMatch(toolsSource, /context_store|CONTEXT_EXTERNAL/, "context_store externalization should stay disabled until the design is reintroduced");

console.log("long-output tool contract tests passed");

function toolBlock(name) {
  const source = filesDocumentsToolsSource;
  const start = source.indexOf(`registerTool({\n    name: "${name}"`);
  const fallbackStart = source.indexOf(`registerTool({\n  name: "${name}"`);
  const effectiveStart = start >= 0 ? start : fallbackStart;
  assert.notEqual(effectiveStart, -1, `missing ${name} tool block`);
  const end = source.indexOf("\n  });\n", effectiveStart) >= 0
    ? source.indexOf("\n  });\n", effectiveStart)
    : source.indexOf("\n});\n", effectiveStart);
  assert.notEqual(end, -1, `unterminated ${name} tool block`);
  return source.slice(effectiveStart, end);
}

function assertPropertyOrder(schema, keys, message) {
  const properties = Object.keys(schema.properties);
  let previous = -1;
  for (const key of keys) {
    const index = properties.indexOf(key);
    assert.notEqual(index, -1, `${message}: missing property ${key}`);
    assert.ok(index > previous, `${message}: ${key} should appear after previous fields`);
    previous = index;
  }
}

function extractFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, index);
    }
  }
  throw new Error(`unterminated function ${name}`);
}
