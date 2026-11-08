type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
const PROBE_TIMEOUT_MS = 1000;

async function probe<T>(read: () => Promise<T>, unknown: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(unknown), PROBE_TIMEOUT_MS); }),
    ]);
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function outerSize(tabId: number) {
  return probe(async () => {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: () => {
        const view = globalThis as unknown as { outerWidth: number; outerHeight: number };
        return { width: view.outerWidth, height: view.outerHeight };
      },
    });
    const value = frame?.result;
    if (!value) return null;
    return { width: Number(value.width) || 0, height: Number(value.height) || 0 };
  }, null);
}

function laidOut(size: { width: number; height: number } | null) {
  return !!size && size.width > 0 && size.height > 0;
}

/** A background tab or child frame can lack an input surface. One capture composites it before dispatch. */
export async function ensurePageSurface(tabId: number, send: Send, { frameId = "" }: { frameId?: string } = {}) {
  const size = frameId ? null : await outerSize(tabId);
  // An unreadable size is not evidence the surface is missing.
  // A laid-out parent does not establish an out-of-process child's input surface.
  if (!frameId && (!size || laidOut(size))) return;
  try {
    await send("Page.captureScreenshot", { format: "jpeg", quality: 1, fromSurface: true, captureBeyondViewport: false });
  } catch (error) {
    if (frameId) throw error;
    // The discarded frame only nudges layout. The tab stays in the background.
  }
}

interface ReceiptOp { n: number; expiresAt: number; timer: number; observeSubmission: boolean }
interface ReceiptBook { ops: Record<string, ReceiptOp> }
interface ArmedFrame { frameId: number; documentId: string }
interface ReceiptFrame { frameId: number; documentId: string; result: unknown }

// The previous extension stored `__qzInputReceiptBound` and its own listeners.
// Reusing that flag skips installation, so every later count stays at zero.
const armedReceipts = new Map<string, ArmedFrame[]>();

/** Arm one operation in every frame. An empty id means the page could not be armed. */
export async function armPageInputReceipt(tabId: number, { observeSubmission = false } = {}) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const frames = await receiptFrames(tabId, id, true, observeSubmission);
  const armed = frames.filter(frame => Number.isInteger(frame.frameId) && frame.frameId >= 0
    && typeof frame.result === "number" && Number.isFinite(frame.result));
  if (!armed.length) return "";
  armedReceipts.set(id, armed.map(frame => ({ frameId: frame.frameId, documentId: frame.documentId })));
  return id;
}

/** Count this operation across the frames armed for it. Null means the result cannot be confirmed. */
export async function readPageInputReceipt(tabId: number, receiptId = "") {
  if (!receiptId) return null;
  const expected = armedReceipts.get(receiptId);
  if (!expected?.length) return null;
  try {
    return aggregateReceipts(expected, await receiptFrames(tabId, receiptId, false));
  } finally {
    armedReceipts.delete(receiptId);
  }
}

function aggregateReceipts(expected: readonly ArmedFrame[], frames: readonly ReceiptFrame[]) {
  const current = new Map<string, unknown>();
  for (const frame of frames) {
    const key = frameKey(frame.frameId, frame.documentId);
    if (!current.has(key)) current.set(key, frame.result);
  }
  let highest = 0;
  let sawNumber = false;
  let unknown = false;
  for (const frame of expected) {
    const key = frameKey(frame.frameId, frame.documentId);
    // A frame that appeared after arm is not in this set. A replaced document is.
    if (!current.has(key)) {
      unknown = true;
      continue;
    }
    const value = current.get(key);
    if (typeof value === "number" && Number.isFinite(value)) {
      sawNumber = true;
      if (value > highest) highest = value;
    } else unknown = true;
  }
  // One delivered frame is enough. A missing armed frame is not a count of zero.
  if (highest > 0) return highest;
  if (unknown || !sawNumber) return null;
  return 0;
}

function frameKey(frameId: number, documentId: string) {
  return `${frameId}:${documentId}`;
}

function receiptWorld(): "MAIN" | "ISOLATED" {
  // Firefox dispatches synthetic input in the isolated world, where isTrusted stays false.
  // Chrome counts trusted events in the page world.
  try {
    const root = chrome.runtime?.getURL?.("") || "";
    return root.startsWith("moz-extension:") ? "ISOLATED" : "MAIN";
  } catch {
    return "MAIN";
  }
}

async function receiptFrames(tabId: number, receiptId: string, arm: boolean, observeSubmission = false): Promise<ReceiptFrame[]> {
  return probe(async () => {
    const world = receiptWorld();
    const details = {
      target: { tabId, allFrames: true },
      world,
      injectImmediately: true,
      args: [receiptId, arm, Date.now() + PROBE_TIMEOUT_MS, world === "ISOLATED", observeSubmission] as [string, boolean, number, boolean, boolean],
      func: (opId: string, shouldArm: boolean, armDeadline: number, acceptExtensionEvents = false, watchSubmission = false) => {
        const root = globalThis as unknown as {
          addEventListener: (type: string, listener: (event: { isTrusted: boolean }) => void, capture: boolean) => void;
          document: {
            defaultView: {
              setTimeout: (callback: () => void, delay: number) => number;
              clearTimeout: (timer: number) => void;
            } | null;
            __qzInputReceiptsV4Bound?: boolean;
            __qzInputReceiptsV4?: ReceiptBook;
          };
          __qzExtensionInputEvents?: { has?(value: object): boolean };
        };
        const doc = root.document;
        if (!doc?.defaultView) return null;
        const ops = () => doc.__qzInputReceiptsV4?.ops;
        if (!shouldArm) {
          const book = ops();
          const op = book?.[opId];
          // This document never armed the operation. Navigation is not a missed click.
          if (!book || !op || typeof op.n !== "number") return null;
          const count = op.expiresAt <= Date.now() ? null : op.n;
          doc.defaultView.clearTimeout(op.timer);
          delete book[opId];
          return count;
        }
        // executeScript can finish after the caller timed out or navigated away.
        if (Date.now() >= armDeadline) return null;
        if (!doc.__qzInputReceiptsV4Bound) {
          doc.__qzInputReceiptsV4Bound = true;
          const pointers = ["pointerdown", "mousedown", "touchstart", "click"];
          // Same-document submit counts. beforeunload and pagehide do not.
          const submissions = ["submit"];
          const count = (event: { isTrusted: boolean }, type: string) => {
            if (!event.isTrusted) {
              if (!acceptExtensionEvents) return;
              const marked = (globalThis as { __qzExtensionInputEvents?: { has?(value: object): boolean } }).__qzExtensionInputEvents;
              if (marked?.has?.(event) !== true) return;
            }
            const open = ops();
            if (!open) return;
            for (const op of Object.values(open)) {
              if (op && typeof op.n === "number"
                && (pointers.includes(type) || (op.observeSubmission && submissions.includes(type)))) op.n += 1;
            }
          };
          // pointerdown preventDefault suppresses mousedown; the click still runs.
          for (const type of [...pointers, ...submissions]) root.addEventListener(type, event => count(event, type), true);
        }
        const book = doc.__qzInputReceiptsV4 || (doc.__qzInputReceiptsV4 = { ops: {} });
        // A timed-out arm has no receipt id to read back. Expire it in the page.
        book.ops[opId] = {
          observeSubmission: watchSubmission,
          n: 0,
          expiresAt: Date.now() + 30000,
          timer: doc.defaultView.setTimeout(() => { delete book.ops[opId]; }, 30000),
        };
        return 0;
      },
    };
    let frames;
    try {
      frames = await chrome.scripting.executeScript(details);
    } catch (error) {
      if (world !== "ISOLATED") throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/world|ISOLATED/i.test(message)) throw error;
      const { world: _world, ...rest } = details;
      frames = await chrome.scripting.executeScript(rest);
    }
    return frames.map(frame => ({
      frameId: Number(frame?.frameId),
      documentId: String(frame?.documentId || ""),
      result: frame?.result,
    }));
  }, []);
}
