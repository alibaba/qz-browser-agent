import { randomUUID } from "node:crypto";

const browsers = new WeakMap();

/** Register a synthetic browser through the production pairing API. */
export async function pairBrowser(state, { id = "browser", ...details } = {}) {
  let entries = browsers.get(state);
  if (!entries) browsers.set(state, entries = new Map());
  if (!entries.has(id)) {
    const paired = await state.pair({ clientId: randomUUID(), connectionId: randomUUID(), instanceId: state.instanceId, name: id });
    entries.set(id, { ...paired, id: paired.clientId, pairingVersion: 1 });
  }
  return { ...entries.get(id), ...details };
}

export function browserId(state, name = "browser") {
  return browsers.get(state)?.get(name)?.clientId;
}

export async function pollBrowser(state, browser, options) {
  return state.poll(await pairBrowser(state, browser), options);
}

/** Attach the actual paired sender proof; an unknown sender remains unauthenticated. */
export function resultPayload(state, requestId, payload) {
  const target = payload.clientId || state.inflight.get(requestId)?.clientId;
  const entries = browsers.get(state);
  const proof = entries?.get(target) || [...(entries?.values() || [])].find(browser => browser.clientId === target);
  return proof ? { ...proof, ...payload, clientId: proof.clientId } : payload;
}

export function completeBrowser(state, requestId, payload) {
  return state.complete(requestId, resultPayload(state, requestId, payload));
}
