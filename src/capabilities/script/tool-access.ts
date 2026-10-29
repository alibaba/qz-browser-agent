import { parse } from "acorn";

type Node = Record<string, unknown>;
const GLOBALS = new Set(["globalThis", "window", "self", "top", "parent", "frames"]);
const TOOL_REF = /(?<![\w$.])(?:tools|tool)(?![\w$])/;
const DYNAMIC = /(?<![\w$.])(?:eval|Function)\s*\(|(?<![\w$.])with\s*\(|(?<![\w$.])(?:globalThis|window|self|top|parent|frames)\s*(?:\?\.)?\s*\[/;

/** Conservative scheduling/bridge classification, not a JavaScript security sandbox. */
export function mayUseTools(code: unknown): boolean {
  if (typeof code !== "string" || !code.trim()) return true;
  try {
    // Parsing keeps comments/strings separate from template expressions and handles escaped identifiers.
    const tree = parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
    return visit(tree);
  } catch {
    return true; // Unknown or invalid syntax never receives tab-local scheduling authority.
  }
}

function visit(value: unknown, parent?: Node): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Node;
  if (node.type === "Identifier") {
    if (node.name === "eval" || node.name === "Function") return true; // Includes aliases and indirect/optional calls.
    if (node.name === "tools" || node.name === "tool") {
      const property = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      if (!property) return true; // Local bindings/object keys may conservatively produce false positives.
    }
  }
  if (node.type === "WithStatement" || node.type === "ImportExpression") return true;
  if (node.type === "MemberExpression") {
    const object = node.object as Node, property = node.property as Node;
    if (node.computed && (GLOBALS.has(String(object.name)) || object.type === "ThisExpression")) return true;
    if (property.name === "constructor" || property.value === "constructor") return true;
    if (node.computed && (property.value === "eval" || property.value === "Function")) return true;
  }
  if (node.type === "TemplateElement") {
    const raw = String((node.value as Node).raw || "");
    if (TOOL_REF.test(raw) || DYNAMIC.test(raw)) return true;
  }
  return Object.values(node).some(child => Array.isArray(child)
    ? child.some(item => visit(item, node)) : visit(child, node));
}
