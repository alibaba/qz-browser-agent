import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { CustomProviderProtocol } from "../../shared/contracts/settings.js";
interface ConfigRuntimeOptions {
  listCustomProtocols?(): readonly CustomProviderProtocol[];
  getConfig(): Promise<RuntimeConfig>;
  saveConfig(config: Record<string, unknown>, signal?: AbortSignal): Promise<RuntimeConfig>;
  saveModelPreset(preset: Record<string, unknown>): Promise<RuntimeConfig>;
  applyModelPreset(presetId: string, signal?: AbortSignal): Promise<RuntimeConfig>;
  deleteModelPreset(presetId: string): Promise<RuntimeConfig>;
  clearProviderAuth(provider: string): Promise<unknown>;
  getSecurityGuardrails: typeof import("../../shared/security-guardrails.js").getSecurityGuardrails;
  saveSecurityGuardrails: typeof import("../../shared/security-guardrails.js").saveSecurityGuardrails;
  getCurrentRuntimeConfig(): Promise<RuntimeConfig>;
  setCurrentRuntimeConfig(config: RuntimeConfig): unknown;
  clearContextUsage?(): Promise<unknown>;
}
/** Keeps persisted model settings and the in-memory run snapshot in lockstep. */
export function createConfigRuntime({
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
  clearContextUsage = async () => {},
}: ConfigRuntimeOptions) {
  async function get() {
    const [config, securityGuardrails] = await Promise.all([
      getConfig(),
      getSecurityGuardrails(),
    ]);
    return updateRuntimeConfig({ ...config, securityGuardrails });
  }

  async function save(inputConfig: Record<string, unknown> = {}, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const writesGuardrails = Object.prototype.hasOwnProperty.call(inputConfig, "securityGuardrails");
    const config = await saveConfig(inputConfig, signal);
    try {
      signal?.throwIfAborted();
      config.securityGuardrails = writesGuardrails
        ? await saveSecurityGuardrails(inputConfig.securityGuardrails)
        : await getSecurityGuardrails();
    } catch (error) {
      // The model write may already be committed; keep its live snapshot consistent.
      config.securityGuardrails = await getSecurityGuardrails();
      await updateRuntimeConfig(config, { clearUsage: true });
      throw error;
    }
    return updateRuntimeConfig(config, { clearUsage: true });
  }

  function setRuntime(config: RuntimeConfig = {}) {
    setCurrentRuntimeConfig(config);
    return getCurrentRuntimeConfig();
  }

  async function savePreset(preset: Record<string, unknown> = {}) {
    return updateRuntimeConfig(await saveModelPreset(preset), { clearUsage: true });
  }

  async function applyPreset(presetId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return updateRuntimeConfig(await applyModelPreset(presetId, signal), { clearUsage: true });
  }

  async function deletePreset(presetId: string) {
    return updateRuntimeConfig(await deleteModelPreset(presetId));
  }

  async function logoutProvider(provider: string) {
    const authStatus = await clearProviderAuth(provider);
    return { authStatus, config: await refresh() };
  }

  async function refresh() {
    return updateRuntimeConfig(await getConfig(), { clearUsage: true });
  }

  async function updateRuntimeConfig(config: RuntimeConfig, { clearUsage = false } = {}) {
    const complete = listCustomProtocols ? { ...config, customProtocols: listCustomProtocols() } : config;
    setCurrentRuntimeConfig(complete);
    if (clearUsage) await clearContextUsage();
    return complete;
  }

  return Object.freeze({
    get,
    save,
    getRuntime: getCurrentRuntimeConfig,
    setRuntime,
    savePreset,
    applyPreset,
    deletePreset,
    logoutProvider,
    refresh,
  });
}
