import { productText } from "#sdk/shared/product-text";
import { toolT } from "./tool-messages.js";
import { mayUseTools } from "./tool-access.js";
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
interface ScriptOptions { tabId?: number; sessionId?: string; runId?: string; depth?: number; reason?: string; scriptArgs?: Fields; securityGuardrails?: Guardrails }
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorCode = (error: unknown) => String(record(error).code || "");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(record(error).message || error || "");
import { scriptTimeout } from "#sdk/background/tools";
import { ensureOffscreenDocument } from "#sdk/background/browser";
import { wrapRunScriptSource } from "#sdk/shared/browser";
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
    return enrichRunScriptResult({
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
    });
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
      message: "Script completed successfully but returned undefined. Put an expression at the end or use return to inspect a value.",
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
  const result = enrichRunScriptResult(out);
  return lastObservation && result && typeof result === "object"
    ? { ...result, ...lastObservation }
    : result;
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

function enrichRunScriptResult(result: Fields): Fields {
  if (!result || typeof result !== "object" || result.ok !== false) return result;
  if (result.diagnostic && typeof result.diagnostic === "object") return result;
  return {
    ...result,
    diagnostic: buildRunScriptDiagnostic(result),
  };
}

function buildRunScriptDiagnostic(result: Fields = {}) {
  const error = normalizeRunScriptErrorText(result.error || result.message || "");
  const code = String(result.code || "").trim();
  const category = classifyRunScriptFailure(error, code);
  return {
    category,
    likelyCause: describeRunScriptFailure(category),
    suggestedNextStep: suggestRunScriptNextStep(category),
    lastTrace: summarizeRunScriptTraceTail(result.trace),
    engine: result.engine || record(result.details).engine || record(result.details).reason || "",
    code: code || undefined,
  };
}

function normalizeRunScriptErrorText(error: unknown = "") {
  return String(error || "").replace(/\s+/g, " ").trim();
}

function classifyRunScriptFailure(error: string, code = "") {
  const text = `${code} ${error}`.toLowerCase();
  if (/page_context_unavailable|page javascript context is unavailable/.test(text)) return "page_context";
  if (/self_unloading|may unload|blocked .*own tab/.test(text)) return "page_lifecycle";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/illegal return|unexpected token 'return'|await is only valid|unexpected token|unexpected identifier|missing \)|reserved word|syntaxerror/.test(text)) return "script_shape";
  if (/\b(require|process|fs|path|module|exports|import)\b.*(not defined|unexpected)|\b(document|window) is not defined\b|cannot use import|geteventlisteners|\$0|monitorevents|copy is not defined/i.test(error)) return "wrong_runtime";
  if (/cannot read propert(?:y|ies) of (null|undefined)|null is not an object|undefined is not an object|queryselector|query selector/.test(text)) return "selector_or_timing";
  if (/run_script tool bridge|bridge timed out|empty bridge response|tool_call_failed/.test(text)) return "tool_bridge";
  if (/cannot access contents|extensions gallery|chrome:|edge:|moz-extension|restricted url|permission/.test(text)) return "restricted_page";
  return "script_error";
}

function describeRunScriptFailure(category: string) {
  switch (category) {
    case "page_context":
      return t("thePageJavascriptContextIsUnavailableRunScriptRuns");
    case "page_lifecycle":
      return t("theScriptClickedSubmittedNavigatedOrClosedTheCurrent");
    case "timeout":
      return t("theScriptPageWaitOrNestedToolCallTimed");
    case "script_shape":
      return t("theScriptHasAnUnsupportedShapeOrInvalidSyntax");
    case "wrong_runtime":
      return t("theExecutionEnvironmentDoesNotMatchTheScriptPage");
    case "selector_or_timing":
      return t("theTargetDomIsEmptyOrThePageHas");
    case "tool_bridge":
      return t("aToolsCallInsideRunScriptFailedCheckBridge");
    case "restricted_page":
      return t("theBrowserBlocksScriptInjectionOnThisPageThis");
    default:
      return t("scriptExecutionFailedUseTheErrorAndTraceTo");
  }
}

function suggestRunScriptNextStep(category: string) {
  switch (category) {
    case "page_context":
      return t("useARegularHttpHttpsPageRefreshOrReopen");
    case "page_lifecycle":
      return t("performClicksSubmissionsAndNavigationAsSeparateToolCalls");
    case "timeout":
      return t("useABoundedTimeoutRecordTheWaitTargetMatch");
    case "script_shape":
      return toolT("scriptShapeRecovery");
    case "wrong_runtime":
      return t("useTargetPageWithAWorkingTabForPage");
    case "selector_or_timing":
      return t("returnTheCandidateCountAndASampleFirstOr");
    case "tool_bridge":
      return t("checkToolStartToolErrorInTheTraceIncluding");
    case "restricted_page":
      return t("runOnARegularHttpHttpsPageOrUse");
    default:
      return t("inspectDiagnosticLasttraceAndTheErrorAddStageTrace");
  }
}

function summarizeRunScriptTraceTail(trace: unknown) {
  const rows: unknown[] = Array.isArray(trace) ? trace : [];
  return rows.slice(-5).map((row) => {
    if (!row || typeof row !== "object") return String(row ?? "");
    return [record(row).level || "trace", record(row).message || record(row).text || ""].filter(Boolean).join(": ");
  }).filter(Boolean);
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
  throw new ToolExecutionError("INVALID_RUN_SCRIPT_TARGET", "run_script target must be page or inner.", {
    target: value,
    allowed: ["page", "inner"],
  });
}

function makeRunScriptTargetRequiredError({ code, skill, script, context = {} }: { code?: unknown; skill?: unknown; script?: unknown; context?: ToolContext } = {}) {
  const workingTabId = Number(context?.workingTabId);
  const sessionId = String(context?.sessionId || "").trim();
  return new ToolExecutionError(
    "RUN_SCRIPT_TARGET_TAB_REQUIRED",
    "run_script requires an explicit tabId or the current session workingTabId; it will not fall back to the active browser tab.",
    {
      reason: "run_script_strict_target_policy",
      codeLength: String(code || "").length,
      skill: String(skill || ""),
      script: String(script || ""),
      sessionId,
      workingTabId: Number.isFinite(workingTabId) && workingTabId > 0 ? workingTabId : null,
      suggestedNextStep: toolT("workingTabRecovery"),
      examples: [
        t("callOpenTabForTheTargetUrlFirstThen"),
        t("ifTheTargetPageIsKnownPassTabidTo"),
        t("useListTabsToInspectActiveIsworkingtabUsableThen"),
        t("forDataStoreProcessingFileGenerationOrPureJs"),
      ],
    },
  );
}

registerTool({
  name: "run_skill_script",
  behavior: { barrier: true, timeoutResult: { kind: "action", pending: "script outcome confirmation" } },
  requires: { tools: ["run_script"] },
  effects: args => args.mutatesPage === true ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("runSkillScriptDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      timeout: SCRIPT_TIMEOUT_SECONDS_PROPERTY,
      target: { type: "string", enum: ["page", "inner"], description: toolT("runSkillScriptTarget") },
      tabId: { type: "number", description: toolT("runSkillScriptTabId") },
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
      return runScriptWithOffscreenInnerRunner(code, context, "skill_script", scriptArgs, securityGuardrails, signal);
    }
    const resolvedTabId = resolveRunScriptTargetTabId(tabId, context);
    if (!resolvedTabId) throw makeRunScriptTargetRequiredError({ skill, script, context });
    return runScriptWithCdpToolBridge(resolvedTabId, code, context, "skill_script", scriptArgs, securityGuardrails, signal);
  },
});

registerTool({
  name: "run_script",
  behavior: {
    barrier: args => isRunScriptInnerTargetArgs(args) || mayUseTools(args.code),
    parallelTab: true,
    timeoutResult: { kind: "action", pending: "script outcome confirmation" },
  },
  workingTab: args => args.mutatesPage === true ? "claim" : "update",
  effects: args => args.mutatesPage === true ? [{ type: "context.siteChanged" }] : [],
  get description() { return getRunScriptDescription(); },
  get parameters() { return {
    type: "object",
    properties: {
      timeout: SCRIPT_TIMEOUT_SECONDS_PROPERTY,
      target: { type: "string", enum: ["page", "inner"], description: toolT("runScriptTarget") },
      tabId: { type: "number", description: toolT("runSkillScriptTabId") },
      args: { type: "object", description: toolT("runScriptArgs") },
      mutatesPage: { type: "boolean", description: toolT("runSkillScriptMutatesPage") },
      code: { type: "string", description: toolT("runScriptCode") },
    },
    required: ["timeout", "code"],
  } as const; },
  page: args => isRunScriptInnerTargetArgs(args) ? false : "owned",
  timeout: scriptTimeout,
  validateArgs: args => { scriptTimeout(args, "run_script"); },
  execute: async (input, signal, context = {}) => {
    const { target, tabId, code, args = {}, mutatesPage } = input;
    const { skill, script } = input as typeof input & { skill?: unknown; script?: unknown };
    const executionTarget = normalizeRunScriptTarget(target);
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
    const scriptArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const securityGuardrails = compactRunScriptSecurityGuardrails(await getSecurityGuardrails());
    if (executionTarget === "inner") {
      if (mutatesPage === true) {
        throw new ToolExecutionError("INVALID_RUN_SCRIPT_TARGET", "run_script target:\"inner\" cannot mutate a page.", {
          target: executionTarget,
          mutatesPage,
        });
      }
      return runScriptWithOffscreenInnerRunner(code, context, "inner", scriptArgs, securityGuardrails, signal);
    }

    const resolvedTabId = resolveRunScriptTargetTabId(tabId, context);
    if (!resolvedTabId) throw makeRunScriptTargetRequiredError({ code, skill, script, context });

    const run = async () => {
      if (mayUseTools(code)) {
        if (context.deferToolCommit) throw new ToolExecutionError("RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE", t("scriptToolAccessUnavailable"), {
          toolAccess: false, executed: false, automaticReplay: false, suggestedNextStep: t("scriptToolAccessRecovery"),
        });
        return runScriptWithCdpToolBridgeUnlocked(resolvedTabId, code, context, "tool_api", scriptArgs, securityGuardrails, signal);
      }

      try {
        const evalResult = await evaluateCdpScript(resolvedTabId, {
          expression: buildCdpTraceExpression(code, { tabId: resolvedTabId, reason: "cdp", scriptArgs, securityGuardrails }),
          returnByValue: true,
          awaitPromise: true,
          generatePreview: true,
          userGesture: true,
        }, signal, context);
        const formatted = formatCdpScriptResult(evalResult, "cdp");
        if (formatted.ok || isToolApiReferenceError(formatted.error) || !isExplicitReturnError(formatted.error, record(evalResult).exceptionDetails)) return withoutToolAccess(formatted);
        // Only a native syntax error without an execution stack may use shape recovery.
        return withoutToolAccess(await runScriptAsFunctionBody(resolvedTabId, code, formatted.error, scriptArgs, securityGuardrails, signal, context));
      } catch (cdpError) {
        if (errorCode(cdpError) === "OPERATION_ABORTED") throw cdpError;
        if (isToolApiReferenceError(errorMessage(cdpError))) return withoutToolAccess({ ok: false, error: errorMessage(cdpError), engine: "cdp", execution_world: "page" });
        return makePageContextUnavailableResult(cdpError, { tabId: resolvedTabId, reason: "cdp" });
      }
    };
    return isNestedRunScriptContext(context) ? run() : runPageScriptExclusive(resolvedTabId, signal, run);
  },
});

function isToolApiReferenceError(error: unknown) {
  return /\b(?:tools|tool) is not defined\b|can't find variable:\s*(?:tools|tool)\b/i.test(String(error || ""));
}

function withoutToolAccess(result: Fields): Fields {
  if (result.ok !== false || !isToolApiReferenceError(result.error)) return result;
  return { ...result,
    code: "RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE", error: t("scriptToolAccessUnavailable"),
    details: { ...record(result.details), originalError: result.error, toolAccess: false, automaticReplay: false, mayHaveTakenEffect: true },
    diagnostic: { ...record(result.diagnostic), category: "tool_access",
      likelyCause: t("scriptToolAccessUnavailable"), suggestedNextStep: t("scriptToolAccessRecovery") },
  };
}

const pageScriptQueuesByTabId = new Map<number, Promise<void>>();
const runScriptInnerPendingByRequestId = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();

function makeRunScriptAbortedError(tabId: number, phase = "run") {
  return new ToolExecutionError("OPERATION_ABORTED", `Operation aborted while waiting to ${phase} page script`, {
    tabId,
    engine: "cdp",
    phase,
  });
}

async function waitForPageScriptTurn(tabId: number, previous: Promise<void>, signal?: AbortSignal) {
  if (!signal) {
    await previous.catch(() => {});
    return;
  }
  if (signal.aborted) throw makeRunScriptAbortedError(tabId, "queue");
  let abortHandler: (() => void) | null = null;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => reject(makeRunScriptAbortedError(tabId, "queue"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    await Promise.race([previous.catch(() => {}), abortPromise]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

async function runPageScriptExclusive<T>(tabId: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const key = Number(tabId);
  if (!Number.isFinite(key) || key <= 0) return fn();

  const previous = pageScriptQueuesByTabId.get(key) || Promise.resolve();
  let releaseTurn!: () => void;
  const gate = new Promise<void>(resolve => { releaseTurn = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  pageScriptQueuesByTabId.set(key, current);

  try {
    await waitForPageScriptTurn(key, previous, signal);
    if (signal?.aborted) throw makeRunScriptAbortedError(key, "run");
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
    throw new ToolExecutionError("INNER_RUNNER_UNAVAILABLE", productText("Chrome offscreen documents are not available.", "Firefox offscreen documents are not available."), {
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
  throw new ToolExecutionError("INNER_RUNNER_OFFSCREEN_NOT_READY", "run_script inner offscreen document did not become ready.", {
    existed,
    elapsedMs: Date.now() - startedAt,
    lastError,
  });
}

async function runScriptWithOffscreenInnerRunner(code: string, context: ToolContext = {}, reason = "inner", scriptArgs: Fields = {}, securityGuardrails: Guardrails = {}, signal?: AbortSignal) {
  const requestId = `inner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const runId = typeof context.runId === "string" ? context.runId : "";
  const depth = Math.max(0, Math.floor(Number(context.runScriptToolDepth) || 0));
  const source = wrapRunScriptSource(String(code || ""));
  let unregisterNetworkExecution: (() => void) | null = null;
  try {
    await ensureRunScriptOffscreenDocument();
    const skillExecution = context?.skillExecution;
    const skillNetwork = getToolRuntimeDependencies(context)?.skillNetwork;
    const fetchBridge = Boolean(skillExecution?.plugin);
    if (skillExecution?.plugin) {
      if (typeof skillNetwork?.registerExecution !== "function") {
        throw new ToolExecutionError("SKILL_NETWORK_UNAVAILABLE", "Skill inner fetch runtime is unavailable", {
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
      source,
      sessionId,
      runId,
      depth,
      reason,
      scriptArgs,
      securityGuardrails,
      fetchBridge,
    }, signal);
    const envelope = record(response);
    if (envelope && typeof envelope === "object" && envelope.__runScriptEnvelope === true) {
      return compactRunScriptEnvelope(envelope, "offscreen_inner");
    }
    if (envelope && typeof envelope === "object" && envelope.ok === false) {
      return enrichRunScriptResult({
        ...envelope,
        engine: envelope.engine || "offscreen_inner",
        execution_world: envelope.execution_world || "inner",
      });
    }
    return {
      ok: true,
      hasResult: true,
      result: response,
      resultType: response === null ? "null" : Array.isArray(response) ? "array" : typeof response,
      engine: "offscreen_inner",
      execution_world: "inner",
    };
  } catch (err) {
    if (errorCode(err) === "OPERATION_ABORTED") throw err;
    return enrichRunScriptResult({
      ok: false,
      hasResult: false,
      result: null,
      error: errorMessage(err) || "inner_runner_unavailable",
      code: errorCode(err) || "INNER_RUNNER_UNAVAILABLE",
      engine: "offscreen_inner",
      execution_world: "inner",
      details: {
        requestId,
        reason,
      },
    });
  } finally {
    unregisterNetworkExecution?.();
  }
}

async function sendRunScriptInnerMessage(message: Fields, signal?: AbortSignal) {
  const requestId = String(message?.requestId || "");
  if (!requestId) {
    throw new ToolExecutionError("INNER_RUNNER_INVALID_REQUEST", "run_script inner requires requestId.", {
      engine: "offscreen_inner",
    });
  }
  if (signal?.aborted) {
    throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before running inner script", {
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
    if (pending) {
      chrome.runtime.sendMessage({
        type: "run_script_inner_cancel",
        requestId,
      }).catch(() => {});
      pending.reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while running inner script", {
        engine: "offscreen_inner",
        requestId,
      }));
    }
  };
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    const ack = record(await chrome.runtime.sendMessage<Fields, unknown>(message));
    if (!ack?.ok) {
      const pending = runScriptInnerPendingByRequestId.get(requestId);
      pending?.reject(new ToolExecutionError(String(ack.code || "INNER_RUNNER_SEND_FAILED"), String(ack.error || "run_script inner request was not accepted."), {
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

function handleRunScriptInnerRuntimeMessage(msg: Fields = {}) {
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
  ));
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
  const expression = buildCdpToolBridgeExpression(code, { tabId, sessionId, runId, depth, reason, scriptArgs, securityGuardrails });
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
    if (errorCode(err) === "OPERATION_ABORTED") throw err;
    return makePageContextUnavailableResult(err, { tabId, reason });
  }
}

function makePageContextUnavailableResult(error: unknown, { tabId, reason = "cdp", phase = "evaluate" }: { tabId?: number; reason?: string; phase?: string } = {}) {
  const cause = errorMessage(error);
  return enrichRunScriptResult({
    ok: false,
    hasResult: false,
    result: null,
    error: "page_context_unavailable",
    message: "Page JavaScript context is unavailable; script was not executed.",
    code: "PAGE_CONTEXT_UNAVAILABLE",
    engine: "cdp",
    execution_world: "page",
    details: {
      tabId,
      reason,
      phase,
      cdp: cause,
      engine: "cdp",
      execution_world: "page",
    },
  });
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

function buildCdpToolBridgeExpression(code: string, { tabId, sessionId, runId, depth, reason, scriptArgs = {}, securityGuardrails = {} }: ScriptOptions) {
  const source = wrapRunScriptSource(String(code || ""));
  return `
(async () => {
  const __qzSourceTabId = ${JSON.stringify(tabId)};
  const __qzSessionId = ${JSON.stringify(sessionId)};
  const __qzRunId = ${JSON.stringify(runId || "")};
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
    try {
      if (input && typeof input === "object" && input.tabId == null && __qzSourceTabId) input.tabId = __qzSourceTabId;
    } catch (_e) {}
    const safeInput = __qzSafeValueForMessage(input || {});
    __qzPushTrace("tool.start", [toolName, safeInput]);
    const id = "qz_tool_" + Date.now() + "_" + (++__qzSeq);
    return new Promise((resolve, reject) => {
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "qz-run-script-tool-response" || data.id !== id) return;
        window.removeEventListener("message", onMessage);
        const response = data.response;
        if (!response) {
          __qzPushTrace("tool.error", [toolName, "empty bridge response"]);
          reject(new Error("tools." + toolName + " returned empty bridge response"));
          return;
        }
        if (!response.ok) {
          __qzPushTrace("tool.error", [toolName, response.error || "bridge failed"]);
          const bridgeError = new Error(response.error || ("tools." + toolName + " bridge failed"));
          if (response.code) bridgeError.code = response.code;
          if (response.diagnostic) bridgeError.diagnostic = response.diagnostic;
          if (response.details) bridgeError.details = response.details;
          reject(bridgeError);
          return;
        }
        if (response.observation && typeof response.observation === "object") {
          __qzLastObservation = response.observation;
        }
        __qzPushTrace("tool.end", [toolName, response.result]);
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
  ${runScriptTraceRuntimeSource({ reason, source, withConsolePatch: true, defineInputBindings: false, securityGuardrails })}
})()
`;
}

function buildCdpTraceExpression(code: string, { tabId, reason = "cdp", scriptArgs = {}, securityGuardrails = {} }: ScriptOptions = {}) {
  const source = wrapRunScriptSource(String(code || ""));
  return `
(async () => {
  ${runScriptTraceRuntimeSource({ tabId, reason, scriptArgs, source, withConsolePatch: true, defineInputBindings: true, securityGuardrails })}
})()
`;
}

function runScriptTraceRuntimeSource({ tabId, reason, scriptArgs = {}, source, withConsolePatch = true, defineInputBindings = true, securityGuardrails = {} }: ScriptOptions & { source: string; withConsolePatch?: boolean; defineInputBindings?: boolean }) {
  return `
  ${defineInputBindings ? `
  const tabId = ${JSON.stringify(tabId || null)};
  const input = ${JSON.stringify(scriptArgs || {})};
  const args = input;
  const $plugin = input.$plugin || {};
  ` : ""}
  const __qzTrace = [];
  const __qzArtifacts = [];
  const __qzMaxTrace = ${MAX_SCRIPT_TRACE_ENTRIES};
  const __qzStartedAt = Date.now();
  ${SCRIPT_RUNTIME_SOURCE}
  const __qzSafeValueForMessage = value => QZ_SCRIPT_RUNTIME.safeValueForMessage(value, "page");
  function __qzTraceText(value) {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack || value.message || String(value);
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
    const __qzSafeResult = ok && result !== undefined ? __qzSafeValueForMessage(result) : null;
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
      out.error = error?.stack || error?.message || String(error || "Script evaluation failed");
      out.code = error?.code || "SCRIPT_EVALUATION_FAILED";
      out.details = __qzSafeValueForMessage({
        reason: ${JSON.stringify(reason || "cdp")},
        ...(error?.details && typeof error.details === "object" ? error.details : {}),
      });
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

async function runScriptAsFunctionBody(tabId: number, code: string, cdpEvalError: unknown, scriptArgs: Fields, securityGuardrails: Guardrails = {}, signal?: AbortSignal, context: ToolContext = {}) {
  const wrappedCode = `async () => { ${code} }`;
  const evalResult = await evaluateCdpScript(tabId, {
    expression: buildCdpTraceExpression(wrappedCode, {
      tabId,
      reason: "cdp_function_body",
      scriptArgs,
      securityGuardrails,
    }),
    returnByValue: true,
    awaitPromise: true,
    generatePreview: true,
    userGesture: true,
  }, signal, context);
  const formatted = formatCdpScriptResult(evalResult, "cdp_function_body");
  if (!formatted.ok) {
    formatted.details = {
      ...record(formatted.details),
      consoleModeError: cdpEvalError,
    };
  }
  return formatted;
}

function isExplicitReturnError(error: unknown, exceptionDetails: unknown) {
  const text = String(error || "");
  return Boolean(exceptionDetails) && !record(exceptionDetails).stackTrace && !/\n\s+at\b/.test(text)
    && /^(?:Uncaught\s+)?SyntaxError:\s*(?:Illegal return statement|Unexpected token 'return')/i.test(text);
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
