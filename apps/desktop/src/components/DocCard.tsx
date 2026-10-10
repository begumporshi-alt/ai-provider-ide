/**
 * DocCard — the rich document card for the chat transcript.
 *
 * Modeled on what ZCode shows for a plan: a titled card with an icon-labelled header, a copy
 * button, a truncated preview that fades out, and a centered "View full plan →" pill that
 * expands the whole document in place. Before this component a plan-mode answer rendered as one
 * long markdown message — correct, but indistinguishable from every other paragraph, which is
 * exactly the "where does the plan end and the prose begin" reading problem the card solves.
 *
 * The card is generic on purpose (`label` prop): plan mode passes "Plan" today, and any other
 * long document the assistant should set apart can pass its own label without a second component.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/** The preview's ceiling. About four content lines — enough to read the shape, short enough that
 *  the fade reads as "there is more" rather than "this is all". */
const PREVIEW_MAX_PX = 176;

export interface SplitDocTitle {
  /** The document's title line, or null when the body opens with prose instead of a heading. */
  title: string | null;
  /** The body with the title line removed, so the card does not print the heading twice. */
  body: string;
}

/** Inline markdown the title should not carry into a plain-text heading. */
function cleanTitle(s: string): string {
  return s.replace(/[*_`]/g, "").trim();
}

/**
 * Peel the document's title off the body: the first non-empty line, only when it is an `h1` or
 * `h2` heading (deeper headings are sections, not titles) — or nothing, for a plan that opens in
 * prose, in which case the card header's label alone identifies it.
 */
export function splitDocTitle(source: string): SplitDocTitle {
  const lines = source.split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first += 1;
  const m = first < lines.length ? /^#{1,2}\s+(.+)$/.exec(lines[first].trim()) : null;
  if (!m) return { title: null, body: source };
  return {
    title: cleanTitle(m[1]),
    body: lines.slice(0, first).concat(lines.slice(first + 1)).join("\n"),
  };
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]" aria-hidden="true">
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2" />
      <path d="M9 12h6m-6 3.5h4" />
    </svg>
  );
}

/**
 * The copy glyph, exported for the HTML card too — one icon, so the two cards' header actions
 * cannot drift apart. Stroke width 2 (not the 1.6 used for decorative glyphs): at 1.6 the
 * rendered strokes measured ~2.8:1 against the card even with a compliant token colour, because
 * a 1px hairline never reaches its own ink under antialiasing.
 */
export function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[14px] w-[14px]" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" />
    </svg>
  );
}

export function DocCard({
  source,
  label = "Plan",
  testId = "doc-card",
}: {
  source: string;
  /** What the document is — the header's icon label and the pill's noun ("View full plan"). */
  label?: string;
  testId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { title, body } = useMemo(() => splitDocTitle(source), [source]);

  // The fade + pill only make sense when the content actually overflows the preview — a
  // three-line plan gets the card's frame without a pointless "view full" button. The clamp is
  // applied FIRST and the overflow measured against it: measuring an unclamped box would find
  // scrollHeight === clientHeight and never show the pill at all.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    // Re-measure after Prism highlighting and layout settles, and on any resize — a stale
    // measurement is what shows a pill over full content.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body]);

  const copy = () => {
    void navigator.clipboard.writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border"
      style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 px-4 pt-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
        <ClipboardIcon />
        <span className="font-medium">{label}</span>
        <button
          type="button"
          className="card-icon-btn ml-auto rounded p-1"
          style={copied ? { color: "var(--success)" } : undefined}
          onClick={copy}
          title={copied ? "Copied" : `Copy the full ${label.toLowerCase()}`}
          data-testid="doc-card-copy"
        >
          {copied ? "✓" : <CopyIcon />}
        </button>
      </div>

      {title && (
        <h3
          className="px-4 pt-2 text-[17px] font-semibold leading-snug"
          style={{ color: "var(--text)" }}
          data-testid="doc-card-title"
        >
          {title}
        </h3>
      )}

      <div className="relative">
        <div
          ref={bodyRef}
          className="doc-card-body px-4 pt-1"
          style={expanded ? undefined : { maxHeight: PREVIEW_MAX_PX, overflow: "hidden" }}
          data-testid="doc-card-body"
        >
          <Markdown source={body} />
        </div>
        {!expanded && overflows && (
          <>
            {/* The fade must reach OPAQUE by the pill's band, not drift toward it: a soft
                transparent→surface ramp measured invisible at the gate — the last clipped line
                rendered at full brightness and the preview read as accidentally cut rather than
                deliberately clamped. Opaque at 65% of 80px puts solid surface behind the pill. */}
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-20"
              style={{ background: "linear-gradient(to bottom, transparent 0%, var(--surface-2) 65%)" }}
            />
            <div className="absolute inset-x-0 bottom-3 flex justify-center">
              <button
                type="button"
                className="rounded-full px-4 py-1.5 text-[12px] font-medium shadow-md transition-opacity hover:opacity-90"
                style={{ background: "var(--text)", color: "var(--surface)" }}
                onClick={() => setExpanded(true)}
                data-testid="doc-card-view"
              >
                View full {label.toLowerCase()} →
              </button>
            </div>
          </>
        )}
      </div>

      {expanded && (
        <div className="flex justify-center px-4 pb-3 pt-1">
          <button
            type="button"
            className="card-icon-btn rounded-full border px-3.5 py-1 text-[11px]"
            // `--border-strong` measured 1.3:1 here — an outline the gate could not see, leaving
            // only the label to carry the affordance. `--text-faint` puts the edge at ~3:1.
            style={{ borderColor: "var(--text-faint)" }}
            onClick={() => setExpanded(false)}
            data-testid="doc-card-collapse"
          >
            Show less ↑
          </button>
        </div>
      )}
    </div>
  );
}
