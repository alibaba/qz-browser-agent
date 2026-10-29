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
    ["read_article", { limit: 1200 }], ["read_dom", {}], ["find_elements", { selector: "button" }],
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
      if (name === "list_images") expect(result.code, JSON.stringify(result)).toBe("TOOL_TIMEOUT");
      else expect(result, JSON.stringify(result)).toMatchObject({ tabId, incomplete: { reason: "timeout" } });
      expect(await session.extension("background", `return (await view.chrome.tabs.get(${tabId})).status;`)).toBe("loading");
    }
    for (const response of held.splice(0)) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Ready</title><article>Firefox loaded article.</article><button>Loaded action</button>");
    }
    for (const [name, args] of readers) {
      const result = await callTool(session, name, { ...args, tabId, timeout: 5 });
      expect(result, `${name}: ${JSON.stringify(result)}`).not.toHaveProperty("error");
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
      return { code: String(failure.code || ""), error: String(failure.message || failure) };
    }
  `);
}
