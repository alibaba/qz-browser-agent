import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

export async function installNavigationFuzzHarness(source, directory, browser) {
  await cp(source, directory, { recursive: true });
  await cp(new URL("../fixtures/navigation-fuzz-worker.mjs", import.meta.url), join(directory, "navigation-fuzz.mjs"));
  const path = join(directory, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  const original = browser === "firefox" ? manifest.background.scripts[0] : manifest.background.service_worker;
  await writeFile(join(directory, "navigation-fuzz-boot.js"), `import './${original}';\nimport './navigation-fuzz.mjs';\n`);
  if (browser === "firefox") manifest.background.scripts = ["navigation-fuzz-boot.js"];
  else manifest.background.service_worker = "navigation-fuzz-boot.js";
  await writeFile(path, JSON.stringify(manifest));
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return max => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
}

function pageColor(label) {
  let hash = 2166136261;
  for (const character of label) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return [hash & 255, (hash >>> 8) & 255, (hash >>> 16) & 255];
}

export const navigationCombinationScenarios = [
  "combo-redirect-parser", "combo-redirect-cancel", "combo-redirect-block-recover", "combo-reload-retry",
  "combo-supersede-close-reopen", "combo-same-url-replace", "combo-parallel-close", "combo-transfer-redirect",
  "combo-obsolete-new-run", "combo-deadline-close", "combo-redirect-no-content-recover", "combo-stale-uid",
];

export async function runNavigationFuzz(api, { seed, watchNetwork = false, scenarios }, report) {
  const choose = seededRandom(seed), routes = new Map();
  const server = createServer((request, response) => {
    const route = routes.get(request.url);
    if (!route) { response.writeHead(204); response.end(); return; }
    route.count++;
    const label = route.generationLabels ? `${route.label}-request-${route.count}` : route.label;
    const finish = () => {
      if (response.destroyed) return;
      if (route.redirect) { response.writeHead(302, { Location: route.redirect }); response.end(); return; }
      if (route.fail) { request.socket.destroy(); return; }
      if (route.empty) { response.writeHead(204); response.end(); return; }
      if (route.script) { response.writeHead(200, { "content-type": "text/javascript" }); response.end("// parser released"); return; }
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><head><title>${label}</title>${route.head ? `<script src="${route.head}"></script>` : ""}</head><body style="background:rgb(${pageColor(label).join(",")})"><article>${label}</article><button>${label} action</button><img id="sample" alt="${label} image" width="32" height="32" src="${route.image || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}">${route.frame ? `<iframe src="${route.frame}"></iframe>` : ""}</body>`);
    };
    if (route.hold) route.pending.push(finish); else finish();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let routeSerial = 0;
  const page = (label, options = {}) => {
    const path = `/s${seed}-${++routeSerial}`;
    routes.set(path, { label, count: 0, pending: [], ...options }); return origin + path;
  };
  const route = url => routes.get(new URL(url).pathname);
  const release = url => { const value = route(url); value.hold = false; for (const finish of value.pending.splice(0)) finish(); };
  const wait = async (predicate, label, timeout = 12000) => {
    const end = Date.now() + timeout;
    do { const value = await predicate(); if (value) return value; await pause(10); } while (Date.now() < end);
    throw new Error(`seed=${seed} ${label}: fixture deadline exceeded`);
  };
  const start = (name, args, sessionId, runId) => api({ op: "start", name, args, sessionId, runId });
  const settle = async callId => (await wait(async () => {
    const status = await api({ op: "poll", callId }); return status.settled ? status : null;
  }, `call ${callId}`)).result;
  const call = async (name, args, sessionId) => settle(await start(name, args, sessionId));
  const readers = [
    ["read_article", { limit: 1200 }], ["read_dom", {}], ["find_elements", { selector: "button" }],
    ["inspect_element", { target: "css:article" }], ["list_images", {}],
    ["read_image", { target: "css:#sample" }], ["get_ax_tree", {}], ["screenshot", { format: "png", maxWidth: 2048, maxHeight: 2048 }],
  ];
  const read = async (tabId, sessionId, timeout = 5, selection = readers, runId) => {
    const order = [...selection];
    for (let i = order.length - 1; i > 0; i--) { const j = choose(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    return Promise.all(order.map(async ([name, args]) => ({ name, callId: await start(name, { ...args, tabRef: tabId, timeout }, sessionId, runId) })));
  };
  const pending = async calls => {
    await pause(30 + choose(70));
    for (const item of calls) {
      const status = await api({ op: "poll", callId: item.callId });
      assert.equal(status.settled, false, `${item.name} must not read before commit: ${JSON.stringify(status.result)}`);
    }
  };
  const success = async (calls, label) => {
    for (const item of calls) {
      const result = await settle(item.callId);
      assert.ok(!result.error && !result.incomplete, `${item.name}: ${JSON.stringify(result)}`);
      if (item.name === "screenshot") {
        assert.ok(result.imageBytes > 0, item.name);
        const expected = pageColor(label);
        assert.ok(expected.every((channel, index) => Math.abs(channel - result.imagePixel?.[index]) <= 1),
          `screenshot must capture ${label}: pixel=${result.imagePixel} expected=${expected}`);
      } else {
        const content = {
          read_article: result.text, read_dom: result.content, find_elements: result.results,
          inspect_element: result.text, list_images: result.images, get_ax_tree: result.snapshot, read_image: result.alt,
        }[item.name];
        assert.ok(JSON.stringify(content)?.includes(label), `${item.name} must observe ${label} in its content: ${JSON.stringify(result)}`);
        if (item.name === "read_image") assert.ok(result.imageBytes > 0);
      }
      report.reads++;
    }
  };
  const timeout = async calls => {
    for (const item of calls) {
      const result = await settle(item.callId);
      assert.ok(result.incomplete?.reason === "timeout" || result.code === "TOOL_TIMEOUT", `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.imageBytes, undefined); assert.equal(result.text, undefined); assert.equal(result.snapshot, undefined);
      report.reads++;
    }
  };
  const failures = async (calls, code) => {
    for (const item of calls) {
      const result = await settle(item.callId);
      assert.ok(result.error || (!code && result.incomplete), `${item.name}: ${JSON.stringify(result)}`);
      if (code) assert.equal(result.code, code, `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.imageBytes, undefined); assert.equal(result.text, undefined); assert.equal(result.snapshot, undefined);
      report.reads++;
    }
  };
  const open = async (url, sessionId = "fuzz-a", timeout = 1) => {
    const result = await call("open_tab", { url, tabAlias: "page", watchNetwork, timeout }, sessionId);
    assert.ok(!result.error, JSON.stringify(result));
    return result.tabId || result.id;
  };
  try {
    await api({ op: "reset" });
    for (const scenario of scenarios) {
      await api({ op: "reset" });
      const entry = { scenario, seed, watchNetwork, started: Date.now() }; report.cases.push(entry);
      try {
        const label = `NEW-${seed}-${scenario}`;
        if (scenario.startsWith("combo-")) {
          const old = page(`OLD-${seed}-${scenario}`), tabId = await open(old);
          await success(await read("page", undefined, 5, [["read_article", { limit: 1200 }]]), `OLD-${seed}-${scenario}`);
          let staleTarget;
          if (scenario === "combo-stale-uid") {
            const tree = await call("get_ax_tree", { tabId });
            staleTarget = /target=(uid:\S+) button/.exec(tree.snapshot)?.[1];
            assert.ok(staleTarget, tree.snapshot);
          }
          const sameUrl = ["combo-reload-retry", "combo-same-url-replace"].includes(scenario);
          const target = sameUrl ? old : page(label, { hold: true });
          Object.assign(route(target), { hold: true, label, generationLabels: scenario === "combo-same-url-replace" });
          const nav = await call("navigate", { tabId, url: target, timeout: 1 });
          assert.equal(nav.incomplete?.reason, "timeout", JSON.stringify(nav));
          entry.tabBeforeRead = await api({ op: "tab", tabId });
          const calls = await read(choose(2) ? "page" : String(tabId), undefined,
            ["combo-reload-retry", "combo-deadline-close"].includes(scenario) ? 1 : 5,
            scenario === "combo-transfer-redirect" ? readers.filter(([name]) => ["screenshot", "get_ax_tree"].includes(name)) : readers);
          await pending(calls);
          if (scenario === "combo-redirect-parser") {
            const head = page("HEAD", { hold: true, script: true }), final = page(label + "-parsed", { head });
            route(target).redirect = final; release(target);
            await wait(() => route(head).pending.length, "parser-blocking script request");
            await pending(calls); release(head); await success(calls, label + "-parsed");
          } else if (["combo-redirect-cancel", "combo-redirect-block-recover"].includes(scenario)) {
            const middle = page(label + "-middle", { hold: true }), final = page(label + "-final", { hold: true });
            route(target).redirect = middle; release(target);
            await wait(() => route(middle).pending.length, "first redirect"); await pending(calls);
            if (scenario === "combo-redirect-cancel") {
              const cancelled = calls.filter((_, index) => index % 3 === 0);
              for (const item of cancelled) await api({ op: "abort", callId: item.callId });
              route(middle).redirect = final; release(middle);
              await wait(() => route(final).pending.length, "second redirect"); release(final);
              await failures(cancelled, "OPERATION_ABORTED");
              await success(calls.filter((_, index) => index % 3 !== 0), label + "-final");
            } else {
              route(middle).redirect = final.replace("127.0.0.1", "localhost");
              await api({ op: "security", rules: { blockedDomains: ["localhost"] } }); release(middle);
              await wait(() => route(final).pending.length, "blocked redirect"); release(final);
              await failures(calls, "SECURITY_GUARDRAIL_BLOCKED");
              await api({ op: "security", rules: {} }); await success(await read(tabId), label + "-final");
            }
          } else if (scenario === "combo-reload-retry") {
            await timeout(calls); const retried = await read("page"); await pending(retried);
            const cancelled = retried.slice(0, 2);
            for (const item of cancelled) await api({ op: "abort", callId: item.callId });
            const before = await Promise.all(calls.map(item => api({ op: "poll", callId: item.callId })));
            release(target); await failures(cancelled, "OPERATION_ABORTED"); await success(retried.slice(2), label);
            assert.deepEqual(await Promise.all(calls.map(item => api({ op: "poll", callId: item.callId }))), before, "expired reads remain settled after retry succeeds");
          } else if (scenario === "combo-supersede-close-reopen") {
            const replacement = page(label + "-replacement", { hold: true });
            await api({ op: "update", tabId, url: replacement }); await wait(() => route(replacement).pending.length, "replacement navigation");
            await api({ op: "close", tabId }); await failures(calls);
            release(replacement); release(target);
            const reopened = await open(page(label + "-reopened")); assert.notEqual(reopened, tabId);
            await success(await read("page"), label + "-reopened");
            assert.ok((await call("read_article", { tabRef: tabId, limit: 1200 })).error, "old numeric ID cannot follow a reused alias");
          } else if (scenario === "combo-same-url-replace") {
            await api({ op: "update", tabId, url: target });
            await wait(() => route(target).count >= 3, "second same-URL request");
            await pending(calls);
            const queued = route(target).pending.splice(0); route(target).hold = false;
            queued.at(-1)(); await success(calls, label + `-request-${route(target).count}`);
            for (const finish of queued.slice(0, -1)) finish();
            await success(await read(tabId, undefined, 5, [["read_article", { limit: 1200 }]]), label + `-request-${route(target).count}`);
          } else if (scenario === "combo-parallel-close") {
            const other = await open(page(label + "-other"), "fuzz-b");
            await success(await read("page", "fuzz-b"), label + "-other");
            await api({ op: "close", tabId }); await failures(calls); release(target);
            await success(await read(other, "fuzz-b"), label + "-other");
          } else if (scenario === "combo-transfer-redirect") {
            await api({ op: "transfer", tabId, to: "fuzz-b" });
            const final = page(label + "-transferred"); route(target).redirect = final; release(target);
            await failures(calls, "SESSION_TAB_FOREIGN");
            if (watchNetwork) {
              await failures(await read(tabId, "fuzz-b", 5, [["get_ax_tree", {}], ["screenshot", { format: "png" }]]), "CDP_TAB_LEASE_CONFLICT");
              await api({ op: "release-run" });
            }
            await success(await read(tabId, "fuzz-b"), label + "-transferred");
          } else if (scenario === "combo-obsolete-new-run") {
            await api({ op: "obsolete" });
            // Match Supervisor cleanup before starting the new run, including any
            // debugger connection retained by network watching in the previous run.
            await api({ op: "release-run" });
            const current = await read(tabId, undefined, 5, readers, "next-run"); await pending(current); release(target);
            await failures(calls, "OPERATION_ABORTED"); await success(current, label);
          } else if (scenario === "combo-deadline-close") {
            await pause(750 + choose(400)); release(target); await pause(choose(30)); await api({ op: "close", tabId });
            for (const item of calls) {
              const result = await settle(item.callId);
              if (result.error || result.incomplete) await failures([item]); else await success([item], label);
            }
            const snapshot = await Promise.all(calls.map(item => api({ op: "poll", callId: item.callId })));
            await pause(80);
            assert.deepEqual(await Promise.all(calls.map(item => api({ op: "poll", callId: item.callId }))), snapshot);
          } else if (scenario === "combo-redirect-no-content-recover") {
            const empty = page("EMPTY", { empty: true }); route(target).redirect = empty; release(target);
            await wait(() => route(empty).count, "204 redirect");
            for (const item of calls) {
              const result = await settle(item.callId);
              if (result.error || result.incomplete) await failures([item]);
              else await success([item], `OLD-${seed}-${scenario}`);
            }
            assert.ok(!(await call("navigate", { tabId, url: page(label + "-recovered"), timeout: 3 })).error);
            await success(await read("page"), label + "-recovered");
          } else if (scenario === "combo-stale-uid") {
            release(target); await success(calls, label);
            const stale = await call("inspect_element", { tabId, target: staleTarget });
            assert.ok(stale.error && /STALE|NOT_FOUND|UNAVAILABLE/.test(stale.code), JSON.stringify(stale));
            await success(await read(tabId, undefined, 5, [["inspect_element", { target: "css:article" }]]), label);
          }
        } else if (["old-pending", "reload"].includes(scenario)) {
          const old = page(`OLD-${seed}`), tabId = await open(old);
          // Establish an observed old document before replacing it; this also catches
          // browser adapters that report an open timeout before the body is available.
          const baseline = await call("read_article", { tabId, limit: 1200, timeout: 5 });
          assert.ok(baseline.text?.includes(`OLD-${seed}`), `old document: ${JSON.stringify(baseline)}`);
          const target = scenario === "reload" ? old : page(label, { hold: true });
          Object.assign(route(target), { label, hold: true });
          const navigation = await call("navigate", { tabId, url: target, timeout: 1 });
          assert.equal(navigation.incomplete?.reason, "timeout", JSON.stringify(navigation));
          entry.navigation = navigation;
          entry.tabBeforeRead = await api({ op: "tab", tabId });
          const calls = await read("page"); await pending(calls); release(target); await success(calls, label);
        } else if (scenario === "subresources" || scenario === "fragment") {
          const resource = page("RESOURCE", { hold: true });
          const target = page(label, scenario === "subresources" ? { image: resource, frame: resource } : {});
          const tabId = await open(target);
          if (scenario === "subresources") await wait(() => route(resource).pending.length, "held subresource request");
          if (scenario === "fragment") assert.ok(!(await call("navigate", { tabId, url: target + "#part", timeout: 2 })).error);
          const calls = await read(tabId, undefined, 3, readers.filter(([name]) => !["read_image", "list_images"].includes(name)));
          await success(calls, label);
          if (scenario === "subresources") {
            assert.ok(route(resource).pending.length > 0, "readers finish while subresources remain withheld");
            if (report.browser === "chromium") assert.equal((await api({ op: "tab", tabId })).status, "loading");
            release(resource);
          }
        } else if (scenario === "isolated-sessions") {
          const a = page(label + "-A", { hold: true }), b = page(label + "-B", { hold: true });
          const [aId, bId] = await Promise.all([open(a), open(b, "fuzz-b")]); assert.notEqual(aId, bId);
          const aCalls = await read("page"), bCalls = await read("page", "fuzz-b");
          for (const item of aCalls) await api({ op: "abort", callId: item.callId });
          release(b); await success(bCalls, label + "-B"); await failures(aCalls, "OPERATION_ABORTED"); release(a);
          assert.equal((await api({ op: "state", sessionId: "fuzz-b" })).tabAliases.page, bId);
        } else {
          const target = page(label, { hold: true }), tabId = await open(target);
          assert.equal((await api({ op: "tab", tabId })).status, "loading");
          const calls = await read(choose(2) ? "page" : tabId, undefined, scenario === "timeout" ? 1 : 5,
            scenario === "transfer" ? readers.filter(([name]) => ["screenshot", "get_ax_tree"].includes(name)) : readers);
          await pending(calls);
          if (scenario === "close") { await api({ op: "close", tabId }); await failures(calls); }
          else if (scenario === "cancel") {
            for (const item of calls.filter((_, index) => index % 2 === 0)) await api({ op: "abort", callId: item.callId });
            release(target);
            await failures(calls.filter((_, index) => index % 2 === 0), "OPERATION_ABORTED");
            await success(calls.filter((_, index) => index % 2), label);
          } else if (scenario === "timeout") {
            await timeout(calls); assert.ok(await api({ op: "tab", tabId })); release(target);
            await success(await read("page"), label);
          } else if (scenario === "obsolete" || scenario === "delete") {
            await api({ op: scenario, callIds: calls.map(item => item.callId) }); release(target);
            await failures(calls, "OPERATION_ABORTED");
          } else if (scenario === "transfer") {
            await api({ op: "transfer", tabId, to: "fuzz-b" }); release(target); await failures(calls, "SESSION_TAB_FOREIGN");
          } else if (scenario === "replace") {
            const replacement = page(label + "-replacement", { hold: true });
            await api({ op: "update", tabId, url: replacement });
            await wait(() => route(replacement).count, "replacement request");
            release(replacement); await success(calls, label + "-replacement"); release(target);
          } else if (scenario === "redirect" || scenario === "blocked") {
            const destination = page(label + "-redirected", { hold: true });
            route(target).redirect = scenario === "blocked" ? destination.replace("127.0.0.1", "localhost") : destination;
            if (scenario === "blocked") await api({ op: "security", rules: { blockedDomains: ["localhost"] } });
            release(target); await wait(() => route(destination).count, "redirected request"); release(destination);
            if (scenario === "blocked") await failures(calls, "SECURITY_GUARDRAIL_BLOCKED");
            else await success(calls, label + "-redirected");
          } else if (scenario === "no-content" || scenario === "network-failure") {
            route(target)[scenario === "no-content" ? "empty" : "fail"] = true;
            release(target);
            for (const item of calls) {
              const result = await settle(item.callId);
              // A screenshot or AX observation can legitimately describe the browser's
              // error document. It must never masquerade as the requested article.
              if (scenario === "network-failure" && item.name === "get_ax_tree" && result.snapshot) {
                assert.match(result.snapshot, /chrome-error|about:neterror|ERR_|Problem loading page|Unable to connect|server not found|connection was reset/i);
                assert.ok(!result.snapshot.includes(label)); report.reads++;
              } else if (scenario === "network-failure" && item.name === "screenshot" && result.imageBytes) report.reads++;
              else await failures([item]);
            }
          } else { release(target); await success(calls, label); }
        }
        entry.status = "passed"; entry.durationMs = Date.now() - entry.started;
      } catch (error) { entry.status = "failed"; entry.error = String(error.stack || error); throw error; }
    }
  } finally {
    await api({ op: "reset" });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
