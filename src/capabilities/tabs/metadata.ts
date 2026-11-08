import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  list_tabs: toolMeta(t("viewTabs"), ["tab"], { profileFamily: "tabs", resultFamily: "tabs", familyId: "arrival" }),
  open_tab: toolMeta(t("openPage"), ["navigation"], { profileFamily: "navigation", familyId: "arrival", pageContext: true }),
  close_tab: toolMeta(t("closePage"), ["navigation"], { profileFamily: "navigation", familyId: "arrival", pageContext: true }),
  navigate: toolMeta(t("navigatePage"), ["navigation"], { shortTitle: t("navigatePageShort"), profileFamily: "navigation", familyId: "arrival", pageContext: true }),
  set_page_mode: toolMeta(t("setPageMode"), ["navigation"], { profileFamily: "navigation", familyId: "arrival", pageContext: true }),
  group_tabs: toolMeta(t("organizeTabsTool"), [], { shortTitle: t("organizeTabsToolShort"), familyId: "arrival" }),
  // Presentation metadata for saved transcripts only; these tools are no longer registered.
  get_working_tab: toolMeta(t("viewWorkingPage"), ["tab"], { shortTitle: t("viewWorkingPageShort"), profileFamily: "tabs", resultFamily: "tabs", familyId: "arrival" }),
  use_tab: toolMeta(t("usePage"), ["navigation"], { shortTitle: t("usePageShort"), profileFamily: "navigation", familyId: "arrival", pageContext: true }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;

