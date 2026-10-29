/** Stand-in used when the Firefox boot has turned session automations off. */
export function sessionAutomationsDisabledError(method: string): Error {
  const error = new Error("Session automations are disabled in Firefox. Stored scheduled tasks do not run.");
  error.name = "SessionAutomationsDisabledError";
  return Object.assign(error, { code: "AUTOMATION_DISABLED", method });
}

function rejectDisabled(method: string): Promise<never> {
  return Promise.reject(sessionAutomationsDisabledError(method));
}

export function createDisabledAutomationRuntime() {
  return Object.freeze({
    start: () => Promise.resolve(false),
    handleAlarm(_alarm: { name?: string }) {
      return false;
    },
    queueScheduler: (_reason?: string) => Promise.resolve({ started: false, reason: "disabled" }),
    list: () => rejectDisabled("list"),
    save: () => rejectDisabled("save"),
    toggle: () => rejectDisabled("toggle"),
    remove: () => rejectDisabled("remove"),
    run: (_automationId?: string, _signal?: AbortSignal) => rejectDisabled("run"),
    listRuns: () => rejectDisabled("listRuns"),
    syncSessionOutcome: (_sessionId?: string) => Promise.resolve(false),
    consumeNotificationSession(_notificationId?: string) {
      return "";
    },
    handleNotificationClick: (_notificationId?: string) => Promise.resolve(false),
    flush: () => Promise.resolve(),
    inspect: () => ({ notificationSessionCount: 0 }),
  });
}
