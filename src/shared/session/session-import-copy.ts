/** Import-button labels shared by the export page and the extension bridge. */
export const sessionImportLabelKeys = ["importQingzhou", "importing", "imported", "retryImport", "importFailedRetry"] as const;
export type SessionImportLabelKey = typeof sessionImportLabelKeys[number];
export type SessionImportLabels = Record<SessionImportLabelKey, string>;

export function readSessionImportLabels(value: unknown): SessionImportLabels | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const labels = {} as SessionImportLabels;
  for (const key of sessionImportLabelKeys) {
    const text = record[key];
    if (typeof text !== "string" || text.length === 0 || text.length > 200) return null;
    labels[key] = text;
  }
  return labels;
}

/** Failure leaves a title on the button; success and the busy state are explicit. */
export function sessionImportButtonText(state: { busy: boolean; imported: boolean; titled: boolean }, labels: SessionImportLabels): string {
  if (state.busy) return labels.importing;
  if (state.imported) return labels.imported;
  if (state.titled) return labels.retryImport;
  return labels.importQingzhou;
}
