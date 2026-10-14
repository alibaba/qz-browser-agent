/** Increment when the disclosed data use changes and requires renewed consent. */
export const DATA_CONSENT_VERSION = 1;
export const LOCATION_CONSENT_KEY = "qz_location_consent";
export const DATA_CONSENT_KEY = "qz_data_consent";
export interface DataConsent { version: number; acceptedAt: number }
export function hasDataConsent(value: unknown): value is DataConsent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DataConsent>;
  return record.version === DATA_CONSENT_VERSION
    && typeof record.acceptedAt === "number" && Number.isFinite(record.acceptedAt) && record.acceptedAt > 0;
}
