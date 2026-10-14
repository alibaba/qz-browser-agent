import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const extensionPath = await ensureTestExtension();
const tableName = "__data_grid_extension_e2e__";

const playwright = await loadPlaywright();
const chromeExecutable = findChromeExecutable(playwright.chromium.executablePath());
if (!chromeExecutable) throw new Error("Chrome executable not found");

const userDataDir = mkdtempSync(join(tmpdir(), "qingzhou-data-grid-extension-"));
let context;

try {
  context = await playwright.chromium.launchPersistentContext(userDataDir, {
    locale: "zh-CN",
    headless: process.env.DATA_GRID_EXTENSION_HEADLESS === "1",
    executablePath: chromeExecutable,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1120, height: 760 },
    args: [
      "--lang=zh-CN",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const extensionId = await getExtensionId(context, userDataDir);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));

  await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await acceptDataDisclosure(page);
  await page.waitForSelector('[data-tab="data"]');
  await seedDataTable(page, tableName);

  await page.locator('[data-tab="data"]').click();
  await page.waitForFunction(
    table => document.querySelector("#data-table-search")?.value === table,
    tableName,
  );
  await page.waitForSelector(".data-grid-table.tabulator");
  await page.waitForSelector(".tabulator-cell[tabulator-field='name']");

  const scoreHeader = page.locator(".tabulator-col[tabulator-field='score']");
  await scoreHeader.locator(".data-grid-column-title-text").click();
  await page.waitForFunction(() => {
    const header = document.querySelector(".tabulator-col[tabulator-field='score']");
    return header && header.getAttribute("aria-sort") !== "none";
  });
  const sortDirection = await scoreHeader.getAttribute("aria-sort");
  const sortedScores = await readVisibleColumnValues(page, "score");
  await page.locator(".data-grid-table").evaluate(el => { el.dataset.e2eGridIdentity = "stable"; });

  await page.locator('[data-tab="chat"]').click();
  await page.waitForTimeout(5200);
  await page.locator('[data-tab="data"]').click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".data-grid-table").getAttribute("data-e2e-grid-identity"), "stable", "returning to Data should keep the existing grid DOM");
  assert.equal(await scoreHeader.getAttribute("aria-sort"), sortDirection, "returning to Data should preserve sorting direction");
  assert.deepEqual(await readVisibleColumnValues(page, "score"), sortedScores, "returning to Data should preserve sorted row order");

  await page.locator('.data-grid-column-filter-btn[data-filter-field="score"]').click({ force: true });
  await page.waitForSelector("[data-data-grid-filter-popover]:not(.hidden)");
  await page.locator("[data-data-grid-filter-input]").fill("9");
  await page.waitForFunction(() => document.querySelector("[data-data-grid-meta]")?.textContent.includes("过滤后 1/3 行"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("[data-data-grid-filter-popover]")?.classList.contains("hidden"));

  await page.locator(".tabulator-cell[tabulator-field='score']").first().dblclick();
  const scoreEditor = page.locator(".tabulator-cell[tabulator-field='score'] input").first();
  assert.equal(await scoreEditor.getAttribute("type"), "text", "all cells should use a plain text input");
  assert.equal(await scoreEditor.getAttribute("inputmode"), null, "cells should not imply numeric input mode");
  await scoreEditor.fill("9.8");
  await page.keyboard.press("Enter");
  await waitForDataRowValue(page, tableName, "杭州西湖", "score", "9.8");
  assert.equal(await page.locator("#data-edit-status").count(), 0, "successful cell saves should not reserve an inline status surface");
  let rows = await readDataRows(page, tableName);
  assert.equal(rows.find(row => row.name === "杭州西湖")?.score, "9.8", "cell edit should persist plain text into data-store");

  await page.locator("#btn-clear-data-filters").click();
  await page.waitForFunction(() => !document.querySelector("[data-data-grid-meta]")?.textContent.includes("过滤后"));

  const selectedCell = page.locator(".tabulator-cell[tabulator-field='name']").first();
  const selectedText = String(await selectedCell.textContent() || "").trim();
  await selectedCell.click();
  assert.equal(await selectedCell.locator("input").count(), 0, "single click should select a cell without entering edit mode");
  await page.evaluate(() => {
    window.__qingzhouCopiedCellText = "";
    window.__qingzhouCopiedCellHtml = "";
    document.addEventListener("copy", (event) => {
      window.__qingzhouCopiedCellText = event.clipboardData?.getData("text/plain") || "";
      window.__qingzhouCopiedCellHtml = event.clipboardData?.getData("text/html") || "";
    }, { once: true });
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  await page.waitForFunction(() => Boolean(window.__qingzhouCopiedCellText));
  assert.equal(await page.evaluate(() => window.__qingzhouCopiedCellText.trim()), selectedText, "Ctrl/Cmd-C should copy the selected cell");
  assert.equal(await page.evaluate(() => window.__qingzhouCopiedCellHtml), "", "cell copy should not publish an HTML table payload");

  await dragDataRange(page, "name", 0, "city", 1);
  await page.evaluate(() => {
    window.__qingzhouCopiedRangeText = "";
    window.__qingzhouCopiedRangeHtml = "";
    document.addEventListener("copy", (event) => {
      window.__qingzhouCopiedRangeText = event.clipboardData?.getData("text/plain") || "";
      window.__qingzhouCopiedRangeHtml = event.clipboardData?.getData("text/html") || "";
    }, { once: true });
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  await page.waitForFunction(() => Boolean(window.__qingzhouCopiedRangeText));
  assert.equal((await page.evaluate(() => window.__qingzhouCopiedRangeText)).split(/\r?\n/)[0], "name\tcity", "multi-cell range copy should include column headers");
  assert.equal(await page.evaluate(() => window.__qingzhouCopiedRangeHtml), "", "range copy should remain plain text rather than HTML table data");

  await page.locator('.data-grid-column-filter-btn[data-filter-field="city"]').click({ force: true });
  await page.waitForSelector("[data-data-grid-filter-popover]:not(.hidden)");
  let categoricalOptions = await readCategoricalFilterOptions(page);
  assert.deepEqual(categoricalOptions.slice(0, 2), [
    { label: "杭州", count: "2", checked: false },
    { label: "南京", count: "1", checked: false },
  ], "text filters should show categorical values sorted by count");
  await page.locator("[data-data-grid-filter-input]").fill("杭");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll(".data-grid-filter-option")];
    return rows.length === 1 && rows[0]?.querySelector(".data-grid-filter-option-label")?.textContent.trim() === "杭州";
  });
  categoricalOptions = await readCategoricalFilterOptions(page);
  assert.deepEqual(categoricalOptions, [
    { label: "杭州", count: "2", checked: false },
  ], "categorical options should be recomputed from the column text input");
  await page.locator('.data-grid-filter-option input[value="杭州"]').check();
  await page.waitForFunction(() => document.querySelector("[data-data-grid-meta]")?.textContent.includes("过滤后 2/3 行"));
  categoricalOptions = await readCategoricalFilterOptions(page);
  assert.equal(categoricalOptions[0]?.checked, true, "categorical value selection should remain checked after filtering");

  await page.locator("#btn-clear-data-filters").click();
  await page.waitForFunction(() => !document.querySelector("[data-data-grid-meta]")?.textContent.includes("过滤后"));

  await openDataColumnsMenu(page);
  await page.locator("[data-column-add]").click();
  await submitDecisionText(page, "notes");
  await page.waitForSelector(".tabulator-cell[tabulator-field='notes']");
  const notesCell = page.locator(".tabulator-cell[tabulator-field='notes']").first();
  const editedRowName = String(await notesCell.locator("xpath=..").locator(".tabulator-cell[tabulator-field='name']").textContent() || "").trim();
  assert.ok(editedRowName, "new column edit should stay anchored to a row with a business key");
  await notesCell.dblclick();
  const notesEditor = page.locator(".tabulator-cell[tabulator-field='notes'] input").first();
  await notesEditor.fill("新字段可编辑");
  await page.keyboard.press("Enter");
  await waitForDataRowValue(page, tableName, editedRowName, "notes", "新字段可编辑");
  rows = await readDataRows(page, tableName);
  assert.equal(rows.find(row => row.name === editedRowName)?.notes, "新字段可编辑", "newly added column should be editable");

  await page.locator(".tabulator-cell[tabulator-field='notes']").first().dblclick();
  const jsonEditor = page.locator(".tabulator-cell[tabulator-field='notes'] input").first();
  assert.equal(await jsonEditor.evaluate(el => el.tagName.toLowerCase()), "input", "inline editing should remain single-line");
  await jsonEditor.fill('{"ok":true}');
  await page.keyboard.press("Enter");
  await waitForDataRowValue(page, tableName, editedRowName, "notes", '{"ok":true}');
  rows = await readDataRows(page, tableName);
  assert.equal(rows.find(row => row.name === editedRowName)?.notes, '{"ok":true}', "inline JSON-looking text should save as text");

  await openDataColumnsMenu(page);
  await page.locator("[data-column-action='rename'][data-column='notes']").click({ force: true });
  const renameInput = page.locator("[data-column-rename-input][data-column-rename-from='notes']");
  await renameInput.fill("remark");
  await page.locator("[data-column-action='rename-commit'][data-column='notes']").click({ force: true });
  await page.waitForSelector(".tabulator-cell[tabulator-field='remark']");
  rows = await readDataRows(page, tableName);
  assert.equal(rows.find(row => row.name === editedRowName)?.remark, '{"ok":true}', "renamed column should keep existing values");
  assert.equal(rows.find(row => row.name === editedRowName)?.notes, undefined, "renamed column should remove old field");

  await openDataColumnsMenu(page);
  await page.locator("[data-column-action='delete'][data-column='remark']").click({ force: true });
  await acceptDecision(page);
  await page.waitForFunction(() => !document.querySelector(".tabulator-cell[tabulator-field='remark']"));
  rows = await readDataRows(page, tableName);
  assert.equal(rows.some(row => Object.prototype.hasOwnProperty.call(row, "remark")), false, "deleted column should be removed from row data");

  await dragDataRange(page, "name", 0, "name", 0);
  await dispatchGridPaste(page, "西溪湿地\t杭州\t8.9\n拙政园\t苏州\t9");
  await waitForDataRowValue(page, tableName, "西溪湿地", "city", "杭州");
  rows = await readDataRows(page, tableName);
  assert.equal(rows.find(row => row.name === "西溪湿地")?.city, "杭州", "range paste should persist first pasted row");
  assert.equal(rows.find(row => row.name === "拙政园")?.score, "9", "range paste should persist second pasted row as text");
  assert.equal(rows.length, 3, "range paste should update rows without inserting in-memory Tabulator rows");

  await page.locator("#btn-add-data-row").click();
  await page.waitForFunction(() => document.querySelector("#btn-delete-data-rows")?.textContent.includes("删除 1 行"));
  rows = await readDataRows(page, tableName);
  assert.equal(rows.length, 4, "add row should persist a new row");
  const newEmptyRow = rows.find(row => row.name === "" && row.city === "");
  assert.ok(newEmptyRow, "add row should create an empty editable row");
  assert.equal(rows[0]?.name, "", "toolbar add row should insert the new row at the top of the table");
  assert.equal(newEmptyRow.score, "", "new rows should use empty text values");
  assert.equal(newEmptyRow.available, "", "new rows should use empty text values");

  await page.locator('.data-grid-column-filter-btn[data-filter-field="city"]').click({ force: true });
  await page.waitForSelector("[data-data-grid-filter-popover]:not(.hidden)");
  categoricalOptions = await readCategoricalFilterOptions(page);
  const emptyOption = categoricalOptions.find(option => option.label === "(空)");
  assert.deepEqual(emptyOption, { label: "(空)", count: "1", checked: false }, "blank values should be exposed as a selectable categorical filter");
  await page.locator('.data-grid-filter-option input[value=""]').check();
  await page.waitForFunction(() => document.querySelector("[data-data-grid-meta]")?.textContent.includes("过滤后 1/4 行"));
  categoricalOptions = await readCategoricalFilterOptions(page);
  assert.equal(categoricalOptions.find(option => option.label === "(空)")?.checked, true, "blank categorical value should remain checked after filtering");
  await page.locator("#btn-clear-data-filters").click();
  await page.waitForFunction(() => !document.querySelector("[data-data-grid-meta]")?.textContent.includes("过滤后"));

  await page.locator("#btn-delete-data-rows").click();
  await acceptDecision(page);
  await page.waitForFunction(() => document.querySelector("#btn-delete-data-rows")?.textContent.trim() === "删除行");
  rows = await readDataRows(page, tableName);
  assert.equal(rows.length, 3, "delete selected row should persist deletion");

  assert.deepEqual(pageErrors, [], "sidepanel should not emit page errors during Data grid e2e");
  console.log("data grid extension page e2e passed");
} finally {
  await context?.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

async function seedDataTable(page, table) {
  await page.evaluate(async ({ table }) => {
    const dataStore = await import(chrome.runtime.getURL("shared/data-store.js"));
    await dataStore.clearDataTable(table).catch(() => {});
    await dataStore.insertDataRows(table, [
      { name: "杭州西湖", city: "杭州", score: 9.3, available: true },
      { name: "灵隐寺", city: "杭州", score: 8.7, available: true },
      { name: "夫子庙", city: "南京", score: 7.5, available: false },
    ], { columns: ["name", "city", "score", "available"] });
  }, { table });
}

async function readDataRows(page, table) {
  return page.evaluate(async ({ table }) => {
    const dataStore = await import(chrome.runtime.getURL("shared/data-store.js"));
    const result = await dataStore.queryDataRows({ table, limit: 100 });
    return result.rows.map(row => row.data);
  }, { table });
}

async function readVisibleColumnValues(page, field) {
  return page.locator(`.tabulator-row .tabulator-cell[tabulator-field='${field}']`).allTextContents()
    .then(values => values.map(value => value.trim()));
}

async function waitForDataRowValue(page, table, rowName, field, expected) {
  await page.waitForFunction(
    async ({ table, rowName, field, expected }) => {
      const dataStore = await import(chrome.runtime.getURL("shared/data-store.js"));
      const result = await dataStore.queryDataRows({ table, limit: 100 });
      return result.rows.some(row => row.data?.name === rowName && row.data?.[field] === expected);
    },
    { table, rowName, field, expected },
  );
}

async function dragDataRange(page, fromField, fromIndex, toField, toIndex) {
  const from = await waitForVisibleCellBox(page, fromField, fromIndex, "source");
  const to = fromField === toField && fromIndex === toIndex
    ? from
    : await waitForVisibleCellBox(page, toField, toIndex, "target");
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".tabulator-range, .tabulator-range-cell-active, .tabulator-range-selected");
}

async function waitForVisibleCellBox(page, field, index, role) {
  const selector = `.tabulator-cell[tabulator-field='${field}']`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const cell = page.locator(selector).nth(index);
    try {
      await cell.waitFor({ state: "visible", timeout: 1_000 });
      await cell.scrollIntoViewIfNeeded({ timeout: 1_000 });
      const box = await cell.boundingBox();
      if (box?.width > 0 && box?.height > 0) return box;
    } catch (error) {
      if (!/not attached|Timeout/i.test(String(error?.message || error))) throw error;
    }
    await page.waitForTimeout(50);
  }
  assert.fail(`${role} cell ${field}[${index}] should be visible`);
}

async function openDataColumnsMenu(page) {
  const hidden = await page.locator("#data-columns-menu").evaluate(el => el.classList.contains("hidden"));
  if (hidden) await page.locator("#btn-data-columns").click();
  await page.waitForFunction(() => !document.querySelector("#data-columns-menu")?.classList.contains("hidden"));
}

async function submitDecisionText(page, value) {
  const dialog = page.locator("#qz-decision-dialog[open]");
  await dialog.waitFor();
  await dialog.locator("[data-qz-decision-input]").fill(value);
  await dialog.locator("[data-qz-decision-confirm]").click();
  await page.waitForFunction(() => !document.querySelector("#qz-decision-dialog")?.open);
}

async function acceptDecision(page) {
  const dialog = page.locator("#qz-decision-dialog[open]");
  await dialog.waitFor();
  await dialog.locator("[data-qz-decision-confirm]").click();
  await page.waitForFunction(() => !document.querySelector("#qz-decision-dialog")?.open);
}

async function dispatchGridPaste(page, text) {
  await page.evaluate(({ text }) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData(type) {
          return type === "text/plain" ? text : "";
        },
      },
    });
    document.querySelector(".data-grid-table").dispatchEvent(event);
  }, { text });
}

async function readCategoricalFilterOptions(page) {
  return page.$$eval(".data-grid-filter-option", rows => rows.map(row => ({
    label: row.querySelector(".data-grid-filter-option-label")?.textContent.trim() || "",
    count: row.querySelector(".data-grid-filter-option-count")?.textContent.trim() || "",
    checked: Boolean(row.querySelector("input")?.checked),
  })));
}

async function getExtensionId(context, userDataDir) {
  const existing = context.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"));
  if (existing) return new URL(existing.url()).host;
  try {
    const worker = await context.waitForEvent("serviceworker", {
      predicate: item => item.url().startsWith("chrome-extension://"),
      timeout: 3000,
    });
    return new URL(worker.url()).host;
  } catch (_err) {
    const id = await waitForExtensionIdFromPreferences(userDataDir);
    if (id) return id;
    throw new Error("Unable to resolve loaded extension id from service worker or Chrome Preferences");
  }
}

async function waitForExtensionIdFromPreferences(userDataDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = readExtensionIdFromPreferences(userDataDir);
    if (id) return id;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return "";
}

function readExtensionIdFromPreferences(userDataDir) {
  const candidates = [
    join(userDataDir, "Default", "Preferences"),
    join(userDataDir, "Preferences"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const settings = JSON.parse(readFileSync(file, "utf8"))?.extensions?.settings || {};
      const match = Object.entries(settings).find(([, value]) => {
        const path = String(value?.path || value?.manifest?.path || "");
        return path && resolve(path) === resolve(extensionPath);
      });
      if (match?.[0]) return match[0];
    } catch (_err) {}
  }
  return "";
}

async function loadPlaywright() {
  try {
    return normalizePlaywrightImport(await import("playwright"));
  } catch (_err) {
    const explicitPath = process.env.PLAYWRIGHT_PATH || "";
    if (explicitPath) return normalizePlaywrightImport(await import(pathToFileURL(explicitPath).href));
    throw new Error("Playwright not installed");
  }
}

function normalizePlaywrightImport(module) {
  return module?.chromium ? module : (module?.default?.chromium ? module.default : module);
}

function findChromeExecutable(bundled = "") {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    bundled,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || "";
}
