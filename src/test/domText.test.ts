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

  it("skips text inside hidden ancestors", () => {
    document.body.innerHTML = `
      <main>
        <p>Visible text</p>
        <div style="display: none"><p>display hidden</p></div>
        <section hidden><p>hidden attribute</p></section>
        <article aria-hidden="true"><p>aria hidden</p></article>
      </main>
    `;

    const items = collectVisibleTextNodes(document.body);
    expect(items.map((item) => item.text)).toEqual(["Visible text"]);
  });
});
