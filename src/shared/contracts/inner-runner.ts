/** Internal offscreen/sandbox/Worker wire protocol; task ownership stays in Background. */
export interface BridgeFailure { ok: false; error?: string; message?: string; hint?: string; code?: string; details?: unknown; diagnostic?: unknown }
export type ToolBridgeResponse = (BridgeFailure | { ok: true; result?: unknown; resultFormat?: 'receipt'; observation?: unknown; artifacts?: unknown; artifact?: unknown }) & { toolCallId?: string };
export interface FetchResult { status: number; statusText?: string; headers?: [string, string][]; bodyBase64?: string; url?: string; redirected?: boolean }
export type FetchBridgeResponse = BridgeFailure | { ok: true; result: FetchResult };
export interface FetchRequest { url: string; method: string; headers: [string, string][]; bodyBase64: string }
export interface TraceRow { time: string; level: string; message: string; traceIndex?: number }
export interface ScriptFailure extends Error { hint?: string; code?: string; details?: unknown; diagnostic?: unknown }
export type MessageValue = undefined | null | string | boolean | number | MessageValue[] | { [key: string]: MessageValue };
export interface ScriptEnvelope {
  __runScriptEnvelope: true; ok: boolean; hasResult: boolean; result: MessageValue; resultType: string;
  engine: 'offscreen_inner'; execution_world: 'inner'; reason?: 'inner'; trace: MessageValue; elapsedMs: number;
  error?: string; code?: string; hint?: string; details?: MessageValue; diagnostic?: MessageValue; message?: string; artifacts?: MessageValue;
  observations?: MessageValue;
}
export interface WorkerExecute { type: 'execute'; requestId?: string; source?: string; scriptArgs?: unknown; securityGuardrails?: unknown; fetchBridge?: boolean; strictResult?: boolean }
export type InnerWorkerInput = WorkerExecute
  | { type: 'tool_response'; callId: string; response?: ToolBridgeResponse }
  | { type: 'fetch_response'; callId: string; response?: FetchBridgeResponse }
  | { type: 'trace_snapshot'; requestId?: string };
export type InnerWorkerOutput = { type: 'tool_call'; callId: string; toolName: string; args: MessageValue }
  | { type: 'script_trace'; row: TraceRow }
  | { type: 'fetch_call'; callId: string; request: FetchRequest }
  | { type: 'fetch_cancel'; callId: string }
  | { type: 'trace_snapshot'; requestId: string; trace: TraceRow[] }
  | { type: 'result'; result: ScriptEnvelope };
