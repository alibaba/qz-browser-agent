import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { getCoreToolMetadata } from "../../src/shared/tools/tool-metadata.js";
import { chromeMessageId } from "../../src/shared/i18n/definition.js";
import { createSessionRepository } from "../../src/background/session/repository.js";
import { createSessionTabs } from "../../src/background/session/tabs.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";

globalThis.chrome = { i18n: { getUILanguage: () => "zh-CN" } };

const root = new URL("../../", import.meta.url);

function readProjectFile(relativePath) {
  const original = new URL(relativePath, root);
  return readFileSync(existsSync(original) ? original : new URL(relativePath.replace(/\.js$/, ".ts"), root), "utf8");
}

function installChromeMock({ tabs = [], groups = [] } = {}) {
  const state = {
    tabs: new Map(tabs.map(tab => [Number(tab.id), { ...tab }])),
    groups: new Map(groups.map(group => [Number(group.id), { ...group }])),
    nextGroupId: Math.max(0, ...groups.map(group => Number(group.id) || 0)) + 1,
    groupCalls: [],
    updateCalls: [],
  };

  globalThis.chrome = {
    i18n: { getUILanguage: () => "zh-CN" },
    tabs: {
      async get(tabId) {
        const tab = state.tabs.get(Number(tabId));
        if (!tab) throw new Error(`missing tab ${tabId}`);
        return { ...tab };
      },
      async query(query = {}) {
        return [...state.tabs.values()]
          .filter(tab => query.windowId == null || Number(tab.windowId) === Number(query.windowId))
          .filter(tab => query.groupId == null || Number(tab.groupId) === Number(query.groupId))
          .map(tab => ({ ...tab }));
      },
      async group({ tabIds = [], groupId = undefined } = {}) {
        const normalizedTabIds = tabIds.map(Number).filter(Number.isFinite);
        let id = Number(groupId);
        if (!Number.isFinite(id) || id < 0) {
          const firstTab = state.tabs.get(normalizedTabIds[0]);
          id = state.nextGroupId++;
          state.groups.set(id, { id, windowId: Number(firstTab?.windowId || 1), title: "", color: "grey", collapsed: false });
        }
        for (const tabId of normalizedTabIds) {
          const tab = state.tabs.get(tabId);
          if (tab) tab.groupId = id;
        }
        state.groupCalls.push({ groupId: id, tabIds: normalizedTabIds });
        return id;
      },
    },
    tabGroups: {
      async get(groupId) {
        const group = state.groups.get(Number(groupId));
        if (!group) throw new Error(`missing group ${groupId}`);
        return { ...group };
      },
      async query(query = {}) {
        return [...state.groups.values()]
          .filter(group => query.windowId == null || Number(group.windowId) === Number(query.windowId))
          .map(group => ({ ...group }));
      },
      async update(groupId, patch = {}) {
        const id = Number(groupId);
        const group = state.groups.get(id);
        if (!group) throw new Error(`missing group ${groupId}`);
        Object.assign(group, patch);
        state.updateCalls.push({ groupId: id, patch: { ...patch } });
        return { ...group };
      },
    },
  };

  return state;
}

async function assertToolExposure() {
  const tools = readProjectFile("src/background/tools/runtime.js");
  assert.doesNotMatch(tools, /registerTool\(\s*\{\s*name:\s*"group_tabs"/, "group_tabs should not be registered as a model-visible tool");
  assert.doesNotMatch(tools, /["']group_tabs["']\s*,?\s*\]/, "group_tabs should not remain in direct tool lists");
  const { getToolSchemas } = await import("../../src/background/tools/runtime.js");
  const registeredNames = getToolSchemas().map(tool => tool.function.name);
  for (const name of ["group_tabs", "use_tab", "get_working_tab"]) {
    assert.equal(registeredNames.includes(name), false, `${name} must not be registered as a public tool`);
  }
  for (const [name, title] of [["list_tabs", "查看标签页"], ["get_working_tab", "查看工作页"]]) {
    const metadata = getCoreToolMetadata(name);
    assert.equal(metadata?.title, title, `${name} should keep its localized label for saved results`);
    assert.deepEqual(metadata?.sets, ["tab"], `${name} should be a tab UI tool`);
  }
  assert.equal(getCoreToolMetadata("search_tabs"), null, "removed tab search tool should not remain in UI metadata");
}

async function assertDuplicateGroupsMerge() {
  const { ensureQingzhouTabGroupForWindow, QINGZHOU_TAB_GROUP_TITLE } = await import("../../src/shared/tab-groups.js");
  const state = installChromeMock({
    tabs: [
      { id: 101, windowId: 1, groupId: 5 },
      { id: 102, windowId: 1, groupId: 9 },
      { id: 103, windowId: 1, groupId: -1 },
    ],
    groups: [
      { id: 5, windowId: 1, title: QINGZHOU_TAB_GROUP_TITLE, color: "cyan", collapsed: false },
      { id: 9, windowId: 1, title: QINGZHOU_TAB_GROUP_TITLE, color: "green", collapsed: false },
    ],
  });

  const result = await ensureQingzhouTabGroupForWindow([103], { color: "cyan" });
  assert.equal(result.groupId, 5);
  assert.equal(state.tabs.get(102).groupId, 5, "duplicate group tabs should move into the canonical group");
  assert.equal(state.tabs.get(103).groupId, 5, "new task tabs should join the canonical group");
  assert.equal(state.groups.get(5).title, QINGZHOU_TAB_GROUP_TITLE);
  assert.equal(state.groups.get(5).color, "cyan");
}

async function assertCreatesGroupWhenMissing() {
  const { ensureQingzhouTabGroupForWindow, QINGZHOU_TAB_GROUP_TITLE } = await import("../../src/shared/tab-groups.js");
  const state = installChromeMock({
    tabs: [
      { id: 201, windowId: 2, groupId: -1 },
      { id: 202, windowId: 2, groupId: -1 },
    ],
    groups: [],
  });

  const result = await ensureQingzhouTabGroupForWindow([201, 202], { color: "cyan" });
  assert.ok(result.groupId > 0);
  assert.equal(state.tabs.get(201).groupId, result.groupId);
  assert.equal(state.tabs.get(202).groupId, result.groupId);
  assert.equal(state.groups.get(result.groupId).title, QINGZHOU_TAB_GROUP_TITLE);
}

async function assertManagedGroupSurvivesLanguageSwitch() {
  const { ensureQingzhouTabGroupForWindow } = await import("../../src/shared/tab-groups.js");
  const state = installChromeMock({ tabs: [{ id: 301, windowId: 3, groupId: -1 }, { id: 302, windowId: 3, groupId: -1 }] });
  globalThis.chrome.i18n = {
    getUILanguage: () => "ja",
    getMessage: key => key === "qz_language" ? "ja" : key === chromeMessageId("backend.notification.task") ? "軽舟のタスク" : "",
  };
  const created = await ensureQingzhouTabGroupForWindow([301]);
  assert.equal(created.group.title, "軽舟のタスク");

  globalThis.chrome.i18n = { getUILanguage: () => "en" };
  const updated = await ensureQingzhouTabGroupForWindow([301, 302], { preferredGroupId: created.groupId });
  assert.equal(updated.groupId, created.groupId, "the persisted identity survives a language switch");
  assert.equal(state.groups.size, 1, "changing language must not create another task group");
  assert.equal(updated.group.title, "qz task");
  assert.equal(state.tabs.get(302).groupId, created.groupId);
}

async function assertManagedGroupSurvivesLegacyBranding() {
  const { ensureQingzhouTabGroupForWindow } = await import("../../src/shared/tab-groups.js");
  for (const title of ["Tâche Qingzhou", "Qingzhou のタスク", "輕舟任務"]) {
    const state = installChromeMock({
      tabs: [{ id: 401, windowId: 4, groupId: 9 }, { id: 402, windowId: 4, groupId: 5 }],
      groups: [{ id: 9, windowId: 4, title }, { id: 5, windowId: 4, title: "qz task" }],
    });
    globalThis.chrome.i18n = { getUILanguage: () => "en" };
    const result = await ensureQingzhouTabGroupForWindow([401, 402], { preferredGroupId: 9 });
    assert.equal(result.groupId, 9, `owned group ${title} takes priority over title matching`);
    assert.equal(state.tabs.get(402).groupId, 9, "existing duplicate groups still merge");
    assert.equal(result.group.title, "qz task");
  }
}

async function assertInvalidPreferredGroupIsNotAdopted() {
  const { ensureQingzhouTabGroupForWindow } = await import("../../src/shared/tab-groups.js");
  for (const preferredGroupId of [99, 8, 0, null]) {
    const state = installChromeMock({
      tabs: [{ id: 501, windowId: 5, groupId: -1 }, { id: 502, windowId: 5, groupId: 0 }, { id: 601, windowId: 6, groupId: 8 }],
      groups: [{ id: 0, windowId: 5, title: "Personal" }, { id: 8, windowId: 6, title: "qz task" }],
    });
    globalThis.chrome.i18n = { getUILanguage: () => "en" };
    const result = await ensureQingzhouTabGroupForWindow([501], { preferredGroupId });
    assert.notEqual(result.groupId, 8, "a missing or foreign-window preferred group must not be adopted");
    assert.notEqual(result.groupId, 0, "a stale same-window ID or null preference must not adopt an unrelated user group");
    assert.equal(state.groups.get(0).title, "Personal");
    assert.equal(state.tabs.get(502).groupId, 0);
    assert.equal(state.tabs.get(601).groupId, 8);
    assert.equal(state.tabs.get(501).windowId, 5);
    assert.equal(result.group.windowId, 5);
    assert.equal(state.groupCalls.length, 1);
    assert.deepEqual(state.groupCalls[0].tabIds, [501]);
  }
}

async function assertWitnessedDriveGroupKeepsItsId() {
  const { ensureQingzhouTabGroupForWindow } = await import("../../src/shared/tab-groups.js");
  const state = installChromeMock({
    tabs: [{ id: 701, windowId: 7, groupId: 3 }],
    groups: [{ id: 3, windowId: 7, title: "轻舟任务" }],
  });
  globalThis.chrome.i18n = { getUILanguage: () => "zh-CN" };
  const result = await ensureQingzhouTabGroupForWindow([701], { preferredGroupId: 3, title: "轻舟 · CLI" });
  assert.equal(result.groupId, 3);
  assert.equal(result.group.title, "轻舟 · CLI");
  assert.equal(state.groups.get(3).title, "轻舟 · CLI");
  assert.equal(state.tabs.get(701).groupId, 3);
}

async function assertTitleFallbackJoinsTheMatchingDriveGroup() {
  const { ensureQingzhouTabGroupForWindow } = await import("../../src/shared/tab-groups.js");
  const state = installChromeMock({
    tabs: [{ id: 702, windowId: 7, groupId: -1 }],
    groups: [
      { id: 3, windowId: 7, title: "轻舟任务" },
      { id: 4, windowId: 7, title: "轻舟 · CLI" },
    ],
  });
  globalThis.chrome.i18n = { getUILanguage: () => "zh-CN" };
  const result = await ensureQingzhouTabGroupForWindow([702], { title: "轻舟 · CLI" });
  assert.equal(result.groupId, 4);
  assert.equal(state.tabs.get(702).groupId, 4);
  assert.equal(state.groups.get(3).title, "轻舟任务");
}

async function assertStoredDriveGroupFollowsLanguage() {
  const { ensureQingzhouTabGroupForWindow } = await import("../../src/shared/tab-groups.js");
  const state = installChromeMock({
    tabs: [{ id: 703, windowId: 7, groupId: 4, url: "https://example.com/" }],
    groups: [{ id: 4, windowId: 7, title: "轻舟 · CLI" }],
  });
  const storage = createMemoryStorage({
    _sessions: { drive: { id: "drive", source: "external-drive", driveGroupTitle: "轻舟 · CLI", title: "My task" } },
    _session_tab_groups: { "drive:drive": { windows: { 7: { groupId: 4, tabIds: [703] } } } },
  });
  const repository = createSessionRepository({ storage });
  const runtime = { ownedTabIds: [703] };
  const sessionTabs = createSessionTabs({
    supervisor: { getRuntime: () => runtime, setRuntime: (_id, next) => Object.assign(runtime, next), runtimeEntries: () => [["drive", runtime]] },
    tabsApi: chrome.tabs, tabGroupsApi: chrome.tabGroups, storage,
    setRuntime: (_id, patch) => Object.assign(runtime, patch), persistRuntime: async () => {},
    getSessions: repository.listMetadata, ensureTabGroupForWindow: ensureQingzhouTabGroupForWindow,
  });
  for (const [language, brand] of [["en", "qz"], ["ja", "軽舟"], ["zh-TW", "輕舟"], ["zh-CN", "轻舟"]]) {
    const catalog = ["ja", "zh-TW"].includes(language)
      ? JSON.parse(readProjectFile(`src/capabilities/i18n/locales/${language}/content.json`)) : {};
    globalThis.chrome.i18n = { getUILanguage: () => language,
      getMessage: key => key === "qz_language" ? language : key === chromeMessageId("content.brand") ? catalog["content.brand"] || "" : "" };
    await sessionTabs.syncGroup();
    assert.equal(state.groups.get(4).title, `${brand} · CLI`);
    assert.equal(state.groups.size, 1, "renaming must reuse the existing group");
    assert.equal(state.tabs.get(703).groupId, 4);
    assert.equal((await repository.getMetadata("drive")).title, "My task");
  }
  assert.equal(state.groupCalls.length, 0, "changing language only updates the group label");
}

await assertToolExposure();
await assertDuplicateGroupsMerge();
await assertCreatesGroupWhenMissing();
await assertManagedGroupSurvivesLanguageSwitch();
await assertManagedGroupSurvivesLegacyBranding();
await assertInvalidPreferredGroupIsNotAdopted();
await assertWitnessedDriveGroupKeepsItsId();
await assertTitleFallbackJoinsTheMatchingDriveGroup();
await assertStoredDriveGroupFollowsLanguage();

console.log("tab group management tests passed");
