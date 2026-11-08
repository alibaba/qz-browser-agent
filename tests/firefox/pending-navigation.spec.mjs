import { createServer } from "node:http";
import { expect, test } from "./fixture.mjs";

test("fast localhost loads do not leave pendingUrl, and find_elements sees an open shadow button", async ({ firefoxSidebar: session }) => {
  test.setTimeout(60000);
  const page = `<!doctype html><title>open-shadow-fixture</title><button id="light">light-btn</button><div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML='<button id="shadow-btn">shadow-btn</button>'</script>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let tabId;
  try {
    tabId = await session.extension("background", `
      const tab = await view.chrome.tabs.create(Cu.cloneInto({ url: "about:blank", active: false }, content));
      return tab.id;
    `);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const url = `${origin}/shadow.html?n=${attempt}`;
      await session.extension("background", `
        await view.chrome.tabs.update(${tabId}, Cu.cloneInto({ url: ${JSON.stringify(url)} }, content));
      `);
      await expect.poll(async () => session.extension("background", `
        const tab = await view.chrome.tabs.get(${tabId});
        return { url: tab.url, status: tab.status };
      `), { timeout: 3000 }).toEqual({ url, status: "complete" });
      // The late main-frame request arrives just after the document is complete.
      await new Promise(resolve => setTimeout(resolve, 200));
      const tab = await session.extension("background", `
        const tab = await view.chrome.tabs.get(${tabId});
        return { url: tab.url, status: tab.status, pendingUrl: tab.pendingUrl || "" };
      `);
      expect(tab, JSON.stringify(tab)).toEqual({ url, status: "complete", pendingUrl: "" });
    }
    const found = await callTool(session, "find_elements", { tabId, pattern: "shadow-btn", timeout: 5 });
    expect(found, JSON.stringify(found)).not.toHaveProperty("incomplete");
    expect(found, JSON.stringify(found)).not.toHaveProperty("error");
    expect(JSON.stringify(found)).toContain("shadow-btn");
    const light = await callTool(session, "find_elements", { tabId, pattern: "light-btn", timeout: 5 });
    expect(light, JSON.stringify(light)).not.toHaveProperty("incomplete");
    expect(JSON.stringify(light)).toContain("light-btn");
  } finally {
    if (tabId) await session.extension("background", `await view.chrome.tabs.remove(${tabId});`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("same-URL navigate of a fast page succeeds", async ({ firefoxSidebar: session }) => {
  test.setTimeout(60000);
  const page = "<!doctype html><meta charset=\"utf-8\"><title>fast-fixture</title><h1>fast page</h1><p id=\"stamp\"></p><script>document.getElementById('stamp').textContent='load-'+Date.now()</script>";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/fast.html`;
  let tabId;
  try {
    tabId = await session.extension("background", `
      const tab = await view.chrome.tabs.create(Cu.cloneInto({ url: ${JSON.stringify(url)}, active: false }, content));
      return tab.id;
    `);
    await expect.poll(async () => session.extension("background", `
      const tab = await view.chrome.tabs.get(${tabId});
      return tab.status;
    `), { timeout: 3000 }).toBe("complete");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reloaded = await callTool(session, "navigate", { tabId, url });
      expect(reloaded, JSON.stringify(reloaded)).not.toHaveProperty("code");
      expect(reloaded, JSON.stringify(reloaded)).not.toHaveProperty("error");
      expect(reloaded.url).toBe(url);
    }
    const found = await callTool(session, "find_elements", { tabId, pattern: "load-", timeout: 5 });
    expect(found, JSON.stringify(found)).not.toHaveProperty("incomplete");
    expect(JSON.stringify(found)).toContain("load-");
  } finally {
    if (tabId) await session.extension("background", `await view.chrome.tabs.remove(${tabId});`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

function callTool(session, name, args) {
  return session.extension("background", `
    const request = ${JSON.stringify({ name, args })};
    const context = Cu.cloneInto({ sessionId: "firefox-pending-navigation", runId: "run", workingTabId: request.args.tabId, source: "agent" }, content);
    try {
      const result = await view.__qzFirefoxPageTools.execute(request.name, Cu.cloneInto(request.args, content), undefined, context);
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      const failure = Cu.waiveXrays(error);
      return { code: String(failure.code || ""), error: String(failure.message || failure) };
    }
  `);
}
