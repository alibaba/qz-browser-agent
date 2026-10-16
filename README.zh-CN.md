# qz-browser-agent（轻舟）

[English](README.md) · 简体中文

> 两岸猿声啼不住，轻舟已过万重山。  
> —— 李白《早发白帝城》

**轻舟**（`qz`，*qingzhou* 的缩写）是一个本地优先的 Chrome 扩展，用于网页研究、浏览器自动化和结构化数据提取。使用你自己的模型，并通过 Skill 和 TypeScript 能力包扩展功能。

![轻舟从 Wikipedia 采集杭州照片](docs/images/workspace-zh-CN.png)

https://github.com/user-attachments/assets/3203bc89-ef26-4f66-86cc-b602a912a1ab

## 功能

- **浏览器自动化**：通过 DOM 元素或截图操作页面，填写表单，跨标签页协作，支持桌面和移动端视口。
- **并行子任务**：并行运行任务并委派子任务。执行过程中可随时中断、调整方向或补充上下文。
- **结构化数据**：将表格、媒体和网页内容提取到本地数据集合，并在侧边栏中预览、编辑和导出。
- **Skill**：在目标网页中运行 JavaScript。将指令、脚本、工具和自定义界面打包为可复用的 Skill，并可按站点自动启用。
- **模型选择**：支持任何具备工具调用能力且协议兼容的服务商，包括本地模型服务。
- **TypeScript 能力包**：添加 Agent 工具、面板视图、设置页或模型服务商。
- **CLI 与 MCP**：从终端、编程 Agent 或 MCP 客户端委派浏览器任务，通过同一连接管理任务、数据、图集和设置。

## 隐私与数据流

会话、Skill 和采集的数据存储在浏览器中。模型请求包含你的输入和任务上下文，包括网页或文件内容、截图、标签页信息，以及授权读取的书签或历史记录。当任务需要本地信息时，`get_location` 工具可获取经纬度、精度和定位时间并发送给模型。首次调用时会征求你的同意。Skill 和 MCP 连接也可能与你配置的服务交换数据。详见[隐私政策与浏览器权限](docs/permissions.md)。

## 快速开始

### 安装

1. 下载[最新版本](https://github.com/alibaba/qz-browser-agent/releases/latest)中的 ZIP 安装包。
2. 解压文件。
3. 打开 `chrome://extensions`，启用**开发者模式**。
4. 点击**加载已解压的扩展程序**，选择解压后的 `qz-browser-agent-extension` 文件夹。

### 从源码构建

如需本地构建，安装 Node.js 24 LTS 和 npm，然后在本地仓库中运行：

```bash
npm ci
npm run build
```

按照上面的 Chrome 安装步骤，选择 `dist/extension/` 作为扩展文件夹。

### 使用

1. 从扩展工具栏打开轻舟侧边栏。
2. 在**设置**中选择服务商并填写凭证。使用自定义接口时，还需填写 URL 和协议。
3. 选择模型并保存。
4. 试着输入：`打开 example.com，把页面的主标题提取到一张表格中。`

## CLI 与编程 Agent

给 qz 一个目标和需要的产出，它会自行规划并执行浏览器任务，返回结果或需要用户回答的问题。终端和轻舟侧边栏可以查看同一个任务。

在运行 Chrome 的同一台机器上使用 Node.js 24 或更高版本。从[最新版本](https://github.com/alibaba/qz-browser-agent/releases/latest)安装扩展，在轻舟设置中配置模型，然后安装 CLI：

```bash
npm install --global qz-browser-agent
qz connect
qz create "比较 SQLite、DuckDB 和 PostgreSQL 在本地数据分析中的取舍，把优缺点和来源链接整理成表格。" --stream
```

`connect` 会在需要时打开连接页面。请使用安装了轻舟的 Chrome 用户配置，并完成首次数据告知。`--stream` 实时显示进展、待回答的问题和结果。
也可以不做全局安装，将命令中的 `qz` 替换为 `npx --yes qz-browser-agent@latest`。

### 给 Agent 安装 Skill

安装 [qz-browser-agent Skill](skills/qz-browser-agent/SKILL.md)，让编程 Agent 检查连接、委派任务、处理用户输入并获取结果：

```bash
npx --yes skills add alibaba/qz-browser-agent --skill qz-browser-agent --agent codex --global
```

安装给 Claude Code 或 Pi 时，将目标改为 `--agent claude-code` 或 `--agent pi`。`--skill` 选择 Skill，`--agent` 选择编程 Agent。其他目标见[支持列表](https://github.com/vercel-labs/skills#supported-agents)。

然后对 Agent 说：**用轻舟比较这三个产品页面，把价格和来源链接整理成表格。**

使用 MCP 客户端时，连接后运行 `qz mcp`，将返回的 HTTP 地址填入客户端配置。任务追问、用户输入、导出和设置等用法见 [CLI 与 MCP 指南](services/mcp-bridge/README.md)。

## 扩展轻舟

### Skill

Skill 用于打包可重复的工作流程：自动化脚本、侧边栏中的交互组件，以及在匹配网站上自动启用的站点 Skill。可以在界面中管理，也可以从 Git 仓库安装。

### TypeScript 能力包

能力包是编译进扩展的 TypeScript 模块。将[示例能力包](tests/fixtures/capabilities/example/README.md)复制到 `src/capabilities/<your-feature>/`，重命名其中的注册项，保留需要的部分：

```ts
// src/capabilities/<your-feature>/index.ts
export { default as tools } from "./tools.js";         // Agent 工具
export { default as renderers } from "./renderers.js"; // 工具结果视图
```

构建时会自动发现这些声明。工具处理函数运行在后台 service worker 中，可将操作和脚本执行委派给活动标签页；Renderer 在侧边栏中挂载可交互的结果卡片。

SDK 详情见[能力包指南](src/capabilities/README.md)。这些 API 仍处于实验阶段，兼容性约定见[扩展契约](CONTRIBUTING.md#extension-contracts)。

## 开发

运行测试前，请先完成[测试环境配置](docs/commands.md#run-tests)。

```bash
npm run dev       # 源码变更后自动重新构建
npm test          # 运行默认测试
npm run verify    # 类型检查，并运行全部自动化测试与覆盖率统计
```

重新构建后，在 `chrome://extensions` 中重新加载扩展，并重新打开侧边栏。

- [架构](docs/architecture.md)
- [命令与构建选项](docs/commands.md)
- [基准测试](docs/benchmarks.md)
- [贡献指南](CONTRIBUTING.md)

## 许可证

[Apache-2.0](LICENSE)。第三方依赖保留各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
