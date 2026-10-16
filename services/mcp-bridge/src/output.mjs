import { renderInputNotice, renderResult, sanitizeTerminalText } from "./terminal.mjs";

export function outputMode(options = {}, stdout, env = process.env) {
  const json = Boolean(options.json || (!options.plain && !stdout.isTTY));
  const color = !json && !options.plain && !options["no-color"] && Boolean(stdout.isTTY)
    && env.NO_COLOR === undefined && env.TERM !== "dumb" && env.FORCE_COLOR !== "0";
  return { json, color, width: stdout.columns || 80 };
}

/** Stream readable assistant text; all data from the model is stripped of terminal controls. */
export function createLiveOutput(parsed, { stdout, stderr, json = false, color = false, width = 80 }) {
  const shown = new Map();
  let lineOpen = false, streamed = false, waiting = false;
  const tint = (text, code) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const endLine = () => { if (lineOpen) stdout.write("\n"); lineOpen = false; };
  return {
    get streamed() { return streamed; },
    created(task) {
      if (json) return;
      stdout.write(renderResult(parsed, task, { color, width }));
      if (parsed.options.stream) stdout.write("\n");
      else stderr.write(`${stderr.isTTY && color ? "\u001b[90m" : ""}Waiting for the task…${stderr.isTTY && color ? "\u001b[0m" : ""}\n`);
    },
    update(event) {
      if (event.type === "input") {
        waiting = true;
        if (json) stderr.write(renderInputNotice(event, { width }));
        else {
          endLine();
          stdout.write(`\n${renderInputNotice({ ...event, waiting: true, clientId: event.clientId || parsed.options?.["client-id"] }, { color, width })}`);
          stdout.write(`${tint("Waiting for your response…", 90)}\n`);
        }
        return;
      }
      if (event.type === "status") {
        if (waiting && event.status === "running") {
          waiting = false;
          if (json) stderr.write("Task resumed.\n");
          else { endLine(); stdout.write(`${tint("Resumed", 90)}\n`); }
        }
        if (!json && parsed.options.stream && event.currentToolName && event.status === "running") {
          endLine();
          const tool = sanitizeTerminalText(event.currentToolName).replace(/\s+/gu, " ");
          stdout.write(`${tint(`› ${tool}`, 90)}\n`);
        }
        return;
      }
      if (json || !parsed.options.stream) return;
      if (!["text", "replace"].includes(event.type)) return;
      const text = sanitizeTerminalText(event.fullText);
      const previous = shown.get(event.messageId) || "";
      if (text === previous) return;
      const append = text.startsWith(previous);
      if (!append) { endLine(); stdout.write(`\n${tint("Revised response", 90)}\n`); }
      else if (!shown.has(event.messageId) && streamed) { endLine(); stdout.write("\n"); }
      const delta = append ? text.slice(previous.length) : text;
      stdout.write(delta);
      shown.set(event.messageId, text);
      streamed = true;
      lineOpen = !delta.endsWith("\n");
    },
    finish() { endLine(); if (streamed) stdout.write("\n"); },
  };
}
