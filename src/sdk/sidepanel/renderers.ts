/** Public rendering contracts. Implementations, registries and workspace state stay in the host. */
import type { TranscriptEntry as StoredTranscriptEntry } from "../../shared/contracts/session.js";

/** Serializable presentation snapshot; DOM, instances and disclosure state stay in Side Panel. */
export interface ToolView {
  readonly id: string;
  readonly rendererId: string;
  readonly name: string;
  readonly title: string;
  readonly state: "preparing" | "running" | "completed" | "incomplete" | "error" | "aborted";
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly originalResult: unknown;
  readonly rawArgsText: string;
  readonly hasResult: boolean;
  readonly isRunning: boolean;
  readonly isError: boolean;
  readonly argsIncomplete: boolean;
  readonly profileFamily: string;
  readonly status: Readonly<{ title: string; tone: string }>;
}

/** Historical events may predate normalized renderer input; normalize them at the host boundary. */
export interface ToolEvent extends Partial<Omit<StoredTranscriptEntry, "status" | "summary">>, Partial<Pick<ToolView,
  "rawArgsText" | "hasResult" | "profileFamily"
>> {
  summary?: unknown;
  argsComplete?: boolean;
  resultFamily?: string;
  labelerId?: string;
  pageContext?: boolean;
  detailLayout?: string;
  mediaPresentation?: string;
  _uiKey?: string;
}

/** Client projection; unknown payloads remain opaque until their renderer reads them. */
export interface TranscriptEntry extends ToolEvent {
  status?: StoredTranscriptEntry["status"];
  entries?: TranscriptEntry[];
  _toolPresentationAnchor?: string;
}

export interface RendererContext { readonly document: Document; readonly signal: AbortSignal }
export interface RendererInstance { update(view: ToolView): undefined; dispose(): undefined }
export interface RendererDefinition {
  readonly id: string;
  readonly lane?: "detail" | "wide";
  /** Optional package-owned skin class for the shared tool-details container. */
  readonly detailsClass?: (view: ToolView) => string;
  /** Defaults to true; a renderer may suppress redundant raw data in its footer. */
  readonly showRawData?: boolean;
  /** Package-owned context shown before both successful and failed results. */
  readonly renderPrelude?: (container: HTMLElement, view: ToolView) => unknown;
  /** Return true when the package has rendered its own error payload. */
  readonly renderErrorResult?: (container: HTMLElement, view: ToolView) => boolean;
  /** Optional argument projection shown alongside a failed result by the shared error shell. */
  readonly renderErrorInputs?: (container: HTMLElement, view: ToolView) => unknown;
  /** Optional progress preview after the shared running summary and compact parameters. */
  readonly renderRunningInputs?: (container: HTMLElement, view: ToolView) => unknown;
  mount(container: HTMLElement, view: ToolView, context: RendererContext): RendererInstance;
  renderStatic(view: ToolView, context: Pick<RendererContext, "document">): Node;
}

/** Pure summaries are shared by cards, timelines and generic failure/running views. */
export interface ToolPresentationView {
  readonly name: string;
  /** Historical identity metadata is retained for capability-owned presentation policies. */
  readonly tool: Readonly<ToolEvent>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly rawArgsText: string;
  readonly surface: "details" | "timeline";
}
export interface ToolPresentationLabel {
  readonly label: string;
  readonly order: number;
  /** Optional stable evidence group; the first matching tool supplies its label. */
  readonly key?: string;
}
export interface ToolPresentationDefinition {
  /** A stable capability ID or renderer/profile ID; capability-specific rules win. */
  readonly id: string;
  /** Visibility belongs to the capability ID, never to tools that share its renderer. */
  readonly timelineVisibility?: "hidden" | "standalone";
  timelineTarget?(view: ToolPresentationView): string | undefined;
  timelineBadge?(view: ToolPresentationView): ToolPresentationLabel | undefined;
  timelineGroupTitle?(view: ToolPresentationView): ToolPresentationLabel | undefined;
  /** Optional result interpretation; explicit execution failure/abort remains authoritative. */
  resultIsError?(view: ToolPresentationView): boolean | undefined;
  argsSummary?(view: ToolPresentationView): string | undefined;
  describeRun?(view: ToolPresentationView): string | undefined;
  compactParams?(view: ToolPresentationView): Readonly<Record<string, unknown>> | undefined;
}

export type ProfileProjection = (parent: HTMLElement, view: ToolView) => unknown;
export interface RendererServices {
  readonly generic: {
    describeToolRun(tool: ToolEvent | string | undefined, args: Record<string, unknown>, result: unknown, hasResult: boolean): unknown;
    appendJsonCodeBlock(parent: HTMLElement, label: string, value: unknown): void;
    appendMarkdownSection(parent: HTMLElement, title: unknown, text: unknown): void;
  };
  pageDisplayTarget(args?: unknown, result?: unknown, options?: {maxLength?: number; fallbackToTabId?: boolean; fallbackLabel?: string}): string;
  renderMarkdown(source: string): string;
  formatSkillToolHeaderLabel(name: string | undefined, args: Record<string, unknown>, result: unknown): string;
  /** Delegate by ID. A missing extension uses the host's readable fallback. */
  render(parent: HTMLElement, view: ToolView): true;
  /** A stateless projection automatically gains live updates, cleanup and offline export. */
  project(id: string, projection: ProfileProjection, options?: Pick<RendererDefinition,
    "renderErrorInputs" | "renderRunningInputs" | "renderPrelude" | "renderErrorResult" | "detailsClass" | "showRawData">): RendererDefinition;
}
/** Register synchronously; rendering callbacks receive the current execution's immutable view. */
export interface RendererExtensionAPI extends RendererServices {
  registerRenderer(renderer: RendererDefinition): void;
  registerPresentation(presentation: ToolPresentationDefinition): void;
}
export type RendererExtension = (qz: RendererExtensionAPI) => void;
