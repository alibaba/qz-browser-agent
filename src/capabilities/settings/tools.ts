import { modelT } from "./model-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { ToolContext, ToolArguments } from "#sdk/background";
import type { ToolSkillSetting } from "#sdk/background";
import type { GuardrailRule } from "#sdk/shared/security";
type AlertsSettingsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "clampLimit" | "secondsToMs"
  | "getToolRuntimeDependencies" | "models">;
type SettingsInput = Partial<ToolArguments<typeof QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS>> & { id?: string; activePresetId?: string };
type GuardrailsInput = Partial<ToolArguments<typeof QINGZHOU_MANAGE_GUARDRAILS_TOOL_PARAMETERS>>;
type SkillSettingsInput = Partial<ToolArguments<typeof QINGZHOU_MANAGE_SKILL_SETTINGS_TOOL_PARAMETERS>>;
import type { SettingsConfig } from "#sdk/shared/settings";
interface AlertRateState { timestamps: number[]; dedupe: Record<string, unknown> }
import { requireToolFields } from "#sdk/background/tools";
import { getQingzhouManageGuardrailsToolDescription, QINGZHOU_MANAGE_GUARDRAILS_TOOL_PARAMETERS, getQingzhouManageSkillSettingsToolDescription, QINGZHOU_MANAGE_SKILL_SETTINGS_TOOL_PARAMETERS, getQingzhouManageSettingsToolDescription, QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS } from "./embedded-skill.js";
import { matchConfiguredModelCapabilities } from "#sdk/background/model-discovery";
import { normalizeModelParameters } from "#sdk/shared/models";
import {
  getSecurityGuardrails,
  normalizeGuardrailRuleInput,
  normalizeSiteOpenRateLimitInput,
  saveSecurityGuardrails,
} from "#sdk/shared/security";
import { trace as toolTrace } from "#sdk/background/tools";

const SEND_ALERT_RATE_LIMIT_STORAGE_KEY = "_qz_send_alert_rate_limit_v1";
const SEND_ALERT_RATE_LIMIT_POLICY = Object.freeze({
  minIntervalMs: 5000,
  windowMs: 60 * 1000,
  maxPerWindow: 3,
  duplicateWindowMs: 2 * 60 * 1000,
  maxTitleChars: 80,
  maxMessageChars: 600,
  maxDedupeEntries: 80,
});

/** Registers user alerts plus self-management settings and guardrails. */
export function registerAlertsSettingsTools({
  registerTool,
  ToolExecutionError,
  clampLimit,
  secondsToMs,
  getToolRuntimeDependencies,
  models: { getConfig, saveConfig, applyPreset: applyModelPreset, deletePreset: deleteModelPreset, listModels, listProviders: listProviderSummaries },
}: AlertsSettingsHost) {
  let sendAlertRateQueue = Promise.resolve();

function normalizeSendAlertText(value: unknown, { fallback = "", maxChars = 200 } = {}) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || fallback;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function normalizeSendAlertLevel(level: unknown) {
  const value = String(level || "").trim().toLowerCase();
  return ["info", "success", "warning", "error"].includes(value) ? value : "info";
}

function sendAlertPriority(level: string) {
  if (level === "error") return 2;
  if (level === "warning") return 1;
  return 0;
}

function simpleHash(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeSendAlertDedupeKey({ title, message, dedupeKey }: { title: string; message: string; dedupeKey?: string }) {
  const explicit = String(dedupeKey || "").trim();
  const raw = explicit || `${title}\n${message}`;
  return simpleHash(raw).slice(0, 32);
}

async function readSendAlertRateState(now = Date.now()) {
  const saved = await chromeStorageLocalGet(SEND_ALERT_RATE_LIMIT_STORAGE_KEY);
  const raw = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  const timestamps = Array.isArray(raw.timestamps)
    ? raw.timestamps.map(Number).filter(value => Number.isFinite(value) && value > 0)
    : [];
  const dedupe = raw.dedupe && typeof raw.dedupe === "object" && !Array.isArray(raw.dedupe)
    ? raw.dedupe as Record<string, unknown>
    : {};
  return pruneSendAlertRateState({ timestamps, dedupe }, now);
}

function pruneSendAlertRateState(state: AlertRateState, now = Date.now()) {
  const minTimestamp = now - SEND_ALERT_RATE_LIMIT_POLICY.windowMs;
  const minDedupeTimestamp = now - SEND_ALERT_RATE_LIMIT_POLICY.duplicateWindowMs;
  const timestamps = (state.timestamps || [])
    .map(Number)
    .filter(value => Number.isFinite(value) && value > minTimestamp)
    .sort((a, b) => a - b);
  const dedupeEntries = Object.entries(state.dedupe || {})
    .map(([key, value]): [string, number] => [String(key), Number(value)])
    .filter(([key, value]) => key && Number.isFinite(value) && value > minDedupeTimestamp)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEND_ALERT_RATE_LIMIT_POLICY.maxDedupeEntries);
  return {
    timestamps,
    dedupe: Object.fromEntries(dedupeEntries),
  };
}

function getSendAlertRateDecision(state: AlertRateState, now: number, dedupeKey: string) {
  const duplicateAt = Number(state.dedupe?.[dedupeKey] || 0);
  if (duplicateAt && now - duplicateAt < SEND_ALERT_RATE_LIMIT_POLICY.duplicateWindowMs) {
    return {
      allowed: false,
      reason: "duplicate",
      retryAfterMs: SEND_ALERT_RATE_LIMIT_POLICY.duplicateWindowMs - (now - duplicateAt),
    };
  }

  const latestAt = Math.max(0, ...state.timestamps);
  if (latestAt && now - latestAt < SEND_ALERT_RATE_LIMIT_POLICY.minIntervalMs) {
    return {
      allowed: false,
      reason: "too_soon",
      retryAfterMs: SEND_ALERT_RATE_LIMIT_POLICY.minIntervalMs - (now - latestAt),
    };
  }

  if (state.timestamps.length >= SEND_ALERT_RATE_LIMIT_POLICY.maxPerWindow) {
    const oldestAt = Math.min(...state.timestamps);
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfterMs: SEND_ALERT_RATE_LIMIT_POLICY.windowMs - (now - oldestAt),
    };
  }

  return { allowed: true, reason: "", retryAfterMs: 0 };
}

async function withSendAlertRateLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = sendAlertRateQueue.catch(() => {});
  let release = () => {};
  sendAlertRateQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

async function chromeStorageLocalGet(key: string): Promise<unknown> {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.get) return undefined;
  const result = await storage.get(key);
  return result?.[key];
}

async function chromeStorageLocalSet(values: Record<string, unknown>) {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.set) return;
  await storage.set(values);
}

async function getSendAlertNotificationPermissionLevel() {
  const notifications = globalThis.chrome?.notifications;
  if (!notifications?.getPermissionLevel) return "";
  return new Promise((resolve) => {
    notifications.getPermissionLevel((level) => resolve(level || ""));
  });
}

async function createSendAlertNotification(notificationId: string, options: chrome.notifications.NotificationCreateOptions) {
  const notifications = globalThis.chrome?.notifications;
  if (!notifications?.create) {
    throw new ToolExecutionError("SEND_ALERT_UNAVAILABLE", t("notificationsUnavailable"), {});
  }
  const permissionLevel = await getSendAlertNotificationPermissionLevel();
  if (permissionLevel && permissionLevel !== "granted") {
    throw new ToolExecutionError("SEND_ALERT_PERMISSION_DENIED", t("notificationPermission", { permission: String(permissionLevel) }), {
      permissionLevel,
    });
  }
  return new Promise((resolve, reject) => {
    notifications.create(notificationId, options, (createdId) => {
      const err = globalThis.chrome?.runtime?.lastError;
      if (err) reject(new ToolExecutionError("SEND_ALERT_FAILED", err.message || t("notificationFailed"), {}));
      else resolve(createdId || notificationId);
    });
  });
}

function sendAlertResultPolicy() {
  return {
    minIntervalMs: SEND_ALERT_RATE_LIMIT_POLICY.minIntervalMs,
    windowMs: SEND_ALERT_RATE_LIMIT_POLICY.windowMs,
    maxPerWindow: SEND_ALERT_RATE_LIMIT_POLICY.maxPerWindow,
    duplicateWindowMs: SEND_ALERT_RATE_LIMIT_POLICY.duplicateWindowMs,
  };
}

async function sendBrowserAlert({ title, message, level, dedupeKey, sessionId = "" }: { title?: string; message: string; level?: string; dedupeKey?: string; sessionId?: string }) {
  const normalizedTitle = normalizeSendAlertText(title, {
    fallback: t("qingzhouReminder"),
    maxChars: SEND_ALERT_RATE_LIMIT_POLICY.maxTitleChars,
  });
  const normalizedMessage = normalizeSendAlertText(message, {
    fallback: t("thisTaskNeedsYourAttention"),
    maxChars: SEND_ALERT_RATE_LIMIT_POLICY.maxMessageChars,
  });
  const normalizedLevel = normalizeSendAlertLevel(level);
  const normalizedDedupeKey = normalizeSendAlertDedupeKey({
    title: normalizedTitle,
    message: normalizedMessage,
    dedupeKey,
  });

  return await withSendAlertRateLock(async () => {
    const now = Date.now();
    const state = await readSendAlertRateState(now);
    const decision = getSendAlertRateDecision(state, now, normalizedDedupeKey);
    if (!decision.allowed) {
      return {
        ok: true,
        sent: false,
        suppressed: true,
        reason: decision.reason,
        retryAfterMs: Math.max(0, Math.ceil(decision.retryAfterMs)),
        title: normalizedTitle,
        message: normalizedMessage,
        policy: sendAlertResultPolicy(),
      };
    }

    const sourceSessionId = String(sessionId || "").trim().replace(/[^a-zA-Z0-9]/g, "");
    const notificationId = sourceSessionId
      ? `qz_alert_session_${sourceSessionId}_${now}_${normalizedDedupeKey}`
      : `qz_alert_${now}_${normalizedDedupeKey}`;
    const iconUrl = globalThis.chrome?.runtime?.getURL
      ? globalThis.chrome.runtime.getURL("icons/icon128.png")
      : "icons/icon128.png";
    const createdNotificationId = await createSendAlertNotification(notificationId, {
      type: "basic",
      iconUrl,
      title: normalizedTitle,
      message: normalizedMessage,
      priority: sendAlertPriority(normalizedLevel),
    });

    state.timestamps.push(now);
    state.dedupe[normalizedDedupeKey] = now;
    await chromeStorageLocalSet({
      [SEND_ALERT_RATE_LIMIT_STORAGE_KEY]: pruneSendAlertRateState(state, now),
    });

    return {
      ok: true,
      sent: true,
      suppressed: false,
      notificationId: createdNotificationId,
      title: normalizedTitle,
      message: normalizedMessage,
      level: normalizedLevel,
      policy: sendAlertResultPolicy(),
    };
  });
}

registerTool({
  name: "send_alert",
  get description() { return modelT("notifyUser"); },
  get parameters() { return {
    type: "object",
    properties: {
      title: { type: "string", description: modelT("notificationTitle") },
      message: { type: "string", description: modelT("notificationMessage") },
      level: { type: "string", enum: ["info", "success", "warning", "error"], description: modelT("notificationLevel") },
      dedupeKey: { type: "string", description: modelT("notificationDedupeKey") },
    },
    required: ["message"],
  } as const; },
  execute: async ({ title, message, level, dedupeKey }, _signal, context = {}) => {
    return await sendBrowserAlert({ title, message, level, dedupeKey, sessionId: context.sessionId });
  },
});

const SETTINGS_CONFIG_FIELDS = [
  "provider",
  "apiKey",
  "model",
  "modelParameters",
  "codexReasoningEffort",
  "customProtocol",
  "customEndpoint",
  "customPresetName",
  "endpoint",
  "contextWindow",
  "trimOldToolResults",
  "vision",
  "requestRateLimit",
  "debugMode",
];

registerTool({
  name: "manage_settings",
  get description() { return getQingzhouManageSettingsToolDescription(); },
  get parameters() { return QINGZHOU_MANAGE_SETTINGS_TOOL_PARAMETERS; },
  hidden: true,
  execute: async (input, signal, context = {}) => executeManageSettingsAction(input, context, signal),
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["apply_preset","delete_preset"].includes(action)) requireToolFields("manage_settings", args, [["presetId","id","activePresetId"]], { action, requiredWhen: `action=${action}` });
  },
});

registerTool({
  name: "manage_guardrails",
  get description() { return getQingzhouManageGuardrailsToolDescription(); },
  get parameters() { return QINGZHOU_MANAGE_GUARDRAILS_TOOL_PARAMETERS; },
  hidden: true,
  execute: async (input, _signal, context = {}) => executeManageGuardrailsAction(input, context),
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["add_rule"].includes(action)) requireToolFields("manage_guardrails", args, ["targetType","target"], { action, requiredWhen: `action=${action}` });
    if (["remove_rule","remove_rate_limit"].includes(action)) requireToolFields("manage_guardrails", args, [["id","target"]], { action, requiredWhen: `action=${action}` });
    if (["add_rate_limit"].includes(action)) requireToolFields("manage_guardrails", args, ["targetType","target","minOpenIntervalSeconds"], { action, requiredWhen: `action=${action}` });
    if (["reorder"].includes(action)) requireToolFields("manage_guardrails", args, ["order"], { action, requiredWhen: `action=${action}` });
  },
});

registerTool({
  name: "manage_skill_settings",
  get description() { return getQingzhouManageSkillSettingsToolDescription(); },
  get parameters() { return QINGZHOU_MANAGE_SKILL_SETTINGS_TOOL_PARAMETERS; },
  hidden: true,
  execute: async (input, _signal, context = {}) => executeManageSkillSettingsAction(input, context),
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["get"].includes(action)) requireToolFields("manage_skill_settings", args, ["settingId"], { action, requiredWhen: `action=${action}` });
    if (["update"].includes(action)) requireToolFields("manage_skill_settings", args, ["settingId","values"], { action, requiredWhen: `action=${action}` });
  },
});

async function executeManageSkillSettingsAction(input: SkillSettingsInput = {}, context: ToolContext = {}) {
  const action = String(input.action || "").trim().toLowerCase();
  const service = getToolRuntimeDependencies(context).skillSettings;
  if (typeof service?.list !== "function") {
    throw new ToolExecutionError("SKILL_SETTINGS_UNAVAILABLE", t("skillSettingsAreUnavailable"), {});
  }

  const snapshot = await service.list();
  const settings = Array.isArray(snapshot?.settings) ? snapshot.settings : [];
  if (action === "list") {
    return {
      ok: true,
      action,
      count: settings.length,
      settings: settings.map(skillSettingSummary),
    };
  }

  if (action === "get" || action === "update") {
    const settingId = String(input.settingId || "").trim();
    const setting = settings.find(item => String(item?.id || "") === settingId);
    if (!setting) {
      throw new ToolExecutionError("SKILL_SETTINGS_NOT_FOUND", t("skillSettingsNotFoundListTheSettingsAgainAndSelect"), {
        settingId,
        availableSettingIds: settings.map(item => String(item?.id || "")).filter(Boolean).slice(0, 100),
      });
    }

    if (action === "get") {
      return {
        ok: true,
        action,
        setting: skillSettingResult(setting),
      };
    }

    const values = input.values && typeof input.values === "object" && !Array.isArray(input.values)
      ? { ...input.values }
      : null;
    if (!values || Object.keys(values).length === 0) {
      throw new ToolExecutionError(
        "MISSING_SKILL_SETTINGS_UPDATE",
        t("valuesCannotBeEmptyWhenUpdatingSkillSettings"),
        {
          settingId,
          allowedFields: (Array.isArray(setting.fields) ? setting.fields : []).map(field => String(field?.key || "")).filter(Boolean),
        },
      );
    }
    if (typeof service.save !== "function") {
      throw new ToolExecutionError("SKILL_SETTINGS_UNAVAILABLE", t("skillSettingsAreUnavailable"), {});
    }
    const saved = await service.save({
      pluginId: setting.pluginId,
      skillName: setting.skillName,
      values,
    });
    const nextSetting = saved?.setting || setting;
    await emitSkillSettingsChanged({
      settingId,
      changedFields: Object.keys(values),
    }, context);
    return {
      ok: true,
      action,
      saved: true,
      changedFields: Object.keys(values),
      setting: skillSettingResult(nextSetting),
    };
  }

  throw new ToolExecutionError(
    "INVALID_SKILL_SETTINGS_ACTION",
    t("unsupportedSkillSettingsAction", { action: String(action || "(empty)") }),
    { action },
  );
}

function skillSettingSummary(setting: ToolSkillSetting) {
  return {
    id: String(setting.id || ""),
    title: String(setting.title || setting.pluginName || setting.skillName || ""),
    pluginName: String(setting.pluginName || ""),
    skillName: String(setting.skillName || ""),
    skillDisplayName: String(setting.skillDisplayName || setting.skillName || ""),
    configured: setting.configured === true,
    missing: Array.isArray(setting.missing) ? setting.missing.map(String) : [],
    updatedAt: String(setting.updatedAt || ""),
  };
}

function skillSettingResult(setting: ToolSkillSetting) {
  return {
    ...skillSettingSummary(setting),
    description: String(setting.description || ""),
    layout: skillSettingLayoutResult(setting.layout),
    fields: (Array.isArray(setting.fields) ? setting.fields : []).map(skillSettingFieldResult),
  };
}

function skillSettingLayoutResult(layout: ToolSkillSetting["layout"]) {
  return {
    sections: (Array.isArray(layout?.sections) ? layout.sections : []).map(section => ({
      title: String(section?.title || ""),
      description: String(section?.description || ""),
      fields: (Array.isArray(section?.fields) ? section.fields : []).map(String),
    })),
  };
}

function skillSettingFieldResult(field: ToolSkillSetting["fields"][number]) {
  const result: Pick<ToolSkillSetting["fields"][number], "key" | "type" | "label" | "required"> & Partial<ToolSkillSetting["fields"][number]> = {
    key: String(field.key || ""),
    type: String(field.type || "text"),
    label: String(field.label || field.key || ""),
    required: field.required === true,
  };
  const description = String(field.description || "");
  const placeholder = String(field.placeholder || "");
  const options = Array.isArray(field.options)
    ? field.options.map(option => ({ value: String(option?.value || ""), label: String(option?.label || option?.value || "") }))
    : [];
  const reenterWhen = Array.isArray(field.reenterWhen) ? field.reenterWhen.map(String) : [];
  if (description) result.description = description;
  if (placeholder) result.placeholder = placeholder;
  if (options.length) result.options = options;
  if (field.min != null) result.min = field.min;
  if (field.max != null) result.max = field.max;
  if (field.step != null) result.step = field.step;
  if (reenterWhen.length) result.reenterWhen = reenterWhen;
  if (result.type === "secret") result.hasValue = field.hasValue === true;
  else if (Object.prototype.hasOwnProperty.call(field, "value")) result.value = field.value;
  return result;
}

async function emitSkillSettingsChanged(change: { settingId?: string; changedFields?: string[] } = {}, context: ToolContext = {}) {
  const sink = getToolRuntimeDependencies(context).emit;
  if (typeof sink !== "function") return false;
  try {
    sink({
      type: "skill_settings_changed",
      source: "manage_skill_settings",
      settingId: String(change.settingId || ""),
      changedFields: Array.isArray(change.changedFields) ? change.changedFields.map(String) : [],
    });
    return true;
  } catch (_err) {
    return false;
  }
}

async function executeManageSettingsAction(input: SettingsInput = {}, context: ToolContext = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const action = normalizeSettingsAction(input.action);
  if (action === "get") {
    return await readSettingsSnapshot({
      includeProviders: input.includeProviders !== false,
    });
  }

  if (action === "list_models") {
    const result = await listModels({
      provider: input.provider,
      apiKey: input.apiKey,
      customProtocol: input.customProtocol,
      customEndpoint: input.customEndpoint ?? input.endpoint,
      signal,
    });
    const models = Array.isArray(result.models) ? result.models : [];
    const limit = clampLimit(input.limit || 200, 1, 1000);
    return {
      ok: true,
      action,
      provider: result.provider || input.provider || "",
      providerLabel: result.providerLabel || "",
      count: models.length,
      limit,
      models: models.slice(0, limit),
      truncated: models.length > limit,
      ...(input.includeProviders ? { providers: listProviderSummaries() } : {}),
    };
  }

  if (action === "update_config") {
    const configInput = await settingsCompleteConfigForUpdate(input, signal);
    if (!configInput) {
      throw new ToolExecutionError("MISSING_SETTINGS_UPDATE", t("settingsPatchRequired"), {
        allowedFields: SETTINGS_CONFIG_FIELDS,
      });
    }
    const config = await saveConfig(configInput, signal);
    await emitSettingsConfigChanged(config, "manage_settings", context);
    return {
      ok: true,
      action,
      saved: true,
      config: settingsConfigResult(config),
      ...(input.includeProviders ? { providers: listProviderSummaries() } : {}),
    };
  }

  if (action === "apply_preset" || action === "delete_preset") {
    const presetId = normalizeSettingsPresetId(input.presetId || input.activePresetId || input.id);
    if (!presetId) {
      throw new ToolExecutionError("MISSING_PRESET_ID", t("presetIdRequired", { action }), {});
    }
    const config = await (action === "apply_preset" ? applyModelPreset : deleteModelPreset)(presetId, signal);
    await emitSettingsConfigChanged(config, "manage_settings", context);
    return {
      ok: true,
      action,
      ...(action === "apply_preset" ? { applied: true } : { deleted: true }),
      presetId,
      config: settingsConfigResult(config),
      ...(input.includeProviders ? { providers: listProviderSummaries() } : {}),
    };
  }

  throw new ToolExecutionError("INVALID_SETTINGS_ACTION", t("settingsActionUnsupported", { action }), { action });
}

function normalizeSettingsAction(action = "") {
  return String(action || "").trim().toLowerCase();
}

async function executeManageGuardrailsAction(input: GuardrailsInput = {}, context: ToolContext = {}) {
  const action = String(input.action || "").trim().toLowerCase();
  if (action === "get") {
    return {
      ok: true,
      action,
      securityGuardrails: await getSecurityGuardrails(),
    };
  }

  if (action === "add_rule") {
    const normalized = normalizeManageGuardrailRule(input);
    const guardrails = await getSecurityGuardrails();
    const exists = guardrails.rules.some(rule => guardrailRulesEqual(rule, normalized.rule));
    const next = exists
      ? guardrails
      : await saveSecurityGuardrails({
          rules: [...guardrails.rules, normalized.rule],
          siteOpenRateLimits: guardrails.siteOpenRateLimits,
          order: [...guardrails.order, normalized.rule.id],
        });
    if (!exists) await emitSettingsConfigChanged(null, "manage_guardrails", context);
    return {
      ok: true,
      action,
      saved: !exists,
      existed: exists,
      rule: normalized.rule,
      securityGuardrails: next,
    };
  }

  if (action === "remove_rule") {
    const guardrails = await getSecurityGuardrails();
    const id = String(input.id || "").trim();
    const normalized = id ? null : normalizeManageGuardrailRule(input);
    const nextRules = guardrails.rules.filter((rule) => {
      if (id) return rule.id !== id;
      return !guardrailRulesEqual(rule, normalized!.rule);
    });
    const removed = guardrails.rules.length - nextRules.length;
    const next = removed > 0
      ? await saveSecurityGuardrails({
          rules: nextRules,
          siteOpenRateLimits: guardrails.siteOpenRateLimits,
          order: guardrails.order.filter(ruleId => nextRules.some(rule => rule.id === ruleId) || guardrails.siteOpenRateLimits.some(item => item.id === ruleId)),
        })
      : guardrails;
    if (removed > 0) await emitSettingsConfigChanged(null, "manage_guardrails", context);
    return {
      ok: true,
      action,
      removed,
      id,
      rule: normalized?.rule || null,
      securityGuardrails: next,
    };
  }

  if (action === "add_rate_limit") {
    const normalized = normalizeManageRateLimit(input);
    const guardrails = await getSecurityGuardrails();
    const targetId = normalized.rateLimit.id;
    let existed = false;
    const nextRateLimits = guardrails.siteOpenRateLimits.map((item) => {
      const sameId = item.id === targetId;
      const sameTarget = item.type === normalized.rateLimit.type && item.value === normalized.rateLimit.value;
      if (!sameId && !sameTarget) return item;
      existed = true;
      return {
        ...normalized.rateLimit,
        id: item.id,
        createdAt: item.createdAt || normalized.rateLimit.createdAt,
      };
    });
    if (!existed) nextRateLimits.push(normalized.rateLimit);
    const next = await saveSecurityGuardrails({
      rules: guardrails.rules,
      siteOpenRateLimits: nextRateLimits,
      order: existed ? guardrails.order : [...guardrails.order, normalized.rateLimit.id],
    });
    await emitSettingsConfigChanged(null, "manage_guardrails", context);
    return {
      ok: true,
      action,
      saved: true,
      existed,
      rateLimit: existed
        ? next.siteOpenRateLimits.find(item => item.type === normalized.rateLimit.type && item.value === normalized.rateLimit.value) || normalized.rateLimit
        : normalized.rateLimit,
      securityGuardrails: next,
    };
  }

  if (action === "remove_rate_limit") {
    const guardrails = await getSecurityGuardrails();
    const id = String(input.id || "").trim();
    const targetType = String(input.targetType || "").trim();
    const target = String(input.target || "").trim();
    const normalized = id ? null : normalizeManageRateLimitTarget({ targetType, target });
    const nextRateLimits = guardrails.siteOpenRateLimits.filter((item) => {
      if (id) return item.id !== id;
      return !(item.type === normalized!.type && item.value === normalized!.value);
    });
    const removed = guardrails.siteOpenRateLimits.length - nextRateLimits.length;
    const next = removed > 0
      ? await saveSecurityGuardrails({
          rules: guardrails.rules,
          siteOpenRateLimits: nextRateLimits,
          order: guardrails.order.filter(ruleId => guardrails.rules.some(rule => rule.id === ruleId) || nextRateLimits.some(item => item.id === ruleId)),
        })
      : guardrails;
    if (removed > 0) await emitSettingsConfigChanged(null, "manage_guardrails", context);
    return {
      ok: true,
      action,
      removed,
      id,
      target: normalized || null,
      securityGuardrails: next,
    };
  }

  if (action === "reorder") {
    const guardrails = await getSecurityGuardrails();
    const requested = Array.isArray(input.order) ? input.order.map(id => String(id || "").trim()).filter(Boolean) : [];
    const knownIds = new Set([
      ...guardrails.rules.map(rule => rule.id),
      ...guardrails.siteOpenRateLimits.map(item => item.id),
    ]);
    const nextOrder = [
      ...requested.filter(id => knownIds.has(id)),
      ...guardrails.order.filter(id => knownIds.has(id) && !requested.includes(id)),
      ...[...knownIds].filter(id => !requested.includes(id) && !guardrails.order.includes(id)),
    ];
    const next = await saveSecurityGuardrails({
      rules: guardrails.rules,
      siteOpenRateLimits: guardrails.siteOpenRateLimits,
      order: nextOrder,
    });
    await emitSettingsConfigChanged(null, "manage_guardrails", context);
    return {
      ok: true,
      action,
      order: next.order,
      securityGuardrails: next,
    };
  }

  throw new ToolExecutionError("INVALID_GUARDRAILS_ACTION", t("guardrailsActionUnsupported", { action }), { action });
}

async function settingsCompleteConfigForUpdate(input: SettingsInput = {}, signal?: AbortSignal) {
  const rawPatch: Record<string, unknown> = {};
  for (const field of SETTINGS_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (field === "endpoint") {
      if (!Object.prototype.hasOwnProperty.call(rawPatch, "customEndpoint")) rawPatch.customEndpoint = input.endpoint;
      continue;
    }
    rawPatch[field] = input[field as keyof SettingsInput];
  }
  const current = await getConfig();
  signal?.throwIfAborted();
  if (Object.keys(rawPatch).length === 0) return null;

  const targetProvider = normalizeSettingsProviderId(rawPatch.provider || current.provider) || current.provider;
  const sameProvider = targetProvider === current.provider;
  const modelChanged = Object.prototype.hasOwnProperty.call(input, "model");
  const providerChanged = Object.prototype.hasOwnProperty.call(input, "provider") && !sameProvider;
  const providerSummary = settingsProviderSummary(targetProvider);
  const endpointChanged = Object.hasOwn(rawPatch, "customEndpoint") && String(rawPatch.customEndpoint || "").trim() !== current.customEndpoint;
  const credentialChanged = providerSummary?.modelsIncludeCapabilities && Object.hasOwn(rawPatch, "apiKey") && rawPatch.apiKey !== current.apiKey;
  const modelIdentityChanged = providerChanged || endpointChanged || credentialChanged
    || (modelChanged && String(rawPatch.model || "").trim() !== String(current.model || "").trim());
  const codexProvider = Boolean(providerSummary?.auth);
  const customProvider = targetProvider === "custom";
  const model = modelChanged ? rawPatch.model : (providerChanged ? "" : current.model);

  const next = {
    provider: targetProvider,
    apiKey: settingsApiKeyForProvider({ input, rawPatch, current, targetProvider, codexProvider, sameProvider }),
    model,
    modelLabel: modelChanged || providerChanged ? "" : current.modelLabel,
    modelParameters: Object.prototype.hasOwnProperty.call(input, "modelParameters")
      ? rawPatch.modelParameters
      : (modelIdentityChanged ? {} : current.modelParameters),
    codexReasoningEffort: codexProvider
      ? (Object.prototype.hasOwnProperty.call(input, "codexReasoningEffort") ? rawPatch.codexReasoningEffort : (sameProvider ? current.codexReasoningEffort : "medium"))
      : "",
    customProtocol: customProvider
      ? (Object.prototype.hasOwnProperty.call(input, "customProtocol") ? rawPatch.customProtocol : (sameProvider ? current.customProtocol : "openai"))
      : "",
    customEndpoint: customProvider || providerSummary?.editableEndpoint
      ? (Object.prototype.hasOwnProperty.call(input, "customEndpoint") || Object.prototype.hasOwnProperty.call(input, "endpoint")
          ? rawPatch.customEndpoint
          : (sameProvider ? current.customEndpoint : providerSummary?.editableEndpoint || ""))
      : "",
    customPresetName: customProvider
      ? (Object.prototype.hasOwnProperty.call(input, "customPresetName") ? rawPatch.customPresetName : (sameProvider ? current.customPresetName : ""))
      : "",
    maxOutputTokens: modelIdentityChanged ? undefined : current.maxOutputTokens,
    contextWindow: Object.prototype.hasOwnProperty.call(input, "contextWindow") ? rawPatch.contextWindow : current.contextWindow,
    trimOldToolResults: Object.prototype.hasOwnProperty.call(input, "trimOldToolResults")
      ? rawPatch.trimOldToolResults
      : (providerChanged ? true : current.trimOldToolResults),
    vision: Object.prototype.hasOwnProperty.call(input, "vision") ? rawPatch.vision : current.vision,
    requestRateLimit: Object.prototype.hasOwnProperty.call(input, "requestRateLimit")
      ? rawPatch.requestRateLimit
      : current.requestRateLimit,
    debugMode: Object.prototype.hasOwnProperty.call(input, "debugMode") ? rawPatch.debugMode : current.debugMode,
  };
  await applySettingsModelCapabilityDefaults(input, next, modelIdentityChanged, signal);
  return next;
}

function settingsApiKeyForProvider({ input, rawPatch, current, targetProvider, codexProvider, sameProvider }: { input: SettingsInput; rawPatch: Record<string, unknown>; current: SettingsConfig; targetProvider: string; codexProvider: boolean; sameProvider: boolean }) {
  if (codexProvider) return "";
  if (Object.prototype.hasOwnProperty.call(input, "apiKey")) return rawPatch.apiKey;
  if (targetProvider === "custom" || settingsProviderSummary(targetProvider)?.editableEndpoint) {
    const endpointChanged = Object.hasOwn(rawPatch, "customEndpoint") && rawPatch.customEndpoint !== current.customEndpoint;
    return sameProvider && !endpointChanged ? current.apiKey || "" : "";
  }
  if (sameProvider) return current.apiKey || "";
  const providerApiKeys = current.providerApiKeys && typeof current.providerApiKeys === "object" && !Array.isArray(current.providerApiKeys)
    ? current.providerApiKeys
    : {};
  return String(providerApiKeys[targetProvider] || "").trim();
}

async function applySettingsModelCapabilityDefaults(input: SettingsInput, config: { provider: string; model?: unknown; customEndpoint?: unknown; apiKey?: unknown; maxOutputTokens?: number; contextWindow?: unknown; vision?: unknown }, modelIdentityChanged = false, signal?: AbortSignal) {
  if (!modelIdentityChanged) return config;
  const hasExplicitContextWindow = Object.prototype.hasOwnProperty.call(input, "contextWindow");
  const hasExplicitVision = Object.prototype.hasOwnProperty.call(input, "vision");
  if (hasExplicitContextWindow && hasExplicitVision && !settingsProviderSummary(config.provider)?.modelsIncludeCapabilities) return config;

  const provider = config.provider;
  const modelName = String(config.model || "").trim();
  if (!modelName) {
    if (!hasExplicitContextWindow) config.contextWindow = "";
    if (!hasExplicitVision) config.vision = false;
    return config;
  }

  let match = null;
  try {
    match = await matchConfiguredModelCapabilities({ model: modelName, provider, customEndpoint: String(config.customEndpoint || ""), apiKey: String(config.apiKey || "") }, signal);
  } catch (err) {
    signal?.throwIfAborted();
    toolTrace(`[settings] model capability match failed provider=${provider || ""} model=${modelName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  signal?.throwIfAborted();

  config.maxOutputTokens = settingsProviderSummary(provider)?.modelsIncludeCapabilities ? match?.maxOutputTokens ?? undefined : undefined;
  const missingFields = [];
  if (!hasExplicitContextWindow) {
    if (match?.matched && Number(match.contextWindow) > 0) {
      config.contextWindow = Number(match.contextWindow);
    } else {
      config.contextWindow = "";
      missingFields.push("contextWindow");
    }
  }
  if (!hasExplicitVision) {
    if (match?.matched && typeof match.vision === "boolean") {
      config.vision = match.vision;
    } else {
      config.vision = false;
    }
  }
  if (missingFields.length) {
    throw new ToolExecutionError(
      "MODEL_CAPABILITIES_REQUIRED",
      t("couldNotDetectTheCapabilitiesOfConfirmWithTheUser", { model: String(modelName), fields: String(missingFields.join("、")) }),
      {
        provider,
        model: modelName,
        missingFields,
      },
    );
  }
  return config;
}

function normalizeSettingsProviderId(provider: unknown = "") {
  const value = String(provider || "").trim().toLowerCase();
  return settingsProviderSummary(value)?.id || "";
}

function settingsProviderSummary(provider = "") {
  const value = String(provider || "").trim().toLowerCase();
  return listProviderSummaries().find(item => item.id === value) || null;
}

function normalizeSettingsPresetId(value = "") {
  return String(value || "").trim();
}

async function readSettingsSnapshot({
  includeProviders = true,
  includeSecurityGuardrails = false,
} = {}) {
  const [config, securityGuardrails] = await Promise.all([
    getConfig(),
    includeSecurityGuardrails ? getSecurityGuardrails() : Promise.resolve(null),
  ]);
  return {
    ok: true,
    action: "get",
    config: settingsConfigResult(config),
    ...(includeProviders ? { providers: listProviderSummaries() } : {}),
    ...(includeSecurityGuardrails ? { securityGuardrails } : {}),
  };
}

function settingsConfigResult(config: SettingsConfig) {
  const providerApiKeys = config.providerApiKeys && typeof config.providerApiKeys === "object" && !Array.isArray(config.providerApiKeys)
    ? config.providerApiKeys
    : {};
  const providerApiKeyProviders = Object.entries(providerApiKeys)
    .filter(([, value]) => Boolean(String(value || "").trim()))
    .map(([provider]) => provider)
    .sort((a, b) => a.localeCompare(b));
  return {
    provider: config.provider || "",
    providerLabel: config.providerLabel || "",
    endpoint: config.endpoint || "",
    model: config.model || "",
    modelLabel: config.modelLabel || config.model || "",
    modelParameters: normalizeModelParameters(config.modelParameters),
    codexReasoningEffort: config.codexReasoningEffort || "",
    customProtocol: config.customProtocol || "",
    customEndpoint: config.customEndpoint || "",
    customPresetName: config.customPresetName || "",
    apiKey: config.apiKey || "",
    providerApiKeys: { ...providerApiKeys },
    contextWindow: Number(config.contextWindow) || 0,
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    trimOldToolResults: config.trimOldToolResults !== false,
    vision: config.vision === true,
    requestRateLimit: config.requestRateLimit === true,
    debugMode: config.debugMode === true,
    activePresetId: config.activePresetId || "",
    hasApiKey: Boolean(String(config.apiKey || "").trim()),
    providerApiKeyProviders,
    hasCurrentProviderApiKey: providerApiKeyProviders.includes(String(config.provider || "")),
    providerAuth: config.providerAuth || {},
    codexAuthStatus: config.codexAuthStatus || null,
    presets: settingsPresetResults(config.presets),
  };
}

function settingsPresetResults(presets: SettingsConfig["presets"] = []) {
  return (Array.isArray(presets) ? presets : []).map(preset => ({
    id: String(preset?.id || ""),
    name: String(preset?.name || ""),
    provider: String(preset?.provider || ""),
    model: String(preset?.model || ""),
    modelLabel: String(preset?.modelLabel || preset?.model || ""),
    modelParameters: normalizeModelParameters(preset?.modelParameters),
    codexReasoningEffort: String(preset?.codexReasoningEffort || ""),
    customProtocol: String(preset?.customProtocol || ""),
    customEndpoint: String(preset?.customEndpoint || ""),
    customPresetName: String(preset?.customPresetName || ""),
    contextWindow: Number(preset?.contextWindow) || 0,
    ...(preset?.maxOutputTokens ? { maxOutputTokens: preset.maxOutputTokens } : {}),
    trimOldToolResults: preset?.trimOldToolResults !== false,
    vision: preset?.vision === true,
    updatedAt: String(preset?.updatedAt || ""),
    apiKey: String(preset?.apiKey || ""),
    hasApiKey: Boolean(String(preset?.apiKey || "").trim()),
  }));
}

function normalizeManageGuardrailRule(input: GuardrailsInput = {}) {
  const source = {
    id: input.id,
    action: input.ruleAction || "block",
    type: input.targetType,
    value: input.target,
  };
  const normalized = normalizeGuardrailRuleInput(source);
  if (normalized.error || !normalized.rule) {
    throw new ToolExecutionError("INVALID_GUARDRAIL_RULE", normalized.error || t("invalidGuardrailRule"), {
      source,
    });
  }
  return { ...normalized, rule: normalized.rule };
}

function normalizeManageRateLimit(input: GuardrailsInput = {}) {
  const source = {
    id: input.id,
    type: input.targetType,
    value: input.target,
    minOpenIntervalMs: secondsToMs(input.minOpenIntervalSeconds),
    enabled: input.enabled,
  };
  const normalized = normalizeSiteOpenRateLimitInput(source);
  if (normalized.error || !normalized.rateLimit) {
    throw new ToolExecutionError("INVALID_GUARDRAIL_RATE_LIMIT", normalized.error || t("invalidNavigationRateLimit"), {
      source: {
        id: source.id,
        type: source.type,
        value: source.value,
        minOpenIntervalSeconds: input.minOpenIntervalSeconds,
        enabled: input.enabled,
      },
    });
  }
  return { ...normalized, rateLimit: normalized.rateLimit };
}

function normalizeManageRateLimitTarget(input: { targetType?: string; target?: string } = {}) {
  const normalized = normalizeSiteOpenRateLimitInput({
    type: input.targetType,
    value: input.target,
    minOpenIntervalMs: 1000,
  });
  if (normalized.error || !normalized.rateLimit) {
    throw new ToolExecutionError("INVALID_GUARDRAIL_RATE_LIMIT_TARGET", normalized.error || t("invalidNavigationTarget"), {
      targetType: input.targetType,
      target: input.target,
    });
  }
  return {
    type: normalized.rateLimit.type,
    value: normalized.rateLimit.value,
  };
}

function guardrailRulesEqual(a: GuardrailRule, b: GuardrailRule) {
  return a.action === b.action && a.type === b.type && a.value === b.value;
}

async function emitSettingsConfigChanged(config: SettingsConfig | null = null, source = "manage_settings", context: ToolContext = {}) {
  const sink = getToolRuntimeDependencies(context).emit;
  if (typeof sink !== "function") return false;
  try {
    const fullConfig = config || await getConfig();
    const securityGuardrails = await getSecurityGuardrails();
    sink({
      type: "config",
      source,
      config: { ...fullConfig, securityGuardrails },
    });
    return true;
  } catch (_err) {
    return false;
  }
}
}


export default registerAlertsSettingsTools satisfies ToolExtension;
