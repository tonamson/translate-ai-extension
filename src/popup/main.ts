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

const OPEN_WEB_PAGE_MESSAGE = "Open a web page to translate.";
const PAGE_NOT_READY_MESSAGE = "This page is not ready for translation.";

type ErrorResponse = {
  error: string;
};

type ActivePageTab = chrome.tabs.Tab & {
  id: number;
};

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("Receiving end does not exist")) {
    return PAGE_NOT_READY_MESSAGE;
  }

  return error instanceof Error ? error.message : String(error);
}

function renderError(error: unknown): void {
  statusText.textContent = getErrorMessage(error);
  statusDot.dataset.status = "error";
}

async function unwrapResponse<T>(promise: Promise<unknown>): Promise<T> {
  const response = await promise;
  if (isErrorResponse(response)) {
    throw new Error(response.error);
  }

  return response as T;
}

function sendMessage<T>(message: unknown): Promise<T> {
  return unwrapResponse<T>(chrome.runtime.sendMessage(message) as Promise<unknown>);
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isPageUrl(url: string | undefined): boolean {
  return url !== undefined && /^(https?|file):\/\//.test(url);
}

async function getActivePageTab(): Promise<ActivePageTab> {
  const tab = await getActiveTab();
  if (typeof tab?.id !== "number" || !isPageUrl(tab.url)) {
    throw new Error(OPEN_WEB_PAGE_MESSAGE);
  }

  return tab as ActivePageTab;
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
  try {
    await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() });
    statusText.textContent = "Settings saved";
  } catch (error) {
    renderError(error);
  }
});

translateButton.addEventListener("click", async () => {
  try {
    const tab = await getActivePageTab();
    await unwrapResponse(chrome.tabs.sendMessage(tab.id, { type: "MANUAL_TRANSLATE_PAGE" }));
    window.close();
  } catch (error) {
    renderError(error);
  }
});

restoreButton.addEventListener("click", async () => {
  try {
    const tab = await getActivePageTab();
    await unwrapResponse(chrome.tabs.sendMessage(tab.id, { type: "RESTORE_ORIGINALS" }));
    window.close();
  } catch (error) {
    renderError(error);
  }
});

refresh().catch(renderError);
