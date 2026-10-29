import { t, tHtml } from "../i18n/index.js";
import { timelineGroupTools } from "./renderer-input.js";
export { timelineGroupTools } from "./renderer-input.js";
import { toolPresentationRegistry, type ToolPresentationLabel } from "./tool-presentation.js";
import { resolveFamilyTimelineTarget } from "./timeline-navigation.js";
import { record, type TranscriptEntry as Entry, type ToolRenderOptions, type ToolPresentation } from "./renderer-input.js";

interface TimelineOptions extends ToolRenderOptions, ToolPresentation {
  uiKey?: string;
  presentationAnchor?: string;
  runId?: string;
  activeThinkingKey?: string;
  viewStateKey?: string;
  activeIndex?: number;
  mode?: string;
}
export interface TimelineElement extends HTMLElement {
  __thinkingTimelineGroupEntry?: Entry;
  __toolTimelineGroupEntry?: Entry;
  __toolTimelinePresentationOptions?: TimelineOptions;
}
interface ThinkingState { userToggled: boolean; expanded: boolean; activeThinkingKey: string; element: HTMLElement }
interface Turn {
  key: string; runId: string; prefaceAssistants: Entry[]; thinkings: Entry[];
  tools: Entry[]; assistants: Entry[]; closedByAssistant: boolean;
}
interface Batch {
  familyId: string; name: string; target: string; count: number; firstIndex: number;
  latestIndex: number; indexes: number[]; latestTool: Entry;
}
interface Family {
  id: string; label: string; shortLabel: string; items: { tool: Entry; index: number }[];
  batches: Batch[]; latestIndex: number;
}
declare global {
  var __QINGZHOU_TOOL_TIMELINE_TRACE: boolean | undefined;
  var __QINGZHOU_TOOL_TIMELINE_TRACE_BUFFER: Record<string, unknown>[] | undefined;
}
import { commitRendererTree, disposeRendererTree, preserveRendererSubtree } from "./renderer-host.js";
import { parseBeijingDateTime } from "../../shared/time-utils.js";
import { formatToolActionTitle } from "../../shared/tools/tool-metadata.js";
import {
  getToolActionLabel,
  getToolTimelineFamilyInfo,
  getToolUiMeta,
  isPageContextToolName,
  resolveToolState,
} from "./tool-model.js";
import {
  ensureToolRawPanelRendered,
  normalizeToolResult,
  pageDisplayTarget,
  preserveToolDetailScrollState,
  queueStreamingDetailScroll,
  renderToolEvent,
  toolEventLaneMode,
  toolRendererRegistry,
} from "./tool-renderer.js";
import { escapeHtml } from "../ui/ui-utils.js";
import { installTailTracker, scrollToTail, setFollowTail, shouldFollowTail } from "../ui/scroll-tail-controller.js";
import {
  hasActiveSelectionInsideNode,
  morphElementChildren,
  patchAttributes,
} from "../ui/dom-morph.js";
import {
  renderThinkingSummaryPreview,
  setThinkingSummaryPreview,
} from "../ui/thinking-preview-motion.js";
import { enrichSkillToolIdentity } from "./skill-tool-ui-registry.js";

const TOOL_TIMELINE_STEP_MODE_LIMIT = 12;
const TOOL_FAMILY_BATCH_PREVIEW_LIMIT = 3;
const TOOL_TIMELINE_TRACE_STORAGE_KEY = "qingzhou.toolTimelineTrace";
const TOOL_TIMELINE_TRACE_BUFFER_LIMIT = 120;
const transientClassTimers = new WeakMap<HTMLElement, Map<string, number>>();
const thinkingTimelineGroupViewStateByKey = new Map<string, ThinkingState>();

export function groupConsecutiveToolTranscriptEntries(history: Entry[]) {
  const out: Entry[] = [];
  let currentUserKey = "";
  let turnOrdinal = 0;
  let turn: Turn | null = null;

  const flushTurn = () => {
    if (!turn) return;
    for (const assistant of turn.prefaceAssistants) {
      if (String(assistant?.content || "").trim() || assistant?.streaming) out.push(assistant);
    }
    if (turn.thinkings.length) {
      out.push(createThinkingTimelineGroupEntry(turn.thinkings, {
        uiKey: `${turn.key}:thinking`,
        runId: turn.runId,
      }));
    }
    const visibleTools = visibleTimelineTools(turn.tools);
    if (visibleTools.length) {
      const presentationAnchor = `${turn.key}:tools`;
      out.push(visibleTools.length >= 2
        ? createToolTimelineGroupEntry(visibleTools, {
          uiKey: presentationAnchor,
          presentationAnchor,
          runId: turn.runId,
        })
        : { ...visibleTools[0], _toolPresentationAnchor: presentationAnchor });
    }
    for (const assistant of turn.assistants) {
      if (String(assistant?.content || "").trim() || assistant?.streaming) out.push(assistant);
    }
    turn = null;
  };

  const ensureTurn = (entry: Entry) => {
    const runId = String(entry?.runId || "");
    if (turn?.closedByAssistant && (entry?.type === "thinking" || entry?.type === "tool")) flushTurn();
    if (turn && turn.runId && runId && turn.runId !== runId) flushTurn();
    if (!turn) {
      turnOrdinal += 1;
      const keyBase = currentUserKey || runId || entry?._uiKey || entry?.spanId || entry?.timestamp || "orphan";
      turn = {
        key: `${keyBase}:assistant-turn:${turnOrdinal}`,
        runId,
        prefaceAssistants: [],
        thinkings: [],
        tools: [],
        assistants: [],
        closedByAssistant: false,
      };
    } else if (!turn.runId && runId) {
      turn.runId = runId;
    }
    return turn;
  };

  for (const entry of Array.isArray(history) ? history : []) {
    if (entry?.type === "user") {
      flushTurn();
      out.push(entry);
      currentUserKey = String(entry?._uiKey || entry?.clientMessageId || entry?.timestamp || "");
      turnOrdinal = 0;
      continue;
    }
    if (entry?.type === "thinking") {
      if (entry.streaming || thinkingTimelineText(entry).trim()) {
        ensureTurn(entry).thinkings.push(entry);
      }
      continue;
    }
    if (entry?.type === "tool") {
      ensureTurn(entry).tools.push(entry);
      continue;
    }
    if (entry?.type === "assistant") {
      const currentTurn = ensureTurn(entry);
      const hasLaneActivity = currentTurn.thinkings.length || currentTurn.tools.length;
      if (hasLaneActivity) {
        currentTurn.assistants.push(entry);
        currentTurn.closedByAssistant = true;
      } else {
        currentTurn.prefaceAssistants.push(entry);
      }
      continue;
    }
    flushTurn();
    out.push(entry);
  }
  flushTurn();
  return out;
}

export function createToolTimelineGroupEntry(entries: Entry[], options: TimelineOptions = {}) {
  const tools = timelineGroupTools({ entries });
  const first = tools[0] || {};
  const last = tools[tools.length - 1] || first;
  return {
    type: "tool-group",
    entries: tools,
    _uiKey: options.uiKey || `${first._uiKey || first.toolCallId || first.name || "tool"}:timeline-group`,
    _toolPresentationAnchor: options.presentationAnchor || first._toolPresentationAnchor || "",
    runId: options.runId || first.runId || "",
    timestamp: first.timestamp || "",
    endedAt: last.endedAt || "",
  };
}


function visibleTimelineTools(tools: Entry[]) {
  const items = (Array.isArray(tools) ? tools : [])
    .filter(item => item?.type === "tool")
    .filter(item => !isHiddenTimelineTool(item));
  if (items.some(tool => !isPureTimeWaitTool(tool))) {
    return items.filter(tool => !isPureTimeWaitTool(tool));
  }
  return items;
}

function isHiddenTimelineTool(tool: Entry) {
  return toolPresentationRegistry.timelineVisibility(tool) === "hidden";
}

function isPureTimeWaitTool(tool: Entry) {
  return toolPresentationRegistry.timelineVisibility(tool) === "standalone";
}

export function createThinkingTimelineGroupEntry(entries: Entry[], options: TimelineOptions = {}) {
  const thoughts = thinkingTimelineGroupEntries({ entries });
  const first = thoughts[0] || {};
  const last = thoughts[thoughts.length - 1] || first;
  return {
    type: "thinking-group",
    entries: thoughts,
    _uiKey: options.uiKey || `${first._uiKey || first.id || first.timestamp || hashText(thinkingTimelineText(first)) || "thinking"}:thinking-group`,
    runId: options.runId || first.runId || "",
    timestamp: first.timestamp || "",
    endedAt: last.endedAt || last.timestamp || "",
  };
}

export function thinkingTimelineGroupEntries(entry?: Entry) {
  return Array.isArray(entry?.entries) ? entry.entries.filter(item => item?.type === "thinking") : [];
}

export function createThinkingTimelineGroupElement(entry: Entry, options: TimelineOptions = {}) {
  const thoughts = thinkingTimelineGroupEntries(entry);
  const el = document.createElement("div");
  const viewStateKey = thinkingTimelineGroupViewStateKey(entry);
  const rememberedState = getRememberedThinkingTimelineGroupViewState(viewStateKey);
  const rememberedActiveKey = rememberedState?.userToggled ? rememberedState.activeThinkingKey : "";

  const activeIndex = resolveThinkingTimelineActiveIndex(thoughts, options.activeThinkingKey || rememberedActiveKey);
  const activeThought = thoughts[activeIndex] || thoughts[0] || {};
  const shouldExpand = Object.prototype.hasOwnProperty.call(options, "expanded")
    ? Boolean(options.expanded)
    : Boolean(rememberedState?.userToggled && rememberedState.expanded);
  const state = thinkingTimelineGroupState(thoughts);
  const running = state === "running";
  const { title, preview } = thinkingTimelineSummaryText(thoughts, activeThought, state);
  el.className = `msg msg-thinking-group${shouldExpand ? " thinking-group-expanded" : ""}`;
  el.dataset.chatLane = shouldExpand ? "detail" : "summary";

  el.dataset.thinkingTimelineSignature = thinkingTimelineGroupSignature(entry);
  if (viewStateKey) el.dataset.thinkingTimelineViewStateKey = viewStateKey;
  if (rememberedState?.userToggled) el.dataset.userToggled = "true";
  el.dataset.activeThinkingKey = thinkingTimelineEntryKey(activeThought);
  el.innerHTML = `
    <button class="qz-chiphead thinking-group-summary ${running ? "thinking-group-summary-running" : ""}" type="button" aria-expanded="${shouldExpand ? "true" : "false"}">
      <span class="thinking-dot ${thinkingTimelineDotClass(state)}" aria-hidden="true"></span>
      <span class="thinking-group-title">${escapeHtml(title)}</span>
      <span class="thinking-group-preview">${renderThinkingSummaryPreview(preview, running)}</span>
      <span class="tool-caret thinking-caret">${shouldExpand ? "▾" : "▸"}</span>
    </button>
    <div class="thinking-group-details${shouldExpand ? "" : " hidden"}" data-auto-expanded="${shouldExpand ? "true" : "false"}" data-active-thinking-key="${escapeHtml(thinkingTimelineEntryKey(activeThought))}">
      <div class="thinking-group-slot"></div>
    </div>
  `;

  const previewEl = el.querySelector<HTMLElement>(":scope > .thinking-group-summary .thinking-group-preview");
  if (previewEl) {
    setThinkingSummaryPreview(previewEl, preview, running);
  }
  const details = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
  if (rememberedState?.userToggled && details) details.dataset.userToggled = "true";
  if (rememberedState?.userToggled && viewStateKey) {
    thinkingTimelineGroupViewStateByKey.set(viewStateKey, {
      ...rememberedState,
      element: el,
    });
  }

  rememberThinkingTimelineGroupRenderState(el, entry);
  if (shouldExpand) renderThinkingTimelineActiveSlot(el, activeIndex);
  attachThinkingTimelineGroupHandlers(el);
  return el;
}

export function patchThinkingTimelineGroupElement(el: TimelineElement, entry: Entry) {
  if (!el) return false;
  if (hasActiveSelectionInsideNode(el)) return true;

  const nextSignature = thinkingTimelineGroupSignature(entry);
  if (el.dataset.thinkingTimelineSignature === nextSignature) {
    rememberThinkingTimelineGroupRenderState(el, entry, nextSignature);
    return true;
  }

  const currentSummary = el.querySelector<HTMLElement>(":scope > .thinking-group-summary");
  const currentDetails = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
  const viewStateKey = el.dataset.thinkingTimelineViewStateKey || thinkingTimelineGroupViewStateKey(entry);
  const rememberedState = getRememberedThinkingTimelineGroupViewState(viewStateKey);
  const domUserToggled = el.dataset.userToggled === "true" || currentDetails?.dataset.userToggled === "true";
  const wasExpanded = domUserToggled
    ? currentSummary?.getAttribute("aria-expanded") === "true" && !currentDetails?.classList.contains("hidden")
    : Boolean(rememberedState?.expanded);
  const wasUserToggled = domUserToggled || rememberedState?.userToggled === true;
  const activeThinkingKey = wasUserToggled
    ? (currentDetails?.dataset.activeThinkingKey || el.dataset.activeThinkingKey || rememberedState?.activeThinkingKey || "")
    : "";
  const shouldExpand = wasUserToggled ? wasExpanded : false;
  const next = createThinkingTimelineGroupElement(entry, {
    expanded: shouldExpand,
    activeThinkingKey,
  });

  patchAttributes(el, next);
  preserveToolDetailScrollState(el, () => {
    morphElementChildren(el, next, { preserveSubtree: shouldPreserveMorphSubtree, beforeRemove: disposeRendererTree, beforeReplace: disposeRendererTree });
    commitRendererTree(el);
  });
  updateThinkingSummaryPreview(el, entry);

  const nextDetails = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
  if (nextDetails) {
    if (wasUserToggled) {
      el.dataset.userToggled = "true";
      nextDetails.dataset.userToggled = "true";
      rememberThinkingTimelineGroupUserState(el, {
        expanded: shouldExpand,
        activeThinkingKey,
        viewStateKey,
      });
    } else {
      delete el.dataset.userToggled;
      delete nextDetails.dataset.userToggled;
    }
  }
  rememberThinkingTimelineGroupRenderState(el, entry);
  return true;
}

function updateThinkingSummaryPreview(el: TimelineElement, entry: Entry) {
  const thoughts = thinkingTimelineGroupEntries(entry);
  const previewEl = el?.querySelector<HTMLElement>(":scope > .thinking-group-summary .thinking-group-preview");
  if (!previewEl || !thoughts.length) return;
  const details = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
  const activeIndex = resolveThinkingTimelineActiveIndex(thoughts, details?.dataset.activeThinkingKey);
  const state = thinkingTimelineGroupState(thoughts);
  const running = state === "running";
  const preview = details && !details.classList.contains("hidden")
    ? t("currentStep", { index: activeIndex + 1, total: thoughts.length, title: summarizeThinkingPreview(thoughts[activeIndex]) })
    : thinkingTimelineSummaryText(thoughts, thoughts[activeIndex], state).preview;
  setThinkingSummaryPreview(previewEl, preview, running);
}

function attachThinkingTimelineGroupHandlers(el: TimelineElement) {
  el.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const nav = target.closest<HTMLElement>(".thinking-group-nav-btn");
    if (nav && el.contains(nav)) {
      event.preventDefault();
      event.stopPropagation();
      const thoughts = thinkingTimelineGroupEntries(el.__thinkingTimelineGroupEntry);
      const details = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
      if (details) details.dataset.userToggled = "true";
      const current = Number(details?.dataset.activeThinkingIndex ?? resolveThinkingTimelineActiveIndex(thoughts, details?.dataset.activeThinkingKey));
      const direction = Number(nav.dataset.thinkingNavDirection) || 0;
      const next = Math.max(0, Math.min(thoughts.length - 1, current + direction));
      if (next !== current) renderThinkingTimelineActiveSlot(el, next);
      rememberThinkingTimelineGroupUserState(el, { expanded: true });
      return;
    }

    const summary = target.closest<HTMLElement>(".thinking-group-summary");
    if (!summary || summary.parentElement !== el) return;
    event.preventDefault();
    event.stopPropagation();
    const details = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
    if (!details) return;
    details.dataset.userToggled = "true";
    const expanded = !details.classList.toggle("hidden");
    summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    const caret = summary.querySelector<HTMLElement>(".thinking-caret");
    if (caret) caret.textContent = expanded ? "▾" : "▸";
    el.classList.toggle("thinking-group-expanded", expanded);
    el.dataset.chatLane = expanded ? "detail" : "summary";
    const thoughts = thinkingTimelineGroupEntries(el.__thinkingTimelineGroupEntry);
    if (expanded) {
      renderThinkingTimelineActiveSlot(el, resolveThinkingTimelineActiveIndex(thoughts, details.dataset.activeThinkingKey));
    } else {
      const previewEl = summary.querySelector<HTMLElement>(".thinking-group-preview");
      if (previewEl) {
        setThinkingSummaryPreview(
          previewEl,
          thinkingTimelineSummaryText(thoughts, thoughts[resolveThinkingTimelineActiveIndex(thoughts)], thinkingTimelineGroupState(thoughts)).preview,
          thinkingTimelineGroupState(thoughts) === "running",
        );
      }
    }
    rememberThinkingTimelineGroupUserState(el, { expanded });
  });
}

function thinkingTimelineGroupViewStateKey(entry?: Entry) {
  const thoughts = thinkingTimelineGroupEntries(entry);
  const first = thoughts[0] || {};
  const key = thinkingTimelineEntryKey(first) || entry?._uiKey || "";
  return key ? `thinking:${key}` : "";
}

function getRememberedThinkingTimelineGroupViewState(viewStateKey: string) {
  if (!viewStateKey) return null;
  const state = thinkingTimelineGroupViewStateByKey.get(viewStateKey);
  if (!state) return null;
  if (state.element && !state.element.isConnected) {
    thinkingTimelineGroupViewStateByKey.delete(viewStateKey);
    return null;
  }
  return state;
}

function rememberThinkingTimelineGroupUserState(el: TimelineElement, options: TimelineOptions = {}) {
  if (!el) return;
  const details = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
  const summary = el.querySelector<HTMLElement>(":scope > .thinking-group-summary");
  const viewStateKey = options.viewStateKey || el.dataset.thinkingTimelineViewStateKey || thinkingTimelineGroupViewStateKey(el.__thinkingTimelineGroupEntry);
  if (!viewStateKey) return;
  const expanded = Object.prototype.hasOwnProperty.call(options, "expanded")
    ? Boolean(options.expanded)
    : Boolean(summary?.getAttribute("aria-expanded") === "true" && !details?.classList.contains("hidden"));
  const activeThinkingKey = options.activeThinkingKey || details?.dataset.activeThinkingKey || el.dataset.activeThinkingKey || "";
  thinkingTimelineGroupViewStateByKey.set(viewStateKey, {
    userToggled: true,
    expanded,
    activeThinkingKey,
    element: el,
  });
  el.dataset.thinkingTimelineViewStateKey = viewStateKey;
  el.dataset.userToggled = "true";
  if (details) details.dataset.userToggled = "true";
}

export function renderThinkingTimelineActiveSlot(el: TimelineElement, index: number) {
  const thoughts = thinkingTimelineGroupEntries(el.__thinkingTimelineGroupEntry);
  const activeThought = thoughts[index] || thoughts[0];
  const slot = el.querySelector<HTMLElement>(".thinking-group-slot");
  const details = el.querySelector<HTMLElement>(":scope > .thinking-group-details");
  if (!activeThought || !slot || !details) return;

  el.dataset.activeThinkingKey = thinkingTimelineEntryKey(activeThought);
  el.dataset.activeThinkingIndex = String(index);
  details.dataset.activeThinkingKey = thinkingTimelineEntryKey(activeThought);
  details.dataset.activeThinkingIndex = String(index);
  slot.innerHTML = `
    <div class="thinking-group-slot-head">
      <div class="thinking-group-slot-title">
        <b>${escapeHtml(thinkingTimelineSlotTitle(index, thoughts.length))}</b>
      </div>
      ${renderThinkingTimelineSlotNav(index, thoughts)}
    </div>
    <pre class="thinking-group-body user-selectable"></pre>
  `;
  const body = slot.querySelector<HTMLElement>(".thinking-group-body");
  if (body) {
    body.textContent = thinkingTimelineText(activeThought);
    setFollowTail(body, Boolean(activeThought.streaming));
    installTailTracker(body);
    requestAnimationFrame(() => {
      if (body.isConnected && shouldFollowTail(body)) scrollToTail(body);
    });
  }

  const summaryPreview = el.querySelector<HTMLElement>(":scope > .thinking-group-summary .thinking-group-preview");
  if (summaryPreview && !details.classList.contains("hidden")) {
    setThinkingSummaryPreview(summaryPreview, t("currentStep", { index: index + 1, total: thoughts.length, title: summarizeThinkingPreview(activeThought) }), thoughts.some(thought => thought?.streaming));
  }
}

function renderThinkingTimelineSlotNav(index: number, thoughts: Entry[]) {
  const total = thoughts.length;
  if (total <= 1) return "";
  return `
    <div class="timeline-pager thinking-group-slot-nav" aria-label="${tHtml("switchReasoning")}">
      <button class="qz-icon-btn qz-icon-btn--secondary qz-icon-btn--xs timeline-pager-btn thinking-group-nav-btn" type="button" data-thinking-nav-direction="-1" aria-label="${tHtml("previousReasoning")}" title="${tHtml("previousReasoning")}"${index <= 0 ? " disabled" : ""}>‹</button>
      <span>${escapeHtml(String(index + 1))}/${escapeHtml(String(total))}</span>
      <button class="qz-icon-btn qz-icon-btn--secondary qz-icon-btn--xs timeline-pager-btn thinking-group-nav-btn" type="button" data-thinking-nav-direction="1" aria-label="${tHtml("nextReasoning")}" title="${tHtml("nextReasoning")}"${index >= total - 1 ? " disabled" : ""}>›</button>
    </div>
  `;
}

function resolveThinkingTimelineActiveIndex(thoughts: Entry[], activeThinkingKey = "") {
  if (!thoughts.length) return 0;
  if (activeThinkingKey) {
    const selected = thoughts.findIndex(thought => thinkingTimelineEntryKey(thought) === activeThinkingKey);
    if (selected >= 0) return selected;
  }
  const running = findLastIndex(thoughts, thought => Boolean(thought?.streaming));
  if (running >= 0) return running;
  return thoughts.length - 1;
}

function thinkingTimelineSlotTitle(index: number, total: number) {
  if (total <= 1) return t("latestReasoning");
  return index === total - 1 ? t("latestReasoning") : t("pastReasoning", { number: index + 1 });
}

function thinkingTimelineSummaryText(thoughts: Entry[], activeThought: Entry, state = "completed") {
  const normalizedState = normalizeThinkingTimelineState(state);
  const running = normalizedState === "running";
  const count = thoughts.length;
  const latest = thoughts[thoughts.length - 1] || activeThought || {};
  const preview = count > 1
    ? t("reasoningCount", { count: count, text: summarizeThinkingPreview(latest, { running }) })
    : summarizeThinkingPreview(latest, { running });
  return { title: thinkingTimelineTitle(normalizedState), preview };
}

function thinkingTimelineTitle(state: unknown) {
  if (state === "running") return t("reasoningRunning");
  if (state === "aborted") return t("reasoningCancelled");
  if (state === "error") return t("reasoningFailed");
  return t("reasoningCompleted");
}

function thinkingTimelineDotClass(state: unknown) {
  const normalized = normalizeThinkingTimelineState(state);
  return normalized === "aborted" ? "aborted" : normalized === "error" ? "error" : normalized;
}

function thinkingTimelineGroupState(thoughts: Entry[] = []) {
  const entries = Array.isArray(thoughts) ? thoughts : [];
  if (entries.some(thought => thinkingTimelineEntryState(thought) === "running")) return "running";
  if (entries.some(thought => thinkingTimelineEntryState(thought) === "aborted")) return "aborted";
  if (entries.some(thought => thinkingTimelineEntryState(thought) === "error")) return "error";
  return "completed";
}

function thinkingTimelineEntryState(thought: Entry) {
  if (thought?.streaming) return "running";
  const phase = String(thought?.phase || thought?.status || "").trim().toLowerCase();
  if (["aborted", "cancelled", "canceled"].includes(phase)) return "aborted";
  if (phase === "error" || thought?.isError) return "error";
  return "completed";
}

function normalizeThinkingTimelineState(state: unknown) {
  if (state === true) return "running";
  if (state === false) return "completed";
  const value = String(state || "").trim().toLowerCase();
  if (["running", "aborted", "error", "completed"].includes(value)) return value;
  return "completed";
}

function summarizeThinkingPreview(thought: Entry, { running = false } = {}) {
  const text = thinkingTimelineText(thought).replace(/\s+/g, " ").trim();
  if (!text) return t("recorded");
  const limit = running ? 280 : 72;
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function thinkingTimelineText(thought?: Entry) {
  return String(thought?.text ?? thought?.content ?? "");
}

function thinkingTimelineEntryKey(thought?: Entry) {
  return String(thought?._uiKey || thought?.id || thought?.timestamp || hashText(thinkingTimelineText(thought)));
}

function thinkingTimelineGroupSignature(entry: Entry = {}) {
  const thoughts = thinkingTimelineGroupEntries(entry);
  return hashText(JSON.stringify(thoughts.map(thought => ({
    key: thinkingTimelineEntryKey(thought),
    text: hashText(thinkingTimelineText(thought)),
    streaming: Boolean(thought?.streaming),
    phase: thought?.phase || "",
    status: thought?.status || "",
    isError: Boolean(thought?.isError),
    timestamp: thought?.timestamp || "",
    endedAt: thought?.endedAt || "",
  }))));
}

function rememberThinkingTimelineGroupRenderState(el: TimelineElement, entry: Entry, signature = thinkingTimelineGroupSignature(entry)) {
  if (!el) return;
  el.__thinkingTimelineGroupEntry = entry;
  el.dataset.thinkingTimelineSignature = signature;
}

export function createToolTimelineGroupElement(entry: Entry, options: TimelineOptions = {}, signature = toolTimelineGroupSignature(entry)) {
  const tools = timelineGroupTools(entry);
  const el = document.createElement("div");

  const presentationState = options.presentationState || null;
  const activeToolKey = presentationState?.activeToolKey || options.activeToolKey || "";
  const activeIndex = resolveToolTimelineActiveIndex(tools, activeToolKey);
  const activeTool = tools[activeIndex] || tools[0] || {};
  const mode = toolTimelineRenderMode(tools);
  const shouldExpand = presentationState
    ? Boolean(presentationState.userToggled && presentationState.expanded)
    : Boolean(options.expanded ?? false);
  const userToggled = presentationState
    ? presentationState.userToggled === true
    : options.userToggled === true;
  el.className = `msg msg-tool msg-tool-timeline${shouldExpand ? " tool-timeline-expanded" : ""}`;
  el.dataset.chatLane = toolTimelineLaneMode(tools, shouldExpand);
  const tone = toolTimelineTone(tools);
  const statusClass = tone === "success" ? "" : tone === "waiting" ? "running" : tone;
  const { title, preview } = toolTimelineSummaryText(tools, activeTool, {
    activeIndex,
    expanded: shouldExpand,
    mode,
  });
  const duration = toolTimelineDurationText(tools);

  el.dataset.activeToolKey = toolTimelineEntryKey(activeTool);
  el.innerHTML = `
    <button class="qz-chiphead tool-summary tool-timeline-summary ${tone !== "success" ? `tool-timeline-summary-${tone}` : ""}" type="button" aria-expanded="${shouldExpand ? "true" : "false"}">
      <span class="dot ${statusClass}" title="${tone === "incomplete" ? tHtml("toolResultIncomplete") : ""}"></span>
      <span class="tool-name">${escapeHtml(title)}</span>
      <span class="tool-args-preview">${escapeHtml(preview)}</span>
      <span class="tool-caret">${shouldExpand ? "▾" : "▸"}</span>
    </button>
    <div class="tool-details tool-timeline-details${mode === "family" ? " tool-timeline-details-family" : ""}${shouldExpand ? "" : " hidden"}" data-auto-expanded="${shouldExpand ? "true" : "false"}" data-active-tool-key="${escapeHtml(toolTimelineEntryKey(activeTool))}" data-timeline-mode="${mode}">
      <div class="tool-timeline-nav-area" data-tool-timeline-nav-signature="${escapeHtml(toolTimelineNavigatorSignature(tools, mode))}">
        ${renderToolTimelineNavigator(tools, activeIndex, mode)}
      </div>
      <div class="tool-timeline-slot"></div>
      <div class="tool-timeline-footer">
        <div class="tool-timeline-footer-row">
          <button class="qz-btn qz-btn--ghost qz-btn--inline tool-timeline-raw-btn hidden" type="button" aria-expanded="false">${tHtml("viewRawData")}</button>
          <span class="tool-timeline-footer-spacer"></span>
          ${duration ? `<time class="tool-timeline-duration">${tHtml("elapsedTime", { duration })}</time>` : ""}
          <button class="qz-btn qz-btn--ghost qz-btn--inline tool-timeline-collapse-btn" type="button">${tHtml("collapse")}</button>
        </div>
        <div class="tool-timeline-raw-panel hidden"></div>
      </div>
    </div>
  `;

  const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  if (userToggled && details) details.dataset.userToggled = "true";
  rememberToolTimelineGroupRenderState(el, entry, signature, options);
  if (shouldExpand) ensureToolTimelineActiveSlot(el, activeIndex);
  attachToolTimelineGroupHandlers(el);
  return el;
}

export function patchToolTimelineGroupElement(el: TimelineElement, entry: Entry, options: TimelineOptions = {}) {
  if (!el) return false;
  if (hasActiveSelectionInsideNode(el)) return true;

  const nextSignature = toolTimelineGroupSignature(entry);
  if (el.dataset.toolTimelineSignature === nextSignature) {
    rememberToolTimelineGroupRenderState(el, entry, nextSignature, options);
    return true;
  }

  const tools = timelineGroupTools(entry);
  const previousTools = timelineGroupTools(el.__toolTimelineGroupEntry);
  const previousTone = toolTimelineTone(previousTools);
  const nextTone = toolTimelineTone(tools);
  const currentDetails = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  const presentationState = options.presentationState || {};
  const wasExpanded = Boolean(presentationState.userToggled && presentationState.expanded);
  const wasUserToggled = presentationState.userToggled === true;
  const activeToolKey = presentationState.activeToolKey || "";
  const shouldExpand = wasUserToggled ? wasExpanded : false;
  const rawPanelWasOpen = isToolTimelineRawPanelOpen(currentDetails);
  const next = createToolTimelineGroupElement(entry, {
    expanded: shouldExpand,
    userToggled: wasUserToggled,
    activeToolKey,
    presentationState,
    onPresentationChange: options.onPresentationChange,
    deferMount: true,
  }, nextSignature);
  const nextDetailsTemplate = next.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  const keepsActiveTool = Boolean(
    currentDetails
    && currentDetails.dataset.activeToolKey
    && currentDetails.dataset.activeToolKey === nextDetailsTemplate?.dataset.activeToolKey
  );
  const patch = () => {
    patchAttributes(el, next);
    morphElementChildren(el, next, { preserveSubtree: shouldPreserveMorphSubtree, beforeRemove: disposeRendererTree, beforeReplace: disposeRendererTree });
    commitRendererTree(el);
  };
  if (keepsActiveTool && currentDetails) preserveToolDetailScrollState(currentDetails, patch);
  else patch();
  restoreToolTimelineRawPanelOpen(el, rawPanelWasOpen);
  if (shouldSettleToolTimelineSummary(previousTone, nextTone)) {
    triggerToolTimelineSummarySettle(el);
  }

  const nextDetails = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  if (nextDetails) {
    if (wasUserToggled) nextDetails.dataset.userToggled = "true";
    else delete nextDetails.dataset.userToggled;
    queueStreamingDetailScroll(nextDetails.querySelector<HTMLElement>(".tool-timeline-slot-body.tool-details-streaming"));
  }
  rememberToolTimelineGroupRenderState(el, entry, nextSignature, options);
  return true;
}

function attachToolTimelineGroupHandlers(el: TimelineElement) {
  el.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rawButton = target.closest<HTMLElement>(".tool-timeline-raw-btn");
    if (rawButton && el.contains(rawButton)) {
      event.preventDefault();
      event.stopPropagation();
      const panel = el.querySelector<HTMLElement>(".tool-timeline-raw-panel");
      if (!panel) return;
      if (panel.classList.contains("hidden")) ensureToolRawPanelRendered(panel);
      const expanded = !panel.classList.toggle("hidden");
      rawButton.setAttribute("aria-expanded", expanded ? "true" : "false");
      return;
    }

    const collapse = target.closest<HTMLElement>(".tool-timeline-collapse-btn");
    if (collapse && el.contains(collapse)) {
      event.preventDefault();
      event.stopPropagation();
      const summary = el.querySelector<HTMLElement>(":scope > .tool-timeline-summary");
      const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
      setToolTimelineGroupExpanded(el, summary, details, false);
      return;
    }

    const nav = target.closest<HTMLElement>(".tool-timeline-nav-btn");
    if (nav && el.contains(nav)) {
      event.preventDefault();
      event.stopPropagation();
      const tools = timelineGroupTools(el.__toolTimelineGroupEntry);
      const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
      if (details) details.dataset.userToggled = "true";
      const current = Number(details?.dataset.activeToolIndex ?? resolveToolTimelineActiveIndex(tools, details?.dataset.activeToolKey));
      const direction = Number(nav.dataset.timelineNavDirection) || 0;
      const navHost = nav.closest<HTMLElement>(".tool-timeline-slot-nav");
      const navMode = navHost?.dataset.timelineMode || details?.dataset.timelineMode || "family";
      const next = resolveToolTimelineNavTarget(tools, current, direction, navMode);
      traceToolTimeline("nav", {
        mode: navMode,
        direction,
        current,
        next,
        navText: navHost?.textContent?.replace(/\s+/g, " ").trim() || "",
        navScope: navHost?.querySelector<HTMLElement>("span")?.dataset.positionScope || "",
        currentTool: tools[current]?.name || "",
        nextTool: tools[next]?.name || "",
        currentFamily: toolFamilyInfo(tools[current]).id,
        nextFamily: toolFamilyInfo(tools[next]).id,
      });
      if (next !== current) ensureToolTimelineActiveSlot(el, next);
      notifyToolTimelinePresentationChange(el, { activeToolKey: toolTimelineEntryKey(tools[next] || tools[current]) });
      return;
    }

    const step = target.closest<HTMLElement>(".tool-timeline-step, .tool-family-row, .tool-family-batch");
    if (step && el.contains(step)) {
      event.preventDefault();
      event.stopPropagation();
      const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
      if (details) details.dataset.userToggled = "true";
      const index = Number(step.dataset.toolTimelineIndex);
      if (!Number.isFinite(index)) return;
      traceToolTimeline("select", {
        mode: details?.dataset.timelineMode || "",
        index,
        tool: timelineGroupTools(el.__toolTimelineGroupEntry)[index]?.name || "",
        family: step.dataset.toolFamilyId || "",
        kind: step.classList.contains("tool-family-batch")
          ? "batch"
          : step.classList.contains("tool-family-row")
            ? "family"
            : "step",
        batchIndexes: step.dataset.toolTimelineIndexes || "",
      });
      ensureToolTimelineActiveSlot(el, index);
      notifyToolTimelinePresentationChange(el, { activeToolKey: toolTimelineEntryKey(timelineGroupTools(el.__toolTimelineGroupEntry)[index]) });
      return;
    }

    const summary = target.closest<HTMLElement>(".tool-timeline-summary");
    if (!summary || summary.parentElement !== el) return;
    const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
    if (!details) return;
    const expanded = details.classList.contains("hidden");
    setToolTimelineGroupExpanded(el, summary, details, expanded);
    const tools = timelineGroupTools(el.__toolTimelineGroupEntry);
    if (expanded) {
      ensureToolTimelineActiveSlot(el, resolveToolTimelineActiveIndex(tools, details.dataset.activeToolKey), { afterPaint: true });
    } else {
      updateToolTimelineSummaryForState(el, false);
    }
  });
}

function traceToolTimeline(stage: string, payload: Record<string, unknown> = {}) {
  if (!isToolTimelineTraceEnabled()) return;
  const entry = {
    stage,
    at: new Date().toISOString(),
    ...payload,
  };
  try {
    const buffer = Array.isArray(globalThis.__QINGZHOU_TOOL_TIMELINE_TRACE_BUFFER)
      ? globalThis.__QINGZHOU_TOOL_TIMELINE_TRACE_BUFFER
      : [];
    buffer.push(entry);
    if (buffer.length > TOOL_TIMELINE_TRACE_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - TOOL_TIMELINE_TRACE_BUFFER_LIMIT);
    }
    globalThis.__QINGZHOU_TOOL_TIMELINE_TRACE_BUFFER = buffer;
  } catch {
    // Trace should never affect the UI path.
  }
  try {
    console.debug("[轻舟 tool-timeline]", stage, entry);
  } catch {
    // Ignore consoles that are unavailable in test harnesses.
  }
}

function isToolTimelineTraceEnabled() {
  try {
    if (globalThis.__QINGZHOU_TOOL_TIMELINE_TRACE === true) return true;
    const value = globalThis.localStorage?.getItem?.(TOOL_TIMELINE_TRACE_STORAGE_KEY);
    return value === "1" || value === "true" || value === "on";
  } catch {
    return false;
  }
}

function setToolTimelineGroupExpanded(el: TimelineElement, summary: HTMLElement | null, details: HTMLElement | null, expanded: boolean) {
  if (!details || !summary) return;
  details.dataset.userToggled = "true";
  details.classList.toggle("hidden", !expanded);
  summary.setAttribute("aria-expanded", expanded ? "true" : "false");
  el?.classList.toggle("tool-timeline-expanded", Boolean(expanded));
  if (el) el.dataset.chatLane = toolTimelineLaneMode(timelineGroupTools(el.__toolTimelineGroupEntry), expanded);
  const caret = summary.querySelector<HTMLElement>(".tool-caret");
  if (caret) caret.textContent = expanded ? "▾" : "▸";
  updateToolTimelineSummaryForState(el, expanded);
  notifyToolTimelinePresentationChange(el, { expanded });
}

function notifyToolTimelinePresentationChange(el: TimelineElement, patch: TimelineOptions = {}) {
  const details = el?.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  if (details) details.dataset.userToggled = "true";
  const callback = el?.__toolTimelinePresentationOptions?.onPresentationChange;
  if (typeof callback !== "function") return;
  callback({
    userToggled: true,
    expanded: Object.prototype.hasOwnProperty.call(patch, "expanded")
      ? Boolean(patch.expanded)
      : Boolean(el.querySelector<HTMLElement>(":scope > .tool-timeline-summary")?.getAttribute("aria-expanded") === "true"),
    activeToolKey: patch.activeToolKey || details?.dataset.activeToolKey || el.dataset.activeToolKey || "",
  });
}

function toolTimelineLaneMode(tools: Entry[], expanded: boolean) {
  if (!expanded) return "summary";
  return (Array.isArray(tools) ? tools : []).some(tool => toolEventLaneMode(tool, true) === "wide")
    ? "wide"
    : "detail";
}

function isToolTimelineRawPanelOpen(details: HTMLElement | null) {
  return Boolean(details?.querySelector<HTMLElement>(":scope .tool-timeline-raw-panel:not(.hidden)"));
}

function restoreToolTimelineRawPanelOpen(el: TimelineElement, open: boolean) {
  if (!open) return;
  const rawButton = el?.querySelector<HTMLElement>(".tool-timeline-raw-btn:not(.hidden)");
  const rawPanel = el?.querySelector<HTMLElement>(".tool-timeline-raw-panel");
  if (!rawButton || !rawPanel) return;
  ensureToolRawPanelRendered(rawPanel);
  rawPanel.classList.remove("hidden");
  rawButton.setAttribute("aria-expanded", "true");
}

function shouldSettleToolTimelineSummary(previousTone: string, nextTone: string) {
  return (previousTone === "running" || previousTone === "waiting") && nextTone === "success";
}

function triggerToolTimelineSummarySettle(el: TimelineElement) {
  triggerTransientClass(el?.querySelector<HTMLElement>(":scope > .tool-timeline-summary"), "tool-summary-settled", 900);
}

function triggerTransientClass(el: HTMLElement | null, className: string, duration = 800) {
  if (!el || !className) return;
  let timers = transientClassTimers.get(el);
  if (!timers) {
    timers = new Map();
    transientClassTimers.set(el, timers);
  }
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  clearTimeout(timers.get(className));
  timers.set(className, setTimeout(() => {
    el.classList.remove(className);
    timers.delete(className);
  }, duration));
}

function renderToolTimelineNavigator(tools: Entry[], activeIndex: number, mode: string) {
  if (mode === "family") return renderToolTimelineFamilyTrace(tools, activeIndex);
  return `
    <div class="tool-timeline-rail">
      ${tools.map((tool, index) => renderToolTimelineStep(tool, index, index === activeIndex)).join("")}
    </div>
  `;
}

function toolTimelineRenderMode(tools: Entry[]) {
  return tools.length > TOOL_TIMELINE_STEP_MODE_LIMIT ? "family" : "steps";
}

function renderToolTimelineFamilyTrace(tools: Entry[], activeIndex: number) {
  const families = buildToolTimelineFamilies(tools);
  const activeTool = tools[activeIndex] || tools[0] || {};
  const activeFamilyId = toolFamilyInfo(activeTool).id;
  return `
    <div class="tool-family-trace" data-family-count="${families.length}">
      <div class="tool-family-tabs" role="list" aria-label="${tHtml("toolTypes")}">
        ${families.map(family => renderToolFamilyTab(family, activeFamilyId)).join("")}
      </div>
      <div class="tool-family-submenu">
        <div class="tool-family-panels">
          ${families.map(family => renderToolFamilyPanel(family, activeIndex, activeFamilyId)).join("")}
        </div>
        <div class="tool-family-panel-nav"></div>
      </div>
    </div>
  `;
}

function renderToolFamilyTab(family: Family, activeFamilyId: string) {
  const active = family.id === activeFamilyId;
  const state = toolTimelineFamilyState(family);
  return `
    <button class="qz-pill tool-family-row ${active ? "active" : ""}" type="button" role="listitem" data-tool-family-id="${escapeHtml(family.id)}" data-tool-timeline-index="${family.latestIndex}" aria-current="${active ? "true" : "false"}" title="${escapeHtml(toolFamilySummary(family))}">
      <span class="mini-dot ${state}" title="${state === "incomplete" ? tHtml("toolResultIncomplete") : ""}"></span>
      <span class="tool-family-title">${escapeHtml(family.shortLabel || family.label)}</span>
      <span class="tool-family-count">${escapeHtml(String(family.items.length))}</span>
    </button>
  `;
}

function renderToolFamilyPanel(family: Family, activeIndex: number, activeFamilyId: string) {
  const active = family.id === activeFamilyId;
  // Keep each preview page stable while visiting its calls, and always show the selected batch.
  const selected = family.batches.findIndex(batch => batch.indexes.includes(activeIndex));
  const batchIndex = selected < 0 ? family.batches.length - 1 : selected;
  const start = Math.min(
    Math.floor(batchIndex / TOOL_FAMILY_BATCH_PREVIEW_LIMIT) * TOOL_FAMILY_BATCH_PREVIEW_LIMIT,
    Math.max(0, family.batches.length - TOOL_FAMILY_BATCH_PREVIEW_LIMIT),
  );
  const [primaryBatch, ...remainingBatches] = family.batches.slice(start, start + TOOL_FAMILY_BATCH_PREVIEW_LIMIT);
  return `
    <section class="tool-family-panel ${active ? "active" : ""}" data-tool-family-id="${escapeHtml(family.id)}">
      <div class="tool-family-primary-batch">
        ${primaryBatch ? renderToolFamilyBatch(primaryBatch, activeIndex) : ""}
      </div>
      ${remainingBatches.length ? `
        <div class="tool-family-batches">
          ${remainingBatches.map(batch => renderToolFamilyBatch(batch, activeIndex)).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderToolFamilyBatch(batch: Batch, activeIndex: number) {
  const indexes = toolFamilyBatchIndexes(batch);
  const active = indexes.includes(Number(activeIndex));
  return `
    <button class="qz-pill tool-family-batch ${active ? "active" : ""}" type="button" data-tool-family-id="${escapeHtml(batch.familyId)}" data-tool-timeline-index="${batch.latestIndex}" data-tool-timeline-indexes="${escapeHtml(indexes.join(","))}" title="${escapeHtml(batchSummary(batch))}">
      <span>${escapeHtml(toolTimelineActionLabel(batch.latestTool || batch.name))}</span>
      <b>${escapeHtml(batch.count > 1 ? `×${batch.count}` : "1")}</b>
      ${batch.target ? `<em>${escapeHtml(batch.target)}</em>` : ""}
    </button>
  `;
}

function toolFamilyBatchIndexes(batch: Partial<Batch> = {}) {
  const raw = Array.isArray(batch?.indexes) && batch.indexes.length ? batch.indexes : [batch?.latestIndex];
  return raw
    .map(value => Number(value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function timelineIndexListIncludes(value: unknown, index: number) {
  const target = Number(index);
  if (!Number.isFinite(target)) return false;
  return String(value || "")
    .split(",")
    .map(item => Number(item.trim()))
    .filter(Number.isFinite)
    .includes(target);
}

function buildToolTimelineFamilies(tools: Entry[]) {
  const map = new Map<string, Family>();
  (Array.isArray(tools) ? tools : []).forEach((tool, index) => {
    const familyInfo = toolFamilyInfo(tool);
    if (!map.has(familyInfo.id)) {
      map.set(familyInfo.id, {
        ...familyInfo,
        items: [],
        batches: [],
        latestIndex: index,
      });
    }
    const family = map.get(familyInfo.id)!;
    family.items.push({ tool, index });
    family.latestIndex = index;

    const target = rawStepTarget(tool);
    const name = tool?.name || "tool";
    let batch = family.batches.at(-1);
    // Only consecutive calls within a family can merge without reversing pager traversal.
    if (!batch || batch.name !== name || batch.target !== target) {
      batch = {
        familyId: family.id,
        name,
        target,
        count: 0,
        firstIndex: index,
        latestIndex: index,
        indexes: [],
        latestTool: tool,
      };
      family.batches.push(batch);
    }
    batch.count += 1;
    batch.latestIndex = index;
    batch.indexes.push(index);
    batch.latestTool = tool;
  });

  return Array.from(map.values());
}

function toolFamilyInfo(toolOrName: Entry | string) {
  toolOrName = toolOrName && typeof toolOrName === "object"
    ? enrichSkillToolIdentity(toolOrName)
    : enrichSkillToolIdentity({ name: String(toolOrName || "") });
  return getToolTimelineFamilyInfo(toolOrName);
}

function toolTimelineFamilyState(family: Family) {
  const latest = latestTimelineItem(family.items)?.tool;
  return latest ? resolveTimelineToolState(latest) : "success";
}

function toolFamilySummary(family: Family) {
  const recent = family.batches
    .slice(-3)
    .map(batch => `${toolTimelineActionLabel(batch.latestTool || batch.name)}${batch.count > 1 ? ` ×${batch.count}` : ""}`)
    .join(" · ");
  return recent ? `${family.label}：${recent}` : family.label;
}

function batchSummary(batch: Batch) {
  return `${toolTimelineActionLabel(batch.latestTool || batch.name)}${batch.count > 1 ? ` ×${batch.count}` : ""}${batch.target ? ` · ${batch.target}` : ""}`;
}

function toolTimelineActionLabel(toolOrName: Entry | string = "") {
  toolOrName = toolOrName && typeof toolOrName === "object"
    ? enrichSkillToolIdentity(toolOrName)
    : enrichSkillToolIdentity({ name: String(toolOrName || "") });
  const args = record(toolOrName.args);
  if (getToolUiMeta(toolOrName) || toolOrName.title) return formatToolActionTitle(toolOrName, args);
  return getToolActionLabel(toolOrName);
}

function rawStepTarget(tool: Entry) {
  const args = record(tool?.args);
  // Only custom projections need an isolated result; built-in labels read scalar fields.
  const hasTargetProjection = toolPresentationRegistry.has("timelineTarget", tool);
  const result = hasTargetProjection ? normalizeToolResult(tool?.result) : tool?.result;
  const resultObject = record(result);
  const target = hasTargetProjection
    ? toolPresentationRegistry.project("timelineTarget", tool, args, result, "", "timeline")
    : undefined;
  if (target !== undefined) return summarizeTimelineTarget(target);
  const pageTarget = isPageContextToolName(tool)
    ? pageDisplayTarget(args, resultObject, { maxLength: 36, fallbackToTabId: false })
    : "";
	  return summarizeTimelineTarget(firstNonEmpty([
	    args.table && t("tableNamed", { name: String(args.table) }),
	    args.target,
	    args.selector,
	    pageTarget,
    args.url,
    args.skill && args.script ? `${args.skill}/${args.script}` : "",
    args.skill,
    args.server && args.tool ? `${args.server}/${args.tool}` : "",
    args.tool,
    args.filename,
    args.docModelId,
    args.artifactId,
    args.query,
    args.pattern,
    resultObject.title,
    resultObject.url,
    resultObject.selector,
    resultObject.table,
    resultObject.filename,
  ]));
}

function summarizeTimelineTarget(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 72);
}

function renderToolTimelineStep(tool: Entry, index: number, active = false) {
  const state = resolveTimelineToolState(tool);
  return `
    <button class="qz-pill tool-timeline-step ${state}${active ? " active" : ""}" type="button" data-tool-timeline-index="${index}" title="${escapeHtml(tool.name || "")}">
      <span class="mini-dot" title="${state === "incomplete" ? tHtml("toolResultIncomplete") : ""}"></span>
      <span>${escapeHtml(toolTimelineActionLabel(tool))}</span>
    </button>
  `;
}

export function ensureToolTimelineActiveSlot(el: TimelineElement, index: number, { afterPaint = false } = {}) {
  const tools = timelineGroupTools(el.__toolTimelineGroupEntry);
  const activeTool = tools[index] || tools[0];
  const slot = el.querySelector<HTMLElement>(".tool-timeline-slot");
  const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  if (!activeTool || !slot || !details) return;
  const signature = `${el.dataset.toolTimelineSignature || ""}:${index}:${toolTimelineEntryKey(activeTool)}`;
  if (slot.dataset.toolTimelineSlotSignature === signature && slot.firstElementChild) return;
  if (!afterPaint) {
    renderToolTimelineActiveSlot(el, index, signature);
    return;
  }
  slot.dataset.toolTimelinePendingSignature = signature;
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (
        !el.isConnected
        || details.classList.contains("hidden")
        || slot.dataset.toolTimelinePendingSignature !== signature
      ) return;
      renderToolTimelineActiveSlot(el, index, signature);
    }, 0);
  });
}

function renderToolTimelineActiveSlot(el: TimelineElement, index: number, signature: string) {
  const tools = timelineGroupTools(el.__toolTimelineGroupEntry);
  const activeTool = tools[index] || tools[0];
  const slot = el.querySelector<HTMLElement>(".tool-timeline-slot");
  const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  if (!activeTool || !slot || !details) return;

  el.dataset.activeToolKey = toolTimelineEntryKey(activeTool);
  el.dataset.activeToolIndex = String(index);
  details.dataset.activeToolKey = toolTimelineEntryKey(activeTool);
  details.dataset.activeToolIndex = String(index);
  syncToolTimelineNavigator(el, tools, index, details.dataset.timelineMode || "steps");
  for (const step of el.querySelectorAll<HTMLElement>(".tool-timeline-step")) {
    step.classList.toggle("active", Number(step.dataset.toolTimelineIndex) === index);
  }
  const activeFamilyId = toolFamilyInfo(activeTool).id;
  for (const panel of el.querySelectorAll<HTMLElement>(".tool-family-panel")) {
    panel.classList.toggle("active", panel.dataset.toolFamilyId === activeFamilyId);
  }
  for (const item of el.querySelectorAll<HTMLElement>(".tool-family-row, .tool-family-batch")) {
    const exactActive = Number(item.dataset.toolTimelineIndex) === index;
    const familyActive = item.classList.contains("tool-family-row") && item.dataset.toolFamilyId === activeFamilyId;
    const batchActive = item.classList.contains("tool-family-batch")
      && timelineIndexListIncludes(item.dataset.toolTimelineIndexes || item.dataset.toolTimelineIndex, index);
    item.classList.toggle("active", exactActive || familyActive || batchActive);
    if (item.classList.contains("tool-family-row")) {
      item.setAttribute("aria-current", familyActive ? "true" : "false");
    }
  }

  const renderOptions = el.__toolTimelinePresentationOptions || {};
  const rendered = renderToolEvent(activeTool, { standaloneFooter: false, lazyDetails: false, deferMount: true, static: renderOptions.static });
  const activeDetails = rendered.querySelector<HTMLElement>(":scope > .tool-details");
  const rawButton = el.querySelector<HTMLElement>(".tool-timeline-raw-btn");
  const rawPanel = el.querySelector<HTMLElement>(".tool-timeline-raw-panel");
  if (rawButton) {
    rawButton.classList.add("hidden");
    rawButton.setAttribute("aria-expanded", "false");
  }
  if (rawPanel) {
    rawPanel.classList.add("hidden");
    delete rawPanel.dataset.rawToolRendered;
    rawPanel.replaceChildren();
  }
  const mode = details.dataset.timelineMode;
  const navAttachedToFamilyPanel = updateToolTimelineFamilyPanelNav(el, index, tools, mode);
  traceToolTimeline("active-slot", {
    mode,
    index,
    tool: activeTool.name || "",
    family: activeFamilyId,
    activeBatchIndexes: el.querySelector<HTMLElement>(".tool-family-batch.active")?.dataset.toolTimelineIndexes || "",
  });
  const previousBody = slot.querySelector<HTMLElement>(":scope > .tool-timeline-slot-body");
  const previousKey = previousBody?.dataset.toolRendererOwner;
  previousBody?.remove();
  disposeRendererTree(slot);
  slot.replaceChildren();
  if (!navAttachedToFamilyPanel) {
    const slotNav = renderToolTimelineSlotNav(index, tools, mode);
    if (slotNav) {
      slot.innerHTML = `
        <div class="tool-timeline-slot-head">
          ${renderToolTimelineSlotTitle(activeTool)}
          ${slotNav}
        </div>
      `;
    }
  }
  let body: HTMLElement = document.createElement("div");
  body.className = "tool-timeline-slot-body";
  body.dataset.toolRendererOwner = toolTimelineEntryKey(activeTool);
  if (activeDetails) {
    activeDetails.classList.remove("hidden");
    for (const className of activeDetails.classList) {
      if (className !== "tool-details" && className !== "hidden") body.classList.add(className);
    }
    while (activeDetails.firstChild) body.appendChild(activeDetails.firstChild);
    const rawDetails = body.querySelector<HTMLElement>(":scope > .tool-raw-details");
    if (rawDetails && rawButton && rawPanel) {
      rawDetails.querySelector<HTMLElement>("summary")?.remove();
      while (rawDetails.firstChild) rawPanel.appendChild(rawDetails.firstChild);
      rawDetails.remove();
      rawButton.classList.remove("hidden");
    }
    queueStreamingDetailScroll(body);
  } else {
    body.innerHTML = `<div class="tool-compact-line"><div class="tool-compact-title">${escapeHtml(toolTimelineActionLabel(activeTool))}</div><div class="tool-compact-subtitle">${tHtml("noToolDetails")}</div></div>`;
  }
  if (previousBody && previousKey === body.dataset.toolRendererOwner) {
    preserveToolDetailScrollState(previousBody, () => {
      patchAttributes(previousBody, body);
      morphElementChildren(previousBody, body, { preserveSubtree: shouldPreserveMorphSubtree, beforeRemove: disposeRendererTree, beforeReplace: disposeRendererTree });
    });
    body = previousBody;
  } else if (previousBody) disposeRendererTree(previousBody);
  slot.appendChild(body);
  if (!renderOptions.deferMount && !renderOptions.static) commitRendererTree(body);
  slot.dataset.toolTimelineSlotSignature = signature;
  delete slot.dataset.toolTimelinePendingSignature;

  const summaryPreview = el.querySelector<HTMLElement>(":scope > .tool-timeline-summary .tool-args-preview");
  if (summaryPreview && !details.classList.contains("hidden")) {
    updateToolTimelineSummaryForState(el, true);
  }
}

function syncToolTimelineNavigator(el: TimelineElement, tools: Entry[], index: number, mode: string) {
  const area = el.querySelector<HTMLElement>(".tool-timeline-nav-area");
  if (!area) return;
  const signature = toolTimelineNavigatorSignature(tools, mode);
  const selectedBatchVisible = mode !== "family" || Array.from(area.querySelectorAll<HTMLElement>(".tool-family-batch"))
    .some(batch => timelineIndexListIncludes(batch.dataset.toolTimelineIndexes, index));
  if (area.dataset.toolTimelineNavSignature === signature && selectedBatchVisible) return;
  area.innerHTML = renderToolTimelineNavigator(tools, index, mode);
  area.dataset.toolTimelineNavSignature = signature;
}

function updateToolTimelineFamilyPanelNav(el: TimelineElement, index: number, tools: Entry[], mode = "steps") {
  const host = el?.querySelector<HTMLElement>(".tool-family-submenu > .tool-family-panel-nav");
  if (!host) return false;
  host.replaceChildren();
  if (mode !== "family") return false;
  const nav = renderToolTimelineSlotNav(index, tools, mode);
  if (!nav) return false;
  host.innerHTML = nav;
  return true;
}

function renderToolTimelineSlotTitle(tool: Entry) {
  const target = rawStepTarget(tool);
  return `
    <div class="tool-timeline-slot-title">
      <b>${escapeHtml(toolTimelineActionLabel(tool))}</b>
      ${target ? `<span>${escapeHtml(target)}</span>` : ""}
    </div>
  `;
}

function updateToolTimelineSummaryForState(el: TimelineElement, expanded: boolean | undefined = undefined) {
  const tools = timelineGroupTools(el?.__toolTimelineGroupEntry);
  if (!tools.length) return;
  const details = el.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  const summary = el.querySelector<HTMLElement>(":scope > .tool-timeline-summary");
  if (!details || !summary) return;
  const activeIndex = resolveToolTimelineActiveIndex(tools, details.dataset.activeToolKey);
  const activeTool = tools[activeIndex] || tools[0] || {};
  const isExpanded = expanded ?? !details.classList.contains("hidden");
  const text = toolTimelineSummaryText(tools, activeTool, {
    activeIndex,
    expanded: isExpanded,
    mode: details.dataset.timelineMode || "steps",
  });
  const nameEl = summary.querySelector<HTMLElement>(".tool-name");
  const previewEl = summary.querySelector<HTMLElement>(".tool-args-preview");
  if (nameEl) nameEl.textContent = text.title;
  if (previewEl) previewEl.textContent = text.preview;
}

function renderToolTimelineSlotNav(index: number, tools: Entry[], mode = "steps") {
  const total = tools.length;
  if (total <= 1) return "";
  const previousIndex = resolveToolTimelineNavTarget(tools, index, -1, mode);
  const nextIndex = resolveToolTimelineNavTarget(tools, index, 1, mode);
  const position = toolTimelineSlotPosition(tools, index, mode);
  const familyMode = mode === "family";
  const previousTitle = familyMode ? t("previousInFamily") : t("previousCall");
  const nextTitle = familyMode ? t("nextInFamily") : t("nextCall");
  return `
    <div class="timeline-pager tool-timeline-slot-nav" data-timeline-mode="${escapeHtml(familyMode ? "family" : "steps")}" aria-label="${tHtml("switchToolDetails")}">
      <button class="qz-icon-btn qz-icon-btn--secondary qz-icon-btn--xs timeline-pager-btn tool-timeline-nav-btn" type="button" data-timeline-nav-direction="-1" aria-label="${tHtml("previousCall")}" title="${escapeHtml(previousTitle)}"${previousIndex === index ? " disabled" : ""}>‹</button>
      <span title="${escapeHtml(position.title)}" data-position-scope="${escapeHtml(position.scope)}">${escapeHtml(String(position.current))}/${escapeHtml(String(position.total))}</span>
      <button class="qz-icon-btn qz-icon-btn--secondary qz-icon-btn--xs timeline-pager-btn tool-timeline-nav-btn" type="button" data-timeline-nav-direction="1" aria-label="${tHtml("nextCall")}" title="${escapeHtml(nextTitle)}"${nextIndex === index ? " disabled" : ""}>›</button>
    </div>
  `;
}

function toolTimelineSlotPosition(tools: Entry[], index: number, mode = "steps") {
  const total = tools.length;
  if (mode !== "family") {
    return {
      current: Math.max(1, Math.min(total, index + 1)),
      total,
      scope: "timeline",
      title: t("allToolsIndex", { index: index + 1, total: total }),
    };
  }

  const currentIndex = Math.max(0, Math.min(total - 1, Number(index) || 0));
  const activeTool = tools[currentIndex] || {};
  const activeFamily = toolFamilyInfo(activeTool);
  const familyItems = (Array.isArray(tools) ? tools : [])
    .map((tool, itemIndex) => ({ tool, index: itemIndex }))
    .filter(item => toolFamilyInfo(item.tool).id === activeFamily.id)
    .sort((a, b) => a.index - b.index);
  const familyIndex = familyItems.findIndex(item => item.index === currentIndex);
  if (familyIndex < 0 || !familyItems.length) {
    return {
      current: Math.max(1, Math.min(total, currentIndex + 1)),
      total,
      scope: "timeline",
      title: t("allToolsIndex", { index: currentIndex + 1, total: total }),
    };
  }
  return {
    current: familyIndex + 1,
    total: familyItems.length,
    scope: "family",
    title: t("familyToolIndex", { family: activeFamily.label, index: familyIndex + 1, count: familyItems.length, globalIndex: currentIndex + 1, total: total }),
  };
}

function resolveToolTimelineNavTarget(tools: Entry[], index: number, direction: number, mode = "family") {
  return resolveFamilyTimelineTarget(Array.isArray(tools) ? tools.map(tool => toolFamilyInfo(tool).id) : [], index, direction, mode);
}

export function resolveToolTimelineActiveIndex(tools: Entry[], activeToolKey = "") {
  if (!tools.length) return 0;
  if (activeToolKey) {
    const selected = tools.findIndex(tool => toolTimelineEntryKey(tool) === activeToolKey);
    if (selected >= 0) return selected;
  }
  const error = findLastIndex(tools, tool => {
    const state = resolveTimelineToolState(tool);
    return state === "error" || state === "aborted";
  });
  if (error >= 0) return error;
  const waiting = findLastIndex(tools, tool => isToolAwaitingHuman(tool));
  if (waiting >= 0) return waiting;
  const running = findLastIndex(tools, tool => Boolean(tool.isRunning || tool.argsIncomplete || tool.phase === "preparing"));
  if (running >= 0) return running;
  return tools.length - 1;
}

function toolTimelineEntryKey(tool?: Entry | null) {
  return String(tool?._uiKey || tool?.toolCallId || tool?.id || tool?.name || "");
}

function toolTimelineGroupSignature(entry: Entry = {}) {
  const tools = timelineGroupTools(entry);
  return hashText(JSON.stringify([toolRendererRegistry.revision, tools.map(toolTimelineToolSignature)]));
}

function rememberToolTimelineGroupRenderState(el: TimelineElement, entry: Entry, signature = toolTimelineGroupSignature(entry), options: TimelineOptions = {}) {
  if (!el) return;
  el.__toolTimelineGroupEntry = entry;
  el.__toolTimelinePresentationOptions = options;
  el.dataset.toolTimelineSignature = signature;
}

function isHumanInterventionTool(tool: Entry) {
  return ["ask_user", "wait_for_user"].includes(tool?.name || "");
}

function isToolAwaitingHuman(tool: Entry) {
  if (!isHumanInterventionTool(tool)) return false;
  return Boolean(tool?.isRunning || tool?.argsIncomplete || tool?.phase === "preparing" || (tool?.result == null && !tool?.endedAt));
}

function toolTimelineTone(tools: Entry[]) {
  return toolTimelineToneFromTool(latestTimelineTool(tools));
}

function resolveTimelineToolState(tool: Entry) {
  const state = resolveToolState(tool);
  return state === "running" && isToolAwaitingHuman(tool) ? "waiting" : state;
}

function toolTimelineSummaryText(tools: Entry[], activeTool: Entry, options: TimelineOptions = {}) {
  if (options.expanded && activeTool) {
    const activeIndex = options.activeIndex ?? resolveToolTimelineActiveIndex(tools);
    const position = toolTimelineSlotPosition(tools, activeIndex, options.mode || "steps");
    return {
      title: toolTimelineActionLabel(activeTool),
      preview: `${toolTimelineActiveMeta(activeTool)} · ${position.current}/${position.total}`,
    };
  }
  if (options.mode === "family") {
    return {
      title: t("toolExecutionOverview"),
      preview: t("toolFamilySteps", { steps: tools.length, families: buildToolTimelineFamilies(tools).length }),
    };
  }
  const title = inferToolTimelineGroupTitle(tools);
  const preview = t("toolSteps", { steps: tools.length, label: toolTimelineEvidenceSummary(tools, activeTool) });
  return { title, preview };
}

function latestTimelineTool(tools: Entry[]) {
  if (!Array.isArray(tools) || !tools.length) return null;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    if (tools[i]) return tools[i];
  }
  return null;
}

function latestTimelineItem(items: { tool: Entry; index: number }[]) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.reduce((latest, item) => {
    if (!latest) return item;
    return Number(item?.index ?? -1) >= Number(latest?.index ?? -1) ? item : latest;
  }, null as { tool: Entry; index: number } | null);
}

function toolTimelineToneFromTool(tool?: Entry | null) {
  if (!tool) return "success";
  return resolveTimelineToolState(tool);
}

function timelinePresentationLabels(projection: "timelineGroupTitle" | "timelineBadge", tools: Entry[]) {
  const labels = new Map<string, ToolPresentationLabel>();
  for (const input of tools) {
    const tool = enrichSkillToolIdentity(input);
    const label = toolPresentationRegistry.project(projection, tool, tool.args, normalizeToolResult(tool.result), "", "timeline");
    if (label?.label && !labels.has(label.key ?? label.label)) labels.set(label.key ?? label.label, label);
  }
  return [...labels.values()].sort((a, b) => a.order - b.order);
}

function inferToolTimelineGroupTitle(tools: Entry[]) {
  if (tools.length > TOOL_TIMELINE_STEP_MODE_LIMIT) return t("toolExecutionOverview");
  return timelinePresentationLabels("timelineGroupTitle", tools)[0]?.label || t("toolsIncluding", { name: toolTimelineActionLabel(tools[0]) });
}

function toolTimelineEvidenceSummary(tools: Entry[], activeTool: Entry) {
  if (tools.length > TOOL_TIMELINE_STEP_MODE_LIMIT) {
    return buildToolTimelineFamilies(tools)
      .slice(0, 3)
      .map(family => `${family.label} ${family.items.length}`)
      .join(" · ");
  }
  const parts = timelinePresentationLabels("timelineBadge", tools).map(item => item.label);
  if (tools.some(tool => isToolAwaitingHuman(tool))) parts.push(t("pendingConfirmation"));
  if (!parts.length && activeTool) parts.push(toolTimelineActionLabel(activeTool));
  return parts.slice(0, 3).join(" · ");
}

function toolTimelineActiveMeta(tool: Entry) {
  if (!tool) return "";
  const state = resolveTimelineToolState(tool);
  if (state === "aborted") return t("terminated");
  if (state === "error") return t("failed");
  if (state === "incomplete") return t("toolResultIncompleteShort");
  if (tool.isRunning && tool.statusText) return tool.statusText;
  if (state === "running") return t("running");
  if (state === "waiting") return t("awaitingApproval");
  const result = record(normalizeToolResult(tool.result));
  const description = toolPresentationRegistry.project("describeRun", tool, tool.args, result, "", "timeline");
  if (description !== undefined) return description;
  return t("completed");
}

function toolTimelineDurationText(tools: Entry[]) {
  const first = tools[0];
  const last = tools[tools.length - 1] || first;
  const resultSeconds = toolTimelineResultDurationSeconds(tools);
  const start = parseBeijingDateTime(first?.timestamp || "");
  const end = parseBeijingDateTime(last?.endedAt || last?.timestamp || "");
  if (start && end && end >= start) {
    const seconds = Math.max(0, (end - start) / 1000);
    const displaySeconds = tools.length === 1
      ? Math.max(seconds, resultSeconds)
      : (seconds > 0 ? seconds : resultSeconds);
    return formatToolTimelineDurationSeconds(displaySeconds);
  }
  if (resultSeconds > 0) return formatToolTimelineDurationSeconds(resultSeconds);
  if (tools.some(tool => tool?.isRunning || isToolAwaitingHuman(tool))) return "live";
  return "";
}

function toolTimelineResultDurationSeconds(tools: Entry[]) {
  const entries = Array.isArray(tools) ? tools : [];
  if (!entries.length) return 0;
  if (entries.length === 1) return toolResultDurationSeconds(entries[0]);
  return entries.reduce((sum, tool) => sum + toolResultDurationSeconds(tool), 0);
}

function toolResultDurationSeconds(tool: Entry) {
  const result = record(tool?.result);
  if (!result) return 0;
  const elapsedMs = firstPositiveNumber([
    result.elapsedMs,
    result.durationMs,
    record(result.timing).elapsedMs,
    record(result.details).elapsedMs,
  ]);
  return elapsedMs > 0 ? elapsedMs / 1000 : 0;
}

function firstPositiveNumber(values: unknown[]) {
  for (const value of values || []) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function formatToolTimelineDurationSeconds(secondsValue: unknown) {
  const seconds = Math.max(0, Number(secondsValue) || 0);
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  const totalSeconds = Math.round(seconds);
  const remainingSeconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function toolTimelineToolSignature(entry: Entry = {}) {
  return {
    key: toolTimelineEntryKey(entry),
    rendererId: entry.rendererId || "",
    spanId: entry.spanId || "",
    toolCallId: entry.toolCallId || "",
    runId: entry.runId || "",
    name: entry.name || "",
    args: entry.args ?? null,
    argsText: entry.argsText || "",
    argsIncomplete: Boolean(entry.argsIncomplete),
    argsGenerating: Boolean(entry.argsGenerating),
    argsState: entry.argsState || "",
    phase: entry.phase || "",
    statusText: entry.statusText || "",
    rateLimit: entry.rateLimit ?? null,
    result: entry.result ?? null,
    state: resolveTimelineToolState(entry),
    isError: Boolean(entry.isError),
    isRunning: Boolean(entry.isRunning),
    image: entry.image ? hashText(entry.image) : "",
    timestamp: entry.timestamp || "",
    endedAt: entry.endedAt || "",
  };
}

function shouldPreserveMorphSubtree(current: HTMLElement, next: HTMLElement) {
  if (preserveRendererSubtree(current, next)) return true;
  if (
    current.classList?.contains("thinking-group-preview")
    && next.classList?.contains("thinking-group-preview")
  ) return true;
  if (
    current.classList?.contains("tool-timeline-nav-area")
    && next.classList?.contains("tool-timeline-nav-area")
  ) {
    return Boolean(current.dataset.toolTimelineNavSignature)
      && current.dataset.toolTimelineNavSignature === next.dataset.toolTimelineNavSignature;
  }
  return false;
}

function toolTimelineNavigatorSignature(tools: Entry[], mode = "steps") {
  return [
    mode,
    ...(Array.isArray(tools) ? tools : []).map(tool => [
      toolTimelineEntryKey(tool),
      resolveTimelineToolState(tool),
      toolFamilyInfo(tool).id,
      toolTimelineActionLabel(tool),
      rawStepTarget(tool),
    ].join(":")),
  ].join("|");
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number, items: T[]) => boolean) {
  if (!Array.isArray(items)) return -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i, items)) return i;
  }
  return -1;
}

function hashText(text: unknown) {
  let hash = 0;
  const str = String(text || "");
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

function firstNonEmpty(values: unknown[]) {
  return values.find(value => value != null && String(value).trim() !== "") || "";
}
