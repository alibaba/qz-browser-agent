import { expect, test } from "./sidepanel-fixtures.mjs";
import { readFileSync } from "node:fs";
import { imageTranscript } from "../support/markdown-stream-fixture.mjs";

test.use({ viewport: { width: 430, height: 760 }, launchOptions: { args: ["--enable-smooth-scrolling"] } });


for (const step of [5, 20]) {
  test(`expanded image timeline stays stable at the streaming tail, ${step} characters per update`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: step === 5 ? "dark" : "light" });
    const data = process.env.QZ_SCROLL_TRACE
      ? JSON.parse(readFileSync(process.env.QZ_SCROLL_TRACE, "utf8"))
      : { session: { transcript: imageTranscript() } };
    await page.route("https://**/*", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#638f87"/></svg>' }));
    await page.evaluate(async ({ transcript, step }) => {
      const bench = window.qingzhouConversationBenchmark;
      const final = transcript.at(-1), sessionId = "trace-scroll", runId = final.runId;
      await bench.runLiveReplay({ sessionId, baseTranscript: transcript.slice(0, -1), events: [] }, { runId });
      const maxSequence = Math.max(...transcript.map(e => Number(e.eventSeq) || 0));
      window.__startTraceStream = () => {
        window.__traceFrames = []; window.__traceSampling = true;
        const sample = () => {
          const m = document.querySelector("#messages");
          const answer = m.querySelector(".msg-assistant:last-child .msg-content");
          window.__traceFrames.push({ time: performance.now(), top: m.scrollTop, height: m.scrollHeight, client: m.clientHeight,
            cardTop: m.querySelector(".msg-tool-timeline")?.getBoundingClientRect().top,
            answerLength: answer?.textContent.length, markdownTail: answer?.parentElement.dataset.content?.slice(-200),
            markdownLength: answer?.parentElement.dataset.content?.length,
            anchor: bench.collectViewportAnchorState() });
          if (window.__traceSampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        let length = 0, seq = maxSequence;
        window.__traceTimer = setInterval(() => {
          length = Math.min(final.content.length, length + step);
          bench.dispatchBackgroundEvent({ type: "message_update", sessionId, runId, spanId: final.spanId,
            eventSeq: ++seq, content: final.content.slice(0, length) });
          if (length === final.content.length) { clearInterval(window.__traceTimer); window.__traceDone = true;
            window.__finishTrace = () => {
              bench.dispatchBackgroundEvent({ type: "message_end", sessionId, runId, spanId: final.spanId,
                eventSeq: ++seq, message: { role: "assistant", content: final.content } });
              bench.dispatchBackgroundEvent({ type: "agent_end", sessionId, runId, eventSeq: ++seq });
            }; }
        }, 30);
      };
    }, { transcript: data.session.transcript, step });
    const card = page.locator(".msg-tool-timeline");
    await card.locator(":scope > .tool-summary").click();
    await card.locator('[data-tool-timeline-index="2"]').click();
    await expect(card.locator(".tool-image-grid-scroll")).toBeVisible();
    // Locator hover can scroll the footer into view, including retries while the
    // answer grows. Finish that setup before measuring native wheel/tail motion.
    await card.locator(".tool-timeline-collapse-btn").hover();
    await page.evaluate(() => window.__startTraceStream());
    await page.mouse.wheel(0, 1000);
    await page.waitForFunction(() => window.__traceDone);
    const answer = page.locator('.msg-assistant').last();
    await expect(answer).toHaveAttribute('data-content', data.session.transcript.at(-1).content);
    await expect(answer.locator('table tbody tr')).toHaveCount(5);
    await expect(answer.locator('table a')).toHaveCount(5);
    await page.evaluate(() => window.__finishTrace());
    await expect(answer).toHaveAttribute('data-markdown-mode', 'complete');
    await expect(answer.locator('table tbody tr')).toHaveCount(5);
    await expect(answer.locator('table a')).toHaveCount(5);
    await page.waitForTimeout(250);
    const frames = await page.evaluate(() => { window.__traceSampling = false; return window.__traceFrames; });
    await testInfo.attach("scroll-frames.json", { body: Buffer.from(JSON.stringify(frames)), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("completed.png") });
    const tail = frames.findIndex(s => s.top > 20 && s.height - s.client - s.top < 2);
    expect(tail).toBeGreaterThanOrEqual(0);
    // The run-status bar disappears on completion and changes the viewport height.
    const backwards = frames.slice(tail + 1).map((s, i) => ({ from: frames[tail + i], to: s }))
      .filter(({from, to}) => from.client === to.client && to.top < from.top - 0.5);
    await testInfo.attach("replay-backwards.json", { body: Buffer.from(JSON.stringify(backwards)), contentType: "application/json" });
    expect(backwards, JSON.stringify(backwards.slice(0, 5))).toEqual([]);
  });
}

test("pending links keep their labels without exposing unfinished destinations", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
    const render = (markdown, stream = true) => {
      const node = document.createElement("div");
      node.innerHTML = renderMarkdown(markdown, { math: stream ? "stream" : true });
      return { text: node.textContent.trim(), links: [...node.querySelectorAll("a")].map(a => a.getAttribute("href")), html: node.innerHTML };
    };
    const target = "https://example.com/a_long_path_(with_parentheses)#fragment";
    const label = "**景点** `[`与\\]说明";
    const markdown = `查看 [${label}](${target} "来源标题")`;
    const destinationStart = markdown.indexOf("](") + 2;
    return {
      pending: Array.from({ length: markdown.length - destinationStart }, (_, i) => render(markdown.slice(0, destinationStart + i))),
      partialLabel: render("查看 [景点"),
      completed: render(markdown), final: render(markdown, false),
      literals: [
        "`[literal](https://example.com/unfinished`",
        "```text\n[literal](https://example.com/unfinished",
        "<code>[literal](https://example.com/unfinished</code>",
        "[literal]\n\n接下来的正文",
        "[source]: https://example.com/complete\n\n[source]",
      ].map(source => ({ streamed: render(source), final: render(source, false) })),
      interrupted: render("查看 [景点](https://example.com/unfinished", false),
    };
  });
  for (const result of results.pending) {
    expect(result.text).toBe("查看 景点 [与]说明");
    expect(result.links).toEqual([]);
  }
  expect(results.partialLabel.text).toBe("查看 景点");
  expect(results.completed.html).toBe(results.final.html);
  expect(results.completed.links).toEqual(["https://example.com/a_long_path_(with_parentheses)#fragment"]);
  for (const { streamed, final } of results.literals) {
    expect(streamed.text).toBe(final.text);
    expect(streamed.links).toEqual(final.links);
  }
  expect(results.interrupted.text).toContain("[景点](https://example.com/unfinished");
});

test("footnote definition prefixes stay out of the body and source links finish normally", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
    const node = document.createElement("div");
    const render = markdown => {
      node.innerHTML = renderMarkdown(markdown, { math: "stream" });
      return { text: node.textContent.trim(), body: node.querySelector(".markdown-footnote-body")?.textContent,
        sourceLinks: node.querySelectorAll(".markdown-footnote-body a").length };
    };
    const prefixes = ["[", "[^", "[^s", "[^source", "[^source]", "[1", "[12", "[123]"];
    return {
      prefixes: prefixes.map(prefix => render(`已完成正文。\n\n${prefix}`)),
      unused: render("已完成正文。\n\n[^1]: [来源](https://example.com/unfinished"),
      pending: render("核对来源[^1]。\n\n[^1]: [来源名称](https://example.com/unfinished"),
      completed: render("核对来源[^1]。\n\n[^1]: [来源名称](https://example.com/complete)"),
      code: render("```text\n[^source]"),
      inline: render("正文中使用[^source]"),
    };
  });
  for (const result of [...results.prefixes, results.unused]) expect(result.text).toBe("已完成正文。");
  expect(results.pending.body).toBe("来源名称");
  expect(results.pending.sourceLinks).toBe(0);
  expect(results.completed.body).toBe("来源名称");
  expect(results.completed.sourceLinks).toBe(1);
  expect(results.code.text).toContain("[^source]");
  expect(results.inline.text).toBe("正文中使用source");
});

test("ending an unchanged stream restores unfinished literal Markdown", async ({ page }) => {
  const source = "正文结束。\n\n[未完成链接](https://example.com/unfinished";
  await page.evaluate(async source => {
    const bench = window.qingzhouConversationBenchmark;
    await bench.runLiveReplay({ sessionId: "literal-end", baseTranscript: [], events: [] }, { runId: "literal-run" });
    bench.dispatchBackgroundEvent({ type: "message_update", sessionId: "literal-end", runId: "literal-run",
      spanId: "literal-answer", eventSeq: 1, content: source });
  }, source);
  const answer = page.locator('.msg-assistant').last();
  await expect(answer).toHaveAttribute("data-content", source);
  await expect(answer.locator(".msg-content")).not.toContainText("https://");
  await page.evaluate(source => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
    type: "message_end", sessionId: "literal-end", runId: "literal-run", spanId: "literal-answer", eventSeq: 2,
    message: { role: "assistant", content: source },
  }), source);
  await expect(answer).toHaveAttribute("data-markdown-mode", "complete");
  await expect(answer.locator(".msg-content")).toContainText("[未完成链接](https://example.com/unfinished");
});

test("tables show an increasing character count, then keep their compact automatic columns", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
    const node = document.createElement("div");
    node.className = "msg-assistant";
    node.style.width = "380px";
    node.innerHTML = '<div class="msg-content"></div>';
    document.body.append(node);
    const body = node.firstElementChild;
    const table = "| # | 景点 | 图片尺寸 | 来源条目 |\n|---|---|---|---|\n"
      + "| 1 | 湖边楼阁 | 1365×2048（原图 4000×6000） | [Pavilion](https://example.com/long_path/Pavilion) |\n"
      + "| 2 | 历史木造舞台 | 1452×969 | [Wooden Stage](https://example.com/long_path/Stage) |";
    const samples = [];
    for (let length = 1; length <= table.length; length += 1) {
      body.innerHTML = renderMarkdown("开始整理图片。\n\n" + table.slice(0, length), { math: "stream" });
      const pending = body.querySelector(".markdown-table-pending");
      samples.push({ text: pending?.textContent, height: pending?.getBoundingClientRect().height,
        tables: body.querySelectorAll("table").length });
    }
    const measure = () => ({
      pending: !!body.querySelector(".markdown-table-pending"),
      layout: getComputedStyle(body.querySelector("table")).tableLayout,
      rows: body.querySelectorAll("tbody tr").length,
      widths: [...body.querySelectorAll("th")].map(th => th.getBoundingClientRect().width),
      html: body.querySelector("table").outerHTML,
    });
    body.innerHTML = renderMarkdown(table + "\n\n后续文字", { math: "stream" });
    const released = measure();
    body.innerHTML = renderMarkdown(table);
    const final = measure();
    body.innerHTML = renderMarkdown(table, { math: "stream" });
    const open = !!body.querySelector(".markdown-table-pending");
    body.innerHTML = renderMarkdown(table + "\n# 下一节", { math: "stream" });
    const nextBlock = measure();
    node.remove();
    return { samples, released, final, open, nextBlock };
  });
  let lastCount = 0;
  for (const sample of results.samples) {
    expect(sample.text).toMatch(/^表格生成中… \d+ 字$/);
    const count = Number(sample.text.match(/\d+/)[0]);
    expect(count).toBeGreaterThanOrEqual(lastCount);
    lastCount = count;
    expect(sample.height).toBe(results.samples[0].height);
    expect(sample.tables).toBe(0);
  }
  expect(lastCount).toBeGreaterThan(150);
  expect(results.open).toBe(true);
  expect(results.released.pending).toBe(false);
  expect(results.nextBlock.pending).toBe(false);
  expect(results.released.layout).toBe("auto");
  expect(results.released.rows).toBe(2);
  expect(results.released.html).toBe(results.final.html);
  expect(results.released.widths).toEqual(results.final.widths);
  expect(results.released.widths[0]).toBeLessThan(results.released.widths[2] / 2);
});


test("streamed HTML-looking code and emphasis prefixes do not create transient block layout", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
    const host = document.createElement("div"); host.className = "msg-assistant";
    host.style.width = "330px"; host.innerHTML = '<div class="msg-content"></div>'; document.body.append(host);
    const body = host.firstElementChild;
    const measure = source => {
      body.innerHTML = renderMarkdown(source, { math: "stream" });
      return { height: host.getBoundingClientRect().height, html: body.innerHTML, text: body.textContent,
        code: body.querySelector("code")?.textContent, figures: body.querySelectorAll("figure, img").length,
        lists: body.querySelectorAll("ul, ol").length };
    };
    const prefix = "图片已经核对。与页面 DOM 中三个 ";
    const code = ["`<", "`<figure>", "`<figure>/<i", "`<figure>/<img>", "`<figure>/<img>`"].map(suffix => measure(prefix + suffix));
    const baseline = measure("已完成正文。\n\n");
    const markers = ["*", "**", "***", "_", "__"].map(suffix => measure("已完成正文。\n\n" + suffix));
    const complete = ["* 列表项", "**粗体段落**", "***", "未闭合的 `<figure>", "``含 ` 的代码``"].map(source => ({
      source, final: renderMarkdown(source), streamed: renderMarkdown(source, { math: "stream" }),
    }));
    host.remove(); return { code, baseline, markers, complete };
  });
  for (const sample of result.code) { expect(sample.figures).toBe(0); expect(sample.code).toBeDefined(); }
  expect(result.code.at(-1).code).toBe("<figure>/<img>");
  for (let i=1;i<result.code.length;i++) expect(result.code[i].height).toBeGreaterThanOrEqual(result.code[i-1].height);
  for (const sample of result.markers) { expect(sample.height).toBe(result.baseline.height); expect(sample.lists).toBe(0); }
  expect(result.complete[0].streamed).toBe(result.complete[0].final);
  expect(result.complete[1].streamed).toBe(result.complete[1].final);
  expect(result.complete[2].final).toContain("<hr>");
  expect(result.complete[3].final).toContain("`");
  expect(result.complete[4].streamed).toBe(result.complete[4].final);
});
