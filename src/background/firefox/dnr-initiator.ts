/** Rewrite initiatorDomains that use Firefox's email-shaped runtime.id. */

const MARK = "qzFirefoxInitiator";

export function installInitiatorRewrite(chromeApi: InitiatorChrome): void {
  const dnr = chromeApi.declarativeNetRequest;
  if (!dnr) return;
  wrap(chromeApi, dnr, "updateSessionRules");
  wrap(chromeApi, dnr, "updateDynamicRules");
}

function wrap(chromeApi: InitiatorChrome, dnr: DeclarativeNetRequest, name: "updateSessionRules" | "updateDynamicRules") {
  const current = dnr[name];
  if (typeof current !== "function" || (current as Marked)[MARK]) return;
  const original = current.bind(dnr);
  const wrapped: Marked = (update: RuleUpdate) => {
    if (!Array.isArray(update?.addRules)) return original(update);
    return original({ ...update, addRules: rewrite(chromeApi, update.addRules) });
  };
  wrapped[MARK] = true;
  dnr[name] = wrapped;
}

function rewrite(chromeApi: InitiatorChrome, rules: Rule[] | undefined): Rule[] | undefined {
  if (!Array.isArray(rules)) return rules;
  const runtime = chromeApi.runtime;
  const id = String(runtime?.id || "");
  let host = "";
  try { host = new URL(String(runtime?.getURL?.("/") || "")).hostname; } catch { host = ""; }
  if (!id || !host || host === id) return rules;
  return rules.map(rule => {
    const domains = rule?.condition?.initiatorDomains;
    if (!Array.isArray(domains) || !domains.includes(id)) return rule;
    return { ...rule, condition: { ...rule.condition, initiatorDomains: domains.map(domain => domain === id ? host : domain) } };
  });
}

interface Rule { condition?: { initiatorDomains?: string[] } }
interface RuleUpdate { addRules?: Rule[]; removeRuleIds?: number[] }
type Marked = ((update: RuleUpdate) => unknown) & { [MARK]?: boolean };
interface DeclarativeNetRequest {
  updateSessionRules?: Marked;
  updateDynamicRules?: Marked;
}
interface InitiatorChrome {
  runtime?: { id?: string; getURL?(path: string): string };
  declarativeNetRequest?: DeclarativeNetRequest;
}
