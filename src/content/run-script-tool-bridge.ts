export {};
/** Reinjection is idempotent; page messages are untrusted and Background rechecks run/tab authority. */
const bridgeScope = globalThis as typeof globalThis & { __QZ_RUN_SCRIPT_TOOL_BRIDGE_INSTALLED__?: boolean };
if (!bridgeScope.__QZ_RUN_SCRIPT_TOOL_BRIDGE_INSTALLED__) {
  bridgeScope.__QZ_RUN_SCRIPT_TOOL_BRIDGE_INSTALLED__ = true;
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.source !== 'qz-run-script-tool-call' || !message.id) return;
    chrome.runtime.sendMessage({
      type: 'run_script_tool_call',
      toolName: message.toolName,
      args: message.args && typeof message.args === 'object' ? message.args : {},
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : '',
      runId: typeof message.runId === 'string' ? message.runId : '',
      depth: Math.max(0, Math.floor(Number(message.depth) || 0)),
      parentCallId: String(message.parentCallId || ''),
    }, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({
        source: 'qz-run-script-tool-response',
        id: message.id,
        response: runtimeError ? { ok: false, error: runtimeError.message || 'runtime message failed' } : response,
      }, '*');
    });
  });
}
