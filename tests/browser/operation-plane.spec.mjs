import { test, expect } from './fixtures.mjs';
import { callTool, readHealth } from '../../services/mcp-bridge/src/client.mjs';
import { main } from '../../services/mcp-bridge/src/cli.mjs';
import { buildScriptRequest } from '../../services/mcp-bridge/src/script-call.mjs';
import { exerciseElementActionWorkflow, startElementActionWorkflow } from '../support/element-action-workflow.mjs';

test('direct-drive tools discover capabilities and act on ready element targets', async () => {
  test.setTimeout(120_000);
  const { launchIsolatedExtensionMcp } = await import('../support/isolated-extension-mcp.mjs');
  const fixture = await startElementActionWorkflow();
  let environment, sessionId;
  try {
    environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-operation-plane-' });
    ({ sessionId } = await callTool(environment.bridge.endpoint, 'qingzhou_create_drive_session', { title: 'Element action workflow' }));
    const call = async (name, args = {}) => {
      try { return (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', {
        sessionId, name, args: ['open_tab', 'list_tabs', 'list_tools', 'run_script'].includes(name) ? args : { tabRef: 'page', ...args },
      })).result; }
      catch (error) { return { code: error.code, message: error.message, details: error.details }; }
    };
    expect(await call('open_tab', { url: fixture.url, tabAlias: 'page' })).toHaveProperty('tabRef', 'page');
    await expect.poll(() => environment.context.pages().some(page => page.url() === fixture.url)).toBe(true);
    const page = environment.context.pages().find(page => page.url() === fixture.url);
    await page.frameLocator('iframe').locator('#frame-hover').waitFor();
    await exerciseElementActionWorkflow({ page, call, expect });

    const concurrent = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', buildScriptRequest({ sessionId, code: `
      const [found] = await Promise.all([
        qz.tab('page').find({ role: 'button', pattern: '^Pipeline ready$', waitForMatch: true, timeout: 5 }),
        qz.tab('page').evaluate(() => {
          const button = document.createElement('button');
          const link = document.createElement('a'); link.href = '#pipeline';
          button.textContent = link.textContent = 'Pipeline ready'; document.body.append(button, link);
          const contextual = document.createElement('button'); contextual.textContent = 'Before Pipeline ready After';
          document.body.append(contextual);
          for (const type of ['search', 'text']) {
            const input = document.createElement('input'); input.type = type;
            input.setAttribute('aria-label', 'Pipeline ready'); document.body.append(input);
          }
        })
      ]);
      return found;
    ` }))).result;
    expect(concurrent, JSON.stringify(concurrent)).toMatchObject({ ok: true, result: [{ role: 'button', target: expect.stringMatching(/^uid:/) }] });
    const multiple = await call('find_elements', { roles: ['button', 'link'], pattern: '^Pipeline ready$' });
    expect(multiple.total).toBe(2);
    expect(multiple.results.map(element => element.role).sort()).toEqual(['button', 'link']);
    const input = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', buildScriptRequest({ sessionId, code: `
      return qz.tab('page').find({tag:'input', type:'search', pattern:/^pipeline ready$/i});
    ` }))).result;
    expect(input).toMatchObject({ ok: true, result: [{ tag: 'input', type: 'search', target: expect.stringMatching(/^uid:/) }] });
    const patterns = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool', buildScriptRequest({ sessionId, code: `
      const page = qz.tab('page');
      return {
        sensitive: await page.find({tag:'input', type:'search', pattern:/^pipeline ready$/}),
        spaced: await page.find({role:'button', pattern:/ Pipeline ready /}),
      };
    ` }))).result;
    expect(patterns).toMatchObject({ ok: true, result: {
      sensitive: [],
      spaced: [{ name: 'Before Pipeline ready After' }],
    } });

    const authored = { popups: [{ tabRef: 'business-value' }], target: 'inventory', result: { nodes: [1, 2] } };
    const script = (await callTool(environment.bridge.endpoint, 'qingzhou_execute_tool',
      buildScriptRequest({ sessionId, code: 'return args;', args: authored }))).result;
    expect(script).toMatchObject({ ok: true, result: authored });
    const clicked = await call('act_on_element', { target: 'css:#popup', action: 'click' });
    expect(clicked.popups, JSON.stringify(clicked)).toHaveLength(1);
    expect(Object.keys(clicked.popups[0]).sort()).toEqual(['active', 'tabRef', 'title', 'url']);
    const tabs = await call('list_tabs', { scope: 'owned' });
    expect(tabs.tabs.find(tab => tab.tabRef === clicked.popups[0].tabRef)?.ownership).toBe('owned');

    const userPage = await environment.context.newPage();
    await userPage.goto(`${fixture.url}user`);
    const cancel = async () => {
      const stdout = { isTTY: false, text: '', write(value) { this.text += value; } };
      const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
      const code = await main(['session', 'cancel', sessionId, '--keep', 'page', '--json'], {
        stdout, stderr, findDaemon: async () => ({ endpoint: environment.bridge.endpoint, health: await readHealth(environment.bridge.endpoint) }),
      });
      expect(code, JSON.stringify({ stdout: stdout.text, stderr: stderr.text })).toBe(0);
    };
    await cancel();
    await expect.poll(() => environment.context.pages().filter(candidate => candidate.url() === `${fixture.url}popup`).length).toBe(0);
    expect(page.isClosed()).toBe(false);
    expect(userPage.isClosed()).toBe(false);
    await cancel();
    expect(page.isClosed()).toBe(false);
    expect(userPage.isClosed()).toBe(false);
  } finally {
    if (sessionId) await callTool(environment.bridge.endpoint, 'qingzhou_stop_session', { sessionId }).catch(() => {});
    await environment?.close(); await fixture.close();
  }
});
