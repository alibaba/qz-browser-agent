export const SCRIPT_API_VERSION = 2;

/** Script timeout stays at 120 unless --timeout is set. The request waits 60 seconds longer. */
export function scriptTimeouts({ timeoutOption, timeoutSeconds = 180 } = {}) {
  const scriptSeconds = timeoutOption === undefined ? 120 : Number(timeoutSeconds);
  return { scriptSeconds, requestSeconds: scriptSeconds + 60 };
}

/** Build an outer script request; each page tool supplies its own tabRef. */
export function buildScriptRequest({ code = "", timeoutSeconds = 120, sessionId = "", args = {} } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("qz script requires --session <id>. Pass the sessionId from qz session create.");
  return { name: "run_script", sessionId: id, scriptApiVersion: SCRIPT_API_VERSION, args: { timeout: timeoutSeconds, code: String(code), args } };
}

/** The execution envelope, never business keys, determines success. */
export function presentScriptResult(payload) {
  const receipt = payload?.result;
  if (payload?.scriptApiVersion !== SCRIPT_API_VERSION || typeof payload.isError !== "boolean"
    || !receipt || typeof receipt.ok !== "boolean" || payload.isError === receipt.ok
    || !Object.hasOwn(receipt, "result") || receipt.result === undefined
    || !Array.isArray(receipt.trace) || !receipt.trace.every(row => typeof row === "string")) {
    return presentScriptFailure({ code: "UPGRADE_REQUIRED", message: "The connected extension uses an incompatible script API.",
      hint: "The script may have run. Inspect the browser before retrying, then update the CLI and extension together and reconnect." });
  }
  return { text: JSON.stringify(receipt) + "\n", exitCode: receipt.ok ? 0 : 1 };
}

/** Local and transport failures have no script receipt; only their diagnostics become trace. */
export function presentScriptFailure(error = {}) {
  const { trace: hostTrace, ...details } = error.details || {};
  const trace = Array.isArray(hostTrace) ? hostTrace.flatMap(row => typeof row === "string" ? [row]
    : typeof row?.message === "string" ? [row.message] : []) : [];
  const failure = {
    code: String(error.code || "TOOL_EXECUTION_FAILED").toUpperCase(),
    message: typeof error.message === "string" ? error.message : "Script failed.",
    ...(error.hint ? { hint: error.hint } : {}), ...(Object.keys(details).length ? { details } : {}),
  };
  return { text: JSON.stringify({ ok: false, result: failure, trace }) + "\n", exitCode: 1 };
}
