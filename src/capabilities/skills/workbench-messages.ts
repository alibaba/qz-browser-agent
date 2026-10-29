import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Builtin authoring documentation and manifest labels, separate from DOM translations. */
const messages = defineMessages("skill-workbench", {
  "name": {
    "zh-CN": "技能工作台",
    "en": "Skill workbench"
  },
  "oldContent": {
    "zh-CN": "当前 Skill Markdown 正文中唯一存在的原文片段",
    "en": "An exact excerpt that occurs once in the current Skill Markdown."
  },
  "newContent": {
    "zh-CN": "替换后的正文片段",
    "en": "Replacement Markdown excerpt."
  },
  "resourcePath": {
    "zh-CN": "资源路径，如 plugin.json、scripts/collect.js 或 references/checklist.md",
    "en": "Resource path, such as plugin.json, scripts/collect.js, or references/checklist.md."
  },
  "resourceType": {
    "zh-CN": "资源类型，如 json/script/markdown/asset",
    "en": "Resource type, such as json/script/markdown/asset."
  },
  "resourceTitle": {
    "zh-CN": "显示标题",
    "en": "Display title."
  },
  "resourceDescription": {
    "zh-CN": "用途说明",
    "en": "Description of the resource's purpose."
  },
  "resourceContent": {
    "zh-CN": "资源内容；script 须为浏览器 JS（推荐单个 async () => { ... } 表达式），先填 path/title 再填长 content。",
    "en": "Resource content; scripts must be browser JS (prefer a single async () => { ... } expression). Supply path/title before long content."
  },
  "resourceAction": {
    "zh-CN": "资源操作：upsert/set 整体写入；replace/patch/edit 精确替换；rename 重命名；delete/remove 删除（仅传 path+content 时默认 set）。",
    "en": "Resource action: upsert/set writes full content; replace/patch/edit replaces exact text; rename renames; delete/remove deletes (defaults to set when only path+content is supplied)."
  },
  "shortResourcePath": {
    "zh-CN": "资源路径，如 plugin.json 或 scripts/collect.js",
    "en": "Resource path, such as plugin.json or scripts/collect.js."
  },
  "newResourcePath": {
    "zh-CN": "rename 时的新资源路径。",
    "en": "New resource path for rename."
  },
  "upsertResourceType": {
    "zh-CN": "可选资源类型，如 script/json/markdown/asset。",
    "en": "Optional resource type, such as script/json/markdown/asset."
  },
  "upsertResourceTitle": {
    "zh-CN": "可选显示标题。",
    "en": "Optional display title."
  },
  "upsertResourceDescription": {
    "zh-CN": "可选用途说明。",
    "en": "Optional purpose description."
  },
  "upsertContent": {
    "zh-CN": "upsert/set 的完整资源内容（不可与 replace 的 oldText/newText 同用）。",
    "en": "Full resource content for upsert/set (do not combine with oldText/newText)."
  },
  "resourceOldText": {
    "zh-CN": "replace/patch/edit 的唯一旧文本片段。",
    "en": "Unique old text excerpt for replace/patch/edit."
  },
  "resourceNewText": {
    "zh-CN": "replace/patch/edit 的新文本片段。",
    "en": "Replacement text for replace/patch/edit."
  },
  "resourceEdits": {
    "zh-CN": "基于同一份原始资源 content 的多处精确替换数组。",
    "en": "Array of exact replacements matched against the same original resource content."
  },
  "skillName": {
    "zh-CN": "必填。Skill 标准英文小写 id（仅含 a-z、0-9 和连字符，如 bilibili-video-search）。",
    "en": "Required lowercase English Skill ID (a-z, 0-9, and hyphens only, e.g. bilibili-video-search)."
  },
  "displayName": {
    "zh-CN": "中文显示名（创建中文技能时必须填写，不要只写在正文标题中）。",
    "en": "Localized display name (supply explicitly for Chinese skills rather than only in the Markdown heading)."
  },
  "skillPurpose": {
    "zh-CN": "必填。一句话描述 Skill 的用途与触发场景。",
    "en": "Required one-sentence description of the Skill's purpose and trigger scenario."
  },
  "scope": {
    "zh-CN": "作用域：resident（常驻注入系统上下文）、global（按需加载）或 site（按域名/URL 激活）。",
    "en": "Scope: resident (always injected), global (loaded on demand), or site (activated by domain/URL)."
  },
  "domains": {
    "zh-CN": "scope=site 的适用域名数组。",
    "en": "Domains array for scope=site."
  },
  "urlPatterns": {
    "zh-CN": "scope=site 的 URL/path 匹配数组。",
    "en": "URL/path patterns array for scope=site."
  },
  "excludePatterns": {
    "zh-CN": "scope=site 的 URL/path 排除数组。",
    "en": "Excluded URL/path patterns array for scope=site."
  },
  "skillContent": {
    "zh-CN": "必填。完整 Skill Markdown 正文（写清流程、前置导航、状态校验、工具调用时机与失败回退）。该字段可能很长，必须在元信息字段之后最后填写。",
    "en": "Required complete Skill Markdown body (workflow, prerequisite navigation, state checks, when to call tools, and fallbacks). This field may be long; supply it last after metadata fields."
  },
  "resourceOwner": {
    "zh-CN": "必填。目标 Skill 名称。",
    "en": "Required target Skill name."
  },
  "resourcePathFirst": {
    "zh-CN": "必填。资源相对路径（如 plugin.json、scripts/collect.js、references/checklist.md；必须先填写）。",
    "en": "Required relative resource path (e.g. plugin.json, scripts/collect.js, references/checklist.md; supply before content)."
  },
  "editAction": {
    "zh-CN": "必填。编辑动作：set（新增或全量覆盖）、replace（单次精确替换）、append/prepend（首尾追加）、rename（重命名）、delete（删除）。",
    "en": "Required edit action: set (create or overwrite), replace (single exact replacement), append/prepend (add at end/start), rename, or delete."
  },
  "setResourceType": {
    "zh-CN": "set/rename 可选资源类型（json/script/markdown/asset）。",
    "en": "Optional resource type for set/rename (json/script/markdown/asset)."
  },
  "setResourceTitle": {
    "zh-CN": "set/rename 可选显示标题。",
    "en": "Optional display title for set/rename."
  },
  "setResourceDescription": {
    "zh-CN": "set/rename 可选用途说明。",
    "en": "Optional purpose description for set/rename."
  },
  "exactOldText": {
    "zh-CN": "replace 必填的旧文本片段（从刚读取的资源 content 中原样复制最小唯一连续片段）。",
    "en": "Required old text for replace (copy the smallest unique contiguous excerpt verbatim from the freshly read resource)."
  },
  "exactNewText": {
    "zh-CN": "replace 必填的新文本片段。",
    "en": "Required replacement text for replace."
  },
  "appendText": {
    "zh-CN": "append 追加到末尾的文本。",
    "en": "Text to append for append."
  },
  "prependText": {
    "zh-CN": "prepend 添加到开头的文本。",
    "en": "Text to prepend for prepend."
  },
  "setContent": {
    "zh-CN": "set 时的完整资源内容（文本或可序列化 JSON）。path=plugin.json 时，settings.fields[].type 只支持 text|secret|url|boolean|number|select，width 只支持 full|half，分组用 settings.layout.sections（完整约束见已加载 skill-workbench）；script 资源须为浏览器 JS（推荐单个 async () => { ... } 表达式）。一次调用只改一个资源，先填 path/type/title/description，最后填写本字段。",
    "en": "Full resource content for set (string or serializable JSON). For path=plugin.json, settings.fields[].type supports text|secret|url|boolean|number|select, width supports full|half, and sections use settings.layout.sections (see the loaded skill-workbench for the full contract); scripts must be browser JS (prefer a single async () => { ... } expression). Edit one resource per call, supplying path/type/title/description first and this field last."
  },
  "updateName": {
    "zh-CN": "必填。要更新的 Skill 名称。",
    "en": "Required name of the Skill to update."
  },
  "renameTo": {
    "zh-CN": "可选新 Skill 英文 ID。",
    "en": "Optional new lowercase English Skill ID."
  },
  "updateDisplayName": {
    "zh-CN": "可选：更新中文显示名（保持 name 为英文 id）。",
    "en": "Optional new localized display name (keep name as an English ID)."
  },
  "updateDescription": {
    "zh-CN": "可选新用途描述。",
    "en": "Optional updated purpose description."
  },
  "updateScope": {
    "zh-CN": "可选新作用域（resident/global/site）。",
    "en": "Optional updated scope (resident/global/site)."
  },
  "updateStatus": {
    "zh-CN": "可选状态（active/disabled）。",
    "en": "Optional status (active/disabled)."
  },
  "updateDomains": {
    "zh-CN": "可选：替换适用域名数组。",
    "en": "Optional replacement domains array."
  },
  "updatePatterns": {
    "zh-CN": "可选：替换 URL/path 匹配数组。",
    "en": "Optional replacement URL/path patterns array."
  },
  "updateExclusions": {
    "zh-CN": "可选：替换排除规则数组。",
    "en": "Optional replacement exclusion patterns array."
  },
  "updateOldText": {
    "zh-CN": "可选：Skill Markdown 正文单次精确替换的唯一旧文本（只改正文，不改资源）。",
    "en": "Optional unique old text for one exact replacement in Skill Markdown (modifies Markdown body only, not resources)."
  },
  "updateNewText": {
    "zh-CN": "可选：Skill Markdown 正文单次精确替换的新文本。",
    "en": "Optional replacement text for Skill Markdown."
  },
  "prependContent": {
    "zh-CN": "可选：添加到 Markdown 正文开头的文本。",
    "en": "Optional text to prepend to the Markdown body."
  },
  "appendContent": {
    "zh-CN": "可选：追加到 Markdown 正文末尾的文本。",
    "en": "Optional text to append to the Markdown body."
  },
  "deleteName": {
    "zh-CN": "必填。要删除的用户自定义 Skill 名称。",
    "en": "Required name of the user-created Skill to delete."
  },
  "listScope": {
    "zh-CN": "要列出的 Skill 范围（all/global/site/resident），默认 all。",
    "en": "Skill scope to list (all/global/site/resident). Default: all."
  },
  "zipUrl": {
    "zh-CN": "必填。当前工作标签页上已确认的 Skill Zip 完整 http(s) 下载地址（复用该页认证态）。",
    "en": "Required confirmed http(s) Skill ZIP download URL from the current working tab (reuses that tab's authenticated context)."
  },
  "zipOverwrite": {
    "zh-CN": "是否覆盖本地同名 Skill，默认 false（仅用户明确确认后传 true）。",
    "en": "Overwrite local Skills with the same name. Default: false (pass true only after explicit user confirmation)."
  },
  "repositoryUrl": {
    "zh-CN": "必填。支持的 GitHub 或 GitLab 仓库根页或 tree 目录页 URL。",
    "en": "Required supported GitHub or GitLab repository root or tree directory URL."
  },
  "gitOverwrite": {
    "zh-CN": "是否覆盖同名或含本地修改的 Skill，默认 false（仅用户明确确认后传 true）。",
    "en": "Overwrite same-name or locally modified Skills. Default: false (pass true only after explicit user confirmation)."
  },
  "installName": {
    "zh-CN": "必填。要安装到 Git 仓库的本地 Skill 名称。",
    "en": "Required local Skill name to install into Git."
  },
  "publishUrl": {
    "zh-CN": "必填。发布适配器支持的 Git 仓库根页或 tree 目录页 URL。",
    "en": "Required repository root or tree directory URL supported by the publishing adapter."
  },
  "commitMessage": {
    "zh-CN": "可选 Git commit message；省略时使用默认提交说明。",
    "en": "Optional Git commit message; uses a default message if omitted."
  },
  "manifestDescription": {
    "zh-CN": "通用轻舟 skill 的创建、更新、删除、列出、包导入和 Git 分发工具。适用：用户要创建、修改、删除某个已指定的 skill，或导入 skill、编辑其 content、plugin.json、scripts、resources、把本地 Skill 安装到 Git；给具体网站生成站点 skill、Skill 工具、采集工具或网页操作能力时使用 site-skill-author。",
    "en": "Create, update, delete, list, import, and distribute qz Skills through Git. Use for managing a specified Skill, editing content/plugin.json/scripts/resources, importing packages, or installing a local Skill into Git. Use site-skill-author to build site-specific Skills, tools, collectors, or page actions."
  },
  "system": {
    "zh-CN": "系统",
    "en": "System"
  },
  "listRenderers": {
    "zh-CN": "读取可用渲染器",
    "en": "List available renderers"
  },
  "listRenderersDescription": {
    "zh-CN": "读取轻舟支持的 UI renderer 类型、用途与返回 JSON schema（设计带 UI 的 Skill 工具前先调用）。",
    "en": "List supported UI renderer types, purposes, and return JSON schemas (call before designing a Skill tool with a result UI)."
  },
  "listSkills": {
    "zh-CN": "列出技能",
    "en": "List skills"
  },
  "listSkillsDescription": {
    "zh-CN": "按 all/global/site/resident 列出已安装的 Skill 名称，避免重复创建或误改。",
    "en": "List installed Skill names by all/global/site/resident to avoid duplicate creation or unintended edits."
  },
  "importZip": {
    "zh-CN": "导入页面 Zip",
    "en": "Import Skill ZIP from page"
  },
  "importZipDescription": {
    "zh-CN": "使用当前任务工作标签页的认证上下文下载并导入已确认的 Skill Zip URL（不探测或猜测 URL，默认不覆盖同名 Skill）。",
    "en": "Download and import a confirmed Skill ZIP URL using the current working tab's authenticated context (does not scan or guess URLs; refuses to overwrite by default)."
  },
  "importGit": {
    "zh-CN": "探测并导入 Git 仓库",
    "en": "Inspect and import Git repository"
  },
  "importGitDescription": {
    "zh-CN": "打开支持的 GitHub/GitLab 仓库或目录页，下载并导入其中的 Skill，绑定为可更新的 Git 来源。",
    "en": "Open a supported GitHub/GitLab repository or directory page, import its Skills, and bind them as an updatable Git source."
  },
  "installGit": {
    "zh-CN": "安装 Skill 到 Git",
    "en": "Install Skill into Git"
  },
  "installGitDescription": {
    "zh-CN": "将已保存的本地 Skill 写入受支持 Git 仓库根页或 tree 目录并提交一次 commit（仅在用户明确要求提交到仓库时调用）。",
    "en": "Write a saved local Skill to a supported Git repository root or tree directory in a single commit (call only when explicitly requested by the user)."
  },
  "createSkill": {
    "zh-CN": "创建技能",
    "en": "Create skill"
  },
  "createSkillDescription": {
    "zh-CN": "创建新 Skill 的 Markdown 正文（content）和顶层元信息。带工具的 Skill 先用本工具创建正文，再用 edit_skill_resource 逐个写入 plugin.json、scripts/*.js 或 references/*.md。",
    "en": "Create a new Skill's Markdown body (content) and top-level metadata. For a Skill with tools, create the body here first, then write plugin.json, scripts/*.js, or references/*.md one at a time with edit_skill_resource."
  },
  "editResource": {
    "zh-CN": "编辑技能资源",
    "en": "Edit skill resource"
  },
  "editResourceDescription": {
    "zh-CN": "新增、整体覆盖（set）、局部替换（replace）、首尾追加（prepend/append）、重命名（rename）或删除（delete）Skill 的单个资源文件（plugin.json、scripts/*.js、references/*.md）。每次调用只编辑一个资源、执行一个 action。",
    "en": "Create, overwrite (set), replace text in (replace), prepend/append, rename, or delete a single Skill resource file (plugin.json, scripts/*.js, references/*.md). Edit one resource with one action per call."
  },
  "updateSkill": {
    "zh-CN": "更新技能",
    "en": "Update skill"
  },
  "updateSkillDescription": {
    "zh-CN": "更新已有 Skill 的顶层元信息或 Markdown 正文（用 oldText/newText 做单次精确替换，或用 prependContent/appendContent 追加；编辑资源文件请用 edit_skill_resource）。",
    "en": "Update an existing Skill's metadata or Markdown body (use oldText/newText for a single exact replacement, or prependContent/appendContent; use edit_skill_resource for resource files)."
  },
  "deleteSkill": {
    "zh-CN": "删除技能",
    "en": "Delete skill"
  },
  "deleteSkillDescription": {
    "zh-CN": "删除一个用户自定义 Skill（内置系统 Skill 不可删除）。",
    "en": "Delete a user-created Skill (built-in system Skills cannot be deleted)."
  },
  "preparingCreate": {
    "zh-CN": "准备创建技能",
    "en": "Preparing to create skill"
  },
  "created": {
    "zh-CN": "技能已创建",
    "en": "Skill created"
  },
  "createFailed": {
    "zh-CN": "技能创建失败",
    "en": "Could not create skill"
  },
  "preparingEdit": {
    "zh-CN": "准备编辑资源",
    "en": "Preparing to edit resource"
  },
  "edited": {
    "zh-CN": "资源已编辑",
    "en": "Resource edited"
  },
  "editFailed": {
    "zh-CN": "资源编辑失败",
    "en": "Could not edit resource"
  },
  "preparingUpdate": {
    "zh-CN": "准备更新技能",
    "en": "Preparing to update skill"
  },
  "updated": {
    "zh-CN": "技能已更新",
    "en": "Skill updated"
  },
  "updateFailed": {
    "zh-CN": "技能更新失败",
    "en": "Could not update skill"
  },
  "preparingDelete": {
    "zh-CN": "准备删除技能",
    "en": "Preparing to delete skill"
  },
  "deleted": {
    "zh-CN": "技能已删除",
    "en": "Skill deleted"
  },
  "deleteFailed": {
    "zh-CN": "技能删除失败",
    "en": "Could not delete skill"
  },
  "availableRenderers": {
    "zh-CN": "可用渲染器",
    "en": "Available renderers"
  },
  "type": {
    "zh-CN": "类型",
    "en": "Type"
  },
  "displayTitle": {
    "zh-CN": "名称",
    "en": "Name"
  },
  "returnShape": {
    "zh-CN": "返回结构",
    "en": "Return structure"
  },
  "purpose": {
    "zh-CN": "用途",
    "en": "Purpose"
  },
  "skillList": {
    "zh-CN": "技能列表",
    "en": "Skills"
  },
  "pagePackage": {
    "zh-CN": "页面 Skill 包",
    "en": "Skill package from page"
  },
  "imported": {
    "zh-CN": "导入",
    "en": "Imported"
  },
  "overwritten": {
    "zh-CN": "覆盖",
    "en": "Overwritten"
  },
  "gitSource": {
    "zh-CN": "Git Skill 来源",
    "en": "Git Skill source"
  },
  "skills": {
    "zh-CN": "技能",
    "en": "Skills"
  },
  "action": {
    "zh-CN": "动作",
    "en": "Action"
  },
  "branch": {
    "zh-CN": "分支",
    "en": "Branch"
  },
  "installed": {
    "zh-CN": "Skill 已安装到 Git",
    "en": "Skill installed into Git"
  },
  "files": {
    "zh-CN": "文件",
    "en": "Files"
  },
  "added": {
    "zh-CN": "新增",
    "en": "Added"
  },
  "changed": {
    "zh-CN": "更新",
    "en": "Updated"
  },
  "workbenchDescription": {
    "zh-CN": "通用轻舟 skill 管理工作台。适用：用户要创建、更新、删除某个 skill，或编辑某个 skill 的 content、plugin.json、scripts、resources、导入 skill、探测并导入 Git Skill 仓库、把本地 Skill 安装到 Git。与 site-skill-author 区别：本 skill 面向已指定 skill 的管理、包导入和分发；给具体网站生成站点能力时使用 site-skill-author。",
    "en": "Manage qz Skills: create, update, delete, edit content/plugin.json/scripts/resources, import packages, inspect and import Git repositories, or install a local Skill into Git. This skill manages specified Skills and their distribution; use site-skill-author to build capabilities for a particular website."
  },
  "manifestTitle": {
    "zh-CN": "技能工作台 Skill 工具清单",
    "en": "Skill workbench tool manifest"
  },
  "manifestPurpose": {
    "zh-CN": "声明创建、更新、删除 skill 的 meta-skill Skill 工具与 UI。",
    "en": "Declares the meta-skill's authoring tools and result views."
  },
  "scriptPurpose": {
    "zh-CN": "技能工作台 host runtime 脚本。",
    "en": "Skill workbench host-runtime script."
  }
});

export const workbenchT = createTranslator(messages);
