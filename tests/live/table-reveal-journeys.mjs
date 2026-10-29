import { runStreamUiJourneys } from "./stream-ui-journeys.mjs";

const format = "请实际打开并读取来源页面，再用中文给出建议。最终回答先写约 300 字背景，再用 Markdown 表格对照（至少 6 行），再写约 1000 字的具体建议和带链接的脚注来源。不要在工具执行前输出长说明。";

export const tableRevealScenarios = [
  { id: "public-python-storage", width: 430, theme: "dark", required: ["csv", "json", "sqlite3"], tools: ["open_tab", "read_article"], table: true,
    prompt: `我正在选小型库存系统的数据存储格式。阅读 https://docs.python.org/3/library/csv.html、https://docs.python.org/3/library/json.html 和 https://docs.python.org/3/library/sqlite3.html，比较 CSV、JSON 和 SQLite 的类型、更新方式、事务、导出和适用规模。${format}` },
  { id: "public-css-layout", width: 360, theme: "light", required: ["grid", "flex"], tools: ["open_tab", "read_article"], table: true,
    prompt: `我要做一个窄屏图片素材管理界面。读取 https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout 和 https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout，对比 Grid 与 Flexbox，并给出缩略图网格和工具栏的布局建议。${format}` },
  { id: "public-http-cache", width: 560, theme: "dark", required: ["Cache-Control", "ETag"], tools: ["open_tab", "read_article"], table: true,
    prompt: `我需要给一个包含用户资料和公共图片的网站设置缓存。读取 https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching，对比 no-store、no-cache、private、public、max-age 和 immutable，说明 ETag 如何配合。${format}` },
  { id: "public-clipboard-design", width: 380, theme: "light", required: ["Clipboard", "writeText", "HTTPS"], tools: ["open_tab", "read_article"], table: true,
    prompt: `我要给客服后台加“复制订单摘要”按钮。读取 https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API 和 https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText，说明 HTTPS、用户操作、权限、拒绝访问和可访问反馈如何处理。首次开页启用 watchNetwork=true，并用 tabAlias/tabRef 引用页面。附一个包含异常处理的 JavaScript 示例。${format}` },
  { id: "public-national-parks", width: 480, theme: "dark", required: ["Yellowstone", "Yosemite", "Zion"], tools: ["open_tab", "read_article", "data_store"], table: true,
    prompt: `我在准备美国国家公园的旅行资料卡。读取 https://www.nps.gov/yell/index.htm、https://www.nps.gov/yose/index.htm 和 https://www.nps.gov/zion/index.htm，提取英文名、所在州、主要自然景观、首页提示的行前注意事项和来源 URL；不要凭记忆补数据，页面未提到的字段注明未提供。保存到 live_park_reference 数据表并读回确认恰好三行。${format}` },
  { id: "public-archive-import", width: 560, theme: "light", required: ["zipfile", "tarfile", "filter"], tools: ["open_tab", "read_article"], table: true,
    prompt: `我需要处理用户上传的 ZIP 和 TAR 资料包。读取 https://docs.python.org/3/library/zipfile.html 和 https://docs.python.org/3/library/tarfile.html，设计文件列表预览、单文件读取、解压目录和大小限制方案，区分 ZIP 路径处理与 TAR extraction filter 的实际行为。明确资料对应的 Python 版本，附短代码示例，并指出仅设置 filter 仍不能保证的限制。${format}` },
];

export function runTableRevealJourneys(options) {
  return runStreamUiJourneys({ ...options, scenarios: tableRevealScenarios });
}
