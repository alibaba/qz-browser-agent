import type { ToolContext, ToolErrorConstructor } from '../../sdk/background.js';
import type { CdpCommand } from '../../sdk/background/browser.js';
import { forgetIsolatedContexts } from './isolated-contexts.js';
import { forgetChildFrames } from './child-frames.js';
export type { CdpCommand };
interface CdpOwner { key: string; kind: 'run' | 'temporary' | 'session'; sessionId: string; runId: string }
interface CdpState {
  tabId: number; target: chrome.debugger.Debuggee; ownerKey: string; ownerKind: CdpOwner['kind'];
  sessionId: string; runId: string; attached: boolean; releasing: boolean;
  connectionId: number;
  retained: boolean; userDetached: boolean;
  restore: ((send: CdpCommand) => Promise<void>) | null;
  authorizeRestore: (() => Promise<unknown>) | null;
  recoveryPromise: Promise<void> | null;
  idlePromise: Promise<void> | null;
  attachPromise: Promise<void> | null; detachPromise: Promise<void> | null;
}
interface DebuggerApi {
  onDetach?: { addListener(listener: (source: chrome.debugger.Debuggee, reason: string) => void): void };
  attach(target: chrome.debugger.Debuggee, version: string): Promise<void>;
  detach(target: chrome.debugger.Debuggee): Promise<void>;
  sendCommand(target: chrome.debugger.DebuggerSession, method: string, params?: object): Promise<unknown>;
}
interface RunAccess { sessionId: string; runId: string; context: ToolContext }
interface CdpHost {
  ToolExecutionError: ToolErrorConstructor;
  assertTabAllowed?: (tabId: number, details: Record<string, unknown>) => Promise<unknown>;
  isRunCurrent?: ((access: RunAccess) => boolean) | null;
  /** Ownership only; run liveness is separately enforced before every tool command. */
  authorizeRunTab?: ((access: RunAccess & { tabId: number }) => Promise<unknown>) | null;
  /** Asks whether a run may re-attach after the user dismissed the debugging bar; false refuses control. */
  confirmUserReattach?: ((access: RunAccess & { tabId: number; signal?: AbortSignal | null }) => Promise<boolean>) | null;
  debuggerApi?: DebuggerApi;
}
type CdpOperation<T> = (target: chrome.debugger.Debuggee, send: CdpCommand) => T | Promise<T>;
/** Physical connections may outlive a run; permission to send commands never does. */
export function createCdpRuntime({
  ToolExecutionError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  isRunCurrent = null,
  authorizeRunTab = null,
  confirmUserReattach = null,
  debuggerApi = globalThis.chrome?.debugger,
}: CdpHost) {
  const tabs = new Map<number, CdpState>();
  const reattachPrompts = new Map<string, Promise<boolean>>();
  let temporaryScopeSeq = 0;
  let connectionSeq = 0;

  debuggerApi?.onDetach?.addListener((source, reason) => {
    const tabId = Number(source?.tabId);
    if (!Number.isFinite(tabId) || tabId <= 0) return;
    const state = tabs.get(tabId);
    if (!state) return;
    state.attached = false;
    state.attachPromise = null;
    if (reason === "canceled_by_user" && !state.releasing) state.userDetached = true;
    if (reason === "canceled_by_user" && state.recoveryPromise) state.restore = null;
    if (!state.releasing && reason === "target_closed" && state.retained && state.restore && !state.recoveryPromise) {
      // A target can disappear during navigation while its tab survives. Restore only
      // retained configuration, never a tool action or the permissions of an old run.
      state.recoveryPromise = restoreConnection(state).finally(() => { state.recoveryPromise = null; });
    } else if (state.releasing || (reason === "target_closed" && !state.recoveryPromise)) {
      tabs.delete(tabId);
    }
  });

  async function ensureDebugger(tabId: unknown, context: ToolContext = {}): Promise<CdpState> {
    const owner = runOwner(tabId, context);
    const id = positiveTabId(tabId);
    assertRunCurrent(owner, id, context);
    const current = tabs.get(id);
    if (current?.recoveryPromise) await current.recoveryPromise;
    assertRunCurrent(owner, id, context);
    if (current?.ownerKey === owner.key && current.attached && !current.releasing) {
      return current;
    }
    if (typeof authorizeRunTab === "function") {
      await authorizeRunTab({ tabId: id, sessionId: owner.sessionId, runId: owner.runId, context });
      assertRunCurrent(owner, id, context);
    }
    return ensureForOwner(tabId, owner, context);
  }

  /**
   * Pre-tool gate, called before the tool timeout starts: a run that owns a
   * user-detached tab asks once whether to continue or stop. Parallel calls
   * share the answer; approval leaves the re-attach to the normal path.
   */
  async function confirmRunReattach({ sessionId, runId, context = {}, signal = null }: RunAccess & { signal?: AbortSignal | null }) {
    const ownerKey = `run:${String(sessionId || "").trim()}:${String(runId || "").trim()}`;
    const detached = [...tabs.values()].filter(entry => entry.ownerKey === ownerKey
      && entry.userDetached && !entry.attached && !entry.releasing);
    if (!detached.length) return;
    if (typeof confirmUserReattach !== "function") {
      for (const entry of detached) entry.userDetached = false;
      return;
    }
    let prompt = reattachPrompts.get(ownerKey);
    if (!prompt) {
      prompt = Promise.resolve()
        .then(() => {
          const current = detached.find(entry => tabs.get(entry.tabId) === entry && !entry.releasing);
          return current ? confirmUserReattach({ tabId: current.tabId, sessionId, runId, context, signal }) : true;
        })
        .finally(() => { if (reattachPrompts.get(ownerKey) === prompt) reattachPrompts.delete(ownerKey); });
      reattachPrompts.set(ownerKey, prompt);
    }
    const approved = await prompt;
    if (!approved) throw runReleasedError(detached[0].tabId, sessionId, runId);
    for (const entry of tabs.values()) if (entry.ownerKey === ownerKey) entry.userDetached = false;
  }

  async function ensureForOwner(tabId: unknown, owner: CdpOwner, context: ToolContext = {}): Promise<CdpState> {
    const id = positiveTabId(tabId);
    if (typeof assertTabAllowedBySecurityGuardrails === "function") {
      await assertTabAllowedBySecurityGuardrails(id, { tool: "debugger", source: "cdp" });
    }
    assertRunCurrent(owner, id, context);
    if (!debuggerApi?.attach || !debuggerApi?.sendCommand || !debuggerApi?.detach) {
      throw new ToolExecutionError("DEBUGGER_UNAVAILABLE", "chrome.debugger API is unavailable in this environment", {
        tabId: id,
      });
    }

    let state = tabs.get(id);
    if (state?.idlePromise) {
      await state.idlePromise;
      assertRunCurrent(owner, id, context);
      state = tabs.get(id);
    }
    if (state?.releasing) {
      await state.detachPromise;
      assertRunCurrent(owner, id, context);
      state = tabs.get(id);
    }
    if (state && state.ownerKey !== owner.key) {
      if (state.ownerKind === "session" && owner.kind === "run" && state.sessionId === owner.sessionId) {
        if (state.runId === owner.runId) throw runReleasedError(id, owner.sessionId, owner.runId);
        // An idle retained connection may be borrowed only after fresh Session authorization.
        state.ownerKey = owner.key;
        state.ownerKind = owner.kind;
        state.runId = owner.runId;
      } else {
        throw new ToolExecutionError(
          "CDP_TAB_LEASE_CONFLICT",
          `Tab ${id} is already attached by another active operation`,
          {
            tabId: id,
            sessionId: owner.sessionId || "",
            runId: owner.runId || "",
            currentSessionId: state.sessionId || "",
            currentRunId: state.runId || "",
            currentOwnerKind: state.ownerKind,
          },
        );
      }
    }
    if (!state) {
      state = {
        tabId: id,
        target: { tabId: id },
        ownerKey: owner.key,
        ownerKind: owner.kind,
        sessionId: owner.sessionId || "",
        runId: owner.runId || "",
        attached: false,
        connectionId: 0,
        retained: false,
        userDetached: false,
        restore: null,
        authorizeRestore: null,
        recoveryPromise: null,
        idlePromise: null,
        attachPromise: null,
        detachPromise: null,
        releasing: false,
      };
      tabs.set(id, state);
    }

    if (state.attached) return state;
    if (!state.attachPromise) {
      state.attachPromise = (async () => {
        try {
          await debuggerApi.attach(state.target, "1.3");
          state.attached = true;
          state.userDetached = false;
          state.connectionId = ++connectionSeq;
        } catch (err) {
          if (tabs.get(id) === state) tabs.delete(id);
          assertStateActive(state);
          throw new ToolExecutionError("DEBUGGER_ATTACH_FAILED", `Failed to attach debugger to tab ${id}: ${String(record(err).message || err)}`, {
            tabId: id,
            message: String(record(err).message || err),
          });
        } finally {
          state.attachPromise = null;
        }
      })();
    }
    await state.attachPromise;
    assertStateActive(state);
    if (tabs.get(id) !== state || !state.attached) {
      if (state.detachPromise) await state.detachPromise;
      assertRunCurrent(owner, id, context);
      return ensureForOwner(id, owner, context);
    }
    return state;
  }

  async function sendCdp(tabId: unknown, method: string, params: Record<string, unknown> = {}, context: ToolContext = {}) {
    const state = await ensureDebugger(tabId, context);
    const check = commandAccess(state, context);
    try {
      return await sendForState(state, method, params, check, "", context);
    } catch (err) {
      if (record(err).code === "CDP_RUN_RELEASED") throw err;
      throw new ToolExecutionError("CDP_COMMAND_FAILED", `${method} failed: ${String(record(err).message || err)}`, {
        tabId: state.tabId,
        method,
        params,
        message: String(record(err).message || err),
      });
    }
  }

  async function evaluateCdpScript(tabId: unknown, params: Record<string, unknown> = {}, signal?: AbortSignal, context: ToolContext = {}) {
    if (signal?.aborted) {
      throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before running script", {
        tabId,
        engine: "cdp",
      });
    }

    const state = await ensureDebugger(tabId, context);
    const check = commandAccess(state, context);
    const ownerKey = state.ownerKey;
    if (signal?.aborted) {
      throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before running script", {
        tabId,
        engine: "cdp",
      });
    }
    let abortHandler: (() => void) | null = null;
    let aborted = false;

    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
        abortHandler = () => {
          aborted = true;
          // A late abort must not terminate the next run on this retained connection.
          if (state.ownerKey === ownerKey && state.attached && !state.releasing) {
            const finishPhase = context.measurePhase?.("cdp");
            debuggerApi.sendCommand(state.target, "Runtime.terminateExecution")
              .finally(() => finishPhase?.()).catch(() => {});
          }
          reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while running script", {
            tabId: state.tabId,
            engine: "cdp",
          }));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      })
      : null;
    const runCommand = async (method: string, commandParams: Record<string, unknown>) => {
      check();
      const finishPhase = context.measurePhase?.("cdp");
      try {
        const command = debuggerApi.sendCommand(state.target, method, commandParams);
        command.catch(() => {});
        const result = await (abortPromise ? Promise.race([command, abortPromise]) : command);
        check();
        return result;
      } finally { finishPhase?.(); }
    };

    try {
      const evalResult = await runCommand("Runtime.evaluate", params);
      const result = record(evalResult).result;
      if (params?.awaitPromise && isCdpPromiseResult(result)) {
        return await runCommand("Runtime.awaitPromise", {
          promiseObjectId: result.objectId,
          returnByValue: params.returnByValue !== false,
          generatePreview: params.generatePreview === true,
        });
      }
      return evalResult;
    } catch (err) {
      if (aborted || ["OPERATION_ABORTED", "CDP_RUN_RELEASED"].includes(String(record(err).code || ""))) throw err;
      throw new ToolExecutionError("CDP_COMMAND_FAILED", `Runtime.evaluate failed: ${String(record(err).message || err)}`, {
        tabId: state.tabId,
        method: "Runtime.evaluate",
        params,
        message: String(record(err).message || err),
      });
    } finally {
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }
  }

  /** Keeps the run-owned tab attached while a compound operation uses the raw Debuggee target. */
  async function withDebugger<T>(tabId: unknown, fn: CdpOperation<T>, context: ToolContext = {}) {
    const state = await ensureDebugger(tabId, context);
    const check = commandAccess(state, context);
    check();
    const result = await fn(state.target, bindSend(state, check, "", context));
    check();
    return result;
  }

  /**
   * Runs an internal operation on a temporary/system tab. This is deliberately
   * separate from Agent tools: it owns its whole attach/detach boundary and does
   * not add the tab to Session ownership.
   */
  async function withTemporaryDebugger<T>(tabId: unknown, fn: CdpOperation<T>, label = "temporary") {
    const owner: CdpOwner = {
      key: `temporary:${++temporaryScopeSeq}:${String(label || "temporary")}`,
      kind: "temporary",
      sessionId: "",
      runId: "",
    };
    const state = await ensureForOwner(tabId, owner);
    try {
      return await fn(state.target, bindSend(state, () => {}));
    } finally {
      await detachState(state);
    }
  }

  /** Revoke run access synchronously; retain only explicitly requested tab emulation. */
  async function releaseRun(sessionId: string, runId: string) {
    const sid = String(sessionId || "").trim();
    const rid = String(runId || "").trim();
    if (!sid || !rid) return { released: 0, tabIds: [] };
    const matches = [...tabs.values()].filter(state => (
      state.ownerKind === "run" && state.sessionId === sid && state.runId === rid
    ));
    const released: CdpState[] = [];
    const cleanup: Promise<unknown>[] = [];
    for (const state of matches) {
      if (state.retained && (state.attached || state.recoveryPromise) && !state.releasing) {
        state.ownerKey = `session:${sid}`;
        state.ownerKind = "session";
        // Keep emulation and Runtime. Network and Page collection stops. Runtime
        // stays enabled so the next borrower does not replay console calls.
        // The connection stays attached, so isolated contexts stay too: a second
        // enable would not report the worlds that are already live.
        state.idlePromise = Promise.resolve(state.recoveryPromise).then(async () => {
          if (!state.attached || state.releasing) return;
          // The stopped run can no longer send its own cleanup commands. Release
          // any held finger before lending this retained connection to another run.
          await debuggerApi.sendCommand(state.target, "Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }).catch(() => {});
          await Promise.all(["Network.disable", "Page.disable"].map(method =>
            debuggerApi.sendCommand(state.target, method).catch(() => {})));
        });
        cleanup.push(state.idlePromise);
      } else {
        released.push(state);
        cleanup.push(detachState(state));
      }
    }
    await Promise.all(cleanup);
    return {
      released: released.length,
      tabIds: released.map(state => state.tabId),
    };
  }

  async function releaseSession(sessionId: string) {
    if (!sessionId) return;
    await Promise.all([...tabs.values()].filter(state => state.sessionId === sessionId).map(detachState));
  }

  /** A closed tab revokes its lease even if Chrome already emitted a user detach. */
  async function releaseTab(tabId: number) {
    const state = tabs.get(tabId);
    if (state) await detachState(state);
  }

  function setDebuggerRetention(tabId: number, retained: boolean, context: ToolContext, restore?: (send: CdpCommand) => Promise<void>) {
    const state = tabs.get(tabId);
    if (!state) throw runReleasedError(tabId, context.sessionId || "", context.runId || "");
    commandAccess(state, context)();
    state.retained = retained;
    state.restore = retained ? restore || null : null;
    state.authorizeRestore = retained && authorizeRunTab
      ? () => authorizeRunTab({ tabId, sessionId: state.sessionId, runId: state.runId, context }) : null;
  }

  async function restoreConnection(state: CdpState) {
    const restore = state.restore;
    const check = () => {
      assertStateActive(state);
      if (tabs.get(state.tabId) !== state || !state.retained || state.restore !== restore) {
        throw runReleasedError(state.tabId, state.sessionId, state.runId);
      }
    };
    try {
      // This ownership check also rejects closed tabs and deleted Sessions.
      if (!state.authorizeRestore || !restore) return;
      await state.authorizeRestore();
      check();
      await assertTabAllowedBySecurityGuardrails?.(state.tabId, { tool: "debugger", source: "cdp:restore" });
      check();
      state.attachPromise = debuggerApi.attach(state.target, "1.3").then(() => {
        state.attached = true;
        state.userDetached = false;
        state.connectionId = ++connectionSeq;
      });
      await state.attachPromise;
      check();
      const connection = state.connectionId;
      const checkConnection = () => {
        check();
        if (!state.attached || state.connectionId !== connection) throw runReleasedError(state.tabId, state.sessionId, state.runId);
      };
      await restore(bindSend(state, checkConnection));
      checkConnection();
    } catch {
      // One bounded attempt. Never fight a user detach, reload a submitted form,
      // or spin on a restricted/closed target. The next explicit tool can recover.
      if (!state.releasing) await detachState(state);
    } finally {
      state.attachPromise = null;
    }
  }

  async function detachState(state: CdpState) {
    if (!state || state.releasing) return state?.detachPromise || undefined;
    state.releasing = true;
    state.detachPromise = (async () => {
      try {
        if (state.attachPromise) await state.attachPromise.catch(() => {});
        if (state.attached) await debuggerApi.detach(state.target);
      } catch (_error) {
        // Detach is best-effort at a terminal boundary; the cache must still be retired.
      } finally {
        state.attached = false;
        state.userDetached = false;
        // chrome.debugger.detach() does not emit onDetach. Retiring the connection
        // drops isolated contexts and child targets before the next connection.
        forgetIsolatedContexts(state.tabId);
        forgetChildFrames(state.tabId);
        if (tabs.get(state.tabId) === state) tabs.delete(state.tabId);
      }
    })();
    return state.detachPromise;
  }

  /** Opaque identity changes on reconnect; consumers must not mistake a saved preference for live CDP state. */
  function getDebuggerConnectionId(tabId: number): number | null {
    const state = tabs.get(tabId);
    return state?.attached && !state.releasing ? state.connectionId : null;
  }

  /** Event consumers may record only for the active run, never an idle retained connection. */
  function getDebuggerRun(tabId: number) {
    const state = tabs.get(tabId);
    return state?.attached && !state.releasing && state.ownerKind === "run"
      ? { sessionId: state.sessionId, runId: state.runId, connectionId: state.connectionId }
      : null;
  }

  /** Retire only the caller's lease, including after cancellation, without acquiring a new connection. */
  async function releaseDebugger(tabId: number, context: ToolContext) {
    const state = tabs.get(tabId);
    if (state?.ownerKind === "run" && state.sessionId === context.sessionId && state.runId === context.runId) await detachState(state);
  }

  function runOwner(tabId: unknown, context: ToolContext = {}): CdpOwner {
    const sessionId = String(context?.sessionId || "").trim();
    const runId = String(context?.runId || "").trim();
    if (!sessionId || !runId) {
      throw new ToolExecutionError(
        "CDP_RUN_CONTEXT_REQUIRED",
        "CDP page access requires the current Session and Agent run",
        { tabId: Number(tabId) || null, sessionId, runId },
      );
    }
    return {
      key: `run:${sessionId}:${runId}`,
      kind: "run",
      sessionId,
      runId,
    };
  }

  function assertRunCurrent(owner: CdpOwner, tabId: number, context: ToolContext = {}) {
    if (context.signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Tool call was cancelled", { tabId });
    if (owner?.kind !== "run") return;
    if (typeof isRunCurrent === "function" && isRunCurrent({
      sessionId: owner.sessionId,
      runId: owner.runId,
      context,
    })) return;
    throw runReleasedError(tabId, owner.sessionId, owner.runId);
  }

  function assertStateActive(state: CdpState) {
    if (!state?.releasing) return;
    throw runReleasedError(state.tabId, state.sessionId, state.runId);
  }

  function commandAccess(state: CdpState, context: ToolContext) {
    const owner = runOwner(state.tabId, context);
    const connectionId = state.connectionId;
    return () => {
      assertStateActive(state);
      if (state.ownerKey !== owner.key || !state.attached || state.connectionId !== connectionId) throw runReleasedError(state.tabId, owner.sessionId, owner.runId);
      assertRunCurrent(owner, state.tabId, context);
    };
  }

  function bindSend(state: CdpState, check: () => void, sessionId = "", context: ToolContext = {}): CdpCommand {
    const send = ((method: string, params: Record<string, unknown> = {}) => sendForState(state, method, params, check, sessionId, context)) as CdpCommand;
    send.inSession = (childSessionId: string) => bindSend(state, check, String(childSessionId || ""), context);
    send.tabId = state.tabId;
    send.connectionId = state.connectionId;
    return send;
  }

  async function sendForState(state: CdpState, method: string, params: Record<string, unknown> = {}, check = () => {}, sessionId = "", context: ToolContext = {}) {
    assertStateActive(state);
    check();
    const finishPhase = context.measurePhase?.("cdp");
    try {
      const target = sessionId ? { ...state.target, sessionId } : state.target;
      const result = await debuggerApi.sendCommand(target, method, params);
      assertStateActive(state);
      check();
      return result;
    } catch (error) {
      assertStateActive(state);
      check();
      throw error;
    } finally {
      finishPhase?.();
    }
  }

  function runReleasedError(tabId: unknown, sessionId: string, runId: string) {
    return new ToolExecutionError(
      "CDP_RUN_RELEASED",
      "The Agent run has ended and can no longer acquire browser control",
      { tabId: Number(tabId) || null, sessionId, runId },
    );
  }

  function positiveTabId(tabId: unknown) {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ToolExecutionError("SESSION_TAB_TARGET_REQUIRED", "CDP requires a valid tabId", {
        tabId: Number.isFinite(id) ? id : null,
      });
    }
    return id;
  }

  return Object.freeze({
    ensureDebugger,
    confirmRunReattach,
    sendCdp,
    evaluateCdpScript,
    withDebugger,
    withTemporaryDebugger,
    releaseRun,
    releaseSession,
    releaseTab,
    setDebuggerRetention,
    getDebuggerConnectionId,
    getDebuggerRun,
    releaseDebugger,
  });
}

function isCdpPromiseResult(input: unknown): input is { objectId: string } {
  const value = record(input);
  if (typeof value.objectId !== "string" || !value.objectId || value.type !== "object") return false;
  return value.subtype === "promise"
    || value.className === "Promise"
    || /^Promise\b/.test(String(value.description || ""));
}

/** Errors at ownership, lifecycle, or policy boundaries must never fall back to another page-control channel. */
export function isCdpFallbackForbiddenError(error: unknown) {
  const code = String(record(error).code || "");
  return code === "OPERATION_ABORTED"
    || code === "SECURITY_GUARDRAIL_BLOCKED"
    || code.startsWith("SESSION_TAB_")
    || [
      "CDP_RUN_CONTEXT_REQUIRED",
      "CDP_RUN_RELEASED",
      "CDP_SESSION_RUNTIME_UNAVAILABLE",
      "CDP_REATTACH_WAIT_CONFLICT",
      "CDP_TAB_LEASE_CONFLICT",
    ].includes(code);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
