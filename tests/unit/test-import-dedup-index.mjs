import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";
import {
  appendSessionExchangeImportCapsule,
  hashSessionExchangeContent,
} from "../../src/shared/session/session-exchange.js";
import {
  groupSessionsByImportIdentity,
  normalizeSessionImportDedupEntry,
  sessionImportDedupEntryFromRecord,
  sessionImportDedupKey,
  sessionImportDedupWritePatch,
} from "../../src/background/session/import-dedup-index.js";

test("import identity groups keep source id ahead of content hash and leave legacy copies unmarked", () => {
  const tagged = { id: "tagged", exchangeSourceSessionId: "origin", exchangeContentHash: "hash-a" };
  const hashed = { id: "hashed", exchangeContentHash: "hash-a" };
  const legacy = { id: "legacy" };
  const blank = { id: "blank", exchangeSourceSessionId: "", exchangeContentHash: "" };
  const grouped = groupSessionsByImportIdentity([tagged, hashed, legacy, blank]);

  assert.deepEqual(grouped.bySourceId.get("origin").map(session => session.id), ["tagged"]);
  assert.deepEqual(grouped.byContentHash.get("hash-a").map(session => session.id), ["tagged", "hashed"]);
  assert.deepEqual(grouped.unmarked.map(session => session.id), ["legacy", "blank"]);
});

test("legacy import entries remember a content hash only for conversations that carry the import capsule", async () => {
  const conversation = serializeConversation([{ role: "user", content: "西湖和灵隐" }]);
  const plain = await sessionImportDedupEntryFromRecord(createSessionRecord(conversation, []));
  assert.deepEqual(plain, { schemaVersion: 1, contentHash: null });
  assert.deepEqual(sessionImportDedupWritePatch("session", undefined, plain), {});

  const importedRecord = createSessionRecord(appendSessionExchangeImportCapsule(conversation), []);
  const imported = await sessionImportDedupEntryFromRecord(importedRecord);
  assert.equal(imported.contentHash, await hashSessionExchangeContent(conversation));
  assert.deepEqual(sessionImportDedupWritePatch("session", undefined, imported), {
    [sessionImportDedupKey("session")]: imported,
  });
  assert.deepEqual(sessionImportDedupWritePatch("session", imported, imported), {});
  assert.equal(normalizeSessionImportDedupEntry({ schemaVersion: 99, contentHash: null }), null);
  assert.deepEqual(
    normalizeSessionImportDedupEntry({ schemaVersion: 1, contentHash: null }),
    { schemaVersion: 1, contentHash: null },
  );
});
