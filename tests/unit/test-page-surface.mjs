import assert from "node:assert/strict";
import test from "node:test";

const sizes = [];
let runInPage = null;
globalThis.chrome = {
  scripting: {
    async executeScript(options) {
      if (runInPage) return [{ result: runInPage(options) }];
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
    await armPageInputReceipt(7);
    assert.equal(await readPageInputReceipt(7), 0);
    page.listeners[0]({ isTrusted: false });
    assert.equal(await readPageInputReceipt(7), 0);
    page.listeners[0]({ isTrusted: true });
    assert.equal(await readPageInputReceipt(7), 1);

    const next = installPage();
    assert.equal(await readPageInputReceipt(7), null);
    assert.equal(next.document.__qzInputReceiptBound, undefined);
  } finally {
    runInPage = null;
    delete globalThis.document;
    delete globalThis.__qzInputReceipt;
  }
});

function installPage() {
  const listeners = [];
  const document = {
    addEventListener(_type, listener) { listeners.push(listener); },
  };
  globalThis.document = document;
  delete globalThis.__qzInputReceipt;
  return { document, listeners };
}
