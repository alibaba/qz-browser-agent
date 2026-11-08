import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { getToolMetadataCatalog, getCoreToolMetadata, getToolFamilyMetadata, formatActionLabel, formatToolActionTitle } from "../../src/shared/tools/tool-metadata.js";
import { toolIdentityEventFields } from "../../src/shared/tools/tool-identity.js";
import { updateTranscriptWithAgentEvent, createSessionRecord, readSessionRecord } from "../../src/shared/session/session-codec.js";
import { getToolDisplayName, getToolTimelineFamilyInfo, isToolInSet } from "../../src/sidepanel/tools/tool-model.js";
import { createToolView, RendererRegistry } from "../../src/sidepanel/tools/renderer-host.js";
import { getLanguage, withLanguage } from "../../src/shared/i18n/index.js";
import { materializeContribution } from "../../src/shared/capabilities.js";

const definition = name => ({ name, description: "Test tool", parameters: { type: "object", properties: {} }, execute: () => ({ value: 42 }) });

test("contribution snapshots materialize nested getters and keep executable handlers by identity", () => {
  let title = "First title";
  const execute = () => 42;
  const source = { nested: [{ get title() { return title; }, actions: { get label() { return title; } } }], execute };
  const snapshot = materializeContribution(source);
  title = "Second title";
  source.nested.push({ title });
  assert.equal(snapshot.execute, execute);
  assert.equal(snapshot.nested.length, 1);
  assert.equal(snapshot.nested[0].title, "First title");
  assert.equal(snapshot.nested[0].actions.label, "First title");
  assert.equal(Object.getOwnPropertyDescriptor(snapshot.nested[0], "title").get, undefined);
  assert.ok(Object.isFrozen(snapshot.nested[0].actions));
});

test("materialized metadata keeps dictionary lookups isolated from Object prototype names", () => {
  const source = Object.assign(Object.create(null), { constructor: { title: "Declared constructor" } });
  const snapshot = materializeContribution(source);
  assert.equal(Object.getPrototypeOf(snapshot), null);
  assert.equal(snapshot.constructor.title, "Declared constructor");
  assert.equal(snapshot.toString, undefined);
  for (const language of ["zh-CN", "en"]) withLanguage(language, () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.equal(getCoreToolMetadata(name), null);
      assert.equal(formatActionLabel(name), "");
      assert.equal(isToolInSet(name, "human"), false);
      assert.equal(getToolFamilyMetadata(name).id, "other");
      assert.equal(getToolDisplayName(name), name);
    }
  });
});

test("metadata resolves after import in each language without changing previous run snapshots or tool policy", () => {
  const previousLanguage = getLanguage();
  const chinese = getToolMetadataCatalog("zh-CN");
  const english = getToolMetadataCatalog("en");
  assert.equal(getLanguage(), previousLanguage, "materialization cannot leak its synchronous language scope");
  assert.equal(getToolMetadataCatalog("zh-CN"), chinese);
  assert.equal(getToolMetadataCatalog("en"), english);
  assert.notEqual(chinese, english);
  assert.ok(Object.isFrozen(chinese));
  assert.deepEqual(Object.keys(chinese.tools), Object.keys(english.tools));
  const policy = ({ title, shortTitle, actionLabels, titleRule, ...facts }) => ({
    ...facts,
    actions: Object.keys(actionLabels || {}),
    ...(titleRule ? { titleRule: { field: titleRule.field, normalize: titleRule.normalize, fallback: titleRule.fallback, actions: Object.keys(titleRule.values) } } : {}),
  });
  for (const name of Object.keys(chinese.tools)) assert.deepEqual(policy(chinese.tools[name]), policy(english.tools[name]), name);
  assert.ok(Object.keys(chinese.tools).filter(name => chinese.tools[name].title !== english.tools[name].title).length > 40);
  withLanguage("en", () => {
    assert.equal(getCoreToolMetadata("open_tab"), english.tools.open_tab);
    assert.equal(getToolDisplayName("open_tab"), english.tools.open_tab.title);
    assert.equal(formatToolActionTitle("data_store", { action: "upsert" }), "Write to table");
    assert.equal(getToolTimelineFamilyInfo("read_article").label, "Collect information");
  });
  withLanguage("zh-CN", () => {
    assert.equal(getCoreToolMetadata("open_tab"), chinese.tools.open_tab);
    assert.equal(formatToolActionTitle("data_store", { action: "upsert" }), "写入数据表");
    assert.equal(getToolTimelineFamilyInfo("read_article").label, "采集信息");
  });
  assert.equal(english.families.collect.title, "Collect information", "old snapshots stay in their captured language");
});

test("historical catalog titles follow the current display language without rewriting their snapshots", () => {
  for (const [source, target] of [["en", "zh-CN"], ["zh-CN", "en"]]) {
    const tools = Object.entries(getToolMetadataCatalog(source).tools).map(([name, metadata]) =>
      Object.freeze({ name, capabilityId: name, title: metadata.title }));
    withLanguage(target, () => {
      for (const tool of tools) {
        const metadata = getCoreToolMetadata(tool.capabilityId);
        const expected = metadata.shortTitle || metadata.title;
        assert.equal(getToolDisplayName(tool), expected, `${source} → ${target}: ${tool.name}`);
        assert.equal(getToolDisplayName({ name: "alias", toolCapabilityId: tool.name, toolTitle: tool.title }), expected);
        assert.equal(formatToolActionTitle(tool, {}), formatToolActionTitle(tool.name, {}));
      }
    });
    for (const tool of tools) assert.equal(tool.title, getToolMetadataCatalog(source).tools[tool.name].title);
  }
});

test("compact tool labels leave canonical identities and historical titles intact", () => {
  withLanguage("en", () => {
    const original = Object.freeze({ name: "navigate", title: "Navigate to URL" });
    assert.equal(getCoreToolMetadata("navigate").title, "Navigate to URL");
    assert.equal(getToolDisplayName(original), "Go to URL");
    assert.equal(formatToolActionTitle(original), "Go to URL");
    assert.equal(toolIdentityEventFields(original).toolTitle, "Navigate to URL");
    assert.equal(getToolTimelineFamilyInfo(original).shortLabel, "Navigate");
    assert.equal(getToolTimelineFamilyInfo(original).label, "Navigate to page");
    assert.equal(getToolDisplayName({ name: "navigate", title: "Research destination" }), "Research destination");
  });
  withLanguage("zh-CN", () => {
    for (const metadata of Object.values(getToolMetadataCatalog().tools)) {
      assert.equal(metadata.shortTitle || metadata.title, metadata.title, "Chinese tool labels remain unchanged");
    }
    for (const family of Object.values(getToolMetadataCatalog().families)) {
      assert.equal(family.shortTitle, family.title, "Chinese family labels remain unchanged");
    }
  });
});

test("historical explicit titles are not mistaken for catalog titles from another tool", () => {
  for (const language of ["en", "zh-CN"]) withLanguage(language, () => {
    for (const tool of [
      { name: "open_tab", title: "打开资料" },
      { name: "open_tab", title: "Navigate to URL" },
      { name: "external_tool", title: "Open tab" },
      { name: "custom_alias", capabilityId: "open_tab", title: "Custom research tab" },
      { name: "manage_settings", title: "Custom settings" },
    ]) {
      assert.equal(getToolDisplayName(tool), tool.title);
      assert.equal(formatToolActionTitle(tool, { action: "unknown" }), tool.title);
    }
  });
});

test("a tool's declared identity reaches persisted transcript, UI title, family and custom renderer without metadata", () => {
  const registry = createToolRegistry();
  registry.defineTool({ ...definition("parallel_example"), title: "扩展结果", familyId: "process", rendererId: "example.card" });
  assert.equal(getCoreToolMetadata("parallel_example"), null, "the tool must not require a parallel metadata entry");
  const registered = registry.get("parallel_example");
  const events = ["tool_execution_start", "tool_execution_end"].map(type => JSON.parse(JSON.stringify({
    type, sessionId: "session-a", runId: "run-a", spanId: "span-a", toolCallId: "call-a",
    toolName: registered.name, ...toolIdentityEventFields(registered), args: {}, result: { value: 42 },
  })));
  let transcript = [];
  for (const event of events) transcript = updateTranscriptWithAgentEvent(transcript, event).transcript;
  const saved = JSON.parse(JSON.stringify(createSessionRecord([], transcript)));
  const tool = readSessionRecord(saved).transcript.find(entry => entry.type === "tool");
  assert.equal(getToolDisplayName(tool), "扩展结果");
  assert.equal(formatToolActionTitle(tool), "扩展结果");
  assert.deepEqual(getToolTimelineFamilyInfo(tool), { id: "process", label: "处理数据", shortLabel: "处理数据" });
  const view = createToolView({ ...tool, id: tool.toolCallId });
  assert.equal(view.title, "扩展结果");
  assert.equal(view.rendererId, "example.card");
  const renderers = new RendererRegistry({ id: "generic" });
  const custom = { id: "example.card" };
  renderers.register(custom);
  assert.equal(renderers.resolve(view.rendererId), custom);
});

test("omitted identity preserves every built-in title and family and keeps unknown-tool fallbacks", () => {
  const registry = createToolRegistry();
  for (const [name, metadata] of Object.entries(getToolMetadataCatalog().tools)) {
    registry.defineTool(definition(name));
    const registered = registry.get(name);
    assert.equal(registered.title, metadata.title, name);
    assert.equal(registered.familyId, metadata.familyId, name);
    assert.equal(registered.profileFamily, metadata.profileFamily, name);
    assert.equal(registered.resultFamily, metadata.resultFamily, name);
  }
  registry.defineTool(definition("unknown_example"));
  const unknown = registry.get("unknown_example");
  assert.equal(unknown.title, "unknown_example");
  assert.equal(unknown.familyId, "other");
  assert.equal(unknown.rendererId, undefined);
});

test("an explicit title and family override presentation defaults without changing tool policy", () => {
  const registry = createToolRegistry();
  registry.defineTool({ ...definition("open_tab"), title: "打开资料", familyId: "collect" });
  const registered = registry.get("open_tab");
  assert.equal(registered.title, "打开资料");
  assert.equal(registered.familyId, "collect");
  assert.equal(registered.model.pageContext, "explicit");
  assert.equal(registered.profileFamily, getCoreToolMetadata("open_tab").profileFamily);
  assert.equal(registered.schema.function.name, "open_tab");
});
