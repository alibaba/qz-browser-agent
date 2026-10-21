import { t, tHtml } from "../i18n/index.js";
import { createImageAssetUrls } from "./image-asset-urls.js";
import { record } from "../tools/renderer-input.js";
import { escapeHtml, escapeHtmlAttribute as escapeAttr } from "./ui-utils.js";

interface GalleryItem { assetId: string; src: string; thumbSrc: string; title: string; error: string; fields: [string, unknown][] }
interface GalleryState { urls: ReturnType<typeof createImageAssetUrls>; revision: number }
let imageLightboxEl: HTMLElement | null = null;
let imageGalleryEl: HTMLElement | null = null;
let disposeGallery: (() => void) | null = null;

export function installImageLightbox(rootEl: HTMLElement | null, selector = ".msg-images img, .tool-screenshot img, .tool-article-body img, .msg-assistant .msg-content img") {
  if (!rootEl) return;
  rootEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : (event.target instanceof Node ? event.target.parentElement : null);
    const toolCard = target?.closest<HTMLElement>(".tool-image-grid-card[data-gallery-item]");
    if (toolCard && rootEl.contains(toolCard)) {
      event.preventDefault();
      openToolImageGridGallery(toolCard);
      return;
    }

    const img = target?.closest<HTMLImageElement>(selector);
    if (!img) return;
    event.preventDefault();
    openImageLightbox(img.dataset.fullSrc || img.currentSrc || img.src, img.alt || "image");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (imageGalleryEl) closeImageGallery();
      else if (imageLightboxEl) closeImageLightbox();
    }
  });
}

export function openImageGallery(items: unknown[] = [], startIndex = 0, options: { label?: string } = {}) {
  const rows = (Array.isArray(items) ? items : []).map(normalizeGalleryItem).filter(item => item.assetId || item.src);
  if (!rows.length) return;
  closeImageLightbox();
  closeImageGallery();

  const state: GalleryState = { urls: createImageAssetUrls(), revision: 0 };
  const controller = new AbortController();
  let index = clampGalleryIndex(startIndex, rows.length);
  const overlay = document.createElement("div");
  overlay.className = "data-image-gallery-overlay";
  overlay.innerHTML = `
    <div class="data-image-gallery" role="dialog" aria-modal="true" aria-label="${escapeAttr(options.label || t("imagePreview"))}">
      <button class="qz-icon-btn qz-icon-btn--sm data-image-gallery-close" type="button" title="${tHtml("close")}" aria-label="${tHtml("close")}">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <div class="data-image-gallery-main">
        <button class="qz-icon-btn qz-icon-btn--sm data-image-gallery-nav prev" type="button" title="${tHtml("previousImage")}" aria-label="${tHtml("previousImage")}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="data-image-gallery-stage"></div>
        <button class="qz-icon-btn qz-icon-btn--sm data-image-gallery-nav next" type="button" title="${tHtml("nextImage")}" aria-label="${tHtml("nextImage")}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <aside class="data-image-gallery-meta"></aside>
      <div class="data-image-gallery-strip" aria-label="${tHtml("imageThumbnails")}">
        ${rows.map((item, itemIndex) => renderGalleryThumb(item, itemIndex)).join("")}
      </div>
    </div>
  `;

  const select = (nextIndex: number, { scrollBehavior = "smooth" }: { scrollBehavior?: ScrollBehavior } = {}) => {
    index = clampGalleryIndex(nextIndex, rows.length);
    renderGallerySelection(overlay, rows, index, state, scrollBehavior);
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (!overlay.isConnected) return;
    if (event.key === "Escape") closeImageGallery();
    if (event.key === "ArrowLeft") select(index - 1);
    if (event.key === "ArrowRight") select(index + 1);
  };

  disposeGallery = () => { state.revision += 1; controller.abort(); state.urls.dispose(); };
  overlay.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : (event.target instanceof Node ? event.target.parentElement : null);
    if (target === overlay || target?.closest(".data-image-gallery-close")) {
      closeImageGallery();
      return;
    }
    if (target?.closest(".data-image-gallery-nav.prev")) {
      select(index - 1);
      return;
    }
    if (target?.closest(".data-image-gallery-nav.next")) {
      select(index + 1);
      return;
    }
    const thumb = target?.closest<HTMLElement>("[data-gallery-index]");
    if (thumb) select(Number(thumb.dataset.galleryIndex || 0));
  });
  document.addEventListener("keydown", onKeydown, { signal: controller.signal });
  document.body.appendChild(overlay);
  imageGalleryEl = overlay;
  hydrateGalleryThumbs(overlay, rows, state.urls);
  select(index, { scrollBehavior: "auto" });
}

function openToolImageGridGallery(card: HTMLElement) {
  const section = card.closest(".tool-image-grid-section") || card.parentElement;
  const cards = Array.from(section?.querySelectorAll<HTMLElement>(".tool-image-grid-card[data-gallery-item]") || []);
  const items = cards.map(parseGalleryItemFromCard).filter(Boolean);
  const index = Math.max(0, cards.indexOf(card));
  openImageGallery(items, index, { label: t("imagePreview") });
}

function parseGalleryItemFromCard(card: HTMLElement): unknown {
  try {
    const item: unknown = JSON.parse(card?.dataset?.galleryItem || "{}");
    if (item && typeof item === "object") return item;
  } catch (_err) {}
  const img = card?.querySelector?.("img");
  return normalizeGalleryItem({
    assetId: card?.dataset?.toolImageAssetId || "",
    src: img?.currentSrc || img?.src || "",
    title: card?.getAttribute?.("title") || img?.alt || t("images"),
  });
}

function renderGalleryThumb(item: GalleryItem, index: number) {
  const thumbSrc = item.thumbSrc || (!item.assetId ? item.src : "");
  const image = thumbSrc
    ? `<img src="${escapeAttr(thumbSrc)}" alt="">`
    : `<span class="data-image-thumb-loading">${escapeHtml(item.assetId ? t("loading") : t("noImage"))}</span>`;
  return `
    <button class="data-image-gallery-thumb" type="button" data-gallery-index="${escapeAttr(String(index))}" ${item.assetId ? `data-gallery-asset-id="${escapeAttr(item.assetId)}"` : ""} title="${escapeAttr(item.src || item.title || t("imageNumber", { number: index + 1 }))}">
      ${image}
    </button>
  `;
}

function hydrateGalleryThumbs(root: HTMLElement, items: GalleryItem[], urls: GalleryState["urls"]) {
  root.querySelectorAll<HTMLElement>(".data-image-gallery-thumb[data-gallery-asset-id]").forEach(slot => {
    const index = Number(slot.dataset.galleryIndex || -1);
    const item = items[index];
    if (!item?.assetId || slot.querySelector("img")) return;
    urls.acquire(item.assetId).then(url => {
      if (!slot.isConnected) return;
      slot.innerHTML = url ? `<img src="${escapeAttr(url)}" alt="">` : `<span class="data-image-thumb-empty">${tHtml("missing")}</span>`;
    }).catch(() => {
      if (!slot.isConnected) return;
      slot.innerHTML = `<span class="data-image-thumb-empty">${tHtml("missing")}</span>`;
    });
  });
}

function renderGallerySelection(root: HTMLElement, items: GalleryItem[], index: number, state: GalleryState, scrollBehavior: ScrollBehavior) {
  const revision = ++state.revision;
  const item = items[index];
  const stage = root.querySelector(".data-image-gallery-stage");
  const meta = root.querySelector(".data-image-gallery-meta");
  let activeThumb: HTMLElement | null = null;
  root.querySelectorAll<HTMLElement>(".data-image-gallery-thumb").forEach((thumb, thumbIndex) => {
    thumb.classList.toggle("active", thumbIndex === index);
    if (thumbIndex === index) activeThumb = thumb;
  });
  scrollGalleryThumbIntoView(activeThumb, scrollBehavior);
  if (meta) meta.innerHTML = renderGalleryMeta(item, index, items.length);
  if (!stage) return;
  stage.innerHTML = `<div class="data-image-gallery-loading">${tHtml("loading")}</div>`;
  resolveGalleryImageSrc(item, state.urls).then(src => {
    if (!stage.isConnected || state.revision !== revision) return;
    if (!src) {
      stage.innerHTML = `<div class="data-image-gallery-empty">${escapeHtml(item.error || t("noImagesToPreview"))}</div>`;
      return;
    }
    stage.innerHTML = `<img src="${escapeAttr(src)}" alt="${escapeAttr(item.title || t("images"))}">`;
  }).catch(() => {
    if (!stage.isConnected || state.revision !== revision) return;
    stage.innerHTML = `<div class="data-image-gallery-empty">${tHtml("imageAssetMissing")}</div>`;
  });
}

function scrollGalleryThumbIntoView(thumb: HTMLElement | null, behavior: ScrollBehavior = "smooth") {
  if (!thumb) return;
  const strip = thumb.closest(".data-image-gallery-strip");
  if (!strip) return;
  const thumbRect = thumb.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const delta = (thumbRect.left + thumbRect.width / 2) - (stripRect.left + stripRect.width / 2);
  const left = strip.scrollLeft + delta;
  if (behavior === "auto") {
    strip.scrollLeft = left;
  } else {
    strip.scrollTo({ left, behavior });
  }
}

async function resolveGalleryImageSrc(item: GalleryItem, urls: GalleryState["urls"]) {
  if (item.assetId) {
    const url = await urls.acquire(item.assetId);
    if (url) return url;
  }
  return item.src || "";
}

function renderGalleryMeta(item: GalleryItem, index = 0, total = 0) {
  const fields = normalizeGalleryFields(item.fields);
  return `
    <div class="data-image-gallery-meta-head">
      <div class="data-image-gallery-meta-title">${escapeHtml(item.title || t("images"))}</div>
      <div class="data-image-gallery-meta-count">${escapeHtml(String(index + 1))}/${escapeHtml(String(total))}</div>
    </div>
    <div class="data-image-gallery-meta-list">
      ${fields.map(([label, value]) => `
        <div class="data-image-gallery-meta-row">
          <span>${escapeHtml(label)}</span>
          <b title="${escapeAttr(String(value))}">${formatGalleryMetaValueHtml(label, value)}</b>
        </div>
      `).join("")}
    </div>
  `;
}

function formatGalleryMetaValueHtml(label: string, value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (isGallerySourceLabel(label) && isHttpUrl(text)) {
    return `<a href="${escapeAttr(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clipText(text, 180))}</a>`;
  }
  return escapeHtml(clipText(text, 180));
}

function isGallerySourceLabel(label: string) {
  return String(label || "").trim() === t("source");
}

function isHttpUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

function normalizeGalleryItem(item: unknown = {}): GalleryItem {
  const value = record(item);
  return {
    assetId: String(value.assetId || "").trim(),
    src: String(value.src || value.url || value.imageUrl || "").trim(),
    thumbSrc: String(value.thumbSrc || value.thumbnailUrl || "").trim(),
    title: String(value.title || value.alt || value.name || value.assetId || t("images")).trim(),
    error: String(value.error || "").trim(),
    fields: normalizeGalleryFields(value.fields || value.meta),
  };
}

function normalizeGalleryFields(fields: unknown): [string, unknown][] {
  const source = Array.isArray(fields)
    ? fields
    : (fields && typeof fields === "object" ? Object.entries(fields) : []);
  return source
    .map((item): [string, unknown] => Array.isArray(item) ? [String(item[0] || ""), item[1]] : ["", ""])
    .filter(([label, value]) => label && value !== undefined && value !== null && value !== "");
}

function clampGalleryIndex(value: unknown, total: number) {
  if (!total) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((Math.trunc(n) % total) + total) % total;
}

function openImageLightbox(src: string, alt = "image") {
  if (!src) return;
  closeImageGallery();
  closeImageLightbox();
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.innerHTML = `
    <button class="qz-icon-btn qz-icon-btn--md image-lightbox-close" type="button" title="${tHtml("close")}" aria-label="${tHtml("close")}">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">
  `;
  overlay.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : (event.target instanceof Node ? event.target.parentElement : null);
    if (target === overlay || target?.closest(".image-lightbox-close")) closeImageLightbox();
  });
  document.body.appendChild(overlay);
  imageLightboxEl = overlay;
}

function closeImageLightbox() {
  imageLightboxEl?.remove();
  imageLightboxEl = null;
}

function closeImageGallery() {
  disposeGallery?.();
  disposeGallery = null;
  imageGalleryEl?.remove();
  imageGalleryEl = null;
}

function clipText(value: unknown, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

