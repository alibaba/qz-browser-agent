import { t } from "../../shared/i18n/backend.js";
import { normalizeSessionId } from "../../shared/session/session-store.js";
import { createKeyedSerialQueue } from "../internal/serial-queue.js";

import type { AgentEvent } from '../../shared/contracts/agent-event.js';
export interface AgentLease { readonly sessionId: string; readonly epoch: number; isActive(): boolean }
export interface SupervisorAgent {
  readonly isRunning?: boolean;
  isStreaming?: boolean;
  messages?: unknown[];
  subscribe?(listener: (event: AgentEvent) => unknown): (() => void) | void;
  getRunState?(): { runId?: string | null; [field: string]: unknown };
  getAbortSignal?(): AbortSignal | null;
  exportSession?(): unknown;
  discardUnstartedPrompt?(): { clientMessageId: string } | null;
  hasPendingUserInput?(): boolean;
  waitForIdle?(): Promise<unknown>;
  abort?(reason: string): unknown;
}
export interface SessionTask {
  sessionId: string; epoch: number; startedAt: string; cancelled: boolean;
  promise: Promise<unknown> | null; messageId?: string; messageAcceptance?: unknown;
  settled?: boolean;
}
interface UserWait {
  sessionId: string; waitId: string; runId: string; epoch: number;
  signal: AbortSignal | null; onSettled: ((reason: string) => void) | null;
  abortHandler: () => void; resolve(value: unknown): void; reject(error: unknown): void; settled: boolean;
}
export interface SessionHandle<A extends SupervisorAgent> {
  sessionId: string; epoch: number; agent: A | null; lease: AgentLease | null;
  ready: Promise<unknown> | null; unsubscribe: (() => void) | null; task: SessionTask | null;
  wait: UserWait | null; runtime: Record<string, unknown> | null; activeRunId: string; lastEventSeq: number;
}
type ActiveHandle<A extends SupervisorAgent> = SessionHandle<A> & { agent: A; lease: AgentLease };
interface Revocation<A extends SupervisorAgent> {
  sessionId: string; epoch: number; agent: A | null; task: SessionTask | null;
  liveState: { runId?: string | null; [field: string]: unknown }; activeRunId: string; conversation: unknown;
  hasHistory: boolean; hadAgent: boolean; hadTask: boolean;
  discardedPrompt: { clientMessageId: string } | null;
}
interface RevokeOptions<A extends SupervisorAgent> {
  abort?: boolean; reason?: string; beforeRelease?: ((snapshot: Revocation<A>) => unknown | Promise<unknown>) | null;
  admissionSignal?: AbortSignal;
}
interface TaskContext<A extends SupervisorAgent> { agent: A; task: SessionTask; entry: ActiveHandle<A> }
interface TaskOptions<A extends SupervisorAgent> { startedAt?: string; onStart?: ((context: TaskContext<A>) => unknown) | null }
export interface MessageAdmission { disposition: "started" | "queued"; duplicate: boolean; task?: SessionTask; message?: unknown; [field: string]: unknown }
interface ExistingMessage { disposition: "started" | "queued"; message?: unknown }
interface MessageOptions<A extends SupervisorAgent> extends TaskOptions<A> {
  executor(context: TaskContext<A>): unknown;
  enqueue(context: { agent: A; entry: ActiveHandle<A> }): Promise<Record<string, unknown>> | Record<string, unknown>;
  findExisting?: ((context: { agent: A; entry: ActiveHandle<A> }) => ExistingMessage | null | Promise<ExistingMessage | null>) | null;
  messageId?: string; acceptance?: unknown;
}

/** Owns every live, per-Session lifecycle fact and Agent write authority. */
export function createSessionSupervisor<A extends SupervisorAgent>({
  createAgent,
  initializeAgent = async () => {},
  onAgentEvent = () => {},
  logger = console,
}: {
  createAgent(lease: AgentLease): A;
  initializeAgent?: (agent: A, sessionId: string, lease: AgentLease) => unknown;
  onAgentEvent?: (sessionId: string, event: AgentEvent) => unknown;
  logger?: Pick<Console, "warn" | "error">;
}) {
  if (typeof createAgent !== "function") throw new TypeError("createAgent is required");
  if (typeof initializeAgent !== "function") throw new TypeError("initializeAgent must be a function");
  if (typeof onAgentEvent !== "function") throw new TypeError("onAgentEvent must be a function");

  const handles = new Map<string, SessionHandle<A>>();
  const commandQueues = createKeyedSerialQueue();

  function peekEntry(sessionId: string) {
    return handles.get(requireSessionId(sessionId)) || null;
  }

  function getEntry(sessionId: string) {
    const id = requireSessionId(sessionId);
    let handle = handles.get(id);
    if (!handle) {
      handle = createHandle(id);
      handles.set(id, handle);
    }
    ensureAgent(handle);
    return handle;
  }

  async function getAgent(sessionId: string) {
    return withAgent(sessionId, agent => agent);
  }

  /** Serialize state commands without creating or hydrating an Agent. */
  function withRuntime<T>(sessionId: string, operation: (entry: SessionHandle<A> | null) => T | PromiseLike<T>) {
    if (typeof operation !== "function") throw new TypeError("runtime operation must be a function");
    const id = requireSessionId(sessionId);
    return commandQueues.run(id, () => operation(handles.get(id) || null));
  }

  async function withAgent<T>(sessionId: string, operation: (agent: A, entry: ActiveHandle<A>) => T | PromiseLike<T>) {
    if (typeof operation !== "function") throw new TypeError("agent operation must be a function");
    const id = requireSessionId(sessionId);
    return commandQueues.run(id, async () => {
      const entry = getEntry(id);
      await entry.ready;
      assertCurrentEntry(entry);
      return operation(entry.agent, entry);
    });
  }

  async function startTask(sessionId: string, executor: (context: TaskContext<A>) => unknown, { startedAt = "", onStart = null }: TaskOptions<A> = {}) {
    if (typeof executor !== "function") throw new TypeError("task executor must be a function");
    const id = requireSessionId(sessionId);
    return commandQueues.run(id, async () => {
      const entry = getEntry(id);
      await entry.ready;
      assertCurrentEntry(entry);
      if (hasActiveWork(entry)) {
        throw codedError("SESSION_ALREADY_RUNNING", `session is already running: ${id}`);
      }
      return startEntryTask(entry, executor, { startedAt, onStart });
    });
  }

  /** Atomically joins, starts, or queues one ordinary user message for a Session. */
  async function submitMessage(sessionId: string, {
    executor,
    enqueue,
    findExisting = null,
    messageId = "",
    acceptance = null,
    startedAt = "",
    onStart = null,
  }: MessageOptions<A>): Promise<MessageAdmission> {
    if (typeof executor !== "function") throw new TypeError("message executor must be a function");
    if (typeof enqueue !== "function") throw new TypeError("message enqueue must be a function");
    const id = requireSessionId(sessionId);
    return commandQueues.run<MessageAdmission>(id, async () => {
      const entry = getEntry(id);
      await entry.ready;
      assertCurrentEntry(entry);
      const existing = typeof findExisting === "function"
        ? await findExisting({ agent: entry.agent, entry })
        : null;
      if (existing && typeof existing === "object") return { ...existing, duplicate: true };
      const idempotencyKey = String(messageId || "").trim();
      if (idempotencyKey && isTaskActive(entry.task) && entry.task.messageId === idempotencyKey) {
        return { disposition: "started", duplicate: true, task: entry.task };
      }
      if (hasActiveWork(entry)) {
        const queued = await enqueue({ agent: entry.agent, entry });
        return { ...queued, disposition: "queued", duplicate: false };
      }
      const task = await startEntryTask(entry, executor, { startedAt, onStart });
      task.messageId = idempotencyKey;
      task.messageAcceptance = acceptance;
      return { disposition: "started", duplicate: false, task };
    });
  }

  async function revoke(sessionId: string, {
    abort = true,
    reason = "revoked",
    beforeRelease = null,
    admissionSignal,
  }: RevokeOptions<A> = {}) {
    const id = requireSessionId(sessionId);
    return commandQueues.run(id, async () => {
      admissionSignal?.throwIfAborted();
      const entry = handles.get(id);
      if (!entry) {
        const snapshot = emptyRevocation(id);
        if (typeof beforeRelease === "function") await beforeRelease(snapshot);
        return snapshot;
      }
      return revokeEntry(entry, { abort, reason, beforeRelease, admissionSignal });
    });
  }

  async function remove(sessionId: string, options: RevokeOptions<A> = {}) {
    const id = requireSessionId(sessionId);
    return commandQueues.run(id, async () => {
      options.admissionSignal?.throwIfAborted();
      const entry = handles.get(id);
      if (!entry) {
        const snapshot = emptyRevocation(id);
        if (typeof options.beforeRelease === "function") await options.beforeRelease(snapshot);
        return snapshot;
      }
      const snapshot = await revokeEntry(entry, options);
      if (handles.get(id) === entry) handles.delete(id);
      return snapshot;
    });
  }

  async function waitForIdle(sessionId: string) {
    const id = requireSessionId(sessionId);
    const entry = handles.get(id);
    const task = entry?.task;
    if (task?.promise) await task.promise;
    const current = handles.get(id);
    if (current?.ready) await settleReady(current);
    if (current?.agent?.isRunning || current?.agent?.isStreaming) await current.agent.waitForIdle?.();
    return id;
  }

  /** Wait outside the command queue so stop/input remain admissible during task execution. */
  async function waitForTaskRelease(sessionId: string) {
    const id = requireSessionId(sessionId);
    while (true) {
      const task = await commandQueues.run(id, () => handles.get(id)?.task || null);
      if (!task) return;
      // onStart has completed before this serialized read; task cleanup queues before settlement.
      await task.promise?.catch(() => {});
    }
  }

  function isRunCurrent(sessionId: string, runId: string) {
    const id = requireSessionId(sessionId);
    const rid = normalizeRunId(runId);
    if (!rid) return false;
    const entry = handles.get(id);
    return Boolean(entry?.agent && entry.activeRunId === rid);
  }

  function getTask(sessionId: string) {
    return handles.get(requireSessionId(sessionId))?.task || null;
  }

  function getRuntime(sessionId: string) {
    return handles.get(requireSessionId(sessionId))?.runtime || null;
  }

  function setRuntime(sessionId: string, runtime: Record<string, unknown> | null) {
    const id = requireSessionId(sessionId);
    let handle = handles.get(id);
    if (!handle) {
      handle = createHandle(id);
      handles.set(id, handle);
    }
    handle.runtime = runtime && typeof runtime === "object" ? runtime : null;
    return handle.runtime;
  }

  function deleteRuntime(sessionId: string) {
    const id = requireSessionId(sessionId);
    const handle = handles.get(id);
    if (!handle) return false;
    handle.runtime = null;
    if (!handle.agent && !handle.task) handles.delete(id);
    return true;
  }

  function replaceRuntimes(runtimes: Record<string, Record<string, unknown>> = {}) {
    for (const handle of handles.values()) handle.runtime = null;
    for (const [sessionId, runtime] of Object.entries(runtimes || {})) {
      if (runtime && typeof runtime === "object") setRuntime(sessionId, runtime);
    }
    for (const [sessionId, handle] of handles.entries()) {
      if (!handle.runtime && !handle.agent && !handle.task) handles.delete(sessionId);
    }
  }

  function runtimeEntries(): [string, Record<string, unknown>][] {
    return [...handles.values()].flatMap(handle => handle.runtime ? [[handle.sessionId, handle.runtime] as [string, Record<string, unknown>]] : []);
  }

  function getAbortSignal(sessionId: string, runId = "") {
    const entry = handles.get(requireSessionId(sessionId));
    const rid = normalizeRunId(runId);
    if (!entry?.agent || (rid && entry.activeRunId && entry.activeRunId !== rid)) return null;
    return entry.agent.getAbortSignal?.() || null;
  }

  function beginUserWait(sessionId: string, {
    waitId,
    runId = "",
    signal = null,
    onSettled = null,
  }: { waitId: string; runId?: string | null; signal?: AbortSignal | null; onSettled?: ((reason: string) => void) | null }) {
    const id = requireSessionId(sessionId);
    const normalizedWaitId = normalizeWaitId(waitId);
    if (!normalizedWaitId) throw new TypeError("waitId is required");
    const entry = handles.get(id);
    assertCurrentEntry(entry);
    const normalizedRunId = normalizeRunId(runId);
    if (normalizedRunId && entry.activeRunId && normalizedRunId !== entry.activeRunId) {
      throw codedError("STALE_RUN", `session run is stale: ${id}`);
    }

    if (entry.wait) {
      settleWait(entry.wait, {
        reason: "superseded",
        error: waitError("WAIT_SUPERSEDED", "A newer user wait replaced the previous wait in this session", entry.wait),
      });
    }

    return new Promise<unknown>((resolve, reject) => {
      const wait: UserWait = {
        sessionId: id,
        waitId: normalizedWaitId,
        runId: normalizedRunId || entry.activeRunId || "",
        epoch: entry.epoch,
        signal,
        onSettled: typeof onSettled === "function" ? onSettled : null,
        abortHandler: () => {},
        resolve,
        reject,
        settled: false,
      };
      wait.abortHandler = () => settleWait(wait, {
        reason: "aborted",
        error: waitError("OPERATION_ABORTED", "Operation aborted while waiting for user", wait),
      });
      entry.wait = wait;
      if (signal?.aborted) {
        wait.abortHandler();
      } else {
        signal?.addEventListener?.("abort", wait.abortHandler, { once: true });
      }
    });
  }

  function resolveUserWait({ sessionId = "", waitId = "", payload = null }: { sessionId?: string; waitId?: string; payload?: unknown } = {}) {
    const wait = findWait({ sessionId, waitId });
    if (!wait) return false;
    return settleWait(wait, {
      reason: "user",
      value: payload ?? { continued: true, reason: "user" },
      reject: false,
    });
  }

  function rejectUserWait({ sessionId = "", waitId = "" } = {}) {
    const wait = findWait({ sessionId, waitId });
    if (!wait) return false;
    return settleWait(wait, {
      reason: "cancelled",
      error: waitError("USER_CANCELLED_WAIT", t("session.waitCancelled"), wait),
    });
  }

  function getUserWait(sessionId: string) {
    const entry = handles.get(normalizeOptionalSessionId(sessionId));
    const wait = entry?.wait;
    if (!wait || wait.settled || wait.signal?.aborted || !isCurrentEpoch(entry, wait.epoch)
      || (wait.runId && entry?.activeRunId !== wait.runId)) return null;
    return { sessionId: wait.sessionId, waitId: wait.waitId, runId: wait.runId };
  }

  function isWaitingForUser(sessionId = "") {
    const id = normalizeOptionalSessionId(sessionId);
    if (id) return Boolean(handles.get(id)?.wait);
    return [...handles.values()].some(handle => Boolean(handle.wait));
  }

  function findWait({ sessionId = "", waitId = "" } = {}) {
    const id = normalizeOptionalSessionId(sessionId);
    const normalizedWaitId = normalizeWaitId(waitId);
    if (id) {
      const wait = handles.get(id)?.wait || null;
      return wait && (!normalizedWaitId || wait.waitId === normalizedWaitId) ? wait : null;
    }
    const waits = [...handles.values()].map(handle => handle.wait).filter((wait): wait is UserWait => wait !== null);
    if (normalizedWaitId) return waits.find(wait => wait.waitId === normalizedWaitId) || null;
    return waits.length === 1 ? waits[0] : null;
  }

  function settleWait(wait: UserWait, { reason, value, error = null, reject = true }: {
    reason?: string; value?: unknown; error?: unknown; reject?: boolean;
  } = {}) {
    if (!wait || wait.settled) return false;
    wait.settled = true;
    const entry = handles.get(wait.sessionId);
    if (entry?.wait === wait) entry.wait = null;
    wait.signal?.removeEventListener?.("abort", wait.abortHandler);
    try {
      wait.onSettled?.(String(reason || "resolved"));
    } catch (settleError) {
      logger?.warn?.("session supervisor: wait settlement callback failed", settleError);
    }
    if (reject) wait.reject(error || waitError("USER_WAIT_REJECTED", "User wait was rejected", wait));
    else wait.resolve(value ?? { reason: String(reason || "resolved") });
    return true;
  }

  function has(sessionId: string) {
    return handles.has(requireSessionId(sessionId));
  }

  function hasAgent(sessionId: string) {
    return Boolean(handles.get(requireSessionId(sessionId))?.agent);
  }

  function size() {
    return [...handles.values()].filter(handle => handle.agent).length;
  }

  function createHandle(sessionId: string): SessionHandle<A> {
    return {
      sessionId,
      epoch: 0,
      agent: null,
      lease: null,
      ready: null,
      unsubscribe: null,
      task: null,
      wait: null,
      runtime: null,
      activeRunId: "",
      lastEventSeq: 0,
    };
  }

  async function revokeEntry(entry: SessionHandle<A>, {
    abort = true,
    reason = "revoked",
    beforeRelease = null,
    admissionSignal,
  }: RevokeOptions<A> = {}) {
    await settleReady(entry);
    admissionSignal?.throwIfAborted();
    const agent = entry.agent;
    const task = entry.task;
    const discardedPrompt = agent?.discardUnstartedPrompt?.() || null;
    const liveState = agent?.getRunState?.() || {};
    const messageCount = Array.isArray(agent?.messages) ? agent.messages.length : 0;
    const snapshot = {
      sessionId: entry.sessionId,
      epoch: entry.epoch,
      agent,
      task,
      liveState,
      activeRunId: entry.activeRunId || liveState.runId || "",
      conversation: agent?.exportSession?.() || null,
      hasHistory: messageCount > 1,
      hadAgent: Boolean(agent),
      hadTask: isTaskActive(task),
      discardedPrompt,
    };

    if (task) task.cancelled = true;
    if (entry.wait) {
      settleWait(entry.wait, {
        reason: "aborted",
        error: waitError("OPERATION_ABORTED", "Operation aborted while waiting for user", entry.wait),
      });
    }
    detachAgent(entry);
    entry.task = null;

    if (abort) {
      try {
        agent?.abort?.(reason);
      } catch (error) {
        logger?.warn?.("session supervisor: agent abort failed", error);
      }
    }
    if (typeof beforeRelease === "function") await beforeRelease(snapshot);
    return snapshot;
  }

  function ensureAgent(handle: SessionHandle<A>) {
    if (handle.agent) return handle;
    const epoch = handle.epoch + 1;
    handle.epoch = epoch;
    let agent: A | null = null;
    const lease = Object.freeze({
      sessionId: handle.sessionId,
      epoch,
      isActive: () => {
        const current = handles.get(handle.sessionId);
        return current === handle && current.epoch === epoch && current.agent === agent;
      },
    });
    agent = createAgent(lease);
    if (!agent || typeof agent !== "object") throw new TypeError("createAgent must return an Agent-like object");
    handle.agent = agent;
    handle.lease = lease;
    handle.activeRunId = "";
    handle.lastEventSeq = 0;
    handle.unsubscribe = agent.subscribe?.((event) => acceptAgentEvent(handle, epoch, event)) || null;
    handle.ready = Promise.resolve()
      .then(() => initializeAgent(agent, handle.sessionId, lease))
      .catch((error) => {
        if (isCurrentEpoch(handle, epoch)) detachAgent(handle);
        throw error;
      });
    return handle;
  }

  function acceptAgentEvent(handle: SessionHandle<A>, capturedEpoch: number, event: AgentEvent) {
    if (!isCurrentEpoch(handle, capturedEpoch)) return false;
    const type = event?.type;
    if (typeof type !== "string" || !type) return false;
    const runId = normalizeRunId(event?.runId);
    if (type === "session_pending" || type === "agent_start") {
      if (handle.activeRunId && handle.activeRunId !== runId) return false;
      handle.activeRunId = runId;
      handle.lastEventSeq = 0;
    } else if (runId && handle.activeRunId !== runId) {
      return false;
    }

    const eventSeq = Number(event?.eventSeq);
    if (Number.isFinite(eventSeq)) {
      if (eventSeq <= handle.lastEventSeq) return false;
      handle.lastEventSeq = eventSeq;
    }

    let processing: unknown = null;
    try {
      processing = onAgentEvent(handle.sessionId, {
        ...event,
        ...(type === "queue_update" ? {
          isRunning: Boolean(isTaskActive(handle.task) || handle.agent?.isRunning || handle.agent?.isStreaming),
        } : {}),
      });
    } catch (error) {
      logger?.error?.("session supervisor: agent event failed", error);
    }
    if (type === "agent_end" && (!runId || handle.activeRunId === runId)) {
      handle.activeRunId = "";
      handle.lastEventSeq = 0;
    }
    if (!processing || typeof processing !== "object" || !("then" in processing) || typeof processing.then !== "function") return true;
    return Promise.resolve(processing).then(
      () => true,
      (error) => {
        logger?.error?.("session supervisor: async agent event failed", error);
        return false;
      },
    );
  }

  function detachAgent(handle: SessionHandle<A>) {
    try {
      handle.unsubscribe?.();
    } catch (_error) {}
    handle.unsubscribe = null;
    handle.epoch += 1;
    handle.agent = null;
    handle.lease = null;
    handle.ready = null;
    handle.activeRunId = "";
    handle.lastEventSeq = 0;
  }

  async function settleReady(entry: SessionHandle<A>) {
    if (!entry?.ready) return;
    try {
      await entry.ready;
    } catch (_error) {
      // A failed/stale hydrate has already detached the Agent.
    }
  }

  function assertCurrentEntry(entry: SessionHandle<A> | null | undefined): asserts entry is ActiveHandle<A> {
    if (!entry?.agent || handles.get(entry.sessionId) !== entry || !entry.lease?.isActive()) {
      throw codedError("STALE_AGENT", `session agent is stale: ${entry?.sessionId || ""}`);
    }
  }

  async function startEntryTask(entry: ActiveHandle<A>, executor: (context: TaskContext<A>) => unknown, { startedAt = "", onStart = null }: TaskOptions<A> = {}) {
    const task: SessionTask = {
      sessionId: entry.sessionId,
      epoch: entry.epoch,
      startedAt: String(startedAt || ""),
      cancelled: false,
      promise: null,
    };
    entry.task = task;
    try {
      if (typeof onStart === "function") await onStart({ agent: entry.agent, task, entry });
    } catch (error) {
      if (entry.task === task) entry.task = null;
      throw error;
    }
    task.promise = Promise.resolve()
      .then(() => executor({ agent: entry.agent, task, entry }))
      .finally(() => {
        task.settled = true;
        void commandQueues.run(entry.sessionId, () => {
          const current = handles.get(entry.sessionId);
          if (current === entry && current.task === task) current.task = null;
        });
      });
    return task;
  }

  return Object.freeze({
    getEntry,
    peekEntry,
    getAgent,
    withAgent,
    withRuntime,
    startTask,
    submitMessage,
    revoke,
    remove,
    waitForIdle,
    waitForTaskRelease,
    isRunCurrent,
    getTask,
    getRuntime,
    setRuntime,
    deleteRuntime,
    replaceRuntimes,
    runtimeEntries,
    getAbortSignal,
    beginUserWait,
    resolveUserWait,
    rejectUserWait,
    isWaitingForUser,
    getUserWait,
    has,
    hasAgent,
    size,
  });
}

function isCurrentEpoch(handle: SessionHandle<SupervisorAgent>, epoch: number) {
  return Boolean(handle?.agent && handle.epoch === epoch && handle.lease?.isActive());
}

function isTaskActive(task: SessionTask | null | undefined): task is SessionTask {
  return Boolean(task && !task.cancelled && !task.settled);
}

function hasActiveWork(entry: SessionHandle<SupervisorAgent>) {
  return Boolean(
    isTaskActive(entry?.task)
    || entry?.agent?.isRunning
    || entry?.agent?.isStreaming
    || entry?.agent?.hasPendingUserInput?.()
  );
}

function emptyRevocation(sessionId: string) {
  return {
    sessionId,
    epoch: 0,
    agent: null,
    task: null,
    liveState: {},
    activeRunId: "",
    conversation: null,
    hasHistory: false,
    hadAgent: false,
    hadTask: false,
    discardedPrompt: null,
  };
}

function requireSessionId(value: unknown) {
  const id = normalizeSessionId(value);
  if (!id) throw new TypeError("sessionId is required");
  return id;
}

function normalizeRunId(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWaitId(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalSessionId(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function waitError(code: string, message: string, wait: Partial<UserWait> = {}) {
  return Object.assign(codedError(code, message), { details: {
    sessionId: String(wait.sessionId || ""),
    waitId: String(wait.waitId || ""),
    runId: String(wait.runId || ""),
  } });
}
