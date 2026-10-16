import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.addStyleTag({ url: "/extension/sidepanel/sidepanel.css" });
  await page.evaluate(() => {
    document.body.innerHTML = '<form id="choices" aria-label="Results" style="display:grid;gap:8px;padding:12px;width:100%;box-sizing:border-box"></form>';
  });
});

async function render(page, choices) {
  await page.evaluate(async choices => {
    const { renderResultChoice } = await import("/extension/sidepanel/ui/result-choice.js");
    for (const [index, choice] of choices.entries()) {
      document.querySelector("#choices").append(renderResultChoice(document, {
        id: `result-${index}`, name: "results", value: `result-${index}`, label: "Result",
        multiple: true, checked: false, ...choice,
      }));
    }
  }, choices);
}

test("native cards support label clicks, keyboard selection, exclusive radio choices, and disabled state", async ({ page }) => {
  await render(page, [
    { label: "Compiler engineer", description: "Work on a local-first editor.", value: "compiler" },
    { label: "Database engineer", value: "database", checked: true, disabled: true },
    { label: "Europe", name: "region", value: "eu", multiple: false },
    { label: "Americas", name: "region", value: "us", multiple: false },
  ]);
  const compiler = page.getByRole("checkbox", { name: "Compiler engineer" });
  await page.getByText("Work on a local-first editor.").click();
  await expect(compiler).toBeChecked();
  await compiler.focus();
  await page.keyboard.press("Space");
  await expect(compiler).not.toBeChecked();
  const invalidBorder = await compiler.evaluate(input => {
    input.setAttribute("aria-invalid", "true");
    const card = input.closest(".qz-choice-card");
    const expected = document.createElement("span");
    expected.style.color = "var(--red)";
    card.append(expected);
    const result = getComputedStyle(expected).color;
    expected.remove();
    return result;
  });
  await expect(page.locator(".qz-choice-card").first()).toHaveCSS("border-color", invalidBorder);
  const database = page.getByRole("checkbox", { name: "Database engineer" });
  await expect(database).toBeChecked();
  await expect(database).toBeDisabled();
  await page.getByRole("radio", { name: "Europe" }).check();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Europe" })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "Americas" })).toBeChecked();
  expect(await page.locator("form").evaluate(form => [...new FormData(form).entries()])).toEqual([["region", "us"]]);
});

test("opening a source preserves selection and text and URLs remain inert", async ({ page, context }) => {
  await context.route("https://example.com/jobs", route => route.fulfill({ body: "Job source" }));
  await render(page, [
    { label: "<script>unsafe()</script>", description: '<img src=x onerror="unsafe()">', meta: ["<b>Remote</b>"], url: "https://example.com/jobs", checked: true },
    { label: "Unsafe link", url: "javascript:alert(1)", imageUrl: "data:text/html,invalid" },
    { label: "Credentials", url: "https://user:secret@example.com/jobs", imageUrl: "https://user:secret@example.com/a.png" },
  ]);
  await expect(page.locator("#choices script, #choices img")).toHaveCount(0);
  await expect(page.locator("#choices a")).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "<script>unsafe()</script>", exact: true })).toBeChecked();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link").click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(page.getByRole("checkbox").first()).toBeChecked();
  await popup.close();
  expect(await page.locator(".qz-choice-card").first().evaluate(card => {
    const cloned = document.createElement("div");
    cloned.innerHTML = card.outerHTML;
    return { checked: cloned.querySelector("input").checked, rel: card.querySelector("a").rel };
  })).toEqual({ checked: true, rel: "noopener noreferrer" });
});

for (const colorScheme of ["light", "dark"]) for (const direction of ["ltr", "rtl"]) {
  test(`cards fit 320px with ${colorScheme} colors and ${direction} text`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.evaluate(direction => document.documentElement.dir = direction, direction);
    await page.route("https://example.com/thumb-*.svg", route => {
      const portrait = route.request().url().endsWith("portrait.svg");
      return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 90 : 160}" height="${portrait ? 160 : 90}"><path fill="#777" d="M0 0h160v160H0z"/></svg>` });
    });
    await render(page, [
      { label: "Compiler engineer · أدوات المطور", description: "Build a local-first editor and language tools. Long uninterrupted text: " + "narrow-panel".repeat(6), meta: ["Remote · Europe", "Rust / TypeScript", "Open source", "a-long-metadata-value".repeat(3), "Full time", "Senior"], url: "https://careers.example.com/jobs/123", imageUrl: "https://example.com/thumb-landscape.svg", checked: true },
      { label: "Backend engineer", description: "Work on the database engine.", meta: ["Remote", "Full time"], imageUrl: "https://example.com/thumb-portrait.svg" },
    ]);
    const thumbnails = await page.locator(".qz-choice-card-image").evaluateAll(async images => {
      for (const image of images) { image.loading = "eager"; await image.decode(); }
      return images.map(image => ({
        natural: [image.naturalWidth, image.naturalHeight],
        displayed: [image.getBoundingClientRect().width, image.getBoundingClientRect().height],
        fit: getComputedStyle(image).objectFit,
      }));
    });
    expect(thumbnails).toEqual([
      { natural: [160, 90], displayed: [40, 40], fit: "cover" },
      { natural: [90, 160], displayed: [40, 40], fit: "cover" },
    ]);
    const selectedCard = page.locator(".qz-choice-card").first();
    const selectedStyle = await selectedCard.evaluate(card => ({
      border: getComputedStyle(card).borderColor,
      background: getComputedStyle(card).backgroundColor,
    }));
    await selectedCard.hover();
    await expect(selectedCard).toHaveCSS("border-color", selectedStyle.border);
    await expect(selectedCard).toHaveCSS("background-color", selectedStyle.background);
    await page.getByRole("checkbox").first().focus();
    const layout = await page.evaluate(() => {
      const card = document.querySelector(".qz-choice-card");
      const label = card.querySelector("label");
      const input = label.querySelector("input");
      const image = label.querySelector("img");
      const title = card.querySelector("strong");
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        cardOverflow: card.scrollWidth > card.clientWidth,
        imageWidth: image.getBoundingClientRect().width,
        inputLeft: input.getBoundingClientRect().left,
        imageLeft: image.getBoundingClientRect().left,
        color: getComputedStyle(title).color,
        background: getComputedStyle(card).backgroundColor,
        focus: getComputedStyle(card).boxShadow,
      };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.cardOverflow).toBe(false);
    expect(layout.imageWidth).toBe(40);
    expect(direction === "rtl" ? layout.inputLeft > layout.imageLeft : layout.inputLeft < layout.imageLeft).toBe(true);
    expect(layout.color).not.toBe(layout.background);
    expect(layout.focus).not.toBe("none");
    await page.screenshot({ path: testInfo.outputPath(`result-choices-${colorScheme}-${direction}.png`), fullPage: true });
  });
}
