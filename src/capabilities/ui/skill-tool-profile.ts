import { t } from "./i18n.js";
import { skillResultData, skillResultEnvelope } from "#sdk/sidepanel/components";
import { isSkillResourceRenderer, resolveSkillToolRenderContext } from "#sdk/sidepanel/skills";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";
import type { RendererServices } from "#sdk/sidepanel";
import type { ToolView } from "#sdk/sidepanel";

type Data = Record<string, unknown>;
interface ProfileOptions { status?: ToolView["status"] }
interface SkillToolProfileHelpers {
  structuredRenderer: ReturnType<typeof createDeclarativeRenderer>;
  render: RendererServices["render"];
  formatSkillToolHeaderLabel(name: string | undefined, args: unknown, result: unknown): string;
}

import type { createDeclarativeRenderer } from "#sdk/sidepanel/components";

export function createSkillToolProfile(helpers: SkillToolProfileHelpers) {
  const {
    structuredRenderer,
    render,
    formatSkillToolHeaderLabel,
  } = helpers;

function appendSkillToolProfile(parent: HTMLElement, tool: ToolView, result: unknown, originalResult: unknown, options: ProfileOptions = {}) {
  const context = resolveSkillToolRenderContext(tool.name, originalResult, result, tool.args);
  const plugin = context.plugin;
  const data = skillResultData(result, originalResult, plugin);
  const renderer = context.renderer || null;
  if (!renderer) {
    if (plugin?.runtime === "mcp") return render(parent, { ...tool, rendererId: "plugin-mcp", result: result || originalResult || {} });
    return appendSkillRunScriptProfile(parent, tool, plugin, result, originalResult);
  }
  if (isSkillResourceRenderer(renderer)) {
    parent.classList.add("tool-details-skill-edit");
    return render(parent, { ...tool, rendererId: "plugin-skill" });
  }
  if (options.status) return appendSkillPreparingRenderer(parent, renderer, tool, plugin, options.status);

  if (renderer && structuredRenderer.render(parent, renderer, data, plugin, { args: tool.args || {} })) return true;
  if (plugin?.runtime === "mcp") return render(parent, { ...tool, rendererId: "plugin-mcp", result: result || originalResult || {} });
  return appendSkillRunScriptProfile(parent, tool, plugin, result, originalResult);
}

function appendSkillPreparingRenderer(parent: HTMLElement, renderer: Data, tool: ToolView, plugin: Data | null, status: ToolView["status"]) {
  const title = renderer.title || plugin?.title || status.title || formatSkillToolHeaderLabel(tool.name, tool.args, null);
  const subtitle = renderer.subtitle
    || plugin?.displayName
    || plugin?.name
    || (tool.argsIncomplete ? t("preparingToolArguments") : "");
  presentation.appendCompactLine(parent, {
    title,
    subtitle,
    meta: [
      status.title,
      record(plugin?.category).label,
    ].filter(Boolean),
  });
  const renderedInputs = structuredRenderer.renderInputs(parent, renderer, tool.args || {}, plugin);
  if (!renderedInputs && !presentation.isEmptyJsonObject(tool.args)) presentation.appendCompactParams(parent, tool.name, tool.args);
  return true;
}

function appendSkillToolInputRenderers(parent: HTMLElement, tool: ToolEvent = {}) {
  const context = resolveSkillToolRenderContext(tool.name, tool.result, tool.args);
  if (!context.renderer) return false;
  return structuredRenderer.renderInputs(parent, context.renderer, tool.args || {}, context.plugin);
}

function appendSkillRunScriptProfile(parent: HTMLElement, tool: ToolView, plugin: Data | null, result: unknown, originalResult: unknown) {
  const value = skillResultEnvelope(result, originalResult);
  const scriptResult = tool.isError || presentation.unwrapResultValue(value).envelope ? value : { ok: true, result: value };
  return render(parent, { ...tool, rendererId: "plugin-script", args: {
    ...tool.args, skill: plugin?.skillName || "", script: plugin?.script || "",
  }, result: scriptResult, originalResult: scriptResult });
}

  return {
    render: appendSkillToolProfile,
    renderInputs: appendSkillToolInputRenderers,
  };
}

