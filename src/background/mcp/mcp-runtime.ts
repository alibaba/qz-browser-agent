import { createSessionUserInput } from "../session/user-input.js";
import { productText } from "../../shared/product-text.js";
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
import type { SkillRecord, SkillResource } from "../../shared/skills/skill-utils.js";
import type { RunProfile } from "../agent/run-profile.js";
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
  supervisor: Pick<ReturnType<typeof createSessionSupervisor<Agent>>, "resolveUserWait" | "rejectUserWait" | "isRunCurrent" | "getUserWait">;
  submitMessage: Commands["submitSessionMessageRuntime"]; waitForRunObserved: Commands["waitForSessionRunObserved"];
  getRuntimeOutput: Commands["getSessionRuntimeStateForOutput"]; getRuntime: Commands["getSessionRuntimeState"];
  getLiveAgentEntry: Host["getLiveEntry"]; getAgent: Host["getAgent"]; setRuntime: Runtime["set"];
  getLastMessages: Commands["getLastMessagesRuntime"]; getTranscript: Transcript["get"]; getConversation: Transcript["getConversation"];
  listMetadata(): Promise<Record<string, SessionMetadata>>; compactTranscriptEvent: Commands["compactTranscriptEvent"];
}
interface McpToolsPort {
  ready?: Promise<unknown> | ((reason: string) => Promise<unknown>);
  canManageSessions(id: string): Promise<boolean>;
  buildRunProfile(input: { sessionId: string; canManageSessions: boolean }): Promise<RunProfile> | RunProfile;
  loadedSkillNames: Runtime["loadedSkillNames"]; recordLoadedSkillNames: Runtime["recordLoadedSkillNames"];
  runtime: {
    getSchemas(options: { runProfile: RunProfile; context: ToolContext; loadedPluginSkillNames: string[] }): { type: string; function: { name: string; description: string; parameters: object } }[];
    execute(name: string, args: Fields, signal: AbortSignal | undefined, context: ToolContext): Promise<unknown>;
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
      storageKey: storageKey(),
      methods: [
        "ping", "capabilities", "get_bridge_config", "save_bridge_config", "runtime_message",
        "list_sessions", "create_session", "send_message", "follow_up", "continue_task",
        "submit_wait_form", "cancel_wait", "get_user_input", "respond_to_user_input", "get_session_state", "get_session_snapshot",
        "get_messages", "get_history", "stop_session", "clear_goal", "list_tools",
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
      runtime,
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
        runtime,
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
        runtime,
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
      session: metadata[id] || null,
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

  async function listTools(params: Fields = {}) {
    await waitForToolsReady("mcp_list_tools");
    const sessionId = sessions.normalizeId(params.sessionId);
    const canManageSessions = await tools.canManageSessions(sessionId);
    const runProfile = await tools.buildRunProfile({ sessionId, canManageSessions });
    const runtime = sessions.getRuntime(sessionId);
    const loadedNames = tools.loadedSkillNames(sessionId, params.loadedPluginSkillNames || []);
    const schemas = tools.runtime.getSchemas({
      runProfile,
      context: {
        dynamicContext: plainObject(params.dynamicContext),
        workingTab: runtime.workingTab || null,
        pageUrl: String(runtime.workingUrl || ""),
        taskSiteTabs: runtime.visitedTaskSites || [],
        loadedPluginSkillNames: loadedNames,
      },
      loadedPluginSkillNames: loadedNames,
    });
    return {
      sessionId,
      tools: schemas.map(schema => ({
        name: schema.function?.name || "",
        description: schema.function?.description || "",
        parameters: schema.function?.parameters || {},
        type: schema.type || "function",
      })).filter(tool => tool.name),
    };
  }

  async function executeTool(params: Fields = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const name = String(params.name || params.toolName || "").trim();
    if (!name) throw new Error("execute_tool requires name");
    await waitForToolsReady("mcp_execute_tool");
    signal?.throwIfAborted();
    const sessionId = sessions.normalizeId(params.sessionId);
    const canManageSessions = await tools.canManageSessions(sessionId);
    signal?.throwIfAborted();
    const runProfile = await tools.buildRunProfile({ sessionId, canManageSessions });
    signal?.throwIfAborted();
    const runtime = sessions.getRuntime(sessionId);
    const requestedRunId = String(params.runId || "").trim();
    const runtimeRunId = String(runtime.runId || "").trim();
    const runId = requestedRunId || (
      runtimeRunId
      && typeof sessions.supervisor?.isRunCurrent === "function"
      && sessions.supervisor.isRunCurrent(sessionId, runtimeRunId)
        ? runtimeRunId
        : ""
    );
    const loadedNames = tools.loadedSkillNames(sessionId, params.loadedPluginSkillNames || []);
    const dynamicContext = { ...plainObject(params.dynamicContext, {}) };
    dynamicContext.workingTab = runtime.workingTab || null;
    dynamicContext.pageUrl = runtime.workingUrl || "";
    dynamicContext.taskSiteTabs = runtime.visitedTaskSites || [];
    const result = await tools.runtime.execute(name, plainObject(params.args), signal, {
      sessionId,
      runId,
      workingTabId: runtime.workingTabId || null,
      runProfile,
      source: "mcp_bridge",
      dynamicContext,
      loadedPluginSkillNames: loadedNames,
    });
    signal?.throwIfAborted();
    if (name === "load_skill" && result && typeof result === "object" && !plainObject(result).error) {
      tools.recordLoadedSkillNames(sessionId, [plainObject(result).name, plainObject(result).displayName]);
    }
    return { toolName: name, sessionId, runId: runId || null, result };
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
    executeTool,
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

function plainObject(value: unknown, fallback: Fields = {}): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function randomRequestId() {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
