import { t, tHtml } from "../../i18n/index.js";
import * as presentation from "../generic-result-renderer.js";
import { escapeHtml } from "../../ui/ui-utils.js";
import { record } from "../renderer-input.js";
type Data = Record<string, unknown>;
interface TreeLine { depth: number; text: unknown; meta: unknown; index?: number; hasChildren?: boolean }

export function createTreeRenderer() {
let indentUnit = 2;

function render(parent: HTMLElement, args: Data, value: unknown, options: { title?: string; appendDetails?(parent: HTMLElement, result: Data): void } = {}) {
  if (!value || typeof value !== "object") return false;
  const result = record(value);
  const section = document.createElement("div");
  section.className = "tool-tree-panel";
  const title = result.title || result.url || options.title || t("tree");
  const url = result.url || result._pageUrl || args.url || "";
  const stats = formatPageTreeStats(result);
  const lines = buildTreeLines(result);
  const lineModels = lines.map((line, index) => ({
    ...line,
    index,
    hasChildren: (Number(lines[index + 1]?.depth) || 0) > (Number(line.depth) || 0),
  }));
  section.innerHTML = `
    <div class="tool-tree-head">
      <div class="tool-tree-title">${escapeHtml(presentation.summarizeValue(title, 180))}</div>
      ${url ? `<div class="tool-tree-url">${presentation.linkifyText(presentation.summarizeValue(url, 520))}</div>` : ""}
      ${stats ? `<div class="tool-tree-stats">${escapeHtml(stats)}</div>` : ""}
    </div>
    ${lineModels.length ? `<div class="tool-tree-body" data-tool-scroll-surface="tree">${lineModels.map(renderTreeLine).join("")}</div>` : ""}
  `;
  options.appendDetails?.(section, result);
  parent.appendChild(section);
  installToolTreeDisclosure(section);
  return true;
}

function formatPageTreeStats(result: Data = {}) {
  const items = [
    result.depth ? t("treeDepth", { depth: String(result.depth) }) : "",
    result.nodeCount ? t("nodeCount", { count: String(result.nodeCount) }) : (result.totalLines ? t("rowCount", { count: String(result.totalLines) }) : ""),
    result.returnedNodeCount ? t("displayedCount", { count: String(result.returnedNodeCount) }) : "",
    result.truncatedNodeCount ? t("truncatedCount", { count: String(result.truncatedNodeCount) }) : "",
  ].filter(Boolean);
  return items.join("，");
}

function buildTreeLines(result: Data): TreeLine[] {
  indentUnit = 2;
  const display = record(result._display);
  if (Array.isArray(display.tree) && display.tree.length) {
    const lines: TreeLine[] = [];
    display.tree.forEach(node => flattenDisplayTreeNode(node, 0, lines));
    return lines.slice(0, 160);
  }
  if (Array.isArray(display.nodes) && display.nodes.length) {
    return display.nodes.slice(0, 160).map(node => treeLineFromSnapshotNode(node));
  }
  if (Array.isArray(result.nodes)) {
    return result.nodes.slice(0, 160).map(node => treeLineFromSnapshotNode(node));
  }
  if (Array.isArray(result.lines)) {
    return result.lines.slice(0, 80).map((line, index) => ({
      depth: 0,
      text: typeof line === "string" ? line : (line.text || line.html || JSON.stringify(line)),
      meta: line.line ? `L${line.line}` : `L${(Number(result.offset) || 1) + index}`,
    }));
  }
  const outline = result.snapshot || result.outline || result.tree || result.text || result.html || "";
  const outlineText = String(outline || "");
  if (/\btarget=uid:t\d+\./.test(outlineText)) indentUnit = 1;
  return outlineText
    .split("\n")
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(0, 80)
    .map(treeLineFromSnapshotText);
}

function flattenDisplayTreeNode(value: unknown, depth: number, lines: TreeLine[]) {
  if (!value || typeof value !== "object") return;
  const node = record(value);
  lines.push(treeLineFromSnapshotNode({ ...node, depth }));
  for (const child of Array.isArray(node.children) ? node.children : []) {
    flattenDisplayTreeNode(child, depth + 1, lines);
  }
}

function treeLineFromSnapshotNode(value: unknown): TreeLine {
  const node = record(value);
  return {
    depth: Math.min(12, Number(node.depth || node.level || 0) || 0),
    text: formatTreeNodeText(node),
    meta: formatTreeNodeMeta(node),
  };
}

function treeLineFromSnapshotText(line: unknown): TreeLine {
  const raw = String(line || "").trimEnd();
  const trimmed = raw.trim();
  const targetMatch = trimmed.match(/\btarget=(uid:[^\s]+|css:[^\s]+)/);
  const meta = [
    targetMatch?.[1],
  ].filter(Boolean).join(" · ");
  const text = trimmed
    .replace(/\btarget=(uid:[^\s]+|css:[^\s]+)\s*/g, "")
    .replace(/\s#\d+\s*$/g, "")
    .trim();
  return {
    depth: Math.min(16, Math.floor((raw.match(/^\s*/)?.[0].length || 0) / indentUnit)),
    text: text || targetMatch?.[1] || "node",
    meta,
  };
}

function formatTreeNodeText(node: Data = {}) {
  const role = node.role ? `[${node.role}]` : "";
  const name = presentation.firstNonEmpty([node.name, node.text, node.value, node.placeholder, node.title]);
  const value = node.value && node.value !== name ? ` value="${presentation.summarizeValue(node.value, 80)}"` : "";
  const label = name ? `"${presentation.summarizeValue(name, 120)}"` : "";
  return [role, label, value].filter(Boolean).join(" ") || node.target || node.selector || "node";
}

function formatTreeNodeMeta(node: Data = {}) {
  const flags = Array.isArray(node.flags) ? node.flags : [];
  return [
    node.target ? presentation.summarizeValue(node.target, 48) : "",
    node.url || node.href ? presentation.summarizeValue(node.url || node.href, 90) : "",
    node.selector ? presentation.summarizeValue(node.selector, 90) : "",
    ...flags.slice(0, 3),
  ].filter(Boolean).join(" · ");
}

function renderTreeLine(line: TreeLine) {
  const depth = Math.max(0, Number(line.depth) || 0);
  const toggle = line.hasChildren
    ? `<button class="qz-tree-toggle tool-tree-toggle" type="button" aria-expanded="true" title="${tHtml("toggleExpanded")}">▾</button>`
    : `<span class="tool-tree-toggle-spacer"></span>`;
  return `
    <div class="tool-tree-line" data-tree-index="${line.index}" data-depth="${depth}" data-expanded="true" data-has-children="${line.hasChildren ? "true" : "false"}" style="--depth:${depth}">
      ${toggle}
      <span class="tool-tree-text">${escapeHtml(presentation.summarizeValue(line.text, 220))}</span>
      ${line.meta ? `<span class="tool-tree-line-meta">${escapeHtml(presentation.summarizeValue(line.meta, 80))}</span>` : ""}
    </div>
  `;
}

function installToolTreeDisclosure(section: HTMLElement) {
  const lines = Array.from(section.querySelectorAll<HTMLElement>(".tool-tree-line"));
  if (!lines.length) return;
  section.querySelectorAll(".tool-tree-toggle").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const row = button.closest<HTMLElement>(".tool-tree-line");
      if (!row) return;
      const expanded = row.dataset.expanded !== "false";
      row.dataset.expanded = expanded ? "false" : "true";
      button.textContent = expanded ? "▸" : "▾";
      button.setAttribute("aria-expanded", expanded ? "false" : "true");
      updateToolTreeVisibility(lines);
    });
  });
}

function updateToolTreeVisibility(lines: HTMLElement[]) {
  const collapsedDepths: number[] = [];
  for (const line of lines) {
    const depth = Number(line.dataset.depth) || 0;
    while (collapsedDepths.length && collapsedDepths[collapsedDepths.length - 1] >= depth) {
      collapsedDepths.pop();
    }
    const hidden = collapsedDepths.length > 0;
    line.classList.toggle("tool-tree-line-hidden", hidden);
    if (!hidden && line.dataset.hasChildren === "true" && line.dataset.expanded === "false") {
      collapsedDepths.push(depth);
    }
  }
}

  return { render };
}
