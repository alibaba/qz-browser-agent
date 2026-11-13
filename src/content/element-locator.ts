import { validateElementLocator, type ElementLocator } from "../shared/contracts/element-locator.js";
import { eachElementWithinOpenShadow, openShadowRoot } from "./open-shadow.js";

interface ElementSemantics {
  role(element: Element): string;
  name(element: Element, includeHidden: boolean): string;
  visible(element: Element): boolean;
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

/** How a match covers a field value: 0 the whole value, 1 its start, 2 elsewhere. */
export function matchTier(value: string, index: number, length: number): number {
  if (index !== 0) return 2;
  return length === value.length ? 0 : 1;
}

/**
 * The one match order shared by locator nth and find_elements: ascending tier, ties in tree order.
 * Only fuzzy matches (exact: false or a find pattern) carry a nonzero tier.
 */
export function orderElementMatches<T>(matches: T[], tier: (match: T) => number): T[] {
  return matches.map((match, order) => ({ match, order, tier: tier(match) }))
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .map(entry => entry.match);
}

/**
 * The match list shared by locators and find_elements. Hidden elements are dropped unless includeHidden is
 * true, before any other rule, so a hidden node never displaces a visible one; with includeHidden, names
 * also count hidden content. name and text compare
 * whitespace-normalized values exactly (case-sensitive) unless exact is false, which matches a substring.
 * Unless the caller has already narrowed candidates, a text-only query keeps the smallest matching nodes
 * rather than every ancestor whose aggregate text contains the phrase. Matches are returned in
 * orderElementMatches order.
 */
export function matchElementQuery(
  candidates: Element[], query: Pick<ElementLocator, "role" | "name" | "text" | "exact" | "includeHidden">,
  semantics: ElementSemantics, narrowed = false,
): Element[] {
  const fieldTier = (actual: string, expected: string) => {
    const value = normalize(actual);
    const wanted = normalize(expected);
    if (query.exact !== false) return value === wanted ? 0 : -1;
    const index = value.indexOf(wanted);
    return index < 0 ? -1 : matchTier(value, index, wanted.length);
  };
  const tiers = new Map<Element, number>();
  const matches = candidates.filter(element => {
    if (!element.isConnected || query.role !== undefined && semantics.role(element) !== query.role) return false;
    if (query.includeHidden !== true && !semantics.visible(element)) return false;
    const name = query.name === undefined ? 0 : fieldTier(semantics.name(element, query.includeHidden === true), query.name);
    if (name < 0) return false;
    const text = query.text === undefined ? 0 : fieldTier(element.textContent || "", query.text);
    if (text < 0) return false;
    tiers.set(element, Math.max(name, text));
    return true;
  });
  const byTier = (element: Element) => tiers.get(element) ?? 0;
  if (query.text === undefined || narrowed || query.role !== undefined || query.name !== undefined) {
    return orderElementMatches(matches, byTier);
  }
  const ancestors = new Set<Element>();
  for (const element of matches) {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
  }
  return orderElementMatches(matches.filter(element => !ancestors.has(element)), byTier);
}

/**
 * nth indexes the shared match list and ambiguity counts it. A target names its nodes explicitly, so with a
 * target (css, or a pinned uid via matchSelf) hidden nodes always match; role/name/text only narrow them.
 */
export function resolveElementLocator(
  root: Element | Document, locator: ElementLocator, semantics: ElementSemantics,
  { matchSelf = false, all = false, limit = 20 }: { matchSelf?: boolean; all?: boolean; limit?: number } = {},
): { matched: number; element?: Element; elements?: Element[] } {
  try { validateElementLocator(matchSelf && locator ? { target: "css:*", ...locator } : locator); }
  catch (error) { throw failure("INVALID_ELEMENT_LOCATOR", error instanceof Error ? error.message : String(error)); }
  let queryRoot = root;
  let candidates = matchSelf && root.nodeType === 1 ? [root as Element] : allElements(root);
  if (locator.within) {
    const roots = cssMatches(queryRoot, candidates, locator.within);
    if (roots.length > 1) throw failure("AMBIGUOUS_ELEMENT", "The locator within matches multiple elements.", roots.length);
    if (roots[0]) queryRoot = roots[0];
    candidates = roots.length ? allElements(roots[0]!) : [];
  }
  if (locator.target) candidates = cssMatches(queryRoot, candidates, locator.target);
  const query = matchSelf || locator.target !== undefined ? { ...locator, includeHidden: true } : locator;
  const matches = matchElementQuery(candidates, query, semantics, locator.target !== undefined);
  const selected = locator.nth === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : matches[locator.nth];
  if (all) {
    const items = locator.nth === undefined ? matches : selected ? [selected] : [];
    return { matched: matches.length, elements: items.slice(0, Math.max(1, Math.min(100, Math.trunc(limit) || 20))) };
  }
  return { matched: matches.length, ...(selected ? { element: selected } : {}) };
}
