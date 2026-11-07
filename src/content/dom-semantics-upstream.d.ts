/** The pinned upstream browser sources do not publish standalone declarations. */
export function getAriaRole(element: Element): string | null;
export function getElementAccessibleName(element: Element, includeHidden: boolean): string;
export function beginAriaCaches(): void;
export function endAriaCaches(): void;
export function isElementVisible(element: Element): boolean;
export function isElementHiddenForAria(element: Element): boolean;
export function isVisibleTextNode(node: Text): boolean;
