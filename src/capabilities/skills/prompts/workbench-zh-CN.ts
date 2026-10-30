// Authored builtin guidance; installed Skill content is never rewritten.
export default `# 技能工作台

当用户希望“创建 Skill”“修改 Skill”“删除 Skill”“从页面 Zip 或 Git 仓库导入 Skill”“把 Skill 安装到 Git 仓库”“给 Skill 增加工具或结果界面”时，先按这个 skill 操作。涉及系统指令调整、长久记忆信息、个人长期偏好、写作规则或交付标准的需求，由 \`scope: "resident"\` 的常驻技能承接。普通 skill 只需要 \`SKILL.md\` 的过程知识；只有需要把脚本工具化或定制工具 UI 时，才创建根目录 \`plugin.json\` 与 \`scripts/*.js\`。

## 工作方式

1. 先判断 Skill 是否需要工具：只沉淀流程/偏好/SOP 时，不要创建 \`plugin.json\`；只有需要暴露 LLM 可调用工具或工具结果 UI 时，才创建 Skill 资源。
2. 涉及系统指令调整、长久记忆信息、个人长期偏好、领域规则、写作规则或交付标准时，创建或更新 \`scope: "resident"\` 的常驻技能；content 写可长期完整注入的规则，不要修改 Kernel Prompt。
3. 创建 Skill 时，\`name\` 使用稳定英文小写 id（Agent Skill 标准名），中文显示名写入 \`displayName\`；再写清 content、scope、domains/urlPatterns 等必要字段，resources 可以为空。
4. Skill 需要工具时，正文 content 写清 SOP、前置导航、页面状态判断、什么时候调用 Skill 工具，以及失败回退；根目录 \`plugin.json\` 声明工具和 UI，\`scripts/*.js\` 放工具脚本。
5. 设计可视化前，先调用本 skill 暴露的“读取可用渲染器”工具，选择 renderer 类型，并让脚本返回值严格匹配该 renderer schema。
6. 需要理解当前完整 skill 体系时，调用本 skill 暴露的“列出技能”工具，按 \`all/global/site/resident\` 获取现有技能名称全集，再决定创建新 skill 还是更新已有 skill。
7. 创建新 skill 时调用本 skill 暴露的“创建技能”Skill 工具；写入或编辑 \`plugin.json\`、\`scripts/*.js\`、\`references/*.md\` 等资源时调用“编辑技能资源”，一次只改一个资源且一次只做一个动作；修改已有 skill 正文或元信息时调用“更新技能”；删除时调用“删除技能”。
8. Skill 脚本不要承载完整流程，只封装可重复、边界明确、适合 LLM tool 调用的局部动作；skill 本身就是用户可选择的入口，不要额外设计 Skill slash command。
9. 写入或更新后，轻舟会刷新 Skill 注册表；显式声明的新工具和工具结果渲染应立即对当前对话生效。
10. Skill 脚本默认使用 \`runtime:"page"\` 注入当前任务网页，页面工具会自动获得可选参数 \`tabRef\`：传当前任务拥有的标签页别名或正整数 ID（也可用数字字符串），省略时使用当前任务工作标签页。在 \`plugin.json\` 中声明时，使用 \`tabRef\` 和 \`type:["integer","string"]\`。未知别名会报错，不会回退到工作标签页。与页面无关、需要自身设置或网络 API 的脚本使用 \`runtime:"inner"\`：通过 \`$plugin.config\` 读取 manifest 设置，通过标准 \`fetch\` 访问 \`network.allowedOrigins\` 声明的来源。不要给用户自定义 Skill 配置 \`runtime:"host"\`；host 只用于轻舟 core 显式注册的受控后台动作。
11. Skill 脚本工具会自动拥有必填的 \`timeout\` 调用参数；不要把超时写进业务 schema。单位是秒，\`timeout <= 0\` 表示无限等待，\`timeout > 0\` 表示最多等待对应秒数；调用 Skill 工具、\`run_script\` 或 \`run_skill_script\` 时由模型按任务复杂度主动选择。
12. Skill 工具曝光由 skill 的 \`scope\` 决定，不在 manifest 里额外配置：\`scope:"resident"\` 常驻曝光；\`scope:"site"\` 在当前页面匹配 skill 的 \`domains/urlPatterns\` 时曝光，也可由当前会话 \`load_skill\` 后曝光；\`scope:"global"\` 只在当前会话 \`load_skill\` 后曝光。\`builtin\`、\`readOnly\` 和 \`source\` 只描述来源与权限，不改变加载策略。
13. 接入外部 MCP 时，先 \`load_skill("qingzhou-mcp")\`，按该 skill 完成 registry 搜索、未注册 URL 探测和必要的最小试调用。只有确认要长期复用时，才把选中的 MCP server 和工具绑定写入目标 skill；已注册 MCP 必须通过对应 Skill 工具名调用。
14. Agent 用现有页面或 Network 工具找到 Skill Zip URL 后，先确保来源页面是当前任务的工作标签页，再把该 URL 传给“导入页面 Zip”。这个工具不负责扫描或猜测下载链接；下载在该页面的认证上下文中完成，解压、校验和 Skill 写入由 Background 统一处理。不要用页面脚本手工拼 base64 或自己解析 Zip。
15. 用户给出支持的 GitHub 或 GitLab 仓库/目录页时，调用“探测并导入 Git 仓库”。它会打开仓库页面、等待必要登录、探测分支与 Zip，并绑定为可更新的 Skill 来源；发生同名或本地修改冲突时，不得未经用户确认传 \`overwrite:true\`。
16. 用户明确要求把某个本地 Skill 安装到 Git 仓库时，调用“安装 Skill 到 Git”。目标 URL 必须由当前产品的 Git 发布适配器支持；目录决定安装位置，工具会创建或更新 \`<目录>/<skill-name>/SKILL.md\` 及其资源并生成一次 commit。未安装对应发布适配器时，先导出 Skill 再由用户提交。
17. Skill 包可以携带 DOCX、XLSX、PDF 参考资源。调用 \`load_skill_resource(name,path)\` 时会自动通过 document pipeline 返回首块预览和 \`docModelId\`；需要继续读取时先 \`load_skill("qingzhou-documents")\`，再调用 \`document_read_chunk\`。这些二进制资源不能使用文本 replace/append/set 编辑。

## 页面模式前置条件

- 基于网页创建或更新 Skill 时，先从当前任务的页面上下文或 \`list_tabs\` 返回的 \`pageMode\` 确认目标页模式，不凭窗口宽度或 URL 猜测；模式缺失或正在切换时，先重新观察确认。
- 如果流程是在 \`pageMode:"mobile"\` 下采集或验证的，必须在生成的 \`SKILL.md\` / content 的前置条件中写明“在移动模式下验证”，并写清复用步骤：新页面用 \`open_tab\` 的 \`mode:"mobile"\` 打开；已有任务所属页面用 \`set_page_mode\` 的 \`mode:"mobile"\` 切换。切换会刷新页面，操作前重新读取页面或截图，不复用旧元素引用和坐标。
- 记录实际验证过的模式；只验证移动模式时，不宣称桌面模式也适用。两种模式流程不同则分别说明。模式要求放在 Skill 正文中，不新增 manifest 字段，也不固化创建时的 tabRef。

## Skill content 与 Skill 脚本的分工

- \`SKILL.md\` / skill content：解释“怎么完成任务”。例如检索 B 站视频时，写清如何打开 B 站、如何搜索、如何筛选、何时进入详情页、哪些页面状态代表成功、遇到风控/空结果怎么处理。
- \`plugin.json\`：可选。只有需要把脚本工具化或定制工具结果 UI 时才创建。它让工具进入 LLM schema，让工具结果用轻舟组件展示。
- \`scripts/*.js\`：可选，且必须由 \`plugin.json.tools[]\` 显式声明后才会成为工具。页面动作使用 \`runtime:"page"\`；纯计算、Skill 自身设置或外部 API 使用 \`runtime:"inner"\`。脚本只实现边界明确的局部动作，不承载完整任务流程。
- 如果一个工具需要多步前置流程，工具描述或 skill content 要明确“先 load_skill 读取流程，再在合适页面调用脚本”。
- 创建、更新、删除 skill 不再直接使用裸露 core tool；统一调用本 skill 暴露的 Skill 工具，让创建逻辑、目录规范和结果 UI 都走同一个入口。

## Skill 包导入与 Git 分发

- “导入页面 Zip”只接收 Agent 已经发现的完整 http(s) 下载地址，默认使用当前任务 workingTabId 的页面登录态下载，不扫描 DOM、Network 或猜测 URL。它可以一次导入一个或多个标准 Skill；默认不覆盖同名项，只有用户确认后才传 \`overwrite:true\`。
- “探测并导入 Git 仓库”接收支持的 GitHub 或 GitLab 的仓库根页/目录页 URL。它复用技能页的 Git 来源能力，保留仓库、分支、目录和更新摘要，后续仍可在技能页检查更新或解除绑定。
- “安装 Skill 到 Git”接收本地 Skill 名称和已支持的 Git 发布目标 URL。调用本身会产生外部 Git commit，必须以用户的明确安装/提交要求为前提；成功后核对返回的 \`targetPath\`、\`fileCount\` 和 \`commitId\`。
- 页面 Zip 导入和 Git 导入都是 package 级操作，不要先拆成 \`create_skill\` + 多次 \`edit_skill_resource\`；Skill 正文、资源、manifest 和来源元数据必须作为一个包校验并写入。

## MCP 接入 SOP

轻舟只支持远程 HTTP MCP，不支持本地 stdio。MCP 的发现、探测和一次性调用由 \`qingzhou-mcp\` 负责；本 skill 只承接已经确认需要持久化的配置：

1. 编辑前先 \`load_skill("qingzhou-mcp")\`，根据其探测结果、\`tools[].name/description/inputSchema\`、最小试调用和用户目标，选出真正需要绑定的工具；不要默认包装 server 的全部工具。
2. 在 \`plugin.json\` 顶层写 \`category\`，按用户任务场景选择稳定业务分类（如“研究”“数据”“出行”“开发”）；只有跨场景纯 MCP 网关才使用 \`{ "id": "mcp", "label": "MCP" }\`。
3. 根据最小试调用的真实返回 shape 调用“读取可用渲染器”，为每个绑定工具选择 \`table/list/fields/summary/article/image_grid/tree/markdown/text\` 等标准 renderer。MCP 返回 \`structuredContent\` 或 JSON 文本时可直接映射；只有自然语言文本时使用 \`text/markdown\`，不要臆测字段。
4. 在 \`plugin.json.mcpServers\` 声明 server，并在 \`tools[]\` 中为选中的工具配置 \`runtime:"mcp"\`、\`mcp:{ server, tool }\` 和匹配返回结构的 \`renderer\`。renderer 可以写在单个 tool 上，也可以写在顶层 \`renderers.tools\`。
5. 写入前轻舟会校验启用的 MCP server 能否完成 \`tools/list\`；失败时修正 URL、headers，或明确将暂不可用的 server 设为 \`enabled:false\`，不要绕过校验。
6. 写入后重新 \`load_skill(name)\`，再按 \`qingzhou-mcp\` 的 registry 流程验证 \`pluginTool.name\`，通过该 Skill 工具做正式调用，并确认命中了预期 renderer 而不是通用文本兜底。

\`\`\`json
{
  "format": "qingzhou.plugin",
  "schemaVersion": 1,
  "id": "docs-mcp",
  "displayName": "文档 MCP",
  "description": "通过远程 MCP 查询文档信息",
  "category": { "id": "research", "label": "研究" },
  "mcpServers": {
    "docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  },
  "tools": [
    {
      "name": "resolve_library",
      "title": "解析库 ID",
      "description": "调用 docs MCP 的 resolve-library-id 工具。",
      "runtime": "mcp",
      "mcp": { "server": "docs", "tool": "resolve-library-id" },
      "parameters": {
        "type": "object",
        "properties": {
          "libraryName": { "type": "string", "description": "库名或框架名" }
        },
        "required": ["libraryName"]
      },
      "renderer": {
        "type": "text",
        "title": "解析结果",
        "valuePath": "text"
      }
    }
  ]
}
\`\`\`

## Manifest 最小结构

\`\`\`json
{
  "format": "qingzhou.plugin",
  "schemaVersion": 1,
  "id": "page-inspector",
  "displayName": "页面洞察",
  "version": "0.1.0",
  "description": "提取当前页面的标题、链接和正文摘要",
  "category": { "id": "research", "label": "研究" },
  "tools": [
    {
      "name": "inspect_page",
      "title": "分析当前页面",
      "description": "读取当前页面的可见结构并返回摘要",
      "script": "scripts/inspect-page.js",
      "needsPage": true,
      "parameters": {
        "type": "object",
        "properties": {
          "tabRef": { "type": ["integer", "string"], "description": "当前任务拥有的标签页别名或正整数 ID；省略时使用工作标签页" },
          "limit": { "type": "integer", "description": "最多返回多少条链接" }
        }
      }
    }
  ],
  "renderers": {
    "tools": {
      "inspect_page": {
        "type": "summary",
        "titlePath": "title",
        "subtitlePath": "url",
        "fields": [
          { "label": "链接", "path": "linkCount" },
          { "label": "正文", "path": "textLength" }
        ]
      }
    }
  }
}
\`\`\`

## Skill 设置 DSL 与 inner 网络

需要 Endpoint、Token 或其他用户配置时，在 manifest 顶层声明 \`settings.fields\`；不要新增业务专用设置页或 host action。设置页的控件、分组和宽度只由下面这套通用 DSL 决定，不支持自定义 \`style\`、\`theme\` 或任意组件名：

- \`settings.fields[].type\` 只支持 \`text\`、\`secret\`、\`url\`、\`boolean\`、\`number\`、\`select\`。布尔开关使用 \`boolean\`。
- 所有字段都可声明 \`key\`、\`type\`、\`label\`、\`description\`、\`placeholder\`、\`required\`、\`default\` 和 \`width\`。\`key\` 以英文字母开头，只能包含字母、数字、下划线和连字符；\`width\` 只支持 \`full\`（默认，整行）或 \`half\`（半行，两列排列；窄屏自动回到整行）。
- \`text\` 可声明正则字符串 \`pattern\`；\`url\` 只接受不带用户名密码的 HTTP(S) 地址；\`secret\` 可声明 \`reenterWhen\`，列出哪些其他字段改变后必须重新输入密钥，且不能声明非空 \`default\`。
- \`number\` 可声明 \`min\`、\`max\`、\`step\`；\`select\` 必须声明非空 \`options\`，每项使用 \`{ "label": "显示文字", "value": "稳定字符串值" }\`；\`boolean\` 的值和默认值必须是真正的 JSON boolean，不能用字符串 \`"true"\` / \`"false"\` 代替。
- 字段较多时用 \`settings.layout.sections\` 分组。每组支持 \`title\`、可选 \`description\` 和字段 key 数组 \`fields\`；一个字段最多进入一个分组，未分组字段仍会显示。layout 只控制通用设置页的展示，不进入存储或脚本配置。

脚本通过 \`$plugin.config.<key>\` 读取设置。\`type:"secret"\` 的值会回填到本地设置页的 password 控件，但不会注入 page runtime；需要密钥的工具必须使用 \`runtime:"inner"\`。动态网络来源引用一个 \`type:"url"\` 设置字段，Skill 使用普通 \`fetch\`。

\`\`\`json
{
  "settings": {
    "title": "示例 API",
    "description": "连接信息与查询偏好",
    "fields": [
      { "key": "endpoint", "type": "url", "label": "Endpoint", "required": true },
      { "key": "token", "type": "secret", "label": "Token", "required": true, "reenterWhen": ["endpoint"] },
      { "key": "project", "type": "text", "label": "Project", "pattern": "^[A-Za-z][A-Za-z0-9_\\\\-]*$", "width": "half" },
      { "key": "limit", "type": "number", "label": "返回条数", "min": 1, "max": 1000, "step": 1, "default": 100, "width": "half" },
      { "key": "mode", "type": "select", "label": "模式", "options": [{ "label": "标准", "value": "standard" }, { "label": "快速", "value": "fast" }], "default": "standard", "width": "half" },
      { "key": "cache", "type": "boolean", "label": "启用缓存", "default": true, "width": "half" }
    ],
    "layout": {
      "sections": [
        { "title": "连接", "description": "服务地址与凭证", "fields": ["endpoint", "token", "project"] },
        { "title": "查询", "fields": ["limit", "mode", "cache"] }
      ]
    }
  },
  "network": {
    "allowedOrigins": [{ "setting": "endpoint" }],
    "allowedMethods": ["GET", "POST"]
  },
  "tools": [{
    "name": "query_api",
    "title": "查询 API",
    "runtime": "inner",
    "script": "scripts/query-api.js",
    "parameters": { "type": "object", "properties": { "query": { "type": "string" } } }
  }]
}
\`\`\`

## 脚本约定

Skill 脚本与 \`run_script.code\` 使用同一种源码形态：默认写成单个 \`async () => { ... }\` 函数表达式，由轻舟自动调用。不要写顶层 \`return\`、IIFE、\`main();\` 或把结果包在 \`result\` 字段里。\`runtime:"page"\` 在当前任务工作标签页或用 \`tabRef\` 指定的自有页面上执行；\`runtime:"inner"\` 在无 DOM 的 Worker 中执行，不需要 tab，可用标准 Web APIs、\`$plugin.config\`、\`fetch\` 和 \`tools/tool\`。

\`\`\`js
async () => {
  const limit = Number(args.limit || 10);
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, limit)
    .map(a => ({ text: a.innerText.trim(), href: a.href }));

  return {
    title: document.title,
    url: location.href,
    linkCount: links.length,
    textLength: document.body?.innerText?.length || 0,
    links
  };
}
\`\`\`

两种脚本都可用 \`args/input\`、\`$plugin\`、\`tools/tool\` 和 Web APIs；page 额外可用 \`window/document\` 和宿主解析后的数字 \`tabId\`。该运行时值不是作者声明的页面目标参数；调用页面工具时使用 \`tabRef\`。inner 没有 DOM，网络来源和 method 必须在 manifest \`network\` 中声明。不要使用 Node.js、\`fs/path/process/require\`、npm 包、本地 shell 或服务器文件系统。

### 页面 state 与安全返回规范

工具脚本的返回值和调试 trace 必须是小型 plain JSON，只允许 string/number/boolean/null/array/plain object。禁止返回或 trace DOM node、Window、Document、Event、Response、Request、Headers、Promise、Function、Map/Set 原对象、Proxy、Vue/React 内部对象、页面原始 state 引用或任何带循环/深原型链的大对象。

可以读取 \`window.__INITIAL_STATE__\`、\`__NEXT_DATA__\`、\`__NUXT__\` 等 SSR/hydration state，但只能做字段投影：先取业务字段，再立刻 \`slice\`、\`map\`、\`String/Number/Boolean\` 归一化成小对象。不要 \`return state\`、\`return window.__INITIAL_STATE__\`、\`return state.search.feeds._rawValue\`、\`trace("state", stateObj)\` 或 \`JSON.stringify(window.__INITIAL_STATE__)\`。

遇到大型页面 state 时，优先 DOM-first 或 Network-first；只有可见 DOM/API 不足时才 state-first。state-first 也必须只读 primitive、小数组和必要业务字段，所有中间大对象不得进入最终返回值、renderer payload、trace、错误对象或缓存。

\`trace()\` 只记录 URL、count、字段名、错误码和少量样本。若运行时报 \`Object reference chain is too long\`、\`Converting circular structure to JSON\`、\`DataCloneError\`、\`Maximum call stack size exceeded\` 或类似 CDP 序列化错误，按 \`STATE_SERIALIZATION\` / \`SERIALIZATION\` 处理：改成 DOM-first、Network-first 或 state 字段投影，并复测正式 Skill 工具。

如果工具配置了 UI renderer，脚本返回值必须直接匹配 renderer schema，不要把主要数据包进 \`result\` 字段：

- \`summary/compact/metrics/fields\`：返回对象，字段与 \`titlePath\`、\`subtitlePath\`、\`fields[].path\` 对齐。
- \`table\`：默认返回 \`{ rows: [...] }\`，每行字段与 \`columns[].path\` 对齐；若 renderer 写了 \`itemsPath/valuePath\`，则该路径必须是数组。分页或截断结果用 \`totalPath\` 指向完整行数、\`truncatedPath\` 指向是否截断。
- \`list\`：默认返回 \`{ items: [...] }\`，每项字段与 \`itemTitlePath/itemSubtitlePath/itemMeta[].path\` 对齐。
- \`markdown\`：默认返回 \`{ markdown: "..." }\`；若配置 \`valuePath\`，则该路径必须是 Markdown 字符串。
- \`json\`：返回可序列化 JSON；若配置 \`valuePath\`，则该路径必须存在。

复杂展示使用线性 \`layout.blocks\`，每个 block 是一个 renderer。block 的 \`source\` 默认是脚本返回结果；\`source:"args"\` 可直接展示本次工具输入，不要求脚本把输入复制进 return。\`sourcePath\` 先在所选 source 中定位 block 数据，\`valuePath/itemsPath\` 再相对该数据读取：

\`\`\`json
{
  "layout": {
    "type": "stack",
    "blocks": [
      { "type": "code", "title": "SQL", "source": "args", "valuePath": "sql", "language": "sql" },
      { "type": "summary", "sourcePath": "summary", "fields": [{ "label": "数量", "path": "count" }] },
      { "type": "table", "sourcePath": "data", "itemsPath": "rows", "totalPath": "totalRows", "truncatedPath": "truncated", "columns": [{ "label": "标题", "path": "title" }] },
      { "type": "markdown", "sourcePath": "notes" }
    ]
  }
}
\`\`\`

脚本应返回 \`{ summary: {...}, data: { rows:[...], totalRows: 10, truncated: false }, notes: { markdown:"..." } }\`；SQL 已从 \`args.sql\` 展示，不要再复制进返回值。

## 更新协议

- 修改 skill 正文时，用“更新技能”的顶层 \`oldText/newText\`、\`prependContent\` 或 \`appendContent\`。一次调用只做一类清晰修改；它们只作用于 Skill Markdown 正文，不会修改资源。
- 新增、整体替换或编辑 \`plugin.json\`、\`scripts/*.js\`、\`references/*.md\` 等资源时，调用“编辑技能资源”：\`name\`、\`path\`、\`action\`、\`type\`、\`title\`、\`description\`、\`content\`、\`oldText\`、\`newText\` 等都是顶层参数，一次只改一个资源，一次只做一个动作。
- 大段脚本/JSON 整体替换用 \`action:"set"\`，先写 \`path/type/title/description\`，最后写长 \`content\`。
- 小范围修改用 \`action:"replace"\` + 顶层 \`oldText/newText\`，从刚读取的资源 content 中原样复制最小但唯一的连续片段作为 \`oldText\`，不要凭记忆重写；追加/前置用 \`append\` / \`prepend\`；重命名用 \`rename\`；删除用 \`delete\`。
- 修改已有资源前先用 \`load_skill\` 查看资源清单，再用 \`load_skill_resource(name,path)\` 读取目标文件。不要把多个资源或多个 edits 塞进数组对象里。
- DOCX、XLSX、PDF 资源由导入流程保留原始字节并交给 document pipeline 读取；“编辑技能资源”只处理文本内容，不要把二进制文件转写成 base64 文本参数。

## UI 与渲染

- skill 的 \`name\` 是稳定英文 id，只用小写字母、数字和连字符；\`displayName\` 是中文显示名。创建中文技能时必须同时传 \`displayName\`，不要把中文只放在正文标题里。
- Skill 的 \`displayName\` 是 Skill 中文名；\`category\` 必须填写，用于 Skill 上层归类和对话流中的工具自动聚合。按用户可理解的业务场景命名，不要省略让系统回退到默认分类。
- \`renderers.tools\` 的可用类型以“读取可用渲染器”工具返回为准。创建带 UI 的 Skill 前先读取 registry，再选择合适 renderer，并按返回 schema 设计脚本 return。
- 配置了 renderer 的工具用轻舟标准可视化/分组展示；没有 renderer 的工具自动按通用脚本结果展示。
- 更复杂的展示用 renderer 的 \`layout.blocks\` 组合已有轻舟组件，不要写一次性的视觉结构。
- 需要用户配置时，在 manifest 声明通用 \`settings.fields\`，轻舟会自动把设置卡片放进“设置 → 技能”。
- manifest 的 \`settings.fields\` 只定义字段结构和可选初始 default，不代表用户当前配置；实际读写配置值时加载 \`qingzhou-management\`，使用 \`qingzhou_management__manage_skill_settings\` 的 list/get/update，并以 get 结果验收。secret 不在 manifest 声明 default。

## 质量要求

- Skill id 和工具名要稳定、短、英文小写；中文只放在 \`displayName/title/label\`。
- 工具返回 JSON 要和 renderer schema 对应；有 UI renderer 时必须写清脚本 return 的对象结构，避免返回 \`result\` 包裹、raw JSON 字符串或不可结构化文本。
- 写入、审查或修复 \`scripts/*.js\` 前必须做 serialization audit：页面 state 只投影小字段，返回值和 trace 不带 DOM/Window/Response/Proxy/框架内部对象/原始 state/大响应体。
- site Skill 把 \`domains/urlPatterns\` 写在 skill 顶层；Skill manifest 不写曝光 mode 字段，也不要新增手动/常驻之类的曝光配置。
- 不要覆盖用户已有 skill；修改已有 Skill 前先 \`load_skill\` 或 \`load_skill_resource\`。
- 产出的 Skill 应能被用户直接继续编辑和导出。`;
