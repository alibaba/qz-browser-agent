import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installBenchmarkChromeStub } from "../browser/benchmark-chrome-stub.mjs";
import { capabilityLocaleAssets } from "../../scripts/capability-locales.mjs";
import { chromeMessageId, decodeChromeMessage, encodeChromeMessage, HISTORICAL_LABELS_MESSAGE_ID } from "../../src/shared/i18n/definition.ts";
import { createLanguageRuntime } from "../../src/shared/i18n/runtime.ts";
import languagePacks from "../../src/capabilities/i18n/locales.ts";
import coreMessages from "../../src/sidepanel/i18n/messages.ts";
import { backendMessages } from "../../src/shared/i18n/backend-messages.ts";

async function fixture(t, packs = [{ language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./ja" }]) {
  const source = await realpath(await mkdtemp(join(tmpdir(), "qingzhou-locales-")));
  t.after(() => rm(source, { recursive: true, force: true }));
  await put(source, "manifest.json", JSON.stringify({ default_locale: "en" }));
  await put(source, "_locales/en/messages.json", JSON.stringify({ extensionName: { message: "Qingzhou" }, extensionDescription: { message: "An agent workspace." } }));
  await put(source, "shared/messages.ts", 'import { defineMessages } from "./definition.js"; export default defineMessages("core", { save: { en: "Save {name}", "zh-CN": "保存 {name}" }, price: { en: "Costs $5", "zh-CN": "费用 $5" } });');
  await put(source, "capabilities/languages/index.ts", 'export { default as locales } from "./locales.js";');
  await metadata(source, packs);
  await put(source, "capabilities/languages/ja/core.json", JSON.stringify({ "core.save": "{name} を保存", "core.price": "$5 です", "manifest.extensionDescription": "ブラウザーで使える AI エージェント。" }));
  return source;
}

async function put(source, file, contents) {
  await mkdir(dirname(join(source, file)), { recursive: true });
  await writeFile(join(source, file), contents);
}

async function metadata(source, packs) {
  await put(source, "capabilities/languages/locales.ts", `export default ${JSON.stringify(packs)};\n`);
}

function catalog(result, source, locale = "ja") {
  return JSON.parse(result.assets.get(join(source, "_locales", locale, "messages.json")));
}

test("interruption recovery copy is consistent and translated in every shipped language", async () => {
  const source = await realpath(new URL("../../src", import.meta.url));
  const assets = capabilityLocaleAssets(source);
  const english = "The run was interrupted. Saved chat content has been restored. Send a message to continue.";
  const chinese = "运行已中断，已恢复保存的对话。发送消息可继续。";
  for (const { language, chromeLocale, catalog: contributed } of languagePacks) {
    const native = catalog(assets, source, chromeLocale);
    const core = contributed ? decodeChromeMessage(native[chromeMessageId("core.runInterrupted")])
      : coreMessages.messages.runInterrupted[language];
    const backend = contributed ? decodeChromeMessage(native[chromeMessageId("backend.status.runInterrupted")])
      : backendMessages.messages["status.runInterrupted"][language];
    assert.ok(core, `${language}: recovery notice must be translated`);
    assert.equal(core, backend, `${language}: panel and persisted notice must agree`);
    if (language === "en") assert.equal(core, english);
    else if (language === "zh-CN") assert.equal(core, chinese);
    else assert.notEqual(core, english, `${language}: no unintended English fallback`);
  }
});

test("language packages generate deterministic native resources without copying their JSON into runtime modules", async t => {
  const source = await fixture(t, [
    { language: "en", chromeLocale: "en", name: "English" },
    { language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./ja" },
  ]);
  const before = await readFile(join(source, "capabilities/languages/ja/core.json"), "utf8");
  const assets = capabilityLocaleAssets(source);
  assert.deepEqual(assets, capabilityLocaleAssets(source));
  const japanese = catalog(assets, source);
  assert.equal(japanese.extensionName.message, "Qingzhou", "missing manifest translations retain the declared default locale");
  assert.equal(japanese.extensionDescription.message, "ブラウザーで使える AI エージェント。");
  assert.equal(japanese.qz_language.message, "ja");
  assert.equal(japanese[chromeMessageId("core.save")].message, "{name} を保存");
  assert.equal(decodeChromeMessage(japanese[chromeMessageId("core.price")]), "$5 です", "Chrome runtime text preserves literal dollars");
  assert.equal(catalog(assets, source, "en").qz_language.message, "en");
  assert.equal(catalog(assets, source, "en").extensionDescription.message, "An agent workspace.");
  assert.ok(assets.resources.has(join(source, "capabilities/languages/ja/core.json")));
  assert.ok(assets.resources.has(join(source, "_locales/en/messages.json")));
  assert.equal(await readFile(join(source, "capabilities/languages/ja/core.json"), "utf8"), before);
});

test("native assets preserve dollar runs, apparent Chrome placeholders and named interpolation as literal text", async t => {
  const source = await fixture(t);
  const price = "$5 / $$6 / $$$7 / $HOME$ / $1 / $QZ_LITERAL$ / trailing $";
  await put(source, "capabilities/languages/ja/core.json", JSON.stringify({ "core.price": price, "manifest.extensionDescription": price }));
  const messages = catalog(capabilityLocaleAssets(source), source);
  assert.equal(decodeChromeMessage(messages[chromeMessageId("core.price")]), price);
  assert.equal(messages[chromeMessageId("core.price")].placeholders.qz_literal.content, "$$5 / $$$6 / $$$$7 / $$HOME$$ / $$1 / $$QZ_LITERAL$$ / trailing $$");
  assert.equal(messages.extensionDescription.placeholders.qz_literal.content, price, "manifest values do not pass through getMessage substitutions");
  for (const value of ["", "plain {name}", price, "$", "$$", "$$$", "$QZ_LITERAL$"]) {
    assert.equal(decodeChromeMessage(encodeChromeMessage(value)), value);
    const state = { window: {}, options: { localeMessages: { probe: encodeChromeMessage(value) } } };
    runInNewContext(`(${installBenchmarkChromeStub.toString()})(options)`, state);
    assert.equal(state.window.chrome.i18n.getMessage("probe"), value, "serialized browser stubs follow the same native literal contract");
  }
  for (const value of [null, [], "text", { message: 1 }, { message: "$QZ_LITERAL$" }, { message: "$OTHER$", placeholders: {} }, { message: "$QZ_LITERAL$", placeholders: { qz_literal: { content: false } } }]) {
    assert.equal(decodeChromeMessage(value), undefined);
  }
});

test("historical labels form a compact index in each current pack without loading source-language catalogs", async t => {
  const source = await fixture(t, [
    { language: "en", chromeLocale: "en", name: "English" },
    { language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./ja" },
    { language: "ko", chromeLocale: "ko", name: "한국어", catalog: "./ko" },
  ]);
  await put(source, "shared/history.ts", 'import { defineMessages } from "./definition.js"; export default defineMessages("history", { title: { en: "Open $HOME$", "zh-CN": "打开 $HOME$" }, description: { en: "Long explanation", "zh-CN": "说明" } }, { historicalLabels: ["title"] });');
  await put(source, "capabilities/languages/ja/history.json", JSON.stringify({ "history.title": "$HOME$ を開く" }));
  await put(source, "capabilities/languages/ko/history.json", JSON.stringify({ "history.title": "$HOME$ 열기" }));
  const assets = capabilityLocaleAssets(source);
  const english = catalog(assets, source, "en");
  const index = JSON.parse(decodeChromeMessage(english[HISTORICAL_LABELS_MESSAGE_ID]));
  assert.deepEqual(Object.keys(index), ["Open $HOME$"]);
  assert.deepEqual(new Set(index["Open $HOME$"]), new Set(["Open $HOME$", "打开 $HOME$", "$HOME$ を開く", "$HOME$ 열기"]));
  for (const language of ["en", "ja", "ko"]) {
    const messages = catalog(assets, source, language);
    assert.deepEqual(messages[HISTORICAL_LABELS_MESSAGE_ID], english[HISTORICAL_LABELS_MESSAGE_ID]);
    const runtime = createLanguageRuntime(() => ({ chrome: { i18n: {
      getUILanguage: () => language, getMessage: key => decodeChromeMessage(messages[key]) || "",
    } }, fetch: () => { throw new Error("Historical labels must not fetch another language"); } }));
    for (const label of index["Open $HOME$"]) assert.equal(runtime.isHistoricalLabel(label, "Open $HOME$"), true);
    assert.equal(runtime.isHistoricalLabel("My custom title", "Open $HOME$"), false);
    assert.equal(runtime.isHistoricalLabel("$HOME$ 열기", "Another tool"), false);
    assert.equal(runtime.isHistoricalLabel("Long explanation", "Long explanation"), false);
    for (const payload of ["invalid", "[]", '{"Open $HOME$":42}', '{"Open $HOME$":[42]}']) {
      messages[HISTORICAL_LABELS_MESSAGE_ID] = encodeChromeMessage(payload);
      assert.equal(runtime.isHistoricalLabel("$HOME$ 열기", "Open $HOME$"), false, "invalid replacements cannot retain old matches");
    }
  }
});

test("historical-label declarations fail during the build for missing keys, parameters and non-string values", async t => {
  const source = await fixture(t);
  for (const [messages, options] of [
    [{ title: { en: "Open", "zh-CN": "打开" } }, { historicalLabels: ["typo"] }],
    [{ title: { en: "Open", "zh-CN": "打开" } }, { historicalLabels: "title" }],
    [{ title: { en: "Open", "zh-CN": "打开" } }, { historicalLabels: [42] }],
    [{ title: { en: "Open {name}", "zh-CN": "打开 {name}" } }, { historicalLabels: ["title"] }],
    [{ title: { en: "Open", "zh-CN": 42 } }, { historicalLabels: ["title"] }],
  ]) {
    await put(source, "shared/history.ts", `import { defineMessages } from "./definition.js"; export default defineMessages("history", ${JSON.stringify(messages)}, ${JSON.stringify(options)});`);
    assert.throws(() => capabilityLocaleAssets(source), /Historical labels/);
  }
});

test("catalogs can be one file or recursively organized files; duplicate definitions never silently override", async t => {
  const source = await fixture(t);
  await metadata(source, [{ language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./ja/core.json" }]);
  assert.equal(catalog(capabilityLocaleAssets(source), source)[chromeMessageId("core.save")].message, "{name} を保存");
  await metadata(source, [{ language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./ja" }]);
  await put(source, "capabilities/languages/ja/nested/extra.json", '{"core.save":"保存 {name}"}');
  assert.throws(() => capabilityLocaleAssets(source), /Duplicate language message: core.save/);
  await rm(join(source, "capabilities/languages/ja/nested"), { recursive: true });
  await put(source, "capabilities/languages/ja/core.json", '{"core.save":"{name}","core.save":"{name}"}');
  assert.throws(() => capabilityLocaleAssets(source), /Duplicate literal key: core.save/);
});

test("message validation protects interpolation, known keys and literal text boundaries", async t => {
  const source = await fixture(t);
  for (const [contents, expected] of [
    [{ "core.save": "保存" }, /Translation parameters differ/],
    [{ "core.typo": "保存" }, /Unknown language message/],
    [{ "manifest.unknown": "Unknown" }, /Unknown language message/],
    [{ "core.save": { name: "保存" } }, /Invalid language message/],
    [{ "core.save": "" }, /Invalid language message/],
    [["保存"], /Language catalog must be an object/],
  ]) {
    await put(source, "capabilities/languages/ja/core.json", JSON.stringify(contents));
    assert.throws(() => capabilityLocaleAssets(source), expected);
  }
});

test("package removal and product selection omit unavailable namespaces and leave English fallback intact", async t => {
  const source = await fixture(t);
  await put(source, "products/optional/messages.ts", 'import { defineMessages } from "./definition.js"; export default defineMessages("product-optional", { hello: {en:"Hello", "zh-CN":"你好"} });');
  await put(source, "capabilities/languages/ja/optional.json", JSON.stringify({ "removed.feature": "削除された機能", "product-optional.hello": "こんにちは" }));
  const selected = catalog(capabilityLocaleAssets(source, { includes: path => !path.startsWith("products/optional/") }), source);
  assert.equal(selected[chromeMessageId("removed.feature")], undefined);
  assert.equal(selected[chromeMessageId("product-optional.hello")], undefined);
  assert.equal(catalog(capabilityLocaleAssets(source), source)[chromeMessageId("product-optional.hello")].message, "こんにちは");
  await rm(join(source, "capabilities/languages"), { recursive: true });
  assert.deepEqual(capabilityLocaleAssets(source), { resources: new Set(), assets: new Map() });
  assert.equal(JSON.parse(await readFile(join(source, "_locales/en/messages.json"), "utf8")).extensionName.message, "Qingzhou");
});

test("Traditional Chinese native labels stay localized without a contributed translation catalog", async t => {
  const source = await fixture(t, [
    { language: "en", chromeLocale: "en", name: "English" },
    { language: "zh-TW", chromeLocale: "zh_TW", name: "繁體中文" },
  ]);
  const file = "_locales/zh_TW/messages.json";
  await put(source, file, await readFile(new URL(`../../src/${file}`, import.meta.url), "utf8"));
  const expected = {
    extensionName: { message: "輕舟" },
    extensionDescription: { message: "輕舟是瀏覽器中的 AI 助理工作區。" },
    switchModel: { message: "快速切換模型預設組合" },
  };
  const generated = catalog(capabilityLocaleAssets(source), source, "zh_TW");
  assert.deepEqual(generated, { ...expected, qz_language: { message: "zh-TW" } });
  await rm(join(source, "capabilities/languages"), { recursive: true });
  assert.deepEqual(capabilityLocaleAssets(source), { resources: new Set(), assets: new Map() });
  assert.deepEqual(JSON.parse(await readFile(join(source, file), "utf8")), expected);
});

test("language registration rejects duplicates, malformed locale ids and executable metadata", async t => {
  const source = await fixture(t);
  const pack = { language: "ja", chromeLocale: "ja", name: "日本語", catalog: "./ja" };
  await metadata(source, [pack, pack]);
  assert.throws(() => capabilityLocaleAssets(source), /Duplicate language pack/);
  for (const changes of [{ chromeLocale: "../ja" }, { language: "JA" }, { chromeLocale: "ko" }, { direction: "down" }, { aliases: [false] }]) {
    await metadata(source, [{ ...pack, ...changes }]);
    assert.throws(() => capabilityLocaleAssets(source), /Invalid language pack|Language and Chrome locale differ/);
  }
  await put(source, "capabilities/languages/locales.ts", 'globalThis.localeSideEffect = true; export default [];');
  assert.throws(() => capabilityLocaleAssets(source), /literal array/);
  assert.equal(globalThis.localeSideEffect, undefined);
  await put(source, "capabilities/languages/locales.ts", 'export default (() => [])();');
  assert.throws(() => capabilityLocaleAssets(source), /Expected literal data/);
  await put(source, "capabilities/languages/unused.ts", 'globalThis.localeSideEffect = true; export const unused = 1;');
  await put(source, "capabilities/languages/locales.ts", 'import { unused } from "./unused.js"; export default [];');
  assert.throws(() => capabilityLocaleAssets(source), /literal array/, "an unused value import must not conceal module side effects");
  assert.equal(globalThis.localeSideEffect, undefined);
});

test("catalog paths stay in their own package and reject symlinks", async t => {
  const source = await fixture(t);
  const pack = { language: "ja", chromeLocale: "ja", name: "日本語" };
  for (const path of ["../../shared", "/tmp/languages", "ja\\messages.json"]) {
    await metadata(source, [{ ...pack, catalog: path }]);
    assert.throws(() => capabilityLocaleAssets(source), /catalog.*(?:path|package)/i);
  }
  await metadata(source, [{ ...pack, catalog: "./linked.json" }]);
  await symlink(join(source, "capabilities/languages/ja/core.json"), join(source, "capabilities/languages/linked.json"));
  assert.throws(() => capabilityLocaleAssets(source), /symlink/i);
});

test("language aliases are unambiguous and canonical; Chrome numeric regions remain supported", async t => {
  const source = await fixture(t);
  await metadata(source, [{ language: "es-419", chromeLocale: "es_419", name: "Español latinoamericano", aliases: ["es-MX"] }]);
  assert.equal(catalog(capabilityLocaleAssets(source), source, "es_419").qz_language.message, "es-419");
  await metadata(source, [
    { language: "zh-CN", chromeLocale: "zh_CN", name: "简体中文", aliases: ["zh-HK"] },
    { language: "zh-TW", chromeLocale: "zh_TW", name: "繁體中文", aliases: ["zh-HK"] },
  ]);
  assert.throws(() => capabilityLocaleAssets(source), /Conflicting language alias: zh-HK/);
  for (const alias of ["not a locale", "zh-hant", "iw"]) {
    await metadata(source, [{ language: "zh-TW", chromeLocale: "zh_TW", name: "繁體中文", aliases: [alias] }]);
    assert.throws(() => capabilityLocaleAssets(source), /Invalid language alias|canonical language tag/);
  }
});
