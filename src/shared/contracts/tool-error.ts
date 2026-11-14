import { validateElementLocator } from "./element-locator.js";

/** Public recovery fields. Schema/value/trace payloads are business data and stay intact. */
const TEXT = [
  'target', 'reason', 'name', 'requestId', 'table', 'actualTable', 'scope', 'capability', 'prefix',
  'pattern', 'flags', 'localName', 'requiredWhen', 'filename', 'cause',
  'tool', 'skill', 'skillName', 'pluginId', 'script', 'server', 'settingId', 'url', 'repositoryUrl', 'path',
  'field', 'fieldId', 'rowId', 'format', 'src', 'currentSrc', 'expectedSrc', 'contentType', 'mimeType',
  'statusText', 'unit', 'key', 'action', 'model', 'provider', 'permission', 'permissionLevel', 'blockedType',
  'blockedDomain', 'blockedPattern', 'host', 'until', 'suggestedNextStep', 'recommendedAction', 'actualType',
  'receivedType', 'recordId', 'artifactId', 'assetId', 'fileId', 'targetType', 'docModelId', 'id', 'stack',
  'browserMessage', 'pending', 'within',
] as const;
const NUMBER = [
  'line', 'column', 'index', 'timeout', 'timeoutMs', 'bytes', 'maxBytes', 'base64Chars', 'payloadChars',
  'sheetCount', 'blockCount', 'tableCount', 'matched', 'selectedTargets', 'selectedUrls', 'collected', 'failed',
  'issueCount', 'omittedIssueCount', 'maxOptions', 'remainingSeconds', 'maxWaitSeconds', 'targetAt', 'maximum',
  'min', 'max', 'schemaVersion', 'downloadId', 'revision', 'expectedRevision', 'currentRevision', 'count', 'nth',
] as const;
const BOOLEAN = [
  'automaticReplay', 'mayHaveTakenEffect', 'toolAccess', 'executed', 'submitDispatched', 'clickDispatched',
  'inputDelivered', 'filled', 'checked', 'selected', 'mutatesPage', 'submit',
] as const;
const ARRAY = [
  'missing', 'missingFields', 'allowedValues', 'allowedActions', 'allowedFields', 'availableSettingIds',
  'availableTools', 'allowedScopes', 'requiredFields', 'notFoundRowIds', 'supported', 'allowed', 'available',
  'invalidFields', 'nonTableBlockPaths', 'issues', 'trace', 'failures', 'errors', 'candidates', 'resources',
  'disabledTools',
] as const;
const OBJECT = [
  'schema', 'expectedSchema', 'retry', 'contentSummary', 'coordinateSpace', 'clip', 'rect', 'bounds',
  'viewport', 'locator', 'pageState',
] as const;
const VALUE = [
  'value', 'expected', 'expectedType', 'recommended', 'recovery', 'examples', 'expectedValue', 'currentValue',
] as const;
const REFERENCE = [
  'tabRef', 'status', 'browserCode',
] as const;
export type ToolErrorDetails = Partial<Record<typeof TEXT[number], string> & Record<typeof NUMBER[number], number>
  & Record<typeof BOOLEAN[number], boolean> & Record<typeof ARRAY[number], readonly unknown[]>
  & Record<typeof OBJECT[number], Record<string, unknown>> & Record<typeof VALUE[number], unknown>
  & Record<typeof REFERENCE[number], string | number>>;

/** Construct only public top-level fields; never inspect caller-authored nested payloads. */
export function toolErrorDetails(input: unknown): ToolErrorDetails {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const details: Record<string, unknown> = {};
  for (const key of TEXT) if (typeof source[key] === 'string') details[key] = source[key];
  for (const key of NUMBER) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) details[key] = source[key];
  }
  for (const key of BOOLEAN) if (typeof source[key] === 'boolean') details[key] = source[key];
  for (const key of ARRAY) if (Array.isArray(source[key])) details[key] = source[key];
  for (const key of OBJECT) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) details[key] = source[key];
  }
  for (const key of VALUE) if (source[key] !== undefined) details[key] = source[key];
  for (const key of REFERENCE) {
    if (typeof source[key] === 'string' || typeof source[key] === 'number' && Number.isFinite(source[key])) {
      details[key] = source[key];
    }
  }
  return details as ToolErrorDetails;
}

/** Echo only the caller's public reference, never a resolved browser identifier. */
export function pageErrorDetails(
  context: { requestedTabRef?: string | number } = {}, target?: string,
): ToolErrorDetails {
  return { ...(context.requestedTabRef != null ? { tabRef: context.requestedTabRef } : {}),
    ...(target ? { target } : {}) };
}

/** Identify an operation without echoing values, script source, or browser-internal IDs. */
export function operationErrorDetails(
  context: { requestedTabRef?: string | number } = {}, args: Readonly<Record<string, unknown>> = {},
): ToolErrorDetails {
  let locator: Record<string, unknown> | undefined;
  if (args.locator !== undefined) {
    try { validateElementLocator(args.locator); locator = { ...args.locator }; }
    catch { /* Unrecognized business payloads are not element identities. */ }
  }
  return { ...pageErrorDetails(context, typeof args.target === "string" ? args.target : undefined),
    ...(locator ? { locator } : {}),
    ...(typeof args.action === "string" ? { action: args.action } : {}),
    ...(typeof args.index === "number" && Number.isInteger(args.index) ? { index: args.index } : {}),
  };
}

export interface ToolError { code: string; message: string; hint?: string; details?: ToolErrorDetails }
const values = new WeakSet<object>();

/** Execution status belongs to the host, never to keys in a caller's returned object. */
export function markToolValue<T>(value: T): T {
  if (value && typeof value === 'object') values.add(value);
  return value;
}

export function isToolValue(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && values.has(value));
}

export function toolError(
  code: string, message: string, options: { hint?: string; details?: unknown } = {},
): ToolError {
  const details = toolErrorDetails(options.details);
  return { code: code.toUpperCase(), message, ...(options.hint ? { hint: options.hint } : {}),
    ...(Object.keys(details).length ? { details } : {}) };
}

/** Native failures plus the input-only legacy failure envelopes. */
export function isToolFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isToolValue(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === false || result.isError === true || Boolean(result.error)
    || (result.ok !== true && typeof result.code === 'string' && typeof result.message === 'string'
      && !['', 'OK', 'SUCCESS', 'DONE'].includes(result.code.trim().toUpperCase()));
}
