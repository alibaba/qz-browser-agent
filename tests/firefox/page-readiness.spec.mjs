import { createServer } from "node:http";
import { expect, test } from "./fixture.mjs";

test("page readers wait for initial navigation before extracting", async ({ firefoxSidebar: session }) => {
  const held = [];
  const server = createServer((request, response) => {
    if (request.url === "/slow") held.push(response);
    else { response.writeHead(204); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/slow`;
  let tabId;
  const readers = [
    ["read_article", { limit: 1200 }], ["read_dom", {}], ["find_elements", { target: "button" }],
    ["inspect_element", { target: "css:article" }], ["list_images", {}],
    ["get_ax_tree", {}], ["screenshot", {}],
  ];
  try {
    // The Firefox harness supplies target authorization; the shared unit and Chrome
    // fixtures exercise the production Session manager. Use native navigation here.
    tabId = await session.extension("background", `
      const tab = await view.chrome.tabs.create(Cu.cloneInto({ url: "about:blank", active: false }, content));
      await view.chrome.tabs.update(tab.id, Cu.cloneInto({ url: ${JSON.stringify(url)} }, content));
      return tab.id;
    `);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    for (const [name, args] of readers) {
      const result = await callTool(session, name, { ...args, tabId, timeout: 0.1 });
      expect(result.code, `${name}: ${JSON.stringify(result)}`).toBe("TOOL_TIMEOUT");
      expect(result).not.toHaveProperty("incomplete");
      if (name !== "list_images") {
        expect(result.details?.pageState, JSON.stringify(result)).toMatchObject({ status: "loading", loading: true });
      }
      expect(result).not.toHaveProperty("tabId");
      expect(result).not.toHaveProperty("tabRef");
      expect(await session.extension("background", `return (await view.chrome.tabs.get(${tabId})).status;`)).toBe("loading");
    }
    for (const response of held.splice(0)) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Ready</title><article>Firefox loaded article.</article><button>Loaded action</button>");
    }
    for (const [name, args] of readers) {
      const result = await callTool(session, name, { ...args, tabId, timeout: 5 });
      expect(result, `${name}: ${JSON.stringify(result)}`).not.toHaveProperty("message");
      expect(result).not.toHaveProperty("incomplete");
      if (name === "read_article" || name === "read_dom" || name === "inspect_element") expect(JSON.stringify(result)).toContain("Firefox loaded article");
      if (name === "find_elements" || name === "get_ax_tree") expect(JSON.stringify(result)).toContain("Loaded action");
      if (name === "screenshot") expect(result._image).toBeTruthy();
    }
  } finally {
    if (tabId) await session.extension("background", `await view.chrome.tabs.remove(${tabId});`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

function callTool(session, name, args) {
  return session.extension("background", `
    const request = ${JSON.stringify({ name, args })};
    const context = Cu.cloneInto({ sessionId: "firefox-readiness", runId: "run", workingTabId: request.args.tabId, source: "agent" }, content);
    try {
      const result = await view.__qzFirefoxPageTools.execute(request.name, Cu.cloneInto(request.args, content), undefined, context);
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      const failure = Cu.waiveXrays(error);
      return { code: String(failure.code || ""), message: String(failure.message || failure),
        ...(failure.details ? { details: JSON.parse(JSON.stringify(failure.details)) } : {}) };
    }
  `);
}

test('evaluation prepares DOM while element tools observe the current document', async ({ firefoxSidebar: session }) => {
  const held = new Map();
  const server = createServer((request, response) => {
    if (request.url.endsWith('.js')) { held.set(request.url, response); return; }
    response.setHeader('Content-Type', 'text/html');
    const body = '<input id="field"><button id="tap" onclick="this.dataset.clicked=\'yes\'">Tap</button>';
    response.end(request.url === '/head'
      ? `<!doctype html><head><script src="/head.js"></script></head><body>${body}</body>`
      : `<!doctype html><body>${body}<script src="/tail.js"></script></body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const release = path => { const response = held.get(path); response?.end('// ready'); held.delete(path); };
  let tabId, timer;
  try {
    tabId = await session.extension('background', `return (await view.chrome.tabs.create(Cu.cloneInto({url:'about:blank',active:false},content))).id;`);
    const call = (name, args = {}) => callTool(session, name, { tabId, timeout: 5, ...args });
    await call('navigate', { url: `${origin}/head` });
    expect(await call('evaluate', { waitUntil: 'commit', code: '() => !!document.body' })).toBe(false);
    let completed = false;
    const prepared = call('evaluate', { code: '() => !!document.body' }).then(value => { completed = true; return value; });
    timer = setTimeout(() => release('/head.js'), 250);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(completed).toBe(false);
    expect(await prepared).toBe(true);
    await call('navigate', { url: `${origin}/tail` });
    for (const state of ['attached', 'visible']) {
      const found = await call('wait_for_element', { target: 'css:#field', state, timeout: 1 });
      expect(found, JSON.stringify(found)).toMatchObject({ found: true });
      expect(await call('act_on_element', { target: found.target, action: 'fill', value: state })).toEqual({});
    }
    expect(await call('act_on_element', { target: 'css:#tap', action: 'click' })).toEqual({});
    expect(await call('evaluate', { waitUntil: 'commit', code: '() => ({state:document.readyState,clicked:document.querySelector("#tap").dataset.clicked})' }))
      .toEqual({ state: 'loading', clicked: 'yes' });
  } finally {
    clearTimeout(timer);
    for (const path of held.keys()) release(path);
    if (tabId) await session.extension('background', `await view.chrome.tabs.remove(${tabId});`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
