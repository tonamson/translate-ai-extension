import { describe, expect, it } from "vitest";
import { shouldAutoTranslate } from "../shared/translationDecision";

describe("shouldAutoTranslate", () => {
  it("translates only when auto mode is enabled and analysis says translation is needed", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: true, targetLanguage: "Vietnamese", apiProvider: "openai-compatible", openaiBaseUrl: "https://api.stepfun.ai/v1", openaiModel: "example-model", openaiApiKey: "123456" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: true, reason: "foreign page" }
      )
    ).toBe(true);
  });

  it("does not translate when auto mode is disabled", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: false, targetLanguage: "Vietnamese", apiProvider: "openai-compatible", openaiBaseUrl: "https://api.stepfun.ai/v1", openaiModel: "example-model", openaiApiKey: "123456" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: true, reason: "foreign page" }
      )
    ).toBe(false);
  });

  it("does not translate when the page is not foreign", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: true, targetLanguage: "Vietnamese", apiProvider: "openai-compatible", openaiBaseUrl: "https://api.stepfun.ai/v1", openaiModel: "example-model", openaiApiKey: "123456" },
        { detectedLanguage: "Vietnamese", confidence: 0.9, isForeign: false, shouldTranslate: true, reason: "target language page" }
      )
    ).toBe(false);
  });

  it("does not translate when analysis says translation is unnecessary", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: true, targetLanguage: "Vietnamese", apiProvider: "openai-compatible", openaiBaseUrl: "https://api.stepfun.ai/v1", openaiModel: "example-model", openaiApiKey: "123456" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: false, reason: "user content excluded" }
      )
    ).toBe(false);
  });
});
