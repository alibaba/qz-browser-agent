export type BackgroundApi = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
type FrozenApi<T extends BackgroundApi> = { readonly [K in keyof T]: Readonly<T[K]> };
/**
 * Creates the one business-command surface shared by background transports.
 * Namespaces contain already-bound functions; transports may adapt envelopes,
 * but they never receive repositories, Agents, or mutable Session handles.
 */
export function createBackgroundApi<T extends BackgroundApi>(namespaces: T, beforeCall?: (path: string) => void) {
  if (!isPlainObject(namespaces)) throw new TypeError("background API namespaces are required");
  const api: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [namespace, methods] of Object.entries(namespaces)) {
    if (!isPlainObject(methods)) throw new TypeError(`background API namespace must be an object: ${namespace}`);
    const normalized: Record<string, unknown> = {};
    for (const [name, method] of Object.entries(methods)) {
      if (typeof method !== "function") throw new TypeError(`background API method must be a function: ${namespace}.${name}`);
      normalized[name] = beforeCall ? (...args: unknown[]) => {
        beforeCall(`${namespace}.${name}`);
        return method(...args);
      } : method;
    }
    api[namespace] = Object.freeze(normalized);
  }
  return Object.freeze(api) as FrozenApi<T>;
}

export function resolveBackgroundApiMethod(api: BackgroundApi, path: string | readonly string[]): (...args: unknown[]) => unknown {
  const parts = Array.isArray(path) ? path : String(path || "").split(".").filter(Boolean);
  if (parts.length !== 2) throw apiError("BACKGROUND_API_PATH_INVALID", `invalid background API path: ${parts.join(".")}`);
  const method = api?.[parts[0]]?.[parts[1]];
  if (typeof method !== "function") {
    throw apiError("BACKGROUND_API_METHOD_UNAVAILABLE", `background API method unavailable: ${parts.join(".")}`);
  }
  return method as (...args: unknown[]) => unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function apiError(code: string, message: string) {
  const error = new Error(message);
  return Object.assign(error, { code });
}
