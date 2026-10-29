import { getHistoryImage, HISTORY_IMAGE_PREFIX, saveHistoryImage } from "../asset-store.js";

type ImageSlot = { value: string; reference: string };

/** Live holders use weak memoization; fresh transport snapshots use a bounded
 * exact-value memo. Neither cache grows with the lifetime of a conversation.
 * Mutating an image slot invalidates that slot; sweeping invalidates both caches.
 */
export function createSessionImageStorage(save = saveHistoryImage, { maxMemoChars = 32 * 1024 * 1024, maxMemoEntries = 256 } = {}) {
  let slots = new WeakMap<object, Map<string, ImageSlot>>();
  // Transport and codec snapshots can have fresh holders. Exact string keys
  // avoid rehashing them without trusting a lossy prefix/suffix fingerprint.
  // Bound both entries and characters (at most 64 MiB of UTF-16 string data).
  const recent = new Map<string, string>();
  let memoChars = 0;
  function remember(value: string, reference: string) {
    if (value.length > maxMemoChars) return;
    if (recent.delete(value)) memoChars -= value.length;
    recent.set(value, reference);
    memoChars += value.length;
    while (memoChars > maxMemoChars || recent.size > maxMemoEntries) {
      const oldest = recent.keys().next().value!;
      recent.delete(oldest);
      memoChars -= oldest.length;
    }
  }
  async function persist<T>(input: T): Promise<T> {
    const pending = new Map<string, Promise<string>>();
    return mapStrings(input, value => value.startsWith("data:image/"), async (value, holder, key) => {
      const cached = holder && slots.get(holder)?.get(key);
      if (cached?.value === value) return cached.reference;
      const known = recent.get(value);
      if (known) { remember(value, known); return known; }
      let saving = pending.get(value);
      if (!saving) {
        saving = save(value);
        pending.set(value, saving);
      }
      const reference = await saving;
      remember(value, reference);
      if (holder) {
        let fields = slots.get(holder);
        if (!fields) slots.set(holder, fields = new Map());
        fields.set(key, { value, reference });
      }
      return reference;
    });
  }
  return Object.assign(persist, {
    clear() { slots = new WeakMap(); recent.clear(); memoChars = 0; },
    memoStats: () => ({ entries: recent.size, chars: memoChars }),
  });
}

/** Traverse storage records without decoding images or serializing large inline strings. */
export function collectSessionImageReferences(value: unknown, references = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (/^qz-history-image:v1:[a-f0-9]{64}$/.test(value)) references.add(value);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSessionImageReferences(item, references);
  }
  return references;
}

export const persistSessionImages = createSessionImageStorage();

/** Resolve only at read boundaries. No process-wide cache of decoded payloads. */
export async function resolveSessionImages<T>(input: T, load = getHistoryImage): Promise<T> {
  const pending = new Map<string, Promise<string | null>>();
  return mapStrings(input, value => /^qz-history-image:v1:[a-f0-9]{64}$/.test(value), async value => {
    let loading = pending.get(value);
    if (!loading) {
      loading = load(value).catch(cause => {
        // A transient read failure is not a missing image. Fail hydration so a
        // new run cannot overwrite intact history with an empty conversation.
        throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), {
          code: "SESSION_IMAGE_READ_FAILED",
        });
      });
      pending.set(value, loading);
    }
    const dataUrl = await loading;
    if (dataUrl === null) {
      // A damaged/missing asset must not become an invalid model image URL.
      // Normalizers omit empty image slots; all other history remains readable.
      console.warn("[轻舟] missing Session image asset", value.slice(HISTORY_IMAGE_PREFIX.length));
    }
    return dataUrl ?? "";
  }, 4);
}

async function mapStrings<T>(input: T, matches: (value: string) => boolean, map: (value: string, holder: object | null, key: string) => Promise<string>, concurrency = 1): Promise<T> {
  const slots: { value: string; holder: object | null; key: string; target: Record<string, unknown> }[] = [];
  function capture(value: unknown, holder: object | null, key: string, target: Record<string, unknown>) {
    if (typeof value === "string" && matches(value)) slots.push({ value, holder, key, target });
    if (!value || typeof value !== "object") {
      Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
      return;
    }
    const copy = (Array.isArray(value) ? new Array(value.length) : {}) as Record<string, unknown>;
    Object.defineProperty(target, key, { value: copy, writable: true, enumerable: true, configurable: true });
    for (const [field, item] of Object.entries(value)) capture(item, value, field, copy);
  }
  // Capture the complete structure before yielding, without copying strings.
  // Writes/hash migrations stay sequential. Read boundaries overlap at most
  // four Blob reads, never a whole collection of temporary buffers.
  const root: Record<string, unknown> = {};
  capture(input, null, "value", root);
  for (let offset = 0; offset < slots.length; offset += concurrency) {
    await Promise.all(slots.slice(offset, offset + concurrency).map(async slot => {
      slot.target[slot.key] = await map(slot.value, slot.holder, slot.key);
    }));
  }
  return root.value as T;
}
