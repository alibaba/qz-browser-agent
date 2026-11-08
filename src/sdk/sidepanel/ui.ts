import type { TranscriptEntry } from "./renderers.js";
import type { SessionRuntime } from "../../shared/contracts/session-runtime.js";
import type { TranscriptAgentEvent, TranscriptEntry as StoredTranscriptEntry } from "../../shared/contracts/session.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import type { CapabilityStateStore } from "../../shared/capability-state-store.js";
export type { CapabilityStateStore, CapabilityStorageOptions } from "../../shared/capability-state-store.js";
export type { ReadonlyJsonValue as JsonValue } from "../../shared/contracts/json.js";
import type { SettingsProduct, SettingsProductHost } from "./settings.js";

export type UiEvent = Readonly<Record<string, unknown>>;
export interface UiSessionEvent extends Omit<TranscriptAgentEvent, "runtime">, UiEvent {
  type: string; sessionId?: string; session?: Partial<SessionMetadata>; runtime?: UiEvent;
  transcript?: StoredTranscriptEntry[]; isStreaming?: boolean;
}
export interface UiSessionRuntime extends Pick<SessionRuntime, "status" | "running" | "pendingStart" | "runId" | "waitForm" | "contextUsage">, UiEvent {}
export interface UiSessionPort {
  getRuntime(id: unknown): UiSessionRuntime;
  getRecord(id: unknown): SessionMetadata | null;
  mergeRecord(record: unknown): unknown;
  mergeRecords(records: unknown): unknown;
  mergeRuntime(id: unknown, runtime: unknown, options?: { resetCausality?: boolean }): unknown;
  updateRuntime(id: string, event: UiSessionEvent): boolean;
  isDeleted(id: string): boolean;
  getTranscript(id: string): TranscriptEntry[];
  hasTranscript(id: string): boolean;
  open(id: string, options?: { source?: string; signal?: AbortSignal }): Promise<unknown>;
  export(id: unknown): Promise<boolean>;
  isExporting(id: unknown): boolean;
}
export interface UiToastOptions {
  tone?: string; durationMs?: number | null; anchorEl?: Element | null; key?: string; toggle?: boolean;
  variant?: string; title?: string; actionLabel?: string; onAction?: (() => unknown) | null; dismissible?: boolean | null;
}
export interface UiReferenceItem {
  kind: string; name: string; label: string; title: string; subtitle: string; meta: string;
  priority: number; search: string; token?: string;
}
export interface UiReferenceSource {
  id: string; label: string; className?: string; order?: number;
  menuLabel?: string; filterLabel?: string; emptyText?: string;
  list(signal: AbortSignal): Promise<readonly UiReferenceItem[]>;
}
export interface UiTranscriptContribution {
  id: string;
  project?(entries: TranscriptEntry[], sessionId: string): TranscriptEntry[];
  create?(entry: TranscriptEntry): HTMLElement | null;
  patch?(element: HTMLElement, entry: TranscriptEntry): boolean;
  retire?(element: HTMLElement): void;
  preview?(entry: TranscriptEntry): string;
}
export interface UiCommand {
  id: string;
  run(payload: unknown): unknown;
}
export interface WorkspaceContribution {
  commands?: readonly UiCommand[];
  references?: readonly UiReferenceSource[];
  transcript?: readonly UiTranscriptContribution[];
}

export interface UiWorkspacePort {
  register(contribution: WorkspaceContribution, signal?: AbortSignal): () => void;
  notify(event: UiEvent): void;
  hasCommand(id: string): boolean;
  invoke(id: string, payload?: unknown): unknown;
}

export interface UiChatPort {
  readonly messages: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly welcomeHTML: string;
  setInput(value: unknown, options?: { focus?: boolean }): void;
  showWelcome(): void;
  focus(source?: "request" | "preset_closed"): void;
  refresh(id: string): void;
  scheduleRender(id: string, options: { delay: number }): void;
  appendNote(text: string): void;
  clearInlineActions(element: HTMLElement): void;
  flashAction(element: HTMLElement, text: string): void;
  refreshReferences(): void;
  isGoalClearPending(id: string): boolean;
  renderGoal(): void;
  syncExternalDriveChrome?(): void;
}

export interface UiActivation {
  readonly signal: AbortSignal;
  readonly refresh: boolean;
}
/** Pages own their local state; the shell only orders, navigates and restores them. */
export interface UiPage {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly elements: readonly (HTMLElement | null)[];
  readonly button?: HTMLElement | null;
  isEnabled?(): boolean;
  activate?(context: UiActivation): unknown;
  deactivate?(): unknown;
  capture?(): unknown;
  restore?(state: unknown, context: UiActivation): unknown;
}
export interface UiOverlay {
  readonly id: string;
  readonly priority?: number;
  close(): boolean;
  blocksFocus(): boolean;
}
export interface UiSettingsSection {
  readonly id: string;
  readonly title: string;
  /** Orders the independent forms within a shared tab, or the standalone tab when omitted. */
  readonly order?: number;
  /** Matching tab ids share navigation and Save; every section retains its own lifecycle and state. */
  readonly tab?: { readonly id: string; readonly title: string; readonly order?: number };
  readonly element: HTMLElement;
  visible?(): boolean;
  activate?(context: UiActivation): unknown;
  deactivate?(): unknown;
  save?(context: UiActivation): unknown;
  /** Runs for every tab member after a successful shared save, including previously saved members.
   * Cancelled saves and new edits suppress this callback; recheck signal after any await. */
  afterSave?(context: UiActivation): unknown;
}
export interface UiSettingsPort {
  /** Opens the tab containing a section; tab ids are also accepted. */
  open(sectionId?: string): void;
  close(): void;
  /** The selected tab id, or an empty string while closed. */
  currentSection(): string;
  /** Changes only when a closed panel opens; switching sections preserves the editing cycle. */
  getOpenGeneration(): number;
  refresh(): void;
  setState(sectionId: string, state: { text?: string; tone?: string; saveLabel?: string; disabled?: boolean; busy?: boolean }): void;
}
export interface UiDialogInput {
  title?: unknown; message?: unknown; confirmLabel?: unknown; cancelLabel?: unknown; tone?: unknown;
  choices?: unknown; inputLabel?: unknown; value?: unknown; placeholder?: unknown; required?: unknown; maxLength?: unknown;
  signal?: AbortSignal;
}
/** Stable ports cross the capability boundary; no feature instances are exposed. */
export interface UiExtensionAPI {
  readonly root: Document;
  readonly signal: AbortSignal;
  readonly providers: { createSettings(host: SettingsProductHost): SettingsProduct };
  readonly settings: UiSettingsPort;
  readonly extensions: UiWorkspacePort;
  readonly storage: CapabilityStateStore;
  readonly sessions: UiSessionPort;
  readonly chat: UiChatPort;
  readonly presentation: {
    renderMarkdown(text: string): string;
    clearMath(root: Node | null): void;
    scheduleMath(root: Node | null): void;
    highlightSearchText(root: Element, query: string): void;
  };
  readonly performance: {
    start(name: string, metadata?: Record<string, unknown>): ((metadata?: Record<string, unknown>) => void) | null;
    grid(stage: string, metadata?: Record<string, unknown>): void;
  };
  getCurrentPage(): string;
  isDebugEnabled(): boolean;
  setDebugMode(enabled: boolean): void;
  syncKeepAlive(): void;
  request(type: string, payload?: UiEvent, timeoutMs?: number | null): Promise<UiEvent>;
  send(message: UiEvent): unknown;
  on(type: string, listener: (event: UiEvent) => unknown): () => void;
  registerPage(page: UiPage): void;
  registerSettings(section: UiSettingsSection): void;
  registerOverlay(overlay: UiOverlay): void;
  mountTemplate(id: string): HTMLElement;
  onDispose(cleanup: () => unknown): void;
  getCurrentSessionId(): string | null;
  getRunContext(): { runStatus?: string; activeRunId?: string | null; currentSessionId?: string | null };
  navigate(page: string, options?: { userInitiated?: boolean; refresh?: boolean }): boolean;
  notifyViewChange(): void;
  showToast(message: unknown, options?: UiToastOptions): void;
  hideToast(options?: { key?: string }): boolean;
  readonly dialogs: {
    confirm(input: unknown, options?: UiDialogInput): Promise<boolean>;
    choose(input?: UiDialogInput): Promise<string | null>;
    requestText(input?: UiDialogInput): Promise<string | null>;
  };
}

/** File-discovered setup runs once per mount; the package directory supplies its identity. */
export type UiExtension = (qz: UiExtensionAPI) => void | Promise<void>;
