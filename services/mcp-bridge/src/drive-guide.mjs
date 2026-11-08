import { readFileSync } from "node:fs";

const MARKER_START = "<!-- qz-drive-guide:en -->";
const MARKER_END = "<!-- qz-drive-guide:end -->";
const candidates = [
  new URL("./qz-drive-SKILL.md", import.meta.url),
  new URL("../../../skills/qz-browser-agent/SKILL.md", import.meta.url),
];

let cached = "";

function loadGuideSource() {
  if (cached) return cached;
  const errors = [];
  for (const url of candidates) {
    try {
      cached = readFileSync(url, "utf8");
      return cached;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      errors.push(url.pathname);
    }
  }
  throw new Error(`direct-drive guide is missing. Looked in ${errors.join(", ")}.`);
}

/** Read the direct-drive usage guide. */
export function driveGuide() {
  const text = loadGuideSource();
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END, start + MARKER_START.length);
  if (start < 0 || end < 0) throw new Error("direct-drive guide content is missing.");
  return `${text.slice(start + MARKER_START.length, end).trim()}\n`;
}

export function resetDriveGuideCache() {
  cached = "";
}
