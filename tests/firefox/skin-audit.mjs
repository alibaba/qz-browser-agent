// Measure the Firefox sidebar skin in stock Firefox: label, icon, and focus-ring contrast for
// each control state, the disabled treatment, and horizontal overflow at a given sidebar width.

/**
 * Runs in the sidebar frame script (`content`, `Cu`, `InspectorUtils`). States are forced with
 * InspectorUtils pseudo-class locks, transitions are paused so computed colors are final, and
 * each sample keeps the background layers up to the first opaque ancestor for compositing.
 */
const AUDIT_SCRIPT = `
  const doc = content.document;
  const win = content;
  const visible = selector => [...doc.querySelectorAll(selector)].find(element => element.getClientRects().length > 0) || null;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const app = doc.querySelector("#app");
    const rendered = [".send-btn", ".tab-btn.active", "#btn-new", ".onboarding-action"].every(visible);
    if (rendered && app && !app.hasAttribute("data-workspace-booting")) break;
    await new Promise(resolve => win.setTimeout(resolve, 50));
  }
  const pause = doc.createElement("style");
  pause.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  doc.head.appendChild(pause);
  const layers = element => {
    const out = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) out.push(win.getComputedStyle(node).backgroundColor);
    return out;
  };
  const read = (element, pseudo) => {
    const style = win.getComputedStyle(element, pseudo || null);
    return {
      color: style.color,
      layers: layers(element),
      outerLayers: layers(element.parentElement),
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      cursor: style.cursor,
      opacity: style.opacity,
    };
  };
  const locked = (element, state, run) => {
    if (!state) return run();
    const target = Cu.waiveXrays(element);
    InspectorUtils.addPseudoClassLock(target, state);
    try { return run(); } finally { InspectorUtils.clearPseudoClassLocks(target); }
  };
  const samples = [];
  const add = (name, kind, element, states, options = {}) => {
    if (!element) { samples.push({ name, kind, missing: true }); return; }
    for (const state of states) {
      samples.push({ name, kind, state: state || "rest", ...locked(options.lock || element, state, () => read(element, options.pseudo)) });
    }
  };
  try {
    add("body text", "text", doc.body, [""]);
    add("tab", "text", visible(".tab-btn:not(.active)"), ["", ":hover", ":active"]);
    add("selected tab", "text", visible(".tab-btn.active"), ["", ":focus-visible"]);
    add("icon button", "icon", visible("#btn-new"), ["", ":hover", ":active", ":focus-visible"]);
    add("onboarding copy", "text", visible(".onboarding-copy"), [""]);
    const action = visible(".onboarding-action");
    add("task title", "text", action && action.querySelector("span"), ["", ":hover", ":active"], { lock: action });
    add("task description", "text", action && action.querySelector("small"), ["", ":hover", ":active"], { lock: action });
    const primary = visible("#onboarding-primary-btn") || visible(".qz-btn--primary");
    add("primary", "text", primary, ["", ":hover", ":active", ":focus-visible"]);
    if (primary) {
      const was = primary.disabled;
      primary.disabled = true;
      add("primary disabled", "text", primary, [""]);
      primary.disabled = was;
    }
    const input = doc.querySelector("#input");
    add("placeholder", "text", input, [""], { pseudo: "::placeholder" });
    add("input hint", "text", visible(".input-hint"), [""]);
    const send = doc.querySelector(".send-btn");
    if (send) {
      const was = send.disabled;
      send.disabled = true;
      add("send disabled", "icon", send, ["", ":hover"]);
      send.disabled = false;
      add("send", "icon", send, ["", ":hover", ":active", ":focus-visible"]);
      send.disabled = was;
    }
  } finally {
    pause.remove();
  }
  const rootStyle = win.getComputedStyle(doc.documentElement);
  const palette = {};
  for (const name of [
    "--qz-ff-primary", "--qz-ff-primary-hover", "--qz-ff-primary-active", "--qz-ff-primary-text", "--qz-ff-accent-ink",
    "--qz-ff-text-deemphasized", "--qz-ff-text-muted", "--qz-ff-popup-text-deemphasized", "--qz-ff-popup-text-muted",
    "--qz-ff-field-text-deemphasized", "--qz-ff-field-placeholder",
  ]) {
    palette[name] = doc.documentElement.style.getPropertyValue(name).trim();
  }
  const probe = doc.createElement("span");
  probe.style.color = "AccentColor";
  doc.body.appendChild(probe);
  const accent = win.getComputedStyle(probe).color;
  probe.remove();
  return {
    samples,
    palette,
    accent,
    sidebar: win.getComputedStyle(doc.body).backgroundColor,
    dark: win.matchMedia("(prefers-color-scheme: dark)").matches,
    colorScheme: rootStyle.colorScheme,
  };
`;

export function auditSkin(session) {
  return session.extension("sidebar", AUDIT_SCRIPT);
}

/** Open settings when asked, then list visible elements that cross the sidebar's right edge. */
export function readOverflow(session, { settings = false } = {}) {
  return session.extension("sidebar", `
    const doc = content.document;
    const settingsButton = doc.querySelector("#btn-settings");
    const closeButton = doc.querySelector("#btn-close-settings");
    const settingsOpen = () => !!closeButton && closeButton.getClientRects().length > 0;
    if (${settings} !== settingsOpen()) (${settings} ? settingsButton : closeButton)?.click();
    await new Promise(resolve => content.setTimeout(resolve, 400));
    const width = content.innerWidth;
    const root = doc.documentElement;
    const offenders = [];
    for (const element of doc.querySelectorAll("body *")) {
      const rects = element.getClientRects();
      if (!rects.length) continue;
      const style = content.getComputedStyle(element);
      if (style.visibility === "hidden" || style.position === "fixed") continue;
      const box = element.getBoundingClientRect();
      if (box.width && box.right > width + 0.5) {
        offenders.push({ tag: element.tagName.toLowerCase(), id: element.id, className: String(element.className || "").slice(0, 80), right: Math.round(box.right) });
        if (offenders.length >= 10) break;
      }
    }
    return {
      width,
      settings: settingsOpen(),
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollWidth: doc.body.scrollWidth,
      offenders,
    };
  `);
}

export function parseColor(value) {
  const text = String(value || "").trim();
  let match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3]), alpha(match[4])];
  match = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (match) return [Number(match[1]) * 255, Number(match[2]) * 255, Number(match[3]) * 255, alpha(match[4])];
  return null;
}

function alpha(raw) {
  if (raw == null) return 1;
  return String(raw).endsWith("%") ? Number.parseFloat(raw) / 100 : Number(raw);
}

/** Composite background layers, innermost first, over the first opaque one. */
export function compositeLayers(layers, fallback) {
  const parsed = layers.map(parseColor).filter(Boolean);
  const base = parsed.findIndex(color => color[3] >= 1);
  let result = base >= 0 ? parsed[base].slice(0, 3) : (parseColor(fallback) || [255, 255, 255]).slice(0, 3);
  for (let index = (base >= 0 ? base : parsed.length) - 1; index >= 0; index -= 1) {
    const [red, green, blue, weight] = parsed[index];
    result = [red, green, blue].map((channel, at) => channel * weight + result[at] * (1 - weight));
  }
  return result;
}

export function contrast(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(rgb) {
  const [red, green, blue] = rgb.slice(0, 3).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Contrast of each sample: text and icons against their composited background, focus rings against the surroundings. */
export function measureSamples(audit) {
  return audit.samples.filter(sample => !sample.missing).map(sample => {
    const background = compositeLayers(sample.layers, audit.sidebar);
    const ink = parseColor(sample.color);
    const opacity = Number(sample.opacity || 1);
    const visibleInk = ink ? ink.slice(0, 3).map((channel, index) => channel * ink[3] * opacity + background[index] * (1 - ink[3] * opacity)) : null;
    const measured = {
      name: sample.name,
      state: sample.state,
      kind: sample.kind,
      cursor: sample.cursor,
      background: background.map(Math.round),
      ink: visibleInk ? visibleInk.map(Math.round) : null,
      ratio: visibleInk ? contrast(visibleInk, background) : 0,
    };
    if (sample.state === ":focus-visible") {
      const ring = parseColor(sample.outlineColor);
      const around = compositeLayers(sample.outerLayers, audit.sidebar);
      const drawn = sample.outlineStyle !== "none" && Number.parseFloat(sample.outlineWidth) >= 2 && ring;
      const inset = Number.parseFloat(sample.outlineOffset) < 0;
      measured.ring = drawn ? contrast(ring.slice(0, 3), inset ? background : around) : 0;
    }
    return measured;
  });
}
