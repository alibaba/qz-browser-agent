# 轻舟 · DeepSeek Harness 插件

[English](README.md)

在 dsh 中通过轻舟操作已连接的 Chrome、Edge 或 Firefox。`qz_browser` 工具调用已安装的
`qz` CLI 执行脚本，结果、Trace、脚本和截图展示在对话卡片中。卡片与无底色帆船标识
跟随 dsh 的日夜主题。

## 安装

需要 Node.js 24.9 及以上、dsh `0.2.2-rc.1`，以及配套的 qz CLI 和浏览器扩展。
先安装[轻舟扩展](https://alibaba.github.io/qz-browser-agent/)，打开侧栏并完成初始化。

```sh
npm install --global qz-browser-agent
qz --version
```

本包发布后，安装到你使用的 dsh profile：

```sh
dsh plugin --profile web add dsh-browser-qz
```

也可以在 dsh「插件」页安装。安装会启用插件组合包；若安装器提示需要重启，请重启 dsh。
本地试用时，把包名替换为下面 `npm pack` 生成的 `.tgz` 文件绝对路径。

然后直接让 dsh 使用轻舟完成网页任务。CLI 会自动准备连接；需要切换浏览器 Profile 时，
运行 `qz connect uri`，在目标浏览器中打开输出的地址。

## 浏览器脚本

模型调用 `qz_browser`，传入简短标题 `title`、脚本 `code`、可选 JSON 参数 `args`
和以秒计的 `timeout`。插件为当前对话创建并保留轻舟会话，脚本使用 qz SDK：

```js
const opened = await qz.openTab({ url: "https://example.com", tabAlias: "example" });
const page = qz.tab(opened);
trace("已打开示例页面");
return await page.read({ limit: 2000 });
```

后续调用复用 `qz.tab("example")`。用 `page.goto(url)` 导航现有标签，
`page.locator(query)` 操作元素，`page.evaluate(fn, args)` 访问页面 DOM。
独立页面的工作流可以在一个脚本内使用 `Promise.all`；同一对话的独立工具调用会排队执行。

只返回后续步骤需要的数据。需要展示截图时，把截图回执包含在返回值中，例如
`return { screenshot: await page.screenshot() }`。插件把 CLI 导出的图片转为 dsh 附件；
只截图而不返回，不会附带图片。模型收到 `{ok,result,trace}` 和图片附件，卡片展示同一份
结果与 Trace。Trace 只包含脚本主动输出和错误。

返回完整的 `page.read()` 或 `page.axTree()` 结果即可保留专用展示，也可以放在
`{ article, structure }` 这样的对象里。文章按 Markdown 展示标题、来源和正文；页面结构
区分角色、名称与 target，支持折叠分支。截图和 `read_image` 显示可打开原图的预览、尺寸
和格式；原始数据仍可查看和复制。普通 Markdown 表格正常排版；内嵌 HTML（包括复杂的
合并单元格表格）目前由 dsh 的 Markdown 组件按原文显示。

停止调用会中断当前脚本，保留会话和标签页；已经发生的浏览器动作不会回滚。
恢复同一 dsh 对话会继续使用原绑定，分叉对话使用自己的轻舟会话。
若轻舟会话已结束或过期，本次调用会在执行脚本前说明，下一次调用可以重新打开任务页面。

## 配置

默认使用 `PATH` 中的 `qz` 和 CLI 的普通连接配置。需要覆盖时，在 profile patch 中配置
`browser-qz`：

```yaml
- id: browser-qz
  config:
    cliPath: /absolute/path/to/qz
    client: work-browser
```

`cliPath` 也可以指向源码仓库中的 `services/mcp-bridge/src/bin.mjs`。
`stateDir` 可指定独立的 qz 状态目录；不填则复用普通 CLI 服务。
`client` 按名称或 UUID 选择已配对的浏览器，可用 `qz browsers` 查看。
Windows 使用 npm 安装的 CLI 或其 JavaScript 入口，以便把取消请求传给 CLI。

## 开发与打包

在本目录运行：

```sh
npm ci
npm test
npm run build
npm run check:package
```

`check:package` 会打包、在临时目录安装并检查两个入口，将验证过的压缩包写入 `dist/`。
也可以直接运行 `npm pack` 打包。
包内包含运行适配器、已构建的 dsh 客户端、组合包配置、语言元数据和文档。
安装时不运行构建脚本；`npm pack` 在本地构建客户端，React 和 dsh 服务由宿主提供。
浏览器扩展与 CLI 单独安装。

源码位于 `services/dsh-plugin`。dsh peer 版本应与集成验证版本一致。
发布前检查包内容并设置正式版本，再运行 `npm publish --access public`。
