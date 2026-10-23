// Detail-page media, the export transcript, and the document title.

// Each detail page names the export runtime that matches its transcript ("" or "-2", ...).
const { mountSessionView } = await import(`./examples/session-view${document.documentElement.dataset.sessionView || ""}.js`);
const catalog = window.QZ_EXAMPLES;
const siteRoot = document.documentElement.dataset.siteRoot || "../../";

function siteUrl(relativeToSite) {
  return new URL(relativeToSite, new URL(siteRoot, document.baseURI)).href;
}

function syncTitle() {
  const heading = document.querySelector(".example-page h1");
  const text = heading?.textContent?.replace(/\s+/g, " ").trim();
  if (text) document.title = `${text} — qz`;
}

function bindMedia() {
  const video = document.querySelector(".example-video");
  if (!(video instanceof HTMLVideoElement)) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;
  const src = video.dataset.src;
  if (!src) return;
  const frame = video.closest(".example-frame") || video;
  let started = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        if (started) video.pause();
        continue;
      }
      if (!video.getAttribute("src")) {
        video.src = src;
        video.load();
      }
      started = true;
      video.play().catch(() => { /* The poster stays visible if autoplay is blocked. */ });
    }
  });
  video.addEventListener("playing", () => video.classList.add("is-playing"));
  observer.observe(frame);
}

function adoptSessionOverrides(root) {
  if (root.querySelector('link[href*="session-view-overrides.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = siteUrl("assets/examples/session-view-overrides.css");
  const current = [...root.querySelectorAll("link")].find((node) => node.getAttribute("href")?.includes("session-view.css"));
  if (current) current.after(link);
  else root.prepend(link);
}

function cellText(cell) {
  return (cell.textContent || "").replace(/\s+/g, " ").trim();
}

function keepCellOnOneLine(text) {
  if (!text || (text.length <= 14 && !/\s/.test(text))) return true;
  if (text.length > 24) return false;
  const time = /^(?:\d{1,2}:\d{2})(?:\s*[-–—~～至到]\s*\d{1,2}:\d{2})?$/;
  const date = /^(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[/.月]\d{1,2}日?)(?:\s*[-–—~～至到]\s*(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[/.月]\d{1,2}日?))?$/;
  const price = /^(?:免费|免票|[—–-]|[$¥￥€£]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:元|美元|人民币))$/;
  return time.test(text) || date.test(text) || price.test(text);
}

function markTableCells(table) {
  for (const cell of table.querySelectorAll("th, td")) {
    cell.classList.toggle("example-cell-nowrap", keepCellOnOneLine(cellText(cell)));
  }
}

function prepareTable(table) {
  const parent = table.parentElement;
  if (!parent) return;
  if (parent.classList.contains("example-table-scroll") || parent.classList.contains("tool-data-table-wrap")) {
    markTableCells(table);
    return;
  }
  const scroller = document.createElement("div");
  scroller.className = "example-table-scroll";
  parent.insertBefore(scroller, table);
  scroller.append(table);
  markTableCells(table);
}

function prepareTables(root) {
  adoptSessionOverrides(root);
  root.querySelectorAll("table").forEach(prepareTable);
  root.querySelectorAll("template").forEach((template) => {
    template.content.querySelectorAll("table").forEach(prepareTable);
  });
}

function splitThreadScroll() {
  for (const thread of document.querySelectorAll(".example-thread")) {
    if (thread.querySelector(":scope > .example-thread-body")) continue;
    const bar = thread.querySelector(":scope > .example-thread-bar");
    if (!bar) continue;
    const body = document.createElement("div");
    body.className = "example-thread-body";
    while (bar.nextSibling) body.append(bar.nextSibling);
    thread.append(body);
  }
}

function bindSessions() {
  for (const host of document.querySelectorAll("qz-session-view")) {
    if (!host.shadowRoot) continue;
    mountSessionView(host.shadowRoot);
    prepareTables(host.shadowRoot);
  }
}

function importLabel() {
  const lang = document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
  return catalog?.copy?.[lang]?.download || "";
}

function labelImportButton() {
  const button = document.querySelector("#qingzhou-session-cta");
  if (!(button instanceof HTMLButtonElement) || !button.hasAttribute("data-qingzhou-session-import")) return;
  if (button.disabled || button.getAttribute("aria-busy") === "true") return;
  if (button.dataset.qzLabeled) return;
  const label = importLabel();
  if (!label) return;
  button.dataset.qzLabeled = "1";
  if (button.textContent !== label) button.textContent = label;
}

function bindImport() {
  const actions = document.querySelector(".example-actions");
  if (!actions) return;
  const sync = () => {
    actions.classList.toggle("is-live", Boolean(actions.querySelector("[data-qingzhou-session-import]")));
    labelImportButton();
  };
  sync();
  new MutationObserver(sync).observe(actions, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden"],
  });
}

const transcriptScrollKeys = new Set(["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "]);

function pinTranscriptToTop() {
  const bodies = [...document.querySelectorAll(".example-thread-body")];
  if (!bodies.length) return;
  const keyListeners = [];
  const releaseScrollKeys = () => {
    for (const [target, handler] of keyListeners) target.removeEventListener("keydown", handler);
    keyListeners.length = 0;
  };
  const reset = () => {
    for (const body of bodies) {
      if (body.dataset.userScrolled === "true") continue;
      body.scrollTop = 0;
      const messages = body.querySelector("qz-session-view")?.shadowRoot?.getElementById("messages");
      if (messages) messages.scrollTop = 0;
    }
  };
  const mark = (event) => {
    const node = event.currentTarget instanceof ShadowRoot ? event.currentTarget.host : event.currentTarget;
    const body = node?.closest?.(".example-thread-body");
    if (!body) return;
    body.dataset.userScrolled = "true";
    if (bodies.every((item) => item.dataset.userScrolled === "true")) releaseScrollKeys();
  };
  const onScrollKey = (event) => {
    if (!transcriptScrollKeys.has(event.key) && event.code !== "Space") return;
    mark(event);
  };
  const watchScrollKeys = (target) => {
    target.addEventListener("keydown", onScrollKey);
    keyListeners.push([target, onScrollKey]);
  };
  reset();
  requestAnimationFrame(reset);
  window.addEventListener("load", reset);
  for (const delay of [50, 300, 1000]) {
    window.setTimeout(() => {
      reset();
      if (delay === 1000) releaseScrollKeys();
    }, delay);
  }
  for (const body of bodies) {
    if (!body.hasAttribute("tabindex")) body.tabIndex = -1;
    watchScrollKeys(body);
    body.addEventListener("wheel", mark, { passive: true });
    body.addEventListener("touchmove", mark, { passive: true });
    body.addEventListener("pointerdown", mark);
    const root = body.querySelector("qz-session-view")?.shadowRoot;
    if (root) watchScrollKeys(root);
    root?.addEventListener("wheel", mark, { passive: true });
    root?.addEventListener("touchmove", mark, { passive: true });
    root?.addEventListener("pointerdown", mark);
    root?.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", reset, { once: true });
    });
  }
}

bindMedia();
splitThreadScroll();
bindSessions();
pinTranscriptToTop();
bindImport();
syncTitle();
document.querySelector(".language")?.addEventListener("click", () => {
  syncTitle();
  labelImportButton();
});
window.addEventListener("popstate", () => {
  syncTitle();
  labelImportButton();
});
