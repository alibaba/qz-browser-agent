import type { UiActivation, UiExtensionAPI } from "#sdk/sidepanel";
import type { CliConnectionStatus } from "#sdk/shared/mcp-connection";
import { copyPlainText } from "#sdk/sidepanel/dom";
import { t } from "./i18n.js";

type Host = Pick<UiExtensionAPI, "root" | "signal" | "request" | "on" | "showToast">;
const states = new Set(["disconnected", "connecting", "connected", "reconnecting", "paused"]);
const startErrors = new Set(["MCP_CONNECTION_UNAVAILABLE", "MCP_CONNECTION_INCOMPATIBLE", "BRIDGE_INSTANCE_CHANGED", "BRIDGE_PAIRING_REQUIRED"]);
const errorKeys = {
  MCP_CONNECTION_INCOMPATIBLE: "cliIncompatible", MCP_CONNECTION_UNAVAILABLE: "cliUnavailable",
  MCP_CONNECTION_CANCELLED: "cliCancelled", MCP_CONNECTION_PAGE_CHANGED: "cliPairAgain",
  MCP_CONNECTION_INVALID_ENDPOINT: "cliInvalidEndpoint", BRIDGE_NAME_INVALID: "cliInvalidName",
  BRIDGE_NAME_IN_USE: "cliNameConflict", BRIDGE_CLIENT_IN_USE: "cliClientInUse",
  BRIDGE_PAIRING_REQUIRED: "cliPairAgain", BRIDGE_INSTANCE_CHANGED: "cliPairAgain",
} as const;

function statusValue(value: unknown): CliConnectionStatus | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<CliConnectionStatus>;
  return typeof item.state === "string" && states.has(item.state) && typeof item.name === "string"
    && typeof item.endpoint === "string" && typeof item.clientId === "string"
    ? item as CliConnectionStatus : null;
}

/** Immediate connection actions have their own lifecycle and never enter the settings draft. */
export function createCliConnection(qz: Host) {
  const { root, signal } = qz;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const section = $("settings-cli-connection"), toggle = $<HTMLButtonElement>("cli-toggle");
  const toggleLabel = $("cli-toggle-label");
  const edit = $<HTMLButtonElement>("cli-edit"), popup = $("cli-connect-popover");
  const name = $<HTMLInputElement>("cli-name"), address = $<HTMLInputElement>("cli-address");
  const addressDetails = $<HTMLDetailsElement>("cli-address-details");
  const form = $<HTMLFormElement>("cli-connect-form"), submit = $<HTMLButtonElement>("cli-submit");
  const status = $("cli-status"), popupStatus = $("cli-popover-status"), start = $("cli-start");
  const command = $("cli-start-command"), copy = $<HTMLButtonElement>("cli-copy");
  const listener = { signal };
  let current: CliConnectionStatus | null = null;
  let active = false, loaded = false, busy = false, dirty = false, revision = 0;
  let readFailure = false, actionError = "";
  let anchor: HTMLElement = toggle;

  function isOpen() { return popup.matches(":popover-open"); }
  function close(restoreFocus = false) {
    const opened = isOpen();
    if (opened) popup.hidePopover();
    toggle.setAttribute("aria-expanded", "false");
    edit.setAttribute("aria-expanded", "false");
    if (opened && restoreFocus) anchor.focus({ preventScroll: true });
    return opened;
  }
  function position() {
    if (!isOpen()) return;
    const view = root.defaultView!, rect = anchor.getBoundingClientRect(), inset = 12, gap = 6;
    const width = Math.min(300, view.innerWidth - inset * 2), height = popup.offsetHeight;
    const left = root.documentElement.dir === "rtl" ? rect.left : rect.right - width;
    popup.style.left = `${Math.max(inset, Math.min(left, view.innerWidth - width - inset))}px`;
    popup.style.top = `${Math.max(inset, Math.min(rect.bottom + gap, view.innerHeight - height - inset))}px`;
  }
  function open(from = toggle) {
    anchor = from;
    if (!dirty && current) { name.value = current.name; address.value = current.endpoint; }
    if (!isOpen()) popup.showPopover();
    anchor.setAttribute("aria-expanded", "true");
    render();name.focus({ preventScroll: true });
  }
  function errorText(code: string) {
    return t(errorKeys[code as keyof typeof errorKeys] || "cliFailure");
  }
  function revealAddress(code?: string) {
    if (code === "MCP_CONNECTION_UNAVAILABLE" || code === "MCP_CONNECTION_INVALID_ENDPOINT") addressDetails.open = true;
  }
  function startCommand() {
    try {
      const url = new URL(address.value.trim());
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return "";
      const port = Number(url.port || 80);
      const suffix = port === 18765 ? "" : ` --port ${port}`;
      return `npx --yes qz-browser-agent@latest connect${suffix}`;
    } catch { return ""; }
  }
  function render() {
    if (!active || signal.aborted) return;
    const connected = current?.state === "connected";
    const connecting = busy || current?.state === "connecting";
    const opened = isOpen();
    toggle.disabled = !loaded || busy;
    const label = connecting ? t("cliConnecting") : connected
      ? t("cliDisconnect", { name: current?.name || "" }) : t("cliConnect");
    toggleLabel.textContent = label;toggle.title = label;toggle.setAttribute("aria-label", label);
    edit.classList.toggle("hidden", connected || !current?.name && !dirty);
    edit.disabled = busy;
    submit.disabled = busy;
    name.disabled = busy;address.disabled = busy;
    submit.textContent = connecting ? t("cliConnecting") : t("cliConnect");
    const code = actionError || current?.lastError?.code || "";
    const message = readFailure ? t("cliReadFailure") : code ? errorText(code)
      : current?.state === "reconnecting" ? t("cliReconnecting", { count: current.retryCount, limit: current.retryLimit }) : "";
    for (const [target, visible] of [[status, !opened], [popupStatus, opened]] as const) {
      target.textContent = visible ? message : "";target.classList.toggle("hidden", !message || !visible);
      target.classList.toggle("qz:text-danger", Boolean(code || readFailure));
    }
    const text = startErrors.has(code) ? startCommand() : "";
    start.classList.toggle("hidden", !text);
    command.textContent = text && code === "MCP_CONNECTION_INCOMPATIBLE"
      ? `npx --yes qz-browser-agent@latest stop\n${text}` : text;
    if (opened) form.insertBefore(start, form.lastElementChild);
    else section.insertBefore(start, popup);
    position();
  }
  function apply(next: CliConnectionStatus) {
    current = next;loaded = true;readFailure = false;
    if (!dirty) { name.value = next.name;address.value = next.endpoint; }
    render();
  }
  async function activate({ signal: activation }: UiActivation) {
    active = true;const ticket = ++revision;render();
    try {
      const reply = await qz.request("mcp_connection_status", {}, 5000);
      if (signal.aborted || activation.aborted || ticket !== revision) return;
      const next = statusValue(reply.result);
      if (!next) throw new Error("Invalid connection status");
      apply(next);
    } catch {
      if (signal.aborted || activation.aborted || ticket !== revision) return;
      loaded = true;readFailure = true;render();
    }
  }
  function deactivate() { active = false;++revision;close(); }
  async function act(disconnect = false) {
    if (busy || signal.aborted) return;
    const ticket = ++revision;
    let restoreFocus = false;
    busy = true;readFailure = false;actionError = "";render();
    try {
      const reply = await qz.request(disconnect ? "mcp_connection_disconnect" : "mcp_connection_connect",
        disconnect ? {} : { name: name.value.trim(), endpoint: address.value.trim() }, 30000);
      if (signal.aborted) return;
      const next = statusValue(reply.result);
      if (!next) {
        if (ticket !== revision) return;
        throw new Error("Invalid connection status");
      }
      // A broadcast may describe a later action in another panel. Its status wins.
      if (ticket === revision) { dirty = false;revealAddress(next.lastError?.code);apply(next); }
      const latest = current;
      const completed = disconnect ? latest?.state === "disconnected"
        : latest?.state === "connected" && latest.name === next.name && latest.endpoint === next.endpoint;
      if (completed && latest) { dirty = false;apply(latest);restoreFocus = close(); }
    } catch (error) {
      if (signal.aborted || ticket !== revision) return;
      actionError = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      actionError ||= "MCP_CONNECTION_FAILED";
      revealAddress(actionError);
      if (!disconnect) dirty = true;
    } finally {
      busy = false;render();
      if (restoreFocus && active && !signal.aborted) anchor.focus({ preventScroll: true });
    }
  }
  toggle.addEventListener("click", () => {
    if (current?.state === "connected") void act(true);
    else if (!current?.name || dirty) open();
    else void act();
  }, listener);
  edit.addEventListener("click", () => open(edit), listener);
  form.addEventListener("submit", event => { event.preventDefault();if (form.reportValidity()) void act(); }, listener);
  for (const field of [name, address]) field.addEventListener("input", () => { dirty = true;actionError = "";render(); }, listener);
  $("cli-cancel").addEventListener("click", () => close(true), listener);
  popup.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault();event.stopPropagation();close(true); }
  }, listener);
  popup.addEventListener("toggle", () => { if (!isOpen()) close();render(); }, listener);
  addressDetails.addEventListener("toggle", position, listener);
  root.defaultView?.addEventListener("resize", position, listener);
  root.addEventListener("scroll", event => { if (event.target instanceof Node && event.target.contains(section)) position(); }, { ...listener, capture: true });
  copy.addEventListener("click", async () => {
    try { await copyPlainText(command.textContent);if (!signal.aborted) qz.showToast(t("cliCopied"), { tone: "success" }); }
    catch { if (!signal.aborted) qz.showToast(t("cliCopyFailed"), { tone: "error" }); }
  }, listener);
  qz.on("mcp_connection_status_changed", event => {
    const next = statusValue(event.status);
    if (next) {
      if (isOpen() && next.lastError?.code !== current?.lastError?.code) revealAddress(next.lastError?.code);
      ++revision;actionError = "";apply(next);
    }
  });
  signal.addEventListener("abort", () => { active = false;close(); }, { once: true });
  return { activate, deactivate, close, isOpen };
}
