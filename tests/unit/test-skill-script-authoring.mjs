import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { scriptExecutionFixture } from '../support/script-execution-fixture.mjs';
import { findBuiltinSkill } from '../../src/shared/skills/builtin-skills.js';
import {
  getActiveSkillToolSchemasSync,
} from '../../src/background/skills/skill-tool-runtime.js';

const blocks = (content, language) => [...content.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map(match => match[1]);

for (const language of ['en', 'zh-CN']) test(`${language} authored Skill examples run outside pages with explicit page arguments`, async () => {
  const workbench = findBuiltinSkill('skill-workbench', language).content;
  const site = findBuiltinSkill('site-skill-author', language).content;
  for (const content of [workbench, site]) {
    assert.doesNotMatch(content, /runtime:\s*"(?:page|inner)"|"needsPage":\s*true/);
    for (const manifest of blocks(content, 'json').map(JSON.parse)) {
      for (const tool of manifest.tools || []) if (tool.script) assert.equal(tool.runtime, 'script');
    }
  }
  const workbenchManifest = blocks(workbench, 'json').map(JSON.parse).find(value => value.id === 'page-inspector');
  const siteManifest = blocks(site, 'json').map(JSON.parse).find(value => value.id === 'example-site-tools');
  const scripts = [blocks(workbench, 'js')[0], ...blocks(site, 'js')];
  assert.equal(scripts.length, 3);
  for (const [index, script] of scripts.entries()) {
    const manifest = structuredClone(index === 0 ? workbenchManifest : siteManifest);
    const tool = manifest.tools[0];
    const skill = { format: 'qingzhou.skill', schemaVersion: 2, name: 'authored-example', scope: 'resident', resources: [
      { path: 'plugin.json', type: 'json', content: JSON.stringify(manifest) },
      { path: tool.script, type: 'script', content: script },
    ] };
    const before = JSON.stringify(skill);
    const calls = [];
    const fixture = await scriptExecutionFixture([skill], async message => {
      assert.equal(message.type, 'tool_call', 'no DOM or authenticated fetch runs in the outer worker');
      assert.equal(message.toolName, 'evaluate');
      assert.equal(message.args.tabRef, 'research');
      calls.push(message);
      const page = {
        document: { title: 'Example', cookie: 'session=test', scripts: [], body: { innerText: 'Example text' },
          querySelectorAll: () => [{ innerText: ' Link ', href: 'https://example.com/link' }] },
        location: { href: 'https://example.com/research' }, window: {}, URL,
        async fetch(url, options) {
          assert.equal(url, 'https://example.com/api/hot');
          assert.equal(options.credentials, 'include');
          return { ok: true, status: 200, json: async () => ({ data: { items: [
            { title: 'One', author: 'Author', url: '/one' }, { title: 'Two', url: '/two' },
          ] } }) };
        },
      };
      // A fresh page realm catches accidental closures over outer args, tools or local variables.
      const result = await runInNewContext(`(${message.args.code})`, page)(message.args.args);
      return JSON.parse(JSON.stringify(result));
    });
    assert.equal(JSON.stringify(skill), before, 'registration never rewrites the authored package');
    const schema = getActiveSkillToolSchemasSync({ language })[0].function;
    assert.deepEqual(schema.parameters.required, ['tabRef']);
    const execute = limit => fixture.execute(schema.name, { tabRef: 'research', limit });
    const receipt = await execute(1);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.deepEqual(receipt.trace ?? [], [], 'successful examples do not emit automatic trace');
    const result = receipt.result;
    assert.equal(calls.length, 1, JSON.stringify(result));
    if (index === 0) assert.deepEqual(result, { title: 'Example', url: 'https://example.com/research',
      linkCount: 1, textLength: 12, links: [{ text: 'Link', href: 'https://example.com/link' }] });
    else if (index === 1) assert.deepEqual(result.cookies, ['session']);
    else {
      assert.equal(result.count, 1);
      assert.equal(result.rows[0].url, 'https://example.com/one');
      const invalid = await execute(51);
      assert.equal(invalid.ok, true, 'an authored validation result is business data');
      assert.equal(invalid.result.code, 'ARGUMENT');
      assert.equal(calls.length, 1, 'invalid arguments never enter the page');
    }
  }
});
