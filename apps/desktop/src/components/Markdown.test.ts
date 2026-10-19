/**
 * The rendering contract for untrusted text: raw HTML is escaped, markdown still works.
 *
 * The component is fed straight to `dangerouslySetInnerHTML`, so this is the line that keeps a
 * model-authored `<img onerror=…>` from becoming executable markup. The CSP is a second line,
 * not the first one.
 */
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./Markdown";

describe("renderMarkdown", () => {
  it("escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("still renders ordinary markdown", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("[link](https://example.com)")).toContain('href="https://example.com"');
  });
});
