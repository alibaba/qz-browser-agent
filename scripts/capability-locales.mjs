import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse } from "acorn";
import { transformSync } from "esbuild";
import { chromeMessageId, encodeChromeMessage, HISTORICAL_LABELS_MESSAGE_ID } from "../src/shared/i18n/definition.ts";
import { validateExtensionBoundaries } from "./extension-boundaries.mjs";

const posix = value => value.split(sep).join("/");
const inside = (parent, path) => path === parent || path.startsWith(`${parent}${sep}`);
const parameters = value => [...new Set([...value.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(match => match[1]))].sort().join(",");

/** Language catalogs are data assets. Build consumes them; runtime imports only small descriptors. */
export function capabilityLocaleAssets(sourceDir, { entries, includes = () => true } = {}) {
  sourceDir = realpathSync(sourceDir);
  entries ??= validateExtensionBoundaries(sourceDir).entries.locales;
  const resources = new Set();
  const assets = new Map();
  if (!entries.length) return { resources, assets };
  const { baseline, historicalLabels } = readTranslationSource(sourceDir, includes);
  const labelAliases = new Map();
  for (const [key, labels] of historicalLabels) {
    const english = baseline.get(key);
    if (!labelAliases.has(english)) labelAliases.set(english, new Set());
    for (const label of labels) labelAliases.get(english).add(label);
  }
  const nativeCatalogs = new Map();
  const knownNamespaces = new Set([...baseline.keys()].map(key => key.split(".")[0]));
  const manifest = JSON.parse(readFileSync(resolve(sourceDir, "manifest.json"), "utf8"));
  const defaultFile = resolve(sourceDir, "_locales", manifest.default_locale || "en", "messages.json");
  const defaultMessages = existsSync(defaultFile) ? readNativeMessages(defaultFile) : {};
  for (const [key, value] of Object.entries(defaultMessages)) baseline.set(`manifest.${key}`, value.message);
  knownNamespaces.add("manifest");
  const languages = new Set(), chromeLocales = new Set(), selectors = new Map();
  for (const entry of entries) {
    const declaration = moduleAst(entry).body;
    if (declaration.length !== 1 || declaration[0].type !== "ExportDefaultDeclaration") {
      throw new Error(`Language packs must export a literal array with type-only imports: ${entry}`);
    }
    const packs = literalValue(declaration[0].declaration, entry);
    if (!Array.isArray(packs)) throw new Error(`Language packs must export an array: ${entry}`);
    const packageDir = resolve(sourceDir, "capabilities", relative(resolve(sourceDir, "capabilities"), entry).split(sep)[0]);
    for (const pack of packs) {
      validatePack(pack, entry);
      const canonicalLanguage = Intl.getCanonicalLocales(pack.language)[0];
      if (languages.has(canonicalLanguage.toLowerCase()) || chromeLocales.has(pack.chromeLocale.toLowerCase())) {
        throw new Error(`Duplicate language pack: ${pack.language} (${entry})`);
      }
      languages.add(canonicalLanguage.toLowerCase());
      chromeLocales.add(pack.chromeLocale.toLowerCase());
      for (const tag of [pack.language, ...(pack.aliases || [])]) {
        let canonical;
        try { canonical = Intl.getCanonicalLocales(tag)[0]; }
        catch { throw new Error(`Invalid language alias: ${tag} (${entry})`); }
        if (canonical !== tag) throw new Error(`Use canonical language tag ${canonical}, not ${tag} (${entry})`);
        const previous = selectors.get(canonical.toLowerCase());
        if (previous && previous !== pack.language) throw new Error(`Conflicting language alias: ${tag} (${previous}, ${pack.language})`);
        selectors.set(canonical.toLowerCase(), pack.language);
      }
      const destination = resolve(sourceDir, "_locales", pack.chromeLocale, "messages.json");
      const messages = existsSync(destination) ? readNativeMessages(destination) : { ...defaultMessages };
      if (existsSync(destination)) resources.add(destination);
      messages.qz_language = { message: pack.language };
      const translated = new Map();
      if (pack.catalog) {
        if (pack.catalog.includes("\\") || !/^\.{1,2}\//.test(pack.catalog)) throw new Error(`Invalid language catalog path: ${pack.catalog} (${entry})`);
        const catalogPath = resolve(dirname(entry), pack.catalog);
        if (!inside(packageDir, catalogPath)) throw new Error(`Language catalog must stay inside its package: ${pack.catalog} (${entry})`);
        if (!lstatSync(catalogPath).isDirectory() && !catalogPath.endsWith(".json")) throw new Error(`Language catalog must be a JSON file or directory: ${catalogPath}`);
        for (const file of catalogFiles(catalogPath, packageDir)) {
          resources.add(file);
          const text = readFileSync(file, "utf8");
          JSON.parse(text); // JSON syntax, not the broader JavaScript literal grammar.
          const catalog = literalValue(parse(`(${text})`, { ecmaVersion: "latest" }).body[0].expression, file);
          if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") throw new Error(`Language catalog must be an object: ${file}`);
          for (const [key, value] of Object.entries(catalog)) {
            if (!/^[a-z][a-z0-9-]*\..+$/.test(key) || typeof value !== "string" || !value.trim()) {
              throw new Error(`Invalid language message: ${key} (${file})`);
            }
            if (translated.has(key)) throw new Error(`Duplicate language message: ${key} (${file})`);
            translated.set(key, value);
          }
        }
      }
      for (const [key, value] of translated) {
        // Uninstalled capabilities and inactive product copy do not enter the selected build.
        if (!knownNamespaces.has(key.split(".")[0])) continue;
        if (!baseline.has(key)) throw new Error(`Unknown language message: ${key} (${entry})`);
        if (parameters(value) !== parameters(baseline.get(key))) throw new Error(`Translation parameters differ: ${pack.language} ${key}`);
        const manifestMessage = key.startsWith("manifest.");
        const name = manifestMessage ? key.slice("manifest.".length) : chromeMessageId(key);
        messages[name] = encodeChromeMessage(value, { substitutions: !manifestMessage });
        if (historicalLabels.has(key)) labelAliases.get(baseline.get(key)).add(value);
      }
      nativeCatalogs.set(destination, messages);
    }
  }
  const aliases = Object.fromEntries([...labelAliases].sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([label, values]) => [label, [...values].sort((a, b) => a.localeCompare(b, "en"))]));
  for (const [destination, messages] of nativeCatalogs) {
    if (labelAliases.size) messages[HISTORICAL_LABELS_MESSAGE_ID] = encodeChromeMessage(JSON.stringify(aliases));
    assets.set(destination, `${JSON.stringify(Object.fromEntries(Object.entries(messages).sort(([a], [b]) => a.localeCompare(b, "en"))), null, 2)}\n`);
  }
  return { resources, assets };
}

function validatePack(pack, file) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)
    || Object.keys(pack).some(key => !["language", "chromeLocale", "name", "aliases", "direction", "catalog"].includes(key))
    || typeof pack.language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(pack.language)
    || typeof pack.chromeLocale !== "string" || !/^[a-z]{2,3}(?:_(?:[A-Z][A-Za-z0-9]{1,7}|[0-9]{3}))*$/.test(pack.chromeLocale)
    || typeof pack.name !== "string" || !pack.name.trim()
    || (pack.direction !== undefined && !["ltr", "rtl"].includes(pack.direction))
    || (pack.aliases !== undefined && (!Array.isArray(pack.aliases) || pack.aliases.some(value => typeof value !== "string" || !value.trim())))
    || (pack.catalog !== undefined && (typeof pack.catalog !== "string" || !pack.catalog))) {
    throw new Error(`Invalid language pack: ${file}`);
  }
  try { Intl.getCanonicalLocales(pack.language); }
  catch { throw new Error(`Invalid language tag: ${pack.language} (${file})`); }
  const chromeLanguage = Intl.getCanonicalLocales(pack.chromeLocale.replaceAll("_", "-"))[0];
  if (chromeLanguage !== Intl.getCanonicalLocales(pack.language)[0]) throw new Error(`Language and Chrome locale differ: ${pack.language} / ${pack.chromeLocale}`);
}

function catalogFiles(path, packageDir) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !inside(realpathSync(packageDir), realpathSync(path))) throw new Error(`Language catalog symlink is not allowed: ${path}`);
  if (stat.isDirectory()) return readdirSync(path).sort().flatMap(name => catalogFiles(resolve(path, name), packageDir));
  if (!stat.isFile()) throw new Error(`Invalid language catalog resource: ${path}`);
  return path.endsWith(".json") ? [path] : [];
}

function readNativeMessages(file) {
  const messages = JSON.parse(readFileSync(file, "utf8"));
  if (!messages || Array.isArray(messages) || typeof messages !== "object"
    || Object.values(messages).some(value => !value || typeof value.message !== "string")) throw new Error(`Invalid Chrome messages: ${file}`);
  return messages;
}

/** Read only literal message definitions, never execute a capability or a model prompt. */
export function readTranslationBaseline(sourceDir, includes = () => true) {
  return readTranslationSource(sourceDir, includes).baseline;
}

/** Authored language objects for the same literal definitions. Keys are qualified message ids. */
export function readTranslationVariants(sourceDir, includes = () => true) {
  return readTranslationSource(sourceDir, includes).variants;
}

function readTranslationSource(sourceDir, includes) {
  const messages = new Map();
  const variants = new Map();
  const historicalLabels = new Map();
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`extension files must not be symlinks: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!name.startsWith(".") && !["node_modules", "vendor", "_metadata"].includes(name)) visit(resolve(path, name));
      return;
    }
    if (!path.endsWith(".ts") || !includes(posix(relative(sourceDir, path)))) return;
    const source = readFileSync(path, "utf8");
    if (!source.includes("defineMessages")) return;
    const ast = moduleAst(path, source);
    const definitions = new Set(ast.body.flatMap(node => node.type === "ImportDeclaration"
      ? node.specifiers.filter(item => item.type === "ImportSpecifier" && item.imported.name === "defineMessages").map(item => item.local.name) : []));
    const walk = node => {
      if (!node || typeof node !== "object") return;
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && definitions.has(node.callee.name)) {
        const namespace = literalValue(node.arguments[0], path), catalog = literalValue(node.arguments[1], path);
        if (typeof namespace !== "string" || !catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error(`Translation baseline must be literal: ${path}`);
        const options = node.arguments[2] ? literalValue(node.arguments[2], path) : {};
        if (!options || typeof options !== "object" || Array.isArray(options)
          || Object.keys(options).some(key => key !== "historicalLabels")
          || (options.historicalLabels !== undefined && (!Array.isArray(options.historicalLabels)
            || options.historicalLabels.some(key => typeof key !== "string" || !Object.hasOwn(catalog, key))))) {
          throw new Error(`Historical labels must reference declared message keys: ${path}`);
        }
        for (const [key, value] of Object.entries(catalog)) {
          const qualified = `${namespace}.${key}`;
          if (messages.has(qualified)) throw new Error(`Duplicate translation baseline: ${qualified}`);
          if (!value || typeof value.en !== "string") throw new Error(`Translation requires an English fallback: ${qualified}`);
          messages.set(qualified, value.en);
          variants.set(qualified, value);
          if (options.historicalLabels?.includes(key)) {
            const labels = Object.values(value);
            if (labels.some(label => typeof label !== "string" || !label.trim() || parameters(label))) {
              throw new Error(`Historical labels must be fixed strings: ${qualified} (${path})`);
            }
            historicalLabels.set(qualified, labels);
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") walk(value);
      }
    };
    walk(ast);
  };
  visit(sourceDir);
  return { baseline: messages, historicalLabels, variants };
}

function moduleAst(file, source = readFileSync(file, "utf8")) {
  const { code } = transformSync(source, { loader: "ts", target: "esnext", tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } });
  return parse(code, { ecmaVersion: "latest", sourceType: "module" });
}

function literalValue(node, file) {
  if (node?.type === "Literal" && !node.regex) return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node?.type === "ArrayExpression") return node.elements.map(item => literalValue(item, file));
  if (node?.type === "ObjectExpression") {
    const entries = new Map();
    for (const item of node.properties) {
      if (item.type !== "Property" || item.computed || item.kind !== "init" || item.method || item.shorthand) throw new Error(`Expected plain literal data: ${file}`);
      const key = item.key.type === "Identifier" ? item.key.name : literalValue(item.key, file);
      if (entries.has(key)) throw new Error(`Duplicate literal key: ${key} (${file})`);
      entries.set(key, literalValue(item.value, file));
    }
    return Object.fromEntries(entries);
  }
  throw new Error(`Expected literal data: ${file}`);
}
