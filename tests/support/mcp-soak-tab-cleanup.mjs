// The isolated browser fixture closes native task tabs as a user would. Native
// Sessions cannot execute drive tools, and stopping a completed root keeps its tabs.
export async function closeCompletedTaskTabs({ mcp, page, sessionIds, activeSessionIds = [] }) {
  const active = new Set(activeSessionIds);
  const owners = [...new Set(sessionIds)].filter(id => !active.has(id));
  const report = { at: new Date().toISOString(), closed: [], skipped: [], errors: [] };
  if (!owners.length) return report;
  for (const sessionId of owners) {
    try {
      const snapshot = await mcp("qingzhou_get_session_snapshot", { sessionId, compact: true });
      const terminal = ["completed", "aborted", "interrupted", "cancelled", "error"];
      if (!terminal.includes(snapshot.status) || snapshot.isStreaming || snapshot.runtime?.running) {
        report.skipped.push({ sessionId, status: snapshot.status });
        continue;
      }
      const result = await page.evaluate(async ({ sessionId, runId, terminal }) => {
        // Read the isolated profile's checkpoints, never write them. Chrome's
        // existing onRemoved handler updates ownership and keeps history intact.
        const runtimes = async () => Object.entries(await chrome.storage.local.get(null))
          .filter(([key, value]) => key.startsWith("_session_runtime_") && value?.sessionId)
          .map(([, value]) => value);
        const owned = runtime => runtime?.ownedTabIds || [];
        const settled = runtime => terminal.includes(runtime?.status) && !runtime.running && !runtime.pendingStart
          && runtime.runId === runId && !runtime.waitId
          && ["pendingFollowUps", "pendingFollowUpMessages", "pendingSteerings", "pendingSteeringMessages"]
            .every(key => !runtime[key]?.length);
        const result = { closed: [], skipped: [], errors: [] };
        const initial = (await runtimes()).find(runtime => runtime.sessionId === sessionId);
        for (const tabId of new Set(owned(initial))) {
          const current = await runtimes();
          const owner = current.find(runtime => runtime.sessionId === sessionId);
          if (!settled(owner) || !owned(owner).includes(tabId)
            || current.some(runtime => runtime.sessionId !== sessionId && owned(runtime).includes(tabId))) {
            result.skipped.push({ sessionId, tabId, reason: "task_or_ownership_changed" });
            continue;
          }
          try {
            await chrome.tabs.remove(tabId);
            result.closed.push({ sessionId, tabId });
          } catch (error) { result.errors.push({ sessionId, tabId, message: error.message }); }
        }
        return result;
      }, { sessionId, runId: snapshot.runId ?? snapshot.runtime?.runId ?? null, terminal });
      for (const key of ["closed", "skipped", "errors"]) report[key].push(...result[key]);
    } catch (error) { report.errors.push({ sessionId, message: error.message }); }
  }
  return report;
}
