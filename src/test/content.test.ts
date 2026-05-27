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
let messageHandlers: Partial<Record<string, (message: { type: string; items?: { id: string; text: string }[] }) => unknown>>;

function installChromeMock() {
  sentMessages = [];
  messageHandlers = {};

  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: { type: string; items?: { id: string; text: string }[] }) => {
        sentMessages.push(message);

        const handler = messageHandlers[message.type];
        if (handler) return handler(message);
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

async function flushPromises() {
  await Promise.resolve();
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
  settings.autoTranslate = true;
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

  it("manual page translation bypasses the auto translate setting", async () => {
    settings.autoTranslate = false;
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });

    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This paragraph has enough English text for page translation."
    );
  });

  it("reports not-needed status when page text is too short to detect", async () => {
    await loadContentScript();
    document.body.innerHTML = "<main><p>Too short.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });

    expect(sentMessages).toContainEqual({
      type: "SET_TAB_STATUS",
      status: { status: "not-needed", message: "Not enough text to detect" }
    });
  });

  it("reports restored status after restoring originals", async () => {
    await loadContentScript();

    await expect(sendContentMessage({ type: "RESTORE_ORIGINALS" })).resolves.toEqual({ ok: true });

    expect(sentMessages).toContainEqual({
      type: "SET_TAB_STATUS",
      status: { status: "restored" }
    });
  });

  it("returns an error response when page analysis fails in the background", async () => {
    messageHandlers.ANALYZE_PAGE = () => ({ error: "analysis failed" });
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ error: "analysis failed" });
  });

  it("shows an error panel when selection translation fails in the background", async () => {
    messageHandlers.TRANSLATE_SELECTION = () => ({ error: "selection failed" });
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
    button?.click();
    await flushPromises();

    const panel = document.querySelector<HTMLDivElement>("div[data-translate-ai-ui='true']");
    expect(panel?.textContent).toBe("selection failed");
  });

  it("preserves leading and trailing whitespace when replacing adjacent inline text nodes", async () => {
    messageHandlers.TRANSLATE_ITEMS = (message) => ({
      items:
        message.items?.map((item) => ({
          id: item.id,
          text: item.text === "Hello" ? "Xin chao" : item.text === "world" ? "the gioi" : `vi:${item.text}`
        })) ?? []
    });
    await loadContentScript();
    document.body.innerHTML =
      "<main><p><span>Hello </span><strong>world</strong><em> enough surrounding English content for translation.</em></p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });

    expect(document.querySelector("span")?.textContent).toBe("Xin chao ");
    expect(document.querySelector("strong")?.textContent).toBe("the gioi");
    expect(document.querySelector("p")?.textContent).toContain("Xin chao the gioi");
  });

  it("restores text by node identity after new text nodes are inserted between translations", async () => {
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });

    const paragraph = document.querySelector("p")!;
    paragraph.insertBefore(document.createTextNode("Inserted English content before existing text. "), paragraph.firstChild);

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await expect(sendContentMessage({ type: "RESTORE_ORIGINALS" })).resolves.toEqual({ ok: true });

    expect(paragraph.textContent).toBe(
      "Inserted English content before existing text. This paragraph has enough English text for page translation."
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
    await flushPromises();

    const panel = document.querySelector<HTMLDivElement>("div[data-translate-ai-ui='true']");
    expect(panel?.textContent).toBe("Xin chao");
    expect(sentMessages).toContainEqual({ type: "TRANSLATE_SELECTION", text: "Hello world selection text." });
  });
});
