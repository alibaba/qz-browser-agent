import { createServer } from 'node:http';

/** Synthetic task corpus: document forms, SPA updates and open-shadow controls. */
export async function startDriveTaskPage() {
  const cases = new Map(), receipts = [], held = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    const [kind, id] = url.pathname.split('/').filter(Boolean);
    const task = cases.get(id);
    if (!task) { response.writeHead(404); response.end(); return; }
    response.setHeader('cache-control', 'no-store');
    if (kind === 'submit') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const receipt = { id, ...JSON.parse(body) };
      receipts.push(receipt);
      if (task.hold) await new Promise(resolve => held.set(id, resolve));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ saved: true })); return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (kind === 'receipt') {
      response.end(`<!doctype html><title>Receipt ${id}</title><article><h1>Receipt ${id}</h1><p>Unit price ${task.price}</p></article>`);
      return;
    }
    const controls = `<label>Quantity<input id="quantity" aria-label="Quantity" value="1"></label>
      <label>Shipping<select id="shipping" aria-label="Shipping"><option value="standard">Standard</option><option value="express">Express</option></select></label>
      <label><input id="gift" type="checkbox" aria-label="Gift wrap">Gift wrap</label>
      <button id="save">Save order</button><output id="result"></output>`;
    response.end(`<!doctype html><meta charset="utf-8"><title>Order ${id}</title>
      <style>body{font:18px sans-serif;padding:20px}label,button,a{display:block;margin:12px}#task{display:block}</style>
      <aside><button disabled>Save order</button><input aria-label="Quantity" value="999"></aside>
      <article><h1>Order ${id}</h1><p>Unit price ${task.price}</p></article>
      <div id="task"></div><a id="receipt" href="/receipt/${id}" target="_blank">Read receipt</a>
      <script>
        const host=document.querySelector('#task');
        const root=${task.mode === 'shadow' ? "host.attachShadow({mode:'open'})" : 'host'};
        function mount(){
          root.innerHTML=${JSON.stringify(controls)};
          root.querySelector('#save').onclick=async()=>{
            const quantity=root.querySelector('#quantity').value;
            const shipping=root.querySelector('#shipping').value;
            const gift=root.querySelector('#gift').checked;
            await fetch('/submit/${id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quantity,shipping,gift})});
            root.querySelector('#result').textContent=String(Number(quantity)*${task.price}+(shipping==='express'?17:5)+(gift?3:0));
            document.body.dataset.saved='yes';
            ${task.mode === 'spa' ? `history.pushState({},'', '/done/${id}');` : ''}
          };
          document.body.dataset.ready='yes';
        }
        setTimeout(mount,${task.delay});
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, receipts,
    add(id, task) { cases.set(id, task); return `${origin}/order/${id}`; },
    release(id) { held.get(id)?.(); held.delete(id); },
    close() {
      for (const release of held.values()) release();
      server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
    },
  };
}
