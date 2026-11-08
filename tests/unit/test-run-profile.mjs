import assert from "node:assert/strict";
import test from "node:test";
import { providers } from "@opencode-ai/models/snapshot";

import {
  buildRunProfile,
  buildRunProfilePromptSection,
  resolveOutputReserveTokens,
} from "../../src/background/agent/run-profile.js";

test("the first run loads the packaged directory before resolving its output limit", async t => {
  const model = Object.values(providers.openai.models).find(model => model.limit.output > 1024 && model.limit.output < 32768);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: path => `chrome-extension://fixture/${path}` } };
  t.after(() => { globalThis.chrome = previousChrome; });
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "chrome-extension://fixture/vendor/models-dev/providers.json");
    return Response.json(providers);
  });
  const config = { provider: "openai", model: model.id };
  const profiles = await Promise.all([buildRunProfile({ config }), buildRunProfile({ config })]);
  assert.equal(fetch.mock.callCount(), 1);
  for (const profile of profiles) assert.equal(profile.model.maxOutputTokens, model.limit.output);
});

test("run profile emits the session kinds referenced by the kernel", () => {
  const rootSection = buildRunProfilePromptSection({
    session: { kind: "user", canManageSessions: true },
    model: {},
    features: {},
  });
  const restrictedSection = buildRunProfilePromptSection({
    session: { kind: "restricted", canManageSessions: false },
    model: {},
    features: {},
  });

  assert.match(rootSection, /Session 类型: user-created root session/);
  assert.match(restrictedSection, /Session 类型: restricted session/);
});

test("run profile never fetches external model metadata", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("external model metadata is unavailable");
  };

  try {
    const profile = await buildRunProfile({
      sessionId: "session_deepseek",
      config: {
        provider: "deepseek",
        model: "deepseek-chat",
        endpoint: "https://api.deepseek.com/chat/completions",
        contextWindow: 128000,
        vision: false,
        toolCalling: true,
        trimOldToolResults: true,
      },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(profile.model.contextWindow, 128000);
    assert.equal(profile.model.vision, false);
    assert.equal(profile.model.maxOutputTokens, 32768);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run profile preserves bundled provider output limits without network access", async () => {
  const profile = await buildRunProfile({
    sessionId: "session_glm",
    config: {
      provider: "zhipuai",
      model: "GLM-4V-Flash",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      contextWindow: 16384,
      vision: true,
      toolCalling: true,
      trimOldToolResults: true,
    },
  });

  assert.equal(profile.model.maxOutputTokens, 1024);
  assert.equal(profile.model.contextWindow, 16384);
  assert.equal(profile.model.vision, true);
});

test("run profile exposes the current OS in the prompt", async () => {
  const config = {
    provider: "deepseek",
    model: "deepseek-chat",
    endpoint: "https://api.deepseek.com/chat/completions",
    contextWindow: 128000,
    vision: true,
    toolCalling: true,
    trimOldToolResults: true,
  };
  const macProfile = await buildRunProfile({
    sessionId: "session_mac",
    config,
    platformInfo: { os: "mac", arch: "arm64" },
  });
  assert.deepEqual(macProfile.platform, {
    os: "mac",
    label: "macOS",
  });
  assert.match(
    buildRunProfilePromptSection(macProfile),
    /当前操作系统: macOS/u,
  );

  const windowsProfile = await buildRunProfile({
    sessionId: "session_windows",
    config,
    platformInfo: { os: "win", arch: "x86-64" },
  });
  assert.deepEqual(windowsProfile.platform, {
    os: "win",
    label: "Windows",
  });
  assert.match(
    buildRunProfilePromptSection(windowsProfile),
    /当前操作系统: Windows/u,
  );
});

test("an external drive session keeps image tools when the configured model has no vision", async () => {
  const config = { provider: "test", model: "text-only", vision: false, toolCalling: true };
  const plain = await buildRunProfile({ sessionId: "task", config, platformInfo: { os: "linux" } });
  const drive = await buildRunProfile({ sessionId: "drive", externalDrive: true, config, platformInfo: { os: "linux" } });
  assert.equal(plain.model.vision, false);
  assert.equal(drive.model.vision, false);
  assert.ok(plain.tools.disabled.includes("screenshot"));
  assert.equal(plain.features.imageInput, false);
  assert.equal(drive.tools.disabled.includes("screenshot"), false);
  assert.equal(drive.tools.disabled.includes("act_on_screen"), false);
  assert.equal(drive.tools.disabled.includes("read_image"), false);
  assert.equal(drive.features.imageInput, true);
  assert.equal(drive.features.screenshots, true);
});

test("custom run profiles use the supplied configuration without loading a directory", async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = new Proxy({}, { get() { throw new Error("must not read Chrome"); } });
  try {
    const profile = await buildRunProfile({ config: { provider: "test", model: "test" }, platformInfo: { os: "linux" } });
    assert.deepEqual(profile.platform, { os: "linux", label: "Linux" });
  } finally { globalThis.chrome = originalChrome; }
});

test("output reserves follow transmitted limits without changing generation defaults", async () => {
  const cases = [
    { name: "uncapped 32K OpenAI", config: { provider: "custom", contextWindow: 32768 }, reserve: 0 },
    { name: "OpenAI max_tokens", config: { provider: "custom", modelParameters: { max_tokens: 32768 } }, reserve: 32768 },
    { name: "OpenAI completion limit", config: { provider: "custom", modelParameters: { max_completion_tokens: 65536 } }, reserve: 65536 },
    { name: "Anthropic required default", config: { provider: "custom", customProtocol: "anthropic" }, reserve: 32768 },
    { name: "Anthropic explicit limit", config: { provider: "custom", customProtocol: "anthropic", modelParameters: { max_tokens: 8192 } }, reserve: 8192 },
    { name: "Codex uncapped", config: { provider: "openaicodex" }, reserve: 0 },
    { name: "Codex explicit limit", config: { provider: "openaicodex", modelParameters: { max_output_tokens: 49152 } }, reserve: 49152 },
    { name: "oversized explicit limit stays explicit", config: { provider: "custom", contextWindow: 16384, modelParameters: { max_tokens: 65536 } }, reserve: 65536 },
  ];
  for (const { name, config, reserve } of cases) {
    const before = structuredClone(config);
    const profile = await buildRunProfile({ config: { model: "unknown-test-model", ...config } });
    assert.equal(profile.model.outputReserveTokens, reserve, name);
    assert.equal(profile.model.maxOutputTokens, 32768, name);
    assert.deepEqual(config, before, "budget planning must not rewrite user parameters");
  }
});

test("output reserves retain provider policy and parameter precedence", () => {
  const definition = { label: "Budget test", api: "openai-chat-completions", protocol: "openai", outputTokenParam: "max_tokens" };
  const reserve = modelParameters => resolveOutputReserveTokens({ modelParameters }, definition, 32768);
  assert.equal(reserve(), 32768);
  assert.equal(reserve({ max_completion_tokens: 4096 }), 4096);
  definition.requestDefaults = { max_tokens: 24000 };
  assert.equal(reserve(), 24000);
  assert.equal(reserve({ max_tokens: 48000 }), 48000);
  definition.protocol = "anthropic";
  definition.anthropicRequestDefaults = { max_tokens: 64000 };
  assert.equal(reserve(), 32768, "Anthropic adapter replaces provider defaults with its required request limit");
});
