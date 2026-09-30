/**
 * `@file` mentions: finding the active one, and turning it into context before a send.
 *
 * The reference is resolved **on send**, not while typing: the draft is what the user sees, and
 * rewriting it under the caret as they type makes the composer fight them. `expandMentions` returns
 * both the message text and the files it inlined, so the UI can say which files the model actually
 * received — a mention that matched nothing must not look like context the model got.
 *
 * A reference is a path, and paths are the workspace's — so expansion is bounded and root-relative by
 * construction: the caller only ever offers paths the host's own directory listing returned.
 */

/** A workspace file the composer can offer. */
export interface MentionCandidate {
  /** Path relative to the workspace root, e.g. `src/main.rs`. */
  path: string;
  /** Rough size for the menu, when the listing provides it. */
  bytes?: number;
}

/**
 * The `@fragment` under or immediately before the caret, or null.
 *
 * Only the word the caret sits in counts, and only if that word starts with `@`. Anything else — an
 * email address mid-sentence, an `@` that is not at a word start — is left alone, because inserting a
 * file suggestion into a sentence the user is writing is worse than not offering one.
 */
export function activeMention(draft: string, caret: number): { start: number; fragment: string } | null {
  const at = Math.min(Math.max(caret, 0), draft.length);
  // Walk back to the start of the word the caret is in.
  let i = at;
  while (i > 0 && !/[\s\n]/.test(draft[i - 1]!)) i -= 1;
  const word = draft.slice(i, at);
  if (!word.startsWith("@")) return null;
  // A word with a newline in it is two words; the walk above cannot cross whitespace, so this only
  // guards a caret placed after a newline inside what looked like one token.
  if (word.includes("\n")) return null;
  return { start: i, fragment: word.slice(1) };
}

/**
 * Candidates matching a fragment, best first.
 *
 * Scoring is intentionally shallow: basename prefix beats basename substring beats any path
 * substring. Deep fuzzy scoring would rank a file the user did not mean above the one they did, and
 * the listing is already root-confined and small.
 */
export function matchMentions(files: readonly MentionCandidate[], fragment: string, limit = 8): MentionCandidate[] {
  const f = fragment.toLowerCase();
  const scored: { file: MentionCandidate; score: number }[] = [];
  for (const file of files) {
    const path = file.path.toLowerCase();
    const base = path.split("/").pop() ?? path;
    let score: number;
    if (f === "") score = 3;
    else if (base.startsWith(f)) score = 0;
    else if (base.includes(f)) score = 1;
    else if (path.includes(f)) score = 2;
    else continue;
    // Shorter paths first inside a band: `main.rs` over `src/deep/nested/main.rs`.
    scored.push({ file, score: score * 1000 + path.length });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.file);
}

/** Replace the active mention with a chosen path, leaving the caret after it. */
export function applyMention(draft: string, start: number, caret: number, path: string): { text: string; caret: number } {
  const before = draft.slice(0, start);
  const after = draft.slice(caret);
  const text = `${before}@${path} ${after}`;
  return { text, caret: before.length + path.length + 2 };
}

/** One file inlined into the outgoing message. */
export interface InlinedFile {
  path: string;
  content: string;
  /** Set when the file was too large to send whole; the block says so in-band. */
  truncated?: boolean;
}

/** Bytes of a file that may be inlined; beyond this the mention is dropped with a note. */
export const INLINE_LIMIT_BYTES = 48 * 1024;

/** `@` reference syntax: a path token, terminated by whitespace or the end of the line. */
const MENTION = /@([A-Za-z0-9._\-/]+)/g;

/** Every path a draft references. Used to decide what to read before a send. */
export function mentionedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const p = m[1];
    if (p) out.add(p);
  }
  return [...out];
}

/**
 * Inline referenced files as fenced blocks, and report what happened to each one.
 *
 * The reference stays in the text — it is what the user typed, and the model can see the file name
 * next to its contents — and the block is appended after the message. `skipped` names the references
 * that could not be read, so the caller can tell the user instead of sending a message that silently
 * claims context it does not have.
 */
export function expandMentions(
  text: string,
  files: ReadonlyMap<string, { content: string; truncated?: boolean }>,
): { text: string; inlined: InlinedFile[]; skipped: string[] } {
  const inlined: InlinedFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const path of mentionedPaths(text)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const file = files.get(path);
    if (!file) {
      skipped.push(path);
      continue;
    }
    inlined.push({ path, content: file.content, ...(file.truncated ? { truncated: true } : {}) });
  }
  if (inlined.length === 0) return { text, inlined, skipped };
  const blocks = inlined
    .map((f) => `--- ${f.path}${f.truncated ? " (truncated)" : ""} ---\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return {
    text: `${text}\n\nFiles referenced above:\n\n${blocks}`,
    inlined,
    skipped,
  };
}

/**
 * Files out of a `list_dir` listing.
 *
 * The listing is a *formatted* string, not a path list: Rust emits `file <path>` and `dir  <path>`
 * (two spaces, so the columns line up), which the host's own tests pin. Splitting on whitespace and
 * taking the last token would work until a path contains a space; splitting on the type prefix is
 * exact. Directories are dropped because `read_file` refuses them, so offering one would offer a
 * reference that can only fail.
 */
export function parseListing(output: string): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  for (const line of output.split("\n")) {
    const m = /^(file|dir)\s+(.+?)\s*$/.exec(line);
    if (!m || m[1] !== "file") continue;
    const path = m[2]!.trim();
    if (path) out.push({ path });
  }
  return out;
}
