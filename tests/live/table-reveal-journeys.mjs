import assert from "node:assert/strict";
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
  { id: "public-wikipedia-elements", width: 560, theme: "light", required: ["Wikipedia", "Contents"], tools: ["open_tab", "find_elements", "act_on_element", "list_images", "read_article", "run_script"], table: true,
    prompt: `帮我实测 Wikipedia 的内容导航：打开 https://en.wikipedia.org/wiki/Main_Page，取别名 wiki，此后每个页面工具都显式传 tabRef=wiki。用 find_elements 找到名为 Contents 的链接，把返回的 target 原样交给 act_on_element 点击；需要时先展开菜单。到达 Contents 后读取正文，随后用 list_images 在 css:.mw-logo 范围内找到页眉 Wikipedia 标志，把返回的一张标志图片的 target 原样交给 act_on_element 点击回主页。不要用 navigate、新开页或脚本代替这两次点击。回到主页后，用 act_on_element 的 CSS target（css:input[name='search']）填写搜索词 Hangzhou，不提交；需要时先展开搜索入口。最后调用一次外层 run_script，脚本不带 tabRef，使用顶层 return await tools.evaluate({tabRef:"wiki",code:()=>({...})})，由 evaluate 的自包含函数读取并返回 {url:location.href,title:document.title,searchValue:document.querySelector('input[name="search"]').value,business:{tabId:"page-owned",selector:"business-field",inner:{nodes:[1,2]}}}，业务对象的键和值保持不变。报告实际来源、两次导航、搜索框实际值和最终 URL/标题。${format}`,
    check: checkWikipediaElements },
  { id: "public-national-parks", width: 480, theme: "dark", required: ["Yellowstone", "Yosemite", "Zion"], tools: ["open_tab", "read_article", "data_store"], table: true,
    prompt: `我在准备美国国家公园的旅行资料卡。读取 https://www.nps.gov/yell/index.htm、https://www.nps.gov/yose/index.htm 和 https://www.nps.gov/zion/index.htm，提取英文名、所在州、主要自然景观、首页提示的行前注意事项和来源 URL；不要凭记忆补数据，页面未提到的字段注明未提供。保存到 live_park_reference 数据表并读回确认恰好三行。${format}` },
  { id: "public-archive-import", width: 560, theme: "light", required: ["zipfile", "tarfile", "filter"], tools: ["open_tab", "read_article"], table: true,
    prompt: `我需要处理用户上传的 ZIP 和 TAR 资料包。读取 https://docs.python.org/3/library/zipfile.html 和 https://docs.python.org/3/library/tarfile.html，设计文件列表预览、单文件读取、解压目录和大小限制方案，区分 ZIP 路径处理与 TAR extraction filter 的实际行为。明确资料对应的 Python 版本，附短代码示例，并指出仅设置 filter 仍不能保证的限制。${format}` },
];

async function checkWikipediaElements({ events, messages, record, page }) {
  const ends = events.filter(event => event.type === "tool_execution_end");
  for (const type of ["tool_execution_start", "tool_execution_end"]) {
    const ids = events.filter(event => event.type === type).map(event => event.toolCallId);
    assert.equal(new Set(ids).size, ids.length, `${type} has no duplicate calls`);
  }
  const results = new Map(ends.map(event => [event.toolCallId, event.result]));
  const modelResult = id => {
    const reply = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    assert.ok(reply, `tool result ${id} reached the model`);
    return JSON.parse(typeof reply.content === "string" ? reply.content : reply.content.find(item => item.type === "text").text);
  };
  const calls = messages.flatMap((message, turn) => (message.tool_calls || []).map(call => ({ call, turn }))).map(({ call, turn }, index) => ({
    id: call.id, index, turn, name: call.function.name, args: JSON.parse(call.function.arguments), result: results.get(call.id),
  }));
  assert.equal(calls.filter(call => call.name === "open_tab").length, 1);
  const opened = calls.find(call => call.name === "open_tab");
  assert.equal(opened.args.tabAlias, "wiki"); assert.equal(opened.result.tabRef, "wiki");
  assert.equal(opened.args.url, "https://en.wikipedia.org/wiki/Main_Page");
  for (const call of calls.filter(call => ["find_elements", "act_on_element", "list_images", "read_article"].includes(call.name))) assert.equal(call.args.tabRef, "wiki");
  const followTarget = (name, key, matches, after = -1) => {
    for (const source of calls.filter(call => call.name === name && call.index > after)) {
      const targets = (source.result?.[key] || []).filter(matches).map(item => item.target).filter(Boolean);
      const reply = messages.findIndex(message => message.role === "tool" && message.tool_call_id === source.id);
      const click = calls.find(call => reply >= 0 && call.turn > reply && call.name === "act_on_element" && call.args.action === "click" && targets.includes(call.args.target));
      if (click) return { source, click };
    }
    assert.fail(`${name} returned a target that must be clicked unchanged`);
  };
  const contents = followTarget("find_elements", "results", item => /\bContents\b/i.test(`${item.name || ""} ${item.text || ""}`) && (item.role === "link" || item.tag === "a"));
  const logo = followTarget("list_images", "images", item => /wikipedia/i.test([item.alt, item.title, item.src, item.currentSrc].join(" ")), contents.click.index);
  assert.equal(logo.source.args.target, "css:.mw-logo");
  assert.match(logo.source.result.pageUrl, /^https:\/\/en\.wikipedia\.org\/wiki\/Wikipedia(?::|%3A)Contents(?:[?#]|$)/i);
  assert.equal(calls.filter(call => call.name === "navigate").length, 0);
  const filled = calls.find(call => call.index > logo.click.index && call.name === "act_on_element" && call.args.action === "fill" && String(call.args.target).startsWith("css:") && call.args.value === "Hangzhou");
  assert.ok(filled, "the search box was filled through a CSS target");
  for (const call of [contents.click, logo.click, filled]) {
    const receipt = modelResult(call.id);
    for (const key of Object.keys(receipt)) assert.ok(["navigated", "url", "navigationPending", "confirmationRequired", "hint"].includes(key), `compact action receipt: ${key}`);
    assert.notEqual(receipt.confirmationRequired, true, "ordinary link clicks and search input fill are confirmed");
  }
  const scripts = calls.filter(call => call.name === "run_script"); assert.equal(scripts.length, 1);
  assert.ok(scripts[0].index > filled.index);
  for (const key of ["tabRef", "target", "scope"]) assert.equal(Object.hasOwn(scripts[0].args, key), false, `outer run_script has no ${key}`);
  const trace = scripts[0].result?._display?.script?.trace || [];
  assert.ok(trace.some(row => row.level === "tool.start" && row.message === "evaluate"), "the outer script invoked the real page evaluate tool");
  const observed = modelResult(scripts[0].id);
  assert.deepEqual(Object.keys(observed).sort(), ["business", "searchValue", "title", "url"]);
  assert.deepEqual(observed.business, { tabId: "page-owned", selector: "business-field", inner: { nodes: [1, 2] } });
  assert.match(observed.url, /^https:\/\/en\.wikipedia\.org\/wiki\/Main_Page(?:[?#]|$)/);
  assert.equal(observed.searchValue, "Hangzhou");
  const actual = page.context().pages().find(candidate => candidate.url() === observed.url);
  assert.ok(actual, "the browser returned to Main_Page"); assert.equal(observed.title, await actual.title());
  assert.equal(await actual.locator('input[name="search"]').first().inputValue(), "Hangzhou");
  record.targetReuse = { contents: contents.click.args.target, logo: logo.click.args.target, fill: filled.args.target, scriptResult: observed };
}

export function runTableRevealJourneys(options) {
  return runStreamUiJourneys({ ...options, scenarios: tableRevealScenarios });
}
