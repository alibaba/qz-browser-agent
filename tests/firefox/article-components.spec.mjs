import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixture.mjs';

const html = await readFile(new URL('../fixtures/shadow-components-article.html', import.meta.url), 'utf8');

test('article reads preserve component content without running lifecycle callbacks', async ({ firefoxSidebar: session }) => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/favicon.ico' ? 204 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/favicon.ico' ? '' : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/article`;
  const errors = [], page = session.page;
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.goto(url);
    const before = await page.evaluate(() => ({ calls: {...componentCalls}, html: document.body.innerHTML,
      shadow: document.querySelector('#shadow-host').shadowRoot.innerHTML }));
    const tabId = await session.extension('background', `
      const tab=(await view.chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(url)});
      await view.chrome.scripting.executeScript(view.JSON.parse(JSON.stringify({target:{tabId:tab.id},files:['content/article-extractor.js','content/content-script.js']})));
      return tab.id;
    `);
    for (const source of ['auto', 'selector', 'body']) {
      const result = await session.extension('background', `return await view.chrome.tabs.sendMessage(${tabId},view.JSON.parse(${JSON.stringify(JSON.stringify({action:'readArticle',source,selector:'#story',limit:20000}))}));`);
      expect(result.code, result.error).toBeUndefined();
      for (const marker of ['LIGHT-SLOT-EVIDENCE', 'NESTED-SLOT-EVIDENCE', 'DEEP-SLOT-EVIDENCE']) {
        expect(result.text.match(new RegExp(marker, 'g'))).toEqual([marker]);
      }
      expect(result.text.match(/FULL-117/g)).toHaveLength(3);
      expect(result.text.match(/FULL-118/g)).toHaveLength(3);
      expect(result.text).toContain('https://example.test/research/reference.html');
      if (source === 'auto') expect(result.text).not.toMatch(/HIDDEN-(LIGHT|SHADOW)-SECRET/);
    }
    expect(await page.evaluate(() => ({ calls: {...componentCalls}, html: document.body.innerHTML,
      shadow: document.querySelector('#shadow-host').shadowRoot.innerHTML }))).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    page.off('pageerror', onError);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
