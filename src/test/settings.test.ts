import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, getSettings, normalizeSettings } from "../shared/settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeSettings", () => {
  it("keeps valid stored settings", () => {
    expect(
      normalizeSettings({
        targetLanguage: "Japanese",
        autoTranslate: false,
        apiProvider: "anthropic",
        openaiBaseUrl: "https://api.example.test/v1",
        openaiModel: "example-model",
        openaiApiKey: "test-key"
      })
    ).toEqual({
      targetLanguage: "Japanese",
      autoTranslate: false,
      apiProvider: "anthropic",
      openaiBaseUrl: "https://api.example.test/v1",
      openaiModel: "example-model",
      openaiApiKey: "test-key"
    });
  });

  it("migrates legacy ollama-named provider settings", () => {
    expect(
      normalizeSettings({
        targetLanguage: "Japanese",
        autoTranslate: false,
        ollamaEndpoint: "http://legacy.test:11434",
        ollamaModel: "legacy-model"
      })
    ).toEqual({
      targetLanguage: "Japanese",
      autoTranslate: false,
      apiProvider: "openai-compatible",
      openaiBaseUrl: "http://legacy.test:11434",
      openaiModel: "legacy-model",
      openaiApiKey: "123456"
    });
  });

  it("falls back to defaults for fields with invalid types", () => {
    expect(
      normalizeSettings({
        targetLanguage: 123,
        autoTranslate: "yes",
        openaiBaseUrl: null,
        openaiModel: ["example-model"],
        openaiApiKey: 123
      })
    ).toEqual(DEFAULT_SETTINGS);
  });
});

describe("getSettings", () => {
  it("normalizes untyped chrome storage data", async () => {
    const get = vi.fn().mockResolvedValue({
      translateAiSettings: {
        targetLanguage: "Korean",
        autoTranslate: "false",
        openaiBaseUrl: "https://remote.test/v1",
        openaiModel: undefined,
        openaiApiKey: undefined
      }
    });

    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get
        }
      }
    });

    await expect(getSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      targetLanguage: "Korean",
      openaiBaseUrl: "https://remote.test/v1"
    });
    expect(get).toHaveBeenCalledWith("translateAiSettings");
  });
});
