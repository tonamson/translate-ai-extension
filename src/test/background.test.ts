import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "../shared/types";

const mockGetSettings = vi.fn();
const mockAnalyzeLanguage = vi.fn();
const mockTranslateItems = vi.fn();
const mockTranslateSelection = vi.fn();

vi.mock("../shared/settings", () => ({
  getSettings: mockGetSettings,
  saveSettings: vi.fn()
}));

vi.mock("../shared/ollama", () => ({
  analyzeLanguage: mockAnalyzeLanguage,
  translateItems: mockTranslateItems,
  translateSelection: mockTranslateSelection
}));

type RuntimeListener = (
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean;

type TabRemovedListener = (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void;
type TabUpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab
) => void;

const settings = {
  targetLanguage: "Vietnamese",
  autoTranslate: true,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3"
};

let runtimeListener: RuntimeListener;
let tabRemovedListener: TabRemovedListener;
let tabUpdatedListener: TabUpdatedListener;
let sessionStorageValues: Record<string, unknown>;

function installChromeMock() {
  sessionStorageValues = {};

  const session = {
    get: vi.fn(async (key: string) => ({ [key]: sessionStorageValues[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(sessionStorageValues, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete sessionStorageValues[key];
    })
  };

  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => {
          runtimeListener = listener;
        })
      }
    },
    tabs: {
      onRemoved: {
        addListener: vi.fn((listener: TabRemovedListener) => {
          tabRemovedListener = listener;
        })
      },
      onUpdated: {
        addListener: vi.fn((listener: TabUpdatedListener) => {
          tabUpdatedListener = listener;
        })
      }
    },
    storage: {
      sync: {
        get: vi.fn(),
        set: vi.fn()
      },
      session
    }
  };

  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}

async function loadBackground() {
  await import("../background/index");
}

function sendMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender = {}) {
  return new Promise<unknown>((resolve) => {
    expect(runtimeListener(message, sender, resolve)).toBe(true);
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installChromeMock();
  mockGetSettings.mockResolvedValue(settings);
  mockTranslateSelection.mockResolvedValue("Xin chao");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background tab status", () => {
  it("sets sender tab status to error when page analysis fails", async () => {
    mockAnalyzeLanguage.mockRejectedValue(new Error("Ollama request failed: 503"));
    await loadBackground();

    await expect(sendMessage({ type: "ANALYZE_PAGE", sample: "Hello" }, { tab: { id: 7 } as chrome.tabs.Tab }))
      .resolves.toEqual({ error: "Ollama request failed: 503" });

    await expect(sendMessage({ type: "GET_TAB_STATUS", tabId: 7 })).resolves.toEqual({
      status: "error",
      message: "Ollama request failed: 503"
    });
  });

  it("sets sender tab status to error when item translation fails", async () => {
    mockTranslateItems.mockRejectedValue(new Error("Ollama request failed: 500"));
    await loadBackground();

    await expect(
      sendMessage({ type: "TRANSLATE_ITEMS", items: [{ id: "a", text: "Hello" }] }, { tab: { id: 9 } as chrome.tabs.Tab })
    ).resolves.toEqual({ error: "Ollama request failed: 500" });

    await expect(sendMessage({ type: "GET_TAB_STATUS", tabId: 9 })).resolves.toEqual({
      status: "error",
      message: "Ollama request failed: 500"
    });
  });

  it("persists tab status in chrome.storage.session across service worker reloads", async () => {
    await loadBackground();

    await sendMessage({ type: "SET_TAB_STATUS", tabId: 11, status: { status: "translated" } });

    vi.resetModules();
    await loadBackground();

    await expect(sendMessage({ type: "GET_TAB_STATUS", tabId: 11 })).resolves.toEqual({ status: "translated" });
  });

  it("clears tab status when the tab is removed", async () => {
    await loadBackground();

    await sendMessage({ type: "SET_TAB_STATUS", tabId: 13, status: { status: "error", message: "Old page" } });
    tabRemovedListener(13, { windowId: 1, isWindowClosing: false });

    await expect(sendMessage({ type: "GET_TAB_STATUS", tabId: 13 })).resolves.toEqual({ status: "idle" });
  });

  it("clears stale tab status when navigation starts", async () => {
    await loadBackground();

    await sendMessage({ type: "SET_TAB_STATUS", tabId: 15, status: { status: "translated" } });
    tabUpdatedListener(15, { status: "loading" }, { id: 15 } as chrome.tabs.Tab);

    await expect(sendMessage({ type: "GET_TAB_STATUS", tabId: 15 })).resolves.toEqual({ status: "idle" });
  });

  it("clears stale tab status when navigation completes", async () => {
    await loadBackground();

    await sendMessage({ type: "SET_TAB_STATUS", tabId: 17, status: { status: "error", message: "Old page" } });
    tabUpdatedListener(17, { status: "complete" }, { id: 17 } as chrome.tabs.Tab);

    await expect(sendMessage({ type: "GET_TAB_STATUS", tabId: 17 })).resolves.toEqual({ status: "idle" });
  });
});
