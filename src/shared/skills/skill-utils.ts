import { base64ToBytes } from '../bytes.js';
export { bytesToBase64 as encodeSkillResourceBytes } from '../bytes.js';

type Data = Record<string, unknown>;
export interface SkillResource extends Data {
  path: string; type: string; title: string; description: string;
  content?: string; encoding?: string; mimeType?: string; size?: number;
}
export interface SkillMetadata extends Data { qingzhou?: Data }
export interface SkillRecord extends Data {
  builtin?: unknown; readOnly?: unknown; source?: unknown;
  name: string; displayName: string; description: string; content: string; metadata: SkillMetadata;
  scope: string; status: string; domains: string[]; urlPatterns: string[]; excludePatterns: string[];
  resources: SkillResource[]; format: string; schemaVersion: number; createdAt: unknown; updatedAt: unknown;
}
interface SkillTarget { href: string; host: string; path: string; pathWithSearch: string }
type SiteSkillMatch = SkillRecord & { matchScore: number; matchedDomain?: string; matchedPattern?: string };
const objectInput = (value: unknown): Data => value && typeof value === "object" ? value as Data : {};

export const SKILL_SCOPE_GLOBAL = "global";
export const SKILL_SCOPE_SITE = "site";
export const SKILL_SCOPE_RESIDENT = "resident";
export const QINGZHOU_SKILL_FORMAT = "qingzhou.skill";
export const QINGZHOU_SKILL_SCHEMA_VERSION = 2;
export const QINGZHOU_SKILL_METADATA_KEY = "qingzhou";
export const SKILL_RESOURCE_ENCODING_BASE64 = "base64";

const SKILL_DOCUMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

const AGENT_SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CONSECUTIVE_HYPHENS_RE = /--/;

export function normalizeSkill(input: unknown = {}): SkillRecord {
  const skill = objectInput(input);
  const metadata = normalizeSkillMetadata(skill.metadata);
  const identity = normalizeSkillIdentity(skill, metadata);
  const rawScope = String(skill.scope || SKILL_SCOPE_GLOBAL).trim().toLowerCase();
  const scope = [SKILL_SCOPE_GLOBAL, SKILL_SCOPE_SITE, SKILL_SCOPE_RESIDENT].includes(rawScope)
    ? rawScope
    : SKILL_SCOPE_GLOBAL;
  return {
    ...skill,
    name: identity.name,
    displayName: identity.displayName,
    description: String(skill.description || "").trim(),
    content: String(skill.content || ""),
    metadata: identity.metadata,
    scope,
    status: String(skill.status || "active").trim().toLowerCase() || "active",
    domains: normalizeStringList(skill.domains),
    urlPatterns: normalizeStringList(skill.urlPatterns),
    excludePatterns: normalizeStringList(skill.excludePatterns),
    resources: normalizeSkillResources(skill.resources),
    format: String(skill.format || "").trim(),
    schemaVersion: Number(skill.schemaVersion || 0) || 0,
    createdAt: skill.createdAt || "",
    updatedAt: skill.updatedAt || "",
  };
}

export function normalizeModernSkill(skill: unknown = {}) {
  return normalizeSkill({
    ...objectInput(skill),
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  });
}

export function isValidAgentSkillName(value: unknown = "") {
  const name = String(value || "").trim();
  return AGENT_SKILL_NAME_RE.test(name) && !CONSECUTIVE_HYPHENS_RE.test(name);
}

export function toAgentSkillName(value: unknown = "", fallback = "skill") {
  const raw = String(value || "").trim();
  const fallbackSlug = skillSlug(fallback) || "skill";
  const slug = skillSlug(raw);
  const hasNonAscii = /[^\x00-\x7F]/.test(raw);
  if (slug && isValidAgentSkillName(slug) && !hasNonAscii) return slug;
  // Reserve the full hash suffix before truncating the already-normalized, nonempty slug.
  const suffix = `-${shortSkillHash(raw || fallbackSlug)}`;
  const stem = (slug || fallbackSlug).slice(0, 64 - suffix.length).replace(/-+$/g, "");
  return `${stem}${suffix}`;
}

export function getSkillDisplayName(skill: Data = {}) {
  const metadata = normalizeSkillMetadata(skill.metadata);
  const qingzhou = metadata[QINGZHOU_SKILL_METADATA_KEY] || {};
  return String(
    metadata.displayName
      || qingzhou.displayName
      || skill.displayName
      || skill.name
      || "",
  ).trim();
}

export function skillMatchesName(skill: Data = {}, name = "") {
  const target = normalizeSkillLookup(name);
  if (!target) return false;
  const canonicalTarget = normalizeSkillLookup(toAgentSkillName(name));
  return skillLookupAliases(skill).some(alias => {
    const normalizedAlias = normalizeSkillLookup(alias);
    return normalizedAlias === target || normalizedAlias === canonicalTarget;
  });
}

export function skillLookupAliases(skill: Data = {}) {
  const normalized = normalizeSkill(skill);
  return [
    normalized.name,
    getSkillDisplayName(normalized),
  ].filter(Boolean);
}

/** Storage replacement matches identity only, never display names or lookup aliases. */
export function skillEntriesByIdentity(skills: Data, name: string) {
  const target = normalizeSkillLookup(name);
  if (!target) return [];
  return Object.entries(skills)
    .filter(([key, skill]) => normalizeSkillLookup(key) === target || normalizeSkillLookup(objectInput(skill).name) === target)
    .map(([key, skill]) => ({ key, skill: objectInput(skill) }));
}

export function normalizeSkillLookup(value: unknown = "") {
  return String(value || "").toLowerCase().replace(/[-_\s]/g, "");
}

export function normalizeSkillMetadata(value: unknown = {}): SkillMetadata {
  const metadata: SkillMetadata = clonePlainObject(value);
  const qingzhou = clonePlainObject(metadata[QINGZHOU_SKILL_METADATA_KEY]);
  if (Object.keys(qingzhou).length) metadata[QINGZHOU_SKILL_METADATA_KEY] = qingzhou;
  return metadata;
}

export function isModernSkillRecord(skill: unknown = {}) {
  const normalized = normalizeSkill(skill);
  return normalized.format === QINGZHOU_SKILL_FORMAT
    && normalized.schemaVersion >= QINGZHOU_SKILL_SCHEMA_VERSION;
}

export function modernSkillValuesFromRecord(skills: Data = {}) {
  return Object.values(skills || {})
    .filter(isModernSkillRecord)
    .map(normalizeSkill);
}

export function normalizeSkillResources(value: unknown): SkillResource[] {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((raw): SkillResource | null => {
      const item = objectInput(raw);
      const path = normalizeSkillResourcePath(item?.path);
      if (!path) return null;
      const type = String(item?.type || inferSkillResourceType(path)).trim().toLowerCase() || "asset";
      const content = normalizeSkillResourceContent(item?.content);
      const encoding = String(item?.encoding || "").trim().toLowerCase() === SKILL_RESOURCE_ENCODING_BASE64
        ? SKILL_RESOURCE_ENCODING_BASE64
        : "";
      const mimeType = String(item?.mimeType || inferSkillResourceMimeType(path)).trim().toLowerCase();
      const size = Number(item?.size);
      const resource: SkillResource = {
        ...item,
        path,
        type,
        title: String(item?.title || resourceTitleFromPath(path)).trim(),
        description: String(item?.description || "").trim(),
        ...(content !== undefined ? { content } : {}),
      };
      if (content === undefined) delete resource.content;
      if (encoding) resource.encoding = encoding;
      else delete resource.encoding;
      if (mimeType) resource.mimeType = mimeType;
      else delete resource.mimeType;
      if (Number.isFinite(size) && size >= 0) resource.size = Math.floor(size);
      else delete resource.size;
      return resource;
    })
    .filter((resource): resource is SkillResource => resource !== null);
}

export function normalizeSkillResourcePath(value: unknown = "") {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

export function normalizeSkillResourceContent(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_err) {
    return String(value);
  }
}

export function isSkillDocumentResource(value: unknown = {}) {
  const resource: Data = typeof value === "string" ? { path: value } : objectInput(value);
  const extension = skillResourceExtension(resource.path);
  const mimeType = String(resource.mimeType || "").toLowerCase();
  return Boolean(SKILL_DOCUMENT_MIME_BY_EXTENSION[extension])
    || mimeType.includes("wordprocessingml")
    || mimeType.includes("spreadsheetml")
    || mimeType.includes("pdf");
}

export function inferSkillResourceMimeType(path: unknown = "") {
  return SKILL_DOCUMENT_MIME_BY_EXTENSION[skillResourceExtension(path)] || "";
}

export function isBase64SkillResource(resource: Partial<SkillResource> = {}) {
  return String(resource?.encoding || "").trim().toLowerCase() === SKILL_RESOURCE_ENCODING_BASE64;
}

export function decodeSkillResourceBytes(resource: Partial<SkillResource> = {}) {
  if (!isBase64SkillResource(resource)) return new TextEncoder().encode(String(resource?.content || ""));
  return base64ToBytes(resource?.content);
}

export function skillResourceByteSize(resource: Partial<SkillResource> = {}) {
  if (isBase64SkillResource(resource)) return decodeSkillResourceBytes(resource).byteLength;
  if (typeof resource?.content === "string") return new TextEncoder().encode(resource.content).byteLength;
  const declared = Number(resource?.size);
  return Number.isFinite(declared) && declared >= 0 ? Math.floor(declared) : 0;
}

export function inferSkillResourceType(path: unknown = "") {
  const clean = String(path || "").toLowerCase().split("?")[0].split("#")[0];
  if (clean.endsWith(".js") || clean.endsWith(".mjs")) return "script";
  if (clean.endsWith(".json")) return "json";
  if (clean.endsWith(".md") || clean.endsWith(".markdown")) return "markdown";
  return "asset";
}

function resourceTitleFromPath(path: unknown = "") {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || path;
}

function skillResourceExtension(path: unknown = "") {
  const clean = String(path || "").toLowerCase().split(/[?#]/, 1)[0];
  const basename = clean.split(/[\\/]/).pop() || "";
  return basename.includes(".") ? basename.split(".").pop() || "" : "";
}

function normalizeSkillIdentity(skill: Data = {}, metadata: SkillMetadata = {}) {
  const rawName = String(skill.name || "").trim();
  const rawDisplayName = String(
    metadata.displayName
      || metadata[QINGZHOU_SKILL_METADATA_KEY]?.displayName
      || skill.displayName
      || "",
  ).trim();
  const basis = rawName || rawDisplayName;
  const name = basis ? (isValidAgentSkillName(basis) ? basis : toAgentSkillName(basis)) : "";
  const displayName = rawDisplayName || (rawName && rawName !== name ? rawName : name);
  const nextMetadata = normalizeSkillMetadata(metadata);
  if (nextMetadata[QINGZHOU_SKILL_METADATA_KEY]?.displayName) {
    delete nextMetadata[QINGZHOU_SKILL_METADATA_KEY].displayName;
    if (!Object.keys(nextMetadata[QINGZHOU_SKILL_METADATA_KEY]).length) {
      delete nextMetadata[QINGZHOU_SKILL_METADATA_KEY];
    }
  }
  if (displayName && displayName !== name) {
    nextMetadata.displayName = displayName;
  } else {
    delete nextMetadata.displayName;
  }
  return { name, displayName, metadata: nextMetadata };
}

function skillSlug(value: unknown = "") {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function shortSkillHash(value: unknown = "") {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

function clonePlainObject(value: unknown = {}): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return {};
  }
}

export function normalizeStringList(value: unknown) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function matchSiteSkills(skills: unknown, url: unknown, { limit = 3 } = {}): SiteSkillMatch[] {
  const target = parseTargetUrl(url);
  if (!target) return [];
  const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 3)));
  return (Array.isArray(skills) ? skills : [])
    .map(normalizeSkill)
    .map(skill => ({ skill, match: matchSiteSkill(skill, target) }))
    .filter(item => item.match.matched)
    .sort((a, b) => b.match.score - a.match.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, max)
	    .map(item => ({
	      ...item.skill,
	      matchScore: item.match.score,
	      matchedDomain: item.match.domain,
	      matchedPattern: item.match.pattern,
	    }));
}

export function matchSiteSkillsForUrls(skills: unknown, urls: unknown, { limit = 5 } = {}) {
  const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 5)));
  const byName = new Map<string, SiteSkillMatch & { matchedUrl: string; matchedUrls: string[] }>();
  const candidates = Array.isArray(urls) ? urls : [urls];

  for (const url of candidates) {
    const href = normalizeMatchUrl(url);
    if (!href) continue;
    for (const skill of matchSiteSkills(skills, href, { limit: 20 })) {
      const key = skill.name;
      const previous = byName.get(key);
      const matchedUrls = [...(previous?.matchedUrls || []), href].filter(Boolean);
      const uniqueMatchedUrls = [...new Set(matchedUrls)].slice(0, 3);
      if (!previous || Number(skill.matchScore || 0) > Number(previous.matchScore || 0)) {
        byName.set(key, {
          ...skill,
          matchedUrl: href,
          matchedUrls: uniqueMatchedUrls,
        });
      } else {
        previous.matchedUrls = uniqueMatchedUrls;
      }
    }
  }

  return [...byName.values()]
    .sort((a, b) => Number(b.matchScore || 0) - Number(a.matchScore || 0) || a.name.localeCompare(b.name))
    .slice(0, max);
}

export function matchesSkillSearch(skill: unknown, query: unknown) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const normalized = normalizeSkill(skill);
  const haystack = [
    normalized.name,
    getSkillDisplayName(normalized),
    normalized.description,
    normalized.scope,
    ...normalized.domains,
    ...normalized.urlPatterns,
    ...normalized.excludePatterns,
    ...normalized.resources.map(resource => `${resource.path} ${resource.title} ${resource.description}`),
  ].join("\n").toLowerCase();
  return haystack.includes(q);
}

function matchSiteSkill(skill: SkillRecord, target: SkillTarget) {
  if (skill.scope !== SKILL_SCOPE_SITE || skill.status === "disabled") return { matched: false, score: 0 };
  const domain = matchDomain(skill.domains, target.host);
  if (!domain) return { matched: false, score: 0 };
  const excluded = skill.excludePatterns.some(pattern => patternMatches(pattern, target));
  if (excluded) return { matched: false, score: 0 };

  let pattern = "";
  let patternScore = 0;
  if (skill.urlPatterns.length === 0) {
    patternScore = 5;
  } else {
    pattern = skill.urlPatterns.find(item => patternMatches(item, target)) || "";
    if (!pattern) return { matched: false, score: 0 };
    patternScore = 20 + Math.min(30, pattern.length);
  }

  return {
    matched: true,
    domain,
    pattern,
    score: domain.length + patternScore,
  };
}

function parseTargetUrl(value: unknown): SkillTarget | null {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/i.test(url.protocol)) return null;
    return {
      href: url.href,
      host: url.hostname.toLowerCase(),
      path: url.pathname || "/",
      pathWithSearch: `${url.pathname || "/"}${url.search || ""}`,
    };
  } catch(_e) {
    return null;
  }
}

function normalizeMatchUrl(value: unknown = "") {
  const target = parseTargetUrl(value);
  return target?.href || "";
}

function matchDomain(domains: unknown, host: string) {
  const normalizedHost = String(host || "").toLowerCase();
  const candidates = normalizeStringList(domains).map(domain => domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  for (const domain of candidates.sort((a, b) => b.length - a.length)) {
    const clean = domain.replace(/^\*\./, "").replace(/^\./, "");
    if (!clean) continue;
    if (normalizedHost === clean || normalizedHost.endsWith(`.${clean}`)) return domain;
  }
  return "";
}

function patternMatches(pattern: string, target: SkillTarget) {
  const text = String(pattern || "").trim();
  if (!text) return false;
  if (text.startsWith("regex:")) return safeRegexTest(text.slice(6), target.href);
  if (text.startsWith("/") && text.endsWith("/") && text.length > 2) return safeRegexTest(text.slice(1, -1), target.href);
  if (text.includes("*")) return wildcardMatches(text, target);
  return target.href.includes(text) || target.pathWithSearch.includes(text) || target.path.includes(text);
}

function safeRegexTest(source: string, value: string) {
  try {
    return new RegExp(source).test(value);
  } catch(_e) {
    return false;
  }
}

function wildcardMatches(pattern: string, target: SkillTarget) {
  const escaped = pattern
    .split("*")
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return safeRegexTest(`^${escaped}$`, target.href) || safeRegexTest(`^${escaped}$`, target.pathWithSearch);
}
