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
  const document = { documentId: `doc-${++documentSerial}` };
  globalThis.document = document;
  globalThis.addEventListener = (type, listener, capture) => {
    listeners.push({ type, listener, capture });
  };
  delete globalThis.__qzInputReceipt;
  return { document, listeners };
}
