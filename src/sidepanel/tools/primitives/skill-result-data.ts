import { skillMetaFromResult } from "../skill-renderer-context.js";
import { record } from "../renderer-input.js";
import { unwrapResultValue } from "../generic-result-renderer.js";
type Data = Record<string, unknown>;

/** Normalize historical Skill/MCP result envelopes without loading a capability package. */
export function skillResultData(result: unknown, originalResult: unknown, plugin: Data | null = null) {
  const source = skillResultEnvelope(result, originalResult);
  const data = unwrapResultValue(source).envelope ? record(source).result : source;
  const meta = skillMetaFromResult(originalResult, result);
  return (meta?.runtime || plugin?.runtime) === "mcp" ? normalizeMcpRendererData(data) : data;
}

/** Presentation belongs to the host envelope, never to the returned business subtree. */
export function skillResultEnvelope(result: unknown, originalResult: unknown) {
  const source = originalResult ?? result;
  const historical = record(source);
  const nested = record(historical.result);
  const envelope = Object.keys(historical).length === 1 && nested._plugin && typeof nested._plugin === "object"
    && !Array.isArray(nested._plugin) && unwrapResultValue(nested).envelope
    ? nested : source;
  return unwrapResultValue(envelope).envelope ? stripSkillMeta(envelope) : envelope;
}

export function stripSkillMeta(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value;
  const out = { ...record(value) };
  delete out._plugin;
  return out;
}

export function normalizeMcpRendererData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = record(value);
  const text = mcpTextFromResult(data);
  const structured = data.structuredContent !== undefined
    ? data.structuredContent
    : parseMcpJsonText(text);
  if (structured !== undefined) {
    return mergeMcpStructuredData(structured, data, text);
  }
  return text ? { ...value, text } : value;
}

function mergeMcpStructuredData(structured: unknown, value: Data = {}, text = "") {
  const base = {
    ...(text ? { text } : {}),
    ...(Array.isArray(value.content) ? { content: value.content } : {}),
    ...(value.raw !== undefined ? { raw: value.raw } : {}),
  };
  if (Array.isArray(structured)) {
    return {
      ...base,
      items: structured,
      rows: structured,
      records: structured,
      structuredContent: structured,
    };
  }
  if (structured && typeof structured === "object") {
    return {
      ...base,
      ...structured,
      structuredContent: structured,
    };
  }
  return {
    ...base,
    value: structured,
    structuredContent: structured,
  };
}

function mcpTextFromResult(value: Data = {}) {
  if (typeof value?.text === "string" && value.text.trim()) return value.text;
  const content = Array.isArray(value?.content) ? value.content.map(record) : [];
  return content
    .filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .filter(Boolean)
    .join("\n");
}

function parseMcpJsonText(text = ""): unknown {
  const raw = String(text || "").trim();
  if (!raw || !/^[\[{]/.test(raw)) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return undefined;
  }
}
