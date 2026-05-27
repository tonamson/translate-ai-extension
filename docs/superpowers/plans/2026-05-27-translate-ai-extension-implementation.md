# Translate AI Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vite + TypeScript Chrome Manifest V3 extension that auto-translates foreign-language pages into the configured target language through local Ollama, with a compact popup and selected-text translation overlay.

**Architecture:** The extension has a typed service worker as the only Ollama API caller, a framework-free content script that extracts and mutates visible text nodes, and a plain TypeScript popup that controls settings and status. Shared modules hold message contracts, settings, chunking, Ollama JSON parsing, and translation-decision logic so core behavior is unit tested with Vitest.

**Tech Stack:** Chrome Manifest V3, Vite, TypeScript, Vitest, jsdom, plain HTML/CSS, Ollama local HTTP API.

---

## File Structure

- `package.json`: npm scripts and dev dependencies.
- `tsconfig.json`: strict TypeScript settings.
- `vite.config.ts`: multi-entry Vite build for popup, service worker, and content script.
- `vitest.config.ts`: Vitest config with jsdom.
- `public/manifest.json`: Chrome MV3 manifest copied to `dist`.
- `src/shared/types.ts`: shared settings, page status, messages, Ollama response types.
- `src/shared/settings.ts`: default settings and storage helpers.
- `src/shared/chunking.ts`: ordered text chunking.
- `src/shared/ollama.ts`: prompts, fetch client, JSON parsing helpers.
- `src/shared/translationDecision.ts`: auto-translation decision rules.
- `src/content/domText.ts`: visible text-node collection and filtering.
- `src/content/index.ts`: page lifecycle, auto translation, restore, selection overlay.
- `src/background/index.ts`: Chrome message routing, tab status, Ollama calls.
- `src/popup/index.html`: popup markup.
- `src/popup/main.ts`: popup behavior and Chrome messaging.
- `src/popup/styles.css`: compact professional popup styling.
- `src/test/*.test.ts`: unit tests for shared logic and DOM filtering.

---

### Task 1: Project Scaffold And Build Wiring

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `public/manifest.json`
- Create: `src/popup/index.html`
- Create: `src/popup/main.ts`
- Create: `src/popup/styles.css`
- Create: `src/background/index.ts`
- Create: `src/content/index.ts`

- [ ] **Step 1: Create npm/Vite/TypeScript config**

Create `package.json`:

```json
{
  "name": "translate-ai-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.268",
    "@vitejs/plugin-legacy": "^5.4.2",
    "jsdom": "^24.1.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["chrome", "vitest/globals"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true
  }
});
```

- [ ] **Step 2: Create MV3 manifest and minimal entry files**

Create `public/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Local AI Page Translator",
  "description": "Translate web pages with a local Ollama model.",
  "version": "0.1.0",
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": ["http://localhost:11434/*", "http://127.0.0.1:11434/*"],
  "action": {
    "default_title": "Local AI Translator",
    "default_popup": "src/popup/index.html"
  },
  "background": {
    "service_worker": "assets/background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["assets/content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

Create minimal entry files:

```html
<!-- src/popup/index.html -->
<div id="app">Local AI Translator</div>
<script type="module" src="./main.ts"></script>
```

```ts
// src/popup/main.ts
import "./styles.css";
```

```css
/* src/popup/styles.css */
body {
  margin: 0;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

```ts
// src/background/index.ts
chrome.runtime.onInstalled.addListener(() => undefined);
```

```ts
// src/content/index.ts
export {};
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`

Expected: `package-lock.json` is created and dependencies install without errors.

- [ ] **Step 4: Verify build and typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

Run: `npm run build`

Expected: `dist/manifest.json`, `dist/assets/background.js`, `dist/assets/content.js`, and popup assets exist.

- [ ] **Step 5: Commit scaffold**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts public src
git commit -m "chore: scaffold chrome extension"
```

---

### Task 2: Shared Types, Settings, Chunking, And Decisions

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/settings.ts`
- Create: `src/shared/chunking.ts`
- Create: `src/shared/translationDecision.ts`
- Create: `src/test/chunking.test.ts`
- Create: `src/test/translationDecision.test.ts`

- [ ] **Step 1: Write failing tests for chunking**

Create `src/test/chunking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkTextItems } from "../shared/chunking";

describe("chunkTextItems", () => {
  it("keeps item order while respecting max characters", () => {
    const chunks = chunkTextItems(
      [
        { id: "a", text: "hello" },
        { id: "b", text: "world" },
        { id: "c", text: "again" }
      ],
      11
    );

    expect(chunks).toEqual([
      [{ id: "a", text: "hello" }],
      [{ id: "b", text: "world" }],
      [{ id: "c", text: "again" }]
    ]);
  });

  it("keeps oversized single items instead of dropping them", () => {
    const chunks = chunkTextItems([{ id: "a", text: "long text value" }], 4);
    expect(chunks).toEqual([[{ id: "a", text: "long text value" }]]);
  });
});
```

- [ ] **Step 2: Run chunking test to verify it fails**

Run: `npm test -- src/test/chunking.test.ts`

Expected: FAIL because `../shared/chunking` does not exist.

- [ ] **Step 3: Implement shared types and chunking**

Create `src/shared/types.ts`:

```ts
export type TranslationStatus =
  | "idle"
  | "detecting"
  | "not-needed"
  | "translating"
  | "translated"
  | "restored"
  | "error";

export type TextItem = {
  id: string;
  text: string;
};

export type ExtensionSettings = {
  targetLanguage: string;
  autoTranslate: boolean;
  ollamaEndpoint: string;
  ollamaModel: string;
};

export type PageAnalysis = {
  detectedLanguage: string;
  confidence: number;
  isForeign: boolean;
  shouldTranslate: boolean;
  reason: string;
};

export type TabStatus = {
  status: TranslationStatus;
  detectedLanguage?: string;
  message?: string;
  progress?: {
    done: number;
    total: number;
  };
};
```

Create `src/shared/chunking.ts`:

```ts
import type { TextItem } from "./types";

export function chunkTextItems(items: TextItem[], maxChars: number): TextItem[][] {
  const chunks: TextItem[][] = [];
  let current: TextItem[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    const nextChars = currentChars + itemChars;

    if (current.length > 0 && nextChars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
```

- [ ] **Step 4: Write failing tests for translation decision**

Create `src/test/translationDecision.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldAutoTranslate } from "../shared/translationDecision";

describe("shouldAutoTranslate", () => {
  it("translates only when auto mode is enabled and analysis says translation is needed", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: true, targetLanguage: "Vietnamese", ollamaEndpoint: "http://localhost:11434", ollamaModel: "llama3.1" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: true, reason: "foreign page" }
      )
    ).toBe(true);
  });

  it("does not translate when auto mode is disabled", () => {
    expect(
      shouldAutoTranslate(
        { autoTranslate: false, targetLanguage: "Vietnamese", ollamaEndpoint: "http://localhost:11434", ollamaModel: "llama3.1" },
        { detectedLanguage: "English", confidence: 0.9, isForeign: true, shouldTranslate: true, reason: "foreign page" }
      )
    ).toBe(false);
  });
});
```

- [ ] **Step 5: Run decision test to verify it fails**

Run: `npm test -- src/test/translationDecision.test.ts`

Expected: FAIL because `../shared/translationDecision` does not exist.

- [ ] **Step 6: Implement settings and decision logic**

Create `src/shared/settings.ts`:

```ts
import type { ExtensionSettings } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  targetLanguage: "Vietnamese",
  autoTranslate: true,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3.1"
};

const SETTINGS_KEY = "translateAiSettings";

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}
```

Create `src/shared/translationDecision.ts`:

```ts
import type { ExtensionSettings, PageAnalysis } from "./types";

export function shouldAutoTranslate(settings: ExtensionSettings, analysis: PageAnalysis): boolean {
  return settings.autoTranslate && analysis.isForeign && analysis.shouldTranslate;
}
```

- [ ] **Step 7: Verify tests pass**

Run: `npm test -- src/test/chunking.test.ts src/test/translationDecision.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit shared foundation**

```bash
git add src/shared src/test
git commit -m "feat: add shared translation logic"
```

---

### Task 3: Ollama Client And JSON Parsing

**Files:**
- Create: `src/shared/ollama.ts`
- Create: `src/test/ollama.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `src/test/ollama.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseJsonObjectFromModelText } from "../shared/ollama";

describe("parseJsonObjectFromModelText", () => {
  it("parses direct JSON", () => {
    expect(parseJsonObjectFromModelText<{ ok: boolean }>("{\"ok\":true}")).toEqual({ ok: true });
  });

  it("parses JSON wrapped in extra text", () => {
    expect(parseJsonObjectFromModelText<{ ok: boolean }>("result: {\"ok\":true} done")).toEqual({ ok: true });
  });

  it("throws for malformed text", () => {
    expect(() => parseJsonObjectFromModelText("no json")).toThrow("Model response did not contain a JSON object");
  });
});
```

- [ ] **Step 2: Run parser test to verify it fails**

Run: `npm test -- src/test/ollama.test.ts`

Expected: FAIL because `../shared/ollama` does not exist.

- [ ] **Step 3: Implement Ollama helpers**

Create `src/shared/ollama.ts`:

```ts
import type { ExtensionSettings, PageAnalysis, TextItem } from "./types";

type OllamaGenerateResponse = {
  response?: string;
};

export function parseJsonObjectFromModelText<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object");
  }

  return JSON.parse(text.slice(start, end + 1)) as T;
}

async function generateJson(settings: ExtensionSettings, prompt: string): Promise<unknown> {
  const response = await fetch(`${settings.ollamaEndpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.ollamaModel,
      prompt,
      stream: false,
      format: "json"
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  if (!data.response) {
    throw new Error("Ollama response was empty");
  }

  return parseJsonObjectFromModelText(data.response);
}

export async function analyzeLanguage(settings: ExtensionSettings, sample: string): Promise<PageAnalysis> {
  const prompt = [
    "Detect the language of this web page sample.",
    `Target language: ${settings.targetLanguage}.`,
    "Return only JSON with keys: detectedLanguage, confidence, isForeign, shouldTranslate, reason.",
    "Translate only when the page is not already in the target language.",
    `Sample:\n${sample}`
  ].join("\n");

  return (await generateJson(settings, prompt)) as PageAnalysis;
}

export async function translateItems(settings: ExtensionSettings, items: TextItem[]): Promise<TextItem[]> {
  const prompt = [
    `Translate each text item to ${settings.targetLanguage}.`,
    "Preserve meaning and tone. Return only JSON: {\"items\":[{\"id\":\"...\",\"text\":\"...\"}]}",
    `Items:\n${JSON.stringify({ items })}`
  ].join("\n");

  const result = (await generateJson(settings, prompt)) as { items: TextItem[] };
  return result.items;
}

export async function translateSelection(settings: ExtensionSettings, text: string): Promise<string> {
  const prompt = [
    `Translate this text to ${settings.targetLanguage}.`,
    "Return only JSON: {\"text\":\"translated text\"}",
    `Text:\n${text}`
  ].join("\n");

  const result = (await generateJson(settings, prompt)) as { text: string };
  return result.text;
}
```

- [ ] **Step 4: Verify parser tests pass**

Run: `npm test -- src/test/ollama.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Ollama client**

```bash
git add src/shared/ollama.ts src/test/ollama.test.ts
git commit -m "feat: add ollama client helpers"
```

---

### Task 4: DOM Text Collection And Filtering

**Files:**
- Create: `src/content/domText.ts`
- Create: `src/test/domText.test.ts`

- [ ] **Step 1: Write failing DOM filtering tests**

Create `src/test/domText.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectVisibleTextNodes } from "../content/domText";

describe("collectVisibleTextNodes", () => {
  it("collects visible body text and skips scripts, styles, inputs, and extension UI", () => {
    document.body.innerHTML = `
      <main>
        <p>Hello world</p>
        <script>ignored()</script>
        <style>.x { color: red; }</style>
        <input value="ignored">
        <div data-translate-ai-ui="true">ignored overlay</div>
      </main>
    `;

    const items = collectVisibleTextNodes(document.body);
    expect(items.map((item) => item.text)).toEqual(["Hello world"]);
  });
});
```

- [ ] **Step 2: Run DOM test to verify it fails**

Run: `npm test -- src/test/domText.test.ts`

Expected: FAIL because `../content/domText` does not exist.

- [ ] **Step 3: Implement DOM text collection**

Create `src/content/domText.ts`:

```ts
import type { TextItem } from "../shared/types";

export type CollectedTextNode = TextItem & {
  node: Text;
};

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);

function shouldSkipElement(element: Element): boolean {
  if (element.closest("[data-translate-ai-ui='true']")) return true;
  if (SKIP_TAGS.has(element.tagName)) return true;

  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

export function collectVisibleTextNodes(root: ParentNode = document.body): CollectedTextNode[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      const parent = node.parentElement;

      if (!text || !parent || shouldSkipElement(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const items: CollectedTextNode[] = [];
  let index = 0;
  let current = walker.nextNode();

  while (current) {
    const node = current as Text;
    items.push({
      id: `text-${index}`,
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      node
    });
    index += 1;
    current = walker.nextNode();
  }

  return items;
}

export function createPageSample(items: TextItem[], maxChars = 4000): string {
  return items.map((item) => item.text).join("\n").slice(0, maxChars);
}
```

- [ ] **Step 4: Verify DOM tests pass**

Run: `npm test -- src/test/domText.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit DOM collection**

```bash
git add src/content/domText.ts src/test/domText.test.ts
git commit -m "feat: collect visible page text"
```

---

### Task 5: Background Message Router

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/background/index.ts`

- [ ] **Step 1: Extend message contracts**

Modify `src/shared/types.ts` to add:

```ts
export type RuntimeMessage =
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings }
  | { type: "GET_TAB_STATUS"; tabId: number }
  | { type: "ANALYZE_PAGE"; sample: string }
  | { type: "TRANSLATE_ITEMS"; items: TextItem[] }
  | { type: "TRANSLATE_SELECTION"; text: string }
  | { type: "SET_TAB_STATUS"; tabId: number; status: TabStatus };
```

- [ ] **Step 2: Implement service worker routing**

Replace `src/background/index.ts` with:

```ts
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
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit background routing**

```bash
git add src/shared/types.ts src/background/index.ts
git commit -m "feat: route translation messages"
```

---

### Task 6: Content Script Page Translation And Selection Overlay

**Files:**
- Modify: `src/content/index.ts`

- [ ] **Step 1: Implement content script**

Replace `src/content/index.ts` with:

```ts
import { collectVisibleTextNodes, createPageSample, type CollectedTextNode } from "./domText";
import { shouldAutoTranslate } from "../shared/translationDecision";
import type { ExtensionSettings, PageAnalysis, TextItem } from "../shared/types";

const originals = new Map<string, { node: Text; text: string }>();
let selectionButton: HTMLButtonElement | null = null;
let selectionPanel: HTMLDivElement | null = null;

function sendMessage<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function rememberOriginals(items: CollectedTextNode[]): void {
  for (const item of items) {
    if (!originals.has(item.id)) {
      originals.set(item.id, { node: item.node, text: item.node.textContent ?? "" });
    }
  }
}

async function translatePage(): Promise<void> {
  const settings = await sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  const nodes = collectVisibleTextNodes();
  const sample = createPageSample(nodes);

  if (sample.length < 40) return;

  const analysis = await sendMessage<PageAnalysis>({ type: "ANALYZE_PAGE", sample });
  if (!shouldAutoTranslate(settings, analysis)) return;

  rememberOriginals(nodes);
  const response = await sendMessage<{ items: TextItem[] }>({
    type: "TRANSLATE_ITEMS",
    items: nodes.map(({ id, text }) => ({ id, text }))
  });

  const translatedById = new Map(response.items.map((item) => [item.id, item.text]));
  for (const item of nodes) {
    const translated = translatedById.get(item.id);
    if (translated) item.node.textContent = translated;
  }
}

function restoreOriginals(): void {
  for (const original of originals.values()) {
    original.node.textContent = original.text;
  }
}

function removeSelectionUi(): void {
  selectionButton?.remove();
  selectionPanel?.remove();
  selectionButton = null;
  selectionPanel = null;
}

function showSelectionPanel(text: string): void {
  selectionPanel?.remove();
  selectionPanel = document.createElement("div");
  selectionPanel.dataset.translateAiUi = "true";
  selectionPanel.textContent = text;
  Object.assign(selectionPanel.style, {
    position: "fixed",
    right: "16px",
    bottom: "64px",
    maxWidth: "360px",
    padding: "12px",
    borderRadius: "8px",
    background: "#111827",
    color: "#ffffff",
    fontSize: "14px",
    lineHeight: "1.4",
    zIndex: "2147483647",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.24)"
  });
  document.body.append(selectionPanel);
}

function showSelectionButton(): void {
  const selectedText = window.getSelection()?.toString().trim();
  removeSelectionUi();
  if (!selectedText) return;

  selectionButton = document.createElement("button");
  selectionButton.dataset.translateAiUi = "true";
  selectionButton.type = "button";
  selectionButton.textContent = "Translate";
  Object.assign(selectionButton.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    padding: "9px 12px",
    border: "0",
    borderRadius: "999px",
    background: "#2563eb",
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    zIndex: "2147483647",
    boxShadow: "0 10px 24px rgba(37, 99, 235, 0.3)"
  });

  selectionButton.addEventListener("click", async () => {
    selectionButton!.textContent = "Translating...";
    const result = await sendMessage<{ text: string }>({ type: "TRANSLATE_SELECTION", text: selectedText });
    showSelectionPanel(result.text);
  });

  document.body.append(selectionButton);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MANUAL_TRANSLATE_PAGE") {
    translatePage().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "RESTORE_ORIGINALS") {
    restoreOriginals();
    sendResponse({ ok: true });
  }
  return false;
});

document.addEventListener("selectionchange", () => window.setTimeout(showSelectionButton, 120));
translatePage().catch(() => undefined);
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit content behavior**

```bash
git add src/content/index.ts
git commit -m "feat: translate pages from content script"
```

---

### Task 7: Popup UI And Settings

**Files:**
- Modify: `src/popup/index.html`
- Modify: `src/popup/main.ts`
- Modify: `src/popup/styles.css`

- [ ] **Step 1: Replace popup HTML**

Replace `src/popup/index.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local AI Translator</title>
  </head>
  <body>
    <main class="popup">
      <header class="header">
        <div>
          <h1>Local AI Translator</h1>
          <p id="statusText">Loading...</p>
        </div>
        <span id="statusDot" class="status-dot"></span>
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
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement popup TypeScript**

Replace `src/popup/main.ts` with:

```ts
import "./styles.css";
import type { ExtensionSettings, TabStatus } from "../shared/types";

const targetLanguage = document.querySelector<HTMLInputElement>("#targetLanguage")!;
const ollamaEndpoint = document.querySelector<HTMLInputElement>("#ollamaEndpoint")!;
const ollamaModel = document.querySelector<HTMLInputElement>("#ollamaModel")!;
const autoTranslate = document.querySelector<HTMLInputElement>("#autoTranslate")!;
const statusText = document.querySelector<HTMLParagraphElement>("#statusText")!;
const statusDot = document.querySelector<HTMLSpanElement>("#statusDot")!;
const saveButton = document.querySelector<HTMLButtonElement>("#saveButton")!;
const translateButton = document.querySelector<HTMLButtonElement>("#translateButton")!;
const restoreButton = document.querySelector<HTMLButtonElement>("#restoreButton")!;

function sendMessage<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function readForm(): ExtensionSettings {
  return {
    targetLanguage: targetLanguage.value.trim() || "Vietnamese",
    ollamaEndpoint: ollamaEndpoint.value.trim() || "http://localhost:11434",
    ollamaModel: ollamaModel.value.trim() || "llama3.1",
    autoTranslate: autoTranslate.checked
  };
}

function fillForm(settings: ExtensionSettings): void {
  targetLanguage.value = settings.targetLanguage;
  ollamaEndpoint.value = settings.ollamaEndpoint;
  ollamaModel.value = settings.ollamaModel;
  autoTranslate.checked = settings.autoTranslate;
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
  await sendMessage({ type: "SAVE_SETTINGS", settings: readForm() });
  statusText.textContent = "Settings saved";
});

translateButton.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_TRANSLATE_PAGE" });
  window.close();
});

restoreButton.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "RESTORE_ORIGINALS" });
  window.close();
});

refresh().catch((error) => {
  statusText.textContent = error instanceof Error ? error.message : String(error);
  statusDot.dataset.status = "error";
});
```

- [ ] **Step 3: Implement popup styling**

Replace `src/popup/styles.css` with:

```css
:root {
  color: #172033;
  background: #f7f8fb;
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  width: 340px;
  margin: 0;
}

.popup {
  display: grid;
  gap: 12px;
  padding: 16px;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

h1 {
  margin: 0;
  font-size: 16px;
  line-height: 1.25;
}

p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 12px;
}

label {
  display: grid;
  gap: 6px;
  color: #344054;
  font-size: 12px;
  font-weight: 600;
}

input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  border: 1px solid #d0d5dd;
  border-radius: 7px;
  padding: 0 10px;
  background: #ffffff;
  color: #172033;
}

.toggle {
  grid-template-columns: 18px 1fr;
  align-items: center;
  gap: 8px;
}

.toggle input {
  width: 16px;
  height: 16px;
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

button {
  height: 34px;
  border: 0;
  border-radius: 7px;
  background: #2563eb;
  color: #ffffff;
  font-weight: 700;
  cursor: pointer;
}

button:nth-child(3) {
  background: #475467;
}

.status-dot {
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 999px;
  background: #f59e0b;
}

.status-dot[data-status="translated"],
.status-dot[data-status="not-needed"] {
  background: #16a34a;
}

.status-dot[data-status="error"] {
  background: #dc2626;
}
```

- [ ] **Step 4: Verify typecheck and build**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit popup**

```bash
git add src/popup
git commit -m "feat: add translator popup"
```

---

### Task 8: Final Verification And Documentation

**Files:**
- Create: `README.md`
- Modify: implementation code if verification exposes defects.

- [ ] **Step 1: Create README**

Create `README.md`:

```md
# Local AI Page Translator

Chrome Manifest V3 extension for translating web pages with local Ollama.

## Requirements

- Node.js 20+
- Chrome or Chromium
- Ollama running locally
- The configured model installed, default `llama3.1`

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Load `dist/` as an unpacked extension in Chrome.

## Ollama

Default endpoint: `http://localhost:11434`

Default model: `llama3.1`

If Chrome cannot reach Ollama, start Ollama with an origin configuration that allows Chrome extension requests.
```

- [ ] **Step 2: Run full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run production build**

Run: `npm run build`

Expected: PASS and `dist/` contains the Chrome extension.

- [ ] **Step 5: Inspect git status**

Run: `git status --short`

Expected: only intended source changes and `README.md` are present before commit.

- [ ] **Step 6: Commit documentation and final verification fixes**

```bash
git add README.md
git commit -m "docs: add extension usage instructions"
```

## Self-Review

- Spec coverage: the plan implements Vite + TypeScript MV3, auto full-page translation, selected-text overlay, popup status/settings, Ollama local integration, error-preserving behavior, restore, and unit tests for core logic.
- Red-flag scan: no unfinished-work markers are intentionally present.
- Type consistency: settings, page analysis, text item, tab status, and runtime message names are defined in `src/shared/types.ts` and reused by content, background, popup, and tests.
