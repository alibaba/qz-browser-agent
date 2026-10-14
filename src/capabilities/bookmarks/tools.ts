import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
type BookmarkDependencies = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "clampLimit" | "getBookmarks"
  | "getHistory" | "getSecurityGuardrails" | "matchBlockedUrl" | "assertUrlAllowed">;
import { requireToolFields } from "#sdk/background/tools";
import { formatBeijingDateTime } from "#sdk/shared/format";

/** Registers browser-owned bookmark mutation and history read tools. */
export function registerBookmarksHistoryTools({
  registerTool,
  ToolExecutionError,
  clampLimit,
  getBookmarks,
  getHistory,
  getSecurityGuardrails,
  matchBlockedUrl,
  assertUrlAllowed,
}: BookmarkDependencies) {
  registerTool({
  name: "manage_bookmarks",
  requires: { browserPermission: "bookmarks" },
  get description() { return toolT("manageBookmarksDescription"); },
  get parameters() { return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "create", "update", "move", "delete", "list"],
          description: toolT("manageBookmarksAction"),
        },
        query: { type: "string", description: toolT("manageBookmarksQuery") },
        id: { type: "string", description: toolT("manageBookmarksId") },
        parentId: { type: "string", description: toolT("manageBookmarksParentId") },
        title: { type: "string", description: toolT("manageBookmarksTitle") },
        url: { type: "string", description: toolT("manageBookmarksUrl") },
        index: { type: "number", description: toolT("manageBookmarksIndex") },
        recursive: { type: "boolean", description: toolT("manageBookmarksRecursive") },
        limit: { type: "number", description: toolT("manageBookmarksLimit") },
      },
      required: ["action"],
    } as const; },
  timeout: { defaultMs: 15000, maxMs: 120000 },
  execute: async ({ action, query = "", id, parentId, title, url, index, recursive = false, limit = 50 }) => {
      const bookmarks = getBookmarks();
      const max = clampLimit(limit, 1, 200);

      if (action === "search") {
        if (!query.trim()) {
          throw new ToolExecutionError("MISSING_QUERY", t("manageBookmarksSearchRequiresANonEmptyQuery"), { action });
        }
        const guardrails = await getSecurityGuardrails();
        const nodes = await bookmarks.search(query);
        return nodes
          .filter(node => !node.url || !matchBlockedUrl(node.url, guardrails))
          .slice(0, max)
          .map(formatBookmarkNode);
      }

      if (action === "list") {
        const guardrails = await getSecurityGuardrails();
        if (id || parentId) {
          const targetId = id || parentId!;
          const nodes = recursive
            ? await bookmarks.getSubTree(targetId)
            : await bookmarks.getChildren(targetId);
          const flat = recursive ? flattenBookmarkNodes(nodes) : nodes;
          return flat.filter(node => !node.url || !matchBlockedUrl(node.url, guardrails)).slice(0, max).map(formatBookmarkNode);
        }
        const tree = await bookmarks.getTree();
        const roots = tree[0]?.children || tree;
        const flat = recursive ? flattenBookmarkNodes(roots) : roots;
        return flat.filter(node => !node.url || !matchBlockedUrl(node.url, guardrails)).slice(0, max).map(formatBookmarkNode);
      }

      if (action === "create") {
        if (!title?.trim() && !url?.trim()) {
          throw new ToolExecutionError("MISSING_BOOKMARK_DATA", t("manageBookmarksCreateRequiresTitleOrUrl"), { action });
        }
        const payload: chrome.bookmarks.CreateDetails = {};
        if (parentId) payload.parentId = parentId;
        if (title != null) payload.title = title;
        if (url) payload.url = url;
        if (payload.url) assertUrlAllowed(payload.url, await getSecurityGuardrails(), { tool: "manage_bookmarks", action, source: "url" });
        if (Number.isFinite(index)) payload.index = index;
        return { created: formatBookmarkNode(await bookmarks.create(payload)) };
      }

      if (action === "update") {
        if (!id) throw new ToolExecutionError("MISSING_BOOKMARK_ID", t("manageBookmarksUpdateRequiresId"), { action });
        const changes: { title?: string; url?: string } = {};
        if (title != null) changes.title = title;
        if (url != null) changes.url = url;
        if (changes.url) assertUrlAllowed(changes.url, await getSecurityGuardrails(), { tool: "manage_bookmarks", action, source: "url" });
        if (Object.keys(changes).length === 0) {
          throw new ToolExecutionError("MISSING_BOOKMARK_CHANGES", t("manageBookmarksUpdateRequiresTitleOrUrlToMove"), { action, id, parentId, index });
        }
        return { updated: formatBookmarkNode(await bookmarks.update(id, changes)) };
      }

      if (action === "move") {
        if (!id) throw new ToolExecutionError("MISSING_BOOKMARK_ID", t("manageBookmarksMoveRequiresId"), { action });
        const destination: chrome.bookmarks.MoveDestination = {};
        if (parentId) destination.parentId = parentId;
        if (Number.isFinite(index)) destination.index = index;
        if (Object.keys(destination).length === 0) {
          throw new ToolExecutionError("MISSING_BOOKMARK_DESTINATION", t("manageBookmarksMoveRequiresParentidOrIndex"), { action, id });
        }
        return { moved: formatBookmarkNode(await bookmarks.move(id, destination)) };
      }

      if (action === "delete") {
        if (!id) throw new ToolExecutionError("MISSING_BOOKMARK_ID", t("manageBookmarksDeleteRequiresId"), { action });
        if (recursive) await bookmarks.removeTree(id);
        else await bookmarks.remove(id);
        return { deleted: id, recursive };
      }

      throw new ToolExecutionError("INVALID_BOOKMARK_ACTION", t("unsupportedManageBookmarksAction", { action: String(action) }), { action });
    },
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["search"].includes(action)) requireToolFields("manage_bookmarks", args, ["query"], { action, requiredWhen: `action=${action}` });
    if (["create"].includes(action)) requireToolFields("manage_bookmarks", args, [["title","url"]], { action, requiredWhen: `action=${action}` });
    if (["update"].includes(action)) requireToolFields("manage_bookmarks", args, ["id",["title","url"]], { action, requiredWhen: `action=${action}` });
    if (["move"].includes(action)) requireToolFields("manage_bookmarks", args, ["id",["parentId","index"]], { action, requiredWhen: `action=${action}` });
    if (["delete"].includes(action)) requireToolFields("manage_bookmarks", args, ["id"], { action, requiredWhen: `action=${action}` });
  },
});

  registerTool({
  name: "browse_history",
  requires: { browserPermission: "history" },
  get description() { return toolT("browseHistoryDescription"); },
  get parameters() { return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "recent"],
          description: toolT("browseHistoryAction"),
        },
        query: { type: "string", description: toolT("browseHistoryQuery") },
        startTime: { type: "number", description: toolT("browseHistoryStartTime") },
        endTime: { type: "number", description: toolT("browseHistoryEndTime") },
        limit: { type: "number", description: toolT("manageBookmarksLimit") },
      },
      required: ["action"],
    } as const; },
  timeout: { defaultMs: 15000, maxMs: 120000 },
  execute: async ({ action, query = "", startTime, endTime, limit = 50 }) => {
      const maxResults = clampLimit(limit, 1, 200);
      const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const searchText = action === "recent" ? "" : query;
      if (action === "search" && !query.trim()) {
        throw new ToolExecutionError("MISSING_QUERY", t("browseHistorySearchRequiresANonEmptyQuery"), { action });
      }
      if (!["search", "recent"].includes(action)) {
        throw new ToolExecutionError("INVALID_HISTORY_ACTION", t("unsupportedBrowseHistoryAction", { action: String(action) }), { action });
      }
      const items = await getHistory().search({
        text: searchText,
        startTime: normalizeHistoryTimeSecondsToMs(startTime, monthAgo),
        endTime: normalizeHistoryTimeSecondsToMs(endTime, Date.now()),
        maxResults,
      });
      const guardrails = await getSecurityGuardrails();
      return items.filter(item => !matchBlockedUrl(item.url || "", guardrails)).map(formatHistoryItem);
    },
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["search"].includes(action)) requireToolFields("browse_history", args, ["query"], { action, requiredWhen: `action=${action}` });
  },
});
}

function formatBookmarkNode(node: chrome.bookmarks.BookmarkTreeNode) {
  return {
    id: node.id,
    parentId: node.parentId ?? null,
    index: node.index ?? null,
    type: node.url ? "bookmark" : "folder",
    title: node.title || "",
    url: node.url || null,
    dateAdded: node.dateAdded ? formatBeijingDateTime(new Date(node.dateAdded)) : null,
    dateGroupModified: node.dateGroupModified ? formatBeijingDateTime(new Date(node.dateGroupModified)) : null,
    childCount: Array.isArray(node.children) ? node.children.length : undefined,
  };
}

function flattenBookmarkNodes(nodes: chrome.bookmarks.BookmarkTreeNode[], out: chrome.bookmarks.BookmarkTreeNode[] = []) {
  for (const node of nodes || []) {
    out.push(node);
    if (Array.isArray(node.children)) flattenBookmarkNodes(node.children, out);
  }
  return out;
}

function formatHistoryItem(item: chrome.history.HistoryItem) {
  return {
    id: item.id,
    title: item.title || "",
    url: item.url,
    lastVisitTime: item.lastVisitTime ? formatBeijingDateTime(new Date(item.lastVisitTime)) : null,
    visitCount: item.visitCount ?? 0,
    typedCount: item.typedCount ?? 0,
  };
}

function normalizeHistoryTimeSecondsToMs(value: unknown, fallbackMs: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return n > 100_000_000_000 ? Math.floor(n) : Math.floor(n * 1000);
}


export default registerBookmarksHistoryTools satisfies ToolExtension;
