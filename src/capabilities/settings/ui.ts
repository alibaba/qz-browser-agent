import type { UiExtensionAPI } from "#sdk/sidepanel";
import type { SettingsConfig } from "#sdk/shared/settings";
import { createSettingsFeature } from "./settings-feature.js";
import { createCliConnection } from "./cli-connection.js";
import { createOnboardingFeature } from "./onboarding-feature.js";

/** Settings, connection notices and first-use guidance share the package's config projection. */
export default function (qz: UiExtensionAPI) {
  const { root, signal, extensions } = qz;
  const resources = root.createElement("div");
  resources.style.display = "contents";
  resources.append(root.querySelector<HTMLTemplateElement>("#settings-ui-template")!.content.cloneNode(true));
  root.body.append(resources);
  const mountedNodes: Node[] = [resources];
  for (const [template, slot] of [["settings-notices-template", "composer-notices"], ["settings-model-template", "composer-meta"]]) {
    const content = root.querySelector<HTMLTemplateElement>(`#${template}`)?.content;
    if (content) {
      const fragment = content.cloneNode(true) as DocumentFragment;
      mountedNodes.push(...fragment.childNodes);
      root.querySelector(`[data-ui-slot="${slot}"]`)?.append(fragment);
    }
  }
  qz.onDispose(() => { for (const node of mountedNodes) node.parentNode?.removeChild(node); });
  const cliConnection = createCliConnection(qz);
  let onboarding: ReturnType<typeof createOnboardingFeature> | undefined;
  const settings = createSettingsFeature({
    root, signal, settings: qz.settings, request: qz.request, send: qz.send,
    createProductSettings: qz.providers.createSettings,
    setDebugMode: qz.setDebugMode, confirm: input => qz.dialogs.confirm(input), showToast: qz.showToast,
    renderWelcome: () => onboarding?.render(), getRunContext: qz.getRunContext,
    restoreComposerFocus: () => qz.chat.focus("preset_closed"),
  });
  onboarding = createOnboardingFeature({
    messagesEl: qz.chat.messages, inputEl: qz.chat.input, welcomeHTML: qz.chat.welcomeHTML,
    template: root.querySelector<HTMLTemplateElement>("#settings-onboarding-template"),
    settings, storage: globalThis.localStorage, getCurrentSessionId: qz.getCurrentSessionId,
    composer: { setValue: value => qz.chat.setInput(value) }, showWelcome: qz.chat.showWelcome,
    switchTab: qz.navigate, chatTab: "chat", skillsTab: "skills",
    openSkillCatalog: () => { extensions.invoke("skills.openOfficial"); },
  });
  qz.on("*", event => {
    if (settings.handleProductEvent(event)) return;
    switch (event.type) {
      case "config":
        if (event.config) settings.applyConfig(event.config as SettingsConfig);
        break;
      case "config_saved":
        if (!event.requestId && event.config) settings.applySavedConfig(event.config as SettingsConfig);
        break;
      case "model_preset_switcher_requested": settings.openPresetSwitcher(); break;
      case "plugin_registry_update": case "skill_settings_changed":
        void settings.refreshSkillSettings({ silent: true }); break;
      case "message_start":
        if (event.message && typeof event.message === "object" && "role" in event.message) {
          if (event.message.role === "assistant") settings.hideGptConnectHint();
          if (event.message.role === "user") onboarding?.markActivated();
        }
        break;
      case "thinking_update": case "message_update": case "tool_call_update":
        settings.hideGptConnectHint(); break;
      case "message_end":
        if (event.message && typeof event.message === "object" && "role" in event.message
          && event.message.role === "assistant" && "content" in event.message && event.message.content) onboarding?.markActivated();
        break;
      case "turn_start": case "agent_start": settings.showGptConnectHint(event); break;
    }
  });
  qz.on("*", event => {
    switch (event.type) {
      case "ui_workspace_started": onboarding?.start(); break;
      case "ui_chat_reset": onboarding?.render(); settings.hideGptConnectHint(); break;
      case "ui_chat_branding": onboarding?.render(); break;
      case "ui_chat_submitted": onboarding?.markActivated(); settings.hideGptConnectHint(); break;
      case "ui_chat_dock": case "ui_session_changed": settings.renderGptConnectHint(); break;
      case "ui_notice_hide": settings.hideGptConnectHint(); break;
      case "ui_clear_landing_history": onboarding?.clearLandingHistory(); break;
      case "ui_onboarding_reset": onboarding?.reset({ clearStorage: true, render: false }); break;
      case "ui_close_transient": cliConnection.close(); settings.closePresetSwitcherIfOpen(); settings.closeProviderPickerIfOpen(); settings.closeModelSuggestionsIfOpen(); break;
    }
  });
  for (const section of settings.settingsSections) qz.registerSettings(section.id === "advanced" ? {
    ...section,
    activate(context) { void cliConnection.activate(context);return section.activate?.(context); },
    deactivate() { cliConnection.deactivate();return section.deactivate?.(); },
  } : section);
  qz.registerOverlay({ id: "cli-connection", priority: 100, close: cliConnection.close, blocksFocus: cliConnection.isOpen });
  qz.registerOverlay({
      id: "model-picker", priority: 90,
      close: () => settings.closePresetSwitcherIfOpen() || settings.closeProviderPickerIfOpen() || settings.closeModelSuggestionsIfOpen(),
      blocksFocus: settings.hasBlockingOverlay,
  });
  qz.onDispose(() => {
      onboarding?.stop();
      cliConnection.deactivate();
      settings.dispose();
      qz.chat.messages.querySelector(".welcome-onboarding")?.remove();
      qz.chat.messages.querySelector("#welcome")?.classList.remove("onboarding-dismissed");
  });
}
