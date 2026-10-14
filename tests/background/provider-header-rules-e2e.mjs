import { acceptDataDisclosure } from "../support/data-consent.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ensureTestExtension } from "../support/extension-build.mjs";

const extension = await ensureTestExtension();
const profile = await mkdtemp(join(tmpdir(), "qz-provider-headers-"));
const server = createServer({
  key: await readFile(new URL("../fixtures/tls/localhost-key.pem", import.meta.url)),
  cert: await readFile(new URL("../fixtures/tls/localhost-cert.pem", import.meta.url)),
}, (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Provider header fixture</title>");
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ userAgent: request.headers["user-agent"] }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: chromium.executablePath(), ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`,
      "--no-proxy-server", "--ignore-certificate-errors",
    ],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const panel = await context.newPage();
  await panel.goto(new URL("/sidepanel/sidepanel.html", worker.url()).href);
  await acceptDataDisclosure(panel);
  await panel.waitForFunction(() => {
    const app = document.querySelector("#app");
    return app && !app.hasAttribute("data-workspace-booting");
  });
  const id = new URL(worker.url()).host;
  const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.deepEqual(rule.condition.initiatorDomains, [id]);
  const grants = await worker.evaluate(() => chrome.permissions.getAll());
  for (const permission of ["history", "bookmarks", "desktopCapture", "downloads.open"]) {
    assert.equal(grants.permissions.includes(permission), false, `${permission} starts ungranted`);
  }
  const url = "https://chatgpt.com/backend-api/header-probe";
  const request = url => fetch(url).then(response => response.json());
  assert.equal((await worker.evaluate(request, url)).userAgent, "qz-agent/1.0.0");
  assert.equal((await panel.evaluate(request, url)).userAgent, "qz-agent/1.0.0");
  const web = await context.newPage();
  await web.goto("https://chatgpt.com/");
  assert.match((await web.evaluate(request, url)).userAgent, /Chrome\//);

  // Restart the worker while Chrome retains its existing session rules.
  const cdp = await context.newCDPSession(panel);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find(item => item.type === "service_worker" && item.url === worker.url());
  assert.ok(target);
  assert.equal((await cdp.send("Target.closeTarget", { targetId: target.targetId })).success, true);
  await cdp.detach();
  await panel.reload();
  await panel.waitForFunction(() => {
    const app = document.querySelector("#app");
    return app && !app.hasAttribute("data-workspace-booting");
  });
  assert.deepEqual(await panel.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), rules);
  assert.equal((await panel.evaluate(request, url)).userAgent, "qz-agent/1.0.0");
  assert.match((await web.evaluate(request, url)).userAgent, /Chrome\//);
  console.log("Provider headers: extension requests scoped, ordinary website unchanged, worker restart stable; optional permissions ungranted.");
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
