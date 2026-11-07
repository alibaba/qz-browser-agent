import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
declare const SCRIPT_RUNTIME_SOURCE: string;
import type { ToolContext } from "#sdk/background";
import type { ToolParameter } from "#sdk/shared/metadata";
import type { SecurityGuardrails } from "#sdk/shared/security";
type Fields = Record<string, unknown>;
type Guardrails = { rules?: readonly Pick<SecurityGuardrails["rules"][number], "action" | "type" | "value">[] };
type ScriptHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "evaluateCdpScript" | "skills"> & Partial<Pick<ToolExtensionAPI, "getToolRuntimeDependencies">> & { scriptTimeoutProperty: ToolParameter };
interface ScriptOptions { tabId?: number; sessionId?: string; runId?: string; parentCallId?: string; depth?: number; reason?: string; scriptArgs?: unknown; strictResult?: boolean; securityGuardrails?: Guardrails }
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorCode = (error: unknown) => String(record(error).code || "");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(record(error).message || error || "");
import { publishTimeoutTrace, beginScriptTrace, acceptScriptTrace, scriptTimeout, orchestrationTimeout, toolError, markToolValue, bindToolResultPresentation } from "#sdk/background/tools";
import { ensureOffscreenDocument, waitForParsedDocument, waitForPageCommit } from "#sdk/background/browser";
import { wrapRunScriptSource, isRunScriptCallableExpression } from "#sdk/shared/browser";
import { getSecurityGuardrails } from "#sdk/shared/security";
import {
  isRunScriptInnerTargetArgs,
  resolveRunScriptTargetTabId,
} from "#sdk/background/browser";

/** Owns page/inner script queues, bridges, and run_script tool registration. */
export function createScriptTools({
  registerTool,
  ToolExecutionError,
  scriptTimeoutProperty: SCRIPT_TIMEOUT_SECONDS_PROPERTY,
  evaluateCdpScript,
  skills: { loadScript: loadSkillScript },
  getToolRuntimeDependencies = () => ({}),
}: ScriptHost) {
// ===========================================================================
// Execute JavaScript in the page.
// ===========================================================================

const MAX_SCRIPT_TRACE_ENTRIES = 80;
const MAX_SCRIPT_TRACE_CHARS = 12000;
let runScriptOffscreenSetupPromise: Promise<boolean> | null = null;
const getRunScriptDescription = () => (toolT("runScriptDescription"));

function formatCdpScriptResult(input: unknown, engine = "cdp"): Fields {
  const evalResult = record(input);
  const exception = record(evalResult.exceptionDetails);
  if (evalResult?.exceptionDetails) {
    const errMsg = record(exception.exception).description
      || record(exception.exception).value
      || exception.text
      || "Script evaluation failed";
    return {
      ok: false,
      hasResult: false,
      result: null,
      error: String(errMsg),
      code: "SCRIPT_EVALUATION_FAILED",
      execution_world: "page",
      details: {
        engine,
        execution_world: "page",
        lineNumber: exception.lineNumber,
        columnNumber: exception.columnNumber,
      },
    };
  }

  const value = record(evalResult.result);
  if (value.value && typeof value.value === "object" && record(value.value).__runScriptEnvelope === true) {
    return compactRunScriptEnvelope(record(value.value), engine);
  }
  const resultType = value.subtype || value.type || "unknown";
  if (value.type === "undefined") {
    return {
      ok: true,
      hasResult: false,
      result: null,
      resultType: "undefined",
      engine,
      execution_world: "page",
      message: "Script completed successfully but returned undefined.",
    };
  }

  if (value.subtype === "null") {
    return { ok: true, hasResult: true, result: null, resultType: "null", engine, execution_world: "page" };
  }

  let result;
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    result = value.value;
  } else if (value.unserializableValue != null) {
    result = String(value.unserializableValue);
  } else if (value.description) {
    result = value.description;
  } else if (value.preview) {
    result = record(value.preview).description || JSON.stringify(value.preview);
  } else {
    result = null;
  }

  return {
    ok: true,
    hasResult: true,
    result,
    resultType,
    engine,
    execution_world: "page",
    description: value.description || undefined,
  };
}

function compactRunScriptEnvelope(envelope: Fields, engine = "cdp") {
  const out = { ...envelope };
  delete out.__runScriptEnvelope;
  const lastObservation = normalizeRunScriptObservation(out.__lastObservation);
  delete out.__lastObservation;
  out.engine = out.engine || engine;
  out.execution_world = out.execution_world || (String(out.engine || engine).includes("inner") ? "inner" : "page");
  out.trace = compactScriptTrace(out.trace);
  return lastObservation ? { ...out, ...lastObservation } : out;
}

function normalizeRunScriptObservation(input: unknown) {
  const value = record(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const image = String(value._image || "");
  if (!/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(image)) return null;
  return {
    _image: image,
    ...(value._imageDetail ? { _imageDetail: String(value._imageDetail) } : {}),
  };
}

function compactScriptTrace(trace: unknown) {
  const rows: unknown[] = Array.isArray(trace) ? trace : [];
  let totalChars = 0;
  const clipped = [];
  for (const row of rows.slice(-MAX_SCRIPT_TRACE_ENTRIES)) {
    const item = row && typeof row === "object" ? record(row) : { message: String(row ?? "") };
    const message = String(item.message || item.text || "");
    totalChars += message.length;
    if (totalChars > MAX_SCRIPT_TRACE_CHARS) {
      clipped.push({
        level: "trace",
        message: `[trace truncated: ${rows.length - clipped.length} earlier/overflow entries omitted]`,
      });
      break;
    }
    clipped.push({
      time: item.time || "",
      level: item.level || "trace",
      message,
    });
  }
  return clipped;
}



function compactRunScriptSecurityGuardrails(guardrails: Guardrails = {}): Guardrails {
  return {
    rules: (Array.isArray(guardrails.rules) ? guardrails.rules : [])
      .map((rule): Pick<SecurityGuardrails["rules"][number], "action" | "type" | "value"> => ({
        action: rule.action === "allow" ? "allow" : "block",
        type: rule.type === "pattern" ? "pattern" : "domain",
        value: String(rule.value || "").trim(),
      }))
      .filter(rule => rule.value),
  };
}


function normalizeRunScriptTarget(value: unknown) {
  const target = String(value || "page").trim().toLowerCase();
  if (!target || target === "page") return "page";
  if (target === "inner") return "inner";
  throw new ToolExecutionError("SCRIPT_REQUEST_INVALID", "The script execution request is invalid.");
}

function makeRunScriptTargetRequiredError({ skill, script }: { code?: unknown; skill?: unknown; script?: unknown; context?: ToolContext } = {}) {
  return new ToolExecutionError("TAB_REF_REQUIRED", "The page reference tabRef is missing.", {
    ...(skill ? { skill: String(skill) } : {}), ...(script ? { script: String(script) } : {}),
  });
}

registerTool({
  name: "run_skill_script",
  behavior: { barrier: true, mayOpenPopup: true, timeoutResult: { kind: "action", pending: "script outcome confirmation" } },
  requires: { tools: ["run_script"], pageScript: args => !isRunScriptInnerTargetArgs(args) },
  effects: args => args.mutatesPage === true ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("runSkillScriptDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      timeout: SCRIPT_TIMEOUT_SECONDS_PROPERTY,
      target: { type: "string", enum: ["page", "inner"], description: toolT("runSkillScriptTarget") },
      tabRef: { type: ["integer", "string"], description: toolT("runSkillScriptTabId") },
      skill: { type: "string", description: toolT("runSkillScriptSkill") },
      script: { type: "string", description: toolT("runSkillScriptScript") },
      args: { type: "object", description: toolT("runSkillScriptArgs") },
      mutatesPage: { type: "boolean", description: toolT("runSkillScriptMutatesPage") },
    },
    required: ["timeout", "skill", "script"],
  } as const; },
  hidden: true,
  page: args => isRunScriptInnerTargetArgs(args) ? false : "owned",
  timeout: scriptTimeout,
  validateArgs: args => { scriptTimeout(args, "run_skill_script"); },
  execute: async ({ target, tabId, skill, script, args = {} }, signal, context = {}) => {
    if (!String(skill || "").trim() || !String(script || "").trim()) {
      throw new ToolExecutionError("INVALID_RUN_SKILL_SCRIPT_INPUT", "run_skill_script requires both skill and script", { skill, script });
    }
    const executionTarget = normalizeRunScriptTarget(target);
    const scriptArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const securityGuardrails = compactRunScriptSecurityGuardrails(await getSecurityGuardrails());
    const code = (await loadSkillScript(skill, script, context.language)) || "";
    if (executionTarget === "inner") {
      return describeScriptExecution(record(await runScriptWithOffscreenInnerRunner(code, context, "skill_script", scriptArgs, securityGuardrails, signal)));
    }
    const resolvedTabId = resolveRunScriptTargetTabId(tabId);
    if (!resolvedTabId) throw makeRunScriptTargetRequiredError({ skill, script, context });
    return describeScriptExecution(record(await runScriptWithCdpToolBridge(resolvedTabId, code, context, "skill_script", scriptArgs, securityGuardrails, signal)));
  },
});

registerTool({
  name: "run_script",
  behavior: { orchestration: true, timeoutResult: { kind: "action", pending: "script outcome confirmation" } },
  model: { preserveResult: true, scriptResult: "value" },
  get description() { return getRunScriptDescription(); },
  get parameters() { return {
    type: "object",
    properties: {
      timeout: SCRIPT_TIMEOUT_SECONDS_PROPERTY,
      args: { description: toolT("runScriptArgs") },
      code: { type: "string", description: toolT("runScriptCode") },
    },
    required: ["code"],
  } as const; },
  page: false,
  timeout: orchestrationTimeout,
  validateArgs: args => {
    if (args.tabRef != null || args.tabId != null) throw new ToolExecutionError("INVALID_RUN_SCRIPT_INPUT",
      "run_script executes outside the page and does not accept a page reference.");
    orchestrationTimeout(args, "run_script");
  },
  execute: async (input, signal, context = {}) => {
    if (context.requestedTabRef != null) throw new ToolExecutionError("INVALID_RUN_SCRIPT_INPUT",
      "run_script executes outside the page and does not accept a page reference.");
    const { code, args = {} } = input;
    const { skill, script } = input as typeof input & { skill?: unknown; script?: unknown };
    const hasInlineCode = String(code || "").trim().length > 0;
    const hasSkillScript = String(skill || "").trim() || String(script || "").trim();
    if (hasSkillScript) {
      throw new ToolExecutionError("INVALID_RUN_SCRIPT_INPUT", "run_script only accepts inline code; skill scripts must be invoked through their Skill tools", {
        hasCode: hasInlineCode,
        skill,
        script,
      });
    }
    if (!hasInlineCode) {
      throw new ToolExecutionError("INVALID_RUN_SCRIPT_INPUT", "run_script requires inline code", {});
    }
    const securityGuardrails = compactRunScriptSecurityGuardrails(await getSecurityGuardrails());
    return scriptExecutionValue(record(await runScriptWithOffscreenInnerRunner(code, context, "orchestration", args, securityGuardrails, signal)),
      context, context.skillExecution?.resultMode === "receipt");
  },
});

registerTool({
  name: "evaluate",
  requires: { pageScript: true },
  behavior: { parallelTab: true, mayOpenPopup: true, reportsExecution: true, timeoutResult: { kind: "action", pending: "page evaluation outcome confirmation" } },
  model: { preserveResult: true, scriptResult: "value" },
  effects: () => [{ type: "context.siteChanged" }],
  get description() { return toolT("evaluateDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabRef: { type: ["integer", "string"], description: toolT("runSkillScriptTabId") },
      code: { type: "string", description: toolT("evaluateCode") },
      args: { description: toolT("evaluateArgs") },
      waitUntil: { type: "string", enum: ["commit", "domcontentloaded"], description: toolT("evaluateWaitUntil") },
      timeout: SCRIPT_TIMEOUT_SECONDS_PROPERTY,
    },
    required: ["tabRef", "code"],
  } as const; },
  page: "owned",
  timeout: orchestrationTimeout,
  validateArgs: args => {
    if (!isRunScriptCallableExpression(String(args.code || ""))) throw new ToolExecutionError(
      "INVALID_SCRIPT_FUNCTION", "evaluate code is not a function expression.");
  },
  execute: async ({ tabId, code, args, waitUntil = "domcontentloaded" }, signal, context = {}) => {
    const resolvedTabId = resolveRunScriptTargetTabId(tabId);
    if (!resolvedTabId) throw makeRunScriptTargetRequiredError();
    const securityGuardrails = compactRunScriptSecurityGuardrails(await getSecurityGuardrails());
    const run = async () => {
      await (waitUntil === "commit" ? waitForPageCommit : waitForParsedDocument)(resolvedTabId, { ...context, signal });
      signal?.throwIfAborted();
      try {
        context.operation?.dispatch();
        const evalResult = await evaluateCdpScript(resolvedTabId, {
          // Evaluate the user function outside the host closure: only its argument and page globals are visible.
          expression: `((__qzEvaluate, __qzArgument) => ${holdScriptTrace(runScriptTraceRuntimeSource({
            reason: "evaluate", strictResult: true, securityGuardrails, defineInputBindings: false,
            source: "return await __qzEvaluate(__qzArgument);",
          }))}) ((${String(code).trim().replace(/;+$/, "")}), ${JSON.stringify(args) ?? "undefined"})`,
          returnByValue: true,
          awaitPromise: true,
          generatePreview: true,
          userGesture: true,
        }, signal, context);
        const result = withoutToolAccess(formatCdpScriptResult(evalResult, "cdp"));
        if (result.ok !== false) context.operation?.confirm();
        return result;
      } catch (cdpError) {
        if (["OPERATION_ABORTED", "BROWSER_PERMISSION_REQUIRED", "BROWSER_PERMISSION_DENIED"].includes(errorCode(cdpError))) throw cdpError;
        if (isToolApiReferenceError(errorMessage(cdpError))) return withoutToolAccess({ ok: false, error: errorMessage(cdpError), engine: "cdp", execution_world: "page" });
        return makePageContextUnavailableResult(cdpError, { tabId: resolvedTabId, reason: "cdp" });
      }
    };
    const fromPageParent = isNestedRunScriptContext(context) && Number(context.senderTabId) === resolvedTabId;
    const execution = await (fromPageParent ? run() : runPageScriptExclusive(resolvedTabId, signal, run, context));
    return scriptExecutionValue(record(execution), context);
  },
});

registerTool({
  name: "list_tools",
  get description() { return toolT("listToolsDescription"); },
  parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" } } } },
  execute: async ({ names }, _signal, context = {}) => {
    if (!context.listTools) throw new ToolExecutionError("TOOL_CATALOG_UNAVAILABLE", "The tool catalog is unavailable.");
    return context.listTools(names);
  },
});

function scriptExecutionValue(execution: Fields, context: ToolContext, receipt = false): unknown {
  const failed = execution.ok === false;
  const value = failed || receipt ? describeScriptExecution(execution) : markToolValue(execution.resultType === "undefined" ? undefined : execution.result);
  const images = (Array.isArray(execution.observations) ? execution.observations : []).flatMap(item => {
    const image = normalizeRunScriptObservation(item)?._image;
    const match = typeof image === 'string' ? /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(image) : null;
    return match ? [{ mimeType: match[1]!, data: match[2]!.replace(/\s/g, '') }] : [];
  });
  const presentation = { _display: { script: { ...(!failed && !receipt ? { valueOnly: true } : {}), trace: compactScriptTrace(execution.trace) } },
    ...(images.length ? { _images: images } : {}) };
  Object.assign(context.resultPresentation ?? {}, presentation);
  return bindToolResultPresentation(value, presentation);
}

/** Both execution environments construct the same caller result here. */
function describeScriptExecution(execution: Fields) {
  const image = normalizeRunScriptObservation(execution);
  const trace = compactScriptTrace(execution.trace);
  if (execution.ok !== false) return {
    ok: true, result: execution.result,
    ...(trace.length ? { trace } : {}),
    ...(execution.hasResult === false || execution.resultType === 'undefined'
      ? { hint: 'The script returned undefined.' } : {}),
    ...(image || {}),
  };
  const details = record(execution.details);
  return { ...toolError(String(execution.code || 'SCRIPT_EVALUATION_FAILED'),
    String(details.originalError || execution.message || execution.error || 'Script failed.'), {
      hint: typeof execution.hint === "string" ? execution.hint : undefined,
      details: {
        ...details,
        ...(details.lineNumber != null ? { line: details.lineNumber } : {}),
        ...(details.columnNumber != null ? { column: details.columnNumber } : {}),
        ...(trace.length ? { trace: trace.slice(-5) } : {}),
      },
    }), ...(image || {}) };
}

function isToolApiReferenceError(error: unknown) {
  return /\b(?:qz|tools|tool) is not defined\b|can't find variable:\s*(?:qz|tools|tool)\b/i.test(String(error || ""));
}

function withoutToolAccess(result: Fields): Fields {
  if (result.ok !== false || !isToolApiReferenceError(result.error)) return result;
  return { ...result,
    code: "RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE", error: t("scriptToolAccessUnavailable"),
    hint: toolT("toolAccessRecovery"),
    details: { ...record(result.details), toolAccess: false, automaticReplay: false, mayHaveTakenEffect: true },
  };
}

const pageScriptQueuesByTabId = new Map<number, Promise<void>>();
const runScriptInnerPendingByRequestId = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
const runScriptInnerTraceWaiters = new Map<string, (rows: unknown) => void>();

function makeRunScriptAbortedError(context: ToolContext, phase = "run") {
  return new ToolExecutionError("OPERATION_ABORTED", `Operation aborted while waiting to ${phase} page script`, {
    ...(context.requestedTabRef == null ? {} : { tabRef: context.requestedTabRef }), phase,
  });
}

async function waitForPageScriptTurn(previous: Promise<void>, signal: AbortSignal | undefined, context: ToolContext) {
  if (!signal) {
    await previous.catch(() => {});
    return;
  }
  if (signal.aborted) throw makeRunScriptAbortedError(context, "queue");
  let abortHandler: (() => void) | null = null;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => reject(makeRunScriptAbortedError(context, "queue"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    await Promise.race([previous.catch(() => {}), abortPromise]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

async function runPageScriptExclusive<T>(tabId: number, signal: AbortSignal | undefined, fn: () => Promise<T>, context: ToolContext = {}): Promise<T> {
  const key = Number(tabId);
  if (!Number.isFinite(key) || key <= 0) return fn();

  const previous = pageScriptQueuesByTabId.get(key) || Promise.resolve();
  let releaseTurn!: () => void;
  const gate = new Promise<void>(resolve => { releaseTurn = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  pageScriptQueuesByTabId.set(key, current);

  try {
    await waitForPageScriptTurn(previous, signal, context);
    if (signal?.aborted) throw makeRunScriptAbortedError(context, "run");
    return await fn();
  } finally {
    releaseTurn?.();
    void current.then(() => {
      if (pageScriptQueuesByTabId.get(key) === current) pageScriptQueuesByTabId.delete(key);
    });
  }
}

async function ensureRunScriptOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new ToolExecutionError("SCRIPT_CONTEXT_UNAVAILABLE", "Script execution is unavailable in this browser.", {
      engine: "offscreen_inner",
    });
  }
  if (runScriptOffscreenSetupPromise) return runScriptOffscreenSetupPromise;
  runScriptOffscreenSetupPromise = (async () => {
    const { existed } = await ensureOffscreenDocument();
    await waitForRunScriptOffscreenReady({ existed });
    return true;
  })().finally(() => {
    runScriptOffscreenSetupPromise = null;
  });
  return runScriptOffscreenSetupPromise;
}

async function waitForRunScriptOffscreenReady({ existed = false } = {}) {
  const startedAt = Date.now();
  let lastError = "";
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = record(await chrome.runtime.sendMessage<Fields, unknown>({ type: "run_script_inner_ping", attempt }));
      if (response?.ok && response?.ready) {
        return true;
      }
      lastError = `unexpected response ${JSON.stringify(response)}`;
    } catch (err) {
      lastError = errorMessage(err);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new ToolExecutionError("SCRIPT_CONTEXT_UNAVAILABLE", "The script context did not become ready.", {
    existed,
    elapsedMs: Date.now() - startedAt,
    lastError,
  });
}

async function runScriptWithOffscreenInnerRunner(code: string, context: ToolContext = {}, reason = "inner", scriptArgs: unknown = {}, securityGuardrails: Guardrails = {}, signal?: AbortSignal) {
  const requestId = `inner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const runId = typeof context.runId === "string" ? context.runId : "";
  const depth = Math.max(0, Math.floor(Number(context.runScriptToolDepth) || 0));
  const source = wrapRunScriptSource(String(code || ""));
  const scriptTrace = beginScriptTrace(context, requestId);
  let unregisterNetworkExecution: (() => void) | null = null;
  try {
    await ensureRunScriptOffscreenDocument();
    const skillExecution = context?.skillExecution;
    const skillNetwork = getToolRuntimeDependencies(context)?.skillNetwork;
    const fetchBridge = Boolean(skillExecution?.plugin);
    if (skillExecution?.plugin) {
      if (typeof skillNetwork?.registerExecution !== "function") {
        throw new ToolExecutionError("SKILL_NETWORK_UNAVAILABLE", "Skill network access is unavailable", {
          pluginId: skillExecution.plugin?.id || "",
          skillName: skillExecution.plugin?.skillName || "",
        });
      }
      unregisterNetworkExecution = skillNetwork.registerExecution(requestId, {
        plugin: skillExecution.plugin,
        config: skillExecution.config || {},
        signal,
      });
    }
    const response = await sendRunScriptInnerMessage({
      type: "run_script_inner_execute",
      requestId,
      parentCallId: context.toolExecutionId || "",
      source,
      sessionId,
      runId,
      depth,
      reason,
      scriptArgs,
      strictResult: reason === "orchestration",
      securityGuardrails,
      fetchBridge,
    }, signal);
    const envelope = record(response);
    const trace = scriptTrace.finish(envelope.__runScriptEnvelope === true ? envelope.trace : []);
    if (envelope && typeof envelope === "object" && envelope.__runScriptEnvelope === true) {
      envelope.trace = trace;
      return compactRunScriptEnvelope(envelope, "offscreen_inner");
    }
    if (envelope && typeof envelope === "object" && envelope.ok === false) {
      return {
        ...envelope,
        trace,
        engine: envelope.engine || "offscreen_inner",
        execution_world: envelope.execution_world || "inner",
      };
    }
    return {
      ok: true,
      hasResult: true,
      result: response,
      trace,
      resultType: response === null ? "null" : Array.isArray(response) ? "array" : typeof response,
      engine: "offscreen_inner",
      execution_world: "inner",
    };
  } catch (err) {
    const trace = scriptTrace.finish([{ level: "error", message: errorMessage(err) }]);
    if (errorCode(err) === "OPERATION_ABORTED") throw err;
    return {
      ok: false,
      hasResult: false,
      result: null,
      error: errorMessage(err) || "The script context is unavailable.",
      code: errorCode(err) || "SCRIPT_CONTEXT_UNAVAILABLE",
      hint: typeof record(err).hint === "string" ? record(err).hint
        : !errorCode(err) || errorCode(err) === "SCRIPT_CONTEXT_UNAVAILABLE" ? toolT("scriptContextRecovery") : undefined,
      trace,
      engine: "offscreen_inner",
      execution_world: "inner",
      details: {},
    };
  } finally {
    scriptTrace.close();
    unregisterNetworkExecution?.();
  }
}

async function sendRunScriptInnerMessage(message: Fields, signal?: AbortSignal) {
  const requestId = String(message?.requestId || "");
  if (!requestId) {
    throw new ToolExecutionError("SCRIPT_REQUEST_INVALID", "The script execution request is missing its identifier.", {
      engine: "offscreen_inner",
    });
  }
  if (signal?.aborted) {
    throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before running the script", {
      engine: "offscreen_inner",
      requestId,
    });
  }
  let abortHandler: (() => void) | null = null;
  const resultPromise = new Promise<unknown>((resolve, reject) => {
    runScriptInnerPendingByRequestId.set(requestId, {
      resolve(value) {
        runScriptInnerPendingByRequestId.delete(requestId);
        resolve(value);
      },
      reject(error) {
        runScriptInnerPendingByRequestId.delete(requestId);
        reject(error);
      },
    });
  });
  abortHandler = () => {
    const pending = runScriptInnerPendingByRequestId.get(requestId);
    if (!pending) return;
    if (record(signal?.reason).code === "TOOL_TIMEOUT") {
      const read = requestInnerTraceSnapshot(requestId);
      publishTimeoutTrace(signal, read);
      void read.finally(() => {
        chrome.runtime.sendMessage({ type: "run_script_inner_cancel", requestId }).catch(() => {});
      });
    } else {
      chrome.runtime.sendMessage({ type: "run_script_inner_cancel", requestId }).catch(() => {});
    }
    pending.reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while running the script", {
      engine: "offscreen_inner",
      requestId,
    }));
  };
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    const ack = record(await chrome.runtime.sendMessage<Fields, unknown>(message));
    if (!ack?.ok) {
      const pending = runScriptInnerPendingByRequestId.get(requestId);
      pending?.reject(new ToolExecutionError(String(ack.code || "SCRIPT_CONTEXT_UNAVAILABLE"), String(ack.error || "The script execution request was not accepted."), {
        engine: "offscreen_inner",
        requestId,
      }));
    }
    return await resultPromise;
  } finally {
    if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
    runScriptInnerPendingByRequestId.delete(requestId);
  }
}

function isNestedRunScriptContext(context: ToolContext = {}) {
  return Math.max(0, Math.floor(Number(context.runScriptToolDepth) || 0)) > 0;
}

function requestInnerTraceSnapshot(requestId: string): Promise<unknown[]> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (rows: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runScriptInnerTraceWaiters.delete(requestId);
      resolve(Array.isArray(rows) ? rows.slice(-5) : []);
    };
    const timer = setTimeout(() => finish([]), 800);
    runScriptInnerTraceWaiters.set(requestId, finish);
    chrome.runtime.sendMessage({ type: "run_script_inner_trace_snapshot", requestId }).catch(() => finish([]));
  });
}

function handleRunScriptInnerRuntimeMessage(msg: Fields = {}) {
  if (msg?.type === "run_script_inner_diagnostic") {
    acceptScriptTrace(String(msg.requestId || ""), msg.row);
    return { ok: true, handled: true };
  }
  if (msg?.type === "run_script_inner_trace_snapshot_result") {
    runScriptInnerTraceWaiters.get(String(msg.requestId || ""))?.(msg.trace);
    return { ok: true, handled: true };
  }
  if (msg?.type === "run_script_inner_trace") {
    return { ok: true, handled: true };
  }
  if (msg?.type === "run_script_inner_result") {
    const requestId = String(msg.requestId || "");
    const pending = runScriptInnerPendingByRequestId.get(requestId);
    if (pending) {
      pending.resolve(msg.result);
    }
    return { ok: true, handled: true };
  }
  return null;
}

async function runScriptWithCdpToolBridge(tabId: number, code: string, context: ToolContext = {}, reason = "tool_api", scriptArgs: Fields = {}, securityGuardrails: Guardrails = {}, signal?: AbortSignal) {
  if (isNestedRunScriptContext(context)) {
    return runScriptWithCdpToolBridgeUnlocked(tabId, code, context, reason, scriptArgs, securityGuardrails, signal);
  }
  return runPageScriptExclusive(tabId, signal, () => (
    runScriptWithCdpToolBridgeUnlocked(tabId, code, context, reason, scriptArgs, securityGuardrails, signal)
  ), context);
}

async function runScriptWithCdpToolBridgeUnlocked(tabId: number, code: string, context: ToolContext = {}, reason = "tool_api", scriptArgs: Fields = {}, securityGuardrails: Guardrails = {}, signal?: AbortSignal) {
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const runId = typeof context.runId === "string" ? context.runId : "";
  const depth = Math.max(0, Math.floor(Number(context.runScriptToolDepth) || 0));
  try {
    await ensureRunScriptToolBridge(tabId, context);
  } catch (err) {
    if (errorCode(err) === "OPERATION_ABORTED") throw err;
    return makePageContextUnavailableResult(err, { tabId, reason, phase: "tool_bridge_install" });
  }
  const expression = buildCdpToolBridgeExpression(code, { tabId, sessionId, runId, parentCallId: context.toolExecutionId || "", depth, reason, scriptArgs, securityGuardrails });
  try {
    const evalResult = await evaluateCdpScript(tabId, {
      expression,
      returnByValue: true,
      awaitPromise: true,
      generatePreview: true,
      userGesture: true,
    }, signal, context);
    return formatCdpScriptResult(evalResult, `cdp_${reason}`);
  } catch (err) {
    if (["OPERATION_ABORTED", "BROWSER_PERMISSION_REQUIRED", "BROWSER_PERMISSION_DENIED"].includes(errorCode(err))) throw err;
    return makePageContextUnavailableResult(err, { tabId, reason });
  }
}

function makePageContextUnavailableResult(error: unknown, { tabId, reason = "cdp", phase = "evaluate" }: { tabId?: number; reason?: string; phase?: string } = {}) {
  return {
    ok: false,
    hasResult: false,
    result: null,
    error: "page_context_unavailable",
    message: "The page execution context became unavailable.",
    code: "PAGE_CONTEXT_UNAVAILABLE",
    hint: toolT("pageContextRecovery"),
    engine: "cdp",
    execution_world: "page",
    details: { mayHaveTakenEffect: true, automaticReplay: false },
  };
}

async function ensureRunScriptToolBridge(tabId: number, context: ToolContext) {
  const finishPhase = context.measurePhase?.("injection");
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["content/run-script-tool-bridge.js"],
      injectImmediately: true,
    });
  } finally {
    finishPhase?.();
  }
}

function holdScriptTrace(body: string) {
  return `
(() => {
  const __qzTrace = [];
  const __qzPromise = (async () => {
${body}
  })();
  try { Object.defineProperty(__qzPromise, "__qzTrace", { value: __qzTrace }); } catch (_e) {}
  return __qzPromise;
})()
`;
}

function buildCdpToolBridgeExpression(code: string, { tabId, sessionId, runId, parentCallId, depth, reason, scriptArgs = {}, securityGuardrails = {} }: ScriptOptions) {
  const source = wrapRunScriptSource(String(code || ""));
  return holdScriptTrace(`
  const __qzSourceTabId = ${JSON.stringify(tabId)};
  const __qzSessionId = ${JSON.stringify(sessionId)};
  const __qzRunId = ${JSON.stringify(runId || "")};
  const __qzParentCallId = ${JSON.stringify(parentCallId || "")};
  const __qzDepth = ${JSON.stringify(depth)};
  const __qzReason = ${JSON.stringify(reason)};
  const input = ${JSON.stringify(scriptArgs || {})};
  const args = input;
  const $plugin = input.$plugin || {};
  let __qzSeq = 0;
  let __qzLastObservation = null;
  function __qzCallTool(name, args = {}) {
    const toolName = String(name || "").trim();
    if (!toolName) throw new Error("tools call requires a tool name");
    let input;
    try {
      input = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : args;
    } catch (_e) {
      input = args;
    }
    const safeInput = __qzSafeValueForMessage(input || {});
    const id = "qz_tool_" + Date.now() + "_" + (++__qzSeq);
    return new Promise((resolve, reject) => {
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "qz-run-script-tool-response" || data.id !== id) return;
        window.removeEventListener("message", onMessage);
        const response = data.response;
        if (!response) {
          reject(new Error("tools." + toolName + " returned empty bridge response"));
          return;
        }
        if (!response.ok) {
          const bridgeError = new Error(response.message || response.error || ("tools." + toolName + " bridge failed"));
          if (response.code) bridgeError.code = response.code;
          if (response.hint) bridgeError.hint = response.hint;
          if (response.details) bridgeError.details = response.details;
          reject(bridgeError);
          return;
        }
        if (response.observation && typeof response.observation === "object") {
          __qzLastObservation = response.observation;
        }
        __qzAddToolArtifacts(response.artifacts || response.artifact);
        resolve(response.result);
      }
      window.addEventListener("message", onMessage);
      window.postMessage({
        source: "qz-run-script-tool-call",
        id,
        toolName,
        args: safeInput,
        sessionId: __qzSessionId,
        runId: __qzRunId,
        depth: __qzDepth + 1,
        parentCallId: __qzParentCallId,
        reason: __qzReason,
      }, "*");
    });
  }
  const tool = __qzCallTool;
  const tools = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toStringTag) return "RunScriptTools";
      if (prop === "$call") return __qzCallTool;
      if (prop === "$list") return () => __qzCallTool("__list_tools__", {});
      if (typeof prop !== "string") return undefined;
      return (args = {}) => __qzCallTool(prop, args);
    },
  });
  const tabId = __qzSourceTabId;
  ${runScriptTraceRuntimeSource({ reason, source, withConsolePatch: true, defineInputBindings: false, withToolSdk: true, securityGuardrails })}
`);
}

function runScriptTraceRuntimeSource({ tabId, reason, scriptArgs, strictResult = false, source, withConsolePatch = true, defineInputBindings = true, withToolSdk = false, securityGuardrails = {} }: ScriptOptions & { source: string; withConsolePatch?: boolean; defineInputBindings?: boolean; withToolSdk?: boolean }) {
  return `
  ${defineInputBindings ? `
  const tabId = ${JSON.stringify(tabId || null)};
  const input = ${JSON.stringify(scriptArgs) ?? "undefined"};
  const args = input;
  const $plugin = input?.$plugin || {};
  ` : ""}
  const __qzArtifacts = [];
  const __qzMaxTrace = ${MAX_SCRIPT_TRACE_ENTRIES};
  const __qzStartedAt = Date.now();
  ${SCRIPT_RUNTIME_SOURCE}
  ${withToolSdk ? "const qz = QZ_SCRIPT_RUNTIME.createQzSdk((name, args) => __qzCallTool(name, QZ_SCRIPT_RUNTIME.scriptToolArguments(name, args)));" : ""}
  const __qzSafeValueForMessage = value => QZ_SCRIPT_RUNTIME.safeValueForMessage(value, "page");
  function __qzTraceText(value) {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return QZ_SCRIPT_RUNTIME.formatScriptErrorTrace(value);
      if (value && typeof value === "object") return JSON.stringify(__qzSafeValueForMessage(value));
      return String(value);
    } catch(_e) {
      try { return String(value); } catch(_err) { return "[unserializable]"; }
    }
  }
  function __qzPushTrace(level, items) {
    const message = Array.from(items || []).map(__qzTraceText).join(" ");
    __qzTrace.push({
      time: new Date().toISOString(),
      level: String(level || "trace"),
      message: message.length > 1000 ? message.slice(0, 1000) + "…[truncated]" : message,
    });
    if (__qzTrace.length > __qzMaxTrace) __qzTrace.splice(0, __qzTrace.length - __qzMaxTrace);
  }
  function trace(...items) { __qzPushTrace("trace", items); }
  const log = trace;
  function __qzAddToolArtifacts(items) {
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      __qzArtifacts.push(item);
    }
  }
  const __qzConsoleOriginal = {};
  ${withConsolePatch ? `
  for (const __qzLevel of ["log", "info", "warn", "error", "debug"]) {
    try {
      __qzConsoleOriginal[__qzLevel] = console[__qzLevel];
      console[__qzLevel] = function(...items) {
        __qzPushTrace("console." + __qzLevel, items);
        return __qzConsoleOriginal[__qzLevel]?.apply(this, items);
      };
    } catch(_e) {}
  }
  ` : ""}
  const __qzSecurityGuardrails = ${JSON.stringify(compactRunScriptSecurityGuardrails(securityGuardrails))};
  function __qzEnvelope(ok, result, error) {
    const __qzSafeResult = ok && result !== undefined ? ${strictResult ? "QZ_SCRIPT_RUNTIME.scriptValue(result)" : "__qzSafeValueForMessage(result)"} : null;
    const out = {
      __runScriptEnvelope: true,
      ok,
      hasResult: ok && result !== undefined,
      result: __qzSafeResult,
      resultType: ok ? (result === null ? "null" : Array.isArray(result) ? "array" : typeof result) : "error",
      engine: "cdp",
      reason: ${JSON.stringify(reason || "cdp")},
      trace: __qzSafeValueForMessage(__qzTrace.slice()),
      elapsedMs: Date.now() - __qzStartedAt,
    };
    if (!ok) {
      out.error = error?.message || String(error || "Script evaluation failed");
      out.code = error?.code || "SCRIPT_EVALUATION_FAILED";
      if (error?.hint) out.hint = String(error.hint);
      out.details = __qzSafeValueForMessage(error?.details && typeof error.details === "object" ? error.details : {});
      if (error?.diagnostic && typeof error.diagnostic === "object") out.diagnostic = __qzSafeValueForMessage(error.diagnostic);
    } else if (result === undefined) {
      out.message = "Script completed successfully but returned undefined. Put an expression at the end or use return to inspect a value.";
    }
    if (__qzArtifacts.length) out.artifacts = __qzSafeValueForMessage(__qzArtifacts.slice());
    if (typeof __qzLastObservation !== "undefined" && __qzLastObservation) {
      out.__lastObservation = __qzSafeValueForMessage(__qzLastObservation);
    }
    return out;
  }
  const __qzRestoreSecurityGuards = QZ_SCRIPT_RUNTIME.installSecurityGuards(__qzSecurityGuardrails, "page");
  try {
    const __qzResult = await (async () => {
      ${source}
    })();
    return __qzEnvelope(true, __qzResult, null);
  } catch (__qzError) {
    __qzPushTrace("error", [__qzError]);
    return __qzEnvelope(false, null, __qzError);
  } finally {
    __qzRestoreSecurityGuards();
    ${withConsolePatch ? `
    for (const __qzLevel of Object.keys(__qzConsoleOriginal)) {
      try { console[__qzLevel] = __qzConsoleOriginal[__qzLevel]; } catch(_e) {}
    }
    ` : ""}
  }
  `;
}

  return Object.freeze({ handleRunScriptInnerRuntimeMessage });
}


export default ((host) => {
  const runtime = createScriptTools({ ...host, scriptTimeoutProperty: {
    type: "number",
    get description() { return toolT("scriptTimeout"); },
  } });
  return { handleRuntimeMessage: runtime.handleRunScriptInnerRuntimeMessage };
}) satisfies ToolExtension;
