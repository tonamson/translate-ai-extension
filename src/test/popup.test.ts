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

    <label>
      Target language
      <select id="targetLanguage">
        <option value="Vietnamese">Vietnamese</option>
        <option value="English">English</option>
        <option value="Japanese">Japanese</option>
        <option value="Korean">Korean</option>
      </select>
    </label>
    <label>
      API type
      <select id="apiProvider">
        <option value="openai-compatible">OpenAI-compatible</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </label>
    <label>API base URL <input id="openaiBaseUrl" /></label>
    <label>AI model <input id="openaiModel" /></label>
    <label>API key <input id="openaiApiKey" type="password" /></label>

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
  apiProvider: "openai-compatible",
  openaiBaseUrl: "https://api.example.test/v1",
  openaiModel: "example-model",
  openaiApiKey: "test-key"
};

const tabStatus: TabStatus = {
  status: "translated",
  detectedLanguage: "English"
};

function getInput(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}

function getSelect(id: string): HTMLSelectElement {
  return document.querySelector<HTMLSelectElement>(`#${id}`)!;
}

async function loadPopup() {
  await import("../popup/main");
  await flushPromises();
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) {
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

    expect(getSelect("targetLanguage").value).toBe("Japanese");
    expect(getSelect("apiProvider").value).toBe("openai-compatible");
    expect(getInput("openaiBaseUrl").value).toBe("https://api.example.test/v1");
    expect(getInput("openaiModel").value).toBe("example-model");
    expect(getInput("openaiApiKey").value).toBe("test-key");
    expect(document.querySelector("#autoTranslate")).toBeNull();
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

    getSelect("targetLanguage").value = "Korean";
    getSelect("apiProvider").value = "anthropic";
    getInput("openaiBaseUrl").value = "";
    getInput("openaiModel").value = "   ";
    getInput("openaiApiKey").value = "";
    document.querySelector<HTMLButtonElement>("#saveButton")!.click();
    await flushPromises();

    expect(sendMessage).toHaveBeenLastCalledWith({
      type: "SAVE_SETTINGS",
      settings: {
        targetLanguage: "Korean",
        autoTranslate: false,
        apiProvider: "anthropic",
        openaiBaseUrl: "https://api.anthropic.com/v1",
        openaiModel: "",
        openaiApiKey: "123456"
      }
    });
    expect(document.querySelector("#statusText")?.textContent).toBe("Settings saved");
  });

  it("falls back to Vietnamese when saved target language is not supported", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ...settings, targetLanguage: "Not a valid language" })
      .mockResolvedValueOnce({ status: "idle" })
      .mockResolvedValue({ ok: true });

    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), sendMessage: vi.fn() }
    });

    await loadPopup();

    expect(getSelect("targetLanguage").value).toBe("Vietnamese");
    document.querySelector<HTMLButtonElement>("#saveButton")!.click();
    await flushPromises();

    expect(sendMessage).toHaveBeenLastCalledWith({
      type: "SAVE_SETTINGS",
      settings: expect.objectContaining({ targetLanguage: "Vietnamese" })
    });
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

  it("injects the content script and retries when the active tab is not ready", async () => {
    const tabSendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Receiving end does not exist."))
      .mockResolvedValueOnce({ ok: true });
    const executeScript = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce({ status: "idle" })
      },
      scripting: { executeScript },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42, url: "https://example.com" }]), sendMessage: tabSendMessage }
    });

    await loadPopup();

    document.querySelector<HTMLButtonElement>("#translateButton")!.click();
    await flushPromises();

    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ["assets/content.js"] });
    expect(tabSendMessage).toHaveBeenCalledTimes(2);
    expect(tabSendMessage).toHaveBeenLastCalledWith(42, { type: "MANUAL_TRANSLATE_PAGE" });
    expect(window.close).toHaveBeenCalledTimes(1);
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
    const executeScript = vi.fn().mockRejectedValue(new Error("Cannot access this page."));

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce({ status: "idle" })
      },
      scripting: { executeScript },
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
