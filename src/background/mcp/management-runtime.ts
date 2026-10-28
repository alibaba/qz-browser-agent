import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { SkillRecord } from "../../shared/skills/skill-utils.js";
import { isBuiltinSkill } from "../../shared/skills/builtin-skills.js";
import { exportSkillsZip } from "../../shared/skills/skill-package.js";
import { completeCustomProviderEndpoint } from "../../shared/models/custom-provider-endpoint.js";
import { normalizeModelParameters } from "../../shared/models/model-parameters.js";
import { productText } from "../../shared/product-text.js";

type Fields = Record<string, unknown>;
interface Field { key: string; type: string; description: string; values?: string[]; secret?: boolean }
interface Options {
  config: {
    get(): Promise<RuntimeConfig>;
    save(patch: Fields, signal?: AbortSignal): Promise<RuntimeConfig>;
    applyPreset?(id: string, signal?: AbortSignal): Promise<RuntimeConfig>;
  };
  skills: { load(name: string): Promise<SkillRecord | null> };
  download(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<Fields>;
  language?: {
    get(): Promise<string>;
    save(value: string): Promise<unknown>;
    list(): readonly { language: string; name: string }[];
  };
}
const field = (key: string, type: string, description: string, extra: Partial<Field> = {}): Field => ({ key, type, description, ...extra });
const MODEL_FIELDS = [
  field("provider", "string", "Provider ID from providers."),
  field("apiKey", "string", "Write-only API key for the selected provider.", { secret: true }),
  field("model", "string", "Model ID accepted by the provider."),
  field("modelLabel", "string", "Optional display name for the model."),
  field("customProtocol", "string", "Protocol ID from customProtocols; used by the custom provider."),
  field("customEndpoint", "string", "HTTP(S) endpoint for the custom provider."),
  field("customPresetName", "string", "Display name for a custom provider preset."),
  field("contextWindow", "number|string", "Positive token count, or a value such as 128k or 1m."),
  field("modelParameters", "object", "Provider request parameters; replaces the existing parameter object."),
  field("trimOldToolResults", "boolean", "Trim older tool results from model context."),
  field("vision", "boolean", "Enable image input when supported by the selected model."),
  field("requestRateLimit", "boolean", "Enable model request rate limiting."),
  field("debugMode", "boolean", "Enable diagnostic tracing."),
];
const SECRET_KEY = /api.?key|password|secret|credential|authorization|cookie|(?:access|refresh|auth).?token|^token$/i;
const record = (value: unknown): Fields | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Fields : null;
};
const rows = (value: unknown) => Array.isArray(value) ? value.map(item => record(item) || {}) : [];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** MCP management uses the same settings and Skill owners as the side panel. */
export function createMcpManagementRuntime(options: Options) {
  let updates: Promise<unknown> = Promise.resolve();

  function editableFields(config: RuntimeConfig): Field[] {
    const selected = rows(config.providers).find(provider => provider.id === config.provider);
    return [
      ...MODEL_FIELDS,
      ...rows(selected?.modelOptions).map(option => field(text(option.key), "string", text(option.label), {
        values: rows(option.options).map(choice => text(choice.value)),
      })).filter(option => option.key && !MODEL_FIELDS.some(base => base.key === option.key)
        && !["language", "activePresetId", "securityGuardrails", "dataConsent", "__proto__", "constructor", "prototype"].includes(option.key)
        && !SECRET_KEY.test(option.key)),
      ...(options.config.applyPreset ? [field("activePresetId", "string", "Apply a saved preset by ID; set it separately from other model settings.", {
        values: rows(config.presets).map(preset => text(preset.id)),
      })] : []),
      ...(options.language ? [field("language", "string", productText("Interface language; reopen the side panel after changing it.", "Interface language; reopen the sidebar after changing it."), {
        values: ["system", ...options.language.list().map(item => item.language)],
      })] : []),
    ];
  }

  async function snapshot(raw: RuntimeConfig) {
    const secrets = collectSecrets(raw);
    const fields = editableFields(raw);
    const safe: Fields = Object.fromEntries(fields.filter(item => !item.secret && Object.hasOwn(raw, item.key))
      .map(item => [item.key, redact(raw[item.key], secrets)]));
    for (const key of ["providerLabel", "endpoint", "activePresetId"]) {
      if (Object.hasOwn(raw, key)) safe[key] = redact(raw[key], secrets);
    }
    safe.hasApiKey = Boolean(text(raw.apiKey));
    for (const key of ["endpoint", "customEndpoint"]) if (typeof safe[key] === "string") safe[key] = safeEndpoint(safe[key]);
    safe.presets = rows(raw.presets).map(preset => ({
      id: text(preset.id), name: redact(preset.name, secrets), provider: text(preset.provider),
      model: redact(preset.model, secrets), customEndpoint: safeEndpoint(redactText(text(preset.customEndpoint), secrets)),
      hasApiKey: Boolean(text(preset.apiKey)),
    }));
    safe.providerKeysConfigured = Object.fromEntries(Object.entries(record(raw.providerApiKeys) || {})
      .map(([provider, value]) => [provider, Boolean(text(value))]));
    if (options.language) safe.language = await options.language.get();
    return {
      config: safe, fields,
      providers: rows(raw.providers).map(provider => {
        const status = record(record(raw.providerAuth)?.[text(provider.id)]);
        return {
          id: text(provider.id), label: text(provider.label), requiresApiKey: provider.requiresApiKey === true,
          auth: provider.auth ? { mode: "sign_in", loggedIn: status?.loggedIn === true, expired: status?.expired === true }
            : { mode: provider.requiresApiKey === true ? "api_key" : "none" },
        };
      }),
      customProtocols: rows(raw.customProtocols).map(protocol => ({ id: text(protocol.id), label: text(protocol.label) })),
      ...(options.language ? { languages: options.language.list() } : {}),
    };
  }

  async function getSettings(params: Fields = {}) {
    const result = await snapshot(await options.config.get());
    if (params.key === undefined) return result;
    const key = text(params.key);
    const definition = result.fields.find(item => item.key === key);
    if (key === "apiKey") return { key, value: { configured: result.config.hasApiKey }, field: definition };
    if (!Object.hasOwn(result.config, key)) throw failure("UNKNOWN_SETTING", "Unknown setting. Read settings without a key to discover available fields.");
    return { key, value: result.config[key], ...(definition ? { field: definition } : {}) };
  }

  function updateSettings(params: Fields = {}, signal?: AbortSignal) {
    const supplied = record(params.config);
    if (!supplied || !Object.keys(supplied).length) return Promise.reject(failure("INVALID_SETTINGS", "Provide a non-empty config object containing editable settings."));
    const patch = structuredClone(supplied);
    const operation = updates.then(async () => {
      signal?.throwIfAborted();
      const current = await options.config.get();
      signal?.throwIfAborted();
      const secrets = collectSecrets({ current, patch });
      let modelSaved = false;
      try {
        const validated = validatePatch(current, patch, editableFields({ ...current, provider: typeof patch.provider === "string" ? patch.provider : current.provider }));
        const { language, activePresetId, ...modelPatch } = validated;
        let saved = current;
        if (activePresetId !== undefined) {
          if (Object.keys(modelPatch).length) throw failure("INVALID_SETTINGS", "Apply activePresetId separately from other model settings.");
          saved = await options.config.applyPreset!(String(activePresetId), signal);
          modelSaved = true;
        } else if (Object.keys(modelPatch).length) {
          // The owner merges this patch with persisted settings and preserves unrelated credentials.
          // A provider switch must never forward the previous provider's API key.
          if (modelPatch.provider !== undefined && modelPatch.provider !== current.provider && !Object.hasOwn(modelPatch, "apiKey")) {
            modelPatch.apiKey = text(record(current.providerApiKeys)?.[String(modelPatch.provider)]);
          }
          const next = { ...current, ...modelPatch };
          if (next.provider === "custom" && text(next.apiKey) && !Object.hasOwn(patch, "apiKey")
            && completeCustomProviderEndpoint(next.customEndpoint, next.customProtocol) !== completeCustomProviderEndpoint(current.customEndpoint, current.customProtocol)) {
            throw failure("API_KEY_REQUIRED", "Include apiKey explicitly when changing a custom endpoint so credentials are sent only to the intended service.");
          }
          saved = await options.config.save(modelPatch, signal);
          modelSaved = true;
        }
        if (language !== undefined) {
          signal?.throwIfAborted();
          await options.language!.save(String(language));
        }
        return { updated: Object.keys(patch), ...await snapshot(saved) };
      } catch (error) {
        const code = modelSaved ? "SETTINGS_PARTIALLY_UPDATED" : text(record(error)?.code) || String((error as { code?: unknown })?.code || "SETTINGS_UPDATE_FAILED");
        const message = error instanceof Error ? error.message : "Could not update settings.";
        throw failure(code, `${modelSaved ? "Model settings were saved; a subsequent settings step failed. " : ""}${redactText(message, secrets)}`);
      }
    });
    updates = operation.catch(() => {});
    return operation;
  }

  async function exportSkill(params: Fields = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const name = text(params.name);
    if (!name) throw failure("INVALID_ARGUMENTS", "Provide the Skill name from list_skills.");
    const skill = await options.skills.load(name);
    signal?.throwIfAborted();
    if (!skill) throw failure("SKILL_NOT_FOUND", "The Skill was not found. Read list_skills for available names.");
    if (isBuiltinSkill(skill)) throw failure("SKILL_EXPORT_UNSUPPORTED", "Built-in Skills depend on the installed extension and cannot be exported as standalone packages.");
    const filename = params.filename === undefined ? `${skill.name}.zip` : text(params.filename);
    if (!filename || !/\.zip$/i.test(filename) || /[\\/\u0000-\u001f]/.test(filename) || filename === ".zip" || filename.includes("..")) {
      throw failure("INVALID_FILENAME", "Use a ZIP filename without directories, for example my-skill.zip.");
    }
    const blob = await exportSkillsZip([skill]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted();
    const result = await options.download({ bytes, filename, mimeType: "application/zip" });
    return { ...result, name: skill.name, resourceCount: skill.resources.length };
  }

  return Object.freeze({ getSettings, updateSettings, exportSkill });
}

function validatePatch(current: RuntimeConfig, patch: Fields, definitions: Field[]) {
  const next: Fields = {};
  const byKey = new Map(definitions.map(definition => [definition.key, definition]));
  for (const [key, value] of Object.entries(patch)) {
    const definition = byKey.get(key);
    if (!definition) throw failure("UNKNOWN_SETTING", `Setting ${key} is not editable. Read settings for supported fields.`);
    if (definition.type === "boolean" && typeof value !== "boolean") throw failure("INVALID_SETTINGS", `${key} requires a boolean.`);
    if (definition.type === "string" && typeof value !== "string") throw failure("INVALID_SETTINGS", `${key} requires a string.`);
    if (definition.values && !definition.values.includes(String(value))) throw failure("INVALID_SETTINGS", `${key} must use one of its listed values.`);
    if (key === "provider" && !rows(current.providers).some(provider => provider.id === value)) throw failure("INVALID_SETTINGS", "Use a provider ID listed in settings.providers.");
    if (key === "customProtocol" && !rows(current.customProtocols).some(protocol => protocol.id === value)) throw failure("INVALID_SETTINGS", "Use a protocol ID listed in settings.customProtocols.");
    if (key === "customEndpoint") {
      let url: URL;
      try { url = new URL(completeCustomProviderEndpoint(value, patch.customProtocol ?? current.customProtocol)); }
      catch { throw failure("INVALID_SETTINGS", "customEndpoint requires an HTTP(S) URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw failure("INVALID_SETTINGS", "Use an HTTP(S) endpoint without embedded credentials.");
    }
    if (key === "contextWindow" && !((typeof value === "number" && Number.isFinite(value) && value > 0)
      || (typeof value === "string" && /^\d+(?:\.\d+)?\s*[km]?$/i.test(value.trim()) && Number.parseFloat(value) > 0))) {
      throw failure("INVALID_SETTINGS", "contextWindow requires a positive token count, such as 128000 or 128k.");
    }
    if (key === "modelParameters" && !record(value)) throw failure("INVALID_SETTINGS", "modelParameters requires a JSON object.");
    next[key] = key === "modelParameters" ? normalizeModelParameters(value, { strict: true }) : value;
  }
  return next;
}

function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }
function collectSecrets(value: unknown, inherited = false, result = new Set<string>()): Set<string> {
  if (typeof value === "string") { if (inherited && value) result.add(value); return result; }
  if (Array.isArray(value)) { for (const item of value) collectSecrets(item, inherited, result); }
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collectSecrets(item, inherited || SECRET_KEY.test(key), result);
  return result;
}
function redactText(value: string, secrets: Set<string>) {
  let result = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join("[configured]");
  return result;
}
function redact(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (record(value)) return Object.fromEntries(Object.entries(value as Fields).map(([key, item]) => [key,
    SECRET_KEY.test(key) ? { configured: Boolean(item) } : redact(item, secrets)]));
  return value;
}
function safeEndpoint(value: string) {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = ""; url.password = "";
    for (const key of url.searchParams.keys()) url.searchParams.set(key, "[configured]");
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}
