import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storageData = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
};

const {
  AUTOMATIONS_KEY,
  computeNextRunAt,
  describeAutomationSchedule,
  normalizeAutomationSchedule,
} = await import("../../src/shared/automation-store.js");
const {
  saveAutomation,
  createAutomationRun,
  getAutomationRun,
  patchAutomationRun,
} = await import("../../src/background/automation/repository.js");

const once = normalizeAutomationSchedule({
  type: "once",
  runAt: "2026-07-08T09:30:00+08:00",
});
assert.equal(once.type, "once");
assert.equal(once.runAt, "2026-07-08 09:30:00");
assert.equal(computeNextRunAt(once, Date.UTC(2026, 6, 7, 0, 0, 0)), "2026-07-08 09:30:00");
assert.equal(describeAutomationSchedule(once), "单次 2026-07-08 09:30");

const dateAndTime = normalizeAutomationSchedule({
  type: "once",
  date: "2026-07-09",
  time: "8:05",
});
assert.equal(dateAndTime.runAt, "2026-07-09 08:05:00");

assert.equal(
  normalizeAutomationSchedule({ type: "once", runAt: "2026-07-0717:49:41" }).runAt,
  "2026-07-07 17:49:41",
  "once runAt should tolerate a missing separator between date and time",
);
assert.equal(
  normalizeAutomationSchedule({ type: "once", runAt: "2026/07/07 17:49" }).runAt,
  "2026-07-07 17:49:00",
  "once runAt should tolerate slashes and minute precision",
);
assert.equal(
  normalizeAutomationSchedule({ type: "once", runAt: "2026-07-07T09:49:41Z" }).runAt,
  "2026-07-07 17:49:41",
  "once runAt should normalize zoned ISO timestamps to Beijing time",
);
await assert.rejects(
  () => saveAutomation({
    id: "auto_once_invalid",
    title: "坏时间",
    instruction: "不要静默回退",
    schedule: { type: "once", runAt: "2026-07-07oops" },
  }),
  /once automation requires a valid runAt/,
  "invalid once runAt should be rejected instead of falling back to tomorrow morning",
);
await assert.rejects(
  () => saveAutomation({
    id: "auto_once_missing",
    title: "缺时间",
    instruction: "不要静默回退",
    schedule: { type: "once" },
  }),
  /once automation requires a valid runAt/,
  "missing once runAt should be rejected instead of falling back to tomorrow morning",
);

const savedFlexible = await saveAutomation({
  id: "auto_once_flexible",
  title: "ISO 时间",
  instruction: "推荐无空格格式",
  schedule: {
    type: "once",
    runAt: "2026-07-07T17:49:41+08:00",
  },
});
assert.equal(savedFlexible.schedule.runAt, "2026-07-07 17:49:41");
assert.equal(savedFlexible.nextRunAt, "2026-07-07 17:49:41");

const savedMissingSeparator = await saveAutomation({
  id: "auto_once_missing_separator",
  title: "容错时间",
  instruction: "兼容少空格",
  schedule: {
    type: "once",
    runAt: "2026-07-0717:49:41",
  },
});
assert.equal(savedMissingSeparator.schedule.runAt, "2026-07-07 17:49:41");
assert.equal(savedMissingSeparator.nextRunAt, "2026-07-07 17:49:41");

const saved = await saveAutomation({
  id: "auto_once_test",
  title: "单次测试",
  instruction: "到点运行一次",
  schedule: {
    type: "once",
    runAt: "2026-07-10 10:15:00",
  },
});
assert.equal(saved.schedule.type, "once");
assert.equal(saved.nextRunAt, "2026-07-10 10:15:00");
assert.equal(saved.missedPolicy, "run_once");
assert.equal(storageData[AUTOMATIONS_KEY].auto_once_test.nextRunAt, "2026-07-10 10:15:00");

const run = await createAutomationRun({ automationId: saved.id });
await assert.rejects(() => patchAutomationRun(run.id, { automationId: "" }), /invalid automation run/);
assert.deepEqual(await getAutomationRun(run.id), run, "invalid patches must not replace the stored run with null");

const html = readFileSync(new URL("../../src/capabilities/sessions/ui.html", import.meta.url), "utf8");
assert.match(html, /<option value="once"[^>]*data-i18n="sessions.runOnce"[^>]*>单次运行<\/option>/, "automation editor should expose once frequency");
assert.match(html, /id="automation-once-date"[^>]*type="date"/, "automation editor should expose a once date field");

const sidepanel = readFileSync(
  new URL("../../src/capabilities/sessions/automations/automations-feature.ts", import.meta.url),
  "utf8",
);
assert.match(sidepanel, /frequencyValue === "once"[\s\S]*type:\s*"once"[\s\S]*runAt:/, "automation editor should save once schedules with runAt");
assert.match(sidepanel, /runAt:\s*`\$\{onceDate\}T\$\{time\}:00\+08:00`/, "automation editor should submit one-shot runAt as a space-free ISO timestamp");
assert.match(sidepanel, /describeAutomationScheduleText[\s\S]*type === "once"[\s\S]*t\("onceAt",/, "automation list should describe once schedules");

const sessionTools = readFileSync(new URL("../../src/capabilities/sessions/tools.ts", import.meta.url), "utf8");
assert.match(sessionTools, /enum:\s*\["once",\s*"hourly",\s*"daily",\s*"weekly"\]/, "manage_sessions schedule schema should expose once");
assert.match(sessionTools, /MISSING_AUTOMATION_TITLE/, "create_automation should reject an omitted title instead of deriving UI text from its instruction");

const tools = await import("../../src/background/tools/runtime.js");
const runAtSchema = tools.resolveToolDefinition("manage_sessions").parameters.properties.schedule.properties.runAt;
assert.equal(runAtSchema.type, "string");
assert.match(runAtSchema.description, /once 必填/, "manage_sessions schedule schema should document runAt");
assert.match(runAtSchema.description, /YYYY-MM-DDTHH:mm:ss\+08:00/, "manage_sessions should recommend a space-free ISO timestamp");
const automationWrites = [];
const toolRuntime = tools.createToolRuntime({
  sessions: {
    async saveAutomation(input) {
      automationWrites.push(input);
      return { automation: { id: "auto-contract", ...input.automation } };
    },
  },
});
await assert.rejects(
  () => toolRuntime.execute("manage_sessions", {
    action: "create_automation",
    instruction: "每天检查一次",
    schedule: { type: "daily", time: "09:00" },
  }, null, { sessionId: "source-session" }),
  error => error?.code === "MISSING_AUTOMATION_TITLE" && error?.details?.requiredFields?.includes("title"),
);
const createdByTool = await toolRuntime.execute("manage_sessions", {
  action: "create_automation",
  title: "每日检查",
  instruction: "每天检查一次",
  schedule: { type: "daily", time: "09:00" },
}, null, { sessionId: "source-session" });
assert.equal(createdByTool.automation.title, "每日检查");
assert.equal(automationWrites.length, 1, "the rejected request must not reach persistence");

const { SYSTEM_PROMPT: prompts } = await import("../../src/background/agent/prompts.js");
assert.match(prompts, /schedule\.type="once"[\s\S]*runAt="YYYY-MM-DDTHH:mm:ss\+08:00"/, "kernel prompt should tell agents how to create one-shot automations");
assert.match(prompts, /不要改用普通子任务等待/, "kernel prompt should discourage simulating one-shot automations with child sessions");
assert.match(prompts, /明确要求并行[\s\S]*manage_sessions\.create[\s\S]*同时返回多个工具调用[\s\S]*按任务依赖关系自动编排执行顺序/, "kernel prompt should map child-session parallelism to dependency-scheduled tool calls");
assert.match(prompts, /先 manage_sessions\.wait\(waitFor:"any"\)[\s\S]*wait\(waitFor:"all"\)/, "progressive parallel requests should map to any then all waits");

const automationRuntime = readFileSync(new URL("../../src/background/automation/runtime.ts", import.meta.url), "utf8");
assert.match(automationRuntime, /function nextPatchAfterScheduledRun/, "automation runtime should centralize post-run next schedule patching");
assert.match(automationRuntime, /object\(schedule\)\.type === "once"[\s\S]*enabled:\s*false[\s\S]*nextRunAt:\s*""/, "scheduled once runs should disable themselves after firing");

console.log("automation once tests passed");
