import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import "../support/typescript-loader.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { assertPublicReleasePackage } from "./public-package.mjs";
import { verifyStaticEngines } from "./static-engines.mjs";
import { assertNoRemoteCode } from "../../scripts/check-no-remote-code.mjs";
import { assertReviewableCode } from "../../scripts/check-reviewable-code.mjs";
import { checkStore } from "../../scripts/check-store.mjs";

const zip = resolve(process.argv[2] || "dist/releases/0.1.5/webstore/qz-browser-agent-extension-0.1.5.webstore.zip");
const evidenceDir = resolve(process.argv[3] || "tests/results/final-store-zip");
const work = await mkdtemp(join(tmpdir(), "qz-final-store-"));
const extension = join(work, "extension");
let context;
try {
  await mkdir(evidenceDir, { recursive: true });
  assertPublicReleasePackage(zip);
  execFileSync("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zip, extension]);
  await assertNoRemoteCode([extension]);
  const audit = await assertReviewableCode(extension);
  await writeFile(join(evidenceDir, "code-audit.json"), JSON.stringify(audit, null, 2));
  const storecheck = await checkStore(zip);
  await writeFile(join(evidenceDir, "storecheck.json"), JSON.stringify(storecheck, null, 2));
  assert.equal(storecheck.ok, true);
  context = await chromium.launchPersistentContext(join(work, "profile"), {
    headless: true, executablePath: chromium.executablePath(), locale: "zh-CN", acceptDownloads: true,
    ignoreDefaultArgs: ["--disable-extensions"], viewport: { width: 640, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers().find(item => item.url().endsWith("/background/service-worker.js"))
    || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const version = await worker.evaluate(() => chrome.runtime.getManifest().version);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await acceptDataDisclosure(page);
  await page.locator("#input").waitFor();
  const result = await verifyStaticEngines({ context, page, worker, evidenceDir });
  const report = { ...result, version, extensionId, zip, zipSha256: createHash("sha256").update(await readFile(zip)).digest("hex"),
    scriptCount: audit.length, storecheck: { raw: storecheck.rawCli.summary, effective: storecheck.effective.summary, exceptions: storecheck.exceptions } };
  await writeFile(join(evidenceDir, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await rm(work, { recursive: true, force: true });
}
