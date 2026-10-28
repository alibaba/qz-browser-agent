import { t } from "../i18n/index.js";
import {
  getToolMetadataCatalog,
  getCoreToolMetadata,
  getToolPresentationTitle,
} from "../../shared/tools/tool-metadata.js";
import { record, type ToolEvent } from "./renderer-input.js";

export function getToolDisplayName(toolOrName: unknown) {
  const explicitTitle = typeof toolOrName === "object" && toolOrName
    ? String(record(toolOrName).title || record(toolOrName).toolTitle || "").trim()
    : "";
  const key = toolKey(toolOrName);
  const title = getToolPresentationTitle(key, explicitTitle);
  if (title) return title;
  if (isSkillToolRuntimeName(toolOrName)) return t("extensionTool");
  return key || t("tool");
}

export function getToolUiMeta(toolOrName: unknown) {
  return getCoreToolMetadata(toolKey(toolOrName));
}

function metadataText(toolOrName: unknown, field: "profileFamily" | "resultFamily" | "detailLayout" | "mediaPresentation" | "labelerId", fallback: string): string {
  return String(record(toolOrName)[field] || "").trim() || getToolUiMeta(toolOrName)?.[field] || fallback;
}

export function getToolProfileFamily(toolOrName: unknown): string {
  return metadataText(toolOrName, "profileFamily", "");
}

export function getToolResultFamily(toolOrName: unknown): string {
  return metadataText(toolOrName, "resultFamily", "generic");
}

export function getToolDetailLayout(toolOrName: unknown): string {
  return metadataText(toolOrName, "detailLayout", "detail");
}

export function getToolMediaPresentation(toolOrName: unknown): string {
  return metadataText(toolOrName, "mediaPresentation", "");
}

export function getToolLabelerId(toolOrName: unknown): string {
  return metadataText(toolOrName, "labelerId", "static");
}

export function getToolTimelineFamilyInfo(toolOrName: unknown) {
  const explicitFamilyId = typeof toolOrName === "object" && toolOrName
    ? String(record(toolOrName).familyId || record(toolOrName).toolFamilyId || "").trim()
    : "";
  const familyId = explicitFamilyId || getToolUiMeta(toolOrName)?.familyId || "other";
  const knownFamily = getToolMetadataCatalog().families[familyId];
  if (knownFamily) return { id: knownFamily.id, label: knownFamily.title, shortLabel: knownFamily.shortTitle };
  const familyTitle = typeof toolOrName === "object" && toolOrName
    ? String(record(toolOrName).familyTitle || record(toolOrName).toolFamilyTitle || familyId).trim()
    : familyId;
  return { id: familyId, label: familyTitle || familyId, shortLabel: familyTitle || familyId };
}

export function getToolActionLabel(toolOrName: unknown) {
  return getToolDisplayName(toolOrName);
}

export function isPageContextToolName(toolOrName: unknown) {
  if (typeof toolOrName === "object" && toolOrName && typeof record(toolOrName).pageContext === "boolean") {
    return record(toolOrName).pageContext === true;
  }
  const meta = getToolUiMeta(toolOrName);
  return Boolean(meta?.pageContext);
}

export function toolKey(toolOrName: unknown) {
  if (toolOrName && typeof toolOrName === "object") {
    return String(record(toolOrName).capabilityId || record(toolOrName).toolCapabilityId || record(toolOrName).name || "").trim();
  }
  return String(toolOrName || "").trim();
}

export function toolRuntimeName(toolOrName: unknown) {
  if (toolOrName && typeof toolOrName === "object") {
    return String(record(toolOrName).name || record(toolOrName).toolName || "").trim();
  }
  return String(toolOrName || "").trim();
}

export function isSkillToolRuntimeName(toolOrName: unknown) {
  return /^[a-z0-9_]+__[a-z0-9_]+$/i.test(toolRuntimeName(toolOrName));
}

export function isToolInSet(name: unknown, setName: string) {
  return Boolean(getCoreToolMetadata(toolKey(name))?.sets.includes(setName));
}

export function isDataTool(name: unknown) { return getToolProfileFamily(name) === "data"; }
export function isCssInjectionTool(name: unknown) { return getToolProfileFamily(name) === "css"; }
export function isDomMutationTool(name: unknown) { return getToolProfileFamily(name) === "domMutation"; }
export function isHumanInterventionToolName(name: unknown) { return isToolInSet(name, "human"); }

const TOOL_SUCCESS_CODES = new Set(["", "OK", "SUCCESS", "DONE"]);
const TOOL_FAILURE_CODE_PATTERN = /(?:ERROR|FAILED|MISSING_REQUIRED|INVALID_|ABORTED|TIMEOUT|DENIED|FORBIDDEN|UNAVAILABLE)/i;

export function resolveToolState(tool: ToolEvent | null | undefined, ...values: unknown[]) {
  if (isToolAborted(tool, ...values)) return "aborted";
  if (tool?.isError || [tool?.result, ...values].some(isToolResultErrorLike)) return "error";
  if (tool?.argsIncomplete || tool?.phase === "preparing" || tool?.isRunning) return "running";
  // Timeout metadata belongs to the outer result envelope, not page/script data.
  if (record(record(tool?.result).incomplete).reason === "timeout") return "incomplete";
  return "success";
}

export function isToolResultErrorLike(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (record(value).ok === false || record(value).isError === true || record(value).error) return true;
  const code = String(record(value).code || "").trim().toUpperCase();
  return Boolean(code && !TOOL_SUCCESS_CODES.has(code) && TOOL_FAILURE_CODE_PATTERN.test(code));
}

function isToolAborted(tool: ToolEvent | null | undefined, ...values: unknown[]) {
  if (tool?.phase === "aborted") return true;
  return [tool?.result, ...values].some(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const code = String(record(value).code || "").toUpperCase();
    return record(value).interrupted === true && (code === "TOOL_ABORTED" || code === "ABORTED");
  });
}
