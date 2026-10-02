/**
 * What "Add context" may attach, and the blocks it writes into a turn.
 *
 * A `.ts` module rather than logic inside `Composer.tsx` for the same reason `slash.ts` and
 * `mentions.ts` are: vitest runs without jsdom, so anything decided in a component is decided where
 * no test can see it. Three decisions live here — what a file *is*, what a block looks like, and what
 * the button should say is attached — and all three are the kind that fail quietly.
 *
 * # Why documents get their own kind
 *
 * The composer reads browser `File` objects; it can read text and it can carry image bytes, and that
 * is the whole of its ability. A PDF or a .docx is a *container*, so reading it with `readAsText`
 * yields compressed bytes rendered as replacement characters — not an error, not a refusal, just
 * garbage appended to the draft as though it were the document. The host has a real extractor
 * (`read_document`, `core/tool_registry.rs:242`) but it takes a workspace path, which a file chosen
 * in the OS dialog does not have. Until documents travel as content parts (see
 * `docs/ADD_CONTEXT_MENU_PLAN_2026-10-02.md`, Phase 2) the honest move is to refuse one and name the
 * path that does work, rather than to inline nonsense.
 */

/** Characters allowed in a per-turn instruction: a real constraint list, not a second prompt. */
export const MAX_INSTRUCTION_CHARS = 2000;

/** The header a reused output gets. Counted back out of the draft to keep the button honest. */
const RESULT_MARKER = "Previous result —";

/** Container formats the composer cannot read as text, whatever the browser calls them. */
const DOCUMENT_EXT = /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|rtf|epub|pages|numbers|key)$/i;
const DOCUMENT_MIME =
  /^(application\/(pdf|msword|rtf|epub\+zip|vnd\.openxmlformats-officedocument[.\w-]*|vnd\.oasis\.opendocument[.\w-]*|x-iwork[.\w-]*))/i;

/** Extensions treated as text even when the browser reports no type (a dragged file often has none). */
const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|sh|bash|zsh|fish|ps1|bat|cmd|ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cpp|hpp|cs|php|sql|css|scss|sass|less|html|htm|xml|svg|graphql|gql|proto|lock|gitignore|dockerfile|makefile)$/i;

export type FileKind =
  /** Carried as bytes in a `ContentPart`, gated on the model declaring vision. */
  | "image"
  /** Read with `readAsText` and appended to the draft as a fenced block. */
  | "text"
  /** A container the composer cannot open; refused with the path that works. */
  | "document"
  /** Neither recognised nor obviously text — inspected for binary content before being read. */
  | "unknown";

/**
 * What a picked or dropped file is, from its name and the type the browser reported.
 *
 * Name first, because the browser's type is frequently absent (drag-and-drop from some file managers)
 * or wrong (`application/octet-stream` for everything). A recognised document extension outranks a
 * `text/*` type: `.rtf` is text-ish by type and a container in fact, and guessing wrong there costs
 * the user a draft full of control words.
 */
export function fileKind(name: string, mimeType: string): FileKind {
  if (/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mimeType)) return "image";
  if (DOCUMENT_EXT.test(name) || DOCUMENT_MIME.test(mimeType)) return "document";
  if (TEXT_EXT.test(name) || /^text\//i.test(mimeType)) return "text";
  if (/^(image|video|audio|font)\//i.test(mimeType)) return "unknown";
  if (/^application\/(json|xml|javascript|typescript|x-sh|x-httpd-php|graphql)/i.test(mimeType)) return "text";
  return "unknown";
}

/**
 * Whether a leading chunk of bytes looks like a container rather than text.
 *
 * A NUL byte is the signal: no text encoding this app reads puts one in the first few KB (UTF-16
 * would, and UTF-16 source files are rare enough that mislabelling one as binary is the cheaper
 * error — it is refused with a message rather than silently mangled).
 */
export function looksBinary(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b === 0) return true;
  return false;
}

/** Why a document was refused, and what to do instead. Names the working path, not just the refusal. */
export function documentRefusal(name: string): string {
  return (
    `${name} was not attached: the composer can read text and images, not document files. ` +
    `Reference it from your workspace with @, or ask the agent to read it with read_document.`
  );
}

export function binaryRefusal(name: string): string {
  return `${name} was not attached: it looks like a binary file, not text.`;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * A per-turn instruction, shaped for a system message.
 *
 * Its own message rather than a line spliced into the user's text, for the reason the recalled-memory
 * block is (`Assistant.tsx:2169`): the model has to be able to tell a constraint the user set from a
 * sentence the user wrote. Empty in, empty out — a blank instruction must add no system turn at all,
 * or every message would carry an empty one.
 */
export function instructionSystemText(instruction: string): string {
  const t = instruction.trim();
  if (!t) return "";
  return `Requirements for this reply — apply them, and do not treat them as the user's message:\n\n${t}`;
}

/** Clamp an instruction as the user types, so the limit is felt before it is hit. */
export function clampInstruction(text: string): string {
  return text.length <= MAX_INSTRUCTION_CHARS ? text : text.slice(0, MAX_INSTRUCTION_CHARS);
}

/**
 * A past output, as a block the user can see and edit in the draft.
 *
 * Capped at the same inline limit a text file gets: a reused answer is context, and context that
 * silently costs the whole window is how a helpful button becomes a broken turn. The block says it
 * was truncated in-band, so neither the user nor the model has to guess whether it is complete.
 */
export function previousResultBlock(
  label: string,
  text: string,
  cap: number,
): { block: string; truncated: boolean } {
  const { text: body, truncated } = clip(text, cap);
  const head = `${RESULT_MARKER} ${label}${truncated ? " (truncated)" : ""}`;
  return { block: `${head}\n\`\`\`\n${body}\n\`\`\``, truncated };
}

export function previousResultMarkerCount(draft: string): number {
  let n = 0;
  for (const line of draft.split("\n")) if (line.startsWith(RESULT_MARKER)) n += 1;
  return n;
}

export interface ContextCounts {
  /** Image parts held as attachments. */
  attachments: number;
  /** Distinct `@path` references in the draft. */
  references: number;
  /** Reused outputs in the draft. */
  results: number;
  /** The per-turn instruction, or "" when none is set. */
  instruction: string;
}

/**
 * The button's own label for what is attached.
 *
 * Derived from the draft rather than from the click history, so deleting a block by hand takes the
 * count down with it. A badge fed by "how many times the menu was used" keeps claiming context the
 * user has since removed, which is exactly the lie the chevron used to tell.
 *
 * # What it counts, and what it deliberately does not
 *
 * The rule is *count what the draft does not show you*. An `@path` reference is eleven characters in
 * the box that will send a whole file's contents at send time; an image is pixels the box renders as
 * a thumbnail at best; an instruction changes the request from a corner of the UI the user is not
 * looking at. Those are the ones worth a number.
 *
 * An **inlined text file is not counted**, and that is the rule rather than an omission: its entire
 * body is sitting in the box, so it argues for itself. Counting it would make the badge a count of
 * everything the menu ever did, which is the version that keeps claiming context after the user has
 * deleted it.
 */
export function contextSummary(c: ContextCounts): { badge: string | null; title: string } {
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (c.attachments > 0) parts.push(plural(c.attachments, "image"));
  if (c.references > 0) parts.push(plural(c.references, "file reference"));
  if (c.results > 0) parts.push(plural(c.results, "reused result"));
  if (c.instruction.trim()) parts.push("instruction");
  if (parts.length === 0) return { badge: null, title: "Add an image, a file, a reference or an instruction" };
  const total = c.attachments + c.references + c.results + (c.instruction.trim() ? 1 : 0);
  return { badge: `· ${total}`, title: `This turn carries ${parts.join(", ")}` };
}
