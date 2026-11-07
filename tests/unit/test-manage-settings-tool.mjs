import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import { loadModelsDevFixture } from "../support/models-dev-fixture.mjs";
import { createStreamAttempt } from "../../src/background/llm/stream-attempt.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

await loadModelsDevFixture();

const storageData = {};
const fetchCalls = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
};

globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), method: String(options.method || "GET").toUpperCase() });
  if (String(url).includes("models.dev/api.json")) {
    throw new TypeError("models.dev is offline in this fixture; use the bundled SDK catalog");
  }
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ data: [{ id: "model-a", owned_by: "test" }] });
    },
    async json() {
      return { data: [{ id: "model-a", owned_by: "test" }] };
    },
  };
};

const skillSettingsModule = await import("../../src/background/skills/skill-settings.js");
const skillSettingsPlugin = Object.freeze({
  id: "example-warehouse",
  name: "example-warehouse",
  displayName: "示例数据仓库",
  description: "Example data warehouse tools",
  skillName: "warehouse-query",
  skillDisplayName: "数据仓库查询",
  settings: {
    title: "数据仓库查询",
    description: "连接示例数据仓库所需配置",
    layout: {
      sections: [
        { title: "项目", description: "目标项目", fields: ["project", "endpoint"] },
        { title: "凭证", description: "访问凭证", fields: ["accessKeyId", "secretAccessKey"] },
      ],
    },
    fields: [
      { key: "project", type: "text", label: "Project", description: "Warehouse project", required: true, default: "", options: [], reenterWhen: [] },
      { key: "endpoint", type: "url", label: "Endpoint", description: "Warehouse endpoint", required: true, default: "https://warehouse.example.com/api", options: [], reenterWhen: [] },
      { key: "accessKeyId", type: "text", label: "AccessKey ID", description: "AccessKey ID", required: true, default: "", options: [], reenterWhen: [] },
      { key: "secretAccessKey", type: "secret", label: "AccessKey Secret", description: "AccessKey Secret", required: true, default: "", options: [], reenterWhen: [] },
    ],
  },
});
const skillSettings = skillSettingsModule.createSkillSettingsService({
  storage: globalThis.chrome.storage.local,
  listSkillManifests: async () => [skillSettingsPlugin],
  now: () => "2026-07-17T12:00:00.000Z",
});

const toolsModule = await import("../../src/background/tools/runtime.js");
const toolEvents = [];
const toolRuntime = toolsModule.createToolRuntime({
  skillSettings,
  emit: event => toolEvents.push(event),
});
const tools = Object.freeze({ ...toolsModule, executeTool: toolRuntime.execute });
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
const skills = await import("../../src/background/skills/runtime.js");
const managementSkill = await import("../../src/capabilities/settings/embedded-skill.js");
const modelParameters = await import("../../src/shared/models/model-parameters.js");
const runtimeConfig = await import("../../src/background/runtime-config.js");
const prompts = await import("../../src/background/agent/prompts.js");
const toolModel = await import("../../src/sidepanel/tools/tool-model.js");
const pluginUi = await import("../../src/sidepanel/tools/skill-tool-ui-registry.js");
const sidepanelEvents = await import("../../src/sidepanel/features/app/sidepanel-event-router.js");

const MANAGEMENT_SETTINGS_TOOL = "qingzhou_management__manage_settings";
const MANAGEMENT_GUARDRAILS_TOOL = "qingzhou_management__manage_guardrails";
const MANAGEMENT_SKILL_SETTINGS_TOOL = "qingzhou_management__manage_skill_settings";
const loadedManagementContext = Object.freeze({
  source: "test",
  loadedPluginSkillNames: [managementSkill.BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME],
});

function resetStorage() {
  for (const key of Object.keys(storageData)) delete storageData[key];
  fetchCalls.length = 0;
  runtimeConfig.invalidateCurrentRuntimeConfig();
}

function stringify(value) {
  return JSON.stringify(value);
}

resetStorage();
const initialSkillSecret = "warehouse-secret-initial";
await skillSettings.save({
  pluginId: skillSettingsPlugin.id,
  skillName: skillSettingsPlugin.skillName,
  values: {
    project: "analytics_dev",
    endpoint: "https://warehouse.example.com/api",
    accessKeyId: "warehouse-access-key-id",
    secretAccessKey: initialSkillSecret,
  },
});

await runtime.commitSkillToolRegistryCandidate(
  await runtime.prepareSkillToolRegistryFromStorage(),
  { reason: "test_qingzhou_management_skill" },
);
pluginUi.setSkillToolUiCatalog(await runtime.listSkillContributions(loadedManagementContext));
const initialToolNames = tools.getToolSchemas().map(item => item.function?.name);
assert.equal(initialToolNames.includes("manage_settings"), false, "core manage_settings should stay hidden");
assert.equal(initialToolNames.includes("manage_guardrails"), false, "core manage_guardrails should stay hidden");
assert.equal(initialToolNames.includes("manage_skill_settings"), false, "core manage_skill_settings should stay hidden");
assert.equal(initialToolNames.includes(MANAGEMENT_SETTINGS_TOOL), false, "management tools should be absent before load_skill");
assert.equal(initialToolNames.includes(MANAGEMENT_GUARDRAILS_TOOL), false, "guardrail tools should be absent before load_skill");
assert.equal(initialToolNames.includes(MANAGEMENT_SKILL_SETTINGS_TOOL), false, "Skill settings tools should be absent before load_skill");
await assert.rejects(
  () => tools.executeTool(MANAGEMENT_SETTINGS_TOOL, { timeout: 30, action: "get" }, null, { source: "test" }),
  err => err?.code === "UNKNOWN_TOOL",
);

const loadedSkill = await skills.loadSkill(managementSkill.BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME);
assert.equal(loadedSkill.name, managementSkill.BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME);
assert.equal(loadedSkill.metadata.displayName, managementSkill.getBuiltinQingzhouManagementDisplayName());
assert.equal(loadedSkill.scope, "global");
assert.equal(loadedSkill.builtin, true);
assert.equal(loadedSkill.readOnly, true);
assert.match(loadedSkill.content, /qingzhou_management__manage_settings/);
assert.match(loadedSkill.content, /qingzhou_management__manage_guardrails/);
assert.match(loadedSkill.content, /qingzhou_management__manage_skill_settings/);
const managementManifest = JSON.parse(loadedSkill.resources.find(resource => resource.path === "plugin.json")?.content || "{}");
assert.equal(managementManifest.id, "qingzhou-management");
assert.deepEqual(managementManifest.tools.map(tool => tool.name), ["manage_settings", "manage_guardrails", "manage_skill_settings"]);
const skillCatalog = await skills.buildSkillPromptSection();
assert.match(skillCatalog, /qingzhou-management（轻舟管理）/);
assert.match(skillCatalog, /通过对话管理轻舟自身的模型、Provider、模型请求参数、预设/);
await assert.rejects(
  () => skills.updateSkill(managementSkill.BUILTIN_QINGZHOU_MANAGEMENT_SKILL_NAME, { description: "x" }),
  err => err?.code === "SKILL_READ_ONLY",
);

const loadedSchemas = tools.getToolSchemas(loadedManagementContext);
const schema = loadedSchemas.find(item => item.function?.name === MANAGEMENT_SETTINGS_TOOL);
assert.ok(schema, "qingzhou-management should expose model settings after load_skill");
assert.match(schema.function.description, /AK|API Key/, "tool description should cover model credentials");
assert.ok(schema.function.parameters.properties.action.enum.includes("apply_preset"), "manage_settings should expose preset application");
assert.ok(schema.function.parameters.properties.action.enum.includes("delete_preset"), "manage_settings should expose preset deletion");
assert.equal(schema.function.parameters.properties.requestRateLimit.type, "boolean", "manage_settings should expose the global request-limit switch");
assert.equal(schema.function.parameters.properties.modelParameters.type, "object");
assert.equal(schema.function.parameters.properties.modelParameters.additionalProperties, true);
assert.match(schema.function.parameters.properties.modelParameters.description, /JSON|Key\/Value/);
assert.match(schema.function.parameters.properties.requestRateLimit.description, /RPM\/TPM|限速/);
assert.match(schema.function.parameters.properties.requestRateLimit.description, /429|Too Many Requests|rate limit/i, "request limiting should describe the provider 429 recovery use case");
assert.equal(schema.function.parameters.properties.contextWindow.minimum, 1, "context windows should reject non-positive values at the tool boundary");
assert.match(schema.function.description, /MODEL_CAPABILITIES_REQUIRED/, "the tool should explain how unknown context windows are recovered");
assert.match(
  schema.function.parameters.properties.contextWindow.description,
  /切换模型时省略.*默认值.*MODEL_CAPABILITIES_REQUIRED.*明确传入/,
  "contextWindow should use detected defaults and explain when explicit input is needed",
);
assert.match(schema.function.parameters.properties.vision.description, /false/, "unknown image support should have a conservative fallback");
assert.deepEqual(
  schema.function.parameters.properties.codexReasoningEffort.enum,
  ["low", "medium", "high", "xhigh", "max"],
  "Codex reasoning options should match the request protocol",
);
assert.match(schema.function.parameters.properties.codexReasoningEffort.description, /默认 medium/);
assert.equal(schema.function.parameters.properties.codexReasoningEffort.enum.includes("ultra"), false);
assert.equal(schema.function.parameters.properties.action.enum.includes("add_guardrail"), false, "manage_settings should not expose guardrail actions");
assert.equal(Object.prototype.hasOwnProperty.call(schema.function.parameters.properties, "securityGuardrails"), false, "manage_settings should not expose guardrail snapshots");

const guardrailSchema = loadedSchemas.find(item => item.function?.name === MANAGEMENT_GUARDRAILS_TOOL);
assert.ok(guardrailSchema, "qingzhou-management should expose guardrails after load_skill");
assert.ok(guardrailSchema.function.parameters.properties.action.enum.includes("add_rule"), "manage_guardrails should expose access rules");
assert.ok(guardrailSchema.function.parameters.properties.action.enum.includes("add_rate_limit"), "manage_guardrails should expose rate limits");
assert.ok(Object.prototype.hasOwnProperty.call(guardrailSchema.function.parameters.properties, "minOpenIntervalSeconds"), "rate-limit interval should be seconds-facing");
assert.equal(Object.prototype.hasOwnProperty.call(guardrailSchema.function.parameters.properties, "minOpenIntervalMs"), false, "rate-limit interval should not expose milliseconds");

const skillSettingsSchema = loadedSchemas.find(item => item.function?.name === MANAGEMENT_SKILL_SETTINGS_TOOL);
assert.ok(skillSettingsSchema, "qingzhou-management should expose Skill settings after load_skill");
assert.deepEqual(skillSettingsSchema.function.parameters.properties.action.enum, ["list", "get", "update"]);
assert.equal(skillSettingsSchema.function.parameters.properties.settingId.type, "string");
assert.equal(skillSettingsSchema.function.parameters.properties.values.type, "object");
assert.equal(Object.prototype.hasOwnProperty.call(skillSettingsSchema.function.parameters, "anyOf"), false, "Skill settings schema should stay provider-friendly");

const skillSettingsList = await tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
  timeout: 30,
  action: "list",
}, null, loadedManagementContext);
assert.equal(skillSettingsList.count, 1);
assert.equal(skillSettingsList.settings[0].id, "warehouse-query::example-warehouse");
assert.equal(skillSettingsList.settings[0].configured, true);
assert.equal(Object.prototype.hasOwnProperty.call(skillSettingsList.settings[0], "fields"), false, "list should return compact summaries");
assert.equal(stringify(skillSettingsList).includes(initialSkillSecret), false, "list should not expose saved secrets");

const skillSettingsGet = await tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
  timeout: 30,
  action: "get",
  settingId: skillSettingsList.settings[0].id,
}, null, loadedManagementContext);
const skillSecretField = skillSettingsGet.setting.fields.find(field => field.key === "secretAccessKey");
assert.equal(skillSettingsGet.setting.fields.find(field => field.key === "project")?.value, "analytics_dev");
assert.equal(skillSecretField.hasValue, true);
assert.equal(Object.prototype.hasOwnProperty.call(skillSecretField, "value"), false, "secret reads should expose only hasValue");
assert.equal(stringify(skillSettingsGet).includes(initialSkillSecret), false, "get should not expose saved secrets");

const skillSettingsUpdate = await tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
  timeout: 30,
  action: "update",
  settingId: skillSettingsList.settings[0].id,
  values: { project: "analytics_v2" },
}, null, loadedManagementContext);
assert.equal(skillSettingsUpdate.saved, true);
assert.deepEqual(skillSettingsUpdate.changedFields, ["project"]);
assert.equal(skillSettingsUpdate.setting.fields.find(field => field.key === "project")?.value, "analytics_v2");
assert.equal(stringify(skillSettingsUpdate).includes(initialSkillSecret), false, "update results should not expose preserved secrets");
let executionConfig = await skillSettings.getExecutionConfig(skillSettingsPlugin, { includeSecrets: true });
assert.equal(executionConfig.secretAccessKey, initialSkillSecret, "partial updates should preserve omitted secrets");

const replacementSkillSecret = "warehouse-secret-replacement";
const skillSecretUpdate = await tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
  timeout: 30,
  action: "update",
  settingId: skillSettingsList.settings[0].id,
  values: { secretAccessKey: replacementSkillSecret },
}, null, loadedManagementContext);
assert.equal(skillSecretUpdate.setting.fields.find(field => field.key === "secretAccessKey")?.hasValue, true);
assert.equal(stringify(skillSecretUpdate).includes(replacementSkillSecret), false, "new secrets should not be echoed in results");
executionConfig = await skillSettings.getExecutionConfig(skillSettingsPlugin, { includeSecrets: true });
assert.equal(executionConfig.secretAccessKey, replacementSkillSecret, "secret updates should reach the shared Skill settings service");
const skillSettingsEvent = toolEvents.find(event => (
  event.type === "skill_settings_changed"
  && event.settingId === skillSettingsList.settings[0].id
  && event.changedFields.includes("project")
));
assert.ok(skillSettingsEvent, "Skill settings updates should notify the settings UI");

await assert.rejects(
  () => tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
    timeout: 30,
    action: "get",
    settingId: "missing::setting",
  }, null, loadedManagementContext),
  err => err?.code === "SKILL_SETTINGS_NOT_FOUND",
);
await assert.rejects(
  () => tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
    timeout: 30,
    action: "update",
    settingId: skillSettingsList.settings[0].id,
    values: {},
  }, null, loadedManagementContext),
  err => err?.code === "MISSING_SKILL_SETTINGS_UPDATE",
);
const skillSettingsEventCountBeforeFailure = toolEvents.filter(event => event.type === "skill_settings_changed").length;
await assert.rejects(
  () => tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
    timeout: 30,
    action: "update",
    settingId: skillSettingsList.settings[0].id,
    values: { unknownField: "value" },
  }, null, loadedManagementContext),
  err => err?.code === "SKILL_SETTING_UNKNOWN",
);
await assert.rejects(
  () => tools.executeTool(MANAGEMENT_SKILL_SETTINGS_TOOL, {
    timeout: 30,
    action: "update",
    settingId: skillSettingsList.settings[0].id,
    values: { project: { value: "must-not-be-stringified" } },
  }, null, loadedManagementContext),
  err => err?.code === "SKILL_SETTING_VALUE_INVALID" && err?.details?.field === "project",
);
assert.equal(
  toolEvents.filter(event => event.type === "skill_settings_changed").length,
  skillSettingsEventCountBeforeFailure,
  "failed Skill settings writes should not publish change events",
);

const runtimeWithoutSkillSettings = toolsModule.createToolRuntime();
await assert.rejects(
  () => runtimeWithoutSkillSettings.execute("manage_skill_settings", { action: "list" }, null, { source: "test" }),
  err => err?.code === "SKILL_SETTINGS_UNAVAILABLE",
);

const acceptedSettingsEvents = [];
const sidepanelEventRouter = sidepanelEvents.createSidepanelEventRouter({
  switchToSession() {},
  onEvent: event => acceptedSettingsEvents.push(event),
});
sidepanelEventRouter.handle({ type: "skill_settings_changed", settingId: skillSettingsList.settings[0].id });
assert.deepEqual(acceptedSettingsEvents, [{ type: "skill_settings_changed", settingId: skillSettingsList.settings[0].id }],
  "Skill settings changes should reach the public accepted-event channel exactly once");
const settingsUiSource = readFileSync(new URL("../../src/capabilities/settings/ui.ts", import.meta.url), "utf8");
assert.match(settingsUiSource, /qz\.on\("\*", event =>[\s\S]*case "skill_settings_changed":\s*void settings\.refreshSkillSettings\(\{ silent: true \}\)/,
  "the Settings contribution owns silent refresh of its open projection after an accepted change");

const secret = "sk-test-secret-value";
const updateResult = await tools.executeTool(MANAGEMENT_SETTINGS_TOOL, {
  timeout: 30,
  action: "update_config",
  provider: "custom",
  apiKey: secret,
  model: "router-model",
  modelParameters: {
    reasoning_effort: "high",
    temperature: 0.2,
  },
  customProtocol: "openai",
  customEndpoint: "https://router.example/v1/chat/completions",
  customPresetName: "Router",
  contextWindow: 128000,
  vision: true,
  requestRateLimit: false,
  debugMode: true,
}, null, loadedManagementContext);

assert.equal(updateResult.config.provider, "custom");
assert.equal(updateResult.config.debugMode, true);
assert.equal(updateResult.config.requestRateLimit, false);
assert.deepEqual(updateResult.config.modelParameters, { reasoning_effort: "high", temperature: 0.2 });
assert.deepEqual(updateResult.config.presets[0].modelParameters, updateResult.config.modelParameters);
assert.equal(updateResult.config.hasApiKey, true);
assert.equal(updateResult.config.providerApiKeyProviders.includes("custom"), true);
assert.equal(updateResult.config.presets[0].hasApiKey, true);
assert.equal(updateResult.config.apiKey, secret);
assert.equal(updateResult.config.providerApiKeys.custom, secret);
assert.equal(updateResult.config.presets.find(preset => preset.id === updateResult.config.activePresetId)?.apiKey, secret);
assert.equal(getToolResultPresentation(updateResult)._plugin.id, "qingzhou-management");
assert.equal(getToolResultPresentation(updateResult)._plugin.runtime, "host");
assert.equal(stringify(updateResult).includes(secret), true, "update result should preserve apiKey like any other field");
assert.equal(Object.prototype.hasOwnProperty.call(updateResult, "trace"), false, "management results should not expose host trace");
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, secret, "runtime config should receive the real secret internally");
const configEvent = toolEvents.find(event => event.type === "config" && event.source === "manage_settings");
assert.ok(configEvent, "manage_settings update_config should broadcast a config event for the UI");
assert.equal(configEvent.config.debugMode, true, "config event should carry advanced settings updates");
assert.equal(configEvent.config.requestRateLimit, false, "config event should carry the request-limit switch");
assert.equal(configEvent.config.apiKey, secret, "UI config event may carry the real secret for the local settings input");

const getResult = await tools.executeTool("manage_settings", { action: "get" }, null, { source: "test" });
assert.equal(getResult.config.hasApiKey, true);
assert.equal(getResult.config.apiKey, secret);
assert.equal(getResult.config.providerApiKeys.custom, secret);
assert.equal(getResult.config.requestRateLimit, false);
assert.deepEqual(getResult.config.modelParameters, { reasoning_effort: "high", temperature: 0.2 });
assert.ok(getResult.providers.some(provider => provider.id === "moonshotai"), "Kimi moonshot provider should be discoverable");
assert.ok(getResult.providers.some(provider => provider.id === "kimicode"), "KimiCode provider should be discoverable");

// Exercise the public Skill host with the real provider registry and capability matcher.
// Restore this fixture's state so the independent guardrail scenarios keep their baseline.
{
  const storedBefore = structuredClone(storageData);
  const runtimeBefore = runtimeConfig.getCurrentRuntimeConfigSnapshot();
  const eventsBefore = toolEvents.length;
  const requestsBefore = fetchCalls.length;
  const fetchBefore = globalThis.fetch;
  const manage = input => tools.executeTool(MANAGEMENT_SETTINGS_TOOL, {
    timeout: 30,
    ...input,
  }, null, loadedManagementContext);
  try {
    const sdkRequestsBefore = fetchCalls.filter(call => call.url.includes("models.dev")).length;
    const alias = await manage({
      action: "update_config", provider: "opencodego", model: "glm-5.2",
      apiKey: "test-alias-key",
    });
    assert.equal(alias.config.provider, "opencodego", "the saved provider identity must retain its existing alias");
    assert.equal(alias.config.contextWindow, 1000000, "OpenCode Go should resolve the SDK's opencode-go entry");
    assert.equal(alias.config.vision, false);
    assert.equal(getToolResultPresentation(alias)._plugin.runtime, "host");
    assert.equal(fetchCalls.filter(call => call.url.includes("models.dev")).length, sdkRequestsBefore,
      "known alias metadata must not trigger an online catalog refresh");

    const offlineRequests = [];
    globalThis.fetch = async url => {
      offlineRequests.push(String(url));
      throw new TypeError("All network access is disabled for this Skill host scenario");
    };
    const directory = await manage({ action: "get" });
    assert.ok(directory.providers.length > 100, "the management tool must expose the full usable offline provider directory");
    const groups = [...new Map(directory.providers.map(provider => [provider.group.id, provider.group])).values()]
      .sort((a, b) => b.priority - a.priority);
    assert.deepEqual(groups.map(group => group.id), directory.providers.some(provider => provider.group.id === "preferred")
      ? ["preferred", "custom", "all"] : ["custom", "all"]);
    assert.equal(directory.providers.find(provider => provider.id === "custom")?.group.id, "custom");
    const openrouter = directory.providers.find(provider => provider.id === "openrouter");
    assert.equal(openrouter.group.id, "all");
    assert.equal(openrouter.endpoint, "https://openrouter.ai/api/v1/chat/completions");
    const { listProviderSummaries } = await import("../../src/background/llm/provider-catalog.js");
    assert.deepEqual(directory.providers, listProviderSummaries(), "the management tool preserves provider grouping and endpoint visibility");

    const available = await manage({ action: "list_models", provider: "openrouter", limit: 1000 });
    assert.equal(available.provider, "openrouter");
    assert.ok(available.models.some(model => model.id === "openai/gpt-4.1"), "model suggestions must come from the offline SDK snapshot");
    assert.ok(available.count > 100);

    const switched = await manage({
      action: "update_config", provider: "openrouter", model: "openai/gpt-4.1",
      apiKey: "test-skill-host-key",
    });
    assert.equal(switched.config.provider, "openrouter");
    assert.equal(switched.config.contextWindow, 1047576, "switching to an SDK-only provider must replace the old model's context window");
    assert.equal(switched.config.vision, true, "switching must replace the old text-only capability");
    assert.equal(getToolResultPresentation(switched)._plugin.runtime, "host");
    assert.deepEqual(switched.config.modelParameters, {});

    const contextOnly = await manage({
      action: "update_config", model: "openai/gpt-4o", contextWindow: 32000,
    });
    assert.equal(contextOnly.config.contextWindow, 32000, "an explicit context window overrides the SDK default");
    assert.equal(contextOnly.config.vision, true, "omitted vision must still use the SDK default");

    const visionOnly = await manage({
      action: "update_config", model: "openai/gpt-4.1-mini", vision: false,
    });
    assert.equal(visionOnly.config.contextWindow, 1047576, "omitted context must not inherit the previous override");
    assert.equal(visionOnly.config.vision, false, "explicit false must not be replaced by SDK image support");

    const bothExplicit = await manage({
      action: "update_config", model: "openai/gpt-4.1", contextWindow: 65536, vision: false,
    });
    assert.equal(bothExplicit.config.contextWindow, 65536);
    assert.equal(bothExplicit.config.vision, false);
    const savedPresetId = bothExplicit.config.activePresetId;
    const parametersOnly = await manage({
      action: "update_config", provider: "openrouter", model: "openai/gpt-4.1",
      modelParameters: { temperature: 0.3 }, requestRateLimit: true,
    });
    assert.equal(parametersOnly.config.contextWindow, 65536, "same-model edits must preserve the saved context override");
    assert.equal(parametersOnly.config.vision, false, "same-model edits must preserve the saved vision override");
    assert.deepEqual(parametersOnly.config.modelParameters, { temperature: 0.3 });
    assert.equal(parametersOnly.config.activePresetId, savedPresetId, "editing the model must upsert its existing preset");

    const otherModel = await manage({ action: "update_config", model: "openai/gpt-4o" });
    assert.equal(otherModel.config.contextWindow, 128000);
    assert.equal(otherModel.config.vision, true);
    const restored = await manage({ action: "apply_preset", presetId: savedPresetId });
    assert.equal(restored.applied, true);
    assert.equal(restored.config.model, "openai/gpt-4.1");
    assert.equal(restored.config.contextWindow, 65536, "applying a preset must restore its saved override instead of re-matching SDK defaults");
    assert.equal(restored.config.vision, false);
    assert.deepEqual(restored.config.modelParameters, { temperature: 0.3 });
    assert.equal(restored.config.apiKey, "test-skill-host-key");
    assert.equal(restored.config.requestRateLimit, true);
    const persisted = await manage({ action: "get", includeProviders: false });
    assert.equal(persisted.config.activePresetId, savedPresetId);
    assert.equal(persisted.config.contextWindow, 65536);
    assert.equal(persisted.config.vision, false);
    assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().contextWindow, 65536);
    assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().vision, false);
    assert.deepEqual(offlineRequests, [], "offline discovery, model switching, overrides and preset application must issue zero network requests");
  } finally {
    globalThis.fetch = fetchBefore;
    for (const key of Object.keys(storageData)) delete storageData[key];
    Object.assign(storageData, storedBefore);
    if (runtimeBefore) runtimeConfig.setCurrentRuntimeConfig(runtimeBefore);
    else runtimeConfig.invalidateCurrentRuntimeConfig();
    toolEvents.length = eventsBefore;
    fetchCalls.length = requestsBefore;
  }
}

const textCapabilityResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "bailian",
  apiKey: "test-text-model-key",
  model: "deepseek-v4-pro",
}, null, { source: "test" });
assert.equal(textCapabilityResult.config.contextWindow, 1_000_000, "Text model should expose its 1M context window to Agent-driven settings");
assert.equal(textCapabilityResult.config.vision, false, "Text model should expose text-only input support to Agent-driven settings");
assert.deepEqual(textCapabilityResult.config.modelParameters, {}, "switching providers should not carry model-specific parameters forward");

const zhipuSecret = "sk-zhipu-secret";
const capabilityResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "zhipuai",
  apiKey: zhipuSecret,
  model: "GLM-5V-Turbo",
  modelParameters: { thinking: { type: "enabled" } },
}, null, { source: "test" });
assert.equal(capabilityResult.config.provider, "zhipuai");
assert.equal(capabilityResult.config.model, "GLM-5V-Turbo");
assert.equal(capabilityResult.config.contextWindow, 200000, "model changes should prefer the SDK context window over the older official value");
assert.equal(capabilityResult.config.vision, true, "model changes should auto-fill default vision capability");
assert.equal(capabilityResult.config.apiKey, zhipuSecret);
assert.equal(capabilityResult.config.providerApiKeys.zhipuai, zhipuSecret);
assert.deepEqual(capabilityResult.config.modelParameters, { thinking: { type: "enabled" } });
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, zhipuSecret, "capability update should store the target provider secret internally");

const rateLimitOnlyResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  requestRateLimit: true,
}, null, { source: "test" });
assert.equal(rateLimitOnlyResult.config.provider, "zhipuai", "rate-limit recovery should keep the current provider");
assert.equal(rateLimitOnlyResult.config.model, "GLM-5V-Turbo", "rate-limit recovery should keep the current model");
assert.equal(rateLimitOnlyResult.config.contextWindow, 200000, "rate-limit recovery should keep the current context window");
assert.equal(rateLimitOnlyResult.config.vision, true, "rate-limit recovery should keep the current vision setting");
assert.equal(rateLimitOnlyResult.config.requestRateLimit, true, "rate-limit recovery should enable the global request-limit setting");
assert.deepEqual(rateLimitOnlyResult.config.modelParameters, { thinking: { type: "enabled" } }, "unrelated settings updates should preserve model parameters");
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, zhipuSecret, "rate-limit recovery should keep the current provider secret");

const redundantProviderResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "zhipuai",
  model: "GLM-5V-Turbo",
  debugMode: true,
}, null, { source: "test" });
assert.equal(redundantProviderResult.config.model, "GLM-5V-Turbo", "redundant same-provider updates should not clear the model");
assert.equal(redundantProviderResult.config.contextWindow, 200000, "redundant same-provider updates should keep existing context window");
assert.deepEqual(redundantProviderResult.config.modelParameters, { thinking: { type: "enabled" } }, "repeating the same provider/model should preserve its parameters");
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, zhipuSecret, "redundant same-provider updates should keep the provider secret");

const explicitCapabilityResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  model: "GLM-5",
  contextWindow: 123456,
  vision: true,
}, null, { source: "test" });
assert.equal(explicitCapabilityResult.config.contextWindow, 123456, "explicit contextWindow should override model defaults");
assert.equal(explicitCapabilityResult.config.vision, true, "explicit vision should override model defaults");
assert.deepEqual(explicitCapabilityResult.config.modelParameters, {}, "changing models should start with empty model parameters unless explicitly supplied");
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, zhipuSecret, "same-provider model updates without apiKey should preserve the provider secret");

const zhipuPresetId = capabilityResult.config.activePresetId;

await assert.rejects(
  () => tools.executeTool("manage_settings", {
    action: "update_config",
    provider: "opencodego",
    apiKey: "sk-opencode-secret",
    model: "unknown-model-without-capabilities",
  }, null, { source: "test" }),
  err => err?.code === "MODEL_CAPABILITIES_REQUIRED"
    && err?.details?.provider === "opencodego"
    && err?.details?.model === "unknown-model-without-capabilities"
    && JSON.stringify(err?.details?.missingFields) === JSON.stringify(["contextWindow"]),
  "unknown models should require an explicit context window instead of silently falling back",
);
assert.equal((await tools.executeTool("manage_settings", {
  action: "get",
}, null, { source: "test" })).config.provider, "zhipuai", "failed context validation must not mutate the active configuration");

const explicitUnknownContextResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "opencodego",
  apiKey: "sk-opencode-secret",
  model: "unknown-model-without-capabilities",
  contextWindow: 262144,
}, null, { source: "test" });
assert.equal(explicitUnknownContextResult.config.contextWindow, 262144);
assert.equal(explicitUnknownContextResult.config.vision, false, "unknown image support should conservatively default to false");

const sameUnknownModelUpdateResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "opencodego",
  model: "unknown-model-without-capabilities",
  modelParameters: { thinking: { type: "disabled" } },
}, null, { source: "test" });
assert.equal(sameUnknownModelUpdateResult.config.contextWindow, 262144, "updating the current model should preserve its saved context window");
assert.equal(sameUnknownModelUpdateResult.config.vision, false, "updating the current model should preserve its saved vision capability");
assert.deepEqual(
  sameUnknownModelUpdateResult.config.modelParameters,
  { thinking: { type: "disabled" } },
  "repeating an unlisted current model identity should still allow model-parameter updates",
);

const dynamicCapabilityResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "opencodego",
  apiKey: "sk-opencode-secret",
  model: "glm-5.2",
}, null, { source: "test" });
assert.equal(dynamicCapabilityResult.config.provider, "opencodego");
assert.equal(dynamicCapabilityResult.config.model, "glm-5.2");
assert.equal(dynamicCapabilityResult.config.contextWindow, 1000000, "the offline SDK snapshot should auto-fill context window");
assert.equal(dynamicCapabilityResult.config.vision, false, "models.dev capability matches should auto-fill vision");

const rememberedProviderResult = await tools.executeTool("manage_settings", {
  action: "update_config",
  provider: "zhipuai",
  model: "GLM-5V-Turbo",
}, null, { source: "test" });
assert.equal(rememberedProviderResult.config.provider, "zhipuai");
assert.equal(rememberedProviderResult.config.hasCurrentProviderApiKey, true);
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, zhipuSecret, "provider switches without apiKey should use only the target provider remembered secret");
assert.equal(rememberedProviderResult.config.apiKey, zhipuSecret);

const applyPresetResult = await tools.executeTool("manage_settings", {
  action: "apply_preset",
  presetId: zhipuPresetId,
}, null, { source: "test" });
assert.equal(applyPresetResult.config.provider, "zhipuai");
assert.equal(applyPresetResult.config.model, "GLM-5V-Turbo");
assert.equal(applyPresetResult.config.contextWindow, 200000);
assert.equal(applyPresetResult.config.vision, true);
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().apiKey, zhipuSecret, "apply_preset should restore the preset provider secret internally");
assert.equal(applyPresetResult.config.apiKey, zhipuSecret);
assert.equal(applyPresetResult.applied, true);
assert.equal(Object.hasOwn(applyPresetResult, "deleted"), false);

const modelResult = await tools.executeTool("manage_settings", {
  action: "list_models",
  provider: "kimicode",
  apiKey: "sk-list-secret",
  limit: 5,
}, null, { source: "test" });
assert.equal(modelResult.provider, "kimicode");

const addDomain = await tools.executeTool(MANAGEMENT_GUARDRAILS_TOOL, {
  timeout: 30,
  action: "add_rule",
  ruleAction: "block",
  targetType: "domain",
  target: "Example.com",
}, null, loadedManagementContext);
assert.equal(addDomain.saved, true);
assert.deepEqual(addDomain.securityGuardrails.blockedDomains.map(item => item.domain), ["example.com"]);
const guardrailConfigEvent = toolEvents.find(event => (
  event.type === "config"
  && event.source === "manage_guardrails"
  && event.config?.securityGuardrails?.blockedDomains?.some(item => item.domain === "example.com")
));
assert.ok(guardrailConfigEvent, "manage_guardrails changes should broadcast a config event for the UI");

const duplicateDomain = await tools.executeTool("manage_guardrails", {
  action: "add_rule",
  ruleAction: "block",
  targetType: "domain",
  target: "example.com",
}, null, { source: "test" });
assert.equal(duplicateDomain.existed, true, "duplicate guardrail should not be inserted twice");

const addPattern = await tools.executeTool("manage_guardrails", {
  action: "add_rule",
  ruleAction: "block",
  targetType: "pattern",
  target: "Example.org/private/*",
}, null, { source: "test" });
assert.equal(addPattern.securityGuardrails.blockedPatterns[0].pattern, "*://example.org/private/*");

const removeDomain = await tools.executeTool("manage_guardrails", {
  action: "remove_rule",
  targetType: "domain",
  target: "example.com",
}, null, { source: "test" });
assert.equal(removeDomain.removed, 1);
assert.deepEqual(removeDomain.securityGuardrails.blockedDomains, []);

const addRateLimit = await tools.executeTool("manage_guardrails", {
  action: "add_rate_limit",
  id: "rate-hn",
  targetType: "domain",
  target: "News.YCombinator.com",
  minOpenIntervalSeconds: 3,
}, null, { source: "test" });
assert.equal(addRateLimit.securityGuardrails.siteOpenRateLimits[0].value, "news.ycombinator.com");
assert.equal(addRateLimit.securityGuardrails.siteOpenRateLimits[0].minOpenIntervalMs, 3000);

const addBlockExample = await tools.executeTool("manage_guardrails", {
  action: "add_rule",
  id: "block-example",
  ruleAction: "block",
  targetType: "domain",
  target: "blocked.example.com",
}, null, { source: "test" });
assert.equal(addBlockExample.saved, true);

const reorderGuardrails = await tools.executeTool("manage_guardrails", {
  action: "reorder",
  order: ["rate-hn", "block-example"],
}, null, { source: "test" });
assert.deepEqual(reorderGuardrails.securityGuardrails.order.slice(0, 2), ["rate-hn", "block-example"]);

const getGuardrailsWithRateLimit = await tools.executeTool("manage_guardrails", { action: "get" }, null, { source: "test" });
assert.equal(getGuardrailsWithRateLimit.securityGuardrails.siteOpenRateLimits[0].value, "news.ycombinator.com");
assert.deepEqual(getGuardrailsWithRateLimit.securityGuardrails.order.slice(0, 2), ["rate-hn", "block-example"]);

const addAfterRateLimit = await tools.executeTool("manage_guardrails", {
  action: "add_rule",
  ruleAction: "block",
  targetType: "domain",
  target: "another.example.com",
}, null, { source: "test" });
assert.equal(addAfterRateLimit.securityGuardrails.siteOpenRateLimits[0].value, "news.ycombinator.com");

const removeAfterRateLimit = await tools.executeTool("manage_guardrails", {
  action: "remove_rule",
  targetType: "domain",
  target: "another.example.com",
}, null, { source: "test" });
assert.equal(removeAfterRateLimit.securityGuardrails.siteOpenRateLimits[0].value, "news.ycombinator.com");

await assert.rejects(tools.executeTool("manage_settings", { action: "delete_preset" }, null, { source: "test" }), { code: "MISSING_REQUIRED_ARGUMENTS" });
const deletePresetResult = await tools.executeTool("manage_settings", {
  action: "delete_preset", presetId: zhipuPresetId,
}, null, { source: "test" });
assert.equal(deletePresetResult.deleted, true);
assert.equal(Object.hasOwn(deletePresetResult, "applied"), false);
assert.equal(deletePresetResult.config.presets.some(preset => preset.id === zhipuPresetId), false);
assert.equal(runtimeConfig.getCurrentRuntimeConfigSnapshot().presets.some(preset => preset.id === zhipuPresetId), false);

assert.match(prompts.SYSTEM_PROMPT, /用户可以通过对话管理轻舟自身/, "kernel prompt should preserve Qingzhou self-management");
assert.match(prompts.SYSTEM_PROMPT, /先加载当前可用的配置管理技能/, "kernel prompt should route settings requests through the management skill");
assert.match(prompts.SYSTEM_PROMPT, /模型接口 429\/频率限制/, "kernel prompt should route model rate-limit recovery through the management skill");
assert.match(prompts.SYSTEM_PROMPT, /Skill 配置/, "kernel prompt should route Skill configuration requests through the management skill");
assert.match(prompts.SYSTEM_PROMPT, /轻舟不自行更换模型、修改设置或放宽安全护栏/, "kernel prompt should require an explicit user request");
assert.doesNotMatch(prompts.SYSTEM_PROMPT, /AK\/API Key 只接受本轮明确提供的新值|不得读取、回显、复述/, "kernel prompt should not retain the removed credential policy");
assert.doesNotMatch(prompts.SYSTEM_PROMPT, /manage_settings\.apply_preset/, "preset SOP should move out of the kernel");
assert.match(loadedSkill.content, /只传本次要改变的字段/, "management skill should explain patch-style model updates");
assert.match(loadedSkill.content, /实际切换到不同 provider\/model.*省略 `contextWindow` 与 `vision`.*新模型默认值.*不要复制旧值/, "management skill should leave new capabilities to the matcher instead of copying old values");
assert.match(loadedSkill.content, /models\.dev SDK 离线快照.*本地未命中时才查在线目录/, "management skill should describe offline-first matching");
assert.match(loadedSkill.content, /`MODEL_CAPABILITIES_REQUIRED`[\s\S]*确认 `contextWindow`/, "management skill should explain explicit context-window recovery");
assert.match(loadedSkill.content, /`requestRateLimit`/, "management skill should document the request-limit setting");
assert.match(loadedSkill.content, /只传 `requestRateLimit:true`/, "management skill should define the minimal 429 recovery update");
assert.match(loadedSkill.content, /insufficient_quota/, "management skill should distinguish rate limiting from exhausted quota");
assert.match(loadedSkill.content, /已有目标预设时优先 `apply_preset`/, "management skill should explain preset application");
assert.match(loadedSkill.content, /`modelParameters`/, "management skill should document model-specific request parameters");
assert.match(loadedSkill.content, /思考开关、推理强度、采样和输出限制都属于模型请求参数/, "management skill should define the natural-language boundary of model parameters");
assert.match(loadedSkill.content, /与设置页下拉使用同一份候选数据/, "management skill should explain the shared suggestion source");
for (const suggestion of modelParameters.MODEL_PARAMETER_SUGGESTIONS) {
  assert.ok(loadedSkill.content.includes(`\`${suggestion.key}\``), `management skill should include ${suggestion.key}`);
  for (const value of suggestion.values) {
    assert.ok(loadedSkill.content.includes(`\`${value}\``), `management skill should include ${suggestion.key}=${value}`);
  }
}
assert.doesNotMatch(loadedSkill.content, /## API Key|API Key 只可写入|不复述、不回显/, "management skill should remove the credential-specific policy section");
assert.doesNotMatch(prompts.SYSTEM_PROMPT, /moonshotai（OpenAI 兼容）或 kimicode/, "kernel prompt should avoid hard-coding Kimi provider choices");
assert.doesNotMatch(prompts.SYSTEM_PROMPT, /manage_guardrails\.add_rule/, "guardrail SOP should move out of the kernel");
assert.match(loadedSkill.content, /`add_rate_limit` 和 `minOpenIntervalSeconds`/, "management skill should explain seconds-based rate limits");
assert.match(loadedSkill.content, /读、改 Skill 自带配置统一使用/, "management skill should identify the Skill settings tool as the configuration boundary");

const agentSource = readFileSync(new URL("../../src/background/agent/agent.ts", import.meta.url), "utf8");
const rendererSource = readFileSync(new URL("../../src/capabilities/settings/renderers.ts", import.meta.url), "utf8");
const dataSettingsProfileSource = readFileSync(new URL("../../src/capabilities/settings/data-settings.ts", import.meta.url), "utf8");
const genericResultRendererSource = readFileSync(new URL("../../src/sidepanel/tools/generic-result-renderer.ts", import.meta.url), "utf8");
const toolRuntimeDetailsSource = readFileSync(new URL("../../src/sidepanel/tools/tool-runtime-details.ts", import.meta.url), "utf8");
const timelineRendererSource = readFileSync(new URL("../../src/sidepanel/tools/tool-timeline-renderer.ts", import.meta.url), "utf8");
assert.doesNotMatch(agentSource, /sanitizeAssistantToolCallsForStorage|sanitizeToolArgsForStorage|toolCallMayContainWriteOnlySecrets|sensitiveToolArgText/, "agent should not keep credential-specific tool argument handling");
const streamedArguments = '{"apiKey":"fixture-only-key","model":"example"}';
const streamEvents = [];
const streamAttempt = createStreamAttempt({
  callId: "settings-call", emit: event => streamEvents.push(event), trace() {},
  toolIdentity: () => ({}), toolSpanId: id => `tool:${id}`, indexedToolSpanId: index => `tool:${index}`, usage() {},
});
await streamAttempt.consume((async function* () {
  yield { type: "tool_call_update", index: 0, toolCallId: "settings", toolName: "manage_settings", arguments: streamedArguments };
})());
assert.equal(streamEvents[0].argsText, streamedArguments, "streaming tool arguments should flow into timeline events unchanged");
assert.equal(toolModel.getToolDisplayName("manage_settings"), "管理模型设置");
assert.equal(toolModel.getToolProfileFamily("manage_settings"), "settings");
assert.equal(toolModel.getToolDisplayName("manage_guardrails"), "管理安全护栏");
assert.equal(toolModel.getToolProfileFamily("manage_guardrails"), "settings");
assert.equal(toolModel.getToolDisplayName("manage_skill_settings"), "管理 Skill 配置");
assert.equal(toolModel.getToolProfileFamily("manage_skill_settings"), "settings");
const settingsIdentity = pluginUi.enrichSkillToolIdentity({ name: MANAGEMENT_SETTINGS_TOOL });
const guardrailsIdentity = pluginUi.enrichSkillToolIdentity({ name: MANAGEMENT_GUARDRAILS_TOOL });
const skillSettingsIdentity = pluginUi.enrichSkillToolIdentity({ name: MANAGEMENT_SKILL_SETTINGS_TOOL });
assert.equal(settingsIdentity.capabilityId, "manage_settings");
assert.equal(toolModel.getToolDisplayName(settingsIdentity), "管理模型设置");
assert.equal(toolModel.getToolProfileFamily(settingsIdentity), "settings");
assert.equal(toolModel.getToolResultFamily(settingsIdentity), "settings");
assert.equal(guardrailsIdentity.capabilityId, "manage_guardrails");
assert.equal(toolModel.getToolDisplayName(guardrailsIdentity), "管理安全护栏");
assert.equal(toolModel.getToolProfileFamily(guardrailsIdentity), "settings");
assert.equal(toolModel.getToolResultFamily(guardrailsIdentity), "settings");
assert.equal(skillSettingsIdentity.capabilityId, "manage_skill_settings");
assert.equal(toolModel.getToolDisplayName(skillSettingsIdentity), "管理 Skill 配置");
assert.equal(toolModel.getToolProfileFamily(skillSettingsIdentity), "settings");
assert.equal(toolModel.getToolResultFamily(skillSettingsIdentity), "settings");
assert.match(rendererSource, /"settings":\s*resultProfile\([^\n]+settings\.renderSettings[^\n]+settings\.renderPreparingSettings/, "manage_settings should register the completed and preparing settings renderer");
assert.match(dataSettingsProfileSource, /function appendSettingsProfile/, "settings renderer should render completed results");
assert.match(dataSettingsProfileSource, /function appendPreparingSettingsProfile/, "settings renderer should render preparing state");
assert.doesNotMatch(dataSettingsProfileSource, /appendSlimList\(parent,\s*["']可用服务商["']/, "reading settings should not render the full provider catalog");
assert.match(
  toolRuntimeDetailsSource,
  /rendererId: tool\.rendererId \|\| profileFamily \|\| \(skillPresentation\.resolveSkillToolRenderContext/,
  "capability presentation metadata should select the settings renderer before generic plugin rendering",
);
assert.doesNotMatch(genericResultRendererSource, /isSensitiveDisplayKey|isSensitiveRawDisplayKey|isRedactedDisplayValue/, "generic tool rendering should not special-case credential fields");
assert.match(dataSettingsProfileSource, /apiKey:\s*config\.apiKey[\s\S]*providerApiKeys:\s*config\.providerApiKeys/, "settings results should render credential fields with the rest of the config");
assert.match(dataSettingsProfileSource, /modelParameters:\s*config\.modelParameters/, "settings results should render model parameters with the active model config");
assert.match(timelineRendererSource, /formatToolActionTitle\(toolOrName, args\)/, "timeline should use the shared action labeler");
assert.doesNotMatch(timelineRendererSource, /qingzhou_management__manage_settings/, "timeline should not special-case management runtime names");

console.log("manage settings tool tests passed");
