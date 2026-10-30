import assert from "node:assert/strict";
import { discoverCapabilities } from "../../scripts/capability-catalog.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  getToolMetadataCatalog,
  formatActionLabel,
  formatToolActionTitle,
} from "../../src/shared/tools/tool-metadata.js";
import { QINGZHOU_DOCUMENT_TOOL_SPECS } from "../../src/capabilities/documents/skill-contract.js";
import {
  discoverSkillManifests,
  normalizeSkillManifest,
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import { listBuiltinSkills } from "../../src/shared/skills/builtin-skills.js";
import {
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-utils.js";
import {
  createSessionRecord,
  readSessionRecord,
  updateTranscriptWithAgentEvent,
} from "../../src/shared/session/session-codec.js";
import { createSessionListSummaryFromTranscript } from "../../src/shared/session/session-list-summary.js";
import {
  enrichSkillToolIdentity,
  setSkillToolUiCatalog,
} from "../../src/sidepanel/tools/skill-tool-ui-registry.js";
import {
  getToolDisplayName,
  getToolDetailLayout,
  getToolMediaPresentation,
  getToolProfileFamily,
  getToolResultFamily,
  getToolTimelineFamilyInfo,
  isToolInSet,
  isPageContextToolName,
} from "../../src/sidepanel/tools/tool-model.js";
import {
  normalizeToolIdentitySnapshot,
  toolIdentityEventFields,
  toolIdentityMetaFromEvent,
} from "../../src/shared/tools/tool-identity.js";

await assertCoreMetadataCoverage();
const { resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
const { getSkillToolParameters } = await import("../../src/background/skills/skill-tool-runtime.js");
assertSharedActionLabels();
assertBuiltinCapabilitiesInheritPresentation();
assertUntrustedPluginsCannotClaimCoreCapabilities();
assertUnknownToolsDoNotInferPresentationFromNames();
assertIdentityProtocolUsesOneCodec();
assertToolIdentitySurvivesTranscriptRoundTrip();
assertPresentationHasNoRuntimeAliasSpecialCases();
assertPageRoleTerminologyContract();

console.log("tool definition catalog tests passed");

async function assertCoreMetadataCoverage() {
  // Run the real registrars: tools.js delegates registration, so scanning its
  // source for registerTool("name") used to silently test an empty catalog.
  globalThis.chrome = {
    storage: { local: { async get() { return {}; } } },
    runtime: { getURL: path => `chrome-extension://test/${path}` },
  };
  const families = discoverCapabilities(fileURLToPath(new URL("../../src/", import.meta.url))).tools;
  assert.ok(families.length > 0, "the tool family discovery must not be empty");
  const registered = new Set();
  for (const file of families) {
    const { default: register } = await import(pathToFileURL(file));
    assert.equal(typeof register, "function", `${file} must expose a capability registrar`);
    const before = registered.size;
    register({
      skills: {}, models: {},
      registerTool({ name }) {
        assert.ok(!registered.has(name), `${name} must not be registered twice`);
        registered.add(name);
      },
    });
    assert.ok(registered.size > before, `${file} must register at least one tool`);
  }
  const runtime = await import("../../src/background/tools/runtime.js");
  const visible = runtime.getToolSchemas().map(schema => schema.function.name);
  assert.ok(visible.length > 0, "the model-facing tool catalog must not be empty");
  assert.ok(registered.has("open_tab"), "the catalog must include browser tools");
  assert.ok(registered.has("document_parse"), "the catalog must include hidden host tools");
  for (const name of registered) {
    const definition = runtime.resolveToolDefinition(name);
    assert.equal(definition?.source, "core", `${name} must be wired into the runtime`);
    assert.ok(definition.description?.trim(), `${name} must explain its purpose`);
    assert.equal(typeof definition.execute, "function", `${name} must be executable`);
    assert.equal(definition.parameters.type, "object", `${name} must expose an object schema`);
    const meta = getToolMetadataCatalog().tools[name];
    assert.ok(meta, `registered core tool ${name} should have shared metadata`);
    assert.ok(meta.title, `${name} should have a user-facing title`);
    assert.ok(meta.familyId, `${name} should have an aggregation family`);
    assert.equal(typeof meta.profileFamily, "string");
    assert.equal(typeof meta.resultFamily, "string");
    assert.equal(typeof meta.detailLayout, "string");
    assert.equal(typeof meta.mediaPresentation, "string");
  }
  assert.deepEqual(
    visible.sort(),
    [...registered.keys()].filter(name => !runtime.resolveToolDefinition(name).hidden).sort(),
    "the model-facing catalog must match all visible registered tools",
  );
}

function assertSharedActionLabels() {
  assert.equal(getToolMetadataCatalog().tools.list_images.title, "发现图片");
  assert.equal(getToolMetadataCatalog().tools.collect_images.title, "采集图片");
  assert.equal(formatToolActionTitle("data_store", { action: "upsert" }), "写入数据表");
  assert.equal(formatToolActionTitle("data_store", { action: "query" }), "读取数据表");
  assert.equal(formatToolActionTitle("manage_settings", { action: "apply_preset" }), "应用模型预设");
  assert.equal(formatToolActionTitle("manage_guardrails", { action: "get" }), "读取安全策略");
  assert.equal(formatToolActionTitle("network_body", { bodyType: "request" }), "读取请求体");
  assert.equal(formatActionLabel("upsert"), "写入/更新");
  assert.equal(formatActionLabel("type"), "", "a generic type field must not be mislabeled as an input action");
  const screenActions = {
    click: "点击页面",
    double_click: "双击页面",
    long_press: "长按页面",
    hover: "悬停页面",
    type: "输入文本",
    press: "按下按键",
    scroll: "滚动页面",
    drag: "拖动页面",
  };
  for (const [action, label] of Object.entries(screenActions)) {
    assert.equal(formatActionLabel(action, "act_on_screen"), label);
    assert.equal(formatToolActionTitle("act_on_screen", { action }), label);
  }
}

function assertBuiltinCapabilitiesInheritPresentation() {
  const discovered = discoverSkillManifests(listBuiltinSkills());
  const documents = discovered.plugins.find(plugin => plugin.id === "qingzhou-documents");
  const management = discovered.plugins.find(plugin => plugin.id === "qingzhou-management");
  const mcp = discovered.plugins.find(plugin => plugin.id === "qingzhou-mcp");
  assert.ok(documents);
  assert.ok(management);
  assert.ok(mcp);

  const parse = documents.tools.find(tool => tool.localName === "document_parse");
  const settings = management.tools.find(tool => tool.localName === "manage_settings");
  const inspectMcp = mcp.tools.find(tool => tool.localName === "mcp_inspect_server");
  assert.equal(parse.capabilityId, "document_parse");
  assert.equal(parse.familyId, "document");
  assert.equal(parse.profileFamily, "document");
  assert.equal(parse.pageContext, false);
  assert.equal(settings.capabilityId, "manage_settings");
  assert.equal(settings.familyId, "settings");
  assert.equal(settings.profileFamily, "settings");
  assert.equal(settings.pageContext, false);
  assert.equal(inspectMcp.capabilityId, "mcp_inspect_server");
  assert.equal(inspectMcp.familyId, "mcp");
  assert.equal(inspectMcp.profileFamily, "mcp");
  assert.equal(inspectMcp.pageContext, false);

  setSkillToolUiCatalog({ plugins: [documents, management, mcp] });
  const parseIdentity = enrichSkillToolIdentity({ name: parse.name });
  const settingsIdentity = enrichSkillToolIdentity({ name: settings.name });
  const mcpIdentity = enrichSkillToolIdentity({ name: inspectMcp.name });
  assert.equal(getToolDisplayName(parseIdentity), "解析文档");
  assert.equal(getToolProfileFamily(parseIdentity), "document");
  assert.equal(getToolResultFamily(parseIdentity), "generic");
  assert.equal(getToolTimelineFamilyInfo(parseIdentity).id, "document");
  assert.equal(getToolDisplayName(settingsIdentity), "管理模型设置");
  assert.equal(getToolProfileFamily(settingsIdentity), "settings");
  assert.equal(getToolResultFamily(settingsIdentity), "settings");
  assert.equal(getToolDisplayName(mcpIdentity), "探测 MCP");
  assert.equal(getToolProfileFamily(mcpIdentity), "mcp");
  assert.equal(getToolResultFamily(mcpIdentity), "mcp");
  assert.equal(getToolTimelineFamilyInfo(mcpIdentity).id, "mcp");
  assert.equal(getToolDetailLayout({ name: "data_store" }), "wide");
  assert.equal(getToolMediaPresentation({ name: "read_image" }), "asset");
  assert.equal(isPageContextToolName({ name: "wait" }), false);
  assert.equal(isPageContextToolName({ name: "wait_for_user" }), false);

  for (const skill of listBuiltinSkills().filter(item => ["qingzhou-documents", "qingzhou-management", "qingzhou-mcp"].includes(item.name))) {
    const manifest = JSON.parse(skill.resources.find(resource => resource.path === "plugin.json").content);
    assert.equal(manifest.tools.every(tool => !Object.hasOwn(tool, "title")), true, `${skill.name} titles should come from capability metadata`);
  }
  assert.equal(Object.values(QINGZHOU_DOCUMENT_TOOL_SPECS).every(spec => !Object.hasOwn(spec, "title")), true);
}

function assertIdentityProtocolUsesOneCodec() {
  const eventFields = toolIdentityEventFields({
    name: "wrapped__tool",
    capabilityId: "core_tool",
    title: "核心工具",
    familyId: "process",
    familyTitle: "处理数据",
  });
  assert.deepEqual(eventFields, {
    toolCapabilityId: "core_tool",
    toolTitle: "核心工具",
    toolFamilyId: "process",
    toolFamilyTitle: "处理数据",
  });
  assert.deepEqual(toolIdentityMetaFromEvent(eventFields), {
    capabilityId: "core_tool",
    title: "核心工具",
    familyId: "process",
    familyTitle: "处理数据",
  });
  assert.deepEqual(normalizeToolIdentitySnapshot({ toolName: "wrapped__tool" }, eventFields), {
    name: "wrapped__tool",
    capabilityId: "core_tool",
    title: "核心工具",
    familyId: "process",
    familyTitle: "处理数据",
  });
}

function assertUntrustedPluginsCannotClaimCoreCapabilities() {
  const diagnostics = [];
  const plugin = normalizeSkillManifest({
    format: SKILL_MANIFEST_FORMAT,
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    id: "third-party",
    tools: [{
      name: "pretend_document",
      capabilityId: "document_parse",
      title: "Pretend",
      script: "scripts/run.js",
      parameters: { type: "object", properties: {} },
    }],
  }, {
    name: "third-party-skill",
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    scope: "global",
    source: "user",
    builtin: false,
    readOnly: false,
    resources: [],
  }, diagnostics);
  assert.equal(plugin.tools[0].capabilityId, "third_party__pretend_document");
  assert.equal(plugin.tools[0].pageContext, true);
  assert.equal(diagnostics.some(item => /capabilityId ignored/.test(item.message)), true);
}

function assertUnknownToolsDoNotInferPresentationFromNames() {
  const unknown = { name: "third_party__network_body" };
  assert.equal(getToolProfileFamily(unknown), "");
  assert.equal(getToolResultFamily(unknown), "generic");
  assert.equal(getToolTimelineFamilyInfo(unknown).id, "other");
  assert.equal(isToolInSet(unknown, "network"), false);
  assert.equal(isPageContextToolName(unknown), false);
}

function assertToolIdentitySurvivesTranscriptRoundTrip() {
  const identity = {
    toolCapabilityId: "document_create",
    toolTitle: "生成文档",
    toolFamilyId: "artifact",
    toolFamilyTitle: "生成产物",
  };
  let state = updateTranscriptWithAgentEvent([], {
    type: "tool_execution_start",
    runId: "run_identity",
    spanId: "span_identity",
    toolCallId: "call_identity",
    toolName: "qingzhou_documents__document_create",
    ...identity,
    args: { format: "pdf" },
  });
  state = updateTranscriptWithAgentEvent(state.transcript, {
    type: "tool_execution_update",
    runId: "run_identity",
    spanId: "span_identity",
    toolCallId: "call_identity",
    toolName: "qingzhou_documents__document_create",
    statusText: "生成中",
  });
  assert.equal(state.transcript.find(entry => entry.type === "tool").capabilityId, "document_create");
  assert.equal(state.transcript.find(entry => entry.type === "tool").title, "生成文档");
  state = updateTranscriptWithAgentEvent(state.transcript, {
    type: "tool_execution_end",
    runId: "run_identity",
    spanId: "span_identity",
    toolCallId: "call_identity",
    toolName: "qingzhou_documents__document_create",
    ...identity,
    args: { format: "pdf" },
    result: { artifactId: "artifact_1", filename: "result.pdf" },
  });
  const record = readSessionRecord(createSessionRecord([], state.transcript));
  const tool = record.transcript.find(entry => entry.type === "tool");
  assert.equal(tool.capabilityId, "document_create");
  assert.equal(tool.title, "生成文档");
  assert.equal(tool.familyId, "artifact");
  assert.equal(tool.familyTitle, "生成产物");
  assert.equal(createSessionListSummaryFromTranscript(record.transcript).lastText, "生成文档 完成");
}

function assertPresentationHasNoRuntimeAliasSpecialCases() {
  for (const file of [
    "src/sidepanel/tools/tool-model.ts",
    "src/sidepanel/tools/tool-renderer.ts",
    "src/sidepanel/tools/tool-timeline-renderer.ts",
    "src/shared/session/session-list-summary.js",
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, /qingzhou_documents__|qingzhou_management__|qingzhou_mcp__/i, `${file} should resolve wrapped tools through capability metadata`);
    assert.doesNotMatch(text, /getDocumentToolCoreName/, `${file} should not contain document-specific alias normalization`);
  }
  const renderer = source("src/sidepanel/tools/tool-renderer.ts");
  const timeline = source("src/sidepanel/tools/tool-timeline-renderer.ts");
  assert.doesNotMatch(renderer, /WIDE_TOOL_NAMES|const ACTION_LABELS|\.name === "read_image"|\.name === "read_image_asset"/);
  assert.doesNotMatch(timeline, /isDefaultPluginCategory|\["document_create", "document_download", "document_list_artifacts"\]|toolKey\(tool\) === "network_body"|toolKey\(tool\) === "screenshot"/);
  assert.doesNotMatch(source("src/background/agent/agent.js"), /function toolIdentityEventFields/);
  assert.doesNotMatch(source("src/background/tools/runtime.js"), /function toolIdentityEventFields/);
}

function assertPageRoleTerminologyContract() {
  const tabTools = ["list_tabs", "use_tab", "get_working_tab"].map(name => resolveToolDefinition(name).description).join("\n");
  const accessibilityTools = resolveToolDefinition("get_ax_tree").description;
  const browserContentProfile = ["wait", "tabs", "accessibility", "documents", "media"]
    .map(name => source(`src/capabilities/${name}/browser-content.ts`)).join("\n");
  const pluginRuntime = getSkillToolParameters({ script: "scripts/example.js", runtime: "page" }).properties.tabRef.description;
  assert.match(
    tabTools,
    /active=true 表示用户可见标签页，isWorkingTab=true 表示当前任务工作标签页/,
    "list_tabs should expose page roles as result facts",
  );
  assert.match(
    tabTools,
    /用户可见标签页保持不变/,
    "use_tab should state its local visible-tab effect",
  );
  assert.doesNotMatch(
    `${tabTools}\n${pluginRuntime}`,
    /用户(?:明确)?说[“「]?当前页面|我现在看的页面/,
    "tool descriptions should rely on the kernel page-language contract",
  );
  assert.match(
    pluginRuntime,
    /标签页别名或正整数标签页 ID.*省略时使用当前任务工作标签页。/,
    "plugin page tools should describe tabRef and its working-tab default",
  );
  assert.match(
    accessibilityTools,
    /获取当前任务所拥有页面的语义快照/,
    "get_ax_tree should state its owner-only CDP boundary",
  );
  assert.match(
    tabTools,
    /没有工作标签页时返回 hasWorkingTab=false；存在时返回 hasWorkingTab=true/,
    "get_working_tab should model absence as a normal getter result",
  );
  assert.match(
    browserContentProfile,
    /data\.hasWorkingTab === false \? t\("noWorkingPage"\) : t\("workingPage"\)/,
    "the tool profile should render the normal empty state without an error card",
  );
}

function source(path) {
  const source = new URL(`../../${path}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : new URL(source.href.replace(/\.js$/, ".ts")), "utf8");
}
