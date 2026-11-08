import { t } from "./i18n.js";
import { getResultEnvelope } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
import type { RendererServices } from "#sdk/sidepanel";
import { isToolResultErrorLike, isPageContextToolName } from "#sdk/sidepanel/presentation";

export const presentations = (host: RendererServices): readonly ToolPresentationDefinition[] => ["run_script", "script"].map(id => ({
  id,
  resultIsError: ({ tool, result }) => {
    if (typeof tool.isError === "boolean") return tool.isError;
    const envelope = getResultEnvelope(result);
    return envelope?.ok === true && !isToolResultErrorLike(envelope) ? false : undefined;
  },
  argsSummary: ({ tool, args, result }) => {
    if (!isPageContextToolName(tool)) return "";
    const page = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const details = page.details && typeof page.details === "object" ? page.details as Record<string, unknown> : {};
    // A script's returned title/url are user data; only host page metadata identifies its execution page.
    const target = host.pageDisplayTarget(args, {
      _pageTitle: page._pageTitle ?? details._pageTitle, _pageUrl: page._pageUrl ?? details._pageUrl,
    }, { maxLength: 42, fallbackToTabId: true });
    return target ? `(${target})` : "";
  },
  timelineBadge: () => ({ label: t("script"), order: 40 }),
  describeRun: ({ surface }) => surface === "timeline" ? t("executeCode") : t("executeScript"),
  compactParams: ({ args }) => {
    const { code: _, target: _target, scope: _scope, engine: _engine, execution_world: _world, ...rest } = args;
    return rest;
  },
}));
