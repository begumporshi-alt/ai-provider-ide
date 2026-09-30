/**
 * The global keyboard listener, and the two overlays it opens.
 *
 * # Why one listener
 *
 * Every screen is remounted on navigation (`App` renders one at a time), so a listener owned by a
 * screen would have to be re-bound on every route — and the palette has to open on all of them. One
 * listener on the window, owned by `Shell`, is the only arrangement where "⌘K works everywhere"
 * is true by construction rather than by thirteen copies of the same effect.
 *
 * # What it refuses to swallow
 *
 * A shortcut only consumes the event after it matches (`preventDefault`), so an unrelated keystroke
 * still reaches whatever field has focus. The `isEditableTarget` guard is applied to the un-modified
 * entries: Escape is a key people press while typing, and it is meant to keep working there, but a
 * future bare-letter binding must not fire mid-sentence. Modified chords are exempt because a
 * command-key chord inside a text field is unambiguous — that is the whole reason they were chosen.
 */
import { useEffect } from "react";
import { useUi } from "../ui-state";
import { isEditableTarget, shortcutFor } from "../lib/keys/shortcuts";
import { CommandPalette } from "./CommandPalette";
import { ShortcutSheet } from "./ShortcutSheet";

export function ShortcutHost() {
  const overlay = useUi((s) => s.overlay);
  const setOverlay = useUi((s) => s.setOverlay);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = shortcutFor(e);
      if (!hit) return;
      // An overlay owns the keyboard while it is open: Escape belongs to the dialog (the dialog's
      // own listener closes it), and re-opening a palette over a palette would stack modals. The
      // one exception is `help` — switching from the palette to the cheat sheet is a real thing to
      // want, and it is a single keypress rather than a stack because the id replaces the overlay.
      if (overlay !== null && hit.id !== "help") return;
      if (!hit.combo.mod && isEditableTarget(e.target as { tagName?: string; isContentEditable?: boolean } | null)) {
        return;
      }
      e.preventDefault();
      if (hit.id === "palette") setOverlay("palette");
      else if (hit.id === "help") setOverlay("sheet");
      // `new-chat` and `stop` are the Assistant's, and it binds them itself — it is the only
      // component that knows whether a turn is running, and a stop that fired on a screen with
      // nothing to stop would be exactly the kind of command that lies about what it did.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, setOverlay]);

  if (overlay === "palette") return <CommandPalette onClose={() => setOverlay(null)} />;
  if (overlay === "sheet") return <ShortcutSheet onClose={() => setOverlay(null)} />;
  return null;
}
