import { chunkTextItems } from "../shared/chunking";
import { analyzeLanguage, translateItems, translateSelection } from "../shared/ollama";
import { getSettings, saveSettings } from "../shared/settings";
import type { RuntimeMessage, TabStatus, TextItem } from "../shared/types";

const STATUS_KEY_PREFIX = "translateAiTabStatus:";
const fallbackTabStatuses = new Map<number, TabStatus>();

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
    return { ok: true };
  }
  if (message.type === "GET_TAB_STATUS") return getTabStatus(message.tabId);
  if (message.type === "SET_TAB_STATUS") {
    const tabId = message.tabId ?? getSenderTabId(sender);
    if (tabId === undefined) throw new Error("Missing tab id for tab status");
    await setTabStatus(tabId, message.status);
    return { ok: true };
  }

  const settings = await getSettings();
  const tabId = getSenderTabId(sender);

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
    try {
      const chunks = chunkTextItems(message.items, 5000);
      const translated: TextItem[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        if (tabId !== undefined) {
          await setTabStatus(tabId, { status: "translating", progress: { done: index, total: chunks.length } });
        }
        translated.push(...(await translateItems(settings, chunks[index])));
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
    }
  }

  if (message.type === "TRANSLATE_SELECTION") {
    return { text: await translateSelection(settings, message.text) };
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
