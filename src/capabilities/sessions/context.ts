import type { ContextCapability } from "#sdk/background/context";
import { normalizeSessionGoal, normalizeSessionTracker } from "#sdk/background/sessions";
import { annotateSecurityGuardrailTab } from "#sdk/shared/security";

/** Structured values stay private to the Session host; only titled sources become model text. */
export default ((host) => [
  { id: "session", required: true, reasons: ["snapshot", "site-skills"], read: async ({ sessionId, reason }) => {
    const runtime = host.getSessionRuntime(sessionId) || {};
    const context: Record<string, unknown> = {};
    if (Array.isArray(runtime.visitedTaskSites) && runtime.visitedTaskSites.length) context.taskSiteTabs = runtime.visitedTaskSites;
    if (reason === "snapshot") {
      const tracker = normalizeSessionTracker(runtime.tracker);
      if (tracker) context.tracker = tracker;
      if (await host.canUseSessionGoal(sessionId)) {
        const goal = normalizeSessionGoal(runtime.goal);
        if (goal && goal.status !== "complete") context.goal = goal;
      }
    }
    return context;
  } },
  { id: "workingTab", reasons: ["snapshot", "site-skills", "tool"], read: async ({ sessionId }) => {
    const tab = await host.getWorkingTabContext(sessionId);
    if (!tab) return null;
    try { return annotateSecurityGuardrailTab(tab, await host.getSecurityGuardrails()); }
    catch { return tab; } // Tool execution still enforces the guardrail at its own boundary.
  } },
]) satisfies ContextCapability;
