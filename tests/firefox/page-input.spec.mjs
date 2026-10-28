import { createServer } from "node:http";
import { expect, test } from "./fixture.mjs";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Input fixture</title>
<button id="go" type="button" aria-label="Add">Add</button>
<input id="name" type="text" aria-label="Name">
<input id="box" type="checkbox" aria-label="Agree">
<input id="keys" type="text" aria-label="Keys">
<script>
  window.clicks = 0;
  window.checks = 0;
  window.keys = 0;
  document.querySelector("#go").addEventListener("click", () => { window.clicks += 1; });
  document.querySelector("#box").addEventListener("click", () => { window.checks += 1; });
  document.querySelector("#keys").addEventListener("keydown", event => {
    if (event.key === "a") window.keys += 1;
  });
</script>`;

test("uid and css input succeed once on a page without a content CSP", async ({ firefoxSidebar }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const url = `http://127.0.0.1:${port}/input`;
  const page = firefoxSidebar.page;
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.locator("#go").waitFor();
    const tabId = await firefoxSidebar.extension("background", `
      const tabs = await view.chrome.tabs.query({});
      const match = tabs.find(tab => String(tab.url || "").indexOf(${JSON.stringify(`127.0.0.1:${port}`)}) !== -1);
      return match ? match.id : 0;
    `);
    expect(tabId).toBeGreaterThan(0);

    const tree = await callTool(firefoxSidebar, "get_ax_tree", { tabId });
    expect(tree.thrown, JSON.stringify(tree)).toBeUndefined();
    const button = targetFor(tree.snapshot, "Add");
    const field = targetFor(tree.snapshot, "Name");
    expect(button, tree.snapshot).toMatch(/^uid:/);
    expect(field, tree.snapshot).toMatch(/^uid:/);

    const clicked = await callTool(firefoxSidebar, "act_on_element", { tabId, target: button, action: "click" });
    expect(clicked.thrown, JSON.stringify(clicked)).toBeUndefined();
    expect(clicked.code, JSON.stringify(clicked)).toBeUndefined();
    expect(clicked.inputDelivered, JSON.stringify(clicked)).toBe(true);
    expect(await page.evaluate(() => window.clicks)).toBe(1);
    const receipt = await firefoxSidebar.extension("background", `
      const [frame] = await view.chrome.scripting.executeScript({
        target: { tabId: ${Number(tabId)} },
        world: "ISOLATED",
        func: () => ({
          bound: document.__qzInputReceiptsV2Bound === true,
          marked: globalThis.__qzExtensionInputEvents instanceof WeakSet,
        }),
      });
      return frame && frame.result;
    `);
    expect(receipt).toEqual({ bound: true, marked: true });

    const filled = await callTool(firefoxSidebar, "act_on_element", { tabId, target: field, action: "fill", value: "hello" });
    expect(filled.thrown, JSON.stringify(filled)).toBeUndefined();
    expect(filled.filled, JSON.stringify(filled)).toBe(true);
    expect(await page.evaluate(() => document.querySelector("#name").value)).toBe("hello");

    const cssClick = await callTool(firefoxSidebar, "act_on_element", { tabId, target: "css:#go", action: "click" });
    expect(cssClick.thrown, JSON.stringify(cssClick)).toBeUndefined();
    expect(cssClick.code, JSON.stringify(cssClick)).toBeUndefined();
    expect(cssClick.inputDelivered, JSON.stringify(cssClick)).toBe(true);
    expect(await page.evaluate(() => window.clicks)).toBe(2);

    const pressed = await callTool(firefoxSidebar, "act_on_element", { tabId, target: "css:#keys", action: "press", key: "a" });
    expect(pressed.thrown, JSON.stringify(pressed)).toBeUndefined();
    expect(pressed.code, JSON.stringify(pressed)).toBeUndefined();
    expect(pressed.pressed, JSON.stringify(pressed)).toBe(true);
    expect(await page.evaluate(() => window.keys)).toBe(1);

    const checked = await callTool(firefoxSidebar, "act_on_element", { tabId, target: "css:#box", action: "check" });
    expect(checked.thrown, JSON.stringify(checked)).toBeUndefined();
    expect(checked.code, JSON.stringify(checked)).toBeUndefined();
    expect(checked.checked, JSON.stringify(checked)).toBe(true);
    expect(checked.changed, JSON.stringify(checked)).toBe(true);
    expect(await page.evaluate(() => ({
      checks: window.checks,
      checked: document.querySelector("#box").checked,
    }))).toEqual({ checks: 1, checked: true });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function targetFor(snapshot, label) {
  const line = String(snapshot || "").split("\n").find(item => item.includes(`"${label}"`) && item.includes("target=uid:"));
  const match = /target=(uid:\S+)/.exec(line || "");
  return match ? match[1] : "";
}

function callTool(session, name, args) {
  return session.extension("background", `
    const request = ${JSON.stringify({ name, args })};
    const tools = view.__qzFirefoxPageTools;
    if (!tools || typeof tools.execute !== "function") throw new Error("Firefox page tool harness is missing");
    const context = Cu.cloneInto({
      sessionId: "firefox-page-input",
      runId: "run",
      workingTabId: request.args.tabId || 0,
      source: "agent",
    }, content);
    const toolArgs = Cu.cloneInto(request.args, content);
    try {
      const result = await tools.execute(request.name, toolArgs, undefined, context);
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      const code = error && error.code ? String(error.code) : "";
      const message = error && error.message ? String(error.message) : String(error);
      return { thrown: code ? code + ": " + message : message };
    }
  `);
}
