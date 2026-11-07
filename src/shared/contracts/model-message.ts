/** Persisted and wire-compatible messages shared by Agent, Provider and transcript boundaries. */
export interface ModelToolCall { id: string; type?: string; function: { name: string; arguments: unknown } }

export interface ModelMessage {
  role: string;
  content?: unknown;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
  /** Persisted execution status, omitted from provider messages. */
  _toolIsError?: boolean;
  _origin?: string;
  _kind?: string;
  _usage?: Record<string, unknown>;
  _providerState?: unknown;
  [key: string]: unknown;
}
