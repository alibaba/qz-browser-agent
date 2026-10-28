/** Runs in either the Chrome fixture page or Firefox's real extension sidebar. */
export async function runToolCollapseProbe({ scope = window, toolCount = 45, footer = false } = {}) {
  const doc = scope.document;
  const bench = scope.qingzhouConversationBenchmark;
  const frame = () => new Promise(resolve => scope.requestAnimationFrame(resolve));
  const settle = async () => { for (let index = 0; index < 20; index += 1) await frame(); };
  const sessionId = "short-collapse-session";
  const runId = "short-collapse-run";
  // Firefox's privileged test driver must pass records from the sidebar realm.
  const record = value => scope.JSON.parse(JSON.stringify(value));
  await bench.runSnapshotRender(record({
    sessionId,
    transcript: [
      { type: "user", text: "京都五景点维基图片采集", clientMessageId: "first-user" },
      ...Array.from({ length: toolCount }, (_, index) => ({
        type: "tool", runId, toolCallId: `tool-${index}`, name: "read_article",
        args: { tabId: index + 1 }, phase: "done", isRunning: false, isError: false,
        result: { title: `Article ${index}`, text: "Article content.\n".repeat(150) },
      })),
    ],
  }));
  bench.configureVisualState(record({ running: true }));
  await settle();
  const messages = doc.querySelector("#messages");
  const summary = messages.querySelector(".tool-timeline-summary, .tool-summary");
  const measure = () => {
    const user = messages.querySelector(".msg-user").getBoundingClientRect();
    const viewport = messages.getBoundingClientRect();
    const currentSummary = messages.querySelector(".tool-timeline-summary, .tool-summary");
    return {
      scrollTop: messages.scrollTop, overflow: messages.scrollHeight - messages.clientHeight,
      userTop: user.top - viewport.top, userBottom: user.bottom - viewport.top,
      summaryTop: currentSummary.getBoundingClientRect().top - viewport.top,
      expanded: currentSummary.getAttribute("aria-expanded"),
      beforeSpace: bench.collectViewportAnchorState().beforeSpacePx,
      afterSpace: bench.collectViewportAnchorState().afterSpacePx,
    };
  };
  summary.click();
  await settle();
  messages.dispatchEvent(new scope.WheelEvent("wheel", { deltaY: 500, bubbles: true }));
  messages.scrollTop = messages.scrollHeight;
  await settle();
  const expanded = measure();
  const control = footer
    ? summary.parentElement.querySelector(toolCount > 1 ? ".tool-timeline-collapse-btn" : ".tool-event-collapse-btn")
    : summary;
  control.click();
  const collapsed = [];
  // Observe the first paint as well as the settled state, without a wheel event.
  for (let index = 0; index < 24; index += 1) {
    await frame();
    collapsed.push(measure());
  }
  bench.dispatchBackgroundEvent(record({
    type: "tool_execution_start", sessionId, runId, eventSeq: 1,
    toolCallId: "next-tool", spanId: "next-tool-span", toolName: "read_article", args: { tabId: 100 },
  }));
  await settle();
  const entries = messages.querySelector(".msg-tool-timeline")?.__toolTimelineGroupEntry?.entries || [];
  return { expanded, collapsed, afterUpdate: measure(), toolCount, nextToolRendered: entries.some(entry => entry.toolCallId === "next-tool") };
}

export function expectToolCollapseVisible(expect, result) {
  expect(result.expanded.scrollTop, "the expanded conversation had a scroll range").toBeGreaterThan(1);
  if (result.toolCount > 1) expect(result.expanded.summaryTop, "the timeline header was sticky").toBeLessThan(2);
  expect(result.nextToolRendered, "the running task added its next tool after collapse").toBe(true);
  for (const sample of [...result.collapsed, result.afterUpdate]) {
    const detail = JSON.stringify(sample);
    expect(sample.expanded, detail).toBe("false");
    expect(Math.abs(sample.scrollTop), detail).toBeLessThan(1);
    expect(sample.overflow, detail).toBeLessThanOrEqual(1);
    expect(sample.userTop, detail).toBeGreaterThanOrEqual(0);
    expect(sample.summaryTop, detail).toBeGreaterThanOrEqual(sample.userBottom);
    expect(sample.beforeSpace, detail).toBe(0);
    expect(sample.afterSpace, detail).toBe(0);
  }
}
