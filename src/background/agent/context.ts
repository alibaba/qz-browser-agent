import { t } from "./prompts/messages.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import { normalizeMessageDocuments } from "../../shared/documents/document-attachments.js";
import { MESSAGE_KIND_CONTEXT_CAPSULE, MESSAGE_KIND_CONTEXT_EVENT, MESSAGE_ORIGIN_CONTEXT_CAPSULE,
  MESSAGE_ORIGIN_CONTEXT_EVENT } from "../../shared/message-blocks.js";
import { annotateSecurityGuardrailTab, annotateSecurityGuardrailTabs, matchBlockedUrl } from "../../shared/security-guardrails.js";
import { getSkillDisplayName } from "../../shared/skills/skill-utils.js";
import { throwIfCancelled } from "../internal/abortable.js";
import type { TabReference } from "../../shared/tab-utils.js";
import { isLocalFileUrl } from "../../shared/tab-utils.js";
import type { ModelMessage } from "../../shared/contracts/model-message.js";
import type { ContextReason } from "../../sdk/background/context.js";
import type { ContextCapsule, ContextDiagnostic } from "../context-sources.js";
import type { AgentServices } from "./services.js";

export interface ContextTab extends TabReference {
  readOnlyUsable?: boolean; securityGuardrailBlocked?: boolean; contentAccess?: string;
  ownedByCurrentTask?: boolean; ownerSessionId?: string;
}
export interface SiteSkill {
  name?: string; displayName?: string; description?: string; matchedDomain?: string; matchedPattern?: string; metadata?: unknown;
}
export interface GoalContext {
  status?: string; objective?: string; criteria?: string; progress?: string; next?: string;
  checkpoint?: string; version?: number; updatedAt?: string;
}
interface TrackerContext {
  title?: string; mode?: string; total?: number; current?: number; completed?: number;
  unit?: string; defaultUnit?: string; currentStep?: number; steps?: (string | { label?: string })[];
  note?: string; stats?: Record<string, unknown> | null;
}
interface SessionContext { id?: string; title?: string; running?: boolean; runId?: string; updatedAt?: string }
interface LocationContext { latitude?: number; longitude?: number; accuracy?: number; timestamp?: string | number }
/** Known browser facts are normalized here; unnamed capability values stay opaque to Agent. */
export interface DynamicContext extends Record<string, unknown> {
  now?: string; workingTab?: ContextTab | null; userVisibleTab?: ContextTab | null;
  tabs?: ContextTab[]; taskSiteTabs?: ContextTab[]; sourceWindowId?: number | string | null;
  pageTitle?: string; pageUrl?: string; selectionText?: string;
  securityGuardrailBlocked?: boolean; fileAccessAllowed?: boolean; contentAccess?: string; siteSkills?: SiteSkill[];
  sessions?: SessionContext[]; tracker?: TrackerContext; goal?: GoalContext | null; location?: LocationContext;
  sources?: readonly ContextCapsule[]; contextDiagnostics?: readonly ContextDiagnostic[];
}
export interface ContextReadRequest { reason: ContextReason; signal?: AbortSignal; runId: string }
export type DynamicContextProvider = (request: ContextReadRequest) => Promise<unknown>;
export interface GoalDeletedSnapshot { objective?: unknown; criteria?: unknown; progress?: unknown; version?: unknown }
interface ContextServices {
  getSecurityGuardrails: AgentServices['getSecurityGuardrails'];
  matchSiteSkillsForUrls: AgentServices['matchSiteSkillsForUrls'];
  readSelectedText(tabId?: number): Promise<string>;
}
const GOAL_CONTEXT_CAPSULE_REASON = "goal_snapshot";

function formatTrackerContextLines(tracker: TrackerContext = {}) {
  const lines = [];
  const title = String(tracker.title || "").trim();
  const mode = String(tracker.mode || "generic").trim();
  const total = Number(tracker.total);
  const current = Number(tracker.current);
  const completed = Number(tracker.completed);
  const unit = String(tracker.unit || tracker.defaultUnit || "").trim();
  if (title) lines.push(t("task", { value: title }));
  if (mode) lines.push(t("type", { value: trackerModeText(mode) }));
  if (Number.isFinite(total) && total > 0) {
    const value = mode === "steps"
      ? (Number.isFinite(completed) ? completed : 0)
      : Math.max(Number.isFinite(current) ? current : 0, Number.isFinite(completed) ? completed : 0);
    lines.push(t("progressCount", { value: Math.max(0, value), total, unit }));
  } else if (Number.isFinite(current) || Number.isFinite(completed)) {
    const value = Math.max(Number.isFinite(current) ? current : 0, Number.isFinite(completed) ? completed : 0);
    lines.push(t("processed", { value: Math.max(0, value), unit }));
  }
  if (Number.isFinite(Number(tracker.currentStep)) && Array.isArray(tracker.steps) && tracker.steps.length) {
    const index = Math.max(0, Math.min(tracker.steps.length - 1, Math.floor(Number(tracker.currentStep)) - 1));
    const step = tracker.steps[index];
    const label = typeof step === "string" ? step : step?.label;
    if (label) lines.push(t("currentStep", { value: label }));
  }
  if (tracker.note) lines.push(t("current", { value: String(tracker.note).slice(0, 200) }));
  if (tracker.stats && typeof tracker.stats === "object" && !Array.isArray(tracker.stats)) {
    const stats = Object.entries(tracker.stats)
      .slice(0, 6)
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(", ");
    if (stats) lines.push(t("statistics", { value: stats }));
  }
  return lines.length ? lines : [t("trackerEnabled")];
}

export function shouldExposeGoalContext(goal: GoalContext | null | undefined = null): goal is GoalContext {
  return Boolean(goal && typeof goal === "object" && ["active", "blocked", "paused"].includes(String(goal.status)));
}

function formatGoalContextLines(goal: GoalContext = {}) {
  const lines = [];
  const statusLabels: Record<string, string> = {
    active: t("active"),
    blocked: t("blocked"),
    paused: t("paused"),
  };
  const statusText = statusLabels[String(goal.status)] || t("active");
  lines.push(t("status", { value: statusText }));
  if (goal.objective) lines.push(t("objective", { value: String(goal.objective).slice(0, 240) }));
  if (goal.criteria) lines.push(t("criteria", { value: String(goal.criteria).slice(0, 360) }));
  if (goal.progress) lines.push(t("progress", { value: String(goal.progress).slice(0, 360) }));
  if (goal.next) lines.push(t("next", { value: String(goal.next).slice(0, 240) }));
  if (goal.checkpoint) lines.push(t("checkpoint", { value: String(goal.checkpoint).slice(0, 500) }));
  if (Number.isFinite(Number(goal.version))) lines.push(t("version", { value: Math.max(0, Math.floor(Number(goal.version))) }));
  return lines;
}

function goalContextSignature(goal: GoalContext = {}) {
  if (!shouldExposeGoalContext(goal)) return "";
  try {
    return JSON.stringify({
      status: goal.status || "",
      objective: goal.objective || "",
      criteria: goal.criteria || "",
      progress: goal.progress || "",
      next: goal.next || "",
      checkpoint: goal.checkpoint || "",
      version: Math.max(0, Math.floor(Number(goal.version) || 0)),
      updatedAt: goal.updatedAt || "",
    });
  } catch (_err) {
    return String(goal.version || goal.updatedAt || "");
  }
}

export function isGoalSnapshotCapsuleMessage(msg: Partial<ModelMessage> = {}) {
  return msg?._origin === MESSAGE_ORIGIN_CONTEXT_CAPSULE
    && msg?._kind === MESSAGE_KIND_CONTEXT_CAPSULE
    && record(msg?._contextCapsule).reason === GOAL_CONTEXT_CAPSULE_REASON;
}

function formatDynamicContextTab(tab: ContextTab = {}) {
  const suffix = tab.securityGuardrailBlocked ? t("pageBlocked") : "";
  return `[${tab.id ?? ""}${tab.tabAlias ? ` alias=${JSON.stringify(tab.tabAlias)}` : ""}] ${tab.title ?? ""} | ${tab.url ?? ""}${suffix}`;
}

function trackerModeText(mode = "") {
  switch (mode) {
    case "steps": return t("steps");
    case "pagination": return t("pagination");
    default: return t("generic");
  }
}


export function buildContextCapsuleMessage(dynamicContext: DynamicContext | null, reason = "prompt") {
  const contextText = formatDynamicContext(dynamicContext);
  if (!contextText) return null;
  return {
    role: "user",
    _origin: MESSAGE_ORIGIN_CONTEXT_CAPSULE,
    _kind: MESSAGE_KIND_CONTEXT_CAPSULE,
    _contextCapsule: {
      reason: String(reason || "prompt"),
      createdAt: nowBeijingDateTime(),
      signature: dynamicContextSignature(dynamicContext),
    },
    content: [
      t("contextCapsule"),
      t("contextReadOnly"),
      "",
      contextText,
    ].join("\n"),
  };
}


export function buildDocumentCapsuleMessage(documents: unknown[] = [], clientMessageId = "") {
  const normalized = normalizeMessageDocuments(documents);
  if (!normalized.length) return null;
  const lines = normalized.map((document, index) => (
    `${index + 1}. ${document.filename} | docModelId=${document.docModelId} | fileId=${document.fileId} | format=${document.format || "unknown"}`
  ));
  return {
    role: "user",
    _origin: MESSAGE_ORIGIN_CONTEXT_CAPSULE,
    _kind: MESSAGE_KIND_CONTEXT_CAPSULE,
    _contextCapsule: {
      reason: "document_attachment",
      createdAt: nowBeijingDateTime(),
      signature: `${String(clientMessageId || "").trim()}:${normalized.map(item => item.attachmentId).join(",")}`,
    },
    content: [
      t("documentCapsule"),
      t("documentReadOnly"),
      t("documentInstructions"),
      "",
      ...lines,
    ].join("\n"),
  };
}


export function buildGoalSnapshotCapsuleMessage(dynamicContext: DynamicContext | null = null, _reason = "goal_snapshot") {
  const goal = dynamicContext?.goal;
  if (!shouldExposeGoalContext(goal)) return null;
  const lines = formatGoalContextLines(goal);
  if (!lines.length) return null;
  return {
    role: "user",
    _origin: MESSAGE_ORIGIN_CONTEXT_CAPSULE,
    _kind: MESSAGE_KIND_CONTEXT_CAPSULE,
    _contextCapsule: {
      reason: GOAL_CONTEXT_CAPSULE_REASON,
      createdAt: nowBeijingDateTime(),
      signature: goalContextSignature(goal),
    },
    content: [
      t("goalCapsule"),
      t("goalReadOnly"),
      "",
      ...lines,
      "",
      t("goalRules"),
    ].join("\n"),
  };
}


export function buildGoalDeletedContextEventMessage(goal: GoalDeletedSnapshot | null = null) {
  if (!goal || typeof goal !== "object") return null;
  const objective = String(goal.objective || goal.criteria || goal.progress || t("currentGoal"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || t("currentGoal");
  return {
    role: "user",
    _origin: MESSAGE_ORIGIN_CONTEXT_EVENT,
    _kind: MESSAGE_KIND_CONTEXT_EVENT,
    _contextEvent: {
      kind: "goal_deleted",
      createdAt: nowBeijingDateTime(),
      objective,
      version: Math.max(0, Math.floor(Number(goal.version) || 0)),
    },
    content: [{
      type: "text",
      text: [
        t("goalEvent"),
        t("goalDeleted", { objective }),
        t("goalDeletedReadOnly"),
      ].join("\n"),
    }],
  };
}


export function formatGoalForCompaction(goal: GoalContext | null = null) {
  if (!shouldExposeGoalContext(goal)) return "";
  return [
    t("goalCompaction"),
    ...formatGoalContextLines(goal),
  ].join("\n");
}


export function formatDynamicContext(context: DynamicContext | null) {
  if (!context || typeof context !== "object") return "";
  const lines = [t("dynamicContext")];
  if (context.now) lines.push(t("systemTime", { value: context.now }));

  const working = context.workingTab;
  const visible = context.userVisibleTab;
  if (working) {
    lines.push(t("workingTab", { value: formatDynamicContextTab(working) }));
  } else {
    lines.push(t("noWorkingTab"));
  }
  if (!working && (context.pageTitle || context.pageUrl)) {
    const suffix = context.securityGuardrailBlocked ? t("pageBlocked") : "";
    lines.push(t("initialPage", { title: context.pageTitle ?? "", url: context.pageUrl ?? "", suffix }));
  }
  if (visible && (!working || Number(visible.id) !== Number(working.id))) {
    const ownership = visible.ownedByCurrentTask
      ? t("owned")
      : (visible.ownerSessionId ? t("foreignOwned", { id: visible.ownerSessionId }) : t("unowned"));
    const access = visible.readOnlyUsable === false ? "" : visible.ownerSessionId && !visible.ownedByCurrentTask
      ? t("readOnlyAccess")
      : t("useTabAccess");
    lines.push(t("visibleTab", { tab: formatDynamicContextTab(visible), ownership, access }));
  }

  if (Array.isArray(context.tabs) && context.tabs.length) {
    lines.push(t("taskTabs"));
    for (const tab of context.tabs) {
      lines.push(`  ${working?.id === tab.id ? "→" : " "} ${formatDynamicContextTab(tab)}`);
    }
  }

  if (Array.isArray(context.sessions) && context.sessions.length) {
    lines.push(t("recentSessions"));
    for (const session of context.sessions.slice(0, 20)) {
      const status = session.running ? "running" : "idle";
      const runId = session.runId ? ` runId=${session.runId}` : "";
      const updatedAt = session.updatedAt ? ` updatedAt=${session.updatedAt}` : "";
      lines.push(`  ${session.running ? "●" : "○"} [${session.id ?? ""}] ${status}${runId}${updatedAt} | ${session.title ?? ""}`);
    }
  }

  if (context.tracker) {
    lines.push(t("taskProgress"));
    for (const line of formatTrackerContextLines(context.tracker)) {
      lines.push(`- ${line}`);
    }
    lines.push(t("progressReadOnly"));
  }

  if (Array.isArray(context.siteSkills) && context.siteSkills.length) {
    lines.push(t("siteSkills"));
    for (const skill of context.siteSkills.slice(0, 5)) {
      const matched = [skill.matchedDomain, skill.matchedPattern].filter(Boolean).join(" ");
      const scope = matched ? ` (${matched})` : "";
      const displayName = getSkillDisplayName({ ...skill });
      const label = displayName && displayName !== skill.name ? t("skillLabel", { name: String(skill.name), displayName }) : skill.name;
      lines.push(`- ${label}${scope}: ${skill.description || ""}`);
      lines.push(t("fullProcedure", { name: JSON.stringify(skill.name) }));
    }
  }

  if (context.selectionText) {
    lines.push(t("selection"));
    lines.push(String(context.selectionText).slice(0, 4000));
  }

  if (context.location) {
    const loc = context.location;
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const accuracy = Number.isFinite(Number(loc.accuracy)) ? t("locationAccuracy", { value: Math.round(Number(loc.accuracy)) }) : "";
      const timestamp = loc.timestamp ? t("locationTime", { value: loc.timestamp }) : "";
      lines.push(t("location", { latitude: lat.toFixed(6), longitude: lon.toFixed(6), accuracy, timestamp }));
    }
  }

  for (const source of context.sources || []) {
    lines.push(t("source", { id: source.id, title: source.title }));
    lines.push(source.text);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}


export function buildSiteSkillContextEventMessage(previousSkills: SiteSkill[] = [], nextSkills: SiteSkill[] = [], toolName = "") {
  const delta = diffSiteSkills(previousSkills, nextSkills);
  if (!delta.added.length && !delta.removed.length) return null;
  const lines = [
    t("contextEvent"),
    t("siteSkillsUpdated"),
  ];
  if (delta.added.length) {
    lines.push(t("skillsAdded", { skills: delta.added.map(formatSiteSkillBrief).join(t("listSeparator")) }));
  }
  if (delta.removed.length) {
    lines.push(t("skillsRemoved", { skills: delta.removed.map(formatSiteSkillBrief).join(t("listSeparator")) }));
  }
  lines.push(t("skillsNextRequest"));
  return {
    role: "user",
    _origin: MESSAGE_ORIGIN_CONTEXT_EVENT,
    _kind: MESSAGE_KIND_CONTEXT_EVENT,
    _contextEvent: {
      kind: "site_skill_update",
      toolName: String(toolName || ""),
      createdAt: nowBeijingDateTime(),
      added: delta.added.map(skill => skill.name).filter(Boolean),
      removed: delta.removed.map(skill => skill.name).filter(Boolean),
    },
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

export function collectSiteSkillCandidateUrls(context: DynamicContext = {}) {
  const taskSites = Array.isArray(context.taskSiteTabs) ? context.taskSiteTabs : [];
  const candidates = [...taskSites];
  if (context.workingTab) candidates.push(context.workingTab);

  const urls = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate?.securityGuardrailBlocked || candidate?.contentAccess === "blocked") continue;
    const href = normalizeSiteSkillCandidateUrl(candidate);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

export function siteSkillSignature(skills: SiteSkill[] = []) {
  const names = new Set();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = String(skill?.name || "").trim().toLowerCase();
    if (name) names.add(name);
  }
  return [...names].sort().join("|");
}

function dynamicContextSignature(context: DynamicContext | null = {}) {
  const working = context?.workingTab || {};
  const visible = context?.userVisibleTab || {};
  const payload = {
    workingUrl: working.url || "",
    workingTitle: working.title || "",
    visibleUrl: visible.url || "",
    siteSkills: siteSkillSignature(context?.siteSkills),
    sources: context?.sources || [],
    selection: String(context?.selectionText || "").slice(0, 120),
    location: context?.location ? {
      latitude: context.location.latitude,
      longitude: context.location.longitude,
    } : null,
  };
  return stableJson(payload);
}

function diffSiteSkills(previousSkills: SiteSkill[] = [], nextSkills: SiteSkill[] = []) {
  const previousMap = siteSkillMap(previousSkills);
  const nextMap = siteSkillMap(nextSkills);
  const added = [];
  const removed = [];
  for (const [key, skill] of nextMap.entries()) {
    if (!previousMap.has(key)) added.push(skill);
  }
  for (const [key, skill] of previousMap.entries()) {
    if (!nextMap.has(key)) removed.push(skill);
  }
  return { added, removed };
}

function siteSkillMap(skills: SiteSkill[] = []) {
  const map = new Map<string, SiteSkill>();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const key = String(skill?.name || getSkillDisplayName({ ...skill }) || "").trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, skill);
  }
  return map;
}

function formatSiteSkillBrief(skill: SiteSkill = {}) {
  const displayName = getSkillDisplayName({ ...skill });
  const label = displayName && displayName !== skill.name ? t("skillLabel", { name: String(skill.name), displayName }) : String(skill.name || displayName || "skill");
  return skill.description ? `${label}: ${skill.description}` : label;
}

function normalizeSiteSkillCandidateUrl(candidate: ContextTab | string = {}) {
  const raw = typeof candidate === "string"
    ? candidate
    : candidate?.url || candidate?.pendingUrl || "";
  try {
    const url = new URL(String(raw || ""));
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch(_e) {
    return "";
  }
}

function stableJson(value: unknown) {
  try {
    return JSON.stringify(value, Object.keys(flattenObjectKeys(value)).sort());
  } catch(_err) {
    return "";
  }
}

function flattenObjectKeys(value: unknown, out: Record<string, boolean> = {}) {
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(value)) {
    out[key] = true;
    flattenObjectKeys(record(value)[key], out);
  }
  return out;
}


function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read-only collection carries one request identity across every asynchronous boundary.
 * Agent alone decides when a completed snapshot may enter the conversation. */
export async function collectDynamicContext(
  provider: DynamicContextProvider | null, request: ContextReadRequest, services: ContextServices,
): Promise<DynamicContext> {
  const context: DynamicContext = { now: nowBeijingDateTime() };
  Object.assign(context, await readContext(provider, request));
  try {
    const guardrails = await services.getSecurityGuardrails();
    if (context.tabs) context.tabs = annotateSecurityGuardrailTabs(context.tabs, guardrails);
    if (context.workingTab) context.workingTab = annotateSecurityGuardrailTab(context.workingTab, guardrails);
    if (context.pageUrl && matchBlockedUrl(context.pageUrl, guardrails)) {
      context.securityGuardrailBlocked = true;
      context.contentAccess = "blocked";
    }
  } catch {
    // Metadata remains useful if settings are unavailable; tool execution checks policy again.
  }
  throwIfCancelled(request.signal);
  const contextTab = context.workingTab;
  if (contextTab) {
    context.pageTitle = contextTab.title || context.pageTitle || "";
    context.pageUrl = contextTab.url || context.pageUrl || "";
    if (!contextTab.securityGuardrailBlocked && !(isLocalFileUrl(contextTab.url) && context.fileAccessAllowed === false)) {
      context.selectionText = String(await services.readSelectedText(contextTab.id ?? undefined) || "");
    } else {
      delete context.selectionText;
    }
  }
  throwIfCancelled(request.signal);
  const urls = collectSiteSkillCandidateUrls(context);
  if (urls.length) context.siteSkills = normalizeSiteSkills(await services.matchSiteSkillsForUrls(urls, { limit: 5 }));
  else delete context.siteSkills;
  throwIfCancelled(request.signal);
  return context;
}

export async function collectSiteSkillPreviewContext(provider: DynamicContextProvider | null, request: ContextReadRequest) {
  const context = await readContext(provider, request);
  if (!context) return null;
  if (context.workingTab) {
    context.pageTitle = context.workingTab.title || context.pageTitle || "";
    context.pageUrl = context.workingTab.url || context.pageUrl || "";
  }
  return context;
}

export async function collectToolRuntimeContext(
  provider: DynamicContextProvider | null, request: ContextReadRequest, snapshotWorking: ContextTab | null,
) {
  const live = await readContext(provider, request);
  const workingTab = live?.workingTab || snapshotWorking || null;
  const workingTabId = Number(workingTab?.id);
  return { workingTab, workingTabId: Number.isFinite(workingTabId) && workingTabId > 0 ? workingTabId : null };
}

async function readContext(provider: DynamicContextProvider | null, request: ContextReadRequest): Promise<DynamicContext | null> {
  throwIfCancelled(request.signal);
  if (!provider) return null;
  try {
    const value = await provider(request);
    throwIfCancelled(request.signal);
    return normalizeDynamicContext(value);
  } catch (error) {
    throwIfCancelled(request.signal);
    if (record(error).name === "AbortError" || record(error).code === "CONTEXT_SOURCE_REQUIRED") throw error;
    // Optional sources may fail; only tool targeting can fall back to the run's own snapshot.
    return null;
  }
}

/** Drop malformed known fields; preserve unnamed capability payloads without interpreting them. */
export function normalizeDynamicContext(value: unknown): DynamicContext {
  const source = record(value);
  const extra = { ...source };
  for (const key of ["now", "workingTab", "userVisibleTab", "tabs", "taskSiteTabs", "sourceWindowId", "pageTitle", "pageUrl",
    "selectionText", "securityGuardrailBlocked", "fileAccessAllowed", "contentAccess", "siteSkills", "sessions", "tracker", "goal", "location", "sources", "contextDiagnostics"]) delete extra[key];
  const context: DynamicContext = {
    ...extra,
    ...textFields(source, ["now", "pageTitle", "pageUrl", "selectionText", "contentAccess"]),
    ...booleanFields(source, ["securityGuardrailBlocked", "fileAccessAllowed"]),
  };
  if (source.sourceWindowId === null || typeof source.sourceWindowId === "string" || typeof source.sourceWindowId === "number") context.sourceWindowId = source.sourceWindowId;
  for (const key of ["workingTab", "userVisibleTab"] as const) {
    if (source[key] === null) context[key] = null;
    else if (isRecord(source[key])) context[key] = normalizeContextTab(source[key]);
  }
  for (const key of ["tabs", "taskSiteTabs"] as const) {
    if (Array.isArray(source[key])) context[key] = source[key].filter(isRecord).map(normalizeContextTab);
  }
  if (Array.isArray(source.siteSkills)) context.siteSkills = normalizeSiteSkills(source.siteSkills);
  if (Array.isArray(source.sessions)) context.sessions = source.sessions.filter(isRecord).map(session => ({
    ...textFields(session, ["id", "title", "runId", "updatedAt"]), ...booleanFields(session, ["running"]),
  }));
  if (source.goal === null) context.goal = null;
  else if (isRecord(source.goal)) context.goal = {
    ...textFields(source.goal, ["status", "objective", "criteria", "progress", "next", "checkpoint", "updatedAt"]),
    ...numberFields(source.goal, ["version"]),
  };
  if (isRecord(source.tracker)) {
    const tracker = source.tracker;
    context.tracker = { ...textFields(tracker, ["title", "mode", "unit", "defaultUnit", "note"]),
      ...numberFields(tracker, ["total", "current", "completed", "currentStep"]),
      ...(isRecord(tracker.stats) ? { stats: { ...tracker.stats } } : {}),
      ...(Array.isArray(tracker.steps) ? { steps: tracker.steps.flatMap<string | { label?: string }>(step => typeof step === "string" ? [step] : isRecord(step) ? [textFields(step, ["label"])] : []) } : {}),
    };
  }
  if (isRecord(source.location)) context.location = {
    ...numberFields(source.location, ["latitude", "longitude", "accuracy"]),
    ...(typeof source.location.timestamp === "string" || typeof source.location.timestamp === "number" ? { timestamp: source.location.timestamp } : {}),
  };
  if (Array.isArray(source.sources)) context.sources = source.sources.filter(isRecord).flatMap(item =>
    typeof item.id === "string" && typeof item.title === "string" && typeof item.text === "string"
      ? [{ id: item.id, title: item.title, text: item.text }] : []);
  if (Array.isArray(source.contextDiagnostics)) context.contextDiagnostics = source.contextDiagnostics.filter(isRecord).flatMap(item =>
    typeof item.sourceId === "string" && typeof item.code === "string" ? [{ sourceId: item.sourceId, code: item.code }] : []);
  return context;
}

function normalizeContextTab(tab: Record<string, unknown>): ContextTab {
  return { ...textFields(tab, ["url", "pendingUrl", "title", "ownerSessionId", "contentAccess"]),
    ...numberFields(tab, ["id", "windowId"]),
    ...booleanFields(tab, ["active", "pinned", "readOnlyUsable", "securityGuardrailBlocked", "ownedByCurrentTask"]),
  };
}
export function normalizeSiteSkills(value: unknown): SiteSkill[] {
  return Array.isArray(value) ? value.filter(isRecord).map(skill => ({ ...textFields(skill, ["name", "displayName", "description", "matchedDomain", "matchedPattern"]), ...(skill.metadata == null ? {} : { metadata: skill.metadata }) })) : [];
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function textFields<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) { const value = source[key]; if (typeof value === "string") result[key] = value; }
  return result;
}
function numberFields<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = source[key];
    if ((typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value))) result[key] = Number(value);
  }
  return result;
}
function booleanFields<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, boolean>> {
  const result: Partial<Record<K, boolean>> = {};
  for (const key of keys) { const value = source[key]; if (typeof value === "boolean") result[key] = value; }
  return result;
}
