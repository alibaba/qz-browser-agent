import assert from "node:assert/strict";
import test from "node:test";

const sizes = [];
let runInPage = null;
globalThis.chrome = {
  scripting: {
    async executeScript(options) {
      if (runInPage) {
        return [{
          frameId: 0,
          documentId: String(globalThis.document?.documentId || ""),
          result: runInPage(options),
        }];
      }
      return [{ result: sizes.shift() }];
    },
  },
};

const { armPageInputReceipt, ensurePageSurface, readPageInputReceipt } = await import("../../src/background/tools/page-surface.ts");

test("a zero outer size gets one warmup capture and the tab stays in the background", async () => {
  sizes.push({ width: 1200, height: 800 });
  const ready = [];
  await ensurePageSurface(7, async (method) => { ready.push(method); });
  assert.deepEqual(ready, []);

  sizes.push({ width: 0, height: 0 });
  const warm = [];
  await ensurePageSurface(7, async (method) => { warm.push(method); return {}; });
  assert.deepEqual(warm, ["Page.captureScreenshot"]);

  sizes.push(null);
  const unread = [];
  await ensurePageSurface(7, async (method) => { unread.push(method); });
  assert.deepEqual(unread, []);
});

test("a child surface is prepared even when the parent is laid out, and preparation failure propagates", async () => {
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async () => [{ result: { width: 1200, height: 800 } }];
  try {
    const commands = [];
    await ensurePageSurface(7, async method => { commands.push(method); }, { frameId: "child" });
    assert.deepEqual(commands, ["Page.captureScreenshot"]);
    await assert.rejects(ensurePageSurface(7, async () => { throw new Error("frame unavailable"); }, { frameId: "child" }), /frame unavailable/);
  } finally { chrome.scripting.executeScript = original; }
});

test("a replaced document is not counted as a missed click", async () => {
  runInPage = ({ func, args }) => func(...args);
  try {
    const page = installPage();
    const id = await armPageInputReceipt(7);
    assert.equal(typeof id, "string");
    assert.notEqual(id, "");
    const op = () => page.document.__qzInputReceiptsV2.ops[id];
    assert.equal(op().n, 0);
    const pointerdown = page.listeners.find(item => item.type === "pointerdown");
    assert.equal(pointerdown.capture, true);
    pointerdown.listener({ isTrusted: false });
    assert.equal(op().n, 0);
    pointerdown.listener({ isTrusted: true });
    assert.ok(op().n > 0);
    const seen = await readPageInputReceipt(7, id);
    assert.ok(seen > 0);
    assert.equal(op(), undefined, "reading the receipt drops that operation");
    assert.equal(page.timers.size, 0, "a normal read cancels the page expiry timer");
    pointerdown.listener({ isTrusted: true });
    assert.equal(op(), undefined);
    assert.equal(await readPageInputReceipt(7, id), null);

    const follow = await armPageInputReceipt(7);
    pointerdown.listener({ isTrusted: true });
    assert.ok(page.document.__qzInputReceiptsV2.ops[follow].n > 0);
    const next = installPage();
    assert.equal(await readPageInputReceipt(7, follow), null);
    assert.equal(next.document.__qzInputReceiptsV2Bound, undefined);
  } finally {
    runInPage = null;
    delete globalThis.document;
    delete globalThis.__qzInputReceipt;
    delete globalThis.addEventListener;
  }
});

test("an old receipt flag does not block the versioned listener", async () => {
  runInPage = ({ func, args }) => func(...args);
  try {
    const page = installPage();
    page.document.__qzInputReceiptBound = true;
    page.document.__qzInputReceipt = 0;
    const oldListener = event => {
      if (event.isTrusted) page.document.__qzInputReceipt += 1;
    };
    for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) {
      page.listeners.push({ type, listener: oldListener, capture: true });
    }
    const installed = page.listeners.length;
    const id = await armPageInputReceipt(7);
    assert.notEqual(id, "");
    assert.equal(page.document.__qzInputReceiptsV2Bound, true);
    const click = page.listeners.slice(installed).find(item => item.type === "click");
    assert.ok(click, "the upgraded page installs its own listener");
    click.listener({ isTrusted: true });
    assert.equal(page.document.__qzInputReceipt, 0);
    assert.ok(page.document.__qzInputReceiptsV2.ops[id].n > 0);
    assert.ok(await readPageInputReceipt(7, id) > 0);
  } finally {
    runInPage = null;
    delete globalThis.document;
    delete globalThis.addEventListener;
  }
});

test("a delivered iframe is not cancelled by a top frame that saw nothing", async () => {
  await withFrames([{ result: 0 }, { result: 2 }], async () => {
    const id = await armPageInputReceipt(7);
    assert.equal(await readPageInputReceipt(7, id), 2);
  });
});

test("every armed frame at zero is a missed click, and an unreadable armed frame is not", async () => {
  await withFrames([
    { frameId: 0, documentId: "main", result: 0 },
    { frameId: 1, documentId: "child", result: 0 },
  ], async () => {
    const id = await armPageInputReceipt(7);
    assert.equal(await readPageInputReceipt(7, id), 0);
  });
  let calls = 0;
  await withFrames(() => {
    calls += 1;
    if (calls === 1) {
      return [
        { frameId: 0, documentId: "main", result: 0 },
        { frameId: 1, documentId: "child", result: 0 },
      ];
    }
    return [
      { frameId: 0, documentId: "main", result: 0 },
      { frameId: 1, documentId: "child", result: null },
    ];
  }, async () => {
    const id = await armPageInputReceipt(7);
    assert.equal(await readPageInputReceipt(7, id), null);
  });
  await withFrames(async () => { throw new Error("frame gone"); }, async () => {
    assert.equal(await armPageInputReceipt(7), "");
    assert.equal(await readPageInputReceipt(7, "missing"), null);
  });
});

test("a removed iframe does not turn the remaining zero into a miss", async () => {
  let calls = 0;
  await withFrames(() => {
    calls += 1;
    const main = { frameId: 0, documentId: "main", result: 0 };
    if (calls === 1) return [main, { frameId: 4, documentId: "popup", result: 0 }];
    return [main];
  }, async () => {
    const id = await armPageInputReceipt(7);
    assert.notEqual(id, "");
    assert.equal(await readPageInputReceipt(7, id), null);
  });
});

test("a frame that appears after the click does not hide a real miss", async () => {
  let calls = 0;
  await withFrames(() => {
    calls += 1;
    const main = { frameId: 0, documentId: "main", result: 0 };
    if (calls === 1) return [main];
    return [main, { frameId: 8, documentId: "ad", result: null }];
  }, async () => {
    const id = await armPageInputReceipt(7);
    assert.notEqual(id, "");
    assert.equal(await readPageInputReceipt(7, id), 0);
  });
});

test("a stalled surface probe is immediate and bounded without claiming a missing surface", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = options => {
    assert.equal(options.injectImmediately, true);
    return new Promise(() => {});
  };
  try {
    const commands = [];
    const pending = ensurePageSurface(7, async method => { commands.push(method); });
    context.mock.timers.tick(1000);
    await pending;
    assert.deepEqual(commands, []);
  } finally { chrome.scripting.executeScript = original; }
});

test("a stalled receipt read returns unknown and releases its background entry", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = chrome.scripting.executeScript;
  let reads = 0;
  chrome.scripting.executeScript = options => {
    assert.equal(options.injectImmediately, true);
    if (options.args[1]) return Promise.resolve([{ frameId: 0, documentId: "main", result: 0 }]);
    reads++;
    return new Promise(() => {});
  };
  try {
    const id = await armPageInputReceipt(7);
    const pending = readPageInputReceipt(7, id);
    context.mock.timers.tick(1000);
    assert.equal(await pending, null, "unavailable delivery evidence is not a missed click");
    assert.equal(await readPageInputReceipt(7, id), null);
    assert.equal(reads, 1, "a timed-out receipt is removed from armedFrames");
  } finally { chrome.scripting.executeScript = original; }
});

for (const delayedExecution of [false, true]) test(`a timed-out arm leaves no permanent receipt (delayed execution: ${delayedExecution})`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const original = chrome.scripting.executeScript;
  const page = installPage();
  let execute, complete;
  chrome.scripting.executeScript = options => {
    assert.equal(options.injectImmediately, true);
    execute = () => options.func(...options.args);
    if (!delayedExecution) execute();
    return new Promise(resolve => { complete = resolve; });
  };
  try {
    const pending = armPageInputReceipt(7);
    context.mock.timers.tick(1000);
    assert.equal(await pending, "");
    if (delayedExecution) {
      assert.equal(execute(), null, "an arm that starts after its deadline is rejected");
      assert.equal(page.document.__qzInputReceiptsV2, undefined);
      assert.equal(page.timers.size, 0);
    } else {
      assert.equal(Object.keys(page.document.__qzInputReceiptsV2.ops).length, 1);
      assert.equal(page.timers.size, 1);
      const [{ callback, delay }] = page.timers.values();
      assert.equal(delay, 30000);
      context.mock.timers.tick(delay);
      callback();
      assert.deepEqual(page.document.__qzInputReceiptsV2.ops, {}, "expiry cleans an arm whose response was lost");
    }
    complete([{ frameId: 0, documentId: page.document.documentId, result: 0 }]);
  } finally {
    chrome.scripting.executeScript = original;
    delete globalThis.document;
    delete globalThis.addEventListener;
  }
});

test("firefox counts marked extension events and chrome still requires a trusted event", async () => {
  const previousRuntime = chrome.runtime;
  try {
    chrome.runtime = { getURL: () => "moz-extension://uuid/" };
    const seen = {};
    runInPage = options => {
      seen.world = options.world;
      seen.accept = options.args[3];
      return options.func(...options.args);
    };
    const page = installPage();
    const id = await armPageInputReceipt(11);
    assert.equal(seen.world, "ISOLATED");
    assert.equal(seen.accept, true);
    const listener = page.listeners.find(item => item.type === "pointerdown");
    const untrusted = { isTrusted: false };
    listener.listener(untrusted);
    assert.equal(page.document.__qzInputReceiptsV2.ops[id].n, 0);
    const marked = new WeakSet();
    globalThis.__qzExtensionInputEvents = marked;
    listener.listener(untrusted);
    assert.equal(page.document.__qzInputReceiptsV2.ops[id].n, 0);
    marked.add(untrusted);
    listener.listener(untrusted);
    assert.ok(page.document.__qzInputReceiptsV2.ops[id].n > 0);
    assert.ok(await readPageInputReceipt(11, id) > 0);

    chrome.runtime = { getURL: () => "chrome-extension://id/" };
    const chromePage = installPage();
    const chromeId = await armPageInputReceipt(12);
    assert.equal(seen.world, "MAIN");
    assert.equal(seen.accept, false);
    const chromeListener = chromePage.listeners.find(item => item.type === "pointerdown");
    const extensionEvent = { isTrusted: false };
    marked.add(extensionEvent);
    chromeListener.listener(extensionEvent);
    assert.equal(chromePage.document.__qzInputReceiptsV2.ops[chromeId].n, 0);
    chromeListener.listener({ isTrusted: true });
    assert.ok(chromePage.document.__qzInputReceiptsV2.ops[chromeId].n > 0);
    assert.ok(await readPageInputReceipt(12, chromeId) > 0);
  } finally {
    if (previousRuntime === undefined) delete chrome.runtime;
    else chrome.runtime = previousRuntime;
    delete globalThis.__qzExtensionInputEvents;
    runInPage = null;
    delete globalThis.document;
    delete globalThis.addEventListener;
  }
});

async function withFrames(results, run) {
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async () => {
    const produced = typeof results === "function" ? await results() : results;
    return produced.map((item, index) => ({
      frameId: item.frameId ?? index,
      documentId: item.documentId ?? `doc-${index}`,
      result: item.result,
    }));
  };
  try { await run(); }
  finally { chrome.scripting.executeScript = original; }
}

let documentSerial = 0;
function installPage() {
  const listeners = [];
  const timers = new Map();
  let nextTimer = 0;
  const document = {
    documentId: `doc-${++documentSerial}`,
    defaultView: {
      setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
      clearTimeout(timer) { timers.delete(timer); },
    },
  };
  globalThis.document = document;
  globalThis.addEventListener = (type, listener, capture) => {
    listeners.push({ type, listener, capture });
  };
  delete globalThis.__qzInputReceipt;
  return { document, listeners, timers };
}
