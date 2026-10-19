import { expect, test } from "./sidepanel-fixtures.mjs";

for (const width of [320, 800]) for (const direction of ["ltr", "rtl"]) for (const colorScheme of ["light", "dark"]) {
  test.describe(`${width}px ${direction} gallery · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width, height: 760 } });
    test("keeps the selected gallery thumbnail visible when wrapping", async ({ page }, testInfo) => {
      await page.evaluate(async direction => {
        document.documentElement.dir = direction;
        const { openImageGallery } = await import("/extension/sidepanel/ui/image-lightbox.js");
        const src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#638f87"/></svg>');
        openImageGallery(Array.from({ length: 10 }, (_, index) => ({ src, title: `Image ${index + 1}` })), 9);
      }, direction);
      const strip = page.locator(".data-image-gallery-strip");
      const selected = page.locator(".data-image-gallery-thumb.active");
      expect(await strip.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await expect(selected).toHaveAttribute("data-gallery-index", "9");
      await expect(selected).toBeInViewport({ ratio: 1 });

      await page.locator(".data-image-gallery-nav.next").click();
      await expect(selected).toHaveAttribute("data-gallery-index", "0");
      await expect(selected).toBeInViewport({ ratio: 1 });
      await page.locator(".data-image-gallery-nav.prev").click();
      await expect(selected).toHaveAttribute("data-gallery-index", "9");
      await expect(selected).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`gallery-${width}-${direction}-${colorScheme}.png`), animations: "disabled" });
    });
  });
}
