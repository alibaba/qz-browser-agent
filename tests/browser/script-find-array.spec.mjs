import { createServer } from 'node:http';
import { test, expect } from './fixtures.mjs';
import { callTool } from '../../services/mcp-bridge/src/client.mjs';
import { buildScriptRequest } from '../../services/mcp-bridge/src/script-call.mjs';

// 4000 matches leave room in the 5000-entry element reference capacity for the clicks' own references.
const ITEMS = 3997;
const LINKS = ITEMS + 3;

test('page.find returns every match as an Array in nth order while find_elements keeps its limit', async () => {
  test.setTimeout(240_000);
  const { launchIsolatedExtensionMcp } = await import('../support/isolated-extension-mcp.mjs');
  const items = Array.from({ length: ITEMS }, (_, index) => `<li><a href="/item/${index}">Item ${index}</a></li>`).join('');
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Links</title>
      <script>addEventListener('click', event => { event.preventDefault(); document.title = event.target.closest('a').getAttribute('href'); }, true);</script><nav><a href="/monthly">Monthly Report</a><a href="/report">Report</a>
      <a href="/archive">Report archive</a><a href="/hidden" hidden>Hidden Report</a><a href="/none" style="display:none">None</a></nav>
      <ul>${items}</ul>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let environment, sessionId;
  try {
    environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-find-array-' });
    ({ sessionId } = await callTool(environment.bridge.endpoint, 'qingzhou_create_drive_session', { title: 'Find array' }));
    await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', { sessionId, name: 'open_tab', args: { url, tabAlias: 'page' } });
    const run = async code => (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', buildScriptRequest({ sessionId, code, timeout: 200 }))).result;

    const large = await run(`
      const page = qz.tab('page');
      const query = {role:'link'};
      const started = Date.now();
      const links = await page.find(query);
      const ms = Date.now() - started;
      const limited = (await tools.find_elements({tabRef:'page', role:'link', limit:100})).results;
      const strip = ({ target, ...fields }) => fields;
      const domLine = async line => (await tools.read_dom({tabRef:'page', offset:line, limit:1})).content;
      const node = async locator => { const seen = await page.locator(locator).inspect(); return { target: seen.target, name: seen.name, href: seen.href }; };
      const clicked = async locator => { await page.locator(locator).click(); return page.evaluate(() => document.title); };
      const sampled = [0, 1, 4, Math.floor(links.length / 2), links.length - 1];
      const identity = [];
      for (const index of sampled) {
        identity.push({ index, name: links[index].name, href: links[index].href, byTarget: await node({target: links[index].target}),
          byNth: await node({...query, nth: index}), clickTarget: await clicked({target: links[index].target}), clickNth: await clicked({...query, nth: index}) });
      }
      const later = [await node({target: links[0].target}), await node({target: links[links.length - 1].target})];
      const hiddenLength = (await page.find({...query, includeHidden:true})).length;
      const again = await page.find(query);
      return {
        ms, isArray: Array.isArray(links), length: links.length, count: await page.locator(query).count(),
        hiddenLength, hiddenCount: await page.locator({...query, includeHidden:true}).count(),
        sliced: links.slice(0, 5).map(link => link.name), withTarget: links.filter(link => /^uid:/.test(link.target)).length,
        distinct: new Set(links.map(link => link.target)).size, identity, later: later.map(item => item.name),
        stable: again.length === links.length && again.every((link, index) => link.name === links[index].name && link.href === links[index].href),
        fields: ['line', 'lineRange', 'obscuredAtCenter', 'clickablePoint', 'inViewport', 'actionable'].filter(key => key in links[0] && key in links[links.length - 1]),
        lines: [await domLine(links[0].line), await domLine(links[links.length - 1].line)],
        parity: JSON.stringify(links.slice(0, limited.length).map(strip)) === JSON.stringify(limited.map(strip)) && limited.length === 100,
        iterated: (() => { let n = 0; for (const link of links) if (link.name) n++; return n; })(),
        shape: Object.keys(links[0]).filter(key => ['target', 'role', 'name', 'text', 'rect'].includes(key)).sort(),
        rect: Object.keys(links[0].rect).sort(), capped: (await page.find({...query, limit:3})).map(link => link.name),
        invalid: await Promise.all([0, -1, 1.5].map(limit => page.find({...query, limit}).then(() => 'accepted', error => error.code))),
      };
    `);
    expect(large.ok, JSON.stringify(large).slice(0, 2000)).toBe(true);
    const found = large.result;
    expect(found.isArray).toBe(true);
    expect(found.length).toBe(LINKS);
    expect(found.count).toBe(found.length);
    expect(found.iterated).toBe(found.length);
    expect(found.hiddenCount).toBe(LINKS + 2);
    expect(found.hiddenLength).toBe(found.hiddenCount);
    expect(found.sliced).toEqual(['Monthly Report', 'Report', 'Report archive', 'Item 0', 'Item 1']);
    expect(found.withTarget).toBe(found.length);
    expect(found.distinct).toBe(found.length);
    for (const { index, name, href, byTarget, byNth, clickTarget, clickNth } of found.identity) {
      expect(byTarget, `match ${index} resolves through its target`).toMatchObject({ name, href, target: expect.stringMatching(/^uid:/) });
      expect(byNth, `nth ${index} names the same link`).toMatchObject({ name, href });
      expect(new URL(href).pathname, `clicking match ${index} and nth ${index} hits the same element`).toBe(clickTarget);
      expect(clickNth).toBe(clickTarget);
    }
    expect(new Set(found.identity.map(item => item.clickTarget)).size).toBe(found.identity.length);
    expect(found.later).toEqual(['Monthly Report', `Item ${ITEMS - 1}`]);
    expect(found.stable).toBe(true);
    expect(found.fields).toEqual(['line', 'lineRange', 'obscuredAtCenter', 'clickablePoint', 'inViewport', 'actionable']);
    expect(found.lines[0]).toMatch(/^\d+: <a href="\/monthly">Monthly Report<\/a>$/);
    expect(found.lines[1]).toMatch(new RegExp(`^\\d+: <a href="/item/${ITEMS - 1}">Item ${ITEMS - 1}</a>$`));
    expect(found.parity, 'page.find elements carry the find_elements fields').toBe(true);
    expect(found.shape).toEqual(['name', 'rect', 'role', 'target', 'text']);
    expect(found.rect).toEqual(['height', 'width', 'x', 'y']);
    expect(found.capped).toEqual(['Monthly Report', 'Report', 'Report archive']);
    expect(found.invalid).toEqual(['INVALID_ARGUMENTS', 'INVALID_ARGUMENTS', 'INVALID_ARGUMENTS']);
    expect(found.ms, `page.find of ${found.length} links took ${found.ms} ms`).toBeLessThan(5_000);

    const ordered = await run(`
      const page = qz.tab('page');
      const query = {role:'link', text:'Report', exact:false};
      const found = await page.find(query);
      const nth = [];
      for (let index = 0; index < found.length; index++) nth.push((await page.locator({...query, nth:index}).inspect()).name);
      const pattern = await page.find({role:'link', pattern:/report/i, includeHidden:true});
      return { found: found.map(link => link.name), nth, pattern: pattern.map(link => new URL(link.href).pathname),
        none: await page.find({role:'link', name:'Missing'}) };
    `);
    expect(ordered).toMatchObject({ ok: true, result: {
      found: ['Report', 'Report archive', 'Monthly Report'],
      nth: ['Report', 'Report archive', 'Monthly Report'],
      pattern: ['/report', '/archive', '/monthly', '/hidden'],
      none: [],
    } });

    const raw = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', {
      sessionId, name: 'find_elements', args: { tabRef: 'page', role: 'link' },
    })).result;
    expect(raw.results).toHaveLength(20);
    expect(raw.total).toBe(LINKS);
    expect(raw.truncated).toBe(true);
    expect(raw.results[0]).toMatchObject({ name: 'Monthly Report', target: expect.stringMatching(/^uid:/), lineRange: expect.any(Array) });
    expect(raw.results[0]).toHaveProperty('obscuredAtCenter');
    const capped = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', {
      sessionId, name: 'find_elements', args: { tabRef: 'page', role: 'link', limit: 500 },
    })).result;
    expect(capped.results).toHaveLength(100);
    const tools = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', { sessionId, name: 'list_tools', args: {} })).result;
    expect(JSON.stringify(tools)).not.toContain('find_all_elements');
  } finally {
    if (sessionId) await callTool(environment.bridge.endpoint, 'qingzhou_stop_session', { sessionId }).catch(() => {});
    await environment?.close();
    server.close();
  }
});
