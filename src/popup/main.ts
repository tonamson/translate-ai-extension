import "./styles.css";
import type { ExtensionSettings, TabStatus } from "../shared/types";

const targetLanguage = document.querySelector<HTMLInputElement>("#targetLanguage")!;
const ollamaEndpoint = document.querySelector<HTMLInputElement>("#ollamaEndpoint")!;
const ollamaModel = document.querySelector<HTMLInputElement>("#ollamaModel")!;
const autoTranslate = document.querySelector<HTMLInputElement>("#autoTranslate")!;
const statusText = document.querySelector<HTMLParagraphElement>("#statusText")!;
const statusDot = document.querySelector<HTMLSpanElement>("#statusDot")!;
const saveButton = document.querySelector<HTMLButtonElement>("#saveButton")!;
const translateButton = document.querySelector<HTMLButtonElement>("#translateButton")!;
const restoreButton = document.querySelector<HTMLButtonElement>("#restoreButton")!;

function sendMessage<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function readForm(): ExtensionSettings {
  return {
    targetLanguage: targetLanguage.value.trim() || "Vietnamese",
    ollamaEndpoint: ollamaEndpoint.value.trim() || "http://localhost:11434",
    ollamaModel: ollamaModel.value.trim() || "llama3.1",
    autoTranslate: autoTranslate.checked
  };
}

function fillForm(settings: ExtensionSettings): void {
  targetLanguage.value = settings.targetLanguage;
  ollamaEndpoint.value = settings.ollamaEndpoint;
  ollamaModel.value = settings.ollamaModel;
  autoTranslate.checked = settings.autoTranslate;
}

function renderStatus(status: TabStatus): void {
  statusText.textContent = status.detectedLanguage
    ? `${status.status} · ${status.detectedLanguage}`
    : status.message ?? status.status;
  statusDot.dataset.status = status.status;
}

async function refresh(): Promise<void> {
  fillForm(await sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }));
  const tab = await getActiveTab();
  if (tab?.id) {
    renderStatus(await sendMessage<TabStatus>({ type: "GET_TAB_STATUS", tabId: tab.id }));
  }
}

saveButton.addEventListener("click", async () => {
  await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() });
  statusText.textContent = "Settings saved";
});

translateButton.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_TRANSLATE_PAGE" });
  window.close();
});

restoreButton.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "RESTORE_ORIGINALS" });
  window.close();
});

refresh().catch((error) => {
  statusText.textContent = error instanceof Error ? error.message : String(error);
  statusDot.dataset.status = "error";
});
