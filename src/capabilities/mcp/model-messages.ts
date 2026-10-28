import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("mcp-model", {
  mcpInspectServer: {
    "zh-CN": "探测尚未注册到 Skill 的远程 HTTP MCP server，读取 serverInfo、capabilities 和 tools/list（不支持本地 stdio，也不会自动注册 server）。",
    en: "Inspect an unregistered remote HTTP MCP server for serverInfo, capabilities, and tools/list (local stdio is unsupported; does not register the server).",
  },
  mcpUrl: {
    "zh-CN": "必填。远程 HTTP(S) MCP endpoint URL（如 https://example.com/mcp）。",
    en: "Required remote HTTP(S) MCP endpoint URL (e.g. https://example.com/mcp).",
  },
  mcpName: {
    "zh-CN": "可选临时标识名，默认 adhoc。",
    en: "Optional temporary server name. Default: adhoc.",
  },
  mcpHeaders: {
    "zh-CN": "可选 HTTP 请求头对象（如 Authorization）。",
    en: "Optional HTTP request headers object (e.g. Authorization).",
  },
  mcpRefreshMetadata: {
    "zh-CN": "是否强制重新请求远端元数据，默认 false。",
    en: "Force a fresh metadata request to the remote server. Default: false.",
  },
  mcpIncludeResources: {
    "zh-CN": "当 server 支持时是否一并读取 resources/list 与模板，默认 false。",
    en: "Read resources/list and resource templates when supported by the server. Default: false.",
  },
  mcpIncludePrompts: {
    "zh-CN": "当 server 支持时是否一并读取 prompts/list，默认 false。",
    en: "Read prompts/list when supported by the server. Default: false.",
  },
  mcpMetadataLimit: {
    "zh-CN": "tools/resources/prompts 各自最多返回项数，默认 100。",
    en: "Maximum items returned per list (tools/resources/prompts). Default: 100.",
  },
  mcpListTools: {
    "zh-CN": "列出所有 Skill plugin.json 声明的虚拟全局 MCP 注册表。结果中的 pluginTool.name 是已注册 MCP 的正式调用入口：先调用 load_skill(skillName) 激活所属 Skill，再调用 pluginTool.name。",
    en: "List the virtual global MCP registry declared across all Skill plugin.json manifests. pluginTool.name in each entry is the formal invocation entry point: call load_skill(skillName) first, then invoke pluginTool.name.",
  },
  mcpServerFilter: {
    "zh-CN": "可选 MCP server 过滤引用（如 pluginId:serverId 或 serverId）；省略时列出全部。",
    en: "Optional MCP server filter reference (e.g. pluginId:serverId or serverId); lists all servers if omitted.",
  },
  mcpRefreshTools: {
    "zh-CN": "是否强制重新请求远端 tools/list，默认 false。",
    en: "Force a fresh tools/list request to the remote server. Default: false.",
  },
  mcpListActiveOnly: {
    "zh-CN": "是否仅列出当前页面或本会话已 load_skill 激活的 MCP 工具，默认 false。",
    en: "Include only MCP tools activated by the current page or load_skill in this session. Default: false.",
  },
  mcpToolLimit: {
    "zh-CN": "最多返回工具数，默认 50。",
    en: "Maximum tools to return. Default: 50.",
  },
  mcpSearchTools: {
    "zh-CN": "按关键词搜索所有 Skill plugin.json 声明的虚拟全局 MCP 注册表。先调用 load_skill(skillName) 激活所属 Skill，再调用返回的 pluginTool.name。",
    en: "Search the virtual global MCP registry declared across all Skill plugin.json manifests by keyword. Call load_skill(skillName) first, then invoke the returned pluginTool.name.",
  },
  mcpQuery: {
    "zh-CN": "必填。搜索关键词（匹配工具名、描述、serverId、pluginId 或 skillName）。",
    en: "Required search query (matches tool name, description, serverId, pluginId, or skillName).",
  },
  mcpServerReference: {
    "zh-CN": "可选 MCP server 过滤引用（如 pluginId:serverId 或 serverId）。",
    en: "Optional MCP server filter reference (e.g. pluginId:serverId or serverId).",
  },
  mcpRefreshSearch: {
    "zh-CN": "是否强制重新请求远端 tools/list，默认 false。",
    en: "Force a fresh tools/list request to the remote server. Default: false.",
  },
  mcpSearchActiveOnly: {
    "zh-CN": "是否仅搜索当前页面或本会话已 load_skill 激活的 MCP 工具，默认 false。",
    en: "Search only MCP tools activated by the current page or load_skill in this session. Default: false.",
  },
  mcpCallTool: {
    "zh-CN": "按 URL 调用尚未注册到 Skill 的远程 HTTP MCP 工具（仅用于一次性验证；已注册到 Skill 的 MCP 必须先 load_skill(skillName) 再调用对应的 Skill 工具名 pluginTool.name）。调用前先用 mcp_inspect_server 确认工具名与 inputSchema。",
    en: "Directly invoke an unregistered remote HTTP MCP tool by URL for one-off testing (for registered MCP tools, call load_skill(skillName) and invoke the Skill tool name pluginTool.name instead). Inspect the server with mcp_inspect_server first to confirm tool name and inputSchema.",
  },
  mcpToolName: {
    "zh-CN": "必填。远程 MCP 工具原始名称（取自 mcp_inspect_server 返回的 tools[].name）。",
    en: "Required remote MCP tool name (from tools[].name in mcp_inspect_server).",
  },
  mcpArguments: {
    "zh-CN": "传给远程 MCP 工具的 JSON 参数对象。",
    en: "JSON arguments object passed to the remote MCP tool.",
  },
  mcpValidate: {
    "zh-CN": "调用前是否先通过 tools/list 校验工具存在，默认 false。",
    en: "Verify that the tool exists in tools/list before calling. Default: false.",
  },
  mcpRefreshCall: {
    "zh-CN": "validate=true 时是否强制刷新 tools/list，默认 false。",
    en: "Force a fresh tools/list check when validate=true. Default: false.",
  },
  builtinContent: {
    "zh-CN": `# MCP 接入

用于发现、探测和试调用 MCP。轻舟只支持远程 HTTP MCP，不支持本地 stdio。

## 先判断对象

- 已写入某个 skill 的 MCP：使用虚拟全局 registry 查找，正式调用对应 Skill 工具。
- 用户给出尚未注册的 MCP URL：先探测 metadata；只有需要一次性验证时才直调。
- 用户要长期接入：先完成探测和最小试调用，再加载 \`skill-workbench\`，把选中的 server/tool 写入目标 skill。

## 已注册 MCP

1. 不知道入口时，用 \`{SEARCH}\` 按能力、工具名、server 或 Skill 搜索；需要浏览全量时用 \`{LIST}\`。
2. 结果中的 \`skillName\` 表示所属 skill，\`pluginTool.name\` 是正式执行入口。
3. 先 \`load_skill(skillName)\` 激活该 Skill，再调用 \`pluginTool.name\`。不要用 \`{CALL}\` 绕过 Skill 工具层。
4. \`activeOnly:false\` 会搜索所有 skill 声明的虚拟 registry；只看当前页面或本会话已加载能力时传 \`activeOnly:true\`。
5. 默认使用 metadata cache；只有需要确认远端最新工具时才传 \`refresh:true\`。

## 未注册 MCP

1. 调用 \`{INSPECT}\`，传入 URL 和必要 headers，读取 \`serverInfo\`、\`capabilities\`、\`tools\` 与 \`inputSchema\`。不要为了探测创建临时 skill。
2. 默认只读取工具 metadata；只有任务确实需要时才传 \`includeResources:true\` 或 \`includePrompts:true\`。
3. 一次性请求或开发期验证使用 \`{CALL}\`。工具名和参数必须来自刚探测到的 \`tools[].name/inputSchema\`。
4. \`{CALL}\` 默认不重复执行 \`tools/list\`；需要调用前校验时传 \`validate:true\`，需要强制刷新时再传 \`refresh:true\`。

## 长期接入

1. 先通过 \`{INSPECT}\` 和必要的 \`{CALL}\` 确认 server 可用、目标工具名称和参数契约。
2. 只绑定用户任务真正需要的工具，不默认包装 server 的全部工具。
3. 根据最小试调用的真实返回结构选择轻舟标准 renderer；加载 \`skill-workbench\` 后先读取可用渲染器，再把 renderer 与返回 shape 一起设计。不要把原本只有自然语言的 MCP 文本臆测成表格。
4. 在目标 skill 的 \`plugin.json.mcpServers\` 声明 server，并在 \`tools[]\` 中配置 \`runtime:"mcp"\`、\`mcp:{ server, tool }\` 和匹配返回结构的 \`renderer\`。未声明 renderer 时只使用结构化数据或文本兜底。
5. 写入后重新 \`load_skill\`，再用 \`{SEARCH}\` 或 \`{LIST}\` 验证 registry 中出现 \`pluginTool.name\`，最后通过该 Skill 工具做正式调用并确认结果 UI。

## 结果

- 最终说明使用的是已注册 Skill 入口还是一次性 URL 调用，并给出 server/tool 名称、结果摘要和必要限制；不要复制大段 MCP 原始响应。`,
    en: `# MCP integration

Discover, inspect, and test MCP tools. qz supports remote HTTP MCP only, not local stdio.

## Identify the target

- MCP already declared in a Skill: find it through the virtual global registry and invoke the registered Skill tool.
- An unregistered MCP URL supplied by the user: inspect its metadata first; call it directly only for a one-off check.
- Persistent integration: inspect the server and make a minimal test call, then load \`skill-workbench\` to add selected servers/tools to the target Skill.

## Registered MCP

1. Use \`{SEARCH}\` to find tools by capability, tool name, server, or Skill; use \`{LIST}\` to browse all tools.
2. \`skillName\` identifies the owning Skill; \`pluginTool.name\` is the registered invocation entry point.
3. Activate it with \`load_skill(skillName)\`, then call \`pluginTool.name\`. Do not bypass the Skill tool layer with \`{CALL}\`.
4. \`activeOnly:false\` searches the virtual registry declared by all Skills. Use \`activeOnly:true\` for capabilities activated by the current page or loaded in this session.
5. Use the metadata cache by default. Set \`refresh:true\` only when you need the latest remote tool definitions.

## Unregistered MCP

1. Call \`{INSPECT}\` with the URL and required headers to read \`serverInfo\`, \`capabilities\`, \`tools\`, and \`inputSchema\`. Do not create a temporary Skill just for inspection.
2. Read tool metadata by default. Set \`includeResources:true\` or \`includePrompts:true\` only when the task needs them.
3. Use \`{CALL}\` for a one-off request or development check. Tool names and arguments must come from the freshly inspected \`tools[].name/inputSchema\`.
4. \`{CALL}\` does not repeat \`tools/list\` by default. Set \`validate:true\` to check before calling, and add \`refresh:true\` only when a fresh check is needed.

## Persistent integration

1. Use \`{INSPECT}\` and, if needed, \`{CALL}\` to verify server availability, the target tool names, and their argument contracts.
2. Bind only tools the user's task needs; do not wrap every tool by default.
3. Choose a standard qz renderer from the actual minimal test response. After loading \`skill-workbench\`, inspect available renderers and design the renderer together with the result shape. Do not assume natural-language MCP text is a table.
4. Declare the server in the target Skill's \`plugin.json.mcpServers\`. In \`tools[]\`, set \`runtime:"mcp"\`, \`mcp:{ server, tool }\`, and a \`renderer\` matching the response shape. If no renderer is declared, structured-data or text fallback is used.
5. After writing, call \`load_skill\` again. Use \`{SEARCH}\` or \`{LIST}\` to verify that \`pluginTool.name\` appears in the registry, then invoke that Skill tool and inspect its result UI.

## Delivery

- State whether you used a registered Skill entry point or a one-off URL call. Give the server/tool names, a concise result, and material limitations; do not reproduce large raw MCP responses.`,
  },
  mcpDisplayName: {
    "zh-CN": "MCP 接入",
    en: "MCP integration",
  },
  mcpDescription: {
    "zh-CN": "发现已注册的 MCP 能力，探测尚未注册的远程 HTTP MCP server，并进行一次性试调用。用户要求查找、测试、接入或调用 MCP 时加载；长期接入时再配合技能工作台写入 skill。",
    en: "Discover registered MCP capabilities, inspect unregistered remote HTTP MCP servers, and make one-off test calls. Load when the user asks to find, test, integrate, or call MCP tools. For persistent integrations, use the Skill workbench to add them to a Skill.",
  },
  mcpManifestTitle: {
    "zh-CN": "MCP 接入 Skill 工具清单",
    en: "MCP integration Skill tool manifest",
  },
  mcpManifestDescription: {
    "zh-CN": "声明按需加载的 MCP 发现、探测和试调用 host 工具。",
    en: "Declares on-demand host tools for MCP discovery, inspection, and test calls.",
  },
  mcpScriptDescription: {
    "zh-CN": "MCP 接入 host runtime 转发脚本。",
    en: "MCP integration host runtime forwarding script.",
  },
});

export const modelT = createTranslator(messages);
