import { stringifyJsonSafe } from "#sdk/shared/format";
import { trace } from "#sdk/background/tools";
import { normalizeHeaderToken } from "#sdk/background/providers";
import {
  contentToPlainText,
  getToolCallArgumentsValue,
  normalizeToolCallName,
  createAssistantProviderState,
  formatOutputTruncatedError,
  isOutputTruncatedFinishReason,
  isReplayableProviderState,
  PROVIDER_STATE_OPENAI_REASONING,
  resolveRequestMaxOutputTokens,
} from "#sdk/background/providers";
import {
  fetchLlmEndpointWithRetry,
  readWithIdleTimeout,
  REQUEST_TIMEOUT,
  withTimeout,
} from "#sdk/background/providers";
import { normalizeLlmFailure } from "#sdk/background/providers";

import type { ModelMessage, ModelToolCall } from '#sdk/shared/models';
import type { RuntimeConfig } from '#sdk/background/providers';
import type { ProviderDefinition } from '#sdk/background/providers';
import type { ModelOptions, ModelEvent, RawModelExchange } from '#sdk/background/providers';
interface WireToolCall extends Record<string, unknown> { id?: string; index?: number; type?: string; function?: Record<string, unknown> }
interface OpenAiMessage extends ModelMessage { tool_calls?: ModelToolCall[] }
interface OpenAiEnvelope extends Record<string, unknown> {
  choices?: { message?: OpenAiMessage; delta?: Record<string, unknown> & { tool_calls?: WireToolCall[] }; finish_reason?: string }[];
  usage?: Record<string, unknown>; model?: string;
}
interface ToolCall extends ModelToolCall { type: string; function: { name: string; arguments: string } }
interface ThinkPart { type: 'text' | 'thinking'; delta: string }
interface ErrorOptions { assistantContent?: boolean; allowAnyErrorEnvelope?: boolean }
interface FunctionTool { type: string; function: { name: string; parameters: object; description?: string; strict?: boolean } }

const STREAM_IDLE_TIMEOUT = 45000;
const MAX_RAW_PROVIDER_ERROR_CHARS = 4000;
const OPENAI_REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];
const PROVIDER_ERROR_CODE_PATTERN = /^(?:PROXY|UPSTREAM|GATEWAY|MODEL|LLM)_[A-Z0-9_]+$/i;

function normalizeOpenAiAssistantMessage(message: ModelMessage, providerDef: Partial<ProviderDefinition> = {}, config: RuntimeConfig = {}): ModelMessage {
  const normalized: ModelMessage = { ...(message || {}) };
  const reasoning = extractOpenAiReasoningFromMessage(normalized);
  if (Array.isArray(normalized.tool_calls)) {
    normalized.tool_calls = normalized.tool_calls.map(normalizeOpenAiToolCall).filter((call): call is ToolCall => call !== null);
  }
  if (reasoning.text) {
    normalized._thinking = `${normalized._thinking || ""}${reasoning.text}`;
  }
  for (const field of OPENAI_REASONING_FIELDS) delete normalized[field];
  if (providerDef.contentThinkTags && typeof normalized.content === "string") {
    const split = splitThinkTaggedText(normalized.content);
    if (split.changed) {
      normalized.content = split.content || null;
      if (split.thinking) normalized._thinking = `${normalized._thinking || ""}${split.thinking}`;
    }
  }
  if (reasoning.text && hasOpenAiAssistantPayload(normalized)) {
    normalized._providerState = createAssistantProviderState(config, providerDef, {
      kind: PROVIDER_STATE_OPENAI_REASONING,
      reasoningField: reasoning.field,
      reasoningText: reasoning.text,
    });
  }
  return normalized;
}

function extractOpenAiReasoningFromMessage(message: Record<string, unknown> = {}) {
  for (const field of OPENAI_REASONING_FIELDS) {
    const value = message?.[field];
    if (typeof value === "string" && value.length > 0) {
      return { field, text: value };
    }
  }
  return { field: "", text: "" };
}

function pickOpenAiReasoningDelta(delta: Record<string, unknown> = {}) {
  for (const field of OPENAI_REASONING_FIELDS) {
    const value = delta?.[field];
    if (typeof value === "string" && value.length > 0) {
      return { field, delta: value };
    }
  }
  return { field: "", delta: "" };
}

function convertOpenAiMessagesForRequest(messages: ModelMessage[] = [], config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}) {
  return (Array.isArray(messages) ? messages : [])
    .map(msg => normalizeOpenAiMessageForRequest(msg, config, providerDef))
    .filter(Boolean);
}

function normalizeOpenAiMessageForRequest(msg: ModelMessage, config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}): ModelMessage | null {
  if (!msg || typeof msg !== "object" || typeof msg.role !== "string") return null;
  if (msg.role === "system") {
    const content = contentToPlainText(msg.content);
    return content ? { role: "system", content } : null;
  }
  if (msg.role === "user") {
    const content = cloneOpenAiContent(msg.content);
    return isEmptyOpenAiContent(content) ? null : { role: "user", content };
  }
  if (msg.role === "tool") {
    const toolCallId = String(msg.tool_call_id || "");
    if (!toolCallId) return null;
    return { role: "tool", tool_call_id: toolCallId, content: contentToPlainText(msg.content) };
  }
  if (msg.role === "assistant") {
    const out: ModelMessage = {
      role: "assistant",
      content: typeof msg.content === "string" && msg.content ? msg.content : null,
    };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      out.tool_calls = msg.tool_calls.map(normalizeOpenAiToolCallForRequest).filter((call): call is ToolCall => call !== null);
    }
    if (!hasOpenAiAssistantPayload(out)) return null;

    const state = msg._providerState;
    if (
      isReplayableProviderState(state, config, providerDef)
      && state.kind === PROVIDER_STATE_OPENAI_REASONING
      && OPENAI_REASONING_FIELDS.includes(String(state.reasoningField || ""))
      && typeof state.reasoningText === "string"
      && state.reasoningText
    ) {
      out[String(state.reasoningField)] = state.reasoningText;
    }
    return out;
  }
  return null;
}

function cloneOpenAiContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const value of content as unknown[]) {
    const part = record(value);
    if (part?.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part?.type === "image_url") {
      const url = String(record(part.image_url).url || "");
      if (url) {
        parts.push({
          type: "image_url",
          image_url: {
            url,
            detail: record(part.image_url).detail || "auto",
          },
        });
      }
    }
  }
  return parts;
}

function isEmptyOpenAiContent(content: unknown) {
  if (typeof content === "string") return !content.trim();
  if (Array.isArray(content)) return content.length === 0;
  return true;
}

function hasOpenAiAssistantPayload(message: Record<string, unknown> = {}) {
  // Chat Completions requires assistant messages to include more than reasoning fields.
  const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return hasContent || hasToolCalls;
}

function normalizeOpenAiToolCall(value: unknown, index = 0): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const toolCall = record(value);
  const fn = record(toolCall.function);
  const name = normalizeToolCallName(toolCall);
  const argsText = normalizeOpenAiToolArgumentsText(getToolCallArgumentsValue(toolCall));
  return {
    ...toolCall,
    id: String(toolCall.id || `call_${Date.now()}_${index}`),
    type: String(toolCall.type || "function"),
    function: {
      ...fn,
      name,
      arguments: argsText,
    },
  };
}

function normalizeOpenAiToolCallForRequest(toolCall: unknown, index = 0) {
  const normalized = normalizeOpenAiToolCall(toolCall, index);
  if (!normalized?.function?.name) return null;
  return {
    id: normalized.id,
    type: "function",
    function: {
      name: normalized.function.name,
      arguments: normalized.function.arguments,
    },
  };
}

function normalizeOpenAiToolArgumentsText(value: unknown) {
  const fragment = normalizeOpenAiToolArgumentsFragment(value);
  return fragment || "{}";
}

function normalizeOpenAiToolArgumentsFragment(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) || "";
  } catch (_err) {
    return "";
  }
}

function splitThinkTaggedText(text: string) {
  const splitter = createThinkTagSplitter(true);
  let content = "";
  let thinking = "";
  for (const part of splitter.feed(text, { flush: true })) {
    if (part.type === "thinking") {
      thinking += part.delta;
    } else {
      content += part.delta;
    }
  }
  const changed = content !== String(text || "") || Boolean(thinking);
  return { content, thinking, changed };
}

function createThinkTagSplitter(enabled = false) {
  return {
    enabled: enabled === true,
    inThinking: false,
    justClosedThinking: false,
    buffer: "",
    feed(input: unknown, { flush = false } = {}): ThinkPart[] {
      const value = String(input ?? "");
      if (!this.enabled) return value ? [{ type: "text", delta: value }] : [];
      let text = `${this.buffer}${value}`;
      this.buffer = "";
      const parts: ThinkPart[] = [];

      while (text) {
        if (this.inThinking) {
          const closeTag = findThinkTag(text, "close");
          if (closeTag) {
            pushThinkTagPart(parts, "thinking", text.slice(0, closeTag.index), this);
            text = text.slice(closeTag.end);
            this.inThinking = false;
            this.justClosedThinking = true;
            continue;
          }
          const keep = flush ? 0 : trailingPartialThinkTagLength(text, "close");
          const delta = keep ? text.slice(0, -keep) : text;
          pushThinkTagPart(parts, "thinking", delta, this);
          this.buffer = keep ? text.slice(-keep) : "";
          text = "";
          continue;
        }

        const openTag = findThinkTag(text, "open");
        if (openTag) {
          pushThinkTagPart(parts, "text", text.slice(0, openTag.index), this);
          text = text.slice(openTag.end);
          this.inThinking = true;
          this.justClosedThinking = false;
          continue;
        }

        const keep = flush ? 0 : trailingPartialThinkTagLength(text, "open");
        const delta = keep ? text.slice(0, -keep) : text;
        pushThinkTagPart(parts, "text", delta, this);
        this.buffer = keep ? text.slice(-keep) : "";
        text = "";
      }

      if (flush && this.buffer) {
        pushThinkTagPart(parts, this.inThinking ? "thinking" : "text", this.buffer, this);
        this.buffer = "";
      }
      return parts;
    },
  };
}

function pushThinkTagPart(parts: ThinkPart[], type: ThinkPart["type"], delta: string, splitter: {justClosedThinking: boolean}) {
  let value = String(delta || "");
  if (type === "text" && splitter.justClosedThinking) {
    value = value.replace(/^\s+/, "");
    if (value) splitter.justClosedThinking = false;
  }
  if (!value) return;
  parts.push({ type, delta: value });
}

function findThinkTag(text: string, kind: "open" | "close") {
  const pattern = kind === "close" ? /<\/think\s*>/i : /<think\s*>/i;
  const match = pattern.exec(text);
  return match ? { index: match.index, end: match.index + match[0].length } : null;
}

function trailingPartialThinkTagLength(text: string, kind: "open" | "close") {
  const lower = String(text || "").toLowerCase();
  // A partial tag contains exactly one "<", so only the last one can start it.
  const index = lower.lastIndexOf("<");
  if (index < 0) return 0;
  const suffix = lower.slice(index);
  if (kind === "close") return "</think".startsWith(suffix) || /^<\/think\s*$/.test(suffix) ? suffix.length : 0;
  return "<think".startsWith(suffix) || /^<think\s*$/.test(suffix) ? suffix.length : 0;
}

export async function chatOpenAi(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig) {
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};

  const body = buildRequestBody(config, messages, tools, false, options);
  const rawExchange = options?.rawExchange && typeof options.rawExchange === "object"
    ? options.rawExchange
    : null;
  const requestBodyText = stringifyJsonSafe(body);
  if (rawExchange) {
    rawExchange.requestBody = requestBodyText;
    // Preserve the resolved wire model for injected request tracing.
    rawExchange.requestModel = String(body.model || "");
  }
  const { signal: requestSignal, cleanup } = withTimeout(signal, REQUEST_TIMEOUT);

  try {
    const resp = await fetchLlmEndpointWithRetry(config, "chat", {
      method: "POST",
      headers: buildHeaders(config, options),
      body: requestBodyText,
      signal: requestSignal,
    }, options);

    if (rawExchange) captureRawResponseHeaders(rawExchange, resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (rawExchange) rawExchange.responseBody = text;
      throw normalizeLlmFailure(new Error(`LLM API ${resp.status}`), {
        status: resp.status,
        headers: resp.headers,
        body: text,
        provider: config.provider,
        phase: "chat",
      });
    }

    const responseText = rawExchange ? await resp.text().catch(() => "") : "";
    if (rawExchange) rawExchange.responseBody = responseText;
    const data = rawExchange ? parseJsonObject(responseText) : parseJsonObject(await resp.text());
    if (!data) {
      throw new Error("LLM API returned an invalid JSON response");
    }
    if (rawExchange) captureRawResponseIds(rawExchange, data);
    throwIfOpenAiProviderError(data);
    const choice = data.choices?.[0];
    if (rawExchange && choice?.finish_reason) {
      rawExchange.finishReason = String(choice.finish_reason);
    }
    if (!choice?.message) {
      throw new Error("LLM API returned no message");
    }
    if (choice.finish_reason === "error_finish") {
      throwOpenAiErrorFinish(choice.message?.content, { phase: "chat" });
    }
    throwIfOpenAiProviderError(choice.message?.content, { assistantContent: true });
    if (choice.finish_reason === "content_filter") {
      throw new Error("LLM API stopped by content_filter");
    }
    if (isOutputTruncatedFinishReason(choice.finish_reason)) {
      throw new Error(formatOutputTruncatedError(choice.finish_reason));
    }
    return {
      message: normalizeOpenAiAssistantMessage(choice.message, providerDef, config),
      usage: data.usage,
    };
  } finally {
    cleanup();
  }
}

export async function* chatStreamOpenAi(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig): AsyncGenerator<ModelEvent> {
  const body = buildRequestBody(config, messages, tools, true, options);
  const rawExchange = options?.rawExchange && typeof options.rawExchange === "object"
    ? options.rawExchange
    : null;
  const requestBodyText = stringifyJsonSafe(body);
  if (rawExchange) {
    rawExchange.requestBody = requestBodyText;
    rawExchange.requestModel = String(body.model || "");
  }
  // Limit the connection and first-byte phases; streaming has no total duration limit.
  // After the response body arrives, enforce only the idle timeout between chunks.
  const { signal: requestSignal, cleanup } = withTimeout(signal, REQUEST_TIMEOUT);
  const streamSignal = signal || new AbortController().signal;

  // Accumulate the complete assistant message.
  let fullContent = "";
  let fullThinking = "";
  let openAiReasoningField = "";
  const toolCallsMap = new Map<number, ToolCall>();
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let sawDone = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let sseEventName = "";
  let sseEventStatus = 0;
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};
  const thinkTagSplitter = createThinkTagSplitter(providerDef.contentThinkTags);
  const onAbort = () => { try { reader?.cancel(); } catch(_e) {} };

  try {
    const resp = await fetchLlmEndpointWithRetry(config, "stream", {
      method: "POST",
      headers: buildHeaders(config, options),
      body: requestBodyText,
      signal: requestSignal,
    }, options);

    if (rawExchange) captureRawResponseHeaders(rawExchange, resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (rawExchange) rawExchange.responseBody = text;
      throw normalizeLlmFailure(new Error(`LLM API ${resp.status}`), {
        status: resp.status,
        headers: resp.headers,
        body: text,
        provider: config.provider,
        phase: "stream",
      });
    }
    if (!resp.body) {
      throw new Error("LLM API returned an empty stream body");
    }

    // Parse the SSE stream.
    reader = resp.body.getReader();
    cleanup();
    const decoder = new TextDecoder();
    let buffer = "";

    // Cancel the reader on abort; the fetch signal may leave an acquired body stream open.
    streamSignal.addEventListener("abort", onAbort, { once: true });

    let _chunkCount = 0;
    let _lastChunkTime = Date.now();
    trace(`stream start, model=${config.model}, msgs=${messages.length}, affinity=${getSessionAffinityId(options.sessionId)}`);

    const processLine = function*(rawLine: string): Generator<ModelEvent> {
      const line = rawLine.trim();
      if (!line) {
        sseEventName = "";
        sseEventStatus = 0;
        return;
      }
      if (line.startsWith("event:")) {
        sseEventName = line.slice(6).trim().toLowerCase();
        return;
      }
      if (sseEventName === "error" && line.startsWith(":")) {
        const match = line.match(/^:HTTP_STATUS\/(\d{3})$/i);
        if (match) sseEventStatus = Number(match[1]);
        return;
      }
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trimStart();
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }

      let chunk: OpenAiEnvelope;
      try {
        const parsed = parseJsonObject(data);
        if (!parsed) throw new Error("Invalid SSE JSON object");
        chunk = parsed;
      } catch(_e) {
        trace(`skip invalid SSE JSON: ${data.slice(0, 120)}`);
        return;
      }

      if (sseEventName === "error") {
        throwOpenAiSseEventError(chunk, { status: sseEventStatus });
      }
      throwIfOpenAiProviderError(chunk);

      if (rawExchange) captureRawResponseIds(rawExchange, chunk);
      if (chunk.usage) {
        usage = chunk.usage;
        yield { type: "usage", usage };
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        if (rawExchange) rawExchange.finishReason = String(choice.finish_reason);
        trace(`finish_reason=${choice.finish_reason} chunk#${_chunkCount}`);
      }

      const delta = choice.delta;
      if (choice.finish_reason === "error_finish") {
        const errorContent = `${fullContent}${typeof delta?.content === "string" ? delta.content : ""}`;
        throwOpenAiErrorFinish(errorContent, { phase: "stream" });
      }
      if (!delta) return;

      // Thinking and reasoning fields, including reasoning_content and reasoning
      const reasoning = pickOpenAiReasoningDelta(delta);
      if (reasoning.delta) {
        if (!openAiReasoningField) openAiReasoningField = reasoning.field;
        fullThinking += reasoning.delta;
        yield { type: "thinking_delta", delta: reasoning.delta };
      }

      // Text content
      if (delta.content) {
        throwIfOpenAiProviderError(delta.content, { assistantContent: true });
        for (const contentEvent of splitContentDelta(delta.content)) {
          yield contentEvent;
        }
      }

      // Incrementally assemble tool calls.
      // Fireworks repeats the id in each chunk; deduplicate by index.
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const wasNew = !toolCallsMap.has(idx);
          if (wasNew) {
            toolCallsMap.set(idx, {
              id: tc.id || `call_${Date.now()}_${idx}`,
              type: "function",
              function: { name: "", arguments: "" },
            });
          }
          const existing = toolCallsMap.get(idx)!;
          if (tc.id && (!existing.id || existing.id.startsWith("call_"))) existing.id = tc.id;
          const toolName = normalizeToolCallName(tc);
          if (toolName) existing.function.name = toolName;
          const argDelta = normalizeOpenAiToolArgumentsFragment(getToolCallArgumentsValue(tc, {
            allowWhitespaceOnly: true,
          }));
          if (argDelta) existing.function.arguments += argDelta;
          if (wasNew || toolName || argDelta) {
            yield {
              type: "tool_call_update",
              index: idx,
              toolCallId: existing.id,
              toolName: existing.function.name || "",
              delta: argDelta,
              arguments: existing.function.arguments || "",
              isStart: wasNew,
            };
          }
        }
      }
    };

    while (true) {
      if (streamSignal.aborted) throw new DOMException("Aborted", "AbortError");
      const readStart = Date.now();
      const { done, value } = await readWithIdleTimeout(reader, STREAM_IDLE_TIMEOUT, streamSignal);
      const readMs = Date.now() - readStart;
      _chunkCount++;

      if (done) {
        trace(`stream done, chunks=${_chunkCount}, thinking=${fullThinking.length}c, content=${fullContent.length}c, tools=${toolCallsMap.size}`);
        const flushed = decoder.decode();
        if (rawExchange) rawExchange.responseBody = (rawExchange.responseBody || "") + flushed;
        buffer += flushed;
        break;
      }

      if (_chunkCount % 10 === 1 || readMs > 5000) {
        trace(`chunk#${_chunkCount} readMs=${readMs} bytes=${value?.length} gap=${Date.now() - _lastChunkTime}ms`);
      }
      _lastChunkTime = Date.now();

      const decoded = decoder.decode(value, { stream: true });
      if (rawExchange) rawExchange.responseBody = (rawExchange.responseBody || "") + decoded;
      buffer += decoded;

      // Parse SSE one line at a time.
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        for (const event of processLine(line)) {
          yield event;
        }
      }
    }

    if (buffer.trim()) {
      for (const event of processLine(buffer)) {
        yield event;
      }
    }
    for (const contentEvent of splitContentDelta("", { flush: true })) {
      yield contentEvent;
    }

    throwIfOpenAiProviderError(fullContent, { assistantContent: true });

    if (!finishReason) {
      throw new Error(sawDone ? "Stream ended without finish_reason" : "Stream disconnected before finish_reason");
    }
    if (finishReason === "content_filter") {
      throw new Error("Provider finish_reason: content_filter");
    }
    if (isOutputTruncatedFinishReason(finishReason)) {
      throw new Error(formatOutputTruncatedError(finishReason));
    }
    if (finishReason === "network_error") {
      throw new Error("Provider finish_reason: network_error");
    }
  } finally {
    streamSignal.removeEventListener("abort", onAbort);
    cleanup();
    try { reader?.releaseLock(); } catch(_e) {}
  }

  // Assemble the final message.
  // Tool-call messages require explicit null content when no text is present.
  // Fireworks and OpenAI reject undefined content with HTTP 400.
  const message: ModelMessage = { role: "assistant", content: fullContent || null };
  if (toolCallsMap.size > 0) {
    message.tool_calls = [...toolCallsMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, toolCall]) => toolCall);
  }
  if (fullThinking) {
    message._thinking = fullThinking;
    if (openAiReasoningField && hasOpenAiAssistantPayload(message)) {
      message._providerState = createAssistantProviderState(config, providerDef, {
        kind: PROVIDER_STATE_OPENAI_REASONING,
        reasoningField: openAiReasoningField,
        reasoningText: fullThinking,
      });
    }
  }
  if (usage) message._usage = usage;

  yield { type: "done", message };

  function* splitContentDelta(contentDelta: unknown, { flush = false } = {}): Generator<ModelEvent> {
    for (const part of thinkTagSplitter.feed(contentDelta, { flush })) {
      if (!part.delta) continue;
      if (part.type === "thinking") {
        fullThinking += part.delta;
        yield { type: "thinking_delta", delta: part.delta };
      } else {
        fullContent += part.delta;
        throwIfOpenAiProviderError(fullContent, { assistantContent: true });
        yield { type: "text_delta", delta: part.delta };
      }
    }
  }
}

function throwIfOpenAiProviderError(value: unknown, options: ErrorOptions = {}) {
  const error = openAiProviderError(value, options);
  if (!error) return;
  trace(`OpenAI provider response error code=${error.code}`);
  throw error;
}

function throwOpenAiSseEventError(value: unknown, { status = 0, phase = "stream" } = {}) {
  const error = normalizeLlmFailure(new Error("OpenAI SSE error event"), {
    payload: value,
    status,
    phase,
  });
  trace(`OpenAI SSE error event code=${error.code}${error.status ? ` status=${error.status}` : ""}`);
  throw error;
}

function throwOpenAiErrorFinish(value: unknown, { phase = "stream" } = {}) {
  const providerError = openAiProviderError(value, {
    assistantContent: true,
    allowAnyErrorEnvelope: true,
  });
  if (providerError) throw providerError;

  const embedded = parseEmbeddedOpenAiSseError(value);
  if (embedded) {
    throwOpenAiSseEventError(embedded.payload, {
      status: embedded.status,
      phase,
    });
  }

  const rawError = String(value || "").trim();
  const genericError = normalizeLlmFailure(new Error("OpenAI provider returned error_finish"), {
    code: "LLM_PROVIDER_ERROR",
    phase,
    message: rawError,
  });
  if (rawError) genericError.message = rawError.slice(0, MAX_RAW_PROVIDER_ERROR_CHARS);
  throw genericError;
}

function parseEmbeddedOpenAiSseError(value: unknown) {
  const lines = String(value || "").split(/\r?\n/);
  let eventName = "";
  let status = 0;
  const dataLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim().toLowerCase();
      continue;
    }
    if (eventName && eventName !== "error") continue;
    const statusMatch = line.match(/^:HTTP_STATUS\/(\d{3})$/i);
    if (statusMatch) {
      status = Number(statusMatch[1]);
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if ((eventName && eventName !== "error") || dataLines.length === 0) return null;
  try {
    const payload = JSON.parse(dataLines.join("\n"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (!eventName && !providerErrorEnvelope(payload)) return null;
    return { payload, status };
  } catch (_error) {
    return null;
  }
}

function openAiProviderError(value: unknown, {
  assistantContent = false,
  allowAnyErrorEnvelope = false,
}: ErrorOptions = {}) {
  const envelope = assistantContent
    ? providerErrorEnvelopeFromAssistantContent(value)
    : providerErrorEnvelope(value);
  if (!envelope) return null;

  const payload = envelope?.error && typeof envelope.error === "object"
    ? record(envelope.error)
    : envelope;
  const type = String(payload?.type || envelope?.type || "").trim().toLowerCase();
  const explicitCode = String(payload?.code || envelope?.code || "").trim();
  const message = String(
    payload?.message
    || payload?.error
    || envelope?.message
    || (typeof envelope?.error === "string" ? envelope.error : ""),
  ).trim();
  if (assistantContent && !allowAnyErrorEnvelope && !isRecognizableProviderError(explicitCode, type, message)) return null;
  const code = explicitCode || (type === "upstream_error" ? "UPSTREAM_ERROR" : "LLM_PROVIDER_RESPONSE_ERROR");
  const providerDetail = message || stringifyJsonSafe(envelope) || "OpenAI provider response error";

  return normalizeLlmFailure(new Error(providerDetail.slice(0, MAX_RAW_PROVIDER_ERROR_CHARS)), {
    payload: envelope,
    code: code || "LLM_PROVIDER_RESPONSE_ERROR",
    phase: "stream",
  });
}

function providerErrorEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = record(value);
  const type = String(envelope.type || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(envelope, "error")) return envelope;
  if (type === "upstream_error") return envelope;
  return null;
}

function providerErrorEnvelopeFromAssistantContent(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  const directEnvelope = providerErrorEnvelope(parseJsonObject(text));
  if (directEnvelope) return directEnvelope;

  for (let index = value.lastIndexOf("\n{"); index >= 0; index = index > 0 ? value.lastIndexOf("\n{", index - 1) : -1) {
    const suffix = value.slice(index + 1).trim();
    const envelope = providerErrorEnvelope(parseJsonObject(suffix));
    if (envelope) return envelope;
  }
  return null;
}

function parseJsonObject(value: unknown): OpenAiEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as OpenAiEnvelope : null;
  } catch (_error) {
    return null;
  }
}

function isRecognizableProviderError(code = "", type = "", message = "") {
  if (type === "upstream_error") return true;
  if (PROVIDER_ERROR_CODE_PATTERN.test(code)) return true;
  return /upstream_error|SSE data is not (?:a )?valid LLM response|(?:upstream|proxy|gateway).*(?:error|invalid|failed)/i.test(message);
}

/** Route a conversation to the same Fireworks replica for prompt caching. */
let _fallbackSessionAffinity: string | null = null;
function getSessionAffinityId(sessionId: unknown) {
  const normalized = normalizeHeaderToken(sessionId);
  if (normalized) return `qz-${normalized}`;
  if (!_fallbackSessionAffinity) {
    _fallbackSessionAffinity = `qz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return _fallbackSessionAffinity;
}

function captureRawResponseHeaders(rawExchange: RawModelExchange, resp: Response) {
  try {
    // The gateway may emit the same response header twice; Headers.get()
    // joins multi-values with ", ", so keep only the first value.
    const get = (name: string) => String(resp?.headers?.get?.(name) || "").split(",")[0].trim();
    const requestId = get("x-request-id");
    if (requestId && !rawExchange.requestId) rawExchange.requestId = requestId;
  } catch (_error) {}
}

// The data spec keeps two vendor ids apart: dashscope_request_id is the
// gateway request_id (headers or body), dashscope_id is the response's own id.
function captureRawResponseIds(rawExchange: RawModelExchange, payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  const data = record(payload);
  const responseId = String(data.id || "").trim();
  if (!rawExchange.responseId && responseId) {
    rawExchange.responseId = responseId;
  }
  if (!rawExchange.requestId) {
    const requestId = String(
      data.request_id
        || record(data.routify_response).request_id
        // Some compatible gateways expose the completion id as their request id.
        || responseId
        || "",
    ).trim();
    if (requestId) rawExchange.requestId = requestId;
  }
}

function buildHeaders(config: RuntimeConfig, options: ModelOptions = {}) {
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};
  const headers: Record<string, string> = {
    ...options.baseHeaders,
    "Content-Type": "application/json",
    ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
  };
  // An injected W3C traceparent continues the same trace across the gateway.
  const traceparent = String(options.traceparent || "").trim();
  if (/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)) {
    headers.traceparent = traceparent;
  }
  // The W3C baggage header carries the conversation id alongside.
  const baggage = String(options.baggage || "").trim();
  if (baggage && !/[\r\n]/.test(baggage)) headers.baggage = baggage;
  for (const [name, value] of Object.entries(record(config.providerHeaders))) {
    if (!/^x-[a-z0-9-]+$/i.test(name)) continue;
    if (typeof providerDef.sessionAffinityHeader === "string" && name.toLowerCase() === providerDef.sessionAffinityHeader.toLowerCase()) continue;
    const text = String(value || "").trim();
    if (text) headers[name] = text;
  }
  if (providerDef.sessionAffinityHeader === true) {
    headers["x-session-affinity"] = getSessionAffinityId(options.sessionId);
  }
  return headers;
}

function buildRequestBody(config: RuntimeConfig, messages: ModelMessage[], tools: object[], stream: boolean, options: ModelOptions = {}) {
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};
  const outputTokenParam = providerDef.outputTokenParam;
  const modelParameters = config.modelParameters || {};
  const body: Record<string, unknown> & { tools?: FunctionTool[] } = {
    ...(providerDef.requestDefaults || {}),
    ...modelParameters,
    model: config.model,
    messages: convertOpenAiMessagesForRequest(messages, config, providerDef),
    stream,
  };
  // Chat Completions limits are optional. Only an explicit provider policy supplies a default.
  if (outputTokenParam && ![outputTokenParam, "max_tokens", "max_completion_tokens"].some(key => Object.hasOwn(body, key))) {
    body[outputTokenParam] = Math.min(resolveRequestMaxOutputTokens(options), config.maxOutputTokens || Infinity);
  }
  if (stream) {
    body.stream_options = { include_usage: true };
  }
  if (tools && tools.length > 0) {
    body.tools = normalizeOpenAiToolsForRequest(tools);
    if (!Object.prototype.hasOwnProperty.call(modelParameters, "tool_choice")) {
      body.tool_choice = "auto";
    }
  }
  if (!body.tools?.length) {
    delete body.tools;
    delete body.tool_choice;
  }
  return body;
}

function normalizeOpenAiToolsForRequest(tools: object[] = []) {
  if (!Array.isArray(tools)) return [];
  return tools.map(normalizeOpenAiToolForRequest).filter((tool): tool is FunctionTool => tool !== null);
}

function normalizeOpenAiToolForRequest(value: unknown): FunctionTool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tool = record(value);
  const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
    ? record(tool.function)
    : tool;
  const name = String(fn.name || tool.name || "").trim();
  if (!name) return null;
  const description = String(fn.description || "").trim();
  const parameters = fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
    ? fn.parameters
    : { type: "object", properties: {} };
  const normalized: FunctionTool = {
    type: "function",
    function: {
      name,
      parameters,
    },
  };
  if (description) normalized.function.description = description;
  if (typeof fn.strict === "boolean") normalized.function.strict = fn.strict;
  return normalized;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
