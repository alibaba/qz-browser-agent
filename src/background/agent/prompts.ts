import type { ModelMessage } from "../../shared/contracts/model-message.js";
import { getLanguage, withLanguage, type Language } from "../../shared/i18n/index.js";
import { sessionAutomationsEnabled } from "../../shared/session-automations.js";
import * as zhCN from "./prompts/zh-CN.js";
import * as en from "./prompts/en.js";
import { t } from "./prompts/messages.js";

/** Prompt policies have identical structure in both languages; machine identifiers are unchanged. */
export function getAgentPrompts(language: Language = getLanguage()) {
  return language === "zh-CN" ? zhCN : en;
}

// A browser runtime has one UI language. Export the selected pieces together so capability
// substitutions always match the exact text used to compose the kernel.
export const {
  COMPACT_SYSTEM_PROMPT,
  COMPACT_USER_PROMPT,
  MULTIMODAL_CAPABILITY_PROMPT,
  TEXT_ONLY_CAPABILITY_PROMPT,
  VISION_READING_RULE,
  VISUAL_SCREEN_ACTION_RULE,
  TEXT_ONLY_READING_RULE,
  TEXT_ONLY_PAGE_ACTION_RULE,
  READING_CAPABILITY_PROTOCOL,
  TEXT_ONLY_READING_CAPABILITY_PROTOCOL,
  VISUAL_TARGET_TOOL_PROTOCOL,
  TEXT_ONLY_TARGET_TOOL_PROTOCOL,
  TOOL_CALLING_CONTRACT,
  VISUAL_IMAGE_ASSET_PROTOCOL,
  TEXT_ONLY_IMAGE_ASSET_PROTOCOL,
  GOAL_DRIVEN_RULE,
  RESTRICTED_GOAL_RULE,
  SYSTEM_PROMPT,
} = getAgentPrompts();

export function sessionAutomationPromptSuffix(language: Language = getLanguage()): string {
  if (sessionAutomationsEnabled()) return "";
  return `\n${getAgentPrompts(language).SESSION_AUTOMATIONS_DISABLED_PROMPT}`;
}

export function buildCompactUserPrompt(instruction = "", language = getLanguage()) {
  const base = getAgentPrompts(language).COMPACT_USER_PROMPT;
  const extra = String(instruction || "").replace(/\u0000/gu, "").trim();
  return extra ? `${base}\n\n${withLanguage(language, () => t("compactionInstruction"))}\n${extra}` : base;
}

export function buildSessionTitleMessages(text = ""): ModelMessage[] {
  return [
    { role: "system", content: t("titleInstructions") },
    { role: "user", content: JSON.stringify({ source_text: String(text ?? "") }) },
  ];
}
