export interface PageInputDelivery {
  /** Pointer or same-document submit count. Null means the receipt could not be read. Omit when this path has no receipt. */
  receipt?: number | null;
  /** A navigation commit, including a same-URL reload. */
  committed?: boolean;
  /** A same-document submit observed outside the receipt. */
  submitted?: boolean;
}

/**
 * A click or Enter is delivered when the page accepted the input, the document
 * committed, or a same-document submit ran. beforeunload and pagehide alone
 * are not delivery. An unreadable receipt is not a miss.
 */
export function pageInputDelivered({ receipt, committed = false, submitted = false }: PageInputDelivery) {
  if (committed || submitted) return true;
  if (receipt === undefined) return false;
  return receipt == null || receipt > 0;
}
