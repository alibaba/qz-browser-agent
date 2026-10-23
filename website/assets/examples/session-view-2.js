export function mountSessionView(root) {
  // sidepanel/tools/timeline-navigation.ts
  function resolveFamilyTimelineTarget(familyIds, index, direction, mode = "family") {
    if (!familyIds.length) return index;
    const current = Math.max(0, Math.min(familyIds.length - 1, Number(index) || 0));
    const step = Math.sign(Number(direction) || 0);
    if (!step) return current;
    if (mode !== "family") return Math.max(0, Math.min(familyIds.length - 1, current + step));
    const groups = /* @__PURE__ */ new Map();
    familyIds.forEach((family, item) => {
      if (!groups.has(family)) groups.set(family, []);
      groups.get(family).push(item);
    });
    const order = [...groups.values()].flat();
    const position = order.indexOf(current);
    return position < 0 ? current : order[position + step] ?? current;
  }

  // shared/session/session-import-copy.ts
  var sessionImportLabelKeys = ["importQingzhou", "importing", "imported", "retryImport", "importFailedRetry"];
  function readSessionImportLabels(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value;
    const labels = {};
    for (const key of sessionImportLabelKeys) {
      const text = record[key];
      if (typeof text !== "string" || text.length === 0 || text.length > 200) return null;
      labels[key] = text;
    }
    return labels;
  }
  function sessionImportButtonText(state, labels) {
    if (state.busy) return labels.importing;
    if (state.imported) return labels.imported;
    if (state.titled) return labels.retryImport;
    return labels.importQingzhou;
  }

  // sidepanel/features/export/session-export-runtime.ts
  (() => {
    const messages = JSON.parse(root.getElementById("qingzhou-export-messages")?.textContent || "{}");
    const t = (key) => typeof messages[key] === "string" ? messages[key] : key;
    let imageLightbox = null;
    function closeImageLightbox() {
      if (!imageLightbox) return;
      imageLightbox.remove();
      imageLightbox = null;
    }
    function openImageLightbox(source, alt) {
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
      close.textContent = "\xD7";
      overlay.appendChild(image);
      overlay.appendChild(close);
      root.appendChild(overlay);
      imageLightbox = overlay;
    }
    function toggle(root, details, summary, expandedClass) {
      if (!root || !details || !summary) return;
      let expanded = details.classList.contains("hidden");
      details.classList.toggle("hidden", !expanded);
      root.classList.toggle(expandedClass, expanded);
      syncStaticChatLane(root, expanded);
      summary.setAttribute("aria-expanded", expanded ? "true" : "false");
      let caret = summary.querySelector(".tool-caret, .thinking-caret");
      if (caret) caret.textContent = expanded ? "\u25BE" : "\u25B8";
    }
    function syncStaticChatLane(root, expanded) {
      if (!root || !root.dataset) return;
      root.dataset.chatLane = expanded ? root.dataset.staticExpandedLane || "detail" : root.dataset.staticCollapsedLane || "summary";
    }
    function setTemplate(root, kind, index) {
      let details = root.querySelector(kind === "tool" ? ":scope > .tool-timeline-details" : ":scope > .thinking-group-details");
      let slot = details && details.querySelector(kind === "tool" ? ".tool-timeline-slot" : ".thinking-group-slot");
      let template = root.querySelector("template[data-static-" + kind + "-index='" + index + "']");
      if (!details || !slot || !template) return;
      slot.innerHTML = template.innerHTML;
      if (kind === "tool") {
        let navHost = root.querySelector(".tool-family-submenu > .tool-family-panel-nav");
        if (navHost) navHost.innerHTML = template.dataset.staticToolFamilyNavHtml || "";
        const familyId = template.dataset.staticToolFamilyId || "";
        const panel = Array.from(root.querySelectorAll(".tool-family-panel")).find((item) => item.dataset.toolFamilyId === familyId);
        if (panel && template.dataset.staticToolFamilyPanelHtml !== void 0) {
          panel.innerHTML = template.dataset.staticToolFamilyPanelHtml;
        }
        const summary = root.querySelector(":scope > .tool-timeline-summary");
        const title = summary?.querySelector(".tool-name");
        const preview = summary?.querySelector(".tool-args-preview");
        if (title && template.dataset.staticToolTitle !== void 0) title.textContent = template.dataset.staticToolTitle;
        if (preview && template.dataset.staticToolPreview !== void 0) preview.textContent = template.dataset.staticToolPreview;
        syncStaticToolTimelineActiveState(root, index, template.dataset.staticToolFamilyId || "");
      }
      details.dataset[kind === "tool" ? "activeToolIndex" : "activeThinkingIndex"] = String(index);
    }
    function syncStaticToolTimelineActiveState(root, index, familyId) {
      root.querySelectorAll(".tool-timeline-step").forEach(function(item) {
        item.classList.toggle("active", Number(item.dataset.toolTimelineIndex) === index);
      });
      root.querySelectorAll(".tool-family-panel").forEach(function(panel) {
        panel.classList.toggle("active", panel.dataset.toolFamilyId === familyId);
      });
      root.querySelectorAll(".tool-family-row, .tool-family-batch").forEach(function(item) {
        let exactActive = Number(item.dataset.toolTimelineIndex) === index;
        let familyActive = item.classList.contains("tool-family-row") && item.dataset.toolFamilyId === familyId;
        let batchActive = item.classList.contains("tool-family-batch") && staticTimelineIndexListIncludes(item.dataset.toolTimelineIndexes || item.dataset.toolTimelineIndex, index);
        item.classList.toggle("active", exactActive || familyActive || batchActive);
        if (item.classList.contains("tool-family-row")) {
          item.setAttribute("aria-current", familyActive ? "true" : "false");
        }
      });
    }
    function staticTimelineIndexListIncludes(value, index) {
      let target = Number(index);
      if (!Number.isFinite(target)) return false;
      return String(value || "").split(",").map(function(item) {
        return Number(item.trim());
      }).filter(Number.isFinite).indexOf(target) >= 0;
    }
    function staticToolTemplates(root) {
      return Array.from(root.querySelectorAll("template[data-static-tool-index]")).sort(function(a, b) {
        return Number(a.dataset.staticToolIndex || 0) - Number(b.dataset.staticToolIndex || 0);
      });
    }
    function resolveStaticToolNavTarget(root, current, direction, mode) {
      return resolveFamilyTimelineTarget(staticToolTemplates(root).map((template) => template.dataset.staticToolFamilyId || ""), current, direction, mode);
    }
    root.addEventListener("click", function(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      let lightbox = target.closest(".image-lightbox");
      if (lightbox && (event.target === lightbox || target.closest(".image-lightbox-close"))) {
        closeImageLightbox();
        return;
      }
      let previewImage = target.closest("#messages img");
      if (previewImage) {
        event.preventDefault();
        openImageLightbox(previewImage.dataset.fullSrc || previewImage.currentSrc || previewImage.src, previewImage.alt || t("images"));
        return;
      }
      let codeCopy = target.closest(".code-copy-btn");
      if (codeCopy) {
        let block = codeCopy.closest(".copyable-code-block");
        let text = block && (block.dataset.copyText || block.querySelector("pre")?.innerText || "");
        if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(function() {
        });
        return;
      }
      let directSummary = target.closest(".msg-tool:not(.msg-tool-timeline) > .tool-summary");
      if (directSummary) {
        let directRoot = directSummary.parentElement;
        toggle(directRoot, directRoot?.querySelector(":scope > .tool-details") || null, directSummary, "tool-expanded");
        return;
      }
      let toolRoot = target.closest(".msg-tool-timeline");
      if (toolRoot) {
        let toolSummary = target.closest(".tool-timeline-summary");
        if (toolSummary && toolSummary.parentElement === toolRoot) {
          toggle(toolRoot, toolRoot.querySelector(":scope > .tool-timeline-details"), toolSummary, "tool-timeline-expanded");
          return;
        }
        let toolDetails = toolRoot.querySelector(":scope > .tool-timeline-details");
        let currentTool = Number(toolDetails?.dataset.activeToolIndex || 0);
        let directTool = target.closest("[data-tool-timeline-index]");
        let navTool = target.closest("[data-timeline-nav-direction]");
        let totalTools = toolRoot.querySelectorAll("template[data-static-tool-index]").length;
        let navMode = navTool?.closest(".tool-timeline-slot-nav")?.dataset.timelineMode || toolDetails?.dataset.timelineMode || "family";
        let nextTool = directTool ? Number(directTool.dataset.toolTimelineIndex) : resolveStaticToolNavTarget(toolRoot, currentTool, Number(navTool?.dataset.timelineNavDirection || 0), navMode);
        if (totalTools) setTemplate(toolRoot, "tool", Math.max(0, Math.min(totalTools - 1, nextTool)));
        return;
      }
      let thinkingRoot = target.closest(".msg-thinking-group");
      if (thinkingRoot) {
        let thinkingSummary = target.closest(".thinking-group-summary");
        if (thinkingSummary && thinkingSummary.parentElement === thinkingRoot) {
          toggle(thinkingRoot, thinkingRoot.querySelector(":scope > .thinking-group-details"), thinkingSummary, "thinking-group-expanded");
          return;
        }
        let thinkingDetails = thinkingRoot.querySelector(":scope > .thinking-group-details");
        let currentThinking = Number(thinkingDetails?.dataset.activeThinkingIndex || 0);
        let navThinking = target.closest("[data-thinking-nav-direction]");
        let totalThinking = thinkingRoot.querySelectorAll("template[data-static-thinking-index]").length;
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
    let cta = document.getElementById("qingzhou-session-cta");
    if (!cta) return;
    function useImportLabels(value) {
      const labels = readSessionImportLabels(value);
      if (!labels) return;
      Object.assign(messages, labels);
    }
    function refreshImportButton() {
      if (!(cta instanceof HTMLButtonElement) || !cta.hasAttribute("data-qingzhou-session-import")) return;
      cta.textContent = sessionImportButtonText({
        busy: cta.getAttribute("aria-busy") === "true",
        imported: Boolean(cta.getAttribute("data-qingzhou-imported-session-id")),
        titled: Boolean(cta.title)
      }, {
        importQingzhou: t("importQingzhou"),
        importing: t("importing"),
        imported: t("imported"),
        retryImport: t("retryImport"),
        importFailedRetry: t("importFailedRetry")
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
    function updateImportState(data) {
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
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const message = data;
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
}
