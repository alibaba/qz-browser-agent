import { expect, test } from "./sidepanel-fixtures.mjs";
import { expectToolCollapseVisible, runToolCollapseProbe } from "../support/tool-collapse-probe.mjs";

test.describe("short conversation collapse", () => {
  test.use({ viewport: { width: 400, height: 600 } });
  for (const toolCount of [1, 45]) {
    for (const footer of [false, true]) {
      test(`${toolCount} tools collapsed from ${footer ? "footer" : "summary"} reveal the first message before scrolling`, async ({ page }) => {
        expectToolCollapseVisible(expect, await page.evaluate(runToolCollapseProbe, { toolCount, footer }));
      });
    }
  }
});

test.describe("completed tool card scroll stability", () => {
  test.use({ viewport: { width: 430, height: 844 } });

  test("keeps transcript identity and nested scroll when a canonical snapshot reorders entries", async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const toolContent = JSON.stringify({
        name: "scroll-probe",
        tools: Array.from({ length: 28 }, (_, index) => ({
          name: `probe_${index + 1}`,
          description: `canonical snapshot scroll probe ${index + 1}`,
        })),
      }, null, 2);
      const legacyNotes = Array.from({ length: 12 }, (_, index) => ({
        type: "note",
        text: `legacy note without protocol identity ${index + 1}`,
      }));
      const resourceTool = createSkillResourceTool("snapshot_scroll_probe_tool", toolContent);
      const finalAssistant = {
        type: "assistant",
        content: "检查完成。",
        spanId: "snapshot_scroll_probe_assistant",
        runId: "snapshot_scroll_probe_run",
      };
      const transcript = [
        {
          type: "user",
          text: "检查 canonical snapshot 的滚动稳定性。",
          clientMessageId: "snapshot_scroll_probe_user",
        },
        ...legacyNotes,
        resourceTool,
        finalAssistant,
      ];
      window.__scrollProbeCanonicalSnapshot = [
        transcript[0],
        resourceTool,
        ...legacyNotes,
        finalAssistant,
      ];
      const metrics = await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "snapshot_scroll_probe_session",
        title: "Canonical snapshot 滚动稳定性",
        transcript,
      });
      return {
        metrics,
        keys: Array.from(document.querySelectorAll("#messages [data-transcript-key]"), item => item.dataset.transcriptKey),
      };

      function createSkillResourceTool(toolCallId, content) {
        return {
          type: "tool",
          toolCallId,
          runId: "completed_scroll_probe_run",
          name: "qingzhou_skill_author__edit_skill_resource",
          capabilityId: "qingzhou_skill_author__edit_skill_resource",
          title: "编辑技能资源",
          familyId: "plugin:meta",
          args: {
            name: "scroll-probe",
            path: "plugin.json",
            action: "set",
            type: "json",
            content,
          },
          result: {
            ok: true,
            name: "scroll-probe",
            path: "plugin.json",
            type: "json",
            content,
            _plugin: {
              id: "qingzhou-skill-author",
              tool: "qingzhou_skill_author__edit_skill_resource",
              capabilityId: "qingzhou_skill_author__edit_skill_resource",
              localName: "edit_skill_resource",
              title: "编辑技能资源",
              familyId: "plugin:meta",
              renderer: { type: "skill", action: "edit_resource" },
            },
          },
          phase: "done",
          isRunning: false,
          isError: false,
        };
      }
    });

    const tool = page.locator('[data-transcript-key="snapshot_scroll_probe_session:tool:completed_scroll_probe_run:snapshot_scroll_probe_tool"]');
    await expect(tool, JSON.stringify(setup, null, 2)).toBeVisible();
    await tool.locator(":scope > .tool-summary").click();
    const editor = tool.locator(".tool-skill-resource-code");
    await expect(editor).toBeVisible();

    const before = await editor.evaluate((node) => {
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(1, Math.round(max * 0.43));
      node.dispatchEvent(new Event("scroll"));
      const toolRoot = node.closest("[data-transcript-key]");
      const messages = toolRoot.closest("#messages");
      window.__scrollProbeEditor = node;
      window.__scrollProbeToolRoot = toolRoot;
      window.__scrollProbeResourceMoves = 0;
      const observer = new MutationObserver(records => {
        for (const record of records) {
          const nodes = [...record.addedNodes, ...record.removedNodes];
          if (nodes.includes(window.__scrollProbeToolRoot)) window.__scrollProbeResourceMoves += 1;
        }
      });
      observer.observe(messages, { childList: true });
      window.__scrollProbeMessagesObserver = observer;
      return {
        top: node.scrollTop,
        max,
        fallbackKeys: Array.from(messages.querySelectorAll(".msg-note[data-transcript-key]"), item => item.dataset.transcriptKey),
      };
    });
    expect(before.max).toBeGreaterThan(20);

    await page.evaluate(() => {
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "messages",
        sessionId: "snapshot_scroll_probe_session",
        transcript: structuredClone(window.__scrollProbeCanonicalSnapshot),
        save: false,
      });
    });
    await page.waitForTimeout(180);

    const after = await editor.evaluate((node) => {
      const messages = node.closest("#messages");
      window.__scrollProbeMessagesObserver?.disconnect();
      return {
        top: node.scrollTop,
        sameNode: node === window.__scrollProbeEditor,
        resourceMoves: window.__scrollProbeResourceMoves,
        fallbackKeys: Array.from(messages.querySelectorAll(".msg-note[data-transcript-key]"), item => item.dataset.transcriptKey),
      };
    });

    expect(after, JSON.stringify({ before, after }, null, 2)).toMatchObject({
      top: before.top,
      sameNode: true,
    });
    expect(after.resourceMoves).toBeGreaterThan(0);
    expect(before.fallbackKeys).toHaveLength(12);
    expect(after.fallbackKeys).toEqual(before.fallbackKeys);
  });

  test("keeps a completed skill resource editor stable while a later turn streams", async ({ page }) => {
    await page.evaluate(() => {
      const toolContent = JSON.stringify({
        format: "qingzhou.plugin",
        schemaVersion: 1,
        id: "scroll-probe",
        displayName: "滚动稳定性探针",
        tools: Array.from({ length: 28 }, (_, index) => ({
          name: `probe_${index + 1}`,
          title: `探针工具 ${index + 1}`,
          description: `用于验证已完成资源卡片在后续流式期间不会重置滚动位置 ${index + 1}`,
          script: `scripts/probe-${index + 1}.js`,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: `检索条件 ${index + 1}` },
            },
          },
        })),
      }, null, 2);
      const thinkingUpdates = Array.from({ length: 28 }, (_, index) => ({
        type: "thinking_update",
        runId: "later_scroll_probe_run",
        thinking: Array.from({ length: index + 1 }, (_item, line) => `后续思考区块 ${line + 1}`).join("\n\n"),
      }));
      const messageUpdates = Array.from({ length: 12 }, (_, index) => ({
        type: "message_update",
        runId: "later_scroll_probe_run",
        spanId: "later_scroll_probe_assistant",
        content: Array.from({ length: index + 1 }, (_item, line) => `后续流式区块 ${line + 1}`).join("\n\n"),
      }));
      const fixture = {
        sessionId: "scroll_probe_session",
        title: "技能资源滚动稳定性",
        baseTranscript: [
          {
            type: "user",
            text: "创建并写入 plugin.json。",
            clientMessageId: "scroll_probe_user",
          },
          {
            type: "tool",
            _uiKey: "skill_resource_probe_tool",
            toolCallId: "skill_resource_probe_tool",
            runId: "completed_scroll_probe_run",
            name: "qingzhou_skill_author__edit_skill_resource",
            capabilityId: "qingzhou_skill_author__edit_skill_resource",
            title: "编辑技能资源",
            familyId: "plugin:meta",
            args: {
              name: "scroll-probe",
              path: "plugin.json",
              action: "set",
              type: "json",
              description: "验证完成态技能资源卡的内部滚动位置。",
              content: toolContent,
            },
            result: {
              ok: true,
              name: "scroll-probe",
              path: "plugin.json",
              type: "json",
              content: toolContent,
              _plugin: {
                id: "qingzhou-skill-author",
                name: "技能工作台",
                displayName: "技能工作台",
                tool: "qingzhou_skill_author__edit_skill_resource",
                capabilityId: "qingzhou_skill_author__edit_skill_resource",
                localName: "edit_skill_resource",
                title: "编辑技能资源",
                familyId: "plugin:meta",
                resultFamily: "generic",
                labelerId: "static",
                renderer: { type: "skill", action: "edit_resource" },
              },
            },
            phase: "done",
            isRunning: false,
            isError: false,
          },
          {
            type: "assistant",
            content: "plugin.json 已写入。",
            spanId: "completed_scroll_probe_assistant",
            runId: "completed_scroll_probe_run",
          },
        ],
        events: [
          {
            type: "message_start",
            runId: "later_scroll_probe_run",
            clientMessageId: "later_scroll_probe_user",
            message: { role: "user", content: "继续检查这个技能。" },
          },
          ...thinkingUpdates,
          {
            type: "message_start",
            runId: "later_scroll_probe_run",
            spanId: "later_scroll_probe_assistant",
            message: { role: "assistant", content: "" },
          },
          ...messageUpdates,
          {
            type: "message_end",
            runId: "later_scroll_probe_run",
            spanId: "later_scroll_probe_assistant",
            message: { role: "assistant", content: messageUpdates.at(-1).content },
          },
        ],
      };
      window.__scrollProbeRun = window.qingzhouConversationBenchmark.runLiveReplay(fixture, {
        eventDelayMs: 36,
        framePerEvent: true,
      });
    });

    const tool = page.locator('[data-transcript-key="skill_resource_probe_tool"]');
    await expect(tool).toBeVisible();
    await tool.locator(":scope > .tool-summary").click();
    const editor = tool.locator(".tool-skill-resource-code");
    await expect(editor).toBeVisible();

    const initialized = await editor.evaluate((node) => {
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.max(1, Math.round(max * 0.43));
      node.dispatchEvent(new Event("scroll"));
      window.__scrollProbeEditor = node;
      window.__scrollProbeInitialTop = node.scrollTop;
      window.__scrollProbeMutations = 0;
      const observer = new MutationObserver(items => {
        window.__scrollProbeMutations += items.length;
      });
      observer.observe(node.closest(".tool-details"), {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      window.__scrollProbeObserver = observer;
      return {
        top: node.scrollTop,
        max,
        scrollable: max > 20,
      };
    });
    expect(initialized.scrollable).toBe(true);

    const samples = [];
    while (await page.evaluate(() => Boolean(window.__scrollProbeRun))) {
      samples.push(await page.evaluate(() => {
        const current = document.querySelector('[data-transcript-key="skill_resource_probe_tool"] .tool-skill-resource-code');
        return {
          top: current?.scrollTop ?? null,
          sameNode: current === window.__scrollProbeEditor,
          mutations: window.__scrollProbeMutations || 0,
        };
      }));
      const done = await page.evaluate(async () => {
        const run = window.__scrollProbeRun;
        if (!run) return true;
        const settled = await Promise.race([
          run.then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 20)),
        ]);
        if (settled) window.__scrollProbeRun = null;
        return settled;
      });
      if (done) break;
    }

    const final = await page.evaluate(() => {
      const current = document.querySelector('[data-transcript-key="skill_resource_probe_tool"] .tool-skill-resource-code');
      window.__scrollProbeObserver?.disconnect();
      return {
        initialTop: window.__scrollProbeInitialTop,
        top: current?.scrollTop ?? null,
        sameNode: current === window.__scrollProbeEditor,
        mutations: window.__scrollProbeMutations || 0,
      };
    });

    expect(samples.length).toBeGreaterThan(5);
    expect(final, JSON.stringify({ initialized, samples, final }, null, 2)).toMatchObject({
      top: initialized.top,
      sameNode: true,
      mutations: 0,
    });
  });

  test("keeps following a streaming run script after the user returns its inner scroller to the tail", async ({ page }) => {
    await page.evaluate(async () => {
      const sessionId = "run_script_tail_resume_session";
      const runId = "run_script_tail_resume_run";
      const toolCallId = "run_script_tail_resume_tool";
      const code = Array.from({ length: 520 }, (_, index) => (
        `const streamedValue${index} = rows.map((item) => item.score + ${index});`
      )).join("\n");
      const argsText = JSON.stringify({ target: "inner", timeout: 30, code });
      let length = 2400;
      let eventSeq = 1;
      const update = () => ({
        type: "tool_call_update",
        toolCallId,
        spanId: `span-${toolCallId}`,
        toolName: "run_script",
        argsText: argsText.slice(0, length),
        argsComplete: length >= argsText.length,
        phase: "preparing",
      });
      // Advance the stream with each assertion instead of racing a long replay
      // against wall-clock time on busy Linux/macOS workers.
      window.__advanceRunScriptTail = (finish = false) => {
        length = finish ? argsText.length : Math.min(argsText.length, length + 1000);
        window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ sessionId, runId, eventSeq: eventSeq++, ...update() });
        if (finish) window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
          sessionId, runId, eventSeq: eventSeq++, type: "tool_execution_start",
          toolCallId, spanId: `span-${toolCallId}`, toolName: "run_script",
          args: { target: "inner", timeout: 30, code },
        });
      };
      await window.qingzhouConversationBenchmark.runLiveReplay({
        sessionId,
        baseTranscript: Array.from({ length: 8 }, (_, index) => ({
          type: "assistant",
          runId: `history-${index}`,
          spanId: `history-${index}`,
          content: `历史消息 ${index + 1}：用于保证外层对话拥有独立滚动范围。`.repeat(3),
        })),
        events: [update()],
      }, {
        runId,
        framePerEvent: true,
      });
    });

    const tool = page.locator('[data-transcript-key$=":tool:run_script_tail_resume_run:run_script_tail_resume_tool"]');
    await expect(tool).toBeVisible();
    await tool.locator(":scope > .tool-summary").click();
    const code = tool.locator(".js-code-block");
    await expect(code).toBeVisible();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-transcript-key$=":tool:run_script_tail_resume_run:run_script_tail_resume_tool"] .js-code-block');
      return Boolean(node && node.scrollHeight - node.clientHeight > 160 && node.dataset.followTail === "true");
    });

    await code.hover();
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-transcript-key$=":tool:run_script_tail_resume_run:run_script_tail_resume_tool"] .js-code-block');
      return node?.dataset.followTail === "false" && node.scrollHeight - node.scrollTop - node.clientHeight > 80;
    });
    const paused = await code.evaluate(node => ({
      top: node.scrollTop,
      height: node.scrollHeight,
      gap: node.scrollHeight - node.scrollTop - node.clientHeight,
      following: node.dataset.followTail,
    }));
    const whilePaused = await code.evaluate(async node => {
      window.__advanceRunScriptTail();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { top: node.scrollTop, height: node.scrollHeight, following: node.dataset.followTail };
    });
    expect(whilePaused).toMatchObject({ top: paused.top, following: "false" });
    expect(whilePaused.height).toBeGreaterThan(paused.height);

    // Let the preceding automatic tail movement's grace window expire, then
    // model dragging the native scrollbar thumb back to the very bottom.
    await page.waitForTimeout(180);
    await code.evaluate(node => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-transcript-key$=":tool:run_script_tail_resume_run:run_script_tail_resume_tool"] .js-code-block');
      return Boolean(node && node.scrollHeight - node.scrollTop - node.clientHeight <= 28 && node.dataset.followTail === "true");
    });

    // One more downward wheel crosses the inner boundary and is handed to Chat.
    // It must not undo the explicit decision to resume the live inner tail.
    await page.mouse.wheel(0, 160);
    const resumedSamples = [];
    for (let index = 0; index < 28; index += 1) {
      resumedSamples.push(await code.evaluate(async node => {
        window.__advanceRunScriptTail();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          height: node.scrollHeight,
          gap: node.scrollHeight - node.scrollTop - node.clientHeight,
          following: node.dataset.followTail,
        };
      }));
    }

    expect(paused.following).toBe("false");
    expect(resumedSamples.length).toBeGreaterThan(20);
    expect(
      resumedSamples.every(sample => sample.following === "true" && sample.gap <= 28),
      JSON.stringify({ paused, resumedSamples }, null, 2),
    ).toBe(true);
    expect(resumedSamples.at(-1).height).toBeGreaterThan(resumedSamples[0].height);
    await page.evaluate(() => {
      window.__advanceRunScriptTail(true);
      delete window.__advanceRunScriptTail;
    });
  });

  test("does not paint a run script jump when goal-driven thinking resumes", async ({ page }) => {
    await page.evaluate(async () => {
      const code = Array.from({ length: 26 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const rows = Array.from({ length: 18 }, (_, index) => ({ index, title: `record-${index}` }));
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "goal_strip_scroll_probe",
        transcript: [
          { type: "user", text: "执行脚本并继续回答。", clientMessageId: "goal_strip_scroll_probe_user" },
          {
            type: "tool",
            toolCallId: "goal_strip_scroll_probe_tool",
            runId: "benchmark-visual-run",
            name: "run_script",
            args: { target: "inner", code },
            result: { ok: true, result: rows },
            phase: "done",
            isRunning: false,
            isError: false,
          },
        ],
      });
      window.qingzhouConversationBenchmark.configureVisualState({ running: true });
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "goal_update",
        sessionId: "goal_strip_scroll_probe",
        runId: "benchmark-visual-run",
        eventSeq: 1,
        goal: {
          status: "active",
          objective: "完成页面采集并汇总结果",
          version: 1,
        },
      });
    });

    await expect(page.locator("#goal-strip")).toBeVisible();
    const tool = page.locator(".msg-tool");
    const summary = tool.locator(":scope > .tool-summary");
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(tool.locator(":scope > .tool-details")).toBeVisible();
    await page.waitForTimeout(100);

    const before = await tool.evaluate((node) => {
      const messagesEl = node.closest("#messages");
      window.__goalStripProbeTool = node;
      window.__goalStripProbeDetails = node.querySelector(":scope > .tool-details");
      return {
        top: node.getBoundingClientRect().top,
        scrollHeight: messagesEl.scrollHeight,
        clientHeight: messagesEl.clientHeight,
      };
    });
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

    await page.evaluate(() => {
      window.__goalStripProbeSamples = [];
      const sample = () => {
        const node = window.__goalStripProbeTool;
        window.__goalStripProbeSamples.push(node?.getBoundingClientRect().top ?? null);
        if (window.__goalStripProbeSamples.length < 8) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "thinking_update",
        sessionId: "goal_strip_scroll_probe",
        runId: "benchmark-visual-run",
        eventSeq: 2,
        thinking: "继续检查脚本结果，并整理最终结论。",
      });
    });
    await expect(page.locator(".msg-thinking-group")).toBeVisible();
    await page.waitForFunction(() => window.__goalStripProbeSamples?.length === 8);

    const afterThinking = await tool.evaluate((node) => {
      const messagesEl = node.closest("#messages");
      const thinking = messagesEl.querySelector(".msg-thinking-group");
      return {
        top: node.getBoundingClientRect().top,
        scrollHeight: messagesEl.scrollHeight,
        frameTops: window.__goalStripProbeSamples,
        sameTool: node === window.__goalStripProbeTool,
        sameDetails: node.querySelector(":scope > .tool-details") === window.__goalStripProbeDetails,
        thinkingBeforeTool: Boolean(thinking && (thinking.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    });
    expect(afterThinking.scrollHeight).toBeGreaterThan(before.scrollHeight);
    expect(afterThinking.top).toBeCloseTo(before.top, 1);
    expect(afterThinking.frameTops.every(top => Math.abs(top - before.top) < 0.5), afterThinking.frameTops).toBe(true);
    expect(afterThinking).toMatchObject({
      sameTool: true,
      sameDetails: true,
      thinkingBeforeTool: true,
    });
  });

  test("honors a direct user scroll during the interaction stabilization window", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const sessionId = "viewport_user_scroll_probe";
      const runId = "viewport_user_scroll_run";
      const code = Array.from({ length: 44 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const rows = Array.from({ length: 30 }, (_, index) => ({ index, value: `row-${index}` }));
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId,
        transcript: [
          { type: "user", text: "执行脚本并继续分析。", clientMessageId: "viewport_user_scroll_user" },
          {
            type: "tool",
            toolCallId: "viewport_user_scroll_tool",
            runId,
            name: "run_script",
            args: { target: "inner", code },
            result: { ok: true, result: rows },
            phase: "done",
            isRunning: false,
            isError: false,
          },
        ],
      });
      window.qingzhouConversationBenchmark.configureVisualState({ running: true });

      const messages = document.querySelector("#messages");
      const summary = messages.querySelector(".msg-tool > .tool-summary");
      summary.click();
      await nextFrame();
      await nextFrame();
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "thinking_update",
        sessionId,
        runId,
        eventSeq: 1,
        thinking: Array.from({ length: 12 }, (_, index) => `新增思考 ${index + 1}`).join("\n\n"),
      });
      for (let frame = 0; frame < 6 && !document.querySelector(".msg-thinking-group"); frame += 1) {
        await nextFrame();
      }
      await nextFrame();

      const beforeUserScroll = {
        top: summary.getBoundingClientRect().top,
        scrollTop: messages.scrollTop,
        maxScrollTop: Math.max(0, messages.scrollHeight - messages.clientHeight),
      };
      const requestedScrollTop = Math.min(beforeUserScroll.maxScrollTop, beforeUserScroll.scrollTop + 80);
      const messagesRect = messages.getBoundingClientRect();
      messages.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 7,
        pointerType: "mouse",
        button: 0,
        clientX: messagesRect.right - 1,
        clientY: messagesRect.top + 40,
        bubbles: true,
      }));
      messages.scrollTop = requestedScrollTop;
      messages.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, pointerType: "mouse", bubbles: true }));
      const immediate = {
        top: summary.getBoundingClientRect().top,
        scrollTop: messages.scrollTop,
      };
      const samples = [];
      for (let frame = 0; frame < 10; frame += 1) {
        await nextFrame();
        samples.push({
          top: summary.getBoundingClientRect().top,
          scrollTop: messages.scrollTop,
          compensation: getComputedStyle(messages).getPropertyValue("--viewport-anchor-after-space").trim(),
        });
      }
      return {
        beforeUserScroll,
        requestedScrollTop,
        immediate,
        samples,
        thinkingVisible: Boolean(document.querySelector(".msg-thinking-group")),
      };
    });

    expect(result.thinkingVisible, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.requestedScrollTop - result.beforeUserScroll.scrollTop).toBeGreaterThan(20);
    expect(result.immediate.scrollTop).toBeCloseTo(result.requestedScrollTop, 1);
    expect(
      result.samples.every(sample => Math.abs(sample.scrollTop - result.requestedScrollTop) < 0.5),
      JSON.stringify(result, null, 2),
    ).toBe(true);
    expect(result.samples.at(-1).compensation).toBe("0px");
  });

  test("releases the active viewport anchor when chat search navigates", async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const code = Array.from({ length: 48 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const rows = Array.from({ length: 32 }, (_, index) => ({ index, value: `row-${index}` }));
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "viewport_search_navigation",
        transcript: [
          ...Array.from({ length: 12 }, (_, index) => ({
            type: "assistant", spanId: `search-history-${index}`,
            content: `历史消息 ${index + 1}：保持收起后的对话仍需滚动。`.repeat(4),
          })),
          { type: "user", text: "执行脚本并查看搜索目标。", clientMessageId: "viewport_search_user" },
          {
            type: "tool",
            toolCallId: "viewport_search_tool",
            runId: "viewport_search_run",
            name: "run_script",
            args: { target: "inner", code },
            result: { ok: true, result: rows },
            phase: "done",
            isRunning: false,
            isError: false,
          },
          { type: "assistant", runId: "viewport_search_run", content: "唯一搜索目标：海风坐标。" },
        ],
      });
      const messages = document.querySelector("#messages");
      const summary = messages.querySelector(".msg-tool > .tool-summary");
      summary.click();
      await nextFrame();
      await nextFrame();
      messages.scrollTop = messages.scrollHeight;
      messages.dispatchEvent(new Event("scroll"));
      await nextFrame();
      summary.click();
      for (let frame = 0; frame < 6; frame += 1) await nextFrame();
      return {
        compensation: getComputedStyle(messages).getPropertyValue("--viewport-anchor-after-space").trim(),
        scrollTop: messages.scrollTop,
      };
    });

    expect(Number.parseFloat(setup.compensation), JSON.stringify(setup, null, 2)).toBeGreaterThan(0);
    await page.keyboard.press("Control+f");
    const searchInput = page.locator("#chat-search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("海风坐标");
    await searchInput.press("Enter");
    const after = await page.locator("#messages").evaluate(messages => ({
      compensation: getComputedStyle(messages).getPropertyValue("--viewport-anchor-after-space").trim(),
      activeMatches: messages.querySelectorAll(".chat-search-active").length,
      anchored: window.qingzhouConversationBenchmark.collectViewportAnchorState().active,
    }));
    expect(after, JSON.stringify({ setup, after }, null, 2)).toEqual({
      compensation: "0px",
      activeMatches: 1,
      anchored: false,
    });
  });

  for (const viewport of [
    { width: 430, height: 844 },
    { width: 360, height: 640 },
  ]) {
    test(`keeps the visible run script geometry fixed throughout mixed streaming at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const result = await page.evaluate(async () => {
        const code = Array.from({ length: 32 }, (_, index) => `const sample${index} = ${index};`).join("\n");
        const rows = Array.from({ length: 24 }, (_, index) => ({ index, value: `result-${index}` }));
        const sessionId = "viewport_stability_matrix";
        const runId = "viewport_stability_run";
        const toolCallId = "viewport_stability_tool";
        await window.qingzhouConversationBenchmark.runSnapshotRender({
          sessionId,
          transcript: [
            { type: "user", text: "执行脚本，然后持续分析结果。", clientMessageId: "viewport_stability_user" },
            {
              type: "tool",
              toolCallId,
              runId,
              name: "run_script",
              args: { target: "inner", code },
              result: { ok: true, result: rows },
              phase: "done",
              isRunning: false,
              isError: false,
            },
          ],
        });
        window.qingzhouConversationBenchmark.configureVisualState({ running: true });
        window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
          type: "goal_update",
          sessionId,
          runId,
          eventSeq: 1,
          goal: { status: "active", objective: "完成脚本分析", version: 1 },
        });

        const tool = document.querySelector(`[data-transcript-key$=":tool:${runId}:${toolCallId}"]`)
          || document.querySelector(".msg-tool");
        const summary = tool?.querySelector(":scope > .tool-summary");
        summary?.click();
        await nextFrames(3);
        const messages = document.querySelector("#messages");
        const details = tool?.querySelector(":scope > .tool-details");
        const baselineTop = summary?.getBoundingClientRect().top ?? null;
        const baselineDetailsTop = details?.getBoundingClientRect().top ?? null;
        const baselineViewportTop = messages?.getBoundingClientRect().top ?? null;
        const samples = [];
        let sampling = true;
        let frame = 0;
        const sample = () => {
          const liveTool = document.querySelector(`[data-transcript-key$=":tool:${runId}:${toolCallId}"]`)
            || document.querySelector(".msg-tool");
          const liveSummary = liveTool?.querySelector(":scope > .tool-summary");
          const rect = liveSummary?.getBoundingClientRect();
          const viewportRect = messages?.getBoundingClientRect();
          samples.push({
            frame: frame++,
            top: rect?.top ?? null,
            detailsTop: liveTool?.querySelector(":scope > .tool-details")?.getBoundingClientRect().top ?? null,
            viewportTop: viewportRect?.top ?? null,
            viewportHeight: viewportRect?.height ?? null,
            scrollTop: messages?.scrollTop ?? null,
            scrollHeight: messages?.scrollHeight ?? null,
            beforeSpace: getComputedStyle(messages).getPropertyValue("--viewport-anchor-before-space").trim(),
            afterSpace: getComputedStyle(messages).getPropertyValue("--viewport-anchor-after-space").trim(),
            anchor: window.qingzhouConversationBenchmark.collectViewportAnchorState?.() || null,
            sameTool: liveTool === tool,
            sameDetails: liveTool?.querySelector(":scope > .tool-details") === details,
          });
          if (sampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);

        let eventSeq = 2;
        const dispatch = async event => {
          window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ sessionId, runId, eventSeq: eventSeq++, ...event });
          await nextFrames(3);
        };
        for (let index = 1; index <= 12; index += 1) {
          await dispatch({
            type: "thinking_update",
            thinking: Array.from({ length: index }, (_item, line) => `分析脚本结果 ${line + 1}：继续核对数据。`).join("\n\n"),
          });
          if (index === 4) {
            await dispatch({
              type: "goal_update",
              goal: { status: "active", objective: "完成脚本分析", version: 2, progress: "正在核对输出" },
            });
          }
        }
        await dispatch({
          type: "message_start",
          spanId: "viewport_stability_assistant",
          message: { role: "assistant", content: "" },
        });
        for (let index = 1; index <= 10; index += 1) {
          await dispatch({
            type: "message_update",
            spanId: "viewport_stability_assistant",
            content: Array.from({ length: index }, (_item, line) => `结论 ${line + 1}：脚本结果符合预期。`).join("\n\n"),
          });
        }
        sampling = false;
        await nextFrames(2);

        const tops = samples.map(item => item.top).filter(Number.isFinite);
        const topDeltas = tops.map(top => top - baselineTop);
        const detailsTopDeltas = samples
          .map(item => item.detailsTop)
          .filter(Number.isFinite)
          .map(top => top - baselineDetailsTop);
        const viewportTopDeltas = samples
          .map(item => item.viewportTop)
          .filter(Number.isFinite)
          .map(top => top - baselineViewportTop);
        const frameMoves = tops.slice(1).map((top, index) => top - tops[index]);
        const visibleMoves = frameMoves.filter(delta => Math.abs(delta) >= 0.5);
        let directionReversals = 0;
        for (let index = 1; index < visibleMoves.length; index += 1) {
          if (Math.sign(visibleMoves[index]) !== Math.sign(visibleMoves[index - 1])) directionReversals += 1;
        }
        return {
          baselineTop,
          sampleCount: samples.length,
          maxAnchorDriftPx: Math.max(0, ...topDeltas.map(Math.abs)),
          maxDetailsDriftPx: Math.max(0, ...detailsTopDeltas.map(Math.abs)),
          maxViewportDriftPx: Math.max(0, ...viewportTopDeltas.map(Math.abs)),
          directionReversals,
          nodeReplacements: samples.filter(item => !item.sameTool || !item.sameDetails).length,
          samples: samples.filter((_item, index) => index === 0 || index === samples.length - 1 || Math.abs(frameMoves[index - 1] || 0) >= 0.5),
        };

        function nextFrames(count) {
          return new Promise(resolve => {
            const tick = remaining => requestAnimationFrame(() => remaining <= 1 ? resolve() : tick(remaining - 1));
            tick(Math.max(1, count));
          });
        }
      });

      expect(result.sampleCount, JSON.stringify(result, null, 2)).toBeGreaterThan(60);
      expect(result.nodeReplacements, JSON.stringify(result, null, 2)).toBe(0);
      expect(result.directionReversals, JSON.stringify(result, null, 2)).toBe(0);
      expect(result.maxAnchorDriftPx, JSON.stringify(result, null, 2)).toBeLessThan(0.5);
      expect(result.maxDetailsDriftPx, JSON.stringify(result, null, 2)).toBeLessThan(0.5);
      expect(result.maxViewportDriftPx, JSON.stringify(result, null, 2)).toBeLessThan(0.5);
    });
  }

});
