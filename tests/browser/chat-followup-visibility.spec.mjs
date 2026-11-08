import { expect, test } from "./sidepanel-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`steering dequeue border · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 360, height: 640 } });

    for (const focused of [false, true]) {
      for (const count of [1, 2]) {
        test(`keeps the composer border stable when ${count} steering messages leave with focus ${focused}`, async ({ page }) => {
          const result = await page.evaluate(async ({ focused, count }) => {
            const sessionId = "steering_border_session";
            const runId = "benchmark-visual-run";
            const benchmark = window.qingzhouConversationBenchmark;
            await benchmark.runSnapshotRender({ sessionId, transcript: [] });
            benchmark.configureVisualState({ running: true });
            const input = document.querySelector("#input");
            const wrapper = document.querySelector(".input-wrapper");
            if (focused) input.focus();
            else input.blur();
            await new Promise(resolve => setTimeout(resolve, 250));
            const expected = getComputedStyle(wrapper).borderTopColor;
            const items = Array.from({ length: count }, (_, index) => ({
              clientMessageId: `steering-border-${index}`, text: `Steering message ${index + 1}`,
            }));
            benchmark.configureVisualState({ running: true, pendingSteerings: items });
            await new Promise(resolve => setTimeout(resolve, 250));
            benchmark.dispatchBackgroundEvent({
              type: "queue_update", sessionId, runId, eventSeq: 1,
              pendingSteerings: [], pendingFollowUps: [],
            });
            items.forEach((item, index) => benchmark.dispatchBackgroundEvent({
              type: "message_start", sessionId, runId, eventSeq: index + 2,
              clientMessageId: item.clientMessageId,
              message: { role: "user", content: item.text, clientMessageId: item.clientMessageId, _origin: "user" },
            }));
            const colors = new Set();
            const started = performance.now();
            do {
              await new Promise(requestAnimationFrame);
              const style = getComputedStyle(wrapper);
              if (parseFloat(style.borderTopWidth) > 0) colors.add(style.borderTopColor);
            } while (performance.now() - started < 400);
            return {
              expected, colors: [...colors],
              queueHidden: document.querySelector("#queued-followups").classList.contains("hidden"),
              focused: document.activeElement === input,
            };
          }, { focused, count });

          expect(result.queueHidden).toBe(true);
          expect(result.focused).toBe(focused);
          expect(result.colors).toEqual([result.expected]);
        });
      }
    }
  });
}

test.describe("queued follow-up visibility", () => {
  test.use({ viewport: { width: 430, height: 620 } });

  test("keeps an accepted follow-up fully visible above the running status bar", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const sessionId = "followup_visibility_session";
      const runId = "benchmark-visual-run";
      const firstId = "followup-visible-1";
      const transcript = [];
      for (let index = 0; index < 12; index += 1) {
        transcript.push({
          type: "user",
          text: `历史问题 ${index + 1}`,
          clientMessageId: `history-user-${index + 1}`,
        });
        transcript.push({
          type: "assistant",
          content: `历史回答 ${index + 1}：${"用于制造可滚动对话。".repeat(3)}`,
          spanId: `history-assistant-${index + 1}`,
          runId: `history-run-${index + 1}`,
        });
      }

      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId,
        title: "连续消息可见性",
        transcript,
      });
      window.qingzhouConversationBenchmark.configureVisualState({
        running: true,
        pendingFollowUps: [
          { clientMessageId: firstId, text: "第一条连续发送的新消息" },
        ],
      });
      await frames(3);

      const messagesBefore = document.querySelector("#messages");
      messagesBefore.dispatchEvent(new WheelEvent("wheel", { deltaY: -180, bubbles: true, cancelable: true }));
      messagesBefore.scrollTop = Math.max(0, messagesBefore.scrollTop - 180);
      messagesBefore.dispatchEvent(new Event("scroll"));
      await frames(2);

      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "message_start",
        sessionId,
        runId,
        eventSeq: 1,
        clientMessageId: firstId,
        message: {
          role: "user",
          content: "第一条连续发送的新消息",
          clientMessageId: firstId,
          _origin: "user",
        },
      });
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "thinking_update",
        sessionId,
        runId,
        eventSeq: 2,
        thinking: "正在处理第一条连续消息。",
      });
      await frames(5);

      const messages = document.querySelector("#messages");
      const status = document.querySelector("#status-bar");
      const bubble = document.querySelector(`[data-transcript-key="${sessionId}:user:${firstId}"]`);
      const messagesRect = messages?.getBoundingClientRect();
      const statusRect = status?.getBoundingClientRect();
      const bubbleRect = bubble?.getBoundingClientRect();
      return {
        bubbleFound: Boolean(bubble),
        statusVisible: Boolean(status && !status.classList.contains("hidden")),
        messagesBottom: messagesRect?.bottom ?? null,
        statusTop: statusRect?.top ?? null,
        bubbleTop: bubbleRect?.top ?? null,
        bubbleBottom: bubbleRect?.bottom ?? null,
        bubbleHeight: bubbleRect?.height ?? null,
        scrollTop: messages?.scrollTop ?? null,
        scrollHeight: messages?.scrollHeight ?? null,
        clientHeight: messages?.clientHeight ?? null,
        bottomGap: messages ? messages.scrollHeight - messages.scrollTop - messages.clientHeight : null,
        pendingCount: document.querySelectorAll("#queued-followups .queued-followup").length,
      };

      function frames(count) {
        return new Promise(resolve => {
          const step = remaining => requestAnimationFrame(() => (
            remaining <= 1 ? resolve() : step(remaining - 1)
          ));
          step(Math.max(1, count));
        });
      }
    });

    expect(result.bubbleFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.statusVisible, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.pendingCount, JSON.stringify(result, null, 2)).toBe(0);
    expect(result.statusTop, JSON.stringify(result, null, 2)).toBeGreaterThanOrEqual(result.messagesBottom - 0.5);
    expect(result.bubbleTop, JSON.stringify(result, null, 2)).toBeGreaterThanOrEqual(0);
    expect(result.bubbleBottom, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(result.messagesBottom - 1);
  });

  test("queued sends resume the live tail after an interaction anchor", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const sessionId = "queued_send_tail_session";
      const runId = "queued-send-tail-run";
      const transcript = [];
      for (let index = 0; index < 12; index += 1) {
        transcript.push({
          type: "user",
          text: `历史问题 ${index + 1}`,
          clientMessageId: `queued-send-history-user-${index + 1}`,
        });
        transcript.push({
          type: "assistant",
          content: `历史回答 ${index + 1}：${"用于制造可滚动对话。".repeat(3)}`,
          spanId: `queued-send-history-assistant-${index + 1}`,
          runId: `queued-send-history-run-${index + 1}`,
        });
      }
      transcript.push({
        type: "tool",
        toolCallId: "queued-send-run-script-tool",
        runId,
        name: "run_script",
        args: {
          code: Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`).join("\n"),
        },
        result: { ok: true, result: { count: 20 } },
        phase: "done",
        isRunning: false,
        isError: false,
      });

      await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId, transcript });
      window.qingzhouConversationBenchmark.configureVisualState({ running: true });
      window.__qzPromptAcceptance = { disposition: "queued", duplicate: false };
      await frames(3);

      const messages = document.querySelector("#messages");
      messages.scrollTop = messages.scrollHeight;
      await frames(2);
      const summary = document.querySelector(
        ".msg-tool > .tool-summary, .msg-tool-timeline > .tool-timeline-summary",
      );
      summary?.click();
      await frames(6);
      const anchored = window.qingzhouConversationBenchmark.collectViewportAnchorState?.() || null;

      const input = document.querySelector("#input");
      const send = async text => {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#btn-send")?.click();
        await frames(4);
      };
      await send("连续排队消息一");
      await send("连续排队消息二");
      await send("连续排队消息三");

      const finalAnchor = window.qingzhouConversationBenchmark.collectViewportAnchorState?.() || null;
      return {
        summaryFound: Boolean(summary),
        anchored,
        finalAnchor,
        pendingCount: document.querySelectorAll("#queued-followups .queued-followup").length,
        bottomGap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        clientHeight: messages.clientHeight,
      };

      function frames(count) {
        return new Promise(resolve => {
          const step = remaining => requestAnimationFrame(() => (
            remaining <= 1 ? resolve() : step(remaining - 1)
          ));
          step(Math.max(1, count));
        });
      }
    });

    expect(result.summaryFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.anchored?.active, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.pendingCount, JSON.stringify(result, null, 2)).toBe(3);
    expect(result.finalAnchor?.active, JSON.stringify(result, null, 2)).toBe(false);
    expect(result.bottomGap, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(28);
  });

  test("moves a follow-up into the shared steering-first queue", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const sessionId = "steering_queue_session";
      const runId = "steering-queue-run";
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId,
        title: "引导队列",
        transcript: [{ type: "assistant", content: "正在执行原任务。", runId }],
      });
      window.qingzhouConversationBenchmark.configureVisualState({
        running: true,
        pendingSteerings: [
          { clientMessageId: "steering-existing", text: "先检查当前页面" },
        ],
        pendingFollowUps: [
          { clientMessageId: "followup-a", text: "完成后整理结果，并保留页面、网络请求和脚本执行过程中用到的全部证据，最后再按来源分组" },
          { clientMessageId: "followup-b", text: "改为优先查看网络请求" },
        ],
      });
      await frames(3);

      const before = rows();
      document.querySelector('[data-steer-follow-up="followup-b"]')?.click();
      await frames(5);
      const after = rows();
      const queue = document.querySelector("#queued-followups");
      const steeringRow = queue?.querySelector('[data-client-message-id="followup-b"]');
      const ordinaryRow = queue?.querySelector('[data-client-message-id="followup-a"]');
      const steeringStyle = steeringRow ? getComputedStyle(steeringRow) : null;
      const ordinaryStyle = ordinaryRow ? getComputedStyle(ordinaryRow) : null;
      const steeringBackground = steeringStyle?.backgroundColor || "";
      const ordinaryBackground = ordinaryStyle?.backgroundColor || "";
      const steeringColor = steeringStyle?.color || "";
      const ordinaryColor = ordinaryStyle?.color || "";
      const ordinaryText = ordinaryRow?.querySelector(".queued-followup-text");
      const longTextClipped = Boolean(ordinaryText && ordinaryText.scrollWidth > ordinaryText.clientWidth);
      const ordinaryMetaWidth = ordinaryRow?.querySelector(".queued-followup-meta")?.getBoundingClientRect().width || 0;
      const steeringMeta = steeringRow?.querySelector(".queued-followup-meta");
      const steeringState = steeringRow?.querySelector(".queued-followup-steering-state");
      const ordinarySteer = ordinaryRow?.querySelector(".queued-followup-steer");
      const ordinarySteerLabel = ordinarySteer?.querySelector("span");
      const steeringMetaRect = steeringMeta?.getBoundingClientRect();
      const steeringStateRect = steeringState?.getBoundingClientRect();
      const ordinarySteerRect = ordinarySteer?.getBoundingClientRect();
      const steeringRowRect = steeringRow?.getBoundingClientRect();
      const ordinaryRowRect = ordinaryRow?.getBoundingClientRect();
      const steeringMetaTextRect = textRect(steeringMeta);
      const ordinarySteerTextRect = textRect(ordinarySteerLabel);
      const posted = (window.__qzPostedMessages || []).find(message => (
        message.type === "steer_follow_up" && message.clientMessageId === "followup-b"
      ));
      const rowBounds = [...(queue?.querySelectorAll(".queued-followup") || [])].map(row => {
        const rect = row.getBoundingClientRect();
        return { left: rect.left, right: rect.right, kind: row.dataset.queueKind };
      });

      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "message_start",
        sessionId,
        runId,
        eventSeq: 1,
        clientMessageId: "followup-b",
        message: {
          role: "user",
          content: "改为优先查看网络请求",
          clientMessageId: "followup-b",
          _origin: "user",
        },
      });
      await frames(5);
      const settled = rows();
      const acceptedBubble = document.querySelector(
        `[data-transcript-key="${sessionId}:user:followup-b"]`,
      );

      return {
        before,
        after,
        settled,
        posted,
        steeringMeta: steeringRow?.querySelector(".queued-followup-meta")?.textContent || "",
        steeringHasAction: Boolean(steeringRow?.querySelector("[data-steer-follow-up]")),
        steeringStateWidth: steeringStateRect?.width || 0,
        steeringMetaCenterDelta: rectCenterDelta(steeringMetaRect, steeringStateRect),
        steeringStateRowCenterDelta: rectCenterDelta(steeringStateRect, steeringRowRect),
        steeringActionRowCenterDelta: rectCenterDelta(ordinarySteerRect, ordinaryRowRect),
        steeringLabelLeftDelta: Math.abs((steeringMetaTextRect?.left || 0) - (ordinarySteerTextRect?.left || 0)),
        deleteClass: ordinaryRow?.querySelector(".queued-followup-delete")?.className || "",
        longTextClipped,
        ordinaryMetaWidth,
        differentBackground: steeringBackground !== ordinaryBackground,
        differentColor: steeringColor !== ordinaryColor,
        queueClientWidth: queue?.clientWidth || 0,
        queueScrollWidth: queue?.scrollWidth || 0,
        rowBounds,
        queueBounds: queue ? {
          left: queue.getBoundingClientRect().left,
          right: queue.getBoundingClientRect().right,
        } : null,
        acceptedBubble: Boolean(acceptedBubble),
      };

      function rows() {
        return [...document.querySelectorAll("#queued-followups .queued-followup")].map(row => ({
          id: row.dataset.clientMessageId,
          kind: row.dataset.queueKind,
          sameParent: row.parentElement?.id === "queued-followups",
        }));
      }

      function textRect(element) {
        if (!element?.firstChild) return null;
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      }

      function rectCenterDelta(left, right) {
        if (!left || !right) return Number.POSITIVE_INFINITY;
        return Math.abs((left.top + left.height / 2) - (right.top + right.height / 2));
      }

      function frames(count) {
        return new Promise(resolve => {
          const step = remaining => requestAnimationFrame(() => (
            remaining <= 1 ? resolve() : step(remaining - 1)
          ));
          step(Math.max(1, count));
        });
      }
    });

    expect(result.before, JSON.stringify(result, null, 2)).toEqual([
      { id: "steering-existing", kind: "steering", sameParent: true },
      { id: "followup-a", kind: "followup", sameParent: true },
      { id: "followup-b", kind: "followup", sameParent: true },
    ]);
    expect(result.after, JSON.stringify(result, null, 2)).toEqual([
      { id: "steering-existing", kind: "steering", sameParent: true },
      { id: "followup-b", kind: "steering", sameParent: true },
      { id: "followup-a", kind: "followup", sameParent: true },
    ]);
    expect(result.posted?.sessionId, JSON.stringify(result, null, 2)).toBe("steering_queue_session");
    expect(result.steeringMeta, JSON.stringify(result, null, 2)).toBe("引导");
    expect(result.steeringHasAction, JSON.stringify(result, null, 2)).toBe(false);
    expect(result.steeringStateWidth, JSON.stringify(result, null, 2)).toBe(50);
    expect(result.steeringMetaCenterDelta, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(0.5);
    expect(result.steeringStateRowCenterDelta, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(0.5);
    expect(result.steeringActionRowCenterDelta, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(0.5);
    expect(result.steeringLabelLeftDelta, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(1);
    expect(result.deleteClass, JSON.stringify(result, null, 2)).not.toContain("danger");
    expect(result.longTextClipped, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.ordinaryMetaWidth, JSON.stringify(result, null, 2)).toBeGreaterThan(0);
    expect(result.differentBackground, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.differentColor, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.queueScrollWidth, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(result.queueClientWidth + 1);
    expect(result.rowBounds.every(rect => (
      rect.left >= result.queueBounds.left - 0.5 && rect.right <= result.queueBounds.right + 0.5
    )), JSON.stringify(result, null, 2)).toBe(true);
    expect(result.settled.some(row => row.id === "followup-b"), JSON.stringify(result, null, 2)).toBe(false);
    expect(result.acceptedBubble, JSON.stringify(result, null, 2)).toBe(true);
  });

  test("dequeues a steering batch as one queue motion and separate ordered bubbles", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const result = await page.evaluate(async () => {
      const sessionId = "steering_batch_queue_session";
      const runId = "benchmark-visual-run";
      const steeringItems = [
        { clientMessageId: "steering-batch-a", text: "先确认安全边界，再读取最新页面状态" },
        { clientMessageId: "steering-batch-b", text: "接着查看失败请求，并保留原任务的执行上下文" },
      ];
      const followUp = {
        clientMessageId: "followup-after-batch",
        text: "当前任务完成后，把页面结构、接口响应和脚本结果整理成一份可以继续复查的长报告",
      };
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId,
        title: "批量引导出队",
        transcript: [{ type: "assistant", content: "正在执行原任务。", runId }],
      });
      window.qingzhouConversationBenchmark.configureVisualState({
        running: true,
        pendingSteerings: steeringItems,
        pendingFollowUps: [followUp],
      });
      await frames(3);

      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "queue_update",
        sessionId,
        runId,
        eventSeq: 1,
        pendingSteerings: [],
        pendingFollowUps: [followUp],
      });

      const batchGhost = document.querySelector(".queued-followup-batch-exit-ghost");
      const dequeueSnapshot = {
        batchGhostCount: document.querySelectorAll(".queued-followup-batch-exit-ghost").length,
        batchSize: batchGhost?.dataset.batchSize || "",
        batchRows: batchGhost?.querySelectorAll(".queued-followup-batch-exit-row").length || 0,
        individualGhostCount: document.querySelectorAll(".queued-followup-exit-ghost").length,
        remainingQueueIds: queueIds(),
      };

      steeringItems.forEach((item, index) => {
        window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
          type: "message_start",
          sessionId,
          runId,
          eventSeq: index + 2,
          clientMessageId: item.clientMessageId,
          message: {
            role: "user",
            content: item.text,
            clientMessageId: item.clientMessageId,
            _origin: "user",
          },
        });
      });
      await frames(5);

      const bubbleNodes = [...document.querySelectorAll(
        `[data-transcript-key^="${sessionId}:user:steering-batch-"]`,
      )];
      const followUpRow = document.querySelector('[data-client-message-id="followup-after-batch"]');
      const followUpText = followUpRow?.querySelector(".queued-followup-text");
      const followUpMeta = followUpRow?.querySelector(".queued-followup-meta");
      const queue = document.querySelector("#queued-followups");
      const bubbleSnapshot = {
        ids: bubbleNodes.map(node => node.dataset.clientMessageId),
        batchAnimationCount: bubbleNodes.filter(node => node.classList.contains("msg-user-steering-batch-enter")).length,
        distinctBubbleCount: bubbleNodes.filter(node => node.querySelector(".msg-content")).length,
        queueIds: queueIds(),
        longTextClipped: Boolean(followUpText && followUpText.scrollWidth > followUpText.clientWidth),
        metaVisible: Boolean(followUpMeta && followUpMeta.getBoundingClientRect().width > 0),
        queueClientWidth: queue?.clientWidth || 0,
        queueScrollWidth: queue?.scrollWidth || 0,
      };
      await new Promise(resolve => setTimeout(resolve, 220));
      return {
        dequeueSnapshot,
        bubbleSnapshot,
        ghostCountAfterMotion: document.querySelectorAll(".queued-followup-batch-exit-ghost").length,
      };

      function queueIds() {
        return [...document.querySelectorAll("#queued-followups .queued-followup")]
          .map(row => row.dataset.clientMessageId);
      }

      function frames(count) {
        return new Promise(resolve => {
          const step = remaining => requestAnimationFrame(() => (
            remaining <= 1 ? resolve() : step(remaining - 1)
          ));
          step(Math.max(1, count));
        });
      }
    });

    expect(result.dequeueSnapshot, JSON.stringify(result, null, 2)).toEqual({
      batchGhostCount: 1,
      batchSize: "2",
      batchRows: 2,
      individualGhostCount: 0,
      remainingQueueIds: ["followup-after-batch"],
    });
    expect(result.bubbleSnapshot.ids, JSON.stringify(result, null, 2)).toEqual([
      "steering-batch-a",
      "steering-batch-b",
    ]);
    expect(result.bubbleSnapshot.batchAnimationCount, JSON.stringify(result, null, 2)).toBe(2);
    expect(result.bubbleSnapshot.distinctBubbleCount, JSON.stringify(result, null, 2)).toBe(2);
    expect(result.bubbleSnapshot.queueIds, JSON.stringify(result, null, 2)).toEqual(["followup-after-batch"]);
    expect(result.bubbleSnapshot.longTextClipped, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.bubbleSnapshot.metaVisible, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.bubbleSnapshot.queueScrollWidth, JSON.stringify(result, null, 2))
      .toBeLessThanOrEqual(result.bubbleSnapshot.queueClientWidth + 1);
    expect(result.ghostCountAfterMotion, JSON.stringify(result, null, 2)).toBe(0);
  });
});
