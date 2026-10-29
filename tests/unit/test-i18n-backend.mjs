import assert from "node:assert/strict";
import { test } from "node:test";
import { backendMessages } from "../../src/shared/i18n/backend-messages.js";
import {
  localizeToolFailureCode,
  localizeToolFailurePayload,
  localizeToolFailureText,
  localizeToolDiagnostic,
} from "../../src/shared/tools/tool-error-localization.js";
import { normalizeLlmFailure, llmFailureFacts, formatLlmFailureForUser } from "../../src/background/llm/provider-errors.js";
import { providerRecoveryHint } from "../../src/background/llm/provider-recovery.js";
import { createSessionCompletionNotifier } from "../../src/background/services/chrome-notifications.js";
import { createSessionListSummaryFromFirstMessage, formatSessionListSummaryText, createSessionListSummaryFromAgentEvent } from "../../src/shared/session/session-list-summary.js";
import { describeAutomationSchedule, computeNextRunAt } from "../../src/shared/automation-store.js";
import { qingzhouTabGroupPatch, ensureQingzhouTabGroupForWindow } from "../../src/shared/tab-groups.js";
import { formatBeijingDateTime, parseBeijingDateTime } from "../../src/shared/time-utils.js";
import { t as contentText } from "../../src/content/i18n.js";
import { appendErrorSection } from "../../src/sidepanel/tools/generic-result-renderer.js";

async function inLanguage(language, run) {
  const chrome = globalThis.chrome;
  globalThis.chrome = { ...chrome, i18n: { getUILanguage: () => language } };
  try { return await run(); }
  finally { if (chrome === undefined) delete globalThis.chrome; else globalThis.chrome = chrome; }
}

test("backend catalogs provide complete bilingual plain-text messages", () => {
  assert.ok(Object.keys(backendMessages.messages).length > 800);
  for (const [key, value] of Object.entries(backendMessages.messages)) {
    assert.equal(typeof value.en, "string", key);
    assert.equal(typeof value["zh-CN"], "string", key);
    assert.ok(value.en.length, key);
    assert.doesNotMatch(value.en, /[\u3400-\u9fff]/u, key);
    const parameters = text => [...text.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(parameters(value.en), parameters(value["zh-CN"]), key);
  }
});

test("isolated content bridge messages use the extension language instead of the page language", async () => {
  assert.equal(await inLanguage("en-US", () => contentText("brand")), "qz");
  assert.equal(await inLanguage("zh-CN", () => contentText("importFailed")), "会话导入失败");
  assert.equal(await inLanguage("fr-FR", () => contentText("noStableSelector")), "Could not generate a stable selector for this element");
});

test("tool errors translate at the boundary and retain machine identity and original evidence", async () => {
  const input = { ok: false, code: "DATA_ROW_CONFLICT", error: "changed revision 7", details: { rowId: "row:abc", revision: 7 } };
  const english = await inLanguage("en-GB", () => localizeToolFailurePayload(input));
  const chinese = await inLanguage("zh-CN", () => localizeToolFailurePayload(input));
  assert.match(english.error, /Read it again before updating/);
  assert.match(chinese.error, /重新读取后再更新/);
  assert.equal(english.code, input.code);
  assert.equal(english.details.rowId, "row:abc");
  assert.equal(english.details.revision, 7);
  assert.equal(english.details.originalError, input.error);
  assert.equal(input.error, "changed revision 7");
  assert.equal(await inLanguage("de-DE", () => localizeToolFailureCode("TOOL_NOT_EXECUTED")), "Tool did not run");
});

test("location failures keep stable codes and short recovery text", async () => {
  const cases = [
    ["LOCATION_RESPONSE_TIMEOUT", "locationResponseTimeout", "locationResponseTimeoutLabel"],
    ["LOCATION_TIMEOUT", "locationTimeout", "locationTimeoutLabel"],
    ["LOCATION_PERMISSION_DENIED", "locationPermissionDenied", "locationPermissionDeniedLabel"],
    ["LOCATION_POSITION_UNAVAILABLE", "locationPositionUnavailable", "locationPositionUnavailableLabel"],
    ["LOCATION_UNAVAILABLE", "locationUnavailable", "locationUnavailableLabel"],
    ["LOCATION_PANEL_UNAVAILABLE", "locationPanelUnavailable", "locationPanelUnavailableLabel"],
  ];
  const expected = {
    en: {
      LOCATION_RESPONSE_TIMEOUT: "Location timed out. Allow location in the browser and turn on system Location Services, or just tell me a city or area.",
      LOCATION_PERMISSION_DENIED: "Location was blocked. Allow it when the browser asks, check system Location Services, or just tell me a city or area.",
      LOCATION_TIMEOUT: "Location timed out. Keep the sidebar open and allow browser location, or just tell me a city or area.",
      LOCATION_POSITION_UNAVAILABLE: "Couldn't determine your position. Check network and Location Services, or just tell me a city or area.",
      LOCATION_UNAVAILABLE: "Couldn't get your location. Open the sidebar and check location permissions, or just tell me a city or area.",
      LOCATION_PANEL_UNAVAILABLE: "Sidebar isn't connected. Open it in this window and try again, or just tell me a city or area.",
    },
    "zh-CN": {
      LOCATION_RESPONSE_TIMEOUT: "定位超时。请确认已允许浏览器定位，并打开系统定位服务；也可直接告诉我城市或区域。",
      LOCATION_PERMISSION_DENIED: "定位被拒绝。请在浏览器提示中允许定位，并检查系统定位权限；也可直接告诉我城市或区域。",
      LOCATION_TIMEOUT: "定位超时。请保持侧边栏打开并允许浏览器定位，或直接告诉我城市或区域。",
      LOCATION_POSITION_UNAVAILABLE: "暂时无法定位。请检查网络和系统定位服务，或直接告诉我城市或区域。",
      LOCATION_UNAVAILABLE: "未能获取位置。请打开侧边栏并检查定位权限，或直接告诉我城市或区域。",
      LOCATION_PANEL_UNAVAILABLE: "侧边栏未连接。请打开当前窗口的侧边栏后重试，或直接告诉我城市或区域。",
    },
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({
      innerHTML: "",
      set textContent(value) {
        this.innerHTML = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      },
    }) },
  });
  try {
    for (const [code, messageKey, labelKey] of cases) {
      for (const language of ["en", "zh-CN"]) {
        const payload = await inLanguage(language, () => localizeToolFailurePayload({
          ok: false,
          code,
          error: "The side panel did not return a location result",
        }));
        const message = backendMessages.messages[messageKey][language];
        const label = backendMessages.messages[labelKey][language];
        assert.equal(message, expected[language][code]);
        assert.equal(payload.code, code);
        assert.equal(payload.error, message);
        assert.equal(payload.codeLabel, label);
        assert.equal(payload.details.originalCode, code);
        assert.equal(payload.details.originalError, "The side panel did not return a location result");
        assert.equal(message.includes(code), false);
        assert.equal(/Chrome|Firefox/.test(message), false);
        assert.equal(label.includes("_"), false);
        const sections = [];
        await inLanguage(language, () => {
          appendErrorSection({ appendChild: section => sections.push(section) }, {
            ok: false, code, error: "The side panel did not return a location result",
          });
        });
        const html = sections.at(-1).innerHTML;
        assert.match(html, /tool-error-message/);
        assert.equal(html.includes(message), true);
        assert.equal(html.includes(label), true);
        assert.equal(html.includes(code), false);
      }
    }
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }
});

test("tool failures interpolate fields without translating caller values", async () => {
  const actual = await inLanguage("en", () => localizeToolFailureText("invalid", {
    code: "INVALID_ARGUMENTS", toolName: "自定义工具", details: { path: "$.标题", allowedValues: ["保留原值", "next"] },
  }));
  assert.equal(actual, "Invalid 标题 for 自定义工具. Use one of: 保留原值, next.");
  assert.equal(await inLanguage("en", () => localizeToolFailureText("Unknown tool: example")), "Unknown tool: example");
  assert.equal(await inLanguage("en", () => localizeToolFailureText("opaque private error")), "The tool call failed.");
});

test("diagnostic category and cached code label can be rendered in a different language", async () => {
  const chinese = await inLanguage("zh-CN", () => localizeToolFailurePayload({ code: "TOOL_TIMEOUT", error: "timeout", diagnostic: { category: "timeout" } }));
  const english = await inLanguage("en", () => localizeToolFailurePayload(chinese));
  assert.equal(english.codeLabel, "Tool execution timed out");
  assert.equal(english.diagnostic.category, "Timeout");
  assert.equal(english.diagnostic.originalCategory, "timeout");
  assert.deepEqual(await inLanguage("en", () => localizeToolDiagnostic({ category: "third_party", detail: "用户内容" })), { category: "third_party", detail: "用户内容" });
});

test("provider language does not change classification, request identity or retry semantics", async () => {
  const hints = { status: 429, code: "Throttling.AllocationQuota", message: "Allocated quota exceeded", requestId: "req-123", retryAfterMs: 1234 };
  const english = await inLanguage("en", () => normalizeLlmFailure(new Error(hints.message), hints));
  const chinese = await inLanguage("zh-CN", () => normalizeLlmFailure(new Error(hints.message), hints));
  assert.deepEqual(llmFailureFacts(english), llmFailureFacts(chinese));
  assert.equal(english.providerMessage, hints.message);
  assert.match(english.message, /quota has been used up/);
  assert.match(chinese.message, /额度已用尽/);
  assert.match(english.message, /\(Throttling.AllocationQuota, HTTP 429\)\./);
  const recovery = await inLanguage("en", () => providerRecoveryHint(english, { provider: "custom" }));
  assert.equal(recovery.strategy, "same_protocol");
  assert.equal(recovery.delayMs, 2000);
  assert.match(recovery.message, /Retrying once in 2 seconds/);
});

test("unsupported image guidance translates while external provider diagnostics remain intact", async () => {
  const result = await inLanguage("en", () => formatLlmFailureForUser({ kind: "invalid_request", code: "invalid_parameter_error", message: "Unexpected item type in content." }));
  assert.match(result, /set “Image support” to “No”/);
  const resultWithEvidence = await inLanguage("en", () => formatLlmFailureForUser({ kind: "invalid_request", status: 400, message: "Original vendor diagnostic: 用户数据" }));
  assert.match(resultWithEvidence, /Original vendor diagnostic: 用户数据$/u);
});

test("summary display translates owned prefixes without changing Chinese user content", async () => {
  const body = "用户: 原始内容；Error: 不应替换；完成";
  const summary = await inLanguage("zh-CN", () => createSessionListSummaryFromFirstMessage(body, "2026-09-19 10:00:00"));
  assert.equal(summary.lastText, `用户: ${body}`);
  assert.equal(await inLanguage("en", () => formatSessionListSummaryText(summary)), `User: ${body}`);
  assert.equal(summary.lastText, `用户: ${body}`, "projection must not write the cache");
  assert.equal(await inLanguage("en", () => formatSessionListSummaryText({ lastType: "assistant", lastText: "用户: 完成" })), "用户: 完成");
  assert.equal(await inLanguage("en", () => formatSessionListSummaryText({ lastType: "note", lastText: "已取消" })), "已取消");
  assert.equal(await inLanguage("en", () => formatSessionListSummaryText({ lastType: "tool", lastText: "我的工具 完成" })), "我的工具 completed");
  assert.equal(await inLanguage("zh-CN", () => formatSessionListSummaryText({ lastType: "run-status", lastText: "Cancelled" })), "已取消");
  assert.equal(await inLanguage("zh-CN", () => formatSessionListSummaryText({ lastType: "run-status", lastText: "Canceled" })), "已取消");
  assert.equal(await inLanguage("en", () => formatSessionListSummaryText({ lastType: "run-status", lastText: "Cancelled" })), "Canceled");
  assert.equal(await inLanguage("zh-CN", () => formatSessionListSummaryText({ lastType: "assistant", lastText: "Canceled" })), "Canceled", "do not translate authored messages");
  const generated = await inLanguage("en", () => createSessionListSummaryFromAgentEvent({ type: "aborted" }));
  assert.equal(generated.lastText, "Canceled");
});

test("notification titles follow browser language and preserve the user's task title", async () => {
  const notices = [];
  const notifier = createSessionCompletionNotifier({
    notifications: { isChromeVisuallyFocused: async () => false, create: async (id, options) => { notices.push(options); return id; } },
    getRuntime: () => ({ status: "completed", running: false, runId: "run-1" }),
    getSessions: async () => ({ s1: { id: "s1", title: "我的用户标题", parentSessionId: "0" } }),
  });
  assert.equal(await inLanguage("en", () => notifier.notifyCompleted("s1")), true);
  assert.equal(notices[0].title, "qz task completed");
  assert.equal(notices[0].message, "我的用户标题");
});

test("schedule display localizes without changing Beijing-time persistence or scheduling", async () => {
  const schedule = { type: "weekly", weekday: 1, time: "09:30" };
  assert.equal(await inLanguage("zh-CN", () => describeAutomationSchedule(schedule)), "每周一 09:30");
  assert.equal(await inLanguage("en-US", () => describeAutomationSchedule(schedule)), "Every Monday at 09:30");
  const now = Date.parse("2026-09-19T00:00:00Z");
  const first = await inLanguage("zh-CN", () => computeNextRunAt(schedule, now));
  const second = await inLanguage("en-US", () => computeNextRunAt(schedule, now));
  assert.equal(first, second);
  assert.equal(formatBeijingDateTime(now), "2026-09-19 08:00:00");
  assert.equal(parseBeijingDateTime("2026-09-19 08:00:00"), now);
});


for (const title of ["轻舟任务", "Qingzhou task", "qz task"]) test(`tab groups reuse ${title} after the brand change`, async () => {
  await inLanguage("en", async () => {
    assert.equal(qingzhouTabGroupPatch().title, "qz task");
    const patches = [];
    globalThis.chrome = {
      ...globalThis.chrome,
      tabs: { get: async id => ({ id, windowId: 1 }), query: async () => [{ id: 7 }], group: async () => { throw new Error("must reuse the existing group"); } },
      tabGroups: { query: async () => [{ id: 8, windowId: 1, title }], update: async (id, patch) => { patches.push(patch); return { id, windowId: 1, ...patch }; } },
    };
    const result = await ensureQingzhouTabGroupForWindow([7]);
    assert.equal(result.groupId, 8);
    assert.equal(patches.at(-1).title, "qz task");
  });
});
