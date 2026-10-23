import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBackgroundApi } from "../../src/background/background-api.ts";
import { createSessionImportLabels } from "../../src/background/services/session-import-labels.ts";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.ts";
import { chromeMessageId } from "../../src/shared/i18n/definition.ts";
import { readSessionImportLabels, sessionImportButtonText } from "../../src/shared/session/session-import-copy.ts";

const english = {
  importQingzhou: "Continue in qz",
  importing: "Importing",
  imported: "Imported",
  retryImport: "Try again",
  importFailedRetry: "Could not import. Try again.",
};
const chinese = {
  importQingzhou: "导入轻舟继续对话",
  importing: "正在导入",
  imported: "已导入",
  retryImport: "重试导入",
  importFailedRetry: "导入失败，请重试",
};

test("import button copy follows page language, then the extension language", async () => {
  assert.deepEqual(await createSessionImportLabels("en"), english);
  assert.deepEqual(await createSessionImportLabels("en-US"), english);
  assert.deepEqual(await createSessionImportLabels("zh-CN"), chinese);
  assert.deepEqual(await createSessionImportLabels("zh"), chinese);
  assert.deepEqual(await createSessionImportLabels("zh-Hans"), chinese);
  assert.equal(await createSessionImportLabels("ja"), null, "a page language without a loaded catalog keeps its baked copy");

  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const previousFetch = globalThis.fetch;
  try {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: {
      getUILanguage: () => "zh-CN",
      getMessage: key => key === "qz_language" ? "zh-CN" : "",
    } } });
    assert.deepEqual(await createSessionImportLabels(""), chinese, "an empty page language follows the extension");
    assert.deepEqual(await createSessionImportLabels("   "), chinese);

    const catalog = {
      qz_language: { message: "ja" },
      [chromeMessageId("core.importQingzhou")]: { message: "軽舟にインポート" },
      [chromeMessageId("core.importing")]: { message: "インポート中" },
      [chromeMessageId("core.imported")]: { message: "インポートしました" },
      [chromeMessageId("core.retryImport")]: { message: "再試行" },
      [chromeMessageId("core.importFailedRetry")]: { message: "インポートできませんでした。もう一度お試しください。" },
    };
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
      i18n: { getUILanguage: () => "zh-CN", getMessage: () => "" },
      runtime: { getURL: path => `chrome-extension://labels/${path}` },
    } });
    globalThis.fetch = async url => {
      const href = String(url);
      if (href.endsWith("_locales/ja/messages.json")) return new Response(JSON.stringify(catalog), { status: 200 });
      if (href.endsWith("_locales/en/messages.json")) return new Response(JSON.stringify({ qz_language: { message: "en" } }), { status: 200 });
      return new Response("missing", { status: 404 });
    };
    assert.equal((await createSessionImportLabels("ja")).importQingzhou, "軽舟にインポート");
    assert.equal((await createSessionImportLabels("en")).importQingzhou, "Continue in qz", "page English wins over the extension language");
  } finally {
    globalThis.fetch = previousFetch;
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else delete globalThis.chrome;
  }
});

test("import label payloads and button states stay bounded", () => {
  assert.deepEqual(readSessionImportLabels(english), english);
  assert.equal(readSessionImportLabels({ ...english, importQingzhou: "" }), null);
  assert.deepEqual(readSessionImportLabels({ ...english, extra: "ignored" }), english);
  assert.equal(readSessionImportLabels(null), null);
  assert.equal(sessionImportButtonText({ busy: false, imported: false, titled: false }, english), "Continue in qz");
  assert.equal(sessionImportButtonText({ busy: true, imported: false, titled: true }, english), "Importing");
  assert.equal(sessionImportButtonText({ busy: false, imported: true, titled: true }, english), "Imported");
  assert.equal(sessionImportButtonText({ busy: false, imported: false, titled: true }, chinese), "重试导入");
});

test("import labels are available before data-consent acceptance", async () => {
  const worker = readFileSync("src/background/service-worker.ts", "utf8");
  const gate = worker.slice(worker.indexOf("}, path => {"));
  assert.match(gate.slice(0, gate.indexOf("dataConsent.assertAccepted()")), /"system\.sessionImportLabels"/);

  const transport = createRuntimeMessageTransport(createBackgroundApi({
    system: { sessionImportLabels: async language => ({ language, importQingzhou: "Continue in qz" }) },
  }));
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("label request timed out")), 1000);
    const keep = transport.listener({ type: "session_export_import_labels", language: "en" }, {}, value => {
      clearTimeout(timer);
      resolve(value);
    });
    assert.equal(keep, true);
  });
  assert.deepEqual(response, { ok: true, labels: { language: "en", importQingzhou: "Continue in qz" } });
});
