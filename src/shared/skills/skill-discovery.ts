import { getSkillDisplayName, matchSkillUrl, type SkillRecord } from "./skill-utils.js";

export interface SkillSummary {
  name: string;
  displayName: string;
  description: string;
  scope: string;
  domains?: string[];
  urlPatterns?: string[];
}

export function summarizeSkill(skill: SkillRecord): SkillSummary {
  return {
    name: skill.name,
    displayName: getSkillDisplayName(skill) || skill.name,
    description: skill.description,
    scope: skill.scope,
    ...(skill.scope === "site" ? { domains: [...skill.domains], urlPatterns: [...skill.urlPatterns] } : {}),
  };
}

export function isDiscoverableUserSkill(skill: SkillRecord) {
  return Boolean(skill.name) && skill.status !== "disabled" && skill.builtin !== true && skill.source !== "system";
}

export function discoverUserSkills(skills: readonly SkillRecord[], urls: readonly string[] = []) {
  return skills.filter(isDiscoverableUserSkill)
    .filter(skill => skill.scope === "global" || skill.scope === "resident"
      || (skill.scope === "site" && (skill.domains.length > 0 || skill.urlPatterns.length > 0)
        && urls.some(url => matchSkillUrl(skill, url))))
    .map(skill => ({ skill, summary: summarizeSkill(skill) }));
}
