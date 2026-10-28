import { expect, test, testAssetUrl } from "./fixtures.mjs";

const html = `<style>
  body { margin: 12px; }
  img { width: 24px; height: 24px; }
  nav, ul, h2, a { display: block; }
</style>
<main>
  <h2>Syntax</h2>
  <h2>Browser compatibility</h2>
  <h2 role="tab">Not heading</h2>
  <nav aria-label="Primary"><a href="#syntax">Syntax link</a></nav>
  <a id="placeholder">No href</a>
  <ul><li>One</li><li>Two</li></ul>
  <table>
    <thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody><tr><th scope="row">Alpha</th><td>1</td></tr></tbody>
  </table>
  <img alt="Diagram" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
  <img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
</main>`;

async function installContentScript(page) {
  await page.setContent(html);
  await page.evaluate(() => {
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    let listener = null;
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {
        getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
        onMessage: {
          addListener(nextListener) { listener = nextListener; },
          removeListener() {},
        },
        sendMessage: async () => ({ ok: true }),
      },
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") {
        reject(new Error("content-script listener is not installed"));
        return;
      }
      try {
        listener({ action, ...params }, {}, resolve);
      } catch (error) {
        reject(error);
      }
    });
  });
  await page.addScriptTag({ url: testAssetUrl("extension/content/content-script.js") });
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

function findElements(page, params) {
  return page.evaluate(
    nextParams => window.__callQingzhouContent("findElements", nextParams),
    params,
  );
}

test("find_elements roles filter matches implicit heading, table, list, and navigation roles", async ({ page }) => {
  await installContentScript(page);

  const unfiltered = await findElements(page, { pattern: "Browser compatibility", limit: 20 });
  expect(unfiltered.matches).toBeGreaterThan(0);

  const heading = await findElements(page, { pattern: "Browser compatibility", roles: ["heading"], limit: 20 });
  expect(heading.matches).toBe(1);
  expect(heading.results).toHaveLength(1);
  expect(heading.results[0]).toMatchObject({ role: "heading", tag: "h2" });
  expect(heading.results[0].text).toContain("Browser compatibility");

  const headings = await findElements(page, { roles: ["heading"], limit: 20 });
  expect(headings.matches).toBe(2);
  expect(headings.results.map(item => item.text).sort()).toEqual(["Browser compatibility", "Syntax"]);
  expect(new Set(headings.results.map(item => item.role))).toEqual(new Set(["heading"]));

  const roles = [
    ["table", 1],
    ["row", 2],
    ["columnheader", 2],
    ["rowheader", 1],
    ["cell", 1],
    ["rowgroup", 2],
    ["list", 1],
    ["listitem", 2],
    ["navigation", 1],
    ["link", 1],
    ["img", 1],
    ["presentation", 1],
  ];
  for (const [role, count] of roles) {
    const result = await findElements(page, { roles: [role], limit: 20 });
    expect(result.matches, role).toBe(count);
    expect(result.results.every(item => item.role === role), role).toBe(true);
  }

  const link = await findElements(page, { roles: ["link"], limit: 20 });
  expect(link.results[0].text).toContain("Syntax link");
  const image = await findElements(page, { roles: ["img"], limit: 20 });
  expect(image.results[0].name).toBe("Diagram");
});
