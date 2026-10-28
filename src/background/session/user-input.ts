import { DATA_CONSENT_VERSION } from "../../shared/data-consent.js";
import { productText } from "../../shared/product-text.js";

type Fields = Record<string, unknown>;
interface WaitIdentity { sessionId: string; waitId: string; runId: string }
interface Options {
  getWait(sessionId: string): WaitIdentity | null;
  getRuntime(sessionId: string): Fields;
  resolve(input: { sessionId: string; waitId: string; payload: Fields }): boolean;
  reject(input: { sessionId: string; waitId: string }): boolean;
  hasBrowserPermission(permission: string): Promise<boolean>;
  locationConsent: {
    isAccepted(): Promise<boolean>;
    acceptExternal(waitId: string, sessionId: string, consentVersion: unknown, signal?: AbortSignal): Promise<unknown>;
  };
}
interface Input extends WaitIdentity {
  waiting: true;
  kind: "form" | "confirmation" | "browser_permission" | "location_consent";
  title: string; message: string; form: Fields;
  actions: string[]; consentVersion?: number;
  instructions: string;
  responseTemplate?: Fields;
  requiresUserAction?: true;
}

const browserPermissionInstructions = () => productText(
  "Open this task in the qz side panel, click Allow and continue, and approve Chrome's permission prompt.",
  "Open this task in the qz sidebar, click Allow and continue, and approve Firefox's permission prompt.",
);

/** Commands share the supervisor's live wait, never a persisted UI snapshot alone. */
export function createSessionUserInput(options: Options) {
  function current(sessionId: string): Input | null {
    const wait = options.getWait(sessionId);
    if (!wait) return null;
    const runtime = options.getRuntime(sessionId);
    if (runtime.waitId !== wait.waitId || runtime.runId !== wait.runId) return null;
    const form = object(runtime.waitForm) || {};
    const kind = form.browserPermission ? "browser_permission" : form.locationConsent === true
      ? "location_consent" : Array.isArray(form.fields) && form.fields.length ? "form" : "confirmation";
    const consent = kind === "location_consent" ? { consentVersion: DATA_CONSENT_VERSION } : {};
    return {
      ...wait, waiting: true, kind,
      title: String(runtime.waitTitle || form.title || ""), message: String(runtime.waitMessage || ""),
      form: structuredClone(form), actions: [kind === "form" ? "submit" : "approve", "reject"],
      ...consent,
      instructions: kind === "browser_permission" ? browserPermissionInstructions() : kind === "form"
        ? "Fill responseTemplate.answers with the user's answers. Keys are field IDs; choices use option values, and multi_choice uses an array. Send the completed template to qingzhou_respond_to_user_input."
        : "Show this request to the user. After approval, send responseTemplate to qingzhou_respond_to_user_input; to decline, use action reject with this sessionId and waitId.",
      ...(kind === "browser_permission" ? { requiresUserAction: true as const } : {
        responseTemplate: {
          sessionId, waitId: wait.waitId, action: kind === "form" ? "submit" : "approve",
          ...(kind === "form" ? { answers: answerTemplate(form) } : {}), ...consent,
        },
      }),
    };
  }

  function get(params: Fields = {}) {
    const sessionId = id(params.sessionId);
    return current(sessionId) || { sessionId, waiting: false };
  }

  async function respond(params: Fields = {}, signal?: AbortSignal, { allowExistingConsent = false } = {}) {
    signal?.throwIfAborted();
    const sessionId = id(params.sessionId);
    const waitId = id(params.waitId);
    const input = current(sessionId);
    const stale = () => ({ accepted: false, sessionId, waitId, stale: true, code: "STALE_WAIT",
      message: "This request is no longer pending. Review the current input returned here before responding.",
      input: get({ sessionId }) });
    if (!sessionId || !waitId || !input || input.waitId !== waitId) return stale();
    const result = { sessionId, waitId, runId: input.runId };
    const stillCurrent = () => {
      const wait = current(sessionId);
      return wait?.waitId === waitId && wait.runId === input.runId;
    };
    const fail = (code: string, message: string, extra: Fields = {}) => ({ accepted: false, ...result, code, message, ...extra, input: get({ sessionId }) });
    if (params.action === "reject") {
      return options.reject(result) ? { accepted: true, ...result, reason: "cancelled" } : stale();
    }
    if (params.action !== "approve" && params.action !== "submit") {
      return fail("INVALID_ACTION", "Use submit for a form, or approve/reject for a confirmation.");
    }
    let payload: Fields = { continued: true, reason: "continued" };
    if (input.kind === "form") {
      if (params.action !== "submit") return fail("ANSWERS_REQUIRED", "Submit answers to the pending form.");
      const validation = validateAnswers(input.form, params.answers);
      if (validation.fieldErrors.length) return fail("INVALID_ANSWERS", "Correct the indicated fields and submit again.", { fieldErrors: validation.fieldErrors });
      payload = { submitted: true, reason: "submitted", answers: validation.answers };
    } else {
      if (params.action !== "approve") return fail("INVALID_ACTION", "Use approve or reject for this confirmation.");
      if (input.kind === "browser_permission") {
        let granted = false;
        try { granted = await options.hasBrowserPermission(String(input.form.browserPermission)); } catch { /* Keep the wait pending on a failed permission check. */ }
        signal?.throwIfAborted();
        if (!stillCurrent()) return stale();
        if (!granted) return fail("BROWSER_PERMISSION_REQUIRED", `The task is paused. ${browserPermissionInstructions()}`, { requiresUserAction: true });
      }
      if (input.kind === "location_consent") {
        try {
          if (allowExistingConsent) {
            const accepted = await options.locationConsent.isAccepted();
            signal?.throwIfAborted();
            if (!accepted) {
              if (!stillCurrent()) return stale();
              return fail("LOCATION_CONSENT_REQUIRED", "Read the location disclosure, then explicitly approve it to continue.", { requiresUserAction: true });
            }
          } else {
            await options.locationConsent.acceptExternal(waitId, sessionId, params.consentVersion, signal);
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (!stillCurrent()) return stale();
          return fail(String((error as { code?: string })?.code || "LOCATION_CONSENT_FAILED"),
            error instanceof Error ? error.message : "Could not save location consent. Try again.");
        }
        signal?.throwIfAborted();
        if (!stillCurrent()) return stale();
      }
    }
    signal?.throwIfAborted();
    if (!stillCurrent() || !options.resolve({ ...result, payload })) return stale();
    return { accepted: true, ...result, submitted: payload.submitted === true, reason: payload.reason,
      ...(payload.submitted ? { answerKeys: Object.keys(payload.answers as Fields) } : {}) };
  }

  // Side-panel replies and older MCP commands retain the same validation and permission guards.
  function continueWait(params: Fields = {}, signal?: AbortSignal) {
    const payload = object(params.payload);
    return respond({ ...params, action: payload?.submitted === true ? "submit" : "approve", answers: payload?.answers }, signal, { allowExistingConsent: true });
  }
  function submitWaitForm(params: Fields = {}, signal?: AbortSignal) { return respond({ ...params, action: "submit" }, signal); }
  function cancelWait(params: Fields = {}, signal?: AbortSignal) { return respond({ ...params, action: "reject" }, signal); }
  return { get, respond, continueWait, submitWaitForm, cancelWait };
}

function answerTemplate(form: Fields): Fields {
  return Object.fromEntries((Array.isArray(form.fields) ? form.fields : []).map(value => {
    const field = object(value) || {};
    const multi = field.type === "multi_choice";
    const initial = field.defaultValue ?? field.defaultValues;
    const placeholder = field.required === false ? (multi ? [] : "")
      : multi ? ["<option value>"] : field.type === "single_choice" ? "<option value>" : "<text>";
    const answer = multi ? (Array.isArray(initial) && initial.length ? initial : placeholder)
      : typeof initial === "string" && initial.length ? initial : placeholder;
    return [String(field.id), structuredClone(answer)];
  }));
}

function validateAnswers(form: Fields, value: unknown) {
  const fieldErrors: { fieldId: string; code: string; message: string }[] = [];
  const answers = object(value);
  if (!answers) return { answers: {}, fieldErrors: [{ fieldId: "", code: "INVALID_TYPE", message: "Answers must be a JSON object." }] };
  const defaults: Fields = Object.create(null);
  const fields = (Array.isArray(form.fields) ? form.fields : []).map(value => object(value) || {});
  const known = new Set(fields.map(field => String(field.id)));
  const error = (fieldId: string, code: string, message: string) => fieldErrors.push({ fieldId, code, message });
  for (const key of Object.keys(answers)) if (!known.has(key)) error(key, "UNKNOWN_FIELD", "Use a field ID from the current form.");
  for (const field of fields) {
    const key = String(field.id);
    const provided = Object.hasOwn(answers, key);
    const answer = provided ? answers[key] : undefined;
    const multi = field.type === "multi_choice";
    const empty = answer == null || (typeof answer === "string" && !answer.trim()) || (Array.isArray(answer) && answer.length === 0);
    if (empty) {
      if (field.required !== false) error(key, "REQUIRED", "This field is required.");
      else if (!provided) defaults[key] = multi ? [] : "";
      else if (multi ? !Array.isArray(answer) : typeof answer !== "string") error(key, "INVALID_TYPE", multi ? "Use an array of option values." : "Use a string.");
      continue;
    }
    if (multi ? !Array.isArray(answer) || answer.some(item => typeof item !== "string") : typeof answer !== "string") {
      error(key, "INVALID_TYPE", multi ? "Use an array of option values." : "Use a string.");
      continue;
    }
    if (multi || field.type === "single_choice") {
      const values = multi ? answer as string[] : [answer as string];
      const allowed = new Set((Array.isArray(field.options) ? field.options : []).map(option => object(option)?.value));
      if (values.some(value => !allowed.has(value))) error(key, "INVALID_OPTION", "Choose values listed in the current form.");
      if (new Set(values).size !== values.length) error(key, "DUPLICATE_OPTION", "Each option may be selected once.");
    }
  }
  return { answers: { ...defaults, ...answers }, fieldErrors };
}
function object(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}
function id(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
