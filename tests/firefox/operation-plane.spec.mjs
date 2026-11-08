import { test, expect } from './fixture.mjs';
import { exerciseElementActionWorkflow, startElementActionWorkflow } from '../support/element-action-workflow.mjs';

test('Firefox actions wait for readiness and reuse element targets for pointer operations', async ({ firefoxSidebar }) => {
  test.setTimeout(120_000);
  const fixture = await startElementActionWorkflow();
  const page = await firefoxSidebar.context.newPage();
  try {
    await page.goto(fixture.url);
    await page.frameLocator('iframe').locator('#frame-hover').waitFor();
    const tabId = await firefoxSidebar.extension('background', `
      return (await view.chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(fixture.url)}).id;
    `);
    const call = (name, args = {}) => firefoxSidebar.extension('background', `
      const request=${JSON.stringify({ name, args: { tabRef: tabId, ...args } })};
      const context=Cu.cloneInto({sessionId:'firefox-operation-plane',runId:'run',externalDrive:true,source:'agent'},content);
      try { return JSON.parse(JSON.stringify(await view.__qzFirefoxPageTools.execute(request.name,Cu.cloneInto(request.args,content),undefined,context))); }
      catch(error) { const failure=Cu.waiveXrays(error); return {code:String(failure.code||''),message:String(failure.message||failure),
        ...(failure.details?{details:JSON.parse(JSON.stringify(failure.details))}:{})}; }
    `);
    await exerciseElementActionWorkflow({ page, call, expect });
    await page.evaluate(() => {
      const section = document.createElement('section');
      section.innerHTML = '<p>Inventory remains readable.</p><div style="visibility:hidden"><button style="visibility:visible">Visible descendant</button></div>';
      document.body.append(section);
    });
    const tree = await call('get_ax_tree', { scope: 'full', limit: 200 });
    expect(tree.snapshot, JSON.stringify(tree)).toContain('combobox "Track"');
    expect(tree.snapshot).toContain('Inventory remains readable.');
    expect(tree.snapshot).toContain('button "Visible descendant"');
  } finally { await page.close(); await fixture.close(); }
});
