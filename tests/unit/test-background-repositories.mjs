import { createSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAutomationRepository } from "../../src/background/automation/repository.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { createSerialQueue } from "../../src/background/internal/serial-queue.js";
import { ROOT_SESSION_ID } from "../../src/shared/session/session-store.js";
import {
  DeletedSessionWriteError,
  LEGACY_SESSION_RUNTIME_KEY,
  SESSION_RUNTIME_MIGRATION_KEY,
  StaleSessionLeaseError,
  createSessionRepository,
  runtimeKey,
} from "../../src/background/session/repository.js";

await serialQueueRecoversAfterFailure();
await sessionMetadataUpdatesAreAtomic();
await runtimeCheckpointsArePerSessionAndCoalesced();
await runtimeDeleteWinsOverPendingWrites();
await staleConversationLeaseCannotWrite();
await staleRecordLeaseCannotOverwriteAuthoritativeWrite();
await sessionQueuesRecoverAfterStorageFailures();
await deletedSessionsRejectLateWritesAndRecoverCleanup();
await concurrentCreateThenDeleteKeepsTombstone();
await legacyRuntimeMigrationIsIdempotent();
await automationWritesAreAtomicAndRecoverable();
assertProductionWritesUseRepositories();

console.log("background repository concurrency tests passed");

async function serialQueueRecoversAfterFailure() {
  const queue = createSerialQueue();
  await assert.rejects(queue.run(async () => { throw new Error("first write failed"); }), /first write failed/);
  assert.equal(await queue.run(async () => 42), 42);
}

async function sessionMetadataUpdatesAreAtomic() {
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  await Promise.all(Array.from({ length: 20 }, (_, index) => (
    repository.createMetadata({ id: `s${index}`, title: `session ${index}` })
  )));
  assert.equal(Object.keys(await repository.listMetadata()).length, 20);

  await repository.patchMetadata("s0", { counter: 0 });
  await Promise.all(Array.from({ length: 50 }, () => (
    repository.patchMetadata("s0", current => ({ counter: (current.counter || 0) + 1 }))
  )));
  assert.equal((await repository.getMetadata("s0")).counter, 50);
}

async function runtimeCheckpointsArePerSessionAndCoalesced() {
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  const writes = [];
  for (let index = 0; index < 100; index += 1) {
    writes.push(repository.writeRuntime("a", { sessionId: "a", status: "running", sequence: index }));
    writes.push(repository.writeRuntime("b", { sessionId: "b", status: "running", sequence: index }));
  }
  await Promise.all(writes);
  assert.equal((await repository.readRuntime("a")).sequence, 99);
  assert.equal((await repository.readRuntime("b")).sequence, 99);
  assert.equal(storage.snapshot()[runtimeKey("a")].sequence, 99);
  assert.equal(storage.snapshot()[runtimeKey("b")].sequence, 99);
  assert.equal(storage.snapshot()[LEGACY_SESSION_RUNTIME_KEY], undefined);
  assert.equal(storage.writes.filter(item => item.type === "set" && item.patch[runtimeKey("a")]).length, 1);
  assert.equal(storage.writes.filter(item => item.type === "set" && item.patch[runtimeKey("b")]).length, 1);
}

async function runtimeDeleteWinsOverPendingWrites() {
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  const pending = repository.writeRuntime("gone", { sessionId: "gone", status: "running", sequence: 1 });
  await repository.deleteRuntime("gone");
  assert.equal(await pending, null);
  await repository.flush();
  assert.equal(storage.snapshot()[runtimeKey("gone")], undefined);
}

async function staleConversationLeaseCannotWrite() {
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  let active = true;
  const lease = { sessionId: "s1", isActive: () => active };
  await repository.writeActiveConversation("s1", { messages: [{ role: "user", content: "before" }] }, lease);
  active = false;
  await assert.rejects(
    async () => repository.writeActiveConversation("s1", { messages: [{ role: "assistant", content: "late" }] }, lease),
    StaleSessionLeaseError,
  );
  assert.equal((await repository.readActiveConversation("s1")).messages.at(-1).content, "before");
  assert.throws(() => repository.clearActiveConversation("s1", lease), StaleSessionLeaseError);
}

async function staleRecordLeaseCannotOverwriteAuthoritativeWrite() {
  for (const stage of ["queued", "reading"]) {
    const base = createMemoryStorage();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let pauseRead = false;
    const storage = {
      ...base,
      async get(keys) {
        if (pauseRead) {
          pauseRead = false;
          entered.resolve();
          await release.promise;
        }
        return base.get(keys);
      },
    };
    const repository = createSessionRepository({ storage });
    let active = true;
    const lease = { sessionId: "s1", isActive: () => active };
    const seed = createSessionRecord(null, [{ type: "assistant", content: "seed" }]);
    const stale = createSessionRecord(null, [{ type: "assistant", content: "stale" }]);
    const authoritative = createSessionRecord(null, [{ type: "assistant", content: "authoritative" }]);
    await repository.writeRecord("s1", seed, lease);
    pauseRead = true;
    const blocker = stage === "queued" ? repository.writeRecord("s1", seed) : null;
    if (blocker) await entered.promise;
    const pending = repository.writeRecord("s1", stale, lease);
    const rejected = assert.rejects(pending, StaleSessionLeaseError);
    await entered.promise;
    active = false;
    const replacement = repository.writeRecord("s1", authoritative);
    release.resolve();
    await Promise.all([blocker, rejected, replacement]);

    assert.deepEqual(await repository.readRecord("s1"), authoritative, stage);
    assert.equal(base.writes.some(write =>
      write.patch?._session_s1?.transcript?.[0]?.content === "stale"), false, stage);
    assert.throws(() => repository.writeRecord("s1", stale, lease), StaleSessionLeaseError);
  }
}

async function sessionQueuesRecoverAfterStorageFailures() {
  const base = createMemoryStorage();
  let failMetadata = true;
  let failRuntime = true;
  const storage = {
    get: (...args) => base.get(...args),
    remove: (...args) => base.remove(...args),
    async set(patch) {
      if (failMetadata && patch._sessions) {
        failMetadata = false;
        throw new Error("metadata write failed");
      }
      if (failRuntime && patch[runtimeKey("recover")]) {
        failRuntime = false;
        throw new Error("runtime write failed");
      }
      return base.set(patch);
    },
  };
  const repository = createSessionRepository({ storage });
  await assert.rejects(repository.createMetadata({ id: "failed" }), /metadata write failed/);
  await repository.createMetadata({ id: "recover", title: "recovered" });
  assert.equal((await repository.getMetadata("recover")).title, "recovered");

  await assert.rejects(
    repository.writeRuntime("recover", { status: "running", sequence: 1 }, { terminal: true }),
    /runtime write failed/,
  );
  await repository.writeRuntime("recover", { status: "completed", sequence: 2 }, { terminal: true });
  assert.equal((await repository.readRuntime("recover")).sequence, 2);
}

async function deletedSessionsRejectLateWritesAndRecoverCleanup() {
  const base = createMemoryStorage();
  let failRecordRemoval = true;
  const storage = {
    get: (...args) => base.get(...args),
    set: (...args) => base.set(...args),
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (failRecordRemoval && list.includes("_session_parent")) {
        failRecordRemoval = false;
        throw new Error("record cleanup failed");
      }
      return base.remove(keys);
    },
  };
  const repository = createSessionRepository({ storage });
  await repository.createMetadata({ id: "parent", title: "parent" });
  await repository.createMetadata({ id: "child", title: "child", parentSessionId: "parent" });
  await repository.writeRecord("parent", createSessionRecord(serializeConversation([{ role: "user", content: "seed" }]), []));
  const lease = { sessionId: "parent", isActive: () => true };
  await repository.writeActiveConversation("parent", { messages: [] }, lease);
  await repository.writeRuntime("parent", { status: "running" }, { terminal: true });

  await repository.deleteSession("parent");
  assert.equal(await repository.getMetadata("parent"), null, "metadata deletion is the logical delete boundary");
  assert.equal((await repository.getMetadata("child")).parentSessionId, ROOT_SESSION_ID);
  assert.throws(() => repository.writeRecord("parent", { late: true }), DeletedSessionWriteError);
  assert.throws(
    () => repository.writeRuntime("parent", { status: "completed" }, { terminal: true }),
    DeletedSessionWriteError,
  );
  assert.throws(
    () => repository.writeActiveConversation("parent", { late: true }, lease),
    DeletedSessionWriteError,
  );

  const retry = await repository.deleteSession("parent");
  assert.equal(retry.existed, false);
  assert.equal(base.snapshot()._session_parent, undefined);
  assert.equal(base.snapshot()._active_conversation_parent, undefined);
  assert.equal(base.snapshot()[runtimeKey("parent")], undefined);

  await repository.createMetadata({ id: "parent", title: "explicit recreation" });
  await repository.writeRecord("parent", { ...createSessionRecord(null, []), restored: true });
  assert.equal(base.snapshot()._session_parent.restored, true);
}

async function concurrentCreateThenDeleteKeepsTombstone() {
  const repository = createSessionRepository({ storage: createMemoryStorage() });
  const creating = repository.createMetadata({ id: "race", title: "queued create" });
  const deleting = repository.deleteSession("race");
  await Promise.all([creating, deleting]);

  assert.equal(await repository.getMetadata("race"), null);
  assert.throws(() => repository.writeRecord("race", { late: true }), DeletedSessionWriteError);

  await repository.createMetadata({ id: "race", title: "explicit recreation" });
  const restored = { ...createSessionRecord(null, []), restored: true };
  await repository.writeRecord("race", restored);
  assert.deepEqual(await repository.readRecord("race"), restored);
}

async function legacyRuntimeMigrationIsIdempotent() {
  const storage = createMemoryStorage({
    [LEGACY_SESSION_RUNTIME_KEY]: {
      a: { sessionId: "a", status: "running", runId: "ra" },
      b: { sessionId: "b", status: "completed", runId: "rb" },
    },
  });
  const repository = createSessionRepository({ storage });
  assert.equal((await repository.readRuntime("a")).runId, "ra");
  assert.deepEqual(await repository.migrateLegacyRuntime(), { migrated: 2, skipped: 0, schemaVersion: 4 });
  assert.deepEqual(await repository.migrateLegacyRuntime(), { migrated: 0, skipped: 2, schemaVersion: 4 });
  assert.equal(storage.snapshot()[SESSION_RUNTIME_MIGRATION_KEY], 4);
  assert.equal(storage.snapshot()[runtimeKey("a")].runId, "ra");
}

async function automationWritesAreAtomicAndRecoverable() {
  const base = createMemoryStorage();
  let failNext = true;
  const storage = {
    get: (...args) => base.get(...args),
    remove: (...args) => base.remove(...args),
    async set(patch) {
      if (failNext) {
        failNext = false;
        throw new Error("injected storage failure");
      }
      return base.set(patch);
    },
  };
  const repository = createAutomationRepository({ storage });
  await assert.rejects(repository.saveDefinition({ id: "failed", title: "failed" }), /injected storage failure/);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (
    repository.saveDefinition({ id: `a${index}`, title: `automation ${index}` })
  )));
  assert.equal((await repository.listDefinitions()).length, 20);
  await Promise.all(Array.from({ length: 30 }, (_, index) => (
    repository.patchDefinition("a0", { title: `revision ${index}` })
  )));
  assert.equal((await repository.getDefinitions()).a0.title, "revision 29");
}

function assertProductionWritesUseRepositories() {
  const agent = readFileSync("src/background/agent/agent.ts", "utf8");
  const tools = readFileSync("src/background/tools/runtime.ts", "utf8");
  const worker = readFileSync("src/background/service-worker.ts", "utf8");
  assert.doesNotMatch(agent, /chrome\.storage\.local\.(?:set|remove)\([^\n]*active_conversation/);
  const sharedSessionImport = tools.match(/import\s*{([^}]*)}\s*from\s*["'][^"']*shared\/session\/session-store\.js["']/)?.[1] || "";
  assert.doesNotMatch(sharedSessionImport, /\b(?:createStoredSession|deleteStoredSession|getSessions)\b/);
  assert.doesNotMatch(worker, /\[SESSIONS_KEY\]|_session_runtime["']/);
}
