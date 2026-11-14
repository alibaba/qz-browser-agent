import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { ToolMetadata } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  read_article: toolMeta(t("readArticle"), ["article"], { profileFamily: "article", resultFamily: "article", familyId: "collect", pageContext: true }),
  read_dom: toolMeta(t("readHtml"), [], { profileFamily: "domRaw", resultFamily: "page-raw", familyId: "collect", pageContext: true }),
  select_element: elementTool(t("selectElement"), { shortTitle: t("selectElementShort") }),
  find_elements: elementTool(t("findElements"), { shortTitle: t("findElementsShort") }),
  find_all_elements: elementTool(t("findElements"), { shortTitle: t("findElementsShort") }),
  inspect_element: elementTool(t("inspectElement"), { shortTitle: t("inspectElementShort") }),
  act_on_element: elementTool(t("interactWithElement"), { shortTitle: t("interactWithElementShort") }),
  click_element: elementTool(t("clickElement"), { shortTitle: t("clickElementShort") }),
  fill_input: elementTool(t("fillInput"), { shortTitle: t("fillInputShort") }),
  scroll_page: elementTool(t("scrollPage"), { shortTitle: t("scrollPageShort") }),
  highlight_elements: elementTool(t("highlightElement"), { shortTitle: t("highlightElementShort") }),
  inject_css: toolMeta(t("injectStyles"), ["domMutation"], { profileFamily: "css", familyId: "process", pageContext: true }),
  modify_dom: toolMeta(t("modifyDom"), ["domMutation"], { profileFamily: "domMutation", familyId: "process", pageContext: true }),
});

const actionLabels = () => Object.freeze({
  addClass: "addClass",
  removeAttr: "removeAttr",
  setHTML: "setHTML",
});

export default { get actionLabels() { return actionLabels(); }, get tools() { return tools(); } } satisfies CapabilityMetadata;

function elementTool(title: string, options: Partial<ToolMetadata> = {}) {
  return toolMeta(title, ["element"], {
    shortTitle: options.shortTitle,
    profileFamily: "element",
    resultFamily: "elements",
    familyId: "operate",
    pageContext: true,
    labelerId: options.labelerId,
  });
}
