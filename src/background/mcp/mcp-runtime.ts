import { isToolFailure, toolError } from "../../shared/contracts/tool-error.js";
import { bindToolResultPresentation, getToolResultPresentation, presentToolResult, toolFailurePresentation, type ToolResultPresentation } from "../../shared/contracts/tool-result-presentation.js";
import { scriptReceipt, SCRIPT_API_VERSION } from "../../shared/contracts/script-receipt.js";
import { createSessionUserInput } from "../session/user-input.js";
import { productText } from "../../shared/product-text.js";
import { parseBeijingDateTime } from "../../shared/time-utils.js";
import { driveToolText } from "./tool-messages.js";
import { publicSessionObservation, type SessionRuntimeObservation } from "../../shared/contracts/session-observation.js";
import { t } from "../../shared/i18n/backend.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import {
  createExternalDriveCoordinator,
  driveToolSignature,
  isDriveToolDiscoverable,
  isDriveToolForbidden,
  parseDriveRequest,
  prepareDriveToolCall,
  projectDriveResult,
  getDriveToolTraces,
  runDriveCalls,
  type DriveToolObservation,
} from "./external-drive.js";
import { summarizeSessionUsage } from "../../shared/session/session-usage.js";
import type { createSessionCommands } from "../session/commands.js";
import type { createSessionAgentHost } from "../session/agent-host.js";
import type { createSessionRuntimeState } from "../session/runtime-state.js";
import type { createSessionTranscript } from "../session/transcript.js";
import type { createSessionArtifacts } from "../session/artifacts.js";
import type { createSessionSupervisor } from "../session/supervisor.js";
import type { createSkillDocumentResourceService } from "../skills/skill-document-resources.js";
import type { Agent } from "../agent/agent.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import { normalizeDriveClientName } from "../../shared/session/session-store.js";
import type { SkillRecord, SkillResource } from "../../shared/skills/skill-utils.js";
import type { RunProfile } from "../agent/run-profile.js";
import type { ToolBatchTabPolicy, ToolModelPolicy } from "../../shared/contracts/tool.js";
import type { ToolContext } from "../../sdk/background.js";
import type { ResponsePort } from "../transports/sidepanel.js";
type Fields = Record<string, unknown>;
type Commands = ReturnType<typeof createSessionCommands>;
type Host = ReturnType<typeof createSessionAgentHost>;
type Runtime = ReturnType<typeof createSessionRuntimeState>;
type Transcript = ReturnType<typeof createSessionTranscript>;
type Artifacts = ReturnType<typeof createSessionArtifacts>;
interface McpSessionPort {
  normalizeId(value: unknown): string; requireId(value: unknown, operation: string): string;
  supervisor: Pick<ReturnType<typeof createSessionSupervisor<Agent>>, "resolveUserWait" | "rejectUserWait" | "isRunCurrent" | "getUserWait" | "mintDriveRunId" | "clearDriveRunId" | "takeDriveRunForRelease">;
  submitMessage: Commands["submitSessionMessageRuntime"]; waitForRunObserved: Commands["waitForSessionRunObserved"];
  getRuntimeOutput: Commands["getSessionRuntimeStateForOutput"]; getRuntime: Commands["getSessionRuntimeState"];
  getLiveAgentEntry: Host["getLiveEntry"]; getAgent: Host["getAgent"]; setRuntime: Runtime["set"];
  getLastMessages: Commands["getLastMessagesRuntime"]; getTranscript: Transcript["get"]; getConversation: Transcript["getConversation"];
  listMetadata(): Promise<Record<string, SessionMetadata>>; compactTranscriptEvent: Commands["compactTranscriptEvent"];
  recordToolEvent?(event: Fields): void;
  persistTranscript?(sessionId: string): Promise<unknown>;
  createMetadata?(input: Fields): Promise<unknown>;
  stop?(sessionId: string, meta?: Fields, signal?: AbortSignal): Promise<unknown>;
  getStoredRuntime?(sessionId: string): Fields | null;
}
interface McpToolsPort {
  ready?: Promise<unknown> | ((reason: string) => Promise<unknown>);
  canManageSessions(id: string): Promise<boolean>;
  buildRunProfile(input: { sessionId: string; canManageSessions: boolean; externalDrive?: boolean }): Promise<RunProfile> | RunProfile;
  loadedSkillNames: Runtime["loadedSkillNames"]; recordLoadedSkillNames: Runtime["recordLoadedSkillNames"];
  runtime: {
    getSchemas(options: { runProfile: RunProfile; context: ToolContext; loadedPluginSkillNames: string[] }): { type: string; function: { name: string; description: string; parameters: object } }[];
    execute(name: string, args: Fields, signal: AbortSignal | undefined, context: ToolContext): Promise<unknown>;
    getModelPolicy?(name: string): ToolModelPolicy | null | undefined;
    getBatchTabPolicy?(name: string, args: unknown): ToolBatchTabPolicy | null;
    getTabAliases?(sessionId: string): Record<string, number>;
    getToolResultPageContext?(result: unknown): Fields;
    commitToolResult?(result: unknown, signal: AbortSignal, context: ToolContext): Promise<unknown>;
    discardToolResult?(result: unknown, context: ToolContext): Promise<unknown>;
  };
}
interface McpSkillsPort {
  list(): Promise<SkillRecord[]>; load(name: string): Promise<SkillRecord | null>;
  getDisplayName(skill: Partial<SkillRecord>): string; normalizeResourcePath(value: unknown): string;
  loadDocumentResource?: ReturnType<typeof createSkillDocumentResourceService>["load"];
}
interface McpOptions {
  sessions: McpSessionPort; tools: McpToolsPort; skills: McpSkillsPort;
  artifacts: Pick<Artifacts, "collect" | "empty">; trace: { get(): Promise<readonly unknown[]> };
  dispatchSidepanel(message: Fields, port: ResponsePort): Promise<unknown>;
  storageKey?(): string;
  driveIdleMs?: number;
  onDriveSettled?(): Promise<unknown>;
  userInputPermissions: Pick<Parameters<typeof createSessionUserInput>[0], "hasBrowserPermission" | "locationConsent">;
}
import {
  isBase64SkillResource,
  isSkillDocumentResource,
  skillResourceByteSize,
} from "../../shared/skills/skill-utils.js";

const getSkillRuntimeGuidance = () => ([
  productText(
    "Skill 运行环境是轻舟 Chrome 浏览器扩展，不是 Node.js，也不是服务器。",
    "Skill 运行环境是轻舟 Firefox 浏览器扩展，不是 Node.js，也不是服务器。",
  ),
  "Skill content 描述浏览器操作 SOP；资源文件承载 plugin.json、scripts、references、模板或示例。",
  "资源内容请用 get_skill_resource(name,path) 按需读取；get_skill 默认只返回资源清单。",
  "DOCX、XLSX、PDF 资源会解析为 document model，并返回首块预览与 docModelId。",
].join("\n"));

/** Business commands used by the MCP transport and shared Background API. */
export function createMcpRuntime({
  sessions,
  tools,
  skills,
  artifacts,
  trace,
  dispatchSidepanel,
  userInputPermissions,
  storageKey = () => "",
  driveIdleMs,
  onDriveSettled = async () => {},
}: McpOptions) {
  if (typeof dispatchSidepanel !== "function") throw new TypeError("dispatchSidepanel is required");

  async function waitForToolsReady(reason: string) {
    try {
      const ready = typeof tools.ready === "function" ? tools.ready(reason) : tools.ready;
      await ready;
    } catch (_error) {
      // Core tools remain usable when optional Skill discovery is unavailable.
    }
  }

  function describe() {
    return {
      protocolVersion: 1,
      scriptApiVersion: SCRIPT_API_VERSION,
      storageKey: storageKey(),
      methods: [
        "ping", "capabilities", "get_bridge_config", "save_bridge_config", "runtime_message",
        "list_sessions", "create_session", "create_drive_session", "list_drive_sessions", "get_drive_session", "send_message", "follow_up", "continue_task",
        "submit_wait_form", "cancel_wait", "get_user_input", "respond_to_user_input", "get_session_state", "get_session_snapshot",
        "get_messages", "get_history", "stop_session", "clear_goal", "list_tools", "get_tool",
        "execute_tool", "list_data_tables", "list_skills", "get_skill", "get_skill_resource",
        "delete_data_table", "export_data_table", "list_image_collections", "delete_image_collection", "export_image_collection",
        "list_downloads", "export_skill", "get_settings", "update_settings",
        "get_config", "save_config", "get_runtime_config", "set_runtime_config", "list_plugins",
        "refresh_skill_registry", "list_automations", "run_automation", "get_trace", "clear_trace",
      ],
    };
  }

  async function dispatchRuntimeMessage(message: Fields = {}, options: Fields = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const requestId = String(message.requestId || options.requestId || randomRequestId());
    const responses: Fields[] = [];
    const port = {
      name: "mcp_bridge",
      signal,
      postMessage(response: unknown) {
        responses.push(plainObject(response));
      },
    };
    await dispatchSidepanel({ ...message, requestId }, port);
    const expectedTypes = normalizeExpectedTypes(options.expectedTypes || options.expectedType);
    const response = expectedTypes.length
      ? responses.find(item => expectedTypes.includes(String(item?.type || "")))
      : responses.at(-1);
    return { requestId, response: response || null, responses };
  }

  const userInput = createSessionUserInput({
    getWait: sessions.supervisor.getUserWait,
    getRuntime: sessions.getRuntime,
    resolve: sessions.supervisor.resolveUserWait,
    reject: sessions.supervisor.rejectUserWait,
    ...userInputPermissions,
  });

  const drive = createExternalDriveCoordinator({
    ...(driveIdleMs == null ? {} : { idleMs: driveIdleMs }),
    stop: (sessionId, meta) => sessions.stop?.(sessionId, meta || {}),
    getRuntime: sessionId => readRuntime(sessionId),
    setRuntime: (sessionId, patch) => sessions.setRuntime(sessionId, patch),
    mintRunId: sessionId => sessions.supervisor.mintDriveRunId(sessionId),
    takeRunId: sessionId => sessions.supervisor.takeDriveRunForRelease(sessionId),
  });

  function readRuntime(sessionId: string): Fields {
    const stored = sessionId ? sessions.getStoredRuntime?.(sessionId) : null;
    if (stored && typeof stored === "object") return stored;
    const runtime = sessionId ? sessions.getRuntime(sessionId) : null;
    return runtime && typeof runtime === "object" ? runtime as Fields : {};
  }

  function driveTabId(value: unknown) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function toolContext(sessionId: string, runId: string, runProfile: RunProfile, params: Fields, runtime: Fields): ToolContext {
    const loadedNames = tools.loadedSkillNames(sessionId, params.loadedPluginSkillNames || []);
    const dynamicContext = { ...plainObject(params.dynamicContext, {}) };
    dynamicContext.workingTab = runtime.workingTab || null;
    dynamicContext.pageUrl = runtime.workingUrl || "";
    dynamicContext.taskSiteTabs = runtime.visitedTaskSites || [];
    return {
      sessionId,
      runId,
      workingTabId: Number(runtime.workingTabId) || null,
      runProfile,
      source: "mcp_bridge",
      dynamicContext,
      loadedPluginSkillNames: loadedNames,
    };
  }

  function refreshDriveContext(base: Fields): Fields {
    const sessionId = String(base.sessionId || "");
    const runtime = readRuntime(sessionId);
    const dynamic = plainObject(base.dynamicContext);
    return {
      ...base,
      sessionId,
      runId: String(base.runId || ""),
      workingTabId: driveTabId(runtime.workingTabId),
      dynamicContext: {
        ...dynamic,
        workingTab: runtime.workingTab ?? null,
        pageUrl: String(runtime.workingUrl ?? ""),
        taskSiteTabs: Array.isArray(runtime.visitedTaskSites) ? runtime.visitedTaskSites : [],
      },
    };
  }

  async function sendMessage(params: Fields = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const sessionId = sessions.requireId(params.sessionId, "send_message");
    if (params.steer !== undefined && typeof params.steer !== "boolean") {
      throw Object.assign(new Error("steer must be a boolean."), { code: "INVALID_ARGUMENTS" });
    }
    const deliveryMode = params.steer === true ? "steer" : "follow_up";
    const text = String(params.text || params.message || "").trim();
    const images = Array.isArray(params.images) ? params.images : [];
    const documents = Array.isArray(params.documents) ? params.documents : [];
    if (!text && !images.length && !documents.length) throw new Error("send_message requires text or attachments");
    const acceptedHook = params.onMessageAccepted;
    const clientMessageId = String(params.clientMessageId || randomRequestId());
    const taskInfo = await sessions.submitMessage({
      sessionId,
      text,
      images,
      documents,
      sourceWindowId: typeof params.sourceWindowId === "number" ? params.sourceWindowId : null,
      clientMessageId,
      deliveryMode,
      onMessageAccepted: typeof acceptedHook === "function" ? acceptedHook as NonNullable<NonNullable<Parameters<Commands["submitSessionMessageRuntime"]>[0]>["onMessageAccepted"]> : null,
      swallowErrors: params.swallowErrors !== false,
    }, signal);
    const started = taskInfo.disposition === "started";
    if (params.wait === true && started) {
      await taskInfo.promise;
    } else if (started && params.waitForStart !== false) {
      await sessions.waitForRunObserved(sessionId, taskInfo, Number(params.waitForStartMs ?? 2000));
    }
    return sessions.getRuntimeOutput(sessionId, runtime => ({
      accepted: true,
      sessionId,
      clientMessageId,
      deliveryMode,
      disposition: taskInfo.disposition,
      wait: params.wait === true && started,
      waitForStart: started && params.wait !== true && params.waitForStart !== false,
      runtime: describeSessionRuntime(runtime),
      input: userInput.get({ sessionId }),
    }));
  }

  async function getState(sessionId: unknown) {
    const id = sessions.normalizeId(sessionId);
    const entry = id ? await sessions.getLiveAgentEntry(id) : null;
    const agent = entry?.agent;
    if (!agent) {
      return sessions.getRuntimeOutput(id, runtime => ({
        sessionId: id,
        isStreaming: !!runtime.running,
        runId: runtime.runId,
        hasHistory: false,
        status: runtime.status,
        runtime: describeSessionRuntime(runtime),
        input: userInput.get({ sessionId: id }),
      }));
    }
    const contextRunId = agent.getRunState().runId;
    const contextState = await agent.getContextUsageState();
    return sessions.getRuntimeOutput(id, current => {
      const observed = entry.agent?.getRunState();
      const sameRun = entry.agent === agent && observed && observed.runId === current.runId;
      const liveState = sameRun ? observed : { isStreaming: !!current.running, runId: current.runId, hasHistory: !!observed?.hasHistory };
      const contextCurrent = sameRun && observed.runId === contextRunId;
      if (contextCurrent && contextState.inputTokensEstimate) sessions.setRuntime(id, contextState);
      const runtime = contextCurrent ? { ...current, ...contextState } : current;
      return {
        sessionId: id,
        ...liveState,
        runId: runtime.runId || liveState.runId || null,
        status: runtime.status,
        runtime: describeSessionRuntime(runtime),
        input: userInput.get({ sessionId: id }),
      };
    });
  }

  async function getMessages(sessionId: unknown, options: Fields = {}) {
    const id = sessions.normalizeId(sessionId);
    if (options.tail === true || options.compact === true || options.num) {
      return sessions.getLastMessages({ sessionId: id, num: options.num || 20 });
    }
    const agent = await sessions.getAgent(id);
    const conversation = agent.exportSession();
    const transcript = await sessions.getTranscript(id, conversation);
    return { sessionId: id, session: conversation, transcript };
  }

  async function getSnapshot(sessionId: unknown, options: Fields = {}) {
    const id = sessions.normalizeId(sessionId);
    const [metadata, state] = await Promise.all([sessions.listMetadata(), getState(id)]);
    const entry = await sessions.getLiveAgentEntry(id);
    const agent = entry?.agent;
    const conversation = agent
      ? agent.exportSession()
      : await sessions.getConversation(id).catch(() => null);
    const transcript = await sessions.getTranscript(id, conversation).catch(() => []);
    const usage = summarizeSessionUsage({ conversation, transcript });
    const compact = options.compact !== false;
    const rendered = compact ? transcript.map(sessions.compactTranscriptEvent) : transcript;
    const limit = clampNumber(options.num || options.tailCount, 1, 200, 50);
    const sessionArtifacts = options.includeArtifacts === false
      ? artifacts.empty()
      : await artifacts.collect(id, transcript);
    const runtime = state.runtime || (await sessions.getRuntimeOutput(id));
    const snapshot: Fields = {
      sessionId: id,
      session: metadata[id] ? publicSessionObservation(id, metadata[id].title?.trim() || t("session.new"),
        String(state.status || state.runtime?.status || "idle")) : null,
      state,
      runtime,
      input: state.input,
      isStreaming: !!state.isStreaming,
      status: state.status || state.runtime?.status || "",
      runId: state.runId || state.runtime?.runId || null,
      hasHistory: !!state.hasHistory || transcript.length > 0,
      transcriptTotal: transcript.length,
      transcript: options.tail === true ? rendered.slice(-limit) : rendered,
      tail: rendered.slice(-limit),
      tailCount: Math.min(rendered.length, limit),
      compact,
      artifacts: sessionArtifacts,
      usage,
    };
    if (options.includeTools === true) {
      const listed = await listTools({ sessionId: id, dynamicContext: options.dynamicContext || {} });
      snapshot.tools = listed.tools;
      snapshot.toolCount = listed.tools.length;
    }
    if (options.includeTrace === true) {
      const traceLimit = clampNumber(options.traceLimit, 1, 200, 40);
      snapshot.trace = (await trace.get())
        .filter(line => String(line || "").includes(id))
        .slice(-traceLimit);
    }
    return snapshot;
  }

  async function toolCatalog(params: Fields, reason: string) {
    await waitForToolsReady(reason);
    const selected = params.sessionId == null ? null : await requireToolSession(params.sessionId);
    const sessionId = selected?.sessionId || "";
    const canManageSessions = selected ? await tools.canManageSessions(sessionId) : false;
    const externalDrive = !selected || selected.metadata.source === "external-drive";
    const runProfile = await tools.buildRunProfile({ sessionId, canManageSessions, externalDrive });
    const runtime = selected ? sessions.getRuntime(sessionId) : null;
    const loadedNames = selected ? tools.loadedSkillNames(sessionId, params.loadedPluginSkillNames || []) : [];
    const schemas = tools.runtime.getSchemas({
      runProfile,
      context: {
        externalDrive,
        dynamicContext: plainObject(params.dynamicContext),
        workingTab: runtime?.workingTab || null,
        pageUrl: String(runtime?.workingUrl || ""),
        taskSiteTabs: runtime?.visitedTaskSites || [],
        loadedPluginSkillNames: loadedNames,
      },
      loadedPluginSkillNames: loadedNames,
    });
    const catalog = schemas.map(schema => ({
      name: schema.function?.name || "",
      description: schema.function?.description || "",
      parameters: schema.function?.parameters || {},
      type: schema.type || "function",
    })).filter(tool => tool.name && (!externalDrive || isDriveToolDiscoverable(tool.name)));
    return { sessionId, externalDrive, tools: catalog };
  }

  async function listTools(params: Fields = {}) {
    const catalog = await toolCatalog(params, "mcp_list_tools");
    return {
      sessionId: catalog.sessionId,
      tools: catalog.externalDrive
        ? catalog.tools.map(driveToolSignature)
        : catalog.tools,
    };
  }

  async function getTool(params: Fields = {}) {
    const name = String(params.name || params.toolName || "").trim();
    const catalog = await toolCatalog(params, "mcp_get_tool");
    if (catalog.externalDrive && isDriveToolForbidden(name)) {
      throw Object.assign(new Error(driveToolText("unavailable")), { code: "DRIVE_TOOL_FORBIDDEN" });
    }
    const found = catalog.tools.find(tool => tool.name === name) || null;
    return found && catalog.externalDrive ? driveToolSignature(found) : found;
  }

  function rememberLoadedSkill(sessionId: string, name: string, result: unknown) {
    if (name !== "load_skill" || !result || typeof result !== "object" || plainObject(result).error) return;
    const value = plainObject(result);
    tools.recordLoadedSkillNames(sessionId, [value.name, value.displayName]);
  }

  async function ensureDriveSession(sessionId: string, title: string, clientName: unknown) {
    if (!sessionId) return "";
    const metadata = await sessions.listMetadata();
    const existing = metadata[sessionId];
    if (existing) {
      if (String(existing.source || "") !== "external-drive") {
        throw Object.assign(new Error(t("drive.sessionOccupied")), { code: "DRIVE_SESSION_OCCUPIED" });
      }
      if (existing.driveRetentionPending === true) throw Object.assign(new Error(t("drive.sessionEnded")), { code: "DRIVE_SESSION_ENDED" });
      drive.assertActive(sessionId);
      return "external-drive";
    }
    if (!sessions.createMetadata) return "";
    await sessions.createMetadata({
      id: sessionId, title, titleSource: "fixed", source: "external-drive",
      driveClientName: normalizeDriveClientName(clientName), firstMessage: "",
    });
    const created = await sessions.listMetadata();
    if (String(created[sessionId]?.source || "") !== "external-drive") {
      throw Object.assign(new Error(t("drive.sessionOccupied")), { code: "DRIVE_SESSION_OCCUPIED" });
    }
    return "external-drive";
  }

  async function requireToolSession(value: unknown) {
    // Do not use the runtime normalizer: missing IDs must never select "default".
    const sessionId = typeof value === "string" ? value.trim() : "";
    if (!sessionId) {
      throw Object.assign(new Error(t("drive.sessionRequired")), { code: "DRIVE_SESSION_REQUIRED" });
    }
    const metadata = (await sessions.listMetadata())[sessionId];
    if (!metadata) {
      throw Object.assign(new Error(t("drive.sessionNotFound")), { code: "DRIVE_SESSION_NOT_FOUND" });
    }
    if (metadata.driveRetentionPending === true) {
      throw Object.assign(new Error(t("drive.sessionEnded")), { code: "DRIVE_SESSION_ENDED" });
    }
    return { sessionId, metadata };
  }

  async function createDriveSession(params: Fields = {}) {
    const title = typeof params.title === "string" ? params.title.replace(/\s+/gu, " ").trim() : "";
    if (!title) throw Object.assign(new Error(t("session.titleRequired")), {
      code: "SESSION_TITLE_REQUIRED", hint: 'Run qz session create --title "Task title".',
    });
    const requested = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    const sessionId = requested || crypto.randomUUID().replaceAll("-", "");
    const release = drive.protect(sessionId);
    try {
      const source = await ensureDriveSession(sessionId, title, params.clientName);
      if (source !== "external-drive") {
        throw Object.assign(new Error(t("drive.sessionOccupied")), { code: "DRIVE_SESSION_OCCUPIED" });
      }
      sessions.setRuntime(sessionId, { driveLastActivityAt: Date.now() });
      drive.restore(sessionId, Date.now());
      const created = (await sessions.listMetadata())[sessionId];
      return publicSessionObservation(sessionId, String(created?.title || title), String(readRuntime(sessionId).status || "idle"));
    } finally { release(); void onDriveSettled(); }
  }

  async function restoreDriveSessions() {
    for (const [sessionId, metadata] of Object.entries(await sessions.listMetadata())) {
      if (metadata.source !== "external-drive" || metadata.driveRetentionPending === true) continue;
      const runtime = readRuntime(sessionId);
      drive.restore(sessionId, Number(runtime.driveLastActivityAt)
        || parseBeijingDateTime(runtime.updatedAt || metadata.createdAt) || Date.now());
    }
  }

  async function listDriveSessions(params: Fields = {}) {
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 200));
    const entries = Object.entries(await sessions.listMetadata())
      .filter(([, metadata]) => metadata.source === "external-drive" && metadata.driveRetentionPending !== true)
      .sort(([, left], [, right]) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, limit);
    return { sessions: entries.map(([id, metadata]) => publicSessionObservation(id, String(metadata.title || ""),
      String(readRuntime(id).status || "idle"))) };
  }

  async function getDriveSession(params: Fields = {}) {
    const id = sessions.requireId(params.sessionId, "get_drive_session");
    const metadata = (await sessions.listMetadata())[id];
    if (!metadata || metadata.source !== "external-drive" || metadata.driveRetentionPending === true) {
      throw Object.assign(new Error(t("drive.sessionNotFound")), { code: "DRIVE_SESSION_NOT_FOUND" });
    }
    return publicSessionObservation(id, String(metadata.title || ""), String(readRuntime(id).status || "idle"));
  }

  function recordDriveTool(input: DriveToolObservation, images: { mimeType: string; data: string }[] = [], rawResult: unknown = input.result) {
    const { sessionId, runId, name, args, result, isError } = input;
    if (!sessions.recordToolEvent || !drive.hasActiveLease(sessionId) || !sessions.supervisor.isRunCurrent(sessionId, runId)) return false;
    // Only the host supplies transcript identities; client correlation IDs stay separate.
    const toolCallId = input.toolCallId || crypto.randomUUID();
    if (input.phase === "start") {
      sessions.recordToolEvent({ type: "tool_execution_start", sessionId, runId, toolCallId,
        spanId: `tool:${toolCallId}`, parentSpanId: input.parentSpanId,
        toolName: name, args, startedExecution: input.startedExecution });
      return true;
    }
    sessions.recordToolEvent({
      type: "tool_execution_end", sessionId, runId, toolCallId, spanId: `tool:${toolCallId}`, parentSpanId: input.parentSpanId,
      toolName: name, args, result: driveTranscriptResult(result, images, {
        ...tools.runtime.getToolResultPageContext?.(rawResult), ...getToolResultPresentation(rawResult), ...input.resultPresentation,
      }), isError,
    });
    return true;
  }

  async function recordNestedTool(input: DriveToolObservation) {
    if (input.phase === "start") {
      if (recordDriveTool(input)) await sessions.persistTranscript?.(input.sessionId);
      return;
    }
    const projected = projectDriveResult(input.result, tools.runtime.getModelPolicy?.(input.name), input.resultPresentation);
    if (!recordDriveTool({ ...input, result: projected.value }, projected.images, input.result)) return;
    if (!input.isError) rememberLoadedSkill(input.sessionId, input.name, input.result);
    await sessions.persistTranscript?.(input.sessionId);
  }

  async function executeTool(params: Fields = {}, signal?: AbortSignal) {
    const release = drive.protect(typeof params.sessionId === "string" ? params.sessionId.trim() : "");
    try { return await executeToolRequest(params, signal); }
    finally { release(); void onDriveSettled(); }
  }

  async function executeToolRequest(params: Fields = {}, signal?: AbortSignal) {
    const language = getLanguage();
    const parsed = parseDriveRequest(params);
    if (!parsed.ok) throw parsed.error;
    const callsScript = parsed.mode === "single" ? parsed.name === "run_script" : parsed.calls.some(call => call.name === "run_script");
    if (callsScript && params.scriptApiVersion !== SCRIPT_API_VERSION) {
      throw toolError("UPGRADE_REQUIRED", "The CLI and extension use incompatible script APIs. No script was executed.", {
        hint: "Update the CLI and extension together, then reconnect before running the script.",
      });
    }
    signal?.throwIfAborted();
    const { sessionId, metadata } = await requireToolSession(params.sessionId);
    if (metadata.source !== "external-drive") {
      throw Object.assign(new Error(t("drive.sessionOccupied")), { code: "DRIVE_SESSION_OCCUPIED" });
    }
    drive.assertActive(sessionId);
    const source = metadata.source;
    signal?.throwIfAborted();
    await waitForToolsReady("mcp_execute_tool");
    signal?.throwIfAborted();
    const canManageSessions = await tools.canManageSessions(sessionId);
    signal?.throwIfAborted();
    const runProfile = await tools.buildRunProfile({ sessionId, canManageSessions, externalDrive: source === "external-drive" });
    signal?.throwIfAborted();
    const leased = source === "external-drive";
    let lease: { signal: AbortSignal; driveRunId: string; release(): void } | null = null;
    let timeoutSignal: AbortSignal | null = null;
    let notedDriveTools = false;
    let runId = "";
    const noteDriveTool = (name: string, args: unknown, result: unknown, isError: boolean, images: { mimeType: string; data: string }[] = [], rawResult: unknown = result, resultPresentation?: ToolResultPresentation, toolCallId?: string) => {
      if (recordDriveTool({ sessionId, runId, name, args: plainObject(args), result, isError, resultPresentation, toolCallId }, images, rawResult)) notedDriveTools = true;
    };
    try {
      lease = leased ? drive.begin(sessionId, signal) : null;
      const runtime = readRuntime(sessionId);
      runId = leased ? String(lease?.driveRunId || "") : "";
      const context = { ...toolContext(sessionId, runId, runProfile, params, runtime), language, externalDrive: source === "external-drive" };
      timeoutSignal = parsed.timeoutSeconds
        ? AbortSignal.timeout(parsed.timeoutSeconds * 1000)
        : null;
      const baseSignal = lease?.signal || signal;
      const callSignal = timeoutSignal && baseSignal
        ? AbortSignal.any([baseSignal, timeoutSignal])
        : timeoutSignal || baseSignal;
      const aliases = tools.runtime.getTabAliases?.(sessionId) || {};
      if (parsed.mode === "single") {
        const name = parsed.name;
        const toolCallId = crypto.randomUUID();
        const resultPresentation: ToolResultPresentation = {};
        const policy = tools.runtime.getModelPolicy?.(name);
        try {
          const prepared = prepareDriveToolCall(name, params.args);
          if (!prepared.ok) throw prepared.error;
          const result = await settleDriveCall(tools.runtime.execute(name, prepared.args, callSignal, { ...context, toolCallId, spanId: `tool:${toolCallId}`, resultPresentation }), callSignal);
          signal?.throwIfAborted();
          callSignal?.throwIfAborted();
          rememberLoadedSkill(sessionId, name, result);
          const projected = projectDriveResult(result, policy, resultPresentation);
          const isError = isToolFailure(result);
          const presentation = isError ? toolFailurePresentation(result, resultPresentation) : resultPresentation;
          const traces = getDriveToolTraces(result, presentation, isError);
          noteDriveTool(name, prepared.args, projected.value, isError, projected.images, result, presentation, toolCallId);
          if (policy?.scriptResult) return {
            toolName: name, sessionId, runId: runId || null, isError, scriptApiVersion: SCRIPT_API_VERSION,
            result: scriptReceipt(result, { format: policy.scriptResult, isError, presentation }),
            ...(projected.images.length ? { images: projected.images } : {}),
          };
          const body = { toolName: name, sessionId, runId: runId || null, result: projected.value, isError };
          return { ...body, ...(projected.images.length ? { images: projected.images } : {}), ...(traces.length ? { traces } : {}) };
        } catch (error) {
          const presentation = toolFailurePresentation(error, resultPresentation);
          bindToolResultPresentation(error, presentation);
          noteDriveTool(name, params.args, driveToolFailure(error), true, [], error, presentation, toolCallId);
          if (policy?.scriptResult) return {
            toolName: name, sessionId, runId: runId || null, isError: true, scriptApiVersion: SCRIPT_API_VERSION,
            result: scriptReceipt(driveToolFailure(error), { format: policy.scriptResult, isError: true, presentation }),
          };
          throw error;
        }
      }
      const batch = await settleDriveCall(runDriveCalls(parsed.calls, {
        execute: (name, args, batchSignal, batchContext) => tools.runtime.execute(name, plainObject(args), batchSignal, batchContext as ToolContext),
        getBatchTabPolicy: (name, args) => tools.runtime.getBatchTabPolicy?.(name, args) ?? null,
        getModelPolicy: name => tools.runtime.getModelPolicy?.(name) ?? null,
        commitToolResult: tools.runtime.commitToolResult
          ? (result, commitSignal, commitContext) => tools.runtime.commitToolResult!(result, commitSignal, commitContext as ToolContext)
          : undefined,
        discardToolResult: tools.runtime.discardToolResult
          ? (result, discardContext) => tools.runtime.discardToolResult!(result, discardContext as ToolContext)
          : undefined,
        aliases: tools.runtime.getTabAliases?.(sessionId) || {},
        context,
        refreshContext: refreshDriveContext,
        onSettled: call => noteDriveTool(call.name, call.args, call.result, call.isError, call.images, call.rawResult, call.resultPresentation, call.toolCallId),
        signal: callSignal ?? new AbortController().signal,
        maxInFlight: parsed.maxCalls,
      }), callSignal);
      signal?.throwIfAborted();
      callSignal?.throwIfAborted();
      for (const item of batch.results) if (!item.isError) rememberLoadedSkill(sessionId, item.name, item.result);
      return { sessionId, runId: runId || null, results: batch.results };
    } catch (error) {
      if (timeoutSignal?.aborted && !signal?.aborted) {
        throw Object.assign(new Error(t("drive.batchTimeout")), { code: "DRIVE_BATCH_TIMEOUT" });
      }
      throw error;
    } finally {
      if (notedDriveTools && sessionId && typeof sessions.persistTranscript === "function") {
        try { await sessions.persistTranscript(sessionId); }
        catch (error) { console.warn("[轻舟] persist drive transcript failed:", error); }
      }
      lease?.release();
    }
  }

  async function listAvailableSkills(params: Fields = {}) {
    const scope = normalizeSkillScope(params.scope);
    const query = String(params.query || "").trim().toLowerCase();
    const items = (await skills.list())
      .filter(skill => scope === "all" || String(skill.scope || "global") === scope)
      .filter(skill => !query || skillMatchesQuery(skill, query, skills.getDisplayName))
      .map(skill => summarizeSkill(skill, {}, skills.getDisplayName))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { scope, query, count: items.length, items };
  }

  async function getSkill(params: Fields = {}) {
    const name = String(params.name || params.skill || "").trim();
    if (!name) throw new Error("get_skill requires name");
    const skill = await skills.load(name);
    if (!skill) return skillNotFound(name);
    tools.recordLoadedSkillNames(sessions.normalizeId(params.sessionId), [skill.name, skills.getDisplayName(skill)]);
    return summarizeSkill(skill, {
      includeContent: params.includeContent !== false,
      includeResourceContent: params.includeResources === true,
    }, skills.getDisplayName);
  }

  async function getSkillResource(params: Fields = {}) {
    const name = String(params.name || params.skill || "").trim();
    const path = skills.normalizeResourcePath(params.path || params.resourcePath || "");
    if (!name) throw new Error("get_skill_resource requires name");
    if (!path) throw new Error("get_skill_resource requires path");
    const skill = await skills.load(name);
    if (!skill) return skillNotFound(name);
    const resource = (Array.isArray(skill.resources) ? skill.resources : [])
      .find(item => skills.normalizeResourcePath(item?.path || "") === path);
    if (!resource) {
      return {
        error: `Skill resource "${path}" not found`,
        code: "SKILL_RESOURCE_NOT_FOUND",
        details: { name: skill.name, path },
        resources: summarizeSkillResources(skill.resources),
      };
    }
    if (isSkillDocumentResource(resource) || isBase64SkillResource(resource)) {
      if (typeof skills.loadDocumentResource !== "function") {
        const error = new Error("Skill document resource runtime is unavailable");
        Object.assign(error, { code: "SKILL_DOCUMENT_RUNTIME_UNAVAILABLE" });
        throw error;
      }
      return skills.loadDocumentResource({
        skill,
        resource,
        path,
        displayName: skills.getDisplayName(skill) || skill.name,
      }, {
        context: {
          sessionId: String(params.sessionId || ""),
          runId: String(params.runId || ""),
          source: "mcp_bridge",
        },
      });
    }
    const content = typeof resource.content === "string" ? resource.content : "";
    const start = clampNumber(params.start, 0, Math.max(0, content.length), 0);
    const maxChars = clampNumber(params.maxChars, 1, 1000000, 300000);
    const end = Math.min(content.length, start + maxChars);
    return {
      name: skill.name,
      displayName: skills.getDisplayName(skill) || skill.name,
      path: resource.path,
      type: resource.type,
      title: resource.title,
      description: resource.description,
      size: content.length,
      start,
      end,
      truncated: end < content.length,
      content: content.slice(start, end),
    };
  }

  async function skillNotFound(name: string) {
    return {
      error: `Skill "${name}" not found`,
      code: "SKILL_NOT_FOUND",
      details: { name },
      available: (await skills.list()).map(skill => skill.name).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    };
  }

  return Object.freeze({
    describe,
    dispatchRuntimeMessage,
    continueUserWait: userInput.continueWait,
    submitWaitForm: userInput.submitWaitForm,
    cancelUserWait: userInput.cancelWait,
    getUserInput: userInput.get,
    respondToUserInput: userInput.respond,
    sendMessage,
    getState,
    getMessages,
    getSnapshot,
    listTools,
    getTool,
    createDriveSession,
    listDriveSessions,
    getDriveSession,
    restoreDriveSessions,
    recordNestedTool,
    executeTool,
    drive,
    listSkills: listAvailableSkills,
    getSkill,
    getSkillResource,
  });
}

function summarizeSkill(skill: Partial<SkillRecord> = {}, {
  includeContent = false,
  includeResourceContent = false,
} = {}, getDisplayName: McpSkillsPort["getDisplayName"] = value => value?.name || "") {
  const content = typeof skill.content === "string" ? skill.content : "";
  const resources = summarizeSkillResources(skill.resources, { includeContent: includeResourceContent });
  return {
    name: skill.name || "",
    displayName: getDisplayName(skill) || skill.name || "",
    description: skill.description || "",
    scope: skill.scope || "global",
    status: skill.status || "active",
    domains: Array.isArray(skill.domains) ? skill.domains : [],
    urlPatterns: Array.isArray(skill.urlPatterns) ? skill.urlPatterns : [],
    excludePatterns: Array.isArray(skill.excludePatterns) ? skill.excludePatterns : [],
    source: skill.source || "",
    builtin: skill.builtin === true,
    readOnly: skill.readOnly === true,
    format: skill.format || "",
    schemaVersion: Number(skill.schemaVersion || 0) || 0,
    metadata: plainObject(skill.metadata),
    createdAt: skill.createdAt || "",
    updatedAt: skill.updatedAt || "",
    contentSize: content.length,
    ...(includeContent ? { content, runtime: getSkillRuntimeGuidance() } : {}),
    resourceCount: resources.length,
    resources,
  };
}

function summarizeSkillResources(resources: readonly SkillResource[] | undefined = [], { includeContent = false } = {}) {
  return (Array.isArray(resources) ? resources : []).map(resource => {
    const content = typeof resource?.content === "string" ? resource.content : "";
    const binary = isBase64SkillResource(resource);
    return {
      path: resource?.path || "",
      type: resource?.type || "",
      title: resource?.title || "",
      description: resource?.description || "",
      size: resourceByteSize(resource, content),
      hasContent: content.length > 0,
      ...(resource?.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(binary ? { encoding: resource.encoding } : {}),
      ...(includeContent && !binary ? { content } : {}),
    };
  }).filter(resource => resource.path);
}

function resourceByteSize(resource: SkillResource, content = "") {
  try { return skillResourceByteSize(resource); }
  catch (_error) { return Number(resource?.size) || content.length; }
}

function normalizeSkillScope(scope: unknown = "all") {
  const normalized = String(scope || "all").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized || normalized === "all" || normalized === "allskills") return "all";
  if (["global", "globalskill", "globalskills"].includes(normalized)) return "global";
  if (["site", "siteskill", "siteskills"].includes(normalized)) return "site";
  if (["resident", "residentskill", "residentskills"].includes(normalized)) return "resident";
  throw new Error("list_skills scope must be all, global, site, or resident");
}

function skillMatchesQuery(skill: Partial<SkillRecord> = {}, query = "", getDisplayName: McpSkillsPort["getDisplayName"] = value => value?.name || "") {
  return [
    skill.name,
    getDisplayName(skill),
    skill.description,
    skill.scope,
    skill.source,
    ...(Array.isArray(skill.domains) ? skill.domains : []),
    ...(Array.isArray(skill.urlPatterns) ? skill.urlPatterns : []),
    ...(Array.isArray(skill.resources) ? skill.resources.map(resource => [
      resource?.path,
      resource?.title,
      resource?.description,
    ].filter(Boolean).join(" ")) : []),
  ].filter(Boolean).join("\n").toLowerCase().includes(query);
}

function normalizeExpectedTypes(value: unknown) {
  return (Array.isArray(value) ? value : [value]).map(item => String(item || "").trim()).filter(Boolean);
}

function settleDriveCall<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  const guarded = promise.then(value => value, error => { throw error; });
  promise.catch(() => {});
  if (!signal) return guarded;
  if (signal.aborted) return Promise.reject(driveAbortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(driveAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    guarded.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function driveAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("The drive call was aborted."), { name: "AbortError", code: "OPERATION_ABORTED" });
}

function plainObject(value: unknown, fallback: Fields = {}): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : fallback;
}

function driveTranscriptResult(result: unknown, images: { mimeType: string; data: string }[], metadata: ToolResultPresentation) {
  const presented = presentToolResult(result, metadata);
  const image = images[0];
  if (!image?.mimeType || !image.data) return presented ?? null;
  const body = presented && typeof presented === "object" && !Array.isArray(presented) ? presented : { value: presented ?? null };
  return { ...body, _image: `data:${image.mimeType};base64,${image.data}` };
}

function driveToolFailure(error: unknown) {
  const err = plainObject(error);
  const name = error instanceof Error ? error.name : "";
  const aborted = name === "AbortError" || name === "TimeoutError";
  const message = error instanceof Error && error.message ? error.message : String(error ?? "");
  return toolError(aborted ? "OPERATION_ABORTED" : String(err.code || "TOOL_EXECUTION_FAILED"), message, {
    hint: typeof err.hint === "string" ? err.hint : undefined,
    details: plainObject(err.details),
  });
}

function describeSessionRuntime(state: Fields): SessionRuntimeObservation {
  return {
    status: state.status, running: Boolean(state.running), pendingStart: Boolean(state.pendingStart), runId: state.runId,
    waitId: state.waitId, waitMessage: state.waitMessage, waitTitle: state.waitTitle, waitForm: state.waitForm,
    interrupted: Boolean(state.interrupted), reason: state.reason, startedAt: state.startedAt, endedAt: state.endedAt, updatedAt: state.updatedAt,
    currentToolName: state.currentToolName, currentToolStartedAt: state.currentToolStartedAt,
    contextUsage: state.contextUsage, contextWindow: state.contextWindow, inputTokensEstimate: state.inputTokensEstimate,
    tracker: state.tracker, goal: state.goal, pendingSteerings: state.pendingSteerings, pendingSteeringMessages: state.pendingSteeringMessages,
    pendingFollowUps: state.pendingFollowUps, pendingFollowUpMessages: state.pendingFollowUpMessages,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function randomRequestId() {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
