import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { compileScriptToolHost } from '../support/script-runtime-fixture.mjs';
import { safeValueForMessage, installSecurityGuards } from '../../src/shared/script-runtime.js';

const rules = [
  { action: 'block', type: 'domain', value: 'blocked.test' },
  { action: 'allow', type: 'pattern', value: 'https://blocked.test/allowed/*' },
];

async function fixture(mode) {
  const calls = [];
  const fetch = function(...args) { calls.push({ kind: 'fetch', receiver: this, args }); return Promise.resolve('fetched'); };
  class XMLHttpRequest { open(...args) { calls.push({ kind: 'xhr', receiver: this, args }); return 'opened'; } }
  const navigator = { sendBeacon(...args) { calls.push({ kind: 'beacon', receiver: this, args }); return true; } };
  const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, () => {}]));
  const context = createContext({ URL, TransformStream, TextEncoder, TextDecoder, fetch, XMLHttpRequest, navigator, console, setTimeout, clearTimeout,
    location: { href: 'https://blocked.test/current' },
    chrome: { storage: { local: { get: async () => ({ securityGuardrails: { rules } }) } }, scripting: { executeScript: async options => { calls.push({ kind: 'bridge', files: options.files }); return []; } } },
  });
  runInContext('globalThis.window = globalThis; globalThis.document = {};', context);
  runInContext(await compileScriptToolHost(mode), context);
  const definitions = new Map();
  const { createScriptTools, ToolExecutionError } = context.QZ_SCRIPT_TEST;
  createScriptTools({ registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
    skills: { loadScript: async () => null }, scriptTimeoutProperty: { type: 'number' }, evaluateCdpScript: async (_tab, { expression }) => {
      return { result: { type: 'object', value: await runInContext(expression, context) } };
    },
  });
  const originals = { fetch, open: XMLHttpRequest.prototype.open, beacon: navigator.sendBeacon, console: { ...console } };
  return {
    context, calls,
    run: (code, options = {}) => definitions.get('run_script').execute({ code, target: 'page', tabId: 7, timeout: 5, ...options }, undefined, { sessionId: 'task', runId: 'run' }),
    restored() {
      assert.equal(context.fetch, originals.fetch);
      assert.equal(XMLHttpRequest.prototype.open, originals.open);
      assert.equal(navigator.sendBeacon, originals.beacon);
      for (const level of Object.keys(console)) assert.equal(console[level], originals.console[level]);
    },
  };
}

for (const mode of ['development', 'production']) {
  test(`${mode}: input-only scripts use the no-bridge path and missing tools never replay side effects`, async () => {
    const f = await fixture(mode);
    const result = await f.run('async () => input.value + args.extra', { args: { value: 4, extra: 8 } });
    assert.equal(result.result, 12); assert.equal(result.ok, true);
    assert.equal(f.calls.filter(c => c.kind === 'bridge').length, 0);
    runInContext('globalThis.attempts = 0; globalThis.missingTools = () => tools.$list();', f.context);
    const failed = await f.run('async () => { globalThis.attempts++; return globalThis.missingTools(); }');
    assert.equal(failed.code, 'RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
    assert.equal(failed.details.automaticReplay, false);
    assert.equal(failed.details.mayHaveTakenEffect, true);
    assert.match(failed.diagnostic.suggestedNextStep, /tools\.name/);
    assert.equal(f.context.attempts, 1);
    assert.equal(f.calls.filter(c => c.kind === 'bridge').length, 0);
    const shape = await f.run('async () => { globalThis.shapeAttempts = (globalThis.shapeAttempts || 0) + 1; throw new Error("Illegal return statement"); }');
    assert.equal(shape.ok, false); assert.equal(f.context.shapeAttempts, 1, 'a runtime error is not a compile-time shape retry');
    const bridged = await f.run('async () => typeof tools.$list');
    assert.equal(bridged.result, 'function');
    assert.equal(f.calls.filter(c => c.kind === 'bridge').length, 1);
    f.restored();
  });

  test(`${mode}: actual page expression serializes cyclic, exceptional and binary values`, async () => {
    const f = await fixture(mode);
    const envelope = await f.run(`async () => {
      const cycle = { label: 'cycle' }; cycle.self = cycle;
      let deep = { leaf: true }; for (let i = 0; i < 10; i++) deep = { next: deep };
      const error = Object.assign(new TypeError('invalid sample'), { code: 'SAMPLE', details: { count: 3 }, diagnostic: { retry: false } });
      const getter = { get denied() { throw new Error('getter denied'); } };
      const proxy = new Proxy({}, { ownKeys() { throw new Error('keys denied'); } });
      const shared = { value: 5 };
      return {
        fn: function named() {}, symbol: Symbol('sample'), bigint: 9007199254740993n,
        infinity: Infinity, nan: NaN, missing: undefined,
        date: new Date('2026-07-09T00:00:00Z'), invalidDate: new Date('invalid'), regexp: /sample/gi,
        url: new URL('https://example.test/a'), cycle, deep, error, getter, proxy,
        map: new Map([['key', shared], [shared, new Set([1, 2])]]), set: new Set(['a', 'b']), repeated: [shared, shared],
        bytes: new Uint8Array(Array.from({ length: 40 }, (_, i) => i)), bigints: new BigInt64Array([1n, 2n]),
        view: new DataView(new ArrayBuffer(4)), buffer: new ArrayBuffer(9), global: globalThis, document,
      };
    }`);
    assert.equal(envelope.ok, true, envelope.error);
    const value = structuredClone(envelope.result);
    assert.deepEqual(value.fn, { __qz_uncloneable: 'function', name: 'named' });
    assert.deepEqual(value.symbol, { __qz_uncloneable: 'symbol', description: 'Symbol(sample)' });
    assert.equal(value.bigint, '9007199254740993');
    assert.equal(value.infinity, 'Infinity'); assert.equal(value.nan, 'NaN');
    assert.ok(Object.hasOwn(value, 'missing')); assert.equal(value.missing, undefined);
    assert.equal(value.date, '2026-07-09T00:00:00.000Z'); assert.equal(value.invalidDate, '');
    assert.equal(value.regexp, '/sample/gi'); assert.equal(value.url, 'https://example.test/a');
    assert.deepEqual(value.cycle.self, { __qz_circular: true });
    let deepest = value.deep; for (let depth = 1; depth < 8; depth++) deepest = deepest.next;
    assert.deepEqual(deepest, { __qz_truncated: true, type: 'Object' });
    assert.equal(value.error.name, 'TypeError'); assert.equal(value.error.message, 'invalid sample');
    assert.equal(value.error.code, 'SAMPLE'); assert.deepEqual(value.error.details, { count: 3 });
    assert.deepEqual(value.error.diagnostic, { retry: false }); assert.match(value.error.stack, /TypeError: invalid sample/);
    assert.deepEqual(value.getter.denied, { __qz_uncloneable: 'property', error: 'getter denied' });
    assert.deepEqual(value.proxy, { __qz_uncloneable: 'object', type: 'Object', error: 'keys denied' });
    assert.deepEqual(value.map, { __qz_type: 'Map', entries: [['key', { value: 5 }], [{ value: 5 }, { __qz_type: 'Set', values: [1, 2] }]] });
    assert.deepEqual(value.set, { __qz_type: 'Set', values: ['a', 'b'] });
    assert.deepEqual(value.repeated, [{ value: 5 }, { value: 5 }]);
    assert.deepEqual(value.bytes, { __qz_type: 'Uint8Array', length: 40, sample: Array.from({ length: 32 }, (_, i) => i) });
    assert.deepEqual(value.bigints, { __qz_type: 'BigInt64Array', length: 2, sample: [1, 2] });
    assert.deepEqual(value.view, { __qz_type: 'DataView', length: 4, sample: [] });
    assert.deepEqual(value.buffer, { __qz_type: 'ArrayBuffer', byteLength: 9 });
    assert.deepEqual(value.global, { __qz_uncloneable: 'global' });
    assert.deepEqual(value.document, { __qz_uncloneable: 'global' });
    f.restored();
  });

  test(`${mode}: page guards block each request surface, honor allow patterns and restore originals`, async () => {
    const f = await fixture(mode);
    const blocked = [
      ['fetch', 'await fetch("https://blocked.test/private")'],
      ['fetch', 'await fetch(new URL("https://child.blocked.test/private"))'],
      ['fetch', 'await fetch({ url: "https://blocked.test/private" })'],
      ['fetch', 'await fetch("/private")'],
      ['XMLHttpRequest.open', 'new XMLHttpRequest().open("GET", "https://blocked.test/private", false)'],
      ['navigator.sendBeacon', 'navigator.sendBeacon("https://blocked.test/private", "body")'],
    ];
    for (const [source, call] of blocked) {
      const result = await f.run(`async () => { ${call}; return 'escaped'; }`);
      assert.equal(result.ok, false, call);
      assert.equal(result.code, 'SECURITY_GUARDRAIL_BLOCKED', call);
      assert.match(result.error, /安全护栏已阻止 run_script 访问 blocked\.test 及其子域名。/);
      assert.equal(result.details.source, source);
      assert.equal(f.calls.length, 0, 'blocked requests must not invoke the original transport');
      f.restored();
    }
    const result = await f.run(`async () => {
      const fetched = await fetch(new URL('https://blocked.test/allowed/fetch'), { method: 'POST' });
      const xhr = new XMLHttpRequest(); const opened = xhr.open('POST', 'https://blocked.test/allowed/xhr', false, 'user', 'pass');
      const beacon = navigator.sendBeacon('https://blocked.test/allowed/beacon', 'payload');
      await fetch('https://unrelated.test/free');
      return { fetched, opened, beacon };
    }`);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(structuredClone(result.result), { fetched: 'fetched', opened: 'opened', beacon: true });
    assert.deepEqual(f.calls.map(call => call.kind), ['fetch', 'xhr', 'beacon', 'fetch']);
    assert.equal(f.calls[0].args[0].href, 'https://blocked.test/allowed/fetch');
    assert.equal(f.calls[0].args[1].method, 'POST');
    assert.deepEqual(f.calls[1].args, ['POST', 'https://blocked.test/allowed/xhr', false, 'user', 'pass']);
    assert.equal(f.calls[1].receiver instanceof f.context.XMLHttpRequest, true);
    assert.equal(f.calls[2].receiver, f.context.navigator);
    assert.deepEqual(f.calls[2].args, ['https://blocked.test/allowed/beacon', 'payload']);
    f.restored();
    assert.equal((await f.run(`async () => { throw new Error('application failure'); }`)).ok, false);
    f.restored();
  });
}


test('shared runtime preserves page and inner compatibility differences', async () => {
  const names = ['self', 'location', 'fetch', 'XMLHttpRequest', 'navigator'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = [];
  const fetch = (...values) => { calls.push(['fetch', values]); return Promise.resolve('allowed'); };
  class XMLHttpRequest { open(...values) { calls.push(['xhr', values]); return 'opened'; } }
  const navigator = { sendBeacon: url => { calls.push(['beacon', url]); return true; } };
  let restore;
  try {
    for (const [name, value] of Object.entries({ self: globalThis, location: { href: 'https://blocked.test/' }, fetch, XMLHttpRequest, navigator })) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const bytes = new Uint8Array([1, 2, 3]);
    bytes.slice = () => new Uint8Array([9]);
    assert.deepEqual(safeValueForMessage(bytes, 'page').sample, [9], 'page retains the existing slice-based sampling contract');
    assert.deepEqual(safeValueForMessage(bytes, 'inner').sample, [1, 2, 3], 'inner reads typed indices independently of an overridden slice');
    const getter = { get denied() { throw { message: 'plain failure' }; } };
    for (const world of ['page', 'inner']) {
      assert.deepEqual(safeValueForMessage(getter, world), { denied: { __qz_uncloneable: 'property', error: 'plain failure' } });
      assert.deepEqual(safeValueForMessage(globalThis, world), { __qz_uncloneable: 'global' });
    }
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalBeacon = navigator.sendBeacon;
    restore = installSecurityGuards({ rules });
    for (const request of [() => globalThis.fetch('/private'), () => new XMLHttpRequest().open('GET', '/private')]) {
      assert.throws(request, error => error.code === 'SECURITY_GUARDRAIL_BLOCKED' && /run_script inner/.test(error.message));
    }
    assert.equal(calls.length, 0);
    assert.equal(navigator.sendBeacon, originalBeacon, 'inner has no page beacon hook');
    assert.equal(navigator.sendBeacon('https://blocked.test/private'), true);
    assert.equal(await globalThis.fetch('https://blocked.test/allowed/item'), 'allowed');
    assert.equal(new XMLHttpRequest().open('GET', 'https://unrelated.test/free'), 'opened');
    assert.deepEqual(calls[2][1], ['GET', 'https://unrelated.test/free', true, undefined, undefined], 'inner retains its explicit XHR defaults');
    restore();
    assert.equal(globalThis.fetch, fetch);
    assert.equal(XMLHttpRequest.prototype.open, originalOpen);
  } finally {
    restore?.();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
