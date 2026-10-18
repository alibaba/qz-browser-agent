import { loadModelsDevFixture } from "../support/models-dev-fixture.mjs";
import { t } from "../../src/capabilities/settings/i18n.js";
import { assertClassTokens } from "../support/html-contracts.mjs";
import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeModelSuggestionState,
  filterModelOptions,
  groupProviderChoices,
  normalizeModelOptions,
} from "../../src/shared/settings-menu-utils.js";
import { matchConfiguredModelCapabilities } from "../../src/shared/models/model-capabilities.js";
import test from "node:test";
import { getProductDefaultProvider } from '../../src/background/product/providers.js';
import { sampleModels, createResponse, createStreamResponse, storageData, fetchCalls, llm, resetStorage, presetByProviderModel, readProjectFile, readSettingsFeature, extractPresetChangeHandler, extractFunction, setExtraResponse } from '../support/settings-menu-fixture.mjs';

await loadModelsDevFixture();

test("provider groups sort by descending priority, then name; omitted priority is zero", () => {
  const provider = (id, group) => ({ id, label: id, requiresApiKey: true, group });
  const providers = Object.freeze([
    provider("Zulu", { id: "shared", label: "Shared", priority: 10 }),
    provider("Zero", { id: "z", label: "Zulu", priority: 0 }),
    provider("Default", { id: "a", label: "Alpha" }),
    provider("First", { id: "first", label: "First", priority: 100 }),
    provider("Alpha", { id: "shared", label: "Shared", priority: 10 }),
    provider("Last", { id: "last", label: "Last", priority: -1 }),
  ]);
  const groups = groupProviderChoices(providers, "en");
  assert.deepEqual(groups.map(group => group.id), ["first", "shared", "a", "z", "last"]);
  assert.deepEqual(groups[1].providers.map(item => item.id), ["Alpha", "Zulu"]);
  assert.deepEqual(groupProviderChoices([...providers].reverse(), "en"), groups);
  assert.equal(providers[0].id, "Zulu", "projection must not reorder the registry");
});

test("independent packages join one group deterministically; ungrouped and invalid priorities remain usable", () => {
  const providers = [
    { id: "a", label: "Alpha", requiresApiKey: true, group: { id: "shared", label: "Shared" } },
    { id: "b", label: "Beta", requiresApiKey: false, group: { id: "shared", label: "Shared", priority: 5 } },
    { id: "c", label: "Charlie", requiresApiKey: true },
    { id: "d", label: "Delta", requiresApiKey: true, group: { id: "invalid", label: "Invalid", priority: NaN } },
  ];
  const groups = groupProviderChoices(providers, "en");
  assert.deepEqual(groupProviderChoices([...providers].reverse(), "en"), groups);
  assert.deepEqual(groups.map(group => [group.id, group.priority]), [["shared", 5], ["", 0], ["invalid", 0]]);
  assert.equal(groups[0].providers.length, 2);
  assert.deepEqual(groupProviderChoices([], "en"), []);
});

test("model options de-dupe case-insensitively and keep metadata search text", () => {
  assert.deepEqual(sampleModels.map(item => item.id), [
    "gpt-5.4",
    "gpt-5.4-mini",
    "deepseek-chat",
    "moonshot-v1",
  ]);
  assert.equal(filterModelOptions("128k", sampleModels).length, 2);
});

test("Codex reasoning declaration matches the request protocol and defaults to medium", async () => {
  const { listProviderSummaries } = await import("../../src/background/llm/provider-catalog.js");
  const option = listProviderSummaries().find(item => item.id === "openaicodex").modelOptions[0];
  assert.equal(option.key, "codexReasoningEffort");
  assert.equal(option.defaultValue, "medium");
  assert.deepEqual(option.options.map(item => item.value), ["low", "medium", "high", "xhigh", "max"]);
});

test("model options preserve a display label while searching and selecting by either name or id", () => {
  const options = normalizeModelOptions([{
    id: "mode-fixture",
    label: "Example-Model",
    ownedBy: "Example model metadata",
  }]);
  assert.equal(options[0].id, "mode-fixture");
  assert.equal(options[0].label, "Example-Model");
  assert.equal(options[0].meta, "Example model metadata");
  assert.equal(filterModelOptions("Example-Model", options)[0].id, "mode-fixture");
  assert.equal(filterModelOptions("mode-fixture", options)[0].label, "Example-Model");
  assert.equal(computeModelSuggestionState({
    query: "Example-Model",
    options,
  }).exactMatch, true);
});

test("prefix query filters suggestions without hiding the menu", () => {
  const state = computeModelSuggestionState({ query: "gpt-5", options: sampleModels, limit: 8 });
  assert.equal(state.hidden, false);
  assert.equal(state.useAllOptions, false);
  assert.deepEqual(state.visibleOptions.map(item => item.id), ["gpt-5.4", "gpt-5.4-mini"]);
});

test("exact model match stays hidden for automatic open", () => {
  const state = computeModelSuggestionState({ query: "gpt-5.4-mini", options: sampleModels, limit: 8 });
  assert.equal(state.exactMatch, true);
  assert.equal(state.hidden, true);
  assert.deepEqual(state.visibleOptions, []);
});

test("exact model match can be manually expanded into the full list", () => {
  const state = computeModelSuggestionState({
    query: "gpt-5.4-mini",
    options: sampleModels,
    limit: 8,
    showAllOnExactMatch: true,
  });
  assert.equal(state.exactMatch, true);
  assert.equal(state.hidden, false);
  assert.equal(state.useAllOptions, true);
  assert.deepEqual(state.visibleOptions.map(item => item.id), sampleModels.map(item => item.id));
});

test("manual exact-match expansion still obeys the menu limit", () => {
  const state = computeModelSuggestionState({
    query: "gpt-5.4-mini",
    options: sampleModels,
    limit: 2,
    showAllOnExactMatch: true,
  });
  assert.deepEqual(state.visibleOptions.map(item => item.id), ["gpt-5.4", "gpt-5.4-mini"]);
});

test("settings model suggestions render in a viewport popover without growing the settings scroller", () => {
  const html = readProjectFile("src/sidepanel/sidepanel.html") + readProjectFile("src/capabilities/settings/ui.html");
  const settingsFeature = readSettingsFeature();
  const css = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url)) + readProjectFile("src/capabilities/settings/ui.css");

  assert.match(html, /id="cfg-model-options"[^>]*popover="manual"/u);
  assert.match(css, /#cfg-model-options\.qz-combobox-menu\s*\{[^}]*position:\s*fixed;/su);
  assert.match(css, /#cfg-model-options\.qz-combobox-menu\.open-upward\s*\{[^}]*bottom:\s*var\(--model-menu-bottom/su);
  assert.match(settingsFeature, /function positionModelSuggestions\(\)/u);
  assert.match(settingsFeature, /spaceBelow < 144 && spaceAbove > spaceBelow/u);
  assert.match(settingsFeature, /menu\.showPopover\(\)/u);
  assert.match(settingsFeature, /menu\.hidePopover\(\)/u);
});

test("Skill settings are manifest-driven and use conventional credential inputs", () => {
  const html = readProjectFile("src/sidepanel/sidepanel.html") + readProjectFile("src/capabilities/settings/ui.html");
  const settingsFeature = readSettingsFeature();
  const css = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url)) + readProjectFile("src/capabilities/settings/ui.css");

  assert.match(settingsFeature, /id: "skills", title: t\("skills"\), order: 20, visible: hasAvailableSkillSettings/, "the Skill section is registered with conditional visibility");
  assert.match(html, /id="skill-settings-list"/, "the Skill tab should have one manifest-driven card host");
  assert.match(settingsFeature, /request\("list_skill_settings"/, "Skill settings should be read through the Side Panel transport");
  assert.match(settingsFeature, /function syncSkillSettingsTabAvailability\(\)/, "the settings projection should own conditional Skill tab visibility");
  assert.match(settingsFeature, /skillSettingsItems\.length === 1/, "one configurable Skill should render its form directly");
  assert.match(settingsFeature, /function renderSkillSettingsIndex\(\)/, "multiple configurable Skills should use one generic index");
  assert.match(settingsFeature, /SKILL_SETTINGS_SEARCH_THRESHOLD = 6/, "long Skill indexes should gain search without burdening short lists");
  assert.match(settingsFeature, /function returnToSkillSettingsIndex\(\)/, "detail navigation should own its dirty-form guard");
  assert.match(settingsFeature, /request\("save_skill_settings"/, "each Skill card should save through the generic transport");
  assert.match(settingsFeature, /function handleSaveSettings\(context\)[\s\S]*currentSettingsTab === "skills"[\s\S]*saveSkillSettingsCard\(card\)/, "the shared settings save button should dispatch to the active Skill form");
  assert.match(settingsFeature, /function updateSettingsSaveState\(\)[\s\S]*currentSettingsTab === "skills"[\s\S]*updateSkillSettingsSaveState\(\)/, "the shared settings footer should project Skill save state");
  assert.match(settingsFeature, /async function saveSkillSettingsCard\(card\)[\s\S]*if \(saved\)[\s\S]*closeSettingsPanel\(\)/, "saving Skill settings should close the shared settings panel like model saves");
  assert.doesNotMatch(settingsFeature, /data-skill-settings-save|data-skill-settings-delete|deleteSkillSettingsCard|request\("delete_skill_settings"/, "Skill setting cards should not add their own save or clear actions");
  assert.match(settingsFeature, /function renderSkillSettingLayout\(setting, busy\)/, "the generic renderer should own optional section layout");
  assert.match(settingsFeature, /Array\.isArray\(setting\.layout\?\.sections\)/, "section layout should remain manifest-driven");
  assert.match(settingsFeature, /const ungroupedFields = fields\.filter/, "fields omitted from layout should remain visible");
  assert.match(settingsFeature, /const value = String\(field\.value \?\? ""\)/, "manifest values should be rendered through the generic field path");
  assert.match(settingsFeature, /field\.type === "secret" \? "password"/, "secret fields should use the browser's standard masked input");
  assert.match(settingsFeature, /else values\[key\] = field\.value/, "secret values should save through the same path as ordinary text fields");
  assert.doesNotMatch(settingsFeature, /data-skill-setting-clear=/, "the form should not add a special clear-secret checkbox");
  assert.doesNotMatch(settingsFeature, /settingsSaveState\?\.classList\.toggle\("hidden", nextTab === "skills"\)/, "the settings footer should remain shared across all tabs");
  assert.doesNotMatch(settingsFeature, /odps|accessKey|secretAccessKey/i, "the core settings UI must not contain service-specific fields");
  assert.match(css, /\.skill-settings-card\s*\{[\s\S]*var\(--border\)[\s\S]*var\(--radius-md\)/, "Skill cards should reuse Qingzhou design tokens");
  assert.match(css, /\.skill-settings-section\s*\{[\s\S]*var\(--border\)[\s\S]*var\(--radius-sm\)/, "generic sections should reuse Qingzhou surface tokens");
  assert.match(css, /\.settings-tabs\s*\{[^}]*grid-auto-columns:\s*minmax\(max-content, 1fr\)[^}]*overflow-x:\s*auto/, "settings navigation preserves complete labels and scrolls when contributions exceed its width");
  assert.match(css, /\.settings-body\s*\{[\s\S]*padding-right:\s*0/, "Skill cards and tab bar should share the same horizontal bounds");
});

test("compact query can match a model without being treated as literal exact match", () => {
  const state = computeModelSuggestionState({ query: "gpt54mini", options: sampleModels, limit: 8 });
  assert.equal(state.hidden, false);
  assert.deepEqual(state.visibleOptions.map(item => item.id), ["gpt-5.4-mini"]);
});

test("preset selection only stages fields and waits for save", () => {
  const html = readProjectFile("src/sidepanel/sidepanel.html") + readProjectFile("src/capabilities/settings/ui.html");
  const settingsFeature = readSettingsFeature();
  const handler = extractPresetChangeHandler(settingsFeature);
  assert.match(html, /<label class="qz-field-label"[^>]*>当前<\/label>[\s\S]*?<option value=""[^>]*>新配置<\/option>/u, "the settings selector should describe current and newly edited configurations");
  assert.match(settingsFeature, /<option value="">\$\{escapeHtml\(t\("newConfiguration"\)\)\}<\/option>/u, "rerendering presets should preserve the new-configuration label");
  assert.match(handler, /applyPresetToSettingsFields\(preset\)/, "preset selection should fill settings fields");
  assert.match(handler, /updateSettingsSaveState\(\)/, "preset selection should refresh save button state");
  assert.doesNotMatch(handler, /apply_model_preset/, "preset selection should not apply the preset immediately");
  assert.doesNotMatch(handler, /sendMsg\(/, "preset selection should not send background mutations");
});

test("settings security policy lives under advanced and uses one save action", () => {
  const html = readProjectFile("src/sidepanel/sidepanel.html") + readProjectFile("src/capabilities/settings/ui.html");
  const settingsFeature = readSettingsFeature();
  const css = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url)) + readProjectFile("src/capabilities/settings/ui.css");
  const serviceWorker = readProjectFile("src/background/service-worker.js");

  assert.doesNotMatch(html, /settings-tab-security/, "security policy should not be a top-level settings tab");
  assert.doesNotMatch(html, /settings-panel-security/, "security policy should not keep a separate tab panel");
  assert.match(settingsFeature, /id: "advanced", title: t\("advanced"\), order: 30/, "advanced settings contributes a visible section");
  assert.match(
    html,
    /清理多轮之前的工具结果、图片等历史内容，提高上下文利用率。长上下文模型可以关闭以提高缓存命中率。/,
    "hidden context trimming control should keep its compatibility copy",
  );
  assert.match(
    html,
    /<div id="cfg-trim-old-tool-results-field" class="hidden" aria-hidden="true">[\s\S]*?<input id="cfg-trim-old-tool-results" class="qz-checkbox" type="checkbox">[\s\S]*?<\/div>/,
    "context trimming should remain wired but hidden from advanced settings",
  );
  assert.match(
    html,
    /<select id="cfg-context-preset" class="qz-field qz-select context-window-select"[^>]*aria-label="上下文长度"[^>]*><\/select>/,
    "context window presets should render as a compact dropdown",
  );
  assert.match(
    html,
    /<input id="cfg-context-window" type="text" class="[^"]*\bqz-field\b[^"]*\bcontext-window-input\b[^"]*\bhidden\b[^"]*"/,
    "custom context window input should stay collapsed until selected",
  );
  assertClassTokens(html, "context-window-input", ["qz:h-8.5"], "custom context field preserves its 34px control height");
  assert.doesNotMatch(html, /context-window-presets/, "context window settings should not use the old preset button grid");
  assert.doesNotMatch(html, /cfg-context-hint/, "context window hints should not add a separate settings row");
  assert.doesNotMatch(html, /限制 Agent 访问特定站点或 URL。/, "security policy should not spend vertical space on redundant explanatory copy");
  assert.match(html, /<option value="rate_limit"[^>]*>流控<\/option>/, "security policy UI should merge site open rate limits into rule actions");
  assert.match(html, /id="guardrail-rate-limit-interval"/, "security policy UI should expose site open rate-limit interval input");
  assert.match(html, /id="guardrail-rate-limit-interval" type="number"/, "rate-limit interval should use a numeric seconds input");
  assert.match(html, /class="[^"]*\bguardrail-rate-limit-unit\b[^"]*"[^>]*>秒<\/span>/, "rate-limit interval should show an explicit seconds unit");
  assert.doesNotMatch(html, /guardrail-rate-limit-target/, "rate-limit UI should not add a separate target field");
  assert.match(settingsFeature, /normalizeSiteOpenRateLimitInput/, "rate-limit UI should reuse shared security guardrail normalization");

  const renderContextWindowPresets = extractFunction(settingsFeature, "renderContextWindowPresets");
  assert.match(renderContextWindowPresets, /CONTEXT_WINDOW_PRESETS\.filter\(\(?preset\)? => preset\.value\)/, "context window dropdown should only include concrete common values");
  assert.doesNotMatch(renderContextWindowPresets, /自动/, "context window dropdown should not expose a confusing automatic option");

  const handleSaveSettings = extractFunction(settingsFeature, "handleSaveSettings");
  assert.match(
    handleSaveSettings,
    /securityGuardrails:\s*normalizeSecurityGuardrails\(currentSecurityGuardrails\)/,
    "save settings should submit the security policy draft with model settings",
  );

  const snapshot = extractFunction(settingsFeature, "normalizeSettingsConfigSnapshot");
  assert.match(
    snapshot,
    /securityGuardrails:\s*normalizeSecurityGuardrailsSnapshot\(config\.securityGuardrails \|\| currentSecurityGuardrails\)/,
    "settings dirty state should include the security policy snapshot",
  );
  assert.match(settingsFeature, /kind:\s*"site_open_rate_limit"/, "settings dirty state should include site open rate-limit rules");

  const equality = extractFunction(settingsFeature, "settingsSnapshotsEqual");
  assert.match(
    equality,
    /securityGuardrailSnapshotsEqual\(a\.securityGuardrails,\s*b\.securityGuardrails\)/,
    "settings snapshot equality should compare security policy rules",
  );

  // The real get/save runtime's security-policy and catalog projection is covered
  // by test-background-services; the UI contract below owns the single save action.
  assert.match(css, /\.settings-save-status\s*\{[\s\S]*overflow-wrap:\s*anywhere/, "long settings errors should wrap inside the save bar");
  assertClassTokens(html, "settings-save-status", ["qz:grid", "qz:grid-cols-[6px_minmax(0,1fr)]"], "settings status dot should not force a single-line flex layout");
  assertClassTokens(html, "settings-content", ["qz:grid", "qz:grid-rows-[auto_auto_minmax(0,1fr)_auto]", "qz:overflow-hidden"], "settings shell should keep scrolling inside tab content");
  assert.match(css, /\.settings-content\s*\{[\s\S]*border-radius:\s*var\(--radius-lg\)/, "settings shell should clip all four rounded corners consistently");
  assert.match(css, /\.settings-body\s*\{[\s\S]*overflow-y:\s*auto/, "settings tab body should own vertical scrolling");
  assert.match(css, /\.settings-body::-webkit-scrollbar\s*\{[\s\S]*width:\s*4px/, "settings body scrollbar should stay narrow");
  assert.doesNotMatch(css, /context-preset-btn/, "context window preset button styles should not remain");
  assert.match(css, /\.context-window-box\.custom-active\s*\{[\s\S]*grid-template-columns:/, "custom context input should remain in the same compact row");
  assert.doesNotMatch(css, /context-custom-row/, "custom context input should not use a second row wrapper");
});

test("security policy edits are staged locally until save_config", () => {
  const settingsFeature = readSettingsFeature();
  const addBody = extractFunction(settingsFeature, "handleAddGuardrailDomain");
  const removeBody = extractFunction(settingsFeature, "handleRemoveGuardrailDomain");
  const reorderBody = extractFunction(settingsFeature, "persistGuardrailRuleOrder");
  const addRateLimitBody = extractFunction(settingsFeature, "handleAddGuardrailRateLimit");
  const removeRateLimitBody = extractFunction(settingsFeature, "handleRemoveGuardrailRateLimit");

  assert.doesNotMatch(settingsFeature, /addSecurityGuardrailRule/, "settings feature should not import immediate add storage helper");
  assert.doesNotMatch(settingsFeature, /removeSecurityGuardrailRule/, "settings feature should not import immediate remove storage helper");
  assert.doesNotMatch(settingsFeature, /reorderSecurityGuardrailRules/, "settings feature should not import immediate reorder storage helper");
  [addBody, removeBody, reorderBody, addRateLimitBody, removeRateLimitBody].forEach((body) => {
    assert.match(body, /setDraftSecurityGuardrails/, "security edits should update the draft rules");
    assert.match(body, /markSettingsDraftDirty/, "security edits should mark settings dirty");
    assert.doesNotMatch(body, /await\s+/, "security edit handlers should not write storage directly");
  });
  [addBody, removeBody].forEach((body) => {
    assert.match(body, /siteOpenRateLimits:\s*guardrails\.siteOpenRateLimits/, "access-rule edits should preserve site open rate limits");
  });
  assert.match(reorderBody, /rateLimitById/, "reordering configured rules should resolve site open rate limits from the unified order");
  assert.match(addRateLimitBody, /normalizeSiteOpenRateLimitInput/, "rate-limit edits should use shared validation");
  assert.match(addRateLimitBody, /rules:\s*guardrails\.rules/, "adding a rate limit should preserve access rules");
  assert.match(removeRateLimitBody, /rules:\s*guardrails\.rules/, "removing a rate limit should preserve access rules");
  assert.match(reorderBody, /order:\s*orderedIds/, "dragging configured rules should preserve a unified security policy order");
});

test("rate-limit interval editor uses seconds for bare numbers", () => {
  const settingsFeature = readSettingsFeature();
  const body = extractFunction(settingsFeature, "parseGuardrailRateLimitInterval");
  const parse = new Function("t", `${body.replace(/^\{/, "function parseGuardrailRateLimitInterval(value = \"\") {")}; return parseGuardrailRateLimitInterval;`)(t);
  assert.equal(parse("3").value, 3000);
  assert.equal(parse("0.5").value, 500);
  assert.equal(parse("3000ms").value, 3000);
  assert.match(parse("0.1").error, /至少 0\.5 秒/);
});

test("empty config chooses its provider from the current language without persisting it", async () => {
  const originalI18n = chrome.i18n;
  try {
    resetStorage();
    for (const [language, provider] of [["zh-CN", "deepseek"], ["zh-TW", "deepseek"], ["en-US", "openrouter"], ["ja-JP", "openrouter"], ["fr-FR", "openrouter"], ["zh-CN", "deepseek"]]) {
      chrome.i18n = { getUILanguage: () => language };
      const config = await llm.getConfig();
      assert.equal(config.provider, provider, language);
      assert.equal(config.apiKey, "");
      assert.equal(config.model, "");
      assert.equal(config.requestRateLimit, false);
      assert.equal(storageData.llmConfig, undefined, "opening first setup must not persist a provider");
    }
  } finally {
    if (originalI18n === undefined) delete chrome.i18n;
    else chrome.i18n = originalI18n;
    resetStorage();
  }
});

test("language defaults preserve saved providers and incomplete configurations", async () => {
  const originalI18n = chrome.i18n;
  try {
    for (const saved of [
      { provider: "fireworks", model: "saved-model", apiKey: "saved-key" },
      { provider: "deepseek", model: "", apiKey: "" },
      { provider: "openrouter", model: "", apiKey: "" },
      { provider: "custom", model: "", apiKey: "", customEndpoint: "https://saved.example/v1/chat/completions" },
    ]) {
      resetStorage();
      storageData.llmConfig = structuredClone(saved);
      for (const language of ["zh-CN", "en-US"]) {
        chrome.i18n = { getUILanguage: () => language };
        const config = await llm.getConfig();
        assert.equal(config.provider, saved.provider, `${language}: ${saved.provider}`);
        assert.equal(config.model, saved.model);
        assert.equal(config.apiKey, saved.apiKey);
        if (saved.customEndpoint) assert.equal(config.customEndpoint, saved.customEndpoint);
        assert.deepEqual(storageData.llmConfig, saved, "loading configuration must preserve stored settings");
      }
    }
  } finally {
    if (originalI18n === undefined) delete chrome.i18n;
    else chrome.i18n = originalI18n;
    resetStorage();
  }
});

test("unknown saved providers keep their endpoint and credentials instead of using the language default", async () => {
  const originalI18n = chrome.i18n;
  try {
    for (const language of ["zh-CN", "en-US"]) {
      chrome.i18n = { getUILanguage: () => language };
      for (const endpointField of ["customEndpoint", "endpoint"]) {
        resetStorage();
        const saved = {
          provider: "retired-provider",
          apiKey: "synthetic-retired-provider-key",
          model: "saved-model",
          customProtocol: "openai",
          [endpointField]: "https://retired-provider.example/v1/chat/completions",
        };
        storageData.llmConfig = structuredClone(saved);
        const config = await llm.getConfig();
        assert.equal(config.provider, "custom");
        assert.equal(config.apiKey, saved.apiKey);
        assert.equal(config.model, saved.model);
        assert.equal(config.endpoint, saved[endpointField]);
        assert.equal(config.customEndpoint, saved[endpointField]);
        assert.deepEqual(storageData.llmConfig, saved, "reading an unknown provider must not rewrite its stored configuration");
        assert.equal(fetchCalls.length, 0);

        await llm.chat([{ role: "user", content: "hello" }], []);
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].url, saved[endpointField]);
        assert.equal(fetchCalls[0].auth, `Bearer ${saved.apiKey}`);
      }

      resetStorage();
      storageData.llmConfig = { provider: "retired-provider", apiKey: "synthetic-retired-provider-key", model: "saved-model" };
      const config = await llm.getConfig();
      assert.equal(config.provider, "custom");
      assert.equal(config.endpoint, "");
      await assert.rejects(() => llm.saveConfig(config));
      assert.equal(fetchCalls.length, 0, "a missing saved endpoint must not validate credentials against a default service");
    }
  } finally {
    if (originalI18n === undefined) delete chrome.i18n;
    else chrome.i18n = originalI18n;
    resetStorage();
  }
});

test("unknown saved preset providers preserve their credential destination when applied", async () => {
  const originalI18n = chrome.i18n;
  try {
    for (const language of ["zh-CN", "en-US"]) {
      resetStorage();
      chrome.i18n = { getUILanguage: () => language };
      const preset = {
        id: "retired-provider-preset",
        name: "Saved provider",
        provider: "retired-provider",
        apiKey: "synthetic-preset-provider-key",
        model: "preset-model",
        customProtocol: "openai",
        customEndpoint: "https://preset-provider.example/v1/chat/completions",
      };
      const saved = {
        provider: "openrouter", apiKey: "synthetic-openrouter-key", model: "other-model",
        providerApiKeys: { openrouter: "synthetic-openrouter-key", deepseek: "synthetic-deepseek-key" },
        presets: [preset],
      };
      storageData.llmConfig = structuredClone(saved);
      const config = await llm.getConfig();
      assert.equal(config.provider, "openrouter");
      assert.equal(config.presets[0].provider, "custom");
      assert.equal(config.presets[0].apiKey, preset.apiKey);
      assert.equal(config.presets[0].customEndpoint, preset.customEndpoint);
      assert.deepEqual(storageData.llmConfig, saved, "reading an unknown preset must not rewrite it");

      const applied = await llm.applyModelPreset(preset.id);
      assert.equal(applied.provider, "custom");
      assert.equal(applied.apiKey, preset.apiKey);
      assert.equal(applied.model, preset.model);
      assert.equal(applied.endpoint, preset.customEndpoint);
      assert.equal(fetchCalls.length, 0);
      await llm.chat([{ role: "user", content: "hello" }], []);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, preset.customEndpoint);
      assert.equal(fetchCalls[0].auth, `Bearer ${preset.apiKey}`);
    }
  } finally {
    if (originalI18n === undefined) delete chrome.i18n;
    else chrome.i18n = originalI18n;
    resetStorage();
  }
});

test("SDK providers load their model menus offline, including services with runtime policies", async () => {
  for (const provider of ["deepseek", "opencodego", "opencodezen"]) {
    resetStorage();
    const result = await llm.listModels({ provider });
    assert.equal(result.provider, provider);
    assert.ok(result.models.length > 0);
    assert.ok(result.models.every(model => model.id && model.label));
    assert.equal(fetchCalls.length, 0, "model discovery must work without an API key or network access");
  }
});

test("Codex fallback includes Astra first and retains supported older models", async () => {
  resetStorage();
  const result = await llm.listModels({ provider: "openaicodex" });

  assert.deepEqual(result.models.map(model => model.id), [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ]);
  assert.deepEqual(
    result.models.slice(0, 3).map(model => model.ownedBy),
    Array(3).fill("ChatGPT Codex · 272K · image"),
  );
  assert.equal(fetchCalls.length, 0, "missing Codex auth should use the bundled fallback before fetch");
});

test("Codex live model responses sort newest first and exclude the hidden auto-review model", async () => {
  resetStorage();
  storageData.openaiCodexAuth = {
    access: "codex-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };

  const result = await llm.listModels({ provider: "openaicodex" });

  assert.deepEqual(result.models.map(model => model.id), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4"]);
  assert.equal(fetchCalls.length, 1);
});

test("model list failures clear loading and suggestions without disabling manual input", () => {
  const source = readSettingsFeature();
  const start = source.indexOf("async function loadProviderModels");
  const end = source.indexOf("\n  function renderModelOptions", start);
  assert.ok(start >= 0 && end > start, "missing loadProviderModels implementation");
  const body = source.slice(start, end);
  assert.match(
    body,
    /catch \(err\) \{[\s\S]*?modelListLoading = false;[\s\S]*?applyModelOptions\(\[\]\);[\s\S]*?modelInput\.removeAttribute\("title"\);/u,
  );
});

test("settings require a context window when automatic capability matching has no result", () => {
  const source = readSettingsFeature();
  const validation = extractFunction(source, "validateSettingsConfigFields");
  const clearModelFields = extractFunction(source, "clearModelScopedSettings");

  assert.match(validation, /if \(!contextWindow\)[\s\S]*t\("selectAContextLength"\)/u);
  assert.match(clearModelFields, /\$\("#cfg-context-window"\)\.value = ""/u);
  assert.match(clearModelFields, /\$\("#cfg-vision"\)\.value = "false"/u);
  assert.doesNotMatch(validation, /请选择是否支持图片/u);
});

test("runtime preference patches work before model setup and preserve stored model and preset fields", async () => {
  resetStorage();
  const fresh = await llm.saveConfig({ debugMode: true });
  assert.equal(fresh.debugMode, true);
  assert.equal(fresh.model, "");
  assert.equal(storageData.llmConfig.model, "");
  assert.deepEqual(storageData.llmConfig.presets, []);
  assert.equal(storageData.llmConfig.activePresetId, "");
  const freshStored = structuredClone(storageData.llmConfig);
  const rateLimited = await llm.saveConfig({ requestRateLimit: true });
  assert.equal(rateLimited.requestRateLimit, true);
  assert.deepEqual(storageData.llmConfig, { ...freshStored, requestRateLimit: true });
  assert.equal(fetchCalls.length, 0);

  await llm.saveConfig({
    provider: "custom", model: "saved-model", apiKey: "private-key", customEndpoint: "https://model.invalid/v1", customProtocol: "openai",
    modelParameters: { temperature: 0.3 },
    debugMode: true, requestRateLimit: true,
  });
  const raw = structuredClone(storageData.llmConfig);
  await llm.saveConfig({ debugMode: false, requestRateLimit: false });
  assert.deepEqual(storageData.llmConfig, { ...raw, debugMode: false, requestRateLimit: false });
  assert.equal(fetchCalls.length, 0);
});

test("runtime preferences still reject invalid types and mixed invalid model patches without writes", async () => {
  resetStorage();
  storageData.llmConfig = { debugMode: false, requestRateLimit: false };
  for (const patch of [
    { debugMode: "true" }, { requestRateLimit: 1 }, { debugMode: true, requestRateLimit: null },
    { debugMode: true, provider: "custom", customEndpoint: "", model: "" },
  ]) {
    await assert.rejects(llm.saveConfig(patch));
    assert.deepEqual(storageData.llmConfig, { debugMode: false, requestRateLimit: false });
  }
  await assert.rejects(llm.saveModelPreset({ debugMode: true }));
  assert.deepEqual(storageData.llmConfig, { debugMode: false, requestRateLimit: false });
  assert.equal(fetchCalls.length, 0);
});

test("config persistence rejects an explicitly missing or invalid context window", async () => {
  resetStorage();
  const base = {
    provider: "deepseek",
    apiKey: "valid-deepseek",
    model: "unknown-model",
    vision: false,
  };
  await assert.rejects(
    () => llm.saveConfig({ ...base, contextWindow: "" }),
    /请先填写上下文长度/u,
  );
  await assert.rejects(
    () => llm.saveConfig({ ...base, contextWindow: "many" }),
    /上下文长度格式不正确/u,
  );
  const config = await llm.getConfig();
  assert.equal(config.model, "", "failed validation must not persist a partial model configuration");
  assert.equal(fetchCalls.length, 0, "context validation should run before provider network checks");
});

test("Astra uses the Codex 272K image profile instead of the public API context window", async () => {
  resetStorage();
  const match = await matchConfiguredModelCapabilities({ provider: "openaicodex", model: "gpt-6-astra" });
  assert.equal(match.matched, true);
  assert.equal(match.contextWindow, 272000);
  assert.equal(match.maxOutputTokens, 128000);
  assert.equal(match.vision, true);
  assert.equal(fetchCalls.length, 0, "Astra defaults must be available offline");
});

test("GPT-5.6 Codex models use the current multimodal 272K profile", async () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const match = await matchConfiguredModelCapabilities({
      provider: "openaicodex",
      model,
    });
    assert.equal(match.matched, true, model);
    assert.equal(match.contextWindow, 272000, model);
    assert.equal(match.maxOutputTokens, 128 * 1024, model);
    assert.equal(match.vision, true, model);
    assert.equal(match.source, "qz-openai-codex-provider-metadata", model);
  }
});

test("custom OpenAI endpoint saves protocol, endpoint, modality and preset name without model validation", async () => {
  resetStorage();
  const config = await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/chat/completions",
    customPresetName: "Router A",
    contextWindow: "128K",
    vision: true,
  });

  assert.equal(config.provider, "custom");
  assert.equal(config.providerLabel, "自定义接口");
  assert.equal(config.endpoint, "https://router.example/v1/chat/completions");
  assert.equal(config.customProtocol, "openai");
  assert.equal(config.customEndpoint, "https://router.example/v1/chat/completions");
  assert.equal(config.customPresetName, "Router A");
  assert.equal(config.contextWindow, 128000);
  assert.equal(config.vision, true);
  assert.equal(config.providerApiKeys.custom, "custom-openai-key");
  assert.equal(config.presets.length, 1);
  assert.equal(config.presets[0].name, "Router A");
  assert.equal(config.presets[0].customProtocol, "openai");
  assert.equal(config.presets[0].customEndpoint, "https://router.example/v1/chat/completions");
  assert.equal(config.presets[0].customPresetName, "Router A");
  assert.equal(fetchCalls.length, 0);
});

test("custom endpoint prefixes are completed before storage", async () => {
  resetStorage();
  const openai = await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/openai/v1",
  });

  assert.equal(openai.endpoint, "https://router.example/openai/v1/chat/completions");
  assert.equal(openai.customEndpoint, "https://router.example/openai/v1/chat/completions");
  assert.equal(openai.presets[0].customEndpoint, "https://router.example/openai/v1/chat/completions");
  fetchCalls.length = 0;
  assert.equal((await llm.chat([{ role: "user", content: "hello" }], [])).message.content, "openai ok");
  assert.equal(fetchCalls[0].url, "https://router.example/openai/v1/chat/completions");

  const anthropic = await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-anthropic-key",
    model: "claude-compatible",
    customProtocol: "anthropic",
    customEndpoint: "router.example/v1",
  });

  assert.equal(anthropic.endpoint, "https://router.example/v1/messages");
  assert.equal(anthropic.customEndpoint, "https://router.example/v1/messages");
  assert.equal(anthropic.presets.some(preset => preset.customEndpoint === "https://router.example/v1/messages"), true);
  fetchCalls.length = 0;
  assert.equal((await llm.chat([{ role: "user", content: "hello" }], [])).message.content, "anthropic ok");
  assert.equal(fetchCalls[0].url, "https://router.example/v1/messages");
});

test("custom Anthropic endpoint uses messages endpoint and keeps blank preset name blank", async () => {
  resetStorage();
  const config = await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-anthropic-key",
    model: "claude-compatible",
    customProtocol: "anthropic",
    customEndpoint: "https://router.example/v1/messages",
    customPresetName: "",
  });

  assert.equal(config.endpoint, "https://router.example/v1/messages");
  assert.equal(config.customProtocol, "anthropic");
  assert.equal(config.customPresetName, "");
  assert.equal(config.presets.length, 1);
  assert.equal(config.presets[0].name, "自定义接口 · claude-compatible");
  assert.equal(config.presets[0].customPresetName, "");
  assert.equal(fetchCalls.length, 0);
});

test("custom OpenAI chat posts to the configured endpoint", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/chat/completions",
  });
  fetchCalls.length = 0;

  const result = await llm.chat([{ role: "user", content: "hello" }], []);
  const call = fetchCalls[0];
  const body = JSON.parse(call.body);

  assert.equal(result.message.content, "openai ok");
  assert.equal(call.url, "https://router.example/v1/chat/completions");
  assert.equal(call.method, "POST");
  assert.equal(call.auth, "Bearer custom-openai-key");
  assert.equal(body.model, "router-model");
  assert.equal(body.messages[0].content, "hello");
});

test("custom OpenAI chat retries transient provider failures", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/retry-success/chat/completions",
  });
  fetchCalls.length = 0;
  const retries = [];

  const result = await llm.chat([{ role: "user", content: "hello" }], [], undefined, {
    retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
    onRetry: event => retries.push(event),
  });
  const retryCalls = fetchCalls.filter(call => /\/retry-success\/chat\/completions$/.test(call.url));

  assert.equal(result.message.content, "retry ok");
  assert.equal(retryCalls.length, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].status, 503);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].maxRetries, 2);
  assert.match(retries[0].reason, /HTTP 503/);
});

test("custom OpenAI chat does not retry quota errors", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/retry-quota/chat/completions",
  });
  fetchCalls.length = 0;
  const retries = [];

  await assert.rejects(
    () => llm.chat([{ role: "user", content: "hello" }], [], undefined, {
      retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      onRetry: event => retries.push(event),
    }),
    /429|insufficient_quota/,
  );
  const retryCalls = fetchCalls.filter(call => /\/retry-quota\/chat\/completions$/.test(call.url));

  assert.equal(retryCalls.length, 1);
  assert.equal(retries.length, 0);
});

test("custom OpenAI chat does not preflight tool schema names", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/chat/completions",
  });
  fetchCalls.length = 0;

  const schemaResult = await llm.chat(
    [{ role: "user", content: "hello" }],
    [{ type: "function", function: { name: "36kr_tools__36kr_fetch_news", parameters: { type: "object" } } }],
  );
  assert.equal(schemaResult.message.content, "openai ok");
  assert.equal(fetchCalls.length, 1);
  assert.equal(JSON.parse(fetchCalls[0].body).tools[0].function.name, "36kr_tools__36kr_fetch_news");

  const result = await llm.chat(
    [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_bad",
        type: "function",
        function: { name: "36kr_tools__36kr_fetch_news", arguments: "{}" },
      }],
    }],
    [],
  );
  assert.equal(result.message.content, "openai ok");
  assert.equal(fetchCalls.length, 2);
});

test("custom OpenAI chat sends provider-safe tool schema fields only", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/chat/completions",
  });
  fetchCalls.length = 0;

  await llm.chat(
    [
      {
        role: "assistant",
        content: null,
        _spanId: "internal-span",
        tool_calls: [{
          id: "call_plugin",
          type: "function",
          index: 0,
          _qingzhouPlugin: { pluginId: "plugin-a" },
          function: {
            name: "plugin_lookup",
            arguments: { query: "demo" },
            input: { query: "demo" },
          },
        }],
      },
      { role: "tool", tool_call_id: "call_plugin", content: "ok", _trace: true },
      { role: "user", content: "continue" },
    ],
    [{
      type: "function",
      function: {
        name: "plugin_lookup",
        description: "Lookup with a plugin",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        extraFunctionField: "internal",
      },
      _qingzhouPlugin: { pluginId: "plugin-a", skillName: "插件", localName: "lookup" },
      renderer: { type: "grid" },
    }],
  );

  const body = JSON.parse(fetchCalls[0].body);
  assert.deepEqual(Object.keys(body.tools[0]).sort(), ["function", "type"]);
  assert.deepEqual(Object.keys(body.tools[0].function).sort(), ["description", "name", "parameters"]);
  assert.equal(body.tools[0]._qingzhouPlugin, undefined);
  assert.equal(body.tools[0].renderer, undefined);
  assert.equal(body.tools[0].function.extraFunctionField, undefined);
  assert.deepEqual(body.tools[0].function.parameters.properties.query, { type: "string" });

  const toolCall = body.messages[0].tool_calls[0];
  assert.deepEqual(Object.keys(toolCall).sort(), ["function", "id", "type"]);
  assert.deepEqual(Object.keys(toolCall.function).sort(), ["arguments", "name"]);
  assert.equal(toolCall._qingzhouPlugin, undefined);
  assert.equal(toolCall.function.input, undefined);
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { query: "demo" });
});

test("OpenCode Go sends a simple object tool schema to its Go endpoint", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "opencodego",
    apiKey: "opencode-go-key",
    model: "kimi-k2.7-code",
  });
  fetchCalls.length = 0;

  const parameters = {
    type: "object",
    properties: {
      url: { type: "string" },
      target: { type: "string" },
    },
  };

  await llm.chat(
    [{ role: "user", content: "inspect image" }],
    [{ type: "function", function: { name: "read_image", parameters } }],
  );

  const sent = JSON.parse(fetchCalls[0].body).tools[0].function.parameters;
  assert.equal(fetchCalls[0].url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.deepEqual(sent, parameters);
});

test("custom OpenAI chat normalizes object tool arguments", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/tool-object/chat/completions",
  });
  fetchCalls.length = 0;

  const result = await llm.chat([{ role: "user", content: "show data" }], [{ type: "function", function: { name: "data_store", parameters: { type: "object" } } }]);
  const toolCall = result.message.tool_calls[0];
  const args = JSON.parse(toolCall.function.arguments);

  assert.equal(toolCall.function.name, "data_store");
  assert.deepEqual(args, { action: "list", table: "weather" });
});

test("custom OpenAI stream normalizes nonstandard input tool arguments", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/tool-stream/chat/completions",
  });
  fetchCalls.length = 0;

  let doneMessage = null;
  for await (const chunk of llm.chatStream([{ role: "user", content: "schema" }], [{ type: "function", function: { name: "data_store", parameters: { type: "object" } } }])) {
    if (chunk.type === "done") doneMessage = chunk.message;
  }

  const toolCall = doneMessage.tool_calls[0];
  const args = JSON.parse(toolCall.function.arguments);

  assert.equal(toolCall.function.name, "data_store");
  assert.deepEqual(args, { action: "schema", table: "weather" });
});

test("custom OpenAI stream preserves standalone whitespace tool argument fragments", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-openai-key",
    model: "router-model",
    customProtocol: "openai",
    customEndpoint: "https://router.example/v1/tool-whitespace-stream/chat/completions",
  });
  fetchCalls.length = 0;

  const deltas = [];
  let doneMessage = null;
  for await (const chunk of llm.chatStream(
    [{ role: "user", content: "write code" }],
    [{ type: "function", function: { name: "run_script", parameters: { type: "object" } } }],
  )) {
    if (chunk.type === "tool_call_update") deltas.push(chunk.delta);
    if (chunk.type === "done") doneMessage = chunk.message;
  }

  assert.deepEqual(deltas, [
    "{\"source\":\"function demo() {\\n",
    "    ",
    "return",
    " ",
    "0;\\n}\"}",
  ]);
  const args = JSON.parse(doneMessage.tool_calls[0].function.arguments);
  assert.equal(args.source, "function demo() {\n    return 0;\n}");
});

test("custom Anthropic chat posts to the configured messages endpoint", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-anthropic-key",
    model: "claude-compatible",
    customProtocol: "anthropic",
    customEndpoint: "https://router.example/v1/messages",
  });
  fetchCalls.length = 0;

  const result = await llm.chat([{ role: "user", content: "hello" }], []);
  const call = fetchCalls[0];
  const body = JSON.parse(call.body);

  assert.equal(result.message.content, "anthropic ok");
  assert.equal(call.url, "https://router.example/v1/messages");
  assert.equal(call.method, "POST");
  assert.equal(call.auth, "custom-anthropic-key");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(body.model, "claude-compatible");
  assert.equal(body.messages[0].content, "hello");
});

test("custom presets include protocol and endpoint in the upsert key", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-key-a",
    model: "shared-model",
    customProtocol: "openai",
    customEndpoint: "https://router-a.example/v1/chat/completions",
  });
  const config = await llm.saveConfig({
    provider: "custom",
    apiKey: "custom-key-b",
    model: "shared-model",
    customProtocol: "openai",
    customEndpoint: "https://router-b.example/v1/chat/completions",
  });

  assert.equal(config.presets.length, 2);
  assert.deepEqual(
    config.presets.map(preset => preset.customEndpoint).sort(),
    [
      "https://router-a.example/v1/chat/completions",
      "https://router-b.example/v1/chat/completions",
    ],
  );
  assert.equal(fetchCalls.length, 0);
});

test("custom endpoint rejects non-http endpoints before writing", async () => {
  resetStorage();
  await assert.rejects(
    () => llm.saveConfig({
      provider: "custom",
      apiKey: "custom-key",
      model: "router-model",
      customProtocol: "openai",
      customEndpoint: "ftp://router.example/v1/chat/completions",
    }),
    /Endpoint/,
  );
  assert.equal(storageData.llmConfig, undefined);
  assert.equal(fetchCalls.length, 0);
});

test("save_config creates one provider/model preset and remembers provider AK", async () => {
  resetStorage();
  const config = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
    contextWindow: "262K",
    trimOldToolResults: false,
    vision: true,
    requestRateLimit: false,
    debugMode: true,
  });

  assert.equal(config.provider, "fireworks");
  assert.equal(config.apiKey, "valid-fireworks");
  assert.equal(config.providerApiKeys.fireworks, "valid-fireworks");
  assert.equal(config.presets.length, 1);
  assert.equal(config.activePresetId, config.presets[0].id);
  assert.equal(config.presets[0].name, "Fireworks AI · accounts/fireworks/models/model-a");
  assert.equal(config.trimOldToolResults, false);
  assert.equal(config.requestRateLimit, false);
  assert.equal(storageData.llmConfig.requestRateLimit, false);
  assert.equal(config.presets[0].trimOldToolResults, false);
  assert.equal(config.presets[0].vision, true);
  assert.equal(fetchCalls.length, 0, "an SDK catalog must not invent a remote /models credential check");
});

test("save_config skips remote AK validation when model connection is unchanged", async () => {
  resetStorage();
  storageData.llmConfig = {
    provider: "fireworks",
    apiKey: "bad-fireworks",
    model: "accounts/fireworks/models/model-a",
    contextWindow: 262000,
    trimOldToolResults: true,
    vision: false,
    debugMode: false,
    presets: [],
    providerApiKeys: { fireworks: "bad-fireworks" },
  };

  const config = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "bad-fireworks",
    model: "accounts/fireworks/models/model-a",
    contextWindow: "1M",
    trimOldToolResults: false,
  });

  assert.equal(config.provider, "fireworks");
  assert.equal(config.apiKey, "bad-fireworks");
  assert.equal(config.contextWindow, 1000000);
  assert.equal(config.trimOldToolResults, false);
  assert.equal(fetchCalls.length, 0);
});

test("saving the same provider/model overwrites the existing preset", async () => {
  resetStorage();
  const first = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
    contextWindow: "262K",
    vision: true,
  });
  const firstPresetId = first.activePresetId;

  const second = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks-2",
    model: "accounts/fireworks/models/model-a",
    contextWindow: "1M",
    vision: false,
  });

  assert.equal(second.activePresetId, firstPresetId);
  assert.equal(second.presets.length, 1);
  assert.equal(second.providerApiKeys.fireworks, "valid-fireworks-2");
  assert.equal(presetByProviderModel(second, "fireworks", "accounts/fireworks/models/model-a").vision, false);
  assert.equal(presetByProviderModel(second, "fireworks", "accounts/fireworks/models/model-a").contextWindow, 1000000);
});

test("saving a different provider/model keeps previous provider AK memory", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
  });
  const config = await llm.saveConfig({
    provider: "deepseek",
    apiKey: "valid-deepseek",
    model: "deepseek-chat",
  });

  assert.equal(config.provider, "deepseek");
  assert.equal(config.providerApiKeys.fireworks, "valid-fireworks");
  assert.equal(config.providerApiKeys.deepseek, "valid-deepseek");
  assert.equal(config.presets.length, 2);
  assert.ok(presetByProviderModel(config, "fireworks", "accounts/fireworks/models/model-a"));
  assert.ok(presetByProviderModel(config, "deepseek", "deepseek-chat"));
});

test("missing API key rejects an SDK provider save and leaves storage unchanged", async () => {
  resetStorage();
  const before = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
  });
  const storedBefore = JSON.stringify(storageData.llmConfig);

  await assert.rejects(
    () => llm.saveConfig({
      provider: "fireworks",
      apiKey: "",
      model: "accounts/fireworks/models/model-b",
    }),
    /请先填写.*API Key/,
  );

  assert.equal(JSON.stringify(storageData.llmConfig), storedBefore);
  const after = await llm.getConfig();
  assert.equal(after.activePresetId, before.activePresetId);
  assert.equal(after.providerApiKeys.fireworks, "valid-fireworks");
  assert.equal(after.presets.length, 1);
  assert.equal(fetchCalls.length, 0);
});

test("missing model name rejects before writing", async () => {
  resetStorage();
  await assert.rejects(
    () => llm.saveConfig({ provider: "fireworks", apiKey: "valid-fireworks", model: "" }),
    /模型名称/,
  );
  assert.equal(storageData.llmConfig, undefined);
  assert.equal(fetchCalls.length, 0);
});

test("Codex saves without AK and does not write provider AK memory", async () => {
  resetStorage();
  const config = await llm.saveConfig({
    provider: "openaicodex",
    model: "gpt-5.4",
    codexReasoningEffort: "high",
    contextWindow: "272K",
    vision: true,
  });

  assert.equal(config.provider, "openaicodex");
  assert.equal(config.apiKey, "");
  assert.equal(config.codexReasoningEffort, "high");
  assert.equal(config.providerApiKeys.openaicodex, undefined);
  assert.equal(fetchCalls.length, 0);
  assert.equal(config.presets.length, 1);
});

test("Codex defaults missing or unsupported reasoning values to medium", async () => {
  resetStorage();
  const defaulted = await llm.saveConfig({
    provider: "openaicodex",
    model: "gpt-5.6-sol",
    contextWindow: "272K",
    vision: true,
  });
  assert.equal(defaulted.codexReasoningEffort, "medium");

  for (const removed of ["none", "minimal"]) {
    const saved = await llm.saveConfig({
      provider: "openaicodex",
      model: "gpt-5.4",
      codexReasoningEffort: removed,
      contextWindow: "272K",
      vision: true,
    });
    assert.equal(saved.codexReasoningEffort, "medium");
    assert.equal(saved.presets.find(preset => preset.model === "gpt-5.4").codexReasoningEffort, "medium");
  }

  const supported = await llm.saveConfig({
    provider: "openaicodex",
    model: "gpt-5.6-sol",
    codexReasoningEffort: "max",
    contextWindow: "272K",
    vision: true,
  });
  assert.equal(supported.codexReasoningEffort, "max");

  const unsupported = await llm.saveConfig({
    provider: "openaicodex",
    model: "GPT-5.6-LUNA",
    codexReasoningEffort: "ultra",
    contextWindow: "272K",
    vision: true,
  });
  assert.equal(unsupported.codexReasoningEffort, "medium");
});

test("model parameters persist with presets and update the same provider-model preset", async () => {
  resetStorage();
  const first = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
    contextWindow: 128000,
    modelParameters: {
      temperature: 0.2,
      thinking: { type: "enabled", budget_tokens: 4096 },
      parallel_tool_calls: false,
    },
  });
  const presetId = first.activePresetId;
  assert.deepEqual(first.modelParameters, {
    temperature: 0.2,
    thinking: { type: "enabled", budget_tokens: 4096 },
    parallel_tool_calls: false,
  });
  assert.deepEqual(first.presets[0].modelParameters, first.modelParameters);
  assert.deepEqual(storageData.llmConfig.modelParameters, first.modelParameters);

  const updated = await llm.saveConfig({
    modelParameters: {
      reasoning_effort: "high",
      max_tokens: 8192,
    },
  });
  assert.equal(updated.activePresetId, presetId);
  assert.equal(updated.presets.length, 1);
  assert.deepEqual(updated.modelParameters, { reasoning_effort: "high", max_tokens: 8192 });
  assert.deepEqual(updated.presets[0].modelParameters, updated.modelParameters);

  const applied = await llm.applyModelPreset(presetId);
  assert.deepEqual(applied.modelParameters, updated.modelParameters);
});

test("preset switching records and preserves unigram and bigram usage", async () => {
  resetStorage();
  const first = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
  });
  const firstPresetId = first.activePresetId;
  const second = await llm.saveConfig({
    provider: "deepseek",
    apiKey: "valid-deepseek",
    model: "deepseek-chat",
  });
  const secondPresetId = second.activePresetId;

  const switched = await llm.applyModelPreset(firstPresetId);
  assert.deepEqual(switched.presetUsage, {
    selections: { [firstPresetId]: 1 },
    transitions: { [secondPresetId]: { [firstPresetId]: 1 } },
  });

  const storedAfterSwitch = storageData.llmConfig;
  const repeated = await llm.applyModelPreset(firstPresetId);
  assert.deepEqual(repeated.presetUsage, switched.presetUsage, "reapplying the current preset is not a switch");
  assert.strictEqual(storageData.llmConfig, storedAfterSwitch, "reapplying the current preset must not write storage");

  const switchedBack = await llm.applyModelPreset(secondPresetId);
  assert.deepEqual(switchedBack.presetUsage, {
    selections: { [firstPresetId]: 1, [secondPresetId]: 1 },
    transitions: {
      [firstPresetId]: { [secondPresetId]: 1 },
      [secondPresetId]: { [firstPresetId]: 1 },
    },
  });

  const legacySaved = await llm.saveModelPreset({
    provider: "deepseek",
    apiKey: "valid-deepseek",
    model: "deepseek-chat",
  });
  assert.deepEqual(legacySaved.presetUsage, switchedBack.presetUsage, "legacy preset saves must retain switch memory");

  const saved = await llm.saveConfig({ trimOldToolResults: false });
  assert.deepEqual(saved.presetUsage, switchedBack.presetUsage, "ordinary model settings saves must retain switch memory");
  assert.deepEqual(storageData.llmConfig.presetUsage, switchedBack.presetUsage);
});

test("model change observer fires exactly when the persisted provider or model changes", async () => {
  resetStorage();
  const seen = [];
  llm.setModelChangeObserver((previous, next) => {
    seen.push([previous, next]);
  });
  try {
    await llm.saveConfig({
      provider: "fireworks",
      apiKey: "valid-fireworks",
      model: "accounts/fireworks/models/model-a",
    });
    assert.equal(seen.length, 1, "the first effective model save fires once");
    assert.deepEqual(seen[0][0], { provider: getProductDefaultProvider(), model: "" });
    assert.deepEqual(seen[0][1], {
      provider: "fireworks",
      model: "accounts/fireworks/models/model-a",
    });

    await llm.saveConfig({ trimOldToolResults: false });
    assert.equal(seen.length, 1, "non-model saves never fire");

    const fireworks = await llm.saveConfig({
      provider: "fireworks",
      apiKey: "valid-fireworks",
      model: "accounts/fireworks/models/model-a",
    });
    assert.equal(seen.length, 1, "saving the identical model never fires");

    await llm.saveConfig({
      provider: "deepseek",
      apiKey: "valid-deepseek",
      model: "deepseek-chat",
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1][0], {
      provider: "fireworks",
      model: "accounts/fireworks/models/model-a",
    });
    assert.deepEqual(seen[1][1], { provider: "deepseek", model: "deepseek-chat" });

    const fireworksPreset = (await llm.saveConfig({
      provider: "fireworks",
      apiKey: "valid-fireworks",
      model: "accounts/fireworks/models/model-b",
    })).activePresetId;
    assert.equal(seen.length, 3);
    await llm.applyModelPreset(fireworksPreset);
    assert.equal(seen.length, 3, "reapplying the active preset is not a switch");

    const deepseekPreset = (await llm.saveConfig({
      provider: "deepseek",
      apiKey: "valid-deepseek",
      model: "deepseek-chat",
    })).activePresetId;
    assert.equal(seen.length, 4);
    await llm.applyModelPreset(fireworksPreset);
    assert.equal(seen.length, 5, "preset apply flows through the same observer");
    assert.deepEqual(seen[4][0], { provider: "deepseek", model: "deepseek-chat" });
    assert.deepEqual(seen[4][1], {
      provider: "fireworks",
      model: "accounts/fireworks/models/model-b",
    });
    assert.ok(deepseekPreset && deepseekPreset !== fireworksPreset);
  } finally {
    llm.setModelChangeObserver(null);
  }
});

test("saving presets preserves runtime switches and does not emit the ordinary save observer", async () => {
  resetStorage();
  await llm.saveConfig({ provider: "fireworks", apiKey: "valid-fireworks", model: "accounts/fireworks/models/model-a", requestRateLimit: true, debugMode: true });
  const changes = [];
  llm.setModelChangeObserver((previous, next) => changes.push([previous, next]));
  try {
    const preset = await llm.saveModelPreset({ model: "accounts/fireworks/models/model-b", requestRateLimit: false, debugMode: false });
    assert.equal(preset.requestRateLimit, true);
    assert.equal(preset.debugMode, true);
    assert.deepEqual(changes, []);
    const ordinary = await llm.saveConfig({ model: "accounts/fireworks/models/model-c", requestRateLimit: false, debugMode: false });
    assert.equal(ordinary.requestRateLimit, false);
    assert.equal(ordinary.debugMode, false);
    assert.deepEqual(changes, [[
      { provider: "fireworks", model: "accounts/fireworks/models/model-b" },
      { provider: "fireworks", model: "accounts/fireworks/models/model-c" },
    ]]);
  } finally {
    llm.setModelChangeObserver(null);
  }
});

test("preset usage normalization prunes malformed and deleted preset references", async () => {
  resetStorage();
  const first = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
  });
  const firstPresetId = first.activePresetId;
  const second = await llm.saveConfig({
    provider: "deepseek",
    apiKey: "valid-deepseek",
    model: "deepseek-chat",
  });
  const secondPresetId = second.activePresetId;
  storageData.llmConfig.presetUsage = {
    selections: {
      [firstPresetId]: 2.9,
      [secondPresetId]: "4",
      stale: 99,
    },
    transitions: {
      [firstPresetId]: { [firstPresetId]: 11, [secondPresetId]: 3, stale: 8 },
      [secondPresetId]: { [firstPresetId]: 5, [secondPresetId]: 13 },
      stale: { [firstPresetId]: 7 },
    },
  };

  const normalized = await llm.getConfig();
  assert.deepEqual(normalized.presetUsage, {
    selections: { [firstPresetId]: 2, [secondPresetId]: 4 },
    transitions: {
      [firstPresetId]: { [secondPresetId]: 3 },
      [secondPresetId]: { [firstPresetId]: 5 },
    },
  });

  const deleted = await llm.deleteModelPreset(secondPresetId);
  assert.deepEqual(deleted.presetUsage, {
    selections: { [firstPresetId]: 2 },
    transitions: {},
  });
  assert.deepEqual(storageData.llmConfig.presetUsage, deleted.presetUsage);
});

test("preset usage handles the first selection and saturates safe counters", async () => {
  resetStorage();
  const first = await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
  });
  const firstPresetId = first.activePresetId;
  const second = await llm.saveConfig({
    provider: "deepseek",
    apiKey: "valid-deepseek",
    model: "deepseek-chat",
  });
  const secondPresetId = second.activePresetId;

  storageData.llmConfig.activePresetId = "";
  storageData.llmConfig.presetUsage = {};
  const initialSelection = await llm.applyModelPreset(firstPresetId);
  assert.deepEqual(initialSelection.presetUsage, {
    selections: { [firstPresetId]: 1 },
    transitions: {},
  });

  storageData.llmConfig.activePresetId = secondPresetId;
  storageData.llmConfig.presetUsage = {
    selections: { [firstPresetId]: Number.MAX_SAFE_INTEGER },
    transitions: { [secondPresetId]: { [firstPresetId]: Number.MAX_SAFE_INTEGER } },
  };
  const saturated = await llm.applyModelPreset(firstPresetId);
  assert.deepEqual(saturated.presetUsage, {
    selections: { [firstPresetId]: Number.MAX_SAFE_INTEGER },
    transitions: { [secondPresetId]: { [firstPresetId]: Number.MAX_SAFE_INTEGER } },
  });
});

test("failed preset applications leave usage and active config untouched", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
  });
  const storedBefore = JSON.stringify(storageData.llmConfig);
  await assert.rejects(() => llm.applyModelPreset("missing-preset"), /Preset not found/);
  assert.equal(JSON.stringify(storageData.llmConfig), storedBefore);
});

test("model parameter validation rejects kernel fields before storage changes", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
    contextWindow: 128000,
    modelParameters: { temperature: 0.2 },
  });
  const storedBefore = JSON.stringify(storageData.llmConfig);
  await assert.rejects(
    () => llm.saveConfig({ modelParameters: { messages: [], temperature: 0.7 } }),
    /messages 由轻舟管理/,
  );
  assert.equal(JSON.stringify(storageData.llmConfig), storedBefore);
});

test("legacy save_model_preset path also ignores custom names and uses upsert rules", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
    requestRateLimit: false,
  });
  const config = await llm.saveModelPreset({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-b",
    name: "用户自定义名称",
  });

  assert.equal(config.presets.length, 2);
  assert.equal(config.presets[1].name, "Fireworks AI · accounts/fireworks/models/model-b");
  assert.equal(config.providerApiKeys.fireworks, "valid-fireworks");
  assert.equal(config.requestRateLimit, false, "saving a model preset must preserve the global request-limit setting");

  const applied = await llm.applyModelPreset(config.presets[0].id);
  assert.equal(applied.requestRateLimit, false, "applying a model preset must preserve the global request-limit setting");
});

test("model preset operations preserve an explicit request limiting opt-in", async () => {
  resetStorage();
  await llm.saveConfig({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-a",
    requestRateLimit: true,
  });

  const saved = await llm.saveModelPreset({
    provider: "fireworks",
    apiKey: "valid-fireworks",
    model: "accounts/fireworks/models/model-b",
  });
  assert.equal(saved.requestRateLimit, true);

  const applied = await llm.applyModelPreset(saved.presets[0].id);
  assert.equal(applied.requestRateLimit, true);
});
