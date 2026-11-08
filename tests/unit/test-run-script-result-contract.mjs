import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileInnerWorker } from "../../scripts/build-extension.mjs";
import { runInnerWorker } from "../support/inner-runner-fixture.mjs";
import { wrapRunScriptSource } from "../../src/shared/run-script-source.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = [
  readSource("src/background/tools/runtime.js"),
  readSource("src/capabilities/script/tools.js"),
].join("\n");
const manifest = readSource("src/manifest.json");
const offscreen = transformSync(readSource("src/offscreen.ts"), { loader: "ts" }).code;
const sandbox = transformSync(readSource("src/runner-sandbox.ts"), { loader: "ts" }).code;
const sidepanel = readSource("src/sidepanel/sidepanel.js");
const dataStore = readSource("src/shared/data-store.ts");
const serviceWorker = readSource("src/background/service-worker.js");
const runScriptBridge = readSource("src/background/tools/run-script-bridge.js");
const manifestJson = JSON.parse(manifest);
const innerWorkerSource = readFileSync(join(root, "src/workers/inner-runner.ts"), "utf8");
const compiledWorker = await compileInnerWorker();
const scriptRuntimeSource = readSource("src/shared/script-runtime.ts");
const innerWorkerWrapperLine = innerWorkerSource.split("\n").find(line => line.includes('new Function("input"')) || "";

assert.doesNotMatch(source, /MAX_SCRIPT_RESULT_CHARS/, "run_script should not enforce a result-size truncation threshold");
assert.doesNotMatch(source, /json\.length\s*<=\s*MAX_CHARS\s*\?\s*JSON\.parse\(json\)/, "run_script should not stringify large results into truncated text");
assert.doesNotMatch(source, /runScriptWithScriptingBridge/, "run_script should not keep a chrome.scripting fallback helper");
assert.doesNotMatch(source, /cdp_fallback|scripting fallback failed/, "run_script should not expose scripting fallback behavior");
assert.match(source, /function makePageContextUnavailableResult\(/, "run_script should use an explicit page-context unavailable result");
assert.match(source, /error:\s*"page_context_unavailable"/, "page-context failure should have a stable agent-readable error");
assert.match(source, /execution_world:\s*"page"/, "the private page runner envelope should identify its execution world");
assert.match(source, /execution_world:\s*"inner"/, "the private Worker envelope should identify its execution world");
assert.deepEqual(manifestJson.sandbox?.pages, ["runner-sandbox.html"], "manifest should register the inner runner sandbox page");
assert.match(manifestJson.content_security_policy?.sandbox || "", /unsafe-eval[\s\S]*worker-src blob:/, "manifest should provide a sandboxed eval-capable worker host for inner run_script");
assert.match(offscreen, /run_script_inner_ping/, "offscreen should expose an inner runner ready ping");
assert.match(offscreen, /runner-sandbox\.html/, "offscreen should host the sandbox runner page");
assert.match(offscreen, /run_script_inner_execute[\s\S]*run_script_tool_call/s, "offscreen should execute inner scripts and relay tool calls through the existing bridge");
assert.match(offscreen, /run_script_inner_fetch[\s\S]*fetch_response/s, "offscreen should relay standard Skill fetch calls through the background boundary");
assert.match(offscreen, /event\.source !== sandboxFrame\.contentWindow/, "offscreen should accept sandbox messages only from its owned iframe window");
assert.match(sandbox, /event\.source !== parent/, "sandbox should accept host messages only from its parent window");
assert.match(offscreen, /run_script_inner_fetch_cancel/, "offscreen should relay per-request fetch cancellation to Background");
assert.match(offscreen, /sendResponse\(\{\s*ok:\s*true,\s*accepted:\s*true[\s\S]*publishInnerRunResult/s, "offscreen should ack inner execute immediately and publish results separately");
assert.match(source, /handleRunScriptInnerRuntimeMessage[\s\S]*run_script_inner_result[\s\S]*pending\.resolve\(msg\.result\)/s, "background should resolve the real inner envelope, not wrap it in a transport ack");
assert.doesNotMatch(source, /pending\.resolve\(\{\s*ok:\s*true,\s*result:\s*msg\.result\s*\}\)/, "inner transport ack must not leak into the run_script result protocol");
assert.match(source, /const envelope = record\(response\);[\s\S]*compactRunScriptEnvelope\(envelope,\s*"offscreen_inner"\)/, "inner runner should consume the resolved response as the final run_script envelope");
assert.match(source, /runScriptInnerPendingByRequestId/, "background should own inner runner pending requests instead of waiting on offscreen sendResponse");
assert.match(source, /const runScriptInnerPendingByRequestId = .*new Map\(\)/, "background should isolate concurrent inner runs by request id");
assert.match(offscreen, /const pendingRuns = .*new Map\(\)/, "offscreen should isolate concurrent inner runs by request id");
assert.match(sandbox, /const workers = .*new Map\(\)/, "sandbox should isolate concurrent inner workers by request id");
assert.match(sandbox, /workers\.set\(requestId,\s*worker\)/, "sandbox should track each inner worker independently");
assert.match(sandbox, /workers\.delete\(requestId\)[\s\S]*worker\.terminate\(\)/, "sandbox should clean up the completed worker for the matching request id");
assert.match(offscreen, /scriptSource:\s*String\(msg\.source \|\| ""\)/, "offscreen should not send script code through the message routing source field");
assert.match(sandbox, /source:\s*String\(data\.scriptSource \|\| ""\)/, "sandbox should read script code from scriptSource so routing source remains stable");
assert.match(sandbox, /URL\.createObjectURL\(new Blob\(\[INNER_WORKER_SOURCE\][\s\S]*new Worker\(workerUrl\)/, "sandbox should execute inner scripts in a terminable worker");
assert.match(innerWorkerSource, /new Function\("input", "args", "\$plugin", "tools", "tool", "trace", "log", "tabId"/, "inner worker should expose Skill config as a first-class script binding");
assert.match(innerWorkerSource, /if \(payload\.fetchBridge === true\) self\.fetch = createBridgedFetch/, "plugin inner scripts should keep the standard fetch call surface");
assert.match(innerWorkerSource, /signal\?\.addEventListener\?\.\("abort", abort/, "the bridged fetch surface should preserve per-request AbortSignal cancellation");
assert.match(innerWorkerSource, /type: "fetch_cancel"/, "the inner worker should cancel only its matching Background fetch call");
assert.match(innerWorkerSource, /import \{[^}]*safeValueForMessage[^}]*scriptValue[^}]*scriptToolArguments[^}]*installSecurityGuards[^}]*\} from "\.\.\/shared\/script-runtime\.js"/, "the Worker should share strict public serialization, tool arguments and Skill security guards");
assert.match(scriptRuntimeSource, /function safeValueForMessage\(/, "shared script runtime should own dynamic value serialization");
assert.match(innerWorkerSource, /const safeToolArgs = scriptToolArguments\(toolName, toolArgs\)/, "the Worker should serialize callable code only for code-bearing tools before crossing postMessage");
assert.match(innerWorkerSource, /strictResult \? scriptValue\(result\) : safeValueForMessage\(result\)/, "public scripts require JSON values while existing Skill serialization stays available");
assert.match(source, /const __qzSafeValueForMessage = value => QZ_SCRIPT_RUNTIME\.safeValueForMessage\(value, "page"\)/, "page runtime should select page serialization semantics from the compiled shared runtime");
assert.match(source, /QZ_SCRIPT_RUNTIME\.installSecurityGuards\(__qzSecurityGuardrails, "page"\)/, "page runtime should install the shared guard with page semantics");
assert.match(source, /const safeInput = __qzSafeValueForMessage\(input \|\| \{\}\)/, "page runtime should sanitize tool args before window.postMessage");
assert.match(source, /QZ_SCRIPT_RUNTIME\.scriptValue\(result\)/, "page evaluation should use strict public JSON serialization");
assert.match(source, /strictResult \? "QZ_SCRIPT_RUNTIME\.scriptValue\(result\)" : "__qzSafeValueForMessage\(result\)"/, "internal Skill page scripts should retain their existing value serializer");
assert.match(runScriptBridge, /function failureResponse\(/, "run_script tool bridge should have one failure response contract");
assert.match(runScriptBridge, /const respondFailure[\s\S]*withLanguage\(language, \(\) => failureResponse\(withToolOperationFailure\(payload, operation\), options\)/, "run language scopes must retain execution evidence in the shared failure response contract");
assert.match(runScriptBridge, /const isError = isToolFailure\(result\)[\s\S]*await applyNestedToolResult\([\s\S]*if \(isError\)[\s\S]*respondFailure\(result/, "run_script tool bridge should record and reject tool failure payloads instead of resolving error objects");
assert.match(runScriptBridge, /catch \(error\)[\s\S]*return respondFailure\(/, "run_script tool bridge should reject thrown tool errors");
assert.doesNotMatch(serviceWorker, /ok:\s*true,\s*[\r\n\s]*result:\s*localizeToolFailurePayload\(\{[\s\S]*RUN_SCRIPT_TOOL_CALL_FAILED/, "run_script tool bridge must not wrap failed tool calls as successful responses");
assert.match(source, /if \(!response\.ok\)[\s\S]*reject\(bridgeError\)/, "page run_script tools should reject failed bridge responses");
assert.match(innerWorkerSource, /if \(!response\.ok\)[\s\S]*call\.reject\(error\)/, "inner run_script tools should reject failed bridge responses");
for (const [name, text] of Object.entries({ tools: source, offscreen, sandbox, sidepanel, dataStore })) {
  assert.doesNotMatch(text, /console\.info/, `${name} should not keep console.info debug logs`);
}
assert.doesNotMatch(source, /\[run_script:inner\]/, "inner runner should not write normal lifecycle events into the global LLM console trace");
assert.doesNotThrow(() => new Function(compiledWorker), "inner worker source embedded in the sandbox must be syntactically valid");
assert.ok(innerWorkerWrapperLine.includes('{\\n" + source + "\\n})();'), "inner worker wrapper should use one newline escape layer, not literal backslash-n code");
assert.doesNotMatch(innerWorkerWrapperLine, /\{\\\\n" \+ source \+ "\\\\n/, "inner worker wrapper must not double-escape newline separators");
assert.doesNotThrow(() => {
  const innerSmokeSource = wrapRunScriptSource(`async () => {
 return { ok: true, message: "Hello World!轻舟 inner环境正常运行 ✅", timestamp: new Date().toISOString() };
}`);
  const body = `"use strict"; return (async () => {\n${innerSmokeSource}\n})();`;
  new Function("input", "args", "$plugin", "tools", "tool", "trace", "log", "tabId", body);
}, "inner worker wrapper should accept a normal async arrow script with Chinese text and emoji inside strings");
{
  const { result: envelope } = await runInnerWorker(compiledWorker, `
    const cycle = { name: 'cycle' }; cycle.self = cycle;
    return { fn: function namedUnsafe() {}, symbol: Symbol('unsafe'), bigint: 9007199254740993n,
      date: new Date('2026-07-09T00:00:00.000Z'), regexp: /qingzhou/gi,
      map: new Map([['fn', () => 'map']]), set: new Set([Symbol('set')]),
      proxy: new Proxy({}, { ownKeys() { throw new Error('bad ownKeys'); } }), cycle };
  `);
  assert.equal(envelope.ok, true);
  const safe = envelope.result;
  assert.equal(safe.fn.__qz_uncloneable, 'function');
  assert.equal(safe.symbol.__qz_uncloneable, 'symbol');
  assert.equal(safe.bigint, '9007199254740993');
  assert.equal(safe.proxy.__qz_uncloneable, 'object');
  assert.equal(safe.cycle.self.__qz_circular, true);
  assertCloneSafe(envelope, 'inner sanitized envelope');
}

{
  const authored = { ok: false, error: 'authored', code: 'BUSINESS_STATUS', message: 'Returned value',
    _display: { script: { trace: ['authored'] } }, _image: 'ordinary data', text: 'x'.repeat(50_000) };
  const calls = [];
  const { result: envelope } = await runInnerWorker(compiledWorker,
    'return await tools.evaluate({tabRef: "page", code: ({value}) => value, args: {value: 7}});', {
      strictResult: true,
      onMessage(message, reply) {
        if (message.type !== 'tool_call') return;
        calls.push(message);
        reply({ type: 'tool_response', callId: message.callId, response: { ok: true, result: authored } });
      },
    });
  assert.equal(envelope.ok, true, 'returned error-shaped business data is successful execution');
  assert.deepEqual(envelope.result, authored, 'strict public JSON values retain all business keys and long values');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'evaluate');
  assert.equal(calls[0].args.tabRef, 'page');
  assert.equal(typeof calls[0].args.code, 'string', 'a callable crosses the Worker boundary as code');
  assert.deepEqual(calls[0].args.args, { value: 7 });
  assertCloneSafe(envelope, 'public script envelope');
}

{
  const { result: envelope } = await runInnerWorker(compiledWorker, 'return {callback: () => 1};', { strictResult: true });
  assert.equal(envelope.ok, false, 'unsupported public values must fail instead of becoming placeholder objects');
  assert.equal(envelope.code, 'SCRIPT_VALUE_NOT_SERIALIZABLE');
}

assert.ok(
  (source.match(/world:\s*"ISOLATED"/g) || []).length >= 2,
  "internal chrome.scripting bridges should execute in the isolated world so page CSP cannot block bridge code",
);
assert.doesNotMatch(source, /qz-run-script-trace/, "page scripts must not broadcast trace rows");
assert.match(source, /Object\.defineProperty\(__qzPromise, "__qzTrace"/, "page traces stay on the promise held by CDP");
assert.match(innerWorkerSource, /script_trace/, "inner diagnostics reach the host before a script completes");
assert.match(innerWorkerSource, /liveInnerTraces/, "inner traces stay addressable for the timeout snapshot");
{
  const hung = wrapRunScriptSource("async () => { for (let i = 0; i < 8; i += 1) trace('row-' + i); await new Promise(() => {}); }");
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = globalThis;
    globalThis.location = { href: 'https://fixture.test/' };
    self.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => self.onmessage({ data }));
    ${compiledWorker}
  `, { eval: true, execArgv: [] });
  const seen = [];
  try {
    const snapshot = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("trace snapshot timed out")), 5000);
      worker.on("message", message => {
        seen.push(message.type);
        if (message.type === "trace_snapshot") { clearTimeout(timer); resolve(message.trace); }
      });
      worker.postMessage({ type: "execute", requestId: "hung", source: hung });
      worker.postMessage({ type: "trace_snapshot", requestId: "hung" });
    });
    assert.deepEqual(snapshot.map(row => row.message), ["row-3", "row-4", "row-5", "row-6", "row-7"]);
    assert.equal(seen.includes("script_trace"), true);
  } finally {
    await worker.terminate();
  }
}

console.log("run_script result contract tests passed");

function readSource(path) {
  const sourcePath = existsSync(join(root, path)) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(join(root, sourcePath), "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", charset: "utf8" }).code : source;
}

function assertCloneSafe(value, label) {
  if (typeof structuredClone === "function") {
    assert.doesNotThrow(() => structuredClone(value), `${label} should be structured-clone safe`);
  }
  assert.doesNotThrow(() => JSON.stringify(value), `${label} should be JSON safe for extension messaging`);
}
