import { t } from "../../shared/i18n/backend.js";
import { toolError, isToolFailure } from "../../shared/contracts/tool-error.js";
import { copyToolResultPresentation, getToolResultPresentation, getToolResultTraces, traceMessages, toolFailurePresentation, type ToolResultPresentation } from "../../shared/contracts/tool-result-presentation.js";
import { scriptReceipt, SCRIPT_API_VERSION } from "../../shared/contracts/script-receipt.js";
import { driveToolText } from "./tool-messages.js";
import { createTranslator, getLanguage } from "../../shared/i18n/index.js";
import { contentMessages } from "../../shared/i18n/content.js";
import { normalizeDriveClientName } from "../../shared/session/session-store.js";
import type { ToolBatchTabPolicy, ToolModelPolicy } from "../../shared/contracts/tool.js";
import { planTabBatch } from "../tools/tab-batch.js";
import { scheduleToolCalls } from "../tools/tool-scheduler.js";

/** Same-session batch cap. The scheduler also refuses to run more than ten at once. */
export const DRIVE_MAX_CALLS = 10;
const DRIVE_IDLE_MS = 30 * 60 * 1000;

const FORBIDDEN = new Set([
  "ask_llm", "manage_sessions", "manage_settings", "manage_guardrails", "manage_skill_settings",
  "manage_goal", "example_echo",
  "qingzhou_call", "create_skill", "update_skill", "delete_skill", "manage_skill",
  "edit_skill_resource", "import_skill_from_page_zip", "import_git_skill_repository",
  "install_skill_to_git", "import_page_zip", "import_git_repository", "manage_bookmarks",
  "wait_for_user", "ask_user", "send_message", "use_tab", "get_working_tab", "run_skill_script",
]);

// The CLI script entry and local storage workflows remain callable but unlisted.
const DRIVE_UNLISTED_TOOLS = new Set(["run_script", "collect_images", "read_image_asset", "data_store"]);

export interface DriveCall { id: string; name: string; args: Record<string, unknown> }
export interface DriveImage { mimeType: string; data: string }
export interface DriveToolObservation {
  sessionId: string; runId: string; name: string; args: Record<string, unknown>; result: unknown; isError: boolean;
  toolCallId?: string; parentCallId?: string; parentSpanId?: string; phase?: "start" | "end"; startedExecution?: boolean;
  resultPresentation?: ToolResultPresentation;
}
type Fields = Record<string, unknown>;
type ModelPolicy = ToolModelPolicy | null | undefined;
export type DriveParse =
  | { ok: false; error: Error }
  | { ok: true; mode: "single"; name: string; timeoutSeconds: number | null; maxCalls: number }
  | { ok: true; mode: "batch"; calls: DriveCall[]; timeoutSeconds: number | null; maxCalls: number };

const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

function driveError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function driveGroupTitle(clientName: unknown) {
  return `${createTranslator(contentMessages)("brand")} · ${normalizeDriveClientName(clientName)}`;
}

function toolLocalName(name: string) {
  const separator = name.lastIndexOf("__");
  return separator >= 0 ? name.slice(separator + 2) : name;
}

/** True when direct drive must not call this tool. Matches the full name and the segment after the last "__". */
export function isDriveToolForbidden(name: string) {
  const local = toolLocalName(name);
  return FORBIDDEN.has(name) || FORBIDDEN.has(local) || name.startsWith("mcp_") || local.startsWith("mcp_");
}

/** Shared visibility policy for compact and named tool discovery. */
export function isDriveToolDiscoverable(name: string) {
  return !isDriveToolForbidden(name) && !DRIVE_UNLISTED_TOOLS.has(toolLocalName(name));
}

/** Page operations require an explicit reference; scripts and URL readers also support page-free calls. */
const PAGE_TAB_TOOLS = new Set([
  "navigate", "close_tab", "use_tab", "set_page_mode",
  "read_article", "read_dom", "find_elements", "inspect_element", "act_on_element", "scroll_page",
  "get_ax_tree",
  "read_console_messages", "network_watch", "network_recent", "network_body",
  "wait_for_response", "wait_for_network_idle", "wait_for_navigation", "wait_for_element", "wait_for_user",
  "screenshot", "act_on_screen", "list_images", "collect_images", "read_image",
  "run_script", "run_skill_script",
  "import_skill_from_page_zip", "import_git_skill_repository", "install_skill_to_git",
]);

function pageToolNeedsTabRef(name: string, args: Fields) {
  const local = toolLocalName(name);
  if (!PAGE_TAB_TOOLS.has(name) && !PAGE_TAB_TOOLS.has(local)) return false;
  if (local === "run_script") return false;
  if (local === "read_image" && String(args.url ?? "").trim()) return false;
  if (local === "collect_images" && Array.isArray(args.urls) && args.urls.some(url => String(url || "").trim())
    && !(Array.isArray(args.targets) && args.targets.some(target => String(target || "").trim()))) return false;
  return true;
}

/** Validate explicit page references before admitting a drive batch. */
export function prepareDriveToolCall(name: string, args: unknown): { ok: true; args: Fields } | { ok: false; error: Error } {
  const input = record(args);
  if (!pageToolNeedsTabRef(name, input)) return { ok: true, args: input };
  if (!Object.hasOwn(input, "tabRef")) {
    return { ok: false, error: Object.assign(driveError("TAB_REF_REQUIRED", t("toolError.TAB_REF_REQUIRED.message")), { hint: t("toolError.TAB_REF_REQUIRED.hint") }) };
  }
  const tabRef = typeof input.tabRef === "string" ? input.tabRef.trim() : input.tabRef;
  return { ok: true, args: { ...input, tabRef } };
}

/** One-line signature plus the first description line. Drive catalogs and tools.$list share this shape. */
export function driveToolSignature(tool: { name: string; description?: string; parameters?: unknown }) {
  if (isDriveToolForbidden(tool.name)) throw driveError("DRIVE_TOOL_FORBIDDEN", driveToolText("unavailable"));
  return toolSignature(tool);
}

export function toolSignature(tool: { name: string; description?: string; parameters?: unknown }) {
  const parameters = record(tool.parameters);
  const sourceProperties = record(parameters.properties);
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.map(item => String(item)) : []);
  const properties = sourceProperties;
  const signature = (fields: Fields, needed: Set<string>) => `${tool.name}({${Object.entries(fields).map(([key, spec]) => {
    const schema = record(spec);
    const type = Array.isArray(schema.enum)
      ? schema.enum.map(item => JSON.stringify(item)).join("|")
      : Array.isArray(schema.type)
        ? schema.type.filter(item => item !== "null").join("|") || "any"
        : typeof schema.type === "string" && schema.type ? schema.type : "any";
    return `${key}${needed.has(key) ? "" : "?"}:${type}`;
  }).join(", ")}})`;
  const variants = Array.isArray(parameters.anyOf) ? parameters.anyOf : [{}];
  const signatures = variants.map(variant => {
    const fields = record(variant);
    const needed = new Set([...required, ...(Array.isArray(fields.required) ? fields.required.map(String) : [])]);
    return signature(properties, needed);
  });
  return { name: tool.name, signature: [...new Set(signatures)].join(" | "),
    description: driveCatalogDescription(tool.description) };
}

/** The declaration owns public vocabulary; the catalog shows its first description line. */
function driveCatalogDescription(description: unknown) {
  return String(description || "").split("\n").map(item => item.trim()).find(Boolean)?.slice(0, 240) || "";
}

function positiveSeconds(value: unknown) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function callBudget(limits: unknown) {
  const requested = Number(record(limits).maxCalls);
  if (!Number.isFinite(requested)) return DRIVE_MAX_CALLS;
  if (!Number.isInteger(requested) || requested < 1 || requested > DRIVE_MAX_CALLS) {
    return { error: driveError("DRIVE_TOO_MANY_CALLS", t("drive.tooManyCalls", { limit: DRIVE_MAX_CALLS })) };
  }
  return requested;
}

/** Classify one execute_tool request. Forbidden names stop before any tool runs. */
export function parseDriveRequest(params: Fields = {}): DriveParse {
  const name = String(params.name || params.toolName || "").trim();
  const hasCalls = Array.isArray(params.calls);
  if (hasCalls && name) return { ok: false, error: driveError("DRIVE_ARGUMENTS", t("drive.nameOrCalls")) };
  if (params.calls != null && !hasCalls) return { ok: false, error: driveError("DRIVE_ARGUMENTS", t("drive.callShape")) };
  const budget = callBudget(params.limits);
  if (typeof budget !== "number") return { ok: false, error: budget.error };
  const timeoutSeconds = positiveSeconds(record(params.limits).timeoutSeconds);
  if (!hasCalls) {
    if (!name) return { ok: false, error: driveError("DRIVE_ARGUMENTS", "execute_tool requires name") };
    if (isDriveToolForbidden(name)) return { ok: false, error: driveError("DRIVE_TOOL_FORBIDDEN", driveToolText("unavailable")) };
    return { ok: true, mode: "single", name, timeoutSeconds, maxCalls: budget };
  }
  const calls: DriveCall[] = [];
  for (const item of params.calls as unknown[]) {
    const call = record(item);
    const id = String(call.id ?? "").trim();
    const callName = String(call.name ?? "").trim();
    if (!id || !callName || (call.args != null && (typeof call.args !== "object" || Array.isArray(call.args)))) {
      return { ok: false, error: driveError("DRIVE_ARGUMENTS", t("drive.callShape")) };
    }
    if (isDriveToolForbidden(callName)) {
      return { ok: false, error: driveError("DRIVE_TOOL_FORBIDDEN", driveToolText("unavailable")) };
    }
    calls.push({ id, name: callName, args: record(call.args) });
  }
  if (!calls.length) return { ok: false, error: driveError("DRIVE_ARGUMENTS", t("drive.callShape")) };
  if (calls.length > budget) return { ok: false, error: driveError("DRIVE_TOO_MANY_CALLS", t("drive.tooManyCalls", { limit: budget })) };
  return { ok: true, mode: "batch", calls, timeoutSeconds, maxCalls: budget };
}

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u;

/** Apply the declared model policy, separate screenshot bytes and bound the text result. */
export function projectDriveResult(result: unknown, policy: ModelPolicy = null, collected: ToolResultPresentation = {}): { value: unknown; images: DriveImage[] } {
  if (policy?.preserveResult && !isToolFailure(result)) return { value: result, images: [...({ ...getToolResultPresentation(result), ...collected }._images || [])] };
  let projected = result;
  try {
    if (policy?.projectResult) projected = policy.projectResult(result);
  } catch {
    projected = result;
  }
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) return { value: capDriveValue(projected), images: [] };
  const value = { ...(projected as Fields) };
  const images: DriveImage[] = [];
  const raw = value._image;
  delete value._image;
  delete value._imageDetail;
  if (typeof raw === "string") {
    const match = DATA_URL.exec(raw);
    if (match?.[1] && match[2]) images.push({ mimeType: match[1], data: match[2].replace(/\s+/gu, "") });
  }
  return { value: capDriveValue(value), images };
}

export const DRIVE_RESULT_CHAR_LIMIT = 48_000;

function capDriveValue(value: unknown): unknown {
  if (isToolFailure(value)) return value;
  let text = "";
  try { text = JSON.stringify(value) ?? ""; }
  catch { return value; }
  if (text.length <= DRIVE_RESULT_CHAR_LIMIT) return value;
  return {
    truncated: true,
    totalChars: text.length,
    limitChars: DRIVE_RESULT_CHAR_LIMIT,
    preview: text.slice(0, DRIVE_RESULT_CHAR_LIMIT),
  };
}

interface DriveOutcome {
  call: DriveCall;
  id: string;
  name: string;
  args: unknown;
  isError: boolean;
  result: unknown;
  resultPresentation?: ToolResultPresentation;
  projected?: { value: unknown; images: DriveImage[] };
}

/** Only host presentation, or an explicitly failed ToolError, supplies transport traces. */
export function getDriveToolTraces(result: unknown, collected: ToolResultPresentation = {}, isError = false): readonly string[] {
  const traces = getToolResultTraces(result, collected);
  if (traces.length || !isError) return traces;
  const error = record(result);
  return typeof error.code === "string" && typeof error.message === "string" ? traceMessages(record(error.details).trace) : [];
}

function failed(call: DriveCall, error: unknown, args: unknown = call.args, collected: ToolResultPresentation = {}): DriveOutcome {
  const err = record(error);
  const aborted = err.name === "AbortError" || err.name === "TimeoutError";
  const code = aborted ? "OPERATION_ABORTED" : String(err.code || "TOOL_EXECUTION_FAILED");
  const fallback = typeof err.message === "string" && err.message ? err.message : String(error);
  const message = fallback;
  return {
    call,
    id: call.id,
    name: call.name,
    args,
    isError: true,
    resultPresentation: toolFailurePresentation(error, collected),
    result: copyToolResultPresentation(error, toolError(code, message, { hint: typeof err.hint === "string" ? err.hint : undefined, details: err.details as Fields | undefined })),
  };
}

/** Run one calls batch through the same tab planner and scheduler the built-in agent uses. */
export async function runDriveCalls(calls: readonly DriveCall[], deps: {
  execute(name: string, args: unknown, signal: AbortSignal, context: Fields): Promise<unknown>;
  getBatchTabPolicy?(name: string, args: unknown): ToolBatchTabPolicy | null;
  getModelPolicy?(name: string): ModelPolicy;
  commitToolResult?(result: unknown, signal: AbortSignal, context: Fields): Promise<unknown>;
  discardToolResult?(result: unknown, context: Fields): Promise<unknown>;
  aliases?: Readonly<Record<string, number>>;
  context?: Fields;
  refreshContext?(context: Fields): Fields;
  onSettled?(call: { id: string; toolCallId: string; name: string; args: unknown; isError: boolean; result: unknown; rawResult: unknown; images: DriveImage[]; resultPresentation?: ToolResultPresentation }): void;
  signal: AbortSignal;
  maxInFlight?: number;
}) {
  const language = getLanguage();
  const canCommit = Boolean(deps.commitToolResult && deps.discardToolResult);
  const hostIds = new Map<DriveCall, string>(calls.map(call => [call, crypto.randomUUID()]));
  function publish(outcome: DriveOutcome) {
    if (outcome.projected) return outcome;
    const projected = projectDriveResult(outcome.result, deps.getModelPolicy?.(outcome.name) ?? null, outcome.resultPresentation);
    const published = { ...outcome, projected };
    deps.onSettled?.({
      id: published.id,
      toolCallId: hostIds.get(published.call)!,
      name: published.name,
      args: published.call.args,
      isError: published.isError,
      result: projected.value,
      rawResult: published.result,
      resultPresentation: published.resultPresentation,
      images: projected.images,
    });
    return published;
  }
  const blocked = new Map<DriveCall, DriveOutcome>();
  const plannedBySource = new Map<DriveCall, DriveCall>();
  const planned: DriveCall[] = [];
  for (const call of calls) {
    const ready = prepareDriveToolCall(call.name, call.args);
    if (!ready.ok) {
      blocked.set(call, failed(call, ready.error, call.args));
      continue;
    }
    const next = { ...call, args: ready.args };
    hostIds.set(next, hostIds.get(call)!);
    plannedBySource.set(call, next);
    planned.push(next);
  }
  const batch = planTabBatch(planned, call => {
    let policy = deps.getBatchTabPolicy?.(call.name, call.args) ?? null;
    if (policy?.kind === "create" && !policy.targeted && policy.parallel && !canCommit) policy = { ...policy, parallel: false };
    return { args: call.args, policy };
  }, language, deps.aliases || {});
  const settled = new Map<DriveCall, DriveOutcome>();
  await scheduleToolCalls<DriveCall, DriveOutcome>(batch.ordered, {
    signal: deps.signal,
    maxInFlight: deps.maxInFlight,
    dependencies: batch.dependencies,
    independent: batch.independent,
    lane: batch.lane,
    observer: batch.passive,
    orchestration: batch.orchestration,
    completed: (call, outcome) => batch.complete(call, outcome.result, outcome.isError),
    cancelled: call => failed(call, { message: t("agent.toolStopped"), code: "OPERATION_ABORTED" }, call.args),
    tab: call => {
      try { return batch.observation(call) ? Number(record(batch.args(call)).tabId) || null : null; }
      catch { return null; }
    },
    reject: (call, error) => failed(call, error, call.args),
    execute: async (call, callSignal, parallel, scope) => {
      let args: unknown = call.args;
      try { args = batch.args(call); }
      catch (error) { return failed(call, error, call.args); }
      const base: Fields = {
        ...(deps.context || {}),
        nestedToolScope: scope,
        toolCallId: hostIds.get(call), spanId: `tool:${hostIds.get(call)}`,
        preserveWorkingTab: batch.observation(call) === true,
        deferToolCommit: parallel,
        deferCreatedTabSelection: batch.parallelCreate(call) === true,
        createdTabResult: batch.executionParent(call),
      };
      const resultPresentation: ToolResultPresentation = {};
      const context = { ...(deps.refreshContext ? deps.refreshContext(base) : base), resultPresentation };
      try {
        const result = await deps.execute(call.name, args, callSignal, context);
        const isError = isToolFailure(result);
        return {
          call, id: call.id, name: call.name, args, result,
          resultPresentation: isError ? toolFailurePresentation(result, resultPresentation) : resultPresentation, isError,
        };
      } catch (error) {
        await deps.discardToolResult?.(undefined, context);
        return failed(call, error, args, resultPresentation);
      }
    },
    commit: async outcome => {
      let current = outcome;
      try {
        batch.assertDependenciesCommitted(outcome.call);
        if (!current.isError) await deps.commitToolResult?.(current.result, deps.signal, deps.context || {});
      } catch (error) {
        current = failed(outcome.call, error, outcome.args, outcome.resultPresentation);
      }
      await deps.discardToolResult?.(outcome.result, deps.context || {});
      batch.settle(outcome.call, current.result, current.isError);
      settled.set(outcome.call, publish(current));
    },
  });
  const results = calls.map(call => {
    const plannedCall = plannedBySource.get(call);
    const outcome = publish(blocked.get(call) || (plannedCall && settled.get(plannedCall)) || failed(call, { message: t("agent.toolStopped"), code: "OPERATION_ABORTED" }, call.args));
    const images = outcome.projected?.images || [];
    const traces = getDriveToolTraces(outcome.result, outcome.resultPresentation, outcome.isError);
    const format = deps.getModelPolicy?.(outcome.name)?.scriptResult;
    return {
      id: outcome.id,
      name: outcome.name,
      result: format ? scriptReceipt(outcome.result, { format, isError: outcome.isError, presentation: outcome.resultPresentation }) : outcome.projected?.value,
      isError: outcome.isError,
      ...(images.length ? { images } : {}),
      ...(format ? { scriptApiVersion: SCRIPT_API_VERSION } : traces.length ? { traces } : {}),
    };
  });
  return { results };
}

type DriveCoordinatorOptions = {
  idleMs?: number;
  stop?(sessionId: string, meta?: Fields): Promise<unknown> | unknown;
  getRuntime?(sessionId: string): Fields | null;
  setRuntime?(sessionId: string, patch: Fields): unknown;
  mintRunId?(sessionId: string): string;
  takeRunId?(sessionId: string): string;
};

let activeCoordinator: ReturnType<typeof createExternalDriveCoordinator> | null = null;

/** One in-flight batch per drive session. Idle close uses the same 30 minute window as the MCP HTTP session. */
export function createExternalDriveCoordinator({
  idleMs = DRIVE_IDLE_MS,
  stop,
  getRuntime,
  setRuntime,
  mintRunId,
  takeRunId,
}: DriveCoordinatorOptions = {}) {
  const busy = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const generation = new Map<string, number>();
  const active = new Map<string, number>();
  const ended = new Set<string>();
  const admissions = new Map<string, number>();

  function assertActive(sessionId: string) {
    const runtime = getRuntime?.(sessionId);
    const lastActivity = Number(runtime?.driveLastActivityAt);
    if (runtime?.status !== "aborted" && !ended.has(sessionId) && !active.has(sessionId)
      && lastActivity > 0 && Date.now() - lastActivity >= idleMs) {
      expire(sessionId, generationOf(sessionId));
    }
    if (ended.has(sessionId) || runtime?.status === "aborted") {
      throw driveError("DRIVE_SESSION_ENDED", t("drive.sessionEnded"));
    }
  }

  function generationOf(sessionId: string) {
    return generation.get(sessionId) || 0;
  }

  function clearIdle(sessionId: string) {
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
  }

  function touch(sessionId: string, token: number, lastActivity = Date.now()) {
    if (!sessionId || !stop) return;
    clearIdle(sessionId);
    const timer = setTimeout(() => expire(sessionId, token), Math.max(0, lastActivity + idleMs - Date.now()));
    (timer as unknown as { unref?: () => void }).unref?.();
    timers.set(sessionId, timer);
  }

  function expire(sessionId: string, token: number) {
    if (generationOf(sessionId) !== token || active.has(sessionId)) return;
    ended.add(sessionId);
    const driveRunId = takeRunId?.(sessionId) || "";
    invalidate(sessionId);
    void Promise.resolve(stop?.(sessionId, {
      source: "drive_idle", cascade: false, keepTabs: false, driveRunCaptured: true, driveRunId,
    })).catch(error => console.warn("[轻舟] idle drive cleanup failed:", error));
  }

  function invalidate(sessionId: string) {
    if (!sessionId) return;
    generation.set(sessionId, generationOf(sessionId) + 1);
    clearIdle(sessionId);
    busy.delete(sessionId);
    active.delete(sessionId);
    controllers.get(sessionId)?.abort(driveError("OPERATION_ABORTED", t("agent.toolStopped")));
    controllers.delete(sessionId);
  }

  const coordinator = {
    assertActive,
    protect(sessionId: string) {
      if (sessionId) admissions.set(sessionId, (admissions.get(sessionId) || 0) + 1);
      let released = false;
      return () => {
        if (released || !sessionId) return;
        released = true;
        const remaining = (admissions.get(sessionId) || 1) - 1;
        if (remaining > 0) admissions.set(sessionId, remaining);
        else admissions.delete(sessionId);
      };
    },
    retireForRetention(sessionId: string) {
      if (busy.has(sessionId) || admissions.has(sessionId)) return false;
      ended.add(sessionId);
      invalidate(sessionId);
      return true;
    },
    forget(sessionId: string) {
      invalidate(sessionId);
      ended.delete(sessionId);
      generation.delete(sessionId);
    },
    restore(sessionId: string, lastActivity: number) {
      if (busy.has(sessionId) || timers.has(sessionId) || ended.has(sessionId)) return;
      const runtime = getRuntime?.(sessionId);
      if (runtime?.status === "aborted") {
        ended.add(sessionId);
        if (![runtime.ownedTabIds, runtime.createdTabIds, runtime.driveHandoffTabIds].some(ids => Array.isArray(ids) && ids.length)) return;
        void Promise.resolve(stop?.(sessionId, { source: "drive_recovery", cascade: false,
          keepTabs: runtime.driveKeepTabs === true }))
          .catch(error => console.warn("[轻舟] stopped drive cleanup failed:", error));
        return;
      }
      setRuntime?.(sessionId, { driveLastActivityAt: lastActivity });
      if (Date.now() - lastActivity >= idleMs) expire(sessionId, generationOf(sessionId));
      else touch(sessionId, generationOf(sessionId), lastActivity);
    },
    isBusy(sessionId: string) { return busy.has(sessionId); },
    hasActiveLease(sessionId: string) { return active.has(sessionId); },
    begin(sessionId: string, signal?: AbortSignal) {
      assertActive(sessionId);
      if (sessionId && busy.has(sessionId)) throw driveError("DRIVE_SESSION_BUSY", t("drive.sessionBusy"));
      const token = sessionId ? generationOf(sessionId) : 0;
      if (sessionId) {
        busy.add(sessionId);
        active.set(sessionId, token);
        clearIdle(sessionId);
        setRuntime?.(sessionId, { driveLastActivityAt: Date.now() });
      }
      const controller = new AbortController();
      if (sessionId) controllers.set(sessionId, controller);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const driveRunId = sessionId && mintRunId ? String(mintRunId(sessionId) || "") : "";
      return {
        signal: combined,
        driveRunId,
        release() {
          signal?.removeEventListener("abort", onAbort);
          if (!sessionId || generationOf(sessionId) !== token || active.get(sessionId) !== token) return;
          busy.delete(sessionId);
          active.delete(sessionId);
          if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
          setRuntime?.(sessionId, { driveLastActivityAt: Date.now() });
          touch(sessionId, token);
        },
      };
    },
    abort(sessionId: string) {
      controllers.get(sessionId)?.abort(driveError("OPERATION_ABORTED", t("agent.toolStopped")));
    },
    markHandoff(sessionId: string, tabId: number) {
      const id = Number(tabId);
      if (!sessionId || !Number.isInteger(id) || id <= 0 || !setRuntime) return;
      const runtime = getRuntime?.(sessionId) || {};
      const current = Array.isArray(runtime.driveHandoffTabIds) ? runtime.driveHandoffTabIds.map(Number) : [];
      if (current.includes(id)) return;
      setRuntime(sessionId, { driveHandoffTabIds: [...current, id] });
    },
    noteStopped(sessionId: string, meta: Fields = {}) {
      if (!sessionId) return false;
      if (meta.source === "drive_idle" && active.has(sessionId)) return false;
      ended.add(sessionId);
      invalidate(sessionId);
      return true;
    },
  };
  activeCoordinator = coordinator;
  return coordinator;
}

export function noteExternalDriveStopped(sessionId: string, meta: Fields = {}) {
  if (!activeCoordinator) return true;
  return activeCoordinator.noteStopped(sessionId, meta);
}

export function protectExternalDriveSession(sessionId: string) {
  return activeCoordinator?.protect(sessionId) || (() => {});
}

export function forgetExternalDriveSession(sessionId: string) {
  activeCoordinator?.forget(sessionId);
}

/** True while a newer execute_tool lease owns this session. A late stop must not close its tabs. */
export function externalDriveLeaseActive(sessionId: string) {
  return Boolean(sessionId && activeCoordinator?.hasActiveLease(sessionId));
}
