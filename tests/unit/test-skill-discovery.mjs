import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverUserSkills, isDiscoverableUserSkill, summarizeSkill } from '../../src/shared/skills/skill-discovery.js';
import { normalizeModernSkill } from '../../src/shared/skills/skill-utils.js';
import { findBuiltinSkill } from '../../src/shared/skills/builtin-skills.js';
import { registerAnalysisSkillsTools } from '../../src/capabilities/skills/tools.js';

const skill = (name, fields = {}) => normalizeModernSkill({ name, displayName: `Title ${name}`,
  description: `Use ${name}`, content: 'Instructions stay out of discovery.', ...fields });
const global = skill('global');
const resident = skill('resident', { scope: 'resident', readOnly: true, source: 'git' });
const site = skill('orders', { scope: 'site', domains: ['shop.example'], urlPatterns: ['/orders/*'], excludePatterns: ['/orders/private/*'] });
const unrelated = skill('other-site', { scope: 'site', domains: ['other.example'] });
const emptySite = skill('empty-site', { scope: 'site' });
const disabled = skill('disabled', { status: 'disabled' });
const builtin = skill('builtin', { builtin: true });
const system = skill('system', { source: 'system' });
const fixture = [global, resident, site, unrelated, emptySite, disabled, builtin, system];

test('discovery summaries expose descriptions and site rules without instructions or storage fields', () => {
  assert.deepEqual(summarizeSkill(global), { name: 'global', displayName: 'Title global', description: 'Use global', scope: 'global' });
  assert.deepEqual(summarizeSkill(site), { name: 'orders', displayName: 'Title orders', description: 'Use orders', scope: 'site',
    domains: ['shop.example'], urlPatterns: ['/orders/*'] });
  assert.notEqual(summarizeSkill(site).domains, site.domains);
  assert.equal(isDiscoverableUserSkill(resident), true, 'read-only imported Skills remain user Skills');
  for (const row of [disabled, builtin, system]) assert.equal(isDiscoverableUserSkill(row), false);
});

test('automatic discovery has no global cap and matches only enabled user site rules', () => {
  const globals = Array.from({ length: 25 }, (_, i) => skill(`global-${i}`));
  assert.equal(discoverUserSkills(globals).length, 25);
  assert.deepEqual(discoverUserSkills(fixture).map(row => row.skill), [global, resident]);
  for (const url of ['https://shop.example/orders/1', 'https://buyer.shop.example/orders/1']) {
    assert.deepEqual(discoverUserSkills(fixture, [url, url]).map(row => row.skill), [global, resident, site]);
  }
  for (const url of ['https://shop.example/orders/private/1', 'https://notshop.example/orders/1', 'about:blank']) {
    assert.deepEqual(discoverUserSkills(fixture, [url]).map(row => row.skill), [global, resident]);
  }
});

function catalog() {
  const definitions = new Map();
  registerAnalysisSkillsTools({ registerTool: tool => definitions.set(tool.name, tool), models: {},
    skills: { list: async () => fixture, load: async name => findBuiltinSkill(name, 'en') },
    ToolExecutionError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
  });
  return definitions;
}

test('the real list_skills tool keeps its side-panel catalog and filters direct-drive discovery by URL and scope', async () => {
  const list = catalog().get('list_skills');
  assert.equal(list.parameters.properties.url.type, 'string');
  const sidePanel = await list.execute({}, undefined, {});
  assert.deepEqual(sidePanel.names, fixture.map(row => row.name).sort());
  const drive = await list.execute({}, undefined, { externalDrive: true });
  assert.deepEqual(drive.names, ['empty-site', 'global', 'orders', 'other-site', 'resident']);
  assert.deepEqual(drive.items.find(row => row.name === site.name), summarizeSkill(site));
  const matching = await list.execute({ url: 'https://shop.example/orders/1' }, undefined, { externalDrive: true });
  assert.deepEqual(matching.names, ['global', 'orders', 'resident']);
  assert.equal(matching.count, matching.items.length);
  const siteOnly = await list.execute({ scope: 'site', url: 'https://shop.example/orders/1' }, undefined, { externalDrive: true });
  assert.deepEqual(siteOnly.names, ['orders']);
  const excluded = await list.execute({ url: 'https://shop.example/orders/private/1' }, undefined, { externalDrive: true });
  assert.deepEqual(excluded.names, ['global', 'resident']);
});

test('explicit document Skill loading stays available in direct-drive mode', async () => {
  const result = await catalog().get('load_skill').execute({ name: 'qingzhou-documents' }, undefined, { externalDrive: true });
  assert.equal(result.name, 'qingzhou-documents');
  assert.equal(result.builtin, true);
  assert.ok(result.content.length > 0);
  assert.ok(result.resources.some(resource => resource.path === 'plugin.json'));
});
