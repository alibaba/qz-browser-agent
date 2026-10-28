/** Runtime.evaluate expression that selects the extension isolated world. */
export const ISOLATED_CONTENT_PROBE = `(() => {
            let extensionId = "";
            try { extensionId = globalThis.chrome?.runtime?.id || ""; } catch {}
            return { extensionId, bridge: typeof globalThis.__qzInvoke === "function" };
          })()`;

/** Runtime.callFunctionOn declaration that enters the content-script bridge. */
export const ISOLATED_CONTENT_INVOKE = "function(payload){return globalThis.__qzInvoke(this,payload)}";

export function compactIsolatedSource(source: string) {
  return String(source || "").replace(/\s+/g, "");
}

export function isIsolatedContentProbe(expression: string) {
  return compactIsolatedSource(expression) === compactIsolatedSource(ISOLATED_CONTENT_PROBE);
}

export function isIsolatedContentInvoke(declaration: string) {
  return compactIsolatedSource(declaration) === compactIsolatedSource(ISOLATED_CONTENT_INVOKE);
}
