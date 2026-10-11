/**
 * Session-references drawer — the source links this conversation has gathered, and the one place
 * to curate them.
 *
 * The list is mostly derived (lib/chat/turn/session-references): URLs in the user's messages,
 * pages the agent fetched, links that rode along in search results. The drawer adds the two
 * things derivation cannot do — pin a link by hand, and remove one (a removal is remembered as a
 * dismissal, or the next transcript change would resurrect it). Every reply's system turn carries
 * the block built from this list; the footer says so, because a list that quietly shapes every
 * answer is exactly the kind of control that must be findable.
 *
 * Pinned under the skills drawer's rail on the same right edge — the third seat in the stack
 * (runs, skills, references).
 */
import { useState } from "react";
import { normalizeUrl, type SessionReference } from "../lib/chat/turn/session-references";
import { useUi } from "../ui-state";

const ORIGIN_LABEL: Record<SessionReference["origin"], string> = {
  user: "you",
  agent: "agent",
  manual: "added",
};

export function SessionReferencesDrawer({
  refs,
  onAdd,
  onRemove,
}: {
  refs: ReadonlyArray<SessionReference>;
  /** Pin a link by hand. Invalid input never reaches here — the drawer validates first. */
  onAdd: (url: string) => void;
  /** Drop a reference from the session — derived ones stay dropped across transcript changes. */
  onRemove: (url: string) => void;
}) {
  // The runs drawer's open state, read only for the side-by-side offset (same rule as the
  // skills drawer's).
  const runsDrawerOpen = useUi((s) => s.runsDrawerOpen);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = () => {
    const url = normalizeUrl(draft);
    if (!url) {
      setInvalid(true);
      return;
    }
    onAdd(url);
    setDraft("");
    setInvalid(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open session references drawer"
        data-testid="session-refs-rail"
        // Below the runs rail (top-2) and the skills rail (top-10) on the same edge.
        className="absolute right-2 top-[4.5rem] z-30 flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-opacity hover:opacity-90"
        style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}
        title="The source links this session has gathered — every reply reads them"
      >
        {refs.length > 0 && (
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <span className="mono">{refs.length} refs</span>
      </button>
    );
  }

  return (
    <aside
      className={`absolute bottom-2 top-2 z-30 flex w-72 flex-col overflow-hidden rounded-xl border shadow-xl ${
        // Same offset rule as the skills drawer: stand beside the runs drawer, not over it.
        runsDrawerOpen ? "right-[19rem]" : "right-2"
      }`}
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="session-refs-drawer"
      aria-label="Session references"
    >
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Session references
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close session references drawer"
          className="rounded px-1 text-[11px] transition-opacity hover:opacity-80"
          style={{ color: "var(--text-faint)" }}
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Sources of this session
        </p>
        {refs.length === 0 ? (
          <p className="px-1 pb-2 text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="session-refs-empty">
            No references yet — links you paste and pages the agent fetches collect here.
          </p>
        ) : (
          refs.map((r) => (
            <div
              key={r.url}
              data-testid="session-refs-row"
              className="mb-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
            >
              <span
                className="mt-0.5 shrink-0 rounded px-1 py-px text-[9px] uppercase tracking-wide"
                style={{
                  background: r.origin === "user" ? "var(--accent-soft)" : "var(--surface)",
                  color: r.origin === "user" ? "var(--accent)" : "var(--text-faint)",
                  border: "1px solid var(--border)",
                }}
              >
                {ORIGIN_LABEL[r.origin]}
              </span>
              <span className="mono min-w-0 flex-1 break-all text-[11px]" title={r.url}>
                {r.url}
              </span>
              <button
                type="button"
                onClick={() => onRemove(r.url)}
                aria-label={`Remove ${r.url} from this session's references`}
                className="shrink-0 rounded px-1 text-[11px] transition-opacity hover:opacity-80"
                style={{ color: "var(--text-faint)" }}
                title="Remove from this session"
              >
                ✕
              </button>
            </div>
          ))
        )}

        <div className="mt-2 border-t px-1 pt-2" style={{ borderColor: "var(--border)" }}>
          <p className="pb-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
            Pin a link
          </p>
          <div className="flex items-center gap-1.5">
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="https://…"
              aria-label="Add a reference link"
              data-testid="session-refs-input"
              className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px] outline-none"
              style={{
                borderColor: invalid ? "var(--danger)" : "var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              onClick={submit}
              data-testid="session-refs-add"
              className="shrink-0 rounded-md border px-2 py-1 text-[11px] transition-opacity hover:opacity-80"
              style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
            >
              add
            </button>
          </div>
          {invalid && (
            <p className="px-1 pt-1 text-[10px]" style={{ color: "var(--danger)" }} data-testid="session-refs-invalid">
              That does not read as an http(s) link.
            </p>
          )}
        </div>
      </div>
      <p className="shrink-0 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}>
        Every reply's system prompt lists these sources.
      </p>
    </aside>
  );
}
