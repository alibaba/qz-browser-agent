/** Chrome Web Store review prompt. Packaging does not emit a separate Firefox target,
 * so Firefox is rejected here at runtime together with the store-install check. */

export const CHROME_STORE_REVIEW_STORAGE_KEY = "qz_chrome_store_review";
export const CHROME_STORE_REVIEW_VERSION = 1;
export const CHROME_STORE_REVIEW_TASK_THRESHOLD = 5;
export const CHROME_WEB_STORE_REVIEWS_URL = "https://chromewebstore.google.com/detail/qz/dknbdgkgoinlgjpfebapkklbmjjgdblm/reviews";
export const CHROME_WEB_STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";

export type ChromeStoreReviewStatus = "hidden" | "visible" | "done";
export type ChromeStoreReviewResolution = "" | "dismissed" | "reviewed";
export type BrowserTarget = "chrome" | "firefox" | "other";

export interface ChromeStoreReviewRecord {
  version: number;
  completedRunIds: string[];
  status: ChromeStoreReviewStatus;
  sessionId: string;
  runId: string;
  resolution: ChromeStoreReviewResolution;
}

export interface InstallProbe {
  browser: BrowserTarget;
  installType: string;
  updateUrl: string;
}

export interface BrowserInstallEnvironment {
  protocol?: string;
  userAgent?: string;
  hasGetBrowserInfo?: boolean;
  getSelf?: () => Promise<{ installType?: string; updateUrl?: string } | null | undefined>;
}

const ID_LIMIT = 160;

export function emptyChromeStoreReviewRecord(): ChromeStoreReviewRecord {
  return {
    version: CHROME_STORE_REVIEW_VERSION,
    completedRunIds: [],
    status: "hidden",
    sessionId: "",
    runId: "",
    resolution: "",
  };
}

export function normalizeChromeStoreReviewRecord(value: unknown): ChromeStoreReviewRecord {
  const raw = record(value);
  if (raw.version !== CHROME_STORE_REVIEW_VERSION) return emptyChromeStoreReviewRecord();
  const completedRunIds = normalizeRunIds(raw.completedRunIds);
  const sessionId = clipId(raw.sessionId);
  const runId = clipId(raw.runId);
  const resolution = raw.resolution === "dismissed" || raw.resolution === "reviewed" ? raw.resolution : "";
  if (raw.status === "done") {
    return {
      version: CHROME_STORE_REVIEW_VERSION,
      completedRunIds,
      status: "done",
      sessionId,
      runId,
      resolution: resolution || "dismissed",
    };
  }
  if (raw.status === "visible" && sessionId && completedRunIds.length >= CHROME_STORE_REVIEW_TASK_THRESHOLD) {
    return {
      version: CHROME_STORE_REVIEW_VERSION,
      completedRunIds,
      status: "visible",
      sessionId,
      runId,
      resolution: "",
    };
  }
  return {
    ...emptyChromeStoreReviewRecord(),
    completedRunIds,
  };
}

/** Run id of a successful finish. A follow-up handoff can complete without a run id; then the session and end time name that finish. */
export function completedTaskRunKey(sessionId: unknown, runtime: { runId?: unknown; endedAt?: unknown } = {}): string {
  const runId = clipId(runtime.runId);
  if (runId) return runId;
  const endedAt = clipId(runtime.endedAt);
  const session = clipId(sessionId);
  return endedAt && session ? `${session}:${endedAt}` : "";
}

export function recordCompletedTask(
  value: unknown,
  input: { sessionId?: unknown; runId?: unknown; endedAt?: unknown } = {},
): { record: ChromeStoreReviewRecord; changed: boolean } {
  const current = normalizeChromeStoreReviewRecord(value);
  if (current.status !== "hidden") return { record: current, changed: false };
  const sessionId = clipId(input.sessionId);
  const runKey = completedTaskRunKey(sessionId, input);
  if (!sessionId || !runKey || current.completedRunIds.includes(runKey)) return { record: current, changed: false };
  const completedRunIds = [...current.completedRunIds, runKey];
  if (completedRunIds.length < CHROME_STORE_REVIEW_TASK_THRESHOLD) {
    return { record: { ...current, completedRunIds }, changed: true };
  }
  return {
    record: {
      ...current,
      completedRunIds: completedRunIds.slice(0, CHROME_STORE_REVIEW_TASK_THRESHOLD),
      status: "visible",
      sessionId,
      runId: runKey,
      resolution: "",
    },
    changed: true,
  };
}

export function finishChromeStoreReview(
  value: unknown,
  resolution: "dismissed" | "reviewed",
): { record: ChromeStoreReviewRecord; changed: boolean } {
  const current = normalizeChromeStoreReviewRecord(value);
  if (current.status === "done") return { record: current, changed: false };
  return {
    record: { ...current, status: "done", resolution },
    changed: true,
  };
}

export function isReviewCardPending(value: unknown, sessionId: unknown, hasTranscript: boolean): boolean {
  const current = normalizeChromeStoreReviewRecord(value);
  return hasTranscript
    && current.status === "visible"
    && current.completedRunIds.length >= CHROME_STORE_REVIEW_TASK_THRESHOLD
    && current.sessionId === clipId(sessionId);
}

export function classifyBrowserTarget(input: { protocol?: string; userAgent?: string; hasGetBrowserInfo?: boolean } = {}): BrowserTarget {
  const protocol = String(input.protocol || "").trim().toLowerCase();
  if (protocol === "moz-extension:" || input.hasGetBrowserInfo === true || /Firefox\//.test(String(input.userAgent || ""))) {
    return "firefox";
  }
  return protocol === "chrome-extension:" ? "chrome" : "other";
}

export function isChromeWebStoreUpdateUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:"
      && url.hostname === "clients2.google.com"
      && url.pathname.replace(/\/+$/, "") === "/service/update2/crx";
  } catch {
    return false;
  }
}

/** Store installs report installType "normal" and the Chrome Web Store update URL. Anything else stays closed. */
export function isChromeWebStoreInstall(probe: InstallProbe | null | undefined): boolean {
  if (!probe || probe.browser !== "chrome" || probe.installType !== "normal") return false;
  return isChromeWebStoreUpdateUrl(probe.updateUrl);
}

export function shouldShowChromeStoreReview(input: {
  record: unknown;
  sessionId: unknown;
  hasTranscript: boolean;
  install: InstallProbe | null | undefined;
}): boolean {
  return isReviewCardPending(input.record, input.sessionId, input.hasTranscript)
    && isChromeWebStoreInstall(input.install);
}

export async function readChromeWebStoreInstallProbe(env: BrowserInstallEnvironment = {}): Promise<InstallProbe> {
  const browser = classifyBrowserTarget(env);
  if (browser !== "chrome" || typeof env.getSelf !== "function") {
    return { browser: browser === "chrome" ? "other" : browser, installType: "", updateUrl: "" };
  }
  try {
    const info = await env.getSelf();
    return {
      browser: "chrome",
      installType: String(info?.installType || ""),
      updateUrl: String(info?.updateUrl || ""),
    };
  } catch {
    return { browser: "chrome", installType: "", updateUrl: "" };
  }
}

function normalizeRunIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const id = clipId(item);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= CHROME_STORE_REVIEW_TASK_THRESHOLD) break;
  }
  return ids;
}

function clipId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > ID_LIMIT ? text.slice(0, ID_LIMIT) : text;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
