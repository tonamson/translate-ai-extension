import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, TabStatus } from "../shared/types";

const popupHtml = `
  <main class="popup">
    <header class="header">
      <div>
        <h1>Local AI Translator</h1>
        <p id="statusText" aria-live="polite">Loading...</p>
      </div>
      <span id="statusDot" class="status-dot" aria-hidden="true"></span>
    </header>

    <label>Target language <input id="targetLanguage" /></label>
    <label>Ollama endpoint <input id="ollamaEndpoint" /></label>
    <label>Model <input id="ollamaModel" /></label>

    <label class="toggle">
      <input id="autoTranslate" type="checkbox" />
      <span>Auto translate foreign pages</span>
    </label>

    <section class="actions">
      <button id="saveButton">Save</button>
      <button id="translateButton" type="button">Translate page</button>
      <button id="restoreButton" type="button">Restore</button>
    </section>
  </main>
`;

const settings: ExtensionSettings = {
  targetLanguage: "Japanese",
  autoTranslate: true,
  ollamaEndpoint: "http://ollama.test:11434",
  ollamaModel: "mistral"
};

const tabStatus: TabStatus = {
  status: "translated",
  detectedLanguage: "English"
};

function getInput(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}

async function loadPopup() {
  await import("../popup/main");
  await flushPromises();
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = popupHtml;
  vi.stubGlobal("close", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("popup UI", () => {
  it("loads settings and current tab status", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce(tabStatus);
    const query = vi.fn().mockResolvedValue([{ id: 42 }]);

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      tabs: { query, sendMessage: vi.fn() }
    });

    await loadPopup();

    expect(getInput("targetLanguage").value).toBe("Japanese");
    expect(getInput("ollamaEndpoint").value).toBe("http://ollama.test:11434");
    expect(getInput("ollamaModel").value).toBe("mistral");
    expect(getInput("autoTranslate").checked).toBe(true);
    expect(document.querySelector("#statusText")?.textContent).toBe("translated · English");
    expect((document.querySelector("#statusDot") as HTMLSpanElement).dataset.status).toBe("translated");
    expect(sendMessage).toHaveBeenNthCalledWith(2, { type: "GET_TAB_STATUS", tabId: 42 });
  });

  it("saves trimmed settings with defaults for empty fields", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ status: "idle" })
      .mockResolvedValue({ ok: true });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), sendMessage: vi.fn() }
    });

    await loadPopup();

    getInput("targetLanguage").value = "  Korean  ";
    getInput("ollamaEndpoint").value = "";
    getInput("ollamaModel").value = "   ";
    getInput("autoTranslate").checked = false;
    document.querySelector<HTMLButtonElement>("#saveButton")!.click();
    await flushPromises();

    expect(sendMessage).toHaveBeenLastCalledWith({
      type: "SAVE_SETTINGS",
      settings: {
        targetLanguage: "Korean",
        autoTranslate: false,
        ollamaEndpoint: "http://localhost:11434",
        ollamaModel: "llama3.1"
      }
    });
    expect(document.querySelector("#statusText")?.textContent).toBe("Settings saved");
  });

  it("shows an error when saving settings returns an error response", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ status: "idle" })
      .mockResolvedValueOnce({ error: "Settings failed" });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url: "https://example.com" }]), sendMessage: vi.fn() }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#saveButton")!.click();
    await flushPromises();

    expect(document.querySelector("#statusText")?.textContent).toBe("Settings failed");
    expect((document.querySelector("#statusDot") as HTMLSpanElement).dataset.status).toBe("error");
  });

  it("sends page commands to the active tab", async () => {
    const tabSendMessage = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce({ status: "idle" })
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url: "https://example.com" }]), sendMessage: tabSendMessage }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#translateButton")!.click();
    await flushPromises();
    expect(tabSendMessage).toHaveBeenCalledWith(42, { type: "MANUAL_TRANSLATE_PAGE" });

    document.querySelector<HTMLButtonElement>("#restoreButton")!.click();
    await flushPromises();
    expect(tabSendMessage).toHaveBeenCalledWith(42, { type: "RESTORE_ORIGINALS" });
    expect(window.close).toHaveBeenCalledTimes(2);
  });

  it("does not send page commands when there is no active tab", async () => {
    const tabSendMessage = vi.fn();

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings)
      },
      tabs: { query: vi.fn().mockResolvedValue([]), sendMessage: tabSendMessage }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#translateButton")!.click();
    await flushPromises();

    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    expect(document.querySelector("#statusText")?.textContent).toBe("Open a web page to translate.");
    expect((document.querySelector("#statusDot") as HTMLSpanElement).dataset.status).toBe("error");
  });

  it("does not send page commands when the active tab has no id", async () => {
    const tabSendMessage = vi.fn();

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings)
      },
      tabs: { query: vi.fn().mockResolvedValue([{ url: "https://example.com" }]), sendMessage: tabSendMessage }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#translateButton")!.click();
    await flushPromises();

    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    expect(document.querySelector("#statusText")?.textContent).toBe("Open a web page to translate.");
    expect((document.querySelector("#statusDot") as HTMLSpanElement).dataset.status).toBe("error");
  });

  it("does not send page commands to browser pages", async () => {
    const tabSendMessage = vi.fn();

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings)
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url: "chrome://extensions" }]), sendMessage: tabSendMessage }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#restoreButton")!.click();
    await flushPromises();

    expect(tabSendMessage).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    expect(document.querySelector("#statusText")?.textContent).toBe("Open a web page to translate.");
    expect((document.querySelector("#statusDot") as HTMLSpanElement).dataset.status).toBe("error");
  });

  it("shows a compact error when active tab messaging is rejected", async () => {
    const tabSendMessage = vi.fn().mockRejectedValue(new Error("Receiving end does not exist."));

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce({ status: "idle" })
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url: "https://example.com" }]), sendMessage: tabSendMessage }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#translateButton")!.click();
    await flushPromises();

    expect(tabSendMessage).toHaveBeenCalledWith(42, { type: "MANUAL_TRANSLATE_PAGE" });
    expect(window.close).not.toHaveBeenCalled();
    expect(document.querySelector("#statusText")?.textContent).toBe("This page is not ready for translation.");
    expect((document.querySelector("#statusDot") as HTMLSpanElement).dataset.status).toBe("error");
  });

  it("marks the status text as live and hides the decorative status dot", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce({ status: "idle" })
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url: "https://example.com" }]), sendMessage: vi.fn() }
    });

    await loadPopup();

    expect(document.querySelector("#statusText")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector("#statusDot")?.getAttribute("aria-hidden")).toBe("true");
  });
});
