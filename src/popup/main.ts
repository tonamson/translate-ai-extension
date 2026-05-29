import "./styles.css";
import type { ApiProvider, ExtensionSettings, TabStatus } from "../shared/types";

const targetLanguage = document.querySelector<HTMLSelectElement>("#targetLanguage")!;
const apiProvider = document.querySelector<HTMLSelectElement>("#apiProvider")!;
const openaiBaseUrl = document.querySelector<HTMLInputElement>("#openaiBaseUrl")!;
const openaiModel = document.querySelector<HTMLInputElement>("#openaiModel")!;
const openaiApiKey = document.querySelector<HTMLInputElement>("#openaiApiKey")!;
const statusText = document.querySelector<HTMLParagraphElement>("#statusText")!;
const statusDot = document.querySelector<HTMLSpanElement>("#statusDot")!;
const saveButton = document.querySelector<HTMLButtonElement>("#saveButton")!;
const translateButton = document.querySelector<HTMLButtonElement>("#translateButton")!;
const restoreButton = document.querySelector<HTMLButtonElement>("#restoreButton")!;

const OPEN_WEB_PAGE_MESSAGE = "Open a web page to translate.";
const PAGE_NOT_READY_MESSAGE = "This page is not ready for translation.";
const DEFAULT_TARGET_LANGUAGE = "English";
const DEFAULT_OPENAI_BASE_URL = "https://api.stepfun.ai/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

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
  if (isMissingContentScriptError(error)) {
    return PAGE_NOT_READY_MESSAGE;
  }

  return error instanceof Error ? error.message : String(error);
}

function isMissingContentScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Receiving end does not exist");
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

async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["assets/content.js"] });
}

async function sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return await unwrapResponse<T>(chrome.tabs.sendMessage(tabId, message));
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    try {
      await injectContentScript(tabId);
    } catch {
      throw error;
    }
    return unwrapResponse<T>(chrome.tabs.sendMessage(tabId, message));
  }
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
  const provider = apiProvider.value === "anthropic" ? "anthropic" : "openai-compatible";

  return {
    targetLanguage: targetLanguage.value || DEFAULT_TARGET_LANGUAGE,
    apiProvider: provider,
    openaiBaseUrl: openaiBaseUrl.value.trim() || getDefaultBaseUrl(provider),
    openaiModel: openaiModel.value.trim(),
    openaiApiKey: openaiApiKey.value.trim() || "123456",
    autoTranslate: false
  };
}

function getDefaultBaseUrl(provider: ApiProvider): string {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
}

function isSupportedTargetLanguage(language: string): boolean {
  return Array.from(targetLanguage.options).some((option) => option.value === language);
}

function fillForm(settings: ExtensionSettings): void {
  targetLanguage.value = isSupportedTargetLanguage(settings.targetLanguage)
    ? settings.targetLanguage
    : DEFAULT_TARGET_LANGUAGE;
  apiProvider.value = settings.apiProvider === "anthropic" ? "anthropic" : "openai-compatible";
  openaiBaseUrl.value = settings.openaiBaseUrl;
  openaiModel.value = settings.openaiModel;
  openaiApiKey.value = settings.openaiApiKey;
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
    await sendTabMessage(tab.id, { type: "MANUAL_TRANSLATE_PAGE" });
    window.close();
  } catch (error) {
    renderError(error);
  }
});

restoreButton.addEventListener("click", async () => {
  try {
    const tab = await getActivePageTab();
    await sendTabMessage(tab.id, { type: "RESTORE_ORIGINALS" });
    window.close();
  } catch (error) {
    renderError(error);
  }
});

refresh().catch(renderError);
