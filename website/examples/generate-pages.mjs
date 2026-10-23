// Build homepage cards, detail pages, and example translations from catalog.js.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(websiteRoot, "examples/catalog.js");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(catalogPath, "utf8"), context, { filename: catalogPath });
const catalog = context.window.QZ_EXAMPLES;
const localeIds = ["zh", "en"];
if (!Array.isArray(catalog?.locales?.zh) || !Array.isArray(catalog?.locales?.en)) {
  throw new Error("catalog locales need zh and en lists");
}
if (catalog.fallback && !localeIds.includes(catalog.fallback)) throw new Error("fallback locale must be zh or en");
if (!catalog.locales.zh.length && !catalog.locales.en.length) throw new Error("catalog has no examples");

const ARROW = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>';
const GITHUB = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"></path></svg>';
const VIDEO_BYTES = 5 * 1024 * 1024;
let locales = catalog.locales;
const START = "<!-- examples:start -->";
const END = "<!-- examples:end -->";
const STORE = catalog.storeUrl;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buttonHtml(label) {
  return `<span>${escapeHtml(label)}</span>${ARROW}`;
}

function groupOf(entry) {
  return entry.group || entry.slug;
}

function requireEntry(entry, localeId) {
  if (!entry.slug) throw new Error(`${localeId} example is missing slug`);
  if (!entry.file) throw new Error(`${entry.slug} example is missing file`);
  if (entry.slug === "en" || entry.slug === "sessions") throw new Error(`${entry.slug} is a reserved directory name`);
  if (entry.posterTime !== undefined && entry.posterTime !== null && entry.posterTime !== "") {
    const time = Number(entry.posterTime);
    if (!Number.isFinite(time) || time < 0) throw new Error(`${entry.slug} posterTime must be seconds`);
  }
  for (const link of entry.related || []) {
    if (!link.slug || !link.id || !link.label) throw new Error(`${entry.slug} related link is incomplete`);
    if (!catalog.locales[localeId].some((item) => item.slug === link.slug)) {
      throw new Error(`${entry.slug} links to missing ${localeId} example ${link.slug}`);
    }
  }
}

function presentation(localeId) {
  const own = locales[localeId];
  if (own.length || localeId === catalog.fallback || !catalog.fallback) {
    return { entries: own.filter((entry) => entry.card !== false), fallback: false, source: localeId };
  }
  return {
    entries: locales[catalog.fallback].filter((entry) => entry.card !== false),
    fallback: true,
    source: catalog.fallback,
  };
}

function cardHref(sourceLocale, slug) {
  return sourceLocale === "en" ? `./examples/en/${slug}/` : `./examples/${slug}/`;
}

function cardsHtml(localeId) {
  const view = presentation(localeId);
  return view.entries.map((entry) => {
    const pack = view.fallback ? catalog.fallbackCopy?.[localeId]?.[groupOf(entry)] : null;
    if (view.fallback && !pack) throw new Error(`missing fallbackCopy.${localeId}.${groupOf(entry)}`);
    const title = view.fallback ? pack.title : entry.title;
    const summary = view.fallback ? pack.summary : entry.summary;
    const alt = view.fallback ? (pack.alt || pack.title) : (entry.alt || entry.title);
    // Keep a clearly wider shot whole so side text is not cropped. A frame only
    // slightly wider than 16/10 fills the card; its radius clips the corners.
    const wide = entry.poster && entry.imageWidth / entry.imageHeight > 1.75;
    // An optional animated cover for the homepage card. The still poster stays
    // for the detail page and for visitors who prefer reduced motion.
    const still = entry.poster ? `<img src="./${entry.poster}" width="${entry.imageWidth}" height="${entry.imageHeight}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">` : "";
    const art = entry.cardGif && entry.poster
      ? `<picture><source media="(prefers-reduced-motion: reduce)" srcset="./${entry.poster}"><img src="./${entry.cardGif}" width="${entry.imageWidth}" height="${entry.imageHeight}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"></picture>`
      : still;
    const cover = entry.poster
      ? `<span class="example-cover${wide ? " is-wide" : ""}">${art}</span>`
      : `<span class="example-cover example-cover-empty" role="img" aria-label="${escapeHtml(alt)}"></span>`;
    return `    <a class="example-card" href="${cardHref(view.source, entry.slug)}">
      ${cover}
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(summary)}</p>
    </a>`;
  }).join("\n");
}

function englishPack(group) {
  const pack = catalog.fallbackCopy?.en?.[group];
  if (!pack) throw new Error(`missing fallbackCopy.en.${group}`);
  return pack;
}

function englishAlt(entry) {
  const pack = englishPack(groupOf(entry));
  return pack.sessionAlt?.[entry.session] || pack.alt || pack.title;
}

function commandExists(name) {
  const found = spawnSync("which", [name], { encoding: "utf8" });
  return found.status === 0 && Boolean(found.stdout.trim());
}

function inspectVideo(entry, absPath) {
  const size = fs.statSync(absPath).size;
  if (size > VIDEO_BYTES) {
    console.warn(`warning: ${entry.slug} video is ${(size / 1048576).toFixed(1)}MB, over the 5MB guide size`);
  }
  if (!commandExists("ffprobe")) {
    console.warn(`warning: ffprobe is not installed, so the codec and audio checks for ${entry.slug} were skipped`);
    return null;
  }
  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-of", "json",
    absPath,
  ], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.warn(`warning: ffprobe could not read ${entry.slug}; the frame uses 16:10`);
    return null;
  }
  const streams = JSON.parse(probe.stdout || "{}").streams || [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (streams.some((stream) => stream.codec_type === "audio")) {
    console.warn(`warning: ${entry.slug} video has an audio track. Examples play muted; strip the audio before publishing.`);
  }
  if (video?.codec_name && video.codec_name !== "h264") {
    console.warn(`warning: ${entry.slug} video codec is ${video.codec_name}, not H.264`);
  }
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!width || !height) {
    console.warn(`warning: ${entry.slug} video dimensions are unknown; the frame uses 16:10`);
    return null;
  }
  return { width, height };
}

function extractPoster(entry, localeId, videoAbs) {
  const rel = `assets/examples/${entry.slug}-${localeId}.webp`;
  const out = path.join(websiteRoot, rel);
  const time = entry.posterTime === undefined || entry.posterTime === null || entry.posterTime === ""
    ? 1
    : Number(entry.posterTime);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let quality = 72;
  while (quality >= 40) {
    const result = spawnSync("ffmpeg", [
      "-y", "-ss", String(time), "-i", videoAbs,
      "-frames:v", "1",
      "-vf", "scale=840:-2",
      "-c:v", "libwebp",
      "-quality", String(quality),
      out,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      const tail = (result.stderr || "").trim().split("\n").slice(-3).join(" ");
      console.warn(`warning: ffmpeg could not extract a poster for ${entry.slug}${tail ? ` (${tail})` : ""}`);
      if (entry.poster) console.warn(`warning: ${entry.slug} keeps the poster field`);
      return entry.poster || "";
    }
    if (fs.statSync(out).size <= 80 * 1024) break;
    quality -= 8;
  }
  return rel;
}

function readImageSize(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X" && buf.length >= 30) {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function resolveMedia(entry, localeId) {
  const video = typeof entry.video === "string" ? entry.video.trim() : "";
  let poster = typeof entry.poster === "string" ? entry.poster.trim() : "";
  let frameWidth = 16;
  let frameHeight = 10;
  if (video) {
    const abs = path.join(websiteRoot, video);
    if (!fs.existsSync(abs)) throw new Error(`${entry.slug} video was not found at ${video}`);
    const probed = inspectVideo(entry, abs);
    if (probed) {
      frameWidth = probed.width;
      frameHeight = probed.height;
    }
    if (!commandExists("ffmpeg")) {
      console.warn(`warning: ffmpeg is not installed, so no poster frame was extracted for ${entry.slug}`);
      if (poster) console.warn(`warning: ${entry.slug} keeps the poster field`);
      else console.warn(`warning: ${entry.slug} has no poster field to fall back to`);
    } else if (!poster) {
      poster = extractPoster(entry, localeId, abs);
    }
  }
  if (poster && !fs.existsSync(path.join(websiteRoot, poster))) {
    throw new Error(`${entry.slug} poster was not found at ${poster}`);
  }
  const image = poster ? readImageSize(path.join(websiteRoot, poster)) : null;
  if (entry.cardGif && !fs.existsSync(path.join(websiteRoot, entry.cardGif))) {
    throw new Error(`${entry.slug} cardGif was not found at ${entry.cardGif}`);
  }
  return {
    video,
    poster,
    frameWidth,
    frameHeight,
    imageWidth: image?.width || frameWidth,
    imageHeight: image?.height || frameHeight,
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join(" ");
}

function oneLine(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = flat.split(/(?<=[。！？.!?])/)[0].trim();
  const line = sentence.length >= 12 ? sentence : flat;
  if (line.length <= 140) return line;
  return `${line.slice(0, 139).trim()}…`;
}

function firstUserLine(payload) {
  const entries = payload?.session?.conversation?.entries || [];
  for (const item of entries) {
    const message = item?.message;
    if (message?.role !== "user") continue;
    if (message._kind === "context_capsule" || message._origin === "context_capsule") continue;
    const text = messageText(message.content).trim();
    if (!text || text.startsWith("[运行上下文")) continue;
    return oneLine(text);
  }
  return "";
}

const exportCache = new Map();
function loadExport(file) {
  if (!exportCache.has(file)) exportCache.set(file, readExport(file));
  return exportCache.get(file);
}

function presentEntry(entry, localeId) {
  const exported = loadExport(entry.file);
  const media = resolveMedia(entry, localeId);
  return {
    ...entry,
    title: entry.title || exported.title,
    summary: entry.summary || exported.summary || exported.title,
    alt: entry.alt || entry.title || exported.title,
    video: media.video,
    poster: media.poster,
    frameWidth: media.frameWidth,
    frameHeight: media.frameHeight,
    imageWidth: media.imageWidth,
    imageHeight: media.imageHeight,
    exportPart: exported,
  };
}

function buildCopy() {
  const copy = {};
  for (const locale of ["en", "zh-CN"]) {
    const shared = catalog.copy[locale];
    const localeId = locale === "zh-CN" ? "zh" : "en";
    copy[locale] = {
      html: {
        examplesTitle: escapeHtml(shared.title),
        examplesLede: escapeHtml(shared.lede),
        exampleDownload: escapeHtml(shared.download),
        examplesGrid: cardsHtml(localeId),
      },
      attributes: {},
    };
  }
  const seen = new Set();
  for (const entry of locales.zh) {
    const group = groupOf(entry);
    if (seen.has(group)) continue;
    seen.add(group);
    const primary = locales.zh.find((item) => item.slug === group) || entry;
    const pack = englishPack(group);
    copy.en.html[`example-${group}-title`] = escapeHtml(pack.title);
    copy["zh-CN"].html[`example-${group}-title`] = escapeHtml(primary.title);
    copy.en.html[`example-${group}-summary`] = escapeHtml(pack.summary);
    copy["zh-CN"].html[`example-${group}-summary`] = escapeHtml(primary.summary);
    copy.en.attributes[`example-${group}-description`] = { content: pack.summary };
    copy["zh-CN"].attributes[`example-${group}-description`] = { content: primary.summary };
    const labels = locales.zh
      .filter((item) => groupOf(item) === group)
      .flatMap((item) => item.related || []);
    labels.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    for (const link of labels) {
      const english = pack.related?.[link.id];
      if (!english) throw new Error(`missing fallbackCopy.en.${group}.related.${link.id}`);
      copy.en.html[`example-${group}-${link.id}`] = escapeHtml(english);
      copy["zh-CN"].html[`example-${group}-${link.id}`] = escapeHtml(link.label);
    }
  }
  for (const entry of locales.zh) {
    const key = `example-${entry.slug}-poster`;
    copy.en.attributes[key] = { alt: englishAlt(entry), "aria-label": englishAlt(entry) };
    const zhAlt = entry.alt || entry.title;
    copy["zh-CN"].attributes[key] = { alt: zhAlt, "aria-label": zhAlt };
  }
  for (const entry of locales.en) {
    const key = `example-en-${entry.slug}`;
    const zhMatch = locales.zh.find((item) => item.slug === entry.slug);
    copy.en.html[`${key}-title`] = escapeHtml(entry.title);
    copy["zh-CN"].html[`${key}-title`] = escapeHtml(zhMatch?.title || entry.title);
    copy.en.html[`${key}-summary`] = escapeHtml(entry.summary);
    copy["zh-CN"].html[`${key}-summary`] = escapeHtml(zhMatch?.summary || entry.summary);
    copy.en.attributes[`${key}-description`] = { content: entry.summary };
    copy["zh-CN"].attributes[`${key}-description`] = { content: zhMatch?.summary || entry.summary };
    const enAlt = entry.alt || entry.title;
    const zhAlt = zhMatch?.alt || zhMatch?.title || enAlt;
    copy.en.attributes[`${key}-poster`] = { alt: enAlt, "aria-label": enAlt };
    copy["zh-CN"].attributes[`${key}-poster`] = { alt: zhAlt, "aria-label": zhAlt };
    for (const link of entry.related || []) {
      copy.en.html[`${key}-${link.id}`] = escapeHtml(link.label);
      const zhLabel = zhMatch?.related?.find((item) => item.id === link.id)?.label || link.label;
      copy["zh-CN"].html[`${key}-${link.id}`] = escapeHtml(zhLabel);
    }
  }
  return copy;
}

function homepageSection(cards) {
  const en = catalog.copy.en;
  return `<section class="examples section wrap" id="examples" aria-labelledby="examples-title">
  <div class="section-heading">
    <h2 id="examples-title" data-i18n="examplesTitle">${escapeHtml(en.title)}</h2>
    <p data-i18n="examplesLede">${escapeHtml(en.lede)}</p>
  </div>
  <div class="example-grid" data-i18n="examplesGrid">
${cards}
  </div>
</section>`;
}

function mediaMarkup(entry, view, root) {
  const alt = escapeHtml(view.mediaAlt);
  const ratio = `style="aspect-ratio: ${entry.frameWidth} / ${entry.frameHeight}"`;
  const poster = entry.poster
    ? `<img class="example-poster" src="${root}${entry.poster}" width="${entry.imageWidth}" height="${entry.imageHeight}" alt="${alt}" decoding="async" data-i18n-attributes="${view.mediaKey}">`
    : "";
  const video = entry.video
    ? `<video class="example-video" muted autoplay loop playsinline preload="metadata"${entry.poster ? ` poster="${root}${entry.poster}"` : ""} width="${entry.frameWidth}" height="${entry.frameHeight}" data-src="${root}${entry.video}" aria-label="${alt}" data-i18n-attributes="${view.mediaKey}"></video>`
    : "";
  if (!poster && !video) {
    return `<div class="example-frame example-frame-empty" ${ratio} role="img" aria-label="${alt}" data-i18n-attributes="${view.mediaKey}"></div>`;
  }
  return `<div class="example-frame" ${ratio}>${poster}${video}</div>`;
}

function hasSlug(localeId, slug) {
  return locales[localeId].some((entry) => entry.slug === slug);
}

function switchHref(localeId, slug) {
  const other = localeId === "zh" ? "en" : "zh";
  if (hasSlug(other, slug)) return localeId === "zh" ? `../en/${slug}/` : `../../${slug}/`;
  return localeId === "zh" ? "../../?lang=en#examples" : "../../../?lang=zh-CN#examples";
}

function readExport(file) {
  const absolute = path.join(websiteRoot, file);
  const html = fs.readFileSync(absolute, "utf8");
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  const runtime = html.match(/<script>([\s\S]*?)<\/script>/);
  const exchange = html.match(/<script id="qingzhou-session-exchange" type="application\/json">[\s\S]*?<\/script>/);
  const messages = html.match(/<main id="messages">([\s\S]*?)<\/main>/);
  const labels = html.match(/<script type="application\/json" id="qingzhou-export-messages">[\s\S]*?<\/script>/);
  if (styles.length < 2 || !runtime || !exchange || !messages || !labels) {
    throw new Error(`export ${file} is missing the transcript, stylesheet, or exchange script`);
  }
  const payload = JSON.parse(exchange[0].replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
  const title = sessionTitle(html, payload);
  const summary = firstUserLine(payload);
  const transcript = messages[1].replace(/<div id="session-title-bar"[\s\S]*?<\/div>/, "");
  return { styles, runtime: runtime[1], exchange: exchange[0], messages: transcript, labels: labels[0], title, summary };
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function sessionTitle(html, payload) {
  const shown = html.match(/<span id="current-session-title"[^>]*>([\s\S]*?)<\/span>/);
  if (!shown?.[1].trim()) throw new Error("export is missing the session title");
  const title = decodeHtml(shown[1].trim());
  if (payload?.session?.title !== title) throw new Error(`session title mismatch for ${title}`);
  return title;
}

function adaptSessionCss(panel, shell) {
  const adaptedPanel = panel.replaceAll(":root", ":host").replace("html,\n  body", ":host");
  const adaptedShell = shell
    .replaceAll("html, body", ":host")
    .replace("body { background: var(--bg-primary); }", ":host { background: var(--bg-primary); }");
  if (adaptedPanel.includes(":root") || adaptedPanel.includes("html,") || adaptedShell.includes("html,") || /\bbody\b/.test(adaptedShell)) {
    throw new Error("session stylesheet still targets the outer page");
  }
  return `${adaptedPanel}\n${adaptedShell}\n`;
}

function replaceRequired(source, from, to) {
  const found = source.split(from).length - 1;
  if (found !== 1) {
    throw new Error(`export runtime has ${found} occurrences of ${JSON.stringify(from)}; expected 1. The extension export runtime changed. Update adaptSessionScript, then regenerate the example pages.`);
  }
  return source.replace(from, to);
}

function adaptSessionScript(source) {
  source = source.trim();
  // Minified exports start with (()=>{ and unminified ones with (() => {.
  const open = /^\(\(\)\s*=>\s*\{/.exec(source);
  if (!open || !source.endsWith("})();")) throw new Error("unexpected export runtime");
  let body = source.slice(open[0].length, -"})();".length);
  body = replaceRequired(body, 'document.getElementById("qingzhou-export-messages")', 'root.getElementById("qingzhou-export-messages")');
  body = replaceRequired(body, "document.body.appendChild", "root.appendChild");
  body = replaceRequired(body, 'document.addEventListener("click"', 'root.addEventListener("click"');
  if (body.includes("document.body") || body.includes('document.addEventListener("click"') || body.includes('document.getElementById("qingzhou-export-messages")')) {
    throw new Error("export runtime was not scoped to the shadow root. The extension export runtime changed. Update adaptSessionScript, then regenerate the example pages.");
  }
  if (!body.includes('document.getElementById("qingzhou-session-cta")')) {
    throw new Error('export runtime is missing document.getElementById("qingzhou-session-cta"). The extension export runtime changed. Update adaptSessionScript, then regenerate the example pages.');
  }
  return `export function mountSessionView(root) {${body}}\n`;
}

function lazyImages(html) {
  return html.replace(/<img\b([^>]*?)>/g, (full, attrs) => (
    /\bloading\s*=/.test(attrs) ? full : `<img loading="lazy"${attrs}>`
  ));
}

function sessionView(part, root) {
  return `<qz-session-view><template shadowrootmode="open"><link rel="stylesheet" href="${root}assets/examples/session-view${part.assetSuffix}.css"><link rel="stylesheet" href="${root}assets/examples/session-view-overrides.css">${part.labels}<main id="messages">${lazyImages(part.messages)}</main></template></qz-session-view>`;
}

// A group of examples that belong together (for example create and reuse) is
// shown as a numbered step switch. Each member's label comes from the related
// link another member holds to it, so the catalog data is unchanged.
function stepsMarkup(entry, localeId) {
  const group = groupOf(entry);
  const members = catalog.locales[localeId].filter((item) => groupOf(item) === group);
  if (members.length < 2) return "\n      ";
  const items = members.map((member, index) => {
    let label = "";
    let key = "";
    for (const holder of members) {
      const link = (holder.related || []).find((item) => item.slug === member.slug);
      if (!link) continue;
      if (localeId === "zh") {
        label = englishPack(group).related?.[link.id];
        if (!label) throw new Error(`missing fallbackCopy.en.${group}.related.${link.id}`);
        key = `example-${group}-${link.id}`;
      } else {
        label = link.label;
        key = `example-en-${holder.slug}-${link.id}`;
      }
      break;
    }
    if (!label) throw new Error(`${member.slug} has no step label; add a related link to it from the same group`);
    const inner = `<span class="example-step-n">${index + 1}</span><span class="example-step-label" data-i18n="${key}">${escapeHtml(label)}</span>`;
    return member.slug === entry.slug
      ? `<li><span class="example-step is-current" aria-current="step">${inner}</span></li>`
      : `<li><a class="example-step" href="../${member.slug}/">${inner}</a></li>`;
  });
  return `\n      <ol class="example-steps">${items.join("")}</ol>`;
}

function pageView(entry, localeId) {
  const group = groupOf(entry);
  if (localeId === "zh") {
    const pack = englishPack(group);
    return {
      title: pack.title,
      summary: pack.summary,
      mediaAlt: englishAlt(entry),
      titleKey: `example-${group}-title`,
      summaryKey: `example-${group}-summary`,
      descriptionKey: `example-${group}-description`,
      mediaKey: `example-${entry.slug}-poster`,
      related: stepsMarkup(entry, localeId),
    };
  }
  const key = `example-en-${entry.slug}`;
  return {
    title: entry.title,
    summary: entry.summary,
    mediaAlt: entry.alt || entry.title,
    titleKey: `${key}-title`,
    summaryKey: `${key}-summary`,
    descriptionKey: `${key}-description`,
    mediaKey: `${key}-poster`,
    related: stepsMarkup(entry, localeId),
  };
}

// 0.1.4 exports differ from the shared 0.1.2 sheet by exactly these two rules.
// Fold them back to the 0.1.2 spelling before the compare and before writing
// the shared sheet. Any other difference still fails the check.
function normalizeSharedPanel(css) {
  return css
    .replace(
      "#app[data-consent-pending] {\n    display: none !important;\n  }",
      "#app[data-consent-pending] {\n    display: none;\n  }",
    )
    .replace(
      ".data-image-gallery-strip {\n    grid-column: 1 / -1;\n    min-width: 0;\n    display: flex;\n    gap: 8px;\n    overflow-x: auto;\n    padding: 4px 2px 2px;\n  }",
      ".data-image-gallery-strip {\n    grid-column: 1 / -1;\n    min-width: 0;\n    display: flex;\n    gap: 8px;\n    overflow-x: auto;\n    padding: 4px 2px 2px;\n    scrollbar-gutter: stable;\n  }",
    );
}

// Exports from different extension builds can ship a different panel stylesheet or runtime.
// Parts with identical ones share one pair of files; the first group keeps the plain
// session-view.css/js names and every other group gets a numbered pair (-2, -3, ...).
// Labels are per language and are inlined into each page, so they are not compared.
function writeSharedSessionAssets(parts) {
  const groups = new Map();
  for (const part of parts) {
    const panel = normalizeSharedPanel(part.styles[0]);
    const key = JSON.stringify([panel, part.styles[1], part.runtime]);
    if (!groups.has(key)) groups.set(key, { panel, part, suffix: groups.size === 0 ? "" : `-${groups.size + 1}` });
    part.assetSuffix = groups.get(key).suffix;
  }
  const dir = path.join(websiteRoot, "assets/examples");
  fs.mkdirSync(dir, { recursive: true });
  for (const [, group] of groups) {
    fs.writeFileSync(path.join(dir, `session-view${group.suffix}.css`), adaptSessionCss(group.panel, group.part.styles[1]));
    fs.writeFileSync(path.join(dir, `session-view${group.suffix}.js`), adaptSessionScript(group.part.runtime));
  }
  for (const file of fs.readdirSync(dir)) {
    const match = /^session-view(-\d+)?\.(?:css|js)$/.exec(file);
    if (match && !(match[1] === undefined ? groups.size > 0 : [...groups.values()].some((group) => group.suffix === match[1]))) {
      fs.rmSync(path.join(dir, file));
    }
  }
}

function detailPage(localeId, entry, part) {
  const en = catalog.copy.en;
  const view = pageView(entry, localeId);
  const root = localeId === "zh" ? "../../" : "../../../";
  const canonical = localeId === "zh"
    ? `https://alibaba.github.io/qz-browser-agent/examples/${entry.slug}/`
    : `https://alibaba.github.io/qz-browser-agent/examples/en/${entry.slug}/`;
  const alternates = localeId === "zh" && !hasSlug("en", entry.slug)
    ? `<link rel="canonical" href="${canonical}">
  <link rel="alternate" hreflang="en" href="${canonical}">
  <link rel="alternate" hreflang="zh-CN" href="${canonical}?lang=zh-CN">
  <link rel="alternate" hreflang="x-default" href="${canonical}">`
    : `<link rel="canonical" href="${canonical}">
  <link rel="alternate" hreflang="en" href="${hasSlug("en", entry.slug) ? `https://alibaba.github.io/qz-browser-agent/examples/en/${entry.slug}/` : "https://alibaba.github.io/qz-browser-agent/?lang=en#examples"}">
  <link rel="alternate" hreflang="zh-CN" href="${hasSlug("zh", entry.slug) ? `https://alibaba.github.io/qz-browser-agent/examples/${entry.slug}/` : "https://alibaba.github.io/qz-browser-agent/?lang=zh-CN#examples"}">
  <link rel="alternate" hreflang="x-default" href="${canonical}">`;
  const pageLang = localeId === "zh" ? "zh-CN" : "en";
  return `<!DOCTYPE html>
<html lang="en" data-example="${groupOf(entry)}" data-site-root="${root}" data-generated="qz-example" data-session="${entry.session || "default"}" data-session-view="${part.assetSuffix}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="${escapeHtml(view.summary)}" data-i18n-attributes="${view.descriptionKey}">
  <meta name="theme-color" content="#f7f7f5">
  ${alternates}
  <link rel="icon" type="image/png" href="${root}assets/icon.png">
  <link rel="stylesheet" href="${root}assets/site.css">
  <link rel="stylesheet" href="${root}assets/examples.css">
  <script src="${root}examples/catalog.js"></script>
  <script src="${root}assets/site.js" type="module"></script>
  <script src="${root}assets/examples-render.js" type="module"></script>
  <title>${escapeHtml(view.title)} — qz</title>
</head>
<body>
<a class="skip-link" href="#main" data-i18n="skip">Skip to content</a>
<header class="header wrap">
  <a class="brand" href="${root}" aria-label="qz — Home" data-i18n-attributes="home"><img src="${root}assets/icon.png" width="32" height="32" alt=""><span>qz<span class="brand-caption"> / 轻舟</span></span></a>
  <nav aria-label="Main navigation" data-i18n-attributes="nav"><a href="${root}#overview" data-i18n="navOverview">Data</a><a href="${root}#extend" data-i18n="navExtend">Skills</a><a href="${root}#agents" data-i18n="navAgents">For agents</a><a href="https://github.com/alibaba/qz-browser-agent" class="nav-github">GitHub ${GITHUB}</a></nav>
  <div class="header-actions"><button class="language" type="button" hidden="" aria-label="Switch to 简体中文" data-example-locale="${pageLang}" data-switch-href="${switchHref(localeId, entry.slug)}">中文</button><a class="button button-small" href="${STORE}" data-i18n="navStart">Install${ARROW}</a></div>
</header>
<main id="main" class="example-page wrap">
  <div class="example-stage">
    <div class="example-lead">
      <h1 data-i18n="${view.titleKey}">${escapeHtml(view.title)}</h1>
      <p class="example-summary" data-i18n="${view.summaryKey}">${escapeHtml(view.summary)}</p>${view.related}
      ${mediaMarkup(entry, view, root)}
    </div>
    <div class="example-thread">
      <div class="example-actions example-thread-bar">
        <p class="example-session-title">${escapeHtml(part.title)}</p>
        <div class="example-thread-cta">
          <button id="qingzhou-session-cta" class="qz-btn qz-btn--primary qz-btn--xs session-export-cta" hidden type="button"></button>
          <a class="qz-btn qz-btn--primary qz-btn--xs session-export-cta" id="example-store" href="${STORE}" target="_blank" rel="noopener" data-i18n="exampleDownload">${escapeHtml(en.download)}</a>
        </div>
      </div>
      <div class="example-thread-body">
        ${sessionView(part, root)}
      </div>
    </div>
  </div>
</main>
<footer class="footer wrap"><a class="brand" href="${root}">qz</a><nav aria-label="Footer navigation" data-i18n-attributes="footer"><a href="https://github.com/alibaba/qz-browser-agent/blob/main/README.md" data-i18n="footerDocs" data-i18n-attributes="documentation">Documentation</a><a href="https://github.com/alibaba/qz-browser-agent/issues" data-i18n="footerIssues">Feedback</a><a href="https://github.com/alibaba/qz-browser-agent/blob/main/docs/permissions.md" data-i18n="footerPrivacy">Privacy</a><a href="${root}credits/" data-i18n="footerCredits">Credits</a><a href="https://github.com/alibaba/qz-browser-agent/blob/main/LICENSE">Apache-2.0</a></nav></footer>
${part.exchange}
</body>
</html>
`;
}

function assertClean(label, html) {
  if (html.includes("待定") || html.includes("copy-pending") || html.includes("<iframe") || html.includes("header-examples")) {
    throw new Error(`${label} still has a draft mark, frame, or duplicate Examples link`);
  }
  const navEntries = html.match(/data-i18n="navExamples"/g) || [];
  if (navEntries.length !== 0) throw new Error(`${label} still changes the site nav`);
  if (html.includes("Allow access to file URLs") || html.includes("允许访问文件网址") || html.includes("下载后用 Chrome")) {
    throw new Error(`${label} still shows a download hint`);
  }
}

function assertExampleKeys(html, translations) {
  for (const locale of ["en", "zh-CN"]) {
    for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
      if (!Object.hasOwn(translations[locale].html, match[1])) throw new Error(`missing ${locale} html translation ${match[1]}`);
    }
    for (const match of html.matchAll(/data-i18n-attributes="([^"]+)"/g)) {
      if (!translations[locale].attributes[match[1]]) throw new Error(`missing ${locale} attribute translation ${match[1]}`);
    }
  }
}

function jsonEntries(entries, indent) {
  return Object.entries(entries).map(([key, value]) => {
    if (value && typeof value === "object") {
      const body = Object.entries(value).map(([name, item]) => `${indent}  ${JSON.stringify(name)}: ${JSON.stringify(item)}`).join(",\n");
      return `${indent}${JSON.stringify(key)}: {\n${body}\n${indent}}`;
    }
    return `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  }).join(",\n");
}

function upsertMarked(source, marker, block, anchor) {
  const start = `/* ${marker}:start */`;
  const end = `/* ${marker}:end */`;
  const wrapped = `${start}\n${block}\n      ${end}`;
  const pattern = new RegExp(`/\\* ${marker}:start \\*/[\\s\\S]*?/\\* ${marker}:end \\*/`);
  if (pattern.test(source)) return source.replace(pattern, wrapped);
  if (!source.includes(anchor)) throw new Error(`missing translations anchor for ${marker}`);
  return source.replace(anchor, `${anchor},\n      ${wrapped}`);
}

function writeTranslations(copy) {
  const file = path.join(websiteRoot, "assets/translations.js");
  let source = fs.readFileSync(file, "utf8");
  source = upsertMarked(
    source,
    "example-html:en",
    jsonEntries(copy.en.html, "      "),
    '"agentRequirements": "Requires Node.js 22+ and Chrome on the same machine, with the qz extension and a model configured."',
  );
  source = upsertMarked(
    source,
    "example-html:zh",
    jsonEntries(copy["zh-CN"].html, "      "),
    '"agentRequirements": "需要 Node.js 22+，以及同一台电脑上的 Chrome、轻舟扩展和已配置的模型。"',
  );
  source = upsertMarked(
    source,
    "example-attr:en",
    jsonEntries(copy.en.attributes, "      "),
    '"aria-label": "Enlarge the qz side panel"\n      }',
  );
  source = upsertMarked(
    source,
    "example-attr:zh",
    jsonEntries(copy["zh-CN"].attributes, "      "),
    '"aria-label": "放大查看轻舟侧边栏"\n      }',
  );
  fs.writeFileSync(file, source);
}

function ensureHomepage(html) {
  if (!html.includes('href="./assets/examples.css"')) {
    html = html.replace(
      '  <link rel="stylesheet" href="./assets/site.css">\n',
      '  <link rel="stylesheet" href="./assets/site.css">\n  <link rel="stylesheet" href="./assets/examples.css">\n',
    );
  }
  return html
    .replace('<a class="header-examples" href="#examples" data-i18n="navExamples">Examples</a>', "")
    .replace('<a href="#examples" data-i18n="navExamples">Examples</a>', "");
}

function upsertHomepage(section) {
  const indexPath = path.join(websiteRoot, "index.html");
  let html = ensureHomepage(fs.readFileSync(indexPath, "utf8"));
  const block = `${START}\n${section}\n${END}\n`;
  if (html.includes(START) && html.includes(END)) {
    html = html.replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`), block);
  } else {
    const marker = '<section class="results section wrap" id="overview"';
    if (!html.includes(marker)) throw new Error("homepage overview section was not found");
    html = html.replace(marker, `${block}${marker}`);
  }
  if (!html.includes('id="examples"')) throw new Error("homepage is missing the examples section");
  if (html.includes('href="#examples"') || html.includes('data-i18n="navExamples"')) {
    throw new Error("homepage nav was changed");
  }
  fs.writeFileSync(indexPath, html);
  return html;
}

function removeGenerated(dir, slugs) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "sessions" || entry.name === "en" || slugs.has(entry.name)) continue;
    const indexPath = path.join(dir, entry.name, "index.html");
    if (!fs.existsSync(indexPath)) continue;
    const html = fs.readFileSync(indexPath, "utf8");
    if (html.includes('data-generated="qz-example"')) fs.rmSync(path.join(dir, entry.name), { recursive: true });
  }
}

function removeStalePages() {
  const examplesDir = path.join(websiteRoot, "examples");
  removeGenerated(examplesDir, new Set(catalog.locales.zh.map((entry) => entry.slug)));
  const englishDir = path.join(examplesDir, "en");
  removeGenerated(englishDir, new Set(catalog.locales.en.map((entry) => entry.slug)));
  if (fs.existsSync(englishDir) && fs.readdirSync(englishDir).length === 0) fs.rmdirSync(englishDir);
}

for (const localeId of localeIds) {
  const seen = new Set();
  for (const entry of catalog.locales[localeId]) {
    requireEntry(entry, localeId);
    if (seen.has(entry.slug)) throw new Error(`duplicate ${localeId} example ${entry.slug}`);
    seen.add(entry.slug);
  }
}
locales = {
  zh: catalog.locales.zh.map((entry) => presentEntry(entry, "zh")),
  en: catalog.locales.en.map((entry) => presentEntry(entry, "en")),
};
const copy = buildCopy();
const staleI18n = path.join(websiteRoot, "assets/examples-i18n.js");
if (fs.existsSync(staleI18n)) fs.rmSync(staleI18n);
writeTranslations(copy);
const translations = (await import(pathToFileURL(path.join(websiteRoot, "assets/translations.js")).href)).translations;
const section = homepageSection(cardsHtml("en"));
const homepage = upsertHomepage(section);
assertClean("homepage", homepage);
assertExampleKeys(homepage, translations);
removeStalePages();
const pages = localeIds.flatMap((localeId) => locales[localeId].map((entry) => ({
  localeId,
  entry,
  part: entry.exportPart,
})));
writeSharedSessionAssets(pages.map((page) => page.part));
for (const page of pages) {
  const html = detailPage(page.localeId, page.entry, page.part);
  const exchangeCount = html.split('id="qingzhou-session-exchange"').length - 1;
  const slug = page.localeId === "zh" ? page.entry.slug : `en/${page.entry.slug}`;
  if (exchangeCount !== 1) throw new Error(`${slug} embeds ${exchangeCount} exchange payloads`);
  if (!html.includes(page.part.exchange)) throw new Error(`${slug} changed the exchange script`);
  assertClean(`examples/${slug}/`, html);
  assertExampleKeys(html, translations);
  const dir = path.join(websiteRoot, "examples", ...(page.localeId === "zh" ? [page.entry.slug] : ["en", page.entry.slug]));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  console.log(`examples/${slug}/`);
}
console.log(`fallback: ${catalog.fallback || "off"}`);
console.log("generated example pages");
