export function isRunScriptInnerTargetArgs(args: { target?: unknown } = {}) {
  return String(args?.target || "").trim().toLowerCase() === "inner";
}

export function resolveRunScriptTargetTabId(tabId: unknown) {
  const explicitTabId = Number(tabId);
  if (Number.isFinite(explicitTabId) && explicitTabId > 0) return explicitTabId;
  return null;
}
