import assert from "node:assert/strict";
import { registerBookmarksHistoryTools } from "../../src/capabilities/bookmarks/tools.js";

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const definitions = new Map();
const calls = [];
const blocked = new Set(["https://blocked.test/"]);
registerBookmarksHistoryTools({
  registerTool({ name, description, parameters, execute }) {
    definitions.set(name, { description, parameters, execute });
  },
  ToolExecutionError,
  clampLimit: (value, min, max) => Math.max(min, Math.min(max, Math.floor(Number(value) || min))),
  getBookmarks: () => ({
    search: async query => {
      calls.push(["bookmark.search", query]);
      return [bookmark("1", "Allowed", "https://allowed.test/"), bookmark("2", "Blocked", "https://blocked.test/")];
    },
    getSubTree: async id => [{ id, title: "Folder", children: [bookmark("3", "Nested", "https://nested.test/")] }],
    getChildren: async id => [bookmark(`${id}-child`, "Child", "https://child.test/")],
    getTree: async () => [{ id: "root", children: [{ id: "folder", title: "Folder", children: [bookmark("4", "Deep", "https://deep.test/")] }] }],
    create: async payload => {
      calls.push(["bookmark.create", payload]);
      return { id: "created", ...payload };
    },
    update: async (id, changes) => ({ id, ...changes }),
    move: async (id, destination) => ({ id, ...destination }),
    remove: async id => calls.push(["bookmark.remove", id]),
    removeTree: async id => calls.push(["bookmark.removeTree", id]),
  }),
  getHistory: () => ({
    search: async input => {
      calls.push(["history.search", input]);
      return [
        { id: "h1", title: "Allowed", url: "https://allowed.test/", lastVisitTime: 1_700_000_000_000, visitCount: 2 },
        { id: "h2", title: "Blocked", url: "https://blocked.test/", lastVisitTime: 1_700_000_000_000 },
      ];
    },
  }),
  getSecurityGuardrails: async () => ({ blocked }),
  matchBlockedUrl: (url, guardrails) => guardrails.blocked.has(url),
  assertUrlAllowed: (url, guardrails) => {
    calls.push(["guardrail", url]);
    if (guardrails.blocked.has(url)) throw new ToolExecutionError("SECURITY_GUARDRAIL_BLOCKED", "blocked", { url });
  },
});

assert.deepEqual([...definitions.keys()], ["manage_bookmarks", "browse_history"]);
const bookmarksTool = definitions.get("manage_bookmarks").execute;
const historyTool = definitions.get("browse_history").execute;
assert.match(definitions.get("browse_history").description, /不能用 open_tab 成功代替/);

assert.deepEqual((await bookmarksTool({ action: "search", query: "test", limit: 50 })).map(item => item.id), ["1"]);
await assert.rejects(() => bookmarksTool({ action: "search", query: " " }), error => error?.code === "MISSING_QUERY");

const recursive = await bookmarksTool({ action: "list", id: "folder", recursive: true });
assert.deepEqual(recursive.map(item => item.id), ["folder", "3"]);
const topLevel = await bookmarksTool({ action: "list", recursive: false });
assert.deepEqual(topLevel.map(item => item.id), ["folder"]);

const created = await bookmarksTool({
  action: "create",
  parentId: "folder",
  title: "Created",
  url: "https://created.test/",
  index: 2,
});
assert.equal(created.created.id, "created");
assert.deepEqual(calls.slice(-2).map(item => item[0]), ["guardrail", "bookmark.create"]);
await assert.rejects(
  () => bookmarksTool({ action: "create", title: "Blocked", url: "https://blocked.test/" }),
  error => error?.code === "SECURITY_GUARDRAIL_BLOCKED",
);
await assert.rejects(() => bookmarksTool({ action: "update", id: "1" }), error => error?.code === "MISSING_BOOKMARK_CHANGES");
await assert.rejects(() => bookmarksTool({ action: "move", id: "1" }), error => error?.code === "MISSING_BOOKMARK_DESTINATION");
await bookmarksTool({ action: "delete", id: "folder", recursive: true });
assert.deepEqual(calls.at(-1), ["bookmark.removeTree", "folder"]);

const history = await historyTool({
  action: "search",
  query: "allowed",
  startTime: 1_700_000_000,
  endTime: 1_700_000_100_000,
  limit: 999,
});
assert.deepEqual(history.map(item => item.id), ["h1"]);
assert.deepEqual(calls.find(item => item[0] === "history.search")?.[1], {
  text: "allowed",
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_100_000,
  maxResults: 200,
});
await assert.rejects(() => historyTool({ action: "search", query: "" }), error => error?.code === "MISSING_QUERY");
await assert.rejects(() => historyTool({ action: "delete" }), error => error?.code === "INVALID_HISTORY_ACTION");

console.log("bookmarks/history tool family tests passed");

function bookmark(id, title, url) {
  return { id, title, url, parentId: "root", index: 0, dateAdded: 1_700_000_000_000 };
}
