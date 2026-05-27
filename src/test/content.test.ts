import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (
  message: { type: string; [key: string]: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean;

const settings = {
  targetLanguage: "Vietnamese",
  autoTranslate: true,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3"
};

let runtimeListener: RuntimeListener;
let sentMessages: unknown[];

function installChromeMock() {
  sentMessages = [];

  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: { type: string; items?: { id: string; text: string }[] }) => {
        sentMessages.push(message);

        if (message.type === "GET_SETTINGS") return settings;
        if (message.type === "ANALYZE_PAGE") {
          return {
            detectedLanguage: "English",
            confidence: 0.95,
            isForeign: true,
            shouldTranslate: true,
            reason: "English page"
          };
        }
        if (message.type === "TRANSLATE_ITEMS") {
          return {
            items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
          };
        }
        if (message.type === "TRANSLATE_SELECTION") return { text: "Xin chao" };
        return undefined;
      }),
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => {
          runtimeListener = listener;
        })
      }
    }
  });
}

async function loadContentScript() {
  await import("../content/index");
  await Promise.resolve();
}

function sendContentMessage(message: { type: string }) {
  return new Promise<unknown>((resolve) => {
    runtimeListener(message, {}, resolve);
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  installChromeMock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("content script", () => {
  it("translates page text on request and restores original text", async () => {
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This paragraph has enough English text for page translation."
    );

    await expect(sendContentMessage({ type: "RESTORE_ORIGINALS" })).resolves.toEqual({ ok: true });
    expect(document.querySelector("p")?.textContent).toBe(
      "This paragraph has enough English text for page translation."
    );
  });

  it("shows a translation overlay for selected text", async () => {
    vi.useFakeTimers();
    await loadContentScript();
    document.body.innerHTML = "<main><p>Hello world selection text.</p></main>";

    const textNode = document.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(120);

    const button = document.querySelector<HTMLButtonElement>("button[data-translate-ai-ui='true']");
    expect(button?.textContent).toBe("Translate");

    button?.click();
    await Promise.resolve();

    const panel = document.querySelector<HTMLDivElement>("div[data-translate-ai-ui='true']");
    expect(panel?.textContent).toBe("Xin chao");
    expect(sentMessages).toContainEqual({ type: "TRANSLATE_SELECTION", text: "Hello world selection text." });
  });
});
