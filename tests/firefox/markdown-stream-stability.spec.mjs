import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { openFirefoxSidebar } from "./launch.mjs";
import { openFromToolbar, setColorScheme, setSidebarWidth } from "./driver.mjs";
import { prepareBenchmarkAssets } from "../support/benchmark-assets.mjs";
import { imageTranscript } from "../support/markdown-stream-fixture.mjs";

test("expanded image tools and streamed Markdown keep a stable tail in the Firefox sidebar", async ({}, testInfo) => {
  const extensionDir = testInfo.outputPath("extension");
  await mkdir(extensionDir, { recursive: true });
  await cp(process.env.QINGZHOU_FIREFOX_EXTENSION_DIR, extensionDir, { recursive: true });
  await prepareBenchmarkAssets(extensionDir, join(extensionDir, "sidepanel"), { extensionUrlPrefix: "" });
  const hook = join(extensionDir, "sidepanel/benchmark-test-hook.js");
  await writeFile(hook, `globalThis.__QZ_CONVERSATION_BENCHMARK__ = true;\n${await readFile(hook, "utf8")}`);
  const session = await openFirefoxSidebar({ extensionDir, profile: testInfo.outputPath("profile") });
  try {
    await openFromToolbar(session);
    await setSidebarWidth(session, 430);
    expect(await session.extension("sidebar", `
      const started = Date.now();
      while (Date.now() - started < 12000) {
        content.document.querySelector("[data-consent-accept]")?.click();
        if (view.qingzhouConversationBenchmark && !content.document.querySelector("#app")?.hasAttribute("data-consent-pending")) return true;
        await new Promise(resolve => content.setTimeout(resolve, 100));
      }
      return false;
    `)).toBe(true);
    for (const step of [5, 20]) {
      await setColorScheme(session, step === 5 ? "dark" : "light");
      const result = await session.extension("sidebar", `
        const transcript = view.JSON.parse(${JSON.stringify(JSON.stringify(imageTranscript()))});
        const final = transcript.at(-1), runId = final.runId, sessionId = "firefox-markdown";
        const bench = view.qingzhouConversationBenchmark, doc = content.document;
        const wait = ms => new Promise(resolve => content.setTimeout(resolve, ms));
        const frame = () => new Promise(resolve => content.requestAnimationFrame(resolve));
        await bench.runLiveReplay(view.JSON.parse(JSON.stringify({ sessionId, baseTranscript: transcript.slice(0, -1), events: [] })), view.JSON.parse(JSON.stringify({ runId })));
        const card = doc.querySelector(".msg-tool-timeline"), messages = doc.querySelector("#messages");
        card.querySelector(":scope > .tool-summary").click();
        card.querySelector('[data-tool-timeline-index="2"]').click();
        await wait(250);
        messages.scrollTop = messages.scrollHeight;
        messages.dispatchEvent(new content.Event("scroll"));
        await wait(150);
        const frames = [];
        let sampling = true;
        const sample = () => {
          const answer = messages.querySelector(".msg-assistant:last-child");
          const table = answer?.querySelector("table");
          frames.push({ top: messages.scrollTop, height: messages.scrollHeight, client: messages.clientHeight,
            length: answer?.dataset.content?.length, tableOpacity: table ? Number(content.getComputedStyle(table).opacity) : null });
          if (sampling) content.requestAnimationFrame(sample);
        };
        content.requestAnimationFrame(sample);
        let seq = 0;
        const dispatch = event => bench.dispatchBackgroundEvent(view.JSON.parse(JSON.stringify({ sessionId, runId, eventSeq: ++seq, ...event })));
        for (let length = ${step}; length < final.content.length + ${step}; length += ${step}) {
          dispatch({ type: "message_update", spanId: final.spanId, content: final.content.slice(0, length) });
          await wait(30);
        }
        let answer;
        const started = Date.now();
        while (Date.now() - started < 4000) {
          answer = messages.querySelector(".msg-assistant:last-child");
          if (answer?.dataset.content === final.content) break;
          await frame();
        }
        dispatch({ type: "message_end", spanId: final.spanId, message: { role: "assistant", content: final.content } });
        await wait(300);
        sampling = false;
        return { frames, mode: answer?.dataset.markdownMode, content: answer?.dataset.content,
          reducedMotion: content.matchMedia("(prefers-reduced-motion: reduce)").matches,
          rows: answer?.querySelectorAll("table tbody tr").length, links: answer?.querySelectorAll("table a").length,
          imageGrid: !!card.querySelector(".tool-image-grid-scroll") };
      `);
      await testInfo.attach(`frames-${step}.json`, { body: Buffer.from(JSON.stringify(result)), contentType: "application/json" });
      expect(result.mode).toBe("complete");
      expect(result.content).toBe(imageTranscript().at(-1).content);
      expect(result.rows).toBe(5);
      expect(result.links).toBe(5);
      expect(result.imageGrid).toBe(true);
      if (!result.reducedMotion) expect(result.frames.some(frame => frame.tableOpacity > 0 && frame.tableOpacity < 1)).toBe(true);
      const tail = result.frames.findIndex(s => s.top > 20 && s.height - s.client - s.top < 2);
      expect(tail).toBeGreaterThanOrEqual(0);
      const backwards = result.frames.slice(tail + 1).filter((frame, i) =>
        frame.client === result.frames[tail + i].client && frame.top < result.frames[tail + i].top - 0.5);
      expect(backwards).toEqual([]);
    }
  } finally {
    await session.close();
  }
});
