import { t } from "./prompts/messages.js";
import { getLocale } from "../../shared/i18n/index.js";
import type { RuntimeConfig } from "../../sdk/background/providers.js";
import { getBundledModelMaxOutputTokens } from "../../shared/models/model-capabilities.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export async function buildRunProfile({
  sessionId = "",
  canManageSessions = true,
  config,
  platformInfo = {},
}: { sessionId?: string; canManageSessions?: boolean; config: RuntimeConfig; platformInfo?: { os?: string } }) {
  const llmConfig = config;
  const detectedPlatformInfo = platformInfo;
  const maxOutputTokens = resolveRunProfileMaxOutputTokens(
    await getBundledModelMaxOutputTokens(llmConfig),
  );
  const vision = llmConfig.vision === true;
  const sessionKind = canManageSessions ? "user" : "restricted";
  const disabledTools = [];

  if (!canManageSessions) disabledTools.push("manage_sessions", "manage_goal");
  if (!vision) disabledTools.push("screenshot", "act_on_screen", "read_image");

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
      vision,
      toolCalling: llmConfig.toolCalling !== false,
      contextWindow: Number(llmConfig.contextWindow) || null,
      trimOldToolResults: llmConfig.trimOldToolResults !== false,
      maxOutputTokens,
    },
    features: {
      imageInput: vision,
      screenshots: vision,
      goalTracking: !!canManageSessions,
      toolImages: vision,
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
