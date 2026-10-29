import { Readability } from "@mozilla/readability";
import { appendOpenShadowContent, openShadowRoot } from "./open-shadow.js";
import type { ArticleExtractor, ExtractedArticle, ReadableArticleMetadata } from './article-types.js';

type QueryRoot = Document | Element;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const styleOf = (element: Element) => (element as Element & { style?: CSSStyleDeclaration }).style;
interface Candidate extends ExtractedArticle { root: Element; length: number; paragraphCount: number; tableCount: number; headingCount: number; dirty: boolean }
interface Paragraph { parts: string[]; charsInLinks: number; path: string; cfClass: string; classType: string; text: string }
interface TraversalState { anchor: boolean; listItem: boolean; boilerplateHits: number; contentHits: number; depth: number }
interface TreeNode extends TraversalState {
  element: Element; parent: number; childIndex: number; tag: string; heading: number; repeated: number; ownRaw: string[];
  readabilityClassWeight: number; readabilityPositiveHits: number; readabilityNegativeHits: number;
  readabilityOkMaybe: boolean; readabilityExtraneous: boolean; readabilityByline: boolean;
  readabilityShare: boolean; readabilityUnlikely: boolean; readabilityRoleRejected: boolean;
}
interface TreeDiagnostics { includeRootCount: number; hasOrphanListOrTableRoot: boolean; retainedAnchorShare: number; retainedBoilerplateShare: number; minLocalRootDecisionMarginPerToken: number | null }
interface ActionModel {
  localBeta: Float64Array; scalingMean: Float64Array; scalingScale: Float64Array;
  rootInputWeight: Float32Array; rootInputBias: Float32Array; rootOutputWeight: Float32Array; rootOutputBias: number;
  emptyInputWeight: Float32Array; emptyInputBias: Float32Array; emptyOutputWeight: Float32Array; emptyOutputBias: number;
}
const host = globalThis as typeof globalThis & { QingzhouArticleExtractor?: ArticleExtractor };
/**
 * Browser-native main-content extraction pipeline.
 *
 * The established pipeline follows Trafilatura's extraction model: a
 * rule-based main extractor, Readability comparison, paragraph-classification
 * rescue, baseline rescue, and a recall escalation for suspiciously short
 * results. On Han-dominant pages where that pipeline clearly under-extracts, a
 * tree dynamic program may supply a larger keep/carve/descend rescue candidate.
 * Both paths return ordinary HTML so read_article keeps one canonical Markdown
 * serializer and one public result contract.
 */
(() => {
  if (host.QingzhouArticleExtractor) return;

  const MIN_EXTRACTED_SIZE = 250;
  const MIN_CONTENT_LENGTH = 100;
  const MIN_DUPLICATE_LENGTH = 50;
  const DEDUPE_SCAN_CAP = 200_000;
  const ESCALATION_MAX_LENGTH = 3_000;
  const ESCALATION_PAGE_SHARE = 0.2;
  const ESCALATION_ACCEPT_RATIO = 1.5;
  const ESCALATION_PARAGRAPH_RATIO = 2;
  const LINK_FARM_RATIO = 0.9;
  const PREPARED_DOCUMENTS = new WeakSet<Document>();
  const TREE_DP_INTERNAL_DIAGNOSTICS = new WeakMap<Candidate, TreeDiagnostics>();

  // Tree-DP rescue (Han-gated): the stable v6b 16-D per-token scorer supplies
  // local evidence, augmented by generic Readability-derived DOM signals. The
  // keep/carve recurrence computes legal forests, then a bounded page-global
  // action model compares the ordinary forest, each feasible independent root,
  // and empty. Tokens count Han characters individually and space-delimited
  // words as one unit each, so scores and penalties share one cross-language
  // scale. Readability remains an independent candidate in the legacy cascade;
  // Tree-DP borrows only general structural signals, never its selected output.
  // Pages that are not Han-dominant keep the established cascade, which carries
  // the upstream Trafilatura parity contract.
  const TREE_DP_COEFFICIENTS = [0.233591, 0.276023, -0.119059, 0.290607, 0.163986, -0.368303,
    -3.254073, 0.210214, 0.462327, 0.152472, -0.996532, -0.064612, 0.260533,
    2.509179, -1.510555, 3.430879];
  const TREE_DP_INTERCEPT = 0.476964;
  const TREE_DP_ROOT_PENALTY = 80;
  const TREE_DP_EXCLUDE_PENALTY = 20;
  const TREE_DP_MIN_EXCLUDE_TOKENS = 20;
  const TREE_DP_GUARD_MIN_TOKENS = 20;
  const TREE_DP_HAN_GATE_SHARE = 0.3;
  const TREE_DP_GATE_MIN_TOKENS = 40;
  const TREE_DP_MAX_PAGE_SHARE = 0.9;
  const TREE_DP_MIN_ANCHORED_SHARE = 0.9;
  const TREE_DP_RESCUE_MAX_LEGACY_PAGE_SHARE = 0.25;
  const TREE_DP_RESCUE_PREFLIGHT_MAX_LEGACY_PAGE_SHARE = 0.5;
  const TREE_DP_RESCUE_MIN_PAGE_SHARE = 0.4;
  const TREE_DP_RESCUE_MAX_LINK_SHARE = 0.8;
  const TREE_DP_RESCUE_MIN_LENGTH_RATIO = 1.5;
  const TREE_DP_RESCUE_MIN_RETAIN = 0.8;
  const TREE_DP_CONFIDENT_MIN_RETAINED_ANCHOR_SHARE = 0.8;
  const TREE_DP_CONFIDENT_MAX_RETAINED_BOILERPLATE_SHARE = 0.03;
  const TREE_DP_CONFIDENT_MIN_ROOT_MARGIN_PER_TOKEN = 0.02;
  const TREE_DP_RESCUE_TEXT_CAP = 80_000;
  const TREE_DP_REMOVED_SELECTOR = "script,style,noscript,svg,canvas,iframe,template";
  const TREE_DP_PARENT_DEPENDENT_ROOT_TAGS = new Set([
    "caption", "col", "colgroup", "dd", "dt", "figcaption", "legend", "li", "optgroup",
    "option", "summary", "tbody", "td", "tfoot", "th", "thead", "tr",
  ]);
  const TREE_DP_DEPENDENT_ROOT_TAGS = new Set([
    ...TREE_DP_PARENT_DEPENDENT_ROOT_TAGS,
    // Phrasing-only wrappers also cannot represent an independent document.
    // Malformed pages occasionally leave EM or SPAN wrapped around most of BODY;
    // fail closed when the calibrated model prefers that malformed boundary
    // instead of silently promoting its second-best, uncalibrated action.
    "abbr", "b", "bdi", "bdo", "cite", "code", "dfn", "em", "i", "kbd", "label",
    "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var",
  ]);
  const TREE_DP_BOILER_RE = /(^|[-_ ])(nav|menu|footer|header|banner|sidebar|aside|breadcrumb|crumb|comment|reply|recommend|related|hot|rank|share|social|login|register|search|copyright|links?|friend|ad|ads|advert|promo|download|qrcode|toolbar|fixed|float|pager|pagination|tag|foot)([-_ ]|$)/i;
  const TREE_DP_CONTENT_RE = /(^|[-_ ])(content|article|artical|main|text|body|post|detail|news|zw|zhengwen|para|passage|word|cont)([-_ ]|$)/i;
  const TREE_DP_PUNCT_RE = /[。！？；：，、.!?;:,]/g;
  const TREE_DP_HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const TREE_DP_WORD_RE = /[\p{L}\p{N}_]+/gu;
  const TREE_DP_DIGIT_RE = /[0-9]/g;
  const TREE_DP_READABILITY_RE = Object.freeze({
    unlikely: /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybe: /and|article|body|column|content|main|shadow/i,
    positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative: /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
    extraneous: /print|archive|comment|discuss|e[\\-]?mail|share|reply|all|login|sign|single|utility/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    share: /(\b|_)(share|sharedaddy)(\b|_)/i,
  });
  const TREE_DP_READABILITY_REJECTED_ROLES = new Set([
    "menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog",
  ]);
  const TREE_DP_READABILITY_BLOCK_TAGS = new Set([
    "blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul",
  ]);
  const TREE_DP_READABILITY_SCORE_TAGS = new Set([
    "section", "h2", "h3", "h4", "h5", "h6", "p", "td", "pre",
  ]);
  const TREE_DP_READABILITY_TAG_PRIOR: Readonly<Record<string, number>> = Object.freeze({
    div: 5, pre: 3, td: 3, blockquote: 3, address: -3, ol: -3, ul: -3,
    dl: -3, dd: -3, dt: -3, li: -3, form: -3, h1: -5, h2: -5, h3: -5,
    h4: -5, h5: -5, h6: -5, th: -5,
  });

  // Rich bounded-action Tree-DP model. The base 16-D scorer remains a fixed
  // offset; this artifact adds generic Readability DOM signals and one bounded
  // page-global action energy over ordinary / empty / legal single-root
  // reconstructions. It never materializes a Readability candidate.
  //
  // Training: zh-realworld base+train, WCXB and WebMainBench at 0.15 corpus
  // weight; site-family OOF; validation consumed once. Float weights are the
  // exact final all-development model, packed little-endian for a compact,
  // synchronous content-script dependency.
  const TREE_DP_ACTION_MODEL_ARTIFACT = Object.freeze({
    schema: "qingzhou.tree-dp-rich-bounded-action.v1",
    reportSha256: "d679bc65b9630e71ed5c7e2cc466b7ab7c5e91273ccef9334aa7ac042f632baf",
    packedSha256: "65a060d2dd57e8071fcc187840979255eda2d6450052694b925f3244241d0da3",
    dimensions: 118,
    width: 16,
    localDimensions: 11,
    doubleCount: 247,
    floatCount: 5730,
    residualBound: 3,
    currentEnergyPrior: 2,
    scopePriorWeight: 0.25,
    minimumRescueTokens: 64,
    shortRescueScore: 2.5,
    packedBase64: [
    "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",
    ].join(""),
  });
  let treeDpActionModelCache: ActionModel | null = null;

  function treeDpActionModel() {
    if (treeDpActionModelCache) return treeDpActionModelCache;
    const binary = atob(TREE_DP_ACTION_MODEL_ARTIFACT.packedBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const take64 = (count: number) => {
      const result = new Float64Array(count);
      for (let index = 0; index < count; index += 1, offset += 8) {
        result[index] = view.getFloat64(offset, true);
      }
      return result;
    };
    const take32 = (count: number) => {
      const result = new Float32Array(count);
      for (let index = 0; index < count; index += 1, offset += 4) {
        result[index] = view.getFloat32(offset, true);
      }
      return result;
    };
    const dimensions = TREE_DP_ACTION_MODEL_ARTIFACT.dimensions;
    const width = TREE_DP_ACTION_MODEL_ARTIFACT.width;
    const model = Object.freeze({
      localBeta: take64(TREE_DP_ACTION_MODEL_ARTIFACT.localDimensions),
      scalingMean: take64(dimensions),
      scalingScale: take64(dimensions),
      rootInputWeight: take32(width * dimensions),
      rootInputBias: take32(width),
      rootOutputWeight: take32(width),
      rootOutputBias: take32(1)[0],
      emptyInputWeight: take32(width * dimensions * 2),
      emptyInputBias: take32(width),
      emptyOutputWeight: take32(width),
      emptyOutputBias: take32(1)[0],
    });
    if (offset !== bytes.length) throw new Error("Tree-DP model artifact length mismatch");
    treeDpActionModelCache = model;
    return model;
  }

  const CANDIDATE_TAGS = "article,div,main,section";
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI",
    "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
  ]);
  const PARAGRAPH_BOUNDARIES = new Set([
    "BODY", "BLOCKQUOTE", "CAPTION", "CENTER", "COL", "COLGROUP", "DD", "DIV", "DL", "DT",
    "FIELDSET", "FORM", "LEGEND", "OPTGROUP", "OPTION", "P", "PRE", "TABLE", "TD", "TEXTAREA",
    "TFOOT", "TH", "THEAD", "TR", "UL", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
  ]);
  const REMOVE_TAGS = [
    "aside", "embed", "fencedframe", "footer", "head", "iframe", "menu", "object", "script",
    "applet", "audio", "canvas", "map", "svg", "video", "area", "blink", "button", "datalist",
    "dialog", "frame", "frameset", "fieldset", "link", "input", "label", "legend", "marquee",
    "menuitem", "nav", "noindex", "optgroup", "option", "output", "param", "progress", "rp", "rt",
    "rtc", "select", "style", "track", "textarea", "use",
  ];
  const UNWRAP_TAGS = [
    "abbr", "acronym", "address", "bdi", "bdo", "big", "cite", "data", "dfn", "font", "hgroup",
    "mark", "meta", "nobr", "ruby", "small", "tbody", "tfoot", "thead",
  ];
  const EMPTY_TAGS = new Set([
    "ARTICLE", "B", "BLOCKQUOTE", "DD", "DIV", "DT", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
    "I", "LI", "MAIN", "P", "PRE", "Q", "SECTION", "SPAN", "STRONG",
  ]);

  const ARTICLE_ID_RE = /(?:entry|article|art)-content|article__content|article(?:-|__)?body|articleBody|body-text/;
  const ARTICLE_CLASS_RE = /post[-_]text|post-body|post-?entry|post[-_]?content|postContent|post_inner_wrapper|article-?text|articleText|(?:entry|page|text|article|art)-content|article__content|article(?:-|__)?body|articleBody|ArticleContent|body-text|article__container/;
  const STORY_ID_RE = /^primary|story-body/;
  const STORY_CLASS_RE = /^article |post-bodycopy|story-?content|(?:theme|blog|section|single)-content|single-post|main-column|wpb_text_column|story-body|field-body/;
  const MAIN_ID_RE = /content-main|content-body|contentBody/;
  const MAIN_CLASS_RE = /content[-_]main|content(?:-|__)body/;

  const DISCARD_BOTH_RE = /^shar|social|viral|newsletter|syndication|tags|sidebar|banner|bread-?crumb|button|author/;
  const DISCARD_ID_RE = /^(?:jp-|dpsp-content)|bmdh|footer|Footer|share|Share|nav|Nav|menu|related|message-container|premium/;
  const DISCARD_CLASS_RE = /^(?:nav|post-nav|ZendeskForm)|subnav|avigation|navbar|navbox|menu|bar| ad |-ad-|outbrain|taboola|criteo|paid-?content|widget|footer|Footer|byline|Byline|share-|sociable|embedded|embed|tag-list|consent|modal-content|permission|elated|next-|-stories|most-popular|meta|rating|attachment|timestamp|user-info|user-profile|-icon|article-infos|message-container|slide|viewport|overlay|options|expand|obfuscated|blurred|mol-factbox|yin|zlylin|nfoline/;
  const COOKIE_RE = /cookie/i;
  const COMMENT_RE = /^(?:comment|comol|disqus_thread|dsq-comments)|(?:article|post)-comments/i;
  const COOKIE_BANNER_RE = /cookie[-_]?(?:banner|bar|consent|law|notice|policy|description)|notice[-_]{0,2}cookie|consent[-_]?(?:banner|manager|sdk)|borlabs|cookiebot|cmplz|onetrust|moove[-_]?gdpr/i;
  const SANITIZED_SELECTOR = "aside,audio,button,fencedframe,fieldset,footer,iframe,input,label,link,nav,noindex,object,option,select,svg";

  // A compact multilingual stop-word core keeps the jusText classifier useful
  // without shipping its multi-megabyte language corpus. The classifier and
  // thresholds are otherwise the same ones used by Trafilatura's rescue path.
  const STOPWORDS = new Set((
    "a an and are as at be been but by can could did do does for from had has have he her hers him his how i if in into is it its may me more most my no not of on one or our ours she so than that the their them then there these they this those to too up us was we were what when where which who why will with would you your " +
    "de der die das den dem des ein eine einer eines einem einen und oder aber als am an auf aus bei bis durch für gegen im in ist mit nach nicht ohne sich sie sind über um von vor war was wie wir zu zum zur " +
    "le la les de des du un une et ou mais dans en est sont pour par pas plus que qui sur au aux ce cette ces se son sa ses " +
    "el la los las de del un una y o pero en es son para por no más que quien sobre al este esta estos se su sus " +
    "o a os as de do da dos das um uma e ou mas em é são para por não mais que quem sobre ao esta este seus suas"
  ).split(/\s+/));

  function normalizedText(value: unknown) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function pageText(value: unknown) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/(^|\n)[\s\u200b-\u200f\ufeff]*(?:[\u2580-\u259f\u25a0-\u25ff\u2630\u2261\ufffd]{1,4})[ \t]*/g, "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readableText(root: Node) {
    const parts: string[] = [];
    function walk(node: Node) {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      const boundary = node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName);
      if (boundary) parts.push("\n");
      for (const child of node.childNodes || []) walk(child);
      if (node.nodeType === 1) {
        const shadow = openShadowRoot(node as Element);
        if (shadow) for (const child of shadow.childNodes) walk(child);
      }
      if (boundary) parts.push("\n");
    }
    walk(root);
    return parts.join("")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function textOf(node: Node) {
    return normalizedText(readableText(node));
  }

  function cloneDocument(doc: Document) {
    return doc.cloneNode(true) as Document;
  }

  // Some collection pages make the whole result label a block-level link
  // (`a > h3 + div`). Link-density cleaners, including Readability, can then
  // mistake the semantic heading for navigation and discard it with the link.
  // Normalize that shape once on the shared prepared document so every
  // extractor sees the same ordinary `h3 > a` structure.
  function normalizeBlockHeadingLinks(root: QueryRoot) {
    for (const link of safeQueryAll(root, "a[href]")) {
      const headings = safeQueryAll(link, "h1,h2,h3,h4,h5,h6")
        .filter(heading => heading.closest("a[href]") === link);
      if (headings.length !== 1) continue;
      const heading = headings[0];
      const hasBlockLabelDetail = heading.parentElement === link
        && [...link.children].some(child => child !== heading && /^(CITE|DIV|P)$/.test(child.tagName));
      if (!hasBlockLabelDetail) continue;
      const rawHref = String(link.getAttribute("href") || "").trim();
      let url = null;
      try {
        url = new URL(rawHref, link.ownerDocument?.baseURI || "https://invalid.local/");
      } catch (_err) {}
      if (!url || !/^(?:https?|file):$/.test(url.protocol) || !normalizedText(heading.textContent)) continue;
      if (heading.closest("table") || heading.querySelector("a[href],button,input,select,textarea")) continue;
      if (link.querySelector("button,input,select,textarea,audio,video")) continue;

      const innerLink = link.ownerDocument.createElement("a");
      for (const attribute of ["href", "title", "hreflang", "lang", "dir", "rel", "referrerpolicy", "target"]) {
        if (link.hasAttribute(attribute)) innerLink.setAttribute(attribute, link.getAttribute(attribute)!);
      }
      innerLink.append(...heading.childNodes);
      heading.append(innerLink);
      link.replaceWith(...link.childNodes);
    }
  }

  function liveDocumentView(doc: Document) {
    const view = doc?.defaultView;
    return view?.document === doc && doc.documentElement?.isConnected ? view : null;
  }

  function elementVisibility(element: Element, view: Window, { ignoreAncestorOpacity = false } = {}) {
    let style = null;
    try {
      style = view.getComputedStyle(element);
    } catch (_err) {
      return { hiddenSubtree: false, hiddenText: false };
    }
    const display = String(style.display || "").toLowerCase();
    const visibility = String(style.visibility || "").toLowerCase();
    const opacity = Number(style.opacity);
    const contentVisibility = String(style.contentVisibility || "").toLowerCase();
    const contents = display === "contents";
    let hiddenSubtree = display === "none"
      || (!contents && (opacity === 0 || contentVisibility === "hidden"));
    if (!hiddenSubtree && !contents && typeof element.checkVisibility === "function") {
      try {
        hiddenSubtree = !element.checkVisibility({
          opacityProperty: !ignoreAncestorOpacity,
          checkOpacity: !ignoreAncestorOpacity,
          visibilityProperty: false,
          checkVisibilityCSS: false,
        });
      } catch (_err) {}
    }
    return {
      hiddenSubtree,
      hiddenText: visibility === "hidden" || visibility === "collapse",
      display,
      visibility,
      opacity,
      contentVisibility,
    };
  }

  function retainVisibleSubtree(source: Element, clone: Element, view: Window, { ignoreAncestorOpacity = false } = {}) {
    if (source.getAttribute("aria-hidden") === "true") {
      clone.remove();
      return false;
    }
    if (source.tagName === "NOSCRIPT"
      && /<(?:img|picture)\b/i.test(String(source.textContent || source.innerHTML || ""))) {
      return true;
    }
    const state = elementVisibility(source, view, { ignoreAncestorOpacity });
    if (state.hiddenSubtree) {
      clone.remove();
      return false;
    }
    const sourceStyle = styleOf(source);
    const cloneStyle = styleOf(clone);
    if (sourceStyle && cloneStyle) {
      if (sourceStyle.display === "none" && state.display !== "none") cloneStyle.removeProperty("display");
      if (Number(sourceStyle.opacity) === 0 && state.opacity !== 0) cloneStyle.removeProperty("opacity");
      if (sourceStyle.contentVisibility === "hidden" && state.contentVisibility !== "hidden") {
        cloneStyle.removeProperty("content-visibility");
      }
      if (/^(?:hidden|collapse)$/.test(sourceStyle.visibility) && !state.hiddenText) {
        cloneStyle.removeProperty("visibility");
      }
      if (state.display === "contents") {
        cloneStyle.removeProperty("opacity");
        cloneStyle.removeProperty("content-visibility");
      }
    }

    const sourceChildren = [...source.childNodes];
    const cloneChildren = [...clone.childNodes];
    let retainedElementChild = false;
    for (let index = 0; index < sourceChildren.length; index += 1) {
      if (sourceChildren[index]?.nodeType !== 1 || cloneChildren[index]?.nodeType !== 1) continue;
      retainedElementChild = retainVisibleSubtree(sourceChildren[index] as Element, cloneChildren[index] as Element, view, {
        ignoreAncestorOpacity: ignoreAncestorOpacity || (state.display === "contents" && state.opacity === 0),
      })
        || retainedElementChild;
    }

    if (state.hiddenText) {
      for (const child of [...clone.childNodes]) {
        if (child.nodeType === 3) child.remove();
      }
      if (!retainedElementChild) {
        clone.remove();
        return false;
      }
      cloneStyle?.setProperty("visibility", "visible", "important");
    }
    appendOpenShadowContent(source, clone, {
      includeElement: (element) => openShadowElementVisible(element, view),
    });
    clone.removeAttribute("hidden");
    return true;
  }

  function openShadowElementVisible(element: Element, view: Window) {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const state = elementVisibility(element, view);
    return !state.hiddenSubtree && !state.hiddenText;
  }

  function prepareDocument(doc: Document) {
    if (!doc?.body || PREPARED_DOCUMENTS.has(doc)) return doc;
    const view = liveDocumentView(doc);
    if (!view) return doc;
    const metadataSelector = 'script[type="application/ld+json"],#data-preloaded';
    const metadata = safeQueryAll(doc, metadataSelector).map(element => element.cloneNode(true));
    const clone = cloneDocument(doc);
    if (!clone?.body) return doc;
    retainVisibleSubtree(doc.body, clone.body, view);
    safeQueryAll(clone, metadataSelector).forEach(element => element.remove());
    clone.head?.append(...metadata);
    normalizeBlockHeadingLinks(clone.body);
    PREPARED_DOCUMENTS.add(clone);
    return clone;
  }

  function unwrap(element: Element) {
    if (!element?.parentNode) return;
    element.replaceWith(...element.childNodes);
  }

  function removeComments(root: QueryRoot) {
    const doc = root?.ownerDocument || root;
    const view = doc?.defaultView || globalThis;
    const showComment = view.NodeFilter?.SHOW_COMMENT || 128;
    const walker = doc?.createTreeWalker?.(root, showComment);
    if (!walker) return;
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(node => node.parentNode?.removeChild(node));
  }

  function safeQueryAll(root: ParentNode | null | undefined, selector: string): Element[] {
    try {
      return [...(root?.querySelectorAll?.(selector) || [])];
    } catch (_err) {
      return [];
    }
  }

  function isForumThreadPage(doc: Document) {
    return safeQueryAll(doc, 'script[type="application/ld+json"]').some(script => (
      /"@type"\s*:\s*"DiscussionForumPosting"|"@type"\s*:\s*\[[^\]]*"DiscussionForumPosting"/.test(script.textContent || "")
    ));
  }

  function removeCommentSections(root: QueryRoot) {
    for (const element of safeQueryAll(root, "div,section,details,ul,ol")) {
      const marker = `${element.id || ""} ${element.className || ""}`;
      if (COMMENT_RE.test(marker)) element.remove();
    }
  }

  function handleForms(root: QueryRoot) {
    const forms = safeQueryAll(root, "form");
    if (!forms.length) return;
    const total = textOf(root).length;
    for (const form of forms) {
      if (total && textOf(form).length > total / 2) unwrap(form);
      else form.remove();
    }
  }

  function cleanTree(root: QueryRoot) {
    if (!root) return root;
    removeComments(root);
    for (const table of safeQueryAll(root, 'table[role="presentation"],table[role="none"]')) unwrap(table);
    for (const figure of safeQueryAll(root, "figure")) {
      if (figure.querySelector("table")) {
        const replacement = figure.ownerDocument.createElement("div");
        replacement.append(...figure.childNodes);
        figure.replaceWith(replacement);
      }
    }
    safeQueryAll(root, "noscript").forEach((element) => {
      const markup = element.querySelector("img,picture")
        ? element.innerHTML
        : String(element.textContent || "");
      if (!/<(?:img|picture)\b/i.test(markup)) {
        element.remove();
      }
    });
    safeQueryAll(root, REMOVE_TAGS.join(",")).forEach(element => element.remove());
    handleForms(root);
    safeQueryAll(root, "template").forEach(element => element.remove());
    safeQueryAll(root, UNWRAP_TAGS.join(",")).forEach(unwrap);
    for (const element of safeQueryAll(root, "*")) {
      if (!EMPTY_TAGS.has(element.tagName)) continue;
      if (!element.childNodes.length || (!textOf(element) && !element.querySelector("img,table"))) element.remove();
    }
    return root;
  }

  function isDiscardCandidate(element: Element) {
    if (!/^(DIV|LI|UL|OL|P|SECTION|SPAN)$/.test(element.tagName)) return false;
    const id = String(element.id || "");
    const className = String(element.className || "");
    const role = String(element.getAttribute("role") || "");
    const firstMarker = id || className;
    if (element.hasAttribute("data-lp-replacement-content")) return true;
    if (/nav/i.test(role)) return true;
    if (String(element.getAttribute("data-component") || "").includes("MostPopularStories")) return true;
    if (COOKIE_RE.test(firstMarker)) return true;
    if (DISCARD_BOTH_RE.test(id) || DISCARD_BOTH_RE.test(className)) return true;
    if (DISCARD_ID_RE.test(id) || DISCARD_CLASS_RE.test(className)) return true;
    return false;
  }

  function isHiddenCandidate(element: Element) {
    const display = String(styleOf(element)?.display || "").toLowerCase();
    const visibility = String(styleOf(element)?.visibility || "").toLowerCase();
    const opacity = String(styleOf(element)?.opacity || "");
    return ("hidden" in element && element.hidden)
      || element.getAttribute("aria-hidden") === "true"
      || display === "none"
      || visibility === "hidden"
      || visibility === "collapse"
      || (opacity !== "" && Number(opacity) === 0);
  }

  function pruneNamedNoise(root: Element, { focus = "balanced" } = {}) {
    if (!root) return root;
    const backup = root.cloneNode(true) as Element;
    const oldLength = textOf(root).length;
    for (const element of safeQueryAll(root, "div,li,ul,ol,p,section,span")) {
      if (isDiscardCandidate(element)) element.remove();
    }
    for (const element of safeQueryAll(root, "*")) {
      if (isHiddenCandidate(element)) element.remove();
    }
    if (oldLength && textOf(root).length <= oldLength / 7) root = backup;
    if (focus !== "recall") {
      for (const element of safeQueryAll(root, "div,li,ul,ol,p,section,span")) {
        if (/teaser/i.test(`${element.id || ""} ${element.className || ""}`)) element.remove();
      }
    }
    return root;
  }

  function collectLinkInfo(element: Element) {
    const texts = safeQueryAll(element, "a").map(textOf).filter(Boolean);
    return {
      length: texts.reduce((sum, text) => sum + text.length, 0),
      count: texts.length,
      shortCount: texts.filter(text => text.length < 10).length,
      texts,
    };
  }

  function repeatedContentScore(root: QueryRoot) {
    if (!root) return 0;
    let best = 0;
    const rootLength = normalizedText(root.textContent).length;
    const containers = [root, ...safeQueryAll(root, "div,section,ul,ol,table,tbody")].slice(0, 80);
    for (const container of containers) {
      const children = [...(container.children || [])].filter(child => !/^(SCRIPT|STYLE|TEMPLATE)$/.test(child.tagName));
      if (children.length < 3 || children.length > 100) continue;
      const groups = new Map<string, Element[]>();
      for (const child of children) {
        const shape = `${child.tagName}:${[...(child.children || [])].slice(0, 4).map(item => item.tagName).join(",")}`;
        if (!groups.has(shape)) groups.set(shape, []);
        groups.get(shape)!.push(child);
      }
      for (const items of groups.values()) {
        if (items.length < 3) continue;
        const useful = items.map(item => ({
          textLength: normalizedText(item.textContent).length,
          structured: Boolean(item.querySelector("a,img,picture,h1,h2,h3,td,th")),
        })).filter(item => item.textLength >= 8 && item.structured);
        if (useful.length < 3 || useful.length < items.length * 0.6) continue;
        const total = useful.reduce((sum, item) => sum + item.textLength, 0);
        const average = total / useful.length;
        if (total < 80 || average < 12 || total < rootLength * 0.7) continue;
        best = Math.max(best, Math.min(1, 0.25 + useful.length / 12 + average / 160));
      }
    }
    return best;
  }

  function isStructuredTable(table: Element) {
    const rows = safeQueryAll(table, "tr").filter(row => safeQueryAll(row, ":scope > th,:scope > td").length >= 2);
    return rows.length >= 3 && textOf(table).length >= 40;
  }

  function isLinkDense(element: Element) {
    const links = safeQueryAll(element, "a");
    if (!links.length || (links.length === 1 && element.querySelector("img,picture"))) {
      return { discard: false, texts: [] };
    }
    const text = textOf(element);
    if (links.length === 1) {
      const linkText = textOf(links[0]);
      if (linkText.length > 100 && linkText.length > text.length * 0.9) return { discard: true, texts: [] };
    }
    const isLast = !element.nextElementSibling;
    const limit = element.tagName === "P" ? (isLast ? 60 : 30) : (isLast ? 300 : 100);
    if (text.length < limit) {
      const info = collectLinkInfo(element);
      if (!info.count) return { discard: true, texts: info.texts };
      if (info.length > text.length * 0.8 || (info.count > 1 && info.shortCount / info.count > 0.8)) {
        return { discard: true, texts: info.texts };
      }
      return { discard: false, texts: info.texts };
    }
    if (links.length > 4) {
      const info = collectLinkInfo(element);
      if (info.length > text.length * LINK_FARM_RATIO && info.length < 100 * info.count) {
        return { discard: true, texts: info.texts };
      }
    }
    return { discard: false, texts: [] };
  }

  function pruneLinkDense(root: Element, selector: string, { backtracking = false } = {}) {
    for (const element of safeQueryAll(root, selector)) {
      const result = isLinkDense(element);
      const backtrack = backtracking && result.texts.length && textOf(element).length > 0
        && textOf(element).length < 100 && element.childElementCount >= 3;
      if (!result.discard && !backtrack) continue;
      if (element.tagName === "P" && /^(LI|TD|TH)$/.test(element.parentElement?.tagName || "")) continue;
      element.remove();
    }
  }

  function pruneLinkDenseTables(root: QueryRoot) {
    for (const table of safeQueryAll(root, "table")) {
      if (isStructuredTable(table)) continue;
      const textLength = textOf(table).length;
      if (textLength < 200) continue;
      const linkLength = collectLinkInfo(table).length;
      if (linkLength > 0 && (textLength < 1_000 ? linkLength > textLength * 0.8 : linkLength > textLength * 0.5)) {
        table.remove();
      }
    }
  }

  function pruneSections(root: Element, options: { focus?: string } = {}) {
    let result = pruneNamedNoise(root, options);
    const collectionScore = repeatedContentScore(result);
    for (let pass = 0; pass < 2; pass += 1) {
      if (collectionScore < 0.95) {
        pruneLinkDense(result, "div", { backtracking: true });
        pruneLinkDense(result, "ul,ol");
      }
      pruneLinkDense(result, "p");
    }
    if (collectionScore < 0.95) pruneLinkDenseTables(result);
    return result;
  }

  function firstMatching(root: QueryRoot, predicate: (element: Element) => boolean) {
    return safeQueryAll(root, CANDIDATE_TAGS).find(predicate) || null;
  }

  const CANDIDATE_STAGES: ((root: QueryRoot) => Element | null)[] = [
    root => firstMatching(root, element => {
      const id = String(element.id || "");
      const className = String(element.className || "");
      return className === "post" || className === "entry" || element.getAttribute("itemprop") === "articleBody"
        || id === "articleContent" || ARTICLE_ID_RE.test(id) || ARTICLE_CLASS_RE.test(className);
    }),
    root => root.querySelector?.("article") || null,
    root => firstMatching(root, element => {
      const id = String(element.id || "");
      const className = String(element.className || "");
      return element.getAttribute("role") === "article" || id === "article" || id === "story"
        || ["postarea", "art-postcontent", "text", "cell", "story"].includes(className)
        || STORY_ID_RE.test(id) || /fulltext/i.test(className) || STORY_CLASS_RE.test(className);
    }),
    root => firstMatching(root, element => {
      const id = String(element.id || "");
      const className = String(element.className || "");
      return id === "content" || className === "content" || MAIN_ID_RE.test(id) || MAIN_CLASS_RE.test(className)
        || /main-content/i.test(id) || /main-content/i.test(className) || /page-content/i.test(className);
    }),
    root => firstMatching(root, element => element.tagName === "MAIN"
      || String(element.className || "").startsWith("main")
      || String(element.id || "").startsWith("main")
      || String(element.getAttribute("role") || "").startsWith("main")),
  ];

  function findCandidate(root: QueryRoot, stage: number) {
    return CANDIDATE_STAGES[stage]?.(root) || null;
  }

  function createWrapper(doc: Document) {
    return doc.createElement("div");
  }

  function extractContentBlocks(root: Element, focus: string) {
    const wrapper = createWrapper(root.ownerDocument);
    const paragraphLength = safeQueryAll(root, "p").reduce((sum, element) => sum + textOf(element).length, 0);
    const includeTextDivs = focus === "recall" || paragraphLength < MIN_EXTRACTED_SIZE * 3;
    const selector = [
      "blockquote", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "img", "math",
      "noscript", "ol", "p", "picture", "pre", "q", "summary", "table", "ul",
      ...(includeTextDivs ? ["div"] : []),
    ].join(",");
    const accepted: Element[] = [];
    for (const element of safeQueryAll(root, selector)) {
      if (accepted.some(parent => parent.contains(element))) continue;
      if (element.tagName === "DIV") {
        const nestedBlock = element.querySelector("blockquote,figcaption,figure,h1,h2,h3,h4,h5,h6,math,noscript,ol,p,picture,pre,q,summary,table,ul");
        if (nestedBlock) continue;
      }
      const text = textOf(element);
      if (!text && !element.matches("img") && !element.querySelector("img,picture")) continue;
      accepted.push(element);
      wrapper.append(element.cloneNode(true));
    }
    while (/^H[1-6]$/.test(wrapper.lastElementChild?.tagName || "")) wrapper.lastElementChild!.remove();
    return wrapper;
  }

  function appendRootContents(wrapper: Element, root: Element | null) {
    if (!root) return;
    wrapper.append(...[...root.childNodes].map(node => node.cloneNode(true)));
  }

  function removeAdjacentDuplicates(root: QueryRoot) {
    let previous = "";
    for (const element of [...root.children]) {
      const current = textOf(element);
      if (current && current === previous && current.length > MIN_DUPLICATE_LENGTH) element.remove();
      else previous = current;
    }
  }

  function recoveryElements(searchRoot: QueryRoot, focus: string) {
    const primarySelector = "blockquote,p,pre,q,summary,table,.w3-code,code:not(pre code)";
    const primary = safeQueryAll(searchRoot, primarySelector).filter(element => (
      !element.parentElement?.closest(primarySelector)
    ));
    if (focus !== "recall") return primary;

    // Recall adds div/list text only when it is not already represented by a
    // semantic text block. Taking the deepest containers avoids app-shell
    // wrappers swallowing the whole page as one candidate.
    const extras = safeQueryAll(searchRoot, "div,ul,ol").filter(element => (
      !element.querySelector(primarySelector)
      && !safeQueryAll(element, ":scope div,:scope ul,:scope ol").some(child => textOf(child))
      && pageText(element.textContent)
    ));
    return [...primary, ...extras].sort((left, right) => {
      const relation = left.compareDocumentPosition(right);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function recoverWildText(cleanedDoc: Document, currentRoot: Element, focus: string) {
    const wrapper = createWrapper(cleanedDoc);
    appendRootContents(wrapper, currentRoot);
    const searchRoot = pruneSections(cleanedDoc.body?.cloneNode(true) as Element, { focus });
    if (!searchRoot) return wrapper;
    const existingTexts = [
      textOf(wrapper),
      ...safeQueryAll(wrapper, "blockquote,code,div,li,p,pre,q,table,ul,ol").map(textOf),
    ];
    const exact = new Set(existingTexts);
    let accumulated = existingTexts.filter(Boolean).join("\n");
    for (const element of recoveryElements(searchRoot, focus)) {
      const text = textOf(element);
      if (!text) continue;
      const underCap = accumulated.length <= DEDUPE_SCAN_CAP;
      if (exact.has(text) || (text.length > MIN_DUPLICATE_LENGTH && underCap && accumulated.includes(text))) continue;
      wrapper.append(element.cloneNode(true));
      exact.add(text);
      if (underCap) accumulated += `\n${text}`;
    }
    return wrapper;
  }

  function makeCandidate(name: string, root: Element | null): Candidate | null {
    if (!root) return null;
    removeAdjacentDuplicates(root);
    const text = readableText(root);
    const length = normalizedText(text).length;
    if (!length) return null;
    return {
      name,
      root,
      content: root.tagName === "BODY" ? root.innerHTML : root.outerHTML,
      text,
      length,
      paragraphCount: safeQueryAll(root, "p").length,
      tableCount: safeQueryAll(root, "table").length,
      headingCount: safeQueryAll(root, "h1,h2,h3,h4,h5,h6").length,
      dirty: Boolean(root.matches?.(SANITIZED_SELECTOR) || root.querySelector?.(SANITIZED_SELECTOR)),
    };
  }

  function topLevelMatches(doc: Document, selectors: string[]) {
    const selector = selectors.join(",");
    return safeQueryAll(doc, selector).filter(element => (
      !element.parentElement?.closest(selector)
      && textOf(element)
    ));
  }

  function pageContentRoot(doc: Document) {
    const articleRoots = topLevelMatches(doc, [
      "article",
      "[role='article']",
      "[itemprop='articleBody']",
      ".article-content",
      ".post-content",
      ".entry-content",
    ]);
    if (articleRoots.length === 1) {
      const article = articleRoots[0];
      const articleLength = pageText(article.textContent).length;
      if (articleLength >= MIN_EXTRACTED_SIZE) {
        const substantialSiblings = [...(article.parentElement?.children || [])].filter(element => (
          element !== article && pageText(element.textContent).length >= Math.max(80, articleLength / 4)
        ));
        if (substantialSiblings.length < 3) return article;
      }
    }
    if (articleRoots.length > 1 && new Set(articleRoots.map(element => pageText(element.textContent))).size === 1) {
      const article = articleRoots[0];
      if (pageText(article.textContent).length >= MIN_EXTRACTED_SIZE) return article;
    }

    let best = null;
    let bestLength = 0;
    for (const element of topLevelMatches(doc, [
      "main",
      "[role='main']",
      ".main-content",
      "#main",
      "#content",
    ])) {
      const length = pageText(element.textContent).length;
      if (length > bestLength) {
        best = element;
        bestLength = length;
      }
    }
    return best || doc.body;
  }

  function repeatedItemShape(element: Element) {
    const structure = [
      "a[href]",
      "article",
      "img,picture",
      "h1,h2,h3,h4,h5,h6,[role='heading']",
      "p",
      "li",
      "table",
    ].map(selector => element.querySelector(selector) ? "1" : "0").join("");
    return `${element.tagName}:${structure}`;
  }

  function belongsToRepeatedCollection(element: Element | null, root: Element) {
    if (!element || element === root || !root.contains(element)) return false;
    for (let member: Element | null = element; member && member !== root; member = member.parentElement) {
      const container = member.parentElement;
      if (!container || (container !== root && !root.contains(container))) break;
      const shape = repeatedItemShape(member);
      let peerCount = 0;
      let totalLength = 0;
      for (const candidate of container.children) {
        if (repeatedItemShape(candidate) !== shape) continue;
        const length = pageText(candidate.textContent).length;
        if (length < 8) continue;
        peerCount += 1;
        totalLength += length;
        if (peerCount >= 3 && totalLength >= 80 && totalLength / peerCount >= 12) return true;
      }
    }
    return false;
  }

  function firstTextProbe(text: string) {
    return String(text || "")
      .split(/\n+/)
      .map(normalizedText)
      .find(line => line.length >= 30)
      ?.slice(0, 120) || "";
  }

  function findSourceElement(doc: Document, text: string) {
    const probe = firstTextProbe(text);
    if (!probe) return null;
    let best = null;
    for (const candidate of [
      ...safeQueryAll(doc, [
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
      doc.body,
    ].filter(Boolean)) {
      const candidateText = pageText(candidate.textContent);
      if (!candidateText.includes(probe)) continue;
      if (!best || candidateText.length < pageText(best.textContent).length) best = candidate;
    }
    return best;
  }

  function pageCandidateStatus(candidate: Candidate, doc: Document, { requireCentralCollection = false } = {}) {
    const root = pageContentRoot(doc);
    const rootText = pageText(root.textContent);
    const blocks = String(candidate?.text || "")
      .split(/\n+/)
      .map(normalizedText)
      .filter(Boolean);
    const totalLength = blocks.reduce((sum, block) => sum + block.length, 0);
    if (!totalLength) return {
      anchored: true,
      anchoredShare: 1,
      complete: true,
      disjoint: false,
      rootCoverage: 1,
    };
    const anchoredLength = blocks
      .filter(block => rootText.includes(block))
      .reduce((sum, block) => sum + block.length, 0);
    const rootCoverage = rootText.length ? Math.min(1, anchoredLength / rootText.length) : 1;
    const anchoredShare = anchoredLength / totalLength;
    const anchored = anchoredShare >= 0.5;
    const missesCentralCollection = requireCentralCollection
      && rootCoverage < 0.5
      && anchored
      && repeatedContentScore(root) >= 0.95;
    return {
      anchored,
      anchoredShare,
      disjoint: anchoredLength === 0,
      rootCoverage,
      complete: rootCoverage >= 0.5
        || (anchored
          && !missesCentralCollection
          && !belongsToRepeatedCollection(findSourceElement(doc, candidate.text), root)),
    };
  }

  function centralPageCandidate(doc: Document) {
    const clone = pageContentRoot(doc)?.cloneNode(true) as Element | undefined;
    if (!clone) return null;
    safeQueryAll(clone, "script,style,svg,canvas,iframe,nav,header,footer,aside,form,button")
      .forEach(element => element.remove());
    const candidate = makeCandidate("body", clone);
    if (candidate) candidate.content = clone.outerHTML;
    return candidate;
  }

  function runCustomExtractor(doc: Document, focus = "balanced") {
    const cleanedDoc = cloneDocument(doc);
    if (!cleanedDoc?.body) return null;
    if (!isForumThreadPage(doc)) removeCommentSections(cleanedDoc);
    cleanTree(cleanedDoc);
    let root = null;
    for (const stage of CANDIDATE_STAGES.keys()) {
      const node = findCandidate(cleanedDoc, stage);
      if (!node) continue;
      const candidate = pruneSections(node.cloneNode(true) as Element, { focus });
      const content = extractContentBlocks(candidate, focus);
      if (content.childNodes.length && (textOf(content) || content.querySelector("img,picture"))) {
        root = content;
        break;
      }
    }
    const extracted = createWrapper(cleanedDoc);
    appendRootContents(extracted, root);
    root = !root || textOf(extracted).length < MIN_EXTRACTED_SIZE
      ? recoverWildText(cleanedDoc, extracted, focus)
      : extracted;
    return makeCandidate(focus === "recall" ? "rules-recall" : "rules", root);
  }

  function parseReadabilityCandidate(doc: Document, readability: ReadableArticleMetadata | null | undefined) {
    if (!readability?.content || !normalizedText(readability.textContent || "")) return null;
    const parsed = doc.implementation.createHTMLDocument("");
    parsed.body.innerHTML = String(readability.content || "");
    return makeCandidate("readability", parsed.body);
  }

  function preferReadability(custom: Candidate | null, readable: Candidate | null, focus = "balanced") {
    const customLength = custom?.length || 0;
    const readableLength = readable?.length || 0;
    if (!readable || !readableLength || readableLength === customLength) return false;
    if (customLength > 2 * readableLength) return false;
    return customLength === 0
      || (readableLength > 2 * customLength && !readable.text.startsWith("{"))
      || (readableLength > MIN_EXTRACTED_SIZE * 2
        && (!(custom?.paragraphCount) || (custom?.tableCount || 0) > (custom?.paragraphCount || 0)))
      || (focus === "recall" && readableLength > 1.5 * customLength && !readable.text.startsWith("{"))
      || (focus === "recall" && !(custom?.headingCount) && readable.headingCount > 0 && readableLength > customLength);
  }

  function sanitizeReadability(doc: Document, candidate: Candidate | null, focus: string) {
    if (!candidate) return null;
    const parsed = doc.implementation.createHTMLDocument("");
    parsed.body.innerHTML = candidate.content;
    if (!isForumThreadPage(doc)) removeCommentSections(parsed);
    cleanTree(parsed.body);
    const root = pruneSections(parsed.body, { focus });
    return makeCandidate(candidate.name, extractContentBlocks(root, focus)) || candidate;
  }

  function collectParagraphs(root: QueryRoot) {
    const paragraphs: Paragraph[] = [];
    let current!: Omit<Paragraph, "text">;
    let linkDepth = 0;
    let previousBreak = false;

    function begin(path = "") {
      current = { parts: [], charsInLinks: 0, path, cfClass: "", classType: "" };
    }
    function flush() {
      if (!current) return;
      const text = normalizedText(current.parts.join(""));
      if (text) paragraphs.push({ ...current, text });
      begin(current.path);
    }
    function append(raw: unknown) {
      const value = String(raw || "").replace(/\s+/g, " ");
      if (!value.trim()) return;
      current.parts.push(value);
      if (linkDepth) current.charsInLinks += value.length;
      previousBreak = false;
    }
    function walk(node: Node, path = "") {
      if (node.nodeType === 3) {
        append(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node as Element).tagName;
      const nextPath = path ? `${path}.${tag.toLowerCase()}` : tag.toLowerCase();
      const boundary = PARAGRAPH_BOUNDARIES.has(tag);
      if (boundary) flush();
      if (tag === "BR") {
        if (previousBreak) flush();
        else current.parts.push(" ");
        previousBreak = true;
        return;
      }
      if (tag === "A") linkDepth += 1;
      current.path = nextPath;
      for (const child of node.childNodes) walk(child, nextPath);
      const shadow = openShadowRoot(node as Element);
      if (shadow) for (const child of shadow.childNodes) walk(child, nextPath);
      if (tag === "A") linkDepth -= 1;
      if (boundary) flush();
    }

    begin();
    walk(root);
    flush();
    return paragraphs;
  }

  function classifyParagraphs(paragraphs: Paragraph[]) {
    for (const paragraph of paragraphs) {
      const words = paragraph.text.split(/\s+/).filter(Boolean);
      const stopDensity = words.length
        ? words.filter(word => STOPWORDS.has(word.toLowerCase().replace(/^\W+|\W+$/g, ""))).length / words.length
        : 0;
      const linkDensity = paragraph.text.length ? paragraph.charsInLinks / paragraph.text.length : 0;
      const cjkCharacters = (paragraph.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
      const visibleCharacters = paragraph.text.replace(/\s/g, "").length;
      const cjkShare = visibleCharacters ? cjkCharacters / visibleCharacters : 0;
      const cjkSentenceMarks = (paragraph.text.match(/[。！？.!?]/g) || []).length;
      const cjkClauseMarks = (paragraph.text.match(/[，、；：]/g) || []).length;
      if (linkDensity > 0.25 || /©|&copy/i.test(paragraph.text) || paragraph.path.includes("select")) paragraph.cfClass = "bad";
      else if (cjkShare >= 0.3) {
        if (paragraph.text.length < 24) paragraph.cfClass = paragraph.charsInLinks ? "bad" : "short";
        else if (paragraph.text.length >= 80 && (cjkSentenceMarks > 0 || cjkClauseMarks >= 2)) paragraph.cfClass = "good";
        else if (paragraph.text.length >= 40 && (cjkSentenceMarks > 0 || cjkClauseMarks > 0)) paragraph.cfClass = "neargood";
        else paragraph.cfClass = "short";
      }
      else if (paragraph.text.length < 50) paragraph.cfClass = paragraph.charsInLinks ? "bad" : "short";
      else if (stopDensity >= 0.2) paragraph.cfClass = paragraph.text.length > 150 ? "good" : "neargood";
      else if (stopDensity >= 0.1) paragraph.cfClass = "neargood";
      else paragraph.cfClass = "bad";
      paragraph.classType = paragraph.cfClass;
    }

    const neighbour = (index: number, direction: number, ignoreNearGood: boolean) => {
      for (let next = index + direction; next >= 0 && next < paragraphs.length; next += direction) {
        const type = paragraphs[next].classType;
        if (type === "good" || type === "bad") return type;
        if (type === "neargood" && !ignoreNearGood) return type;
      }
      return "bad";
    };
    const updates = new Map<number, string>();
    paragraphs.forEach((paragraph, index) => {
      if (paragraph.classType !== "short") return;
      const previous = neighbour(index, -1, true);
      const next = neighbour(index, 1, true);
      if (previous === "good" && next === "good") updates.set(index, "good");
      else if (previous === "bad" && next === "bad") updates.set(index, "bad");
      else if ((previous === "bad" && neighbour(index, -1, false) === "neargood")
        || (next === "bad" && neighbour(index, 1, false) === "neargood")) updates.set(index, "good");
      else updates.set(index, "bad");
    });
    updates.forEach((value, index) => { paragraphs[index].classType = value; });
    paragraphs.forEach((paragraph, index) => {
      if (paragraph.classType !== "neargood") return;
      paragraph.classType = neighbour(index, -1, true) === "bad" && neighbour(index, 1, true) === "bad" ? "bad" : "good";
    });
    return paragraphs;
  }

  function paragraphRescue(doc: Document) {
    const cloned = cloneDocument(doc);
    if (!cloned?.body) return null;
    if (!isForumThreadPage(doc)) removeCommentSections(cloned);
    basicClean(cloned.body);
    const paragraphs = classifyParagraphs(collectParagraphs(cloned.body)).filter(item => item.classType === "good");
    if (!paragraphs.length) return null;
    const wrapper = createWrapper(cloned);
    paragraphs.forEach(item => {
      const paragraph = cloned.createElement("p");
      paragraph.textContent = item.text;
      wrapper.append(paragraph);
    });
    return makeCandidate("paragraph-rescue", wrapper);
  }

  function basicClean(root: QueryRoot) {
    safeQueryAll(root, "aside,footer,script,style,svg,template,fencedframe").forEach(element => element.remove());
    for (const element of safeQueryAll(root, "*")) {
      const marker = `${element.id || ""} ${element.className || ""}`;
      if (COOKIE_BANNER_RE.test(marker)) element.remove();
    }
    return root;
  }

  function blockAwareText(root: QueryRoot) {
    if (!root) return "";
    const clone = root.cloneNode(true) as QueryRoot;
    const doc = root.ownerDocument || root as Document;
    for (const element of safeQueryAll(clone, "*")) {
      if (!BLOCK_TAGS.has(element.tagName)) continue;
      element.prepend(doc.createTextNode(" "));
      element.append(doc.createTextNode(" "));
    }
    return textOf(clone);
  }

  function renderEmbeddedText(doc: Document, value: unknown) {
    const decoder = doc.createElement("textarea");
    decoder.innerHTML = String(value || "");
    const decoded = decoder.value;
    if (!/<\/?(?:a|article|blockquote|br|code|div|h[1-6]|li|ol|p|pre|q|section|span|strong|table|td|th|tr|ul)(?:\s[^<>]*=[^<>]*)?\s*\/?\s*>/i.test(decoded)) {
      return normalizedText(decoded);
    }
    const wrapper = doc.createElement("div");
    wrapper.innerHTML = decoded;
    return textOf(wrapper);
  }

  function walkJsonContent(node: unknown, bodies: string[], teasers: string[]): void {
    const items: unknown[] = Array.isArray(node) ? node : [node];
    for (const raw of items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = record(raw);
      for (const key of ["articleBody", "reviewBody"]) {
        if (typeof item[key] === "string" && item[key]) bodies.push(item[key]);
      }
      for (const key of ["recipeInstructions", "step"]) {
        const steps: unknown[] = Array.isArray(item[key]) ? item[key] : [item[key]];
        for (const step of steps) {
          if (typeof step === "string") bodies.push(step);
          else if (step && typeof step === "object") {
            const list = record(step).itemListElement;
            const nested: unknown[] = [step, ...(Array.isArray(list) ? list : [list])];
            nested.forEach(value => {
              const text = record(value).text;
              if (typeof text === "string") bodies.push(text);
            });
          }
        }
      }
      const answer = record(item.acceptedAnswer).text;
      if (typeof answer === "string") bodies.push(answer);
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (types.some(type => String(type || "").includes("Product") || String(type || "").includes("VideoObject"))
        && typeof item.description === "string") {
        teasers.push(item.description);
      }
      walkJsonContent(item["@graph"], bodies, teasers);
      walkJsonContent(item.mainEntity, bodies, teasers);
    }
  }

  function collectJsonContent(doc: Document) {
    const bodies: string[] = [];
    const teasers: string[] = [];
    for (const script of safeQueryAll(doc, 'script[type="application/ld+json"]')) {
      const raw = script.textContent || "";
      if (!/articleBody|reviewBody|recipeInstructions|acceptedAnswer|"Product"|"VideoObject"|"HowTo"/.test(raw)) continue;
      try { walkJsonContent(JSON.parse(raw), bodies, teasers); } catch (_err) {}
    }
    const preloaded = doc.querySelector?.("#data-preloaded")?.getAttribute("data-preloaded");
    if (preloaded) {
      try {
        const data = JSON.parse(preloaded);
        for (const [key, value] of Object.entries(data || {})) {
          if (!key.startsWith("topic_") || typeof value !== "string") continue;
          const posts: unknown = JSON.parse(value)?.post_stream?.posts;
          if (Array.isArray(posts)) posts.forEach((post: unknown) => { const cooked = record(post).cooked; if (typeof cooked === "string") bodies.push(cooked); });
        }
      } catch (_err) {}
    }
    return { bodies, teasers };
  }

  function attemptTexts(doc: Document, name: string, values: string[], { dedupe = false } = {}) {
    const wrapper = createWrapper(doc);
    let accumulated = "";
    for (const raw of values) {
      const text = normalizedText(raw);
      if (!text) continue;
      if (dedupe && text.length > MIN_DUPLICATE_LENGTH && accumulated.length <= DEDUPE_SCAN_CAP && accumulated.includes(text)) continue;
      const paragraph = doc.createElement("p");
      paragraph.textContent = text;
      wrapper.append(paragraph);
      accumulated += `${accumulated ? "\n" : ""}${text}`;
    }
    return accumulated.length > MIN_CONTENT_LENGTH ? makeCandidate(name, wrapper) : null;
  }

  function baseline(doc: Document) {
    const cloned = cloneDocument(doc);
    if (!cloned?.body) return null;
    if (!isForumThreadPage(doc)) removeCommentSections(cloned);
    const { bodies, teasers } = collectJsonContent(cloned);
    const json = attemptTexts(cloned, "baseline-json", bodies.map(value => renderEmbeddedText(cloned, value)), { dedupe: true });
    if (json) return json;

    basicClean(cloned.body);
    const articles = safeQueryAll(cloned, "article")
      .filter(element => !element.parentElement?.closest("article"))
      .map(element => ({ element, text: textOf(element) }))
      .filter(item => item.text.length > MIN_CONTENT_LENGTH);
    if (articles.length) {
      const cutoff = Math.max(...articles.map(item => item.text.length)) / 5;
      const result = attemptTexts(cloned, "baseline-article", articles.filter(item => item.text.length >= cutoff).map(item => item.text));
      if (result) return result;
    }

    const paragraphValues = safeQueryAll(cloned, "blockquote,code,p,pre,q").map(textOf);
    const paragraphs = attemptTexts(cloned, "baseline-paragraphs", paragraphValues, { dedupe: true });
    if (paragraphs) return paragraphs;

    const teaser = attemptTexts(cloned, "baseline-teaser", teasers.map(value => renderEmbeddedText(cloned, value)), { dedupe: true });
    const bodyText = blockAwareText(cloned.body);
    if (bodyText && (!teaser || bodyText.length >= teaser.length)) {
      const wrapper = createWrapper(cloned);
      const paragraph = cloned.createElement("p");
      paragraph.textContent = bodyText;
      wrapper.append(paragraph);
      return makeCandidate("baseline-body", wrapper);
    }
    return teaser;
  }

  function pageTextLength(doc: Document) {
    const cloned = cloneDocument(doc);
    if (!cloned?.body) return 0;
    if (!isForumThreadPage(doc)) removeCommentSections(cloned);
    basicClean(cloned.body);
    return blockAwareText(cloned.body).length;
  }

  function treeDpTokens(text: string) {
    const han = (text.match(TREE_DP_HAN_RE) || []).length;
    const words = (text.replace(TREE_DP_HAN_RE, " ").match(TREE_DP_WORD_RE) || []).length;
    return han + words;
  }

  function hanDominantDocument(doc: Document) {
    const sample = normalizedText(String(doc.body?.textContent || "").slice(0, 60_000));
    const han = (sample.match(TREE_DP_HAN_RE) || []).length;
    const words = (sample.replace(TREE_DP_HAN_RE, " ").match(TREE_DP_WORD_RE) || []).length;
    const tokens = han + words;
    return tokens >= TREE_DP_GATE_MIN_TOKENS && han / tokens >= TREE_DP_HAN_GATE_SHARE;
  }

  function treeDpMaterializedStats(root: Element) {
    let tokens = 0;
    let anchorTokens = 0;
    let boilerplateTokens = 0;
    (function visit(element: Element, state: { anchor: boolean; boilerplate: boolean }) {
      const tag = element.tagName ? element.tagName.toLowerCase() : "";
      const classId = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
      const next = {
        anchor: state.anchor || tag === "a",
        boilerplate: state.boilerplate || TREE_DP_BOILER_RE.test(classId),
      };
      const ownRaw = [];
      for (const child of element.childNodes) {
        if (child.nodeType === 3) {
          if (child.textContent) ownRaw.push(child.textContent);
        } else if (child.nodeType === 1) {
          visit(child as Element, next);
        }
      }
      const ownTokens = treeDpTokens(normalizedText(ownRaw.join("")));
      tokens += ownTokens;
      if (next.anchor) anchorTokens += ownTokens;
      if (next.boilerplate) boilerplateTokens += ownTokens;
    })(root, { anchor: false, boilerplate: false });
    return { tokens, anchorTokens, boilerplateTokens };
  }

  function treeDpClip(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function treeDpReadabilityComponents(nodes: TreeNode[], children: number[][], ownText: string[]) {
    const total = nodes.length;
    const subtreeChars = new Float64Array(total);
    const subtreeCommas = new Float64Array(total);
    const subtreeAnchorChars = new Float64Array(total);
    const blockDescendant = new Uint8Array(total);
    const commaRe = /[,،﹐︐︑⹁⸴⸲，]/g;
    for (let index = 0; index < total; index += 1) {
      const chars = ownText[index].length;
      subtreeChars[index] = chars;
      subtreeCommas[index] = (ownText[index].match(commaRe) || []).length;
      subtreeAnchorChars[index] = nodes[index].anchor ? chars : 0;
    }
    for (let index = total - 1; index >= 0; index -= 1) {
      for (const child of children[index]) {
        subtreeChars[index] += subtreeChars[child];
        subtreeCommas[index] += subtreeCommas[child];
        subtreeAnchorChars[index] += subtreeAnchorChars[child];
        if (TREE_DP_READABILITY_BLOCK_TAGS.has(nodes[child].tag)
          || blockDescendant[child]) blockDescendant[index] = 1;
      }
    }

    const evidence = new Float64Array(total);
    const initialized = new Uint8Array(total);
    for (let index = 0; index < total; index += 1) {
      const node = nodes[index];
      const pseudoParagraph = node.tag === "div" && !blockDescendant[index];
      if (!TREE_DP_READABILITY_SCORE_TAGS.has(node.tag) && !pseudoParagraph) continue;
      const chars = subtreeChars[index];
      if (chars < 25) continue;
      const contribution = 1 + subtreeCommas[index] + Math.min(Math.floor(chars / 100), 3);
      let ancestor = node.parent;
      for (let depth = 0; depth < 5 && ancestor >= 0; depth += 1) {
        const divisor = depth === 0 ? 1 : depth === 1 ? 2 : 3 * depth;
        evidence[ancestor] += contribution / divisor;
        initialized[ancestor] = 1;
        ancestor = nodes[ancestor].parent;
      }
    }

    const tag = new Float64Array(total);
    const classWeight = new Float64Array(total);
    const linkFactor = new Float64Array(total);
    const raw = new Float64Array(total);
    const full = new Float64Array(total);
    linkFactor.fill(1);
    for (let index = 0; index < total; index += 1) {
      if (!initialized[index]) continue;
      tag[index] = TREE_DP_READABILITY_TAG_PRIOR[nodes[index].tag] || 0;
      classWeight[index] = nodes[index].readabilityClassWeight;
      const density = subtreeChars[index]
        ? subtreeAnchorChars[index] / subtreeChars[index]
        : 0;
      linkFactor[index] = 1 - treeDpClip(density, 0, 1);
      raw[index] = evidence[index] + tag[index] + classWeight[index];
      full[index] = raw[index] * linkFactor[index];
    }
    return {
      evidence, tag, classWeight, linkFactor, raw, full,
      subtreeChars, subtreeAnchorChars,
    };
  }

  function treeDpReadabilityScope(nodes: TreeNode[], children: number[][], components: ReturnType<typeof treeDpReadabilityComponents>) {
    const total = nodes.length;
    const candidates = [];
    for (let index = 0; index < total; index += 1) {
      if (components.evidence[index] > 0 && components.full[index] > 0) candidates.push(index);
    }
    candidates.sort((left, right) => (
      components.full[right] - components.full[left] || left - right
    ));
    const top = candidates.slice(0, 5);
    let primary = top.length ? top[0] : -1;
    let scope = -1;
    if (primary >= 0) {
      const corroborating = [];
      const primaryScore = components.full[primary];
      for (const candidate of top.slice(1)) {
        if (components.full[candidate] / primaryScore < 0.75) continue;
        const ancestors = new Set();
        let ancestor = nodes[candidate].parent;
        while (ancestor >= 0) {
          ancestors.add(ancestor);
          ancestor = nodes[ancestor].parent;
        }
        corroborating.push(ancestors);
      }
      if (corroborating.length >= 3) {
        let ancestor = nodes[primary].parent;
        while (ancestor >= 0 && nodes[ancestor].tag !== "body") {
          if (corroborating.filter(values => values.has(ancestor)).length >= 3) {
            primary = ancestor;
            break;
          }
          ancestor = nodes[ancestor].parent;
        }
      }
      let lastScore = components.evidence[primary] > 0 ? components.full[primary] : 0;
      const threshold = lastScore / 3;
      let ancestor = nodes[primary].parent;
      while (ancestor >= 0 && nodes[ancestor].tag !== "body") {
        if (components.evidence[ancestor] > 0) {
          const score = components.full[ancestor];
          if (score < threshold) break;
          if (score > lastScore) {
            primary = ancestor;
            break;
          }
          lastScore = score;
        }
        ancestor = nodes[ancestor].parent;
      }
      ancestor = nodes[primary].parent;
      while (ancestor >= 0
        && nodes[ancestor].tag !== "body"
        && children[ancestor].length === 1) {
        primary = ancestor;
        ancestor = nodes[primary].parent;
      }
      scope = nodes[primary].parent >= 0 ? nodes[primary].parent : primary;
    }

    const topMask = new Uint8Array(total);
    for (const index of top) topMask[index] = 1;
    const subtreePositiveMass = Float64Array.from(components.full, value => Math.max(0, value));
    const subtreeTopMass = Float64Array.from(
      components.full,
      (value, index) => topMask[index] ? Math.max(0, value) : 0,
    );
    const subtreeTopCount = Float64Array.from(topMask);
    for (let index = total - 1; index >= 1; index -= 1) {
      const parent = nodes[index].parent;
      subtreePositiveMass[parent] += subtreePositiveMass[index];
      subtreeTopMass[parent] += subtreeTopMass[index];
      subtreeTopCount[parent] += subtreeTopCount[index];
    }
    const primaryScope = new Float64Array(total);
    const scopeScore = new Float64Array(total);
    const scopePrior = new Float64Array(total);
    if (primary >= 0 && scope >= 0) {
      primaryScope[scope] = 1;
      scopeScore[scope] = Math.min(4, Math.max(0, components.full[primary]) / 25);
      scopePrior[scope] = Math.max(0, components.full[primary]);
    }
    const totalTopMass = Math.max(1e-12, top.reduce(
      (sum, index) => sum + Math.max(0, components.full[index]), 0,
    ));
    const totalTopCount = Math.max(1, top.length);
    let totalPositiveMass = 0;
    for (const value of components.full) totalPositiveMass += Math.max(0, value);
    totalPositiveMass = Math.max(1e-12, totalPositiveMass);
    return {
      primaryScope,
      scopeScore,
      topMassCoverage: Float64Array.from(
        subtreeTopMass,
        value => treeDpClip(value / totalTopMass, 0, 1),
      ),
      topCountCoverage: Float64Array.from(
        subtreeTopCount,
        value => treeDpClip(value / totalTopCount, 0, 1),
      ),
      positiveMassCoverage: Float64Array.from(
        subtreePositiveMass,
        value => treeDpClip(value / totalPositiveMass, 0, 1),
      ),
      scopePrior,
    };
  }

  function treeDpScaledAction(row: ArrayLike<number>, model: ActionModel) {
    const result = new Float64Array(row.length);
    for (let index = 0; index < row.length; index += 1) {
      result[index] = treeDpClip(
        (row[index] - model.scalingMean[index]) / model.scalingScale[index],
        -8,
        8,
      );
    }
    return result;
  }

  function treeDpActionResidual(values: ArrayLike<number>, model: ActionModel) {
    const dimensions = TREE_DP_ACTION_MODEL_ARTIFACT.dimensions;
    const width = TREE_DP_ACTION_MODEL_ARTIFACT.width;
    const hidden = new Float64Array(width);
    for (let output = 0; output < width; output += 1) {
      let value = model.rootInputBias[output];
      const offset = output * dimensions;
      for (let input = 0; input < dimensions; input += 1) {
        value += model.rootInputWeight[offset + input] * values[input];
      }
      hidden[output] = Math.tanh(value);
    }
    let raw = model.rootOutputBias;
    for (let index = 0; index < width; index += 1) {
      raw += model.rootOutputWeight[index] * hidden[index];
    }
    const bound = TREE_DP_ACTION_MODEL_ARTIFACT.residualBound;
    return bound * Math.tanh(raw / bound);
  }

  function treeDpEmptyActionScore(mean: ArrayLike<number>, maximum: ArrayLike<number>, model: ActionModel) {
    const dimensions = TREE_DP_ACTION_MODEL_ARTIFACT.dimensions;
    const width = TREE_DP_ACTION_MODEL_ARTIFACT.width;
    const hidden = new Float64Array(width);
    for (let output = 0; output < width; output += 1) {
      let value = model.emptyInputBias[output];
      const offset = output * dimensions * 2;
      for (let input = 0; input < dimensions; input += 1) {
        value += model.emptyInputWeight[offset + input] * mean[input];
        value += model.emptyInputWeight[offset + dimensions + input] * maximum[input];
      }
      hidden[output] = Math.tanh(value);
    }
    let raw = model.emptyOutputBias;
    for (let index = 0; index < width; index += 1) {
      raw += model.emptyOutputWeight[index] * hidden[index];
    }
    const bound = TREE_DP_ACTION_MODEL_ARTIFACT.residualBound;
    return bound * Math.tanh(raw / bound);
  }

  function treeDpExtract(doc: Document) {
    const body = doc?.body;
    if (!body) return null;

    const model = treeDpActionModel();
    const nodes: TreeNode[] = [];
    const siblingSignatureCounts = new WeakMap<Element, Map<string, number>>();
    const repeatedSiblingCount = (element: Element) => {
      const parent = element.parentElement;
      if (!parent) return 1;
      let counts = siblingSignatureCounts.get(parent);
      if (!counts) {
        counts = new Map();
        for (const sibling of parent.children) {
          const signature = `${sibling.tagName}|${typeof sibling.className === "string" ? sibling.className : ""}`;
          counts.set(signature, (counts.get(signature) || 0) + 1);
        }
        siblingSignatureCounts.set(parent, counts);
      }
      const signature = `${element.tagName}|${typeof element.className === "string" ? element.className : ""}`;
      return counts.get(signature) || 1;
    };
    (function visit(element: Element, parentIndex: number, childIndex: number, state: TraversalState) {
      if (element.matches?.(TREE_DP_REMOVED_SELECTOR)) return;
      if (("hidden" in element && element.hidden) || element.getAttribute?.("aria-hidden") === "true") return;
      const inlineStyle = element.getAttribute?.("style") || "";
      if (/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(inlineStyle)) return;
      const tag = element.tagName ? element.tagName.toLowerCase() : "";
      const headingMatch = /^h([1-6])$/.exec(tag);
      const className = typeof element.className === "string" ? element.className : "";
      const id = String(element.id || "");
      const classId = `${id} ${className}`;
      let readabilityClassWeight = 0;
      let readabilityPositiveHits = 0;
      let readabilityNegativeHits = 0;
      for (const value of [className, id]) {
        if (!value) continue;
        if (TREE_DP_READABILITY_RE.negative.test(value)) {
          readabilityClassWeight -= 25;
          readabilityNegativeHits += 1;
        }
        if (TREE_DP_READABILITY_RE.positive.test(value)) {
          readabilityClassWeight += 25;
          readabilityPositiveHits += 1;
        }
      }
      const readabilityOkMaybe = TREE_DP_READABILITY_RE.okMaybe.test(classId);
      const repeated = repeatedSiblingCount(element);
      const next = {
        anchor: state.anchor || tag === "a",
        listItem: state.listItem || tag === "li" || tag === "dt" || tag === "dd",
        boilerplateHits: state.boilerplateHits + (TREE_DP_BOILER_RE.test(classId) ? 1 : 0),
        contentHits: state.contentHits + (TREE_DP_CONTENT_RE.test(classId) ? 1 : 0),
        depth: state.depth + 1,
      };
      const index = nodes.length;
      nodes.push({
        element, parent: parentIndex, childIndex, tag,
        anchor: next.anchor, heading: headingMatch ? Number(headingMatch[1]) : 0,
        listItem: next.listItem, boilerplateHits: next.boilerplateHits,
        contentHits: next.contentHits, repeated, depth: next.depth,
        readabilityClassWeight,
        readabilityPositiveHits,
        readabilityNegativeHits,
        readabilityOkMaybe,
        readabilityExtraneous: TREE_DP_READABILITY_RE.extraneous.test(classId),
        readabilityByline: TREE_DP_READABILITY_RE.byline.test(classId),
        readabilityShare: TREE_DP_READABILITY_RE.share.test(classId),
        readabilityUnlikely: tag !== "body" && tag !== "a"
          && TREE_DP_READABILITY_RE.unlikely.test(`${className} ${id}`)
          && !TREE_DP_READABILITY_RE.okMaybe.test(`${className} ${id}`)
          && !element.parentElement?.closest?.("table,code"),
        readabilityRoleRejected: TREE_DP_READABILITY_REJECTED_ROLES.has(
          String(element.getAttribute?.("role") || "").toLowerCase(),
        ),
        ownRaw: [],
      });
      let elementChildIndex = 0;
      for (const child of element.childNodes) {
        if (child.nodeType === 3) {
          if (child.textContent) nodes[index].ownRaw.push(child.textContent);
        } else if (child.nodeType === 1) {
          visit(child as Element, index, elementChildIndex, next);
          elementChildIndex += 1;
        }
      }
    })(body, -1, -1, {
      anchor: false,
      listItem: false,
      boilerplateHits: 0,
      contentHits: 0,
      depth: 0,
    });

    const total = nodes.length;
    if (!total) return null;
    const ownText = new Array(total);
    const ownTokens = new Array(total);
    let pageTokens = 0;
    let anchorTokens = 0;
    for (let index = 0; index < total; index += 1) {
      const value = normalizedText(nodes[index].ownRaw.join(""));
      ownText[index] = value;
      ownTokens[index] = treeDpTokens(value);
      pageTokens += ownTokens[index];
      if (nodes[index].anchor) anchorTokens += ownTokens[index];
    }
    const anchorShare = pageTokens ? anchorTokens / pageTokens : 0;

    const baseFeatures = new Array(total);
    for (let index = 0; index < total; index += 1) {
      const tokens = ownTokens[index];
      const node = nodes[index];
      const text = ownText[index];
      const chars = text.length;
      let category;
      if (node.heading) category = "h";
      else if (node.tag === "p") category = "p";
      else if (node.listItem && node.anchor) category = "a-ctx";
      else if (node.listItem) category = "li";
      else if (node.tag === "td" || node.tag === "th") category = "td";
      else if (node.anchor) category = "a-ctx";
      else category = "other";
      baseFeatures[index] = [
        category === "p" ? 1 : 0,
        category === "h" ? 1 : 0,
        category === "li" ? 1 : 0,
        category === "td" ? 1 : 0,
        category === "a-ctx" ? 1 : 0,
        category === "other" ? 1 : 0,
        node.anchor ? 1 : 0,
        Math.log1p(tokens),
        tokens ? (text.match(TREE_DP_PUNCT_RE) || []).length / tokens : 0,
        chars ? (text.match(TREE_DP_DIGIT_RE) || []).length / chars : 0,
        Math.min(3, node.boilerplateHits),
        Math.min(3, node.contentHits),
        Math.log1p(node.repeated),
        Math.min(30, node.depth) / 30,
        anchorShare,
        (node.anchor ? 1 : 0) * anchorShare,
      ];
    }

    const children: number[][] = Array.from({ length: total }, () => []);
    for (let index = 1; index < total; index += 1) children[nodes[index].parent].push(index);
    const subtreeTokens = ownTokens.slice();
    for (let index = total - 1; index >= 1; index -= 1) {
      subtreeTokens[nodes[index].parent] += subtreeTokens[index];
    }

    const readability = treeDpReadabilityComponents(nodes, children, ownText);
    const scope = treeDpReadabilityScope(nodes, children, readability);
    const ancestorClass = new Float64Array(total);
    const ancestorUnlikely = new Float64Array(total);
    const ancestorRoleRejected = new Float64Array(total);
    for (let index = 0; index < total; index += 1) {
      const parent = nodes[index].parent;
      ancestorClass[index] = nodes[index].readabilityClassWeight / 25
        + (parent >= 0 ? ancestorClass[parent] : 0);
      ancestorUnlikely[index] = Math.max(
        Number(nodes[index].readabilityUnlikely),
        parent >= 0 ? ancestorUnlikely[parent] : 0,
      );
      ancestorRoleRejected[index] = Math.max(
        Number(nodes[index].readabilityRoleRejected),
        parent >= 0 ? ancestorRoleRejected[parent] : 0,
      );
    }

    const score = new Float64Array(total);
    const pageChars = Math.max(1, readability.subtreeChars[0]);
    for (let index = 0; index < total; index += 1) {
      const tokens = ownTokens[index];
      if (!tokens) continue;
      let logit = TREE_DP_INTERCEPT;
      const features = baseFeatures[index];
      for (let column = 0; column < features.length; column += 1) {
        logit += TREE_DP_COEFFICIENTS[column] * features[column];
      }
      const rich = [
        treeDpClip(ancestorClass[index], -3, 3),
        ancestorUnlikely[index],
        nodes[index].readabilityClassWeight / 25,
        Number(nodes[index].readabilityUnlikely),
        ancestorRoleRejected[index],
        Math.log1p(Math.max(0, readability.evidence[index])),
        readability.tag[index] / 5,
        readability.linkFactor[index],
        treeDpClip(readability.raw[index] / 25, -4, 4),
        treeDpClip(readability.full[index] / 25, -4, 4),
        treeDpClip(readability.subtreeChars[index] / pageChars, 0, 1),
      ];
      for (let column = 0; column < rich.length; column += 1) {
        logit += model.localBeta[column] * rich[column];
      }
      score[index] = tokens * logit;
    }

    // keep[v]: value of v's subtree inside a kept region, carving negative child
    // subtrees at a fixed penalty. The ordinary forest remains an explicit
    // zero-energy action; every legal single root competes with it globally.
    const keep = new Float64Array(total);
    const keepChoice = new Array(total);
    const keptTokens = Float64Array.from(ownTokens);
    for (let index = total - 1; index >= 0; index -= 1) {
      let kept = score[index];
      let selectedTokens = ownTokens[index];
      const choices = [];
      for (const child of children[index]) {
        const excludePenalty = TREE_DP_EXCLUDE_PENALTY * Math.min(
          1,
          subtreeTokens[child] / TREE_DP_MIN_EXCLUDE_TOKENS,
        );
        if (keep[child] >= -excludePenalty) {
          kept += keep[child];
          choices.push(true);
          selectedTokens += keptTokens[child];
        } else {
          kept += -excludePenalty;
          choices.push(false);
        }
      }
      keep[index] = kept;
      keepChoice[index] = choices;
      keptTokens[index] = selectedTokens;
    }

    const feasible = new Uint8Array(total);
    for (let index = 0; index < total; index += 1) {
      feasible[index] = Number(
        keptTokens[index] >= TREE_DP_GUARD_MIN_TOKENS
        && !TREE_DP_PARENT_DEPENDENT_ROOT_TAGS.has(nodes[index].tag),
      );
    }

    const free = new Float64Array(total);
    const freeRoot = new Uint8Array(total);
    for (let index = total - 1; index >= 0; index -= 1) {
      let descend = 0;
      for (const child of children[index]) descend += free[child];
      const asRoot = feasible[index]
        ? keep[index] - TREE_DP_ROOT_PENALTY
        : -Infinity;
      if (asRoot >= descend && asRoot > 0) {
        free[index] = asRoot;
        freeRoot[index] = 1;
      } else {
        free[index] = Math.max(0, descend);
      }
    }

    const ordinaryMask = new Uint8Array(total);
    const ordinaryRoots = [];
    const rootsStack = [0];
    while (rootsStack.length) {
      const index = rootsStack.pop()!;
      if (freeRoot[index]) {
        ordinaryRoots.push(index);
        const keepStack = [index];
        while (keepStack.length) {
          const current = keepStack.pop()!;
          ordinaryMask[current] = 1;
          const choices = keepChoice[current];
          const kids = children[current];
          for (let j = 0; j < kids.length; j += 1) {
            if (choices[j]) keepStack.push(kids[j]);
          }
        }
      } else {
        for (const child of children[index]) rootsStack.push(child);
      }
    }

    let ordinaryRetainedTokens = 0;
    for (let index = 0; index < total; index += 1) {
      if (ordinaryMask[index]) ordinaryRetainedTokens += ownTokens[index];
    }
    const ordinaryAvailable = ordinaryRetainedTokens >= TREE_DP_GUARD_MIN_TOKENS;
    const ordinaryRootSet = new Set(ordinaryRoots);

    const readabilityScope = Array.from({ length: 7 }, () => new Float64Array(total));
    for (let index = 0; index < total; index += 1) {
      const direct = [
        treeDpClip(nodes[index].readabilityPositiveHits / 2, 0, 1),
        treeDpClip(nodes[index].readabilityNegativeHits / 2, 0, 1),
        Number(nodes[index].readabilityUnlikely),
        Number(nodes[index].readabilityExtraneous),
        Number(nodes[index].readabilityByline),
        Number(nodes[index].readabilityShare),
        Number(nodes[index].readabilityRoleRejected),
      ];
      const parent = nodes[index].parent;
      for (let column = 0; column < direct.length; column += 1) {
        readabilityScope[column][index] = Math.max(
          direct[column],
          parent >= 0 ? readabilityScope[column][parent] : 0,
        );
      }
    }

    const additive = Array.from({ length: 25 }, () => new Float64Array(total));
    const maximumRepeat = new Float64Array(total);
    for (let index = 0; index < total; index += 1) {
      const tokens = ownTokens[index];
      const feature = baseFeatures[index];
      const tag = nodes[index].tag;
      additive[0][index] = tokens;
      additive[1][index] = tokens * feature[6];
      additive[2][index] = tokens * Number(feature[10] > 0);
      additive[3][index] = tokens * Number(feature[11] > 0);
      for (let column = 0; column < 7; column += 1) {
        additive[4 + column][index] = tokens * readabilityScope[column][index];
      }
      additive[11][index] = tokens * feature[0];
      additive[12][index] = tokens * feature[1];
      additive[13][index] = tokens * feature[2];
      additive[14][index] = tokens * feature[3];
      additive[15][index] = tokens * feature[8];
      additive[16][index] = 1;
      additive[17][index] = Number(tag === "p");
      additive[18][index] = Number(/^h[1-6]$/.test(tag));
      additive[19][index] = Number(tag === "a");
      additive[20][index] = Number(tag === "li" || tag === "dt" || tag === "dd");
      additive[21][index] = Number(tag === "table" || tag === "tr" || tag === "td" || tag === "th");
      additive[22][index] = Number(tag === "img" || tag === "picture" || tag === "figure");
      additive[23][index] = Number(
        tag === "button" || tag === "form" || tag === "input"
        || tag === "select" || tag === "textarea",
      );
      additive[24][index] = tokens * feature[12];
      maximumRepeat[index] = feature[12];
    }
    for (let index = total - 1; index >= 0; index -= 1) {
      const kids = children[index];
      for (let offset = 0; offset < kids.length; offset += 1) {
        if (!keepChoice[index][offset]) continue;
        const child = kids[offset];
        for (let column = 0; column < additive.length; column += 1) {
          additive[column][index] += additive[column][child];
        }
        maximumRepeat[index] = Math.max(maximumRepeat[index], maximumRepeat[child]);
      }
    }

    const currentEnergy = new Float64Array(total);
    for (let index = 0; index < total; index += 1) {
      currentEnergy[index] = keep[index] - TREE_DP_ROOT_PENALTY
        + 0.25 * readability.raw[index]
        + TREE_DP_ACTION_MODEL_ARTIFACT.scopePriorWeight * scope.scopePrior[index];
    }
    const rootFeatureFree = new Float64Array(total);
    const rootDecisionMargin = new Float64Array(total);
    rootDecisionMargin.fill(-4);
    for (let index = total - 1; index >= 0; index -= 1) {
      let descend = 0;
      for (const child of children[index]) descend += rootFeatureFree[child];
      if (feasible[index]) {
        rootDecisionMargin[index] = treeDpClip(
          (currentEnergy[index] - descend)
            / Math.max(TREE_DP_GUARD_MIN_TOKENS, keptTokens[index]),
          -4,
          4,
        );
        rootFeatureFree[index] = Math.max(0, descend, currentEnergy[index]);
      } else {
        rootFeatureFree[index] = Math.max(0, descend);
      }
    }

    const keptOrdinaryTokens = new Float64Array(total);
    for (let index = 0; index < total; index += 1) {
      keptOrdinaryTokens[index] = ordinaryMask[index] ? ownTokens[index] : 0;
    }
    for (let index = total - 1; index >= 0; index -= 1) {
      const kids = children[index];
      for (let offset = 0; offset < kids.length; offset += 1) {
        if (keepChoice[index][offset]) {
          keptOrdinaryTokens[index] += keptOrdinaryTokens[kids[offset]];
        }
      }
    }

    const rootIndices = [];
    let bestEnergy = 0;
    for (let index = 0; index < total; index += 1) {
      if (!feasible[index]) continue;
      rootIndices.push(index);
      bestEnergy = Math.max(bestEnergy, currentEnergy[index]);
    }
    if (!rootIndices.length && !ordinaryAvailable) return null;

    let paragraphCount = 0;
    let headingCount = 0;
    let listItemCount = 0;
    let tableCount = 0;
    let maximumEvidence = 0;
    let positiveReadabilityMass = 0;
    for (let index = 0; index < total; index += 1) {
      const tag = nodes[index].tag;
      if (tag === "p") paragraphCount += 1;
      if (/^h[1-6]$/.test(tag)) headingCount += 1;
      if (tag === "li" || tag === "dt" || tag === "dd") listItemCount += 1;
      if (tag === "table" || tag === "tr" || tag === "td" || tag === "th") tableCount += 1;
      maximumEvidence = Math.max(maximumEvidence, readability.evidence[index]);
      positiveReadabilityMass += Math.max(0, readability.full[index]);
    }
    const pageContext = new Float64Array([
      Math.log1p(pageTokens) / 12,
      Math.log1p(total) / 12,
      Math.log1p(paragraphCount) / 8,
      Math.log1p(headingCount) / 8,
      Math.log1p(listItemCount) / 8,
      Math.log1p(tableCount) / 8,
      Math.log1p(Math.max(0, maximumEvidence)) / 8,
      Math.log1p(positiveReadabilityMass) / 12,
    ]);
    const ordinaryTotal = Math.max(1, ordinaryRetainedTokens);
    const ordinaryRootCountLog = Math.log1p(ordinaryRoots.length) / 4;
    const positionDenominator = Math.max(1, total - 1);

    const choiceFeature = (index: number) => {
      const retained = Math.max(1, additive[0][index]);
      const position = index / positionDenominator;
      return new Float64Array([
        treeDpClip((keep[index] - TREE_DP_ROOT_PENALTY)
          / Math.max(TREE_DP_GUARD_MIN_TOKENS, keptTokens[index]), -4, 4),
        Math.log1p(keptTokens[index]),
        treeDpClip(keptTokens[index] / Math.max(1, pageTokens), 0, 1),
        Math.log1p(Math.max(0, readability.evidence[index])),
        readability.tag[index] / 5,
        readability.classWeight[index] / 25,
        readability.linkFactor[index],
        treeDpClip(readability.raw[index] / 25, -4, 4),
        treeDpClip(readability.full[index] / 25, -4, 4),
        treeDpClip(ancestorClass[index], -3, 3) / 3,
        ancestorUnlikely[index],
        baseFeatures[index][10] / 3,
        baseFeatures[index][11] / 3,
        baseFeatures[index][12],
        baseFeatures[index][13],
        Number(nodes[index].tag === "body"),
        Number(nodes[index].tag === "main" || nodes[index].tag === "article"),
        Number(nodes[index].tag === "section"),
        Number(nodes[index].tag === "div"),
        Number(nodes[index].tag === "p" || nodes[index].tag === "table"),
        scope.primaryScope[index],
        scope.scopeScore[index],
        scope.topMassCoverage[index],
        scope.topCountCoverage[index],
        scope.positiveMassCoverage[index],
        treeDpClip(nodes[index].readabilityPositiveHits / 2, 0, 1),
        treeDpClip(nodes[index].readabilityNegativeHits / 2, 0, 1),
        Number(nodes[index].readabilityOkMaybe),
        additive[1][index] / retained,
        additive[2][index] / retained,
        additive[3][index] / retained,
        additive[4][index] / retained,
        additive[5][index] / retained,
        additive[6][index] / retained,
        additive[7][index] / retained,
        additive[8][index] / retained,
        additive[9][index] / retained,
        additive[10][index] / retained,
        additive[11][index] / retained,
        additive[12][index] / retained,
        additive[13][index] / retained,
        additive[14][index] / retained,
        additive[15][index] / retained,
        Math.log1p(additive[16][index]) / 10,
        Math.log1p(additive[17][index]) / 8,
        Math.log1p(additive[18][index]) / 8,
        Math.log1p(additive[19][index]) / 8,
        Math.log1p(additive[20][index]) / 8,
        Math.log1p(additive[21][index]) / 8,
        Math.log1p(additive[22][index]) / 8,
        Math.log1p(additive[23][index]) / 8,
        additive[24][index] / retained,
        maximumRepeat[index],
        treeDpClip(keptTokens[index] / Math.max(1, subtreeTokens[index]), 0, 1),
        position,
        1 - Math.abs(2 * position - 1),
        Math.log1p(children[index].length) / 8,
        rootDecisionMargin[index],
        treeDpClip(currentEnergy[index] / retained, -4, 4),
        treeDpClip(currentEnergy[index] / Math.max(1, pageTokens), -4, 4),
        1,
      ]);
    };

    const rootActionFeature = (index: number) => {
      const choice = choiceFeature(index);
      const retained = Math.max(1, keptTokens[index]);
      const intersection = ordinaryAvailable ? keptOrdinaryTokens[index] : 0;
      const result = new Float64Array(78);
      result.set(choice);
      result[61] = treeDpClip((currentEnergy[index] - bestEnergy) / TREE_DP_ROOT_PENALTY, -8, 0);
      result[62] = 0;
      result[63] = 0;
      result[64] = Number(ordinaryRootSet.has(index));
      result[65] = Number(ordinaryAvailable);
      result[66] = ordinaryRootCountLog;
      result[67] = treeDpClip(intersection / ordinaryTotal, 0, 1);
      result[68] = treeDpClip(intersection / retained, 0, 1);
      result[69] = treeDpClip(Math.log((retained + 1) / (ordinaryTotal + 1)), -8, 8) / 8;
      result.set(pageContext, 70);
      return result;
    };

    const ordinaryAction = new Float64Array(78);
    if (ordinaryAvailable && ordinaryRoots.length) {
      let totalWeight = 0;
      for (const root of ordinaryRoots) totalWeight += keptTokens[root];
      for (const root of ordinaryRoots) {
        const weight = keptTokens[root] / Math.max(1, totalWeight);
        const row = rootActionFeature(root);
        for (let column = 0; column < row.length; column += 1) {
          ordinaryAction[column] += weight * row[column];
        }
      }
    }
    ordinaryAction.set(pageContext, 70);
    ordinaryAction[61] = 0;
    ordinaryAction[62] = 0;
    ordinaryAction[63] = Number(ordinaryAvailable);
    ordinaryAction[64] = 0;
    ordinaryAction[65] = Number(ordinaryAvailable);
    ordinaryAction[66] = ordinaryRootCountLog;
    ordinaryAction[67] = Number(ordinaryAvailable);
    ordinaryAction[68] = Number(ordinaryAvailable);
    ordinaryAction[69] = 0;

    const differenceIndices = [
      3, 5, 6, 7, 8, 20, 21, 24, 28, 29, 30, 25, 26, 27, 31, 32,
      33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 51, 53, 54, 55, 57,
    ];
    const ordinaryRelation = new Float64Array(118);
    ordinaryRelation.set(ordinaryAction);
    ordinaryRelation[114] = 1;
    const relationFeature = (root: number) => {
      const row = rootActionFeature(root);
      const result = new Float64Array(118);
      result.set(row);
      for (let column = 0; column < differenceIndices.length; column += 1) {
        const source = differenceIndices[column];
        result[78 + column] = row[source] - ordinaryAction[source];
      }
      const retained = Math.max(1, keptTokens[root]);
      const intersection = ordinaryAvailable ? keptOrdinaryTokens[root] : 0;
      const recall = ordinaryAvailable ? intersection / ordinaryTotal : 0;
      const precision = intersection / retained;
      let kind;
      if (!ordinaryAvailable) kind = 0;
      else if (recall >= 1 - 1e-12 && precision >= 1 - 1e-12) kind = 4;
      else if (recall >= 1 - 1e-12) kind = 1;
      else if (precision >= 1 - 1e-12) kind = 2;
      else kind = 3;
      result[110 + kind] = 1;
      const added = Math.max(0, retained - intersection);
      const dropped = ordinaryAvailable ? Math.max(0, ordinaryTotal - intersection) : 0;
      const union = Math.max(1, retained + ordinaryTotal - intersection);
      result[115] = added / Math.max(1, pageTokens);
      result[116] = ordinaryAvailable ? dropped / ordinaryTotal : 0;
      result[117] = 1 - intersection / union;
      return result;
    };

    const pooledSum = new Float64Array(118);
    const pooledMaximum = new Float64Array(118);
    pooledMaximum.fill(-Infinity);
    let pooledCount = 0;
    const includeInPool = (values: Float64Array) => {
      pooledCount += 1;
      for (let column = 0; column < values.length; column += 1) {
        pooledSum[column] += values[column];
        pooledMaximum[column] = Math.max(pooledMaximum[column], values[column]);
      }
    };

    let selectedKind = null;
    let selectedRoot = -1;
    let selectedScore = -Infinity;
    if (ordinaryAvailable) {
      includeInPool(treeDpScaledAction(ordinaryRelation, model));
      selectedKind = "ordinary";
      selectedScore = 0;
    }
    for (const root of rootIndices) {
      const scaled = treeDpScaledAction(relationFeature(root), model);
      includeInPool(scaled);
      const energyOffset = treeDpClip(
        (currentEnergy[root] - bestEnergy) / TREE_DP_ROOT_PENALTY,
        -8,
        0,
      );
      const actionScore = TREE_DP_ACTION_MODEL_ARTIFACT.currentEnergyPrior * energyOffset
        + treeDpActionResidual(scaled, model);
      const eligible = ordinaryAvailable
        || keptTokens[root] >= TREE_DP_ACTION_MODEL_ARTIFACT.minimumRescueTokens
        || actionScore >= TREE_DP_ACTION_MODEL_ARTIFACT.shortRescueScore;
      if (eligible && actionScore > selectedScore) {
        selectedKind = "root";
        selectedRoot = root;
        selectedScore = actionScore;
      }
    }
    if (!pooledCount || !selectedKind) return null;
    const pooledMean = Float64Array.from(pooledSum, value => value / pooledCount);
    const emptyScore = treeDpEmptyActionScore(pooledMean, pooledMaximum, model);
    if (emptyScore >= selectedScore) return null;

    const retained = selectedKind === "ordinary"
      ? ordinaryMask
      : new Uint8Array(total);
    const includeRoots = selectedKind === "ordinary" ? [...ordinaryRoots] : [selectedRoot];
    if (selectedKind === "root") {
      const keepStack = [selectedRoot];
      while (keepStack.length) {
        const current = keepStack.pop()!;
        retained[current] = 1;
        const kids = children[current];
        for (let offset = 0; offset < kids.length; offset += 1) {
          if (keepChoice[current][offset]) keepStack.push(kids[offset]);
        }
      }
    }

    const excluded = [];
    const excludedByRoot = new Map<number, number[]>();
    for (const root of includeRoots) {
      const rootExclusions: number[] = [];
      excludedByRoot.set(root, rootExclusions);
      const keepStack = [root];
      while (keepStack.length) {
        const current = keepStack.pop()!;
        const kids = children[current];
        for (let offset = 0; offset < kids.length; offset += 1) {
          if (keepChoice[current][offset]) keepStack.push(kids[offset]);
          else {
            excluded.push(kids[offset]);
            rootExclusions.push(kids[offset]);
          }
        }
      }
    }

    let retainedTokens = 0;
    let retainedAnchorTokens = 0;
    let retainedBoilerplateTokens = 0;
    for (let index = 0; index < total; index += 1) {
      if (!retained[index]) continue;
      retainedTokens += ownTokens[index];
      if (nodes[index].anchor) retainedAnchorTokens += ownTokens[index];
      if (nodes[index].boilerplateHits) retainedBoilerplateTokens += ownTokens[index];
    }
    if (retainedTokens < TREE_DP_GUARD_MIN_TOKENS) return null;
    const rootMargins = includeRoots.map((root) => {
      const descend = children[root].reduce((sum, child) => sum + free[child], 0);
      return (keep[root] - TREE_DP_ROOT_PENALTY - Math.max(0, descend))
        / Math.max(1, subtreeTokens[root]);
    });
    const hasDependentRoot = includeRoots.some(root => TREE_DP_DEPENDENT_ROOT_TAGS.has(nodes[root].tag));
    if (hasDependentRoot) return null;

    includeRoots.sort((left, right) => left - right);
    const wrapper = createWrapper(doc);
    for (const rootIndex of includeRoots) {
      const clone = nodes[rootIndex].element.cloneNode(true) as Element;
      const rootExclusions = new Set(excludedByRoot.get(rootIndex) || []);
      const materializeStack: [number, Element][] = [[rootIndex, clone]];
      while (materializeStack.length) {
        const [sourceIndex, target] = materializeStack.pop()!;
        const kids = children[sourceIndex];
        for (let j = kids.length - 1; j >= 0; j -= 1) {
          const child = kids[j];
          const childClone = target?.children?.[nodes[child].childIndex];
          if (!childClone) continue;
          if (rootExclusions.has(child)) childClone.remove();
          else materializeStack.push([child, childClone]);
        }
      }
      if (nodes[rootIndex].tag === "body") wrapper.append(...clone.childNodes);
      else wrapper.append(clone);
    }
    cleanTree(wrapper);
    const candidate = makeCandidate("tree-dp", wrapper);
    if (!candidate) return null;
    const materialized = treeDpMaterializedStats(candidate.root);
    if (materialized.tokens < TREE_DP_GUARD_MIN_TOKENS) return null;
    const diagnostics = Object.freeze({
      includeRootCount: includeRoots.length,
      hasOrphanListOrTableRoot: hasDependentRoot,
      retainedAnchorShare: materialized.anchorTokens / materialized.tokens,
      retainedBoilerplateShare: materialized.boilerplateTokens / materialized.tokens,
      minLocalRootDecisionMarginPerToken: rootMargins.length
        ? Math.min(...rootMargins)
        : null,
    });
    TREE_DP_INTERNAL_DIAGNOSTICS.set(candidate, diagnostics);
    return candidate;
  }

  function candidateLinkShare(candidate: Candidate) {
    if (!candidate?.length) return 1;
    return collectLinkInfo(candidate.root).length / candidate.length;
  }

  function legacyCandidateIsSafe(legacy: Candidate | null, doc: Document, status: ReturnType<typeof pageCandidateStatus> | null = null) {
    if (!legacy || legacy.dirty) return false;
    const candidateStatus = status || pageCandidateStatus(legacy, doc);
    return candidateStatus.anchoredShare >= TREE_DP_MIN_ANCHORED_SHARE
      && candidateStatus.complete
      && candidateLinkShare(legacy) < LINK_FARM_RATIO;
  }

  function normalizedRescueText(value: unknown) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized.length <= TREE_DP_RESCUE_TEXT_CAP) return normalized;
    const headLength = Math.floor(TREE_DP_RESCUE_TEXT_CAP / 2);
    const tailLength = TREE_DP_RESCUE_TEXT_CAP - headLength;
    return `${normalized.slice(0, headLength)} ${normalized.slice(-tailLength)}`;
  }

  function rescueGramSet(value: string) {
    const characters = Array.from(value);
    if (characters.length < 3) return new Set(value ? [value] : []);
    const grams = new Set<string>();
    for (let index = 0; index <= characters.length - 3; index += 1) {
      grams.add(characters.slice(index, index + 3).join(""));
    }
    return grams;
  }

  function retainedGramShare(source: string, target: string | Set<string>) {
    const sourceGrams = rescueGramSet(source);
    if (!sourceGrams.size) return 1;
    const targetGrams = target instanceof Set ? target : rescueGramSet(target);
    let retained = 0;
    for (const gram of sourceGrams) if (targetGrams.has(gram)) retained += 1;
    return retained / sourceGrams.size;
  }

  function treeDpPreservesLegacy(treeDp: Candidate, legacy: Candidate | null) {
    if (!legacy) return true;
    const legacyText = normalizedRescueText(legacy.text);
    const treeText = normalizedRescueText(treeDp.text);
    const treeGrams = rescueGramSet(treeText);
    return retainedGramShare(legacyText, treeGrams) >= TREE_DP_RESCUE_MIN_RETAIN
      && retainedGramShare(legacyText.slice(0, 250), treeGrams) >= TREE_DP_RESCUE_MIN_RETAIN
      && retainedGramShare(legacyText.slice(-250), treeGrams) >= TREE_DP_RESCUE_MIN_RETAIN;
  }

  function selectTreeDpCandidate(treeDp: Candidate | null, legacy: Candidate | null, doc: Document, {
    allowConfidenceOverride = false,
    getPageLength = null,
    treeCandidateStatus = null,
  }: { allowConfidenceOverride?: boolean; getPageLength?: (() => number) | null; treeCandidateStatus?: ReturnType<typeof pageCandidateStatus> | null } = {}) {
    if (!treeDp) return legacy;
    const diagnostics = TREE_DP_INTERNAL_DIAGNOSTICS.get(treeDp);
    const tree = treeCandidateStatus || pageCandidateStatus(treeDp, doc);
    const treeStructurallySafe = diagnostics
      && !diagnostics.hasOrphanListOrTableRoot
      && !treeDp.dirty
      && tree.anchoredShare >= TREE_DP_MIN_ANCHORED_SHARE
      && tree.complete;
    if (!treeStructurallySafe) return legacy;
    const confidentlyCoherent = allowConfidenceOverride
      && diagnostics
      && diagnostics.includeRootCount === 1
      && !diagnostics.hasOrphanListOrTableRoot
      && diagnostics.retainedAnchorShare >= TREE_DP_CONFIDENT_MIN_RETAINED_ANCHOR_SHARE
      && diagnostics.retainedBoilerplateShare <= TREE_DP_CONFIDENT_MAX_RETAINED_BOILERPLATE_SHARE
      && diagnostics.minLocalRootDecisionMarginPerToken !== null
      && Number.isFinite(diagnostics.minLocalRootDecisionMarginPerToken)
      && diagnostics.minLocalRootDecisionMarginPerToken
        >= TREE_DP_CONFIDENT_MIN_ROOT_MARGIN_PER_TOKEN
      && (!legacy || treeDp.length >= legacy.length)
      && treeDpPreservesLegacy(treeDp, legacy);
    if (confidentlyCoherent) return treeDp;
    const comparablePageLength = typeof getPageLength === "function"
      ? getPageLength()
      : pageTextLength(doc);
    if (!comparablePageLength) return legacy;
    const legacyPageShare = legacy ? legacy.length / comparablePageLength : 0;
    const treePageShare = treeDp.length / comparablePageLength;
    const treeLinkShare = candidateLinkShare(treeDp);
    if (legacyPageShare > TREE_DP_RESCUE_MAX_LEGACY_PAGE_SHARE
      || treePageShare < TREE_DP_RESCUE_MIN_PAGE_SHARE
      || treePageShare >= TREE_DP_MAX_PAGE_SHARE
      || treeLinkShare >= TREE_DP_RESCUE_MAX_LINK_SHARE
      || (legacy && treeDp.length < TREE_DP_RESCUE_MIN_LENGTH_RATIO * legacy.length)
      || !treeDpPreservesLegacy(treeDp, legacy)) return legacy;
    return treeDp;
  }

  function chooseInitial(doc: Document, custom: Candidate | null, readable: Candidate | null, focus: string, getParagraph: () => Candidate | null) {
    let chosen = preferReadability(custom, readable, focus) ? readable : (custom || readable);
    if (!chosen || chosen.dirty || chosen.length < MIN_EXTRACTED_SIZE) {
      const rescue = getParagraph();
      if (rescue?.text && (!chosen || chosen.length <= 3 * rescue.length)) chosen = rescue;
    }
    if (!chosen) return null;
    if (chosen.name === "readability") chosen = sanitizeReadability(doc, chosen, focus);
    return chosen;
  }

  function parseReadability(doc: Document) {
    try {
      return new Readability(cloneDocument(doc), {
        charThreshold: 0,
        keepClasses: false,
      }).parse();
    } catch (_err) {
      return null;
    }
  }

  function withMetadata(result: Candidate | null, readability: ReadableArticleMetadata | null | undefined) {
    if (!result) return null;
    result.metadata = {
      title: readability?.title || "",
      byline: readability?.byline || "",
      siteName: readability?.siteName || "",
      publishedTime: readability?.publishedTime || "",
      excerpt: readability?.excerpt || "",
    };
    return result;
  }

  function extract(doc: Document, { readability, complete = false }: { readability?: ReadableArticleMetadata | null; complete?: boolean } = {}) {
    if (!doc?.body) return null;
    doc = prepareDocument(doc);
    if (readability === undefined) readability = parseReadability(doc);
    let cachedPageLength: number | null = null;
    const getPageLength = () => {
      if (cachedPageLength === null) cachedPageLength = pageTextLength(doc);
      return cachedPageLength;
    };

    const memo = (factory: () => Candidate | null) => {
      let ready = false;
      let value: Candidate | null = null;
      return () => {
        if (!ready) {
          value = factory();
          ready = true;
        }
        return value;
      };
    };
    const getParagraph = memo(() => paragraphRescue(doc));
    const getBaseline = memo(() => baseline(doc));
    const readable = parseReadabilityCandidate(doc, readability);
    const custom = runCustomExtractor(doc, "balanced");
    let chosen = chooseInitial(doc, custom, readable, "balanced", getParagraph);
    if (!chosen || chosen.length < MIN_EXTRACTED_SIZE) {
      chosen = getBaseline() || chosen;
    }

    if (chosen && chosen.length > 0 && chosen.length < ESCALATION_MAX_LENGTH) {
      const pageLength = getPageLength();
      if (chosen.length < ESCALATION_PAGE_SHARE * pageLength) {
        const recall = chooseInitial(doc, runCustomExtractor(doc, "recall"), readable, "recall", getParagraph);
        const paragraph = getParagraph();
        if (paragraph && (!recall || paragraph.length > recall.length)
          && paragraph.length > ESCALATION_PARAGRAPH_RATIO * chosen.length) chosen = paragraph;
        else if (recall && recall.length >= MIN_EXTRACTED_SIZE
          && recall.length > ESCALATION_ACCEPT_RATIO * chosen.length) chosen = recall;
      }
    }
    const legacy = chosen || readable || custom || getBaseline();
    let selected = legacy;

    // Tree-DP is a Han-gated rescue path, not a competing fast path. Most pages keep
    // the established cascade and pay no DP cost; only an unsafe or incomplete
    // legacy candidate asks Tree-DP for a structurally validated replacement.
    if (hanDominantDocument(doc)) {
      // Reject obvious non-rescue cases before the more expensive structural
      // status walk. The selector still rechecks against the cleaned page text.
      const visiblePageLength = normalizedText(doc.body?.textContent || "").length;
      const legacyPageShare = legacy && visiblePageLength ? legacy.length / visiblePageLength : 0;
      if (legacyPageShare <= TREE_DP_RESCUE_PREFLIGHT_MAX_LEGACY_PAGE_SHARE) {
        const legacyStatus = legacy
          ? pageCandidateStatus(legacy, doc, { requireCentralCollection: true })
          : null;
        if (!legacyCandidateIsSafe(legacy, doc, legacyStatus)) {
          let treeDp = null;
          try {
            treeDp = treeDpExtract(doc);
          } catch (_error) {
            treeDp = null;
          }
          selected = selectTreeDpCandidate(treeDp, legacy, doc, {
            allowConfidenceOverride: complete,
            getPageLength,
            treeCandidateStatus: treeDp
              ? pageCandidateStatus(treeDp, doc, { requireCentralCollection: true })
              : null,
          });
        }
      }
    }
    const status = complete && selected ? pageCandidateStatus(selected, doc) : null;
    const fallback = status && !status.complete
      ? centralPageCandidate(doc)
      : null;
    const result = fallback && (
      fallback.length >= selected!.length
      || (status!.disjoint && fallback.length >= MIN_CONTENT_LENGTH)
    ) ? fallback : selected;
    return withMetadata(result, readability);
  }

  host.QingzhouArticleExtractor = Object.freeze({ extract });
})();
