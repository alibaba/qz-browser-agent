import { beginAriaCaches, endAriaCaches, getAriaRole, getElementAccessibleName, isElementHiddenForAria } from "#playwright-dom-role";
import { isElementVisible, isVisibleTextNode } from "#playwright-dom-layout";

/** Role, name and rendering semantics share the pinned browser implementation. */
export function elementAriaRole(element: Element): string {
  return getAriaRole(element) || "";
}

export function elementAccessibleName(element: Element): string {
  return getElementAccessibleName(element, false);
}

export const elementIsVisible = isElementVisible;
export const elementIsHiddenForAria = isElementHiddenForAria;
export const textNodeIsVisible = isVisibleTextNode;

/** Caches belong to one synchronous observation, never to a later DOM state. */
export function withDomSemantics<T>(read: () => T): T {
  beginAriaCaches();
  try { return read(); }
  finally { endAriaCaches(); }
}
