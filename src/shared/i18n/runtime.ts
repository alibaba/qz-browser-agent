import contributions from "#capabilities/locales";
import { chromeMessageId, decodeChromeMessage, HISTORICAL_LABELS_MESSAGE_ID, type LanguagePack } from "./definition.js";

/** The framework owns preference persistence; capability packages own the available languages. */
export const LANGUAGE_PREFERENCE_KEY = "qingzhou_language";
const packs = contributions.flat();
const matches = packs.flatMap(pack => [pack.language, ...(pack.aliases || [])]
  .map(tag => ({ tag: tag.toLowerCase(), language: pack.language })))
  .sort((a, b) => b.tag.length - a.tag.length);
const available = Object.freeze(packs.map(({ language, name, direction }) => Object.freeze({ language, name, direction })));

function canonicalLocale(locale: string): string {
  try { return Intl.getCanonicalLocales(locale)[0] || "en"; }
  catch { return "en"; }
}

export function resolveLanguage(locale: string): string {
  const normalized = canonicalLocale(locale).toLowerCase();
  return matches.find(({ tag }) => normalized === tag || normalized.startsWith(`${tag}-`))?.language || "en";
}
export function getAvailableLanguages() { return available; }

interface LanguageEnvironment {
  chrome?: {
    i18n?: { getUILanguage?(): string; getMessage?(key: string): string };
    runtime?: { getURL?(path: string): string };
    storage?: {
      local?: { get(key: string): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
      onChanged?: { addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
    };
  };
  navigator?: { language?: string };
  fetch?: typeof fetch;
}
type Catalog = Readonly<Record<string, string>>;

/** One instance per extension context. A panel keeps its startup locale; Background observes changes. */
export function createLanguageRuntime(environment: () => LanguageEnvironment = () => globalThis as LanguageEnvironment) {
  let locale: string | undefined;
  let scopedLocale: string | undefined;
  let preference = "system";
  let generation = 0;
  let initialization: Promise<void> | undefined;
  let pending = Promise.resolve();
  let writes = Promise.resolve();
  const catalogs = new Map<string, Catalog>();
  const loads = new Map<string, Promise<void>>();
  const messageIds = new Map<string, string>();
  let historicalLabelsSource: string | undefined;
  let historicalLabels = new Map<string, readonly string[]>();

  function browserLocale(): string {
    const env = environment();
    let language: string | undefined;
    try { language = env.chrome?.i18n?.getUILanguage?.(); } catch { /* Standalone pages use navigator. */ }
    const value = canonicalLocale(language || env.navigator?.language || "en");
    return resolveLanguage(value) === "en" && !/^en(?:-|$)/i.test(value) ? "en" : value;
  }
  const getLocale = () => scopedLocale ?? locale ?? browserLocale();
  const getLanguage = () => resolveLanguage(getLocale());
  const normalize = (value: unknown) => typeof value === "string" && packs.some(pack => pack.language === value) ? value : "system";
  function storedPreference(value: unknown): string {
    if (!value || typeof value !== "object" || !("v" in value) || value.v !== 1 || !("language" in value)) return "system";
    return normalize(value.language);
  }
  async function readLanguagePreference(): Promise<string> {
    await writes;
    const storage = environment().chrome?.storage?.local;
    if (!storage) return "system";
    return storedPreference((await storage.get(LANGUAGE_PREFERENCE_KEY))[LANGUAGE_PREFERENCE_KEY]);
  }
  async function load(language: string, required = false): Promise<void> {
    if (catalogs.has(language)) return;
    const existing = loads.get(language);
    if (existing) return existing;
    const env = environment();
    const pack: LanguagePack | undefined = packs.find(pack => pack.language === language);
    if (!pack || !env.chrome?.runtime?.getURL || !env.fetch) {
      if (required) throw new Error("Language resources are unavailable");
      return;
    }
    const url = env.chrome.runtime.getURL(`_locales/${pack.chromeLocale}/messages.json`);
    const operation = (async () => {
      const response = await env.fetch!(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Language resource failed: ${response.status}`);
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid language catalog");
      const entries = raw as Record<string, unknown>;
      if (decodeChromeMessage(entries.qz_language) !== language) throw new Error("Language catalog does not match its descriptor");
      const catalog: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [key, value] of Object.entries(entries)) {
        const text = decodeChromeMessage(value);
        if (key.startsWith("qz_") && text !== undefined) catalog[key] = text;
      }
      catalogs.set(language, Object.freeze(catalog));
    })();
    loads.set(language, operation);
    try { await operation; }
    finally { loads.delete(language); }
  }
  function apply(value: string) {
    const ticket = ++generation;
    const nextLocale = value === "system" ? browserLocale() : value;
    pending = load(resolveLanguage(nextLocale)).then(() => {
      if (ticket !== generation) return;
      locale = nextLocale;
      preference = value;
    }).catch(() => {
      // A missing/old installed resource must not prevent the extension from starting.
      if (ticket !== generation) return;
      locale = browserLocale();
      preference = value;
    });
    return pending;
  }
  function initializeLanguage({ watch = false }: { watch?: boolean } = {}): Promise<void> {
    if (initialization) return initialization;
    const ticket = generation;
    if (watch) environment().chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && Object.hasOwn(changes, LANGUAGE_PREFERENCE_KEY)) {
        void apply(storedPreference(changes[LANGUAGE_PREFERENCE_KEY]?.newValue));
      }
    });
    initialization = readLanguagePreference().catch(() => "system").then(async value => {
      if (generation === ticket) await apply(value);
      await whenLanguageReady();
    });
    return initialization;
  }
  async function whenLanguageReady(): Promise<void> {
    // A second preference can arrive while the preceding catalog is loading.
    for (;;) {
      const current = pending;
      await current;
      if (current === pending) return;
    }
  }
  function saveLanguagePreference(value: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (value !== "system" && normalize(value) !== value) return Promise.reject(new TypeError("Unsupported language"));
    const operation = writes.then(async () => {
      options.signal?.throwIfAborted();
      const storage = environment().chrome?.storage?.local;
      if (!storage) throw new Error("Language storage is unavailable");
      await load(resolveLanguage(value === "system" ? browserLocale() : value), true);
      options.signal?.throwIfAborted();
      await storage.set({ [LANGUAGE_PREFERENCE_KEY]: { v: 1, language: value } });
      options.signal?.throwIfAborted();
      preference = value;
    });
    writes = operation.then(() => {}, () => {});
    return operation;
  }
  async function ensureLanguage(language: string): Promise<void> {
    try { await load(resolveLanguage(language)); }
    catch { /* Authored text remains available when a catalog cannot be fetched. */ }
  }
  function withLanguage<T>(language: string, callback: () => T): T {
    const previous = scopedLocale;
    scopedLocale = language;
    try {
      const result = callback();
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
        throw new TypeError("Language scopes must be synchronous");
      }
      return result;
    } finally { scopedLocale = previous; }
  }
  function lookupMessage(qualifiedKey: string): string | undefined {
    let id = messageIds.get(qualifiedKey);
    if (!id) { id = chromeMessageId(qualifiedKey); messageIds.set(qualifiedKey, id); }
    return lookupNativeMessage(id);
  }
  function lookupNativeMessage(id: string): string | undefined {
    const language = getLanguage();
    const text = catalogs.get(language)?.[id];
    if (text !== undefined) return text;
    try {
      const native = environment().chrome?.i18n;
      if (native?.getMessage?.("qz_language") === language) return native.getMessage(id) || undefined;
    } catch { /* Old extensions and standalone tools use their authored fallback. */ }
    return undefined;
  }
  /** A small generated index travels with the current pack, including after a panel restart. */
  function isHistoricalLabel(value: string, englishLabel: string): boolean {
    const source = lookupNativeMessage(HISTORICAL_LABELS_MESSAGE_ID);
    if (source !== historicalLabelsSource) {
      historicalLabelsSource = source;
      historicalLabels = new Map();
      try {
        const parsed: unknown = JSON.parse(source || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [label, aliases] of Object.entries(parsed)) {
            if (Array.isArray(aliases) && aliases.every(alias => typeof alias === "string")) historicalLabels.set(label, aliases);
          }
        }
      } catch { /* Old or unavailable catalogs retain their original historical labels. */ }
    }
    return historicalLabels.get(englishLabel)?.includes(value) || false;
  }
  return Object.freeze({
    getLocale, getLanguage, getLanguagePreference: () => preference,
    initializeLanguage, whenLanguageReady, readLanguagePreference, saveLanguagePreference, ensureLanguage, withLanguage, lookupMessage, isHistoricalLabel,
  });
}

export const languageRuntime = createLanguageRuntime();
