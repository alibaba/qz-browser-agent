import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { resolve } from "node:path";
import { serializeConversation } from "../../src/shared/session/session-codec.js";
import { createSessionExchangePayload } from "../../src/shared/session/session-exchange.js";
import { createSessionExchangeBridge } from "../../src/background/services/session-exchange-bridge.js";
import { compileEmbeddedScript } from "../../scripts/build-extension.mjs";

const DENIED = [
  "https://example.com/",
  "https://alibaba.github.io/other-repo/",
  "http://alibaba.github.io/qz-browser-agent/",
];

test("pages outside the import allowlist keep the button hidden and the background rejects the import", async () => {
  const bridgeBundle = await compileEmbeddedScript({
    sourceDir: resolve("src"),
    entry: "content/session-export-bridge.ts",
    mode: "production",
  });
  const allowed = installExportBridge(bridgeBundle, "http://127.0.0.1/export.html");
  assert.equal(allowed.importable, true, "the harness must show the button on an allowed page");
  assert.equal(allowed.hidden, false);
  assert.ok(allowed.probes > 0);

  const imported = [];
  const opened = [];
  const bridge = createSessionExchangeBridge({
    sidePanel: { open: async input => { opened.push(input); } },
    importSessionExchange: async () => {
      imported.push(true);
      return { session: { id: "should-not-import" } };
    },
    channel: { hasPorts: () => false, broadcast() {}, remember() {} },
    logger: { debug() {} },
    consentAccepted: () => true,
  });
  const payload = createSessionExchangePayload({
    session: { id: "source", title: "Denied" },
    conversation: serializeConversation([{ role: "user", content: "import me" }]),
    transcript: [],
    exportedAt: "2026-07-12 12:00:00",
  });
  for (const url of DENIED) {
    const page = installExportBridge(bridgeBundle, url);
    assert.equal(page.importable, false, url);
    assert.equal(page.hidden, true, url);
    assert.equal(page.probes, 0, url);
    await assert.rejects(
      () => bridge.importFromPage({ payload }, { tab: { url, id: 1, windowId: 2 } }),
      error => error?.code === "SESSION_EXPORT_SOURCE_NOT_ALLOWED",
      url,
    );
  }
  assert.equal(imported.length, 0);
  assert.equal(opened.length, 0);
});

const PAGE_HARNESS = `
class HTMLScriptElement {}
class HTMLButtonElement {}
class Element {}
class Node {}
class MutationObserver { observe() {} disconnect() {} }
const listeners = [];
const script = new HTMLScriptElement();
script.type = "application/json";
script.textContent = JSON.stringify({ format: "qingzhou.session", version: 1 });
const button = {
  hidden: true,
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, String(value)); },
  hasAttribute(name) { return this.attributes.has(name); },
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
  parentElement: null,
};
const document = {
  documentElement: { lang: "en" },
  getElementById(id) {
    if (id === "qingzhou-session-exchange") return script;
    if (id === "qingzhou-session-cta") return button;
    return null;
  },
  contains(node) { return node === script || node === button; },
  addEventListener() {},
};
const window = {
  document,
  __importProbes: 0,
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
  postMessage(data) {
    if (data && data.type === "qingzhou:session-export:result" && data.action === "probe" && data.installed) {
      window.__importProbes += 1;
      button.hidden = false;
      button.setAttribute("data-qingzhou-session-import", "");
    }
    const event = { source: window, data };
    for (const listener of listeners.slice()) listener(event);
  },
};
globalThis.window = window;
globalThis.document = document;
globalThis.HTMLScriptElement = HTMLScriptElement;
globalThis.HTMLButtonElement = HTMLButtonElement;
globalThis.Element = Element;
globalThis.Node = Node;
globalThis.MutationObserver = MutationObserver;
`;

function installExportBridge(bundle, href) {
  const sandbox = {
    console,
    location: new URL(href),
    chrome: {
      runtime: {
        getManifest: () => ({ name: "qz", version: "0.0.0" }),
        sendMessage: () => Promise.resolve({ ok: false }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(PAGE_HARNESS, sandbox, { filename: "export-page-harness.js" });
  vm.runInContext(bundle, sandbox, { filename: "session-export-bridge.js" });
  vm.runInContext(
    `window.postMessage({ type: "qingzhou:session-export:probe", requestId: "allowlist" });`,
    sandbox,
  );
  return vm.runInContext(`({
    importable: document.getElementById("qingzhou-session-cta").hasAttribute("data-qingzhou-session-import"),
    hidden: document.getElementById("qingzhou-session-cta").hidden === true,
    probes: window.__importProbes,
  })`, sandbox);
}
