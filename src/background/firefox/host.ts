import { installFirefoxDebugger } from "./debugger-host.js";
import { installInitiatorRewrite } from "./dnr-initiator.js";
import { installFirefoxMcpWake } from "./mcp-wake.js";
import { installNotificationRenewal } from "./notifications.js";
import { installOffscreenHost } from "./offscreen-host.js";
import { disableFirefoxSessionAutomations } from "./session-automations.js";
import { installWorkspacePanel } from "./workspace-panel.js";
import { installFirefoxTabNavigation } from "./tab-navigation.js";

/** Patch Firefox APIs before the shared background graph reads them. */
export function installFirefoxHost(chromeApi: unknown = globalThis.chrome): void {
  const browser = chromeApi as HostChrome | undefined;
  if (!browser || browser.qzFirefoxHost) return;
  browser.qzFirefoxHost = true;
  installFirefoxTabNavigation(browser as Parameters<typeof installFirefoxTabNavigation>[0]);
  disableFirefoxSessionAutomations(browser);
  installFirefoxMcpWake(browser as Parameters<typeof installFirefoxMcpWake>[0]);
  installFirefoxDebugger(browser as Parameters<typeof installFirefoxDebugger>[0]);
  installWorkspacePanel(browser as Parameters<typeof installWorkspacePanel>[0]);
  installOffscreenHost(browser as Parameters<typeof installOffscreenHost>[0]);
  installInitiatorRewrite(browser as Parameters<typeof installInitiatorRewrite>[0]);
  installNotificationRenewal(browser as Parameters<typeof installNotificationRenewal>[0]);
  console.info("[轻舟] firefox host installed");
}

installFirefoxHost();

interface HostChrome {
  qzFirefoxHost?: boolean;
  qzSessionAutomationsEnabled?: boolean;
  alarms?: {
    create?: (name: string, info?: chrome.alarms.AlarmCreateInfo) => Promise<void> | void;
    clear?: (name?: string) => Promise<boolean> | boolean;
    qzSessionAutomationAlarmBlocked?: boolean;
  };
  debugger?: { sendCommand?: unknown };
  runtime?: { id?: string; getURL?(path: string): string; onMessage?: { addListener(listener: (...args: never[]) => void): void } };
  sidebarAction?: {
    open(): unknown;
    toggle?(): unknown;
    setPanel?(details: { tabId?: number; panel?: string | null }): unknown;
  };
  sidePanel?: { open?(options?: { windowId?: number; tabId?: number }): unknown };
  action?: { onClicked?: { addListener(listener: () => void): void } };
  offscreen?: { createDocument?: () => unknown };
  declarativeNetRequest?: { updateSessionRules?: (update: unknown) => unknown; updateDynamicRules?: (update: unknown) => unknown };
  notifications?: { create: (id: string, options?: { requireInteraction?: boolean }) => unknown; onClosed?: { addListener(listener: (id: string, byUser: boolean) => void): void }; onClicked?: { addListener(listener: (id: string) => void): void } };
  tabs?: { onRemoved?: { addListener(listener: (tabId: number) => void): void } };
  webNavigation?: { onCommitted?: { addListener(listener: (details: unknown) => void): void } };
  scripting?: { executeScript?: unknown };
  windows?: { get?: unknown; update?: unknown; create?: unknown };
  webRequest?: { onBeforeRequest: { addListener(...args: never[]): void } };
}
