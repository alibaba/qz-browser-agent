import { t, tHtml } from "../i18n/index.js";
import rendererCapabilities from "#capabilities/renderers";
import { toolPresentationRegistry } from "./tool-presentation.js";
import type { RendererExtensionAPI } from "../../sdk/sidepanel/renderers.js";
import * as skillPresentation from "./skill-renderer-context.js";
import { hashText as hashString, escapeHtml } from "../ui/ui-utils.js";
import * as presentation from "./generic-result-renderer.js";
import { record } from "./renderer-input.js";
import type { ToolEvent, ToolRenderOptions } from "./renderer-input.js";

import { commitRendererTree, disposeRendererTree, planRenderer, projectedRenderer, RendererRegistry, morphRendererChildren } from "./renderer-host.js";
import { formatToolActionTitle } from "../../shared/tools/tool-metadata.js";
import { highlightCode } from "../ui/code-highlighter.js";
import {
  hasActiveSelectionInsideNode,
} from "../ui/dom-morph.js";
import {
  installTailTracker,
  scrollToTail,
  setFollowTail,
  shouldFollowTail,
} from "../ui/scroll-tail-controller.js";
import {
  getToolDisplayName,
  getToolDetailLayout,
  getToolMediaPresentation,
  getToolProfileFamily,
  getToolUiMeta,
  isSkillToolRuntimeName,
  resolveToolState,
  toolKey,
} from "./tool-model.js";
import { localizeToolFailureText } from "../../shared/tools/tool-error-localization.js";
import { enrichSkillToolIdentity } from "./skill-tool-ui-registry.js";
import { getSkillRendererPresentationLane } from "../../shared/skills/skill-renderers.js";
import { createGenericResultRenderer } from "./generic-result-renderer.js";
import { createToolArgsPreview } from "./tool-args-preview.js";
import { createToolRuntimeDetails } from "./tool-runtime-details.js";
import { renderMarkdown as renderMarkdownHtml } from "../features/chat/markdown-feature.js";

type ToolEventView = ReturnType<typeof createToolEventView>;
type ToolDetails = HTMLElement & { __toolEventDetailsHandler?: (event: MouseEvent) => void };
interface ToolArgsInfo { value: Readonly<Record<string, unknown>>; rawText: string; incomplete: boolean }
type ImageMedia = { action: string; beforeImage?: string; afterImage?: string };
type ImageAction = ImageMedia & ({ kind: "frame" } | { kind: "point"; x: number; y: number; direction?: string } | { kind: "drag"; x: number; y: number; endX: number; endY: number; direction?: string });
const toolSummarySettleTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const toolEventStateByRoot = new WeakMap<HTMLElement, ToolEventView>();

export function renderToolEvent(tool: ToolEvent, options: ToolRenderOptions = {}) {
  const view = createToolEventView(tool, options);
  const div = document.createElement("div");
  div.className = "msg msg-tool";
  div.dataset.chatLane = toolEventLaneMode(tool, view.initiallyExpanded);
  rememberToolEventView(div, view);

  div.innerHTML = renderToolSummaryHtml(view);
  const summary = div.querySelector<HTMLElement>(".tool-summary");
  summary?.addEventListener("click", () => {
    const details = div.querySelector<HTMLElement>(":scope > .tool-details");
    if (!details) return;
    setToolEventExpanded(div, summary, details, details.classList.contains("hidden"));
  });

  if (view.hasDetails) {
    const details = createToolDetailsShell(view, { hidden: !view.initiallyExpanded });
    if (view.options.presentationState?.userToggled === true) details.dataset.userToggled = "true";
    div.classList.toggle("tool-expanded", view.initiallyExpanded);
    if (shouldRenderToolDetailsImmediately(view)) {
      renderToolDetailsInto(details, view, { preserveHidden: true });
    }
    div.appendChild(details);
    syncToolSummaryExpanded(summary, view.initiallyExpanded, view.hasDetails);
    attachToolEventDetailsHandlers(div, summary, details);
  }

  return div;
}

export function toolEventLaneMode(tool: ToolEvent = {}, expanded = false) {
  if (!expanded) return "summary";
  const identifiedTool = enrichSkillToolIdentity(tool);
  const registeredLane = identifiedTool.rendererId && toolRendererRegistry.resolve(identifiedTool.rendererId).lane;
  if (registeredLane) return registeredLane;
  const renderer = skillPresentation.resolveSkillToolRenderContext(identifiedTool?.name, identifiedTool?.args, identifiedTool?.result).renderer;
  return getToolDetailLayout(identifiedTool) === "wide" || getSkillRendererPresentationLane(renderer || {}) === "wide"
    ? "wide"
    : "detail";
}

function createToolEventView(tool: ToolEvent, options: ToolRenderOptions = {}) {
  tool = enrichSkillToolIdentity(tool);
  const argsInfo = normalizeToolArgsForRender(tool);
  const args = argsInfo.value;
  const hasResult = tool.result != null && tool.result !== "";
  const hasDetails = Boolean(!presentation.isEmptyJsonObject(args) || argsInfo.rawText || hasResult || tool.image);
  const statusText = String(tool.statusText || "").trim();
  const toolLabel = tool.isRunning && statusText
    ? statusText
    : formatToolHeaderLabel(tool, args, tool.result);
  const isStreamingDetails = Boolean(tool.isRunning && !hasResult && (tool.argsIncomplete || tool.phase === "preparing"));
  const presentationState = options.presentationState;
  const initiallyExpanded = presentationState
    ? Boolean(presentationState.userToggled && presentationState.expanded)
    : Boolean(options.expanded);
  const statusClass = toolStatusClass(tool);
  return {
    ...tool,
    tool,
    options,
    name: tool.name || "",
    label: toolLabel,
    statusClass,
    statusTitle: statusClass === "incomplete" ? t("toolResultIncomplete") : "",
    args,
    rawArgsText: argsInfo.rawText,
    argsIncomplete: argsInfo.incomplete,
    hasResult,
    hasDetails,
    hasImage: !!tool.image,
    isRunning: !!tool.isRunning,
    isError: !!tool.isError,
    statusText: tool.statusText || "",
    rateLimit: tool.rateLimit || null,
    isStreamingDetails,
    phase: tool.phase || "",
    result: tool.result,
    image: tool.image || "",
    initiallyExpanded,
    argsPreview: formatToolArgs(args, argsInfo.rawText, tool, tool.result),
    detailsSignature: toolDetailsRenderSignature(tool, argsInfo),
  };
}

function rememberToolEventView(root: HTMLElement, view: ToolEventView) {
  if (root && view) toolEventStateByRoot.set(root, view);
}

function renderToolSummaryHtml(view: ToolEventView) {
  return `
    <button class="qz-chiphead tool-summary" type="button" aria-expanded="false">
      <span class="dot ${view.statusClass}" title="${escapeHtml(view.statusTitle)}"></span>
      <span class="tool-name">${escapeHtml(view.label)}</span>
      <span class="tool-args-preview">${escapeHtml(view.argsPreview)}</span>
      ${view.hasDetails ? '<span class="tool-caret">▸</span>' : ''}
    </button>
  `;
}

function createToolDetailsShell(view: ToolEventView, { hidden = true } = {}) {
  const details = document.createElement("div");
  details.className = toolDetailsClassName(view, { hidden });
  details.dataset.autoExpanded = "false";
  details.dataset.toolDetailsLazy = "true";
  details.dataset.toolDetailsSignature = "";
  return details;
}

function toolDetailsClassName(view: ToolEventView, { hidden = true } = {}) {
  const detailClasses = ["tool-details"];
  if (hidden) detailClasses.push("hidden");
  if (view.isStreamingDetails) detailClasses.push("tool-details-streaming");
  const profileFamily = getToolProfileFamily(view);
  if (profileFamily) detailClasses.push(`tool-details-profile-${toolDetailClassSuffix(profileFamily)}`);
  const projected = toolRuntimeDetails.project(view);
  try {
    const contributed = toolRendererRegistry.resolve(projected.rendererId).detailsClass?.(projected);
    if (contributed) detailClasses.push(contributed);
  } catch { /* Optional decoration cannot prevent readable tool output. */ }
  detailClasses.push(`tool-details-${toolDetailClassSuffix(toolKey(view) || view.name)}`);
  return detailClasses.join(" ");
}

function shouldRenderToolDetailsImmediately(view: ToolEventView) {
  return view.initiallyExpanded || view.options.lazyDetails === false;
}

function ensureToolDetailsRendered(root: HTMLElement, details: HTMLElement, view = toolEventStateByRoot.get(root), { preserveHidden = true } = {}) {
  if (!root || !details || !view) return false;
  if (
    details.dataset.toolDetailsLazy !== "true"
    && details.dataset.toolDetailsSignature === view.detailsSignature
  ) {
    return true;
  }
  renderToolDetailsInto(details, view, { preserveHidden });
  attachToolEventDetailsHandlers(root, root.querySelector<HTMLElement>(":scope > .tool-summary"), details);
  return true;
}

function renderToolDetailsInto(details: HTMLElement, view: ToolEventView, { preserveHidden = true } = {}) {
  const hidden = preserveHidden ? details.classList.contains("hidden") : false;
  details.className = toolDetailsClassName(view, { hidden });
  details.dataset.autoExpanded = details.dataset.autoExpanded || "false";
  details.dataset.toolDetailsSignature = view.detailsSignature;
  details.dataset.toolDetailsLazy = "false";
  const previous = details;
  details = document.createElement("div");
  const content = document.createElement("div");
  content.style.display = "contents";
  const projected = toolRuntimeDetails.project({
    ...view, id: view.tool._uiKey || view.tool.toolCallId || view.name,
    rendererId: view.tool.rendererId || "",
  });
  planRenderer(content, toolRendererRegistry, projected, view.options.static === true);
  details.appendChild(content);
  const imageAction = normalizeImageActionDisplay(record(view.result)._display, view.args);
  const displayImage = imageAction?.afterImage || view.image || imageAction?.beforeImage || "";
  if (displayImage) {
    const mediaPresentation = getToolMediaPresentation(view);
    const isAssetPreview = mediaPresentation === "asset";
    const thumb = document.createElement("div");
    thumb.className = `tool-screenshot${isAssetPreview ? " tool-image-preview" : ""}`;
    const image = document.createElement("img");
    image.src = displayImage;
    if (view.image && view.image !== displayImage) image.dataset.fullSrc = view.image;
    image.alt = isAssetPreview ? "image preview" : "screenshot";
    image.title = t("clickToEnlarge");
    let actionLayer = thumb;
    if ((imageAction?.afterImage || view.image) && imageAction?.beforeImage) {
      thumb.classList.add("tool-image-action-transition");
      const beforeLayer = document.createElement("div");
      beforeLayer.className = "tool-image-action-before-layer";
      const beforeImage = document.createElement("img");
      beforeImage.className = "tool-image-action-before";
      beforeImage.src = imageAction.beforeImage;
      beforeImage.alt = "";
      beforeImage.setAttribute("aria-hidden", "true");
      beforeImage.draggable = false;
      image.classList.add("tool-image-action-after");
      beforeLayer.append(beforeImage);
      thumb.append(beforeLayer);
      actionLayer = beforeLayer;
    }
    thumb.append(image);
    appendImageActionOverlay(actionLayer, imageAction);
    details.appendChild(thumb);
  }
  if (!view.isStreamingDetails && toolRendererRegistry.resolve(projected.rendererId).showRawData !== false) {
    genericRenderer.appendRawToolData(details, {
      args: view.args,
      rawArgsText: view.rawArgsText,
      result: (view.hasResult || view.isError) ? stripToolDisplayFields(view.result) : undefined,
    });
  }
  if (view.options.standaloneFooter !== false) appendToolEventFooter(details);
  morphElementChildren(previous, details, !view.options.deferMount && !view.options.static);
  if (!view.options.deferMount && !view.options.static) commitRendererTree(previous);
  queueStreamingDetailScroll(previous);
}

function appendImageActionOverlay(parent: HTMLElement, action: ImageAction | null) {
  if (!action || action.kind === "frame") return;

  const overlay = document.createElement("div");
  overlay.className = "tool-image-action-overlay";
  overlay.dataset.action = action.action;
  if (action.direction) overlay.dataset.direction = action.direction;
  overlay.setAttribute("aria-hidden", "true");

  const targetX = action.kind === "drag" ? action.endX : action.x;
  const targetY = action.kind === "drag" ? action.endY : action.y;
  const point = createImageActionPoint(targetX, targetY, action.kind === "drag" ? { x: action.x, y: action.y } : null);
  if (action.action === "scroll" && action.direction) point.append(createImageActionScrollCue(action.direction));
  overlay.append(point);
  parent.append(overlay);
}

function createImageActionPoint(x: number, y: number, from: {x: number; y: number} | null = null) {
  const point = document.createElement("span");
  point.className = `tool-image-action-point${from ? " tool-image-action-point-moving" : ""}`;
  point.style.left = `${x * 100}%`;
  point.style.top = `${y * 100}%`;
  if (from) {
    point.style.setProperty("--tool-image-action-from-x", `${from.x * 100}%`);
    point.style.setProperty("--tool-image-action-from-y", `${from.y * 100}%`);
    point.style.setProperty("--tool-image-action-to-x", `${x * 100}%`);
    point.style.setProperty("--tool-image-action-to-y", `${y * 100}%`);
  }
  point.append(createImageActionCursor());
  return point;
}

function createImageActionCursor() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("tool-image-action-cursor");
  svg.setAttribute("viewBox", "0 0 18 22");
  svg.setAttribute("focusable", "false");

  const cursor = document.createElementNS("http://www.w3.org/2000/svg", "path");
  cursor.setAttribute("d", "M2 1.5v16.4l4.4-4.1 3.1 6.6 3.2-1.5-3.1-6.4 6-.4L2 1.5Z");
  svg.append(cursor);
  return svg;
}

function createImageActionScrollCue(direction: string) {
  const cue = document.createElement("span");
  cue.className = "tool-image-action-scroll-cue";
  cue.dataset.direction = direction;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 20");
  svg.setAttribute("focusable", "false");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M7 2v13m-4-4 4 4 4-4");
  svg.append(arrow);
  cue.append(svg);
  return cue;
}

function normalizeImageActionDisplay(value: unknown, args: Readonly<Record<string, unknown>> = {}): ImageAction | null {
  const display = record(value);
  if (display.type !== "imageWithAction") return null;
  const action = String(display.action || "action").trim() || "action";
  const beforeImage = normalizedDisplayImage(display.beforeImage);
  const afterImage = normalizedDisplayImage(display.afterImage);
  if (display.kind === "frame") {
    return beforeImage || afterImage
      ? {
        action,
        kind: "frame",
        ...(beforeImage ? { beforeImage } : {}),
        ...(afterImage ? { afterImage } : {}),
      }
      : null;
  }
  const x = normalizedDisplayCoordinate(display.x);
  const y = normalizedDisplayCoordinate(display.y);
  if (x == null || y == null) return null;
  const kind = display.kind === "drag" ? "drag" : "point";
  const direction = normalizedScrollDirection(display.direction) || scrollDirectionFromArgs(args);
  if (kind !== "drag") return {
    action,
    kind,
    x,
    y,
    ...(action === "scroll" && direction ? { direction } : {}),
    ...(beforeImage ? { beforeImage } : {}),
    ...(afterImage ? { afterImage } : {}),
  };
  const endX = normalizedDisplayCoordinate(display.endX);
  const endY = normalizedDisplayCoordinate(display.endY);
  return endX == null || endY == null
    ? null
    : {
      action,
      kind,
      x,
      y,
      endX,
      endY,
      ...(beforeImage ? { beforeImage } : {}),
      ...(afterImage ? { afterImage } : {}),
    };
}

function normalizedScrollDirection(value: unknown) {
  const direction = String(value || "").trim().toLowerCase();
  return ["up", "down", "left", "right"].includes(direction) ? direction : "";
}

function scrollDirectionFromArgs(args: Readonly<Record<string, unknown>> = {}) {
  const deltaX = Number(args?.deltaX) || 0;
  const deltaY = Number(args?.deltaY) || 0;
  if (deltaX === 0 && deltaY === 0) return "";
  if (Math.abs(deltaX) > Math.abs(deltaY)) return deltaX < 0 ? "left" : "right";
  return deltaY < 0 ? "up" : "down";
}

function normalizedDisplayCoordinate(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function normalizedDisplayImage(value: unknown) {
  const image = String(value || "");
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(image) ? image : "";
}

function toolDetailsRenderSignature(tool: ToolEvent, argsInfo: ToolArgsInfo) {
  const payload = {
    name: tool?.name || "",
    rendererId: tool?.rendererId || "",
    rendererRevision: toolRendererRegistry.revision,
    capabilityId: tool?.capabilityId || "",
    title: tool?.title || "",
    familyId: tool?.familyId || "",
    profileFamily: tool?.profileFamily || "",
    resultFamily: tool?.resultFamily || "",
    detailLayout: tool?.detailLayout || "",
    mediaPresentation: tool?.mediaPresentation || "",
    args: argsInfo?.value ?? null,
    rawArgsText: argsInfo?.rawText || "",
    argsIncomplete: Boolean(argsInfo?.incomplete || tool?.argsIncomplete),
    phase: tool?.phase || "",
    statusText: tool?.statusText || "",
    rateLimit: tool?.rateLimit ?? null,
    result: tool?.result ?? null,
    isRunning: Boolean(tool?.isRunning),
    isError: Boolean(tool?.isError),
    image: tool?.image ? hashString(tool.image) : "",
  };
  try {
    return hashString(JSON.stringify(payload));
  } catch (_err) {
    return hashString(`${payload.name}:${payload.phase}:${payload.isRunning}:${payload.isError}:${payload.image}`);
  }
}


function formatToolHeaderLabel(toolOrName: ToolEvent | string = "", args: Readonly<Record<string, unknown>> = {}, result: unknown = undefined) {
  if (getToolUiMeta(toolOrName)) return formatToolActionTitle(toolOrName, args);
  const runtimeName = typeof toolOrName === "object" && toolOrName ? toolOrName.name : toolOrName;
  const skillLabel = formatSkillToolHeaderLabel(runtimeName, args, result);
  return skillLabel || getToolDisplayName(toolOrName);
}

function formatSkillToolHeaderLabel(toolName = "", args: Readonly<Record<string, unknown>> = {}, result: unknown = undefined) {
  const { plugin } = skillPresentation.resolveSkillToolRenderContext(toolName, args, result);
  if (plugin && typeof plugin === "object") {
    const pluginName = String(plugin.name || plugin.displayName || t("extension")).trim() || t("extension");
    const title = String(plugin.title || plugin.localName || "").trim();
    return title ? `${pluginName} · ${formatSkillToolLocalTitle(title)}` : pluginName;
  }
  return isSkillToolRuntimeName(toolName) ? t("extensionTool") : "";
}

function formatSkillToolLocalTitle(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[\u4e00-\u9fff]/u.test(text)) return text;
  return text.replace(/[_-]+/g, " ");
}

function toolStatusClass(tool: ToolEvent) {
  const state = resolveToolState(tool);
  return state === "success" ? "" : state;
}

function appendToolEventFooter(details: HTMLElement) {
  const rawDetails = details.querySelector<HTMLElement>(":scope > .tool-raw-details");
  const footer = document.createElement("div");
  footer.className = "tool-event-footer";
  footer.innerHTML = `
    <div class="tool-event-footer-row">
      <button class="qz-btn qz-btn--ghost qz-btn--inline tool-event-raw-btn ${rawDetails ? "" : "hidden"}" type="button" aria-expanded="false">${tHtml("viewRawData")}</button>
      <span class="tool-event-footer-spacer"></span>
      <button class="qz-btn qz-btn--ghost qz-btn--inline tool-event-collapse-btn" type="button">${tHtml("collapse")}</button>
    </div>
    <div class="tool-event-raw-panel hidden"></div>
  `;
  if (rawDetails) {
    const panel = footer.querySelector<HTMLElement>(".tool-event-raw-panel")!;
    rawDetails.querySelector<HTMLElement>("summary")?.remove();
    while (rawDetails.firstChild) panel.appendChild(rawDetails.firstChild);
    rawDetails.remove();
  }
  details.appendChild(footer);
}

function attachToolEventDetailsHandlers(root: HTMLElement, summary: HTMLElement | null, details: ToolDetails) {
  if (!root || !summary || !details) return;
  if (details.__toolEventDetailsHandler) {
    details.removeEventListener("click", details.__toolEventDetailsHandler);
  }
  const handler = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const collapseButton = target.closest<HTMLElement>(".tool-event-collapse-btn");
    if (collapseButton && details.contains(collapseButton)) {
      event.preventDefault();
      event.stopPropagation();
      setToolEventExpanded(root, summary, details, false);
      return;
    }

    const rawButton = target.closest<HTMLElement>(".tool-event-raw-btn");
    if (!rawButton || !details.contains(rawButton)) return;
    event.preventDefault();
    event.stopPropagation();
    const panel = details.querySelector<HTMLElement>(":scope .tool-event-raw-panel");
    if (!panel) return;
    if (panel.classList.contains("hidden")) genericRenderer.ensureRawPanel(panel);
    const expanded = !panel.classList.toggle("hidden");
    rawButton.setAttribute("aria-expanded", expanded ? "true" : "false");
  };
  details.__toolEventDetailsHandler = handler;
  details.addEventListener("click", handler);
}

function setToolEventExpanded(root: HTMLElement, summary: HTMLElement | null, details: HTMLElement, expanded: boolean) {
  if (!summary || !details) return;
  if (expanded) ensureToolDetailsRendered(root, details, toolEventStateByRoot.get(root));
  details.dataset.userToggled = "true";
  details.classList.toggle("hidden", !expanded);
  root?.classList?.toggle("tool-expanded", Boolean(expanded));
  if (root) root.dataset.chatLane = toolEventLaneMode(toolEventStateByRoot.get(root)?.tool, expanded);
  syncToolSummaryExpanded(summary, expanded, Boolean(summary.querySelector<HTMLElement>(".tool-caret")));
  notifyToolPresentationChange(root, expanded);
}

function notifyToolPresentationChange(root: HTMLElement, expanded: boolean) {
  const view = toolEventStateByRoot.get(root);
  const callback = view?.options?.onPresentationChange;
  if (!view || typeof callback !== "function") return;
  callback({
    userToggled: true,
    expanded: Boolean(expanded),
    activeToolKey: view.options.presentationState?.activeToolKey
      || view.tool?._uiKey
      || view.tool?.toolCallId
      || "",
  });
}

function toolDetailClassSuffix(name: string) {
  return String(name || "tool").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "tool";
}

export function patchToolEvent(existing: HTMLElement | null, tool: ToolEvent, options: ToolRenderOptions = {}) {
  if (!existing) return false;

  const view = createToolEventView(tool, options);
  rememberToolEventView(existing, view);
  const currentSummary = existing.querySelector<HTMLElement>(":scope > .tool-summary");
  const currentDetails = existing.querySelector<HTMLElement>(":scope > .tool-details");
  if (!currentSummary) return false;

  const controlledState = options.presentationState || {};
  const wasExpanded = Boolean(controlledState.userToggled && controlledState.expanded);
  const wasUserToggled = controlledState.userToggled === true;
  const shouldExpand = wasUserToggled && wasExpanded;
  const rawPanelWasOpen = isToolEventRawPanelOpen(currentDetails);
  const shouldSettle = Boolean(currentSummary.querySelector<HTMLElement>(".dot.running"))
    && view.statusClass === "";

  if (hasActiveSelectionInsideNode(existing)) return true;
  patchToolSummary(currentSummary, view, shouldExpand);

  let details = currentDetails;
  if (!view.hasDetails) {
    if (details) disposeRendererTree(details);
    details?.remove();
    existing.classList.remove("tool-expanded");
  } else {
    if (!details) {
      details = createToolDetailsShell(view, { hidden: !shouldExpand });
      existing.appendChild(details);
    }
    if (wasUserToggled) details.dataset.userToggled = "true";
    else delete details.dataset.userToggled;
    details.className = toolDetailsClassName(view, { hidden: !shouldExpand });
    details.classList.toggle("hidden", !shouldExpand);
    existing.classList.toggle("tool-expanded", shouldExpand);
    if (shouldExpand) {
      renderToolDetailsInto(details, view, { preserveHidden: false });
      details.dataset.toolDetailsSignature = view.detailsSignature;
      details.dataset.toolDetailsLazy = "false";
      attachToolEventDetailsHandlers(existing, currentSummary, details);
      restoreToolEventRawPanelOpen(details, rawPanelWasOpen);
      queueStreamingDetailScroll(details);
    } else if (details.dataset.toolDetailsSignature !== view.detailsSignature) {
      details.dataset.toolDetailsLazy = "true";
    }
  }
  existing.dataset.chatLane = toolEventLaneMode(tool, shouldExpand);
  if (shouldSettle) triggerToolSummarySettle(currentSummary);
  if (details && !details.classList.contains("hidden")) queueStreamingDetailScroll(details);
  return true;
}

function patchToolSummary(currentSummary: HTMLElement, view: ToolEventView, expanded: boolean) {
  const currentDot = currentSummary.querySelector<HTMLElement>(".dot");
  if (currentDot) {
    currentDot.className = `dot ${view.statusClass}`.trim();
    currentDot.title = view.statusTitle;
  }

  patchTextValue(currentSummary.querySelector<HTMLElement>(".tool-name"), view.label);
  patchTextValue(currentSummary.querySelector<HTMLElement>(".tool-args-preview"), view.argsPreview);

  syncToolSummaryExpanded(currentSummary, expanded, view.hasDetails);
}

function syncToolSummaryExpanded(summary: HTMLElement | null, expanded: boolean, hasDetails: boolean) {
  if (!summary) return;
  let caret = summary.querySelector<HTMLElement>(".tool-caret");
  if (hasDetails && !caret) {
    caret = document.createElement("span");
    caret.className = "tool-caret";
    summary.appendChild(caret);
  } else if (!hasDetails && caret) {
    caret.remove();
    caret = null;
  }
  if (caret) caret.textContent = expanded ? "▾" : "▸";
  summary.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function patchTextValue(current: HTMLElement | null, nextText: unknown) {
  if (!current) return;
  const text = String(nextText || "");
  if (current.textContent !== text) current.textContent = text;
}

function isToolEventRawPanelOpen(details: HTMLElement | null) {
  return Boolean(details?.querySelector?.<HTMLElement>(":scope .tool-event-raw-panel:not(.hidden)"));
}

function restoreToolEventRawPanelOpen(details: HTMLElement | null, open: boolean) {
  if (!open) return;
  const rawButton = details?.querySelector?.<HTMLElement>(":scope .tool-event-raw-btn:not(.hidden)");
  const rawPanel = details?.querySelector?.<HTMLElement>(":scope .tool-event-raw-panel");
  if (!rawButton || !rawPanel) return;
  genericRenderer.ensureRawPanel(rawPanel);
  rawPanel.classList.remove("hidden");
  rawButton.setAttribute("aria-expanded", "true");
}

function triggerToolSummarySettle(summary: HTMLElement) {
  if (!summary) return;
  summary.classList.remove("tool-summary-settled");
  void summary.offsetWidth;
  summary.classList.add("tool-summary-settled");
  clearTimeout(toolSummarySettleTimers.get(summary));
  toolSummarySettleTimers.set(summary, setTimeout(() => {
    summary.classList.remove("tool-summary-settled");
    toolSummarySettleTimers.delete(summary);
  }, 900));
}

function morphElementChildren(current: HTMLElement, next: HTMLElement, commit = true) {
  preserveToolDetailScrollState(current, () => morphRendererChildren(current, next, commit));
}

export function preserveToolDetailScrollState<T>(root: HTMLElement, update: () => T): T {
  const scrollState = captureScrollState(root);
  const result = update();
  restoreScrollState(root, scrollState);
  return result;
}

function captureScrollState(root: HTMLElement) {
  return collectScrollTargets(root)
    .map((el, index) => ({
      index,
      selector: scrollStateSelector(el),
      top: el.scrollTop,
      left: el.scrollLeft,
      followTail: shouldFollowTail(el),
    }));
}

function restoreScrollState(root: HTMLElement, state: ReturnType<typeof captureScrollState>) {
  for (const item of state) {
    const el = item.selector
      ? (item.selector === ":scope" ? root : root.querySelector<HTMLElement>(item.selector))
      : collectScrollTargets(root)[item.index];
    if (!el) continue;
    installTailTracker(el);
    setFollowTail(el, item.followTail);
    el.scrollLeft = item.left;
    if (item.followTail) scrollToTail(el);
    else el.scrollTop = Math.min(item.top, Math.max(0, el.scrollHeight - el.clientHeight));
  }
}

function collectScrollTargets(root: HTMLElement) {
  const targets: HTMLElement[] = [];
  if (root?.classList?.contains("tool-details-streaming") && getStreamingScrollTarget(root) === root) targets.push(root);
  for (const el of root?.querySelectorAll?.<HTMLElement>("[data-tool-scroll-surface], pre") || []) {
    if (!targets.includes(el)) targets.push(el);
  }
  return targets;
}

function scrollStateSelector(el: HTMLElement) {
  if (el.classList.contains("tool-details-streaming")) return ":scope";
  if (el.dataset.toolScrollSurface) {
    return `[data-tool-scroll-surface="${CSS.escape(el.dataset.toolScrollSurface)}"]`;
  }
  return "";
}

export function queueStreamingDetailScroll(details: HTMLElement | null) {
  if (!details?.classList?.contains("tool-details-streaming")) return;
  requestAnimationFrame(() => {
    const target = getStreamingScrollTarget(details);
    if (!target) return;
    installTailTracker(target);
    if (!shouldFollowTail(target)) return;
    scrollToTail(target);
  });
}

function getStreamingScrollTarget(details: HTMLElement) {
  let target = details;
  let priority = -Infinity;
  for (const element of details.querySelectorAll<HTMLElement>("[data-tool-stream-surface]")) {
    const value = Number(element.dataset.toolStreamSurface) || 0;
    if (value >= priority) { priority = value; target = element; }
  }
  return target;
}

export function normalizeToolResult(result: unknown, hasImage = true) {
  if (result == null) return "";
  const safeResult = stripToolDisplayFields(result, { stripImage: hasImage });
  return presentation.cloneDisplayValue(safeResult);
}

function stripToolDisplayFields(result: unknown, { stripImage = true } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return Object.fromEntries(Object.entries(result).filter(([key]) => (
    key !== "_display" && (!stripImage || key !== "_image")
  )));
}

export function createValueView(value: unknown, options: {localizeToolFailure?: boolean} = {}) {
  const parsed = presentation.parseJsonish(value);
  if (!parsed.ok) {
    const rawText = String(value ?? "");
    const text = options.localizeToolFailure ? localizeToolFailureText(rawText) : rawText;
    return {
      kind: "text",
      html: escapeHtml(text),
      warning: presentation.isLikelyIncompleteJsonText(rawText) ? "stored result is incomplete" : "",
    };
  }
  const displayValue = options.localizeToolFailure ? presentation.localizeToolDisplayValue(parsed.value) : parsed.value;
  const pretty = JSON.stringify(displayValue, null, 2);
  return {
    kind: "json",
    html: highlightCode(pretty, "json", { autoDetect: false }).html,
  };
}

function normalizeToolArgsForRender(tool: ToolEvent): ToolArgsInfo {
  return toolArgsPreview.normalize(tool);
}

function formatToolArgs(args: Readonly<Record<string, unknown>>, rawText = "", toolOrName: ToolEvent | string = "", result: unknown = undefined) {
  return toolArgsPreview.format(args, rawText, toolOrName, result);
}

export function readArticleDisplayTarget(...args: Parameters<ReturnType<typeof createToolArgsPreview>["readArticleDisplayTarget"]>) {
  return toolArgsPreview.readArticleDisplayTarget(...args);
}

export function pageDisplayTarget(...args: Parameters<ReturnType<typeof createToolArgsPreview>["pageDisplayTarget"]>) {
  return toolArgsPreview.pageDisplayTarget(...args);
}


const toolArgsPreview = createToolArgsPreview({ normalizeToolResult });
const renderMarkdown = (value: string) => renderMarkdownHtml(value, { math: false });
const genericRenderer = createGenericResultRenderer({
  createValueView, normalizeToolResult, pageDisplayTarget, formatToolHeaderLabel, renderMarkdown,
});
const toolRuntimeDetails = createToolRuntimeDetails({
  genericRenderer,
  renderPrelude(parent, view) {
    try { return toolRendererRegistry.resolve(view.rendererId).renderPrelude?.(parent, view); }
    catch { return false; }
  },
  renderErrorResult(parent, view) {
    try { return toolRendererRegistry.resolve(view.rendererId).renderErrorResult?.(parent, view) === true; }
    catch { return false; }
  },
  renderRunningInputs(parent, view) {
    try { return toolRendererRegistry.resolve(view.rendererId).renderRunningInputs?.(parent, view); }
    catch { return false; }
  },
  renderErrorInputs(parent, view) {
    const renderer = toolRendererRegistry.resolve(view.rendererId);
    if (renderer.renderErrorInputs) return renderer.renderErrorInputs(parent, view);
    if (!view.profileFamily && skillPresentation.resolveSkillToolRenderContext(view.name, view.args, view.result).plugin) {
      return toolRendererRegistry.resolve("plugin").renderErrorInputs?.(parent, view);
    }
  },
});

// Historical generic results stay compact; an unavailable renderer keeps the shape-only fallback.
const genericDefinition = projectedRenderer("generic", (parent, view) => toolRuntimeDetails.append(parent, view, undefined, { compact: view.rendererId === "generic" }));
export const toolRendererRegistry = new RendererRegistry(genericDefinition);
const rendererHost: RendererExtensionAPI = {
  registerRenderer: renderer => { toolRendererRegistry.register(renderer); },
  registerPresentation: definition => { toolPresentationRegistry.register(definition); },
  generic: genericRenderer, pageDisplayTarget, formatSkillToolHeaderLabel, renderMarkdown,
  render: (parent, view) => toolRendererRegistry.render(parent, view),
  project(id, projection, options = {}) {
    return { ...projectedRenderer(id, (parent, view) => toolRuntimeDetails.append(parent, view, projection)), ...options };
  },
};
for (const setup of rendererCapabilities) setup(rendererHost);
export { commitRendererTree, disposeRendererTree };

export function ensureToolRawPanelRendered(panel: HTMLElement) {
  return genericRenderer.ensureRawPanel(panel);
}

export function formatJavaScriptCode(code: string) {
  return presentation.formatJavaScriptCode(code);
}
