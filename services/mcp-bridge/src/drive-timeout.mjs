/** Shared CLI/bridge wait budget. Never rewrites script or batch execution deadlines. */
export function driveExtensionTimeoutSeconds(params, fallback = 180) {
  const client = Number(params?.timeoutSeconds);
  const base = Number.isFinite(client) && client > 0 ? client : Number(fallback) || 180;
  const scripts = [];
  if (params?.name === "run_script") scripts.push(params.args);
  if (Array.isArray(params?.calls)) {
    for (const call of params.calls) if (call?.name === "run_script") scripts.push(call.args);
  }
  let scriptMax = 0;
  let unlimited = false;
  for (const raw of scripts) {
    const timeout = Number(raw && typeof raw === "object" ? raw.timeout : undefined);
    if (!Number.isFinite(timeout)) continue;
    if (timeout <= 0) unlimited = true;
    else scriptMax = Math.max(scriptMax, timeout);
  }
  if (unlimited) return 86400;
  if (scriptMax > 0) return Math.max(base, scriptMax + 60);
  return base;
}
