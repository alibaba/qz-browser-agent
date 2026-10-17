import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { waitForTask } from "../../services/mcp-bridge/src/task-stream.mjs";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { parseCommand } from "../../services/mcp-bridge/src/args.mjs";

const user = (id, runId) => ({ type: "user", clientMessageId: id, runId, content: id });
const assistant = (runId, content) => ({ type: "assistant", runId, content, streaming: false });
const snapshot = (runId, status, transcript) => ({ sessionId: "task", runId, status, runtime: { status }, transcript });
const passed = snapshot("next-run", "completed", [
  user("requested-message", "target-run"), assistant("target-run", "Requested answer"),
  user("later-message", "next-run"), assistant("next-run", "Later answer"),
]);

test("a run completed and replaced before the first poll fails promptly with both run IDs", async () => {
  for (const tracking of [{ expectedMessageId: "requested-message" }, { expectedRunId: "target-run" }]) {
    let calls = 0;
    await assert.rejects(waitForTask({ sessionId: "task", ...tracking,
      getSnapshot: () => { assert.equal(++calls, 1); return passed; },
      onUpdate: () => assert.fail("the later run must not be streamed as the requested result"),
    }), error => error.code === "task_changed"
      && error.details.expectedRunId === "target-run" && error.details.actualRunId === "next-run");
    assert.equal(calls, 1);
  }
});

test("a stale preceding runtime waits until it catches up with the submitted message", async () => {
  const transcript = [user("old-message", "old-run"), assistant("old-run", "Old answer"),
    user("requested-message", "target-run"), assistant("target-run", "Requested answer")];
  const snapshots = [snapshot("old-run", "completed", transcript), snapshot("target-run", "completed", transcript)];
  const updates = [];
  const done = await waitForTask({ sessionId: "task", expectedMessageId: "requested-message", pollIntervalMs: 0,
    getSnapshot: () => { assert.ok(snapshots.length); return snapshots.shift(); }, onUpdate: update => updates.push(update),
  });
  assert.equal(done.runId, "target-run");
  assert.deepEqual(updates.filter(update => update.type === "text").map(update => update.text), ["Requested answer"]);
});

test("CLI replacement recovery inspects the conversation without resending or watching the later run", async () => {
  let calls = 0;
  await assert.rejects(runCli(["send", "task", "Requested message", "--wait"], {
    findDaemon: async () => ({ endpoint: "http://127.0.0.1:23456", health: { features: { browserPairing: 1 },
      status: { connected: true, clients: [{ clientId: "browser" }] },
    } }),
    callTool: async (_endpoint, name) => {
      calls++;
      if (name === "qingzhou_send_message") return { accepted: true, clientMessageId: "requested-message" };
      assert.equal(name, "qingzhou_get_session_snapshot");
      return passed;
    },
  }), error => {
    assert.equal(error.code, "task_changed");
    assert.equal(error.details.command, "qz show task --client browser");
    assert.equal(error.details.expectedRunId, "target-run");
    assert.equal(error.details.actualRunId, "next-run");
    return true;
  });
  assert.equal(calls, 2);
});

test("CLI recovery commands preserve shell-sensitive IDs and option-like values", { skip: process.platform === "win32" }, async () => {
  for (const sessionId of ["task '$(printf unwanted);", "-task '$(printf unwanted);"]) {
    const clientId = "-browser '$(printf unwanted);";
    for (const tracked of [false, true]) {
      await assert.rejects(runCli(["send", `--client=${clientId}`, "--wait", "--", sessionId, "Requested message"], {
        findDaemon: async () => ({ endpoint: "http://127.0.0.1:23456", health: { features: { browserPairing: 1 },
          status: { connected: true, clients: [{ clientId }] },
        } }),
        callTool: async (_endpoint, name) => name === "qingzhou_send_message"
          ? { accepted: true, ...(tracked ? { clientMessageId: "requested-message" } : {}) }
          : passed,
      }), error => {
        assert.equal(error.code, tracked ? "task_changed" : "invalid_response");
        const shell = spawnSync("/bin/sh", ["-c", `qz() { printf '%s\\n' "$@"; }\n${error.details.command}`], { encoding: "utf8" });
        assert.equal(shell.status, 0, shell.stderr);
        const parsed = parseCommand(shell.stdout.trimEnd().split("\n"));
        assert.equal(parsed.command, tracked ? "tasks" : "watch");
        assert.equal(parsed.id, sessionId);
        assert.equal(parsed.options["client-id"], clientId);
        assert.equal(parsed.options.stream, tracked ? undefined : true);
        return true;
      });
    }
  }
});
