import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import { isPageOverview, type PageAction as Action, type PageCanvas as Canvas, type PageOverview } from "#sdk/shared/browser";
type AccessibilityHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "clampLimit" | "makeSessionTabTargetError"
  | "sendToContent" | "withDebugger"> & Pick<ToolExtensionAPI["element"],
  "makeSnapshotId" | "elementTargetForUid" | "registerElementRef" | "resolveElementReference"
  | "backendNodeIdForSelector" | "bindBackendNodes" | "callElement" | "elementTargetGrammar">;
interface AxValue { value?: unknown }
interface AxNode {
  nodeId: string; parentId?: string; childIds?: string[]; backendDOMNodeId?: number; ignored?: boolean;
  role?: AxValue; name?: AxValue; description?: AxValue; value?: AxValue;
  properties?: { name?: string; value?: AxValue }[];
}
interface SnapshotContext { tabId: number; snapshotId: string; sessionId?: string; pageUrl?: string }

/** Registers the compact accessibility-tree snapshot tool. */
export function registerAccessibilityTools({
  registerTool,
  ToolExecutionError,
  clampLimit,
  makeSnapshotId,
  elementTargetForUid,
  registerElementRef,
  resolveElementReference,
  backendNodeIdForSelector,
  bindBackendNodes = async (_tabId: number, selectors: string[] = []) => ({ loaderId: "", ids: selectors.map(() => 0) }),
  callElement,
  makeSessionTabTargetError,
  sendToContent,
  withDebugger,
  elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
}: AccessibilityHost) {
type CompactNode = ReturnType<typeof compactAxNode>;
interface SemanticNode { compact: CompactNode; depth: number; parent: SemanticNode | null; children: SemanticNode[] }
type DisplayNode = { uid: string; target: string; depth: number; nodeId: string; parentUid?: string; truncated?: boolean } & Partial<CompactNode>;
function buildAccessibilitySnapshot(rawNodes: AxNode[], { tabId, snapshotId, limit, sessionId = "", pageUrl = "", rootBackendNodeId = 0, maxDepth = Infinity, loaderId = "" }: SnapshotContext & { limit: number; rootBackendNodeId?: number; maxDepth?: number; loaderId?: string }) {
  const nodeMap = new Map<string, AxNode>();
  for (const node of rawNodes || []) {
    if (node?.nodeId) nodeMap.set(node.nodeId, node);
  }

  const defaultRoots = [...nodeMap.values()].filter(node => !node.parentId || !nodeMap.has(node.parentId));
  let roots = defaultRoots;
  let rootFound = true;
  if (rootBackendNodeId) {
    const requestedRoot = [...nodeMap.values()].find(node => Number(node?.backendDOMNodeId || 0) === Number(rootBackendNodeId));
    roots = requestedRoot ? [requestedRoot] : [];
    rootFound = !!requestedRoot;
  }
  const semanticRoots: SemanticNode[] = [];
  const semanticNodes: SemanticNode[] = [];

  const buildSemanticTree = (rawNode: AxNode | undefined, depth: number, parentNode: SemanticNode | null): void => {
    if (!rawNode) return;
    const compact = compactAxNode(rawNode);
    const keep = shouldKeepAxNode(compact, depth);
    let nextDepth = depth;
    let nextParentNode = parentNode;

    if (keep) {
      const semanticNode: SemanticNode = {
        compact,
        depth,
        parent: parentNode,
        children: [],
      };
      semanticNodes.push(semanticNode);
      if (parentNode) {
        parentNode.children.push(semanticNode);
      } else {
        semanticRoots.push(semanticNode);
      }
      nextDepth = depth + 1;
      nextParentNode = semanticNode;
    }

    if (nextDepth >= maxDepth) return;
    for (const childId of rawNode.childIds || []) {
      buildSemanticTree(nodeMap.get(childId), nextDepth, nextParentNode);
    }
  };

  for (const root of roots) buildSemanticTree(root, 0, null);

  const includedNodes = selectSemanticNodesByBreadth(semanticRoots, limit);
  const displayNodes: DisplayNode[] = [];
  let counter = 0;
  const emitDisplayNode = (semanticNode: SemanticNode, parentUid: string | null): void => {
    if (!includedNodes.has(semanticNode)) return;
    const compact = semanticNode.compact;
    const uid = `${snapshotId}_${counter++}`;
    const item: DisplayNode = {
      uid,
      target: elementTargetForUid(uid),
      depth: semanticNode.depth,
      nodeId: compact.nodeId,
    };
    if (parentUid) item.parentUid = parentUid;
    if (compact.backendNodeId) item.backendNodeId = compact.backendNodeId;
    if (compact.role) item.role = compact.role;
    if (compact.name) item.name = compact.name;
    if (compact.value) item.value = compact.value;
    if (compact.description) item.description = compact.description;
    if (compact.url) item.url = compact.url;
    if (compact.flags?.length) item.flags = compact.flags;
    if (compact.ignored) item.ignored = true;
    if (semanticNode.children.some(child => !includedNodes.has(child))) item.truncated = true;
    displayNodes.push(item);
    registerElementRef({
      uid,
      tabId,
      sessionId,
      pageUrl,
      backendNodeId: item.backendNodeId,
      loaderId: loaderId || undefined,
      role: item.role,
      name: item.name,
      url: item.url,
      snapshotId,
    });
    for (const child of semanticNode.children) emitDisplayNode(child, uid);
  };

  for (const root of semanticRoots) emitDisplayNode(root, null);

  const lines = displayNodes.map(formatSnapshotLine);
  const truncatedNodeCount = Math.max(0, semanticNodes.length - displayNodes.length);
  return {
    snapshot: lines.join("\n"),
    nodes: displayNodes,
    nodeCount: rawNodes?.length || 0,
    semanticNodeCount: semanticNodes.length,
    returnedNodeCount: displayNodes.length,
    truncatedNodeCount,
    outlineTruncated: truncatedNodeCount > 0,
    rootFound,
  };
}

function selectSemanticNodesByBreadth(roots: SemanticNode[], limit: number) {
  const maxNodes = Math.max(0, Number(limit) || 0);
  const included = new Set<SemanticNode>();
  const queue = Array.isArray(roots) ? roots.slice() : [];
  for (let index = 0; index < queue.length && included.size < maxNodes; index += 1) {
    const node = queue[index];
    if (!node || included.has(node)) continue;
    included.add(node);
    for (const child of node.children || []) queue.push(child);
  }
  return included;
}

function compactAxNode(node: AxNode) {
  const props = axPropertiesToObject(node.properties || []);
  return {
    nodeId: node.nodeId,
    backendNodeId: node.backendDOMNodeId,
    ignored: !!node.ignored,
    role: cleanAxValue(node.role?.value),
    name: cleanAxValue(node.name?.value),
    description: cleanAxValue(node.description?.value),
    value: cleanAxValue(node.value?.value),
    url: cleanAxValue(props.url),
    flags: ["focused", "disabled", "expanded", "checked", "selected", "editable", "readonly", "required"]
      .map(key => formatAxFlag(key, props[key]))
      .filter(Boolean),
  };
}

function axPropertiesToObject(properties: NonNullable<AxNode["properties"]>) {
  const out: Record<string, unknown> = {};
  for (const prop of properties || []) {
    if (!prop?.name) continue;
    out[prop.name] = prop.value?.value;
  }
  return out;
}

function cleanAxValue(value: unknown) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function formatAxFlag(key: string, value: unknown) {
  if (value == null) return "";
  if (key === "expanded") return value ? "expanded" : "collapsed";
  if (key === "checked") return value === true ? "checked" : value === false ? "unchecked" : String(value);
  if (value === false) return "";
  return value === true ? key : `${key}=${cleanAxValue(value)}`;
}

function shouldKeepAxNode(node: CompactNode, depth: number) {
  if (!node) return false;
  if (depth === 0) return true;
  if (node.ignored) return false;
  const role = String(node.role || "");
  const hasContent = !!(node.name || node.value || node.description || node.url || node.flags?.length);
  if ((role === "none" || role === "generic") && !hasContent) return false;
  if (!role && !hasContent) return false;
  return true;
}

function formatSnapshotLine(node: DisplayNode) {
  const target = node.target || elementTargetForUid(node.uid);
  const attrs = target ? [`target=${target}`] : [];
  if (node.role) attrs.push(node.role);
  if (node.name) attrs.push(`"${truncateInline(node.name, 90)}"`);
  if (node.value && node.value !== node.name) attrs.push(`value="${truncateInline(node.value, 80)}"`);
  if (node.url) attrs.push(`url="${truncateInline(node.url, 120)}"`);
  for (const flag of node.flags || []) attrs.push(flag);
  if (node.truncated) attrs.push("(truncated)");
  return `${"  ".repeat(Math.max(0, Number(node.depth) || 0))}${attrs.join(" ")}`;
}

function truncateInline(value: unknown, max: number) {
  const text = cleanAxValue(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function attachSnapshotRefsToActions(actions: Action[], nodes: DisplayNode[], { tabId, snapshotId, sessionId = "", pageUrl = "" }: SnapshotContext, backendNodeIds: number[] = [], loaderId = "") {
  const candidates = Array.isArray(nodes) ? nodes : [];
  const used = new Set<string>();
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    const matched = findBestActionNode(action, candidates, used);
    const uid = matched?.uid || `${snapshotId}_a${index}`;
    used.add(uid);
    const next = { ...action, uid, target: elementTargetForUid(uid) };
    const backendNodeId = Number(matched?.backendNodeId || backendNodeIds[index] || 0);
    registerElementRef({
      uid, tabId, sessionId, pageUrl, selector: next.selector, index: 0,
      backendNodeId: backendNodeId || undefined, loaderId: loaderId || undefined,
      role: next.role || matched?.role, name: next.name || next.text || matched?.name,
      url: next.href || matched?.url, snapshotId,
    });
    return next;
  });
}

function compactAxActionsForModel(actions: Action[]) {
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    const target = action?.target || elementTargetForUid(action?.uid);
    const next = {
      i: Number.isFinite(Number(action?.i)) ? Number(action.i) : index,
      target,
      role: truncateInline(action?.role, 40),
      type: truncateInline(action?.type, 40),
      name: truncateInline(action?.name, 100),
      text: truncateInline(action?.text, 120),
      textLength: Number.isFinite(Number(action?.textLength)) && Number(action.textLength) > 0
        ? Number(action.textLength)
        : undefined,
      value: truncateInline(action?.value, 80),
      placeholder: truncateInline(action?.placeholder, 80),
      href: truncateInline(action?.href, 160),
      disabled: action?.disabled ? true : undefined,
      editable: action?.editable ? true : undefined,
      checked: typeof action?.checked === "boolean" ? action.checked : undefined,
      accept: truncateInline(action?.accept, 120),
      multiple: action?.multiple ? true : undefined,
      selectedFileCount: Number.isFinite(Number(action?.selectedFileCount))
        ? Number(action.selectedFileCount)
        : undefined,
      inViewport: typeof action?.inViewport === "boolean" ? action.inViewport : undefined,
      rect: action?.rect && typeof action.rect === "object" ? action.rect : undefined,
    };
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (next[key] == null || next[key] === "") delete next[key];
    }
    return next;
  });
}

function compactAxHeadingsForModel(headings: NonNullable<PageOverview["headings"]>) {
  return (Array.isArray(headings) ? headings : [])
    .map(heading => ({
      level: Number.isFinite(Number(heading?.level)) ? Number(heading.level) : null,
      text: truncateInline(heading?.text, 160),
    }))
    .filter(heading => heading.text);
}

function compactAxCanvasesForModel(canvases: Canvas[]) {
  return (Array.isArray(canvases) ? canvases : [])
    .slice(0, 8)
    .map((canvas) => {
      const rect = canvas?.rect && typeof canvas.rect === "object"
        ? {
            x: Number(canvas.rect.x),
            y: Number(canvas.rect.y),
            w: Number(canvas.rect.w),
            h: Number(canvas.rect.h),
          }
        : null;
      if (!rect || !Object.values(rect).every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return null;
      const bitmapWidth = Number(canvas?.bitmapSize?.width);
      const bitmapHeight = Number(canvas?.bitmapSize?.height);
      const next = {
        name: truncateInline(canvas?.name, 160),
        rect,
        inViewport: typeof canvas?.inViewport === "boolean" ? canvas.inViewport : undefined,
        bitmapSize: Number.isFinite(bitmapWidth) && Number.isFinite(bitmapHeight)
          ? { width: bitmapWidth, height: bitmapHeight }
          : undefined,
      };
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        if (next[key] == null || next[key] === "") delete next[key];
      }
      return next;
    })
    .filter(Boolean);
}

function findBestActionNode(action: Action, nodes: DisplayNode[], used: Set<string>) {
  let best: DisplayNode | null = null;
  let bestScore = 0;
  for (const node of nodes) {
    if (!node?.uid || used.has(node.uid)) continue;
    const score = scoreActionNodeMatch(action, node);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

function scoreActionNodeMatch(action: Action, node: DisplayNode) {
  let score = 0;
  const actionHref = cleanAxValue(action.href);
  const nodeUrl = cleanAxValue(node.url);
  const actionRole = normalizeRole(action.role);
  const nodeRole = normalizeRole(node.role);
  const actionText = cleanAxValue(action.name || action.text || action.value || action.placeholder);
  const nodeText = cleanAxValue(node.name || node.value);

  if (actionHref && nodeUrl && sameUrlPrefix(actionHref, nodeUrl)) score += 5;
  if (actionRole && nodeRole && actionRole === nodeRole) score += 2;
  if (actionText && nodeText) {
    if (actionText === nodeText) score += 4;
    else if (actionText.includes(nodeText) || nodeText.includes(actionText)) score += 2;
  }
  return score;
}

function normalizeRole(role: unknown) {
  const value = String(role || "").toLowerCase();
  if (value === "a") return "link";
  if (value === "input" || value === "textarea") return "textbox";
  return value;
}

function sameUrlPrefix(a: string, b: string) {
  const left = String(a || "").split("#")[0];
  const right = String(b || "").split("#")[0];
  return left === right || left.startsWith(right) || right.startsWith(left);
}

registerTool({
  name: "get_ax_tree",
  model: { projectResult: projectAxResultForModel },
  get description() { return toolT("getAxTreeDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("getAxTreeTabId") },
      root: { type: "string", description: toolT("getAxTreeRoot") },
      depth: { type: "number", description: toolT("getAxTreeDepth") },
      limit: { type: "number", description: toolT("getAxTreeLimit") },
      actionsLimit: { type: "number", description: toolT("getAxTreeActionsLimit") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, root = "root", depth = 16, limit = 120, actionsLimit = 40 }, _signal, context = {}) => {
    const axDepth = Number.isFinite(Number(depth)) ? clampLimit(depth, 1, 40) : 16;
    const snapshotLimit = Number.isFinite(Number(limit)) ? clampLimit(limit, 20, 300) : 120;
    const actionMax = Number.isFinite(Number(actionsLimit)) ? clampLimit(actionsLimit, 5, 80) : 40;
    let snapshotId = "";
    const sessionId = String(context.sessionId || "").trim();
    const requestedRoot = String(root || "root").trim() || "root";
    let targetTabId = tabId;
    let resolvedRoot = requestedRoot;
    let overviewSelector = "body";
    let rootBackendNodeId = 0;
    let rootRef: Awaited<ReturnType<typeof resolveElementReference>> | null = null;

    if (requestedRoot !== "root") {
      rootRef = await resolveElementReference(tabId, { target: requestedRoot, allowBackendOnly: true }, context);
      targetTabId = rootRef.tabId;
      resolvedRoot = rootRef.target || requestedRoot;
      overviewSelector = rootRef.selector || "";
      rootBackendNodeId = Number(rootRef.ref?.backendNodeId || 0);
      if (!rootBackendNodeId && overviewSelector && targetTabId) {
        rootBackendNodeId = await backendNodeIdForSelector(targetTabId, overviewSelector, context);
      }
      if (!rootBackendNodeId) {
        throw new ToolExecutionError("AX_ROOT_UNRESOLVED", t("cannotResolveAxRoot", { selector: String(requestedRoot) }), {
          root: requestedRoot,
          target: resolvedRoot,
          selector: overviewSelector || undefined,
        });
      }
    }

    if (!targetTabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", {
      toolName: "get_ax_tree",
      sessionId: context?.sessionId || "",
      depth,
      root: requestedRoot,
    });

    snapshotId = makeSnapshotId(targetTabId);
    let overview: PageOverview;
    try {
      const result = rootRef?.uid
        ? await callElement(targetTabId, rootRef, "pageOverview", { limit: actionMax }, context)
        : await sendToContent(targetTabId, "pageOverview", { limit: actionMax, selector: overviewSelector || "body" });
      if (!isPageOverview(result)) throw new ToolExecutionError("PAGE_OVERVIEW_FAILED", t("pageOverviewResponseIsInvalid"));
      overview = result;
    } catch (err) {
      if (err instanceof ToolExecutionError && String(err.code).startsWith("STALE_ELEMENT_UID")) throw err;
      overview = {
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof ToolExecutionError ? err.code : "PAGE_OVERVIEW_FAILED",
      };
    }

    const pageUrl = String(overview?.url || "").trim();
    const ax = await withDebugger(targetTabId, async (_target, send) => {
      const actionList = overview?.actions || [];
      const bound = await bindBackendNodes(targetTabId, actionList.map(action => String(action?.selector || "")), context);
      const fetchDepth = rootBackendNodeId ? 40 : axDepth;
      const result = await send("Accessibility.getFullAXTree", { depth: fetchDepth });
      const nodes = result && typeof result === "object" && "nodes" in result && Array.isArray(result.nodes) ? result.nodes as AxNode[] : [];
      const built = buildAccessibilitySnapshot(nodes, {
        tabId: targetTabId!, snapshotId, limit: snapshotLimit, sessionId, pageUrl, rootBackendNodeId, maxDepth: axDepth, loaderId: bound.loaderId,
      });
      return {
        ...built,
        actions: attachSnapshotRefsToActions(actionList, built.nodes, { tabId: targetTabId, snapshotId, sessionId, pageUrl }, bound.ids, bound.loaderId),
      };
    }, context);
    const actions = ax.actions;
    return {
      tabId: targetTabId,
      title: overview?.title,
      url: overview?.url,
      viewport: overview?.viewport,
      snapshotId,
      root: resolvedRoot,
      rootFound: ax.rootFound,
      depth: axDepth,
      nodeCount: ax.nodeCount,
      semanticNodeCount: ax.semanticNodeCount,
      returnedNodeCount: ax.returnedNodeCount,
      outlineTruncated: ax.outlineTruncated,
      snapshot: ax.snapshot,
      headings: compactAxHeadingsForModel(overview?.headings || []),
      actions: compactAxActionsForModel(actions),
      canvases: compactAxCanvasesForModel(overview?.canvases || []),
      pageOverviewError: overview?.error ? {
        error: overview.error,
        code: overview.code,
      } : undefined,
    };
  },
});


}

/** The model gets actionable fields; UI diagnostics remain in the original result. */
function projectAxResultForModel(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { nodes, ...out } = result as Record<string, unknown>;
  if (Array.isArray(out.actions)) out.actions = out.actions.map((action: Record<string, unknown>) => ({
    target: action.target,
    selector: action.selector,
    role: action.role,
    name: action.name,
    text: action.text,
    value: action.value,
    placeholder: action.placeholder,
    href: action.href,
    disabled: action.disabled,
    editable: action.editable,
    inViewport: action.inViewport,
  }));
  return out;
}


export default ((host) => { registerAccessibilityTools({ ...host, ...host.element }); }) satisfies ToolExtension;
