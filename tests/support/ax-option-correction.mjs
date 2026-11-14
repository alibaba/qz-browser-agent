import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the exact private production function without overview/binding costs.
// The public tool's integration tests separately exercise its registration and frame routing.
export async function loadOptionCorrection(revision) {
  const path = 'src/capabilities/accessibility/tools.ts';
  const source = revision ? execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' }) : await readFile(path, 'utf8');
  const start = source.indexOf('async function clearStaleOptionDisabled(');
  const end = source.indexOf('/** Graft one direct child document', start);
  if (start < 0 || end < 0) throw new Error('Missing production correction function boundary');
  const { outputFiles } = await build({ stdin: { contents: `
    import { isCdpFallbackForbiddenError } from ${JSON.stringify(pathToFileURL(resolve('src/background/tools/cdp-runtime.ts')).href)};
    const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    ${source.slice(start, end)}
    export { clearStaleOptionDisabled };
  `, loader: 'ts' }, write: false, format: 'esm', platform: 'node' });
  return (await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`)).clearStaleOptionDisabled;
}

export const optionPredicate = `function() { return this.matches(':disabled') || !!this.closest('select:disabled, optgroup:disabled, [aria-disabled="true"]'); }`;

export const optionCases = `<!doctype html><html><body>
<select><option id="enabled">Enabled</option><option id="attribute" disabled>Attribute</option><option id="js">JS</option>
  <optgroup id="group" label="Group" disabled><option id="group-child">Group child</option></optgroup></select>
<select id="select" disabled><option id="select-child">Select child</option></select>
<fieldset disabled><legend><select><option id="first-legend">First legend</option></select></legend>
 <legend><select><option id="second-legend">Second legend</option></select></legend>
 <select><option id="fieldset">Fieldset</option></select></fieldset>
<fieldset disabled><legend><fieldset disabled><legend><select><option id="nested-legend">Nested legend</option></select></legend>
 <select><option id="nested-fieldset">Nested fieldset</option></select></fieldset></legend></fieldset>
<div aria-disabled="true"><select><option id="aria-ancestor">ARIA ancestor</option></select></div>
<select><option id="aria-self" aria-disabled="true">ARIA self</option><option id="aria-upper" aria-disabled="TRUE">ARIA upper</option></select>
<div id="aria-host" aria-disabled="true"></div><div id="closed-host"></div>
<div id="custom" role="option">Role only</div><button id="role-button" role="option" disabled>Button role</button>
</body></html>`;

export async function installOptionCases(page) {
  await page.setContent(optionCases);
  await page.evaluate(() => {
    document.querySelector('#js').disabled = true;
    document.querySelector('#aria-host').attachShadow({ mode: 'open' }).innerHTML = '<select><option id="open-shadow">Open shadow</option></select>';
    const closed = document.querySelector('#closed-host').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<select><option id="closed-shadow">Closed shadow</option><option id="closed-disabled" disabled>Closed disabled</option></select>';
    const custom = document.createElement('form-option');
    custom.id = 'custom-form'; custom.setAttribute('role', 'option'); custom.setAttribute('disabled', '');
    customElements.define('form-option', class extends HTMLElement { static formAssociated = true; constructor() { super(); this.attachInternals(); } });
    document.body.append(custom);
  });
}

export async function correctionNodes(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const nodes = [{ nodeId: 'root', backendDOMNodeId: root.backendNodeId, role: { value: 'RootWebArea' }, properties: [] }];
  function visit(node) {
    const attrs = Object.fromEntries(Array.from({ length: (node.attributes?.length || 0) / 2 }, (_, i) => node.attributes.slice(i * 2, i * 2 + 2)));
    if (attrs.id && (['OPTION', 'OPTGROUP'].includes(node.nodeName) || attrs.role === 'option')) nodes.push({
      nodeId: String(node.backendNodeId), backendDOMNodeId: node.backendNodeId, label: attrs.id,
      role: { value: node.nodeName === 'OPTGROUP' ? 'optgroup' : 'option' }, properties: [{ name: 'disabled', value: { value: true } }, { name: 'selected', value: { value: true } }],
    });
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
  }
  visit(root); return nodes;
}

export async function predicateOracle(cdp, nodes) {
  const values = new Map();
  try {
    for (const node of nodes.slice(1)) {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, objectGroup: 'option-oracle' });
      const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: optionPredicate, returnByValue: true });
      if (exceptionDetails) throw new Error('Oracle failed');
      values.set(node.label, result.value);
    }
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'option-oracle' }); }
  return values;
}
