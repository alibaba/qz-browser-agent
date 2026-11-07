const ENDPOINT_PATHS: Readonly<Record<string, { suffix: string; counterpart: string }>> = {
  openai: { suffix: "/chat/completions", counterpart: "/v1/messages" },
  anthropic: { suffix: "/messages", counterpart: "/v1/chat/completions" },
};

export function normalizeCustomProtocol(value: unknown) {
  return String(value || "").trim().toLowerCase() || "openai";
}

export function suggestCustomProviderEndpoint(value: unknown = "", protocol: unknown = "openai") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const paths = ENDPOINT_PATHS[normalizeCustomProtocol(protocol)];
  if (!paths) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:/i.test(raw)) return null;
  const localHost = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw);
  const parsedValue = hasScheme ? raw : `${localHost ? "http" : "https"}://${raw}`;
  let url;
  try {
    url = new URL(parsedValue);
  } catch (_err) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const path = url.pathname.replace(/\/+$/, "");
  if (!path) {
    url.pathname = `/v1${paths.suffix}`;
  } else if (/\/v1$/i.test(path)) {
    url.pathname = `${path}${paths.suffix}`;
  } else if (path.toLowerCase().endsWith(paths.counterpart)) {
    url.pathname = `${path.slice(0, -paths.counterpart.length)}/v1${paths.suffix}`;
  } else {
    return null;
  }

  const completed = url.toString();
  const displayed = hasScheme ? completed : completed.replace(/^https?:\/\//i, "");
  return {
    value: completed,
    addition: displayed.startsWith(raw) ? displayed.slice(raw.length) : "",
  };
}

export function completeCustomProviderEndpoint(value: unknown = "", protocol: unknown = "openai") {
  const raw = String(value || "").trim();
  return suggestCustomProviderEndpoint(raw, protocol)?.value || raw;
}

/** Discover only the standard sibling route; retain the configured origin, prefix and query. */
export function customProviderModelsEndpoint(value: unknown = "", protocol: unknown = "openai") {
  const paths = ENDPOINT_PATHS[normalizeCustomProtocol(protocol)];
  if (!paths) return "";
  let url;
  try { url = new URL(completeCustomProviderEndpoint(value, protocol)); }
  catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(paths.suffix)) return "";
  url.pathname = `${path.slice(0, -paths.suffix.length)}/models`;
  url.hash = "";
  return url.toString();
}
