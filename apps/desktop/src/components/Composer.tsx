/**
 * The composer: the draft, its attachments, and the two menus that change what a keystroke means.
 *
 * # Why this owns the draft
 *
 * It has to, because three of its inputs are not text: an attachment, a slash command and an
 * `@`-reference. Keeping the string in the parent and the attachments here would make "what will be
 * sent" a fact split across two components, and the two would disagree exactly when it matters — on
 * the send that carries an image and a `/clear`.
 *
 * The parent gets one callback, `onSend(text, attachments, inlined)`, with everything already
 * resolved: mentions expanded and attachment bytes read. Nothing is left for the turn runner to guess.
 *
 * # Files are read here, not fetched from the host
 *
 * A picked or dropped file is read with `FileReader` inside the webview. Images become base64 parts
 * (`ContentPart`); text files become a fenced block in the draft itself. That is also why this phase
 * adds no Tauri command: the host's job (egress, confinement) is unchanged, and a native file dialog
 * would add a privileged surface for something the platform already provides.
 *
 * # Two ways in for a text file, deliberately different
 *
 * A **dropped/picked** text file is appended to the draft, where the user can see it, edit it, or
 * delete it. An **`@reference`** is expanded at send time and stays a path in the draft, because
 * that is what the user typed and rewriting it under the caret as they type is how a composer starts
 * fighting the person using it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, inputCls, inputStyle } from "./atoms";
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

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|webp|gif)$/i;
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
  onSend: (text: string, attachments: Attachment[], inlined: InlinedText[]) => void;
  onStop: () => void;
  /**
   * The draft, reported on each keystroke. The parent needs it for exactly one thing — the context
   * meter, which reports what the NEXT send will contain — and giving it the string is cheaper than
   * lifting the whole draft back out of here.
   */
  onDraftChange: (text: string) => void;
  /** Why Send is refused when the turn cannot run (no model, no workspace root). */
  sendDisabled?: boolean;
  /** Slash commands the composer cannot run itself. */
  onClear: () => void;
  onOpenModelPicker: () => void;
  onSwitchToImageTab: () => void;
  onCompact: () => void;
  /** Workspace listing for @-mentions, or null when there is no root to search. */
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
  const [files, setFiles] = useState<MentionCandidate[] | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionPick, setMentionPick] = useState(0);
  const [slashPick, setSlashPick] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  // The seed claim (see `ComposerProps.seed`). Focused on the textarea and the caret parked at the
  // end, so the user can start typing onto the suggestion immediately.
  const seenSeed = useRef<number | null>(null);
  useEffect(() => {
    if (!seed || seed.nonce === seenSeed.current) return;
    seenSeed.current = seed.nonce;
    setDraft(seed.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = seed.text.length;
      el.setSelectionRange(end, end);
    });
  }, [seed, textareaRef]);

  const slashMatches = useMemo(() => matchSlashCommands(draft), [draft]);
  const parsedSlash = useMemo(() => parseSlash(draft), [draft]);
  const mentionMatches = useMemo(
    () => (mentionStart === null ? [] : matchMentions(files ?? [], draft.slice(mentionStart + 1, caret))),
    [mentionStart, draft, caret, files],
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

  async function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    const images: Attachment[] = [];
    for (const file of incoming) {
      if (IMAGE_TYPES.test(file.type)) {
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
        setDraft((d) => `${d.trimEnd()}${d.trim() ? "\n\n" : ""}${file.name}:\n\`\`\`\n${text}\n\`\`\``);
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
    setDraft(text);
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
    setDraft("");
    onDraftChange("");
    setAttachments([]);
    setMentionStart(null);
    switch (command.id) {
      case "clear": onClear(); break;
      case "model": onOpenModelPicker(); break;
      case "image": onSwitchToImageTab(); break;
      case "compact": onCompact(); break;
    }
  }

  async function send() {
    if (busy || sendDisabled) return;
    if (parsedSlash) {
      runSlash(parsedSlash.command);
      return;
    }
    const text = draft.trim();
    if (!text && attachments.length === 0) return;

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

    setDraft("");
    setAttachments([]);
    setMentionStart(null);
    setCaret(0);
    onDraftChange("");
    onSend(body, attachments, inlined);
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
        if (c) setDraft(`/${c.name}`);
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

      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
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
          {/* Attach stays live even when images are refused — text files still work — and its tooltip
              says which case applies instead of the button being dead with no explanation. */}
          <button
            type="button"
            onClick={() => pickerRef.current?.click()}
            disabled={busy}
            aria-label="Attach files"
            title={visionNote ?? "Attach an image or a text file"}
            className="mt-1.5 shrink-0 rounded px-0.5 py-0.5 disabled:opacity-40"
            style={{ color: vision === true ? "var(--accent)" : "var(--text-dim)" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
              <path d="m20.5 11.5-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-2.8-2.8l7.3-7.3" />
            </svg>
          </button>
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
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? 0);
              onDraftChange(e.target.value);
              syncMenus(e.target.value, e.target.selectionStart ?? 0);
            }}
            onKeyUp={(e) => { setCaret(e.currentTarget.selectionStart ?? 0); syncMenus(draft, e.currentTarget.selectionStart ?? 0); }}
            onClick={(e) => { setCaret(e.currentTarget.selectionStart ?? 0); syncMenus(draft, e.currentTarget.selectionStart ?? 0); }}
            onKeyDown={onKeyDown}
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
          {/* "Add context" is the attach affordance named for what it is for. It opens the same
              file picker — images become parts, text files become fenced blocks — so there is one
              input, not two, and one place that explains refusals. */}
          <button
            type="button"
            onClick={() => pickerRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
          >
            ＋ Add context
            <span aria-hidden="true" style={{ color: "var(--text-faint)" }}>▾</span>
          </button>
          {/* The screen's run controls (mode toggles, model picker) share the send's row. The
              toolbar's trailing auto-margin pushes the picker against Send, per the layout: what
              the turn will use brackets the row's two ends with what it does. */}
          {toolbar}
          <span className="ml-auto flex items-center gap-2">
            {busy ? (
              <Button variant="danger" onClick={onStop}>■ Stop</Button>
            ) : (
              <Button variant="primary" disabled={sendDisabled} onClick={() => void send()}>
                Send
                {/* aria-hidden: decoration on the button's face. The accessible name stays exactly
                    "Send", which the specs (and screen readers) match on. */}
                <span aria-hidden="true" style={{ opacity: 0.75, fontWeight: 400 }}>↵ Enter</span>
              </Button>
            )}
          </span>
        </div>
      </div>

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
