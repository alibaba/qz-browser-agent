import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { initializeProviderHeaderRules } from "../../src/background/services/provider-header-rules.js";

const rules = JSON.parse(await readFile(new URL("../../src/rules/provider-headers.json", import.meta.url)));
const skillRule = { id: 1_930_000_001 };

function fixture(id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
  let installed = [{ id: 1_900_000_099 }, skillRule];
  let updates = 0;
  const options = {
    runtime: { id, getURL: path => `chrome-extension://${id}/${path}` },
    fetch: async url => {
      assert.equal(url, `chrome-extension://${id}/rules/provider-headers.json`);
      return Response.json(rules);
    },
    dnr: {
      getSessionRules: async () => structuredClone(installed),
      async updateSessionRules({ removeRuleIds, addRules }) {
        updates++;
        installed = installed.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules);
      },
    },
  };
  return { options, installed: () => installed, updates: () => updates };
}

test("provider rules use the installed ID and preserve destinations, actions, and Skill rules across restarts", async () => {
  for (const id of ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
    const f = fixture(id);
    for (let restart = 0; restart < 2; restart++) {
      await initializeProviderHeaderRules(f.options);
      assert.deepEqual(f.installed(), [skillRule, ...rules.map(rule => ({
        ...rule, id: 1_900_000_000 + rule.id,
        condition: { ...rule.condition, initiatorDomains: [id] },
      }))]);
    }
    assert.equal(f.updates(), 2);
  }
});

test("empty provider configuration removes obsolete rules without touching Skill rules", async () => {
  const f = fixture();
  f.options.fetch = async () => Response.json([]);
  await initializeProviderHeaderRules(f.options);
  assert.deepEqual(f.installed(), [skillRule]);
});

test("invalid configuration and Chrome failures reject initialization and allow retry", async () => {
  for (const fetch of [
    async () => new Response("missing", { status: 404 }),
    async () => new Response("invalid json"),
    async () => Response.json([{ ...rules[0], id: 1_000_000 }]),
  ]) {
    const f = fixture();
    await assert.rejects(initializeProviderHeaderRules({ ...f.options, fetch }));
    assert.equal(f.updates(), 0);
    await initializeProviderHeaderRules(f.options);
    assert.equal(f.updates(), 1);
  }
  const f = fixture();
  const update = f.options.dnr.updateSessionRules;
  f.options.dnr.updateSessionRules = async () => { throw new Error("Chrome unavailable"); };
  await assert.rejects(initializeProviderHeaderRules(f.options), /Chrome unavailable/);
  f.options.dnr.updateSessionRules = update;
  await initializeProviderHeaderRules(f.options);
  assert.equal(f.updates(), 1);
});
