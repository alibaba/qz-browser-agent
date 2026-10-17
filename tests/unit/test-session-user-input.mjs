import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionUserInput } from '../../src/background/session/user-input.js';
import { selectSkillResults } from '../../src/background/skills/skill-selection.js';

const fields = [
  { id: 'name', type: 'text', required: true },
  { id: 'notes', type: 'textarea', required: false },
  { id: 'choice', type: 'single_choice', options: [{ value: 'a', label: 'Alpha' }, { value: 'b' }] },
  { id: 'cards', type: 'multi_choice', presentation: 'cards', options: [{ value: 'a', imageUrl: 'https://example.test/a.png', meta: [{ label: 'Price', value: '42' }] }, { value: 'b' }] },
];
const valid = { name: 'Ada', choice: 'a', cards: ['b', 'a'] };
function fixture(form = { fields }) {
  let wait = { sessionId: 's1', waitId: 'w1', runId: 'r1' };
  const runtime = { ...wait, waitForm: form, waitTitle: 'Review', waitMessage: 'Full disclosure' };
  const resolved = []; const rejected = []; const consents = [];
  const permissions = { granted: false, accepted: false, check: null, save: null, read: null };
  const api = createSessionUserInput({
    getWait: id => id === 's1' ? wait : null,
    getRuntime: () => runtime,
    resolve: input => { if (!wait || input.waitId !== wait.waitId) return false; resolved.push(input); wait = null; return true; },
    reject: input => { if (!wait || input.waitId !== wait.waitId) return false; rejected.push(input); wait = null; return true; },
    hasBrowserPermission: async permission => { assert.equal(permission, 'history'); return permissions.check ? permissions.check() : permissions.granted; },
    locationConsent: {
      isAccepted: async () => permissions.read ? permissions.read() : permissions.accepted,
      acceptExternal: async (...args) => { if (permissions.save) return permissions.save(...args); if (args[2] !== 1) throw Object.assign(new Error('Read current notice.'), { code: 'VERSION_MISMATCH' }); consents.push(args.slice(0, 3)); permissions.accepted = true; },
    },
  });
  return { api, runtime, resolved, rejected, permissions, consents,
    replace(id = 'w2', runId = 'r2') { wait = { sessionId: 's1', waitId: id, runId }; Object.assign(runtime, wait); },
    clear() { wait = null; }, reply: args => api.respond({ sessionId: 's1', waitId: 'w1', ...args }) };
}

test('input exposes complete live form and cards; caller mutations cannot alter it', () => {
  const f = fixture(); const input = f.api.get({ sessionId: 's1' });
  assert.equal(input.kind, 'form'); assert.equal(input.message, 'Full disclosure'); assert.deepEqual(input.actions, ['submit', 'reject']);
  assert.deepEqual(input.form.fields, fields);
  input.form.fields[0].required = false;
  assert.equal(f.runtime.waitForm.fields[0].required, true);
  f.runtime.waitId = 'stale'; assert.equal(f.api.get({ sessionId: 's1' }).waiting, false);
  f.runtime.waitId = 'w1'; f.clear(); assert.equal(f.api.get({ sessionId: 's1' }).waiting, false);
});

test('response template uses exact field IDs, defaults, and choice value shapes without answering', () => {
  const f = fixture({ fields: [
    { id: 'city', type: 'text', label: '城市 / 地区', required: true, defaultValue: '' },
    { id: "owner's name", type: 'text', defaultValue: "O'Reilly" },
    { id: 'one', type: 'single_choice', options: [{ value: 'a', label: 'Alpha' }] },
    { id: 'many', type: 'multi_choice', options: [{ value: 'a' }] },
    { id: 'defaultChoice', type: 'multi_choice', defaultValues: [' a '], options: [{ value: ' a ' }] },
    { id: 'normalizedChoice', type: 'multi_choice', defaultValue: ['b'], options: [{ value: 'b' }] },
    { id: 'notes', type: 'textarea', required: false },
    { id: 'optionalChoice', type: 'multi_choice', required: false },
    { id: '__proto__', type: 'text' },
  ] });
  const input = f.api.get({ sessionId: 's1' });
  assert.deepEqual(input.responseTemplate, {
    sessionId: 's1', waitId: 'w1', action: 'submit', answers: {
      city: '<text>', "owner's name": "O'Reilly", one: '<option value>', many: ['<option value>'],
      defaultChoice: [' a '], normalizedChoice: ['b'], notes: '', optionalChoice: [], ['__proto__']: '<text>',
    },
  });
  assert.match(input.instructions, /field IDs.*option values.*array/);
  input.responseTemplate.answers.defaultChoice.push('b');
  assert.deepEqual(f.runtime.waitForm.fields[4].defaultValues, [' a ']);
  assert.deepEqual(f.api.get({ sessionId: 's1' }).responseTemplate.answers.defaultChoice, [' a ']);
  assert.equal(f.resolved.length, 0);
});

test('invalid and stale responses carry the current form and template for the next reply', async () => {
  const f = fixture();
  const invalid = await f.reply({ action: 'submit', answers: {} });
  assert.equal(invalid.accepted, false);
  assert.deepEqual(invalid.input.form.fields, fields);
  assert.equal(invalid.input.responseTemplate.waitId, 'w1');
  assert.equal((await f.api.respond({ ...invalid.input.responseTemplate, answers: valid })).accepted, true);
  f.replace();
  const stale = await f.reply({ action: 'submit', answers: valid });
  assert.equal(stale.stale, true);
  assert.equal(stale.input.responseTemplate.waitId, 'w2');
  assert.equal(stale.input.runId, 'r2');
  assert.equal(f.resolved.length, 1);
  f.clear();
  assert.deepEqual((await f.reply({ action: 'reject' })).input, { sessionId: 's1', waiting: false });
  assert.deepEqual((await f.api.respond({ sessionId: 'other', waitId: 'w1', action: 'reject' })).input, { sessionId: 'other', waiting: false });
});

test('required, type, allowed option, duplicate and unknown field failures retain wait', async () => {
  for (const [answers, fieldId, code] of [
    [{ ...valid, name: ' ' }, 'name', 'REQUIRED'],
    [{ ...valid, notes: 3 }, 'notes', 'INVALID_TYPE'],
    [{ ...valid, cards: 'a' }, 'cards', 'INVALID_TYPE'],
    [{ ...valid, choice: ['a'] }, 'choice', 'INVALID_TYPE'],
    [{ ...valid, choice: 'missing' }, 'choice', 'INVALID_OPTION'],
    [{ ...valid, cards: ['a', 'a'] }, 'cards', 'DUPLICATE_OPTION'],
    [{ ...valid, invented: true }, 'invented', 'UNKNOWN_FIELD'],
    [[], '', 'INVALID_TYPE'],
  ]) {
    const f = fixture(); const result = await f.reply({ action: 'submit', answers });
    assert.equal(result.accepted, false); assert.equal(result.code, 'INVALID_ANSWERS');
    assert.ok(result.fieldErrors.some(error => error.fieldId === fieldId && error.code === code));
    assert.equal(f.api.get({ sessionId: 's1' }).waiting, true); assert.equal(f.resolved.length, 0);
    assert.equal((await f.reply({ action: 'submit', answers: valid })).accepted, true);
  }
});

test('valid form resolves once; duplicate/stale/sessionless responses cannot resolve a new wait', async () => {
  const f = fixture(); assert.equal((await f.reply({ action: 'submit', answers: valid })).accepted, true);
  assert.deepEqual(f.resolved[0].payload.answers, { ...valid, notes: '' });
  assert.equal((await f.reply({ action: 'submit', answers: valid })).stale, true);
  f.replace(); assert.equal((await f.reply({ action: 'reject' })).stale, true);
  assert.equal((await f.api.respond({ action: 'approve' })).stale, true);
  assert.equal(f.api.get({ sessionId: 's1' }).waitId, 'w2');
});

test('generic continue and approve cannot consume a required form', async () => {
  const f = fixture();
  assert.equal((await f.reply({ action: 'approve' })).code, 'ANSWERS_REQUIRED');
  assert.equal((await f.api.continueWait({ sessionId: 's1', waitId: 'w1' })).accepted, false);
  assert.equal((await f.api.continueWait({ sessionId: 's1', waitId: 'w1', payload: { submitted: true, answers: valid } })).accepted, true);
});

test('omitted optional fields use UI empty values without changing submitted answers', async () => {
  const optional = ['text', 'textarea', 'single_choice', 'multi_choice'].map(type => ({
    id: type, type, required: false, options: [{ value: 'a' }],
  }));
  const f = fixture({ fields: optional });
  const answers = Object.freeze({});
  assert.equal((await f.reply({ action: 'submit', answers })).accepted, true);
  assert.deepEqual(f.resolved[0].payload.answers, { text: '', textarea: '', single_choice: '', multi_choice: [] });
  assert.deepEqual(answers, {});
});

test('explicit null answers retain the wait with required or type errors', async () => {
  for (const type of ['text', 'textarea', 'single_choice', 'multi_choice']) {
    for (const required of [false, true]) {
      const f = fixture({ fields: [{ id: 'answer', type, required, options: [{ value: 'a' }] }] });
      const result = await f.reply({ action: 'submit', answers: { answer: null } });
      assert.equal(result.accepted, false);
      assert.deepEqual(result.fieldErrors.map(({ fieldId, code }) => ({ fieldId, code })), [
        { fieldId: 'answer', code: required ? 'REQUIRED' : 'INVALID_TYPE' },
      ]);
      assert.equal(f.api.get({ sessionId: 's1' }).waiting, true);
      assert.equal(f.resolved.length, 0);
    }
  }
});

test('optional Skill selection rejects null then accepts omitted selection as empty', async () => {
  for (const selectionMode of ['single', 'multiple']) {
    const result = await selectSkillResults({ type: 'selection', required: false, selectionMode },
      { items: [{ id: 'a', title: 'Alpha' }] }, undefined, { sessionId: 's1', runId: 'r1', language: 'en' },
      async (tool, form) => {
        assert.equal(tool, 'ask_user');
        const f = fixture(form);
        assert.equal((await f.reply({ action: 'submit', answers: { selectedIds: null } })).accepted, false);
        assert.equal(f.api.get({ sessionId: 's1' }).waiting, true);
        assert.equal((await f.reply({ action: 'submit', answers: {} })).accepted, true);
        return f.resolved[0].payload;
      });
    assert.deepEqual(result, { selectedIds: [], selectedItems: [], totalItems: 1 });
  }
});

test('ordinary confirm/reject resolve only the addressed live wait', async () => {
  const f = fixture({}); assert.equal(f.api.get({ sessionId: 's1' }).kind, 'confirmation');
  assert.deepEqual(f.api.get({ sessionId: 's1' }).responseTemplate, { sessionId: 's1', waitId: 'w1', action: 'approve' });
  assert.equal((await f.reply({ action: 'submit', answers: {} })).code, 'INVALID_ACTION');
  assert.equal((await f.reply({ action: 'approve' })).accepted, true);
  const g = fixture({}); assert.equal((await g.reply({ action: 'reject' })).reason, 'cancelled');
  assert.equal(g.rejected.length, 1); assert.equal(g.resolved.length, 0);
});

test('native Chrome permission keeps task paused through new and legacy entry points', async () => {
  const f = fixture({ browserPermission: 'history' });
  assert.equal(f.api.get({ sessionId: 's1' }).kind, 'browser_permission');
  const input = f.api.get({ sessionId: 's1' });
  assert.equal(input.requiresUserAction, true);
  assert.match(input.instructions, /side panel.*Chrome/);
  assert.equal(input.responseTemplate, undefined);
  for (const response of [() => f.reply({ action: 'approve' }), () => f.api.continueWait({ sessionId: 's1', waitId: 'w1' }), () => f.api.submitWaitForm({ sessionId: 's1', waitId: 'w1', answers: {} })]) {
    const result = await response(); assert.equal(result.accepted, false); assert.equal(f.resolved.length, 0);
  }
  const pending = await f.reply({ action: 'approve' }); assert.equal(pending.requiresUserAction, true); assert.match(pending.message, /side panel.*Chrome/);
  f.permissions.granted = true; assert.equal((await f.api.continueWait({ sessionId: 's1', waitId: 'w1' })).accepted, true);
});

test('permission check failure and cancellation/new run during check cannot resume task', async () => {
  const f = fixture({ browserPermission: 'history' }); f.permissions.check = async () => { throw new Error('Chrome unavailable'); };
  assert.equal((await f.reply({ action: 'approve' })).requiresUserAction, true);
  f.permissions.check = async () => { f.replace(); return true; };
  assert.equal((await f.reply({ action: 'approve' })).stale, true); assert.equal(f.resolved.length, 0);
});

test('location uses versioned explicit consent; legacy continue cannot grant it', async () => {
  const f = fixture({ locationConsent: true }); const input = f.api.get({ sessionId: 's1' });
  assert.deepEqual(input.responseTemplate, { sessionId: 's1', waitId: 'w1', action: 'approve', consentVersion: 1 });
  assert.equal(input.consentVersion, 1); assert.equal(input.message, 'Full disclosure');
  assert.equal((await f.api.continueWait({ sessionId: 's1', waitId: 'w1' })).requiresUserAction, true);
  assert.equal(f.consents.length, 0);
  assert.equal((await f.reply({ action: 'approve', consentVersion: 0 })).accepted, false);
  assert.equal((await f.reply({ action: 'approve', consentVersion: input.consentVersion })).accepted, true);
  assert.deepEqual(f.consents, [['w1', 's1', 1]]);
});

test('location persistence failure/reject preserve correctness; saved UI consent can continue', async () => {
  const f = fixture({ locationConsent: true }); f.permissions.save = async () => { throw new Error('Disk error'); };
  assert.equal((await f.reply({ action: 'approve', consentVersion: 1 })).code, 'LOCATION_CONSENT_FAILED');
  assert.equal(f.resolved.length, 0); assert.equal(f.api.get({ sessionId: 's1' }).waiting, true);
  f.permissions.accepted = true; assert.equal((await f.api.continueWait({ sessionId: 's1', waitId: 'w1' })).accepted, true);
  const g = fixture({ locationConsent: true }); assert.equal((await g.reply({ action: 'reject' })).accepted, true); assert.equal(g.consents.length, 0);
});

test('concurrent approvals settle a native wait at most once', async () => {
  const f = fixture({ browserPermission: 'history' }); f.permissions.granted = true;
  const results = await Promise.all([f.reply({ action: 'approve' }), f.reply({ action: 'approve' })]);
  assert.equal(results.filter(result => result.accepted).length, 1); assert.equal(f.resolved.length, 1);
});

test('cancelled connection cannot submit, approve or reject a pending wait', async () => {
  for (const method of ['respond', 'continueWait', 'submitWaitForm', 'cancelWait']) {
    const f = fixture(), controller = new AbortController(); controller.abort(new Error('disconnected'));
    await assert.rejects(f.api[method]({ sessionId: 's1', waitId: 'w1', action: 'submit', answers: valid }, controller.signal), /disconnected/);
    assert.equal(f.api.get({ sessionId: 's1' }).waiting, true);
    assert.equal(f.resolved.length + f.rejected.length, 0);
  }
});

test('connection cancellation during permission or consent checks leaves the wait pending', async () => {
  for (const kind of ['permission', 'savedConsent', 'newConsent']) {
    const f = fixture(kind === 'permission' ? { browserPermission: 'history' } : { locationConsent: true });
    const controller = new AbortController(); let release, receivedSignal;
    const gate = new Promise(resolve => { release = resolve; });
    if (kind === 'permission') f.permissions.check = () => gate;
    else if (kind === 'savedConsent') f.permissions.read = () => gate;
    else f.permissions.save = (_wait, _session, _version, signal) => { receivedSignal = signal; return gate; };
    const method = kind === 'savedConsent' ? 'continueWait' : 'respond';
    const pending = f.api[method]({ sessionId: 's1', waitId: 'w1', action: 'approve', consentVersion: 1 }, controller.signal);
    controller.abort(new Error('connection replaced')); release(true);
    await assert.rejects(pending, /connection replaced/);
    if (kind === 'newConsent') assert.equal(receivedSignal, controller.signal);
    assert.equal(f.resolved.length, 0); assert.equal(f.api.get({ sessionId: 's1' }).waiting, true);
  }
});
