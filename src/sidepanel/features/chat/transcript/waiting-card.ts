import { isToolBrowserPermission, type ToolBrowserPermission } from "../../../../shared/browser-permissions.js";
import { debuggerDetachT } from "../../../../shared/debugger-detach.js";
import { requestBrowserPermission, permissionT } from "../../../ui/browser-permissions.js";
import { t as backendT } from "../../../../shared/i18n/backend.js";
import { t, tHtml } from "../../../i18n/index.js";
import { escapeHtml, escapeHtmlAttribute } from "../../../ui/ui-utils.js";
import { record } from "../../../tools/renderer-input.js";
import { renderResultChoice } from "../../../ui/result-choice.js";

type Answer = string | string[];
interface FieldBase { id: string; label: string; help: string; required: boolean }
interface ChoiceOption { label: string; value: string; description: string; meta?: string[]; imageUrl?: string; url?: string }
export type WaitingField = FieldBase & (
  | { type: "text" | "textarea"; placeholder: string; defaultValue: string }
  | { type: "single_choice"; presentation?: "cards"; options: ChoiceOption[]; defaultValue: string }
  | { type: "multi_choice"; presentation?: "cards"; options: ChoiceOption[]; defaultValue: string[] }
);
interface WaitingForm { locationConsent?: boolean; browserPermission?: ToolBrowserPermission; debuggerDetached?: boolean; title: string; submitLabel: string; fields: WaitingField[] }
interface WaitCard {
  waitId: string; runId: string; title: string; message: string; status: string; reason: string; form: WaitingForm;
}
type WaitCommand = { type: "continue_task" | "cancel_wait"; sessionId: string; waitId: string;
  payload?: { submitted: true; reason: "submitted"; answers: Record<string, Answer> } };
interface CardOptions { send(message: WaitCommand): unknown; isCurrentSession(id: string): boolean }
interface CardState {
  sessionId: string | null; key: string; card: WaitCard; controller: AbortController; pending: boolean;
}

/** The card owns its draft and submission lifetime; only Background events resolve a wait. */
export function createWaitingCards(options: CardOptions) {
  const cards = new Map<HTMLElement, CardState>();

  function dispose(el: HTMLElement) {
    const state = cards.get(el);
    cards.delete(el);
    state?.controller.abort();
  }

  function forgetSession(sessionId: string) {
    for (const [el, state] of cards) if (state.sessionId === sessionId) dispose(el);
  }

  function reset() {
    for (const el of cards.keys()) dispose(el);
  }

  function create(entry: unknown, sessionId: string | null) {
    const el = document.createElement("div");
    patch(el, entry, sessionId);
    return el;
  }

  function patch(el: HTMLElement, entry: unknown, sessionId: string | null) {
    const card = normalizeWaitCard(entry);
    const key = JSON.stringify(card);
    const previous = cards.get(el);
    // Repeated snapshots must not replace a draft, its selection or an in-flight submission.
    if (previous?.sessionId === sessionId && previous.key === key) return true;
    dispose(el);
    const state: CardState = { sessionId, key, card, controller: new AbortController(), pending: false };
    cards.set(el, state);
    const waiting = isWaitingTranscriptActive(card);
    el.className = `msg msg-waiting ${waiting ? "waiting-active" : "waiting-resolved"}`;
    el.dataset.chatLane = waiting ? "detail" : "summary";
    el.dataset.waitId = card.waitId;
    el.dataset.waitStatus = card.status;
    el.dataset.waitRenderKey = key;
    el.innerHTML = renderWaitTranscriptHtml(card);
    if (!waiting) return true;
    const signal = state.controller.signal;
    const continueButton = el.querySelector<HTMLButtonElement>('[data-wait-action="continue"]');
    const cancelButton = el.querySelector<HTMLButtonElement>('[data-wait-action="cancel"]');
    const form = el.querySelector<HTMLFormElement>(".waiting-form");
    form?.addEventListener("submit", event => { event.preventDefault(); continueButton?.click(); }, { signal });
    form?.querySelectorAll<HTMLElement>(".waiting-field-control").forEach(control => {
      control.addEventListener("input", () => clearWaitingFieldInvalid(control.closest(".waiting-field")), { signal });
    });
    form?.querySelectorAll<HTMLElement>(".waiting-options input").forEach(control => {
      control.addEventListener("change", () => {
        clearWaitingFieldInvalid(control.closest(".waiting-field"));
        updateChoiceCounts(el);
      }, { signal });
    });
    updateChoiceCounts(el);
    continueButton?.addEventListener("click", () => { void submit(el, state, "continue_task"); }, { signal });
    cancelButton?.addEventListener("click", () => { void submit(el, state, "cancel_wait"); }, { signal });
    return true;
  }

  function owns(el: HTMLElement, state: CardState) {
    return cards.get(el) === state && !state.controller.signal.aborted && el.isConnected
      && Boolean(state.sessionId && options.isCurrentSession(state.sessionId));
  }

  async function submit(el: HTMLElement, state: CardState, type: WaitCommand["type"]) {
    if (state.pending || !state.sessionId || !owns(el, state)) return;
    const command: WaitCommand = { type, sessionId: state.sessionId, waitId: state.card.waitId };
    const hasForm = state.card.form.fields.length > 0;
    if (type === "continue_task" && hasForm) {
      const collected = collectWaitingFormAnswers(el, state.card.form.fields);
      if (!collected.ok) return;
      command.payload = { submitted: true, reason: "submitted", answers: collected.answers };
    }
    state.pending = true;
    const label = type === "cancel_wait" ? t("cancel") : hasForm ? t("submit") : t("continue");
    setWaitActions(el, true, t(type === "cancel_wait" ? "cancelling" : hasForm ? "submitting" : "continuing"));
    try {
      if (type === "continue_task" && state.card.form.browserPermission) {
        const allowed = await requestBrowserPermission(state.card.form.browserPermission);
        if (!owns(el, state)) return;
        if (!allowed) command.type = "cancel_wait";
      }
      if (type === "continue_task" && state.card.form.locationConsent) {
        const response = await chrome.runtime.sendMessage({ type: "accept_location_consent", sessionId: state.sessionId, waitId: state.card.waitId });
        if (!owns(el, state)) return;
        if (!response?.ok || response.accepted !== true) throw new Error("Location consent was not saved");
      }
      // Background acknowledges validation; accepted events still own the completed card.
      const response = record(await options.send(command));
      if (response.accepted === false) throw new Error(String(response.code || "USER_INPUT_REJECTED"));
    } catch (_error) {
      if (!owns(el, state)) return;
      state.pending = false;
      setWaitActions(el, false, t("actionFailed", { action: label }));
    }
  }

  return { create, patch, dispose, forgetSession, reset };
}

function setWaitActions(el: HTMLElement, disabled: boolean, label: string) {
  el.querySelectorAll<HTMLButtonElement>(".waiting-actions button").forEach(button => { button.disabled = disabled; });
  el.querySelectorAll<HTMLInputElement>(".qz-choice-card input").forEach(input => { input.disabled = disabled; });
  const hint = el.querySelector<HTMLElement>(".waiting-hint");
  if (hint) { hint.textContent = label; hint.hidden = false; }
}

function updateChoiceCounts(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>("[data-choice-count]").forEach(counter => {
    const count = counter.closest(".waiting-field")?.querySelectorAll(".qz-choice-card input:checked").length || 0;
    counter.textContent = t("choiceSelectedCount", { count });
  });
}

function normalizeWaitCard(value: unknown): WaitCard {
  const entry = record(value);
  const form = normalizeWaitingForm(entry.form);
  let message = String(entry.message || "");
  // Resolve built-in disclosures in the panel's language, including restored waits.
  if (form.locationConsent) {
    form.title = backendT("locationTitle");
    message = backendT("locationDisclosure");
  } else if (form.browserPermission) {
    form.title = permissionT("title");
    message = permissionT(form.browserPermission);
  } else if (form.debuggerDetached) {
    form.title = debuggerDetachT("title");
    message = debuggerDetachT("message");
  }
  return {
    waitId: String(entry.waitId || ""), runId: String(entry.runId || ""),
    title: String(entry.title || ""), message,
    status: String(entry.status || "waiting"), reason: String(entry.reason || ""),
    form,
  };
}

export function isWaitingTranscriptActive(value: unknown) {
  return ["", "waiting"].includes(String(record(value).status || "waiting"));
}

function renderWaitTranscriptHtml(entry: WaitCard) {
  const form = entry.form;
  const waiting = isWaitingTranscriptActive(entry);
  const hasForm = waiting && form.fields.length > 0;
  const hasResultChoices = hasForm && form.fields.some(field =>
    (field.type === "single_choice" || field.type === "multi_choice") && field.presentation === "cards");
  const statusClass = waiting ? "" : " resolved";
  const title = waiting
    ? (form.title || entry.title || t("actionRequired"))
    : waitResolvedTitle(entry);
  const repeatedCardTitle = form.fields.length === 1 && form.fields.some(field =>
    (field.type === "single_choice" || field.type === "multi_choice") && field.presentation === "cards")
    && entry.message === form.title;
  const message = repeatedCardTitle ? "" : entry.message || "";
  const hint = waiting
    ? (form.browserPermission ? permissionT("hint") : form.debuggerDetached || hasResultChoices ? "" : hasForm ? t("agentAfterSubmit") : t("agentAfterAction"))
    : waitResolvedHint(entry);
  return `
    <div class="waiting-card${statusClass} qz:relative qz:overflow-hidden qz:px-3 qz:pt-2.5 qz:pb-3">
      <div class="waiting-pulse"></div>
      <div class="waiting-body qz:mb-2.5">
        <div class="waiting-title qz:mb-1">${escapeHtml(title)}</div>
        ${message ? `<div class="waiting-message qz:mb-1">${escapeHtml(message)}</div>` : ""}
        ${hasForm ? `<form class="waiting-form qz:mt-2 qz:grid qz:gap-2">${renderWaitingFormFields(form.fields, form.title)}</form>` : ""}
        ${hint || hasResultChoices ? `<div class="waiting-hint qz:mt-1.5"${hint ? "" : " hidden"}>${escapeHtml(hint)}</div>` : ""}
      </div>
      ${waiting ? `
        <div class="waiting-actions qz:flex qz:gap-1.5">
          <button class="qz-btn qz-btn--primary qz-btn--sm waiting-continue-btn qz:flex-1" type="button" data-wait-action="continue">${escapeHtml(form.locationConsent ? t("dataConsentAccept") : form.browserPermission ? permissionT("allow") : form.debuggerDetached ? debuggerDetachT("continue") : hasForm ? form.submitLabel : t("doneContinue"))}</button>
          <button class="qz-btn qz-btn--ghost qz-btn--sm waiting-cancel-btn" type="button" data-wait-action="cancel">${form.debuggerDetached ? escapeHtml(debuggerDetachT("stop")) : tHtml("cancel")}</button>
        </div>
      ` : ""}
    </div>
  `;
}

function waitResolvedTitle(entry: WaitCard) {
  switch (entry.status) {
    case "cancelled": return t("cancelled");
    case "aborted": return t("cancelled");
    case "superseded": return t("waitReplaced");
    default: return t("continued");
  }
}

function waitResolvedHint(entry: WaitCard) {
  if (entry.status === "cancelled") return t("waitCancelledByUser");
  if (entry.status === "aborted") return t("waitClosedAtEnd");
  if (entry.status === "superseded") return t("newWaitRequested");
  if (entry.status === "stale") return t("waitNotQueued");
  return t("agentContinued");
}

export function normalizeWaitingForm(value: unknown = {}): WaitingForm {
  const form = record(value);
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return {
    ...(form.locationConsent === true ? { locationConsent: true } : {}),
    ...(isToolBrowserPermission(form.browserPermission) ? { browserPermission: form.browserPermission } : {}),
    ...(form.debuggerDetached === true ? { debuggerDetached: true } : {}),
    title: String(form.title || "").trim(),
    submitLabel: String(form.submitLabel || t("submit")).trim(),
    fields: fields.map((value: unknown, index): WaitingField => {
      const field = record(value);
      const id = String(field.id || `field_${index + 1}`).trim();
      const options = Array.isArray(field.options) ? field.options.map((value: unknown): ChoiceOption => {
        const option = record(value);
        return {
          label: String(option.label ?? option.value ?? value ?? "").trim(),
          value: String(option.value ?? option.label ?? value ?? ""),
          description: String(option.description || "").trim(),
          ...(Array.isArray(option.meta) ? { meta: option.meta.filter((item): item is string => typeof item === "string").slice(0, 6) } : {}),
          ...(typeof option.imageUrl === "string" ? { imageUrl: option.imageUrl } : {}),
          ...(typeof option.url === "string" ? { url: option.url } : {}),
        };
      }).filter(option => option.label && option.value) : [];
      const base: FieldBase = { id, label: String(field.label || id).trim(), help: String(field.help || "").trim(), required: field.required !== false };
      const presentation = field.presentation === "cards" ? { presentation: "cards" as const } : {};
      const defaultValue = Object.hasOwn(field, "defaultValue") ? field.defaultValue
        : Object.hasOwn(field, "defaultValues") ? field.defaultValues
          : Object.hasOwn(field, "default") ? field.default : field.value;
      if (field.type === "multi_choice" && options.length) {
        const values = Array.isArray(defaultValue) ? defaultValue : defaultValue == null || defaultValue === "" ? [] : [defaultValue];
        return { ...base, ...presentation, type: "multi_choice", options, defaultValue: values.map(value => String(value)).filter(Boolean) };
      }
      const scalar = defaultValue == null ? "" : String(defaultValue);
      if (field.type === "single_choice" && options.length) return { ...base, ...presentation, type: "single_choice", options, defaultValue: scalar };
      return { ...base, type: field.type === "textarea" ? "textarea" : "text", placeholder: String(field.placeholder || "").trim(), defaultValue: scalar.trim() };
    }).filter(field => field.id && field.label),
  };
}

function renderWaitingFormFields(fields: WaitingField[], title: string) {
  return fields.map((field, fieldIndex) => {
    const name = `wait_${field.id}`;
    const controlId = `wait_${field.id}_${fieldIndex}`;
    const required = field.required ? `<span class="waiting-field-required">*</span>` : "";
    const help = field.help ? `<div class="waiting-field-help">${escapeHtml(field.help)}</div>` : "";
    const error = `<div class="waiting-field-error" data-field-error></div>`;
    let control = "";
    if (field.type === "textarea") {
      control = `<textarea id="${escapeHtmlAttribute(controlId)}" class="qz-field qz-field--sm waiting-field-control" data-field-id="${escapeHtmlAttribute(field.id)}" placeholder="${escapeHtmlAttribute(field.placeholder)}" aria-required="${String(field.required)}">${escapeHtml(field.defaultValue)}</textarea>`;
    } else if (field.type === "single_choice" || field.type === "multi_choice") {
      const inputType = field.type === "single_choice" ? "radio" : "checkbox";
      const defaultValues = new Set(Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue].filter(Boolean));
      control = `
        <div class="waiting-options qz:grid ${field.presentation === "cards" ? "qz:gap-2 qz:-mx-1 qz:p-1 qz-scroll qz:max-h-80 qz:overflow-y-auto qz:overscroll-contain" : "qz:gap-1"}" data-field-id="${escapeHtmlAttribute(field.id)}" role="group" aria-label="${escapeHtmlAttribute(field.label)}" aria-required="${String(field.required)}">
          ${field.options.map((option, optionIndex) => {
            const optionId = `${controlId}_${optionIndex}`;
            if (field.presentation === "cards") return renderResultChoice(document, {
              ...option, id: optionId, name, multiple: field.type === "multi_choice", checked: defaultValues.has(option.value),
            }).outerHTML;
            const checked = defaultValues.has(option.value) ? " checked" : "";
            return `
            <label class="waiting-option qz:grid qz:cursor-pointer qz:grid-cols-[auto_minmax(0,1fr)] qz:items-start qz:gap-1.75 qz:px-1.75 qz:py-1.5">
              <input id="${escapeHtmlAttribute(optionId)}" class="${inputType === "radio" ? "qz-radio" : "qz-checkbox"}" type="${inputType}" name="${escapeHtmlAttribute(name)}" value="${escapeHtmlAttribute(option.value)}"${checked}>
              <span>
                <strong>${escapeHtml(option.label)}</strong>
                ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
              </span>
            </label>
          `;
          }).join("")}
        </div>
        ${field.presentation === "cards" ? '<div class="qz-field-hint qz:mt-1" data-choice-count role="status" aria-live="polite"></div>' : ""}
      `;
    } else {
      control = `<input id="${escapeHtmlAttribute(controlId)}" class="qz-field qz-field--sm waiting-field-control" data-field-id="${escapeHtmlAttribute(field.id)}" type="text" placeholder="${escapeHtmlAttribute(field.placeholder)}" value="${escapeHtmlAttribute(field.defaultValue)}" aria-required="${String(field.required)}">`;
    }
    const labelFor = field.type === "single_choice" || field.type === "multi_choice" ? "" : ` for="${escapeHtmlAttribute(controlId)}"`;
    const redundantCardLabel = fields.length === 1 && (field.type === "single_choice" || field.type === "multi_choice")
      && field.presentation === "cards" && field.label === title;
    return `
      <div class="waiting-field qz:grid qz:gap-1" data-field-id="${escapeHtmlAttribute(field.id)}" data-required="${String(field.required)}" data-type="${escapeHtmlAttribute(field.type)}">
        ${redundantCardLabel ? "" : `<label class="waiting-field-label"${labelFor}>${escapeHtml(field.label)}${required}</label>`}
        ${control}
        ${help}
        ${error}
      </div>
    `;
  }).join("");
}

function collectWaitingFormAnswers(root: HTMLElement, fields: WaitingField[]) {
  const answers: Record<string, string | string[]> = Object.create(null);
  const invalidFields = [];
  for (const field of fields) {
    const wrap = root.querySelector<HTMLElement>(`.waiting-field[data-field-id="${CSS.escape(field.id)}"]`);
    if (!wrap) continue;
    clearWaitingFieldInvalid(wrap);
    const value = readWaitingFieldValue(wrap, field);
    const empty = Array.isArray(value) ? value.length === 0 : !String(value || "").trim();
    if (field.required && empty) {
      invalidFields.push({ wrap, field });
    }
    answers[field.id] = value;
  }
  for (const item of invalidFields) markWaitingFieldInvalid(item.wrap, item.field);
  if (invalidFields.length) {
    focusWaitingField(invalidFields[0].wrap);
    return { ok: false, answers };
  }
  return { ok: true, answers };
}

function readWaitingFieldValue(wrap: HTMLElement | null, field: WaitingField) {
  if (!wrap) return field.type === "multi_choice" ? [] : "";
  if (field.type === "single_choice") {
    return wrap.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value || "";
  }
  if (field.type === "multi_choice") {
    return Array.from(wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(input => input.value);
  }
  return wrap.querySelector<HTMLInputElement | HTMLTextAreaElement>(".waiting-field-control")?.value.trim() || "";
}

function markWaitingFieldInvalid(wrap: HTMLElement | null, field: WaitingField) {
  if (!wrap) return;
  wrap.classList.add("invalid");
  wrap.querySelectorAll<HTMLElement>("input, textarea").forEach(input => input.setAttribute("aria-invalid", "true"));
  const error = wrap.querySelector<HTMLElement>("[data-field-error]");
  if (error) {
    error.textContent = field.type === "single_choice" || field.type === "multi_choice"
      ? t("selectThisOption")
      : t("fillThisField");
  }
}

function clearWaitingFieldInvalid(wrap: HTMLElement | null) {
  if (!wrap) return;
  wrap.classList.remove("invalid");
  wrap.querySelectorAll<HTMLElement>("input, textarea").forEach(input => input.removeAttribute("aria-invalid"));
  const error = wrap.querySelector<HTMLElement>("[data-field-error]");
  if (error) error.textContent = "";
}

function focusWaitingField(wrap: HTMLElement | null) {
  const target = wrap?.querySelector<HTMLElement>(".waiting-field-control, input");
  target?.focus?.();
}

