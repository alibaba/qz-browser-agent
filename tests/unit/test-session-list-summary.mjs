import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSessionArtifactListSummary,
  createSessionListSummaryFromAgentEvent,
  createSessionListSummaryFromFirstMessage,
  createSessionListSummaryFromTranscript,
  mergeSessionListSummary,
  normalizeSessionListSummary,
  sessionListSummarySearchText,
} from "../../src/shared/session/session-list-summary.js";
import { PortClientError } from "../../src/sidepanel/features/app/port-client.js";
import { isSessionListSnapshotSoftTimeout } from "../../src/capabilities/sessions/sessions-feature.js";

assert.equal(mergeSessionListSummary({}, { lastAt: 123 }).updatedAt, "123", "timestamp fallbacks stay normalized on malformed persisted patches");
assert.equal(mergeSessionListSummary({ lastAt: "older" }, { artifactUpdatedAt: "newer" }).updatedAt, "newer", "new artifact patches keep timestamp precedence");

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path) => {
  let sourcePath = join(root, path);
  if (!existsSync(sourcePath) && path.endsWith(".js")) sourcePath = sourcePath.replace(/\.js$/, ".ts");
  const source = readFileSync(sourcePath, "utf8");
  return sourcePath.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
};

assertFirstMessageSummary();
assertTranscriptSummary();
assertAgentEventSummary();
assertArtifactSummary();
assertSessionListSnapshotFallback();
assertSourceContracts();

function assertFirstMessageSummary() {
  const summary = createSessionListSummaryFromFirstMessage("  采集 B 站视频  ", "2026-07-07 10:00:00");
  assert.equal(summary.lastText, "用户: 采集 B 站视频");
  assert.equal(summary.lastType, "user");
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.updatedAt, "2026-07-07 10:00:00");
}

function assertTranscriptSummary() {
  const summary = createSessionListSummaryFromTranscript([
    { type: "user", text: "生成 PDF", timestamp: "2026-07-07 10:00:00" },
    { type: "assistant", content: "**好的**，我来做", timestamp: "2026-07-07 10:00:05" },
    { type: "tool", name: "document_create", isError: false, endedAt: "2026-07-07 10:00:10" },
  ]);
  assert.equal(summary.lastText, "document_create 完成");

  const namespacedSummary = createSessionListSummaryFromTranscript([
    {
      type: "tool",
      name: "qingzhou_documents__document_create",
      capabilityId: "document_create",
      title: "生成文档",
      isError: false,
      endedAt: "2026-07-07 10:00:11",
    },
  ]);
  assert.equal(namespacedSummary.lastText, "生成文档 完成", "session summaries should use the persisted tool title instead of a runtime namespace");
  assert.equal(summary.lastType, "tool");
  assert.equal(summary.lastAt, "2026-07-07 10:00:10");
  assert.equal(summary.messageCount, 3);
}

function assertAgentEventSummary() {
  const user = createSessionListSummaryFromAgentEvent({
    type: "message_end",
    message: {
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  });
  assert.equal(user.lastText, "用户: 看这张图");

  const imageOnly = createSessionListSummaryFromAgentEvent({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    },
  });
  assert.equal(imageOnly.lastText, "用户发送了图片");

  const tool = createSessionListSummaryFromAgentEvent({
    type: "tool_execution_end",
    toolName: "save_file",
    toolTitle: "保存文件",
    isError: true,
  });
  assert.equal(tool.lastText, "保存文件 出错");
}

function assertArtifactSummary() {
  const base = createSessionListSummaryFromTranscript([
    { type: "assistant", content: "完成", timestamp: "2026-07-07 10:00:00" },
  ]);
  const artifacts = createSessionArtifactListSummary({
    dataTables: [{ title: "视频表", totalRows: 12 }],
    files: [{ filename: "报告.pdf", size: 1024, downloadId: 12 }],
  }, "2026-07-07 10:00:12");
  const merged = mergeSessionListSummary(base, artifacts);
  assert.equal(merged.lastText, "完成");
  assert.equal(merged.artifactCount, 2);
  assert.equal(merged.dataCount, 1);
  assert.equal(merged.fileCount, 1);
  assert.match(merged.artifactPreview, /视频表/);
  assert.match(sessionListSummarySearchText(merged), /报告\.pdf/);

  const internalOnly = createSessionArtifactListSummary({
    files: [{ filename: "内部.docx", artifactId: "artifact_1" }],
    items: [{ type: "file", filename: "内部2.docx", artifactId: "artifact_2" }],
  });
  assert.equal(internalOnly.artifactCount, 0);
  assert.equal(internalOnly.fileCount, 0);

  const runtimeShape = createSessionArtifactListSummary({
    total: 2,
    items: [
      { type: "dataTable", title: "视频表" },
      { type: "file", filename: "报告.pdf", downloadId: 12 },
    ],
    dataTables: [{ title: "视频表" }],
    files: [{ filename: "报告.pdf", downloadId: 12 }],
  });
  assert.equal(runtimeShape.artifactCount, 2);
  assert.equal(runtimeShape.dataCount, 1);
  assert.equal(runtimeShape.fileCount, 1);

  const imageCollection = createSessionArtifactListSummary({
    total: 2,
    imageCollections: [{ type: "imageCollection", title: "图集表", totalRows: 2 }],
  });
  assert.equal(imageCollection.artifactCount, 1);
  assert.equal(imageCollection.dataCount, 1);
  assert.equal(imageCollection.fileCount, 0);

  const duplicatedTables = createSessionArtifactListSummary({
    items: [
      { type: "dataTable", table: "同一张表", title: "同一张表", totalRows: 1 },
      { type: "dataTable", table: "同一张表", title: "同一张表", totalRows: 3 },
      { type: "imageCollection", table: "同一图集", title: "同一图集", totalRows: 2 },
      { type: "imageCollection", table: "同一图集", title: "同一图集", totalRows: 2 },
    ],
  });
  assert.equal(duplicatedTables.artifactCount, 2);
  assert.equal(duplicatedTables.dataCount, 2);
  assert.equal(duplicatedTables.fileCount, 0);
  assert.equal(duplicatedTables.artifactPreview, "同一图集 · 同一张表");

  const staleRowCountSummary = normalizeSessionListSummary({
    artifactCount: 2,
    dataCount: 1,
    fileCount: 0,
  });
  assert.equal(staleRowCountSummary.artifactCount, 1);
  assert.equal(mergeSessionListSummary(null, {
    artifactCount: 2,
    dataCount: 1,
    fileCount: 0,
  }).artifactCount, 1);

  const normalized = normalizeSessionListSummary(null);
  assert.equal(normalized.artifactCount, 0);
  assert.equal(normalized.version, 4);
}

function assertSessionListSnapshotFallback() {
  const expected = new PortClientError("PORT_REQUEST_TIMEOUT", "list_sessions timed out", {
    type: "list_sessions",
    timeoutMs: 1200,
  });
  assert.equal(isSessionListSnapshotSoftTimeout(expected), true);
  assert.equal(isSessionListSnapshotSoftTimeout(new PortClientError(
    "PORT_REQUEST_TIMEOUT",
    "get_state timed out",
    { type: "get_state", timeoutMs: 1200 },
  )), false);
  assert.equal(isSessionListSnapshotSoftTimeout(new PortClientError(
    "PORT_REQUEST_TIMEOUT",
    "list_sessions timed out",
    { type: "list_sessions", timeoutMs: 8000 },
  )), false);
  assert.equal(
    isSessionListSnapshotSoftTimeout(new Error("list_sessions timed out")),
    true,
    "bundled or legacy plain timeout errors should use the same cache fallback",
  );
  assert.equal(isSessionListSnapshotSoftTimeout(new Error("storage failed")), false);
}

function assertSourceContracts() {
  const sessionsFeature = read("src/capabilities/sessions/sessions-feature.js");
  const artifactsFeature = read("src/capabilities/sessions/artifacts/artifacts-feature.js");
  const artifactModel = read("src/capabilities/sessions/artifacts/artifact-model.js");
  const automationsFeature = read("src/capabilities/sessions/automations/automations-feature.js");
  const sidepanel = [sessionsFeature, artifactsFeature, artifactModel, automationsFeature].join("\n");
  const sidepanelCss = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url)) + read("src/capabilities/sessions/ui.css");
  const listMotion = read("src/sidepanel/ui/list-layout-motion.ts");
  const serviceWorker = read("src/background/service-worker.js");
  const sessionCommands = read("src/background/session/commands.js");
  const sessionArtifacts = read("src/background/session/artifacts.js");
  const sidepanelTransport = read("src/background/transports/sidepanel.js");
  const sessionStore = read("src/shared/session/session-store.ts");

  assert.match(
    sidepanel,
    /artifactsFeature\.scheduleSummaryBackfill\(list\)/,
    "session list should still schedule stale summary backfill",
  );
  assert.match(
    sidepanel,
    /commitSessionsListSearchHtml\(html,\s*searchQuery\)[\s\S]*artifactsFeature\.scheduleListHydration\(rows\.map\(row => row\.session\)\.filter\(Boolean\)\)/,
    "session list should reuse the existing async artifact hydration path after first paint",
  );
  assert.match(
    sidepanel,
    /function\s+renderSessionTreeCard[\s\S]*artifactsFeature\.getSummaryFromRecord\(s\)/,
    "session cards should read artifact counts from listSummary",
  );
  assert.match(
    sidepanel,
    /async function\s+hydrateSessionArtifactSummary[\s\S]*collectSessionArtifactsWithRuntime\(id,\s*source\)[\s\S]*syncSessionArtifactListSummary\(id,\s*summary\)/,
    "artifact hydration should sync computed source-of-truth counts back to listSummary",
  );
  assert.match(
    sidepanel,
    /function\s+syncSessionArtifactListSummary[\s\S]*type:\s*"sync_session_artifact_list_summary"[\s\S]*data:\s*Array\.isArray\(summary\.data\)[\s\S]*files:\s*Array\.isArray\(summary\.files\)/,
    "artifact summary sync should send the same hydrated artifact payload to the background",
  );
  assert.match(
    sidepanel,
    /const\s+SESSION_LIST_SORT_THROTTLE_MS\s*=/,
    "session list should throttle visual reordering separately from content refresh",
  );
  assert.match(
    sidepanel,
    /function\s+resolveSessionListRenderOrder[\s\S]*resolveStableSiblingOrders\([\s\S]*previousOrders:\s*sessionListVisibleOrderByParent[\s\S]*scheduleDeferredSessionListSortRefresh/,
    "session list should preserve the current sibling order while reorder is held or throttled",
  );
  assert.match(
    sidepanel,
    /function\s+buildSessionTreeModel[\s\S]*compare:\s*compareSessionListRenderOrder/,
    "session tree sibling sorting should use the render-order comparator",
  );
  assert.match(
    sidepanel,
    /const\s+pendingSessionDeleteIds\s*=\s*new Set\s*\(\)/,
    "session list should track pending deletes locally for smooth repeated delete clicks",
  );
  assert.match(
    sidepanel,
    /async function\s+deleteSessionFromList[\s\S]*pendingSessionDeleteIds\.add\(id\)[\s\S]*request\("delete_session"/,
    "session delete should optimistically enter a pending visual state and wait for a background acknowledgement",
  );
  assert.match(
    sidepanel,
    /async function\s+deleteSessionFromList[\s\S]*syncSessionDeleteVisualState\(id,\s*true\);\s*try\s*\{/,
    "session delete should update the clicked card directly instead of immediately re-rendering the whole list",
  );
  assert.match(
    sidepanel,
    /function\s+removeSessionChildWithAnimation[\s\S]*createSessionRemovalGhost\(node\)[\s\S]*node\.remove\(\)[\s\S]*playSessionRemovalGhost\(ghost\)/,
    "session list removals should remove layout nodes immediately and animate a compositor-friendly ghost",
  );
  assert.match(
    sidepanel,
    /function\s+morphSessionChildren[\s\S]*const\s+nextKeys\s*=\s*new Set[\s\S]*!nextKeys\.has\(key\)[\s\S]*if\s*\(animateRemovals\)\s*removeSessionChildWithAnimation\(child\)[\s\S]*let\s+cursor\s*=\s*null/,
    "obsolete keyed sessions should animate from their original position outside search, with immediate removal available to search reconciliation",
  );
  assert.match(
    sidepanel,
    /function\s+createSessionRemovalGhost[\s\S]*closest\("\.sessions-list, \.automations-list"\)[\s\S]*classList\.add\("session-removal-ghost"[\s\S]*layer\.appendChild\(ghost\)/,
    "session removal ghosts should stay in their local list coordinate system",
  );
  assert.match(
    sidepanel,
    /function\s+commitSessionsListHtml[\s\S]*captureSessionListCardRects\(sessionsList\)[\s\S]*animateSessionListLayout\(previousRects\)/,
    "session list commits should capture card positions before morphing and animate after morphing",
  );
  assert.match(
    sidepanel,
    /function\s+commitSessionsListSearchHtml[\s\S]*query === sessionsListRenderedSearchQuery[\s\S]*commitSessionsListHtml\(html,\s*\{\s*animate\s*\}\)[\s\S]*function\s+commitSessionsListHtml[\s\S]*if\s*\(!animate\)\s*settleSessionListMotion\(\)[\s\S]*animateRemovals:\s*animate/,
    "search query changes should reconcile immediately without carrying delete or layout animations across keystrokes",
  );
  assert.match(
    sidepanel,
    /function\s+settleSessionListMotion[\s\S]*layoutMotion\.settle\(\)[\s\S]*:scope\s*>\s*\.session-removal-ghost[\s\S]*ghost\.remove\(\)/,
    "an immediate search reconcile should settle in-flight cards and discard stale removal ghosts",
  );
  assert.match(
    sidepanel,
    /function\s+commitSessionsListHtml[\s\S]*shouldStageSessionsEmptyTransition\(markup\)[\s\S]*transitionSessionsListToEmpty\(markup,\s*scrollTop\)/,
    "session list should stage the empty-state render until the final card has animated out",
  );
  assert.match(
    sidepanel,
    /function\s+transitionSessionsListToEmpty[\s\S]*listExit\.start\(Array\.from\(sessionsList\.children\)[\s\S]*sessionsList\.innerHTML = markup[\s\S]*sessions-empty-enter/,
    "final session deletion should fade the original card in place before rendering the empty state",
  );
  assert.match(
    sidepanel,
    /createListExitTransition\(\{[\s\S]*className:\s*"session-tree-node-final-exit"[\s\S]*clipPath:\s*"inset\(0 0 100% 0\)"[\s\S]*duration:\s*SESSION_LIST_LAYOUT_MOVE_MS[\s\S]*easing:\s*"cubic-bezier\(0\.16, 1, 0\.3, 1\)"/,
    "the final session should use the same crisp collapse motion as list deletion",
  );
  assert.match(
    listMotion,
    /Promise\.all\(animations\.map\(animation => animation\.finished[\s\S]*\.then\(finish\)/,
    "the empty state should wait for the compositor collapse to finish instead of racing it with a timer",
  );
  assert.match(
    sidepanel,
    /function\s+animateSessionListLayout[\s\S]*layoutMotion\.animate\(previousRects\)/,
    "session list should use the shared layout motion lifecycle",
  );
  assert.match(
    listMotion,
    /const moves = items\(root\(\)\)\.map[\s\S]*getBoundingClientRect\(\)[\s\S]*for \(const \{ item, previous, next \} of moves\)[\s\S]*item\.animate\?\.\([\s\S]*translate3d/,
    "shared list motion should read all card geometry before starting WAAPI transforms",
  );
  assert.match(
    sidepanel,
    /function\s+playSessionRemovalGhost[\s\S]*ghost\.animate\(\[\s*\{ clipPath: "inset\(0 0 0 0\)" \},\s*\{ clipPath: "inset\(0 0 100% 0\)" \},?\s*\][\s\S]*duration:\s*SESSION_LIST_LAYOUT_MOVE_MS[\s\S]*easing:\s*"cubic-bezier\(0\.16, 1, 0\.3, 1\)"/,
    "removed sessions should collapse behind retained cards without opacity blending",
  );
  assert.match(
    sidepanelCss,
    /\.session-card\.is-deleting/,
    "session cards should have a pending-delete visual state",
  );
  assert.match(
    sidepanelCss,
    /\.session-tree-node\.session-tree-node-final-exit/,
    "the final session tree node should have an exit transition state",
  );
  assert.match(
    sidepanelCss,
    /\.sessions-list\s*\{[\s\S]*isolation:\s*isolate[\s\S]*\.session-removal-ghost\s*\{[\s\S]*position:\s*absolute[\s\S]*z-index:\s*0[\s\S]*will-change:\s*clip-path/,
    "session delete ghosts should be isolated in the rear list layer",
  );
  assert.match(
    sidepanelCss,
    /\.session-removal-ghost\.is-exiting\s*\{[^}]*clip-path:\s*inset\(0 0 100% 0\)[^}]*transition:\s*clip-path/,
    "session delete fallback should collapse instead of blending opacity",
  );
  assert.match(
    sidepanelCss,
    /\.session-tree-node\.session-tree-node-final-exit[\s\S]*will-change:\s*clip-path/,
    "the final session card should collapse in place without a fixed-position clone",
  );
  assert.match(
    sidepanelCss,
    /\.sessions-list\s*>\s*\.session-tree-node:not\(\.session-removal-ghost\)\s*\{[^}]*z-index:\s*1[\s\S]*\.session-card\.is-layout-moving\s*\{[^}]*z-index:\s*2[\s\S]*\.sessions-list:has\(>\s*\.session-removal-ghost\)[\s\S]*\.session-card::before[\s\S]*background:\s*var\(--bg-primary\)/,
    "live cards should carry an opaque foreground surface over removal ghosts during delete and search reconciliation",
  );
  assert.doesNotMatch(
    sidepanelCss,
    /\.session-card\.is-deleting\s*\{[^}]*transform:/,
    "pending delete state should not move or scale session text",
  );
  assert.doesNotMatch(
    sidepanelCss,
    /\.session-card\.is-deleting\s*\{[^}]*opacity:/,
    "pending delete state should not stack another opacity animation under the final fade",
  );
  assert.doesNotMatch(
    sidepanelCss,
    /\.session-delete-btn\[aria-busy="true"\][\s\S]*@keyframes\s+session-delete-drift/,
    "pending deletion should not repaint an animated icon under the final compositor fade",
  );
  assert.match(
    sidepanelCss,
    /\.sessions-empty\.sessions-empty-enter[\s\S]*\.sessions-empty\.sessions-empty-enter\.is-visible/,
    "empty session state should fade in after the final delete transition",
  );
  assert.match(
    sidepanelTransport,
    /delete_session:\s*\{\s*method:\s*"sessions.remove",\s*response:\s*"delete_session_result"[\s\S]*args:\s*message\s*=>\s*\[message\.sessionId/,
    "sidepanel transport should acknowledge request-based UI deletes through the Background API",
  );
  assert.match(
    sidepanel,
    /const\s+pendingAutomationDeleteIds\s*=\s*new Set\s*\(\)/,
    "automation cards should track pending deletes locally",
  );
  assert.match(
    sidepanel,
    /async function\s+deleteAutomationFromList[\s\S]*pendingAutomationDeleteIds\.add\(id\)[\s\S]*request\("delete_automation"[\s\S]*prepareListRemovalLayer\(\)[\s\S]*renderAutomationsList\(\)/,
    "automation deletion should prepare and optimistically animate while background instance cleanup runs",
  );
  assert.match(
    sidepanel,
    /function\s+prepareListRemovalLayer[\s\S]*requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => resolve\(\)\)\)/,
    "optimistic list removal should give the compositor one painted frame to promote the layer",
  );
  assert.match(
    sidepanel,
    /function\s+commitAutomationsListHtml[\s\S]*captureAutomationListItemRects\(automationsList\)[\s\S]*morphSessionsListHtml\(automationsList,\s*markup\)[\s\S]*animateAutomationListLayout\(previousRects\)/,
    "automation refreshes should keyed-morph cards and instances before applying FLIP motion",
  );
  assert.match(
    sidepanel,
    /function\s+automationListItemKey[\s\S]*automation-card[\s\S]*automation-run[\s\S]*automation-artifact-shelf/,
    "automation cards, instances, and instance artifact shelves should have stable DOM keys",
  );
  assert.match(
    automationsFeature,
    /function\s+renderAutomationRunArtifactBadge\(summary\s*=\s*null\)[\s\S]*return\s+count\s*\?\s*`<span class="automation-run-artifacts">\$\{escapeHtml\(t\("artifacts"\)\)\} \$\{count\}<\/span>`\s*:\s*""/,
    "automation run artifact labels should render only when the run has artifacts",
  );
  assert.doesNotMatch(
    automationsFeature,
    /无产物/,
    "automation runs without artifacts should not render an empty-state label",
  );
  assert.match(
    sidepanel,
    /createListLayoutMotion\(\{[\s\S]*automation-card\[data-automation-id\][\s\S]*automation-run\[data-run-id\][\s\S]*function\s+animateAutomationListLayout[\s\S]*layoutMotion\.animate\(previousRects\)/,
    "automation cards and instances should animate layout movement on the compositor",
  );
  assert.match(
    sidepanel,
    /createListExitTransition\(\{[\s\S]*className:\s*"automation-card-final-exit"[\s\S]*function\s+transitionAutomationListToEmpty[\s\S]*listExit\.start\(cards[\s\S]*automation-empty-enter/,
    "the final automation card should fade in place before the automation empty state appears",
  );
  assert.match(
    sidepanelCss,
    /\.automation-card\.is-deleting,[\s\S]*\.automation-card\.automation-card-final-exit[\s\S]*will-change:\s*opacity/,
    "automation deletion should pre-promote the final card opacity layer",
  );
  assert.match(
    sidepanelCss,
    /\.automation-card\.is-layout-moving\s*\{[^}]*will-change:\s*transform[\s\S]*\.automation-run\.is-layout-moving\s*\{[^}]*will-change:\s*transform/,
    "automation cards and instances should expose compositor layout states",
  );
  assert.match(
    sidepanelCss,
    /\.automation-empty\.automation-empty-enter[\s\S]*\.automation-empty\.automation-empty-enter\.is-visible/,
    "automation empty state should fade in after the final card",
  );
  assert.match(
    sidepanel,
    /sessionsList\?\.addEventListener\("pointerenter"[\s\S]*sessionsList\?\.addEventListener\("pointerleave"[\s\S]*sessionsList\?\.addEventListener\("focusin"[\s\S]*sessionsList\?\.addEventListener\("focusout"[\s\S]*sessionsList\?\.addEventListener\("scroll"/,
    "session list should hold reorder while hovered, focused, or scrolling",
  );
  assert.match(
    sidepanel,
    /function\s+buildSessionSearchText[\s\S]*sessionListSummarySearchText\(listSummary\)/,
    "session search should use listSummary text",
  );
  assert.match(
    sidepanel,
    /async function\s+openArtifactsPanel[\s\S]*const\s+renderSeq\s*=\s*\+\+artifactsPanelRenderSeq[\s\S]*renderArtifactsPanelShell\(id\)[\s\S]*artifactsPanel\.classList\.remove\("hidden"\)[\s\S]*renderArtifactsPanel\(id,\s*\{\s*renderSeq\s*\}\)/,
    "artifact panel should render a stable shell before it is shown",
  );
  assert.match(
    sidepanel,
    /function\s+commitArtifactsPanelHtml/,
    "artifact panel should avoid rewriting identical content",
  );
  assert.match(
    sidepanel,
    /renderSeq\s*!==\s*artifactsPanelRenderSeq[\s\S]*artifactsPanelSessionId\s*!==\s*id/,
    "artifact panel async refresh should ignore stale results",
  );
  assert.match(
    sidepanelTransport,
    /hydrate_session_list_summaries:\s*\{\s*method:\s*"sessions\.hydrateListSummaries"/,
    "background should expose lazy list summary backfill",
  );
  assert.match(
    sidepanelTransport,
    /sync_session_artifact_list_summary:\s*\{\s*method:\s*"artifacts\.syncSummary"/,
    "background should persist artifact hydration results into listSummary",
  );
  assert.match(
    serviceWorker,
    /hydrateListSummaries:\s*sessionArtifacts\.hydrateListSummaries[\s\S]*syncSummary:\s*sessionArtifacts\.syncSummary/,
    "background API should bind list-summary commands to the canonical runtime implementations",
  );
  assert.match(
    sessionArtifacts,
    /async function\s+syncSessionArtifactListSummaryRuntime[\s\S]*createSessionArtifactListSummary\(artifacts,\s*nowBeijingDateTime\(\)\)[\s\S]*touchSession:\s*false/,
    "artifact summary reconcile should not bump session ordering timestamps",
  );
  assert.match(
    sessionArtifacts,
    /async function\s+buildSessionListSummaryRuntime[\s\S]*createSessionListSummaryFromTranscript\(safeTranscript,\s*summaryAt\)[\s\S]*createSessionArtifactListSummary\(artifacts,\s*summaryAt\)/,
    "stored listSummary should be built from both transcript and canonical artifacts",
  );
  assert.match(
    sessionCommands,
    /persistSessionRecord[\s\S]*sessionArtifacts\.buildListSummary\(id,\s*\[\.\.\.record\.transcript,\s*\.\.\.record\.currentTranscript\],\s*now\)/,
    "saving a terminal session record should not write a transcript-only listSummary",
  );
  assert.match(
    sessionArtifacts,
    /hydrateSessionListSummariesRuntime[\s\S]*buildSessionListSummaryRuntime\(id,\s*transcript,\s*fallbackAt\)/,
    "summary backfill should reuse the same complete listSummary builder",
  );
  assert.match(
    sessionArtifacts,
    /recordSessionResourceEvent[\s\S]*appendResources[\s\S]*scheduleStoredSessionArtifactSummaryRefresh/,
    "resource events should invalidate artifact summary and recompute canonical counts",
  );
  assert.doesNotMatch(
    `${sessionCommands}\n${sessionArtifacts}`,
    /createSessionArtifactListSummary\(\{\s*items\s*\}/,
    "artifact summary should not be derived from append results as an accumulating event stream",
  );
  assert.match(
    sessionArtifacts,
    /function\s+isStoredSessionListSummaryStale[\s\S]*hasRepeatedArtifactPreviewTokens/,
    "stored duplicate artifact previews should force summary backfill",
  );
  assert.match(
    sidepanel,
    /function\s+isSessionListSummaryStale[\s\S]*hasRepeatedArtifactPreviewTokens/,
    "sidepanel should request backfill for duplicate artifact previews even when the version is current",
  );
  assert.match(
    sidepanel,
    /function\s+getSessionListArtifactSummaryFromSession[\s\S]*isSessionListSummaryStale\(session\?\.listSummary\)[\s\S]*return getSessionListArtifactSummary\(id\)[\s\S]*!summary\.artifactCount\)[\s\S]*return getSessionListArtifactSummary\(id\)/,
    "session list should prefer listSummary but keep the previous async artifact-summary fallback",
  );
  assert.match(
    sessionArtifacts,
    /const\s+dataItems\s*=\s*mergeSessionDataArtifacts\([\s\S]*flowArtifacts\?\.imageCollections[\s\S]*flowArtifacts\?\.dataTables[\s\S]*ledger\.imageCollections[\s\S]*ledger\.dataTables/,
    "runtime artifacts should merge all data-like resources by table before splitting image collections and data tables",
  );
  assert.match(
    sessionStore,
    /listSummary:\s*normalizeSessionListSummary/,
    "session metadata should always expose a normalized listSummary",
  );
}
