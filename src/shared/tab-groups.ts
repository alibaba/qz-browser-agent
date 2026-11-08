import { t } from "./i18n/backend.js";
type GroupAppearance = Pick<chrome.tabGroups.UpdateProperties, "color" | "collapsed">;

export const QINGZHOU_TAB_GROUP_TITLE = "轻舟任务";

export function qingzhouTabGroupPatch({ color = "cyan", collapsed = false, title = "" }: GroupAppearance & { title?: string } = {}) {
  return {
    title: title || t("notification.task"),
    color,
    collapsed,
  };
}

export async function ensureQingzhouTabGroupForWindow(tabIds: readonly unknown[] = [], {
  preferredGroupId = null,
  color = "cyan",
  collapsed = false,
  title = "",
}: GroupAppearance & { preferredGroupId?: number | null; title?: string } = {}) {
  const desiredTabIds = normalizeTabIds(tabIds);
  if (desiredTabIds.length < 1) return null;

  const tabs = [];
  for (const tabId of desiredTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.id != null && Number.isFinite(Number(tab.windowId))) tabs.push(tab);
    } catch (_err) {}
  }
  if (!tabs.length) return null;

  const windowId = Number(tabs[0].windowId);
  const windowTabIds = tabs
    .filter(tab => Number(tab.windowId) === windowId)
    .map(tab => Number(tab.id));
  if (!windowTabIds.length) return null;

  const preferredId = typeof preferredGroupId === "number" && Number.isInteger(preferredGroupId) && preferredGroupId >= 0
    && tabs.some(tab => tab.windowId === windowId && tab.groupId === preferredGroupId)
    ? preferredGroupId : null;
  const groups = await listQingzhouTabGroups(windowId, preferredId, title);
  let target = groups.find(group => Number(group.id) === preferredId) || groups[0] || null;

  if (!target) {
    const groupId = await chrome.tabs.group({ tabIds: windowTabIds as [number, ...number[]] });
    const group = await chrome.tabGroups.update(groupId, qingzhouTabGroupPatch({ color, collapsed, title }));
    return { groupId, tabIds: windowTabIds as [number, ...number[]], group };
  }

  target = await normalizeQingzhouTabGroupDuplicates(target, groups, { color, collapsed, title });
  const currentTabIds = await getTabIdsInGroup(target.id, windowId);
  const missingTabIds = windowTabIds.filter(tabId => !currentTabIds.includes(tabId));
  if (missingTabIds.length) {
    await chrome.tabs.group({ groupId: Number(target.id), tabIds: missingTabIds as [number, ...number[]] });
  }
  const group = await chrome.tabGroups.update(Number(target.id), qingzhouTabGroupPatch({ color, collapsed, title }));
  return { groupId: Number(target.id), tabIds: windowTabIds as [number, ...number[]], group };
}

async function normalizeQingzhouTabGroupDuplicates(target: chrome.tabGroups.TabGroup, groups: readonly chrome.tabGroups.TabGroup[] = [], { color, collapsed, title = "" }: GroupAppearance & { title?: string } = {}) {
  const targetId = Number(target?.id);
  if (!Number.isFinite(targetId) || targetId < 0) return target;
  const windowId = Number(target?.windowId);
  for (const group of groups) {
    const groupId = Number(group?.id);
    if (!Number.isFinite(groupId) || groupId < 0 || groupId === targetId) continue;
    const tabIds = await getTabIdsInGroup(groupId, windowId);
    if (!tabIds.length) continue;
    try {
      await chrome.tabs.group({ groupId: targetId, tabIds: tabIds as [number, ...number[]] });
    } catch (_err) {}
  }
  try {
    return await chrome.tabGroups.update(targetId, qingzhouTabGroupPatch({ color, collapsed, title })) || target;
  } catch (_err) {
    return target;
  }
}

async function listQingzhouTabGroups(windowId: number, preferredGroupId: number | null, title = "") {
  if (!chrome.tabGroups?.query) return [];
  const groups = await chrome.tabGroups.query({ windowId });
  // A stored group ID is claimed only when one of this session's tabs is already in it.
  // That witnessed identity is reused even when the title differs, then the title is updated.
  // Title matching is the fallback when no tab witnesses the stored id. Browser restarts may reuse ids.
  const titles = title
    ? new Set([title])
    : new Set([t("notification.task"), QINGZHOU_TAB_GROUP_TITLE, "Qingzhou task", "qz task"]);
  const inWindow = groups.filter(group => group.windowId === windowId);
  if (preferredGroupId != null) {
    const witnessed = inWindow.filter(group => group.id === preferredGroupId);
    if (witnessed.length) return witnessed;
  }
  return inWindow
    .filter(group => typeof group.title === "string" && titles.has(group.title))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function getTabIdsInGroup(groupId: number, windowId: number) {
  const id = Number(groupId);
  if (!Number.isFinite(id) || id < 0) return [];
  const query: chrome.tabs.QueryInfo = { groupId: id };
  if (Number.isFinite(Number(windowId))) query.windowId = Number(windowId);
  try {
    const tabs = await chrome.tabs.query(query);
    return normalizeTabIds(tabs.map(tab => tab.id));
  } catch (_err) {
    return [];
  }
}

function normalizeTabIds(tabIds: readonly unknown[] = []): number[] {
  return [...new Set((Array.isArray(tabIds) ? tabIds : [])
    .map(tabId => Number(tabId))
    .filter(tabId => Number.isFinite(tabId) && tabId > 0))];
}
