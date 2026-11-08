import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installFirefoxDebugger } from "../../src/background/firefox/debugger-host.js";

function browserFixture({ granted = true, globals = {}, execute } = {}) {
  const calls = [];
  let committed;
  const browser = {
    permissions: { async contains() { return granted; } },
    webNavigation: {
      async getFrame({ frameId }) { return { documentId: `document-${frameId}` }; },
      onCommitted: { addListener(listener) { committed = listener; } },
    },
    userScripts: { async execute(injection) {
      calls.push(injection);
      if (execute) return execute(injection);
      const frameId = Number(injection.target.documentIds[0].slice("document-".length));
      try {
        return [{ frameId, result: await runInNewContext(injection.js[0].code, {
          ...globals, Function() { throw new EvalError("call to Function() blocked by CSP"); },
        }) }];
      } catch (error) { return [{ frameId, error }]; }
    } },
  };
  installFirefoxDebugger(browser);
  const send = (expression, options = {}) => browser.debugger.sendCommand({ tabId: 8, ...options.target }, "Runtime.evaluate", {
    expression, returnByValue: true, ...options.params,
  });
  return { browser, calls, send, navigate: frameId => committed({ tabId: 8, frameId, url: "https://next.test/" }) };
}

test("Firefox compiles full MAIN expressions natively under strict page CSP", async () => {
  const fixture = browserFixture({ globals: { document: { title: "Strict CSP" } } });
  await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
  const response = await fixture.send(`((input) => (async () => {
    const trace = ["read title"];
    return { success: true, data: { title: document.title, input }, trace };
  })())({ answer: 42 })`, { params: { awaitPromise: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    result: { type: "object", value: { success: true, data: { title: "Strict CSP", input: { answer: 42 } }, trace: ["read title"] } },
  });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].world, "MAIN");
  assert.equal(fixture.calls[0].injectImmediately, true);
  assert.deepEqual(fixture.calls[0].target, { tabId: 8, documentIds: ["document-0"] });
  const strict = await fixture.send("this === globalThis && (() => this === globalThis)()");
  assert.equal(strict.result.value, true, "the expression retains the page global receiver, including arrow closures");
  const frame = await fixture.send("7", { target: { sessionId: "ff-8-7" } });
  assert.equal(frame.result.value, 7);
  assert.deepEqual(fixture.calls[2].target.documentIds, ["document-7"]);
});

test("Firefox preserves primitive values and maps runtime, async and native syntax errors", async () => {
  const fixture = browserFixture();
  await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
  for (const [expression, expected] of [
    ["undefined", { type: "undefined" }], ["null", { type: "object", subtype: "null", value: null }],
    ["true", { type: "boolean", value: true }], ["42", { type: "number", value: 42 }],
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify((await fixture.send(expression)).result)), expected);
  }
  for (const expression of ["(() => { throw new TypeError('bad input'); })()", "Promise.reject(new TypeError('bad input'))", "const value = ;"]) {
    const result = await fixture.send(expression);
    assert.equal(result.result, undefined);
    assert.match(result.exceptionDetails.text, /^(TypeError: bad input|SyntaxError:)/);
    assert.equal(result.exceptionDetails.exception.description, result.exceptionDetails.text);
  }
  assert.equal(fixture.calls.length, 7, "failed expressions are never replayed");
  assert.equal((await fixture.send("1 + 2")).result.value, 3);
});

test("Firefox requests permission explicitly and notices revocation without replay", async () => {
  const fixture = browserFixture({ granted: false });
  await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
  const required = error => error.code === "BROWSER_PERMISSION_REQUIRED" && typeof error.hint === "string";
  await assert.rejects(fixture.send("1"), required);
  assert.equal(fixture.calls.length, 0);
  fixture.browser.permissions.contains = async () => true;
  const native = fixture.browser.userScripts;
  delete fixture.browser.userScripts;
  await assert.rejects(fixture.send("1"), required);
  fixture.browser.userScripts = native;
  assert.equal((await fixture.send("1")).result.value, 1, "a newly granted namespace is read dynamically");
  fixture.browser.userScripts.execute = async () => {
    fixture.browser.permissions.contains = async () => false;
    throw new Error("permission revoked");
  };
  await assert.rejects(fixture.send("1"), required);
});

test("Firefox rejects stale evaluation results after frame or top-level navigation", async () => {
  for (const navigatedFrame of [0, 7]) {
    let resolve;
    const fixture = browserFixture({ execute: () => new Promise(done => { resolve = done; }) });
    await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
    const pending = fixture.send("1", { target: { sessionId: "ff-8-7" } });
    await new Promise(done => setImmediate(done));
    fixture.navigate(navigatedFrame);
    resolve([{ frameId: 7, result: { result: { type: "number", value: 1 } } }]);
    await assert.rejects(pending, /Execution context was destroyed/);
    assert.equal(fixture.calls.length, 1);
  }
});

test("Firefox does not dispatch into a replacement document during target lookup", async () => {
  const fixture = browserFixture();
  await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
  fixture.browser.webNavigation.getFrame = async () => {
    fixture.navigate(0);
    return { documentId: "replacement-document" };
  };
  await assert.rejects(fixture.send("1"), /Execution context was destroyed/);
  assert.equal(fixture.calls.length, 0);
  fixture.browser.webNavigation.getFrame = async () => null;
  await assert.rejects(fixture.send("1"), /Execution context was destroyed/);
  assert.equal(fixture.calls.length, 0, "missing documents never fall back to a frame target");
});

test("Firefox checks cancellation after permission wait and after native execution", async () => {
  const fixture = browserFixture();
  await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
  const abort = new AbortController();
  fixture.browser.permissions.contains = async () => { abort.abort(new Error("cancelled")); return true; };
  await assert.rejects(fixture.browser.debugger.sendCommandWithScope({ tabId: 8 }, "Runtime.evaluate", { expression: "1" }, {
    signal: abort.signal, check() {},
  }), /cancelled/);
  assert.equal(fixture.calls.length, 0);

  const next = new AbortController();
  fixture.browser.permissions.contains = async () => true;
  fixture.browser.userScripts.execute = async () => {
    next.abort(new Error("cancelled after execution"));
    return [{ frameId: 0, result: { result: { type: "number", value: 1 } } }];
  };
  await assert.rejects(fixture.browser.debugger.sendCommandWithScope({ tabId: 8 }, "Runtime.evaluate", { expression: "1" }, {
    signal: next.signal, check() {},
  }), /cancelled after execution/);
});

test("Firefox treats missing per-frame results as context loss", async () => {
  const fixture = browserFixture({ execute: async () => [] });
  await fixture.browser.debugger.attach({ tabId: 8 }, "1.3");
  await assert.rejects(fixture.send("1"), /Execution context was destroyed/);
  assert.equal(fixture.calls.length, 1);
});
