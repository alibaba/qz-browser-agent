import type { BackgroundApi } from "../background-api.js";
import { resolveBackgroundApiMethod } from "../background-api.js";
type Fields = Record<string, unknown>;
export interface ResponsePort { postMessage(message: unknown): void; name?: string; sender?: chrome.runtime.MessageSender; signal?: AbortSignal }
interface TransportOptions {
  onMessage?: ((message: Fields) => unknown) | null;
  onDynamicContext?: ((message: Fields) => unknown) | null;
  getWindowId?(port: ResponsePort | undefined): number | null;
}
interface ReplyRoute {
  method: string; response: string; args(message: Fields, port: ResponsePort | undefined): unknown[];
  envelope?: string; requestOnly?: boolean;
}
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
import { formatTraceFields, trace } from "../trace.js";

/** Side Panel protocol adapter. Business decisions live behind Background API. */
export function createSidepanelTransport(api: BackgroundApi, {
  onMessage = null,
  onDynamicContext = null,
  getWindowId = () => null,
}: TransportOptions = {}) {
  const call = (path: string, ...args: unknown[]) => resolveBackgroundApiMethod(api, path)(...args);
  const replies: Readonly<Record<string, ReplyRoute>> = {
    mcp_connection_status: { method: "system.mcpConnectionStatus", response: "mcp_connection_status_result", envelope: "result", args: (_message, port) => [port?.sender || {}] },
    mcp_connection_connect: { method: "system.connectMcpFromSettings", response: "mcp_connection_connect_result", envelope: "result", args: (message, port) => [port?.sender || {}, { name: message.name, endpoint: message.endpoint }] },
    mcp_connection_disconnect: { method: "system.disconnectMcp", response: "mcp_connection_disconnect_result", envelope: "result", args: (_message, port) => [port?.sender || {}] },
    start_element_picker: { method: "ui.startElementPicker", response: "element_picker_result", args: message => [message.tabId] },
    confirm_element_picker: { method: "ui.confirmElementPicker", response: "element_picker_confirmed", args: message => [message.tabId] },
    cancel_element_picker: { method: "ui.cancelElementPicker", response: "element_picker_cancelled", args: message => [message.tabId] },
    list_models: { method: "config.listModels", response: "models", args: message => [{ provider: message.provider, apiKey: message.apiKey }] },
    match_model_capabilities: { method: "config.matchModelCapabilities", response: "model_capabilities", envelope: "match", args: message => [{ provider: String(message.provider || ""), model: String(message.model || "") }] },
    start_provider_login: { method: "auth.startLogin", response: "provider_login_started", args: message => [message.provider] },
    poll_provider_login: { method: "auth.pollLogin", response: "provider_login_polled", args: message => [message.provider, message.loginId] },
    logout_provider: { method: "auth.logout", response: "provider_logged_out", args: message => [message.provider] },
    // Retain the established wire messages for panels opened before an extension update.
    start_codex_login: { method: "auth.startLogin", response: "codex_login_started", args: () => ["openaicodex"] },
    poll_codex_login: { method: "auth.pollLogin", response: "codex_login_polled", args: message => ["openaicodex", message.loginId] },
    logout_codex: { method: "auth.logout", response: "codex_logged_out", args: () => ["openaicodex"] },
    get_skill_workspace: { method: "skills.workspaceRead", response: "skill_workspace", args: () => [] },
    save_workspace_skill: { method: "skills.workspaceSave", response: "skill_workspace_saved", args: message => [message] },
    import_workspace_skills: { method: "skills.workspaceImport", response: "skill_workspace_imported", args: message => [message] },
    delete_workspace_skill: { method: "skills.workspaceDelete", response: "skill_workspace_deleted", args: message => [message] },
    list_plugin_contributions: { method: "skills.contributions", response: "plugin_contributions", args: message => [message.sessionId] },
    refresh_skill_registry: { method: "skills.refresh", response: "skill_registry_refreshed",
      args: message => [{ reason: message.reason || "ui_skill_change", skillName: message.skillName || "", previousSkillName: message.previousSkillName || "", }]
    },
    list_git_skill_sources: { method: "skills.listGitSources", response: "git_skill_sources", args: () => [] },
    bind_git_skill_source: { method: "skills.bindGitSource", response: "git_skill_source_synced",
      args: (message, port) => [{ repositoryUrl: message.repositoryUrl || message.url || "", overwrite: message.overwrite === true, sourceWindowId: getWindowId(port), }]
    },
    check_git_skill_source: { method: "skills.checkGitSource", response: "git_skill_source_checked", args: (message, port) => [{ sourceId: message.sourceId || "", sourceWindowId: getWindowId(port), }] },
    update_git_skill_source: { method: "skills.updateGitSource", response: "git_skill_source_synced",
      args: (message, port) => [{ sourceId: message.sourceId || "", overwrite: message.overwrite === true, sourceWindowId: getWindowId(port), }]
    },
    remove_git_skill_source: { method: "skills.removeGitSource", response: "git_skill_source_removed",
      args: message => [{ sourceId: message.sourceId || "", deleteUnmodifiedSkills: message.deleteUnmodifiedSkills === true, }]
    },
    inspect_git_skill_publish_target: { method: "skills.inspectGitPublishTarget", response: "git_skill_publish_target", args: (message, port) => [{ tabId: message.tabId, sourceWindowId: getWindowId(port), }] },
    publish_skill_to_git: { method: "skills.publishToGit", response: "git_skill_published",
      args: (message, port) => [{ skill: message.skill || {}, target: message.target || {}, commitMessage: message.commitMessage || "", sourceWindowId: getWindowId(port), }]
    },
    validate_skill_mcp: { method: "skills.validateMcp", response: "skill_mcp_validated", args: message => [message.skill || {}, { refresh: message.refresh !== false }] },
    list_skill_settings: { method: "skillSettings.list", response: "skill_settings", args: () => [] },
    save_skill_settings: { method: "skillSettings.save", response: "skill_settings_saved",
      args: message => [{ pluginId: message.pluginId, skillName: message.skillName, values: message.values || {}, clearSecrets: message.clearSecrets || [], }]
    },
    delete_skill_settings: { method: "skillSettings.remove", response: "skill_settings_deleted", args: message => [{ pluginId: message.pluginId, skillName: message.skillName, }] },
    list_automations: { method: "automations.list", response: "automations", args: message => [{ limit: message.limit || 100, runLimit: message.runLimit || 5 }] },
    save_automation: { method: "automations.save", response: "automation_saved", args: message => [{ automation: message.automation || {} }] },
    delete_automation: { method: "automations.remove", response: "automation_deleted", args: message => [String(message.automationId || "").trim()] },
    run_automation: { method: "automations.run", response: "automation_run_started", args: (message, port) => [String(message.automationId || "").trim(), port?.signal] },
    list_automation_runs: { method: "automations.runs", response: "automation_runs", args: message => [{ automationId: message.automationId, limit: message.limit || 20 }] },
    get_config: { method: "config.get", response: "config", args: () => [], envelope: "config" },
    save_config: { method: "config.save", response: "config_saved", args: (message, port) => [message.config || {}, port?.signal], envelope: "config" },
    save_model_preset: { method: "config.savePreset", response: "config", args: message => [message.preset || message.config || {}], envelope: "config" },
    apply_model_preset: { method: "config.applyPreset", response: "config", args: message => [message.presetId], envelope: "config" },
    delete_model_preset: { method: "config.deletePreset", response: "config", args: message => [message.presetId], envelope: "config" },
    toggle_automation: { method: "automations.toggle", response: "automation_saved", args: message => [message], envelope: "automation" },
    get_trace: { method: "trace.get", response: "trace", args: () => [], envelope: "logs" },
    steer_follow_up: { method: "sessions.steerFollowUp", response: "follow_up_steered", args: message => [message], requestOnly: true },
    stage_chat_document: { method: "attachments.stage", response: "chat_document_staged", args: message => [message] },
    delete_chat_document: { method: "attachments.remove", response: "chat_document_deleted", args: message => [message], requestOnly: true },
    get_composer_draft: { method: "sessions.getDraft", response: "get_composer_draft_result", args: (message, port) => [{ sessionId: message.sessionId, windowId: getWindowId(port), ...(message.afterQueuedMutation === true ? { afterQueuedMutation: true } : {}) }] },
    delete_follow_up: { method: "sessions.deleteFollowUp", response: "follow_up_deleted", args: message => [message.sessionId, message.clientMessageId || ""], requestOnly: true },
    restore_queued_message: { method: "sessions.restoreQueuedMessage", response: "queued_message_restored", args: (message, port) => [{ ...message, windowId: getWindowId(port) }], requestOnly: true },
    delete_steering: { method: "sessions.deleteSteering", response: "steering_deleted", args: message => [message.sessionId, message.clientMessageId || ""], requestOnly: true },
    reorder_follow_ups: { method: "sessions.reorderFollowUps", response: "follow_ups_reordered", args: message => [message.sessionId, message.clientMessageIds || []], requestOnly: true },
    compact_context: { method: "sessions.compact", response: "compact_context_result", args: message => [{ sessionId: message.sessionId, instruction: message.instruction || "", }] },
    create_ui_session: { method: "sessions.createUi", response: "create_ui_session_result", args: (message, port) => [{ ...message, windowId: getWindowId(port), }] },
    rename_session: { method: "sessions.rename", response: "rename_session_result", args: message => [{ sessionId: message.sessionId, title: message.title, }] },
    list_sessions: { method: "sessions.list", response: "list_sessions_result", args: message => [{ limit: message.limit || 500, excludeSessionId: message.excludeSessionId || "", }] },
    hydrate_session_list_summaries: { method: "sessions.hydrateListSummaries", response: "hydrate_session_list_summaries_result",
      args: message => [{ sessionIds: message.sessionIds || [], limit: message.limit || 24, force: message.force === true, }], requestOnly: true
    },
    sync_session_artifact_list_summary: { method: "artifacts.syncSummary", response: "sync_session_artifact_list_summary_result",
      args: message => [message.sessionId, message.artifacts || {}, { action: message.action || "summary_reconcile" },], requestOnly: true
    },
    save_session_record: { method: "exchange.saveRecord", response: "save_session_record_result",
      args: message => [{ sessionId: message.sessionId, conversation: message.session ?? message.messages, transcript: message.transcript, }], requestOnly: true
    },
    import_session_exchange: { method: "exchange.import", response: "import_session_exchange_result", args: (message, port) => [message.payload, { sourceWindowId: getWindowId(port) }] },
    delete_session: { method: "sessions.remove", response: "delete_session_result", args: (message, port) => [message.sessionId, { source: "ui" }, port?.signal], requestOnly: true },
    clear_goal: { method: "sessions.clearGoal", response: "goal_cleared", args: (message, port) => [message.sessionId, message.source || "ui", port?.signal], requestOnly: true },
    get_history: { method: "sessions.history", response: "history", args: message => [message.sessionId] },
    restore_session: { method: "sessions.restore", response: "session_restored", args: message => [message.sessionId, message.session ?? message.messages] },
    get_state: { method: "sessions.state", response: "state", args: message => [message.sessionId] },
  };

  async function dispatch(message: Fields = {}, port?: ResponsePort) {
    const signal = port?.signal;
    signal?.throwIfAborted();
    const type = String(message.type || "");
    if (type === "ping") return true;
    if (type === "dynamic_context_response") {
      await onDynamicContext?.(message);
      return true;
    }

    await call("system.ready");
    signal?.throwIfAborted();
    await onMessage?.(message);
    signal?.throwIfAborted();

    const productResponse = await (api.product ? call("product.dispatch", message, {
      sourceWindowId: getWindowId(port), progress: (event: unknown) => port?.postMessage?.(event),
    }) : null);
    signal?.throwIfAborted();
    if (productResponse) {
      const response = object(productResponse);
      post(port, String(response.type || ""), message, response.payload);
      return true;
    }

    const reply = replies[type];
    if (reply) {
      const result = await call(reply.method, ...reply.args(message, port));
      if (!reply.requestOnly || message.requestId) {
        post(port, reply.response, message, reply.envelope ? { [reply.envelope]: result } : result);
      }
      return true;
    }

    switch (type) {
      case "prompt": {
        const windowId = getWindowId(port);
        const startedAt = Date.now();
        let accepted = false;
        traceMessageDelivery(message, "background.received", {
          window: windowId,
          textChars: String(message.text || "").length,
          images: Array.isArray(message.images) ? message.images.length : 0,
          documents: Array.isArray(message.documents) ? message.documents.length : 0,
        });
        try {
          const draftStartedAt = Date.now();
          const draftSynced = await updateSubmittedDraft(message, windowId, "sync");
          traceMessageDelivery(message, "draft.synced", {
            window: windowId,
            persisted: Boolean(draftSynced),
            elapsedMs: Date.now() - draftStartedAt,
          });
          const submission = await call("sessions.submit", {
            ...message,
            sourceWindowId: windowId,
            swallowErrors: false,
            onMessageAccepted: async (acceptedMessage: unknown, admission: Fields = {}) => {
              accepted = true;
              traceMessageDelivery(message, "background.accepted", {
                window: windowId,
                disposition: admission.disposition || "started",
                duplicate: admission.duplicate === true,
                elapsedMs: Date.now() - startedAt,
              });
              const draftConsumed = await updateSubmittedDraft(message, windowId, "consume");
              traceMessageDelivery(message, "draft.consumed", {
                window: windowId,
                consumed: Boolean(draftConsumed),
              });
              if (message.requestId) post(port, "prompt_accepted", message, {
                accepted: true,
                sessionId: message.sessionId,
                clientMessageId: object(acceptedMessage).clientMessageId || message.clientMessageId || "",
                disposition: admission.disposition || "started",
                duplicate: admission.duplicate === true,
              });
              traceMessageDelivery(message, "background.ack_sent", {
                window: windowId,
                elapsedMs: Date.now() - startedAt,
              });
            },
          }, signal);
          await object(submission).promise;
          traceMessageDelivery(message, "background.run_completed", {
            accepted,
            elapsedMs: Date.now() - startedAt,
          });
          return true;
        } catch (error) {
          traceMessageDelivery(message, accepted ? "background.failed_after_accept" : "background.failed_before_accept", {
            window: windowId,
            code: object(error).code || object(error).name || "ERROR",
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - startedAt,
          });
          throw error;
        }
      }
      case "resend_prompt":
        await call("sessions.resend", { ...message, sourceWindowId: getWindowId(port) });
        return true;
      case "follow_up": {
        const windowId = getWindowId(port);
        await updateSubmittedDraft(message, windowId, "sync");
        await call("sessions.followUp", message, signal);
        await updateSubmittedDraft(message, windowId, "consume");
        return true;
      }
      case "sync_composer_draft": {
        const windowId = getWindowId(port);
        if (windowId === null || windowId === undefined) {
          throw Object.assign(
            new Error("Side Panel must attach its browser window before syncing a draft"),
            { code: "COMPOSER_DRAFT_WINDOW_REQUIRED" },
          );
        }
        const result = await call("sessions.saveDraft", {
          draft: message.draft,
          sessionId: message.sessionId,
          windowId,
        });
        if (message.requestId) post(port, "sync_composer_draft_result", message, result);
        return true;
      }
      case "reset":
        await call("sessions.reset", message.sessionId);
        return true;
      case "create_session":
        await call("sessions.create", message, signal);
        return true;
      case "get_session_artifacts": {
        const artifacts = await call("artifacts.list", message.sessionId);
        post(port, "session_artifacts_result", message, { sessionId: message.sessionId, artifacts });
        return true;
      }
      case "export_session_exchange": {
        const payload = await call("exchange.export", message.sessionId);
        post(port, "export_session_exchange_result", message, { payload });
        return true;
      }
      case "stop_session": {
        const stopped = await call("sessions.stop", message.sessionId, { source: message.source || "ui" }, signal);
        if (message.requestId) {
          const stoppedRecord = object(stopped);
          const runtime = object(stoppedRecord.runtime);
          post(port, "state", message, {
            sessionId: stoppedRecord.sessionId || message.sessionId,
            isStreaming: false,
            status: runtime.status || stoppedRecord.status || "idle",
            runtime,
            runId: runtime.runId || stoppedRecord.runId || null,
            hasHistory: true,
          });
        }
        return true;
      }
      case "continue_task":
      case "cancel_wait": {
        const result = await call(message.type === "continue_task" ? "sessions.continueWait" : "sessions.cancelWait", message, signal);
        post(port, "user_input_response", message, result);
        return true;
      }
      case "get_messages": {
        const result = await call("sessions.messages", message.sessionId);
        post(port, "messages", message, { ...object(result), save: message.save !== false });
        return true;
      }
      case "activate_session_working_tab": {
        const result = await call("ui.activateWorkingTab", message.sessionId);
        post(port, "session_working_tab_activated", message, { sessionId: message.sessionId, result });
        return true;
      }
      case "stream_trace":
        await call("trace.stream", message);
        return true;
      case "clear_trace":
        await call("trace.clear");
        post(port, "trace_cleared", message, {});
        return true;
      default:
        return false;
    }
  }

  async function updateSubmittedDraft(message: Fields, windowId: number | null, action: "sync" | "consume") {
    const messageId = String(message.clientMessageId || "").trim();
    if (windowId == null || !messageId || !message.composerDraft) return false;
    try {
      return await call(action === "sync" ? "sessions.saveDraft" : "sessions.consumeDraft", {
        ...(action === "sync" ? {
          draft: {
            ...object(message.composerDraft),
            sessionId: message.sessionId,
            messageId,
          },
        } : {}),
        ...(action === "consume" ? { messageId } : {}),
        windowId,
        sessionId: message.sessionId,
      });
    } catch (error) {
      console.warn(`[轻舟] composer draft ${action} failed`, error);
      traceMessageDelivery(message, `draft.${action}_failed`, {
        window: windowId,
        code: object(error).code || object(error).name || "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return Object.freeze({ dispatch });
}

function traceMessageDelivery(message: Fields = {}, phase = "", fields: Fields = {}) {
  trace(`message_delivery_trace${formatTraceFields({
    phase,
    request: message.requestId,
    session: message.sessionId,
    message: message.clientMessageId,
    ...fields,
  })}`);
}

function post(port: ResponsePort | undefined, type: string, request: Fields, payload: unknown = {}) {
  port?.postMessage?.({
    type,
    ...(request?.requestId ? { requestId: request.requestId } : {}),
    ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { result: payload }),
  });
}
