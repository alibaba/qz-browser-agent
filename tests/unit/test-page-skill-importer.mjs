import assert from "node:assert/strict";
import test from "node:test";

import { createGitSkillSourceRepository } from "../../src/background/skills/git-skill-source-repository.js";
import {
  createPageSkillImportService,
} from "../../src/background/skills/page-skill-importer.js";
import { createZip } from "../../src/shared/skills/skill-package.js";
import { normalizeModernSkill } from "../../src/shared/skills/skill-utils.js";

const ZIP_URL = "https://skills.example/download/private-package.zip";

function createRepositoryState(initial = {}) {
  const state = structuredClone({ _skills: {}, ...initial });
  const repository = createGitSkillSourceRepository({
    storage: {
      async get(keys) {
        return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])]));
      },
      async set(values) {
        Object.assign(state, structuredClone(values));
      },
    },
  });
  return { repository, state };
}

async function skillZip(skills = []) {
  const entries = [];
  for (const skill of skills) {
    entries.push({
      path: `${skill.name}/SKILL.md`,
      content: `---\nname: ${skill.name}\ndescription: ${skill.description || "Imported Skill"}\n---\n${skill.content || `# ${skill.name}`}`,
    });
    for (const resource of skill.resources || []) {
      entries.push({ path: `${skill.name}/${resource.path}`, content: resource.content || "" });
    }
  }
  return (await createZip(entries)).arrayBuffer();
}

test("page importer consumes an Agent-provided Zip URL and atomically creates its Skills", async () => {
  const archive = await skillZip([{
    name: "page-imported",
    description: "Imported from a signed page URL.",
    content: "# Page imported\n\nUse the bundled script.",
    resources: [{ path: "scripts/run.js", content: "async () => ({ ok: true })" }],
  }]);
  const { repository } = createRepositoryState({
    _gitSkillSources: { preserved: { id: "preserved", repositoryUrl: "https://github.com/example/skills" } },
  });
  const downloads = [];
  const validated = [];
  const changes = [];
  const service = createPageSkillImportService({
    repository,
    downloadFromTab: async (tabId, url) => {
      downloads.push({ tabId, url });
      return archive;
    },
    validateSkill: async skill => validated.push(skill.name),
    onSkillsChanged: async change => changes.push(change),
    now: () => "2026-07-14 15:20:00",
  });

  const result = await service.import({ tabId: 73, url: ZIP_URL });
  assert.equal(result.ok, true);
  assert.deepEqual(result.names, ["page-imported"]);
  assert.deepEqual(downloads, [{ tabId: 73, url: ZIP_URL }]);
  assert.deepEqual(validated, ["page-imported"]);
  assert.deepEqual(changes, [{ action: "page_zip_import", names: ["page-imported"] }]);

  const snapshot = await repository.readSnapshot();
  assert.equal(snapshot.skills["page-imported"].content, "# Page imported\n\nUse the bundled script.");
  assert.equal(snapshot.skills["page-imported"].resources[0].path, "scripts/run.js");
  assert.equal(snapshot.skills["page-imported"].updatedAt, "2026-07-14 15:20:00");
  assert.equal(snapshot.sources.preserved.id, "preserved");
});

test("page importer reports name conflicts without overwriting until explicitly allowed", async () => {
  const archive = await skillZip([{ name: "existing-skill", content: "# New content" }]);
  const { repository } = createRepositoryState({
    _skills: {
      "existing-skill": {
        name: "existing-skill",
        description: "Local version",
        content: "# Local content",
        scope: "global",
        createdAt: "2026-07-01 10:00:00",
        updatedAt: "2026-07-01 10:00:00",
      },
    },
  });
  let validations = 0;
  const service = createPageSkillImportService({
    repository,
    downloadFromTab: async () => archive,
    validateSkill: async () => { validations += 1; },
    now: () => "2026-07-14 15:30:00",
  });

  const conflict = await service.import({ tabId: 73, url: ZIP_URL });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "SKILL_IMPORT_NAME_CONFLICT");
  assert.deepEqual(conflict.conflicts, [{ name: "existing-skill", reason: "name_conflict" }]);
  assert.equal(validations, 0);
  assert.equal((await repository.readSnapshot()).skills["existing-skill"].content, "# Local content");

  const overwritten = await service.import({ tabId: 73, url: ZIP_URL, overwrite: true });
  assert.equal(overwritten.ok, true);
  assert.equal(overwritten.overwrittenCount, 1);
  const installed = (await repository.readSnapshot()).skills["existing-skill"];
  assert.equal(installed.content, "# New content");
  assert.equal(installed.createdAt, "2026-07-01 10:00:00");
  assert.equal(installed.updatedAt, "2026-07-14 15:30:00");
});

test("page imports preserve siblings with the same title or a title equal to the imported ID", async () => {
  const neighbours = [
    normalizeModernSkill({ name: "sibling", displayName: "target", content: "keep", createdAt: "sibling-only" }),
    normalizeModernSkill({ name: "same-title", displayName: "Shared title", content: "keep too" }),
  ];
  const { repository } = createRepositoryState({ _skills: Object.fromEntries(neighbours.map(row => [row.name, row])) });
  const service = createPageSkillImportService({
    repository,
    downloadFromTab: async () => new ArrayBuffer(0),
    importZip: async () => [normalizeModernSkill({ name: "target", displayName: "Shared title", content: "new" })],
  });
  assert.equal((await service.import({ tabId: 73, url: ZIP_URL })).ok, true);
  const created = (await repository.readSnapshot()).skills.target;
  assert.notEqual(created.createdAt, "sibling-only");
  assert.equal((await service.import({ tabId: 73, url: ZIP_URL, overwrite: true })).ok, true);
  const { skills } = await repository.readSnapshot();
  assert.equal(skills.target.createdAt, created.createdAt);
  for (const row of neighbours) assert.deepEqual(skills[row.name], row);
});

test("page importer validates every Skill before committing any of them", async () => {
  const archive = await skillZip([
    { name: "valid-first", content: "# First" },
    { name: "invalid-second", content: "# Second" },
  ]);
  const { repository } = createRepositoryState();
  const service = createPageSkillImportService({
    repository,
    downloadFromTab: async () => archive,
    validateSkill: async skill => {
      if (skill.name === "invalid-second") throw new Error("invalid plugin manifest");
    },
  });

  await assert.rejects(
    () => service.import({ tabId: 73, url: ZIP_URL }),
    /invalid plugin manifest/,
  );
  assert.deepEqual((await repository.readSnapshot()).skills, {});
});

test("page importer never writes a late archive after its run is aborted", async () => {
  const archive = await skillZip([{ name: "late-skill", content: "# Late" }]);
  const { repository } = createRepositoryState();
  const controller = new AbortController();
  const service = createPageSkillImportService({
    repository,
    downloadFromTab: async () => {
      controller.abort();
      return archive;
    },
  });

  await assert.rejects(
    () => service.import({ tabId: 73, url: ZIP_URL }, { signal: controller.signal }),
    error => error?.code === "OPERATION_ABORTED",
  );
  assert.deepEqual((await repository.readSnapshot()).skills, {});
});
