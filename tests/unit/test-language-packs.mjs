import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { capabilityLocaleAssets, readTranslationBaseline } from "../../scripts/capability-locales.mjs";
import { chromeMessageId, decodeChromeMessage, defineMessages, HISTORICAL_LABELS_MESSAGE_ID } from "../../src/shared/i18n/definition.ts";
import { getToolMetadataCatalog } from "../../src/shared/tools/tool-metadata.ts";
import { createTranslator, getLanguage, getTextDirection } from "../../src/shared/i18n/index.ts";
import { browserPermissionMessages, permissionT } from "../../src/shared/browser-permissions.ts";
import { debuggerDetachMessages, debuggerDetachT } from "../../src/shared/debugger-detach.ts";
import { createContentLanguageSnapshot } from "../../src/shared/i18n/content.ts";
import { t as panelText } from "../../src/sidepanel/i18n/index.ts";
import { localizeToolFailurePayload } from "../../src/shared/tools/tool-error-localization.ts";
import packs from "../../src/capabilities/i18n/locales.ts";
import sessionMessages from "../../src/capabilities/sessions/messages.ts";
import { backendMessages } from "../../src/shared/i18n/backend-messages.ts";
import uiCatalogs from "#capabilities/translations";
import { describeAutomationSchedule, computeNextRunAt } from "../../src/shared/automation-store.ts";
import { listProviderSummaries } from "../../src/background/llm/provider-catalog.ts";
import { groupProviderChoices } from "../../src/shared/settings-menu-utils.ts";

const source = resolve("src");
const namespaces = new Set([
  ...uiCatalogs.map(catalog => catalog.namespace), "core", "backend", "content",
  "product-public", "document-input", "skill-renderers", browserPermissionMessages.namespace, debuggerDetachMessages.namespace,
]);
const baseline = readTranslationBaseline(source);
const required = [...baseline.keys()].filter(key => namespaces.has(key.split(".")[0]));
const assets = capabilityLocaleAssets(source).assets;
const nativePack = pack => JSON.parse(assets.get(resolve(source, `_locales/${pack.chromeLocale}/messages.json`)));
const builtinLabels = {
  "skill-workbench": ["skill-workbench.name", "skill-workbench.workbenchDescription"],
  "site-skill-author": ["skills.siteAuthorName", "skills.siteAuthorDescription"],
  "qingzhou-documents": ["documents-model.documentsDisplayName", "documents-model.documentsDescription"],
  "qingzhou-mcp": ["mcp-model.mcpDisplayName", "mcp-model.mcpDescription"],
  "qingzhou-management": ["settings-model.managementDisplayName", "settings-model.managementDescription"],
};
function withPack(pack, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const messages = nativePack(pack);
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: {
    getUILanguage: () => pack.language,
    getMessage: key => decodeChromeMessage(messages[key]) || "",
  } } });
  try { return run(messages); }
  finally { if (previous) Object.defineProperty(globalThis, "chrome", previous); else delete globalThis.chrome; }
}

test("historical-label indexes contain every declared tool title and no unrelated product prose", () => {
  const english = getToolMetadataCatalog("en");
  const titles = new Set(Object.values(english.tools).map(tool => tool.title));
  for (const pack of packs) {
    const raw = decodeChromeMessage(nativePack(pack)[HISTORICAL_LABELS_MESSAGE_ID]);
    const aliases = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) < 64 * 1024, `${pack.language}: the title index remains bounded`);
    assert.deepEqual(new Set(Object.keys(aliases)), titles, "only registered tool titles enter the history index");
    for (const title of titles) assert.ok(aliases[title].includes(title));
  }
});

test("provider groups stay localized across all public catalog languages", () => {
  const labels = {
    "zh-CN": "所有服务商", "zh-TW": "所有服務商", en: "All providers",
    ja: "すべてのプロバイダー", ko: "모든 제공업체", es: "Todos los proveedores",
    fr: "Tous les fournisseurs", de: "Alle Anbieter", "pt-BR": "Todos os provedores",
    ru: "Все провайдеры", ar: "جميع المزوّدين", hi: "सभी प्रदाता",
  };
  const snapshots = packs.map(pack => withPack(pack, () => {
    const summaries = listProviderSummaries();
    const groups = groupProviderChoices(summaries, pack.language);
    assert.deepEqual(groups.map(group => group.id), ["custom", "all"]);
    const all = groups.at(-1);
    assert.equal(all.label, labels[pack.language], pack.language);
    assert.ok(all.providers.length > 100);
    for (const id of ["fireworks", "openaicodex", "opencodego", "opencodezen", "siliconflowcn", "deepseek", "anthropic", "openrouter"]) {
      assert.ok(all.providers.some(provider => provider.id === id), `${id} joins the shared catalog group`);
    }
    assert.ok(summaries.every(provider => provider.group), "all shipped providers declare their group");
    assert.deepEqual(JSON.parse(JSON.stringify(summaries)), summaries, "wire snapshots contain plain values");
    return { language: pack.language, group: summaries.find(provider => provider.id === "openaicodex").group };
  }));
  for (const snapshot of snapshots) assert.equal(snapshot.group.label, labels[snapshot.language], "later language changes cannot rewrite an earlier snapshot");
});

test("product names agree across the UI, content script and native extension labels", () => {
  const localNames = { "zh-CN": "轻舟", "zh-TW": "輕舟", ja: "軽舟" };
  for (const pack of packs) {
    const expected = localNames[pack.language] || "qz";
    withPack(pack, messages => {
      assert.equal(panelText("brand"), expected, `${pack.language} panel`);
      assert.equal(createContentLanguageSnapshot().messages.brand, expected, `${pack.language} content script`);
      assert.equal(messages.extensionName.message, expected, `${pack.language} manifest`);
    });
  }
});

for (const pack of packs.filter(pack => pack.catalog)) {
  test(`${pack.language} covers every shipped UI message, tool result, error, and extension label`, () => {
    const messages = nativePack(pack);
    assert.ok(required.length > 3000, "real source catalogs, including backend errors, are covered");
    const missing = required.filter(key => !messages[chromeMessageId(key)]?.message);
    assert.deepEqual(missing, [], `${pack.language} has untranslated source messages`);
    const manifest = JSON.parse(readFileSync(resolve(source, "manifest.json"), "utf8"));
    for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) assert.ok(messages[key]?.message, key);
    withPack(pack, () => {
      assert.equal(getLanguage(), pack.language);
      assert.equal(getTextDirection(), pack.direction || "ltr");
      const input = { ok: false, code: "SKILL_NOT_FOUND", error: "Legacy provider detail", details: { skillName: "用户技能 {name} <script>" } };
      const output = localizeToolFailurePayload(input);
      assert.equal(output.code, input.code);
      assert.equal(output.details.originalError, input.error);
      assert.equal(output.details.skillName, input.details.skillName);
      assert.equal(output.codeLabel, messages[chromeMessageId("backend.toolError.SKILL_NOT_FOUND.label")].message);
      assert.notEqual(output.error, "The tool failed.");
      assert.equal(input.error, "Legacy provider detail");
    });
  });
}

test("the public extension ships all twelve declared native language packs", () => {
  assert.deepEqual(packs.map(pack => pack.language).sort(), [
    "ar", "de", "en", "es", "fr", "hi", "ja", "ko", "pt-BR", "ru", "zh-CN", "zh-TW",
  ]);
  assert.equal(assets.size, packs.length);
  for (const pack of packs) {
    const messages = nativePack(pack);
    assert.equal(messages.qz_language.message, pack.language);
    assert.ok(messages.extensionName.message);
    assert.ok(messages.extensionDescription.message);
  }
});

test("permission recovery messages use localized permission names in every language", () => {
  for (const pack of packs) withPack(pack, messages => {
    const text = key => pack.catalog
      ? decodeChromeMessage(messages[chromeMessageId(`browser-permissions.${key}`)])
      : browserPermissionMessages.messages[key]?.[pack.language];
    for (const permission of ["bookmarks", "history", "desktopCapture", "downloads.open"]) {
      const name = text(`name.${permission}`);
      assert.ok(name, `${pack.language}: ${permission} has a translated name`);
      assert.equal(permissionT(`name.${permission}`), name);
      for (const key of ["required", "denied"]) {
        const template = text(key);
        assert.ok(template, `${pack.language}: ${key} is shipped`);
        assert.equal(permissionT(key, { permission: name }), template.replace("{permission}", name));
      }
    }
  });
});

test("debugger reattach cards ship localized titles, disclosures and actions in every language", () => {
  for (const pack of packs) withPack(pack, messages => {
    for (const [key, authored] of Object.entries(debuggerDetachMessages.messages)) {
      const expected = pack.catalog
        ? decodeChromeMessage(messages[chromeMessageId(`debugger-detach.${key}`)])
        : authored[pack.language];
      assert.ok(expected, `${pack.language}: debugger-detach.${key} must be shipped`);
      assert.equal(debuggerDetachT(key), expected, `${pack.language}: ${key} resolves through the native pack`);
      if (pack.catalog) assert.notEqual(expected, authored.en, `${pack.language}: ${key} cannot silently fall back to English`);
    }
  });
});

test("weekly schedule summaries localize weekdays without changing the scheduled instant", () => {
  const weekdays = { "zh-TW": "一", ja: "月曜日", ko: "월요일", es: "lunes", fr: "lundi", de: "Montag", "pt-BR": "segunda-feira", ru: "понедельник", ar: "الاثنين", hi: "सोमवार" };
  const schedule = { type: "weekly", weekday: 1, time: "09:30" };
  const from = Date.parse("2026-09-19T00:00:00Z");
  const next = computeNextRunAt(schedule, from);
  for (const pack of packs.filter(pack => pack.catalog)) withPack(pack, () => {
    const summary = describeAutomationSchedule(schedule);
    assert.ok(summary.includes(weekdays[pack.language]), `${pack.language}: ${summary}`);
    assert.ok(!summary.includes("Monday"));
    assert.equal(computeNextRunAt(schedule, from), next);
  });
});

test("untranslated third-party messages use their authored English fallback without translating user text", () => {
  const t = createTranslator(defineMessages("third-party", { saved: { en: "Saved {name}", "zh-CN": "已保存 {name}" } }));
  const userText = '日本語 中文 العربية {name} $& <img src=x>';
  for (const pack of packs.filter(pack => pack.catalog)) withPack(pack, () => {
    assert.equal(t("saved", { name: userText }), `Saved ${userText}`);
  });
});

test("a third-party capability can supply its own optional translation without editing the language capability", () => {
  const t = createTranslator(defineMessages("self-contained", { saved: { en: "Saved {name}", "zh-CN": "已保存 {name}", ja: "{name}を保存しました" } }));
  withPack(packs.find(pack => pack.language === "ja"), () => assert.equal(t("saved", { name: "User data" }), "User dataを保存しました"));
});

test("location recovery text is short and translated in every shipped language pack", () => {
  const keys = [
    "locationUnavailable",
    "locationPermissionDenied",
    "locationPositionUnavailable",
    "locationTimeout",
    "locationPanelUnavailable",
    "locationResponseTimeout",
  ];
  for (const key of keys) {
    for (const language of ["en", "zh-CN"]) {
      assert.equal(sessionMessages.messages[key][language], backendMessages.messages[key][language], `${language} ${key}`);
    }
  }
  for (const pack of packs.filter(pack => pack.catalog)) {
    const messages = nativePack(pack);
    for (const key of keys) {
      const backendKey = `backend.${key}`;
      const sessionsKey = `sessions.${key}`;
      const backend = decodeChromeMessage(messages[chromeMessageId(backendKey)]);
      const sessions = decodeChromeMessage(messages[chromeMessageId(sessionsKey)]);
      assert.equal(backend, sessions, `${pack.language} ${key}`);
      assert.equal(/Chrome|Firefox/i.test(backend), false, `${pack.language} ${key}`);
      assert.notEqual(backend, baseline.get(backendKey), `${pack.language} ${key} is translated`);
      assert.ok(backend.length <= 220, `${pack.language} ${key} stays short (${backend.length})`);
    }
  }
});

test("chrome store review copy is translated in every catalog and names the store", () => {
  const mentions = ["Chrome Web Store", "Chrome 应用商店"];
  for (const pack of packs.filter(pack => pack.catalog)) {
    const messages = nativePack(pack);
    const prompt = decodeChromeMessage(messages[chromeMessageId("core.storeReviewPrompt")]);
    const action = decodeChromeMessage(messages[chromeMessageId("core.storeReviewAction")]);
    const dismiss = decodeChromeMessage(messages[chromeMessageId("core.storeReviewDismiss")]);
    assert.ok(prompt, pack.language);
    assert.ok(action, pack.language);
    assert.ok(dismiss, pack.language);
    assert.ok(mentions.some(mention => prompt.includes(mention)), `${pack.language} prompt names the store: ${prompt}`);
    assert.notEqual(prompt, baseline.get("core.storeReviewPrompt"), pack.language);
    assert.notEqual(action, baseline.get("core.storeReviewAction"), pack.language);
    assert.notEqual(dismiss, baseline.get("core.storeReviewDismiss"), pack.language);
  }
});

test("built-in skill cards and tool titles use each language pack while identifiers and user-authored text stay stable", t => {
  const directory = mkdtempSync(join(tmpdir(), "qingzhou-locale-registrations-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let originalNames;
  for (const pack of packs.filter(pack => pack.catalog)) {
    const messages = nativePack(pack);
    const file = join(directory, `${pack.language}.json`);
    writeFileSync(file, JSON.stringify(messages));
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--import", "./tests/support/typescript-loader.mjs", "tests/fixtures/i18n/model-catalog.mjs", pack.language, file], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }));
    const names = result.registered.map(tool => tool.name);
    originalNames ??= names;
    assert.deepEqual(names, originalNames);
    for (const [name, [title, description]] of Object.entries(builtinLabels)) {
      const skill = result.skills.find(skill => skill.name === name);
      assert.equal(skill?.displayName, messages[chromeMessageId(title)]?.message, `${pack.language}: ${name}`);
      assert.equal(skill.description, messages[chromeMessageId(description)]?.message, `${pack.language}: ${name} description`);
    }
    assert.equal(result.registered.find(tool => tool.name === "open_tab").title, messages[chromeMessageId("tabs.openPage")].message);
    const foreign = result.schemas.find(tool => tool.function.name === "foreign_guide__echo").function;
    assert.ok(foreign.description.startsWith("用户定义的工具说明"));
    assert.equal(foreign.parameters.properties.text.description, "用户的参数说明");
    assert.ok(Object.values(result.aliases).every(Boolean), "historical aliases remain available");
  }
});
