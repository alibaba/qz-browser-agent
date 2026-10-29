import type { RegisterTool, ToolArguments } from "../../src/sdk/background.js";

declare const defineTool: RegisterTool;
const schema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "get"] },
    count: { type: "integer" },
    value: { description: "Arbitrary JSON value" },
    content: { type: ["string", "object"] },
    rows: { type: "array", items: {
      type: "object", properties: { label: { type: "string" } }, required: ["label"],
    } },
  },
  required: ["action"],
} as const;

const valid: ToolArguments<typeof schema> = { action: "create", rows: [{ label: "First" }] };
void valid;
// @ts-expect-error action is required by the schema.
const missing: ToolArguments<typeof schema> = {};
// @ts-expect-error literal enums constrain values.
const invalidAction: ToolArguments<typeof schema> = { action: "delete" };
// @ts-expect-error nested required properties are inferred too.
const invalidRows: ToolArguments<typeof schema> = { action: "get", rows: [{}] };
void [missing, invalidAction, invalidRows];

defineTool({ name: "example", description: "Typed tool", parameters: schema, execute: async (args, signal, context) => {
  const action: "create" | "get" = args.action;
  const count: number | undefined = args.count;
  const value: unknown = args.value;
  void value;
  // @ts-expect-error an open JSON field is unknown until narrowed.
  args.value.toString();
  const first: string | undefined = args.rows?.[0]?.label;
  const content: string | Record<string, unknown> | undefined = args.content;
  void content;
  const sessionId: string | undefined = context.sessionId;
  signal?.throwIfAborted();
  // @ts-expect-error an optional field cannot be used as a required value.
  args.count.toFixed();
  // @ts-expect-error a numeric field has no string method.
  args.count?.trim();
  // @ts-expect-error unknown fields are not inferred as any.
  args.unknownField;
  return { action, count, first, sessionId };
}, validateArgs: args => {
  // @ts-expect-error validation receives unknown external values before schema checking.
  args.action.trim();
} });

defineTool({ name: "async-validator", description: "Rejected async validation", parameters: schema, execute: () => ({}),
  // @ts-expect-error validation must finish before target resolution; runtime does not await it.
  validateArgs: async () => {},
});

defineTool({ name: "behavior", description: "Trusted synchronous decisions", parameters: schema, execute: () => ({}),
  behavior: {
    barrier: args => args.action === "create",
    mayUnloadPage: args => args.action === "create",
    nestedObservation: true,
    timeoutTrace: "example_trace",
  },
});
defineTool({ name: "async-behavior", description: "Rejected async decision", parameters: schema, execute: () => ({}),
  behavior: {
    // @ts-expect-error barrier decisions must be synchronous booleans.
    barrier: async () => true,
    // @ts-expect-error runtime behavior decisions must be synchronous and boolean.
    mayUnloadPage: async () => true,
  },
});

// @ts-expect-error simple JSON schema type unions still reject undeclared types.
const invalidContent: ToolArguments<typeof schema> = { action: "get", content: 42 };
void invalidContent;

// Localized documentation must not widen the schema's inferred handler arguments.
import { defineMessages } from '../../src/sdk/shared/i18n-definition.js';
import { createTranslator } from '../../src/sdk/shared/i18n.js';
const toolText = createTranslator(defineMessages('typed-tool-example', {
  title: { 'zh-CN': '回显文本', en: 'Echo text' },
  description: { 'zh-CN': '返回输入', en: 'Return the input' },
}));
defineTool({ name: 'localized-example', title: toolText('title'), description: toolText('description'),
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['echo'], description: toolText('description') } }, required: ['action'] },
  execute: args => {
    const action: 'echo' = args.action;
    // @ts-expect-error Localized descriptions do not relax machine enums.
    const invalid: 'translate' = args.action;
    return { action, invalid };
  },
});
// @ts-expect-error Both supported languages are required.
defineMessages('missing-language', { title: { en: 'Title' } });
// @ts-expect-error Unknown documentation keys are rejected.
toolText('missing');
