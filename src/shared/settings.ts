import type { ApiProvider, ExtensionSettings } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: "Vietnamese",
  autoTranslate: false,
  apiProvider: "openai-compatible",
  openaiBaseUrl: "https://api.stepfun.ai/v1",
  openaiModel: "",
  openaiApiKey: "123456"
};

const SETTINGS_KEY = "translateAiSettings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeApiProvider(value: unknown): ApiProvider {
  return value === "anthropic" || value === "openai-compatible" ? value : DEFAULT_SETTINGS.apiProvider;
}

export function normalizeSettings(raw: unknown): ExtensionSettings {
  if (!isRecord(raw)) {
    return DEFAULT_SETTINGS;
  }

  return {
    targetLanguage: typeof raw.targetLanguage === "string" ? raw.targetLanguage : DEFAULT_SETTINGS.targetLanguage,
    autoTranslate: typeof raw.autoTranslate === "boolean" ? raw.autoTranslate : DEFAULT_SETTINGS.autoTranslate,
    apiProvider: normalizeApiProvider(raw.apiProvider),
    openaiBaseUrl: typeof raw.openaiBaseUrl === "string"
      ? raw.openaiBaseUrl
      : typeof raw.ollamaEndpoint === "string"
        ? raw.ollamaEndpoint
        : DEFAULT_SETTINGS.openaiBaseUrl,
    openaiModel: typeof raw.openaiModel === "string"
      ? raw.openaiModel
      : typeof raw.ollamaModel === "string"
        ? raw.ollamaModel
        : DEFAULT_SETTINGS.openaiModel,
    openaiApiKey: typeof raw.openaiApiKey === "string" ? raw.openaiApiKey : DEFAULT_SETTINGS.openaiApiKey
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}
