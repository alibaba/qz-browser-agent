import { createServer } from 'node:http';
import { test, expect } from './fixture.mjs';

test('Firefox without deep serialization preserves disabled option observations and reads later DOM changes', async ({ firefoxSidebar }) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<select size="3"><option>Available</option><option id="disabled" disabled>Disabled option</option></select><div role="option" aria-disabled="true">ARIA option</div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await firefoxSidebar.context.newPage();
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(url);
    const tabId = await firefoxSidebar.extension('background', `return (await view.chrome.tabs.query({})).find(tab => tab.url === ${JSON.stringify(url)}).id;`);
    const snapshot = () => firefoxSidebar.extension('background', `
      const context = Cu.cloneInto({sessionId:'firefox-option-disabled',runId:'option-run',externalDrive:true,source:'agent'},content);
      return JSON.parse(JSON.stringify(await view.__qzFirefoxPageTools.execute('get_ax_tree',
        Cu.cloneInto({tabRef:${tabId},scope:'full',limit:100},content),undefined,context)));
    `);
    const line = (result, label) => result.snapshot.split('\n').find(line => line.includes(`"${label}"`) && /\boption\b/.test(line));
    const before = await snapshot();
    expect(line(before, 'Available'), before.snapshot).not.toMatch(/\bdisabled\b/);
    expect(line(before, 'Disabled option'), before.snapshot).toMatch(/\bdisabled\b/);
    expect(line(before, 'ARIA option'), before.snapshot).toMatch(/\bdisabled\b/);
    await page.locator('#disabled').evaluate(option => { option.disabled = false; });
    const after = await snapshot();
    expect(line(after, 'Disabled option'), after.snapshot).not.toMatch(/\bdisabled\b/);
    expect(line(after, 'ARIA option'), after.snapshot).toMatch(/\bdisabled\b/);
  } finally {
    await page.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
});
