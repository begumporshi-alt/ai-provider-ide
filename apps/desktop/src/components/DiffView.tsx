/**
 * DiffView — the readable form of a file mutation (Phase 2).
 *
 * `edit_file` / `write_file` used to reach the transcript as raw JSON arguments and a plain text
 * result, which hides the only thing worth seeing: what changed. This renders the change itself,
 * with added/removed colouring and a copy button for the new contents.
 *
 * Presentation only — the diff is computed by `lib/tools/diff` so the two can be tested apart.
 * Long diffs are capped and say so rather than silently dropping lines.
 */
import { useMemo, useState } from "react";
import { unifiedDiff } from "../lib/tools/diff";
import type { FileChange } from "../lib/tools/render";

const LINE_CAP = 200;

const KIND_MARK: Record<string, string> = { add: "+", del: "-", ctx: " " };

export function DiffView({ change, defaultOpen = true }: { change: FileChange; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const diff = useMemo(
    () => unifiedDiff(change.oldText, change.newText, { maxLines: showAll ? 5_000 : LINE_CAP }),
    [change, showAll],
  );

  const verb = change.kind === "edit" ? "edit" : "write";
  const id = `diff-${change.path}`;

  return (
    <div className="mb-2 overflow-hidden rounded border" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: open ? "1px solid var(--border)" : "none" }}>
        <button
          type="button"
          className="text-[11px]"
          style={{ color: "var(--text-dim)" }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Hide the diff" : "Show the diff"}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="mono truncate text-[11px]" style={{ color: "var(--text)" }} title={change.path}>
          {change.path}
        </span>
        <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface)", color: "var(--text-dim)" }}>
          {verb}
        </span>
        <span className="mono text-[11px]" style={{ color: "var(--success)" }}>+{diff.added}</span>
        <span className="mono text-[11px]" style={{ color: "var(--danger)" }}>−{diff.removed}</span>
        <button
          type="button"
          className="ml-auto text-[10px] opacity-60 transition-opacity hover:opacity-100"
          style={{ color: "var(--text-dim)" }}
          onClick={() => {
            void navigator.clipboard.writeText(change.newText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          }}
          title="Copy the new contents"
        >
          {copied ? "✓ copied" : "copy result"}
        </button>
      </div>

      {open && (
        <>
          {change.note && (
            <div className="px-2.5 py-1 text-[10px]" style={{ color: "var(--warn)" }}>
              {change.note}
            </div>
          )}
          <div className="mono max-h-72 overflow-auto px-1 py-1 text-[11px] leading-relaxed" role="group" aria-label={`Diff of ${change.path}`}>
            {diff.lines.map((l, i) => (
              <div key={i} className="flex whitespace-pre" data-kind={l.kind}>
                <span className="w-4 shrink-0 select-none text-center" style={{ color: "var(--text-faint)" }}>
                  {KIND_MARK[l.kind]}
                </span>
                <span
                  className="flex-1 break-all"
                  style={{
                    color: l.kind === "add" ? "var(--success)" : l.kind === "del" ? "var(--danger)" : "var(--text-dim)",
                    background: l.kind === "add" ? "rgba(63,185,80,0.10)" : l.kind === "del" ? "rgba(248,81,73,0.10)" : undefined,
                  }}
                >
                  {l.text || " "}
                </span>
              </div>
            ))}
          </div>
          {diff.truncated && (
            <div className="px-2.5 py-1 text-[10px]" style={{ color: "var(--warn)" }}>
              diff truncated — {diff.added} added, {diff.removed} removed in total.{" "}
              <button type="button" className="underline" onClick={() => setShowAll(true)}>
                show more
              </button>
            </div>
          )}
          {change.path && (
            <div className="px-2.5 py-1 text-[10px]" style={{ color: "var(--text-faint)" }} id={id}>
              workspace-relative path
            </div>
          )}
        </>
      )}
    </div>
  );
}
