import { expect, test } from "./fixtures.mjs";

async function showResultChoices(page, multiple = true) {
  await page.evaluate(multiple => {
    const f = window.waitFixture;
    f.entry = { ...f.entry, title: "Shortlist roles", message: "Choose the roles to research next.", form: {
      title: "Shortlist roles", submitLabel: "Research selected roles", fields: [{
        id: "selectedIds", label: "Open positions", type: multiple ? "multi_choice" : "single_choice", presentation: "cards",
        options: [
          { value: "job-1", label: "Backend engineer · Northstar", description: "Build distributed infrastructure for open-source projects.", meta: ["Remote · Europe", "€90–120k"], url: "https://example.com/jobs/1" },
          { value: "job-2", label: "Senior systems engineer · Cedar", description: "Own storage performance and reliability.", meta: ["Berlin / Remote", "Rust"], url: "https://example.com/jobs/2" },
          { value: "job-3", label: "Platform engineer · Signal Works", description: "Work on tools for small engineering teams.", meta: ["Remote", "Go · PostgreSQL"] },
        ],
      }],
    } };
    f.cards.patch(f.el, f.entry, "session-a");
  }, multiple);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.addStyleTag({ url: "/extension/sidepanel/sidepanel.css" });
  await page.evaluate(async () => {
    const { createWaitingCards } = await import("/extension/sidepanel/features/chat/transcript/waiting-card.js");
    document.body.innerHTML = '<div id="messages" style="width:430px;height:760px;position:relative;padding:20px"></div>';
    const state = { sessionId: "session-a", commands: [], sends: [] };
    const cards = createWaitingCards({
      isCurrentSession: id => id === state.sessionId,
      send(command) {
        state.commands.push(command);
        return new Promise((resolve, reject) => state.sends.push({ resolve, reject }));
      },
    });
    const entry = { type: "wait", waitId: "wait-a", runId: "run-a", status: "waiting", title: "确认方案", message: "请填写以下信息", form: {
      submitLabel: "确认", fields: [
        { id: "name", label: "名称", defaultValue: "原始名称" },
        { id: "notes", label: "备注", type: "textarea", required: false, default: "备注内容" },
        { id: "mode", label: "模式", type: "single_choice", defaultValue: "b", options: ["a", "b"] },
        { id: "items", label: "项目", type: "multi_choice", defaultValues: ["one"], options: ["one", "two"] },
      ],
    } };
    const el = cards.create(entry, state.sessionId);
    document.querySelector("#messages").append(el);
    window.waitFixture = { cards, state, entry, el };
  });
});

test("identical snapshots preserve draft, focus and selection, including legacy missing status", async ({ page }) => {
  const result = await page.evaluate(() => {
    const { cards, entry, el } = window.waitFixture;
    const input = el.querySelector('input[data-field-id="name"]');
    input.value = "用户正在编辑"; input.focus(); input.setSelectionRange(2, 5);
    cards.patch(el, { ...entry, status: undefined }, "session-a");
    cards.patch(el, { ...entry }, "session-a");
    return { same: input === el.querySelector('input[data-field-id="name"]'), focused: document.activeElement === input,
      value: input.value, selection: [input.selectionStart, input.selectionEnd] };
  });
  expect(result).toEqual({ same: true, focused: true, value: "用户正在编辑", selection: [2, 5] });
});

test("result cards validate, preserve selection, lock during submit and recover after transport failure", async ({ page }) => {
  await showResultChoices(page);
  await expect(page.locator('.waiting-hint')).toBeHidden();
  const first = page.locator('.qz-choice-card input[value="job-1"]');
  const second = page.locator('.qz-choice-card input[value="job-2"]');
  await expect(page.locator('[data-choice-count]')).toHaveText("已选 0 项");
  await page.locator('[data-wait-action="continue"]').click();
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-invalid", "true");
  await first.press("Space");
  await second.check();
  await expect(page.locator('[data-choice-count]')).toHaveText("已选 2 项");
  await page.evaluate(() => {
    const f = window.waitFixture;
    f.cards.patch(f.el, structuredClone(f.entry), "session-a");
  });
  await expect(first).toBeChecked();
  await expect(second).toBeChecked();
  await page.locator('[data-wait-action="continue"]').click();
  await expect(first).toBeDisabled();
  expect(await page.evaluate(() => window.waitFixture.state.commands[0].payload.answers)).toEqual({ selectedIds: ["job-1", "job-2"] });
  await page.evaluate(() => window.waitFixture.state.sends[0].reject(new Error("port disconnected")));
  await expect(page.locator('.waiting-hint')).toBeVisible();
  await expect(page.locator('.waiting-hint')).toContainText("失败，请重试");
  await expect(first).toBeEnabled();
  await expect(first).toBeChecked();
  await second.uncheck();
  await page.locator('[data-wait-action="continue"]').click();
  expect(await page.evaluate(() => window.waitFixture.state.commands[1].payload.answers)).toEqual({ selectedIds: ["job-1"] });
  await page.evaluate(() => {
    const f = window.waitFixture;
    f.cards.patch(f.el, { ...f.entry, status: "submitted" }, "session-a");
    f.state.sends[1].resolve();
  });
  await expect(page.locator('.qz-choice-card')).toHaveCount(0);
  await expect(page.locator('[data-wait-action]')).toHaveCount(0);
});

test("single result choice submits one stable ID and cancellation submits no answer", async ({ page }) => {
  await showResultChoices(page, false);
  await page.locator('.qz-choice-card input[value="job-1"]').check();
  await page.locator('.qz-choice-card input[value="job-2"]').check();
  await expect(page.locator('.qz-choice-card input[value="job-1"]')).not.toBeChecked();
  await page.locator('[data-wait-action="continue"]').click();
  expect(await page.evaluate(() => window.waitFixture.state.commands[0].payload.answers)).toEqual({ selectedIds: "job-2" });
  await page.evaluate(() => {
    const f = window.waitFixture;
    f.cards.patch(f.el, { ...f.entry, waitId: "next-wait" }, "session-a");
  });
  await page.locator('[data-wait-action="cancel"]').click();
  expect(await page.evaluate(() => window.waitFixture.state.commands[1])).toEqual({ type: "cancel_wait", sessionId: "session-a", waitId: "next-wait" });
});

test("long result lists scroll within the card and keep counts and actions below the list", async ({ page }) => {
  await showResultChoices(page);
  await page.evaluate(() => {
    const f = window.waitFixture;
    const field = f.entry.form.fields[0];
    field.label = f.entry.form.title;
    f.entry.message = f.entry.form.title;
    field.options = Array.from({ length: 12 }, (_, index) => ({
      ...field.options[index % 3], value: `job-${index + 1}`, label: `Role ${index + 1} · Distributed systems engineer`,
    }));
    document.querySelector('#messages').style.cssText = 'width:320px;padding:8px';
    f.cards.patch(f.el, f.entry, "session-a");
  });
  await expect(page.locator('.waiting-field-label')).toHaveCount(0);
  await expect(page.locator('.waiting-message')).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const list = document.querySelector('.waiting-options');
    return { scrolls: list.scrollHeight > list.clientHeight, listBottom: list.getBoundingClientRect().bottom,
      countTop: document.querySelector('[data-choice-count]').getBoundingClientRect().top,
      actionTop: document.querySelector('.waiting-actions').getBoundingClientRect().top };
  });
  expect(geometry.scrolls).toBe(true);
  expect(geometry.countTop).toBeGreaterThanOrEqual(geometry.listBottom);
  expect(geometry.actionTop).toBeGreaterThan(geometry.countTop);
  await page.locator('.qz-choice-card input[value="job-12"]').check();
  await page.locator('[data-wait-action="continue"]').click();
  expect(await page.evaluate(() => window.waitFixture.state.commands[0].payload.answers)).toEqual({ selectedIds: ["job-12"] });
});

for (const scheme of ["light", "dark"]) {
  test(`result cards follow all reading sizes in a narrow ${scheme} form`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.route("https://example.com/role.svg", route => route.fulfill({
      contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path fill="#888" d="M0 0h40v40H0z"/></svg>',
    }));
    await showResultChoices(page);
    await page.evaluate(() => {
      const f = window.waitFixture;
      document.querySelector('#messages').style.cssText = 'width:320px;padding:8px';
      f.entry.form.fields[0].options[0].imageUrl = "https://example.com/role.svg";
      f.cards.patch(f.el, f.entry, "session-a");
    });
    const first = page.locator('.qz-choice-card input[value="job-1"]');
    await first.check();
    for (const [level, scale] of [["small", 0.875], ["compact", 0.9], ["standard", 1], ["comfortable", 1.1], ["large", 1.25], ["xlarge", 15.5 / 12]]) {
      await page.locator('#messages').evaluate((el, size) => { el.dataset.chatTextSize = size; }, level);
      await expectResultCardTypography(page.locator('.qz-choice-card').first(), scale);
      await expect(first).toBeChecked();
      // Reading size changes content; action controls keep the shared small-button size.
      await expect(page.locator('[data-wait-action="continue"]')).toHaveCSS('font-size', '11px');
      expect(await page.locator('.waiting-card').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }

    await page.locator('#messages').screenshot({ path: testInfo.outputPath(`choice-reading-size-${scheme}.png`) });
    await page.locator('[data-wait-action="continue"]').click();
    await expect(first).toBeDisabled();
    await expectResultCardTypography(page.locator('.qz-choice-card').first(), 15.5 / 12);
    await page.evaluate(() => {
      const f = window.waitFixture;
      f.cards.patch(f.el, { ...f.entry, status: "submitted" }, "session-a");
      f.state.sends[0].resolve();
    });
    await expect(page.locator('.waiting-title')).toHaveCSS('font-size', '15.5px');
    await page.evaluate(() => {
      const f = window.waitFixture;
      f.cards.reset();
      f.el = f.cards.create(JSON.parse(JSON.stringify(f.entry)), "session-a");
      document.querySelector('#messages').replaceChildren(f.el);
    });
    await expectResultCardTypography(page.locator('.qz-choice-card').first(), 15.5 / 12);

    // The reusable control keeps its theme defaults outside the conversation.
    await page.evaluate(async () => {
      const { renderResultChoice } = await import("/extension/sidepanel/ui/result-choice.js");
      const option = window.waitFixture.entry.form.fields[0].options[0];
      const control = renderResultChoice(document, { ...option, id: "standalone-choice", name: "standalone", checked: false });
      control.id = "standalone-control";
      document.body.append(control);
    });
    await expectResultCardTypography(page.locator('#standalone-control'), 1);
  });

  test(`result selection fits a 320px ${scheme} panel with visible action and translated count`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await showResultChoices(page);
    await page.evaluate(async () => {
      const { withLanguage } = await import("/extension/shared/i18n/index.js");
      const f = window.waitFixture;
      document.querySelector('#messages').style.cssText = 'width:320px;padding:8px';
      withLanguage("en", () => f.cards.patch(f.el, { ...f.entry, waitId: "en-wait" }, "session-a"));
    });
    await expect(page.locator('[data-choice-count]')).toHaveText("Selected: 0");
    const geometry = await page.locator('.waiting-card').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    await expect(page.locator('[data-wait-action="continue"]')).toBeVisible();
    await page.locator('#messages').screenshot({ path: testInfo.outputPath(`selection-wait-${scheme}.png`) });
  });
}

async function expectResultCardTypography(card, scale) {
  const styles = await card.evaluate(el => {
    const sizes = Object.fromEntries(['title', 'description', 'tag', 'source'].map(part => {
      const style = getComputedStyle(el.querySelector(`.qz-choice-card-${part}`));
      return [part, { size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) }];
    }));
    return { sizes, overflow: el.scrollWidth - el.clientWidth, imageWidth: el.querySelector('img')?.getBoundingClientRect().width };
  });
  for (const [part, style] of Object.entries(styles.sizes)) {
    expect(style.size).toBeCloseTo((part === 'title' ? 13 : 11.5) * scale, 2);
    expect(style.lineHeight).toBeCloseTo(18 * scale, 2);
  }
  expect(styles.overflow).toBeLessThanOrEqual(1);
  expect(styles.imageWidth).toBe(40);
}

test("required fields validate before sending and form submission delivers all typed answers once", async ({ page }) => {
  const name = page.locator('input[data-field-id="name"]');
  await name.fill("");
  await page.locator('[data-wait-action="continue"]').click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([]);
  await name.fill(" 新名称 ");
  await expect(name).not.toHaveAttribute("aria-invalid");
  await page.locator('input[value="two"]').check();
  await page.evaluate(() => {
    const { el, cards, entry } = window.waitFixture;
    el.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    cards.patch(el, structuredClone(entry), "session-a");
    // dispatchEvent deliberately bypasses disabled-button click suppression.
    el.querySelector('[data-wait-action="continue"]').dispatchEvent(new Event("click"));
    el.querySelector('[data-wait-action="cancel"]').dispatchEvent(new Event("click"));
  });
  expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([{
    type: "continue_task", sessionId: "session-a", waitId: "wait-a",
    payload: { submitted: true, reason: "submitted", answers: { name: "新名称", notes: "备注内容", mode: "b", items: ["one", "two"] } },
  }]);
  await expect(page.locator('[data-wait-action="continue"]')).toBeDisabled();
  await page.evaluate(() => window.waitFixture.state.sends[0].resolve());
  await expect(page.locator('[data-wait-action="continue"]')).toBeDisabled();
});

for (const action of ["continue", "cancel"]) {
  test(`${action} transport failure keeps the draft and allows retry`, async ({ page }) => {
    await page.locator('input[data-field-id="name"]').fill("保留草稿");
    await page.locator(`[data-wait-action="${action}"]`).click();
    await page.evaluate(() => window.waitFixture.state.sends[0].reject(new Error("port disconnected")));
    await expect(page.locator(".waiting-hint")).toContainText("失败，请重试");
    await expect(page.locator('input[data-field-id="name"]')).toHaveValue("保留草稿");
    await expect(page.locator(`[data-wait-action="${action}"]`)).toBeEnabled();
    await page.locator(`[data-wait-action="${action}"]`).click();
    expect(await page.evaluate(() => window.waitFixture.state.commands.length)).toBe(2);
  });
}

for (const cleanup of ["removed", "dispose", "forgetSession", "reset", "switch", "replace"]) {
  test(`${cleanup} blocks late delivery failure and detached handlers`, async ({ page }) => {
    await page.locator('[data-wait-action="continue"]').click();
    const result = await page.evaluate(async cleanup => {
      const { el, cards, state, entry } = window.waitFixture;
      const oldButton = el.querySelector('[data-wait-action="cancel"]');
      if (cleanup === "removed") el.remove();
      if (cleanup === "dispose") cards.dispose(el);
      if (cleanup === "forgetSession") cards.forgetSession("session-a");
      if (cleanup === "reset") cards.reset();
      if (cleanup === "switch") state.sessionId = "session-b";
      if (cleanup === "replace") cards.patch(el, { ...entry, waitId: "new-wait", status: "submitted" }, "session-a");
      const before = el.innerHTML;
      state.sends[0].reject(new Error("late failure"));
      await Promise.resolve(); await Promise.resolve();
      oldButton.dispatchEvent(new Event("click"));
      return { unchanged: before === el.innerHTML, count: state.commands.length };
    }, cleanup);
    expect(result).toEqual({ unchanged: true, count: 1 });
  });
}

test("a new wait identity resets its draft and revokes the previous card's actions", async ({ page }) => {
  await page.locator('input[data-field-id="name"]').fill("旧草稿");
  const result = await page.evaluate(() => {
    const { cards, el, entry, state } = window.waitFixture;
    const old = el.querySelector('[data-wait-action="continue"]');
    cards.patch(el, { ...entry, waitId: "next-wait" }, "session-a");
    old.dispatchEvent(new Event("click"));
    el.querySelector('[data-wait-action="continue"]').click();
    return { commands: state.commands, name: el.querySelector('input[data-field-id="name"]').value };
  });
  expect(result.name).toBe("原始名称");
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0].waitId).toBe("next-wait");
});

for (const scheme of ["light", "dark"]) {
  test(`${scheme} cards preserve form controls and every terminal status uses the summary lane`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const result = await page.evaluate(() => {
      const { cards, el, entry } = window.waitFixture;
      const geometry = [...el.querySelectorAll("input, textarea, button")].map(node => {
        const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
      });
      const active = { lane: el.dataset.chatLane, className: el.className };
      const statuses = ["submitted", "cancelled", "aborted", "superseded", "stale", "unknown-terminal"].map(status => {
        cards.patch(el, { ...entry, status }, "session-a");
        return { status, lane: el.dataset.chatLane, className: el.className, actions: el.querySelectorAll("button, form").length };
      });
      return { geometry, active, statuses };
    });
    expect(result.geometry.every(rect => rect.width > 0 && rect.height > 0)).toBe(true);
    expect(result.active).toEqual({ lane: "detail", className: "msg msg-waiting waiting-active" });
    for (const state of result.statuses) expect(state).toMatchObject({ lane: "summary", className: "msg msg-waiting waiting-resolved", actions: 0 });
  });
}


test("defaults render into their native controls without allowing field data to become markup", async ({ page }) => {
  await expect(page.locator('input[data-field-id="name"]')).toHaveValue("原始名称");
  await expect(page.locator('textarea')).toHaveValue("备注内容");
  await expect(page.locator('input[value="b"]')).toBeChecked();
  await expect(page.locator('input[value="a"]')).not.toBeChecked();
  await expect(page.locator('input[value="one"]')).toBeChecked();
  await expect(page.locator('input[value="two"]')).not.toBeChecked();
  const result = await page.evaluate(() => {
    const { cards, el, entry, state } = window.waitFixture;
    const literal = '\" autofocus data-injected=\"true <img src=x> &';
    cards.patch(el, { ...entry, form: { fields: [
      { id: literal, label: literal, defaultValue: literal, placeholder: literal, help: literal },
      { id: "__proto__", defaultValue: "safe answer" },
      { id: "choice", type: "single_choice", default: literal, options: [{ value: literal, label: literal, description: literal }] },
    ] } }, "session-a");
    el.querySelector('[data-wait-action="continue"]').click();
    const answers = state.commands[0].payload.answers;
    return { injected: el.querySelectorAll("[data-injected], img").length,
      answer: answers[literal], choice: answers.choice, proto: Object.hasOwn(answers, "__proto__") && answers.__proto__ };
  });
  expect(result).toEqual({ injected: 0, answer: '\" autofocus data-injected=\"true <img src=x> &',
    choice: '\" autofocus data-injected=\"true <img src=x> &', proto: "safe answer" });
});

test("choice validation clears on change and empty forms send a plain continue command", async ({ page }) => {
  await page.evaluate(() => {
    const { el } = window.waitFixture;
    el.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(input => { input.checked = false; });
  });
  await page.locator('[data-wait-action="continue"]').click();
  await expect(page.locator('.waiting-field.invalid')).toHaveCount(2);
  await expect(page.locator('input[value="a"]')).toBeFocused();
  await page.locator('input[value="a"]').check();
  await page.locator('input[value="one"]').check();
  await expect(page.locator('.waiting-field.invalid')).toHaveCount(0);
  await page.evaluate(() => {
    const { cards, el, entry } = window.waitFixture;
    cards.patch(el, { ...entry, form: null }, "session-a");
    el.querySelector('[data-wait-action="continue"]').click();
  });
  expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([
    { type: "continue_task", sessionId: "session-a", waitId: "wait-a" },
  ]);
});

for (const outcome of ["grant", "deny", "error", "dispose", "switch", "resolve"]) {
  test(`browser permission card: ${outcome}`, async ({ page }) => {
    await page.evaluate(() => {
      const f = window.waitFixture;
      window.chrome ??= {};
      chrome.permissions = { request(input) {
        f.permissionRequest = { input, userGesture: navigator.userActivation.isActive };
        return new Promise((resolve, reject) => { f.permissionReply = { resolve, reject }; });
      } };
      f.entry = { ...f.entry, form: { browserPermission: "history" } };
      f.cards.patch(f.el, f.entry, "session-a");
    });
    const button = page.locator('[data-wait-action="continue"]');
    await button.click();
    expect(await page.evaluate(() => window.waitFixture.permissionRequest)).toEqual({ input: { permissions: ["history"] }, userGesture: true });
    expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([]);
    await expect(button).toBeDisabled();
    await page.evaluate(outcome => {
      const f = window.waitFixture;
      if (outcome === "dispose") f.cards.dispose(f.el);
      if (outcome === "switch") f.state.sessionId = "session-b";
      if (outcome === "resolve") f.cards.patch(f.el, { ...f.entry, status: "aborted" }, "session-a");
      if (outcome === "error") f.permissionReply.reject(new Error("permission service unavailable"));
      else f.permissionReply.resolve(outcome !== "deny");
    }, outcome);
    if (outcome === "error") {
      await expect(button).toBeEnabled();
      await button.click();
      await page.evaluate(() => window.waitFixture.permissionReply.resolve(true));
    }
    expect(await page.evaluate(() => window.waitFixture.state.commands.map(command => command.type)))
      .toEqual(["grant", "error"].includes(outcome) ? ["continue_task"] : outcome === "deny" ? ["cancel_wait"] : []);
  });
}

test("location consent is saved before continuing, with retry on save failure", async ({ page }) => {
  await page.evaluate(() => {
    const { cards, el, entry } = window.waitFixture;
    window.__locationConsentRequests = [];
    window.chrome = { runtime: { sendMessage: async message => {
      window.__locationConsentRequests.push(message);
      return { ok: window.__locationConsentRequests.length > 1, accepted: true };
    } } };
    cards.patch(el, { ...entry, form: { locationConsent: true, title: "允许获取位置？" } }, "session-a");
  });
  await expect(page.locator('[data-wait-action="continue"]')).toHaveText("同意并继续");
  await page.locator('[data-wait-action="continue"]').click();
  await expect(page.locator('[data-wait-action="continue"]')).toBeEnabled();
  expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([]);
  await page.locator('[data-wait-action="continue"]').click();
  expect(await page.evaluate(() => window.__locationConsentRequests)).toHaveLength(2);
  expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([{ type: "continue_task", sessionId: "session-a", waitId: "wait-a" }]);
});

for (const kind of ["bookmarks", "history", "location"]) {
  test(`${kind} approval translates persisted copy when rendered in another language`, async ({ page }) => {
    const original = await page.evaluate(async kind => {
      const { withLanguage } = await import("/extension/shared/i18n/index.js");
      const { t } = await import("/extension/shared/i18n/backend.js");
      const { permissionT } = await import("/extension/shared/browser-permissions.js");
      const f = window.waitFixture;
      f.entry = withLanguage("zh-CN", () => ({
        type: "wait", waitId: "approval", runId: "run-a", status: "waiting",
        message: kind === "location" ? t("locationDisclosure") : permissionT(kind),
        form: kind === "location" ? { locationConsent: true, title: t("locationTitle") }
          : { browserPermission: kind, title: permissionT("title") },
      }));
      withLanguage("zh-CN", () => f.cards.patch(f.el, f.entry, "session-a"));
      return JSON.stringify(f.entry);
    }, kind);
    await expect(page.locator(".waiting-message")).toHaveText(JSON.parse(original).message);
    await page.evaluate(async () => {
      const { withLanguage } = await import("/extension/shared/i18n/index.js");
      const f = window.waitFixture;
      withLanguage("en", () => f.cards.patch(f.el, f.entry, "session-a"));
    });
    await expect(page.locator(".waiting-title")).toHaveText(kind === "location" ? "Use your location?" : "Browser permission required");
    await expect(page.locator(".waiting-message")).toContainText("configured model service");
    await expect(page.locator(".waiting-message")).not.toContainText(JSON.parse(original).message);
    await expect(page.locator('[data-wait-action="continue"]')).toHaveText(kind === "location" ? "Agree and continue" : "Allow and continue");
    const englishMessage = await page.locator(".waiting-message").textContent();
    for (const [status, title] of [["submitted", "Resumed"], ["cancelled", "Canceled"]]) {
      await page.evaluate(async status => {
        const { withLanguage } = await import("/extension/shared/i18n/index.js");
        const f = window.waitFixture;
        f.cards.reset();
        const restored = JSON.parse(JSON.stringify({ ...f.entry, status }));
        f.el = withLanguage("en", () => f.cards.create(restored, "session-a"));
        document.querySelector("#messages").replaceChildren(f.el);
      }, status);
      await expect(page.locator(".waiting-title")).toHaveText(title);
      await expect(page.locator(".waiting-message")).toHaveText(englishMessage);
      await expect(page.locator(".waiting-actions")).toHaveCount(0);
    }
    expect(await page.evaluate(() => JSON.stringify(window.waitFixture.entry))).toBe(original);
    expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([]);
  });
}

test("debugger detach card translates persisted copy and sends continue or stop commands", async ({ page }) => {
  await page.evaluate(async () => {
    const { withLanguage } = await import("/extension/shared/i18n/index.js");
    const { debuggerDetachT } = await import("/extension/shared/debugger-detach.js");
    const f = window.waitFixture;
    f.entry = withLanguage("zh-CN", () => ({
      type: "wait", waitId: "detach-wait", runId: "run-a", status: "waiting",
      message: debuggerDetachT("message"),
      form: { debuggerDetached: true, title: debuggerDetachT("title") },
    }));
    withLanguage("zh-CN", () => f.cards.patch(f.el, f.entry, "session-a"));
  });
  await expect(page.locator(".waiting-title")).toHaveText("已断开调试");
  await expect(page.locator(".waiting-message")).toHaveText("你关闭了「正在调试此浏览器」提示，调试连接已断开。要继续这个任务吗？");
  await expect(page.locator('[data-wait-action="continue"]')).toHaveText("继续");
  await expect(page.locator('[data-wait-action="cancel"]')).toHaveText("停止");
  await expect(page.locator(".waiting-hint")).toHaveCount(0);

  await page.evaluate(async () => {
    const { withLanguage } = await import("/extension/shared/i18n/index.js");
    const f = window.waitFixture;
    withLanguage("en", () => f.cards.patch(f.el, f.entry, "session-a"));
  });
  await expect(page.locator(".waiting-title")).toHaveText("Debugging disconnected");
  await expect(page.locator(".waiting-message")).toContainText("debugging this browser");
  await expect(page.locator('[data-wait-action="continue"]')).toHaveText("Continue");
  await expect(page.locator('[data-wait-action="cancel"]')).toHaveText("Stop");

  await page.locator('[data-wait-action="cancel"]').click();
  expect(await page.evaluate(() => window.waitFixture.state.commands)).toEqual([
    { type: "cancel_wait", sessionId: "session-a", waitId: "detach-wait" },
  ]);
  await page.evaluate(() => window.waitFixture.state.sends[0].reject(new Error("port disconnected")));
  await page.locator('[data-wait-action="continue"]').click();
  expect(await page.evaluate(() => window.waitFixture.state.commands[1])).toEqual(
    { type: "continue_task", sessionId: "session-a", waitId: "detach-wait" },
  );
});

test("language changes preserve model-authored questions and form labels", async ({ page }) => {
  await page.evaluate(async () => {
    const { withLanguage } = await import("/extension/shared/i18n/index.js");
    const f = window.waitFixture;
    f.cards.reset();
    f.el = withLanguage("en", () => f.cards.create(JSON.parse(JSON.stringify(f.entry)), "session-a"));
    document.querySelector("#messages").replaceChildren(f.el);
  });
  await expect(page.locator(".waiting-title")).toHaveText("确认方案");
  await expect(page.locator(".waiting-message")).toHaveText("请填写以下信息");
  await expect(page.locator('[data-wait-action="continue"]')).toHaveText("确认");
  await expect(page.locator('input[data-field-id="name"]')).toHaveValue("原始名称");
  await expect(page.locator('[data-wait-action="cancel"]')).toHaveText("Cancel");
});
