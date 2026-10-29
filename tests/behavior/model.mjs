import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT_ROOT = resolve(TESTS_ROOT, "..");
export const BEHAVIOR_INDEX_PATH = resolve(TESTS_ROOT, "BEHAVIOR_INDEX.md");

// Keep the existing report shape while allowing contributor docs in either language.
const FIELD_LABELS = {
  角色: "Role",
  任务: "Task",
  前置: "Preconditions",
  步骤: "Steps",
  成功结果: "Expected outcome",
  失败与恢复: "Failure and recovery",
  现有证据: "Evidence",
  覆盖判断: "Coverage",
  下一测试: "Next test",
};
const REQUIRED_FIELDS = Object.keys(FIELD_LABELS);
const EXPECTED_ROLE = { H: "Human", A: "Agent", S: "System" };
const EXPECTED_MINIMUMS = { H: 16, A: 21, S: 13 };
const COVERAGE_VALUES = new Set(["强", "中", "弱", "缺"]);
const COVERAGE_LABELS = { strong: "强", medium: "中", weak: "弱", missing: "缺" };

export function loadBehaviorIndex(indexPath = BEHAVIOR_INDEX_PATH) {
  const source = readFileSync(indexPath, "utf8");
  const headingPattern = /^### ([HAS]\d{2}) · ([^\n]+)$/gmu;
  const headings = [...source.matchAll(headingPattern)];
  const journeys = headings.map((match, index) => {
    const bodyStart = match.index + match[0].length;
    const nextHeading = headings[index + 1]?.index ?? source.length;
    const nextSection = source.indexOf("\n## ", bodyStart);
    const bodyEnd = nextSection >= 0 && nextSection < nextHeading ? nextSection : nextHeading;
    const body = source.slice(bodyStart, bodyEnd);
    const fields = Object.fromEntries(REQUIRED_FIELDS.map(field => [field, readField(body, field)]));
    fields["覆盖判断"] = normalizeCoverage(fields["覆盖判断"]);
    return {
      id: match[1],
      title: match[2].trim(),
      body,
      fields,
      role: fields["角色"],
      coverage: fields["覆盖判断"],
      evidence: parseEvidence(fields["现有证据"]),
    };
  });
  const summaryRows = [...source.matchAll(/^\| ([HAS]\d{2}) \| [^|\n]+ \| ([^|\n]+) \|/gmu)];
  const summaryIds = summaryRows.map(match => match[1]);
  const summaryCoverage = Object.fromEntries(summaryRows.map(match => [match[1], normalizeCoverage(match[2])]));
  const index = { indexPath: resolve(indexPath), source, journeys, summaryIds, summaryCoverage };
  validateBehaviorIndex(index);
  return index;
}

export function validateBehaviorIndex(index) {
  const { indexPath, source, journeys, summaryIds, summaryCoverage } = index;
  assert.ok(journeys.length >= 50, `expected a product-wide journey index, got ${journeys.length}`);
  assert.equal(new Set(journeys.map(journey => journey.id)).size, journeys.length, "journey IDs must be unique");
  assert.equal(new Set(summaryIds).size, summaryIds.length, "summary contains duplicate journey IDs");

  for (const [prefix, minimum] of Object.entries(EXPECTED_MINIMUMS)) {
    const count = journeys.filter(journey => journey.id.startsWith(prefix)).length;
    assert.ok(count >= minimum, `expected at least ${minimum} ${prefix} journeys, got ${count}`);
  }

  const summarySet = new Set(summaryIds);
  for (const journey of journeys) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(journey.fields[field], `${journey.id} is missing ${field}`);
    }
    assert.equal(journey.role, EXPECTED_ROLE[journey.id[0]], `${journey.id} has the wrong role`);
    assert.ok(COVERAGE_VALUES.has(journey.coverage), `${journey.id} has an invalid coverage rating`);
    assert.ok(summarySet.has(journey.id), `${journey.id} is missing from the summary table`);
    assert.equal(summaryCoverage[journey.id], journey.coverage, `${journey.id} coverage differs between summary and detail`);
    if (journey.coverage === "强") {
      assert.ok(journey.evidence.length > 0, `${journey.id} is strong but has no linked evidence`);
      assert.match(journey.fields["失败与恢复"], /\S/u, `${journey.id} is strong but has no recovery oracle`);
    }
  }
  assert.deepEqual(
    [...summarySet].sort(),
    journeys.map(journey => journey.id).sort(),
    "summary and detailed journey IDs must match",
  );

  const testsRoot = dirname(indexPath);
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)) {
    const target = match[1].trim();
    if (/^(?:https?:|mailto:)/u.test(target)) continue;
    const resolved = resolve(testsRoot, target);
    assert.ok(resolved.startsWith(`${testsRoot}/`) || resolved === testsRoot, `link escapes tests/: ${target}`);
    assert.ok(existsSync(resolved), `behavior index evidence does not exist: ${target}`);
  }
  return index;
}

export function classifyEvidence(target) {
  const normalized = normalizeEvidenceTarget(target);
  if (["unit/test-node-mcp-bridge.mjs", "unit/test-node-mcp-cli.mjs"].includes(normalized)) {
    return evidence(normalized, "automated", "service", "service:node-mcp");
  }
  if (/^unit\/test-.*\.mjs$/u.test(normalized)) {
    return evidence(normalized, "automated", "unit", "unit");
  }
  if (/^browser\/.*\.spec\.mjs$/u.test(normalized)) {
    return evidence(normalized, "automated", "browser", "browser");
  }
  if (normalized === "integration/test-agent-behavior-acceptance.py") {
    return evidence(normalized, "automated", "service", "service:mcp");
  }
  if (normalized === "background/image-conversion-e2e.mjs") {
    return evidence(normalized, "automated", "e2e", "e2e:image-conversion");
  }
  if (normalized === "background/extension-e2e.mjs") {
    return evidence(normalized, "automated", "e2e", "e2e:extension");
  }
  if (normalized === "background/mcp-tab-ownership-e2e.mjs") {
    return evidence(normalized, "automated", "e2e", "e2e:mcp-tab-ownership");
  }
  if (["qingzhou-documents/e2e-check.py", "session-exchange/e2e-check.py"].includes(normalized)) {
    return evidence(normalized, "automated", "e2e", `e2e:python:${normalized}`);
  }
  if (normalized === "data-grid/browser-matrix.mjs") {
    return evidence(normalized, "automated", "browser", "browser:data-grid");
  }
  if (normalized === "data-grid/extension-page.mjs") {
    return evidence(normalized, "automated", "e2e", "e2e:data-grid-extension");
  }
  if (normalized === "release/bundle-release.test.mjs") {
    return evidence(normalized, "automated", "release", "release:bundle");
  }
  if (normalized === "release/chrome-smoke.mjs") {
    return evidence(normalized, "automated", "release", "release:chrome");
  }
  if (normalized === "benchmarks/conversation-render/run.mjs") {
    return evidence(normalized, "automated", "benchmark", "benchmark:conversation");
  }
  if (normalized === "benchmarks/conversation-render/run-visual-audit-matrix.mjs") {
    return evidence(normalized, "automated", "visual", "visual:conversation");
  }
  if (normalized === "benchmarks/data-grid-large-runner.mjs") {
    return evidence(normalized, "automated", "benchmark", "benchmark:data-grid");
  }
  if (normalized === "benchmarks/message-stream.py") {
    return evidence(normalized, "automated", "benchmark", "benchmark:message-stream");
  }
  if (["background/agent-behavior-e2e.mjs", "background/agent-behavior-regression.py"].includes(normalized)) {
    return evidence(normalized, "explicit", "agent", "agent:model-regression");
  }
  if (normalized === "live/page-batch-case.mjs") {
    return evidence(normalized, "explicit", "agent", "live:page-batch");
  }
  if (normalized === "live/ax-viewport.mjs") {
    return evidence(normalized, "explicit", "agent", "live:ax-viewport");
  }
  if (normalized === "live/ax-viewport-public.mjs") {
    return evidence(normalized, "explicit", "agent", "live:ax-viewport-public");
  }
  if (normalized === "behavior/probes/notification-return.mjs") {
    return evidence(normalized, "automated", "e2e", "probe:notification-return");
  }
  if (normalized.startsWith("fixtures/") || normalized.endsWith("/README.md")) {
    return evidence(normalized, "reference", "manual", `reference:${normalized}`);
  }
  return evidence(normalized, "unknown", "unknown", `unknown:${normalized}`);
}

export function createEvidencePlan(index, filters = {}) {
  const journeyIds = new Set(splitFilter(filters.journeyIds).map(value => value.toUpperCase()));
  const actors = new Set(splitFilter(filters.actors).map(normalizeActor));
  const coverages = new Set(splitFilter(filters.coverages).map(normalizeCoverage));
  const layers = new Set(splitFilter(filters.layers));
  const selectedJourneys = index.journeys.filter(journey => (
    (!journeyIds.size || journeyIds.has(journey.id))
    && (!actors.size || actors.has(journey.role))
    && (!coverages.size || coverages.has(journey.coverage))
  ));
  if (journeyIds.size) {
    const selectedIds = new Set(selectedJourneys.map(journey => journey.id));
    const unknown = [...journeyIds].filter(id => !selectedIds.has(id));
    assert.deepEqual(unknown, [], `unknown or filtered journey IDs: ${unknown.join(", ")}`);
  }

  const evidenceByTarget = new Map();
  for (const journey of selectedJourneys) {
    for (const item of journey.evidence) {
      const classified = classifyEvidence(item.target);
      if (layers.size && !layers.has(classified.layer)) continue;
      const current = evidenceByTarget.get(classified.target) || { ...classified, labels: new Set(), journeys: new Set() };
      current.labels.add(item.label);
      current.journeys.add(journey.id);
      evidenceByTarget.set(classified.target, current);
    }
  }

  const evidenceItems = [...evidenceByTarget.values()].map(item => ({
    ...item,
    labels: [...item.labels].sort(),
    journeys: [...item.journeys].sort(),
  }));
  const unknown = evidenceItems.filter(item => item.mode === "unknown");
  assert.deepEqual(unknown.map(item => item.target), [], "behavior evidence has no execution adapter");

  const groups = new Map();
  for (const item of evidenceItems) {
    if (item.mode !== "automated" && !(filters.includeExplicit && item.mode === "explicit")) continue;
    const group = groups.get(item.groupKey) || {
      key: item.groupKey,
      mode: item.mode,
      layer: item.layer,
      targets: new Set(),
      journeys: new Set(),
    };
    group.targets.add(item.target);
    item.journeys.forEach(id => group.journeys.add(id));
    groups.set(item.groupKey, group);
  }

  const commands = [...groups.values()]
    .map(group => commandForGroup({
      ...group,
      targets: [...group.targets].sort(),
      journeys: [...group.journeys].sort(),
    }))
    .sort((left, right) => commandOrder(left) - commandOrder(right) || left.key.localeCompare(right.key));

  return { selectedJourneys, evidenceItems, commands };
}

export function commandForGroup(group) {
  const paths = group.targets.map(target => `tests/${target}`);
  const common = { ...group, cwd: PROJECT_ROOT };
  if (group.key === "unit") {
    return command(common, "node", [
      "--test",
      `--test-concurrency=${clampNumber(process.env.QINGZHOU_TEST_CONCURRENCY, 1, 16, 4)}`,
      "--test-reporter=spec",
      "--require=./tests/support/unit-bootstrap.cjs",
      ...paths,
    ]);
  }
  if (group.key === "browser") {
    return command(common, "node", [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "tests/config/playwright.config.mjs",
      ...paths,
    ], {
      QINGZHOU_PLAYWRIGHT_WORKERS: String(clampNumber(
        process.env.QINGZHOU_BEHAVIOR_PLAYWRIGHT_WORKERS,
        1,
        4,
        1,
      )),
    });
  }
  if (group.key === "service:mcp") {
    return command(common, "uv", [
      "run", "--project", "tests/python",
      "--default-index", "https://pypi.org/simple",
      "--locked", "pytest",
      "-q", "--durations=5", ...paths,
    ]);
  }
  if (group.key === "service:node-mcp") return command(common, "node", ["--test", ...paths]);
  const exact = {
    "e2e:image-conversion": ["node", ["tests/background/image-conversion-e2e.mjs"]],
    "e2e:extension": ["node", ["tests/background/extension-e2e.mjs"]],
    "e2e:mcp-tab-ownership": ["node", ["tests/background/mcp-tab-ownership-e2e.mjs"]],
    "e2e:data-grid-extension": ["node", ["tests/data-grid/extension-page.mjs"]],
    "browser:data-grid": ["node", ["tests/data-grid/browser-matrix.mjs"]],
    "release:bundle": ["node", ["--test", "--test-reporter=spec", "tests/release/bundle-release.test.mjs"]],
    "release:chrome": ["node", ["tests/release/chrome-smoke.mjs"]],
    "benchmark:conversation": ["node", ["tests/benchmarks/conversation-render/run.mjs", "--mode", "all", "--json", "--fail-on-health"]],
    "visual:conversation": ["node", ["tests/benchmarks/conversation-render/run-visual-audit-matrix.mjs", "--profiles", "sidepanel-light", "--json"]],
    "benchmark:data-grid": ["node", ["tests/benchmarks/data-grid-large-runner.mjs"]],
    "benchmark:message-stream": ["node", [
      "tests/support/run-python-browser.mjs",
      "tests/benchmarks/message-stream.py",
      "--fail-on-budget",
    ]],
    "agent:model-regression": ["node", ["tests/background/agent-behavior-e2e.mjs", "--suite", "all"]],
    "probe:notification-return": ["node", ["tests/behavior/probes/notification-return.mjs"]],
    "live:page-batch": ["node", ["tests/live/deepseek-extension.mjs"], { QINGZHOU_LIVE_CASES: "pageBatch" }],
    "live:ax-viewport": ["node", ["tests/live/ax-viewport.mjs"]],
    "live:ax-viewport-public": ["node", ["tests/live/ax-viewport-public.mjs"]],
  };
  if (group.key.startsWith("e2e:python:")) {
    return command(common, "node", ["tests/support/run-python-browser.mjs", paths[0]]);
  }
  const pair = exact[group.key];
  assert.ok(pair, `no command for evidence group ${group.key}`);
  return command(common, pair[0], pair[1], pair[2]);
}

export function detectSkippedCommandOutput(...values) {
  const output = values.map(value => String(value || "")).join("\n");
  return /"stage"\s*:\s*"skipped"/u.test(output)
    || /^.*\be2e skipped:\s*.+$/imu.test(output);
}

export function summarizeCoverage(journeys) {
  const summary = { total: journeys.length, 强: 0, 中: 0, 弱: 0, 缺: 0 };
  journeys.forEach(journey => { summary[journey.coverage] += 1; });
  return summary;
}

function readField(body, field) {
  const values = [...body.matchAll(new RegExp(`^- \\*\\*(?:${field}|${FIELD_LABELS[field]})\\*\\*[:：](.*)$`, "gmu"))];
  assert.ok(values.length <= 1, `duplicate behavior field: ${FIELD_LABELS[field]}`);
  return values[0]?.[1]?.trim() || "";
}

function normalizeCoverage(value) {
  const normalized = String(value || "").trim();
  return COVERAGE_LABELS[normalized.toLowerCase()] || normalized;
}

function parseEvidence(value) {
  return [...String(value || "").matchAll(/\[([^\]]+)\]\(([^)#]+)(?:#[^)]+)?\)/gu)].map(match => ({
    label: match[1].trim(),
    target: normalizeEvidenceTarget(match[2]),
  }));
}

function normalizeEvidenceTarget(value) {
  return String(value || "").trim().replace(/^\.\//u, "").replaceAll("\\", "/");
}

function evidence(target, mode, layer, groupKey) {
  return { target, mode, layer, groupKey };
}

function command(group, bin, args, env = {}) {
  const environment = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return { ...group, bin, args, env, label: [...environment, bin, ...args].join(" ") };
}

function commandOrder(commandItem) {
  return ["unit", "service", "browser", "e2e", "benchmark", "visual", "release", "agent"].indexOf(commandItem.layer);
}

function splitFilter(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => String(item || "").split(",")).map(item => item.trim()).filter(Boolean);
}

function normalizeActor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return { h: "Human", human: "Human", a: "Agent", agent: "Agent", s: "System", system: "System" }[normalized] || value;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function relativeIndexPath(path = BEHAVIOR_INDEX_PATH) {
  return relative(PROJECT_ROOT, path);
}
