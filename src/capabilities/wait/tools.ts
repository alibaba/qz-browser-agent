import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension } from "#sdk/background";
import { delayTimeout, pageWaitTimeout } from "#sdk/background/tools";
/** Wait for user actions, navigation, page elements, or a specified time. */

import {
  formatBeijingDateTime,
  parseBeijingDateTime,
} from "#sdk/shared/format";

import type { RegisterTool, ToolContext } from "#sdk/background";
import { ToolExecutionError } from "#sdk/background/tools";

import type { ToolEvent } from "#sdk/background";
import type { UserWaitRuntime } from "#sdk/background";
export type { UserWaitRuntime } from "#sdk/background";
interface WaitDependencies {
  registerTool: RegisterTool;
  getToolRuntimeDependencies(context: ToolContext): { sessions?: Partial<UserWaitRuntime> | null; emit?: ((event: ToolEvent) => void) | null };
  captureTabScreenshot(tabId: number, options: { format: "jpeg" | "png"; quality: number }, context: ToolContext): Promise<{ dataUrl: string; method?: string }>;
  sendToContent(tabId: number | undefined, action: string, args: Record<string, unknown>): Promise<unknown>;
}
type QuestionField = Record<string, unknown>;
interface NavigationResult { status: string; waited: boolean; url?: string; title?: string }

/** Human waits and page waits share the same declarative execution contract. */
export function registerWaitTools({ registerTool, getToolRuntimeDependencies, captureTabScreenshot, sendToContent }: WaitDependencies) {
const WAIT_MAX_DELAY_MS = 2 * 60 * 60 * 1000;
const WAIT_CLOCK_RECHECK_MS = 30 * 1000;
const ZONED_ISO_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

function normalizeWaitSelector(selector = "") {
  const raw = String(selector || "").trim();
  if (/^css:/i.test(raw)) return raw.slice(raw.indexOf(":") + 1).trim();
  if (/^uid:/i.test(raw)) {
    throw new ToolExecutionError("INVALID_ELEMENT_TARGET", t("waitForElementSelectorSupportsRawCssOrCss"), {
      selector: raw,
      expected: "selector = <css_selector> | css:<css_selector>",
    });
  }
  return raw;
}

function secondsToMs(value: unknown, fallbackMs: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(0, Math.floor(n * 1000));
}

function parseWaitUntil(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return null;

  const beijingMs = parseBeijingDateTime(text);
  if (beijingMs !== null && Number.isFinite(beijingMs) && formatBeijingDateTime(new Date(beijingMs)) === text) return beijingMs;

  const match = text.match(ZONED_ISO_DATE_TIME_RE);
  if (!match || !validIsoDateTimeParts(match)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIsoDateTimeParts(match: RegExpMatchArray) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  const zone = match[8];
  if (zone === "Z") return true;
  const offsetHour = Number(zone.slice(1, 3));
  const offsetMinute = Number(zone.slice(4, 6));
  return offsetHour <= 14 && offsetMinute <= 59 && (offsetHour < 14 || offsetMinute === 0);
}

function waitDelay(delayMs: number, signal?: AbortSignal, details: Record<string, unknown> = {}) {
  if (signal?.aborted) {
    return Promise.reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting", details));
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting", details));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

async function waitUntilTime(targetMs: number, signal?: AbortSignal, details: Record<string, unknown> = {}) {
  if (signal?.aborted) {
    throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting", details);
  }
  while (true) {
    const remainingMs = targetMs - Date.now();
    if (remainingMs <= 0) return;
    await waitDelay(Math.min(remainingMs, WAIT_CLOCK_RECHECK_MS), signal, details);
  }
}

function roundSeconds(milliseconds: number) {
  return Math.round(Math.max(0, Number(milliseconds) || 0)) / 1000;
}

// ---------------------------------------------------------------------------
// SessionSupervisor owns the wait_for_user lifecycle.
// ---------------------------------------------------------------------------

function requireUserWaitRuntime(runtime: Partial<UserWaitRuntime> | null | undefined) {
  if (
    !runtime
    || typeof runtime.beginUserWait !== "function"
    || typeof runtime.resolveUserWait !== "function"
    || typeof runtime.rejectUserWait !== "function"
    || typeof runtime.isWaitingForUser !== "function"
  ) {
    throw new ToolExecutionError("USER_WAIT_RUNTIME_UNAVAILABLE", t("userWaitRuntimeIsUnavailable"));
  }
  return runtime as UserWaitRuntime;
}

function normalizeSessionId(sessionId: unknown) {
  return String(sessionId || "").trim();
}

function createWaitId(sessionId: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `wait_${sessionId || "default"}_${Date.now().toString(36)}_${suffix}`;
}

function canReturnImages(context: ToolContext = {}) {
  return context?.runProfile?.features?.imageInput !== false
    && context?.runProfile?.features?.toolImages !== false;
}

function cardWebUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 4096) return undefined;
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href : undefined;
  } catch { return undefined; }
}

function normalizeQuestionField(field: QuestionField = {}, index = 0) {
  const rawType = String(field.type || "text").trim().toLowerCase();
  const typeMap: Record<string, string> = {
    choice: "single_choice",
    select: "single_choice",
    radio: "single_choice",
    checkbox: "multi_choice",
    checkboxes: "multi_choice",
    multiselect: "multi_choice",
  };
  const type = ["text", "textarea", "single_choice", "multi_choice"].includes(rawType)
    ? rawType
    : (typeMap[rawType] || "text");
  const cards = field.presentation === "cards" && (type === "single_choice" || type === "multi_choice");
  const id = String(field.id || field.name || `field_${index + 1}`).trim().replace(/[^\w.-]+/g, "_") || `field_${index + 1}`;
  if (cards && Array.isArray(field.options) && field.options.length > 50) {
    throw new ToolExecutionError("INVALID_ARGUMENTS", t("cardsTooManyOptions"), { fieldId: id, maxOptions: 50 });
  }
  const options = Array.isArray(field.options)
    ? field.options.map((option, optionIndex) => {
      if (typeof option === "string") return { label: cards ? option.trim().slice(0, 240) : option, value: option };
      const label = String(option?.label ?? option?.value ?? t("option", { index: String(optionIndex + 1) })).trim();
      // Answer values cross the wire/storage boundary; preserve the legacy fallback independently of UI language.
      const value = String(option?.value ?? option?.label ?? `选项 ${optionIndex + 1}`).trim();
      const description = String(option?.description || "").trim();
      const meta = cards && Array.isArray(option?.meta)
        ? option.meta.filter((entry: unknown): entry is string => typeof entry === "string")
          .map((entry: string) => entry.trim().slice(0, 80)).filter(Boolean).slice(0, 6)
        : [];
      const imageUrl = cards ? cardWebUrl(option?.imageUrl) : undefined;
      const url = cards ? cardWebUrl(option?.url) : undefined;
      return {
        label: cards ? label.slice(0, 240) : label,
        value,
        description: cards ? description.slice(0, 1000) : description,
        ...(meta.length ? { meta } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(url ? { url } : {}),
      };
    }).filter(option => option.label && option.value)
    : [];
  const normalizedType = (type === "single_choice" || type === "multi_choice") && options.length === 0 ? "text" : type;
  return {
    id,
    type: normalizedType,
    label: String(field.label || field.title || id).trim(),
    placeholder: String(field.placeholder || "").trim(),
    help: String(field.help || field.description || "").trim(),
    required: field.required !== false,
    defaultValue: normalizeQuestionFieldDefaultValue(field, normalizedType),
    options,
    ...(cards && normalizedType !== "text" ? { presentation: "cards" as const } : {}),
  };
}

function normalizeQuestionFieldDefaultValue(field: QuestionField = {}, type = "text") {
  const source = Object.prototype.hasOwnProperty.call(field, "defaultValue")
    ? field.defaultValue
    : Object.prototype.hasOwnProperty.call(field, "defaultValues")
      ? field.defaultValues
      : Object.prototype.hasOwnProperty.call(field, "default")
        ? field.default
        : field.value;
  if (type === "multi_choice") {
    const values = Array.isArray(source) ? source : (source == null || source === "" ? [] : [source]);
    return values.map(value => String(value).trim()).filter(Boolean);
  }
  if (source == null) return "";
  return String(source).trim();
}

function normalizeQuestionForm({ title = "", message = "", fields = [], submitLabel = "" }: { title?: string; message?: string; fields?: QuestionField[]; submitLabel?: string } = {}) {
  const normalizedFields = (Array.isArray(fields) ? fields : [])
    .slice(0, 8)
    .map(normalizeQuestionField)
    .filter(field => field.id && field.label);
  return {
    title: String(title || t("provideMoreInformation")).trim(),
    message: String(message || "").trim(),
    submitLabel: String(submitLabel || t("submit")).trim(),
    fields: normalizedFields.length
      ? normalizedFields
      : [normalizeQuestionField({ id: "answer", label: t("additionalNotes"), type: "textarea", required: true }, 0)],
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

registerTool({
  name: "wait_for_user",
  model: { pageContext: "working" },
  get description() { return toolT("waitForUserDescription"); },
  get parameters() { return {
    type: "object",
    "x-disableCommonTimeout": true,
    properties: {
      message: {
        type: "string",
        description: toolT("waitForUserMessage"),
      },
      tabId: {
        type: "number",
        description: toolT("waitForUserTabId"),
      },
    },
    required: ["message"],
  } as const; },
  page: args => args.tabId == null ? false : "owned",
  timeout: 0,
  execute: async ({ message, tabId }, signal, context = {}) => {
    const runtime = getToolRuntimeDependencies(context);
    const sessions = requireUserWaitRuntime(runtime.sessions);
    const emit = runtime.emit || (() => {});
    const sessionId = normalizeSessionId(context.sessionId);
    const runId = String(context.runId || "").trim();
    const waitId = createWaitId(sessionId);
    const targetTabId = Number(tabId || context.workingTabId);

    // Notify the Side Panel to display the waiting state.
    emit({
      type: "waiting_for_user",
      sessionId,
      runId,
      waitId,
      message,
    });

    // Wait for the user action.
    const waitValue = await sessions.beginUserWait(sessionId, {
      waitId,
      runId,
      signal,
      onSettled(reason) {
        emit({ type: "user_wait_resolved", sessionId, runId, waitId, reason });
      },
    });
    const waitResult = waitValue && typeof waitValue === "object" ? waitValue as Record<string, unknown> : {};

    // Capture the resulting page for vision-capable models after the user completes the action.
    if (!canReturnImages(context)) {
      return {
        continued: true,
        reason: waitResult.reason,
        tabId: Number.isFinite(targetTabId) && targetTabId > 0 ? targetTabId : undefined,
        note: toolT("userContinuedNoImages"),
      };
    }
    try {
      const effectiveTabId = Number.isFinite(targetTabId) && targetTabId > 0 ? targetTabId : null;
      if (effectiveTabId) {
        const shot = await captureTabScreenshot(effectiveTabId, { format: "jpeg", quality: 70 }, context);
        return {
          _image: shot.dataUrl,
          continued: true,
          reason: waitResult.reason,
          tabId: effectiveTabId,
          screenshotMethod: shot.method,
          note: toolT("userContinuedWithImage"),
        };
      }
    } catch(_e) { /* Continue when screenshot capture fails. */ }

    return {
      continued: true,
      reason: waitResult.reason,
      note: toolT("userContinued"),
    };
  },
});

registerTool({
  name: "ask_user",
  get description() { return toolT("askUserDescription"); },
  get parameters() { return {
    type: "object",
    "x-disableCommonTimeout": true,
    properties: {
      title: { type: "string", description: toolT("askUserTitle") },
      message: { type: "string", description: toolT("askUserMessage") },
      submitLabel: { type: "string", description: toolT("askUserSubmitLabel") },
      fields: {
        type: "array",
        description: toolT("askUserFields"),
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: toolT("askUserId") },
            label: { type: "string", description: toolT("askUserLabel") },
            type: { type: "string", enum: ["text", "textarea", "single_choice", "multi_choice"], description: toolT("askUserType") },
            presentation: { type: "string", enum: ["cards"], description: toolT("askUserPresentation") },
            placeholder: { type: "string", description: toolT("askUserPlaceholder") },
            help: { type: "string", description: toolT("askUserHelp") },
            defaultValue: {
              type: "string",
              description: toolT("askUserDefaultValue"),
            },
            defaultValues: {
              type: "array",
              description: toolT("askUserDefaultValues"),
              items: { type: "string" },
            },
            required: { type: "boolean", description: toolT("askUserRequired") },
            options: {
              type: "array",
              description: toolT("askUserOptions"),
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                  description: { type: "string" },
                  meta: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 }, description: toolT("askUserOptionMeta") },
                  imageUrl: { type: "string", maxLength: 4096, description: toolT("askUserOptionImageUrl") },
                  url: { type: "string", maxLength: 4096, description: toolT("askUserOptionUrl") },
                },
              },
            },
          },
          required: ["id", "label"],
        },
      },
    },
    required: ["message", "fields"],
  } as const; },
  timeout: 0,
  execute: async ({ title = "", message = "", fields = [], submitLabel = "" }, signal, context = {}) => {
    const runtime = getToolRuntimeDependencies(context);
    const sessions = requireUserWaitRuntime(runtime.sessions);
    const emit = runtime.emit || (() => {});
    const sessionId = normalizeSessionId(context.sessionId);
    const runId = String(context.runId || "").trim();
    const waitId = createWaitId(sessionId);
    const form = normalizeQuestionForm({ title, message, fields, submitLabel });

    emit({
      type: "waiting_for_user",
      sessionId,
      runId,
      waitId,
      message: form.message,
      form,
    });

    const waitValue = await sessions.beginUserWait(sessionId, {
      waitId,
      runId,
      signal,
      onSettled(reason) {
        emit({ type: "user_wait_resolved", sessionId, runId, waitId, reason });
      },
    });
    const waitResult = waitValue && typeof waitValue === "object" ? waitValue as Record<string, unknown> : {};

    const answers = waitResult && typeof waitResult === "object" && !Array.isArray(waitResult)
      ? (waitResult.answers && typeof waitResult.answers === "object" ? waitResult.answers : {})
      : {};
    return {
      submitted: waitResult?.submitted !== false,
      reason: waitResult?.reason || "submitted",
      answers,
    };
  },
});

registerTool({
  name: "wait_for_navigation",
  model: { noImages: {
    omitParameters: ["screenshot"],
    get description() { return toolT("waitForNavigationNoImages"); },
  } },
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("waitForNavigationDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("waitForNavigationTabId") },
      timeout: { type: "number", description: toolT("waitForNavigationTimeout") },
      screenshot: { type: "boolean", description: toolT("waitForNavigationScreenshot") },
      fromUrl: { type: "string", description: toolT("waitForNavigationFromUrl") },
      fromTitle: { type: "string", description: toolT("waitForNavigationFromTitle") },
    },
  } as const; },
  page: "owned",
  timeout: pageWaitTimeout,
  execute: async (input, signal, context = {}) => {
    const { tabId, timeout = 10, screenshot = false, fromUrl = "", fromTitle = "" } = input;
    const { timeoutMs } = input as Record<string, unknown>;
    const timeoutMsValue = timeoutMs != null ? Math.max(0, Number(timeoutMs) || 0) : secondsToMs(timeout, 10000);
    if (!tabId) throw new ToolExecutionError("SESSION_TAB_TARGET_REQUIRED", t("currentTaskHasNoWorkingTab"));

    // Wait for loading.
    const tab = await chrome.tabs.get(tabId);
    let navResult: NavigationResult;

    if (tab.status === "complete") {
      navResult = { status: "already_complete", waited: false, url: tab.url, title: tab.title };
    } else {
      navResult = await new Promise<NavigationResult>((resolve, reject) => {
        const onAbort = () => {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting for navigation", { tabId }));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          signal?.removeEventListener("abort", onAbort);
          resolve({ status: "timeout", waited: true });
        }, timeoutMsValue);

        const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, updatedTab: chrome.tabs.Tab) => {
          if (updatedTabId !== tabId) return;
          if (changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve({ status: "complete", waited: true, url: updatedTab.url, title: updatedTab.title });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    }

    const inputFromUrl = String(fromUrl || "");
    const inputFromTitle = String(fromTitle || "");
    const changedFromInput = {
      urlChanged: !!inputFromUrl && !!navResult.url && inputFromUrl !== navResult.url,
      titleChanged: !!inputFromTitle && !!navResult.title && inputFromTitle !== navResult.title,
    };
    const textNote = navResult.status === "timeout"
      ? t("pageLoadTimedOutUseScreenshotToInspectThe")
      : navResult.waited === false
        ? t("thePageWasAlreadyCompleteWhenCalledThisReflects")
        : t("pageLoadedUseReadArticleToReadTheContent");

    if (!screenshot || !canReturnImages(context)) {
      return {
        tabId,
        ...navResult,
        ...(inputFromUrl ? { fromUrl: inputFromUrl } : {}),
        ...(inputFromTitle ? { fromTitle: inputFromTitle } : {}),
        ...changedFromInput,
        note: !screenshot
          ? textNote
          : t("pageLoadedThisModelDoesNotSupportImageInput"),
      };
    }

    // Capture on request for visual checks, dialogs, or verification challenges.
    try {
      await new Promise(r => setTimeout(r, 300)); // Wait for rendering.
      const shot = await captureTabScreenshot(tabId, { format: "jpeg", quality: 70 }, context);
      return {
        _image: shot.dataUrl,
        tabId,
        screenshotMethod: shot.method,
        ...navResult,
        ...(inputFromUrl ? { fromUrl: inputFromUrl } : {}),
        ...(inputFromTitle ? { fromTitle: inputFromTitle } : {}),
        ...changedFromInput,
        note: navResult.status === "timeout"
          ? t("pageLoadTimedOutTheScreenshotShowsTheCurrent")
          : t("pageLoadedTheScreenshotShowsTheCurrentPage"),
      };
    } catch(_e) {
      return {
        tabId,
        ...navResult,
        ...(inputFromUrl ? { fromUrl: inputFromUrl } : {}),
        ...(inputFromTitle ? { fromTitle: inputFromTitle } : {}),
        ...changedFromInput,
        note: toolT("navigationScreenshotFailed"),
      };
    }
  },
});

registerTool({
  name: "wait_for_element",
  get description() { return toolT("waitForElementDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("waitForElementTabId") },
      selector: { type: "string", description: toolT("waitForElementSelector") },
      absent: { type: "boolean", description: toolT("waitForElementAbsent") },
      timeout: { type: "number", description: toolT("waitForNavigationTimeout") },
      intervalSeconds: { type: "number", description: toolT("waitForElementIntervalSeconds") },
    },
    required: ["selector"],
  } as const; },
  page: "owned",
  timeout: pageWaitTimeout,
  execute: async (input, signal) => {
    let { selector } = input;
    const { tabId, absent = false, timeout = 10, intervalSeconds = 0.5 } = input;
    const { timeoutMs, interval } = input as Record<string, unknown>;
    selector = normalizeWaitSelector(selector);
    const waitTimeoutMs = timeoutMs != null ? Math.max(0, Number(timeoutMs) || 0) : secondsToMs(timeout, 10000);
    const intervalMs = interval != null ? Math.max(0, Number(interval) || 0) : secondsToMs(intervalSeconds, 500);
    const deadline = Date.now() + waitTimeoutMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting for element", { selector });

      try {
        const result = await sendToContent(tabId, "querySelector", {
          selector,
          limit: 1,
        });
        const found = Array.isArray(result) && result.length > 0;

        if (absent ? !found : found) {
          return {
            found: !absent,
            selector,
            element: found && Array.isArray(result) ? result[0] : null,
          };
        }
      } catch(_e) { /* The page may still be initializing. */ }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return { found: false, selector, timedOut: true };
  },
});

registerTool({
  name: "wait",
  get description() { return toolT("waitDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      seconds: { type: "number", description: toolT("waitSeconds") },
    },
    required: ["seconds"],
  } as const; },
  timeout: delayTimeout,
  execute: async (input, signal) => {
    const { seconds } = input;
    const { ms } = input as Record<string, unknown>;
    const waitMs = ms != null ? Math.max(0, Number(ms) || 0) : secondsToMs(seconds, 0);
    await waitDelay(waitMs, signal, { seconds: waitMs / 1000 });
    return { waitedSeconds: waitMs / 1000 };
  },
});

registerTool({
  name: "wait_until",
  get description() { return toolT("waitUntilDescription"); },
  get parameters() { return {
    type: "object",
    "x-disableCommonTimeout": true,
    properties: {
      until: {
        type: "string",
        minLength: 1,
        description: toolT("waitUntilUntil"),
      },
    },
    required: ["until"],
  } as const; },
  timeout: 0,
  execute: async ({ until }, signal) => {
    const requestedUntil = String(until || "").trim();
    const targetMs = parseWaitUntil(requestedUntil);
    if (targetMs === null || !Number.isFinite(targetMs)) {
      throw new ToolExecutionError("INVALID_WAIT_UNTIL", t("waitUntilRequiresAValidAbsoluteTimeWithAn"), {
        until: requestedUntil,
        expected: [
          "ISO 8601 with timezone, for example 2026-07-17T12:00:00+08:00",
          "YYYY-MM-DD HH:mm:ss (interpreted as Asia/Shanghai)",
        ],
      });
    }

    const startedAtMs = Date.now();
    const remainingMs = targetMs - startedAtMs;
    if (remainingMs > WAIT_MAX_DELAY_MS) {
      throw new ToolExecutionError("WAIT_UNTIL_TOO_FAR", t("waitUntilTargetMustBeWithin2HoursUse"), {
        until: requestedUntil,
        targetAt: formatBeijingDateTime(new Date(targetMs)),
        remainingSeconds: Math.ceil(remainingMs / 1000),
        maxWaitSeconds: WAIT_MAX_DELAY_MS / 1000,
      });
    }

    const details = {
      until: requestedUntil,
      targetAt: formatBeijingDateTime(new Date(targetMs)),
    };
    await waitUntilTime(targetMs, signal, details);
    const reachedAtMs = Date.now();
    return {
      mode: "absolute",
      until: requestedUntil,
      targetAt: details.targetAt,
      reachedAt: formatBeijingDateTime(new Date(reachedAtMs)),
      waitedSeconds: roundSeconds(reachedAtMs - startedAtMs),
      lateBySeconds: roundSeconds(reachedAtMs - targetMs),
      pastDue: remainingMs <= 0,
    };
  },
});

}


export default registerWaitTools satisfies ToolExtension;
