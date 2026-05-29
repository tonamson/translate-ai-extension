import { collectVisibleTextNodes, createPageSample, type CollectedTextNode } from "./domText";
import { shouldAutoTranslate } from "../shared/translationDecision";
import type { ExtensionSettings, PageAnalysis, TabStatus, TextItem } from "../shared/types";

const originals = new Map<Text, string>();
const translatedNodes = new Set<Text>();
const translatedTextByHash = new Map<string, { originalText: string; translatedText: string }>();
const pendingTranslationNodesByHash = new Map<string, Set<Text>>();
const MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST = 10;
const WATCH_SMALL_UPDATE_TEXT_BLOCK_LIMIT = 5;
const WATCH_SMALL_UPDATE_DELAY_MS = 250;
const WATCH_DEFAULT_UPDATE_DELAY_MS = 600;
const MANUAL_COLLECT_RETRY_LIMIT = 4;
const MANUAL_COLLECT_RETRY_DELAY_MS = 350;
const QUICK_BUTTON_POSITION_STORAGE_KEY = "translateAiQuickButtonPosition";
const QUICK_BUTTON_SIZE = 48;
const QUICK_BUTTON_MARGIN = 16;
let quickTranslateButton: HTMLButtonElement | null = null;
let quickTranslateMenu: HTMLDivElement | null = null;
let regionHighlight: HTMLDivElement | null = null;
let pageTranslationIndicator: HTMLDivElement | null = null;
let pageTranslationJob: Promise<void> | null = null;
let pendingPageTranslationTimer: number | null = null;
let continuousObserver: MutationObserver | null = null;
let continuousTimer: number | null = null;
let continuousRoot: ParentNode = document.body;
let highlightedRegionElement: Element | null = null;
let pendingContinuousTranslation = false;
let queuedTranslationHashes = new Set<string>();
let activeTranslationRunId = 0;
const canceledTranslationRunIds = new Set<number>();
let translationProgress = {
  active: false,
  completedBlocks: 0,
  totalBlocks: 0
};
let activeTranslationSettingsSignature = "";

type QuickButtonEdge = "left" | "right" | "top" | "bottom";

type QuickButtonPosition = {
  edge: QuickButtonEdge;
  offset: number;
};

type QuickButtonDragState = {
  pointerId: number;
  dragging: boolean;
};

let quickButtonPosition: QuickButtonPosition | null = null;
let quickButtonDragState: QuickButtonDragState | null = null;
let suppressQuickButtonClick = false;
let selectionBubble: HTMLDivElement | null = null;

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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getDefaultQuickButtonPosition(): QuickButtonPosition {
  return {
    edge: "right",
    offset: Math.max(QUICK_BUTTON_MARGIN, window.innerHeight - QUICK_BUTTON_SIZE - QUICK_BUTTON_MARGIN)
  };
}

function isQuickButtonPosition(value: unknown): value is QuickButtonPosition {
  if (typeof value !== "object" || value === null) return false;
  const position = value as Partial<QuickButtonPosition>;
  return (
    (position.edge === "left" || position.edge === "right" || position.edge === "top" || position.edge === "bottom") &&
    typeof position.offset === "number" &&
    Number.isFinite(position.offset)
  );
}

function applyQuickButtonPosition(position: QuickButtonPosition): void {
  if (!quickTranslateButton) return;

  const maxLeft = Math.max(QUICK_BUTTON_MARGIN, window.innerWidth - QUICK_BUTTON_SIZE - QUICK_BUTTON_MARGIN);
  const maxTop = Math.max(QUICK_BUTTON_MARGIN, window.innerHeight - QUICK_BUTTON_SIZE - QUICK_BUTTON_MARGIN);
  const offset = position.edge === "left" || position.edge === "right"
    ? clampNumber(position.offset, QUICK_BUTTON_MARGIN, maxTop)
    : clampNumber(position.offset, QUICK_BUTTON_MARGIN, maxLeft);

  Object.assign(quickTranslateButton.style, {
    left: "",
    right: "",
    top: "",
    bottom: ""
  });

  if (position.edge === "left") {
    quickTranslateButton.style.left = `${QUICK_BUTTON_MARGIN}px`;
    quickTranslateButton.style.top = `${offset}px`;
  } else if (position.edge === "right") {
    quickTranslateButton.style.right = `${QUICK_BUTTON_MARGIN}px`;
    quickTranslateButton.style.top = `${offset}px`;
  } else if (position.edge === "top") {
    quickTranslateButton.style.top = `${QUICK_BUTTON_MARGIN}px`;
    quickTranslateButton.style.left = `${offset}px`;
  } else {
    quickTranslateButton.style.bottom = `${QUICK_BUTTON_MARGIN}px`;
    quickTranslateButton.style.left = `${offset}px`;
  }
}

function saveQuickButtonPosition(position: QuickButtonPosition): void {
  quickButtonPosition = position;
  void chrome.storage.local.set({ [QUICK_BUTTON_POSITION_STORAGE_KEY]: position }).catch(() => undefined);
}

async function restoreQuickButtonPosition(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(QUICK_BUTTON_POSITION_STORAGE_KEY);
    const position = stored[QUICK_BUTTON_POSITION_STORAGE_KEY];
    if (isQuickButtonPosition(position)) {
      quickButtonPosition = position;
      applyQuickButtonPosition(position);
    }
  } catch {
    // Ignore storage failures; the button still works at the default position.
  }
}

function getQuickButtonDragPosition(event: PointerEvent): { left: number; top: number } {
  const maxLeft = Math.max(QUICK_BUTTON_MARGIN, window.innerWidth - QUICK_BUTTON_SIZE - QUICK_BUTTON_MARGIN);
  const maxTop = Math.max(QUICK_BUTTON_MARGIN, window.innerHeight - QUICK_BUTTON_SIZE - QUICK_BUTTON_MARGIN);
  return {
    left: clampNumber(event.clientX - QUICK_BUTTON_SIZE / 2, QUICK_BUTTON_MARGIN, maxLeft),
    top: clampNumber(event.clientY - QUICK_BUTTON_SIZE / 2, QUICK_BUTTON_MARGIN, maxTop)
  };
}

function moveQuickButtonTo(left: number, top: number): void {
  if (!quickTranslateButton) return;
  Object.assign(quickTranslateButton.style, {
    left: `${left}px`,
    top: `${top}px`,
    right: "",
    bottom: ""
  });
}

function getQuickButtonViewportBox(): { left: number; top: number; width: number; height: number } {
  if (!quickTranslateButton) {
    const fallback = getDefaultQuickButtonPosition();
    return {
      left: window.innerWidth - QUICK_BUTTON_SIZE - QUICK_BUTTON_MARGIN,
      top: fallback.offset,
      width: QUICK_BUTTON_SIZE,
      height: QUICK_BUTTON_SIZE
    };
  }

  const left = quickTranslateButton.style.left
    ? Number.parseFloat(quickTranslateButton.style.left)
    : window.innerWidth - Number.parseFloat(quickTranslateButton.style.right || `${QUICK_BUTTON_MARGIN}`) - QUICK_BUTTON_SIZE;
  const top = quickTranslateButton.style.top
    ? Number.parseFloat(quickTranslateButton.style.top)
    : window.innerHeight - Number.parseFloat(quickTranslateButton.style.bottom || `${QUICK_BUTTON_MARGIN}`) - QUICK_BUTTON_SIZE;

  return {
    left,
    top,
    width: QUICK_BUTTON_SIZE,
    height: QUICK_BUTTON_SIZE
  };
}

function positionFloatingElementNearQuickButton(element: HTMLElement, preferredWidth: number): void {
  const anchor = getQuickButtonViewportBox();
  const gap = 8;

  // Align menu's right edge to button's right edge, clamped to viewport
  const buttonRight = anchor.left + anchor.width;
  const left = clampNumber(
    buttonRight - preferredWidth,
    QUICK_BUTTON_MARGIN,
    Math.max(QUICK_BUTTON_MARGIN, window.innerWidth - preferredWidth - QUICK_BUTTON_MARGIN)
  );

  const opensBelow = anchor.top + anchor.height / 2 < window.innerHeight / 2;

  if (opensBelow) {
    Object.assign(element.style, {
      left: `${left}px`,
      top: `${anchor.top + anchor.height + gap}px`,
      bottom: ""
    });
  } else {
    // Anchor bottom of menu to top of button so it always hugs the icon
    Object.assign(element.style, {
      left: `${left}px`,
      top: "",
      bottom: `${window.innerHeight - anchor.top + gap}px`
    });
  }
}

function snapQuickButtonToNearestEdge(left: number, top: number): QuickButtonPosition {
  const centerX = left + QUICK_BUTTON_SIZE / 2;
  const centerY = top + QUICK_BUTTON_SIZE / 2;
  const distances: Record<QuickButtonEdge, number> = {
    left: centerX,
    right: window.innerWidth - centerX,
    top: centerY,
    bottom: window.innerHeight - centerY
  };
  const edge = (Object.keys(distances) as QuickButtonEdge[]).reduce((nearest, candidate) => {
    return distances[candidate] < distances[nearest] ? candidate : nearest;
  }, "right");

  return {
    edge,
    offset: edge === "left" || edge === "right" ? top : left
  };
}

function pruneDetachedTextState(): void {
  for (const node of translatedNodes) {
    if (!node.isConnected) translatedNodes.delete(node);
  }
  for (const node of originals.keys()) {
    if (!node.isConnected) originals.delete(node);
  }
}

function rememberOriginals(items: CollectedTextNode[]): void {
  for (const item of items) {
    if (!originals.has(item.node)) {
      originals.set(item.node, item.node.textContent ?? "");
    }
  }
}

function normalizeSourceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hashTextBlock(text: string): string {
  const normalizedText = normalizeSourceText(text);
  let hash = 2166136261;
  for (let index = 0; index < normalizedText.length; index += 1) {
    hash ^= normalizedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalizedText.length}:${hash.toString(36)}`;
}

function getSettingsSignature(settings: ExtensionSettings): string {
  return [
    settings.targetLanguage,
    settings.apiProvider,
    settings.openaiBaseUrl,
    settings.openaiModel
  ].join("\u0000");
}

function syncTranslationCacheSettings(settings: ExtensionSettings): void {
  const signature = getSettingsSignature(settings);
  if (signature === activeTranslationSettingsSignature) return;

  translatedTextByHash.clear();
  pendingTranslationNodesByHash.clear();
  queuedTranslationHashes.clear();
  activeTranslationSettingsSignature = signature;
}

function rememberTranslatedText(sourceText: string, translatedText: string): void {
  const originalText = normalizeSourceText(sourceText);
  if (!originalText) return;
  translatedTextByHash.set(hashTextBlock(sourceText), { originalText, translatedText });
}

function getCachedTranslatedText(sourceText: string): string | undefined {
  const originalText = normalizeSourceText(sourceText);
  const cached = translatedTextByHash.get(hashTextBlock(sourceText));
  if (!cached || cached.originalText !== originalText) return undefined;
  return cached.translatedText;
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

function replaceCachedNodeTranslation(item: CollectedTextNode, translated: string): void {
  if (!originals.has(item.node)) {
    originals.set(item.node, item.node.textContent ?? "");
  }
  replaceNodeTranslation(item.node, translated);
}

function trackPendingTranslationNode(hash: string, node: Text): void {
  const nodes = pendingTranslationNodesByHash.get(hash) ?? new Set<Text>();
  nodes.add(node);
  pendingTranslationNodesByHash.set(hash, nodes);
}

function applyTranslationToPendingNodes(hash: string, translated: string): void {
  const nodes = pendingTranslationNodesByHash.get(hash);
  if (!nodes) return;

  for (const node of nodes) {
    if (!node.isConnected || translatedNodes.has(node)) continue;
    if (!originals.has(node)) {
      originals.set(node, node.textContent ?? "");
    }
    replaceNodeTranslation(node, translated);
  }
  pendingTranslationNodesByHash.delete(hash);
}

function clearPendingTranslationNodesForItems(items: CollectedTextNode[]): void {
  for (const item of items) {
    pendingTranslationNodesByHash.delete(hashTextBlock(item.text));
  }
}

function shouldTranslatePage(settings: ExtensionSettings, analysis: PageAnalysis, force: boolean): boolean {
  if (force) return analysis.isForeign && analysis.shouldTranslate;
  return shouldAutoTranslate(settings, analysis);
}

function hidePageTranslationIndicator(): void {
  pageTranslationIndicator?.remove();
  pageTranslationIndicator = null;
}

function isTranslationRunCanceled(runId: number): boolean {
  return runId !== activeTranslationRunId || canceledTranslationRunIds.has(runId);
}

function cancelActiveTranslation(): void {
  if (!pageTranslationJob && !continuousObserver && continuousTimer === null) return;
  canceledTranslationRunIds.add(activeTranslationRunId);
  pageTranslationJob = null;
  stopContinuousTranslation();
  quickTranslateButton?.removeAttribute("disabled");
  void setTabStatus({ status: "idle", message: "Translation paused" }).catch(() => undefined);
  logContentDebug("translate:cancel", { runId: activeTranslationRunId });
}

function restartActiveTranslationWithLatestSettings(): void {
  if (!pageTranslationJob) return;

  const restartRoot = continuousObserver ? continuousRoot : document.body;
  canceledTranslationRunIds.add(activeTranslationRunId);
  pendingTranslationNodesByHash.clear();
  queuedTranslationHashes.clear();
  pageTranslationJob = null;
  quickTranslateButton?.removeAttribute("disabled");
  showPageTranslationIndicator("Settings changed, restarting...");
  logContentDebug("translate:restart-settings", {
    runId: activeTranslationRunId,
    root: restartRoot instanceof Element ? describeElement(restartRoot) : "document"
  });
  schedulePageTranslation({ force: true, root: restartRoot }, 0);
}

function getQueuedTranslationBlockCount(): number {
  return queuedTranslationHashes.size;
}

function resetQueuedTranslationState(): void {
  queuedTranslationHashes = new Set<string>();
}

function resetTranslationProgress(): void {
  translationProgress = {
    active: false,
    completedBlocks: 0,
    totalBlocks: 0
  };
}

function getTranslationBatchCount(totalBlocks = translationProgress.totalBlocks): number {
  return Math.max(1, Math.ceil(totalBlocks / MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST));
}

function getCurrentTranslationBatch(inFlightBlocks = 0): number {
  return Math.min(
    getTranslationBatchCount(),
    Math.max(1, Math.ceil((translationProgress.completedBlocks + inFlightBlocks) / MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST))
  );
}

function formatTranslationProgress(inFlightBlocks = 0): string {
  return `Translating ${getCurrentTranslationBatch(inFlightBlocks)}/${getTranslationBatchCount()} (${translationProgress.totalBlocks} blocks)...`;
}

function startOrExtendTranslationProgress(nodeCount: number, continuous: boolean): void {
  if (!translationProgress.active || !continuous) {
    translationProgress = {
      active: true,
      completedBlocks: 0,
      totalBlocks: nodeCount
    };
    return;
  }

  translationProgress.totalBlocks = Math.max(
    translationProgress.totalBlocks,
    translationProgress.completedBlocks + nodeCount
  );
}

function addQueuedNodesToTranslationProgress(nodes: CollectedTextNode[]): number {
  let addedBlocks = 0;
  for (const item of nodes) {
    const hash = hashTextBlock(item.text);
    if (queuedTranslationHashes.has(hash) || pendingTranslationNodesByHash.has(hash) || getCachedTranslatedText(item.text) !== undefined) {
      continue;
    }
    queuedTranslationHashes.add(hash);
    addedBlocks += 1;
  }
  if (addedBlocks > 0) {
    if (!translationProgress.active) {
      translationProgress = {
        active: true,
        completedBlocks: 0,
        totalBlocks: addedBlocks
      };
    } else {
      translationProgress.totalBlocks += addedBlocks;
    }
  }
  return addedBlocks;
}

function updateTranslationProgressUi(inFlightBlocks = 0): void {
  const queuedTranslationBlocks = getQueuedTranslationBlockCount();
  if (quickTranslateButton) {
    quickTranslateButton.dataset.translateAiQueuedBlocks = String(queuedTranslationBlocks);
  }
  if (translationProgress.active) {
    showPageTranslationIndicator(formatTranslationProgress(inFlightBlocks));
  }
  updateQuickTranslateButtonState();
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
  const header = document.createElement("span");
  header.dataset.translateAiProgressHeader = "true";
  const label = document.createElement("span");
  label.dataset.translateAiProgressLabel = "true";
  label.textContent = message;
  const pauseButton = document.createElement("button");
  pauseButton.type = "button";
  pauseButton.title = "Hủy dịch";
  pauseButton.dataset.translateAiPauseTranslation = "true";
  pauseButton.dataset.translateAiUi = "true";
  pauseButton.textContent = "Pause";
  pauseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveTranslation();
  });
  Object.assign(header.style, {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    justifyContent: "space-between",
    minWidth: "190px"
  });
  Object.assign(label.style, {
    display: "block",
    whiteSpace: "nowrap"
  });
  Object.assign(pauseButton.style, {
    border: "0",
    borderRadius: "999px",
    background: "rgba(255, 255, 255, 0.14)",
    color: "#ffffff",
    cursor: "pointer",
    flex: "0 0 auto",
    fontSize: "11px",
    fontWeight: "700",
    lineHeight: "1",
    padding: "6px 8px"
  });
  header.append(label, pauseButton);
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
  pageTranslationIndicator.append(header, progressTrack);
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
    pointerEvents: "auto"
  });
  const style = document.createElement("style");
  style.dataset.translateAiUi = "true";
  style.textContent = "@keyframes translate-ai-progress { from { transform: translateX(-45%); } to { transform: translateX(125%); } }";
  pageTranslationIndicator.append(style);
  document.body.append(pageTranslationIndicator);
}

function collectUntranslatedTextNodes(root: ParentNode): CollectedTextNode[] {
  pruneDetachedTextState();
  return collectVisibleTextNodes(root).filter((item) => {
    if (translatedNodes.has(item.node)) return false;

    const hash = hashTextBlock(item.text);
    const cachedTranslation = getCachedTranslatedText(item.text);
    if (cachedTranslation !== undefined) {
      replaceCachedNodeTranslation(item, cachedTranslation);
      return false;
    }

    if (pendingTranslationNodesByHash.has(hash)) {
      trackPendingTranslationNode(hash, item.node);
      return false;
    }

    return true;
  });
}

function prepareUniqueTextNodesForTranslation(nodes: CollectedTextNode[]): CollectedTextNode[] {
  const uniqueNodes: CollectedTextNode[] = [];
  const preparedHashes = new Set<string>();

  for (const item of nodes) {
    if (translatedNodes.has(item.node)) continue;

    const hash = hashTextBlock(item.text);
    const cachedTranslation = getCachedTranslatedText(item.text);
    if (cachedTranslation !== undefined) {
      replaceCachedNodeTranslation(item, cachedTranslation);
      continue;
    }

    trackPendingTranslationNode(hash, item.node);
    if (preparedHashes.has(hash)) continue;

    preparedHashes.add(hash);
    queuedTranslationHashes.delete(hash);
    uniqueNodes.push(item);
  }

  return uniqueNodes;
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

function clearPendingPageTranslationTimer(): void {
  if (pendingPageTranslationTimer === null) return;
  window.clearTimeout(pendingPageTranslationTimer);
  pendingPageTranslationTimer = null;
}

function schedulePageTranslation(options: { force?: boolean; root?: ParentNode }, delay: number): void {
  clearPendingPageTranslationTimer();
  pendingPageTranslationTimer = window.setTimeout(() => {
    pendingPageTranslationTimer = null;
    startPageTranslation(options);
  }, delay);
}

function isInsideTranslateAiUi(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-translate-ai-ui='true']") !== null;
}

function collectMutationTextNodes(records: MutationRecord[], root: ParentNode): CollectedTextNode[] {
  const nodes = new Map<string, CollectedTextNode>();

  for (const record of records) {
    if (isInsideTranslateAiUi(record.target)) continue;

    if (record.type === "characterData" && record.target instanceof Text) {
      if (translatedNodes.has(record.target)) continue;
      const parent = record.target.parentElement;
      if (parent && rootContainsNode(root, record.target)) {
        for (const item of collectUntranslatedTextNodes(parent)) {
          nodes.set(hashTextBlock(item.text), item);
        }
      }
      continue;
    }

    for (const addedNode of record.addedNodes) {
      if (isInsideTranslateAiUi(addedNode)) continue;
      if (addedNode instanceof Text && translatedNodes.has(addedNode)) continue;
      if (!rootContainsNode(root, addedNode)) continue;

      const collectRoot = addedNode instanceof Text
        ? addedNode.parentElement
        : addedNode instanceof Element
          ? addedNode
          : null;

      if (!collectRoot) continue;

      for (const item of collectUntranslatedTextNodes(collectRoot)) {
        nodes.set(hashTextBlock(item.text), item);
      }
    }
  }

  return Array.from(nodes.values());
}

function rootContainsNode(root: ParentNode, node: Node): boolean {
  return root === node || (root instanceof Node && root.contains(node));
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

async function translatePage({
  force = false,
  root = document.body,
  runId
}: { force?: boolean; root?: ParentNode; runId: number }): Promise<void> {
  if (isTranslationRunCanceled(runId)) return;
  showPageTranslationIndicator("Collecting text...");
  const settings = await sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
  if (isTranslationRunCanceled(runId)) return;
  syncTranslationCacheSettings(settings);
  const translationRoot = force ? resolveRootWithText(root) : root;
  let nodes = collectUntranslatedTextNodes(translationRoot);
  for (let retryIndex = 0; force && nodes.length === 0 && retryIndex < MANUAL_COLLECT_RETRY_LIMIT; retryIndex += 1) {
    showPageTranslationIndicator(`Waiting for page text ${retryIndex + 1}/${MANUAL_COLLECT_RETRY_LIMIT}...`);
    await wait(MANUAL_COLLECT_RETRY_DELAY_MS);
    if (isTranslationRunCanceled(runId)) return;
    nodes = collectUntranslatedTextNodes(translationRoot);
  }
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
    if (isTranslationRunCanceled(runId)) return;
    if (!shouldTranslatePage(settings, analysis, force)) {
      hidePageTranslationIndicator();
      return;
    }
  }

  const translatableNodes = prepareUniqueTextNodesForTranslation(nodes);
  if (translatableNodes.length === 0) {
    logContentDebug("translate:skip", { reason: "already-queued-or-translated" });
    if (!translationProgress.active) hidePageTranslationIndicator();
    return;
  }

  startOrExtendTranslationProgress(translatableNodes.length, continuousObserver !== null);
  rememberOriginals(translatableNodes);
  try {
    const chunks = chunkCollectedTextNodes(translatableNodes, MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST);
    for (let index = 0; index < chunks.length; index += 1) {
      if (isTranslationRunCanceled(runId)) return;
      const chunk = chunks[index];
      updateTranslationProgressUi(chunk.length);
      logContentDebug("translate:send", {
        batchIndex: getCurrentTranslationBatch(chunk.length),
        batchCount: getTranslationBatchCount(),
        nodeCount: chunk.length,
        totalBlocks: translationProgress.totalBlocks,
        totalChars: chunk.reduce((sum, item) => sum + item.text.length, 0)
      });
      let response: { items: TextItem[] };
      try {
        response = await sendMessage<{ items: TextItem[] }>({
          type: "TRANSLATE_ITEMS",
          items: chunk.map(({ id, text }) => ({ id, text }))
        });
      } catch (error) {
        clearPendingTranslationNodesForItems(chunk);
        throw error;
      }
      if (isTranslationRunCanceled(runId)) {
        clearPendingTranslationNodesForItems(chunk);
        return;
      }
      logContentDebug("translate:response", {
        batchIndex: getCurrentTranslationBatch(chunk.length),
        batchCount: getTranslationBatchCount(),
        itemCount: response.items.length
      });
      const translatedById = new Map(response.items.map((item) => [item.id, item.text]));
      for (const item of chunk) {
        const translated = translatedById.get(item.id);
        if (translated !== undefined) {
          const hash = hashTextBlock(item.text);
          rememberTranslatedText(item.text, translated);
          applyTranslationToPendingNodes(hash, translated);
        }
      }
      translationProgress.completedBlocks += chunk.length;
      if (index < chunks.length - 1) {
        await waitForNextTranslationBatch();
      }
    }
  } finally {
    logContentDebug("translate:done");
    if (isTranslationRunCanceled(runId)) {
      if (runId === activeTranslationRunId) {
        resetTranslationProgress();
        hidePageTranslationIndicator();
      }
      return;
    }
    const hasFollowUpWork = continuousObserver !== null && (pendingContinuousTranslation || queuedTranslationHashes.size > 0);
    if (!hasFollowUpWork) {
      resetTranslationProgress();
      hidePageTranslationIndicator();
    } else {
      updateTranslationProgressUi();
    }
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
  const queuedTranslationBlocks = getQueuedTranslationBlockCount();
  const hasQueuedBlocks = queuedTranslationBlocks > 0;
  quickTranslateButton.title = hasQueuedBlocks
    ? `Đang chờ dịch ${queuedTranslationBlocks} block mới`
    : continuousObserver ? "Dừng dịch liên tục" : "Translate page";
  quickTranslateButton.dataset.translateAiQuickState = hasQueuedBlocks
    ? "queued"
    : continuousObserver ? "pause" : "translate";
  quickTranslateButton.dataset.translateAiQueuedBlocks = String(queuedTranslationBlocks);
  Object.assign(quickTranslateButton.style, hasQueuedBlocks ? {
    filter: "saturate(1.14) brightness(1.05)",
    boxShadow: "0 14px 34px rgba(14, 165, 233, 0.38), 0 0 0 4px rgba(14, 165, 233, 0.24)"
  } : continuousObserver ? {
    filter: "saturate(1.08) brightness(1.02)",
    boxShadow: "0 14px 34px rgba(37, 99, 235, 0.34), 0 0 0 3px rgba(37, 99, 235, 0.28)"
  } : {
    filter: "",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.22)"
  });
}

function createQuickTranslateLogo(): HTMLImageElement {
  const image = document.createElement("img");
  image.dataset.translateAiQuickLogo = "true";
  image.alt = "";
  image.src = chrome.runtime.getURL("logo.png");
  Object.assign(image.style, {
    display: "block",
    width: "100%",
    height: "100%",
    borderRadius: "14px",
    objectFit: "cover",
    pointerEvents: "none",
    userSelect: "none"
  });
  return image;
}

function installQuickButtonDragHandlers(button: HTMLButtonElement): void {
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    quickButtonDragState = {
      pointerId: event.pointerId,
      dragging: false
    };
    button.setPointerCapture?.(event.pointerId);
  });

  button.addEventListener("pointermove", (event) => {
    if (!quickButtonDragState || quickButtonDragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const { left, top } = getQuickButtonDragPosition(event);
    quickButtonDragState.dragging = true;
    hideQuickTranslateMenu();
    button.style.transition = "filter 160ms ease, box-shadow 160ms ease";
    moveQuickButtonTo(left, top);
  });

  button.addEventListener("pointerup", (event) => {
    if (!quickButtonDragState || quickButtonDragState.pointerId !== event.pointerId) return;
    const wasDragging = quickButtonDragState.dragging;
    quickButtonDragState = null;
    button.releasePointerCapture?.(event.pointerId);
    button.style.transition = "filter 160ms ease, box-shadow 160ms ease, transform 160ms ease";
    if (!wasDragging) return;

    event.preventDefault();
    const { left, top } = getQuickButtonDragPosition(event);
    const snappedPosition = snapQuickButtonToNearestEdge(left, top);
    saveQuickButtonPosition(snappedPosition);
    applyQuickButtonPosition(snappedPosition);
    suppressQuickButtonClick = true;
    window.setTimeout(() => {
      suppressQuickButtonClick = false;
    }, 0);
  });

  button.addEventListener("pointercancel", (event) => {
    if (!quickButtonDragState || quickButtonDragState.pointerId !== event.pointerId) return;
    quickButtonDragState = null;
    button.style.transition = "filter 160ms ease, box-shadow 160ms ease, transform 160ms ease";
    applyQuickButtonPosition(quickButtonPosition ?? getDefaultQuickButtonPosition());
  });
}

function startPageTranslation(options: { force?: boolean; root?: ParentNode } = {}): void {
  if (pageTranslationJob) {
    if (continuousObserver) {
      pendingContinuousTranslation = true;
      updateTranslationProgressUi();
    }
    logContentDebug("translate:ignored", { reason: "job-already-running" });
    return;
  }
  hideQuickTranslateMenu();
  if (!continuousObserver) {
    resetTranslationProgress();
  }
  resetQueuedTranslationState();
  updateQuickTranslateButtonState();
  quickTranslateButton?.setAttribute("disabled", "true");
  const runId = activeTranslationRunId + 1;
  activeTranslationRunId = runId;
  canceledTranslationRunIds.delete(runId);
  pageTranslationJob = translatePage({ ...options, runId })
    .catch(async (error) => {
      if (isTranslationRunCanceled(runId)) return;
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
      canceledTranslationRunIds.delete(runId);
      if (runId !== activeTranslationRunId) return;
      pageTranslationJob = null;
      quickTranslateButton?.removeAttribute("disabled");
      updateQuickTranslateButtonState();
      if (!isTranslationRunCanceled(runId) && pendingContinuousTranslation && continuousObserver) {
        pendingContinuousTranslation = false;
        logContentDebug("translate:pending-run", {
          root: continuousRoot instanceof Element ? describeElement(continuousRoot) : "document"
        });
        updateTranslationProgressUi();
        schedulePageTranslation({ force: true, root: continuousRoot }, 0);
      }
    });
}

function scheduleContinuousTranslation(newTextNodes: CollectedTextNode[] = []): void {
  if (continuousTimer !== null) {
    window.clearTimeout(continuousTimer);
  }
  const newTextBlockCount = addQueuedNodesToTranslationProgress(newTextNodes);
  const queuedTranslationBlocks = getQueuedTranslationBlockCount();
  const delay = newTextBlockCount > 0 && newTextBlockCount < WATCH_SMALL_UPDATE_TEXT_BLOCK_LIMIT
    ? WATCH_SMALL_UPDATE_DELAY_MS
    : WATCH_DEFAULT_UPDATE_DELAY_MS;
  updateTranslationProgressUi();
  logContentDebug("watch:schedule", {
    newTextBlockCount,
    queuedTranslationBlocks,
    totalBlocks: translationProgress.totalBlocks,
    completedBlocks: translationProgress.completedBlocks,
    batchIndex: getCurrentTranslationBatch(),
    batchCount: getTranslationBatchCount(),
    delayMs: delay
  });
  continuousTimer = window.setTimeout(() => {
    continuousTimer = null;
    if (pageTranslationJob) {
      pendingContinuousTranslation = true;
      updateTranslationProgressUi();
      logContentDebug("watch:pending", { reason: "job-running" });
      return;
    }
    startPageTranslation({ force: true, root: continuousRoot });
  }, delay);
}

function stopContinuousTranslation(): void {
  clearPendingPageTranslationTimer();
  if (pageTranslationJob) {
    canceledTranslationRunIds.add(activeTranslationRunId);
    pageTranslationJob = null;
  }
  translatedTextByHash.clear();
  pendingTranslationNodesByHash.clear();
  activeTranslationSettingsSignature = "";
  continuousObserver?.disconnect();
  continuousObserver = null;
  continuousRoot = document.body;
  if (continuousTimer !== null) {
    window.clearTimeout(continuousTimer);
    continuousTimer = null;
  }
  pendingContinuousTranslation = false;
  resetQueuedTranslationState();
  resetTranslationProgress();
  hidePageTranslationIndicator();
  updateQuickTranslateButtonState();
}

function startContinuousTranslation(root: ParentNode = document.body): void {
  hideQuickTranslateMenu();
  stopContinuousTranslation();

  continuousRoot = root;
  logContentDebug("watch:start", {
    root: root instanceof Element ? describeElement(root) : "document"
  });
  continuousObserver = new MutationObserver((records) => {
    const newTextNodes = collectMutationTextNodes(records, continuousRoot);
    logContentDebug("watch:mutation", {
      newTextBlockCount: newTextNodes.length,
      mutationCount: records.length,
      root: continuousRoot instanceof Element ? describeElement(continuousRoot) : "document"
    });
    if (newTextNodes.length > 0) {
      scheduleContinuousTranslation(newTextNodes);
    }
  });
  continuousObserver.observe(root, { childList: true, characterData: true, subtree: true });
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
  translatedTextByHash.clear();
  pendingTranslationNodesByHash.clear();
  stopContinuousTranslation();
  await setTabStatus({ status: "restored" });
}

const SELECTION_BUBBLE_LANGUAGES = [
  "English", "Vietnamese", "Japanese", "Korean", "Chinese",
  "Thai", "Indonesian", "French", "German", "Spanish", "Portuguese", "Russian"
];

function hideSelectionBubble(): void {
  selectionBubble?.remove();
  selectionBubble = null;
}

function positionSelectionBubble(element: HTMLElement, rect: DOMRect): void {
  const gap = 8;
  const estimatedHeight = 36;
  const maxWidth = 300;
  const top = rect.top > estimatedHeight + gap + 8
    ? rect.top - estimatedHeight - gap
    : rect.bottom + gap;
  const left = Math.max(8, Math.min(
    rect.left + rect.width / 2 - maxWidth / 2,
    window.innerWidth - maxWidth - 8
  ));
  Object.assign(element.style, { left: `${left}px`, top: `${top}px` });
}

function createSelectionCloseButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.translateAiUi = "true";
  btn.textContent = "×";
  Object.assign(btn.style, {
    border: "0",
    background: "transparent",
    color: "rgba(255,255,255,0.5)",
    cursor: "pointer",
    fontSize: "18px",
    fontWeight: "300",
    lineHeight: "1",
    padding: "0 2px",
    flexShrink: "0",
    alignSelf: "center"
  });
  btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function replaceSelectionWithText(range: Range, text: string): boolean {
  try {
    const container = range.commonAncestorContainer;
    const element = container instanceof Element ? container : container.parentElement;
    if (!element?.isContentEditable) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function showSelectionTranslateBubble(text: string, rect: DOMRect, defaultLanguage: string, savedRange: Range | null): void {
  hideSelectionBubble();

  const bubble = document.createElement("div");
  bubble.dataset.translateAiUi = "true";
  bubble.dataset.translateAiSelectionBubble = "true";
  Object.assign(bubble.style, {
    position: "fixed",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "7px 10px",
    background: "#111827",
    color: "#f9fafb",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "500",
    lineHeight: "1.3",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.32)",
    zIndex: "2147483647",
    maxWidth: "340px",
    flexWrap: "nowrap"
  });

  selectionBubble = bubble;
  document.body.append(bubble);
  positionSelectionBubble(bubble, rect);

  const clearBubble = (): void => {
    while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
  };

  let selectedLanguage = defaultLanguage;

  const createLanguageSelect = (): HTMLSelectElement => {
    const select = document.createElement("select");
    select.dataset.translateAiUi = "true";
    Object.assign(select.style, {
      border: "0",
      borderRadius: "4px",
      background: "rgba(255,255,255,0.12)",
      color: "#e5e7eb",
      cursor: "pointer",
      fontSize: "11px",
      fontWeight: "600",
      padding: "3px 5px",
      flexShrink: "0",
      outline: "none"
    });
    for (const lang of SELECTION_BUBBLE_LANGUAGES) {
      const option = document.createElement("option");
      option.value = lang;
      option.textContent = lang;
      if (lang === selectedLanguage) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => { selectedLanguage = select.value; });
    return select;
  };

  const renderTrigger = (): void => {
    clearBubble();
    bubble.style.flexWrap = "nowrap";
    const langSelect = createLanguageSelect();
    const translateBtn = document.createElement("button");
    translateBtn.type = "button";
    translateBtn.dataset.translateAiUi = "true";
    translateBtn.textContent = "→";
    Object.assign(translateBtn.style, {
      border: "0",
      borderRadius: "4px",
      background: "rgba(255,255,255,0.12)",
      color: "#e5e7eb",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "700",
      padding: "4px 8px",
      flexShrink: "0",
      whiteSpace: "nowrap"
    });
    translateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedLanguage = langSelect.value;
      renderLoading();
      void performTranslation();
    });
    bubble.append(langSelect, translateBtn, createSelectionCloseButton(hideSelectionBubble));
  };

  const renderLoading = (): void => {
    clearBubble();
    bubble.style.flexWrap = "nowrap";
    const span = document.createElement("span");
    span.textContent = "Đang dịch...";
    span.style.color = "rgba(255,255,255,0.7)";
    span.style.fontSize = "12px";
    bubble.append(span, createSelectionCloseButton(hideSelectionBubble));
  };

  const renderResult = (resultText: string): void => {
    clearBubble();
    bubble.style.flexWrap = "wrap";
    const span = document.createElement("span");
    span.textContent = resultText;
    span.style.flex = "1 1 auto";
    span.style.minWidth = "0";
    span.style.wordBreak = "break-word";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.dataset.translateAiUi = "true";
    copyBtn.textContent = "Copy";
    Object.assign(copyBtn.style, {
      border: "0",
      borderRadius: "4px",
      background: "rgba(255,255,255,0.12)",
      color: "#e5e7eb",
      cursor: "pointer",
      fontSize: "11px",
      padding: "3px 6px",
      flexShrink: "0"
    });
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(resultText).catch(() => undefined);
      copyBtn.textContent = "✓";
      window.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
    });

    const actionButtons: HTMLElement[] = [span, copyBtn];

    if (savedRange !== null) {
      const replaceBtn = document.createElement("button");
      replaceBtn.type = "button";
      replaceBtn.dataset.translateAiUi = "true";
      replaceBtn.textContent = "Replace";
      Object.assign(replaceBtn.style, {
        border: "0",
        borderRadius: "4px",
        background: "rgba(96,165,250,0.2)",
        color: "#93c5fd",
        cursor: "pointer",
        fontSize: "11px",
        padding: "3px 6px",
        flexShrink: "0"
      });
      replaceBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ok = replaceSelectionWithText(savedRange, resultText);
        if (ok) {
          hideSelectionBubble();
        } else {
          replaceBtn.textContent = "✗";
          window.setTimeout(() => { replaceBtn.textContent = "Replace"; }, 1200);
        }
      });
      actionButtons.push(replaceBtn);
    }

    actionButtons.push(createSelectionCloseButton(hideSelectionBubble));
    bubble.append(...actionButtons);
    positionSelectionBubble(bubble, rect);
  };

  const renderError = (message: string): void => {
    clearBubble();
    bubble.style.flexWrap = "nowrap";
    const span = document.createElement("span");
    span.textContent = message;
    span.style.color = "#fca5a5";
    span.style.fontSize = "12px";
    bubble.append(span, createSelectionCloseButton(hideSelectionBubble));
  };

  const performTranslation = async (): Promise<void> => {
    try {
      const result = await sendMessage<{ text: string }>({
        type: "TRANSLATE_TEXT",
        text,
        targetLanguage: selectedLanguage
      });
      if (selectionBubble !== bubble) return;
      renderResult(result.text);
    } catch (error) {
      if (selectionBubble !== bubble) return;
      renderError(getErrorMessage(error));
    }
  };

  renderTrigger();
}

async function handleTextSelection(): Promise<void> {
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    hideSelectionBubble();
    return;
  }

  const text = selection.toString().trim();
  if (text.length < 2) {
    hideSelectionBubble();
    return;
  }

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const containerElement = container instanceof Element ? container : container.parentElement;
  if (containerElement?.closest("[data-translate-ai-ui='true']")) return;

  const isEditable = containerElement?.isContentEditable === true;
  const savedRange = isEditable ? range.cloneRange() : null;

  try {
    const settings = await sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" });

    const currentSelection = window.getSelection();
    if (!currentSelection || currentSelection.isCollapsed) return;
    if (currentSelection.toString().trim() !== text) return;

    const currentRange = currentSelection.getRangeAt(0);
    const currentRect = currentRange.getBoundingClientRect();
    if (currentRect.width === 0 && currentRect.height === 0) return;

    showSelectionTranslateBubble(text, currentRect, settings.targetLanguage, savedRange);
  } catch {
    // Extension context may be invalid
  }
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
    width: "48px",
    height: "48px",
    border: "0",
    borderRadius: "14px",
    background: "transparent",
    cursor: "pointer",
    zIndex: "2147483647",
    padding: "0",
    overflow: "hidden",
    transition: "filter 160ms ease, box-shadow 160ms ease, transform 160ms ease",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.22)"
  });
  quickButtonPosition = getDefaultQuickButtonPosition();
  applyQuickButtonPosition(quickButtonPosition);
  void restoreQuickButtonPosition();
  installQuickButtonDragHandlers(quickTranslateButton);
  quickTranslateButton.addEventListener("mouseenter", () => {
    quickTranslateButton!.style.transform = "translateY(-1px)";
  });
  quickTranslateButton.addEventListener("mouseleave", () => {
    quickTranslateButton!.style.transform = "";
  });
  quickTranslateButton.addEventListener("click", () => {
    if (suppressQuickButtonClick) return;
    if (continuousObserver) {
      stopContinuousTranslation();
      return;
    }
    toggleQuickTranslateMenu();
  });
  quickTranslateButton.append(createQuickTranslateLogo());
  document.body.append(quickTranslateButton);
  updateQuickTranslateButtonState();
}

function hideQuickTranslateMenu(): void {
  quickTranslateMenu?.remove();
  quickTranslateMenu = null;
}

const MENU_ICONS: Record<string, string> = {
  "translate-new": `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  "watch-page":    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  "watch-stop":    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
  "pick-region":   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h5v5H3zM3 16h5v5H3zM16 3h5v5h-5zM16 16h5v5h-5z"/><line x1="8" y1="5.5" x2="16" y2="5.5"/><line x1="5.5" y1="8" x2="5.5" y2="16"/><line x1="18.5" y1="8" x2="18.5" y2="16"/><line x1="8" y1="18.5" x2="16" y2="18.5"/></svg>`,
};

function createMenuButton(label: string, action: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.translateAiMenuAction = action;
  button.dataset.translateAiUi = "true";

  const iconSvg = MENU_ICONS[action] ?? MENU_ICONS["translate-new"];
  const iconWrap = document.createElement("span");
  iconWrap.dataset.translateAiUi = "true";
  iconWrap.innerHTML = iconSvg;
  Object.assign(iconWrap.style, {
    display: "flex",
    alignItems: "center",
    flexShrink: "0",
    color: "#6b7280"
  });

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  labelSpan.dataset.translateAiUi = "true";

  button.append(iconWrap, labelSpan);

  Object.assign(button.style, {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    border: "0",
    padding: "9px 12px",
    background: "transparent",
    color: "#111827",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    fontSize: "13px",
    fontWeight: "500",
    textAlign: "left",
    cursor: "pointer",
    borderRadius: "6px",
    transition: "background 0.1s"
  });

  button.addEventListener("mouseenter", () => {
    button.style.background = "#f3f4f6";
    iconWrap.style.color = "#4f7ef8";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "transparent";
    iconWrap.style.color = "#6b7280";
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
    minWidth: "210px",
    padding: "5px",
    borderRadius: "12px",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.06)",
    zIndex: "2147483647"
  });

  const watchAction = continuousObserver ? "watch-stop" : "watch-page";
  const watchLabel = continuousObserver ? "Dừng dịch liên tục" : "Dịch liên tục toàn trang";

  quickTranslateMenu.append(
    createMenuButton("Dịch trang", "translate-new", () => startPageTranslation({ force: true })),
    createMenuButton(watchLabel, watchAction, toggleContinuousTranslation),
    createMenuButton("Chọn vùng để dịch", "pick-region", startRegionPick)
  );

  positionFloatingElementNearQuickButton(quickTranslateMenu, 210);
  document.body.append(quickTranslateMenu);
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
  if (message?.type === "SETTINGS_UPDATED") {
    restartActiveTranslationWithLatestSettings();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

document.addEventListener("mouseup", (event) => {
  if ((event.target as Element).closest?.("[data-translate-ai-ui='true']")) return;
  window.setTimeout(() => { void handleTextSelection(); }, 0);
});

document.addEventListener("mousedown", (event) => {
  if ((event.target as Element).closest?.("[data-translate-ai-selection-bubble='true']")) return;
  hideSelectionBubble();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSelectionBubble();
});

document.addEventListener("keyup", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "a") {
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
    window.setTimeout(() => { void handleTextSelection(); }, 50);
  }
});

document.addEventListener("DOMContentLoaded", showQuickTranslateButton);
window.addEventListener("pagehide", stopContinuousTranslation);
showQuickTranslateButton();
