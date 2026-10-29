import { createHash } from "node:crypto";
import { parse } from "acorn";

// Reviewed pdfjs-dist 4.10.38 modern builds. Updates must re-review these reductions.
export const pdfSourceHashes = {
  "pdf.mjs": "a209a2124baa35cbb9015b809926f1bcec9dd1c247296290e205dd9d76cb9128",
  "pdf.worker.mjs": "7c237f83fa56bce645d8af51d183c9c56ba7b2d2928ff42754dc7020bea36323",
};

export function hardenPdfSource(source, filename) {
  if (createHash("sha256").update(source).digest("hex") !== pdfSourceHashes[filename]) {
    throw new Error(`PDF.js input changed; review the static-only build: ${filename}`);
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const changes = [];
  const replace = (node, text) => changes.push({ start: node.start, end: node.end, text });
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id.name === "isEvalSupported") {
      replace(node, "function isEvalSupported() { return false; }");
    }
    if (node.type === "VariableDeclaration" && node.declarations.length === 1 && node.declarations[0].id.name === "OpenJPEG") {
      // Text extraction never decodes JPEG2000 pixels. Exclude the binary and its URL fallback.
      replace(node, 'function OpenJPEG() { throw new Error("JPEG2000 pixel rendering is not included in the text reader"); }');
    }
    if (node.type !== "ClassDeclaration") continue;
    for (const method of node.body.body) {
      if (node.id.name === "PDFWorker") {
        if (method.type === "StaticBlock") replace(method, "static { this.#isWorkerDisabled = true; }");
        if (method.key?.name === "_initialize") {
          replace(method.value.body, "{ this._setupFakeWorker(); }");
        }
        if (method.key?.name === "_setupFakeWorkerGlobal") {
          replace(method.value.body, `{
    // qz statically imports WorkerMessageHandler; never fetch or compile a Worker URL.
    const handler = this.#mainThreadWorkerMessageHandler;
    const ready = handler ? Promise.resolve(handler) : Promise.reject(new Error("Local PDF worker is not registered"));
    return shadow(this, "_setupFakeWorkerGlobal", ready);
  }`);
        }
      }
      if (node.id.name === "PDFFunction" && method.key?.name === "constructPostScript") {
        const branch = method.value.body.body.find(statement => statement.type === "IfStatement"
          && source.slice(statement.test.start, statement.test.end) === "isEvalSupported && FeatureTest.isEvalSupported");
        if (!branch) throw new Error("PDF PostScript compiler branch missing");
        replace(branch, "// Always use the upstream PostScript interpreter, never JavaScript code generation.");
      }
    }
  }
  const expected = filename === "pdf.mjs" ? 4 : 3;
  if (changes.length !== expected) throw new Error(`PDF reduction count changed: ${filename}: ${changes.length}`);
  for (const change of changes.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, change.start) + change.text + source.slice(change.end);
  }
  // Keep Chrome 114 support without core-js's legacy DOM/script polyfills.
  source = source.replaceAll("Promise.withResolvers()", "createPromiseCapability()");
  source = source.replace(/\/\/# sourceMappingURL=.*$/mu, "");
  return `${source}\nfunction createPromiseCapability() {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}\n`;
}
