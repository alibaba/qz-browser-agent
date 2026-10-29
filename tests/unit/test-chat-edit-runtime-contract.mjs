import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

assertUiRuntimeContracts();

function assertUiRuntimeContracts() {
  const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
  const chatRunController = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-run-controller.ts"), "utf8"), { mode: "transform" });
  const chatScrollFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-scroll-feature.ts"), "utf8"), { mode: "transform" });
  const transcriptReconcileFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/recovery.ts"), "utf8"), { mode: "transform" });
  const composerFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/composer-feature.ts"), "utf8"), { mode: "transform" });
  const queuedFollowupsFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/queued-followups-feature.ts"), "utf8"), { mode: "transform" });
  const eventRouter = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/sidepanel-event-router.ts"), "utf8"), { mode: "transform" });
  const sidepanelPortRuntime = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/sidepanel-port-runtime.ts"), "utf8"), { mode: "transform" });
  const workspaceComposition = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/workspace-composition.ts"), "utf8"), { mode: "transform" });
  const sessionsFeature = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/sessions/sessions-feature.ts"), "utf8"), { mode: "transform" });
  const sessionNavigationFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/sessions/session-navigation-feature.ts"), "utf8"), { mode: "transform" });
  const artifactsFeature = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/sessions/artifacts/artifacts-feature.ts"), "utf8"), { mode: "transform" });
  const sessionUi = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/sessions/ui.ts"), "utf8"), { mode: "transform" });
  const conversationBenchmark = readFileSync(join(root, "tests/benchmarks/conversation-render/runtime.mjs"), "utf8");
  const conversationBenchmarkHost = readFileSync(join(root, "tests/benchmarks/conversation-render/host.mjs"), "utf8");
  const sidepanel = [
    transcriptRenderer,
    chatRunController,
    chatScrollFeature,
    transcriptReconcileFeature,
    composerFeature,
    queuedFollowupsFeature,
    eventRouter,
    sidepanelPortRuntime,
    workspaceComposition,
    sessionsFeature,
    sessionNavigationFeature,
    artifactsFeature,
    conversationBenchmark,
    conversationBenchmarkHost,
  ].join("\n");
  const sidepanelCss = ["src/sidepanel/sidepanel.css", "src/capabilities/sessions/ui.css"]
    .map(path => readStylesheetSource(join(root, path))).join("\n");
  const sidepanelHtml = readFileSync(join(root, "src/sidepanel/sidepanel.html"), "utf8");
  const serviceWorker = stripTypeScriptTypes(readFileSync(join(root, "src/background/service-worker.ts"), "utf8"), { mode: "transform" });
  const sessionCommands = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/commands.ts"), "utf8"));
  const sessionRuntimeState = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/runtime-state.ts"), "utf8"));
  const sidepanelTransport = stripTypeScriptTypes(readFileSync(join(root, "src/background/transports/sidepanel.ts"), "utf8"), { mode: "transform" });
  const runtimeReducer = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/runtime-reducer.ts"), "utf8"));
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));
  const sessionCodec = stripTypeScriptTypes(readFileSync(join(root, "src/shared/session/session-codec.ts"), "utf8"));

  assert.match(sidepanel, /data-tooltip="\$\{tHtml\("edit"\)\}"\s+title="\$\{tHtml\("edit"\)\}"\s+aria-label="\$\{tHtml\("edit"\)\}"/, "edit icon should expose a simple Edit tooltip");
  assert.match(sidepanel, /class="msg-user-row"/, "user bubbles should keep inline message actions beside the bubble");
  assert.match(sidepanelCss, /\.msg-user-edit-btn::before[\s\S]*content:\s*attr\(data-tooltip\)/, "edit tooltip should be rendered from data-tooltip");
  assert.match(sidepanelCss, /\.msg-user-edit-btn::before[\s\S]*border-radius:\s*999px/, "edit tooltip should use an oval pill shape");
  assert.match(sidepanelCss, /\.msg-user-edit-btn::after\s*\{\s*content:\s*none;\s*\}/, "edit tooltip should not render an arrow");
  assert.match(sidepanel, /class="qz-icon-btn qz-icon-btn--sm msg-action-btn msg-user-edit-btn"/, "edit icon should consume the shared icon-button primitive");
  assert.match(sidepanelCss, /--control-surface-hover:\s*var\(--control-hover-fill\)/, "edit icon should inherit the shared quiet hover fill");
  assert.match(sidepanelCss, /\.msg-user-row\s*\{[\s\S]*align-items:\s*flex-end/, "edit icon should align to the user bubble bottom edge");
  assert.doesNotMatch(sidepanelCss, /\.msg-user-actions\s*\{[\s\S]*margin:\s*3px\s+3px\s+0\s+0/, "edit icon should not reserve a separate row below the bubble");
  assert.match(sidepanelCss, /\.msg-user-edit-btn::before\s*\{[\s\S]*bottom:\s*calc\(100% \+ 3px\)/, "edit tooltip should appear above the icon");
  assert.match(sidepanel, /class="qz-field qz-field--bare msg-user-edit-input"/, "message editing should use the shared borderless field treatment");
  assert.match(sidepanelCss, /textarea\.msg-user-edit-input\s*\{[\s\S]*border:\s*0[\s\S]*resize:\s*none/, "message editing should override the generic textarea border and resize handle");
  assert.match(sidepanelHtml, /id="chat-dock"[\s\S]*id="status-bar"[\s\S]*<footer id="input-area"[^>]*>/, "status and composer should live in one chat dock");
  assert.match(sidepanelCss, /\.chat-dock\s*\{[\s\S]*border-top:\s*1px solid var\(--border\)/, "chat dock should own the bottom separator");
  const appClasses = sidepanelHtml.match(/id="app"[^>]*class="([^"]*)"/)?.[1].split(/\s+/) || [];
  for (const utility of ["qz:rounded-none", "qz:bg-surface", "qz:w-full", "qz:h-full", "qz:flex", "qz:flex-col"]) {
    assert.ok(appClasses.includes(utility), `the full-panel square shell requires ${utility}`);
  }
  assert.match(sidepanelCss, /\.chat-dock\s*\{[\s\S]*border-radius:\s*0/, "chat dock should not add bottom corner rounding");
  const inputAreaClasses = sidepanelHtml.match(/id="input-area"[^>]*class="([^"]*)"/)?.[1].split(/\s+/) || [];
  for (const utility of ["qz:pt-1.75", "qz:px-2.5", "qz:pb-1"]) {
    assert.ok(inputAreaClasses.includes(utility), `the compact 7px/10px/4px composer inset requires ${utility}`);
  }
  assert.match(sidepanelCss, /#input-area\s*\{[^}]*border-radius:\s*0/, "composer should not round the shell corners");
  assert.match(sidepanelCss, /#messages\s*\{[\s\S]*--chat-tail-safe-bottom:\s*12px[\s\S]*--messages-top-gap:\s*18px[\s\S]*min-height:\s*0[\s\S]*padding:\s*0 10px var\(--chat-tail-safe-bottom\)[\s\S]*scrollbar-gutter:\s*stable both-edges/, "scrolling messages should keep symmetric scrollbar gutters and the standard reading inset");
  assert.match(sidepanelCss, /#messages\[data-chat-state="landing"\]\s*\{[\s\S]*padding-inline:\s*14px[\s\S]*scrollbar-gutter:\s*auto/, "landing should keep its original symmetric inset without reserving scroll gutters");
  assert.match(sidepanelCss, /#messages\s*\{[\s\S]*--viewport-anchor-before-space:\s*0px[\s\S]*--viewport-anchor-after-space:\s*0px/, "viewport anchor compensation should be inert outside an active interaction");
  assert.match(sidepanelCss, /#messages::before\s*\{[\s\S]*height:\s*calc\(var\(--messages-top-gap\)\s*\+\s*var\(--viewport-anchor-before-space\)\)/, "messages should combine the base top gap with automatic before-space compensation");
  assert.match(sidepanelCss, /#messages::after\s*\{[\s\S]*height:\s*var\(--viewport-anchor-after-space\)/, "messages should expose automatic after-space compensation");
  assert.match(sidepanelCss, /#messages\s*\{[\s\S]*scroll-padding-bottom:\s*var\(--chat-tail-safe-bottom\)/, "messages should expose tail-safe scroll padding");
  assert.match(sidepanelCss, /#messages\s*\{[\s\S]*scrollbar-color:\s*transparent transparent/, "chat scrollbar should stay visually quiet by default");
  assert.match(sidepanelCss, /#messages::-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*transparent/, "chat webkit scrollbar thumb should not look like a dock artifact");
  assert.match(sidepanelCss, /#messages:hover::-webkit-scrollbar-thumb,[\s\S]*#messages:focus-within::-webkit-scrollbar-thumb[\s\S]*background:\s*color-mix/, "chat scrollbar should appear only on interaction");
  assert.match(sidepanelCss, /#messages\s*\{[\s\S]*overflow-anchor:\s*none/, "messages should not let browser scroll anchoring fight tail following");

  const patchUserBody = extractFunction(sidepanel, "patchUserTranscriptElement");
  assert.match(patchUserBody, /const\s+hasEditShell\s*=\s*Boolean\(el\.querySelector\("\.msg-user-edit-shell"\)\)/, "user patch should detect lingering edit shell");
  assert.match(patchUserBody, /content\.innerHTML\s*=\s*""/, "user patch should clear edit shell before repainting normal text");
  assert.match(patchUserBody, /!hasEditShell\s*&&\s*!el\.classList\.contains\("is-resending"\)\s*&&\s*hasActiveSelectionInsideNode\(el\)/, "selection protection must not block edit/resend repaint");

  const renderStatusVisibilityBody = extractFunction(sidepanel, "renderStatusVisibility");
  assert.match(renderStatusVisibilityBody, /const\s+wasHidden\s*=\s*statusBar\.classList\.contains\("hidden"\)/, "status visibility should detect layout changes");
  assert.match(renderStatusVisibilityBody, /scroll\.settleAfterDockLayout\(\)/, "status bar layout changes should settle the chat dock tail");
  assert.match(renderStatusVisibilityBody, /scroll\.updateSafeArea\(\)/, "status visibility should refresh chat tail safe area");

  const installTailObserversBody = extractFunction(sidepanel, "installChatTailLayoutObservers");
  assert.match(installTailObserversBody, /new ResizeObserver/, "chat dock layout changes should use ResizeObserver");
  assert.match(installTailObserversBody, /observer\.observe\(chatDock\)/, "chat dock resize should preserve the visible tail");
  assert.match(installTailObserversBody, /observer\.observe\(messagesEl\)/, "message viewport resize should preserve the visible tail");
  assert.match(installTailObserversBody, /dockLayoutTransaction[\s\S]*restoreDockLayoutTransaction[\s\S]*endDockLayoutTransaction/, "composer-only dock resize should preserve the current message viewport until ResizeObserver delivers it");

  const preserveDockViewportBody = extractFunction(sidepanel, "preserveViewportDuringDockLayout");
  assert.match(preserveDockViewportBody, /previousScrollTop[\s\S]*dockChanged[\s\S]*viewportChanged[\s\S]*transientScrollChanged/, "dock layout transaction should preserve both final geometry changes and transient scroll clamping");
  assert.match(preserveDockViewportBody, /cancelScheduledChatTailScroll\(\)[\s\S]*(?:restoreDockScrollTop|restoreDockLayoutTransaction)/, "dock layout transaction should replace stale tail writes with the preserved viewport");
  assert.doesNotMatch(chatScrollFeature, /DOCK_VIEWPORT_HOLD_FRAMES|framesRemaining/, "dock layout transaction lifetime must follow ResizeObserver delivery rather than a fixed frame count");

  const lockTailBody = extractFunction(sidepanel, "lockChatTailForSubmittedAction");
  assert.match(lockTailBody, /chatTailLockUntil\s*=\s*Date\.now\(\)\s*\+\s*CHAT_TAIL_LOCK_MS/, "sending a message should briefly lock the chat tail");
  const applyChatTailScrollBody = extractFunction(sidepanel, "applyChatTailScroll");
  assert.match(applyChatTailScrollBody, /updateChatTailSafeArea\(\)/, "scroll to bottom should sync tail safe area before applying scroll");
  const scheduleChatTailScrollBody = extractFunction(sidepanel, "scheduleChatTailScroll");
  assert.match(scheduleChatTailScrollBody, /pendingChatTailScroll\s*=\s*\{/, "chat tail writes should merge into one pending frame task");
  assert.match(scheduleChatTailScrollBody, /Math\.max\(nextFrames,\s*pendingChatTailScroll\?\.frames\s*\|\|\s*0\)/, "settle requests should preserve the longest pending tail sequence");

  assert.match(transcriptReconcileFeature, /watchdogStaleMs\s*=\s*Math\.max\(0,\s*Number\(options\.watchdogStaleMs\)\s*\|\|\s*1600\)/, "stream watchdog should detect stale chat transcript quickly");
  assert.match(transcriptReconcileFeature, /watchdogMinIntervalMs\s*=\s*Math\.max\(0,\s*Number\(options\.watchdogMinIntervalMs\)\s*\|\|\s*1800\)/, "stream watchdog should be globally throttled");
  assert.match(sidepanel, /transcriptLastChangedAtBySessionId\s*=\s*new Map\(\)/, "sidepanel should track last transcript updates per session");
  assert.match(sidepanel, /TRANSCRIPT_LIVE_RENDER_INTERVAL_MS\s*=\s*48/, "live transcript rendering should have a responsive coalescing interval");
  assert.match(sidepanel, /transcriptLiveRunIdBySessionId\s*=\s*new Map\(\)/, "live transcript rendering should prefer explicit run boundaries over history guessing");
  assert.match(sidepanel, /function\s+patchLiveTranscriptDomTail/, "live transcript rendering should keep a small insert/update-only tail path");
  assert.doesNotMatch(sidepanel, /function\s+patchChatTranscriptDomSuffix|transcriptUiPlanHistoryBySessionId|transcriptUiPlanSnapshotBySessionId|createIncrementalTailTranscriptRenderPlan|assignTranscriptUiKeysFromSource/, "live rendering should not keep the old suffix cache/delete pipeline");
  const patchLiveTailBody = extractFunction(sidepanel, "patchLiveTranscriptDomTail");
  assert.match(patchLiveTailBody, /history\.findIndex\(isLiveVisibleTranscriptEntry\)/, "live tail patching should anchor around the first live visible node");
  assert.match(patchLiveTailBody, /firstLive\s*>=\s*0[\s\S]*Math\.max\(0,\s*firstLive\s*-\s*1\)[\s\S]*history\.length\s*-\s*1/, "a run with no currently live entry should settle only the final visible transcript node");
  assert.match(patchLiveTailBody, /dataset\.transcriptLive\s*===\s*["']true["'][\s\S]*Math\.min\(patchStart,\s*previouslyLive\)/, "tail patching should include entries that became final since their previous DOM render");
  assert.match(patchLiveTailBody, /while\s*\(patchStart\s*>\s*0\s*&&\s*!existingByKey\.has\(history\[patchStart\s*-\s*1\]/, "coalesced tail entries should rewind only to the nearest existing DOM anchor");
  assert.doesNotMatch(patchLiveTailBody, /fallbackReason\s*=\s*["']no-live-entry["']/, "a completed tail entry should remain on the incremental patch path");
  assert.match(patchLiveTailBody, /for\s*\(let\s+index\s*=\s*patchStart;\s*index\s*<\s*history\.length/, "live tail patching should update only the active tail");
  assert.match(patchLiveTailBody, /isLivePatchDomCompatible\(history,\s*patchStart,\s*existingByKey\)/, "live tail patching should fall back whenever keyed DOM no longer matches the UI projection");
  assert.ok(
    patchLiveTailBody.indexOf("isLivePatchDomCompatible(history, patchStart, existingByKey)")
      < patchLiveTailBody.indexOf('fallbackReason = "missing-anchor"'),
    "projection mismatches should be classified before their stale DOM makes the old anchor disappear",
  );
  assert.doesNotMatch(patchLiveTailBody, /retireTranscriptElement|removeStale|querySelectorAll\("\[data-transcript-key\]"\)|while\s*\(node\)/, "live tail patching must not delete transcript DOM nodes");
  const projectionCompatibilityBody = extractFunction(sidepanel, "isLivePatchDomCompatible");
  assert.match(projectionCompatibilityBody, /desiredKeys[\s\S]*existingKeys/, "projection compatibility should compare desired and rendered transcript keys");
  assert.match(projectionCompatibilityBody, /existingKeys\[index\]\s*!==\s*desiredKeys\[index\]/, "projection compatibility should require an exact stable prefix");
  assert.match(projectionCompatibilityBody, /desiredTail[\s\S]*existingKeys\.slice\(start\)\.every/, "projection compatibility should reject every stale tail key");
  const syncTranscriptDomMetadataBody = extractFunction(sidepanel, "syncTranscriptDomMetadata");
  assert.match(syncTranscriptDomMetadataBody, /dataset\.transcriptLive\s*=\s*isLiveVisibleTranscriptEntry\(entry\)/, "every keyed transcript node should retain its last rendered live state");
  const scheduleTranscriptCacheRenderBody = extractFunction(sidepanel, "scheduleTranscriptCacheRender");
  assert.match(scheduleTranscriptCacheRenderBody, /scheduler\.requestRender\(id,\s*requestedDelay\)/, "renderer should delegate pending work to its scheduler");
  // Coalescing, cancellation and bounded input yielding run against the scheduler in test-transcript-scheduler.mjs.
  const renderChatTranscriptBody = extractFunction(sidepanel, "renderChatTranscript");
  assert.match(renderChatTranscriptBody, /createTranscriptRenderPlan\(id,\s*history/, "rendering should first build a transcript UI plan");
  assert.match(renderChatTranscriptBody, /patchLiveTranscriptDomTail\(id,\s*renderedHistory\)/, "live rendering should try the insert/update-only tail path before full reconcile");
  assert.match(renderChatTranscriptBody, /if\s*\(!patched\)[\s\S]*reconcileChatTranscriptDom/, "snapshot/full reconcile should remain the only path that removes stale transcript nodes");
  assert.doesNotMatch(renderChatTranscriptBody, /renderStatusVisibility\(|renderQueuedFollowups\(/, "transcript renderer should not refresh dock or queue surfaces during live typing");
  assert.doesNotMatch(renderChatTranscriptBody, /renderArtifactsPanelIfOpen\(|scheduleMissingSessionArtifactHydration\(/, "transcript renderer should not refresh external artifact panels during live typing");
  const benchmarkReplayBody = extractFunction(conversationBenchmark, "runLiveReplay");
  assert.match(benchmarkReplayBody, /const\s+playbackProbe\s*=\s*startPlaybackProbe\(\)/, "stream replay should observe playback concurrency throughout fixture delivery");
  assert.match(benchmarkReplayBody, /const\s+playbackSettle\s*=\s*await\s+settleAssistantPlayback\(\)[\s\S]*const\s+interaction\s*=\s*interactionProbe\.stop\(\)/, "stream interaction probes should stay active until assistant playback settles");
  assert.match(benchmarkReplayBody, /metrics\.playbackSettle\s*=\s*playbackSettle/, "stream metrics should retain the completed assistant playback result");
  assert.match(benchmarkReplayBody, /metrics\.playbackConcurrency\s*=\s*playbackConcurrency/, "stream metrics should retain the playback concurrency high-water mark");
  const benchmarkPlaybackProbeBody = extractFunction(conversationBenchmark, "startPlaybackProbe");
  assert.match(benchmarkPlaybackProbeBody, /requestAnimationFrame\(tick\)/, "playback concurrency should be sampled on visual frames");
  const benchmarkActivePlaybackBody = extractFunction(conversationBenchmark, "countActiveAssistantPlayback");
  assert.match(benchmarkActivePlaybackBody, /host\.hasAssistantPlaybackState\(element\)/, "playback concurrency should count actual assistant playback states");
  const benchmarkPlaybackSettleBody = extractFunction(conversationBenchmark, "settleAssistantPlayback");
  assert.match(benchmarkPlaybackSettleBody, /countPendingAssistantPlayback\(\)/, "benchmark playback settling should observe rendered assistant completion state");
  const benchmarkLivePatchSummaryBody = extractFunction(conversationBenchmark, "summarizeLivePatch");
  assert.match(benchmarkLivePatchSummaryBody, /"no-live-entry",\s*"no-existing-dom",\s*"projection-mismatch"/, "benchmark health should skip only intentional live-patch bootstrap and projection fallbacks");
  const benchmarkResetBody = extractFunction(conversationBenchmarkHost, "reset");
  assert.match(benchmarkResetBody, /options\.runController\.resetState\([\s\S]*options\.transcriptReconcile\.reset\(\)[\s\S]*options\.sessionState\.reset\(\)/, "benchmark modes should reset run, reconcile, and session state before replay");
  const transcriptTrackRunBody = extractFunction(sidepanel, "trackBackgroundRun");
  assert.match(transcriptTrackRunBody, /sessionState\.applyEvent\(\{\s*\.\.\.event,\s*sessionId\s*\},\s*\{\s*transcript:\s*!ignoreTranscript\s*\}\)/, "background events should enter the SessionState reducer through one sidepanel entrypoint");
  assert.match(workspaceComposition, /port\.onMessage\(eventRouter\.handle\)/, "the port should route every event through the single event router");
  assert.match(workspaceComposition, /if\s*\(await ui\.restorePage\(getCurrentTab\(\), initialView\.state\) === "failed"\)\s*\{\s*switchTab\(tabs\.CHAT,\s*\{\s*refresh:\s*false\s*\}\);\s*await ui\.restorePage\(tabs\.CHAT, null\)/, "a failed page restore should return to Chat through its normal restore path");
  assert.match(workspaceComposition, /async restore\s*\(state,\s*\{\s*signal\s*\}\)[\s\S]*else await navigation\.transitionToSession\(null,\s*\{\s*reload:\s*true,\s*signal\s*\}\)/, "Chat restore without a session should hydrate its draft through the normal transition");
  assert.match(transcriptTrackRunBody, /if\s*\(!ignoreTranscript\)\s*applyTranscriptUiSideEffects\(sessionId,\s*event\)/, "the unified transcript entrypoint should own transcript UI side effects");
  assert.match(transcriptTrackRunBody, /if\s*\(!change\.accepted\)\s*return\s+false/, "the unified transcript entrypoint should honor reducer causality rejection");
  assert.match(agent, /FOLLOW_UP_RUN_HANDOFF_DELAY_MS\s*=\s*160/, "follow-up continuation should leave a small visual handoff after agent_end");
  const agentRunLoopSource = agent.match(/async\s+_runLoop\([\s\S]*?(?=\n\s+async\s+_canManageSessions\()/)?.[0] || "";
  assert.match(agentRunLoopSource, /awaitingFollowUp\s*\?\s*this\.followUpQueue\.drain\(\)\s*:\s*\[\][\s\S]*awaitingFollowUp\s*=\s*false/, "a follow-up is consumed only at its new run's initial handoff");
  assert.match(agent, /this\._emit\(\{\s*type:\s*"agent_end"[\s\S]*this\._scheduleNextFollowUpRun\(scheduleEpoch\)/, "follow-ups should be scheduled only after the current run ends");
  assert.match(agent, /steeringQueue\s*=\s*new MessageQueue\s*\("all"\)/, "steering should drain all pending guidance at one safe boundary");
  assert.match(agentRunLoopSource, /while\s*\(hasMoreToolCalls \|\| pendingMessages\.length > 0 \|\| this\.steeringQueue\.hasItems\(\)\)/, "the active loop should inspect steering only at turn boundaries");
  assert.match(agentRunLoopSource, /awaitingInitialHandoff[\s\S]*acceptedUserMessages\.length\s*>\s*0[\s\S]*break outer/, "an idle queued run should stop if its visible input is removed during preparation");
  const contextPrepareIndex = agentRunLoopSource.indexOf("_refreshDynamicContextSnapshot");
  const steeringDrainIndex = agentRunLoopSource.indexOf("this.steeringQueue.drain()");
  const acceptedPersistIndex = agentRunLoopSource.indexOf("await this._persistConversation()", steeringDrainIndex);
  const queueHandoffIndex = agentRunLoopSource.indexOf("this._emitQueueUpdate()", acceptedPersistIndex);
  const acceptedMessageIndex = agentRunLoopSource.indexOf('type: "message_start"', queueHandoffIndex);
  assert.ok(
    contextPrepareIndex >= 0
      && contextPrepareIndex < steeringDrainIndex
      && steeringDrainIndex < acceptedPersistIndex
      && acceptedPersistIndex < queueHandoffIndex
      && queueHandoffIndex < acceptedMessageIndex,
    "steering handoff should prepare, dequeue, persist, then move directly into the transcript",
  );
  assert.match(agent, /steerFollowUp\(clientMessageId[\s\S]*followUpQueue\.removeByClientMessageId[\s\S]*steeringQueue\.enqueue/, "promotion should move the original queued message without rebuilding attachments");
  assert.match(serviceWorker, /Promise\.all\(\[\s*sessionRuntimeReady,\s*dataConsent\.whenAccepted\s*\]\)\.then\(\(\)\s*=>\s*sessionRuntimeState\.queueFollowUpResume\("startup"\)\)/, "service worker startup should resume persisted follow-up queues after data consent is accepted");
  const resumePersistedFollowUpsBody = extractFunction(sessionRuntimeState, "resumeFollowUps");
  assert.match(resumePersistedFollowUpsBody, /normalizePendingFollowUps\(runtime\?\.pendingFollowUpMessages\)\.length\s*>\s*0/, "startup resume should scan persisted pending follow-up messages");
  assert.match(resumePersistedFollowUpsBody, /normalizePendingFollowUps\(runtime\?\.pendingSteeringMessages\)\.length\s*>\s*0/, "startup resume should also scan persisted steering messages");
  assert.match(resumePersistedFollowUpsBody, /const\s+entry\s*=\s*getAgentEntry\(sessionId\)/, "startup resume should instantiate the session agent so restorePendingFollowUps can schedule the next run");
  assert.match(resumePersistedFollowUpsBody, /await\s+entry\.ready/, "startup resume should wait for restored queues to be handed to the agent");
  const trackRunBody = extractFunction(sidepanel, "trackBackgroundRun");
  assert.match(trackRunBody, /previousQueueSignature\s*=\s*queuedFollowups\.itemsSignature\([\s\S]*pendingFollowUps,[\s\S]*pendingSteerings/, "runtime tracking should diff both visible queues before refreshing queue UI");
  assert.match(trackRunBody, /if\s*\(queueChanged\s*&&\s*options\.isCurrentSession\?\.\(sessionId\)\)\s*queuedFollowups\.render\(\)/, "queue UI should refresh only when the current session queue changes");
  assert.match(trackRunBody, /transcriptReconcile\.handleEvent\(sessionId,\s*event\)/, "ctx/runtime heartbeats should invoke the stale transcript watchdog");
  const morphSessionNodeBody = extractFunction(sidepanel, "morphSessionNode");
  assert.match(morphSessionNodeBody, /shouldPreserveSessionRenderSubtree\(current,\s*next\)/, "session list morphing should skip unchanged keyed subtrees");
  const preserveSessionTreeBody = extractFunction(sidepanel, "shouldPreserveSessionRenderSubtree");
  assert.match(preserveSessionTreeBody, /getAttribute\("data-render-signature"\)/, "session subtree preservation should be driven by an explicit render signature");
  assert.match(preserveSessionTreeBody, /sessionDomKey\(current\)[\s\S]*sessionDomKey\(next\)/, "session subtree preservation must require the same stable DOM key");
  const renderSessionTreeNodeBody = extractFunction(sidepanel, "renderSessionTreeNode");
  assert.match(renderSessionTreeNodeBody, /data-render-signature="\$\{signature\}"/, "session tree nodes should carry stable render signatures");
  const renderSessionTreeCardBody = extractFunction(sidepanel, "renderSessionTreeCard");
  assert.match(renderSessionTreeCardBody, /data-render-signature="\$\{cardSignature\}"/, "session cards should carry stable render signatures so sibling artifact chips are not patched during unrelated runtime ticks");
  const resourcesChangedBody = extractFunction(sidepanel, "handleSessionResourcesChanged");
  assert.match(resourcesChangedBody, /markSessionListArtifactSummaryRefreshing\(id\)/, "resource updates should keep the previous artifact pill visible while refreshing");
  assert.doesNotMatch(resourcesChangedBody, /sessionListArtifactHydrationStateBySessionId\.delete/, "resource updates must not clear the artifact summary before hydration finishes");
  const markArtifactRefreshingBody = extractFunction(sidepanel, "markSessionListArtifactSummaryRefreshing");
  assert.match(markArtifactRefreshingBody, /refreshing:\s*true/, "artifact hydration should expose a stale-while-refresh state");
  assert.match(markArtifactRefreshingBody, /summary:\s*previous\?\.summary \|\| null/, "artifact refresh should preserve the previous summary");
  const requestArtifactHydrationBody = extractFunction(sidepanel, "requestSessionArtifactHydration");
  assert.match(requestArtifactHydrationBody, /const\s+previous\s*=\s*sessionListArtifactHydrationStateBySessionId\.get\(id\)/, "artifact hydration refresh should compare against the previous summary");
  assert.match(requestArtifactHydrationBody, /Number\(previous\?\.total \|\| 0\)\s*!==\s*Number\(next\?\.total \|\| 0\)/, "artifact hydration should refresh the session list when artifacts are removed");
  assert.doesNotMatch(requestArtifactHydrationBody, /if\s*\(!summary\?\.total\)\s*return;/, "artifact hydration must not ignore a confirmed empty result after a stale summary");
  const getSessionListArtifactSummaryBody = extractFunction(sidepanel, "getSessionListArtifactSummary");
  assert.match(getSessionListArtifactSummaryBody, /const\s+stale\s*=\s*hydration\?\.summary \? getMergedSessionArtifactSummary/, "session list should show stale artifact summaries during hydration");
  assert.match(getSessionListArtifactSummaryBody, /return\s+stale\?\.total \? stale : null/, "session list should only hide the artifact pill when no stale or loaded summary exists");
  const staleWatchdogBody = extractFunction(transcriptReconcileFeature, "reconcileStaleStream");
  assert.match(staleWatchdogBody, /event\?\.type !== "context_usage"/, "watchdog should only run from context usage heartbeats");
  assert.match(staleWatchdogBody, /options\.isRuntimeRunning\?\.\(options\.getRuntime\?\.\(id\)\)/, "watchdog should only run for active sessions");
  assert.match(staleWatchdogBody, /schedule\(id,\s*\{\s*delay:\s*0,\s*force:\s*true\s*\}\)/, "stale transcript watchdog should force a snapshot from the runtime transcript cache");
  const scheduleReconcileBody = extractFunction(transcriptReconcileFeature, "schedule");
  assert.match(scheduleReconcileBody, /if\s*\(reconcileTimers\.has\(id\)\)\s*\{[\s\S]*if\s*\(!force\)\s*return\s+false;[\s\S]*clearTimeout\(reconcileTimers\.get\(id\)\)/, "forced reconcile should replace a pending low-priority snapshot timer");

  const sendBody = extractFunction(composerFeature, "sendComposerMessage");
  const compositionStart = composerFeature.slice(
    composerFeature.indexOf('input.addEventListener("compositionstart"'),
    composerFeature.indexOf('input.addEventListener("compositionend"'),
  );
  assert.match(
    compositionStart,
    /isComposingInput\s*=\s*true[\s\S]*cancelAnimationFrame\(compositionLayoutFrame\)/,
    "IME composition should cancel a stale committed resize before preedit text changes",
  );
  assert.doesNotMatch(
    compositionStart,
    /getBoundingClientRect|input\.style\.height/,
    "IME composition must not write a transformed visual height back into CSS layout coordinates",
  );
  assert.match(
    composerFeature,
    /input\.addEventListener\("compositionend"[\s\S]*requestAnimationFrame[\s\S]*autoResize\(\)/,
    "IME composition should commit one deferred resize after the candidate is accepted",
  );
  assert.match(
    composerFeature,
    /input\.addEventListener\("input", \(event\)[\s\S]*if \(isComposingInput \|\| event\.isComposing\)[\s\S]*requestAnimationFrame[\s\S]*autoResize\(true\)[\s\S]*if \(compositionLayoutFrame\) return;/,
    "preedit growth is deferred without collapsing the textarea; native IME browser tests verify viewport stability",
  );
  const composerAutoResizeBody = extractFunction(composerFeature, "autoResize");
  assert.match(composerAutoResizeBody, /preserveViewportDuringDockLayout\(\(\)\s*=>\s*\{[\s\S]*input\.scrollHeight/, "committed line growth should resize the composer inside the chat viewport transaction");
  assert.match(sendBody, /appendUserMessage\(text,\s*images,\s*clientMessageId,\s*documents\);\s*\n\s*lockForUserMessage\(\)/, "ordinary submission should append one pending bubble before awaiting admission");
  assert.doesNotMatch(sendBody, /type:\s*"follow_up"/, "composer must not choose the Background submission protocol from projected state");
  assert.doesNotMatch(composerFeature, /shouldQueueComposerMessage|shouldPresentAsQueuedMessage|getIsStreaming|getActiveRunSessionId/, "composer must not infer Background admission from projected runtime state");
  assert.match(sendBody, /return\s+submitPrompt\(\{/, "all ordinary composer messages should use the same submission command");
  const submitPromptBody = extractFunction(composerFeature, "submitPrompt");
  assert.match(submitPromptBody, /response\?\.disposition\s*===\s*"queued"[\s\S]*removePendingUserMessage/, "a queued admission should remove the temporary pending bubble after the queue event is projected");
  assert.doesNotMatch(submitPromptBody, /pendingFollowUps|pendingSteerings|setForSession/, "an admission acknowledgement must not overwrite the newer queue event projection");
  assert.match(sidepanelHtml, /id="queued-followups"/, "composer should render the session follow-up queue");
  assert.match(sidepanelHtml, /class="input-composer-frame(?:\s[^"]*)?"[\s\S]*id="queued-followups"[\s\S]*class="input-wrapper(?:\s[^"]*)?"/, "queued follow-ups and the composer should share one surface");
  const composerFrameClasses = sidepanelHtml.match(/class="input-composer-frame([^"]*)"/)?.[1].split(/\s+/) || [];
  for (const utility of ["qz:flex", "qz:flex-col", "qz:min-w-0"]) {
    assert.ok(composerFrameClasses.includes(utility), `the queue/composer surface requires ${utility}`);
  }
  assert.match(sidepanelCss, /\.input-composer-frame:has\(\.queued-followups:not\(\.hidden\)\)\s*\{[\s\S]*border:\s*1px solid/, "the shared queue/composer surface should own the quiet boundary");
  assert.match(sidepanelCss, /\.queued-followups\s*\{[\s\S]*border-bottom:\s*1px solid/, "the visible queue should remain visually attached to the composer");
  assert.match(sidepanel, /data-steer-follow-up=/, "each ordinary follow-up should expose a steering action");
  assert.match(sidepanel, /request\("steer_follow_up",\s*\{\s*sessionId,\s*clientMessageId\s*\}\)/, "steering should wait for a Background acknowledgement");
  assert.match(sidepanel, /\.\.\.normalizePendingSteerings\(steerings\)[\s\S]*queueKind:\s*"steering"[\s\S]*\.\.\.normalizePendingFollowUps\(followUps\)/, "steering and follow-ups should share one surface with steering rows first");
  const steeringRowCss = (sidepanelCss.match(/\.queued-followup\.is-steering\s*\{[\s\S]*?\n\}/) || [""])[0];
  assert.match(steeringRowCss, /background:[\s\S]*color:/, "steering rows should have a distinct neutral treatment");
  assert.doesNotMatch(steeringRowCss, /--accent|--green|--red/, "steering rows should stay inside the neutral ink palette");
  assert.doesNotMatch(sidepanel, /qz-icon-btn--danger queued-followup-delete/, "queued-message deletion should not use danger coloring");
  assert.match(sidepanelCss, /\.queued-followup-steer\s*\{[\s\S]*width:\s*50px/, "the steering action should keep a fixed width without hover expansion");
  assert.match(sidepanelCss, /\.queued-followup-copy\s*\{[\s\S]*overflow:\s*hidden[\s\S]*white-space:\s*nowrap/, "long queued messages should truncate without moving their metadata");
  assert.match(sidepanelTransport, /steer_follow_up:\s*\{\s*method:\s*"sessions\.steerFollowUp",\s*response:\s*"follow_up_steered"[\s\S]*requestOnly:\s*true/, "Side Panel steering should use a request/ack transport route");
  assert.doesNotMatch(renderStatusVisibilityBody, /renderQueuedFollowups\(/, "status visibility must not rerender the queued follow-up DOM during live typing");
  assert.match(sidepanel, /function\s+renderChatDockState\(\)[\s\S]*renderQueuedFollowups\(\);[\s\S]*renderStatusVisibility\(\);/, "chat dock surfaces should have an explicit render entrypoint");
  const renderQueuedBody = extractFunction(sidepanel, "renderQueuedFollowups");
  assert.match(renderQueuedBody, /queuedFollowupRenderSignature\(sessionId,\s*items\)/, "queued follow-up rendering should be keyed by a stable data signature");
  assert.match(renderQueuedBody, /queuedFollowupRenderedSignature\s*===\s*nextSignature[\s\S]*return;/, "unchanged queued follow-ups should not rebuild DOM or rerun hover/FLIP state");
  assert.match(sidepanel, /let\s+queuedFollowupRenderedSignature\s*=\s*""/, "queued follow-up render signature should persist between unrelated transcript updates");
  assert.match(sidepanel, /queuedFollowupKnownItemsById\s*=\s*new Map\(\)/, "queued follow-up animation should track rows by stable message id");
  assert.match(sidepanel, /function\s+captureQueuedFollowupSnapshots/, "queued follow-up removal should snapshot row geometry before rerender");
  assert.match(sidepanel, /function\s+spawnQueuedFollowupExitGhost/, "queued follow-up removal should animate a fixed ghost outside normal layout");
  assert.match(sidepanel, /function\s+spawnQueuedFollowupBatchExitGhost/, "a steering batch should share one exit ghost container");
  assert.match(sidepanel, /removed\.length\s*>\s*1[\s\S]*entry\.item\?\.queueKind\s*===\s*"steering"[\s\S]*spawnQueuedFollowupBatchExitGhost\(removed\)[\s\S]*return\s+1/, "multiple steering removals should produce one queue animation capsule");
  assert.match(sidepanel, /function\s+rememberQueuedFollowupOutgoingBatch/, "steering batch identity should survive the queue-to-transcript handoff");
  assert.match(sidepanel, /function\s+animateQueuedFollowupRowsFrom/, "queued follow-up remaining rows should glide with FLIP instead of jumping");
  assert.match(sidepanel, /function\s+queuedFollowupTopDrainInfo/, "queued follow-up FIFO consumption should be detected separately from reorder/delete");
  assert.match(sidepanel, /queuedFollowupLocalMutationReason\s*=\s*String\(reason \|\| ""\)/, "local queue edits should not be mistaken for runtime FIFO dequeue");
  assert.match(sidepanel, /const\s+isTopDrain\s*=\s*drainInfo\.isTopDrain\s*&&\s*!localMutationReason/, "only runtime-driven FIFO dequeue should use the top-send animation");
  assert.match(sidepanel, /function\s+startQueuedFollowupTopDrain/, "FIFO top drain should animate the existing top row before committing queue layout changes");
  assert.match(sidepanel, /row\.classList\.add\("is-sending"\)/, "FIFO top drain should move only the consumed top row");
  assert.match(sidepanel, /if\s*\(isTopDrain\s*&&\s*startQueuedFollowupTopDrain\(items,\s*drainInfo\.removedId\)\)\s*return/, "FIFO top drain should not rerender the queue until the send-out animation finishes");
  assert.doesNotMatch(`${sidepanel}\n${sidepanelCss}`, /queuedFollowupTopDrainSlot|queued-followup-top-slot/, "FIFO top drain should not leave a visible top placeholder");
  assert.match(sidepanel, /if\s*\(!isTopDrain\s*&&\s*!queuedFollowupSuppressNextMove\)\s*animateQueuedFollowupRowsFrom\(snapshots\)/, "FIFO top drain should only fly out the consumed row, not animate the whole queue");
  assert.match(sidepanel, /function\s+queuedFollowupDomId/, "queued follow-up rows should have stable DOM ids");
  assert.match(sidepanel, /container\.classList\.add\("is-draining"\)/, "empty queue should reserve its old surface briefly while the ghost flies out");
  assert.match(sidepanel, /container\.classList\.add\("is-reserving"\)/, "non-empty queue removals should briefly reserve old height while rows glide");
  assert.match(sidepanelCss, /@keyframes queued-followup-enter/, "queued follow-up rows should have a restrained enter animation");
  assert.match(sidepanelCss, /@keyframes queued-followup-send-out/, "FIFO top drain should have a dedicated send-out animation");
  assert.match(sidepanelCss, /\.queued-followup\.is-sending\s*\{[\s\S]*pointer-events:\s*none[\s\S]*animation:\s*queued-followup-send-out/, "FIFO top drain should animate only the in-flow top row");
  assert.match(sidepanelCss, /@keyframes queued-followup-ghost-out/, "queued follow-up exit should use a composited ghost animation");
  assert.doesNotMatch(
    (sidepanelCss.match(/@keyframes queued-followup-send-out\s*\{[\s\S]*?\n\}/) || [""])[0],
    /transform:/,
    "FIFO send-out should not drift sideways",
  );
  assert.doesNotMatch(
    (sidepanelCss.match(/@keyframes queued-followup-send-out\s*\{[\s\S]*?\n\}/) || [""])[0],
    /scale\(|translate/,
    "FIFO send-out should use a quiet opacity-only exit",
  );
  assert.match(sidepanelCss, /\.queued-followup-exit-ghost,[\s\S]*\.queued-followup-batch-exit-ghost\s*\{[\s\S]*position:\s*fixed[\s\S]*will-change:\s*opacity[\s\S]*animation:\s*queued-followup-ghost-out/, "single and batched queue exits should be fixed opacity-only ghosts");
  assert.match(sidepanelCss, /\.queued-followups\.is-draining\s*\{[\s\S]*min-height:\s*var\(--queued-followups-drain-height/, "empty queue should hold its old height during ghost exit");
  assert.match(sidepanelCss, /\.queued-followups\.is-reserving\s*\{[\s\S]*min-height:\s*var\(--queued-followups-drain-height/, "non-empty queue should reserve old height during ghost exit");
  assert.doesNotMatch(
    (sidepanelCss.match(/@keyframes queued-followup-ghost-out\s*\{[\s\S]*?\n\}/) || [""])[0],
    /max-height/,
    "queued follow-up ghost exit should not animate height because it causes composer jitter",
  );
  assert.doesNotMatch(sidepanelCss, /\.queued-followup\.is-exiting/, "queued follow-up exit should not keep a fake row in normal layout");
  assert.doesNotMatch(sidepanel, /function\s+markUserMessageEntering/, "sent user bubbles should not use queue-like enter markers");
  assert.match(sidepanel, /function\s+settleQueuedFollowupForAcceptedUserMessage/, "accepted queued user messages should settle any stale queue row immediately");
  const settleQueuedBody = extractFunction(sidepanel, "settleQueuedFollowupForAcceptedUserMessage");
  assert.match(settleQueuedBody, /queuedFollowupSeenIds\.has\(id\)/, "queued identity should survive longer than the queue row drain animation");
  assert.match(settleQueuedBody, /queuedFollowupSeenIds\.delete\(id\)/, "accepted queued identity should be consumed so duplicate events cannot replay motion");
  assert.match(settleQueuedBody, /clearTimeout\(queuedFollowupDrainTimer\)/, "settling an accepted follow-up should cancel any pending queue drain timer");
  assert.match(settleQueuedBody, /queuedFollowupTopDrainState\s*=\s*null/, "settling an accepted follow-up should clear top-drain animation state");
  assert.match(settleQueuedBody, /rememberQueuedFollowupItems\(queuedItems\(nextFollowUps,\s*nextSteerings\)\)[\s\S]*renderQueuedFollowups\(\)/, "settling an accepted queued message should rerender from both remaining queues");
  const transcriptUiEffectsBody = extractFunction(sidepanel, "applyTranscriptUiSideEffects");
  assert.match(transcriptUiEffectsBody, /const\s+clientMessageId\s*=\s*event\.clientMessageId \|\| record\(event\.message\)\.clientMessageId/, "transcript UI effects should use the accepted message id");
  assert.match(transcriptUiEffectsBody, /const\s+settled\s*=\s*queuedFollowups\.settleAccepted\(clientMessageId\)[\s\S]*ensureAcceptedUserMessageVisible\?\.\(\)[\s\S]*transcriptRenderer\.armOutgoingEntry\?\.\(sessionId,\s*clientMessageId,\s*settled\.outgoingBatch\)/, "a drained follow-up should carry its batch handoff into the outgoing animation before transcript render");
  assert.match(workspaceComposition, /ensureAcceptedUserMessageVisible:\s*chat\.scroll\.lockForSubmittedAction/, "accepted queued messages should use the same tail lock as direct composer sends");
  assert.match(sidepanel, /armOutgoingEntry:\s*armOutgoingUserMessageEntry/, "composer should expose its existing outgoing animation token registry");
  assert.match(sidepanel, /armOutgoingEntry:\s*composer\.armOutgoingEntry/, "transcript renderer should expose outgoing animation arming to the event router");
  assert.match(sidepanelCss, /\.msg-user\.msg-user-outgoing-enter\.msg-user-steering-batch-enter \.msg-content\s*\{[\s\S]*steering-batch-message-enter 180ms[\s\S]*28ms/, "batched steering messages should enter as separate ordered bubbles with one restrained motion language");
  assert.match(sidepanelCss, /\.msg-user\s*\{[\s\S]*animation:\s*none/, "direct user bubbles should land in the transcript without queue-like entrance motion");
  assert.match(sidepanel, /el\.addEventListener\("transitionend",\s*remove,\s*\{\s*once:\s*true,\s*signal:\s*lifetime\s*\}\)/, "artifact cards should remove after the retreat transition finishes, scoped to the capability lifetime");
  assert.match(sidepanelCss, /\.msg-artifacts\.msg-artifacts-exiting\s*\{[\s\S]*max-height:\s*0[\s\S]*opacity:\s*0/, "artifact cards should collapse smoothly when hidden for a new turn");
  assert.match(sidepanel, /id="\$\{escapeHtml\(domId\)\}"/, "queued follow-up rows should keep stable DOM ids without making the whole row draggable");
  assert.match(sidepanel, /class="queued-followup-drag"\s+draggable="\$\{!item\.submitting\}"/, "queued follow-ups should enable their drag handle only after admission");
  assert.match(sidepanel, /function\s+queuedFollowupDropPositionForEvent/, "queued follow-up drag should calculate before/after insertion points");
  assert.match(sidepanel, /setDragImage\?\.\(row/, "queued follow-up drag should use the row as a stable drag image");
  assert.match(sidepanel, /const\s+rect\s*=\s*row\.getBoundingClientRect\(\)[\s\S]*event\.clientX\s*-\s*rect\.left[\s\S]*event\.clientY\s*-\s*rect\.top[\s\S]*setDragImage\?\.\(row,\s*offsetX,\s*offsetY\)/, "queued follow-up drag image should stay under the cursor");
  assert.match(sidepanelCss, /\.queued-followup::before,[\s\S]*\.queued-followup::after/, "queued follow-up drop targets should use insertion indicators");
  assert.match(sidepanelCss, /\.queued-followup::before,[\s\S]*height:\s*1px[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--border\)/, "queued follow-up insertion indicators should stay muted");
  assert.match(sidepanelCss, /\.queued-followup::before,[\s\S]*transition:\s*none/, "queued follow-up insertion indicators should not animate");
  assert.match(sidepanelCss, /\.queued-followup\.is-drop-before::before,[\s\S]*\.queued-followup\.is-drop-after::after/, "queued follow-up insertion indicators should use the same static line for before and after");
  assert.doesNotMatch(`${sidepanel}\n${sidepanelCss}`, /is-drag-over/, "queued follow-up dragging should not use coarse row background highlighting");
  assert.match(sidepanel, /function\s+trackBackgroundRun[\s\S]*sessionState\.applyEvent\(\{\s*\.\.\.event,\s*sessionId\s*\},\s*\{\s*transcript:\s*!ignoreTranscript\s*\}\)/, "queued follow-up user bubbles should enter transcript through the unified runtime reducer");
  assert.match(sidepanelTransport, /delete_follow_up:\s*\{\s*method:\s*"sessions.deleteFollowUp"/, "sidepanel transport should route queued follow-up deletion");
  assert.match(sidepanelTransport, /reorder_follow_ups:\s*\{\s*method:\s*"sessions.reorderFollowUps"/, "sidepanel transport should route queued follow-up reordering");
  assert.match(runtimeReducer, /pendingFollowUpMessages:\s*cloneArray\(event\.pendingFollowUpMessages\)/, "runtime reducer should persist queued follow-up messages");
  assert.match(agent, /_emitQueueUpdate\([^)]*\)[\s\S]*pendingFollowUps:[\s\S]*pendingFollowUpMessages:/, "agent should expose both UI summaries and restorable queued messages");
  assert.match(agent, /followUp\(text\s*,[\s\S]*this\._emitQueueUpdate\([^)]*\);[\s\S]*this\._scheduleNextFollowUpRun\(scheduleEpoch\)/, "idle follow-ups should schedule background consumption under their admission epoch");
  assert.match(agent, /restorePendingFollowUps\(messages[\s\S]*this\._emitQueueUpdate\(\);[\s\S]*this\._scheduleNextFollowUpRun\(\)/, "restored follow-ups should resume background consumption");

  const cancelBody = extractFunction(sidepanel, "cancelUserMessageEdit");
  assert.match(cancelBody, /\.blur\?\.\(\)/, "cancel should blur textarea before rerender");
  assert.match(cancelBody, /settleUserMessageActionsAfterEdit\(el\)/, "cancel should suppress edit actions while the bubble contracts");
  assert.match(cancelBody, /classList\.remove\("is-editing",\s*"is-resending"\)/, "cancel should leave edit/resend state");
  assert.match(cancelBody, /restoreUserMessageElement\(el,\s*entry\)/, "cancel should restore only the edited user bubble");
  assert.doesNotMatch(cancelBody, /renderCurrentTranscript|renderChatTranscript|reconcileChatTranscriptDom/, "cancel should not repaint the full chat transcript");
  const settleActionsBody = extractFunction(sidepanel, "settleUserMessageActionsAfterEdit");
  assert.match(settleActionsBody, /classList\.add\("is-settling-edit"\)[\s\S]*requestAnimationFrame\([\s\S]*classList\.remove\("is-settling-edit"\)/, "edit actions should resume after the contracted layout has completed hit testing");
  assert.match(sidepanelCss, /\.msg-user\.is-editable\.is-settling-edit \.msg-user-actions\s*\{[\s\S]*opacity:\s*0[\s\S]*transition:\s*none/, "settling edit actions should never flash or fade from a stale hover state");
  const restoreBody = extractFunction(sidepanel, "restoreUserMessageElement");
  assert.match(restoreBody, /patchUserTranscriptElement\(el,\s*entry/, "cancel restore should reuse the user-message patch path");
  assert.doesNotMatch(restoreBody, /renderCurrentTranscript|renderChatTranscript|reconcileChatTranscriptDom/, "cancel restore should stay local to one message element");

  const canEditBody = extractFunction(sidepanel, "canEditUserTranscriptEntry");
  assert.match(canEditBody, /normalizeClientMessageIdValue\(entry\.clientMessageId\)[\s\S]*return\s+true/, "any user bubble with a stable client message id should be editable while idle");
  assert.match(canEditBody, /index\s*!==\s*lastUserIndex[\s\S]*return\s+false/, "legacy user bubbles without ids should only keep the safe latest-message fallback");
  assert.ok(
    canEditBody.indexOf("normalizeClientMessageIdValue(entry.clientMessageId)") < canEditBody.indexOf("index !== lastUserIndex"),
    "stable ids should bypass the latest-user fallback check",
  );

  const startEditBody = extractFunction(sidepanel, "startUserMessageEdit");
  assert.match(startEditBody, /canEditUserMessageElement\(el,\s*entry\)/, "starting edit should validate the selected bubble, not only the latest user entry");
  assert.match(startEditBody, /scroll\.preserveViewportDuringContentLayout/, "opening an edit shell should reuse the shared content-layout anchoring transaction");
  const editInputBody = extractFunction(sidepanel, "handleUserMessageEditInput");
  assert.match(editInputBody, /scroll\.preserveViewportDuringContentLayout/, "textarea remeasurement should reuse the shared content-layout anchoring transaction");
  assert.match(cancelBody, /scroll\.preserveViewportDuringContentLayout/, "canceling an edit should preserve the current conversation viewport");
  const interactionAnchorBody = extractFunction(sidepanel, "resolveInteractionViewportAnchor");
  assert.match(interactionAnchorBody, /\.msg-user \[data-action='edit-user-message'\]/, "entering message edit should acquire the generic interaction viewport anchor");
  assert.match(interactionAnchorBody, /\.msg-user \.msg-user-edit-shell/, "controls inside the edit shell should keep using the same message anchor");

  const stopBody = extractFunction(sidepanel, "stopCurrentRun");
  assert.match(stopBody, /markCurrentSessionAbortRequested\(sessionId\)/, "stop should optimistically mark the current session aborted before waiting for the service worker");
  const markAbortBody = extractFunction(sidepanel, "markCurrentSessionAbortRequested");
  assert.match(markAbortBody, /status:\s*"aborted"[\s\S]*running:\s*false/, "local abort request should make the cached runtime terminal immediately");
  assert.match(markAbortBody, /trackBackgroundRun\(\{[\s\S]*type:\s*"state"[\s\S]*status:\s*"aborted"/, "local abort request should flow through the same runtime state pipeline");
  assert.match(markAbortBody, /blockedRunIds\.add\(runId\)/, "local abort request should keep stale stream events from reactivating the stopped run");

  const submitBody = extractFunction(sidepanel, "submitUserMessageEdit");
  assert.match(submitBody, /textarea\.blur\(\)/, "submit should blur textarea before local repaint");
  assert.match(submitBody, /applyLocalEditedUserMessage\(getSessionId\(\)/, "submit should optimistically replace the local transcript");
  assert.match(submitBody, /scroll\.lockForSubmittedAction\(\);[\s\S]*applyLocalEditedUserMessage\(getSessionId\(\)/, "edited resend should establish live-tail intent before repainting the truncated transcript");
  assert.match(submitBody, /type:\s*"resend_prompt"/, "submit should call the runtime resend path");
  assert.match(submitBody, /images:\s*images\.map/, "submit should carry edited message images for fallback resend");

  assert.match(sidepanelTransport, /case\s+"resend_prompt":[\s\S]*call\("sessions.resend",\s*\{\s*\.\.\.message,\s*sourceWindowId:/, "sidepanel transport should expose resend_prompt with its Side Panel window through the Background API");
  assert.match(sessionCommands, /function resendSessionMessageRuntime[\s\S]*editUserMessageAndRerun[\s\S]*images:\s*params\.images\s*\|\|\s*\[\]/, "runtime resend should pass images to the agent");
  assert.match(sessionCommands, /type:\s*"transcript_replace"/, "runtime should broadcast canonical transcript replacement after edit");
  assert.match(sidepanel, /import\s*\{[^}]*\bmergeTranscriptSnapshotWithLocalState\b[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/shared\/session\/session-codec\.js"/, "transcript renderer should import shared snapshot reconciliation from the transcript codec");
  assert.match(sessionCodec, /export\s+function\s+mergeTranscriptSnapshotWithLocalState/, "shared transcript codec should own snapshot reconciliation");
  assert.match(sessionCodec, /function\s+isProtectedLocalTool/, "shared transcript codec should explicitly protect local live tool evidence from snapshots");
  assert.doesNotMatch(sidepanel, /function\s+mergeSnapshotWithLocalTranscriptState/, "sidepanel should not keep a second snapshot reconciliation entrypoint");
  assert.doesNotMatch(sidepanel, /function\s+isProtectedLocalLiveTranscript/, "sidepanel should not keep a second private live-tool reconciliation policy");
  const seedTranscriptBody = extractFunction(sidepanel, "seedSessionTranscriptFromStorage");
  assert.match(seedTranscriptBody, /hasSessionTranscript\(id\)[\s\S]*return\s+false/, "stored transcripts should only seed an uninitialized in-memory view");
  const applyRuntimeSnapshotBody = extractFunction(sidepanel, "applyRuntimeTranscriptSnapshot");
  assert.match(applyRuntimeSnapshotBody, /preserveLocalState[\s\S]*mergeTranscriptSnapshotWithLocalState\(existing,\s*snapshot\)/, "canonical snapshots should preserve only shared optimistic evidence");
  assert.match(applyRuntimeSnapshotBody, /preserveLocalState[\s\S]*transcriptCompletenessScore\(next\)\s*<=\s*transcriptCompletenessScore\(existing\)/, "ordinary runtime snapshots should not replace a more complete live transcript");
  const transcriptCompletenessScoreBody = extractFunction(sidepanel, "transcriptCompletenessScore");
  assert.match(transcriptCompletenessScoreBody, /item\.type\s*===\s*"tool"\s*\?\s*8/, "tool evidence should retain the strongest transcript completeness weight");
  const replaceRuntimeBody = extractFunction(sidepanel, "replaceTranscriptFromRuntime");
  assert.match(replaceRuntimeBody, /transcriptRenderer\.applyRuntimeSnapshot\(id,\s*transcriptSnapshot,\s*\{\s*preserveLocalState:\s*false,?\s*\}\)/, "explicit transcript replacement should be strict");
  assert.match(replaceRuntimeBody, /options\.onUiEvent\?\.\(\{\s*type:\s*"ui_transcript_replaced",\s*sessionId:\s*id\s*\}\)/, "explicit transcript replacement should notify capabilities with its session identity");
  assert.match(sessionUi, /event\.type === "ui_transcript_replaced"\) artifacts\.releaseCardSuppression\(id\)/, "the session capability should release optimistic artifact suppression on explicit transcript replacement");
  assert.match(replaceRuntimeBody, /if\s*\(changed\s*&&\s*isCurrentSession\(id\)\)[\s\S]*transcriptRenderer\.render\(id,\s*\{\s*force:\s*true\s*\}\)/, "a changed strict replacement should repaint only the current session");
  const applySnapshotBody = extractFunction(sidepanel, "applyConversationSnapshot");
  assert.doesNotMatch(applySnapshotBody, /await\s|getSessions\(/, "canonical snapshots should commit synchronously in port delivery order");
  assert.match(applySnapshotBody, /options\.isDeletedSession\?\.\(id\)/, "deleted sessions should reject late canonical snapshots without an asynchronous lookup");
  assert.doesNotMatch(applySnapshotBody, /transcript,\s*\n\s*\}/, "sidepanel should not send view transcript back as the persisted authority");
  assert.match(applySnapshotBody, /type:\s*"save_session_record"[\s\S]*session:\s*conversation/, "sidepanel should ask runtime to persist from its canonical transcript cache");
  assert.match(agent, /findEditableUserMessageIndex\(this\.messages,\s*normalizedClientMessageId\)/, "agent should identify the edited user message with the shared helper");
  assert.match(agent, /_buildContextCapsuleMessage\(dynamicContext,\s*"prompt_edit"\)/, "agent should refresh the hidden context capsule before edit resend");
  assert.match(agent, /this\._isHiddenContextMessage\(prefix\[prefix\.length - 1\]\)/, "agent should replace the previous hidden context capsule together with the edited user message");
  assert.match(agent, /this\.messages\s*=\s*\[[\s\S]*\.\.\.prefix[\s\S]*contextCapsule[\s\S]*replacement[\s\S]*\]/, "agent should truncate history to the edited request plus its refreshed capsule");
  assert.match(agent, /_findPendingUserMessage\(normalizedClientMessageId\)/, "agent should recover queued follow-up messages when edit target is not in history");
  assert.match(agent, /this\.messages\.push\(replacement\)/, "agent should fall back to sending a new message when the edit target cannot be found");
}

function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  const start = match?.index ?? -1;
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
