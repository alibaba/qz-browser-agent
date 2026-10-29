import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("sessions-model", {
  getLocation: {
    en: "Get the user's current latitude, longitude, accuracy in meters, and location timestamp. Call only when the task needs local information (no arguments). Requires an open side panel and user permission; if unavailable or declined, ask the user for a city or area and continue.",
    "zh-CN": "获取用户当前经纬度、精度（米）和定位时间。仅在任务需要本地位置信息时调用（无参数）。需打开侧边栏并由用户授权定位；不可用或被拒绝时，向用户询问城市或区域并继续任务。",
  },
  manageSessionsWithoutAutomations: {
    "zh-CN": "管理轻舟子任务与会话（仅 user-created root session 可用）：create 创建子 session 并可通过 firstMessage 启动后台运行；wait 等待子任务完成并回收消息与 artifacts 产物索引（图集、Data 表、文件句柄）；last_messages 读取指定 session 最近消息与 artifacts；send_message 向其他 session 追加消息（follow_up 在当前 run 后执行，steer 在当前完整 turn 后介入，空闲时直接启动）；stop 终止目标当前 run；list/delete 列出或删除其他 session。本 Firefox 包不提供定时任务。",
    en: "Manage qz child tasks and sessions (available in user-created root sessions only): create starts a child session (pass firstMessage to run in the background); wait waits for child sessions and returns messages plus their artifacts index (galleries, Data tables, file handles); last_messages reads recent messages and artifacts; send_message sends a message to another session (follow_up runs after the current run, steer after the current turn, or immediately if idle); stop ends the target's current run; list/delete lists or deletes other sessions. Session automations are disabled in Firefox.",
  },
  sessionAutomationsDisabled: {
    "zh-CN": "Firefox 中已停用定时任务，已保存的定时任务不会执行。",
    en: "Session automations are disabled in Firefox. Stored scheduled tasks do not run.",
  },
  sessionActionWithoutAutomations: {
    "zh-CN": "操作类型。必填项：delete/last_messages/stop 需 sessionId；send_message 需 sessionId + message；wait 需 sessionIds 或 sessionId。",
    en: "Action. Required fields: delete/last_messages/stop needs sessionId; send_message needs sessionId + message; wait needs sessionIds or sessionId.",
  },
  manageSessions: {
    "zh-CN": "管理轻舟子任务、会话与本地定时任务（仅 user-created root session 可用）。子任务：create 创建子 session 并可通过 firstMessage 启动后台运行；wait 等待子任务完成并附带 artifacts 产物索引（图集、Data 表、文件句柄）；last_messages 读取最近消息与 artifacts；send_message 向其他 session 发送消息（follow_up 在当前 run 后执行，steer 在当前 turn 后介入，空闲时立即启动）；stop 终止目标当前 run；list/delete 列出或删除其他 session。定时任务：create_automation 保存 title、instruction、schedule、missedPolicy、notifyPolicy；list_automations/automation_runs/run_automation/update_automation/delete_automation 查看、立即运行、修改或删除定时任务。",
    en: "Manage qz child tasks, sessions, and local automations (available in user-created root sessions only). Sessions: create starts a child session (pass firstMessage to run in the background); wait waits for child sessions and includes their artifacts index (galleries, Data tables, file handles); last_messages reads recent messages and artifacts; send_message sends a message to another session (follow_up after the current run, steer after the current turn, or immediately if idle); stop ends the target's current run; list/delete lists or deletes other sessions. Automations: create_automation saves title, instruction, schedule, missedPolicy, and notifyPolicy; list_automations/automation_runs/run_automation/update_automation/delete_automation lists, runs, edits, or deletes automations.",
  },
  sessionAction: {
    "zh-CN": "操作类型。必填项：delete/last_messages/stop 需 sessionId；send_message 需 sessionId + message；wait 需 sessionIds 或 sessionId；create_automation 需 title + instruction；update_automation/delete_automation/run_automation/automation_runs 需 automationId。",
    en: "Action. Required fields: delete/last_messages/stop needs sessionId; send_message needs sessionId + message; wait needs sessionIds or sessionId; create_automation needs title + instruction; update_automation/delete_automation/run_automation/automation_runs needs automationId.",
  },
  sessionId: {
    "zh-CN": "目标 sessionId（用于 delete/last_messages/stop/send_message/wait）。",
    en: "Target sessionId for delete/last_messages/stop/send_message/wait.",
  },
  sessionMessage: {
    "zh-CN": "send_message 发送的非空消息正文。",
    en: "Non-empty message text for send_message.",
  },
  sessionMessageMode: {
    "zh-CN": "send_message 投递模式：follow_up（默认，当前 run 后）或 steer（当前 turn 后）；空闲时直接启动。",
    en: "Delivery mode: follow_up (default, after current run) or steer (after current turn); starts immediately if idle.",
  },
  automationId: {
    "zh-CN": "update_automation/delete_automation/run_automation/automation_runs 的目标 ID。",
    en: "Target automation ID for update_automation/delete_automation/run_automation/automation_runs.",
  },
  sessionIds: {
    "zh-CN": "wait 的目标 sessionId 数组。",
    en: "Target sessionIds array for wait.",
  },
  sessionWaitFor: {
    "zh-CN": "wait 模式：all（默认）或 any（先看首项再汇总时，先对同一批 sessionIds 调 any 再调 all）。",
    en: "Wait mode: all (default) or any (call any then all on the same sessionIds to inspect the first result before summarizing all).",
  },
  sessionTitle: {
    "zh-CN": "create 的子任务标题，或 create_automation 必填的简短标题。",
    en: "Child-session title for create, or required short title for create_automation.",
  },
  sessionFirstMessage: {
    "zh-CN": "create 后发送给新 session 并在后台启动执行的首条消息。",
    en: "Initial message sent to start the new session in the background after create.",
  },
  automationInstruction: {
    "zh-CN": "create_automation/update_automation 的执行说明（目标、步骤、页面、Data 表及异常处理）。",
    en: "Instructions for create_automation/update_automation (goal, steps, pages, Data tables, and error handling).",
  },
  automationSchedule: {
    "zh-CN": "定时调度规则，支持 once/hourly/daily/weekly。",
    en: "Schedule rule supporting once/hourly/daily/weekly.",
  },
  automationScheduleType: {
    "zh-CN": "once（单次，需 runAt）、hourly（按分钟间隔）、daily（每天）、weekly（每周）。",
    en: "once (requires runAt), hourly (by minute interval), daily, or weekly.",
  },
  automationRunAt: {
    "zh-CN": "once 必填。推荐 ISO 8601 北京时间 YYYY-MM-DDTHH:mm:ss+08:00（如 2026-07-08T09:30:00+08:00），兼容 YYYY-MM-DD HH:mm:ss。",
    en: "Required for once. Prefer ISO 8601 Beijing time YYYY-MM-DDTHH:mm:ss+08:00 (e.g. 2026-07-08T09:30:00+08:00); accepts YYYY-MM-DD HH:mm:ss.",
  },
  automationTime: {
    "zh-CN": "daily/weekly 的北京时间 HH:mm（如 09:00）。",
    en: "Beijing time HH:mm for daily/weekly (e.g. 09:00).",
  },
  automationWeekday: {
    "zh-CN": "weekly 星期几（1=周一 ... 7=周日）。",
    en: "Day of the week for weekly (1=Monday through 7=Sunday).",
  },
  automationIntervalMinutes: {
    "zh-CN": "hourly 间隔分钟数（支持 5、15、30、60）。",
    en: "Interval in minutes for hourly (supports 5, 15, 30, or 60).",
  },
  automationIntervalHours: {
    "zh-CN": "兼容旧字段（小时数，自动转为 intervalMinutes）。",
    en: "Legacy interval in hours (converted to intervalMinutes).",
  },
  automationMissedPolicy: {
    "zh-CN": "离线/睡眠漏跑策略：run_once（补跑一次）、latest_only（只查最新）、skip（跳过）。",
    en: "Missed-run policy: run_once (catch up once), latest_only (check latest), or skip.",
  },
  automationNotifyPolicy: {
    "zh-CN": "通知策略：failure（仅失败）、always（每次完成）、silent（静默）。",
    en: "Notification policy: failure, always, or silent.",
  },
  automationEnabled: {
    "zh-CN": "是否启用（create_automation 默认 true）。",
    en: "Whether enabled (defaults to true for create_automation).",
  },
  sessionListLimit: {
    "zh-CN": "list 返回条数，默认 100。",
    en: "Maximum items for list. Default: 100.",
  },
  automationRunLimit: {
    "zh-CN": "list_automations 附带的最近运行记录数，默认 3。",
    en: "Recent runs included per automation in list_automations. Default: 3.",
  },
  sessionMessageLimit: {
    "zh-CN": "last_messages/wait 返回的最近消息条数，默认 5，最大 50。",
    en: "Recent messages returned by last_messages/wait. Default: 5; maximum: 50.",
  },
  sessionWaitTimeout: {
    "zh-CN": "wait 等待秒数；省略或 <=0 表示无限等待（上限 2 小时），>0 表示最多等待对应秒数后返回快照。",
    en: "Wait seconds: omitted or <=0 means infinite wait (up to 2 hours); >0 returns snapshots after at most that many seconds.",
  },
  manageGoal: {
    "zh-CN": "管理当前 root session 的多轮长任务目标追踪：长流程开始时 create 记录 objective 与 criteria；每次已经写入 data_store、图集或文件等 durable 进展后 checkpoint 更新 progress/next/checkpoint；遇到阻塞时 block 写明 progress（原因）和 next（等待事项）；完成前先用工具验证完成标准再 complete。只保存简短文本，禁止存入大数组、全文、DOM、base64 或文件内容。",
    en: "Track the current root session's multi-turn task goal: call create at the start with objective and criteria; call checkpoint after durable progress is written to data_store, a gallery, or a file; call block with progress (cause) and next (needed action) when blocked; verify criteria with tools before complete. Store only short text fields, never large arrays, full text, DOM, base64, or file contents.",
  },
  goalAction: {
    "zh-CN": "操作类型。必填项：create 需 objective + criteria；block 需 progress + next；checkpoint/update 更新 progress/next/checkpoint；complete 前须先验证 criteria。",
    en: "Goal action. Required fields: create needs objective + criteria; block needs progress + next; checkpoint/update updates progress/next/checkpoint; verify criteria before complete.",
  },
  goalObjective: {
    "zh-CN": "一句话任务目标（create 必填，最多 240 字符）。例：采集 Hacker News 前 3 页帖子写入 hn_posts。",
    en: "One-sentence task objective (required for create, up to 240 chars). Example: Collect posts from the first 3 Hacker News pages into hn_posts.",
  },
  goalCriteria: {
    "zh-CN": "可验证的完成标准（create 必填，最多 360 字符）。例：完成 3 页、按 url 去重写入 hn_posts 并核对行数。",
    en: "Verifiable completion criteria (required for create, up to 360 chars). Example: Finish 3 pages, deduplicate by url in hn_posts, and verify row count.",
  },
  goalProgress: {
    "zh-CN": "当前已完成进展或 block 阻塞原因短句（block 必填，最多 360 字符）。",
    en: "Brief progress summary or blocker cause for block (required for block, up to 360 chars).",
  },
  goalNext: {
    "zh-CN": "下一步动作或等待事项短句（block 必填，最多 240 字符）。",
    en: "Brief next step or awaited action for block (required for block, up to 240 chars).",
  },
  goalCheckpoint: {
    "zh-CN": "可恢复执行的短检查点（最多 500 字符），如 page=2; next=?p=3; table=hn_posts; rows=60。",
    en: "Short resumable checkpoint (up to 500 chars), such as page=2; next=?p=3; table=hn_posts; rows=60.",
  },
  goalTimeout: {
    "zh-CN": "超时秒数；省略时使用默认超时。",
    en: "Timeout in seconds. Uses the default timeout if omitted.",
  },
});

export const modelT = createTranslator(messages);
