import type { TextItem } from "./types";

export function chunkTextItems(items: TextItem[], maxChars: number): TextItem[][] {
  const chunks: TextItem[][] = [];
  let current: TextItem[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    const nextChars = currentChars + itemChars + current.length;

    if (current.length > 0 && nextChars >= maxChars) {
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
