import { t } from "./i18n.js";
import type { ProviderDefinition } from "#sdk/background/providers";
import { createModelsDevPresets } from "./models-dev-presets.js";
import modelCapabilities from "./model-capabilities.js";

// Public service data comes from the SDK; only user-supplied endpoints live here.
export default {
  ...createModelsDevPresets(modelCapabilities.modelsDev),
  custom: {
    group: { id: "custom", get label() { return t("customProviderGroup"); }, priority: 300 },
    get label() { return t("customEndpoint"); },
    api: "openai-chat-completions",
    protocol: "openai",
    endpoint: "",
    modelsEndpoint: "",
    modelsAuth: false,
    requiresApiKey: false,
    defaultContextWindow: 128000,
    custom: true,
  },
} satisfies Readonly<Record<string, ProviderDefinition>>;
