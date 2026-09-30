/**
 * The command palette (⌘K / Ctrl+K).
 *
 * Two kinds of row, and the difference is deliberate rather than decorative: **screens** are the
 * sidebar's list (imported, not copied — see `lib/nav.ts`), and **commands** are actions that do
 * something the sidebar cannot express, like "start a new chat" or "search conversations".
 *
 * A command is only listed when it would actually do something. "New chat" is *refused* while a turn
 * is running — `Chat`'s own button is disabled for the same reason (re-entering the loop mid-stream
 * would interleave two runs into one transcript) — so the palette renders that row disabled and says
 * why, instead of offering a command that silently no-ops. That is the failure this component is
 * most likely to grow: a palette that lists more than it can do is a list of lies.
 */
import { useMemo, useState } from "react";
import { useUi } from "../ui-state";
import { NAV } from "../lib/nav";
import { bindingOf, comboLabel } from "../lib/keys/shortcuts";
import { Modal, inputCls, inputStyle } from "./atoms";

interface Command {
  id: string;
  label: string;
  /** What the row does, shown beside the label — a palette row with only a name is a guess. */
  hint: string;
  /** Present when the command cannot run, with the reason. */
  disabledReason?: string;
  run: () => void;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const go = useUi((s) => s.go);
  const fire = useUi((s) => s.fire);
  const setOverlay = useUi((s) => s.setOverlay);
  const busy = useUi((s) => s.assistantBusy);
  const screen = useUi((s) => s.screen);

  const commands = useMemo<Command[]>(() => {
    const screens: Command[] = NAV.flatMap((g) =>
      g.items.map((it) => ({
        id: `go:${it.id}`,
        label: it.label,
        hint: g.group,
        // Navigating to the screen you are already on is a real no-op, and the palette's job is to
        // tell the truth about what a row will do. It stays listed (so search finds it) and says so.
        disabledReason: it.id === screen ? "already open" : undefined,
        run: () => go(it.id),
      })),
    );
    const actions: Command[] = [
      {
        id: "act:new-chat",
        label: "New chat",
        hint: "Assistant",
        disabledReason: busy ? "a turn is running — press Esc to stop it first" : undefined,
        run: () => {
          go("assistant");
          fire("new-chat");
        },
      },
      {
        id: "act:focus-composer",
        label: "Focus the composer",
        hint: "Assistant",
        run: () => {
          go("assistant");
          fire("focus-composer");
        },
      },
      {
        id: "act:search-conversations",
        label: "Search conversations",
        hint: "History",
        run: () => {
          go("history");
          fire("focus-history-search");
        },
      },
    ];
    return [...actions, ...screens];
  }, [go, fire, busy, screen]);

  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      commands.filter((c) => {
        if (needle.length === 0) return true;
        // Label only, not hint: "Assistant" as a hint would otherwise make every row match the
        // word, which is the opposite of what typing a name should do.
        return c.label.toLowerCase().includes(needle);
      }),
    [commands, needle],
  );

  const pick = (c: Command | undefined) => {
    if (!c || c.disabledReason) return;
    setOverlay(null);
    c.run();
  };

  // Clamped rather than stored, so a narrowing search cannot leave the highlight past the end and
  // make Enter a no-op on a list the user can see.
  const highlighted = Math.min(active, Math.max(0, matches.length - 1));

  return (
    <Modal title="Commands" onClose={onClose} width={520}>
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(matches[highlighted]);
          }
        }}
        placeholder="Go to a screen, or run a command…"
        aria-label="Command palette search"
        className={inputCls}
        style={inputStyle}
      />
      <div className="mt-2 max-h-[320px] overflow-y-auto" role="listbox" aria-label="Commands">
        {matches.length === 0 ? (
          <p className="px-1 py-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
            No screen or command matches “{q}”.
          </p>
        ) : (
          matches.map((c, i) => (
            <button
              key={c.id}
              role="option"
              aria-selected={i === highlighted}
              disabled={Boolean(c.disabledReason)}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              className="block w-full rounded px-2 py-1.5 text-left text-[12px] disabled:opacity-50"
              style={{
                background: i === highlighted ? "var(--surface-2)" : "transparent",
                color: c.disabledReason ? "var(--text-faint)" : "var(--text)",
              }}
            >
              <span className="flex items-baseline gap-2">
                <span className="truncate">{c.label}</span>
                <span className="ml-auto shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {c.disabledReason ?? c.hint}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      {/* The keys that work *inside* the palette, plus the one that opened it. A palette is a modal
          with its own keyboard rules, and they are not discoverable from the list above. */}
      <div className="mt-3 border-t pt-2 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}>
        ↑↓ move · Enter run · Esc close · open with {comboLabel(bindingOf("palette").combo)} ·{" "}
        {comboLabel(bindingOf("help").combo)} for all shortcuts
      </div>
    </Modal>
  );
}
