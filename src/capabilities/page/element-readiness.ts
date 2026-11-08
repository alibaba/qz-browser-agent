import { ToolExecutionError } from "#sdk/background/tools";
import type { ElementReply } from "#sdk/shared/browser";

interface ElementReadiness {
  inspect(): Promise<ElementReply>;
  prepare?(inspection: ElementReply): Promise<ElementReply>;
  confirm?(inspection: ElementReply): Promise<ElementReply>;
  readiness(inspection: ElementReply): string | undefined;
  target: string;
  signal?: AbortSignal;
  deadline?: number;
  stable?: boolean;
}

function geometry(inspection: ElementReply): number[] | undefined {
  const rect = inspection.rect as Record<string, unknown> | undefined;
  if (!rect) return;
  const values = [rect.x, rect.y, rect.width ?? rect.w, rect.height ?? rect.h];
  if (!values.every(value => typeof value === "number" && Number.isFinite(value))) return;
  if (inspection.clickablePoint) values.push(inspection.clickablePoint.x, inspection.clickablePoint.y);
  return values as number[];
}

/** Compare the observed hit point as well as the element's bounds. */
export function sameElementGeometry(before: ElementReply, after: ElementReply) {
  const left = geometry(before), right = geometry(after);
  const sameRect = !left && !right || !!left && !!right && left.length === right.length
    && left.every((value, index) => Math.abs(value - right[index]!) <= 0.5);
  const a = before.clickablePoint, b = after.clickablePoint;
  return sameRect && (!a && !b || !!a && !!b && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5);
}

function pause(milliseconds: number, signal?: AbortSignal) {
  assertNotAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
    const aborted = () => { cleanup(); try { assertNotAborted(signal); } catch (error) { reject(error); } };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  if (signal.reason?.name === "AbortError") throw new ToolExecutionError("OPERATION_ABORTED", "Element preparation was cancelled.");
  throw signal.reason;
}

/** Wait only before input delivery; this helper never dispatches or retries an action. */
export async function waitForElementReady({
  inspect, prepare, confirm, readiness, target, signal, deadline = Date.now() + 5_000, stable = false,
}: ElementReadiness): Promise<ElementReply> {
  let prepared = false;
  let previous: number[] | undefined;
  let reason = "not observed";
  const assertCurrent = () => {
    assertNotAborted(signal);
    if (Date.now() >= deadline) throw Object.assign(new ToolExecutionError(
      "ELEMENT_NOT_READY", "Element did not become ready before the action deadline.", { target, reason },
    ), { hint: "Inspect the target and page state, then retry with a suitable timeout." });
  };
  while (true) {
    assertCurrent();
    let inspection = await inspect();
    assertCurrent();
    if (!inspection.error && !inspection.code && !prepared && prepare) {
      prepared = true;
      inspection = await prepare(inspection);
      assertCurrent();
    }
    if (inspection.error || inspection.code) {
      if (!["ELEMENT_NOT_FOUND", "NO_CLICKABLE_TARGET"].includes(String(inspection.code))) return inspection;
      reason = "element not found";
      previous = undefined;
    } else {
      const pending = readiness(inspection);
      const current = stable && !pending ? geometry(inspection) : undefined;
      const stationary = !current || previous?.length === current.length
        && current.every((value, index) => Math.abs(value - previous![index]!) <= 0.5);
      if (!pending && stationary) {
        if (!confirm) return inspection;
        const confirmed = await confirm(inspection);
        assertCurrent();
        if ((confirmed.error || confirmed.code) && !["ELEMENT_NOT_FOUND", "NO_CLICKABLE_TARGET"].includes(String(confirmed.code))) return confirmed;
        const blocked = confirmed.error || confirmed.code ? "element not found" : readiness(confirmed);
        if (!blocked && sameElementGeometry(inspection, confirmed)) return confirmed;
        reason = blocked || "element moved after pointer preparation";
        previous = undefined;
        await pause(Math.min(50, Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      reason = pending || "element is moving";
      previous = current;
    }
    await pause(Math.min(50, Math.max(0, deadline - Date.now())), signal);
  }
}
