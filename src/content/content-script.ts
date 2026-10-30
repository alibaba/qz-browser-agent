import { elementAriaRole } from "./implicit-aria-role.js";
import { refreshContentLanguage, t } from "./i18n.js";
import { documentReadiness } from "../shared/document-readiness.js";
import { normalizeImage } from "../shared/images/normalize.js";
import { assertImageDimensions, IMAGE_MAX_EDGE } from "../shared/images/policy.js";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { finder, attr as finderAttribute } from "@medv/finder";
import type { ArticleExtractor, ExtractedArticle } from './article-types.js';
import { eachElementWithinOpenShadow, firstElementMatchingOpenShadow, graftOpenShadows, openShadowRoot } from './open-shadow.js';
import type { PageOverview, PageAction, PagePoint } from '../shared/contracts/page-content.js';

interface Article { mode: string; title: string; byline: string; siteName: string; publishedTime: string; excerpt: string; content: string; text: string; sourceSelector: string }
interface ElementSummary extends PageAction {
  selector: string; tag: string; role: string; type: string; name: string; text: string; value: string; placeholder: string; href: string;
  visible: boolean; disabled: boolean; editable: boolean; actionable?: boolean; inViewport?: boolean;
  rect: { x: number; y: number; w: number; h: number }; clickablePoint: PagePoint | null;
}
interface ContentRequest {
  action: string; selector?: string; editingHost?: boolean; fillToken?: string; elementRef?: string; source?: string; offset?: number; limit?: number;
  pattern?: string; flags?: string; roles?: string[]; tags?: string[]; types?: string[]; includeHidden?: boolean;
  index?: number; block?: ScrollLogicalPosition; elementAction?: string; value?: string; key?: string; submit?: boolean;
  direction?: string; pixels?: number; minWidth?: number; minHeight?: number; visibleOnly?: boolean;
  maxWidth?: number; maxHeight?: number; format?: string; quality?: number;
}
interface PickerRect { left: number; top: number; width: number; height: number }
interface PickerState {
  resolve(result: unknown): void; host: HTMLElement; enterAnimation: Animation; fogPanels: HTMLElement[];
  fogCorners: HTMLElement[]; cursorStyle: HTMLElement; target: Element | null; hoverCandidate: Element | null;
  hoverTimer: number; renderedTarget: Element | null; focusRect: PickerRect | null; immediateUpdate: boolean;
  raf: number; motionRaf: number; timer: number; listeners: [string, EventListener, boolean | AddEventListenerOptions][];
}
type ContentMessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
interface ContentGlobals {
  __QZ_CONTENT_VERSION?: string; __QZ_CONTENT_READY?: boolean; QingzhouArticleExtractor?: ArticleExtractor;
  __QZ_CONTENT_MESSAGE_LISTENER?: ContentMessageListener;
  __qzInvoke?: (node: Node | null, payload: ContentRequest) => Promise<unknown>;
}
const host = globalThis as typeof globalThis & ContentGlobals;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
// DOM reads and interactions run in Chrome's isolated world; page scripts cannot access this state.
// Background validates Session/tab ownership before dispatch. Replies contain data, never DOM nodes.

(() => {
  const QZ_CONTENT_VERSION = "2026-10-28-shadow-find-target";
  const findElementRefs = new Map<string, WeakRef<Element>>();
  const findElementRefScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let findElementRefSequence = 0;
  const imageSourceIdentities = new WeakMap<HTMLImageElement, { source: string; identity: string }>();
  const imageSourceScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let imageSourceSequence = 0;
  const ELEMENT_PICKER_TIMEOUT_MS = 60000;
  const ELEMENT_PICKER_FOG_COLOR = "rgba(216,220,225,.62)";
  const ELEMENT_PICKER_MOTION_MS = 240;
  const ELEMENT_PICKER_HOVER_INTENT_MS = 55;
  const ELEMENT_PICKER_RADIUS = 8;
  let activeElementPicker: PickerState | null = null;
  let elementPickerGeneration = 0;
  let elementPickerStarting = false;
  // Skip duplicate injection of this version; a new version refreshes styles and handlers.
  if (host.__QZ_CONTENT_VERSION === QZ_CONTENT_VERSION && typeof host.__qzInvoke === "function") return;
  host.__QZ_CONTENT_READY = true;
  host.__QZ_CONTENT_VERSION = QZ_CONTENT_VERSION;

  // Content actions share one reply channel; asynchronous handlers must keep it open.

  const onMessage: ContentMessageListener = (raw: unknown, _sender, sendResponse) => {
    const msg = (raw && typeof raw === "object" ? raw : {}) as ContentRequest;
    const handler = handlers[msg.action];
    if (!handler) {
      if (msg.action === "ping") {
        sendResponse({ ok: true, contentVersion: QZ_CONTENT_VERSION, documentReady: documentReadiness() });
        return;
      }
      sendResponse(toolError("UNKNOWN_ACTION", `Unknown content action: ${msg.action}`, { action: msg.action }));
      return;
    }

    Promise.resolve().then(() => handler(msg))
      .then((result) => sendResponse(normalizeResponse(result, msg.action)))
      .catch((err) => sendResponse(toolError(
        "ACTION_FAILED",
        errorMessage(err) || `Action failed: ${msg.action}`,
        { action: msg.action },
      )));

    return true; // Keep sendResponse available for the asynchronous handler.
  };
  // Reinitialization replaces the old message owner before accepting new actions.
  if (host.__QZ_CONTENT_MESSAGE_LISTENER) chrome.runtime.onMessage.removeListener(host.__QZ_CONTENT_MESSAGE_LISTENER);
  chrome.runtime.onMessage.addListener(onMessage);
  host.__QZ_CONTENT_MESSAGE_LISTENER = onMessage;

  // One event-only wait per document, even when a caller stops waiting.
  let documentReady: Promise<{ ok: true }> | undefined;
  function awaitDocument() {
    if (documentReady) return documentReady;
    const ready = documentReadiness("wait");
    if (ready === true) return { ok: true };
    return documentReady = ready.then(() => ({ ok: true }));
  }

  // Handlers

  function normalizeResponse(result: unknown, action: string) {
    if (result === undefined) {
      return toolError("EMPTY_RESPONSE", `Content action returned undefined: ${action}`, { action });
    }
    return result;
  }

  function toolError(code: string, error: string, details: object = {}) {
    return { error, code, details };
  }

  /** Return cleaned DOM HTML lines with script, style, and SVG elements removed. */
  function getDomLines(selector = "body") {
    const rootResult = queryOne(selector);
    if (rootResult.error) return rootResult;
    const root = rootResult.element;
    const clone = root.cloneNode(true) as Element;
    clone.querySelectorAll("script, style, noscript, svg").forEach(el => el.remove());
    // Put each tag or text segment on its own line for paginated reads.
    return clone.innerHTML
      .replace(/>[\s]*</g, ">\n<")  // Separate adjacent tags.
      .split("\n")
      .filter(line => line.trim());  // Remove empty lines.
  }

  function extractReadableArticle({ complete = false } = {}): Article | null {
    const extractor = host.QingzhouArticleExtractor;
    let extracted: ExtractedArticle | null = null;
    try {
      extracted = extractor?.extract?.(document, { complete }) || null;
    } catch (_err) {}

    let parsed = extracted?.metadata || null;
    if (!extracted) {
      try {
        parsed = new Readability(document.cloneNode(true) as Document, {
          charThreshold: 0,
          keepClasses: false,
        }).parse();
        extracted = parsed?.content && parsed?.textContent ? {
          name: "readability",
          content: parsed.content,
          text: parsed.textContent,
        } : null;
      } catch (_err) {}
    }

    const text = String(extracted?.text || parsed?.textContent || "").trim();
    const content = String(extracted?.content || parsed?.content || "");
    if (!text || !content) return null;
    return {
      mode: extracted?.name === "body" ? "body" : "article",
      title: parsed?.title || document.title,
      byline: parsed?.byline || getMetaContent("author") || "",
      siteName: parsed?.siteName || getMetaContent("og:site_name") || "",
      publishedTime: parsed?.publishedTime || getMetaContent("article:published_time") || getMetaContent("datePublished") || "",
      excerpt: parsed?.excerpt || getMetaContent("description") || "",
      content,
      text,
      sourceSelector: getArticleSourceSelector(text),
    };
  }

  function articleFromElement(element: Element, mode: string): Article {
    // Import into an inert document before copying shadow content; cloning in
    // the live document would construct the page's custom elements.
    const snapshot = document.implementation.createHTMLDocument("");
    const base = snapshot.createElement("base");
    base.href = element.baseURI;
    snapshot.head.append(base);
    const clone = snapshot.importNode(element, true);
    // Materialize open shadow trees onto the clone so text, tables, and outline
    // use the existing light-DOM walk. Closed roots are not copied.
    graftOpenShadows(element, clone);
    clone.querySelectorAll("script, style, svg, canvas, iframe, nav, header, footer, aside, form, button").forEach(el => el.remove());
    return {
      mode,
      title: document.title,
      byline: "",
      siteName: "",
      publishedTime: getMetaContent("article:published_time") || getMetaContent("datePublished") || "",
      excerpt: getMetaContent("description") || "",
      content: clone.outerHTML,
      text: elementToReadableText(clone),
      sourceSelector: getAbsoluteSelector(element),
    };
  }

  function getArticleSourceSelector(text = "") {
    const element = findArticleSourceElement(text);
    return element ? getAbsoluteSelector(element) : "";
  }

  function findArticleSourceElement(text = "") {
    const probe = firstArticleProbe(text);
    if (!probe) return null;
    const candidates = [
      ...document.querySelectorAll([
        "article",
        "main",
        "[role='main']",
        "[itemprop='articleBody']",
        ".article",
        ".article-content",
        ".post",
        ".post-content",
        ".entry-content",
        ".main-content",
        ".content",
        "#article",
        "#content",
        "#main",
      ].join(",")),
      document.body,
    ].filter(candidate => candidate && isVisibleArticleSource(candidate));
    let best = null;
    for (const candidate of candidates) {
      const candidateText = cleanArticleText((candidate instanceof HTMLElement ? candidate.innerText : ""));
      if (!candidateText.includes(probe)) continue;
      if (!best || candidateText.length < cleanArticleText((best instanceof HTMLElement ? best.innerText : "")).length) best = candidate;
    }
    return best;
  }

  function isVisibleArticleSource(element: Element) {
    try {
      if (typeof element.checkVisibility === "function" && !element.checkVisibility({
        opacityProperty: true,
        checkOpacity: true,
        visibilityProperty: true,
        checkVisibilityCSS: true,
      })) return false;
      const style = getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.visibility !== "collapse"
        && Number(style.opacity) !== 0
        && style.contentVisibility !== "hidden";
    } catch (_err) {
      return true;
    }
  }

  function firstArticleProbe(text = "") {
    return String(text || "")
      .split(/\n+/)
      .map(line => cleanArticleText(line))
      .find(line => line.length >= 30)
      ?.slice(0, 120) || "";
  }

  function selectedArticle() {
    try {
      const selection = window.getSelection();
      const text = selection?.toString() || "";
      if (!selection?.rangeCount || !text.trim()) return null;
      const container = document.createElement("div");
      for (let index = 0; index < selection.rangeCount; index += 1) {
        container.appendChild(selection.getRangeAt(index).cloneContents());
      }
      container.querySelectorAll("script, style, svg, canvas, iframe, nav, header, footer, aside, form, button").forEach(el => el.remove());
      return {
        text,
        content: container.innerHTML,
        sourceSelector: selectionSourceSelector(),
      };
    } catch (_err) {
      return null;
    }
  }

  function selectionSourceSelector() {
    try {
      const selection = window.getSelection();
      const node = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
      const element = node instanceof Element ? node : node?.parentElement;
      return element ? getAbsoluteSelector(element) : "";
    } catch (_e) {
      return "";
    }
  }

  function elementToReadableText(root: Element) {
    const blockTags = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "LI", "UL", "OL", "TABLE", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);
    const lines: string[] = [];

    function walk(node: Node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (isDecorativeTextArtifact(text)) return;
        if (text) lines.push(text);
        return;
      }
      if (!(node instanceof Element)) return;
      const before = lines.length;
      for (const child of node.childNodes) walk(child);
      const shadow = openShadowRoot(node);
      if (shadow) for (const child of shadow.childNodes) walk(child);
      if (blockTags.has(node.tagName) && lines.length > before) lines.push("\n");
    }

    walk(root);
    return cleanArticleText(lines.join(" "));
  }

  function cleanArticleText(text: string) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/(^|\n)[\s\u200b-\u200f\ufeff]*(?:[\u2580-\u259f\u25a0-\u25ff\u2630\u2261\ufffd]{1,4})[ \t]*/g, "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function cleanArticleMarkdown(markdown: string) {
    return String(markdown || "").trim();
  }

  function plainTextToMarkdown(text: string) {
    return cleanArticleText(text).replace(/[!-/:-@[-`{-~]/g, "\\$&");
  }

  function isSimpleGfmTable(table: Element) {
    const rows = table instanceof HTMLTableElement ? [...table.rows] : [];
    if (!rows.length || table.querySelector("caption, tfoot, table")) return false;
    const firstRowCells = [...rows[0].cells];
    if (!firstRowCells.length || !firstRowCells.every(cell => cell.tagName === "TH")) return false;
    const columnCount = firstRowCells.length;
    const cells = rows.flatMap(row => [...row.cells]);
    if (rows.some(row => row.cells.length !== columnCount)) return false;
    if (cells.some(cell => Number(cell.getAttribute("rowspan") || 1) !== 1
      || Number(cell.getAttribute("colspan") || 1) !== 1)) return false;
    if (cells.some(cell => String(cell.textContent || "").includes("|"))) return false;
    if (rows.slice(1).some(row => [...row.cells].some(cell => cell.tagName === "TH"))) return false;
    if (cells.some(cell => cell.hasAttribute("scope") || cell.hasAttribute("headers"))) return false;
    return !cells.some(cell => cell.querySelector("address, blockquote, br, div, dl, figure, h1, h2, h3, h4, h5, h6, hr, ol, p, pre, table, ul"));
  }

  function safeArticleTableHtml(table: Element) {
    const clone = table.cloneNode(true) as Element;
    clone.querySelectorAll("script, style, noscript, template, iframe, object, embed, form, input, button, select, textarea, svg, canvas, audio, video, source, picture").forEach(el => el.remove());
    const allowedTags = new Set([
      "A", "ABBR", "B", "BLOCKQUOTE", "BR", "CAPTION", "CODE", "COL", "COLGROUP", "DD", "DEL", "DIV", "DL", "DT",
      "EM", "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "I", "LI", "MARK", "OL", "P", "PRE",
      "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "U", "UL",
    ]);
    const allowedCellAttributes = new Set(["abbr", "colspan", "headers", "id", "rowspan", "scope"]);
    [clone, ...clone.querySelectorAll("*")].forEach((element) => {
      if (!allowedTags.has(element.tagName)) {
        element.replaceWith(...element.childNodes);
        return;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const keepCellAttribute = (element.tagName === "TH" || element.tagName === "TD") && allowedCellAttributes.has(name);
        const keepColumnSpan = (element.tagName === "COL" || element.tagName === "COLGROUP") && name === "span";
        const keepLinkAttribute = element.tagName === "A" && (name === "href" || name === "title");
        const keepListAttribute = element.tagName === "OL" && ["reversed", "start", "type"].includes(name);
        if (!keepCellAttribute && !keepColumnSpan && !keepLinkAttribute && !keepListAttribute) element.removeAttribute(attribute.name);
      }
      if (element.tagName === "A" && element.hasAttribute("href")) {
        try {
          const url = new URL(element.getAttribute("href") || "", document.baseURI);
          if (!["http:", "https:", "file:", "mailto:", "tel:"].includes(url.protocol)) element.removeAttribute("href");
          else element.setAttribute("href", url.href);
        } catch (_err) {
          element.removeAttribute("href");
        }
      }
    });
    return clone.outerHTML.trim();
  }

  const ARTICLE_BLOCK_SELECTOR = [
    "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption",
    "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
    "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
  ].join(",");

  function normalizeBlockArticleLinks(doc: Document) {
    for (const outer of [...doc.querySelectorAll("a[href]")]) {
      if (!outer.querySelector(ARTICLE_BLOCK_SELECTOR)) continue;
      const label = [
        ...outer.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],p,figcaption,li,dt,dd,div,section,article"),
      ].find(element => (
        cleanArticleText(element.textContent || "")
        && !element.querySelector(ARTICLE_BLOCK_SELECTOR)
      ));
      const image = label ? null : outer.querySelector("img");
      const container = label || image?.parentElement;
      if (container && outer.contains(container)) {
        const inline = doc.createElement("a");
        inline.setAttribute("href", outer.getAttribute("href") || "");
        if (outer.hasAttribute("title")) inline.setAttribute("title", outer.getAttribute("title") || "");
        if (label) inline.append(...label.childNodes);
        else if (image) inline.append(image);
        container.append(inline);
      }
      outer.replaceWith(...outer.childNodes);
    }
  }

  function articleEmphasisKind(node: Node | null) {
    if (!(node instanceof Element)) return "";
    if (node.matches("em,i")) return "em";
    if (node.matches("strong,b")) return "strong";
    return "";
  }

  const ARTICLE_MARKDOWN_TRANSPARENT_INLINE_SELECTOR = [
    "abbr", "acronym", "bdi", "bdo", "cite", "data", "dfn", "font", "ins", "kbd", "mark",
    "nobr", "q", "rp", "rt", "ruby", "samp", "slot", "small", "span", "sub", "sup", "time",
    "u", "var", "wbr",
  ].join(",");

  function unwrapTransparentArticleInlineElements(doc: Document) {
    // Turndown's default inline rule emits only descendant content, while WBR
    // emits nothing. Flatten the same boundaries before grouping emphasis so
    // serializer-adjacent wrappers are also adjacent in the canonical DOM.
    for (const element of [...doc.querySelectorAll(ARTICLE_MARKDOWN_TRANSPARENT_INLINE_SELECTOR)]) {
      if (element.isConnected && !element.closest("table")) element.replaceWith(...element.childNodes);
    }
  }

  function unwrapLiteralAsteriskArticleEmphasis(doc: Document) {
    for (const element of [...doc.querySelectorAll("em,i,strong,b")]) {
      if (element.isConnected && String(element.textContent || "").includes("*")) {
        element.replaceWith(...element.childNodes);
      }
    }
  }

  function nextRenderedArticleSibling(node: Node) {
    let sibling = node?.nextSibling || null;
    while (sibling && (sibling.nodeType === Node.COMMENT_NODE
      || (sibling.nodeType === Node.TEXT_NODE && sibling.nodeValue === ""))) {
      sibling = sibling.nextSibling;
    }
    return sibling;
  }

  function normalizeAdjacentArticleEmphasis(doc: Document) {
    for (const element of [...doc.querySelectorAll("em,i,strong,b")]) {
      if (!element.isConnected) continue;
      const kind = articleEmphasisKind(element);
      let sibling = nextRenderedArticleSibling(element);
      while (kind && sibling && articleEmphasisKind(sibling) === kind) {
        element.append(...sibling.childNodes);
        sibling.remove();
        sibling = nextRenderedArticleSibling(element);
      }
    }
  }

  function safeArticleImageUrl(value: unknown) {
    const source = String(value || "").trim();
    if (!source) return "";
    try {
      const url = new URL(source, document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (_err) {
      return "";
    }
  }

  function bestArticleSrcsetUrl(value: unknown) {
    let best = null;
    for (const part of String(value || "").split(",")) {
      const match = part.trim().match(/^(\S+?)(?:\s+(\d+(?:\.\d+)?)[wx])?$/i);
      if (!match) continue;
      const url = safeArticleImageUrl(match[1]);
      if (!url) continue;
      const score = Number(match[2] || 1);
      if (!best || score > best.score) best = { url, score };
    }
    return best?.url || "";
  }

  function preferredArticleImageUrl(image: Element, noscriptUrl = "") {
    if (noscriptUrl) return noscriptUrl;
    const picture = image.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source")) {
        const media = source.getAttribute("media");
        if (media && typeof matchMedia === "function" && !matchMedia(media).matches) continue;
        const sourceUrl = bestArticleSrcsetUrl(source.getAttribute("data-srcset"))
          || bestArticleSrcsetUrl(source.getAttribute("srcset"))
          || safeArticleImageUrl(source.getAttribute("data-src"))
          || safeArticleImageUrl(source.getAttribute("src"));
        if (sourceUrl) return sourceUrl;
      }
    }
    return bestArticleSrcsetUrl(image.getAttribute("data-srcset"))
      || safeArticleImageUrl(image.getAttribute("data-src"))
      || bestArticleSrcsetUrl(image.getAttribute("srcset"))
      || safeArticleImageUrl(image.getAttribute("src"));
  }

  function expandArticleNoscriptImages(doc: Document) {
    const fallbacks = new Map();
    for (const noscript of [...doc.querySelectorAll("noscript")]) {
      const template = doc.createElement("template");
      template.innerHTML = noscript.querySelector("img,picture")
        ? noscript.innerHTML
        : String(noscript.textContent || "");
      const fallbackImage = template.content.querySelector("img");
      if (!fallbackImage) {
        noscript.remove();
        continue;
      }
      const previous = noscript.previousElementSibling;
      const existingImage = previous?.matches("img")
        ? previous
        : previous?.matches("picture") ? previous.querySelector("img") : null;
      const fallbackUrl = preferredArticleImageUrl(fallbackImage);
      if (existingImage && fallbackUrl) {
        fallbacks.set(existingImage, fallbackUrl);
        noscript.remove();
        continue;
      }
      noscript.replaceWith(...template.content.childNodes);
    }
    return fallbacks;
  }

  function normalizeArticleImages(doc: Document) {
    const noscriptFallbacks = expandArticleNoscriptImages(doc);
    for (const image of doc.querySelectorAll("img")) {
      const src = preferredArticleImageUrl(image, noscriptFallbacks.get(image));
      image.removeAttribute("src");
      image.removeAttribute("srcset");
      image.removeAttribute("data-src");
      image.removeAttribute("data-srcset");
      if (src) image.setAttribute("src", src);
    }
  }

  function normalizedArticleHtml(html: string) {
    const doc = htmlToDocument(html);
    if (!doc) return String(html || "");
    doc.querySelectorAll("a[href]").forEach((link) => {
      try {
        const url = new URL(link.getAttribute("href") || "", document.baseURI);
        if (!["http:", "https:", "file:", "mailto:", "tel:"].includes(url.protocol)) link.removeAttribute("href");
        else link.setAttribute("href", url.href);
      } catch (_err) {
        link.removeAttribute("href");
      }
    });
    normalizeArticleImages(doc);
    normalizeBlockArticleLinks(doc);
    unwrapTransparentArticleInlineElements(doc);
    // Turndown escapes literal asterisks before adding emphasis delimiters;
    // adjacent delimiter runs can then reinterpret those escaped markers.
    // Preserve the literal content and discard only the unsafe outer emphasis.
    unwrapLiteralAsteriskArticleEmphasis(doc);
    // Turndown serializes adjacent equivalent wrappers as ambiguous delimiter
    // runs (`*foo**bar*`, `**foo****bar**`). Merge them in the canonical DOM
    // first so Markdown parsing cannot turn the middle markers into text.
    normalizeAdjacentArticleEmphasis(doc);
    return doc.body.innerHTML;
  }

  function serializeArticleContent(article: Article) {
    const fallback = plainTextToMarkdown(article?.text || "");
    if (!article?.content) {
      return fallback;
    }
    try {
      const service = new TurndownService({
        headingStyle: "atx",
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        fence: "```",
        // Asterisks remain valid next to word characters; underscores do not.
        // This keeps adjacent inline emphasis parseable (for example <i>02</i>2085).
        emDelimiter: "*",
        strongDelimiter: "**",
        linkStyle: "inlined",
      });
      service.use(gfm);
      service.addRule("qingzhouDecorativeMediaEmphasis", {
        filter: node => ["EM", "I"].includes(node.nodeName)
          && !cleanArticleText(node.textContent || "")
          && Boolean(node.querySelector("img,picture")),
        replacement: content => content,
      });
      service.addRule("qingzhouComplexTable", {
        filter: node => node.nodeName === "TABLE" && !isSimpleGfmTable(node),
        replacement: (_content, node) => `\n\n${safeArticleTableHtml(node)}\n\n`,
      });
      const markdown = cleanArticleMarkdown(service.turndown(normalizedArticleHtml(article.content)));
      return markdown || fallback;
    } catch (_err) {
      return fallback;
    }
  }

  function articleCompactImageHints(article: Article) {
    const parsed = htmlToDocument(article?.content || "");
    if (!parsed) return [];
    const resourceIdentity = (value: string) => {
      try {
        const url = new URL(value, document.baseURI);
        return `${url.origin}${url.pathname}`;
      } catch (_err) {
        return "";
      }
    };
    const liveImages = [...document.querySelectorAll("img")];
    const bySource = new Map<string, HTMLImageElement[]>();
    const byIdentity = new Map<string, HTMLImageElement[]>();
    const byAlt = new Map<string, HTMLImageElement[]>();
    const add = (map: Map<string, HTMLImageElement[]>, key: string, image: HTMLImageElement) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(image);
    };
    for (const image of liveImages) {
      const liveSrc = preferredArticleImageUrl(image);
      add(bySource, liveSrc, image);
      add(byIdentity, resourceIdentity(liveSrc), image);
      add(byAlt, cleanArticleText(image.getAttribute("alt") || ""), image);
    }

    const hints = new Map();
    for (const articleImage of parsed.querySelectorAll("img")) {
      const src = preferredArticleImageUrl(articleImage);
      if (!src) continue;
      const alt = cleanArticleText(articleImage.getAttribute("alt") || "");
      const altMatches = alt && byAlt.get(alt)?.length === 1 ? byAlt.get(alt) : [];
      const candidates = bySource.get(src)
        || byIdentity.get(resourceIdentity(src))
        || altMatches;
      for (const image of candidates || []) {
      const rect = image.getBoundingClientRect();
      const width = Math.round(Math.max(0, rect.width));
      const height = Math.round(Math.max(0, rect.height));
      const naturalWidth = Math.round(Math.max(0, image.naturalWidth || 0));
      const naturalHeight = Math.round(Math.max(0, image.naturalHeight || 0));
      if (!width || !height) continue;
      const renderedCompact = Math.max(width, height) <= 96
        || (Math.min(width, height) <= 48 && Math.max(width, height) <= 192);
      const intrinsicCompact = naturalWidth > 0 && naturalHeight > 0
        && Math.max(naturalWidth, naturalHeight) <= 96;
      const intrinsicAvatar = naturalWidth > 0 && naturalHeight > 0
        && Math.max(naturalWidth, naturalHeight) <= 256
        && Math.max(naturalWidth, naturalHeight) / Math.min(naturalWidth, naturalHeight) <= 1.25;
      if (!renderedCompact && !intrinsicCompact && !intrinsicAvatar) continue;
      const hint = { src, width, height, naturalWidth, naturalHeight };
        const previous = hints.get(src);
        if (!previous || width * height < previous.width * previous.height) hints.set(src, hint);
      }
    }
    return [...hints.values()].slice(0, 100);
  }

  function markdownPageEnd(markdown: string, start: number, limit: number) {
    const hardEnd = Math.min(markdown.length, start + limit);
    if (hardEnd === markdown.length) return hardEnd;
    const preferredMinimum = start + Math.floor(limit / 2);
    for (const separator of ["\n\n", "\n"]) {
      const boundary = markdown.lastIndexOf(separator, hardEnd - separator.length);
      const end = boundary + separator.length;
      if (boundary >= start && end >= preferredMinimum) return end;
    }
    return hardEnd;
  }

  function isDecorativeTextArtifact(text: string) {
    return /^[\s\u200b-\u200f\ufeff\u2580-\u259f\u25a0-\u25ff\u2630\u2261\ufffd]{1,4}$/.test(String(text || ""));
  }

  function extractArticleOutline(html: string, fullText = "") {
    const doc = htmlToDocument(html);
    const root = doc || document;
    const headings = [...root.querySelectorAll("h1,h2,h3,h4,[role='heading']")]
      .map((el) => ({
        level: Number(el.getAttribute("aria-level")) || Number(el.tagName?.slice(1)) || null,
        title: cleanArticleText(el.textContent || "").slice(0, 180),
      }))
      .filter(item => item.title)
      .slice(0, 40);

    let cursor = 0;
    const outline = headings.map((item, index) => {
      const offset = findArticleTextOffset(fullText, item.title, cursor);
      if (offset != null) cursor = offset + item.title.length;
      return {
        index: index + 1,
        level: item.level,
        title: item.title,
        text: item.title,
        offset,
        endOffset: null as number | null,
        charCount: null as number | null,
      };
    });

    for (let index = 0; index < outline.length; index += 1) {
      const item = outline[index];
      if (item.offset == null) continue;
      const offset = item.offset;
      const next = outline.slice(index + 1).find(entry => entry.offset != null && entry.offset > offset);
      item.endOffset = next?.offset ?? String(fullText || "").length;
      item.charCount = Math.max(0, item.endOffset - item.offset);
    }

    return outline;
  }

  function findArticleTextOffset(fullText: string, heading: string, minOffset = 0) {
    const text = String(fullText || "");
    const needle = cleanArticleText(heading);
    if (!text || !needle) return null;
    const start = Math.max(0, Math.floor(Number(minOffset) || 0));
    const exact = text.indexOf(needle, start);
    if (exact >= 0) return exact;
    const normalized = normalizedTextWithOffsets(text);
    const normalizedNeedle = normalizeArticleIndexText(needle);
    if (!normalized.value || !normalizedNeedle) return null;
    const normalizedStart = normalized.offsets.findIndex(offset => offset >= start);
    const matched = normalized.value.indexOf(normalizedNeedle, Math.max(0, normalizedStart));
    return matched >= 0 ? normalized.offsets[matched] : null;
  }

  function normalizedTextWithOffsets(text: string) {
    const value = [];
    const offsets = [];
    let pendingSpace = false;
    for (let index = 0; index < String(text || "").length; index += 1) {
      const char = text[index];
      if (char === "\\" && /[!-/:-@[-`{-~]/.test(text[index + 1] || "")) continue;
      if (/\s/.test(char)) {
        pendingSpace = value.length > 0;
        continue;
      }
      if (pendingSpace) {
        value.push(" ");
        offsets.push(index);
        pendingSpace = false;
      }
      value.push(char.toLowerCase());
      offsets.push(index);
    }
    return { value: value.join("").trim(), offsets };
  }

  function normalizeArticleIndexText(text: string) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function countArticleLinks(html: string) {
    const doc = htmlToDocument(html);
    const root = doc || document;
    return root.querySelectorAll("a[href]").length;
  }

  function htmlToDocument(html: string) {
    if (typeof html !== "string" || !html.trim()) return null;
    try {
      return new DOMParser().parseFromString(html, "text/html");
    } catch(_e) {
      return null;
    }
  }

  function getMetaContent(name: string) {
    const selector = [
      `meta[name="${cssAttrValue(name)}"]`,
      `meta[property="${cssAttrValue(name)}"]`,
      `meta[itemprop="${cssAttrValue(name)}"]`,
    ].join(",");
    return document.querySelector(selector)?.getAttribute("content") || "";
  }

  function cssAttrValue(value: unknown) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function queryAll(selector: unknown) {
    if (selector instanceof Element) {
      return selector.isConnected
        ? { elements: [selector] }
        : { error: toolError("STALE_ELEMENT_UID", "Element target is stale or unknown. Take a fresh get_ax_tree snapshot, then retry.", {}), elements: [] as Element[] };
    }
    if (typeof selector !== "string" || !selector.trim()) {
      return {
        error: toolError("MISSING_SELECTOR", "selector is required", { selector }),
        elements: [],
      };
    }
    const locator = parseElementLocator(selector);
    if (locator.type === "text") {
      return { elements: findElementsByText(locator.value), locator: locator.type };
    }
    try {
      return { elements: [...document.querySelectorAll(selector)] };
    } catch (err) {
      return {
        error: toolError("INVALID_SELECTOR", `Invalid CSS selector or locator: ${selector}`, {
          selector,
          message: errorMessage(err),
          supportedLocators: ["CSS selector", "text='可见文字'"],
        }),
        elements: [],
      };
    }
  }

  function queryElement(selector: unknown, index: number) {
    const query = queryAll(selector);
    if (query.error) return { ...query.error, interactable: getInteractableElements() };
    const element = selector instanceof Element ? query.elements[0] : query.elements[index];
    if (!element) {
      return {
        ...toolError("ELEMENT_NOT_FOUND", `Element not found at selector/index: ${selector}[${index}]`, {
          selector,
          index,
          matched: query.elements.length,
        }),
        interactable: getInteractableElements(),
      };
    }
    return { element, matched: query.elements.length };
  }

  function parseElementLocator(selector: unknown) {
    const text = String(selector || "").trim();
    const textMatch = text.match(/^text\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+))$/i);
    if (textMatch) {
      return {
        type: "text",
        value: normalizeText(textMatch[1] ?? textMatch[2] ?? textMatch[3] ?? ""),
      };
    }
    return { type: "css", value: text };
  }

  function findElementsByText(text: string) {
    const query = normalizeText(text);
    if (!query) return [];
    const candidates = [...document.querySelectorAll("a,button,input,textarea,select,[role],label,summary,[onclick],[tabindex],body *")]
      .filter(isVisible);
    const exact = [];
    const partial = [];
    for (const el of candidates) {
      const haystack = normalizeText([
        getAccessibleName(el),
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.getAttribute("placeholder") || "",
        getElementValue(el) || "",
        el.textContent || "",
      ].filter(Boolean).join(" "));
      if (!haystack) continue;
      if (haystack === query) exact.push(el);
      else if (haystack.includes(query)) partial.push(el);
    }
    return preferSmallestTextMatches(exact.length ? exact : partial, query);
  }

  function preferSmallestTextMatches(elements: Element[], query: string) {
    const unique = [...new Set(elements)];
    return unique
      .filter(el => ![...el.children].some(child => {
        if (!isVisible(child)) return false;
        const childText = normalizeText([
          getAccessibleName(child),
          child.getAttribute("aria-label") || "",
          child.getAttribute("title") || "",
          child.getAttribute("placeholder") || "",
          getElementValue(child) || "",
          child.textContent || "",
        ].filter(Boolean).join(" "));
        return childText === query || childText.includes(query);
      }))
      .sort((a, b) => {
        const actionableA = isActionableElement(a) ? 0 : 1;
        const actionableB = isActionableElement(b) ? 0 : 1;
        if (actionableA !== actionableB) return actionableA - actionableB;
        return elementArea(a) - elementArea(b);
      })
      .slice(0, 50);
  }

  function isActionableElement(el: Element) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName?.toLowerCase();
    const role = getElementRole(el);
    return ["a", "button", "input", "textarea", "select", "summary"].includes(tag)
      || ["button", "link", "menuitem", "tab", "checkbox", "radio", "textbox", "searchbox", "combobox", "listbox", "option", "switch", "slider"].includes(role)
      || (el instanceof HTMLElement && (!!el.onclick || el.tabIndex >= 0));
  }

  function elementArea(el: Element) {
    const rect = el.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function normalizeText(value: unknown) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function queryOne(selector: unknown) {
    const result = queryAll(selector);
    if (result.error) return result;
    const element = result.elements[0] || null;
    if (!element) {
      return {
        error: toolError("ELEMENT_NOT_FOUND", `Element not found: ${selector}`, { selector }),
        element: null,
      };
    }
    return { element };
  }

  /**
   * find_elements scope. Light DOM wins when it matches. A selector that only
   * exists inside an open shadow is still accepted. Invalid selectors keep the
   * original error.
   */
  function queryOpenShadowScope(selector: unknown) {
    const found = queryOne(selector);
    if (!found.error) return found;
    if (found.error.code !== "ELEMENT_NOT_FOUND" || typeof selector !== "string" || !document.documentElement) return found;
    const locator = parseElementLocator(selector);
    if (locator.type !== "css") return found;
    try {
      const match = firstElementMatchingOpenShadow(document.documentElement, locator.value);
      if (!match) return found;
      return { element: match };
    } catch {
      return found;
    }
  }

  async function readImageElement({ selector, index = 0, maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE, format = "png", quality = 0.88 }: Partial<ContentRequest>) {
    const query = queryAll(selector);
    if (query.error) return query.error;
    const requested: unknown = selector;
    const matched = requested instanceof Element ? query.elements[0] : query.elements[Math.max(0, Math.floor(Number(index) || 0))];
    if (!matched) {
      return toolError("ELEMENT_NOT_FOUND", `Element not found at selector/index: ${selector}[${index}]`, {
        selector,
        index,
        matched: query.elements.length,
      });
    }
    const img = pickImageElement(matched);
    if (!img) {
      return toolError("NO_IMAGE_ELEMENT", "Selector did not resolve to an img element or an element containing img", {
        selector,
        index,
        tag: matched.tagName?.toLowerCase() || "",
      });
    }

    const src = img.currentSrc || img.src || img.getAttribute("src") || "";
    let metadata = imageMetadata(img, { selector, index, matched: query.elements.length });
    if (!src) {
      return toolError("IMAGE_SRC_EMPTY", "Image element has no src/currentSrc", metadata);
    }

    try {
      const imageResult = await normalizeImage(() => {
        // The queue may wait while a carousel or lazy loader replaces the image.
        // Capture its identity and pixels together so collection can detect that change.
        metadata = imageMetadata(img, { selector, index, matched: query.elements.length });
        assertImageAlreadyLoaded(img);
        assertImageDimensions(img.naturalWidth, img.naturalHeight);
        return createImageBitmap(img);
      }, {
        maxWidth, maxHeight, quality,
        format: format === "jpeg" || format === "webp" ? format : "png",
      });
      return {
        ok: true,
        dataUrl: imageResult.dataUrl,
        method: "canvas",
        mimeType: imageResult.mimeType,
        width: imageResult.width,
        height: imageResult.height,
        sourceWidth: imageResult.sourceWidth,
        sourceHeight: imageResult.sourceHeight,
        resized: imageResult.resized,
        ...metadata,
      };
    } catch (err) {
      return {
        ...toolError("IMAGE_CANVAS_FAILED", `Cannot convert image in page context: ${errorMessage(err)}`, metadata),
        src: metadata.src,
        currentSrc: metadata.src,
      };
    }
  }

  function listImageElements({ selector = "", minWidth = 1, minHeight = 1, visibleOnly = true, limit = 100 } = {}) {
    const roots = [];
    if (selector) {
      const query = queryAll(selector);
      if (query.error) return query.error;
      roots.push(...query.elements);
    } else {
      roots.push(document.documentElement);
    }

    const seen = new Set();
    const images = [];
    const minW = clampNumber(minWidth, 0, 100000, 1);
    const minH = clampNumber(minHeight, 0, 100000, 1);
    const max = clampNumber(limit, 1, 1000, 100);

    let rawIndex = 0;
    for (const root of roots) {
      const candidates = root instanceof HTMLImageElement
        ? [root]
        : [...(root?.querySelectorAll?.("img") || [])];
      for (const img of candidates) {
        if (!img || seen.has(img)) continue;
        seen.add(img);
        const candidateIndex = rawIndex++;
        const meta = imageMetadata(img);
        const displayWidth = Number(meta.rect?.w || 0);
        const displayHeight = Number(meta.rect?.h || 0);
        const bitmapWidth = Number(meta.naturalWidth || 0);
        const bitmapHeight = Number(meta.naturalHeight || 0);
        if (visibleOnly && !meta.visible) continue;
        if (Math.max(displayWidth, bitmapWidth) < minW || Math.max(displayHeight, bitmapHeight) < minH) continue;
        images.push({
          index: candidateIndex,
          rank: images.length,
          ...meta,
          context: getImageTextContext(img),
          currentSrc: meta.src,
          hasSrcset: Boolean(img.getAttribute("srcset")),
        });
        if (images.length >= max) break;
      }
      if (images.length >= max) break;
    }

    return {
      ok: true,
      count: images.length,
      scanned: rawIndex,
      pageUrl: location.href,
      pageTitle: document.title || "",
      pageContext: getImagePageContext(),
      images,
    };
  }

  function pickImageElement(el: Element) {
    if (!el) return null;
    if (el instanceof HTMLImageElement) return el;
    const images = [...el.querySelectorAll("img")]
      .filter(img => img.currentSrc || img.src || img.getAttribute("src"))
      .sort((a, b) => imageArea(b) - imageArea(a));
    return images[0] || null;
  }

  function imageArea(img: HTMLImageElement) {
    const rect = img.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height)
      || Math.max(0, img.naturalWidth) * Math.max(0, img.naturalHeight);
  }

  function imageMetadata(img: HTMLImageElement, meta: object = {}) {
    const rect = img.getBoundingClientRect();
    return {
      ...meta,
      selector: getAbsoluteSelector(img),
      src: boundedImageSource(img),
      alt: img.getAttribute("alt") || "",
      title: img.getAttribute("title") || "",
      loading: img.getAttribute("loading") || "",
      complete: !!img.complete,
      naturalWidth: Number(img.naturalWidth) || 0,
      naturalHeight: Number(img.naturalHeight) || 0,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      visible: isVisible(img),
    };
  }

  function getImageTextContext(img: HTMLImageElement) {
    const context: Record<string, string> = {};
    const seen = new Set([
      normalizeText(img.getAttribute("alt")).toLowerCase(),
      normalizeText(img.getAttribute("title")).toLowerCase(),
    ].filter(Boolean));
    const scope = findImageContextScope(img);
    const link = img.closest("a[href], button, [role=link], [role=button]");

    addImageContextText(context, seen, "accessibleName", [
      getReferencedText(img, "aria-labelledby"),
      img.getAttribute("aria-label"),
    ]);
    addImageContextText(context, seen, "accessibleDescription", [
      getReferencedText(img, "aria-describedby"),
      getReferencedText(img, "aria-details"),
      img.getAttribute("aria-description"),
    ], 320);
    addImageContextText(context, seen, "caption", imageCaptionCandidates(img, scope?.element), 320);
    addImageContextText(context, seen, "heading", findImageContextHeading(img, scope?.element));
    addImageContextText(context, seen, "linkText", [
      elementContextText(link),
      link ? getReferencedText(link, "aria-labelledby") : "",
      link?.getAttribute("aria-label"),
    ]);
    addImageContextText(context, seen, "linkTitle", link?.getAttribute("title"));
    addImageContextText(context, seen, "nearbyText", scope?.text, 400);

    const linkUrl = link?.matches("a[href]") ? getHref(link) : "";
    if (linkUrl) context.linkUrl = linkUrl.slice(0, 2048);
    return context;
  }

  function getImagePageContext() {
    const context: Record<string, string> = {};
    const heading = [...document.querySelectorAll("main h1, article h1, h1, [role=heading][aria-level='1']")]
      .map(element => elementContextText(element))
      .find(Boolean);
    const description = document.querySelector<HTMLMetaElement>("meta[name='description' i]")?.content
      || document.querySelector<HTMLMetaElement>("meta[property='og:description' i]")?.content
      || "";
    if (heading) context.heading = heading;
    if (normalizeText(description)) context.description = normalizeText(description).slice(0, 500);
    return context;
  }

  function addImageContextText(context: Record<string, string>, seen: Set<string>, key: string, candidates: unknown, limit = 240) {
    const values = Array.isArray(candidates) ? candidates : [candidates];
    for (const value of values) {
      const rawText = normalizeText(value);
      const identity = rawText.toLowerCase();
      if (!rawText || seen.has(identity)) continue;
      context[key] = rawText.slice(0, limit);
      seen.add(identity);
      return;
    }
  }

  function getReferencedText(element: Element, attribute: string) {
    const values = String(element.getAttribute(attribute) || "")
      .split(/\s+/)
      .map(id => normalizeText(document.getElementById(id)?.textContent).slice(0, 240))
      .filter(Boolean);
    return [...new Set(values)].join(" · ").slice(0, 640);
  }

  function imageCaptionCandidates(img: HTMLImageElement, scope?: Element) {
    const figure = img.closest("figure, [role=figure]");
    const structuredScope = img.closest("[itemtype*='ImageObject']") || scope;
    return [
      img.getAttribute("data-caption"),
      img.getAttribute("data-title"),
      img.getAttribute("data-description"),
      img.parentElement?.getAttribute("data-caption"),
      img.parentElement?.getAttribute("data-title"),
      elementContextText(figure?.querySelector("figcaption, [role=caption], [itemprop=caption]")),
      elementContextText(structuredScope?.querySelector("[itemprop=caption], [itemprop=description]")),
    ];
  }

  function findImageContextScope(img: HTMLImageElement) {
    let current = img.parentElement;
    let best = null;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      if (current.matches("main, body, html")) break;
      if (current.querySelectorAll("img").length > 1) break;
      const text = elementContextText(current, 601);
      if (text.length > 600) break;
      if (text) best = { element: current, text };
      if (current.matches("article, [role=article], li, [role=listitem], td, th")) break;
    }
    return best;
  }

  function findImageContextHeading(img: HTMLImageElement, scope?: Element) {
    const selector = "h1, h2, h3, h4, h5, h6, [role=heading]";
    const scopedHeading = [...(scope?.querySelectorAll?.(selector) || [])]
      .map(element => elementContextText(element))
      .find(Boolean);
    if (scopedHeading) return scopedHeading;

    let branch: Element = img;
    for (let depth = 0; branch?.parentElement && depth < 6; depth += 1) {
      const parent = branch.parentElement;
      if (parent.matches("main, body, html")) break;
      for (let sibling = branch.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        const heading = precedingImageContextHeading(sibling, selector);
        if (heading) return heading;
      }
      branch = parent;
    }
    return "";
  }

  function precedingImageContextHeading(element: Element, selector: string) {
    if (element.matches(selector)) return elementContextText(element);
    if (element.querySelector("img")) return "";
    const headings = [...element.querySelectorAll(selector)];
    return elementContextText(headings[headings.length - 1]);
  }

  function elementContextText(element: Element | null | undefined, limit = 240) {
    if (!element) return "";
    const style = getComputedStyle(element);
    if ((element instanceof HTMLElement && element.hidden)
      || element.getAttribute("aria-hidden") === "true"
      || style.display === "none"
      || style.visibility === "hidden"
      || Number(style.opacity) === 0) return "";
    const text = normalizeText(element instanceof HTMLElement ? element.innerText : "");
    return text.slice(0, Math.max(1, Number(limit) || 240));
  }

  function assertImageAlreadyLoaded(img: HTMLImageElement) {
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) return;
    throw new Error("image is not loaded in the DOM yet");
  }

  function boundedImageSource(img: HTMLImageElement) {
    const source = img.currentSrc || img.src || img.getAttribute("src") || "";
    if (!/^data:/i.test(source) && source.length <= 8192) return source;
    const existing = imageSourceIdentities.get(img);
    if (existing?.source === source) return existing.identity;
    const mime = /^data:(image\/[a-z0-9.+-]+)/i.exec(source)?.[1] || "image/unknown";
    const identity = `data:${mime};token=${imageSourceScope}:${++imageSourceSequence};chars=${source.length}`;
    imageSourceIdentities.set(img, { source, identity });
    return identity;
  }

  async function startElementPicker() {
    const generation = ++elementPickerGeneration;
    elementPickerStarting = true;
    if (activeElementPicker) finishElementPicker({ ok: true, status: "cancelled", reason: "replaced" });
    await refreshContentLanguage();
    // Cancel/replacement owns pending startup too, before the overlay and listeners exist.
    if (generation !== elementPickerGeneration) return { ok: true, status: "cancelled", reason: "superseded" };
    elementPickerStarting = false;

    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.dataset.qingzhouElementPicker = "";
      host.style.setProperty("all", "initial", "important");
      host.style.setProperty("position", "fixed", "important");
      host.style.setProperty("inset", "0", "important");
      host.style.setProperty("z-index", "2147483647", "important");
      host.style.setProperty("pointer-events", "none", "important");

      const shadow = host.attachShadow({ mode: "closed" });
      const stage = document.createElement("div");
      stage.style.cssText = "position:fixed;inset:0;pointer-events:none";
      shadow.appendChild(stage);
      const fogPanels = Array.from({ length: 4 }, () => {
        const panel = document.createElement("div");
        panel.style.cssText = [
          "position:fixed",
          "left:0",
          "top:0",
          "width:0",
          "height:0",
          "pointer-events:none",
          "visibility:hidden",
          `background:${ELEMENT_PICKER_FOG_COLOR}`,
        ].join(";");
        stage.appendChild(panel);
        return panel;
      });
      const fogCorners = ["100% 100%", "0 100%", "100% 0", "0 0"].map((origin) => {
        const corner = document.createElement("div");
        corner.style.cssText = [
          "position:fixed",
          "left:0",
          "top:0",
          "width:0",
          "height:0",
          "pointer-events:none",
          "visibility:hidden",
          `background:radial-gradient(circle at ${origin},transparent 70%,${ELEMENT_PICKER_FOG_COLOR} 71%)`,
        ].join(";");
        stage.appendChild(corner);
        return corner;
      });

      const cursorStyle = document.createElement("style");
      cursorStyle.dataset.qingzhouElementPicker = "";
      cursorStyle.textContent = "html, html * { cursor: crosshair !important; }";
      document.documentElement.append(cursorStyle, host);
      const enterAnimation = stage.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 280, easing: "cubic-bezier(.4,0,.2,1)" },
      );

      const state: PickerState = {
        resolve,
        host,
        enterAnimation,
        fogPanels,
        fogCorners,
        cursorStyle,
        target: null,
        hoverCandidate: null,
        hoverTimer: 0,
        renderedTarget: null,
        focusRect: null,
        immediateUpdate: false,
        raf: 0,
        motionRaf: 0,
        timer: 0,
        listeners: [],
      };
      activeElementPicker = state;
      updateElementPickerFog(state);

      const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void, options: boolean | AddEventListenerOptions = true) => {
        window.addEventListener(type, handler, options);
        state.listeners.push([type, handler as EventListener, options]);
      };
      const updateFromEvent = (event: MouseEvent) => {
        const target = elementPickerTarget(event);
        if (target) queueElementPickerHoverIntent(state, target);
      };
      const blockPointerEvent = (event: MouseEvent) => {
        if (event.button != null && event.button !== 0) return;
        updateFromEvent(event);
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const selectElement = (event: MouseEvent) => {
        if (event.button != null && event.button !== 0) return;
        const target = elementPickerTarget(event) || state.target;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!target) return;
        selectElementPickerTarget(target);
      };
      const cancelOnEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finishElementPicker({ ok: true, status: "cancelled", reason: "escape" });
      };
      const refreshOverlay = () => {
        if (state.target) scheduleElementPickerOverlay(state.target, true);
      };

      listen("pointermove", updateFromEvent, { capture: true, passive: true });
      listen("pointerdown", blockPointerEvent, { capture: true, passive: false });
      listen("mousedown", blockPointerEvent, { capture: true, passive: false });
      listen("mouseup", blockPointerEvent, { capture: true, passive: false });
      listen("click", selectElement, { capture: true, passive: false });
      listen("keydown", cancelOnEscape, true);
      listen("scroll", refreshOverlay, { capture: true, passive: true });
      listen("resize", refreshOverlay, { capture: true, passive: true });
      state.timer = window.setTimeout(() => {
        finishElementPicker({ ok: true, status: "cancelled", reason: "timeout" });
      }, ELEMENT_PICKER_TIMEOUT_MS);
    });
  }

  function cancelElementPicker() {
    elementPickerGeneration += 1;
    const starting = elementPickerStarting;
    elementPickerStarting = false;
    if (!activeElementPicker) return { ok: true, status: starting ? "cancelled" : "idle" };
    finishElementPicker({ ok: true, status: "cancelled", reason: "button" });
    return { ok: true, status: "cancelled" };
  }

  function confirmElementPicker() {
    const state = activeElementPicker;
    if (!state) return { ok: true, status: "idle" };
    const target = state.renderedTarget?.isConnected
      ? state.renderedTarget
      : state.target?.isConnected
        ? state.target
        : null;
    if (!target) return { ok: true, status: "waiting" };
    return selectElementPickerTarget(target);
  }

  function selectElementPickerTarget(target: Element) {
    try {
      const result = {
        ok: true,
        status: "selected",
        selector: generatePickedSelector(target),
      };
      finishElementPicker(result);
      return result;
    } catch (err) {
      const result = {
        error: t("noStableSelector"),
        code: "ELEMENT_PICKER_SELECTOR_FAILED",
        details: { message: errorMessage(err) },
      };
      finishElementPicker(result);
      return result;
    }
  }

  function finishElementPicker(result: unknown) {
    const state = activeElementPicker;
    if (!state) return;
    activeElementPicker = null;
    state.enterAnimation.cancel();
    if (state.raf) cancelAnimationFrame(state.raf);
    if (state.motionRaf) cancelAnimationFrame(state.motionRaf);
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    if (state.timer) clearTimeout(state.timer);
    for (const [type, handler, options] of state.listeners) {
      window.removeEventListener(type, handler, options);
    }
    state.cursorStyle.remove();
    state.host.remove();
    state.resolve(result);
  }

  function elementPickerTarget(event: Event) {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    const fromPath = path.find((node): node is Element => (
      node instanceof Element
      && node.ownerDocument === document
      && node.getRootNode() === document
      && !node.hasAttribute("data-qingzhou-element-picker")
    ));
    if (fromPath) return fromPath;
    const direct = event?.target instanceof Element ? event.target : null;
    return direct?.getRootNode() === document ? direct : null;
  }

  function queueElementPickerHoverIntent(state: PickerState, target: Element) {
    if (target === state.target) {
      if (state.hoverTimer) clearTimeout(state.hoverTimer);
      state.hoverTimer = 0;
      state.hoverCandidate = null;
      return;
    }
    if (target === state.hoverCandidate) return;
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverCandidate = target;
    state.hoverTimer = window.setTimeout(() => {
      state.hoverTimer = 0;
      if (activeElementPicker !== state || state.hoverCandidate !== target || !target.isConnected) return;
      state.hoverCandidate = null;
      scheduleElementPickerOverlay(target);
    }, ELEMENT_PICKER_HOVER_INTENT_MS);
  }

  function scheduleElementPickerOverlay(target: Element, immediate = false) {
    const state = activeElementPicker;
    if (!state) return;
    state.target = target;
    state.immediateUpdate ||= immediate;
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      const target = state.target;
      const immediateUpdate = state.immediateUpdate;
      state.immediateUpdate = false;
      if (activeElementPicker !== state || !target?.isConnected) return;
      const rect = target.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        if (state.motionRaf) cancelAnimationFrame(state.motionRaf);
        state.motionRaf = 0;
        state.focusRect = null;
        state.renderedTarget = null;
        updateElementPickerFog(state);
        updateElementPickerFogCorners(state);
        return;
      }
      const focusRect = {
        left: rect.left - 3,
        top: rect.top - 3,
        width: rect.width + 6,
        height: rect.height + 6,
      };
      if (immediateUpdate || state.renderedTarget === null) {
        moveElementPickerFocus(state, focusRect, false);
      } else if (state.renderedTarget !== target) {
        moveElementPickerFocus(state, focusRect, true);
      }
      state.renderedTarget = target;
    });
  }

  function moveElementPickerFocus(state: PickerState, targetRect: PickerRect, animated: boolean) {
    if (state.motionRaf) cancelAnimationFrame(state.motionRaf);
    state.motionRaf = 0;
    if (!animated || !state.focusRect) {
      state.focusRect = targetRect;
      applyElementPickerFocusRect(state, targetRect);
      return;
    }

    const from = state.focusRect;
    const startedAt = performance.now();
    const tick = (now: number) => {
      if (activeElementPicker !== state) return;
      const progress = Math.min(1, Math.max(0, (now - startedAt) / ELEMENT_PICKER_MOTION_MS));
      const eased = progress * progress * (3 - 2 * progress);
      const current = {
        left: from.left + (targetRect.left - from.left) * eased,
        top: from.top + (targetRect.top - from.top) * eased,
        width: from.width + (targetRect.width - from.width) * eased,
        height: from.height + (targetRect.height - from.height) * eased,
      };
      state.focusRect = current;
      applyElementPickerFocusRect(state, current);
      if (progress < 1) {
        state.motionRaf = requestAnimationFrame(tick);
      } else {
        state.motionRaf = 0;
      }
    };
    state.motionRaf = requestAnimationFrame(tick);
  }

  function applyElementPickerFocusRect(state: PickerState, focusRect: PickerRect) {
    const targetRect = {
      ...focusRect,
      right: focusRect.left + focusRect.width,
      bottom: focusRect.top + focusRect.height,
    };
    updateElementPickerFog(state, targetRect);
    updateElementPickerFogCorners(state, targetRect);
  }

  function updateElementPickerFog(state: PickerState, targetRect: (PickerRect & { right: number; bottom: number }) | null = null) {
    const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
    const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
    const left = targetRect ? Math.max(0, Math.min(viewportWidth, targetRect.left)) : 0;
    const top = targetRect ? Math.max(0, Math.min(viewportHeight, targetRect.top)) : 0;
    const right = targetRect ? Math.max(left, Math.min(viewportWidth, targetRect.right)) : 0;
    const bottom = targetRect ? Math.max(top, Math.min(viewportHeight, targetRect.bottom)) : 0;
    const regions = targetRect
      ? [
          [0, 0, viewportWidth, top],
          [0, bottom, viewportWidth, viewportHeight - bottom],
          [0, top, left, bottom - top],
          [right, top, viewportWidth - right, bottom - top],
        ]
      : [[0, 0, viewportWidth, viewportHeight], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    state.fogPanels.forEach((panel, index) => {
      const [x, y, width, height] = regions[index];
      panel.style.visibility = width > 0 && height > 0 ? "visible" : "hidden";
      panel.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
      panel.style.width = `${Math.max(0, width).toFixed(2)}px`;
      panel.style.height = `${Math.max(0, height).toFixed(2)}px`;
    });
  }

  function updateElementPickerFogCorners(state: PickerState, targetRect: (PickerRect & { right: number; bottom: number }) | null = null) {
    if (!targetRect) {
      for (const corner of state.fogCorners) corner.style.visibility = "hidden";
      return;
    }
    const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
    const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
    const left = Math.max(0, Math.min(viewportWidth, targetRect.left));
    const top = Math.max(0, Math.min(viewportHeight, targetRect.top));
    const right = Math.max(left, Math.min(viewportWidth, targetRect.right));
    const bottom = Math.max(top, Math.min(viewportHeight, targetRect.bottom));
    const radius = Math.max(0, Math.min(ELEMENT_PICKER_RADIUS, (right - left) / 2, (bottom - top) / 2));
    const positions = [
      [left, top],
      [right - radius, top],
      [left, bottom - radius],
      [right - radius, bottom - radius],
    ];
    state.fogCorners.forEach((corner, index) => {
      const [x, y] = positions[index];
      corner.style.visibility = radius > 0 ? "visible" : "hidden";
      corner.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
      corner.style.width = `${radius.toFixed(2)}px`;
      corner.style.height = `${radius.toFixed(2)}px`;
    });
  }

  function generatePickedSelector(element: Element) {
    const preferredAttributes = new Set(["data-testid", "data-test", "data-cy", "aria-label", "name", "role"]);
    const selector = String(finder(element, {
      root: document.body,
      timeoutMs: 120,
      seedMinLength: 1,
      optimizedMinLength: 2,
      maxNumberOfPathChecks: 3000,
      attr(name, value) {
        const text = String(value || "").trim();
        if (preferredAttributes.has(name) && text && text.length <= 120) return true;
        return finderAttribute(name, value);
      },
    }) || "").trim();
    if (!selector) throw new Error("selector generator returned an empty selector");
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1 || matches[0] !== element) {
      throw new Error(`selector is not unique: ${selector}`);
    }
    return selector;
  }

  const handlers: Record<string, (message: ContentRequest) => unknown> = {
    awaitDocument,
    startElementPicker,
    confirmElementPicker,
    cancelElementPicker,

    // -- Paginated DOM reads --

    readArticle({ source = "auto", selector = "", offset = 0, limit = 8000 }) {
      const maxChars = clampNumber(limit, 1000, 20000, 8000);
      const start = Math.max(0, Math.floor(Number(offset) || 0));
      const mode = String(source || "auto").toLowerCase();
      let article = null;

      const selection = mode === "auto" || mode === "selection" ? selectedArticle() : null;
      if (selection) {
        article = {
          mode: "selection",
          title: document.title,
          text: selection.text,
          excerpt: "",
          byline: "",
          siteName: "",
          publishedTime: "",
          content: selection.content,
          sourceSelector: selection.sourceSelector,
        };
      }

      if (!article && (mode === "auto" || mode === "article")) {
        article = extractReadableArticle({ complete: mode === "auto" });
      }

      if (!article && (mode === "auto" || mode === "selector") && selector) {
        const root = queryOne(selector);
        if (root.error) return root.error;
        article = articleFromElement(root.element, "selector");
      }

      if (!article) {
        article = articleFromElement(document.body, "body");
      }

      const fullText = serializeArticleContent(article);
      const end = markdownPageEnd(fullText, start, maxChars);
      const text = fullText.slice(start, end);
      const linkCount = countArticleLinks(article.content);
      // Display-only projection for the side panel's formatted preview.
      // _display is stripped before the result reaches the model, and the
      // live-layout measurement is skipped when this slice carries no image
      // Markdown at all.
      const imageDisplayHints = text.includes("![") ? articleCompactImageHints(article) : [];

      return {
        title: article.title || document.title,
        url: location.href,
        mode: article.mode || "article",
        sourceSelector: article.sourceSelector || "",
        byline: article.byline || "",
        siteName: article.siteName || "",
        publishedTime: article.publishedTime || "",
        excerpt: article.excerpt || "",
        ...(imageDisplayHints.length ? { _display: { imageDisplayHints } } : {}),
        text,
        offset: start,
        limit: maxChars,
        showing: `${start}-${end}`,
        totalChars: fullText.length,
        returnedChars: text.length,
        hasMore: end < fullText.length,
        nextOffset: end < fullText.length ? end : null,
        outline: extractArticleOutline(article.content, fullText).slice(0, 20),
        linkCount,
        stats: {
          chars: text.length,
          totalChars: fullText.length,
          truncated: end < fullText.length,
        },
      };
    },

    readDom({ offset = 1, limit = 200, selector = "body" }) {
      const lines = getDomLines(selector);
      if (!Array.isArray(lines)) return lines.error;

      const totalLines = lines.length;
      const start = Math.max(0, offset - 1); // 1-indexed → 0-indexed
      const end = Math.min(totalLines, start + limit);
      const slice = lines.slice(start, end);

      // Add line numbers.
      const numbered = slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n");

      return {
        title: document.title,
        url: location.href,
        totalLines,
        showing: `${start + 1}-${end}`,
        hasMore: end < totalLines,
        content: numbered,
      };
    },

    // -- Element selection --

    findElements({ pattern = "", flags = "i", selector = "body", roles = [], tags = [], types = [], limit = 20, includeHidden = false }) {
      const rootResult = queryOpenShadowScope(selector);
      if (rootResult.error || !rootResult.element) return rootResult.error;
      const maxResults = clampNumber(limit, 1, 100, 20);

      const patternText = String(pattern || "").trim();
      let regex = null;
      if (patternText) {
        try {
          regex = new RegExp(patternText, flags || "i");
        } catch (err) {
          return toolError("INVALID_REGEX", `Invalid regular expression: ${errorMessage(err)}`, { pattern: patternText, flags });
        }
      }

      const roleSet = new Set((roles || []).map(v => String(v).toLowerCase()));
      const tagSet = new Set((tags || []).map(v => String(v).toLowerCase()));
      const typeSet = new Set((types || []).map(v => String(v).toLowerCase()));
      const scope = rootResult.element;
      const candidates: Element[] = [];
      // A light-DOM scope still includes descendants inside nested open shadows.
      eachElementWithinOpenShadow(scope, (element) => { candidates.push(element); });
      const matches = [];

      for (let order = 0; order < candidates.length; order += 1) {
        const el = candidates[order];
        const summary = getElementSummary(el);
        if (!includeHidden && !summary.visible) continue;
        if (roleSet.size && !roleSet.has(summary.role)) continue;
        if (tagSet.size && !tagSet.has(summary.tag)) continue;
        if (typeSet.size && !typeSet.has(String(summary.type || "").toLowerCase())) continue;

        const matchInfo = matchElementSearch(regex, getElementSearchParts(el, summary));
        if (regex && !matchInfo.matched) continue;
        matches.push({
          el,
          summary,
          order,
          ...matchInfo,
          score: scoreElementCandidate(el, summary, matchInfo),
        });
      }

      const results = matches
        .sort(compareElementCandidates)
        .slice(0, maxResults)
        .map(({ el, summary, match = "", matchKind = "none", score = 0 }) => ({
          ...summary,
          ...(el.getRootNode() instanceof ShadowRoot ? { _elementRef: rememberFindElement(el) } : {}),
          ...getElementDomLocation(el, selector),
          match,
          matchKind,
          score: Math.round(score),
          obscuredAtCenter: summary.visible ? isObscuredAtCenter(el) : false,
        }));

      return {
        pattern: patternText,
        flags,
        matches: matches.length,
        searched: candidates.length,
        limit: maxResults,
        resultTruncated: matches.length > results.length,
        results,
      };
    },

    inspectElement({ selector, index = 0 }) {
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el, matched } = targetResult;
      return getElementInspection(el, {
        selector,
        index,
        matched,
        ...getElementDomLocation(el),
      });
    },

    scrollElementIntoView({ selector, index = 0, block = "center" }) {
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el, matched } = targetResult;
      el.scrollIntoView({ behavior: "instant", block, inline: "center" });
      return getElementInspection(el, {
        selector,
        index,
        matched,
        scrolledIntoView: true,
        ...getElementDomLocation(el),
      });
    },

    getElementScreenshotBounds({ selector, index = 0 }) {
      const query = queryAll(selector);
      if (query.error) return query.error;
      const normalizedIndex = Math.max(0, Math.floor(Number(index) || 0));
      const el = query.elements[normalizedIndex];
      if (!el) {
        return toolError("ELEMENT_NOT_FOUND", `Element not found at selector/index: ${selector}[${normalizedIndex}]`, {
          selector,
          index: normalizedIndex,
          matched: query.elements.length,
        });
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return toolError("ELEMENT_HAS_NO_RENDERED_BOX", "Element has no rendered box to screenshot", {
          selector,
          index: normalizedIndex,
          matched: query.elements.length,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
        });
      }
      const visualViewport = window.visualViewport || null;
      const pageX = visualViewport && Number.isFinite(visualViewport.pageLeft)
        ? visualViewport.pageLeft
        : window.scrollX;
      const pageY = visualViewport && Number.isFinite(visualViewport.pageTop)
        ? visualViewport.pageTop
        : window.scrollY;
      return {
        selector: getAbsoluteSelector(el),
        index: normalizedIndex,
        matched: query.elements.length,
        visible: isVisible(el),
        bounds: {
          x: rect.left + pageX,
          y: rect.top + pageY,
          width: rect.width,
          height: rect.height,
        },
        rect: {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
        },
        viewport: {
          pageX,
          pageY,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          width: Math.round(window.innerWidth),
          height: Math.round(window.innerHeight),
          scale: visualViewport && Number.isFinite(visualViewport.scale) ? visualViewport.scale : 1,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
      };
    },

    readImageElement(args) {
      return readImageElement(args);
    },

    pageOverview({ limit = 40, selector = "body" }) {
      const max = clampNumber(limit, 5, 80, 40);
      const rootResult = queryOne(selector || "body");
      if (rootResult.error) return rootResult;
      const root = rootResult.element || document.body;
      const actionSelector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role]",
        "[onclick]",
        "[tabindex]",
        "[contenteditable='true']",
      ].join(",");
      const actionElements = [
        ...(root.matches?.(actionSelector) ? [root] : []),
        ...root.querySelectorAll(actionSelector),
      ];
      // Ranking uses semantic fields and geometry. Build unique selectors only for retained actions.
      const actions = actionElements
        .map(el => ({ el, item: getElementSummary(el, { selector: false, labels: false }) }))
        .filter(({ el, item }) => item.visible && (isUsefulOverviewItem(item)
          || (!item.role && isUsefulOverviewItem(getElementSummary(el, { selector: false })))))
        .sort(({ item: a }, { item: b }) => {
          const av = isRectInViewport(a.rect) ? 0 : 1;
          const bv = isRectInViewport(b.rect) ? 0 : 1;
          if (av !== bv) return av - bv;
          return (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x);
        })
        .slice(0, max)
        .map(({ el }) => getElementSummary(el))
        .map((item, i) => ({
          i,
          selector: item.selector,
          role: item.role || item.tag,
          type: item.type,
          name: item.name,
          text: item.text,
          value: item.value,
          placeholder: item.placeholder,
          href: item.href,
          disabled: item.disabled,
          editable: item.editable,
          checked: item.checked,
          accept: item.accept,
          multiple: item.multiple,
          selectedFileCount: item.selectedFileCount,
          rect: item.rect,
          inViewport: isRectInViewport(item.rect),
        }));

      const headingSelector = "h1,h2,h3,[role='heading']";
      const headingElements = [
        ...(root.matches?.(headingSelector) ? [root] : []),
        ...root.querySelectorAll(headingSelector),
      ];
      const headings = headingElements
        .filter(isVisible)
        .slice(0, 24)
        .map((el) => ({
          level: Number(el.getAttribute("aria-level")) || Number(el.tagName?.slice(1)) || null,
          text: el.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) || "",
          selector: getAbsoluteSelector(el),
        }))
        .filter(item => item.text);

      const canvasElements = [
        ...(root.matches?.("canvas") ? [root] : []),
        ...root.querySelectorAll("canvas"),
      ];
      const canvases = canvasElements
        .filter(isVisible)
        .map((canvas) => {
          const rect = canvas.getBoundingClientRect();
          const renderedArea = rect.width * rect.height;
          if (Math.min(rect.width, rect.height) < 120 || renderedArea < 40000) return null;
          const name = String(getAccessibleName(canvas) || canvas.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 160);
          const summaryRect = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
          return {
            name,
            rect: summaryRect,
            inViewport: isRectInViewport(summaryRect),
            bitmapSize: {
              width: Number(canvas.width) || 0,
              height: Number(canvas.height) || 0,
            },
            renderedArea,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => {
          const av = a.inViewport ? 0 : 1;
          const bv = b.inViewport ? 0 : 1;
          if (av !== bv) return av - bv;
          return (b.renderedArea - a.renderedArea)
            || (a.rect.y - b.rect.y)
            || (a.rect.x - b.rect.x);
        })
        .slice(0, 8)
        .map(({ renderedArea: _renderedArea, ...canvas }) => canvas);

      return {
        title: document.title,
        url: location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollY: Math.round(window.scrollY),
          scrollHeight: document.documentElement.scrollHeight,
        },
        headings,
        actions,
        canvases,
      } satisfies PageOverview;
    },

    prepareElementFill({ selector, index = 0, value = "" }) {
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el } = targetResult;
      if (!isEditableElement(el)) {
        return toolError("NOT_EDITABLE_ELEMENT", "Element is not editable", getElementSummary(el));
      }
      const target = el.isContentEditable ? getContentEditableRoot(el) : el;
      if (isDisabled(el) || isDisabled(target)) {
        return toolError("ELEMENT_DISABLED", "Element is disabled", getElementSummary(target));
      }
      if (isReadOnly(el) || isReadOnly(target)) {
        return toolError("ELEMENT_READONLY", "Element is readonly", getElementSummary(target));
      }
      const fillMode = target instanceof HTMLTextAreaElement
        || (target instanceof HTMLInputElement && ["text", "search", "tel", "url", "password", "email", "number"].includes(target.type))
        || (target.isContentEditable && !hasLineBreaks(value)) ? "text" : "content";
      target.scrollIntoView({ behavior: "instant", block: "center" });
      target.focus({ preventScroll: true });
      if (!target.isConnected || !elementHasFocus(target)) {
        return toolError("ELEMENT_FOCUS_FAILED", "Element could not receive focus", getElementSummary(target));
      }
      if (fillMode === "text") {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          target.select();
        } else if (!selectEditableContents(target)) {
          return toolError("ELEMENT_SELECTION_FAILED", "Element contents could not be selected", getElementSummary(target));
        }
        if (!target.isConnected || !elementHasFocus(target)) {
          return toolError("ELEMENT_FOCUS_FAILED", "Element lost focus while selecting its contents", getElementSummary(target));
        }
      }
      return { ...getElementSummary(target), fillMode, contentEditable: target.isContentEditable };
    },

    async readElementActionState({ selector, index = 0 }) {
      // Let page event handlers commit or roll back native actions; background tabs may not paint.
      await new Promise<void>(resolve => {
        const timeout = window.setTimeout(() => {
          window.cancelAnimationFrame(frame);
          resolve();
        }, 50);
        const frame = window.requestAnimationFrame(() => {
          window.clearTimeout(timeout);
          resolve();
        });
      });
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el } = targetResult;
      return {
        ...getElementSummary(el),
        value: getElementValue(el, true),
        focused: elementHasFocus(el),
        checked: "checked" in el ? !!el.checked : undefined,
      };
    },

    resolveCheckTarget({ selector, index = 0 }) {
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el } = targetResult;
      if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) {
        return toolError("NOT_CHECKABLE_ELEMENT", "Element is not a checkbox or radio", getElementSummary(el));
      }
      if (isDisabled(el)) return toolError("ELEMENT_DISABLED", "Element is disabled", getElementSummary(el));
      const labels = [...(el.labels || [])].filter(label => label.control === el);
      for (const candidate of [el, ...labels]) {
        candidate.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        const inspection = getElementInspection(candidate);
        const point = inspection.clickablePoint;
        if (!inspection.visible || inspection.disabled || !pointInViewport(point) || inspection.state.obscuredAtCenter) continue;
        let hit = point && elementAtPoint(candidate, point.x, point.y);
        if (!hit || (hit !== candidate && !candidate.contains(hit))) continue;
        // Label activation excludes nested links and other independent controls.
        while (hit && hit !== candidate && hit !== el) {
          if (hit.matches("a[href], button, input, select, textarea, [contenteditable]:not([contenteditable='false']), [role='button'], [role='link']")) break;
          hit = hit.parentElement;
        }
        if (hit !== candidate && hit !== el) continue;
        return { ...getElementInspection(el), element: inspection };
      }
      return getElementInspection(el);
    },

    actOnElement({ selector, index = 0, action, elementAction = "", value = "", key = "", submit = false }) {
      const op = String(elementAction || action || "").trim();
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el, matched } = targetResult;

      el.scrollIntoView({ behavior: "instant", block: "center" });

      if (op === "scroll") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return { action: op, selector, index, scrolledTo: true, element: getElementSummary(el) };
      }

      if (op === "click") {
        const target = resolveClickTarget(el);
        if ("error" in target) return target;
        if (target.navigateUrl) {
          location.href = target.navigateUrl;
          return { action: op, selector, index, navigated: true, href: target.navigateUrl, element: getElementSummary(el) };
        }
        simulateClick(target.element);
        return { action: op, selector, index, clicked: true, element: getElementSummary(target.element), originalElement: getElementSummary(el) };
      }

      if (op === "fill") {
        const filled = setElementValue(el, value, submit);
        if ("error" in filled) return filled;
        return { action: op, selector, index, filled: true, submitted: submit, fill: filled, element: getElementSummary(el) };
      }

      if (op === "select") {
        if (!(el instanceof HTMLSelectElement)) {
          return toolError("NOT_SELECT_ELEMENT", `Element is not a select: ${selector}`, {
            selector,
            tag: el.tagName.toLowerCase(),
          });
        }
        // Prefer an exact, untrimmed option.value match; fall back to visible label
        // (option.label) with surrounding whitespace ignored. Select by index so
        // duplicate values do not resolve to the wrong option.
        const rawWanted = String(value ?? "");
        const labelWanted = rawWanted.trim();
        const options = Array.from(el.options);
        let matchIndex = options.findIndex(option => option.value === rawWanted);
        if (matchIndex < 0 && labelWanted) {
          matchIndex = options.findIndex(option => String(option.label || "").trim() === labelWanted);
        }
        if (matchIndex < 0 && labelWanted) {
          return toolError("OPTION_NOT_FOUND", `No <option> matched value or label: ${labelWanted}`, {
            selector,
            value: rawWanted,
            options: options.slice(0, 20).map(option => ({
              value: option.value,
              label: String(option.label || "").trim(),
            })),
          });
        }
        el.selectedIndex = matchIndex;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const selectedOption = matchIndex >= 0 ? options[matchIndex] : null;
        return {
          action: op,
          selector,
          index,
          selected: selectedOption ? selectedOption.value : "",
          selectedLabel: selectedOption ? String(selectedOption.label || "").trim() : "",
          element: getElementSummary(el),
        };
      }

      if (op === "check" || op === "uncheck") {
        if (!("checked" in el)) {
          return toolError("NOT_CHECKABLE_ELEMENT", `Element is not checkable: ${selector}`, {
            selector,
            tag: el.tagName.toLowerCase(),
          });
        }
        const desired = op === "check";
        if (el.checked !== desired) simulateClick(el);
        return { action: op, selector, index, checked: !!el.checked, element: getElementSummary(el) };
      }

      if (op === "press") {
        const pressedKey = key || value;
        if (!pressedKey) return toolError("MISSING_KEY", "key is required for press action", { selector, index });
        if (el instanceof HTMLElement || el instanceof SVGElement) el.focus();
        dispatchKey(el, pressedKey);
        return { action: op, selector, index, key: pressedKey, element: getElementSummary(el) };
      }

      return toolError("UNKNOWN_ELEMENT_ACTION", `Unknown element action: ${op}`, { action: op });
    },

    fill({ selector, index = 0, value = "", submit = false }) {
      return handlers.actOnElement({ selector, index, action: "fill", value, submit });
    },

    press({ selector, index = 0, key = "", value = "" }) {
      return handlers.actOnElement({ selector, index, action: "press", key, value });
    },

    resolveClickTarget({ selector, index = 0 }) {
      const targetResult = queryElement(selector, index);
      if ("error" in targetResult) return targetResult;
      const { element: el, matched } = targetResult;
      const target = resolveClickTarget(el);
      if ("error" in target) return target;
      const summary = getElementSummary(target.element);
      return {
        selector,
        index,
        resolvedSelector: summary.selector,
        clickablePoint: target.point,
        href: target.href,
        navigateUrl: target.navigateUrl,
        element: summary,
        originalElement: getElementSummary(el),
      };
    },

    querySelector({ selector, limit = 10 }) {
      const query = queryAll(selector);
      if (query.error) return query.error;
      return query.elements.slice(0, limit).map((el, i) => ({
        index: i,
        selector: getAbsoluteSelector(el),
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 120) || "",
        visible: (!(el instanceof HTMLElement) || el.offsetParent !== null),
      }));
    },

    // -- Interaction --

    scrollPage({ direction = "down", pixels = 500, selector }) {
      // Hidden tabs do not produce frames, so a smooth scroll never moves.
      const behavior = document.visibilityState === "hidden" ? "instant" : "smooth";
      if (selector) {
        const query = queryOne(selector);
        if (query.error) return query.error;
        query.element.scrollIntoView({ behavior, block: "center" });
        return behavior === "instant"
          ? { scrolledTo: selector, scrollY: window.scrollY }
          : { scrolledTo: selector };
      }

      const map: Record<string, number> = {
        up: -pixels,
        down: pixels,
        top: -document.documentElement.scrollHeight,
        bottom: document.documentElement.scrollHeight,
      };
      const top = map[direction] ?? pixels;
      const scroller = document.scrollingElement || document.documentElement;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const target = Math.min(max, Math.max(0, scroller.scrollTop + top));
      const start = window.scrollY;
      window.scrollBy({ top, behavior });
      // Foreground smooth scrolling settles over later frames. Report the clamped
      // destination immediately so the receipt is not the pre-scroll offset.
      const scrollY = behavior === "instant" || window.scrollY !== start ? window.scrollY : target;
      return {
        direction,
        scrollY,
        scrollHeight: document.documentElement.scrollHeight,
      };
    },

    listImageElements(params) {
      return listImageElements(params);
    },

    getImageBase64({ selector }) {
      return readImageElement({ selector, index: 0 });
    },

  };

  // DOM helpers

  /**
   * Dispatch the full pointer and mouse event sequence for a click:
   *   pointerover → pointerenter → mouseover → mouseenter
   *   → pointermove → mousemove
   *   → pointerdown → mousedown → (focus)
   *   → pointerup → mouseup → click
   *
   * Use the element center, button state, and bubbling flags required by
   * delegated and synthetic event handlers in frameworks such as Vue and React.
   */
  function simulateClick(el: Element) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const commonProps = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
      button: 0,
      buttons: 1,
    };

    // Pointer events (Vue3, modern frameworks)
    el.dispatchEvent(new PointerEvent("pointerover", { ...commonProps, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...commonProps, pointerId: 1, bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...commonProps, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...commonProps, pointerId: 1 }));

    // Mouse events (Vue2, jQuery, vanilla)
    el.dispatchEvent(new MouseEvent("mouseover", commonProps));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...commonProps, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mousemove", commonProps));
    el.dispatchEvent(new MouseEvent("mousedown", commonProps));

    // Focus
    if (el instanceof HTMLElement || el instanceof SVGElement) el.focus();

    // Release
    el.dispatchEvent(new PointerEvent("pointerup", { ...commonProps, pointerId: 1, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...commonProps, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...commonProps, buttons: 0 }));
  }

  function setElementValue(el: Element, value: unknown, submit = false) {
    if (isDisabled(el)) {
      return toolError("ELEMENT_DISABLED", "Element is disabled", getElementSummary(el));
    }
    if (!isEditableElement(el)) {
      return toolError("NOT_EDITABLE_ELEMENT", "Element is not editable", getElementSummary(el));
    }
    const editableRoot = el.isContentEditable ? getContentEditableRoot(el) : el;
    if (isReadOnly(el) || isReadOnly(editableRoot)) {
      return toolError("ELEMENT_READONLY", "Element is readonly", getElementSummary(editableRoot));
    }

    const text = String(value ?? "");
    let target = el;
    let richText = null;
    target.focus();
    if (el instanceof HTMLElement && el.isContentEditable) {
      target = getContentEditableRoot(el);
      target.focus();
      if (hasLineBreaks(text)) {
        richText = setContentEditableMultilineValue(target, text);
      } else {
        target.textContent = text;
      }
    } else {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el), "value",
      )?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else if ("value" in el) el.value = text;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));

    if (submit) {
      const form = target.closest("form");
      if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
      } else {
        dispatchKey(target, "Enter");
      }
    }
    return {
      ok: true,
      multiline: hasLineBreaks(text),
      method: richText?.method || (el.isContentEditable ? "textContent" : "value"),
      richText,
    };
  }

  function hasLineBreaks(value: unknown) {
    return /\r|\n/.test(String(value || ""));
  }

  function getContentEditableRoot(el: HTMLElement) {
    if (!el?.isContentEditable) return el;
    let node: HTMLElement | null = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node.hasAttribute?.("contenteditable") && node.contentEditable !== "false") return node;
      node = node.parentElement;
    }
    return el;
  }

  function setContentEditableMultilineValue(el: HTMLElement, value: unknown) {
    const text = normalizeLineBreaks(value);
    const html = multilineTextToParagraphHtml(text);
    const expected = getExpectedRichTextShape(text);
    const attempts = [];

    selectEditableContents(el);
    attempts.push(dispatchSyntheticRichPaste(el, text, html));
    let structure = getEditableRichTextStructure(el);
    if (isAcceptableRichTextStructure(structure, expected)) {
      return { method: "paste", expected, structure, attempts };
    }

    selectEditableContents(el);
    const execCommandAttempt: { method: string; ok: boolean; error?: string } = { method: "execCommand.insertHTML", ok: false };
    try {
      execCommandAttempt.ok = document.execCommand("insertHTML", false, html);
    } catch (err) {
      execCommandAttempt.error = errorMessage(err);
    }
    attempts.push(execCommandAttempt);
    structure = getEditableRichTextStructure(el);
    if (isAcceptableRichTextStructure(structure, expected)) {
      return { method: "insertHTML", expected, structure, attempts };
    }

    el.innerHTML = html;
    structure = getEditableRichTextStructure(el);
    return {
      method: "innerHTML",
      expected,
      structure,
      attempts,
      warning: "Used direct innerHTML fallback; rich editor internal state may still need a follow-up DOM check before publishing.",
    };
  }

  function normalizeLineBreaks(value: unknown) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  function getExpectedRichTextShape(text: string) {
    const lines = normalizeLineBreaks(text).split("\n");
    return {
      lines: lines.length,
      nonEmptyLines: lines.filter(line => line.trim()).length,
      requiresBlocks: lines.length > 1,
    };
  }

  function multilineTextToParagraphHtml(text: string) {
    return normalizeLineBreaks(text)
      .split("\n")
      .map(line => `<p>${line ? escapeHtml(line) : "<br>"}</p>`)
      .join("");
  }

  function escapeHtml(value: unknown) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function selectEditableContents(el: Element) {
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function dispatchSyntheticRichPaste(el: HTMLElement, text: string, html: string) {
    const attempt: { method: string; ok: boolean; defaultPrevented: boolean; error?: string } = { method: "paste", ok: false, defaultPrevented: false };
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      data.setData("text/html", html);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: data,
      });
      attempt.ok = el.dispatchEvent(pasteEvent);
      attempt.defaultPrevented = pasteEvent.defaultPrevented;
    } catch (err) {
      attempt.error = errorMessage(err);
    }
    return attempt;
  }

  function getEditableRichTextStructure(el: HTMLElement) {
    const innerText = el.innerText || "";
    const html = el.innerHTML || "";
    const paragraphCount = el.querySelectorAll("p").length;
    const brCount = el.querySelectorAll("br").length;
    const blockCount = el.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre").length;
    return {
      paragraphCount,
      brCount,
      blockCount,
      lineBreakCount: (innerText.match(/\n/g) || []).length,
      innerTextLength: innerText.length,
      htmlSample: html.slice(0, 500),
    };
  }

  function isAcceptableRichTextStructure(structure: ReturnType<typeof getEditableRichTextStructure>, expected: ReturnType<typeof getExpectedRichTextShape>) {
    if (!expected.requiresBlocks) return true;
    return structure.paragraphCount > 1 || structure.brCount > 0 || structure.blockCount > 1;
  }

  function dispatchKey(el: Element, key: string) {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const common = { key, code, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", common));
    el.dispatchEvent(new KeyboardEvent("keypress", common));
    el.dispatchEvent(new KeyboardEvent("keyup", common));
  }

  function resolveClickTarget(el: Element) {
    const visibleSelf = clickablePointFor(el);
    if (visibleSelf) {
      return { element: el, point: visibleSelf, href: getHref(el) || undefined };
    }

    const descendants = [...el.querySelectorAll("a[href], button, [role='button'], input, textarea, select, [onclick], [tabindex]")]
      .filter(isVisible);
    for (const child of descendants) {
      const point = clickablePointFor(child);
      if (point) return { element: child, point, href: getHref(child) || getHref(el) || undefined };
    }

    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const point = clickablePointFor(parent);
      const role = getElementRole(parent);
      if (point && (getHref(parent) || parent.onclick || role === "button" || parent.tabIndex >= 0)) {
        return { element: parent, point, href: getHref(parent) || getHref(el) || undefined };
      }
      parent = parent.parentElement;
    }

    const href = getHref(el);
    if (href) return { element: el, point: null, href, navigateUrl: href };

    return {
      ...toolError("NO_CLICKABLE_TARGET", "Element has no visible clickable box and no href to navigate", getElementSummary(el)),
      interactable: getInteractableElements(),
    };
  }

  function clickablePointFor(el: Element) {
    if (!isVisible(el)) return null;
    const rects = [...el.getClientRects()]
      .filter(rect => rect.width > 0 && rect.height > 0)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const rect = rects[0];
    if (!rect) return null;
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }

  function getElementSummary(el: Element, { selector = true, labels = true } = {}) {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const isFileInput = el instanceof HTMLInputElement
      && String(el.type || el.getAttribute("type") || "").toLowerCase() === "file";
    const summary: ElementSummary = {
      selector: selector ? getAbsoluteSelector(el) : "",
      tag,
      role: getElementRole(el),
      type: el.getAttribute("type") || "",
      name: labels ? getAccessibleName(el) : "",
      text: labels ? el.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) || "" : "",
      value: getElementValue(el),
      placeholder: el.getAttribute("placeholder") || "",
      href: getHref(el),
      visible: isVisible(el),
      disabled: isDisabled(el),
      editable: isEditableElement(el),
      checked: "checked" in el ? !!el.checked : undefined,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      clickablePoint: rect.width > 0 && rect.height > 0
        ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        : null,
    };
    if (isFileInput) {
      summary.accept = String(el.accept || "");
      summary.multiple = !!el.multiple;
      summary.selectedFileCount = Number(el.files?.length || 0);
    }
    summary.actionable = isActionableElement(el);
    summary.inViewport = isRectInViewport(summary.rect);
    return summary;
  }

  function getElementInspection(el: Element, meta: object = {}) {
    const summary = getElementSummary(el);
    const extra = { ...(meta as Record<string, unknown>) };
    if (extra.selector instanceof Element) delete extra.selector;
    return {
      ...summary,
      ...extra,
      attrs: getElementAttrs(el),
      state: {
        focused: elementHasFocus(el),
        inViewport: isInViewport(el),
        clickablePointInViewport: pointInViewport(summary.clickablePoint),
        obscuredAtCenter: isObscuredAtCenter(el),
      },
      form: getFormInfo(el),
      parent: el.parentElement ? getElementSummary(el.parentElement) : null,
      nearbyText: getNearbyText(el),
    };
  }

  function getElementSearchParts(el: Element, summary = getElementSummary(el)) {
    const attrs = getElementAttrs(el);
    return [
      { kind: "tag", value: summary.tag },
      { kind: "role", value: summary.role },
      { kind: "name", value: summary.name },
      { kind: "aria", value: attrs["aria-label"] },
      { kind: "placeholder", value: summary.placeholder },
      { kind: "value", value: summary.value },
      { kind: "text", value: summary.text },
      { kind: "href", value: summary.href },
      { kind: "id", value: attrs.id },
      { kind: "class", value: attrs.class },
      { kind: "attr", value: attrs.name },
      { kind: "attr", value: attrs.title },
      { kind: "attr", value: attrs["data-testid"] },
    ].map(part => ({
      kind: part.kind,
      value: normalizeSearchField(part.value, part.kind),
    })).filter(part => part.value);
  }

  function matchElementSearch(regex: RegExp | null, parts: { kind: string; value: string }[]) {
    if (!regex) return { matched: true, match: "", matchKind: "none", matchScore: 0 };
    let best = { matched: false, match: "", matchKind: "none", matchScore: 0 };
    for (const part of parts) {
      regex.lastIndex = 0;
      const match = regex.exec(part.value);
      if (!match) continue;
      const weight = matchKindWeight(part.kind);
      const exactBonus = normalizeText(match[0]).length === part.value.length ? 24 : 0;
      const prefixBonus = part.value.startsWith(normalizeText(match[0])) ? 8 : 0;
      const lengthPenalty = part.kind === "text" ? Math.min(28, Math.max(0, part.value.length - 80) / 10) : 0;
      const score = weight + exactBonus + prefixBonus - lengthPenalty;
      if (score > best.matchScore) {
        best = {
          matched: true,
          match: match[0],
          matchKind: part.kind,
          matchScore: score,
        };
      }
    }
    return best;
  }

  function scoreElementCandidate(el: Element, summary: ReturnType<typeof getElementSummary>, matchInfo: ReturnType<typeof matchElementSearch>) {
    const rect = summary.rect || {};
    const area = Math.max(1, Math.max(0, rect.w || 0) * Math.max(0, rect.h || 0));
    const depth = elementDepth(el);
    let score = Number(matchInfo?.matchScore || 0);
    if (summary.actionable) score += 70;
    if (summary.inViewport) score += 22;
    if (summary.editable) score += 18;
    if (summary.href) score += 10;
    if (summary.disabled) score -= 45;
    if (!summary.visible) score -= 80;
    score += Math.min(26, depth * 1.4);
    score -= Math.min(38, Math.log2(area + 1) * 3.2);
    if (summary.text && summary.text.length > 120 && !summary.actionable) score -= 18;
    return score;
  }

  function compareElementCandidates(a: { score: number; summary: ReturnType<typeof getElementSummary>; order: number }, b: typeof a) {
    return (b.score - a.score)
      || (Number(b.summary?.inViewport) - Number(a.summary?.inViewport))
      || (Number(b.summary?.actionable) - Number(a.summary?.actionable))
      || ((a.summary?.rect?.y || 0) - (b.summary?.rect?.y || 0))
      || ((a.summary?.rect?.x || 0) - (b.summary?.rect?.x || 0))
      || (a.order - b.order);
  }

  function matchKindWeight(kind: string) {
    const weights: Record<string, number> = {
      name: 130,
      aria: 126,
      placeholder: 118,
      value: 112,
      id: 104,
      attr: 96,
      href: 86,
      text: 72,
      role: 42,
      tag: 18,
      class: 14,
    };
    return weights[kind] || 30;
  }

  function normalizeSearchField(value: unknown, kind = "") {
    const max = kind === "text" ? 600 : 240;
    return normalizeText(value).slice(0, max);
  }

  function elementDepth(el: Element) {
    let depth = 0;
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function rememberFindElement(el: Element) {
    const token = `${findElementRefScope}:${++findElementRefSequence}`;
    findElementRefs.set(token, new WeakRef(el));
    while (findElementRefs.size > 5000) findElementRefs.delete(findElementRefs.keys().next().value!);
    return token;
  }

  function getElementDomLocation(el: Element, rootSelector = "body") {
    // read_dom's HTML snapshot does not contain shadow trees, even when their
    // markup happens to match a light-DOM element.
    if (el.getRootNode() instanceof ShadowRoot) return {};
    const lines = getDomLines(rootSelector);
    if (!Array.isArray(lines)) return {};
    const ownLines = normalizeHtmlForLines(el.outerHTML);
    const first = ownLines[0]?.trim();
    if (!first) return {};

    let start = lines.findIndex(line => line.trim() === first);
    if (start < 0) {
      const compactFirst = compactHtml(first);
      start = lines.findIndex(line => compactHtml(line).includes(compactFirst));
    }
    if (start < 0) {
      const selector = getAbsoluteSelector(el).split(" > ").pop();
      const id = el.id ? `id="${el.id}"` : "";
      const cls = el.className && typeof el.className === "string"
        ? el.className.split(/\s+/).filter(Boolean)[0]
        : "";
      start = lines.findIndex(line =>
        (id && line.includes(id)) ||
        (cls && line.includes(cls)) ||
        (selector && line.includes(selector)),
      );
    }
    if (start < 0) return {};

    const end = Math.min(lines.length, start + Math.max(1, ownLines.length)) - 1;
    return {
      line: start + 1,
      lineRange: [start + 1, end + 1],
    };
  }

  function normalizeHtmlForLines(html: string) {
    return String(html || "")
      .replace(/>[\s]*</g, ">\n<")
      .split("\n")
      .filter(line => line.trim());
  }

  function compactHtml(value: unknown) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getElementRole(el: Element) {
    return elementAriaRole(el);
  }

  function getAccessibleName(el: Element) {
    return el.getAttribute("aria-label")
      || el.getAttribute("alt")
      || el.getAttribute("title")
      || labelTextFor(el)
      || "";
  }

  function labelTextFor(el: Element) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent) return label.textContent.trim();
    }
    const wrapped = el.closest("label");
    return wrapped?.textContent?.trim() || "";
  }

  function getElementValue(el: Element, full = false) {
    if (el instanceof HTMLInputElement && String(el.type || "").toLowerCase() === "file") return "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const value = String(el.value || "");
      return full ? value : value.slice(0, 160);
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      const value = el.textContent || "";
      return full ? value : value.trim().slice(0, 160);
    }
    return "";
  }

  function getHref(el: Element) {
    const href = el.getAttribute?.("href") || el.getAttribute?.("src") || "";
    if (href) {
      try { return new URL(href, document.baseURI || location.href).href; }
      catch(_e) { return String(href); }
    }
    if ("href" in el && typeof el.href === "string") return el.href;
    if ("src" in el && typeof el.src === "string") return el.src;
    return "";
  }

  function getElementAttrs(el: Element) {
    const names = ["id", "class", "name", "type", "role", "aria-label", "placeholder", "title", "href", "data-testid"];
    const attrs: Record<string, string> = {};
    for (const name of names) {
      const value = el.getAttribute?.(name);
      if (value) attrs[name] = value.slice(0, 240);
    }
    return attrs;
  }

  function getFormInfo(el: Element) {
    const form = el.closest("form");
    if (!form) return null;
    return {
      selector: getAbsoluteSelector(form),
      action: form.getAttribute("action") || "",
      method: form.getAttribute("method") || "get",
    };
  }

  function getNearbyText(el: Element) {
    const parent = el.parentElement;
    if (!parent) return "";
    return parent.textContent?.trim().replace(/\s+/g, " ").slice(0, 300) || "";
  }

  function elementHasFocus(el: Element) {
    let current: Node | null = el;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const root = current.getRootNode();
      if (!(root instanceof Document || root instanceof ShadowRoot)) return false;
      if (root.activeElement === el) return true;
      if (!(root instanceof ShadowRoot)) return false;
      current = root.host;
    }
    return false;
  }

  function elementFromNode(node: Node | null) {
    if (!node || !node.isConnected) return null;
    if (node instanceof Element) return node;
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
  }

  function isVisible(el: Element) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function isInViewport(el: Element) {
    const rect = el.getBoundingClientRect();
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function pointInViewport(point: PagePoint | null) {
    if (!point) return false;
    return point.x >= 0 && point.y >= 0 && point.x <= window.innerWidth && point.y <= window.innerHeight;
  }

  // document.elementFromPoint stops at a shadow host. The element's own root,
  // including a closed root reached from the element, returns the inner hit and
  // still returns a light-DOM node when that node is the one on top.
  function elementAtPoint(el: Element, x: number, y: number) {
    const root = el.getRootNode();
    const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;
    return scope.elementFromPoint(x, y);
  }

  function isObscuredAtCenter(el: Element) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = elementAtPoint(el, x, y);
    return !!top && top !== el && !el.contains(top);
  }

  function isDisabled(el: Element) {
    return ("disabled" in el && !!el.disabled) || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";
  }

  function isReadOnly(el: Element) {
    return ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly)
      || el.getAttribute("aria-readonly") === "true";
  }

  function isEditableElement(el: Element): el is HTMLElement {
    return (el instanceof HTMLInputElement && String(el.type || "").toLowerCase() !== "file")
      || el instanceof HTMLTextAreaElement
      || el instanceof HTMLSelectElement
      || (el instanceof HTMLElement && el.isContentEditable);
  }

  function clampNumber(value: unknown, min: number, max: number, fallback: number) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function isUsefulOverviewItem(item: ReturnType<typeof getElementSummary>) {
    if (!item) return false;
    if (item.disabled) return true;
    const actionableRoles = new Set([
      "button",
      "link",
      "textbox",
      "searchbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "option",
      "menuitem",
      "tab",
      "switch",
      "slider",
    ]);
    if (item.editable || item.href || actionableRoles.has(item.role)) return true;
    if (item.tag === "button" || item.tag === "summary" || item.tag === "select") return true;
    if (item.role) return false;
    return Boolean(item.name || item.text || item.placeholder || item.value);
  }

  function isRectInViewport(rect: { x: number; y: number; w: number; h: number }) {
    if (!rect) return false;
    return rect.y + rect.h >= 0
      && rect.x + rect.w >= 0
      && rect.y <= window.innerHeight
      && rect.x <= window.innerWidth;
  }

  /**
   * Build an absolute CSS selector for an element.
   * Example: "#app > div.container:nth-child(1) > div.list:nth-child(3) > span.list-title"
   */
  function getAbsoluteSelector(el: Element) {
    const parts = [];
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
      if (current.id) {
        const idSelector = `#${cssEscapeIdent(current.id)}`;
        // A repeated id does not identify the element. Keep walking a unique path.
        if (current.ownerDocument.querySelectorAll(idSelector).length === 1) {
          parts.unshift(idSelector);
          break; // A unique id completes the selector.
        }
      }
      let tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === current!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          tag += `:nth-of-type(${idx})`;
        }
      }
      // Include the first class for readability.
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.split(/\s+/).filter(Boolean)[0];
        if (cls) tag = tag.split(':')[0] + `.${cssEscapeIdent(cls)}` + (tag.includes(':') ? ':' + tag.split(':').slice(1).join(':') : '');
      }
      parts.unshift(tag);
      current = parent;
    }
    const selector = parts.join(" > ");
    if (!selector) return "";
    try {
      const matches = el.ownerDocument.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el ? selector : "";
    } catch {
      return "";
    }
  }

  function cssEscapeIdent(value: unknown) {
    const text = String(value || "");
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(text);
    return text.replace(/^-?\d|[^a-zA-Z0-9_-]/g, (chunk) => {
      const code = chunk.codePointAt(0);
      return Number.isFinite(code) ? `\\${code!.toString(16)} ` : "\\ ";
    });
  }

  /** Summarize interactive page elements, including buttons, links, and clickable nodes. */
  function getInteractableElements() {
    const selectors = 'a[href], button, [role="button"], [onclick], input[type="submit"], [tabindex]';
    const els = [...document.querySelectorAll(selectors)]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (!(el instanceof HTMLElement) || el.offsetParent !== null);
      })
      .slice(0, 30);
    return els.map((el, i) => {
      const item: PageAction & { tag: string; label?: string | null } = { i, tag: el.tagName.toLowerCase() };
      const text = el.textContent?.trim().slice(0, 60);
      if (text) item.text = text;
      if (el.id) item.selector = `#${cssEscapeIdent(el.id)}`;
      else if (el.className && typeof el.className === 'string') {
        const cls = el.className.split(/\s+/).filter(Boolean)[0];
        if (cls) item.selector = `${item.tag}.${cssEscapeIdent(cls)}`;
      }
      const href = getHref(el);
      if (href) item.href = href.slice(0, 80);
      if ("type" in el && typeof el.type === "string") item.type = el.type;
      if (el.getAttribute("aria-label")) item.label = el.getAttribute("aria-label");
      return item;
    });
  }

  const FILL_ROOT_LIMIT = 8;
  const fillRoots = new Map<string, Element>();
  function rememberFillRoot(token: string, root: Element) {
    if (!token || !root.isConnected) return;
    for (const [key, element] of fillRoots) {
      if (!element.isConnected) fillRoots.delete(key);
    }
    fillRoots.delete(token);
    fillRoots.set(token, root);
    while (fillRoots.size > FILL_ROOT_LIMIT) {
      const oldest = fillRoots.keys().next().value;
      if (oldest === undefined) break;
      fillRoots.delete(oldest);
    }
  }
  host.__qzInvoke = async (node, payload) => {
    // Background consumes this isolated-world reference once to bind a backend
    // node UID. It never rematches a selector or exposes a DOM node in a reply.
    if (payload?.action === "resolveFindElement") {
      const token = String(payload.elementRef || "");
      const element = findElementRefs.get(token)?.deref();
      findElementRefs.delete(token);
      return element?.isConnected && element.ownerDocument === document ? element : null;
    }
    const token = String(payload?.fillToken || "");
    if (payload?.action === "releaseFillRoot") {
      if (token) fillRoots.delete(token);
      return { ok: true };
    }
    let element = elementFromNode(node);
    // RootWebArea resolves to the Document. Overview reads from the page element.
    if (!element && payload?.action === "pageOverview" && node instanceof Document) {
      element = node.body || node.documentElement;
    }
    const saved = token ? fillRoots.get(token) : undefined;
    if ((!element || !element.isConnected) && saved?.isConnected) element = saved;
    // This script accepts elements in its own document, including a direct child frame it was injected into.
    if (!element || element.ownerDocument !== document) return toolError("STALE_ELEMENT_UID", "Element target is stale or unknown. Take a fresh get_ax_tree snapshot, then retry.", {});
    if (payload?.editingHost && element instanceof HTMLElement && element.isContentEditable) {
      const root = getContentEditableRoot(element);
      if (root.isConnected) {
        element = root;
        rememberFillRoot(token, root);
      }
    }
    const handler = handlers[payload?.action];
    if (!handler) return toolError("UNKNOWN_ACTION", `Unknown content action: ${payload?.action}`, { action: payload?.action });
    const result = await handler({ ...payload, selector: element } as unknown as ContentRequest);
    const encoded = JSON.stringify(result, (_key, value) => value instanceof Node ? "" : value);
    return encoded === undefined ? {} : JSON.parse(encoded);
  };

})();
