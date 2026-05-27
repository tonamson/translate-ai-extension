import { collectVisibleTextNodes, createPageSample, type CollectedTextNode } from "./domText";
import { shouldAutoTranslate } from "../shared/translationDecision";
import type { ExtensionSettings, PageAnalysis, TextItem } from "../shared/types";

const originals = new Map<string, { node: Text; text: string }>();
let selectionButton: HTMLButtonElement | null = null;
let selectionPanel: HTMLDivElement | null = null;

function sendMessage<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function rememberOriginals(items: CollectedTextNode[]): void {
  for (const item of items) {
    if (!originals.has(item.id)) {
      originals.set(item.id, { node: item.node, text: item.node.textContent ?? "" });
    }
  }
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
    if (translated) item.node.textContent = translated;
  }
}

function restoreOriginals(): void {
  for (const original of originals.values()) {
    original.node.textContent = original.text;
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
    const result = await sendMessage<{ text: string }>({ type: "TRANSLATE_SELECTION", text: selectedText });
    showSelectionPanel(result.text);
  });

  document.body.append(selectionButton);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MANUAL_TRANSLATE_PAGE") {
    translatePage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: String(error) }));
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
