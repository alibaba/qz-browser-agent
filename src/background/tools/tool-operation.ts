import type { ToolOperationEvidence } from "../../sdk/background.js";
import { toolErrorDetails, type ToolErrorDetails } from "../../shared/contracts/tool-error.js";
import { copyToolResultPresentation } from "../../shared/contracts/tool-result-presentation.js";
import { localizeToolTimeoutMessage } from "../../shared/tools/tool-error-localization.js";
import { ToolExecutionError } from "./arguments.js";

/** Every deadline captures its execution evidence before aborting in-flight work. */
export function createToolTimeoutError(tool: string, timeoutMs: number, details: ToolErrorDetails, operation?: ToolOperationEvidence) {
  const evidence = { ...details, timeoutMs, ...operation?.snapshot() };
  return new ToolExecutionError("TOOL_TIMEOUT", localizeToolTimeoutMessage(tool, evidence), evidence);
}

/** A dispatch may have taken effect before its acknowledgement reaches the host. */
export function createToolOperation(): ToolOperationEvidence {
  let identity: ToolErrorDetails | undefined;
  let status: "not_started" | "unconfirmed" | "completed" = "not_started";
  let closed = false;
  return {
    prepare(details) {
      if (!closed && !identity) identity = structuredClone({
        ...(Object.hasOwn(details, "tabRef") ? { tabRef: undefined } : {}), ...toolErrorDetails(details),
      });
    },
    dispatch() { if (!closed && status !== "completed") status = "unconfirmed"; },
    confirm() { if (!closed) status = "completed"; },
    snapshot() {
      return identity ? { ...structuredClone(identity), status,
        ...(status === "unconfirmed" ? {} : { executed: status === "completed" }),
        mayHaveTakenEffect: status !== "not_started", automaticReplay: false,
      } : {};
    },
    close() { closed = true; },
  };
}

/**
 * Argument validation precedes execution. The rejected call reports its own not-started facts, which
 * the facts of an enclosing script or wait do not overwrite.
 */
export function notStartedToolFailure<T>(failure: T, tool: string): T {
  const operation = createToolOperation();
  operation.prepare({ tool });
  return withToolOperationFailure(failure, operation);
}

/** Preserve the original failure and presentation without mutating a shared abort reason. */
export function withToolOperationFailure<T>(failure: T, operation?: ToolOperationEvidence): T {
  const facts = operation?.snapshot();
  if (!facts?.status) return failure;
  const source = failure && typeof failure === "object" ? failure as Record<string, unknown> : {};
  const previous = toolErrorDetails(source.details);
  // A script can fail because a child action failed. Keep that action's facts.
  if (previous.tool && previous.tool !== facts.tool
    && ["not_started", "unconfirmed", "completed"].includes(String(previous.status))) return failure;
  const { executed: _executed, status: _status,
    mayHaveTakenEffect: _mayHaveTakenEffect, automaticReplay: _automaticReplay, ...details } = previous;
  // DOMException accessors require native internal slots, even when it is also an Error.
  const result = failure instanceof DOMException
    ? Object.assign(new DOMException(failure.message, failure.name), failure, { stack: failure.stack })
    : failure instanceof Error
    ? Object.setPrototypeOf(Object.assign(new Error(failure.message), failure, { name: failure.name, stack: failure.stack }), Object.getPrototypeOf(failure))
    : failure && typeof failure === "object" ? { ...source } : new Error(String(failure));
  return copyToolResultPresentation(failure, Object.assign(result, {
    details: { ...details, ...facts, ...(details.pending ? { pending: details.pending } : {}) },
  })) as T;
}
