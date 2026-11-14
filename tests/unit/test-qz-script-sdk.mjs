import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzSdk } from '../../src/shared/qz-script-sdk.js';
import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { runInnerWorker } from '../support/inner-runner-fixture.mjs';

const fixture = (execute = async () => ({})) => {
  const calls = [];
  return { calls, qz: createQzSdk((name, args) => {
    calls.push({ name, args });
    return execute(name, args);
  }) };
};

test('locators are lazy immutable queries and dispatch a single strict action', async () => {
  const { qz, calls } = fixture();
  const query = { role: 'option', name: '杭州大厦' };
  const page = qz.tab('map');
  const options = page.locator(query);
  const second = options.nth(1);
  query.name = 'changed';
  assert.equal(calls.length, 0);
  await options.click();
  await second.click();
  await page.locator('css:input').fill('杭州大厦');
  assert.deepEqual(calls, [
    { name: 'act_on_element', args: { tabRef: 'map', locator: { role: 'option', name: '杭州大厦' }, action: 'click' } },
    { name: 'act_on_element', args: { tabRef: 'map', locator: { role: 'option', name: '杭州大厦', nth: 1 }, action: 'click' } },
    { name: 'act_on_element', args: { tabRef: 'map', locator: { target: 'css:input' }, action: 'fill', value: '杭州大厦' } },
  ]);
});

test('Tab observations bind their explicit reference once and reject missing or invalid references', async () => {
  const { qz, calls } = fixture();
  for (const tabRef of ['map', 42]) {
    const observation = { tabRef, title: 'Map', url: 'https://fixture.test/map', active: true };
    const page = qz.tab(observation);
    observation.tabRef = 'changed';
    assert.equal(page.tabRef, tabRef);
    await page.read();
  }
  assert.deepEqual(calls.map(call => call.args.tabRef), ['map', 42]);
  for (const input of [null, [], {}, { id: 42 }, { tabRef: undefined }, { tabRef: null },
    { tabRef: '' }, { tabRef: ' ' }, { tabRef: 0 }, { tabRef: -1 }, { tabRef: 1.5 }, { tabRef: {} }]) {
    assert.throws(() => qz.tab(input), { code: 'INVALID_ARGUMENTS' });
  }
  assert.equal(calls.length, 2);
});

test('CSS shorthand becomes a canonical locator while retaining qualifiers and strict validation', async () => {
  const { qz, calls } = fixture();
  const page = qz.tab('form');
  const query = Object.freeze({ css: 'input, textarea', role: 'textbox', name: 'Search', exact: false, within: 'css:form', nth: 1 });
  await page.locator(query).fill('query');
  const expected = { name: 'act_on_element', args: {
    tabRef: 'form', action: 'fill', value: 'query', locator: {
      target: 'css:input, textarea', role: 'textbox', name: 'Search', exact: false, within: 'css:form', nth: 1,
    },
  } };
  assert.deepEqual(calls, [expected]);
  const { within, ...legacyQuery } = query;
  await page.locator({ ...legacyQuery, scope: within }).fill('query');
  assert.deepEqual(calls[1], expected, 'the retired scope spelling resolves to within');
  calls.length = 1;
  assert.equal(query.css, 'input, textarea');
  for (const input of [
    { css: '#search', target: 'css:#search' }, { css: '#search', target: undefined },
    ...[undefined, null, '', ' ', 1, [], {}].map(css => ({ css })),
    { css: '#search', exact: 'yes' }, { css: '#search', nth: -1 }, { css: '#search', within: 1 },
  ]) assert.throws(() => page.locator(input), { code: 'INVALID_ARGUMENTS' });
  assert.equal(calls.length, 1, 'invalid locators never dispatch');
});

test('bound calls reject changes to page, query and positional arguments before dispatch', () => {
  const { qz, calls } = fixture();
  const page = qz.tab('map'), input = page.locator('css:input');
  for (const invoke of [
    () => page.goto('/next', { tabRef: 'other' }),
    () => page.goto('/next', { url: '/override' }),
    () => page.read({ tabId: 8 }),
    () => page.evaluate('() => 1', null, { code: '() => 2' }),
    () => input.click({ target: 'css:button' }),
    () => input.click({ css: 'button' }),
    () => input.click({ locator: { role: 'button' } }),
    () => input.click({ action: 'fill' }),
    () => input.fill('safe', { value: 'other' }),
    () => input.wait({ index: 3 }),
    () => input.read({ source: 'body' }),
    () => input.click({ waitFor: 'stable' }),
    () => input.click({ waitOptions: { timeout: 3 } }),
    () => input.click({ waitFor: 'navigation', waitOptions: { trigger: {} } }),
    () => input.click({ waitFor: 'popup', waitOptions: { tabRef: 'other' } }),
    () => qz.tab(undefined),
    () => page.locator({}),
    () => input.nth(-1),
    () => input.click({ expect: 'stable' }),
    () => input.click({ tabAlias: 'other' }),
    () => input.click({ submit: true }),
    () => input.click({ force: true }),
    () => input.fill(undefined),
    () => input.press(13),
    () => input.scrollIntoView({ direction: 'down' }),
    () => page.scroll({ locator: { role: 'list' } }),
  ]) assert.throws(invoke, { code: 'INVALID_ARGUMENTS' });
  assert.equal(calls.length, 0);
});

test('unknown locator keys identify the invalid input and supported fields without dispatching', () => {
  const { qz, calls } = fixture();
  assert.throws(() => qz.tab('page').locator({ cs: '#search', timeout: 2 }), error => {
    assert.equal(error.code, 'INVALID_ARGUMENTS');
    assert.match(error.message, /"cs", "timeout"/);
    assert.match(error.message, /Supported fields: target, role, name, text, exact, within, nth/);
    assert.equal(error.hint, undefined);
    assert.deepEqual(error.details, {
      invalidFields: ['cs', 'timeout'], allowedFields: ['target', 'role', 'name', 'text', 'exact', 'within', 'nth', 'includeHidden'],
    });
    return true;
  });
  assert.equal(calls.length, 0, 'unsupported keys never silently select a different element');
});

test('URL waits preserve string patterns and lower RegExp source and flags without mutable matcher state', async () => {
  const { qz, calls } = fixture();
  const page = qz.tab('page');
  await page.waitForURL('^https://example\\.test/Done$', { flags: 'i', timeout: 3 });
  const pattern = /^https:\/\/example\.test\/Done$/ig;
  pattern.lastIndex = 7;
  await page.waitForURL(pattern, { timeout: 4 });
  assert.deepEqual(calls, [
    { name: 'wait_for_url', args: { tabRef: 'page', urlPattern: '^https://example\\.test/Done$', flags: 'i', timeout: 3 } },
    { name: 'wait_for_url', args: { tabRef: 'page', urlPattern: pattern.source, flags: 'gi', timeout: 4 } },
  ]);
  assert.equal(pattern.lastIndex, 7);
  assert.throws(() => page.waitForURL(pattern, { flags: 'i' }), { code: 'INVALID_ARGUMENTS', message: /flags/ });
  assert.throws(() => page.waitForURL(pattern, { urlPattern: 'other' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => page.waitForURL({ source: 'done', flags: 'i' }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(calls.length, 2);
});

test('find resolves to a plain Array of every match while raw tools keep query metadata', async () => {
  const elements = [{ target: 'uid:t1.snap.1', name: 'First' }, { target: 'uid:t1.snap.2', name: 'Second' }];
  const raw = { results: elements.slice(0, 1), total: 2, truncated: true, limit: 1, searched: 9 };
  const { qz, calls } = fixture(async (name, args) => name === 'find_elements' ? raw
    : { results: args.pattern === 'missing' ? [] : elements });
  const page = qz.tab('page');
  const found = await page.find({ role: 'link' });
  assert.equal(Array.isArray(found), true);
  assert.deepEqual(found, elements);
  assert.deepEqual(found.slice(0, 1).map(element => element.name), ['First']);
  assert.deepEqual([...found].map(element => element.target), ['uid:t1.snap.1', 'uid:t1.snap.2']);
  assert.deepEqual(JSON.parse(JSON.stringify(found)), elements);
  assert.deepEqual(await page.find({ pattern: 'missing' }), []);
  assert.equal(await qz.call('find_elements', { tabRef: 'page', role: 'link', limit: 1 }), raw);
  assert.throws(() => page.find({ countOnly: true }), { code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(calls.map(call => call.name), ['find_all_elements', 'find_all_elements', 'find_elements'],
    'count-only requests must use locator.count or the raw tool');
  assert.deepEqual(calls[0].args, { tabRef: 'page', role: 'link' }, 'find sends no result limit');
});

test('find preserves string filters and serializes RegExp without mutating caller options or matcher state', async () => {
  const { qz, calls } = fixture(async () => ({ results: [] }));
  const page = qz.tab('page');
  await page.find({ pattern: '^Download$', flags: 'i', role: 'link' });
  const pattern = /^下载\s+report$/giu;
  pattern.lastIndex = 7;
  const filters = Object.freeze({ pattern, role: 'button', limit: 3 });
  await page.find(filters);
  assert.deepEqual(calls, [
    { name: 'find_all_elements', args: { tabRef: 'page', pattern: '^Download$', flags: 'i', role: 'link' } },
    { name: 'find_all_elements', args: { tabRef: 'page', pattern: pattern.source, flags: 'giu', role: 'button', limit: 3 } },
  ]);
  assert.equal(filters.pattern, pattern);
  assert.equal(pattern.lastIndex, 7);
  for (const flags of ['i', '', undefined]) {
    assert.throws(() => page.find({ pattern, flags }), { code: 'INVALID_ARGUMENTS', message: /flags/ });
  }
  assert.equal(calls.length, 2, 'conflicting regex flags fail before dispatch');
});

test('scroll names separate page scrolling from bringing an element into view', async () => {
  const { qz, calls } = fixture();
  const page = qz.tab('feed');
  const item = page.locator({ role: 'article', nth: 2 });
  await page.scroll({ direction: 'down', pixels: 600 });
  await item.scrollIntoView();
  await item.scroll();
  await item.screenshot();
  await item.axTree({ maxDepth: 2 });
  assert.deepEqual(calls, [
    { name: 'scroll_page', args: { tabRef: 'feed', direction: 'down', pixels: 600 } },
    { name: 'act_on_element', args: { tabRef: 'feed', locator: { role: 'article', nth: 2 }, action: 'scroll' } },
    { name: 'act_on_element', args: { tabRef: 'feed', locator: { role: 'article', nth: 2 }, action: 'scroll' } },
    { name: 'screenshot', args: { tabRef: 'feed', locator: { role: 'article', nth: 2 } } },
    { name: 'get_ax_tree', args: { tabRef: 'feed', maxDepth: 2, locator: { role: 'article', nth: 2 } } },
  ]);
});

test('drag binds both ends on the same explicit page', async () => {
  const { qz, calls } = fixture();
  const source = qz.tab('board').locator({ role: 'listitem', name: 'Task' });
  const destination = qz.tab('board').locator('css:#done');
  await source.dragTo(destination);
  assert.deepEqual(calls[0].args.destination, { locator: { target: 'css:#done' } });
  assert.throws(() => source.dragTo(qz.tab('other').locator('css:#done')), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => source.dragTo({}), { code: 'INVALID_ARGUMENTS' });
  assert.equal(calls.length, 1);
});

test('event actions compile one armed trigger and preserve the waited business value', async () => {
  const popup = { tabRef: 'receipt', url: 'https://fixture.test/receipt', title: 'Receipt', active: false };
  const { qz, calls } = fixture(async () => popup);
  const button = qz.tab('checkout').locator('uid:t1.snap.1');
  const value = await button.click({ timeout: 7, expect: 'popup', tabAlias: 'receipt' });
  assert.equal(value, popup);
  const expected = { name: 'wait_for_popup', args: {
    tabRef: 'checkout', timeout: 7, tabAlias: 'receipt', trigger: {
      name: 'act_on_element', args: { tabRef: 'checkout', locator: { target: 'uid:t1.snap.1' }, action: 'click', timeout: 7 },
    },
  } };
  assert.deepEqual(calls, [expected]);
  await button.click({ timeout: 7, waitFor: 'popup', waitOptions: { tabAlias: 'receipt' } });
  assert.deepEqual(calls[1], expected, 'the retired waitFor and waitOptions spelling compiles to the same call');
});

test('counts, zero-count waits and reads retain their distinct backend semantics', async () => {
  const { qz, calls } = fixture(async name => name === 'find_elements' ? { count: 3 } : { state: 'ready' });
  const rows = qz.tab('orders').locator({ role: 'row', within: 'css:#orders' });
  assert.equal(await rows.count(), 3);
  await rows.wait({ count: 0, timeout: 2 });
  await rows.nth(0).read({ limit: 1500 });
  assert.equal(calls[0].args.countOnly, true);
  assert.equal(calls[1].args.count, 0);
  assert.equal(calls[1].args.state, undefined);
  assert.equal(calls[2].args.source, 'target');
  assert.equal(calls[2].args.locator.nth, 0);
  assert.equal(calls[2].args.limit, 1500);
});

test('SDK calls retain native concurrency and propagate errors without retries', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const failure = Object.assign(new Error('Not unique'), { code: 'ELEMENT_AMBIGUOUS', hint: 'Narrow the locator.' });
  const { qz, calls } = fixture((name, args) => args.tabRef === 'slow' ? held : Promise.reject(failure));
  const slow = qz.tab('slow').read();
  const fast = qz.tab('fast').locator('css:button').click();
  assert.equal(slow instanceof Promise, true);
  assert.equal(calls.length, 2);
  await assert.rejects(Promise.all([slow, fast]), error => error === failure);
  release({ text: 'finished' });
  assert.deepEqual(await slow, { text: 'finished' });
  assert.equal(calls.length, 2);
});

for (const mode of ['development', 'production']) {
  test(`${mode}: actual Worker exposes qz and retains legacy tools and function serialization`, async () => {
    const compiled = await compileInnerWorker({ mode });
    const calls = [];
    const { result } = await runInnerWorker(compiled, `
      const page = qz.tab("map");
      await page.locator({role:"option",name:"杭州大厦"}).click();
      const title = await page.evaluate(() => document.title);
      await page.waitForURL(/#done$/i, {timeout:2});
      const pattern = /^Download$/gi; pattern.lastIndex = 7;
      const found = await page.find({pattern,role:"button"});
      await tools.legacy({value:1});
      trace("selected");
      return {title, count: await page.locator({role:"option"}).count(), isArray: Array.isArray(found), found: found.slice(0,1).map(element => element.target), lastIndex: pattern.lastIndex};
    `, { strictResult: true, onMessage(message, reply) {
      if (message.type !== 'tool_call') return;
      calls.push(message);
      reply({ type: 'tool_response', callId: message.callId, response: { ok: true, result:
        message.toolName === 'evaluate' ? 'Map' : message.toolName === 'find_elements' ? { count: 4 }
          : message.toolName === 'find_all_elements' ? { results: [{ target: 'uid:t1.snap.1' }, { target: 'uid:t1.snap.2' }] } : {} } });
    } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { title: 'Map', count: 4, isArray: true, found: ['uid:t1.snap.1'], lastIndex: 7 });
    assert.deepEqual(result.trace.map(row => row.message), ['selected']);
    assert.deepEqual(calls.map(call => call.toolName), ['act_on_element', 'evaluate', 'wait_for_url', 'find_all_elements', 'legacy', 'find_elements']);
    assert.equal(typeof calls[1].args.code, 'string');
    assert.match(calls[1].args.code, /document.title/);
    assert.deepEqual(calls[2].args, { tabRef: 'map', urlPattern: '#done$', flags: 'i', timeout: 2 });
    assert.deepEqual(calls[3].args, { tabRef: 'map', pattern: '^Download$', flags: 'gi', role: 'button' });

    const returned = await runInnerWorker(compiled, 'return await qz.tab("map").find({role:"button"});', {
      strictResult: true, onMessage(message, reply) {
        if (message.type === 'tool_call') reply({ type: 'tool_response', callId: message.callId, response: { ok: true,
          result: { results: [{ target: 'uid:t1.snap.1' }, { target: 'uid:t1.snap.2' }, { target: 'uid:t1.snap.3' }] } } });
      } });
    assert.equal(returned.result.ok, true);
    assert.deepEqual(returned.result.result, [{ target: 'uid:t1.snap.1' }, { target: 'uid:t1.snap.2' }, { target: 'uid:t1.snap.3' }],
      'a returned find result is the element array through script serialization');

    const conflictingPattern = await runInnerWorker(compiled,
      'return qz.tab("map").find({pattern:/download/i,flags:"i"});', { strictResult: true });
    assert.equal(conflictingPattern.result.code, 'INVALID_ARGUMENTS');
    assert.equal(conflictingPattern.events.some(event => event.type === 'tool_call'), false);

    const popupCalls = [];
    const popupRun = await runInnerWorker(compiled, `
      const popup = qz.tab(await qz.tab("portal").locator({css:"a.item"}).click({expect:"popup"}));
      return await popup.read({limit:200});
    `, { strictResult: true, onMessage(message, reply) {
      if (message.type !== 'tool_call') return;
      popupCalls.push({ name: message.toolName, args: message.args });
      reply({ type: 'tool_response', callId: message.callId, response: { ok: true, result:
        message.toolName === 'wait_for_popup'
          ? { tabRef: 42, title: 'Item', url: 'https://fixture.test/item', active: false }
          : { text: 'In stock' } } });
    } });
    assert.equal(popupRun.result.ok, true);
    assert.deepEqual(popupRun.result.result, { text: 'In stock' });
    assert.deepEqual(popupCalls, [
      { name: 'wait_for_popup', args: { tabRef: 'portal', trigger: {
        name: 'act_on_element', args: { tabRef: 'portal', locator: { target: 'css:a.item' }, action: 'click' },
      } } },
      { name: 'read_article', args: { tabRef: 42, limit: 200 } },
    ]);

    const invalidLocator = await runInnerWorker(compiled, 'return qz.tab("map").locator({cs:"#search"});', { strictResult: true });
    assert.equal(invalidLocator.result.code, 'INVALID_ARGUMENTS');
    assert.deepEqual(invalidLocator.result.details.invalidFields, ['cs']);
    assert.ok(invalidLocator.result.details.allowedFields.includes('target'));
    assert.equal(invalidLocator.result.hint, undefined);

    for (const source of [
      'return await qz.call("wait_for_url", {tabRef:"map",urlPattern:/done/i});',
      'return await qz.call("find_elements", {tabRef:"map",pattern:/download/i});',
      'return /done/i;',
    ]) {
      const rejected = await runInnerWorker(compiled, source, { strictResult: true });
      assert.equal(rejected.result.code, 'SCRIPT_VALUE_NOT_SERIALIZABLE');
      assert.match(rejected.result.error, /Pass or return JSON values/);
      assert.equal(rejected.result.hint, undefined);
      assert.equal(rejected.events.some(event => event.type === 'tool_call'), false, 'only typed SDK pattern arguments serialize RegExp');
    }
  });
}
