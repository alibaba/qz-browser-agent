import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    const [{ createTranscriptRenderer }, { createTranscriptProjection }, { createSessionState }] = await Promise.all([
      import("/extension/sidepanel/features/chat/transcript/renderer.js"),
      import("/extension/sidepanel/features/chat/transcript/projection.js"),
      import("/extension/sidepanel/features/sessions/session-state.js"),
    ]);
    document.body.innerHTML = '<div id="app" data-workspace-booting><div id="messages"></div></div>';
    const root = document.querySelector("#app");
    const messages = document.querySelector("#messages");
    const state = { sessionId: "a", active: true, commands: [], sends: [] };
    const jobs = [];
    const observers = [];
    let nextHandle = 0;
    const queue = (kind, callback) => {
      const job = { kind, callback, handle: ++nextHandle, cancelled: false };
      jobs.push(job); return job.handle;
    };
    const cancel = handle => { const job = jobs.find(job => job.handle === handle); if (job) job.cancelled = true; };
    window.setTimeout = callback => queue("timeout", callback);
    window.clearTimeout = cancel;
    window.requestAnimationFrame = callback => queue("frame", callback);
    window.cancelAnimationFrame = cancel;
    window.requestIdleCallback = callback => queue("idle", callback);
    window.cancelIdleCallback = cancel;
    const NativeObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeObserver {
      constructor(callback) {
        super(callback); this.deliver = callback; this.disconnected = false; observers.push(this);
      }
      disconnect() { this.disconnected = true; super.disconnect(); }
    };
    const scroll = {
      hasLatestIntent: () => true, shouldFollowTail: () => true, isUserScrolling: () => false,
      consumeLatestIntent() {}, scrollToBottom() {}, cancelScheduledScroll() {}, clearLatestIntent() {},
      setFollowing() {}, syncScrollPosition() {}, userScrollIdleMs: 180,
    };
    const renderer = createTranscriptRenderer({
      messagesEl: messages, workspaceRoot: root, sessionState: createSessionState(),
      projection: createTranscriptProjection(), scroll,
      composer: { consumeOutgoingEntry: () => null }, math: {},
      getSessionId: () => state.sessionId, isCurrentSession: id => id === state.sessionId,
      isChatActive: () => state.active,
      request(type, payload) {
        state.commands.push({ ...payload, type });
        return new Promise((resolve, reject) => state.sends.push({ resolve, reject }));
      },
    });
    renderer.setTranscript("a", Array.from({ length: 120 }, (_, index) => ({ type: "user", text: `旧消息 ${index}` })));
    renderer.render("a", { force: true });
    renderer.scheduleRender("a", { delay: 120 });
    window.schedulerFixture = { renderer, root, messages, state, jobs, observers };
  });
  await expect(page.locator("#messages > [data-transcript-key]")).toHaveCount(48);
});

for (const operation of ["forgetSession", "resetState", "resetUi"]) {
  test(`${operation} revokes render and backfill before the same session is reused`, async ({ page }) => {
    const result = await page.evaluate(operation => {
      const { renderer, root, messages, jobs, observers } = window.schedulerFixture;
      const oldTimer = jobs.find(job => job.kind === "timeout");
      const oldObserver = observers.find(observer => !observer.disconnected);
      renderer[operation]("a");
      const afterCleanup = messages.innerHTML;
      renderer.setTranscript("a", [{ type: "user", text: "新会话内容" }]);
      renderer.scheduleRender("a", { delay: 0 });
      root.removeAttribute("data-workspace-booting");
      oldObserver.deliver();
      oldTimer.callback();
      const unchanged = messages.innerHTML === afterCleanup;
      const fresh = jobs.filter(job => job.kind === "frame" && !job.cancelled);
      fresh.forEach(job => job.callback());
      return {
        unchanged, oldTimerCancelled: oldTimer.cancelled, observerDisconnected: oldObserver.disconnected,
        freshFrames: fresh.length, count: messages.querySelectorAll("[data-transcript-key]").length,
        text: messages.textContent, partial: renderer.hasPartial("a"),
      };
    }, operation);
    expect(result).toMatchObject({
      unchanged: true, oldTimerCancelled: true, observerDisconnected: true, freshFrames: 1, count: 1, partial: false,
    });
    expect(result.text).toContain("新会话内容");
    expect(result.text).not.toContain("旧消息");
  });
}

test("late work from a previous session cannot render into or cancel the current session", async ({ page }) => {
  const result = await page.evaluate(() => {
    const { renderer, root, messages, state, jobs, observers } = window.schedulerFixture;
    const oldTimer = jobs.find(job => job.kind === "timeout");
    const oldObserver = observers.find(observer => !observer.disconnected);
    state.sessionId = "b";
    root.removeAttribute("data-workspace-booting");
    renderer.setTranscript("b", [{ type: "user", text: "任务 B" }]);
    renderer.scheduleRender("b", { delay: 0 });
    const before = messages.innerHTML;
    oldTimer.callback(); oldObserver.deliver();
    const unchanged = messages.innerHTML === before;
    const fresh = jobs.filter(job => job.kind === "frame" && !job.cancelled);
    fresh.forEach(job => job.callback());
    return { unchanged, freshFrames: fresh.length, text: messages.textContent, observerDisconnected: oldObserver.disconnected };
  });
  expect(result).toMatchObject({ unchanged: true, freshFrames: 1, observerDisconnected: true });
  expect(result.text).toContain("任务 B");
  expect(result.text).not.toContain("旧消息");
});

test("clearing only partial history keeps a pending full render", async ({ page }) => {
  const result = await page.evaluate(() => {
    const { renderer, root, messages, jobs, observers } = window.schedulerFixture;
    const timer = jobs.find(job => job.kind === "timeout");
    const observer = observers.find(observer => !observer.disconnected);
    renderer.clearPartial("a");
    root.removeAttribute("data-workspace-booting");
    observer.deliver();
    const before = messages.querySelectorAll("[data-transcript-key]").length;
    timer.callback();
    jobs.find(job => job.kind === "frame" && !job.cancelled).callback();
    return { before, count: messages.querySelectorAll("[data-transcript-key]").length, observerDisconnected: observer.disconnected };
  });
  expect(result).toEqual({ before: 48, count: 120, observerDisconnected: true });
});


test("reconcile replaces a mismatched row and releases its waiting handlers", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderer, messages, state } = window.schedulerFixture;
    renderer.setTranscript("a", [{ type: "wait", waitId: "wait-a", status: "waiting", title: "确认" }]);
    renderer.render("a", { force: true });
    const old = messages.querySelector(".msg-waiting");
    const oldButton = old.querySelector('[data-wait-action="continue"]');
    oldButton.click();
    old.dataset.transcriptType = "user";
    renderer.render("a", { force: true });
    const next = messages.querySelector(".msg-waiting");
    const before = next.innerHTML;
    state.sends[0].reject(new Error("late old card"));
    await Promise.resolve(); await Promise.resolve();
    old.querySelector('[data-wait-action="cancel"]').dispatchEvent(new MouseEvent("click"));
    return { replaced: next !== old, count: messages.querySelectorAll("[data-transcript-key]").length,
      removed: !old.isConnected, unchanged: next.innerHTML === before, commands: state.commands };
  });
  expect(result).toEqual({ replaced: true, count: 1, removed: true, unchanged: true,
    commands: [{ type: "continue_task", sessionId: "a", waitId: "wait-a" }] });
});
