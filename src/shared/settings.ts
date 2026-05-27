import type { ExtensionSettings } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: "Vietnamese",
  autoTranslate: true,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3.1"
};

const SETTINGS_KEY = "translateAiSettings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSettings(raw: unknown): ExtensionSettings {
  if (!isRecord(raw)) {
    return DEFAULT_SETTINGS;
  }

  return {
    targetLanguage: typeof raw.targetLanguage === "string" ? raw.targetLanguage : DEFAULT_SETTINGS.targetLanguage,
    autoTranslate: typeof raw.autoTranslate === "boolean" ? raw.autoTranslate : DEFAULT_SETTINGS.autoTranslate,
    ollamaEndpoint: typeof raw.ollamaEndpoint === "string" ? raw.ollamaEndpoint : DEFAULT_SETTINGS.ollamaEndpoint,
    ollamaModel: typeof raw.ollamaModel === "string" ? raw.ollamaModel : DEFAULT_SETTINGS.ollamaModel
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}
