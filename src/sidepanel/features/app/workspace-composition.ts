import { t } from "../../i18n/index.js";
import capabilities from "#capabilities/ui";
import type { createChatWorkspaceFeature } from "../chat/chat-workspace-feature.js";
import type { createSessionState } from "../sessions/session-state.js";
import type { createSidepanelPortRuntime } from "./sidepanel-port-runtime.js";
import type { createPerfTrace } from "../dev/perf-trace.js";
import type { WorkspaceExtensions } from "./workspace-extensions.js";
import type { WorkspaceView } from "./workspace-view-store.js";
import { sessionIdText as normalizeSessionId } from "../sessions/session-id.js";
import { isSessionRuntimeActive } from "../sessions/session-state.js";
import { CHAT_RUN_STATES } from "../chat/chat-run-controller.js";
import { createSessionExportFeature } from "../export/session-export-feature.js";
import { createSessionNavigationFeature } from "../sessions/session-navigation-feature.js";
import { createDecisionDialogFeature } from "../../ui/decision-dialog-feature.js";
import { createAppShellFeature } from "./app-shell-feature.js";
import { createDynamicContextProvider } from "./dynamic-context-provider.js";
import { createSidepanelEventRouter } from "./sidepanel-event-router.js";
import { createSidepanelUiRuntime } from "../../capability-host/runtime.js";
import { createSettingsShell } from "../../capability-host/settings-shell.js";
import { createSkillToolCatalog } from "./skill-tool-catalog.js";
import { createProductSettings } from "../../product/settings.js";
import { defaultWorkspaceView, normalizeWorkspaceView, WORKSPACE_VIEW_VERSION } from "./workspace-view-store.js";

type Navigation = ReturnType<typeof createSessionNavigationFeature>;
interface WorkspaceOptions {
  root?: Document; tabs: { CHAT: string }; initialView?: WorkspaceView;
  sessionState: ReturnType<typeof createSessionState>; chat: ReturnType<typeof createChatWorkspaceFeature>;
  extensions: WorkspaceExtensions;
  portRuntime: ReturnType<typeof createSidepanelPortRuntime>; perf: ReturnType<typeof createPerfTrace>;
  getCurrentSessionId(): string | null; getCurrentTab(): string; setCurrentTab(tab: string): void;
  setCurrentSessionIdValue(id: string | null): void; getSessionSwitchEpoch(): number; incrementSessionSwitchEpoch(): number;
  isDebugEnabled(): boolean; setDebugEnabled(value: boolean): void; resetNavigation(): void; nowTimestamp(): string;
  onWorkspaceViewChange?(view: WorkspaceView): unknown;
}

/** The composition root supplies framework ports. File-discovered packages own all
 * optional pages, forms, decorations and their event subscriptions. */
export function createWorkspaceComposition(options: WorkspaceOptions) {
  const root = options.root || document;
  const { tabs, sessionState, chat, extensions, perf } = options;
  const port = options.portRuntime;
  const lifetime = new AbortController();
  const skillToolCatalog = createSkillToolCatalog({
    signal: lifetime.signal, request: port.request, getCurrentSessionId: options.getCurrentSessionId,
    refreshReferences: chat.slashMenu.refresh,
  });
  const initialView = normalizeWorkspaceView(options.initialView || defaultWorkspaceView());
  let appShell: ReturnType<typeof createAppShellFeature>;
  let navigation: Navigation;
  let eventRouter: ReturnType<typeof createSidepanelEventRouter>;
  let startPromise: Promise<void> | null = null;
  let workspaceStarted = false;
  let pendingSessionRevealId: string | null = null;
  let stableViewScheduled = false;
  let lastStableViewSignature = JSON.stringify(initialView);
  const getCurrentSessionId = options.getCurrentSessionId;
  const getCurrentTab = options.getCurrentTab;
  const getRuntime = (id: unknown) => sessionState.getRuntime(normalizeSessionId(id));
  const isRuntimeRunning = isSessionRuntimeActive;
  const isCurrentSession = (id: unknown) => Boolean(normalizeSessionId(id) && normalizeSessionId(id) === getCurrentSessionId());
  const switchTab: ReturnType<typeof createAppShellFeature>["switchTab"] = (tab, input = {}) => appShell?.switchTab(tab, input) === true;
  const switchToSession: Navigation["switchToSession"] = (id, input = {}) => {
    // Hold the target until boot finishes. Restoring the saved new-chat view would
    // otherwise replace an import that arrived while the panel was still starting.
    if (!workspaceStarted && (input.source === "notification" || input.source === "export_import")) {
      pendingSessionRevealId = normalizeSessionId(id) || null;
      return Promise.resolve(undefined);
    }
    return navigation.switchToSession(id, input);
  };
  const transitionToSession: Navigation["transitionToSession"] = (id, input = {}) => navigation.transitionToSession(id, input);
  const refreshCurrentSessionTitle: Navigation["refreshCurrentSessionTitle"] = snapshot => navigation.refreshCurrentSessionTitle(snapshot);
  const resetUi = () => { chat.transcript.resetUi(); extensions.notify({ type: "ui_chat_reset" }); };
  const notifyStableViewChange = () => {
    if (!workspaceStarted || stableViewScheduled) return;
    stableViewScheduled = true;
    queueMicrotask(() => {
      stableViewScheduled = false;
      const view = captureWorkspaceView();
      const signature = JSON.stringify(view);
      if (signature === lastStableViewSignature) return;
      lastStableViewSignature = signature;
      Promise.resolve(options.onWorkspaceViewChange?.(view)).then(
        saved => { if (saved === false && lastStableViewSignature === signature) lastStableViewSignature = ""; },
        () => { if (lastStableViewSignature === signature) lastStableViewSignature = ""; },
      );
    });
  };
  const decisions = createDecisionDialogFeature({ root, hideToast: chat.toast.hide });
  const settingsShell = createSettingsShell(root);
  const sessionExport = createSessionExportFeature({
    request: port.request, normalizeSessionId, getCurrentSessionId,
    projectTranscript: transcript => chat.projection.visibleHistory(transcript),
    renderTranscriptElement: (entry, context) => chat.transcript.createElement(entry, context.sessionId, context.index,
      context.lastUserIndex, context.assistantActionIndexes),
    flashAction: chat.transcript.flashAction,
  });
  const ui = createSidepanelUiRuntime({ host: {
    root, settings: settingsShell.port, extensions, request: port.request, send: port.send,
    providers: { createSettings: createProductSettings },
    getCurrentSessionId, getCurrentPage: getCurrentTab,
    getRunContext: () => ({ runStatus: chat.runController.getStatus(), activeRunId: chat.runController.getActiveRunId(), currentSessionId: getCurrentSessionId() }),
    navigate: switchTab, notifyViewChange: notifyStableViewChange,
    showToast: chat.toast.show, hideToast: chat.toast.hide, dialogs: decisions,
    isDebugEnabled: options.isDebugEnabled,
    setDebugMode: enabled => appShell ? appShell.setDebugMode(enabled) : options.setDebugEnabled(enabled),
    syncKeepAlive: port.syncKeepAlive,
    sessions: {
      getRuntime, getRecord: sessionState.getRecord.bind(sessionState), mergeRecord: sessionState.mergeRecord.bind(sessionState),
      mergeRecords: sessionState.mergeRecords.bind(sessionState), mergeRuntime: sessionState.mergeRuntime.bind(sessionState),
      getTranscript: chat.transcript.getTranscript, hasTranscript: chat.transcript.hasTranscript,
      isDeleted: id => eventRouter?.isDeletedSession(id) === true,
      updateRuntime: (id, event) => eventRouter?.updateRuntime(id, event) === true,
      open: (id, input) => switchToSession(id, input), export: sessionExport.exportSession, isExporting: sessionExport.isPreparing,
    },
    chat: {
      messages: chat.elements.messagesEl, input: chat.elements.inputEl, welcomeHTML: chat.elements.welcomeHTML,
      setInput: chat.composer.setValue, showWelcome: chat.runController.showWelcome,
      focus: source => appShell?.scheduleComposerFocus(source),
      refresh: id => chat.transcript.render(id, { force: true }), scheduleRender: chat.transcript.scheduleRender,
      appendNote: chat.transcript.appendSystemNote, clearInlineActions: chat.transcript.clearInlineActions,
      flashAction: chat.transcript.flashAction, refreshReferences: chat.slashMenu.refresh,
      isGoalClearPending: chat.goal.isClearPending, renderGoal: chat.goal.renderCurrent,
    },
    presentation: { renderMarkdown: chat.renderMarkdown, clearMath: chat.math.clear,
      scheduleMath: chat.math.schedule, highlightSearchText: chat.search.highlightText },
    performance: { start: perf.start, grid: perf.dataGrid },
  } });
  settingsShell.connect(ui);
  ui.mount({ id: "workspace", mount: () => ({
    pages: [{ id: tabs.CHAT, title: t("chat"), order: 0,
      elements: [chat.elements.sessionTitleBar, chat.elements.messagesEl, chat.elements.chatDock],
      activate: ({ refresh }) => {
        if (!refresh) return;
        void refreshCurrentSessionTitle();
        const id = getCurrentSessionId();
        if (id) chat.transcript.render(id, { force: true });
        chat.runController.renderDock();
      },
      deactivate: () => chat.search.close({ restoreFocus: false }),
      capture: () => ({ sessionId: getCurrentSessionId() }),
      async restore(state, { signal }) {
        const id = normalizeSessionId(state && typeof state === "object" && "sessionId" in state ? state.sessionId : null);
        const exists = id && await navigation.hasStoredSession(id);
        signal.throwIfAborted();
        if (exists) {
          await navigation.switchToSession(id, { source: "restore", signal });
          signal.throwIfAborted();
          await navigation.refreshCurrentSessionTitle();
        } else await navigation.transitionToSession(null, { reload: true, signal });
      },
    }],
    overlays: [settingsShell.overlay, { id: "chat-slash-menu", priority: 80,
      close: () => { if (!chat.slashMenu.isOpen()) return false; chat.slashMenu.close(); return true; },
      blocksFocus: () => !chat.search.bar?.classList.contains("hidden"),
    }],
  }) });
  const mounted = ui.mountAll(capabilities);
  const dynamicContext = createDynamicContextProvider({ geolocation: globalThis.navigator?.geolocation, send: port.send });
  eventRouter = createSidepanelEventRouter({
    sessionState, runController: chat.runController, transcriptRenderer: chat.transcript, transcriptReconcile: chat.reconcile,
    queuedFollowups: chat.queue, goalStrip: chat.goal, runStates: CHAT_RUN_STATES,
    getCurrentSessionId, getCurrentTab, isCurrentSession, switchToSession, transitionToSession,
    forgetComposerSession: chat.composer.forgetSession, setCurrentSessionTitle: title => navigation.setCurrentSessionTitle(title),
    refreshCurrentSessionTitle,
    applyConversationSnapshot: input => navigation.applyConversationSnapshot(input),
    replaceTranscript: (id, transcript) => navigation.replaceTranscriptFromRuntime(id, transcript),
    requestConversationSnapshot: (id, input) => navigation.requestConversationSnapshot(id, input),
    saveCurrentSession: () => navigation.saveCurrentSession(), resetUi, send: port.send,
    syncKeepAlive: port.syncKeepAlive, emitStreamTrace: port.emitStreamTrace,
    ensureAcceptedUserMessageVisible: chat.scroll.lockForSubmittedAction, handleDynamicContextRequest: dynamicContext.handle,
    onTransportError: event => chat.toast.show(String(event.message || event.code || ""), { tone: "error" }),
    onEvent: event => {
      if (event.type === "plugin_registry_update") skillToolCatalog.handleUpdate(event);
      ui.emit(event);
    }, onUiEvent: extensions.notify,
  });
  port.onMessage(eventRouter.handle);
  appShell = createAppShellFeature({ root, sidePanelApi: globalThis.chrome?.sidePanel, tabs, ui,
    input: chat.elements.inputEl, inputArea: chat.elements.inputArea, newButton: chat.elements.btnNew,
    caseRecordingButton: chat.elements.btnCaseRecording, getCurrentTab, setCurrentTab: options.setCurrentTab,
    transitionToSession, isDebugEnabled: options.isDebugEnabled, setDebugEnabled: options.setDebugEnabled,
    send: port.send, resetUi, runController: chat.runController, goalStrip: chat.goal, toast: chat.toast,
    onStableViewChange: notifyStableViewChange,
  });
  navigation = createSessionNavigationFeature({
    storage: globalThis.chrome?.storage,
    chatTab: tabs.CHAT,
    sessionTitleBar: chat.elements.sessionTitleBar,
    currentSessionTitle: chat.elements.currentSessionTitleEl,
    sessionTitleEditButton: chat.elements.sessionTitleEditButton,
    sessionTitleInput: chat.elements.sessionTitleInput,
    getCurrentSessionId,
    setCurrentSessionIdValue: options.setCurrentSessionIdValue,
    getSessionSwitchEpoch: options.getSessionSwitchEpoch,
    incrementSessionSwitchEpoch: options.incrementSessionSwitchEpoch,
    getCurrentTab,
    switchToChatTab: ({ refresh = true } = { refresh: true }) => switchTab(tabs.CHAT, { refresh }),
    request: port.request,
    send: port.send,
    isDeletedSession: eventRouter.isDeletedSession,
    getRuntime,
    isRuntimeRunning,
    resetUi,
    startPerfTrace: perf.start,
    perfTrace: perf.measure,
    perfTraceAsync: perf.measureAsync,
    chatSearch: chat.search,
    chatScroll: chat.scroll,
    goalStrip: chat.goal,
    sessionExport,
    showToast: chat.toast.show,
    transcriptRenderer: chat.transcript,
    composer: chat.composer,
    runController: chat.runController,
    onUiEvent: extensions.notify,
    onStableViewChange: notifyStableViewChange,
  });

  function captureWorkspaceView(): WorkspaceView {
    const page = getCurrentTab();
    return normalizeWorkspaceView({ v: WORKSPACE_VIEW_VERSION, page, state: ui.capturePage(page) });
  }
  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await mounted;
      extensions.notify({ type: "ui_workspace_started" });
      const revealPending = Boolean(pendingSessionRevealId);
      // Prepare the landing draft before enabling navigation. Once a page is active,
      // its restore signal owns all asynchronous work and yields to a newer navigation.
      if (!revealPending && initialView.page !== tabs.CHAT) await navigation.transitionToSession(null, { reload: true });
      appShell.start({ initialTab: revealPending ? tabs.CHAT : initialView.page });
      if (!revealPending) {
        if (await ui.restorePage(getCurrentTab(), initialView.state) === "failed") {
          switchTab(tabs.CHAT, { refresh: false });
          await ui.restorePage(tabs.CHAT, null);
        }
      }
      while (pendingSessionRevealId) {
        const id = pendingSessionRevealId;
        pendingSessionRevealId = null;
        try { await navigation.switchToSession(id, { source: "notification" }); await navigation.refreshCurrentSessionTitle(); }
        catch (error) { console.warn("[轻舟] reveal notification session failed", error); }
      }
      workspaceStarted = true;
      notifyStableViewChange();
    })();
    return startPromise;
  }
  return {
    start, ready: mounted, connected: () => { skillToolCatalog.refresh(); ui.emit({ type: "workspace_ready" }); }, setReady: () => appShell.setReady(), captureWorkspaceView, ui, extensions, settingsShell,
    sessionExport, eventRouter, appShell, navigation, switchTab, switchToSession,
    setCurrentSessionId: (id: unknown) => navigation.setCurrentSessionId(id), refreshCurrentSessionTitle,
    requestConversationSnapshot: navigation.requestConversationSnapshot,
    dispose: async () => { lifetime.abort(); appShell.stop(); settingsShell.dispose(); await ui.dispose(); },
  };
}
export function runStatusText(status: unknown = "") {
  if (status === "aborted") return t("cancelled");
  if (status === "error") return t("runFailed");
  if (status === "interrupted") return t("runInterrupted");
  if (status === "completed") return t("completed");
  return t("statusUpdated");
}
