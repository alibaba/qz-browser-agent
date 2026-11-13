import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { driveGuide, resetDriveGuideCache } from "../../services/mcp-bridge/src/drive-guide.mjs";
import { BridgeError } from "../../services/mcp-bridge/src/state.mjs";
import { driveExtensionTimeoutSeconds, executeMcpTool } from "../../services/mcp-bridge/src/tools.mjs";
import { buildScriptRequest, presentScriptResult, scriptTimeouts } from "../../services/mcp-bridge/src/script-call.mjs";

const CHARS_PER_TOKEN = 23156 / 5700;

test("the packaged guide matches the installed Skill and keeps one script vocabulary", () => {
  const source = readFileSync(new URL("../../skills/qz-browser-agent/SKILL.md", import.meta.url), "utf8");
  const mirror = readFileSync(new URL("../../services/mcp-bridge/src/qz-drive-SKILL.md", import.meta.url), "utf8");
  assert.equal(mirror, source);
  assert.deepEqual(readdirSync(new URL("../../skills", import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "node_modules").map(entry => entry.name), ["qz-browser-agent"]);
  resetDriveGuideCache();
  const guide = driveGuide();
  assert.equal(driveGuide({ env: { LANG: "zh_CN.UTF-8" } }), guide);
  assert.match(source, /qz \(轻舟\)/);
  assert.doesNotMatch(source.replaceAll('qz (轻舟)', 'qz'), /[\u3400-\u9fff]/);
  assert.match(source, /qz skill.*installed CLI/);
  assert.match(guide, /Do not configure a qz model/);
  assert.match(guide, /references\/create-task\.md/);
  for (const method of ["qz.tab", "qz.openTab", "qz.listTabs", "qz.listTools", "qz.call", "page.locator", "page.evaluate"]) {
    assert.ok(guide.includes(method), `The guide must document ${method}`);
  }
  const syntax = [...guide.matchAll(/```(?:js|sh)\n([\s\S]*?)```|`([^`\n]+)`/g)]
    .map(match => match[1] || match[2]).join("\n");
  assert.doesNotMatch(syntax, /\btools\s*\./);
  assert.doesNotMatch(guide, /qz (?:exec|tools)\b|--tab|qz-browser-agent@latest|page\.click|\b(?:inner|tabId|workingTab|isWorkingTab|use_tab|get_working_tab|selector)\b/);
  assert.doesNotMatch(guide, /\bqz stop\b|\bqz connect\b(?! uri)/);
  for (const command of ["create", "list", "show", "cancel"]) assert.match(guide, new RegExp(`qz session ${command}`));
  assert.match(guide, /active.*never selects/);
  assert.match(guide, /qz\.tab\(tabRef\)/);
  assert.match(guide, /uid:t<tab>\.<snap>\.<n>/);
  assert.match(guide, /`rect` is `\{x,y,width,height\}`/);
  assert.match(guide, /Ordinary success returns `\{\}`/);
  assert.match(guide, /expect:"navigation"/);
  assert.match(guide, /expect:"popup"/);
  assert.match(guide, /`within`/);
  assert.match(guide, /waitForMatch:true/);
  assert.match(guide, /returns an array of every matching current element observation/);
  assert.match(guide, /\)\)\.slice\(0,5\)/);
  assert.doesNotMatch(guide, /\{results,total,truncated\}|\.results\.slice\(/);
  assert.match(guide, /scrollIntoView/);
  assert.match(guide, /page\.scroll\(\{direction,pixels\}\)/);
  assert.equal(guide.match(/timeout` option is in seconds/g)?.length, 1, "the guide states the timeout unit once");
  assert.doesNotMatch(guide, /\b(?:waitFor|waitOptions|visibleOnly)\b|`scope` is an observed|locator\.nth\(index\)/);
  assert.match(guide, /listener before/);
  assert.match(guide, /locator\.count\(\)/);
  assert.match(guide, /\.wait\(\{count:/);
  assert.match(guide, /not transactions/);
  assert.match(guide, /stdout is JSON `\{ok,result,trace\}`/);
  assert.match(guide, /`trace` contains only errors and explicit `trace\(\)`\/`console` output, in order/);
  assert.match(guide, /load_skill.*qingzhou-documents/);
  assert.match(guide, /timed out|timeout/i);
  assert.doesNotMatch(guide, /\bMCP\b|\bqingzhou_(?:guide|create_drive_session|execute_tool|list_tools|get_tool|bridge_status|stop_session)\b|keepTabs:true/i);
  const tokens = guide.length / CHARS_PER_TOKEN;
  assert.ok(guide.length > 1000 && tokens <= 5000, `${guide.length} chars is ${tokens} estimated tokens`);
});

test("MCP server instructions retain their explicit session and page-reference contract", () => {
  const bridgeTools = readFileSync(new URL("../../services/mcp-bridge/src/tools.mjs", import.meta.url), "utf8");
  const instructions = bridgeTools.slice(bridgeTools.indexOf("const DRIVE_INSTRUCTIONS"), bridgeTools.indexOf("export function mcpCatalogProfile"));
  assert.doesNotMatch(instructions, /不传 sessionId 时，这条 MCP 连接共用一个新 id|Without sessionId, this MCP connection keeps one new id/);
  assert.doesNotMatch(instructions, /返回的 id|a returned id/i);
  assert.doesNotMatch(instructions, /\binner\b/i);
  assert.doesNotMatch(instructions, /target page|第一次调用创建会话|The first call creates a session/);
  assert.match(instructions, /qz session create/);
  assert.match(instructions, /qingzhou_create_drive_session/);
  assert.match(instructions, /不会自动建会话/);
  assert.match(instructions, /does not create a session/);
  assert.match(instructions, /open_tab \/ list_tabs 返回的 tabRef/);
  assert.match(instructions, /the tabRef returned by open_tab or list_tabs/);
});

test("outer scripts pass args separately and present traces with values by transport status", () => {
  assert.throws(() => buildScriptRequest({ code: "return 1" }), /requires --session/);
  assert.deepEqual(buildScriptRequest({ code: "return input", sessionId: " s ", args: [1, 2] }), {
    name: "run_script", sessionId: "s", scriptApiVersion: 2, args: { timeout: 120, code: "return input", args: [1, 2] },
  });
  const business = { ok: false, code: "APP_CODE", message: "business", result: 7, trace: [1] };
  assert.deepEqual(presentScriptResult({ scriptApiVersion: 2, isError: false, result: { ok: true, result: business, trace: [] } }), { text: JSON.stringify({ ok: true, result: business, trace: [] }) + "\n", exitCode: 0 });
  const error = { code: "SCRIPT_EVALUATION_FAILED", message: "SyntaxError", hint: "Fix the function.", details: { line: 2, column: 4 } };
  const bad = presentScriptResult({ scriptApiVersion: 2, isError: true, result: { ok: false, result: error, trace: [] } });
  assert.equal(bad.exitCode, 1);
  assert.deepEqual(JSON.parse(bad.text), { ok: false, result: error, trace: [] });
  const oldExtension = presentScriptResult({ result: business });
  assert.equal(oldExtension.exitCode, 1);
  assert.equal(JSON.parse(oldExtension.text).result.code, "UPGRADE_REQUIRED");
  assert.match(JSON.parse(oldExtension.text).result.hint, /may have run.*Inspect/);
  assert.deepEqual(scriptTimeouts({}), { scriptSeconds: 120, requestSeconds: 180 });
  assert.deepEqual(scriptTimeouts({ timeoutOption: "5", timeoutSeconds: 5 }), { scriptSeconds: 5, requestSeconds: 65 });
});

function driveState(callExtension) {
  return {
    requestTimeoutSeconds: 180,
    signal: signal => signal || new AbortController().signal,
    resolveClient: async id => ({ id: id || "browser", controller: new AbortController() }),
    callExtension,
  };
}

test("a run_script request waits for the script plus 60 seconds and retries one busy session", async () => {
  assert.equal(driveExtensionTimeoutSeconds({
    name: "run_script",
    timeoutSeconds: 30,
    args: { timeout: 200 },
  }, 180), 260);
  assert.equal(driveExtensionTimeoutSeconds({
    calls: [{ name: "run_script", args: { timeout: 0 } }],
    timeoutSeconds: 30,
  }, 180), 86400);
  const seen = [];
  let attempts = 0;
  const busy = driveState(async (_method, params, options) => {
    attempts += 1;
    seen.push({ payloadTimeout: params.timeoutSeconds, wait: options.timeoutSeconds });
    if (attempts === 1) throw new BridgeError("DRIVE_SESSION_BUSY", "busy");
    return { ok: true };
  });
  await executeMcpTool(busy, "qingzhou_execute_tool", {
    name: "run_script",
    sessionId: "created",
    timeoutSeconds: 30,
    args: { tabRef: "page", timeout: 200, code: "async () => 1" },
  });
  assert.equal(attempts, 2);
  assert.equal(seen[0].payloadTimeout, 30);
  assert.equal(seen[0].wait, 260);
  assert.equal(seen[1].wait, 260);
  let occupied = 0;
  await assert.rejects(executeMcpTool(driveState(async () => {
    occupied += 1;
    throw new BridgeError("DRIVE_SESSION_OCCUPIED", "occupied");
  }), "qingzhou_execute_tool", { sessionId: "created", name: "list_tabs", args: {} }), error => error.code === "DRIVE_SESSION_OCCUPIED");
  assert.equal(occupied, 1);
});
