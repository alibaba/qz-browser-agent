import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../../services/mcp-bridge/src/cli.mjs";
import { createMcpRuntime } from "../../src/background/mcp/mcp-runtime.js";
import { deserializeConversation, serializeConversation, updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";
import { normalizeRecordedUsage, summarizeSessionUsage } from "../../src/shared/session/session-usage.js";

const callA = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 30, audio_tokens: 1 },
  cost_in_usd_ticks: 2_000_000_000,
  ignored: { nested: true },
};
const callB = {
  input_tokens: 40,
  output_tokens: 10,
  cache_read_input_tokens: 15,
  cache_creation_input_tokens: 5,
  cost_usd: 0.05,
};
const callC = {
  input_tokens: 8,
  output_tokens: 2,
  cache_read_input_tokens: 4,
  cost_in_usd_ticks: 500_000_000,
};
const expected = {
  inputTokens: 123,
  outputTokens: 32,
  cachedTokens: 49,
  costUsd: 0.3,
  modelCalls: 3,
  toolCalls: 7,
  screenshots: 2,
  contextCompressions: 1,
};
const usageLine = "input 123, output 32, cached 49, cost $0.3, model calls 3, tool calls 7, screenshots 2, compressions 1";

function sessionMessages() {
  return [
    { role: "system", content: "system", _usage: { prompt_tokens: 999, completion_tokens: 999, cost_usd: 50 } },
    { role: "user", content: "question" },
    { role: "assistant", content: "openai", _usage: callA },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "extra", type: "function", function: { name: "screenshot", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "extra", content: "{\"ok\":true}" },
    {
      role: "user",
      content: "compressed",
      _kind: "compaction",
      _origin: "compaction",
      _usage: callC,
      _compact: { compactId: "compact-1", status: "done" },
    },
    { role: "assistant", content: "anthropic", _usage: callB },
  ];
}

function sessionTranscript() {
  return [
    { type: "tool", name: "screenshot", phase: "done", args: {} },
    { type: "tool", name: "screenshot", phase: "done", args: {}, isError: true },
    { type: "tool", name: "act_on_screen", phase: "done", args: { returnScreenshot: true } },
    { type: "tool", name: "act_on_screen", phase: "done", args: { returnScreenshot: false } },
    { type: "tool", name: "read_page", phase: "done", args: {} },
    { type: "tool", name: "read_image", phase: "done", args: {}, image: "data:image/png;base64,xx" },
    { type: "tool", name: "screenshot", phase: "running", isRunning: true, args: {} },
    { type: "tool", name: "screenshot", phase: "preparing", args: {} },
    { type: "compact", status: "done", compactId: "compact-1", summary: "compressed" },
    { type: "compact", status: "failed", compactId: "compact-failed" },
    { type: "compact", status: "running", compactId: "compact-running" },
  ];
}

function sumRecordedCalls() {
  return [callA, callB, callC].map(usage => summarizeSessionUsage({
    conversation: [{ role: "assistant", content: "part", _usage: usage }],
  })).reduce((total, part) => {
    for (const key of ["inputTokens", "outputTokens", "cachedTokens", "costUsd", "modelCalls"]) total[key] += part[key];
    return total;
  }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, modelCalls: 0 });
}

test("session usage matches the sum of recorded calls and completed activity", () => {
  const summary = summarizeSessionUsage({ conversation: sessionMessages(), transcript: sessionTranscript() });
  assert.deepEqual(summary, expected);
  const parts = sumRecordedCalls();
  assert.equal(parts.inputTokens, summary.inputTokens);
  assert.equal(parts.outputTokens, summary.outputTokens);
  assert.equal(parts.cachedTokens, summary.cachedTokens);
  assert.equal(parts.costUsd, summary.costUsd);
  assert.equal(parts.modelCalls, summary.modelCalls);
  assert.deepEqual(summarizeSessionUsage(), {
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0,
    modelCalls: 0, toolCalls: 0, screenshots: 0, contextCompressions: 0,
  });
});

test("recorded usage round-trips through the session codec", () => {
  assert.deepEqual(normalizeRecordedUsage(callA), {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cached_tokens: 30,
    cost_in_usd_ticks: 2_000_000_000,
  });
  assert.equal(normalizeRecordedUsage({ prompt_tokens: 1.2, cost_usd: 0.05 }).prompt_tokens, 2);
  assert.equal(normalizeRecordedUsage({ prompt_tokens: 1, cost_usd: 0.05 }).cost_usd, 0.05);
  assert.equal(normalizeRecordedUsage(null), null);

  const saved = serializeConversation([
    ...sessionMessages(),
    { role: "user", content: "stray", _usage: { prompt_tokens: 9, completion_tokens: 1, cost_usd: 3 } },
  ]);
  const openai = saved.entries.find(entry => entry.message?._usage?.prompt_tokens === 100);
  assert.deepEqual(openai.message._usage, normalizeRecordedUsage(callA));
  assert.equal(saved.entries.some(entry => entry.message?._usage?.cost_usd === 3), false);
  const compact = saved.entries.find(entry => entry.message?._kind === "compaction");
  assert.equal(compact.message._usage.input_tokens, 8);
  assert.equal(compact.message._usage.cache_read_input_tokens, 4);
  assert.equal(compact.message._usage.cost_in_usd_ticks, 500_000_000);
  assert.equal(compact.message._compact.compactId, "compact-1");

  const restored = deserializeConversation(saved, "system");
  assert.deepEqual(summarizeSessionUsage({ conversation: saved, transcript: sessionTranscript() }), expected);
  assert.deepEqual(summarizeSessionUsage({ conversation: restored, transcript: sessionTranscript() }), expected);
});

test("cache totals survive codec round-trips for DeepSeek, Responses and split usage", () => {
  for (const [usage, expectedInput, expectedCached] of [
    [{ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }, 20, 80],
    [{ input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 } }, 20, 80],
    [{ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 80 }, 20, 80],
    [{ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 }, 25, 80],
  ]) {
    const conversation = [{ role: 'assistant', content: 'answer', _usage: usage }];
    const live = summarizeSessionUsage({ conversation });
    assert.equal(live.inputTokens, expectedInput);
    assert.equal(live.cachedTokens, expectedCached);
    assert.equal(live.outputTokens, 10);
    assert.equal(live.modelCalls, 1);
    assert.deepEqual(summarizeSessionUsage({ conversation: serializeConversation(conversation) }), live);
    assert.deepEqual(summarizeSessionUsage({ conversation: deserializeConversation(serializeConversation(conversation), 'system') }), live);
  }
});

test("provider cost prefers ticks and does not invent a price", () => {
  const preferred = summarizeSessionUsage({ conversation: [{
    role: "assistant", content: "priced",
    _usage: { prompt_tokens: 10, completion_tokens: 1, cost_in_usd_ticks: 1_000_000_000, cost_usd: 9 },
  }] });
  assert.equal(preferred.costUsd, 0.1);
  assert.equal(preferred.inputTokens, 10);
  const missing = summarizeSessionUsage({ conversation: [{
    role: "assistant", content: "unpriced",
    _usage: { prompt_tokens: 10, completion_tokens: 1, cost_in_usd_ticks: -5, cost_usd: 4 },
  }] });
  assert.equal(missing.costUsd, 0);
  assert.equal(missing.modelCalls, 1);
  const dollars = summarizeSessionUsage({ conversation: [{
    role: "assistant", content: "dollars", _usage: { input_tokens: 2, output_tokens: 1, cost_usd: 0.05 },
  }] });
  assert.equal(dollars.costUsd, 0.05);
});

test("tool counts use the transcript when it has tools, otherwise paired tool results", () => {
  const conversation = [
    {
      role: "assistant", content: null,
      tool_calls: [{ id: "shot", type: "function", function: { name: "screenshot", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "shot", content: "captured" },
    {
      role: "assistant", content: "act",
      tool_calls: [{ id: "act", type: "function", function: { name: "act_on_screen", arguments: JSON.stringify({ returnScreenshot: true }) } }],
    },
    { role: "tool", tool_call_id: "act", content: JSON.stringify({ error: "failed" }) },
    {
      role: "user", content: "compressed", _kind: "compaction", _origin: "compaction", _usage: callC,
      _compact: { compactId: "compact-only", status: "done" },
    },
  ];
  const fromMessages = summarizeSessionUsage({
    conversation,
    transcript: [{ type: "compact", status: "running", compactId: "compact-running" }],
  });
  assert.equal(fromMessages.toolCalls, 2);
  assert.equal(fromMessages.screenshots, 1);
  assert.equal(fromMessages.contextCompressions, 1);
  assert.equal(fromMessages.modelCalls, 1);

  const transcriptWins = summarizeSessionUsage({
    conversation,
    transcript: [{ type: "tool", name: "read_page", phase: "done", args: {} }],
  });
  assert.deepEqual(
    { toolCalls: transcriptWins.toolCalls, screenshots: transcriptWins.screenshots },
    { toolCalls: 1, screenshots: 0 },
  );
  const failedCompact = summarizeSessionUsage({ conversation: [{
    role: "user", content: "failed", _kind: "compaction", _compact: { compactId: "bad", status: "failed" },
  }] });
  assert.equal(failedCompact.contextCompressions, 0);
});

test('tool usage excludes every explicit not-executed representation', () => {
  for (const skipped of [
    { phase: 'not_executed' }, { argsState: 'not_executed' },
    { phase: 'done', result: { code: 'TOOL_NOT_EXECUTED' } },
    { phase: 'done', result: JSON.stringify({ code: 'TOOL_NOT_EXECUTED' }) },
  ]) {
    const summary = summarizeSessionUsage({ transcript: [{ type: 'tool', name: 'screenshot', ...skipped }] });
    assert.equal(summary.toolCalls, 0);
    assert.equal(summary.screenshots, 0);
  }
});

test('paired cancellation ledger and conversation fallback do not count skipped tools', () => {
  let transcript = [];
  const results = [{ ok: true }, { code: 'OPERATION_ABORTED', error: 'stopped' }, { code: 'TOOL_NOT_EXECUTED', error: 'not started' }];
  for (const [index, result] of results.entries()) {
    for (const type of ['tool_execution_start', 'tool_execution_end']) {
      transcript = updateTranscriptWithAgentEvent(transcript, { type, runId: 'run', toolCallId: `call-${index}`,
        toolName: 'screenshot', args: {}, result, isError: !!result.error, startedExecution: index < 2 }).transcript;
    }
  }
  const conversation = [
    { role: 'assistant', tool_calls: results.map((_, index) => ({ id: `call-${index}`, type: 'function', function: { name: 'screenshot', arguments: '{}' } })) },
    ...results.map((result, index) => ({ role: 'tool', tool_call_id: `call-${index}`, content: JSON.stringify(result) })),
  ];
  for (const input of [{ transcript }, { conversation }, { conversation: serializeConversation(conversation) }]) {
    const summary = summarizeSessionUsage(input);
    assert.equal(summary.toolCalls, 2, 'an invoked failure counts, a synthetic skipped end does not');
    assert.equal(summary.screenshots, 1);
  }
});

function snapshotRuntime(messages, transcript) {
  let live = null;
  const sessions = {
    normalizeId: value => String(value || "").trim(),
    requireId(value, operation) {
      const id = String(value || "").trim();
      if (!id) throw new Error(`${operation} requires sessionId`);
      return id;
    },
    supervisor: {
      getUserWait: () => null,
      isRunCurrent: () => true,
      resolveUserWait: () => false,
      rejectUserWait: () => false,
    },
    submitMessage: async () => ({ promise: Promise.resolve(), runId: "run-1", disposition: "started" }),
    waitForRunObserved: async () => true,
    getRuntimeOutput: async (_id, project = value => value) => project({ sessionId: "s1", status: "completed", runId: "run-1" }),
    getLiveAgentEntry: async () => live,
    setRuntime() {},
    getLastMessages: async () => ({ messages: [] }),
    getAgent: async () => ({ exportSession: () => serializeConversation(messages) }),
    getTranscript: async () => transcript,
    listMetadata: async () => ({ s1: { id: "s1", title: "Usage" } }),
    getConversation: async () => serializeConversation(messages),
    compactTranscriptEvent: event => ({ ...event, compact: true }),
    getRuntime: () => ({ status: "completed", runId: "run-1" }),
  };
  const runtime = createMcpRuntime({
    sessions,
    userInputPermissions: {
      hasBrowserPermission: async () => false,
      locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("unused"); } },
    },
    tools: {
      canManageSessions: async () => false,
      buildRunProfile: async () => ({}),
      loadedSkillNames: () => [],
      recordLoadedSkillNames() {},
      runtime: { getSchemas: () => [], async execute() { return {}; } },
    },
    skills: {
      list: async () => [],
      load: async () => null,
      getDisplayName: skill => skill.name || "",
      normalizeResourcePath: value => String(value || ""),
    },
    artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
    trace: { get: async () => [] },
    async dispatchSidepanel() {},
  });
  return {
    runtime,
    useLive() {
      live = {
        exportSession: () => serializeConversation(messages),
        getRunState: () => ({ isStreaming: false, runId: "run-1", hasHistory: true }),
        getContextUsageState: async () => ({ runId: "run-1", inputTokensEstimate: 0 }),
      };
    },
  };
}

test("session snapshot usage matches the serialized conversation", async () => {
  const messages = sessionMessages();
  const transcript = sessionTranscript();
  const { runtime, useLive } = snapshotRuntime(messages, transcript);
  const persisted = await runtime.getSnapshot("s1", { compact: false, includeArtifacts: false });
  assert.deepEqual(persisted.usage, expected);
  assert.equal(persisted.transcript[0].compact, undefined);

  useLive();
  const live = await runtime.getSnapshot("s1");
  assert.deepEqual(live.usage, expected);
  assert.equal(live.transcript[0].compact, true);
  assert.equal(live.runtime.contextUsage, undefined);
});

const running = {
  endpoint: "http://127.0.0.1:23456",
  health: { features: { browserPairing: 1 }, status: { connected: true, clients: [{ clientId: "fixture" }] } },
};

function cliDeps({ tty = false, columns = 160, callTool }) {
  const stream = () => ({ isTTY: tty, columns, text: "", write(value) { this.text += value; } });
  return {
    stdout: stream(),
    stderr: stream(),
    env: { NO_COLOR: "1" },
    findDaemon: async () => running,
    callTool,
  };
}

test("create --wait and show JSON include the cumulative usage summary", async () => {
  const usage = summarizeSessionUsage({ conversation: sessionMessages(), transcript: sessionTranscript() });
  assert.deepEqual(usage, expected);
  const snapshot = {
    sessionId: "task-1",
    session: { id: "task-1", title: "Usage" },
    status: "completed",
    runId: "run-1",
    runtime: { status: "completed", runId: "run-1" },
    transcript: [{ type: "assistant", content: "done" }],
    usage,
  };
  const calls = [];
  const callTool = async (_endpoint, name, args) => {
    calls.push({ name, args });
    if (name === "qingzhou_create_session") return { session: { id: "task-1", title: "Usage" }, started: true };
    assert.equal(name, "qingzhou_get_session_snapshot");
    assert.equal(args.sessionId, "task-1");
    return snapshot;
  };

  const created = cliDeps({ callTool });
  assert.equal(await main(["create", "Finish the task", "--wait", "--json"], created), 0);
  const createdResult = JSON.parse(created.stdout.text);
  assert.equal(createdResult.ok, true);
  assert.deepEqual(createdResult.result.snapshot.usage, expected);
  const waited = calls.find(call => call.name === "qingzhou_get_session_snapshot");
  assert.equal(waited.args.compact, false);
  assert.equal(waited.args.tail, false);
  calls.length = 0;

  const shown = cliDeps({ callTool });
  assert.equal(await main(["show", "task-1", "--json"], shown), 0);
  assert.deepEqual(JSON.parse(shown.stdout.text).result.usage, expected);

  const human = cliDeps({ tty: true, callTool });
  assert.equal(await main(["show", "task-1"], human), 0);
  assert.match(human.stdout.text, new RegExp(usageLine.replace(/[$.]/g, "\\$&")));

  const quiet = cliDeps({
    tty: true,
    callTool: async () => ({ ...snapshot, usage: {
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0,
      modelCalls: 0, toolCalls: 0, screenshots: 0, contextCompressions: 0,
    } }),
  });
  assert.equal(await main(["show", "task-1"], quiet), 0);
  assert.doesNotMatch(quiet.stdout.text, /^Usage {2}/m);
});
