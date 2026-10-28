import type { ToolContext } from "../../sdk/background.js";
import { documentReadiness } from "../../shared/document-readiness.js";
import { ToolExecutionError } from "./arguments.js";

/** Wait for parsing/deferred scripts, independently of images, child frames and network idle. */
export async function waitForParsedDocument(tabId: number, context: ToolContext = {}) {
  const signal = context.signal;
  const abortError = () => signal?.reason || new ToolExecutionError("OPERATION_ABORTED", "Document observation was cancelled");
  if (signal?.aborted) throw abortError();
  const finish = context.measurePhase?.("readiness");
  let onAbort = () => {};
  try {
    const ready = chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, injectImmediately: true,
      func: documentReadiness, args: ["wait"],
    });
    if (!signal) { await ready; return; }
    await Promise.race([ready, new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
    if (signal.aborted) throw abortError();
  } finally { signal?.removeEventListener("abort", onAbort); finish?.(); }
}
