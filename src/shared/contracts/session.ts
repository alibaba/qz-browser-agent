import type { ModelMessage } from './model-message.js';
import type { MessageDocument } from '../documents/document-attachments.js';
import type { ToolIdentity } from '../tools/tool-identity.js';

export interface TranscriptImage { dataUrl: string; url?: string; name?: string; type?: string; size?: number | null }
export interface TranscriptMeta {
  timestamp?: string; endedAt?: string; spanId?: string; parentSpanId?: string; runId?: string | null;
  streamTraceId?: string; provider?: string; model?: string; eventSeq?: number;
  clientMessageId?: string; deliveryStatus?: string;
}
export interface CompactMeta {
  id?: string; compactId?: string; status?: string; timestamp?: string;
  sourceMessageCount?: number; retainedMessageCount?: number; inputTokensBefore?: number;
  inputTokensAfter?: number; contextWindow?: number; threshold?: number; keepBudget?: number;
  sourceStartIndex?: number; sourceEndIndex?: number;
}
/** Persisted projection. Tool results and form payloads are interpreted only by their owners. */
export interface TranscriptEntry extends TranscriptMeta, CompactMeta, Partial<ToolIdentity> {
  type: string;
  text?: string; content?: unknown; images?: TranscriptImage[]; documents?: MessageDocument[];
  toolCallId?: string; args?: unknown; argsText?: string; argsIncomplete?: boolean; argsGenerating?: boolean;
  argsState?: string; phase?: string; result?: unknown; image?: string | null; rateLimit?: unknown;
  isError?: boolean; isRunning?: boolean; streaming?: boolean; statusText?: string;
  waitId?: string; message?: string; form?: unknown; reason?: string; summary?: string;
}
export interface TranscriptSnapshot {
  history: readonly TranscriptEntry[];
  current: readonly TranscriptEntry[];
}
export interface SessionMessage extends ModelMessage {
  _compact?: CompactMeta;
  _contextCapsule?: { reason?: string; createdAt?: string; signature?: string };
  _contextEvent?: { kind?: string; toolName?: string; createdAt?: string; added?: string[]; removed?: string[] };
  clientMessageId?: string; documents?: MessageDocument[]; trim?: boolean;
  _usageContextBoundaryId?: string; _usageContextFingerprint?: string;
}
export interface ConversationEntry {
  type: 'message'; id: string; parentId: string | null; timestamp: string; message: SessionMessage;
}
export interface Conversation { type: 'conversation'; version: number; entries: ConversationEntry[] }
/** Facts read by the transcript projection; other event payloads remain opaque. */
export interface TranscriptAgentEvent extends Omit<Partial<TranscriptEntry>, 'message' | 'status'> {
  message?: SessionMessage | string;
  status?: string | number;
  runtime?: { status?: string; reason?: string; runId?: string | null };
  thinking?: string; delta?: unknown; toolName?: string; tool_call_id?: string;
  toolCall?: { id?: string }; argsComplete?: boolean; arguments?: string;
}

/** Host projection input also accepts tool/command events and historical wire shapes.
 * Live Agent producers use the closed AgentEvent contract instead. */
export type SessionEvent = { type: string; runId?: string | null; eventSeq?: number; [field: string]: unknown };
