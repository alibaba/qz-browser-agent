import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

/** Real-provider acceptance of the documented batch contract, isolated from user Sessions. */
export async function runPageBatchCase({ page, createSession, deleteSession, runPrompt, historyMessages, recordEvidence = () => {} }) {
  const records = new Map();
  let holdDocument;
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/head.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      if (holdDocument) {
        const hold = holdDocument; holdDocument = null;
        hold(req, res);
        return;
      }
      setTimeout(() => res.end('// parsing can continue'), 150);
      return;
    }
    const item = records.get(req.url);
    if (!item) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><head><script src="/head.js"></script><title>${item.name}</title></head><body><article><h1>${item.name}</h1><p>商品校验码：${item.code}</p></article></body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const trials = [];
  try {
    for (let trial = 1; trial <= 3; trial++) {
      const left = { name: '青松杯', code: `LEFT_${randomBytes(4).toString('hex')}` };
      const right = { name: '白云杯', code: `RIGHT_${randomBytes(4).toString('hex')}` };
      records.set(`/left-${trial}`, left); records.set(`/right-${trial}`, right);
      const sessionId = await createSession(page, `Batch page references ${trial}`);
      try {
        const start = Date.now();
        let releaseDocument;
        const documentRequested = new Promise(resolve => {
          holdDocument = (req, res) => {
            releaseDocument = () => res.end('// parsing can continue');
            resolve(req.headers.referer);
          };
        });
        const after = await page.evaluate(() => window.__qzLiveHarness.count());
        const pending = runPrompt(page, sessionId,
          `用 open_tab 和 read_article 打开并读取这两个页面：${origin}/left-${trial} 和 ${origin}/right-${trial}。分别列出商品名称和校验码，每个商品一行。`, { timeoutMs: 120_000 });
        void pending.catch(() => {});
        let liveStart;
        try {
          const url = await Promise.race([documentRequested, pending.then(() => {
            throw new Error('the real task must request a fixture document');
          })]);
          await page.waitForFunction(({ sessionId, after, url }) => window.__qzLiveHarness.eventsSince(after).some(event =>
            event.sessionId === sessionId && event.type === 'tool_execution_start' && event.toolName === 'open_tab' && event.args?.url === url),
          { sessionId, after, url }, { timeout: 5000 });
          const events = await page.evaluate(after => window.__qzLiveHarness.eventsSince(after), after);
          liveStart = events.find(event => event.sessionId === sessionId && event.type === 'tool_execution_start' && event.args?.url === url);
          assert.ok(liveStart, 'tool start must reach the Side Panel while document parsing is blocked');
          assert.equal(events.some(event => event.type === 'tool_execution_end' && event.toolCallId === liveStart.toolCallId), false);
        } finally {
          holdDocument = null;
          releaseDocument?.();
        }
        const result = await pending;
        const elapsedMs = Date.now() - start;
        const messages = await historyMessages(page, sessionId);
        const batches = messages.filter(m => m.role === 'assistant' && m.tool_calls?.length).map(m => m.tool_calls.map(call => ({
          id: call.id, name: call.function?.name || call.name,
          args: typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments || call.arguments || {},
        })));
        const hasBoundBatch = batches.some(calls => {
          const opens = calls.filter(call => call.name === 'open_tab' && call.args.tabAlias);
          const reads = calls.filter(call => call.name === 'read_article' && opens.some(open => open.args.tabAlias === call.args.tabRef));
          return opens.length >= 2 && reads.length >= 2;
        });
        assert.ok(result.assistantText.includes(left.code), result.assistantText);
        assert.ok(result.assistantText.includes(right.code), result.assistantText);
        assert.ok(result.assistantText.includes(left.name) && result.assistantText.includes(right.name));
        const record = { trial, elapsedMs, hasBoundBatch, startObservedBeforePageReady: Boolean(liveStart),
          modelTurns: messages.filter(m => m.role === 'assistant').length,
          batches, answer: result.assistantText };
        trials.push(record);
        recordEvidence({ trials });
        console.log(JSON.stringify({ trial, elapsedMs, hasBoundBatch, toolBatches: batches.length }));
        if (process.env.QZ_PAGE_BATCH_EXPECT_BINDINGS !== '0') assert.equal(hasBoundBatch, true,
          'the system prompt and tool schemas should elicit open + referenced reads in one response');
      } finally { await deleteSession(page, sessionId); }
    }
    return { trials };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
