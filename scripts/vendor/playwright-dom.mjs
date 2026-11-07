import { fileURLToPath } from "node:url";

const sourcePackage = "@qz/playwright-dom-source";
const tokenizer = fileURLToPath(new URL(`../../node_modules/${sourcePackage}/packages/isomorphic/cssTokenizer.ts`, import.meta.url));

/** Keep aliases anchored to this package when compiling a relocated extension source. */
export function resolvePlaywrightDomSource({ path, importer }) {
  if (path === "#playwright-dom-role" || path === "#playwright-dom-layout") {
    return fileURLToPath(import.meta.resolve(path));
  }
  if (path !== "@isomorphic/cssTokenizer"
    || !importer.replaceAll("\\", "/").endsWith(`${sourcePackage}/packages/injected/src/roleUtils.ts`)) return null;
  return tokenizer;
}

export function playwrightDomSources() {
  return { name: "playwright-dom-sources", setup(build) {
    build.onResolve({ filter: /^(?:#playwright-dom-(?:role|layout)|@isomorphic\/cssTokenizer)$/ }, args => {
      const path = resolvePlaywrightDomSource(args);
      return path ? { path } : null;
    });
  } };
}
