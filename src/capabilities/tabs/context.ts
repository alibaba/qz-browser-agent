import type { ContextCapability } from "#sdk/background/context";
import { readPageMode, pageModeStates } from "./page-mode.js";
import { toolT } from "./tool-messages.js";

/** Report live state, never the desired mode from a released connection. */
export default ((host) => [{
  id: "page-mode", get title() { return toolT("modeContextTitle"); }, maxChars: 400,
  read: async ({ sessionId }) => {
    const tab = await host.getWorkingTabContext(sessionId);
    if (!tab?.id) return null;
    const pageMode = readPageMode(tab.id);
    const saved = pageModeStates.get(tab.id);
    return JSON.stringify({ tabRef: tab.tabAlias || tab.id, ...(pageMode ? { pageMode } : { note: toolT("modeChanging") }),
      ...(saved?.sessionId === sessionId && pageMode === "desktop"
        ? { note: toolT("modeResume") } : {}) });
  },
}]) satisfies ContextCapability;
