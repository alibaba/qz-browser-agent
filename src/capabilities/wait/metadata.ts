import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { ToolMetadata } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  wait_for_response: waitTool(t("waitingForResponse"), { resultFamily: "network", familyId: "process" }),
  wait_for_network_idle: waitTool(t("waitingForNetworkIdle"), { shortTitle: t("waitingForNetworkIdleShort"), resultFamily: "network", familyId: "process" }),
  wait_for_user: waitTool(t("waitingForUser"), { sets: ["human"], familyId: "confirm", pageContext: false }),
  send_alert: toolMeta(t("notifyUser"), ["human"], { shortTitle: t("notifyUserShort"), profileFamily: "sendAlert", familyId: "alert" }),
  ask_user: toolMeta(t("askUser"), ["ask", "human"], { shortTitle: t("askUserShort"), profileFamily: "askUser", familyId: "confirm" }),
  wait_for_load: waitTool(t("waitingForPageLoad"), { shortTitle: t("waitingForPageLoadShort"), familyId: "arrival" }),
  wait_for_navigation: waitTool(toolT("waitForNavigationTitle"), { familyId: "arrival" }),
  wait_for_popup: waitTool(toolT("waitForPopupTitle"), { familyId: "arrival" }),
  wait_for_url: waitTool(toolT("waitForUrlTitle"), { familyId: "arrival" }),
  wait_for_function: waitTool(toolT("waitForFunctionTitle"), { familyId: "arrival" }),
  wait_for_element: waitTool(t("waitingForElement"), { profileFamily: "wait", familyId: "operate" }),
  wait: waitTool(t("wait"), { familyId: "confirm", pageContext: false }),
  wait_until: waitTool(t("waitUntilATime"), { familyId: "confirm", pageContext: false }),
  ask_llm: toolMeta(t("askModel"), ["ask"], { profileFamily: "askLlm", familyId: "process" }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;

function waitTool(title: string, options: Partial<ToolMetadata> = {}) {
  return toolMeta(title, ["wait"], {
    shortTitle: options.shortTitle,
    profileFamily: options.profileFamily || "wait",
    resultFamily: options.resultFamily || "generic",
    familyId: options.familyId || "confirm",
    pageContext: options.pageContext !== false,
    sets: options.sets || [],
  });
}
