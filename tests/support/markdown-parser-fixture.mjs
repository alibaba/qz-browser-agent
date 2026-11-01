import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../../src/sidepanel/features/chat/markdown-feature.ts", import.meta.url));

// Expose the private factory only in tests, retaining its real Marked configuration
// and rendering helpers instead of copying the streaming tokenizers.
export function loadMarkdownParser(source = readFileSync(sourcePath, "utf8")) {
  const { outputFiles } = buildSync({
    stdin: { contents: `${source}\nexport { createMarkdownParser };`, loader: "ts", resolveDir: dirname(sourcePath), sourcefile: sourcePath },
    bundle: true, platform: "node", format: "cjs", write: false,
  });
  const module = { exports: {} };
  new Function("module", "exports", outputFiles[0].text)(module, module.exports);
  return module.exports.createMarkdownParser;
}
