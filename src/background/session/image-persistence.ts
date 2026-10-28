import type { StorageAdapter } from "../internal/storage.js";
import { sweepHistoryImages } from "../../shared/asset-store.js";
import { collectSessionImageReferences, persistSessionImages } from "../../shared/session/session-image-assets.js";

const owners = new WeakMap<StorageAdapter, ReturnType<typeof createOwner>>();

/** Background repositories are the sole writers of persisted Session image references.
 * Writes run concurrently across Sessions; only mark-and-sweep takes an exclusive barrier.
 */
export function sessionImagePersistence(storage: StorageAdapter) {
  let owner = owners.get(storage);
  if (!owner) owners.set(storage, owner = createOwner(storage));
  return owner;
}

function createOwner(storage: StorageAdapter) {
  let barrier: Promise<unknown> = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  // prepareConversation can finish before writeActiveConversation starts. Pin its
  // identifiers (not payloads) until Session deletion; persisted history normally
  // references these too. Retaining ambiguous prepared writes is intentional.
  const prepared = new Map<string, Set<string>>();

  function write<T>(operation: () => Promise<T>): Promise<T> {
    const running = barrier.then(operation);
    active.add(running);
    void running.then(() => active.delete(running), () => active.delete(running));
    return running;
  }

  function sweep() {
    const preceding = [barrier, ...active];
    let release!: () => void;
    barrier = new Promise<void>(resolve => { release = resolve; });
    return Promise.allSettled(preceding).then(async () => {
      // Missing IndexedDB is possible in non-browser hosts. Never infer absence
      // of assets from an unavailable store or a failed storage read.
      if (typeof indexedDB === "undefined") return [];
      const stored = await storage.get(null);
      // Mark ALL keys, including records, active/current checkpoints, runtime
      // queues, drafts and unknown future keys. Uncertainty keeps the image.
      const references = collectSessionImageReferences(stored);
      for (const ids of prepared.values()) for (const id of ids) references.add(id);
      const deleted = await sweepHistoryImages(references);
      // Weak holder entries and the bounded string memo must not reuse an ID
      // whose Blob was swept (e.g. a later clone of a deleted Session).
      persistSessionImages.clear();
      return deleted;
    }).finally(release);
  }

  return {
    write,
    pinPrepared(sessionId: string, snapshot: unknown) {
      let ids = prepared.get(sessionId);
      if (!ids) prepared.set(sessionId, ids = new Set());
      collectSessionImageReferences(snapshot, ids);
    },
    forgetSession(sessionId: string) { prepared.delete(sessionId); },
    sweep,
  };
}
