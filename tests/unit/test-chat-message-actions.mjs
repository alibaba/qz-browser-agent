import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sidepanelHtml = readFileSync(join(root, "src/sidepanel/sidepanel.html"), "utf8");
const sidepanelCss = readStylesheetSource(join(root, "src/sidepanel/sidepanel.css"));
const agent = readFileSync(join(root, "src/background/agent/agent.ts"), "utf8");
const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
const messageActions = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/message-actions.ts"), "utf8"), { mode: "transform" });
const transcriptProjection = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/projection.ts"), "utf8"), { mode: "transform" });
const markdownFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/markdown-feature.ts"), "utf8"));
const sessionExportFeature = readFileSync(join(root, "src/sidepanel/features/export/session-export-feature.ts"), "utf8");
const sessionsFeature = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/sessions/sessions-feature.ts"), "utf8"), { mode: "transform" });
const eventRouter = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/sidepanel-event-router.ts"), "utf8"), { mode: "transform" });
const sessionNavigation = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/sessions/session-navigation-feature.ts"), "utf8"), { mode: "transform" });
const sidepanelTransport = stripTypeScriptTypes(readFileSync(join(root, "src/background/transports/sidepanel.ts"), "utf8"), { mode: "transform" });
const sidepanel = [
  transcriptRenderer,
  transcriptProjection,
  markdownFeature,
  sessionExportFeature,
  sessionsFeature,
  eventRouter,
].join("\n");

assertAssistantDownloadContracts();
assertSessionTitleEditingContracts();
assertChatErrorRenderingContracts();
assertLlmRetryStatusContracts();

function assertAssistantDownloadContracts() {
  const syncActionsBody = extractFunction(messageActions, "syncAssistantMessageActions");
  assert.match(syncActionsBody, /data-action="download-markdown"[\s\S]*title="\$\{tHtml\("downloadMessage"\)\}"/, "assistant actions should expose a direct current-message download");
  assert.match(syncActionsBody, /<rect x="2\.5" y="5" width="19" height="14" rx="2"\/>[\s\S]*M6 15V9l3 3 3-3v6M17 9v6/, "message download should use the Markdown mark");
  assert.match(syncActionsBody, /downloadAssistantMarkdown\(markdown, btn, isCurrent\)/, "current message download should use the markdown downloader");
  assert.doesNotMatch(syncActionsBody, /toggle-download-menu|data-download-choice|session-html/, "assistant actions should no longer own session export");

  const exportBody = extractFunction(sessionExportFeature, "exportCurrentSession");
  assert.match(exportBody, /normalizeSessionId\(getCurrentSessionId\(\)\)/, "title action should export the active session");
  assert.match(exportBody, /exportSessionHtml\(sessionId\)/, "title action should reuse session-list HTML export");

  const sessionExportBody = extractFunction(sessionExportFeature, "exportSessionHtml");
  assert.match(sessionExportBody, /preparingSessionExportIds\.has\(sessionId\)/, "session export should reject duplicate preparation for the same session");
  assert.match(sessionExportBody, /setSessionExportPreparing\(sessionId, true\)/, "session export should enter a preparing state before building HTML");
  assert.match(sessionExportBody, /await waitForSessionExportIndicatorPaint\(\)[\s\S]*createSessionExportDocument\(sessionId\)/, "session export should paint the spinner before preparing the document");
  assert.match(sessionExportBody, /setSessionExportPreparing\(sessionId, false\)[\s\S]*downloadSessionExportDocument/, "the save dialog should open only after preparation finishes");

  const exportHtmlBody = extractFunction(sessionExportFeature, "buildSessionExportHtml");
  assert.match(exportHtmlBody, /width:\s*min\(var\(--lane-detail-width\),\s*calc\(100vw - 48px\)\)/, "export HTML should use the same detail lane width as expanded cards");
  assert.match(exportHtmlBody, /align-items:\s*flex-start;/, "export transcript should keep cards aligned like the live panel");
  assert.match(exportHtmlBody, /\.tool-event-raw-btn,[\s\S]*\.tool-event-collapse-btn\s*\{\s*display:\s*none !important;\s*\}/, "export HTML should hide single-tool card controls just like timeline-only controls");

  const staticToolGroupBody = extractFunction(sessionExportFeature, "createStaticToolTimelineGroup");
  assert.match(staticToolGroupBody, /template\.dataset\.staticToolFamilyId/, "static export should preserve each tool template's family id");
  assert.match(staticToolGroupBody, /template\.dataset\.staticToolFamilyNavHtml/, "static export should preserve per-tool family pager HTML");
  assert.match(staticToolGroupBody, /element\.dataset\.staticExpandedLane = expandedLane[\s\S]*element\.dataset\.chatLane = "summary"/, "collapsed exported tool groups should use summary lane width");

  const staticToolBody = extractFunction(sessionExportFeature, "createStaticTranscriptElement");
  assert.match(staticToolBody, /toolEventLaneMode\(entry,\s*true\)/, "static single-tool cards should remember their expanded semantic lane");
  assert.match(staticToolBody, /element\.dataset\.chatLane = "summary"/, "static single-tool cards should start in the summary lane");

  const staticScriptBody = readFileSync(join(root, "src/sidepanel/features/export/session-export-runtime.ts"), "utf8");
  assert.match(staticScriptBody, /function syncStaticChatLane/, "static export interactions should keep semantic card lanes in sync");
  assert.match(staticScriptBody, /function resolveStaticToolNavTarget/, "static export should resolve timeline pager targets locally");
  assert.match(staticScriptBody, /resolveFamilyTimelineTarget\(staticToolTemplates\(root\)\.map/, "static and live family pagers should share traversal over their stable family IDs");
  assert.match(staticScriptBody, /staticTimelineIndexListIncludes\(item\.dataset\.toolTimelineIndexes \|\| item\.dataset\.toolTimelineIndex,\s*index\)/, "static export should keep merged family batches active while paging within them");
  assert.match(staticScriptBody, /navTool\?\.closest<HTMLElement>\("\.tool-timeline-slot-nav"\)\?\.dataset\.timelineMode/, "static export should respect the clicked pager's timeline mode");

  const preparingBody = extractFunction(sessionExportFeature, "syncSessionExportControl");
  assert.match(preparingBody, /classList\.toggle\("is-preparing", preparing\)/, "export controls should expose the preparing visual state");
  assert.match(preparingBody, /button\.disabled = preparing/, "preparing export controls should prevent duplicate clicks");
  assert.match(preparingBody, /setAttribute\("aria-busy", "true"\)[\s\S]*removeAttribute\("aria-busy"\)/, "preparing export controls should expose accessible busy state");

  assert.match(sidepanelHtml, /id="btn-export-session"[\s\S]*title="导出对话 HTML"[\s\S]*M14\.5 2H6/, "title row should expose FileDown session export");
  assert.match(sessionExportFeature, /currentButton\?\.addEventListener\("click",\s*onCurrentButtonClick\)/, "title FileDown should trigger session export through the export feature");
  assert.match(sessionsFeature, /session-export-btn[\s\S]*M14\.5 2H6[\s\S]*M12 12v6/, "session list export should use the same FileDown icon");
  assert.match(sessionsFeature, /session-artifact-action-btn[\s\S]*<rect x="3" y="4" width="18" height="4" rx="1"\/>[\s\S]*M10 12h4/, "session artifacts should use an Archive icon");
  assert.match(sidepanelCss, /\.session-title-export-btn\s*\{[\s\S]*width:\s*24px;[\s\S]*background:\s*transparent;/, "title export should remain a quiet fixed-size icon action");
  assert.match(sidepanelCss, /\.session-title-export-btn::after,[\s\S]*top:\s*50%;[\s\S]*left:\s*50%;[\s\S]*\.session-title-export-btn\.is-preparing::after,[\s\S]*animation:\s*session-export-spin 780ms linear infinite/, "session export should use a centered restrained inline spinner");
  assert.match(sidepanelCss, /@keyframes session-export-spin/, "session export spinner should define a dedicated rotation");
  assert.doesNotMatch(sidepanel, /msg-download-menu|toggleAssistantDownloadMenu|handleAssistantDownloadMenu/, "obsolete assistant download menu code should be removed");
  assert.doesNotMatch(sidepanelCss, /\.msg-download-menu/, "obsolete assistant download menu styles should be removed");
}

function assertSessionTitleEditingContracts() {
  const editIcon = /<path d="m15\.2 5\.2 3\.6 3\.6"\/><path d="M4 20l4\.2-1 11-11a2\.55 2\.55 0 0 0-3\.6-3\.6l-11 11Z"\/>/u;
  assert.match(transcriptRenderer, editIcon, "message editing should keep the shared pencil glyph");
  const titleTriggerMarkup = sidepanelHtml.match(/<button id="btn-edit-session-title"[\s\S]*?<\/button>/u)?.[0] || "";
  assert.ok(titleTriggerMarkup, "the title row should expose a rename trigger");
  assert.doesNotMatch(titleTriggerMarkup, /<svg\b/u, "the title itself should be the rename affordance without a redundant edit icon");
  assert.match(sidepanelHtml, /id="btn-edit-session-title"[\s\S]*aria-label="重命名对话"[\s\S]*id="session-title-input"/, "the title row should expose one inline rename control");
  assert.match(sessionNavigation, /request\("rename_session",\s*\{[\s\S]*sessionId,[\s\S]*title:/, "title edits should use the explicit-session Background command");
  assert.match(sessionNavigation, /event\.isComposing \|\| event\.keyCode === 229/, "IME confirmation must not accidentally submit a title");
  assert.match(sessionNavigation, /event\.key === "Enter"[\s\S]*commitSessionTitleEdit[\s\S]*event\.key === "Escape"[\s\S]*closeSessionTitleEditor/, "the inline editor should support conventional save and cancel keys");
  assert.match(sidepanelTransport, /rename_session:\s*\{[\s\S]*method:\s*"sessions.rename"[\s\S]*response:\s*"rename_session_result"/, "Side Panel title edits should route through the Background API");
  const titleEditorClasses = sidepanelHtml.match(/class="session-title-editor([^"]*)"/)?.[1].split(/\s+/) || [];
  assert.ok(titleEditorClasses.includes("qz:h-6"), "the title row retains its 24px height through the 4px utility scale");
  assert.match(sidepanelCss, /\.session-title-input\s*\{[^}]*height:\s*24px;/, "the edit input should preserve the title row height");
  assert.match(sidepanelCss, /\.session-title-edit-trigger\s*\{[\s\S]*width:\s*fit-content;[\s\S]*max-width:\s*calc\(100% \+ 3px\);/, "the rename hit target should hug the visible title instead of filling the row");
}

function assertChatErrorRenderingContracts() {
  const stopReasonStart = agent.indexOf('if (_stopReason === "error" || _stopReason === "aborted")');
  assert.notEqual(stopReasonStart, -1, "agent should keep a stopReason terminal block");
  const stopReasonBlock = agent.slice(stopReasonStart, stopReasonStart + 420);
  assert.doesNotMatch(
    stopReasonBlock,
    /type:\s*"error"/,
    "assistant failure messages should not also emit a duplicate error transcript event",
  );

  assert.match(sidepanel, /function renderAssistantContentHtml/, "assistant messages should route through a shared content renderer");
  assert.match(sidepanel, /function renderChatErrorCardHtml/, "chat failures should have a dedicated card renderer");
  assert.match(sidepanel, /function dedupeDuplicateAssistantFailureErrors/, "legacy duplicate assistant/error failures should be hidden in transcript UI");
  const errorCardRule = sidepanelCss.match(/\.chat-error-card\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(errorCardRule, "chat error card should have a CSS rule");
  assert.match(errorCardRule, /color:\s*var\(--text-secondary\)/, "chat error card should use quiet text color");
  assert.doesNotMatch(errorCardRule, /border-left|inset\s+\d+px\s+0\s+0/, "chat error card should not use a left stripe");
  assert.doesNotMatch(sidepanelCss, /\.chat-error-card::before/, "chat error card should not draw a pseudo-element stripe");
  assert.doesNotMatch(
    errorCardRule,
    /color:\s*var\(--red\)/,
    "chat error card should not render the whole message in red",
  );
}

function assertLlmRetryStatusContracts() {
  assert.match(agent, /const\s+emitLlmRetry\s*=\s*\(/, "agent should define a lightweight LLM retry event emitter");
  assert.match(agent, /onRetry:\s*emitLlmRetry/, "LLM retry callbacks should be wired into agent LLM options");
  assert.match(sidepanel, /"llm_retry"/, "sidepanel should treat LLM retry as a scoped runtime event");
  assert.match(sidepanel, /"llm_rate_wait"/, "sidepanel should treat a long provider wait as a scoped runtime event");

  const onPortMessageBody = extractFunction(eventRouter, "handle");
  assert.match(
    onPortMessageBody,
    /case\s+"llm_retry":[\s\S]*t\("modelRetry",[\s\S]*seconds:\s*delaySeconds[\s\S]*t\("retrying"\)[\s\S]*break;/,
    "transport retries should expose their existing delay while other retries keep a generic status",
  );
  const retryCase = onPortMessageBody.match(/case\s+"llm_retry":[\s\S]*?break;/)?.[0] || "";
  assert.doesNotMatch(retryCase, /recordSessionTranscriptEvent/, "LLM retry should not be written into the chat transcript");
  assert.match(
    onPortMessageBody,
    /case\s+"llm_rate_wait":[\s\S]*showStatus\(t\("modelQueued"\),\s*\{\s*immediate:\s*true\s*\}\)[\s\S]*break;/,
    "long provider waits should update the status bar without adding transcript noise",
  );
  const rateWaitCase = onPortMessageBody.match(/case\s+"llm_rate_wait":[\s\S]*?break;/)?.[0] || "";
  assert.doesNotMatch(rateWaitCase, /waitMs|秒/, "provider waits should not show an inaccurate duration beside the run timer");
}

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}`);
  if (start < 0) start = source.indexOf(`  ${name}(`);
  if (start < 0) start = source.indexOf(`${name}(`);
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
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}
