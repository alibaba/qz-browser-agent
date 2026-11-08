import assert from "node:assert/strict";
import { registerSessionTools } from "../../src/capabilities/sessions/tools.js";
const definitions = new Map();
const calls = [];
class ToolExecutionError extends Error { constructor(code, message) { super(message); this.code = code; } }
registerSessionTools({
  registerTool: ({ name, description, parameters: schema, execute }) => definitions.set(name, { schema, execute }),
  ToolExecutionError, secondsToMs: n => n * 1000,
  getToolRuntimeDependencies: () => ({ sessions: {
    listSessions: async args => { calls.push(['list', args]); return { sessions: [] }; },
    createSession: async args => { calls.push(['create', args]); return {
      session: { sessionId: 'child', title: args.title, status: 'idle' }, started: false,
    }; },
    stopSession: async (...args) => { calls.push(['stop', ...args]); return { stopped: true }; },
    sendMessage: async args => { calls.push(['send', args]); return { accepted: true }; },
    saveAutomation: async args => { calls.push(['save', args]); return { automation: args.automation }; },
  } }),
});
const tool = definitions.get('manage_sessions');
const context = { sessionId: 'parent', runId: 'run', toolCallId: 'call' };
for (const mode of ['follow_up', 'steer']) {
  assert.deepEqual(await tool.execute({ action: 'send_message', sessionId: 'child', message: 'Continue', mode }, null, context), { accepted: true });
  assert.equal(calls.at(-1)[1].deliveryMode, mode);
  assert.equal(calls.at(-1)[1].clientMessageId, 'session-tool:parent:run:call');
}
await tool.execute({ action: 'stop', sessionId: 'child' }, null, context);
assert.equal(calls.at(-1)[0], 'stop');
assert.equal(calls.at(-1)[1], 'child');
for (const args of [
  { action: 'stop' }, { action: 'stop', sessionId: 'parent' },
  { action: 'send_message', sessionId: 'child', message: '' },
  { action: 'send_message', sessionId: 'child', message: 'x', mode: 'invalid' },
]) await assert.rejects(tool.execute(args, null, context));
assert.equal(calls.length, 3);

const beforeInvalidTitle = calls.length;
for (const title of [undefined, '', '  \n ']) {
  await assert.rejects(tool.execute({ action: 'create', title }, null, context), { code: 'MISSING_REQUIRED_ARGUMENTS' });
}
assert.equal(calls.length, beforeInvalidTitle, 'a public task needs a readable title before persistence');
const child = await tool.execute({ action: 'create', title: '  Collect prices  ' }, null, context);
assert.deepEqual(child, { created: true, session: { sessionId: 'child', title: 'Collect prices', status: 'idle' }, started: false });
assert.deepEqual(calls.at(-1), ['create', {
  title: 'Collect prices', firstMessage: '', parentSessionId: 'parent', publicView: true,
}]);
assert.deepEqual(await tool.execute({ action: 'list', limit: 2 }, null, context), { sessions: [] });
assert.deepEqual(calls.at(-1), ['list', { limit: 2, excludeSessionId: 'parent', publicView: true }]);

const schedule = { type: 'once', datetime: '2026-10-01T09:00:00+08:00' };
const created = await tool.execute({ action: 'create_automation', title: '  Collect  ', firstMessage: '  Save rows  ',
  schedule, missedPolicy: 'run_once', notifyPolicy: 'silent' }, null, context);
assert.deepEqual(calls.at(-1), ['save', { sourceSessionId: 'parent', automation: {
  title: 'Collect', instruction: 'Save rows', schedule, missedPolicy: 'run_once', notifyPolicy: 'silent', enabled: true,
} }]);
assert.equal(created.created, true);
assert.equal(calls.at(-1)[1].automation.schedule, schedule, 'legacy schedule fields reach the existing host normalization unchanged');

await tool.execute({ action: 'create_automation', title: 'Paused', instruction: 'Save rows', enabled: false }, null, context);
assert.equal(calls.at(-1)[1].automation.enabled, false, 'explicit false is not replaced by the creation default');
const updated = await tool.execute({ action: 'update_automation', automationId: 'existing', enabled: false }, null, context);
assert.equal(updated.updated, true);
assert.deepEqual(calls.at(-1)[1], { sourceSessionId: 'parent', automation: { id: 'existing', enabled: false } },
  'partial edits do not materialize title, instruction, schedule or policy defaults');
await tool.execute({ action: 'update_automation', automationId: 'existing', title: '', instruction: '', schedule: null }, null, context);
assert.deepEqual(calls.at(-1)[1].automation, { id: 'existing' }, 'empty optional patches retain the current definition');

const beforeInvalidAutomation = calls.length;
for (const args of [
  { action: 'create_automation', instruction: 'No title' },
  { action: 'create_automation', title: 'No instruction' },
  { action: 'update_automation', enabled: false },
]) await assert.rejects(tool.execute(args, null, context));
assert.equal(calls.length, beforeInvalidAutomation, 'invalid creation or update input never reaches persistence');
console.log('session stop, send_message and automation input tests passed');
