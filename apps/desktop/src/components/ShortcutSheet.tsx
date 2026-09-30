/**
 * The keyboard-shortcut sheet (⌘/ / Ctrl+/).
 *
 * Renders `SHORTCUTS` verbatim, which is the whole design: the list a user reads is the list the
 * binder matched against, so a binding cannot exist without being documented, and a documented key
 * cannot quietly stop working. `shortcuts.test.ts` asserts the table is coherent for the same
 * reason — this component has no independent knowledge to get wrong.
 *
 * The palette's own keys (arrows, Enter) are listed too, because they are keyboard behaviour the
 * app owns and they appear in no table entry: they are modal-scoped, not global.
 */
import { bindingOf, comboLabel, SHORTCUTS } from "../lib/keys/shortcuts";
import { Modal } from "./atoms";

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={560}>
      <table className="w-full text-[12px]">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
              <td className="py-2 pr-3">
                <kbd
                  className="mono rounded border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
                >
                  {comboLabel(s.combo)}
                </kbd>
              </td>
              <td className="py-2">
                <div style={{ color: "var(--text)" }}>{s.label}</div>
                <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>{s.where}</div>
              </td>
            </tr>
          ))}
          <tr className="border-t align-top" style={{ borderColor: "var(--border)" }}>
            <td className="py-2 pr-3">
              <kbd
                className="mono rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
              >
                ↑ ↓ · Enter
              </kbd>
            </td>
            <td className="py-2">
              <div style={{ color: "var(--text)" }}>Move through the palette and run the highlighted command</div>
              <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                In the command palette ({comboLabel(bindingOf("palette").combo)})
              </div>
            </td>
          </tr>
          <tr className="border-t align-top" style={{ borderColor: "var(--border)" }}>
            <td className="py-2 pr-3">
              <kbd
                className="mono rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
              >
                Esc
              </kbd>
            </td>
            <td className="py-2">
              <div style={{ color: "var(--text)" }}>Close a dialog</div>
              <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                Anywhere a dialog is open — it closes that rather than stopping a turn
              </div>
            </td>
          </tr>
          <tr className="border-t align-top" style={{ borderColor: "var(--border)" }}>
            <td className="py-2 pr-3">
              <kbd
                className="mono rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
              >
                Enter · Shift+Enter
              </kbd>
            </td>
            <td className="py-2">
              <div style={{ color: "var(--text)" }}>Send · newline</div>
              <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>In the composer</div>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-3 text-[11px]" style={{ color: "var(--text-dim)" }}>
        Every screen is also reachable from the sidebar, and every command in the palette has a
        button somewhere in the app — the keys are a shortcut, never the only way.
      </p>
    </Modal>
  );
}
