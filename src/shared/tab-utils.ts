import { stripInvisibleTitlePrefix } from "./unicode-utils.js";

/** Browser tab fields shared across contexts without importing a Chrome runtime. */
export interface TabReference {
  id?: number | null;
  windowId?: number | null;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  tabAlias?: string;
}

export function isWebTabUrl(url: unknown) {
  return /^https?:\/\//i.test(String(url || ""));
}

export function isLocalFileUrl(url: unknown) {
  return /^file:\/\//i.test(String(url || ""));
}

export function isPageTabUrl(url: unknown) {
  return isWebTabUrl(url) || isLocalFileUrl(url);
}

export function isPageTab(tab: TabReference | null | undefined) {
  return isPageTabUrl(getEffectiveTabUrl(tab));
}

export function getEffectiveTabUrl(tab: TabReference | null | undefined) {
  if (!tab || typeof tab !== "object") return "";
  const currentUrl = String(tab.url || "").trim();
  const pendingUrl = String(tab.pendingUrl || "").trim();
  if (isPageTabUrl(currentUrl)) return currentUrl;
  if (isPageTabUrl(pendingUrl)) return pendingUrl;
  return currentUrl || pendingUrl;
}

export function isWebTab(tab: TabReference | null | undefined) {
  return isWebTabUrl(getEffectiveTabUrl(tab));
}

export function filterWebTabs<T extends TabReference>(tabs: readonly T[] | null | undefined): T[] {
  return (Array.isArray(tabs) ? tabs : []).filter(isWebTab);
}

export function formatTab(tab: TabReference, { titleLimit = 80 } = {}) {
  const currentUrl = String(tab?.url || "").trim();
  const url = getEffectiveTabUrl(tab);
  const rawTitle = stripInvisibleTitlePrefix(String(tab?.title || ""));
  const title = isPageTabUrl(url) && (
    !isPageTabUrl(currentUrl)
    || /^(?:about:|chrome(?:-extension)?:\/\/|edge:\/\/|brave:\/\/|opera:\/\/|vivaldi:\/\/)/i.test(rawTitle.trim())
  )
    ? ""
    : rawTitle;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: title.slice(0, titleLimit),
    url,
    active: !!tab.active,
    pinned: !!tab.pinned,
  };
}
