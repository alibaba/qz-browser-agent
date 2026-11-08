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
  const dependencies = Object.fromEntries(["findDaemon", "ensureDaemon", "stopDaemon", "restartDaemon", "openBrowser", "openConnectionBrowser", "callTool", "readHealth", "readStdin"].map(name => [name, unexpected]));
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
    assert.throws(() => parseCommand(argv), error => error.code === "INVALID_ARGUMENTS", argv.join(" "));
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
  health: { features: { browserPairing: 1, scriptApiVersion: 2 }, instanceId: "existing-service", buildId: "previous-build", status: {
    connected: true, clients: [{ clientId: "browser-1" }],
  } },
};

test("a running current-protocol daemon survives source edits and reports an available update", async () => {
  const calls = []; let ensures = 0;
  const dependencies = {
    findDaemon: async () => running,
    ensureDaemon: async () => { ensures++; return running; },
    restartDaemon: () => assert.fail("a compatible build difference cannot restart the service"),
    callTool: async (...args) => { calls.push(args); return { sessions: [] }; },
  };
  const status = (await runCli(["status"], dependencies)).result;
  assert.equal(status.connected, true);
  assert.equal(status.updateAvailable, true);
  assert.equal(Object.hasOwn(status, "updateRequired"), false);
  await runCli(["tasks"], dependencies);
  const taskRead = calls.find(call => call[1] === "qingzhou_list_sessions");
  assert.equal(taskRead[0], running.endpoint);
  assert.equal(taskRead[2].clientId, "browser-1");
  assert.equal(ensures, 0, "status and task commands reuse the found daemon");
  assert.deepEqual(await runCli(["mcp"], dependencies), { text: `${running.endpoint}/mcp\n` });
  assert.equal(ensures, 1, "MCP URL preparation may ensure the same daemon without restarting it");
});

test("session creation probes and reuses the responsive current-protocol daemon without opening another browser", async () => {
  const seen = [];
  const result = await runCli(["session", "create", "--title", "Reuse existing browser", "--json"], {
    findDaemon: async () => running,
    ensureDaemon: () => assert.fail("the healthy service already exists"),
    restartDaemon: () => assert.fail("a build difference does not require a restart"),
    callTool: async (endpoint, name, args) => {
      seen.push({ name, args });
      assert.equal(endpoint, running.endpoint);
      assert.equal(args.clientId, "browser-1");
      if (name === "qingzhou_call") { assert.equal(args.method, "ping"); return { pong: true }; }
      assert.equal(name, "qingzhou_create_drive_session");
      return { sessionId: "session", title: args.title, status: "ready" };
    },
    openConnectionBrowser: () => assert.fail("the existing browser connection must remain in use"),
  });
  assert.equal(result.result.sessionId, "session");
  assert.deepEqual(seen.map(call => call.name), ["qingzhou_call", "qingzhou_create_drive_session"]);
});

test("a missing daemon is started once before a session mutation", async () => {
  let starts = 0, mutations = 0;
  const result = await runCli(["session", "create", "--title", "Automatic startup", "--json"], {
    findDaemon: async () => null,
    ensureDaemon: async () => { starts++; return running; },
    restartDaemon: () => assert.fail("startup is not an upgrade"),
    openConnectionBrowser: () => assert.fail("the started service already has a responsive browser"),
    callTool: async (_endpoint, name) => {
      if (name === "qingzhou_call") return { pong: true };
      assert.equal(name, "qingzhou_create_drive_session"); mutations++;
      return { sessionId: "automatic", title: "Automatic startup", status: "ready" };
    },
  });
  assert.equal(starts, 1); assert.equal(mutations, 1);
  assert.equal(result.result.sessionId, "automatic");
});

test("an incompatible service gets one preflight restart and the script is dispatched only on the replacement", async () => {
  const legacy = { ...running, health: { ...running.health, features: { browserPairing: 1, scriptApiVersion: 1 } } };
  const replacement = { ...running, endpoint: "http://127.0.0.1:23457", instanceId: "replacement-service",
    health: { ...running.health, instanceId: "replacement-service" } };
  let restarts = 0;
  const calls = [];
  const output = await runCli(["script", "--session", "existing"], {
    findDaemon: async () => legacy,
    restartDaemon: async ({ expected }) => { assert.equal(expected, legacy); restarts++; return replacement; },
    ensureDaemon: () => assert.fail("the existing service is replaced through its identity-checked restart"),
    openConnectionBrowser: () => assert.fail("the replacement already has a responsive browser"),
    readStdin: async () => "return 7;",
    callTool: async (endpoint, name, args) => {
      calls.push({ endpoint, name, args });
      assert.equal(endpoint, replacement.endpoint, "the incompatible service receives no script or preflight browser request");
      if (name === "qingzhou_call") return { pong: true };
      if (name === "qingzhou_get_drive_session") return { sessionId: "existing", title: "Existing task", status: "ready" };
      assert.equal(name, "qingzhou_execute_tool");
      return { scriptApiVersion: 2, isError: false, result: { ok: true, result: 7, trace: ["Script started."] } };
    },
  });
  assert.equal(restarts, 1);
  assert.equal(calls.filter(call => call.name === "qingzhou_execute_tool").length, 1);
  assert.deepEqual(JSON.parse(output.text), { ok: true, result: 7, trace: ["Script started."] });
});

test("persistent incompatibility stops after one restart before dispatching a script", async () => {
  const unsupported = { ...running, health: { ...running.health, features: { browserPairing: 1 } } };
  let restarts = 0, dispatches = 0;
  await assert.rejects(runCli(["script", "--session", "existing"], {
    findDaemon: async () => unsupported,
    restartDaemon: async () => { restarts++; return unsupported; },
    readStdin: async () => "return 7;",
    callTool: async () => { dispatches++; assert.fail("an unsupported service cannot receive a script"); },
    openConnectionBrowser: () => assert.fail("repeated upgrades cannot open another browser"),
  }), error => error.code === "UPGRADE_REQUIRED");
  assert.equal(restarts, 1); assert.equal(dispatches, 0);
});

test("invalid input is rejected before automatic service or browser preparation", async () => {
  const unexpected = () => assert.fail("invalid input must have no service or browser effects");
  const dependencies = Object.fromEntries(["findDaemon", "ensureDaemon", "restartDaemon", "openConnectionBrowser", "callTool"].map(name => [name, unexpected]));
  for (const argv of [["session", "create"], ["script", "--session", "task", "--args", "{"], ["settings", "set", "{"]]) {
    await assert.rejects(runCli(argv, dependencies), error => error.code === "INVALID_ARGUMENTS");
  }
  await assert.rejects(runCli(["script", "--session", "task"], { ...dependencies, readStdin: async () => " \n " }), error => error.code === "INVALID_ARGUMENTS");
});
