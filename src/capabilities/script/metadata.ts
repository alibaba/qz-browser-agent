import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  run_script: toolMeta(t("executeScript"), ["script"], { profileFamily: "script", resultFamily: "script", familyId: "process", pageContext: false }),
  evaluate: toolMeta(t("executePageScript"), ["script"], { profileFamily: "script", resultFamily: "script", familyId: "process", pageContext: true }),
  list_tools: toolMeta(t("listTools"), [], { familyId: "process", pageContext: false }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;


