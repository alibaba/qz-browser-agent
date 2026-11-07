import { createTranslator } from "#sdk/shared/i18n";
import messages from "./messages.js";
import type { ProviderDefinition, ProviderModelDiscovery } from "#sdk/background/providers";

const t = createTranslator(messages);
const BASE_URL = "http://127.0.0.1:3425/v1";

/** Magpie's OpenAI /models includes its configured model limits and input modalities. */
async function listModels({ definition, apiKey, read }: ProviderModelDiscovery) {
  const endpoint = new URL(String(definition.endpoint));
  endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions\/?$/, "/models");
  const { response, text } = await read(endpoint.href, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
  if (!response.ok) throw new Error(`Magpie Models API ${response.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (!Array.isArray(body?.data)) throw new Error("Magpie Models API did not return a model list.");
  return body.data.filter((model: unknown): model is Record<string, unknown> =>
    !!model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string",
  ).map((model: Record<string, unknown>) => {
    const modalities = model.modalities as { input?: unknown } | undefined;
    const input = modalities?.input;
    return {
      id: model.id, label: model.display_name, ownedBy: model.owned_by,
      contextWindow: model.context_window, maxOutputTokens: model.max_output_tokens,
      ...(Array.isArray(input) ? { vision: input.includes("image") } : {}),
    };
  });
}

export default {
  magpie: {
    label: "Magpie",
    group: { id: "all", get label() { return t("allProviders"); }, priority: 100 },
    api: "openai-chat-completions", protocol: "openai",
    endpoint: `${BASE_URL}/chat/completions`, editableEndpoint: BASE_URL,
    modelsEndpoint: `${BASE_URL}/models`, modelsAuth: false,
    requiresApiKey: false, modelsIncludeCapabilities: true,
    outputTokenParam: "max_tokens", listModels,
  },
} satisfies Readonly<Record<string, ProviderDefinition>>;
