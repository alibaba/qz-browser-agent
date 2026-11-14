import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWaitTools } from "../../src/capabilities/wait/tools.js";
import { registerTabsNavigationTools } from "../../src/capabilities/tabs/tools.js";
import { Agent } from "../../src/background/agent/agent.js";
import { createTestAgentOptions } from "../support/agent-services.mjs";
import { initializeLanguage } from "../../src/shared/i18n/index.js";

globalThis.chrome = { ...globalThis.chrome, i18n: { getUILanguage: () => "zh-CN" } };
await initializeLanguage();

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tools = [
  "src/background/tools/runtime.ts",
  "src/capabilities/tabs/tools.ts",
  "src/capabilities/media/tools.ts",
].map(path => readFileSync(join(root, path), "utf8")).join("\n");

await assertImageToolInjectionIsNeutral();
const { resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
assertReadImageKeepsTransparencyByDefault();
await assertToolNotesAreCompact();
await assertWaitToolNotesAreCompact();

async function assertImageToolInjectionIsNeutral() {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: path => path } };
  let createToolRuntime;
  try {
    ({ createToolRuntime } = await import("../../src/background/tools/runtime.js"));
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
  const registered = createToolRuntime();
  const requests = [], executed = [];
  const names = ["read_image", "read_image_asset", "screenshot"];
  const imageUrl = "data:image/png;base64,AA==";
  const agent = new Agent("image-hints", createTestAgentOptions({
    tools: {
      getSchemas: () => [], getIdentity: registered.getIdentity, getModelPolicy: registered.getModelPolicy,
      async execute(name) { executed.push(name); return { ok: true, _image: imageUrl }; },
    },
    llm: {
      async *chatStream(messages) {
        requests.push(structuredClone(messages));
        const name = names[requests.length - 1];
        yield { type: "done", message: name
          ? { role: "assistant", content: null, tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }] }
          : { role: "assistant", content: "done" } };
      },
      async chat() { throw new Error("Unexpected fallback"); },
    },
  }));
  await agent.prompt("Inspect the images", {});
  assert.deepEqual(executed, names);
  const images = requests.at(-1).filter(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
  assert.equal(images.length, 3);
  assert.deepEqual(images.map(message => message.content[0].text), [
    "以上工具读取到的图片，请分析其视觉内容：",
    "以上工具读取到的图片，请分析其视觉内容：",
    "以上工具返回的图片，请结合工具结果继续判断：",
  ], "real registered policies choose image-analysis hints; ordinary image tools use the neutral fallback");
  for (const message of images) {
    assert.equal(message.content[1].image_url.url, imageUrl);
    assert.doesNotMatch(message.content[0].text, /登录弹窗|验证码|必须立即调用 wait_for_user/);
  }
  assert.equal(agent.messages.at(-1).content, "done");
}

function assertReadImageKeepsTransparencyByDefault() {
  assert.match(tools, /readImageUrlAsResult\(url,[\s\S]*format = "png"/, "read_image url path should default to png");
  assert.match(tools, /registerTool\(\{\s*name:\s*"read_image"[\s\S]*format = "png"/, "read_image DOM path should default to png");
  assert.match(resolveToolDefinition("read_image").parameters.properties.format.description, /png 可保留透明通道/, "read_image schema should explain why png is the default");
}

async function assertToolNotesAreCompact() {
  const definitions = new Map();
  class ToolExecutionError extends Error {}
  registerTabsNavigationTools({
    registerTool({ name, description, parameters, execute }) {
      definitions.set(name, { description, parameters, execute });
    },
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({ sessions: { getTabAliases: () => ({}), resolveTargetTab: async () => ({ ok: true, ownedByCurrentTask: true }) } }),
    makeSessionTabTargetError: (code, details) => Object.assign(new Error(code), { code, details }),
    assertTabAllowed: async () => undefined,
    assertUrlAllowed: () => undefined,
    enablePreNavigationNetworkWatch: async () => ({}),
  });

  const previousChrome = globalThis.chrome;
  let visibleMutations = 0;
  globalThis.chrome = {
    tabs: {
      async query() {
        return [{ id: 42, active: false, title: "Background tab", url: "https://example.test/", windowId: 7 }];
      },
      async update() {
        visibleMutations += 1;
        throw new Error("discovery must not activate or focus the browser tab");
      },
    },
  };
  try {
    const result = await definitions.get("list_tabs").execute({}, undefined, { sessionId: 'hints', runId: 'run' });
    assert.deepEqual(result, { tabs: [{ tabRef: 42, active: false, title: "Background tab", url: "https://example.test/", ownership: "owned" }], count: 1, foreign: 0 });
    assert.equal(definitions.has("use_tab"), false);
    assert.equal(definitions.has("get_working_tab"), false);
    assert.equal(visibleMutations, 0);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }

  assert.doesNotMatch(tools, /截图已获取。请仔细查看图片内容。如果看到登录弹窗\/验证码\/授权请求，必须立即调用 wait_for_user/, "screenshot note should not repeat hard wait_for_user rules");
  assert.match(tools, /note:\s*collection[\s\S]*t\("screenshotCapturedAndSavedToTheImageCollection"\)[\s\S]*t\("elementScreenshotCaptured"\)[\s\S]*t\("screenshotCaptured"\)/, "screenshot notes should stay compact and mention optional asset saving");
}

async function assertWaitToolNotesAreCompact() {
  const definitions = new Map();
  let screenshotFails = false;
  let captures = 0;
  registerWaitTools({
    registerTool: definition => definitions.set(definition.name, definition),
    getToolRuntimeDependencies: () => ({ sessions: {
      beginUserWait: async () => ({ reason: "continued" }),
      resolveUserWait() {}, rejectUserWait() {}, isWaitingForUser() { return false; },
    } }),
    captureTabScreenshot: async () => {
      captures++;
      if (screenshotFails) throw new Error("Screenshot unavailable");
      return { dataUrl: "data:image/png;base64,AA==" };
    },
    sendToContent: async () => ({}),
  });
  const context = { sessionId: "wait-hints", runId: "wait-run", workingTabId: 42 };
  const resumed = await definitions.get("wait_for_user").execute({ tabId: 42, message: "Continue when ready" }, undefined, context);
  assert.equal(resumed.continued, true);
  assert.ok(resumed._image);
  assert.match(resumed.note, /用户已继续，这是 tabRef 指定页面的状态截图，请确认并继续任务。/, "wait_for_user screenshot note should say user continued");
  screenshotFails = true;
  const fallback = await definitions.get("wait_for_user").execute({ tabId: 42, message: "Continue when ready" }, undefined, context);
  assert.equal(fallback.continued, true);
  assert.equal(fallback._image, undefined);
  assert.match(fallback.note, /用户已继续，请确认用户操作的结果后继续任务。/, "wait_for_user fallback note should say user continued");
  const capturesBeforeUnscoped = captures;
  screenshotFails = false;
  const unscoped = await definitions.get("wait_for_user").execute({ message: "Continue when ready" }, undefined, context);
  assert.equal(unscoped.continued, true);
  assert.equal(unscoped._image, undefined);
  assert.equal(captures, capturesBeforeUnscoped, "an optional screenshot never infers the recent or visible page");


  const previousChrome = globalThis.chrome;
  screenshotFails = false;
  try {
    const listeners = new Set();
    let status = "complete";
    let documentId = "before";
    const navigationEvents = Object.fromEntries(["onBeforeNavigate", "onCommitted", "onHistoryStateUpdated", "onReferenceFragmentUpdated", "onErrorOccurred"].map(name => {
      const registered = new Set();
      return [name, { addListener: listener => registered.add(listener), removeListener: listener => registered.delete(listener),
        emit: event => { for (const listener of registered) listener(event); } }];
    }));
    globalThis.chrome = { tabs: {
      get: async () => ({ id: 42, status, url: "https://example.test", title: "Page" }),
      onUpdated: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    }, webNavigation: { ...navigationEvents,
      getFrame: async () => ({ url: "https://example.test", documentId, errorOccurred: false }),
    } };
    const pageContext = { ...context, requestedTabRef: "page" };
    const load = definitions.get("wait_for_load"), navigation = definitions.get("wait_for_navigation");
    assert.deepEqual(await load.execute({ tabId: 42, timeout: 0.1 }, undefined, pageContext), {
      status: "complete", url: "https://example.test", title: "Page",
    }, "a current load-state wait returns concise page state");
    assert.equal(Object.hasOwn(navigation.parameters.properties, "screenshot"), false);
    await assert.rejects(navigation.execute({ tabId: 42, timeout: 0.001 }, undefined, pageContext), error =>
      error.code === "TOOL_TIMEOUT" && error.details.tabRef === "page", "a previously complete page does not satisfy a future-navigation wait");
    status = "loading";
    await assert.rejects(load.execute({ tabId: 42, timeout: 0.001 }, undefined, pageContext), error =>
      error.code === "TOOL_TIMEOUT" && error.details.tabRef === "page", "load timeout is a recoverable ToolError, not a successful screenshot receipt");
    const pending = navigation.execute({ tabId: 42, timeout: 0.5 }, undefined, pageContext);
    setTimeout(() => {
      for (const listener of listeners) listener(42, { status: "loading" }, { id: 42, status: "loading" });
      status = "complete";
      documentId = "after";
      navigationEvents.onCommitted.emit({ tabId: 42, frameId: 0, url: "https://example.test", documentId });
      for (const listener of listeners) listener(42, { status: "complete" }, {
        id: 42, status: "complete", url: "https://example.test", title: "Page",
      });
    }, 0);
    assert.deepEqual(await pending, { status: "navigated", url: "https://example.test", title: "Page" });
    assert.equal(listeners.size, 0, "settled navigation observers remove their listeners");
    assert.equal(captures, capturesBeforeUnscoped, "state and navigation waits never inject an unsolicited screenshot");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
}
