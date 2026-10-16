interface ConnectDependencies {
  extensionId: string;
  assertConsent(): void;
  getConfig(): Promise<{ enabled: boolean }>;
  saveConfig(patch: { endpoint: string }): Promise<unknown>;
  getTab(tabId: number): Promise<{ url?: string }>;
  wake(): void;
  fetch?: typeof fetch;
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
      if (!(await deps.getConfig()).enabled) {
        throw failure("MCP_CONNECTION_DISABLED", "Local connections are disabled in this browser profile.");
      }
      const tab = await deps.getTab(tabId);
      if (tab.url !== sender.url) throw failure("MCP_CONNECTION_PAGE_CHANGED", "Reload the connection page to continue.");
    };
    await assertCurrent();
    const response = await (deps.fetch || fetch)(`${url.origin}/health`, {
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000),
    });
    const health = await response.json() as Record<string, unknown>;
    if (!response.ok || health.service !== "qz-browser-agent" || health.protocolVersion !== 1
      || typeof health.instanceId !== "string" || !health.instanceId) {
      throw failure("MCP_CONNECTION_INCOMPATIBLE", "Start a compatible qz connection with qz connect.");
    }
    await assertCurrent();
    await deps.saveConfig({ endpoint: url.origin });
    deps.wake();
    return { connected: true };
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
