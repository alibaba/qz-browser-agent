import { ToolExecutionError } from "#sdk/background/tools";
import type { ToolExtensionAPI } from "#sdk/background";
import { isPageTabUrl } from "#sdk/shared/browser";
import { t } from "./i18n.js";
import { productText } from "#sdk/shared/product-text";

/** Confirm the new main document using existing tabs/scripting permissions. */
export async function navigateTab(tabId: number, url: string, assertTabAllowed: ToolExtensionAPI["assertTabAllowed"], signal?: AbortSignal) {
  let disposed = false;
  const cancelled = () => new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while navigating", { tabId });
  const check = () => {
    if (disposed || signal?.aborted) throw cancelled();
  };
  check();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(cancelled()); });
  signal?.addEventListener("abort", onAbort, { once: true });
  const wait = <T>(operation: Promise<T>) => Promise.race([operation, aborted]);
  const getTab = async () => {
    check();
    try { return await wait(chrome.tabs.get(tabId)); }
    catch (error) {
      check();
      throw new ToolExecutionError("SESSION_TAB_UNAVAILABLE", t("navigationTabClosed"), { tabId, cause: String(error) });
    }
  };
  const documentId = async () => {
    check();
    await wait(assertTabAllowed(tabId, { source: "navigation_document" }));
    check();
    // The probe reads no page content and changes no page state. Chrome supplies the identity.
    const [result] = await wait(chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, injectImmediately: true, func: () => null,
    }));
    if (!result?.documentId) throw new Error(productText("Chrome did not return a document ID", "Firefox did not return a document ID"));
    return result.documentId;
  };
  let baselineTimer: ReturnType<typeof setTimeout> | undefined;
  let listenForCompletion = false, completed = false;
  const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id === tabId && change.status) completed = change.status === "complete";
  };
  try {
    const destination = new URL(url).href;
    const before = await getTab();
    // A busy old renderer must not prevent Chrome from starting navigation.
    const previousId = isPageTabUrl(before.url) ? await wait(Promise.race([
      documentId().catch(() => null),
      new Promise<null>(resolve => { baselineTimer = setTimeout(() => resolve(null), 100); }),
    ])) : null;
    clearTimeout(baselineTimer);
    check();
    const withoutFragment = (value: string) => value.split("#", 1)[0];
    const sameDocument = (destination.includes("#") || before.url !== destination)
      && withoutFragment(before.url || "") === withoutFragment(destination);
    // Without a baseline, require a load completion observed after navigation starts.
    listenForCompletion = previousId === null && isPageTabUrl(before.url) && !sameDocument;
    if (listenForCompletion) chrome.tabs.onUpdated.addListener(onUpdated);
    await wait(chrome.tabs.update(tabId, { url }));
    for (;;) {
      const tab = await getTab();
      if (!tab.pendingUrl && tab.url && tab.url !== "about:blank") {
        try {
          const currentId = await documentId();
          check();
          if (listenForCompletion ? completed && tab.status === "complete"
            : currentId !== previousId || (sameDocument && tab.url === destination)) return;
        } catch (error) {
          check();
          if (error instanceof ToolExecutionError) throw error;
          if (tab.status === "complete") {
            throw new ToolExecutionError("NAVIGATION_FAILED", t("navigationFailed"), { tabId, url: tab.url, cause: String(error) });
          }
        }
      }
      check();
      await wait(new Promise(resolve => setTimeout(resolve, 50)));
    }
  } finally {
    disposed = true;
    clearTimeout(baselineTimer);
    signal?.removeEventListener("abort", onAbort);
    if (listenForCompletion) chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}
