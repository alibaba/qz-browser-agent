import { copyCreatedTabResult } from "../../shared/contracts/page-observation.js";
import { copyToolResultPresentation } from "../../shared/contracts/tool-result-presentation.js";
import type { ToolEffect } from "../../shared/contracts/tool.js";
import type { ToolContext } from "../../sdk/background.js";

interface Ticket { effects: readonly ToolEffect[]; sessionId: string; runId: string; consumed: boolean }
const tickets = new WeakMap<object, readonly Ticket[]>();
const object = (value: unknown): value is object => value !== null && typeof value === "object";

/** Effects are private execution receipts, never inferred from a serializable result field. */
export function issueToolEffects(result: unknown, effects: readonly ToolEffect[], context: ToolContext): void {
  if (!object(result) || !effects.length) return;
  tickets.set(result, [...tickets.get(result) || [], {
    effects: Object.freeze(effects.map(effect => Object.freeze({ ...effect }))),
    sessionId: context.sessionId || "", runId: context.runId || "", consumed: false,
  }]);
}

/** A trusted adapter may wrap the same result; all copies share one consumable receipt. */
export function copyToolEffects<T>(source: unknown, target: T): T {
  if (object(source) && object(target) && tickets.has(source)) tickets.set(target, tickets.get(source)!);
  return copyToolResultPresentation(source, copyCreatedTabResult(source, target));
}

export function consumeToolEffects(result: unknown, context: ToolContext): readonly ToolEffect[] {
  if (!object(result)) return [];
  const effects: ToolEffect[] = [];
  for (const ticket of tickets.get(result) || []) {
    if (ticket.consumed || ticket.sessionId !== (context.sessionId || "") || ticket.runId !== (context.runId || "")) continue;
    ticket.consumed = true;
    effects.push(...ticket.effects);
  }
  return effects;
}
