/**
 * Keyboard shortcuts: the one table, and the two pure functions that read it.
 *
 * # Why a table rather than a listener per feature
 *
 * The help sheet has to list exactly what the app does — a shortcut nobody can discover is a
 * shortcut nobody uses, and a help sheet maintained by hand drifts from the bindings the first
 * time one changes. Here the same entry answers both questions: `SHORTCUTS` is what the binder
 * matches against and what the sheet renders, so the list cannot disagree with the behaviour.
 *
 * # Why the matching is here and not in a component
 *
 * vitest runs in a node environment with no jsdom, and `.tsx` is outside its include glob, so a
 * matcher living in a component would be untestable — the same reasoning `lib/ledger/format.ts`
 * records. `KeyLike`/`TargetLike` are the structural subsets the functions actually read, so a
 * test can pass `{ key: "k", metaKey: true, … }` with no DOM at all.
 *
 * # Why `mod` is one flag and not meta-or-ctrl
 *
 * `mod` means "the platform's command key": Meta on macOS, Ctrl everywhere else. Matching either
 * one on every platform would make Ctrl+K work on macOS, where Ctrl+K is a real readline binding
 * inside text fields (kill-to-end-of-line) — hijacking it would break editing in the composer to
 * serve a shortcut the user did not ask for. `isMacPlatform` picks, and it defaults to the
 * presence of `window` so a test can assert both branches without one.
 */

/** The event fields a matcher reads. Satisfied by `KeyboardEvent`, and by a plain object in tests. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The event-target fields the editable guard reads. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** One binding. `combo.key` is compared case-insensitively so caps-lock does not break it. */
export interface Shortcut {
  id: ShortcutId;
  combo: { key: string; mod?: boolean; shift?: boolean; alt?: boolean };
  /** What the user gets. Read by the help sheet — so it is a sentence, not an identifier. */
  label: string;
  /** Where it applies, so the sheet can say why a key did nothing on another screen. */
  where: string;
}

export type ShortcutId = "palette" | "help" | "new-chat" | "stop";

/**
 * Every global binding in the app.
 *
 * Deliberately short, and each entry has to justify its key:
 *
 * - `mod+K` — the near-universal "command palette". Also the only way to reach a screen without
 *   the sidebar, which is the point of having a palette at all.
 * - `mod+/` — help. Not `?`: `?` is a printable character, so binding it means either hijacking
 *   a keystroke inside the composer or a guard subtle enough to be wrong in one direction.
 * - `mod+shift+O` — new chat. **Not `mod+N`**: in a browser (which is what the test harness is)
 *   Ctrl/Cmd+N is the browser's own "new window" and never reaches the page, and in the packaged
 *   Tauri app the same chord is the native menu's. A binding that works in neither is worse than
 *   no binding — this is the chord ChatGPT's web app uses for the same reason.
 * - `Escape` — stop the running turn, but only while one is running. Nothing else in the app uses
 *   Escape for a non-dismissive action, and stopping is the one thing a user reaches for by reflex
 *   when a model runs long.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", combo: { key: "k", mod: true }, label: "Open the command palette", where: "Anywhere" },
  { id: "help", combo: { key: "/", mod: true }, label: "Show keyboard shortcuts", where: "Anywhere" },
  { id: "new-chat", combo: { key: "o", mod: true, shift: true }, label: "Start a new chat", where: "Assistant" },
  { id: "stop", combo: { key: "Escape" }, label: "Stop the running turn", where: "Assistant, while a turn is running" },
];

/**
 * The binding for an id.
 *
 * `SHORTCUTS` is the table; this is how a caller names one entry without depending on its position
 * in the array, which is what `SHORTCUTS[0]` would do — and an index that silently becomes a
 * different shortcut the day an entry is inserted above it is a bug the help text would report
 * while looking correct.
 */
export function bindingOf(id: ShortcutId): Shortcut {
  const found = SHORTCUTS.find((s) => s.id === id);
  // Not a lookup that can miss: the table is a literal in this module and `id` is its own union.
  if (!found) throw new Error(`no shortcut registered for "${id}"`);
  return found;
}

/** The platform's command key is Meta on macOS and Ctrl elsewhere. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // `navigator.platform` is deprecated but still the only field a browser reports consistently
  // here; `userAgentData` is Chromium-only. Either way the answer only picks which key to read.
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
}

/**
 * Does this event trigger this combo?
 *
 * Shift and Alt are required to match exactly (`undefined` meaning "must not be held"), while the
 * command key is compared against the platform's own. Exactness on the modifiers is what keeps
 * Ctrl+Shift+K from firing the Ctrl+K binding.
 */
export function comboMatches(e: KeyLike, combo: Shortcut["combo"], mac: boolean = isMacPlatform()): boolean {
  if (e.key.toLowerCase() !== combo.key.toLowerCase()) return false;
  const cmd = combo.mod ? (mac ? e.metaKey : e.ctrlKey) : true;
  const noOtherCmd = combo.mod ? true : !e.metaKey && !e.ctrlKey;
  return (
    cmd &&
    noOtherCmd &&
    Boolean(combo.shift) === e.shiftKey &&
    Boolean(combo.alt) === e.altKey
  );
}

/**
 * The binding this event fires, or undefined.
 *
 * Exported as the single entry point the shell's listener uses, so "which shortcut is this" is one
 * testable call rather than a chain of `if`s spread through an effect.
 */
export function shortcutFor(e: KeyLike, mac: boolean = isMacPlatform()): Shortcut | undefined {
  return SHORTCUTS.find((s) => comboMatches(e, s.combo, mac));
}

/**
 * Is the event aimed at a text field?
 *
 * The guard that keeps a future single-key binding from eating a keystroke mid-sentence. Modifier
 * combos are exempt at the call site rather than here — the caller knows whether its shortcut is
 * one a user would type (a bare letter) or one that is unambiguous everywhere (Escape, mod+K).
 */
export function isEditableTarget(t: TargetLike | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/**
 * A combo as the sheet prints it: `⇧`/`⌘` glyphs on macOS, words elsewhere.
 *
 * The sheet's whole job is to tell the user which keys to press, and "mod+shift+O" is not that.
 */
export function comboLabel(combo: Shortcut["combo"], mac: boolean = isMacPlatform()): string {
  const parts: string[] = [];
  if (combo.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (combo.shift) parts.push(mac ? "⇧" : "Shift");
  if (combo.alt) parts.push(mac ? "⌥" : "Alt");
  const key = combo.key === "Escape" ? "Esc" : combo.key.toUpperCase();
  // macOS convention is to close up the modifiers ("⌘⇧O"); elsewhere they read as words.
  return mac ? parts.join("") + key : [...parts, key].join("+");
}
