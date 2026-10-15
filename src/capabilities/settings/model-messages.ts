import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("settings-model", {
  notifyUser: {
    "zh-CN": "给当前用户发送一条本地浏览器弹窗提醒，用于把用户叫回浏览器处理阻塞或查看重要进展。它不能替代 ask_user/wait_for_user；遇到登录、验证码、授权、付款等需要用户亲自操作的场景，仍必须调用 wait_for_user。工具内置全局流控，所有 session、定时任务和脚本调用共享限频，重复提醒可能被 suppressed。",
    en: "Send the current user a local browser notification to bring them back for a blocker or important progress. It does not replace ask_user/wait_for_user. For login, CAPTCHA, authorization, payment, or other actions requiring the user, still call wait_for_user. Notifications share a global rate limit across all sessions, automations, and scripts; repeated notifications may be suppressed.",
  },
  notificationTitle: {
    "zh-CN": "通知标题，默认“轻舟提醒”。保持简短。",
    en: "Short notification title. Defaults to “qz”.",
  },
  notificationMessage: {
    "zh-CN": "通知正文，说明用户需要注意或处理什么。",
    en: "Notification body explaining what needs the user's attention or action.",
  },
  notificationLevel: {
    "zh-CN": "提醒级别，默认 info；只影响通知优先级。",
    en: "Notification level. Default: info. Affects priority only.",
  },
  notificationDedupeKey: {
    "zh-CN": "可选去重键。相同去重键在短时间内只会提醒一次；不填时按 title+message 自动去重。",
    en: "Optional deduplication key. Only one notification with the same key is sent within a short period. If omitted, deduplicates by title+message.",
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
    "zh-CN": "读取和修改轻舟自身设置。只负责模型服务商、模型名、模型参数、高级运行设置和模型预设；访问安全策略和站点流控请使用 qingzhou_management__manage_guardrails。update_config 接收字段补丁：只传本次要改变的字段，未传字段沿用当前配置，并按设置页保存语义 upsert provider/model 预设。modelParameters 是直接传给模型服务商的 JSON 参数对象，支持项由服务商决定，模型、消息、工具和流式开关等请求骨架字段由轻舟管理。实际切换到不同 provider/model 时，省略 contextWindow、vision 即自动采用新模型的默认值；匹配与设置页共用 models.dev SDK 离线快照及本地能力声明，未命中时才查询在线目录。不要复制旧模型的能力字段；用户明确要求的覆盖值仍优先。无法准确匹配新模型的上下文长度时工具会返回 MODEL_CAPABILITIES_REQUIRED；此时向用户确认 contextWindow，再明确传入并重试，不猜测默认值。无法识别图片能力时按不支持图片处理。apply_preset 恢复预设保存的能力及覆盖值；apply_preset/delete_preset 复用设置页的预设函数，不手工拼字段。用户要求处理模型接口 429/Too Many Requests/rate limit 时，可只把 requestRateLimit 更新为 true，让后续模型请求进入 RPM/TPM 流控；余额、账单或总配额耗尽不适用。典型流程：先 get 查看当前 provider/model 和已有预设；已有匹配预设时 apply_preset；需要找模型时 list_models；缺少 AK 时打开服务商网站或说明步骤并 wait_for_user/ask_user 等用户亲自创建或提供 AK；拿到 AK 后再 update_config。",
    en: "Read and update qz settings: model provider, model name, request parameters, advanced runtime settings, and model presets. Use qingzhou_management__manage_guardrails for access rules and site rate limits. update_config accepts a field patch: supply only fields to change; omitted fields keep their current values. Provider/model presets are upserted using the same semantics as the Settings page. modelParameters is a JSON object passed directly to the provider; supported options depend on that provider. qz owns request structure such as model, messages, tools, and streaming. When switching to a different provider/model, omit contextWindow and vision to use the new model’s defaults. Matching shares the Settings page’s models.dev SDK snapshot and local capability definitions, consulting the online catalog only for local misses. Do not copy capabilities from the previous model. Explicit user overrides take precedence. If the new context length cannot be identified, the tool returns MODEL_CAPABILITIES_REQUIRED. Ask the user for contextWindow, then provide it explicitly and retry; do not guess a default. Unrecognized image support is treated as unsupported. apply_preset restores the preset’s saved capabilities and overrides. apply_preset/delete_preset use the same preset functions as Settings; do not construct preset fields manually. When the user asks to address model API 429/Too Many Requests/rate limits, set requestRateLimit=true to queue subsequent requests by RPM/TPM. This does not resolve exhausted balances, billing limits, or total quotas. Typical workflow: get the current provider/model and presets; apply_preset for a matching preset; list_models to find a model. If an API key is missing, open the provider website or explain the steps, then wait_for_user/ask_user while the user creates or provides the key. Call update_config after obtaining it.",
  },
  settingsAction: {
    "zh-CN": "设置动作。分支必填：apply_preset/delete_preset 需 presetId；update_config 至少传一个模型配置字段。",
    en: "Settings operation. apply_preset/delete_preset requires presetId. update_config requires at least one model configuration field.",
  },
  settingsProvider: {
    "zh-CN": "模型服务商 id。使用 get 返回的 providers 中的 id；列表包含推荐、自定义及 models.dev SDK 支持的服务商，并提供各自的模型请求 endpoint。",
    en: "Provider ID from the providers array returned by get. It includes recommended, custom, and supported models.dev SDK providers, with each provider’s model request endpoint.",
  },
  settingsModel: {
    "zh-CN": "模型名称。切换模型时传入；修改当前模型的其他设置时可省略并沿用已有值。",
    en: "Model name. Provide when switching models; omit to keep the current model while changing other settings.",
  },
  settingsModelParameters: {
    "zh-CN": "可选模型请求参数 Key/Value 对象，例如 reasoning_effort、thinking、temperature。值保留 JSON 类型并直接透传；服务商不支持时会返回其原始错误。",
    en: "Optional JSON key/value object for model requests, such as reasoning_effort, thinking, or temperature. Values keep their JSON types and pass through directly. Unsupported parameters return the provider's original error.",
  },
  settingsApiKey: {
    "zh-CN": "模型接口的 AK/API Key。",
    en: "API key for the model endpoint.",
  },
  settingsPresetId: {
    "zh-CN": "apply_preset/delete_preset 使用的模型预设 id；来自 get 返回的 config.presets[].id。",
    en: "Preset ID for apply_preset/delete_preset, from config.presets[].id in the get result.",
  },
  settingsReasoningEffort: {
    "zh-CN": "OpenAI Codex provider 的 reasoning effort，默认 medium。",
    en: "Reasoning effort for the OpenAI Codex provider. Default: medium.",
  },
  settingsCustomProtocol: {
    "zh-CN": "自定义接口协议。",
    en: "Protocol for the custom endpoint.",
  },
  settingsCustomEndpoint: {
    "zh-CN": "自定义接口 endpoint。",
    en: "Custom API endpoint.",
  },
  settingsCustomPresetName: {
    "zh-CN": "自定义接口预设名称。",
    en: "Preset name for the custom endpoint.",
  },
  settingsEndpointAlias: {
    "zh-CN": "customEndpoint 的兼容别名，仅 provider=custom 时使用。",
    en: "Compatibility alias for customEndpoint. Only used when provider=custom.",
  },
  settingsContextWindow: {
    "zh-CN": "上下文窗口 tokens。切换模型时省略以采用自动匹配的默认值；仅用户要求覆盖或工具返回 MODEL_CAPABILITIES_REQUIRED 时明确传入，不复制旧模型的值。",
    en: "Context window in tokens. Omit when switching models to use the detected default. Supply only for a user-requested override or after MODEL_CAPABILITIES_REQUIRED; do not copy the previous model’s value.",
  },
  settingsTrimResults: {
    "zh-CN": "高级设置：是否在上下文压力下裁剪旧工具结果。",
    en: "Advanced setting: trim old tool results when context space is limited.",
  },
  settingsVision: {
    "zh-CN": "当前模型是否支持图片输入。切换模型时省略以采用自动匹配的默认值；仅用户要求覆盖时明确传入。无法识别时按 false 处理。",
    en: "Whether the model accepts image inputs. Omit when switching models to use the detected default; supply only for a user-requested override. Unknown support defaults to false.",
  },
  settingsRateLimit: {
    "zh-CN": "高级设置：是否对模型接口请求统一限速，默认关闭。开启后按 RPM/TPM 统一排队，可用于降低模型接口 429/Too Many Requests/rate limit 再次发生的概率；不处理余额、账单或总配额耗尽。",
    en: "Advanced setting: apply shared rate limiting to model API requests. Disabled by default. When enabled, requests queue by RPM/TPM to reduce recurring 429/Too Many Requests/rate-limit errors. Does not resolve exhausted balances, billing limits, or total quotas.",
  },
  settingsDebugMode: {
    "zh-CN": "高级设置：调试模式。",
    en: "Advanced setting: debug mode.",
  },
  settingsIncludeProviders: {
    "zh-CN": "get/update_config 是否返回 provider 摘要列表。默认 get=true，update_config=false。",
    en: "Include provider summaries in get/update_config results. Defaults to true for get and false for update_config.",
  },
  settingsModelLimit: {
    "zh-CN": "list_models 最多返回模型数量，默认 200，最大 1000。",
    en: "Maximum models returned by list_models. Default: 200; maximum: 1000.",
  },
  manageGuardrails: {
    "zh-CN": "读取和修改轻舟安全策略。用于配置访问规则和站点打开/跳转流控；模型配置请使用 qingzhou_management__manage_settings。访问规则支持禁止访问/允许访问，targetType=domain 表示域名及子域名，targetType=pattern 表示 URL 通配规则。流控使用 minOpenIntervalSeconds，单位秒；工具层会在 open_tab/navigate/点击跳转等打开页面动作上全局排队，多个 session 共享。",
    en: "Read and update qz access rules and navigation rate limits. Use qingzhou_management__manage_settings for model settings. Rules can block or allow access: targetType=domain matches the domain and its subdomains; targetType=pattern matches URL wildcards. Rate limits use minOpenIntervalSeconds in seconds. The tool runtime queues page-opening actions such as open_tab, navigate, and click navigation globally across sessions.",
  },
  guardrailAction: {
    "zh-CN": "动作。add_rule 需 targetType/target；remove_rule 需 id 或 target；add_rate_limit 需 targetType/target/minOpenIntervalSeconds；remove_rate_limit 需 id 或 target；reorder 需 order。",
    en: "Operation. add_rule requires targetType/target; remove_rule requires id or target; add_rate_limit requires targetType/target/minOpenIntervalSeconds; remove_rate_limit requires id or target; reorder requires order.",
  },
  guardrailId: {
    "zh-CN": "规则 id，用于 remove_rule/remove_rate_limit/reorder。",
    en: "Rule ID for remove_rule/remove_rate_limit/reorder.",
  },
  guardrailRuleAction: {
    "zh-CN": "访问规则动作。block=禁止访问，allow=允许访问；add_rule 默认 block。",
    en: "Access rule action: block denies access; allow permits it. add_rule defaults to block.",
  },
  guardrailTargetType: {
    "zh-CN": "匹配类型。domain 匹配域名及子域名；pattern 匹配 URL 通配规则。",
    en: "Match type: domain matches the domain and subdomains; pattern matches URL wildcards.",
  },
  guardrailTarget: {
    "zh-CN": "匹配目标。domain 例：example.com；pattern 例：*://example.com/private/*。",
    en: "Match target. Domain example: example.com. Pattern example: *://example.com/private/*.",
  },
  guardrailInterval: {
    "zh-CN": "站点打开/跳转最小间隔，单位秒；仅 add_rate_limit 使用。",
    en: "Minimum interval between page openings or navigations, in seconds. Used only by add_rate_limit.",
  },
  guardrailEnabled: {
    "zh-CN": "流控规则是否启用，默认 true；仅 add_rate_limit 使用。",
    en: "Whether the rate-limit rule is enabled. Default: true. Used only by add_rate_limit.",
  },
  guardrailOrder: {
    "zh-CN": "安全策略顺序，填已有访问规则和流控规则的 id。访问规则先按顺序决定 allow/block；未禁止时，流控再按顺序命中。",
    en: "Ordered IDs of existing access and rate-limit rules. Access rules determine allow/block in order. If access is not blocked, rate-limit rules are then matched in order.",
  },
  manageSkillSettings: {
    "zh-CN": "读取和修改已安装 Skill 自带的配置。读/改 Skill 配置统一使用本工具，不要操作设置页 DOM，也不要直接读写 storage。典型流程：先 list 找到稳定的 settingId，再 get 查看字段定义和当前值，最后 update 传 settingId 与需要改变的 values；update 是局部更新，未传字段保持不变。密钥字段读取时只返回 hasValue，不返回已保存的明文；写入新的密钥值会替换旧值。模型与 Provider 配置请使用 qingzhou_management__manage_settings。",
    en: "Read and update settings declared by installed Skills. Always use this tool for Skill settings; do not manipulate the Settings page DOM or read/write storage directly. First list to find a stable settingId, then get the field definitions and current values, then update with settingId and the values to change. update is a partial patch; omitted fields remain unchanged. Secret reads return only hasValue, never stored plaintext. Writing a new secret replaces the old value. Use qingzhou_management__manage_settings for model/provider configuration.",
  },
  skillSettingsAction: {
    "zh-CN": "动作。list 列出带配置的 Skill；get 需 settingId；update 需 settingId 和非空 values。",
    en: "Operation. list finds Skills with settings; get requires settingId; update requires settingId and nonempty values.",
  },
  skillSettingId: {
    "zh-CN": "Skill 配置的稳定 id，来自 list 返回的 settings[].id。get/update 必填。",
    en: "Stable Skill settings ID from settings[].id in the list result. Required for get/update.",
  },
  skillSettingValues: {
    "zh-CN": "update 使用的字段补丁，key 必须来自 get 返回的 setting.fields[].key；未传字段保持不变。",
    en: "Field patch for update. Keys must come from setting.fields[].key in the get result. Omitted fields remain unchanged.",
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
