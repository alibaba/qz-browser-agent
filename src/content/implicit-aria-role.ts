/**
 * HTML-AAM implicit roles for find_elements.
 * The first valid explicit role token wins. Generic elements and elements with
 * no corresponding role stay empty, matching the previous empty role field.
 */

interface RoleNode {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement: unknown;
  children?: ArrayLike<unknown>;
  isContentEditable?: boolean;
  multiple?: boolean;
  size?: number;
  ownerDocument?: {
    getElementById?(id: string): { textContent?: string | null } | null;
  } | null;
}

const ROLE_TOKENS = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption",
  "cell", "checkbox", "code", "columnheader", "combobox", "comment", "complementary", "contentinfo",
  "definition", "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form",
  "generic", "graphics-document", "graphics-object", "graphics-symbol", "grid", "gridcell", "group",
  "heading", "image", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main",
  "marquee", "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio",
  "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar", "radio",
  "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox",
  "sectionfooter", "sectionheader", "separator", "slider", "spinbutton", "status", "strong",
  "subscript", "suggestion", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term",
  "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
  "doc-abstract", "doc-acknowledgments", "doc-afterword", "doc-appendix", "doc-backlink",
  "doc-biblioentry", "doc-bibliography", "doc-biblioref", "doc-chapter", "doc-colophon",
  "doc-conclusion", "doc-cover", "doc-credit", "doc-credits", "doc-dedication", "doc-endnote",
  "doc-endnotes", "doc-epigraph", "doc-epilogue", "doc-errata", "doc-example", "doc-footnote",
  "doc-foreword", "doc-glossary", "doc-glossref", "doc-index", "doc-introduction", "doc-noteref",
  "doc-notice", "doc-pagebreak", "doc-pagelist", "doc-part", "doc-preface", "doc-prologue",
  "doc-pullquote", "doc-qna", "doc-subtitle", "doc-tip", "doc-toc",
]);

const STATIC_ROLES: Record<string, string> = {
  address: "group",
  article: "article",
  aside: "complementary",
  blockquote: "blockquote",
  button: "button",
  caption: "caption",
  code: "code",
  datalist: "listbox",
  del: "deletion",
  details: "group",
  dfn: "term",
  dialog: "dialog",
  em: "emphasis",
  fieldset: "group",
  figure: "figure",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  hgroup: "group",
  hr: "separator",
  ins: "insertion",
  main: "main",
  math: "math",
  menu: "list",
  meter: "meter",
  nav: "navigation",
  ol: "list",
  optgroup: "group",
  option: "option",
  output: "status",
  p: "paragraph",
  progress: "progressbar",
  s: "deletion",
  search: "search",
  strong: "strong",
  sub: "subscript",
  sup: "superscript",
  table: "table",
  textarea: "textbox",
  time: "time",
  ul: "list",
};

const SECTIONING_TAGS = new Set(["article", "aside", "main", "nav", "section"]);
const SECTIONING_ROLES = new Set(["article", "complementary", "main", "navigation", "region"]);
const UNMAPPED_INPUT_TYPES = new Set(["hidden", "color", "date", "datetime-local", "month", "time", "week"]);

export function elementAriaRole(el: RoleNode): string {
  return explicitRole(el) || implicitRole(el);
}

function explicitRole(el: RoleNode): string {
  const raw = el.getAttribute("role");
  if (!raw) return "";
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    if (ROLE_TOKENS.has(token)) return token;
  }
  return "";
}

function implicitRole(el: RoleNode): string {
  const name = tag(el);
  if (name === "a" || name === "area") return el.hasAttribute("href") ? "link" : "";
  if (name === "img") return imgRole(el);
  if (name === "input") return inputRole(el);
  if (name === "select") return selectRole(el);
  if (name === "li") return listItemRole(el);
  if (name === "header" || name === "footer") return landmarkRole(el, name);
  if (name === "section") return hasAccessibleName(el) ? "region" : "";
  if (name === "summary") return summaryRole(el);
  if (name === "td" || name === "th" || name === "tr" || name === "thead" || name === "tbody" || name === "tfoot") {
    return tablePartRole(el, name);
  }
  if (STATIC_ROLES[name]) return STATIC_ROLES[name];
  if (el.isContentEditable === true) return "textbox";
  return "";
}

function imgRole(el: RoleNode): string {
  const alt = el.hasAttribute("alt") ? el.getAttribute("alt") || "" : null;
  // Empty alt, including whitespace-only alt, is presentation unless another name exists.
  if (alt !== null && !alt.trim() && !hasAccessibleName(el)) return "presentation";
  return "img";
}

function inputRole(el: RoleNode): string {
  const type = (el.getAttribute("type") || "text").trim().toLowerCase() || "text";
  if (type === "file") return "button";
  if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
  if (type === "checkbox" || type === "radio") return type;
  if (type === "range") return "slider";
  if (type === "number") return "spinbutton";
  if (UNMAPPED_INPUT_TYPES.has(type)) return "";
  // Password has no HTML-AAM role; Chrome exposes it as a textbox.
  if (type === "password") return "textbox";
  if (el.hasAttribute("list")) return "combobox";
  if (type === "search") return "searchbox";
  return "textbox";
}

function selectRole(el: RoleNode): string {
  if (el.multiple === true || el.hasAttribute("multiple")) return "listbox";
  const size = Number(el.size ?? el.getAttribute("size") ?? 0);
  return Number.isFinite(size) && size > 1 ? "listbox" : "combobox";
}

function listItemRole(el: RoleNode): string {
  const owner = parent(el);
  if (!owner) return "";
  const explicit = explicitRole(owner);
  if (explicit) return explicit === "list" ? "listitem" : "";
  const ownerTag = tag(owner);
  return ownerTag === "ul" || ownerTag === "ol" || ownerTag === "menu" ? "listitem" : "";
}

function landmarkRole(el: RoleNode, name: "header" | "footer"): string {
  // Nested header/footer are section landmarks; top-level ones are banner/contentinfo.
  if (inSectioningContent(el)) return name === "header" ? "sectionheader" : "sectionfooter";
  return name === "header" ? "banner" : "contentinfo";
}

function summaryRole(el: RoleNode): string {
  const owner = parent(el);
  if (!owner || tag(owner) !== "details") return "";
  const summaries = elementChildren(owner).filter(child => tag(child) === "summary");
  return summaries[0] === el ? "button" : "";
}

function tablePartRole(el: RoleNode, name: string): string {
  const context = tableContext(el);
  if (!context) return "";
  if (name === "tr") return "row";
  if (name === "thead" || name === "tbody" || name === "tfoot") return "rowgroup";
  if (name === "td") return context === "table" ? "cell" : "gridcell";
  const kind = headerKind(el);
  if (kind === "row") return "rowheader";
  if (kind === "col") return "columnheader";
  return context === "table" ? "cell" : "gridcell";
}

function tableContext(el: RoleNode): "table" | "grid" | "treegrid" | "" {
  const table = ancestors(el).find(item => tag(item) === "table");
  if (!table) return "";
  const role = explicitRole(table) || "table";
  if (role === "table" || role === "grid" || role === "treegrid") return role;
  return "";
}

function headerKind(el: RoleNode): "row" | "col" | "" {
  const scope = (el.getAttribute("scope") || "").trim().toLowerCase();
  if (scope === "row" || scope === "rowgroup") return "row";
  if (scope === "col" || scope === "colgroup") return "col";
  if (ancestors(el).some(item => tag(item) === "thead")) return "col";
  const row = parent(el);
  if (!row || tag(row) !== "tr") return "";
  const table = ancestors(el).find(item => tag(item) === "table");
  const firstRow = table ? firstDescendant(table, item => tag(item) === "tr") : null;
  if (firstRow === row) return "col";
  const cells = elementChildren(row).filter(child => tag(child) === "th" || tag(child) === "td");
  if (cells[0] === el) return "row";
  return "";
}

function inSectioningContent(el: RoleNode): boolean {
  return ancestors(el).some(item => SECTIONING_TAGS.has(tag(item)) || SECTIONING_ROLES.has(explicitRole(item)));
}

function hasAccessibleName(el: RoleNode): boolean {
  if ((el.getAttribute("aria-label") || "").trim()) return true;
  if ((el.getAttribute("title") || "").trim()) return true;
  const ids = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
  const lookup = el.ownerDocument?.getElementById;
  if (!ids.length || typeof lookup !== "function") return false;
  return ids.some(id => (lookup.call(el.ownerDocument, id)?.textContent || "").trim().length > 0);
}

function tag(el: RoleNode): string {
  return el.tagName.toLowerCase();
}

function parent(el: RoleNode): RoleNode | null {
  return asNode(el.parentElement);
}

function ancestors(el: RoleNode): RoleNode[] {
  const list: RoleNode[] = [];
  const seen = new Set<RoleNode>();
  let current = parent(el);
  while (current && !seen.has(current)) {
    seen.add(current);
    list.push(current);
    current = parent(current);
  }
  return list;
}

function elementChildren(el: RoleNode): RoleNode[] {
  const children = el.children;
  if (!children) return [];
  const list: RoleNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = asNode(children[index]);
    if (child) list.push(child);
  }
  return list;
}

function firstDescendant(el: RoleNode, predicate: (node: RoleNode) => boolean): RoleNode | null {
  const stack = elementChildren(el);
  const seen = new Set<RoleNode>();
  while (stack.length) {
    const current = stack.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (predicate(current)) return current;
    stack.unshift(...elementChildren(current));
  }
  return null;
}

function asNode(value: unknown): RoleNode | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as RoleNode;
  if (typeof candidate.tagName !== "string" || typeof candidate.getAttribute !== "function" || typeof candidate.hasAttribute !== "function") return null;
  return candidate;
}
