import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const PRODUCTS = new Set(['public']);
const forwardPath = value => value.split(sep).join('/');
const safePath = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value)
  && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Select thin composition facades; no core implementation is rewritten or duplicated. */
export async function readProductProfile(sourceDir, requested) {
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(sourceDir, 'products/manifest.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || requested) throw error;
    return { name: null, overrides: new Map(), includes: () => true, plugins: [] };
  }
  const name = requested ?? manifest.defaultProduct;
  if (manifest.version !== 1 || !PRODUCTS.has(name) || !Array.isArray(manifest.ports)) throw new Error('invalid product manifest or product selection');
  const overrides = new Map();
  const fragments = new Set();
  for (const port of manifest.ports) {
    if (!safePath(port.facade) || !safePath(port.entry)
      || !/^(background|shared|sidepanel)\/product\/[^/]+\.ts$/.test(port.facade)
      || !port.entry.startsWith(`${port.facade.split('/')[0]}/`) || !port.entry.endsWith('.ts')) throw new Error('invalid product composition port');
    const facade = resolve(sourceDir, port.facade);
    if (overrides.has(facade)) throw new Error(`duplicate product facade: ${port.facade}`);
    const entry = resolve(sourceDir, 'products', name, port.entry);
    await readFile(entry); // Composition entries must exist in the selected profile.
    const path = forwardPath(relative(dirname(facade), entry)).replace(/\.ts$/, '.js');
    overrides.set(facade, `export * from ${JSON.stringify(path.startsWith('.') ? path : `./${path}`)};\n`);
  }
  for (const ruleSet of manifest.rules ?? []) {
    if (!safePath(ruleSet.path) || !safePath(ruleSet.entry)
      || !/^rules\/[^/]+\.json$/.test(ruleSet.path) || !/^rules\/[^/]+\.json$/.test(ruleSet.entry)) throw new Error('invalid product rule contribution');
    const target = resolve(sourceDir, ruleSet.path);
    if (overrides.has(target)) throw new Error(`duplicate product rule contribution: ${ruleSet.path}`);
    const fragment = `products/${name}/${ruleSet.entry}`;
    const common = JSON.parse(await readFile(target, 'utf8'));
    const contribution = JSON.parse(await readFile(resolve(sourceDir, fragment), 'utf8'));
    if (!Array.isArray(common) || !Array.isArray(contribution)) throw new Error('product rule contributions must be JSON arrays');
    const rules = [...common, ...contribution];
    const ids = new Set();
    for (const rule of rules) {
      if (!Number.isSafeInteger(rule?.id) || rule.id <= 0 || ids.has(rule.id)) throw new Error('product rule ids must be unique positive integers');
      ids.add(rule.id);
    }
    overrides.set(target, `${JSON.stringify(rules.sort((a, b) => a.id - b.id), null, 2)}\n`);
    fragments.add(fragment);
  }
  const includes = path => path !== 'products/manifest.json' && !fragments.has(path)
    && (!/^products\/[^/]+\//.test(path) || path.startsWith(`products/${name}/`));
  const plugins = [{ name: 'product-composition', setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, ({ path }) => {
      if (!includes(forwardPath(relative(sourceDir, path)))) throw new Error(`inactive product import: ${forwardPath(relative(sourceDir, path))}`);
      const contents = overrides.get(path);
      return contents === undefined ? undefined : { contents, loader: 'ts', resolveDir: dirname(path) };
    });
  } }];
  return { name, overrides, includes, plugins };
}
