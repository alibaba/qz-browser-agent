import { createHash } from "node:crypto";
import { parse } from "acorn";

// Zod 4.4.3 includes a Function alias in its optional JIT. CSP catches it at runtime,
// but store review must not have to prove it unreachable. Retain the upstream interpreter.
export const zodSourceHashes = {
  "util.js": "968e3433e810cf7ba5efb609a1cb6d9a6cfb51215fd1f699938228f7ac25deb3",
  "doc.js": "e084bbcc536746a8942fd33b08afe4db345554b3a0383114f1dca95261c958d9",
  "schemas.js": "09da9b0cb9b9d2d795c349bc47c7521d5aaffe241885f0c9728f2aa7de3834c9",
};

export function hardenZodSource(source, filename) {
  if (createHash("sha256").update(source).digest("hex") !== zodSourceHashes[filename]) {
    throw new Error(`Zod input changed; review the interpreter-only build: ${filename}`);
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let target;
  let replacement;
  for (const exported of ast.body) {
    const node = exported.declaration;
    if (node?.type === "VariableDeclaration") {
      const declaration = node.declarations[0];
      if (declaration.id.name === "allowsEval") {
        target = declaration.init;
        replacement = "Object.freeze({ value: false })";
      }
      if (declaration.id.name === "$ZodObjectJIT") {
        target = declaration.init.arguments[1].body;
        replacement = "{ $ZodObject.init(inst, def); }";
      }
    }
    if (node?.type === "ClassDeclaration" && node.id.name === "Doc") {
      target = node.body.body.find(method => method.key?.name === "compile").value.body;
      replacement = '{ throw new Error("Zod code generation is excluded from this extension"); }';
    }
  }
  if (!target) throw new Error(`Zod static reduction target missing: ${filename}`);
  return (source.slice(0, target.start) + replacement + source.slice(target.end)).replace(/\/\/# sourceMappingURL=.*$/mu, "");
}
