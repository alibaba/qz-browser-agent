import type { ModelMessage } from './model-message.js';
import type { TranscriptMeta } from './session.js';
import type { toolIdentityEventFields } from '../tools/tool-identity.js';

type EventMeta = Pick<TranscriptMeta,
  'deliveryStatus' | 'clientMessageId' | 'runId' | 'eventSeq' | 'spanId' | 'parentSpanId' | 'streamTraceId' | 'provider' | 'model'>;
type ToolMeta = ReturnType<typeof toolIdentityEventFields>;
type QueuedMessage = { clientMessageId: string; text: string; imageCount: number; attachmentCount?: number; index: number };
type Compaction = {
  compactId: string; trigger: string; inputTokensBefore: number; contextWindow: number;
  threshold: number; sourceMessageCount: number; retainedMessageCount: number;
};

export type ContextUsageSnapshot = {
  contextUsageId: string; contextWindow: number; reserveTokens: number; threshold: number;
  inputTokensEstimate: number; messageCount: number; contextEstimateSource: string;
  usageAnchorTokens: number; estimatedTrailingTokens: number; toolSchemaTokens: number;
  messageTokensEstimate: number; usageAnchorMessageIndex: number; contextBoundaryId: string;
};
export type ContextUsageDetails = {
  source?: string; phase?: string; compacted?: boolean; budgetStatus?: string; usage?: unknown;
  toolSchemas?: object[];
};
export type AgentRetryDetails = {
  attempt: number; maxAttempts?: number; maxRetries?: number; delayMs?: number;
  retryAfterMs?: number | null; reason?: string; message?: string; phase?: string;
  status?: number; kind?: string; code?: string; requestId?: string;
};

/** Live core events. Historical/wire projections remain tolerant in session.ts;
 * new producers must provide the fields required by their specific event. */
export type AgentEvent = EventMeta & (
  | { type: 'session_pending'; runId: string }
  | { type: 'agent_start' | 'agent_end'; runId: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string; code?: string; kind?: string; status?: number; requestId?: string }
  | { type: 'turn_start' | 'turn_end'; turnIndex: number }
  | { type: 'queue_update'; pendingFollowUps: QueuedMessage[]; pendingFollowUpMessages: ModelMessage[];
      pendingSteerings: QueuedMessage[]; pendingSteeringMessages: ModelMessage[]; isRunning?: boolean; resume?: boolean }
  | { type: 'message_start' | 'message_end'; message: ModelMessage;
      contentIndex?: number; outputIndex?: number | null; itemId?: string }
  | { type: 'message_update'; content: unknown; delta: unknown }
  | { type: 'thinking_update'; thinking: string; delta: string }
  // A streamed tool may not yet have an id; execution must always have one.
  | (ToolMeta & { type: 'tool_call_update'; toolCallId?: string; toolName: string; index?: number;
      delta?: string; argsText: string; argsComplete: boolean; phase: 'preparing' | 'running' })
  | (ToolMeta & { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown; startedExecution?: boolean })
  | (ToolMeta & { type: 'tool_execution_end'; toolCallId: string; toolName: string; args: unknown;
      result: unknown; isError: boolean })
  | ({ type: 'llm_retry' } & AgentRetryDetails)
  | { type: 'llm_rate_wait'; waitMs: number; waitedMs: number; availableAt: number }
  | ({ type: 'context_usage'; sessionId: string } & ContextUsageSnapshot & ContextUsageDetails)
  | ({ type: 'context_compaction_start' } & Compaction)
  | ({ type: 'context_compaction_end'; status: 'done'; summary: string; content: unknown;
      inputTokensAfter: number } & Compaction)
  | ({ type: 'context_compaction_failed'; status: 'failed'; message: string } & Compaction)
  | { type: 'skill_loaded'; name: string; displayName?: string; hasPluginManifest?: boolean;
      loadedPluginSkillNames: string[] }
);
