/**
 * html-doc.test.ts — the splitter that decides "page" vs "code snippet" vs "prose".
 *
 * The line the component draws is whole-document or nothing: `<!doctype html>` / `<html>` gets a
 * live preview card, everything else stays a highlighted code block. Each case here is a shape a
 * real model has produced or will produce the first week this ships.
 */
import { describe, expect, it } from "vitest";
import { splitHtmlDocs } from "./html-doc";

describe("splitHtmlDocs", () => {
  it("promotes a whole message that is a raw document", () => {
    const src = "<!doctype html>\n<html><body><h1>hi</h1></body></html>";
    expect(splitHtmlDocs(src)).toEqual([{ kind: "html", code: src }]);
  });

  it("promotes a message that opens with <html> without a doctype", () => {
    const src = "<html>\n<body>hello</body>\n</html>";
    expect(splitHtmlDocs(src)).toEqual([{ kind: "html", code: src }]);
  });

  it("splits prose before and after a fenced document", () => {
    const src = [
      "Here is the page you asked for:",
      "",
      "```html",
      "<!doctype html>",
      "<html><body><p>x</p></body></html>",
      "```",
      "",
      "It renders live above.",
    ].join("\n");
    const parts = splitHtmlDocs(src);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ kind: "text", text: "Here is the page you asked for:\n" });
    expect(parts[1]).toEqual({ kind: "html", code: "<!doctype html>\n<html><body><p>x</p></body></html>" });
    expect(parts[2]).toEqual({ kind: "text", text: "\nIt renders live above." });
  });

  it("keeps an html FRAGMENT in prose — a snippet is code, not a page", () => {
    const src = "```html\n<button onclick=\"alert(1)\">go</button>\n```";
    expect(splitHtmlDocs(src)).toEqual([{ kind: "text", text: src }]);
  });

  it("keeps a non-html fenced block untouched", () => {
    const src = "```js\nconsole.log(1)\n```";
    expect(splitHtmlDocs(src)).toEqual([{ kind: "text", text: src }]);
  });

  it("leaves an unterminated fence alone (mid-stream)", () => {
    const src = "```html\n<!doctype html>\n<html>…";
    expect(splitHtmlDocs(src)).toEqual([{ kind: "text", text: src }]);
  });

  it("handles two documents in one message", () => {
    const doc = (n: string) => `<!doctype html>\n<html><body>${n}</body></html>`;
    const src = `a\n\n\`\`\`html\n${doc("1")}\n\`\`\`\n\nmid\n\n\`\`\`html\n${doc("2")}\n\`\`\`\n\nz`;
    const parts = splitHtmlDocs(src);
    expect(parts.map((p) => p.kind)).toEqual(["text", "html", "text", "html", "text"]);
    expect(parts[1]).toEqual({ kind: "html", code: doc("1") });
    expect(parts[3]).toEqual({ kind: "html", code: doc("2") });
  });

  it("is case-insensitive on the fence language and the doctype", () => {
    const src = "```HTML\n<!DOCTYPE HTML>\n<html></html>\n```";
    expect(splitHtmlDocs(src)).toEqual([{ kind: "html", code: "<!DOCTYPE HTML>\n<html></html>" }]);
  });
});
