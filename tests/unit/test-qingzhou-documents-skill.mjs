import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import "../support/default-locale.mjs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storageData = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]));
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete storageData[item];
      },
    },
  },
};

const tools = await import("../../src/background/tools/runtime.js");
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
const skills = await import("../../src/background/skills/runtime.js");
const prompts = await import("../../src/background/agent/prompts.js");
const documentsSkill = await import("../../src/capabilities/documents/embedded-skill.js");
const contract = await import("../../src/capabilities/documents/skill-contract.js");
const createInput = await import("../../src/shared/documents/document-create-input.js");
const toolModel = await import("../../src/sidepanel/tools/tool-model.js");
const pluginUi = await import("../../src/sidepanel/tools/skill-tool-ui-registry.js");

const loadedContext = Object.freeze({
  source: "test",
  sessionId: "session_documents_test",
  runId: "run_documents_test",
  loadedPluginSkillNames: [documentsSkill.BUILTIN_QINGZHOU_DOCUMENTS_SKILL_NAME],
});

await runtime.commitSkillToolRegistryCandidate(
  await runtime.prepareSkillToolRegistryFromStorage(),
  { reason: "test_qingzhou_documents_skill" },
);
pluginUi.setSkillToolUiCatalog(await runtime.listSkillContributions(loadedContext));

const initialNames = tools.getToolSchemas().map(item => item.function?.name);
for (const coreName of contract.DOCUMENT_TOOL_CORE_NAMES) {
  const pluginName = contract.getDocumentSkillToolName(coreName);
  assert.equal(initialNames.includes(coreName), false, `${coreName} should not stay resident`);
  assert.equal(initialNames.includes(pluginName), false, `${pluginName} should be absent before load_skill`);
}

await assert.rejects(
  () => tools.executeTool(contract.getDocumentSkillToolName("document_list_artifacts"), { timeout: 30 }, null, { source: "test" }),
  err => err?.code === "UNKNOWN_TOOL",
  "document plugin tools should not execute before the skill is loaded",
);

const loadedSkill = await skills.loadSkill(documentsSkill.BUILTIN_QINGZHOU_DOCUMENTS_SKILL_NAME);
assert.equal(loadedSkill.name, "qingzhou-documents");
assert.equal(loadedSkill.metadata.displayName, "文档处理");
assert.equal(loadedSkill.scope, "global");
assert.equal(loadedSkill.builtin, true);
assert.equal(loadedSkill.readOnly, true);
assert.match(loadedSkill.content, /只把远程文件原样下载[\s\S]*`download_url`/);
assert.match(loadedSkill.content, /大文档必须通过 `docModelId` 传入/);
assert.match(loadedSkill.content, /qingzhou_documents__document_fetch/);
assert.match(loadedSkill.content, /qingzhou_documents__document_list_artifacts/);
assert.match(loadedSkill.content, /DOCX、XLSX、PDF 来自其他 Skill 的资源[\s\S]*load_skill_resource/);
assert.match(loadedSkill.content, /rows 的每个元素就是一行/);
assert.match(loadedSkill.content, /rows:\[\[\{"公司":"A"\},\{"公司":"B"\}\]\]/);
assert.match(loadedSkill.content, /title[^\n]*元数据[^\n]*不会自动写入正文/);

const manifest = JSON.parse(loadedSkill.resources.find(resource => resource.path === "plugin.json")?.content || "{}");
assert.equal(manifest.id, contract.QINGZHOU_DOCUMENTS_SKILL_ID);
assert.equal(manifest.version, "0.2.3");
assert.deepEqual(manifest.tools.map(tool => tool.name), contract.DOCUMENT_TOOL_CORE_NAMES);
assert.ok(manifest.tools.every(tool => tool.runtime === "host" && tool.needsPage === false));
assert.ok(manifest.tools.every(tool => tool.includeTrace === false));
assert.equal(loadedSkill.resources.filter(resource => resource.type === "script").length, contract.DOCUMENT_TOOL_CORE_NAMES.length);

const catalog = await skills.buildSkillPromptSection();
assert.match(catalog, /qingzhou-documents（文档处理）/);
assert.match(catalog, /阅读长文档、转换文件格式或生成正式文档产物/);
await assert.rejects(
  () => skills.updateSkill("qingzhou-documents", { description: "x" }),
  err => err?.code === "SKILL_READ_ONLY",
);

const loadedSchemas = tools.getToolSchemas(loadedContext);
const loadedNames = loadedSchemas.map(item => item.function?.name);
for (const coreName of contract.DOCUMENT_TOOL_CORE_NAMES) {
  const pluginName = contract.getDocumentSkillToolName(coreName);
  assert.equal(loadedNames.includes(coreName), false, `${coreName} should remain hidden after load_skill`);
  const schema = loadedSchemas.find(item => item.function?.name === pluginName)?.function;
  assert.ok(schema, `${pluginName} should be exposed after load_skill`);
  assert.equal(schema.name, pluginName);
  assert.ok(schema.description.startsWith(contract.QINGZHOU_DOCUMENT_TOOL_SPECS[coreName].description));
  assert.ok(Object.prototype.hasOwnProperty.call(schema.parameters.properties, "timeout"), `${pluginName} should receive the common timeout control`);
}

assert.deepEqual(
  Object.keys(loadedSchemas.find(item => item.function?.name === contract.getDocumentSkillToolName("document_create")).function.parameters.properties),
  ["timeout", "format", "filename", "title", "docModelId", "download", "saveAs", "blocks", "sheets"],
  "document_create should preserve short fields before long payloads",
);
const documentCreateSchema = loadedSchemas.find(
  item => item.function?.name === contract.getDocumentSkillToolName("document_create"),
).function.parameters;
assert.deepEqual(documentCreateSchema.required, ["format"]);
const documentCreateFunction = loadedSchemas.find(
  item => item.function?.name === contract.getDocumentSkillToolName("document_create"),
).function;
for (const format of createInput.DOCUMENT_OUTPUT_FORMATS) {
  assert.match(documentCreateFunction.description, new RegExp(`"${format}"`));
  assert.match(documentCreateSchema.properties.format.description, new RegExp(`"${format}"`));
}
assert.match(documentCreateFunction.description, /120/);
assert.doesNotMatch(documentCreateFunction.description, /必须传入 timeout/);
assert.match(documentCreateFunction.description, /用户明确指定目标格式时必须传对应值并直接生成/);
assert.match(documentCreateSchema.properties.title.description, /元数据标题[^。]*默认文件名[^。]*不会自动写入正文/);
assert.match(documentCreateSchema.properties.title.description, /type:'heading', level:1/);
assert.match(documentCreateSchema.properties.sheets.description, /rows 的每个元素就是一行/);
assert.match(documentCreateSchema.properties.sheets.description, /rows:\[\[\{"公司":"A"\},\{"公司":"B"\}\]\]/);
assert.deepEqual(documentCreateSchema.properties.blocks.items, createInput.DOCUMENT_BLOCK_INPUT_SCHEMA);
assert.deepEqual(documentCreateSchema.properties.sheets.items, createInput.DOCUMENT_SHEET_INPUT_SCHEMA);
assert.equal(documentCreateSchema.additionalProperties, false);
assert.deepEqual(
  tools.resolveToolDefinition(contract.getDocumentSkillToolName("document_create")).parameters,
  documentCreateSchema,
  "document_create execution must validate against the exact schema exposed to the model and run_script",
);
assert.deepEqual(
  Object.keys(loadedSchemas.find(item => item.function?.name === contract.getDocumentSkillToolName("document_read_chunk")).function.parameters.properties),
  ["timeout", "docModelId", "chunkIndex", "tableId", "sheetName", "offset", "limit"],
  "document_read_chunk should keep one flat cursor schema",
);

const forwardingCases = {
  document_fetch: { url: "https://example.com/report.pdf", filename: "report.pdf" },
  document_parse: { fileId: "file_1", chunkSize: 4096 },
  document_read_chunk: { docModelId: "model_1", tableId: "table:3", offset: 50, limit: 50 },
  document_create: { format: "txt", filename: "summary.txt", title: "Summary", blocks: [{ type: "paragraph", text: "ok" }], download: false },
  document_download: { artifactId: "artifact_1", filename: "summary.txt", saveAs: false },
  document_list_artifacts: { limit: 8 },
};

for (const [coreName, input] of Object.entries(forwardingCases)) {
  const calls = [];
  const result = await runtime.executeSkillTool(
    contract.getDocumentSkillToolName(coreName),
    { ...input, timeout: 45 },
    null,
    loadedContext,
    async (name, args, _signal, context) => {
      calls.push({ name, args, context });
      return { ok: true, coreName: name, echoed: args };
    },
  );
  assert.equal(calls.length, 1, `${coreName} should dispatch exactly once`);
  assert.equal(calls[0].name, coreName);
  assert.deepEqual(calls[0].args, input, `${coreName} should forward business args unchanged`);
  assert.equal(calls[0].context.source, "plugin_host");
  assert.equal(calls[0].context.sessionId, loadedContext.sessionId);
  assert.equal(calls[0].context.runId, loadedContext.runId);
  assert.equal(result.coreName, coreName);
  assert.equal(getToolResultPresentation(result)._plugin.id, contract.QINGZHOU_DOCUMENTS_SKILL_ID);
  assert.equal(getToolResultPresentation(result)._plugin.runtime, "host");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "trace"), false, `${coreName} should not duplicate its result into host trace`);
}

await assert.rejects(
  () => tools.executeTool(
    contract.getDocumentSkillToolName("document_create"),
    { timeout: 30, filename: "missing-format.pdf", blocks: [{ type: "paragraph", text: "content" }] },
    null,
    loadedContext,
  ),
  error => {
    assert.equal(error?.code, "MISSING_REQUIRED_ARGUMENTS");
    assert.deepEqual(error?.details?.missing, ["format"]);
    assert.deepEqual(error?.details?.expected?.format?.enum, createInput.DOCUMENT_OUTPUT_FORMATS);
    assert.deepEqual(error?.details?.retry?.requiredFields, ["format"]);
    assert.deepEqual(error?.details?.retry?.preservedArgs, {});
    return true;
  },
  "missing format should return its schema and preserve the plugin timeout for retry",
);

await assert.rejects(
  () => tools.executeTool(
    contract.getDocumentSkillToolName("document_create"),
    {
      timeout: 30,
      format: "pdf",
      filename: "legacy-blocks.pdf",
      download: false,
      blocks: [
        { heading: "Summary", level: 1 },
        { table: true, columns: ["id"], rows: [[1]] },
        { list: ["one"] },
      ],
    },
    null,
    loadedContext,
  ),
  error => {
    assert.equal(error?.code, "DOCUMENT_BLOCK_SCHEMA_INVALID");
    assert.equal(error?.details?.issueCount, 3);
    assert.equal(error?.details?.expectedSchema?.required?.includes("type"), true);
    assert.equal(error?.details?.examples?.heading?.type, "heading");
    assert.deepEqual(error?.details?.retry?.requiredFields, ["format"]);
    assert.deepEqual(error?.details?.retry?.preservedArgs, {
      format: "pdf",
      filename: "legacy-blocks.pdf",
      download: false,
    });
    assert.deepEqual(error?.details?.retry?.replacePaths, ["blocks"]);
    return true;
  },
  "invalid blocks should fail before rendering and return a self-contained retry envelope",
);

await assert.rejects(
  () => tools.executeTool(
    contract.getDocumentSkillToolName("document_create"),
    { timeout: 30, format: "txt", filename: "empty.txt", blocks: [], download: false },
    null,
    loadedContext,
  ),
  error => error?.code === "DOCUMENT_CONTENT_EMPTY",
  "empty content should not create an artifact",
);

await assert.rejects(
  () => tools.executeTool(
    contract.getDocumentSkillToolName("document_create"),
    {
      timeout: 30,
      format: "txt",
      filename: "unknown-field.txt",
      blocks: [{ type: "paragraph", text: "content" }],
      download: false,
      mystery: true,
    },
    null,
    loadedContext,
  ),
  error => {
    assert.equal(error?.code, "DOCUMENT_CREATE_SCHEMA_INVALID");
    assert.equal(error?.details?.expectedSchema?.additionalProperties, false);
    assert.ok(error?.details?.allowedFields?.includes("blocks"));
    assert.equal(error?.details?.retry?.preservedArgs?.format, "txt");
    assert.equal(Object.hasOwn(error?.details?.retry?.preservedArgs || {}, "timeout"), false);
    return true;
  },
  "unknown fields should return the top-level contract instead of being ignored",
);

await assert.rejects(
  () => tools.executeTool(
    contract.getDocumentSkillToolName("document_create"),
    {
      timeout: 30,
      format: "pptx",
      filename: "unsupported.pptx",
      blocks: [{ type: "paragraph", text: "content" }],
      download: false,
    },
    null,
    loadedContext,
  ),
  error => {
    assert.equal(error?.code, "DOCUMENT_FORMAT_UNSUPPORTED");
    assert.equal(Object.hasOwn(error?.details?.retry?.preservedArgs || {}, "format"), false);
    assert.equal(error?.details?.retry?.preservedArgs?.filename, "unsupported.pptx");
    assert.equal(Object.hasOwn(error?.details?.retry?.preservedArgs || {}, "timeout"), false);
    return true;
  },
  "retry context should not preserve an unsupported format",
);

assert.match(prompts.SYSTEM_PROMPT, /从当前可用技能中选择文档处理能力[\s\S]*先 load_skill/, "kernel should route document workflows through the on-demand skill");
assert.doesNotMatch(prompts.SYSTEM_PROMPT, /document_fetch|document_parse|document_read_chunk|document_create|document_download|document_list_artifacts/, "kernel should not duplicate document tool SOPs");
assert.match(prompts.SYSTEM_PROMPT, /原样下载远程文件使用 download_url/);
assert.match(prompts.SYSTEM_PROMPT, /保存少量已生成文本使用 save_file/);

for (const coreName of contract.DOCUMENT_TOOL_CORE_NAMES) {
  const pluginName = contract.getDocumentSkillToolName(coreName);
  const definition = tools.resolveToolDefinition(pluginName);
  const identity = pluginUi.enrichSkillToolIdentity({ name: pluginName });
  assert.equal(definition.capabilityId, coreName);
  assert.equal(identity.capabilityId, coreName);
  assert.equal(toolModel.getToolDisplayName(identity), toolModel.getToolDisplayName(coreName));
  assert.equal(toolModel.getToolProfileFamily(identity), toolModel.getToolProfileFamily(coreName));
  assert.equal(toolModel.getToolTimelineFamilyInfo(identity).id, toolModel.getToolTimelineFamilyInfo(coreName).id);
}

const rendererSource = readFileSync(new URL("../../src/sidepanel/tools/tool-renderer.ts", import.meta.url), "utf8");
const rendererCapabilitySource = readFileSync(new URL("../../src/capabilities/documents/renderers.ts", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("../../src/sidepanel/tools/tool-timeline-renderer.ts", import.meta.url), "utf8");
const serviceWorkerSource = stripTypeScriptTypes(readFileSync(new URL("../../src/background/service-worker.ts", import.meta.url), "utf8"), { mode: "transform" });
const sessionArtifactsSource = stripTypeScriptTypes(readFileSync(new URL("../../src/background/session/artifacts.ts", import.meta.url), "utf8"), { mode: "transform" });
const artifactModelSource = stripTypeScriptTypes(readFileSync(new URL("../../src/capabilities/sessions/artifacts/artifact-model.ts", import.meta.url), "utf8"), { mode: "transform" });
assert.match(rendererCapabilitySource, /host\.project\("document",[^\n]+documents\.renderDocument/, "document tools should register their shared profile projection");
const { default: registerDocumentRenderers } = await import("../../src/capabilities/documents/renderers.js");
const registeredRenderers = [];
const registeredPresentations = [];
registerDocumentRenderers({
  generic: {},
  project: (id, projection) => ({ id, projection }),
  registerRenderer: renderer => registeredRenderers.push(renderer),
  registerPresentation: presentation => registeredPresentations.push(presentation),
});
assert.deepEqual(registeredRenderers.map(renderer => renderer.id), ["download", "document"]);
assert.ok(registeredRenderers.every(renderer => typeof renderer.projection === "function"));
assert.ok(registeredPresentations.length > 0, "document presentations should share the same registration API");
assert.match(rendererSource, /registerRenderer: renderer => \{ toolRendererRegistry\.register\(renderer\); \}/, "the SDK should register renderers with the shared host registry");
assert.match(rendererSource, /for \(const setup of rendererCapabilities\) setup\(rendererHost\)/, "all discovered renderer extensions should receive the registration API");
assert.match(readFileSync(new URL("../../src/sidepanel/tools/tool-runtime-details.ts", import.meta.url), "utf8"), /rendererId: tool\.rendererId \|\| profileFamily \|\| \(skillPresentation\.resolveSkillToolRenderContext/, "running and completed tools should resolve the same profile before generic plugin rendering");
assert.match(timelineSource, /enrichSkillToolIdentity[\s\S]*getToolTimelineFamilyInfo\(toolOrName\)/, "document plugin tools should inherit document and artifact families through capability identity");
assert.match(sessionArtifactsSource, /function toolCapabilityName[\s\S]*getToolIdentity\(name\)\.capabilityId/, "background artifact collection should resolve generic tool capabilities");
assert.match(serviceWorkerSource, /createSessionArtifacts\([\s\S]*getToolIdentity/, "service worker should inject the shared capability registry into artifact collection");
assert.match(artifactModelSource, /function toolCapabilityName[\s\S]*enrichSkillToolIdentity\(\{[\s\S]*\.\.\.tool/, "sidepanel artifact fallback should resolve generic tool capabilities");
assert.doesNotMatch(rendererSource, /getDocumentToolCoreName/, "renderer should not know about document runtime aliases");
assert.doesNotMatch(timelineSource, /getDocumentToolCoreName/, "timeline should not know about document runtime aliases");

console.log("qingzhou documents skill tests passed");
