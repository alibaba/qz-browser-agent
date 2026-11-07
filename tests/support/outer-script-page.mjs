import { createServer } from 'node:http';

/** Local pages expose observable navigation, AJAX and popup effects without a provider. */
export async function startOuterScriptPage() {
  const requests = [], held = new Map();
  const html = path => `<!doctype html><meta charset="utf-8"><title>Outer script ${path}</title>
    <style>body{font:18px sans-serif;padding:24px}button,a,input{display:block;margin:12px;padding:10px}</style>
    <h1>${path}</h1><a id="navigate" href="/next">Navigate document</a>
    <button id="continue" onclick="document.body.dataset.continued='yes'">Continue after navigation</button>
    <button id="more" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);fetch('/api/more').then(r=>r.json()).then(rows=>{document.querySelector('#count').textContent=String(rows.length);document.body.dataset.more='loaded'})">More</button>
    <span id="count">1</span><input id="edit" value="0">
    <a id="popup" href="/popup" target="_blank">Open child</a>
    <a id="popup-late" href="/popup-late" target="_blank">Open delayed child</a>
    <script>document.body.dataset.documentToken=crypto.randomUUID();</script>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    requests.push({ path: url.pathname, lane: url.searchParams.get('lane'), at: Date.now() });
    if (url.pathname === '/hold' || url.pathname === '/popup-late') {
      const key = url.pathname === '/hold' ? url.searchParams.get('lane') : 'popup-late';
      const responses = held.get(key) || []; responses.push(response); held.set(key, responses);
      return;
    }
    if (url.pathname === '/api/more') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify([{ name: 'first' }, { name: 'second' }])); return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html(url.pathname));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests,
    pending: lane => (held.get(lane) || []).filter(response => !response.destroyed).length,
    release(lane) {
      for (const response of held.get(lane) || []) {
        if (response.destroyed) continue;
        response.writeHead(200, { 'content-type': lane === 'popup-late' ? 'text/html; charset=utf-8' : 'application/json' });
        response.end(lane === 'popup-late' ? html('/popup-late') : JSON.stringify({ released: lane }));
      }
      held.delete(lane);
    },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}
