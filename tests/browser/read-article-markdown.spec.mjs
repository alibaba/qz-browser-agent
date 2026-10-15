import { expect, test, testAssetUrl } from "./fixtures.mjs";
import { prepareUpstreamArticleAssets } from "../support/upstream-article-assets.mjs";
const contentScripts = [
  "extension/content/article-extractor.js",
  "extension/content/content-script.js",
];

async function installContentScript(page, html) {
  await page.setContent(`<base href="https://example.test/articles/">${html}`);
  await page.evaluate(() => {
    let listener = null;
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    }
    const runtime = {
      getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
      onMessage: {
        addListener(nextListener) {
          listener = nextListener;
        },
      },
      sendMessage: async () => ({ ok: true }),
    };
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: runtime,
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") {
        reject(new Error("content-script listener is not installed"));
        return;
      }
      try {
        listener({ action, ...params }, {}, resolve);
      } catch (error) {
        reject(error);
      }
    });
  });
  for (const script of contentScripts) {
    await page.addScriptTag({ url: testAssetUrl(script) });
  }
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

async function readArticle(page, params) {
  return page.evaluate(nextParams => window.__callQingzhouContent("readArticle", nextParams), params);
}

async function extractCandidate(page, readability = null) {
  return page.evaluate((nextReadability) => {
    const candidate = window.QingzhouArticleExtractor.extract(document, { readability: nextReadability });
    if (!candidate) return null;
    return {
      name: candidate.name,
      content: candidate.content,
      text: candidate.text,
      length: candidate.length,
      paragraphCount: candidate.paragraphCount,
      tableCount: candidate.tableCount,
      headingCount: candidate.headingCount,
    };
  }, readability);
}

test("read_article returns canonical Markdown with GFM tables, pagination, and outline offsets", async ({ page }) => {
  const filler = "A stable paragraph keeps pagination deterministic and readable. ".repeat(90);
  await installContentScript(page, `
    <article id="story">
      <h1>Structured article</h1>
      <p>An <strong>important</strong> paragraph with <a href="/docs">documentation</a>.</p>
      <ul><li>First item</li><li>Second item</li></ul>
      <pre><code>const answer = 42;</code></pre>
      <h2>Data [section]</h2>
      <table>
        <thead><tr><th>Name</th><th>Count</th></tr></thead>
        <tbody><tr><td>Alpha</td><td>2</td></tr><tr><td>Beta</td><td>3</td></tr></tbody>
      </table>
      <p>${filler}</p>
    </article>
  `);

  const full = await readArticle(page, { source: "selector", selector: "#story", limit: 20_000 });
  expect(Object.hasOwn(full, "format")).toBe(false);
  expect(full.text).toContain("# Structured article");
  expect(full.text).toContain("**important**");
  expect(full.text).toContain("[documentation](https://example.test/docs)");
  expect(full.text).toMatch(/-\s+First item/);
  expect(full.text).toContain("```\nconst answer = 42;\n```");
  expect(full.text).toContain("| Name | Count |");
  expect(full.text).toContain("| --- | --- |");
  expect(full.text).toContain("| Alpha | 2 |");
  expect(full.totalChars).toBe(full.text.length);
  expect(full.totalChars).toBeGreaterThan(2_000);

  const dataHeading = full.outline.find(item => item.title === "Data [section]");
  expect(dataHeading).toBeTruthy();
  expect(full.text.slice(dataHeading.offset).startsWith("Data \\[section\\]")).toBe(true);
  expect(dataHeading.endOffset).toBe(full.text.length);
  expect(dataHeading.charCount).toBe(dataHeading.endOffset - dataHeading.offset);

  const chunks = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const chunk = await readArticle(page, { source: "selector", selector: "#story", offset, limit: 1_000 });
    chunks.push(chunk.text);
    expect(chunk.offset).toBe(offset);
    expect(chunk.totalChars).toBe(full.totalChars);
    if (!chunk.hasMore) break;
    expect(chunk.nextOffset).toBe(offset + chunk.returnedChars);
    offset = chunk.nextOffset;
  }
  expect(chunks.join("")).toBe(full.text);

  const readability = await readArticle(page, { source: "article", limit: 20_000 });
  expect(Object.hasOwn(readability, "format")).toBe(false);
  expect(readability.text).toContain("| Name | Count |");
  expect(readability.text).toContain("| Beta | 3 |");
});

test("read_article removes named and link-dense boilerplate while preserving article structure", async ({ page }) => {
  const prose = "The extraction pipeline keeps the actual report, its evidence, and the structure readers need. ".repeat(8);
  await page.route(/https:\/\/example\.test\/(?:diagram|one)\.png/, route => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));
  await installContentScript(page, `
    <header><nav>Global navigation that is not part of the report</nav></header>
    <main id="feature" class="article-content">
      <h1>Evidence report</h1>
      <p>${prose}</p>
      <div class="topic-links">
        <a href="/one"><img src="/one.png" alt="One">One</a><a href="/two">Two</a><a href="/three">Three</a>
        <a href="/four">Four</a><a href="/five">Five</a><a href="/six">Six</a>
      </div>
      <figure><img src="/diagram.png" alt="System diagram"><figcaption>Observed system</figcaption></figure>
      <pre><code>const stable = true;</code></pre>
      <table><thead><tr><th>Signal</th><th>Value</th></tr></thead><tbody><tr><td>Stable</td><td>Yes</td></tr></tbody></table>
      <section class="related-stories"><p>Unrelated recommendation should disappear.</p></section>
    </main>
    <aside>Sidebar promotion should disappear.</aside>
  `);

  const result = await readArticle(page, { source: "article", limit: 20_000 });
  expect(result.mode).toBe("article");
  expect(result.sourceSelector).toBe("#feature");
  expect(result.text).toContain("# Evidence report");
  expect(result.text).toContain("![System diagram](https://example.test/diagram.png)");
  expect(result.text).toContain("```\nconst stable = true;\n```");
  expect(result.text).toContain("| Signal | Value |");
  expect(result.text).not.toContain("Global navigation");
  expect(result.text).not.toContain("Unrelated recommendation");
  expect(result.text).not.toContain("Sidebar promotion");
  expect(result.text).toContain("Observed system");
  expect(result.text).not.toMatch(/\[(?:One|Two|Three|Four|Five|Six)\]/);
  expect(result.text).not.toContain("one.png");
});

test("read_article preserves inserted text, time, math, and meaningful figure captions", async ({ page }) => {
  const prose = "The report explains the verified result and keeps the surrounding context intact. ".repeat(8);
  await page.route("https://example.test/**", route => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));
  await installContentScript(page, `
    <article class="article-content">
      <h1>Semantic report</h1>
      <p>${prose}</p>
      <p>The revised total is <del>40</del> <ins>42 confirmed units</ins> as of <time datetime="2026-08-14">August 14, 2026</time>.</p>
      <p>Edition <i>02</i>2085 keeps <em>important</em>context adjacent to emphasized text.</p>
      <p>Adjacent <em>alpha</em><i>beta</i> and <strong>gamma</strong><b>delta</b> keep their rendered text exact.</p>
      <p>Transparent <em>empty</em><span></span><i>boundary</i>, <span><em>nested</em></span><span><i>wrappers</i></span>, and <em>word</em><wbr><i>break</i> stay exact.</p>
      <p>Literal stars <em>*</em><strong>a</strong> and <em>*x*</em><strong>a</strong> stay exact.</p>
      <p><a href="/tool"><i><img src="/tool-icon.png" alt=""></i><span>Tool link</span></a> keeps decorative media wrappers from leaking Markdown delimiters.</p>
      <p>The defining expression is <math aria-label="x squared plus one"><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mn>1</mn></mrow></math>.</p>
      <figure><img src="/semantic-diagram.png" alt="Semantic diagram"><figcaption>Figure 1: verified system boundary</figcaption></figure>
    </article>
  `);

  const result = await readArticle(page, { source: "article", limit: 20_000 });
  expect(result.text).toContain("42 confirmed units");
  expect(result.text).toContain("August 14, 2026");
  expect(result.text).toContain("Edition *02*2085 keeps *important*context");
  expect(result.text).not.toContain("_02_2085");
  expect(result.text).toContain("Adjacent *alphabeta* and **gammadelta**");
  expect(result.text).not.toContain("*alpha**beta*");
  expect(result.text).not.toContain("**gamma****delta**");
  expect(result.text).toContain("Transparent *emptyboundary*, *nestedwrappers*, and *wordbreak* stay exact.");
  expect(result.text).not.toMatch(/\*(?:empty|nested|word)\*\*(?:boundary|wrappers|break)\*/);
  expect(result.text).toContain("[![](https://example.test/tool-icon.png)Tool link](https://example.test/tool)");
  expect(result.text).not.toContain("[*![]");
  expect(result.text).toContain("x2+1");
  expect(result.text).toContain("![Semantic diagram](https://example.test/semantic-diagram.png)");
  expect(result.text).toContain("Figure 1: verified system boundary");

  await page.addScriptTag({ path: (await prepareUpstreamArticleAssets()).marked });
  const renderedText = await page.evaluate((markdown) => {
    const container = document.createElement("div");
    container.innerHTML = globalThis.marked.parse(markdown, { gfm: true });
    return container.textContent;
  }, result.text);
  expect(renderedText).toContain("Adjacent alphabeta and gammadelta keep their rendered text exact.");
  expect(renderedText).toContain("Transparent emptyboundary, nestedwrappers, and wordbreak stay exact.");
  expect(renderedText).toContain("Literal stars *a and *x*a stay exact.");
  expect(renderedText).not.toContain("alpha**beta");
  expect(renderedText).not.toContain("gamma****delta");
});

test("read_article resolves responsive and lazy image sources before its canonical Markdown serializer", async ({ page }) => {
  const prose = "This illustrated report contains enough useful prose for stable article extraction. ".repeat(8);
  await page.route("https://example.test/**", route => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));
  await installContentScript(page, `
    <article class="article-content">
      <h1>Responsive image report</h1>
      <p>${prose}</p>
      <img alt="Lazy source" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="/images/lazy.jpg">
      <img alt="Lazy source set" src="/images/placeholder.gif" data-srcset="/images/lazy-small.jpg 320w, /images/lazy-large.jpg 1280w">
      <img alt="Responsive source set" src="/images/responsive-fallback.jpg" srcset="/images/responsive-1x.jpg 1x, /images/responsive-2x.jpg 2x">
      <picture>
        <source media="(min-width: 1px)" srcset="/images/picture-small.webp 400w, /images/picture-large.webp 1200w">
        <img alt="Picture source" src="/images/picture-fallback.jpg">
      </picture>
      <img alt="Noscript fallback" src="/images/noscript-placeholder.gif">
      <noscript><img alt="Noscript fallback" src="/images/noscript.jpg" onload="window.__extractionProbe = true"></noscript>
      <img alt="Safe protocol fallback" data-src="javascript:alert(1)" src="/images/safe.jpg">
      <img alt="Safe data fallback" data-src="data:text/html,unsafe" src="/images/safe-data.jpg">
      <img alt="Compact high-resolution icon" src="/images/highres-icon.png" style="width:24px;height:24px">
    </article>
  `);

  const result = await readArticle(page, { source: "article", limit: 20_000 });
  expect(result.text).toContain("![Lazy source](https://example.test/images/lazy.jpg)");
  expect(result.text).toContain("![Lazy source set](https://example.test/images/lazy-large.jpg)");
  expect(result.text).toContain("![Responsive source set](https://example.test/images/responsive-2x.jpg)");
  expect(result.text).toContain("![Picture source](https://example.test/images/picture-large.webp)");
  expect(result.text.match(/!\[Noscript fallback\]\(https:\/\/example\.test\/images\/noscript\.jpg\)/g)).toHaveLength(1);
  expect(result.text).not.toContain("noscript-placeholder.gif");
  expect(result.text).toContain("![Safe protocol fallback](https://example.test/images/safe.jpg)");
  expect(result.text).toContain("![Safe data fallback](https://example.test/images/safe-data.jpg)");
  expect(result._display?.imageDisplayHints).toContainEqual(expect.objectContaining({
    src: "https://example.test/images/highres-icon.png",
    width: 24,
    height: 24,
  }));
  // Display-only hints must stay out of the model-facing top-level result.
  expect(result.imageDisplayHints).toBeUndefined();
  expect(result.text).not.toMatch(/placeholder|responsive-fallback|picture-fallback|javascript:|data:text/i);
  expect(result.text).not.toContain("onload");
  expect(await page.evaluate(() => window.__extractionProbe)).toBeUndefined();
});

test("visible overflow containers remain part of the extracted article", async ({ page }) => {
  const clipped = "This clipped container is visible article content even though its overflow is hidden. ".repeat(5);
  const ordinary = "The following paragraph completes the same report with additional verified context. ".repeat(7);
  await installContentScript(page, `
    <main class="article-content">
      <h1>Clipped report</h1>
      <div style="overflow: hidden"><p>${clipped}</p></div>
      <p>${ordinary}</p>
      <p hidden>Native hidden text must stay excluded.</p>
      <p aria-hidden="true">ARIA hidden text must stay excluded.</p>
      <p style="display: none">Display hidden text must stay excluded.</p>
      <p style="visibility: hidden">Visibility hidden text must stay excluded.</p>
      <p style="opacity: 0">Transparent hidden text must stay excluded.</p>
    </main>
  `);

  const result = await readArticle(page, { source: "auto", limit: 20_000 });
  expect(result.mode).toBe("article");
  expect(result.text).toContain("Clipped report");
  expect(result.text).toContain("visible article content even though its overflow is hidden");
  expect(result.text).toContain("additional verified context");
  expect(result.text).not.toContain("Native hidden text");
  expect(result.text).not.toContain("ARIA hidden text");
  expect(result.text).not.toContain("Display hidden text");
  expect(result.text).not.toContain("Visibility hidden text");
  expect(result.text).not.toContain("Transparent hidden text");
});

test("article extraction shares one computed-visibility snapshot across selectors", async ({ page }) => {
  const body = "The visible report contains enough verified evidence for stable extraction. ".repeat(8);
  const hiddenRoot = "A hidden article-shaped root must never outrank the visible report. ".repeat(16);
  await installContentScript(page, `
    <style>
      .hidden-article { display: none }
      .hidden-parent { visibility: hidden }
      .visible-child { visibility: visible }
      .restored-native[hidden] { display: block !important }
      .transparent-noise { opacity: 0 }
      .skipped-noise { content-visibility: hidden }
      .contents-wrapper { display: contents }
      .contents-opacity { display: contents; opacity: 0 }
      .contents-skipped { display: contents; content-visibility: hidden }
      .restored-display { display: block !important }
      .restored-visibility { visibility: visible !important }
      .restored-opacity { opacity: 1 !important }
    </style>
    <article class="article-content hidden-article"><h1>Hidden decoy</h1><p>${hiddenRoot}</p></article>
    <main class="article-content">
      <h1>Visible report</h1>
      <p>${body}</p>
      <section class="hidden-parent">
        Hidden ancestor text must disappear.
        <p class="visible-child">A descendant restored with visibility visible must remain.</p>
      </section>
      <p class="restored-native" hidden>CSS-restored native hidden content must remain.</p>
      <p class="restored-display" style="display: none">CSS-restored inline display content must remain.</p>
      <p class="restored-visibility" style="visibility: hidden">CSS-restored inline visibility content must remain.</p>
      <p class="restored-opacity" style="opacity: 0">CSS-restored inline opacity content must remain.</p>
      <p class="transparent-noise">Transparent content must disappear.</p>
      <p class="skipped-noise">Content-visibility hidden content must disappear.</p>
      <p aria-hidden="true">ARIA-hidden content must disappear.</p>
      <details><summary>Visible disclosure label</summary><p>Closed disclosure content must disappear.</p></details>
      <div class="contents-wrapper"><p>Display contents descendants must remain.</p></div>
      <div class="contents-opacity"><p>Display contents ignores wrapper opacity.</p></div>
      <div class="contents-skipped"><p>Display contents ignores wrapper content visibility.</p></div>
    </main>
  `);

  const candidate = await extractCandidate(page);
  const article = await readArticle(page, { source: "article", limit: 20_000 });
  for (const text of [candidate.text, article.text]) {
    expect(text).toContain("Visible report");
    expect(text).toContain("descendant restored with visibility visible");
    expect(text).toContain("CSS-restored native hidden content");
    expect(text).toContain("CSS-restored inline display content");
    expect(text).toContain("CSS-restored inline visibility content");
    expect(text).toContain("CSS-restored inline opacity content");
    expect(text).toContain("Display contents descendants");
    expect(text).toContain("Visible disclosure label");
    expect(text).toContain("Display contents ignores wrapper opacity");
    expect(text).toContain("Display contents ignores wrapper content visibility");
    expect(text).not.toContain("Hidden decoy");
    expect(text).not.toContain("Hidden ancestor text");
    expect(text).not.toContain("Transparent content");
    expect(text).not.toContain("Content-visibility hidden content");
    expect(text).not.toContain("ARIA-hidden content");
    expect(text).not.toContain("Closed disclosure content");
  }
});

test("article source selectors resolve to the visible copy of responsive duplicate content", async ({ page }) => {
  const prose = "The visible report contains the complete evidence, context, and conclusions readers need. ".repeat(10);
  await installContentScript(page, `
    <article id="hidden-copy" style="opacity: 0"><h1>Responsive report</h1><p>${prose}</p></article>
    <main id="visible-copy" class="article-content"><h1>Responsive report</h1><p>${prose}</p></main>
  `);

  const result = await readArticle(page, { source: "article", limit: 20_000 });
  expect(result.text).toContain("complete evidence");
  expect(result.sourceSelector).toBe("#visible-copy");
});

test("auto reading falls back to the central collection when article heuristics select page chrome", async ({ page }) => {
  await page.route(/https:\/\/example\.test\/images\/\d+\.jpg/, route => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    body: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==", "base64"),
  }));
  const cards = Array.from({ length: 8 }, (_, index) => `
    <article class="result-card">
      <a href="/notes/${index}"><img src="/images/${index}.jpg" alt="Cover ${index}"></a>
      <div class="footer">
        <a href="/notes/${index}">Useful result ${index}</a>
        <a href="/authors/${index}">Author ${index}</a>
      </div>
    </article>
  `).join("");
  await installContentScript(page, `
    <div class="site-information">
      <p>${"Registration, license, privacy policy, and site filing details. ".repeat(20)}</p>
    </div>
    <div class="main-content">
      <div class="filters">Recommended · Articles · Videos</div>
      <div class="result-grid">${cards}</div>
    </div>
  `);

  const forced = await readArticle(page, { source: "article", limit: 20_000 });
  expect(forced.mode).toBe("article");
  expect(forced.text).toContain("Registration, license");

  const automatic = await readArticle(page, { source: "auto", limit: 20_000 });
  expect(automatic.mode).toBe("body");
  expect(await page.evaluate(selector => (
    document.querySelector(selector)?.classList.contains("main-content") || false
  ), automatic.sourceSelector)).toBe(true);
  expect(automatic.text).toContain("Useful result 0");
  expect(automatic.text).toContain("Useful result 7");
  expect(automatic.text).toContain("![Cover 0](https://example.test/images/0.jpg)");
  expect(automatic.text).not.toContain("Registration, license");

  const chunks = [];
  let offset = 0;
  while (offset < automatic.totalChars) {
    const chunk = await readArticle(page, { source: "auto", offset, limit: 1_000 });
    chunks.push(chunk.text);
    expect(chunk.text).not.toMatch(/^\]\(/);
    if (!chunk.hasMore) break;
    expect(automatic.text.slice(chunk.nextOffset - 2, chunk.nextOffset)).toBe("\n\n");
    offset = chunk.nextOffset;
  }
  expect(chunks.join("")).toBe(automatic.text);
});

test("auto requests complete page content while article mode may return a targeted candidate", async ({ page }) => {
  const cards = Array.from({ length: 8 }, (_, index) => `
    <a class="result-link" href="/reports/${index}">
      <article class="result-card">
        <h2>Result ${index}</h2>
        <p>${`Card ${index} contains a substantial linked summary with evidence and context for the reader. `.repeat(5)}</p>
      </article>
    </a>
  `).join("");
  await installContentScript(page, `
    <main class="main-content">
      <h1>All current reports</h1>
      <div class="result-grid">${cards}</div>
    </main>
  `);
  await page.evaluate(() => {
    window.QingzhouArticleExtractor = Object.freeze({
      extract(_document, { complete = false } = {}) {
        if (complete) {
          const main = document.querySelector("main");
          return {
            name: "body",
            content: main.outerHTML,
            text: main.innerText,
          };
        }
        const card = document.querySelector(".result-card");
        return {
          name: "fixture-first-card",
          content: card.outerHTML,
          text: card.innerText,
        };
      },
    });
  });

  const forced = await readArticle(page, { source: "article", limit: 20_000 });
  expect(forced.text).toContain("Result 0");
  expect(forced.text).not.toContain("Result 7");

  const automatic = await readArticle(page, { source: "auto", limit: 20_000 });
  expect(automatic.mode).toBe("body");
  expect(automatic.text).toContain("All current reports");
  expect(automatic.text).toContain("Result 0");
  expect(automatic.text).toContain("Result 7");
});

test("complete extraction never shrinks an already complete heterogeneous feed to its only article", async ({ page }) => {
  const card = index => `Card ${index} has distinct context and evidence for readers. `.repeat(8);
  await installContentScript(page, `
    <article class="card"><h2>Story 1</h2><p>${card(1)}</p></article>
    ${[2, 3, 4, 5, 6].map(index => `
      <div class="card"><h2>Story ${index}</h2><p>${card(index)}</p></div>
    `).join("")}
  `);

  const result = await page.evaluate(() => {
    const targeted = window.QingzhouArticleExtractor.extract(document, { complete: false });
    const complete = window.QingzhouArticleExtractor.extract(document, { complete: true });
    return {
      targetedLength: targeted?.length || 0,
      completeLength: complete?.length || 0,
      completeText: complete?.text || "",
    };
  });
  expect(result.completeText).toContain("Card 1 has distinct context");
  expect(result.completeText).toContain("Story 6");
  expect(result.completeLength).toBeGreaterThanOrEqual(result.targetedLength);
});

test("complete extraction stays monotonic when the central-root guess excludes sibling modules", async ({ page }) => {
  const prose = (label, count) => `${label} verified context and evidence for readers. `.repeat(count);
  await installContentScript(page, `
    <article>
      <h2>Lead</h2>
      <p id="lead">${prose("Lead opening", 3)}</p>
      <p>${prose("Lead remainder", 22)}</p>
    </article>
    <div id="second"><h2>Second</h2><p>${prose("Second module", 45)}</p></div>
    <div id="third"><h2>Third</h2><p>${prose("Third module", 45)}</p></div>
  `);

  const result = await page.evaluate(() => {
    const lead = document.querySelector("#lead");
    const second = document.querySelector("#second");
    const third = document.querySelector("#third");
    const readability = {
      content: `<p>${lead.textContent}</p>${second.outerHTML}${third.outerHTML}`,
      textContent: [lead.textContent, second.innerText, third.innerText].join("\n"),
    };
    const targeted = window.QingzhouArticleExtractor.extract(document, { readability, complete: false });
    const complete = window.QingzhouArticleExtractor.extract(document, { readability, complete: true });
    return {
      targetedLength: targeted?.length || 0,
      completeLength: complete?.length || 0,
      completeText: complete?.text || "",
    };
  });
  expect(result.completeText).toContain("Third module");
  expect(result.completeLength).toBeGreaterThanOrEqual(result.targetedLength);
});

test("auto reading keeps a dominant ordinary article beside repeated related links", async ({ page }) => {
  const prose = "The primary investigation documents the event, evidence, chronology, and implications in full. ".repeat(24);
  const related = Array.from({ length: 4 }, (_, index) => `
    <a class="related-card" href="/related/${index}"><h3>Related report ${index}</h3><p>Short related summary.</p></a>
  `).join("");
  await installContentScript(page, `
    <main>
      <section class="content"><h1>Primary investigation</h1><p>${prose}</p></section>
      <section class="related-grid">${related}</section>
    </main>
  `);

  const automatic = await readArticle(page, { source: "auto", limit: 20_000 });
  expect(automatic.mode).toBe("article");
  expect(await page.evaluate(selector => (
    document.querySelector(selector)?.classList.contains("content") || false
  ), automatic.sourceSelector)).toBe(true);
  expect(automatic.text).toContain("Primary investigation");
  expect(automatic.text).toContain("chronology, and implications in full");
  expect(automatic.text).not.toContain("Related report 3");
});

test("read_article converts block-level card links into valid title links", async ({ page }) => {
  await page.route("https://example.test/cover.jpg", route => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    body: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==", "base64"),
  }));
  await installContentScript(page, `
    <main class="main-content">
      <a class="card" href="/reports/one">
        <article>
          <h2>First field report</h2>
          <p>The first summary remains ordinary card content.</p>
        </article>
      </a>
      <a class="card" href="/reports/two">
        <div>
          <img src="/cover.jpg" alt="Second report cover">
          <p>Second field report</p>
          <p>The second summary also remains readable.</p>
        </div>
      </a>
    </main>
  `);

  const result = await readArticle(page, { source: "selector", selector: ".main-content", limit: 20_000 });
  expect(result.text).toContain("## [First field report](https://example.test/reports/one)");
  expect(result.text).toContain("[Second field report](https://example.test/reports/two)");
  expect(result.text).toContain("The first summary remains ordinary card content.");
  expect(result.text).toContain("The second summary also remains readable.");
  expect(result.text).not.toMatch(/^\s*\]\(/m);
  expect(result.text).not.toMatch(/\[\s*\n/);
});

test("read_article keeps definition-list media links valid", async ({ page }) => {
  await page.route("https://example.test/images/deep-sea.jpg", route => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    body: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==", "base64"),
  }));
  await installContentScript(page, `
    <article>
      <a href="/videos/deep-sea">
        <dt><img src="/images/deep-sea.jpg" alt="深海观测视频"></dt>
      </a>
    </article>
  `);

  const result = await readArticle(page, { source: "selector", selector: "article", limit: 20_000 });
  expect(result.text).toContain(
    "[![深海观测视频](https://example.test/images/deep-sea.jpg)](https://example.test/videos/deep-sea)",
  );
  expect(result.text).not.toMatch(/^\[$|^\]\([^\n]+\)$/m);
});

test("read_article keeps definition-list text links and their destinations", async ({ page }) => {
  await installContentScript(page, `
    <article>
      <a href="/terms/temperature"><dt>海水温度</dt></a>
      <a href="/definitions/continuous"><dd>连续观测得到的定义正文</dd></a>
    </article>
  `);

  const result = await readArticle(page, { source: "selector", selector: "article", limit: 20_000 });
  expect(result.text).toContain("[海水温度](https://example.test/terms/temperature)");
  expect(result.text).toContain("[连续观测得到的定义正文](https://example.test/definitions/continuous)");
  expect(result.linkCount).toBe(2);
  expect(result.text).not.toMatch(/^\[$|^\]\([^\n]+\)$/m);
});

test("auto reading treats duplicate semantic article roots as one responsive article", async ({ page }) => {
  const story = "The primary report explains the observed event, its evidence, and the consequences for readers. ".repeat(18);
  await installContentScript(page, `
    <div class="article-content"><h1>Primary report</h1><p>${story}</p></div>
    <div class="article-content"><h1>Primary report</h1><p>${story}</p></div>
    <main class="next-article"><h2>Next report</h2><p>A shorter related report should not replace the primary story.</p></main>
  `);

  const automatic = await readArticle(page, { source: "auto", limit: 20_000 });
  expect(automatic.mode).toBe("article");
  expect(automatic.sourceSelector).toContain("article-content");
  expect(automatic.text).toContain("Primary report");
  expect(automatic.text).toContain("observed event");
});

test("rule recovery adds missing text without duplicating the selected region", async ({ page }) => {
  const primary = "This primary paragraph belongs to the selected article and must occur exactly once. ".repeat(2);
  const recovered = "This continuation sits outside the detected wrapper and should be recovered once. ".repeat(2);
  await installContentScript(page, `
    <div class="article-content"><h1>Short article</h1><p>${primary}</p></div>
    <p>${recovered}</p>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.name).toBe("rules");
  expect(candidate.length).toBeGreaterThan(250);
  expect(candidate.text.match(/This primary paragraph/g)).toHaveLength(2);
  expect(candidate.text.match(/This continuation sits/g)).toHaveLength(2);
  expect(candidate.content.match(/This primary paragraph/g)).toHaveLength(2);
  expect(candidate.content.match(/This continuation sits/g)).toHaveLength(2);
});

test("the staged comparison selects and sanitizes a materially better Readability candidate", async ({ page }) => {
  const local = "A local candidate contains valid prose but deliberately covers only a small part of the document. ".repeat(4);
  const recovered = "The comparison candidate restores the complete headed article with substantially more useful context. ".repeat(12);
  await installContentScript(page, `<div class="article-content"><p>${local}</p></div>`);

  const candidate = await extractCandidate(page, {
    content: `<article><h2>Recovered heading</h2><p>${recovered}</p><nav>Readability navigation noise</nav></article>`,
    textContent: `Recovered heading ${recovered} Readability navigation noise`,
  });
  expect(candidate.name).toBe("readability");
  expect(candidate.headingCount).toBe(1);
  expect(candidate.text).toContain("Recovered heading");
  expect(candidate.text).not.toContain("Readability navigation noise");
  expect(candidate.content).not.toContain("<nav");
});

test("link-rich repeated cards remain a valid editorial collection", async ({ page }) => {
  const cards = Array.from({ length: 8 }, (_, index) => `
    <li class="result-card">
      <a href="/reports/${index}"><h2>Field report ${index}: a material development</h2></a>
      <p>Summary ${index} explains the event, its source, and why the result matters.</p>
    </li>
  `).join("");
  await installContentScript(page, `
    <main class="main-content"><h1>Latest field reports</h1><ul class="results">${cards}</ul></main>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.name).toBe("rules");
  expect(candidate.text).toContain("Latest field reports");
  expect(candidate.text).toContain("Field report 0");
  expect(candidate.text).toContain("Field report 7");
  expect(candidate.text).toContain("Summary 7 explains");
});

test("read_article preserves block-linked search result headings and their URLs", async ({ page }) => {
  const cards = Array.from({ length: 8 }, (_, index) => `
    <div class="search-result">
      <a href="${index === 3 ? 'file:///tmp/report.html' : `https://result${index}.example/article`}">
        <h3><span>React library result ${index + 1}</span></h3>
        <div class="result-source">result${index}.example</div>
      </a>
      <div class="result-snippet">Result ${index + 1} explains the library API, examples, compatibility, and supporting documentation for developers.</div>
    </div>
  `).join("");
  await installContentScript(page, `<main><h1>Search results</h1>${cards}</main>`);

  const result = await readArticle(page, { source: "auto", limit: 20_000 });
  expect(result.text).toContain("### [React library result 1](https://result0.example/article)");
  expect(result.text).toContain("### [React library result 8](https://result7.example/article)");
  expect(result.text).toContain("### [React library result 4](file:///tmp/report.html)");
  expect(result.text).toContain("Result 8 explains the library API");
  expect(result.outline).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: 3, title: "React library result 1" }),
    expect.objectContaining({ level: 3, title: "React library result 8" }),
  ]));
});

test("short navigation link farms do not outrank prose", async ({ page }) => {
  const links = ["Home", "News", "Markets", "Sports", "Video", "Weather", "Login", "Apps", "Help", "About"]
    .map((label, index) => `<a href="/nav/${index}">${label}</a>`).join("");
  const prose = "The published analysis explains the finding with independently verified evidence and complete context. ".repeat(8);
  await installContentScript(page, `
    <main id="main-navigation">${links}</main>
    <article><h1>Verified analysis</h1><p>${prose}</p></article>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("Verified analysis");
  expect(candidate.text).toContain("independently verified evidence");
  expect(candidate.text).not.toContain("Markets Sports Video");
});

test("structured linked tables survive link-density cleanup", async ({ page }) => {
  const rows = Array.from({ length: 6 }, (_, index) => `
    <tr><td><a href="/regions/${index}">Region ${index} annual result</a></td><td>${120 + index}</td><td>Verified source record</td></tr>
  `).join("");
  await installContentScript(page, `
    <main class="main-content">
      <h1>Regional results</h1>
      <table><thead><tr><th>Region</th><th>Count</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    </main>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("Regional results");
  expect(candidate.text).toContain("Region 0 annual result");
  expect(candidate.text).toContain("Region 5 annual result");
  expect(candidate.text).toContain("Verified source record");
  expect(candidate.tableCount).toBe(1);
});

test("paragraph classification rescues div-buried prose and rejects link-only chrome", async ({ page }) => {
  const first = "This section explains how the system works and why the result is reliable for readers who need the complete account. ".repeat(3);
  const second = "The following section provides the evidence, the limitations, and the context that an accurate extraction should preserve. ".repeat(3);
  await installContentScript(page, `
    <div class="copy-block">${first}</div>
    <div class="utility-links"><a href="/a">Account</a> <a href="/b">Settings</a> <a href="/c">Support</a></div>
    <div class="copy-block">${second}</div>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.name).toBe("paragraph-rescue");
  expect(candidate.paragraphCount).toBe(2);
  expect(candidate.text).toContain("how the system works");
  expect(candidate.text).toContain("provides the evidence");
  expect(candidate.text).not.toContain("Account Settings Support");
});

test("Han-dominant pages keep prose while dropping utility links", async ({ page }) => {
  const chinese = "这段正文解释系统如何工作，并给出用户需要的完整证据、限制条件和上下文。".repeat(5);
  const japanese = "この段落は抽出結果の根拠を説明し、読者が必要とする背景と制約を明確に示します。".repeat(5);
  const korean = "이 문단은 추출 결과의 근거를 설명하고 독자에게 필요한 배경과 제한 사항을 제공합니다.".repeat(5);
  await installContentScript(page, `
    <div class="copy-block">${chinese}</div>
    <div class="utility-links"><a href="/a">首页</a><a href="/b">登录</a><a href="/c">下载</a><a href="/d">客服</a></div>
    <div class="copy-block">${japanese}</div>
    <div class="copy-block">${korean}</div>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("这段正文解释系统如何工作");
  expect(candidate.text).toContain("この段落は抽出結果の根拠を説明");
  expect(candidate.text).toContain("이 문단은 추출 결과의 근거를 설명");
  expect(candidate.text).not.toContain("首页 登录 下载 客服");
});

test("repeated content cards keep titles from an internal footer region", async ({ page }) => {
  const cards = Array.from({ length: 8 }, (_, index) => `
    <article class="content-card">
      <img alt="专题封面 ${index + 1}">
      <div class="footer">
        <a class="card-title" href="/stories/${index}">专题观察 ${index + 1}：普通卡片底部仍然承载用户要阅读的标题、事实背景与关键结论</a>
        <span class="author">作者 ${index + 1}</span>
      </div>
    </article>
  `).join("");
  await installContentScript(page, `
    <div class="utility-links">账户设置 下载客户端 联系客服</div>
    <main class="feed-content"><h1>专题列表</h1>${cards}</main>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("专题观察 1：普通卡片底部仍然承载用户要阅读的标题");
  expect(candidate.text).toContain("专题观察 8：普通卡片底部仍然承载用户要阅读的标题");
});

test("repeated registration records in a side column do not outrank the main collection", async ({ page }) => {
  const records = Array.from({ length: 6 }, (_, index) => `
    <div class="registration-record">
      <p>备案记录 ${index + 1}：增值业务经营许可证、网络服务备案号、举报电话与办公地址。</p>
      <a href="/licenses/${index}">查看备案 ${index + 1}</a>
    </div>
  `).join("");
  const stories = Array.from({ length: 8 }, (_, index) => `
    <article class="story-card">
      <h2>行业专题 ${index + 1}</h2>
      <p>这篇内容介绍第 ${index + 1} 项行业变化，包含事实背景、关键证据、影响范围和后续判断。</p>
    </article>
  `).join("");
  await installContentScript(page, `
    <div class="layout">
      <div class="side-bar"><div class="registration-list">${records}</div></div>
      <main class="main-content"><h1>行业专题集合</h1>${stories}</main>
    </div>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("行业专题 1");
  expect(candidate.text).toContain("第 8 项行业变化");
  expect(candidate.text).not.toContain("增值业务经营许可证");
  expect(candidate.text).not.toContain("举报电话与办公地址");
});

test("complete extraction on Han-dominant collections preserves sibling cards outside the targeted candidate", async ({ page }) => {
  const cards = Array.from({ length: 6 }, (_, index) => `
    <article class="result-card">
      <div class="footer">
        <a href="/results/${index}">集合条目 ${index + 1}：${"这条记录提供独立的事实背景、证据来源、影响范围和后续结论。".repeat(4)}</a>
      </div>
    </article>
  `).join("");
  await installContentScript(page, `
    <main class="main-content">
      <p class="page-introduction">本页汇总多个独立条目，读者需要完整浏览集合中的每一项内容。${"完整集合说明。".repeat(18)}</p>
      <section class="result-grid">${cards}</section>
    </main>
  `);

  const result = await page.evaluate(() => {
    const first = document.querySelector(".result-card");
    const readability = {
      content: first.outerHTML,
      textContent: first.innerText,
    };
    const targeted = window.QingzhouArticleExtractor.extract(document, { readability, complete: false });
    const complete = window.QingzhouArticleExtractor.extract(document, { readability, complete: true });
    return {
      targetedLength: targeted?.length || 0,
      completeLength: complete?.length || 0,
      completeText: complete?.text || "",
    };
  });

  expect(result.completeText).toContain("集合条目 1");
  expect(result.completeText).toContain("集合条目 6");
  expect(result.completeLength).toBeGreaterThanOrEqual(result.targetedLength);
});

test("mixed-language pages keep both the primary prose and embedded CJK text", async ({ page }) => {
  const english = "The published explanation covers the complete evidence, limitations, and context readers require. ".repeat(12);
  const chinese = "文中引用了一段中文说明，用于验证混合语言页面仍走规则级联。";
  await installContentScript(page, `
    <article><p>${english}</p><p>${chinese}</p></article>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("complete evidence");
  expect(candidate.text).toContain("混合语言页面仍走规则级联");
});

test("embedded JSON full text is the baseline when the rendered page has no article body", async ({ page }) => {
  await page.route("https://example.test/extraction-probe", route => route.fulfill({ status: 404, body: "missing" }));
  const embedded = "The embedded article body is available before the client application renders its visible content. ".repeat(4);
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    articleBody: `&lt;p&gt;${embedded}&lt;/p&gt;&lt;img src="/extraction-probe" onerror="window.__extractionProbe = true"&gt;`,
  });
  await installContentScript(page, `<div id="app"></div><script type="application/ld+json">${json}</script>`);

  const candidate = await extractCandidate(page);
  expect(candidate.name).toBe("baseline-json");
  expect(candidate.text).toContain("embedded article body");
  expect(candidate.text).not.toContain("&lt;p&gt;");

  const result = await readArticle(page, { source: "article", limit: 20_000 });
  expect(result.text).toContain("embedded article body");
  expect(result.text).not.toContain("&lt;p&gt;");
  expect(result.sourceSelector).toBe("");
  expect(result.text).not.toContain("onerror");
  expect(await page.evaluate(() => window.__extractionProbe)).toBeUndefined();
});

test("comment sections stay out of ordinary articles but remain content on forum threads", async ({ page }) => {
  const mainText = "The published article contains the verified statement readers came to see. ".repeat(3);
  const commentText = "A reader comment must not leak into an ordinary article extraction. ".repeat(4);
  await installContentScript(page, `
    <article><p>${mainText}</p></article>
    <section id="comments"><p>${commentText}</p></section>
  `);
  const article = await extractCandidate(page);
  expect(article.text).toContain("verified statement");
  expect(article.text).not.toContain("reader comment");

  const forumSchema = JSON.stringify({ "@context": "https://schema.org", "@type": "DiscussionForumPosting" });
  await installContentScript(page, `
    <script type="application/ld+json">${forumSchema}</script>
    <section id="comments"><p>${commentText}</p></section>
  `);
  const forum = await extractCandidate(page);
  expect(forum.text).toContain("reader comment");
});

test("read_article converts the selected DOM fragment into the same Markdown contract", async ({ page }) => {
  await installContentScript(page, `
    <main>
      <section id="selected-section">
        <h2>Selected section</h2>
        <p>Keep <strong>this structure</strong> and <a href="/selected">its link</a>.</p>
        <table>
          <thead><tr><th>Item</th><th>State</th></tr></thead>
          <tbody><tr><td>Alpha</td><td>Ready</td></tr></tbody>
        </table>
      </section>
      <p id="outside">Do not include this paragraph.</p>
    </main>
  `);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#selected-section"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const result = await readArticle(page, { source: "selection", limit: 20_000 });
  expect(Object.hasOwn(result, "format")).toBe(false);
  expect(result.mode).toBe("selection");
  expect(result.sourceSelector).toBe("#selected-section");
  expect(result.text).toContain("## Selected section");
  expect(result.text).toContain("**this structure**");
  expect(result.text).toContain("[its link](https://example.test/selected)");
  expect(result.text).toContain("| Item | State |");
  expect(result.text).not.toContain("Do not include this paragraph");
  expect(result.outline).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: 2, title: "Selected section" }),
  ]));
});

test("read_article keeps complex tables as sanitized HTML", async ({ page }) => {
  await installContentScript(page, `
    <table id="complex" class="report" style="color:red" onclick="alert(1)">
      <caption>Quarterly sales <a href="file:///tmp/report.html">Local report</a></caption>
      <thead>
        <tr><th id="region" rowspan="2" scope="col">Region</th><th colspan="2">Sales</th></tr>
        <tr><th>Q1</th><th>Q2</th></tr>
      </thead>
      <tbody>
        <tr><td headers="region"><strong>East</strong> <em>zone</em> <abbr title="application programming interface">API</abbr><sub>2</sub><sup>3</sup></td><td><mark>10</mark> <q>verified</q></td><td><u>20</u> <span class="note">units</span><a href="javascript:alert(1)" onclick="alert(2)"> details</a><template><script>alert(3)</script></template></td></tr>
      </tbody>
    </table>
  `);

  const result = await readArticle(page, { source: "selector", selector: "#complex", limit: 20_000 });
  expect(Object.hasOwn(result, "format")).toBe(false);
  expect(result.text).toContain("<table>");
  expect(result.text).toContain('<caption>Quarterly sales <a href="file:///tmp/report.html">Local report</a></caption>');
  expect(result.text).toContain('rowspan="2"');
  expect(result.text).toContain('colspan="2"');
  expect(result.text).toContain('headers="region"');
  expect(result.text).toContain("<strong>East</strong> <em>zone</em>");
  expect(result.text).toContain("<abbr>API</abbr><sub>2</sub><sup>3</sup>");
  expect(result.text).toContain("<mark>10</mark> <q>verified</q>");
  expect(result.text).toContain("<u>20</u> <span>units</span><a> details</a>");
  expect(result.text).not.toMatch(/onclick|style=|javascript:|template|script/i);

  await page.setContent(`
    <base href="https://example.test/articles/">
    <table id="pipe"><thead><tr><th>Expression</th></tr></thead><tbody><tr><td>a | b</td></tr></tbody></table>
  `);
  const pipeResult = await readArticle(page, { source: "selector", selector: "#pipe", limit: 20_000 });
  expect(pipeResult.text).toContain("<table>");
  expect(pipeResult.text).toContain("a | b");
  expect(pipeResult.text).not.toContain("| Expression |");
});

test("read_article falls back to escaped Markdown when the serializer fails", async ({ page }) => {
  await installContentScript(page, `
    <article id="story"><h1>Fallback *heading*</h1><p>Literal [brackets] &amp; punctuation!</p></article>
  `);
  await page.evaluate(() => {
    const parse = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function(source, type) {
      if (source.includes("x-turndown")) throw new Error("fixture serializer failure");
      return parse.call(this, source, type);
    };
  });

  const result = await readArticle(page, { source: "selector", selector: "#story", limit: 20_000 });
  expect(Object.hasOwn(result, "format")).toBe(false);
  expect(result.text).toContain("Fallback \\*heading\\*");
  expect(result.text).toContain("Literal \\[brackets\\] \\& punctuation\\!");
  expect(result.text).not.toContain("# Fallback");
});

test("a tiny footer article never hijacks the central content root", async ({ page }) => {
  const prose = "Token Plan 个人版是面向个人开发者的 AI 大模型订阅服务，以 Credits 统一计量，支持文本与多模态模型。".repeat(4);
  await installContentScript(page, `
    <main class="aliyun-docs-view" id="aliyun-docs-view">
      <nav class="side-nav"><a href="/a">目录一</a><a href="/b">目录二</a></nav>
      <section class="aliyun-docs-content">
        <div class="icms-help-docs-content">
          <main id="main-tp-personal-ov">
            <h1>Token Plan 个人版概述</h1>
            ${[1, 2, 3, 4, 5, 6].map(index => `<p>${index}. ${prose}</p>`).join("\n")}
          </main>
        </div>
      </section>
    </main>
    <div class="site-footer">
      <article class="abc123_focus">关注阿里云关注阿里云公众号或下载阿里云APP，随时随地运维管控云服务</article>
    </div>
  `);

  const result = await page.evaluate(() => {
    const candidate = window.QingzhouArticleExtractor.extract(document, { complete: true });
    return candidate ? { name: candidate.name, text: candidate.text, length: candidate.length } : null;
  });
  expect(result).toBeTruthy();
  expect(result.text).toContain("Token Plan 个人版概述");
  expect(result.length).toBeGreaterThan(1_000);
  expect(result.text).not.toContain("关注阿里云");
});
