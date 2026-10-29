/** Recreate a notification Firefox would otherwise dismiss. priority has no equivalent. */

const RENEWALS = 12;

export function installNotificationRenewal(chromeApi: NotificationChrome): void {
  const notifications = chromeApi.notifications;
  if (!notifications?.create || (notifications.create as Marked).qzFirefoxRenewal) return;
  const original = notifications.create.bind(notifications);
  const pending = new Map<string, { options: NotificationOptions; left: number }>();
  const wrapped: Marked = (notificationId: string, options: NotificationOptions = {}, callback?: (createdId: string) => void) => {
    // Firefox 158's schema rejects requireInteraction before this function's
    // original implementation runs. priority stays; the schema allows it.
    const renew = options.requireInteraction === true;
    const firefoxOptions = stripRequireInteraction(options);
    let noted = false;
    const note = (createdId: unknown) => {
      const id = String(createdId || notificationId || "");
      if (!noted && renew && id) pending.set(id, { options: firefoxOptions, left: RENEWALS });
      noted = true;
      return id;
    };
    if (typeof callback === "function") {
      const created = original(notificationId, firefoxOptions, createdId => {
        callback(note(createdId));
      });
      if (isPromise(created)) return created.then(createdId => note(createdId));
      return created;
    }
    const created = original(notificationId, firefoxOptions);
    if (isPromise(created)) return created.then(createdId => note(createdId));
    return note(created);
  };
  wrapped.qzFirefoxRenewal = true;
  notifications.create = wrapped;
  notifications.onClosed?.addListener((id, byUser) => {
    const state = pending.get(id);
    if (!state) return;
    if (byUser === true || state.left <= 0) {
      pending.delete(id);
      return;
    }
    state.left -= 1;
    void Promise.resolve(original(id, state.options)).catch(() => { pending.delete(id); });
  });
  notifications.onClicked?.addListener(id => { pending.delete(id); });
}

function stripRequireInteraction(options: NotificationOptions): NotificationOptions {
  // Always return a new plain object. Firefox still reports the field when it
  // is inherited or wrapped, and the schema rejects that object before showAlert.
  let next: NotificationOptions;
  try {
    next = JSON.parse(JSON.stringify(options ?? {})) as NotificationOptions;
  } catch {
    next = {};
    for (const key of Object.keys(options || {})) next[key] = options[key];
  }
  delete next.requireInteraction;
  return next;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as Promise<unknown>).then === "function";
}

interface NotificationOptions { requireInteraction?: boolean; priority?: number; [key: string]: unknown }
type Create = (notificationId: string, options?: NotificationOptions, callback?: (createdId: string) => void) => Promise<string> | string | void;
type Marked = Create & { qzFirefoxRenewal?: boolean };
interface NotificationChrome {
  notifications?: {
    create: Marked;
    onClosed?: { addListener(listener: (id: string, byUser: boolean) => void): void };
    onClicked?: { addListener(listener: (id: string) => void): void };
  };
}
