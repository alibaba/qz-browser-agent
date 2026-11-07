import { t } from "./prompts/messages.js";
import { getLocale } from "../../shared/i18n/index.js";
import type { ProviderDefinition, RuntimeConfig } from "../../sdk/background/providers.js";
import { getBundledModelMaxOutputTokens } from "../../shared/models/model-capabilities.js";
import { getProviderDef } from "../llm/provider-catalog.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export async function buildRunProfile({
  sessionId = "",
  canManageSessions = true,
  externalDrive = false,
  config,
  platformInfo = {},
}: { sessionId?: string; canManageSessions?: boolean; externalDrive?: boolean; config: RuntimeConfig; platformInfo?: { os?: string } }) {
  const llmConfig = config;
  const detectedPlatformInfo = platformInfo;
  const maxOutputTokens = resolveRunProfileMaxOutputTokens(
    await getBundledModelMaxOutputTokens(llmConfig),
  );
  const configuredVision = llmConfig.vision === true;
  // An external client decides whether it can read images. Qingzhou's own model setting does not hide them.
  const imageTools = externalDrive || configuredVision;
  const sessionKind = canManageSessions ? "user" : "restricted";
  const disabledTools = [];

  if (!canManageSessions) disabledTools.push("manage_sessions", "manage_goal");
  if (!imageTools) disabledTools.push("screenshot", "act_on_screen", "read_image");

  return {
    version: 1,
    sessionId: String(sessionId || ""),
    session: {
      kind: sessionKind,
      canManageSessions: !!canManageSessions,
    },
    platform: buildPlatformProfile(detectedPlatformInfo),
    model: {
      id: String(llmConfig.model || ""),
      provider: String(llmConfig.provider || ""),
      endpoint: String(llmConfig.endpoint || ""),
      vision: configuredVision,
      toolCalling: llmConfig.toolCalling !== false,
      contextWindow: Number(llmConfig.contextWindow) || null,
      trimOldToolResults: llmConfig.trimOldToolResults !== false,
      maxOutputTokens,
      outputReserveTokens: resolveOutputReserveTokens(llmConfig, getProviderDef(llmConfig), maxOutputTokens),
    },
    features: {
      imageInput: imageTools,
      screenshots: imageTools,
      goalTracking: !!canManageSessions,
      toolImages: imageTools,
      sessionTools: !!canManageSessions,
      toolCalling: llmConfig.toolCalling !== false,
    },
    tools: {
      disabled: disabledTools,
    },
  };
}

export type RunProfile = Awaited<ReturnType<typeof buildRunProfile>>;

export function buildRunProfilePromptSection(profile: RunProfile | null | undefined) {
  if (!profile || typeof profile !== "object") return "";
  const lines = [
    "",
    t("runConfig"),
    t("sessionType", { value: profile.session?.kind === "restricted" ? "restricted session" : "user-created root session" }),
    `- Provider: ${profile.model?.provider || "unknown"}`,
    t("model", { value: profile.model?.id || "unknown" }),
    t("language", { value: getLocale() }),
    t("contextWindow", { value: formatTokenWindow(profile.model?.contextWindow) }),
    t("trimTools", { value: profile.model?.trimOldToolResults === false ? t("disabled") : t("enabled") }),
    t("outputLimit", { value: formatTokenWindow(profile.model?.maxOutputTokens) }),
    t("imageCapability", { value: profile.features?.imageInput ? t("imagesEnabled") : t("imagesDisabled") }),
  ];

  if (profile.platform?.label) {
    lines.splice(3, 0, t("os", { value: profile.platform.label }));
  }

  if (!profile.features?.imageInput) {
    lines.push(t("textPolicy"));
    lines.push(t("imagePlaceholderPolicy"));
  }
  return `${lines.join("\n")}\n`;
}

function resolveRunProfileMaxOutputTokens(modelLimit: unknown) {
  const limit = Number(modelLimit);
  if (Number.isFinite(limit) && limit > 0) {
    return Math.max(1024, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(limit)));
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

export function resolveOutputReserveTokens(config: RuntimeConfig, provider: ProviderDefinition, maxOutputTokens: number) {
  const parameters = config.modelParameters || {};
  const positiveTokens = (value: unknown) => {
    const tokens = Number(value);
    return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
  };
  if (provider.protocol === "anthropic") {
    return positiveTokens(Object.hasOwn(parameters, "max_tokens") ? parameters.max_tokens : maxOutputTokens);
  }
  if (provider.protocol === "openai-codex") return positiveTokens(parameters.max_output_tokens);
  if (provider.protocol !== "openai") return 0;

  const request = { ...provider.requestDefaults, ...parameters };
  const keys = ["max_tokens", "max_completion_tokens", ...(provider.outputTokenParam ? [provider.outputTokenParam] : [])];
  // Optional limits absent from the request must not consume the model's whole output allowance.
  if (provider.outputTokenParam && !keys.some(key => Object.hasOwn(request, key))) return maxOutputTokens;
  return Math.max(0, ...keys.map(key => positiveTokens(request[key])));
}

function buildPlatformProfile(platformInfo: { os?: string }) {
  const os = String(platformInfo?.os || "").trim().toLowerCase();
  const labels: Record<string, string> = {
    mac: "macOS",
    win: "Windows",
    linux: "Linux",
    cros: "ChromeOS",
    android: "Android",
    openbsd: "OpenBSD",
  };
  if (!labels[os]) return null;
  return {
    os,
    label: labels[os],
  };
}

function formatTokenWindow(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M tokens`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}K tokens`;
  return `${Math.round(n)} tokens`;
}
