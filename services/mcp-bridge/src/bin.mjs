#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep this entry independent of the runtime and SDK until Node is validated.
let isEntry = false;
try { isEntry = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isEntry) {
  const argv = process.argv.slice(2);
  if (Number(process.versions.node.split(".")[0]) < 24) {
    const error = {
      code: "unsupported_node_version",
      message: `qz requires Node.js 24 or later. Current version: ${process.versions.node}.`,
      hint: "Install Node.js 24 or later, then run qz again.",
    };
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    else process.stderr.write(`${error.message}\n${error.hint}\n`);
    process.exitCode = 1;
  } else {
    const { main } = await import("./cli.mjs");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.exitCode = await main(argv, { signal: controller.signal });
  }
}
