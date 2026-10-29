import type { ToolContext, ToolExtensionAPI } from "#sdk/background";
import type { CdpCommand } from "#sdk/background/browser";
import { t } from "./i18n.js";

export type PageMode = "desktop" | "mobile";
interface ModeState {
  sessionId: string;
  applied: PageMode | null;
  connectionId: number | null;
  connection: () => number | null;
}
type ModeHost = Pick<ToolExtensionAPI, "withDebugger" | "getDebuggerConnectionId" | "setDebuggerRetention" | "releaseDebugger" | "ToolExecutionError">;
// Background-only, package-owned preferences. A released connection never counts as active emulation.
export const pageModeStates = new Map<number, ModeState>();
export function readPageMode(tabId: number, states = pageModeStates): PageMode | null {
  const state = states.get(tabId);
  if (!state || state.connectionId !== state.connection() || state.connectionId === null) return "desktop";
  return state.applied;
}

/** Mobile emulation is a tab transaction; CDP leases and run revocation remain host-owned. */
export function createPageModeRuntime(host: ModeHost, states = new Map<number, ModeState>()) {
  const pending = new Map<number, Promise<unknown>>();
  const describePage = (tabId: number): Record<string, string> => {
    const mode = readPageMode(tabId, states);
    return mode ? { pageMode: mode } : {};
  };
  globalThis.chrome?.tabs?.onRemoved?.addListener(tabId => { states.delete(tabId); });

  function check(signal?: AbortSignal) {
    if (signal?.aborted) throw new host.ToolExecutionError("OPERATION_ABORTED", t("modeCancelled"));
  }

  async function change(tabId: number, mode: PageMode, signal: AbortSignal | undefined, context: ToolContext, reload = true) {
    const before = pending.get(tabId);
    const operation = (async () => {
      await before?.catch(() => {});
      check(signal);
      const previous = states.get(tabId);
      // No attach or reload for an unchanged mode; a disconnected mobile preference is reapplied.
      if (readPageMode(tabId, states) === mode && (mode !== "desktop" || !previous)) {
        if (mode === "desktop") states.delete(tabId);
        return { tabId, pageMode: mode, changed: false, reloaded: false };
      }
      try {
        const result = await host.withDebugger(tabId, async (_target, send) => {
          check(signal);
          // The host may have restored a replaced navigation target while we waited.
          if (readPageMode(tabId, states) === mode && (mode !== "desktop" || !previous)) {
            return { tabId, pageMode: mode, changed: false, reloaded: false };
          }
          const state: ModeState = { sessionId: String(context.sessionId || ""), applied: null,
            connectionId: host.getDebuggerConnectionId(tabId), connection: () => host.getDebuggerConnectionId(tabId) };
          // An interrupted transition must detach, never park partially applied emulation.
          host.setDebuggerRetention(tabId, false, context);
          states.set(tabId, state);
          let reloadStarted = false;
          try {
            await apply(send, mode, () => check(signal));
            if (reload) { reloadStarted = true; await reloadPage(send, signal); }
            check(signal);
            if (state.connectionId !== host.getDebuggerConnectionId(tabId)) throw new Error("Debugger connection changed");
            if (mode === "mobile") retain(tabId, state, context);
            state.applied = mode;
            if (mode === "desktop") states.delete(tabId);
            return { tabId, pageMode: mode, changed: true, reloaded: reload };
          } catch (error) {
            // Cancellation may revoke the lease while cleanup runs. Never reacquire it for rollback.
            try {
              const restore = previous?.applied === "mobile" && previous.connectionId === state.connectionId ? "mobile" : "desktop";
              await apply(send, restore);
              if (reloadStarted) await send("Page.reload", { ignoreCache: true });
              if (restore === "mobile" && previous) retain(tabId, previous, context);
              else host.setDebuggerRetention(tabId, false, context);
              if (previous) states.set(tabId, previous);
              else states.delete(tabId);
            } catch {
              await host.releaseDebugger(tabId, context);
              if (previous) states.set(tabId, previous);
              else states.delete(tabId);
            }
            throw error;
          }
        }, context);
        if (mode === "desktop") await host.releaseDebugger(tabId, context);
        return result;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (signal?.aborted || code.startsWith("SESSION_") || code === "CDP_RUN_RELEASED" || code === "SECURITY_GUARDRAIL_BLOCKED") throw error;
        throw new host.ToolExecutionError("PAGE_MODE_FAILED", t("modeFailed"), { tabId, requestedMode: mode, cause: error instanceof Error ? error.message : String(error) });
      }
    })();
    pending.set(tabId, operation);
    try { return await operation; }
    finally { if (pending.get(tabId) === operation) pending.delete(tabId); }
  }

  function retain(tabId: number, state: ModeState, context: ToolContext) {
    host.setDebuggerRetention(tabId, true, context, async send => {
      await apply(send, "mobile");
      state.connectionId = host.getDebuggerConnectionId(tabId);
    });
  }

  async function reloadPage(send: CdpCommand, signal?: AbortSignal) {
    const before = await send("Page.getFrameTree") as { frameTree?: { frame?: { loaderId?: string } } };
    const loader = before.frameTree?.frame?.loaderId;
    check(signal);
    await send("Page.reload", { ignoreCache: true });
    // Do not return old coordinates/DOM from a reload which Chrome has only scheduled.
    for (;;) {
      check(signal);
      const after = await send("Page.getFrameTree") as typeof before;
      if (after.frameTree?.frame?.loaderId && after.frameTree.frame.loaderId !== loader) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return {
    change, describePage,
    async preparePage(tabId: number, toolName: string, signal: AbortSignal | undefined, context: ToolContext) {
      // Parallel observations read the current page; restoring a preference can reload it.
      if (context.preserveWorkingTab || toolName === "set_page_mode" || toolName === "close_tab") return;
      const state = states.get(tabId);
      if (state?.sessionId !== context.sessionId || readPageMode(tabId, states) === "mobile") return;
      if ((context.source === "run_script" || context.runScriptToolDepth != null) && Number(context.senderTabId) === tabId) {
        throw new host.ToolExecutionError("PAGE_MODE_REOBSERVE_REQUIRED", t("modeResumeRequired"), { tabId });
      }
      await change(tabId, "mobile", signal, context, toolName !== "navigate");
    },
  };
}

async function apply(send: CdpCommand, mode: PageMode, check = () => {}) {
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    check(); const result = await send(method, params); check(); return result;
  };
  if (mode === "desktop") {
    await command("Emulation.clearDeviceMetricsOverride");
    await command("Emulation.setTouchEmulationEnabled", { enabled: false });
    await command("Emulation.setUserAgentOverride", { userAgent: "" });
    return;
  }
  const browser = await command("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true }) as { result?: { value?: string } };
  const version = /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(browser.result?.value || "")?.[1];
  if (!version) throw new Error("Chrome version unavailable");
  const brands = [{ brand: "Chromium", version: version.split(".")[0] }, { brand: "Google Chrome", version: version.split(".")[0] }];
  await command("Emulation.setUserAgentOverride", {
    userAgent: `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`,
    platform: "Linux armv8l",
    userAgentMetadata: { brands, fullVersionList: brands.map(brand => ({ ...brand, version })),
      platform: "Android", platformVersion: "13.0.0", architecture: "arm", model: "Pixel 7", mobile: true, bitness: "64", wow64: false },
  });
  await command("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625,
    mobile: true, screenWidth: 412, screenHeight: 915, screenOrientation: { type: "portraitPrimary", angle: 0 } });
  await command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}
