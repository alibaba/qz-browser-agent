/** Bounded work with stable input-order output, local to one AX observation. */
export async function mapConcurrent<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, concurrency = 4): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  }));
  return results;
}
