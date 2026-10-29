import { t } from "../i18n/index.js";
import { toolPresentationRegistry } from "./tool-presentation.js";
import * as skillPresentation from "./skill-renderer-context.js";
import * as presentation from "./generic-result-renderer.js";
import type { ToolView } from "../../sdk/sidepanel/renderers.js";
import { record, type ToolEvent } from "./renderer-input.js";
import type { createGenericResultRenderer } from "./generic-result-renderer.js";

interface RuntimeDetailsOptions {
  genericRenderer: Pick<ReturnType<typeof createGenericResultRenderer>, "appendGenericCompactView" | "describeToolRun">;
  renderPrelude(parent: HTMLElement, tool: ToolView): unknown;
  renderErrorResult(parent: HTMLElement, tool: ToolView): boolean;
  renderErrorInputs(parent: HTMLElement, tool: ToolView): unknown;
  renderRunningInputs(parent: HTMLElement, tool: ToolView): unknown;
}

import { createToolView } from "./renderer-host.js";
import {
  getToolProfileFamily,
  isToolResultErrorLike as isErrorLike,
  resolveToolState,
  toolKey,
} from "./tool-model.js";

export function createToolRuntimeDetails(options: RuntimeDetailsOptions) {
  const genericRenderer = options.genericRenderer;
  const renderErrorInputs = options.renderErrorInputs;

function project(tool: ToolEvent): ToolView {
  const resultValue = (tool.hasResult || tool.isError) ? presentation.normalizeFriendlyValue(tool.result) : null;
  const displayResult = presentation.unwrapResultValue(resultValue).value;
  const state = getToolState(tool, resultValue, displayResult);
  const status = getToolStatus(tool, state);
  const profileFamily = getToolProfileFamily(tool);
  return createToolView({
    ...tool, args: record(tool.args), id: tool.id || tool.toolCallId || tool._uiKey || tool.name || "",
    name: toolKey(tool) || tool.name || "",
    rendererId: tool.rendererId || profileFamily || (skillPresentation.resolveSkillToolRenderContext(tool.name, tool.args, tool.result).plugin ? "plugin" : "generic"),
    profileFamily, result: displayResult, originalResult: resultValue, status,
    state,
  });
}

function appendReadableToolDetails(parent: HTMLElement, tool: ToolView, renderProfile?: (parent: HTMLElement, tool: ToolView) => unknown, { compact = true } = {}) {
  const { result: displayResult, originalResult: resultValue, status } = tool;
  options.renderPrelude(parent, tool);
  if (status.tone === "error") {
    if (!options.renderErrorResult(parent, tool)) {
      presentation.appendErrorSection(parent, pickErrorDisplayValue(displayResult, resultValue, tool.result));
    }
    if (!renderErrorInputs(parent, tool)) presentation.appendCompactParams(parent, tool, tool.args);
    return;
  }

  if (renderProfile?.(parent, tool)) return;
  if (tool.isRunning && !tool.hasResult) return appendRunningToolDetails(parent, tool, status);
  genericRenderer.appendGenericCompactView(parent, tool, displayResult, resultValue, status, { compact });
}

function appendRunningToolDetails(parent: HTMLElement, tool: ToolView, status: ToolView["status"]) {
  presentation.appendCompactLine(parent, {
    title: status.title,
    subtitle: tool.argsIncomplete
      ? t("toolArgumentsPending")
      : genericRenderer.describeToolRun(tool, tool.args, null, false),
    meta: tool.rawArgsText ? [t("textCharacters", { count: tool.rawArgsText.length })] : [],
  });
  presentation.appendCompactParams(parent, tool, tool.args);
  options.renderRunningInputs(parent, tool);
  if (tool.rawArgsText && presentation.isEmptyJsonObject(tool.args)) {
    presentation.appendTextSection(parent, t("partialArguments"), presentation.summarizeValue(tool.rawArgsText, 1200));
  }
}

  return {
    project,
    append: appendReadableToolDetails,
  };
}

function pickErrorDisplayValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (isErrorLike(value)) return value;
  }
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function getToolState(tool: ToolEvent, resultValue: unknown, displayResult: unknown): ToolView["state"] {
  const resultIsError = toolPresentationRegistry.project("resultIsError", tool, tool.args, resultValue);
  const state = resultIsError === undefined
    ? resolveToolState(tool, resultValue, displayResult)
    : resolveToolState({ ...tool, isError: tool.isError || resultIsError }, resultValue);
  if (state === "success") return "completed";
  if (state === "running" && (tool.argsIncomplete || tool.phase === "preparing")) return "preparing";
  return state;
}

function getToolStatus(tool: ToolEvent, state: ToolView["state"]): ToolView["status"] {
  if (state === "aborted") return { title: t("terminated"), tone: "error" };
  if (state === "error") return { title: t("incomplete"), tone: "error" };
  if (state === "incomplete") return { title: t("toolResultIncompleteShort"), tone: "incomplete" };
  if (tool.argsIncomplete || tool.phase === "preparing") return { title: t("preparingArgs"), tone: "running" };
  if (state === "running" && tool.statusText) return { title: tool.statusText, tone: "running" };
  if (state === "running") return { title: t("running"), tone: "running" };
  return { title: t("completed"), tone: "success" };
}

