import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

const SIDEPANEL_URL = "/extension/sidepanel/sidepanel.html";
const WINDOW_ID = 7;
const VIEW_KEY = `qingzhou:workspace-view:${WINDOW_ID}`;

// Build fixture records with the browser's emitted modules before navigating to the app.
async function storedSessionFixture(page, input) {
  return page.evaluate(async ({ session, conversation, transcript }) => {
    const { createSessionRecord } = await import("/extension/shared/session/session-codec.js");
    const { SESSIONS_KEY, storedSessionKey } = await import("/extension/shared/session/session-store.js");
    const storage = { [SESSIONS_KEY]: { [session.id]: session } };
    if (transcript) storage[storedSessionKey(session.id)] = createSessionRecord(conversation, transcript);
    return storage;
  }, input);
}

test("restores the last stable workspace before the first visible frame", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "sessions", mode: "automation" },
    },
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "sessions",
    visible: ["sessions-panel"],
    sessionsMode: "automation",
    dataTable: "",
  });

  await page.evaluate(async () => {
    const { insertDataRows } = await import("/extension/shared/data-store.js");
    await insertDataRows("alpha_table", [{ id: 1, value: "alpha" }]);
    await insertDataRows("zeta_table", [{ id: 2, value: "zeta" }]);
  });
  await page.locator('.tab-btn[data-tab="data"]').click();
  await expect(page.locator("#data-table-search")).not.toHaveValue("");
  await page.locator("#data-table-search").click();
  await page.locator('.data-table-select[data-table="zeta_table"]').click();
  await expect(page.locator("#data-table-search")).toHaveValue("zeta_table");
  await page.waitForFunction(
    ({ key }) => JSON.parse(localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null")?.state?.table === "zeta_table",
    { key: VIEW_KEY },
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "data",
    visible: ["data-panel"],
    sessionsMode: "manual",
    dataTable: "zeta_table",
    dataLoadingVisible: true,
  });
  await expect(page.locator("#data-detail")).toBeVisible();
});

test("keeps the latest data table when an older query finishes later", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => {
    const { insertDataRows } = await import("/extension/shared/data-store.js");
    await insertDataRows(
      "slow_table",
      Array.from({ length: 8000 }, (_, index) => ({ marker: `slow-${index}` })),
    );
    await insertDataRows("fast_table", [{ marker: "latest-table-row" }]);
  });
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await page.locator('.tab-btn[data-tab="data"]').click();
  await expect(page.locator("#data-detail")).toBeVisible();
  await page.evaluate(() => {
    globalThis.__qingzhouDataStorePerf.length = 0;
    const picker = document.querySelector("#data-table-search");
    picker.click();
    document.querySelector('.data-table-select[data-table="slow_table"]')?.click();
    picker.click();
    document.querySelector('.data-table-select[data-table="fast_table"]')?.click();
  });
  await page.waitForFunction(() => {
    const completed = globalThis.__qingzhouDataStorePerf
      .filter(entry => entry.name === "query_rows")
      .map(entry => entry.meta?.table);
    return completed.includes("slow_table") && completed.includes("fast_table");
  });

  await expect(page.locator("#data-table-search")).toHaveValue("fast_table");
  await expect(page.locator("#data-preview")).toContainText("latest-table-row");
  await expect(page.locator("#data-preview")).not.toContainText("slow-0");
  await expect(page.locator("#data-loading")).toBeHidden();
});

test("hydrates the restored chat session before revealing it", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const sessionId = "restored-chat";
  const title = "上次查看的对话";
  const message = "这条消息必须在首个可见帧中出现";
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "chat", sessionId },
    },
    localStorage: await storedSessionFixture(page, {
      session: { id: sessionId, title, parentSessionId: "root" },
      conversation: [{ role: "user", content: message }],
      transcript: [{ type: "user", text: message }],
    }),
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "chat",
    visible: ["messages"],
    sessionTitle: title,
    messageText: message,
  });
  expect(await page.evaluate(() => (
    window.__qzPostedMessages.some(message => message.type === "activate_session_working_tab")
  ))).toBe(false);
});

test("a failed page restore returns to the empty Chat workspace", async ({ page, browserDiagnostics }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const sessionId = "failed-restoration";
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false, windowId: WINDOW_ID,
    sessionStorage: { [VIEW_KEY]: { v: 1, page: "chat", sessionId } },
    localStorage: await storedSessionFixture(page, {
      session: { id: sessionId, title: "尚未恢复的对话" },
    }),
  });
  await page.route("**/extension/sidepanel/features/app/workspace-composition.js", async route => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'await navigation.switchToSession(id, { source: "restore", signal });';
    expect(body).toContain(marker);
    await route.fulfill({ response, body: body.replace(marker, 'throw new Error("forced page restore failure");') });
  });
  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
  await expect(page.locator('.tab-btn[data-tab="chat"]')).toHaveClass(/active/);
  await expect(page.locator("#input")).toHaveValue("");
  await expect(page.locator("#session-title-bar")).toBeHidden();
  await expect.poll(() => page.evaluate(key => JSON.parse(
    localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null",
  ), VIEW_KEY)).toEqual({ v: 2, page: "chat", state: { sessionId: null } });
  expect(browserDiagnostics.consoleErrors).toHaveLength(1);
  expect(browserDiagnostics.consoleErrors[0]).toContain("forced page restore failure");
  browserDiagnostics.consoleErrors.length = 0;
});

test("leaving a slow restoring page preserves the user's newer navigation", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const sessionId = "cancelled-restoration";
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false, windowId: WINDOW_ID,
    sessionStorage: { [VIEW_KEY]: { v: 2, page: "chat", state: { sessionId } } },
    localStorage: await storedSessionFixture(page, {
      session: { id: sessionId, title: "慢恢复" },
    }),
  });
  await page.route("**/extension/sidepanel/features/sessions/session-navigation-feature.js", async route => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = "async function hasStoredSession(sessionId) {";
    expect(body).toContain(marker);
    await route.fulfill({ response, body: body.replace(marker, `${marker}
      await new Promise(resolve => { globalThis.__releaseStoredSessionRead = resolve; });`) });
  });
  await page.goto(SIDEPANEL_URL, { waitUntil: "commit" });
  await expect(page.locator("#app")).toHaveAttribute("data-workspace-boot-fallback", "timeout", { timeout: 8000 });
  await page.locator('.tab-btn[data-tab="data"]').click();
  await expect(page.locator("#data-panel")).toBeVisible();
  await page.evaluate(() => globalThis.__releaseStoredSessionRead());
  // Successful completion of startup persists the current view, not the cancelled restore.
  await expect.poll(() => page.evaluate(key => JSON.parse(
    localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null",
  ), VIEW_KEY)).toMatchObject({ v: 2, page: "data" });
  await expect(page.locator('.tab-btn[data-tab="data"]')).toHaveClass(/active/);
  await expect(page.locator("#session-title-bar")).toBeHidden();
  expect(await page.evaluate(() => window.__qzPostedMessages.some(message =>
    message.type === "restore_session" && message.sessionId === "cancelled-restoration"))).toBe(false);
});

test("reveals the latest tail of a long restored chat before backfilling its history", async ({ page }, testInfo) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const sessionId = "restored-long-chat";
  const title = "超长恢复对话";
  const transcript = Array.from({ length: 140 }, (_, index) => ({
    type: "user",
    text: `长对话消息 ${String(index + 1).padStart(3, "0")}`,
    images: [],
  }));
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    localGetDelayMs: 40,
    respondToStateWithoutRequestId: true,
    stateResponseDelayMs: 80,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "chat", sessionId },
    },
    localStorage: await storedSessionFixture(page, {
      session: { id: sessionId, title, parentSessionId: "root" },
      conversation: [],
      transcript,
    }),
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  const firstReveal = await page.evaluate(() => window.__qzFirstWorkspaceReveal);
  expect(firstReveal).toMatchObject({
    tab: "chat",
    visible: ["messages"],
    sessionTitle: title,
    transcriptCount: 48,
    hasLongFirstMessage: false,
    hasLongLastMessage: true,
  });
  await testInfo.attach("first-workspace-reveal.json", {
    body: JSON.stringify(firstReveal), contentType: "application/json",
  });

  await expect.poll(
    () => page.locator("#messages > [data-transcript-key]").count(),
    { timeout: 10_000 },
  ).toBe(transcript.length);
  await expect(page.locator("#messages")).toContainText("长对话消息 001");
  await expect(page.locator("#messages")).toContainText("长对话消息 140");
  expect(await page.locator("#messages").evaluate(element => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThanOrEqual(2);
});

test("recovers a long restored chat when incremental history backfill fails", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const sessionId = "restored-long-chat-recovery";
  const transcript = Array.from({ length: 110 }, (_, index) => ({
    type: "user",
    text: `恢复消息 ${String(index + 1).padStart(3, "0")}`,
    images: [],
  }));
  await page.route("**/extension/sidepanel/features/chat/transcript/renderer.js", async route => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = "const nextStart = Math.max(0, state.start - TRANSCRIPT_BACKFILL_BATCH_SIZE);";
    expect(body).toContain(marker);
    await route.fulfill({
      response,
      body: body.replace(marker, `
    if (!globalThis.__qzBackfillFailureInjected) {
      globalThis.__qzBackfillFailureInjected = true;
      throw new Error("forced transcript backfill failure");
    }
    ${marker}`),
    });
  });
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "chat", sessionId },
    },
    localStorage: await storedSessionFixture(page, {
      session: { id: sessionId, title: "回填恢复对话", parentSessionId: "root" },
      conversation: [],
      transcript,
    }),
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal?.transcriptCount)).toBe(48);
  await expect.poll(
    () => page.locator("#messages > [data-transcript-key]").count(),
    { timeout: 10_000 },
  ).toBe(transcript.length);
  expect(await page.evaluate(() => window.__qzBackfillFailureInjected)).toBe(true);
  await expect(page.locator("#messages")).toContainText("恢复消息 001");
  await expect(page.locator("#messages")).toContainText("恢复消息 110");
});

test("lets an explicit notification replace the stored view before reveal", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const table = "notification_must_skip_this_table";
  await page.evaluate(async tableName => {
    const { insertDataRows } = await import("/extension/shared/data-store.js");
    await insertDataRows(tableName, [{ id: 1, value: "must not load" }]);
  }, table);
  const sessionId = "notification-target";
  const title = "通知指定的对话";
  const message = "通知目标必须覆盖上次界面";
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    attachMessages: [{ type: "session_reveal_requested", sessionId, source: "notification" }],
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "data", table },
    },
    localStorage: await storedSessionFixture(page, {
      session: { id: sessionId, title, parentSessionId: "root" },
      conversation: [{ role: "user", content: message }],
      transcript: [{ type: "user", text: message }],
    }),
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "chat",
    visible: ["messages"],
    sessionTitle: title,
    dataTable: "",
    dataLoadingVisible: false,
  });
  await expect(page.locator("#messages")).toContainText(message);
});

test("restores a Skill detail without flashing the Skill list", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "skills", skill: "workspace-demo" },
    },
    localStorage: {
      _skills: {
        "workspace-demo": {
          name: "workspace-demo",
          displayName: "工作区恢复示例",
          description: "测试恢复",
          content: "# 已恢复",
          scope: "global",
          format: "qingzhou.skill",
          schemaVersion: 2,
        },
      },
    },
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "skills",
    visible: ["skills-panel"],
    skillName: "工作区恢复示例",
    skillDetailVisible: true,
  });
});

test("restores the Logs tab only after its debug capability is known", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    config: { debugMode: true },
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "logs" },
    },
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "logs",
    visible: ["logs-panel"],
  });
});

for (const colorScheme of ["light", "dark"]) {
  test(`reveals a clear ${colorScheme} fallback when the workspace module fails before startup`, async ({ page, browserDiagnostics }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(installBenchmarkChromeStub, { benchmark: false });
    await page.route("**/extension/sidepanel/app.js", route => route.fulfill({
      contentType: "application/javascript",
      body: 'throw new Error("forced workspace startup failure");',
    }));

    await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await expect(page.locator("#app")).toHaveAttribute("data-workspace-boot-fallback", "error");
    await expect(page.locator("#workspace-boot-fallback")).toHaveText("轻舟启动失败，请重新打开侧边栏");
    await expect(page.locator("#header")).toBeVisible();
    expect(browserDiagnostics.consoleErrors).toHaveLength(1);
    expect(browserDiagnostics.consoleErrors[0]).toContain("forced workspace startup failure");
    browserDiagnostics.consoleErrors.length = 0;
  });
}

test("surfaces an error thrown by the application startup sequence", async ({ page, browserDiagnostics }) => {
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false, windowId: WINDOW_ID });
  await page.route("**/extension/sidepanel/features/app/workspace-composition.js", async route => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain("await mounted;");
    await route.fulfill({
      response,
      body: body.replace("await mounted;", 'throw new Error("forced internal startup failure");'),
    });
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).toHaveAttribute("data-workspace-boot-fallback", "error");
  await expect(page.locator("#workspace-boot-fallback")).toHaveText("轻舟启动失败，请重新打开侧边栏");
  expect(browserDiagnostics.consoleErrors.some(message => message.includes("forced internal startup failure"))).toBe(true);
  browserDiagnostics.consoleErrors.length = 0;
});

test("reveals the current shell if workspace startup never settles", async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false });
  await page.route("**/extension/sidepanel/app.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "await new Promise(() => {}); export {};",
  }));

  await page.goto(SIDEPANEL_URL, { waitUntil: "commit" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting", { timeout: 8000 });
  await expect(page.locator("#app")).toHaveAttribute("data-workspace-boot-fallback", "timeout");
  await expect(page.locator("#workspace-boot-fallback")).toHaveText("轻舟仍在启动，请稍候或重新打开侧边栏");
  await expect(page.locator("#header")).toBeVisible();
});

test("does not overwrite the stored workspace when bootstrap falls back after a slow read", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  const storedView = { v: 1, page: "data", table: "preserve_this_table" };
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionGetDelayMs: 450,
    sessionStorage: { [VIEW_KEY]: storedView },
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await page.waitForTimeout(500);
  expect(await page.evaluate(key => (
    JSON.parse(localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null")
  ), VIEW_KEY)).toEqual(storedView);
  expect(await page.evaluate(() => window.__qzSessionSetAttempts)).toBe(0);
});

test("forgets a deleted Data target after restoring an empty workspace", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(installFirstWorkspaceRevealProbe);
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "data", table: "deleted_table" },
    },
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#data-empty")).toBeVisible();
  await page.waitForFunction(
    ({ key }) => JSON.parse(localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null")?.state?.table === null,
    { key: VIEW_KEY },
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  expect(await page.evaluate(() => window.__qzFirstWorkspaceReveal)).toMatchObject({
    tab: "data",
    dataTable: "",
  });
});

test("retries the same stable view after a transient workspace save failure", async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(installBenchmarkChromeStub, {
    benchmark: false,
    windowId: WINDOW_ID,
    sessionSetFailures: 1,
    sessionStorage: {
      [VIEW_KEY]: { v: 1, page: "sessions", mode: "manual" },
    },
  });

  await page.goto(SIDEPANEL_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await page.locator('.tab-btn[data-tab="chat"]').click();
  await page.waitForFunction(() => window.__qzSessionSetAttempts === 1);
  expect(await page.evaluate(key => (
    JSON.parse(localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null")?.page
  ), VIEW_KEY)).toBe("sessions");

  await page.locator("#btn-new").click();
  await page.waitForFunction(
    ({ key }) => JSON.parse(localStorage.getItem(`__qz_test_chrome_session__:${key}`) || "null")?.page === "chat",
    { key: VIEW_KEY },
  );
  expect(await page.evaluate(() => window.__qzSessionSetAttempts)).toBe(2);
});

function installFirstWorkspaceRevealProbe() {
  window.__qzFirstWorkspaceReveal = null;
  const startedAt = performance.now();
  document.addEventListener("DOMContentLoaded", () => {
    const app = document.querySelector("#app");
    if (!app) return;
    const capture = () => {
      if (app.hasAttribute("data-workspace-booting") || window.__qzFirstWorkspaceReveal) return;
      const visible = [
        ["messages", document.querySelector("#messages")],
        ["sessions-panel", document.querySelector("#sessions-panel")],
        ["data-panel", document.querySelector("#data-panel")],
        ["skills-panel", document.querySelector("#skills-panel")],
        ["logs-panel", document.querySelector("#logs-panel")],
      ].filter(([, element]) => element && !element.classList.contains("hidden")).map(([name]) => name);
      window.__qzFirstWorkspaceReveal = {
        tab: document.querySelector(".tab-btn.active")?.dataset?.tab || "",
        visible,
        sessionsMode: document.querySelector(".sessions-mode-btn.active")?.dataset?.sessionsMode || "",
        dataTable: document.querySelector("#data-table-search")?.value || "",
        dataLoadingVisible: !document.querySelector("#data-loading")?.classList.contains("hidden"),
        sessionTitle: document.querySelector("#current-session-title")?.textContent || "",
        revealedAfterMs: Math.round(performance.now() - startedAt),
        transcriptCount: document.querySelectorAll("#messages > [data-transcript-key]").length,
        hasLongFirstMessage: document.querySelector("#messages")?.textContent?.includes("长对话消息 001") || false,
        hasLongLastMessage: document.querySelector("#messages")?.textContent?.includes("长对话消息 140") || false,
        messageText: document.querySelector("#messages")?.textContent?.includes("这条消息必须在首个可见帧中出现")
          ? "这条消息必须在首个可见帧中出现"
          : "",
        skillName: document.querySelector("#skill-detail-name")?.textContent || "",
        skillDetailVisible: !document.querySelector("#skill-detail")?.classList.contains("hidden"),
      };
    };
    new MutationObserver(capture).observe(app, {
      attributes: true,
      attributeFilter: ["data-workspace-booting"],
    });
    capture();
  }, { once: true });
}
