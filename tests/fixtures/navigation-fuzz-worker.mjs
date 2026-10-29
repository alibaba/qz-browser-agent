import { createToolRuntime, releaseRunCdp } from "./background/tools/runtime.js";
import { createSessionTabs } from "./background/session/tabs.js";

// Copied into an isolated test extension. All ownership and tool execution below
// use production modules; only Session persistence and test control are supplied.
const states = new Map(), runs = new Map(), calls = new Map(), testTabs = new Set();
let serial = 0, epoch = 0;
const runKey = run => `${epoch}:${run}`;
const isRunCurrent = (id, run) => states.has(id) && runKey(runs.get(id)) === run;
const setRuntime = (id, patch) => {
  const next = Object.assign(states.get(id) || {}, patch); states.set(id, next); return next;
};
const sessions = createSessionTabs({
  supervisor: { getRuntime: id => states.get(id), runtimeEntries: () => [...states], setRuntime, isRunCurrent },
  tabsApi: chrome.tabs, storage: chrome.storage.local, setRuntime, persistRuntime: async () => {},
  getSessions: async () => Object.fromEntries([...states.keys()].map(id => [id, { id }])),
});
chrome.tabs.onCreated.addListener(tab => testTabs.add(tab.id));
chrome.tabs.onRemoved.addListener(id => { testTabs.delete(id); void sessions.handleTabRemoved(id); });
const runtime = createToolRuntime({ sessions: { ...sessions, isRunCurrent },
  windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
});

globalThis.navigationFuzz = async request => {
  const id = request.sessionId || "fuzz-a";
  if (request.op === "reset") {
    for (const call of calls.values()) call.controller.abort();
    for (const tabId of testTabs) try { await chrome.tabs.remove(tabId); } catch {}
    testTabs.clear();
    states.clear(); runs.clear(); calls.clear();
    epoch++;
    for (const sessionId of ["fuzz-a", "fuzz-b"]) {
      states.set(sessionId, { sessionId, ownedTabIds: [], workingTabId: null }); runs.set(sessionId, "run");
    }
    await chrome.storage.local.set({ securityGuardrails: {} });
    return true;
  }
  if (request.op === "start") {
    const callId = String(++serial), controller = new AbortController();
    const call = { controller, settled: false, result: null };
    calls.set(callId, call);
    void runtime.execute(request.name, request.args, controller.signal, {
      sessionId: id, runId: runKey(request.runId || "run"), toolCallId: callId,
      preserveWorkingTab: !["open_tab", "navigate", "close_tab"].includes(request.name),
    }).then(async result => {
      // Keep images out of the transport/report while retaining evidence of capture.
      if (result?._image) {
        const { _image, ...rest } = result;
        let imagePixel;
        if (request.name === "screenshot") {
          const bitmap = await createImageBitmap(await (await fetch(_image)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), drawing = canvas.getContext("2d");
          drawing.drawImage(bitmap, 0, 0); bitmap.close();
          imagePixel = Array.from(drawing.getImageData(5, 5, 1, 1).data);
        }
        call.result = { ...rest, imageBytes: _image.length, imagePixel };
      } else call.result = result;
    }).catch(error => { call.result = { error: error.message, code: error.code, details: error.details }; })
      .finally(() => { call.settled = true; });
    return callId;
  }
  if (request.op === "poll") {
    const call = calls.get(request.callId);
    return { settled: call.settled, result: call.result };
  }
  if (request.op === "abort") { calls.get(request.callId).controller.abort(); return true; }
  if (request.op === "obsolete") { runs.set(id, "next-run"); return true; }
  if (request.op === "release-run") { await releaseRunCdp(id, runKey(request.runId || "run")); return true; }
  if (request.op === "delete") {
    states.delete(id); runs.delete(id);
    for (const call of request.callIds || []) calls.get(call)?.controller.abort();
    return true;
  }
  if (request.op === "transfer") {
    const previous = states.get(id), next = states.get(request.to);
    previous.ownedTabIds = previous.ownedTabIds.filter(tabId => tabId !== request.tabId);
    next.ownedTabIds.push(request.tabId);
    return true;
  }
  if (request.op === "tab") { try { return await chrome.tabs.get(request.tabId); } catch { return null; } }
  if (request.op === "close") { await chrome.tabs.remove(request.tabId); return true; }
  if (request.op === "update") return await chrome.tabs.update(request.tabId, { url: request.url });
  if (request.op === "state") return structuredClone(states.get(id) || null);
  if (request.op === "security") { await chrome.storage.local.set({ securityGuardrails: request.rules }); return true; }
  throw new Error(`Unknown fuzz operation: ${request.op}`);
};
