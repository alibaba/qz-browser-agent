import { copyToolResultPresentation, type ToolResultPresentation } from "../../shared/contracts/tool-result-presentation.js";
import { isToolFailure, toolError } from "../../shared/contracts/tool-error.js";
import { type DriveToolObservation, isDriveToolForbidden, prepareDriveToolCall } from "../mcp/external-drive.js";
import { t } from "../../shared/i18n/backend.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { projectToolArtifacts } from "../../shared/tools/tool-artifacts.js";
import { positiveArtifactNumber as positiveNumber } from "../../shared/tools/artifact-projection.js";
import type { ToolContext, ToolOperationEvidence } from "../../sdk/background.js";
import { withToolOperationFailure } from "./tool-operation.js";
import { getToolCallParent } from "./call-lifecycle.js";
import { inheritScriptTrace, collectScriptResultTrace } from "./script-trace.js";
import type { RegisteredTool } from "./registry.js";
import type { ToolBatchTabPolicy, ToolBehavior, ToolModelPolicy } from "../../shared/contracts/tool.js";
import { toolBehaviorEnabled } from "./behavior.js";
import { createNestedToolScheduler, independentToolPolicy } from "./tool-scheduler.js";
import { tabReferenceId } from "../../shared/tab-reference.js";
import { tabReferenceError } from "./tab-reference.js";
type Fields = Record<string, unknown>;
interface RunScriptToolContext extends ToolContext { loadedPluginSkillNames?: unknown; skillToolRegistrySnapshot?: unknown }
interface BridgeHost {
  ready?(): Promise<unknown>;
  normalizeSessionId?(value: unknown): string;
  supervisor: { isRunCurrent(sessionId: string, runId: string): boolean; hasAgent(sessionId: string): boolean; getAbortSignal(sessionId: string, runId: string): AbortSignal | null | undefined };
  getRuntime(sessionId: string): Fields | null | undefined;
  loadedSkillNames?(sessionId: string): readonly string[];
  isTerminalRuntimeForRun?(runtime: Fields | null | undefined, runId: string): boolean;
  canManageSessions(sessionId: string): Promise<boolean>;
  buildRunProfile(input: { sessionId: string; canManageSessions: boolean | undefined; externalDrive: boolean }): Promise<NonNullable<ToolContext["runProfile"]>>;
  getRunToolContext?(sessionId: string, runId: string): Promise<RunScriptToolContext | null>;
  recordNestedTool?(input: DriveToolObservation & { externalDrive: boolean }): Promise<unknown>;
  applyNestedToolResult?(input: { sessionId: string; runId: string; toolName: string; args: Fields; result: unknown; isError: boolean }): Promise<unknown>;
  toolRuntime: {
    getSchemas(context: ToolContext): RegisteredTool["schema"][];
    resolveDefinition(name: string, options: { skillToolRegistrySnapshot?: unknown; toolRegistrySnapshot?: unknown; language?: string }): { behavior?: Readonly<ToolBehavior>; model?: Readonly<ToolModelPolicy> } | null;
    execute(name: string, args: unknown, signal: AbortSignal | undefined, context: ToolContext): Promise<unknown>;
    getTabAliases?(sessionId: string): Readonly<Record<string, number>>;
    getBatchTabPolicy?(name: string, args: unknown, context: ToolContext): ToolBatchTabPolicy | null;
    commitToolResult?(result: unknown, signal: AbortSignal, context: ToolContext): Promise<unknown>;
    discardToolResult?(result: unknown, context: ToolContext): Promise<unknown>;
    maxInFlight?: number;
  };
  collectArtifacts(name: string, args: Fields, result: unknown): Fields[];
  appendArtifacts?(input: { sessionId: string; runId: string; toolCallId: string; sourceTool: string; artifacts: Fields[] }): Promise<unknown>;
  scheduleArtifactRefresh?(sessionId: string, options: { action: string; touchSession: boolean; delay: number }): unknown;
  logger?: Pick<Console, "debug">;
}
interface BridgeSender { tab?: { id?: number } }
import {
  localizeToolFailureError,
  localizeToolFailurePayload,
} from "../../shared/tools/tool-error-localization.js";

export function createRunScriptArtifactCollector({ getToolIdentity }: { getToolIdentity(name: string): { capabilityId?: string } }) {
  if (typeof getToolIdentity !== "function") throw new TypeError("getToolIdentity is required");
  return (toolName = "", args: unknown = {}, result: unknown = {}) =>
    projectToolArtifacts(getToolIdentity(toolName).capabilityId || toolName, args, result, "resource");
}

export function createRunScriptBridge({
  ready = async () => {},
  normalizeSessionId = value => String(value || "").trim(),
  supervisor,
  getRuntime,
  loadedSkillNames = () => [],
  isTerminalRuntimeForRun,
  canManageSessions,
  buildRunProfile,
  getRunToolContext = async () => null,
  applyNestedToolResult = async () => false,
  recordNestedTool,
  toolRuntime,
  collectArtifacts,
  appendArtifacts = async () => {},
  scheduleArtifactRefresh = () => {},
  logger = console,
}: BridgeHost) {
  if (!supervisor || typeof supervisor.isRunCurrent !== "function") throw new TypeError("supervisor is required");
  if (typeof getRuntime !== "function") throw new TypeError("getRuntime is required");
  if (typeof canManageSessions !== "function") throw new TypeError("canManageSessions is required");
  if (typeof buildRunProfile !== "function") throw new TypeError("buildRunProfile is required");
  if (!toolRuntime || typeof toolRuntime.execute !== "function") throw new TypeError("toolRuntime is required");
  if (typeof toolRuntime.resolveDefinition !== "function") throw new TypeError("toolRuntime.resolveDefinition is required");
  if (typeof collectArtifacts !== "function") throw new TypeError("collectArtifacts is required");
  const schedulers = new Map<string, ReturnType<typeof createNestedToolScheduler>>();

  async function handleToolCall(message: Fields = {}, sender: BridgeSender = {}, invocationSignal?: AbortSignal, operation?: ToolOperationEvidence): Promise<Fields> {
    // The old transport spelling is a hidden alias for the registered catalog tool.
    if (message.toolName === "__list_tools__") message = { ...message, toolName: "list_tools" };
    let rawResult: unknown, resultPresentation: ToolResultPresentation | undefined, observed = false, externalDrive = false;
    const sessionId = normalizeSessionId(message.sessionId), runId = String(message.runId || "").trim();
    const name = String(message.toolName || "").trim(), toolCallId = crypto.randomUUID();
    const parent = getToolCallParent(message.parentCallId, sessionId, runId);
    const parentCallId = parent?.toolCallId || parent?.toolExecutionId;
    const parentSpanId = typeof parent?.spanId === "string" ? parent.spanId : parentCallId ? `tool:${parentCallId}` : undefined;
    let started = false;
    const record = async (phase: "start" | "end", result: unknown, isError: boolean, startedExecution?: boolean) => {
      try { await recordNestedTool?.({ sessionId, runId, name, toolCallId, parentCallId, parentSpanId, phase, externalDrive,
        args: plainObject(message.args), result, isError, startedExecution,
        resultPresentation }); }
      catch (error) { logger.debug("[轻舟] persist nested tool failed:", error instanceof Error ? error.message : error); }
    };
    const start = async (startedExecution: boolean) => {
      if (started || !name || !supervisor.isRunCurrent(sessionId, runId)) return;
      if (message.parentCallId !== undefined && !getToolCallParent(message.parentCallId, sessionId, runId)) return;
      started = true;
      await record("start", undefined, false, startedExecution);
    };
    const response = await executeToolCall(message, sender, (result, presentation) => {
      rawResult = result; resultPresentation = presentation; observed = true;
    }, mode => { externalDrive = mode; }, invocationSignal, toolCallId, start, operation);
    if (name && supervisor.isRunCurrent(sessionId, runId)
      && (started || plainObject(response).code !== "RUN_STOPPED")
      && (started || message.parentCallId === undefined || getToolCallParent(message.parentCallId, sessionId, runId))) {
      await start(false);
      await record("end", observed && response.isError !== true ? rawResult : response.result ?? response, response.isError === true);
    }
    return { ...response, toolCallId };
  }

  async function executeToolCall(message: Fields, sender: BridgeSender, observe: (result: unknown, presentation?: ToolResultPresentation) => void, observeMode: (externalDrive: boolean) => void, invocationSignal: AbortSignal | undefined, toolCallId: string, start: (executed: boolean) => Promise<void>, operation?: ToolOperationEvidence) {
    await ready();
    let language = getLanguage();
    const respondFailure = (payload: unknown, options: { toolName?: string } = {}) =>
      withLanguage(language, () => failureResponse(withToolOperationFailure(payload, operation), options));
    const toolName = String(message.toolName || "").trim();
    if (!toolName) {
      return respondFailure({
        error: "run_script tool bridge requires toolName",
        code: "MISSING_TOOL_NAME",
        details: {},
      }, { toolName: "run_script" });
    }

    const sessionId = normalizeSessionId(message.sessionId);
    const runId = String(message.runId || "").trim();
    // Current script transports always include a parent ID. Legacy direct host
    // calls without the field retain their run-scoped cancellation contract.
    const parent = getToolCallParent(message.parentCallId, sessionId, runId);
    const runSignal = supervisor.getAbortSignal(sessionId, runId);
    const parentSignal = message.parentCallId !== undefined && !parent ? AbortSignal.abort()
      : parent?.signal && runSignal ? AbortSignal.any([parent.signal, runSignal]) : parent?.signal || runSignal || undefined;
    const signal = invocationSignal && parentSignal ? AbortSignal.any([invocationSignal, parentSignal]) : invocationSignal || parentSignal;
    const stoppedError = stoppedBridgeError(sessionId, runId, toolName, signal);
    if (stoppedError) return respondFailure(stoppedError, { toolName });
    try {
      const toolContext = await resolveToolContext(sessionId, runId, parent, observeMode);
      language = toolContext.language || language;
      const contextStopped = stoppedBridgeError(sessionId, runId, toolName, signal);
      if (contextStopped) return respondFailure(contextStopped, { toolName });
      const driveRun = toolContext.externalDrive === true;
      if (driveRun && isDriveToolForbidden(toolName)) {
        return respondFailure({
          error: t("drive.toolForbidden", { name: toolName }),
          code: "DRIVE_TOOL_FORBIDDEN",
          details: { tool: toolName, status: "not_started", executed: false,
            mayHaveTakenEffect: false, automaticReplay: false },
        }, { toolName });
      }

      const depth = Math.max(0, Math.floor(Number(message.depth) || 0));
      if (depth > 3) {
        return respondFailure({
          error: `run_script nested tool call depth exceeded while calling ${toolName}`,
          code: "RUN_SCRIPT_TOOL_DEPTH_EXCEEDED",
          details: { toolName, depth, maxDepth: 3 },
        }, { toolName });
      }

      let toolArgs = plainObject(message.args);
      if (driveRun) {
        const prepared = prepareDriveToolCall(toolName, toolArgs);
        if (!prepared.ok) {
          return respondFailure(prepared.error, { toolName });
        }
        toolArgs = prepared.args;
      }
      const key = JSON.stringify([sessionId, runId]);
      let scheduler = schedulers.get(key);
      if (!scheduler) { scheduler = createNestedToolScheduler(toolRuntime.maxInFlight); schedulers.set(key, scheduler); }
      const policy = toolRuntime.getBatchTabPolicy?.(toolName, toolArgs, toolContext);
      const staged = policy?.kind !== "script" && Boolean(toolRuntime.commitToolResult && toolRuntime.discardToolResult)
        && independentToolPolicy(policy, toolArgs.tabId != null || Object.hasOwn(toolArgs, "tabRef"));
      const aliases = toolRuntime.getTabAliases?.(sessionId) || {};
      const ref = policy?.kind === "script" ? undefined : toolArgs.tabRef;
      const lane = policy?.kind === "target" && policy.tabId != null ? policy.tabId
        : policy?.kind === "create" && !policy.targeted ? typeof toolArgs.tabAlias === "string" && !Object.hasOwn(aliases, toolArgs.tabAlias) ? `alias:${toolArgs.tabAlias}` : `create:${crypto.randomUUID()}`
        : policy?.kind === "script" ? null : tabReferenceId(ref) ?? (typeof ref === "string" ? aliases[ref] ?? `alias:${ref}` : Number(toolArgs.tabId) || null);
      let definition: ReturnType<BridgeHost["toolRuntime"]["resolveDefinition"]>;
      let executionResult: unknown;
      let executionContext: ToolContext = toolContext;
      try { return await scheduler.run<unknown>({
        parent: parent?.nestedToolScope,
        group: String(message.parentCallId || "legacy"),
        // Pending aliases acquire their physical page lane when the creator commits.
        lane: () => typeof ref === "string" && lane === `alias:${ref}`
          ? toolRuntime.getTabAliases?.(sessionId)?.[ref] ?? lane : lane,
        produces: policy?.kind === "create" && typeof toolArgs.tabAlias === "string" && !Object.hasOwn(aliases, toolArgs.tabAlias) ? toolArgs.tabAlias : undefined,
        targetAlias: typeof ref === "string" && tabReferenceId(ref) === null && !Object.hasOwn(aliases, ref) ? ref : undefined,
        dependencyFailure: () => tabReferenceError("dependency_failed", ref, language), isError: isToolFailure,
        policy, explicit: toolArgs.tabId != null || Object.hasOwn(toolArgs, "tabRef"), signal,
        execute: async scope => {
          const current = await resolveToolContext(sessionId, runId, parent, observeMode);
          const stopped = stoppedBridgeError(sessionId, runId, toolName, signal);
          if (stopped) return stopped;
          definition = toolRuntime.resolveDefinition(toolName, { skillToolRegistrySnapshot: current.skillToolRegistrySnapshot, toolRegistrySnapshot: current.toolRegistrySnapshot, language: current.language });
          executionContext = {
            ...current, operation, sessionId, runId, toolCallId, spanId: `tool:${toolCallId}`, nestedToolScope: scope, runScriptToolDepth: depth,
            resultPresentation: {},
            deferToolCommit: staged, deferCreatedTabSelection: staged && policy?.kind === "create" && !policy.targeted,
            preserveWorkingTab: policy?.kind === "observe" || policy?.kind === "target" && policy.observation,
            source: "run_script", senderTabId: sender?.tab?.id || null,
          };
          inheritScriptTrace(parent, executionContext);
          await start(true);
          return executionResult = await toolRuntime.execute(toolName, toolArgs, signal, executionContext);
        },
        commit: async result => {
          // A host or zero-timeout handler may complete after its run was revoked.
          const executionStopped = stoppedBridgeError(sessionId, runId, toolName, signal);
          if (executionStopped) return respondFailure(executionStopped, { toolName });
          const isError = isToolFailure(result);
          if (!isError && staged) await toolRuntime.commitToolResult?.(result, signal || new AbortController().signal, executionContext);
          await applyNestedToolResult({ sessionId, runId, toolName, args: toolArgs, result, isError });
          const resultStopped = stoppedBridgeError(sessionId, runId, toolName, signal);
          if (resultStopped) return respondFailure(resultStopped, { toolName });
          observe(result, executionContext.resultPresentation);
          if (isError) {
            return respondFailure(result, { toolName });
          }

          const artifacts = collectArtifacts(toolName, toolArgs, result);
          if (artifacts.length) {
            try {
              await appendArtifacts({
                sessionId,
                runId,
                toolCallId: "",
                sourceTool: toolName,
                artifacts,
              });
              scheduleArtifactRefresh(sessionId, { action: "artifacts", touchSession: true, delay: 400 });
            } catch (error) {
              logger?.debug?.("[轻舟] record run_script resource artifacts failed:", error instanceof Error ? error.message : error);
            }
          }
          const modelResult = definition?.model?.projectResult ? definition.model.projectResult(result) : result;
          const observation = nestedObservation(definition?.behavior, toolArgs, result);
          return {
            ok: true,
            result: omitObservationImage(modelResult, Boolean(observation)),
            ...(definition?.model?.scriptResult === "receipt" ? { resultFormat: "receipt" } : {}),
            ...(observation ? { observation } : {}),
            artifacts,
            isError: false,
          };
        },
      }) as Fields; }
      finally {
        collectScriptResultTrace(parent, executionContext);
        await toolRuntime.discardToolResult?.(executionResult, executionContext);
        if (!scheduler.pending && schedulers.get(key) === scheduler) schedulers.delete(key);
      }
    } catch (error) {
      const stopped = stoppedBridgeError(sessionId, runId, toolName, signal);
      if (stopped) return respondFailure(stopped, { toolName });
      const failure = plainObject(error);
      const localized = plainObject(withLanguage(language, () => localizeToolFailureError(error, {
        toolName,
        code: failure.code || "RUN_SCRIPT_TOOL_CALL_FAILED",
      })));
      return respondFailure(copyToolResultPresentation(error, {
        error: localized?.message || String(localized || error),
        code: localized?.code || failure.code || "RUN_SCRIPT_TOOL_CALL_FAILED",
        hint: localized.hint || failure.hint,
        details: localized?.details || failure.details || { toolName },
      }), { toolName });
    }
  }

  async function resolveToolContext(sessionId: string, runId: string, parent: ToolContext | undefined, observeMode: (externalDrive: boolean) => void): Promise<ToolContext> {
    const runtime = plainObject(getRuntime(sessionId));
    const runContext = { ...parent, ...await getRunToolContext(sessionId, runId) };
    const externalDrive = (parent?.externalDrive ?? runContext.externalDrive) === true;
    observeMode(externalDrive);
    const snapshotContext = plainObject(runContext.dynamicContext);
    const dynamicContext = {
      ...snapshotContext,
      taskSiteTabs: Array.isArray(runtime.visitedTaskSites)
        ? runtime.visitedTaskSites.map(pageTab).filter(value => value !== null)
        : (Array.isArray(snapshotContext.taskSiteTabs) ? snapshotContext.taskSiteTabs.map(pageTab).filter(value => value !== null) : []),
    };
    const canManage = runContext.runProfile ? undefined : await canManageSessions(sessionId);
    return {
      nestedToolScope: parent?.nestedToolScope,
      deadlineAt: parent?.deadlineAt,
      externalDrive,
      sourceWindowId: positiveNumber(snapshotContext.sourceWindowId) || null,
      dynamicContext,
      // Read per call: a nested load_skill records its names before its result reaches the script.
      loadedPluginSkillNames: mergeStringLists(
        runContext.loadedPluginSkillNames,
        loadedSkillNames(sessionId),
      ),
      runProfile: runContext.runProfile || await buildRunProfile({ sessionId, canManageSessions: canManage, externalDrive }),
      skillToolRegistrySnapshot: runContext.skillToolRegistrySnapshot || null,
      toolRegistrySnapshot: runContext.toolRegistrySnapshot, language: runContext.language,
    };
  }

  function stoppedBridgeError(sessionId: string, runId: string, toolName: string, signal?: AbortSignal) {
    const runtime = getRuntime(sessionId);
    const stopped = signal?.aborted || (runId
      ? !supervisor.isRunCurrent(sessionId, runId)
      : (!supervisor.hasAgent(sessionId) && isTerminalRuntimeForRun?.(runtime, "")));
    if (!stopped) return null;
    return localizeToolFailurePayload({
      ok: false,
      error: t("browser.runScriptStopped"),
      code: "RUN_STOPPED",
      details: { sessionId, runId, toolName, runtimeStatus: runtime?.status || "" },
    }, { toolName });
  }

  async function invokeTool(parent: ToolContext, name: string, args: Fields, signal?: AbortSignal) {
    const senderId = Number(parent.senderTabId);
    const response = await handleToolCall({ toolName: name, args, sessionId: parent.sessionId, runId: parent.runId,
      parentCallId: parent.toolExecutionId || "", depth: Math.max(0, Number(parent.runScriptToolDepth) || 0) + 1,
    }, senderId > 0 ? { tab: { id: senderId } } : {}, signal, parent.operation);
    if (response.ok !== true) throw response.result || response;
    return response.result;
  }
  return Object.freeze({ handleToolCall, invokeTool });
}

function omitObservationImage(result: unknown, stripImage = false) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (!stripImage) return result;
  const { _image, _imageDetail, ...withoutImage } = plainObject(result);
  return withoutImage;
}

function nestedObservation(behavior: Readonly<ToolBehavior> | undefined, args: Fields = {}, result: unknown = {}) {
  const output = plainObject(result);
  if (!toolBehaviorEnabled(behavior?.nestedObservation, args) || typeof output._image !== "string" || !output._image) return null;
  return {
    _image: output._image,
    ...(output._imageDetail ? { _imageDetail: output._imageDetail } : {}),
  };
}

function failureResponse(payload: unknown, { toolName = "" } = {}) {
  const input = plainObject(payload, { error: String(payload || "run_script tool bridge failed") });
  const localized = plainObject(localizeToolFailurePayload({
    ...input,
    ok: false,
    code: input.code || "RUN_SCRIPT_TOOL_CALL_FAILED",
  }, {
    toolName,
    code: input.code || "RUN_SCRIPT_TOOL_CALL_FAILED",
    isError: true,
  }));
  const failure = copyToolResultPresentation(payload, toolError(String(localized.code || input.code || "RUN_SCRIPT_TOOL_CALL_FAILED"),
    String(localized.message || localized.error || input.message || input.error || "Script tool call failed."), {
      hint: typeof localized.hint === "string" ? localized.hint : typeof input.hint === "string" ? input.hint : undefined,
      details: plainObject(localized.details || input.details),
    }));
  return { ok: false, ...failure, result: failure, isError: true };

}

function plainObject(value: unknown, fallback?: Fields): Fields;
function plainObject(value: unknown, fallback: null): Fields | null;
function plainObject(value: unknown, fallback: Fields | null = {}): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : fallback;
}

function mergeStringLists(...values: unknown[]) {
  const out = new Set<string>();
  for (const value of values) {
    const items = value instanceof Set ? [...value] : (Array.isArray(value) ? value : []);
    for (const item of items) {
      const text = String(item || "").trim().toLowerCase();
      if (text) out.add(text);
    }
  }
  return [...out];
}

function pageTab(value: unknown): (Fields & { url: string }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tab = plainObject(value);
  return { ...tab, url: String(tab.url || "") };
}
