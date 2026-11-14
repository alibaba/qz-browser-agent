import { Worker } from "node:worker_threads";

export const STREAM_DEADLINE_MS = 10_000;

/** Streams `deltas` through the real gateway in a worker so a synchronous hang fails within the deadline. */
export function streamInWorker(provider, deltas) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./openai-stream-worker.mjs", import.meta.url), { workerData: { provider, deltas } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`stream did not finish within ${STREAM_DEADLINE_MS}ms`));
    }, STREAM_DEADLINE_MS);
    worker.once("message", result => { clearTimeout(timer); void worker.terminate(); resolve(result); });
    worker.once("error", error => { clearTimeout(timer); reject(error); });
  });
}
