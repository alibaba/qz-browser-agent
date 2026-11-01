import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path) => {
  const sourcePath = existsSync(join(root, path)) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(join(root, sourcePath), "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", target: "esnext", format: "esm" }).code : source;
};

const serviceWorker = read("src/background/service-worker.js");
const sessionCommands = read("src/background/session/commands.js");
const mcpRuntime = read("src/background/mcp/mcp-runtime.js");
const runScriptBridge = read("src/background/tools/run-script-bridge.js");
const sidepanelTransport = read("src/background/transports/sidepanel.js");
const sessionSupervisor = read("src/background/session/supervisor.ts");
const sessionArtifacts = read("src/background/session/artifacts.js");
const chatRunController = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-run-controller.ts"), "utf8"));
const eventRouter = read("src/sidepanel/features/app/sidepanel-event-router.js");
const artifactFeature = read("src/capabilities/sessions/artifacts/artifacts-feature.js");
const artifactModel = read("src/capabilities/sessions/artifacts/artifact-model.js");
const transcriptRenderer = read("src/sidepanel/features/chat/transcript/renderer.js");
const sessionState = read("src/sidepanel/features/sessions/session-state.ts");
const sidepanel = [chatRunController, eventRouter, artifactFeature, artifactModel, transcriptRenderer, sessionState, read("src/shared/tools/artifact-projection.ts")].join("\n");
const sessionCodec = read("src/shared/session/session-codec.ts");
const tools = read("src/background/tools/runtime.js");
const scriptTools = read("src/capabilities/script/tools.js");
const scriptToolBridge = read("src/content/run-script-tool-bridge.ts");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const parenStart = source.indexOf("(", start);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.notEqual(parenEnd, -1, `unterminated signature for ${name}`);
  const braceStart = source.indexOf("{", parenEnd);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

assert.match(
  chatRunController,
  /request\(\s*"stop_session",\s*\{\s*sessionId,\s*source:\s*"ui"\s*\},\s*8000\s*\)/s,
  "sidepanel stop button should request the full stop_session runtime path",
);

const stopCurrentRunBody = chatRunController.match(/function\s+stopCurrentRun\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
assert.match(
  stopCurrentRunBody,
  /if\s*\(!canStopCurrentRun\(sessionId\)\)\s*return\s+false/,
  "sidepanel stop should no-op when the current session is not actively running",
);
assert.doesNotMatch(
  stopCurrentRunBody,
  /finalizeInterruptedToolTranscriptEvents|finalizeStreamingTranscriptEvents|upsertRunStatusTranscriptEvent/,
  "sidepanel stop button should not synthesize transcript terminal state locally",
);

const canStopBody = extractFunction(chatRunController, "canStopCurrentRun");
assert.match(
  canStopBody,
  /isRuntimeRunning\(runtime\)/,
  "Escape stop should be gated by the current session runtime state",
);

assert.doesNotMatch(
  sidepanel,
  /function\s+applyTranscriptFromTerminalRuntimeState/,
  "sidepanel should not keep a second terminal transcript reducer",
);

assert.match(
  eventRouter,
  /function\s+trackBackgroundRun\(event\)[\s\S]*sessionState\.applyEvent\(\{\s*\.\.\.event,\s*sessionId\s*\}/s,
  "sidepanel should send transcript events through the shared SessionState reducer",
);

for (const status of ["aborted", "completed"]) {
  const result = updateTranscriptWithAgentEvent([
    { type: "tool", toolCallId: "pending", runId: "run", argsState: "ready", isRunning: true },
  ], { type: "state", runId: "run", runtime: { status } });
  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.equal(tool.isRunning, false, "terminal state must settle pending tool evidence");
  assert.equal(tool.phase, status === "completed" ? "not_executed" : "aborted");
  assert.equal(result.transcript.some(entry => entry.type === "run-status" && entry.status === "aborted"), status === "aborted");
}

assert.match(
  sessionCodec,
  /status\s*===\s*SESSION_RUNTIME_STATUS\.COMPLETED\)\s*return\s+"not_executed"/,
  "completed runtime state should preserve unexecuted tool evidence instead of leaving a live card",
);

assert.match(
  sessionCodec,
  /status\s*===\s*SESSION_RUNTIME_STATUS\.INTERRUPTED\)\s*return\s+"interrupted"/,
  "interrupted runtime state should settle locally streamed transcript entries",
);

const terminalArtifactBody = extractFunction(sidepanel, "settleArtifactTailForTerminalSession");
assert.match(
  terminalArtifactBody,
  /releaseArtifactCardSuppression\(id\)[\s\S]*handleSessionResourcesChanged\(id,\s*\{\s*renderCurrent\s*\}\)[\s\S]*renderChatTranscript\(id,\s*\{\s*force:\s*true\s*\}\)[\s\S]*scheduleSessionsListRefresh\(\{\s*delay:\s*0\s*\}\)/s,
  "terminal sessions should release artifact suppression, refresh chat tail, and stale-refresh session-list artifact cache",
);
assert.doesNotMatch(
  terminalArtifactBody,
  /sessionListArtifactHydrationStateBySessionId\.delete/,
  "terminal artifact refresh should not clear the previous summary before hydration finishes",
);

assert.doesNotMatch(
  sidepanel,
  /from\s+["']\.\.\/shared\/session\/session-resource-ledger\.js["']/,
  "sidepanel should not read the resource ledger directly; background owns artifact aggregation",
);

assert.match(
  sidepanelTransport,
  /case\s+"get_session_artifacts":\s*\{[\s\S]*call\("artifacts.list",\s*message\.sessionId\)[\s\S]*"session_artifacts_result"/s,
  "sidepanel transport should expose the authoritative artifact API endpoint",
);

assert.match(
  sessionArtifacts,
  /appendResources\(\{[\s\S]*\}\)[\s\S]*\.then\(\(items\)\s*=>\s*\{[\s\S]*type:\s*"session_resources_changed"/s,
  "resource ledger writes should notify the sidepanel after the ledger update completes",
);

assert.match(
  sidepanel,
  /"session_resources_changed"/,
  "sidepanel should subscribe to resource-ledger change events",
);

assert.match(
  artifactModel,
  /function\s+fetchRuntimeArtifactSummary\(sessionId\s*=\s*""\)\s*\{[\s\S]*request\("get_session_artifacts"/s,
  "sidepanel artifact hydration should request background's merged artifact summary",
);

assert.doesNotMatch(
  sidepanel,
  /artifactOrder|withStableArtifactOrder|stableArtifactOrder/,
  "artifact order should not use a synthetic stable order that overrides modified-time sorting",
);

const withArtifactsBody = extractFunction(sidepanel, "withArtifactsTranscriptEntry");
assert.match(
  withArtifactsBody,
  /const\s+localSummary\s*=\s*model\.collectSessionArtifacts\(id,\s*base\)[\s\S]*if\s*\(!hydration\?\.loaded\)\s*\{[\s\S]*return\s+\[\s*\.\.\.base,\s*createArtifactsTranscriptEntry\(id,\s*localSummary\)\s*\]/s,
  "chat artifact strip should render synchronously from local transcript before hydration",
);

const artifactCompareBody = extractFunction(sidepanel, "compareArtifactItems");
assert.match(
  artifactCompareBody,
  /artifactSortTimeMs\(b\)\s*-\s*artifactSortTimeMs\(a\)/,
  "artifact display order should be modified-time descending",
);
assert.doesNotMatch(
  artifactCompareBody,
  /score|count/,
  "artifact display ordering should not shift because row counts or completeness scores change",
);

const artifactSortTimeBody = extractFunction(sidepanel, "artifactSortTimeMs");
assert.match(
  artifactSortTimeBody,
  /sortTimeMs[\s\S]*timeMs[\s\S]*sortUpdatedAt[\s\S]*updatedAt/,
  "artifact sorting should use a stable sort anchor before falling back to display update time",
);

const mergeSummariesBody = extractFunction(sidepanel, "mergeArtifactSummaries");
assert.match(
  mergeSummariesBody,
  /upsertArtifactItem\(data,\s*normalized\.id,\s*normalized,\s*\{\s*preserveSort:\s*true\s*\}\)/,
  "artifact summary hydration should preserve the local transcript sort anchor for data artifacts",
);
assert.match(
  mergeSummariesBody,
  /upsertArtifactItem\(files,\s*normalized\.id,\s*normalized,\s*\{\s*preserveSort:\s*true\s*\}\)/,
  "artifact summary hydration should preserve the local transcript sort anchor for file artifacts",
);

const mergeItemsBody = extractFunction(sidepanel, "mergeArtifactItems");
assert.match(
  mergeItemsBody,
  /preserveSort[\s\S]*sortTimeMs[\s\S]*sortUpdatedAt/,
  "artifact item merging should keep sorting separate from metadata freshness",
);

const upsertFileArtifactBody = extractFunction(sidepanel, "upsertFileArtifact");
assert.match(
  upsertFileArtifactBody,
  /findFileArtifactMergeKey\(map,\s*next,\s*id\)/,
  "sidepanel file artifacts should merge equivalent artifact/download rows before rendering",
);
const fileArtifactDedupeBody = extractFunction(sidepanel, "fileArtifactDedupeKey");
assert.match(
  fileArtifactDedupeBody,
  /filename \|\| item\.title[\s\S]*artifactFileExtension[\s\S]*`file:\$\{title\}\|\$\{format\}`/,
  "sidepanel file artifact dedupe should collapse the same filename/format across artifactId and downloadId",
);
const backgroundFileUpsertBody = extractFunction(sessionArtifacts, "upsertFileArtifact");
assert.match(
  backgroundFileUpsertBody,
  /findSessionArtifactMergeKey\(map,\s*item,\s*id\)/,
  "background artifact context should merge equivalent file artifacts before exposing runtime summaries",
);
const backgroundArtifactMergeBody = extractFunction(sessionArtifacts, "mergeSessionArtifactItems");
assert.match(
  backgroundArtifactMergeBody,
  /findSessionArtifactMergeKey\(byId,\s*item,\s*key\)/,
  "background runtime artifact list should dedupe ledger and transcript files by equivalent filename/format",
);
assert.match(
  backgroundArtifactMergeBody,
  /for\s*\(const field of \["downloadId",\s*"artifactId",\s*"fileId",\s*"url",\s*"format",\s*"size",\s*"sizeLabel"\]\)/,
  "background runtime artifact list merging should preserve identifiers needed to open deduped files",
);
const backgroundMergeItemsBody = extractFunction(sessionArtifacts, "mergeArtifactItems");
assert.match(
  backgroundMergeItemsBody,
  /for\s*\(const key of \["downloadId",\s*"artifactId",\s*"fileId",\s*"url",\s*"format",\s*"size",\s*"sizeLabel"\]\)/,
  "background file artifact merging should preserve identifiers needed to open deduped files",
);

assert.match(
  sidepanel,
  /function\s+normalizeArtifactSummaryDataItem\(value\s*=\s*\{\}\)\s*\{[\s\S]*maxPositiveArtifactNumber\(item\.count,\s*item\.totalRows,\s*item\.rowCount\)/s,
  "artifact summary merging should let a later totalRows override an older one-row transcript count",
);

const sessionUi = read("src/capabilities/sessions/ui.ts");
const routeBackgroundBody = extractFunction(sidepanel, "routeBackgroundSessionEvent");
assert.match(
  sessionUi,
  /\["agent_end",\s*"aborted",\s*"error"\].*artifacts\.settleTerminal\(id,\s*\{\s*renderCurrent:\s*current\(id\)\s*\}\)/s,
  "background terminal events should release artifact suppression without forcing current chat render",
);

assert.match(
  eventRouter,
  /options\.onEvent\?\.\(event\)[\s\S]*routeBackgroundSessionEvent\(event\)[\s\S]*case\s+"aborted":\s*case\s+"error":[\s\S]*runController\.finish\(\);/s,
  "aborted and error events should show accumulated artifacts after the run settles",
);

assert.match(
  chatRunController,
  /if\s*\(!snapshot\.isStreaming\)\s*\{[\s\S]*const\s+terminalSessionId\s*=[\s\S]*finishRun\(\);[\s\S]*onTerminal\(terminalSessionId\)/s,
  "terminal runtime snapshots should restore the artifact tail after stopping or failing",
);

assert.match(
  chatRunController,
  /if\s*\(snapshot\.runId\s*&&\s*blockedRunIds\.has\(snapshot\.runId\)\)\s*\{[\s\S]*const\s+terminalSessionId\s*=[\s\S]*finishRun\(\);[\s\S]*if\s*\(isRunTerminalEvent\(snapshot\)\)\s*\{[\s\S]*onTerminal\(terminalSessionId\)/s,
  "blocked stopped-run terminal snapshots should restore accumulated artifacts immediately",
);

assert.doesNotMatch(
  sidepanel,
  /__toolTranscriptEntry\s*===\s*entry/,
  "tool transcript patching should not skip updates solely because the entry object reference is unchanged",
);

assert.match(
  sidepanel,
  /function\s+patchToolTranscriptElement\(el,\s*entry,[\s\S]*previousSignature\s*=\s*el\.dataset\.toolRenderSignature[\s\S]*nextSignature\s*=\s*toolTranscriptRenderSignature\(entry\)[\s\S]*previousSignature\s*===\s*nextSignature[\s\S]*if\s*\(same\)\s*return true/s,
  "tool transcript patching should use render signatures so in-place terminal mutations repaint the dot state",
);

assert.match(
  sessionCodec,
  /function\s+eventRunId\(event\s*=\s*\{\}\)[\s\S]*event\?\.runId[\s\S]*event\?\.runtime\?\.runId/s,
  "terminal transcript writes should preserve run identity from runtime state",
);

assert.doesNotMatch(
  mcpRuntime,
  /case\s+"abort"/,
  "public runtime messages should not expose a separate abort command",
);

assert.doesNotMatch(
  serviceWorker,
  /ui_stop|ui_abort/,
  "stop sources should not keep legacy UI-specific abort labels",
);

assert.match(
  sidepanelTransport,
  /case\s+"stop_session":\s*\{[\s\S]*call\("sessions\.stop", message\.sessionId,\s*\{\s*source:\s*message\.source\s*\|\|\s*"ui"\s*\},\s*signal\)/s,
  "sidepanel stop_session messages should use the full stop runtime path, source and admission signal",
);

const stopSingleBody = extractFunction(sessionCommands, "stopSingleSessionRuntime");
const deleteSessionBody = extractFunction(sessionCommands, "deleteSessionRuntime");
// Idle no-op, revoke/release/persist ordering and terminal transcript state are exercised
// by stopPortOrderingAndIdleNoOp in test-session-commands-runtime.mjs.

assert.match(
  sidepanelTransport,
  /if \(message\.requestId\)[\s\S]*const runtime = object\(stoppedRecord\.runtime\)[\s\S]*post\(port, "state", message,[\s\S]*status: runtime\.status[\s\S]*runtime,/s,
  "stop_session request responses should return the canonical terminal runtime state",
);

assert.match(
  mcpRuntime,
  /getRuntimeOutput\(id,\s*\(?current\)?\s*=>\s*\{[\s\S]*const observed = entry\.agent\?\.getRunState\(\);[\s\S]*const sameRun = entry\.agent === agent && observed && observed\.runId === current\.runId;[\s\S]*const liveState = sameRun \? observed[\s\S]*runId:\s*runtime\.runId\s*\|\|\s*liveState\.runId\s*\|\|\s*null/s,
  "get_state should expose the canonical runtime runId after restoring a stopped session",
);

assert.match(
  deleteSessionBody,
  /beforeRelease:\s*async\s*\(revoked\)[\s\S]*await releaseTerminalRunResources\([\s\S]*"delete_session"[\s\S]*deleteStoredSession/,
  "deleteSessionRuntime should release run-owned browser resources before deleting Session storage",
);

assert.match(
  sessionSupervisor,
  /detachAgent\(entry\)[\s\S]*agent\?\.abort\?\.\(reason\)[\s\S]*await beforeRelease\(snapshot\)/,
  "Supervisor should revoke event and persistence authority before aborting and checkpointing an old Agent",
);

assert.match(
  sessionCommands,
  /const\s+status\s*=\s*normalizeRuntimeStatus\(persisted\.status\)\s*\|\|\s*"idle";[\s\S]*const\s+running\s*=\s*isActiveSessionRuntimeStatus\(status\)\s*&&\s*persisted\.running\s*!==\s*false/,
  "getSessionRuntimeState should read the Supervisor-owned runtime projection without merging Agent/task state",
);

assert.match(
  sessionSupervisor,
  /if\s*\(!isCurrentEpoch\(handle,\s*capturedEpoch\)\)\s*return false[\s\S]*handle\.activeRunId !== runId[\s\S]*eventSeq <= handle\.lastEventSeq/,
  "Supervisor should reject stale epochs, stale runIds, and out-of-order events",
);

assert.doesNotMatch(
  serviceWorker,
  /\bagentEntries\b|\bsessionTasks\b|\bstoppedRuns\b/,
  "service worker should not retain parallel Agent/task/stopped-run authorities",
);

assert.match(
  runScriptBridge,
  /const stoppedError = stoppedBridgeError\(sessionId,\s*runId,\s*toolName,\s*signal\)/,
  "run_script bridge should reject tool calls from stopped runs and cancelled parents",
);

assert.match(
  scriptTools,
  /const __qzRunId = \$\{JSON\.stringify\(runId \|\| ""\)\};/,
  "CDP run_script bridge should capture the originating runId",
);

assert.match(
  scriptTools,
  /runId:\s*__qzRunId/,
  "CDP run_script bridge should forward runId to background tool calls",
);

assert.match(
  scriptToolBridge,
  /runId:\s*typeof message\.runId === "string" \? message\.runId : ""/,
  "internal run_script tool bridge should pass runId to background tool calls",
);

assert.doesNotMatch(
  scriptTools,
  /runScriptWithScriptingBridge/,
  "run_script should not keep the removed chrome.scripting fallback helper",
);

console.log("stop-session model contracts passed");
