import { expect, test } from "./fixtures.mjs";

test("a new tool contributes summaries and parameters without modifying the tool host", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { toolPresentationRegistry } = await import("/extension/sidepanel/tools/tool-presentation.js");
    const unregister = toolPresentationRegistry.register({
      id: "fixture.weather",
      argsSummary: ({ args }) => `(${args.city} · weather)`,
      describeRun: ({ args }) => `Forecast for ${args.city}`,
      compactParams: ({ args }) => ({ city: args.city }),
    });
    try {
      return [false, true].map(staticOutput => {
        const root = renderToolEvent({ name: "new_weather_tool_42", rendererId: "fixture.weather",
          args: { city: "杭州", implementationOption: "hidden-parameter" }, result: { temperature: 21 } },
        { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.replaceChildren(root);
        const snapshot = { staticOutput, summary: root.querySelector(".tool-args-preview").textContent,
          description: root.querySelector(".tool-compact-title").textContent,
          params: root.querySelector(".tool-chip-row").textContent,
          fallback: root.querySelectorAll(".tool-renderer-fallback").length };
        disposeRendererTree(root);
        return snapshot;
      });
    } finally { unregister(); }
  });
  for (const snapshot of snapshots) {
    expect(snapshot.summary).toBe("(杭州 · weather)");
    expect(snapshot.description).toBe("Forecast for 杭州");
    expect(snapshot.params).toContain("杭州");
    expect(snapshot.params).not.toContain("hidden-parameter");
    expect(snapshot.fallback).toBe(0);
  }
});

test("throwing or malformed presentation callbacks preserve generic live and static output", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { toolPresentationRegistry } = await import("/extension/sidepanel/tools/tool-presentation.js");
    const snapshots = [];
    for (const failure of ["throw", "invalid", "promise", "rejected-promise", "thenable"]) {
      const args = { query: "retained query", marker: "retained parameter" };
      const bad = () => {
        if (failure === "throw") throw new Error("broken capability");
        if (failure === "promise") return Promise.resolve({ wrong: "async parameters" });
        if (failure === "rejected-promise") return Promise.reject(new Error("async callback failed"));
        if (failure === "thenable") return { then() {}, wrong: "thenable parameters" };
        return [];
      };
      const unregister = toolPresentationRegistry.register({ id: "fixture.broken", argsSummary: bad, describeRun: bad, compactParams: bad });
      try {
        for (const staticOutput of [false, true]) {
          const root = renderToolEvent({ name: "another_new_tool", rendererId: "fixture.broken", args, result: "retained result" },
            { expanded: true, lazyDetails: false, static: staticOutput });
          document.body.replaceChildren(root);
          snapshots.push({ failure, staticOutput, summary: root.querySelector(".tool-args-preview").textContent,
            params: root.querySelector(".tool-chip-row").textContent, text: root.querySelector(".tool-details").textContent,
            fallbacks: root.querySelectorAll(".tool-renderer-fallback").length });
          disposeRendererTree(root);
        }
      } finally { unregister(); }
    }
    return snapshots;
  });
  for (const snapshot of snapshots) {
    expect(snapshot.summary).toContain("retained query");
    expect(snapshot.params).toContain("retained parameter");
    expect(snapshot.text).toContain("retained result");
    expect(snapshot.fallbacks).toBe(0);
  }
});

test("built-in media parameters and streaming file previews survive capability registration", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const image = renderToolEvent({ name: "read_image", args: { url: "https://example.test/image.png", maxBytes: 1234 }, isError: true,
      result: { ok: false, error: "failed" } }, { expanded: true, lazyDetails: false });
    document.body.replaceChildren(image);
    const imageParams = image.querySelector(".tool-chip-row").textContent;
    disposeRendererTree(image);
    const file = renderToolEvent({ name: "save_file", args: { filename: "draft.md", content: "# Streaming content" },
      isRunning: true, argsIncomplete: true, phase: "preparing" }, { expanded: true, lazyDetails: false });
    document.body.replaceChildren(file);
    const fileContent = file.querySelector(".tool-file-content-block")?.textContent;
    const fileParams = file.querySelector(".tool-chip-row").textContent;
    disposeRendererTree(file);
    return { imageParams, fileContent, fileParams };
  });
  expect(result.imageParams).toContain("image.png");
  expect(result.imageParams).not.toContain("1234");
  expect(result.fileContent).toBe("# Streaming content");
  expect(result.fileParams).toContain("draft.md");
  expect(result.fileParams).not.toContain("Streaming content");
});

test("timeline visibility does not leak to other tools sharing a wait renderer", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { groupConsecutiveToolTranscriptEntries } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    const names = entries => groupConsecutiveToolTranscriptEntries(entries).flatMap(entry =>
      entry.type === "tool-group" ? entry.entries.map(tool => tool.name) : entry.type === "tool" ? [entry.name] : []);
    const tool = (name, extra = {}) => ({ type: "tool", name, _uiKey: name, args: {}, result: {}, ...extra });
    return {
      mixed: names([tool("open_tab"), tool("wait"), tool("wait_for_navigation"), tool("wait_until"),
        tool("custom_wait_tool", { rendererId: "wait", profileFamily: "wait" }), tool("image_assets"), tool("read_image")]),
      standalone: names([tool("wait")]),
      hidden: names([tool("image_assets")]),
    };
  });
  expect(result).toEqual({
    mixed: ["open_tab", "wait_for_navigation", "wait_until", "custom_wait_tool", "read_image"],
    standalone: ["wait"], hidden: [],
  });
});

test("compact element receipts retain trusted action labels and rich-text evidence in live and static cards", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const element = { role: "textbox", name: "Article draft" };
    const structure = { lineBreakCount: 1, paragraphCount: 2, brCount: 0, blockCount: 2, htmlSample: "<p>One</p><p>Two</p>" };
    const snapshots = [];
    const hint = "Verify the editor saved the value before continuing.";
    for (const historical of [false, true]) for (const uncertain of historical ? [false] : [false, true]) for (const staticOutput of [false, true]) {
      const result = historical ? { filled: true, element, fill: { richText: { structure } } }
        : { ...(uncertain ? { confirmationRequired: true, hint } : {}), _display: { elementAction: { element, structure } } };
      const root = renderToolEvent({ name: "act_on_element", args: { tabRef: "draft", target: "uid:t1.000001.1", action: "fill" }, result },
        { expanded: true, lazyDetails: false, static: staticOutput });
      document.body.replaceChildren(root);
      snapshots.push({ historical, uncertain, staticOutput, title: root.querySelector(".tool-compact-title")?.textContent,
        stats: root.querySelector(".tool-stat-grid")?.textContent, text: root.querySelector(".tool-details")?.textContent,
        fallbacks: root.querySelectorAll(".tool-renderer-fallback").length });
      disposeRendererTree(root);
    }
    return snapshots;
  });
  for (const snapshot of snapshots) {
    expect(snapshot.title).toBe("Article draft");
    expect(snapshot.stats).toMatch(/2\s*p/);
    expect(snapshot.stats).toMatch(/0\s*br/);
    expect(snapshot.text).toContain("<p>One</p><p>Two</p>");
    expect(snapshot.text.includes("Verify the editor saved the value before continuing.")).toBe(snapshot.uncertain);
    expect(snapshot.fallbacks).toBe(0);
  }
});

test("errors render one complete trace in live and exported cards, including legacy records", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const messages = Array.from({ length: 6 }, (_, index) => `Checkpoint ${index + 1}`);
    const rows = messages.map(message => ({ level: "trace", message }));
    const failure = { code: "SCRIPT_EVALUATION_FAILED", message: "Evaluation failed", hint: "Retry the saved step." };
    const results = [
      { ...failure, details: { trace: rows.slice(-3) }, _display: { script: { trace: rows } } },
      { ok: false, error: failure.message, hint: failure.hint, details: { trace: rows } },
      { ...failure, trace: messages },
    ];
    const snapshots = [];
    for (const name of ["run_script", "evaluate", "fixture_error_tool"]) {
      for (const staticOutput of [false, true]) for (const result of results) {
        const before = JSON.stringify(result);
        const root = renderToolEvent({ name, args: {}, result, isError: true },
          { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.replaceChildren(root);
        snapshots.push({ name, staticOutput,
          traces: root.querySelectorAll(".tool-script-trace").length,
          messages: [...root.querySelectorAll(".tool-script-trace-message")].map(node => node.textContent),
          error: root.querySelector(".tool-error-section")?.textContent,
          hints: (root.querySelector(".tool-details")?.textContent.match(/Retry the saved step\./g) || []).length,
          unchanged: before === JSON.stringify(result),
          fallbacks: root.querySelectorAll(".tool-renderer-fallback").length });
        disposeRendererTree(root);
      }
    }
    return snapshots;
  });
  for (const snapshot of snapshots) {
    expect(snapshot.traces).toBe(1);
    expect(snapshot.messages).toEqual(Array.from({ length: 6 }, (_, index) => `Checkpoint ${index + 1}`));
    expect(snapshot.error).not.toContain("Checkpoint");
    expect(snapshot.hints).toBe(1);
    expect(snapshot.unchanged).toBe(true);
    expect(snapshot.fallbacks).toBe(0);
  }
});

test("raw script values retain authored keys while host traces and execution status stay separate", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const values = [
      { ok: false, code: "SCRIPT_EVALUATION_FAILED", message: "Authored message", error: "Authored error",
        result: { result: 7 }, _display: { script: { valueOnly: true, trace: [{ message: "Authored trace" }] } },
        _plugin: { title: "Authored title" }, hint: "Authored hint", trace: ["Authored trace"],
        interrupted: true, incomplete: { reason: "timeout" }, _pageTitle: "Authored page" },
      { ok: true, result: 7 }, { result: 7 }, [{ result: 7 }], 0, false, null,
    ];
    const snapshots = [];
    for (const name of ["run_script", "evaluate"]) for (const staticOutput of [false, true]) for (const value of values) {
      const result = { result: value, _display: { script: { valueOnly: true, trace: [{ message: "Host execution trace" }] } },
        _pageTitle: "Execution page", _pageUrl: "https://example.test/script" };
      const before = JSON.stringify(result);
      const root = renderToolEvent({ name, args: { ...(name === "evaluate" ? { tabRef: "page" } : {}), code: "return value;" },
        result, isError: false }, { expanded: true, lazyDetails: false, static: staticOutput });
      document.body.replaceChildren(root);
      snapshots.push({ name, staticOutput, value, json: root.querySelector(".tool-result-json-block")?.textContent,
        error: Boolean(root.querySelector(".tool-error-section")), status: root.querySelector(".tool-summary .dot")?.className,
        trace: root.querySelector(".tool-script-trace")?.textContent,
        summary: root.querySelector(".tool-args-preview")?.textContent,
        unchanged: before === JSON.stringify(result), fallbacks: root.querySelectorAll(".tool-renderer-fallback").length });
      disposeRendererTree(root);
    }
    for (const staticOutput of [false, true]) {
      const root = renderToolEvent({ name: "run_script", args: { code: "throw new Error('failure');" }, isError: true,
        result: { code: "SCRIPT_EVALUATION_FAILED", message: "Concrete execution failure", hint: "Inspect the completed steps.",
          details: { trace: [{ message: "Before execution failure" }] } } },
      { expanded: true, lazyDetails: false, static: staticOutput });
      document.body.replaceChildren(root);
      snapshots.push({ failure: true, error: root.querySelector(".tool-error-section")?.textContent,
        text: root.querySelector(".tool-details")?.textContent, trace: root.querySelector(".tool-script-trace")?.textContent,
        status: root.querySelector(".tool-summary .dot")?.className });
      disposeRendererTree(root);
    }
    return snapshots;
  });
  for (const snapshot of snapshots) {
    if (snapshot.failure) {
      expect(snapshot.error).toContain("Concrete execution failure");
      expect(snapshot.text).toContain("Inspect the completed steps.");
      expect(snapshot.trace).toContain("Before execution failure");
      expect(snapshot.status).toContain("error");
      continue;
    }
    expect(JSON.parse(snapshot.json), JSON.stringify(snapshot)).toEqual(snapshot.value);
    expect(snapshot.error).toBe(false);
    expect(snapshot.status).toBe("dot ");
    expect(snapshot.trace).toContain("Host execution trace");
    expect(snapshot.trace).not.toContain("Authored trace");
    expect(snapshot.summary).not.toContain("Authored page");
    if (snapshot.name === "evaluate") expect(snapshot.summary).toContain("Execution page");
    expect(snapshot.unchanged).toBe(true);
    expect(snapshot.fallbacks).toBe(0);
  }
});
