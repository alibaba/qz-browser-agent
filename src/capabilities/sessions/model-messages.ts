import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("sessions-model", {
  getLocation: {
    en: "Get the user's current latitude, longitude, accuracy in meters, and location timestamp. Call only when the user's task needs local information. Takes no arguments. First use waits for the user's permission in the side panel; later calls reuse that permission. Requires an open side panel and device location access. If unavailable or declined, ask for a city or area and continue without precise location.",
    "zh-CN": "获取用户当前经纬度、精度（米）和定位时间。仅在用户任务需要本地信息时调用，无需参数。首次使用在侧边栏等待用户同意，后续调用沿用该选择。需要打开侧边栏并允许设备定位。定位不可用或用户拒绝时，询问城市或区域，继续处理任务。",
  },
  manageSessionsWithoutAutomations: {
    "zh-CN": "管理轻舟 sessions。create 会创建当前 session 的子任务，并可通过 firstMessage 派发异步后台任务；send_message 向已有 session 追加任务（mode=follow_up 在当前 run 后执行；mode=steer 在完整 turn 边界介入，空闲时直接启动）；stop 终止目标当前 run，保留排队消息。list/last_messages/wait/delete 管理普通 session。last_messages 和 wait 回收任务结果时会自动附带每个任务的 artifacts 产物索引（图集、数据表、文件句柄），便于上层继续打开、引用或下载，不会返回大表/文件正文。Firefox 中已停用定时任务，已保存的定时任务不会执行。",
    en: "Manage qz sessions. create starts a child session and can dispatch an asynchronous background task through firstMessage. send_message adds work to an existing session: mode=follow_up runs after the current run; mode=steer is delivered at a complete turn boundary; an idle session starts immediately. stop ends the target's current run but preserves queued messages. Use list/last_messages/wait/delete for ordinary sessions. last_messages and wait include each task's artifacts index (image collections, Data tables, and file handles) for opening, referencing, or downloading results, without returning large tables or file contents. Session automations are disabled in Firefox. Stored scheduled tasks do not run.",
  },
  sessionAutomationsDisabled: {
    "zh-CN": "Firefox 中已停用定时任务，已保存的定时任务不会执行。",
    en: "Session automations are disabled in Firefox. Stored scheduled tasks do not run.",
  },
  sessionActionWithoutAutomations: {
    "zh-CN": "操作类型。分支必填：delete/last_messages/stop 需 sessionId；send_message 需 sessionId 和 message；wait 需 sessionIds 或 sessionId。",
    en: "Operation. delete/last_messages/stop requires sessionId; send_message requires sessionId and message; wait requires sessionIds or sessionId.",
  },
  manageSessions: {
    "zh-CN": "管理轻舟 sessions 和定时任务。create 会创建当前 session 的子任务，并可通过 firstMessage 派发异步后台任务；send_message 向已有 session 追加任务（mode=follow_up 在当前 run 后执行；mode=steer 在完整 turn 边界介入，空闲时直接启动）；stop 终止目标当前 run，保留排队消息。list/last_messages/wait/delete 管理普通 session。last_messages 和 wait 回收任务结果时会自动附带每个任务的 artifacts 产物索引（图集、数据表、文件句柄），便于上层继续打开、引用或下载，不会返回大表/文件正文。常见固化流程：先在当前临时对话里跑通方法，再用 create_automation 把明确 instruction、schedule、missedPolicy、notifyPolicy 保存成本地定时任务；list_automations 查看定时任务规则；automation_runs 查看某条定时任务的运行记录；run_automation 立即运行一次；update_automation 修改配置；delete_automation 删除规则及运行记录。",
    en: "Manage qz sessions and automations. create starts a child session and can dispatch an asynchronous background task through firstMessage. send_message adds work to an existing session: mode=follow_up runs after the current run; mode=steer is delivered at a complete turn boundary; an idle session starts immediately. stop ends the target's current run but preserves queued messages. Use list/last_messages/wait/delete for ordinary sessions. last_messages and wait include each task's artifacts index (image collections, Data tables, and file handles) for opening, referencing, or downloading results, without returning large tables or file contents. To automate a workflow, first verify it in the current temporary conversation, then save explicit instruction, schedule, missedPolicy, and notifyPolicy with create_automation. list_automations lists rules; automation_runs lists a rule's run history; run_automation runs it immediately; update_automation edits it; delete_automation removes the rule and run history.",
  },
  sessionAction: {
    "zh-CN": "操作类型。分支必填：delete/last_messages/stop 需 sessionId；send_message 需 sessionId 和 message；wait 需 sessionIds 或 sessionId；create_automation 需 title 和 instruction；update/delete/run/automation_runs 需 automationId。",
    en: "Operation. delete/last_messages/stop requires sessionId; send_message requires sessionId and message; wait requires sessionIds or sessionId; create_automation requires title and instruction; update_automation/delete_automation/run_automation/automation_runs requires automationId.",
  },
  sessionId: {
    "zh-CN": "delete/last_messages/stop/send_message 目标 session id",
    en: "Target session ID for delete/last_messages/stop/send_message.",
  },
  sessionMessage: {
    "zh-CN": "send_message 发送给已有任务的消息正文",
    en: "Message to send to an existing task with send_message.",
  },
  sessionMessageMode: {
    "zh-CN": "send_message 投递方式，默认 follow_up；steer 在当前完整 turn 后接收；空闲任务直接启动。",
    en: "Delivery mode for send_message. Default: follow_up. steer is received after the current complete turn. Idle tasks start immediately.",
  },
  automationId: {
    "zh-CN": "update_automation/delete_automation/run_automation/automation_runs 的目标 automation id",
    en: "Target automation ID for update_automation/delete_automation/run_automation/automation_runs.",
  },
  sessionIds: {
    "zh-CN": "wait 目标 session id 列表",
    en: "Session IDs to wait for.",
  },
  sessionWaitFor: {
    "zh-CN": "wait 时等待其中之一完成(any)或全部完成(all)，默认 all。用户要求先检查最先完成项、再汇总全部时，先调用 any，再对同一批 sessionIds 调用 all。",
    en: "Wait for any or all sessions to finish. Default: all. If the user wants to inspect the first result before summarizing all results, call any first, then all with the same sessionIds.",
  },
  sessionTitle: {
    "zh-CN": "create 的子 session 标题，或 create_automation 的定时任务标题；短而具体",
    en: "Short, specific child-session title for create, or automation title for create_automation.",
  },
  sessionFirstMessage: {
    "zh-CN": "create 后发送给新 session agent 的第一句话；传入后该 session 会在后台开始运行",
    en: "Initial message for the new session's agent after create. Providing it starts the session in the background.",
  },
  automationInstruction: {
    "zh-CN": "create_automation/update_automation 的定时任务执行说明。应沉淀已跑通的方法、目标页面、输出格式、数据表、异常处理要求。",
    en: "Instructions for create_automation/update_automation. Capture the verified method, target pages, output format, Data tables, and failure handling.",
  },
  automationSchedule: {
    "zh-CN": "定时任务调度规则。本地版支持 once/hourly/daily/weekly。单次运行使用 type=once，并必须提供 runAt；推荐 ISO 8601 北京时间格式，避免空格丢失。",
    en: "Local schedule supporting once/hourly/daily/weekly. For a one-time run, use type=once and supply runAt. Prefer ISO 8601 with the Beijing time offset to avoid losing spaces.",
  },
  automationScheduleType: {
    "zh-CN": "once 单次运行；hourly 每小时/每 N 分钟；daily 每天；weekly 每周",
    en: "once: one-time run; hourly: every hour or N minutes; daily: every day; weekly: every week.",
  },
  automationRunAt: {
    "zh-CN": "once 必填。推荐 ISO 8601 北京时间 YYYY-MM-DDTHH:mm:ss+08:00，如 2026-07-08T09:30:00+08:00；兼容旧格式 YYYY-MM-DD HH:mm:ss。",
    en: "Required for once. Prefer ISO 8601 Beijing time: YYYY-MM-DDTHH:mm:ss+08:00, for example 2026-07-08T09:30:00+08:00. The legacy YYYY-MM-DD HH:mm:ss format is also accepted.",
  },
  automationTime: {
    "zh-CN": "daily/weekly 的北京时间 HH:mm，如 09:00",
    en: "Beijing time in HH:mm format for daily/weekly, for example 09:00.",
  },
  automationWeekday: {
    "zh-CN": "weekly 使用，1=周一 ... 7=周日",
    en: "Day of the week for weekly: 1=Monday through 7=Sunday.",
  },
  automationIntervalMinutes: {
    "zh-CN": "hourly/interval 使用，支持 5、15、30、60；优先使用该字段",
    en: "Interval for hourly/interval. Supports 5, 15, 30, or 60 minutes. Prefer this field.",
  },
  automationIntervalHours: {
    "zh-CN": "兼容旧字段，hourly 使用；会转换为 intervalMinutes",
    en: "Legacy hourly interval, converted to intervalMinutes.",
  },
  automationMissedPolicy: {
    "zh-CN": "本机离线/睡眠漏跑后的处理：run_once 恢复后补跑一次；latest_only 只检查最新状态；skip 跳过漏跑。",
    en: "Handle runs missed while the computer was offline or asleep: run_once catches up once; latest_only checks only the latest state; skip skips missed runs.",
  },
  automationNotifyPolicy: {
    "zh-CN": "通知策略：failure 仅异常；always 每次完成；silent 静默记录。",
    en: "Notification policy: failure notifies only on failures; always notifies after each run; silent records runs without notifications.",
  },
  automationEnabled: {
    "zh-CN": "定时任务是否启用。create_automation 默认 true；update_automation 可修改。",
    en: "Whether the automation is enabled. Defaults to true for create_automation; editable with update_automation.",
  },
  sessionListLimit: {
    "zh-CN": "list 返回数量，默认 100",
    en: "Maximum results for list. Default: 100.",
  },
  automationRunLimit: {
    "zh-CN": "list_automations 每条定时任务附带的最近运行记录数量，默认 3",
    en: "Recent runs to include for each automation in list_automations. Default: 3.",
  },
  sessionMessageLimit: {
    "zh-CN": "last_messages 返回最近消息数量，默认 5，最大 50",
    en: "Recent messages returned by last_messages. Default: 5; maximum: 50.",
  },
  sessionWaitTimeout: {
    "zh-CN": "wait 等待秒数；不填或 <=0 表示无限等待，>0 表示最多等待对应秒数后返回当前子 session 快照；其他 action 可不填。",
    en: "Seconds to wait. Omitted or <=0 means no time limit. A positive value returns the current child-session snapshots after at most that many seconds. Optional for other actions.",
  },
  manageGoal: {
    "zh-CN": "管理当前 session 的目标追踪状态。适合长流程采集、翻页、批处理、跨多个工具步骤的任务，避免执行过程中忘记目标和检查点。使用方式：长流程开始时 create；每次已经写入 data_store、图集或文件等 durable 进展后 checkpoint；遇到阻塞时 block 写明 progress/next；完成前先用相关工具验证 criteria，再 complete。goal 只记录短目标、完成标准、进展、下一步和检查点；大表、大数组、正文、DOM、图片和文件内容不要写入 goal。",
    en: "Track the current session's goal for long collection, pagination, batch, or multi-tool workflows so objectives and checkpoints are not lost. Use create at the start; checkpoint after durable progress is saved to data_store, an image collection, or a file; block with progress/next when blocked; verify criteria with relevant tools before complete. Keep only a short objective, completion criteria, progress, next step, and checkpoint. Do not put large tables, arrays, document text, DOM, images, or file contents in goal.",
  },
  goalAction: {
    "zh-CN": "目标动作。分支必填：create 需 objective 和 criteria；block 需 progress 和 next。checkpoint/update 用 progress/next/checkpoint 更新短状态；complete 前先验证完成标准。",
    en: "Goal operation. create requires objective and criteria; block requires progress and next. checkpoint/update changes short progress/next/checkpoint fields. Verify completion criteria before complete.",
  },
  goalObjective: {
    "zh-CN": "任务目标，create 时建议填写一句话。例：采集 Hacker News 前 3 页帖子并写入 hn_posts。",
    en: "Task objective, preferably one sentence for create. Example: collect posts from the first 3 Hacker News pages into hn_posts.",
  },
  goalCriteria: {
    "zh-CN": "完成标准，create 时建议填写；complete 前必须用工具结果验证。例：3 页完成、写入 hn_posts、按 link 去重、验证行数。",
    en: "Completion criteria for create. Verify them with tool results before complete. Example: finish 3 pages, write to hn_posts, deduplicate by link, and verify the row count.",
  },
  goalProgress: {
    "zh-CN": "当前进展短句。例：第 2 页已写入，累计 60 条。",
    en: "Brief progress update. Example: page 2 saved; 60 rows total.",
  },
  goalNext: {
    "zh-CN": "下一步动作短句。例：打开第 3 页继续采集。",
    en: "Brief next step. Example: open page 3 and continue collecting.",
  },
  goalCheckpoint: {
    "zh-CN": "可恢复执行的短检查点，可写 page/cursor/table/count/url 等少量信息。例：page=2; next=?p=3; table=hn_posts; rows=60。",
    en: "Short resumable checkpoint with a few fields such as page/cursor/table/count/url. Example: page=2; next=?p=3; table=hn_posts; rows=60.",
  },
  goalTimeout: {
    "zh-CN": "工具硬超时，单位秒。不填时系统按工具类型给出默认值；需要长等待时显式设置。",
    en: "Hard tool timeout in seconds. If omitted, uses the tool type's default. Set explicitly for long waits.",
  },
});

export const modelT = createTranslator(messages);
