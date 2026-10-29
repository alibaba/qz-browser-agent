import { t } from "../../i18n/index.js";
import type { WorkspaceExtensions } from "../app/workspace-extensions.js";
import type { createSessionState, ClientRuntime } from "../sessions/session-state.js";
import type { createSidepanelEventRouter } from "../app/sidepanel-event-router.js";
import type { createSessionNavigationFeature } from "../sessions/session-navigation-feature.js";
import type { createPerfTrace } from "../dev/perf-trace.js";
import type { PortMessage } from "../app/port-client.js";
import type { parseSlashCommandText } from "./slash-menu-feature.js";
import { record } from "../../tools/renderer-input.js";
type RunOptions = Parameters<typeof createChatRunController>[0];
type QueueOptions = NonNullable<Parameters<typeof createQueuedFollowupsFeature>[0]>;
type Navigation = ReturnType<typeof createSessionNavigationFeature>;
interface ChatWorkspaceOptions extends Pick<RunOptions, "isRuntimeRunning" | "syncKeepAlive" | "nowTimestamp" | "formatLiveElapsedMs" | "liveElapsedTickMs" | "isCurrentSessionEvent">,
  Pick<QueueOptions, "normalizePendingFollowUps" | "normalizePendingSteerings"> {
  root?: Document; workspaceRoot?: HTMLElement | null; tabs: { CHAT: string };
  sessionState: ReturnType<typeof createSessionState>; storage?: typeof chrome.storage;
  preferenceStorage?: Storage; activeConversationPrefix?: string;
  transcriptFromConversation: NonNullable<Parameters<typeof createTranscriptReconcileFeature>[0]>["transcriptFromConversation"];
  getCurrentTab?(): string; getCurrentSessionId?(): string | null;
  isCurrentSession(id: unknown): boolean; getRuntime(id: unknown): Partial<ClientRuntime>;
  normalizeGoal?: NonNullable<Parameters<typeof createGoalStripFeature>[0]>["normalizeGoal"];
  getTraceId?(id: string): string; emitTrace?: Parameters<typeof createTranscriptRenderer>[0]["emitTrace"];
  perfTrace?: ReturnType<typeof createPerfTrace>["measure"]; startPerfTrace?: ReturnType<typeof createPerfTrace>["start"];
  runStatusText?(value: unknown): string;
  request(type: string, payload?: PortMessage, timeout?: number | null): Promise<PortMessage>; send(message: PortMessage): unknown;
  createSession: Navigation["createSession"]; requestConversationSnapshot: Navigation["requestConversationSnapshot"];
  extensions: WorkspaceExtensions; hasBlockingOverlay?(): boolean;
  getEventRouter?(): ReturnType<typeof createSidepanelEventRouter> | undefined;
}
import { installImageLightbox } from "../../ui/image-lightbox.js";
import { createToastFeature } from "../../ui/toast-feature.js";
import { createCaseRecordingFeature } from "./case-recording-feature.js";
import { createChatRunController, CHAT_RUN_STATES } from "./chat-run-controller.js";
import { createChatScrollFeature } from "./chat-scroll-feature.js";
import { createChatSearchFeature } from "./chat-search-feature.js";
import { createChatTextSizeFeature } from "./chat-text-size-feature.js";
import { createComposerFeature } from "./composer-feature.js";
import { createElementPickerFeature } from "./element-picker-feature.js";
import { createGoalStripFeature } from "./goal-strip-feature.js";
import { createMarkdownFeature, renderMarkdown } from "./markdown-feature.js";
import { createMathFeature } from "./math-feature.js";
import { createQueuedFollowupsFeature } from "./queued-followups-feature.js";
import { createSlashMenuFeature } from "./slash-menu-feature.js";
import { createTranscriptProjection } from "./transcript/projection.js";
import { createTranscriptReconcileFeature } from "./transcript/recovery.js";
import { createTranscriptRenderer } from "./transcript/renderer.js";

export function createChatWorkspaceFeature(options: ChatWorkspaceOptions) {
  const root = options.root || document;
  const extensions = options.extensions;
  const notify = extensions.notify;
  const select = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Chat shell element missing: ${selector}`);
    return element;
  };
  const messagesEl = select("#messages");
  const welcomeHTML = messagesEl.innerHTML;
  const inputEl = select<HTMLTextAreaElement>("#input");
  const inputWrapper = select(".input-wrapper");
  const btnPickElement = select<HTMLButtonElement>("#btn-pick-element");
  const btnSend = select<HTMLButtonElement>("#btn-send");
  const queuedFollowupsEl = select("#queued-followups");
  const btnAbort = select("#btn-abort");
  const btnNew = select("#btn-new");
  const btnCaseRecording = select<HTMLButtonElement>("#btn-case-recording");
  const chatDock = select("#chat-dock");
  const statusBar = select("#status-bar");
  const statusText = select("#status-text");
  const contextUsageEl = select("#context-usage");
  const sessionTitleBar = select("#session-title-bar");
  const currentSessionTitleEl = select("#current-session-title");
  const sessionTitleEditButton = select<HTMLButtonElement>("#btn-edit-session-title");
  const sessionTitleInput = select<HTMLInputElement>("#session-title-input");
  const chatTextSizeControl = select("#chat-text-size-control");
  const chatTextSizeTrigger = select<HTMLButtonElement>("#btn-chat-text-size");
  const chatTextSizePopover = select("#chat-text-size-popover");
  const goalStrip = select("#goal-strip");
  const inputArea = select("#input-area");

  const attachmentsEl = root.createElement("div");
  attachmentsEl.className = "input-attachments hidden";
  inputArea.insertBefore(attachmentsEl, select(".input-hint"));
  const slashMenuEl = root.createElement("div");
  slashMenuEl.className = "qz-popover qz-menu input-slash-menu hidden";
  inputArea.insertBefore(slashMenuEl, attachmentsEl);
  installImageLightbox(messagesEl);

  const math = createMathFeature();
  const projection = createTranscriptProjection({
    projectArtifacts: (entries, sessionId) => extensions.projectTranscript(entries, sessionId),
    isQueuedSubmission: (sessionId, clientMessageId) => queue.isSubmitting(sessionId, clientMessageId),
  });
  const toast = createToastFeature({
    root,
    hasBlockingOverlay: () => options.hasBlockingOverlay?.() === true,
  });
  const goal = createGoalStripFeature({
    strip: goalStrip,
    inputArea,
    getCurrentSessionId: options.getCurrentSessionId,
    getRuntime: options.getRuntime,
    mergeRuntime: (sessionId, runtime) => options.sessionState.mergeRuntime(sessionId, runtime),
    normalizeGoal: options.normalizeGoal,
    isCurrentSession: options.isCurrentSession,
    isChatActive: isChatActive,
    request: options.request,
    applyRuntimeEvent: (...args) => options.getEventRouter?.()?.updateRuntime(...args) === true,
    renderSessions: input => notify({ type: "ui_sessions_refresh", ...input, immediate: true }),
    scheduleSessionsRefresh: input => notify({ type: "ui_sessions_refresh", ...input }),
    showToast: toast.show,
    nowTimestamp: options.nowTimestamp,
  });
  const caseRecording = createCaseRecordingFeature({
    button: btnCaseRecording,
    showToast: toast.show,
  });

  let search: ReturnType<typeof createChatSearchFeature>;
  const scroll = createChatScrollFeature({
    messagesEl,
    chatDock,
    isActive: isChatActive,
    findTranscriptElement: key => search?.elementByKey(key) || null,
  });
  const textSize = createChatTextSizeFeature({
    root,
    messagesEl,
    control: chatTextSizeControl,
    trigger: chatTextSizeTrigger,
    popover: chatTextSizePopover,
    decrease: select('[data-chat-text-size-action="decrease"]'),
    increase: select('[data-chat-text-size-action="increase"]'),
    reset: select("#chat-text-size-reset"),
    storage: options.preferenceStorage || globalThis.localStorage,
    scroll,
  });
  const markdown = createMarkdownFeature({
    scrollToTarget: target => scroll.scrollToTarget(target, { block: "nearest" }),
  });
  const queue = createQueuedFollowupsFeature({
    container: queuedFollowupsEl,
    getSessionId: options.getCurrentSessionId,
    isVisible: isChatActive,
    getRuntime: options.getRuntime,
    mergeRuntime: (sessionId, runtime) => options.sessionState.mergeRuntime(sessionId, runtime),
    normalizePendingFollowUps: options.normalizePendingFollowUps,
    normalizePendingSteerings: options.normalizePendingSteerings,
    settleAfterDockLayout: scroll.settleAfterDockLayout,
    send: options.send,
    request: options.request,
    showToast: toast.show,
    restoreQueuedMessage: (sessionId, messageId, kind) => composer.restoreQueuedMessage(sessionId, messageId, kind),
    now: options.nowTimestamp,
  });
  let composer: ReturnType<typeof createComposerFeature>;
  let transcript: ReturnType<typeof createTranscriptRenderer>;
  let runController: ReturnType<typeof createChatRunController>;
  let reconcile: ReturnType<typeof createTranscriptReconcileFeature<Partial<ClientRuntime>>>;
  async function executeSlashCommand(command: NonNullable<ReturnType<typeof parseSlashCommandText>>) {
    if (command.name !== "compact_context") return { ok: false };
    const sessionId = String(options.getCurrentSessionId?.() || "").trim();
    const toastKey = sessionId ? `compact-context:${sessionId}` : "compact-context";
    if (!sessionId) {
      toast.show(t("noChatToCompact"), { tone: "error", key: toastKey });
      return { ok: false };
    }
    scroll.lockForSubmittedAction();
    try {
      const result = await options.request("compact_context", {
        sessionId,
        instruction: command.argumentText || "",
      }, null);
      if (String(options.getCurrentSessionId?.() || "").trim() !== sessionId) {
        return { ok: true, result };
      }
      reconcileCompactUi(sessionId);
      if (result?.compacted !== true) {
        toast.show(
          result?.reason === "no_compactable_segment"
            ? t("notEnoughToCompact")
            : t("cannotCompact"),
          { tone: "error", key: toastKey },
        );
      }
      return { ok: true, result };
    } catch (error) {
      if (String(options.getCurrentSessionId?.() || "").trim() !== sessionId) {
        return { ok: false, error };
      }
      reconcileCompactUi(sessionId);
      toast.show(String(record(error).message || t("compactFailedRetry")), {
        tone: "error",
        key: toastKey,
      });
      return { ok: false, error };
    }
  }

  function reconcileCompactUi(sessionId: string) {
    notify({ type: "ui_session_terminal", sessionId });
    options.requestConversationSnapshot?.(sessionId, { persist: false });
  }
  const slashMenu = createSlashMenuFeature({
    input: inputEl,
    menu: slashMenuEl,
    references: extensions,
    onInputChanged: () => composer?.syncInputState(),
    onCommand: executeSlashCommand,
  });
  const elementPicker = createElementPickerFeature({
    button: btnPickElement,
    input: inputEl,
    request: options.request,
    closeSlashMenu: slashMenu.close,
    showToast: toast.show,
    isComposing: () => composer?.isComposing() === true,
  });
  composer = createComposerFeature({
    input: inputEl,
    sendButton: btnSend,
    attachments: attachmentsEl,
    slashMenu,
    elementPicker,
    getSessionId: options.getCurrentSessionId,
    ensureSession: options.createSession,
    request: options.request,
    emitTrace: options.emitTrace,
    dropTarget: root,
    dropIndicator: inputWrapper,
    isDropEnabled: isChatActive,
    setSuppressRunEvents: value => runController?.setSuppressEvents(value),
    showError: message => transcript?.appendError(message),
    markOnboardingActivated: () => notify({ type: "ui_chat_submitted" }),
    hideWelcome: () => runController?.hideWelcome(),
    hideAssistantMessageActions: () => transcript?.hideAssistantActions(),
    appendUserMessage: (...args) => transcript?.appendUserMessage(...args),
    stageQueuedSubmission: (sessionId, message) => {
      const running = options.isRuntimeRunning?.(options.getRuntime(sessionId)) === true
        || (runController?.getActiveSessionId() === sessionId && runController.getStatus() !== CHAT_RUN_STATES.IDLE);
      if (running) queue.stageSubmission(sessionId, message);
    },
    settleQueuedSubmission: (sessionId, clientMessageId) => queue.settleSubmission(sessionId, clientMessageId),
    removePendingUserMessage: (...args) => transcript?.removePendingUserMessage(...args),
    setUserMessageDeliveryStatus: (...args) => transcript?.setUserMessageDeliveryStatus(...args),
    lockForUserMessage: scroll.lockForSubmittedAction,
    preserveViewportDuringDockLayout: scroll.preserveViewportDuringDockLayout,
    sendMessage: options.send,
    stopCurrentRun: () => runController?.stop() === true,
  });
  transcript = createTranscriptRenderer({
    messagesEl,
    workspaceRoot: options.workspaceRoot,
    welcomeHTML,
    contextUsageEl,
    sessionState: options.sessionState,
    projection,
    scroll,
    composer,
    math,
    getSessionId: options.getCurrentSessionId,
    isCurrentSession: options.isCurrentSession,
    isChatActive,
    getRunStatus: () => runController?.getStatus() || CHAT_RUN_STATES.IDLE,
    getActiveRunSessionId: () => runController?.getActiveSessionId() || null,
    getRuntime: options.getRuntime,
    isRuntimeRunning: options.isRuntimeRunning,
    getTraceId: options.getTraceId,
    emitTrace: options.emitTrace,
    perfTrace: options.perfTrace,
    startPerfTrace: options.startPerfTrace,
    syncSearchAfterRender: sessionId => search?.syncAfterRender(sessionId),
    hideWelcome: () => runController?.hideWelcome(),
    showWelcome: () => runController?.showWelcome(),
    showStatus: text => runController?.showStatus(text),
    applyBranding: () => notify({ type: "ui_chat_branding" }),
    renderDock: () => runController?.renderDock(),
    renderGoal: goal.renderCurrent,
    send: options.send,
    request: options.request,
    nowTimestamp: options.nowTimestamp,
    formatTokenCount: value => runController?.formatTokenCount(value) || "0",
    runStatusText: options.runStatusText,
    getSessionTitle: () => currentSessionTitleEl?.textContent || "",
    extensions,

  });
  search = createChatSearchFeature({
    root,
    messagesEl,
    inputEl,
    isActive: isChatActive,
    getSessionId: options.getCurrentSessionId,
    isCurrentSession: options.isCurrentSession,
    getTranscript: transcript.getCurrentTranscript,
    assignTranscriptUiKeys: projection.assignKeys,
    projectTranscript: (history, input) => projection.uiHistory(history, input),
    clearPartialTranscriptRender: transcript.clearPartial,
    renderTranscript: transcript.render,
    compactNodeTitle: transcript.compactNodeTitle,
    compactNodeMeta: transcript.compactNodeMeta,
    compactNodeSummary: transcript.compactNodeSummary,
    runStatusText: options.runStatusText,
    previewExtension: extensions.previewTranscript,
    scrollToMatch: scroll.scrollToMatch,
  });

  runController = createChatRunController({
    messagesEl,
    statusBar,
    statusText,
    contextUsageEl,
    chatDock,
    abortButton: btnAbort,
    transcript,
    onUiEvent: notify,
    scroll,
    queue,
    getSessionId: options.getCurrentSessionId,
    isCurrentSession: options.isCurrentSession,
    isCurrentSessionEvent: event => options.getEventRouter?.()?.isCurrentSessionEvent(event) ?? options.isCurrentSessionEvent?.(event) === true,
    isChatActive,
    getRuntime: options.getRuntime,
    isRuntimeRunning: options.isRuntimeRunning,
    trackBackgroundRun: event => options.getEventRouter?.()?.trackBackgroundRun(event) !== false,
    scheduleTranscriptReconcile: (...args) => reconcile?.schedule(...args),
    onTerminal: sessionId => notify({ type: "ui_session_terminal", sessionId }),
    send: options.send,
    request: options.request,
    syncKeepAlive: options.syncKeepAlive,
    nowTimestamp: options.nowTimestamp,
    formatLiveElapsedMs: options.formatLiveElapsedMs,
    liveElapsedTickMs: options.liveElapsedTickMs,
  });
  reconcile = createTranscriptReconcileFeature({
    storage: options.storage,
    activeConversationPrefix: options.activeConversationPrefix,
    getCurrentSessionId: options.getCurrentSessionId,
    isChatActive,
    isDeletedSession: sessionId => options.getEventRouter?.()?.isDeletedSession(sessionId) === true,
    getRuntime: options.getRuntime,
    isRuntimeRunning: options.isRuntimeRunning,
    isUserScrolling: scroll.isUserScrolling,
    userScrollIdleMs: scroll.userScrollIdleMs,
    getTranscriptCount: sessionId => transcript.getTranscript(sessionId).length,
    getCurrentTranscriptCount: () => transcript.getCurrentTranscript().length,
    getTranscriptLastChangedAt: transcript.lastChangedAt,
    transcriptFromConversation: options.transcriptFromConversation,
    seedTranscript: transcript.seedFromStorage,
    renderUpdatedTranscript: transcript.maybeRenderUpdated,
    scheduleSessionsRefresh: () => notify({ type: "ui_sessions_refresh" }),
    requestSnapshot: options.requestConversationSnapshot,
  });

  messagesEl.addEventListener("click", transcript.handleUserMessageActionClick);
  messagesEl.addEventListener("input", transcript.handleUserMessageEditInput);
  messagesEl.addEventListener("keydown", transcript.handleUserMessageEditKeydown);
  root.addEventListener("click", transcript.handleCodeBlockCopyClick);

  function isChatActive() {
    return options.getCurrentTab?.() === options.tabs.CHAT;
  }

  return {
    elements: {
      messagesEl,
      welcomeHTML,
      inputEl,
      btnPickElement,
      btnNew,
      btnCaseRecording,
      chatDock,
      sessionTitleBar,
      currentSessionTitleEl,
      sessionTitleEditButton,
      sessionTitleInput,
      chatTextSizeControl,
      chatTextSizeTrigger,
      chatTextSizePopover,
      inputArea,
    },
    markdown,
    renderMarkdown,
    math,
    projection,
    toast,
    goal,
    caseRecording,
    scroll,
    textSize,
    queue,
    slashMenu,
    elementPicker,
    composer,
    transcript,
    search,
    runController,
    reconcile,
    start: reconcile.start,
    stop: reconcile.stop,
  };
}
