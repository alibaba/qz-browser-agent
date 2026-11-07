import assert from "node:assert/strict";
import test from "node:test";
import { createLanguageRuntime, LANGUAGE_PREFERENCE_KEY } from "../../src/shared/i18n/runtime.js";
import { chromeMessageId, encodeChromeMessage } from "../../src/shared/i18n/definition.js";
import { createContentLanguageSnapshot, parseContentLanguageSnapshot } from "../../src/shared/i18n/content.js";

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ browser = "en-GB", preference, fetch, get, set } = {}) {
  const values = preference === undefined ? {} : { [LANGUAGE_PREFERENCE_KEY]: preference };
  const listeners = [];
  const requests = [];
  const changed = value => {
    if (value === undefined) delete values[LANGUAGE_PREFERENCE_KEY];
    else values[LANGUAGE_PREFERENCE_KEY] = value;
    for (const listener of listeners) listener({ [LANGUAGE_PREFERENCE_KEY]: { newValue: value } }, "local");
  };
  const env = {
    chrome: {
      i18n: { getUILanguage: () => browser },
      runtime: { getURL: path => `chrome-extension://fixture/${path}` },
      storage: {
        local: { get: get || (async () => ({ ...values })), set: set || (async update => changed(update[LANGUAGE_PREFERENCE_KEY])) },
        onChanged: { addListener: listener => listeners.push(listener) },
      },
    },
    fetch: async url => {
      requests.push(url);
      if (fetch) return fetch(url);
      const language = /_locales\/([^/]+)/.exec(url)[1].replace("_", "-");
      return { ok: true, json: async () => ({ qz_language: encodeChromeMessage(language), [chromeMessageId("sample.label")]: encodeChromeMessage(`${language}: $5 $$6 $NAME$ {value}`) }) };
    },
  };
  return { runtime: createLanguageRuntime(() => env), env, values, requests, changed };
}

test("manual preference applies on startup; save retains panel language until reopening", async () => {
  const f = fixture();
  await f.runtime.initializeLanguage();
  assert.equal(f.runtime.getLocale(), "en-GB");
  await f.runtime.saveLanguagePreference("ja");
  assert.deepEqual(f.values[LANGUAGE_PREFERENCE_KEY], { v: 1, language: "ja" });
  assert.equal(f.runtime.getLocale(), "en-GB");
  assert.equal(await f.runtime.readLanguagePreference(), "ja");
  const reopened = createLanguageRuntime(() => f.env);
  await reopened.initializeLanguage();
  assert.equal(reopened.getLanguage(), "ja");
  assert.equal(reopened.lookupMessage("sample.label"), "ja: $5 $$6 $NAME$ {value}");
  await reopened.saveLanguagePreference("system");
  const followingBrowser = createLanguageRuntime(() => f.env);
  await followingBrowser.initializeLanguage();
  assert.equal(followingBrowser.getLocale(), "en-GB");
});

test("unknown, removed and future-version preferences fall back without rewriting storage", async () => {
  for (const preference of ["ja", { v: 2, language: "ja" }, { v: 1, language: "../../ja" }, { v: 1, language: "removed" }, null]) {
    const f = fixture({ preference, browser: "ar-EG" });
    await f.runtime.initializeLanguage();
    assert.equal(f.runtime.getLocale(), "ar-EG");
    assert.equal(f.runtime.getLanguagePreference(), "system");
    assert.deepEqual(f.values[LANGUAGE_PREFERENCE_KEY], preference);
    await assert.rejects(f.runtime.saveLanguagePreference("../../ja"), /Unsupported/);
  }
});

test("storage and resource failures remain recoverable, explicit saves never report success", async () => {
  const f = fixture({ get: async () => { throw new Error("storage unavailable"); } });
  await f.runtime.initializeLanguage();
  assert.equal(f.runtime.getLanguage(), "en");
  await assert.rejects(f.runtime.readLanguagePreference(), /storage unavailable/);
  f.env.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(f.runtime.saveLanguagePreference("ja"), /404/);
  assert.equal(f.values[LANGUAGE_PREFERENCE_KEY], undefined);
  f.env.fetch = async () => ({ ok: true, json: async () => ({ qz_language: { message: "ko" } }) });
  await assert.rejects(f.runtime.saveLanguagePreference("ja"), /does not match/);
  f.env.fetch = async () => ({ ok: true, json: async () => ({ qz_language: { message: "ja" } }) });
  await f.runtime.saveLanguagePreference("ja");
  assert.equal(f.values[LANGUAGE_PREFERENCE_KEY].language, "ja");
  f.env.chrome.storage.local.set = async () => { throw new Error("write failed"); };
  await assert.rejects(f.runtime.saveLanguagePreference("system"), /write failed/);
});

test("background observes latest preference, rejecting stale initial reads and catalog completions", async () => {
  const initial = deferred();
  const japanese = deferred();
  const arabic = deferred();
  const f = fixture({ get: () => initial.promise, fetch: url => url.includes("/ja/") ? japanese.promise : arabic.promise });
  const applied = [];
  const ready = f.runtime.initializeLanguage({ watch: true, onChange: () => applied.push(f.runtime.getLanguage()) });
  f.changed({ v: 1, language: "ja" });
  f.changed({ v: 1, language: "ar" });
  initial.resolve({ [LANGUAGE_PREFERENCE_KEY]: { v: 1, language: "zh-CN" } });
  arabic.resolve({ ok: true, json: async () => ({ qz_language: { message: "ar" } }) });
  await ready;
  assert.equal(f.runtime.getLanguage(), "ar");
  assert.deepEqual(applied, ["ar"]);
  japanese.resolve({ ok: true, json: async () => ({ qz_language: { message: "ja" } }) });
  await turn();
  assert.equal(f.runtime.getLanguage(), "ar");
  assert.deepEqual(applied, ["ar"], "late catalog completions cannot refresh the current display");
  assert.equal(f.runtime.withLanguage("ja", () => f.runtime.getLanguage()), "ja");
});

test("language refresh runs after catalog application, skips startup and cannot cause fallback", async () => {
  const f = fixture();
  const applied = [];
  await f.runtime.initializeLanguage({ watch: true, onChange: () => {
    applied.push([f.runtime.getLanguage(), f.runtime.lookupMessage("sample.label")]);
    throw new Error("display refresh failed");
  } });
  assert.deepEqual(applied, [], "startup consumers retain their own readiness ordering");
  f.changed({ v: 1, language: "ja" });
  await f.runtime.whenLanguageReady();
  assert.deepEqual(applied, [["ja", "ja: $5 $$6 $NAME$ {value}"]]);
  assert.equal(f.runtime.getLanguage(), "ja", "observer failure must not reset the applied locale");
  f.changed(undefined);
  await f.runtime.whenLanguageReady();
  assert.equal(f.runtime.getLocale(), "en-GB");
  assert.equal(applied.at(-1)[0], "en");
});

test("readiness follows preference changes arriving during an earlier load", async () => {
  const loads = { ja: deferred(), ar: deferred() };
  const f = fixture({ preference: { v: 1, language: "ja" }, fetch: url => loads[url.includes("/ja/") ? "ja" : "ar"].promise });
  const ready = f.runtime.initializeLanguage({ watch: true });
  await turn();
  const waiting = f.runtime.whenLanguageReady();
  f.changed({ v: 1, language: "ar" });
  loads.ja.resolve({ ok: true, json: async () => ({ qz_language: { message: "ja" } }) });
  let completed = false;
  void waiting.then(() => { completed = true; });
  await turn();
  assert.equal(completed, false);
  loads.ar.resolve({ ok: true, json: async () => ({ qz_language: { message: "ar" } }) });
  await Promise.all([ready, waiting]);
  assert.equal(f.runtime.getLanguage(), "ar");
});

test("queued writes respect cancellation and a later read sees all submitted writes", async () => {
  const firstWrite = deferred();
  const written = [];
  const f = fixture({ set: async values => { written.push(values); if (written.length === 1) await firstWrite.promise; } });
  const first = f.runtime.saveLanguagePreference("ja");
  await turn();
  const controller = new AbortController();
  const second = f.runtime.saveLanguagePreference("ar", { signal: controller.signal });
  controller.abort();
  const assertion = assert.rejects(second, { name: "AbortError" });
  const read = f.runtime.readLanguagePreference();
  firstWrite.resolve();
  await Promise.all([first, assertion, read]);
  assert.equal(written.length, 1);
});

test("cancellation after a submitted Chrome write suppresses success without pretending to undo persistence", async () => {
  const submitted = deferred();
  const completion = deferred();
  const controller = new AbortController();
  const f = fixture();
  f.env.chrome.storage.local.set = async values => {
    Object.assign(f.values, values);
    submitted.resolve();
    await completion.promise;
  };
  const saving = f.runtime.saveLanguagePreference("ja", { signal: controller.signal });
  await submitted.promise;
  controller.abort();
  const cancelled = assert.rejects(saving, { name: "AbortError" });
  completion.resolve();
  await cancelled;
  assert.equal(await f.runtime.readLanguagePreference(), "ja");
  assert.equal(f.runtime.getLanguage(), "en");
});

test("language scopes nest, retain cached catalogs and always restore after errors", async () => {
  const f = fixture();
  await f.runtime.initializeLanguage({ watch: true });
  await f.runtime.saveLanguagePreference("ja");
  await f.runtime.whenLanguageReady();
  await f.runtime.saveLanguagePreference("ar");
  await f.runtime.whenLanguageReady();
  assert.equal(f.runtime.getLanguage(), "ar");
  f.runtime.withLanguage("ja", () => {
    assert.equal(f.runtime.lookupMessage("sample.label"), "ja: $5 $$6 $NAME$ {value}");
    assert.throws(() => f.runtime.withLanguage("en", () => { throw new Error("failed"); }), /failed/);
    assert.equal(f.runtime.getLanguage(), "ja");
  });
  assert.equal(f.runtime.getLanguage(), "ar");
  assert.throws(() => f.runtime.withLanguage("ja", () => Promise.resolve()), /synchronous/);
  assert.equal(f.runtime.getLanguage(), "ar");
  assert.equal(f.requests.length, 3);
});

test("content-language protocol accepts exactly bounded page labels, not arbitrary dictionaries", () => {
  const snapshot = createContentLanguageSnapshot();
  assert.deepEqual(parseContentLanguageSnapshot(snapshot), snapshot);
  assert.equal(Object.keys(snapshot.messages).length, 3);
  for (const value of [null, [], { ...snapshot, v: 2 }, { ...snapshot, messages: {} }, { ...snapshot, messages: { ...snapshot.messages, brand: "a".repeat(4097) } }]) {
    assert.equal(parseContentLanguageSnapshot(value), null);
  }
  assert.deepEqual(parseContentLanguageSnapshot({ ...snapshot, messages: { ...snapshot.messages, private: "ignored" } }), snapshot);
});
