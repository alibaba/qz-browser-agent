/**
 * Paint the sidebar from the window theme the way Firefox paints its own sidebar panels.
 *
 * theme.getCurrent() returns only a static theme's `theme` block. Firefox paints its
 * `dark_theme` block while the system is dark, and the sidebar document then matches
 * `prefers-color-scheme: dark`, because the sidebar follows the toolbar scheme. A dark
 * document with a light palette therefore shows a dark block this page cannot read, and the
 * dark variant is derived from the light block instead. Missing sidebar keys are derived from
 * the toolbar, tab, and frame keys. Every text color keeps 4.5:1 on its surface and a focus
 * ring keeps 3:1. Without theme colors the stylesheet's Firefox defaults apply, including
 * Firefox's own accent. The resolved colors then yield a primary fill, accent ink, and text
 * tiers that keep 4.5:1. This module never calls theme.update.
 */

/** The source properties a window theme writes on the sidebar root. */
export const FIREFOX_THEME_PROPERTIES = [
  "--qz-ff-sidebar", "--qz-ff-sidebar-text", "--qz-ff-sidebar-border",
  "--qz-ff-accent", "--qz-ff-accent-text", "--qz-ff-focus",
  "--qz-ff-field", "--qz-ff-field-text", "--qz-ff-field-border",
  "--qz-ff-popup", "--qz-ff-popup-text", "--qz-ff-popup-border",
] as const;

export type FirefoxThemeProperty = (typeof FIREFOX_THEME_PROPERTIES)[number];

const LIGHT_INK: Rgba = [251, 251, 254, 1];
const DARK_INK: Rgba = [21, 20, 26, 1];
/** Firefox's default sidebar surfaces, also declared by the stylesheet. */
const DEFAULT_SURFACE = { light: [255, 255, 255, 1] as Rgba, dark: [28, 27, 34, 1] as Rgba };
const TEXT_TARGET = 4.6;
const RING_TARGET = 3;
/** A derived dark surface is at most this luminous, near Firefox's own dark theme blocks. */
const DARK_SURFACE_LUMINANCE = 0.02;
/** A derived light text is at least this luminous, so body text reads well above 4.5:1. */
const LIGHT_TEXT_LUMINANCE = 0.8;
/** Ink keys from the most specific to the least, as Firefox falls back for its sidebar. */
const INK_KEYS = ["sidebar_text", "toolbar_text", "tab_text", "bookmark_text", "tab_background_text", "toolbar_field_text"] as const;

interface ThemeStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

interface AccentRoot {
  style: ThemeStyle;
  ownerDocument?: {
    defaultView: AccentView | null;
    createElement(tag: "span"): { style: { cssText: string; color: string }; remove(): void };
  } | null;
  appendChild?(node: unknown): unknown;
}

interface AccentView {
  getComputedStyle(element: unknown): { color: string; getPropertyValue(name: string): string };
  matchMedia?(query: string): { matches?: boolean; addEventListener?(type: "change", listener: () => void): void } | null;
  addEventListener?(type: "load" | "focus", listener: () => void, options?: { once?: boolean }): void;
}

interface ThemeUpdate {
  theme?: unknown;
  windowId?: number;
}

interface FirefoxThemeApi {
  getCurrent(windowId?: number): Promise<unknown> | unknown;
  onUpdated: { addListener(listener: (update: ThemeUpdate) => void): void };
}

interface FirefoxWindowApi {
  getCurrent(): Promise<{ id?: number } | undefined> | { id?: number } | undefined;
}

export interface FirefoxThemeChrome {
  theme?: FirefoxThemeApi;
  windows?: FirefoxWindowApi;
}

type Rgba = readonly [number, number, number, number];

/** Accept a theme color string or the schema's RGB array. Reject anything that is not a color. */
export function firefoxThemeColor(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > 80 || /[;{}]|url\s*\(/i.test(text)) return undefined;
    if (/^#[0-9a-f]{3,8}$/i.test(text)) return text;
    if (/^(?:rgb|hsl)a?\([^)]+\)$/i.test(text)) return text;
    if (/^[a-z]{3,20}$/i.test(text)) return text;
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  if (value.length === 3 && value.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    return `rgb(${value[0]}, ${value[1]}, ${value[2]})`;
  }
  if (value.length === 4 && value.slice(0, 3).every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255) && typeof value[3] === "number" && value[3] >= 0 && value[3] <= 1) {
    return `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]})`;
  }
  return undefined;
}

/** Parse hex, rgb(), hsl(), and computed color(srgb) into sRGB channels. Named colors stay unparsed. */
export function parseFirefoxThemeColor(color: string): Rgba | undefined {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].split("").map(digit => digit + digit).join("") : hex[1];
    const channel = (index: number) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) / 255 : 1];
  }
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/i.exec(color);
  if (srgb) {
    const parts = srgb[1].split(/\s*\/\s*|\s+/).filter(Boolean);
    const values = parts.map(part => fraction(part, 1));
    if (parts.length < 3 || parts.length > 4 || values.some(value => value === undefined)) return undefined;
    const [red, green, blue] = values.slice(0, 3).map(value => Math.round(clamp(value as number) * 255));
    return [red, green, blue, parts.length === 4 ? clamp(values[3] as number) : 1];
  }
  const fn = /^(rgb|hsl)a?\(\s*([^)]*)\)$/i.exec(color);
  if (!fn) return undefined;
  const parts = fn[2].split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const alpha = parts.length === 4 ? fraction(parts[3], 1) : 1;
  if (alpha === undefined) return undefined;
  if (fn[1].toLowerCase() === "rgb") {
    const channels = parts.slice(0, 3).map(part => fraction(part, 255));
    if (channels.some(channel => channel === undefined)) return undefined;
    const [red, green, blue] = channels.map(channel => Math.round(Math.min(1, Math.max(0, channel as number)) * 255));
    return [red, green, blue, clamp(alpha)];
  }
  const hue = Number.parseFloat(parts[0].replace(/deg$/i, ""));
  const saturation = percent(parts[1]);
  const lightness = percent(parts[2]);
  if (!Number.isFinite(hue) || saturation === undefined || lightness === undefined) return undefined;
  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  return [red, green, blue, clamp(alpha)];
}

function fraction(part: string, scale: number): number | undefined {
  if (part.endsWith("%")) return percent(part);
  const value = Number.parseFloat(part);
  return Number.isFinite(value) ? value / scale : undefined;
}

function percent(part: string): number | undefined {
  if (!part.endsWith("%")) return undefined;
  const value = Number.parseFloat(part);
  return Number.isFinite(value) ? clamp(value / 100) : undefined;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] = sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
      : sector < 3 ? [0, chroma, second]
        : sector < 4 ? [0, second, chroma]
          : sector < 5 ? [second, 0, chroma]
            : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return [red, green, blue].map(channel => Math.round((channel + offset) * 255)) as [number, number, number];
}

function relativeLuminance([red, green, blue]: Rgba): number {
  const linear = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** The ink with the higher WCAG contrast on an opaque surface. */
function legibleInk(surface: Rgba): Rgba {
  return contrast(LIGHT_INK, surface) >= contrast(DARK_INK, surface) ? LIGHT_INK : DARK_INK;
}

function contrast(first: Rgba, second: Rgba): number {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Mix toward black (amount > 0) or white (amount < 0) in sRGB, like color-mix(in srgb). */
function shade([red, green, blue]: Rgba, amount: number): Rgba {
  const target = amount >= 0 ? 0 : 255;
  const weight = Math.abs(amount);
  const channel = (value: number) => Math.round(value + (target - value) * weight);
  return [channel(red), channel(green), channel(blue), 1];
}

const PRIMARY_TARGET = 4.6;
const PRIMARY_HOVER = 0.12;
const PRIMARY_ACTIVE = 0.22;

export interface FirefoxPrimaryPalette { fill: Rgba; hover: Rgba; active: Rgba; ink: Rgba }

/**
 * The fill closest to the accent whose label keeps 4.5:1 at rest, hover, and active.
 * Hover and active darken the fill, so a light label is checked at rest and a dark label at active.
 */
export function firefoxPrimaryPalette(accent: Rgba, preferredInk?: Rgba): FirefoxPrimaryPalette {
  const inks: Rgba[] = [...(preferredInk ? [preferredInk] : []), [255, 255, 255, 1], [21, 20, 26, 1]];
  let best: { step: number; fill: Rgba; ink: Rgba } | undefined;
  for (const ink of inks) {
    const darkInk = relativeLuminance(ink) < relativeLuminance(accent);
    for (let step = 0; step <= 100; step += 1) {
      const fill = shade(accent, darkInk ? -step / 100 : step / 100);
      const hardest = darkInk ? shade(fill, PRIMARY_ACTIVE) : fill;
      if (contrast(ink, hardest) < PRIMARY_TARGET) continue;
      if (!best || step < best.step) best = { step, fill, ink };
      break;
    }
  }
  const { fill, ink } = best ?? { fill: shade(accent, 0.6), ink: [255, 255, 255, 1] as Rgba };
  return { fill, hover: shade(fill, PRIMARY_HOVER), active: shade(fill, PRIMARY_ACTIVE), ink };
}

/** `top` over `bottom` at `weight`, like color-mix(in srgb) or an alpha composite. */
function mix(top: Rgba, weight: number, bottom: Rgba): Rgba {
  const channel = (index: number) => Math.round(top[index] * weight + bottom[index] * (1 - weight));
  return [channel(0), channel(1), channel(2), 1];
}

/** The accent moved away from the surface until it reaches `target` on every ground. */
export function firefoxAccentInk(accent: Rgba, grounds: readonly Rgba[], target = PRIMARY_TARGET): Rgba {
  const toward = relativeLuminance(grounds[0]) > 0.18 ? 1 : -1;
  for (let step = 0; step <= 100; step += 1) {
    const ink = shade(accent, (toward * step) / 100);
    if (grounds.every(ground => contrast(ink, ground) >= target)) return ink;
  }
  return toward > 0 ? [0, 0, 0, 1] : [255, 255, 255, 1];
}

type TierSource = "sidebar" | "popup" | "field";

/**
 * Neutral text tiers: the stylesheet's share of the text over its surface, and the share of
 * the text in the darkest fill the tier sits on. The stylesheet declares the same shares.
 */
export const FIREFOX_TEXT_TIERS: readonly (readonly [string, TierSource, number, number])[] = [
  ["--qz-ff-text-deemphasized", "sidebar", 0.72, 0.14],
  ["--qz-ff-text-muted", "sidebar", 0.6, 0.12],
  ["--qz-ff-popup-text-deemphasized", "popup", 0.72, 0.06],
  ["--qz-ff-popup-text-muted", "popup", 0.6, 0.06],
  ["--qz-ff-field-text-deemphasized", "field", 0.72, 0.14],
  ["--qz-ff-field-placeholder", "field", 0.6, 0],
];

/** The smallest share of `text` at or above `share` that reads on the surface and on its fill. */
export function firefoxTextTier(text: Rgba, surface: Rgba, share: number, fillShare: number): Rgba {
  const fill = mix(text, fillShare, surface);
  for (let step = Math.round(share * 100); step <= 100; step += 1) {
    const ink = mix(text, step / 100, surface);
    if (contrast(ink, surface) >= PRIMARY_TARGET && contrast(ink, fill) >= PRIMARY_TARGET) return ink;
  }
  return mix(text, 1, surface);
}

/** Status inks the stylesheet fixes per scheme; the palette keeps them readable on a themed surface. */
const STATUS_PROPERTIES = ["--qz-ff-success", "--qz-ff-warning", "--qz-ff-critical"] as const;
const PALETTE_SOURCES = [
  "--qz-ff-accent", "--qz-ff-accent-text", "--qz-ff-sidebar", "--qz-ff-sidebar-text",
  "--qz-ff-popup", "--qz-ff-popup-text", "--qz-ff-field", "--qz-ff-field-text",
  ...STATUS_PROPERTIES,
] as const;
const PALETTE_PROPERTIES = [
  "--qz-ff-primary", "--qz-ff-primary-hover", "--qz-ff-primary-active", "--qz-ff-primary-text", "--qz-ff-accent-ink",
  ...FIREFOX_TEXT_TIERS.map(([property]) => property),
  ...STATUS_PROPERTIES,
];

function rgb([red, green, blue]: Rgba): string {
  return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * Resolve the accent, sidebar, popup, field, and status colors through the stylesheet, then
 * write the primary fill, accent ink, text tiers, and status inks that keep 4.5:1. Without a resolved accent and
 * sidebar the stylesheet's fallback stays.
 */
export function applyFirefoxPalette(root: AccentRoot): boolean {
  const document = root.ownerDocument;
  const view = document?.defaultView;
  if (!document || !view || typeof view.getComputedStyle !== "function" || typeof root.appendChild !== "function") return false;
  for (const property of PALETTE_PROPERTIES) root.style.removeProperty(property);
  if (!view.getComputedStyle(root).getPropertyValue("--qz-ff-accent").trim()) return false;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden";
  root.appendChild(probe);
  const colors = {} as Record<(typeof PALETTE_SOURCES)[number], Rgba | undefined>;
  for (const name of PALETTE_SOURCES) {
    probe.style.color = `var(${name})`;
    colors[name] = parseFirefoxThemeColor(view.getComputedStyle(probe).color);
  }
  probe.remove();
  const accent = colors["--qz-ff-accent"];
  const sidebarColor = colors["--qz-ff-sidebar"];
  const sidebarText = colors["--qz-ff-sidebar-text"];
  if (!accent || !sidebarColor || !sidebarText) return false;
  const sidebar: Rgba = [sidebarColor[0], sidebarColor[1], sidebarColor[2], 1];
  const palette = firefoxPrimaryPalette(accent, colors["--qz-ff-accent-text"]);
  root.style.setProperty("--qz-ff-primary", rgb(palette.fill));
  root.style.setProperty("--qz-ff-primary-hover", rgb(palette.hover));
  root.style.setProperty("--qz-ff-primary-active", rgb(palette.active));
  root.style.setProperty("--qz-ff-primary-text", rgb(palette.ink));
  root.style.setProperty("--qz-ff-accent-ink", rgb(firefoxAccentInk(accent, [sidebar, mix(sidebarText, 0.05, sidebar)])));
  const over = (color: Rgba | undefined) => (color ? mix(color, color[3], sidebar) : undefined);
  const pairs: Record<TierSource, [Rgba | undefined, Rgba | undefined]> = {
    sidebar: [sidebarText, sidebar],
    popup: [colors["--qz-ff-popup-text"], over(colors["--qz-ff-popup"])],
    field: [colors["--qz-ff-field-text"], over(colors["--qz-ff-field"])],
  };
  for (const [property, source, share, fillShare] of FIREFOX_TEXT_TIERS) {
    const [text, surface] = pairs[source];
    if (text && surface) root.style.setProperty(property, rgb(firefoxTextTier(text, surface, share, fillShare)));
  }
  for (const property of STATUS_PROPERTIES) {
    const status = colors[property];
    if (status) root.style.setProperty(property, rgb(firefoxAccentInk(status, [sidebar, mix(status, 0.12, sidebar)])));
  }
  return true;
}

type ThemeColors = Readonly<Partial<Record<string, Rgba>>>;

export interface FirefoxSidebarTheme {
  scheme: "light" | "dark";
  /** True when the colors are a dark variant derived from a light block. */
  derived: boolean;
  properties: Partial<Record<FirefoxThemeProperty, string>>;
}

/** Firefox's _isColorDark: perceived brightness at or below 127. */
function perceivedDark([red, green, blue]: Rgba): boolean {
  return 0.2125 * red + 0.7154 * green + 0.0721 * blue <= 127;
}

function opaque(color: Rgba): Rgba;
function opaque(color: Rgba | undefined): Rgba | undefined;
function opaque(color: Rgba | undefined): Rgba | undefined {
  return color ? [color[0], color[1], color[2], 1] : undefined;
}

function over(color: Rgba, ground: Rgba): Rgba {
  return mix(color, color[3], ground);
}

function css([red, green, blue, alpha]: Rgba): string {
  return alpha >= 1 ? rgb([red, green, blue, 1]) : `rgba(${red}, ${green}, ${blue}, ${Math.round(alpha * 1000) / 1000})`;
}

/** `color` composited on `ground`, moved away from it until it reaches `target`. */
function readable(color: Rgba, ground: Rgba, target: number): Rgba {
  return firefoxAccentInk(over(color, ground), [ground], target);
}

/** Shade toward black (`toward` 1) or white (-1) until `done` holds. */
function shadeUntil(color: Rgba, toward: 1 | -1, done: (color: Rgba) => boolean): Rgba {
  for (let step = 0; step <= 100; step += 1) {
    const next = shade(color, (toward * step) / 100);
    if (done(next)) return next;
  }
  return shade(color, toward);
}

function firstInk(colors: ThemeColors): Rgba | undefined {
  for (const key of INK_KEYS) if (colors[key]) return colors[key];
  return undefined;
}

/**
 * Firefox's toolbar scheme for a theme block: `color_scheme` when set, then an opaque
 * toolbar, the toolbar text, an opaque frame, and the tab text. A theme with none is light.
 */
export function firefoxThemeIsDark(colors: ThemeColors, colorScheme?: unknown): boolean {
  if (colorScheme === "dark") return true;
  if (colorScheme === "light") return false;
  if (colors.toolbar && colors.toolbar[3] >= 1) return perceivedDark(colors.toolbar);
  if (colors.toolbar_text) return !perceivedDark(colors.toolbar_text);
  if (colors.frame && colors.frame[3] >= 1) return perceivedDark(colors.frame);
  return colors.tab_background_text ? !perceivedDark(colors.tab_background_text) : false;
}

/**
 * The sidebar colors for a theme block. A dark document with a light block means Firefox paints
 * the theme's dark block, so the dark variant is derived; otherwise the block is painted.
 */
export function deriveFirefoxSidebarTheme(colors: ThemeColors, { dark = false, colorScheme }: { dark?: boolean; colorScheme?: unknown } = {}): FirefoxSidebarTheme {
  const themeDark = firefoxThemeIsDark(colors, colorScheme);
  return dark && !themeDark ? darkVariant(colors) : paintedVariant(colors, themeDark);
}

/**
 * Surface: sidebar, then the toolbar and the selected tab over the frame, then the frame.
 * Text: the most specific ink key. Fields and popups follow their own keys.
 */
function paintedVariant(colors: ThemeColors, themeDark: boolean): FirefoxSidebarTheme {
  const fallback = themeDark ? DEFAULT_SURFACE.dark : DEFAULT_SURFACE.light;
  const frame = opaque(colors.frame);
  const ground = frame ?? fallback;
  const layered = (color: Rgba | undefined) => (color ? over(color, ground) : undefined);
  const surface = opaque(colors.sidebar) ?? layered(colors.toolbar) ?? layered(colors.tab_selected) ?? frame ?? fallback;
  const properties: FirefoxSidebarTheme["properties"] = {
    "--qz-ff-sidebar": rgb(surface),
    "--qz-ff-sidebar-text": rgb(readable(firstInk(colors) ?? legibleInk(surface), surface, TEXT_TARGET)),
  };
  if (colors.sidebar_border) properties["--qz-ff-sidebar-border"] = css(colors.sidebar_border);
  writeAccent(properties, colors, surface);
  if (colors.toolbar_field) {
    const field = over(colors.toolbar_field, surface);
    properties["--qz-ff-field"] = css(colors.toolbar_field);
    properties["--qz-ff-field-text"] = rgb(readable(colors.toolbar_field_text ?? legibleInk(field), field, TEXT_TARGET));
  }
  if (colors.toolbar_field_border) properties["--qz-ff-field-border"] = css(colors.toolbar_field_border);
  if (colors.popup) {
    const popup = opaque(colors.popup);
    properties["--qz-ff-popup"] = rgb(popup);
    properties["--qz-ff-popup-text"] = rgb(readable(colors.popup_text ?? legibleInk(popup), popup, TEXT_TARGET));
  }
  if (colors.popup_border) properties["--qz-ff-popup-border"] = css(colors.popup_border);
  return { scheme: perceivedDark(surface) ? "dark" : "light", derived: false, properties };
}

/**
 * Firefox's dark blocks swap the light block's ink and ground: the light text becomes the
 * surface and the light frame becomes the text. Light fields, popups, and borders are dropped,
 * so the stylesheet derives them from the dark surface.
 */
function darkVariant(colors: ThemeColors): FirefoxSidebarTheme {
  const ink = firstInk(colors);
  const surface = ink ? shadeUntil(opaque(ink), 1, color => relativeLuminance(color) <= DARK_SURFACE_LUMINANCE) : DEFAULT_SURFACE.dark;
  const ground = opaque(colors.frame) ?? opaque(colors.sidebar) ?? opaque(colors.tab_selected) ?? opaque(colors.toolbar_field);
  const text = ground ? shadeUntil(ground, -1, color => relativeLuminance(color) >= LIGHT_TEXT_LUMINANCE) : LIGHT_INK;
  const properties: FirefoxSidebarTheme["properties"] = {
    "--qz-ff-sidebar": rgb(surface),
    "--qz-ff-sidebar-text": rgb(readable(text, surface, TEXT_TARGET)),
  };
  writeAccent(properties, colors, surface);
  return { scheme: "dark", derived: true, properties };
}

/** Firefox's own accent stays unless the theme names a sidebar highlight or a focus outline. */
function writeAccent(properties: FirefoxSidebarTheme["properties"], colors: ThemeColors, surface: Rgba): void {
  if (colors.sidebar_highlight) {
    const accent = over(colors.sidebar_highlight, surface);
    properties["--qz-ff-accent"] = rgb(accent);
    properties["--qz-ff-accent-text"] = rgb(colors.sidebar_highlight_text ? opaque(colors.sidebar_highlight_text) : legibleInk(accent));
  }
  if (colors.focus_outline) properties["--qz-ff-focus"] = rgb(readable(colors.focus_outline, surface, RING_TARGET));
}

function themeColors(theme: unknown): Record<string, unknown> | undefined {
  if (!theme || typeof theme !== "object") return undefined;
  const record = theme as { colors?: unknown; theme?: { colors?: unknown } };
  const colors = record.colors ?? record.theme?.colors;
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) return undefined;
  return colors as Record<string, unknown>;
}

function themeColorScheme(theme: unknown): unknown {
  if (!theme || typeof theme !== "object") return undefined;
  const record = theme as { properties?: { color_scheme?: unknown } | null; theme?: { properties?: { color_scheme?: unknown } | null } };
  return (record.properties ?? record.theme?.properties)?.color_scheme;
}

export interface FirefoxThemeOptions {
  /** Whether the sidebar document matches `prefers-color-scheme: dark`. */
  dark?: boolean;
  /** Parse a validated theme color. The sidebar also resolves named colors through the page. */
  resolve?: (color: string) => Rgba | undefined;
}

/** Write a theme's sidebar colors on the root. A theme without colors removes them. */
export function applyFirefoxTheme(root: { style: ThemeStyle }, theme: unknown, { dark = false, resolve = parseFirefoxThemeColor }: FirefoxThemeOptions = {}): boolean {
  const colors: Record<string, Rgba> = {};
  for (const [key, value] of Object.entries(themeColors(theme) ?? {})) {
    const color = firefoxThemeColor(value);
    const rgba = color ? resolve(color) : undefined;
    if (rgba) colors[key] = rgba;
  }
  const derived = Object.keys(colors).length ? deriveFirefoxSidebarTheme(colors, { dark, colorScheme: themeColorScheme(theme) }) : undefined;
  for (const property of FIREFOX_THEME_PROPERTIES) {
    const value = derived?.properties[property];
    if (value) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }
  if (derived) root.style.setProperty("color-scheme", derived.scheme);
  else root.style.removeProperty("color-scheme");
  return !!derived;
}

/** Resolve a named theme color through a probe element. */
function resolveThemeColor(root: AccentRoot, color: string): Rgba | undefined {
  const parsed = parseFirefoxThemeColor(color);
  if (parsed) return parsed;
  const document = root.ownerDocument;
  const view = document?.defaultView;
  if (!document || !view || typeof root.appendChild !== "function") return undefined;
  const probe = document.createElement("span");
  probe.style.color = color;
  if (!probe.style.color) return undefined;
  root.appendChild(probe);
  const resolved = parseFirefoxThemeColor(view.getComputedStyle(probe).color);
  probe.remove();
  return resolved;
}

/**
 * Follow the sidebar window's theme, and repaint when the stylesheet loads, the color scheme
 * flips, or the window regains focus. Themes without colors keep the stylesheet's defaults.
 */
export function installFirefoxTheme(chromeApi: FirefoxThemeChrome, root: AccentRoot): void {
  const view = root.ownerDocument?.defaultView;
  const scheme = view?.matchMedia?.("(prefers-color-scheme: dark)");
  let current: unknown;
  const paint = () => {
    applyFirefoxTheme(root, current, { dark: scheme?.matches === true, resolve: color => resolveThemeColor(root, color) });
    return applyFirefoxPalette(root);
  };
  if (view) {
    if (!paint()) view.addEventListener?.("load", () => { paint(); }, { once: true });
    scheme?.addEventListener?.("change", () => { paint(); });
    view.addEventListener?.("focus", () => { paint(); });
  }
  const theme = chromeApi.theme;
  if (!theme || typeof theme.getCurrent !== "function" || typeof theme.onUpdated?.addListener !== "function") return;
  const apply = (value: unknown) => {
    current = value;
    paint();
  };
  let windowId: number | undefined;
  let updates = 0;
  theme.onUpdated.addListener(update => {
    const target = update?.windowId;
    if (target != null && (windowId == null || target !== windowId)) return;
    updates += 1;
    apply(update?.theme);
  });
  const readWindow = chromeApi.windows?.getCurrent;
  const started = updates;
  const ready = typeof readWindow === "function"
    ? Promise.resolve(readWindow()).then(win => {
      if (typeof win?.id === "number") windowId = win.id;
      return theme.getCurrent(windowId);
    }, () => theme.getCurrent())
    : Promise.resolve(theme.getCurrent());
  ready.then(value => {
    if (updates === started) apply(value);
  }, () => {
    if (updates === started) apply(undefined);
  });
}
