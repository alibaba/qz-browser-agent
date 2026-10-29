import { expect, test } from "./sidepanel-fixtures.mjs";

for (const ending of ["boundary", "end"]) for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`streamed table fades once without resizing · ${ending} · ${reducedMotion}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 430, height: 760 });
    await page.emulateMedia({ colorScheme: ending === "end" ? "dark" : "light", reducedMotion });
    const source = "| 景点 | 图片尺寸 |\n|---|---|\n| 湖边楼阁 | 1365×2048 |\n| 木造舞台 | 1452×969 |";
    await page.evaluate(async source => {
      const bench = window.qingzhouConversationBenchmark;
      await bench.runLiveReplay({ sessionId: "table-reveal", baseTranscript: [
        { type: "user", text: "比较图片尺寸" },
        { type: "assistant", spanId: "history-table", content: source },
      ], events: [] }, { runId: "table-run" });
      bench.dispatchBackgroundEvent({ type: "message_update", sessionId: "table-reveal", runId: "table-run",
        spanId: "new-table", eventSeq: 1, content: source });
    }, source);
    const answer = page.locator('[data-stream-trace-id="new-table"]');
    await expect(answer).toHaveAttribute("data-content", source);
    await expect(answer.locator(".markdown-table-pending")).toBeVisible();
    const result = await page.evaluate(async ({ source, ending }) => {
      const bench = window.qingzhouConversationBenchmark;
      const history = document.querySelector('[data-stream-trace-id="history-table"] table');
      const answer = document.querySelector('[data-stream-trace-id="new-table"]');
      const frames = [], transitions = [];
      let appearedAt = 0, changed = false, eventSeq = 1;
      answer.addEventListener("transitionrun", event => {
        if (event.target.tagName === "TABLE") transitions.push(event.propertyName);
      });
      const dispatch = event => bench.dispatchBackgroundEvent({ sessionId: "table-reveal", runId: "table-run",
        spanId: "new-table", eventSeq: ++eventSeq, ...event });
      const next = source + "\n\n表格后继续输出。";
      const historicalAnimation = history.getAnimations().length;
      dispatch(ending === "end" ? { type: "message_end", message: { role: "assistant", content: source } }
        : { type: "message_update", content: next });
      const started = performance.now();
      while (performance.now() - started < 3000) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const table = answer.querySelector("table");
        if (!table) continue;
        appearedAt ||= performance.now();
        const rect = table.getBoundingClientRect();
        frames.push({ opacity: Number(getComputedStyle(table).opacity), width: rect.width, height: rect.height,
          columns: [...table.querySelectorAll("th")].map(cell => cell.getBoundingClientRect().width) });
        if (ending === "boundary" && !changed && frames.length >= 2) {
          changed = true;
          dispatch({ type: "message_update", content: next + "追加文字保持表格不变。" });
        }
        if (performance.now() - appearedAt > 350) break;
      }
      return { frames, transitions, historicalAnimation, rows: answer.querySelectorAll("tbody tr").length };
    }, { source, ending });
    await testInfo.attach("table-reveal-frames.json", { body: Buffer.from(JSON.stringify(result)), contentType: "application/json" });
    expect(result.historicalAnimation).toBe(0);
    expect(result.rows).toBe(2);
    expect(result.frames.length).toBeGreaterThan(3);
    expect(new Set(result.frames.map(({ width, height, columns }) => JSON.stringify({ width, height, columns }))).size).toBe(1);
    expect(result.frames.at(-1).opacity).toBe(1);
    if (reducedMotion === "reduce") {
      expect(result.transitions).toEqual([]);
      expect(result.frames.every(frame => frame.opacity === 1)).toBe(true);
    } else {
      expect(result.transitions).toEqual(["opacity"]);
      expect(result.frames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
      expect(result.frames.every((frame, i) => !i || frame.opacity >= result.frames[i - 1].opacity)).toBe(true);
    }
  });
}
