import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoRemoteCode, findRemoteCode } from "../../scripts/check-no-remote-code.mjs";

const root = await mkdtemp(join(tmpdir(), "qz-remote-code-"));
try {
  await mkdir(join(root, "vendor/mathjax"), { recursive: true });
  await mkdir(join(root, "sidepanel"), { recursive: true });
  await writeFile(join(root, "vendor/mathjax/startup.js"), "/* local MathJax startup */");
  await writeFile(join(root, "vendor/provenance.json"), '{"source":"https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"}\n');
  await assertNoRemoteCode([root]);

  await writeFile(join(root, "sidepanel/panel.js"), 'const remote = "https://cdn.jsdelivr.net/npm/mathjax/es5/tex-svg.js";');
  const hits = await findRemoteCode([root]);
  assert.deepEqual(hits.map(hit => `${hit.file}:${hit.host}`), ["sidepanel/panel.js:cdn.jsdelivr.net"]);
  await assert.rejects(assertNoRemoteCode([root]), /sidepanel\/panel\.js:\d+ cdn\.jsdelivr\.net/u);

  await writeFile(join(root, "sidepanel/panel.js"), 'const metadata = "https://raw.githubusercontent.com/example/repo";');
  await assert.rejects(assertNoRemoteCode([root]), /raw\.githubusercontent\.com/u);

  await writeFile(join(root, "sidepanel/panel.js"), "const local = true;");
  await writeFile(join(root, "sidepanel/export.html"), '<script defer src="https://registry.npmmirror.com/mathjax/3.2.2/files/es5/tex-svg.js"></script>');
  await assert.rejects(assertNoRemoteCode([root]), /registry\.npmmirror\.com/u);
  await assert.rejects(assertNoRemoteCode(["/tmp/qz-remote-code-missing"]), /not a directory/u);

  await writeFile(join(root, "sidepanel/export.html"), '<script src="https://unknown-code-host.example/runtime.js"></script>');
  await assert.rejects(assertNoRemoteCode([root]), /unknown-code-host/u);
  const guard = await readFile(new URL("../../scripts/check-no-remote-code.mjs", import.meta.url), "utf8");
  assert.match(guard, /vendor\/provenance\.json/);
  assert.match(guard, /SheetJS/u);
  console.log("remote-code guard tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
