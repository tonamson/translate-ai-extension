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
