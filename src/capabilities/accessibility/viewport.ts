import { frameContentOrigin, openChildFrame, type CdpCommand } from "#sdk/background/browser";

interface ViewportNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  documentFrameId?: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
}
type Band = "above" | "below" | "inside";
export interface ViewportFilter {
  kept: Set<string>;
  structural: Set<string>;
  above: number;
  below: number;
  unmeasured: number;
  /** Folded semantic items, attributed to the nearest retained container. */
  collapsed: Map<string, { above: number; below: number }>;
}

/** Positive Y overlap only: X, containment and occlusion are deliberately irrelevant. */
export function verticalBand(top: number, bottom: number, height: number): Band {
  if (top === bottom) return top < 0 ? "above" : top >= height ? "below" : "inside";
  return bottom <= 0 ? "above" : top >= height ? "below" : "inside";
}

const CONTAINER_ROLES = new Set(["main", "region", "landmark", "article", "navigation", "banner", "contentinfo", "complementary", "group", "list", "listbox", "table", "tree", "feed"]);
const TEXT_ROLES = new Set(["statictext", "labeltext", "inlinetextbox", "linebreak"]);
const roleOf = (node: ViewportNode) => String(node.role?.value || "").toLowerCase();
const nameOf = (node: ViewportNode) => String(node.name?.value || "").replace(/\s+/g, " ").trim();

/** Ordinary structural nodes may remain off-screen as bounded subtree entry points. */
export function isViewportStructure(node: ViewportNode): boolean {
  if (node.ignored || !node.backendDOMNodeId) return false;
  const role = roleOf(node);
  return role === "heading" || CONTAINER_ROLES.has(role)
    || (role === "link" && nameOf(node).length >= 12);
}

/** Count actual raw AX nodes removed, before semantic, depth, text or BFS pruning. */
export function filterViewportNodes(nodes: ViewportNode[], bands: Map<string, Band>): ViewportFilter {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const resolved = new Map<string, Band | undefined>();
  const bandFor = (node: ViewportNode): Band | undefined => {
    if (resolved.has(node.nodeId)) return resolved.get(node.nodeId);
    resolved.set(node.nodeId, undefined);
    // Inline text boxes have no DOM id; inherit their text node's measured box.
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const band = bands.get(node.nodeId) ?? (!node.backendDOMNodeId && parent ? bandFor(parent) : undefined);
    resolved.set(node.nodeId, band);
    return band;
  };
  const children = (node: ViewportNode) => (node.childIds || []).map(id => byId.get(id)).filter((child): child is ViewportNode => !!child);
  const meaningful = (node: ViewportNode) => {
    const role = roleOf(node), parent = node.parentId ? byId.get(node.parentId) : undefined;
    return !node.ignored && role !== "inlinetextbox" && role !== "linebreak"
      && !((role === "none" || role === "generic") && !nameOf(node))
      && !(TEXT_ROLES.has(role) && (!nameOf(node) || (parent && nameOf(parent) === nameOf(node))));
  };
  const sizes = new Map<string, number>(), firstHeadings = new Map<string, string>();
  const measure = (node: ViewportNode): number => {
    if (sizes.has(node.nodeId)) return sizes.get(node.nodeId)!;
    sizes.set(node.nodeId, 0);
    // A heading plus an aria-labelled arrow/image is still only a heading wrapper.
    // Visible text (including link text descendants) identifies the content-bearing section.
    let size = !node.ignored && !["link", "image", "button", "inlinetextbox"].includes(roleOf(node)) && nameOf(node) ? 1 : 0;
    let heading = roleOf(node) === "heading" ? node.nodeId : "";
    for (const child of children(node)) {
      size += measure(child);
      heading ||= firstHeadings.get(child.nodeId) || "";
    }
    sizes.set(node.nodeId, size);
    firstHeadings.set(node.nodeId, heading);
    return size;
  };
  for (const node of nodes) measure(node);
  const containers = new Set(nodes.filter(node => CONTAINER_ROLES.has(roleOf(node))).map(node => node.nodeId));
  // A heading's first content-bearing wrapper is a section even when native AX calls it generic.
  // Keep its actual node/UID: a heading UID alone cannot read its sibling paragraphs or cards.
  for (const heading of nodes.filter(node => roleOf(node) === "heading")) {
    let child = heading;
    for (let parent = byId.get(child.parentId || ""); parent; parent = byId.get(child.parentId || "")) {
      if (firstHeadings.get(parent.nodeId) !== heading.nodeId) break;
      if (!TEXT_ROLES.has(roleOf(parent)) && roleOf(parent) !== "link" && parent.backendDOMNodeId
        && children(parent).some(sibling => sibling !== child && (sizes.get(sibling.nodeId) || 0) > 0)) {
        containers.add(parent.nodeId);
        break;
      }
      child = parent;
    }
  }
  const kept = new Set<string>();
  const keepAncestors = (node: ViewportNode) => {
    let current: ViewportNode | undefined = node;
    while (current && !kept.has(current.nodeId)) {
      kept.add(current.nodeId);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  };
  const structural = new Set<string>();
  let unmeasured = 0;
  for (const node of nodes) {
    const band = bandFor(node);
    if (!band) unmeasured += 1;
    // Unknown geometry fails open, not as a false off-screen count.
    if (!band || band === "inside") keepAncestors(node);
  }
  // Reserve a small character allowance, including newly retained ancestor lines and fold hints.
  // Alternate document ends rather than filling the allowance with only the first screenful of headings.
  let remaining = 1800;
  const candidates = nodes.filter(node => !kept.has(node.nodeId) && isViewportStructure(node));
  candidates.sort((a, b) => Number(roleOf(a) !== "heading") - Number(roleOf(b) !== "heading"));
  for (const role of ["heading", "structure", "link"]) {
    const group = candidates.filter(node => role === "heading" ? roleOf(node) === "heading"
      : role === "link" ? roleOf(node) === "link" : roleOf(node) !== "heading" && roleOf(node) !== "link");
    let allowance = Math.min(remaining, role === "heading" ? 1100 : role === "structure" ? 500 : remaining);
    for (let left = 0, right = group.length - 1; left <= right;) {
      for (const node of left === right ? [group[left++]] : [group[left++], group[right--]]) {
        let cost = 0;
        for (let current: ViewportNode | undefined = node; current && !kept.has(current.nodeId); current = byId.get(current.parentId || "")) {
          if (meaningful(current) || containers.has(current.nodeId)) {
            cost += 88 + Math.min(90, nameOf(current).length) + roleOf(current).length;
            if (containers.has(current.nodeId)) cost += 200;
          }
        }
        if (cost > allowance) continue;
        keepAncestors(node);
        remaining -= cost;
        allowance -= cost;
      }
    }
  }
  const collapsed = new Map<string, { above: number; below: number }>();
  const counted = new Set<string>();
  const countFolded = (node: ViewportNode): { above: number; below: number } => {
    const count = { above: 0, below: 0 };
    if (counted.has(node.nodeId)) return count;
    counted.add(node.nodeId);
    const band = bandFor(node);
    if (!kept.has(node.nodeId) && meaningful(node) && (band === "above" || band === "below")) {
      count[band]++;
      return count; // One folded semantic branch, not its repeated text and nested descendants.
    }
    for (const child of children(node)) {
      const nested = countFolded(child);
      count.above += nested.above;
      count.below += nested.below;
    }
    if (kept.has(node.nodeId) && containers.has(node.nodeId) && (count.above || count.below)) {
      collapsed.set(node.nodeId, count);
      return { above: 0, below: 0 };
    }
    return count;
  };
  for (const node of nodes.filter(node => !node.parentId || !byId.has(node.parentId))) countFolded(node);
  let above = 0, below = 0;
  for (const node of nodes) {
    const band = bandFor(node);
    if (band !== "above" && band !== "below") continue;
    if (kept.has(node.nodeId)) structural.add(node.nodeId);
    else if (band === "above") above += 1;
    else below += 1;
  }
  return { kept, structural, above, below, unmeasured, collapsed };
}

/** Chromium layout snapshot; Firefox batch rects; box models for remaining Chromium gaps. */
export async function readViewportBands(send: CdpCommand, nodes: ViewportNode[], fallbackHeight = 0): Promise<Map<string, Band>> {
  // Match Content's innerHeight band, including pages with horizontal scrollbars.
  let height = fallbackHeight;
  if (!(height > 0)) {
    try {
      const metrics = record(await send("Page.getLayoutMetrics"));
      height = Number(record(metrics.cssLayoutViewport || metrics.layoutViewport).clientHeight);
    } catch { /* Missing viewport geometry fails open below. */ }
  }
  const bands = new Map<string, Band>();
  if (!Number.isFinite(height) || !(height > 0)) return bands;
  const groups = new Map<string, ViewportNode[]>();
  for (const node of nodes) {
    const frameId = node.documentFrameId || "";
    const group = groups.get(frameId) || [];
    group.push(node);
    groups.set(frameId, group);
  }
  for (const [frameId, group] of groups) {
    try {
      const frame = frameId ? await openChildFrame(send, frameId) : null;
      const origin = frameId ? await frameContentOrigin(send, frameId) : { y: 0 };
      if (!origin || (frameId && !frame)) continue;
      const command = frame?.send || send;
      const boxes = new Map<number, [number, number]>();
      try {
        const snapshot = record(await command("DOMSnapshot.captureSnapshot", { computedStyles: [] }));
        const documents = Array.isArray(snapshot.documents) ? snapshot.documents.map(record) : [];
        const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];
        const doc = frameId ? documents.find(doc => strings[Number(doc.frameId)] === frameId) : documents[0];
        if (doc) {
          const backendIds = record(doc.nodes).backendNodeId;
          const layout = record(doc.layout);
          if (Array.isArray(backendIds) && Array.isArray(layout.nodeIndex) && Array.isArray(layout.bounds)) {
            const scrollY = Number(doc.scrollOffsetY) || 0;
            layout.nodeIndex.forEach((index, position) => {
              const rect = (layout.bounds as unknown[])[position];
              if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return;
              const top = Number(rect[1]) - scrollY + origin.y;
              boxes.set(Number(backendIds[Number(index)]), [top, top + Number(rect[3])]);
            });
          }
        }
      } catch { /* Firefox uses the internal batch rect command below. */ }
      {
        // Also resolve boxes omitted by DOMSnapshot (notably input UA-shadow internals).
        // Bound concurrency and deduplicate backend ids. Missing/detached boxes stay unknown.
        const ids = [...new Set(group.map(node => node.backendDOMNodeId).filter((id): id is number => !!id && !boxes.has(id)))];
        // Same-target geometry is already root-relative; child sessions need the iframe origin.
        const offset = frame?.sessionId ? origin.y : 0;
        let batched = false;
        if (ids.length) try {
          const result = record(await command("DOM.getNodeRects", { backendNodeIds: ids }));
          if (Array.isArray(result.rects)) {
            batched = true;
            for (const value of result.rects) {
              const rect = record(value);
              if (![rect.backendNodeId, rect.y, rect.height].every(value => typeof value === "number" && Number.isFinite(value))) continue;
              const top = Number(rect.y) + offset;
              boxes.set(Number(rect.backendNodeId), [top, top + Number(rect.height)]);
            }
          }
        } catch { /* Chromium has no internal batch command. */ }
        let next = batched ? ids.length : 0;
        await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
          while (next < ids.length) {
            const id = ids[next++]!;
            try {
              const model = record(record(await command("DOM.getBoxModel", { backendNodeId: id })).model);
              const quad = model.border;
              if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) continue;
              const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
              boxes.set(id, [Math.min(...ys) + offset, Math.max(...ys) + offset]);
            } catch { /* No layout box. */ }
          }
        }));
      }
      for (const node of group) {
        const box = boxes.get(Number(node.backendDOMNodeId));
        if (box) bands.set(node.nodeId, verticalBand(box[0], box[1], height));
      }
    } catch { /* A detached frame must not discard the main document snapshot. */ }
  }
  return bands;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
