import { workbenchT } from "./workbench-messages.js";
import { getLanguage } from "#sdk/shared/i18n";
import chineseContent from "./prompts/workbench-zh-CN.js";
import englishContent from "./prompts/workbench-en.js";
import { SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from "#sdk/shared/skill-definition";

export const BUILTIN_SKILL_WORKBENCH_NAME = "skill-workbench";
export const getBuiltinSkillWorkbenchDisplayName = () => (workbenchT("name"));

const getSkillWorkbenchContent = () => (getLanguage() === "zh-CN" ? chineseContent : englishContent);

export const SKILL_CONTENT_EDIT_SCHEMA = {
  type: "object",
  properties: {
    oldText: { type: "string", get description() { return workbenchT("oldContent"); } },
    newText: { type: "string", get description() { return workbenchT("newContent"); } },
  },
  required: ["oldText", "newText"],
} as const;

export const SKILL_RESOURCE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", get description() { return workbenchT("resourcePath"); } },
    type: { type: "string", get description() { return workbenchT("resourceType"); } },
    get title() { return { type: "string", description: workbenchT("resourceTitle") } as const; },
    get description() { return { type: "string", description: workbenchT("resourceDescription") } as const; },
    get content() { return { type: "string", description: workbenchT("resourceContent") } as const; },
  },
  required: ["path"],
} as const;

export const SKILL_RESOURCE_EDIT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["upsert", "set", "replace", "patch", "edit", "rename", "delete", "remove"],
      get description() { return workbenchT("resourceAction"); },
    },
    path: { type: "string", get description() { return workbenchT("shortResourcePath"); } },
    newPath: { type: "string", get description() { return workbenchT("newResourcePath"); } },
    type: { type: "string", get description() { return workbenchT("upsertResourceType"); } },
    get title() { return { type: "string", description: workbenchT("upsertResourceTitle") } as const; },
    get description() { return { type: "string", description: workbenchT("upsertResourceDescription") } as const; },
    get content() { return { type: "string", description: workbenchT("upsertContent") } as const; },
    oldText: { type: "string", get description() { return workbenchT("resourceOldText"); } },
    newText: { type: "string", get description() { return workbenchT("resourceNewText"); } },
    edits: {
      type: "array",
      get description() { return workbenchT("resourceEdits"); },
      items: {
        type: "object",
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
      },
    },
  },
  required: ["path"],
} as const;

export const SKILL_AUTHOR_TOOL_PARAMETERS = {
  create: {
    type: "object",
    properties: {
      name: { type: "string", get description() { return workbenchT("skillName"); } },
      get displayName() { return { type: "string", description: workbenchT("displayName") } as const; },
      get description() { return { type: "string", description: workbenchT("skillPurpose") } as const; },
      scope: { type: "string", enum: ["resident", "global", "site"], get description() { return workbenchT("scope"); } },
      domains: { type: "array", items: { type: "string" }, get description() { return workbenchT("domains"); } },
      urlPatterns: { type: "array", items: { type: "string" }, get description() { return workbenchT("urlPatterns"); } },
      excludePatterns: { type: "array", items: { type: "string" }, get description() { return workbenchT("excludePatterns"); } },
      get content() { return { type: "string", description: workbenchT("skillContent") } as const; },
    },
    required: ["name", "description", "content"],
  },
  editResource: {
    type: "object",
    properties: {
      name: { type: "string", get description() { return workbenchT("resourceOwner"); } },
      path: { type: "string", get description() { return workbenchT("resourcePathFirst"); } },
      action: { type: "string", enum: ["set", "replace", "append", "prepend", "rename", "delete"], get description() { return workbenchT("editAction"); } },
      newPath: { type: "string", get description() { return workbenchT("newResourcePath"); } },
      type: { type: "string", get description() { return workbenchT("setResourceType"); } },
      get title() { return { type: "string", description: workbenchT("setResourceTitle") } as const; },
      get description() { return { type: "string", description: workbenchT("setResourceDescription") } as const; },
      oldText: { type: "string", get description() { return workbenchT("exactOldText"); } },
      newText: { type: "string", get description() { return workbenchT("exactNewText"); } },
      appendText: { type: "string", get description() { return workbenchT("appendText"); } },
      prependText: { type: "string", get description() { return workbenchT("prependText"); } },
      get content() { return { type: ["string", "object", "array", "number", "boolean"], description: workbenchT("setContent") } as const; },
    },
    required: ["name", "path", "action"],
  },
  update: {
    type: "object",
    properties: {
      name: { type: "string", get description() { return workbenchT("updateName"); } },
      renameTo: { type: "string", get description() { return workbenchT("renameTo"); } },
      get displayName() { return { type: "string", description: workbenchT("updateDisplayName") } as const; },
      get description() { return { type: "string", description: workbenchT("updateDescription") } as const; },
      scope: { type: "string", enum: ["resident", "global", "site"], get description() { return workbenchT("updateScope"); } },
      status: { type: "string", get description() { return workbenchT("updateStatus"); } },
      domains: { type: "array", items: { type: "string" }, get description() { return workbenchT("updateDomains"); } },
      urlPatterns: { type: "array", items: { type: "string" }, get description() { return workbenchT("updatePatterns"); } },
      excludePatterns: { type: "array", items: { type: "string" }, get description() { return workbenchT("updateExclusions"); } },
      oldText: { type: "string", get description() { return workbenchT("updateOldText"); } },
      newText: { type: "string", get description() { return workbenchT("updateNewText"); } },
      prependContent: { type: "string", get description() { return workbenchT("prependContent"); } },
      appendContent: { type: "string", get description() { return workbenchT("appendContent"); } },
    },
    required: ["name"],
  },
  delete: {
    type: "object",
    properties: {
      name: { type: "string", get description() { return workbenchT("deleteName"); } },
    },
    required: ["name"],
  },
  list: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["all", "global", "site", "resident"],
        get description() { return workbenchT("listScope"); },
      },
    },
  },
  importPageZip: {
    type: "object",
    properties: {
      url: { type: "string", get description() { return workbenchT("zipUrl"); } },
      overwrite: { type: "boolean", get description() { return workbenchT("zipOverwrite"); } },
    },
    required: ["url"],
  },
  importGitRepository: {
    type: "object",
    properties: {
      repositoryUrl: { type: "string", get description() { return workbenchT("repositoryUrl"); } },
      overwrite: { type: "boolean", get description() { return workbenchT("gitOverwrite"); } },
    },
    required: ["repositoryUrl"],
  },
  installToGit: {
    type: "object",
    properties: {
      name: { type: "string", get description() { return workbenchT("installName"); } },
      repositoryUrl: { type: "string", get description() { return workbenchT("publishUrl"); } },
      commitMessage: { type: "string", get description() { return workbenchT("commitMessage"); } },
    },
    required: ["name", "repositoryUrl"],
  },
} as const;

export const SKILL_AUTHOR_ACTIONS: Readonly<Record<string, string>> = {
  create_skill: "create",
  edit_skill_resource: "edit_resource",
  update_skill: "update",
  delete_skill: "delete",
  list_skills: "list_skills",
};
const SKILL_RESOURCE_EDIT_FIELDS = [
  "action", "path", "newPath", "type", "title", "description", "content",
  "oldText", "newText", "appendText", "prependText",
];
export function skillResourceEditArgs(args: Record<string, unknown>) {
  return Object.fromEntries(SKILL_RESOURCE_EDIT_FIELDS.map(key => [key, args[key]]));
}

const getSkillAuthorToolManifest = () => ({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "qingzhou-skill-author",
  get displayName() { return workbenchT("name"); },
  version: "0.2.0",
  get description() { return workbenchT("manifestDescription"); },
  category: { id: "meta", get label() { return workbenchT("system"); } },
  tools: [
    {
      name: "load_available_renderers",
      get title() { return workbenchT("listRenderers"); },
      get description() { return workbenchT("listRenderersDescription"); },
      script: "scripts/load-available-renderers.js",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "list_skills",
      get title() { return workbenchT("listSkills"); },
      get description() { return workbenchT("listSkillsDescription"); },
      script: "scripts/list-skills.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.list,
    },
    {
      name: "import_page_zip",
      get title() { return workbenchT("importZip"); },
      get description() { return workbenchT("importZipDescription"); },
      script: "scripts/import-page-zip.js",
      needsPage: true,
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.importPageZip,
    },
    {
      name: "import_git_repository",
      get title() { return workbenchT("importGit"); },
      get description() { return workbenchT("importGitDescription"); },
      script: "scripts/import-git-repository.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.importGitRepository,
    },
    {
      name: "install_skill_to_git",
      get title() { return workbenchT("installGit"); },
      get description() { return workbenchT("installGitDescription"); },
      script: "scripts/install-skill-to-git.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.installToGit,
    },
    {
      name: "create_skill",
      get title() { return workbenchT("createSkill"); },
      get description() { return workbenchT("createSkillDescription"); },
      script: "scripts/create-skill.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.create,
    },
    {
      name: "edit_skill_resource",
      get title() { return workbenchT("editResource"); },
      get description() { return workbenchT("editResourceDescription"); },
      script: "scripts/edit-skill-resource.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.editResource,
    },
    {
      name: "update_skill",
      get title() { return workbenchT("updateSkill"); },
      get description() { return workbenchT("updateSkillDescription"); },
      script: "scripts/update-skill.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.update,
    },
    {
      name: "delete_skill",
      get title() { return workbenchT("deleteSkill"); },
      get description() { return workbenchT("deleteSkillDescription"); },
      script: "scripts/delete-skill.js",
      parameters: SKILL_AUTHOR_TOOL_PARAMETERS.delete,
    },
  ].map(tool => ({ runtime: "host", needsPage: false, ...tool })),
  renderers: {
    tools: {
      ...Object.fromEntries([
        ["create_skill", "create", workbenchT("preparingCreate"), workbenchT("created"), workbenchT("createFailed")],
        ["edit_skill_resource", "edit_resource", workbenchT("preparingEdit"), workbenchT("edited"), workbenchT("editFailed")],
        ["update_skill", "update", workbenchT("preparingUpdate"), workbenchT("updated"), workbenchT("updateFailed")],
        ["delete_skill", "delete", workbenchT("preparingDelete"), workbenchT("deleted"), workbenchT("deleteFailed")],
      ].map(([name, action, preparing, completed, error]) => [name, {
        type: "skill", action,
        states: {
          preparing: { get title() { return preparing; } },
          completed: { get title() { return completed; } },
          error: { get title() { return error; } },
        },
      }])),
      load_available_renderers: {
        type: "table",
        get title() { return workbenchT("availableRenderers"); },
        itemsPath: "renderers",
        columns: [
          { "label": workbenchT("type"), "path": "type" },
          { "label": workbenchT("displayTitle"), "path": "title" },
          { "label": workbenchT("returnShape"), "path": "returnShape" },
          { "label": workbenchT("purpose"), "path": "description" }
        ]
      },
      list_skills: {
        type: "table",
        get title() { return workbenchT("skillList"); },
        itemsPath: "items",
        columns: [
          { "label": workbenchT("displayTitle"), "path": "name" }
        ]
      },
      import_page_zip: {
        type: "summary",
        get title() { return workbenchT("pagePackage"); },
        titlePath: "names.0",
        subtitlePath: "url",
        fields: [
          { "label": workbenchT("imported"), "path": "count" },
          { "label": workbenchT("overwritten"), "path": "overwrittenCount" }
        ]
      },
      import_git_repository: {
        type: "summary",
        get title() { return workbenchT("gitSource"); },
        titlePath: "source.name",
        subtitlePath: "source.browseUrl",
        fields: [
          { "label": workbenchT("skills"), "path": "count" },
          { "label": workbenchT("action"), "path": "action" },
          { "label": workbenchT("branch"), "path": "source.branch" }
        ]
      },
      install_skill_to_git: {
        type: "summary",
        get title() { return workbenchT("installed"); },
        titlePath: "skillName",
        subtitlePath: "targetPath",
        fields: [
          { "label": workbenchT("files"), "path": "fileCount" },
          { "label": workbenchT("added"), "path": "createdCount" },
          { "label": workbenchT("changed"), "path": "updatedCount" },
          { "label": "Commit", "path": "shortId" }
        ]
      },
    },
  },
});

const SKILL_AUTHOR_SCRIPT_PAYLOAD = `const payload = { ...args };
delete payload.$plugin;
delete payload.timeout;
delete payload.timeoutMs;`;
const SKILL_AUTHOR_SCRIPTS = {
  "scripts/create-skill.js": `${SKILL_AUTHOR_SCRIPT_PAYLOAD}
return await tools.manage_skill({ ...payload, action: "create" });`,
  "scripts/edit-skill-resource.js": `${SKILL_AUTHOR_SCRIPT_PAYLOAD}
const resourceEdit = Object.fromEntries(${JSON.stringify(SKILL_RESOURCE_EDIT_FIELDS)}.map(key => [key, payload[key]]));
return await tools.manage_skill({ name: payload.name, action: "update", resourceEdits: [resourceEdit] });`,
  "scripts/update-skill.js": `${SKILL_AUTHOR_SCRIPT_PAYLOAD}
return await tools.manage_skill({ ...payload, action: "update" });`,
  "scripts/delete-skill.js": `const payload = { name: args.name };
return await tools.manage_skill({ ...payload, action: "delete" });`,
  "scripts/list-skills.js": `const scope = args.scope || "all";
return await tools.manage_skill({ action: "list_skills", scope });`,
  "scripts/load-available-renderers.js": `// Host-handled by qingzhou-skill-author:load_available_renderers.
return { ok: true };`,
  "scripts/import-page-zip.js": `const payload = { url: args.url, overwrite: args.overwrite === true };
return await tools.import_skill_from_page_zip(payload);`,
  "scripts/import-git-repository.js": `const opened = await tools.open_tab({ url: args.repositoryUrl });
return await tools.import_git_skill_repository({
  repositoryUrl: args.repositoryUrl,
  tabRef: opened.id,
  overwrite: args.overwrite === true,
});`,
  "scripts/install-skill-to-git.js": `const opened = await tools.open_tab({ url: args.repositoryUrl });
await tools.use_tab({ tabRef: opened.id });
return await tools.install_skill_to_git({
  name: args.name,
  tabRef: opened.id,
  commitMessage: args.commitMessage,
});`,
};

const workbench = {
    name: BUILTIN_SKILL_WORKBENCH_NAME,
    aliases: ["技能工作台", "Skill workbench"],
    get description() { return workbenchT("workbenchDescription"); },
    get displayName() { return getBuiltinSkillWorkbenchDisplayName(); },
    get content() { return getSkillWorkbenchContent(); },
    get resources() { return [
      {
        path: "plugin.json",
        type: "json",
        title: workbenchT("manifestTitle"),
        description: workbenchT("manifestPurpose"),
        content: JSON.stringify(getSkillAuthorToolManifest(), null, 2),
      },
      ...Object.entries(SKILL_AUTHOR_SCRIPTS).map(([path, content]) => ({
        path,
        type: "script",
        title: path.split("/").pop(),
        description: workbenchT("scriptPurpose"),
        content,
      })),
    ]; },
    order: 0,
};
export default workbench;
