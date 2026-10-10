/**
 * HtmlPreview — a whole HTML document rendered live inside the chat.
 *
 * The frame is sandboxed with `allow-scripts` and deliberately WITHOUT `allow-same-origin`, so the
 * document runs in an opaque origin: it cannot read this app's storage, cookies or the Tauri
 * bridge, whatever it contains.
 *
 * One honest caveat about scripts, verified against the packaged app's CSP (`tauri.conf.json`:
 * `script-src 'self'`): a `srcdoc` frame INHERITS its parent's policy, so a model-authored inline
 * `<script>` is blocked in the shipping app even though the sandbox attribute permits it — and it
 * does run in the browser harness, which has no CSP header. Styles, layout and images render
 * either way, which is what these previews are for. Making scripts run would need
 * `'unsafe-inline'` in the app-wide policy, and that is the same directive that currently stops
 * model-authored `<script>` in a chat MESSAGE from executing in the app's own document (the
 * markdown renderer passes raw HTML through) — not a trade worth making for a preview.
 *
 * A card toggle keeps the source one click away, because the code is often what the user
 * actually asked for.
 */
import { useState, type ReactNode } from "react";
import { CopyIcon } from "./DocCard";

/** The preview (and its code view, see below) at a fixed height so the two modes cannot disagree. */
const FRAME_HEIGHT = 420;

export function HtmlPreview({
  code,
  label = "HTML page",
  actions,
  subtitle,
}: {
  code: string;
  label?: string;
  /** Extra header controls, rendered after the copy button — the artifact card's "Reveal". */
  actions?: ReactNode;
  /** A second header line, for context the title cannot carry — the full URL being previewed. */
  subtitle?: ReactNode;
}) {
  const [view, setView] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tab = (which: "preview" | "code", text: string) => (
    <button
      type="button"
      className="rounded px-2 py-0.5 text-[11px] transition-colors"
      style={
        view === which
          ? // `--accent-soft` (14% alpha) measured as a barely-there lift at the gate — "active"
            // read only from the brighter label. The fill is stronger and carries a border, so the
            // selected segment is unambiguous at a glance.
            {
              background: "rgba(59, 130, 246, 0.30)",
              border: "1px solid rgba(59, 130, 246, 0.55)",
              color: "var(--text)",
            }
          // `--text-dim` (6.6:1), not `--text-faint`: this is TEXT, so it answers to the 4.5:1
          // minimum, and the faint tier measured 3.22:1 (visual gate, 2026-10-10). The selected
          // segment still reads as selected through its fill, ring and brighter label.
          : { border: "1px solid transparent", color: "var(--text-dim)" }
      }
      onClick={() => setView(which)}
      data-testid={`html-preview-${which}`}
      aria-pressed={view === which}
    >
      {text}
    </button>
  );

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border"
      style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}
      data-testid="html-preview"
    >
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]" aria-hidden="true">
          <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
          <path d="M3 9h18M6.5 6.8h.01M9 6.8h.01" />
        </svg>
        <span className="font-medium" style={{ color: "var(--text)" }}>{label}</span>
        <div className="ml-auto flex items-center gap-1 rounded-full border px-1 py-0.5" style={{ borderColor: "var(--border)" }}>
          {/* The toggle group owns `ml-auto`: it pushes the group and everything after it right,
              so an `actions` node lands beside the copy button rather than on its own line. */}
          {tab("preview", "Preview")}
          {tab("code", "Code")}
        </div>
        <button
          type="button"
          className="card-icon-btn rounded p-1"
          style={copied ? { color: "var(--success)" } : undefined}
          onClick={copy}
          title={copied ? "Copied" : "Copy the HTML source"}
          data-testid="html-preview-copy"
        >
          {copied ? "✓" : <CopyIcon />}
        </button>
        {actions}
      </div>
      {subtitle && (
        <div className="mono break-all px-3 pb-1.5 text-[11px]" style={{ color: "var(--text-dim)" }} data-testid="html-preview-subtitle">
          {subtitle}
        </div>
      )}

      {view === "preview" ? (
        <iframe
          title={`${label} preview`}
          data-testid="html-preview-frame"
          sandbox="allow-scripts"
          srcDoc={code}
          className="block w-full border-t bg-white"
          style={{ height: FRAME_HEIGHT, borderColor: "var(--border)" }}
        />
      ) : (
        // Capped at the frame's height, not fixed to it: a long document scrolls at 420px (so
        // toggling a real page does not swing the layout), while a short one stays compact —
        // a fixed height left a measured 282px of empty ground on the seven-line case, which
        // reads as a broken panel rather than a window. The darker ground plus a 1px inset edge
        // is what makes it read as a pane at all: at 0.22 alpha it measured 1.09:1 against the
        // card, which the gate called "a whisper-quiet panel".
        <pre
          className="mono m-0 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed"
          style={{
            maxHeight: FRAME_HEIGHT,
            borderColor: "var(--border)",
            background: "rgba(0, 0, 0, 0.42)",
            boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
            color: "var(--text-dim)",
          }}
          data-testid="html-preview-source"
        >
          {code}
        </pre>
      )}
    </div>
  );
}
