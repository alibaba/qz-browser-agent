import { validateElementLocator, type ElementLocator } from "../shared/contracts/element-locator.js";
import { eachElementWithinOpenShadow, openShadowRoot } from "./open-shadow.js";

interface ElementSemantics {
  role(element: Element): string;
  name(element: Element): string;
}

function failure(code: string, message: string, matched?: number): Error {
  return Object.assign(new Error(message), { code, ...(matched === undefined ? {} : { matched }) });
}

export function invalidCssTargetError(target: string, cause: unknown) {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return Object.assign(new Error(message), { code: "INVALID_SELECTOR", details: { target } });
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cssTarget(target: string): string {
  if (target.startsWith("uid:")) throw failure("INVALID_ELEMENT_LOCATOR", "Resolve a uid reference before querying its element.");
  return target.startsWith("css:") ? target.slice(4) : target;
}

function allElements(root: Element | Document): Element[] {
  const element = root.nodeType === 9 ? (root as Document).documentElement : root as Element;
  const elements: Element[] = [];
  if (element) eachElementWithinOpenShadow(element, node => elements.push(node));
  return elements;
}

function cssMatches(root: Element | Document, elements: Element[], target: string): Element[] {
  const selector = cssTarget(target);
  try {
    // Native queries bind :scope to the query root, not to each candidate.
    // The root itself remains eligible, matching semantic locator scopes.
    const matched = new Set(root.querySelectorAll(selector));
    if (root.nodeType === 1 && (root as Element).matches(selector)) matched.add(root as Element);
    for (const element of elements) {
      const shadow = openShadowRoot(element);
      if (shadow) for (const match of shadow.querySelectorAll(selector)) matched.add(match);
    }
    return elements.filter(element => matched.has(element));
  } catch (error) {
    throw invalidCssTargetError(target, error);
  }
}

/** Strict queries keep tree order and hidden nodes; discovery ranking is deliberately separate. */
export function resolveElementLocator(
  root: Element | Document, locator: ElementLocator, semantics: ElementSemantics,
  { matchSelf = false, all = false, limit = 20 }: { matchSelf?: boolean; all?: boolean; limit?: number } = {},
): { matched: number; element?: Element; elements?: Element[] } {
  try { validateElementLocator(matchSelf && locator ? { target: "css:*", ...locator } : locator); }
  catch (error) { throw failure("INVALID_ELEMENT_LOCATOR", error instanceof Error ? error.message : String(error)); }
  let queryRoot = root;
  let candidates = matchSelf && root.nodeType === 1 ? [root as Element] : allElements(root);
  if (locator.scope) {
    const roots = cssMatches(queryRoot, candidates, locator.scope);
    if (roots.length > 1) throw failure("AMBIGUOUS_ELEMENT", "The locator scope matches multiple elements.", roots.length);
    if (roots[0]) queryRoot = roots[0];
    candidates = roots.length ? allElements(roots[0]!) : [];
  }
  if (locator.target) candidates = cssMatches(queryRoot, candidates, locator.target);
  const matchesText = (actual: string, expected: string) => locator.exact === false
    ? normalize(actual).includes(normalize(expected)) : normalize(actual) === normalize(expected);
  let matches = candidates.filter(element => element.isConnected
    && (locator.role === undefined || semantics.role(element) === locator.role)
    && (locator.name === undefined || matchesText(semantics.name(element), locator.name))
    && (locator.text === undefined || matchesText(element.textContent || "", locator.text)));
  // Text-only queries identify the smallest matching nodes, rather than every
  // ancestor whose aggregate text happens to contain the same phrase.
  if (locator.text !== undefined && locator.target === undefined && locator.role === undefined && locator.name === undefined) {
    const ancestors = new Set<Element>();
    for (const element of matches) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
    }
    matches = matches.filter(element => !ancestors.has(element));
  }
  const selected = locator.nth === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : matches[locator.nth];
  if (all) {
    const items = locator.nth === undefined ? matches : selected ? [selected] : [];
    return { matched: matches.length, elements: items.slice(0, Math.max(1, Math.min(100, Math.trunc(limit) || 20))) };
  }
  return { matched: matches.length, ...(selected ? { element: selected } : {}) };
}
