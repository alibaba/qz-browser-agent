import { t, tHtml } from "../../i18n/index.js";
import { Marked, type Tokenizer } from "marked";
import { createCodeCopyButton, escapeHtml } from "../../ui/ui-utils.js";
interface MarkdownOptions { math?: boolean | "stream"; highlightScope?: object | null }
interface CodeOptions { stream?: boolean; highlightScope?: object | null }
interface Footnote { id: string; label: string; domId: string; text: string; referenced: boolean; refId: string }
interface MathPlaceholder { tex: string; display: boolean; pending: boolean; key: string }
interface MathState { displayMath: { openSeq: string; closeSeq: string; tex: string } | null }
interface MathLine { text: string; indent: number }
interface MathCodeState { kind: string; codeLike: boolean; lines?: (string | MathLine)[]; notation?: "code" | "math" }
interface NotationOptions { notation?: "code" | "math" }
interface LinkOptions { scrollToTarget?(target: HTMLElement): void }


import {
  highlightCode,
  highlightStreamingCode,
  normalizeCodeLanguage,
} from "../../ui/code-highlighter.js";

function renderAssistantContentHtml(text: unknown, { math = true, highlightScope = null }: MarkdownOptions = {}) {
  const source = String(text || "");
  if (isAssistantFailureText(source)) {
    return renderChatErrorCardHtml(source, { compact: false });
  }
  return renderMarkdown(source, { math, highlightScope });
}

function setAssistantFailureClass(el: HTMLElement | null, text = "") {
  el?.classList?.toggle("msg-assistant-error", isAssistantFailureText(text));
}

function isAssistantFailureText(value = "") {
  const text = stripFailureIcon(value).trim();
  return /^(?:LLM\s*(?:调用失败|响应超时|流式响应中断)|工具名非法|Model (?:request failed|response timed out|stream interrupted)|LLM API\s*\d+)/i.test(text);
}

function renderChatErrorCardInto(target: HTMLElement | null, text = "", options = {}) {
  if (!target) return;
  target.innerHTML = renderChatErrorCardInnerHtml(text, options);
}

function renderChatErrorCardHtml(text = "", options = {}) {
  return `<div class="chat-error-card">${renderChatErrorCardInnerHtml(text, options)}</div>`;
}

function renderChatErrorCardInnerHtml(text = "", { compact = false } = {}) {
  const parsed = parseChatErrorText(text);
  const tools = parsed.items.slice(0, compact ? 4 : 6);
  const hiddenCount = Math.max(0, parsed.totalCount - tools.length);
  return `
    <div class="chat-error-head">
      <span class="chat-error-mark" aria-hidden="true"></span>
      <div class="chat-error-title">${escapeHtml(parsed.title)}</div>
    </div>
    ${parsed.summary ? `<div class="chat-error-summary">${escapeHtml(parsed.summary)}</div>` : ""}
    ${tools.length ? `<div class="chat-error-tools" aria-label="${tHtml("affectedTools")}">
      ${tools.map(item => `<span class="chat-error-tool">${escapeHtml(item)}</span>`).join("")}
      ${hiddenCount > 0 ? `<span class="chat-error-more">${tHtml("affectedToolCount", { count: hiddenCount + tools.length })}</span>` : ""}
    </div>` : ""}
    ${parsed.guidance ? `<div class="chat-error-guidance">${escapeHtml(parsed.guidance)}</div>` : ""}
  `;
}

function parseChatErrorText(value = "") {
  const raw = stripFailureIcon(value).trim();
  const noPrefix = raw.replace(/^(?:LLM\s*调用失败|Model request failed)\s*[:：]\s*/i, "").trim();
  const toolNameError = parseToolNameFailureText(noPrefix);
  if (toolNameError) return toolNameError;
  const apiFailure = noPrefix.match(/^(LLM API\s*\d+)\s*[:：]\s*([\s\S]*)$/i);
  if (apiFailure) {
    return {
      title: t("modelIncomplete"),
      summary: `${apiFailure[1]}${apiFailure[2] ? `：${compactErrorSentence(apiFailure[2])}` : ""}`,
      guidance: t("modelRecovery"),
      items: [],
      totalCount: 0,
    };
  }
  return {
    title: t("cannotContinue"),
    summary: compactErrorSentence(noPrefix || raw || t("runFailedSentence")),
    guidance: "",
    items: [],
    totalCount: 0,
  };
}

function parseToolNameFailureText(text = "") {
  if (!/^工具名非法/i.test(text)) return null;
  const withoutRule = text.split(/。function name/i)[0] || text;
  const colonIndex = Math.max(withoutRule.indexOf("："), withoutRule.indexOf(":"));
  const lead = colonIndex >= 0 ? withoutRule.slice(0, colonIndex) : withoutRule;
  const listText = colonIndex >= 0 ? withoutRule.slice(colonIndex + 1) : "";
  const items = listText
    .split("、")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => item.replace(/\s*等\s*\d+\s*个\s*。?$/u, "").trim())
    .filter(Boolean);
  const totalMatch = text.match(/等\s*(\d+)\s*个/u);
  const totalCount = Number(totalMatch?.[1]) || items.length;
  const action = lead
    .replace(/^工具名非法[，,]?\s*/u, "")
    .replace(/[。；;]\s*$/u, "")
    .trim();
  const guidance = (text.split(/；/u).pop() || "")
    .replace(/[。]\s*$/u, "")
    .trim();
  return {
    title: t("invalidToolName"),
    summary: action || t("stoppedBeforeRequest"),
    guidance: guidance || t("toolNameRecovery"),
    items,
    totalCount: Math.max(totalCount, items.length),
  };
}

function stripFailureIcon(value = "") {
  return String(value || "").replace(/^❌\s*/u, "");
}

function normalizeFailureTextForCompare(value = "") {
  return stripFailureIcon(value)
    .replace(/^(?:LLM\s*调用失败|Model request failed)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactErrorSentence(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function renderMarkdown(text: unknown, { math = true, highlightScope = null }: MarkdownOptions = {}) {
  if (!text) return "";
  try {
    const streamMath = math === "stream";
    const footnoteScopeId = nextMarkdownFootnoteScopeId();
    const footnotes = extractMarkdownFootnotes(String(text), {
      provisionalReferences: streamMath,
      scopeId: footnoteScopeId,
    });
    if (!math) {
      const html = marked.parse(footnotes.markdown, { breaks: true, async: false }) as string;
      return withSafeMarkdownLinks(enhanceMarkdownCodeBlocks(appendMarkdownFootnotes(html, footnotes.items), {
        highlightScope,
      }));
    }
    const prepared = extractMarkdownMathPlaceholders(footnotes.markdown, { stream: streamMath });
    const pendingLastCodeFence = streamMath &&
      hasUnclosedTrailingMarkdownFence(prepared.markdown) &&
      !/\r?\n$/.test(prepared.markdown);
    const parser = streamMath ? createMarkdownParser(prepared.markdown) : marked;
    const html = parser.parse(prepared.markdown, { breaks: true, async: false }) as string;
    const restored = restoreMarkdownMathPlaceholders(html, prepared.math);
    const enhanced = enhanceMarkdownMath(restored, {
      stream: streamMath,
      pendingLastCodeFence,
    });
    return withSafeMarkdownLinks(enhanceMarkdownCodeBlocks(appendMarkdownFootnotes(enhanced, footnotes.items, streamMath), {
      stream: streamMath,
      highlightScope,
    }));
  }
  catch(_e) { return escapeHtml(text).replace(/\n/g, "<br>"); }
}

// This private parser has no asynchronous extensions; Marked 12 does not narrow its return type.
const DOUBLE_TILDE_STRIKETHROUGH_RE = /^(~~)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/;
const marked = createMarkdownParser();

function createMarkdownParser(streamingSource?: string) {
  const parser = new Marked({ async: false });
  parser.use({
    tokenizer: {
      del(this: Tokenizer, source) {
        const match = DOUBLE_TILDE_STRIKETHROUGH_RE.exec(source);
        // Marked falls back to its GFM tokenizer only for `false`; `undefined`
        // deliberately leaves a single tilde as ordinary text.
        if (!match) return undefined;
        return {
          type: "del",
          raw: match[0],
          text: match[2],
          tokens: this.lexer.inlineTokens(match[2]),
        };
      },
    },
  });
  if (streamingSource !== undefined) parser.use({
    extensions: [{
      name: "pendingBlockPrefix",
      level: "block",
      tokenizer(source) {
        // A leading '*' may become emphasis or a list. Avoid an empty list row
        // while the stream is still delivering the opening delimiter.
        if (/^ {0,3}(?:\*{1,3}|_{1,3})$/.test(source)) return { type: "pendingBlockPrefix", raw: source };
      },
      renderer() { return ""; },
    }, {
      name: "pendingCodeSpan",
      level: "inline",
      start: source => source.indexOf("`"),
      tokenizer(source) {
        if (this.lexer.state.inRawBlock || !source.startsWith("`") ||
            !streamingSource.endsWith(source) || parser.defaults.tokenizer!.codespan(source)) return;
        const opening = /^`+/.exec(source)!;
        // Render HTML-looking code as text from its first chunk, instead of
        // briefly interpreting tags until the closing backtick arrives.
        return { type: "pendingCodeSpan", raw: source, text: source.slice(opening[0].length).replace(/\n/g, " ") };
      },
      renderer(token) { return `<code>${escapeHtml(token.text || "")}</code>`; },
    }, {
      name: "pendingTable",
      level: "block",
      start(source) {
        // GFM tables interrupt paragraphs. Reserve the same boundary while the
        // trailing pipe header/delimiter is incomplete, before paragraph lexing
        // can absorb it and bypass this tokenizer. A paragraph ends at the first
        // blank line, so avoid rescanning the rest of a long streamed answer.
        const boundary = /\n[ \t]*\n/.exec(source);
        const scope = boundary ? source.slice(0, boundary.index) : source;
        const index = scope.indexOf("\n|");
        return index < 0 ? undefined : index + 1;
      },
      tokenizer(source) {
        const table = parser.defaults.tokenizer!.table(source);
        // Automatic column sizing needs every row. Reveal a table at its block
        // boundary, or on final rendering, so it keeps the compact static layout.
        if (table) {
          const closed = table.raw.length < source.length || /\n[ \t]*\n$/.test(table.raw);
          return closed ? table : { type: "pendingTable", raw: table.raw };
        }
        // Do not flash a partial pipe-table header as prose before its delimiter.
        if (/^\|[^\n]*(?:\n[|:\- \t]*)?$/.test(source.trimEnd())) return { type: "pendingTable", raw: source };
      },
      renderer(token) {
        const count = Array.from(token.raw.replace(/\s/g, "")).length;
        return `<div class="markdown-table-pending">${tHtml("tableGenerating", { count })}</div>`;
      },
    }, {
      name: "pendingLink",
      level: "inline",
      start: source => source.indexOf("["),
      tokenizer(source) {
        if (this.lexer.state.inRawBlock || !source.startsWith("[") ||
            !streamingSource.trimEnd().endsWith(source.trimEnd()) || /\n\s*$/.test(streamingSource)) return;
        const label = pendingMarkdownLinkLabel(source);
        if (label === null) return;
        const tokenizer = parser.defaults.tokenizer!;
        const reference = tokenizer.reflink(source, this.lexer.tokens.links);
        if (reference && reference.type !== "text") return;
        return { type: "pendingLink", raw: source, tokens: this.lexer.inlineTokens(label) };
      },
      renderer(token) { return this.parser.parseInline(token.tokens || []); },
    }],
  });
  return parser;
}

// Only the unfinished inline suffix is provisional. Marked still owns complete links,
// escaped brackets and code spans; no partial destination is displayed or clickable.
function pendingMarkdownLinkLabel(source: string): string | null {
  if (source.includes("\n")) return null;
  let depth = 1;
  for (let i = 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === "`") {
      const fence = /^`+/.exec(source.slice(i))![0];
      const end = source.indexOf(fence, i + fence.length);
      if (end >= 0) { i = end + fence.length - 1; continue; }
    }
    if (source[i] === "[") depth += 1;
    if (source[i] !== "]" || --depth !== 0) continue;
    const rest = source.slice(i + 1);
    if (rest && !rest.startsWith("(")) return null;
    if (rest && hasClosedMarkdownLinkDestination(rest)) return null;
    return source.slice(1, i);
  }
  return source.slice(1);
}

function hasClosedMarkdownLinkDestination(source: string) {
  let depth = 1;
  let quote = "";
  for (let i = 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") { i += 1; continue; }
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "<") {
      quote = ">";
    } else if ((char === '"' || char === "'") && /\s/.test(source[i - 1])) {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && --depth === 0) {
      return true;
    }
  }
  return false;
}

let markdownFootnoteScopeSeq = 0;

function nextMarkdownFootnoteScopeId() {
  markdownFootnoteScopeSeq = (markdownFootnoteScopeSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `qzfn-${markdownFootnoteScopeSeq.toString(36)}`;
}

function extractMarkdownFootnotes(text = "", { provisionalReferences = false, scopeId = "" } = {}) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const notes: Footnote[] = [];
  const byId = new Map<string, Footnote>();
  const body = [];
  const fence = createMarkdownFenceTracker();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (fence.consume(line)) {
      body.push(line);
      continue;
    }

    if (!fence.active) {
      // A trailing definition prefix must not flash in the body before its colon
      // arrives. Final rendering restores literal brackets if the stream stops here.
      if (provisionalReferences && i === lines.length - 1 && /^\[(?:\^(?:[^\]\s]+\]?)?|\d{1,3}\]?)?$/.test(line)) continue;
      const definition = line.match(/^\[(?:\^([^\]\s]+)|(\d{1,3}))\]:[ \t]*(.*)$/);
      if (definition) {
        const id = String(definition[1] || definition[2] || "").trim();
        const noteLines = [definition[3] || ""];
        while (i + 1 < lines.length && /^(?:[ \t]{2,}|\t)/.test(lines[i + 1] || "")) {
          i += 1;
          noteLines.push(String(lines[i] || "").replace(/^(?:[ \t]{2,}|\t)/, ""));
        }
        if (id && !byId.has(id)) {
          const item = {
            id,
            label: id,
            domId: markdownScopedFootnoteDomId(id, scopeId),
            text: noteLines.join("\n").trim(),
            referenced: false,
            refId: "",
          };
          notes.push(item);
          byId.set(id, item);
        }
        continue;
      }
    }

    body.push(line);
  }

  if (!notes.length) {
    return {
      markdown: provisionalReferences
        ? replaceMarkdownFootnoteReferences(body.join("\n"), byId, { provisional: true, scopeId })
        : source,
      items: [],
    };
  }
  return {
    markdown: replaceMarkdownFootnoteReferences(body.join("\n"), byId, {
      provisional: provisionalReferences,
      scopeId,
    }),
    items: notes,
  };
}

function replaceMarkdownFootnoteReferences(markdown = "", notesById: Map<string, Footnote> = new Map(), { provisional = false, scopeId = "" } = {}) {
  const lines = String(markdown || "").split(/\r?\n/);
  const refCounts = new Map<string, number>();
  const fence = createMarkdownFenceTracker();

  return lines.map((line) => {
    if (fence.consume(line)) {
      return line;
    }
    if (fence.active) return line;
    return line.replace(/\[\^([^\]\s]+)\]|\[(\d{1,3})\](?!\s*[\(:])/g, (raw, footnoteId, numericId) => {
      const id = String(footnoteId || numericId || "").trim();
      const note = notesById.get(id);
      const count = (refCounts.get(id) || 0) + 1;
      refCounts.set(id, count);
      if (!note) {
        if (!provisional) return raw;
        const domId = markdownScopedFootnoteDomId(id, scopeId);
        const refId = count === 1 ? `fnref-pending-${domId}` : `fnref-pending-${domId}-${count}`;
        return renderMarkdownFootnoteReference({
          label: id,
          refId,
          pending: true,
        });
      }
      const refId = count === 1 ? `fnref-${note.domId}` : `fnref-${note.domId}-${count}`;
      if (!note.refId) note.refId = refId;
      note.referenced = true;
      return renderMarkdownFootnoteReference({
        label: note.label,
        refId,
        href: `#fn-${note.domId}`,
      });
    });
  }).join("\n");
}

function renderMarkdownFootnoteReference({ label = "", refId = "", href = "", pending = false } = {}) {
  const safeLabel = escapeHtml(label);
  const safeRefId = escapeHtml(refId);
  const classes = pending
    ? "markdown-footnote-ref markdown-footnote-ref-pending"
    : "markdown-footnote-ref";
  if (pending || !href) {
    return `<sup class="${classes}" id="${safeRefId}"><span aria-label="${tHtml("sourceGenerating", { label })}">${safeLabel}</span></sup>`;
  }
  return `<sup class="${classes}" id="${safeRefId}"><a href="${escapeHtml(href)}" aria-label="${tHtml("sourceLabel", { label })}">${safeLabel}</a></sup>`;
}

function appendMarkdownFootnotes(html = "", notes: Footnote[] = [], stream = false) {
  const referenced = (Array.isArray(notes) ? notes : []).filter(note => note?.referenced);
  if (!referenced.length) return html;
  const items = referenced.map((note) => {
    const body = renderMarkdownFootnoteInline(note.text || "", stream);
    return `<li id="fn-${escapeHtml(note.domId)}"><span class="markdown-footnote-body">${body}</span></li>`;
  }).join("");
  return `${html}<section class="markdown-footnotes" role="doc-endnotes"><ol>${items}</ol></section>`;
}

function renderMarkdownFootnoteInline(text = "", stream = false) {
  try {
    const source = normalizeMarkdownFootnoteInlineText(text);
    const parser = stream ? createMarkdownParser(source) : marked;
    return parser.parseInline(source, { async: false }) as string;
  } catch (_e) {}
  return escapeHtml(text);
}

function normalizeMarkdownFootnoteInlineText(text = "") {
  let source = String(text || "");
  source = source.replace(/\]（\s*(https?:\/\/[^）\s]+)\s*）/gi, "]($1)");
  if (/\[[^\]\n]+\]\(\s*https?:\/\//i.test(source)) return source;
  return source.replace(/(^|[\s(（])((?:https?:\/\/)[^\s<>()（）]+)/gi, (match, prefix, rawUrl) => {
    const trimmed = stripTrailingUrlPunctuation(rawUrl);
    const suffix = rawUrl.slice(trimmed.length);
    return `${prefix}<${trimmed}>${suffix}`;
  });
}

function stripTrailingUrlPunctuation(value = "") {
  return String(value || "").replace(/[.,，。;；:：!?！？、]+$/u, "");
}

function markdownFootnoteDomId(id = "") {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "note";
}

function markdownScopedFootnoteDomId(id = "", scopeId = "") {
  const scope = markdownFootnoteDomId(scopeId || "scope");
  return `${scope}-${markdownFootnoteDomId(id)}`;
}

/** Footnotes and math must agree about fenced code, including partial streamed fences. */
function createMarkdownFenceTracker() {
  let marker = "";
  return {
    get active() { return Boolean(marker); },
    consume(line: string) {
      const next = line.match(/^(\s*)(`{3,}|~{3,})/)?.[2];
      if (!next) return false;
      if (!marker) marker = next;
      else if (next[0] === marker[0] && next.length >= marker.length) marker = "";
      return true;
    },
  };
}

function hasUnclosedTrailingMarkdownFence(text: string) {
  const fence = createMarkdownFenceTracker();
  for (const line of String(text || "").match(/[^\n]*(?:\n|$)/g) || []) fence.consume(line);
  return fence.active;
}

function extractMarkdownMathPlaceholders(text: string, { stream = false } = {}) {
  const source = String(text || "");
  const lines = source.match(/[^\n]*(?:\n|$)/g) || [source];
  const math: MathPlaceholder[] = [];
  const state: MathState = { displayMath: null };
  const fence = createMarkdownFenceTracker();
  let markdown = "";
  for (const line of lines) {
    if (line === "") continue;
    if (state.displayMath) {
      markdown += extractMarkdownMathLineWithDisplayState(line, math, state, { stream });
      continue;
    }
    if (fence.consume(line)) {
      markdown += line;
      continue;
    }
    markdown += fence.active ? line : extractMarkdownMathLineWithDisplayState(line, math, state, { stream });
  }
  if (state.displayMath) {
    const item = state.displayMath;
    if (stream) markdown += createMarkdownMathPlaceholder(math, item.tex, true, { pending: true });
    else markdown += `${item.openSeq}${item.tex}`;
    state.displayMath = null;
  }
  return { markdown, math };
}

function extractMarkdownMathLineWithDisplayState(line: string, math: MathPlaceholder[], state: MathState, { stream = false } = {}) {
  let source = String(line || "");
  let output = "";
  while (source) {
    if (state.displayMath) {
      const close = indexOfUnescapedSequence(source, state.displayMath.closeSeq, 0);
      if (close < 0) {
        state.displayMath.tex += source;
        return output;
      }
      state.displayMath.tex += source.slice(0, close);
      output += createMarkdownMathPlaceholder(math, state.displayMath.tex, true);
      source = source.slice(close + state.displayMath.closeSeq.length);
      state.displayMath = null;
      continue;
    }

    const open = findUnclosedDisplayMathOpenInLine(source);
    if (!open) {
      output += extractMarkdownMathPlaceholdersInText(source, math, { stream });
      return output;
    }
    const before = source.slice(0, open.index);
    if (before) output += extractMarkdownMathPlaceholdersInText(before, math, { stream });
    state.displayMath = {
      openSeq: open.openSeq,
      closeSeq: open.closeSeq,
      tex: source.slice(open.index + open.openSeq.length),
    };
    return output;
  }
  return output;
}

function findUnclosedDisplayMathOpenInLine(line: string) {
  const source = String(line || "");
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      const tickLength = countRun(source, index, "`");
      const marker = "`".repeat(tickLength);
      const close = source.indexOf(marker, index + tickLength);
      index = close < 0 ? source.length : close + tickLength;
      continue;
    }
    const dollar = source.startsWith("$$", index) && !isEscapedAt(source, index)
      ? { openSeq: "$$", closeSeq: "$$" }
      : null;
    const bracket = source.startsWith("\\[", index) && !isEscapedAt(source, index)
      ? { openSeq: "\\[", closeSeq: "\\]" }
      : null;
    const marker = dollar || bracket;
    if (!marker) {
      index += 1;
      continue;
    }
    const close = indexOfUnescapedSequence(source, marker.closeSeq, index + marker.openSeq.length);
    if (close < 0) return { ...marker, index };
    index = close + marker.closeSeq.length;
  }
  return null;
}

function extractMarkdownMathPlaceholdersInText(text: string, math: MathPlaceholder[], { stream = false } = {}) {
  const source = String(text || "");
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      const tickLength = countRun(source, index, "`");
      const marker = "`".repeat(tickLength);
      const close = source.indexOf(marker, index + tickLength);
      const end = close < 0 ? source.length : close + tickLength;
      output += source.slice(index, end);
      index = end;
      continue;
    }
    const mathClose = source.startsWith("$$", index) && !isEscapedAt(source, index) ? "$$"
      : source.startsWith("\\[", index) ? "\\]"
      : source.startsWith("\\(", index) ? "\\)" : "";
    if (mathClose) {
      const display = mathClose !== "\\)";
      const close = indexOfUnescapedSequence(source, mathClose, index + 2);
      if (close >= 0) {
        const tex = source.slice(index + 2, close);
        if (display ? looksLikeDisplayMath(tex) : looksLikeInlineMath(tex)) {
          output += createMarkdownMathPlaceholder(math, tex, display);
          index = close + 2;
          continue;
        }
      }
      if (stream) {
        const tex = source.slice(index + 2);
        if (looksLikePendingMath(tex, display)) {
          output += createMarkdownMathPlaceholder(math, tex, display, { pending: true });
          index = source.length;
          continue;
        }
      }
    }
    if (source[index] === "$" && isValidInlineDollarOpen(source, index)) {
      const close = findInlineDollarClose(source, index + 1);
      if (close >= 0) {
        const tex = source.slice(index + 1, close);
        if (looksLikeInlineMath(tex)) {
          output += createMarkdownMathPlaceholder(math, tex, false);
          index = close + 1;
          continue;
        }
      }
      if (stream) {
        const tex = source.slice(index + 1);
        if (looksLikePendingMath(tex, false)) {
          output += createMarkdownMathPlaceholder(math, tex, false, { pending: true });
          index = source.length;
          continue;
        }
      }
    }
    output += source[index];
    index += 1;
  }
  return output;
}

function createMarkdownMathPlaceholder(math: MathPlaceholder[], tex: string, display: boolean, { pending = false } = {}) {
  const index = math.length;
  math.push({ tex, display, pending, key: createMarkdownMathKey(tex, display, index) });
  return `@@QZ_MATH_${index}@@`;
}

function createMarkdownMathKey(tex: string, display: boolean, index: number) {
  return `${display ? "d" : "i"}-${index}-${hashString(`${display ? "display" : "inline"}:${tex}`)}`;
}

function hashString(value: unknown) {
  const source = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function restoreMarkdownMathPlaceholders(html: string, math: MathPlaceholder[]) {
  if (!math.length) return html;
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const pattern = /@@QZ_MATH_(\d+)@@/g;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (pattern.test(node.nodeValue || "")) textNodes.push(node);
    pattern.lastIndex = 0;
  }
  for (const node of textNodes) {
    const text = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let start = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index > start) fragment.append(document.createTextNode(text.slice(start, match.index)));
      const item = math[Number(match[1])];
      if (item?.pending) fragment.append(createPendingMarkdownMathElement(item.tex, item.display, item.key));
      else if (item) fragment.append(createMarkdownMathElement(item.tex, item.display, item.key));
      else fragment.append(document.createTextNode(match[0]));
      start = match.index + match[0].length;
    }
    if (start < text.length) fragment.append(document.createTextNode(text.slice(start)));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}

function createMarkdownMathElement(tex: string, display: boolean, key = "") {
  const el = document.createElement("span");
  el.className = `math-formula ${display ? "math-display" : "math-inline"}`;
  if (key) el.dataset.mathKey = key;
  el.dataset.mathFallback = stripOuterMathDelimiters(tex, display).trim();
  el.textContent = display ? displayMathSource(tex) : inlineMathSource(tex);
  return el;
}

function createPendingMarkdownMathElement(tex: string, display: boolean, key = "") {
  const el = document.createElement("span");
  el.className = `math-formula math-pending ${display ? "math-display math-pending-display" : "math-inline math-pending-inline"}`;
  el.dataset.mathPending = "true";
  if (key) el.dataset.mathKey = key;
  el.setAttribute("aria-label", t("formulaGenerating"));
  el.textContent = pendingMathPreview(tex, display);
  return el;
}

function countRun(text: string, start: number, char: string) {
  let end = start;
  while (end < text.length && text[end] === char) end += 1;
  return end - start;
}

function enhanceMarkdownMath(html: string, { stream = false, pendingLastCodeFence = false } = {}) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  enhanceMarkdownMathCodeBlocks(template.content, { stream, pendingLastCodeFence });
  return template.innerHTML;
}

function enhanceMarkdownMathCodeBlocks(root: ParentNode, { stream = false, pendingLastCodeFence = false } = {}) {
  const codeBlocks = Array.from(root.querySelectorAll("pre > code"));
  for (const [blockIndex, codeEl] of codeBlocks.entries()) {
    const pre = codeEl.closest("pre");
    if (!pre) continue;
    const raw = codeEl.textContent || "";
    const lang = markdownCodeLanguage(codeEl);
    const state = classifyMarkdownMathCodeBlock(raw, lang);
    if (!state) continue;
    const wrap = document.createElement("div");
    wrap.className = `copyable-code-block math-code-block math-code-block-${state.kind}`;
    wrap.dataset.copyText = raw;
    if (lang) wrap.dataset.language = lang;
    const button = createCodeCopyButton(t("copyFormula"));
    pre.replaceWith(wrap);
    const isTrailingOpenFence = pendingLastCodeFence && blockIndex === codeBlocks.length - 1;
    wrap.append(renderMathCodeBlockBody(raw, state, {
      keyPrefix: `math-code-${blockIndex}-${hashString(`${lang || "plain"}:${state.kind}`)}`,
      pendingLastLine: stream && (isTrailingOpenFence || !/\r?\n$/.test(raw)),
    }), button);
  }
}

const MATH_CODE_BLOCK_KIND = Object.freeze({
  LATEX: "latex",
  CODE_EXPRESSION: "code-expression",
  CODE_LINES: "code-lines",
});

const CODE_LIKE_MATH_NOTATION = Object.freeze({
  CODE: "code",
  MATH: "math",
});

function classifyMarkdownMathCodeBlock(raw: string, lang = ""): MathCodeState | null {
  const normalizedLang = String(lang || "").trim().toLowerCase();
  if (/^(math|tex|latex|latex-math)$/.test(normalizedLang)) {
    return { kind: MATH_CODE_BLOCK_KIND.LATEX, codeLike: false };
  }
  if (normalizedLang) return null;
  const text = String(raw || "").trim();
  if (!text || text.length > 3000 || !hasStrongMarkdownMathSyntax(text)) return null;
  if (/\\begin\{[A-Za-z*]+\}/.test(text)) {
    return { kind: MATH_CODE_BLOCK_KIND.LATEX, codeLike: false };
  }
  const lines = codeLikeMathLines(raw);
  const notation = inferCodeLikeMathNotation(raw, lines);
  return {
    kind: lines.length > 1 ? MATH_CODE_BLOCK_KIND.CODE_LINES : MATH_CODE_BLOCK_KIND.CODE_EXPRESSION,
    codeLike: true,
    lines,
    notation,
  };
}

function renderMathCodeBlockBody(raw: string, state: MathCodeState, { keyPrefix = "", pendingLastLine = false } = {}) {
  if (state.kind === MATH_CODE_BLOCK_KIND.CODE_LINES) {
    const container = document.createElement("div");
    container.className = "math-display math-code-like math-code-lines";
    const lines = state.lines || [];
    for (const [index, line] of lines.entries()) {
      const source = typeof line === "string" ? line : line.text;
      const indent = typeof line === "string" ? 0 : line.indent;
      const lineEl = document.createElement("div");
      const linePending = pendingLastLine && index === lines.length - 1;
      lineEl.className = `math-formula math-code-line${linePending ? " math-pending math-code-line-pending" : ""}`;
      if (keyPrefix) lineEl.dataset.mathKey = `${keyPrefix}-line-${index}-${hashString(source)}`;
      lineEl.dataset.mathFallback = source;
      if (linePending) lineEl.dataset.mathPending = "true";
      lineEl.dataset.indent = String(indent || 0);
      lineEl.style.setProperty("--math-code-indent", `${Math.min(Math.max(indent || 0, 0), 24)}ch`);
      lineEl.textContent = linePending
        ? source
        : inlineMathSource(formatCodeLikeMathSource(source, { notation: state.notation }));
      container.append(lineEl);
    }
    return container;
  }
  const formula = document.createElement("div");
  formula.className = `math-formula math-display${state.codeLike ? " math-code-like" : ""}${pendingLastLine ? " math-pending math-code-block-pending" : ""}`;
  const source = state.codeLike && state.lines?.length === 1
    ? (typeof state.lines[0] === "string" ? state.lines[0] : state.lines[0].text)
    : raw;
  if (keyPrefix) formula.dataset.mathKey = `${keyPrefix}-block-${hashString(raw)}`;
  formula.dataset.mathFallback = source;
  if (pendingLastLine) formula.dataset.mathPending = "true";
  formula.textContent = pendingLastLine
    ? source
    : displayMathSource(source, { codeLike: state.codeLike, notation: state.notation });
  return formula;
}

function findInlineDollarClose(text: string, start: number) {
  let index = start;
  while (index < text.length) {
    const close = text.indexOf("$", index);
    if (close < 0) return -1;
    if (text[close + 1] === "$" || isEscapedAt(text, close)) {
      index = close + 1;
      continue;
    }
    const prev = text[close - 1] || "";
    const next = text[close + 1] || "";
    if (/\s/.test(prev) || /[A-Za-z0-9_]/.test(next)) {
      index = close + 1;
      continue;
    }
    return close;
  }
  return -1;
}

function isValidInlineDollarOpen(text: string, index: number) {
  if (text[index + 1] === "$" || isEscapedAt(text, index)) return false;
  const prev = text[index - 1] || "";
  const next = text[index + 1] || "";
  if (!next || /\s/.test(next)) return false;
  if (/[A-Za-z0-9_]/.test(prev)) return false;
  return true;
}

function indexOfUnescapedSequence(text: string, sequence: string, start: number) {
  let index = start;
  while (index < text.length) {
    const found = text.indexOf(sequence, index);
    if (found < 0) return -1;
    if (!isEscapedAt(text, found)) return found;
    index = found + sequence.length;
  }
  return -1;
}

function isEscapedAt(text: string, index: number) {
  let count = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos -= 1) count += 1;
  return count % 2 === 1;
}

function looksLikeInlineMath(tex: string) {
  const text = String(tex || "").trim();
  if (!text || text.length > 500) return false;
  if (/\\[A-Za-z]+|[_^]|[=<>+\-*/]|[≤≥≈≠∑∏∫√∞]|\\\||\|\||\b(?:min|max|argmin|argmax)\b/.test(text)) return true;
  return /^[A-Za-z][A-Za-z0-9]?$/.test(text) || /^[α-ωΑ-Ω]+$/u.test(text);
}

function looksLikePendingMath(tex: string, display = false) {
  const text = String(tex || "").trim();
  if (!text || text.length > (display ? 5000 : 500)) return false;
  if (/[`$]/.test(text)) return false;
  if (display && /\n\s*\n/.test(text)) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(text)) return false;
  return display ? looksLikeDisplayMath(text) : looksLikeInlineMath(text);
}

function pendingMathPreview(tex: string, display = false) {
  const text = stripOuterMathDelimiters(tex, display).replace(/\s+/g, " ").trim();
  const clipped = text.length > 28 ? `${text.slice(0, 28)}...` : text;
  return clipped ? `${clipped} ...` : t("formulaGenerating");
}

function looksLikeDisplayMath(tex: string) {
  const text = String(tex || "").trim();
  if (!text || text.length > 5000) return false;
  return looksLikeInlineMath(text) || /\\begin\{[A-Za-z*]+\}|\\\\|&/.test(text);
}

function hasStrongMarkdownMathSyntax(text: string) {
  if (/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/.test(text)) return true;
  if (/\\begin\{[A-Za-z*]+\}/.test(text)) return true;
  if (/\\(?:frac|sum|prod|int|sqrt|lim|cdot|times|leq|geq|neq|approx|infty)\b/.test(text)) return true;
  const symbolicCommands = text.match(/\\(?:theta|alpha|beta|gamma|delta|lambda|mu|sigma|mathrm|mathsf|mathbb|operatorname)\b/g) || [];
  if (!symbolicCommands.length) return false;
  return /[_^]\s*(?:\{|\\|[A-Za-z0-9])|[=<>+*/≤≥≈≠→]|(?:\|\||\\\|)/.test(text);
}

function displayMathSource(tex: string, { codeLike = false, notation = CODE_LIKE_MATH_NOTATION.CODE }: NotationOptions & { codeLike?: boolean } = {}) {
  const stripped = unwrapOuterTexBox(stripOuterMathDelimiters(tex, true).trim());
  const text = normalizeTexForMathJax(codeLike ? formatCodeLikeMathSource(stripped, { notation }) : stripped);
  if (/^\\begin\{(?:equation|align|alignat|gather|multline|flalign)\*?\}/.test(text)) return text;
  return `\\[${text}\\]`;
}

function inlineMathSource(tex: string) {
  return `\\(${normalizeTexForMathJax(unwrapOuterTexBox(stripOuterMathDelimiters(tex, false).trim()))}\\)`;
}

function normalizeTexForMathJax(tex: string) {
  return normalizeChainedTexScripts(String(tex || ""));
}

function normalizeChainedTexScripts(tex: string) {
  const source = String(tex || "");
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if ((char === "_" || char === "^") && !isEscapedAt(source, index)) {
      const normalized = readChainedTexScript(source, index);
      if (normalized) {
        output += normalized.text;
        index = normalized.end;
        continue;
      }
    }
    if (char === "\\") {
      const command = readTexCommand(source, index);
      output += command.text;
      index = command.end;
      if (/^\\(?:text|mathrm|mathsf|operatorname)$/.test(command.text) && source[index] === "{") {
        const group = readTexGroup(source, index);
        output += group.text;
        index = group.end;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function readChainedTexScript(source: string, start: number) {
  const operator = source[start];
  const first = readTexScriptAtom(source, start + 1);
  if (!first) return null;
  const atoms = [first];
  let end = first.end;
  while (source[end] === operator && !isEscapedAt(source, end)) {
    const next = readTexScriptAtom(source, end + 1);
    if (!next) break;
    atoms.push(next);
    end = next.end;
  }
  if (atoms.length <= 1) return { text: operator + first.raw, end };
  return {
    text: `${operator}{${atoms.map(item => item.content).join(",")}}`,
    end,
  };
}

function readTexScriptAtom(source: string, start: number) {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  if (index >= source.length) return null;
  if (source[index] === "{") {
    const group = readTexGroup(source, index);
    if (group.end <= index) return null;
    return { raw: group.text, content: group.text.replace(/^\{|\}$/g, ""), end: group.end };
  }
  if (source[index] === "\\") {
    const command = readTexCommand(source, index);
    let raw = command.text;
    let end = command.end;
    if (source[end] === "{") {
      const group = readTexGroup(source, end);
      raw += group.text;
      end = group.end;
    }
    return { raw, content: raw, end };
  }
  if (/[A-Za-z0-9]/.test(source[index])) {
    const ident = readAsciiIdentifier(source, index);
    return { raw: ident.text, content: ident.text, end: ident.end };
  }
  return { raw: source[index], content: source[index], end: index + 1 };
}

function unwrapOuterTexBox(tex: string) {
  let text = String(tex || "").trim();
  let next = unwrapOuterSimpleTexBox(text);
  while (next && next !== text) {
    text = next;
    next = unwrapOuterSimpleTexBox(text);
  }
  return text;
}

function unwrapOuterSimpleTexBox(tex: string) {
  const text = String(tex || "").trim();
  const simple = text.match(/^\\(?:boxed|fbox)(?![A-Za-z])\s*/);
  if (simple) return unwrapOuterTexCommandGroup(text, simple[0].length);
  const bbox = text.match(/^\\bbox(?![A-Za-z])\s*/);
  if (!bbox) return text;
  let index = bbox[0].length;
  if (text[index] === "[") {
    const close = indexOfUnescapedSequence(text, "]", index + 1);
    if (close < 0) return text;
    index = close + 1;
    while (/\s/.test(text[index] || "")) index += 1;
  }
  return unwrapOuterTexCommandGroup(text, index);
}

function unwrapOuterTexCommandGroup(text: string, groupStart: number) {
  if (text[groupStart] !== "{") return text;
  const group = readTexGroup(text, groupStart);
  if (group.end !== text.length) return text;
  return group.text.replace(/^\{|\}$/g, "").trim();
}

function formatCodeLikeMathSource(tex: string, { notation = CODE_LIKE_MATH_NOTATION.CODE }: NotationOptions = {}) {
  const source = normalizeCodeLikeMathsfChains(String(tex || ""));
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const command = readTexCommand(source, index);
      if (/^\\(?:mathsf|mathrm|operatorname|text)$/.test(command.text) && source[command.end] === "{") {
        const group = readTexGroup(source, command.end);
        output += formatCodeLikeTextCommand(command.text, group.text, { notation });
        index = group.end;
        continue;
      }
      output += command.text;
      index = command.end;
      continue;
    }
    if (source.startsWith("||", index)) {
      output += "\\mathrel{\\Vert}";
      index += 2;
      continue;
    }
    if (/\s/.test(char)) {
      const whitespace = readWhitespace(source, index);
      output += "\\;";
      index = whitespace.end;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      const ident = readAsciiIdentifier(source, index);
      output += formatCodeLikeIdentifier(ident.text, { notation });
      index = ident.end;
      continue;
    }
    if (isCjkCharacter(char)) {
      const text = readCjkText(source, index);
      output += `\\text{${escapeTexText(text.text)}}`;
      index = text.end;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function inferCodeLikeMathNotation(raw: string, lines: (string | MathLine)[]) {
  const source = String(raw || "");
  if (/[_^]\s*(?:\{|\\|[A-Za-z0-9])|\\(?:theta|alpha|beta|gamma|delta|lambda|mu|sigma)\b|[≤≥≈≠∑∏∫√∞θλμσ]/.test(source)) {
    return CODE_LIKE_MATH_NOTATION.MATH;
  }
  const hasCompactSubscript = (lines || []).some(line => {
    const text = typeof line === "string" ? line : line.text;
    return /(^|[^A-Za-z0-9_])([A-Za-z])_([A-Za-z0-9]+)(?![A-Za-z0-9_])/.test(text || "");
  });
  return hasCompactSubscript ? CODE_LIKE_MATH_NOTATION.MATH : CODE_LIKE_MATH_NOTATION.CODE;
}

function codeLikeMathLines(tex: string) {
  return stripOuterMathDelimiters(tex, true)
    .split(/\r?\n/)
    .map(normalizeCodeLikeMathLine)
    .filter((line): line is MathLine => Boolean(line));
}

function normalizeCodeLikeMathLine(line: string) {
  const raw = String(line || "");
  let text = stripLineMathDelimiters(raw.trim());
  if (!text) return "";
  text = escapeCodeLikeObjectBraces(text);
  return {
    text,
    indent: readCodeLikeIndent(raw),
  };
}

function stripLineMathDelimiters(line: string) {
  let text = String(line || "").trim();
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(/^\\\[/, "")
      .replace(/\\\]$/, "")
      .replace(/^\\\(/, "")
      .replace(/\\\)$/, "")
      .trim();
  }
  return /^(?:\\\[|\\\]|\\\(|\\\))$/.test(text) ? "" : text;
}

function escapeCodeLikeObjectBraces(line: string) {
  const text = String(line || "").trim();
  if (text === "{" || text === "}") return `\\${text}`;
  return text.replace(/(^|[^\\])\{\s*$/, "$1\\{");
}

function readCodeLikeIndent(line: string) {
  const indent = String(line || "").match(/^[\t ]*/)?.[0] || "";
  let width = 0;
  for (const char of indent) width += char === "\t" ? 2 : 1;
  return width;
}

function normalizeCodeLikeMathsfChains(source: string) {
  return String(source || "").replace(/\\mathsf\{[A-Za-z0-9_]+\}(?:_\\mathsf\{[A-Za-z0-9_]+\})+/g, match => {
    const parts = Array.from(match.matchAll(/\\mathsf\{([A-Za-z0-9_]+)\}/g), item => item[1]);
    if (parts.length <= 1) return match;
    return `\\mathsf{${parts.map(escapeMathsfIdentifier).join("\\_")}}`;
  });
}

function formatCodeLikeTextCommand(command: string, group: string, { notation = CODE_LIKE_MATH_NOTATION.CODE }: NotationOptions = {}) {
  if (notation === CODE_LIKE_MATH_NOTATION.MATH && /^(?:\\mathsf|\\mathrm)$/.test(command)) {
    const compact = formatCompactSubscriptIdentifier(unescapeTexIdentifierGroup(group));
    if (compact) return compact;
  }
  return command + group;
}

function unescapeTexIdentifierGroup(group: string) {
  const content = String(group || "").replace(/^\{|\}$/g, "");
  return content.replace(/\\_/g, "_");
}

function readTexCommand(source: string, start: number) {
  let end = start + 1;
  while (end < source.length && /[A-Za-z]/.test(source[end])) end += 1;
  if (end === start + 1 && end < source.length) end += 1;
  return { text: source.slice(start, end), end };
}

function readTexGroup(source: string, start: number) {
  if (source[start] !== "{") return { text: "", end: start };
  let depth = 0;
  let end = start;
  while (end < source.length) {
    const char = source[end];
    if (char === "\\" && end + 1 < source.length) {
      end += 2;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        return { text: source.slice(start, end), end };
      }
    }
    end += 1;
  }
  return { text: source.slice(start), end: source.length };
}

function readAsciiIdentifier(source: string, start: number) {
  let end = start + 1;
  while (end < source.length) {
    if (/[A-Za-z0-9]/.test(source[end])) {
      end += 1;
      continue;
    }
    if (source[end] === "_" && /[A-Za-z0-9]/.test(source[end + 1] || "")) {
      end += 1;
      continue;
    }
    break;
  }
  return { text: source.slice(start, end), end };
}

function readWhitespace(source: string, start: number) {
  let end = start + 1;
  while (end < source.length && /\s/.test(source[end])) end += 1;
  return { text: source.slice(start, end), end };
}

function formatCodeLikeIdentifier(identifier: string, { notation = CODE_LIKE_MATH_NOTATION.CODE }: NotationOptions = {}) {
  const text = String(identifier || "");
  if (text.length <= 1) return text;
  if (notation === CODE_LIKE_MATH_NOTATION.MATH) {
    const compact = formatCompactSubscriptIdentifier(text);
    if (compact) return compact;
  }
  if (text.includes("_")) return `\\mathsf{${escapeMathsfIdentifier(text)}}`;
  if (/^(min|max|argmin|argmax|lim|sup|inf)$/i.test(text)) return `\\operatorname*{${text}}`;
  if (/^(log|ln|exp|sin|cos|tan|softmax|sigmoid)$/i.test(text)) return `\\operatorname{${text}}`;
  return `\\mathsf{${text}}`;
}

function formatCompactSubscriptIdentifier(identifier: string) {
  const match = String(identifier || "").match(/^([A-Za-z])_([A-Za-z0-9]+)$/);
  if (!match) return "";
  return `${match[1]}_{${match[2]}}`;
}

function escapeMathsfIdentifier(text: string) {
  // Callers tokenize ASCII letters, digits and underscores before formatting.
  return text.replaceAll("_", "\\_");
}

function isCjkCharacter(char: string) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(char);
}

function readCjkText(source: string, start: number) {
  let end = start + 1;
  while (end < source.length && isCjkCharacter(source[end])) end += 1;
  return { text: source.slice(start, end), end };
}

function escapeTexText(text: string) {
  return String(text || "").replace(/[\\{}]/g, "");
}

function stripOuterMathDelimiters(tex: string, display: boolean) {
  const text = String(tex || "").trim();
  if (display) {
    const dollar = text.match(/^\$\$([\s\S]*)\$\$$/);
    if (dollar) return dollar[1];
    const bracket = text.match(/^\\\[([\s\S]*)\\\]$/);
    if (bracket) return bracket[1];
  }
  const inlineDollar = text.match(/^\$([\s\S]*)\$$/);
  if (inlineDollar) return inlineDollar[1];
  const paren = text.match(/^\\\(([\s\S]*)\\\)$/);
  if (paren) return paren[1];
  return text;
}


function enhanceMarkdownCodeBlocks(html: string, { stream = false, highlightScope = null }: CodeOptions = {}) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  let blockIndex = 0;
  for (const codeEl of template.content.querySelectorAll("pre > code")) {
    const pre = codeEl.closest("pre");
    if (!pre) continue;
    const raw = codeEl.textContent || "";
    const requestedLang = markdownCodeLanguage(codeEl);
    const highlighted = highlightScope
      ? highlightStreamingCode(raw, requestedLang, {
          scope: highlightScope,
          index: blockIndex,
          final: !stream,
        })
      : highlightCode(raw, requestedLang, { autoDetect: true });
    const lang = highlighted.language || normalizeCodeLanguage(requestedLang);
    codeEl.classList.add("code-block", "hljs");
    if (lang) codeEl.classList.add(`language-${lang}`);
    codeEl.innerHTML = highlighted.html;
    const wrap = document.createElement("div");
    wrap.className = "copyable-code-block markdown-code-block";
    wrap.dataset.copyText = raw;
    if (lang) wrap.dataset.language = lang;
    wrap.dataset.highlighter = highlighted.vendor || "plain";
    const button = createCodeCopyButton(t("copyCode"));
    pre.replaceWith(wrap);
    wrap.append(pre, button);
    blockIndex += 1;
  }
  return template.innerHTML;
}

function markdownCodeLanguage(codeEl: Element) {
  const className = String(codeEl?.className || "");
  const match = className.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)/);
  return match ? match[1].toLowerCase() : "";
}

function withSafeMarkdownLinks(html: string) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  for (const link of template.content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    repairGreedyBareWwwLink(link);
    const href = String(link.getAttribute("href") || "").trim();
    const internalFragment = Boolean(internalFragmentHash(href));
    if (!internalFragment) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    if (isMarkdownCitationLink(link)) {
      link.classList.add("markdown-citation-link");
      link.setAttribute("aria-label", t("citationSource", { label: (link.textContent || "").trim() }));
    }
  }
  return template.innerHTML;
}

function repairGreedyBareWwwLink(link: HTMLAnchorElement) {
  const label = String(link?.textContent || "");
  const href = String(link?.getAttribute?.("href") || "").trim();
  if (!/^www\./i.test(label) || !/^http:\/\//i.test(href)) return;

  let decodedHref = href;
  try {
    decodedHref = decodeURI(href);
  } catch (_e) {}
  if (decodedHref !== `http://${label}`) return;

  const match = label.match(/^(www\.(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?)([\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef][\s\S]*)$/i);
  if (!match) return;

  const [, domain, trailingText] = match;
  link.textContent = domain;
  link.setAttribute("href", `http://${domain}`);
  link.after(document.createTextNode(trailingText));
}

function isMarkdownCitationLink(link: HTMLAnchorElement) {
  const label = String(link?.textContent || "").trim();
  if (!/^\d{1,3}$/.test(label)) return false;
  const href = String(link.getAttribute?.("href") || "").trim();
  if (!href || href.startsWith("#")) return false;
  try {
    const url = new URL(href, location.href);
    if (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash
    ) {
      return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
  } catch(_e) {
    return false;
  }
}

function installExternalLinkHandler(options: LinkOptions = {}) {
  const scrollToTarget = typeof options.scrollToTarget === "function"
    ? options.scrollToTarget
    : defaultFragmentScroller;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : (event.target instanceof Node ? event.target.parentElement : null);
    const link = target?.closest?.("a[href]");
    if (!link || link.hasAttribute("download")) return;
    const href = link.getAttribute("href");
    if (handleInternalFragmentLinkClick(event, href, scrollToTarget)) return;
    const url = normalizeOpenableLinkUrl(href);
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    openLinkInNewTab(url);
  }, true);
}

function handleInternalFragmentLinkClick(event: Event, href: string | null, scrollToTarget: (target: HTMLElement) => void) {
  const hash = internalFragmentHash(href);
  if (!hash) return false;
  event.preventDefault();
  event.stopPropagation();
  scrollToInternalFragment(hash, scrollToTarget);
  return true;
}

function internalFragmentHash(href: string | null) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  if (raw.startsWith("#")) return raw.length > 1 ? raw : "";
  let url;
  try {
    url = new URL(raw, location.href);
  } catch(_e) {
    return "";
  }
  if (
    url.origin === location.origin &&
    url.pathname === location.pathname &&
    url.search === location.search &&
    url.hash
  ) {
    return url.hash;
  }
  return "";
}

function scrollToInternalFragment(hash: string, scrollToTarget = defaultFragmentScroller) {
  let id = "";
  try {
    id = decodeURIComponent(String(hash || "").replace(/^#/, ""));
  } catch (_e) {
    id = String(hash || "").replace(/^#/, "");
  }
  if (!id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  scrollToTarget(target);
  return true;
}

function defaultFragmentScroller(target: HTMLElement) {
  target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function normalizeOpenableLinkUrl(href: string | null) {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#")) return "";
  let url;
  try {
    url = new URL(raw, location.href);
  } catch(_e) {
    return "";
  }
  if (url.origin === location.origin && url.pathname === location.pathname && url.hash) return "";
  if (!["http:", "https:"].includes(url.protocol)) return "";
  return url.href;
}

function openLinkInNewTab(url: string) {
  try {
    const created = chrome.tabs.create({ url, active: true });
    if (created && typeof created.catch === "function") {
      created.catch(() => fallbackOpenLink(url));
    }
  } catch(_e) {
    fallbackOpenLink(url);
  }
}

function fallbackOpenLink(url: string) {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch(_e) {}
}

const MARKDOWN_API = Object.freeze({
  render: renderMarkdown,
  renderAssistantContent: renderAssistantContentHtml,
  renderErrorInto: renderChatErrorCardInto,
  renderErrorHtml: renderChatErrorCardHtml,
  extractMathPlaceholders: extractMarkdownMathPlaceholders,
  setAssistantFailureClass,
  isAssistantFailureText,
  normalizeFailureText: normalizeFailureTextForCompare,
});

let installed = false;

export function createMarkdownFeature(options: LinkOptions = {}) {
  if (!installed) {
    installed = true;
    installExternalLinkHandler(options);
  }
  return MARKDOWN_API;
}

export {
  extractMarkdownMathPlaceholders,
  isAssistantFailureText,
  normalizeFailureTextForCompare,
  renderAssistantContentHtml,
  renderChatErrorCardHtml,
  renderChatErrorCardInto,
  renderMarkdown,
  setAssistantFailureClass,
};
