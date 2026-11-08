/** A repeatable element query. A uid target always retains its original node identity. */
export interface ElementLocator {
  target?: string;
  role?: string;
  name?: string;
  text?: string;
  exact?: boolean;
  scope?: string;
  nth?: number;
}

export const elementLocatorSchema = {
  type: "object",
  properties: {
    target: { type: "string", description: "A uid: reference or css: query." },
    role: { type: "string", description: "Exact ARIA role, including implicit roles." },
    name: { type: "string", description: "Accessible name, matched exactly by default." },
    text: { type: "string", description: "Element text, matched exactly by default." },
    exact: { type: "boolean", description: "Exact normalized text/name match (default true); false matches a substring." },
    scope: { type: "string", description: "A uid: or css: search root. Frame document references scope the query to that frame." },
    nth: { type: "integer", minimum: 0, description: "Explicit zero-based match index; otherwise a single match is required." },
  },
  additionalProperties: false,
} as const;

export function locatorReferences(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const query = value as ElementLocator;
  return [query.target, query.scope].filter((item): item is string => typeof item === "string" && !!item);
}

export function validateElementLocator(value: unknown): asserts value is ElementLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pass an element locator object.");
  const query = value as Record<string, unknown>;
  const allowedFields = Object.keys(elementLocatorSchema.properties);
  const invalidFields = Object.keys(query).filter(key => !allowedFields.includes(key));
  if (invalidFields.length) throw Object.assign(new Error(
    `Unknown element locator field${invalidFields.length === 1 ? "" : "s"}: ${invalidFields.map(key => JSON.stringify(key)).join(", ")}. Supported fields: ${allowedFields.join(", ")}.`,
  ), { details: { invalidFields, allowedFields } });
  for (const key of ["target", "role", "name", "text", "scope"]) {
    if (query[key] !== undefined && (typeof query[key] !== "string" || !query[key].trim())) {
      throw new Error(`Locator ${key} must be a non-empty string.`);
    }
  }
  if (!["target", "role", "name", "text"].some(key => query[key] !== undefined)) {
    throw new Error("A locator requires target, role, name, or text.");
  }
  if (query.exact !== undefined && typeof query.exact !== "boolean") throw new Error("Locator exact must be a boolean.");
  if (query.nth !== undefined && (!Number.isInteger(query.nth) || Number(query.nth) < 0)) {
    throw new Error("Locator nth must be a non-negative integer.");
  }
  if (query.scope !== undefined && typeof query.target === "string" && /^uid:/i.test(query.target.trim())) {
    throw new Error("A uid already identifies its node and frame; omit locator scope.");
  }
}
