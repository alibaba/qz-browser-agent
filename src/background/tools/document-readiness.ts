import type { ToolContext } from "../../sdk/background.js";
import { documentReadiness } from "../../shared/document-readiness.js";
import { ToolExecutionError } from "./arguments.js";
import { isPageTabUrl } from "../../shared/tab-utils.js";
import { pageErrorDetails } from "../../shared/contracts/tool-error.js";

/** Probe before execution only; navigation may replace the document while preparing it. */
async function waitForDocument(tabId: number, context: ToolContext, parsed: boolean) {
  const signal = context.signal;
  const finish = context.measurePhase?.("readiness");
  let onAbort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal?.reason || new ToolExecutionError("OPERATION_ABORTED", "Document observation was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const wait = <T>(operation: Promise<T>) => Promise.race([operation, aborted]);
  const getTab = () => wait(chrome.tabs.get(tabId).catch(() => {
    throw new ToolExecutionError("SESSION_TAB_UNAVAILABLE", "The page could not be accessed while preparing the document.", pageErrorDetails(context));
  }));
  const pending = (tab: chrome.tabs.Tab) => isPageTabUrl(tab.pendingUrl)
    || ((!tab.url || tab.url === "about:blank") && tab.status === "loading");
  try {
    for (;;) {
      signal?.throwIfAborted();
      const tab = await getTab();
      if (!pending(tab)) {
        if (!parsed) return;
        try {
          const [frame] = await wait(chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] }, injectImmediately: true,
            func: documentReadiness as () => boolean,
          }));
          if (frame?.result === true && !pending(await getTab())) return;
        } catch (error) {
          signal?.throwIfAborted();
          // Only a replaced execution context is safe to retry, before user code runs.
          if (!/frame.*(?:removed|not found)|document.*unloaded|execution context.*destroyed/i.test(String(error))) throw error;
        }
      }
      await wait(new Promise(resolve => { timer = setTimeout(resolve, 100); }));
    }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); finish?.(); }
}

export const waitForPageCommit = (tabId: number, context: ToolContext = {}) => waitForDocument(tabId, context, false);
/** Parsing/deferred scripts, independently of images, child frames and network idle. */
export const waitForParsedDocument = (tabId: number, context: ToolContext = {}) => waitForDocument(tabId, context, true);
