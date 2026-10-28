/** Map sidePanel.open and the toolbar click onto Firefox sidebarAction. */

const SIDEBAR_PROMPT_ID = "qz-open-sidebar";
const SIDEBAR_PORT_NAME = "sidepanel";

/**
 * Firefox runs sidebarAction.open only inside browserAction.onClicked, commands.onCommand, or
 * menus.onClicked. notifications.onClicked and runtime messages are not user input, so those
 * routes leave a toolbar badge and a hint instead of opening the sidebar, unless it is already showing.
 */
export function installWorkspacePanel(chromeApi: WorkspaceChrome, host: DiagnosticsHost = globalThis as DiagnosticsHost): void {
  const sidebar = chromeApi.sidebarAction;
  if (!sidebar || typeof sidebar.open !== "function" || chromeApi.sidePanel?.open) return;
  const diagnostics: SidebarDiagnostics = {
    attempts: 0, opened: 0, refused: 0, prompts: 0, notified: 0, notificationClicks: 0, lastSource: "", lastError: "", lastAt: "",
  };
  host.qzFirefoxSidebar = diagnostics;
  const inNotificationClick = trackNotificationClicks(chromeApi.notifications);
  const prompt = installSidebarPrompt(chromeApi, diagnostics);
  const panelUrl = () => {
    try { return chromeApi.runtime?.getURL?.("sidepanel/sidepanel.html") || "sidepanel/sidepanel.html"; }
    catch { return "sidepanel/sidepanel.html"; }
  };
  const refuse = (error: unknown, source: SidebarSource, fromNotification: boolean): Promise<never> => {
    const message = errorMessage(error);
    diagnostics.refused += 1;
    diagnostics.lastError = message;
    diagnostics.lastAt = new Date().toISOString();
    console.error(`[轻舟] firefox sidebarAction failed (${source}):`, message);
    if (isSidebarGestureError(error)) {
      // An open sidebar already receives the reveal; a badge there would point at a closed panel.
      void sidebarShowing(sidebar).then(showing => {
        if (!showing) prompt.show({ notify: !fromNotification });
      });
    }
    return Promise.reject(explainSidebarError(error));
  };
  const attempt = (source: SidebarSource, run: () => unknown): Promise<unknown> => {
    const fromNotification = inNotificationClick();
    diagnostics.attempts += 1;
    diagnostics.lastSource = source;
    let opened: unknown;
    try {
      opened = run();
    } catch (error) {
      return refuse(error, source, fromNotification);
    }
    return Promise.resolve(opened).then(value => {
      diagnostics.opened += 1;
      prompt.clear();
      return value;
    }, (error: unknown) => refuse(error, source, fromNotification));
  };
  const openSidebar = (options?: { windowId?: number; tabId?: number }) => {
    const tabId = Number(options?.tabId);
    if (Number.isInteger(tabId) && tabId > 0 && typeof sidebar.setPanel === "function") {
      try {
        const pending = sidebar.setPanel({ tabId, panel: panelUrl() });
        if (isPromise(pending)) void pending.then(() => {}, () => {});
      } catch { /* The window sidebar panel remains in place. */ }
    }
    // Firefox 158 sidebarAction.open() takes no arguments and uses the current window.
    return attempt(inNotificationClick() ? "notification" : "api", () => sidebar.open());
  };

  chromeApi.notifications?.onClicked?.addListener(notificationId => {
    diagnostics.notificationClicks += 1;
    if (notificationId !== SIDEBAR_PROMPT_ID) return;
    void attempt("notification", () => sidebar.open()).catch(() => {});
    prompt.dismiss();
    focusLastWindow(chromeApi);
  });
  chromeApi.runtime?.onConnect?.addListener(port => {
    if (port?.name !== SIDEBAR_PORT_NAME || port.sender?.tab) return;
    if (String(port.sender?.url || "").split(/[?#]/)[0] !== panelUrl()) return;
    prompt.clear();
  });

  let toolbarBound = false;
  chromeApi.sidePanel = {
    open: options => openSidebar(options),
    setPanelBehavior() {
      if (!toolbarBound && chromeApi.action?.onClicked?.addListener) {
        toolbarBound = true;
        chromeApi.action.onClicked.addListener(() => {
          void attempt("toolbar", () => (typeof sidebar.toggle === "function" ? sidebar.toggle() : sidebar.open())).catch(() => {});
        });
      }
      return Promise.resolve();
    },
  };
}

/** Wrap onClicked listeners so a sidebar open started inside a notification click is recognized. */
function trackNotificationClicks(notifications: WorkspaceChrome["notifications"]): () => boolean {
  const event = notifications?.onClicked;
  if (!event || typeof event.addListener !== "function") return () => false;
  let depth = 0;
  const add = event.addListener.bind(event);
  const remove = typeof event.removeListener === "function" ? event.removeListener.bind(event) : undefined;
  const has = typeof event.hasListener === "function" ? event.hasListener.bind(event) : undefined;
  const wrapped = new WeakMap<NotificationListener, NotificationListener>();
  const wrap = (listener: NotificationListener) => {
    let tracked = wrapped.get(listener);
    if (!tracked) {
      tracked = notificationId => {
        depth += 1;
        try { return listener(notificationId); } finally { depth -= 1; }
      };
      wrapped.set(listener, tracked);
    }
    return tracked;
  };
  try {
    event.addListener = listener => add(wrap(listener));
    if (remove) event.removeListener = listener => remove(wrapped.get(listener) || listener);
    if (has) event.hasListener = listener => has(wrapped.get(listener) || listener);
  } catch {
    return () => false;
  }
  return () => depth > 0;
}

function installSidebarPrompt(chromeApi: WorkspaceChrome, diagnostics: SidebarDiagnostics): SidebarPrompt {
  let prompted = false;
  const dismiss = () => {
    try {
      const cleared = chromeApi.notifications?.clear?.(SIDEBAR_PROMPT_ID);
      if (isPromise(cleared)) void cleared.then(() => {}, () => {});
    } catch { /* The badge still points at the toolbar button. */ }
  };
  const decorate = (text: string, title: string | null) => {
    try {
      const badge = chromeApi.action?.setBadgeText?.({ text });
      if (isPromise(badge)) void badge.then(() => {}, () => {});
      const tooltip = chromeApi.action?.setTitle?.({ title });
      if (isPromise(tooltip)) void tooltip.then(() => {}, () => {});
    } catch { /* The notification still carries the hint. */ }
  };
  // An event page can restart with a stale badge, so clearing never depends on `prompted`.
  const clear = () => {
    prompted = false;
    decorate("", null);
    dismiss();
  };
  const show = ({ notify }: { notify: boolean }) => {
    if (prompted) return;
    prompted = true;
    diagnostics.prompts += 1;
    const copy = sidebarPromptCopy(chromeApi);
    decorate("!", copy.tooltip);
    if (!notify || typeof chromeApi.notifications?.create !== "function") return;
    try {
      const iconUrl = chromeApi.runtime?.getURL?.("icons/icon128.png") || "";
      const created = chromeApi.notifications.create(SIDEBAR_PROMPT_ID, {
        type: "basic",
        ...(iconUrl ? { iconUrl } : {}),
        title: copy.title,
        message: copy.message,
      });
      diagnostics.notified += 1;
      if (isPromise(created)) void created.then(() => {}, () => {});
    } catch { /* The badge remains on the toolbar button. */ }
  };
  return { show, clear, dismiss };
}

function sidebarShowing(sidebar: NonNullable<WorkspaceChrome["sidebarAction"]>): Promise<boolean> {
  if (typeof sidebar.isOpen !== "function") return Promise.resolve(false);
  try {
    return Promise.resolve(sidebar.isOpen({})).then(open => open === true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

function focusLastWindow(chromeApi: WorkspaceChrome) {
  const windows = chromeApi.windows;
  if (typeof windows?.getLastFocused !== "function" || typeof windows.update !== "function") return;
  void Promise.resolve(windows.getLastFocused())
    .then(win => (typeof win?.id === "number" ? windows.update!(win.id, { focused: true }) : undefined))
    .catch(() => {});
}

function sidebarPromptCopy(chromeApi: WorkspaceChrome): { title: string; message: string; tooltip: string } {
  let language = "";
  try { language = chromeApi.i18n?.getUILanguage?.() || ""; } catch { language = ""; }
  if (language.toLowerCase().startsWith("zh")) {
    return { title: "轻舟", message: "点击工具栏中的轻舟图标查看。", tooltip: "轻舟：点击打开侧边栏" };
  }
  return { title: "qz", message: "Click the qz icon in the toolbar to view.", tooltip: "qz: click to open the sidebar" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "sidebarAction.open failed");
}

function isPromise(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as Promise<unknown>).then === "function";
}

function isSidebarGestureError(error: unknown): boolean {
  return /user gesture|user input|user activation|transient activation/i.test(errorMessage(error));
}

function explainSidebarError(error: unknown): Error {
  const message = errorMessage(error);
  if (!isSidebarGestureError(error)) return error instanceof Error ? error : new Error(message);
  return new Error(`Firefox opens the sidebar only from the toolbar button, the sidebar shortcut, or a menu item. ${message}`);
}

type SidebarSource = "api" | "notification" | "toolbar";
type NotificationListener = (notificationId: string) => unknown;

/** Read `qzFirefoxSidebar` in the background console to see what sidebarAction returned. */
export interface SidebarDiagnostics {
  attempts: number;
  opened: number;
  refused: number;
  prompts: number;
  notified: number;
  notificationClicks: number;
  lastSource: string;
  lastError: string;
  lastAt: string;
}
interface DiagnosticsHost { qzFirefoxSidebar?: SidebarDiagnostics }
interface SidebarPrompt { show(options: { notify: boolean }): void; clear(): void; dismiss(): void }
interface RuntimePort { name?: string; sender?: { tab?: unknown; url?: string } }
interface WorkspaceChrome {
  runtime?: {
    getURL?(path: string): string;
    onConnect?: { addListener(listener: (port: RuntimePort) => void): void };
  };
  i18n?: { getUILanguage?(): string };
  sidebarAction?: {
    open(): unknown;
    toggle?(): unknown;
    isOpen?(details: { windowId?: number }): unknown;
    setPanel?(details: { tabId?: number; panel?: string | null }): unknown;
  };
  sidePanel?: { open?(options?: { windowId?: number; tabId?: number }): unknown; setPanelBehavior?(): unknown };
  action?: {
    onClicked?: { addListener(listener: () => void): void };
    setBadgeText?(details: { text: string }): unknown;
    setTitle?(details: { title: string | null }): unknown;
  };
  notifications?: {
    create?(notificationId: string, options: { type: string; iconUrl?: string; title: string; message: string }): unknown;
    clear?(notificationId: string): unknown;
    onClicked?: {
      addListener(listener: NotificationListener): void;
      removeListener?(listener: NotificationListener): void;
      hasListener?(listener: NotificationListener): boolean;
    };
  };
  windows?: {
    getLastFocused?(): Promise<{ id?: number } | undefined> | { id?: number } | undefined;
    update?(windowId: number, info: { focused: boolean }): unknown;
  };
}
