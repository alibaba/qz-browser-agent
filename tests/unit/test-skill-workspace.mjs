import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../support/memory-storage.mjs';
import { createSkillStateRepository } from '../../src/background/skills/skill-repository.js';
import { createSkillWorkspaceService } from '../../src/background/skills/skill-workspace.js';
import { listSkills } from '../../src/background/skills/runtime.js';
import { listBuiltinSkills, mergeBuiltinSkills } from '../../src/shared/skills/builtin-skills.js';
import { createGitSkillSourceRepository } from '../../src/background/skills/git-skill-source-repository.js';
import { nowBeijingDateTime } from '../../src/shared/time-utils.js';
import { normalizeModernSkill } from '../../src/shared/skills/skill-utils.js';
import { createBackgroundApi } from '../../src/background/background-api.js';
import { createSidepanelTransport } from '../../src/background/transports/sidepanel.js';
const skill = (name, content = name) => normalizeModernSkill({ name, content, description: name });
const conflict = { code: 'SKILL_WRITE_CONFLICT' };
function setup(seed = { alpha: skill('alpha') }, options = {}) {
  const storage = createMemoryStorage({ _skills: seed });
  const events = [];
  const repository = createSkillStateRepository({ storage });
  const workspace = createSkillWorkspaceService({ repository, prepare: async () => {}, validate: async () => {},
    onChanged: async (reason, detail) => events.push({ reason, detail }), ...options });
  return { storage, repository, workspace, events };
}

test('skill lists and workspace snapshots dedupe user names, not display names', async t => {
  const stored = [
    ['rt1', 'rt-shared'],
    ['rt2', 'rt-shared'],
    ['rt3', 'rt1'], // A display name may equal an earlier user identity.
    ['rt-shared', 'Other title'], // An identity may equal an earlier display name.
    ['rt-1', 'Duplicate identity'], // Normalized names still dedupe.
  ].map(([name, displayName]) => normalizeModernSkill({ name, displayName, description: name, content: name }));
  const { storage, workspace } = setup(Object.fromEntries(stored.map(row => [row.name, row])));
  const previousChrome = globalThis.chrome;
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
  globalThis.chrome = { storage: { local: storage } };
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  const listed = await createToolRuntime().execute('manage_skill', {
    action: 'list_skills', scope: 'all',
  }, undefined, { source: 'plugin_host' });
  const expected = [...listBuiltinSkills().map(row => row.name), 'rt1', 'rt2', 'rt3', 'rt-shared'].sort();
  for (const [path, rows] of Object.entries({
    mergeBuiltinSkills: mergeBuiltinSkills(stored),
    listSkills: await listSkills(),
    list_skills: listed.items,
    workspace: (await workspace.read()).skills,
  })) {
    assert.deepEqual(rows.map(row => row.name).sort(), expected, path);
  }
});

test('workspace save, import and delete use IDs without removing display-name siblings', async () => {
  const neighbours = [
    normalizeModernSkill({ name: 'sibling', displayName: 'target', content: 'keep', createdAt: 'sibling-only' }),
    normalizeModernSkill({ name: 'same-title', displayName: 'Shared title', content: 'keep too' }),
  ];
  for (const action of ['save', 'import']) {
    const { workspace, storage } = setup(Object.fromEntries(neighbours.map(row => [row.name, row])));
    const incoming = normalizeModernSkill({ name: 'target', displayName: 'Shared title', content: 'new' });
    const write = expected => action === 'save'
      ? workspace.save({ name: 'target', expected, skill: incoming })
      : workspace.import({ skills: [incoming], expected: { target: expected } });
    await write(null);
    const created = storage.snapshot()._skills.target;
    assert.notEqual(created.createdAt, 'sibling-only');
    await write(created);
    for (const row of neighbours) assert.deepEqual(storage.snapshot()._skills[row.name], row);
    await workspace.remove({ name: 'target', expected: storage.snapshot()._skills.target });
    assert.deepEqual(storage.snapshot()._skills, Object.fromEntries(neighbours.map(row => [row.name, row])));
  }
});

test('concurrent unrelated edits merge; a stale edit/delete cannot overwrite the same Skill', async () => {
  const { workspace } = setup({ alpha: skill('alpha'), beta: skill('beta') });
  const { skills } = await workspace.read();
  const alpha = skills.find(row => row.name === 'alpha');
  const beta = skills.find(row => row.name === 'beta');
  await Promise.all([
    workspace.save({ name: 'alpha', expected: alpha, skill: { ...alpha, content: 'A' } }),
    workspace.save({ name: 'beta', expected: beta, skill: { ...beta, content: 'B' } }),
  ]);
  const current = (await workspace.read()).skills;
  assert.equal(current.find(row => row.name === 'alpha').content, 'A');
  assert.equal(current.find(row => row.name === 'beta').content, 'B');
  await assert.rejects(workspace.save({ name: 'alpha', expected: alpha, skill: alpha }), conflict);
  await assert.rejects(workspace.remove({ name: 'alpha', expected: alpha }), conflict);
});

test('validation awaiting a remote check still detects a competing write at commit', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const { workspace, repository } = setup(undefined, { validate: async () => { started(); await gate; } });
  const before = await repository.read();
  const pending = workspace.save({ name: 'alpha', expected: before._skills.alpha, skill: skill('alpha', 'editor') });
  await entered;
  await repository.commit(before, { _skills: { alpha: skill('alpha', 'agent') } });
  release();
  await assert.rejects(pending, conflict);
  assert.equal((await repository.read())._skills.alpha.content, 'agent');
});

test('an unchanged same-second save retains its optimistic read check during validation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 17, 10) });
  const stamp = nowBeijingDateTime();
  const original = { ...skill('alpha'), createdAt: stamp, updatedAt: stamp };
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const { workspace, repository, events } = setup({ alpha: original }, {
    validate: async candidate => { assert.deepEqual(candidate, original); started(); await gate; },
  });
  const before = await repository.read();
  const pending = workspace.save({ name: 'alpha', expected: original, skill: original });
  await entered;
  await repository.commit(before, { _skills: { alpha: skill('alpha', 'newer agent result') } });
  release();
  await assert.rejects(pending, conflict);
  assert.deepEqual(events, []);
  assert.equal((await repository.read())._skills.alpha.content, 'newer agent result');
});

test('Git skill/source commit preserves unrelated local edits and rejects changed packages atomically', async () => {
  const { storage, repository } = setup({ alpha: skill('alpha'), beta: skill('beta') });
  const git = createGitSkillSourceRepository({ storage });
  const expected = await git.readSnapshot();
  const before = await repository.read();
  await repository.commit(before, { _skills: { ...before._skills, beta: skill('beta', 'new') } });
  await git.commitSnapshot({ expected, skills: { ...expected.skills, alpha: skill('alpha', 'git') }, sources: {} });
  assert.equal((await repository.read())._skills.beta.content, 'new');
  await assert.rejects(git.commitSnapshot({ expected, skills: { ...expected.skills, alpha: skill('alpha', 'stale') }, sources: {} }), conflict);
  assert.equal((await repository.read())._skills.alpha.content, 'git');
});

test('failed writes publish nothing and the queue recovers; registry failures retain saved packages', async () => {
  let fail = true;
  const memory = createMemoryStorage({ _skills: { alpha: skill('alpha') } });
  const storage = { ...memory, async set(patch) { if (fail) throw new Error('disk failed'); await memory.set(patch); } };
  const repository = createSkillStateRepository({ storage });
  const events = [];
  const workspace = createSkillWorkspaceService({ repository, prepare: async () => {}, validate: async () => {}, onChanged: async () => { events.push('changed'); throw new Error('registry unavailable'); } });
  const expected = skill('alpha');
  await assert.rejects(workspace.save({ name: 'alpha', expected, skill: skill('alpha', 'saved') }), /disk failed/);
  assert.deepEqual(events, []);
  assert.equal((await repository.read())._skills.alpha.content, 'alpha');
  fail = false;
  const result = await workspace.save({ name: 'alpha', expected, skill: skill('alpha', 'saved') });
  assert.equal(result.registryReady, false);
  assert.equal(result.skill.content, 'saved');
  assert.deepEqual(events, ['changed']);
});

test('batch import requires expectations, validates all rows before writing, and cannot replace builtins', async () => {
  const { workspace, storage } = setup({}, { validate: async row => { if (row.name === 'bad') throw new Error('invalid plugin'); } });
  await assert.rejects(workspace.import({ skills: [skill('one')], expected: {} }), /expected record/);
  await assert.rejects(workspace.import({ skills: [skill('one'), skill('bad')], expected: { one: null, bad: null } }), /invalid plugin/);
  assert.deepEqual(storage.snapshot()._skills, {});
  await assert.rejects(workspace.import({ skills: [skill('qingzhou-documents')], expected: { 'qingzhou-documents': null } }), { code: 'SKILL_READ_ONLY' });
  const result = await workspace.import({ skills: [skill('one')], expected: { one: null } });
  assert.equal(result.count, 1);
  await assert.rejects(workspace.import({ skills: [skill('one', 'overwrite')], expected: { one: null } }), conflict);
});

test('workspace transport preserves optimistic snapshots and correlates replies', async () => {
  const { workspace } = setup({});
  const api = createBackgroundApi({ system: { ready: async () => {} }, skills: { workspaceRead: workspace.read, workspaceSave: workspace.save, workspaceImport: workspace.import, workspaceDelete: workspace.remove } });
  const transport = createSidepanelTransport(api);
  const replies = [];
  const port = { postMessage: message => replies.push(message) };
  await transport.dispatch({ type: 'save_workspace_skill', requestId: 'save-1', name: 'new', skill: skill('new'), expected: null }, port);
  assert.equal(replies[0].type, 'skill_workspace_saved');
  assert.equal(replies[0].requestId, 'save-1');
  const expected = replies[0].skill;
  await transport.dispatch({ type: 'delete_workspace_skill', requestId: 'delete-1', name: 'new', expected }, port);
  assert.equal(replies[1].type, 'skill_workspace_deleted');
  assert.equal((await workspace.read()).skills.some(row => row.name === 'new'), false);
});
