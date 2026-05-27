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
