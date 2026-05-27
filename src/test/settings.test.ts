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
        ollamaEndpoint: "http://example.test:11434",
        ollamaModel: "mistral"
      })
    ).toEqual({
      targetLanguage: "Japanese",
      autoTranslate: false,
      ollamaEndpoint: "http://example.test:11434",
      ollamaModel: "mistral"
    });
  });

  it("falls back to defaults for fields with invalid types", () => {
    expect(
      normalizeSettings({
        targetLanguage: 123,
        autoTranslate: "yes",
        ollamaEndpoint: null,
        ollamaModel: ["llama3.1"]
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
        ollamaEndpoint: "http://remote.test:11434",
        ollamaModel: undefined
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
      ollamaEndpoint: "http://remote.test:11434"
    });
    expect(get).toHaveBeenCalledWith("translateAiSettings");
  });
});
