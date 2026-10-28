#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizer } from "acorn";
import { loadExtension, loadRules, runRules, formatJson } from "storecheck";

const STORECHECK_VERSION = "0.1.0";
const SANDBOX_TOKENS = "be360135e3b288b310f1fd14dfac454cc9620223262b2be8b1012c04fbb5a8eb";
const REQUIRED_CLEAN = /^(?:code\/(?:obfuscated-code|minified-without-source)|privacy\/(?:remote-code-execution|remote-script-tag)|csp\/)/u;
const identity = finding => JSON.stringify([finding.ruleId, finding.file, finding.line, finding.message]);

/** Storecheck 0.1.0 has no ignore config. Its public Rule API permits this exact report adapter. */
export function reviewedSandboxFinding(source, finding) {
  if (finding.file !== "runner-sandbox.js" || finding.message !==
      "new Function( - new Function() compiles a string into executable code. Manifest V3 requires that the full functionality of an extension be discernible from the submitted code, so remotely sourced logic is not allowed.") return false;
  const manifest = source.manifest;
  if (JSON.stringify(manifest?.sandbox?.pages) !== '["runner-sandbox.html"]' ||
      manifest?.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self';" ||
      manifest?.content_security_policy?.sandbox !== "sandbox allow-scripts; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; child-src blob:;") return false;
  const runtime = source.file("runner-sandbox.js")?.text();
  const html = source.file("runner-sandbox.html")?.text();
  if (!runtime || !html || !/<script src="runner-sandbox\.js"><\/script>/u.test(html) ||
      !runtime.split("\n")[finding.line - 1]?.includes('new Function("input", "args", "$plugin", "tools", "tool", "trace", "log", "tabId"')) return false;
  const digest = createHash("sha256").update(JSON.stringify([...tokenizer(runtime, { ecmaVersion: "latest" })].map(token => [token.type.label, token.value]))).digest("hex");
  return digest === SANDBOX_TOKENS;
}

export async function checkStore(path) {
  const cli = fileURLToPath(new URL("cli.js", import.meta.resolve("storecheck")));
  const installed = JSON.parse(await readFile(resolve(dirname(cli), "../../package.json"), "utf8"));
  if (installed.version !== STORECHECK_VERSION) throw new Error("storecheck version changed; review rules and the scoped exception");
  // Always run the unmodified CLI against the final directory/ZIP. Preserve its real exit status.
  const raw = spawnSync(process.execPath, [cli, resolve(path), "--severity=error", "--json"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
  });
  if (raw.error || ![0, 1].includes(raw.status)) throw new Error(`storecheck failed to execute: ${raw.error?.message || raw.stderr}`);
  const cliReport = JSON.parse(raw.stdout);
  if (cliReport.ruleErrors.length) throw new Error(`storecheck rule failures: ${JSON.stringify(cliReport.ruleErrors)}`);
  const source = loadExtension(resolve(path));
  const rules = await loadRules();
  if (rules.length !== 24) throw new Error(`storecheck registry changed: expected 24 rules, got ${rules.length}`);
  const exceptions = [];
  const adapted = rules.map(loaded => loaded.meta.id !== "privacy/remote-code-execution" ? loaded : {
    ...loaded,
    rule: { ...loaded.rule, check(context) {
      return loaded.rule.check({ ...context, report(finding) {
        if (reviewedSandboxFinding(source, finding)) {
          exceptions.push({ ...finding, ruleId: loaded.meta.id, severity: loaded.meta.severity,
            category: loaded.meta.category, title: loaded.meta.title, policyRef: loaded.meta.policyRef,
            rejectionCodes: loaded.meta.rejectionCodes,
            reason: "Exact packaged inner-runner in a manifest-declared opaque-origin sandbox Worker. No extension APIs; existing user/Agent script capability. See docs/store-code-audit.md; this is not a CWS approval." });
        } else context.report(finding);
      } });
    } },
  });
  const result = await runRules(source, { rules: adapted });
  const effective = JSON.parse(formatJson(result, rules.length));
  const accepted = new Set(exceptions.map(identity));
  const cliUnresolved = cliReport.findings.filter(finding => !accepted.has(identity(finding)));
  const blocking = effective.findings.filter(finding => finding.severity === "error" || REQUIRED_CLEAN.test(finding.ruleId));
  const ok = exceptions.length <= 1 && !cliUnresolved.length && !blocking.length && !effective.ruleErrors.length;
  return { version: 1, storecheck: STORECHECK_VERSION, ok, rawCliExitCode: raw.status, rawCli: cliReport,
    rawFindings: [...effective.findings, ...exceptions.map(({ reason, ...finding }) => finding)],
    exceptions, effective, blocking };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [path, output] = process.argv.slice(2);
  if (!path) throw new Error("usage: node scripts/check-store.mjs <extension-directory-or-zip> [report.json]");
  const report = await checkStore(path);
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
