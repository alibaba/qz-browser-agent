import { t, getLocale } from "./i18n.js";
import type { UiActivation, UiSettingsPort, UiSettingsSection } from "#sdk/sidepanel";
import { normalizeProviderModelOptions } from "#sdk/shared/models";
import type { ModelCapabilityMatch } from "#sdk/shared/models";
import { optionalSessionId as normalizeSessionIdValue } from "#sdk/sidepanel/sessions";
import type { SettingsConfig, ModelConfiguration, ModelPreset, ProviderAuthStatus, ProviderDeviceLogin, ProviderLoginPoll, ProviderSummary, SkillSetting, CustomProviderProtocol } from "#sdk/shared/settings";
import type { ModelOption, ModelOptionInput } from "#sdk/shared/settings";
import type { GuardrailRule, SiteOpenRateLimit } from "#sdk/shared/security";
import type { SetupIntent, SetupStatus, SettingsProduct, SettingsProductHost } from "#sdk/sidepanel/settings";

type SaveTicket = { generation: number; revision: number };
type ConfigDraft = Omit<Partial<ModelConfiguration>, "contextWindow" | "trimOldToolResults" | "vision"> & {
  contextWindow?: string | number; trimOldToolResults?: boolean | string; vision?: boolean | string;
  requestRateLimit?: boolean | string; debugMode?: boolean; securityGuardrails?: unknown; _modelParametersSnapshot?: string; _modelParametersError?: string;
};
type GuardrailEntry = (GuardrailRule & { kind: "access" }) | (SiteOpenRateLimit & { kind: "rate_limit" });
interface SettingsReplies {
  match_model_capabilities: { match: ModelCapabilityMatch };
  list_models: { models: (string | ModelOptionInput)[]; provider?: string; providerLabel?: string };
  get_config: { config?: SettingsConfig }; apply_model_preset: { config?: SettingsConfig }; save_config: { config?: SettingsConfig };
  list_skill_settings: { settings?: SkillSetting[] }; save_skill_settings: { setting?: SkillSetting };
  start_provider_login: ProviderDeviceLogin; poll_provider_login: ProviderLoginPoll;
  logout_provider: { authStatus?: ProviderAuthStatus; config?: SettingsConfig };
}
export interface SettingsFeatureOptions {
  root?: Document;
  settings: UiSettingsPort;
  createProductSettings(host: SettingsProductHost): SettingsProduct;
  signal?: AbortSignal;
  request(type: string, payload: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>>;
  send?(message: Record<string, unknown>): unknown; setDebugMode?(enabled: boolean): void;
  confirm?(options: { title: string; message: string; confirmLabel: string; tone: "danger" }): Promise<boolean>;
  showToast?(message: string, options: { tone?: "success" | "error" | "warning"; durationMs?: number; key?: string }): unknown;
  renderWelcome?(): void; restoreComposerFocus?(): void;
  getRunContext?(): { runStatus?: string; activeRunId?: string | null; currentSessionId?: string | null };
}

import {
  formatModelParameterValue,
  MODEL_PARAMETER_SUGGESTIONS,
  normalizeModelParameters,
  parseModelParameterEntries,
  serializeModelParameters,
} from "#sdk/shared/models";
import { completeCustomProviderEndpoint, suggestCustomProviderEndpoint, normalizeCustomProtocol } from "#sdk/shared/models";
import {
  computeModelSuggestionState,
  filterModelOptions,
  normalizeModelOptions,
  shouldHideUniqueExactModelSuggestion,
} from "#sdk/shared/settings";
import {
  normalizeGuardrailRuleInput,
  normalizeSecurityGuardrails,
  normalizeSiteOpenRateLimitInput,
} from "#sdk/shared/security";
import { parseBeijingDateTime } from "#sdk/shared/format";
import { escapeHtml, escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { createModelOptionsController } from "./model-options.js";
import { createModelPresetSwitcher } from "./model-preset-switcher.js";
import { createProviderPicker } from "./provider-picker.js";

const MODEL_SUGGESTION_LIMIT = 8;
const CONTEXT_WINDOW_CUSTOM_VALUE = "__custom";
const SKILL_SETTINGS_SEARCH_THRESHOLD = 6;
const SHORTCUT_BINDINGS_REFRESH_MS = 1000;

export function createSettingsFeature(options: SettingsFeatureOptions) {
  if (typeof options.request !== "function") throw new Error("settings request adapter is required");
  const root = options.root || document;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const requestScoped: SettingsFeatureOptions["request"] = async (...args) => {
    options.signal?.throwIfAborted();
    const result = await options.request(...args);
    options.signal?.throwIfAborted();
    return result;
  };
  const request = async <K extends keyof SettingsReplies>(type: K, payload: Record<string, unknown>, timeout: number) =>
    await requestScoped(type, payload, timeout) as SettingsReplies[K];
  const send = options.send || (() => {});
  const setDebugMode = options.setDebugMode || (() => {});
  const confirmAction = options.confirm || (async () => false);
  const showToast = options.showToast || (() => {});
  const renderWelcome = options.renderWelcome || (() => {});
  const getRunContext = options.getRunContext || (() => ({ runStatus: "idle", activeRunId: "", currentSessionId: "" }));
  const currentModelIndicator = root.querySelector<HTMLElement>("#current-model-indicator");
  const gptConnectHint = root.querySelector<HTMLElement>("#gpt-connect-hint");

  const skillSettingsList = $("#skill-settings-list");
  const btnDeletePreset = $<HTMLButtonElement>("#btn-delete-preset")!;
  const btnProviderLogin = $<HTMLButtonElement>("#btn-provider-login");
  const btnProviderLogout = $<HTMLButtonElement>("#btn-provider-logout");
  const btnProviderOpen = $<HTMLButtonElement>("#btn-provider-open");
  const settingsPanel = $("#settings-panel")!;
  const guardrailRuleAction = $<HTMLSelectElement>("#guardrail-rule-action");
  const guardrailAllowHint = $("#guardrail-allow-hint");
  const guardrailRuleType = $<HTMLSelectElement>("#guardrail-rule-type");
  const guardrailDomainInput = $<HTMLInputElement>("#guardrail-domain-input");
  const btnAddGuardrailDomain = $<HTMLButtonElement>("#btn-add-guardrail-domain");
  const guardrailStatus = $("#guardrail-status");
  const guardrailDomainList = $("#guardrail-domain-list");
  const guardrailRateLimitField = $("#guardrail-rate-limit-field");
  const guardrailRateLimitInterval = $<HTMLInputElement>("#guardrail-rate-limit-interval");

  let lastSettingsConfig: Partial<SettingsConfig> | null = null;
  let customProtocols: readonly CustomProviderProtocol[] | undefined;
  let gptConnectHintState = { active: false, sessionId: "", runId: "" };


  const CONTEXT_WINDOW_PRESETS = [
    {
      value: "1M",
      label: "1M",
      title: "Qwen3.7 Max / DeepSeek V4 / Qwen Coder / MiMo",
    },
    {
      value: "512K",
      label: "512K",
      title: t("commonLimitOnSomeAggregatorGateways"),
    },
    {
      value: "262K",
      label: "262K",
      title: "Qwen3 Max / Kimi K2 / StepFun",
    },
    {
      value: "256K",
      label: "256K",
      title: "Doubao Seed / Kimi / MiMo Flash",
    },
    {
      value: "204800",
      label: "200K",
      title: "GLM-5.1 / GLM-5 / MiniMax M2.x",
    },
    {
      value: "128K",
      label: "128K",
      title: "DeepSeek R1/V3 / Qwen VL / Hunyuan",
    },
    {
      value: "64K",
      label: "64K",
      title: t("lightweightLongContext"),
    },
    {
      value: "32K",
      label: "32K",
      title: t("basicContext"),
    },
  ];
  let currentSettingsPresets: ModelPreset[] = [];
  let currentSettingsActivePresetId = "";
  let lastSettingsModel = "";
  let modelParameterRows: { id: string; key: string; value: string }[] = [];
  let modelParameterRowSequence = 0;
  let modelParameterSuggestionInput: HTMLInputElement | null = null;
  let modelParameterSuggestionOptions: string[] = [];
  let modelParameterSuggestionActiveIndex = -1;
  let modelCapabilityMatchSeq = 0;
  let modelListTimer: ReturnType<typeof setTimeout> | null = null;
  let modelListNeedsReload = false;
  let currentModelOptions: ModelOption[] = [];
  let filteredModelOptions: ModelOption[] = [];
  let modelSuggestionsOpen = false;
  let modelSuggestionsShowAll = false;
  let modelSuggestionActiveIndex = -1;
  let lastModelSuggestionQuery = "";
  let modelListLoading = false;
  let modelListError = "";
  let providerSummaries: readonly ProviderSummary[] = [];
  let providerAuth: Record<string, ProviderAuthStatus> = {};
  let currentProviderAuthStatus: ProviderAuthStatus | null = null;
  let providerLoginError = "";
  let providerLoginGeneration = 0;
  let currentProviderLogin: ProviderDeviceLogin | null = null;
  let providerLoginPollTimer: ReturnType<typeof setTimeout> | null = null;
  let providerLoginBusy = false;
  let pendingSettingsOpenIntent: SetupIntent | null = null;
  let currentSettingsTab = "model";
  let sectionActive = false;
  let panelOpenGeneration = -1;
  const saveState = { saveLabel: t("saveConfiguration"), disabled: true };
  let settingsSavedSnapshot: ReturnType<typeof normalizeSettingsConfigSnapshot> | null = null;
  let settingsSaving = false;
  let settingsGeneration = 0;
  let settingsEditRevision = 0;
  let activeSettingsSave: SaveTicket | null = null;
  let settingsSaveErrorMessage = "";
  let skillSettingsItems: SkillSetting[] = [];
  let skillSettingsLoaded = false;
  let skillSettingsLoading = false;
  let activeSkillSettingsId = "";
  let skillSettingsQuery = "";
  let skillSettingsDetailDirty = false;
  let skillSettingsSaveErrorMessage = "";
  let skillSettingsRefreshPending = false;
  const busySkillSettings = new Map<string, SaveTicket>();
  let currentSecurityGuardrails = normalizeSecurityGuardrails({});
  let draggedGuardrailRuleId = "";
  let presetSwitcherConfigRequest: Promise<void> | null = null;
  const product = options.createProductSettings({
    root, signal: options.signal, request: requestScoped,
    provider: () => $<HTMLSelectElement>("#cfg-provider")?.value || "",
    ownDraft: () => { const ticket = settingsSaveTicket(); return () => ownsSettingsDraft(ticket); },
    changed: () => { syncProviderModelFields(); updateSettingsSaveState(); },
    edited: markSettingsPresetDirtyIfNeeded,
    openSuggestions: openModelSuggestions,
    loadModels: reconcile => loadProviderModels({ force: true, reconcile }),
    selectAndSave: async model => {
      const ticket = settingsSaveTicket();
      const provider = $<HTMLSelectElement>("#cfg-provider")!.value;
      setSettingsModelSelection(model.id, model.label);
      lastSettingsModel = model.id;
      clearModelScopedSettings();
      await applyConfiguredModelCapabilityMatch(model.id, provider, { markDirty: false });
      if (!ownsSettingsDraft(ticket) || $<HTMLSelectElement>("#cfg-provider")!.value !== provider) return false;
      updateModelClearButton();
      updateSettingsSaveState();
      return handleSaveSettings();
    },
  });
  const providerPresentation = (provider = $<HTMLSelectElement>("#cfg-provider")?.value || "") => product.presentation(provider);
  const providerPicker = createProviderPicker({ root, signal: options.signal });
  const modelOptionsController = createModelOptionsController({
    cacheLimit: 24,
    loadModels: ({ provider, apiKey }) => request("list_models", { provider, apiKey }, 30000),
  });
  const modelPresetSwitcher = createModelPresetSwitcher({
    root, signal: options.signal,
    getPresets: () => {
      const labels = buildUniqueSettingsPresetLabels(currentSettingsPresets);
      return currentSettingsPresets.map((preset, index) => ({
        id: preset.id,
        name: preset.name,
        label: labels[index] || formatSettingsPresetLabel(preset),
        provider: preset.provider,
        providerLabel: getProviderDisplayName(preset.provider),
        model: preset.model,
      }));
    },
    getActivePresetId: () => lastSettingsConfig?.activePresetId || currentSettingsActivePresetId,
    getPresetUsage: () => lastSettingsConfig?.presetUsage || {},
    async applyPreset(presetId) {
      const result = await request("apply_model_preset", { presetId }, 15000);
      if (!result?.config) throw new Error(t("couldNotSwitchModelsPleaseTryAgain"));
      populateSettings(result.config);
    },
    onClose: options.restoreComposerFocus,
  });





  function renderWelcomeOnboarding(welcome: HTMLElement | null) {
    if (!welcome) return;
    const setup = getOnboardingSetupStatus();
    const statusEl = welcome.querySelector<HTMLElement>("#onboarding-status");
    const statusText = welcome.querySelector<HTMLElement>("#onboarding-status-text");
    const setupActions = welcome.querySelector<HTMLElement>("#onboarding-setup-actions");
    const primarySetupBtn = welcome.querySelector<HTMLElement>("#onboarding-primary-btn");
    if (statusEl) statusEl.dataset.state = setup.state;
    if (statusText) statusText.textContent = setup.text;
    const shouldShowSetupActions = setup.state === "needs_setup";
    setupActions?.classList.toggle("hidden", !shouldShowSetupActions);
    if (primarySetupBtn) {
      primarySetupBtn.textContent = product.welcomeLabel;
      primarySetupBtn.dataset.onboardingAction = "setup";
    }
  }

  function closeModelSuggestionsIfOpen() {
    if (!modelSuggestionsOpen) return false;
    closeModelSuggestions();
    return true;
  }

  function openModelPresetSwitcher() {
    if (isElementVisible(settingsPanel)) {
      showToast(t("closeSettingsBeforeSwitchingModels"), {
        durationMs: 2800,
        key: "model-preset-switcher-settings-open",
      });
      return false;
    }
    const needsConfig = !lastSettingsConfig;
    modelPresetSwitcher.open({ loading: needsConfig });
    if (needsConfig && !presetSwitcherConfigRequest) {
      presetSwitcherConfigRequest = request("get_config", {}, 10000)
        .then((result) => {
          if (!result?.config) throw new Error(t("couldNotLoadModelPresets"));
          populateSettings(result.config);
        })
        .catch((error) => {
          modelPresetSwitcher.setError(errorMessage(error) || t("couldNotLoadModelPresets"));
        })
        .finally(() => {
          presetSwitcherConfigRequest = null;
        });
    }
    return true;
  }

  function closePresetSwitcherIfOpen() {
    return modelPresetSwitcher.closeIfOpen();
  }

  function hasBlockingOverlay() {
    return modelPresetSwitcher.isOpen() || providerPicker.isOpen();
  }

  function getOnboardingSetupStatus(): SetupStatus {
    const config = lastSettingsConfig;
    if (!config) {
      return { state: "loading", text: t("checkingModelConfiguration"), actionLabel: t("settings") };
    }
    const provider = config.provider || "";
    const model = String(config.model || "").trim();
    if (hasProviderAuth(provider)) {
      const loggedIn = providerAuth[provider]?.loggedIn === true;
      if (!loggedIn) {
        return { state: "needs_setup", text: t("signInToToContinue", { account: String(providerSummary(provider)?.auth?.label || t("account")) }), actionLabel: t("signIn"), focus: "providerAuth" };
      }
      if (!model) {
        return { state: "needs_setup", text: t("selectAModelToContinue"), actionLabel: t("selectModel"), focus: "model" };
      }
      return { state: "ready", text: t("modelConnected", { model: String(model) }), actionLabel: "" };
    }
    const productStatus = product.onboarding(config);
    if (productStatus) return productStatus;
    if (providerNeedsApiKey(provider) && !String(config.apiKey || "").trim()) {
      return { state: "needs_setup", text: t("noModelEndpointConfiguredYet"), actionLabel: t("configure"), focus: "apiKey" };
    }
    if (!model) {
      return { state: "needs_setup", text: t("selectAModelToContinue"), actionLabel: t("selectModel"), focus: "model" };
    }
    return { state: "ready", text: t("modelConnected", { model: String(model) }), actionLabel: "" };
  }

  function handleModelComboboxKeydown(event: KeyboardEvent) {
    return handleModelComboboxKeydownImpl(event);
  }

  renderContextWindowPresets();

  function openSettingsPanel({ focusSetup = false, provider = "", focusTarget = "", startAuth = false }: SetupIntent = {}) {
    const providerIntent = normalizeSettingsOpenProvider(provider);
    if (providerIntent || focusTarget || startAuth) {
      pendingSettingsOpenIntent = { provider: providerIntent, focusTarget, focusSetup, startAuth };
    }
    options.settings.open(focusSetup || startAuth ? "model" : currentSettingsTab);
    if (focusSetup || startAuth) setTimeout(focusOnboardingSetupField, 120);
  }

  function activateSettingsSection(tab: string) {
    const generation = options.settings.getOpenGeneration();
    const opening = panelOpenGeneration !== generation;
    panelOpenGeneration = generation;
    sectionActive = true;
    if (opening) {
      modelListNeedsReload = false;
      invalidateSettingsSaves();
      modelPresetSwitcher.closeIfOpen();
      setGuardrailStatus("");
      send({ type: "get_config" });
      if (!skillSettingsLoaded) void refreshSkillSettings({ silent: tab !== "skills" });
    } else if (modelListNeedsReload) {
      void loadProviderModels();
    }
    if (tab !== currentSettingsTab) settingsEditRevision += 1;
    currentSettingsTab = tab;
    if (tab !== "model") {
      providerPicker.close();
      closeModelSuggestions();
      closeModelParameterSuggestions();
    }
    syncShortcutBindingsRefresh();
    updateSettingsSaveState();
  }

  function normalizeSettingsOpenProvider(provider: unknown) {
    const value = String(provider || "").trim().toLowerCase();
    if (Array.from($<HTMLSelectElement>("#cfg-provider")!.options).some(option => option.value === value)) return value;
    return "";
  }

  function closeSettingsPanel() {
    options.settings.close();
  }

  function deactivateSettingsSection() {
    providerPicker.close();
    // Switching between this package's sections shares one draft; leaving it ends ownership.
    if (["model", "skills", "advanced"].includes(options.settings.currentSection())) return;
    sectionActive = false;
    cancelProviderLoginPolling();
    modelListNeedsReload ||= modelListLoading || modelListTimer !== null;
    cancelProviderModelsLoad();
    modelListLoading = false;
    invalidateSettingsSaves();
    closeModelSuggestions();
    closeModelParameterSuggestions();
    setGuardrailStatus("");
    syncShortcutBindingsRefresh();
  }

  function invalidateSettingsSaves() {
    settingsGeneration += 1;
    activeSettingsSave = null;
    settingsSaving = false;
    busySkillSettings.clear();
    skillSettingsList?.querySelectorAll<HTMLElement>("[data-skill-settings-id]").forEach(card => setSkillSettingsCardBusy(card, false));
    updateSettingsSaveState();
  }

  function settingsSaveTicket() {
    return { generation: settingsGeneration, revision: settingsEditRevision };
  }

  function ownsSettingsDraft(ticket: SaveTicket) {
    return ticket.generation === settingsGeneration && ticket.revision === settingsEditRevision;
  }

  async function refreshSkillSettings({ silent = false } = {}) {
    if (skillSettingsLoading) {
      skillSettingsRefreshPending = true;
      return;
    }
    if (silent && skillSettingsDetailDirty) {
      skillSettingsRefreshPending = true;
      return;
    }
    if (silent && !isElementVisible(settingsPanel)) {
      skillSettingsLoaded = false;
      skillSettingsItems = [];
      activeSkillSettingsId = "";
      skillSettingsQuery = "";
      syncSkillSettingsTabAvailability();
      return;
    }
    const hadAvailableSettings = hasAvailableSkillSettings();
    skillSettingsLoading = true;
    if (!silent && currentSettingsTab === "skills") renderSkillSettings({ loading: true });
    try {
      const result = await request("list_skill_settings", {}, 15000);
      skillSettingsItems = Array.isArray(result.settings) ? result.settings : [];
      skillSettingsLoaded = true;
      skillSettingsSaveErrorMessage = "";
      if (skillSettingsItems.length <= 1) {
        activeSkillSettingsId = "";
        skillSettingsDetailDirty = false;
      }
      if (activeSkillSettingsId && !skillSettingsItems.some(item => getSkillSettingIdentity(item) === activeSkillSettingsId)) {
        activeSkillSettingsId = "";
        skillSettingsDetailDirty = false;
      }
      if (skillSettingsItems.length < SKILL_SETTINGS_SEARCH_THRESHOLD) skillSettingsQuery = "";
      syncSkillSettingsTabAvailability();
      renderSkillSettings();
    } catch (error) {
      skillSettingsLoaded = hadAvailableSettings;
      skillSettingsSaveErrorMessage = errorMessage(error) || t("couldNotLoadSkillSettings");
      syncSkillSettingsTabAvailability();
      if (currentSettingsTab === "skills") {
        renderSkillSettings({ error: skillSettingsSaveErrorMessage });
      }
    } finally {
      skillSettingsLoading = false;
      updateSettingsSaveState();
      flushPendingSkillSettingsRefresh();
    }
  }

  function hasAvailableSkillSettings() {
    return skillSettingsLoaded && skillSettingsItems.length > 0;
  }

  function syncSkillSettingsTabAvailability() {
    options.settings.refresh();
  }

  function flushPendingSkillSettingsRefresh() {
    if (!skillSettingsRefreshPending || skillSettingsLoading || skillSettingsDetailDirty) return;
    skillSettingsRefreshPending = false;
    refreshSkillSettings({ silent: true });
  }

  function renderSkillSettings({ loading = false, error = "" } = {}) {
    if (!skillSettingsList) return;
    let markup = "";
    if (loading) {
      markup = `<div class="skill-settings-empty qz:grid qz:min-h-37.5 qz:gap-2.5">${escapeHtml(t("loadingSkillSettings"))}</div>`;
    } else if (error) {
      markup = `
        <div class="skill-settings-empty skill-settings-empty--error qz:grid qz:min-h-37.5 qz:gap-2.5">
          <span>${escapeHtml(error)}</span>
          <button class="qz-btn qz-btn--secondary qz-btn--sm" type="button" data-skill-settings-refresh>${escapeHtml(t("retry"))}</button>
        </div>`;
    } else if (!skillSettingsItems.length) {
      markup = `<div class="skill-settings-empty qz:grid qz:min-h-37.5 qz:gap-2.5">${escapeHtml(t("installedSkillsHaveNoSettingsToConfigure"))}</div>`;
    } else if (skillSettingsItems.length === 1) {
      markup = renderSkillSettingsCard(skillSettingsItems[0]);
    } else {
      const activeSetting = skillSettingsItems.find(item => getSkillSettingIdentity(item) === activeSkillSettingsId);
      if (activeSetting) {
        markup = `
        <div class="skill-settings-detail-nav">
          <button class="qz-btn qz-btn--ghost qz-btn--sm skill-settings-back" type="button" data-skill-settings-back>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M8.75 3.5L5.25 7l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            ${escapeHtml(t("backToSkills"))}
          </button>
        </div>
        ${renderSkillSettingsCard(activeSetting)}`;
      } else {
        activeSkillSettingsId = "";
        skillSettingsDetailDirty = false;
        markup = renderSkillSettingsIndex();
      }
    }
    skillSettingsList.innerHTML = markup;
    updateSettingsSaveState();
  }

  function renderSkillSettingsIndex() {
    const searchable = skillSettingsItems.length >= SKILL_SETTINGS_SEARCH_THRESHOLD;
    return `
      <section class="skill-settings-index" aria-label="${escapeHtmlAttribute(t("configurableSkills"))}">
        <header class="skill-settings-index-header">
          <div>
            <h4>${escapeHtml(t("selectASkillToConfigure"))}</h4>
            <p>${escapeHtml(t("skillsHaveTheirOwnSettings", { count: String(skillSettingsItems.length) }))}</p>
          </div>
        </header>
        ${searchable ? `
          <input class="qz-field skill-settings-search" type="search" value="${escapeHtmlAttribute(skillSettingsQuery)}" placeholder="${escapeHtmlAttribute(t("searchSkills"))}" aria-label="${escapeHtmlAttribute(t("searchSkills"))}" data-skill-settings-search>` : ""}
        <div class="skill-settings-index-rows" data-skill-settings-index-rows>
          ${renderSkillSettingsIndexRows()}
        </div>
      </section>`;
  }

  function renderSkillSettingsIndexRows() {
    const query = skillSettingsQuery.trim().toLocaleLowerCase(getLocale());
    const visibleItems = query
      ? skillSettingsItems.filter(setting => getSkillSettingSearchText(setting).includes(query))
      : skillSettingsItems;
    if (!visibleItems.length) {
      return `<div class="skill-settings-index-empty">${escapeHtml(t("noMatchingSkills"))}</div>`;
    }
    return visibleItems.map((setting) => {
      const identity = getSkillSettingIdentity(setting);
      const title = getSkillSettingTitle(setting);
      const source = String(setting.skillDisplayName || setting.skillName || "");
      const description = String(setting.description || (source && source !== title ? source : ""));
      const missingCount = Array.isArray(setting.missing) ? setting.missing.length : 0;
      return `
        <button class="qz-btn qz-btn--secondary skill-settings-index-row" type="button" data-skill-settings-open="${escapeHtmlAttribute(identity)}">
          <span class="skill-settings-index-copy">
            <strong>${escapeHtml(title)}</strong>
            ${description ? `<small>${escapeHtml(description)}</small>` : ""}
          </span>
          ${missingCount ? `<span class="skill-settings-index-missing">${escapeHtml(t("missing", { count: String(missingCount) }))}</span>` : ""}
          <svg class="skill-settings-index-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M5.25 3.5L8.75 7l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>`;
    }).join("");
  }

  function getSkillSettingIdentity(setting: Partial<SkillSetting> = {}) {
    return String(setting.id || `${setting.skillName || ""}::${setting.pluginId || ""}`);
  }

  function getSkillSettingTitle(setting: Partial<SkillSetting> = {}) {
    return String(setting.title || setting.pluginName || setting.pluginId || t("skillSettings"));
  }

  function getSkillSettingSearchText(setting: Partial<SkillSetting> = {}) {
    return [
      getSkillSettingTitle(setting),
      setting.pluginName,
      setting.pluginId,
      setting.skillDisplayName,
      setting.skillName,
      setting.description,
    ].map(value => String(value || "").toLocaleLowerCase(getLocale())).join("\n");
  }

  function renderSkillSettingsCard(setting: SkillSetting) {
    const identity = getSkillSettingIdentity(setting);
    const busy = busySkillSettings.has(identity);
    const title = getSkillSettingTitle(setting);
    const source = String(setting.skillDisplayName || setting.skillName || "");
    const sectioned = Array.isArray(setting.layout?.sections) && setting.layout.sections.length > 0;
    return `
      <section class="skill-settings-card${sectioned ? " skill-settings-card--sectioned" : ""}" data-skill-settings-id="${escapeHtmlAttribute(identity)}" data-plugin-id="${escapeHtmlAttribute(setting.pluginId || "")}" data-skill-name="${escapeHtmlAttribute(setting.skillName || "")}">
        <div class="skill-settings-card-header">
          <div class="skill-settings-heading">
            <div class="skill-settings-title">${escapeHtml(title)}</div>
            ${source && source !== title ? `<div class="skill-settings-source">${escapeHtml(t("from", { source: String(source) }))}</div>` : ""}
          </div>
        </div>
        ${setting.description ? `<div class="skill-settings-description">${escapeHtml(setting.description)}</div>` : ""}
        ${renderSkillSettingLayout(setting, busy)}
      </section>`;
  }

  function renderSkillSettingLayout(setting: SkillSetting, busy: boolean) {
    const fields = Array.isArray(setting.fields) ? setting.fields : [];
    const fieldsByKey = new Map(fields.map(field => [String(field.key || ""), field]));
    const renderedKeys = new Set();
    const sections = [];
    for (const section of Array.isArray(setting.layout?.sections) ? setting.layout.sections : []) {
      const sectionFields = [];
      for (const key of Array.isArray(section?.fields) ? section.fields : []) {
        const normalizedKey = String(key || "");
        const field = fieldsByKey.get(normalizedKey);
        if (!field || renderedKeys.has(normalizedKey)) continue;
        renderedKeys.add(normalizedKey);
        sectionFields.push(field);
      }
      if (!sectionFields.length) continue;
      sections.push(`
        <section class="skill-settings-section">
          <header class="skill-settings-section-header">
            <h4 class="skill-settings-section-title">${escapeHtml(section.title || "")}</h4>
            ${section.description ? `<p class="skill-settings-section-description">${escapeHtml(section.description)}</p>` : ""}
          </header>
          <div class="skill-settings-grid">
            ${sectionFields.map(field => renderSkillSettingField(field, busy)).join("")}
          </div>
        </section>`);
    }
    const ungroupedFields = fields.filter(field => !renderedKeys.has(String(field.key || "")));
    if (!sections.length) {
      return `<div class="skill-settings-grid">${fields.map(field => renderSkillSettingField(field, busy)).join("")}</div>`;
    }
    return `
      <div class="skill-settings-sections">
        ${sections.join("")}
        ${ungroupedFields.length ? `
          <div class="skill-settings-grid skill-settings-grid--ungrouped">
            ${ungroupedFields.map(field => renderSkillSettingField(field, busy)).join("")}
          </div>` : ""}
      </div>`;
  }

  function renderSkillSettingField(field: SkillSetting["fields"][number], busy: boolean) {
    const key = escapeHtmlAttribute(field.key || "");
    const label = escapeHtml(field.label || field.key || "");
    const labelAttribute = escapeHtmlAttribute(field.label || field.key || "");
    const required = field.required ? '<span class="skill-settings-required" aria-hidden="true">*</span>' : "";
    const description = field.description ? `<div class="qz-field-hint skill-settings-field-hint">${escapeHtml(field.description)}</div>` : "";
    const width = field.width === "half" ? " skill-settings-field--half" : "";
    if (field.type === "boolean") {
      return `
        <label class="skill-settings-field skill-settings-field--toggle${width}">
          <span class="skill-settings-toggle-label">${label}${required}</span>
          <input class="qz-checkbox" type="checkbox" data-skill-setting-field="${key}" data-field-type="boolean" ${field.value === true ? "checked" : ""} ${busy ? "disabled" : ""}>
          ${description}
        </label>`;
    }
    if (field.type === "select") {
      return `
        <label class="skill-settings-field${width}">
          <span class="qz-field-label">${label}${required}</span>
          <select class="qz-field qz-select" data-skill-setting-field="${key}" data-field-type="select" ${busy ? "disabled" : ""}>
            <option value="" ${String(field.value ?? "") === "" ? "selected" : ""}>${escapeHtml(t("selectAnOption"))}</option>
            ${(field.options || []).map(option => `<option value="${escapeHtmlAttribute(option.value)}" ${String(field.value ?? "") === option.value ? "selected" : ""}>${escapeHtml(option.label || option.value)}</option>`).join("")}
          </select>
          ${description}
        </label>`;
    }
    const inputType = field.type === "secret" ? "password" : field.type === "number" ? "number" : field.type === "url" ? "url" : "text";
    const value = String(field.value ?? "");
    const placeholder = String(field.placeholder || "");
    const numberAttrs = field.type === "number"
      ? `${field.min != null ? ` min="${escapeHtmlAttribute(field.min)}"` : ""}${field.max != null ? ` max="${escapeHtmlAttribute(field.max)}"` : ""}${field.step != null ? ` step="${escapeHtmlAttribute(field.step)}"` : ""}`
      : "";
    return `
      <div class="skill-settings-field${width}">
        <span class="qz-field-label">${label}${required}</span>
        <input class="qz-field${field.type === "secret" ? " qz-field--mono" : ""}" type="${inputType}" value="${escapeHtmlAttribute(value)}" placeholder="${escapeHtmlAttribute(placeholder)}" aria-label="${labelAttribute}" ${field.required ? 'aria-required="true"' : ""} data-skill-setting-field="${key}" data-field-type="${escapeHtmlAttribute(field.type || "text")}" autocomplete="${field.type === "secret" ? "new-password" : "off"}" ${numberAttrs} ${busy ? "disabled" : ""}>
        ${description}
      </div>`;
  }

  skillSettingsList?.addEventListener("click", async (event) => {
    if (eventElement(event)?.closest<HTMLElement>("[data-skill-settings-refresh]")) {
      refreshSkillSettings();
      return;
    }
    if (eventElement(event)?.closest<HTMLElement>("[data-skill-settings-back]")) {
      await returnToSkillSettingsIndex();
      return;
    }
    const openButton = eventElement(event)?.closest<HTMLElement>("[data-skill-settings-open]");
    if (openButton) {
      settingsEditRevision += 1;
      activeSkillSettingsId = openButton.dataset.skillSettingsOpen || "";
      skillSettingsDetailDirty = false;
      skillSettingsSaveErrorMessage = "";
      renderSkillSettings();
      return;
    }
  }, { signal: options.signal });

  skillSettingsList?.addEventListener("input", (event) => {
    const search = eventElement(event)?.closest<HTMLInputElement>("[data-skill-settings-search]");
    if (search) {
      skillSettingsQuery = search.value || "";
      const rows = skillSettingsList.querySelector<HTMLElement>("[data-skill-settings-index-rows]");
      if (rows) rows.innerHTML = renderSkillSettingsIndexRows();
      return;
    }
    const card = eventElement(event)?.closest<HTMLElement>("[data-skill-settings-id]");
    if (!card) return;
    settingsEditRevision += 1;
    skillSettingsDetailDirty = true;
    skillSettingsSaveErrorMessage = "";
    updateSettingsSaveState();
  }, { signal: options.signal });

  async function returnToSkillSettingsIndex() {
    if (skillSettingsDetailDirty && !await confirmAction({
      title: t("discardUnsavedChanges"),
      message: t("changesToTheseSkillSettingsHaveNotBeenSaved"),
      confirmLabel: t("discardChanges"),
      tone: "danger",
    })) return;
    settingsEditRevision += 1;
    activeSkillSettingsId = "";
    skillSettingsDetailDirty = false;
    skillSettingsSaveErrorMessage = "";
    renderSkillSettings();
    flushPendingSkillSettingsRefresh();
  }

  async function saveSkillSettingsCard(card: HTMLElement) {
    const identity = card?.dataset.skillSettingsId || "";
    if (!identity || busySkillSettings.has(identity)) return;
    const payload = readSkillSettingsCard(card);
    const ticket = settingsSaveTicket();
    const ownsCard = () => ownsSettingsDraft(ticket) && skillSettingsList?.querySelector<HTMLElement>("[data-skill-settings-id]") === card;
    skillSettingsSaveErrorMessage = "";
    busySkillSettings.set(identity, ticket);
    setSkillSettingsCardBusy(card, true);
    updateSettingsSaveState();
    let saved = false;
    try {
      const result = await request("save_skill_settings", payload, 15000);
      if (!ownsCard()) return;
      replaceSkillSetting(result.setting);
      saved = true;
      skillSettingsDetailDirty = false;
      showToast(t("skillSettingsSaved"), { tone: "success", key: `skill-settings-saved-${identity}` });
    } catch (error) {
      if (!ownsCard()) return;
      skillSettingsSaveErrorMessage = errorMessage(error) || t("couldNotSave");
    } finally {
      if (busySkillSettings.get(identity) === ticket) {
        busySkillSettings.delete(identity);
        setSkillSettingsCardBusy(card, false);
        if (saved) {
          renderSkillSettings();
          flushPendingSkillSettingsRefresh();
          closeSettingsPanel();
        } else {
          updateSettingsSaveState();
        }
      }
    }
  }

  function readSkillSettingsCard(card: HTMLElement) {
    const values: Record<string, unknown> = {};
    card.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-skill-setting-field]").forEach((field) => {
      const key = field.dataset.skillSettingField || "";
      const type = field.dataset.fieldType || "text";
      if (!key) return;
      if (type === "boolean") values[key] = "checked" in field && field.checked === true;
      else if (type === "number") {
        values[key] = field.value === "" ? null : Number(field.value);
      } else values[key] = field.value;
    });
    return {
      pluginId: card.dataset.pluginId || "",
      skillName: card.dataset.skillName || "",
      values,
    };
  }

  function replaceSkillSetting(setting?: SkillSetting) {
    if (!setting?.id) return;
    const index = skillSettingsItems.findIndex(item => item.id === setting.id);
    if (index >= 0) skillSettingsItems[index] = setting;
    else skillSettingsItems.push(setting);
  }

  function setSkillSettingsCardBusy(card: HTMLElement, busy: boolean) {
    card?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach(control => { control.disabled = busy; });
  }

  const shortcutRows = [
    {
      command: "_execute_action",
      value: $("#side-panel-shortcut-value"),
      button: $<HTMLButtonElement>("#btn-edit-side-panel-shortcut"),
      title: t("openQingzhou"),
    },
    {
      command: "open-model-preset-switcher",
      value: $("#model-switcher-shortcut-value"),
      button: $<HTMLButtonElement>("#btn-edit-model-switcher-shortcut"),
      title: t("switchModel"),
    },
  ];
  let shortcutRefreshSeq = 0;
  let shortcutRefreshTimer = 0;

  async function refreshShortcutBindings() {
    const requestSeq = ++shortcutRefreshSeq;
    try {
      const commands = await chrome.commands.getAll();
      if (requestSeq !== shortcutRefreshSeq) return;
      for (const row of shortcutRows) {
        if (!row.value || !row.button) continue;
        const shortcut = String(commands.find(item => item.name === row.command)?.shortcut || "").trim();
        const label = formatShortcutLabel(shortcut);
        const title = shortcut
          ? t("clickToChange", { command: String(row.title), shortcut: String(shortcut) })
          : t("noShortcutForClickToSetOne", { command: String(row.title) });
        if (row.value.textContent !== label) row.value.textContent = label;
        if (row.button.title !== title) row.button.title = title;
      }
    } catch (_err) {
      if (requestSeq !== shortcutRefreshSeq) return;
      for (const row of shortcutRows) {
        if (row.value && row.value.textContent !== t("notSet")) row.value.textContent = t("notSet");
        if (row.button && row.button.title !== t("openChromeShortcutSettings")) {
          row.button.title = t("openChromeShortcutSettings");
        }
      }
    }
  }

  function formatShortcutLabel(shortcut: unknown) {
    const value = String(shortcut || "").trim();
    if (!value) return t("notSet");
    const tokens = value
      .replace(/⌘/g, "+Command+")
      .replace(/⇧/g, "+Shift+")
      .replace(/⌥/g, "+Option+")
      .replace(/⌃/g, "+Ctrl+")
      .split("+")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => ({
        command: "Command",
        macctrl: "Ctrl",
        control: "Ctrl",
        ctrl: "Ctrl",
        option: "Option",
        alt: "Alt",
        shift: "Shift",
      })[item.toLowerCase()] || item);
    const modifiers = ["Command", "Ctrl", "Option", "Alt", "Shift"];
    const ordered = [
      ...modifiers.filter(modifier => tokens.includes(modifier)),
      ...tokens.filter(token => !modifiers.includes(token)),
    ];
    return ordered.map(token => token === "Command" ? "⌘" : token).join(" + ");
  }

  function refreshShortcutBindingsIfVisible() {
    if (!sectionActive || currentSettingsTab !== "advanced") return;
    refreshShortcutBindings();
  }

  function syncShortcutBindingsRefresh() {
    const shouldRefresh = sectionActive
      && currentSettingsTab === "advanced"
      && document.visibilityState === "visible";
    if (!shouldRefresh) {
      if (shortcutRefreshTimer) window.clearInterval(shortcutRefreshTimer);
      shortcutRefreshTimer = 0;
      return;
    }
    refreshShortcutBindings();
    if (!shortcutRefreshTimer) {
      shortcutRefreshTimer = window.setInterval(refreshShortcutBindingsIfVisible, SHORTCUT_BINDINGS_REFRESH_MS);
    }
  }

  function renderSecurityGuardrails() {
    if (!guardrailDomainList) return;
    const rows = buildSecurityGuardrailDraftEntries(currentSecurityGuardrails);
    if (!rows.length) {
      guardrailDomainList.innerHTML = `<div class="guardrail-domain-empty">${escapeHtml(t("noSecurityPolicyRulesYet"))}</div>`;
      return;
    }
    guardrailDomainList.innerHTML = rows.map((item) => {
      const typeLabel = item.type === "pattern" ? t("wildcardMatch") : t("domain");
      const targetMeta = item.type === "pattern" ? t("matchesTheFullUrlSupportsWildcards") : t("matchesThisDomainAndAllSubdomains");
      const actionLabel = item.kind === "rate_limit"
        ? t("rateLimit")
        : (item.action === "allow" ? t("allowAccess") : t("blockAccess"));
      const meta = item.kind === "rate_limit"
        ? t("minimumInterval", { type: String(typeLabel), interval: String(formatGuardrailRateLimitInterval(item.minOpenIntervalMs)), state: String(targetMeta) })
        : `${typeLabel} · ${targetMeta}`;
      return `
        <div
          class="guardrail-domain-row"
          draggable="true"
          data-guardrail-rule-id="${escapeHtmlAttribute(item.id)}"
          data-guardrail-action="${escapeHtmlAttribute(item.kind === "rate_limit" ? "rate_limit" : item.action)}"
        >
          <div class="guardrail-domain-drag" title="${escapeHtmlAttribute(t("dragToChangePriority"))}" aria-hidden="true">::</div>
          <div class="guardrail-domain-main">
            <div class="guardrail-domain-name" title="${escapeHtmlAttribute(item.value)}">${escapeHtml(item.value)}</div>
            <div class="guardrail-domain-meta">${actionLabel} · ${meta}</div>
          </div>
          <button
            class="qz-btn qz-btn--secondary qz-btn--danger qz-btn--sm  guardrail-domain-remove"
            type="button"
            ${item.kind === "rate_limit" ? `data-remove-rate-limit-id="${escapeHtmlAttribute(item.id)}"` : `data-remove-guardrail-id="${escapeHtmlAttribute(item.id)}"`}
          >${escapeHtml(t("delete"))}</button>
        </div>
      `;
    }).join("");
  }

  function buildSecurityGuardrailDraftEntries(value: unknown = {}) {
    const guardrails = normalizeSecurityGuardrails(value);
    const byId = new Map<string, GuardrailEntry>([
      ...guardrails.rules.map(rule => [rule.id, { ...rule, kind: "access" }] as const),
      ...guardrails.siteOpenRateLimits.map(item => [item.id, { ...item, kind: "rate_limit" }] as const),
    ]);
    return guardrails.order
      .map(id => byId.get(id))
      .filter((item): item is GuardrailEntry => Boolean(item));
  }

  function setGuardrailStatus(message: string, tone = "muted") {
    if (!guardrailStatus) return;
    const text = String(message || "").trim();
    guardrailStatus.textContent = text;
    guardrailStatus.dataset.tone = tone || "muted";
    guardrailStatus.classList.toggle("hidden", !text);
  }

  function markSettingsDraftDirty() {
    settingsEditRevision += 1;
    settingsSaveErrorMessage = "";
    updateSettingsSaveState();
  }

  function setDraftSecurityGuardrails(value: unknown = {}) {
    currentSecurityGuardrails = normalizeSecurityGuardrails(value);
    renderSecurityGuardrails();
  }

  function handleAddGuardrailDomain() {
    if (!guardrailDomainInput || !btnAddGuardrailDomain) return;
    const value = guardrailDomainInput.value;
    const selectedAction = guardrailRuleAction?.value === "rate_limit"
      ? "rate_limit"
      : (guardrailRuleAction?.value === "allow" ? "allow" : "block");
    const type = guardrailRuleType?.value === "pattern" ? "pattern" : "domain";
    if (selectedAction === "rate_limit") {
      handleAddGuardrailRateLimit({ type, value });
      return;
    }
    const action = selectedAction;
    const normalized = normalizeGuardrailRuleInput({ action, type, value });
    if (!normalized.rule) {
      setGuardrailStatus(normalized.error, "error");
      guardrailDomainInput.focus();
      return;
    }
    const guardrails = normalizeSecurityGuardrails(currentSecurityGuardrails);
    const exists = guardrails.rules.some(rule => (
      rule.action === normalized.rule!.action
      && rule.type === normalized.rule!.type
      && rule.value === normalized.rule!.value
    ));
    const savedValue = normalized.rule.value || "";
    if (!exists) {
      setDraftSecurityGuardrails({
        rules: [...guardrails.rules, normalized.rule],
        siteOpenRateLimits: guardrails.siteOpenRateLimits,
        order: [...guardrails.order, normalized.rule.id],
      });
      markSettingsDraftDirty();
    }
    guardrailDomainInput.value = "";
    const actionText = action === "allow" ? t("allowAccess") : t("blockAccess");
    setGuardrailStatus(
      exists ? t("isAlreadyInTheRules", { target: String(savedValue) }) : t("addedTakesEffectAfterSaving", { action: String(actionText), target: String(savedValue) }),
      exists ? "muted" : "success",
    );
    guardrailDomainInput.focus();
  }

  function handleRemoveGuardrailDomain(ruleId: unknown) {
    const target = String(ruleId || "").trim();
    if (!target) return;
    const removed = currentSecurityGuardrails?.rules?.find(rule => rule.id === target);
    const guardrails = normalizeSecurityGuardrails(currentSecurityGuardrails);
    setDraftSecurityGuardrails({
      rules: guardrails.rules.filter(rule => rule.id !== target),
      siteOpenRateLimits: guardrails.siteOpenRateLimits,
      order: guardrails.order.filter(id => id !== target),
    });
    markSettingsDraftDirty();
    setGuardrailStatus(t("removedTakesEffectAfterSaving", { target: String(removed?.value || t("thisRule")) }), "success");
  }

  function syncGuardrailInputPlaceholder() {
    guardrailAllowHint?.classList.toggle("hidden", guardrailRuleAction?.value !== "allow");
    if (!guardrailDomainInput) return;
    const isPattern = guardrailRuleType?.value === "pattern";
    const isRateLimit = guardrailRuleAction?.value === "rate_limit";
    guardrailDomainInput.placeholder = isPattern ? "*://*.example.com/private/*" : "example.com";
    if (guardrailRateLimitField && guardrailRateLimitInterval) {
      guardrailRateLimitField.classList.toggle("hidden", !isRateLimit);
      guardrailRateLimitInterval.disabled = !isRateLimit;
      guardrailRateLimitField.closest<HTMLElement>(".guardrail-input-row")?.classList.toggle("rate-limit-active", isRateLimit);
    }
  }

  function parseGuardrailRateLimitInterval(value = "") {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return { value: 0, error: t("enterTheNavigationIntervalInSeconds") };
    const text = raw.replace(/\s+/g, "");
    const match = text.match(/^(\d+(?:\.\d+)?)(ms|毫秒|s|秒|m|分钟)?$/);
    if (!match) return { value: 0, error: t("enterANumberForTheIntervalForExample3") };
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return { value: 0, error: t("theNavigationIntervalMustBeGreaterThan0Seconds") };
    const unit = match[2] || "s";
    const multiplier = unit === "ms" || unit === "毫秒"
      ? 1
      : (unit === "m" || unit === "分钟" ? 60000 : 1000);
    const intervalMs = Math.round(amount * multiplier);
    if (intervalMs < 500) return { value: 0, error: t("theNavigationIntervalMustBeAtLeast05Seconds") };
    if (intervalMs > 24 * 60 * 60 * 1000) return { value: 0, error: t("theNavigationIntervalMustNotExceed24Hours") };
    return { value: intervalMs, error: "" };
  }

  function formatGuardrailRateLimitInterval(value = 0) {
    const ms = Math.max(0, Number(value) || 0);
    if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
    if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
  }

  function handleAddGuardrailRateLimit(input: { type?: string; value?: string }) {
    if (!guardrailRateLimitInterval || !guardrailDomainInput) return;
    input = input && typeof input === "object" ? input : {};
    const type = input.type === "pattern" ? "pattern" : "domain";
    const value = input.value || "";
    const interval = parseGuardrailRateLimitInterval(guardrailRateLimitInterval.value);
    if (interval.error) {
      setGuardrailStatus(interval.error, "error");
      guardrailRateLimitInterval.focus();
      return;
    }
    const normalized = normalizeSiteOpenRateLimitInput({
      type,
      value,
      minOpenIntervalMs: interval.value,
    });
    if (!normalized.rateLimit) {
      setGuardrailStatus(normalized.error, "error");
      guardrailDomainInput.focus();
      return;
    }
    const guardrails = normalizeSecurityGuardrails(currentSecurityGuardrails);
    const exists = guardrails.siteOpenRateLimits.some(item => (
      item.type === normalized.rateLimit!.type
      && item.value === normalized.rateLimit!.value
    ));
    const savedValue = normalized.rateLimit.value || "";
    if (!exists) {
      setDraftSecurityGuardrails({
        rules: guardrails.rules,
        siteOpenRateLimits: [...guardrails.siteOpenRateLimits, normalized.rateLimit],
        order: [...guardrails.order, normalized.rateLimit.id],
      });
      markSettingsDraftDirty();
    }
    guardrailDomainInput.value = "";
    setGuardrailStatus(
      exists ? t("isAlreadyInTheRateLimitRules", { target: String(savedValue) }) : t("addedWithIntervalTakesEffectAfterSaving", { target: String(savedValue), interval: String(formatGuardrailRateLimitInterval(normalized.rateLimit.minOpenIntervalMs)) }),
      exists ? "muted" : "success",
    );
    guardrailDomainInput.focus();
  }

  function handleRemoveGuardrailRateLimit(rateLimitId: unknown) {
    const target = String(rateLimitId || "").trim();
    if (!target) return;
    const guardrails = normalizeSecurityGuardrails(currentSecurityGuardrails);
    const removed = guardrails.siteOpenRateLimits.find(item => item.id === target);
    setDraftSecurityGuardrails({
      rules: guardrails.rules,
      siteOpenRateLimits: guardrails.siteOpenRateLimits.filter(item => item.id !== target),
      order: guardrails.order.filter(id => id !== target),
    });
    markSettingsDraftDirty();
    setGuardrailStatus(t("removedTakesEffectAfterSaving", { target: String(removed?.value || t("thisRateLimitRule")) }), "success");
  }

  function persistGuardrailRuleOrder(ruleIds: readonly string[]) {
    const ids = Array.isArray(ruleIds) ? ruleIds.map(id => String(id || "")).filter(Boolean) : [];
    const guardrails = normalizeSecurityGuardrails(currentSecurityGuardrails);
    const ruleById = new Map(guardrails.rules.map(rule => [rule.id, rule]));
    const rateLimitById = new Map(guardrails.siteOpenRateLimits.map(item => [item.id, item]));
    const knownIds = new Set([...ruleById.keys(), ...rateLimitById.keys()]);
    const orderedIds: string[] = [];
    ids.forEach((id) => {
      if (!knownIds.has(id) || orderedIds.includes(id)) return;
      orderedIds.push(id);
    });
    guardrails.order.forEach((id) => {
      if (!knownIds.has(id) || orderedIds.includes(id)) return;
      orderedIds.push(id);
    });
    setDraftSecurityGuardrails({
      rules: orderedIds.map(id => ruleById.get(id)).filter(Boolean),
      siteOpenRateLimits: orderedIds.map(id => rateLimitById.get(id)).filter(Boolean),
      order: orderedIds,
    });
    markSettingsDraftDirty();
    setGuardrailStatus(t("rulesReorderedTakesEffectAfterSaving"), "success");
  }

  function focusOnboardingSetupField() {
    const setup = getOnboardingSetupStatus();
    if (product.focus(setup.focus || "")) return;
    if (setup.focus === "providerAuth") {
      btnProviderLogin?.focus();
      return;
    }

    if (setup.focus === "apiKey") {
      $<HTMLInputElement>("#cfg-apikey")?.focus();
      return;
    }
    $<HTMLInputElement>("#cfg-model")?.focus();
  }




  async function handleSaveSettings(context?: UiActivation) {
    if (context?.signal.aborted) return false;
    if (currentSettingsTab === "skills") {
      const card = skillSettingsList?.querySelector<HTMLElement>("[data-skill-settings-id]");
      if (!card || saveState.disabled) return false;
      await saveSkillSettingsCard(card);
      return true;
    }
    applyCustomEndpointCompletion({ animate: false });
    if (saveState.disabled) return false;
    const fields = readSettingsConfigFields();
    const validation = validateSettingsConfigFields(fields);
    if (!validation.valid) {
      updateSettingsSaveState();
      return false;
    }
    const config = settingsConfigForSave(fields);
    const ticket = settingsSaveTicket();
    const submittedTab = currentSettingsTab;
    const ownsSave = () => !context?.signal.aborted && ownsSettingsDraft(ticket);
    activeSettingsSave = ticket;
    settingsSaving = true;
    updateSettingsSaveState();
    const finishSave = () => {
      if (activeSettingsSave !== ticket) return;
      activeSettingsSave = null;
      settingsSaving = false;
      updateSettingsSaveState();
    };
    context?.signal.addEventListener("abort", finishSave, { once: true });
    try {
      const result = await request("save_config", {
        config: {
          ...config,
          securityGuardrails: normalizeSecurityGuardrails(currentSecurityGuardrails),
          activePresetId: getMatchingSelectedPresetId(),
        },
      }, 45000);
      if (context?.signal.aborted) return false;
      if (ownsSave()) {
        if (result.config) populateSettings(result.config);
        // Advanced shares its save action with independently owned contributions.
        if (submittedTab === "model") closeSettingsPanel();
      } else if (ticket.generation === settingsGeneration && result.config) {
        // The submitted draft was saved; newer edits remain in the form and stay dirty.
        rememberSavedConfig(result.config);
      }
      return true;
    } catch (err) {
      if (!ownsSave()) return false;
      settingsSaveErrorMessage = errorMessage(err) || t("couldNotSaveConfiguration");
      setSettingsSaveStatus(settingsSaveErrorMessage, "error");
      showToast(t("configurationNotSaved", { reason: String(settingsSaveErrorMessage) }), {
        tone: "error",
        durationMs: 6000,
        key: "settings-save-error",
      });
      return false;
    } finally {
      context?.signal.removeEventListener("abort", finishSave);
      finishSave();
    }
  }

  btnDeletePreset.addEventListener("click", async () => {
    const presetId = $<HTMLSelectElement>("#cfg-preset")!.value;
    if (!presetId) return;
    const preset = currentSettingsPresets.find(p => p.id === presetId);
    const label = preset?.name || t("thisPreset");
    if (!await confirmAction({
      title: t("deletePresetConfirmation", { name: String(label) }),
      message: t("thisModelPresetWillBeRemovedFromQingzhou"),
      confirmLabel: t("delete"),
      tone: "danger",
    })) return;
    send({ type: "delete_model_preset", presetId });
  }, { signal: options.signal });

  btnProviderLogin?.addEventListener("click", startProviderLogin, { signal: options.signal });
  btnProviderLogout?.addEventListener("click", logoutProvider, { signal: options.signal });
  btnProviderOpen?.addEventListener("click", () => {
    const url = currentProviderLogin?.verificationUri;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, { signal: options.signal });
  btnAddGuardrailDomain?.addEventListener("click", handleAddGuardrailDomain, { signal: options.signal });
  guardrailRuleAction?.addEventListener("change", () => {
    syncGuardrailInputPlaceholder();
    guardrailDomainInput?.focus();
  }, { signal: options.signal });
  guardrailRuleType?.addEventListener("change", () => {
    syncGuardrailInputPlaceholder();
    guardrailDomainInput?.focus();
  }, { signal: options.signal });
  guardrailDomainInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    handleAddGuardrailDomain();
  }, { signal: options.signal });
  guardrailDomainList?.addEventListener("click", (event) => {
    const rateLimitButton = eventElement(event)?.closest<HTMLElement>("[data-remove-rate-limit-id]");
    if (rateLimitButton) {
      handleRemoveGuardrailRateLimit(rateLimitButton.dataset.removeRateLimitId);
      return;
    }
    const button = eventElement(event)?.closest<HTMLElement>("[data-remove-guardrail-id]");
    if (button) handleRemoveGuardrailDomain(button.dataset.removeGuardrailId);
  }, { signal: options.signal });
  guardrailDomainList?.addEventListener("dragstart", (event) => {
    const row = eventElement(event)?.closest<HTMLElement>("[data-guardrail-rule-id]");
    if (!row || !event.dataTransfer) return;
    draggedGuardrailRuleId = row.dataset.guardrailRuleId || "";
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedGuardrailRuleId);
  }, { signal: options.signal });
  guardrailDomainList?.addEventListener("dragend", (event) => {
    eventElement(event)?.closest<HTMLElement>("[data-guardrail-rule-id]")?.classList.remove("dragging");
    draggedGuardrailRuleId = "";
  }, { signal: options.signal });
  guardrailDomainList?.addEventListener("dragover", (event) => {
    if (!draggedGuardrailRuleId || !event.dataTransfer) return;
    if (!eventElement(event)?.closest<HTMLElement>("[data-guardrail-rule-id]")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, { signal: options.signal });
  guardrailDomainList?.addEventListener("drop", (event) => {
    if (!draggedGuardrailRuleId) return;
    const targetRow = eventElement(event)?.closest<HTMLElement>("[data-guardrail-rule-id]");
    if (!targetRow) return;
    event.preventDefault();
    const targetId = targetRow.dataset.guardrailRuleId || "";
    if (!targetId || targetId === draggedGuardrailRuleId) return;
    const ids = normalizeSecurityGuardrails(currentSecurityGuardrails).order;
    const nextIds = ids.filter(id => id !== draggedGuardrailRuleId);
    const targetIndex = nextIds.indexOf(targetId);
    if (targetIndex < 0) return;
    const rect = targetRow.getBoundingClientRect();
    const insertAfter = event.clientY > rect.top + rect.height / 2;
    nextIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedGuardrailRuleId);
    persistGuardrailRuleOrder(nextIds);
  }, { signal: options.signal });
  guardrailRateLimitInterval?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    handleAddGuardrailDomain();
  }, { signal: options.signal });
  syncGuardrailInputPlaceholder();

  $<HTMLSelectElement>("#cfg-preset")!.addEventListener("change", () => {
    settingsEditRevision += 1;
    settingsSaveErrorMessage = "";
    const presetId = $<HTMLSelectElement>("#cfg-preset")!.value;
    if (!presetId) {
      currentSettingsActivePresetId = "";
      updatePresetButtons();
      updateSettingsSaveState();
      return;
    }
    const preset = currentSettingsPresets.find(p => p.id === presetId);
    if (!preset) return;
    applyPresetToSettingsFields(preset);
    currentSettingsActivePresetId = presetId;
    updatePresetButtons();
    updateSettingsSaveState();
  }, { signal: options.signal });

  $<HTMLSelectElement>("#cfg-provider")!.addEventListener("change", () => {
    const provider = $<HTMLSelectElement>("#cfg-provider")!.value;
    clearProviderScopedSettings(provider);
    markSettingsPresetDirtyIfNeeded();
    syncProviderAuthUi(provider);
    loadProviderModels();
  }, { signal: options.signal });

  $<HTMLInputElement>("#cfg-context-window")!.addEventListener("input", () => {
    resetModelCapabilityMatch();
    if ($<HTMLSelectElement>("#cfg-context-preset")?.value === CONTEXT_WINDOW_CUSTOM_VALUE) {
      syncContextWindowCustomInputVisibility();
    } else {
      syncContextWindowPresetToInput();
    }
    updateContextWindowHint();
  }, { signal: options.signal });

  $<HTMLSelectElement>("#cfg-context-preset")!.addEventListener("change", () => {
    resetModelCapabilityMatch();
    applyContextWindowPresetSelection();
    updateContextWindowHint();
    markSettingsPresetDirtyIfNeeded();
  }, { signal: options.signal });

  $<HTMLSelectElement>("#cfg-vision")!.addEventListener("change", () => {
    resetModelCapabilityMatch();
    updateContextWindowHint();
  }, { signal: options.signal });

  $<HTMLInputElement>("#cfg-model")!.addEventListener("input", handleSettingsModelUserChange, { signal: options.signal });
  $<HTMLInputElement>("#cfg-model")!.addEventListener("change", handleSettingsModelUserChange, { signal: options.signal });
  $<HTMLInputElement>("#cfg-model")!.addEventListener("focus", () => {
    retryManagedModelListIfNeeded();
    syncModelSuggestionsVisibility({ forceOpen: true });
  }, { signal: options.signal });
  $<HTMLInputElement>("#cfg-model")!.addEventListener("click", () => {
    if (!modelSuggestionsOpen) syncModelSuggestionsVisibility({ forceOpen: true, showAllOnExactMatch: true });
  }, { signal: options.signal });
  $<HTMLInputElement>("#cfg-model")!.addEventListener("keydown", handleModelComboboxKeydown, { signal: options.signal });
  $<HTMLButtonElement>("#cfg-model-clear")!.addEventListener("mousedown", (event) => event.preventDefault(), { signal: options.signal });
  $<HTMLButtonElement>("#cfg-model-clear")!.addEventListener("click", clearModelNameInput, { signal: options.signal });
  $<HTMLButtonElement>("#cfg-model-toggle")!.addEventListener("mousedown", (event) => event.preventDefault(), { signal: options.signal });
  $<HTMLButtonElement>("#cfg-model-toggle")!.addEventListener("click", () => {
    if (providerPresentation().manualModels) return;
    if (retryManagedModelListIfNeeded()) {
      $<HTMLInputElement>("#cfg-model")!.focus();
      syncModelSuggestionsVisibility({ forceOpen: true, showAllOnExactMatch: true });
      return;
    }
    if (modelSuggestionsOpen) closeModelSuggestions();
    else {
      $<HTMLInputElement>("#cfg-model")!.focus();
      syncModelSuggestionsVisibility({ forceOpen: true, showAllOnExactMatch: true });
    }
  }, { signal: options.signal });
  $("#cfg-model-options")!.addEventListener("mousedown", (event) => event.preventDefault(), { signal: options.signal });
  $("#cfg-model-options")!.addEventListener("click", (event) => {
    const item = eventElement(event)?.closest<HTMLElement>(".model-suggestion-item");
    if (!item) return;
    selectModelSuggestion(Number(item.dataset.modelIndex));
  }, { signal: options.signal });
  $<HTMLButtonElement>("#btn-add-model-parameter")?.addEventListener("click", addModelParameterRow, { signal: options.signal });
  $("#cfg-model-parameters")?.addEventListener("input", handleModelParameterInput, { signal: options.signal });
  $("#cfg-model-parameters")?.addEventListener("focusin", handleModelParameterFocus, { signal: options.signal });
  $("#cfg-model-parameters")?.addEventListener("keydown", handleModelParameterKeydown, { signal: options.signal });
  $("#cfg-model-parameters")?.addEventListener("click", handleModelParameterClick, { signal: options.signal });
  $("#cfg-model-parameter-suggestions")?.addEventListener("mousedown", event => event.preventDefault(), { signal: options.signal });
  $("#cfg-model-parameter-suggestions")?.addEventListener("click", handleModelParameterSuggestionClick, { signal: options.signal });
  $("#settings-panel-model")?.addEventListener("scroll", () => {
    if (modelSuggestionsOpen) positionModelSuggestions();
    closeModelParameterSuggestions();
  }, { passive: true, signal: options.signal });
  window.addEventListener("resize", () => {
    if (modelSuggestionsOpen) positionModelSuggestions();
    closeModelParameterSuggestions();
  }, { signal: options.signal });
  document.addEventListener("mousedown", (event) => {
    if ($("#cfg-model-combobox")?.contains(eventElement(event))) return;
    closeModelSuggestions();
  }, { signal: options.signal });
  document.addEventListener("mousedown", (event) => {
    if (modelParameterSuggestionInput?.contains?.(eventElement(event))) return;
    if ($("#cfg-model-parameter-suggestions")?.contains(eventElement(event))) return;
    closeModelParameterSuggestions();
  }, { signal: options.signal });

  ["#cfg-apikey", "#cfg-model", "#cfg-context-window", "#cfg-trim-old-tool-results", "#cfg-vision", "#cfg-request-rate-limit", "#cfg-debug-mode", "#cfg-custom-protocol", "#cfg-custom-endpoint", "#cfg-custom-preset-name"].forEach((selector) => {
    $(selector)!.addEventListener("input", markSettingsPresetDirtyIfNeeded, { signal: options.signal });
    $(selector)!.addEventListener("change", markSettingsPresetDirtyIfNeeded, { signal: options.signal });
  });

  $("#provider-options-box")?.addEventListener("change", markSettingsPresetDirtyIfNeeded, { signal: options.signal });

  const customEndpointInput = $<HTMLInputElement>("#cfg-custom-endpoint");
  customEndpointInput?.addEventListener("input", syncCustomEndpointCompletion, { signal: options.signal });
  customEndpointInput?.addEventListener("focus", syncCustomEndpointCompletion, { signal: options.signal });
  customEndpointInput?.addEventListener("blur", () => applyCustomEndpointCompletion(), { signal: options.signal });
  customEndpointInput?.addEventListener("keydown", handleCustomEndpointKeydown, { signal: options.signal });

  ["#btn-edit-side-panel-shortcut", "#btn-edit-model-switcher-shortcut"].forEach((selector) => {
    $(selector)?.addEventListener("click", async () => {
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    }, { signal: options.signal });
  });
  window.addEventListener("focus", refreshShortcutBindingsIfVisible, { signal: options.signal });
  document.addEventListener("visibilitychange", syncShortcutBindingsRefresh, { signal: options.signal });

  $<HTMLSelectElement>("#cfg-custom-protocol")!.addEventListener("change", () => {
    updateCustomEndpointPlaceholder();
    applyCustomEndpointCompletion();
  }, { signal: options.signal });

  setModelParameterRows({});

  $<HTMLInputElement>("#cfg-apikey")!.addEventListener("input", () => {
    syncProviderAuthUi();
    if (!sectionActive || hasProviderAuth() || isCustomProvider()) return;
    scheduleProviderModelsLoad();
  }, { signal: options.signal });
  $<HTMLInputElement>("#cfg-apikey")!.addEventListener("change", () => {
    syncProviderAuthUi();
    if (!sectionActive || hasProviderAuth() || isCustomProvider()) return;
    loadProviderModels({ force: true });
  }, { signal: options.signal });

  function populateSettings(config: Partial<SettingsConfig>) {
    settingsGeneration += 1;
    cancelProviderLoginPolling();
    lastSettingsConfig = config || {};
    if (Array.isArray(config.providers)) providerSummaries = config.providers;
    providerAuth = config.providerAuth || providerAuth;
    populateProviderChoices();
    if (Array.isArray(config.customProtocols)) customProtocols = config.customProtocols;
    updateCurrentModelIndicator();
    const provider = config.provider || "fireworks";
    currentSettingsPresets = Array.isArray(config.presets) ? config.presets : [];
    currentSettingsActivePresetId = config.activePresetId || "";
    product.populate(config);
    resetModelCapabilityMatch();
    renderSettingsPresetOptions();
    populateModelFields(config, !providerNeedsApiKey(provider) ? "" : (config.apiKey || ""));
    $<HTMLInputElement>("#cfg-request-rate-limit")!.checked = config.requestRateLimit === true;
    $<HTMLInputElement>("#cfg-debug-mode")!.checked = config.debugMode === true;
    refreshShortcutBindingsIfVisible();
    setDebugMode(config.debugMode === true);
    $<HTMLSelectElement>("#cfg-preset")!.value = currentSettingsPresets.some(p => p.id === currentSettingsActivePresetId)
      ? currentSettingsActivePresetId
      : "";
    updatePresetButtons();
    syncProviderAuthUi(provider);
    renderWelcome();
    setDraftSecurityGuardrails(config.securityGuardrails || currentSecurityGuardrails);
    settingsSaveErrorMessage = "";
    settingsSavedSnapshot = normalizeSettingsConfigSnapshot(config);
    modelPresetSwitcher.refresh();
    const pendingIntentOwnsModelLoad = applyPendingSettingsOpenIntent();
    updateSettingsSaveState();
    if (!pendingIntentOwnsModelLoad) loadProviderModels();
  }

  function rememberSavedConfig(config: Partial<SettingsConfig>) {
    lastSettingsConfig = config;
    settingsSavedSnapshot = normalizeSettingsConfigSnapshot(config);
    updateCurrentModelIndicator();
    setDebugMode(config.debugMode === true);
    renderWelcome();
  }

  function applySavedConfig(config: Partial<SettingsConfig>) {
    if (!isElementVisible(settingsPanel)) return populateSettings(config);
    // Legacy save notifications carry no draft identity; they cannot replace an open form.
    rememberSavedConfig(config);
    updateSettingsSaveState();
  }

  function applyPendingSettingsOpenIntent() {
    if (!pendingSettingsOpenIntent) return false;
    const intent = pendingSettingsOpenIntent;
    pendingSettingsOpenIntent = null;
    if (intent.provider && $<HTMLSelectElement>("#cfg-provider")?.value !== intent.provider) {
      $<HTMLSelectElement>("#cfg-provider")!.value = intent.provider;
      providerPicker.sync();
      clearProviderScopedSettings(intent.provider);
      markSettingsPresetDirtyIfNeeded();
    }
    const target = intent.focusTarget || (intent.focusSetup ? "setup" : "");
    if (target) {
      setTimeout(() => focusSettingsOpenTarget(target), 0);
    }
    if (intent.startAuth) {
      setTimeout(() => {
        void product.connect(true);
      }, 0);
    }
    return intent.startAuth === true;
  }

  function focusSettingsOpenTarget(target: string) {
    if (product.focus(target)) return;
    if (target === "customEndpoint") {
      $<HTMLInputElement>("#cfg-custom-endpoint")?.focus();
      return;
    }
    if (target === "provider") {
      providerPicker.focus();
      return;
    }
    focusOnboardingSetupField();
  }

  function clearProviderScopedSettings(provider: string) {
    cancelProviderLoginPolling();
    cancelProviderModelsLoad();
    resetModelCapabilityMatch();
    closeModelSuggestions();
    $<HTMLInputElement>("#cfg-apikey")!.value = getRememberedProviderApiKey(provider);
    setSettingsModelSelection("");
    setModelParameterRows({});
    lastSettingsModel = "";
    updateModelClearButton();
    renderProviderOptions({}, provider);
    populateCustomProtocol(customProtocols?.find(item => item.id === "openai")?.id || customProtocols?.[0]?.id);
    $<HTMLInputElement>("#cfg-custom-endpoint")!.value = "";
    $<HTMLInputElement>("#cfg-custom-preset-name")!.value = "";
    setActiveContextWindowPreset("");
    $<HTMLInputElement>("#cfg-context-window")!.value = "";
    $<HTMLInputElement>("#cfg-trim-old-tool-results")!.checked = true;
    $<HTMLSelectElement>("#cfg-vision")!.value = "false";
    currentSettingsActivePresetId = "";
    $<HTMLSelectElement>("#cfg-preset")!.value = "";
    modelListLoading = false;
    modelListError = "";
    renderModelOptions([]);
    updateContextWindowHint();
    syncProviderAuthUi(provider);
    updatePresetButtons();
    product.sync();
  }

  function renderContextWindowPresets() {
    const select = $<HTMLSelectElement>("#cfg-context-preset");
    if (!select) return;
    const options = [
      `<option value="" disabled>${escapeHtml(t("selectContextLength"))}</option>`,
      ...CONTEXT_WINDOW_PRESETS.filter(preset => preset.value).map((preset) => {
        const label = preset.label;
        const title = preset.title || label;
        return `<option value="${escapeHtmlAttribute(preset.value)}" title="${escapeHtmlAttribute(title)}">${escapeHtml(label)}</option>`;
      }),
    ];
    options.push(`<option value="${CONTEXT_WINDOW_CUSTOM_VALUE}">${escapeHtml(t("customContextLength"))}</option>`);
    select.innerHTML = options.join("");
    syncContextWindowPresetToInput();
  }

  function renderSettingsPresetOptions() {
    const select = $<HTMLSelectElement>("#cfg-preset")!;
    const presetLabels = buildUniqueSettingsPresetLabels(currentSettingsPresets);
    const options = [
      `<option value="">${escapeHtml(t("newConfiguration"))}</option>`,
      ...currentSettingsPresets.map((preset, index) => {
        return `<option value="${escapeHtmlAttribute(preset.id)}">${escapeHtml(presetLabels[index] || formatSettingsPresetLabel(preset))}</option>`;
      }),
    ];
    select.innerHTML = options.join("");
  }

  function buildUniqueSettingsPresetLabels(presets: readonly ModelPreset[] = []) {
    const items = (Array.isArray(presets) ? presets : []).map((preset, index) => ({
      index,
      label: formatSettingsPresetLabel(preset),
      time: parseSettingsPresetTime(preset),
    }));
    const groups = items.reduce((map, item) => {
      const group = map.get(item.label) || [];
      group.push(item);
      map.set(item.label, group);
      return map;
    }, new Map<string, typeof items>());

    const labels = items.map(item => item.label);
    groups.forEach((group) => {
      if (group.length <= 1) return;
      group
        .slice()
        .sort((a, b) => a.time - b.time || a.index - b.index)
        .forEach((item, number) => {
          labels[item.index] = `${item.label} #${number + 1}`;
        });
    });
    return labels;
  }

  function parseSettingsPresetTime(preset: Partial<ModelPreset> & { createdAt?: string } = {}) {
    const time = parseBeijingDateTime(preset.createdAt || preset.updatedAt || "");
    return time !== null && Number.isFinite(time) && time > 0 ? time : 0;
  }

  function formatSettingsPresetLabel(preset: Partial<ModelPreset> = {}) {
    const name = String(preset.name || t("untitledPreset")).trim();
    const model = String(preset.modelLabel || preset.model || "").trim();
    if (!model) return name;
    return presetLabelIncludesModel(name, model) ? name : `${name} · ${model}`;
  }

  function presetLabelIncludesModel(name: string, model: string) {
    const normalize = (value: string) => String(value || "")
      .toLowerCase()
      .replace(/[._\-/\s]+/g, "")
      .trim();
    const cleanName = normalize(name);
    const cleanModel = normalize(model);
    return cleanModel && cleanName.endsWith(cleanModel);
  }

  function setModelParameterRows(parameters: unknown = {}) {
    closeModelParameterSuggestions();
    modelParameterRows = Object.entries(normalizeModelParameters(parameters)).map(([key, value]) => ({
      id: `model-parameter-${++modelParameterRowSequence}`,
      key,
      value: formatModelParameterValue(value),
    }));
    renderModelParameterRows();
  }

  function renderModelParameterRows() {
    const list = $("#cfg-model-parameters");
    if (!list) return;
    $("#cfg-model-parameters-label")?.classList.toggle("hidden", modelParameterRows.length === 0);
    list.innerHTML = modelParameterRows.map((row) => {
      return `
        <div class="model-parameter-row" data-model-parameter-id="${escapeHtmlAttribute(row.id)}">
          <input
            class="qz-field qz-field--mono"
            type="text"
            value="${escapeHtmlAttribute(row.key)}"
            placeholder="${escapeHtmlAttribute(t("modelParameterKey"))}"
            autocomplete="off"
            spellcheck="false"
            data-model-parameter-field="key"
            aria-label="${escapeHtmlAttribute(t("modelParameterKey"))}"
            aria-autocomplete="list"
            aria-controls="cfg-model-parameter-suggestions"
            aria-expanded="false"
            role="combobox"
          >
          <input
            class="qz-field qz-field--mono"
            type="text"
            value="${escapeHtmlAttribute(row.value)}"
            placeholder="${escapeHtmlAttribute(t("modelParameterValue"))}"
            autocomplete="off"
            spellcheck="false"
            data-model-parameter-field="value"
            aria-label="${escapeHtmlAttribute(t("modelParameterValue"))}"
            aria-autocomplete="list"
            aria-controls="cfg-model-parameter-suggestions"
            aria-expanded="false"
            role="combobox"
          >
          <button class="qz-icon-btn qz-icon-btn--sm model-parameter-remove" type="button" data-remove-model-parameter="${escapeHtmlAttribute(row.id)}" aria-label="${escapeHtmlAttribute(t("deleteModelParameter"))}">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M4.25 4.25l5.5 5.5M9.75 4.25l-5.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>`;
    }).join("");
  }

  function addModelParameterRow() {
    const row = {
      id: `model-parameter-${++modelParameterRowSequence}`,
      key: "",
      value: "",
    };
    modelParameterRows.push(row);
    renderModelParameterRows();
    $("#cfg-model-parameters")
      ?.querySelector<HTMLElement>(`[data-model-parameter-id="${row.id}"] [data-model-parameter-field="key"]`)
      ?.focus();
  }

  function handleModelParameterInput(event: Event) {
    const input = eventElement(event)?.closest<HTMLInputElement>("[data-model-parameter-field]");
    const rowElement = input?.closest<HTMLElement>("[data-model-parameter-id]");
    if (!input || !rowElement) return;
    const row = modelParameterRows.find(item => item.id === rowElement.dataset.modelParameterId);
    if (!row) return;
    const field = input.dataset.modelParameterField;
    if (field !== "key" && field !== "value") return;
    row[field] = input.value;
    openModelParameterSuggestions(input);
    markSettingsPresetDirtyIfNeeded();
  }

  function handleModelParameterFocus(event: Event) {
    const input = eventElement(event)?.closest<HTMLInputElement>("[data-model-parameter-field]");
    if (input) openModelParameterSuggestions(input, { filter: false });
  }

  function handleModelParameterKeydown(event: KeyboardEvent) {
    const input = eventElement(event)?.closest<HTMLInputElement>("[data-model-parameter-field]");
    if (!input) return;
    if (event.key === "Tab") {
      closeModelParameterSuggestions();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeModelParameterSuggestions();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if (modelParameterSuggestionInput !== input || modelParameterSuggestionOptions.length === 0) {
      if (event.key === "Enter") return;
      openModelParameterSuggestions(input);
    }
    if (modelParameterSuggestionOptions.length === 0) return;
    event.preventDefault();
    if (event.key === "Enter") {
      const index = modelParameterSuggestionActiveIndex >= 0 ? modelParameterSuggestionActiveIndex : 0;
      selectModelParameterSuggestion(index);
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    modelParameterSuggestionActiveIndex = (
      modelParameterSuggestionActiveIndex + direction + modelParameterSuggestionOptions.length
    ) % modelParameterSuggestionOptions.length;
    renderModelParameterSuggestions();
  }

  function handleModelParameterClick(event: Event) {
    const button = eventElement(event)?.closest<HTMLElement>("[data-remove-model-parameter]");
    if (!button) return;
    const id = button.dataset.removeModelParameter;
    closeModelParameterSuggestions();
    modelParameterRows = modelParameterRows.filter(row => row.id !== id);
    renderModelParameterRows();
    markSettingsPresetDirtyIfNeeded();
  }

  function openModelParameterSuggestions(input: HTMLInputElement | null | undefined, { filter = true } = {}) {
    if (!input) return closeModelParameterSuggestions();
    const rowElement = input?.closest<HTMLElement>("[data-model-parameter-id]");
    const row = modelParameterRows.find(item => item.id === rowElement?.dataset.modelParameterId);
    const field = input?.dataset?.modelParameterField;
    if (!row || (field !== "key" && field !== "value")) {
      closeModelParameterSuggestions();
      return;
    }
    const candidates = field === "key"
      ? MODEL_PARAMETER_SUGGESTIONS.map(item => item.key)
      : (MODEL_PARAMETER_SUGGESTIONS.find(item => item.key === row.key.trim())?.values || []);
    const query = filter ? String(input.value || "").trim().toLowerCase() : "";
    modelParameterSuggestionOptions = candidates
      .filter(value => !query || value.toLowerCase().includes(query));
    if (modelParameterSuggestionOptions.length === 0) {
      closeModelParameterSuggestions();
      return;
    }
    modelParameterSuggestionInput = input;
    modelParameterSuggestionActiveIndex = -1;
    renderModelParameterSuggestions();
    positionModelParameterSuggestions();
  }

  function renderModelParameterSuggestions() {
    const menu = $("#cfg-model-parameter-suggestions");
    if (!menu || !modelParameterSuggestionInput || modelParameterSuggestionOptions.length === 0) return;
    menu.innerHTML = modelParameterSuggestionOptions.map((value, index) => `
      <button
        id="cfg-model-parameter-suggestion-${index}"
        class="qz-btn qz-btn--ghost qz-menu-item model-parameter-suggestion${index === modelParameterSuggestionActiveIndex ? " active" : ""}"
        type="button"
        role="option"
        aria-selected="${index === modelParameterSuggestionActiveIndex ? "true" : "false"}"
        data-model-parameter-suggestion-index="${index}"
        title="${escapeHtmlAttribute(value)}"
      >${escapeHtml(value)}</button>`).join("");
    menu.classList.remove("hidden");
    try {
      if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) menu.showPopover();
    } catch (_err) {}
    modelParameterSuggestionInput.setAttribute("aria-expanded", "true");
    if (modelParameterSuggestionActiveIndex >= 0) {
      modelParameterSuggestionInput.setAttribute(
        "aria-activedescendant",
        `cfg-model-parameter-suggestion-${modelParameterSuggestionActiveIndex}`,
      );
      menu.querySelector<HTMLElement>(".model-parameter-suggestion.active")?.scrollIntoView({ block: "nearest" });
    } else {
      modelParameterSuggestionInput.removeAttribute("aria-activedescendant");
    }
  }

  function positionModelParameterSuggestions() {
    const input = modelParameterSuggestionInput;
    const menu = $("#cfg-model-parameter-suggestions");
    if (!input || !menu) return;
    const rect = input.getBoundingClientRect();
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 240));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    menu.style.setProperty("--model-parameter-menu-left", `${Math.round(left)}px`);
    menu.style.setProperty("--model-parameter-menu-width", `${Math.round(width)}px`);
    menu.style.setProperty("--model-parameter-menu-top", `${Math.round(rect.bottom + 4)}px`);
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8 && rect.top > menuRect.height + 12) {
      menu.style.setProperty("--model-parameter-menu-top", `${Math.round(rect.top - menuRect.height - 4)}px`);
    }
  }

  function handleModelParameterSuggestionClick(event: Event) {
    const button = eventElement(event)?.closest<HTMLElement>("[data-model-parameter-suggestion-index]");
    if (!button) return;
    selectModelParameterSuggestion(Number(button.dataset.modelParameterSuggestionIndex));
  }

  function selectModelParameterSuggestion(index: number) {
    const input = modelParameterSuggestionInput;
    const value = modelParameterSuggestionOptions[index];
    const rowElement = input?.closest<HTMLElement>("[data-model-parameter-id]");
    const row = modelParameterRows.find(item => item.id === rowElement?.dataset.modelParameterId);
    const field = input?.dataset?.modelParameterField;
    if (!input || !rowElement || !row || value == null || (field !== "key" && field !== "value")) return;
    row[field] = value;
    input.value = value;
    closeModelParameterSuggestions();
    markSettingsPresetDirtyIfNeeded();
    if (field === "key") {
      const valueInput = rowElement.querySelector<HTMLInputElement>('[data-model-parameter-field="value"]');
      valueInput?.focus();
      openModelParameterSuggestions(valueInput);
    }
  }

  function closeModelParameterSuggestions() {
    const menu = $("#cfg-model-parameter-suggestions");
    modelParameterSuggestionInput?.setAttribute?.("aria-expanded", "false");
    modelParameterSuggestionInput?.removeAttribute?.("aria-activedescendant");
    modelParameterSuggestionInput = null;
    modelParameterSuggestionOptions = [];
    modelParameterSuggestionActiveIndex = -1;
    if (!menu) return;
    try {
      if (typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
    } catch (_err) {}
    menu.classList.add("hidden");
    menu.innerHTML = "";
  }

  function readModelParameterDraft() {
    const entries = modelParameterRows.map(({ key, value }) => ({ key, value }));
    try {
      const value = parseModelParameterEntries(entries);
      return { value, error: "", snapshot: serializeModelParameters(value) };
    } catch (err) {
      return {
        value: {},
        error: errorMessage(err) || t("invalidModelParameterFormat"),
        snapshot: `invalid:${JSON.stringify(entries)}`,
      };
    }
  }

  function settingsConfigForSave(fields: ConfigDraft = {}) {
    const {
      _modelParametersError: _error,
      _modelParametersSnapshot: _snapshot,
      ...config
    } = fields;
    return config;
  }

  function readSettingsConfigFields() {
    const provider = $<HTMLSelectElement>("#cfg-provider")!.value;
    const modelParameters = readModelParameterDraft();
    return {
      provider,
      apiKey: !providerNeedsApiKey(provider) ? "" : $<HTMLInputElement>("#cfg-apikey")!.value,
      model: getSettingsModelId(),
      modelLabel: getSettingsModelLabel(),
      modelParameters: modelParameters.value,
      _modelParametersError: modelParameters.error,
      _modelParametersSnapshot: modelParameters.snapshot,
      ...readProviderOptions(),
      customProtocol: isCustomProvider(provider) ? $<HTMLSelectElement>("#cfg-custom-protocol")!.value : "",
      customEndpoint: isCustomProvider(provider) ? $<HTMLInputElement>("#cfg-custom-endpoint")!.value : "",
      customPresetName: isCustomProvider(provider) ? $<HTMLInputElement>("#cfg-custom-preset-name")!.value : "",
      contextWindow: $<HTMLInputElement>("#cfg-context-window")!.value,
      trimOldToolResults: $<HTMLInputElement>("#cfg-trim-old-tool-results")!.checked,
      vision: $<HTMLSelectElement>("#cfg-vision")!.value === "true",
      requestRateLimit: $<HTMLInputElement>("#cfg-request-rate-limit")!.checked,
      debugMode: $<HTMLInputElement>("#cfg-debug-mode")!.checked,
    };
  }

  function normalizeSettingsConfigSnapshot(config: ConfigDraft = readSettingsConfigFields()) {
    const provider = String(config.provider || "fireworks").trim().toLowerCase();
    return {
      provider,
      apiKey: !providerNeedsApiKey(provider) ? "" : String(config.apiKey || "").trim(),
      model: String(config.model || "").trim(),
      modelParameters: config._modelParametersSnapshot || serializeModelParameters(config.modelParameters),
      providerOptions: JSON.stringify(normalizeProviderModelOptions(config, providerSummary(provider)?.modelOptions)),
      customProtocol: isCustomProvider(provider) ? normalizeCustomProtocol(config.customProtocol) : "",
      customEndpoint: isCustomProvider(provider) ? String(config.customEndpoint || "").trim() : "",
      customPresetName: isCustomProvider(provider) ? String(config.customPresetName || "").trim() : "",
      contextWindow: normalizeContextWindowText(config.contextWindow),
      trimOldToolResults: config.trimOldToolResults !== false && config.trimOldToolResults !== "false",
      vision: config.vision === true || config.vision === "true",
      requestRateLimit: config.requestRateLimit === true || config.requestRateLimit === "true",
      debugMode: config.debugMode === true,
      securityGuardrails: normalizeSecurityGuardrailsSnapshot(config.securityGuardrails || currentSecurityGuardrails),
    };
  }

  function validateSettingsConfigFields(config: ConfigDraft = readSettingsConfigFields()) {
    const provider = String(config.provider || "fireworks").trim().toLowerCase();
    const model = String(config.model || "").trim();
    if (config._modelParametersError) {
      return { valid: false, message: config._modelParametersError };
    }
    if (isCustomProvider(provider)) {
      const endpoint = String(config.customEndpoint || "").trim();
      if (!endpoint) return { valid: false, message: t("endpointCannotBeEmpty") };
      if (!isValidHttpEndpointText(endpoint)) return { valid: false, message: t("endpointMustBeAnHttpSUrl") };
    }
    if (!model) return { valid: false, message: t("modelNameCannotBeEmpty") };
    const authError = providerPresentation(provider).authError;
    if (authError) return { valid: false, message: authError };
    if (providerNeedsApiKey(provider) && !String(config.apiKey || "").trim()) {
      return { valid: false, message: t("apiKeyCannotBeEmpty") };
    }
    const contextWindow = String(config.contextWindow ?? "").trim();
    if (!contextWindow) {
      return { valid: false, message: t("selectAContextLength") };
    }
    if (!isValidContextWindowText(contextWindow)) {
      return { valid: false, message: t("invalidContextLengthFormat") };
    }
    return { valid: true, message: "" };
  }

  function isValidContextWindowText(value: unknown) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0;
    const raw = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
    if (!raw) return true;
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
    if (!match) return false;
    const base = Number(match[1]);
    return Number.isFinite(base) && base > 0;
  }

  function isValidHttpEndpointText(value: unknown) {
    try {
      const url = new URL(String(value || "").trim());
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_err) {
      return false;
    }
  }

  function settingsSnapshotsEqual(a: ReturnType<typeof normalizeSettingsConfigSnapshot> | null, b: ReturnType<typeof normalizeSettingsConfigSnapshot> | null) {
    if (!a || !b) return false;
    return (Object.keys(a) as (keyof typeof a)[])
      .every(key => key === "securityGuardrails" || a[key] === b[key])
      && securityGuardrailSnapshotsEqual(a.securityGuardrails, b.securityGuardrails);
  }

  function normalizeSecurityGuardrailsSnapshot(value: unknown = {}) {
    return buildSecurityGuardrailDraftEntries(value).map((item) => {
      if (item.kind === "rate_limit") {
        return {
          kind: "site_open_rate_limit",
          type: item.type,
          value: item.value,
          minOpenIntervalMs: Number(item.minOpenIntervalMs || 0),
          enabled: item.enabled !== false,
        };
      }
      return {
        kind: "rule",
        action: item.action,
        type: item.type,
        value: item.value,
      };
    });
  }

  function securityGuardrailSnapshotsEqual(a: ReturnType<typeof normalizeSecurityGuardrailsSnapshot> = [], b: ReturnType<typeof normalizeSecurityGuardrailsSnapshot> = []) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    return left.every((item, index) => {
      const other = right[index] || {};
      return item.kind === other.kind
        && item.action === other.action
        && item.type === other.type
        && item.value === other.value
        && item.minOpenIntervalMs === other.minOpenIntervalMs
        && item.enabled === other.enabled;
    });
  }

  function settingsSnapshotHasUsableConfig(snapshot: ReturnType<typeof normalizeSettingsConfigSnapshot> | null) {
    if (!snapshot) return false;
    if (!snapshot.model) return false;
    if (providerPresentation(snapshot.provider).managedAuth) {
      return providerPresentation(snapshot.provider).authenticated === true;
    }
    if (!providerNeedsApiKey(snapshot.provider)) return true;
    if (isCustomProvider(snapshot.provider)) return Boolean(snapshot.apiKey && snapshot.customEndpoint);
    return Boolean(snapshot.apiKey);
  }

  function updateSettingsSaveState() {
    if (currentSettingsTab === "skills") {
      updateSkillSettingsSaveState();
      return;
    }
    saveState.saveLabel = settingsSaving ? t("saving") : t("saveConfiguration");
    if (settingsSaving) {
      saveState.disabled = true;
      setSettingsSaveStatus(t("savingConfiguration"));
      return;
    }

    const fields = readSettingsConfigFields();
    const validation = validateSettingsConfigFields(fields);
    const currentSnapshot = normalizeSettingsConfigSnapshot(fields);
    const hasSavedConfig = settingsSnapshotHasUsableConfig(settingsSavedSnapshot);
    const dirty = !settingsSnapshotsEqual(currentSnapshot, settingsSavedSnapshot);
    const canSave = validation.valid && (!hasSavedConfig || dirty);
    saveState.disabled = !canSave;

    if (!validation.valid) {
      setSettingsSaveStatus(validation.message, "error");
    } else if (settingsSaveErrorMessage) {
      setSettingsSaveStatus(settingsSaveErrorMessage, "error");
    } else if (!hasSavedConfig) {
      setSettingsSaveStatus(t("configurationUnsaved"), "dirty");
    } else if (dirty) {
      setSettingsSaveStatus(t("unsavedChanges"), "dirty");
    } else {
      setSettingsSaveStatus(t("saved"), "saved");
    }
  }

  function updateSkillSettingsSaveState() {
    const card = skillSettingsList?.querySelector<HTMLElement>("[data-skill-settings-id]");
    const identity = card?.dataset.skillSettingsId || "";
    const setting = skillSettingsItems.find(item => getSkillSettingIdentity(item) === identity);
    const busy = Boolean(identity && busySkillSettings.has(identity));
    saveState.saveLabel = busy ? t("saving") : t("save");

    if (skillSettingsLoading) {
      saveState.disabled = true;
      setSettingsSaveStatus(t("loadingSkillSettingsStatus"));
      return;
    }
    if (!card || !setting) {
      saveState.disabled = true;
      if (skillSettingsSaveErrorMessage) {
        setSettingsSaveStatus(skillSettingsSaveErrorMessage, "error");
      } else if (skillSettingsItems.length > 1) {
        setSettingsSaveStatus(t("selectASkillToConfigureFirst"));
      } else {
        setSettingsSaveStatus(t("noSkillSettingsToSave"));
      }
      return;
    }
    if (busy) {
      saveState.disabled = true;
      setSettingsSaveStatus(t("savingSkillSettings"));
      return;
    }

    const canSave = skillSettingsDetailDirty || setting.configured !== true;
    saveState.disabled = !canSave;
    if (skillSettingsSaveErrorMessage) {
      setSettingsSaveStatus(skillSettingsSaveErrorMessage, "error");
    } else if (skillSettingsDetailDirty) {
      setSettingsSaveStatus(t("unsavedChanges"), "dirty");
    } else if (setting.configured !== true) {
      setSettingsSaveStatus(t("settingsNotSaved"), "dirty");
    } else {
      setSettingsSaveStatus(t("saved"), "saved");
    }
  }

  function setSettingsSaveStatus(message: string, tone = "muted") {
    const state = { ...saveState, text: String(message || ""), tone };
    const ids = currentSettingsTab === "skills" ? ["skills"] : ["model", "advanced"];
    for (const id of ids) options.settings.setState(id, state);
  }

  function updateCurrentModelIndicator(config = lastSettingsConfig) {
    if (!currentModelIndicator) return;
    const provider = String(config?.provider || "").trim();
    const model = String(config?.modelLabel || config?.model || "").trim();
    if (!provider || !model) {
      currentModelIndicator.textContent = "";
      currentModelIndicator.title = "";
      currentModelIndicator.classList.add("hidden");
      renderGptConnectHint();
      return;
    }
    const text = `${getProviderDisplayName(provider)} - ${model}`;
    currentModelIndicator.textContent = text;
    currentModelIndicator.title = text;
    currentModelIndicator.classList.remove("hidden");
    renderGptConnectHint();
  }

  function getProviderDisplayName(provider: unknown) {
    const value = String(provider || "").trim();
    if (!value) return "";
    const option = Array.from(document.querySelectorAll<HTMLOptionElement>("#cfg-provider option"))
      .find(item => item.value === value);
    // Picker options may carry a plan note suffix; every
    // other surface must read the short label instead of the option text.
    return String(option?.dataset.shortLabel || option?.textContent || value).trim();
  }

  const GPT_CONNECT_HINT_TEXT = product.connectHint;

  function isManagedAuthRuntimeConfig(config = lastSettingsConfig) {
    const provider = String(config?.provider || "").trim().toLowerCase();
    return hasProviderAuth(provider);
  }

  function showGptConnectHint(event: { sessionId?: string | null; runId?: string | null } = {}) {
    if (!isManagedAuthRuntimeConfig()) return;
    gptConnectHintState = {
      active: true,
      sessionId: normalizeSessionIdValue(event.sessionId || getRunContext().currentSessionId) || "",
      runId: String(event.runId || getRunContext().activeRunId || "").trim(),
    };
    renderGptConnectHint();
  }

  function hideGptConnectHint() {
    if (!gptConnectHintState.active) return;
    gptConnectHintState = { active: false, sessionId: "", runId: "" };
    renderGptConnectHint();
  }

  function renderGptConnectHint() {
    if (!gptConnectHint) return;
    const visible = gptConnectHintState.active
      && getRunContext().runStatus === "running"
      && (!gptConnectHintState.sessionId || gptConnectHintState.sessionId === getRunContext().currentSessionId)
      && isManagedAuthRuntimeConfig();
    if (!visible) {
      gptConnectHint.textContent = "";
      gptConnectHint.title = "";
      gptConnectHint.classList.add("hidden");
      return;
    }
    gptConnectHint.textContent = GPT_CONNECT_HINT_TEXT;
    gptConnectHint.title = GPT_CONNECT_HINT_TEXT;
    gptConnectHint.classList.remove("hidden");
  }

  function populateModelFields(config: Partial<ModelConfiguration>, apiKey: string) {
    const provider = config.provider || "fireworks";
    $<HTMLSelectElement>("#cfg-provider")!.value = provider;
    providerPicker.sync();
    $<HTMLInputElement>("#cfg-apikey")!.value = apiKey;
    setSettingsModelSelection(config.model, config.modelLabel);
    setModelParameterRows(config.modelParameters);
    lastSettingsModel = getSettingsModelId();
    updateModelClearButton();
    renderProviderOptions(config, provider);
    populateCustomProtocol(config.customProtocol);
    $<HTMLInputElement>("#cfg-custom-endpoint")!.value = config.customEndpoint || "";
    $<HTMLInputElement>("#cfg-custom-preset-name")!.value = config.customPresetName || "";
    $<HTMLInputElement>("#cfg-context-window")!.value = formatContextWindowInput(config.contextWindow);
    syncContextWindowPresetToInput();
    updateContextWindowHint();
    $<HTMLInputElement>("#cfg-trim-old-tool-results")!.checked = config.trimOldToolResults !== false;
    $<HTMLSelectElement>("#cfg-vision")!.value = config.vision ? "true" : "false";
  }

  function applyPresetToSettingsFields(preset: ModelPreset) {
    resetModelCapabilityMatch();
    populateModelFields(preset, getPresetApiKeyForSettings(preset));
    syncProviderAuthUi(preset.provider || "fireworks");
    loadProviderModels();
  }

  function providerSummary(provider = $<HTMLSelectElement>("#cfg-provider")?.value) {
    return providerSummaries.find(item => item.id === provider);
  }

  function hasProviderAuth(provider = $<HTMLSelectElement>("#cfg-provider")?.value) {
    return Boolean(providerSummary(provider)?.auth);
  }

  function providerNeedsApiKey(provider: string) {
    return providerSummary(provider)?.requiresApiKey !== false && !providerPresentation(provider).managedAuth;
  }

  function populateProviderChoices() {
    providerPicker.refresh(providerSummaries);
  }

  function renderProviderOptions(config: Record<string, unknown>, provider: string) {
    const box = $("#provider-options-box");
    if (!box) return;
    const options = providerSummary(provider)?.modelOptions || [];
    const values = normalizeProviderModelOptions(config, options);
    box.replaceChildren(...options.map(option => {
      const label = document.createElement("label");
      label.className = "provider-option-row";
      const title = document.createElement("span"); title.textContent = option.label;
      const select = document.createElement("select");
      select.className = "qz-field qz-select";
      select.dataset.providerOption = option.key;
      select.id = `cfg-provider-option-${option.key}`;
      select.replaceChildren(...option.options.map(choice => new Option(choice.label, choice.value)));
      select.value = values[option.key];
      label.append(title, select);
      return label;
    }));
    box.classList.toggle("hidden", options.length === 0);
  }

  function readProviderOptions() {
    return Object.fromEntries(Array.from(root.querySelectorAll<HTMLSelectElement>("[data-provider-option]")).map(input => [input.dataset.providerOption!, input.value]));
  }

  function isCustomProvider(provider = $<HTMLSelectElement>("#cfg-provider")?.value) {
    return String(provider || "").trim().toLowerCase() === "custom";
  }

  function getRememberedProviderApiKey(provider: string) {
    if (!providerNeedsApiKey(provider)) return "";
    const keyMap = lastSettingsConfig?.providerApiKeys;
    if (!keyMap || typeof keyMap !== "object" || Array.isArray(keyMap)) return "";
    return String(keyMap[String(provider || "").trim().toLowerCase()] || "").trim();
  }

  function getPresetApiKeyForSettings(preset: Partial<ModelPreset> = {}) {
    const provider = preset.provider || "fireworks";
    if (!providerNeedsApiKey(provider)) return "";
    if (isCustomProvider(provider)) return String(preset.apiKey || "").trim() || getRememberedProviderApiKey(provider);
    return getRememberedProviderApiKey(provider) || String(preset.apiKey || "").trim();
  }

  function populateCustomProtocol(value: unknown) {
    const select = $<HTMLSelectElement>("#cfg-custom-protocol")!;
    const selected = normalizeCustomProtocol(value);
    if (customProtocols) {
      select.replaceChildren(...customProtocols.map(({ id, label }) => new Option(label, id)));
    }
    // Old presets can outlive their adapter. Preserve the ID so execution reports
    // an unsupported protocol instead of silently changing the request format.
    if (!Array.from(select.options).some(option => option.value === selected)) select.add(new Option(selected, selected));
    select.value = selected;
  }

  function syncProviderAuthFields(providerOverride?: string) {
    const provider = providerOverride || $<HTMLSelectElement>("#cfg-provider")?.value || "";
    const apiKeyInput = $<HTMLInputElement>("#cfg-apikey");
    const apiKeyField = $("#cfg-apikey-field");
    if (!apiKeyInput) return;
    const managedAuth = !providerNeedsApiKey(provider);
    if (managedAuth && apiKeyInput.value) apiKeyInput.value = "";
    apiKeyInput.disabled = managedAuth;
    apiKeyInput.placeholder = providerPresentation(provider).apiKeyPlaceholder || (isCustomProvider(provider) ? "API Key" : "sk-...");
    apiKeyInput.title = providerPresentation(provider).apiKeyTitle || "";
    apiKeyInput.setAttribute("aria-disabled", String(managedAuth));
    apiKeyField?.classList.toggle("hidden", managedAuth);
    product.sync();
  }

  function syncCustomProviderUi(providerOverride?: string) {
    const provider = providerOverride || $<HTMLSelectElement>("#cfg-provider")?.value || "";
    const box = $("#custom-provider-box");
    if (!box) return;
    const visible = isCustomProvider(provider);
    box.classList.toggle("hidden", !visible);
    if (visible) updateCustomEndpointPlaceholder();
    syncCustomEndpointCompletion();
  }

  function updateCustomEndpointPlaceholder() {
    const endpointInput = $<HTMLInputElement>("#cfg-custom-endpoint");
    if (!endpointInput) return;
    const protocol = normalizeCustomProtocol($<HTMLSelectElement>("#cfg-custom-protocol")?.value);
    endpointInput.placeholder = suggestCustomProviderEndpoint("https://example.com", protocol)?.value || "https://example.com/api";
  }

  function handleCustomEndpointKeydown(event: KeyboardEvent) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const acceptWithArrow = event.key === "ArrowRight"
      && input.selectionStart === input.value.length
      && input.selectionEnd === input.value.length;
    if (event.key !== "Tab" && !acceptWithArrow) return;
    if (!currentCustomEndpointSuggestion()?.addition) return;
    if (acceptWithArrow) event.preventDefault();
    applyCustomEndpointCompletion();
  }

  function syncCustomEndpointCompletion() {
    syncProviderEndpoint();
    const input = $<HTMLInputElement>("#cfg-custom-endpoint");
    const editor = input?.closest<HTMLElement>(".custom-endpoint-editor");
    const completion = $("#cfg-custom-endpoint-completion");
    if (!input || !editor || !completion) return;
    const suggestion = currentCustomEndpointSuggestion();
    const addition = suggestion?.addition || "";
    completion.textContent = addition;
    completion.classList.toggle("hidden", !addition);
    if (!addition) {
      editor.removeAttribute("data-completion");
      return;
    }
    editor.dataset.completion = addition;
    requestAnimationFrame(() => {
      if (!completion.classList.contains("hidden")) input.scrollLeft = input.scrollWidth;
    });
  }

  function syncProviderEndpoint() {
    const field = $("#cfg-provider-endpoint");
    if (!field) return;
    const provider = $<HTMLSelectElement>("#cfg-provider")?.value || "";
    const endpoint = isCustomProvider(provider)
      ? completeCustomProviderEndpoint(
        $<HTMLInputElement>("#cfg-custom-endpoint")?.value || "",
        $<HTMLSelectElement>("#cfg-custom-protocol")?.value,
      )
      : providerSummary(provider)?.endpoint || "";
    field.textContent = providerSummary(provider)?.hideEndpoint ? "" : endpoint;
    field.hidden = !field.textContent;
  }

  function applyCustomEndpointCompletion({ animate = true } = {}) {
    const input = $<HTMLInputElement>("#cfg-custom-endpoint");
    const suggestion = currentCustomEndpointSuggestion();
    if (!input || !suggestion) {
      syncCustomEndpointCompletion();
      return;
    }
    input.value = suggestion.value;
    syncCustomEndpointCompletion();
    if (animate) {
      input.classList.remove("is-auto-completed");
      void input.offsetWidth;
      input.classList.add("is-auto-completed");
    }
    markSettingsPresetDirtyIfNeeded();
  }

  function currentCustomEndpointSuggestion() {
    if (!isCustomProvider()) return null;
    return suggestCustomProviderEndpoint(
      $<HTMLInputElement>("#cfg-custom-endpoint")?.value || "",
      normalizeCustomProtocol($<HTMLSelectElement>("#cfg-custom-protocol")?.value),
    );
  }

  function syncProviderModelFields() {
    const presentation = providerPresentation();
    product.sync();
    const manual = presentation.manualModels === true;
    const selectedOnly = presentation.selectModels === true;
    const modelInput = $<HTMLInputElement>("#cfg-model");
    const modelToggle = $<HTMLButtonElement>("#cfg-model-toggle");
    const modelClear = $<HTMLButtonElement>("#cfg-model-clear");
    $("#cfg-model-combobox")?.classList.toggle("manual-only", manual);
    if (manual) closeModelSuggestions();
    if (modelInput) {
      modelInput.readOnly = selectedOnly;
      modelInput.disabled = false;
      modelInput.placeholder = selectedOnly
        ? (presentation.authenticated ? t("selectModel") : t("signInToLoadAvailableModels"))
        : manual ? t("enterAModelNameManually") : t("selectOrEnterAModelName");
      if (manual) {
        for (const attribute of ["role", "aria-autocomplete", "aria-controls", "aria-expanded", "aria-activedescendant"]) modelInput.removeAttribute(attribute);
      } else {
        modelInput.setAttribute("role", "combobox");
        modelInput.setAttribute("aria-autocomplete", "list");
        modelInput.setAttribute("aria-controls", "cfg-model-options");
        modelInput.setAttribute("aria-expanded", String(modelSuggestionsOpen));
      }
    }
    if (modelToggle) {
      modelToggle.classList.toggle("hidden", manual);
      modelToggle.disabled = manual || (selectedOnly && !presentation.authenticated);
    }
    if (modelClear) { modelClear.disabled = selectedOnly; updateModelClearButton(); }
  }

  function syncProviderAuthUi(providerOverride?: string) {
    const provider = providerOverride || $<HTMLSelectElement>("#cfg-provider")?.value || "";
    syncProviderAuthFields(provider);
    syncCustomProviderUi(provider);
    syncProviderModelFields();
    const box = $("#provider-auth-box");
    if (!box) return;
    const auth = providerSummary(provider)?.auth;
    box.classList.toggle("hidden", !auth);
    if (!auth) return;
    box.title = auth.hint || "";
    currentProviderAuthStatus = providerAuth[provider] || null;
    const statusEl = $("#provider-auth-status");
    if (!statusEl || !btnProviderLogin || !btnProviderLogout) return;
    const loggedIn = currentProviderAuthStatus?.loggedIn === true;
    if (providerLoginError) statusEl.textContent = providerLoginError;
    else if (currentProviderLogin) statusEl.textContent = t("waitingForBrowserSignInConfirmation");
    else if (loggedIn && currentProviderAuthStatus) {
      const account = currentProviderAuthStatus.accountId ? ` · ${currentProviderAuthStatus.accountId}` : "";
      statusEl.textContent = t("signedIn", { account: String(account), expiry: String(formatProviderExpiry(currentProviderAuthStatus)) });
    } else statusEl.textContent = t("notSignedIn");
    btnProviderLogin.textContent = t("signInTo", { provider: String(auth.label) });
    btnProviderLogin.disabled = providerLoginBusy || Boolean(currentProviderLogin);
    btnProviderLogout.disabled = providerLoginBusy || (!loggedIn && !currentProviderLogin);
    $("#provider-device-box")?.classList.toggle("hidden", !currentProviderLogin);
    if (currentProviderLogin) {
      $("#provider-device-code")!.textContent = currentProviderLogin.userCode || "";
      $("#provider-device-hint")!.textContent = t("enterTheCodeAboveOnThePageThatOpensThis");
    }
  }

  function ownProviderLogin() {
    const generation = providerLoginGeneration;
    const draft = settingsGeneration;
    const provider = $<HTMLSelectElement>("#cfg-provider")!.value;
    return { provider, owns: () => generation === providerLoginGeneration && draft === settingsGeneration && provider === $<HTMLSelectElement>("#cfg-provider")!.value };
  }

  async function startProviderLogin() {
    if (providerLoginBusy || !hasProviderAuth()) return;
    cancelProviderLoginPolling();
    const { provider, owns } = ownProviderLogin();
    providerLoginBusy = true;
    syncProviderAuthUi();
    try {
      const result = await request("start_provider_login", { provider }, 30000);
      if (!owns()) return;
      currentProviderLogin = result;
      window.open(result.verificationUri, "_blank", "noopener,noreferrer");
      scheduleProviderLoginPoll(1200);
    } catch (error) {
      if (owns()) providerLoginError = errorMessage(error) || t("couldNotStartSignIn");
    } finally {
      if (owns()) { providerLoginBusy = false; syncProviderAuthUi(); }
    }
  }

  function scheduleProviderLoginPoll(delayMs: number) {
    if (providerLoginPollTimer) clearTimeout(providerLoginPollTimer);
    if (!currentProviderLogin?.loginId) return;
    providerLoginPollTimer = setTimeout(pollProviderLogin, Math.max(1000, delayMs || 5000));
  }

  async function pollProviderLogin() {
    providerLoginPollTimer = null;
    const login = currentProviderLogin;
    if (!login?.loginId) return;
    const { provider, owns } = ownProviderLogin();
    if (login.expiresAt && Date.now() > login.expiresAt) {
      currentProviderLogin = null; providerLoginError = t("signInCodeExpired"); syncProviderAuthUi(); return;
    }
    try {
      const result = await request("poll_provider_login", { provider, loginId: login.loginId }, 30000);
      if (!owns()) return;
      if (result.status === "complete") {
        providerAuth[provider] = result.authStatus || { loggedIn: true, accountId: result.accountId || "" };
        currentProviderLogin = null;
        syncProviderAuthUi(); renderWelcome();
        loadProviderModels({ force: true });
      } else if (result.status === "expired") {
        currentProviderLogin = null; providerLoginError = result.message || t("signInCodeExpired"); syncProviderAuthUi();
      } else {
        login.intervalSeconds = Number(result.intervalSeconds || login.intervalSeconds || 5);
        scheduleProviderLoginPoll(login.intervalSeconds * 1000);
      }
    } catch (error) {
      if (!owns()) return;
      currentProviderLogin = null; providerLoginError = errorMessage(error) || t("signInFailed"); syncProviderAuthUi();
    }
  }

  function cancelProviderLoginPolling() {
    providerLoginGeneration += 1;
    if (providerLoginPollTimer) clearTimeout(providerLoginPollTimer);
    providerLoginPollTimer = null;
    currentProviderLogin = null;
    providerLoginBusy = false;
    providerLoginError = "";
  }

  async function logoutProvider() {
    cancelProviderLoginPolling();
    const { provider, owns } = ownProviderLogin();
    providerLoginBusy = true; syncProviderAuthUi();
    try {
      const result = await request("logout_provider", { provider }, 10000);
      if (!owns()) return;
      providerAuth[provider] = result.authStatus || result.config?.providerAuth?.[provider] || { loggedIn: false };
      if (result.config) populateSettings(result.config);
    } catch (error) {
      if (owns()) providerLoginError = errorMessage(error) || t("signOutFailed");
    } finally {
      if (owns()) { providerLoginBusy = false; syncProviderAuthUi(); }
    }
  }

  function formatProviderExpiry(status: Partial<ProviderAuthStatus> = {}) {
    if (status.refreshError) return t("automaticRenewalFailedSignInAgain");
    if (status.hasRefreshToken) return t("renewsAutomatically");
    const value = Number(status.expiresAt || status);
    if (!Number.isFinite(value) || value <= 0) return "";
    const minutes = Math.max(0, Math.round((value - Date.now()) / 60000));
    if (minutes <= 0) return t("expired");
    if (minutes < 90) return t("expiresInMinutes", { count: String(minutes) });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t("expiresInHours", { count: String(hours) });
    return t("expiresInDays", { count: String(Math.round(hours / 24)) });
  }

  function setSettingsModelSelection(model?: string, label = "") {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return;
    const modelId = String(model || "").trim();
    const displayLabel = String(label || modelId).trim();
    input.value = displayLabel;
    if (modelId) {
      input.dataset.modelId = modelId;
      input.dataset.modelLabel = displayLabel || modelId;
    } else {
      clearSettingsModelSelection();
    }
  }

  function clearSettingsModelSelection() {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return;
    delete input.dataset.modelId;
    delete input.dataset.modelLabel;
  }

  function getSettingsModelId() {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return "";
    const value = String(input.value || "").trim();
    const selectedId = String(input.dataset.modelId || "").trim();
    const selectedLabel = String(input.dataset.modelLabel || "").trim();
    return selectedId && value === selectedLabel ? selectedId : value;
  }

  function getSettingsModelLabel() {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return "";
    const value = String(input.value || "").trim();
    const selectedLabel = String(input.dataset.modelLabel || "").trim();
    return selectedLabel && value === selectedLabel ? selectedLabel : value;
  }

  function handleSettingsModelUserChange(event: Event) {
    if (event?.type === "input") clearSettingsModelSelection();
    const nextModel = getSettingsModelId();
    updateModelClearButton();
    syncModelSuggestionsVisibility({ autoOpen: event?.type === "input" });
    if (nextModel === lastSettingsModel) return;
    clearModelScopedSettings();
    applyConfiguredModelCapabilityMatch(nextModel, $<HTMLSelectElement>("#cfg-provider")!.value);
    lastSettingsModel = nextModel;
    markSettingsPresetDirtyIfNeeded();
  }

  function clearModelScopedSettings() {
    resetModelCapabilityMatch();
    setActiveContextWindowPreset("");
    $<HTMLInputElement>("#cfg-context-window")!.value = "";
    $<HTMLSelectElement>("#cfg-vision")!.value = "false";
    setModelParameterRows({});
    currentSettingsActivePresetId = "";
    $<HTMLSelectElement>("#cfg-preset")!.value = "";
    updateContextWindowHint();
    updatePresetButtons();
  }

  function clearModelNameInput() {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return;
    if (!input.value) {
      input.focus();
      syncModelSuggestionsVisibility({ forceOpen: true });
      return;
    }
    setSettingsModelSelection("");
    lastSettingsModel = "";
    clearModelScopedSettings();
    updateModelClearButton();
    markSettingsPresetDirtyIfNeeded();
    input.focus();
    syncModelSuggestionsVisibility({ forceOpen: true });
  }

  function updateModelClearButton() {
    $<HTMLButtonElement>("#cfg-model-clear")?.classList.toggle(
      "hidden",
      providerPresentation().managedAuth || !$<HTMLInputElement>("#cfg-model")?.value,
    );
  }

  function resetModelCapabilityMatch() {
    modelCapabilityMatchSeq += 1;
  }

  async function applyConfiguredModelCapabilityMatch(modelName: string, provider: string, { markDirty = true } = {}) {
    const ticket = settingsSaveTicket();
    if (isCustomProvider(provider)) return;
    const seq = ++modelCapabilityMatchSeq;
    let match;
    try {
      ({ match } = await request("match_model_capabilities", { model: modelName, provider }, 10000));
    } catch (err) {
      if (seq === modelCapabilityMatchSeq) {
        console.warn("[轻舟] model capability match failed", err);
      }
      return;
    }
    if (seq !== modelCapabilityMatchSeq || !match.matched || ticket.generation !== settingsGeneration
      || getSettingsModelId() !== modelName || $<HTMLSelectElement>("#cfg-provider")!.value !== provider) return;
    if (match.contextWindow) {
      $<HTMLInputElement>("#cfg-context-window")!.value = formatContextWindowInput(match.contextWindow);
      syncContextWindowPresetToInput();
    }
    if (typeof match.vision === "boolean") {
      $<HTMLSelectElement>("#cfg-vision")!.value = match.vision ? "true" : "false";
    }
    updateContextWindowHint();
    if (markDirty) markSettingsPresetDirtyIfNeeded();
  }

  function syncContextWindowPresetToInput() {
    const input = $<HTMLInputElement>("#cfg-context-window");
    if (!input) return;
    const normalizedInput = normalizeContextWindowText(input.value);
    const matched = CONTEXT_WINDOW_PRESETS.find((preset) => {
      return preset.value && normalizeContextWindowText(preset.value) === normalizedInput;
    });
    setActiveContextWindowPreset(input.value.trim() ? (matched ? matched.value : CONTEXT_WINDOW_CUSTOM_VALUE) : "");
  }

  function setActiveContextWindowPreset(value: unknown) {
    const select = $<HTMLSelectElement>("#cfg-context-preset");
    if (!select) return;
    const optionValue = value === CONTEXT_WINDOW_CUSTOM_VALUE
      ? CONTEXT_WINDOW_CUSTOM_VALUE
      : getMatchingContextWindowPresetValue(value);
    select.value = optionValue;
    syncContextWindowCustomInputVisibility();
  }

  function getMatchingContextWindowPresetValue(value: unknown) {
    const normalized = normalizeContextWindowText(value);
    if (!normalized) return "";
    const matched = CONTEXT_WINDOW_PRESETS.find((preset) => {
      return preset.value && normalizeContextWindowText(preset.value) === normalized;
    });
    return matched?.value || "";
  }

  function syncContextWindowCustomInputVisibility() {
    const select = $<HTMLSelectElement>("#cfg-context-preset");
    const input = $<HTMLInputElement>("#cfg-context-window");
    const box = select?.closest?.(".context-window-box");
    if (!select || !input) return;
    const customActive = select.value === CONTEXT_WINDOW_CUSTOM_VALUE;
    input.classList.toggle("hidden", !customActive);
    input.setAttribute("aria-hidden", String(!customActive));
    if (box) box.classList.toggle("custom-active", customActive);
  }

  function applyContextWindowPresetSelection() {
    const select = $<HTMLSelectElement>("#cfg-context-preset");
    const input = $<HTMLInputElement>("#cfg-context-window");
    if (!select || !input) return;
    const value = select.value || "";
    if (value === CONTEXT_WINDOW_CUSTOM_VALUE) {
      syncContextWindowCustomInputVisibility();
      setTimeout(() => input.focus(), 0);
      return;
    }
    input.value = value;
    syncContextWindowCustomInputVisibility();
  }

  function updateContextWindowHint() {
    // The context window control is intentionally compact; avoid a persistent helper row.
  }

  function cancelProviderModelsLoad() {
    if (modelListTimer) clearTimeout(modelListTimer);
    modelListTimer = null;
    modelOptionsController.cancel();
  }

  function scheduleProviderModelsLoad() {
    // Credential edits revoke the old list immediately, before the debounced replacement starts.
    cancelProviderModelsLoad();
    modelListLoading = false;
    modelListError = "";
    applyModelOptions([], false);
    $("#cfg-model")?.removeAttribute("title");
    modelListTimer = setTimeout(() => {
      modelListTimer = null;
      loadProviderModels();
    }, 600);
  }

  function retryManagedModelListIfNeeded() {
    if (
      !providerPresentation().managedAuth
      || providerPresentation().authenticated !== true
      || modelListLoading
      || currentModelOptions.length
    ) return false;
    void loadProviderModels({ force: true });
    return true;
  }

  async function loadProviderModels({ force = false, reconcile = true } = {}) {
    cancelProviderModelsLoad();
    if (!sectionActive) return;
    modelListNeedsReload = false;
    const provider = $<HTMLSelectElement>("#cfg-provider")!.value || "fireworks";
    const apiKey = !providerNeedsApiKey(provider) ? "" : $<HTMLInputElement>("#cfg-apikey")!.value.trim();
    const modelInput = $<HTMLInputElement>("#cfg-model");
    if (!modelInput) return null;
    if (providerPresentation(provider).manualModels) {
      modelListLoading = false;
      modelListError = "";
      applyModelOptions([]);
      modelInput.setAttribute("title", providerPresentation(provider).modelHint || "");
      return;
    }
    if (isCustomProvider(provider)) {
      modelListLoading = false;
      modelListError = t("enterModelNamesManuallyForCustomEndpoints");
      applyModelOptions([]);
      modelInput.setAttribute("title", t("enterModelNamesManuallyForCustomEndpoints"));
      return;
    }
    if (providerPresentation(provider).managedAuth && providerPresentation().authenticated !== true) {
      modelListLoading = false;
      modelListError = "";
      applyModelOptions([]);
      modelInput.setAttribute("title", providerPresentation(provider).modelHint || "");
      return;
    }
    const credentialSource = providerPresentation(provider).credentialSource ?? apiKey;
    const input = {
      provider,
      apiKey,
      credentialVersion: hashModelCachePart(credentialSource),
      refresh: force,
    };
    const cached = force ? null : modelOptionsController.peek(input);
    if (cached) {
      modelListLoading = false;
      modelListError = "";
      const cachedModels = cached.models || [];
      applyModelOptions(cachedModels, reconcile);
      if (cachedModels.length) modelInput.setAttribute("title", t("modelsCached", { count: String(cachedModels.length) }));
      else modelInput.removeAttribute("title");
      return cachedModels;
    }
    modelListLoading = true;
    modelListError = "";
    modelInput.setAttribute("title", t("loadingModelList"));
    syncModelSuggestionsVisibility();
    try {
      const result = await modelOptionsController.load(input);
      if (result.stale) return null;
      const normalizedModels = result.models || [];
      modelListLoading = false;
      modelListError = "";
      applyModelOptions(normalizedModels, reconcile);
      const count = normalizedModels.length;
      if (count) modelInput.setAttribute("title", t("loadedModels", { count: String(count) }));
      else modelInput.removeAttribute("title");
      return normalizedModels;
    } catch (err) {
      modelListLoading = false;
      modelListError = product.modelError(provider, err);
      applyModelOptions([]);
      modelInput.removeAttribute("title");
      console.warn("[轻舟] list models failed", err);
      return null;
    }
  }

  function renderModelOptions(models: readonly (string | ModelOptionInput)[] = []) {
    modelListLoading = false;
    modelListError = "";
    applyModelOptions(normalizeModelOptions(models));
  }

  function applyModelOptions(options: readonly ModelOption[] = [], reconcile = true) {
    currentModelOptions = options.slice();
    if (reconcile) reconcileSettingsModelSelection(currentModelOptions);
    syncModelSuggestionsVisibility();
  }

  function reconcileSettingsModelSelection(options: readonly ModelOption[] = []) {
    const modelOptions = Array.isArray(options) ? options : [];
    if (!modelOptions.length) return;
    const currentId = getSettingsModelId();
    const normalizedCurrent = currentId.toLowerCase();
    let selected = modelOptions.find(option => option.id === currentId);
    if (!selected && normalizedCurrent) {
      selected = modelOptions.find(option => (
        option.id.toLowerCase() === normalizedCurrent
        || String(option.label || "").trim().toLowerCase() === normalizedCurrent
      ));
    }
    if (!selected && providerPresentation().managedAuth && modelOptions.length === 1) {
      [selected] = modelOptions;
    }
    if (!selected) return;

    const changed = currentId !== selected.id;
    setSettingsModelSelection(selected.id, selected.label);
    lastSettingsModel = selected.id;
    updateModelClearButton();
    if (
      providerPresentation(lastSettingsConfig?.provider).managedAuth
      && String(lastSettingsConfig?.model || "").trim() === selected.id
    ) {
      lastSettingsConfig = {
        ...lastSettingsConfig,
        modelLabel: selected.label || selected.id,
      };
      updateCurrentModelIndicator();
    }
    if (!changed) return;
    clearModelScopedSettings();
    void applyConfiguredModelCapabilityMatch(selected.id, $<HTMLSelectElement>("#cfg-provider")!.value);
    markSettingsPresetDirtyIfNeeded();
  }

  function setModelSuggestionsVisible(menu: HTMLElement | null, visible: boolean) {
    if (!menu) return;
    if (!visible) {
      if (typeof menu.hidePopover === "function" && menu.matches(":popover-open")) {
        menu.hidePopover();
      }
      menu.classList.add("hidden");
      menu.classList.remove("open-upward");
      return;
    }

    menu.classList.remove("hidden");
    if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) {
      menu.showPopover();
    }
    positionModelSuggestions();
  }

  function positionModelSuggestions() {
    const menu = $("#cfg-model-options");
    const combobox = $("#cfg-model-combobox");
    if (!menu || !combobox || !modelSuggestionsOpen) return;

    const rect = combobox.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const preferredMaxHeight = 242;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const width = Math.min(rect.width, Math.max(0, viewportWidth - margin * 2));
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, viewportWidth - margin - width));
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap - margin);
    const spaceAbove = Math.max(0, rect.top - gap - margin);
    const openUpward = spaceBelow < 144 && spaceAbove > spaceBelow;
    const availableHeight = openUpward ? spaceAbove : spaceBelow;

    menu.classList.toggle("open-upward", openUpward);
    menu.style.setProperty("--model-menu-left", `${Math.round(left)}px`);
    menu.style.setProperty("--model-menu-width", `${Math.round(width)}px`);
    menu.style.setProperty("--model-menu-max-height", `${Math.max(48, Math.min(preferredMaxHeight, Math.floor(availableHeight)))}px`);
    menu.style.setProperty("--model-menu-top", `${Math.round(rect.bottom + gap)}px`);
    menu.style.setProperty("--model-menu-bottom", `${Math.round(viewportHeight - rect.top + gap)}px`);
  }

  function renderModelSuggestions() {
    const menu = $("#cfg-model-options");
    const input = $<HTMLInputElement>("#cfg-model");
    const combobox = $("#cfg-model-combobox");
    if (!menu || !input || !combobox) return;

    input.setAttribute("aria-expanded", String(modelSuggestionsOpen));
    combobox.classList.toggle("open", modelSuggestionsOpen);
    if (!modelSuggestionsOpen) {
      setModelSuggestionsVisible(menu, false);
      menu.innerHTML = "";
      input.removeAttribute("aria-activedescendant");
      modelSuggestionsShowAll = false;
      modelSuggestionActiveIndex = -1;
      filteredModelOptions = [];
      return;
    }

    const query = input.value;
    if (query !== lastModelSuggestionQuery) {
      lastModelSuggestionQuery = query;
      // A changed selection resets navigation, not the explicit request to reopen it.
      modelSuggestionActiveIndex = -1;
    }
    const suggestionState = computeModelSuggestionState({
      query,
      options: currentModelOptions,
      limit: MODEL_SUGGESTION_LIMIT,
      showAllOnExactMatch: modelSuggestionsShowAll,
    });
    if (suggestionState.hidden) {
      modelSuggestionsOpen = false;
      input.setAttribute("aria-expanded", "false");
      combobox.classList.remove("open");
      setModelSuggestionsVisible(menu, false);
      menu.innerHTML = "";
      input.removeAttribute("aria-activedescendant");
      modelSuggestionsShowAll = false;
      modelSuggestionActiveIndex = -1;
      filteredModelOptions = [];
      return;
    }
    filteredModelOptions = suggestionState.visibleOptions;
    setModelSuggestionsVisible(menu, true);

    if (modelListLoading) {
      menu.innerHTML = `<div class="qz-combobox-empty model-suggestion-empty">${escapeHtml(t("loadingModelList"))}</div>`;
      input.removeAttribute("aria-activedescendant");
      modelSuggestionActiveIndex = -1;
      return;
    }

    if (!filteredModelOptions.length) {
      const message = modelListError
        ? modelListError
        : currentModelOptions.length
          ? (providerPresentation().managedAuth ? t("noMatchingModelsAvailable") : t("noMatchingModelsYouCanEnterANameManually"))
          : (providerPresentation().managedAuth ? providerPresentation().noModels : t("noModelListAvailableYouCanEnterANameManually"));
      menu.innerHTML = `<div class="qz-combobox-empty model-suggestion-empty" role="option" aria-disabled="true">${escapeHtml(message)}</div>`;
      input.removeAttribute("aria-activedescendant");
      modelSuggestionActiveIndex = -1;
      return;
    }

    if (modelSuggestionActiveIndex < 0 || modelSuggestionActiveIndex >= filteredModelOptions.length) {
      modelSuggestionActiveIndex = 0;
    }
    menu.innerHTML = filteredModelOptions.map((model, index) => {
      const active = index === modelSuggestionActiveIndex;
      const meta = model.meta ? `<span class="qz-combobox-option-meta model-suggestion-meta">${escapeHtml(model.meta)}</span>` : "";
      return `
        <button
          id="cfg-model-option-${index}"
          class="qz-menu-item qz-combobox-option model-suggestion-item${active ? " active" : ""}"
          type="button"
          role="option"
          aria-selected="${active ? "true" : "false"}"
          data-model-index="${index}"
        >
          <span class="qz-combobox-option-name model-suggestion-name">${escapeHtml(model.label || model.id)}</span>
          ${meta}
        </button>
      `;
    }).join("");
    updateModelActiveDescendant();
  }

  function openModelSuggestions({ showAllOnExactMatch = false } = {}) {
    const input = $<HTMLInputElement>("#cfg-model");
    if (providerPresentation().manualModels) {
      closeModelSuggestions();
      return;
    }
    if (showAllOnExactMatch && input) {
      modelSuggestionsShowAll = shouldHideUniqueExactModelSuggestion(
        input.value,
        filterModelOptions(input.value, currentModelOptions),
      );
    } else {
      modelSuggestionsShowAll = false;
    }
    modelSuggestionsOpen = true;
    renderModelSuggestions();
  }

  function closeModelSuggestions() {
    if (!modelSuggestionsOpen) return;
    modelSuggestionsOpen = false;
    modelSuggestionsShowAll = false;
    renderModelSuggestions();
  }

  function syncModelSuggestionsVisibility({ forceOpen = false, autoOpen = false, showAllOnExactMatch = false } = {}) {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return;
    if (providerPresentation().manualModels) {
      closeModelSuggestions();
      return;
    }
    if (providerPresentation().managedAuth && providerPresentation().authenticated !== true) {
      closeModelSuggestions();
      return;
    }
    if (forceOpen) {
      openModelSuggestions({ showAllOnExactMatch });
      return;
    }
    modelSuggestionsShowAll = false;

    const hasInputFocus = document.activeElement === input;
    if (hasInputFocus || autoOpen) {
      const isEmptyQuery = !String(input.value || "").trim();
      const matches = filterModelOptions(input.value, currentModelOptions);
      const shouldShow = modelListLoading
        || isEmptyQuery
        || (matches.length > 0 && !shouldHideUniqueExactModelSuggestion(input.value, matches));
      if (shouldShow) modelSuggestionsOpen = true;
      else if (autoOpen || shouldHideUniqueExactModelSuggestion(input.value, matches)) modelSuggestionsOpen = false;
    }
    renderModelSuggestions();
  }

  function handleModelComboboxKeydownImpl(event: KeyboardEvent) {
    if (event.isComposing || providerPresentation().manualModels) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!modelSuggestionsOpen) openModelSuggestions({ showAllOnExactMatch: true });
      else setModelSuggestionActiveIndex(modelSuggestionActiveIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!modelSuggestionsOpen) openModelSuggestions({ showAllOnExactMatch: true });
      else setModelSuggestionActiveIndex(modelSuggestionActiveIndex - 1);
      return;
    }
    if (event.key === "Enter" && modelSuggestionsOpen && modelSuggestionActiveIndex >= 0) {
      event.preventDefault();
      selectModelSuggestion(modelSuggestionActiveIndex);
      return;
    }
    if (event.key === "Escape" && modelSuggestionsOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeModelSuggestions();
      return;
    }
    if (event.key === "Tab") {
      closeModelSuggestions();
    }
  }

  function setModelSuggestionActiveIndex(index: number) {
    if (!filteredModelOptions.length) return;
    const next = (index + filteredModelOptions.length) % filteredModelOptions.length;
    modelSuggestionActiveIndex = next;
    $("#cfg-model-options")?.querySelectorAll<HTMLElement>(".model-suggestion-item").forEach((item, itemIndex) => {
      const active = itemIndex === next;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
      if (active) item.scrollIntoView({ block: "nearest" });
    });
    updateModelActiveDescendant();
  }

  function updateModelActiveDescendant() {
    const input = $<HTMLInputElement>("#cfg-model");
    if (!input) return;
    if (modelSuggestionActiveIndex >= 0) {
      input.setAttribute("aria-activedescendant", `cfg-model-option-${modelSuggestionActiveIndex}`);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function selectModelSuggestion(index: number) {
    const option = filteredModelOptions[index];
    if (!option?.id) return;
    const input = $<HTMLInputElement>("#cfg-model");
    const nextModel = option.id;
    const changed = getSettingsModelId() !== nextModel;
    setSettingsModelSelection(nextModel, option.label);
    updateModelClearButton();
    closeModelSuggestions();
    input?.focus();
    if (changed) {
      clearModelScopedSettings();
      applyConfiguredModelCapabilityMatch(nextModel, $<HTMLSelectElement>("#cfg-provider")!.value);
      lastSettingsModel = nextModel;
      markSettingsPresetDirtyIfNeeded();
    } else {
      applyConfiguredModelCapabilityMatch(nextModel, $<HTMLSelectElement>("#cfg-provider")!.value);
    }
  }

  function hashModelCachePart(value: unknown) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(36)}:${text.length}`;
  }

  function getMatchingSelectedPresetId() {
    const selectedId = $<HTMLSelectElement>("#cfg-preset")!.value;
    const preset = currentSettingsPresets.find(p => p.id === selectedId);
    return preset && settingsFieldsMatchPreset(preset) ? preset.id : "";
  }

  function settingsFieldsMatchPreset(preset: ModelPreset) {
    const fields = readSettingsConfigFields();
    const presetProvider = preset.provider || "fireworks";
    const presetApiKey = getPresetApiKeyForSettings(preset);
    return fields.provider === presetProvider
      && fields.apiKey === presetApiKey
      && fields.model === (preset.model || "")
      && fields._modelParametersSnapshot === serializeModelParameters(preset.modelParameters)
      && JSON.stringify(normalizeProviderModelOptions(fields, providerSummary(presetProvider)?.modelOptions)) === JSON.stringify(normalizeProviderModelOptions(preset, providerSummary(presetProvider)?.modelOptions))
      && fields.customProtocol === (isCustomProvider(presetProvider) ? normalizeCustomProtocol(preset.customProtocol) : "")
      && String(fields.customEndpoint || "").trim() === (isCustomProvider(presetProvider) ? String(preset.customEndpoint || "").trim() : "")
      && String(fields.customPresetName || "").trim() === (isCustomProvider(presetProvider) ? String(preset.customPresetName || "").trim() : "")
      && normalizeContextWindowText(fields.contextWindow) === normalizeContextWindowText(preset.contextWindow)
      && fields.trimOldToolResults === (preset.trimOldToolResults !== false)
      && fields.vision === Boolean(preset.vision);
  }

  function markSettingsPresetDirtyIfNeeded() {
    settingsEditRevision += 1;
    settingsSaveErrorMessage = "";
    const selectedId = $<HTMLSelectElement>("#cfg-preset")!.value;
    if (!selectedId) {
      updatePresetButtons();
      updateSettingsSaveState();
      return;
    }
    const preset = currentSettingsPresets.find(p => p.id === selectedId);
    if (preset && settingsFieldsMatchPreset(preset)) {
      currentSettingsActivePresetId = selectedId;
    } else {
      currentSettingsActivePresetId = "";
      $<HTMLSelectElement>("#cfg-preset")!.value = "";
    }
    updatePresetButtons();
    updateSettingsSaveState();
  }

  function updatePresetButtons() {
    const hasPresetSelected = Boolean($<HTMLSelectElement>("#cfg-preset")!.value);
    btnDeletePreset.disabled = !hasPresetSelected;
  }

  function normalizeContextWindowText(value: unknown) {
    if (typeof value === "number") return formatContextWindowInput(value).toLowerCase();
    const raw = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
    if (!match) return raw;
    const base = Number(match[1]);
    if (!Number.isFinite(base) || base <= 0) return raw;
    const unit = match[2] || "";
    const multiplier = unit === "m" ? 1000000 : unit === "k" ? 1000 : 1;
    return formatContextWindowInput(Math.round(base * multiplier)).toLowerCase();
  }

  function formatContextWindowInput(value: unknown) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n % 1000000 === 0) return `${n / 1000000}M`;
    if (n % 1000 === 0) return `${n / 1000}K`;
    return String(Math.round(n));
  }



  const settingsSections: UiSettingsSection[] = [
    { id: "model", title: t("model"), order: 10 },
    { id: "skills", title: t("skills"), order: 20, visible: hasAvailableSkillSettings },
    { id: "advanced", title: t("advanced"), order: 30, tab: { id: "advanced", title: t("advanced"), order: 30 } },
  ].map(section => ({
    ...section,
    element: $(`#settings-panel-${section.id}`)!,
    activate: () => activateSettingsSection(section.id),
    deactivate: deactivateSettingsSection,
    save: handleSaveSettings,
  }));

  function dispose() {
    sectionActive = false;
    cancelProviderLoginPolling();
    resetModelCapabilityMatch();
    invalidateSettingsSaves();
    cancelProviderModelsLoad();
    if (shortcutRefreshTimer) window.clearInterval(shortcutRefreshTimer);
    modelPresetSwitcher.closeIfOpen();
    providerPicker.dispose();
    closeModelSuggestions();
    closeModelParameterSuggestions();
  }

  return {
    dispose,
    settingsSections,
    open: openSettingsPanel,
    openPresetSwitcher: openModelPresetSwitcher,
    applyConfig: populateSettings,
    applySavedConfig,
    refreshSkillSettings,
    closePresetSwitcherIfOpen,
    closeProviderPickerIfOpen: () => providerPicker.close(),
    closeModelSuggestionsIfOpen,
    hasBlockingOverlay,
    renderWelcomeOnboarding,
    getOnboardingSetupStatus,
    setupIntent: product.setupIntent,
    handleProductEvent: product.handleEvent,
    showGptConnectHint,
    hideGptConnectHint,
    renderGptConnectHint,
  };
}


function isElementVisible(element: Element | null) {
  return Boolean(element && !element.classList.contains("hidden"));
}

function errorMessage(error: unknown) {
  return error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
}

function eventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}
