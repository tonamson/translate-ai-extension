import { describe, expect, it } from "vitest";
import { shouldAutoTranslate } from "../shared/translationDecision";

describe("shouldAutoTranslate", () => {
  it("translates only when auto mode is enabled and analysis says translation is needed", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: true, targetLanguage: "Vietnamese", ollamaEndpoint: "http://localhost:11434", ollamaModel: "llama3.1" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: true, reason: "foreign page" }
      )
    ).toBe(true);
  });

  it("does not translate when auto mode is disabled", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: false, targetLanguage: "Vietnamese", ollamaEndpoint: "http://localhost:11434", ollamaModel: "llama3.1" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: true, reason: "foreign page" }
      )
    ).toBe(false);
  });
});
