import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { compileScriptRuntime } from './script-runtime-fixture.mjs';
import { runInnerWorker } from './inner-runner-fixture.mjs';
import { createMemoryStorage } from './memory-storage.mjs';
import { normalizeModernSkill } from '../../src/shared/skills/skill-utils.js';
import { commitSkillToolRegistryCandidate, prepareSkillToolRegistryFromSkills } from '../../src/background/skills/skill-tool-runtime.js';

let compiled;

/** Exercise the real argument boundary, Skill loader, public script handler and emitted Worker. */
export async function scriptExecutionFixture(skills, onTool) {
  globalThis.SCRIPT_RUNTIME_SOURCE = await compileScriptRuntime('production');
  compiled ||= compileInnerWorker({ mode: 'production' });
  const worker = await compiled;
  const stored = skills.map(normalizeModernSkill);
  const storage = createMemoryStorage({ _skills: Object.fromEntries(stored.map(skill => [skill.name, skill])) });
  commitSkillToolRegistryCandidate(prepareSkillToolRegistryFromSkills(stored));
  const messages = [], settings = [], networks = [];
  globalThis.chrome = { storage: { local: storage } };
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  const runtime = createToolRuntime({
    skillSettings: { async getExecutionConfig(_plugin, options) { settings.push(options); return { token: 'fixture-secret' }; } },
    skillNetwork: { registerExecution(id, context) { networks.push(context); return () => {}; } },
    sessions: { getTabAliases: () => ({ research: 7 }) },
  });
  globalThis.chrome = {
    storage: { local: storage }, offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtime: { getURL: path => path, async sendMessage(message) {
      if (message.type === 'run_script_inner_ping') return { ok: true, ready: true };
      messages.push(message);
      void runInnerWorker(worker, message.source, {
        scriptArgs: message.scriptArgs, strictResult: message.strictResult, fetchBridge: message.fetchBridge,
        async onMessage(call, respond) {
          if (call.type === 'script_trace') {
            runtime.handleRunScriptInnerRuntimeMessage({ type: 'run_script_inner_diagnostic', requestId: message.requestId, row: call.row });
            return;
          }
          if (call.type !== 'tool_call') return;
          const result = await onTool?.(call);
          respond({ type: 'tool_response', callId: call.callId,
            response: { ok: true, result, toolCallId: 'host-' + call.callId } });
        },
      }).then(({ result }) => runtime.handleRunScriptInnerRuntimeMessage({ type: 'run_script_inner_result', requestId: message.requestId, result }),
        error => runtime.handleRunScriptInnerRuntimeMessage({ type: 'run_script_inner_result', requestId: message.requestId,
          result: { ok: false, code: 'FIXTURE_FAILURE', error: error.stack } }));
      return { ok: true, accepted: true };
    } },
  };
  return { runtime, storage, messages, settings, networks,
    execute: (name, args, context = {}) => runtime.execute(name, args, undefined,
      { sessionId: 'script-test', runId: 'script-run', resultPresentation: {}, ...context }),
  };
}
