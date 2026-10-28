import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, extensionOutputDirectory } from "../../scripts/build-extension.mjs";
import { FIREFOX_GECKO_ID } from "../../scripts/firefox-manifest.mjs";
import { assertFirefoxPackage, resolveFirefoxExecutable } from "../support/browser-package.mjs";
import "../support/typescript-loader.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const reportPath = join(root, "tests/results/firefox-suite.json");
const supplied = process.env.QINGZHOU_FIREFOX_EXTENSION_DIR;
const packageDir = supplied || extensionOutputDirectory("firefox");
const firefox = resolveFirefoxExecutable();
const report = {
  browser: "firefox",
  browserVersion: firefox.version,
  executablePath: firefox.executablePath,
  package: supplied ? packageDir : "dist/extension-firefox",
  packageDir,
  geckoId: FIREFOX_GECKO_ID,
  playwrightConfig: "tests/config/playwright.firefox.config.mjs",
  chromium: false,
  status: "running",
};

console.log(`browser=firefox package=${report.package} executable=${firefox.executablePath} version=${firefox.version}`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

try {
  if (!supplied) {
    console.log("browser=firefox package=dist/extension-firefox step=build");
    await buildExtension({ browser: "firefox", mode: "development", outputDir: packageDir });
  }
  const manifest = assertFirefoxPackage(JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8")), packageDir);
  if (manifest.browser_specific_settings.gecko.id !== FIREFOX_GECKO_ID) {
    throw new Error(`Firefox package id is ${manifest.browser_specific_settings.gecko.id}`);
  }
  const unitFiles = readdirSync(join(root, "tests/unit"))
    .filter(name => /^test-firefox-.*\.mjs$/.test(name))
    .sort()
    .map(name => join("tests/unit", name));
  if (!unitFiles.length) throw new Error("Firefox unit tests were not found in tests/unit/test-firefox-*.mjs");
  console.log(`browser=firefox package=${report.package} step=unit files=${unitFiles.length}`);
  const unitCode = await run(process.execPath, [
    "--test", "--test-reporter=spec", "--test-concurrency=4",
    "--require=./tests/support/unit-bootstrap.cjs",
    ...unitFiles,
  ]);
  if (unitCode !== 0) throw new Error(`Firefox unit tests exited ${unitCode}`);
  console.log(`browser=firefox package=${report.package} step=playwright`);
  const playwrightCode = await run(process.execPath, [
    "node_modules/@playwright/test/cli.js", "test",
    "--config", "tests/config/playwright.firefox.config.mjs",
  ]);
  if (playwrightCode !== 0) throw new Error(`Firefox Playwright exited ${playwrightCode}`);
  report.status = "passed";
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`browser=firefox package=${report.package} status=passed report=${reportPath}`);
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(report.error);
  process.exitCode = 1;
}

function run(command, args) {
  const env = { ...process.env, FIREFOX_EXECUTABLE: firefox.executablePath, QINGZHOU_FIREFOX_EXTENSION_DIR: packageDir };
  delete env.QINGZHOU_TEST_EXTENSION_DIR;
  delete env.QINGZHOU_EXTENSION_PATH;
  delete env.QINGZHOU_PLAYWRIGHT_CHANNEL;
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("exit", code => resolve(code ?? 1));
  });
}
