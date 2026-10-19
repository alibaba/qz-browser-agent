import { expect, test } from "./fixtures.mjs";
import { inspectArtifactLayout } from "./artifact-layout-audit.mjs";

test.use({ viewport: { width: 390, height: 600 } });

async function fixture(page, content, css = "") {
  await page.setContent(`<style>
    body { margin: 0; }
    #root { margin: 10px; padding: 32px; width: 250px; }
    .artifact-strip-title, .artifact-strip-count { display: block; font: 24px/30px sans-serif; }
    ${css}
  </style><div id="root">${content}</div>`);
  await page.evaluate(() => document.fonts.ready);
  return page.locator("#root").evaluate(inspectArtifactLayout);
}

test("allows visible font extents outside a line box and nested inline labels", async ({ page }) => {
  const report = await fixture(page, '<div class="artifact-strip-title">产物 <span class="artifact-strip-count">2</span></div>',
    '.artifact-strip-title { line-height: 6px; } .artifact-strip-count { display: inline; overflow: hidden; font-size: 12px; line-height: inherit; }');
  const overhang = await page.locator(".artifact-strip-title").evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element.firstChild);
    return range.getBoundingClientRect().height > element.getBoundingClientRect().height;
  });
  expect(overhang, "font extents must exceed the line box on every platform").toBe(true);
  expect(report.problems).toEqual([]);
});

for (const overflow of ["hidden", "clip"]) {
  test(`detects a fixed-height cell that clips its line with overflow:${overflow}`, async ({ page }) => {
    const report = await fixture(page, '<div class="artifact-strip-title">Readable label</div>',
      `.artifact-strip-title { height: 4px; overflow: ${overflow}; }`);
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "line boxes exceed clipping height" }),
    ]));
  });
}

test("detects a layout unit clipped by an ancestor", async ({ page }) => {
  const report = await fixture(page, '<div class="clip"><div class="artifact-strip-title">First line<br>Second line</div></div>',
    '.clip { height: 35px; overflow: hidden; }');
  expect(report.problems).toEqual(expect.arrayContaining([
    expect.objectContaining({ container: "clip", reason: "layout unit is vertically clipped" }),
  ]));
});

test("detects adjacent layout units overlapping with visible overflow", async ({ page }) => {
  const report = await fixture(page,
    '<div class="artifact-strip-title">First label</div><div class="artifact-strip-count">Second label</div>',
    '.artifact-strip-count { margin-top: -25px; }');
  expect(report.problems).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: "layout units overlap" }),
  ]));
});

test("detects text squeezed out of its horizontal cell", async ({ page }) => {
  const report = await fixture(page, '<div class="artifact-strip-title">Readable label</div>',
    '.artifact-strip-title { width: 8px; white-space: nowrap; }');
  expect(report.problems).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: "text exceeds its cell" }),
  ]));
});

test("detects an ellipsized title squeezed below its minimum width", async ({ page }) => {
  const report = await fixture(page, '<div class="artifact-strip-name"><span>Long artifact title</span></div>',
    '.artifact-strip-name > span { display: block; width: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }');
  expect(report.problems).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: "title squeezed below two characters" }),
  ]));
});

test("detects rows outside the viewport", async ({ page }) => {
  const report = await fixture(page, '<div class="artifact-strip-item">Row</div>',
    '.artifact-strip-item { width: 500px; }');
  expect(report.viewportOverflow).toContain("artifact-strip-item");
  expect(report.pageWidth).toBeGreaterThan(report.viewportWidth);
});
