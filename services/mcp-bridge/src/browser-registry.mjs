import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isBrowserId = value => typeof value === "string" && uuid.test(value);
export function pairingError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
export function browserName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || uuid.test(name)) {
    throw pairingError("BRIDGE_NAME_INVALID", "Use 1–64 letters, digits, underscores, or hyphens, starting with a letter or digit. A UUID cannot be used as a name.");
  }
  return name;
}
export function sameToken(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function missingRegistry(path) {
  // On Windows, ENOENT can also mean that a parent component is a file.
  for (let candidate = path; ; candidate = dirname(candidate)) {
    try { await lstat(candidate); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(candidate) === candidate) return false;
      continue;
    }
    return candidate !== path && await stat(candidate).then(entry => entry.isDirectory(), () => false);
  }
}

/** The daemon owns this file; its scope lock prevents competing writers. */
export class BrowserRegistry {
  constructor({ path, entries = [], persist } = {}) {
    this.path = path;
    this.entries = new Map(entries.map(entry => [entry.clientId, entry]));
    this.persist = persist || (async entries => {
      if (!path) return;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, browsers: entries })}\n`, { mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
  }

  static async open(path) {
    if (!path) return new BrowserRegistry();
    let document;
    try { document = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT" && await missingRegistry(path)) return new BrowserRegistry({ path });
      throw pairingError("BRIDGE_REGISTRY_READ_FAILED", "Cannot read the browser registry. Restore its valid contents before restarting qz.");
    }
    try {
      if (document.version !== 1 || !Array.isArray(document.browsers)) throw new Error();
      const ids = new Set(), names = new Set();
      for (const entry of document.browsers) {
        if (!isBrowserId(entry.clientId) || browserName(entry.name) !== entry.name
          || !/^[A-Za-z0-9_-]{43}$/.test(entry.pairingToken) || ids.has(entry.clientId) || names.has(entry.name)) throw new Error();
        ids.add(entry.clientId); names.add(entry.name);
      }
      return new BrowserRegistry({ path, entries: document.browsers });
    } catch { throw pairingError("BRIDGE_REGISTRY_READ_FAILED", "The browser registry is invalid. Restore its valid contents before restarting qz."); }
  }

  list() { return [...this.entries.values()].map(({ clientId, name }) => ({ clientId, name })); }
  get(selector) { return this.entries.get(selector) || [...this.entries.values()].find(entry => entry.name === selector); }
  async save(entries) {
    try { await this.persist([...entries.values()]); }
    catch { throw pairingError("BRIDGE_REGISTRY_WRITE_FAILED", "Could not save the browser registry. Check its directory permissions and retry."); }
    this.entries = entries;
  }
  async pair({ clientId, name, pairingToken }) {
    const existing = this.entries.get(clientId);
    if (existing && !sameToken(pairingToken, existing.pairingToken)) {
      throw pairingError("BRIDGE_PAIRING_REQUIRED", "This browser identity is already paired. Use its original profile, or forget the offline browser before pairing again.");
    }
    if (!name && !existing) {
      let index = this.entries.size ? 2 : 1;
      do { name = index === 1 ? "default" : `browser-${index}`; index++; } while (this.get(name));
    }
    name = browserName(name || existing?.name);
    const occupied = this.get(name);
    if (occupied && occupied.clientId !== clientId) throw pairingError("BRIDGE_NAME_IN_USE", `Browser name ${name} is already registered. Choose another name or forget its offline registration.`);
    if (existing?.name === name) return existing;
    if (pairingToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(pairingToken)) throw pairingError("BRIDGE_PAIRING_REQUIRED", "The browser pairing proof is invalid. Reconnect from the extension settings.");
    const entry = { clientId, name, pairingToken: existing?.pairingToken || pairingToken || randomBytes(32).toString("base64url") };
    await this.save(new Map(this.entries).set(clientId, entry));
    return entry;
  }
  async forget(clientId) {
    const entries = new Map(this.entries);
    entries.delete(clientId);
    await this.save(entries);
  }
}
