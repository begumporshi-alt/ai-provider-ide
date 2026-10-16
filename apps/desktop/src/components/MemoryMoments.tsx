/**
 * The two visible moments of the memory loop, inside the chat.
 *
 * Recall has always been silent — the block rides a system message, so an answer could quietly
 * use knowledge the user never saw it consult. The recall card says what an answer drew on, and
 * lets the reader act on it right there (pin, forget) instead of making the Memory screen the
 * only place a memory can be corrected.
 *
 * Learning was silent the other way: distillation stored atoms in the background, so the
 * assistant visibly *knew* things it was never seen *learn*. The learning strip surfaces each
 * stored atom the moment distillation lands it, with the same two actions.
 *
 * Both render nothing when there is nothing to say.
 */
import { useEffect, useState } from "react";
import { forgetMemory, setMemoryPinned } from "../store";
import type { RecalledMemory } from "../lib/chat/turn/memory-refs";
import type { LearnedMemory } from "../lib/memory/engine";

const LAYER_COLOR: Record<string, string> = {
  L3: "var(--success)",
  L2: "var(--info)",
  L1: "var(--text-dim)",
  L0: "var(--text-faint)",
};

const LAYER_LABEL: Record<string, string> = {
  L3: "core",
  L2: "scenario",
  L1: "fact",
  L0: "raw",
};

/** "2h ago"-style label; coarse on purpose — a memory's age is context, not a timestamp to sort by. */
function ageLabel(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function MemoryRow({
  m,
  onChange,
  testPrefix,
}: {
  m: RecalledMemory;
  onChange: (next: RecalledMemory | null) => void;
  testPrefix: string;
}) {
  const [busy, setBusy] = useState(false);
  const pin = async () => {
    setBusy(true);
    try {
      const ok = await setMemoryPinned(m.id, !m.pinned);
      if (ok) onChange({ ...m, pinned: !m.pinned });
    } finally {
      setBusy(false);
    }
  };
  const forget = async () => {
    setBusy(true);
    try {
      const ok = await forgetMemory(m.id);
      // A row that was already forgotten (another window, a supersede) is gone from recall
      // either way — dropping it here matches the store rather than arguing with it.
      if (ok) onChange(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="mt-1 flex items-start gap-1.5 rounded border px-1.5 py-1"
      style={{ borderColor: "var(--border)" }}
      data-testid={`${testPrefix}-row`}
    >
      <span
        className="mono shrink-0 rounded px-1 text-[9px] uppercase"
        style={{ color: LAYER_COLOR[m.layer] ?? "var(--text-faint)", background: "var(--surface-2)" }}
      >
        {LAYER_LABEL[m.layer] ?? m.layer}
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-snug" style={{ color: "var(--text-dim)" }}>
        {m.text}
      </span>
      <span className="shrink-0 text-[9px]" style={{ color: "var(--text-faint)" }}>
        {ageLabel(m.at)}
      </span>
      <button
        type="button"
        className="mono shrink-0 rounded border px-1 text-[9px]"
        style={{ color: m.pinned ? "var(--success)" : "var(--text-faint)", borderColor: "var(--border)", background: "var(--surface-2)" }}
        onClick={() => void pin()}
        disabled={busy}
        data-testid={`${testPrefix}-pin`}
        aria-label={m.pinned ? `unpin memory: ${m.text}` : `pin memory: ${m.text}`}
      >
        {m.pinned ? "pinned" : "pin"}
      </button>
      <button
        type="button"
        className="mono shrink-0 rounded border px-1 text-[9px]"
        style={{ color: "var(--danger)", borderColor: "var(--border)", background: "var(--surface-2)" }}
        onClick={() => void forget()}
        disabled={busy}
        data-testid={`${testPrefix}-forget`}
        aria-label={`forget memory: ${m.text}`}
      >
        forget
      </button>
    </div>
  );
}

/**
 * What an answer knew before it answered. Collapsed by default — one quiet line under the reply;
 * a turn that recalled nothing renders nothing at all.
 */
export function RecallCard({ memories }: { memories: RecalledMemory[] }) {
  const [items, setItems] = useState<RecalledMemory[]>(memories);
  const [open, setOpen] = useState(false);
  // The turn engine patches the bubble once, before the stream starts, so a fresh array here
  // means a fresh recall — adopt it.
  useEffect(() => {
    setItems(memories);
  }, [memories]);
  if (items.length === 0) return null;
  return (
    <div
      data-testid="recall-card"
      className="ml-3.5 mt-1 rounded-md border px-2 py-1.5 text-[11px]"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        data-testid="recall-toggle"
        aria-expanded={open}
      >
        <span style={{ color: "var(--info)" }} aria-hidden="true">
          ✦
        </span>
        <span style={{ color: "var(--text-dim)" }}>
          Drew on {items.length === 1 ? "1 thing" : `${items.length} things`} I remember
        </span>
        {items.some((m) => m.pinned) && (
          <span className="text-[9px]" style={{ color: "var(--success)" }}>
            · pinned
          </span>
        )}
        <span className="ml-auto text-[9px]" style={{ color: "var(--text-faint)" }}>
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="mt-0.5">
          {items.map((m) => (
            <MemoryRow
              key={m.id}
              m={m}
              testPrefix="recall"
              onChange={(next) =>
                setItems((prev) => (next ? prev.map((p) => (p.id === next.id ? next : p)) : prev.filter((p) => p.id !== m.id)))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What the assistant just learned. One row per distilled atom, newest last, expandable in place
 * with the same pin/forget actions as the recall card. Dismissing a row only clears the moment —
 * the atom itself lives on in the Memory screen until forgotten there or here.
 */
export function LearnedStrip({
  items,
  onDismiss,
}: {
  items: LearnedMemory[];
  onDismiss: (id: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <div data-testid="learned-strip" className="mt-2 space-y-1">
      {items.map((m) => (
        <div key={m.id}>
          <button
            type="button"
            className="aip-rise flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]"
            style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
            onClick={() => setOpenId((v) => (v === m.id ? null : m.id))}
            data-testid="learned-chip"
            aria-expanded={openId === m.id}
          >
            <span style={{ color: "var(--success)" }} aria-hidden="true">
              ✦
            </span>
            <span className="max-w-[36ch] truncate">Noted: {m.text}</span>
          </button>
          {openId === m.id && (
            <MemoryRow
              m={{ id: m.id, layer: m.layer, text: m.text, at: Date.now(), pinned: false }}
              testPrefix="learned"
              onChange={(next) => {
                if (!next) {
                  setOpenId(null);
                  onDismiss(m.id);
                }
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
