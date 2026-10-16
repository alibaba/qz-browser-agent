import type { ToolContext } from "../../sdk/background.js";
import type { SkillRenderer } from "../../shared/skills/skill-renderers.js";
import { rendererT } from "../../shared/skills/renderer-messages.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { t } from "../../shared/i18n/backend.js";
import { ToolExecutionError } from "../tools/arguments.js";
import { copyToolEffects } from "../tools/effects.js";
import type { SkillBuiltinExecutor } from "./skill-tool-runtime.js";

type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};

/** Collection work has finished before this runs; the Session owns the human wait. */
export async function selectSkillResults(renderer: SkillRenderer, result: unknown, signal: AbortSignal | undefined,
  context: ToolContext, execute: SkillBuiltinExecutor): Promise<unknown> {
  assertActive(signal);
  const labels = withLanguage(context.language || getLanguage(), () => ({
    title: rendererT("selectionTitle"),
    invalidItems: t("toolError.SKILL_SELECTION_INVALID_ITEMS.message"),
    invalidAnswer: t("toolError.SKILL_SELECTION_INVALID_ANSWER.message"),
  }));
  const invalidItems = () => new ToolExecutionError("SKILL_SELECTION_INVALID_ITEMS", labels.invalidItems);
  const outer = record(result);
  const wrapped = Object.hasOwn(outer, "result") && ["_plugin", "ok", "hasResult", "resultType", "engine"]
    .some(key => Object.hasOwn(outer, key));
  const inner = wrapped ? outer.result : result;
  if (failed(outer) || failed(record(inner))) return result;
  const payload = mcpData(inner, record(outer._plugin).runtime === "mcp");
  const data = renderer.sourcePath ? atPath(payload, renderer.sourcePath) : payload;
  const candidates = atPath(data, renderer.itemsPath || "items");
  if (!Array.isArray(candidates) || candidates.length > 50) throw invalidItems();
  const items = new Map<string, Data>();
  const options = candidates.map(candidate => {
    const item = record(candidate);
    const value = atPath(item, renderer.itemIdPath || "id");
    const label = atPath(item, renderer.itemTitlePath || "title");
    if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512 || items.has(value)
      || typeof label !== "string" || !label.trim()) throw invalidItems();
    items.set(value, item);
    const meta = (renderer.itemMeta || []).slice(0, 6).map(field => {
      const value = field.path ? atPath(item, field.path) : field.value;
      const text = displayText(value, 80);
      return text ? (field.label ? `${field.label}: ${text}` : text).slice(0, 80) : "";
    }).filter(Boolean);
    return {
      value, label: label.slice(0, 240),
      description: displayText(atPath(item, renderer.itemSubtitlePath || "description"), 1000),
      ...(meta.length ? { meta } : {}),
      ...(renderer.itemImagePath ? { imageUrl: webUrl(atPath(item, renderer.itemImagePath)) } : {}),
      ...(renderer.urlPath ? { url: webUrl(atPath(item, renderer.urlPath)) } : {}),
    };
  });
  let selectedIds: string[] = [];
  if (options.length) {
    const title = displayText(renderer.titlePath ? atPath(data, renderer.titlePath) : renderer.title, 512) || labels.title;
    const message = displayText(renderer.subtitlePath ? atPath(data, renderer.subtitlePath) : renderer.subtitle, 2000) || title;
    const answer = record(await execute("ask_user", {
      title, message, ...(renderer.submitLabel ? { submitLabel: renderer.submitLabel } : {}),
      fields: [{ id: "selectedIds", label: title, type: renderer.selectionMode === "single" ? "single_choice" : "multi_choice",
        presentation: "cards", required: renderer.required !== false, options }],
    }, signal, context));
    assertActive(signal);
    const values = record(answer.answers).selectedIds;
    selectedIds = typeof values === "string" ? (values ? [values] : []) : Array.isArray(values) ? values : [];
    if (answer.submitted !== true || (typeof values !== "string" && !Array.isArray(values))
      || selectedIds.some(id => typeof id !== "string" || !items.has(id))
      || new Set(selectedIds).size !== selectedIds.length
      || (renderer.selectionMode === "single" && selectedIds.length > 1)
      || (renderer.required !== false && selectedIds.length === 0)) {
      throw new ToolExecutionError("SKILL_SELECTION_INVALID_ANSWER", labels.invalidAnswer);
    }
  }
  const selected = { selectedIds, selectedItems: selectedIds.map(id => items.get(id)!), totalItems: items.size };
  // The wait transcript retains the candidate presentation. The model receives only chosen rows.
  const metadata = record(inner)._plugin || outer._plugin;
  const compact = { ...selected, ...(metadata ? { _plugin: metadata } : {}) };
  return copyToolEffects(result, wrapped ? { ...outer, result: compact } : {
    ...compact, ...(outer.trace ? { trace: outer.trace } : {}),
  });
}

function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)
      || ["__proto__", "constructor", "prototype"].includes(key)) return undefined;
    current = (current as Data)[key];
  }
  return current;
}

function mcpData(value: unknown, mcp: boolean): unknown {
  if (!mcp) return value;
  const data = record(value);
  if (data.structuredContent !== undefined) return data.structuredContent;
  const text = Array.isArray(data.content) ? data.content.map(record).filter(item => item.type === "text")
    .map(item => String(item.text || "")).join("\n") : String(data.text || "");
  try { return text ? JSON.parse(text) : value; } catch { return value; }
}

function displayText(value: unknown, limit: number): string {
  return ["string", "number", "boolean"].includes(typeof value) ? String(value).trim().slice(0, limit) : "";
}
function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url.href : "";
  } catch { return ""; }
}
function failed(value: Data) { return Boolean(value.error || value.ok === false || value.isError === true); }
function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Skill result selection aborted");
}
