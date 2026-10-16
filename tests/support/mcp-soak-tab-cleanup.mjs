// Keep long manual runs bounded without deleting task history or resources.
export async function closeCompletedTaskTabs({ mcp, sessionIds, activeSessionIds = [] }) {
  const active = new Set(activeSessionIds);
  const owners = [...new Set(sessionIds)].filter(id => !active.has(id));
  const report = { at: new Date().toISOString(), closed: [], skipped: [], errors: [] };
  if (!owners.length) return report;
  const contextId = owners[0];
  try {
    const listed = await mcp("qingzhou_execute_tool", { sessionId: contextId, name: "list_tabs", args: {}, wait: true });
    report.pageTabsBefore = listed.result.length;
    for (const sessionId of owners) {
      const tabs = listed.result.filter(tab => (tab.ownedByCurrentTask ? contextId : tab.ownerSessionId) === sessionId);
      if (!tabs.length) continue;
      const snapshot = await mcp("qingzhou_get_session_snapshot", { sessionId, compact: true });
      if (!["completed", "aborted", "interrupted", "cancelled"].includes(snapshot.status)) {
        report.skipped.push({ sessionId, status: snapshot.status });
        continue;
      }
      for (const tab of tabs) {
        try {
          // Manual management uses the explicit Session, not a revoked completed run.
          const result = await mcp("qingzhou_execute_tool", { sessionId, name: "close_tab", args: { tabId: tab.id }, wait: true });
          if (result.result.closed !== tab.id) throw new Error(`Tab ${tab.id} was not closed`);
          report.closed.push({ sessionId, tabId: tab.id });
        } catch (error) { report.errors.push({ sessionId, tabId: tab.id, message: error.message }); }
      }
    }
  } catch (error) { report.errors.push({ message: error.message }); }
  return report;
}
