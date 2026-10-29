import { modelT } from "./model-messages.js";
import { t } from "./i18n.js";
import { registerGoalTools } from "./goal-tools.js";
import { sessionAutomationsEnabled } from "#sdk/shared/session-automations";
import type { ToolExtension, ToolExtensionAPI, AutomationSaveInput } from "#sdk/background";
import { requireToolFields } from "#sdk/background/tools";
import { sessionWaitTimeout } from "#sdk/background/tools";
import { ROOT_SESSION_ID } from "#sdk/shared/sessions";

type SessionToolsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies" | "secondsToMs">;

const AUTOMATION_SESSION_ACTIONS = [
  "list_automations",
  "create_automation",
  "update_automation",
  "delete_automation",
  "run_automation",
  "automation_runs",
] as const;
const AUTOMATION_SESSION_ACTION_SET = new Set<string>(AUTOMATION_SESSION_ACTIONS);

export function registerSessionTools({
  registerTool,
  getToolRuntimeDependencies,
  ToolExecutionError,
  secondsToMs,
}: SessionToolsHost) {
registerTool({
  name: "manage_sessions",
  requires: { rootSession: { code: "SESSION_TOOL_FORBIDDEN", get message() { return "manage_sessions is only available in user-created root sessions. Agent-created child sessions and automation sessions cannot create, list, wait for, or delete other sessions."; } } },
  get description() { return modelT(sessionAutomationsEnabled() ? "manageSessions" : "manageSessionsWithoutAutomations"); },
  get parameters() { return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "create",
          "send_message",
          "stop",
          "delete",
          "last_messages",
          "wait",
          ...(sessionAutomationsEnabled() ? AUTOMATION_SESSION_ACTIONS : []),
        ],
        description: modelT(sessionAutomationsEnabled() ? "sessionAction" : "sessionActionWithoutAutomations"),
      },
      sessionId: { type: "string", description: modelT("sessionId") },
      message: { type: "string", description: modelT("sessionMessage") },
      mode: { type: "string", enum: ["follow_up", "steer"], description: modelT("sessionMessageMode") },
      automationId: { type: "string", description: modelT("automationId") },
      sessionIds: {
        type: "array",
        items: { type: "string" },
        description: modelT("sessionIds"),
      },
      waitFor: {
        type: "string",
        enum: ["any", "all"],
        description: modelT("sessionWaitFor"),
      },
      title: { type: "string", description: modelT("sessionTitle") },
      firstMessage: { type: "string", description: modelT("sessionFirstMessage") },
      instruction: { type: "string", description: modelT("automationInstruction") },
      schedule: {
        type: "object",
        description: modelT("automationSchedule"),
        properties: {
          type: {
            type: "string",
            enum: ["once", "hourly", "daily", "weekly"],
            description: modelT("automationScheduleType"),
          },
          runAt: { type: "string", description: modelT("automationRunAt") },
          time: { type: "string", description: modelT("automationTime") },
          weekday: { type: "number", description: modelT("automationWeekday") },
          intervalMinutes: { type: "number", description: modelT("automationIntervalMinutes") },
          intervalHours: { type: "number", description: modelT("automationIntervalHours") },
        },
      },
      missedPolicy: {
        type: "string",
        enum: ["run_once", "latest_only", "skip"],
        description: modelT("automationMissedPolicy"),
      },
      notifyPolicy: {
        type: "string",
        enum: ["failure", "always", "silent"],
        description: modelT("automationNotifyPolicy"),
      },
      enabled: { type: "boolean", description: modelT("automationEnabled") },
      limit: { type: "number", description: modelT("sessionListLimit") },
      runLimit: { type: "number", description: modelT("automationRunLimit") },
      num: { type: "number", description: modelT("sessionMessageLimit") },
      timeout: { type: "number", description: modelT("sessionWaitTimeout") },
    },
    required: ["action"],
  } as const; },
  timeout: sessionWaitTimeout,
  legacyTimeoutMs: args => args.action === "wait",
  execute: async ({
    action,
    message = "",
    mode = "follow_up",
    sessionId,
    automationId,
    sessionIds,
    waitFor = "all",
    title = "",
    firstMessage = "",
    instruction = "",
    schedule = null,
    missedPolicy,
    notifyPolicy,
    enabled,
    limit = 100,
    runLimit = 3,
    num = 5,
    timeout,
    timeoutMs,
  }, signal, context = {}) => {
    const actionName = String(action || "");
    if (AUTOMATION_SESSION_ACTION_SET.has(actionName) && !sessionAutomationsEnabled()) {
      return {
        error: modelT("sessionAutomationsDisabled"),
        code: "AUTOMATION_DISABLED",
        details: { action: actionName },
      };
    }
    const commands = getToolRuntimeDependencies(context).sessions;
    if (action === "list") {
      const excludeSessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
      if (typeof commands?.listSessions === "function") {
        return await commands.listSessions({ limit, excludeSessionId });
      }
      return runtimeUnavailable("list");
    }

    if (action === "create") {
      const parentSessionId = typeof context.sessionId === "string" && context.sessionId.trim()
        ? context.sessionId.trim()
        : ROOT_SESSION_ID;
      if (typeof commands?.createSession === "function") {
        const result = await commands.createSession({ title, firstMessage, parentSessionId });
        return { created: true, ...result };
      }
      return runtimeUnavailable("create");
    }

    if (action === "stop" || action === "send_message") {
      const id = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!id) throw new ToolExecutionError("MISSING_SESSION_ID", t("specifyTheTargetTaskSSessionid"), { action });
      if (id === context.sessionId) throw new ToolExecutionError("INVALID_SESSION_ACTION", t("thisOperationCanOnlyTargetAnotherTask"), { action });
      if (action === "stop") {
        if (!commands?.stopSession) return runtimeUnavailable(action, { sessionId: id });
        return await commands.stopSession(id, { source: "tool", requestedBy: context.sessionId || "" });
      }
      if (!String(message).trim() || !["follow_up", "steer"].includes(mode)) {
        throw new ToolExecutionError("INVALID_SESSION_ACTION", t("aFollowUpRequiresANonemptyMessageAndMode"), { action });
      }
      if (!commands?.sendMessage) return runtimeUnavailable(action, { sessionId: id });
      const clientMessageId = `session-tool:${context.sessionId || "root"}:${context.runId || ""}:${context.toolCallId || crypto.randomUUID()}`;
      return await commands.sendMessage({ sessionId: id, text: message.trim(), deliveryMode: mode, clientMessageId, swallowErrors: true });
    }

    if (action === "delete") {
      const id = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!id) {
        throw new ToolExecutionError("MISSING_SESSION_ID", t("manageSessionsDeleteRequiresSessionid"), { action });
      }
      if (context.sessionId && id === context.sessionId) {
        return {
          error: "Cannot delete the session currently executing this tool",
          code: "CANNOT_DELETE_CALLER_SESSION",
          details: { sessionId: id },
        };
      }
      if (typeof commands?.deleteSession === "function") {
        return await commands.deleteSession(id, {
          requestedBy: context.sessionId || "",
          source: "tool",
        });
      }
      return runtimeUnavailable("delete", { sessionId: id });
    }

    if (action === "last_messages") {
      const id = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!id) {
        throw new ToolExecutionError("MISSING_SESSION_ID", t("manageSessionsLastMessagesRequiresSessionid"), { action });
      }
      if (typeof commands?.getLastMessages === "function") {
        return await commands.getLastMessages({ sessionId: id, num });
      }
      return {
        error: "Session runtime is not available for last_messages",
        code: "SESSION_RUNTIME_UNAVAILABLE",
        details: { sessionId: id, num },
      };
    }

    if (action === "wait") {
      const ids = Array.isArray(sessionIds) && sessionIds.length > 0 ? sessionIds : (sessionId ? [sessionId] : []);
      const excludeSessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
      if (typeof commands?.waitSessions === "function") {
        return await commands.waitSessions({
          sessionIds: ids,
          waitFor,
          timeoutMs: timeoutMs != null ? timeoutMs : secondsToMs(timeout, 0),
          num,
          excludeSessionId,
          signal,
        });
      }
      return {
        error: "Session runtime is not available for wait",
        code: "SESSION_RUNTIME_UNAVAILABLE",
        details: { sessionIds: ids, waitFor },
      };
    }

    if (action === "list_automations") {
      if (typeof commands?.listAutomations === "function") {
        return await commands.listAutomations({ limit, runLimit });
      }
      return {
        error: "Automation runtime is not available for list_automations",
        code: "AUTOMATION_RUNTIME_UNAVAILABLE",
        details: { action },
      };
    }

    if (action === "create_automation" || action === "update_automation") {
      if (typeof commands?.saveAutomation !== "function") {
        return {
          error: `Automation runtime is not available for ${action}`,
          code: "AUTOMATION_RUNTIME_UNAVAILABLE",
          details: { action },
        };
      }
      const id = typeof automationId === "string" ? automationId.trim() : "";
      if (action === "update_automation" && !id) {
        throw new ToolExecutionError("MISSING_AUTOMATION_ID", t("manageSessionsUpdateAutomationRequiresAutomationid"), { action });
      }
      const normalizedTitle = String(title || "").trim();
      if (action === "create_automation" && !normalizedTitle) {
        throw new ToolExecutionError(
          "MISSING_AUTOMATION_TITLE",
          t("manageSessionsCreateAutomationRequiresAShortSpecificTitle"),
          { action, requiredFields: ["title", "instruction"] },
        );
      }
      const text = String(instruction || firstMessage || "").trim();
      if (action === "create_automation" && !text) {
        throw new ToolExecutionError(
          "MISSING_AUTOMATION_INSTRUCTION",
          t("manageSessionsCreateAutomationRequiresInstructionSummarizeTheVali"),
          { action },
        );
      }
      const automation: AutomationSaveInput = action === "update_automation"
        ? { id }
        : { title: normalizedTitle, instruction: text };
      if (id) automation.id = id;
      if (normalizedTitle) automation.title = normalizedTitle;
      if (text) automation.instruction = text;
      if (schedule && typeof schedule === "object" && !Array.isArray(schedule)) automation.schedule = schedule;
      if (missedPolicy) automation.missedPolicy = missedPolicy;
      if (notifyPolicy) automation.notifyPolicy = notifyPolicy;
      if (typeof enabled === "boolean") automation.enabled = enabled;
      if (action === "create_automation" && typeof enabled !== "boolean") automation.enabled = true;
      const result = await commands.saveAutomation({
        automation,
        sourceSessionId: context.sessionId || "",
      });
      return { [action === "create_automation" ? "created" : "updated"]: true, ...result };
    }

    if (action === "delete_automation") {
      const id = typeof automationId === "string" ? automationId.trim() : "";
      if (!id) {
        throw new ToolExecutionError("MISSING_AUTOMATION_ID", t("manageSessionsDeleteAutomationRequiresAutomationid"), { action });
      }
      if (typeof commands?.deleteAutomation === "function") {
        return await commands.deleteAutomation(id);
      }
      return {
        error: "Automation runtime is not available for delete_automation",
        code: "AUTOMATION_RUNTIME_UNAVAILABLE",
        details: { action, automationId: id },
      };
    }

    if (action === "run_automation") {
      const id = typeof automationId === "string" ? automationId.trim() : "";
      if (!id) {
        throw new ToolExecutionError("MISSING_AUTOMATION_ID", t("manageSessionsRunAutomationRequiresAutomationid"), { action });
      }
      if (typeof commands?.runAutomation === "function") {
        return await commands.runAutomation(id);
      }
      return {
        error: "Automation runtime is not available for run_automation",
        code: "AUTOMATION_RUNTIME_UNAVAILABLE",
        details: { action, automationId: id },
      };
    }

    if (action === "automation_runs") {
      const id = typeof automationId === "string" ? automationId.trim() : "";
      if (!id) {
        throw new ToolExecutionError("MISSING_AUTOMATION_ID", t("manageSessionsAutomationRunsRequiresAutomationid"), { action });
      }
      if (typeof commands?.listAutomationRuns === "function") {
        return await commands.listAutomationRuns({ automationId: id, limit });
      }
      return {
        error: "Automation runtime is not available for automation_runs",
        code: "AUTOMATION_RUNTIME_UNAVAILABLE",
        details: { action, automationId: id },
      };
    }

    throw new ToolExecutionError("INVALID_SESSION_ACTION", t("unsupportedManageSessionsAction", { action: String(action) }), { action });
  },
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (AUTOMATION_SESSION_ACTION_SET.has(action) && !sessionAutomationsEnabled()) return;
    if (["stop","delete","last_messages"].includes(action)) requireToolFields("manage_sessions", args, ["sessionId"], { action, requiredWhen: `action=${action}` });
    if (["send_message"].includes(action)) requireToolFields("manage_sessions", args, ["sessionId","message"], { action, requiredWhen: `action=${action}` });
    if (["wait"].includes(action)) requireToolFields("manage_sessions", args, [["sessionIds","sessionId"]], { action, requiredWhen: `action=${action}` });
    if (["create_automation"].includes(action)) requireToolFields("manage_sessions", args, [["instruction","firstMessage"]], { action, requiredWhen: `action=${action}` });
    if (["update_automation","delete_automation","run_automation","automation_runs"].includes(action)) requireToolFields("manage_sessions", args, ["automationId"], { action, requiredWhen: `action=${action}` });
  },
});

function runtimeUnavailable(action: string, details: Record<string, unknown> = {}) {
  return {
    error: `Session runtime is not available for ${action}`,
    code: "SESSION_RUNTIME_UNAVAILABLE",
    details: { action, ...details },
  };
}

}


export default ((host) => {
  registerSessionTools(host);
  registerGoalTools(host);
  host.registerTool({
    name: "get_location",
    get title() { return t("getLocation"); },
    get description() { return modelT("getLocation"); },
    parameters: { type: "object", properties: {} },
    model: { pageContext: false },
    timeout: 0,
    execute: (_args, signal, context) => {
      const request = host.getToolRuntimeDependencies(context).requestLocation;
      if (!request) throw new host.ToolExecutionError("LOCATION_UNAVAILABLE", t("locationUnavailable"));
      return request(context, signal);
    },
  });
}) satisfies ToolExtension;
