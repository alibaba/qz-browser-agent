import type { ToolContext } from "../../sdk/background.js";
import { ToolExecutionError } from "./arguments.js";

type Fields = Record<string, unknown>;
/** Sample actual document readiness. An unavailable renderer keeps the last observed state. */
export async function readPartialPageState(tabId: number, previous: Fields = {}, context: ToolContext = {}) {
  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { throw new ToolExecutionError("SESSION_TAB_UNAVAILABLE", "The target tab is unavailable", { tabId }); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observation: Fields = {};
  const finishPhase = context.measurePhase?.("measurement");
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, injectImmediately: true,
        func: () => {
          const page = (globalThis as unknown as { document: { readyState: string; title: string; URL: string } }).document;
          return { readyState: page.readyState, title: page.title, url: page.URL, observedAt: Date.now() };
        },
      }),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 150); }),
    ]);
    const frame = results?.[0];
    if (frame?.result && ["loading", "interactive", "complete"].includes(frame.result.readyState)) {
      observation = { ...frame.result, documentId: frame.documentId || "" };
    }
  } catch { /* The renderer may be busy or the document may be unavailable. */ }
  finally { clearTimeout(timer); finishPhase?.(); }
  const url = tab.url || "";
  const retained = previous.url === url ? previous : {};
  return {
    readyState: "unknown", documentId: "", url, title: tab.title || "", ...retained, ...observation,
    status: tab.status || "unknown", loading: tab.status === "loading", pendingUrl: tab.pendingUrl || "",
  };
}
