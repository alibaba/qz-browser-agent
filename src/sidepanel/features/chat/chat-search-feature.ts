import type { TranscriptEntry, ToolEvent } from "../../tools/renderer-input.js";
import type { TranscriptImage } from "../../../shared/contracts/session.js";
interface SearchOptions {
  root?: Document | Element; messagesEl: HTMLElement; inputEl?: HTMLTextAreaElement;
  isActive?(): boolean; getSessionId?(): string | null; isCurrentSession?(id: string): boolean;
  getTranscript?(): TranscriptEntry[]; assignTranscriptUiKeys?(id: string | null, history: TranscriptEntry[]): void;
  projectTranscript?(history: TranscriptEntry[], options: { sessionId: string }): TranscriptEntry[];
  clearPartialTranscriptRender?(id: string | null): void;
  renderTranscript?(id: string | null, options: { force: boolean; intent: string }): void;
  compactNodeTitle?(entry: TranscriptEntry): string; compactNodeMeta?(entry: TranscriptEntry): string;
  compactNodeSummary?(entry: TranscriptEntry): string; runStatusText?(status: unknown): string;
  previewExtension?(entry: TranscriptEntry): string; scrollToMatch?(element: Element): void;
}
interface SearchMatch { key: string; type: string }

import { getToolDisplayName } from "../../tools/tool-model.js";
import {
  thinkingTimelineGroupEntries,
  timelineGroupTools,
} from "../../tools/tool-timeline-renderer.js";
import { extractMarkdownMathPlaceholders } from "./markdown-feature.js";

export function createChatSearchFeature(options: SearchOptions) {
  const root = options.root || document;
  const messagesEl = options.messagesEl;
  const inputEl = options.inputEl;
  const isActive = options.isActive || (() => false);
  const getSessionId = options.getSessionId || (() => "");
  const isCurrentSession = options.isCurrentSession || (() => false);
  const getTranscript = options.getTranscript || (() => []);
  const assignTranscriptUiKeys = options.assignTranscriptUiKeys || (() => {});
  const projectTranscript: NonNullable<SearchOptions["projectTranscript"]> = options.projectTranscript || (history => history);
  const clearPartialTranscriptRender = options.clearPartialTranscriptRender || (() => {});
  const renderTranscript = options.renderTranscript || (() => {});
  const compactNodeTitle = options.compactNodeTitle || (() => "");
  const compactNodeMeta = options.compactNodeMeta || (() => "");
  const compactNodeSummary = options.compactNodeSummary || (() => "");
  const runStatusText = options.runStatusText || (() => "");
  const previewExtension = options.previewExtension || (() => "");
  const scrollToMatch = options.scrollToMatch || ((target) => target?.scrollIntoView?.({ block: "center", inline: "nearest" }));

  if (!messagesEl) throw new Error("chat search messages element is required");

  const chatSearchBar = root.querySelector<HTMLElement>("#chat-search-bar");
  const chatSearchInput = root.querySelector<HTMLInputElement>("#chat-search-input");
  const chatSearchCount = root.querySelector<HTMLElement>("#chat-search-count");
  const chatSearchPrev = root.querySelector<HTMLButtonElement>("#chat-search-prev");
  const chatSearchNext = root.querySelector<HTMLButtonElement>("#chat-search-next");
  const chatSearchClose = root.querySelector<HTMLButtonElement>("#chat-search-close");

const chatSearchState = {
  open: false,
  query: "",
  matches: [] as SearchMatch[],
  activeIndex: -1,
};

document.addEventListener("keydown", handleChatSearchGlobalKeydown, { capture: true });
chatSearchInput?.addEventListener("input", handleChatSearchInput);
chatSearchBar?.addEventListener("keydown", handleChatSearchKeydown);
chatSearchPrev?.addEventListener("click", () => jumpChatSearch(-1));
chatSearchNext?.addEventListener("click", () => jumpChatSearch(1));
chatSearchClose?.addEventListener("click", () => closeChatSearch());

function isChatSearchShortcut(event: KeyboardEvent) {
  return Boolean(
    isActive()
    && !event.defaultPrevented
    && !event.altKey
    && (event.metaKey || event.ctrlKey)
    && String(event.key || "").toLowerCase() === "f"
  );
}

function handleChatSearchGlobalKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (isChatSearchShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    openChatSearch();
    return;
  }
  if (!chatSearchState.open) return;
  if (event.key === "Escape" && !(event.target instanceof Node && chatSearchBar?.contains(event.target))) {
    closeChatSearch();
  }
}

function openChatSearch() {
  if (!isActive()) return;
  chatSearchState.open = true;
  chatSearchBar?.classList.remove("hidden");
  if (getSessionId()) {
    clearPartialTranscriptRender(getSessionId());
    renderTranscript(getSessionId(), { force: true, intent: "snapshot" });
  }
  updateChatSearchMatches({ preserveActive: true });
  applyChatSearchDomState({ scroll: false });
  updateChatSearchControls();
  requestAnimationFrame(() => {
    chatSearchInput?.focus({ preventScroll: true });
    chatSearchInput?.select();
  });
}

function closeChatSearch({ restoreFocus = true } = {}) {
  if (!chatSearchState.open && !chatSearchState.query) return;
  chatSearchState.open = false;
  chatSearchState.query = "";
  chatSearchState.matches = [];
  chatSearchState.activeIndex = -1;
  if (chatSearchInput) chatSearchInput.value = "";
  chatSearchBar?.classList.add("hidden");
  clearChatSearchDomState();
  updateChatSearchControls();
  if (restoreFocus && isActive()) inputEl?.focus?.({ preventScroll: true });
}

function handleChatSearchInput() {
  chatSearchState.query = String(chatSearchInput?.value || "");
  updateChatSearchMatches({ preserveActive: false });
  applyChatSearchDomState({ scroll: false });
  updateChatSearchControls();
}

function handleChatSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeChatSearch();
    return;
  }
  if (event.key === "Enter" && event.target === chatSearchInput) {
    event.preventDefault();
    event.stopPropagation();
    jumpChatSearch(event.shiftKey ? -1 : 1);
  }
}

function jumpChatSearch(delta: number) {
  const total = chatSearchState.matches.length;
  if (!total) return;
  const current = chatSearchState.activeIndex >= 0 ? chatSearchState.activeIndex : (delta < 0 ? 0 : -1);
  chatSearchState.activeIndex = (current + delta + total) % total;
  applyChatSearchDomState({ scroll: true });
  updateChatSearchControls();
}

function syncChatSearchAfterTranscriptRender(sessionId: string) {
  if (!chatSearchState.open || !isCurrentSession(sessionId)) return;
  updateChatSearchMatches({ preserveActive: true });
  applyChatSearchDomState({ scroll: false });
  updateChatSearchControls();
}

function updateChatSearchMatches({ preserveActive = true } = {}) {
  const query = normalizeChatSearchText(chatSearchState.query);
  const previousKey = preserveActive ? chatSearchState.matches[chatSearchState.activeIndex]?.key || "" : "";
  if (!query || !getSessionId()) {
    chatSearchState.matches = [];
    chatSearchState.activeIndex = -1;
    return;
  }

  const history = getTranscript();
  assignTranscriptUiKeys(getSessionId(), history);
  const visibleHistory = projectTranscript(history, { sessionId: getSessionId() || "" });
  const matches = [];
  for (const entry of visibleHistory) {
    const key = entry?._uiKey || "";
    if (!key) continue;
    const text = normalizeChatSearchText(transcriptEntrySearchText(entry));
    if (text && text.includes(query)) matches.push({ key, type: entry.type || "" });
  }
  chatSearchState.matches = matches;
  if (!matches.length) {
    chatSearchState.activeIndex = -1;
    return;
  }
  const preserved = previousKey ? matches.findIndex(item => item.key === previousKey) : -1;
  chatSearchState.activeIndex = preserved >= 0 ? preserved : Math.min(Math.max(chatSearchState.activeIndex, 0), matches.length - 1);
}

function transcriptEntrySearchText(entry: TranscriptEntry = {}): string {
  if (!entry || typeof entry !== "object") return "";
  if (entry.type === "user") return [entry.text, imageSearchText(entry.images)].filter(Boolean).join("\n");
  if (entry.type === "assistant") return assistantTranscriptSearchText(entry.content || "");
  if (entry.type === "thinking") return entry.text || "";
  if (entry.type === "thinking-group") return thinkingTimelineGroupEntries(entry).map(transcriptEntrySearchText).join("\n");
  if (entry.type === "tool") return toolTranscriptSearchText(entry);
  if (entry.type === "tool-group") return timelineGroupTools(entry).map(toolTranscriptSearchText).join("\n");
  if (entry.type === "wait") return [entry.title, entry.message, entry.reason].filter(Boolean).join("\n");
  if (entry.type === "note" || entry.type === "error") return entry.text || "";
  if (entry.type === "compact") return [compactNodeTitle(entry), compactNodeMeta(entry), compactNodeSummary(entry)].filter(Boolean).join("\n");
  if (entry.type === "run-status") return entry.text || runStatusText(entry.status);
  return previewExtension(entry);
}

function toolTranscriptSearchText(entry: ToolEvent = {}) {
  return [
    getToolDisplayName(entry.name || ""),
    entry.name || "",
    stringifySearchValue(entry.args),
    entry.argsText || "",
    stringifySearchValue(entry.result),
    entry.statusText || "",
  ].filter(Boolean).join("\n");
}

function assistantTranscriptSearchText(content: unknown = "") {
  const source = String(content || "");
  if (!source) return "";
  return stripMarkdownMathFromSearchText(source);
}

function stripMarkdownMathFromSearchText(text = "") {
  const source = String(text || "");
  if (!source) return "";
  try {
    return extractMarkdownMathPlaceholders(source).markdown.replace(/@@QZ_MATH_\d+@@/g, " ");
  } catch (_err) {
    return source;
  }
}

function imageSearchText(images: TranscriptImage[] = []) {
  if (!Array.isArray(images)) return "";
  return images.map(img => [img?.name, img?.type, img?.url].filter(Boolean).join(" ")).filter(Boolean).join("\n");
}

function stringifySearchValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch (_err) {
    return String(value || "").slice(0, 4000);
  }
}

function normalizeChatSearchText(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase();
}

function updateChatSearchControls() {
  const total = chatSearchState.matches.length;
  const active = total && chatSearchState.activeIndex >= 0 ? chatSearchState.activeIndex + 1 : 0;
  if (chatSearchCount) chatSearchCount.textContent = `${active}/${total}`;
  const disabled = !total;
  if (chatSearchPrev) chatSearchPrev.disabled = disabled;
  if (chatSearchNext) chatSearchNext.disabled = disabled;
}

function applyChatSearchDomState({ scroll = false } = {}) {
  clearChatSearchDomState();
  if (!chatSearchState.open || !chatSearchState.query) return;
  const query = chatSearchState.query.trim();
  const active = chatSearchState.matches[chatSearchState.activeIndex] || null;
  for (const match of chatSearchState.matches) {
    const el = transcriptElementByKey(match.key);
    if (!el) continue;
    el.classList.add("chat-search-match-entry");
    highlightChatSearchText(el, query);
    if (active && match.key === active.key) el.classList.add("chat-search-active");
  }
  if (scroll) scrollToChatSearchMatch(active);
}

function clearChatSearchDomState() {
  for (const mark of Array.from(messagesEl.querySelectorAll("mark.chat-search-hit"))) {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
    parent?.normalize?.();
  }
  messagesEl.querySelectorAll(".chat-search-match-entry, .chat-search-active").forEach(el => {
    el.classList.remove("chat-search-match-entry", "chat-search-active");
  });
}

function highlightChatSearchText(root: Element, query: string) {
  const needle = String(query || "");
  if (!root || !needle) return;
  const lowerNeedle = needle.toLocaleLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node?.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || shouldSkipChatSearchHighlight(parent)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.toLocaleLowerCase().includes(lowerNeedle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue || "";
    const lower = text.toLocaleLowerCase();
    let cursor = 0;
    let index = lower.indexOf(lowerNeedle);
    if (index < 0) continue;
    const fragment = document.createDocumentFragment();
    while (index >= 0) {
      if (index > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
      const mark = document.createElement("mark");
      mark.className = "chat-search-hit";
      mark.textContent = text.slice(index, index + needle.length);
      fragment.appendChild(mark);
      cursor = index + needle.length;
      index = lower.indexOf(lowerNeedle, cursor);
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

function shouldSkipChatSearchHighlight(el: Element) {
  return Boolean(el.closest?.([
    "mark.chat-search-hit",
    "script",
    "style",
    "input",
    "textarea",
    "select",
    "option",
    "button",
    "svg",
    "mjx-container",
    ".math-formula",
    ".msg-actions",
    ".msg-user-actions",
    ".tool-event-footer",
    ".artifact-strip-actions",
  ].join(",")));
}

function transcriptElementByKey(key = "") {
  return key ? messagesEl.querySelector<HTMLElement>(`[data-transcript-key="${cssEscapeValue(key)}"]`) : null;
}

function scrollToChatSearchMatch(match: SearchMatch | null) {
  if (!match?.key) return;
  const el = transcriptElementByKey(match.key);
  if (!el) return;
  const target = el.querySelector("mark.chat-search-hit") || el;
  scrollToMatch(target);
}

  return {
    bar: chatSearchBar,
    open: openChatSearch,
    close: closeChatSearch,
    syncAfterRender: syncChatSearchAfterTranscriptRender,
    highlightText: highlightChatSearchText,
    elementByKey: transcriptElementByKey,
    isOpen: () => chatSearchState.open,
  };
}

function cssEscapeValue(value: unknown) {
  const text = String(value || "");
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(text)
    : text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
