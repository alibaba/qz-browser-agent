// Public, unauthenticated pages. Oracles are read independently from rendered DOM before each run.
// No account creation, form submission, purchase, voting or external-link navigation is permitted.
export const publicSites = [
  { id: 'baidu', url: 'https://baike.baidu.com/item/Python/407313', category: 'Chinese encyclopedia', tasks: [
    { id: 'intro', group: 'in-view', prompt: '从词条开头读取 Python 首次发布年份、创始人和目前的维护组织，只回答这三项。', probe: { css: '.J-summary [class*="para"]', text: 'Python 是一种高级、通用' }, answers: ['1991', 'Guido van Rossum', 'Python 软件基金会'] },
    { id: 'learning', group: 'off-screen', prompt: '在词条末尾附近的“学习网站”部分，列出三个网站的可见链接名称。不要打开外链。', probe: { css: 'h2', text: '学习网站' }, answers: ['Python官方文档', 'Python官网', '菜鸟教程'] },
  ] },
  { id: 'github', url: 'https://github.com/psf/requests', category: 'repository / README', tasks: [
    { id: 'about', group: 'in-view', prompt: 'Quote the one-sentence About description of this repository.', probe: { css: 'p', text: 'A simple, yet elegant, HTTP library.' }, answers: ['A simple, yet elegant, HTTP library.'] },
    { id: 'python-version', group: 'off-screen', prompt: 'In the README Installing Requests and Supported Versions section, what minimum Python version is officially supported?', probe: { css: 'p', text: 'Requests officially supports Python' }, capture: 'Requests officially supports Python ([0-9.]+)' },
  ] },
  { id: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array', category: 'reference / sticky navigation', tasks: [
    { id: 'availability', group: 'in-view', prompt: 'What compatibility availability status is displayed in the Baseline badge near the top of this Array page? Quote the status.', probe: { css: 'h1', text: 'Array' }, answers: ['Widely available'] },
    { id: 'modified', group: 'off-screen', prompt: 'Near the bottom under Help improve MDN, what is the exact last-modified date for this page? Copy the displayed date.', probe: { css: 'p', text: 'This page was last modified' }, capture: 'last modified on (.+?) by' },
  ] },
  { id: 'adafruit', url: 'https://www.adafruit.com/category/105', category: 'large commercial product listing', tasks: [
    { id: 'intro-board', group: 'in-view', prompt: 'The introductory text names a five-dollar board. What is that board called? Do not buy anything.', probe: { css: 'p', text: 'five-dollar' }, answers: ['Pi Zero'] },
    { id: 'last-product', group: 'off-screen', prompt: 'At the bottom of the listing, read the product ID and stock status of anidees Black Extra High Raspberry Pi 4 Case. Do not add anything to the cart.', probe: { css: 'h2,h3', text: 'anidees Black Extra High Raspberry Pi 4 Case' }, answers: ['5040', 'No longer stocked'] },
  ] },
  { id: 'python', url: 'https://docs.python.org/3/library/pathlib.html', category: 'long documentation / sidebar', tasks: [
    { id: 'introduced', group: 'in-view', prompt: 'What Python version was pathlib added in, according to the note immediately below the main title?', probe: { css: 'p', text: 'Added in version' }, capture: 'Added in version ([0-9.]+)' },
    { id: 'generator', group: 'off-screen', prompt: 'At the very bottom, which documentation generator and exact version created this page?', probe: { css: 'div.footer', text: 'Created using' }, capture: 'Created using (Sphinx [0-9.]+)' },
  ] },
  { id: 'hn', url: 'https://news.ycombinator.com/item?id=8863', category: 'long forum / comments', tasks: [
    { id: 'submitter', group: 'in-view', prompt: 'Who submitted the original Dropbox post, and how many comments does its header show?', probe: { css: '.subtext' }, answers: ['dhouston'], capture: '([0-9]+)\\s*comments' },
    { id: 'last-reply', group: 'off-screen', prompt: 'In the final reply by jganetsk near the bottom, what website URL is linked in the Coda comment?', probe: { css: 'a[href="http://www.coda.cs.cmu.edu/"]', last: true }, answers: ['www.coda.cs.cmu.edu'] },
  ] },
  { id: 'debian', url: 'https://www.debian.org/distrib/packages', category: 'search / form controls', tasks: [
    { id: 'firmware', group: 'in-view', prompt: 'In the introductory notes, what is the exact name of the separate package section restricted to device firmware?', probe: { css: 'dt', text: 'Non-Free-Firmware' }, answers: ['Non-Free-Firmware'] },
    { id: 'contents-query', group: 'off-screen', prompt: 'In Search the contents of packages (NOT Search package directories), fill Keyword with libssl. Do not submit or change any other field.', probe: { css: '#keyword' }, fill: { selector: '#keyword', value: 'libssl', unchanged: '#kw' } },
  ] },
  { id: 'w3schools', url: 'https://www.w3schools.com/html/html_iframe.asp', category: 'same-process iframe / fixed header', tasks: [
    { id: 'frame-title', group: 'in-view', prompt: 'What is the accessible title of the embedded tutorial iframe shown beneath the introduction? Report the iframe title, not this page title. Do not navigate.', probe: { css: 'iframe[title="W3Schools HTML Tutorial"]' }, answers: ['W3Schools HTML Tutorial'] },
    { id: 'tag-description', group: 'off-screen', prompt: 'In the HTML iframe Tag table near the end of the article, quote the description given for the iframe tag.', probe: { css: 'td', text: 'Defines an inline frame' }, answers: ['Defines an inline frame'] },
  ] },
  { id: 'bbc', url: 'https://www.bbc.com/news', category: 'news / sticky header', tasks: [
    { id: 'lead', group: 'in-view', prompt: 'Quote the first lead news headline in the main content, not a navigation label.', probe: { css: 'main h2', first: true }, fromProbe: true },
    { id: 'last-sport', group: 'off-screen', prompt: 'In the SPORT section near the bottom, quote the last sports story headline in page order, not a footer navigation link.', probe: { css: 'main h2', last: true }, fromProbe: true },
  ] },
  { id: 'rust', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', category: 'fixed sidebar / code-heavy document', tasks: [
    { id: 'sidebar', group: 'in-view', prompt: 'In the left sidebar, what is the title of chapter section 1.3? Include the section number.', probe: { css: 'nav a', text: 'Hello, Cargo!' }, answers: ['1.3', 'Hello, Cargo!'] },
    { id: 'last-listing', group: 'off-screen', prompt: 'Near the end of this chapter, quote the caption of the final numbered code listing (Listing 4-5).', probe: { css: 'figcaption', text: 'Listing 4-5' }, answers: ['Returning ownership of parameters'] },
  ] },
  { id: 'wikihow', url: 'https://www.wikihow.com/Grow-Basil', category: 'long article / fixed header / ad frames', tasks: [
    { id: 'author', group: 'in-view', prompt: 'Who co-authored this article, as credited near the title? Include the displayed qualification.', probe: { css: 'a', text: 'Andrew Carberry' }, answers: ['Andrew Carberry', 'MPH'] },
    { id: 'coauthors', group: 'off-screen', prompt: 'In the About this article metadata near the bottom, how many co-authors are credited? Reply with the count.', probe: { css: 'h2', text: 'About this article' }, capture: 'Co-authors:\\s*(\\d+)', captureBody: true },
  ] },
  { id: 'mediawiki', url: 'https://www.mediawiki.org/w/index.php?title=Special:CreateAccount', category: 'signup form / no submission', tasks: [
    { id: 'username', group: 'in-view', prompt: 'Fill Username with ViewportBandProbe. Do not fill anything else, submit the form, create an account, or solve a CAPTCHA.', probe: { css: '#wpName2' }, fill: { selector: '#wpName2', value: 'ViewportBandProbe', unchanged: '#wpPassword2' } },
    { id: 'mobile-link', group: 'off-screen', prompt: 'At the page footer, quote the link label for the mobile version. Do not follow the link.', probe: { css: 'a', text: 'Mobile view' }, answers: ['Mobile view'] },
  ] },
  { id: 'pypi', url: 'https://pypi.org/project/requests/', category: 'package registry / availability probe', tasks: [
    { id: 'project', group: 'in-view', prompt: 'Read the package name and current version from the project heading.', probe: { css: 'h1', text: 'requests' }, fromProbe: true },
    { id: 'footer', group: 'off-screen', prompt: 'At the bottom, quote the copyright organization for this registry.', probe: { css: 'footer', text: 'Python Software Foundation' }, answers: ['Python Software Foundation'] },
  ] },
];

export const normalizeAnswer = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export async function readPublicOracle(page, task) {
  return page.evaluate(({ probe, capture, captureBody, fromProbe, answers, fill }) => {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    let candidates = [...document.querySelectorAll(probe.css)].map(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { el, text: clean(el.innerText || el.getAttribute('title')), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' };
    }).filter(c => c.visible && (!probe.text || c.text.includes(probe.text)));
    if (!probe.first && !probe.last) candidates.sort((a, b) => a.text.length - b.text.length);
    const picked = probe.last ? candidates.at(-1) : candidates[0];
    if (!picked) return { error: `Missing rendered target: ${JSON.stringify(probe)}`, title: document.title };
    const body = clean(document.body.innerText);
    const expected = [...(answers || [])];
    if (fromProbe) expected.push(picked.text);
    if (capture) {
      const match = (captureBody ? body : picked.text).match(new RegExp(capture, 'i'));
      if (!match) return { error: `Oracle capture did not match: ${capture}`, text: picked.text };
      expected.push(match[1].replace(/\.$/, ''));
    }
    return { title: document.title, expected, probeText: picked.text.slice(0,2000), rect: picked.rect, height: innerHeight, scrollY,
      documentHeight: document.documentElement.scrollHeight,
      textPresent: expected.every(text => body.toLowerCase().includes(text.toLowerCase()) || picked.text.toLowerCase().includes(text.toLowerCase())),
      unchanged: fill?.unchanged ? document.querySelector(fill.unchanged)?.value : undefined,
      iframeCount: document.querySelectorAll('iframe').length };
  }, task);
}

export async function preparePublicTask(page, task) {
  const oracle = await readPublicOracle(page, task);
  if (oracle.error) throw Object.assign(new Error(oracle.error), { oracle });
  const inBand = oracle.rect.y < oracle.height && oracle.rect.y + oracle.rect.height > 0;
  if ((task.group === 'in-view') !== inBand) throw Object.assign(new Error(`Target is not initially ${task.group}`), { oracle });
  if (!task.fill && !oracle.textPresent) throw Object.assign(new Error('Expected source facts missing from DOM'), { oracle });
  return oracle;
}
