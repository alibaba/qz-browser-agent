import assert from 'node:assert/strict';
import test from 'node:test';
import { mayUseTools } from '../../src/capabilities/script/tool-access.js';

for (const code of [
  'async () => document.title',
  'async () => { await new Promise(r => setTimeout(r, 400)); return document.body.innerText; }',
  'return input.title + args.suffix',
  'const x = "tools.click()"; // tools.open_tab()\n x',
  "const x = '/* tools.x */'; /* tool('x') */ x",
  'const x = "escaped \\\" tools.x"; x',
  'obj.tools; obj.tool(); obj?.tools; obj . tools',
  'const obj = { "tools": 1 }; obj.tools',
  'input.tools; args["tools"]',
  '`hello ${input.name}`',
  '`value ${"tools.x"}`',
  '/tools|tool/.test(input.text)',
  "/['\"]/g.test(input.text)",
  'const toolbox = 1, toolshed = 2, $tools = 3; toolbox + toolshed + $tools',
  '// tools.x\n/* tool() */',
]) test(`no tool API: ${code}`, () => assert.equal(mayUseTools(code), false));

for (const code of [
  'tools.click({})', 'tool("click", {})', 'tools["x"]()', 'tools?.click()',
  'const { click } = tools; click({})', 'const t = tools; t.click()',
  'typeof tools', 'const tools = {}; tools.x', '({ tools })', 'obj[tools]',
  'to\\u006fls.click()',
  '`literal tools.x`', '`literal tool()`', '`value ${tools.x()}`',
  '`// quoted "text" ${tools["x"]()}`', '`/* ${tool("x")} */`',
  '`outer ${`inner ${tools.x}`}`',
  "/['\"]/g.test(input.text); tools.x()",
  'eval(input.code)', 'Function(input.code)()', 'new Function(input.code)',
  'const e = eval; e(input.code)', '(0, eval)(input.code)', 'eval?.(input.code)',
  'window.eval(input.code)', 'window["eval"](input.code)',
  '(() => {}).constructor(input.code)()', 'obj["constructor"](input.code)',
  'with (input) { run(); }', 'import(input.url)',
  ...['globalThis', 'window', 'self', 'top', 'parent', 'frames', 'this'].flatMap(name => [
    `${name}[input.key]`, `${name}?.["tools"]`,
  ]),
  '', ' ', 'async () => {', '"unterminated', '/* unterminated', 'const x: number = 1',
  undefined, null, 42, {},
]) test(`tool API or unknown: ${String(code)}`, () => assert.equal(mayUseTools(code), true));
