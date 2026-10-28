import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("settings-model", {
  notifyUser: {
    "zh-CN": "发送本地浏览器系统通知，提醒用户回到浏览器查看重要进展或处理阻塞。它不能替代 ask_user 或 wait_for_user（登录、验证码、授权、付款等仍须调用 wait_for_user）。内置全局流控与防抖，重复或过频通知会返回 suppressed:true。",
    en: "Send a local browser notification to alert the user of important progress or a blocker. Does not replace ask_user or wait_for_user (still call wait_for_user for sign-in, CAPTCHA, authorization, or payment). Globally rate-limited and deduplicated; repeated alerts return suppressed:true.",
  },
  notificationTitle: {
    "zh-CN": "简短通知标题（最多 80 字符），默认“轻舟提醒”。",
    en: "Short notification title (up to 80 chars). Default: “qz”.",
  },
  notificationMessage: {
    "zh-CN": "必填。通知正文（最多 600 字符），说明需要用户关注或处理的事项。",
    en: "Required notification body (up to 600 chars) explaining what needs attention.",
  },
  notificationLevel: {
    "zh-CN": "通知级别（info/success/warning/error），默认 info。",
    en: "Notification priority level (info/success/warning/error). Default: info.",
  },
  notificationDedupeKey: {
    "zh-CN": "可选去重键（2 分钟内相同 key 不重复发送）；省略时按 title+message 去重。",
    en: "Optional deduplication key (suppresses duplicates within 2 minutes); defaults to title+message.",
  },
  managementDisplayName: {
    "zh-CN": "轻舟管理",
    en: "qz settings",
  },
  managementDescription: {
    "zh-CN": "通过对话管理轻舟自身的模型、Provider、模型请求参数、预设、高级运行设置、Skill 配置和访问安全护栏。用户要求配置或切换模型、调整思考开关或推理强度、写入 API Key、调整上下文或视觉能力、处理模型接口 429/频率限制、读取或修改 Skill 配置、设置站点黑白名单、URL pattern 或访问流控时加载。",
    en: "Manage qz's models, providers, model request parameters, presets, advanced runtime settings, Skill settings, and access guardrails through conversation. Load when the user asks to configure or switch models, adjust thinking or reasoning effort, set an API key, change context or image capabilities, address model API 429/rate limits, read or update Skill settings, or configure site allow/block rules, URL patterns, or navigation rate limits.",
  },
  manageSettings: {
    "zh-CN": "读取和修改轻舟模型与运行设置（访问规则与站点流控请用 qingzhou_management__manage_guardrails，Skill 自带配置请用 qingzhou_management__manage_skill_settings）。先 get 查看当前 provider/model 和 presets；已有匹配预设时优先 apply_preset；查询可用模型用 list_models；缺少 API Key 时先请用户提供或调用 wait_for_user/ask_user。update_config 接收增量补丁（未传字段保持不变）：切换到新 provider/model 时省略 contextWindow 和 vision 以自动匹配新模型默认值（不要复制旧模型值）；若返回 MODEL_CAPABILITIES_REQUIRED，向用户确认 contextWindow 后显式传入重试。处理模型接口 429/rate limit 时只传 requestRateLimit:true 开启 RPM/TPM 排队（余额或总配额耗尽不适用）。",
    en: "Read and update qz model and runtime settings (use qingzhou_management__manage_guardrails for access rules/rate limits, and qingzhou_management__manage_skill_settings for Skill-defined settings). Call get first to inspect the current provider/model and presets; prefer apply_preset when a matching preset exists; use list_models to list models; if an API key is needed, ask the user via wait_for_user/ask_user first. update_config applies a partial patch (omitted fields stay unchanged): when switching provider/model, omit contextWindow and vision to use the new model's detected defaults (never copy the old model's values); if MODEL_CAPABILITIES_REQUIRED is returned, ask the user for contextWindow and retry. To mitigate model API 429/rate limits (not exhausted quota/balance), pass requestRateLimit:true.",
  },
  settingsAction: {
    "zh-CN": "操作类型。必填项：apply_preset/delete_preset 需 presetId；update_config 至少传一个配置字段。",
    en: "Action. Required fields: apply_preset/delete_preset needs presetId; update_config needs at least one configuration field.",
  },
  settingsProvider: {
    "zh-CN": "模型服务商 ID（取自 get 返回的 providers[].id）。",
    en: "Model provider ID (from providers[].id in the get result).",
  },
  settingsModel: {
    "zh-CN": "模型名称（切换模型时传入；仅改当前模型其他参数时可省略）。",
    en: "Model ID (pass when switching models; omit when only updating other settings on the current model).",
  },
  settingsModelParameters: {
    "zh-CN": "透传给模型服务商的请求参数对象（如 reasoning_effort、thinking、temperature，保留原始 JSON 类型）。",
    en: "Provider-specific model request parameters object (e.g. reasoning_effort, thinking, temperature; preserves JSON types).",
  },
  settingsApiKey: {
    "zh-CN": "模型服务商 API Key。",
    en: "API key for the model provider.",
  },
  settingsPresetId: {
    "zh-CN": "模型预设 ID（取自 get 返回的 config.presets[].id，用于 apply_preset/delete_preset）。",
    en: "Model preset ID from config.presets[].id in the get result (for apply_preset/delete_preset).",
  },
  settingsReasoningEffort: {
    "zh-CN": "OpenAI Codex 服务商的推理强度（low/medium/high/xhigh/max），默认 medium。",
    en: "Reasoning effort for the OpenAI Codex provider (low/medium/high/xhigh/max). Default: medium.",
  },
  settingsCustomProtocol: {
    "zh-CN": "自定义接口协议（openai/anthropic，仅 provider=custom 使用）。",
    en: "Custom endpoint protocol (openai/anthropic, used when provider=custom).",
  },
  settingsCustomEndpoint: {
    "zh-CN": "自定义接口 HTTP(S) 地址（仅 provider=custom 使用）。",
    en: "Custom HTTP(S) API endpoint URL (used when provider=custom).",
  },
  settingsCustomPresetName: {
    "zh-CN": "自定义接口预设显示名称。",
    en: "Display name for the custom endpoint preset.",
  },
  settingsEndpointAlias: {
    "zh-CN": "customEndpoint 的兼容别名（仅 provider=custom 使用）。",
    en: "Compatibility alias for customEndpoint (only when provider=custom).",
  },
  settingsContextWindow: {
    "zh-CN": "上下文窗口 tokens（切换模型时省略以采用自动匹配的默认值；仅用户要求覆盖或返回 MODEL_CAPABILITIES_REQUIRED 时明确传入）。",
    en: "Context window in tokens (omit when switching models to use the detected default; supply only on user override or after MODEL_CAPABILITIES_REQUIRED).",
  },
  settingsTrimResults: {
    "zh-CN": "是否在上下文压力下自动裁剪旧工具结果。",
    en: "Trim older tool results automatically under context pressure.",
  },
  settingsVision: {
    "zh-CN": "模型是否支持图片输入（切换模型时省略以采用自动匹配的默认值；未知时按 false 处理；仅用户要求覆盖时明确传入）。",
    en: "Whether the model supports image input (omit when switching models to use the detected default; defaults to false when unknown; supply only on user override).",
  },
  settingsRateLimit: {
    "zh-CN": "是否开启模型接口 RPM/TPM 请求限速排队（用于缓解模型 429/rate limit，默认 false）。",
    en: "Enable shared RPM/TPM request queuing for model API calls to mitigate 429/rate limits. Default: false.",
  },
  settingsDebugMode: {
    "zh-CN": "是否开启调试模式。",
    en: "Enable debug mode.",
  },
  settingsIncludeProviders: {
    "zh-CN": "是否在结果中附带 providers 列表（get 默认 true，update_config 默认 false）。",
    en: "Include provider summaries in the result (defaults to true for get, false for update_config).",
  },
  settingsModelLimit: {
    "zh-CN": "list_models 最大返回模型数，默认 200，范围 1–1000。",
    en: "Maximum models returned by list_models. Default: 200; range: 1–1000.",
  },
  manageGuardrails: {
    "zh-CN": "读取和修改轻舟访问安全护栏与站点打开流控（修改前先 get 查看现有规则及顺序）。访问规则支持 block（禁止）和 allow（加白），按列表顺序第一条命中生效；流控使用 minOpenIntervalSeconds（秒）限制打开/跳转同一站点的最小间隔。",
    en: "Read and update qz access guardrails and page-opening rate limits (call get first to inspect existing rules and order). Access rules support block and allow, with the first matching rule in order taking effect; rate limits use minOpenIntervalSeconds in seconds between page openings/navigations.",
  },
  guardrailAction: {
    "zh-CN": "操作类型。必填项：add_rule 需 targetType + target；remove_rule 需 id 或 target；add_rate_limit 需 targetType + target + minOpenIntervalSeconds；remove_rate_limit 需 id 或 target；reorder 需 order。",
    en: "Action. Required fields: add_rule needs targetType + target; remove_rule needs id or target; add_rate_limit needs targetType + target + minOpenIntervalSeconds; remove_rate_limit needs id or target; reorder needs order.",
  },
  guardrailId: {
    "zh-CN": "规则 ID（用于 remove_rule/remove_rate_limit）。",
    en: "Rule ID for remove_rule or remove_rate_limit.",
  },
  guardrailRuleAction: {
    "zh-CN": "访问规则动作：block（禁止访问，add_rule 默认）或 allow（允许访问）。",
    en: "Access rule action: block (default for add_rule) or allow.",
  },
  guardrailTargetType: {
    "zh-CN": "匹配类型：domain（域名及所有子域名）或 pattern（URL 通配符规则）。",
    en: "Match type: domain (domain and all subdomains) or pattern (URL wildcard pattern).",
  },
  guardrailTarget: {
    "zh-CN": "匹配目标（domain 如 example.com；pattern 如 *://example.com/private/*）。",
    en: "Match target (e.g. example.com for domain, or *://example.com/private/* for pattern).",
  },
  guardrailInterval: {
    "zh-CN": "打开/跳转该站点的最小间隔秒数（add_rate_limit 必填）。",
    en: "Minimum interval in seconds between opening/navigating to the target (required for add_rate_limit).",
  },
  guardrailEnabled: {
    "zh-CN": "流控规则是否启用，默认 true（仅 add_rate_limit 使用）。",
    en: "Whether the rate-limit rule is enabled. Default: true (for add_rate_limit).",
  },
  guardrailOrder: {
    "zh-CN": "按优先级排列的规则 ID 数组（用于 reorder）。",
    en: "Ordered array of rule IDs for reorder.",
  },
  manageSkillSettings: {
    "zh-CN": "读取和修改已安装 Skill 声明的配置项（禁止直接操作设置页 DOM 或 storage）。先 list 获取 settingId，再 get 查看字段定义与当前值，最后 update 传入 settingId 和要修改的 values 补丁（未传字段保持不变；secret 字段读取仅返回 hasValue，传入新值即覆盖）。",
    en: "Read and update settings declared by installed Skills (never manipulate the Settings DOM or storage directly). Call list to find settingId, get to inspect field definitions and current values, and update with settingId and a partial values object (omitted fields stay unchanged; secret fields return hasValue only and are overwritten when a new value is supplied).",
  },
  skillSettingsAction: {
    "zh-CN": "操作类型：list 列出带配置的 Skill；get 需 settingId；update 需 settingId + 非空 values。",
    en: "Action: list lists Skills with settings; get requires settingId; update requires settingId + non-empty values.",
  },
  skillSettingId: {
    "zh-CN": "Skill 配置 ID（取自 list 返回的 settings[].id，get/update 必填）。",
    en: "Skill settings ID from settings[].id in the list result (required for get/update).",
  },
  skillSettingValues: {
    "zh-CN": "update 的字段键值补丁对象（key 取自 get 返回的 setting.fields[].key）。",
    en: "Partial field key/value patch for update (keys must match setting.fields[].key from get).",
  },
  managementManifestTitle: {
    "zh-CN": "轻舟管理 Skill 工具清单",
    en: "qz settings Skill tool manifest",
  },
  managementManifestDescription: {
    "zh-CN": "声明模型设置、Skill 配置和安全护栏的按需管理工具。",
    en: "Declares on-demand tools for model settings, Skill settings, and access guardrails.",
  },
  managementScriptDescription: {
    "zh-CN": "轻舟管理 host runtime 脚本。",
    en: "qz settings host runtime script.",
  },
  builtinContent: {
    "zh-CN": `# 轻舟管理

用户可以通过对话读取和调整轻舟自身的模型、Provider、预设、高级设置、Skill 配置与访问边界。收到这类要求时使用本 Skill 完成，不要求用户再去轻舟设置页重复操作；没有用户要求时，不自行修改配置。

## 通用流程

1. 先读取当前状态，确认用户要查看或改变什么，以及哪些值应继续沿用。
2. 使用与设置页相同的原子操作完成修改，不操作设置页 DOM，不手工拼装持久化对象。
3. 修改后重新读取并验证结果。

## 模型与预设

- 使用 \`qingzhou_management__manage_settings\`。先执行 \`action:"get"\`，查看当前 provider/model、可用 provider 摘要和已有预设。服务商使用返回的 id，接口以其 endpoint 为准，不另猜服务商 ID 或接口地址。
- 已有目标预设时优先 \`apply_preset\`。不要把预设拆成字段再手工保存；预设内部保存的凭证由系统解析，能力字段保留该预设保存的值及用户覆盖。
- 需要确认 provider 支持哪些模型时使用 \`list_models\`。
- 没有合适预设时使用 \`update_config\`。它接收字段补丁：修改当前配置时只传本次要改变的字段，未传字段沿用 \`get\` 返回的当前值，并按设置页保存语义 upsert provider/model 预设。
- 实际切换到不同 provider/model 时，省略 \`contextWindow\` 与 \`vision\`，让工具采用新模型默认值，不要复制旧值。匹配与设置页共用 models.dev SDK 离线快照及本地能力声明，本地未命中时才查在线目录。修改当前模型参数不会重置已保存的能力值。
- 思考开关、推理强度、采样和输出限制都属于模型请求参数；用户要求改变这些生成行为时，按模型设置任务处理。
- 用户明确要求模型专属请求参数时，通过 \`modelParameters\` 传 JSON Key/Value；保留现有参数时不要重写，切换 provider/model 时不沿用旧模型参数。
- 切换到新模型且无法自动匹配上下文长度并返回 \`MODEL_CAPABILITIES_REQUIRED\` 时，向用户确认 \`contextWindow\`，再显式传入并重试；不要猜测默认值，也不要把旧模型的能力字段带到新模型。无法识别图片能力时按 \`vision=false\` 处理。
- 只有用户明确要求覆盖时，才主动修改已识别或已保存的 \`contextWindow\`、\`vision\`、\`trimOldToolResults\`、\`requestRateLimit\`、\`debugMode\` 或 Codex reasoning effort。
- 用户要求处理当前模型接口明确返回的 429、Too Many Requests 或 rate limit 时，先 \`get\`；若 \`requestRateLimit\` 为 false，再执行 \`update_config\`，并且只传 \`requestRateLimit:true\`。它会让后续模型请求进入 RPM/TPM 流控，降低再次触发频率限制的概率；不要借此改动 provider、model 或其他高级设置。
- 若错误明确指向余额不足、账单问题、\`insufficient_quota\` 或总配额耗尽，请说明对应的 Provider 问题；请求限速不能修复这类错误。不要因普通网页或工具请求的 HTTP 429 修改模型限速。
- 用户明确要求删除预设时才使用 \`delete_preset\`。

### 模型参数候选

以下 Key/Value 与设置页下拉使用同一份候选数据。值按展示的 JSON 类型传入 \`modelParameters\`；只选择当前目标需要的参数，不同时发送表达同一语义的多个 Key。候选项不代表所有 Provider 都支持，最终以当前 Provider 的协议为准。

{MODEL_PARAMETER_SUGGESTION_GUIDE}

## 安全护栏

- 使用 \`qingzhou_management__manage_guardrails\`。修改前先执行 \`action:"get"\`，读取当前规则与顺序。
- 整站规则使用 \`targetType:"domain"\`；路径级或通配 URL 使用 \`targetType:"pattern"\`。
- \`ruleAction:"block"\` 表示禁止访问；\`ruleAction:"allow"\` 用于从更宽的禁止规则中反向加白。普通访问不需要配置 allow。
- 访问规则按顺序第一条命中生效；需要改变优先级时使用 \`reorder\`，不要删除后重建来碰运气。
- 站点打开/跳转频率使用 \`add_rate_limit\` 和 \`minOpenIntervalSeconds\`。它是多个 session 共享的运行时策略，不用脚本 sleep 代替。
- 只有用户明确要求时才移除、放宽或重排安全规则；不要为了完成当前任务自行削弱护栏。

## Skill 配置

- 读、改 Skill 自带配置统一使用 \`qingzhou_management__manage_skill_settings\`，不要操作设置页 DOM，也不要直接读写 storage。
- 先执行 \`action:"list"\` 找到目标 Skill 的稳定 \`settingId\`，再用 \`action:"get"\` 查看字段定义与当前值。
- 修改时使用 \`action:"update"\`，传入 \`settingId\` 和只包含本次改动字段的 \`values\`。未传字段会保持不变。
- Skill 配置是全局配置，对之后启动的该 Skill 工具调用生效，不把它当作当前 session 的临时状态。
- 密钥字段的读取结果只包含 \`hasValue\`，不会返回已保存的明文。用户提供新的密钥值时，把它放入 \`values\` 对应字段即可替换旧值。
- 不猜测字段名或枚举值；以本次 \`get\` 返回的 \`fields\` 为准。修改后再次 \`get\` 验证结果。

## 验证与交付

- 模型设置修改后再次 \`get\`，确认 provider、model、preset、contextWindow、vision、requestRateLimit 和 hasApiKey 状态。
- 护栏修改后再次 \`get\`，确认规则类型、目标、顺序和流控秒数。
- Skill 配置修改后再次 \`get\`，确认目标字段、configured、missing 和密钥字段的 hasValue 状态。
`,
    en: `# qz settings

Users can read and change qz's models, providers, presets, advanced settings, Skill settings, and access boundaries through conversation. Handle these requests with this Skill without asking the user to repeat the changes in the Settings page. Do not change configuration without a user request.

## General workflow

1. Read the current state. Identify what the user wants to inspect or change and which values should remain unchanged.
2. Use the same atomic operations as Settings. Do not manipulate the Settings page DOM or construct storage records manually.
3. Read the state again and verify the change.

## Models and presets

- Use \`qingzhou_management__manage_settings\`. Begin with \`action:"get"\` to inspect the current provider/model, available provider summaries, and existing presets. Use the returned provider IDs and endpoint values instead of guessing IDs or API URLs.
- Prefer \`apply_preset\` when the target preset exists. Do not split a preset into fields and save them manually; the system resolves its saved credentials and restores its saved capabilities, including user overrides.
- Use \`list_models\` to discover models supported by a provider.
- If no preset fits, use \`update_config\`. It accepts a field patch: supply only the changes, preserve omitted values returned by \`get\`, and upsert the provider/model preset with the same semantics as Settings.
- When switching to a different provider/model, omit \`contextWindow\` and \`vision\` so the tool can use the new model’s defaults; do not copy the old values. Matching shares the Settings page’s models.dev SDK snapshot and local capability definitions, consulting the online catalog only for local misses. Changing parameters on the current model preserves its saved capabilities.
- Thinking, reasoning effort, sampling, and output limits are model request parameters. Treat changes to these behaviors as model settings tasks.
- For model-specific parameters explicitly requested by the user, pass JSON key/value pairs in \`modelParameters\`. Do not rewrite parameters that should remain unchanged or carry the old model's parameters to a different provider/model.
- If a new model's context length cannot be identified and the tool returns \`MODEL_CAPABILITIES_REQUIRED\`, ask the user for \`contextWindow\`, then provide it explicitly and retry. Do not guess a default or carry over the old model's capabilities. Treat unrecognized image support as \`vision=false\`.
- Change detected or saved \`contextWindow\`, \`vision\`, \`trimOldToolResults\`, \`requestRateLimit\`, \`debugMode\`, or Codex reasoning effort only when the user explicitly requests an override.
- When the user asks to address an explicit 429, Too Many Requests, or rate-limit error from the current model API, first \`get\` the settings. If \`requestRateLimit\` is false, call \`update_config\` with only \`requestRateLimit:true\`. Subsequent model requests queue by RPM/TPM to reduce recurring rate-limit errors. Do not change the provider, model, or other advanced settings as part of this fix.
- If the error identifies an insufficient balance, billing problem, \`insufficient_quota\`, or exhausted total quota, explain the provider issue. Request rate limiting cannot fix these errors. Do not change model rate limits for ordinary webpage or tool HTTP 429 errors.
- Use \`delete_preset\` only when the user explicitly requests deletion.

### Suggested model parameters

These key/value choices share the same source as the Settings dropdowns. Preserve the displayed JSON types in \`modelParameters\`. Choose only parameters needed for the current goal; do not send multiple keys expressing the same intent. Suggestions are not a guarantee of support by every provider; follow the current provider's protocol.

{MODEL_PARAMETER_SUGGESTION_GUIDE}

## Access guardrails

- Use \`qingzhou_management__manage_guardrails\`. Before changing anything, run \`action:"get"\` to read the current rules and their order.
- Use \`targetType:"domain"\` for an entire site and \`targetType:"pattern"\` for paths or URL wildcards.
- \`ruleAction:"block"\` denies access. \`ruleAction:"allow"\` creates an exception to a broader block rule. Ordinary access does not require an allow rule.
- The first matching access rule takes effect. Use \`reorder\` to change precedence; do not delete and recreate rules hoping to change priority.
- Use \`add_rate_limit\` and \`minOpenIntervalSeconds\` for page-opening/navigation frequency. This is a runtime policy shared across sessions; do not replace it with script sleeps.
- Remove, relax, or reorder security rules only at the user's explicit request. Do not weaken guardrails to complete the current task.

## Skill settings

- Always use \`qingzhou_management__manage_skill_settings\` to read or update settings declared by a Skill. Do not manipulate the Settings page DOM or read/write storage directly.
- First use \`action:"list"\` to find the target Skill's stable \`settingId\`, then \`action:"get"\` to inspect field definitions and current values.
- Use \`action:"update"\` with \`settingId\` and a \`values\` object containing only fields to change. Omitted fields remain unchanged.
- Skill settings are global and apply to subsequent tool invocations. Do not treat them as temporary session state.
- Secret reads contain only \`hasValue\`, never stored plaintext. When the user supplies a new secret, put it in the corresponding \`values\` field to replace the old value.
- Do not guess field names or enum values; use the \`fields\` returned by the latest \`get\`. Read again after updating to verify the result.

## Verification and delivery

- After model changes, use \`get\` again to verify provider, model, preset, contextWindow, vision, requestRateLimit, and hasApiKey.
- After guardrail changes, use \`get\` again to verify rule types, targets, order, and rate-limit intervals in seconds.
- After Skill settings changes, use \`get\` again to verify the target fields, configured, missing, and secret hasValue states.
`,
  },
  managementCategory: {
    "zh-CN": "系统",
    en: "System",
  },
});

export const modelT = createTranslator(messages);
