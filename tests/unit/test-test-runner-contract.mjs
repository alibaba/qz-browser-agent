import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "acorn";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("full verification inventories production coverage and includes indexed extension E2E", () => {
  const listed = execFileSync(process.execPath, ["tests/run.mjs", "--all", "--coverage", "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  const c8 = JSON.parse(readFileSync(join(root, "tests/config/c8.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.match(listed, /tests\/data-grid\/extension-page\.mjs/);
  assert.match(listed, /tests\/background\/extension-e2e\.mjs/);
  assert.match(listed, /tests\/release\/chrome-smoke\.mjs/);
  assert.equal(c8.all, true, "coverage must expose production files that no test loads");
  assert.equal(pkg.scripts.verify, "npm run typecheck && npm test -- unit contracts services");
  assert.doesNotMatch(pkg.scripts.verify, /--coverage|firefox|browser|e2e|release|visual|--all/);
  assert.equal(pkg.scripts["verify:chrome"], "npm test -- browser e2e release visual");
  assert.doesNotMatch(pkg.scripts["verify:chrome"], /--coverage|firefox|typecheck|--all/);
  assert.equal(pkg.scripts["verify:firefox"], "npm run typecheck && npm test -- firefox");
  assert.equal(pkg.scripts["verify:coverage"], "npm run typecheck && npm test -- --all --coverage");
  assert.equal(pkg.scripts["verify:quick"], undefined);
  assert.match(listed, /Coverage: c8 \+ full runtime critical gate/);
  assert.doesNotMatch(listed, /tests\/live\/|agent-behavior-e2e/);
  assert.doesNotMatch(listed, /tests\/firefox\/run\.mjs|playwright\.firefox\.config/);
  const firefox = execFileSync(process.execPath, ["tests/run.mjs", "firefox", "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(firefox, /tests\/firefox\/run\.mjs/);
  assert.doesNotMatch(firefox, /tests\/config\/playwright\.config\.mjs/);
  const shared = execFileSync(process.execPath, ["tests/run.mjs", "unit", "contracts", "services", "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(shared, /\nunit:/);
  assert.doesNotMatch(shared, /playwright\.config\.mjs|chrome-smoke\.mjs|tests\/firefox\/run\.mjs/);
  const chrome = execFileSync(process.execPath, ["tests/run.mjs", "browser", "e2e", "release", "visual", "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(chrome, /playwright\.config\.mjs/);
  assert.match(chrome, /chrome-smoke\.mjs/);
  assert.doesNotMatch(chrome, /tests\/firefox\/run\.mjs|\nunit:/);
});

test("Playwright loads production modules from the browser build, not its Node collector", () => {
  // Playwright and tsx emit different JavaScript for one source URL. Mixing both in
  // Node coverage merges incompatible V8 offsets before source maps are applied.
  const violations = [];
  const directories = ["tests/browser"];
  if (existsSync(join(root, "tests/internal"))) directories.push("tests/internal");
  for (const directory of directories) {
    for (const filename of readdirSync(join(root, directory), { recursive: true })) {
      if (!filename.endsWith(".spec.mjs")) continue;
      const path = join(root, directory, filename);
      for (const source of productionImports(readFileSync(path, "utf8"), path)) {
        violations.push(`${relative(root, path)}: ${source}`);
      }
    }
  }
  assert.deepEqual(violations, [], "use page.evaluate() with /extension/ emitted modules");

  const fixture = join(root, "tests/browser/example.spec.mjs");
  assert.deepEqual(productionImports(`
    import { value } from "../../src/shared/example.js";
    await import("../../src/background/example.js");
    await import("#sdk/background");
    await page.evaluate(() => import("/extension/shared/example.js"));
  `, fixture), ["../../src/shared/example.js", "../../src/background/example.js", "#sdk/background"]);
});

function productionImports(source, filename) {
  const imports = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ImportExpression", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      const specifier = node.source?.value;
      if (typeof specifier === "string" && (
        /^#(?:sdk|capabilities)\//.test(specifier)
        || relative(join(root, "src"), resolve(dirname(filename), specifier)).split(/[\\/]/)[0] !== ".."
      )) imports.push(specifier);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return imports;
}


test("standalone Playwright ignores generated snapshots and shares Unit source-map coordinates", () => {
  const artifacts = join(root, "tests/results");
  mkdirSync(artifacts, { recursive: true });
  const snapshot = mkdtempSync(join(artifacts, "collector-snapshot-"));
  try {
    mkdirSync(join(snapshot, "tests/browser"), { recursive: true });
    writeFileSync(join(snapshot, "tests/browser/artifact.spec.mjs"), 'throw new Error("Generated snapshot was collected");');
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_TEST_CONTEXT;
    const nodeCoverage = join(snapshot, "node-coverage");
    const playwrightCoverage = join(snapshot, "playwright-coverage");
    execFileSync(process.execPath, ["--import", "./tests/support/typescript-loader.mjs", "--input-type=module",
      "--eval", 'await import("./src/background/llm/transport.js")'], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...environment, NODE_V8_COVERAGE: nodeCoverage },
    });
    const listed = execFileSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "tests/config/playwright.config.mjs", "--list"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...environment, NODE_V8_COVERAGE: playwrightCoverage },
    });
    assert.match(listed, /renderer-lifecycle\.spec\.mjs/);
    assert.doesNotMatch(listed, /artifact\.spec\.mjs/);
    const sourceUrl = pathToFileURL(join(root, "src/background/llm/transport.ts")).href;
    const coordinates = directory => readdirSync(directory).flatMap(file => {
      const record = JSON.parse(readFileSync(join(directory, file), "utf8"));
      const map = record["source-map-cache"]?.[sourceUrl];
      return map ? [{ lineLengths: map.lineLengths, mappings: map.data.mappings }] : [];
    });
    const expected = coordinates(nodeCoverage);
    const actual = coordinates(playwrightCoverage);
    assert.ok(expected.length && actual.length, "both entry points must record the production module");
    for (const map of actual) assert.deepEqual(map, expected[0], "c8 cannot merge different generated coordinates under one source URL");
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
});
