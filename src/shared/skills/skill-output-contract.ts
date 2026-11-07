import { dereference, validate, Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import { skillOutputMetaSchema } from "./skill-output-meta.js";

export type SkillOutputSchema = Schema | boolean;
export interface SkillOutputIssue { path: string; keyword: string; message: string }

const MAX_ISSUES = 8;
const metaValidator = new Validator(skillOutputMetaSchema, "7");
const schemaFailure = (path = "#"): SkillOutputIssue[] => [{
  path, keyword: "schema", message: "Schema cannot be evaluated. Check its references and regular expressions.",
}];

function issues(errors: OutputUnit[], prefix = ""): SkillOutputIssue[] {
  return errors.slice(-MAX_ISSUES).map(error => ({
    path: prefix ? prefix + error.instanceLocation.slice(1) : error.instanceLocation,
    keyword: error.keyword,
    // Numeric constraint errors include the actual value; keep business values out of diagnostics.
    message: error.keyword === "type" || error.keyword === "required"
      ? error.error : `Value does not satisfy the ${error.keyword} constraint.`,
  }));
}

/** Validate declarations and their examples before a Skill tool becomes callable. */
export function validateSkillOutputSchema(input: unknown): SkillOutputIssue[] {
  try {
    const checked = metaValidator.validate(input);
    if (!checked.valid) return issues(checked.errors);
    // The library annotates schemas during reference resolution; never mutate the manifest.
    const schema = structuredClone(input) as SkillOutputSchema;
    const lookup = dereference(schema);
    const seen = new Set<Schema>();
    const problems: SkillOutputIssue[] = [];
    for (const [uri, node] of Object.entries(lookup)) {
      if (typeof node === "boolean" || seen.has(node)) continue;
      seen.add(node);
      const path = new URL(uri).hash || "#";
      if (node.$schema && !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(node.$schema)) {
        problems.push({ path: `${path}/$schema`, keyword: "$schema", message: "outputSchema uses JSON Schema draft-07." });
      }
      if (node.$ref !== undefined && lookup[node.__absolute_ref__ || node.$ref] === undefined) {
        problems.push({ path: `${path}/$ref`, keyword: "$ref", message: "Referenced schema is not defined inside outputSchema." });
      }
      if (problems.length >= MAX_ISSUES) return problems.slice(0, MAX_ISSUES);
    }
    if (problems.length) return problems;
    // Detect reference graphs that cannot even evaluate a JSON primitive before execution.
    validate(null, schema, "7", lookup);
    for (const node of seen) {
      const path = new URL(node.__absolute_uri__!).hash || "#";
      if (!Array.isArray(node.examples)) continue;
      for (let index = 0; index < node.examples.length; index++) {
        const result = validate(node.examples[index], node, "7", lookup);
        problems.push(...issues(result.errors, `${path}/examples/${index}`));
        if (problems.length >= MAX_ISSUES) return problems.slice(0, MAX_ISSUES);
      }
    }
    return problems;
  } catch {
    return schemaFailure();
  }
}

/** Check the authored business value. No coercion, defaults or repair are applied. */
export function validateSkillOutput(schema: SkillOutputSchema, value: unknown): SkillOutputIssue[] {
  try {
    return issues(new Validator(structuredClone(schema), "7").validate(value).errors);
  } catch {
    return schemaFailure();
  }
}
