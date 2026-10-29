import assert from "node:assert/strict";

/** Install only in the isolated live-test panel; never changes rendering or stream timing. */
export function installLiveTableProbe() {
  globalThis.__liveTables?.stop();
  const frames = [], transitions = [], ids = new WeakMap();
  let nextId = 0, active = true;
  const id = table => {
    if (!ids.has(table)) ids.set(table, ++nextId);
    return ids.get(table);
  };
  const onTransition = event => {
    if (event.target.matches(".msg-assistant table")) transitions.push({
      id: id(event.target), type: event.type, property: event.propertyName, time: performance.now(),
    });
  };
  for (const type of ["transitionrun", "transitionend", "transitioncancel"]) document.addEventListener(type, onTransition);
  const sample = () => {
    if (!active) return;
    const messages = document.querySelector("#messages");
    const probe = globalThis.__liveTables;
    const answer = [...messages.querySelectorAll('.msg-assistant')].at(-1);
    frames.push({ time: performance.now(), pending: messages.querySelectorAll(".markdown-table-pending").length,
      phase: probe.phase, top: messages.scrollTop, height: messages.scrollHeight, client: messages.clientHeight, width: messages.clientWidth,
      tailGap: Math.max(0, messages.scrollHeight - messages.clientHeight - messages.scrollTop), contentLength: answer?.dataset.content?.length || 0,
      anchorConnected: probe.anchor?.isConnected || false, anchorTop: probe.anchor?.getBoundingClientRect().top ?? null, anchorBaseline: probe.baseline,
      tables: [...messages.querySelectorAll(".msg-assistant table")].map(table => {
        const rect = table.getBoundingClientRect();
        return { id: id(table), opacity: Number(getComputedStyle(table).opacity), width: rect.width, height: rect.height,
          columns: [...table.querySelectorAll("th")].map(cell => cell.getBoundingClientRect().width),
          rows: table.querySelectorAll("tbody tr").length };
      }) });
    requestAnimationFrame(sample);
  };
  globalThis.__liveTables = {
    phase: "interaction", anchor: null, baseline: null,
    stop() {
      active = false;
      for (const type of ["transitionrun", "transitionend", "transitioncancel"]) document.removeEventListener(type, onTransition);
      return { frames, transitions, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches };
    },
  };
  requestAnimationFrame(sample);
}

export function checkLiveTableReveal(probe) {
  const final = probe.frames.at(-1);
  assert.ok(final?.tables.length, "The real answer must contain a table");
  assert.equal(final.pending, 0, "No unfinished table placeholder remains");
  assert.equal(new Set(probe.frames.flatMap(frame => frame.tables.map(table => table.id))).size, final.tables.length,
    "Completed tables must retain their DOM nodes through later updates");
  assert.equal(probe.transitions.filter(event => event.type === 'transitioncancel').length, 0);
  const tables = final.tables.map(table => {
    const samples = probe.frames.flatMap(frame => frame.tables.filter(item => item.id === table.id));
    const runs = probe.transitions.filter(event => event.id === table.id && event.type === "transitionrun");
    const intermediate = samples.filter(sample => sample.opacity > 0 && sample.opacity < 1);
    assert.equal(samples.at(-1).opacity, 1);
    assert.ok(samples.every((sample, i) => !i || sample.opacity >= samples[i - 1].opacity), "Opacity never restarts during later text updates");
    assert.equal(new Set(samples.map(({ width, height, columns }) => JSON.stringify({ width, height, columns }))).size, 1,
      "Table geometry stays fixed throughout the reveal and later answer updates");
    assert.deepEqual(runs.map(event => event.property), probe.reducedMotion ? [] : ["opacity"]);
    if (!probe.reducedMotion) assert.ok(intermediate.length, "Real provider streaming must expose intermediate opacity frames");
    return { id: table.id, rows: table.rows, samples: samples.length, intermediateFrames: intermediate.length, transitions: runs.length };
  });
  return { tables, frames: probe.frames.length, placeholderFrames: probe.frames.filter(frame => frame.pending).length };
}
