import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "./fixtures.mjs";

const output = resolve("tests/results/i18n/artifacts-review");

/** Read-only cell and line-box checks; this does not measure pixel-level glyph clipping. */
export function inspectArtifactLayout(element) {
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const describe = node => node.id || node.className || node.tagName;
  const productLabels = ".artifact-strip-title, .artifact-strip-count, .artifact-strip-kind, .artifact-strip-name small, .artifact-strip-actions button, .artifacts-header h3, .artifacts-row-kind, .artifacts-row-meta, .artifact-row-action, .artifacts-summary, .automation-artifact-kind, .automation-artifact-line-kind, .automation-artifact-meta, .automation-artifact-open, .automation-artifact-line-open, .automation-artifact-shelf-title";
  const problems = [];
  const units = new Set();
  const measured = new Set();
  for (const label of element.querySelectorAll(productLabels)) {
    if (!visible(label)) continue;
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (!text.textContent.trim() || measured.has(text)) continue;
      measured.add(text);
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [...range.getClientRects()];
      if (!rects.length) continue;
      let unit = text.parentElement;
      while (unit !== element && getComputedStyle(unit).display === "inline") unit = unit.parentElement;
      units.add(unit);
      const unitBounds = unit.getBoundingClientRect();
      // Use line spacing, not Range height: the latter includes platform-dependent font space.
      // An explicit line-height also detects fixed-height cells that cannot fit their lines.
      const lineHeight = parseFloat(getComputedStyle(text.parentElement).lineHeight);
      const linesHeight = Math.max(...rects.map(rect => rect.top)) - Math.min(...rects.map(rect => rect.top)) + lineHeight;
      let ancestor = text.parentElement;
      while (ancestor) {
        const bounds = ancestor.getBoundingClientRect();
        if (rects.some(rect => rect.left < bounds.left - 1.5 || rect.right > bounds.right + 1.5)) {
          problems.push({ element: describe(label), container: describe(ancestor), text: text.textContent.trim(), reason: "text exceeds its cell" });
          break;
        }
        const style = getComputedStyle(ancestor);
        const clips = style.display !== "inline" && ["hidden", "clip"].includes(style.overflowY);
        if (clips && linesHeight > ancestor.clientHeight + 2) {
          problems.push({ element: describe(label), container: describe(ancestor), text: text.textContent.trim(), reason: "line boxes exceed clipping height" });
          break;
        }
        const top = bounds.top + ancestor.clientTop;
        if (clips && ancestor !== unit && (unitBounds.top < top - 2 || unitBounds.bottom > top + ancestor.clientHeight + 2)) {
          problems.push({ element: describe(unit), container: describe(ancestor), reason: "layout unit is vertically clipped" });
          break;
        }
        if (ancestor === element) break;
        ancestor = ancestor.parentElement;
      }
    }
  }
  const boxes = [...units].map(node => ({ node, rect: node.getBoundingClientRect() }));
  for (const [index, first] of boxes.entries()) for (const second of boxes.slice(index + 1)) {
    if (first.node.contains(second.node) || second.node.contains(first.node)) continue;
    if (Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left) > 1.5
      && Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top) > 2) {
      problems.push({ element: describe(first.node), other: describe(second.node), reason: "layout units overlap" });
    }
  }
  for (const title of element.querySelectorAll(".artifact-strip-name > span, .artifacts-row-title, .automation-artifact-name")) {
    if (visible(title) && title.textContent.trim() && title.getBoundingClientRect().width < 23
      && title.scrollWidth > title.clientWidth + 1) {
      problems.push({ element: describe(title), text: title.textContent, reason: "title squeezed below two characters" });
    }
  }
  const viewportOverflow = [...element.querySelectorAll(".artifact-strip-item, .artifacts-row, .automation-artifact-row, button")]
    .filter(visible).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1;
    }).map(describe);
  return { problems, viewportOverflow, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
}

export async function captureArtifactLayout(page, selector, scenario, testInfo) {
  const { language, colorScheme, width } = scenario;
  const name = `${language}-${colorScheme}-${width}-${scenario.scenario}`;
  const root = page.locator(selector).first();
  await root.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  const report = await root.evaluate(inspectArtifactLayout);
  await mkdir(output, { recursive: true });
  await root.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  await page.screenshot({ path: resolve(output, `${name}-page.png`), animations: "disabled" });
  await writeFile(resolve(output, `${name}.json`), JSON.stringify({ ...scenario, ...report }, null, 2));
  await testInfo.attach(`${name}.png`, { path: resolve(output, `${name}.png`), contentType: "image/png" });
  expect.soft(report.problems, `${name}: labels fit their cells and layout units are not clipped or overlapping`).toEqual([]);
  expect.soft(report.viewportOverflow, `${name}: rows and controls stay in the side panel`).toEqual([]);
  expect.soft(report.pageWidth, `${name}: no horizontal page overflow`).toBeLessThanOrEqual(report.viewportWidth);
}
