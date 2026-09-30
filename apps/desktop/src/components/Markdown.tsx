/**
 * Markdown renderer for assistant messages.
 *
 * The audit found the Assistant renders every message as raw `whitespace-pre-wrap` text — no
 * markdown library existed in the app at all. This component adds markdown-it with syntax
 * highlighting (PrismJS) and a copy button on fenced code blocks.
 *
 * Usage: `<Markdown source={messageContent} />`
 *
 * Security: markdown-it escapes user content by default. `html: true` allows inline HTML within
 * the markdown stream, but the source tokens come through the parser — provider/system content
 * is the input, not raw injection. Tool results are app-controlled strings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import Prism from "prismjs";
import "./markdown.css";

// A single shared markdown-it instance — it is stateful (plugins, options) but not per-call.
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
});

function copyToClipboard(text: string, id: string, setCopiedId: (v: string | null) => void) {
  void navigator.clipboard.writeText(text);
  setCopiedId(id);
  setTimeout(() => setCopiedId(null), 2000);
}

export function Markdown({ source }: { source: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Render markdown once per source change. useMemo so we don't re-render the whole DOM tree
  // on every keystroke — only when the text actually differs.
  const html = useMemo(() => md.render(source), [source]);

  // Post-render: syntax-highlight code blocks + inject copy buttons.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const codeBlocks = el.querySelectorAll<HTMLPreElement>("pre code");

    codeBlocks.forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre) return;
      const lang = codeEl.className.replace("language-", "").trim() || "plain";
      const text = codeEl.textContent ?? "";

      // Highlight only once — skip if Prism already ran on this block.
      if (pre.dataset.highlighted === "done") return;
      pre.dataset.highlighted = "done";

      const grammar = Prism.languages[lang as keyof typeof Prism.languages];
      if (grammar) {
        codeEl.innerHTML = Prism.highlight(text, grammar, lang);
      }

      // Copy button — one per code block.
      const btn = el.ownerDocument.createElement("button");
      btn.className = "copy-btn";
      btn.title = "Copy code";
      btn.textContent = copiedId === text ? "✓" : "⎁";
      btn.onclick = () => copyToClipboard(text, text, setCopiedId);
      pre.parentNode?.insertBefore(btn, pre);
    });
  }, [html, copiedId]);

  return (
    <div
      ref={containerRef}
      className="markdown-body whitespace-pre-wrap text-[13px]"
      style={{ color: "var(--text)" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
