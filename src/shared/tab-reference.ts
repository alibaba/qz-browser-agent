/** Model references resolve to browser tab IDs; aliases are scoped to one Session. */
export const isTabAlias = (value: unknown): value is string =>
  typeof value === "string" && /^[\p{L}\p{N}_-]{1,64}$/u.test(value) && !/^[-+]?\p{N}+$/u.test(value);

export function tabReferenceId(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function normalizeTabAliases(value: unknown, ownedTabIds: readonly number[]): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([alias, id]) =>
    isTabAlias(alias) && typeof id === "number" && tabReferenceId(id) !== null && ownedTabIds.includes(id)));
}
