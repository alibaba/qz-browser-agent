import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { documentReadiness } from '../../src/shared/document-readiness.js';

for (const [name, readyState, navigation, expected] of [
  ['complete', 'complete', { domContentLoadedEventStart: 0 }, true],
  ['head still parsing', 'loading', undefined, false],
  ['deferred scripts pending', 'interactive', { domContentLoadedEventStart: 0 }, false],
  ['DOMContentLoaded started', 'interactive', { domContentLoadedEventStart: 10 }, true],
  ['missing navigation timing compatibility', 'interactive', undefined, true],
  ['missing event timestamp', 'interactive', {}, false],
]) test(`serialized document readiness: ${name}`, async () => {
  const listeners = [];
  const globals = {
    document: { readyState, addEventListener(type, listener, options) {
      assert.equal(type, 'DOMContentLoaded'); assert.equal(options.once, true);
      listeners.push(listener);
    } },
    performance: { getEntriesByType(type) {
      assert.equal(type, 'navigation'); return navigation ? [navigation] : [];
    } },
  };
  // Only browser globals and arguments survive executeScript's function serialization.
  const invoke = (...args) => runInNewContext(`(${documentReadiness.toString()})(...args)`, { ...globals, args });
  assert.equal(invoke(), expected);
  assert.equal(listeners.length, 0, 'presence probes never install a listener');
  const result = invoke('wait');
  if (expected) {
    assert.equal(result, true);
    assert.equal(listeners.length, 0, 'ready documents need no event wait');
  } else {
    let settled = false;
    result.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(listeners.length, 1);
    listeners[0]();
    assert.equal(await result, true, 'DOMContentLoaded suffices without a load event');
  }
});
