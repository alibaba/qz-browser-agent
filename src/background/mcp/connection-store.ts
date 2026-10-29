import type { CliConnectionStatus } from "../../shared/mcp-connection.js";

export const BRIDGE_STORAGE_KEY = "_qingzhou_mcp_bridge";
const CLIENT_ID_KEY = "_qingzhou_mcp_bridge_client_id";
export const DEFAULT_ENDPOINT = "http://127.0.0.1:18765";
export const RETRY_LIMIT = 3;
export const LEASE_WAIT_LIMIT = 1;
export const RETRY_DELAY_MS = 30_000;

export interface BridgeConfig {
  schemaVersion: 2;
  enabled: boolean;
  authorizationId: string;
  clientId: string;
  name: string;
  endpoint: string;
  pairingToken: string;
  instanceId: string;
  /** Firefox event-page wake lease. Chrome leaves this unset and mints a new id per worker. */
  connectionId?: string;
  state: CliConnectionStatus["state"];
  attemptsRemaining: number;
  leaseWaitRemaining: number;
  nextRetryAt: number;
  connectedAt?: number;
  serviceVersion?: string;
  lastError?: CliConnectionStatus["lastError"];
  pollIntervalMs: number;
  pollTimeoutMs: number;
  requestTimeoutMs: number;
  maxBatch: number;
  includeCapabilities: boolean;
}

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const integer = (v: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback;
const BROWSER_UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
function browserUuid(value: unknown): string {
  return typeof value === "string" && BROWSER_UUID.test(value) ? value : "";
}
let writes: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = writes.then(work);
  writes = result.catch(() => {});
  return result;
}

export function connectionEndpoint(value: unknown): string {
  try {
    const u = new URL(String(value || DEFAULT_ENDPOINT));
    if (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)
      && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash) return u.origin;
  } catch { /* Report a stable validation code below. */ }
  throw Object.assign(new Error("Use a local qz address such as http://127.0.0.1:18765."), { code: "MCP_CONNECTION_INVALID_ENDPOINT" });
}

export function connectionName(value: string): string {
  const name = value.trim();
  if (!name || (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
    && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(name))) return name;
  throw Object.assign(new Error("Use 1–64 letters, numbers, hyphens or underscores, starting with a letter or number."), { code: "BRIDGE_NAME_INVALID" });
}

async function read(): Promise<BridgeConfig> {
  const data = await chrome.storage.local.get([BRIDGE_STORAGE_KEY, CLIENT_ID_KEY]);
  const stored = object(data[BRIDGE_STORAGE_KEY]);
  const storedId = typeof data[CLIENT_ID_KEY] === "string" ? data[CLIENT_ID_KEY] as string : "";
  const current = stored.schemaVersion === 2 && stored.clientId === storedId && Boolean(browserUuid(storedId));
  const raw = current ? stored : {};
  const clientId = current ? storedId : crypto.randomUUID();
  const connectionId = browserUuid(raw.connectionId);
  const name = String(raw.name || "").trim();
  let endpoint = DEFAULT_ENDPOINT;
  try { endpoint = connectionEndpoint(raw.endpoint); } catch { /* Invalid addresses stay local. */ }
  const enabled = raw.enabled === true && typeof raw.authorizationId === "string" && Boolean(raw.authorizationId);
  const states = ["connecting", "connected", "reconnecting", "paused"];
  const error = object(raw.lastError);
  const config: BridgeConfig = {
    schemaVersion: 2, enabled, clientId, name, endpoint,
    authorizationId: String(raw.authorizationId || ""),
    pairingToken: String(raw.pairingToken || ""),
    instanceId: String(raw.instanceId || ""),
    ...(connectionId ? { connectionId } : {}),
    state: enabled && states.includes(String(raw.state)) ? raw.state as BridgeConfig["state"] : enabled ? "connecting" : "disconnected",
    attemptsRemaining: integer(raw.attemptsRemaining, RETRY_LIMIT, 0, RETRY_LIMIT),
    leaseWaitRemaining: integer(raw.leaseWaitRemaining, LEASE_WAIT_LIMIT, 0, LEASE_WAIT_LIMIT),
    nextRetryAt: integer(raw.nextRetryAt, 0, 0, Number.MAX_SAFE_INTEGER),
    ...(typeof raw.connectedAt === "number" ? { connectedAt: raw.connectedAt } : {}),
    ...(typeof raw.serviceVersion === "string" ? { serviceVersion: raw.serviceVersion } : {}),
    ...(typeof error.code === "string" ? { lastError: { code: error.code, message: String(error.message || "") } } : {}),
    pollIntervalMs: integer(raw.pollIntervalMs, 750, 100, 60_000),
    pollTimeoutMs: integer(raw.pollTimeoutMs, 20_000, 1000, 20_000),
    requestTimeoutMs: integer(raw.requestTimeoutMs, 120_000, 1000, 600_000),
    maxBatch: integer(raw.maxBatch, 4, 1, 16), includeCapabilities: raw.includeCapabilities !== false,
  };
  if (!current) {
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId, [BRIDGE_STORAGE_KEY]: config });
  }
  return config;
}

export function getConnectionConfig() { return serialize(read); }

/** Single Background owner serializes state writes; guards are checked after the storage read. */
export function updateConnectionConfig(update: (current: BridgeConfig) => BridgeConfig | null): Promise<BridgeConfig> {
  return serialize(async () => {
    const current = await read();
    const next = update(current);
    if (!next) return current;
    await chrome.storage.local.set({ [BRIDGE_STORAGE_KEY]: next });
    return next;
  });
}

export function connectionStatus(config: BridgeConfig): CliConnectionStatus {
  return {
    state: config.enabled ? config.state : "disconnected", clientId: config.clientId,
    name: config.name, endpoint: config.endpoint, retryCount: RETRY_LIMIT - config.attemptsRemaining, retryLimit: RETRY_LIMIT,
    ...(config.connectedAt ? { connectedAt: config.connectedAt } : {}),
    ...(config.serviceVersion ? { serviceVersion: config.serviceVersion } : {}),
    ...(config.lastError ? { lastError: config.lastError } : {}),
  };
}
