import type { ExtensionSettings, PageAnalysis, TextItem } from "./types";

type OllamaGenerateResponse = {
  response?: string;
};

export function parseJsonObjectFromModelText<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object");
  }

  return JSON.parse(text.slice(start, end + 1)) as T;
}

async function generateJson(settings: ExtensionSettings, prompt: string): Promise<unknown> {
  const response = await fetch(`${settings.ollamaEndpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaModel,
      prompt,
      stream: false,
      format: "json"
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  if (!data.response) {
    throw new Error("Ollama response was empty");
  }

  return parseJsonObjectFromModelText(data.response);
}

export async function analyzeLanguage(settings: ExtensionSettings, sample: string): Promise<PageAnalysis> {
  const prompt = [
    "Detect the language of this web page sample.",
    `Target language: ${settings.targetLanguage}.`,
    "Return only JSON with keys: detectedLanguage, confidence, isForeign, shouldTranslate, reason.",
    "Translate only when the page is not already in the target language.",
    `Sample:\n${sample}`
  ].join("\n");

  return (await generateJson(settings, prompt)) as PageAnalysis;
}

export async function translateItems(settings: ExtensionSettings, items: TextItem[]): Promise<TextItem[]> {
  const prompt = [
    `Translate each text item to ${settings.targetLanguage}.`,
    "Preserve meaning and tone. Return only JSON: {\"items\":[{\"id\":\"...\",\"text\":\"...\"}]}",
    `Items:\n${JSON.stringify({ items })}`
  ].join("\n");

  const result = (await generateJson(settings, prompt)) as { items: TextItem[] };
  return result.items;
}

export async function translateSelection(settings: ExtensionSettings, text: string): Promise<string> {
  const prompt = [
    `Translate this text to ${settings.targetLanguage}.`,
    "Return only JSON: {\"text\":\"translated text\"}",
    `Text:\n${text}`
  ].join("\n");

  const result = (await generateJson(settings, prompt)) as { text: string };
  return result.text;
}
