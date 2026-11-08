import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../../services/mcp-bridge/src/server.mjs';
import { openFromToolbar } from '../firefox/driver.mjs';

/** Pair the real Firefox sidebar with a private CLI service. */
export async function connectFirefoxCli(session, { requireObserver = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qz-firefox-cli-'));
  const bridge = await startBridge({ port: 0, registryPath: join(directory, 'browsers.json'), requestTimeoutSeconds: 90 });
  const rejectDefaultBridge = route => route.abort();
  let connection, stage = 'open side panel';
  const evaluate = (fn, arg) => {
    // Resolve the test callback's imports to modules loaded by the copied package.
    const source = fn.toString().replace(/import\('\/shared\/(?:transport\/port-transport|session\/session-recovery)\.js'\)/g,
      'globalThis.__qzOuterScriptModules').replace(/import\('\/sidepanel\/tools\/tool-renderer\.js'\)/g, 'globalThis.__qzOuterScriptModules');
    return session.extension('sidebar', `
      const globalThis=view, document=content.document, chrome=view.chrome;
      const argument=${arg === undefined ? 'undefined' : `view.JSON.parse(${JSON.stringify(JSON.stringify(arg))})`};
      return await (${source})(argument);
    `);
  };
  const ui = async ({ sessionId, title, count, expect }) => {
    await session.extension('sidebar', `
      content.document.querySelector('[data-tab="sessions"]').click();
      content.document.querySelector('[data-sessions-mode="external-drive"]').click();return true;
    `);
    await expect.poll(() => session.extension('sidebar', `
      const row=content.document.querySelector('#sessions-list .session-card[data-id="${sessionId}"]:not(.is-removing)');
      if(!row)return null;
      const title=row.querySelector('.session-card-title').textContent.trim();row.click();return title;
    `)).toBe(title);
    await expect.poll(() => session.extension('sidebar', `return content.document.querySelectorAll('#messages .msg-tool').length;`)).toBe(count);
    const ids=await session.extension('sidebar', `return [...content.document.querySelectorAll('#messages .msg-tool')].map(node=>node.id);`);
    expect(new Set(ids).size).toBe(count);
  };
  try {
    await session.context.route('http://127.0.0.1:18765/**', rejectDefaultBridge);
    await openFromToolbar(session);
    stage = 'accept disclosure';
    const ready = await session.extension('sidebar', `
      const deadline=Date.now()+12000;
      while(Date.now()<deadline){
        content.document.querySelector('[data-consent-accept]')?.click();
        if((${JSON.stringify(requireObserver)} ? !!view.__qzOuterScriptModules : true)&&!content.document.querySelector('#app')?.hasAttribute('data-consent-pending')
          &&!content.document.querySelector('#app')?.hasAttribute('data-workspace-booting'))return true;
        await new Promise(resolve=>content.setTimeout(resolve,100));
      }return false;
    `);
    if (!ready) throw new Error('The Firefox sidebar did not finish accepting data disclosure.');
    stage = 'connect local CLI service';
    connection = await session.context.newPage();
    connection.setDefaultTimeout(15_000);
    await connection.goto(`${bridge.endpoint}/qz-connect`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await connection.locator('[data-qz-connection-state="connected"]').waitFor();
    // The authorized private endpoint is persisted; task tabs need no interception.
    await session.context.unroute('http://127.0.0.1:18765/**', rejectDefaultBridge);
    return { endpoint: bridge.endpoint, page: { evaluate }, context: session.context, ui,
      observe: () => session.extension('sidebar', 'view.__qzOuterScriptModules.observe();return true;'),
      async close() {
        await connection.close().catch(() => {});
        await session.context.unroute('http://127.0.0.1:18765/**', rejectDefaultBridge).catch(() => {});
        await bridge.close(); await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    console.error('FIREFOX_CLI_SETUP', JSON.stringify({ stage, error: error.message, connectionUrl: connection?.url() }));
    await connection?.close().catch(() => {});
    await session.context.unroute('http://127.0.0.1:18765/**', rejectDefaultBridge).catch(() => {});
    await bridge.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
