/** Main-branch get_ax_tree payload at 7b5cef4, kept here so the comparison does not depend on git show. */

function clean(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function compactNode(node) {
  const props = {};
  for (const prop of node.properties || []) {
    if (prop?.name) props[prop.name] = prop.value?.value;
  }
  const flag = (key, value) => {
    if (value == null) return "";
    if (key === "expanded") return value ? "expanded" : "collapsed";
    if (key === "checked") return value === true ? "checked" : value === false ? "unchecked" : String(value);
    if (value === false) return "";
    return value === true ? key : `${key}=${clean(value)}`;
  };
  return {
    nodeId: node.nodeId,
    backendNodeId: node.backendDOMNodeId,
    ignored: !!node.ignored,
    role: clean(node.role?.value),
    name: clean(node.name?.value),
    description: clean(node.description?.value),
    value: clean(node.value?.value),
    url: clean(props.url),
    flags: ["focused", "disabled", "expanded", "checked", "selected", "editable", "readonly", "required"].map(key => flag(key, props[key])).filter(Boolean),
  };
}

function keepNode(node, depth) {
  if (!node) return false;
  if (depth === 0) return true;
  if (node.ignored) return false;
  const role = String(node.role || "");
  const hasContent = !!(node.name || node.value || node.description || node.url || node.flags?.length);
  if ((role === "none" || role === "generic") && !hasContent) return false;
  if (!role && !hasContent) return false;
  return true;
}

function buildTree(rawNodes, limit, maxDepth = 16) {
  const nodeMap = new Map();
  for (const node of rawNodes || []) if (node?.nodeId) nodeMap.set(node.nodeId, node);
  const roots = [...nodeMap.values()].filter(node => !node.parentId || !nodeMap.has(node.parentId));
  const semanticRoots = [];
  const semanticNodes = [];
  const build = (rawNode, depth, parentNode) => {
    if (!rawNode) return;
    const compact = compactNode(rawNode);
    const keep = keepNode(compact, depth);
    let nextDepth = depth;
    let nextParent = parentNode;
    if (keep) {
      const semantic = { compact, depth, parent: parentNode, children: [] };
      semanticNodes.push(semantic);
      if (parentNode) parentNode.children.push(semantic);
      else semanticRoots.push(semantic);
      nextDepth = depth + 1;
      nextParent = semantic;
    }
    if (nextDepth >= maxDepth) return;
    for (const childId of rawNode.childIds || []) build(nodeMap.get(childId), nextDepth, nextParent);
  };
  for (const root of roots) build(root, 0, null);
  const included = new Set();
  const queue = semanticRoots.slice();
  const maxNodes = Math.max(0, Number(limit) || 0);
  for (let index = 0; index < queue.length && included.size < maxNodes; index += 1) {
    const node = queue[index];
    if (!node || included.has(node)) continue;
    included.add(node);
    for (const child of node.children || []) queue.push(child);
  }
  return { semanticRoots, semanticNodes, included };
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "a") return "link";
  if (value === "input" || value === "textarea") return "textbox";
  return value;
}

function score(action, node) {
  let total = 0;
  const href = clean(action.href);
  const url = clean(node.url);
  const actionRole = normalizeRole(action.role);
  const nodeRole = normalizeRole(node.role);
  const actionText = clean(action.name || action.text || action.value || action.placeholder);
  const nodeText = clean(node.name || node.value);
  if (href && url && (href.split("#")[0] === url.split("#")[0] || href.startsWith(url) || url.startsWith(href))) total += 5;
  if (actionRole && nodeRole && actionRole === nodeRole) total += 2;
  if (actionText && nodeText) {
    if (actionText === nodeText) total += 4;
    else if (actionText.includes(nodeText) || nodeText.includes(actionText)) total += 2;
  }
  return total;
}

function lineFor(node) {
  const attrs = node.target ? [`target=${node.target}`] : [];
  if (node.role) attrs.push(node.role);
  if (node.name) attrs.push(`"${truncate(node.name, 90)}"`);
  if (node.value && node.value !== node.name) attrs.push(`value="${truncate(node.value, 80)}"`);
  if (node.url) attrs.push(`url="${truncate(node.url, 120)}"`);
  for (const flag of node.flags || []) attrs.push(flag);
  if (node.truncated) attrs.push("(truncated)");
  return `${"  ".repeat(Math.max(0, Number(node.depth) || 0))}${attrs.join(" ")}`;
}

function compactActions(actions) {
  return (actions || []).map((action, index) => {
    const next = {
      i: Number.isFinite(Number(action?.i)) ? Number(action.i) : index,
      target: action?.target || "",
      role: truncate(action?.role, 40),
      type: truncate(action?.type, 40),
      name: truncate(action?.name, 100),
      text: truncate(action?.text, 120),
      textLength: Number.isFinite(Number(action?.textLength)) && Number(action.textLength) > 0 ? Number(action.textLength) : undefined,
      value: truncate(action?.value, 80),
      placeholder: truncate(action?.placeholder, 80),
      href: truncate(action?.href, 160),
      disabled: action?.disabled ? true : undefined,
      editable: action?.editable ? true : undefined,
      checked: typeof action?.checked === "boolean" ? action.checked : undefined,
      accept: truncate(action?.accept, 120),
      multiple: action?.multiple ? true : undefined,
      selectedFileCount: Number.isFinite(Number(action?.selectedFileCount)) ? Number(action.selectedFileCount) : undefined,
      inViewport: typeof action?.inViewport === "boolean" ? action.inViewport : undefined,
      rect: action?.rect && typeof action.rect === "object" ? action.rect : undefined,
    };
    for (const key of Object.keys(next)) if (next[key] == null || next[key] === "") delete next[key];
    return next;
  });
}

function projectActions(actions) {
  return actions.map(action => {
    const next = {
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
    };
    for (const key of Object.keys(next)) if (next[key] == null || next[key] === "") delete next[key];
    return next;
  });
}

function compactHeadings(headings) {
  return (headings || [])
    .map(heading => ({
      level: Number.isFinite(Number(heading?.level)) ? Number(heading.level) : null,
      text: truncate(heading?.text, 160),
    }))
    .filter(heading => heading.text);
}

function compactCanvases(canvases) {
  return (canvases || []).slice(0, 8).map(canvas => {
    const rect = canvas?.rect && typeof canvas.rect === "object"
      ? { x: Number(canvas.rect.x), y: Number(canvas.rect.y), w: Number(canvas.rect.w), h: Number(canvas.rect.h) }
      : null;
    if (!rect || !Object.values(rect).every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return null;
    const next = {
      name: truncate(canvas?.name, 160),
      rect,
      inViewport: typeof canvas?.inViewport === "boolean" ? canvas.inViewport : undefined,
      bitmapSize: Number.isFinite(Number(canvas?.bitmapSize?.width)) && Number.isFinite(Number(canvas?.bitmapSize?.height))
        ? { width: Number(canvas.bitmapSize.width), height: Number(canvas.bitmapSize.height) }
        : undefined,
    };
    for (const key of Object.keys(next)) if (next[key] == null || next[key] === "") delete next[key];
    return next;
  }).filter(Boolean);
}

/** Returns the model-facing JSON object produced by get_ax_tree on main. */
export function buildLegacyModelResult({
  rawNodes, actions = [], headings = [], canvases = [], tabId, pageUrl = "", title = "", viewport, snapshotId, limit = 120, depth = 16,
}) {
  const { semanticRoots, semanticNodes, included } = buildTree(rawNodes, limit, depth);
  const display = [];
  let counter = 0;
  const emit = (semantic, parentUid) => {
    if (!included.has(semantic)) return;
    const compact = semantic.compact;
    const uid = `${snapshotId}_${counter++}`;
    const item = {
      uid,
      target: `uid:${uid}`,
      depth: semantic.depth,
      role: compact.role,
      name: compact.name,
      value: compact.value,
      url: compact.url,
      flags: compact.flags,
      truncated: semantic.children.some(child => !included.has(child)),
    };
    if (parentUid) item.parentUid = parentUid;
    display.push(item);
    for (const child of semantic.children) emit(child, uid);
  };
  for (const root of semanticRoots) emit(root, null);
  const used = new Set();
  const linked = (actions || []).map((action, index) => {
    let best = null;
    let bestScore = 0;
    for (const node of display) {
      if (!node?.uid || used.has(node.uid)) continue;
      const next = score(action, node);
      if (next > bestScore) { best = node; bestScore = next; }
    }
    const matched = bestScore >= 3 ? best : null;
    const uid = matched?.uid || `${snapshotId}_a${index}`;
    used.add(uid);
    return { ...action, uid, target: `uid:${uid}` };
  });
  const snapshot = display.map(lineFor).join("\n");
  const truncatedNodeCount = Math.max(0, semanticNodes.length - display.length);
  const payload = {
    tabId,
    title,
    url: pageUrl,
    viewport,
    snapshotId,
    root: "root",
    rootFound: true,
    depth,
    nodeCount: rawNodes?.length || 0,
    semanticNodeCount: semanticNodes.length,
    returnedNodeCount: display.length,
    outlineTruncated: truncatedNodeCount > 0,
    snapshot,
    headings: compactHeadings(headings),
    actions: projectActions(compactActions(linked)),
    canvases: compactCanvases(canvases),
  };
  return {
    payload,
    truncatedNodeCount,
    outOfTreeActions: linked.filter(action => /_a\d+$/.test(action.uid)).length,
    returnedNodeCount: display.length,
  };
}
