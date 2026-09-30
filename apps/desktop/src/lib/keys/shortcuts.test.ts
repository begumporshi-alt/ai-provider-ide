/**
 * Shortcut matching, and the coherence of the table the help sheet renders.
 *
 * The matcher is the load-bearing part: a binder that fires on the wrong chord is invisible until
 * a user loses a keystroke to it, and the two ways that happens are (a) treating Ctrl as ⌘ on
 * macOS, where Ctrl+K is a readline binding inside the composer, and (b) ignoring the other
 * modifiers, so Ctrl+Shift+K does whatever Ctrl+K does. Both are asserted below, from a plain
 * object — no DOM, which is why the matcher lives in a `.ts` module.
 */
import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  comboLabel,
  comboMatches,
  isEditableTarget,
  shortcutFor,
  type KeyLike,
} from "./shortcuts";

/** A keydown with only the fields the matcher reads, defaulting to "nothing held". */
function key(k: string, held: Partial<Omit<KeyLike, "key">> = {}): KeyLike {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held };
}

const MAC = true;
const PC = false;

describe("combo matching reads the platform's command key", () => {
  it("takes Meta on macOS and Ctrl elsewhere — never both", () => {
    expect(comboMatches(key("k", { metaKey: true }), { key: "k", mod: true }, MAC)).toBe(true);
    expect(comboMatches(key("k", { ctrlKey: true }), { key: "k", mod: true }, PC)).toBe(true);
    // The one that matters: Ctrl+K on a Mac is "kill to end of line" in a text field. Firing the
    // palette for it would break editing in the composer.
    expect(comboMatches(key("k", { ctrlKey: true }), { key: "k", mod: true }, MAC)).toBe(false);
    expect(comboMatches(key("k", { metaKey: true }), { key: "k", mod: true }, PC)).toBe(false);
  });

  it("ignores case, so caps lock and shift do not break a binding", () => {
    expect(comboMatches(key("K", { metaKey: true }), { key: "k", mod: true }, MAC)).toBe(true);
    expect(comboMatches(key("k", { metaKey: true }), { key: "K", mod: true }, MAC)).toBe(true);
  });

  it("requires the un-held modifiers to be absent, not merely tolerated", () => {
    // Ctrl+Shift+K must not run the Ctrl+K command, or every shifted chord becomes a landmine.
    expect(comboMatches(key("k", { ctrlKey: true, shiftKey: true }), { key: "k", mod: true }, PC)).toBe(false);
    // A bare Ctrl+Shift+O is a different chord from mod+shift+O: the command key is not optional.
    expect(comboMatches(key("o", { shiftKey: true }), { key: "o", mod: true, shift: true }, PC)).toBe(false);
    expect(comboMatches(key("o", { metaKey: true }), { key: "o", mod: true, shift: true }, MAC)).toBe(false);
    expect(comboMatches(key("o", { metaKey: true, shiftKey: true }), { key: "o", mod: true, shift: true }, MAC)).toBe(true);
    // Alt is not a modifier any binding uses, so holding it must miss rather than match.
    expect(comboMatches(key("k", { metaKey: true, altKey: true }), { key: "k", mod: true }, MAC)).toBe(false);
  });

  it("matches a bare Escape only when no command key is held", () => {
    expect(comboMatches(key("Escape"), { key: "Escape" }, MAC)).toBe(true);
    // Cmd+Esc is a system chord (macOS: force-quit dialog). Not ours to take.
    expect(comboMatches(key("Escape", { metaKey: true }), { key: "Escape" }, MAC)).toBe(false);
  });
});

describe("shortcutFor resolves an event against the table", () => {
  it("finds each binding by its own chord", () => {
    expect(shortcutFor(key("k", { metaKey: true }), MAC)?.id).toBe("palette");
    expect(shortcutFor(key("/", { metaKey: true }), MAC)?.id).toBe("help");
    expect(shortcutFor(key("o", { metaKey: true, shiftKey: true }), MAC)?.id).toBe("new-chat");
    expect(shortcutFor(key("Escape"), MAC)?.id).toBe("stop");
  });

  it("answers undefined for a key the app does not bind", () => {
    // The caller must be able to tell "not ours" from "ours", because only the former may reach
    // the app — swallowing everything would break typing.
    expect(shortcutFor(key("j", { metaKey: true }), MAC)).toBeUndefined();
    expect(shortcutFor(key("Enter"), MAC)).toBeUndefined();
  });
});

describe("the editable guard", () => {
  it("recognises every control a user types into", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("leaves ordinary elements alone", () => {
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    // A detached target (the window itself) has no tagName at all.
    expect(isEditableTarget({})).toBe(false);
  });
});

describe("comboLabel prints keys a user can press", () => {
  it("uses the platform's own notation", () => {
    expect(comboLabel({ key: "k", mod: true }, MAC)).toBe("⌘K");
    expect(comboLabel({ key: "o", mod: true, shift: true }, MAC)).toBe("⌘⇧O");
    expect(comboLabel({ key: "Escape" }, MAC)).toBe("Esc");
    expect(comboLabel({ key: "k", mod: true }, PC)).toBe("Ctrl+K");
    expect(comboLabel({ key: "o", mod: true, shift: true }, PC)).toBe("Ctrl+Shift+O");
  });
});

describe("the table is coherent, because the help sheet renders it verbatim", () => {
  it("has no duplicate ids and no duplicate chords", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Two entries on one chord means one of them can never fire, and the sheet would list both as
    // if they worked. Chords are compared per platform, since mod differs between them.
    for (const mac of [true, false]) {
      const chords = SHORTCUTS.map((s) => comboLabel(s.combo, mac));
      expect(new Set(chords).size, `duplicate chord with mac=${mac}`).toBe(chords.length);
    }
  });

  it("describes every entry, since the sheet prints these strings", () => {
    for (const s of SHORTCUTS) {
      expect(s.label.length, `${s.id} has no label`).toBeGreaterThan(4);
      expect(s.where.length, `${s.id} does not say where it applies`).toBeGreaterThan(4);
      // A label is a sentence for a human; an identifier means it leaked from the code.
      expect(s.label).not.toMatch(/^[a-z-]+$/);
    }
  });
});
