import { expect, test } from "./fixtures.mjs";

test("Skill fallback retains business metadata keys and host identity in live and historical output", async ({ page }) => {
  await page.goto("/__test_health");
  const results = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { setSkillToolUiCatalog } = await import("/extension/sidepanel/tools/skill-tool-ui-registry.js");
    setSkillToolUiCatalog({ plugins: [{ id: "fixture", name: "Fixture Skill", skillName: "fixture", tools: [{
      name: "fixture__run", title: "Catalog action", runtime: "inner", script: "scripts/run.js",
    }] }] });
    const business = {
      _plugin: { title: "Business title", renderer: { type: "text", valuePath: "spoof" } },
      spoof: "Business renderer must not replace the host view",
      nested: { _plugin: { value: "nested business data" } },
      rows: [{ _plugin: "row business data" }],
    };
    const host = { ok: true, result: business, trace: [{ message: "Host trace retained" }], _plugin: {
      id: "fixture", name: "Fixture Skill", title: "Host action", skillName: "fixture", script: "scripts/run.js", runtime: "inner",
    } };
    const examples = [];
    const cases = [
      { result: host, expected: business, title: "Host action", trace: true },
      { result: { result: host }, expected: business, title: "Host action", trace: true },
      ...[{ result: { _plugin: { value: "unwrapped business data" } } }, { code: "business", result: 42 },
        { _plugin: { value: "raw business metadata" }, rows: [{ _plugin: "row data" }] }, { engine: "diesel", result: 7 }]
        .map(result => ({ result, expected: result, title: "Catalog action", trace: false })),
    ];
    for (const staticOutput of [false, true]) for (const entry of cases) {
      const { result } = entry;
      const before = JSON.stringify(result);
      const root = renderToolEvent({ name: "fixture__run", args: {}, result },
        { expanded: true, lazyDetails: false, static: staticOutput });
      document.body.append(root);
      const details = root.querySelector(".tool-details");
      examples.push({ staticOutput, expected: entry.expected, expectedTitle: entry.title, expectedTrace: entry.trace,
        title: root.querySelector(".tool-name")?.textContent,
        json: details.querySelector(".tool-result-json-block")?.textContent,
        trace: details.querySelector(".tool-script-trace")?.textContent,
        unchanged: JSON.stringify(result) === before });
      disposeRendererTree(root); root.remove();
    }
    for (const staticOutput of [false, true]) {
      const failure = { code: "SKILL_FAILED", message: "Concrete Skill failure", hint: "Read the page again", details: { line: 2 } };
      const root = renderToolEvent({ name: "fixture__run", args: {}, isError: true,
        result: failure },
        { expanded: true, lazyDetails: false, static: staticOutput });
      document.body.append(root);
      examples.push({ failure: true, error: root.querySelector(".tool-error-section")?.textContent,
        hint: failure.hint, json: root.querySelector(".tool-result-json-block")?.textContent });
      disposeRendererTree(root); root.remove();
    }
    setSkillToolUiCatalog({});
    return examples;
  });
  for (const result of results) {
    if (result.failure) {
      expect(result.error).toContain("Concrete Skill failure");
      expect(result.hint).toBe("Read the page again");
      expect(result.json).toBeUndefined();
      continue;
    }
    expect(result.title).toContain(result.expectedTitle);
    expect(result.title).not.toContain("Business title");
    expect(JSON.parse(result.json), JSON.stringify(result)).toEqual(result.expected);
    if (result.expectedTrace) expect(result.trace).toContain("Host trace retained");
    expect(result.unchanged).toBe(true);
  }
});

test("script renders public errors and preserves error-shaped returned business data in live and exported output", async ({ page }) => {
  await page.goto("/__test_health");
  const results = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const examples = [];
    for (const staticOutput of [false, true]) {
      const root = renderToolEvent({
        name: "run_script", args: { timeout: 10, code: "throw new Error('failure');" },
        result: { code: "SCRIPT_EVALUATION_FAILED", message: "外层执行失败", hint: "检查已执行的动作后重试。", details: { trace: [{ message: "before failure", level: "debug" }] } },
      }, { expanded: true, static: staticOutput });
      document.body.append(root);
      const details = root.querySelector(".tool-details");
      const text = details.textContent;
      const business = renderToolEvent({
        name: "run_script", args: { timeout: 10, code: "return {error:'内层业务数据'}" },
        result: { ok: true, result: { error: "内层业务数据" } },
      }, { expanded: true, static: staticOutput });
      document.body.append(business);
      examples.push({ staticOutput, codeBlocks: details.querySelectorAll(".js-code-block").length,
        codeBeforeError: text.indexOf("运行代码") < text.indexOf("外层执行失败"),
        error: details.querySelector(".tool-error-section")?.textContent || text,
        trace: Boolean(details.querySelector(".tool-script-trace")),
        hint: text.includes("检查已执行的动作后重试。"),
        businessError: Boolean(business.querySelector(".tool-error-section")),
        businessText: business.querySelector(".tool-details").textContent,
      });
      disposeRendererTree(root); root.remove();
      disposeRendererTree(business); business.remove();
    }
    return examples;
  });
  for (const result of results) {
    expect(result.codeBlocks).toBe(1);
    expect(result.codeBeforeError, JSON.stringify(results)).toBe(true);
    expect(result.error).toContain("外层执行失败");
    expect(result.trace).toBe(true);
    expect(result.hint).toBe(true);
    expect(result.businessError).toBe(false);
    expect(result.businessText).toContain("内层业务数据");
    expect(result.error).not.toContain("内层业务数据");
  }
});
