/** A repeatable element query. A uid target always retains its original node identity. */
export interface ElementLocator {
  target?: string;
  role?: string;
  name?: string;
  text?: string;
  exact?: boolean;
  within?: string;
  nth?: number;
  includeHidden?: boolean;
}

export const elementLocatorSchema = {
  type: "object",
  properties: {
    target: { type: "string", description: "A uid: reference or css: query." },
    role: { type: "string", description: "Exact ARIA role, including implicit roles." },
    name: { type: "string", description: "Accessible name, matched exactly by default." },
    text: { type: "string", description: "Element text, matched exactly by default." },
    exact: { type: "boolean", description: "Exact normalized text/name match (default true); false matches a substring." },
    within: { type: "string", description: "Search only inside this uid: or css: element. A frame document reference limits the query to that frame." },
    nth: { type: "integer", minimum: 0, description: "Explicit zero-based match index; otherwise a single match is required." },
    includeHidden: { type: "boolean", description: "Also match hidden elements in role/name/text queries, including in nth and counts; a target always matches them. Default: false." },
  },
  additionalProperties: false,
} as const;

export const elementNthSchema = {
  type: "integer", minimum: 0,
  description: "0-based match index when a css: target matches multiple elements. Default: 0. With locator, use locator.nth.",
} as const;

/** Hidden compatibility: the retired locator field scope is within. */
export function normalizeElementLocator<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "scope")) return value;
  const { scope, ...query } = value as Record<string, unknown>;
  return (Object.hasOwn(query, "within") ? query : { ...query, within: scope }) as T;
}

export function locatorReferences(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const query = normalizeElementLocator(value) as ElementLocator;
  return [query.target, query.within].filter((item): item is string => typeof item === "string" && !!item);
}

export function validateElementLocator(value: unknown): asserts value is ElementLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pass an element locator object.");
  const query = value as Record<string, unknown>;
  const allowedFields = Object.keys(elementLocatorSchema.properties);
  const invalidFields = Object.keys(query).filter(key => !allowedFields.includes(key));
  if (invalidFields.length) throw Object.assign(new Error(
    `Unknown element locator field${invalidFields.length === 1 ? "" : "s"}: ${invalidFields.map(key => JSON.stringify(key)).join(", ")}. Supported fields: ${allowedFields.join(", ")}.`,
  ), { details: { invalidFields, allowedFields } });
  for (const key of ["target", "role", "name", "text", "within"]) {
    if (query[key] !== undefined && (typeof query[key] !== "string" || !query[key].trim())) {
      throw new Error(`Locator ${key} must be a non-empty string.`);
    }
  }
  if (!["target", "role", "name", "text"].some(key => query[key] !== undefined)) {
    throw new Error("A locator requires target, role, name, or text.");
  }
  if (query.exact !== undefined && typeof query.exact !== "boolean") throw new Error("Locator exact must be a boolean.");
  if (query.includeHidden !== undefined && typeof query.includeHidden !== "boolean") throw new Error("Locator includeHidden must be a boolean.");
  if (query.nth !== undefined && (!Number.isInteger(query.nth) || Number(query.nth) < 0)) {
    throw new Error("Locator nth must be a non-negative integer.");
  }
  if (query.within !== undefined && typeof query.target === "string" && /^uid:/i.test(query.target.trim())) {
    throw new Error("A uid already identifies its node and frame; omit locator within.");
  }
}
