import { ToolExecutionError } from "#sdk/background/tools";
import type { ToolExtensionAPI } from "#sdk/background";
import { isPageTabUrl } from "#sdk/shared/browser";
import { t } from "./i18n.js";
import { productText } from "#sdk/shared/product-text";

// Firefox rejects scripting.executeScript with this message when the main frame
// has been removed and the call returns no results (bug 2047009). A same-URL
// reload can already report status complete while that frame is still missing.
const FIREFOX_FRAME_MISSING = "Missing host permission for the tab";
const FRAME_MISSING_RETRIES = 20;

/** Confirm the new main document using existing tabs/scripting permissions. */
export async function navigateTab(tabId: number, url: string, assertTabAllowed: ToolExtensionAPI["assertTabAllowed"], signal?: AbortSignal) {
  let disposed = false;
  const cancelled = () => new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while navigating");
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
      const failure = new ToolExecutionError("SESSION_TAB_UNAVAILABLE", t("navigationTabClosed"));
      failure.hint = "Use list_tabs to choose an available tabRef, then retry.";
      throw failure;
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
  let completed = false;
  let navigationVersion = 0;
  const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id !== tabId) return;
    if (change.status || change.url) navigationVersion += 1;
    if (change.status) completed = change.status === "complete";
  };
  try {
    const destination = new URL(url).href;
    const before = await getTab();
    // Continue the pending navigation instead of dispatching the same request twice.
    const joiningNavigation = before.pendingUrl === destination;
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
    const requireCompletion = previousId === null && isPageTabUrl(before.url) && !sameDocument;
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
      if (!joiningNavigation) await wait(chrome.tabs.update(tabId, { url }));
    } catch (error) { await getTab(); throw error; }
    let missingFrames = 0;
    for (;;) {
      const observedVersion = navigationVersion;
      const tab = await getTab();
      if (!tab.pendingUrl && tab.url && tab.url !== "about:blank") {
        try {
          const currentId = await documentId();
          check();
          missingFrames = 0;
          if ((joiningNavigation && tab.status === "complete" && (tab.url === destination || tab.url !== before.url))
            || (requireCompletion ? completed && tab.status === "complete"
            : currentId !== previousId || (sameDocument && tab.url === destination))) return;
        } catch (error) {
          check();
          if (error instanceof ToolExecutionError) throw error;
          // An injection failure describes the probed document, which navigation may already have replaced.
          const latest = await getTab();
          const changed = navigationVersion !== observedVersion || latest.url !== tab.url
            || latest.status !== tab.status || Boolean(latest.pendingUrl);
          const frameMissing = String(error).includes(FIREFOX_FRAME_MISSING);
          missingFrames = !changed && frameMissing ? missingFrames + 1 : 0;
          if (!changed && latest.status === "complete" && !(frameMissing && missingFrames <= FRAME_MISSING_RETRIES)) {
            throw new ToolExecutionError("NAVIGATION_FAILED", t("navigationFailed"), { url: latest.url, cause: String(error) });
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
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}
