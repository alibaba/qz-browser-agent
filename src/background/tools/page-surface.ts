type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

async function outerSize(tabId: number) {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const view = globalThis as unknown as { outerWidth: number; outerHeight: number };
        return { width: view.outerWidth, height: view.outerHeight };
      },
    });
    const value = frame?.result;
    if (!value) return null;
    return { width: Number(value.width) || 0, height: Number(value.height) || 0 };
  } catch {
    return null;
  }
}

function laidOut(size: { width: number; height: number } | null) {
  return !!size && size.width > 0 && size.height > 0;
}

/** A background tab drops CDP mouse input until Chrome has composited it. One capture does that. */
export async function ensurePageSurface(tabId: number, send: Send) {
  const size = await outerSize(tabId);
  // An unreadable size is not evidence the surface is missing.
  if (!size || laidOut(size)) return;
  try {
    await send("Page.captureScreenshot", { format: "jpeg", quality: 1, fromSurface: true, captureBeyondViewport: false });
  } catch {
    // The discarded frame only nudges layout. The tab stays in the background.
  }
}

interface ReceiptOp { n: number }
interface ReceiptBook { ops: Record<string, ReceiptOp> }
interface ArmedFrame { frameId: number; documentId: string }
interface ReceiptFrame { frameId: number; documentId: string; result: unknown }

// The previous extension stored `__qzInputReceiptBound` and its own listeners.
// Reusing that flag skips installation, so every later count stays at zero.
const armedFrames = new Map<string, ArmedFrame[]>();

/** Arm one operation in every frame. An empty id means the page could not be armed. */
export async function armPageInputReceipt(tabId: number) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const frames = await receiptFrames(tabId, id, true);
  const armed = frames.filter(frame => Number.isInteger(frame.frameId) && frame.frameId >= 0
    && typeof frame.result === "number" && Number.isFinite(frame.result));
  if (!armed.length) return "";
  armedFrames.set(id, armed.map(frame => ({ frameId: frame.frameId, documentId: frame.documentId })));
  return id;
}

/** Count this operation across the frames armed for it. Null means the result cannot be confirmed. */
export async function readPageInputReceipt(tabId: number, receiptId = "") {
  if (!receiptId) return null;
  const expected = armedFrames.get(receiptId);
  if (!expected?.length) return null;
  try {
    return aggregateReceipts(expected, await receiptFrames(tabId, receiptId, false));
  } finally {
    armedFrames.delete(receiptId);
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

async function receiptFrames(tabId: number, receiptId: string, arm: boolean): Promise<ReceiptFrame[]> {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      args: [receiptId, arm],
      func: (opId: string, shouldArm: boolean) => {
        const root = globalThis as unknown as {
          addEventListener: (type: string, listener: (event: { isTrusted: boolean }) => void, capture: boolean) => void;
          document: {
            __qzInputReceiptsV2Bound?: boolean;
            __qzInputReceiptsV2?: ReceiptBook;
          };
        };
        const doc = root.document;
        if (!doc) return null;
        const ops = () => doc.__qzInputReceiptsV2?.ops;
        if (!shouldArm) {
          const book = ops();
          const op = book?.[opId];
          // This document never armed the operation. Navigation is not a missed click.
          if (!book || !op || typeof op.n !== "number") return null;
          const count = op.n;
          delete book[opId];
          return count;
        }
        if (!doc.__qzInputReceiptsV2Bound) {
          doc.__qzInputReceiptsV2Bound = true;
          const count = (event: { isTrusted: boolean }) => {
            if (!event.isTrusted) return;
            const open = ops();
            if (!open) return;
            for (const op of Object.values(open)) {
              if (op && typeof op.n === "number") op.n += 1;
            }
          };
          // pointerdown preventDefault suppresses mousedown; the click still runs.
          for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) root.addEventListener(type, count, true);
        }
        const book = doc.__qzInputReceiptsV2 || (doc.__qzInputReceiptsV2 = { ops: {} });
        book.ops[opId] = { n: 0 };
        return 0;
      },
    });
    return frames.map(frame => ({
      frameId: Number(frame?.frameId),
      documentId: String(frame?.documentId || ""),
      result: frame?.result,
    }));
  } catch {
    return [];
  }
}
