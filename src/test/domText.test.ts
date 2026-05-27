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
