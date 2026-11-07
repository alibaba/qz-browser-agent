import { expect, test } from "./fixtures.mjs";

test("the task list hides the external drive tab until a drive session exists", async ({ page }, testInfo) => {
  const absentShot = testInfo.outputPath("drive-session-tab-absent.png");
  const presentShot = testInfo.outputPath("drive-session-tab.png");
  await page.setViewportSize({ width: 420, height: 360 });
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
    document.documentElement.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.height = "360px";
    document.body.style.width = "420px";
    document.querySelector("#app").style.height = "360px";
    document.querySelector("#app").style.width = "420px";
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    document.querySelectorAll(".tab-panel, #messages, #chat-dock, #session-title-bar").forEach(element => element.classList.add("hidden"));
    const panel = document.querySelector("#sessions-panel");
    panel.classList.remove("hidden");
    panel.style.flex = "none";
    panel.style.height = "auto";
    panel.style.minHeight = "0";
    const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
    const { SESSIONS_KEY } = await import("/extension/shared/session/session-store.js");
    const records = {
      normal: { id: "normal", title: "普通调研", status: "completed", parentSessionId: "0", updatedAt: "2026-09-18 12:00:00", source: "" },
    };
    globalThis.chrome = { storage: { local: createMemoryStorage({ [SESSIONS_KEY]: records }) } };
    const { createSessionState } = await import("/extension/sidepanel/features/sessions/session-state.js");
    const { createWorkspaceExtensions } = await import("/extension/sidepanel/features/app/workspace-extensions.js");
    const { createSidepanelUiRuntime } = await import("/extension/sidepanel/capability-host/runtime.js");
    const { default: capability } = await import("/extension/capabilities/sessions/ui.js");
    const state = createSessionState();
    const f = { currentPage: "sessions", sessions: Object.values(records) };
    const host = {
      root: document, settings: {}, extensions: createWorkspaceExtensions(() => {}),
      async request(type) {
        if (type === "list_sessions") return { sessions: f.sessions };
        if (type === "list_automations") return { automations: [], runs: {} };
        if (type === "get_session_artifacts") return { artifacts: {} };
        return {};
      },
      send() {}, navigate: () => true, notifyViewChange() {},
      getCurrentSessionId: () => "normal", getCurrentPage: () => f.currentPage,
      getRunContext: () => ({ runStatus: "idle", activeRunId: null, currentSessionId: "normal" }),
      showToast() {}, hideToast: () => false, syncKeepAlive() {}, dialogs: { confirm: async () => true },
      sessions: {
        getRuntime: id => state.getRuntime(id), getRecord: id => state.getRecord(id),
        mergeRecord: (...args) => state.mergeRecord(...args), mergeRecords: (...args) => state.mergeRecords(...args),
        mergeRuntime: (...args) => state.mergeRuntime(...args), updateRuntime: () => false,
        isDeleted: () => false, getTranscript: () => [], hasTranscript: () => true,
        open() {}, export() {}, isExporting: () => false,
      },
      chat: { refresh() {}, scheduleRender() {}, clearInlineActions() {}, appendNote() {},
        isGoalClearPending: () => false, renderGoal() {}, flashAction() {} },
    };
    f.runtime = createSidepanelUiRuntime({ host, onError: () => {} });
    f.mount = () => {
      f.runtime.mountAll([{ id: "sessions", setup: capability }]);
      document.querySelector("#sessions-panel").classList.remove("hidden");
    };
    f.mount();
    f.runtime.activatePage("sessions");
    window.__sessionsCapability = f;
  });

  const driveTab = page.locator('[data-sessions-mode="external-drive"]');
  await expect(page.locator('.session-card[data-id="normal"]')).toBeVisible();
  await expect(driveTab).toBeHidden();
  await expect(page.locator("#sessions-list")).toContainText("普通调研");
  await page.locator("#sessions-panel").screenshot({ path: absentShot });

  await page.evaluate(async () => {
    const f = window.__sessionsCapability;
    const { SESSIONS_KEY } = await import("/extension/shared/session/session-store.js");
    const records = {
      normal: { id: "normal", title: "普通调研", status: "completed", parentSessionId: "0", updatedAt: "2026-09-18 12:00:00", source: "" },
      "drive-1": { id: "drive-1", title: "直驱页面", status: "idle", parentSessionId: "0", updatedAt: "2026-09-18 12:02:00", source: "external-drive" },
      "drive-2": { id: "drive-2", title: "另一个直驱", status: "idle", parentSessionId: "0", updatedAt: "2026-09-18 12:03:00", source: "external-drive" },
    };
    f.sessions = Object.values(records);
    await chrome.storage.local.set({ [SESSIONS_KEY]: records });
    f.runtime.emit({ type: "sessions_changed" });
  });

  await expect(driveTab).toBeVisible();
  await expect(driveTab).toHaveText("外部直驱");
  await expect(page.locator('.session-card[data-id="drive-1"]')).toHaveCount(0);
  await expect(page.locator("#sessions-list")).toContainText("普通调研");
  await driveTab.click();
  await expect(page.locator('.session-card[data-id="drive-1"]')).toBeVisible();
  await expect(page.locator('.session-card[data-id="drive-2"]')).toBeVisible();
  await expect(page.locator('.session-card[data-id="normal"]')).toHaveCount(0);
  const ids = await page.locator("#sessions-list .session-card").evaluateAll((cards) => cards.map((card) => card.dataset.id));
  expect(ids).toEqual(expect.arrayContaining(["drive-1", "drive-2"]));
  expect(ids.every((id) => id.startsWith("drive-"))).toBe(true);
  await page.locator("#sessions-panel").screenshot({ path: presentShot });

  await page.evaluate(async () => {
    const { applyExternalDriveChrome } = await import("/extension/sidepanel/features/chat/chat-workspace-feature.js");
    document.querySelector("#sessions-panel")?.classList.add("hidden");
    document.querySelector("#messages")?.classList.remove("hidden");
    document.querySelector("#chat-dock")?.classList.remove("hidden");
    document.querySelector("#welcome")?.insertAdjacentHTML("beforeend", `
      <section class="welcome-onboarding">
        <h2>先从一个小任务开始</h2>
        <button id="onboarding-primary-btn" type="button">配置模型接口</button>
        <button type="button" class="onboarding-action">世界主要城市未来 7 天天气</button>
      </section>
    `);
    navigator.clipboard.writeText = async text => { window.__copiedDriveCommand = text; };
    applyExternalDriveChrome(document, true);
  });
  await expect(page.locator("#input-area")).toBeHidden();
  await expect(page.locator("#external-drive-readonly")).toBeVisible();
  await expect(page.locator("#external-drive-readonly")).toContainText("只能查看");
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator(".welcome-onboarding")).toBeHidden();
  await expect(page.locator("#onboarding-primary-btn")).toBeHidden();
  await expect(page.locator(".welcome-subtitle")).toBeHidden();
  await expect(page.locator("#drive-welcome")).toBeVisible();
  await expect(page.locator("#drive-welcome h2")).toHaveText("由外部 agent 直接操作");
  await expect(page.locator("#drive-welcome-command")).toHaveText("npx qz-browser-agent@latest connect uri");
  await page.locator("#drive-welcome-copy").click();
  await expect.poll(() => page.evaluate(() => window.__copiedDriveCommand)).toBe("npx qz-browser-agent@latest connect uri");
  await expect(page.locator("#drive-welcome-copy")).toHaveClass(/is-confirmed/);
});
