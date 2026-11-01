import { modelT } from "./model-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { ToolContext, ToolArguments } from "#sdk/background";
import type { SkillRecord, SkillResource } from "#sdk/shared/skills";
import type { SkillManifest, SkillMcpServer } from "#sdk/shared/skills";
type AnalysisSkillsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "clampNumber" | "getToolRuntimeDependencies"
  | "publishSkillRegistryChange" | "summarizeToolArgsForTrace" | "models" | "skills">;
type ManageSkillInput = Omit<Partial<ToolArguments<typeof SKILL_AUTHOR_TOOL_PARAMETERS.update> & ToolArguments<typeof SKILL_AUTHOR_TOOL_PARAMETERS.create>>, "scope"> & { action?: string; operation?: string; scope?: string; contentEdits?: ToolArguments<typeof SKILL_CONTENT_EDIT_SCHEMA>[]; resourceEdits?: ToolArguments<typeof SKILL_RESOURCE_EDIT_SCHEMA>[] };
import { requireToolFields } from "#sdk/background/tools";
import { isBuiltinSkillName } from "#sdk/shared/skills";
import { SKILL_AUTHOR_TOOL_PARAMETERS, SKILL_CONTENT_EDIT_SCHEMA, SKILL_RESOURCE_EDIT_SCHEMA } from "./workbench.js";
import { getSkillDisplayName, isBase64SkillResource, isSkillDocumentResource, skillResourceByteSize } from "#sdk/shared/skills";

import { findSkillManifestResource, parseSkillManifest } from "#sdk/shared/skills";

import { trace as toolTrace } from "#sdk/background/tools";

/** Registers nested LLM analysis and Skill discovery/authoring tools. */
export function registerAnalysisSkillsTools({
  registerTool,
  ToolExecutionError,
  clampNumber,
  getToolRuntimeDependencies,
  publishSkillRegistryChange,
  summarizeToolArgsForTrace,
  models: { chat: llmChat },
  skills: { list: listSkills, load: loadSkill, save: saveSkill, update: updateSkill, delete: deleteSkill, loadResource: loadSkillResource },
}: AnalysisSkillsHost) {
registerTool({
  name: "ask_llm",
  get description() { return modelT("askLlm"); },
  get parameters() { return {
    type: "object",
    properties: {
      prompt: { type: "string", description: modelT("analysisPrompt") },
      system: { type: "string", description: modelT("analysisSystem") },
      data: { type: "string", description: modelT("analysisData") },
    },
    required: ["prompt"],
  } as const; },
  hidden: true,
  timeout: { defaultMs: 120000, maxMs: 600000 },
  execute: async ({ prompt, system, data }, signal, context = {}) => {
    const messages: Parameters<typeof llmChat>[0] = [];
    if (system) messages.push({ role: "system", content: system });

    let userContent = prompt;
    if (data) {
      // Bound each ask_llm data payload to protect the main context budget.
      const MAX_DATA_CHARS = 300000;
      if (data.length > MAX_DATA_CHARS) {
        data = data.slice(0, MAX_DATA_CHARS) + `\n\n... [truncated: ${data.length} → ${MAX_DATA_CHARS} chars]`;
      }
      userContent += "\n\n---\n" + data;
    }
    messages.push({ role: "user", content: userContent });

    const { message } = await llmChat(messages, [], signal, { sessionId: context.sessionId, runId: context.runId || undefined });
    return String(message?.content || "");
  },
});

// ===========================================================================
// Skills
// ===========================================================================

const getSkillRuntimeGuidance = () => (modelT("runtimeGuidance"));

registerTool({
  name: "load_skill",
  model: { preserveResult: true },
  get description() { return modelT("loadSkill"); },
  get parameters() { return {
    type: "object",
    properties: {
      name: { type: "string", description: modelT("skillName") },
      includeResources: { type: "boolean", description: modelT("skillIncludeResources") },
    },
    required: ["name"],
  } as const; },
  effects: (_args, result: unknown) => {
    const value = resultRecord(result);
    return value.name && !value.error ? [{
      type: "skill.loaded",
      name: String(value.name).trim().toLowerCase(),
      displayName: String(value.displayName || ""),
      hasPluginManifest: Array.isArray(value.resources) && value.resources.some(resource =>
        String(resultRecord(resource).path || "").trim().replace(/^\/+/, "").toLowerCase() === "plugin.json"),
    }] : [];
  },
  execute: async ({ name, includeResources = false }, _signal, context = {}) => {
    const skill = await loadSkill(name, context.language);
    if (!skill) {
      const all = await listSkills(context.language);
      return {
        error: t("skillNotFound", { name: String(name) }),
        code: "SKILL_NOT_FOUND",
        details: { name },
        available: all.map(s => s.name),
      };
    }
    return {
      name: skill.name,
      displayName: getSkillDisplayName(skill) || skill.name,
      description: skill.description,
      scope: skill.scope,
      domains: skill.domains,
      urlPatterns: skill.urlPatterns,
      excludePatterns: skill.excludePatterns,
      status: skill.status,
      source: skill.source || "",
      builtin: skill.builtin === true,
      readOnly: skill.readOnly === true,
      updatedAt: skill.updatedAt,
      runtime: getSkillRuntimeGuidance(),
      content: skill.content,
      resources: summarizeSkillResources(skill.resources, { includeContent: includeResources }),
      ...summarizeSkillMcpFields(skill),
    };
  },
});

registerTool({
  name: "load_skill_resource",
  get description() { return modelT("loadSkillResource"); },
  get parameters() { return {
    type: "object",
    properties: {
      name: { type: "string", description: modelT("skillName") },
      path: { type: "string", description: modelT("skillResourcePath") },
      start: { type: "number", description: modelT("skillResourceStart") },
      maxChars: { type: "number", description: modelT("skillResourceMaxChars") },
    },
    required: ["name", "path"],
  } as const; },
  execute: async ({ name, path, start = 0, maxChars = 300000 }, signal, context = {}) => {
    const loaded = await loadSkillResource(name, path, context.language);
    if (!loaded) {
      const all = await listSkills(context.language);
      return {
        error: t("skillNotFound", { name: String(name) }),
        code: "SKILL_NOT_FOUND",
        details: { name },
        available: all.map(s => s.name),
      };
    }
    const { skill, resource, path: cleanPath } = loaded;
    if (!resource) {
      return {
        error: t("resourceNotFound", { path: cleanPath }),
        code: "SKILL_RESOURCE_NOT_FOUND",
        details: { name: skill.name, path: cleanPath },
        resources: summarizeSkillResources(skill.resources, { includeContent: false }),
      };
    }
    if (isSkillDocumentResource(resource) || isBase64SkillResource(resource)) {
      const loadDocumentResource = getToolRuntimeDependencies(context)?.skills?.loadDocumentResource;
      if (typeof loadDocumentResource !== "function") {
        throw new ToolExecutionError(
          "SKILL_DOCUMENT_RUNTIME_UNAVAILABLE",
          t("skillDocumentParsingIsUnavailable"),
          { name: skill.name, path: cleanPath },
        );
      }
      return loadDocumentResource({
        skill,
        resource,
        path: cleanPath,
        displayName: getSkillDisplayName(skill) || skill.name,
      }, { signal, context });
    }
    const content = typeof resource.content === "string" ? resource.content : "";
    const safeStart = clampNumber(start, 0, Math.max(0, content.length), 0);
    const safeMax = clampNumber(maxChars, 1, 1000000, 300000);
    const end = Math.min(content.length, safeStart + safeMax);
    return {
      name: skill.name,
      displayName: getSkillDisplayName(skill) || skill.name,
      path: resource.path,
      type: resource.type,
      title: resource.title,
      description: resource.description,
      size: content.length,
      start: safeStart,
      end,
      truncated: end < content.length,
      content: content.slice(safeStart, end),
    };
  },
});

async function executeManageSkillAction(input: ManageSkillInput = {}, context: ToolContext = {}) {
  const startedAt = Date.now();
  if (context?.source !== "plugin_host") {
    throw new ToolExecutionError("TOOL_FORBIDDEN_BY_RUN_PROFILE", t("managementInternalOnly"), {
      tool: "manage_skill",
      source: context?.source || "",
    });
  }
  const action = String(input.action || input.operation || "").trim().toLowerCase();
  toolTrace(`[skill] manage start action=${action || ""} name=${input?.name || ""} source=${context?.source || ""} args=${summarizeToolArgsForTrace(input)}`);
  if (action === "create") {
    assertManageSkillName(input, "create");
    const result = await executeCreateSkillAction(input, context);
    toolTrace(`[skill] manage done action=create name=${("name" in result ? result.name : "") || input?.name || ""} durationMs=${Date.now() - startedAt} result=${summarizeToolArgsForTrace(result)}`);
    return result;
  }
  if (action === "update" || action === "edit" || action === "patch") {
    assertManageSkillName(input, "update");
    const result = await executeUpdateSkillAction(input, context);
    toolTrace(`[skill] manage done action=update name=${("name" in result ? result.name : "") || input?.name || ""} durationMs=${Date.now() - startedAt} result=${summarizeToolArgsForTrace(result)}`);
    return result;
  }
  if (action === "delete" || action === "remove") {
    assertManageSkillName(input, "delete");
    const result = await executeDeleteSkillAction(input, context);
    toolTrace(`[skill] manage done action=delete name=${("name" in result ? result.name : "") || input?.name || ""} durationMs=${Date.now() - startedAt} result=${summarizeToolArgsForTrace(result)}`);
    return result;
  }
  if (action === "list_skills" || action === "list") {
    const result = await executeListSkillsAction(input, context);
    toolTrace(`[skill] manage done action=list_skills scope=${result?.scope || ""} durationMs=${Date.now() - startedAt} result=${summarizeToolArgsForTrace(result)}`);
    return result;
  }
  throw new ToolExecutionError("INVALID_ARGUMENTS", t("managementActionInvalid"), {
    action: input.action,
    allowedActions: ["create", "update", "delete", "list_skills"],
  });
}

function assertManageSkillName(input: ManageSkillInput = {}, action = "") {
  if (String(input.name || "").trim()) return;
  throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", t("managementNameRequired", { action }), {
    action,
    missing: ["name"],
  });
}

async function executeListSkillsAction({ scope = "all" } = {}, context: ToolContext = {}) {
  const normalizedScope = normalizeListSkillsScope(scope);
  const skills = await listSkills(context.language);
  const filtered = normalizedScope === "all"
    ? skills
    : skills.filter(skill => String(skill.scope || "global") === normalizedScope);
  const items = filtered
    .map(skill => ({
      name: skill.name,
      displayName: getSkillDisplayName(skill) || skill.name,
    }))
    .filter(item => item.name)
    .sort((a, b) => a.name.localeCompare(b.name) || a.displayName.localeCompare(b.displayName));
  return {
    action: "list_skills",
    scope: normalizedScope,
    count: items.length,
    names: items.map(item => item.name),
    items,
  };
}

function normalizeListSkillsScope(scope = "all") {
  const normalized = String(scope || "all").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized || normalized === "all" || normalized === "allskills") return "all";
  if (normalized === "global" || normalized === "globalskill" || normalized === "globalskills") return "global";
  if (normalized === "site" || normalized === "siteskill" || normalized === "siteskills") return "site";
  if (normalized === "resident" || normalized === "residentskill" || normalized === "residentskills") return "resident";
  throw new ToolExecutionError("INVALID_ARGUMENTS", t("managementScopeInvalid"), {
    scope,
    allowedScopes: ["all", "global", "site", "resident"],
  });
}

async function executeCreateSkillAction({ name, displayName, description, content, scope, domains, urlPatterns, excludePatterns }: ManageSkillInput, context: ToolContext = {}) {
  const startedAt = Date.now();
  toolTrace(`[skill] create start name=${name || ""} scope=${scope || ""} contentChars=${String(content || "").length}`);
  if (isBuiltinSkillName(name || "")) {
    toolTrace(`[skill] create blocked readonly name=${name || ""}`);
    return {
      action: "create",
      error: t("builtInSkillCannotBeOverwritten", { name: String(name) }),
      code: "SKILL_READ_ONLY",
      details: { name },
    };
  }
  const existing = await loadSkill(name, context.language);
  toolTrace(`[skill] create existing name=${name || ""} exists=${existing ? 1 : 0} elapsedMs=${Date.now() - startedAt}`);
  if (existing) {
    return {
      action: "create",
      error: t("skillAlreadyExists", { name: String(name) }),
      code: "SKILL_ALREADY_EXISTS",
      details: { name: existing.name, displayName: getSkillDisplayName(existing) || existing.name },
    };
  }
  if (!description || content == null) {
    toolTrace(`[skill] create invalid name=${name || ""} missing description/content`);
    return {
      action: "create",
      error: t("skillContentRequired"),
      code: "SKILL_CREATE_REQUIRES_CONTENT",
      details: { name },
    };
  }
  const refreshRegistry = requireSkillRegistryMutationRuntime(context);
  const skill = await saveSkill(
    name,
    description,
    content,
    {
      displayName,
      scope,
      domains,
      urlPatterns,
      excludePatterns,
    },
  );
  toolTrace(`[skill] create storage done name=${skill.name} updatedAt=${skill.updatedAt} resources=${skill.resources?.length || 0} elapsedMs=${Date.now() - startedAt}`);
  await publishSkillRegistryChange("create_skill", {
    skillName: skill.name,
    previousSkillName: "",
  }, refreshRegistry);
  toolTrace(`[skill] create registry done name=${skill.name} elapsedMs=${Date.now() - startedAt}`);
  return {
    action: "create",
    saved: true,
    name: skill.name,
    displayName: getSkillDisplayName(skill) || skill.name,
    scope: skill.scope,
    domains: skill.domains,
    urlPatterns: skill.urlPatterns,
    resources: summarizeSkillResources(skill.resources, { includeContent: false }),
    ...summarizeSkillMcpFields(skill),
    runtime: getSkillRuntimeGuidance(),
    updatedAt: skill.updatedAt,
  };
}

async function executeUpdateSkillAction({
  name,
  renameTo,
  displayName,
  description,
  scope,
  status,
  domains,
  urlPatterns,
  excludePatterns,
  oldText,
  newText,
  contentEdits,
  prependContent,
  appendContent,
  resourceEdits,
}: ManageSkillInput, context: ToolContext = {}) {
  if (isBuiltinSkillName(name || "") || isBuiltinSkillName(renameTo || "")) {
    return {
      action: "update",
      error: t("builtInSkillCannotBeModified", { name: String(isBuiltinSkillName(name || "") ? name : renameTo) }),
      code: "SKILL_READ_ONLY",
      details: { name, renameTo },
    };
  }
  const refreshRegistry = requireSkillRegistryMutationRuntime(context);
  const result = await updateSkill(name, {
    renameTo,
    displayName,
    description,
    scope,
    status,
    domains,
    urlPatterns,
    excludePatterns,
    oldText,
    newText,
    contentEdits,
    prependContent,
    appendContent,
    resourceEdits,
  });
  if (!result) {
    const all = await listSkills(context.language);
    return {
      action: "update",
      error: t("skillNotFound", { name: String(name) }),
      code: "SKILL_NOT_FOUND",
      details: { name },
      available: all.map(s => s.name),
    };
  }
  const skill = result.skill;
  const renamedFrom = result.changes.find(change => change.field === "name")?.from || "";
  await publishSkillRegistryChange("update_skill", {
    skillName: skill.name,
    previousSkillName: renamedFrom,
  }, refreshRegistry);
  return {
    action: "update",
    updated: result.updated,
    name: skill.name,
    displayName: getSkillDisplayName(skill) || skill.name,
    scope: skill.scope,
    status: skill.status,
    domains: skill.domains,
    urlPatterns: skill.urlPatterns,
    excludePatterns: skill.excludePatterns,
    contentSize: skill.content.length,
    changes: result.changes,
    diagnostics: result.diagnostics || [],
    resources: summarizeSkillResources(skill.resources, { includeContent: false }),
    ...summarizeSkillMcpFields(skill),
    runtime: getSkillRuntimeGuidance(),
    updatedAt: skill.updatedAt,
  };
}

async function executeDeleteSkillAction({ name }: ManageSkillInput, context: ToolContext = {}) {
  if (isBuiltinSkillName(name || "")) {
    return {
      action: "delete",
      error: t("builtInSkillCannotBeDeleted", { name: String(name) }),
      code: "SKILL_READ_ONLY",
      details: { name },
    };
  }
  const refreshRegistry = requireSkillRegistryMutationRuntime(context);
  const ok = await deleteSkill(name);
  if (ok) await publishSkillRegistryChange("delete_skill", {
    skillName: name,
    previousSkillName: "",
  }, refreshRegistry);
  return ok
    ? { action: "delete", deleted: true, name }
    : {
        action: "delete",
        error: t("skillNotFound", { name: String(name) }),
        code: "SKILL_NOT_FOUND",
        details: { name },
      };
}

function requireSkillRegistryMutationRuntime(context: ToolContext = {}) {
  const refreshRegistry = getToolRuntimeDependencies(context)?.skills?.refreshRegistry;
  if (typeof refreshRegistry === "function") return refreshRegistry;
  throw new ToolExecutionError(
    "SKILL_REGISTRY_RUNTIME_UNAVAILABLE",
    t("registryMutationUnavailable"),
  );
}

registerTool({
  name: "manage_skill",
  get description() { return modelT("manageSkillInternal"); },
  get parameters() { return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "update", "delete", "list_skills"], description: modelT("manageSkillAction") },
      ...SKILL_AUTHOR_TOOL_PARAMETERS.update.properties,
      scope: { type: "string", enum: ["all", "global", "site", "resident"], description: modelT("manageSkillScope") },
      content: SKILL_AUTHOR_TOOL_PARAMETERS.create.properties.content,
    },
    required: ["action"],
  } as const; },
  hidden: true,
  effects: (_args, result: unknown) => {
    const value = resultRecord(result);
    return !value.error && ["create", "update", "delete"].includes(String(value.action || ""))
      ? [{ type: "skills.changed" }] : [];
  },
  execute: async (input, _signal, context = {}) => executeManageSkillAction(input, context),
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["create"].includes(action)) requireToolFields("manage_skill", args, ["name","description","content"], { action, requiredWhen: `action=${action}` });
    if (["update","delete"].includes(action)) requireToolFields("manage_skill", args, ["name"], { action, requiredWhen: `action=${action}` });
  },
});

function getSkillDistributionRuntime(context: ToolContext = {}, capability = "") {
  if (context?.source !== "plugin_host" || context?.pluginId !== "qingzhou-skill-author") {
    throw new ToolExecutionError(
      "TOOL_FORBIDDEN_BY_RUN_PROFILE",
      t("distributionInternalOnly", { capability: capability || "Skill distribution" }),
      { source: context?.source || "", pluginId: context?.pluginId || "" },
    );
  }
  const runtime = getToolRuntimeDependencies(context)?.skills;
  if (!runtime) {
    throw new ToolExecutionError(
      "SKILL_DISTRIBUTION_RUNTIME_UNAVAILABLE",
      t("skillImportAndGitDistributionAreUnavailable"),
      { capability },
    );
  }
  return runtime;
}

registerTool({
  name: "import_skill_from_page_zip",
  get description() { return modelT("importSkillZipInternal"); },
  get parameters() { return {
    type: "object",
    properties: {
      url: { type: "string", description: modelT("skillZipUrl") },
      tabId: { type: "number", description: modelT("skillPageTabId") },
      overwrite: { type: "boolean", description: modelT("skillZipOverwrite") },
    },
    required: ["url", "tabId"],
  } as const; },
  hidden: true,
  page: "owned",
  timeout: { defaultMs: 300000, maxMs: 1800000 },
  execute: async (input, signal, context = {}) => {
    const runtime = getSkillDistributionRuntime(context, "import_skill_from_page_zip");
    if (typeof runtime.importPageZip !== "function") {
      throw new ToolExecutionError("SKILL_DISTRIBUTION_RUNTIME_UNAVAILABLE", t("importingASkillZipFromAPageIsUnavailable"));
    }
    return runtime.importPageZip(input, { signal, context });
  },
});

registerTool({
  name: "import_git_skill_repository",
  get description() { return modelT("importSkillGitInternal"); },
  get parameters() { return {
    type: "object",
    properties: {
      repositoryUrl: { type: "string", description: modelT("skillRepositoryUrl") },
      tabId: { type: "number", description: modelT("skillRepositoryTabId") },
      overwrite: { type: "boolean", description: modelT("skillGitOverwrite") },
    },
    required: ["repositoryUrl", "tabId"],
  } as const; },
  hidden: true,
  page: "owned",
  timeout: { defaultMs: 300000, maxMs: 1800000 },
  execute: async (input, signal, context = {}) => {
    const runtime = getSkillDistributionRuntime(context, "import_git_skill_repository");
    if (typeof runtime.bindGitSource !== "function") {
      throw new ToolExecutionError("SKILL_DISTRIBUTION_RUNTIME_UNAVAILABLE", t("importingAGitSkillRepositoryIsUnavailable"));
    }
    return runtime.bindGitSource(input, { signal, context });
  },
});

registerTool({
  name: "install_skill_to_git",
  get description() { return modelT("installSkillGitInternal"); },
  get parameters() { return {
    type: "object",
    properties: {
      name: { type: "string", description: modelT("skillInstallName") },
      tabId: { type: "number", description: modelT("skillInstallTabId") },
      commitMessage: { type: "string", description: modelT("skillCommitMessage") },
    },
    required: ["name", "tabId"],
  } as const; },
  hidden: true,
  page: "owned",
  timeout: { defaultMs: 300000, maxMs: 1800000 },
  execute: async ({ name, tabId, commitMessage = "" }, signal, context = {}) => {
    const runtime = getSkillDistributionRuntime(context, "install_skill_to_git");
    if (typeof runtime.inspectGitPublishTarget !== "function" || typeof runtime.publishToGit !== "function") {
      throw new ToolExecutionError("SKILL_DISTRIBUTION_RUNTIME_UNAVAILABLE", t("installingASkillToGitIsUnavailable"));
    }
    const skill = await loadSkill(name, context.language);
    if (!skill) {
      throw new ToolExecutionError("SKILL_NOT_FOUND", t("skillNotFound", { name: String(name) }), { name });
    }
    const target = await runtime.inspectGitPublishTarget({ tabId, waitForReady: true }, { signal, context });
    if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", t("skillGitInstallationCanceled"));
    if (!target?.available) {
      throw new ToolExecutionError(
        "GIT_PUBLISH_TARGET_UNAVAILABLE",
        gitPublishTargetUnavailableMessage(target?.reason),
        { tabId, reason: target?.reason || "unknown" },
      );
    }
    return runtime.publishToGit({ skill, target, commitMessage }, { signal, context });
  },
});

function gitPublishTargetUnavailableMessage(reason = "") {
  if (reason === "active_tab_not_code_tree") return t("theTargetPageIsNotARepositoryRootOrDirectory");
  if (reason === "code_project_id_missing") return t("theRepositoryProjectIdIsMissingWaitForThePage");
  if (reason === "code_branch_missing") return t("branchInformationIsMissingOpenASpecificBranchOrDirectory");
  if (reason === "code_page_not_ready") return t("theRepositoryPageHasNotFinishedLoadingTryAgainShortly");
  return t("couldNotReadTheGitRepositoryCheckThatYouAre");
}

function summarizeSkillResources(resources: SkillResource[] = [], { includeContent = false } = {}) {
  return (Array.isArray(resources) ? resources : []).map(resource => {
    const content = typeof resource.content === "string" ? resource.content : "";
    const binary = isBase64SkillResource(resource);
    const summary: { content?: string } & Omit<SkillResource, "content"> & { hasContent: boolean } = {
      path: resource.path,
      type: resource.type,
      title: resource.title,
      description: resource.description,
      size: resourceByteSize(resource, content),
      hasContent: content.length > 0,
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(binary ? { encoding: resource.encoding } : {}),
    };
    if (includeContent && !binary) summary.content = content;
    return summary;
  });
}

function resourceByteSize(resource: SkillResource, content = "") {
  try { return skillResourceByteSize(resource); }
  catch (_error) { return Number(resource?.size) || content.length; }
}

function summarizeSkillMcpFields(skill: SkillRecord) {
  const servers = summarizeSkillMcpServers(skill);
  return {
    mcpServerCount: servers.length,
    mcpToolCount: servers.reduce((sum, server) => sum + (Number(server.toolCount) || 0), 0),
    mcpServers: servers,
  };
}

function summarizeSkillMcpServers(skill: SkillRecord) {
  const manifestResource = findSkillManifestResource(skill.resources || []);
  if (!manifestResource || typeof manifestResource.content !== "string") return [];
  const parsed = parseSkillManifest(manifestResource.content, skill);
  const plugin = parsed.plugin || null;
  if (!plugin) return [];
  return (Array.isArray(plugin.mcpServers) ? plugin.mcpServers : []).map(server => {
    const tools = summarizeSkillMcpBoundTools(plugin, server);
    return {
      id: server.id || server.rawId || server.name || "default",
      name: server.name || server.rawId || server.id || "default",
      ref: `${plugin.id || "plugin"}:${server.id || server.rawId || "default"}`,
      enabled: server.enabled !== false,
      url: server.url || "",
      headers: { ...(server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? server.headers : {}) },
      headerNames: Object.keys(server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? server.headers : {}),
      toolCount: tools.length,
      tools,
    };
  });
}

function summarizeSkillMcpBoundTools(plugin: SkillManifest, server: SkillMcpServer) {
  const serverIds = new Set([
    server.id,
    server.rawId,
    server.name,
  ].map(item => String(item || "").trim()).filter(Boolean));
  return (Array.isArray(plugin.tools) ? plugin.tools : [])
    .filter(tool => tool.runtime === "mcp" && tool.mcp && serverIds.has(String(tool.mcp.server || "").trim()))
    .filter(tool => !tool.hidden)
    .map(tool => ({
      name: tool.name,
      localName: tool.localName,
      title: tool.title,
      mcpTool: tool.mcp!.tool,
    }));
}
}

function resultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


export default registerAnalysisSkillsTools satisfies ToolExtension;
