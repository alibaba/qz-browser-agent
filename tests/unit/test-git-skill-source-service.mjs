import assert from "node:assert/strict";
import test from "node:test";

import { createGitSkillSourceRepository } from "../../src/background/skills/git-skill-source-repository.js";
import {
  createGitSkillSourceService,
  discoverGitRepository,
  downloadGitArchiveFromTab,
  resolveGitRepositoryProbe,
} from "../../src/background/skills/git-skill-sources.js";
import { buildGitSkillPublishFiles } from "../../src/background/skills/git-skill-publisher.js";
import {
  getGitSkillOrigin,
  gitSkillSourceId,
} from "../../src/shared/skills/git-skill-sources.js";
import { createZip, importSkillsZip } from "../../src/shared/skills/skill-package.js";
import { normalizeModernSkill } from "../../src/shared/skills/skill-utils.js";

const REPOSITORY_URL = "https://gitlab.example.com/example-team/browser-skills";
const GITHUB_REPOSITORY_URL = "https://github.com/openai/codex";
const GITHUB_DIRECTORY_URL = "https://github.com/jackwener/OpenCLI/tree/main/skills";
const ARCHIVE_URL = "https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip?path=&sha=main";
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x05, 0x06]).buffer;

test("old GitLab project metadata derives the API v3 archive URL without user-supplied SHA", () => {
  assert.deepEqual(resolveGitRepositoryProbe(REPOSITORY_URL, {
    projectId: "3705939",
    branch: "main",
    revision: "a".repeat(40),
  }), {
    repositoryUrl: REPOSITORY_URL,
    archiveUrl: ARCHIVE_URL,
    branch: "main",
    revision: "a".repeat(40),
  });
});

test("SSO pages do not complete repository discovery before login returns to the project", () => {
  assert.deepEqual(resolveGitRepositoryProbe(REPOSITORY_URL, {
    currentUrl: "https://login.example.com/preLogin2.htm?BACK_URL=https%3A%2F%2Fgitlab.example.com%2Fexample-team%2Fbrowser-skills",
    title: "Login",
  }), {
    repositoryUrl: REPOSITORY_URL,
    archiveUrl: "",
    branch: "",
    revision: "",
  });
});

test("GitHub repositories derive the default branch archive URL", () => {
  assert.deepEqual(resolveGitRepositoryProbe(GITHUB_REPOSITORY_URL, {
    currentUrl: GITHUB_REPOSITORY_URL,
    branch: "master",
    revision: "b".repeat(40),
  }), {
    repositoryUrl: GITHUB_REPOSITORY_URL,
    archiveUrl: `${GITHUB_REPOSITORY_URL}/archive/refs/heads/master.zip`,
    branch: "master",
    revision: "b".repeat(40),
  });
});

test("repository discovery navigates an existing GitHub tab to the selected directory", async () => {
  const tab = { id: 44, url: "https://github.com/jackwener/OpenCLI", status: "complete" };
  const updates = [];
  const result = await discoverGitRepository(GITHUB_DIRECTORY_URL, {
    tabs: {
      async query() { return [{ ...tab }]; },
      async update(id, changes) {
        assert.equal(id, 44);
        updates.push(changes);
        Object.assign(tab, changes);
        return { ...tab };
      },
      async create() { assert.fail("the existing repository tab should be reused"); },
      async get() { return { ...tab }; },
    },
    scripting: {
      async executeScript() {
        return [{ result: { currentUrl: GITHUB_DIRECTORY_URL, branch: "main", revision: "b".repeat(40) } }];
      },
    },
    sleep: async () => {},
  });
  assert.equal(updates[0].url, GITHUB_DIRECTORY_URL);
  assert.equal(result.browseUrl, GITHUB_DIRECTORY_URL);
  assert.equal(result.ref, "main");
  assert.equal(result.subpath, "skills");
});

test("repository discovery uses the task-owned tab when one is provided", async () => {
  const tab = { id: 91, url: "https://example.com/previous", status: "complete" };
  const updates = [];
  const result = await discoverGitRepository(GITHUB_DIRECTORY_URL, {
    tabId: 91,
    tabs: {
      async query() { assert.fail("a preferred tab must not fall back to global tab discovery"); },
      async get(tabId) {
        assert.equal(tabId, 91);
        return { ...tab };
      },
      async update(tabId, changes) {
        assert.equal(tabId, 91);
        updates.push(changes);
        Object.assign(tab, changes);
        return { ...tab };
      },
      async create() { assert.fail("a preferred task tab must be reused"); },
    },
    scripting: {
      async executeScript({ target }) {
        assert.equal(target.tabId, 91);
        return [{ result: { currentUrl: GITHUB_DIRECTORY_URL, branch: "main", revision: "c".repeat(40) } }];
      },
    },
    sleep: async () => {},
  });
  assert.deepEqual(updates, [{ active: true, url: GITHUB_DIRECTORY_URL }]);
  assert.equal(result.tabId, 91);
  assert.equal(result.subpath, "skills");
});

test("repository discovery creates a tab in the resolved Side Panel window", async () => {
  const createCalls = [];
  const targetCalls = [];
  const tab = { id: 92, windowId: 6, url: GITHUB_DIRECTORY_URL, status: "complete" };
  const result = await discoverGitRepository(GITHUB_DIRECTORY_URL, {
    sourceWindowId: 6,
    windowTarget: {
      async resolveForNewTab(input) {
        targetCalls.push(input);
        return 6;
      },
    },
    tabs: {
      async query() { return []; },
      async create(properties) {
        createCalls.push(properties);
        return { ...tab };
      },
      async update() { assert.fail("a missing repository tab should be created"); },
      async get() { return { ...tab }; },
    },
    scripting: {
      async executeScript() {
        return [{ result: { currentUrl: GITHUB_DIRECTORY_URL, branch: "main", revision: "d".repeat(40) } }];
      },
    },
    sleep: async () => {},
  });
  assert.deepEqual(targetCalls, [{ anchorTabId: undefined, sourceWindowId: 6 }]);
  assert.deepEqual(createCalls, [{ windowId: 6, url: GITHUB_DIRECTORY_URL, active: true }]);
  assert.equal(result.tabId, 92);
});

test("authenticated tab download streams private archives through CDP", async () => {
  const calls = [];
  let detached = false;
  const debuggerApi = {
    async attach(target, version) { calls.push(["attach", target.tabId, version]); },
    async detach(target) { detached = target.tabId === 77; },
    async sendCommand(_target, method, params) {
      calls.push([method, params]);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Network.loadNetworkResource") {
        return { resource: { success: true, httpStatusCode: 200, stream: "stream-1" } };
      }
      if (method === "IO.read") {
        return { data: Buffer.from(new Uint8Array(ZIP_BYTES)).toString("base64"), base64Encoded: true, eof: true };
      }
      if (method === "IO.close") return {};
      throw new Error(`unexpected command ${method}`);
    },
  };
  const archive = await downloadGitArchiveFromTab(77, ARCHIVE_URL, {
    withDebugger: async (tabId, operation) => {
      const target = { tabId };
      await debuggerApi.attach(target, "1.3");
      try {
        return await operation(target, (method, params = {}) => debuggerApi.sendCommand(target, method, params));
      } finally {
        await debuggerApi.detach(target);
      }
    },
  });
  assert.deepEqual(Array.from(new Uint8Array(archive)), Array.from(new Uint8Array(ZIP_BYTES)));
  assert.equal(detached, true);
  assert.deepEqual(calls.find(([method]) => method === "Network.loadNetworkResource")?.[1].options, {
    disableCache: true,
    includeCredentials: true,
  });
});

test("authenticated download can borrow the run-owned CDP connection without detaching it", async () => {
  const methods = [];
  let scopeCalls = 0;
  const archive = await downloadGitArchiveFromTab(77, ARCHIVE_URL, {
    withDebugger: async (tabId, operation) => {
      scopeCalls += 1;
      assert.equal(tabId, 77);
      return await operation({ tabId }, async (method, params) => {
        methods.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
        if (method === "Network.loadNetworkResource") {
          assert.equal(params.options.includeCredentials, true);
          return { resource: { success: true, httpStatusCode: 200, stream: "stream-1" } };
        }
        if (method === "IO.read") {
          return { data: Buffer.from(new Uint8Array(ZIP_BYTES)).toString("base64"), base64Encoded: true, eof: true };
        }
        if (method === "IO.close") return {};
        throw new Error(`unexpected command ${method}`);
      });
    },
  });
  assert.deepEqual(Array.from(new Uint8Array(archive)), Array.from(new Uint8Array(ZIP_BYTES)));
  assert.equal(scopeCalls, 1);
  assert.deepEqual(methods, ["Page.getFrameTree", "Network.loadNetworkResource", "IO.read", "IO.close"]);
});

test("an explicitly missing authorized scope cannot fall back to a private debugger attachment", async () => {
  let attached = false;
  await assert.rejects(
    downloadGitArchiveFromTab(77, ARCHIVE_URL, {
      withDebugger: null,
      debuggerApi: {
        async attach() { attached = true; },
        async detach() {},
        async sendCommand() { return {}; },
      },
    }),
    error => error?.code === "GIT_AUTHENTICATED_DOWNLOAD_UNAVAILABLE",
  );
  assert.equal(attached, false);
});

test("synchronization downloads only through the authenticated repository tab", async () => {
  let tabDownloads = 0;
  const harness = createHarness({
    repositoryProbe: async () => ({
      archiveUrl: ARCHIVE_URL,
      branch: "main",
      revision: "a".repeat(40),
      tabId: 77,
    }),
    downloadFromTab: async (tabId, archiveUrl) => {
      tabDownloads += 1;
      assert.equal(tabId, 77);
      assert.equal(archiveUrl, ARCHIVE_URL);
      return ZIP_BYTES.slice(0);
    },
  });
  const result = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  assert.equal(result.action, "bound");
  assert.equal(tabDownloads, 1);
});

test("GitHub binding downloads its archive through the opened GitHub tab", async () => {
  let requested = null;
  const probedUrls = [];
  const harness = createHarness({
    repositoryProbe: async (url) => {
      probedUrls.push(url);
      return {
        currentUrl: GITHUB_DIRECTORY_URL,
        branch: "main",
        revision: "b".repeat(40),
        tabId: 88,
      };
    },
    downloadFromTab: async (tabId, archiveUrl) => {
      requested = { tabId, archiveUrl };
      return ZIP_BYTES.slice(0);
    },
  });
  const result = await harness.service.bind({ repositoryUrl: GITHUB_DIRECTORY_URL });
  assert.equal(result.source.repositoryUrl, "https://github.com/jackwener/OpenCLI");
  assert.equal(result.source.browseUrl, GITHUB_DIRECTORY_URL);
  assert.equal(result.source.ref, "main");
  assert.equal(result.source.subpath, "skills");
  assert.equal(result.source.branch, "main");
  assert.deepEqual(requested, {
    tabId: 88,
    archiveUrl: "https://github.com/jackwener/OpenCLI/archive/refs/heads/main.zip",
  });
  assert.deepEqual(harness.importOptions, [{ subpath: "skills" }]);
  const snapshot = await harness.repository.readSnapshot();
  assert.equal(snapshot.sources[result.source.id].subpath, "skills");
  assert.equal(getGitSkillOrigin(snapshot.skills["content-one"]).subpath, "skills");
  await assert.rejects(
    harness.service.bind({ repositoryUrl: "https://github.com/jackwener/OpenCLI/tree/main/examples" }),
    error => error.code === "GIT_REPOSITORY_ALREADY_BOUND" && /同一仓库只能安装一次/u.test(error.message),
  );
  const current = await harness.service.update({ sourceId: result.source.id });
  assert.equal(current.action, "current");
  assert.deepEqual(probedUrls, [GITHUB_DIRECTORY_URL, GITHUB_DIRECTORY_URL]);
  assert.deepEqual(harness.importOptions, [{ subpath: "skills" }, { subpath: "skills" }]);
});

test("GitHub directory binding imports only Skills below the selected subpath", async () => {
  const scopedEntry = {
    path: "OpenCLI-main/skills/in-scope/SKILL.md",
    content: "---\nname: in-scope\ndescription: Selected Skill.\n---\n# In scope",
  };
  let zip = await createZip([
    scopedEntry,
    {
      path: "OpenCLI-main/examples/outside/SKILL.md",
      content: "---\nname: outside\ndescription: Outside Skill.\n---\n# Outside v1",
    },
  ]);
  const state = { _skills: {} };
  const repository = createGitSkillSourceRepository({
    storage: {
      async get(keys) { return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])])); },
      async set(values) { Object.assign(state, structuredClone(values)); },
    },
  });
  const service = createGitSkillSourceService({
    repository,
    repositoryProbe: async () => ({ currentUrl: GITHUB_DIRECTORY_URL, branch: "main", tabId: 88 }),
    downloadFromTab: async () => zip.arrayBuffer(),
    validateSkill: async () => ({ ok: true }),
    digest: async buffer => byteDigest(buffer),
    now: () => "2026-07-12 23:50:00",
  });
  const result = await service.bind({ repositoryUrl: GITHUB_DIRECTORY_URL });
  assert.deepEqual(result.names, ["in-scope"]);
  const snapshot = await repository.readSnapshot();
  assert.deepEqual(Object.keys(snapshot.skills), ["in-scope"]);
  assert.equal(snapshot.sources[result.source.id].subpath, "skills");
  zip = await createZip([
    scopedEntry,
    {
      path: "OpenCLI-main/examples/outside/SKILL.md",
      content: "---\nname: outside\ndescription: Outside Skill.\n---\n# Outside v2",
    },
  ]);
  const current = await service.update({ sourceId: result.source.id });
  assert.equal(current.action, "current", "changes outside the selected directory must not update the source");
});

test("a Skill published by Qingzhou binds without conflict and is immediately clean", async () => {
  const localSkill = normalizeModernSkill({
    name: "publish-smoke",
    displayName: "发布测试",
    description: "Round-trip regression.",
    content: "# Publish smoke\n\nUse the bundled script.",
    scope: "global",
    status: "active",
    metadata: {
      qingzhou: {
        origin: { type: "local-draft", note: "legacy publish metadata" },
      },
    },
    resources: [{ path: "scripts/run.js", type: "script", title: "Run", content: "export default 1;\n" }],
  });
  const published = buildGitSkillPublishFiles(localSkill, "batch-v3");
  const zip = await createZip(published.map(file => ({ path: `testlib-master/${file.path}`, content: file.content })));
  const state = { _skills: { [localSkill.name]: localSkill } };
  const repository = createGitSkillSourceRepository({
    storage: {
      async get(keys) { return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])])); },
      async set(values) { Object.assign(state, structuredClone(values)); },
    },
  });
  const service = createGitSkillSourceService({
    repository,
    repositoryProbe: async () => ({
      currentUrl: "https://gitlab.example.com/example-user/testlib/tree/master/batch-v3",
      archiveUrl: "https://gitlab.example.com/api/v3/projects/4242575/repository/archive.zip?path=&sha=master",
      branch: "master",
      revision: "c".repeat(40),
      tabId: 71,
    }),
    downloadFromTab: async () => zip.arrayBuffer(),
    importZip: importSkillsZip,
    validateSkill: async () => ({ ok: true }),
    digest: async buffer => byteDigest(buffer),
    now: () => "2026-07-13 00:53:06",
  });

  const result = await service.bind({
    repositoryUrl: "https://gitlab.example.com/example-user/testlib/tree/master/batch-v3",
    overwrite: false,
  });
  assert.equal(result.ok, true);
  const listed = await service.list();
  assert.equal(listed.sources.length, 1);
  assert.equal(listed.sources[0].modifiedCount, 0);
  assert.equal(listed.sources[0].missingCount, 0);
});

test("unsupported Git hosts fail before opening a repository tab", async () => {
  const harness = createHarness({
    repositoryProbe: async () => assert.fail("unsupported hosts must not open a tab"),
  });
  await assert.rejects(
    harness.service.bind({ repositoryUrl: "https://example.com/group/repository" }),
    error => error.code === "GIT_REPOSITORY_HOST_UNSUPPORTED" && /GitHub.*GitLab/u.test(error.message),
  );
});

test("binding imports repository skills, persists origin, and reports current archives", async () => {
  const harness = createHarness();
  const first = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  assert.equal(first.ok, true);
  assert.equal(first.action, "bound");
  assert.deepEqual(first.names, ["content-one", "content-two"]);
  assert.equal(harness.changes.length, 1);

  const snapshot = await harness.repository.readSnapshot();
  const sourceId = gitSkillSourceId(REPOSITORY_URL);
  assert.equal(snapshot.sources[sourceId].branch, "main");
  assert.equal(snapshot.sources[sourceId].skillNames.length, 2);
  assert.equal(getGitSkillOrigin(snapshot.skills["content-one"]).sourceId, sourceId);
  assert.doesNotMatch(JSON.stringify(snapshot.sources[sourceId]), /token|secret/u);

  const second = await harness.service.update({ sourceId });
  assert.equal(second.ok, true);
  assert.equal(second.action, "current");
  assert.equal(second.changed, false);
  assert.equal(harness.changes.length, 1);
});

test("checking is read-only and applying an available update is a separate action", async () => {
  const harness = createHarness();
  const bound = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  const sourceId = bound.source.id;
  harness.archiveVersion = 2;
  harness.imported = () => [skill("content-one", "# One v2"), skill("content-two", "# Two")];

  const checked = await harness.service.check({ sourceId });
  assert.equal(checked.action, "checked");
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.remoteChanged, true);
  assert.equal(checked.repairAvailable, false);
  let snapshot = await harness.repository.readSnapshot();
  assert.equal(snapshot.skills["content-one"].content, "# One v1", "check must not apply repository content");
  assert.equal(snapshot.sources[sourceId].revision, "1".repeat(40), "check must not advance the installed baseline");

  const updated = await harness.service.update({ sourceId });
  assert.equal(updated.action, "updated");
  snapshot = await harness.repository.readSnapshot();
  assert.equal(snapshot.skills["content-one"].content, "# One v2");
  assert.equal((await harness.service.list()).sources[0].modifiedCount, 0);
});

test("checking a locally modified current source offers restore without mutating it", async () => {
  const harness = createHarness();
  const bound = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  const sourceId = bound.source.id;
  const snapshot = await harness.repository.readSnapshot();
  snapshot.skills["content-one"] = { ...snapshot.skills["content-one"], content: "# Local" };
  await harness.repository.commitSnapshot({ ...snapshot, expected: await harness.repository.readSnapshot() });

  const checked = await harness.service.check({ sourceId });
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.remoteChanged, false);
  assert.equal(checked.repairAvailable, true);
  assert.equal(checked.changes.localModifiedCount, 1);
  assert.equal((await harness.repository.readSnapshot()).skills["content-one"].content, "# Local");
});

test("repository archives reject duplicate normalized skill names", async () => {
  const harness = createHarness();
  harness.imported = () => [skill("content-one", "# One"), skill("CONTENT ONE", "# Duplicate")];
  await assert.rejects(
    harness.service.bind({ repositoryUrl: REPOSITORY_URL }),
    error => error.code === "GIT_ARCHIVE_DUPLICATE_SKILL" && /名称唯一/.test(error.message),
  );
  assert.equal((await harness.repository.listSources()).length, 0);
});

test("initial name conflicts and later local edits require explicit overwrite", async () => {
  const existing = normalizeModernSkill({
    name: "content-one",
    description: "local",
    content: "# Local",
  });
  const harness = createHarness({ skills: { "content-one": existing } });
  const conflict = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "name_conflict");
  assert.equal((await harness.repository.listSources()).length, 0);

  const bound = await harness.service.bind({ repositoryUrl: REPOSITORY_URL, overwrite: true });
  assert.equal(bound.action, "bound");
  const sourceId = bound.source.id;
  const snapshot = await harness.repository.readSnapshot();
  snapshot.skills["content-one"] = {
    ...snapshot.skills["content-one"],
    content: "# Locally changed",
  };
  await harness.repository.commitSnapshot({ ...snapshot, expected: await harness.repository.readSnapshot() });
  harness.archiveVersion = 2;

  const localChanges = await harness.service.update({ sourceId });
  assert.equal(localChanges.ok, false);
  assert.equal(localChanges.code, "local_changes");
  assert.deepEqual(localChanges.conflicts.map(item => item.name), ["content-one"]);

  const updated = await harness.service.update({ sourceId, overwrite: true });
  assert.equal(updated.action, "updated");
  assert.equal((await harness.repository.readSnapshot()).skills["content-one"].content, "# One v2");
});

test("Git installs preserve siblings with the same title or a title equal to the installed ID", async () => {
  const neighbours = [
    normalizeModernSkill({ name: "sibling", displayName: "target", content: "keep" }),
    normalizeModernSkill({ name: "same-title", displayName: "Shared title", content: "keep too" }),
  ];
  const harness = createHarness({ skills: Object.fromEntries(neighbours.map(row => [row.name, row])) });
  harness.imported = () => [normalizeModernSkill({ name: "target", displayName: "Shared title", content: `version ${harness.archiveVersion}` })];
  const bound = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  assert.equal(bound.ok, true);
  for (const row of neighbours) assert.deepEqual((await harness.repository.readSnapshot()).skills[row.name], row);
  harness.archiveVersion = 2;
  assert.equal((await harness.service.update({ sourceId: bound.source.id })).ok, true);
  const { skills } = await harness.repository.readSnapshot();
  assert.equal(skills.target.content, "version 2");
  for (const row of neighbours) assert.deepEqual(skills[row.name], row);
});

test("repository updates remove deleted source skills and unbind keeps imported content", async () => {
  const harness = createHarness();
  const bound = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  const sourceId = bound.source.id;
  harness.archiveVersion = 2;
  harness.imported = () => [skill("content-one", "# One v2")];
  const updated = await harness.service.update({ sourceId });
  assert.equal(updated.action, "updated");
  assert.deepEqual(updated.removedNames, ["content-two"]);
  assert.equal((await harness.repository.readSnapshot()).skills["content-two"], undefined);

  const removed = await harness.service.remove({ sourceId });
  assert.equal(removed.action, "unbound");
  const snapshot = await harness.repository.readSnapshot();
  assert.equal(snapshot.sources[sourceId], undefined);
  assert.equal(snapshot.skills["content-one"].content, "# One v2");
  assert.equal(getGitSkillOrigin(snapshot.skills["content-one"]), null);
});

test("unbind cleanup deletes unchanged skills but preserves local modifications", async () => {
  const harness = createHarness();
  const bound = await harness.service.bind({ repositoryUrl: REPOSITORY_URL });
  const sourceId = bound.source.id;
  const snapshot = await harness.repository.readSnapshot();
  snapshot.skills["content-one"] = {
    ...snapshot.skills["content-one"],
    content: "# Locally changed",
  };
  await harness.repository.commitSnapshot({ ...snapshot, expected: await harness.repository.readSnapshot() });

  const removed = await harness.service.remove({ sourceId, deleteUnmodifiedSkills: true });
  assert.equal(removed.action, "unbound_and_cleaned");
  assert.equal(removed.deletedCount, 1);
  assert.equal(removed.preservedModifiedCount, 1);
  const after = await harness.repository.readSnapshot();
  assert.equal(after.skills["content-two"], undefined);
  assert.equal(after.skills["content-one"].content, "# Locally changed");
  assert.equal(getGitSkillOrigin(after.skills["content-one"]), null);
});

function createHarness({ skills = {}, repositoryProbe, downloadFromTab } = {}) {
  const state = { _skills: skills };
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])]));
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
    },
  };
  const repository = createGitSkillSourceRepository({ storage });
  const changes = [];
  const harness = {
    archiveVersion: 1,
    importOptions: [],
    imported: () => [skill("content-one", `# One v${harness.archiveVersion}`), skill("content-two", "# Two")],
  };
  const service = createGitSkillSourceService({
    repository,
    repositoryProbe: repositoryProbe || (async () => ({ archiveUrl: ARCHIVE_URL, branch: "main", revision: String(harness.archiveVersion).repeat(40), tabId: 77 })),
    downloadFromTab: downloadFromTab || (async () => new Uint8Array([0x50, 0x4b, harness.archiveVersion, 0x06]).buffer),
    importZip: async (_archive, importOptions) => {
      harness.importOptions.push(structuredClone(importOptions || {}));
      return harness.imported();
    },
    validateSkill: async () => ({ ok: true }),
    digest: async (buffer) => byteDigest(buffer),
    now: (() => {
      let tick = 0;
      return () => `2026-07-12 23:3${tick++}:00`;
    })(),
    onSkillsChanged: async event => changes.push(event),
  });
  return Object.assign(harness, { service, repository, changes });
}

function skill(name, content) {
  return normalizeModernSkill({ name, description: name, content });
}

function byteDigest(buffer) {
  const bytes = new Uint8Array(buffer);
  let value = 0;
  for (const byte of bytes) value = (value + byte) % 256;
  return value.toString(16).padStart(2, "0").repeat(32);
}
