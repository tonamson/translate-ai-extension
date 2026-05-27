import { collectVisibleTextNodes, createPageSample, type CollectedTextNode } from "./domText";
import { shouldAutoTranslate } from "../shared/translationDecision";
import type { ExtensionSettings, PageAnalysis, TextItem } from "../shared/types";

const originals = new Map<Text, string>();
let selectionButton: HTMLButtonElement | null = null;
let selectionPanel: HTMLDivElement | null = null;

type BackgroundErrorResponse = {
  error: string;
};

function isBackgroundErrorResponse(value: unknown): value is BackgroundErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendMessage<T>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (isBackgroundErrorResponse(response)) {
    throw new Error(response.error);
  }
  return response as T;
}

function rememberOriginals(items: CollectedTextNode[]): void {
  for (const item of items) {
    if (!originals.has(item.node)) {
      originals.set(item.node, item.node.textContent ?? "");
    }
  }
}

function replaceTextPreservingBoundaryWhitespace(node: Text, translated: string): void {
  const currentText = node.textContent ?? "";
  const leadingWhitespace = currentText.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = currentText.match(/\s*$/)?.[0] ?? "";
  node.textContent = `${leadingWhitespace}${translated.trim()}${trailingWhitespace}`;
}

async function translatePage(): Promise<void> {
  const settings = await sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  const nodes = collectVisibleTextNodes();
  const sample = createPageSample(nodes);

  if (sample.length < 40) return;

  const analysis = await sendMessage<PageAnalysis>({ type: "ANALYZE_PAGE", sample });
  if (!shouldAutoTranslate(settings, analysis)) return;

  rememberOriginals(nodes);
  const response = await sendMessage<{ items: TextItem[] }>({
    type: "TRANSLATE_ITEMS",
    items: nodes.map(({ id, text }) => ({ id, text }))
  });

  const translatedById = new Map(response.items.map((item) => [item.id, item.text]));
  for (const item of nodes) {
    const translated = translatedById.get(item.id);
    if (translated !== undefined) replaceTextPreservingBoundaryWhitespace(item.node, translated);
  }
}

function restoreOriginals(): void {
  for (const [node, text] of originals) {
    node.textContent = text;
  }
}

function removeSelectionUi(): void {
  selectionButton?.remove();
  selectionPanel?.remove();
  selectionButton = null;
  selectionPanel = null;
}

function showSelectionPanel(text: string): void {
  selectionPanel?.remove();
  selectionPanel = document.createElement("div");
  selectionPanel.dataset.translateAiUi = "true";
  selectionPanel.textContent = text;
  Object.assign(selectionPanel.style, {
    position: "fixed",
    right: "16px",
    bottom: "64px",
    maxWidth: "360px",
    padding: "12px",
    borderRadius: "8px",
    background: "#111827",
    color: "#ffffff",
    fontSize: "14px",
    lineHeight: "1.4",
    zIndex: "2147483647",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.24)"
  });
  document.body.append(selectionPanel);
}

function showSelectionButton(): void {
  const selectedText = window.getSelection()?.toString().trim();
  removeSelectionUi();
  if (!selectedText) return;

  selectionButton = document.createElement("button");
  selectionButton.dataset.translateAiUi = "true";
  selectionButton.type = "button";
  selectionButton.textContent = "Translate";
  Object.assign(selectionButton.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    padding: "9px 12px",
    border: "0",
    borderRadius: "999px",
    background: "#2563eb",
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    zIndex: "2147483647",
    boxShadow: "0 10px 24px rgba(37, 99, 235, 0.3)"
  });

  selectionButton.addEventListener("click", async () => {
    selectionButton!.textContent = "Translating...";
    try {
      const result = await sendMessage<{ text: string }>({ type: "TRANSLATE_SELECTION", text: selectedText });
      showSelectionPanel(result.text);
    } catch (error) {
      showSelectionPanel(getErrorMessage(error));
    }
  });

  document.body.append(selectionButton);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MANUAL_TRANSLATE_PAGE") {
    translatePage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: getErrorMessage(error) }));
    return true;
  }
  if (message?.type === "RESTORE_ORIGINALS") {
    restoreOriginals();
    sendResponse({ ok: true });
  }
  return false;
});

document.addEventListener("selectionchange", () => window.setTimeout(showSelectionButton, 120));
translatePage().catch(() => undefined);
