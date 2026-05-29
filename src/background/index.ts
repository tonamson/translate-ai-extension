import { chunkTextItems } from "../shared/chunking";
import { analyzeLanguage, translateItems } from "../shared/ai";
import { getSettings, saveSettings } from "../shared/settings";
import type { RuntimeMessage, TabStatus, TextItem } from "../shared/types";

const STATUS_KEY_PREFIX = "translateAiTabStatus:";
const fallbackTabStatuses = new Map<number, TabStatus>();
const activeTranslationControllers = new Set<AbortController>();

function getSenderTabId(sender: chrome.runtime.MessageSender): number | undefined {
  return sender.tab?.id;
}

function getTabStatusKey(tabId: number): string {
  return `${STATUS_KEY_PREFIX}${tabId}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSessionStorage(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.session;
}

function logBackgroundDebug(message: string, data?: unknown): void {
  console.debug(`[Translate AI][background] ${message}`, data ?? "");
}

function abortActiveTranslations(): void {
  for (const controller of activeTranslationControllers) {
    controller.abort();
  }
  activeTranslationControllers.clear();
}

async function notifyTabsSettingsUpdated(): Promise<void> {
  if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) return;

  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number")
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" }).catch(() => undefined))
    );
  } catch {
    // Tabs without the content script loaded are expected.
  }
}

async function getTabStatus(tabId: number): Promise<TabStatus> {
  const storage = getSessionStorage();
  if (!storage) return fallbackTabStatuses.get(tabId) ?? { status: "idle" };

  try {
    const key = getTabStatusKey(tabId);
    const result = await storage.get(key);
    return (result[key] as TabStatus | undefined) ?? { status: "idle" };
  } catch {
    return fallbackTabStatuses.get(tabId) ?? { status: "idle" };
  }
}

async function setTabStatus(tabId: number, status: TabStatus): Promise<void> {
  fallbackTabStatuses.set(tabId, status);

  const storage = getSessionStorage();
  if (!storage) return;

  await storage.set({ [getTabStatusKey(tabId)]: status });
}

async function clearTabStatus(tabId: number): Promise<void> {
  fallbackTabStatuses.delete(tabId);

  const storage = getSessionStorage();
  if (!storage) return;

  await storage.remove(getTabStatusKey(tabId));
}

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (message.type === "GET_SETTINGS") return getSettings();
  if (message.type === "SAVE_SETTINGS") {
    await saveSettings(message.settings);
    abortActiveTranslations();
    void notifyTabsSettingsUpdated();
    return { ok: true };
  }
  if (message.type === "SETTINGS_UPDATED") return { ok: true };
  if (message.type === "GET_TAB_STATUS") return getTabStatus(message.tabId);
  if (message.type === "SET_TAB_STATUS") {
    const tabId = message.tabId ?? getSenderTabId(sender);
    if (tabId === undefined) throw new Error("Missing tab id for tab status");
    await setTabStatus(tabId, message.status);
    return { ok: true };
  }

  const settings = await getSettings();
  const tabId = getSenderTabId(sender);
  logBackgroundDebug("message", {
    type: message.type,
    tabId,
    provider: settings.apiProvider,
    baseUrl: settings.openaiBaseUrl,
    model: settings.openaiModel,
    itemCount: "items" in message ? message.items.length : undefined,
    sampleChars: "sample" in message ? message.sample.length : undefined
  });

  if (message.type === "ANALYZE_PAGE") {
    try {
      if (tabId !== undefined) await setTabStatus(tabId, { status: "detecting" });
      const analysis = await analyzeLanguage(settings, message.sample);
      if (tabId !== undefined) {
        await setTabStatus(tabId, {
          status: analysis.shouldTranslate ? "idle" : "not-needed",
          detectedLanguage: analysis.detectedLanguage,
          message: analysis.reason
        });
      }
      return analysis;
    } catch (error) {
      if (tabId !== undefined) {
        await setTabStatus(tabId, { status: "error", message: getErrorMessage(error) });
      }
      throw error;
    }
  }

  if (message.type === "TRANSLATE_ITEMS") {
    const controller = new AbortController();
    activeTranslationControllers.add(controller);
    try {
      const chunks = chunkTextItems(message.items, 5000);
      logBackgroundDebug("translate-items:start", {
        tabId,
        itemCount: message.items.length,
        chunkCount: chunks.length,
        totalChars: message.items.reduce((sum, item) => sum + item.text.length, 0)
      });
      const translated: TextItem[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        logBackgroundDebug("translate-items:chunk:start", {
          tabId,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          itemCount: chunks[index].length,
          chars: chunks[index].reduce((sum, item) => sum + item.text.length, 0)
        });
        if (tabId !== undefined) {
          await setTabStatus(tabId, { status: "translating", progress: { done: index, total: chunks.length } });
        }
        translated.push(...(await translateItems(settings, chunks[index], { signal: controller.signal })));
        logBackgroundDebug("translate-items:chunk:done", {
          tabId,
          chunkIndex: index + 1,
          chunkCount: chunks.length
        });
      }
      if (tabId !== undefined) {
        await setTabStatus(tabId, { status: "translated", progress: { done: chunks.length, total: chunks.length } });
      }
      return { items: translated };
    } catch (error) {
      if (tabId !== undefined) {
        await setTabStatus(tabId, { status: "error", message: getErrorMessage(error) });
      }
      throw error;
    } finally {
      activeTranslationControllers.delete(controller);
    }
  }

  if (message.type === "TRANSLATE_TEXT") {
    const overriddenSettings = { ...settings, targetLanguage: message.targetLanguage };
    const items = await translateItems(overriddenSettings, [{ id: "sel", text: message.text }]);
    return { text: items[0]?.text ?? message.text };
  }

  return { ok: false };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabStatus(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url !== undefined) {
    void clearTabStatus(tabId);
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ error: getErrorMessage(error) }));
  return true;
});
