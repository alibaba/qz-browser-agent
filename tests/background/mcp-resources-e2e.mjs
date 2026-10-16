import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { callTool, readHealth } from "../../services/mcp-bridge/src/client.mjs";
import {
  PROJECT_ROOT, assertNoUnexpectedDiagnostics, extensionRequest, launchIsolatedExtensionMcp,
} from "../support/isolated-extension-mcp.mjs";

const downloadDirectory = mkdtempSync(join(tmpdir(), "qz-resource-downloads-"));
const report = { ok: false, scenario: "mcp-cli-resources", cases: [] };
let environment;
try {
  environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-resource-e2e-", requestTimeoutSeconds: 40, downloadDirectory });
  const dependencies = { findDaemon: async () => ({ endpoint: environment.bridge.endpoint, health: await readHealth(environment.bridge.endpoint) }) };
  const command = async (...args) => (await runCli([...args, "--timeout", "30"], dependencies)).result;
  const downloads = (args = {}) => callTool(environment.bridge.endpoint, "qingzhou_list_downloads", {
    clientId: environment.bridgeStatus.clients[0].clientId, timeoutSeconds: 30, ...args,
  }, { timeoutMs: 30_000 });
  let lastExport;
  const seeded = await seedResources(environment.page);
  const listed = await command("data", "list");
  assert.ok(listed.tables.some(table => table.name === "Synthetic rows" && table.count === 1005));
  const images = await command("images", "list");
  assert.deepEqual(images.collections.map(item => item.name).sort(), ["Other collection", "Synthetic gallery"]);

  for (const format of ["csv", "xlsx"]) {
    const exported = await command("data", "export", "Synthetic rows", "--format", format);
    assert.equal(exported.rows, 1005);
    assert.deepEqual(exported.columns, ["title", "id", "empty", "extra"]);
    const completed = await completedDownload(exported);
    assert.equal(exported.state, "complete", "small exports return an immediately usable download");
    assert.equal(exported.filepath, completed.filename);
    const parsed = await parseDownloaded(completed.filename, exported.filename);
    assert.equal(parsed.sheets[0].rows.length, 1005);
    assert.equal(parsed.sheets[0].rows.at(-1).id, "1004");
    assert.equal(parsed.sheets[0].rows[0].title, '杭州, "quote"\nsecond line');
    report.cases.push({ name: `data-${format}-1005-rows`, ok: true, downloadId: exported.downloadId, bytes: completed.fileSize });
    lastExport = exported;
  }
  const knownDownload = await downloads({ id: lastExport.downloadId });
  assert.equal(knownDownload.downloads.length, 1);
  assert.equal(knownDownload.downloads[0].downloadId, lastExport.downloadId);
  assert.equal(knownDownload.downloads[0].filepath, lastExport.filepath);
  assert.equal(knownDownload.downloads[0].state, "complete");
  assert.ok((await downloads()).downloads.some(item => item.downloadId === lastExport.downloadId));
  report.cases.push({ name: "downloads-list-and-exact-id-recovery", ok: true });
  const empty = await command("data", "export", "Empty table");
  assert.equal(empty.format, "xlsx", "the default table export is XLSX");
  const emptyDownload = await completedDownload(empty);
  const emptyModel = await parseDownloaded(emptyDownload.filename, empty.filename);
  assert.deepEqual(emptyModel.sheets[0].columns, ["name", "url"]);
  assert.deepEqual(emptyModel.sheets[0].rows, []);
  report.cases.push({ name: "empty-table-headers", ok: true });

  const gallery = await command("images", "export", "Synthetic gallery");
  assert.equal(gallery.rows, 3);
  assert.equal(gallery.images, 2);
  assert.equal(gallery.missingImages, 1);
  const galleryDownload = await completedDownload(gallery);
  const archive = await inspectArchive(galleryDownload.filename);
  assert.equal(archive.manifest.missingImages, 1);
  assert.deepEqual(archive.paths, ["manifest.json", "metadata.xlsx", "images/_image.png", "images/_image-2.png"]);
  assert.equal(archive.metadata.sheets[0].rows.length, 3);
  assert.equal(archive.metadata.sheets[0].rows[2].imageFile, "");
  report.cases.push({ name: "gallery-zip-missing-asset-safe-paths", ok: true, downloadId: gallery.downloadId });

  await assert.rejects(command("images", "delete", "Synthetic rows"));
  await assert.rejects(command("data", "delete", "Synthetic row"));
  assert.ok((await command("data", "list")).tables.some(table => table.name === "Synthetic rows"));
  const deleted = await command("images", "delete", "Synthetic gallery");
  assert.equal(deleted.deleted, 3);
  assert.equal(deleted.retainedAssets, true);
  assert.deepEqual((await command("images", "list")).collections.map(item => item.name), ["Other collection"]);
  const surviving = await environment.page.evaluate(async assetId => {
    const { getImageAsset } = await import(chrome.runtime.getURL("shared/asset-store.js"));
    return Boolean((await getImageAsset(assetId, { touch: false }))?.blob);
  }, seeded.assetId);
  assert.equal(surviving, true, "a shared image survives collection deletion");
  assert.equal((await command("data", "delete", "Synthetic rows")).deleted, 1005);
  assert.ok((await command("data", "list")).tables.some(table => table.name === "Empty table"));
  report.cases.push({ name: "exact-delete-preserves-other-resources-and-shared-assets", ok: true });

  const skill = await environment.page.evaluate(async () => {
    const { normalizeModernSkill } = await import(chrome.runtime.getURL("shared/skills/skill-utils.js"));
    return normalizeModernSkill({ name: "mcp-resource-fixture", description: "Synthetic export fixture", content: "# Synthetic Skill\nRead references/example.txt.",
      resources: [{ path: "references/example.txt", content: "Synthetic fixture bytes." }] });
  });
  const saved = await extensionRequest(environment.page, "save_workspace_skill", { name: skill.name, expected: null, skill }, "skill_workspace_saved");
  assert.equal(saved.registryReady, true);
  const skills = await command("skills", "list", "--query", skill.name);
  assert.ok(skills.items.some(item => item.name === skill.name));
  const shown = await command("skills", "show", skill.name);
  assert.ok(JSON.stringify(shown).includes("Synthetic export fixture"));
  const skillDownload = await completedDownload(await command("skills", "export", skill.name));
  const skillArchive = await inspectArchive(skillDownload.filename);
  assert.ok(skillArchive.paths.includes(`${skill.name}/SKILL.md`));
  assert.equal(skillArchive.textFiles[`${skill.name}/references/example.txt`], "Synthetic fixture bytes.");
  report.cases.push({ name: "custom-skill-list-show-export", ok: true });

  const settings = await command("settings");
  assert.ok(settings.fields.some(field => field.key === "debugMode"));
  await command("settings", "set", "debugMode", "true");
  assert.equal((await command("settings", "get", "debugMode")).value, true);
  const rawBeforeFlags = await environment.page.evaluate(async () => (await chrome.storage.local.get("llmConfig")).llmConfig);
  await command("settings", "set", JSON.stringify({ debugMode: false, requestRateLimit: true }));
  assert.equal((await command("settings", "get", "debugMode")).value, false);
  assert.equal((await command("settings", "get", "requestRateLimit")).value, true);
  const rawAfterFlags = await environment.page.evaluate(async () => (await chrome.storage.local.get("llmConfig")).llmConfig);
  assert.deepEqual(rawAfterFlags, { ...rawBeforeFlags, debugMode: false, requestRateLimit: true });
  await assert.rejects(command("settings", "set", JSON.stringify({ provider: "custom", customEndpoint: "", model: "synthetic-model" })));
  assert.deepEqual(await environment.page.evaluate(async () => (await chrome.storage.local.get("llmConfig")).llmConfig), rawAfterFlags);
  assert.equal(Object.hasOwn(settings.config, "apiKey"), false);
  report.cases.push({ name: "settings-discovery-flags-preserve-model-invalid-patch-no-write", ok: true });
  assertNoUnexpectedDiagnostics(environment.diagnostics);
  report.ok = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  try {
    const directory = join(PROJECT_ROOT, "tests/results/mcp-bridge");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "resources-e2e.json"), JSON.stringify({ ...report,
      diagnostics: environment?.diagnostics || [], logs: environment?.bridge.logs || [],
    }, null, 2));
  } finally {
    await environment?.close().catch(() => undefined);
    rmSync(downloadDirectory, { recursive: true, force: true });
  }
}

async function seedResources(page) {
  return page.evaluate(async () => {
    const data = await import(chrome.runtime.getURL("shared/data-store.js"));
    const assets = await import(chrome.runtime.getURL("shared/asset-store.js"));
    await data.insertDataRows("Synthetic rows", Array.from({ length: 1005 }, (_, id) => ({
      id, title: id === 0 ? '杭州, "quote"\nsecond line' : `Row ${id}`, extra: { value: id },
    })), { columns: ["title", "id", "empty"] });
    await data.setDataTableColumns("Empty table", ["name", "url"]);
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII="), char => char.charCodeAt(0));
    const asset = await assets.saveImageAsset({ bytes, mimeType: "image/png" }, { thumbnail: false });
    await data.insertDataRows("Synthetic gallery", [
      { assetId: asset.assetId, title: "../image" }, { assetId: asset.assetId, title: "../image" },
      { assetId: "img_missing", title: "Missing" },
    ]);
    await data.updateDataTableMetadata("Synthetic gallery", { kind: "image_collection" });
    await data.insertDataRows("Other collection", [{ assetId: asset.assetId, title: "Shared image" }]);
    await data.updateDataTableMetadata("Other collection", { kind: "image_collection" });
    return { assetId: asset.assetId };
  });
}

async function completedDownload(result) {
  assert.ok(Number.isInteger(result.downloadId));
  assert.equal(Object.hasOwn(result, "base64"), false);
  let item;
  const deadline = Date.now() + 20_000;
  do {
    item = await environment.page.evaluate(async id => (await chrome.downloads.search({ id }))[0], result.downloadId);
    if (item?.state === "complete" || item?.state === "interrupted") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.ok(item, "Chrome retains the exact download ID until completion");
  assert.equal(item.state, "complete", JSON.stringify(item));
  assert.ok(item.filename.startsWith(`${downloadDirectory}/`), `download must stay in ${downloadDirectory}: ${item.filename}`);
  assert.ok(!relative(downloadDirectory, item.filename).startsWith(".."));
  return item;
}

async function parseDownloaded(path, filename) {
  const bytes = [...readFileSync(path)];
  return environment.page.evaluate(async ({ bytes, filename }) => {
    const { parseDocumentBytes } = await import(chrome.runtime.getURL("shared/documents/document-codecs.js"));
    return parseDocumentBytes(new Uint8Array(bytes), { filename });
  }, { bytes, filename });
}

async function inspectArchive(filename) {
  const bytes = [...readFileSync(filename)];
  return environment.page.evaluate(async bytes => {
    const { openZip } = await import(chrome.runtime.getURL("shared/zip-bytes.js"));
    const { parseDocumentBytes } = await import(chrome.runtime.getURL("shared/documents/document-codecs.js"));
    const decoder = new TextDecoder();
    const zip = openZip(new Uint8Array(bytes), { decode: bytes => decoder.decode(bytes) });
    const textFiles = {};
    let metadata;
    for (const entry of zip.entries) {
      if (entry.name === "metadata.xlsx") metadata = await parseDocumentBytes(await zip.read(entry, 1_000_000), { filename: entry.name });
      if (/\.(json|md|txt)$/.test(entry.name)) textFiles[entry.name] = decoder.decode(await zip.read(entry, 1_000_000));
    }
    return { paths: zip.entries.map(entry => entry.name), metadata, textFiles,
      manifest: textFiles["manifest.json"] ? JSON.parse(textFiles["manifest.json"]) : null };
  }, bytes);
}
