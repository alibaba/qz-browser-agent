import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures.mjs";
import { stableCapture } from "../design-system/comparison.mjs";

const vendor = "/extension/vendor/mathjax/startup.js";
let host;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import { createMathFeature } from "./src/sidepanel/features/chat/math-feature.ts";
      import { renderMarkdown } from "./src/sidepanel/features/chat/markdown-feature.ts";
      window.mathTest = { createMathFeature, renderMarkdown };
    `, resolveDir: process.cwd() },
    bundle: true, format: "iife", write: false, target: "chrome114",
  });
  host = result.outputFiles[0].text;
});

async function openFixture(page, { eager = false } = {}) {
  await page.route("**/tests/math-runtime/panel.html", route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html><head>
      <base href="/extension/sidepanel/">
      <link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">
      <script src="/extension/shared/mathjax-config.js"></script>
      ${eager ? `<script id="MathJax-script" src="${vendor}"></script>` : ""}
      <style>body{padding:20px;display:block}.sample{width:340px;padding:12px}</style>
    </head><body></body></html>`,
  }));
  await page.goto("/tests/math-runtime/panel.html");
  await page.addScriptTag({ content: host });
  await page.evaluate(eager => {
    window.features = {};
    window.addFormula = (id, markdown) => {
      const element = document.createElement("div"); element.id = id;
      element.className = "sample msg-assistant";
      element.innerHTML = `<div class="msg-content">${window.mathTest.renderMarkdown(markdown)}</div>`;
      document.body.append(element);
      for (const formula of element.querySelectorAll(".math-formula")) formula.dataset.testSample = id;
      const controller = new AbortController();
      const feature = window.mathTest.createMathFeature({ signal: controller.signal });
      window.features[id] = { element, feature, controller };
      if (eager) {
        const targets = [...element.querySelectorAll(".math-formula")];
        window.MathJax.startup.promise.then(() => window.MathJax.typesetPromise(targets))
          .then(() => { for (const target of targets) target.dataset.mathRendered = "true"; });
      } else feature.schedule(element);
    };
  }, eager);
}

const readyRuntime = `window.calls = []; window.MathJax = {
  startup: { promise: Promise.resolve() },
  typesetPromise: async targets => { window.calls.push(targets.map(node => node.dataset.testSample)); },
  typesetClear() {}
};`;

test("plain text and unfinished formulas do not load MathJax", async ({ page }) => {
  let requests = 0;
  page.on("request", request => { if (request.url().endsWith(vendor)) requests += 1; });
  await openFixture(page);
  await page.evaluate(async () => {
    window.addFormula("plain", "A normal reply without mathematics.");
    const pending = document.createElement("div");
    pending.innerHTML = '<span class="math-formula" data-math-pending="true">$x</span>';
    document.body.append(pending);
    const feature = window.mathTest.createMathFeature(); feature.schedule(pending); await feature.flush();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect(requests).toBe(0);
  expect(await page.locator(`script[src$="startup.js"]`).count()).toBe(0);
});

test("concurrent consumers share one load and wait for startup", async ({ page }) => {
  let requests = 0;
  await page.route(`**${vendor}`, route => {
    requests += 1;
    return route.fulfill({ contentType: "application/javascript", body: readyRuntime.replace(
      "Promise.resolve()", "new Promise(resolve => { window.finishStartup = resolve; })",
    ) });
  });
  await openFixture(page);
  await page.evaluate(() => { window.addFormula("first", "$x^2$"); window.addFormula("second", "$y^2$"); });
  await expect.poll(() => page.evaluate(() => typeof window.finishStartup)).toBe("function");
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  expect(requests).toBe(1);
  await page.evaluate(() => window.finishStartup());
  await expect(page.locator("[data-math-rendered=true]")).toHaveCount(2);
  expect((await page.evaluate(() => window.calls)).flat().sort()).toEqual(["first", "second"]);
  await page.evaluate(() => window.addFormula("third", "$z^2$"));
  await expect(page.locator("[data-math-rendered=true]")).toHaveCount(3);
  expect(requests).toBe(1);
});

test("removed, cleared and disposed formulas cannot claim a late load", async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**${vendor}`, async route => { await gate; await route.fulfill({ contentType: "application/javascript", body: readyRuntime }); });
  await openFixture(page);
  await page.evaluate(() => {
    for (const id of ["removed", "cleared", "disposed"]) window.addFormula(id, "$x^2$");
  });
  await expect(page.locator("[data-math-rendering=true]")).toHaveCount(3);
  const before = await page.evaluate(() => {
    window.features.removed.element.remove();
    window.features.cleared.feature.clear(window.features.cleared.element);
    window.features.disposed.controller.abort();
    return Object.fromEntries(Object.entries(window.features).map(([id, value]) => [id, value.element.innerHTML]));
  });
  release();
  await expect.poll(() => page.evaluate(() => Boolean(window.calls))).toBe(true);
  await page.evaluate(() => window.addFormula("current", "$y^2$"));
  await expect(page.locator("#current [data-math-rendered=true]")).toHaveCount(1);
  expect((await page.evaluate(() => window.calls)).flat()).toEqual(["current"]);
  const after = await page.evaluate(() => Object.fromEntries(Object.entries(window.features)
    .filter(([id]) => id !== "current").map(([id, value]) => [id, value.element.innerHTML])));
  expect(after).toEqual(before);
});

for (const failure of ["resource failure", "uninitialized", "startup rejection"]) {
  test(`${failure} falls back and a later formula retries`, async ({ page, browserDiagnostics }) => {
    let requests = 0;
    await page.route(`**${vendor}`, route => {
      requests += 1;
      if (requests === 1 && failure === "resource failure") return route.abort("failed");
      const failed = failure === "uninitialized" ? "/* incomplete resource */" : `${readyRuntime}
        window.MathJax.startup.promise = Promise.reject(new Error("startup failed"));
        window.MathJax.startup.promise.catch(() => {});`;
      return route.fulfill({ contentType: "application/javascript", body: requests === 1 ? failed : readyRuntime });
    });
    await openFixture(page);
    await page.evaluate(() => window.addFormula("failed", "$x^2$"));
    await expect(page.locator("#failed .math-fallback")).toHaveText("x^2");
    if (failure === "resource failure") {
      expect(browserDiagnostics.consoleErrors).toHaveLength(1);
      expect(browserDiagnostics.consoleErrors[0]).toContain("net::ERR_FAILED");
      browserDiagnostics.consoleErrors.length = 0;
    }
    await page.evaluate(async () => {
      window.features.failed.feature.schedule(window.features.failed.element);
      await window.features.failed.feature.flush();
    });
    expect(requests).toBe(1);
    await page.evaluate(() => window.addFormula("retry", "$y^2$"));
    await expect(page.locator("#retry [data-math-rendered=true]")).toHaveCount(1);
    expect(requests).toBe(2);
    expect((await page.evaluate(() => window.calls)).flat()).toEqual(["retry"]);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`late typesetting ${outcome} cannot overwrite a cleared projection`, async ({ page }) => {
    await page.route(`**${vendor}`, route => route.fulfill({ contentType: "application/javascript", body: `${readyRuntime}
      window.MathJax.typesetPromise = () => new Promise((resolve, reject) => { window.finishTypeset = { resolve, reject }; });` }));
    await openFixture(page);
    await page.evaluate(() => window.addFormula("current", "$x^2$"));
    await expect.poll(() => page.evaluate(() => typeof window.finishTypeset)).toBe("object");
    await page.evaluate(async outcome => {
      const { feature, element } = window.features.current;
      feature.clear(element); element.querySelector(".math-formula").textContent = "replacement";
      window.finishTypeset[outcome](new Error("late completion"));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, outcome);
    await expect(page.locator("#current .math-formula")).toHaveText("replacement");
    expect(await page.locator("#current [data-math-rendered], #current .math-fallback").count()).toBe(0);
  });
}

async function pauseRealMathDependency(page) {
  await page.addScriptTag({ url: vendor });
  await page.evaluate(async () => {
    await window.MathJax.startup.promise;
    const document = window.MathJax.startup.document;
    const render = document.render.bind(document);
    let first = true;
    document.render = () => {
      if (first) {
        first = false;
        const error = new Error("delayed MathJax dependency");
        error.retry = new Promise((resolve, reject) => { window.finishDependency = { resolve, reject }; });
        throw error;
      }
      return render();
    };
  });
}

for (const cancellation of ["clear", "remove", "dispose"]) {
  test(`real MathJax dependency completion cannot write after ${cancellation}`, async ({ page }) => {
    await openFixture(page);
    await pauseRealMathDependency(page);
    await page.evaluate(() => {
      window.addFormula("old", "$x^2$");
      window.pending = window.features.old.feature.flush();
      window.originalFormula = window.features.old.element.querySelector(".math-formula");
    });
    await expect.poll(() => page.evaluate(() => typeof window.finishDependency)).toBe("object");
    const before = await page.evaluate(cancellation => {
      const { feature, element } = window.features.old;
      if (cancellation === "clear") feature.clear(element);
      if (cancellation === "remove") element.remove();
      if (cancellation === "dispose") feature.dispose();
      window.originalFormula.textContent = String.raw`\(replacement\)`;
      return window.originalFormula.outerHTML;
    }, cancellation);
    await page.evaluate(async () => { window.finishDependency.resolve(); await window.pending; });
    expect(await page.evaluate(() => window.originalFormula.outerHTML)).toBe(before);
    expect(await page.evaluate(() => [...window.MathJax.startup.document.math].length)).toBe(0);
    expect(await page.locator("body > [aria-hidden=true]").count()).toBe(0);
    await page.evaluate(() => window.addFormula("new", "$y^2$"));
    await expect(page.locator("#new mjx-container svg")).toHaveCount(1);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`real MathJax serializes different features and continues after dependency ${outcome}`, async ({ page }) => {
    await openFixture(page);
    await pauseRealMathDependency(page);
    await page.evaluate(() => {
      window.addFormula("first", "$x^2$"); window.firstRender = window.features.first.feature.flush();
    });
    await expect.poll(() => page.evaluate(() => typeof window.finishDependency)).toBe("object");
    await page.evaluate(async () => {
      window.addFormula("second", "$y^2$"); window.secondRender = window.features.second.feature.flush();
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(await page.locator("#first svg, #second svg").count()).toBe(0);
    await page.evaluate(async outcome => {
      window.finishDependency[outcome](new Error("dependency unavailable"));
      await Promise.all([window.firstRender, window.secondRender]);
    }, outcome);
    if (outcome === "resolve") await expect(page.locator("#first mjx-container svg")).toHaveCount(1);
    else await expect(page.locator("#first .math-fallback")).toHaveText("x^2");
    await expect(page.locator("#second mjx-container svg")).toHaveCount(1);
    expect(await page.evaluate(() => [...window.MathJax.startup.document.math].length)).toBe(0);
    expect(await page.locator("body > [aria-hidden=true]").count()).toBe(0);
  });
}

test("local components render fraction, chemistry, and bold math without remote requests", async ({ page }) => {
  const remote = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") remote.push(request.url());
  });
  await openFixture(page);
  await page.evaluate(() => window.addFormula("sample", String.raw`$\frac{1}{2}$ $\ce{H2O}$ $\bm{v}$`));
  await expect(page.locator("#sample mjx-container svg")).toHaveCount(3);
  await expect(page.locator("#sample mjx-merror")).toHaveCount(0);
  const marks = await page.evaluate(() => [...document.querySelectorAll("#sample svg")].map(svg => ({
    red: svg.innerHTML.includes('fill="red"'),
    glyphs: [...svg.querySelectorAll("[id]")].map(node => node.id).filter(id => id.includes("TEX")),
  })));
  expect(marks.every(mark => mark.red === false)).toBe(true);
  expect(marks[2].glyphs.some(id => id.endsWith("TEX-BI-1D497"))).toBe(true);
  const contained = await page.evaluate(() => [...document.querySelectorAll("#sample svg")].every(svg => {
    const uses = [...svg.querySelectorAll("use")];
    return Boolean(svg.querySelector("path, use")) && uses.every(use => {
      const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
      return href.startsWith("#") && Boolean(svg.querySelector(`#${CSS.escape(href.slice(1))}`));
    });
  }));
  expect(contained).toBe(true);
  expect(remote).toEqual([]);
});

test("exported html embeds self-contained formulas and opens offline", async ({ page }, testInfo) => {
  const remote = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") remote.push(request.url());
  });
  await page.route("**/tests/math-runtime/export.html", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><base href="/extension/sidepanel/">
      <script src="/extension/shared/mathjax-config.js"></script>
    </head><body></body></html>`,
  }));
  await page.goto("/tests/math-runtime/export.html");
  const html = await page.evaluate(async () => {
    const css = await fetch("/extension/sidepanel/sidepanel.css").then(response => response.text());
    const { createSessionExportFeature } = await import("/extension/sidepanel/features/export/session-export-feature.js");
    const feature = createSessionExportFeature({
      request: async () => ({ payload: {} }),
      renderChatHtml: () => '<p><span class="math-formula math-inline">\\(\\frac{1}{2}\\)</span> <span class="math-formula math-inline">\\(\\ce{H2O}\\)</span> <span class="math-formula math-display">\\[\\bm{v}\\]</span></p>',
      fetchStylesheet: async () => ({ ok: true, status: 200, text: async () => css }),
      runtime: {
        getURL: path => new URL(`/extension/${String(path).replace(/^\/+/, "")}`, location.origin).href,
        getManifest: () => ({ version: "0.1.5" }),
      },
    });
    const result = await feature.createDocumentFromSnapshot({
      session: { id: "offline-math", title: "Offline formulas" },
      transcript: [{ type: "assistant", content: "formulas" }],
      appVersion: "0.1.5",
      exportedAt: "2026-10-24 00:00:00",
    });
    return result.html;
  });
  expect(html).not.toMatch(/<script\s[^>]*\bsrc=/i);
  expect(html).not.toMatch(/chrome-extension:|moz-extension:|cdn\.jsdelivr|registry\.npmmirror|unpkg\.com/i);
  expect(html).not.toMatch(/url\(\s*['"]?(?!data:|#)[^)'"]+/i);
  expect(html).toContain('id="qingzhou-session-exchange"');
  expect(html).toContain('"format":"qingzhou.session"');
  expect(html).toContain('"version":1');
  expect(html.match(/<svg\b/gi)?.length).toBe(3);
  expect(html).not.toMatch(/fill="red"/);
  expect(html).toContain("TEX-BI-1D497");
  expect(remote).toEqual([]);
  await writeFile(testInfo.outputPath("export-offline.html"), html);
  const offline = await page.context().newPage();
  const loads = [];
  const errors = [];
  offline.on("request", request => loads.push(request.url()));
  offline.on("pageerror", error => errors.push(String(error)));
  await offline.setContent(html, { waitUntil: "load" });
  const boxes = await offline.locator("#messages svg").evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, bytes: node.outerHTML.length };
  }));
  expect(errors).toEqual([]);
  expect(loads.filter(url => /^https?:/u.test(url))).toEqual([]);
  expect(boxes).toHaveLength(3);
  expect(boxes.every(box => box.width > 2 && box.height > 2 && box.bytes > 80)).toBe(true);
  await offline.screenshot({ path: testInfo.outputPath("export-offline.png"), fullPage: true });
  await offline.close();
});

test("exported math keeps error color, table rules, labels, and template formulas", async ({ page }) => {
  await page.route("**/tests/math-runtime/export-styles.html", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><base href="/extension/sidepanel/">
      <script src="/extension/shared/mathjax-config.js"></script>
    </head><body></body></html>`,
  }));
  await page.goto("/tests/math-runtime/export-styles.html");
  const html = await page.evaluate(async () => {
    const css = await fetch("/extension/sidepanel/sidepanel.css").then(response => response.text());
    const { renderMathSvg } = await import("/extension/sidepanel/features/chat/math-runtime.js");
    const labeled = String.raw`E=mc^2\tag{1}\label{eq:emc}`;
    await renderMathSvg(labeled, true);
    const chatHtml = [
      String.raw`<span class="math-formula math-display">\[\begin{array}{cc|c}1&2&3\\4&5&6\end{array}\]</span>`,
      String.raw`<span class="math-formula math-display">\[\begin{unknownenv}x\end{unknownenv}\]</span>`,
      String.raw`<span class="math-formula math-display">\[E=mc^2\tag{1}\label{eq:emc}\]</span>`,
      String.raw`<template class="static-transcript-template"><span class="math-formula math-inline">\(a+b\)</span></template>`,
      String.raw`<span class="math-formula" data-math-pending="true">\(z\)</span>`,
    ].join("");
    const { createSessionExportFeature } = await import("/extension/sidepanel/features/export/session-export-feature.js");
    const feature = createSessionExportFeature({
      request: async () => ({ payload: {} }),
      renderChatHtml: () => chatHtml,
      fetchStylesheet: async () => ({ ok: true, status: 200, text: async () => css }),
      runtime: {
        getURL: path => new URL(`/extension/${String(path).replace(/^\/+/, "")}`, location.origin).href,
        getManifest: () => ({ version: "0.1.5" }),
      },
    });
    const result = await feature.createDocumentFromSnapshot({
      session: { id: "offline-math-styles", title: "Exported math styles" },
      transcript: [{ type: "assistant", content: "formulas" }],
      appVersion: "0.1.5",
      exportedAt: "2026-10-24 00:00:00",
    });
    return result.html;
  });
  expect(html).toMatch(/g\[data-mml-node="merror"\] > rect\[data-background\]\s*\{[^}]*fill:\s*yellow/);
  expect(html).toMatch(/<template[^>]*static-transcript-template[\s\S]*<svg\b/);
  expect(html).toContain('data-math-pending="true"');
  expect(html).toMatch(/data-math-pending="true">\\\(z\\\)/);
  expect(html).not.toMatch(/multiply defined/i);
  const offline = await page.context().newPage();
  try {
    for (const scheme of ["light", "dark"]) {
      await offline.emulateMedia({ colorScheme: scheme });
      await offline.setContent(html, { waitUntil: "load" });
      const styles = await offline.evaluate(() => {
        const backgrounds = [...document.querySelectorAll('g[data-mml-node="merror"] > rect[data-background]')];
        const lines = [...document.querySelectorAll('line[data-line]')];
        const label = [...document.querySelectorAll("#messages .math-formula")]
          .some(node => /multiply defined/i.test(node.textContent || ""));
        const templateSvg = Boolean(document.querySelector("template.static-transcript-template")?.content.querySelector("svg"));
        const pending = document.querySelector("[data-math-pending='true']")?.textContent || "";
        return {
          backgrounds: backgrounds.map(node => getComputedStyle(node).fill),
          lines: lines.map(node => getComputedStyle(node).strokeWidth),
          label,
          templateSvg,
          pending,
        };
      });
      expect(styles.backgrounds.length, scheme).toBeGreaterThan(0);
      expect(styles.backgrounds.every(fill => (
        fill === "rgb(255, 255, 0)" || fill === "yellow" || fill.startsWith("color(srgb 1 1 0)")
      )), scheme).toBe(true);
      expect(styles.lines.length, scheme).toBeGreaterThan(0);
      expect(styles.lines.every(width => width !== "0px"), scheme).toBe(true);
      expect(styles.label, scheme).toBe(false);
      expect(styles.templateSvg, scheme).toBe(true);
      expect(styles.pending, scheme).toBe("\\(z\\)");
    }
  } finally {
    await offline.close();
  }
});

for (const colorScheme of ["light", "dark"]) for (const scale of [1, 1.25]) {
  test(`real formulas match original direct rendering in ${colorScheme} mode at ${scale} scale`, async ({ page, context }, testInfo) => {
    const eager = await context.newPage();
    try {
      for (const [target, options] of [[page, {}], [eager, { eager: true }]]) {
        await target.emulateMedia({ colorScheme });
        await openFixture(target, options);
        await target.evaluate(scale => {
          window.addFormula("sample", String.raw`Inline $x^2 + y^2 = z^2$.

$$\frac{1}{2} + \sum_{i=1}^{n} i = \int_0^1 x^2\,dx$$` + "\n\n```math\nx = y + 1\n```");
          document.querySelector("#sample").style.setProperty("--chat-text-scale", String(scale));
        }, scale);
        await expect(target.locator("#sample mjx-container svg")).toHaveCount(3);
        await expect(target.locator("#sample [data-math-rendered=true]")).toHaveCount(3);
        await target.evaluate(() => document.fonts.ready);
      }
      expect(await page.locator("#sample").boundingBox()).toEqual(await eager.locator("#sample").boundingBox());
      const actual = await stableCapture(page.locator("#sample"), testInfo.outputPath("lazy.png"));
      const reference = await stableCapture(eager.locator("#sample"), testInfo.outputPath("eager.png"));
      for (const [name, capture] of [["lazy", actual], ["eager", reference]]) {
        await testInfo.attach(`${name}.png`, { path: capture.path, contentType: "image/png" });
      }
      expect((await readFile(actual.path)).equals(await readFile(reference.path)), "settled formulas match byte-for-byte").toBe(true);
    } finally { await eager.close(); }
  });
}
