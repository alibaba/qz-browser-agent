import { resolveFamilyTimelineTarget } from "../../tools/timeline-navigation.js";
import { readSessionImportLabels, sessionImportButtonText } from "../../../shared/session/session-import-copy.js";
/** Standalone exported HTML entry, compiled and embedded by build-extension. No extension APIs. */
(() => {
  // Captured document labels stay with the export. Import-button labels from the extension bridge replace them.
  const messages: Record<string, unknown> = JSON.parse(document.getElementById("qingzhou-export-messages")?.textContent || "{}");
  const t = (key: string): string => typeof messages[key] === "string" ? messages[key] : key;
  let imageLightbox: HTMLElement | null = null;

  function closeImageLightbox() {
    if (!imageLightbox) return;
    imageLightbox.remove();
    imageLightbox = null;
  }

  function openImageLightbox(source: string, alt: string) {
    if (!source) return;
    closeImageLightbox();
    let overlay = document.createElement("div");
    overlay.className = "image-lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || t("imagePreview"));
    let image = document.createElement("img");
    image.src = source;
    image.alt = alt || t("images");
    let close = document.createElement("button");
    close.className = "qz-icon-btn qz-icon-btn--md image-lightbox-close";
    close.type = "button";
    close.title = t("close");
    close.setAttribute("aria-label", t("close"));
    close.textContent = "×";
    overlay.appendChild(image);
    overlay.appendChild(close);
    document.body.appendChild(overlay);
    imageLightbox = overlay;
  }

  function toggle(root: HTMLElement | null, details: HTMLElement | null, summary: HTMLElement | null, expandedClass: string) {
    if (!root || !details || !summary) return;
    let expanded = details.classList.contains("hidden");
    details.classList.toggle("hidden", !expanded);
    root.classList.toggle(expandedClass, expanded);
    syncStaticChatLane(root, expanded);
    summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    let caret = summary.querySelector<HTMLElement>(".tool-caret, .thinking-caret");
    if (caret) caret.textContent = expanded ? "▾" : "▸";
  }

  function syncStaticChatLane(root: HTMLElement, expanded: boolean) {
    if (!root || !root.dataset) return;
    root.dataset.chatLane = expanded
      ? (root.dataset.staticExpandedLane || "detail")
      : (root.dataset.staticCollapsedLane || "summary");
  }

  function setTemplate(root: HTMLElement, kind: "tool" | "thinking", index: number) {
    let details = root.querySelector<HTMLElement>(kind === "tool" ? ":scope > .tool-timeline-details" : ":scope > .thinking-group-details");
    let slot = details && details.querySelector<HTMLElement>(kind === "tool" ? ".tool-timeline-slot" : ".thinking-group-slot");
    let template = root.querySelector<HTMLElement>("template[data-static-" + kind + "-index='" + index + "']");
    if (!details || !slot || !template) return;
    slot.innerHTML = template.innerHTML;
    if (kind === "tool") {
      let navHost = root.querySelector<HTMLElement>(".tool-family-submenu > .tool-family-panel-nav");
      if (navHost) navHost.innerHTML = template.dataset.staticToolFamilyNavHtml || "";
      const familyId = template.dataset.staticToolFamilyId || "";
      const panel = Array.from(root.querySelectorAll<HTMLElement>(".tool-family-panel"))
        .find(item => item.dataset.toolFamilyId === familyId);
      if (panel && template.dataset.staticToolFamilyPanelHtml !== undefined) {
        panel.innerHTML = template.dataset.staticToolFamilyPanelHtml;
      }
      const summary = root.querySelector<HTMLElement>(":scope > .tool-timeline-summary");
      const title = summary?.querySelector<HTMLElement>(".tool-name");
      const preview = summary?.querySelector<HTMLElement>(".tool-args-preview");
      if (title && template.dataset.staticToolTitle !== undefined) title.textContent = template.dataset.staticToolTitle;
      if (preview && template.dataset.staticToolPreview !== undefined) preview.textContent = template.dataset.staticToolPreview;
      syncStaticToolTimelineActiveState(root, index, template.dataset.staticToolFamilyId || "");
    }
    details.dataset[kind === "tool" ? "activeToolIndex" : "activeThinkingIndex"] = String(index);
  }

  function syncStaticToolTimelineActiveState(root: HTMLElement, index: number, familyId: string) {
    root.querySelectorAll<HTMLElement>(".tool-timeline-step").forEach(function(item) {
      item.classList.toggle("active", Number(item.dataset.toolTimelineIndex) === index);
    });
    root.querySelectorAll<HTMLElement>(".tool-family-panel").forEach(function(panel) {
      panel.classList.toggle("active", panel.dataset.toolFamilyId === familyId);
    });
    root.querySelectorAll<HTMLElement>(".tool-family-row, .tool-family-batch").forEach(function(item) {
      let exactActive = Number(item.dataset.toolTimelineIndex) === index;
      let familyActive = item.classList.contains("tool-family-row") && item.dataset.toolFamilyId === familyId;
      let batchActive = item.classList.contains("tool-family-batch")
        && staticTimelineIndexListIncludes(item.dataset.toolTimelineIndexes || item.dataset.toolTimelineIndex, index);
      item.classList.toggle("active", exactActive || familyActive || batchActive);
      if (item.classList.contains("tool-family-row")) {
        item.setAttribute("aria-current", familyActive ? "true" : "false");
      }
    });
  }

  function staticTimelineIndexListIncludes(value: string | undefined, index: number) {
    let target = Number(index);
    if (!Number.isFinite(target)) return false;
    return String(value || "")
      .split(",")
      .map(function(item) { return Number(item.trim()); })
      .filter(Number.isFinite)
      .indexOf(target) >= 0;
  }

  function staticToolTemplates(root: HTMLElement) {
    return Array.from(root.querySelectorAll<HTMLTemplateElement>("template[data-static-tool-index]"))
      .sort(function(a, b) { return Number(a.dataset.staticToolIndex || 0) - Number(b.dataset.staticToolIndex || 0); });
  }

  function resolveStaticToolNavTarget(root: HTMLElement, current: number, direction: number, mode: string) {
    return resolveFamilyTimelineTarget(staticToolTemplates(root).map(template => template.dataset.staticToolFamilyId || ""), current, direction, mode);
  }

  document.addEventListener("click", function(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    let lightbox = target.closest<HTMLElement>(".image-lightbox");
    if (lightbox && (event.target === lightbox || target.closest<HTMLElement>(".image-lightbox-close"))) {
      closeImageLightbox();
      return;
    }

    let previewImage = target.closest<HTMLImageElement>("#messages img");
    if (previewImage) {
      event.preventDefault();
      openImageLightbox(previewImage.dataset.fullSrc || previewImage.currentSrc || previewImage.src, previewImage.alt || t("images"));
      return;
    }

    let codeCopy = target.closest<HTMLElement>(".code-copy-btn");
    if (codeCopy) {
      let block = codeCopy.closest<HTMLElement>(".copyable-code-block");
      let text = block && (block.dataset.copyText || block.querySelector<HTMLElement>("pre")?.innerText || "");
      if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(function() {});
      return;
    }

    let directSummary = target.closest<HTMLElement>(".msg-tool:not(.msg-tool-timeline) > .tool-summary");
    if (directSummary) {
      let directRoot = directSummary.parentElement;
      toggle(directRoot, directRoot?.querySelector<HTMLElement>(":scope > .tool-details") || null, directSummary, "tool-expanded");
      return;
    }

    let toolRoot = target.closest<HTMLElement>(".msg-tool-timeline");
    if (toolRoot) {
      let toolSummary = target.closest<HTMLElement>(".tool-timeline-summary");
      if (toolSummary && toolSummary.parentElement === toolRoot) {
        toggle(toolRoot, toolRoot.querySelector<HTMLElement>(":scope > .tool-timeline-details"), toolSummary, "tool-timeline-expanded");
        return;
      }
      let toolDetails = toolRoot.querySelector<HTMLElement>(":scope > .tool-timeline-details");
      let currentTool = Number(toolDetails?.dataset.activeToolIndex || 0);
      let directTool = target.closest<HTMLElement>("[data-tool-timeline-index]");
      let navTool = target.closest<HTMLElement>("[data-timeline-nav-direction]");
      let totalTools = toolRoot.querySelectorAll<HTMLElement>("template[data-static-tool-index]").length;
      let navMode = navTool?.closest<HTMLElement>(".tool-timeline-slot-nav")?.dataset.timelineMode || toolDetails?.dataset.timelineMode || "family";
      let nextTool = directTool
        ? Number(directTool.dataset.toolTimelineIndex)
        : resolveStaticToolNavTarget(toolRoot, currentTool, Number(navTool?.dataset.timelineNavDirection || 0), navMode);
      if (totalTools) setTemplate(toolRoot, "tool", Math.max(0, Math.min(totalTools - 1, nextTool)));
      return;
    }

    let thinkingRoot = target.closest<HTMLElement>(".msg-thinking-group");
    if (thinkingRoot) {
      let thinkingSummary = target.closest<HTMLElement>(".thinking-group-summary");
      if (thinkingSummary && thinkingSummary.parentElement === thinkingRoot) {
        toggle(thinkingRoot, thinkingRoot.querySelector<HTMLElement>(":scope > .thinking-group-details"), thinkingSummary, "thinking-group-expanded");
        return;
      }
      let thinkingDetails = thinkingRoot.querySelector<HTMLElement>(":scope > .thinking-group-details");
      let currentThinking = Number(thinkingDetails?.dataset.activeThinkingIndex || 0);
      let navThinking = target.closest<HTMLElement>("[data-thinking-nav-direction]");
      let totalThinking = thinkingRoot.querySelectorAll<HTMLElement>("template[data-static-thinking-index]").length;
      if (navThinking && totalThinking) {
        let nextThinking = currentThinking + Number(navThinking.dataset.thinkingNavDirection || 0);
        setTemplate(thinkingRoot, "thinking", Math.max(0, Math.min(totalThinking - 1, nextThinking)));
      }
    }
  });

  document.addEventListener("keydown", function(event) {
    if (event.key === "Escape") closeImageLightbox();
  });

  let PROBE_TYPE = "qingzhou:session-export:probe";
  let RESULT_TYPE = "qingzhou:session-export:result";
  let cta: HTMLElement | null = document.getElementById("qingzhou-session-cta");
  if (!cta) return;

  function useImportLabels(value: unknown) {
    const labels = readSessionImportLabels(value);
    if (!labels) return;
    Object.assign(messages, labels);
  }

  function refreshImportButton() {
    if (!(cta instanceof HTMLButtonElement) || !cta.hasAttribute("data-qingzhou-session-import")) return;
    cta.textContent = sessionImportButtonText({
      busy: cta.getAttribute("aria-busy") === "true",
      imported: Boolean(cta.getAttribute("data-qingzhou-imported-session-id")),
      titled: Boolean(cta.title),
    }, {
      importQingzhou: t("importQingzhou"),
      importing: t("importing"),
      imported: t("imported"),
      retryImport: t("retryImport"),
      importFailedRetry: t("importFailedRetry"),
    });
  }

  function enableImport() {
    if (!cta || cta.hasAttribute("data-qingzhou-session-import")) return;
    let button = document.createElement("button");
    button.id = cta.id;
    button.className = cta.className;
    button.type = "button";
    button.setAttribute("data-qingzhou-session-import", "");
    button.textContent = t("importQingzhou");
    cta.replaceWith(button);
    cta = button;
  }

  function updateImportState(data: Record<string, unknown>) {
    if (!(cta instanceof HTMLButtonElement) || !cta.hasAttribute("data-qingzhou-session-import")) return;
    if (data.status === "working") {
      cta.disabled = true;
      cta.setAttribute("aria-busy", "true");
      cta.textContent = t("importing");
      return;
    }
    cta.removeAttribute("aria-busy");
    if (data.ok) {
      cta.disabled = true;
      cta.textContent = t("imported");
      cta.dataset.qingzhouImportedSessionId = String(data.sessionId || "");
      return;
    }
    cta.disabled = false;
    cta.textContent = t("retryImport");
    cta.title = String(data.error || t("importFailedRetry"));
  }

  window.addEventListener("message", function(event) {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (message.type !== RESULT_TYPE) return;
    if (message.action === "probe" && message.installed) {
      useImportLabels(message.labels);
      enableImport();
      refreshImportButton();
    }
    if (message.action === "import") updateImportState(message);
  });

  window.postMessage({
    type: PROBE_TYPE,
    requestId: "qz-export-" + Date.now().toString(36)
  }, "*");
})();
