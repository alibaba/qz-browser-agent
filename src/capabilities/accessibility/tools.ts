import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import { filterViewportNodes, isViewportStructure, readViewportBands, verticalBand } from "./viewport.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import { directChildFrames, openChildFrame, type CdpCommand } from "#sdk/background/browser";
import { isPageOverview, type PageAction as Action, type PageCanvas as Canvas, type PageOverview } from "#sdk/shared/browser";
type AccessibilityHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "clampLimit" | "makeSessionTabTargetError"
  | "sendToContent" | "withDebugger"> & Pick<ToolExtensionAPI["element"],
  "makeSnapshotId" | "makeElementUid" | "elementTargetForUid" | "registerElementRef" | "resolveElementReference"
  | "backendNodeIdForSelector" | "bindBackendNodes" | "callElement" | "readMainDocumentId" | "elementTargetGrammar">;
interface AxValue { value?: unknown }
interface AxNode {
  nodeId: string; parentId?: string; childIds?: string[]; backendDOMNodeId?: number; ignored?: boolean;
  role?: AxValue; name?: AxValue; description?: AxValue; value?: AxValue;
  properties?: { name?: string; value?: AxValue }[];
  /** Set only for nodes grafted from a direct child document. Chrome's own AX frameId is a different field. */
  documentFrameId?: string; documentLoaderId?: string;
}
interface SnapshotContext { tabId: number; snapshotId: string; sessionId?: string; pageUrl?: string; documentId?: string }
interface ActionLocator { selector: string; index: number }

/** Registers the compact accessibility-tree snapshot tool. */
export function registerAccessibilityTools({
  registerTool,
  ToolExecutionError,
  clampLimit,
  makeSnapshotId,
  makeElementUid = (snapshotId: string, seq: number, mark = "") => `${snapshotId}.${mark}${seq}`,
  elementTargetForUid,
  registerElementRef,
  resolveElementReference,
  backendNodeIdForSelector,
  bindBackendNodes = async (_tabId: number, selectors: string[] = []) => ({ loaderId: "", ids: selectors.map(() => 0) }),
  callElement,
  readMainDocumentId = async () => "",
  makeSessionTabTargetError,
  sendToContent,
  withDebugger,
  elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
}: AccessibilityHost) {
type CompactNode = ReturnType<typeof compactAxNode>;
interface SemanticNode {
  compact: CompactNode;
  depth: number;
  parent: SemanticNode | null;
  children: SemanticNode[];
  actionNode?: boolean;
  locator?: ActionLocator | null;
  unavailable?: boolean;
  placeholder?: string;
  inputType?: string;
  accept?: string;
  multiple?: boolean;
  selectedFileCount?: number;
}
interface ActionAnchor {
  action: Action;
  backendNodeId: number;
  ancestors: { backendNodeId: number; childBackendIds: number[] }[];
}
type DisplayNode = {
  uid: string; target: string; depth: number; nodeId: string; parentUid?: string;
  omitted?: number; suppressName?: boolean; unavailable?: boolean; placeholder?: string; inputType?: string;
  accept?: string; multiple?: boolean; selectedFileCount?: number;
  viewportAbove?: number; viewportBelow?: number; listItems?: number;
} & Partial<CompactNode>;
function buildAccessibilitySnapshot(rawNodes: AxNode[], { tabId, snapshotId, limit, sessionId = "", pageUrl = "", documentId = "", rootBackendNodeId = 0, rootFrameId = "", maxDepth = Infinity, loaderId = "", actions = [], viewportBands, viewportHeight = 0 }: SnapshotContext & { limit: number; rootBackendNodeId?: number; rootFrameId?: string; maxDepth?: number; loaderId?: string; actions?: ActionAnchor[]; viewportBands?: Awaited<ReturnType<typeof readViewportBands>>; viewportHeight?: number }) {
  const nodeMap = new Map<string, AxNode>();
  for (const node of rawNodes || []) {
    if (node?.nodeId) nodeMap.set(node.nodeId, node);
  }

  const defaultRoots = [...nodeMap.values()].filter(node => !node.parentId || !nodeMap.has(node.parentId));
  let roots = defaultRoots;
  let rootFound = true;
  if (rootBackendNodeId) {
    const requestedRoot = [...nodeMap.values()].find(node => Number(node?.backendDOMNodeId || 0) === Number(rootBackendNodeId)
      && String(node.documentFrameId || "") === rootFrameId
      && (!rootFrameId || node.documentLoaderId === loaderId));
    roots = requestedRoot ? [requestedRoot] : [];
    rootFound = !!requestedRoot;
  }
  const scopedNodes: AxNode[] = [];
  const collect = (node: AxNode) => {
    scopedNodes.push(node);
    for (const id of node.childIds || []) {
      const child = nodeMap.get(id);
      if (child) collect(child);
    }
  };
  if (viewportBands) for (const root of roots) collect(root);
  const viewportFilter = viewportBands ? filterViewportNodes(scopedNodes, viewportBands) : undefined;
  if (viewportFilter) {
    const byBackend = new Map(scopedNodes.filter(node => (node.documentFrameId || "") === rootFrameId)
      .map(node => [node.backendDOMNodeId, node]));
    actions = actions.filter(anchor => {
      const node = anchor.backendNodeId ? byBackend.get(anchor.backendNodeId) : undefined;
      if (node) return viewportFilter.kept.has(node.nodeId) && !viewportFilter.structural.has(node.nodeId);
      const rect = record(anchor.action.rect);
      const top = Number(rect.y), height = Number(rect.h);
      return Number.isFinite(top) && Number.isFinite(height) && viewportHeight > 0
        && verticalBand(top, top + height, viewportHeight) === "inside";
    });
  }
  const actionBackendIds = new Set(actions.map(anchor => Number(anchor.backendNodeId || 0)).filter(id => id > 0));
  const semanticRoots: SemanticNode[] = [];
  const semanticNodes: SemanticNode[] = [];

  const buildSemanticTree = (rawNode: AxNode | undefined, depth: number, parentNode: SemanticNode | null): void => {
    if (!rawNode || (viewportFilter && !viewportFilter.kept.has(rawNode.nodeId))) return;
    const compact = compactAxNode(rawNode);
    const backendNodeId = Number(compact.backendNodeId || 0);
    const ordinaryKeep = shouldKeepAxNode(compact, depth)
      || (compact.documentFrameId === rootFrameId && actionBackendIds.has(backendNodeId));
    const folded = viewportFilter?.collapsed.has(rawNode.nodeId);
    const keep = ordinaryKeep || folded;
    let nextDepth = depth;
    let nextParentNode = parentNode;

    if (keep) {
      const semanticNode: SemanticNode = {
        compact,
        depth,
        parent: parentNode,
        children: [],
        unavailable: (viewportFilter?.structural.has(rawNode.nodeId) && !isViewportStructure(rawNode) && !folded) || undefined,
      };
      semanticNodes.push(semanticNode);
      if (parentNode) {
        parentNode.children.push(semanticNode);
      } else {
        semanticRoots.push(semanticNode);
      }
      // Newly exposed fold containers do not consume the existing detail-depth allowance.
      nextDepth = depth + (ordinaryKeep ? 1 : 0);
      nextParentNode = semanticNode;
    }

    if (nextDepth >= maxDepth) return;
    for (const childId of rawNode.childIds || []) {
      buildSemanticTree(nodeMap.get(childId), nextDepth, nextParentNode);
    }
  };

  for (const root of roots) buildSemanticTree(root, 0, null);
  const required = placeActions(rootFound ? actions : [], semanticNodes, semanticRoots, rootFrameId, loaderId);
  pruneRedundantText(semanticRoots);
  rebuildSemanticList(semanticRoots, semanticNodes);
  const includedNodes = selectSemanticNodesByBreadth(semanticRoots, limit, required);
  const displayNodes: DisplayNode[] = [];
  let counter = 0;
  const emitDisplayNode = (semanticNode: SemanticNode, parentUid: string | null): void => {
    if (!includedNodes.has(semanticNode)) return;
    const compact = semanticNode.compact;
    // Text roles are display-only unless the page overview identified an explicit action.
    if (!semanticNode.actionNode && PURE_TEXT_ROLES.has(String(compact.role || "").toLowerCase())) semanticNode.unavailable = true;
    const uid = semanticNode.unavailable ? "" : makeElementUid(snapshotId, counter++);
    const item: DisplayNode = {
      uid,
      target: semanticNode.unavailable ? "" : elementTargetForUid(uid),
      depth: semanticNode.depth,
      nodeId: compact.nodeId,
    };
    if (semanticNode.unavailable) item.unavailable = true;
    if (parentUid) item.parentUid = parentUid;
    if (compact.backendNodeId) item.backendNodeId = compact.backendNodeId;
    if (compact.role) item.role = compact.role;
    if (compact.name) item.name = compact.name;
    if (compact.name && semanticNode.parent && compact.name === visibleName(semanticNode.parent) && !semanticNode.actionNode && !hasOwnValueOrFlags(semanticNode)) item.suppressName = true;
    // Off-band retained nodes are ordinary subtree entries; omit their detailed attributes.
    if (!viewportFilter?.structural.has(compact.nodeId)) {
      if (compact.value) item.value = compact.value;
      if (compact.description) item.description = compact.description;
      if (compact.url) item.url = compact.url;
      if (compact.flags?.length) item.flags = compact.flags;
    }
    const folded = viewportFilter?.collapsed.get(compact.nodeId);
    if (folded?.above) item.viewportAbove = folded.above;
    if (folded?.below) item.viewportBelow = folded.below;
    if (viewportFilter && String(compact.role).toLowerCase() === "list") {
      const countItems = (id: string): number => {
        const node = nodeMap.get(id);
        const role = String(node?.role?.value || "").toLowerCase();
        if (!node || role === "list") return 0;
        if (role === "listitem") return 1;
        return (node.childIds || []).reduce((sum, child) => sum + countItems(child), 0);
      };
      item.listItems = (nodeMap.get(compact.nodeId)?.childIds || []).reduce((sum, id) => sum + countItems(id), 0);
    }
    if (semanticNode.placeholder) item.placeholder = semanticNode.placeholder;
    if (semanticNode.inputType) item.inputType = semanticNode.inputType;
    if (semanticNode.accept) item.accept = semanticNode.accept;
    if (semanticNode.multiple) item.multiple = true;
    if (semanticNode.selectedFileCount != null) item.selectedFileCount = semanticNode.selectedFileCount;
    if (compact.ignored) item.ignored = true;
    const omitted = omittedDescendantCount(semanticNode, includedNodes);
    if (omitted) item.omitted = omitted;
    displayNodes.push(item);
    const frameId = String(compact.documentFrameId || "");
    if (!semanticNode.unavailable) registerElementRef({
      uid,
      tabId,
      sessionId,
      pageUrl,
      backendNodeId: item.backendNodeId,
      loaderId: (frameId ? String(compact.documentLoaderId || "") : loaderId) || undefined,
      documentId: documentId || undefined,
      ...(frameId ? { frameId } : {}),
      selector: semanticNode.locator?.selector,
      index: semanticNode.locator?.index,
      role: item.role,
      name: item.name,
      url: compact.url || undefined,
      snapshotId,
    });
    for (const child of semanticNode.children) emitDisplayNode(child, uid);
  };

  for (const root of semanticRoots) emitDisplayNode(root, null);

  const lines: string[] = [];
  const pending: DisplayNode[] = [];
  const foldLine = (node: DisplayNode, direction: "above" | "below") => {
    const count = direction === "above" ? node.viewportAbove : node.viewportBelow;
    const capability = node.target ? toolT("readViewportRoot", { target: node.target }) : 'scope:"full"';
    return `${" ".repeat(node.depth + 1)}${toolT(direction === "above" ? "foldedAbove" : "foldedBelow", { count: count || 0, capability })}`;
  };
  for (const node of displayNodes) {
    while (pending.length && pending[pending.length - 1]!.depth >= node.depth) lines.push(foldLine(pending.pop()!, "below"));
    lines.push(formatSnapshotLine(node));
    if (node.viewportAbove) lines.push(foldLine(node, "above"));
    if (node.viewportBelow) pending.push(node);
  }
  while (pending.length) lines.push(foldLine(pending.pop()!, "below"));
  if (viewportFilter) {
    if (viewportFilter.above) lines.unshift(toolT("aboveViewport", { count: viewportFilter.above }));
    if (viewportFilter.below) lines.push(toolT("belowViewport", { count: viewportFilter.below }));
    if (viewportFilter.unmeasured) lines.push(toolT("unmeasuredViewport", { count: viewportFilter.unmeasured }));
  }
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
    viewportOmitted: viewportFilter ? { above: viewportFilter.above, below: viewportFilter.below, unmeasured: viewportFilter.unmeasured } : undefined,
  };
}

function placeActions(actions: ActionAnchor[], semanticNodes: SemanticNode[], semanticRoots: SemanticNode[], frameId: string, loaderId: string) {
  // Overview actions come from one document. Backend ids, names and ancestors
  // may all collide with nodes grafted from another document.
  const scopedNodes = semanticNodes.filter(node => node.compact.documentFrameId === frameId);
  const byBackend = new Map<number, SemanticNode>();
  for (const node of scopedNodes) {
    const id = Number(node.compact.backendNodeId || 0);
    if (id > 0) byBackend.set(id, node);
  }
  const used = new Set<SemanticNode>();
  const required = new Set<SemanticNode>();
  for (const anchor of actions) {
    const backendNodeId = Number(anchor.backendNodeId || 0);
    const locator = actionLocator(anchor.action);
    let node = backendNodeId ? byBackend.get(backendNodeId) : undefined;
    // A real backend id, or a selector that identifies the element, must not attach to a same-named node.
    if (!node && !backendNodeId && !locator) node = findBestSemanticNode(anchor.action, scopedNodes, used) || undefined;
    // Selector fallback addresses the main Content document, never a child frame.
    if (!node && (backendNodeId || (locator && !frameId))) node = insertSynthetic(anchor, byBackend, semanticNodes, semanticRoots, frameId, loaderId);
    if (!node) {
      node = insertSynthetic(anchor, byBackend, semanticNodes, semanticRoots, frameId, loaderId);
      node.unavailable = true;
      mergeAction(node, anchor.action);
      let current: SemanticNode | null = node;
      while (current) {
        required.add(current);
        current = current.parent;
      }
      continue;
    }
    used.add(node);
    node.actionNode = true;
    if (locator) node.locator = locator;
    mergeAction(node, anchor.action);
    let current: SemanticNode | null = node;
    while (current) {
      required.add(current);
      current = current.parent;
    }
  }
  return required;
}

function insertSynthetic(anchor: ActionAnchor, byBackend: Map<number, SemanticNode>, semanticNodes: SemanticNode[], semanticRoots: SemanticNode[], frameId: string, loaderId: string) {
  let parent: SemanticNode | null = null;
  let childBackendIds: number[] = [];
  for (const ancestor of anchor.ancestors) {
    const found = byBackend.get(ancestor.backendNodeId);
    if (!found) continue;
    parent = found;
    childBackendIds = ancestor.childBackendIds;
    break;
  }
  const semantic: SemanticNode = {
    compact: {
      nodeId: `action:${anchor.backendNodeId || semanticNodes.length}`,
      backendNodeId: anchor.backendNodeId || undefined,
      ignored: false,
      role: normalizeRole(anchor.action.role) || "generic",
      name: "",
      description: "",
      value: "",
      url: "",
      documentFrameId: frameId,
      documentLoaderId: loaderId,
      flags: [],
    },
    depth: 0,
    parent: null,
    children: [],
  };
  if (!parent) parent = semanticRoots.find(node => node.compact.documentFrameId === frameId) || null;
  if (parent) {
    semantic.parent = parent;
    semantic.depth = parent.depth + 1;
    parent.children.splice(insertionIndex(parent.children, anchor.backendNodeId, childBackendIds), 0, semantic);
  } else {
    semanticRoots.push(semantic);
  }
  semanticNodes.push(semantic);
  if (anchor.backendNodeId) byBackend.set(anchor.backendNodeId, semantic);
  return semantic;
}

function insertionIndex(children: SemanticNode[], backendNodeId: number, childBackendIds: number[]) {
  if (!backendNodeId || !childBackendIds.length) return children.length;
  const order = new Map(childBackendIds.map((id, index) => [id, index]));
  const mine = order.get(backendNodeId);
  if (mine == null) return children.length;
  for (let index = 0; index < children.length; index += 1) {
    const id = Number(children[index]?.compact.backendNodeId || 0);
    const position = order.get(id);
    if (position != null && position > mine) return index;
  }
  return children.length;
}

function mergeAction(node: SemanticNode, action: Action) {
  const compact = node.compact;
  if (!compact.name) compact.name = cleanAxValue(action?.name || action?.text);
  if (!compact.value && action?.value) compact.value = cleanAxValue(action.value);
  if (!compact.url && action?.href) compact.url = cleanAxValue(action.href);
  const placeholder = cleanAxValue(action?.placeholder);
  if (placeholder) node.placeholder = placeholder;
  const flags = [...(compact.flags || [])];
  if (action?.disabled && !hasFlag(flags, "disabled")) flags.push("disabled");
  if (typeof action?.checked === "boolean" && !hasFlag(flags, "checked")) flags.push(action.checked ? "checked" : "unchecked");
  if (action?.editable && !hasFlag(flags, "editable")) flags.push("editable");
  compact.flags = flags;
  const inputType = cleanAxValue(action?.type);
  if (inputType && inputType !== String(compact.role || "")) node.inputType = inputType;
  const accept = cleanAxValue(action?.accept);
  if (accept) node.accept = accept;
  if (action?.multiple) node.multiple = true;
  if (Number.isFinite(Number(action?.selectedFileCount))) node.selectedFileCount = Number(action.selectedFileCount);
}

function hasFlag(flags: string[], key: string) {
  return flags.some(flag => flag === key || flag.startsWith(`${key}=`) || (key === "checked" && (flag === "unchecked" || flag.startsWith("checked="))));
}

function actionLocator(action: Action): ActionLocator | null {
  const selector = String(action?.selector || "").trim();
  if (!selector) return null;
  const index = Number(Reflect.get(action, "index"));
  // A confirmed selector has one match. An ambiguous selector is omitted before it reaches here.
  return { selector, index: Number.isInteger(index) && index >= 0 ? index : 0 };
}

const PURE_TEXT_ROLES = new Set(["statictext", "labeltext", "inlinetextbox", "linebreak"]);

function hasOwnValueOrFlags(node: SemanticNode) {
  return !!(node.compact.value || node.compact.flags?.length);
}

function visibleName(node: SemanticNode | null): string {
  if (!node) return "";
  const name = node.compact.name || "";
  if (!name || name === visibleName(node.parent)) return "";
  return name;
}

function shouldDropText(node: SemanticNode, parentName: string) {
  const role = String(node.compact.role || "").toLowerCase();
  if (!PURE_TEXT_ROLES.has(role) || node.actionNode || hasOwnValueOrFlags(node)) return false;
  if (role === "inlinetextbox") return true;
  const name = node.compact.name || "";
  // Sibling text may repeat. Drop a pure text node only when it is empty or copies its parent.
  return !name || name === parentName;
}

function shiftDepth(node: SemanticNode, depth: number) {
  node.depth = depth;
  for (const child of node.children) shiftDepth(child, depth + 1);
}

function pruneLevel(nodes: SemanticNode[], parent: SemanticNode | null) {
  const parentName = visibleName(parent);
  const pending = nodes.map(node => ({ node, pruned: false }));
  const kept: SemanticNode[] = [];
  while (pending.length) {
    const item = pending.shift();
    if (!item) break;
    const node = item.node;
    node.parent = parent;
    node.depth = parent ? parent.depth + 1 : 0;
    if (!item.pruned) {
      node.children = pruneLevel(node.children, node);
      item.pruned = true;
    }
    if (shouldDropText(node, parentName)) {
      const depth = node.depth;
      for (const child of [...node.children].reverse()) {
        shiftDepth(child, depth);
        pending.unshift({ node: child, pruned: true });
      }
      continue;
    }
    kept.push(node);
  }
  return kept;
}

function pruneRedundantText(roots: SemanticNode[]) {
  const pruned = pruneLevel(roots, null);
  roots.splice(0, roots.length, ...pruned);
}

function rebuildSemanticList(roots: SemanticNode[], into: SemanticNode[]) {
  into.length = 0;
  const walk = (node: SemanticNode) => {
    into.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
}

function selectSemanticNodesByBreadth(roots: SemanticNode[], limit: number, required: Set<SemanticNode>) {
  const maxNodes = Math.max(0, Number(limit) || 0);
  const included = new Set<SemanticNode>();
  let optional = 0;
  const queue = Array.isArray(roots) ? roots.slice() : [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (!node || included.has(node)) continue;
    const must = required.has(node);
    if (!must && optional >= maxNodes) continue;
    included.add(node);
    if (!must) optional += 1;
    for (const child of node.children || []) queue.push(child);
  }
  return included;
}

function omittedDescendantCount(node: SemanticNode, included: Set<SemanticNode>) {
  let count = 0;
  const walk = (current: SemanticNode) => {
    for (const child of current.children) {
      if (!included.has(child)) count += 1;
      walk(child);
    }
  };
  walk(node);
  return count;
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
    documentFrameId: String(node.documentFrameId || ""),
    documentLoaderId: String(node.documentLoaderId || ""),
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
  const target = node.unavailable ? "" : (node.target || elementTargetForUid(node.uid));
  const attrs = target ? [`target=${target}`] : [];
  if (node.role) attrs.push(node.role);
  if (node.name && !node.suppressName) attrs.push(`"${truncateInline(node.name, 90)}"`);
  if (node.value && node.value !== node.name) attrs.push(`value="${truncateInline(node.value, 80)}"`);
  if (node.placeholder) attrs.push(`placeholder="${truncateInline(node.placeholder, 80)}"`);
  if (node.url) attrs.push(`url="${truncateInline(node.url, 120)}"`);
  for (const flag of node.flags || []) attrs.push(flag);
  if (node.inputType) attrs.push(`type=${truncateInline(node.inputType, 40)}`);
  if (node.accept) attrs.push(`accept="${truncateInline(node.accept, 120)}"`);
  if (node.multiple) attrs.push("multiple");
  if (node.selectedFileCount != null) attrs.push(`selectedFileCount=${node.selectedFileCount}`);
  if (node.listItems != null) attrs.push(`items=${node.listItems}`);
  const omitted = Number(node.omitted || 0);
  if (omitted) attrs.push(`(truncated, ${omitted} more)`);
  return `${" ".repeat(Math.max(0, Number(node.depth) || 0))}${attrs.join(" ")}`;
}

function truncateInline(value: unknown, max: number) {
  const text = cleanAxValue(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
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

function findBestSemanticNode(action: Action, nodes: SemanticNode[], used: Set<SemanticNode>) {
  let best: SemanticNode | null = null;
  let bestScore = 0;
  for (const node of nodes) {
    if (!node || used.has(node)) continue;
    const score = scoreActionNodeMatch(action, node.compact);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

function scoreActionNodeMatch(action: Action, node: { url?: string; role?: string; name?: string; value?: string }) {
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

async function actionAnchors(send: CdpCommand, actions: Action[], ids: number[]) {
  const anchors: ActionAnchor[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const backendNodeId = Number(ids[index] || 0);
    const ancestors: ActionAnchor["ancestors"] = [];
    if (backendNodeId > 0) {
      let described = await describeNode(send, { backendNodeId });
      let currentBackend = backendNodeId;
      for (let hop = 0; hop < 32; hop += 1) {
        const node = record(described.node);
        const parentNodeId = Number(node.parentId || 0);
        if (!parentNodeId) break;
        const parentDescribed = await describeNode(send, { nodeId: parentNodeId, depth: 1 });
        const parent = record(parentDescribed.node);
        const parentBackend = Number(parent.backendNodeId || 0);
        if (!parentBackend || parentBackend === currentBackend) break;
        const children = Array.isArray(parent.children) ? parent.children : [];
        ancestors.push({
          backendNodeId: parentBackend,
          childBackendIds: children.map(child => Number(record(child).backendNodeId || 0)).filter(id => id > 0),
        });
        currentBackend = parentBackend;
        described = parentDescribed;
      }
    }
    anchors.push({ action: actions[index] || {}, backendNodeId, ancestors });
  }
  return anchors;
}

async function describeNode(send: CdpCommand, params: Record<string, unknown>) {
  try {
    return record(await send("DOM.describeNode", params));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Graft one direct child document under its iframe. A frame that echoes the main tree, or has no owner, is left out. */
async function embedChildFrameNodes(send: CdpCommand, nodes: AxNode[], depth?: number): Promise<AxNode[]> {
  try {
    const frames = await directChildFrames(send);
    if (!frames.length) return nodes;
    const combined = nodes.map(node => ({ ...node, childIds: node.childIds ? [...node.childIds] : undefined }));
    const mainIds = new Set(combined.map(node => node.nodeId).filter(Boolean));
    for (const frame of frames) {
      try {
        const params = { ...(!frame.sessionId ? { frameId: frame.id } : {}), ...(depth == null ? {} : { depth }) };
        const result = await frame.send("Accessibility.getFullAXTree", params);
        const fetched = result && typeof result === "object" && "nodes" in result && Array.isArray((result as { nodes?: unknown }).nodes)
          ? (result as { nodes: AxNode[] }).nodes : [];
        // Child sessions number their own node ids, so those ids are not an echo of the page tree.
        const echoed = !frame.sessionId && fetched.some(node => node?.nodeId && mainIds.has(node.nodeId));
        if (!fetched.length || echoed) continue;
        const owner = record(await send("DOM.getFrameOwner", { frameId: frame.id }));
        const backendNodeId = Number(owner.backendNodeId || 0);
        if (!backendNodeId) continue;
        const ownerNode = combined.find(node => !node.documentFrameId && Number(node.backendDOMNodeId || 0) === backendNodeId);
        if (!ownerNode?.nodeId) continue;
        const present = new Set(fetched.map(node => node?.nodeId).filter(Boolean));
        const prefixed = fetched.filter(node => node?.nodeId).map(node => {
          const parentInFrame = Boolean(node.parentId && present.has(node.parentId));
          return {
            ...node,
            nodeId: `frame:${frame.id}:${node.nodeId}`,
            parentId: parentInFrame ? `frame:${frame.id}:${node.parentId}` : ownerNode.nodeId,
            childIds: (node.childIds || []).filter(id => present.has(id)).map(id => `frame:${frame.id}:${id}`),
            documentFrameId: frame.id,
            documentLoaderId: frame.loaderId,
          };
        });
        const rootIds = prefixed.filter(node => node.parentId === ownerNode.nodeId).map(node => node.nodeId);
        ownerNode.childIds = [...(ownerNode.childIds || []), ...rootIds];
        combined.push(...prefixed);
      } catch {
        // One child frame must not drop the rest of the snapshot.
      }
    }
    return combined;
  } catch {
    return nodes;
  }
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
      scope: { type: "string", enum: ["viewport", "full"], description: toolT("getAxTreeScope") },
      depth: { type: "number", description: toolT("getAxTreeDepth") },
      limit: { type: "number", description: toolT("getAxTreeLimit") },
      actionsLimit: { type: "number", description: toolT("getAxTreeActionsLimit") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, root = "root", scope, depth = 16, limit = 120, actionsLimit = 40 }, _signal, context = {}) => {
    const axDepth = Number.isFinite(Number(depth)) ? clampLimit(depth, 1, 40) : 16;
    const snapshotLimit = Number.isFinite(Number(limit)) ? clampLimit(limit, 20, 300) : 120;
    const actionMax = Number.isFinite(Number(actionsLimit)) ? clampLimit(actionsLimit, 5, 80) : 40;
    let snapshotId = "";
    const sessionId = String(context.sessionId || "").trim();
    const requestedRoot = String(root || "root").trim() || "root";
    const snapshotScope = scope || (requestedRoot === "root" ? "viewport" : "full");
    let targetTabId = tabId;
    let resolvedRoot = requestedRoot;
    let overviewSelector = "body";
    let rootBackendNodeId = 0;
    let rootRef: Awaited<ReturnType<typeof resolveElementReference>> | null = null;

    if (requestedRoot !== "root") {
      rootRef = await resolveElementReference(tabId, { target: requestedRoot }, context);
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

    snapshotId = makeSnapshotId(targetTabId, context);
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

    // UID pageUrl guards the owning tab, while a child overview reports its own URL.
    const pageUrl = String(rootRef?.ref?.frameId ? rootRef.ref.pageUrl || "" : overview?.url || "").trim();
    const documentId = await readMainDocumentId(targetTabId);
    const ax = await withDebugger(targetTabId, async (_target, send) => {
      const actionList = overview?.actions || [];
      const rootFrameId = String(rootRef?.ref?.frameId || "");
      const bound = await bindBackendNodes(targetTabId, actionList.map(action => String(action?.selector || "")), context, rootRef?.ref);
      const frame = rootFrameId ? await openChildFrame(send, rootFrameId) : null;
      if (rootFrameId && (!frame || frame.loaderId !== bound.loaderId)) {
        throw new ToolExecutionError("STALE_ELEMENT_UID", t("cannotResolveAxRoot", { selector: requestedRoot }), { root: requestedRoot });
      }
      const anchors = await actionAnchors(frame?.send || send, actionList, bound.ids);
      // Viewport omission counts must not depend on the later depth/BFS budgets.
      const fetchDepth = snapshotScope === "viewport" ? undefined : rootBackendNodeId ? 40 : axDepth;
      const result = await send("Accessibility.getFullAXTree", fetchDepth == null ? {} : { depth: fetchDepth });
      const nodes = result && typeof result === "object" && "nodes" in result && Array.isArray(result.nodes) ? result.nodes as AxNode[] : [];
      const withFrames = await embedChildFrameNodes(send, nodes, fetchDepth);
      const viewportHeight = rootFrameId ? 0 : Number(record(overview?.viewport).height);
      const viewportBands = snapshotScope === "viewport"
        ? await readViewportBands(send, withFrames, viewportHeight) : undefined;
      return buildAccessibilitySnapshot(withFrames, {
        tabId: targetTabId!, snapshotId, limit: snapshotLimit, sessionId, pageUrl, documentId,
        rootBackendNodeId, rootFrameId, maxDepth: axDepth, loaderId: bound.loaderId, actions: anchors,
        viewportBands, viewportHeight,
      });
    }, context);
    return {
      tabId: targetTabId,
      title: overview?.title,
      url: overview?.url,
      viewport: overview?.viewport,
      snapshotId,
      root: resolvedRoot,
      scope: snapshotScope,
      viewportOmitted: ax.viewportOmitted,
      rootFound: ax.rootFound,
      depth: axDepth,
      nodeCount: ax.nodeCount,
      semanticNodeCount: ax.semanticNodeCount,
      returnedNodeCount: ax.returnedNodeCount,
      outlineTruncated: ax.outlineTruncated,
      snapshot: ax.snapshot,
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
