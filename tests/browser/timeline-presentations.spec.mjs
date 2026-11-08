import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    const renderer = await import("/extension/sidepanel/tools/tool-renderer.js");
    const timeline = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    const { toolPresentationRegistry } = await import("/extension/sidepanel/tools/tool-presentation.js");
    window.__timelinePresentation = {
      registry: toolPresentationRegistry,
      card(input) {
        const el = renderer.renderToolEvent(input, { lazyDetails: false });
        const summary = el.querySelector(".tool-args-preview")?.textContent;
        renderer.disposeRendererTree(el);
        return summary;
      },
      group(inputs, staticOutput = false) {
        const tools = inputs.map((input, index) => ({ type: "tool", toolCallId: `call-${index}`, args: {}, result: { ok: true }, ...input }));
        const el = timeline.createToolTimelineGroupElement(timeline.createToolTimelineGroupEntry(tools), { static: staticOutput });
        const summary = el.querySelector(":scope > .tool-summary");
        const value = { title: summary.querySelector(".tool-name").textContent, preview: summary.querySelector(".tool-args-preview").textContent };
        renderer.disposeRendererTree(el);
        return value;
      },
    };
  });
});

test("third-party timeline titles, targets and evidence use the same presentation registry", async ({ page }) => {
  const snapshots = await page.evaluate(() => {
    const api = window.__timelinePresentation;
    const dispose = api.registry.register({ id: "custom.forecast",
      timelineGroupTitle: () => ({ label: "Weather evidence", order: 15 }),
      timelineBadge: ({ args }) => ({ label: `${args.city} forecast`, key: "forecast", order: 25 }),
      timelineTarget: ({ args }) => args.city,
    });
    try {
      return [false, true].map(staticOutput => api.group([
        { name: "future_tool_a", rendererId: "custom.forecast", args: { city: "杭州" } },
        { name: "future_tool_b", rendererId: "custom.forecast", args: { city: "上海" } },
      ], staticOutput));
    } finally { dispose(); }
  });
  for (const result of snapshots) expect(result).toEqual({ title: "Weather evidence", preview: "2 步 · 杭州 forecast" });
});

test("built-in timeline labels retain precedence, first-result counts and historical identity", async ({ page }) => {
  const actual = await page.evaluate(() => {
    const { group } = window.__timelinePresentation;
    return [
      group([{ name: "run_script" }, { name: "get_ax_tree" }, { name: "data_store", result: { totalRows: 3 } }, { name: "network_body" }, { name: "data_store", result: { totalRows: 9 } }]),
      group([{ name: "data_store", result: { totalRows: 0 } }, { name: "ask_user" }]),
      group([{ name: "run_script" }, { name: "inject_css" }, { name: "modify_dom" }]),
      group([{ name: "plugin__historical_document", profileFamily: "document", familyId: "artifact" }, { name: "document_fetch" }]),
      group([{ name: "document_fetch" }, { name: "screenshot" }]),
      group([{ name: "legacy_network_alias", labelerId: "networkBody" }, { name: "screenshot" }]),
      group([{ name: "legacy_capture_alias", mediaPresentation: "capture" }, { name: "arbitrary_tool" }]),
    ];
  });
  expect(actual).toEqual([
    { title: "采集并写入数据表", preview: "5 步 · 3 行 · DOM · 响应体" },
    { title: "用户确认", preview: "2 步 · 数据表" },
    { title: "执行脚本等工具", preview: "3 步 · 脚本" },
    { title: "网页证据生成文档", preview: "2 步 · 拉取文档" },
    { title: "阅读文档资料", preview: "2 步 · 页面截图" },
    { title: "接口与日志诊断", preview: "2 步 · 响应体" },
    { title: "页面检查", preview: "2 步 · arbitrary_tool" },
  ]);
});

test("page evaluation summaries use explicit references or host context while outer scripts keep returned titles as business data", async ({ page }) => {
  const results = await page.evaluate(() => {
    const { card } = window.__timelinePresentation;
    const business = { pageTitle: "Business title", _pageTitle: "Returned user data" };
    const returned = (result, metadata = {}) => ({ result, _display: { script: { valueOnly: true, trace: [] } }, ...metadata });
    const pageArgs = { tabRef: "report", code: "value => value", args: business };
    return [
      card({ name: "evaluate", isError: false, args: { code: "() => 1", tabRef: "report" }, result: returned(1) }),
      card({ name: "evaluate", isError: false, args: pageArgs, result: returned(business, { _pageTitle: "Host page" }) }),
      card({ name: "evaluate", isError: false, args: pageArgs, result: returned(business) }),
      card({ name: "run_script", isError: false, args: { code: "return 1" }, result: returned(1) }),
      card({ name: "run_script", isError: false, args: { code: "return args", args: business }, result: returned(business) }),
      card({ name: "third_party_script", profileFamily: "script", pageContext: true, args: { code: "return 1" }, result: returned(business) }),
    ];
  });
  expect(results).toEqual(["(标签页 report)", "(Host page)", "(标签页 report)", "", "", ""]);
});

test("malformed and asynchronous timeline declarations fall back without poisoning other contributions", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.__timelinePresentation;
    const failures = [() => { throw new Error("bad extension"); }, () => Promise.reject(new Error("async declaration")),
      () => ({ label: "bad", order: NaN }), () => ({ label: 1, order: 0 }), () => ({ label: "bad", order: 0, key: [] }),
      () => ({ label: "bad", order: 0, then() {} })];
    return failures.map(bad => {
      const remove = api.registry.register({ id: "broken.forecast", timelineGroupTitle: bad, timelineBadge: bad, timelineTarget: bad });
      try {
        return api.group([{ name: "unknown_external_tool", rendererId: "broken.forecast" }, { name: "get_ax_tree" }]);
      } finally { remove(); }
    });
  });
  for (const snapshot of result) expect(snapshot).toEqual({ title: "页面检查", preview: "2 步 · DOM" });
});

test("timeline target callbacks retain isolated results and omit display-only fields", async ({ page }) => {
  const observed = await page.evaluate(() => {
    const api = window.__timelinePresentation;
    const result = { title: "Original", nested: { value: "unchanged" }, _image: "image payload", _display: { hidden: true } };
    const before = JSON.stringify(result);
    const calls = [];
    let behavior = "label";
    const dispose = api.registry.register({ id: "isolated-target", timelineTarget: ({ result: view }) => {
      calls.push({ title: view.title, nested: view.nested.value, clean: !("_image" in view) && !("_display" in view) });
      view.nested.value = "callback mutation";
      if (behavior === "throw") throw new Error("Projection failed");
      return behavior === "label" ? view.title : undefined;
    } });
    try {
      for (behavior of ["label", "fallback", "throw"]) {
        for (const staticOutput of [false, true]) api.group([
          { name: "custom", rendererId: "isolated-target", result },
          { name: "custom", rendererId: "isolated-target", result },
        ], staticOutput);
      }
      return { unchanged: JSON.stringify(result) === before, calls };
    } finally { dispose(); }
  });
  expect(observed.unchanged).toBe(true);
  expect(observed.calls.length).toBeGreaterThan(0);
  for (const call of observed.calls) expect(call).toEqual({ title: "Original", nested: "unchanged", clean: true });
});
