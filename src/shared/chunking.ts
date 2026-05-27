import type { TextItem } from "./types";

export function chunkTextItems(items: TextItem[], maxChars: number): TextItem[][] {
  const chunks: TextItem[][] = [];
  let current: TextItem[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    // current.length accounts for one separator character between each adjacent
    // item when the chunk is serialized for translation. Reaching maxChars is a
    // boundary, so the next item starts a new chunk instead of filling it.
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
