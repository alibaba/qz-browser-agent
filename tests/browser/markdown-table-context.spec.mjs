import { expect, test } from "./sidepanel-fixtures.mjs";

const prefixes = [
  ["adjacent Chinese colon", "说明文字：\n"],
  ["adjacent Chinese period", "说明文字。\n"],
  ["adjacent English colon", "说明文字:\n"],
  ["heading one", "# 标题\n"],
  ["heading two", "## 标题\n"],
  ["blank line control", "说明文字：\n\n"],
];
const table = "| alpha | beta |\n|---|---|\n| first | second |\n| third | fourth |";

for (const [name, prefix] of prefixes) for (const delivery of ["split points", "character by character"]) {
  test(`table preserves preceding block · ${name} · ${delivery}`, async ({ page }, testInfo) => {
    const result = await page.evaluate(async ({ prefix, table, delivery }) => {
      const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
      const host = document.createElement("div");
      host.className = "msg-assistant";
      host.innerHTML = '<div class="msg-content"></div>';
      document.body.append(host);
      const body = host.firstElementChild;
      const render = (source, stream = true) => {
        body.innerHTML = renderMarkdown(source, { math: stream ? "stream" : true });
        return { source, html: body.innerHTML, text: body.innerText,
          prefix: body.firstElementChild?.outerHTML,
          pending: body.querySelectorAll(".markdown-table-pending").length,
          tables: body.querySelectorAll("table").length,
          headers: [...body.querySelectorAll("th")].map(cell => cell.textContent),
          rows: [...body.querySelectorAll("tbody tr")].map(row => [...row.children].map(cell => cell.textContent)) };
      };
      const expectedPrefix = render(prefix, false).prefix;
      // Header, delimiter (including |--), row and individual cell boundaries.
      const cuts = delivery === "character by character"
        ? Array.from({ length: table.length }, (_, i) => i + 1)
        : [1, 5, 16, 19, 23, 26, 31, 39, 43, table.length];
      const samples = cuts.map(length => render(prefix + table.slice(0, length)));
      const final = render(prefix + table, false);
      const released = render(prefix + table + "\n\n后续文字。");
      const completeWithBoundary = render(prefix + table + "\n\n后续文字。", false);
      host.remove();
      return { expectedPrefix, samples, final, released, completeWithBoundary };
    }, { prefix, table, delivery });
    await testInfo.attach("table-context-states.json", { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: "application/json" });
    for (const sample of result.samples) {
      expect(sample.prefix, sample.source).toBe(result.expectedPrefix);
      expect(sample.pending, sample.source).toBe(1);
      expect(sample.tables, sample.source).toBe(0);
    }
    expect(result.final.prefix).toBe(result.expectedPrefix);
    expect(result.final.headers).toEqual(["alpha", "beta"]);
    expect(result.final.rows).toEqual([["first", "second"], ["third", "fourth"]]);
    expect(result.released.html).toBe(result.completeWithBoundary.html);
    expect(result.released.text).toBe(result.completeWithBoundary.text);
  });
}

test("provisional table boundaries leave literal pipes and code intact", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
    const sources = [
      "正文里的 a | b 保持不变。",
      "正文。\n\\| 不是表头",
      "正文。\n`| literal |`",
      "正文。\n```text\n| alpha | beta |\n|--\n```",
      "正文。\n<pre>\n| alpha | beta |\n|--\n</pre>",
      "正文。\n| literal prose\n这不是分隔行。",
      "正文。\nalpha | beta\n---|---\nfirst | second\n\n后续。",
    ];
    return sources.map(source => ({ source, streamed: renderMarkdown(source, { math: "stream" }), final: renderMarkdown(source) }));
  });
  for (const result of results) expect(result.streamed, result.source).toBe(result.final);
});

for (const ending of ["boundary", "end"]) {
  test(`live adjacent paragraph survives table patches · ${ending}`, async ({ page }, testInfo) => {
    const prefix = "说明文字：\n";
    const source = prefix + table;
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runLiveReplay({ sessionId: "table-context", baseTranscript: [], events: [] }, { runId: "context-run" });
    });
    const answer = page.locator('[data-stream-trace-id="context-answer"]');
    const states = [];
    let eventSeq = 0;
    for (const length of [prefix.length, prefix.length + 5, prefix.length + 19, prefix.length + 31, source.length]) {
      const content = source.slice(0, length);
      await page.evaluate(({ content, eventSeq }) => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "message_update", sessionId: "table-context", runId: "context-run", spanId: "context-answer", eventSeq, content,
      }), { content, eventSeq: ++eventSeq });
      await expect(answer).toHaveAttribute("data-content", content);
      states.push(await answer.locator(".msg-content").evaluate(node => ({ html: node.innerHTML, text: node.innerText })));
    }
    const completed = source + (ending === "boundary" ? "\n\n后续文字。" : "");
    await page.evaluate(({ content, eventSeq, ending }) => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
      sessionId: "table-context", runId: "context-run", spanId: "context-answer", eventSeq,
      ...(ending === "end" ? { type: "message_end", message: { role: "assistant", content } } : { type: "message_update", content }),
    }), { content: completed, eventSeq: ++eventSeq, ending });
    await expect(answer).toHaveAttribute("data-content", completed);
    await expect(answer.locator("table")).toBeVisible();
    const result = await answer.locator(".msg-content").evaluate(async (node, source) => {
      const { renderMarkdown } = await import("/extension/sidepanel/features/chat/markdown-feature.js");
      const expected = document.createElement("div");
      expected.innerHTML = renderMarkdown(source);
      return { html: node.innerHTML, expected: expected.innerHTML, text: node.textContent, expectedText: expected.textContent };
    }, completed);
    await testInfo.attach("live-table-context-states.json", { body: Buffer.from(JSON.stringify({ states, result }, null, 2)), contentType: "application/json" });
    for (const state of states) expect(state.html).toMatch(/^<p>说明文字：<\/p>/);
    expect(result.html).toBe(result.expected);
    expect(result.text).toBe(result.expectedText);
  });
}
