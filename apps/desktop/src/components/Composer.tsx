/**
 * The composer: the draft, what context it carries, and the two menus that change what a keystroke means.
 *
 * # Why this owns the draft
 *
 * It has to, because three of its inputs are not text: an attachment, a slash command and an
 * `@`-reference. Keeping the string in the parent and the attachments here would make "what will be
 * sent" a fact split across two components, and the two would disagree exactly when it matters — on
 * the send that carries an image and a `/clear`.
 *
 * The parent gets one callback, `onSend(text, attachments, inlined, instruction)`, with everything
 * already resolved: mentions expanded, attachment bytes read, the per-turn instruction separated from
 * the text. Nothing is left for the turn runner to guess.
 *
 * # One attach affordance, and it names what it attaches
 *
 * There used to be two buttons that did the same thing — a paperclip and `＋ Add context ▾` — and the
 * chevron was decoration on a button that opened a file dialog. `AddContextMenu` is that button's
 * menu, and the paperclip is gone; drag-and-drop and paste remain, because those are different
 * gestures rather than a second control for one job.
 *
 * # Files are read here, not fetched from the host
 *
 * A picked or dropped file is read with `FileReader` inside the webview. Images become base64 parts
 * (`ContentPart`); text files become a fenced block in the draft itself; a document is refused,
 * because this side can only read text and claiming otherwise means inlining compressed bytes as
 * replacement characters. That is also why this component adds no Tauri command: the host's job
 * (egress, confinement) is unchanged, and a native file dialog would add a privileged surface for
 * something the platform already provides.
 *
 * # Two ways in for a text file, deliberately different
 *
 * A **dropped/picked** text file is appended to the draft, where the user can see it, edit it, or
 * delete it. An **`@reference`** is expanded at send time and stays a path in the draft, because
 * that is what the user typed and rewriting it under the caret as they type is how a composer starts
 * fighting the person using it.
 *
 * # Nothing attaches invisibly
 *
 * Everything this menu adds is either in the draft (references, reused results, text files) or in a
 * chip (images, the instruction). An instruction the user cannot see is a constraint they will
 * misremember setting, so it gets a chip with its text and a ✕ like any other attachment.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, inputCls, inputStyle } from "./atoms";
import { AddContextMenu, type PreviousOutput } from "./AddContextMenu";
import { ProjectFilePicker } from "./ProjectFilePicker";
import { matchSlashCommands, parseSlash, type SlashCommand } from "../lib/chat/slash";
import {
  INLINE_LIMIT_BYTES,
  activeMention,
  applyMention,
  expandMentions,
  matchMentions,
  mentionedPaths,
  type MentionCandidate,
} from "../lib/chat/mentions";
import {
  binaryRefusal,
  clampInstruction,
  contextSummary,
  documentRefusal,
  fileKind,
  looksBinary,
  previousResultBlock,
  previousResultMarkerCount,
} from "../lib/chat/context-blocks";

/** An image the user attached, already read into memory. */
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  dataBase64: string;
  /** Bytes, for the chip — the user should see the size of what they are sending. */
  bytes: number;
}

/** A workspace file that was inlined into the outgoing message. */
export interface InlinedText {
  path: string;
  bytes: number;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Read a file into base64, without the data-URI prefix (the dialect template adds that). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.onload = () => {
      const s = String(r.result ?? "");
      const comma = s.indexOf(",");
      resolve(comma === -1 ? s : s.slice(comma + 1));
    };
    r.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.onload = () => resolve(String(r.result ?? ""));
    r.readAsText(file);
  });
}

/**
 * The first few KB of a file, for the binary check.
 *
 * Only for files whose kind could not be decided from the name or the type. A chunk is enough: a NUL
 * byte in the first kilobyte is not something a text file does, and reading the whole thing to find
 * out would cost exactly what deciding not to attach it is meant to save.
 */
async function headBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 4096).arrayBuffer());
}

export interface ComposerProps {
  /** The composer's textarea, owned here and handed up so a shortcut can focus it. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  /** Switches the placeholder's wording, which the existing specs (and users) have learned. */
  agentMode: boolean;
  /** Whether the chosen model accepts image input: `true`, `false`, or `undefined` for "unasked". */
  vision: boolean | undefined;
  /** The model's own name, for the notice — "GPT-4o does not accept images" beats "not allowed". */
  modelLabel: string;
  onSend: (text: string, attachments: Attachment[], inlined: InlinedText[], instruction: string) => void;
  onStop: () => void;
  /**
   * The draft, reported on each keystroke. The parent needs it for exactly one thing — the context
   * meter, which reports what the NEXT send will contain — and giving it the string is cheaper than
   * lifting the whole draft back out of here.
   */
  onDraftChange: (text: string) => void;
  /**
   * The per-turn instruction, reported for the same reason as the draft: it is a system message the
   * next send will carry, so a meter that did not know about it would understate the prompt by
   * however much the user asked for.
   */
  onInstructionChange?: (text: string) => void;
  /** Earlier assistant answers in this conversation, newest first, offered by "Previous results". */
  previousOutputs?: PreviousOutput[];
  /** Why Send is refused when the turn cannot run (no model, no workspace root). */
  sendDisabled?: boolean;
  /** Slash commands the composer cannot run itself. */
  onClear: () => void;
  onOpenModelPicker: () => void;
  onSwitchToImageTab: () => void;
  onCompact: () => void;
  /** Workspace listing for @-mentions and the Project files panel, or null when there is no root. */
  listFiles: (() => Promise<MentionCandidate[]>) | null;
  /** Reads a workspace file for inlining; null when there is no root. */
  readFile: ((path: string) => Promise<string | null>) | null;
  /** A notice to show the user (a skipped mention, a refused attachment). */
  onNotice: (message: string) => void;
  /**
   * A suggestion card's text, injected into the draft. The composer owns the draft (see above), so
   * the parent cannot set it directly — it hands down `{ text, nonce }` and this effect claims it
   * by nonce, the same pending-and-consumed shape the shell's one-shot intents use. A re-fire with
   * the same text must still re-fill the box, which is why the claim is keyed on the nonce and not
   * on the string.
   */
  seed?: { text: string; nonce: number };
  /**
   * The run toolbar, rendered into the composer's action row between "Add context" and Send. The
   * screen owns the controls (mode toggles, the model picker); the composer only gives them a
   * home in the same row as the send — so what a turn will use sits where it is sent from. A node
   * rather than props: the controls belong to `AssistantScreen`'s state and this component must
   * not grow their concerns.
   */
  toolbar?: ReactNode;
  /**
   * A node pinned to the composer's top-right corner, level with the textarea — the model
   * picker's home (see `ComposerProps.toolbar` for why it is a node): the picker reads as
   * "what this box will send with" when it overlooks the send button.
   */
  corner?: ReactNode;
}

export function Composer({
  textareaRef,
  busy,
  agentMode,
  vision,
  modelLabel,
  onSend,
  onStop,
  onDraftChange,
  onInstructionChange,
  previousOutputs = [],
  sendDisabled = false,
  onClear,
  onOpenModelPicker,
  onSwitchToImageTab,
  onCompact,
  listFiles,
  readFile,
  onNotice,
  seed,
  toolbar,
  corner,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [instruction, setInstruction] = useState("");
  const [files, setFiles] = useState<MentionCandidate[] | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionPick, setMentionPick] = useState(0);
  const [slashPick, setSlashPick] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Mirror of the draft for writers that run outside a render's closure: `addFiles` appends once
  // per file with an `await readAsText` between appends, and the running closure still holds the
  // gesture-time render — composing from `draft` there would overwrite every earlier file's block
  // with the last one's, silently. Every write of the draft goes through `writeDraft`, which keeps
  // this ref, the state, and the parent's copy in step.
  const draftRef = useRef("");
  // The synchronous send lock: set in `send` before its first await, released by the effect below.
  const sendingRef = useRef(false);
  // True while `addFiles` is reading dropped or pasted files. Send is refused during the window:
  // a turn sent while a paste's base64 read is pending would leave the image out of the request
  // and let its chip ghost onto the next one. A ref, not state, because `send` must see it in the
  // same tick the paste landed — a render may not have happened yet; the state copy below exists
  // only so the Send button can show the refusal.
  const attachingRef = useRef(false);
  const [attaching, setAttaching] = useState(false);

  function writeDraft(next: string) {
    draftRef.current = next;
    setDraft(next);
    onDraftChange(next);
  }

  useEffect(() => {
    // Releases the send lock. `busy` going true means the parent took the turn — its own guard
    // covers re-entry from there. `draft` becoming non-empty again means the user typed after a
    // send the parent did not take (e.g. no model chosen — `runTurn` returns before setting busy),
    // which is the only other way out: without it a refused send would lock the composer until
    // reload. Both matter, and neither fires early: the effect only re-runs when `busy` or `draft`
    // actually changes, and nothing between `send`'s lock and its clear touches either.
    if (busy || draft) sendingRef.current = false;
  }, [busy, draft]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  // The seed claim (see `ComposerProps.seed`). Focused on the textarea and the caret parked at the
  // end, so the user can start typing onto the suggestion immediately.
  const seenSeed = useRef<number | null>(null);
  useEffect(() => {
    if (!seed || seed.nonce === seenSeed.current) return;
    seenSeed.current = seed.nonce;
    writeDraft(seed.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = seed.text.length;
      el.setSelectionRange(end, end);
    });
  }, [seed, textareaRef, onDraftChange]);

  // The menu closes on a click outside its wrapper — the button and the panel share that wrapper, so
  // "outside" means outside both. A click on the button itself must not close-then-reopen it, which
  // is exactly what a document-level listener without the wrapper would do.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // Closing the menu hands focus back to the box the user was typing in — otherwise Escape drops the
  // caret on the floor and the next keystroke goes nowhere. Guarded on the picker: when the menu
  // closes *because* Project files opened, the modal has already taken focus and stealing it back
  // would leave its search box unusable.
  const menuWasOpen = useRef(false);
  useEffect(() => {
    if (menuWasOpen.current && !menuOpen && !projectPickerOpen) textareaRef.current?.focus();
    menuWasOpen.current = menuOpen;
  }, [menuOpen, projectPickerOpen, textareaRef]);

  const slashMatches = useMemo(() => matchSlashCommands(draft), [draft]);
  const parsedSlash = useMemo(() => parseSlash(draft), [draft]);
  const mentionMatches = useMemo(
    () => (mentionStart === null ? [] : matchMentions(files ?? [], draft.slice(mentionStart + 1, caret))),
    [mentionStart, draft, caret, files],
  );

  // What the button says is attached. Derived from the draft and the attachments rather than from
  // which rows were clicked, so deleting a block by hand takes the count down with it.
  const summary = useMemo(
    () =>
      contextSummary({
        attachments: attachments.length,
        references: mentionedPaths(draft).length,
        results: previousResultMarkerCount(draft),
        instruction,
      }),
    [attachments.length, draft, instruction],
  );

  // Auto-grow: height follows the content up to a cap, past which the box scrolls. A composer that
  // grows without bound eats the transcript it is sitting under.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft, textareaRef]);

  /** Load the workspace listing when a mention first opens, not on mount: most turns never use one. */
  const ensureFiles = useCallback(async () => {
    if (files !== null || !listFiles) return;
    try {
      setFiles(await listFiles());
    } catch {
      // An unreadable listing is an empty menu, not an error wall: the user can still type a path.
      setFiles([]);
    }
  }, [files, listFiles]);

  function syncMenus(value: string, nextCaret: number) {
    const mention = activeMention(value, nextCaret);
    setMentionStart(mention ? mention.start : null);
    if (mention) {
      setMentionPick(0);
      void ensureFiles();
    }
  }

  /**
   * Append a block to the end of the draft and park the caret after it.
   *
   * Every writer of "context the user can see" goes through here — a dropped text file, a project
   * reference, a reused answer — for two reasons. The draft is what the user edits, so the block is
   * visible and deletable by construction; and `onDraftChange` is called with the new value, which
   * is what keeps the context meter counting what was just added. The previous code appended a text
   * file through a bare `setDraft` and left the parent's copy stale, so the meter was already
   * under-reporting before this menu existed.
   */
  function appendToDraft(block: string) {
    // Composed from the ref, not the render's `draft`: the closure running this was created at the
    // gesture that started `addFiles`, and appends are separated by awaits — the state this
    // closure sees is the pre-append draft for every file but the first.
    const prev = draftRef.current;
    const next = `${prev.trimEnd()}${prev.trim() ? "\n\n" : ""}${block}`;
    writeDraft(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }

  function setInstructionValue(text: string) {
    const clamped = clampInstruction(text);
    setInstruction(clamped);
    onInstructionChange?.(clamped);
  }

  async function addFiles(list: FileList | File[]) {
    // The gate is the point (see `attaching`): between this and the reads below, a Send would
    // compose its request from the pre-attachment closure and drop the files it claims to carry.
    attachingRef.current = true;
    setAttaching(true);
    try {
      await addFilesInner(list);
    } finally {
      attachingRef.current = false;
      setAttaching(false);
    }
  }

  async function addFilesInner(list: FileList | File[]) {
    const incoming = Array.from(list);
    const images: Attachment[] = [];
    for (const file of incoming) {
      const kind = fileKind(file.name, file.type);

      if (kind === "image") {
        if (vision !== true) {
          // The gate, said out loud. A dropped file that silently does nothing reads as a broken app
          // rather than as a model that cannot see.
          onNotice(
            `${file.name} was not attached: ${modelLabel} ${
              vision === undefined ? "does not declare image input" : "does not accept images"
            }.`,
          );
          continue;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          onNotice(`${file.name} was not attached: over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
          continue;
        }
        try {
          images.push({
            id: `${file.name}-${file.size}-${images.length}-${Date.now()}`,
            name: file.name,
            mediaType: file.type,
            dataBase64: await readAsBase64(file),
            bytes: file.size,
          });
        } catch (e) {
          onNotice(`${file.name} could not be read: ${(e as Error).message}`);
        }
        continue;
      }

      // A container this side cannot open. Refused by name, because reading it as text would
      // *succeed* and put compressed bytes in the draft as replacement characters — a failure with
      // no error to notice.
      if (kind === "document") {
        onNotice(documentRefusal(file.name));
        continue;
      }

      // Neither recognised nor obviously text: look at the bytes before trusting the name. Only here,
      // where the extension and the browser's type have both failed to say anything.
      if (kind === "unknown") {
        try {
          if (looksBinary(await headBytes(file))) {
            onNotice(binaryRefusal(file.name));
            continue;
          }
        } catch (e) {
          onNotice(`${file.name} could not be read: ${(e as Error).message}`);
          continue;
        }
      }

      // Anything else is treated as text and appended to the draft as a fenced block — visible and
      // editable, which is what a text file is: context, not an attachment.
      if (file.size > INLINE_LIMIT_BYTES) {
        onNotice(
          `${file.name} was not attached: ${Math.round(file.size / 1024)} KB exceeds the ` +
          `${INLINE_LIMIT_BYTES / 1024} KB inline limit.`,
        );
        continue;
      }
      try {
        const text = await readAsText(file);
        appendToDraft(`${file.name}:\n\`\`\`\n${text}\n\`\`\``);
      } catch (e) {
        onNotice(`${file.name} could not be read: ${(e as Error).message}`);
      }
    }
    if (images.length) setAttachments((a) => [...a, ...images]);
  }

  /** Replace the active mention with a chosen path, leaving a trailing space for the next word. */
  function pickMention(path: string) {
    if (mentionStart === null) return;
    const { text, caret: nextCaret } = applyMention(draft, mentionStart, caret, path);
    writeDraft(text);
    setMentionStart(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }

  function runSlash(command: SlashCommand) {
    // Cleared first: every one of these acts on the screen, and leaving "/clear" in the box invites
    // a second Enter that would send it as a message.
    writeDraft("");
    setAttachments([]);
    setMentionStart(null);
    // A per-turn instruction belongs to the turn, not the composer: `/clear` starts a new chat, and
    // carrying a constraint across it would apply the last conversation's rules to the next one.
    setInstruction("");
    onInstructionChange?.("");
    switch (command.id) {
      case "clear": onClear(); break;
      case "model": onOpenModelPicker(); break;
      case "image": onSwitchToImageTab(); break;
      case "compact": onCompact(); break;
    }
  }

  async function send() {
    if (busy || sendDisabled || attachingRef.current || sendingRef.current) return;
    if (parsedSlash) {
      runSlash(parsedSlash.command);
      return;
    }
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    // Set synchronously, before the first await: the @-expansion below awaits the host per path,
    // and during that window a second Enter passes the `busy` guard (the parent has not seen the
    // turn yet) and re-runs the whole expansion from the same stale closure. Released by the
    // effect after the state block, not here — see it for the two arms.
    sendingRef.current = true;
    const turnInstruction = instruction;

    let body = text;
    const inlined: InlinedText[] = [];
    // `@`-references are expanded before sending, so the model receives the file rather than its
    // name. The expansion itself lives in `lib/chat/mentions.ts` (and is unit-tested there); this
    // only supplies the bytes, which is the one part that needs the host.
    const paths = mentionedPaths(text);
    if (paths.length && readFile) {
      const got = new Map<string, { content: string; truncated?: boolean }>();
      const sizes = new Map<string, number>();
      for (const path of paths) {
        const content = await readFile(path).catch(() => null);
        if (content === null) continue;
        sizes.set(path, content.length);
        const over = content.length > INLINE_LIMIT_BYTES;
        got.set(path, {
          content: over ? content.slice(0, INLINE_LIMIT_BYTES) : content,
          ...(over ? { truncated: true } : {}),
        });
      }
      const expanded = expandMentions(text, got);
      body = expanded.text;
      for (const f of expanded.inlined) inlined.push({ path: f.path, bytes: sizes.get(f.path) ?? f.content.length });
      if (expanded.skipped.length) {
        onNotice(`Not found in the workspace: ${expanded.skipped.map((p) => `@${p}`).join(", ")}.`);
      }
    }

    writeDraft("");
    setAttachments([]);
    setMentionStart(null);
    setCaret(0);
    setInstruction("");
    onInstructionChange?.("");
    onSend(body, attachments, inlined, turnInstruction);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // An open menu owns the arrows and Enter: the user is choosing, not sending.
    if (slashMatches.length > 0 && !parsedSlash) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashPick((i) => Math.min(i + 1, slashMatches.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashPick((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab") {
        // Tab completes the name into the box; Enter runs it. Both are conventional, and running on
        // Tab would fire a destructive `/clear` from a key people press to move focus.
        e.preventDefault();
        const c = slashMatches[slashPick];
        if (c) writeDraft(`/${c.name}`);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const c = slashMatches[slashPick];
        if (c) runSlash(c);
        return;
      }
    }
    if (mentionMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionPick((i) => Math.min(i + 1, mentionMatches.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionPick((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Escape") { e.preventDefault(); setMentionStart(null); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = mentionMatches[mentionPick];
        if (pick) pickMention(pick.path);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const visionNote =
    vision === true
      ? null
      : vision === undefined
        ? `${modelLabel} does not declare image input — text attachments still work.`
        : `${modelLabel} does not accept images.`;

  return (
    <div
      className="relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
      }}
      data-testid="composer"
    >
      {/* The menus sit above the box, not over it: the draft is what the user is looking at. */}
      {slashMatches.length > 0 && !parsedSlash && (
        <div
          className="absolute bottom-full left-0 z-20 mb-1 w-[380px] rounded border p-1 shadow-lg"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
          role="listbox"
          aria-label="Slash commands"
        >
          {slashMatches.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === slashPick}
              onMouseEnter={() => setSlashPick(i)}
              onClick={() => runSlash(c)}
              className="block w-full rounded px-2 py-1.5 text-left text-[12px]"
              style={{ background: i === slashPick ? "var(--surface)" : "transparent" }}
            >
              <span className="mono" style={{ color: "var(--text)" }}>/{c.name}</span>
              <span className="ml-2 text-[11px]" style={{ color: "var(--text-faint)" }}>{c.summary}</span>
            </button>
          ))}
        </div>
      )}

      {mentionMatches.length > 0 && (
        <div
          className="absolute bottom-full left-0 z-20 mb-1 w-[380px] rounded border p-1 shadow-lg"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
          role="listbox"
          aria-label="Workspace files"
          data-testid="mention-menu"
        >
          {mentionMatches.map((f, i) => (
            <button
              key={f.path}
              type="button"
              role="option"
              aria-selected={i === mentionPick}
              onMouseEnter={() => setMentionPick(i)}
              onClick={() => pickMention(f.path)}
              className="mono block w-full truncate rounded px-2 py-1 text-left text-[12px]"
              style={{ background: i === mentionPick ? "var(--surface)" : "transparent", color: "var(--text)" }}
            >
              @{f.path}
            </button>
          ))}
        </div>
      )}

      {(attachments.length > 0 || instruction.trim()) && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {/* The instruction is chipped like an attachment rather than held invisibly in state: a
              constraint the user cannot see is one they will believe they removed, or forget they
              set, and it changes the request as much as an image does. */}
          {instruction.trim() && (
            <span
              className="flex max-w-[360px] items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]"
              style={{ borderColor: "var(--accent)", background: "var(--surface-2)", color: "var(--text-dim)" }}
              data-testid="instruction-chip"
            >
              <span aria-hidden="true" style={{ color: "var(--accent)" }}>⚑</span>
              <span className="truncate">{instruction.trim()}</span>
              <button
                type="button"
                aria-label="Remove the per-turn instruction"
                className="px-0.5"
                style={{ color: "var(--text-faint)" }}
                onClick={() => setInstructionValue("")}
              >
                ✕
              </button>
            </span>
          )}
          {attachments.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px]"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
              data-testid="attachment-chip"
            >
              {/* A thumbnail, not just a name: attaching the wrong screenshot is the mistake this
                  lets the user catch before it is sent. */}
              <img alt="" src={`data:${a.mediaType};base64,${a.dataBase64}`} className="h-5 w-5 rounded-sm object-cover" />
              <span className="max-w-[160px] truncate">{a.name}</span>
              <span style={{ color: "var(--text-faint)" }}>{Math.max(1, Math.round(a.bytes / 1024))} KB</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                className="px-0.5"
                style={{ color: "var(--text-faint)" }}
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="rounded-xl border p-2.5"
        style={{
          borderColor: dragOver ? "var(--accent)" : "var(--border)",
          background: dragOver ? "var(--surface-2)" : "var(--surface)",
        }}
      >
        <div className="flex items-start gap-2.5">
          <input
            ref={pickerRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.py,.rs,.toml,.yaml,.yml,.csv,.log"
            className="hidden"
            data-testid="composer-file-input"
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              // Reset so picking the same file twice fires `change` again.
              e.target.value = "";
            }}
          />

          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            onChange={(e) => {
              writeDraft(e.target.value);
              setCaret(e.target.selectionStart ?? 0);
              syncMenus(e.target.value, e.target.selectionStart ?? 0);
            }}
            onKeyUp={(e) => { setCaret(e.currentTarget.selectionStart ?? 0); syncMenus(draft, e.currentTarget.selectionStart ?? 0); }}
            onClick={(e) => { setCaret(e.currentTarget.selectionStart ?? 0); syncMenus(draft, e.currentTarget.selectionStart ?? 0); }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // Paste is the fastest path there is for a screenshot, and it did not exist: a
              // screenshot on the clipboard arrives as a File, and the default handler does nothing
              // with it. Only intercepted when there are files — a paste of text must stay a paste
              // of text, or the composer swallows ordinary clipboard use.
              const files = e.clipboardData?.files;
              if (files?.length) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder={
              parsedSlash
                ? `Press Enter to run /${parsedSlash.command.name}`
                : agentMode
                  ? "Describe a task for the agent…  / for commands, @ for files (Enter to send)"
                  : "Message your assistant…  Use / for commands, @ to reference files"
            }
            aria-label="Message"
            className={`${inputCls} min-h-[40px] flex-1 resize-none border-0 focus:brightness-100`}
            style={{ ...inputStyle, background: "transparent" }}
          data-testid="composer-input"
        />
        {/* The corner node sits level with the textarea's first line, at the card's top-right —
            directly above the send button it configures. */}
        {corner && <div className="shrink-0 self-start pt-0.5">{corner}</div>}
      </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {/* The one attach affordance, and it opens a menu. It used to be two buttons doing the same
              thing with a decorative chevron; the badge is what it actually carries, counted from the
              draft so it cannot claim context the user has deleted. Drag-and-drop and paste stay —
              different gestures, not a second control. */}
          <div ref={menuWrapRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={summary.title}
              data-testid="add-context-button"
              className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40"
              style={{
                borderColor: summary.badge ? "var(--accent)" : "var(--border)",
                color: summary.badge ? "var(--text)" : "var(--text-dim)",
              }}
            >
              ＋ Add context
              {summary.badge && (
                <span className="text-[11px]" style={{ color: "var(--accent)" }}>{summary.badge}</span>
              )}
              <span aria-hidden="true" style={{ color: "var(--text-faint)" }}>▾</span>
            </button>
            {menuOpen && (
              <AddContextMenu
                onUploadFiles={() => pickerRef.current?.click()}
                onOpenProjectFiles={() => setProjectPickerOpen(true)}
                projectFilesReason={listFiles ? null : "Set a workspace root to reference files"}
                previousOutputs={previousOutputs}
                onInsertResult={(o) => {
                  const { block } = previousResultBlock(o.label, o.text, INLINE_LIMIT_BYTES);
                  appendToDraft(block);
                }}
                instruction={instruction}
                onInstructionChange={setInstructionValue}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
          {/* The screen's run controls (mode toggles, model picker) share the send's row. The
              toolbar's trailing auto-margin pushes the picker against Send, per the layout: what
              the turn will use brackets the row's two ends with what it does. */}
          {toolbar}
          <span className="ml-auto flex items-center gap-2">
            {busy ? (
              <Button variant="danger" onClick={onStop}>■ Stop</Button>
            ) : (
              <Button variant="primary" disabled={sendDisabled || attaching} onClick={() => void send()}>
                Send
                {/* aria-hidden: decoration on the button's face. The accessible name stays exactly
                    "Send", which the specs (and screen readers) match on. */}
                <span aria-hidden="true" style={{ opacity: 0.75, fontWeight: 400 }}>↵ Enter</span>
              </Button>
            )}
          </span>
        </div>
      </div>

      {projectPickerOpen && listFiles && (
        <ProjectFilePicker
          loadFiles={listFiles}
          alreadyReferenced={mentionedPaths(draft)}
          onAdd={(paths) => appendToDraft(paths.map((p) => `@${p}`).join(" "))}
          onClose={() => setProjectPickerOpen(false)}
        />
      )}

      {visionNote && (
        <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }} data-testid="vision-note">
          {visionNote}
        </p>
      )}
      {!readFile && (
        <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }}>
          Set a workspace root to reference files with @.
        </p>
      )}
    </div>
  );
}
