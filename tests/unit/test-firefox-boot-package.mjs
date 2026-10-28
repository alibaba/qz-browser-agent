import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildExtension, EXTENSION_ENTRIES } from "../../scripts/build-extension.mjs";

test("firefox production keeps boot imports that the service worker also bundles", async t => {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-firefox-boot-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const sourceDir = join(work, "source");
  await mkdir(sourceDir);
  const manifest = {
    manifest_version: 3,
    name: "fixture",
    version: "0.0.1",
    background: { service_worker: "background/service-worker.js", type: "module" },
    side_panel: { default_path: "sidepanel/sidepanel.html" },
    content_scripts: [{ js: EXTENSION_ENTRIES.filter(entry => entry.path.startsWith("content/")).map(entry => entry.path) }],
    sandbox: { pages: ["runner-sandbox.html"] },
    declarative_net_request: { rule_resources: [] },
  };
  await put(sourceDir, "manifest.json", JSON.stringify(manifest));
  for (const entry of EXTENSION_ENTRIES) await put(sourceDir, entry.path, "globalThis.fixture = true;\n");
  await put(sourceDir, "sidepanel/sidepanel.html", '<script src="../shared/mathjax-config.js"></script><script type="module" src="sidepanel.js"></script>');
  await put(sourceDir, "offscreen.html", '<script type="module" src="offscreen.js"></script>');
  await put(sourceDir, "runner-sandbox.html", '<script src="runner-sandbox.js"></script>');
  await rm(join(sourceDir, "background/service-worker.js"));
  await put(sourceDir, "background/service-worker.ts", [
    'import { value } from "../shared/value.js";',
    'import { ALARM } from "../shared/alarm.js";',
    'import { ONLY } from "../shared/worker-only.js";',
    "export const answer: number = value + ALARM.length + ONLY;",
    "",
  ].join("\n"));
  await put(sourceDir, "shared/value.ts", "export const value: number = 42;\n");
  await put(sourceDir, "shared/alarm.ts", 'export const ALARM = "qingzhou-mcp-bridge-reconnect";\n');
  await put(sourceDir, "shared/worker-only.ts", "export const ONLY = 1;\n");
  await put(sourceDir, "offscreen.js", 'import { value } from "./shared/value.js";\nglobalThis.offscreenValue = value;\n');
  await rm(join(sourceDir, "content/content-script.js"));
  await put(sourceDir, "content/content-script.ts", 'import { value } from "../shared/value.js";\nglobalThis.answer = value;\n');
  await put(sourceDir, "background/firefox-boot.ts", 'import "./firefox/host.js";\nimport "./service-worker.js";\n');
  await put(sourceDir, "background/firefox/host.ts", 'import {\n  ALARM,\n} from "../../shared/alarm.js";\nexport const alarm = ALARM;\n');
  await put(sourceDir, "sidepanel/firefox-boot.ts", 'import "./firefox/host.js";\nimport "./sidepanel.js";\n');
  await put(sourceDir, "sidepanel/firefox/host.ts", 'import { ALARM } from "../../shared/alarm.js";\nexport const alarm = ALARM;\n');

  const firefox = await buildExtension({ sourceDir, outputDir: join(work, "firefox"), mode: "production", browser: "firefox" });
  assert.ok(firefox.files.includes("background/firefox-boot.js"));
  assert.ok(firefox.files.includes("background/firefox/host.js"));
  assert.ok(firefox.files.includes("sidepanel/firefox-boot.js"));
  assert.ok(firefox.files.includes("shared/alarm.js"), "a module imported by the boot graph survives service-worker bundling");
  assert.equal(firefox.files.includes("shared/worker-only.js"), false, "a service-worker-only module is still inlined and removed");
  assert.match(await readFile(join(firefox.outputDir, "background/firefox/host.js"), "utf8"), /shared\/alarm\.js/);
  assert.equal((await readFile(join(firefox.outputDir, "background/firefox/host.js"), "utf8")).includes("worker-only"), false);
  const manifestOut = JSON.parse(await readFile(join(firefox.outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifestOut.background.scripts, ["background/firefox-boot.js"]);

  const chrome = await buildExtension({ sourceDir, outputDir: join(work, "chrome"), mode: "production", browser: "chrome" });
  assert.equal(chrome.files.includes("background/firefox-boot.js"), false);
  assert.equal(chrome.files.includes("shared/alarm.js"), false, "Chrome still inlines a module that only the bundled worker imports");
  assert.equal(chrome.files.includes("shared/worker-only.js"), false);
  assert.ok(chrome.files.includes("shared/value.js"));
});

async function put(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}
