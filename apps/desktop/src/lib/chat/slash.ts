/**
 * Slash commands: the registry, and the one question the composer asks of it.
 *
 * A registry rather than a `switch` in the key handler, for the same reason `lib/keys/shortcuts.ts`
 * is a table: the hint list the user sees and the behaviour that runs have to be the same data, or
 * the menu becomes a list of things that may or may not work. Commands are also the one place a
 * *type* of the draft changes meaning — "/clear" is not a message to send — so the parse lives here,
 * in a `.ts` module a test can reach (vitest runs without jsdom).
 *
 * Deliberately tiny: four commands that do something the UI already does, so this file adds a way to
 * reach them rather than new behaviour to maintain.
 */

export type SlashCommandId = "clear" | "model" | "image" | "compact";

export interface SlashCommand {
  id: SlashCommandId;
  /** What the user types, without the slash. */
  name: string;
  /** One line in the menu — an argument for the command existing. */
  summary: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "clear", name: "clear", summary: "Start a new chat, emptying this transcript" },
  { id: "model", name: "model", summary: "Open the model picker" },
  { id: "image", name: "image", summary: "Switch to the Image tab" },
  { id: "compact", name: "compact", summary: "Summarise older turns to free context now" },
];

/** A parsed command, or null when the draft is an ordinary message. */
export interface ParsedSlash {
  command: SlashCommand;
  /** Everything after the command word, trimmed. Empty when the user typed just "/clear". */
  args: string;
}

/**
 * The command a draft names, or `null`.
 *
 * Only the FIRST word counts, and only when it is the whole draft or is followed by a space. That
 * keeps two things working that a looser rule breaks:
 *
 *  - `/clearer is a word` stays a message, rather than being read as `/clear` with "er" as arguments;
 *  - a multi-line draft that merely *starts* with something slash-like is still a message once the
 *    user has written a second line, so a stray "/" cannot swallow a real prompt.
 */
export function parseSlash(draft: string): ParsedSlash | null {
  const text = draft.replace(/^\s+/, "");
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  // A newline means the user is writing a prompt, not invoking anything.
  if (rest.includes("\n")) return null;
  const spaceAt = rest.indexOf(" ");
  const name = (spaceAt === -1 ? rest : rest.slice(0, spaceAt)).toLowerCase();
  const args = spaceAt === -1 ? "" : rest.slice(spaceAt + 1).trim();
  // An unknown name is not a command. Returning null makes the draft a message again, which is what
  // the user sees: the menu is not offering it, so Enter must not pretend it was one.
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}

/**
 * The commands a partially-typed first word matches, for the menu.
 *
 * Prefix matching, not fuzzy: the menu appears while the user is still typing the name, and
 * "find anything containing c" would offer `/compact` for "/c" and `/clear` for "/cl" — both fine —
 * but a subsequence match would offer `/clear` for "/cr" too, at which point the list stops being a
 * prediction of what Enter will do.
 */
export function matchSlashCommands(draft: string): SlashCommand[] {
  const text = draft.replace(/^\s+/, "");
  if (!text.startsWith("/")) return [];
  const rest = text.slice(1);
  if (rest.includes("\n") || rest.includes(" ")) return [];
  const prefix = rest.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
