import { createSerialQueue } from "../internal/serial-queue.js";
import {
  CHROME_STORE_REVIEW_STORAGE_KEY,
  finishChromeStoreReview,
  normalizeChromeStoreReviewRecord,
  recordCompletedTask,
  type ChromeStoreReviewRecord,
} from "../../shared/chrome-store-review.js";

interface ReviewStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

/** Counts successful root-session task finishes and remembers when the review card is finished. */
export function createChromeStoreReviewStore({
  storage,
  isRootSession,
}: {
  storage: ReviewStorage;
  isRootSession(sessionId: string): Promise<boolean> | boolean;
}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("Chrome Web Store review store requires storage");
  }
  if (typeof isRootSession !== "function") throw new TypeError("isRootSession is required");
  const writes = createSerialQueue();

  async function read(): Promise<ChromeStoreReviewRecord> {
    const stored = await storage.get(CHROME_STORE_REVIEW_STORAGE_KEY);
    return normalizeChromeStoreReviewRecord(stored[CHROME_STORE_REVIEW_STORAGE_KEY]);
  }

  function recordCompletion(sessionId: string, runtime: { runId?: unknown; endedAt?: unknown } = {}) {
    return writes.run(async () => {
      if (!await isRootSession(sessionId)) return null;
      const current = await read();
      const next = recordCompletedTask(current, { sessionId, runId: runtime.runId, endedAt: runtime.endedAt });
      if (next.changed) await storage.set({ [CHROME_STORE_REVIEW_STORAGE_KEY]: next.record });
      return next.record;
    });
  }

  function finish(resolution: "dismissed" | "reviewed") {
    return writes.run(async () => {
      const current = await read();
      const next = finishChromeStoreReview(current, resolution);
      if (next.changed) await storage.set({ [CHROME_STORE_REVIEW_STORAGE_KEY]: next.record });
      return next.record;
    });
  }

  return Object.freeze({
    read: () => writes.run(read),
    recordCompletion,
    finish,
    idle: () => writes.onIdle(),
  });
}
