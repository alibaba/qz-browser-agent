import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
import { highlightCode } from "#sdk/sidepanel/dom";
import { prefixLines } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createPageProfiles(helpers: ProfileHelpers) {
  const { pageDisplayTarget, describeToolRun, renderMarkdown } = helpers;

function appendElementProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  if (toolName === "inspect_element") return appendInspectElementProfile(parent, args, result);
  if (["act_on_element", "click_element", "fill_input", "select_element", "scroll_page"].includes(toolName)) {
    return appendElementActionProfile(parent, toolName, args, result);
  }
  const items = Array.isArray(result)
    ? result
    : Array.isArray(data.results) ? data.results
      : Array.isArray(data.elements) ? data.elements
        : null;
  if (items?.length) {
    presentation.appendSlimList(parent, t("element"), items.map(record), item => ({
      title: item.name || item.text || item.title || item.role || item.selector || t("element"),
      subtitle: item.target || item.selector || item.href || item.url || "",
      meta: [
        item.role,
        item.line ? `L${item.line}` : "",
        item.index != null ? `#${item.index}` : "",
        item.visible === false ? t("notVisible") : "",
        item.disabled === true ? "disabled" : "",
      ].filter(Boolean),
    }));
    return true;
  }
  const status = record(result);
  presentation.appendCompactLine(parent, {
    title: status.clicked || status.filled || status.selected || status.message || describeToolRun(toolName, args, result, true),
    subtitle: status.target || args.target || status.selector || args.selector || "",
    meta: [
      pageDisplayTarget(args, status, { maxLength: 36, fallbackToTabId: false }),
      status.text,
      status.index != null ? `#${status.index}` : "",
    ].filter(Boolean),
  });
  return true;
}

function appendInspectElementProfile(parent: HTMLElement, args: Data, result: unknown) {
  const element = record(result);
  const title = elementTitle(element, args, t("element"));
  presentation.appendCompactLine(parent, {
    title,
    subtitle: [element.target || args.target, element.selector || args.selector].filter(Boolean).join(" · "),
    meta: [
      pageDisplayTarget(args, element, { maxLength: 36, fallbackToTabId: false }),
      ...elementStateMeta(element),
    ].filter(Boolean),
  });
  presentation.appendCompactParams(parent, "inspect_element", {
    index: element.index ?? args.index,
    line: element.line,
    rect: formatRect(element.rect),
    clickablePoint: formatPoint(element.clickablePoint),
    form: formatForm(element.form),
  });
  return true;
}

function appendElementActionProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  const evidence = record(record(data._display).elementAction);
  const element = record(evidence.element || data.element);
  const action = data.action || args.action || inferredElementAction(toolName);
  presentation.appendCompactLine(parent, {
    title: elementActionTitle(toolName, action, args, data, element),
    subtitle: data.target || args.target || element.target || data.selector || element.selector || args.selector || "",
    meta: [
      pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false }),
      data.method ? `method ${data.method}` : "",
      data.index != null ? `#${data.index}` : (args.index != null ? `#${args.index}` : ""),
      data.navigated != null ? `navigated ${String(Boolean(data.navigated))}` : "",
      data.newTabOpened != null ? `new tab ${String(Boolean(data.newTabOpened))}` : "",
      data.submitted != null ? `submitted ${String(Boolean(data.submitted))}` : "",
    ].filter(Boolean),
  });

  const structure = evidence.structure ? record(evidence.structure) : richTextStructureFromAction(data);
  if (structure) appendRichTextStructure(parent, structure);
  if (data.confirmationRequired && data.hint) presentation.appendNoteSection(parent, t("message"), data.hint);
  return true;
}

function elementActionTitle(toolName: string, action: unknown, args: Data, data: Data, element: Data) {
  if (data.clicked && data.clicked !== true) return data.clicked;
  if (data.filled && data.filled !== true) return data.filled;
  if (data.selected && data.selected !== true) return data.selected;
  if (data.message) return data.message;
  if (data.navigated && data.href) return t("navigatedToTarget");
  if (action === "fill") return elementTitle(element, args, t("articleContentWritten"));
  if (action === "click") return elementTitle(element, args, t("elementClicked"));
  if (action === "scroll") return t("pageScrolled");
  return describeToolRun(toolName, args, data, true) || elementTitle(element, args, t("elementAction"));
}

function appendArticleCompactProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  if (!result || typeof result !== "object") return false;
  presentation.appendCompactLine(parent, {
    title: data.title || data.url || t("article"),
    subtitle: data.url || data.excerpt || "",
    meta: [
      data.mode || data.source,
      data.text ? t("characters", { count: String(String(data.text).length) }) : "",
      data.totalChars ? t("charactersTotal", { count: String(data.totalChars) }) : "",
      data.hasMore ? `next ${data.nextOffset}` : "",
      data.linkCount ? t("links", { count: String(data.linkCount) }) : "",
    ].filter(Boolean),
  });
  if (data.text) appendArticleBody(parent, data.text, record(data._display).imageDisplayHints);
  return true;
}

function appendArticleBody(parent: HTMLElement, text: unknown, imageDisplayHints: unknown = []) {
  const section = document.createElement("div");
  section.className = "tool-article-body qz-markdown";
  section.dataset.toolScrollSurface = "article";
  const markdown = String(text || "").trim();
  const rendered = typeof renderMarkdown === "function"
    ? renderMarkdown(markdown)
    : presentation.linkifyText(markdown);
  section.innerHTML = sanitizeArticleMarkdownHtml(rendered);
  applyArticleImageDisplayHints(section, imageDisplayHints);
  groupArticleMedia(section);
  parent.appendChild(section);
}

const ARTICLE_MARKDOWN_ALLOWED_TAGS = new Set([
  "A", "ABBR", "ADDRESS", "B", "BLOCKQUOTE", "BR", "BUTTON", "CAPTION", "CODE", "COL", "COLGROUP",
  "DD", "DEL", "DIV", "DL", "DT", "EM", "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "I", "IMG", "LI", "MARK", "OL", "P", "PATH", "PRE", "Q", "RECT", "S", "SMALL", "SPAN", "STRONG",
  "SUB", "SUP", "SVG", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "U", "UL",
]);

const ARTICLE_MARKDOWN_DROP_TAGS = new Set([
  "BASE", "CANVAS", "EMBED", "FORM", "IFRAME", "INPUT", "LINK", "META", "OBJECT", "OPTION", "SCRIPT", "SELECT",
  "SOURCE", "STYLE", "TEMPLATE", "TEXTAREA", "VIDEO", "AUDIO",
]);

const ARTICLE_MARKDOWN_ALLOWED_CLASSES = new Set([
  "code-block", "code-copy-btn", "copyable-code-block", "markdown-code-block", "qz-icon-btn", "qz-icon-btn--xs",
]);

function sanitizeArticleMarkdownHtml(html: unknown) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const elements = [...template.content.querySelectorAll("*")];
  for (const element of elements) {
    const tagName = element.tagName;
    if (!ARTICLE_MARKDOWN_ALLOWED_TAGS.has(tagName)) {
      if (ARTICLE_MARKDOWN_DROP_TAGS.has(tagName)) element.remove();
      else element.replaceWith(...element.childNodes);
      continue;
    }
    sanitizeArticleMarkdownAttributes(element);
  }
  return template.innerHTML;
}

function sanitizeArticleMarkdownAttributes(element: Element) {
  const attributes = new Map([...element.attributes].map(attribute => [attribute.name.toLowerCase(), attribute.value]));
  for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
  const keep = (...names: string[]) => {
    for (const name of names) {
      const value = attributes.get(name);
      if (value) element.setAttribute(name, value);
    }
  };

  const safeClassName = sanitizeArticleMarkdownClassName(attributes.get("class"));
  if (safeClassName && ["BUTTON", "CODE", "DIV", "SPAN"].includes(element.tagName)) {
    element.className = safeClassName;
  }

  if (element.tagName === "A") {
    const href = sanitizeArticleMarkdownUrl(attributes.get("href"), { allowFragment: true });
    if (href) element.setAttribute("href", href);
    keep("title");
    if (href && !href.startsWith("#")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }

  if (element.tagName === "IMG") {
    const src = sanitizeArticleMarkdownUrl(attributes.get("src"), { image: true });
    if (src) element.setAttribute("src", src);
    else element.remove();
    keep("alt");
    keep("title");
    element.setAttribute("loading", "lazy");
    element.setAttribute("referrerpolicy", "no-referrer");
  }

  if (["TH", "TD"].includes(element.tagName)) {
    for (const name of ["abbr", "colspan", "rowspan", "scope"]) {
      keep(name);
    }
  }
  if (["COL", "COLGROUP"].includes(element.tagName) && attributes.get("span")) {
    keep("span");
  }
  if (element.tagName === "OL") {
    for (const name of ["start", "type"]) {
      keep(name);
    }
    if (attributes.has("reversed")) element.setAttribute("reversed", "");
  }
  if (["ABBR", "Q"].includes(element.tagName) && attributes.get("title")) {
    keep("title");
  }

  if (element.tagName === "DIV" && safeClassName.includes("copyable-code-block")) {
    for (const name of ["data-copy-text", "data-language", "data-highlighter"]) {
      keep(name);
    }
  }
  if (element.tagName === "BUTTON" && safeClassName.includes("code-copy-btn")) {
    element.setAttribute("type", "button");
    keep("title");
    keep("aria-label");
  }
  if (element.tagName === "SVG") {
    const viewBox = attributes.get("viewbox");
    if (viewBox) element.setAttribute("viewBox", viewBox);
    keep("fill");
    element.setAttribute("aria-hidden", "true");
  }
  if (element.tagName === "RECT") {
    for (const name of ["x", "y", "width", "height", "rx"]) {
      keep(name);
    }
  }
  if (element.tagName === "PATH") keep("d");
}

function sanitizeArticleMarkdownClassName(value: unknown = "") {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => ARTICLE_MARKDOWN_ALLOWED_CLASSES.has(token)
      || /^hljs(?:-[a-z0-9_-]+)?$/i.test(token)
      || /^language-[a-z0-9_+-]+$/i.test(token))
    .join(" ");
}

function appendCssProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const removed = data.removed || args.remove;
  presentation.appendCompactLine(parent, {
    title: removed ? t("injectedStylesRemoved") : t("stylesInjected"),
    subtitle: "",
    meta: [
      args.css ? `length ${String(args.css).length}` : "",
      pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false }),
      data.length != null ? `length ${data.length}` : "",
      data.changed != null ? `changed ${data.changed}` : "",
    ].filter(Boolean),
  });
  if (args.css && !removed) presentation.appendTextSection(parent, "CSS", prefixLines(args.css, "+ "));
  if (data.message) presentation.appendNoteSection(parent, t("message"), data.message);
  return true;
}

function appendModifyDomProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const operations = Array.isArray(args.operations) ? args.operations : [];
  const rows = Array.isArray(data.results) ? data.results : [];
  const changed = rows.reduce((sum, item) => sum + (Number(item?.count) || Number(item?.changed) || 0), 0);
  const failed = rows.filter(item => item?.error || item?.code).length;
  presentation.appendCompactLine(parent, {
    title: t("domUpdated"),
    subtitle: [
      t("operations", { count: String(data.operations ?? operations.length ?? rows.length) }),
      `${changed || data.changed || 0} changed`,
      `${failed} failed`,
    ].filter(Boolean).join(" · "),
    meta: [
      pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false }),
    ].filter(Boolean),
  });
  const displayRows = rows.length ? rows : operations.map(item => ({ ...item, count: "" }));
  if (displayRows.length) {
    presentation.appendSlimList(parent, t("action"), displayRows, item => ({
      title: `${presentation.fieldLabel(item.action || t("action"))} · ${item.selector || ""}`.trim(),
      subtitle: [
        item.count != null && item.count !== "" ? `changed ${item.count}` : "",
        item.value ? presentation.summarizeValue(item.value, 140) : "",
        item.error || item.message || "",
      ].filter(Boolean).join(" · "),
      meta: [item.code].filter(Boolean),
    }));
  } else if (data.message) {
    presentation.appendNoteSection(parent, t("message"), data.message);
  }
  return true;
}

function inferredElementAction(toolName: string) {
  if (toolName === "click_element") return "click";
  if (toolName === "fill_input") return "fill";
  if (toolName === "select_element") return "select";
  if (toolName === "scroll_page") return "scroll";
  return "";
}

function richTextStructureFromAction(data: Data = {}) {
  const fill = record(data.fill);
  const richText = record(fill.richText);
  const structure = richText?.structure || fill.structure || record(data.richText).structure;
  return structure && typeof structure === "object" ? record(structure) : null;
}

function appendRichTextStructure(parent: HTMLElement, structure: Data = {}) {
  presentation.appendStatGrid(parent, [
    { value: structure.lineBreakCount, label: t("wrapLines") },
    { value: structure.paragraphCount, label: "p" },
    { value: structure.brCount, label: "br" },
    { value: structure.blockCount, label: "block" },
  ]);
  if (structure.htmlSample) presentation.appendTextSection(parent, t("domStructure"), structure.htmlSample);
  const passed = (Number(structure.paragraphCount) || 0) > 1
    || (Number(structure.brCount) || 0) > 0
    || (Number(structure.blockCount) || 0) > 1;
  presentation.appendChipRow(parent, [
    t("domValidation", { status: String(passed ? t("passed") : t("failed")) }),
    `single paragraph ${passed ? "false" : "true"}`,
  ]);
}

function elementTitle(element: Data = {}, args: Data = {}, fallback = t("element")) {
  return presentation.firstNonEmpty([
    element.name,
    element.text,
    element.title,
    element.placeholder,
    element.target,
    args.target,
    args.selector,
    element.selector,
    fallback,
  ]);
}

function elementStateMeta(element: Data = {}) {
  return [
    element.role,
    element.visible != null ? `visible ${String(Boolean(element.visible))}` : "",
    element.disabled != null ? `enabled ${String(!element.disabled)}` : "",
    element.inViewport != null ? `viewport ${String(Boolean(element.inViewport))}` : "",
    element.obscuredAtCenter != null ? `obscured ${String(Boolean(element.obscuredAtCenter))}` : "",
    element.index != null ? `#${element.index}` : "",
  ].filter(Boolean);
}

function formatRect(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const rect = record(value);
  const width = rect.width ?? rect.w;
  const height = rect.height ?? rect.h;
  const top = rect.top ?? rect.y;
  if (width == null && height == null && top == null) return "";
  return [
    width != null && height != null ? `${Math.round(Number(width))} x ${Math.round(Number(height))}` : "",
    top != null ? `top ${Math.round(Number(top))}` : "",
  ].filter(Boolean).join(" · ");
}

function formatPoint(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const point = record(value);
  const x = point.x ?? point.clientX;
  const y = point.y ?? point.clientY;
  return x != null && y != null ? `${Math.round(Number(x))}, ${Math.round(Number(y))}` : "";
}

function formatForm(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const form = record(value);
  return [form.selector || form.id || form.name, form.method, form.action].filter(Boolean).join(" · ");
}

function applyArticleImageDisplayHints(root: HTMLElement, hints: unknown) {
  const imageIdentity = (value: string) => {
    try {
      const url = new URL(value, location.href);
      return `${url.origin}${url.pathname}`;
    } catch (_err) {
      return "";
    }
  };
  const bySource = new Map();
  const byIdentity = new Map();
  for (const hint of Array.isArray(hints) ? hints : []) {
    const src = sanitizeArticleMarkdownUrl(hint?.src, { image: true });
    const width = Math.round(Number(hint?.width) || 0);
    const height = Math.round(Number(hint?.height) || 0);
    if (!src || width <= 0 || height <= 0) continue;
    bySource.set(src, true);
    byIdentity.set(imageIdentity(src), true);
  }
  for (const image of root.querySelectorAll("img")) {
    const imageUrl = new URL(image.src, location.href);
    const semanticCompact = /(?:^|[./_-])(?:avatars?|userpics?|user-avatar|profile-image|icons?|badges?|emoji)(?:[./?_-]|$)/i
      .test(`${imageUrl.hostname}${imageUrl.pathname}`);
    if (!semanticCompact && !bySource.has(image.src) && !byIdentity.has(imageIdentity(image.src))) continue;
    const link = image.parentElement?.tagName === "A" && image.parentElement.textContent.trim() === ""
      ? image.parentElement
      : null;
    (link || image).remove();
  }
  for (const block of root.querySelectorAll("p")) {
    if (!block.textContent.trim() && !block.querySelector("img,video,table")) block.remove();
  }
}

function groupArticleMedia(root: HTMLElement) {
  let run: { block: Element; items: Element[] }[] = [];
  const flush = () => {
    if (!run.length) return;
    const items = run.flatMap(entry => entry.items);
    const grid = document.createElement("div");
    grid.className = "tool-article-media-grid";
    grid.dataset.count = String(Math.min(items.length, 3));
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", t("articleImages", { count: String(items.length) }));
    run[0].block.before(grid);
    for (const item of items) {
      const cell = document.createElement("div");
      cell.className = "tool-article-media-item";
      cell.appendChild(item);
      grid.appendChild(cell);
    }
    for (const entry of run) entry.block.remove();
    run = [];
  };

  for (const block of [...root.children]) {
    const items = articleMediaItems(block);
    if (items) run.push({ block, items });
    else flush();
  }
  flush();
}

function articleMediaItems(block: Element) {
  const nodes = block.tagName === "P" ? [...block.childNodes] : [block];
  const items: Element[] = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent || "").trim()) continue;
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR") continue;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if ((node as Element).tagName === "IMG") {
      items.push(node as Element);
      continue;
    }
    if ((node as Element).tagName === "A" && articleLinkedImage(node as Element)) {
      items.push(node as Element);
      continue;
    }
    return null;
  }
  return items.length ? items : null;
}

function articleLinkedImage(link: Element) {
  const images = [...link.children].filter(child => child.tagName === "IMG");
  if (images.length !== 1) return false;
  return [...link.childNodes].every(node => (
    (node.nodeType === Node.TEXT_NODE && !(node.textContent || "").trim())
    || (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "IMG")
  ));
}

function sanitizeArticleMarkdownUrl(value: unknown = "", { allowFragment = false, image = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (allowFragment && /^#[^\s<>'"]+$/u.test(raw)) return raw;
  try {
    const url = new URL(raw, location.href);
    const protocols = image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"];
    return protocols.includes(url.protocol) ? url.href : "";
  } catch (_err) {
    return "";
  }
}

function appendDomRawProfile(parent: HTMLElement, args: Data = {}, result: unknown = {}) {
  const data = record(result);
  const content = data.content || data.html || data.dom || data.text || "";
  presentation.appendCompactLine(parent, {
    title: data.title || args.selector || t("htmlSnippet"),
    subtitle: data.url || args.url || "",
    meta: [
      args.selector ? t("range", { range: String(presentation.summarizeValue(args.selector, 48)) }) : "",
      data.showing ? t("line", { line: String(data.showing) }) : "",
      data.totalLines ? t("linesTotal", { count: String(data.totalLines) }) : "",
      data.hasMore ? t("moreContentAvailable") : "",
    ].filter(Boolean),
  });
  if (content) appendDomRawContent(parent, content);
  else presentation.appendNoteSection(parent, t("content"), t("noDomContentReturned"));
  return true;
}

function appendDomRawContent(parent: HTMLElement, content: unknown) {
  const text = String(content || "");
  const section = document.createElement("div");
  section.className = "tool-detail-section tool-dom-content-section";
  const labelEl = document.createElement("div");
  labelEl.className = "tool-detail-label";
  labelEl.textContent = t("domSnippet");
  const pre = document.createElement("pre");
  const highlighted = highlightCode(text, "html", { autoDetect: false });
  pre.className = "code-block tool-dom-content-block hljs language-html";
  pre.innerHTML = highlighted.html;
  section.append(labelEl, presentation.createCopyableCodeBlock(pre, text));
  parent.appendChild(section);
}

  return { renderElement: appendElementProfile, renderArticle: appendArticleCompactProfile, renderCss: appendCssProfile, renderDomMutation: appendModifyDomProfile, renderDomRaw: appendDomRawProfile };
}
