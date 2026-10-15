import assert from "node:assert/strict";
import { getAgentPrompts } from "../../src/background/agent/prompts.js";
const previousChrome = globalThis.chrome;
const previousIndexedDB = globalThis.indexedDB;
const previousIDBKeyRange = globalThis.IDBKeyRange;
const storageData = {};

globalThis.IDBKeyRange = {
  only(value) {
    return { type: "only", value };
  },
};
globalThis.indexedDB = createFakeIndexedDB();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
  runtime: {
    getURL(path) {
      return `chrome-extension://qingzhou/${path}`;
    },
    lastError: null,
  },
};

async function runDataGridAgentInteractionTests() {
try {
  const toolsModule = await importTools();
  const uiDataStore = await import(`../../src/shared/data-store.js?ui=${Date.now()}`);
  const toolEvents = [];
  const toolRuntime = toolsModule.createToolRuntime({
    emit: event => toolEvents.push(event),
  });
  const tools = Object.freeze({ ...toolsModule, executeTool: toolRuntime.execute });

  assertAgentDataStoreContract(tools);

  const createTableResult = await tools.executeTool("data_store", {
    action: "create_table",
    table: "agent_empty_schema",
    columns: ["id", "distance", "amount"],
  }, null, { source: "agent", sessionId: "s-agent", runId: "r-agent" });
  assert.equal(createTableResult.table, "agent_empty_schema", "agent create_table should return the table name");
  assert.deepEqual(createTableResult.columns, ["id", "distance", "amount"], "agent create_table should persist the requested columns");
  assert.equal(createTableResult.totalRows, 0, "agent create_table should not create placeholder rows");
  assert.deepEqual(
    await uiDataStore.getDataTableColumns("agent_empty_schema"),
    ["id", "distance", "amount"],
    "agent create_table should be visible through data-store schema reads",
  );
  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "upsert",
      table: "agent_empty_schema",
      columns: ["id", "distance"],
      rows: [],
    }, null, { source: "agent" }),
    "MISSING_REQUIRED_ARGUMENTS",
    "agent upsert should not accept empty rows; create_table is the schema-only action",
  );

  const insertResult = await tools.executeTool("data_store", {
    action: "insert",
    table: "agent_grid",
    columns: ["key", "name", "city", "score", "status"],
    rows: [
      { key: "a", name: "Alpha", city: "Hangzhou", score: 9, status: "new" },
      { key: "b", name: "Beta", city: "Suzhou", score: 8, status: "new" },
    ],
  }, null, { source: "agent", sessionId: "s-agent", runId: "r-agent" });
  assert.equal(insertResult.inserted, 2, "agent insert should persist rows");
  assert.equal(insertResult.rowIdCount, 2, "agent insert should return rowId count for written rows");
  assert.equal(insertResult.rowsSample[0].revision, 1, "agent insert result should expose row revision");
  assert.ok(insertResult.rowsSample[0].rowId, "agent insert sample should expose rowId");
  assert.equal(insertResult.rowsSample[0].id, undefined, "agent insert sample should not expose internal id");
  assert.equal(insertResult.rowsSample[0].table, undefined, "agent insert sample should not repeat table inside rows");

  const listed = await tools.executeTool("data_store", {
    action: "list",
    table: "agent_grid",
    limit: 10,
  }, null, { source: "agent" });
  const alpha = listed.rows.find(row => row.data.key === "a");
  assert.ok(alpha?.rowId, "agent list should return the internal rowId");
  assert.equal(alpha.id, undefined, "agent row wrapper should not expose internal id");
  assert.equal(alpha.revision, 1, "agent list should expose current revision");

  const got = await tools.executeTool("data_store", {
    action: "get",
    rowId: alpha.rowId,
  }, null, { source: "agent" });
  assert.equal(got.table, "agent_grid", "agent get should expose table on the envelope");
  assert.equal(got.row.revision, 1, "agent get should expose current revision");
  assert.equal(got.row.id, undefined, "agent get should keep the internal id hidden");
  assert.equal(got.row.table, undefined, "agent get should not repeat table inside the row");
  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "get",
      rowId: "row:00000000-0000-4000-8000-000000000000",
    }, null, { source: "agent" }),
    "DATA_ROW_NOT_FOUND",
    "agent get should fail transparently when an opaque rowId is stale or mistyped",
  );

  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "update",
      rowId: alpha.rowId,
      field: "score",
    }, null, { source: "agent" }),
    "MISSING_REQUIRED_ARGUMENTS",
    "agent update without a value should fail before writing",
  );
  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "update",
      rowId: alpha.rowId,
      field: "score",
      value: 9.2,
    }, null, { source: "agent" }),
    "DATA_ROW_CONFLICT",
    "agent update without expectedValue should only succeed for missing fields",
  );
  assert.equal((await uiDataStore.getDataRow(alpha.rowId)).data.score, 9, "failed agent updates must not mutate row data");

  const agentFieldUpdate = await tools.executeTool("data_store", {
    action: "update",
    rowId: alpha.rowId,
    field: "score",
    value: 9.2,
    expectedValue: alpha.data.score,
  }, null, { source: "agent", sessionId: "s-agent", runId: "r-agent" });
  assert.equal(agentFieldUpdate.row.revision, 2, "agent expectedValue update should advance revision");
  assert.equal(agentFieldUpdate.row.data.score, 9.2, "agent expectedValue update should apply data");

  const nullFieldUpdate = await tools.executeTool("data_store", {
    action: "update",
    rowId: alpha.rowId,
    field: "nullable",
    value: null,
  }, null, { source: "agent" });
  assert.equal(nullFieldUpdate.row.data.nullable, null, "agent update should accept an explicit null value");

  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "update",
      rowId: alpha.rowId,
      field: "score",
      value: 9.4,
      expectedValue: alpha.data.score,
    }, null, { source: "agent" }),
    "DATA_ROW_CONFLICT",
    "stale agent expectedValue should reject the write",
  );
  assert.equal((await uiDataStore.getDataRow(alpha.rowId)).data.score, 9.2, "stale expectedValue conflict must not overwrite data");

  const fieldBase = await uiDataStore.getDataRow(alpha.rowId);
  const [agentField, userField] = await Promise.allSettled([
    tools.executeTool("data_store", {
      action: "update",
      rowId: alpha.rowId,
      field: "city",
      value: "Shanghai",
      expectedValue: fieldBase.data.city,
    }, null, { source: "agent" }),
    uiDataStore.updateDataRow(alpha.rowId, { name: "Manual Alpha" }, {
      expectedData: { name: fieldBase.data.name },
    }),
  ]);
  assert.equal(agentField.status, "fulfilled", `agent disjoint-field update should succeed: ${agentField.reason?.message || ""}`);
  assert.equal(userField.status, "fulfilled", `manual disjoint-field update should succeed: ${userField.reason?.message || ""}`);
  let afterDisjoint = await uiDataStore.getDataRow(alpha.rowId);
  assert.equal(afterDisjoint.data.city, "Shanghai", "agent disjoint-field edit should persist");
  assert.equal(afterDisjoint.data.name, "Manual Alpha", "manual disjoint-field edit should persist");

  const sameFieldBase = await uiDataStore.getDataRow(alpha.rowId);
  const sameFieldResults = await Promise.allSettled([
    tools.executeTool("data_store", {
      action: "update",
      rowId: alpha.rowId,
      field: "status",
      value: "agent-status",
      expectedValue: sameFieldBase.data.status,
    }, null, { source: "agent" }),
    uiDataStore.updateDataRow(alpha.rowId, { status: "manual-status" }, {
      expectedData: { status: sameFieldBase.data.status },
    }),
  ]);
  assert.equal(sameFieldResults.filter(result => result.status === "fulfilled").length, 1, "same-field concurrent edits should allow exactly one writer");
  assert.equal(sameFieldResults.filter(result => result.status === "rejected").length, 1, "same-field concurrent edits should reject the stale writer");
  assert.equal(
    sameFieldResults.find(result => result.status === "rejected")?.reason?.code,
    "DATA_ROW_CONFLICT",
    "same-field losing writer should fail with a row conflict",
  );

  const revisionBase = await uiDataStore.getDataRow(alpha.rowId);
  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "replace",
      rowId: alpha.rowId,
      data: revisionBase.data,
    }, null, { source: "agent" }),
    "MISSING_REQUIRED_ARGUMENTS",
    "agent replace without revision should fail before writing",
  );
  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "replace",
      rowId: alpha.rowId,
      revision: 0,
      data: revisionBase.data,
    }, null, { source: "agent" }),
    "DATA_ROW_CONFLICT",
    "agent replace should treat revision 0 as a real CAS value, not a missing argument",
  );
  const revisionResults = await Promise.allSettled([
    tools.executeTool("data_store", {
      action: "replace",
      rowId: alpha.rowId,
      revision: revisionBase.revision,
      data: { ...revisionBase.data, city: "Ningbo" },
    }, null, { source: "agent" }),
    uiDataStore.updateDataRow(alpha.rowId, { name: "Revision Manual" }, {
      expectedData: { name: revisionBase.data.name },
    }),
  ]);
  assert.equal(revisionResults.filter(result => result.status === "fulfilled").length, 1, "row-revision replace should allow exactly one writer");
  assert.equal(revisionResults.filter(result => result.status === "rejected").length, 1, "row-revision replace should reject the stale writer");

  const blankInsert = await tools.executeTool("data_store", {
    action: "insert",
    table: "agent_grid",
    row: { key: "blank", name: "Blank" },
  }, null, { source: "agent" });
  const blankId = blankInsert.rowIdsSample[0];
  await tools.executeTool("data_store", {
    action: "update",
    rowId: blankId,
    field: "note",
    value: "agent filled missing field",
  }, null, { source: "agent" });
  await assertRejectsWithCode(
    uiDataStore.updateDataRow(blankId, { note: "manual fill" }, {
      expectedData: { note: undefined },
    }),
    "DATA_ROW_CONFLICT",
    "manual edit should treat missing-field expectation as a real state after agent fills it",
  );

  await tools.executeTool("data_store", {
    action: "delete",
    table: "agent_grid",
    rowId: alpha.rowId,
  }, null, { source: "agent" });
  await assertRejectsWithCode(
    tools.executeTool("data_store", {
      action: "delete",
      table: "agent_grid",
      rowId: alpha.rowId,
    }, null, { source: "agent" }),
    "DATA_ROW_NOT_FOUND",
    "agent delete should report an already-deleted opaque rowId instead of returning a false success",
  );
  await assertRejectsWithCode(
    uiDataStore.updateDataRow(alpha.rowId, { name: "after delete" }, {
      expectedData: { name: "whatever" },
    }),
    "DATA_ROW_CONFLICT",
    "manual stale edit after agent delete should fail instead of recreating the row",
  );

  assert.ok(
    toolEvents.some(event => event.type === "data_changed" && event.action === "insert" && event.table === "agent_grid"),
    "agent data writes should emit data_changed events for the UI",
  );
  assert.ok(
    toolEvents.some(event => event.type === "data_changed" && event.action === "update" && event.table === "agent_grid"),
    "agent data updates should emit data_changed events for the UI",
  );
  assert.ok(
    toolEvents.some(event => event.type === "data_changed" && event.action === "delete" && event.table === "agent_grid"),
    "agent data deletes should emit data_changed events for the UI",
  );

  const businessIdUpsert = await tools.executeTool("data_store", {
    action: "upsert",
    table: "agent_grid_business_ids",
    dedupField: "id",
    rows: [
      { id: "biz-1", value: "first" },
      { id: "biz-1", value: "second" },
    ],
  }, null, { source: "agent" });
  assert.equal(businessIdUpsert.inserted, 1, "business id dedupField should insert the first matching row");
  assert.equal(businessIdUpsert.updated, 1, "business id dedupField should update duplicate rows");
  assert.ok(businessIdUpsert.rowsSample[0]?.rowId, "upsert sample should expose rowId");
  assert.equal(businessIdUpsert.rowsSample[0]?.id, undefined, "upsert sample should not expose internal id");
  const businessRows = await tools.executeTool("data_store", {
    action: "list",
    table: "agent_grid_business_ids",
    limit: 10,
  }, null, { source: "agent" });
  assert.equal(businessRows.totalRows, 1, "business id upsert should keep one logical row");
  assert.equal(businessRows.rows[0].data.id, "biz-1", "business id should stay inside row.data");
  assert.equal(businessRows.rows[0].data.value, "second", "business id upsert should update row data");

  assertAgentPromptContract();
} finally {
  globalThis.chrome = previousChrome;
  globalThis.indexedDB = previousIndexedDB;
  globalThis.IDBKeyRange = previousIDBKeyRange;
}

console.log("data grid agent interaction tests passed");
}

async function importTools() {
  const shouldSuppressPdfWarning = (args) => {
    const text = args.map(item => String(item)).join(" ");
    return /Cannot load "@napi-rs\/canvas"|Cannot polyfill `(DOMMatrix|ImageData|Path2D)`/.test(text);
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => {
    if (shouldSuppressPdfWarning(args)) return;
    originalLog(...args);
  };
  console.warn = (...args) => {
    if (shouldSuppressPdfWarning(args)) return;
    originalWarn(...args);
  };
  try {
    return await import("../../src/background/tools/runtime.js");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function assertAgentDataStoreContract(tools) {
  const schema = tools.getToolSchemas().find(item => item?.function?.name === "data_store");
  assert.ok(schema, "data_store should be exposed to the agent");
  assert.ok(schema.function.parameters.properties.rowId, "data_store should expose rowId as the internal row handle");
  assert.match(schema.function.parameters.properties.rowId.description, /不透明/, "rowId should be documented as an opaque handle");
  assert.equal(schema.function.parameters.properties.id, undefined, "data_store should not expose id as an internal row handle");
  assert.ok(schema.function.parameters.properties.dedupField, "data_store should expose dedupField for upsert de-duplication");
  assert.equal(schema.function.parameters.properties.keyField, undefined, "data_store should not expose the old keyField name");
  assert.ok(schema.function.parameters.properties.expectedValue, "data_store update should expose expectedValue");
  assert.ok(schema.function.parameters.properties.revision, "data_store replace should expose revision");
  assert.equal(schema.function.parameters.properties.expectedData, undefined, "data_store should not expose expectedData to the agent");
  assert.equal(schema.function.parameters.properties.expectedRevision, undefined, "data_store should not expose expectedRevision to the agent");
  assert.equal(schema.function.parameters.properties.merge, undefined, "data_store should not expose the old merge switch");
  assert.match(schema.function.description, /list\/get 返回的是行对象[\s\S]*revision/, "agent tool description should expose row revisions");
  assert.match(schema.function.description, /业务字段在 data 内/, "agent tool description should expose the row wrapper data field");
  assert.match(schema.function.description, /row\.data\["标题"\]/, "agent tool description should show row.data field access");
  assert.match(schema.function.description, /row\.id 只是普通业务字段/, "agent tool description should keep business id separate from rowId");
  assert.match(schema.function.description, /需要先建空表头时，用 create_table/, "agent tool description should route schema-only creation through create_table");
  assert.match(schema.function.description, /update 修改单个字段[\s\S]*expectedValue/, "agent tool description should document field-level updates");
  assert.match(schema.function.description, /replace 整行替换[\s\S]*revision/, "agent tool description should document revision-guarded replaces");
  assert.match(schema.function.parameters.properties.data.description, /replace 的完整行/, "data argument should be reserved for replace");
}

function assertAgentPromptContract() {
  const promptsSource = getAgentPrompts("zh-CN").SYSTEM_PROMPT;
  assert.match(promptsSource, /list\/get 返回的是行包装对象：\{rowId, order, data, createdAt, updatedAt, revision\}/, "system prompt should describe rowId wrappers");
  assert.match(promptsSource, /编辑已有 Data 行必须先用 list\/get 读取当前行/, "system prompt should route existing-row edits through read-before-write");
  assert.match(promptsSource, /data_store update：传 rowId、field、value、expectedValue/, "system prompt should require expectedValue for field edits");
  assert.match(promptsSource, /data_store replace：传 rowId、revision=row\.revision、data/, "system prompt should route whole-row replacements through replace");
  assert.match(promptsSource, /data_store create_table 传 table \+ columns/, "system prompt should route schema-only table creation through create_table");
  assert.match(promptsSource, /业务字段都在 row\.data 内/, "system prompt should explain the data_store row wrapper");
  assert.match(promptsSource, /不要用 row\["标题"\] 取业务字段/, "system prompt should prevent top-level row field access");
  assert.match(promptsSource, /run_script\(\{target:"inner"[\s\S]*tools\.data_store 读取、计算和分批写回/, "system prompt should route page-independent table crunching through inner run_script");
  assert.match(promptsSource, /与页面无关的纯 JS 计算[^\n]*直接使用 run_script\(\{target:"inner"/, "system prompt should route page-independent computation directly to inner mode");
  assert.match(promptsSource, /最后只返回表名、行数、聚合口径、少量样例和异常统计/, "system prompt should keep table crunching summaries small");
  assert.match(promptsSource, /聚合结果或派生表使用稳定唯一 dedupField/, "system prompt should require stable unique dedup fields for aggregated outputs");
}

async function assertRejectsWithCode(promise, code, message) {
  await assert.rejects(
    promise,
    err => err?.code === code,
    message,
  );
}

function createFakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) {
          db = new FakeDb();
          dbs.set(name, db);
        }
        request.result = db;
        if (fresh && typeof request.onupgradeneeded === "function") request.onupgradeneeded();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  };
}

class FakeDb {
  constructor() {
    this._stores = new Map();
    this._writeQueue = Promise.resolve();
    this.objectStoreNames = {
      contains: (name) => this._stores.has(name),
    };
  }

  createObjectStore(name, options = {}) {
    const store = new FakeStoreData(options.keyPath || "id");
    this._stores.set(name, store);
    return new FakeObjectStore(store, new FakeTransaction(this));
  }

  transaction(names, mode = "readonly") {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
  }
}

class FakeTransaction {
  constructor(db, names = [], mode = "readonly") {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.pending = 0;
    this.completed = false;
    this._oncomplete = null;
    this._release = null;
    if (mode === "readwrite") {
      const ready = db._writeQueue;
      const locked = new Promise(resolve => {
        this._release = resolve;
      });
      db._writeQueue = ready.then(() => locked);
      this._ready = ready;
    } else {
      this._ready = Promise.resolve();
    }
  }

  objectStore(name) {
    const store = this.db._stores.get(name);
    if (!store) throw new Error(`missing store ${name}`);
    return new FakeObjectStore(store, this);
  }

  set oncomplete(handler) {
    this._oncomplete = handler;
    if (this.completed && typeof handler === "function") queueMicrotask(() => handler());
  }

  get oncomplete() {
    return this._oncomplete;
  }

  _begin() {
    this.pending += 1;
  }

  _end() {
    this.pending = Math.max(0, this.pending - 1);
    queueMicrotask(() => {
      if (this.pending === 0 && !this.completed) {
        this.completed = true;
        this._release?.();
        this._oncomplete?.();
      }
    });
  }
}

class FakeStoreData {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.rows = new Map();
    this.indexes = new Map();
  }
}

class FakeObjectStore {
  constructor(data, tx) {
    this.data = data;
    this.tx = tx;
  }

  createIndex(name, path) {
    this.data.indexes.set(name, path);
  }

  get(key) {
    return fakeRequest(this.tx, () => clone(this.data.rows.get(key)));
  }

  getAll() {
    return fakeRequest(this.tx, () => [...this.data.rows.values()].map(clone));
  }

  add(value) {
    return fakeRequest(this.tx, () => {
      const key = value?.[this.data.keyPath];
      if (this.data.rows.has(key)) throw new Error(`duplicate key ${key}`);
      this.data.rows.set(key, clone(value));
      return key;
    });
  }

  put(value) {
    return fakeRequest(this.tx, () => {
      const key = value?.[this.data.keyPath];
      this.data.rows.set(key, clone(value));
      return key;
    });
  }

  delete(key) {
    return fakeRequest(this.tx, () => {
      this.data.rows.delete(key);
      return undefined;
    });
  }

  index(name) {
    const path = this.data.indexes.get(name);
    if (!path) throw new Error(`missing index ${name}`);
    return new FakeIndex(this.data, path, this.tx);
  }

  openCursor(range) {
    const rows = [...this.data.rows.values()]
      .filter(row => !range || range.type !== "only" || row?.[this.data.keyPath] === range.value)
      .map(clone);
    return fakeCursorRequest(this.tx, rows, this.data, this.data.keyPath);
  }
}

class FakeIndex {
  constructor(data, path, tx) {
    this.data = data;
    this.path = path;
    this.tx = tx;
  }

  openCursor(range) {
    const rows = [...this.data.rows.values()]
      .filter(row => !range || range.type !== "only" || row?.[this.path] === range.value)
      .map(clone);
    return fakeCursorRequest(this.tx, rows, this.data, this.data.keyPath);
  }
}

function fakeRequest(tx, work) {
  const request = {};
  tx._begin();
  tx._ready.then(() => {
    queueMicrotask(() => {
      try {
        request.result = work();
        request.onsuccess?.();
      } catch (err) {
        request.error = err;
        request.onerror?.();
      } finally {
        tx._end();
      }
    });
  });
  return request;
}

function fakeCursorRequest(tx, rows, storeData, keyPath) {
  const request = {};
  tx._begin();
  let index = 0;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    tx._end();
  };
  const emit = () => {
    const value = rows[index] || null;
    let moved = false;
    request.result = value
      ? {
          value,
          delete: () => storeData.rows.delete(value?.[keyPath]),
          continue: () => {
            moved = true;
            index += 1;
            queueMicrotask(emit);
          },
          advance: (count) => {
            moved = true;
            index += Math.max(1, Number(count) || 1);
            queueMicrotask(emit);
          },
        }
      : null;
    request.onsuccess?.();
    if (!request.result || !moved) finish();
  };
  tx._ready.then(() => queueMicrotask(emit));
  return request;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

await runDataGridAgentInteractionTests();
