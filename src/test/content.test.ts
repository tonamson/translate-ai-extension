import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (
  message: { type: string; [key: string]: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean;

const settings = {
  targetLanguage: "Vietnamese",
  autoTranslate: true,
  apiProvider: "openai-compatible",
  openaiBaseUrl: "https://api.stepfun.ai/v1",
  openaiModel: "example-model",
  openaiApiKey: "123456"
};

let runtimeListener: RuntimeListener;
let sentMessages: unknown[];
let storageData: Record<string, unknown>;
let messageHandlers: Partial<Record<string, (message: { type: string; items?: { id: string; text: string }[] }) => unknown>>;

function installChromeMock() {
  sentMessages = [];
  storageData = {};
  messageHandlers = {};

  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
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
        return undefined;
      }),
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => {
          runtimeListener = listener;
        })
      }
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          if (!keys) return { ...storageData };
          if (typeof keys === "string") return { [keys]: storageData[keys] };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
          }
          return Object.fromEntries(
            Object.entries(keys).map(([key, fallback]) => [key, storageData[key] ?? fallback])
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          storageData = { ...storageData, ...items };
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
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function sendContentMessage(message: { type: string }) {
  return new Promise<unknown>((resolve) => {
    runtimeListener(message, {}, resolve);
  });
}

async function waitFor(predicate: () => boolean, maxTicks = 20) {
  for (let index = 0; index < maxTicks; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

async function waitForScheduledBatch() {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
  await flushPromises();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  class TestPointerEvent extends MouseEvent {
    pointerId: number;

    constructor(type: string, eventInitDict: MouseEventInit & { pointerId?: number } = {}) {
      super(type, eventInitDict);
      this.pointerId = eventInitDict.pointerId ?? 1;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  document.body.innerHTML = "";
  settings.autoTranslate = true;
  installChromeMock();
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("content script", () => {
  it("lets the quick translate button snap to the nearest browser edge after dragging", async () => {
    await loadContentScript();
    document.dispatchEvent(new Event("DOMContentLoaded"));

    const button = document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']");
    expect(button).not.toBeNull();

    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 760, clientY: 560 }));
    button!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 420, clientY: 12 }));
    button!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 420, clientY: 12 }));
    button!.click();

    expect(button!.style.top).toBe("16px");
    expect(button!.style.bottom).toBe("");
    expect(button!.style.left).not.toBe("");
    expect(storageData.translateAiQuickButtonPosition).toMatchObject({ edge: "top" });
    expect(document.querySelector("[data-translate-ai-quick-menu='true']")).toBeNull();
  });

  it("anchors the quick translate menu next to the dragged button position", async () => {
    await loadContentScript();
    document.dispatchEvent(new Event("DOMContentLoaded"));

    const button = document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']");
    expect(button).not.toBeNull();

    button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 760, clientY: 560 }));
    button!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 420, clientY: 12 }));
    button!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 420, clientY: 12 }));
    await waitForScheduledBatch();
    button!.click();

    const menu = document.querySelector<HTMLDivElement>("[data-translate-ai-quick-menu='true']");
    expect(menu).not.toBeNull();
    expect(menu!.style.top).not.toBe("");
    expect(menu!.style.bottom).toBe("");
  });

  it("replaces page text on request and restores original text", async () => {
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

  it("translates short text when translation is explicitly requested", async () => {
    await loadContentScript();
    document.body.innerHTML = "<main><p>Too short.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });

    expect(document.querySelector("p")?.textContent).toBe("vi:Too short.");
    expect(sentMessages).not.toContainEqual({
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

  it("shows a page translation indicator while translation is running", async () => {
    const translation = createDeferred<{ items: { id: string; text: string }[] }>();
    messageHandlers.TRANSLATE_ITEMS = () => translation.promise;
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    const translationResponse = sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" });
    await flushPromises();

    const indicator = document.querySelector<HTMLDivElement>("[data-translate-ai-page-indicator='true']");
    expect(indicator?.textContent).toContain("Translating");
    expect(indicator?.querySelector("[data-translate-ai-progress='true']")).not.toBeNull();
    expect(indicator?.querySelector("[data-translate-ai-pause-translation='true']")).not.toBeNull();
    expect(indicator?.style.position).toBe("fixed");
    expect(indicator?.style.right).toBe("16px");
    expect(indicator?.style.bottom).toBe("16px");

    translation.resolve({
      items: [{ id: "text-0", text: "vi:This paragraph has enough English text for page translation." }]
    });
    await expect(translationResponse).resolves.toEqual({ ok: true });

    expect(document.querySelector("[data-translate-ai-page-indicator='true']")).toBeNull();
  });

  it("pauses an active translation and ignores the pending API response", async () => {
    const translation = createDeferred<{ items: { id: string; text: string }[] }>();
    messageHandlers.TRANSLATE_ITEMS = () => translation.promise;
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await waitFor(() => document.querySelector("[data-translate-ai-pause-translation='true']") !== null);

    document.querySelector<HTMLButtonElement>("[data-translate-ai-pause-translation='true']")?.click();
    await flushPromises();

    expect(document.querySelector("[data-translate-ai-page-indicator='true']")).toBeNull();
    expect(sentMessages).toContainEqual({
      type: "SET_TAB_STATUS",
      status: { status: "idle", message: "Translation paused" }
    });

    translation.resolve({
      items: [{ id: "text-0", text: "vi:This paragraph has enough English text for page translation." }]
    });
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "This paragraph has enough English text for page translation."
    );
  });

  it("restarts the in-flight batch with latest settings when settings change", async () => {
    const firstTranslation = createDeferred<{ items: { id: string; text: string }[] }>();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      if (translatedItems.length === 1) return firstTranslation.promise;
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `new-model:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await waitFor(() => translatedItems.length === 1);

    runtimeListener({ type: "SETTINGS_UPDATED" }, {}, () => undefined);
    await waitForScheduledBatch();
    await waitFor(() => translatedItems.length === 2);

    expect(translatedItems[1].map((item) => item.text)).toEqual([
      "This paragraph has enough English text for page translation."
    ]);
    expect(document.querySelector("p")?.textContent).toBe(
      "new-model:This paragraph has enough English text for page translation."
    );

    firstTranslation.resolve({
      items: [{ id: "text-0", text: "old-model:This paragraph has enough English text for page translation." }]
    });
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "new-model:This paragraph has enough English text for page translation."
    );
  });

  it("does not insert per-line translation loading markers", async () => {
    const translation = createDeferred<{ items: { id: string; text: string }[] }>();
    messageHandlers.TRANSLATE_ITEMS = () => translation.promise;
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    const translationResponse = sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" });
    await flushPromises();

    expect(document.querySelector("[data-translate-ai-page-indicator='true']")).not.toBeNull();
    expect(document.querySelector("[data-translate-ai-page-loading='true']")).toBeNull();

    translation.resolve({
      items: [{ id: "text-0", text: "vi:This paragraph has enough English text for page translation." }]
    });
    await expect(translationResponse).resolves.toEqual({ ok: true });
  });

  it("acknowledges page translation commands before the API request finishes", async () => {
    const translation = createDeferred<{ items: { id: string; text: string }[] }>();
    messageHandlers.TRANSLATE_ITEMS = () => translation.promise;
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await waitFor(() => document.querySelector("[data-translate-ai-page-indicator='true']") !== null);

    expect(document.querySelector("p")?.textContent).toBe(
      "This paragraph has enough English text for page translation."
    );

    translation.resolve({
      items: [{ id: "text-0", text: "vi:This paragraph has enough English text for page translation." }]
    });
    await waitFor(() => document.querySelector("p")?.textContent?.startsWith("vi:") === true);
  });

  it("opens a quick translate menu and translates new page text on demand", async () => {
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    document.dispatchEvent(new Event("DOMContentLoaded"));
    const quickButton = document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']");
    expect(quickButton?.title).toBe("Translate page");

    quickButton?.click();
    const menu = document.querySelector<HTMLDivElement>("[data-translate-ai-quick-menu='true']");
    expect(menu?.textContent).toContain("Dịch phần mới");
    expect(menu?.textContent).toContain("Chọn vùng để dịch");

    menu?.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='translate-new']")?.click();
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This paragraph has enough English text for page translation."
    );
  });

  it("waits briefly for page text when translating new content on a freshly rendered page", async () => {
    vi.useFakeTimers();
    await loadContentScript();
    document.body.innerHTML = "<main></main>";
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='translate-new']")?.click();
    await flushPromises();

    expect(document.querySelector("[data-translate-ai-page-indicator='true']")?.textContent).toContain(
      "Waiting for page text 1/4"
    );

    document.querySelector("main")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This delayed paragraph appears after the manual translate click."
      })
    );
    vi.advanceTimersByTime(350);
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This delayed paragraph appears after the manual translate click."
    );
  });

  it("watches lazy-loaded content and translates newly added untranslated text", async () => {
    vi.useFakeTimers();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = "<main><p>This original paragraph has enough English text for page translation.</p></main>";
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='watch-page']")?.click();
    await flushPromises();
    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This original paragraph has enough English text for page translation."
    );

    document.querySelector("main")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This lazy paragraph appears later and should be translated."
      })
    );
    await Promise.resolve();
    vi.advanceTimersByTime(650);
    await flushPromises();

    expect(translatedItems).toHaveLength(2);
    expect(translatedItems[1].map((item) => item.text)).toEqual([
      "This lazy paragraph appears later and should be translated."
    ]);
  });

  it("schedules small lazy-loaded updates without waiting for five text blocks", async () => {
    vi.useFakeTimers();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = "<main><section id=\"region\"><p>This original region text should translate first.</p></section></main>";
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='pick-region']")?.click();
    document.querySelector<HTMLElement>("#region")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    document.querySelector("#region")?.append(
      Object.assign(document.createElement("p"), { textContent: "First small lazy paragraph should translate." }),
      Object.assign(document.createElement("p"), { textContent: "Second small lazy paragraph should translate." })
    );
    await flushPromises();
    expect(document.querySelector("[data-translate-ai-page-indicator='true']")?.textContent).toContain(
      "Translating 1/1 (2 blocks)"
    );
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQuickState).toBe("queued");
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQueuedBlocks).toBe("2");

    vi.runOnlyPendingTimers();
    await flushPromises();
    expect(translatedItems).toHaveLength(2);
    expect(translatedItems[1].map((item) => item.text)).toEqual([
      "First small lazy paragraph should translate.",
      "Second small lazy paragraph should translate."
    ]);
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQuickState).toBe("pause");
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQueuedBlocks).toBe("0");
  });

  it("folds newly detected lazy-loaded blocks into the active translation progress", async () => {
    const firstTranslation = createDeferred<{ items: { id: string; text: string }[] }>();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      if (translatedItems.length === 1) return firstTranslation.promise;
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        ${Array.from({ length: 10 }, (_, index) => `<p>Initial paragraph number ${index + 1} should be translated.</p>`).join("")}
      </main>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='watch-page']")?.click();
    await flushPromises();
    expect(document.querySelector("[data-translate-ai-page-indicator='true']")?.textContent).toContain(
      "Translating 1/1 (10 blocks)"
    );

    document.querySelector("main")?.append(
      ...Array.from({ length: 200 }, (_, index) =>
        Object.assign(document.createElement("p"), {
          textContent: `Lazy paragraph number ${index + 1} should be translated after the current batch.`
        })
      )
    );
    await flushPromises();

    expect(document.querySelector("[data-translate-ai-page-indicator='true']")?.textContent).toContain(
      "Translating 1/21 (210 blocks)"
    );
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQueuedBlocks).toBe("200");

    window.dispatchEvent(new Event("pagehide"));
    firstTranslation.resolve({
      items: translatedItems[0].map((item) => ({ id: item.id, text: `vi:${item.text}` }))
    });
    await waitForScheduledBatch();
    await flushPromises();
  });

  it("translates new region content that appears while a previous region request is still running", async () => {
    vi.useFakeTimers();
    const firstTranslation = createDeferred<{ items: { id: string; text: string }[] }>();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      if (translatedItems.length === 1) return firstTranslation.promise;
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        <section id="region"><p>This original region text should translate first.</p></section>
      </main>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='pick-region']")?.click();
    document.querySelector<HTMLElement>("#region")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    document.querySelector("#region")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This delayed region text appears before the first request finishes."
      })
    );
    await Promise.resolve();
    vi.advanceTimersByTime(650);
    await flushPromises();
    expect(document.querySelector("[data-translate-ai-page-indicator='true']")?.textContent).toContain(
      "Translating 1/1 (2 blocks)"
    );
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQuickState).toBe("queued");

    firstTranslation.resolve({
      items: [{ id: "text-0", text: "vi:This original region text should translate first." }]
    });
    await flushPromises();
    vi.advanceTimersByTime(0);
    await flushPromises();

    expect(translatedItems).toHaveLength(2);
    expect(translatedItems[1].map((item) => item.text)).toEqual([
      "This delayed region text appears before the first request finishes."
    ]);
    expect(document.querySelector("#region p:last-child")?.textContent).toBe(
      "vi:This delayed region text appears before the first request finishes."
    );
  });

  it("watches only a picked page region until paused", async () => {
    vi.useFakeTimers();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        <section id="left"><p>This left section has enough English text for page translation.</p></section>
        <section id="right"><p>This right section must stay original for now.</p></section>
      </main>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='pick-region']")?.click();
    document.querySelector<HTMLElement>("#left")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const highlight = document.querySelector<HTMLDivElement>("[data-translate-ai-region-highlight='true']");
    expect(highlight?.style.background).toBe("rgba(37, 99, 235, 0.12)");
    expect(highlight?.style.pointerEvents).toBe("none");
    expect(document.querySelector("[data-translate-ai-page-indicator='true']")?.textContent).toContain(
      "Click vùng cần dịch"
    );
    document.querySelector<HTMLElement>("#left")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(document.querySelector("#left p")?.textContent).toBe(
      "vi:This left section has enough English text for page translation."
    );
    expect(document.querySelector("#right p")?.textContent).toBe("This right section must stay original for now.");

    document.querySelector("#left")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This lazy left paragraph appears later and should be translated."
      })
    );
    document.querySelector("#right")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This lazy right paragraph should not be translated by region watch."
      })
    );
    await Promise.resolve();
    vi.advanceTimersByTime(650);
    await flushPromises();

    expect(document.querySelector("#left p:last-child")?.textContent).toBe(
      "vi:This lazy left paragraph appears later and should be translated."
    );
    expect(document.querySelector("#right p:last-child")?.textContent).toBe(
      "This lazy right paragraph should not be translated by region watch."
    );

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    expect(document.querySelector("[data-translate-ai-quick-logo='true']")).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQuickState).toBe("translate");

    document.querySelector("#left")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This left paragraph appears after pause and should remain original."
      })
    );
    await Promise.resolve();
    vi.advanceTimersByTime(650);
    await flushPromises();

    expect(document.querySelector("#left p:last-child")?.textContent).toBe(
      "This left paragraph appears after pause and should remain original."
    );
  });

  it("translates a short picked region instead of rejecting it as too short", async () => {
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        <section id="short"><p>Hello world.</p></section>
      </main>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='pick-region']")?.click();
    document.querySelector<HTMLElement>("#short")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(document.querySelector("#short p")?.textContent).toBe("vi:Hello world.");
    expect(sentMessages).not.toContainEqual({
      type: "SET_TAB_STATUS",
      status: { status: "not-needed", message: "Not enough text to detect" }
    });
  });

  it("detects the nearest text region when picking an empty child inside a region", async () => {
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        <section id="card">
          <div id="empty-child"></div>
          <p>This card paragraph should translate when selecting the card area.</p>
        </section>
      </main>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='pick-region']")?.click();
    document.querySelector<HTMLElement>("#empty-child")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    document.querySelector<HTMLElement>("#empty-child")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(document.querySelector("#card p")?.textContent).toBe(
      "vi:This card paragraph should translate when selecting the card area."
    );
  });

  it("expands picked inline text to the nearest readable container", async () => {
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        <section id="card">
          <p id="copy"><span id="word">This</span> paragraph should translate as one context.</p>
        </section>
      </main>
    `;
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='pick-region']")?.click();
    document.querySelector<HTMLElement>("#word")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    document.querySelector<HTMLElement>("#word")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(document.querySelector("#copy")?.textContent).toBe(
      "vi:This vi:paragraph should translate as one context."
    );
  });

  it("does not auto translate when the content script loads", async () => {
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await loadContentScript();
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "This paragraph has enough English text for page translation."
    );
    expect(sentMessages.some((message) => (message as { type?: string }).type === "TRANSLATE_ITEMS")).toBe(false);
  });

  it("does not resend text nodes that were already translated", async () => {
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await flushPromises();
    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await flushPromises();

    expect(translatedItems).toHaveLength(1);
  });

  it("reuses cached translations for remounted text instead of sending duplicate batches", async () => {
    vi.useFakeTimers();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = "<main><p>This virtualized paragraph should not be translated twice.</p></main>";
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='watch-page']")?.click();
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This virtualized paragraph should not be translated twice."
    );

    document.querySelector("p")?.remove();
    document.querySelector("main")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "This virtualized paragraph should not be translated twice."
      })
    );
    await Promise.resolve();
    vi.advanceTimersByTime(650);
    await flushPromises();

    expect(translatedItems).toHaveLength(1);
    expect(document.querySelector("p")?.textContent).toBe(
      "vi:This virtualized paragraph should not be translated twice."
    );
  });

  it("does not queue duplicate remounted text while the original block is still in flight", async () => {
    vi.useFakeTimers();
    const firstTranslation = createDeferred<{ items: { id: string; text: string }[] }>();
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return firstTranslation.promise;
    };
    await loadContentScript();
    document.body.innerHTML = "<main><p>Pending virtualized paragraph should join the in flight translation.</p></main>";
    document.dispatchEvent(new Event("DOMContentLoaded"));

    document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.click();
    document.querySelector<HTMLButtonElement>("[data-translate-ai-menu-action='watch-page']")?.click();
    await waitFor(() => translatedItems.length === 1);

    document.querySelector("p")?.remove();
    document.querySelector("main")?.append(
      Object.assign(document.createElement("p"), {
        textContent: "Pending virtualized paragraph should join the in flight translation."
      })
    );
    await Promise.resolve();
    vi.advanceTimersByTime(650);
    await flushPromises();

    expect(translatedItems).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>("[data-translate-ai-quick-action='true']")?.dataset.translateAiQueuedBlocks).toBe("0");

    firstTranslation.resolve({
      items: [{
        id: translatedItems[0][0].id,
        text: "vi:Pending virtualized paragraph should join the in flight translation."
      }]
    });
    await flushPromises();

    expect(document.querySelector("p")?.textContent).toBe(
      "vi:Pending virtualized paragraph should join the in flight translation."
    );
  });

  it("acknowledges page translation commands and reports background translation failures through tab status", async () => {
    messageHandlers.TRANSLATE_ITEMS = () => ({ error: "translation failed" });
    await loadContentScript();
    document.body.innerHTML = "<main><p>This paragraph has enough English text for page translation.</p></main>";

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await flushPromises();
    expect(sentMessages).toContainEqual({
      type: "SET_TAB_STATUS",
      status: { status: "error", message: "translation failed" }
    });
  });

  it("does not show a translate button when text is selected", async () => {
    vi.useFakeTimers();
    await loadContentScript();
    document.body.innerHTML = "<main><p>Hello world selection text.</p></main>";

    const textNode = document.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(160);
    await flushPromises();

    const uiButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-translate-ai-ui='true']"));
    expect(uiButtons.some((button) => button.textContent === "Translate")).toBe(false);
    expect(document.querySelector("[data-translate-ai-selection-panel='true']")).toBeNull();
    expect(sentMessages).not.toContainEqual({ type: "TRANSLATE_SELECTION", text: "Hello world selection text." });
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

  it("schedules page text translation in batches of at most ten blocks", async () => {
    const translatedItems: { id: string; text: string }[][] = [];
    messageHandlers.TRANSLATE_ITEMS = (message) => {
      translatedItems.push(message.items ?? []);
      return {
        items: message.items?.map((item) => ({ id: item.id, text: `vi:${item.text}` })) ?? []
      };
    };
    await loadContentScript();
    document.body.innerHTML = `
      <main>
        ${Array.from({ length: 16 }, (_, index) => `<p>This paragraph number ${index + 1} should be translated.</p>`).join("")}
      </main>
    `;

    await expect(sendContentMessage({ type: "MANUAL_TRANSLATE_PAGE" })).resolves.toEqual({ ok: true });
    await waitForScheduledBatch();

    expect(translatedItems).toHaveLength(2);
    expect(translatedItems[0]).toHaveLength(10);
    expect(translatedItems[1].map((item) => item.text)).toEqual([
      "This paragraph number 11 should be translated.",
      "This paragraph number 12 should be translated.",
      "This paragraph number 13 should be translated.",
      "This paragraph number 14 should be translated.",
      "This paragraph number 15 should be translated.",
      "This paragraph number 16 should be translated."
    ]);
    expect(document.querySelectorAll("p")[0].textContent).toBe("vi:This paragraph number 1 should be translated.");
    expect(document.querySelectorAll("p")[15].textContent).toBe("vi:This paragraph number 16 should be translated.");
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

});
