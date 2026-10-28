/**
 * Walk light DOM and nested open shadow roots.
 *
 * querySelectorAll, textContent, and cloneNode stay in the light tree, so
 * article text, tables, and element search never saw open-shadow content.
 * Closed roots are not readable; leave them alone.
 */

export interface OpenShadowComposeOptions {
  /** Omit this element and everything inside it, including its open shadow. */
  includeElement?: (element: Element) => boolean;
}

/** Open shadow root, or null when the element has none or the root is closed. */
export function openShadowRoot(element: Element): ShadowRoot | null {
  if (!element || element.nodeType !== 1) return null;
  try {
    const root = element.shadowRoot;
    if (!root || root.mode !== "open") return null;
    return root;
  } catch {
    return null;
  }
}

/**
 * Visit root, its light descendants, and elements inside nested open shadow
 * roots. Light-DOM order is unchanged; a host's shadow tree follows that
 * host's light subtree. Depth is unbounded (MDN's compat table is two hosts).
 */
export function eachElementWithinOpenShadow(root: Element, visit: (element: Element) => void): void {
  const seen = new Set<Element>();
  const walk = (element: Element) => {
    if (seen.has(element)) return;
    seen.add(element);
    visit(element);
    for (const child of element.children) walk(child);
    const shadow = openShadowRoot(element);
    if (!shadow) return;
    for (const child of shadow.children) walk(child);
  };
  walk(root);
}

/** First element matching selector in light DOM or a nested open shadow, in walk order. */
export function firstElementMatchingOpenShadow(root: Element, selector: string): Element | null {
  let found: Element | null = null;
  eachElementWithinOpenShadow(root, (element) => {
    if (!found && element.matches(selector)) found = element;
  });
  return found;
}

/**
 * Copy open-shadow content onto a fresh cloneNode tree.
 * Existing light children stay in place. Shadow content is appended. Slots do
 * not copy assigned nodes, because those nodes are already the light children.
 */
export function graftOpenShadows(source: Element, clone: Element, options?: OpenShadowComposeOptions): void {
  const sourceChildren = [...source.childNodes];
  const cloneChildren = [...clone.childNodes];
  const count = Math.min(sourceChildren.length, cloneChildren.length);
  for (let index = 0; index < count; index += 1) {
    const sourceChild = sourceChildren[index];
    const cloneChild = cloneChildren[index];
    if (sourceChild?.nodeType === 1 && cloneChild?.nodeType === 1) {
      graftOpenShadows(sourceChild as Element, cloneChild as Element, options);
    }
  }
  appendOpenShadowContent(source, clone, options);
}

/**
 * Append one element's open shadow tree to its paired clone.
 * Use this after a walk that already handled light children, including when
 * that walk removed hidden light nodes and the child lists no longer line up.
 */
export function appendOpenShadowContent(source: Element, clone: Element, options?: OpenShadowComposeOptions): void {
  const shadow = openShadowRoot(source);
  if (!shadow) return;
  for (const child of shadow.childNodes) {
    const cloned = composeNode(child, options, true, false, new Set());
    if (cloned) clone.append(cloned);
  }
}

function composeNode(
  node: Node,
  options: OpenShadowComposeOptions | undefined,
  insideShadow: boolean,
  projectSlots: boolean,
  stack: Set<Node>,
): Node | null {
  if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) return node.cloneNode(false);
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  if (stack.has(element)) return null;
  if (insideShadow && element.tagName === "SLOT") {
    if (options?.includeElement && !options.includeElement(element)) return null;
    return composeSlot(element as HTMLSlotElement, options, projectSlots, stack);
  }
  if (options?.includeElement && !options.includeElement(element)) return null;
  stack.add(element);
  try {
    const clone = element.cloneNode(false) as Element;
    const shadow = openShadowRoot(element);
    if (shadow) {
      for (const child of shadow.childNodes) {
        const cloned = composeNode(child, options, true, true, stack);
        if (cloned) clone.append(cloned);
      }
      return clone;
    }
    if (element.tagName === "TEMPLATE") {
      const content = (element as HTMLTemplateElement).content;
      const cloneContent = (clone as HTMLTemplateElement).content;
      for (const child of content.childNodes) {
        const cloned = composeNode(child, options, insideShadow, projectSlots, stack);
        if (cloned) cloneContent.append(cloned);
      }
      return clone;
    }
    for (const child of element.childNodes) {
      const cloned = composeNode(child, options, insideShadow, projectSlots, stack);
      if (cloned) clone.append(cloned);
    }
    return clone;
  } finally {
    stack.delete(element);
  }
}

function composeSlot(
  slot: HTMLSlotElement,
  options: OpenShadowComposeOptions | undefined,
  projectSlots: boolean,
  stack: Set<Node>,
): DocumentFragment | null {
  let assigned: Node[] = [];
  try {
    assigned = typeof slot.assignedNodes === "function" ? [...slot.assignedNodes({ flatten: true })] : [];
  } catch {
    assigned = [];
  }
  if (assigned.length && !projectSlots) return null;
  const children = assigned.length ? assigned : [...slot.childNodes];
  const fragment = slot.ownerDocument.createDocumentFragment();
  const childInsideShadow = assigned.length === 0;
  for (const child of children) {
    const cloned = composeNode(child, options, childInsideShadow, true, stack);
    if (cloned) fragment.append(cloned);
  }
  return fragment.childNodes.length ? fragment : null;
}
