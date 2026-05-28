import { collectVisibleTextNodes, createPageSample, type CollectedTextNode } from "./domText";
import { shouldAutoTranslate } from "../shared/translationDecision";
import type { ExtensionSettings, PageAnalysis, TabStatus, TextItem } from "../shared/types";

const originals = new Map<Text, string>();
const translatedNodes = new Set<Text>();
const MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST = 5;
let quickTranslateButton: HTMLButtonElement | null = null;
let quickTranslateMenu: HTMLDivElement | null = null;
let regionHighlight: HTMLDivElement | null = null;
let selectionButton: HTMLButtonElement | null = null;
let selectionPanel: HTMLDivElement | null = null;
let pageTranslationIndicator: HTMLDivElement | null = null;
let pageTranslationJob: Promise<void> | null = null;
let continuousObserver: MutationObserver | null = null;
let continuousTimer: number | null = null;
let continuousRoot: ParentNode = document.body;
let highlightedRegionElement: Element | null = null;
let pendingContinuousTranslation = false;

type BackgroundErrorResponse = {
  error: string;
};

function isBackgroundErrorResponse(value: unknown): value is BackgroundErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Extension context invalidated");
}

function logContentDebug(message: string, data?: unknown): void {
  console.debug(`[Translate AI][content] ${message}`, data ?? "");
}

async function sendMessage<T>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (isBackgroundErrorResponse(response)) {
    throw new Error(response.error);
  }
  return response as T;
}

async function setTabStatus(status: TabStatus): Promise<void> {
  await sendMessage({ type: "SET_TAB_STATUS", status });
}

function rememberOriginals(items: CollectedTextNode[]): void {
  for (const item of items) {
    if (!originals.has(item.node)) {
      originals.set(item.node, item.node.textContent ?? "");
    }
  }
}

function replaceTextPreservingBoundaryWhitespace(node: Text, translated: string): void {
  const currentText = node.textContent ?? "";
  const leadingWhitespace = currentText.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = currentText.match(/\s*$/)?.[0] ?? "";
  node.textContent = `${leadingWhitespace}${translated.trim()}${trailingWhitespace}`;
}

function replaceNodeTranslation(node: Text, translated: string): void {
  replaceTextPreservingBoundaryWhitespace(node, translated);
  translatedNodes.add(node);
}

function shouldTranslatePage(settings: ExtensionSettings, analysis: PageAnalysis, force: boolean): boolean {
  if (force) return analysis.isForeign && analysis.shouldTranslate;
  return shouldAutoTranslate(settings, analysis);
}

function hidePageTranslationIndicator(): void {
  pageTranslationIndicator?.remove();
  pageTranslationIndicator = null;
}

function showPageTranslationIndicator(message = "Preparing translation..."): void {
  if (pageTranslationIndicator && !pageTranslationIndicator.isConnected) {
    pageTranslationIndicator = null;
  }

  if (pageTranslationIndicator) {
    const label = pageTranslationIndicator.querySelector<HTMLSpanElement>("[data-translate-ai-progress-label='true']");
      if (label) label.textContent = message;
    return;
  }

  pageTranslationIndicator = document.createElement("div");
  pageTranslationIndicator.dataset.translateAiPageIndicator = "true";
  pageTranslationIndicator.dataset.translateAiUi = "true";
  const label = document.createElement("span");
  label.dataset.translateAiProgressLabel = "true";
  label.textContent = message;
  const progressTrack = document.createElement("span");
  progressTrack.dataset.translateAiProgress = "true";
  const progressBar = document.createElement("span");
  Object.assign(progressTrack.style, {
    display: "block",
    width: "160px",
    height: "3px",
    marginTop: "8px",
    overflow: "hidden",
    borderRadius: "999px",
    background: "rgba(255, 255, 255, 0.28)"
  });
  Object.assign(progressBar.style, {
    display: "block",
    width: "55%",
    height: "100%",
    borderRadius: "999px",
    background: "#60a5fa",
    animation: "translate-ai-progress 1s ease-in-out infinite alternate"
  });
  progressTrack.append(progressBar);
  pageTranslationIndicator.append(label, progressTrack);
  Object.assign(pageTranslationIndicator.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    padding: "10px 14px",
    borderRadius: "999px",
    background: "#111827",
    color: "#ffffff",
    fontSize: "13px",
    fontWeight: "600",
    lineHeight: "1",
    zIndex: "2147483647",
    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.24)",
    pointerEvents: "none"
  });
  const style = document.createElement("style");
  style.dataset.translateAiUi = "true";
  style.textContent = "@keyframes translate-ai-progress { from { transform: translateX(-45%); } to { transform: translateX(125%); } }";
  pageTranslationIndicator.append(style);
  document.body.append(pageTranslationIndicator);
}

function collectUntranslatedTextNodes(root: ParentNode): CollectedTextNode[] {
  return collectVisibleTextNodes(root).filter((item) => !translatedNodes.has(item.node));
}

function chunkCollectedTextNodes(items: CollectedTextNode[], maxItems: number): CollectedTextNode[][] {
  const chunks: CollectedTextNode[][] = [];
  for (let index = 0; index < items.length; index += maxItems) {
    chunks.push(items.slice(index, index + maxItems));
  }
  return chunks;
}

function waitForNextTranslationBatch(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function resolveRootWithText(root: ParentNode): ParentNode {
  if (collectUntranslatedTextNodes(root).length > 0) {
    return root;
  }

  let current = root instanceof Element ? root.parentElement : null;
  while (current && current !== document.documentElement) {
    if (collectUntranslatedTextNodes(current).length > 0) {
      return current;
    }
    current = current.parentElement;
  }

  return root;
}

async function translatePage({ force = false, root = document.body }: { force?: boolean; root?: ParentNode } = {}): Promise<void> {
  showPageTranslationIndicator("Collecting text...");
  const settings = await sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  const translationRoot = force ? resolveRootWithText(root) : root;
  const nodes = collectUntranslatedTextNodes(translationRoot);
  const sample = createPageSample(nodes);
  logContentDebug("translate:collect", {
    force,
    requestedRoot: root instanceof Element ? describeElement(root) : "document",
    translationRoot: translationRoot instanceof Element ? describeElement(translationRoot) : "document",
    nodeCount: nodes.length,
    sampleChars: sample.length,
    provider: settings.apiProvider,
    model: settings.openaiModel,
    baseUrl: settings.openaiBaseUrl
  });

  if (!sample) {
    logContentDebug("translate:skip", { reason: "no-text" });
    await setTabStatus({ status: "not-needed", message: "No text to translate" });
    hidePageTranslationIndicator();
    return;
  }

  if (!force && sample.length < 40) {
    logContentDebug("translate:skip", { reason: "sample-too-short", sampleChars: sample.length });
    await setTabStatus({ status: "not-needed", message: "Not enough text to detect" });
    hidePageTranslationIndicator();
    return;
  }

  if (!force) {
    showPageTranslationIndicator(`Analyzing ${nodes.length} text blocks...`);
    const analysis = await sendMessage<PageAnalysis>({ type: "ANALYZE_PAGE", sample });
    if (!shouldTranslatePage(settings, analysis, force)) {
      hidePageTranslationIndicator();
      return;
    }
  }

  rememberOriginals(nodes);
  try {
    const chunks = chunkCollectedTextNodes(nodes, MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      showPageTranslationIndicator(`Translating ${index + 1}/${chunks.length} (${chunk.length} blocks)...`);
      logContentDebug("translate:send", {
        batchIndex: index + 1,
        batchCount: chunks.length,
        nodeCount: chunk.length,
        totalChars: chunk.reduce((sum, item) => sum + item.text.length, 0)
      });
      const response = await sendMessage<{ items: TextItem[] }>({
        type: "TRANSLATE_ITEMS",
        items: chunk.map(({ id, text }) => ({ id, text }))
      });
      logContentDebug("translate:response", {
        batchIndex: index + 1,
        batchCount: chunks.length,
        itemCount: response.items.length
      });
      const translatedById = new Map(response.items.map((item) => [item.id, item.text]));
      for (const item of chunk) {
        const translated = translatedById.get(item.id);
        if (translated !== undefined) replaceNodeTranslation(item.node, translated);
      }
      if (index < chunks.length - 1) {
        await waitForNextTranslationBatch();
      }
    }
  } finally {
    logContentDebug("translate:done");
    hidePageTranslationIndicator();
  }
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes = typeof element.className === "string" && element.className.trim()
    ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
    : "";
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

function updateQuickTranslateButtonState(): void {
  if (!quickTranslateButton) return;
  renderQuickTranslateIcon(continuousObserver ? "pause" : "translate");
  quickTranslateButton.title = continuousObserver ? "Dừng dịch liên tục" : "Translate page";
  quickTranslateButton.dataset.translateAiQuickState = continuousObserver ? "pause" : "translate";
  Object.assign(quickTranslateButton.style, continuousObserver ? {
    background: "#334155",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.16) inset"
  } : {
    background: "#2563eb",
    boxShadow: "0 12px 30px rgba(37, 99, 235, 0.34), 0 0 0 1px rgba(255, 255, 255, 0.18) inset"
  });
}

function renderQuickTranslateIcon(icon: "translate" | "pause"): void {
  if (!quickTranslateButton) return;
  quickTranslateButton.replaceChildren();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.dataset.translateAiIcon = icon;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  Object.assign(svg.style, {
    display: "block",
    flex: "0 0 auto"
  });

  if (icon === "pause") {
    for (const x of ["8", "14"]) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", "6");
      rect.setAttribute("width", "3.2");
      rect.setAttribute("height", "12");
      rect.setAttribute("rx", "1.3");
      rect.setAttribute("fill", "currentColor");
      rect.setAttribute("stroke", "none");
      svg.append(rect);
    }
  } else {
    const paths = [
      "M4.5 5.5h8.8",
      "M8.9 3.5v2",
      "M11.8 5.5c-.6 3.1-2.7 5.7-6.3 7.8",
      "M5.9 8.5c1.2 1.8 2.9 3.3 5.1 4.5",
      "M14.1 18.5l3.2-8 3.2 8",
      "M15.3 15.5h4"
    ];
    for (const pathData of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData);
      svg.append(path);
    }
  }

  quickTranslateButton.append(svg);
}

function startPageTranslation(options: { force?: boolean; root?: ParentNode } = {}): void {
  if (pageTranslationJob) {
    if (continuousObserver) {
      pendingContinuousTranslation = true;
    }
    logContentDebug("translate:ignored", { reason: "job-already-running" });
    return;
  }
  hideQuickTranslateMenu();
  quickTranslateButton?.setAttribute("disabled", "true");
  if (quickTranslateButton) quickTranslateButton.style.display = "none";
  pageTranslationJob = translatePage(options)
    .catch(async (error) => {
      if (isExtensionContextInvalidated(error)) {
        hidePageTranslationIndicator();
        return;
      }
      try {
        await setTabStatus({ status: "error", message: getErrorMessage(error) });
      } catch {
        hidePageTranslationIndicator();
      }
    })
    .finally(() => {
      pageTranslationJob = null;
      quickTranslateButton?.removeAttribute("disabled");
      if (quickTranslateButton) quickTranslateButton.style.display = "";
      updateQuickTranslateButtonState();
      if (pendingContinuousTranslation && continuousObserver) {
        pendingContinuousTranslation = false;
        logContentDebug("translate:pending-run", {
          root: continuousRoot instanceof Element ? describeElement(continuousRoot) : "document"
        });
        window.setTimeout(() => startPageTranslation({ force: true, root: continuousRoot }), 0);
      }
    });
}

function scheduleContinuousTranslation(): void {
  if (continuousTimer !== null) {
    window.clearTimeout(continuousTimer);
  }
  continuousTimer = window.setTimeout(() => {
    continuousTimer = null;
    if (pageTranslationJob) {
      pendingContinuousTranslation = true;
      logContentDebug("watch:pending", { reason: "job-running" });
      return;
    }
    startPageTranslation({ force: true, root: continuousRoot });
  }, 600);
}

function stopContinuousTranslation(): void {
  continuousObserver?.disconnect();
  continuousObserver = null;
  continuousRoot = document.body;
  if (continuousTimer !== null) {
    window.clearTimeout(continuousTimer);
    continuousTimer = null;
  }
  pendingContinuousTranslation = false;
  updateQuickTranslateButtonState();
}

function startContinuousTranslation(root: ParentNode = document.body): void {
  hideQuickTranslateMenu();
  stopContinuousTranslation();

  continuousRoot = root;
  logContentDebug("watch:start", {
    root: root instanceof Element ? describeElement(root) : "document"
  });
  continuousObserver = new MutationObserver(scheduleContinuousTranslation);
  continuousObserver.observe(root, { childList: true, subtree: true });
  updateQuickTranslateButtonState();
  startPageTranslation({ force: true, root });
}

function toggleContinuousTranslation(): void {
  if (continuousObserver) {
    stopContinuousTranslation();
    return;
  }
  startContinuousTranslation(document.body);
}

function startRegionPick(): void {
  hideQuickTranslateMenu();
  showPageTranslationIndicator("Click vùng cần dịch...");
  showRegionHighlight();
  const updateHighlight = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("[data-translate-ai-ui='true']")) return;
    const region = resolveTranslationRegion(target);
    if (!region) return;
    highlightedRegionElement = region;
    updateRegionHighlight(region);
  };
  const handlePick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("[data-translate-ai-ui='true']")) return;
    const region = highlightedRegionElement ?? resolveTranslationRegion(target);
    if (!region) return;
    event.preventDefault();
    event.stopPropagation();
    document.removeEventListener("click", handlePick, true);
    document.removeEventListener("mouseover", updateHighlight, true);
    highlightedRegionElement = null;
    hideRegionHighlight();
    hidePageTranslationIndicator();
    logContentDebug("region:picked", { root: describeElement(region) });
    startContinuousTranslation(region);
  };
  document.addEventListener("mouseover", updateHighlight, true);
  document.addEventListener("click", handlePick, true);
}

function resolveTranslationRegion(element: Element): Element | null {
  let current: Element | null = element;
  let fallback: Element | null = null;

  while (current && current !== document.documentElement) {
    if (current.closest("[data-translate-ai-ui='true']")) return null;
    if (collectUntranslatedTextNodes(current).length > 0) {
      fallback = current;
    }
    if (fallback && isRegionContainer(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return fallback;
}

function isRegionContainer(element: Element): boolean {
  if (["ARTICLE", "ASIDE", "SECTION", "MAIN", "NAV", "HEADER", "FOOTER", "DIV", "LI", "TD", "TH", "P", "BLOCKQUOTE"].includes(element.tagName)) {
    return true;
  }

  const style = window.getComputedStyle(element);
  return ["block", "flex", "grid", "list-item", "table", "table-cell"].includes(style.display);
}

function showRegionHighlight(): void {
  if (regionHighlight?.isConnected) return;
  regionHighlight = document.createElement("div");
  regionHighlight.dataset.translateAiUi = "true";
  regionHighlight.dataset.translateAiRegionHighlight = "true";
  Object.assign(regionHighlight.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    border: "2px solid #2563eb",
    background: "rgba(37, 99, 235, 0.12)",
    pointerEvents: "none",
    zIndex: "2147483646"
  });
  document.body.append(regionHighlight);
}

function updateRegionHighlight(element: Element): void {
  showRegionHighlight();
  const rect = element.getBoundingClientRect();
  Object.assign(regionHighlight!.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  });
}

function hideRegionHighlight(): void {
  regionHighlight?.remove();
  regionHighlight = null;
  highlightedRegionElement = null;
}

async function restoreOriginals(): Promise<void> {
  for (const [node, text] of originals) {
    node.textContent = text;
  }
  translatedNodes.clear();
  stopContinuousTranslation();
  await setTabStatus({ status: "restored" });
}

function showQuickTranslateButton(): void {
  if (quickTranslateButton?.isConnected) return;

  quickTranslateButton = document.createElement("button");
  quickTranslateButton.dataset.translateAiUi = "true";
  quickTranslateButton.dataset.translateAiQuickAction = "true";
  quickTranslateButton.type = "button";
  quickTranslateButton.title = "Translate page";
  Object.assign(quickTranslateButton.style, {
    alignItems: "center",
    justifyContent: "center",
    display: "flex",
    position: "fixed",
    right: "16px",
    bottom: "16px",
    width: "48px",
    height: "48px",
    border: "0",
    borderRadius: "999px",
    background: "#2563eb",
    color: "#ffffff",
    cursor: "pointer",
    zIndex: "2147483647",
    padding: "0",
    transition: "background 160ms ease, box-shadow 160ms ease, transform 160ms ease",
    boxShadow: "0 12px 30px rgba(37, 99, 235, 0.34), 0 0 0 1px rgba(255, 255, 255, 0.18) inset"
  });
  quickTranslateButton.addEventListener("mouseenter", () => {
    quickTranslateButton!.style.transform = "translateY(-1px)";
  });
  quickTranslateButton.addEventListener("mouseleave", () => {
    quickTranslateButton!.style.transform = "";
  });
  quickTranslateButton.addEventListener("click", () => {
    if (continuousObserver) {
      stopContinuousTranslation();
      return;
    }
    toggleQuickTranslateMenu();
  });
  document.body.append(quickTranslateButton);
  updateQuickTranslateButtonState();
}

function hideQuickTranslateMenu(): void {
  quickTranslateMenu?.remove();
  quickTranslateMenu = null;
}

function createMenuButton(label: string, action: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.translateAiMenuAction = action;
  button.textContent = label;
  Object.assign(button.style, {
    display: "block",
    width: "100%",
    border: "0",
    padding: "9px 10px",
    background: "transparent",
    color: "#111827",
    fontSize: "13px",
    fontWeight: "600",
    textAlign: "left",
    cursor: "pointer"
  });
  button.addEventListener("click", onClick);
  return button;
}

function toggleQuickTranslateMenu(): void {
  if (quickTranslateMenu?.isConnected) {
    hideQuickTranslateMenu();
    return;
  }

  quickTranslateMenu = document.createElement("div");
  quickTranslateMenu.dataset.translateAiUi = "true";
  quickTranslateMenu.dataset.translateAiQuickMenu = "true";
  Object.assign(quickTranslateMenu.style, {
    position: "fixed",
    right: "16px",
    bottom: "64px",
    minWidth: "190px",
    overflow: "hidden",
    borderRadius: "8px",
    background: "#ffffff",
    boxShadow: "0 14px 34px rgba(15, 23, 42, 0.22)",
    zIndex: "2147483647"
  });
  quickTranslateMenu.append(
    createMenuButton("Dịch phần mới", "translate-new", () => startPageTranslation({ force: true })),
    createMenuButton(continuousObserver ? "Dừng dịch liên tục" : "Dịch liên tục toàn trang", "watch-page", toggleContinuousTranslation),
    createMenuButton("Chọn vùng để dịch", "pick-region", startRegionPick)
  );
  document.body.append(quickTranslateMenu);
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
  selectionPanel.dataset.translateAiSelectionPanel = "true";
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

function replaceSelectionRange(range: Range, translated: string): void {
  range.deleteContents();
  range.insertNode(document.createTextNode(translated));
  window.getSelection()?.removeAllRanges();
  removeSelectionUi();
}

function showSelectionButton(): void {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();
  removeSelectionUi();
  if (!selectedText || !selection || selection.rangeCount === 0) return;

  const selectedRange = selection.getRangeAt(0).cloneRange();

  selectionButton = document.createElement("button");
  selectionButton.dataset.translateAiUi = "true";
  selectionButton.type = "button";
  selectionButton.textContent = "Translate";
  Object.assign(selectionButton.style, {
    position: "fixed",
    right: "16px",
    bottom: "64px",
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
    try {
      const result = await sendMessage<{ text: string }>({ type: "TRANSLATE_SELECTION", text: selectedText });
      replaceSelectionRange(selectedRange, result.text);
    } catch (error) {
      showSelectionPanel(getErrorMessage(error));
    }
  });

  document.body.append(selectionButton);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MANUAL_TRANSLATE_PAGE") {
    startPageTranslation({ force: true });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "RESTORE_ORIGINALS") {
    restoreOriginals()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: getErrorMessage(error) }));
    return true;
  }
  return false;
});

document.addEventListener("selectionchange", () => window.setTimeout(showSelectionButton, 120));
document.addEventListener("DOMContentLoaded", showQuickTranslateButton);
window.addEventListener("pagehide", stopContinuousTranslation);
showQuickTranslateButton();
