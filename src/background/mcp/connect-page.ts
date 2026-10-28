import type { CliConnectionInput, CliConnectionStatus } from "../../shared/mcp-connection.js";
import { connectionName } from "./connection-store.js";

interface ConnectDependencies {
  extensionId: string;
  assertConsent(): void;
  connect(input: CliConnectionInput, assertCurrent: () => Promise<void>): Promise<CliConnectionStatus>;
  getTab(tabId: number): Promise<{ url?: string }>;
}

/** The endpoint comes from Chrome's sender identity, never from page-supplied parameters. */
export function createMcpConnectPage(deps: ConnectDependencies) {
  return async (sender: chrome.runtime.MessageSender) => {
    deps.assertConsent();
    const url = connectionUrl(sender.url);
    if (sender.id !== deps.extensionId || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !url) {
      throw failure("MCP_CONNECTION_PAGE_REQUIRED", "Open the connection page using qz connect.");
    }
    const tabId = sender.tab!.id!;
    const assertCurrent = async () => {
      deps.assertConsent();
      const tab = await deps.getTab(tabId).catch(() => null);
      if (tab?.url !== sender.url) throw failure("MCP_CONNECTION_PAGE_CHANGED", "Reload the connection page to continue.");
    };
    await assertCurrent();
    const name = url.searchParams.get("name");
    if (url.searchParams.getAll("name").length > 1 || (name !== null && (!name || connectionName(name) !== name))) {
      throw failure("BRIDGE_NAME_INVALID", "Use one browser name containing letters, digits, underscores, or hyphens.");
    }
    const status = await deps.connect({ endpoint: url.origin, name: name ?? "" }, assertCurrent);
    if (status.state !== "connected") throw failure(status.lastError?.code || "MCP_CONNECTION_UNAVAILABLE",
      status.lastError?.message || "The connection is pending. Run qz status to check it.");
    return { connected: true, status };
  };
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
