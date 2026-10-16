import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { main, runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { parseCommand } from "../../services/mcp-bridge/src/args.mjs";
import { callTool, localFetch } from "../../services/mcp-bridge/src/client.mjs";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";

const metadata = JSON.parse(readFileSync(new URL("../../services/mcp-bridge/package.json", import.meta.url), "utf8"));

test("version flags return package metadata without service, browser, or stdin activity", async () => {
  const unexpected = () => assert.fail("version must not perform runtime operations");
  const dependencies = Object.fromEntries(["findDaemon", "ensureDaemon", "stopDaemon", "openBrowser", "callTool", "readHealth", "readStdin"].map(name => [name, unexpected]));
  for (const flag of ["--version", "-v"]) {
    assert.deepEqual(await runCli([flag], dependencies), { text: `qz ${metadata.version}\n` });
    assert.deepEqual(await runCli([flag, "--json"], dependencies), { result: { name: metadata.name, version: metadata.version } });
    for (const isTTY of [false, true]) {
      for (const options of [[], ["--plain"], ["--no-color"], ["--json"]]) {
        let output = "";
        assert.equal(await main([flag, ...options], { ...dependencies,
          stdout: { isTTY, write(value) { output += value; } }, stderr: { write: unexpected },
        }), 0);
        if (options.includes("--json")) assert.deepEqual(JSON.parse(output), {
          ok: true, result: { name: metadata.name, version: metadata.version },
        });
        else assert.equal(output, `qz ${metadata.version}\n`);
      }
    }
  }
});

test("version is a standalone flag and cannot turn a task command into a metadata query", () => {
  for (const argv of [["version"], ["help", "version"], ["--version", "connect"], ["create", "hello", "-v"],
    ["--version", "--client", "browser"], ["--version", "--timeout", "1"], ["--version", "--json", "--plain"]]) {
    assert.throws(() => parseCommand(argv), error => error.code === "invalid_arguments", argv.join(" "));
  }
  assert.equal(parseCommand(["--json", "-v"]).command, "version");
  assert.equal(parseCommand(["create", "--", "--version"]).options.prompt, "--version");
});

test("MCP client initialization reports the package version", async t => {
  const bridge = await startBridge({ port: 0, scopeId: "cli-package-version" });
  t.after(() => bridge.close());
  let clientInfo;
  await callTool(bridge.endpoint, "qingzhou_bridge_status", {}, { fetch: async (input, init) => {
    if (typeof init?.body === "string") {
      const request = JSON.parse(init.body);
      if (request.method === "initialize") clientInfo = request.params.clientInfo;
    }
    return localFetch(input, init);
  } });
  assert.deepEqual(clientInfo, { name: "qz-cli", version: metadata.version });
});

const running = {
  endpoint: "http://127.0.0.1:23456", instanceId: "existing-service",
  compatible: true, updateAvailable: true,
  health: { instanceId: "existing-service", buildId: "previous-build", status: {
    connected: true, clients: [{ clientId: "browser-1" }],
  } },
};

test("a compatible older daemon remains usable and status reports an optional update", async () => {
  const calls = [];
  const dependencies = {
    findDaemon: async () => running,
    ensureDaemon: () => assert.fail("read and task commands must not restart the service"),
    callTool: async (...args) => { calls.push(args); return { sessions: [] }; },
  };
  const status = (await runCli(["status"], dependencies)).result;
  assert.equal(status.connected, true);
  assert.equal(status.updateAvailable, true);
  assert.equal(Object.hasOwn(status, "updateRequired"), false);
  await runCli(["tasks"], dependencies);
  assert.equal(calls[0][0], running.endpoint);
  assert.equal(calls[0][1], "qingzhou_list_sessions");
  assert.deepEqual(await runCli(["mcp"], dependencies), { text: `${running.endpoint}/mcp\n` });
});

test("connect probes and reuses a responsive older daemon without reopening Chrome", async () => {
  const result = await runCli(["connect"], {
    ensureDaemon: async () => running,
    callTool: async (endpoint, name, args) => {
      assert.equal(endpoint, running.endpoint);
      assert.equal(name, "qingzhou_call");
      assert.equal(args.method, "ping");
      assert.equal(args.clientId, "browser-1");
      return { pong: true };
    },
    openBrowser: () => assert.fail("the existing browser connection must remain in use"),
  });
  assert.equal(result.result.connected, true);
  assert.equal(result.result.mcpUrl, `${running.endpoint}/mcp`);
});
