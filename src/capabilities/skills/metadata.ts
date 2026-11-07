import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { ToolMetadata } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  manage_skill_settings: toolMeta(t("manageSkillConfiguration"), ["settings"], { shortTitle: t("manageSkillConfigurationShort"), profileFamily: "settings", resultFamily: "settings", familyId: "settings", labelerId: "settings", titleRule: { field: "action", normalize: "lowercase", values: { list: t("readSkillConfigurationShort"), get: t("readSkillConfigurationShort"), update: t("updateSkillConfigurationShort"), reorder: t("reorderSecurityPoliciesShort") }, fallback: "action" } }),
  list_skills: skillTool(t("skills")),
  load_skill: skillTool(t("loadSkill"), { shortTitle: t("loadSkillShort") }),
  load_skill_resource: skillTool(t("readSkillResource"), { shortTitle: t("readSkillResourceShort") }),
  create_skill: skillTool(t("createSkill")),
  edit_skill_resource: skillTool(t("editSkillResource"), { shortTitle: t("editSkillResourceShort"), detailLayout: "wide" }),
  update_skill: skillTool(t("updateSkill"), { shortTitle: t("updateSkillShort"), detailLayout: "wide" }),
  delete_skill: skillTool(t("deleteSkill"), { shortTitle: t("deleteSkillShort") }),
  manage_skill: skillTool(t("manageSkills"), { shortTitle: t("manageSkillsShort") }),
  import_skill_from_page_zip: toolMeta(t("importSkillFromPage"), [], { shortTitle: t("importSkillFromPageShort") }),
  import_git_skill_repository: toolMeta(t("importGitSkillRepository"), [], { shortTitle: t("importGitSkillRepositoryShort") }),
  install_skill_to_git: toolMeta(t("installSkillToGit"), [], { shortTitle: t("installSkillToGitShort") }),
  run_skill_script: toolMeta(t("runSkillScript"), [], { shortTitle: t("runSkillScriptShort") }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;

function skillTool(title: string, options: Partial<ToolMetadata> = {}) {
  return toolMeta(title, ["skill"], {
    shortTitle: options.shortTitle,
    profileFamily: "skill",
    resultFamily: "skill",
    familyId: "process",
    detailLayout: options.detailLayout,
  });
}
