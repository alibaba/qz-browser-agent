import { createServer } from 'node:http';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export async function startElementReferencePage() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/pixel.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(PNG); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/frame') {
      const kind = url.searchParams.get('kind') === 'cross' ? 'cross' : 'same';
      response.end(`<!doctype html><title>Child document ${kind}</title><button id="frame-action" onclick="document.body.dataset.clicked='yes'">Frame ${kind}</button>
        <button onclick="document.body.dataset.imageClicked='yes'"><img id="photo" alt="Frame picture ${kind}" src="/pixel.png" width="48" height="48"></button>`);
      return;
    }
    const port = server.address().port;
    response.end(`<!doctype html><title>Element reference fixture</title>
      <style>body{margin:12px}button{min-height:24px}iframe{display:block;width:400px;height:120px}
        .reference-switch{position:relative;width:180px;margin-bottom:8px}
        .reference-switch label,.reference-label{display:block;width:180px;padding:8px;background:#eee;cursor:pointer}
        #overlay-toggle{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;z-index:2}
        #detached-toggle{position:absolute;left:420px;top:12px;width:1px;height:1px;opacity:0}</style>
      <div class="reference-switch"><input id="overlay-toggle" type="checkbox" role="button" aria-label="Overlay menu"
        oninput="this.dataset.inputTrusted=String(event.isTrusted)"><label id="overlay-label" for="overlay-toggle">Overlay menu label</label></div>
      <input id="detached-toggle" type="checkbox" role="button" aria-label="Detached menu"
        oninput="this.dataset.inputTrusted=String(event.isTrusted)">
      <section><label id="detached-label" class="reference-label" for="detached-toggle">Detached menu label</label></section>
      <section id="region"><p>Scoped region only</p><button id="alpha" onclick="this.dataset.clicked='yes'">Alpha</button></section>
      <p>Outside scope marker</p><button onclick="document.body.dataset.imageClicked='yes'"><img id="photo" alt="Main picture" src="/pixel.png" width="48" height="48"></button>
      <div id="shadow"></div><iframe id="same" src="/frame?kind=same"></iframe>
      <iframe id="cross" src="http://127.0.0.2:${port}/frame?kind=cross"></iframe>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-action">Shadow action</button><img id="shadow-photo" alt="Shadow picture" src="/pixel.png" width="48" height="48">';</script>`);
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => {
    server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
  } };
}
