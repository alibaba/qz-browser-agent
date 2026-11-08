import type { MessageValue, ScriptFailure } from "./contracts/inner-runner.js";
export { createQzSdk } from "./qz-script-sdk.js";

type ScriptWorld = "page" | "inner";

/** Firefox stacks omit the error header; keep the diagnostic message in every trace. */
export function formatScriptErrorTrace(error: Error): string {
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  const stack = error.stack || "";
  if (!stack) return header;
  return stack === header || stack.startsWith(`${header}\n`) ? stack : `${header}\n${stack}`;
}

/** Public scripts exchange JSON values without truncating or renaming business fields. */
export function scriptValue(value: unknown, seen = new Set<object>()): MessageValue {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const invalid = () => Object.assign(new TypeError('Pass or return JSON values; DOM nodes, functions, cycles and non-finite numbers cannot cross script contexts.'), {
    code: 'SCRIPT_VALUE_NOT_SERIALIZABLE',
  });
  if (!value || typeof value !== 'object' || seen.has(value)) throw invalid();
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') throw invalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => scriptValue(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scriptValue(item, seen)]));
  } finally { seen.delete(value); }
}

/** Only code-bearing tools serialize functions; ordinary tool arguments remain data. */
export function scriptToolArguments(name: string, args: unknown): MessageValue {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } as Record<string, unknown> : {};
  if (['evaluate', 'wait_for_function'].includes(name) && typeof value.code === 'function') {
    const code = Function.prototype.toString.call(value.code);
    if (/\[native code\]/.test(code)) throw Object.assign(new TypeError('Pass a self-contained function to code.'), {
      code: 'INVALID_SCRIPT_FUNCTION', hint: 'Use an ordinary or arrow function and pass captured values through args.',
    });
    value.code = code;
  }
  if (['wait_for_navigation', 'wait_for_popup', 'wait_for_response'].includes(name)
    && value.trigger && typeof value.trigger === 'object' && !Array.isArray(value.trigger)) {
    const trigger = value.trigger as Record<string, unknown>;
    if (['evaluate', 'wait_for_function'].includes(String(trigger.name))) {
      value.trigger = { ...trigger, args: scriptToolArguments(String(trigger.name), trigger.args) };
    }
  }
  return scriptValue(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object");
function scriptErrorText(value: unknown, world: ScriptWorld): string {
  if (world === "page") return ((value as { message?: string })?.message || String(value));
  return (value instanceof Error ? value : Object.assign(new Error(String(value)), isRecord(value) ? value : {})).message;
}

// Both execution worlds use the same wire shape. Keep their existing DOM and
// exception/typed-array edge semantics explicit at this cross-context boundary.
export function safeValueForMessage(value: unknown, world: ScriptWorld = "inner", seen = new WeakSet<object>(), depth = 0): MessageValue {
  if (value == null || typeof value === "string" || typeof value === "boolean" || typeof value === "undefined") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") {
    return { __qz_uncloneable: "function", name: value.name || "" };
  }
  if (typeof value === "symbol") {
    return { __qz_uncloneable: "symbol", description: String(value) };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return { __qz_circular: true };
  if (depth >= 8) {
    return {
      __qz_truncated: true,
      type: Array.isArray(value) ? "array" : objectTag(value, world),
    };
  }
  if (value instanceof Error) {
    const out: Record<string, MessageValue> = {
      name: value.name || "Error",
      message: value.message || String(value),
      stack: value.stack || "",
    };
    const details: ScriptFailure = value;
    if (details.hint != null) out.hint = details.hint;
    if (details.code != null) out.code = safeValueForMessage(details.code, world, seen, depth + 1);
    if (details.details != null) out.details = safeValueForMessage(details.details, world, seen, depth + 1);
    if (details.diagnostic != null) out.diagnostic = safeValueForMessage(details.diagnostic, world, seen, depth + 1);
    return out;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (typeof URL !== "undefined" && value instanceof URL) return value.href;
  const page = globalThis as typeof globalThis & {
    Element?: { new(...args: never[]): { tagName: string; id: string; className: unknown; textContent: string | null } };
    window?: unknown; document?: unknown;
  };
  if (world === "page" && page.Element && value instanceof page.Element) {
    return {
      __qz_uncloneable: "dom", tagName: value.tagName || "", id: value.id || "",
      className: typeof value.className === "string" ? value.className : String(value.className || ""),
      text: String(value.textContent || "").trim().slice(0, 200),
    };
  }
  if (value === globalThis || (world === "page" ? value === page.window || value === page.document : value === self)) {
    return { __qz_uncloneable: "global" };
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => safeValueForMessage(item, world, seen, depth + 1));
    }
    if (value instanceof Map) {
      return {
        __qz_type: "Map",
        entries: Array.from(value.entries()).map(([key, item]) => [
          safeValueForMessage(key, world, seen, depth + 1),
          safeValueForMessage(item, world, seen, depth + 1),
        ]),
      };
    }
    if (value instanceof Set) {
      return {
        __qz_type: "Set",
        values: Array.from(value.values()).map(item => safeValueForMessage(item, world, seen, depth + 1)),
      };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        __qz_type: value.constructor?.name || "TypedArray",
        length: world === "page" ? Reflect.get(value, "length") ?? value.byteLength ?? 0
          : "length" in value && typeof value.length === "number" ? value.length : value.byteLength,
        sample: world === "page" ? Array.from(Reflect.get(value, "slice") ? Reflect.apply(Reflect.get(value, "slice"), value, [0, 32]) as ArrayLike<unknown> : []).map(Number)
          : "length" in value && typeof value.length === "number" ? Array.from({ length: Math.min(32, value.length) }, (_, index) => Number(Reflect.get(value, String(index)))) : [],
      };
    }
    if (value instanceof ArrayBuffer) {
      return { __qz_type: "ArrayBuffer", byteLength: value.byteLength };
    }
    const out: Record<string, MessageValue> = {};
    for (const key of Object.keys(value)) {
      try {
        out[key] = safeValueForMessage((value as Record<string, unknown>)[key], world, seen, depth + 1);
      } catch (err) {
        out[key] = {
          __qz_uncloneable: "property",
          error: scriptErrorText(err, world),
        };
      }
    }
    return out;
  } catch (err) {
    return {
      __qz_uncloneable: "object",
      type: objectTag(value, world),
      error: scriptErrorText(err, world),
    };
  } finally {
    seen.delete(value);
  }
}

function objectTag(value: object, world: ScriptWorld) {
  const tag = Object.prototype.toString.call(value);
  return (world === "page" ? tag.slice(8, -1) : tag.replace(/^\[object\s+|\]$/g, "")) || "object";
}

export function installSecurityGuards(guardrails: unknown, world: ScriptWorld = "inner") {
  const runtime = globalThis as typeof globalThis & { navigator?: { sendBeacon?: (url: string | URL, data?: unknown) => boolean } };
  const originals: { fetch?: typeof fetch; xhrOpen?: XMLHttpRequest["open"]; sendBeacon?: (url: string | URL, data?: unknown) => boolean } = {};
  const rules = isRecord(guardrails) && Array.isArray(guardrails.rules) ? guardrails.rules.filter((value): value is {action: string; type: string; value: string} => isRecord(value) && typeof value.action === 'string' && typeof value.type === 'string' && typeof value.value === 'string') : [];
  function globMatches(pattern: string, text: string) {
    const escaped = String(pattern || "").replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(String(text || ""));
  }
  function urlFromInput(input: unknown) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input === "object" && "url" in input && typeof input.url === "string") return input.url;
    return "";
  }
  function matchUrl(input: unknown) {
    const sourceUrl = urlFromInput(input);
    if (!sourceUrl) return null;
    let parsed;
    try {
      parsed = new URL(sourceUrl, runtime.location.href);
    } catch (_err) {
      return null;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = String(parsed.hostname || "").toLowerCase();
    const href = parsed.protocol.toLowerCase() + "//" + parsed.host.toLowerCase() + parsed.pathname + parsed.search + parsed.hash;
    const matches = [];
    for (const rule of rules) {
      if (!rule || !["block", "allow"].includes(rule.action) || !["domain", "pattern"].includes(rule.type)) continue;
      if (rule.type === "domain" && (host === rule.value || host.endsWith("." + rule.value))) matches.push(rule);
      else if (rule.type === "pattern" && globMatches(rule.value, href)) matches.push(rule);
    }
    const first = matches[0] || null;
    const patternOverride = first && first.action === "block" && first.type === "domain"
      ? matches.find(rule => rule.type === "pattern")
      : null;
    const rule = patternOverride || first;
    if (!rule || rule.action === "allow") return null;
    return { type: rule.type, domain: rule.type === "domain" ? rule.value : undefined, pattern: rule.type === "pattern" ? rule.value : undefined, host };
  }
  function assertAllowed(input: unknown, action: string) {
    const match = matchUrl(input);
    if (!match) return;
    const label = match.type === "pattern" ? ("模糊匹配 " + match.pattern) : (match.domain + " 及其子域名");
    const error: ScriptFailure = new Error("安全护栏已阻止 run_script 访问 " + label + "。");
    error.code = "SECURITY_GUARDRAIL_BLOCKED";
    error.details = {
      action,
      blockedType: match.type,
      blockedDomain: match.domain,
      blockedPattern: match.pattern,
      host: match.host,
    };
    throw error;
  }
  try {
    if (typeof runtime.fetch === "function") {
      originals.fetch = runtime.fetch;
      const originalFetch = runtime.fetch;
      runtime.fetch = function(input, init) {
        assertAllowed(input, "fetch");
        return world === "inner" ? originalFetch.call(this, input, init) : Reflect.apply(originalFetch, this, arguments);
      };
    }
  } catch (_err) {}
  try {
    if (runtime.XMLHttpRequest?.prototype?.open) {
      originals.xhrOpen = runtime.XMLHttpRequest.prototype.open;
      const originalOpen = runtime.XMLHttpRequest.prototype.open;
      runtime.XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
        assertAllowed(url, "XMLHttpRequest.open");
        return world === "inner" ? originalOpen.call(this, method, url, async, username, password) : Reflect.apply(originalOpen, this, arguments);
      };
    }
  } catch (_err) {}
  try {
    if (world === "page" && typeof runtime.navigator?.sendBeacon === "function") {
      originals.sendBeacon = runtime.navigator.sendBeacon;
      const originalBeacon = runtime.navigator.sendBeacon;
      runtime.navigator.sendBeacon = function(url, _data) {
        assertAllowed(url, "navigator.sendBeacon");
        return Reflect.apply(originalBeacon, this, arguments);
      };
    }
  } catch (_err) {}
  return () => {
    try {
      if (originals.fetch) runtime.fetch = originals.fetch;
    } catch (_err) {}
    try {
      if (originals.xhrOpen && runtime.XMLHttpRequest?.prototype) runtime.XMLHttpRequest.prototype.open = originals.xhrOpen;
    } catch (_err) {}
    try {
      if (originals.sendBeacon && runtime.navigator) runtime.navigator.sendBeacon = originals.sendBeacon;
    } catch (_err) {}
  };
}
