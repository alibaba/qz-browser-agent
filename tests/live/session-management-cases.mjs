import assert from "node:assert/strict";

export async function runSessionManagementCases(h) {
  const { page, createSession, deleteSession, runPrompt, eventCount, eventsSince, waitEvent, requestWithoutId, send, historyMessages, messageText } = h;
  const parent = await createSession(page, "DeepSeek session management parent");
  const children = [];
  const checks = [];
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  const state = id => requestWithoutId(page, "get_state", { sessionId: id }, "state", 20000, { sessionId: id });
  async function manage(args, expectError = false) {
    const after = await eventCount(page);
    await runPrompt(page, parent, `这是隔离测试。请且仅请调用一次 manage_sessions，参数严格为 ${JSON.stringify(args)}。不要调用其他工具，不要等待目标任务完成，不要重试。工具返回后只回复已执行。`, { timeoutMs: 180000 });
    const calls = (await eventsSince(page, after)).filter(e => e.sessionId === parent && e.type === "tool_execution_end" && e.toolName === "manage_sessions");
    assert.equal(calls.length, 1, "model must invoke manage_sessions exactly once");
    assert.equal(Boolean(calls[0].isError), expectError, JSON.stringify(calls[0].result));
    return calls[0].result;
  }
  async function done(id, after) {
    await waitEvent(page, { type: "agent_end", sessionId: id }, after, 180000);
    assert.equal((await state(id)).status, "completed");
  }
  try {
    const afterCreate = await eventCount(page);
    const created = await manage({ action: "create", title: "live managed child", firstMessage: "不要调用工具。只回复 QZ_CREATED。" });
    const child = created.session.sessionId;
    children.push(child);
    await done(child, afterCreate);
    pass("create child with firstMessage");
    for (const mode of ["follow_up", "steer"]) {
      const after = await eventCount(page);
      const receipt = await manage({ action: "send_message", sessionId: child, message: `不要调用工具。只回复 QZ_IDLE_${mode}。`, mode });
      assert.equal(receipt.accepted, true);
      assert.equal(receipt.disposition, "started");
      await done(child, after);
      assert.ok((await historyMessages(page, child)).some(m => m.role === "assistant" && messageText(m).includes(`QZ_IDLE_${mode}`)));
      pass(`idle ${mode} starts a new run`);
    }
    // wait_for_user provides a stable real tool boundary while the parent submits messages.
    const afterWait = await eventCount(page);
    await manage({ action: "send_message", sessionId: child, message: "必须调用一次 wait_for_user，message 为 QZ_MANAGEMENT_GATE。等用户继续后回复 QZ_GATE_DONE。", mode: "follow_up" });
    const waiting = await waitEvent(page, { type: "waiting_for_user", sessionId: child }, afterWait, 180000);
    for (const [mode, marker] of [["follow_up", "QZ_QUEUED"], ["steer", "QZ_STEERED"]]) {
      const receipt = await manage({ action: "send_message", sessionId: child, message: `不要再调用工具或等待。只回复 ${marker}。`, mode });
      assert.equal(receipt.disposition, "queued");
    }
    const queued = await state(child);
    assert.deepEqual(queued.runtime.pendingFollowUps.map(item => ({ text: item.text, index: item.index })), [
      { text: "不要再调用工具或等待。只回复 QZ_QUEUED。", index: 0 },
    ]);
    assert.deepEqual(queued.runtime.pendingSteerings.map(item => ({ text: item.text, index: item.index })), [
      { text: "不要再调用工具或等待。只回复 QZ_STEERED。", index: 0 },
    ]);
    pass("running follow_up and steer enter separate queues");
    const afterResume = await eventCount(page);
    await send(page, "continue_task", { sessionId: child, waitId: waiting.waitId, payload: { continued: true } });
    await waitEvent(page, { type: "agent_end", sessionId: child, runId: waiting.runId }, afterResume, 180000);
    const next = await waitEvent(page, { type: "agent_start", sessionId: child }, afterResume, 180000);
    assert.notEqual(next.runId, waiting.runId);
    await waitEvent(page, { type: "agent_end", sessionId: child, runId: next.runId }, afterResume, 180000);
    const history = await historyMessages(page, child);
    const text = history.filter(m => m.role === "assistant").map(messageText).join("\n");
    assert.match(text, /QZ_STEERED/);
    assert.match(text, /QZ_QUEUED/);
    assert.ok(text.indexOf("QZ_STEERED") < text.indexOf("QZ_QUEUED"), "steering must be answered before follow-up");
    assert.deepEqual((await state(child)).runtime.pendingFollowUps, []);
    pass("steer resumes current run, follow_up starts the next run");

    const afterStopGate = await eventCount(page);
    await manage({ action: "send_message", sessionId: child, message: "必须调用 wait_for_user，message 为 QZ_STOP_GATE，然后等用户。" });
    await waitEvent(page, { type: "waiting_for_user", sessionId: child }, afterStopGate, 180000);
    const stop = await manage({ action: "stop", sessionId: child });
    assert.equal(stop.stopped, true);
    assert.equal((await state(child)).status, "aborted");
    pass("stop a waiting run");
    const secondStop = await manage({ action: "stop", sessionId: child });
    assert.equal(secondStop.stopped, false);
    pass("stop is repeatable on an idle task");
    const afterRestart = await eventCount(page);
    await manage({ action: "send_message", sessionId: child, message: "不要调用工具。只回复 QZ_AFTER_STOP。" });
    await done(child, afterRestart);
    pass("send_message restarts a stopped child");
    if (h.extended) {
      const gateStart = await eventCount(page);
      await manage({ action: "send_message", sessionId: child, message: "必须调用一次 wait_for_user，message 为 QZ_PRESERVE_GATE，然后等用户。" });
      await waitEvent(page, { type: "waiting_for_user", sessionId: child }, gateStart, 180000);
      await manage({ action: "send_message", sessionId: child, message: "不要调用工具。只回复 QZ_PRESERVED_STEER。", mode: "steer" });
      await manage({ action: "send_message", sessionId: child, message: "不要调用工具。只回复 QZ_PRESERVED_FOLLOW。", mode: "follow_up" });
      const afterStop = await eventCount(page);
      const stopped = await manage({ action: "stop", sessionId: child });
      assert.deepEqual(stopped.runtime.pendingSteerings.map(item => ({ text: item.text, index: item.index })), [
        { text: "不要调用工具。只回复 QZ_PRESERVED_STEER。", index: 0 },
      ]);
      assert.deepEqual(stopped.runtime.pendingFollowUps.map(item => ({ text: item.text, index: item.index })), [
        { text: "不要调用工具。只回复 QZ_PRESERVED_FOLLOW。", index: 0 },
      ]);
      const first = await waitEvent(page, { type: "agent_start", sessionId: child }, afterStop, 180000);
      await waitEvent(page, { type: "agent_end", sessionId: child, runId: first.runId }, afterStop, 180000);
      const all = await eventsSince(page, afterStop);
      let second = all.find(e => e.type === "agent_start" && e.sessionId === child && e.runId !== first.runId);
      if (!second) {
        const end = all.find(e => e.type === "agent_end" && e.runId === first.runId);
        const index = afterStop + all.indexOf(end) + 1;
        second = await waitEvent(page, { type: "agent_start", sessionId: child }, index, 180000);
      }
      await waitEvent(page, { type: "agent_end", sessionId: child, runId: second.runId }, afterStop, 180000);
      const restored = (await historyMessages(page, child)).filter(m => m.role === "assistant").map(messageText).join("\n");
      assert.match(restored, /QZ_PRESERVED_STEER/);
      assert.match(restored, /QZ_PRESERVED_FOLLOW/);
      assert.ok(restored.indexOf("QZ_PRESERVED_STEER") < restored.indexOf("QZ_PRESERVED_FOLLOW"), "preserved steering must be answered before follow-up");
      pass("stop preserves both queues and resumes steering before follow_up");

      const otherStart = await eventCount(page);
      const otherCreated = await manage({ action: "create", title: "isolated sibling", firstMessage: "必须调用 wait_for_user，message 为 QZ_SIBLING_GATE，然后等待用户。" });
      const other = otherCreated.session.sessionId;
      children.push(other);
      await waitEvent(page, { type: "waiting_for_user", sessionId: other }, otherStart, 180000);
      const childStart = await eventCount(page);
      await manage({ action: "send_message", sessionId: child, message: "不要调用工具。只回复 QZ_ISOLATED。" });
      await done(child, childStart);
      await manage({ action: "stop", sessionId: child });
      assert.equal((await state(other)).status, "waiting_user");
      pass("send and stop do not affect a sibling session");
      const last = await manage({ action: "last_messages", sessionId: child, num: 3 });
      assert.match(JSON.stringify(last), /QZ_ISOLATED/);
      await manage({ action: "wait", sessionId: child, timeout: 5 });
      pass("last_messages and wait can collect the continued task result");
      await manage({ action: "stop", sessionId: other });
      await manage({ action: "delete", sessionId: other });
      children.splice(children.indexOf(other), 1);
      await manage({ action: "send_message", sessionId: other, message: "do not revive deleted session" }, true);
      pass("sending to a deleted child does not recreate it");
    }
    await manage({ action: "send_message", sessionId: "nonexistent-live-session", message: "test" }, true);
    pass("missing target returns an error");
    await manage({ action: "stop", sessionId: parent }, true);
    pass("self-stop is rejected without stopping the caller");
    return { checks };
  } finally {
    for (const child of children) await deleteSession(page, child).catch(() => {});
    await deleteSession(page, parent).catch(() => {});
  }
}
