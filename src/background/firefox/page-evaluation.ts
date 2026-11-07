import { permissionT } from "../../shared/browser-permissions.js";
import { ToolExecutionError } from "../tools/arguments.js";

export interface FirefoxPageEvaluationHost {
  permissions?: { contains(request: { permissions: string[] }): Promise<boolean> };
  webNavigation?: { getFrame?(target: { tabId: number; frameId: number }): Promise<{ documentId?: string } | null> };
  userScripts?: { execute(injection: {
    target: { tabId: number; documentIds: string[] }; world: "MAIN"; injectImmediately: true;
    js: { code: string }[];
  }): Promise<{ frameId: number; result?: unknown; error?: unknown }[]> };
}

/** Compile through Firefox, rather than the page's CSP-restricted Function constructor. */
export async function evaluateFirefoxPage(
  host: FirefoxPageEvaluationHost, tabId: number, frameId: number, expression: string, check: () => void,
): Promise<unknown> {
  check();
  if (!host.userScripts?.execute || (host.permissions && !await host.permissions.contains({ permissions: ["userScripts"] }))) {
    throw permissionRequired();
  }
  check();
  const document = await host.webNavigation?.getFrame?.({ tabId, frameId });
  check();
  if (!document?.documentId) throw new Error("Execution context was destroyed");
  let results;
  try {
    results = await host.userScripts.execute({
      target: { tabId, documentIds: [document.documentId] }, world: "MAIN", injectImmediately: true,
      js: [{ code: `(${evaluateInPage.toString()})(function(){ "use strict"; return (${expression}\n); })` }],
    });
  } catch (error) {
    check();
    if (!host.userScripts?.execute || (host.permissions && !await host.permissions.contains({ permissions: ["userScripts"] }))) {
      throw permissionRequired();
    }
    throw error;
  }
  check();
  const entry = results.find(result => result.frameId === frameId);
  if (!entry) throw new Error("Execution context was destroyed");
  // Native Error properties are not enumerable and cannot be passed through as data.
  const result = entry.result as { error?: unknown } | undefined;
  const error = entry.error ?? result?.error;
  if (error !== undefined) {
    const record = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : undefined;
    const text = record?.message !== undefined ? `${record.name || "Error"}: ${record.message}` : String(error);
    return { exceptionDetails: { text, exception: { type: "object", subtype: "error", description: text } } };
  }
  if (!result || !("result" in result)) throw new Error("Firefox page evaluation returned no result");
  return result;

  // Serialized into MAIN as source. Keep this function self-contained.
  async function evaluateInPage(evaluate: () => unknown) {
    try {
      // Firefox's existing adapter returns the resolved value even with awaitPromise:false.
      const value = await evaluate.call(globalThis);
      if (value === null) return { result: { type: "object", subtype: "null", value: null } };
      const type = typeof value;
      if (type === "undefined") return { result: { type } };
      if (type === "string" || type === "number" || type === "boolean") return { result: { type, value } };
      try { return { result: { type: "object", value: JSON.parse(JSON.stringify(value)) } }; }
      catch { return { result: { type: "object", description: String(value) } }; }
    } catch (error) {
      const record = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : undefined;
      return { error: record?.message !== undefined ? { name: String(record.name || "Error"), message: String(record.message) } : String(error) };
    }
  }
}

function permissionRequired() {
  const message = permissionT("required", { permission: permissionT("name.userScripts") });
  const error = new ToolExecutionError("BROWSER_PERMISSION_REQUIRED", message, { permission: "userScripts" });
  error.hint = message;
  return error;
}
