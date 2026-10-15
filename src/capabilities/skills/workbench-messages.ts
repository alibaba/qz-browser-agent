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
    "zh-CN": "资源内容；script 资源必须是轻舟 page/inner 浏览器 JS，推荐 async () => { ... } 源码形态。生成 script 资源时先填 path/title，再填长 content。",
    "en": "Resource content. Scripts must be browser JavaScript for qz's page/inner runtime, preferably one async () => { ... } expression. Supply path/title before the long script content."
  },
  "resourceAction": {
    "zh-CN": "资源操作。upsert/set 添加或完整更新资源；replace/patch/edit 做精确文本替换；rename 重命名；delete/remove 删除。若只传 path+content 且无 oldText/edits，默认 set。",
    "en": "Resource operation. upsert/set adds or replaces a resource; replace/patch/edit performs exact text replacements; rename renames; delete/remove deletes. Defaults to set when only path+content is supplied, without oldText/edits."
  },
  "shortResourcePath": {
    "zh-CN": "资源路径，如 plugin.json 或 scripts/collect.js",
    "en": "Resource path, such as plugin.json or scripts/collect.js."
  },
  "newResourcePath": {
    "zh-CN": "rename 时的新资源路径",
    "en": "New resource path for rename."
  },
  "upsertResourceType": {
    "zh-CN": "upsert/set/rename 时可更新资源类型，如 script/json/markdown/asset",
    "en": "Optional resource type for upsert/set/rename, such as script/json/markdown/asset."
  },
  "upsertResourceTitle": {
    "zh-CN": "upsert/set/rename 时可更新显示标题",
    "en": "Optional display title for upsert/set/rename."
  },
  "upsertResourceDescription": {
    "zh-CN": "upsert/set/rename 时可更新用途说明",
    "en": "Optional purpose description for upsert/set/rename."
  },
  "upsertContent": {
    "zh-CN": "upsert/set 时设置完整资源内容；script 必须是轻舟 page/inner 浏览器 JS。不要和 replace 的 oldText/newText 混用。",
    "en": "Full resource content for upsert/set. Scripts must be browser JavaScript for qz's page/inner runtime. Do not combine with oldText/newText used by replace."
  },
  "resourceOldText": {
    "zh-CN": "replace/patch/edit 时的单次旧文本；在资源 content 中唯一匹配",
    "en": "Old text for one replace/patch/edit operation. Must match exactly once in the resource content."
  },
  "resourceNewText": {
    "zh-CN": "replace/patch/edit 时的单次新文本",
    "en": "New text for one replace/patch/edit operation."
  },
  "resourceEdits": {
    "zh-CN": "replace/patch/edit 时的多个精确替换，匹配同一份原始资源 content",
    "en": "Multiple exact replacements for replace/patch/edit, all matched against the same original resource content."
  },
  "skillName": {
    "zh-CN": "skill 标准名，稳定英文小写 id，只用 a-z、0-9 和连字符，例如 bilibili-video-search",
    "en": "Standard Skill name: a stable lowercase English ID containing only a-z, 0-9, and hyphens, such as bilibili-video-search."
  },
  "displayName": {
    "zh-CN": "中文显示名，例如 B站视频搜索。创建中文技能时必须填写；不要只把中文放在 SKILL.md 标题里。",
    "en": "Localized display name, such as Bilibili video search. For Chinese skills, supply the Chinese displayName explicitly rather than putting it only in the SKILL.md heading."
  },
  "skillPurpose": {
    "zh-CN": "一句话描述 skill 的用途",
    "en": "One-sentence description of the Skill's purpose."
  },
  "scope": {
    "zh-CN": "resident=常驻技能，用于系统指令调整、长久记忆信息、个人偏好或交付标准；global=全局按需加载；site=站点技能",
    "en": "resident: always-loaded guidance for system instructions, persistent knowledge, preferences, or delivery standards; global: loaded on demand; site: site-specific skill."
  },
  "domains": {
    "zh-CN": "site skill 适用域名",
    "en": "Domains where the site skill applies."
  },
  "urlPatterns": {
    "zh-CN": "site skill URL/path 匹配",
    "en": "URL/path patterns matched by the site skill."
  },
  "excludePatterns": {
    "zh-CN": "site skill URL/path 排除",
    "en": "URL/path patterns excluded from the site skill."
  },
  "skillContent": {
    "zh-CN": "完整 Skill Markdown 正文。写过程知识、前置导航、页面状态判断、失败回退；如有 Skill 工具，再写清何时调用。该字段可能很长，必须在 name/displayName/description/scope/domains/urlPatterns/excludePatterns 之后最后填写。",
    "en": "Complete Skill Markdown: procedures, prerequisite navigation, page-state checks, recovery steps, and when to call any Skill tools. This may be long; supply it last, after name/displayName/description/scope/domains/urlPatterns/excludePatterns."
  },
  "resourceOwner": {
    "zh-CN": "要编辑资源的 skill 名称",
    "en": "Name of the Skill whose resource will be edited."
  },
  "resourcePathFirst": {
    "zh-CN": "资源路径，如 plugin.json、scripts/collect.js 或 references/checklist.md。必须先填写，便于用户先看到要写哪个文件。",
    "en": "Resource path, such as plugin.json, scripts/collect.js, or references/checklist.md. Supply this first so the user can see which file will be written."
  },
  "editAction": {
    "zh-CN": "资源编辑动作。set=新增或整体替换；replace=一次精确文本替换；append/prepend=追加/前置文本；rename=重命名；delete=删除。",
    "en": "Resource edit action. set: add or fully replace; replace: one exact text replacement; append/prepend: add text at the end/start; rename: rename; delete: remove."
  },
  "setResourceType": {
    "zh-CN": "set/rename 时可更新资源类型，如 json/script/markdown/asset",
    "en": "Optional resource type for set/rename, such as json/script/markdown/asset."
  },
  "setResourceTitle": {
    "zh-CN": "set/rename 时可更新显示标题",
    "en": "Optional display title for set/rename."
  },
  "setResourceDescription": {
    "zh-CN": "set/rename 时可更新用途说明",
    "en": "Optional purpose description for set/rename."
  },
  "exactOldText": {
    "zh-CN": "replace 时的旧文本；从刚读取的资源 content 中原样复制最小但唯一的连续片段",
    "en": "Old text for replace. Copy the smallest unique contiguous excerpt verbatim from the resource just read."
  },
  "exactNewText": {
    "zh-CN": "replace 时的新文本",
    "en": "Replacement text for replace."
  },
  "appendText": {
    "zh-CN": "append 时追加到资源末尾的文本",
    "en": "Text to append to the resource for append."
  },
  "prependText": {
    "zh-CN": "prepend 时添加到资源开头的文本",
    "en": "Text to prepend to the resource for prepend."
  },
  "setContent": {
    "zh-CN": "set 时的完整资源内容，文本直接保存，JSON 对象或数组序列化保存。path=plugin.json 时，设置 UI 的 settings.fields[].type 只支持 text|secret|url|boolean|number|select，width 只支持 full|half，分组使用 settings.layout.sections；通用属性为 label/description/placeholder/required/default，number 使用 min/max/step，select 使用 options，text 使用 pattern，secret 使用 reenterWhen。完整约束见已加载 skill-workbench 的“Skill 设置 DSL 与 inner 网络”。script 资源必须是轻舟 page/inner 浏览器 JS，推荐 async () => { ... } 源码形态。该字段可能很长，必须放在 path/type/title/description 之后最后填写；一次调用只改一个资源。",
    "en": "Full resource content for set. Text is saved directly; JSON objects/arrays are serialized. For path=plugin.json: settings.fields[].type supports text|secret|url|boolean|number|select; width supports full|half; group fields with settings.layout.sections. Common attributes are label/description/placeholder/required/default; number uses min/max/step, select uses options, text uses pattern, and secret uses reenterWhen. See “Settings DSL and inner-runtime networking” in the loaded skill-workbench for the full contract. Scripts must be browser JavaScript for qz's page/inner runtime, preferably one async () => { ... } expression. Supply this long field last, after path/type/title/description. Edit one resource per call."
  },
  "updateName": {
    "zh-CN": "要修改的 skill 名称",
    "en": "Name of the Skill to update."
  },
  "renameTo": {
    "zh-CN": "可选：重命名 skill",
    "en": "Optional new Skill name."
  },
  "updateDisplayName": {
    "zh-CN": "可选：更新中文显示名。标准 name 保持英文 id，中文名写这里。",
    "en": "Optional localized display name. Keep name as an English ID; put the user-facing name here."
  },
  "updateDescription": {
    "zh-CN": "可选：更新用途描述",
    "en": "Optional updated purpose description."
  },
  "updateScope": {
    "zh-CN": "可选：resident=常驻技能，用于系统指令调整、长久记忆信息、个人偏好或交付标准；global=全局按需加载；site=站点技能",
    "en": "Optional scope: resident for always-loaded system instructions, persistent knowledge, preferences, or delivery standards; global for on-demand loading; site for a site-specific skill."
  },
  "updateStatus": {
    "zh-CN": "可选：active/disabled 等状态",
    "en": "Optional status, such as active/disabled."
  },
  "updateDomains": {
    "zh-CN": "可选：替换适用域名",
    "en": "Optional replacement domains."
  },
  "updatePatterns": {
    "zh-CN": "可选：替换 URL/path 匹配",
    "en": "Optional replacement URL/path patterns."
  },
  "updateExclusions": {
    "zh-CN": "可选：替换排除规则",
    "en": "Optional replacement exclusion patterns."
  },
  "updateOldText": {
    "zh-CN": "可选：Skill Markdown 正文单次精确替换的旧文本；只改正文，不改资源。必须唯一匹配。复杂修改请拆成多次 update_skill。",
    "en": "Optional old text for one exact replacement in Skill Markdown, not resources. Must match once. Split complex edits into multiple update_skill calls."
  },
  "updateNewText": {
    "zh-CN": "可选：Skill Markdown 正文单次精确替换的新文本；只改正文，不改资源文件。",
    "en": "Optional replacement text for Skill Markdown only, not resource files."
  },
  "prependContent": {
    "zh-CN": "可选：追加到正文开头",
    "en": "Optional text to prepend to the Markdown content."
  },
  "appendContent": {
    "zh-CN": "可选：追加到正文末尾",
    "en": "Optional text to append to the Markdown content."
  },
  "deleteName": {
    "zh-CN": "要删除的 skill 名称",
    "en": "Name of the Skill to delete."
  },
  "listScope": {
    "zh-CN": "要列出的 skill 范围。all=全部；global=全局按需加载；site=站点技能；resident=常驻技能。",
    "en": "Scope to list: all for every skill; global for on-demand skills; site for site-specific skills; resident for always-loaded skills."
  },
  "zipUrl": {
    "zh-CN": "当前页面中的 Skill Zip 完整下载地址，仅支持 http(s)。下载会复用该页面登录态。",
    "en": "Complete http(s) Skill ZIP download URL from the current page. The download reuses that page's authenticated context."
  },
  "zipOverwrite": {
    "zh-CN": "是否覆盖本地同名 Skill，默认 false；只有用户明确确认覆盖后才传 true。",
    "en": "Whether to overwrite local Skills with the same name. Defaults to false. Pass true only after explicit user confirmation."
  },
  "repositoryUrl": {
    "zh-CN": "支持的 GitHub 或 GitLab 仓库根页/目录页地址；tree URL 可限定分支和 Skill 子目录。",
    "en": "Supported GitHub or GitLab repository-root or directory-page URL. A tree URL can specify the branch and Skill subdirectory."
  },
  "gitOverwrite": {
    "zh-CN": "是否覆盖同名 Skill 或仓库来源中的本地修改，默认 false；只有用户明确确认后才传 true。",
    "en": "Whether to overwrite same-name Skills or local edits to repository-sourced Skills. Defaults to false. Pass true only after explicit user confirmation."
  },
  "installName": {
    "zh-CN": "要安装到 Git 仓库的本地 Skill 名称。",
    "en": "Name of the saved local Skill to install in Git."
  },
  "publishUrl": {
    "zh-CN": "发布适配器支持的仓库根页或 tree 目录页地址；tree 目录决定 Skill 的安装父目录。",
    "en": "Repository-root or tree-directory URL supported by the publishing adapter. The tree directory is the Skill's installation parent directory."
  },
  "commitMessage": {
    "zh-CN": "可选 Git commit message；不填时使用稳定的默认提交说明。",
    "en": "Optional Git commit message. If omitted, uses a stable default message."
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
    "zh-CN": "读取轻舟当前支持的 UI renderer 类型、用途和返回 schema。创建带 UI 的 Skill 前先调用它。",
    "en": "Read supported UI renderer types, purposes, and return schemas. Call this before creating a Skill with a custom result view."
  },
  "listSkills": {
    "zh-CN": "列出技能",
    "en": "List skills"
  },
  "listSkillsDescription": {
    "zh-CN": "列出当前轻舟 skill 名称。开发、整理或更新 skill 前可用它按 all/global/site/resident 查看已有技能全集，避免重复创建或误改。",
    "en": "List existing qz Skill names by all/global/site/resident. Use before developing, organizing, or updating skills to avoid duplicates or unintended edits."
  },
  "importZip": {
    "zh-CN": "导入页面 Zip",
    "en": "Import Skill ZIP from page"
  },
  "importZipDescription": {
    "zh-CN": "接收 Agent 已发现的 Zip URL，使用当前任务网页标签页的认证上下文请求 Skill Zip，完成解压、整包校验并直接创建 Skill。本工具不探测或猜测 URL；默认拒绝覆盖同名 Skill。",
    "en": "Import a Skill ZIP from a URL already discovered by the agent, using the current task tab's authenticated context. Extracts and validates the whole package before creating Skills. Does not discover or guess URLs; refuses to overwrite existing names by default."
  },
  "importGit": {
    "zh-CN": "探测并导入 Git 仓库",
    "en": "Inspect and import Git repository"
  },
  "importGitDescription": {
    "zh-CN": "打开并探测支持的 GitHub 或 GitLab 仓库/目录页，使用页面登录态下载仓库 Zip，导入其中的 Skill 并绑定为可更新来源。",
    "en": "Open and inspect a supported GitHub or GitLab repository/directory page, download its ZIP using the page's authenticated context, import the Skills, and bind them to an updatable source."
  },
  "installGit": {
    "zh-CN": "安装 Skill 到 Git",
    "en": "Install Skill into Git"
  },
  "installGitDescription": {
    "zh-CN": "把一个已保存的本地 Skill 安装到发布适配器支持的仓库根页或 tree 目录，创建或更新 SKILL.md 与资源并提交一次 commit。仅在用户明确要求写入目标仓库时调用。",
    "en": "Install a saved local Skill into a repository root or tree directory supported by the publishing adapter. Creates or updates SKILL.md and resources in one commit. Call only when the user explicitly requests a write to the target repository."
  },
  "createSkill": {
    "zh-CN": "创建技能",
    "en": "Create skill"
  },
  "createSkillDescription": {
    "zh-CN": "创建一个轻舟 skill，只写 Skill Markdown 正文和顶层元信息。普通 skill 不需要资源；带工具的 Skill 创建后，再用“编辑技能资源”逐个写入 plugin.json、scripts/*.js 或 references/*.md。不要在本工具里传资源数组。",
    "en": "Create a qz Skill with Markdown content and top-level metadata only. Ordinary skills need no resources. For tools, create the Skill first, then use the resource-editing tool to write plugin.json, scripts/*.js, or references/*.md one file at a time. Do not pass a resource array here."
  },
  "editResource": {
    "zh-CN": "编辑技能资源",
    "en": "Edit skill resource"
  },
  "editResourceDescription": {
    "zh-CN": "新增、整体替换或编辑某个 skill 的单个资源文件。一次只改一个资源、一次只做一个 action，所有参数都是顶层字段；用于 plugin.json、scripts/*.js、references/*.md 等资源，避免把多个资源或多个 edits 塞进 nested 参数。",
    "en": "Add, replace, or edit one Skill resource file. Use one action per call, with all arguments at the top level. Applies to plugin.json, scripts/*.js, references/*.md, and similar resources. Do not pack multiple resources or edits into nested arguments."
  },
  "updateSkill": {
    "zh-CN": "更新技能",
    "en": "Update skill"
  },
  "updateSkillDescription": {
    "zh-CN": "局部更新已有轻舟 skill 的元信息或 Markdown 正文。正文使用顶层 oldText/newText 做一次精确替换，或使用 prependContent/appendContent 追加；资源文件用“编辑技能资源”，不要在本工具里传资源数组。",
    "en": "Update an existing Skill's metadata or Markdown. Use top-level oldText/newText for one exact replacement, or prependContent/appendContent for additions. Use the resource-editing tool for files; do not pass resource arrays here."
  },
  "deleteSkill": {
    "zh-CN": "删除技能",
    "en": "Delete skill"
  },
  "deleteSkillDescription": {
    "zh-CN": "删除一个用户自定义 skill。内置系统 skill 不可删除。",
    "en": "Delete a user-created Skill. Builtin system skills cannot be deleted."
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
