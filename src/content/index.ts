import { collectVisibleTextNodes, createPageSample, type CollectedTextNode } from "./domText";
import { shouldAutoTranslate } from "../shared/translationDecision";
import type { ExtensionSettings, PageAnalysis, TabStatus, TextItem } from "../shared/types";

const originals = new Map<Text, string>();
const translatedNodes = new Set<Text>();
const MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST = 10;
const WATCH_SMALL_UPDATE_TEXT_BLOCK_LIMIT = 5;
const WATCH_SMALL_UPDATE_DELAY_MS = 250;
const WATCH_DEFAULT_UPDATE_DELAY_MS = 600;
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
let queuedTranslationNodes = new Set<Text>();
let activeTranslationRunId = 0;
const canceledTranslationRunIds = new Set<number>();
let translationProgress = {
  active: false,
  completedBlocks: 0,
  totalBlocks: 0
};

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

function getQueuedTranslationBlockCount(): number {
  return queuedTranslationNodes.size;
}

function resetQueuedTranslationState(): void {
  queuedTranslationNodes = new Set<Text>();
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
    if (queuedTranslationNodes.has(item.node)) continue;
    queuedTranslationNodes.add(item.node);
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

function isInsideTranslateAiUi(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-translate-ai-ui='true']") !== null;
}

function collectMutationTextNodes(records: MutationRecord[], root: ParentNode): CollectedTextNode[] {
  const nodes = new Map<Text, CollectedTextNode>();

  for (const record of records) {
    if (isInsideTranslateAiUi(record.target)) continue;

    if (record.type === "characterData" && record.target instanceof Text) {
      if (translatedNodes.has(record.target)) continue;
      const parent = record.target.parentElement;
      if (parent && rootContainsNode(root, record.target)) {
        for (const item of collectUntranslatedTextNodes(parent)) {
          nodes.set(item.node, item);
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
        nodes.set(item.node, item);
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
    if (isTranslationRunCanceled(runId)) return;
    if (!shouldTranslatePage(settings, analysis, force)) {
      hidePageTranslationIndicator();
      return;
    }
  }

  startOrExtendTranslationProgress(nodes.length, continuousObserver !== null);
  rememberOriginals(nodes);
  try {
    const chunks = chunkCollectedTextNodes(nodes, MAX_TEXT_BLOCKS_PER_TRANSLATION_REQUEST);
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
      const response = await sendMessage<{ items: TextItem[] }>({
        type: "TRANSLATE_ITEMS",
        items: chunk.map(({ id, text }) => ({ id, text }))
      });
      if (isTranslationRunCanceled(runId)) return;
      logContentDebug("translate:response", {
        batchIndex: getCurrentTranslationBatch(chunk.length),
        batchCount: getTranslationBatchCount(),
        itemCount: response.items.length
      });
      const translatedById = new Map(response.items.map((item) => [item.id, item.text]));
      for (const item of chunk) {
        const translated = translatedById.get(item.id);
        if (translated !== undefined) replaceNodeTranslation(item.node, translated);
      }
      translationProgress.completedBlocks += chunk.length;
      if (index < chunks.length - 1) {
        await waitForNextTranslationBatch();
      }
    }
  } finally {
    logContentDebug("translate:done");
    if (isTranslationRunCanceled(runId)) {
      resetTranslationProgress();
      hidePageTranslationIndicator();
      return;
    }
    const hasFollowUpWork = continuousObserver !== null && (pendingContinuousTranslation || queuedTranslationNodes.size > 0);
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
        window.setTimeout(() => startPageTranslation({ force: true, root: continuousRoot }), 0);
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
    borderRadius: "14px",
    background: "transparent",
    cursor: "pointer",
    zIndex: "2147483647",
    padding: "0",
    overflow: "hidden",
    transition: "filter 160ms ease, box-shadow 160ms ease, transform 160ms ease",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.22)"
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
  quickTranslateButton.append(createQuickTranslateLogo());
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
