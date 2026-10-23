import type { CdpCommand } from "../../sdk/background/browser.js";

export interface ChildFrame {
  id: string;
  loaderId: string;
  sessionId: string;
  send: CdpCommand;
}

// Flattened iframe targets for one direct child level. Detach drops the tab;
// a detached child session drops that session. Context ids live in isolatedByTab.
const attachedByTab = new Map<number, AttachedChild[]>();
const armedConnectionByTab = new Map<number, number>();

interface AttachedChild {
  sessionId: string;
  targetId: string;
  parentFrameId: string;
}

globalThis.chrome?.debugger?.onEvent?.addListener((source, method, params) => noteDebuggerEvent(source, method, params));
globalThis.chrome?.debugger?.onDetach?.addListener(source => {
  const tabId = Number(source?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  attachedByTab.delete(tabId);
  armedConnectionByTab.delete(tabId);
});

/** Direct child documents only. Nested frames stay on their parent as an iframe node. */
export async function directChildFrames(send: CdpCommand): Promise<ChildFrame[]> {
  const { mainId, frames } = await readMainTree(send);
  if (!mainId || !send.inSession) return frames;
  const remote = await autoAttachedFrames(send, mainId, new Set(frames.map(frame => frame.id)));
  return [...frames, ...remote];
}

/** The page-target session for a same-origin child, or the child target session for a cross-site iframe. */
export async function openChildFrame(send: CdpCommand, frameId: string): Promise<ChildFrame | null> {
  const wanted = String(frameId || "");
  if (!wanted) return null;
  const { mainId, frames } = await readMainTree(send);
  const local = frames.find(frame => frame.id === wanted);
  if (local || !mainId || !send.inSession) return local || null;
  const remote = await autoAttachedFrames(send, mainId, new Set(frames.map(frame => frame.id)));
  return remote.find(frame => frame.id === wanted) || null;
}

/** Content-box origin of an iframe element, in the root viewport. Null when the frame is not measurable. */
export async function frameContentOrigin(send: CdpCommand, frameId: string): Promise<{ x: number; y: number } | null> {
  const id = String(frameId || "");
  if (!id) return null;
  try {
    const owner = record(await send("DOM.getFrameOwner", { frameId: id }));
    const backendNodeId = Number(owner.backendNodeId || 0);
    if (!backendNodeId) return null;
    const described = record(await send("DOM.getBoxModel", { backendNodeId }));
    const content = record(described.model).content;
    if (!Array.isArray(content) || content.length < 2) return null;
    const x = Number(content[0]);
    const y = Number(content[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

async function readMainTree(send: CdpCommand): Promise<{ mainId: string; frames: ChildFrame[] }> {
  let tree: unknown;
  try { tree = await send("Page.getFrameTree"); }
  catch { return { mainId: "", frames: [] }; }
  const root = record(record(tree).frameTree);
  const mainId = String(record(root.frame).id || "");
  if (!mainId) return { mainId: "", frames: [] };
  const frames: ChildFrame[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(root.childFrames) ? root.childFrames : []) {
    const frame = record(record(entry).frame);
    const id = String(frame.id || "");
    if (!id || id === mainId || seen.has(id)) continue;
    seen.add(id);
    frames.push({ id, loaderId: String(frame.loaderId || ""), sessionId: "", send });
  }
  return { mainId, frames };
}

/**
 * A cross-site iframe is a separate target and is omitted from the page frame tree.
 * Auto-attach reports that target on this tab session; nested targets keep their own parent.
 */
async function autoAttachedFrames(send: CdpCommand, mainId: string, localIds: Set<string>): Promise<ChildFrame[]> {
  const tabId = Number(send.tabId);
  const connectionId = Number(send.connectionId) || 0;
  if (!Number.isInteger(tabId) || tabId <= 0 || !send.inSession) return [];
  if (armedConnectionByTab.get(tabId) !== connectionId) {
    try {
      await send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }, { type: "worker", exclude: true }],
      });
    } catch {
      return [];
    }
    armedConnectionByTab.set(tabId, connectionId);
  }
  const frames: ChildFrame[] = [];
  for (const attached of attachedByTab.get(tabId) || []) {
    if (attached.parentFrameId !== mainId) continue;
    const child = send.inSession(attached.sessionId);
    const described = await describeChild(child, localIds);
    if (!described) continue;
    frames.push({ ...described, sessionId: attached.sessionId, send: child });
  }
  return frames;
}

async function describeChild(send: CdpCommand, localIds: Set<string>): Promise<{ id: string; loaderId: string } | null> {
  let childTree: unknown;
  try { childTree = await send("Page.getFrameTree"); }
  catch { return null; }
  const frame = record(record(record(childTree).frameTree).frame);
  const id = String(frame.id || "");
  if (!id || localIds.has(id)) return null;
  localIds.add(id);
  return { id, loaderId: String(frame.loaderId || "") };
}

function noteDebuggerEvent(source: { tabId?: number; sessionId?: string }, method: string, params?: object): void {
  const tabId = Number(source?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const payload = record(params);
  if (method === "Target.detachedFromTarget") {
    const sessionId = String(payload.sessionId || source?.sessionId || "");
    const current = attachedByTab.get(tabId);
    if (!current || !sessionId) return;
    const next = current.filter(item => item.sessionId !== sessionId);
    if (next.length) attachedByTab.set(tabId, next);
    else attachedByTab.delete(tabId);
    return;
  }
  if (method !== "Target.attachedToTarget") return;
  const info = record(payload.targetInfo);
  if (info.type !== "iframe") return;
  const sessionId = String(payload.sessionId || source?.sessionId || "");
  const parentFrameId = String(info.parentFrameId || "");
  const targetId = String(info.targetId || "");
  if (!sessionId || !parentFrameId) return;
  const current = attachedByTab.get(tabId) || [];
  const next = current.filter(item => item.targetId !== targetId && item.sessionId !== sessionId);
  next.push({ sessionId, targetId, parentFrameId });
  attachedByTab.set(tabId, next);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
