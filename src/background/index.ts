import { chunkTextItems } from "../shared/chunking";
import { analyzeLanguage, translateItems, translateSelection } from "../shared/ollama";
import { getSettings, saveSettings } from "../shared/settings";
import type { RuntimeMessage, TabStatus, TextItem } from "../shared/types";

const tabStatuses = new Map<number, TabStatus>();

function getSenderTabId(sender: chrome.runtime.MessageSender): number | undefined {
  return sender.tab?.id;
}

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (message.type === "GET_SETTINGS") return getSettings();
  if (message.type === "SAVE_SETTINGS") {
    await saveSettings(message.settings);
    return { ok: true };
  }
  if (message.type === "GET_TAB_STATUS") return tabStatuses.get(message.tabId) ?? { status: "idle" };
  if (message.type === "SET_TAB_STATUS") {
    tabStatuses.set(message.tabId, message.status);
    return { ok: true };
  }

  const settings = await getSettings();
  const tabId = getSenderTabId(sender);

  if (message.type === "ANALYZE_PAGE") {
    if (tabId) tabStatuses.set(tabId, { status: "detecting" });
    const analysis = await analyzeLanguage(settings, message.sample);
    if (tabId) {
      tabStatuses.set(tabId, {
        status: analysis.shouldTranslate ? "idle" : "not-needed",
        detectedLanguage: analysis.detectedLanguage,
        message: analysis.reason
      });
    }
    return analysis;
  }

  if (message.type === "TRANSLATE_ITEMS") {
    const chunks = chunkTextItems(message.items, 5000);
    const translated: TextItem[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (tabId) tabStatuses.set(tabId, { status: "translating", progress: { done: index, total: chunks.length } });
      translated.push(...(await translateItems(settings, chunks[index])));
    }
    if (tabId) tabStatuses.set(tabId, { status: "translated", progress: { done: chunks.length, total: chunks.length } });
    return { items: translated };
  }

  if (message.type === "TRANSLATE_SELECTION") {
    return { text: await translateSelection(settings, message.text) };
  }

  return { ok: false };
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});
