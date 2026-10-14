const RULE_ID_BASE = 1_900_000_000;
const RULE_ID_LIMIT = RULE_ID_BASE + 1_000_000;

interface Options {
  runtime: Pick<typeof chrome.runtime, "id" | "getURL">;
  dnr: Pick<typeof chrome.declarativeNetRequest, "getSessionRules" | "updateSessionRules">;
  fetch: typeof fetch;
}

/** Bind packaged rules to this installation, including IDs assigned by the Web Store. */
export async function initializeProviderHeaderRules({ runtime, dnr, fetch }: Options) {
  const response = await fetch(runtime.getURL("rules/provider-headers.json"));
  if (!response.ok) throw new Error(`Provider header rules could not be loaded: ${response.status}`);
  const rules: chrome.declarativeNetRequest.Rule[] = await response.json();
  const addRules = rules.map(rule => {
    if (!Number.isSafeInteger(rule.id) || rule.id <= 0 || rule.id >= RULE_ID_LIMIT - RULE_ID_BASE) {
      throw new Error(`Invalid provider header rule ID: ${rule.id}`);
    }
    return {
      ...rule,
      id: RULE_ID_BASE + rule.id,
      condition: { ...rule.condition, initiatorDomains: [runtime.id] },
    };
  });
  const existing = await dnr.getSessionRules();
  await dnr.updateSessionRules({
    removeRuleIds: existing.filter(rule => rule.id > RULE_ID_BASE && rule.id < RULE_ID_LIMIT).map(rule => rule.id),
    addRules,
  });
}
