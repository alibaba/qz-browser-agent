import { stringifyJsonSafe } from "#sdk/shared/format";
import {
  contentToPlainText,
  createAssistantProviderState,
  formatOutputTruncatedError,
  isOutputTruncatedFinishReason,
  isReplayableProviderState,
  normalizeJsonArgumentString,
  parseToolArguments,
  PROVIDER_STATE_ANTHROPIC_THINKING,
  resolveRequestMaxOutputTokens,
} from "#sdk/background/providers";
import {
  fetchLlmEndpointWithRetry,
  readSseFrames,
  REQUEST_TIMEOUT,
  withTimeout,
} from "#sdk/background/providers";
import { normalizeLlmFailure } from "#sdk/background/providers";

import type { ModelMessage, ModelToolCall } from '#sdk/shared/models';
import type { RuntimeConfig } from '#sdk/background/providers';
import type { ProviderDefinition } from '#sdk/background/providers';
import type { ModelOptions, ModelEvent } from '#sdk/background/providers';
interface ContentBlock {
  type?: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; data?: string;
  input?: unknown; partialJson?: string; [key: string]: unknown;
}
interface AnthropicEnvelope {
  type?: string; index?: number; stop_reason?: string;
  content?: ContentBlock[]; content_block?: ContentBlock;
  delta?: {type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string};
  usage?: Record<string, unknown>; message?: {usage?: Record<string, unknown>};
}
interface ToolCall extends ModelToolCall { function: {name: string; arguments: string} }
type Usage = ReturnType<typeof normalizeAnthropicUsage>;

const STREAM_IDLE_TIMEOUT = 45000;

export async function chatAnthropic(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig) {
  const body = buildAnthropicRequestBody(config, messages, tools, false, options);
  const { signal: requestSignal, cleanup } = withTimeout(signal, REQUEST_TIMEOUT);

  try {
    const resp = await fetchLlmEndpointWithRetry(config, "anthropic chat", {
      method: "POST",
      headers: buildAnthropicHeaders(config, options),
      body: stringifyJsonSafe(body),
      signal: requestSignal,
    }, options);

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      throw normalizeLlmFailure(new Error(`LLM API ${resp.status}`), {
        status: resp.status,
        headers: resp.headers,
        body: text,
        phase: "anthropic chat",
      });
    }

    let data: AnthropicEnvelope;
    try {
      data = JSON.parse(text);
    } catch (_err) {
      throw new Error("LLM API returned non-JSON Anthropic response");
    }

    if (isOutputTruncatedFinishReason(data.stop_reason)) {
      throw new Error(formatOutputTruncatedError(data.stop_reason));
    }

    const message = anthropicMessageToOpenAi(data, config, options.providerDefinition);
    return {
      message,
      usage: normalizeAnthropicUsage(data.usage),
    };
  } finally {
    cleanup();
  }
}

export async function* chatStreamAnthropic(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions, config: RuntimeConfig): AsyncGenerator<ModelEvent> {
  const body = buildAnthropicRequestBody(config, messages, tools, true, options);
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};
  const { signal: requestSignal, cleanup } = withTimeout(signal, REQUEST_TIMEOUT);
  const streamSignal = signal || new AbortController().signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const onAbort = () => { try { reader?.cancel(); } catch(_e) {} };

  let fullContent = "";
  let fullThinking = "";
  const contentBlocks = new Map<number | undefined, ContentBlock>();
  const toolCallsMap = new Map<number | undefined, ToolCall>();
  let usage: Usage | null = null;
  let finishReason = "";
  let sawMessageStop = false;

  try {
    const resp = await fetchLlmEndpointWithRetry(config, "anthropic stream", {
      method: "POST",
      headers: buildAnthropicHeaders(config, options),
      body: stringifyJsonSafe(body),
      signal: requestSignal,
    }, options);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw normalizeLlmFailure(new Error(`LLM API ${resp.status}`), {
        status: resp.status,
        headers: resp.headers,
        body: text,
        phase: "anthropic stream",
      });
    }
    if (!resp.body) {
      throw new Error("LLM API returned an empty stream body");
    }

    reader = resp.body.getReader();
    cleanup();
    streamSignal.addEventListener("abort", onAbort, { once: true });

    for await (const event of readAnthropicSseEvents(reader, STREAM_IDLE_TIMEOUT, streamSignal)) {
      if (event.type === "message_start") {
        usage = mergeAnthropicUsage(usage, event.message?.usage);
        if (usage) yield { type: "usage", usage };
      } else if (event.type === "content_block_start") {
        const block = event.content_block || {};
        contentBlocks.set(event.index, {
          ...block,
          partialJson: "",
          thinking: typeof block.thinking === "string" ? block.thinking : "",
          signature: typeof block.signature === "string" ? block.signature : "",
          data: typeof block.data === "string" ? block.data : "",
        });
        if (block.type === "text" && block.text) {
          fullContent += block.text;
          yield { type: "text_delta", delta: block.text };
        } else if (block.type === "thinking" && block.thinking) {
          fullThinking += block.thinking;
          yield { type: "thinking_delta", delta: block.thinking };
        } else if (block.type === "redacted_thinking") {
          const marker = "[Reasoning redacted]";
          fullThinking += fullThinking ? `\n${marker}` : marker;
          yield { type: "thinking_delta", delta: marker };
        } else if (block.type === "tool_use") {
          const id = block.id || `call_${Date.now()}_${event.index ?? 0}`;
          const toolCall = {
            id,
            type: "function",
            function: {
              name: block.name || "",
              arguments: JSON.stringify(block.input || {}),
            },
          };
          toolCallsMap.set(event.index ?? toolCallsMap.size, toolCall);
          yield {
            type: "tool_call_update",
            index: event.index ?? 0,
            toolCallId: id,
            toolName: toolCall.function.name,
            delta: "",
            arguments: toolCall.function.arguments,
            isStart: true,
          };
        }
      } else if (event.type === "content_block_delta") {
        const block = contentBlocks.get(event.index) || {};
        const delta = event.delta || {};
        if (delta.type === "text_delta") {
          fullContent += delta.text || "";
          yield { type: "text_delta", delta: delta.text || "" };
        } else if (delta.type === "thinking_delta") {
          const thinkingDelta = delta.thinking || "";
          block.thinking = `${block.thinking || ""}${thinkingDelta}`;
          contentBlocks.set(event.index, block);
          fullThinking += thinkingDelta;
          yield { type: "thinking_delta", delta: thinkingDelta };
        } else if (delta.type === "signature_delta") {
          block.signature = `${block.signature || ""}${delta.signature || ""}`;
          contentBlocks.set(event.index, block);
        } else if (delta.type === "input_json_delta") {
          block.partialJson = `${block.partialJson || ""}${delta.partial_json || ""}`;
          contentBlocks.set(event.index, block);
          const toolCall = toolCallsMap.get(event.index);
          if (toolCall) {
            toolCall.function.arguments = block.partialJson;
            yield {
              type: "tool_call_update",
              index: event.index ?? 0,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              delta: delta.partial_json || "",
              arguments: block.partialJson,
              argsComplete: false,
            };
          }
        }
      } else if (event.type === "content_block_stop") {
        const block = contentBlocks.get(event.index) || {};
        const toolCall = toolCallsMap.get(event.index);
        if (toolCall) {
          const nextArguments = block.partialJson
            ? normalizeJsonArgumentString(block.partialJson)
            : normalizeJsonArgumentString(toolCall.function.arguments);
          toolCall.function.arguments = nextArguments;
          yield {
            type: "tool_call_update",
            index: event.index ?? 0,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            delta: "",
            arguments: nextArguments,
            argsComplete: true,
          };
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        if (event.usage) {
          usage = mergeAnthropicUsage(usage, event.usage);
          if (usage) yield { type: "usage", usage };
        }
      } else if (event.type === "message_stop") {
        sawMessageStop = true;
      }
    }
  } finally {
    streamSignal.removeEventListener("abort", onAbort);
    cleanup();
    try { reader?.releaseLock(); } catch(_e) {}
  }

  if (!sawMessageStop && !finishReason) {
    throw new Error("Anthropic stream disconnected before message_stop");
  }
  if (isOutputTruncatedFinishReason(finishReason)) {
    throw new Error(formatOutputTruncatedError(finishReason));
  }

  const message: ModelMessage = { role: "assistant", content: fullContent || null };
  if (fullThinking) message._thinking = fullThinking;
  const thinkingBlocks = getAnthropicThinkingBlocks(contentBlocks);
  if (thinkingBlocks.length > 0) {
    message._providerState = createAssistantProviderState(config, providerDef, {
      kind: PROVIDER_STATE_ANTHROPIC_THINKING,
      thinkingBlocks,
    });
  }
  if (usage) message._usage = usage;
  if (toolCallsMap.size > 0) {
    message.tool_calls = [...toolCallsMap.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, toolCall]) => toolCall);
  }

  yield { type: "done", message };
}

// ---------------------------------------------------------------------------

function buildAnthropicRequestBody(config: RuntimeConfig, messages: ModelMessage[], tools: object[], stream: boolean, options: ModelOptions = {}) {
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};
  const converted = convertOpenAiMessagesToAnthropic(messages, config, providerDef);
  const modelParameters = config.modelParameters || {};
  const body: Record<string, unknown> = {
    ...(providerDef.anthropicRequestDefaults || {}),
    ...modelParameters,
    model: config.model,
    messages: converted.messages,
    stream,
  };
  if (!Object.prototype.hasOwnProperty.call(modelParameters, "max_tokens")) {
    body.max_tokens = resolveRequestMaxOutputTokens(options);
  }
  if (converted.system) body.system = converted.system;
  if (tools && tools.length > 0) body.tools = convertToolsToAnthropic(tools);
  return body;
}

function convertOpenAiMessagesToAnthropic(messages: ModelMessage[] = [], config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}) {
  const anthropicMessages = [];
  const systemParts = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      const text = contentToPlainText(msg.content);
      if (text.trim()) systemParts.push({ type: "text", text });
      continue;
    }

    if (msg.role === "user") {
      const content = convertUserContentToAnthropic(msg.content);
      if (isEmptyAnthropicContent(content)) continue;
      anthropicMessages.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = getAnthropicReplayContentBlocks(msg._providerState, config, providerDef);
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text.trim()) content.push({ type: "text", text });
      for (const toolCall of msg.tool_calls || []) {
        const id = normalizeAnthropicToolCallId(toolCall.id || `call_${content.length}`);
        content.push({
          type: "tool_use",
          id,
          name: toolCall.function?.name || "tool",
          input: parseToolArguments(toolCall.function?.arguments),
        });
      }
      if (content.length) anthropicMessages.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      const toolResults = [];
      let j = i;
      while (j < messages.length && messages[j]?.role === "tool") {
        const toolMsg = messages[j];
        toolResults.push({
          type: "tool_result",
          tool_use_id: normalizeAnthropicToolCallId(toolMsg.tool_call_id || ""),
          content: contentToPlainText(toolMsg.content),
        });
        j++;
      }
      i = j - 1;
      if (toolResults.length) anthropicMessages.push({ role: "user", content: toolResults });
    }
  }

  return {
    system: systemParts.length ? systemParts : undefined,
    messages: anthropicMessages,
  };
}

function getAnthropicReplayContentBlocks(state: unknown, config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}): ContentBlock[] {
  if (
    !isReplayableProviderState(state, config, providerDef)
    || state.kind !== PROVIDER_STATE_ANTHROPIC_THINKING
    || !Array.isArray(state.thinkingBlocks)
  ) {
    return [];
  }
  const blocks = [];
  for (const value of state.thinkingBlocks as unknown[]) {
    const block = record(value);
    if (!block || typeof block !== "object") continue;
    if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
      blocks.push({ type: "redacted_thinking", data: block.data });
      continue;
    }
    const thinking = typeof block.thinking === "string" ? block.thinking : "";
    if (!thinking) continue;
    const signature = typeof block.signature === "string" ? block.signature : "";
    blocks.push(signature
      ? { type: "thinking", thinking, signature }
      : { type: "text", text: thinking });
  }
  return blocks;
}

function convertUserContentToAnthropic(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const value of content as unknown[]) {
    const part = record(value);
    if (part?.type === "text") {
      const text = String(part.text || "");
      if (text.trim()) blocks.push({ type: "text", text });
    } else if (part?.type === "image_url") {
      const image = convertImageUrlPartToAnthropic(part);
      if (image) blocks.push(image);
    }
  }
  return blocks.length ? blocks : "";
}

function convertImageUrlPartToAnthropic(part: Record<string, unknown>) {
  const url = String(record(part.image_url).url || "");
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return url ? { type: "text", text: `[Image URL omitted for Anthropic endpoint: ${url.slice(0, 200)}]` } : null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1],
      data: match[2],
    },
  };
}

function convertToolsToAnthropic(tools: object[] = []) {
  return tools.map(value => {
    const tool = record(value);
    const fn = tool.function && typeof tool.function === "object" ? record(tool.function) : tool;
    const parameters = record(fn.parameters);
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: {
        type: "object",
        properties: parameters.properties || {},
        required: parameters.required || [],
      },
    };
  });
}

function getAnthropicThinkingBlocks(contentBlocks = new Map<number | undefined, ContentBlock>()) {
  const blocks = [];
  for (const [, block] of [...contentBlocks.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "redacted_thinking") {
      const data = typeof block.data === "string" ? block.data : "";
      if (data) blocks.push({ type: "redacted_thinking", data });
      continue;
    }
    if (block.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      if (!thinking) continue;
      const signature = typeof block.signature === "string" ? block.signature : "";
      blocks.push(signature
        ? { type: "thinking", thinking, signature }
        : { type: "thinking", thinking });
    }
  }
  return blocks;
}

function anthropicMessageToOpenAi(data: AnthropicEnvelope, config: RuntimeConfig = {}, providerDef: Partial<ProviderDefinition> = {}) {
  const toolCalls: ToolCall[] = [];
  let content = "";
  let thinking = "";
  const thinkingBlocks = [];
  for (const block of data.content || []) {
    if (block.type === "text") {
      content += block.text || "";
    } else if (block.type === "thinking") {
      const thinkingText = block.thinking || "";
      thinking += thinkingText;
      if (thinkingText) {
        thinkingBlocks.push(block.signature
          ? { type: "thinking", thinking: thinkingText, signature: block.signature }
          : { type: "thinking", thinking: thinkingText });
      }
    } else if (block.type === "redacted_thinking") {
      const marker = "[Reasoning redacted]";
      thinking += thinking ? `\n${marker}` : marker;
      if (block.data) thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || ""),
        type: "function",
        function: {
          name: block.name || "",
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }
  const message: ModelMessage = { role: "assistant", content: content || null };
  if (thinking) message._thinking = thinking;
  if (thinkingBlocks.length) {
    message._providerState = createAssistantProviderState(config, providerDef, {
      kind: PROVIDER_STATE_ANTHROPIC_THINKING,
      thinkingBlocks,
    });
  }
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = normalizeAnthropicUsage(data.usage);
  if (usage) message._usage = usage;
  return message;
}

function normalizeAnthropicUsage(usage: Record<string, unknown> = {}) {
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
  const total = input + output + cacheRead + cacheWrite;
  return { input_tokens: input, output_tokens: output, total_tokens: total, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
}

function mergeAnthropicUsage(current: Usage | null, update: Record<string, unknown> | undefined) {
  const next = normalizeAnthropicUsage(update);
  if (!current) return next;
  return normalizeAnthropicUsage({
    input_tokens: Math.max(current.input_tokens || 0, next.input_tokens || 0),
    output_tokens: Math.max(current.output_tokens || 0, next.output_tokens || 0),
    cache_read_input_tokens: Math.max(current.cache_read_input_tokens || 0, next.cache_read_input_tokens || 0),
    cache_creation_input_tokens: Math.max(current.cache_creation_input_tokens || 0, next.cache_creation_input_tokens || 0),
  });
}

async function* readAnthropicSseEvents(reader: ReadableStreamDefaultReader<Uint8Array>, idleTimeoutMs: number, signal: AbortSignal): AsyncGenerator<AnthropicEnvelope> {
  for await (const { data } of readSseFrames(reader, idleTimeoutMs, signal)) {
    let parsed: AnthropicEnvelope;
    try { parsed = JSON.parse(data); }
    catch (_err) { throw new Error(`Invalid Anthropic SSE JSON: ${data.slice(0, 300)}`); }
    if (parsed.type === "error") {
      throw normalizeLlmFailure(new Error("Anthropic SSE error event"), {
        payload: parsed, phase: "anthropic stream",
      });
    }
    yield parsed;
  }
}

function isEmptyAnthropicContent(content: unknown) {
  return Array.isArray(content) ? content.length === 0 : !String(content || "").trim();
}

function normalizeAnthropicToolCallId(id: unknown) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function buildAnthropicHeaders(config: RuntimeConfig, options: ModelOptions = {}) {
  const providerDef: Partial<ProviderDefinition> = options.providerDefinition || {};
  return {
    ...options.baseHeaders,
    "Content-Type": "application/json",
    ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
    "anthropic-version": providerDef.anthropicVersion || "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    ...(options.headers || {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
