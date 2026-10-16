import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { extensionRequest } from "./isolated-extension-mcp.mjs";

const TABLE = "Soak research rows";
const EMPTY = "Soak empty table";
const GALLERY = "Soak image collection";
const OTHER = "Soak shared image";
const SKILL = "mcp-soak-fixture";
const TEXT = '杭州, "quote"\nsecond line';
const RESOURCE = "Synthetic fixture bytes.\nReusable Skill resource.";
const ROWS = 64;

/** Synthetic content is seeded through the owning stores; all exercised operations use CLI/MCP. */
export async function prepareResources({ environment, mcp, cli, outputDirectory }) {
  const page = environment.page;
  const downloads = new Map();
  const seeded = await seed(page);
  const skill = await page.evaluate(async ({ name, content }) => {
    const { normalizeModernSkill } = await import(chrome.runtime.getURL("shared/skills/skill-utils.js"));
    return normalizeModernSkill({ name, description: "Synthetic soak export fixture", content: "# Soak Skill\nRead references/example.txt.",
      resources: [{ path: "references/example.txt", content }] });
  }, { name: SKILL, content: RESOURCE });
  const saved = await extensionRequest(page, "save_workspace_skill", { name: SKILL, expected: null, skill }, "skill_workspace_saved");
  assert.equal(saved.registryReady, true);

  async function completed(result) {
    assert.ok(Number.isInteger(result.downloadId));
    assert.equal(Object.hasOwn(result, "base64"), false);
    const deadline = Date.now() + 20_000;
    let item;
    do {
      item = await page.evaluate(async id => (await chrome.downloads.search({ id }))[0], result.downloadId);
      if (["complete", "interrupted"].includes(item?.state)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(item?.state, "complete", `download ${result.downloadId} did not complete`);
    const path = relative(outputDirectory, item.filename);
    assert.ok(path && !path.startsWith("..") && !isAbsolute(path), "export remains inside the isolated download directory");
    downloads.set(result.downloadId, item.filename);
    const bytes = readFileSync(item.filename);
    assert.ok(bytes.length > 0);
    return { ...item, bytes: [...bytes] };
  }

  async function cleanup() {
    for (const [id, filename] of downloads) {
      rmSync(filename, { force: true });
      await page.evaluate(id => chrome.downloads.erase({ id }), id);
      downloads.delete(id);
    }
  }

  return {
    fixture: { seededThrough: "Data/Asset store and workspace Skill owner", table: TABLE, rows: ROWS, skill: SKILL },
    cleanup,
    async iterate(round) {
      let operations = 0;
      const report = { round, channel: round % 2 ? "mcp" : "cli", exports: [], checks: [] };
      const invoke = async (args, name, params = {}, inverse = false, expectedError = false) => {
        operations += 1;
        return Boolean(round % 2) !== inverse ? mcp(name, params, { expectedError }) : cli(args, { expectedError });
      };
      try {
        const tables = await invoke(["data", "list"], "qingzhou_list_data_tables");
        assert.ok(tables.tables.some(table => table.name === TABLE && table.count === ROWS));
        const galleries = await invoke(["images", "list"], "qingzhou_list_image_collections");
        assert.ok(galleries.collections.some(item => item.name === GALLERY));
        assert.ok(galleries.collections.some(item => item.name === OTHER));
        for (const format of ["csv", "xlsx"]) {
          const result = await invoke(["data", "export", TABLE, "--format", format], "qingzhou_export_data_table", { table: TABLE, format });
          assert.equal(result.rows, ROWS);
          const item = await completed(result);
          const parsed = await parseDocument(page, item.bytes, result.filename);
          assert.equal(parsed.sheets[0].rows.length, ROWS);
          assert.equal(parsed.sheets[0].rows[0].title, TEXT);
          assert.equal(String(parsed.sheets[0].rows.at(-1).id), String(ROWS - 1));
          operations += 1;
          const known = await mcp("qingzhou_list_downloads", { id: result.downloadId });
          assert.equal(known.downloads[0].filepath, item.filename);
          assert.equal(known.downloads[0].state, "complete");
          report.exports.push({ kind: format, bytes: item.bytes.length });
        }
        const empty = await completed(await invoke(["data", "export", EMPTY], "qingzhou_export_data_table", { table: EMPTY }));
        const emptyModel = await parseDocument(page, empty.bytes, "empty.xlsx");
        assert.deepEqual(emptyModel.sheets[0].columns, ["name", "url"]);
        assert.deepEqual(emptyModel.sheets[0].rows, []);

        const gallery = await invoke(["images", "export", GALLERY], "qingzhou_export_image_collection", { collection: GALLERY });
        assert.equal(gallery.images, 2);
        assert.equal(gallery.missingImages, 1);
        const images = await completed(gallery);
        const archive = await inspectArchive(page, images.bytes);
        assert.equal(archive.manifest.missingImages, 1);
        assert.equal(archive.metadata.sheets[0].rows.length, 3);
        assert.deepEqual(archive.paths, ["manifest.json", "metadata.xlsx", "images/_image.png", "images/_image-2.png"]);
        assert.deepEqual(archive.imageBytes, [seeded.imageBytes, seeded.imageBytes]);
        report.exports.push({ kind: "images-zip", bytes: images.bytes.length });

        const list = await invoke(["skills", "list", "--query", SKILL], "qingzhou_list_skills", { query: SKILL });
        assert.ok(list.items.some(item => item.name === SKILL));
        const shown = await invoke(["skills", "show", SKILL], "qingzhou_get_skill", { name: SKILL, includeContent: true });
        assert.ok(JSON.stringify(shown).includes("Synthetic soak export fixture"));
        const resource = await invoke(["skills", "read", SKILL, "references/example.txt"], "qingzhou_get_skill_resource", { name: SKILL, path: "references/example.txt" });
        assert.ok(JSON.stringify(resource).includes("Synthetic fixture bytes."));
        const exportedSkill = await completed(await invoke(["skills", "export", SKILL], "qingzhou_export_skill", { name: SKILL }));
        const skillArchive = await inspectArchive(page, exportedSkill.bytes);
        assert.ok(skillArchive.paths.includes(`${SKILL}/SKILL.md`));
        assert.equal(skillArchive.textFiles[`${SKILL}/references/example.txt`], RESOURCE);
        report.exports.push({ kind: "skill-zip", bytes: exportedSkill.bytes.length });

        const settings = await invoke(["settings", "get"], "qingzhou_get_settings");
        assert.equal(Object.hasOwn(settings.config, "apiKey"), false);
        const raw = await page.evaluate(async () => (await chrome.storage.local.get("llmConfig")).llmConfig);
        if (raw?.apiKey) assert.equal(JSON.stringify(settings).includes(raw.apiKey), false);
        const previous = settings.config.debugMode;
        assert.equal(typeof previous, "boolean");
        try {
          await invoke(["settings", "set", "debugMode", String(!previous)], "qingzhou_update_settings", { config: { debugMode: !previous } });
          const changed = await invoke(["settings", "get", "debugMode"], "qingzhou_get_settings", { key: "debugMode" }, true);
          assert.equal(changed.value, !previous);
        } finally {
          await invoke(["settings", "set", "debugMode", String(previous)], "qingzhou_update_settings", { config: { debugMode: previous } });
        }
        assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get("llmConfig")).llmConfig), raw);
        report.checks.push("settings-patch-preserves-model-and-redacts-credentials");
        assert.ok(await invoke(["automations", "list"], "qingzhou_list_automations"));
        assert.ok(await mcp("qingzhou_get_trace", {}));
        operations += 1;
        const recent = await mcp("qingzhou_list_downloads", {});
        assert.ok(recent.downloads.some(item => downloads.has(item.downloadId)));

        if (round % 3 === 0) {
          const rejected = await invoke(["data", "delete", "Soak research row"], "qingzhou_delete_data_table", { table: "Soak research row" }, false, true);
          assert.equal(rejected.code, "RESOURCE_NOT_FOUND");
          const deleted = await invoke(["data", "delete", TABLE], "qingzhou_delete_data_table", { table: TABLE });
          assert.equal(deleted.deleted, ROWS);
          const removed = await invoke(["images", "delete", GALLERY], "qingzhou_delete_image_collection", { collection: GALLERY });
          assert.equal(removed.deleted, 3);
          assert.equal(removed.retainedAssets, true);
          const remaining = await invoke(["images", "list"], "qingzhou_list_image_collections", {}, true);
          assert.ok(remaining.collections.some(item => item.name === OTHER));
          assert.equal(remaining.collections.some(item => item.name === GALLERY), false);
          const surviving = await page.evaluate(async assetId => {
            const { getImageAsset } = await import(chrome.runtime.getURL("shared/asset-store.js"));
            return Boolean((await getImageAsset(assetId, { touch: false }))?.blob);
          }, seeded.assetId);
          assert.equal(surviving, true);
          await seed(page, seeded.assetId);
          report.checks.push("exact-delete-recreate-preserves-sibling-resources-and-shared-asset");
        }
        return { ...report, operations, ok: true };
      } finally {
        await cleanup();
      }
    },
  };
}

async function seed(page, existingAsset) {
  return page.evaluate(async ({ names, existingAsset, rows, text }) => {
    const data = await import(chrome.runtime.getURL("shared/data-store.js"));
    const assets = await import(chrome.runtime.getURL("shared/asset-store.js"));
    await data.insertDataRows(names.table, Array.from({ length: rows }, (_, id) => ({ id, title: id === 0 ? text : `Row ${id}` })), { columns: ["title", "id", "empty"] });
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII="), char => char.charCodeAt(0));
    const assetId = existingAsset || (await assets.saveImageAsset({ bytes, mimeType: "image/png" }, { thumbnail: false })).assetId;
    await data.insertDataRows(names.gallery, [{ assetId, title: "../image" }, { assetId, title: "../image" }, { assetId: "img_missing", title: "Missing" }]);
    await data.updateDataTableMetadata(names.gallery, { kind: "image_collection" });
    if (!existingAsset) {
      await data.setDataTableColumns(names.empty, ["name", "url"]);
      await data.insertDataRows(names.other, [{ assetId, title: "Shared image" }]);
      await data.updateDataTableMetadata(names.other, { kind: "image_collection" });
    }
    return { assetId, imageBytes: [...bytes] };
  }, { names: { table: TABLE, gallery: GALLERY, empty: EMPTY, other: OTHER }, existingAsset, rows: ROWS, text: TEXT });
}

function parseDocument(page, bytes, filename) {
  return page.evaluate(async ({ bytes, filename }) => {
    const { parseDocumentBytes } = await import(chrome.runtime.getURL("shared/documents/document-codecs.js"));
    return parseDocumentBytes(new Uint8Array(bytes), { filename });
  }, { bytes, filename });
}

function inspectArchive(page, bytes) {
  return page.evaluate(async bytes => {
    const { openZip } = await import(chrome.runtime.getURL("shared/zip-bytes.js"));
    const { parseDocumentBytes } = await import(chrome.runtime.getURL("shared/documents/document-codecs.js"));
    const decoder = new TextDecoder();
    const zip = openZip(new Uint8Array(bytes), { decode: bytes => decoder.decode(bytes) });
    const textFiles = {};
    const imageBytes = [];
    let metadata;
    for (const entry of zip.entries) {
      if (entry.name === "metadata.xlsx") metadata = await parseDocumentBytes(await zip.read(entry, 1_000_000), { filename: entry.name });
      if (entry.name.startsWith("images/")) imageBytes.push([...await zip.read(entry, 1_000_000)]);
      if (/\.(json|md|txt)$/.test(entry.name)) textFiles[entry.name] = decoder.decode(await zip.read(entry, 1_000_000));
    }
    return { paths: zip.entries.map(entry => entry.name), metadata, textFiles, imageBytes,
      manifest: textFiles["manifest.json"] ? JSON.parse(textFiles["manifest.json"]) : null };
  }, bytes);
}
