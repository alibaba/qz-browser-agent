import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("automation visual storage handles absent keys and preserves cloned fixtures", async () => {
  const source = readFileSync(new URL("../tool-timeline/visual-check.py", import.meta.url), "utf8");
  const script = source.match(/def expect_sidepanel_automation_artifacts_smoke\([\s\S]*?page\.add_init_script\("""([\s\S]*?)"""\)/u)?.[1];
  assert.ok(script, "automation visual fixture must install its Chrome mock");
  const context = { window: {} };
  runInNewContext(script, context);
  const storage = context.window.chrome.storage.local;
  const missing = "_session_transcript_auto-session-1";

  assert.equal((await storage.get(missing))[missing], undefined);
  assert.equal((await storage.get([missing]))[missing], undefined);
  assert.equal((await storage.get({ [missing]: undefined }))[missing], undefined);
  assert.equal((await storage.get({ [missing]: null }))[missing], null);

  const key = "_session_auto-session-1";
  const record = (await storage.get([missing, key]))[key];
  assert.equal(record.transcript.length, 2);
  record.transcript.length = 0;
  assert.equal((await storage.get(key))[key].transcript.length, 2);
});
