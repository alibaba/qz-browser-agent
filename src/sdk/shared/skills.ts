/** Public skills contracts and operations, independent of extension implementation paths. */
export { isBuiltinSkill, isBuiltinSkillName } from "../../shared/skills/builtin-skills.js";
export type { SkillWorkspaceSnapshot } from "../../shared/contracts/skill-workspace.js";
export type { GitSkillSource } from "../../shared/skills/git-skill-sources.js";
export { SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION, findSkillManifestResource, parseSkillManifest } from "../../shared/skills/skill-manifest.js";
export type { SkillManifest, SkillMcpServer } from "../../shared/skills/skill-manifest.js";
export { createZip, exportSkillsZip, importSkillsFromFileList, importSkillsZip, parseSkillMarkdownFrontmatter, readSkillYamlString, readSkillYamlStringList, skillToSkillMarkdown } from "../../shared/skills/skill-package.js";
export type { ImportFile } from "../../shared/skills/skill-package.js";
export { SKILL_SCOPE_GLOBAL, SKILL_SCOPE_RESIDENT, SKILL_SCOPE_SITE, getSkillDisplayName, isBase64SkillResource, isSkillDocumentResource, isValidAgentSkillName, matchSiteSkillsForUrls, matchesSkillSearch, modernSkillValuesFromRecord, normalizeModernSkill, normalizeSkill, normalizeSkillLookup, skillEntriesByIdentity, skillMatchesName, skillResourceByteSize } from "../../shared/skills/skill-utils.js";
export type { SkillRecord, SkillResource } from "../../shared/skills/skill-utils.js";
export { listSkillRendererDefinitions } from "../../shared/skills/skill-renderers.js";
