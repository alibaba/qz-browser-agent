import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createNavigationProfiles(helpers: ProfileHelpers) {
function appendNavigationProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  const url = data.url || args.url || "";
  const title = data.title || args.title || navigationFallbackTitle(toolName, data);
  presentation.appendCompactLine(parent, {
    title,
    subtitle: url,
    meta: [
      data.focusedWindow === false ? t("background") : "",
      data.closed ? t("closed") : "",
      data.pageMode === "mobile" ? t("mobileMode") : data.pageMode === "desktop" ? t("desktopMode") : "",
    ].filter(Boolean),
  });
  return true;
}

function navigationFallbackTitle(toolName: string, data: Data = {}) {
  if (data.closed) return t("pageClosed");
  if (toolName === "navigate") return t("pageNavigated");
  if (toolName === "set_page_mode") return data.changed ? t("modeChanged") : t("modeUnchanged");
  // Legacy tool results remain readable in saved transcripts.
  if (toolName === "use_tab") return t("pageSelected");
  if (toolName === "get_working_tab") return data.hasWorkingTab === false ? t("noWorkingPage") : t("workingPage");
  return t("pageOpened");
}

  return { renderNavigation: appendNavigationProfile };
}
