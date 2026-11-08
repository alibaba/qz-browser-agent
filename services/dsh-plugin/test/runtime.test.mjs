import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { apply } from "../src/index.mjs";
import { cliCommand, runCli } from "../src/cli.mjs";
import { captureImages } from "../src/images.mjs";

const fixture = String.raw`
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const dir = process.env.QZ_STATE_DIR;
const argv = process.argv.slice(2);
if (argv[0] === '--client') argv.splice(0, 2);
const emit = (data, code = 0) => {
  if (argv[0] === 'script' && existsSync(dir + '/context')) data.context = JSON.parse(readFileSync(dir + '/context','utf8'));
  process.stdout.write(JSON.stringify(data)); process.exitCode = code;
};
appendFileSync(dir + '/calls', JSON.stringify(argv) + '\n');
if (argv[0] === 'session') {
  if (argv[1] === 'create') {
    const file = dir + '/counter', count = existsSync(file) ? Number(readFileSync(file)) + 1 : 1;
    writeFileSync(file, String(count));
    emit({ok:true,result:{sessionId:'sid-' + count,title:argv[argv.indexOf('--title') + 1],status:'idle'}});
  } else {
    const status = existsSync(dir + '/status') ? readFileSync(dir + '/status','utf8') : 'idle';
    if (status === 'offline') emit({code:'BRIDGE_NOT_CONNECTED',message:'Reconnect the browser.'}, 1);
    else if (status === 'missing') emit({code:'DRIVE_SESSION_NOT_FOUND',message:'Session missing.'}, 1);
    else emit({ok:true,result:{sessionId:argv[2],title:'Original title',status}});
  }
} else {
  let code = ''; for await (const chunk of process.stdin) code += chunk;
  if (code === 'hold') {
    const timer = setInterval(() => {}, 1000);
    process.on('SIGINT', () => { clearInterval(timer); emit({ok:false,result:{code:'ABORTED',message:'Stopped.'},trace:['filled name']},130); });
    writeFileSync(dir + '/ready','yes');
  } else if (code === 'image') {
    const path = mkdtempSync(tmpdir() + '/qz-script-') + '/0.png';
    writeFileSync(path,'png');
    process.stderr.write('Image: ' + path + '\n');
    emit({ok:true,result:{screenshot:true},trace:['form submitted']});
  } else if (code === 'malformed') process.stdout.write('not JSON');
  else if (code === 'bad-shape') emit({ok:true,result:42});
  else if (code === 'failure') emit({ok:false,result:{code:'ELEMENT_NOT_FOUND',message:'No Save button.',details:{target:'css:#save'}},trace:['filled name']},1);
  else emit({ok:true,result:{sessionId:argv[argv.indexOf('--session')+1],code,args:argv.includes('--args') ? JSON.parse(argv[argv.indexOf('--args')+1]) : null},trace:['ready']});
}
`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-qz-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cliPath = join(dir, "qz.mjs");
  await writeFile(cliPath, fixture);
  const records = new Map(), disposers = [];
  t.after(async () => { for (const dispose of disposers) await dispose(); });
  const install = async (overrides = {}, profile = "/profile") => {
    let tool;
    await apply({
      storageDomain: { async open() { return { table() { return {
        get: key => records.get(key), put: async (key, value) => records.set(key, value), delete: async key => records.delete(key),
      }; }, async close() {} }; } },
      get: name => name === "profileContext" ? { dir: profile } : undefined,
      on: (_event, fn) => disposers.push(fn), systemPrompt: { section() {} },
      tools: { register(value) { tool = value; } },
    }, { cliPath, stateDir: dir, ...overrides });
    return tool;
  };
  return { dir, cliPath, install, records, calls: async () => (await readFile(join(dir,"calls"),"utf8")).trim().split("\n").map(JSON.parse) };
}

function execution(id = "conversation", signal = new AbortController().signal) {
  return { agent: { id, session: { header: { cwd: tmpdir() } } }, signal, token: {} };
}
const args = code => ({ title: "Inspect browser", code });
async function failure(tool, input, exec = execution(), normalizedCode) {
  let thrown;
  await assert.rejects(tool.execute(input, exec), error => { thrown = error; return true; });
  const content = tool.finalizeContent(exec, { isError: true, error: { info: { code: normalizedCode || thrown.code } } });
  assert.ok(content, "CLI failures retain their receipt through DSH normalization");
  return JSON.parse(content[0].text);
}
async function untilFile(path) {
  for (let i = 0; i < 100; i++) {
    if (await access(path).then(() => true, () => false)) return;
    await delay(10);
  }
  assert.fail(`CLI did not become ready: ${path}`);
}

test("resume retains the session across Agent/plugin reload and CLI upgrades; forks and profiles isolate", async t => {
  const f = await setup(t), first = await f.install();
  const one = await first.execute({ ...args("first"), args: { city: "杭州", literal: "$(echo nope)" } }, execution());
  assert.equal(one.session.sessionId, "sid-1");
  assert.equal(one.receipt.result.args.literal, "$(echo nope)");
  const upgraded = join(f.dir, "qz-new.mjs"); await writeFile(upgraded, fixture);
  const second = await f.install({ cliPath: upgraded });
  assert.equal((await second.execute(args("second"), execution())).session.sessionId, "sid-1");
  assert.equal((await second.execute(args("fork"), execution("fork"))).session.sessionId, "sid-2");
  const profile = await f.install({}, "/other-profile");
  assert.equal((await profile.execute(args("profile"), execution())).session.sessionId, "sid-3");
  assert.equal((await f.calls()).filter(call => call[0] === "session" && call[1] === "create").length, 3);
});

test("aborted or missing sessions reset without replay; transport failures keep the binding", async t => {
  const f = await setup(t), tool = await f.install();
  await tool.execute(args("first"), execution());
  await writeFile(join(f.dir,"status"), "offline");
  assert.equal((await failure(tool, args("offline"))).result.code, "BRIDGE_NOT_CONNECTED");
  assert.equal(f.records.size, 1);
  await writeFile(join(f.dir,"status"), "error");
  assert.equal((await tool.execute(args("resume-error"), execution())).session.sessionId, "sid-1");
  await writeFile(join(f.dir,"status"), "aborted");
  const ended = await failure(tool, args("do-not-run"));
  assert.equal(ended.result.code, "DRIVE_SESSION_ENDED");
  assert.equal(ended.result.details.executed, false);
  assert.equal(f.records.size, 0);
  await writeFile(join(f.dir,"status"), "idle");
  assert.equal((await tool.execute(args("new"), execution())).session.sessionId, "sid-2");
  await writeFile(join(f.dir,"status"), "missing");
  assert.equal((await failure(tool, args("missing"))).result.code, "DRIVE_SESSION_NOT_FOUND");
  assert.equal((await f.calls()).filter(call => call[0] === "script").length, 3);
});

test("SIGINT preserves error trace and serializes same-conversation calls before continuation", async t => {
  const f = await setup(t), tool = await f.install(), controller = new AbortController();
  const stopped = failure(tool, args("hold"), execution("conversation",controller.signal), "ABORTED");
  await untilFile(join(f.dir,"ready"));
  const next = tool.execute(args("after-stop"), execution());
  const queuedController = new AbortController();
  const cancelledQueue = failure(tool, args("never-dispatched"), execution("conversation",queuedController.signal), "ABORTED");
  queuedController.abort(new DOMException("Stopped before dispatch", "AbortError"));
  await delay(30);
  assert.equal((await f.calls()).filter(call => call[0] === "script").length, 1);
  controller.abort(new DOMException("Stopped", "AbortError"));
  assert.deepEqual((await stopped).trace, ["filled name"]);
  assert.equal((await next).session.sessionId, "sid-1");
  assert.equal((await cancelledQueue).result.code,"ABORTED");
  assert.equal((await f.calls()).filter(call => call[0] === "script").length, 2);
});

test("script failures preserve public details and traces; invalid output and missing CLI fail explicitly", async t => {
  const f = await setup(t), tool = await f.install();
  const failed = await failure(tool,args("failure"));
  assert.deepEqual(failed, {ok:false,result:{code:"ELEMENT_NOT_FOUND",message:"No Save button.",details:{target:"css:#save"}},trace:["filled name"]});
  for (const code of ["malformed","bad-shape"]) assert.equal((await failure(tool,args(code))).result.code,"QZ_INVALID_RECEIPT");
  const imageFailure = await failure(tool,args("image"));
  assert.equal(imageFailure.result.code,"QZ_IMAGES_UNAVAILABLE");
  assert.deepEqual(imageFailure.trace,["form submitted"]);
  await assert.rejects(runCli({cliPath:join(f.dir,"missing-command")},["status"],"",new AbortController().signal), {code:"QZ_CLI_NOT_FOUND"});
});

test("host qz_skills reaches the model on success, script failure and attachment failure", async t => {
  const f = await setup(t), tool = await f.install();
  const context = { qz_skills: [
    { name: "my-report", displayName: "My report", description: "Summarize a report.", scope: "global" },
    { name: "my-shop", displayName: "My shop", description: "Collect shop items.", scope: "site", domains: ["example.com"], urlPatterns: ["https://example.com/items/*"] },
  ] };
  await writeFile(join(f.dir, "context"), JSON.stringify(context));
  const input = { ...args("success"), args: { context: { skills: ["authored business data"] } } };
  const value = await tool.execute(input, execution());
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
  const content = tool.output.render(input, value);
  assert.equal(content.length, 1);
  const rendered = JSON.parse(content[0].text);
  assert.deepEqual(rendered.context, context);
  assert.deepEqual(rendered.result.args.context, { skills: ["authored business data"] });
  assert.deepEqual(rendered.trace, ["ready"]);
  for (const code of ["failure", "image"]) {
    const failed = await failure(tool, args(code));
    assert.deepEqual(failed.context, context);
    assert.deepEqual(failed.trace, [code === "failure" ? "filled name" : "form submitted"]);
    assert.equal(failed.result.code, code === "failure" ? "ELEMENT_NOT_FOUND" : "QZ_IMAGES_UNAVAILABLE");
  }
});

test("Windows npm shims resolve to Node without shell; early IPC cancellation waits for the CLI handler", async t => {
  const root = "C:\\Users\\test\\npm", entry = root + "\\node_modules\\qz-browser-agent\\src\\bin.mjs";
  const command = await cliCommand("qz", {platform:"win32",cwd:root,env:{Path:root},
    exists: async path => path === root + "\\qz.cmd" || path === entry,
    read: async () => JSON.stringify({name:"qz-browser-agent",bin:{qz:"src/bin.mjs"}}),
  });
  assert.equal(command.command, process.execPath); assert.deepEqual(command.prefix,[entry]);
  await assert.rejects(cliCommand(root + "\\missing-command", {platform:"win32",cwd:root,env:{Path:root},exists:async () => false}),
    {code:"QZ_CLI_NOT_FOUND"});
  const child = spawn(process.execPath,["--import",new URL("../src/cli-cancel.mjs",import.meta.url).href,"--input-type=module","-"],{stdio:["pipe","pipe","pipe","ipc"]});
  t.after(() => { if(child.exitCode === null) child.kill("SIGKILL"); });
  let stdout=""; child.stdout.on("data",data=>stdout+=data);
  child.stdin.end("setTimeout(() => process.on('SIGINT', () => { console.log('cooperative stop'); process.exitCode=130; }), 60);");
  child.send({type:"qz.cancel"});
  const [code] = await once(child,"close");
  assert.equal(code,130); assert.equal(stdout.trim(),"cooperative stop");
});

test("screenshots become durable attachments and owned temp files are cleaned even when storage fails", async t => {
  const directory = await mkdtemp(join(tmpdir(),"qz-script-"));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const path = join(directory,"0.png"), signal = new AbortController().signal;
  await writeFile(path,Buffer.from([1,2,3]));
  const refs = await captureImages({imageLimits:{maxImageBytes:100,maxMessageImageBytes:100},async saveImages(images){
    assert.deepEqual([...images[0].data],[1,2,3]); return [{kind:"image",id:"saved"}];
  }},`Image: ${path}\n`,signal);
  assert.equal(refs[0].id,"saved");
  await assert.rejects(access(path));
  const other = await mkdtemp(join(tmpdir(),"qz-script-")), failedPath = join(other,"0.png");
  await writeFile(failedPath,"test");
  await assert.rejects(captureImages({imageLimits:{maxImageBytes:100,maxMessageImageBytes:100},async saveImages(){throw Error("store failed");}},`Image: ${failedPath}\n`,signal),/store failed/);
  await assert.rejects(access(failedPath));
});
