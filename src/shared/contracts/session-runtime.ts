/** Shared wire facts. Opaque nested payloads are normalized by their owning boundary. */
type Fields = Record<string, unknown>;

export interface SessionGoal {
  status: "active" | "blocked" | "paused" | "complete";
  objective: string; criteria: string; progress: string; next: string; checkpoint: string;
  version: number; createdAt: string; updatedAt: string; updatedByRunId: string;
}
export interface TrackerStep { id: string; label: string; status?: "done" | "active" | "pending" }
export type TrackerMode = "steps" | "pagination" | "generic";
export interface SessionTracker {
  id: string; mode: TrackerMode; title: string; status: "active"; steps: TrackerStep[];
  total: number; current: number; completed: number; currentStep: number; unit: string; note: string;
  stats: Record<string, string | number | boolean | null | undefined> | null;
  startedAt: string; updatedAt: string;
}
export interface SessionRuntime extends Fields {
  schemaVersion: number; sessionId: string; status: string; running: boolean; pendingStart: boolean;
  interrupted: boolean; runId: string | null; updatedAt: unknown;
  currentTool: Fields | null; contextUsage: Fields | null; tracker: Fields | null; goal: Fields | null;
  waitForm: Fields | null; pendingFollowUps: unknown[]; pendingFollowUpMessages: unknown[];
  pendingSteerings: unknown[]; pendingSteeringMessages: unknown[]; composerDrafts: Fields;
  loadedPluginSkillNames: string[]; ownedTabIds: number[]; visitedTaskSites: unknown[];
  tabAliases: Record<string, number>;
}
