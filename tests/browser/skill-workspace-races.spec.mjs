import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.add("hidden"));
    document.querySelector("#skills-panel").classList.remove("hidden");
    const { normalizeModernSkill } = await import("/extension/shared/skills/skill-utils.js");
    const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
    const alpha = normalizeModernSkill({ name: "alpha", description: "Alpha skill", content: "original" });
    const beta = normalizeModernSkill({ name: "beta", description: "Beta skill", content: "second" });
    const storage = createMemoryStorage({ _skills: { alpha, beta } });
    const tabListeners = new Set();
    const tabEvent = () => ({ addListener: listener => tabListeners.add(listener), removeListener: listener => tabListeners.delete(listener) });
    globalThis.chrome = { storage: { local: storage }, tabs: { query: async () => [], onUpdated: tabEvent(), onActivated: tabEvent() } };
    const { createSkillStateRepository } = await import("/extension/background/skills/skill-repository.js");
    const { createSkillWorkspaceService } = await import("/extension/background/skills/skill-workspace.js");
    const repository = createSkillStateRepository({ storage });
    const gates = [];
    const workspace = createSkillWorkspaceService({ repository, prepare: async () => {}, validate: async () => {}, onChanged: async () => {} });
    const { createSkillsFeature } = await import("/extension/capabilities/skills/workspace/skills-feature.js");
    const calls = [], toasts = [];
    const lifetime = new AbortController();
    const featureOptions = {
      signal: lifetime.signal, root: document, isActive: () => true, showToast: message => toasts.push(message), confirm: async () => true,
      request: async (type, payload) => {
        calls.push({ type, payload: structuredClone(payload) });
        if (type === "get_skill_workspace") return workspace.read();
        if (type === "save_workspace_skill") {
          await new Promise((resolve, reject) => gates.push({ resolve, reject }));
          return workspace.save(payload);
        }
        if (type === "delete_workspace_skill") return workspace.remove(payload);
        if (type === "import_workspace_skills") return workspace.import(payload);
        return {};
      },
    };
    const feature = createSkillsFeature(featureOptions);
    await feature.activate();
    feature.showDetail("alpha");
    window.__skillsTest = {
      feature, calls, toasts, storage, lifetime, tabListeners,
      async remount() {
        const nextLifetime = new AbortController();
        const next = createSkillsFeature({ ...featureOptions, signal: nextLifetime.signal });
        await next.activate();
        next.showDetail("alpha");
        return next;
      },
      resolveSave: () => gates.shift().resolve(),
      rejectSave: () => gates.shift().reject(new Error("temporary storage failure")),
      async competingWrite() {
        const before = await repository.read();
        await repository.commit(before, { _skills: { ...before._skills, alpha: normalizeModernSkill({ ...alpha, content: "Agent update" }) } });
      },
    };
  });
  await page.locator("#btn-edit-skill").click();
});

test("loaded extension creates and imports a Skill whose ID is another Skill's display name", async () => {
  test.setTimeout(90_000);
  const { launchIsolatedExtensionMcp, extensionRequest, assertNoUnexpectedDiagnostics } = await import("../support/isolated-extension-mcp.mjs");
  const { callTool } = await import("../../services/mcp-bridge/src/client.mjs");
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-skill-create-identity-" });
  try {
    const page = environment.page;
    const seed = await page.evaluate(async () => {
      const { normalizeModernSkill } = await import(chrome.runtime.getURL("shared/skills/skill-utils.js"));
      return normalizeModernSkill({
        name: "rt6", displayName: "rt5", description: "Existing skill", content: "Keep rt6 unchanged",
        metadata: { privateMarker: "rt6-only" }, createdAt: "2026-01-01 00:00:00",
        resources: [{ path: "notes.md", content: "rt6 resource" }],
      });
    });
    const seeded = await extensionRequest(page, "save_workspace_skill", { name: "rt6", skill: seed, expected: null }, "skill_workspace_saved");
    expect(seeded.registryReady).toBe(true);
    const rt6 = seeded.skill;
    const { sessionId } = await callTool(environment.bridge.endpoint, "qingzhou_create_drive_session", { title: "Skill identity regression" });
    const execute = (name, args) => callTool(environment.bridge.endpoint, "qingzhou_execute_tool", { sessionId, name, args, timeoutSeconds: 30 });
    const loaded = await execute("load_skill", { name: "skill-workbench" });
    expect(loaded.result.name).toBe("skill-workbench");
    const created = await extensionRequest(page, "save_workspace_skill", {
      name: "rt5",
      expected: null,
      skill: { name: "rt5", description: "New skill", content: "New rt5 body" },
    }, "skill_workspace_saved");
    expect(created.skill.name).toBe("rt5");
    expect(created.skill.content).toBe("New rt5 body");
    const stored = await page.evaluate(async () => (await chrome.storage.local.get("_skills"))._skills);
    expect(stored.rt6).toEqual(rt6);
    expect(stored.rt5.content).toBe("New rt5 body");
    expect(stored.rt5.metadata).toEqual({});
    expect(stored.rt5.resources).toEqual([]);
    expect(stored.rt5.createdAt).not.toBe(rt6.createdAt);

    // Start the sidebar import with the same QA state: only rt6, titled rt5.
    const removed = await extensionRequest(page, "delete_workspace_skill", { name: "rt5", expected: stored.rt5 }, "skill_workspace_deleted");
    expect(removed.ok).toBe(true);
    await page.locator('[data-tab="skills"]').click();
    const archive = await page.evaluate(async () => {
      const { exportSkillsZip } = await import(chrome.runtime.getURL("shared/skills/skill-package.js"));
      const blob = await exportSkillsZip([{ name: "rt5", description: "Imported skill", content: "Imported rt5 body" }]);
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await page.locator("#skills-import-file").setInputFiles({ name: "rt5.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
    await expect(page.locator('.skill-card[data-name="rt5"]')).toBeVisible();
    const imported = await page.evaluate(async () => (await chrome.storage.local.get("_skills"))._skills);
    expect(imported.rt6).toEqual(rt6);
    expect(imported.rt5.content).toBe("Imported rt5 body");
    expect(imported.rt5.metadata.privateMarker).toBeUndefined();
    expect(imported.rt5.resources).toEqual([]);
    expect(imported.rt5.createdAt).not.toBe(rt6.createdAt);
    assertNoUnexpectedDiagnostics(environment.diagnostics);
  } finally {
    await environment.close();
  }
});

async function save(page, value) {
  await page.locator("#skill-body-text").fill(value);
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBeGreaterThan(0);
}

test("deleting a selected ID preserves siblings sharing its title or using that ID as a title", async ({ page }) => {
  await page.evaluate(async () => {
    const { normalizeModernSkill } = await import("/extension/shared/skills/skill-utils.js");
    const state = window.__skillsTest;
    const rows = [
      normalizeModernSkill({ name: "alpha", displayName: "beta", content: "keep alpha" }),
      normalizeModernSkill({ name: "gamma", displayName: "Shared title", content: "keep gamma" }),
      normalizeModernSkill({ name: "beta", displayName: "Shared title", content: "delete beta" }),
    ];
    await state.storage.set({ _skills: Object.fromEntries(rows.map(row => [row.name, row])) });
    state.lifetime.abort();
    state.feature = await state.remount();
    state.feature.showDetail("beta");
  });
  await expect(page.locator("#skill-detail-name")).toHaveText("Shared title");
  await page.locator("#btn-skill-actions").click();
  await page.locator("#btn-delete-skill").click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.__skillsTest.storage.snapshot()._skills))).toEqual(["alpha", "gamma"]);
  expect(await page.evaluate(() => {
    const call = window.__skillsTest.calls.find(call => call.type === "delete_workspace_skill");
    return { name: call.payload.name, expected: call.payload.expected.name };
  })).toEqual({ name: "beta", expected: "beta" });
});

test("saving preserves newer edits and uses the saved snapshot for the next save", async ({ page }) => {
  await save(page, "first edit");
  await page.locator("#skill-body-text").fill("newer edit");
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
  await expect(page.locator("#skill-body-text")).toHaveValue("newer edit");
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("first edit");
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBe(2);
  expect(await page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill")[1].payload.expected.content)).toBe("first edit");
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeDisabled();
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("newer edit");
});

test("a late save cannot replace the newly opened Skill editor", async ({ page }) => {
  await save(page, "saved alpha");
  await page.evaluate(() => window.__skillsTest.feature.showDetail("beta"));
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#skill-detail-name")).toHaveText("beta");
  await expect(page.locator("#skill-body-text")).toHaveValue("second");
  await expect.poll(() => page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("saved alpha");
});

test("a competing Agent write rejects the stale draft without losing either value", async ({ page }) => {
  await save(page, "local draft");
  await page.evaluate(async () => { await window.__skillsTest.competingWrite(); window.__skillsTest.resolveSave(); });
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
  await expect(page.locator("#skill-body-text")).toHaveValue("local draft");
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("Agent update");
  expect(await page.evaluate(() => window.__skillsTest.toasts.join("\n"))).toContain("已被其他操作修改");
});

test("a failed save retains the draft and a subsequent retry succeeds", async ({ page }) => {
  await save(page, "retry me");
  await page.evaluate(() => window.__skillsTest.rejectSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
  await expect(page.locator("#skill-body-text")).toHaveValue("retry me");
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBe(2);
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeDisabled();
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("retry me");
});


test("disposing Skills isolates late saves and releases browser listeners before remount", async ({ page }) => {
  await save(page, "persisted by the old mount");
  expect(await page.evaluate(() => window.__skillsTest.tabListeners.size)).toBe(2);
  await page.evaluate(async () => {
    const state = window.__skillsTest;
    state.lifetime.abort();
    state.listenersAfterAbort = state.tabListeners.size;
    state.feature = await state.remount();
  });
  expect(await page.evaluate(() => window.__skillsTest.listenersAfterAbort)).toBe(0);
  expect(await page.evaluate(() => window.__skillsTest.tabListeners.size)).toBe(2);
  await page.locator("#btn-edit-skill").click();
  await page.locator("#skill-body-text").fill("draft in the new mount");
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect.poll(() => page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("persisted by the old mount");
  await expect(page.locator("#skill-body-text")).toHaveValue("draft in the new mount");
  await expect(page.locator("#skill-detail")).not.toHaveClass(/has-error/);
  expect(await page.evaluate(() => window.__skillsTest.toasts)).toEqual([]);
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBe(2);
  await page.evaluate(() => window.__skillsTest.rejectSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
});
