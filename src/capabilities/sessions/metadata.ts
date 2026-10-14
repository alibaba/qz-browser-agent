import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  manage_sessions: toolMeta(t("manageTasksTitle"), ["session"], { profileFamily: "sessions", resultFamily: "sessions", familyId: "process" }),
  get_location: toolMeta(t("getLocation"), [], { familyId: "process" }),
  manage_goal: toolMeta(t("goalTracking"), [], { shortTitle: t("goalTrackingShort"), familyId: "process" }),
});

const actionLabels = () => Object.freeze({
  last_messages: t("latestMessagesShort"),
});

export default { get actionLabels() { return actionLabels(); }, get tools() { return tools(); } } satisfies CapabilityMetadata;


