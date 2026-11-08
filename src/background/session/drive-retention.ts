import type { SessionMetadata } from "../../shared/session/session-store.js";
import { parseBeijingDateTime } from "../../shared/time-utils.js";
import { isActiveSessionRuntimeStatus } from "../../shared/session/session-runtime-status.js";

export const DRIVE_SESSION_RETENTION_LIMIT = 200;

/** Retention is separate from execution: only the deletion owner may retire a candidate. */
export function createDriveSessionRetention({
  listMetadata,
  getRuntime,
  isActive,
  retire,
  remove,
  retryMs = 30_000,
  logger = console,
}: {
  listMetadata(): Promise<Record<string, SessionMetadata>>;
  getRuntime(sessionId: string): Record<string, unknown> | null | undefined;
  isActive(sessionId: string): boolean;
  retire(sessionId: string): boolean;
  remove(sessionId: string, canRemove: () => Promise<boolean>): Promise<boolean>;
  retryMs?: number;
  logger?: Pick<Console, "warn">;
}) {
  let pending = false;
  let running: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const time = (session: SessionMetadata) => Math.max(Number(getRuntime(session.id)?.driveLastActivityAt) || 0,
    parseBeijingDateTime(session.updatedAt || session.createdAt) || 0);
  function retryLater() {
    if (retry || disposed) return;
    retry = setTimeout(() => { retry = undefined; void request(); }, retryMs);
    (retry as unknown as { unref?: () => void }).unref?.();
  }

  async function prune() {
    const sessions = Object.values(await listMetadata()).filter(session => session.source === "external-drive");
    const observed = new Map(sessions.map(session => [session.id, time(session)]));
    sessions.sort((a, b) => observed.get(b.id)! - observed.get(a.id)! || a.id.localeCompare(b.id));
    const candidates = [
      ...sessions.filter(session => session.driveRetentionPending === true),
      ...sessions.filter(session => session.driveRetentionPending !== true).slice(DRIVE_SESSION_RETENTION_LIMIT),
    ];
    for (const session of candidates) {
      if (disposed) return;
      try {
        await remove(session.id, async () => {
          const latest = await listMetadata();
          const current = latest[session.id];
          if (disposed || current?.source !== "external-drive") return false;
          const runtime = getRuntime(session.id) || {};
          if (runtime.running || runtime.pendingStart || isActiveSessionRuntimeStatus(runtime.status) || isActive(session.id)) return false;
          if (current.driveRetentionPending !== true) {
            const currentTime = time(current);
            let newer = 0;
            for (const record of Object.values(latest)) {
              if (record.source !== "external-drive" || record.driveRetentionPending === true || record.id === current.id) continue;
              const otherTime = time(record);
              if (otherTime > currentTime || otherTime === currentTime && record.id.localeCompare(current.id) < 0) newer++;
              if (newer >= DRIVE_SESSION_RETENTION_LIMIT) break;
            }
            if (newer < DRIVE_SESSION_RETENTION_LIMIT) { pending = true; return false; }
          }
          return retire(session.id);
        });
      } catch (error) {
        logger.warn("[轻舟] drive retention cleanup failed:", error);
        retryLater();
      }
    }
  }

  function request(): Promise<void> {
    if (disposed) return Promise.resolve();
    pending = true;
    if (!running) running = (async () => {
      while (pending && !disposed) {
        pending = false;
        await prune();
      }
    })().catch(error => { logger.warn("[轻舟] read drive retention candidates failed:", error); retryLater(); })
      .finally(() => { running = null; if (pending && !disposed) void request(); });
    return running;
  }

  return { request, dispose() { disposed = true; clearTimeout(retry); retry = undefined; } };
}
