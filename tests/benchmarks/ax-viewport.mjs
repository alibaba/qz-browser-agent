import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAxViewportHarness } from '../support/ax-viewport-harness.mjs';

export async function serveAxFixtures() {
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!/^[a-z-]+\.html$/.test(name)) return response.writeHead(404).end();
    try { response.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(resolve('tests/fixtures/ax-snapshot', name))); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export async function measureAxSizes(output = 'tests/results/viewport-ax') {
  await mkdir(output, { recursive: true });
  const server = await serveAxFixtures();
  const h = await createAxViewportHarness();
  const pages = [
    ['Long article', `${server.url}/viewport-article.html`],
    ['Dense form', `${server.url}/viewport-dense-form.html`],
    ['Lazy list (60 of 5000 mounted)', `${server.url}/viewport-lazy-list.html`],
    ['Modal form', `${server.url}/form-modal.html`],
    ['Wikipedia River (live)', 'https://en.wikipedia.org/wiki/River'],
  ];
  const report = { at: new Date().toISOString(), browser: h.browser.version(), viewport: { width: 1280, height: 720 }, depth: 16, actionsLimit: 40, pages: [] };
  try {
    for (const [name, url] of pages) {
      const record = { name, url, rows: [] };
      report.pages.push(record);
      try {
        await h.goto(url);
        for (const [scope, limit] of [['full', 120], ['full', 300], ['viewport', 120], ['viewport', 300], ['viewport', 100000], ['full', 100000]]) {
          const start = performance.now();
          const result = await h.snapshot({ scope, limit });
          const chars = result.snapshot.length;
          const mode = `${scope}+${limit === 100000 ? 'no-BFS' : `BFS@${limit}`}`;
          record.rows.push({ mode, nodes: result.returnedNodeCount, chars, estimatedTokens: Math.ceil(chars / 4), modelJsonChars: JSON.stringify(result).length,
            omitted: result.viewportOmitted || null, bfsTruncated: result.outlineTruncated, rawNodes: result.nodeCount, semanticNodes: result.semanticNodeCount, milliseconds: Math.round(performance.now() - start) });
          await writeFile(resolve(output, `${report.pages.length}-${mode.replaceAll('+', '-')}.txt`), result.snapshot);
        }
        console.log(name, JSON.stringify(record.rows));
      } catch (error) { record.error = String(error); console.log(name, record.error); }
      await writeFile(resolve(output, 'sizes.json'), JSON.stringify(report, null, 2));
    }
  } finally { await h.close(); await server.close(); }
  return report;
}
if (process.argv[1] === new URL(import.meta.url).pathname) await measureAxSizes(process.argv[2]);
