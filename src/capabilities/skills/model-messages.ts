import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("skills-model", {
  askLlm: {
    "zh-CN": "在 run_script 内部通过 await tools.ask_llm({prompt, system, data}) 调用 LLM 完成分析、总结、翻译、分类或对比，返回纯文本字符串（data 最长 300,000 字符）。",
    en: "Call the LLM from inside run_script via await tools.ask_llm({prompt, system, data}) for analysis, summarization, translation, classification, or comparison, returning a plain-text string (data up to 300,000 chars).",
  },
  analysisPrompt: {
    "zh-CN": "必填。分析提示词或问题。",
    en: "Required prompt or question.",
  },
  analysisSystem: {
    "zh-CN": "可选 system prompt（设定角色或输出格式）。",
    en: "Optional system prompt (role or output format).",
  },
  analysisData: {
    "zh-CN": "可选待分析数据文本（追加在 prompt 之后，最长 300,000 字符）。",
    en: "Optional data text to analyze (appended after prompt, up to 300,000 chars).",
  },
  loadSkill: {
    "zh-CN": "加载指定 Skill 的完整 Markdown 指令（content）、资源索引（resources，含 plugin.json、scripts、references 等）及运行环境说明，并在当前会话激活该 Skill 声明的扩展工具。需要读取单个资源文件内容时，调用 load_skill_resource(name, path)。",
    en: "Load a Skill's full Markdown instructions (content), resource index (resources, including plugin.json, scripts, and references), and runtime guidance, and activate its declared Skill tools for the current session. Call load_skill_resource(name, path) to read an individual resource file.",
  },
  skillName: {
    "zh-CN": "必填。Skill 名称。",
    en: "Required Skill name.",
  },
  skillIncludeResources: {
    "zh-CN": "是否一并返回全部文本资源的源码 content，默认 false（优先用 load_skill_resource 按需读取单文件）。",
    en: "Include full content of all text resources. Default: false (prefer load_skill_resource for individual files).",
  },
  loadSkillResource: {
    "zh-CN": "读取 Skill 包内单个资源文件（path）：文本资源按 start/maxChars 分段返回；DOCX、XLSX、PDF 自动解析并返回首块预览与 docModelId（续读长文档请先 load_skill(\"qingzhou-documents\") 再调 document_read_chunk）。读取 Skill 正文请用 load_skill。",
    en: "Read a single resource file (path) from a Skill package: text resources return character slices via start/maxChars; DOCX, XLSX, and PDF resources are parsed automatically and return an initial preview plus docModelId (load qingzhou-documents and call document_read_chunk to read further). Use load_skill for the Skill Markdown body.",
  },
  skillResourcePath: {
    "zh-CN": "必填。Skill 包内资源相对路径，如 plugin.json、scripts/collect.js、references/checklist.md、references/report.xlsx。",
    en: "Required relative resource path inside the Skill package, such as plugin.json, scripts/collect.js, references/checklist.md, or references/report.xlsx.",
  },
  skillResourceStart: {
    "zh-CN": "文本资源起始字符偏移，默认 0。",
    en: "Starting character offset for text resources. Default: 0.",
  },
  skillResourceMaxChars: {
    "zh-CN": "文本资源单次最大返回字符数，默认 300000，范围 1–1000000。",
    en: "Maximum characters to return for text resources. Default: 300000; range: 1–1000000.",
  },
  manageSkillInternal: {
    "zh-CN": "内部工具：创建、更新、删除或列出 Skill（仅供技能工作台脚本调用，模型不直接使用）。",
    en: "Internal tool to create, update, delete, or list Skills (called by Skill workbench scripts only).",
  },
  manageSkillAction: {
    "zh-CN": "操作类型：create 需 name + description + content；update/delete 需 name；list_skills 可传 scope。",
    en: "Action: create needs name + description + content; update/delete needs name; list_skills accepts scope.",
  },
  manageSkillScope: {
    "zh-CN": "action=list_skills 的技能范围（all/global/site/resident）。",
    en: "Skill scope for action=list_skills (all/global/site/resident).",
  },
  importSkillZipInternal: {
    "zh-CN": "内部工具：使用当前任务网页标签页的登录态下载并导入 Skill Zip（仅供技能工作台调用）。",
    en: "Internal tool to download and import a Skill ZIP using a task-owned tab's authenticated context (called by Skill workbench only).",
  },
  skillZipUrl: {
    "zh-CN": "页面中的 Skill Zip 下载地址。",
    en: "Skill ZIP download URL from the page.",
  },
  skillPageTabId: {
    "zh-CN": "当前任务拥有的页面标签页 ID。",
    en: "Web tab ID owned by the current task.",
  },
  skillZipOverwrite: {
    "zh-CN": "是否覆盖本地同名 Skill，默认 false。",
    en: "Overwrite a local Skill with the same name. Default: false.",
  },
  importSkillGitInternal: {
    "zh-CN": "内部工具：在当前任务拥有的仓库标签页中探测并导入 Git Skill 仓库（仅供技能工作台调用）。",
    en: "Internal tool to inspect and import a Git Skill repository in a task-owned tab (called by Skill workbench only).",
  },
  skillRepositoryUrl: {
    "zh-CN": "受支持的 Git 仓库或目录页地址。",
    en: "Supported Git repository or directory page URL.",
  },
  skillRepositoryTabId: {
    "zh-CN": "当前任务拥有的仓库标签页 ID。",
    en: "Repository tab ID owned by the current task.",
  },
  skillGitOverwrite: {
    "zh-CN": "是否覆盖同名或本地修改的 Skill，默认 false。",
    en: "Overwrite a same-name or locally modified Skill. Default: false.",
  },
  installSkillGitInternal: {
    "zh-CN": "内部工具：将本地 Skill 提交到当前任务拥有的受支持 Git 仓库目录（仅供技能工作台调用）。",
    en: "Internal tool to commit a local Skill to a supported Git repository directory owned by this task (called by Skill workbench only).",
  },
  skillInstallName: {
    "zh-CN": "要提交的本地 Skill 名称。",
    en: "Local Skill name to commit.",
  },
  skillInstallTabId: {
    "zh-CN": "当前任务拥有的受支持 Git 仓库根页或目录页标签页 ID。",
    en: "Tab ID of a supported repository root or directory page owned by this task.",
  },
  skillCommitMessage: {
    "zh-CN": "可选 Git commit message。",
    en: "Optional Git commit message.",
  },
  runtimeGuidance: {
    "zh-CN": `Skill 运行在轻舟浏览器扩展中（非 Node.js 或服务器）：
- content 编写浏览器 SOP；读取 references/模板/脚本等单文件用 load_skill_resource(name, path)（DOCX/XLSX/PDF 自动返回预览与 docModelId，截断时加载 qingzhou-documents 用 document_read_chunk 续读）。
- 脚本采用单个 async () => { ... } 函数表达式：runtime:"page" 可用 document/window/Web APIs、input/args、tabId、tools/tool；runtime:"inner" 在无 DOM Worker 中运行，可用 $plugin.config 和 manifest 允许来源的 fetch；禁止使用 fs/path/process/require/npm/shell，也不要在页面脚本内直接触发导致当前 frame 卸载的点击或提交。`,
    en: `Skills run in the qz browser extension (not Node.js or a server):
- Content describes browser SOPs; read individual references, templates, or scripts with load_skill_resource(name, path) (DOCX/XLSX/PDF automatically return a preview and docModelId; load qingzhou-documents and call document_read_chunk if truncated).
- Write scripts as a single async () => { ... } function expression: runtime:"page" provides document/window/Web APIs, input/args, tabId, and tools/tool; runtime:"inner" runs in a DOM-free Worker with $plugin.config and fetch for manifest-allowed origins. Do not use fs/path/process/require/npm/shell, and do not click or submit inside a page script if it unloads the frame.`,
  },
});

export const modelT = createTranslator(messages);
