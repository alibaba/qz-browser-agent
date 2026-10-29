import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures.mjs";
import { stableCapture } from "../design-system/comparison.mjs";

const formulas = [
  String.raw`\(\frac{1}{2}+\sqrt{x}\)`,
  String.raw`\[\sum_{i=1}^{n}i=\int_0^1 x^2\,dx\]`,
  String.raw`\[\begin{bmatrix}1&2\\3&4\end{bmatrix}\]`,
  String.raw`\(\ce{H2O}+\bm{v}+\mathbb{R}\)`,
  String.raw`\[\begin{align}a&=b+c\\d&=e\end{align}\]`,
  String.raw`\(\cancel{x}+\bbox[border:1px solid red]{y}\)`,
  String.raw`\(\require{physics}\qty(\frac{x}{y})\)`,
];

for (const scheme of ["light", "dark"]) {
  test(`static MathJax preserves upstream 3.2.2 pixels and MathML in ${scheme}`, async ({ page, context }, testInfo) => {
    const reference = await context.newPage();
    const errors = [];
    reference.on("pageerror", error => errors.push(String(error)));
    try {
      for (const [target, upstream] of [[page, false], [reference, true]]) {
        await target.route("**/tests/static-mathjax.html", route => route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><style>body { width:600px; margin:20px; font:16px Arial; color:${scheme === "dark" ? "#eee" : "#222"}; background:${scheme === "dark" ? "#222" : "#fff"}; } .math-formula { margin:12px; }</style>
            <script src="/extension/shared/mathjax-config.js"></script>
            ${upstream ? '<script>MathJax.loader={load:["input/tex-full","output/svg","a11y/assistive-mml"]};</script>' : ""}
            <script src="${upstream ? "/node_modules/mathjax-full/es5/startup.js" : "/extension/vendor/mathjax/startup.js"}"></script>
            <main id="formulas"></main>`,
        }));
        await target.goto("/tests/static-mathjax.html");
        await target.evaluate(async formulas => {
          await MathJax.startup.promise;
          const root = document.querySelector("#formulas");
          for (const text of formulas) {
            const element = document.createElement("div");
            element.className = "math-formula";
            element.textContent = text;
            root.append(element);
          }
          await MathJax.typesetPromise([root]);
          await document.fonts.ready;
        }, formulas);
        await expect(target.locator("#formulas svg")).toHaveCount(formulas.length);
        await expect(target.locator("#formulas mjx-assistive-mml")).toHaveCount(formulas.length);
        await expect(target.locator('merror, [data-mml-node="merror"]')).toHaveCount(0);
      }
      expect(await page.locator("#formulas").innerHTML()).toBe(await reference.locator("#formulas").innerHTML());
      const actual = await stableCapture(page.locator("#formulas"), testInfo.outputPath("static.png"));
      const original = await stableCapture(reference.locator("#formulas"), testInfo.outputPath("upstream.png"));
      expect((await readFile(actual.path)).equals(await readFile(original.path))).toBe(true);
      expect(errors).toEqual([]);
      const requests = [];
      page.on("request", request => requests.push(request.url()));
      await page.evaluate(async () => MathJax.tex2svgPromise(String.raw`\require{https://remote.example/code}`));
      expect(requests).toEqual([]);
      expect(await page.evaluate(() => typeof MathJax.loader)).toBe("undefined");
    } finally { await reference.close(); }
  });
}
