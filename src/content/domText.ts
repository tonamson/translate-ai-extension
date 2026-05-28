import type { TextItem } from "../shared/types";

export type CollectedTextNode = TextItem & {
  node: Text;
};

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG"]);
const ICON_CLASS_PATTERN = /(^|\s)(material-icons|material-symbols[^ ]*|icon|fa|fas|far|fab)(\s|$)/i;

function shouldSkipElement(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.getAttribute("data-translate-ai-ui") === "true") return true;
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  if (element.getAttribute("role") === "img" || element.getAttribute("role") === "presentation") return true;
  if (element.tagName === "BUTTON" && element.hasAttribute("aria-label")) return true;
  if (ICON_CLASS_PATTERN.test(element.className)) return true;

  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
}

function looksLikeUiGlyph(text: string): boolean {
  return text.length <= 1 || /^[^\p{L}\p{N}]+$/u.test(text);
}

function hasSkippedAncestor(element: Element, root: ParentNode): boolean {
  let current: Element | null = element;

  while (current) {
    if (shouldSkipElement(current)) return true;
    if (current === root) return false;
    current = current.parentElement;
  }

  return false;
}

export function collectVisibleTextNodes(root: ParentNode = document.body): CollectedTextNode[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      const parent = node.parentElement;

      if (!text || looksLikeUiGlyph(text) || !parent || hasSkippedAncestor(parent, root)) {
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
