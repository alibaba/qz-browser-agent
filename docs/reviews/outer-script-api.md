# 外层脚本 API 审查稿

文案修改前取自本轮起点 `91051e7`，修改后取自当前工作树。以下引文均为源文件逐字节选；未标“新增”的接口继续使用原名称。

## 最终调用方式

面向调用方 Agent 的操作入口为 `qz session create/list/show/cancel` 和 `qz script --session ID [FILE|-] [--args JSON]`。连接、安装、内置 Agent 委托和结果管理命令分别保留其用途。

```js
await tools.open_tab({url:"https://example.com", tabAlias:"page"});
return await tools.evaluate({
  tabRef: "page",
  code: (limit) => ({title:document.title, text:document.body.innerText.slice(0,limit)}),
  args: 1000
});
```

- `run_script` 固定在页面外编排，支持顶层 await/return；页面导航不会销毁外层脚本。页面工具逐次显式传 tabRef。
- 新增 `evaluate` 执行页面函数，返回其业务值。JS 调用可直接传函数；JSON 调用传函数字符串。参数可为任意 JSON 值，函数不捕获外层变量。open_tab/navigate 保证导航提交，evaluate 默认等待 DOMContentLoaded；waitUntil:"commit" 可提前观察，动态内容仍按具体条件等待。页面卸载仍可能中断该次 evaluate，不自动重放。
- 新增 `list_tools` 从当前工具登记表返回签名；传 names 获取指定工具的完整 schema。CLI、内置 Agent 与脚本共用工具名和定义，没有另一套 SDK 方法名。
- 动作保留实际输入送达和 fill/check 验证。普通成功回 `{}`；导航只附 navigated/url 或 navigationPending。confirmationRequired 要求先局部验证，再继续任务；观察按需要单独调用。
- `wait_for_navigation/response/popup` 接受 `trigger:{name,args}`，先监听再调用一次动作。失败不重放，超时不回滚。`wait_for_load` 检查当前加载；`wait_for_navigation` 观察之后的新导航，包含同 URL 重载、SPA 和片段变化。`wait_for_url/element/function` 等待状态。
- `qz script` 成功和失败都在 stdout 输出 `{ok,result,trace}`；ok 表示脚本执行成功，trace 是按执行顺序排列、不分级别的消息字符串，result 为 return 的业务值，undefined 映射 null。失败 result 为 `{code,message,hint?,details?}`；成功退出 0，执行或连接失败退出 1，用法错误退出 2。扩展在脚本边界构造统一回执并通过 scriptApiVersion:2 标记，CLI 校验后原样输出；CLI 与扩展协议版本不一致时在执行前被拦截；业务值内的 trace/traces、ok/error/code 等键保真，不参与日志或成败判定。
- CLI 的浏览器操作先自动准备连接；输入验证在任何启动或配对之前完成。优先复用响应正常的在线 UUID，无在线连接时仅在受支持的系统默认浏览器（Chromium 系或 Firefox）打开一次连接页并等待响应，默认浏览器不受支持时提示手动配对；实际响应后固定 UUID。显式 --client 不回退；多浏览器中的已有会话经只读查询唯一定位后固定 UUID。协议不兼容只在业务调用前、锁内核对服务身份后重启一次；已提交操作不重放。`qz connect uri` 只打印指定 profile 的连接地址，公开 stop 命令删除。
- Tab 仍为 `{tabRef,url,title,active}`。active 是用户可见状态；会话归属继续承担互斥、权限和清理职责。因果关联的新 popup 纳入原会话，取消后的晚到页面受同一清理屏障约束。

## CLI 与 Skill 文案对照

源文件：[CLI 声明](../../services/mcp-bridge/src/commands.mjs)、[Skill](../../skills/qz-browser-agent/SKILL.md)。包内指南与 Skill 同步，`qz skill` 读取已安装 CLI 的指南；工具能力以已连接扩展的实际目录为准。新版脚本在执行前检查扩展 API 版本，不要求源码提交哈希相等。

| 位置 | 修改前（逐字） | 修改后（逐字） |
| --- | --- | --- |
| CLI script 用法 | `qz script --session ID --tab TABREF [FILE\|-]` | `qz script --session ID [FILE\|-] [--args JSON]` |
| CLI script 说明 | Run an async JavaScript function on that page. stdout is only the returned value. | Run JavaScript outside the page. stdout is {ok,result,trace}: execution status, the returned value and ordered trace messages. |
| CLI 工具目录 | `qz tools --session ID [NAME]` | `return await tools.list_tools();` |
| CLI 单工具入口 | `qz exec --session ID [JSON\|-]` | 删除该入口；脚本直接调用 `tools.<原工具名>`。 |
| CLI 任务清理 | `qz cancel "$SID"` | `qz session cancel "$SID"` |
| CLI 连接地址 | `qz connect [--client NAME\|UUID] [--port PORT] [--timeout SECONDS]` | `qz connect uri [--name NAME \| --client NAME\|UUID] [--port PORT]` |
| CLI 服务停止 | `qz stop` | 删除公开入口；浏览器操作在执行前自动准备兼容连接。 |
| Skill 外层代码要求 | Page code is a single `async () => { ... }` function expression: no IIFE, main(), or return outside a function. | Use top-level await and return, beginning with a short comment stating the script's purpose. |
| Skill 工具名称说明 | 新增 | Call tools by their catalog names. |

## 工具描述对照

### run_script：页面执行与编排分开

源文件：[script/tool-messages.ts](../../src/capabilities/script/tool-messages.ts)。以下为 description 的首段。

修改前：

> Execute temporary JavaScript with top-level await support. Accepts inline code only; invoke scripts packaged in a Skill through that Skill's tool. Scripts can access input/args, tools/tool, and trace/log. Pass tabRef to execute in that page with document/window; omit tabRef for computation or tool orchestration without DOM access. Each nested page tool also requires an explicit tabRef. tools is a dynamic proxy for tools enabled in the current run configuration (e.g. await tools.find_elements({...}), await tools.data_store({...})); do not use Object.keys(tools) to inspect capabilities—call await tools.$list() instead.

修改后：

> Run JavaScript orchestration outside pages, with top-level await and return. Call available tools through tools; each page call passes tabRef. Use tools.evaluate for a function inside a page. input is the value of args. Use Promise.all for independent tabs. Return only the business value needed; console and trace record diagnostics. timeout is seconds, defaults to 120; 0 removes this call deadline while retaining parent cancellation and deadlines. Page navigation does not destroy the outer script.

新增 evaluate 的 description：

> Evaluate a self-contained function in the page identified by tabRef and return its JSON value. The function can use document/window and the page login state; pass outside values through args rather than captured variables. Scripts can pass a function as code; JSON callers pass its source string. Perform navigation and clicks through outer tools; wait for the required element before reading a new page’s DOM. Unloading the page may interrupt this evaluation; code is never replayed automatically.

新增 list_tools 的 description：

> Inspect tools available in this session. Omit names for compact signatures; provide names for their complete parameter definitions.

### open_tab：保持调用顺序，适用于工具调用与脚本

源文件：[tabs/tool-messages.ts](../../src/capabilities/tabs/tool-messages.ts)。以下为同一 description 中的逐字节选。

英文修改前：

> Return open_tab({url,tabAlias:"source1"}) together with read_article({tabRef:"source1",limit:4000}) in the current assistant message's tool_calls array, sending both calls together; place each opening before its readers.

英文修改后：

> Open each page before calling its readers, for example open_tab({url,tabAlias:"source1"}) followed by read_article({tabRef:"source1",limit:4000}); independent pages may be processed concurrently.

中文修改前：

> 将 open_tab({url,tabAlias:"source1"}) 和 read_article({tabRef:"source1",limit:4000}) 一起放入当前 assistant 消息的 tool_calls 数组并一次发出；将每个打开调用放在依赖它的读取之前。

中文修改后：

> 先用 open_tab({url,tabAlias:"source1"}) 打开页面，再用 read_article({tabRef:"source1",limit:4000}) 读取；每个打开调用都先于依赖它的读取，独立页面可并行处理。

### 导航等待：新导航与当前加载分开

源文件：[wait/tool-messages.ts](../../src/capabilities/wait/tool-messages.ts)。

修改前 wait_for_navigation：

> Wait for the tab specified by tabRef to finish loading, returning status, url, and title. already_complete means the page was already loaded when called; it does not prove the preceding action succeeded or failed. Pass screenshot:true only for visual checks such as dialogs or CAPTCHAs.

修改后 wait_for_navigation：

> Wait for a future navigation in tabRef, including same-URL reloads, SPA navigation, and fragment changes. An already-loaded page does not match. Pass trigger:{name,args} to arm before invoking a tool; action failure propagates and the deadline is shared.

当前加载检查由 wait_for_load 承担，已有完成页面不会被当作一次新导航。

Skill 最新导航就绪说明（逐字）：

> Use ordinary action tools for clicks, forms and navigation. After opening or navigating, use wait_for_element for the DOM you need before reading it with evaluate. evaluate runs inside the page: navigating or closing that page can interrupt that evaluate call, while the outer script remains available. Do not blindly replay a script after an uncertain result; inspect completed work first.

### 动作回执：删除重复元素状态

源文件：[page/tool-messages.ts](../../src/capabilities/page/tool-messages.ts)。

修改前逐字节选：

> fill enters text into an input/textarea/contenteditable ("" clears; multiline contenteditable text inserts paragraphs and returns p/br/block structure)

修改后逐字节选：

> Success returns {}, with navigated/url when navigation occurs and navigationPending while it is pending. If confirmationRequired is true, verify the editor saved the value before continuing; use a focused observation to check the resulting page state when needed.

成功回执精简不会删除实际编辑验证；要读取结果时，调用方选择局部观察。

## 私有兼容保留的原因

已有安装 Skill 的 manifest、资源脚本及内部运行时 ABI 继续工作。隐藏的 run_skill_script 与私有页面/Worker 映射用于执行这些已有包，不进入公开工具目录，也不把执行模式参数带回公开 run_script。

旧页面控制字段在 Skill 声明归一入口按结构迁移。作者正文和嵌套业务 JSON 保真；不扫描任意文字替换词语，也不递归删同名键。旧历史工具的展示支持用于读取存量会话，不恢复工作页默认目标或已移除的工具注册。

## 生产新增逻辑的理由

| 位置 | 必要性 |
| --- | --- |
| 共享工具、脚本与等待契约 | 明确外层/页面函数、嵌套调用、截止时间和错误边界，复用已有执行引擎。 |
| wait-observation、等待工具与调度器 | 监听先于动作；父等待不会阻塞自己的子触发；取消、超时和迟到事件沿同一调用权限处理。 |
| Session 标签页归属与 popup 捕获 | 将真实动作产生的新页纳入会话，保留用户页和互斥权限；关闭取消后的迟到页面。 |
| 原生 Agent 嵌套工具记录 | 让外层脚本中的真实工具调用也有可关联的侧栏记录，保持模型返回值简洁。 |
| CLI / 服务协议声明 | 增加会话列表、详情和独立取消；执行前检查 API 兼容，自动准备连接并只在受锁身份核验后升级服务一次，避免切换会话归属或重放动作。浏览器发现与有界候选尝试用于自动找到真正响应的扩展，沿用既有配对授权。 |
| 传输层日志、图片与成败标记 | 从可信执行记录返回消息字符串，图片使用可信侧通道，isError 决定成败；保留业务 result 内所有键。 |
| metadata、语言与历史标题索引 | 补齐新工具标题，区分外层脚本与页面求值，维持多语言展示及历史可读性。 |

## 验收与差异统计

| 验证 | 结果与证据 |
| --- | --- |
| `npm run verify` | 通过：主单测 2308/2308、重型 32/32、侧栏契约 28/28、Node 服务 361 通过/1 个 PowerShell 环境跳过、Python 41/41。`/tmp/qz-final-acceptance-verify.log`。 |
| `npm run verify:store` | 通过：构建、类型检查、商店审计无阻断项；动态入口仍按精确指纹审查。`/tmp/qz-final-recovery-store.log`，包含最后调度修复的新构建。 |
| Chrome 全量 | 最后源码全量进行中：`/tmp/qz-final-recovery-browser.log`。此前 1384/1385，一次新标签停在 about:blank；16 次同场景、48 个 open/read 批次未复现，未宣称根因已修复，保留被动诊断。 |
| Firefox | 全量通过：201/201 unit、33/33 browser；最后调度修复再用新构建通过 outer-script 1/1。`/tmp/qz-auto-final-firefox.log`、`/tmp/qz-final-recovery-firefox-outer.log`。 |
| CLI 与并发专项 | CLI 升级、取消和客户端归属覆盖一次执行与身份保留；script 21/21 含真实 MCP 成功/错误传输，失败只输出顶层字符串 traces；调度 31/31，新增两条死锁回归先红后绿。 |
| 公网真实任务 | 网络间歇恢复时，最新 CLI 原 CSS check、原 UID 点击、实际 DOM 和 26 条 traces 成功，14 次唯一调用、0 工具错误；证据 `tests/results/final-bootstrap-checkbox-browser-ua/offline-verification.json`。该轮夹具字段误写导致未执行末尾 UI/cancel 检查；修正后的完整回放再次收到实际浏览器 503（`final-bootstrap-checkbox-complete/`）。模型接口也持续 503，最新完整公网验收未完成。 |
| npm 包进程 | launcher/signals 31/31；真实 tarball 配合仓库锁定依赖离线安装，两处干净目录的 bin、MCP、URI、身份复用与退出验证通过。正式 fresh install 受 registry 503 阻断。最新 tarball SHA256 `70dd9e374073ef04f249d0d3bec217b0b0fbea391ebf26405ed0fbe08323eda4`；`/tmp/qz-final-recovery-package.log`。 |

此前公网隔离 Chromium 试用中，直驱 15 轮/33 次调用与卡片、内置 Agent 14 次工具调用均无产品错误，已验证原始 element/image target 点击、标题、单会话分组与页面实际值；证据 `tests/results/outer-live-direct/`、`outer-native-clean/`。随后 trace 版直驱任务完成，但透明 checkbox 的 check 报过一次错；通用遮罩标签问题已用旧源 Chrome 2/2 红、修复后 Chrome 2/2 和 Firefox 1/1 绿确认。所有试用先清空隔离配置的标签；不是用户日常浏览器配置，也未冒称重跑了原 8×3 任务报告。

下表包含此稿；本轮相对 `91051e7`，整个分支相对交接基线 `2fdf4d81`，由 git shortstat/numstat 取得。

| 范围 | 本轮 | 整个分支相对交接基线 |
| --- | --- | --- |
| 全部 | 223 files, +6687/−3382 | 499 files, +14618/−8388 |
| `src/` | 93 files, +1559/−877（净 +682） | 259 files, +4403/−3518（净 +885） |
| `tests/` | 103 files, +4217/−1623 | 207 files, +9110/−3462 |
| `services/` | 14 files, +479/−538 | 19 files, +612/−852 |

生产代码没有整体净减：新增外层编排、监听先于动作、共享叶子并发预算、popup 归属及自动连接；CLI 服务目录净减。非公共契约新增的理由见前表；不能把这些功能扩展称作单纯删补丁。

整个分支净增最多的十个文件：

| 文件 | 净增行数 | 原因 |
| --- | ---: | --- |
| `tests/unit/test-drive-operation-surface.mjs` | 418 | 实际目录和调用验证统一对象、错误、隐藏兼容与业务值保真。 |
| `tests/unit/test-qz-script.mjs` | 381 | 外层脚本、参数、所有失败输出、单一 traces 通道与真实 MCP 传输。 |
| `tests/live/direct-drive.mjs` | 333 | 外部模型用真实 CLI 验证任务、原 target、标题/卡片及实际收到的 traces。 |
| `tests/unit/test-run-script-bridge-lifecycle.mjs` | 304 | 外层脚本取消、超时、导航、嵌套调用及返回通道生命周期。 |
| `tests/unit/test-qz-client-scope.mjs` | 242 | 自动首个响应、显式 UUID、会话唯一定位、离线与重连边界。 |
| `tests/support/outer-script-acceptance.mjs` | 223 | Chrome/Firefox 共用导航、网络、排队、popup、取消及成功/失败轨迹验收。 |
| `tests/browser/external-drive.spec.mjs` | 217 | 迁移真实 CLI 脚本调用，保留批量、权限、清理、卡片检查与按需导航诊断。 |
| `tests/browser/element-reference-unification.spec.mjs` | 204 | UID 登记与复用、iframe、失效引用及实际输入。 |
| `src/background/tools/tool-scheduler.ts` | 183 | 同页冲突序列化、跨页并行、十叶子上限与等待/父容器的子触发。 |
| `tests/unit/test-drive-transcript.mjs` | 180 | 会话卡片、嵌套调用与重复调用 ID 的记录契约。 |

其他主要生产净增：connection +117（自动连接和升级）、session/tabs +111（popup 原子认领/清理）、runtime +65（共享调度/只读授权）、wait-observation +55（共享等待）、run-script-bridge +45（原值与可信展示）、open-browser +45（跨平台确定性发现）、mcp-runtime +43（嵌套记录/轨迹）、external-drive +37（批量轨迹）、shared/script-runtime +37（严格序列化）、tool-result-presentation +32（可信元数据契约）、daemon +30（身份锁与取消安全的单次升级）。
