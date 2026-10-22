/** Loopback hosts that may import an exported chat over HTTP or HTTPS. */
const SESSION_EXCHANGE_LOOPBACK_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
];

/**
 * HTTPS pages that may import an exported chat.
 * Match the hostname exactly. The pathname prefix includes its trailing slash.
 * Add a custom domain as another entry in this list.
 */
export const SESSION_EXCHANGE_HTTPS_ALLOWLIST = [
  {
    hostname: "alibaba.github.io",
    pathnamePrefix: "/qz-browser-agent/",
  },
] as const;

/** Exported chat pages may import from a local file, a loopback origin, or an HTTPS allowlist entry. */
export function isAllowedSessionExchangeLocation(location: {
  protocol: string;
  hostname: string;
  pathname?: string;
}): boolean {
  if (location.protocol === "file:") return true;
  if (location.protocol === "https:" && matchesHttpsAllowlist(location)) return true;
  if (location.protocol !== "http:" && location.protocol !== "https:") return false;
  return SESSION_EXCHANGE_LOOPBACK_HOSTS.includes(location.hostname.toLowerCase());
}

function matchesHttpsAllowlist(location: { hostname: string; pathname?: string }): boolean {
  const hostname = location.hostname.toLowerCase();
  const pathname = typeof location.pathname === "string" ? location.pathname : "";
  return SESSION_EXCHANGE_HTTPS_ALLOWLIST.some(entry => (
    hostname === entry.hostname.toLowerCase()
    && entry.pathnamePrefix.startsWith("/")
    && entry.pathnamePrefix.endsWith("/")
    && pathname.startsWith(entry.pathnamePrefix)
  ));
}
