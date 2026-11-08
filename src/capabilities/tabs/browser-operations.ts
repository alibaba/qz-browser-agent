import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
import { groupColorLabel } from "./presentation.js";
type Data = Record<string, unknown>;
interface GroupedTab { title: string; url: string; active: boolean; pinned: boolean; windowId: unknown }

export function createTabProfiles(helpers: ProfileHelpers) {
function appendTabProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  if (toolName === "group_tabs") return appendGroupTabsProfile(parent, args, result);
  const tabs = Array.isArray(result) ? result : Array.isArray(data.tabs) ? data.tabs : [];
  if (!tabs.length) return false;
  presentation.appendSlimList(parent, t("tabs"), tabs.map(record), item => ({
    title: item.title || item.url || t("tab", { tabRef: String(item.tabRef ?? item.id ?? "") }),
    subtitle: item.url || "",
    meta: [item.active ? t("current") : "", item.pageMode === "mobile" ? t("mobileMode") : item.pageMode === "desktop" ? t("desktopMode") : "",
      item.tabRef != null ? String(item.tabRef) : item.id ? `ID ${item.id}` : "", item.windowId ? t("window", { windowId: String(item.windowId) }) : ""].filter(Boolean),
  }));
  return true;
}

function appendGroupTabsProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const tabs = normalizeGroupedTabs(data.tabs);
  const count = Number(data.count || tabs.length || 0);
  const title = data.title || t("qingzhouTask");
  const domains = normalizeGroupedDomains(data.domains).length
    ? normalizeGroupedDomains(data.domains)
    : topTabDomains(tabs, 4);
  const windowCount = Number(data.windowCount || uniqueTabWindowCount(tabs) || 0);
  presentation.appendCompactLine(parent, {
    title: t("organizedInto", { name: String(title) }),
    subtitle: domains.length
      ? t("namedTabCount", { count: String(count || tabs.length), name: String(domains.map(item => `${item.host}${item.count > 1 ? ` x${item.count}` : ""}`).join("、")) })
      : t("groupedTabs", { count: String(count || tabs.length) }),
    meta: [
      count || tabs.length ? t("tabCount", { count: String(count || tabs.length) }) : "",
      groupColorLabel(data.color || args.color),
      windowCount > 1 ? t("windows", { count: String(windowCount) }) : "",
    ].filter(Boolean),
  });
  if (tabs.length) {
    presentation.appendSlimList(parent, t("pageSamples"), tabs.slice(0, 8), item => ({
      title: item.title || tabHost(item.url) || t("untitledPage"),
      subtitle: summarizeTabUrl(item.url),
      meta: [item.active ? t("current") : "", item.pinned ? t("pinned") : "", tabHost(item.url)].filter(Boolean),
    }));
  }
  return true;
}

function normalizeGroupedDomains(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      host: String(item?.host || "").trim(),
      count: Number(item?.count || 0),
    }))
    .filter(item => item.host)
    .slice(0, 4);
}

function normalizeGroupedTabs(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((value: unknown): GroupedTab | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const item = record(value);
      return {
        title: String(item.title || "").trim(),
        url: String(item.url || item.pendingUrl || "").trim(),
        active: item.active === true,
        pinned: item.pinned === true,
        windowId: item.windowId,
      };
    })
    .filter((tab): tab is GroupedTab => tab !== null);
}

function topTabDomains(tabs: GroupedTab[] = [], limit = 4) {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const host = tabHost(tab.url);
    if (!host) continue;
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, limit);
}

function uniqueTabWindowCount(tabs: GroupedTab[] = []) {
  const ids = new Set();
  for (const tab of tabs) {
    if (tab?.windowId != null) ids.add(String(tab.windowId));
  }
  return ids.size;
}

function tabHost(url: unknown = "") {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    return new URL(text).hostname.replace(/^www\./, "");
  } catch(_err) {
    return "";
  }
}

function summarizeTabUrl(url: unknown = "") {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const path = `${parsed.pathname || ""}${parsed.search || ""}`.replace(/\/$/, "");
    return path ? `${parsed.hostname.replace(/^www\./, "")}${presentation.summarizeValue(path, 80)}` : parsed.hostname.replace(/^www\./, "");
  } catch(_err) {
    return presentation.summarizeValue(text, 120);
  }
}

  return { renderTabs: appendTabProfile };
}
