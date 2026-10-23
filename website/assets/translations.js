// Static, authored translations for the shared homepage DOM.
// ogImage supplies both Open Graph and Twitter images.
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
      "heroIntro": "A coding agent that lives in your browser. It opens tabs, reads pages, runs scripts, and turns what works into a Skill.",
      "heroAction": "Add to Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "filmCaption": "Wikipedia · Page reading and JavaScript execution",
      "filmAction": "Watch demo",
      "overviewTitle": "Web research, delivered as data.",
      "extendTitle": "Scripts, tools,<br>and custom UI.",
      "extendDescription": "This Wikipedia Skill finds city photos and displays the results in an image grid. Its instructions, scripts, and UI can be reused on another city’s page.",
      "ownershipTitle": "Local storage. Your model.",
      "ownershipDescription": "Sessions, Skills, and collected data are stored in your browser. Use a compatible model service with tool calling, a local model server, or OpenAI Codex with ChatGPT sign-in.",
      "ownershipPrivacy": "No usage reporting. No account to create. qz runs no servers of its own. Task content goes only to the model you choose.",
      "ownershipLink": "Permissions &amp; data flow<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "startTitle": "Install qz",
      "startDescription": "Install from the Chrome Web Store, then connect your model service or sign in with ChatGPT.",
      "startDownload": "Add to Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "startGuide": "Manual install · GitHub Release<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "promptLabel": "TRY A TASK",
      "promptCopy": "Copy prompt",
      "prompt": "Find this year’s Nobel Prize winners in every category and put them in a table with source links.",
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
      "extension1Description": "Once a task works, just say “Save this as a Skill” to reuse it anytime. You can also install Skills from a Git repository.",
      "extension1Link": "See the example<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step1Title": "Add to Chrome",
      "step1Description": "In the Chrome Web Store, click “Add to Chrome” and confirm the installation.",
      "extension2Title": "TypeScript capabilities",
      "extension2Description": "Add agent tools, panel views, settings pages, or providers as compiled TypeScript modules.",
      "extension2Link": "Capability API<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step2Title": "Connect your model",
      "step2Description": "Open qz Settings. Choose a provider and enter its credentials, or choose OpenAI Codex and sign in with ChatGPT. Select a model and save.",
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
      "agentRequirements": "Requires Node.js 22+ and Chrome on the same machine, with the qz extension and a model configured.",
      /* example-html:en:start */
      "examplesTitle": "Real tasks, start to finish.",
      "examplesLede": "Each example is a real qz session. The frame on the left is from that session. Follow every step on the right, then import it into qz and pick up the conversation.",
      "exampleDownload": "Import into qz to continue",
      "examplesGrid": "    <a class=\"example-card\" href=\"./examples/en/travel/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/travel-en.webp\"><img src=\"./assets/examples/travel-en-card.gif\" width=\"840\" height=\"500\" alt=\"The gallery of Kyoto photos from the session\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>Kyoto attractions gallery</h3>\n      <p>5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery.</p>\n    </a>\n    <a class=\"example-card\" href=\"./examples/en/hn-skill/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/hn-skill-en.webp\"><img src=\"./assets/examples/hn-skill-en-card.gif\" width=\"840\" height=\"500\" alt=\"Building a Skill from the HN front page\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>Turn Hacker News into a Skill</h3>\n      <p>Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.</p>\n    </a>\n    <a class=\"example-card\" href=\"./examples/en/github-weekly/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/github-weekly-en.webp\"><img src=\"./assets/examples/github-weekly-en-card.gif\" width=\"840\" height=\"518\" alt=\"This week's trending list and the project table\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>Weekly GitHub trending digest</h3>\n      <p>Reads this week's Trending list, puts it into a table, and writes a short weekly summary.</p>\n    </a>\n    <a class=\"example-card\" href=\"./examples/en/pelican/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/pelican-en.webp\"><img src=\"./assets/examples/pelican-en-card.gif\" width=\"840\" height=\"518\" alt=\"A pelican on a bicycle, drawn with the mouse on a canvas\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>A pelican riding a bicycle</h3>\n      <p>Operating the UI like a person.</p>\n    </a>",
      "example-travel-title": "Kyoto attractions gallery",
      "example-travel-summary": "5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery.",
      "example-hn-skill-title": "Turn Hacker News into a Skill",
      "example-hn-skill-summary": "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.",
      "example-hn-skill-first": "Create the Skill",
      "example-hn-skill-reuse": "Reuse in one sentence",
      "example-github-weekly-title": "Weekly GitHub trending digest",
      "example-github-weekly-summary": "Reads this week's Trending list, puts it into a table, and writes a short weekly summary.",
      "example-pelican-title": "A pelican riding a bicycle",
      "example-pelican-summary": "Operating the UI like a person.",
      "example-en-travel-title": "Kyoto attractions gallery",
      "example-en-travel-summary": "5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery.",
      "example-en-hn-skill-title": "Turn Hacker News into a Skill",
      "example-en-hn-skill-summary": "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.",
      "example-en-hn-skill-reuse": "Reuse in one sentence",
      "example-en-hn-skill-reuse-title": "Turn Hacker News into a Skill",
      "example-en-hn-skill-reuse-summary": "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence.",
      "example-en-hn-skill-reuse-first": "Create the Skill",
      "example-en-github-weekly-title": "Weekly GitHub trending digest",
      "example-en-github-weekly-summary": "Reads this week's Trending list, puts it into a table, and writes a short weekly summary.",
      "example-en-pelican-title": "A pelican riding a bicycle",
      "example-en-pelican-summary": "Operating the UI like a person."
      /* example-html:en:end */
    },
    "attributes": {
      "description": {
        "content": "A coding agent that lives in your browser. It opens tabs, reads pages, runs scripts, and turns what works into a Skill."
      },
      "ogTitle": {
        "content": "qz — Open-source browser agent"
      },
      "ogDescription": {
        "content": "A coding agent that lives in your browser. It opens tabs, reads pages, runs scripts, and turns what works into a Skill."
      },
      "ogImage": {
        "content": "https://alibaba.github.io/qz-browser-agent/assets/og-card.png"
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
        "href": "https://github.com/alibaba/qz-browser-agent/blob/main/README.md#get-it-right-once-save-it-as-a-skill-in-one-sentence"
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
      /* example-attr:en:start */
      "example-travel-description": {
        "content": "5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery."
      },
      "example-hn-skill-description": {
        "content": "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence."
      },
      "example-github-weekly-description": {
        "content": "Reads this week's Trending list, puts it into a table, and writes a short weekly summary."
      },
      "example-pelican-description": {
        "content": "Operating the UI like a person."
      },
      "example-travel-poster": {
        "alt": "The gallery of Kyoto photos from the session",
        "aria-label": "The gallery of Kyoto photos from the session"
      },
      "example-hn-skill-poster": {
        "alt": "Building a Skill from the HN front page",
        "aria-label": "Building a Skill from the HN front page"
      },
      "example-hn-skill-reuse-poster": {
        "alt": "Reusing the saved Skill in a new session to read Show HN",
        "aria-label": "Reusing the saved Skill in a new session to read Show HN"
      },
      "example-github-weekly-poster": {
        "alt": "This week's trending list and the project table",
        "aria-label": "This week's trending list and the project table"
      },
      "example-pelican-poster": {
        "alt": "A pelican on a bicycle, drawn with the mouse on a canvas",
        "aria-label": "A pelican on a bicycle, drawn with the mouse on a canvas"
      },
      "example-en-travel-description": {
        "content": "5 sub-tasks run at once, each finds its own pictures, and the results merge into one gallery."
      },
      "example-en-travel-poster": {
        "alt": "The gallery of Kyoto photos from the session",
        "aria-label": "The gallery of Kyoto photos from the session"
      },
      "example-en-hn-skill-description": {
        "content": "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence."
      },
      "example-en-hn-skill-poster": {
        "alt": "Building a Skill from the HN front page",
        "aria-label": "Building a Skill from the HN front page"
      },
      "example-en-hn-skill-reuse-description": {
        "content": "Sorts out the top 5 posts on the front page, then saves the method as a Skill you can reuse with one sentence."
      },
      "example-en-hn-skill-reuse-poster": {
        "alt": "Reusing the saved Skill in a new session to read Show HN",
        "aria-label": "Reusing the saved Skill in a new session to read Show HN"
      },
      "example-en-github-weekly-description": {
        "content": "Reads this week's Trending list, puts it into a table, and writes a short weekly summary."
      },
      "example-en-github-weekly-poster": {
        "alt": "This week's trending list and the project table",
        "aria-label": "This week's trending list and the project table"
      },
      "example-en-pelican-description": {
        "content": "Operating the UI like a person."
      },
      "example-en-pelican-poster": {
        "alt": "A pelican on a bicycle, drawn with the mouse on a canvas",
        "aria-label": "A pelican on a bicycle, drawn with the mouse on a canvas"
      }
      /* example-attr:en:end */
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
      "heroIntro": "把 Coding Agent 装进浏览器，十几个标签页的活，它一次干完。读网页，跑脚本，汇总表格图集，并能总结 Skill。",
      "heroAction": "添加至 Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "filmCaption": "Wikipedia · 阅读页面与执行 JavaScript",
      "filmAction": "观看演示",
      "overviewTitle": "网页再乱，也能整理成一张表。",
      "extendTitle": "脚本、工具，<br>还有自定义界面。",
      "extendDescription": "这个 Wikipedia Skill 提取城市照片，并用图片网格展示结果。指令、脚本与界面保存在一起，换一个城市页面也能复用。",
      "ownershipTitle": "本地存储，自选模型。",
      "ownershipDescription": "会话、Skill 和采集的数据保存在浏览器中。选择支持工具调用的兼容模型服务、本地模型，或通过 OpenAI Codex 用 ChatGPT 账号登录。",
      "ownershipPrivacy": "不上报使用数据，不用注册账号，轻舟没有自己的服务器。任务内容只发给你选的模型。",
      "ownershipLink": "权限与数据流说明<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "startTitle": "安装轻舟",
      "startDescription": "从 Chrome 应用商店安装，再连接模型服务或用 ChatGPT 账号登录。",
      "startDownload": "添加至 Chrome<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"></path></svg>",
      "startGuide": "手动安装 · GitHub Release<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "promptLabel": "试一个任务",
      "promptCopy": "复制指令",
      "prompt": "查今年诺贝尔奖各奖项得主，整理成带来源链接的表格。",
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
      "extension1Description": "任务跑通后，一句话就能存成可复用的 Skill，也可以从 Git 仓库安装。",
      "extension1Link": "查看用例<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step1Title": "添加至 Chrome",
      "step1Description": "在 Chrome 应用商店点击“添加至 Chrome”，确认安装。",
      "extension2Title": "TypeScript 能力包",
      "extension2Description": "通过编译进扩展的 TypeScript 模块，添加工具、面板视图、设置页或模型服务商。",
      "extension2Link": "能力包 API<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 18 18 6M6 6h12v12\"></path></svg>",
      "step2Title": "连接模型",
      "step2Description": "打开轻舟设置，选择服务商并填写凭证，或选择 OpenAI Codex 用 ChatGPT 账号登录。选择模型并保存。",
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
      "agentRequirements": "需要 Node.js 22+，以及同一台电脑上的 Chrome、轻舟扩展和已配置的模型。",
      /* example-html:zh:start */
      "examplesTitle": "真实任务，完整过程。",
      "examplesLede": "每个例子都是轻舟的一次真实会话。左边是这次会话自己的画面，右边是它每一步怎么想、怎么做；导入轻舟，就能接着这段对话继续问。",
      "exampleDownload": "导入轻舟继续对话",
      "examplesGrid": "    <a class=\"example-card\" href=\"./examples/travel/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/travel-zh.webp\"><img src=\"./assets/examples/travel-zh-card.gif\" width=\"840\" height=\"510\" alt=\"并行找图后汇成的杭州景点图集\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>杭州景点图集</h3>\n      <p>5 个景点，5 个子任务同时开跑，各自找图，最后汇成一份图集。</p>\n    </a>\n    <a class=\"example-card\" href=\"./examples/hn-skill/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/hn-skill-zh.webp\"><img src=\"./assets/examples/hn-skill-zh-card.gif\" width=\"840\" height=\"510\" alt=\"整理 HN 热帖并生成 Skill 的过程\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>将 Hacker News 变成 Skill</h3>\n      <p>整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。</p>\n    </a>\n    <a class=\"example-card\" href=\"./examples/github-weekly/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/github-weekly-zh.webp\"><img src=\"./assets/examples/github-weekly-zh-card.gif\" width=\"840\" height=\"510\" alt=\"本周榜单和整理出的项目表\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>GitHub 周榜整理</h3>\n      <p>读完本周 Trending 榜单，整理成表，再写好一段周报总结。</p>\n    </a>\n    <a class=\"example-card\" href=\"./examples/pelican/\">\n      <span class=\"example-cover\"><picture><source media=\"(prefers-reduced-motion: reduce)\" srcset=\"./assets/examples/pelican-zh.webp\"><img src=\"./assets/examples/pelican-zh-card.gif\" width=\"840\" height=\"558\" alt=\"用鼠标在画布上画出的骑自行车的鹈鹕\" loading=\"lazy\" decoding=\"async\"></picture></span>\n      <h3>喜闻乐见的鹈鹕骑自行车</h3>\n      <p>像人一样操作界面</p>\n    </a>",
      "example-travel-title": "杭州景点图集",
      "example-travel-summary": "5 个景点，5 个子任务同时开跑，各自找图，最后汇成一份图集。",
      "example-hn-skill-title": "将 Hacker News 变成 Skill",
      "example-hn-skill-summary": "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。",
      "example-hn-skill-first": "创建 Skill",
      "example-hn-skill-reuse": "一句话复用",
      "example-github-weekly-title": "GitHub 周榜整理",
      "example-github-weekly-summary": "读完本周 Trending 榜单，整理成表，再写好一段周报总结。",
      "example-pelican-title": "喜闻乐见的鹈鹕骑自行车",
      "example-pelican-summary": "像人一样操作界面",
      "example-en-travel-title": "杭州景点图集",
      "example-en-travel-summary": "5 个景点，5 个子任务同时开跑，各自找图，最后汇成一份图集。",
      "example-en-hn-skill-title": "将 Hacker News 变成 Skill",
      "example-en-hn-skill-summary": "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。",
      "example-en-hn-skill-reuse": "一句话复用",
      "example-en-hn-skill-reuse-title": "将 Hacker News 变成 Skill",
      "example-en-hn-skill-reuse-summary": "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。",
      "example-en-hn-skill-reuse-first": "创建 Skill",
      "example-en-github-weekly-title": "GitHub 周榜整理",
      "example-en-github-weekly-summary": "读完本周 Trending 榜单，整理成表，再写好一段周报总结。",
      "example-en-pelican-title": "喜闻乐见的鹈鹕骑自行车",
      "example-en-pelican-summary": "像人一样操作界面"
      /* example-html:zh:end */
    },
    "attributes": {
      "description": {
        "content": "轻舟是在已登录的 Chrome 中运行的开源 AI Agent。自选模型或用 ChatGPT 账号登录，通过 CLI、Skill 或 MCP 接入编程 Agent。"
      },
      "ogTitle": {
        "content": "轻舟 qz — 开源浏览器智能体"
      },
      "ogDescription": {
        "content": "轻舟是在已登录的 Chrome 中运行的开源 AI Agent。自选模型或用 ChatGPT 账号登录，通过 CLI、Skill 或 MCP 接入编程 Agent。"
      },
      "ogImage": {
        "content": "https://alibaba.github.io/qz-browser-agent/assets/og-card.png"
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
        "href": "https://github.com/alibaba/qz-browser-agent/blob/main/README.zh-CN.md#跑通一次一句话存成-skill"
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
      /* example-attr:zh:start */
      "example-travel-description": {
        "content": "5 个景点，5 个子任务同时开跑，各自找图，最后汇成一份图集。"
      },
      "example-hn-skill-description": {
        "content": "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。"
      },
      "example-github-weekly-description": {
        "content": "读完本周 Trending 榜单，整理成表，再写好一段周报总结。"
      },
      "example-pelican-description": {
        "content": "像人一样操作界面"
      },
      "example-travel-poster": {
        "alt": "并行找图后汇成的杭州景点图集",
        "aria-label": "并行找图后汇成的杭州景点图集"
      },
      "example-hn-skill-poster": {
        "alt": "整理 HN 热帖并生成 Skill 的过程",
        "aria-label": "整理 HN 热帖并生成 Skill 的过程"
      },
      "example-hn-skill-reuse-poster": {
        "alt": "新会话里用已保存的 Skill 查看 Show HN 热帖",
        "aria-label": "新会话里用已保存的 Skill 查看 Show HN 热帖"
      },
      "example-github-weekly-poster": {
        "alt": "本周榜单和整理出的项目表",
        "aria-label": "本周榜单和整理出的项目表"
      },
      "example-pelican-poster": {
        "alt": "用鼠标在画布上画出的骑自行车的鹈鹕",
        "aria-label": "用鼠标在画布上画出的骑自行车的鹈鹕"
      },
      "example-en-travel-description": {
        "content": "5 个景点，5 个子任务同时开跑，各自找图，最后汇成一份图集。"
      },
      "example-en-travel-poster": {
        "alt": "并行找图后汇成的杭州景点图集",
        "aria-label": "并行找图后汇成的杭州景点图集"
      },
      "example-en-hn-skill-description": {
        "content": "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。"
      },
      "example-en-hn-skill-poster": {
        "alt": "整理 HN 热帖并生成 Skill 的过程",
        "aria-label": "整理 HN 热帖并生成 Skill 的过程"
      },
      "example-en-hn-skill-reuse-description": {
        "content": "整理首页前 5 条帖子，再把这套做法存成 Skill，下次一句话就能用。"
      },
      "example-en-hn-skill-reuse-poster": {
        "alt": "新会话里用已保存的 Skill 查看 Show HN 热帖",
        "aria-label": "新会话里用已保存的 Skill 查看 Show HN 热帖"
      },
      "example-en-github-weekly-description": {
        "content": "读完本周 Trending 榜单，整理成表，再写好一段周报总结。"
      },
      "example-en-github-weekly-poster": {
        "alt": "本周榜单和整理出的项目表",
        "aria-label": "本周榜单和整理出的项目表"
      },
      "example-en-pelican-description": {
        "content": "像人一样操作界面"
      },
      "example-en-pelican-poster": {
        "alt": "用鼠标在画布上画出的骑自行车的鹈鹕",
        "aria-label": "用鼠标在画布上画出的骑自行车的鹈鹕"
      }
      /* example-attr:zh:end */
    }
  }
};
