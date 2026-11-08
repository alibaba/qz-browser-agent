import type { SkillHostExtension, SkillHostContext } from "#sdk/background/skill-hosts";
import { ToolExecutionError } from "#sdk/background/tools";
import { listSkillRendererDefinitions } from "#sdk/shared/skills";
import { SKILL_AUTHOR_ACTIONS, skillResourceEditArgs, BUILTIN_SKILL_WORKBENCH_NAME } from "./workbench.js";

const register: SkillHostExtension = qz => {
  const handlers = {
    ...Object.fromEntries(Object.keys(SKILL_AUTHOR_ACTIONS).map(name => [name, executeSkillAuthorHostTool])),
    load_available_renderers: executeSkillAuthorLoadAvailableRenderers,
    import_page_zip: executeSkillAuthorDistributionHostTool,
    import_git_repository: executeSkillAuthorDistributionHostTool,
    install_skill_to_git: executeSkillAuthorDistributionHostTool,
  };
  for (const [toolName, execute] of Object.entries(handlers)) {
    qz.registerSkillHost({ skillName: BUILTIN_SKILL_WORKBENCH_NAME, manifestId: "qingzhou-skill-author", toolName, execute });
  }
};
export default register;

async function executeSkillAuthorHostTool(args: Record<string, unknown>, { callTool, tool: toolDefinition }: SkillHostContext) {
  const name = toolDefinition.localName || toolDefinition.rawName || toolDefinition.name;
  const action = SKILL_AUTHOR_ACTIONS[name];
  if (action === "edit_resource") {
    const payload = args;
    return callTool("manage_skill", {
      name: payload.name,
      action: "update",
      resourceEdits: [skillResourceEditArgs(payload)],
    });
  }
  const payload = action === "delete"
    ? { name: args.name }
    : args;
  return callTool("manage_skill", { ...payload, action });
}

async function executeSkillAuthorLoadAvailableRenderers() {
  const renderers = listSkillRendererDefinitions();
  return {
    ok: true,
    count: renderers.length,
    renderers,
  };
}

async function executeSkillAuthorDistributionHostTool(args: Record<string, unknown>, { callTool, tool: toolDefinition, context }: SkillHostContext) {
  const name = String(toolDefinition.localName || toolDefinition.rawName || toolDefinition.name || "").trim();
  const payload = args;

  if (name === "import_page_zip") {
    return callTool("import_skill_from_page_zip", {
      url: payload.url,
      tabRef: context.requestedTabRef ?? payload.tabRef,
      overwrite: payload.overwrite === true,
    });
  }
  if (!["import_git_repository", "install_skill_to_git"].includes(name)) {
    const err = new ToolExecutionError("PLUGIN_HOST_ACTION_UNAVAILABLE", `Unknown skill author distribution tool: ${name}`, { tool: toolDefinition.name, localName: name });
    throw err;
  }

  const opened = (await callTool("open_tab", { url: payload.repositoryUrl })) as Record<string, unknown>;
  const tabRef = opened?.tabRef;
  if (!(typeof tabRef === "string" && tabRef.trim()) && !(typeof tabRef === "number" && Number.isInteger(tabRef) && tabRef > 0)) {
    const err = new ToolExecutionError("GIT_REPOSITORY_TAB_FAILED", "Git repository tab did not open", { repositoryUrl: payload.repositoryUrl });
    throw err;
  }
  if (name === "import_git_repository") {
    return callTool("import_git_skill_repository", {
      repositoryUrl: payload.repositoryUrl,
      tabRef,
      overwrite: payload.overwrite === true,
    });
  }
  return callTool("install_skill_to_git", {
    name: payload.name,
    tabRef,
    commitMessage: payload.commitMessage,
  });
}

