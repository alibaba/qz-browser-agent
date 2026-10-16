import { setTimeout as delay } from "node:timers/promises";

const STOP_STATUSES = new Set(["completed", "error", "failed", "aborted", "cancelled", "interrupted"]);
const ACTIVE_STATUSES = new Set(["pending", "running", "waiting_user", "paused"]);
const INPUT_STATUSES = new Set(["waiting_user", "paused"]);
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function taskStatus(snapshot) {
  const status = String(snapshot.status || snapshot.runtime?.status || snapshot.state?.status || "").trim();
  if (status === "waitingUser") return "waiting_user";
  return status.toLowerCase() === "canceled" ? "cancelled" : status.toLowerCase();
}

function assistantText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part?.type === "text")
    .map(part => String(part.text ?? "")).join("\n") : "";
}

function messageIdentity(entry, index, runId) {
  const scope = String(entry.runId || runId || "");
  const identity = entry.spanId ? `span:${entry.spanId}` : entry.id ? `id:${entry.id}`
    : entry.eventSeq != null ? `event:${entry.eventSeq}` : `index:${index}`;
  return `${scope}/${identity}`;
}

function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(operation).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Observe snapshots only: timeout, interruption, and polling failures never cancel or restart a browser task.
 * User input pauses execution, not observation; input events expose each pending request.
 * Total observation is unlimited by default; each snapshot request has its own finite deadline.
 * getSnapshot must request compact:false and tail:false so transcript identities and streaming text survive.
 */
export async function waitForTask({ sessionId, clientId, timeoutSeconds = null, requestTimeoutSeconds = 180, signal, getSnapshot, onUpdate,
  pollIntervalMs = 750, expectedRunId = "", expectedMessageId = "", previousRunId = "", ignoreWaitId = "", allowIdle = false } = {}) {
  if (!String(sessionId || "").trim()) throw new TypeError("sessionId is required");
  if (typeof getSnapshot !== "function") throw new TypeError("getSnapshot is required");
  if (timeoutSeconds !== null && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) throw new TypeError("timeoutSeconds must be positive or null");
  if (!Number.isFinite(requestTimeoutSeconds) || requestTimeoutSeconds <= 0) throw new TypeError("requestTimeoutSeconds must be positive");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new TypeError("pollIntervalMs must be non-negative");
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = timeoutSeconds === null ? null : Date.now() + timeoutSeconds * 1000;
  const timeout = new DOMException(`Timed out waiting for task ${sessionId}. The browser task may still be running.`, "TimeoutError");
  const timer = timeoutSeconds === null ? null : setTimeout(() => controller.abort(timeout), Math.max(1, Math.ceil(timeoutSeconds * 1000)));
  const checkActive = () => {
    if (deadline !== null && Date.now() >= deadline) controller.abort(timeout);
    activeSignal.throwIfAborted();
  };
  const pollingDelay = () => delay(deadline === null ? pollIntervalMs : Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
    undefined, { signal: activeSignal });
  const readSnapshot = async () => {
    checkActive();
    const milliseconds = Math.max(1, Math.ceil(requestTimeoutSeconds * 1000));
    const requestDeadline = Date.now() + milliseconds;
    const requestExpiresFirst = deadline === null || requestDeadline < deadline;
    const requestTimeout = Object.assign(new Error(`Reading task ${sessionId} timed out after ${requestTimeoutSeconds} seconds. Check the browser connection, then resume watching this task.`),
      { code: "request_timeout" });
    // A request timeout ends observation too. One controller preserves the first reason,
    // and equal deadlines belong to the total timer. Downstream keeps its full request budget.
    const requestTimer = requestExpiresFirst ? setTimeout(() => controller.abort(requestTimeout), milliseconds) : null;
    const checkRequest = () => {
      if (requestExpiresFirst && Date.now() >= requestDeadline) controller.abort(requestTimeout);
      checkActive();
    };
    try {
      const snapshot = await abortable(() => getSnapshot({ sessionId, clientId, signal: activeSignal, timeoutSeconds: requestTimeoutSeconds }), activeSignal);
      checkRequest();
      return snapshot;
    } catch (error) {
      // Synchronous work can cross a deadline before its timer gets an event-loop turn.
      checkRequest();
      throw error;
    } finally {
      clearTimeout(requestTimer);
    }
  };
  const messages = new Map();
  let selectedRunId = String(expectedRunId || "");
  let observedRun = false;
  let observedActivity = false;
  let awaitingMessage = Boolean(expectedMessageId);
  let messageRunId = "";
  let awaitingResume = Boolean(ignoreWaitId);
  let lastStatus = "";
  let lastInput = "";
  const emit = async update => {
    if (onUpdate) await abortable(() => onUpdate(update), activeSignal);
  };
  const emitStatus = async (status, runId, runtime) => {
    const update = { type: "status", sessionId, runId, status,
      currentToolName: String(runtime.currentToolName || ""), waitTitle: String(runtime.waitTitle || ""),
      waitMessage: String(runtime.waitMessage || ""), waitId: String(runtime.waitId || ""), reason: String(runtime.reason || "") };
    const signature = JSON.stringify(update);
    if (signature !== lastStatus) { lastStatus = signature; await emit(update); }
  };
  const emitInput = async (status, runId, runtime, canonicalInput) => {
    if (!INPUT_STATUSES.has(status) || (canonicalInput && canonicalInput.waiting !== true)) return;
    const form = record(runtime.waitForm);
    const input = { ...(canonicalInput || { waiting: true,
      waitId: String(runtime.waitId || ""), title: String(runtime.waitTitle || form.title || ""),
      message: String(runtime.waitMessage || ""), form,
      ...(form.browserPermission ? { kind: "browser_permission", requiresUserAction: true } : {}),
    }), type: "input", sessionId, runId, ...(clientId ? { clientId } : {}) };
    const signature = JSON.stringify(input);
    if (signature !== lastInput) { lastInput = signature; await emit(input); }
  };
  try {
    while (true) {
      checkActive();
      const snapshot = record(await readSnapshot());
      checkActive();
      if (snapshot.sessionId && snapshot.sessionId !== sessionId) {
        throw Object.assign(new Error("The task snapshot belongs to a different session."), { code: "task_changed" });
      }
      if (Object.hasOwn(snapshot, "session") && snapshot.session === null) {
        throw Object.assign(new Error("The task was deleted while waiting for its result."), { code: "task_deleted" });
      }
      const runtime = record(snapshot.runtime);
      const canonicalInput = Object.hasOwn(snapshot, "input") ? record(snapshot.input) : null;
      const runId = String(snapshot.runId || runtime.runId || snapshot.state?.runId || "");
      const status = taskStatus(snapshot);
      if (!status) {
        throw Object.assign(new Error("The task snapshot has no status. Check the browser connection, then resume watching this task."),
          { code: "invalid_response" });
      }
      const transcript = Array.isArray(snapshot.transcript) ? snapshot.transcript : Array.isArray(snapshot.tail) ? snapshot.tail : [];
      const submittedMessageIndex = expectedMessageId
        ? transcript.findIndex(entry => entry?.type === "user" && entry.clientMessageId === expectedMessageId) : -1;
      if (awaitingMessage) {
        const message = transcript[submittedMessageIndex];
        if (message?.runId) {
          messageRunId = String(message.runId);
          selectedRunId = messageRunId;
          awaitingMessage = false;
        } else {
          // A queued message may wait behind an earlier run's question or permission.
          // Keep that input actionable, but never mistake its answer for this message's result.
          if (status !== "completed") await emitStatus(status, runId, runtime);
          await emitInput(status, runId, runtime, canonicalInput);
          if (STOP_STATUSES.has(status) && status !== "completed") return snapshot;
          await pollingDelay();
          continue;
        }
      }
      const previous = previousRunId && (!runId || runId === previousRunId);
      const awaitedRunId = messageRunId || expectedRunId;
      const awaitingExpected = awaitedRunId && runId !== awaitedRunId;
      const targetIndex = submittedMessageIndex >= 0 ? submittedMessageIndex
        : awaitedRunId ? transcript.findIndex(entry => entry?.runId === awaitedRunId) : -1;
      // A fast queued run can finish before the first poll. A later accepted user message
      // distinguishes that replacement from an older runtime snapshot still catching up.
      const passedTarget = awaitingExpected && runId && targetIndex >= 0
        && transcript.slice(targetIndex + 1).some(entry => entry?.type === "user" && entry.runId === runId);
      if ((observedRun && runId && selectedRunId !== runId) || passedTarget) {
        throw Object.assign(new Error("A different run replaced the task being watched. Use qz show to inspect its conversation."), {
          code: "task_changed", details: { expectedRunId: selectedRunId || awaitedRunId, actualRunId: runId },
        });
      }
      if (!previous && !awaitingExpected) {
        if (runId) { selectedRunId = runId; observedRun = true; }
        // Resolving a wait and persisting its updated snapshot are separate operations.
        // Ignore that exact old wait until the resumed run or its next wait is visible.
        const oldWait = awaitingResume && status === "waiting_user" && String(canonicalInput?.waitId || runtime.waitId || "") === ignoreWaitId;
        if (oldWait) {
          await pollingDelay();
          continue;
        }
        awaitingResume = false;
        if (ACTIVE_STATUSES.has(status)) observedActivity = true;
        await emitStatus(status, runId, runtime);
        for (const [index, entry] of transcript.entries()) {
          // Steering can continue the same run. Only stream responses after this submitted message.
          if (expectedMessageId && (submittedMessageIndex < 0 || index <= submittedMessageIndex)) continue;
          if (entry?.type !== "assistant" || (entry.runId && selectedRunId && entry.runId !== selectedRunId)) continue;
          const messageId = messageIdentity(entry, index, selectedRunId);
          const fullText = assistantText(entry.content);
          const seen = messages.has(messageId);
          const previousText = messages.get(messageId) || "";
          if (fullText === previousText) continue;
          messages.set(messageId, fullText);
          const append = fullText.startsWith(previousText);
          await emit({ type: append ? "text" : "replace", sessionId, runId: String(entry.runId || runId), messageId,
            text: append ? fullText.slice(previousText.length) : fullText, fullText,
            newMessage: !seen, streaming: entry.streaming === true });
        }
        await emitInput(status, runId, runtime, canonicalInput);
        // A newly created session can report idle before its first run starts.
        if (STOP_STATUSES.has(status) || (status === "idle" && (observedActivity || allowIdle))) return snapshot;
      }
      await pollingDelay();
    }
  } catch (error) {
    if (activeSignal.aborted) throw activeSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
