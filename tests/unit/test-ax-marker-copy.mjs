import assert from "node:assert/strict";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { toolT } from "../../src/capabilities/accessibility/tool-messages.js";

const target = "uid:t8.000001.3";
for (const language of ["zh-CN", "en"]) withLanguage(language, () => {
  const en = language === "en";
  const capability = toolT("readViewportRoot", { target });
  assert.equal(capability, en ? `read with the same tabRef and target="${target}" or scope:"full"` : `保持 tabRef，用 target="${target}" 或 scope:"full" 读取`);
  for (const [key, expected] of [
    ["aboveViewport", en ? '↑ 7 AX nodes omitted above viewport; read with the same tabRef and scope:"full" or a tree target passed as target' : '↑ 视口上方省略 7 个 AX 节点；保持 tabRef，用 scope:"full" 或树中 target 传给 target 读取'],
    ["belowViewport", en ? '↓ 7 AX nodes omitted below viewport; read with the same tabRef and scope:"full" or a tree target passed as target' : '↓ 视口下方省略 7 个 AX 节点；保持 tabRef，用 scope:"full" 或树中 target 传给 target 读取'],
    ["foldedAbove", en ? `↑ This block omits 7 content items above; ${capability}` : `↑ 此区块上方省略 7 项内容；${capability}`],
    ["foldedBelow", en ? `↓ This block omits 7 content items below; ${capability}` : `↓ 此区块下方省略 7 项内容；${capability}`],
    ["unmeasuredViewport", en ? "Geometry unavailable: 7 nodes." : "几何信息缺失：7 个节点。"],
  ]) assert.equal(toolT(key, { count: 7, capability }), expected);

  assert.match(toolT("getAxTreeScope"), en ? /Only viewport or full/ : /只能是 viewport 或 full/);
  assert.match(toolT("getAxTreeScope"), en ? /omitted target uses viewport, and a uid: or css: target uses full/ : /未传 target 用 viewport，uid: 或 css: 根用 full/);
  assert.doesNotMatch(toolT("getAxTreeScope"), /scope:"page"|整页根|Page roots/i);
  const description = toolT("getAxTreeDescription", { targetGrammar: "uid:/css:" });
  assert.match(description, en ? /scope is only viewport or full/ : /scope 只能是 viewport 或 full/);
  assert.match(description, en ? /When target is omitted, the default is scope:"viewport"/ : /省略 target 时默认 scope:"viewport"/);
  assert.doesNotMatch(description, /scope:"page"|Whole-page reads default/i);
  assert.match(description, /↑\/↓/);
  assert.match(description, /items=N.*\(truncated, N more\)/);
  assert.match(toolT("getAxTreeRoot"), en ? /scope is only viewport or full/ : /scope 只能是 viewport 或 full/);
});
console.log("Bilingual AX marker and budget copy passed");
