import type { CliConnectionInput, CliConnectionStatus } from "../../shared/mcp-connection.js";
import { connectionName } from "./connection-store.js";

interface ConnectDependencies {
  extensionId: string;
  ready: Promise<unknown>;
  assertConsent(): void;
  connect(input: CliConnectionInput, assertCurrent: () => Promise<void>): Promise<CliConnectionStatus>;
  status(): Promise<CliConnectionStatus>;
  getTab(tabId: number): Promise<{ url?: string }>;
  listTabs(): Promise<Array<{ id?: number }>>;
  createTab(): Promise<unknown>;
  removeTab(tabId: number): Promise<void>;
}

/** The endpoint comes from Chrome's sender identity, never from page-supplied parameters. */
export function createMcpConnectPage(deps: ConnectDependencies) {
  let closing: Promise<unknown> = Promise.resolve();
  async function source(sender: chrome.runtime.MessageSender) {
    await deps.ready;
    deps.assertConsent();
    const url = connectionUrl(sender.url);
    if (sender.id !== deps.extensionId || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !url) {
      throw failure("MCP_CONNECTION_PAGE_REQUIRED", "Run qz connect uri and open the printed URL in this browser.");
    }
    const tabId = sender.tab!.id!;
    const assertCurrent = async () => {
      deps.assertConsent();
      const tab = await deps.getTab(tabId).catch(() => null);
      if (tab?.url !== sender.url) throw failure("MCP_CONNECTION_PAGE_CHANGED", "Reload the connection page to continue.");
    };
    await assertCurrent();
    return { url, assertCurrent };
  }
  async function connect(sender: chrome.runtime.MessageSender) {
    const { url, assertCurrent } = await source(sender);
    const name = url.searchParams.get("name");
    if (url.searchParams.getAll("name").length > 1 || (name !== null && (!name || connectionName(name) !== name))) {
      throw failure("BRIDGE_NAME_INVALID", "Use one browser name containing letters, digits, underscores, or hyphens.");
    }
    const status = await deps.connect({ endpoint: url.origin, name: name ?? "" }, assertCurrent);
    await assertCurrent();
    if (status.endpoint !== url.origin) throw failure("MCP_CONNECTION_PAGE_CHANGED", "Reload the connection page to continue.");
    if (status.state === "paused" || status.state === "disconnected") throw failure(status.lastError?.code || "MCP_CONNECTION_UNAVAILABLE",
      status.lastError?.message || "The connection is pending. Run qz status to check it.");
    return { connected: status.state === "connected", status };
  }
  async function status(sender: chrome.runtime.MessageSender) {
    if (!connectionUrl(sender.url)) {
      assertMcpSettingsSender(sender, deps.extensionId);
      return deps.status();
    }
    return currentStatus(await source(sender));
  }
  async function currentStatus({ url, assertCurrent }: { url: URL; assertCurrent(): Promise<void> }) {
    const current = await deps.status();
    await assertCurrent();
    if (current.endpoint !== url.origin) throw failure("MCP_CONNECTION_PAGE_CHANGED", "Reload the connection page to continue.");
    return current;
  }
  async function closePage(sender: chrome.runtime.MessageSender) {
    const page = await source(sender);
    let current = await currentStatus(page);
    if (current.state !== "connected") return { closed: false, status: current };
    const tabId = sender.tab!.id!;
    const tabs = await deps.listTabs();
    await page.assertCurrent();
    if (!tabs.some(tab => tab.id !== tabId)) await deps.createTab();
    current = await currentStatus(page);
    if (current.state !== "connected") return { closed: false, status: current };
    await deps.removeTab(tabId);
    return { closed: true };
  }
  function close(sender: chrome.runtime.MessageSender) {
    // Concurrent connection pages must not each close the browser's final tab.
    const operation = closing.then(() => closePage(sender));
    closing = operation.catch(() => {});
    return operation;
  }
  return { connect, status, close };
}

function connectionUrl(value: string | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
      && url.pathname === "/qz-connect" && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }

function isMozExtensionPage(url: string): boolean {
  const prefix = "moz-extension://";
  if (!url.startsWith(prefix)) return false;
  const slash = url.indexOf("/", prefix.length);
  return slash > prefix.length;
}

export function assertMcpSettingsSender(sender: chrome.runtime.MessageSender, extensionId: string) {
  const url = sender.url ?? "";
  const ownChromePage = url.startsWith(`chrome-extension://${extensionId}/`);
  if (sender.id !== extensionId || (!ownChromePage && !isMozExtensionPage(url))) {
    throw failure("MCP_CONNECTION_PAGE_REQUIRED", "Manage the connection from qz Settings.");
  }
}
