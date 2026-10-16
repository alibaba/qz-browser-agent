import { QzError } from "./client.mjs";
import { COMMANDS } from "./commands.mjs";

const record = value => value && typeof value === "object" && !Array.isArray(value);

/** Parse a settings patch before discovering a connection or changing browser state. */
export function settingsPatch(id, value, json = {}) {
  let config = json;
  if (id !== undefined) {
    let parsed = value;
    try { parsed = JSON.parse(value); } catch { /* An unquoted CLI value is a string. */ }
    config = { [id]: parsed };
  }
  if (!record(config) || !Object.keys(config).length) throw new QzError("invalid_arguments", "Settings must be a non-empty JSON object.");
  if (Object.keys(config).some(key => !key.trim() || ["__proto__", "prototype", "constructor"].includes(key))) {
    throw new QzError("invalid_arguments", "Settings contain an invalid field name.");
  }
  return config;
}

/** Direct resource commands share the MCP operations and parameter names. */
export function resourceRequest(parsed, config) {
  const route = COMMANDS[parsed.command]?.actions?.[parsed.action];
  return route?.tool ? { name: route.tool, args: route.args(parsed, config) } : null;
}
