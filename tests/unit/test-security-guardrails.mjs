import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { transformSync } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { navigationDocuments } from "../support/navigation-documents.mjs";
import { createSessionRuntimeState } from "../../src/background/session/runtime-state.js";
import { createSessionState } from "../../src/sidepanel/features/sessions/session-state.js";
import {
  addSecurityGuardrailDomain,
  addSecurityGuardrailPattern,
  addSecurityGuardrailRule,
  annotateSecurityGuardrailTab,
  annotateSecurityGuardrailTabs,
  buildSecurityGuardrailPromptSection,
  filterAllowedTabs,
  getSecurityGuardrails,
  matchBlockedUrl,
  matchSecurityGuardrailUrl,
  matchSiteOpenRateLimitUrl,
  normalizeGuardrailDomainInput,
  normalizeGuardrailPatternInput,
  normalizeGuardrailRuleInput,
  normalizeSecurityGuardrails,
  normalizeSiteOpenRateLimitInput,
  reorderSecurityGuardrailRules,
  removeSecurityGuardrailDomain,
  removeSecurityGuardrailPattern,
  saveSecurityGuardrails,
  SECURITY_GUARDRAILS_KEY,
} from "../../src/shared/security-guardrails.js";
import {
  createSiteOpenRateLimitScheduler,
  resetSiteOpenRateLimitSchedulerForTests,
} from "../../src/background/security-guardrails-runtime.js";

const storageData = {};
let mockTabs = [];
let createdTabs = [];
let sentContentMessages = [];
let sentDebuggerCommands = [];
let contentMessageHandler = null;
let debuggerCommandHandler = null;
let toolsModulePromise = null;
const root = fileURLToPath(new URL("../..", import.meta.url));
const navigation = navigationDocuments();

globalThis.chrome = {
  // Ordering and copy assertions in this file are written for the Chinese UI.
  // Pin it here so a non-Chinese process locale cannot turn missing text into a false order failure.
  i18n: { getUILanguage: () => "zh-CN" },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
    },
  },
  tabs: {
    onUpdated: { addListener() {}, removeListener() {} },
    async query(query = {}) {
      let tabs = [...mockTabs];
      if (query.currentWindow) tabs = tabs.filter(tab => tab.currentWindow !== false);
      if (query.active) tabs = tabs.filter(tab => tab.active);
      return tabs.map(tab => ({ ...tab }));
    },
    async get(tabId) {
      const tab = mockTabs.find(item => Number(item.id) === Number(tabId));
      if (!tab) throw new Error(`No tab ${tabId}`);
      return { ...tab };
    },
    async create(props = {}) {
      const tab = {
        id: 900 + createdTabs.length,
        windowId: props.windowId || 1,
        title: "",
        url: props.url || "",
        pendingUrl: props.url || "",
        active: !!props.active,
        pinned: false,
      };
      createdTabs.push(tab);
      mockTabs.push(tab);
      return { ...tab };
    },
    async update(tabId, props = {}) {
      const tab = mockTabs.find(item => Number(item.id) === Number(tabId));
      if (!tab) throw new Error(`No tab ${tabId}`);
      Object.assign(tab, props);
      if (props.url) { delete tab.pendingUrl; navigation.commit(tabId); }
      return { ...tab };
    },
    async remove(tabId) {
      mockTabs = mockTabs.filter(item => Number(item.id) !== Number(tabId));
    },
    async sendMessage(tabId, message) {
      sentContentMessages.push({ tabId, message });
      if (typeof contentMessageHandler === "function") {
        const response = await contentMessageHandler(tabId, message);
        if (response !== undefined) return response;
      }
      return { ok: true };
    },
  },
  scripting: {
    async executeScript(details = {}) {
      return details.injectImmediately ? navigation.result(details.target.tabId) : [];
    },
  },
  runtime: {
    onMessage: { addListener() {} },
    sendMessage() {},
  },
  debugger: {
    async attach() {},
    async detach() {},
    async sendCommand(target, method, params = {}) {
      sentDebuggerCommands.push({ tabId: Number(target?.tabId), method, params });
      if (typeof debuggerCommandHandler === "function") {
        const response = await debuggerCommandHandler(target, method, params);
        if (response !== undefined) return response;
      }
      return {};
    },
  },
  bookmarks: {},
  history: {},
  downloads: {},
  windows: {
    async update() {},
  },
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function resetStorage() {
  for (const key of Object.keys(storageData)) delete storageData[key];
}

function resetChromeMocks() {
  mockTabs = [];
  createdTabs = [];
  sentContentMessages = [];
  sentDebuggerCommands = [];
  contentMessageHandler = null;
  debuggerCommandHandler = null;
}

async function assertRejectsWithCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code);
    return true;
  });
}

async function importToolsForGuardrailTests() {
  if (toolsModulePromise) return toolsModulePromise;
  const shouldSuppressPdfWarning = (args) => {
    const text = args.map(item => String(item)).join(" ");
    return /Cannot load "@napi-rs\/canvas"|Cannot polyfill `(DOMMatrix|ImageData|Path2D)`/.test(text);
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => {
    if (shouldSuppressPdfWarning(args)) return;
    originalLog(...args);
  };
  console.warn = (...args) => {
    if (shouldSuppressPdfWarning(args)) return;
    originalWarn(...args);
  };
  try {
    toolsModulePromise = import("../../src/background/tools/runtime.js");
    return await toolsModulePromise;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function installSessionTabResolver(toolsModule, { sessionId = "guardrail-session" } = {}) {
  let runCurrent = true;
  const sessions = {
    isRunCurrent(requestedSessionId, runId) {
      return runCurrent && requestedSessionId === sessionId && Boolean(String(runId || "").trim());
    },
    async resolveTargetTab({ sessionId: requestedSessionId, tabId }) {
      if (requestedSessionId !== sessionId) {
        return {
          ok: false,
          code: "SESSION_TAB_FOREIGN",
          reason: "test_session_mismatch",
          ownerSessionId: sessionId,
          tabId: Number(tabId),
        };
      }
      const tab = await chrome.tabs.get(Number(tabId));
      return { ok: true, code: "OK", tabId: Number(tabId), tab };
    },
    async updateWorkingTab({ sessionId: requestedSessionId, tab }) {
      assert.ok(String(requestedSessionId || "").trim());
      assert.ok(Number(tab?.id) > 0);
    },
  };
  return {
    context: { sessionId },
    setRunCurrent(value) { runCurrent = value === true; },
    createRuntime(options = {}) {
      return toolsModule.createToolRuntime({
        sessions,
        windowTarget: { async resolveForNewTab() { return 1; } },
        ...options,
      });
    },
  };
}

function createOpenTabRuntime(toolsModule, options = {}) {
  return toolsModule.createToolRuntime({
    sessions: {
      async updateWorkingTab({ sessionId, tab }) {
        assert.ok(String(sessionId || "").trim());
        assert.ok(Number(tab?.id) > 0);
      },
    },
    windowTarget: { async resolveForNewTab() { return 1; } },
    ...options,
  });
}

function setMockTabUrl(tabId, url, title = "") {
  const tab = mockTabs.find(item => Number(item.id) === Number(tabId));
  if (!tab) throw new Error(`No tab ${tabId}`);
  tab.url = url;
  tab.pendingUrl = "";
  if (title) tab.title = title;
}

function installClickableElementMock({
  href = "",
  afterUrl = "",
  clickable = true,
  element = {},
} = {}) {
  let activeHref = href;
  let hrefReady = false;
  // Layout warmup inspects the element again. One click still navigates to one href.
  const resolveHref = () => {
    if (hrefReady) return activeHref;
    activeHref = typeof href === "function" ? href() : href;
    hrefReady = true;
    return activeHref;
  };
  contentMessageHandler = async (_tabId, message) => {
    if (message?.action === "inspectElement") {
      const currentHref = resolveHref();
      return {
        selector: message.selector,
        index: message.index || 0,
        visible: true,
        disabled: false,
        state: { inViewport: true, clickablePointInViewport: true, obscuredAtCenter: false },
        clickablePoint: clickable ? { x: 12, y: 34 } : null,
        href: currentHref || undefined,
        ...element,
      };
    }
    return undefined;
  };
  debuggerCommandHandler = async (target, method, params = {}) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      const currentHref = resolveHref();
      hrefReady = false;
      const nextUrl = typeof afterUrl === "function" ? afterUrl(currentHref) : afterUrl;
      if (nextUrl) setMockTabUrl(target.tabId, nextUrl);
    }
    return {};
  };
}

test("normalizes domains and URLs into host rules", () => {
  assert.deepEqual(normalizeGuardrailDomainInput("https://Sub.Example.com/path?q=1"), {
    domain: "sub.example.com",
    error: "",
  });
  assert.deepEqual(normalizeGuardrailDomainInput("*.Example.com"), {
    domain: "example.com",
    error: "",
  });
  assert.deepEqual(normalizeGuardrailDomainInput("@example.com"), {
    domain: "example.com",
    error: "",
  });
});

test("rejects malformed domain values", () => {
  assert.equal(Boolean(normalizeGuardrailDomainInput("").error), true);
  assert.equal(Boolean(normalizeGuardrailDomainInput("exa mple.com").error), true);
  assert.equal(Boolean(normalizeGuardrailDomainInput("https://foo_bar.com").error), true);
  assert.equal(Boolean(normalizeGuardrailDomainInput("https://bad..example.com").error), true);
});

test("normalizes URL patterns with safe wildcard syntax", () => {
  assert.deepEqual(normalizeGuardrailPatternInput("Example.com/private/*"), {
    pattern: "*://example.com/private/*",
    error: "",
  });
  assert.deepEqual(normalizeGuardrailPatternInput("HTTPS://*.Example.com/path/*"), {
    pattern: "https://*.example.com/path/*",
    error: "",
  });
  assert.deepEqual(normalizeGuardrailPatternInput("http://Example.com"), {
    pattern: "http://example.com/*",
    error: "",
  });
  assert.equal(Boolean(normalizeGuardrailPatternInput("https://exa mple.com/*").error), true);
  assert.equal(Boolean(normalizeGuardrailPatternInput("ftp://example.com/*").error), true);
  assert.equal(Boolean(normalizeGuardrailPatternInput("https://example..com/*").error), true);
  assert.equal(Boolean(normalizeGuardrailPatternInput("https://example.com/a\nb").error), true);
  assert.equal(Boolean(normalizeGuardrailPatternInput("a".repeat(2050)).error), true);
  assert.equal(Boolean(normalizeGuardrailPatternInput("a".repeat(2043)).error), true);
  const boundary = normalizeGuardrailPatternInput("a".repeat(2042));
  assert.equal(boundary.error, "");
  assert.equal(boundary.pattern.length, 2048);
  assert.deepEqual(normalizeGuardrailPatternInput(boundary.pattern), boundary);
});

test("rejects adversarial wildcard hosts within a bounded process", () => {
  const result = spawnSync(process.execPath, [
    "--import", "./tests/support/typescript-loader.mjs", "--input-type=module", "-e",
    `import assert from 'node:assert/strict';
     import { normalizeGuardrailPatternInput, matchBlockedUrl } from './src/shared/security-guardrails.js';
     for (const suffix of ['!', ':', '@', '_']) {
       assert.ok(normalizeGuardrailPatternInput('https://' + '*.'.repeat(900) + suffix + '/*').error);
     }
     assert.equal(matchBlockedUrl('https://example.com/' + 'a'.repeat(1000) + 'c', {
       blockedPatterns: [{ pattern: 'https://example.com/' + '*a'.repeat(500) + 'b' }],
     }), null);`,
  ], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("normalizes rule inputs with defaults and stable ids", () => {
  const domain = normalizeGuardrailRuleInput("Example.com/path");
  assert.equal(domain.error, "");
  assert.equal(domain.rule.action, "block");
  assert.equal(domain.rule.type, "domain");
  assert.equal(domain.rule.value, "example.com");
  assert.match(domain.rule.id, /^guard_block_domain_/);

  const pattern = normalizeGuardrailRuleInput({
    action: "allow",
    pattern: "Example.com/public/*",
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(pattern.error, "");
  assert.equal(pattern.rule.action, "allow");
  assert.equal(pattern.rule.type, "pattern");
  assert.equal(pattern.rule.value, "*://example.com/public/*");
  assert.equal(pattern.rule.createdAt, "2026-01-02T03:04:05.000Z");

  const fallback = normalizeGuardrailRuleInput({ action: "unknown", type: "unknown", value: "Example.org" });
  assert.equal(fallback.rule.action, "block");
  assert.equal(fallback.rule.type, "domain");
  assert.equal(fallback.rule.value, "example.org");
});

test("normalizes mixed legacy and ordered rule storage", () => {
  const normalized = normalizeSecurityGuardrails({
    rules: [
      { id: "allow-public", action: "allow", type: "pattern", value: "Example.com/public/*", createdAt: "t1" },
      { action: "block", type: "domain", value: "bad host" },
    ],
    blockedDomains: ["Example.com", "*.Example.com", { host: "Internal.test" }],
    blockedPatterns: ["Example.com/private/*", "Example.com/private/*", { value: "https://*.Internal.test/*" }],
  });

  assert.deepEqual(normalized.rules.map(rule => `${rule.action}:${rule.type}:${rule.value}`), [
    "allow:pattern:*://example.com/public/*",
    "block:domain:example.com",
    "block:domain:internal.test",
    "block:pattern:*://example.com/private/*",
    "block:pattern:https://*.internal.test/*",
  ]);
  assert.deepEqual(normalized.blockedDomains.map(item => item.domain), ["example.com", "internal.test"]);
  assert.deepEqual(normalized.allowedPatterns.map(item => item.pattern), ["*://example.com/public/*"]);
});

test("normalizes site open rate limits with shared domain and pattern targets", () => {
  const domain = normalizeSiteOpenRateLimitInput({
    host: "https://Example.com/a",
    minOpenIntervalMs: "3000",
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(domain.error, "");
  assert.equal(domain.rateLimit.type, "domain");
  assert.equal(domain.rateLimit.value, "example.com");
  assert.equal(domain.rateLimit.minOpenIntervalMs, 3000);
  assert.match(domain.rateLimit.id, /^guard_open_rate_domain_/);

  const pattern = normalizeSiteOpenRateLimitInput({
    type: "pattern",
    value: "HTTPS://*.Example.com/private/*",
    minIntervalMs: 7000,
  });
  assert.equal(pattern.error, "");
  assert.equal(pattern.rateLimit.value, "https://*.example.com/private/*");

  assert.equal(Boolean(normalizeSiteOpenRateLimitInput({ host: "bad host", minOpenIntervalMs: 1000 }).error), true);
  assert.equal(Boolean(normalizeSiteOpenRateLimitInput({ host: "example.com", minOpenIntervalMs: 0 }).error), true);
});

test("normalizes unified security guardrail order across access and rate-limit rules", () => {
  const normalized = normalizeSecurityGuardrails({
    rules: [
      { id: "block-a", action: "block", type: "domain", value: "a.example.com" },
      { id: "allow-b", action: "allow", type: "domain", value: "b.example.com" },
    ],
    siteOpenRateLimits: [
      { id: "rate-c", host: "c.example.com", minOpenIntervalMs: 3000 },
    ],
    order: ["rate-c", "allow-b", "block-a"],
  });
  assert.deepEqual(normalized.order, ["rate-c", "allow-b", "block-a"]);
  assert.deepEqual(normalized.rules.map(rule => rule.id), ["allow-b", "block-a"]);
  assert.deepEqual(normalized.siteOpenRateLimits.map(item => item.id), ["rate-c"]);

  const section = buildSecurityGuardrailPromptSection(normalized);
  assert.ok(section.indexOf("流控 / 域名: c.example.com") < section.indexOf("允许访问 / 域名: b.example.com"));
  assert.ok(section.indexOf("允许访问 / 域名: b.example.com") < section.indexOf("禁止访问 / 域名: a.example.com"));
});

test("matches site open rate limits using first matching ordered target semantics", () => {
  const guardrails = normalizeSecurityGuardrails({
    siteOpenRateLimits: [
      { host: "example.com", minOpenIntervalMs: 3000 },
      { type: "pattern", value: "*://*.example.com/private/*", minOpenIntervalMs: 7000 },
      { host: "disabled.example.com", minOpenIntervalMs: 9000, enabled: false },
      { host: "example.com", minOpenIntervalMs: 1000 },
    ],
  });
  assert.deepEqual(guardrails.siteOpenRateLimits.map(item => `${item.type}:${item.value}:${item.minOpenIntervalMs}`), [
    "domain:example.com:3000",
    "pattern:*://*.example.com/private/*:7000",
    "domain:disabled.example.com:9000",
  ]);

  const publicMatch = matchSiteOpenRateLimitUrl("https://a.example.com/public/a", guardrails);
  assert.equal(publicMatch.domain, "example.com");
  assert.equal(publicMatch.minOpenIntervalMs, 3000);

  const privateMatch = matchSiteOpenRateLimitUrl("https://a.example.com/private/a", guardrails);
  assert.equal(privateMatch.domain, "example.com");
  assert.equal(privateMatch.minOpenIntervalMs, 3000);

  const patternFirst = normalizeSecurityGuardrails({
    siteOpenRateLimits: guardrails.siteOpenRateLimits,
    order: [guardrails.siteOpenRateLimits[1].id, guardrails.siteOpenRateLimits[0].id],
  });
  const privatePatternMatch = matchSiteOpenRateLimitUrl("https://a.example.com/private/a", patternFirst);
  assert.equal(privatePatternMatch.pattern, "*://*.example.com/private/*");
  assert.equal(privatePatternMatch.minOpenIntervalMs, 7000);

  assert.equal(matchSiteOpenRateLimitUrl("https://disabled.example.com/a", guardrails)?.domain, "example.com");
  assert.equal(matchSiteOpenRateLimitUrl("chrome://extensions", guardrails), null);
  assert.equal(matchSiteOpenRateLimitUrl("not a url", guardrails), null);
});

test("site open rate limits are included in the security guardrail prompt", () => {
  const section = buildSecurityGuardrailPromptSection({
    siteOpenRateLimits: [
      { host: "Example.com", minOpenIntervalMs: 3000 },
    ],
  });
  assert.match(section, /用户配置的安全护栏/);
  assert.match(section, /流控 \/ 域名: example\.com/);
  assert.match(section, /最小间隔 3 秒/);
});

test("matches exact host and subdomains only", () => {
  const guardrails = { blockedDomains: [{ domain: "example.com" }] };
  assert.equal(matchBlockedUrl("https://example.com/a", guardrails)?.domain, "example.com");
  assert.equal(matchBlockedUrl("https://a.b.example.com/a", guardrails)?.domain, "example.com");
  assert.equal(matchBlockedUrl("https://badexample.com/a", guardrails), null);
  assert.equal(matchBlockedUrl("chrome://extensions", guardrails), null);
  assert.equal(matchBlockedUrl("not a url", guardrails), null);
});

test("matches URL patterns against normalized full URLs", () => {
  const guardrails = { blockedPatterns: [{ pattern: "*://*.example.com/private/*" }] };
  assert.equal(matchBlockedUrl("https://a.example.com/private/page?q=1", guardrails)?.pattern, "*://*.example.com/private/*");
  assert.equal(matchBlockedUrl("http://b.example.com/private/page", guardrails)?.type, "pattern");
  assert.equal(matchBlockedUrl("https://example.com/private/page", guardrails), null);
  assert.equal(matchBlockedUrl("https://a.example.com/public/page", guardrails), null);
});

test("URL wildcards stay within the protocol and authority boundaries", () => {
  const rules = [
    { action: "allow", type: "pattern", value: "*://*.example.com/public/*" },
    { action: "block", type: "domain", value: "evil.test" },
  ];
  assert.equal(matchSecurityGuardrailUrl("https://a.example.com/public/x", { rules })?.allowed, true);
  for (const url of [
    "https://evil.test/.example.com/public/x",
    "https://evil.test/?next=https://a.example.com/public/x",
    "https://evil.test/#https://a.example.com/public/x",
    "https://a.example.com@evil.test/public/x",
  ]) {
    assert.equal(matchSecurityGuardrailUrl(url, { rules })?.blocked, true, url);
    assert.equal(matchSiteOpenRateLimitUrl(url, {
      siteOpenRateLimits: [{ type: "pattern", value: rules[0].value, minOpenIntervalMs: 1000 }],
    }), null);
  }
});

test("path wildcards preserve literal punctuation, anchors and ordered segments", () => {
  const matches = (pattern, path) => Boolean(matchBlockedUrl(`https://example.com${path}`, {
    blockedPatterns: [{ pattern: `https://example.com${pattern}` }],
  }));
  assert.equal(matches("/a+b.$?q=[x]#end", "/a+b.$?q=[x]#end"), true);
  assert.equal(matches("/a+b.$?q=[x]#end", "/aaabX?q=x#end"), false);
  assert.equal(matches("/start**middle*end", "/start/a/middle/b/end"), true);
  assert.equal(matches("/start*middle*end", "/start/end/middle"), false);
  assert.equal(matches("/abc*bc", "/abc"), false);
  assert.equal(matches("/abc*bc", "/abcbc"), true);
  assert.equal(matches("/exact", "/exact/extra"), false);
  assert.equal(matchBlockedUrl("http://example.com/a", { blockedPatterns: [{ pattern: "https://example.com/*" }] }), null);
  assert.ok(matchBlockedUrl("http://localhost:8080/a", { blockedPatterns: [{ pattern: "*://*/*" }] }));
});

test("applies configured access rule order", () => {
  const allowDomainFirst = {
    rules: [
      { action: "allow", type: "domain", value: "example.com" },
      { action: "block", type: "pattern", value: "*://*.example.com/private/*" },
    ],
  };
  assert.equal(matchSecurityGuardrailUrl("https://a.example.com/private/a", allowDomainFirst)?.allowed, true);

  const blockPatternFirst = {
    rules: [
      { action: "block", type: "pattern", value: "*://*.example.com/private/*" },
      { action: "allow", type: "domain", value: "example.com" },
    ],
  };
  assert.equal(matchBlockedUrl("https://a.example.com/private/a", blockPatternFirst)?.blocked, true);

  const laterAllowDomainDoesNotOverrideEarlierBlockDomain = {
    rules: [
      { action: "block", type: "domain", value: "example.com" },
      { action: "allow", type: "domain", value: "a.example.com" },
    ],
  };
  assert.equal(matchBlockedUrl("https://a.example.com/public/a", laterAllowDomainDoesNotOverrideEarlierBlockDomain)?.domain, "example.com");
  const blockedDomainFirst = {
    rules: [
      { action: "block", type: "domain", value: "example.com" },
      { action: "allow", type: "pattern", value: "*://*.example.com/public/*" },
    ],
  };
  assert.equal(matchBlockedUrl("https://a.example.com/public/page", blockedDomainFirst)?.blocked, true);

  const allowPatternFirst = {
    rules: [
      { action: "allow", type: "pattern", value: "*://*.example.com/public/*" },
      { action: "block", type: "domain", value: "example.com" },
    ],
  };
  assert.equal(matchSecurityGuardrailUrl("https://a.example.com/public/page", allowPatternFirst)?.allowed, true);
  assert.equal(matchBlockedUrl("https://a.example.com/public/page", allowPatternFirst), null);
  assert.equal(matchBlockedUrl("https://a.example.com/private/page", allowPatternFirst)?.blocked, true);
});

test("pattern rules keep their own configured order", () => {
  const guardrails = {
    rules: [
      { action: "block", type: "pattern", value: "*://*.example.com/public/admin/*" },
      { action: "allow", type: "pattern", value: "*://*.example.com/public/*" },
      { action: "block", type: "domain", value: "example.com" },
    ],
  };
  assert.equal(matchBlockedUrl("https://a.example.com/public/admin/a", guardrails)?.pattern, "*://*.example.com/public/admin/*");
  assert.equal(matchSecurityGuardrailUrl("https://a.example.com/public/page", guardrails)?.allowed, true);
  assert.equal(matchBlockedUrl("https://a.example.com/private/page", guardrails)?.domain, "example.com");
});

test("filters tabs whose current or pending URL is blocked", () => {
  const guardrails = {
    blockedDomains: [{ domain: "example.com" }],
    blockedPatterns: [{ pattern: "*://internal.test/private/*" }],
  };
  const tabs = filterAllowedTabs([
    { id: 1, url: "https://example.com/private" },
    { id: 2, url: "https://news.example.org" },
    { id: 3, pendingUrl: "https://sub.example.com/loading" },
    { id: 4, url: "https://internal.test/private/a" },
    { id: 5, url: "about:blank", pendingUrl: "https://sub.example.com/loading" },
  ], guardrails);

  assert.deepEqual(tabs.map(tab => tab.id), [2]);
});

test("annotates blocked tab metadata without hiding it", () => {
  const guardrails = {
    rules: [
      { action: "allow", type: "pattern", value: "*://example.com/public/*" },
      { action: "block", type: "domain", value: "example.com" },
    ],
  };
  const tab = annotateSecurityGuardrailTab({
    id: 1,
    title: "Private page",
    url: "https://example.com/private",
    active: true,
  }, guardrails);
  assert.equal(tab.id, 1);
  assert.equal(tab.title, "Private page");
  assert.equal(tab.url, "https://example.com/private");
  assert.equal(tab.securityGuardrailBlocked, true);
  assert.equal(tab.contentAccess, "blocked");
  assert.equal(tab.securityGuardrail.type, "domain");

  const allowedTab = annotateSecurityGuardrailTab({
    id: 3,
    title: "Public page",
    pendingUrl: "https://example.com/public/a",
  }, guardrails);
  assert.equal(allowedTab.securityGuardrailBlocked, undefined);
  assert.equal(allowedTab.pendingUrl, "https://example.com/public/a");

  const nonHttpTab = annotateSecurityGuardrailTab({
    id: 4,
    title: "Extensions",
    url: "chrome://extensions",
  }, guardrails);
  assert.equal(nonHttpTab.securityGuardrailBlocked, undefined);

  const tabs = annotateSecurityGuardrailTabs([
    tab,
    { id: 2, title: "News", url: "https://news.example.org" },
  ], guardrails);
  assert.deepEqual(tabs.map(item => item.id), [1, 2]);
  assert.equal(tabs[1].securityGuardrailBlocked, undefined);
});

test("saveSecurityGuardrails persists normalized ordered rules and derived views", async () => {
  resetStorage();
  const saved = await saveSecurityGuardrails({
    rules: [
      { action: "allow", type: "domain", value: "Allowed.Example.com" },
      { action: "block", type: "pattern", value: "Example.com/private/*" },
      { action: "block", type: "pattern", value: "bad pattern with space" },
    ],
    blockedDomains: ["Example.com"],
  });

  assert.deepEqual(saved.rules.map(rule => `${rule.action}:${rule.type}:${rule.value}`), [
    "allow:domain:allowed.example.com",
    "block:pattern:*://example.com/private/*",
    "block:domain:example.com",
  ]);
  assert.deepEqual(storageData[SECURITY_GUARDRAILS_KEY].allowedDomains.map(item => item.domain), ["allowed.example.com"]);
  assert.deepEqual(storageData[SECURITY_GUARDRAILS_KEY].blockedPatterns.map(item => item.pattern), ["*://example.com/private/*"]);
});

test("adds, dedupes, reads, and removes guardrail domains and patterns from storage", async () => {
  resetStorage();

  const first = await addSecurityGuardrailDomain("https://Example.com/a");
  assert.equal(first.ok, true);
  assert.equal(first.existed, false);
  assert.equal(first.domain, "example.com");

  const duplicate = await addSecurityGuardrailDomain("*.example.com");
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.existed, true);
  assert.equal(duplicate.guardrails.blockedDomains.length, 1);

  const pattern = await addSecurityGuardrailPattern("example.org/private/*");
  assert.equal(pattern.ok, true);
  assert.equal(pattern.pattern, "*://example.org/private/*");

  const stored = await getSecurityGuardrails();
  assert.deepEqual(stored.blockedDomains.map(item => item.domain), ["example.com"]);
  assert.deepEqual(stored.blockedPatterns.map(item => item.pattern), ["*://example.org/private/*"]);
  assert.equal(storageData[SECURITY_GUARDRAILS_KEY].blockedDomains.length, 1);
  assert.equal(storageData[SECURITY_GUARDRAILS_KEY].blockedPatterns.length, 1);

  const removed = await removeSecurityGuardrailDomain("example.com");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.guardrails.blockedDomains, []);
  assert.equal(removed.guardrails.blockedPatterns.length, 1);

  const removedPattern = await removeSecurityGuardrailPattern("*://example.org/private/*");
  assert.equal(removedPattern.ok, true);
  assert.deepEqual(removedPattern.guardrails.blockedPatterns, []);
});

test("rule helpers preserve configured site open rate limits", async () => {
  resetStorage();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { host: "news.example.org", minOpenIntervalMs: 3000 },
    ],
  });

  const added = await addSecurityGuardrailDomain("example.com");
  assert.equal(added.guardrails.siteOpenRateLimits[0].value, "news.example.org");

  const pattern = await addSecurityGuardrailPattern("example.com/private/*");
  const reordered = await reorderSecurityGuardrailRules([pattern.rule.id, added.rule.id]);
  assert.equal(reordered.guardrails.siteOpenRateLimits[0].minOpenIntervalMs, 3000);

  const removed = await removeSecurityGuardrailDomain("example.com");
  assert.equal(removed.guardrails.siteOpenRateLimits[0].value, "news.example.org");
});

test("rejects invalid add requests without mutating storage", async () => {
  resetStorage();
  await addSecurityGuardrailDomain("example.com");
  const before = JSON.stringify(storageData[SECURITY_GUARDRAILS_KEY]);
  const result = await addSecurityGuardrailRule({ action: "block", type: "pattern", value: "bad pattern with space" });

  assert.equal(result.ok, false);
  assert.equal(Boolean(result.error), true);
  assert.equal(JSON.stringify(storageData[SECURITY_GUARDRAILS_KEY]), before);
});

test("legacy remove helpers only remove matching blocked rules", async () => {
  resetStorage();
  const allow = await addSecurityGuardrailRule({ action: "allow", type: "domain", value: "example.com" });
  const block = await addSecurityGuardrailRule({ action: "block", type: "domain", value: "example.com" });
  assert.notEqual(allow.rule.id, block.rule.id);

  const removed = await removeSecurityGuardrailDomain("example.com");
  assert.deepEqual(removed.guardrails.rules.map(rule => `${rule.action}:${rule.type}:${rule.value}`), [
    "allow:domain:example.com",
  ]);
});

test("adds allow rules and reorders rules by id", async () => {
  resetStorage();
  const block = await addSecurityGuardrailRule({ action: "block", type: "domain", value: "example.com" });
  const allow = await addSecurityGuardrailRule({ action: "allow", type: "pattern", value: "*.example.com/public/*" });
  assert.equal(block.rule.action, "block");
  assert.equal(allow.rule.action, "allow");
  assert.equal(allow.rule.type, "pattern");

  const reordered = await reorderSecurityGuardrailRules([allow.rule.id, block.rule.id]);
  assert.deepEqual(reordered.guardrails.rules.map(rule => rule.id), [allow.rule.id, block.rule.id]);

  const withUnknownId = await reorderSecurityGuardrailRules(["missing", block.rule.id]);
  assert.deepEqual(withUnknownId.guardrails.rules.map(rule => rule.id), [block.rule.id, allow.rule.id]);
});

test("site open rate limiter fairly rotates sessions for the same host", async () => {
  let now = 0;
  const waits = [];
  const grants = [];
  const updates = [];
  const scheduler = createSiteOpenRateLimitScheduler({
    now: () => now,
    random: () => 0.5,
    delay: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  const acquire = (sessionId, label) => scheduler.acquire({
    host: "example.com",
    minOpenIntervalMs: 1000,
    sessionId,
    emitUpdate: update => updates.push({ label, ...update }),
  }).then(() => {
    grants.push(label);
  });

  await Promise.all([
    acquire("session-a", "a1"),
    acquire("session-a", "a2"),
    acquire("session-b", "b1"),
    acquire("session-c", "c1"),
  ]);

  assert.deepEqual(grants, ["a1", "b1", "c1", "a2"]);
  assert.deepEqual(waits, [1000, 1000, 1000]);
  assert.equal(updates.some(item => item.statusText === "流控等待中" && item.host === "example.com"), true);
});

test("site open rate limiter removes queued requests on abort without consuming a slot", async () => {
  let now = 0;
  const grants = [];
  const waits = [];
  const scheduler = createSiteOpenRateLimitScheduler({
    now: () => now,
    random: () => 0.5,
    delay: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  const controller = new AbortController();
  const first = scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "a" }).then(() => grants.push("a1"));
  const aborted = scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "a", signal: controller.signal }).catch(err => err?.code);
  const third = scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "b" }).then(() => grants.push("b1"));
  controller.abort();

  assert.equal(await aborted, "OPERATION_ABORTED");
  await Promise.all([first, third]);
  assert.deepEqual(grants, ["a1", "b1"]);
  assert.deepEqual(waits, [1000]);
});

test("site open rate limiter jitters the next host interval within twenty percent", async () => {
  let now = 0;
  const waits = [];
  const randomValues = [0, 1];
  const scheduler = createSiteOpenRateLimitScheduler({
    now: () => now,
    random: () => randomValues.shift() ?? 0.5,
    delay: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });

  const first = await scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "a" });
  const second = await scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "b" });
  const third = await scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "c" });

  assert.equal(first.nextIntervalMs, 800);
  assert.equal(second.waitMs, 800);
  assert.equal(second.nextIntervalMs, 1200);
  assert.equal(third.waitMs, 1200);
  assert.deepEqual(waits, [800, 1200]);
});

test("site open rate limiter rechecks host availability after queued waits", async () => {
  let now = 0;
  const waits = [];
  const randomValues = [0, 1, 0.5];
  let scheduler;
  scheduler = createSiteOpenRateLimitScheduler({
    now: () => now,
    random: () => randomValues.shift() ?? 0.5,
    delay: async (ms) => {
      waits.push(ms);
      if (waits.length === 1) {
        scheduler.record({ host: "example.com", minOpenIntervalMs: 1000 });
      }
      now += ms;
    },
  });

  await scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "a" });
  const second = await scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "b" });

  assert.equal(second.waitMs, 1200);
  assert.deepEqual(waits, [800, 400]);
});

test("site open rate limiter immediately marks non-head queued requests as waiting", async () => {
  let now = 0;
  const waits = [];
  const delayResolvers = [];
  const updates = [];
  const scheduler = createSiteOpenRateLimitScheduler({
    now: () => now,
    random: () => 0.5,
    delay: async (ms) => {
      waits.push(ms);
      await new Promise(resolve => delayResolvers.push(() => {
        now += ms;
        resolve();
      }));
    },
  });

  await scheduler.acquire({ host: "example.com", minOpenIntervalMs: 1000, sessionId: "a" });
  const second = scheduler.acquire({
    host: "example.com",
    minOpenIntervalMs: 1000,
    sessionId: "b",
    emitUpdate: update => updates.push({ label: "second", ...update }),
  });
  await Promise.resolve();
  const third = scheduler.acquire({
    host: "example.com",
    minOpenIntervalMs: 1000,
    sessionId: "c",
    emitUpdate: update => updates.push({ label: "third", ...update }),
  });
  await Promise.resolve();

  assert.equal(updates.some(item => item.label === "second" && item.statusText === "流控等待中"), true);
  assert.equal(updates.some(item => item.label === "third" && item.statusText === "流控等待中"), true);

  delayResolvers.shift()?.();
  await Promise.resolve();
  await second;
  await Promise.resolve();
  delayResolvers.shift()?.();
  await third;
  assert.deepEqual(waits, [1000, 1000]);
});

test("builds a concise system prompt section for configured rules", () => {
  assert.equal(buildSecurityGuardrailPromptSection({}), "");
  const section = buildSecurityGuardrailPromptSection({
    rules: [
      { action: "block", type: "domain", value: "example.com" },
      { action: "allow", type: "pattern", value: "*://example.org/public/*" },
    ],
  }, { limit: 1 });
  assert.match(section, /用户配置的安全护栏/);
  assert.match(section, /禁止访问 \/ 域名: example\.com/);
  assert.match(section, /元信息可以用于判断当前状态/);
  assert.match(section, /另有 1 条护栏规则未展示/);
  assert.doesNotMatch(section, /^- 允许访问 \/ 模糊匹配/m);
  assert.doesNotMatch(section, /URL Pattern/);
});

test("tool metadata APIs keep blocked tabs visible but annotated", async () => {
  resetStorage();
  resetChromeMocks();
  await saveSecurityGuardrails({ rules: [{ action: "block", type: "domain", value: "example.com" }] });
  mockTabs = [
    { id: 1, windowId: 1, title: "Private", url: "https://example.com/private", active: true, pinned: false },
    { id: 2, windowId: 1, title: "News", url: "https://news.example.org", active: false, pinned: false },
  ];

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools);
  const runtime = session.createRuntime();
  const active = await runtime.execute("get_working_tab", {}, null, { ...session.context, workingTabId: 1 });
  assert.equal(active.hasWorkingTab, true);
  assert.equal(active.id, 1);
  assert.equal(active.url, "https://example.com/private");
  assert.equal(active.securityGuardrailBlocked, true);
  assert.equal(active.contentAccess, "blocked");

  const listed = await runtime.execute("list_tabs", {});
  assert.deepEqual(listed.map(tab => tab.id), [1, 2]);
  assert.equal(listed[0].securityGuardrailBlocked, true);
  assert.equal(listed[1].securityGuardrailBlocked, undefined);

  assert.equal(listed[0].contentAccess, "blocked");
});

test("tool content and navigation APIs are blocked before touching guarded URLs", async () => {
  resetStorage();
  resetChromeMocks();
  await saveSecurityGuardrails({ rules: [{ action: "block", type: "domain", value: "example.com" }] });
  mockTabs = [
    { id: 1, windowId: 1, title: "Private", url: "https://example.com/private", active: true, pinned: false },
    { id: 2, windowId: 1, title: "Allowed", url: "https://news.example.org", active: false, pinned: false },
  ];

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools);
  const runtime = session.createRuntime();
  await assertRejectsWithCode(
    runtime.execute("read_article", { tabId: 1, limit: 4000 }, null, session.context),
    "SECURITY_GUARDRAIL_BLOCKED",
  );
  assert.deepEqual(sentContentMessages, []);

  await assertRejectsWithCode(runtime.execute("open_tab", { url: "https://example.com/new" }), "SECURITY_GUARDRAIL_BLOCKED");
  assert.deepEqual(createdTabs, []);

  await assertRejectsWithCode(runtime.execute("read_image", { url: "https://example.com/image.png" }), "SECURITY_GUARDRAIL_BLOCKED");
});

test("navigation tools use safety guardrail domain rate limits and emit waiting status", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { host: "news.example.org", minOpenIntervalMs: 80 },
    ],
  });

  const tools = await importToolsForGuardrailTests();
  const toolEvents = [];
  const runtime = createOpenTabRuntime(tools, { emit: event => toolEvents.push(event) });
  try {
    await runtime.execute("open_tab", { url: "https://news.example.org/a" }, null, {
      sessionId: "rate-session-a",
      runId: "run_rate_a",
      spanId: "span_rate_a",
      toolCallId: "call_rate_a",
    });
    await runtime.execute("open_tab", { url: "https://news.example.org/b" }, null, {
      sessionId: "rate-session-b",
      runId: "run_rate_b",
      spanId: "span_rate_b",
      toolCallId: "call_rate_b",
    });
  } finally {
    resetSiteOpenRateLimitSchedulerForTests();
  }

  assert.equal(createdTabs.length, 2);
  assert.equal(toolEvents.some(event => (
    event.type === "tool_execution_update"
    && event.toolCallId === "call_rate_b"
    && event.statusText === "流控等待中"
    && event.rateLimit?.host === "news.example.org"
    && event.rateLimit?.type === "domain"
  )), true);
});

test("navigation tools use safety guardrail pattern rate limits without domain fallback", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { type: "pattern", value: "*://pattern-only.example/rate/*", minOpenIntervalMs: 80 },
    ],
  });

  const tools = await importToolsForGuardrailTests();
  const toolEvents = [];
  const runtime = createOpenTabRuntime(tools, { emit: event => toolEvents.push(event) });
  try {
    await runtime.execute("open_tab", { url: "https://pattern-only.example/free/1" }, null, {
      sessionId: "pattern-session-free",
      runId: "run_pattern_free",
      spanId: "span_pattern_free",
      toolCallId: "call_pattern_free",
    });
    await runtime.execute("open_tab", { url: "https://pattern-only.example/rate/a" }, null, {
      sessionId: "pattern-session-a",
      runId: "run_pattern_a",
      spanId: "span_pattern_a",
      toolCallId: "call_pattern_a",
    });
    await runtime.execute("open_tab", { url: "https://pattern-only.example/rate/b" }, null, {
      sessionId: "pattern-session-b",
      runId: "run_pattern_b",
      spanId: "span_pattern_b",
      toolCallId: "call_pattern_b",
    });
  } finally {
    resetSiteOpenRateLimitSchedulerForTests();
  }

  assert.equal(createdTabs.length, 3);
  assert.equal(toolEvents.some(event => event.toolCallId === "call_pattern_free" && event.statusText === "流控等待中"), false);
  assert.equal(toolEvents.some(event => (
    event.type === "tool_execution_update"
    && event.toolCallId === "call_pattern_b"
    && event.statusText === "流控等待中"
    && event.rateLimit?.host === "pattern-only.example"
    && event.rateLimit?.type === "pattern"
    && event.rateLimit?.pattern === "*://pattern-only.example/rate/*"
  )), true);
});

test("navigate uses safety guardrail pattern rate limits without domain fallback", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { type: "pattern", value: "*://pattern-nav.example/rate/*", minOpenIntervalMs: 80 },
    ],
  });
  mockTabs = [
    { id: 77, windowId: 1, title: "Pattern Nav", url: "https://pattern-nav.example/start", active: false, pinned: false },
  ];

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools, { sessionId: "nav-pattern-session" });
  const sessionContext = {
    ...session.context,
    workingTabId: 77,
  };
  const toolEvents = [];
  const runtime = session.createRuntime({ emit: event => toolEvents.push(event) });
  try {
    await runtime.execute("navigate", { url: "https://pattern-nav.example/free/1" }, null, {
      ...sessionContext,
      runId: "run_nav_pattern_free",
      spanId: "span_nav_pattern_free",
      toolCallId: "call_nav_pattern_free",
    });
    await runtime.execute("navigate", { url: "https://pattern-nav.example/rate/a" }, null, {
      ...sessionContext,
      runId: "run_nav_pattern_a",
      spanId: "span_nav_pattern_a",
      toolCallId: "call_nav_pattern_a",
    });
    await runtime.execute("navigate", { url: "https://pattern-nav.example/rate/b" }, null, {
      ...sessionContext,
      runId: "run_nav_pattern_b",
      spanId: "span_nav_pattern_b",
      toolCallId: "call_nav_pattern_b",
    });
  } finally {
    resetSiteOpenRateLimitSchedulerForTests();
  }

  assert.equal(createdTabs.length, 0);
  assert.equal(mockTabs[0].url, "https://pattern-nav.example/rate/b");
  assert.equal(toolEvents.some(event => event.toolCallId === "call_nav_pattern_free" && event.statusText === "流控等待中"), false);
  assert.equal(toolEvents.some(event => (
    event.type === "tool_execution_update"
    && event.toolCallId === "call_nav_pattern_b"
    && event.statusText === "流控等待中"
    && event.rateLimit?.host === "pattern-nav.example"
    && event.rateLimit?.type === "pattern"
    && event.rateLimit?.pattern === "*://pattern-nav.example/rate/*"
  )), true);
});

test("act_on_element blocks known click href before dispatching the click", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({ rules: [{ action: "block", type: "domain", value: "blocked-click.example" }] });
  mockTabs = [
    { id: 81, windowId: 1, title: "Allowed", url: "https://source.example/page", active: false, pinned: false },
  ];
  installClickableElementMock({
    href: "https://blocked-click.example/private",
    afterUrl: "https://blocked-click.example/private",
  });

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools);
  const runtime = session.createRuntime();
  await assertRejectsWithCode(
    runtime.execute("act_on_element", { tabId: 81, target: "css:a.blocked", action: "click" }, null, session.context),
    "SECURITY_GUARDRAIL_BLOCKED",
  );

  assert.equal(sentDebuggerCommands.some(item => item.method === "Input.dispatchMouseEvent"), false);
  assert.equal(mockTabs[0].url, "https://source.example/page");
});

test("act_on_element uses rate limits for known click href targets", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { host: "click-rate.example", minOpenIntervalMs: 300 },
    ],
  });
  mockTabs = [
    { id: 82, windowId: 1, title: "Click Source", url: "https://source.example/page", active: false, pinned: false },
  ];
  const hrefs = ["https://click-rate.example/a", "https://click-rate.example/b"];
  installClickableElementMock({
    href: () => hrefs.shift() || "https://click-rate.example/b",
    afterUrl: activeHref => activeHref,
  });

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools, { sessionId: "click-rate-session" });
  const sessionContext = session.context;
  const toolEvents = [];
  const runtime = session.createRuntime({ emit: event => toolEvents.push(event) });
  try {
    await runtime.execute("act_on_element", { tabId: 82, target: "css:a.next", action: "click" }, null, {
      ...sessionContext,
      runId: "run_click_rate",
      spanId: "span_click_rate_a",
      toolCallId: "call_click_rate_a",
    });
    await runtime.execute("act_on_element", { tabId: 82, target: "css:a.next", action: "click" }, null, {
      ...sessionContext,
      runId: "run_click_rate",
      spanId: "span_click_rate_b",
      toolCallId: "call_click_rate_b",
    });
    session.setRunCurrent(false);
    await tools.releaseRunCdp("click-rate-session", "run_click_rate");
    const fallbackActionsBefore = sentContentMessages.filter(item => item.message?.action === "actOnElement").length;
    await assertRejectsWithCode(
      runtime.execute("act_on_element", { tabId: 82, target: "css:a.next", action: "click" }, null, {
        ...sessionContext,
        runId: "run_click_rate",
        spanId: "span_click_rate_late",
        toolCallId: "call_click_rate_late",
      }),
      "CDP_RUN_RELEASED",
    );
    assert.equal(
      sentContentMessages.filter(item => item.message?.action === "actOnElement").length,
      fallbackActionsBefore,
      "a terminal run must not fall back to content-script page mutation",
    );
  } finally {
    resetSiteOpenRateLimitSchedulerForTests();
  }

  assert.equal(mockTabs[0].url, "https://click-rate.example/b");
  assert.equal(toolEvents.some(event => (
    event.type === "tool_execution_update"
    && event.toolCallId === "call_click_rate_b"
    && event.statusText === "流控等待中"
    && event.rateLimit?.host === "click-rate.example"
  )), true);
});

test("act_on_element records unknown post-click URL changes for later rate limits", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { host: "js-click.example", minOpenIntervalMs: 80 },
    ],
  });
  mockTabs = [
    { id: 83, windowId: 1, title: "JS Source", url: "https://source.example/page", active: false, pinned: false },
  ];
  installClickableElementMock({
    href: "",
    afterUrl: "https://js-click.example/after",
  });

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools, { sessionId: "js-click-session" });
  const sessionContext = session.context;
  const toolEvents = [];
  const runtime = session.createRuntime({ emit: event => toolEvents.push(event) });
  try {
    const clicked = await runtime.execute("act_on_element", { tabId: 83, target: "css:button.router", action: "click" }, null, {
      ...sessionContext,
      runId: "run_js_click",
      spanId: "span_js_click",
      toolCallId: "call_js_click",
    });
    assert.equal(clicked.observedNavigation?.rateLimitRecorded, true);

    const openRuntime = installSessionTabResolver(tools, { sessionId: "js-click-open-session" })
      .createRuntime({ emit: event => toolEvents.push(event) });
    await openRuntime.execute("open_tab", { url: "https://js-click.example/next" }, null, {
      sessionId: "js-click-open-session",
      runId: "run_js_open",
      spanId: "span_js_open",
      toolCallId: "call_js_open",
    });
  } finally {
    resetSiteOpenRateLimitSchedulerForTests();
  }

  assert.equal(toolEvents.some(event => (
    event.type === "tool_execution_update"
    && event.toolCallId === "call_js_open"
    && event.statusText === "流控等待中"
    && event.rateLimit?.host === "js-click.example"
  )), true);
});

test("act_on_element reports blocked unknown post-click URL changes", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({ rules: [{ action: "block", type: "domain", value: "blocked-after-click.example" }] });
  mockTabs = [
    { id: 84, windowId: 1, title: "JS Source", url: "https://source.example/page", active: false, pinned: false },
  ];
  installClickableElementMock({
    href: "",
    afterUrl: "https://blocked-after-click.example/private",
  });

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools);
  const runtime = session.createRuntime();
  await assertRejectsWithCode(
    runtime.execute("act_on_element", { tabId: 84, target: "css:button.router", action: "click" }, null, {
      ...session.context,
      runId: "run_blocked_after_click",
    }),
    "SECURITY_GUARDRAIL_BLOCKED",
  );
  assert.equal(mockTabs[0].url, "https://blocked-after-click.example/private");
});

test("act_on_element ignores hash-only URL changes for navigation rate limits", async () => {
  resetStorage();
  resetChromeMocks();
  resetSiteOpenRateLimitSchedulerForTests();
  await saveSecurityGuardrails({
    siteOpenRateLimits: [
      { host: "hash-click.example", minOpenIntervalMs: 80 },
    ],
  });
  mockTabs = [
    { id: 85, windowId: 1, title: "Hash Source", url: "https://hash-click.example/page", active: false, pinned: false },
  ];
  installClickableElementMock({
    href: "",
    afterUrl: "https://hash-click.example/page#section",
  });

  const tools = await importToolsForGuardrailTests();
  const session = installSessionTabResolver(tools, { sessionId: "hash-click-session" });
  const sessionContext = session.context;
  const toolEvents = [];
  const runtime = session.createRuntime({ emit: event => toolEvents.push(event) });
  try {
    const clicked = await runtime.execute("act_on_element", { tabId: 85, target: "css:a.anchor", action: "click" }, null, {
      ...sessionContext,
      runId: "run_hash_click",
      spanId: "span_hash_click",
      toolCallId: "call_hash_click",
    });
    assert.equal(clicked.navigated, false);
    assert.equal(clicked.observedNavigation, undefined);

    const openRuntime = installSessionTabResolver(tools, { sessionId: "hash-open-session" })
      .createRuntime({ emit: event => toolEvents.push(event) });
    await openRuntime.execute("open_tab", { url: "https://hash-click.example/next" }, null, {
      sessionId: "hash-open-session",
      runId: "run_hash_open",
      spanId: "span_hash_open",
      toolCallId: "call_hash_open",
    });
  } finally {
    resetSiteOpenRateLimitSchedulerForTests();
  }

  assert.equal(toolEvents.some(event => (
    event.type === "tool_execution_update"
    && event.toolCallId === "call_hash_open"
    && event.statusText === "流控等待中"
  )), false);
});

test("service worker routes tool runtime updates through the session event pipeline", () => {
  const source = readSource(join(root, "src/background/service-worker.js"));
  const eventRouter = readSource(join(root, "src/background/tools/event-router.ts"));
  assert.match(
    source,
    /createToolEventRouter\(\{[\s\S]*handleAgentEvent:\s*sessionAgentHost\.handleEvent,[\s\S]*createToolRuntime\(\{[\s\S]*emit:\s*handleToolRuntimeEvent/,
    "the composition root should connect the tool runtime to the shared event router",
  );
  assert.match(
    eventRouter,
    /channel\.isRuntimeEvent\(event\)[\s\S]*handleAgentEvent\(event\.sessionId,\s*event\)[\s\S]*return/,
    "tool runtime updates should update session transcript/runtime before broadcasting",
  );
  assert.doesNotMatch(
    source,
    /createToolRuntime\(\{[\s\S]*emit:\s*broadcast/,
    "tool runtime updates should not bypass session state with a naked broadcast sink",
  );
});

test("rate-limit tool progress is recoverable from runtime snapshots", () => {
  let runtime = null, checkpoint = null;
  const state = createSessionRuntimeState({
    supervisor: {
      getRuntime: () => runtime,
      setRuntime: (_id, next) => (runtime = next),
    },
    repository: { async writeRuntime(_id, value) { checkpoint = structuredClone(value); } },
    getSessions: async () => ({}), getAgentEntry: () => ({ ready: null }), normalizeSessionId: String,
    now: () => "2026-10-28 12:00:00",
  });
  const sessionId = "rate-limit", runId = "rate-run";
  const emit = (type, toolCallId, fields = {}) => state.recordEvent(sessionId, { type, runId, toolCallId, ...fields });
  emit("agent_start");
  emit("tool_execution_start", "opening", { toolName: "open_tab" });
  emit("tool_execution_start", "reading", { toolName: "read_article" });
  const rateLimit = { host: "example.test", waitMs: 1000 };
  emit("tool_execution_update", "opening", { phase: "queued", statusText: "流控等待中", rateLimit });
  assert.equal(checkpoint.currentTool.statusText, "流控等待中");
  assert.deepEqual(checkpoint.currentTool.rateLimit, rateLimit);
  const queuedTool = structuredClone(checkpoint.currentTool);
  const reconnected = createSessionState();
  reconnected.applyEvent({ type: "state", sessionId, runId, runtime: checkpoint });
  assert.deepEqual(reconnected.getRuntime(sessionId).currentTool, queuedTool,
    "reconnecting the Side Panel must restore persisted queued progress");
  emit("tool_execution_end", "reading");
  assert.deepEqual(checkpoint.currentTool, queuedTool, "a sibling ending must preserve the queued call");
  reconnected.applyEvent({ type: "tool_execution_end", sessionId, runId, toolCallId: "reading", runtime: checkpoint });
  assert.deepEqual(reconnected.getRuntime(sessionId).currentTool, queuedTool);
  emit("tool_execution_end", "opening");
  assert.equal(checkpoint.currentTool, null, "ending the last call must clear persisted progress");
  reconnected.applyEvent({ type: "tool_execution_end", sessionId, runId, toolCallId: "opening", runtime: checkpoint });
  assert.equal(reconnected.getRuntime(sessionId).currentTool, null);
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

console.log(`${tests.length} security guardrail tests passed`);

function readSource(path) {
  const sourcePath = existsSync(path) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(sourcePath, "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code : source;
}
