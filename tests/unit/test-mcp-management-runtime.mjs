import assert from "node:assert/strict";
import test from "node:test";
import { createMcpManagementRuntime } from "../../src/background/mcp/management-runtime.js";
import { normalizeModernSkill } from "../../src/shared/skills/skill-utils.js";
import { skillToSkillMarkdown } from "../../src/shared/skills/skill-package.js";
import { openZip } from "../../src/shared/zip-bytes.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

const configFixture = () => ({
  provider: "alpha", providerLabel: "Alpha", model: "small", modelLabel: "Small", apiKey: "alpha-key-private",
  endpoint: "https://alpha.example/v1/chat/completions", customEndpoint: "https://custom.example/v1", customProtocol: "openai",
  contextWindow: 128000, trimOldToolResults: true, vision: true, requestRateLimit: false, debugMode: false,
  modelParameters: { temperature: 0.2 }, securityGuardrails: { privateNetwork: true }, activePresetId: "saved",
  providerApiKeys: { alpha: "alpha-key-private", beta: "beta-key-private", custom: "custom-key-private" },
  presets: [{ id: "saved", name: "Saved", provider: "alpha", model: "saved-model", apiKey: "preset-key-private" }],
  providers: [
    { id: "alpha", label: "Alpha", requiresApiKey: true },
    { id: "beta", label: "Beta", requiresApiKey: true, modelOptions: [{ key: "effort", label: "Effort", options: [{ value: "low" }, { value: "high" }] }] },
    { id: "custom", label: "Custom", requiresApiKey: false },
  ],
  customProtocols: [{ id: "openai", label: "Chat Completions" }, { id: "messages", label: "Messages" }],
});

function harness(options = {}) {
  let current = { ...configFixture(), ...options.initial };
  let language = "en";
  const saves = [], presets = [], downloads = [], languages = [];
  const runtime = createMcpManagementRuntime({
    config: {
      get: async () => { if (options.get) await options.get(); return current; },
      save: async (patch, signal) => {
        saves.push(structuredClone(patch));
        if (options.save) await options.save(patch, signal);
        current = { ...current, ...patch };
        return current;
      },
      applyPreset: async (id, signal) => {
        presets.push(id);
        if (options.applyPreset) await options.applyPreset(id, signal);
        current = { ...current, ...current.presets.find(item => item.id === id), activePresetId: id };
        return current;
      },
    },
    skills: { load: async name => { if (options.loadSkill) await options.loadSkill(); return options.skill?.name === name ? options.skill : null; } },
    download: async input => {
      downloads.push(input);
      if (options.download) return options.download(input);
      return { downloadId: 7, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes.length, state: "in_progress" };
    },
    language: {
      get: async () => language,
      list: () => [{ language: "en", name: "English" }, { language: "zh-CN", name: "简体中文" }],
      save: async value => {
        if (options.saveLanguage) await options.saveLanguage(value);
        language = value;
        languages.push(value);
      },
    },
  });
  return { runtime, saves, presets, downloads, languages, config: () => current };
}

test("settings discovery and keyed reads expose configured flags while redacting credentials and endpoint queries", async () => {
  const { runtime } = harness({ initial: {
    modelLabel: "Uses alpha-key-private",
    endpoint: "https://user:password@alpha.example/v1?key=opaque-value&region=eu#private-fragment",
    customEndpoint: "https://custom.example/v1?token=custom-token",
    modelParameters: { nested: { password: "nested-secret" }, visible: "preset-key-private", temperature: 0.2 },
    providerAuth: { alpha: { refreshToken: "refresh-secret" } },
  } });
  const result = await runtime.getSettings();
  const encoded = JSON.stringify(result);
  for (const secret of ["alpha-key-private", "beta-key-private", "custom-key-private", "preset-key-private", "nested-secret", "refresh-secret", "opaque-value", "custom-token", "private-fragment", "user:password"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(result.config.hasApiKey, true);
  assert.deepEqual(result.config.providerKeysConfigured, { alpha: true, beta: true, custom: true });
  assert.deepEqual(result.config.modelParameters.nested.password, { configured: true });
  assert.equal(Object.hasOwn(result.config, "apiKey"), false);
  assert.equal(Object.hasOwn(result.config, "providerAuth"), false);
  assert.equal(Object.hasOwn(result.config, "securityGuardrails"), false);
  assert.equal(result.config.language, "en");
  assert.deepEqual(result.fields.find(item => item.key === "language").values, ["system", "en", "zh-CN"]);
  assert.deepEqual((await runtime.getSettings({ key: "apiKey" })).value, { configured: true });
  assert.equal((await runtime.getSettings({ key: "model" })).value, "small");
  await assert.rejects(runtime.getSettings({ key: "providerApiKeys" }), { code: "UNKNOWN_SETTING" });
});

test("model changes pass only the patch to its owner and preserve unrelated settings and keys", async () => {
  const { runtime, saves, config } = harness();
  const patch = Object.freeze({ model: "large", modelParameters: Object.freeze({ temperature: 0.7 }) });
  const result = await runtime.updateSettings({ config: patch });
  assert.deepEqual(saves, [{ model: "large", modelParameters: { temperature: 0.7 } }]);
  assert.equal(config().apiKey, "alpha-key-private");
  assert.equal(config().providerApiKeys.beta, "beta-key-private");
  assert.deepEqual(config().securityGuardrails, { privateNetwork: true });
  assert.deepEqual(result.updated, ["model", "modelParameters"]);
  assert.deepEqual(result.config.modelParameters, { temperature: 0.7 });
  assert.equal(JSON.stringify(result).includes("-key-private"), false);
});

test("settings owners receive the connection signal through model validation and preset lookup", async () => {
  for (const preset of [false, true]) {
    const controller = new AbortController(), entered = deferred(), resume = deferred();
    const reason = new Error("connection ended during owner validation");
    const check = async (_value, signal) => {
      assert.equal(signal, controller.signal);
      entered.resolve(); await resume.promise; signal.throwIfAborted();
    };
    const { runtime, config } = harness(preset ? { applyPreset: check } : { save: check });
    const pending = runtime.updateSettings({ config: preset ? { activePresetId: "saved" } : { model: "large" } }, controller.signal);
    const rejected = assert.rejects(pending, error => error.message.includes(reason.message));
    await entered.promise; controller.abort(reason); resume.resolve(); await rejected;
    assert.equal(config().model, "small");
  }
});

test("provider discovery reports sign-in state without account identity or credentials", async () => {
  const { runtime } = harness({ initial: {
    providers: [
      { id: "managed", label: "Managed", requiresApiKey: false, auth: { label: "Login" } },
      { id: "expired", label: "Expired", requiresApiKey: false, auth: { label: "Login" } },
      { id: "signed-out", label: "Signed out", requiresApiKey: false, auth: { label: "Login" } },
      { id: "alpha", label: "Alpha", requiresApiKey: true },
      { id: "local", label: "Local", requiresApiKey: false },
    ],
    providerAuth: {
      managed: { loggedIn: true, expired: false, accountId: "private-account", accessToken: "private-token" },
      expired: { loggedIn: false, expired: true, refreshError: "private-error", refreshToken: "private-refresh-token" },
    },
  } });
  const result = await runtime.getSettings();
  assert.deepEqual(result.providers.map(item => item.auth), [
    { mode: "sign_in", loggedIn: true, expired: false }, { mode: "sign_in", loggedIn: false, expired: true },
    { mode: "sign_in", loggedIn: false, expired: false }, { mode: "api_key" }, { mode: "none" },
  ]);
  for (const secret of ["private-account", "private-token", "private-error", "private-refresh-token"]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("provider switches select that provider's remembered credentials and declared option schema", async () => {
  const { runtime, saves } = harness();
  await runtime.updateSettings({ config: { provider: "beta", model: "beta-large", effort: "high" } });
  assert.equal(saves[0].apiKey, "beta-key-private");
  assert.equal((await runtime.getSettings()).fields.find(item => item.key === "effort").type, "string");
  await assert.rejects(runtime.updateSettings({ config: { effort: "invalid" } }), { code: "INVALID_SETTINGS" });
  assert.equal(saves.length, 1);
  const empty = harness({ initial: { providerApiKeys: { alpha: "alpha-key-private" } } });
  await empty.runtime.updateSettings({ config: { provider: "beta", model: "beta-small" } });
  assert.equal(empty.saves[0].apiKey, "");
});

test("custom endpoint changes require explicit credentials before forwarding a remembered key", async () => {
  for (const provider of ["alpha", "custom"]) {
    const { runtime, saves } = harness({ initial: { provider, apiKey: provider === "custom" ? "custom-key-private" : "alpha-key-private" } });
    const patch = { provider: "custom", customEndpoint: "https://new.example/v1", model: "local-model" };
    await assert.rejects(runtime.updateSettings({ config: patch }), { code: "API_KEY_REQUIRED" });
    assert.deepEqual(saves, []);
    const result = await runtime.updateSettings({ config: { ...patch, apiKey: "" } });
    assert.equal(saves[0].apiKey, "");
    assert.equal(result.config.hasApiKey, false);
  }
  const unchanged = harness({ initial: { provider: "custom", apiKey: "custom-key-private" } });
  await unchanged.runtime.updateSettings({ config: { customEndpoint: "https://custom.example/v1/chat/completions" } });
  assert.equal(Object.hasOwn(unchanged.saves[0], "apiKey"), false);
});

test("settings reject unsupported, protected, malformed and invalid provider fields before persistence", async () => {
  const { runtime, saves, languages } = harness();
  for (const config of [
    {}, { securityGuardrails: {} }, { dataConsent: true }, { providerApiKeys: {} }, { presets: [] },
    { provider: "unknown" }, { provider: 42 }, { customProtocol: "unknown" }, { customEndpoint: "file:///tmp/test" },
    { customEndpoint: "https://user:password@example.com/v1" }, { vision: "true" },
    { contextWindow: 0 }, { contextWindow: Infinity }, { contextWindow: "NaN" },
    { modelParameters: [] }, { modelParameters: { messages: [] } }, { language: "unknown" },
    { activePresetId: "missing" }, { activePresetId: "saved", model: "other" },
  ]) {
    await assert.rejects(runtime.updateSettings({ config }), error => ["INVALID_SETTINGS", "UNKNOWN_SETTING", "SETTINGS_UPDATE_FAILED"].includes(error.code), JSON.stringify(config));
  }
  assert.deepEqual(saves, []);
  assert.deepEqual(languages, []);
});

test("language-only updates work without a configured model and preset selection uses its owning operation", async () => {
  const { runtime, saves, languages, presets, config } = harness({ initial: { model: "", apiKey: "" } });
  const language = await runtime.updateSettings({ config: { language: "zh-CN" } });
  assert.equal(language.config.language, "zh-CN");
  assert.deepEqual(saves, []);
  assert.deepEqual(languages, ["zh-CN"]);
  const applied = await runtime.updateSettings({ config: { activePresetId: "saved" } });
  assert.deepEqual(presets, ["saved"]);
  assert.equal(config().apiKey, "preset-key-private");
  assert.equal(applied.config.model, "saved-model");
  assert.equal(JSON.stringify(applied).includes("preset-key-private"), false);
});

test("settings writes serialize, copy caller patches and recover after an owner failure", async () => {
  let entered, unblock;
  const entry = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const { runtime, saves } = harness({ save: async patch => {
    if (patch.model === "first") { entered(); await gate; throw new Error("Rejected alpha-key-private and submitted-new-key"); }
  } });
  const first = runtime.updateSettings({ config: { model: "first", apiKey: "submitted-new-key" } });
  const rejected = assert.rejects(first, error => error.code === "SETTINGS_UPDATE_FAILED" && error.message === "Rejected [configured] and [configured]");
  await entry;
  const patch = { model: "second" };
  const second = runtime.updateSettings({ config: patch });
  patch.model = "mutated";
  await Promise.resolve();
  assert.equal(saves.length, 1);
  unblock();
  await rejected;
  const result = await second;
  assert.equal(result.config.model, "second");
  assert.equal(saves[1].model, "second");
});

test("a disconnected queued settings update never saves and does not block a later update", async () => {
  const entered = deferred(), saving = deferred(), controller = new AbortController();
  const { runtime, saves } = harness({ save: async patch => {
    if (patch.model === "first") { entered.resolve(); await saving.promise; }
  } });
  const first = runtime.updateSettings({ config: { model: "first" } });
  await entered.promise;
  const second = runtime.updateSettings({ config: { model: "obsolete" } }, controller.signal);
  const reason = new Error("disconnected"); controller.abort(reason);
  const rejected = assert.rejects(second, error => error === reason);
  saving.resolve(); await first; await rejected;
  assert.deepEqual(saves, [{ model: "first" }]);
  await runtime.updateSettings({ config: { model: "fresh" } }, new AbortController().signal);
  assert.deepEqual(saves, [{ model: "first" }, { model: "fresh" }]);
});

test("disconnect during settings read prevents model, preset and language mutations", async () => {
  for (const patch of [{ model: "obsolete" }, { activePresetId: "saved" }, { language: "zh-CN" }]) {
    const entered = deferred(), reading = deferred(), controller = new AbortController();
    const { runtime, saves, presets, languages } = harness({ get: async () => { entered.resolve(); await reading.promise; } });
    const pending = runtime.updateSettings({ config: patch }, controller.signal);
    await entered.promise;
    const reason = new Error("disconnected"); controller.abort(reason); reading.resolve();
    await assert.rejects(pending, error => error === reason);
    assert.deepEqual({ saves, presets, languages }, { saves: [], presets: [], languages: [] });
  }
});

test("disconnect after an admitted model save prevents the later language write and reports partial success", async () => {
  const controller = new AbortController();
  const { runtime, saves, languages } = harness({ save: async () => { controller.abort(new Error("disconnected")); } });
  await assert.rejects(runtime.updateSettings({ config: { model: "saved", language: "zh-CN" } }, controller.signal), { code: "SETTINGS_PARTIALLY_UPDATED" });
  assert.deepEqual(saves, [{ model: "saved" }]); assert.deepEqual(languages, []);
});

test("a second owner failure reports the applied model mutation explicitly", async () => {
  const { runtime, saves, config } = harness({ saveLanguage: async () => { throw new Error("Language failed alpha-key-private"); } });
  await assert.rejects(runtime.updateSettings({ config: { model: "large", language: "zh-CN" } }), error => {
    assert.equal(error.code, "SETTINGS_PARTIALLY_UPDATED");
    assert.match(error.message, /Model settings were saved/);
    assert.equal(error.message.includes("alpha-key-private"), false);
    return true;
  });
  assert.equal(saves.length, 1);
  assert.equal(config().model, "large");
});

test("Skill export preserves canonical SKILL.md and exact UTF-8/binary asset bytes", async () => {
  const script = 'return "杭州";\n// preserved whitespace  \n';
  const binary = new Uint8Array([0, 1, 127, 128, 255, 13, 10]);
  const skill = normalizeModernSkill({
    name: "mcp-export-test", description: "Export test", content: "# Workflow\n\nUse this skill.\n",
    resources: [
      { path: "scripts/run.js", content: script },
      { path: "assets/pixel.png", content: Buffer.from(binary).toString("base64"), encoding: "base64", mimeType: "image/png" },
    ],
  });
  const { runtime, downloads } = harness({ skill });
  const result = await runtime.exportSkill({ name: skill.name });
  assert.equal(result.name, skill.name);
  assert.equal(result.filename, "mcp-export-test.zip");
  assert.equal(result.downloadId, 7);
  assert.equal(result.resourceCount, 2);
  assert.equal(Object.hasOwn(result, "base64"), false);
  const zip = openZip(downloads[0].bytes, { decode: bytes => new TextDecoder().decode(bytes) });
  assert.deepEqual(zip.entries.map(entry => entry.name), ["mcp-export-test/SKILL.md", "mcp-export-test/scripts/run.js", "mcp-export-test/assets/pixel.png"]);
  assert.equal(new TextDecoder().decode(await zip.read(zip.entries[0], 10000)), skillToSkillMarkdown(skill));
  assert.equal(new TextDecoder().decode(await zip.read(zip.entries[1], 10000)), script);
  assert.deepEqual(await zip.read(zip.entries[2], 10000), binary);
});

test("Skill export errors never download missing, built-in or unsafe packages and preserve download failure codes", async () => {
  const skill = normalizeModernSkill({ name: "export-test", description: "Test", content: "Test" });
  const { runtime, downloads } = harness({ skill });
  await assert.rejects(runtime.exportSkill({}), { code: "INVALID_ARGUMENTS" });
  await assert.rejects(runtime.exportSkill({ name: "missing" }), { code: "SKILL_NOT_FOUND" });
  for (const filename of ["../test.zip", "folder/test.zip", "folder\\test.zip", "test.txt", ".zip", "test\u0000.zip"]) {
    await assert.rejects(runtime.exportSkill({ name: skill.name, filename }), { code: "INVALID_FILENAME" });
  }
  assert.deepEqual(downloads, []);
  for (const marker of [{ builtin: true }, { readOnly: true }, { source: "system" }]) {
    const builtin = harness({ skill: { ...skill, ...marker } });
    await assert.rejects(builtin.runtime.exportSkill({ name: skill.name }), { code: "SKILL_EXPORT_UNSUPPORTED" });
    assert.deepEqual(builtin.downloads, []);
  }
  const interrupted = harness({ skill, download: async () => { throw Object.assign(new Error("Interrupted"), { code: "DOWNLOAD_INTERRUPTED" }); } });
  await assert.rejects(interrupted.runtime.exportSkill({ name: skill.name, filename: "copy.zip" }), { code: "DOWNLOAD_INTERRUPTED" });
});

test("disconnect during Skill lookup prevents export and a new connection can export the same Skill", async () => {
  const entered = deferred(), loading = deferred(), controller = new AbortController();
  const skill = normalizeModernSkill({ name: "export-test", description: "Test", content: "Test" });
  const { runtime, downloads } = harness({ skill, loadSkill: async () => { entered.resolve(); await loading.promise; } });
  const pending = runtime.exportSkill({ name: skill.name }, controller.signal);
  await entered.promise;
  const reason = new Error("disconnected"); controller.abort(reason); loading.resolve();
  await assert.rejects(pending, error => error === reason); assert.deepEqual(downloads, []);
  await runtime.exportSkill({ name: skill.name }, new AbortController().signal);
  assert.equal(downloads.length, 1);
});
