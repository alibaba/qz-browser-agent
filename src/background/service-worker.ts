import { initializeLanguage, whenLanguageReady, readLanguagePreference, saveLanguagePreference, getAvailableLanguages } from "../shared/i18n/index.js";
import { firefoxExtension } from "../shared/product-text.js";
import { matchConfiguredModelCapabilities } from "../shared/models/model-capabilities.js";
import { createContentLanguageSnapshot } from "../shared/i18n/content.js";
import { createSessionImportLabels } from "./services/session-import-labels.js";
import { t } from "../shared/i18n/backend.js";
import type { Agent } from "./agent/agent.js";
/**
 * Composition root: connect state owners and selected product ports, then expose application APIs.
 * Business modules never import this entry; construction cycles use explicit deferred callbacks.
 */

import {
  applyModelPreset,
  chat as llmChat,
  chatStream as llmChatStream,
  clearProviderAuth,
  deleteModelPreset,
  getConfig,
  listCustomProtocols,
  listModels,
  pollProviderLogin,
  saveConfig,
  saveModelPreset,
  setModelChangeObserver,
  startProviderLogin,
} from "./llm/index.js";
import { createSkillWorkspaceService } from "./skills/skill-workspace.js";
import { createProductRuntime } from "./product/runtime.js";
import {
  clearTraceLog,
  diagnosticTrace,
  getTraceLog,
  trace as llmTrace,
} from "./trace.js";
import { buildRunProfile as createRunProfile } from "./agent/run-profile.js";
import { getCurrentRuntimeConfig, getCurrentRuntimeConfigVersion, setCurrentRuntimeConfig } from "./runtime-config.js";
import {
  getQingzhouMcpBridgeConfig,
  getQingzhouMcpConnectionStatus,
  qingzhouMcpBridgeStorageKey,
  saveQingzhouMcpBridgeConfig,
  startQingzhouMcpBridge,
} from "./mcp/mcp-bridge.js";
import { createMcpConnectPage, assertMcpSettingsSender } from "./mcp/connect-page.js";
import type { CliConnectionInput } from "../shared/mcp-connection.js";
import { createMcpResourceRuntime } from "./mcp/resource-runtime.js";
import { createMcpManagementRuntime } from "./mcp/management-runtime.js";
import { downloadMcpFile } from "./mcp/file-download.js";
import {
  listSkills,
  loadSkill,
  validateSkillMcpConfig,
  buildSkillPromptSection,
  matchSiteSkillsForUrls,
} from "./skills/runtime.js";
import {
  createToolRuntime,
  getToolIdentity,
  releaseRunCdp,
  releaseSessionCdp,
  releaseTabCdp,
  resolveToolDefinition,
  sendToContent,
  withRunCdp,
  withTemporaryCdp,
} from "./tools/runtime.js";
import {
  commitSkillToolRegistryCandidate,
  getSkillToolRegistrySnapshot,
  getSkillToolRegistryExecutionSnapshot,
  listSkillContributions,
  prepareSkillToolRegistryFromStorage,
  publishSkillToolRegistryUpdate,
  subscribeSkillToolRegistry,
} from "./skills/skill-tool-runtime.js";
import { createSerialQueue } from "./internal/serial-queue.js";
import {
  getLastTranscriptToolName,
} from "../shared/session/session-codec.js";
import {
  normalizeParentSessionId,
  ROOT_SESSION_ID,
} from "../shared/session/session-store.js";
import { getSessionRepository, getSessions } from "./session/repository.js";
import { createSessionSupervisor } from "./session/supervisor.js";
import { createSessionRuntimeState } from "./session/runtime-state.js";
import { createSessionCommands } from "./session/commands.js";
import { createSessionAgentHost } from "./session/agent-host.js";
import { createLifecycleObservers } from "./lifecycle-observers.js";
import observerCapabilities from "#capabilities/observers";
import {
  normalizeRuntimeSessionId as normalizeSessionId,
  normalizeRuntimeStatus,
  requireExplicitSessionId,
} from "./session/id.js";
import {
  createSessionTabs,
  getOwnedTabIds,
} from "./session/tabs.js";
import {
  createAgentBrowserContext,
  createSessionBrowserContextCollector,
} from "./session/browser-context.js";
import { createSessionArtifacts } from "./session/artifacts.js";
import { createSessionTranscript } from "./session/transcript.js";
import {
  createRunScriptArtifactCollector,
  createRunScriptBridge,
} from "./tools/run-script-bridge.js";
import { createToolEventRouter } from "./tools/event-router.js";
import { createBackgroundApi } from "./background-api.js";
import { createMcpRuntime } from "./mcp/mcp-runtime.js";
import { createMcpTransport } from "./transports/mcp.js";
import { createSidepanelTransport } from "./transports/sidepanel.js";
import { createRuntimeMessageTransport } from "./transports/runtime-message.js";
import { createSidepanelChannel } from "./transports/sidepanel-channel.js";
import { createChromeWindowTarget } from "./services/chrome-window-target.js";
import { createLocationService } from "./services/location.js";
import { createDataConsentService } from "./services/data-consent.js";
import { initializeProviderHeaderRules } from "./services/provider-header-rules.js";
import { createConfigRuntime } from "./services/config-runtime.js";
import { createSessionExchangeBridge } from "./services/session-exchange-bridge.js";
import { createPlatformCommands } from "./services/platform-commands.js";
import { createOffscreenKeepalive } from "./services/offscreen-keepalive.js";
import { createGitSkillPublisherService } from "./skills/git-skill-publisher.js";
import { createGitSkillSourceService } from "./skills/git-skill-sources.js";
import { createPageSkillImportService } from "./skills/page-skill-importer.js";
import { createSkillDocumentResourceService } from "./skills/skill-document-resources.js";
import { createChatDocumentAttachmentService } from "./services/chat-document-attachments.js";
import { createSkillSettingsService } from "./skills/skill-settings.js";
import { createSkillNetworkService } from "./skills/skill-network.js";
import {
  createChromeNotificationService,
  createSessionCompletionNotifier,
} from "./services/chrome-notifications.js";
import { createChromeStoreReviewStore } from "./services/chrome-store-review.js";
import { createGitSkillSourceRepository } from "./skills/git-skill-source-repository.js";
import { getAutomationRepository } from "./automation/repository.js";
import {
  createAutomationRuntime,
  isAutomationSessionFamily as isAutomationSessionTree,
} from "./automation/runtime.js";
import { ensureQingzhouTabGroupForWindow } from "../shared/tab-groups.js";
import { buildSessionTitleMessages } from "./agent/prompts.js";
import { nowBeijingDateTime } from "../shared/time-utils.js";
import {
  annotateSecurityGuardrailTab,
  getSecurityGuardrails,
  saveSecurityGuardrails,
} from "../shared/security-guardrails.js";
import {
  getSkillDisplayName,
  normalizeSkillResourcePath,
} from "../shared/skills/skill-utils.js";
import {
  appendSessionResourceArtifacts,
} from "../shared/session/session-resource-ledger.js";

console.log("[轻舟] Service Worker started");

const dataConsent = createDataConsentService(chrome.storage.local);

const MODEL_PRESET_SWITCHER_COMMAND = "open-model-preset-switcher";

let sessionCommands: ReturnType<typeof createSessionCommands>;
let skillSettings: ReturnType<typeof createSkillSettingsService>;
const skillRegistryLifecycleQueue = createSerialQueue();
let skillToolRegistryInitAttempt: Promise<ReturnType<typeof getSkillToolRegistrySnapshot>> | null = null;
let skillToolRegistryNeedsRefresh = true;

async function refreshSkillToolRegistry({
  reason = "registry_changed",
  previousSkillName = "",
  skillName = "",
} = {}, { publish = false } = {}) {
  return skillRegistryLifecycleQueue.run(async () => {
    skillToolRegistryNeedsRefresh = true;
    const candidate = await prepareSkillToolRegistryFromStorage();
    await skillSettings.reconcile({
      plugins: candidate.plugins,
      previousSkillName: String(previousSkillName),
      skillName: String(skillName),
    });
    const skillToolRegistry = commitSkillToolRegistryCandidate(candidate, { reason: String(reason) });
    skillToolRegistryNeedsRefresh = false;
    if (publish) {
      publishSkillToolRegistryUpdate(String(reason), skillToolRegistry, {
        previousSkillName: String(previousSkillName),
        skillName: String(skillName),
      });
    }
    return skillToolRegistry;
  });
}

function startSkillToolRegistryInitialization(reason = "registry_init") {
  const publish = getSkillToolRegistrySnapshot().refreshedAt > 0;
  const attempt = refreshSkillToolRegistry({ reason }, { publish });
  skillToolRegistryInitAttempt = attempt;
  const clearAttempt = () => {
    if (skillToolRegistryInitAttempt === attempt) skillToolRegistryInitAttempt = null;
  };
  attempt.then(clearAttempt, clearAttempt);
  return attempt;
}

async function ensureSkillToolRegistryReady(reason = "registry_ready") {
  if (skillToolRegistryInitAttempt) {
    await skillToolRegistryInitAttempt.catch(() => undefined);
  }
  if (skillRegistryLifecycleQueue.pending > 0) await skillRegistryLifecycleQueue.onIdle();
  const snapshot = getSkillToolRegistrySnapshot();
  if (!skillToolRegistryNeedsRefresh && snapshot.refreshedAt > 0) return snapshot;
  try {
    return await startSkillToolRegistryInitialization(reason);
  } catch (error) {
    const fallback = getSkillToolRegistrySnapshot();
    if (fallback.refreshedAt > 0) return fallback;
    throw error;
  }
}

async function commitSkillRegistryChange(reason: string, details: { skillName?: string; previousSkillName?: string } = {}) {
  const input = {
    ...details,
    reason,
  };
  return refreshSkillToolRegistry(input, { publish: true });
}

const skillWorkspace = createSkillWorkspaceService({ onChanged: commitSkillRegistryChange });

async function runSkillSettingsRequest<T>(reason: string, operation: () => Promise<T>) {
  await ensureSkillToolRegistryReady(reason);
  return skillRegistryLifecycleQueue.run(operation);
}

const sidepanelChannel = createSidepanelChannel({
  normalizeSessionId,
  getRuntime: sessionId => sessionCommands?.getSessionRuntimeState(sessionId) || { status: "idle", running: false },
  trace: llmTrace,
});
const broadcast = sidepanelChannel.broadcast;
const chromeWindowTarget = createChromeWindowTarget({
  tabs: chrome.tabs,
  windows: chrome.windows,
});
const chromeNotificationService = createChromeNotificationService({
  notifications: chrome.notifications,
  runtime: chrome.runtime,
  windows: chrome.windows,
});

function revealNotificationSession(sessionId: string) {
  const id = normalizeSessionId(sessionId);
  if (!id) return false;
  const event = { type: "session_reveal_requested", sessionId: id, source: "notification" };
  const runtime = sessionCommands?.getSessionRuntimeState?.(id) || {};
  const tabId = Number(runtime.workingTabId || runtime.workingTab?.id);
  const windowIdValue = runtime.workingTab?.windowId ?? chromeNotificationService.getLastKnownWindowId?.();
  const fallbackWindowId = windowIdValue == null ? NaN : Number(windowIdValue);
  const hasWorkingTab = Number.isInteger(tabId) && tabId > 0;
  const hasFallbackWindow = Number.isInteger(fallbackWindowId) && fallbackWindowId >= 0;
  const openOptions = hasWorkingTab
    ? { tabId }
    : hasFallbackWindow
      ? { windowId: fallbackWindowId }
      : null;
  const pendingKey = `notification_session_reveal:${id}`;
  let cancelled = false;

  const routeReveal = async ({ remember = false } = {}) => {
    let windowId = !hasWorkingTab && hasFallbackWindow ? fallbackWindowId : null;
    if (hasWorkingTab && chrome.tabs?.get) {
      try {
        const liveTab = await chrome.tabs.get(tabId);
        const liveWindowId = Number(liveTab?.windowId);
        if (Number.isInteger(liveWindowId) && liveWindowId >= 0) windowId = liveWindowId;
      } catch (_error) {}
    }
    if (cancelled || windowId === null) return false;
    const delivered = await sidepanelChannel.sendToWindow(windowId, event);
    if (!delivered && remember && !cancelled) {
      sidepanelChannel.remember(pendingKey, event, 30_000, { windowId });
    }
    void Promise.resolve(chrome.windows?.update?.(windowId, { focused: true })).catch(() => {});
    return delivered || remember;
  };

  if (!openOptions || !chrome.sidePanel?.open) {
    return routeReveal().then(delivered => {
      if (!delivered) console.debug("[轻舟] notification reveal has no available side panel target:", id);
      return delivered;
    });
  }

  let openAttempt;
  try {
    // Keep this call in the notification event's synchronous user-gesture turn.
    openAttempt = chrome.sidePanel.open(openOptions);
  } catch (error) {
    cancelled = true;
    sidepanelChannel.clearPending(pendingKey);
    console.debug("[轻舟] notification side panel open failed:", error instanceof Error ? error.message : error);
    return false;
  }
  const routeAttempt = routeReveal({ remember: true });
  return Promise.resolve(openAttempt).then(
    () => routeAttempt,
    (error) => {
      cancelled = true;
      sidepanelChannel.clearPending(pendingKey);
      console.debug("[轻舟] notification side panel open failed:", error instanceof Error ? error.message : error);
      return false;
    },
  );
}
const offscreenKeepalive = createOffscreenKeepalive({
  offscreen: chrome.offscreen,
  runtime: chrome.runtime,
});
chrome.runtime.onStartup?.addListener(() => {
  refreshSkillToolRegistry({ reason: "runtime_startup" }).catch((err) => {
    console.debug("[轻舟] Skill tool registry startup failed:", err instanceof Error ? err.message : err);
  });
  offscreenKeepalive.ensure().catch((err) => {
    console.debug("[轻舟] offscreen startup failed:", err instanceof Error ? err.message : err);
  });
  automationRuntime.start().catch((err) => {
    console.debug("[轻舟] automation scheduler startup failed:", err instanceof Error ? err.message : err);
  });
});

chrome.runtime.onInstalled?.addListener(() => {
  refreshSkillToolRegistry({ reason: "runtime_installed" }).catch((err) => {
    console.debug("[轻舟] Skill tool registry install failed:", err instanceof Error ? err.message : err);
  });
  offscreenKeepalive.ensure().catch((err) => {
    console.debug("[轻舟] offscreen install failed:", err instanceof Error ? err.message : err);
  });
  automationRuntime.start().catch((err) => {
    console.debug("[轻舟] automation scheduler install failed:", err instanceof Error ? err.message : err);
  });
});

// ---------------------------------------------------------------------------
// Agent management
// ---------------------------------------------------------------------------

const sessionRepository = getSessionRepository();
const chatDocumentAttachments = createChatDocumentAttachmentService({
  sessionRepository,
  trace: diagnosticTrace,
});
let automationRuntime: ReturnType<typeof createAutomationRuntime>;
let sessionCompletionNotifier: ReturnType<typeof createSessionCompletionNotifier>;
let sessionSupervisor: ReturnType<typeof createSessionSupervisor<Agent>>;
let toolRuntime: ReturnType<typeof createToolRuntime>;
const agentBrowserContext = createAgentBrowserContext({
  scripting: chrome.scripting,
  tabs: chrome.tabs,
});
const productRuntime = createProductRuntime({
  browser: chrome,
  llm: { chat: llmChat, chatStream: llmChatStream },
  windowTarget: chromeWindowTarget,
  getTranscript: sessionId => sessionTranscript.get(sessionId),
  trace: diagnosticTrace,
  refreshConfig: () => configRuntime.refresh(),
});
setModelChangeObserver(productRuntime.onModelChange);
const agentLlm = productRuntime.llm;
dataConsent.whenAccepted.then(() => productRuntime.start()).catch(err => console.debug("[轻舟] product runtime start failed:", err instanceof Error ? err.message : err));
const collectRunScriptToolArtifacts = createRunScriptArtifactCollector({ getToolIdentity });
const releaseAgentRunResources = async ({ sessionId, runId, eventType }: { sessionId: string; runId: string; eventType?: string }) => {
  try { return await releaseRunCdp(sessionId, runId); }
  finally { if (eventType === "delete_session") await releaseSessionCdp(sessionId); }
};
const lifecycle = createLifecycleObservers([...productRuntime.observers, ...observerCapabilities.flat()], {
  onDiagnostic: diagnostic => console.debug("[轻舟] lifecycle observer:", diagnostic),
});
const agentServices = Object.freeze({
  getRuntimeConfig: getCurrentRuntimeConfig,
  getRuntimeConfigVersion: getCurrentRuntimeConfigVersion,
  getPlatformInfo: () => chrome.runtime.getPlatformInfo(),
  buildSkillPromptSection,
  matchSiteSkillsForUrls,
  getSkillToolRegistrySnapshot: getSkillToolRegistryExecutionSnapshot,
  getSecurityGuardrails,
  trace: llmTrace,
});
async function buildRunProfile(options: Partial<Parameters<typeof createRunProfile>[0]> = {}) {
  const [config, platformInfo] = await Promise.all([
    options.config || getCurrentRuntimeConfig(), options.platformInfo || agentServices.getPlatformInfo().catch(() => ({})),
  ]);
  return createRunProfile({ ...options, config, platformInfo });
}
const sessionAgentHost = createSessionAgentHost({
  repository: sessionRepository,
  normalizeSessionId,
  llm: agentLlm,
  agentServices,
  browserContext: agentBrowserContext,
  ensureSkillToolRegistryReady: ensureSkillToolRegistryReady,
  lifecycle,
  getToolRuntime: () => toolRuntime,
  getSupervisor: () => sessionSupervisor,
  getCommands: () => sessionCommands,
  getWorkingTabContext: sessionId => sessionTabs.getWorkingTabContext(sessionId, { readOnly: true }),
  recordTranscriptEvent: (...args) => sessionTranscript.recordEvent(...args),
  recordRuntimeEvent: (...args) => sessionRuntimeState.recordEvent(...args),
  persistRuntime: (...args) => sessionRuntimeState.persist(...args),
  recordResourceEvent: (...args) => sessionArtifacts.recordResourceEvent(...args),
  hydrateTranscript: (...args) => sessionTranscript.hydrate(...args),
  releaseRunResources: releaseAgentRunResources,
  closeOwnedTabs: (...args) => sessionTabs.closeOwnedTabsAfterTerminal(...args),
  getAutomationRuntime: () => automationRuntime,
  broadcast,
});
sessionSupervisor = createSessionSupervisor({
  createAgent: sessionAgentHost.createAgent,
  initializeAgent: sessionAgentHost.initializeAgent,
  onAgentEvent: sessionAgentHost.handleEvent,
});
const chromeStoreReview = createChromeStoreReviewStore({
  storage: chrome.storage.local,
  isRootSession: async sessionId => {
    const session = (await getSessions())[sessionId];
    if (!session) return false;
    return normalizeParentSessionId(session.parentSessionId) === ROOT_SESSION_ID;
  },
});
const sessionRuntimeState = createSessionRuntimeState({
  supervisor: sessionSupervisor,
  repository: sessionRepository,
  getSessions,
  getAgentEntry: sessionAgentHost.getEntry,
  normalizeSessionId,
  scheduleTabGroupSync: sessionId => sessionTabs.scheduleGroupSync(sessionId),
  onCompleted: sessionId => sessionCompletionNotifier?.notifyCompleted(sessionId),
  onTaskCompleted: (sessionId, runtime) => chromeStoreReview.recordCompletion(sessionId, runtime),
});
const sessionArtifacts = createSessionArtifacts({
  sessionRepository,
  getSessions,
  ready: () => sessionRuntimeReady,
  normalizeSessionId,
  nowBeijingDateTime,
  broadcast,
  resolveSessionArtifactTranscript: (...args) => sessionCommands.resolveSessionArtifactTranscript(...args),
  collectRunScriptToolArtifacts,
  getToolIdentity,
});
const sessionTranscript = createSessionTranscript({
  repository: sessionRepository,
  supervisor: sessionSupervisor,
  getLiveAgentEntry: sessionAgentHost.getLiveEntry,
  normalizeSessionId,
  resolveToolDefinition,
  getToolIdentity,
  scheduleListSummaryPatch: sessionArtifacts.scheduleListSummaryPatch,
});

const sessionTabs = createSessionTabs({
  supervisor: sessionSupervisor,
  tabsApi: chrome.tabs,
  tabGroupsApi: chrome.tabGroups,
  windowsApi: chrome.windows,
  windowTarget: chromeWindowTarget,
  storage: chrome.storage.local,
  ready: () => sessionRuntimeReady,
  getSessions,
  isAutomationSessionFamily: (sessionId, sessions) => isAutomationSessionTree(sessionId, sessions, ROOT_SESSION_ID),
  setRuntime: sessionRuntimeState.set,
  persistRuntime: sessionRuntimeState.persist,
  broadcast,
  now: nowBeijingDateTime,
  ensureTabGroupForWindow: ensureQingzhouTabGroupForWindow,
  annotateGuardrailTab: annotateSecurityGuardrailTab,
  normalizeSessionId,
  rootSessionId: ROOT_SESSION_ID,
});
// Keep Chrome listener registration synchronous; commands await startup dependencies.
const languageReady = initializeLanguage({ watch: true });
const sessionRuntimeReady = Promise.all([
  sessionRuntimeState.hydrate(), languageReady, dataConsent.ready,
  initializeProviderHeaderRules({ runtime: chrome.runtime, dnr: chrome.declarativeNetRequest, fetch }),
]).then(() => undefined);
const sessionBrowserContext = createSessionBrowserContextCollector({
  ready: () => sessionRuntimeReady,
  tabs: chrome.tabs,
  normalizeSessionId,
  supervisor: sessionSupervisor,
  canUseSessionGoal: (...args) => sessionCommands.canUseSessionGoal(...args),
  getOwnedTabContexts: sessionTabs.getOwnedTabContexts,
  findOwnedTabOwner: sessionTabs.findOwner,
  ownsTab: sessionTabs.owns,
  getWorkingTabContext: sessionId => sessionTabs.getWorkingTabContext(sessionId, { readOnly: true }),
  getRuntime: (...args) => sessionCommands.getSessionRuntimeState(...args),
});
const collectBrowserContext = sessionBrowserContext.collect;
sessionCommands = createSessionCommands({
  assertDataConsent: dataConsent.assertAccepted,
  runtime: sessionRuntimeState,
  agents: sessionAgentHost,
  transcript: sessionTranscript,
  artifacts: sessionArtifacts,
  tabs: sessionTabs,
  sessionRuntimeReady,
  sessionSupervisor,
  sessionRepository,
  normalizeSessionId,
  requireExplicitSessionId,
  normalizeRuntimeStatus,
  getSessions,
  isAutomationSessionTree,
  broadcast,
  getCurrentRuntimeConfig,
  llmChat,
  buildSessionTitleMessages,
  collectBrowserContext,
  releaseRunResources: releaseAgentRunResources,
  removeChatMessageDocuments: chatDocumentAttachments.removeMessageDocuments,
  removeChatSessionDocuments: chatDocumentAttachments.removeSessionDocuments,
  removeSessionObservations: async id => productRuntime.removeSession(id),
  blockChatDocumentParsing: chatDocumentAttachments.blockSession,
  observeAgentEvent: (sessionId, event) => lifecycle.emit(sessionId, event, "committed"),
  getAutomationRuntime: () => automationRuntime,
  getAppVersion: () => chrome.runtime.getManifest()?.version || "",
});
const configRuntime = createConfigRuntime({
  listCustomProtocols,
  getConfig,
  saveConfig,
  saveModelPreset,
  applyModelPreset,
  deleteModelPreset,
  clearProviderAuth,
  getSecurityGuardrails,
  saveSecurityGuardrails,
  getCurrentRuntimeConfig,
  setCurrentRuntimeConfig,
  clearContextUsage: sessionRuntimeState.clearContextUsage,
});
sessionCompletionNotifier = createSessionCompletionNotifier({
  notifications: chromeNotificationService,
  iconUrl: chrome.runtime.getURL("icons/icon128.png"),
  normalizeSessionId,
  getRuntime: sessionCommands.getSessionRuntimeState,
  getRuntimeCheckpoint: sessionId => sessionSupervisor.getRuntime(sessionId),
  getSessions,
  getTranscript: sessionTranscript.get,
  getLastToolName: getLastTranscriptToolName,
  setRuntime: sessionRuntimeState.set,
  activateWorkingTab: sessionTabs.activateWorkingTab,
  openSession: revealNotificationSession,
  getAutomationRuntime: () => automationRuntime,
  now: nowBeijingDateTime,
});
automationRuntime = createAutomationRuntime({
  repository: getAutomationRepository(),
  sessions: {
    getRuntime: sessionCommands.getSessionRuntimeState,
    getMetadata: sessionId => sessionRepository.getMetadata(sessionId),
    listRecords: getSessions,
    create: async ({ automation, run, prompt, signal }) => {
      const { session } = await sessionCommands.createSessionMetadataRuntime({
        title: t("automation.sessionTitle", { title: String(automation.title) }),
        firstMessage: prompt,
        parentSessionId: ROOT_SESSION_ID,
        titleSource: "fixed",
        source: "automation",
        automationId: automation.id,
        automationRunId: run.id,
      }, signal);
      return session;
    },
    launch: async (sessionId, prompt, signal) => {
      const text = String(prompt || "").trim();
      if (!text) return false;
      const task = await sessionCommands.startSessionPromptTask({ sessionId, text, swallowErrors: true }, signal);
      void task.promise?.catch(error => console.warn("[轻舟] launch automation prompt failed:", error));
      return !task.cancelled;
    },
    remove: sessionCommands.deleteSessionRuntime,
    getConversation: sessionTranscript.getConversation,
    getTranscript: sessionTranscript.get,
    activateWorkingTab: sessionTabs.activateWorkingTab,
    shouldSuppressNotification: sessionCompletionNotifier.shouldSuppress,
  },
  alarms: chrome.alarms,
  notifications: {
    create: chromeNotificationService.create,
    clear: chromeNotificationService.clear,
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
  },
  emit: broadcast,
  ready: () => Promise.all([sessionRuntimeReady, dataConsent.whenAccepted]),
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  automationRuntime.handleAlarm(alarm);
});
function dataConsentAllowsImport() {
  try {
    dataConsent.assertAccepted();
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "DATA_CONSENT_REQUIRED") return false;
    throw error;
  }
}
const sessionExchangeBridge = createSessionExchangeBridge({
  sidePanel: chrome.sidePanel,
  importSessionExchange: sessionCommands.importSessionExchangeRuntime,
  channel: sidepanelChannel,
  consentAccepted: dataConsentAllowsImport,
});
skillSettings = createSkillSettingsService({
  storage: chrome.storage.local,
  listSkillManifests: () => getSkillToolRegistrySnapshot().plugins,
});
startSkillToolRegistryInitialization("service_worker_init").catch((err) => {
  console.debug("[轻舟] Skill tool registry init failed:", err instanceof Error ? err.message : err);
});
const skillNetwork = createSkillNetworkService({
  fetch: globalThis.fetch.bind(globalThis),
  declarativeNetRequest: chrome.declarativeNetRequest,
  runtime: chrome.runtime,
});
const platformCommands = createPlatformCommands({
  sessionSupervisor,
  getBridgeConfig: getQingzhouMcpBridgeConfig,
  tabs: chrome.tabs,
  sendToContent,
  ensureSkillToolRegistryReady: ensureSkillToolRegistryReady,
  listSkillContributions,
  buildSkillUiContext: sessionCommands.buildSkillUiContext,
  commitSkillRegistryChange,
});
const gitSkillSourceRepository = createGitSkillSourceRepository({ storage: chrome.storage.local });
const gitSkillSources = createGitSkillSourceService({
  repository: gitSkillSourceRepository,
  tabs: chrome.tabs,
  scripting: chrome.scripting,
  windowTarget: chromeWindowTarget,
  withRunDebugger: withRunCdp,
  withTemporaryDebugger: withTemporaryCdp,
  validateSkill: validateSkillMcpConfig,
  onSkillsChanged: ({ action, names = [] }) => platformCommands.refreshSkills({
    reason: `git_skill_source_${action || "sync"}`,
    skillName: names.length === 1 ? names[0] : "",
  }),
});
const gitSkillPublisher = createGitSkillPublisherService({
  tabs: chrome.tabs,
  scripting: chrome.scripting,
  windowTarget: chromeWindowTarget,
  validateSkill: validateSkillMcpConfig,
});
const pageSkillImporter = createPageSkillImportService({
  repository: gitSkillSourceRepository,
  withRunDebugger: withRunCdp,
  withTemporaryDebugger: withTemporaryCdp,
  validateSkill: validateSkillMcpConfig,
  onSkillsChanged: ({ names = [] }) => platformCommands.refreshSkills({
    reason: "page_skill_zip_import",
    skillName: names.length === 1 ? names[0] : "",
  }),
});
const skillDocumentResources = createSkillDocumentResourceService();
offscreenKeepalive.ensure().catch((err) => {
  console.debug("[轻舟] offscreen keepalive unavailable:", err instanceof Error ? err.message : err);
});
sessionTabs.cleanupLegacyGroups().catch((err) => {
  console.debug("[轻舟] cleanup legacy tab groups failed:", err instanceof Error ? err.message : err);
});
sessionRuntimeReady.then(() => sessionTabs.syncGroup("startup")).catch((err) => {
  console.debug("[轻舟] startup tab group sync failed:", err instanceof Error ? err.message : err);
});
Promise.all([sessionRuntimeReady, dataConsent.whenAccepted]).then(() => sessionRuntimeState.queueFollowUpResume("startup")).catch((err) => {
  console.debug("[轻舟] startup follow-up resume failed:", err instanceof Error ? err.message : err);
});
automationRuntime.start().catch((err) => {
  console.debug("[轻舟] automation scheduler unavailable:", err instanceof Error ? err.message : err);
});

const handleToolRuntimeEvent = createToolEventRouter({
  channel: sidepanelChannel,
  recordTranscriptEvent: sessionTranscript.recordEvent,
  recordRuntimeEvent: sessionRuntimeState.recordEvent,
  handleAgentEvent: sessionAgentHost.handleEvent,
  broadcast,
});
const locationService = createLocationService({
  storage: chrome.storage.local,
  sessions: sessionSupervisor,
  emit: handleToolRuntimeEvent,
  locate: sidepanelChannel.requestLocation,
});
toolRuntime = createToolRuntime({
  requestLocation: locationService.request,
  skillSettings,
  skillNetwork,
  windowTarget: chromeWindowTarget,
  skills: {
    importPageZip: pageSkillImporter.import,
    bindGitSource: gitSkillSources.bind,
    inspectGitPublishTarget: gitSkillPublisher.inspect,
    publishToGit: gitSkillPublisher.publish,
    loadDocumentResource: skillDocumentResources.load,
    refreshRegistry: commitSkillRegistryChange,
  },
  sessions: {
    listSessions: sessionCommands.listSessionsRuntime,
    createSession: sessionCommands.createSessionRuntime,
    sendMessage: async params => {
      const { promise, ...receipt } = await sessionCommands.submitSessionMessageRuntime(params);
      return receipt;
    },
    deleteSession: sessionCommands.deleteSessionRuntime,
    getLastMessages: sessionCommands.getLastMessagesRuntime,
    waitSessions: sessionCommands.waitSessionsRuntime,
    listAutomations: automationRuntime.list,
    saveAutomation: automationRuntime.save,
    deleteAutomation: automationRuntime.remove,
    runAutomation: automationRuntime.run,
    listAutomationRuns: automationRuntime.listRuns,
    reserveCreatedTab: sessionTabs.reserveCreatedTab,
    getTabAliases: sessionTabs.getTabAliases,
    reserveTabAlias: sessionTabs.reserveTabAlias,
    commitTabAlias: sessionTabs.commitTabAlias,
    discardTabAlias: sessionTabs.discardTabAlias,
    commitCreatedTab: sessionTabs.commitCreatedTab,
    discardCreatedTab: sessionTabs.discardCreatedTab,
    updateWorkingTab: sessionTabs.updateWorkingTab,
    clearWorkingTab: sessionTabs.clearWorkingTab,
    resolveTargetTab: sessionTabs.resolveTargetTab,
    listOwnedTabIds(sessionId: string) {
      return getOwnedTabIds(sessionCommands.getSessionRuntimeState(sessionId));
    },
    isRunCurrent: sessionSupervisor.isRunCurrent,
    updateGoal: sessionCommands.updateSessionGoal,
    stopSession: sessionCommands.stopSessionRuntime,
    canManageSessions: sessionCommands.canManageSessionTools,
    beginUserWait: sessionSupervisor.beginUserWait,
    resolveUserWait: sessionSupervisor.resolveUserWait,
    rejectUserWait: sessionSupervisor.rejectUserWait,
    isWaitingForUser: sessionSupervisor.isWaitingForUser,
  },
  emit: handleToolRuntimeEvent,
});
const runScriptBridge = createRunScriptBridge({
  ready: () => sessionRuntimeReady,
  normalizeSessionId,
  supervisor: sessionSupervisor,
  getRuntime: sessionCommands.getSessionRuntimeState,
  isTerminalRuntimeForRun: sessionRuntimeState.isTerminalForRun,
  canManageSessions: sessionCommands.canManageSessionTools,
  buildRunProfile,
  getRunToolContext: async (sessionId, runId) => {
    const entry = await sessionAgentHost.getLiveEntry(sessionId);
    return entry?.agent?.getRunToolContext(runId) || null;
  },
  applyNestedToolResult: async ({ sessionId, ...payload }) => {
    const entry = await sessionAgentHost.getLiveEntry(sessionId);
    return entry?.agent?.applyNestedToolResult(payload) || false;
  },
  toolRuntime,
  collectArtifacts: collectRunScriptToolArtifacts,
  appendArtifacts: appendSessionResourceArtifacts,
  scheduleArtifactRefresh: sessionArtifacts.scheduleSummaryRefresh,
});
let sidepanelTransport: ReturnType<typeof createSidepanelTransport>;
const mcpRuntime = createMcpRuntime({
  sessions: {
    normalizeId: normalizeSessionId,
    requireId: requireExplicitSessionId,
    supervisor: sessionSupervisor,
    submitMessage: sessionCommands.submitSessionMessageRuntime,
    waitForRunObserved: sessionCommands.waitForSessionRunObserved,
    getRuntimeOutput: sessionCommands.getSessionRuntimeStateForOutput,
    getLiveAgentEntry: sessionAgentHost.getLiveEntry,
    setRuntime: sessionRuntimeState.set,
    getLastMessages: sessionCommands.getLastMessagesRuntime,
    getAgent: sessionAgentHost.getAgent,
    getTranscript: sessionTranscript.get,
    listMetadata: getSessions,
    getConversation: sessionTranscript.getConversation,
    compactTranscriptEvent: sessionCommands.compactTranscriptEvent,
    getRuntime: sessionCommands.getSessionRuntimeState,
  },
  tools: {
    ready: ensureSkillToolRegistryReady,
    canManageSessions: sessionCommands.canManageSessionTools,
    buildRunProfile,
    runtime: toolRuntime,
    loadedSkillNames: sessionRuntimeState.loadedSkillNames,
    recordLoadedSkillNames: sessionRuntimeState.recordLoadedSkillNames,
  },
  skills: {
    list: listSkills,
    load: loadSkill,
    getDisplayName: getSkillDisplayName,
    normalizeResourcePath: normalizeSkillResourcePath,
    loadDocumentResource: skillDocumentResources.load,
  },
  artifacts: {
    collect: sessionArtifacts.collect,
    empty: sessionArtifacts.empty,
  },
  trace: { get: getTraceLog },
  userInputPermissions: {
    hasBrowserPermission: permission => chrome.permissions.contains({ permissions: [permission as chrome.runtime.ManifestPermission] }),
    locationConsent: locationService,
  },
  dispatchSidepanel: (message, port) => sidepanelTransport.dispatch(message, port),
  storageKey: qingzhouMcpBridgeStorageKey,
});

const mcpResources = createMcpResourceRuntime();
const mcpManagement = createMcpManagementRuntime({
  config: configRuntime,
  skills: { load: loadSkill },
  download: downloadMcpFile,
  language: { get: readLanguagePreference, save: saveLanguagePreference, list: getAvailableLanguages },
});

let mcpBridge: ReturnType<typeof startQingzhouMcpBridge> | undefined;
const connectMcp = createMcpConnectPage({
  extensionId: chrome.runtime.id,
  assertConsent: dataConsent.assertAccepted,
  connect: (input, assertCurrent) => getMcpBridge().connect(input, assertCurrent),
  getTab: tabId => chrome.tabs.get(tabId),
});

const backgroundApi = createBackgroundApi({
  system: {
    connectMcp,
    mcpConnectionStatus: (sender: chrome.runtime.MessageSender) => {
      assertMcpSettingsSender(sender, chrome.runtime.id);
      return mcpBridge?.status() || getQingzhouMcpConnectionStatus();
    },
    connectMcpFromSettings: (sender: chrome.runtime.MessageSender, input: CliConnectionInput) => {
      assertMcpSettingsSender(sender, chrome.runtime.id);
      return getMcpBridge().connect(input);
    },
    disconnectMcp: (sender: chrome.runtime.MessageSender) => {
      assertMcpSettingsSender(sender, chrome.runtime.id);
      return getMcpBridge().disconnect();
    },
    contentLanguage: async () => {
      await languageReady;
      await whenLanguageReady();
      return createContentLanguageSnapshot();
    },
    sessionImportLabels: async (language: unknown) => {
      await languageReady;
      await whenLanguageReady();
      return createSessionImportLabels(typeof language === "string" ? language : "");
    },
    acceptDataConsent: dataConsent.accept,
    acceptLocationConsent: locationService.accept,
    ready: async () => sessionRuntimeReady,
    ping: platformCommands.ping,
    runtimeMessage: mcpRuntime.dispatchRuntimeMessage,
  },
  sessions: {
    list: sessionCommands.listSessionsRuntime,
    create: sessionCommands.createSessionFromApi,
    rename: sessionCommands.renameSessionRuntime,
    remove: sessionCommands.deleteSessionRuntime,
    send: mcpRuntime.sendMessage,
    submit: sessionCommands.submitSessionMessageRuntime,
    resend: sessionCommands.resendSessionMessageRuntime,
    followUp: sessionCommands.followUpSessionRuntime,
    stop: sessionCommands.stopSessionRuntime,
    getDraft: sessionCommands.getSessionComposerDraftRuntime,
    saveDraft: sessionCommands.saveSessionComposerDraftRuntime,
    consumeDraft: sessionCommands.consumeSessionComposerDraftRuntime,
    steerFollowUp: sessionCommands.steerSessionFollowUpRuntime,
    deleteFollowUp: sessionCommands.deleteSessionFollowUpRuntime,
    deleteSteering: sessionCommands.deleteSessionSteeringRuntime,
    reorderFollowUps: sessionCommands.reorderSessionFollowUpsRuntime,
    reset: sessionCommands.resetSessionRuntime,
    compact: sessionCommands.compactSessionContextRuntime,
    createUi: sessionCommands.createUiSessionFromApi,
    hydrateListSummaries: sessionArtifacts.hydrateListSummaries,
    userInput: mcpRuntime.getUserInput,
    respondToUserInput: mcpRuntime.respondToUserInput,
    continueWait: mcpRuntime.continueUserWait,
    submitWaitForm: mcpRuntime.submitWaitForm,
    cancelWait: mcpRuntime.cancelUserWait,
    state: mcpRuntime.getState,
    snapshot: mcpRuntime.getSnapshot,
    messages: mcpRuntime.getMessages,
    history: sessionCommands.getSessionHistoryRuntime,
    clearGoal: sessionCommands.clearSessionGoalFromApi,
    restore: sessionCommands.restoreSessionFromApi,
  },
  tools: {
    list: mcpRuntime.listTools,
    execute: mcpRuntime.executeTool,
    acceptRunScriptInnerMessage: toolRuntime.handleRunScriptInnerRuntimeMessage,
    executeRunScriptCall: runScriptBridge.handleToolCall,
    executeInnerFetch: skillNetwork.execute,
    cancelInnerFetch: skillNetwork.cancel,
  },
  data: {
    listTables: mcpResources.listDataTables,
    deleteTable: mcpResources.deleteDataTable,
    exportTable: mcpResources.exportDataTable,
    listImageCollections: mcpResources.listImageCollections,
    deleteImageCollection: mcpResources.deleteImageCollection,
    exportImageCollection: mcpResources.exportImageCollection,
    listDownloads: mcpResources.listDownloads,
  },
  artifacts: {
    list: sessionArtifacts.collect,
    syncSummary: sessionArtifacts.syncSummary,
  },
  attachments: {
    stage: chatDocumentAttachments.stage,
    remove: chatDocumentAttachments.remove,
  },
  exchange: {
    saveRecord: sessionCommands.saveSessionRecordRuntime,
    export: sessionCommands.exportSessionExchangeRuntime,
    import: sessionCommands.importSessionExchangeRuntime,
    importFromPage: sessionExchangeBridge.importFromPage,
    revealForImport: sessionExchangeBridge.revealForImport,
  },
  ui: {
    startElementPicker: platformCommands.startElementPicker,
    confirmElementPicker: platformCommands.confirmElementPicker,
    cancelElementPicker: platformCommands.cancelElementPicker,
    activateWorkingTab: sessionTabs.activateWorkingTab,
  },
  skills: {
    workspaceRead: skillWorkspace.read,
    workspaceSave: skillWorkspace.save,
    workspaceImport: skillWorkspace.import,
    workspaceDelete: skillWorkspace.remove,
    list: mcpRuntime.listSkills,
    get: mcpRuntime.getSkill,
    resource: mcpRuntime.getSkillResource,
    export: mcpManagement.exportSkill,
    contributions: platformCommands.contributions,
    refresh: platformCommands.refreshSkills,
    validateMcp: validateSkillMcpConfig,
    listGitSources: gitSkillSources.list,
    bindGitSource: gitSkillSources.bind,
    checkGitSource: gitSkillSources.check,
    updateGitSource: gitSkillSources.update,
    removeGitSource: gitSkillSources.remove,
    inspectGitPublishTarget: gitSkillPublisher.inspect,
    publishToGit: gitSkillPublisher.publish,
  },
  skillSettings: {
    list: () => runSkillSettingsRequest("skill_settings_list", skillSettings.list),
    save: (input: Parameters<typeof skillSettings.save>[0]) => runSkillSettingsRequest("skill_settings_save", () => skillSettings.save(input)),
    remove: (input: Parameters<typeof skillSettings.remove>[0]) => runSkillSettingsRequest("skill_settings_remove", () => skillSettings.remove(input)),
  },
  settings: {
    get: mcpManagement.getSettings,
    update: mcpManagement.updateSettings,
  },
  config: {
    get: configRuntime.get,
    save: configRuntime.save,
    getRuntime: configRuntime.getRuntime,
    setRuntime: configRuntime.setRuntime,
    listModels,
    matchModelCapabilities: matchConfiguredModelCapabilities,
    savePreset: configRuntime.savePreset,
    applyPreset: configRuntime.applyPreset,
    deletePreset: configRuntime.deletePreset,
  },
  auth: {
    startLogin: startProviderLogin,
    pollLogin: pollProviderLogin,
    logout: configRuntime.logoutProvider,
  },
  product: { dispatch: productRuntime.dispatch },
  automations: {
    list: automationRuntime.list,
    save: automationRuntime.save,
    toggle: automationRuntime.toggle,
    remove: automationRuntime.remove,
    run: automationRuntime.run,
    runs: automationRuntime.listRuns,
  },
  trace: {
    get: getTraceLog,
    clear: clearTraceLog,
    stream: sidepanelChannel.recordStreamTrace,
  },
}, path => {
  if (["system.ready", "system.contentLanguage", "system.sessionImportLabels", "system.ping", "system.acceptDataConsent", "exchange.revealForImport", "system.mcpConnectionStatus", "system.disconnectMcp", "sessions.stop"].includes(path)) return;
  dataConsent.assertAccepted();
});

const mcpTransport = createMcpTransport(backgroundApi, {
  bridge: {
    describe: mcpRuntime.describe,
    getConfig: getQingzhouMcpBridgeConfig,
    saveConfig: saveQingzhouMcpBridgeConfig,
  },
});

sidepanelTransport = createSidepanelTransport(backgroundApi, {
  onDynamicContext: sidepanelChannel.acceptDynamicContextResponse,
  getWindowId: sidepanelChannel.getWindowId,
});
sidepanelChannel.register(chrome.runtime, sidepanelTransport.dispatch);

const runtimeMessageTransport = createRuntimeMessageTransport(backgroundApi);
runtimeMessageTransport.register(chrome.runtime);

subscribeSkillToolRegistry(broadcast);
function getMcpBridge() {
  return mcpBridge ??= startQingzhouMcpBridge({
    dispatch: mcpTransport.dispatch,
    describe: mcpRuntime.describe,
    assertConsent: dataConsent.assertAccepted,
    onStatus: status => broadcast({ type: "mcp_connection_status_changed", status }),
    trace: llmTrace,
  });
}
dataConsent.whenAccepted.then(getMcpBridge).catch(error => console.debug("[qz] MCP bridge startup failed:", error));

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseTabCdp(tabId);
  sessionTabs.handleTabRemoved(tabId).catch((error) => {
    console.warn("[轻舟] persist tab removal failed:", error);
  });
});

chrome.notifications?.onClicked?.addListener((notificationId) => {
  sessionCompletionNotifier.handleClick(notificationId).catch((err) => {
    console.debug("[轻舟] activate notification tab failed:", err instanceof Error ? err.message : err);
  });
});

chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command !== MODEL_PRESET_SWITCHER_COMMAND) return;
  const windowId = Number(tab?.windowId);
  if (!Number.isInteger(windowId) || windowId < 0) return;
  const event = { type: "model_preset_switcher_requested", source: "shortcut" };
  const pendingKey = `model_preset_switcher:${windowId}`;
  sidepanelChannel.clearPending(pendingKey);
  const revealSwitcher = async ({ remember = false } = {}) => {
    const delivered = await sidepanelChannel.sendToWindow(windowId, event);
    if (!delivered && remember) sidepanelChannel.remember(pendingKey, event, 15_000, { windowId });
  };
  void sessionExchangeBridge.openSidePanel(windowId).then((opened) => {
    revealSwitcher({ remember: opened === true });
  }, (error) => {
    revealSwitcher();
    console.debug("[轻舟] model preset shortcut could not open side panel:", error instanceof Error ? error.message : error);
  });
});

// ---------------------------------------------------------------------------
// Toggle the Side Panel when the extension icon or _execute_action shortcut is used.
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => console.log("[轻舟] setPanelBehavior OK"))
  .catch((e) => {
    console.warn("[轻舟] setPanelBehavior failed, using fallback:", e);
    chrome.action.onClicked.addListener(async (tab) => {
      try {
        await sessionExchangeBridge.openSidePanel(tab.windowId);
      } catch (err) {
        console.error("[轻舟] sidePanel.open failed:", err);
      }
    });
  });

/** Firefox end-to-end checks call page tools in this background page. */
export function installFirefoxPageToolHarness(): void {
  if (!firefoxExtension()) return;
  const root = globalThis as typeof globalThis & { __qzFirefoxPageTools?: ReturnType<typeof createToolRuntime> };
  if (root.__qzFirefoxPageTools) return;
  root.__qzFirefoxPageTools = createToolRuntime({
    sessions: {
      isRunCurrent: () => true,
      async resolveTargetTab({ tabId }) {
        const tab = await chrome.tabs.get(tabId);
        return { ok: true, tabId: Number(tab?.id || tabId), tab, ownedByCurrentTask: true };
      },
      updateWorkingTab: async () => undefined,
      clearWorkingTab: async () => undefined,
      listOwnedTabIds: () => [],
    },
  });
}

installFirefoxPageToolHarness();
