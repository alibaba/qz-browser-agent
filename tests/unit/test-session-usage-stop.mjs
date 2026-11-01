import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
import { createSessionRecord, readSessionRecord, updateTranscriptWithAgentEvent } from '../../src/shared/session/session-codec.js';
import { summarizeSessionUsage } from '../../src/shared/session/session-usage.js';

globalThis.chrome = { runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: { async get() { return {}; }, async set() {} } } };
const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });

for (const tool of ['wait', 'run_script']) test(`Stop counts admission, not the aborted queue: open_tab + 5 ${tool}`, async () => {
  const calls = [call('open', 'open_tab', { url: 'http://127.0.0.1/fast.html', tabAlias: 'g' }),
    ...Array.from({ length: 5 }, (_, i) => call(`work-${i}`, tool, tool === 'wait'
      ? { seconds: 6, timeout: 15 }
      : { tabRef: 'g', code: 'await new Promise(r => setTimeout(r, 6000)); return Date.now();', timeout: 20 }))];
  const controller = new AbortController();
  const started = [];
  let transcript = [];
  const project = event => { transcript = updateTranscriptWithAgentEvent(transcript, { runId: 'run', ...event }).transcript; };
  for (const tc of calls) project({ type: 'tool_call_update', toolCallId: tc.id, toolName: tc.function.name,
    argsText: tc.function.arguments, argsComplete: true });
  // Keep production scheduling policies, aliases and the Agent's actual scheduler.
  // Only the browser/time effects are held so Stop happens at a deterministic boundary.
  const runtime = createToolRuntime();
  const agent = new Agent('usage-stop', createTestAgentOptions({ tools: { ...runtime,
    async execute(name, args, signal) {
      started.push(name);
      if (name === 'open_tab') return { id: 7, tabAlias: args.tabAlias };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('stopped'), { code: 'OPERATION_ABORTED' });
    },
    async commitToolResult() {}, async discardToolResult() {},
  } }));
  agent._currentRunId = 'run';
  agent._collectToolRuntimeContext = async () => ({ workingTabId: 7 });
  agent._enrichToolCallArgsWithPageContext = async (_name, args) => args;
  agent._applyToolResultEffects = async () => [];
  agent._emit = project;
  const pending = agent._executeToolCalls(calls, controller.signal);
  for (let i = 0; started.length < 2 && i < 300; i++) await tick();
  assert.deepEqual(started, ['open_tab', tool]);
  assert.equal(summarizeSessionUsage({ transcript }).toolCalls, 2);
  // Session Stop revokes events before finalizing the outstanding transcript.
  agent._emit = () => {};
  controller.abort();
  project({ type: 'aborted' });
  await pending;
  const saved = JSON.parse(JSON.stringify(createSessionRecord([], transcript)));
  const restored = readSessionRecord(saved).transcript;
  const rows = restored.filter(entry => entry.type === 'tool');
  assert.deepEqual(rows.map(entry => entry.phase), ['done', ...Array(5).fill('aborted')]);
  assert.deepEqual(rows.map(entry => entry.startedExecution), [true, true, false, false, false, false]);
  assert.equal(summarizeSessionUsage({ transcript: restored }).toolCalls, 2);
  const legacy = restored.map(({ startedExecution, ...entry }) => entry);
  assert.equal(summarizeSessionUsage({ transcript: legacy }).toolCalls, 6, 'old aborted records cannot recover missing admission facts');
  console.log('QA_USAGE', JSON.stringify({ tool, started, beforeFix: summarizeSessionUsage({ transcript: legacy }).toolCalls,
    afterFix: summarizeSessionUsage({ transcript: restored }).toolCalls, rows: rows.map(({ name, phase, startedExecution }) => ({ name, phase, startedExecution })) }));
});

test('preparation failures receive a ledger pair without execution admission', async () => {
  const runtime = createToolRuntime();
  let transcript = [];
  const agent = new Agent('usage-preparation', createTestAgentOptions({ tools: runtime }));
  agent._currentRunId = 'run';
  agent._emit = event => { transcript = updateTranscriptWithAgentEvent(transcript, event).transcript; };
  await agent._executeToolCalls([call('bad-ref', 'run_script', { tabRef: 'unknown', code: 'return 1;' })], new AbortController().signal);
  const restored = readSessionRecord(createSessionRecord([], transcript)).transcript;
  assert.equal(restored[0].startedExecution, false);
  assert.equal(summarizeSessionUsage({ transcript: restored }).toolCalls, 0);
});

test('legacy records retain known completed, running and skipped counts across the codec', () => {
  const transcript = [
    { type: 'tool', name: 'wait', phase: 'done' },
    { type: 'tool', name: 'wait', phase: 'running', isRunning: true },
    { type: 'tool', name: 'wait', phase: 'preparing', argsState: 'ready' },
    { type: 'tool', name: 'wait', phase: 'not_executed' },
    { type: 'tool', name: 'wait', phase: 'aborted', result: { code: 'TOOL_ABORTED' } },
  ];
  const restored = readSessionRecord(createSessionRecord([], transcript)).transcript;
  assert.equal(restored.some(entry => 'startedExecution' in entry), false);
  assert.equal(summarizeSessionUsage({ transcript: restored }).toolCalls, 3);
});
