// Static, authored translations for the shared homepage DOM.
export const translations = {
  "en": {
    "title": "qz — Open-source browser agent",
    "html": {
      "skip": "Skip to content",
      "navOverview": "Data",
      "navExtend": "Skills",
      "navStart": "Install<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "heroBadge": "<span class=\"square\" aria-hidden=\"true\"></span>OPEN SOURCE · LOCAL FIRST",
      "heroTitle": "An agent that<br><span>actually uses<br>the browser.</span>",
      "heroIntro": "Read websites, automate actions, and save results as tables, files, or image collections. Connect your own model.",
      "heroAction": "Add to Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "filmCaption": "Wikipedia · Page reading and JavaScript execution",
      "filmAction": "Watch demo",
      "overviewTitle": "Web research, saved as data.",
      "extendTitle": "Scripts, tools,<br>and custom UI.",
      "extendDescription": "This Wikipedia Skill finds city photos and displays the results in an image grid. Its instructions, scripts, and UI can be reused on another city’s page.",
      "ownershipTitle": "Local storage. Your model.",
      "ownershipDescription": "Sessions, Skills, and collected data are stored in your browser. Connect a service with a compatible API and tool calling, including a local model server.",
      "ownershipPrivacy": "Task context is sent to your configured model service. Skills and MCP connections may exchange data with services you configure.",
      "ownershipLink": "Permissions &amp; data flow<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "startTitle": "Install qz",
      "startDescription": "Install from the Chrome Web Store, then connect your model API or local endpoint.",
      "startDownload": "Add to Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "startGuide": "Manual install · GitHub Release<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "promptLabel": "TRY A TASK",
      "promptCopy": "Copy prompt",
      "prompt": "Open Wikipedia’s Hangzhou page. Make a table of its main sights, with a short description and a source link for each.",
      "footerDocs": "Documentation",
      "footerIssues": "Feedback",
      "footerPrivacy": "Privacy",
      "footerCredits": "Credits",
      "videoTitle": "qz demo",
      "videoLanguage": "English demo · Captions available",
      "videoNote": "Page reading, data extraction, scripting, Skills, and parallel tasks.",
      "videoFallback": "Your browser does not support this video. ",
      "videoDownload": "Download the video",
      "extension1Title": "Skills",
      "extension1Description": "Install from a Git repository, edit in the panel, and activate on matching websites.",
      "extension1Link": "Skill guide<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step1Title": "Add to Chrome",
      "step1Description": "In the Chrome Web Store, click “Add to Chrome” and confirm the installation.",
      "extension2Title": "TypeScript capabilities",
      "extension2Description": "Add agent tools, panel views, settings pages, or providers as compiled TypeScript modules.",
      "extension2Link": "Capability API<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step2Title": "Connect your model",
      "step2Description": "Open qz Settings. Choose a provider, enter your credentials, select a model, and save.",
      "step3Title": "Give it a task",
      "step3Description": "Open the side panel and describe what you want to do. You can adjust the task while it runs.",
      "tableTitle": "Compare tools using their official documentation",
      "tableDescription": "qz read the Playwright, Puppeteer, and Selenium docs and saved a six-criterion comparison. The result is a table you can edit and export.",
      "galleryTitle": "Collect images with their sources",
      "galleryDescription": "Save photos from a page to a local collection. Browse thumbnails and open the source image. Shown here: Hangzhou landmarks from Wikipedia.",
      "codeTitle": "Page scripts",
      "codeDescription": "Inspect and edit a Skill’s JavaScript resources directly in the panel.",
      "uiTitle": "Custom result cards",
      "uiDescription": "Display tool results as summary cards, image grids, or tables inside the conversation.",
      "parallelTitle": "Research with parallel subtasks",
      "parallelDescription": "Delegate parts of a task and combine the findings. Here, agents research West Lake walks and Longjing tea experiences for a Hangzhou itinerary.",
      "imageTitle": "Screenshot",
      "imageOpen": "Open original",
      "navAgents": "For agents",
      "agentsTitle": "Agent-friendly.",
      "agentsDescription": "Let your agent delegate browser tasks to qz.",
      "cliTitle": "Install the CLI",
      "cliDescription": "Connect once. Start tasks from your terminal.",
      "commandCopy": "Copy commands",
      "cliCommands": "npm install --global qz-browser-agent\nqz connect",
      "cliMcp": "Also available via <code>npx --yes qz-browser-agent@latest</code>. For MCP, run <code>qz mcp</code> after connecting to get the connection URL.",
      "cliGuide": "CLI &amp; MCP guide",
      "agentTitle": "Install the Skill",
      "agentDescription": "Let your coding agent delegate browser tasks to qz.",
      "agentTargets": "Then ask your agent: “Use qz to compare these three product pages and save a sourced table.”",
      "agentGuide": "Read the Skill",
      "agentTerminalLabel": "YOUR TERMINAL / CODING AGENT",
      "agentPanelLabel": "qz / CHROME SIDE PANEL",
      "agentExampleLabel": "Example session",
      "agentTerminalPrompt": "qz create \"Compare Playwright, Puppeteer and Selenium. Save a sourced table.\" --stream",
      "agentTerminalQueued": "Task queued",
      "agentTerminalReading": "I’ll read their official documentation and compare the tools.",
      "agentTerminalResult": "Saved 6 comparison rows with source links.",
      "agentTerminalExport": "qz data export \"browser_automation_tool_comparison\" --format csv",
      "agentTerminalFile": "browser_automation_tool_comparison.csv",
      "agentRequirements": "Requires Node.js 22+ and Chrome on the same machine, with the qz extension and a model configured."
    },
    "attributes": {
      "description": {
        "content": "An open-source Chrome agent for web research, browser automation, data extraction, and reusable Skills. Bring your own model."
      },
      "ogTitle": {
        "content": "qz — Open-source browser agent"
      },
      "ogDescription": {
        "content": "An open-source Chrome agent for web research, browser automation, data extraction, and reusable Skills. Bring your own model."
      },
      "ogImage": {
        "content": "https://alibaba.github.io/qz-browser-agent/assets/workspace.png"
      },
      "home": {
        "aria-label": "qz — Home"
      },
      "nav": {
        "aria-label": "Main navigation"
      },
      "screenshot": {
        "src": "./assets/workspace.png",
        "alt": "qz at work on Wikipedia’s Hangzhou page"
      },
      "screenshotLink": {
        "href": "./assets/workspace.png",
        "aria-label": "Open full-size screenshot"
      },
      "skillGuide": {
        "href": "https://github.com/alibaba/qz-browser-agent/blob/main/README.md#skills"
      },
      "installGuide": {
        "href": "https://github.com/alibaba/qz-browser-agent/releases/latest"
      },
      "copy": {
        "data-copied": "Copied",
        "data-failed": "Select and copy the prompt below."
      },
      "footer": {
        "aria-label": "Footer navigation"
      },
      "documentation": {
        "href": "https://github.com/alibaba/qz-browser-agent/blob/main/README.md"
      },
      "closeVideo": {
        "aria-label": "Close video"
      },
      "closeImage": {
        "aria-label": "Close screenshot"
      },
      "tableImage": {
        "src": "./assets/screens/table-en.png",
        "alt": "qz Data view: a live research comparison of Playwright, Puppeteer, and Selenium"
      },
      "tableLink": {
        "href": "./assets/screens/table-en.png",
        "aria-label": "Enlarge browser automation comparison table"
      },
      "galleryImage": {
        "src": "./assets/screens/gallery-en.png",
        "alt": "qz image collection with Hangzhou landmark photographs"
      },
      "galleryLink": {
        "href": "./assets/screens/gallery-en.png",
        "aria-label": "Enlarge: qz image collection with Hangzhou landmark photographs"
      },
      "skill-codeImage": {
        "src": "./assets/screens/skill-code-en.png",
        "alt": "JavaScript resource editor for the Wikipedia city photos Skill"
      },
      "skill-codeLink": {
        "href": "./assets/screens/skill-code-en.png",
        "aria-label": "Enlarge: JavaScript resource editor for the Wikipedia city photos Skill"
      },
      "skill-uiImage": {
        "src": "./assets/screens/skill-ui-en.png",
        "alt": "Wikipedia Skill result with summary cards and an image grid"
      },
      "skill-uiLink": {
        "href": "./assets/screens/skill-ui-en.png",
        "aria-label": "Enlarge: Wikipedia Skill result with summary cards and an image grid"
      },
      "parallelImage": {
        "src": "./assets/screens/parallel-en.png",
        "alt": "Task tree showing agents researching Hangzhou in parallel"
      },
      "parallelLink": {
        "href": "./assets/screens/parallel-en.png",
        "aria-label": "Enlarge: Task tree showing agents researching Hangzhou in parallel"
      },
      "copyCommand": {
        "data-copied": "Copied",
        "data-failed": "Select and copy the commands below."
      },
      "agentPanelImage": {
        "src": "./assets/screens/agent-en.png",
        "alt": "qz side panel showing a real browser automation research task"
      },
      "agentPanelLink": {
        "href": "./assets/screens/agent-en.png",
        "aria-label": "Enlarge the qz side panel"
      },
      "agentTarget": {
        "aria-label": "Install Skill for"
      }
    }
  },
  "zh-CN": {
    "title": "轻舟 qz — 开源浏览器智能体",
    "html": {
      "skip": "跳转到正文",
      "navOverview": "数据",
      "navExtend": "Skill",
      "navStart": "安装<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "heroBadge": "<span class=\"square\" aria-hidden=\"true\"></span>开源 · 本地优先",
      "heroTitle": "一个真正<br><span>会用浏览器的<br>智能体。</span>",
      "heroIntro": "阅读网页、执行操作，把结果保存为表格、文件或图集。连接你自己的模型，通过 Skill 扩展功能。",
      "heroAction": "添加至 Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "filmCaption": "Wikipedia · 阅读页面与执行 JavaScript",
      "filmAction": "观看演示",
      "overviewTitle": "把网页资料整理成数据。",
      "extendTitle": "脚本、工具，<br>还有自定义界面。",
      "extendDescription": "这个 Wikipedia Skill 提取城市照片，并用图片网格展示结果。指令、脚本与界面保存在一起，换一个城市页面也能复用。",
      "ownershipTitle": "本地存储，自选模型。",
      "ownershipDescription": "会话、Skill 和采集的数据保存在浏览器中。连接支持兼容 API 和工具调用的服务，也可以使用本地模型。",
      "ownershipPrivacy": "任务上下文会发送至你配置的模型服务。Skill 和 MCP 连接也可能与你配置的服务交换数据。",
      "ownershipLink": "权限与数据流说明<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "startTitle": "安装轻舟",
      "startDescription": "从 Chrome 应用商店安装，再连接模型 API 或本地模型接口。",
      "startDownload": "添加至 Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "startGuide": "手动安装 · GitHub Release<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "promptLabel": "试一个任务",
      "promptCopy": "复制指令",
      "prompt": "打开 Wikipedia 的杭州页面，把主要景点整理成一张表格，每个景点附上简短介绍和来源链接。",
      "footerDocs": "使用文档",
      "footerIssues": "问题反馈",
      "footerPrivacy": "隐私",
      "footerCredits": "素材来源",
      "videoTitle": "轻舟演示",
      "videoLanguage": "英文演示 · 可开启英文字幕",
      "videoNote": "页面阅读、数据提取、脚本执行、Skill 与并行任务。",
      "videoFallback": "浏览器不支持播放此视频。 ",
      "videoDownload": "下载视频",
      "extension1Title": "Skill",
      "extension1Description": "从 Git 仓库安装，在界面中编辑，并在匹配的网站上启用。",
      "extension1Link": "Skill 指南<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step1Title": "添加至 Chrome",
      "step1Description": "在 Chrome 应用商店点击“添加至 Chrome”，确认安装。",
      "extension2Title": "TypeScript 能力包",
      "extension2Description": "通过编译进扩展的 TypeScript 模块，添加工具、面板视图、设置页或模型服务商。",
      "extension2Link": "能力包 API<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step2Title": "连接模型",
      "step2Description": "打开轻舟设置，选择服务商、填写凭证、选择模型并保存。",
      "step3Title": "开始第一个任务",
      "step3Description": "打开侧边栏，描述你想做的事。执行过程中也可以继续调整任务。",
      "tableTitle": "查阅官方文档，生成工具对比表",
      "tableDescription": "轻舟阅读 Playwright、Puppeteer 和 Selenium 的官方文档，按六个维度生成对比表，可继续编辑并导出。",
      "galleryTitle": "采集图片，保留来源",
      "galleryDescription": "把网页图片保存到本地图集，浏览缩略图、打开来源图片。图中展示了从 Wikipedia 收集的杭州地标照片。",
      "codeTitle": "页面脚本",
      "codeDescription": "直接在侧边栏查看、编辑 Skill 的 JavaScript 资源。",
      "uiTitle": "自定义结果卡片",
      "uiDescription": "在对话中用统计卡片、图片网格或表格展示工具结果。",
      "parallelTitle": "多个子任务，并行研究",
      "parallelDescription": "把任务拆分给多个 Agent，再汇总结果。图中的子任务分别调查西湖路线、龙井体验，并核对交通与预约信息。",
      "imageTitle": "界面截图",
      "imageOpen": "查看原图",
      "navAgents": "Agent 接入",
      "agentsTitle": "Agent 友好性。",
      "agentsDescription": "让你的 Agent 把浏览器任务交给轻舟。",
      "cliTitle": "安装 CLI",
      "cliDescription": "连接轻舟，在终端下达任务。",
      "commandCopy": "复制命令",
      "cliCommands": "npm install --global qz-browser-agent\nqz connect",
      "cliMcp": "也可直接使用 <code>npx --yes qz-browser-agent@latest</code>。MCP 客户端可在连接后运行 <code>qz mcp</code> 获取连接地址。",
      "cliGuide": "CLI 与 MCP 指南",
      "agentTitle": "安装 Skill",
      "agentDescription": "让编程 Agent 学会把浏览器任务交给轻舟。",
      "agentTargets": "然后告诉你的 Agent：“用 qz 对比这三个商品页面，保存带来源链接的表格。”",
      "agentGuide": "查看 Skill",
      "agentTerminalLabel": "你的终端 / 编程 AGENT",
      "agentPanelLabel": "轻舟 / CHROME 侧边栏",
      "agentExampleLabel": "命令示例",
      "agentTerminalPrompt": "qz create \"对比 Playwright、Puppeteer 和 Selenium，保存带来源的表格。\" --stream",
      "agentTerminalQueued": "Task queued",
      "agentTerminalReading": "我会查阅官方文档，整理三个工具的差异。",
      "agentTerminalResult": "已保存 6 行对比数据，附有来源链接。",
      "agentTerminalExport": "qz data export \"browser_automation_tool_comparison\" --format csv",
      "agentTerminalFile": "browser_automation_tool_comparison.csv",
      "agentRequirements": "需要 Node.js 22+，以及同一台电脑上的 Chrome、轻舟扩展和已配置的模型。"
    },
    "attributes": {
      "description": {
        "content": "轻舟是开源 Chrome 智能体，支持网页研究、浏览器自动化、数据提取和可复用 Skill，连接你自己的模型。"
      },
      "ogTitle": {
        "content": "轻舟 qz — 开源浏览器智能体"
      },
      "ogDescription": {
        "content": "轻舟是开源 Chrome 智能体，支持网页研究、浏览器自动化、数据提取和可复用 Skill，连接你自己的模型。"
      },
      "ogImage": {
        "content": "https://alibaba.github.io/qz-browser-agent/assets/workspace-zh-CN.png"
      },
      "home": {
        "aria-label": "qz — 轻舟首页"
      },
      "nav": {
        "aria-label": "主导航"
      },
      "screenshot": {
        "src": "./assets/workspace-zh-CN.png",
        "alt": "轻舟在 Wikipedia 杭州页面执行真实任务"
      },
      "screenshotLink": {
        "href": "./assets/workspace-zh-CN.png",
        "aria-label": "查看原尺寸截图"
      },
      "skillGuide": {
        "href": "https://github.com/alibaba/qz-browser-agent/blob/main/README.zh-CN.md#skill"
      },
      "installGuide": {
        "href": "https://github.com/alibaba/qz-browser-agent/releases/latest"
      },
      "copy": {
        "data-copied": "已复制",
        "data-failed": "请选中下方指令并复制。"
      },
      "footer": {
        "aria-label": "页脚导航"
      },
      "documentation": {
        "href": "https://github.com/alibaba/qz-browser-agent/blob/main/README.zh-CN.md"
      },
      "closeVideo": {
        "aria-label": "关闭视频"
      },
      "closeImage": {
        "aria-label": "关闭截图"
      },
      "tableImage": {
        "src": "./assets/screens/table-zh.png",
        "alt": "轻舟数据页：实际研究生成的 Playwright、Puppeteer、Selenium 中文对比表"
      },
      "tableLink": {
        "href": "./assets/screens/table-zh.png",
        "aria-label": "放大查看浏览器自动化工具对比表"
      },
      "galleryImage": {
        "src": "./assets/screens/gallery-zh.png",
        "alt": "轻舟图集中的杭州地标照片"
      },
      "galleryLink": {
        "href": "./assets/screens/gallery-zh.png",
        "aria-label": "放大查看：轻舟图集中的杭州地标照片"
      },
      "skill-codeImage": {
        "src": "./assets/screens/skill-code-zh.png",
        "alt": "维基百科城市照片 Skill 的 JavaScript 资源编辑器"
      },
      "skill-codeLink": {
        "href": "./assets/screens/skill-code-zh.png",
        "aria-label": "放大查看：维基百科城市照片 Skill 的 JavaScript 资源编辑器"
      },
      "skill-uiImage": {
        "src": "./assets/screens/skill-ui-zh.png",
        "alt": "维基百科 Skill 的统计卡片、图片网格与结果表格"
      },
      "skill-uiLink": {
        "href": "./assets/screens/skill-ui-zh.png",
        "aria-label": "放大查看：维基百科 Skill 的统计卡片、图片网格与结果表格"
      },
      "parallelImage": {
        "src": "./assets/screens/parallel-zh.png",
        "alt": "轻舟任务树：多个 Agent 并行调查杭州行程"
      },
      "parallelLink": {
        "href": "./assets/screens/parallel-zh.png",
        "aria-label": "放大查看：轻舟任务树：多个 Agent 并行调查杭州行程"
      },
      "copyCommand": {
        "data-copied": "已复制",
        "data-failed": "请选中下方命令并复制。"
      },
      "agentPanelImage": {
        "src": "./assets/screens/agent-zh.png",
        "alt": "轻舟侧边栏展示真实的浏览器自动化工具研究任务"
      },
      "agentPanelLink": {
        "href": "./assets/screens/agent-zh.png",
        "aria-label": "放大查看轻舟侧边栏"
      },
      "agentTarget": {
        "aria-label": "Skill 安装目标"
      }
    }
  }
};
