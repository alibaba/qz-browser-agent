import type { ProviderContribution } from '../../../background/llm/provider-types.js';
import { getLanguage } from '../../../shared/i18n/index.js';

export function getProductDefaultProvider(): string {
  return getLanguage().startsWith('zh-') ? 'deepseek' : 'openrouter';
}
export const PRODUCT_PROVIDERS: Readonly<Record<string, ProviderContribution>> = Object.freeze({});
export async function getProductProviderAuthStatus(): Promise<Record<string, unknown>> { return {}; }

export const isRetiredProductCredential = (_value: string): boolean => false;
