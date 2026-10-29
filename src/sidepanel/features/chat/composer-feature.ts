import { normalizeImage } from "../../../shared/images/normalize.js";
import { decodeImageInDom } from "../../../dom/image-decoder.js";
import { t, tHtml } from "../../i18n/index.js";
import { readFileAsDataUrl, formatFileSize, escapeHtml } from "../../ui/ui-utils.js";
import { optionalSessionId as normalizeSessionId } from "../sessions/session-id.js";
import type { ComposerDraft } from "../../../shared/contracts/composer-draft.js";
import type { TranscriptEntry, TranscriptImage } from "../../../shared/contracts/session.js";
import { normalizeMessageDocument, type MessageDocument } from "../../../shared/documents/document-attachments.js";
import type { DocumentFile } from "../../../shared/documents/document-store.js";
import type { createSlashMenuFeature, parseSlashCommandText } from "./slash-menu-feature.js";
import type { createElementPickerFeature } from "./element-picker-feature.js";
import type { OutgoingBatch } from "./queued-followups-feature.js";
import type { PortMessage } from "../app/port-client.js";
import { record } from "../../tools/renderer-input.js";
interface DraftImage extends TranscriptImage { attachmentId: string; resumeStarted?: boolean; error?: string }
interface DraftDocument extends Omit<MessageDocument, "sessionId" | "format"> {
  sessionId: string | null; format?: string; status: string; error: string;
  document: MessageDocument | null; base64: string; resumeStarted?: boolean;
}
export interface ComposerDraftState extends ComposerDraft<DraftImage, DraftDocument> {
  pendingFiles: number; submitting: boolean; sessionTask: Promise<unknown> | null;
}
interface OutgoingEntry { expiresAt: number; outgoingBatch: OutgoingBatch | null }
interface FileDropTarget {
  addEventListener(type: "dragenter" | "dragover" | "dragleave" | "drop", listener: (event: DragEvent) => void): void;
}
interface ComposerOptions {
  input: HTMLTextAreaElement; sendButton: HTMLButtonElement; attachments: HTMLElement;
  slashMenu: ReturnType<typeof createSlashMenuFeature>;
  elementPicker: Pick<ReturnType<typeof createElementPickerFeature>, "isActive" | "cancel">;
  getSessionId?(): string | null; ensureSession?(title: string, draft: ComposerDraftState): Promise<unknown>;
  request?(type: string, payload: PortMessage, timeout?: number | null): Promise<PortMessage>;
  emitTrace?(phase: string, payload: PortMessage, fields: PortMessage): void;
  dropTarget?: FileDropTarget; dropIndicator?: Element | null; isDropEnabled?(): boolean;
  setSuppressRunEvents?(suppressed: boolean): void; showError?(message: string): void;
  markOnboardingActivated?(): void; hideWelcome?(): void; hideAssistantMessageActions?(): void;
  appendUserMessage?(text: string, images: TranscriptImage[], id: string, documents: MessageDocument[]): void;
  stageQueuedSubmission?(sessionId: string, message: { clientMessageId: string; text: string; imageCount: number; attachmentCount: number }): void;
  settleQueuedSubmission?(sessionId: string | null, clientMessageId: string): void;
  removePendingUserMessage?(sessionId: string | null, messageId: string): boolean;
  setUserMessageDeliveryStatus?(sessionId: string | null, messageId: string, status: string, options?: { moveToTail: boolean }): boolean;
  lockForUserMessage?(): void; preserveViewportDuringDockLayout?(update: () => void): void;
  sendMessage?(message: PortMessage): unknown; stopCurrentRun?(): boolean;
  lifecycleDocument?: Document; lifecycleWindow?: Window;
}

import { replaceLoneSurrogates } from "../../../shared/unicode-utils.js";
import { getDocumentFile, getDocumentModel } from "../../../shared/documents/document-store.js";

const SEND_DEPARTURE_FALLBACK_MS = 840;
const OUTGOING_USER_MESSAGE_ENTRY_WINDOW_MS = 600;
const OUTGOING_USER_MESSAGE_ENTRY_FALLBACK_MS = 520;
const DOCUMENT_PARSE_TIMEOUT_MS = 120_000;
const DRAFT_SAVE_DEBOUNCE_MS = 240;

export function createComposerFeature(options: ComposerOptions) {
  const input = options.input;
  const sendButton = options.sendButton;
  const attachments = options.attachments;
  const slashMenu = options.slashMenu;
  const elementPicker = options.elementPicker;
  const getSessionId = options.getSessionId || (() => null);
  const ensureSession = options.ensureSession || (async () => {});
  const request: NonNullable<ComposerOptions["request"]> = options.request || (async () => ({}));
  const emitTrace = options.emitTrace || (() => {});
  const dropTarget: FileDropTarget = options.dropTarget || globalThis.document;
  const dropIndicator = options.dropIndicator || null;
  const isDropEnabled = options.isDropEnabled || (() => true);
  const setSuppressRunEvents = options.setSuppressRunEvents || (() => {});
  const showError = options.showError || (() => {});
  const markOnboardingActivated = options.markOnboardingActivated || (() => {});
  const hideWelcome = options.hideWelcome || (() => {});
  const hideAssistantMessageActions = options.hideAssistantMessageActions || (() => {});
  const appendUserMessage = options.appendUserMessage || (() => {});
  const removePendingUserMessage = options.removePendingUserMessage || (() => false);
  const setUserMessageDeliveryStatus = options.setUserMessageDeliveryStatus || (() => false);
  const lockForUserMessage = options.lockForUserMessage || (() => {});
  const preserveViewportDuringDockLayout = options.preserveViewportDuringDockLayout || (update => update());
  const sendMessage = options.sendMessage || (() => {});
  const stopCurrentRun = options.stopCurrentRun || (() => false);
  const lifecycleDocument = options.lifecycleDocument || globalThis.document;
  const lifecycleWindow = options.lifecycleWindow || globalThis.window;
  if (!input || !sendButton || !attachments || !slashMenu || !elementPicker) {
    throw new Error("composer DOM and feature dependencies are required");
  }

  let isComposingInput = false;
  let compositionLayoutFrame = 0;
  const commandRuns = new Set<string | null>();
  const drafts = new Map<string, ComposerDraftState>();
  const imageTasks = new WeakMap<DraftImage, AbortController>();
  const draftLoads = new Map<string, Promise<ComposerDraftState>>();
  let lastDraftUpdatedAt = 0;
  let activeDraft = createDraftState({
    sessionId: getSessionId(), text: input.value,
  });
  let draftSaveTimer = 0;
  let dragDepth = 0;
  let sendDepartureFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const outgoingUserMessageEntryExpirations = new Map<string, OutgoingEntry>();
  let lastInputWidth = Number(input.getBoundingClientRect?.().width)
    || Number(input.offsetWidth)
    || Number(input.clientWidth)
    || 0;
  const inputResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(([entry]) => {
      const borderBox = entry?.borderBoxSize;
      const legacyInlineSize = borderBox && "inlineSize" in borderBox ? borderBox.inlineSize : undefined;
      const width = Number(
        entry?.borderBoxSize?.[0]?.inlineSize
        ?? legacyInlineSize
        ?? input.getBoundingClientRect?.().width,
      );
      if (!Number.isFinite(width)) return;
      if (width <= 0) {
        lastInputWidth = 0;
        return;
      }
      if (Math.abs(width - lastInputWidth) < 0.5) return;
      lastInputWidth = width;
      if (!isComposingInput && !compositionLayoutFrame) autoResize();
    })
    : null;
  inputResizeObserver?.observe(input, { box: "border-box" });

  function draftIsBusy() {
    return activeDraft.pendingFiles > 0 || activeDraft.submitting
      || activeDraft.images.some(item => !item.dataUrl)
      || activeDraft.documents.some(item => item.status === "parsing");
  }

  function draftHasError() {
    return activeDraft.images.some(item => Boolean(item.error)) || activeDraft.documents.some(item => item.status === "error");
  }

  function updateSendState() {
    const hasContent = Boolean(
      input.value.trim()
      || activeDraft.images.length
      || activeDraft.documents.some(item => item.status === "ready"),
    );
    const commandInFlight = commandRuns.has(normalizeSessionId(getSessionId()));
    sendButton.disabled = !hasContent || draftIsBusy() || draftHasError() || commandInFlight;
    input.readOnly = activeDraft.submitting;
  }

  function finishSendDeparture() {
    if (sendDepartureFallbackTimer) {
      clearTimeout(sendDepartureFallbackTimer);
      sendDepartureFallbackTimer = null;
    }
    sendButton.classList.remove("is-departing");
  }

  function playSendDeparture() {
    if (sendDepartureFallbackTimer) clearTimeout(sendDepartureFallbackTimer);
    sendButton.classList.remove("is-departing");
    void sendButton.offsetWidth;
    sendButton.classList.add("is-departing");
    sendDepartureFallbackTimer = setTimeout(finishSendDeparture, SEND_DEPARTURE_FALLBACK_MS);
  }

  function handleSendDepartureAnimationEnd(event: AnimationEvent) {
    if (event.animationName !== "send-vessel-depart") return;
    finishSendDeparture();
  }

  function outgoingUserMessageEntryKey(sessionId: unknown, clientMessageId: unknown) {
    const id = normalizeSessionId(sessionId);
    const messageId = normalizeClientMessageId(clientMessageId);
    return id && messageId ? `${id}::${messageId}` : "";
  }

  function armOutgoingUserMessageEntry(sessionId: unknown, clientMessageId: unknown, outgoingBatch: unknown = null) {
    const key = outgoingUserMessageEntryKey(sessionId, clientMessageId);
    if (!key) return;
    const expiresAt = Date.now() + OUTGOING_USER_MESSAGE_ENTRY_WINDOW_MS;
    const entry = {
      expiresAt,
      outgoingBatch: normalizeOutgoingBatch(outgoingBatch),
    };
    outgoingUserMessageEntryExpirations.set(key, entry);
    setTimeout(() => {
      if (outgoingUserMessageEntryExpirations.get(key) === entry) {
        outgoingUserMessageEntryExpirations.delete(key);
      }
    }, OUTGOING_USER_MESSAGE_ENTRY_WINDOW_MS);
  }

  function consumeOutgoingUserMessageEntry(sessionId: unknown, clientMessageId: unknown) {
    const key = outgoingUserMessageEntryKey(sessionId, clientMessageId);
    if (!key) return false;
    const entry = outgoingUserMessageEntryExpirations.get(key) || null;
    outgoingUserMessageEntryExpirations.delete(key);
    return entry && entry.expiresAt >= Date.now() ? entry : false;
  }

  function playOutgoingUserMessageEntry(messageEl: HTMLElement, entry: OutgoingEntry | null = null) {
    const content = messageEl?.querySelector?.<HTMLElement>(".msg-content");
    if (!content) return;
    const outgoingBatch = normalizeOutgoingBatch(entry?.outgoingBatch);
    const isSteeringBatch = outgoingBatch && outgoingBatch.size > 1;
    messageEl.classList.add("msg-user-outgoing-enter");
    if (isSteeringBatch) {
      messageEl.classList.add("msg-user-steering-batch-enter");
      messageEl.style.setProperty("--steering-batch-index", String(outgoingBatch.index));
    }
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (event?: AnimationEvent) => {
      if (
        event?.animationName
        && event.animationName !== "user-message-sail-in"
        && event.animationName !== "steering-batch-message-enter"
      ) return;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      content.removeEventListener("animationend", finish);
      messageEl.classList.remove("msg-user-outgoing-enter", "msg-user-steering-batch-enter");
      messageEl.style.removeProperty("--steering-batch-index");
    };
    content.addEventListener("animationend", finish);
    fallbackTimer = setTimeout(finish, OUTGOING_USER_MESSAGE_ENTRY_FALLBACK_MS);
  }

  input.addEventListener("compositionstart", () => {
    isComposingInput = true;
    if (compositionLayoutFrame) cancelAnimationFrame(compositionLayoutFrame);
    compositionLayoutFrame = 0;
  });

  input.addEventListener("compositionend", () => {
    isComposingInput = false;
    captureInputText();
    scheduleDraftSave({ immediate: true });
    if (compositionLayoutFrame) cancelAnimationFrame(compositionLayoutFrame);
    compositionLayoutFrame = requestAnimationFrame(() => {
      compositionLayoutFrame = 0;
      if (isComposingInput) return;
      autoResize();
      updateSendState();
      slashMenu.update();
    });
  });

  input.addEventListener("input", (event: Event & { isComposing?: boolean }) => {
    bindEmptyDraftToCurrentSession();
    captureInputText();
    updateSendState();
    if (isComposingInput || event.isComposing) {
      if (!compositionLayoutFrame) compositionLayoutFrame = requestAnimationFrame(() => {
        compositionLayoutFrame = 0;
        if (isComposingInput) autoResize(true);
      });
      return;
    }
    if (compositionLayoutFrame) return;
    scheduleDraftSave();
    autoResize();
    slashMenu.update();
  });

  input.addEventListener("click", slashMenu.update);
  input.addEventListener("keyup", (event) => {
    if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
    slashMenu.update();
  });

  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });

  input.addEventListener("keydown", (event) => {
    if (event.isComposing || isComposingInput || event.keyCode === 229) return;
    if (slashMenu.handleKeydown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendComposerMessage();
      return;
    }
    if (event.key === "Escape") {
      const slashMenuWasOpen = slashMenu.isOpen();
      slashMenu.close();
      if (slashMenuWasOpen || stopCurrentRun()) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  });

  dropTarget?.addEventListener?.("dragenter", handleDragEnter);
  dropTarget?.addEventListener?.("dragover", handleDragOver);
  dropTarget?.addEventListener?.("dragleave", handleDragLeave);
  dropTarget?.addEventListener?.("drop", handleDrop);
  lifecycleDocument?.addEventListener?.("visibilitychange", () => {
    if (lifecycleDocument.visibilityState === "hidden") persistLifecycleDraft();
  });
  lifecycleWindow?.addEventListener?.("pagehide", persistLifecycleDraft);

  function handleDragEnter(event: DragEvent) {
    if (!isDropEnabled() || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    dropIndicator?.classList?.add("is-file-dragover");
  }

  function handleDragOver(event: DragEvent) {
    if (!isDropEnabled() || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropIndicator?.classList?.remove("is-file-dragover");
  }

  function handleDrop(event: DragEvent) {
    if (!isDropEnabled() || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth = 0;
    dropIndicator?.classList?.remove("is-file-dragover");
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) void addFiles(files);
  }

  async function addFiles(files: File[] = []) {
    const accepted = files.filter(file => file && typeof file === "object");
    if (!accepted.length || activeDraft.submitting) return;
    const draft = activeDraft;
    draft.pendingFiles += accepted.length;
    updateSendState();
    try {
      await ensureDraftSession("", draft);
      for (const file of accepted) {
        if (isImageFile(file)) void addImage(file, draft);
        else void addDocument(file, draft);
      }
    } catch (error) {
      draft.pendingFiles = Math.max(0, draft.pendingFiles - accepted.length);
      if (isActiveDraft(draft)) updateSendState();
      showError(String(record(error).message || t("createSessionFailed")));
    }
  }

  async function addImage(file: File, draft: ComposerDraftState) {
    ensureDraftMessageId(draft);
    const item = {
      attachmentId: createOwnedId("image", draft.sessionId),
      dataUrl: "",
      name: file.name || "pasted-image",
      type: file.type || "application/octet-stream",
      size: Number(file.size) || 0,
    };
    draft.images.push(item);
    touchDraft(draft);
    if (isActiveDraft(draft)) renderAttachments();
    const controller = new AbortController();
    imageTasks.set(item, controller);
    try {
      const image = await normalizeImage(file, { decode: decodeImageInDom, signal: controller.signal });
      if (!isTrackedDraft(draft) || !draft.images.includes(item)) return;
      Object.assign(item, { dataUrl: image.dataUrl, type: image.mimeType, size: image.bytes });
      touchDraft(draft);
    } catch (error) {
      if (draft.images.includes(item)) {
        draft.images = draft.images.filter(candidate => candidate !== item);
        touchDraft(draft);
        if (isActiveDraft(draft)) showError(String(record(error).message || t("readImageFailed")));
      }
    } finally {
      imageTasks.delete(item);
      draft.pendingFiles = Math.max(0, draft.pendingFiles - 1);
      if (isActiveDraft(draft)) {
        renderAttachments();
        updateSendState();
      }
      saveDraft(draft);
    }
  }

  async function addDocument(file: File, draft: ComposerDraftState) {
    const sessionId = draft.sessionId;
    const messageId = ensureDraftMessageId(draft);
    const item: DraftDocument = {
      sessionId,
      messageId,
      attachmentId: createOwnedId("att", sessionId),
      fileId: createOwnedId("file", sessionId),
      docModelId: createOwnedId("model", sessionId),
      filename: file.name || "document",
      mimeType: file.type || "application/octet-stream",
      size: Number(file.size) || 0,
      status: "parsing",
      error: "",
      document: null,
      base64: "",
      resumeStarted: false,
    };
    draft.documents.push(item);
    touchDraft(draft);
    if (isActiveDraft(draft)) {
      renderAttachments();
      updateSendState();
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!isTrackedDraft(draft) || !draft.documents.includes(item)) return;
      item.base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      touchDraft(draft);
      await saveDraft(draft);
      await stageDocument(draft, item);
    } catch (error) {
      if (isTrackedDraft(draft) && draft.documents.includes(item)) {
        item.status = "error";
        item.error = String(record(error).message || t("readFileFailed"));
        touchDraft(draft);
        saveDraft(draft);
      }
    } finally {
      draft.pendingFiles = Math.max(0, draft.pendingFiles - 1);
      if (isActiveDraft(draft)) {
        renderAttachments();
        updateSendState();
      }
    }
  }

  async function stageDocument(draft: ComposerDraftState, item: DraftDocument) {
    if (item.resumeStarted || !item.base64) return;
    item.resumeStarted = true;
    try {
      const response = await request("stage_chat_document", {
        sessionId: item.sessionId,
        messageId: item.messageId,
        attachmentId: item.attachmentId,
        fileId: item.fileId,
        docModelId: item.docModelId,
        filename: item.filename,
        mimeType: item.mimeType,
        size: item.size,
        base64: item.base64,
      }, DOCUMENT_PARSE_TIMEOUT_MS);
      const document = normalizeMessageDocument(response?.document);
      if (!isTrackedDraft(draft)) return;
      if (!draft.documents.includes(item)) {
        void deleteDocument(document || item);
        return;
      }
      if (!sameDocumentOwner(document, item)) {
        void deleteDocument(document || item);
        throw new Error(t("attachmentOwnerFailed"));
      }
      item.document = document;
      item.status = "ready";
      item.error = "";
      item.base64 = "";
    } catch (error) {
      if (!isTrackedDraft(draft) || !draft.documents.includes(item)) return;
      if (["SESSION_DELETED", "SESSION_NOT_FOUND"].includes(String(record(error).code || ""))) {
        forgetDraft(draft);
        return;
      }
      item.status = "error";
      item.error = String(record(error).message || t("parseFailed"));
    } finally {
      if (isTrackedDraft(draft) && draft.documents.includes(item)) {
        touchDraft(draft);
        saveDraft(draft);
      }
      if (isActiveDraft(draft)) {
        renderAttachments();
        updateSendState();
      }
    }
  }

  function removeImage(index: number) {
    if (activeDraft.submitting) return;
    const [item] = activeDraft.images.splice(index, 1);
    if (item) { imageTasks.get(item)?.abort(); touchDraft(activeDraft); }
    renderAttachments();
    updateSendState();
    saveDraft(activeDraft);
  }

  function removeDocument(attachmentId: unknown) {
    if (activeDraft.submitting) return;
    const index = activeDraft.documents.findIndex(item => item.attachmentId === attachmentId);
    if (index < 0) return;
    const [item] = activeDraft.documents.splice(index, 1);
    touchDraft(activeDraft);
    renderAttachments();
    updateSendState();
    saveDraft(activeDraft);
    void deleteDocument(item);
  }

  function deleteDocument(value: Partial<Omit<MessageDocument, "sessionId">> & { sessionId?: string | null } = {}) {
    return request("delete_chat_document", {
      sessionId: value.sessionId,
      messageId: value.messageId,
      attachmentId: value.attachmentId,
      fileId: value.fileId,
      docModelId: value.docModelId,
    }, 15_000).catch(() => null);
  }

  async function ensureDraftSession(title: string, draft = activeDraft) {
    let sessionId = normalizeSessionId(draft.sessionId || getSessionId());
    if (!sessionId && !draft.sessionTask) {
      draft.sessionTask = Promise.resolve(ensureSession(title, draft))
        .finally(() => { draft.sessionTask = null; });
    }
    // The client assigns a provisional Session id before create_ui_session commits it.
    // Treat the in-flight task, rather than the id, as the readiness barrier.
    if (draft.sessionTask) {
      await draft.sessionTask;
      sessionId = normalizeSessionId(draft.sessionId || getSessionId());
    }
    if (!sessionId) throw new Error(t("createSessionFailed"));
    if (!draft.sessionId) await adoptSession(sessionId, draft);
    if (draft.sessionId !== sessionId) throw new Error(t("inputOwnerMismatch"));
    return sessionId;
  }

  function bindEmptyDraftToCurrentSession() {
    if (activeDraft.sessionId || activeDraft.images.length || activeDraft.documents.length) return;
    rekeyDraft(activeDraft, getSessionId());
  }

  function ensureDraftMessageId(draft: ComposerDraftState) {
    if (!draft.messageId) draft.messageId = createClientMessageId(draft.sessionId);
    return draft.messageId;
  }

  function handleSessionChanged(_previousSessionId: unknown, nextSessionId: unknown, preparedDraft: ComposerDraftState | null = null) {
    const next = normalizeSessionId(nextSessionId);
    if (activeDraft.sessionId === next && !preparedDraft) return;
    if (!preparedDraft) {
      captureInputText();
      saveDraft(activeDraft);
    }
    activateDraft(preparedDraft || drafts.get(draftSessionKey(next))
      || createDraftState({ sessionId: next }));
  }

  async function prepareSession(sessionId: unknown) {
    const sourceDraft = activeDraft;
    const flushedRevision = await flushDraftSave(sourceDraft);
    const targetDraft = await loadDraftState(sessionId);
    if (activeDraft === sourceDraft) {
      captureInputText();
      if (sourceDraft.updatedAt !== flushedRevision) void saveDraft(sourceDraft);
    }
    return targetDraft;
  }

  function adoptSession(sessionId: unknown, draft = activeDraft) {
    const next = normalizeSessionId(sessionId);
    if (draft.sessionId === next) return draft;
    const previous = draft.sessionId;
    if (draft === activeDraft) captureInputText();
    rekeyDraft(draft, next, previous);
    for (const item of draft.documents) item.sessionId = next;
    touchDraft(draft);
    return draft;
  }

  function activateDraft(draft: ComposerDraftState) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = 0;
    activeDraft = draft;
    if (draft.updatedAt) drafts.set(draftSessionKey(draft.sessionId), draft);
    input.value = draft.text;
    renderAttachments();
    autoResize();
    updateSendState();
    for (const item of draft.documents) {
      if (item.status === "parsing" && item.base64) void stageDocument(draft, item);
    }
  }

  function forgetSession(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    const forgotten = drafts.get(draftSessionKey(id));
    if (forgotten) forgetDraft(forgotten);
    if (activeDraft.sessionId === id) {
      forgetDraft(activeDraft);
      activateDraft(createDraftState());
    }
  }

  function isActiveDraft(draft: ComposerDraftState) {
    return activeDraft === draft && activeDraft.sessionId === normalizeSessionId(getSessionId());
  }

  function isTrackedDraft(draft: ComposerDraftState) {
    return drafts.get(draftSessionKey(draft.sessionId)) === draft;
  }

  function forgetDraft(draft: ComposerDraftState) {
    drafts.delete(draftSessionKey(draft.sessionId));
    for (const image of draft.images) imageTasks.get(image)?.abort();
    draft.images = [];
    draft.documents = [];
  }

  async function restoreQueuedMessage(sessionId: string, clientMessageId: string, queueKind: string) {
    if (sessionId !== normalizeSessionId(getSessionId()) || draftIsBusy() || isComposingInput) return { busy: true };
    bindEmptyDraftToCurrentSession();
    if (activeDraft.sessionId !== sessionId) return { busy: true };
    captureInputText();
    const draft = activeDraft;
    touchDraft(draft);
    clearTimeout(draftSaveTimer);
    draftSaveTimer = 0;
    draft.submitting = true;
    updateSendState();
    const applyRecoveredDraft = (value: unknown) => {
      if (!value || !isTrackedDraft(draft)) return;
      const restored = createDraftState(value);
      lastDraftUpdatedAt = Math.max(lastDraftUpdatedAt, restored.updatedAt);
      Object.assign(draft, restored, { submitting: true });
      if (isActiveDraft(draft)) {
        slashMenu.close();
        preserveViewportDuringDockLayout(() => activateDraft(draft));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    };
    try {
      const result = await request("restore_queued_message", {
        sessionId, clientMessageId, queueKind, draft: serializeDraft(draft),
      });
      if (result.restored) applyRecoveredDraft(result.draft);
      return result;
    } catch (error) {
      // A disconnected/timed-out response does not mean the durable withdrawal failed.
      // Keep editing paused until an ordered read settles that uncertainty; saving the
      // stale local draft after unlocking could overwrite the recovered attachments.
      const connectionFailure = (value: unknown) => /^(?:PORT_(?:DISCONNECTED|REQUEST_TIMEOUT)|TRANSPORT_(?:DISCONNECTED|TIMEOUT))$/.test(String(record(value).code || ""));
      if (connectionFailure(error) || record(error).code === "COMPOSER_DRAFT_CHANGED") {
        while (isTrackedDraft(draft)) {
          try {
            const saved = await request("get_composer_draft", { sessionId, afterQueuedMutation: true }, null);
            if (Number(record(saved.draft).updatedAt) > draft.updatedAt) applyRecoveredDraft(saved.draft);
            break;
          } catch (readError) {
            if (!connectionFailure(readError)) throw readError;
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }
      }
      throw error;
    } finally {
      draft.submitting = false;
      if (isActiveDraft(draft)) {
        updateSendState();
        scheduleDraftSave();
      }
    }
  }

  async function sendComposerMessage() {
    if (draftIsBusy() || draftHasError()) return;
    if (commandRuns.has(normalizeSessionId(getSessionId()))) return;
    captureInputText();
    const text = replaceLoneSurrogates(input.value.trim());
    const images = activeDraft.images.slice();
    const documents = activeDraft.documents.map(item => item.document).filter((item): item is MessageDocument => Boolean(item));
    if (!text && !images.length && !documents.length) return;
    const command = slashMenu.parseCommand(text);
    if (command) {
      if (images.length || documents.length) {
        showError(t("commandAttachments"));
        return;
      }
      await executeSlashCommand(command, text);
      return;
    }
    if (elementPicker.isActive()) elementPicker.cancel();
    slashMenu.close();

    setSuppressRunEvents(false);
    const sentDraft = activeDraft;
    sentDraft.submitting = true;
    updateSendState();
    let sessionId;
    try {
      sessionId = await ensureDraftSession(text || documents[0]?.filename || "[图片]", sentDraft);
    } catch (error) {
      sentDraft.submitting = false;
      if (isActiveDraft(sentDraft)) updateSendState();
      showError(String(record(error).message || t("createSessionFailed")));
      return;
    }
    const clientMessageId = sentDraft.messageId || createClientMessageId(sessionId);
    sentDraft.messageId = clientMessageId;
    if (!documents.every(document => (
      document.sessionId === sessionId && document.messageId === clientMessageId
    ))) {
      sentDraft.submitting = false;
      if (isActiveDraft(sentDraft)) updateSendState();
      showError(t("attachmentMismatch"));
      return;
    }

    playSendDeparture();
    markOnboardingActivated();
    hideWelcome();
    hideAssistantMessageActions();
    const composerDraft = serializeDraft(sentDraft);
    drafts.delete(draftSessionKey(sentDraft.sessionId));
    sentDraft.submitting = false;
    activateDraft(createDraftState({ sessionId }));
    const imagePayload = images.map(image => ({
      dataUrl: image.dataUrl,
      type: image.type,
      name: image.name,
    }));

    armOutgoingUserMessageEntry(sessionId, clientMessageId);
    options.stageQueuedSubmission?.(sessionId, { clientMessageId, text, imageCount: images.length, attachmentCount: documents.length });
    appendUserMessage(text, images, clientMessageId, documents);
    lockForUserMessage();
    return submitPrompt({
      sessionId,
      text,
      clientMessageId,
      images: imagePayload,
      documents,
      composerDraft,
    });
  }

  async function submitPrompt(payload: PortMessage, { retry = false } = {}) {
    const sessionId = normalizeSessionId(payload?.sessionId);
    const clientMessageId = normalizeClientMessageId(payload?.clientMessageId);
    const startedAt = Date.now();
    traceMessageDelivery("ui.submitted", payload, {
      retry,
      textChars: String(payload?.text || "").length,
      images: Array.isArray(payload?.images) ? payload.images.length : 0,
      documents: Array.isArray(payload?.documents) ? payload.documents.length : 0,
    });
    try {
      const response = await request("prompt", payload, null);
      if (response?.disposition === "queued") {
        // queue_update precedes the acknowledgement; retain the local delivery record until admission completes.
        removePendingUserMessage(sessionId, clientMessageId);
      } else {
        setUserMessageDeliveryStatus(sessionId, clientMessageId, "accepted");
      }
      traceMessageDelivery("ui.accepted", payload, {
        retry,
        request: response?.requestId || "",
        elapsedMs: Date.now() - startedAt,
      });
      return true;
    } catch (error) {
      setUserMessageDeliveryStatus(sessionId, clientMessageId, "failed");
      traceMessageDelivery("ui.failed", payload, {
        retry,
        request: record(record(error).details).requestId || "",
        code: record(error).code || record(error).name || "ERROR",
        error: String(record(error).message || String(error)),
        elapsedMs: Date.now() - startedAt,
      });
      return false;
    } finally {
      options.settleQueuedSubmission?.(sessionId, clientMessageId);
    }
  }

  function traceMessageDelivery(phase: string, payload: PortMessage = {}, fields: PortMessage = {}) {
    const sessionId = normalizeSessionId(payload.sessionId);
    const clientMessageId = normalizeClientMessageId(payload.clientMessageId);
    emitTrace("message_delivery", {
      sessionId,
      streamTraceId: clientMessageId,
    }, {
      phase,
      message: clientMessageId,
      ...fields,
    });
  }

  async function retryUserMessage(entry: Omit<Partial<TranscriptEntry>, "images"> & { images?: (TranscriptImage | string)[] } = {}) {
    const sessionId = normalizeSessionId(getSessionId());
    const clientMessageId = normalizeClientMessageId(entry.clientMessageId);
    if (
      !sessionId
      || !clientMessageId
      || String(entry.deliveryStatus || "").trim() !== "failed"
    ) return Promise.resolve(false);
    const images = (Array.isArray(entry.images) ? entry.images : []).map(image => ({
      dataUrl: typeof image === "string" ? image : image.dataUrl || image.url || image,
      type: typeof image === "string" ? "" : image.type || "",
      name: typeof image === "string" ? "" : image.name || "",
    }));
    try {
      for (const image of images) {
        if (typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:")) continue;
        const normalized = await normalizeImage(image.dataUrl, { decode: decodeImageInDom });
        image.dataUrl = normalized.dataUrl;
        image.type = normalized.mimeType;
      }
    } catch (error) {
      showError(String(record(error).message || t("readImageFailed")));
      return false;
    }
    if (normalizeSessionId(getSessionId()) !== sessionId) return false;
    const documents = Array.isArray(entry.documents) ? entry.documents : [];
    options.stageQueuedSubmission?.(sessionId, { clientMessageId, text: String(entry.text || ""), imageCount: images.length, attachmentCount: documents.length });
    setUserMessageDeliveryStatus(sessionId, clientMessageId, "pending", { moveToTail: true });
    lockForUserMessage();
    return submitPrompt({
      sessionId,
      text: String(entry.text || ""),
      clientMessageId,
      images,
      documents,
      composerDraft: { sessionId, messageId: clientMessageId },
    }, { retry: true });
  }

  async function executeSlashCommand(command: NonNullable<ReturnType<typeof parseSlashCommandText>>, sourceText: string) {
    const sessionId = normalizeSessionId(getSessionId());
    if (commandRuns.has(sessionId)) return;
    if (elementPicker.isActive()) elementPicker.cancel();
    slashMenu.close();
    setSuppressRunEvents(false);
    commandRuns.add(sessionId);
    input.value = "";
    activeDraft.text = "";
    touchDraft(activeDraft);
    saveDraft(activeDraft);
    autoResize();
    updateSendState();
    let result: unknown = null;
    try {
      result = await slashMenu.executeCommand(command);
    } catch (error) {
      showError(String(record(error).message || t("commandFailed")));
      result = { ok: false };
    } finally {
      commandRuns.delete(sessionId);
      if (
        record(result).ok === false
        && normalizeSessionId(getSessionId()) === sessionId
        && !input.value
        && !activeDraft.images.length
        && !activeDraft.documents.length
      ) {
        input.value = sourceText;
        activeDraft.text = sourceText;
        ensureDraftMessageId(activeDraft);
        touchDraft(activeDraft);
        saveDraft(activeDraft);
        autoResize();
      }
      updateSendState();
    }
  }

  function captureInputText() {
    if (activeDraft.text === input.value) return;
    activeDraft.text = input.value;
    if (activeDraft.text) ensureDraftMessageId(activeDraft);
    touchDraft(activeDraft);
  }

  function scheduleDraftSave({ immediate = false } = {}) {
    if (isComposingInput && !immediate) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = 0;
      saveDraft(activeDraft);
    }, immediate ? 0 : DRAFT_SAVE_DEBOUNCE_MS);
  }

  async function flushDraftSave(draft = activeDraft) {
    if (draft === activeDraft && draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = 0;
    }
    if (draft === activeDraft) captureInputText();
    const flushedRevision = draft.updatedAt;
    await saveDraft(draft);
    return flushedRevision;
  }

  function persistLifecycleDraft() {
    captureInputText();
    const draft = activeDraft;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = 0;
    if (draft.sessionId && draft.updatedAt) {
      sendMessage({
        type: "sync_composer_draft",
        sessionId: draft.sessionId,
        draft: serializeDraft(draft),
      });
    } else {
      void saveDraft(draft);
    }
  }

  async function saveDraft(draft: ComposerDraftState) {
    if (!draft.updatedAt) return null;
    if (draft.sessionTask) await draft.sessionTask;
    if (!draft.sessionId) {
      if (draft !== activeDraft) return null;
      if (!draft.text && !draft.images.length && !draft.documents.length) return null;
      await ensureDraftSession("", draft);
    }
    return safeDraftRequest(() => request("sync_composer_draft", {
      sessionId: draft.sessionId,
      draft: serializeDraft(draft),
    }));
  }

  async function loadDraftState(sessionId: unknown) {
    const key = draftSessionKey(sessionId);
    if (drafts.has(key)) return drafts.get(key)!;
    if (draftLoads.has(key)) return draftLoads.get(key)!;
    const loading = (async () => {
      const response = sessionId
        ? await safeDraftRequest(() => request("get_composer_draft", { sessionId }))
        : null;
      const draft = response?.draft
        ? await hydrateStoredDraft(response.draft)
        : createDraftState({ sessionId });
      return draft;
    })();
    draftLoads.set(key, loading);
    try { return await loading; } finally { draftLoads.delete(key); }
  }

  async function resolveStoredDocument(item: DraftDocument) {
    try {
      const [file, model] = await Promise.all([
        getDocumentFile(item.fileId),
        getDocumentModel(item.docModelId),
      ]);
      const ownsItem = (record: Pick<DocumentFile, "sourceTool" | "sessionId" | "messageId" | "attachmentId"> | undefined) => record?.sourceTool === "chat_attachment"
        && record.sessionId === item.sessionId
        && record.messageId === item.messageId
        && record.attachmentId === item.attachmentId;
      if (!file || !model || !ownsItem(file) || !ownsItem(model) || model.fileId !== item.fileId) return null;
      return {
        sessionId: item.sessionId,
        messageId: item.messageId,
        attachmentId: item.attachmentId,
        fileId: item.fileId,
        docModelId: item.docModelId,
        filename: item.filename,
        mimeType: item.mimeType,
        format: model.type || file.extension || "",
        size: item.size,
      };
    } catch (_error) {
      return null;
    }
  }

  async function safeDraftRequest(operation: () => Promise<PortMessage>) {
    try { return await operation(); } catch (error) {
      console.warn("[轻舟] composer draft persistence failed", error);
      return null;
    }
  }

  function rekeyDraft(draft: ComposerDraftState, sessionId: unknown, previousSessionId = draft.sessionId) {
    const previousKey = draftSessionKey(previousSessionId);
    if (drafts.get(previousKey) === draft) drafts.delete(previousKey);
    draft.sessionId = normalizeSessionId(sessionId);
    if (draft.updatedAt) drafts.set(draftSessionKey(draft.sessionId), draft);
  }

  function touchDraft(draft: ComposerDraftState) {
    lastDraftUpdatedAt = Math.max(Date.now(), lastDraftUpdatedAt + 1);
    draft.updatedAt = lastDraftUpdatedAt;
    drafts.set(draftSessionKey(draft.sessionId), draft);
  }

  async function hydrateStoredDraft(value: unknown) {
    lastDraftUpdatedAt = Math.max(lastDraftUpdatedAt, Number(record(value).updatedAt) || 0);
    const draft = createDraftState(value);
    let changed = false;
    if (!draft.messageId && (draft.text || draft.images.length || draft.documents.length)) {
      draft.messageId = createClientMessageId(draft.sessionId);
      changed = true;
    }
    const images = draft.images.filter(image => image?.dataUrl);
    changed ||= images.length !== draft.images.length;
    draft.images = [];
    for (const image of images) {
      try {
        const normalized = await normalizeImage(image.dataUrl!, { decode: decodeImageInDom });
        changed ||= normalized.dataUrl !== image.dataUrl;
        draft.images.push({ ...image, dataUrl: normalized.dataUrl, type: normalized.mimeType, size: normalized.bytes, error: undefined });
      } catch (error) {
        // Keep stored attachments recoverable. Only explicit removal may discard their bytes.
        const message = String(record(error).message || t("readImageFailed"));
        draft.images.push({ ...image, error: message });
        showError(message);
      }
    }
    const documents = draft.documents;
    draft.documents = [];
    for (const document of documents) {
      const item = {
        ...document,
        sessionId: draft.sessionId,
        messageId: draft.messageId,
        base64: String(document.base64 || ""),
        resumeStarted: false,
      };
      const ready = await resolveStoredDocument(item);
      if (ready) {
        changed ||= item.status !== "ready";
        Object.assign(item, { document: ready, status: "ready", error: "", base64: "" });
      } else if (item.status === "parsing" && !item.base64) {
        Object.assign(item, { status: "error", error: t("originalFileUnavailable") });
        changed = true;
      } else if (item.status === "ready") {
        Object.assign(item, { status: "error", error: t("parsedFileUnavailable") });
        changed = true;
      }
      draft.documents.push(item);
    }
    if (changed) {
      touchDraft(draft);
      saveDraft(draft);
    } else {
      drafts.set(draftSessionKey(draft.sessionId), draft);
    }
    return draft;
  }

  function autoResize(growOnly = false) {
    // Preedit can wrap before commit. Grow without collapsing the live textarea:
    // a frozen one-line box scrolls its earlier text out of view to follow the IME caret.
    if (growOnly && input.scrollHeight <= input.clientHeight) return;
    preserveViewportDuringDockLayout(() => {
      if (!growOnly) {
        input.style.overflowY = "hidden";
        input.style.height = "auto";
      }
      const contentHeight = input.scrollHeight;
      input.style.height = Math.min(contentHeight, 120) + "px";
      input.style.overflowY = contentHeight > 120 ? "auto" : "hidden";
      if (input.scrollHeight <= input.clientHeight) input.scrollTop = 0;
    });
  }

  function renderAttachments() {
    if (!activeDraft.images.length && !activeDraft.documents.length) {
      attachments.classList.add("hidden");
      attachments.innerHTML = "";
      return;
    }
    attachments.classList.remove("hidden");
    attachments.innerHTML = [
      ...activeDraft.images.flatMap((image, index) => (
        image.dataUrl ? [renderImageAttachment(image, index)] : []
      )),
      ...activeDraft.documents.map(renderDocumentAttachment),
    ].join("");
    attachments.querySelectorAll<HTMLElement>("[data-remove-image]").forEach(button => {
      button.addEventListener("click", () => removeImage(Number(button.dataset.removeImage)));
    });
    attachments.querySelectorAll<HTMLElement>("[data-remove-document]").forEach(button => {
      button.addEventListener("click", () => removeDocument(button.dataset.removeDocument));
    });
  }

  sendButton.addEventListener("click", sendComposerMessage);
  sendButton.addEventListener("animationend", handleSendDepartureAnimationEnd);

  function syncInputState() {
    bindEmptyDraftToCurrentSession();
    captureInputText();
    scheduleDraftSave();
    autoResize();
    updateSendState();
  }

  function setValue(value: unknown, { focus = false } = {}) {
    bindEmptyDraftToCurrentSession();
    input.value = String(value || "");
    syncInputState();
    if (focus) input.focus();
  }

  return {
    send: sendComposerMessage,
    restoreQueuedMessage,
    retryUserMessage,
    syncInputState,
    setValue,
    focus: () => input.focus(),
    isComposing: () => isComposingInput,
    handleSessionChanged,
    prepareSession,
    adoptSession,
    snapshotDraft: serializeDraft,
    forgetSession,
    flushDraft: flushDraftSave,
    armOutgoingEntry: armOutgoingUserMessageEntry,
    consumeOutgoingEntry: consumeOutgoingUserMessageEntry,
    playOutgoingEntry: playOutgoingUserMessageEntry,
  };
}

function renderImageAttachment(image: DraftImage, index: number) {
  return `
    <div class="input-attachment input-image-attachment qz:relative qz:size-(--input-attachment-size) qz:overflow-hidden">
      ${image.error
        ? `<span class="qz:block" role="img" title="${escapeHtml(image.error)}" aria-label="${escapeHtml(image.error)}">!</span>`
        : `<img class="qz:block qz:size-full qz:object-cover" src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}">`}
      <button class="qz-icon-btn qz-icon-btn--xs" type="button" data-remove-image="${index}" title="${tHtml("remove")}" aria-label="${tHtml("removeImage")}">
        ${closeIcon()}
      </button>
    </div>
  `;
}

function renderDocumentAttachment(item: DraftDocument) {
  const statusText = item.status === "ready"
    ? t("parsedFilename", { filename: formatFileSize(item.size) })
    : item.status === "error"
      ? t("parseFailed")
      : t("parsing");
  const title = item.error ? `${item.filename}：${item.error}` : item.filename;
  return `
    <div class="input-document-attachment document-attachment-card is-${escapeHtml(item.status)} qz:box-border qz:flex qz:h-13 qz:min-w-0 qz:items-stretch qz:overflow-hidden" title="${escapeHtml(title)}">
      <span class="document-attachment-type qz:grid qz:flex-[0_0_44px] qz:place-items-center" aria-hidden="true">${escapeHtml(fileTypeLabel(item.filename))}</span>
      <span class="document-attachment-body qz:flex qz:min-w-0 qz:flex-auto qz:flex-col qz:justify-center qz:px-2 qz:py-0">
        <span class="document-attachment-name qz:block qz:min-w-0 qz:truncate">${escapeHtml(item.filename)}</span>
        <span class="document-attachment-meta qz:block qz:min-w-0 qz:truncate">${escapeHtml(statusText)}</span>
      </span>
      <button class="qz-icon-btn qz-icon-btn--xs document-attachment-remove qz:mr-0.75 qz:flex-none qz:self-center" type="button" data-remove-document="${escapeHtml(item.attachmentId)}" title="${tHtml("remove")}" aria-label="${tHtml("removeFile")}">
        ${closeIcon()}
      </button>
    </div>
  `;
}

function closeIcon() {
  return '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
}

function hasDraggedFiles(dataTransfer: DataTransfer | null) {
  return [...(dataTransfer?.types || [])].includes("Files");
}

function isImageFile(file: File) {
  return String(file?.type || "").toLowerCase().startsWith("image/");
}


function sameDocumentOwner(document: MessageDocument | null, item: DraftDocument): document is MessageDocument {
  return Boolean(
    document
    && document.sessionId === item.sessionId
    && document.messageId === item.messageId
    && document.attachmentId === item.attachmentId
    && document.fileId === item.fileId
    && document.docModelId === item.docModelId
  );
}

function fileTypeLabel(filename: unknown) {
  const name = String(filename || "");
  const extension = name.includes(".") ? name.split(".").pop() : "FILE";
  return String(extension || "FILE").toUpperCase().slice(0, 5);
}


function createOwnedId(prefix: string, sessionId: string | null = "") {
  const sid = (normalizeSessionId(sessionId) || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "session";
  return `${prefix}_${sid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createClientMessageId(sessionId: string | null = "") {
  const sid = (normalizeSessionId(sessionId) || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "session";
  return `cm_${sid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDraftState(input: unknown = {}): ComposerDraftState {
  const value = record(input);
  return {
    sessionId: normalizeSessionId(value.sessionId),
    messageId: normalizeClientMessageId(value.messageId),
    text: String(value.text || ""),
    images: Array.isArray(value.images) ? value.images.map(normalizeDraftImage) : [],
    documents: Array.isArray(value.documents) ? value.documents.map(normalizeDraftDocument) : [],
    updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    pendingFiles: 0,
    submitting: false,
    sessionTask: null,
  };
}

function serializeDraft(draft: Partial<ComposerDraftState> = {}) {
  return {
    sessionId: normalizeSessionId(draft.sessionId),
    messageId: normalizeClientMessageId(draft.messageId),
    text: String(draft.text || ""),
    images: (draft.images || []).map(({ resumeStarted: _resumeStarted, error: _error, ...item }) => item),
    documents: (draft.documents || []).map(({ resumeStarted: _resumeStarted, ...item }) => item),
    updatedAt: Math.max(0, Number(draft.updatedAt) || 0),
  };
}

const draftSessionKey = (sessionId: unknown) => normalizeSessionId(sessionId) || "new";

function normalizeOutgoingBatch(input: unknown) {
  const value = record(input);
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim().slice(0, 160);
  const size = Math.max(0, Math.floor(Number(value.size) || 0));
  const index = Math.max(0, Math.min(size - 1, Math.floor(Number(value.index) || 0)));
  return id && size > 1 ? { id, index, size } : null;
}


function normalizeClientMessageId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

function normalizeDraftImage(value: unknown): DraftImage {
  const item = record(value);
  return { ...item, attachmentId: String(item.attachmentId || ""), dataUrl: String(item.dataUrl || ""),
    name: String(item.name || ""), type: String(item.type || ""), size: Math.max(0, Number(item.size) || 0) };
}

function normalizeDraftDocument(value: unknown): DraftDocument {
  const item = record(value);
  return { ...item, sessionId: normalizeSessionId(item.sessionId), messageId: normalizeClientMessageId(item.messageId),
    attachmentId: String(item.attachmentId || ""), fileId: String(item.fileId || ""), docModelId: String(item.docModelId || ""),
    filename: String(item.filename || "document"), mimeType: String(item.mimeType || "application/octet-stream"),
    size: Math.max(0, Number(item.size) || 0), status: String(item.status || "parsing"), error: String(item.error || ""),
    base64: String(item.base64 || ""), document: normalizeMessageDocument(item.document) };
}
