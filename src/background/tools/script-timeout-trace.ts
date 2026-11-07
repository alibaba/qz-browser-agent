const reads = new WeakMap<AbortSignal, Promise<unknown[]>>();

/** The execution environment registers this while handling a timeout abort. Settlement awaits it once. */
export function publishTimeoutTrace(signal: AbortSignal | undefined, read: Promise<unknown[]>): void {
  if (!signal) return;
  reads.set(signal, read);
}

/** Last rows captured for this deadline. Missing, failed, or slow reads settle as no rows. */
export async function takeTimeoutTrace(signal: AbortSignal | undefined): Promise<unknown[] | undefined> {
  if (!signal) return undefined;
  const read = reads.get(signal);
  reads.delete(signal);
  if (!read) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rows = await Promise.race([
    read.catch(() => [] as unknown[]),
    new Promise<unknown[]>(resolve => { timer = setTimeout(() => resolve([]), 1000); }),
  ]);
  if (timer) clearTimeout(timer);
  return rows;
}
