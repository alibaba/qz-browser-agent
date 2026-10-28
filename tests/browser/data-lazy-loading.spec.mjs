import { expect, test } from "./fixtures.mjs";
import xlsx from "xlsx";

const gridVendor = "**/capabilities/data/workspace/data-grid-vendor.js";
const excelChunk = /\/deps\/chunks\/xlsx-[^/]+\.js$/;

function spreadsheetFile() {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{ value: "spreadsheet row" }]), "input");
  return { name: "input.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(xlsx.write(workbook, { bookType: "xlsx", type: "array" })) };
}

async function mountData(page, { activate = true } = {}) {
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async activate => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css"><link rel="stylesheet" href="/extension/capabilities/data/grid-vendor.css">';
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    document.querySelectorAll(".tab-panel, #messages, #chat-dock, #session-title-bar").forEach(element => element.classList.add("hidden"));
    document.querySelector("#data-panel").classList.remove("hidden");
    window.store = await import("/extension/shared/data-store.js");
    await window.store.clearDataTable("alpha");
    await window.store.clearDataTable("beta");
    await window.store.insertDataRows("alpha", { value: "original alpha" });
    await window.store.insertDataRows("beta", { value: "original beta" });
    window.active = activate;
    window.toasts = [];
    window.traces = [];
    window.downloads = [];
    window.chrome ??= {};
    window.chrome.downloads = { download: async options => {
      const buffer = await fetch(options.url).then(response => response.arrayBuffer());
      window.downloads.push({ ...options, buffer });
      return window.downloads.length;
    } };
    const { createDataFeature } = await import("/extension/capabilities/data/workspace/data-feature.js");
    window.feature = createDataFeature({ root: document, initialTable: "alpha", isActive: () => window.active,
      startTrace: (name, detail) => () => window.traces.push({ name, detail }),
      showToast: message => window.toasts.push(message) });
    if (activate) await window.feature.activate();
  }, activate);
}

function recordHeavyRequests(page) {
  const requests = [];
  page.on("request", request => {
    if (request.url().includes("data-grid-vendor.js") || excelChunk.test(request.url())) requests.push(request.url());
  });
  return requests;
}

test("grid suppresses the header-sort advisory while preserving sorting, column selection and other warnings", async ({ page }) => {
  const warnings = [];
  page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
  await mountData(page, { activate: false });
  await page.evaluate(async () => {
    await window.store.insertDataRows("alpha", { value: "another alpha" });
    window.active = true;
    await window.feature.activate();
  });
  const cells = page.locator('.tabulator-row .tabulator-cell[tabulator-field="value"]');
  await expect(cells).toHaveCount(2);
  const header = page.locator('.tabulator-col[tabulator-field="value"]');
  await header.locator(".data-grid-column-title-text").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect(cells).toHaveText(["another alpha", "original alpha"]);
  await expect(cells.and(page.locator(".tabulator-range-selected"))).toHaveCount(2);
  await header.locator(".data-grid-column-title-text").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(cells).toHaveText(["original alpha", "another alpha"]);
  await page.evaluate(() => window.feature.openArtifactTable("beta"));
  await expect(cells).toHaveText(["original beta"]);
  await page.evaluate(() => console.warn("qz warning probe"));
  expect(warnings.filter(message => message.includes("Using column headerSort with selectableRangeColumns"))).toEqual([]);
  expect(warnings).toContain("qz warning probe");
});

test("registration, references, plain-text import and image browsing do not load either engine", async ({ page }) => {
  const requests = recordHeavyRequests(page);
  await mountData(page, { activate: false });
  expect(await page.evaluate(async () => {
    const { createDataReferences } = await import("/extension/capabilities/data/references.js");
    const references = await createDataReferences(window.feature.listTables, String).list(new AbortController().signal);
    const parser = await import("/extension/capabilities/data/workspace/data-import-parser.js");
    const csv = await parser.parseImportFile(new File(["name,value\nalpha,1"], "data.csv"));
    const json = parser.parseImportText('[{"name":"beta"}]', "data.json");
    const { createDataImageCollection } = await import("/extension/capabilities/data/workspace/data-image-collection.js");
    const collection = createDataImageCollection({ preview: document.querySelector("#data-preview") });
    collection.renderInto([{ id: "image", table: "images", data: { title: "preview" }, createdAt: "", updatedAt: "" }]);
    collection.clearObjectUrls();
    return { references: references.length, csv: csv[0].name, json: json[0].name };
  })).toEqual({ references: 2, csv: "alpha", json: "beta" });
  expect(requests).toEqual([]);
});

test("a shared first grid load renders only the newest requested table", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(gridVendor, route => { release = () => route.continue(); resolve(); });
  });
  const requests = recordHeavyRequests(page);
  await mountData(page);
  await requested;
  await expect(page.locator("#data-preview")).toContainText("正在加载表格");
  await page.evaluate(() => window.feature.openArtifactTable("beta"));
  await release();
  await expect(page.locator(".tabulator-cell").filter({ hasText: "original beta" })).toBeVisible();
  await expect(page.locator(".tabulator-cell").filter({ hasText: "original alpha" })).toHaveCount(0);
  expect(requests.filter(url => url.includes("data-grid-vendor.js"))).toHaveLength(1);
  expect(requests.filter(url => excelChunk.test(url))).toEqual([]);
});

for (const departure of ["deactivate", "dispose"]) {
  test(`a grid loaded after ${departure} cannot write the old view`, async ({ page }) => {
    let release;
    const requested = new Promise(resolve => {
      page.route(gridVendor, route => { release = () => route.continue(); resolve(); });
    });
    await mountData(page);
    await requested;
    await page.evaluate(departure => {
      window.active = false;
      window.feature[departure]();
      document.querySelector("#data-preview").textContent = "replacement view";
    }, departure);
    await release();
    await page.evaluate(async () => {
      await (await import("/extension/capabilities/data/workspace/data-grid-loader.js")).loadDataGrid();
    });
    await expect(page.locator("#data-preview")).toHaveText("replacement view");
    if (departure === "deactivate") {
      await page.evaluate(() => { window.active = true; return window.feature.activate(); });
      await expect(page.locator(".tabulator-cell").filter({ hasText: "original alpha" })).toBeVisible();
    }
  });
}

test("a failed grid fetch explains recovery and reopening the panel loads it successfully", async ({ page, browserDiagnostics }) => {
  let attempts = 0;
  await page.route(gridVendor, route => ++attempts === 1 ? route.abort("failed") : route.continue());
  await mountData(page);
  await expect(page.locator("#data-preview")).toContainText("表格模块加载失败，请重新打开侧栏后重试");
  await expect(page.locator("#data-preview button")).toHaveCount(0);
  // A fresh document is the same module-cache boundary as reopening a Chrome side panel.
  await mountData(page);
  await expect(page.locator(".tabulator-cell").filter({ hasText: "original alpha" })).toBeVisible();
  expect(attempts).toBe(2);
  expect(browserDiagnostics.consoleErrors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
  browserDiagnostics.consoleErrors.length = 0;
});

test("a failed Excel fetch explains recovery and reopening permits export", async ({ page, browserDiagnostics }) => {
  let attempts = 0;
  await page.route(excelChunk, route => ++attempts === 1 ? route.abort("failed") : route.continue());
  await mountData(page);
  await page.evaluate(() => document.querySelector("#btn-export-data").click());
  await expect.poll(() => page.evaluate(() => window.toasts)).toEqual(["导出失败：Excel 模块加载失败，请重新打开侧栏后重试"]);
  expect(await page.evaluate(() => window.downloads)).toEqual([]);
  await mountData(page);
  await page.evaluate(() => document.querySelector("#btn-export-data").click());
  await expect.poll(() => page.evaluate(() => window.downloads.map(item => item.filename))).toEqual(["alpha.xlsx"]);
  expect(attempts).toBe(2);
  expect(browserDiagnostics.consoleErrors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
  browserDiagnostics.consoleErrors.length = 0;
});

test("Excel is loaded once for concurrent exports and each keeps its original table", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(excelChunk, route => { release = () => route.continue(); resolve(); });
  });
  const requests = recordHeavyRequests(page);
  await mountData(page);
  await expect(page.locator(".tabulator-cell").filter({ hasText: "original alpha" })).toBeVisible();
  await page.evaluate(() => document.querySelector("#btn-export-data").click());
  await requested;
  await page.evaluate(async () => {
    await window.feature.openArtifactTable("beta");
    document.querySelector("#btn-export-data").click();
  });
  await release();
  await expect.poll(() => page.evaluate(() => window.downloads.length)).toBe(2);
  const downloads = await page.evaluate(async () => {
    const xlsx = await (await import("/extension/capabilities/data/workspace/data-excel.js")).loadExcel();
    return window.downloads.map(({ filename, buffer }) => {
      const workbook = xlsx.read(buffer, { type: "array" });
      return { filename, sheet: workbook.SheetNames[0], rows: xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]) };
    });
  });
  expect(downloads.map(item => ({ filename: item.filename, sheet: item.sheet, value: item.rows[0].value }))).toEqual([
    { filename: "alpha.xlsx", sheet: "alpha", value: "original alpha" },
    { filename: "beta.xlsx", sheet: "beta", value: "original beta" },
  ]);
  expect(requests.filter(url => excelChunk.test(url))).toHaveLength(1);
});

test("disposing during the first Excel export prevents a late download", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(excelChunk, route => { release = () => route.continue(); resolve(); });
  });
  await mountData(page);
  await page.evaluate(() => document.querySelector("#btn-export-data").click());
  await requested;
  await page.evaluate(() => window.feature.dispose());
  await release();
  await page.evaluate(async () => {
    await (await import("/extension/capabilities/data/workspace/data-excel.js")).loadExcel();
  });
  expect(await page.evaluate(() => window.downloads)).toEqual([]);
});

test("the first Excel import keeps its destination chosen before loading", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(excelChunk, route => { release = () => route.continue(); resolve(); });
  });
  await mountData(page);
  await page.locator("#btn-import-data").click();
  await page.locator("#data-import-table").fill("original destination");
  await page.locator("#data-import-file").setInputFiles(spreadsheetFile());
  await requested;
  await page.locator("#data-import-table").fill("replacement destination");
  await release();
  await expect(page.locator(".tabulator-cell").filter({ hasText: "spreadsheet row" })).toBeVisible();
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe("original destination");
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: "replacement destination" })).rows)).toEqual([]);
});

test("closing an import while Excel loads cancels its unstarted write", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(excelChunk, route => { release = () => route.continue(); resolve(); });
  });
  await mountData(page);
  await page.locator("#btn-import-data").click();
  await page.locator("#data-import-table").fill("cancelled import");
  await page.locator("#data-import-file").setInputFiles(spreadsheetFile());
  await requested;
  await page.locator("#btn-close-data-import").click();
  await release();
  await page.evaluate(async () => {
    await (await import("/extension/capabilities/data/workspace/data-excel.js")).loadExcel();
  });
  await expect(page.locator("#btn-data-import-file")).toBeEnabled();
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: "cancelled import" })).rows)).toEqual([]);
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe("alpha");
});

test("a background refresh of the same table preserves an import awaiting Excel", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(excelChunk, route => { release = () => route.continue(); resolve(); });
  });
  await mountData(page);
  await page.locator("#btn-import-data").click();
  await page.locator("#data-import-table").fill("refreshed import");
  await page.locator("#data-import-file").setInputFiles(spreadsheetFile());
  await requested;
  await page.evaluate(() => window.feature.invalidate());
  await expect.poll(() => page.evaluate(() => window.traces.filter(trace => trace.name === "show_table" && trace.detail.table === "alpha").length)).toBe(2);
  await release();
  await expect(page.locator(".tabulator-cell").filter({ hasText: "spreadsheet row" })).toBeVisible();
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe("refreshed import");
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: "refreshed import" })).rows.length)).toBe(1);
});

test("navigating away and back still cancels an import awaiting Excel", async ({ page }) => {
  let release;
  const requested = new Promise(resolve => {
    page.route(excelChunk, route => { release = () => route.continue(); resolve(); });
  });
  await mountData(page);
  await page.locator("#btn-import-data").click();
  await page.locator("#data-import-table").fill("stale import");
  await page.locator("#data-import-file").setInputFiles(spreadsheetFile());
  await requested;
  await page.evaluate(async () => {
    await window.feature.openArtifactTable("beta");
    await window.feature.openArtifactTable("alpha");
  });
  await release();
  await expect(page.locator("#btn-data-import-file")).toBeEnabled();
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: "stale import" })).rows)).toEqual([]);
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe("alpha");
});
