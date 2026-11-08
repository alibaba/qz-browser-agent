import { createServer } from 'node:http';
import { main } from '../../services/mcp-bridge/src/cli.mjs';
import { callTool, readHealth } from '../../services/mcp-bridge/src/client.mjs';

/** Exercise discovery through the installed package, bridge and public CLI receipt. */
export async function exerciseCliSkillDiscovery({ endpoint, page, expect, step, testInfo }) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Discovery catalog</title><h1>Catalog</h1>'
      + '<article data-id="harbor-mug" data-price="35"><h2>Harbor mug</h2></article>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessions = [], transcript = [];
  const cli = async (argv, source = '', success = true) => {
    const stdout = { isTTY: false, text: '', write(value) { this.text += value; } };
    const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
    const exitCode = await main(argv, { stdout, stderr, readStdin: async () => source,
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
    });
    const entry = { argv, source, exitCode, stdout: stdout.text, stderr: stderr.text };
    transcript.push(entry);
    expect(exitCode, JSON.stringify(entry)).toBe(success ? 0 : 1);
    const receipt = JSON.parse(stdout.text);
    expect(receipt.ok, JSON.stringify(entry)).toBe(success);
    return receipt;
  };
  const globals = ['cli-global', 'cli-resident'];
  const createSession = async () => {
    const receipt = await cli(['session', 'create', '--title', 'CLI Skill discovery', '--json']);
    sessions.push(receipt.result.sessionId);
    summaries({ context: { qz_skills: receipt.result.qz_skills } }, globals);
    return receipt.result.sessionId;
  };
  const script = (sessionId, code, args = {}, success = true) => cli([
    'script', '--session', sessionId, '--timeout', '30', '--args', JSON.stringify(args), '-',
  ], code, success);
  const summaries = (receipt, names) => {
    const skills = receipt.context?.qz_skills || [];
    expect(receipt.context).not.toHaveProperty('skills');
    expect(skills.map(skill => skill.name).sort(), JSON.stringify(receipt)).toEqual([...names].sort());
    for (const skill of skills) {
      expect(skill).toMatchObject({ name: expect.any(String), displayName: expect.any(String),
        description: expect.any(String), scope: expect.any(String) });
      expect(Object.keys(skill).filter(key => ![
        'name', 'displayName', 'description', 'scope', 'domains', 'urlPatterns',
      ].includes(key))).toEqual([]);
    }
    expect(JSON.stringify(skills)).not.toContain('FULL_INSTRUCTIONS');
  };
  try {
    const product = { id: 'harbor-mug', title: 'Harbor mug', price: 35 };
    const detailOutput = {
      type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } },
      required: ['id', 'title', 'price'], additionalProperties: false, examples: [product],
    };
    const searchOutput = {
      type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } },
        required: ['id', 'title'], additionalProperties: false },
      examples: [[{ id: product.id, title: product.title }]],
    };
    const pageParameters = { type: 'object', properties: { tabRef: { type: ['string', 'integer'] } }, required: ['tabRef'] };
    const skill = (name, scope, metadata = {}) => ({
      format: 'qingzhou.skill', schemaVersion: 2, name, displayName: `Guide ${name}`,
      description: `Use ${name} for this workflow.`, scope, status: 'active',
      content: `FULL_INSTRUCTIONS for ${name}`, resources: [], ...metadata,
    });
    const installedSkills = [
      skill('cli-global', 'global'), skill('cli-resident', 'resident'),
      skill('cli-catalog', 'site', { domains: ['127.0.0.1'], urlPatterns: ['/catalog*'], resources: [
        { path: 'plugin.json', type: 'json', content: JSON.stringify({
          format: 'qingzhou.plugin', schemaVersion: 1, id: 'cli-catalog', tools: [{
            name: 'read', runtime: 'script', script: 'read.js', description: 'Read catalog metadata.',
            parameters: pageParameters,
          }, {
            name: 'search', runtime: 'script', script: 'search.js', description: 'Find catalog products.',
            parameters: pageParameters, outputSchema: searchOutput,
          }, {
            name: 'detail', runtime: 'script', script: 'detail.js', description: 'Read a product and its price.',
            parameters: { type: 'object', properties: { ...pageParameters.properties, id: { type: 'string' } }, required: ['tabRef', 'id'] },
            outputSchema: detailOutput,
          }, {
            name: 'search_details', runtime: 'script', script: 'search-details.js', description: 'Find products and read each detail.',
            parameters: pageParameters, outputSchema: { type: 'array', items: detailOutput, examples: [[product]] },
          }],
        }) },
        { path: 'read.js', type: 'script', content: `return await tools.evaluate({
          tabRef: args.tabRef, code: () => ({title: document.title, path: location.pathname})
        });` },
        { path: 'search.js', type: 'script', content: `return await qz.tab(args.tabRef).evaluate(() =>
          [...document.querySelectorAll('article[data-id]')].map(node => ({ id: node.dataset.id, title: node.querySelector('h2').textContent }))
        );` },
        { path: 'detail.js', type: 'script', content: `
          trace('catalog.detail');
          return await qz.tab(args.tabRef).evaluate(id => {
            const node = [...document.querySelectorAll('article[data-id]')].find(node => node.dataset.id === id);
            return { id: node.dataset.id, title: node.querySelector('h2').textContent,
              price: node.dataset.price === undefined ? null : Number(node.dataset.price) };
          }, args.id);` },
        { path: 'search-details.js', type: 'script', content: `
          const products = await qz.call('cli_catalog__search', {tabRef:args.tabRef});
          return await Promise.all(products.map(product => qz.call('cli_catalog__detail', {tabRef:args.tabRef,id:product.id})));` },
      ] }),
      skill('cli-checkout', 'site', { domains: ['127.0.0.1'], urlPatterns: ['/checkout*'] }),
      skill('cli-disabled-global', 'global', { status: 'disabled' }),
      skill('cli-disabled-site', 'site', { status: 'disabled', domains: ['127.0.0.1'] }),
      skill('cli-unmatched-site', 'site', { domains: ['unmatched.example'] }),
    ];
    const installed = await page.evaluate(skills => new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'sidepanel' }), requestId = 'cli-discovery-install';
      const timer = setTimeout(() => { port.disconnect(); reject(new Error('Skill import timed out')); }, 15_000);
      port.onMessage.addListener(message => {
        if (message.requestId !== requestId) return;
        clearTimeout(timer); port.disconnect(); resolve(message);
      });
      port.postMessage({ type: 'import_workspace_skills', requestId, skills,
        expected: Object.fromEntries(skills.map(skill => [skill.name, null])) });
    }), installedSkills);
    expect(installed.registryReady, JSON.stringify(installed)).toBe(true);
    const sessionId = await createSession();
    const visited = [...globals, 'cli-catalog', 'cli-checkout'];

    await step('every receipt exposes the available user summaries', async () => {
      const first = await script(sessionId, "return { value: 'unchanged business result' };");
      expect(first.result).toEqual({ value: 'unchanged business result' });
      expect(first.trace).toEqual([]);
      summaries(first, globals);
      summaries(await script(sessionId, 'return 2;'), globals);
    });

    await step('navigation includes Skills matching current and previously visited pages', async () => {
      const opened = await script(sessionId, 'return await qz.openTab({url:args.url,tabAlias:"catalog"});',
        { url: `${origin}/catalog` });
      expect(opened.result.tabRef).toBe('catalog');
      summaries(opened, [...globals, 'cli-catalog']);
      expect(opened.context.qz_skills.find(skill => skill.name === 'cli-catalog'))
        .toMatchObject({ scope: 'site', domains: ['127.0.0.1'], urlPatterns: ['/catalog*'] });
      summaries(await script(sessionId, 'return await qz.tab("catalog").evaluate(() => document.title);'), [...globals, 'cli-catalog']);
      const navigated = await script(sessionId, 'return await qz.tab("catalog").goto(args.url);',
        { url: `${origin}/checkout` });
      summaries(navigated, visited);
      summaries(await script(sessionId, 'return await qz.tab("catalog").goto(args.url);',
        { url: `${origin}/catalog` }), visited);
    });

    await step('explicit loading returns instructions and enables a working script tool', async () => {
      const loaded = await script(sessionId, 'return await qz.call("load_skill", {name:"cli-catalog"});');
      expect(loaded.result.content).toBe('FULL_INSTRUCTIONS for cli-catalog');
      summaries(loaded, visited);
      const executed = await script(sessionId, 'return await qz.call("cli_catalog__read", {tabRef:"catalog"});');
      expect(executed.result).toEqual({ title: 'Discovery catalog', path: '/catalog' });
      summaries(executed, visited);
      const reloaded = await script(sessionId, 'return await qz.call("load_skill", {name:"cli-catalog"});');
      expect(reloaded.result.content).toBe(loaded.result.content);
      summaries(reloaded, visited);
      const builtin = await script(sessionId, 'return await qz.call("load_skill", {name:"qingzhou-documents"});');
      expect(builtin.result).toMatchObject({ name: 'qingzhou-documents', builtin: true });
      expect(builtin.result.content.length).toBeGreaterThan(0);
      summaries(builtin, visited);
    });

    await step('named discovery exposes output schemas and real Skill calls compose through their values', async () => {
      const catalog = await script(sessionId, `return {
        compact: await qz.listTools(),
        full: await qz.listTools({names:['cli_catalog__search','cli_catalog__detail','cli_catalog__read']})
      };`);
      const compact = catalog.result.compact.tools.filter(tool => tool.name.startsWith('cli_catalog__'));
      expect(compact).toHaveLength(4);
      for (const tool of compact) {
        expect(tool.signature).toContain(tool.name);
        expect(tool).not.toHaveProperty('outputSchema');
        expect(tool).not.toHaveProperty('parameters');
      }
      const full = new Map(catalog.result.full.tools.map(tool => [tool.name, tool]));
      expect(full.get('cli_catalog__search').outputSchema).toEqual(searchOutput);
      expect(full.get('cli_catalog__detail').outputSchema).toEqual(detailOutput);
      expect(full.get('cli_catalog__read')).not.toHaveProperty('outputSchema');
      const chained = await script(sessionId, 'return await qz.call("cli_catalog__search_details", {tabRef:"catalog"});');
      expect(chained.result).toEqual([product]);
      expect(chained.trace).toEqual(['catalog.detail']);

      await script(sessionId, `await qz.tab('catalog').evaluate(() => {
        delete document.querySelector('article').dataset.price;
      });`);
      const failed = await script(sessionId, `trace('caller.start');
        await qz.call('cli_catalog__detail', {tabRef:'catalog',id:args.id});
        trace('caller.completed');`, { id: product.id }, false);
      expect(failed.result).toMatchObject({ code: 'SKILL_OUTPUT_INVALID', details: {
        tool: 'cli_catalog__detail', executed: true, automaticReplay: false,
      } });
      expect(failed.result.details.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/(?:^|\/)price$/), keyword: 'type', message: expect.any(String) }),
      ]));
      expect(failed.trace).toEqual(expect.arrayContaining(['caller.start', 'catalog.detail']));
      expect(failed.trace).not.toContain('caller.completed');
      expect((await script(sessionId, 'return await qz.call("cli_catalog__read", {tabRef:"catalog"});')).result)
        .toEqual({ title: 'Discovery catalog', path: '/catalog' });
    });

    await step('another session does not inherit visited-site Skills', async () => {
      const otherSession = await createSession();
      summaries(await script(otherSession, 'return true;'), globals);
    });
  } finally {
    for (const sessionId of sessions) {
      await callTool(endpoint, 'qingzhou_stop_session', { sessionId }).catch(() => {});
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await testInfo.attach('cli-skill-discovery.json', {
      body: Buffer.from(JSON.stringify(transcript, null, 2)), contentType: 'application/json',
    });
  }
}
