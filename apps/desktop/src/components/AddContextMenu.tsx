/**
 * "Add context" — the one attach affordance, as a menu.
 *
 * This replaces a button whose chevron was decoration: `＋ Add context ▾` used to open the same file
 * dialog as the paperclip beside it, so the label promised a choice and delivered a picker. Two
 * things fix that, and both are in this file's structure rather than its styling:
 *
 *  - **Every row is honest about whether it can run.** A row whose source does not exist yet — no
 *    workspace root, no earlier output — renders disabled *with the reason in place of its subtitle*,
 *    instead of staying clickable and failing into a notice afterwards. This is the same rule the
 *    paperclip's tooltip already followed (`Composer.tsx` `visionNote`): say which case applies
 *    before the click, not after.
 *  - **Two groups, not four siblings.** The rows answer two different questions. "What it reads" is
 *    data the model receives this turn; "How it behaves" is a constraint on the reply. Flattening them
 *    is how a menu becomes a list of unrelated nouns.
 *
 * The menu is presentational and keyboard-complete; `Composer` owns whether it is open and closes it
 * on an outside click, because the button and the panel share one wrapper there and only that wrapper
 * knows the click was "inside".
 */
import { useEffect, useRef, useState } from "react";
import { MAX_INSTRUCTION_CHARS } from "../lib/chat/context-blocks";
import { Button, inputCls, inputStyle } from "./atoms";

/** One earlier output this conversation produced, offered for reuse. */
export interface PreviousOutput {
  id: string;
  /** Short human label — the turn it came from and a fragment of what it said. */
  label: string;
  text: string;
}

export interface AddContextMenuProps {
  /** Runs the native file picker. Images become parts, text becomes a fenced block. */
  onUploadFiles: () => void;
  onOpenProjectFiles: () => void;
  /** A reason the workspace is unavailable, or null when Project files can run. */
  projectFilesReason: string | null;
  /** Earlier assistant outputs in this conversation, newest first. */
  previousOutputs: PreviousOutput[];
  onInsertResult: (output: PreviousOutput) => void;
  /** The per-turn instruction, and its setter. Held by the composer, sent as a system message. */
  instruction: string;
  onInstructionChange: (text: string) => void;
  onClose: () => void;
}

/**
 * Row icons.
 *
 * Inline SVG in the same 24×24 stroke style as the paperclip this menu replaces, rather than an icon
 * dependency: the app has exactly four icons and adding a package for them would be the larger change.
 */
const ICONS: Record<string, string> = {
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M12 3v12M17 8l-5-5-5 5",
  project:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  instruction:
    "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M8 11h.01M8 16h.01M12 11h4M12 16h4",
  previous: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
};

function Row({
  icon, title, subtitle, disabled, selected, onPick, onHover,
}: {
  icon: string;
  title: string;
  subtitle: string;
  disabled: boolean;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled}
      onClick={onPick}
      onMouseEnter={onHover}
      className="flex w-full items-start gap-2.5 rounded px-2 py-2 text-left transition-colors disabled:cursor-not-allowed"
      style={{
        background: selected && !disabled ? "var(--surface)" : "transparent",
        // 0.6, not 0.45: a disabled row's *subtitle is its reason* ("Set a workspace root…"), so
        // dimming it into unreadability would hide the one thing the row exists to say. Still clearly
        // de-emphasised against the live rows, but legible.
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: "var(--accent)" }}
        aria-hidden="true"
      >
        <path d={ICONS[icon]} />
      </svg>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium" style={{ color: "var(--text)" }}>{title}</span>
        <span className="block text-[11px] leading-snug" style={{ color: "var(--text-faint)" }}>{subtitle}</span>
      </span>
    </button>
  );
}

export function AddContextMenu({
  onUploadFiles,
  onOpenProjectFiles,
  projectFilesReason,
  previousOutputs,
  onInsertResult,
  instruction,
  onInstructionChange,
  onClose,
}: AddContextMenuProps) {
  // The menu is a small navigator: the root list, plus two panels that collect something the root
  // list cannot express in one click. Escape walks back out of a panel before it closes the menu.
  const [panel, setPanel] = useState<"root" | "instruction" | "previous">("root");
  const [pick, setPick] = useState(0);
  const [draftInstruction, setDraftInstruction] = useState(instruction);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Focus lands inside on open so the keyboard works immediately and Escape has somewhere to land,
  // matching the modals in `atoms.tsx` rather than inventing a second convention.
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const rows = [
    { id: "upload", icon: "upload", title: "Upload files", subtitle: "Images, text and logs from your machine", disabled: false },
    {
      id: "project",
      icon: "project",
      title: "Project files",
      subtitle: projectFilesReason ?? "Reference code from the workspace with @",
      disabled: projectFilesReason !== null,
    },
    {
      id: "instruction",
      icon: "instruction",
      title: "Instructions",
      subtitle: instruction.trim()
        ? `Set for this turn: ${instruction.trim().slice(0, 60)}${instruction.trim().length > 60 ? "…" : ""}`
        : "Requirements and constraints for this reply",
      disabled: false,
    },
    {
      id: "previous",
      icon: "previous",
      title: "Previous results",
      // Names the count rather than saying "reuse outputs": the number is what tells the user whether
      // this conversation has anything worth reusing.
      subtitle:
        previousOutputs.length === 0
          ? "No earlier answer in this conversation yet"
          : `Reuse one of ${previousOutputs.length} earlier answer${previousOutputs.length === 1 ? "" : "s"}`,
      disabled: previousOutputs.length === 0,
    },
  ];

  function pickRow(id: string) {
    switch (id) {
      case "upload":
        onUploadFiles();
        onClose();
        break;
      case "project":
        onOpenProjectFiles();
        onClose();
        break;
      case "instruction":
        setDraftInstruction(instruction);
        setPanel("instruction");
        break;
      case "previous":
        setPanel("previous");
        break;
    }
  }

  /** Arrow keys move over the rows that can actually run, so a disabled row cannot trap the cursor. */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (panel === "root") onClose();
      else setPanel("root");
      return;
    }
    if (panel !== "root") return;
    const enabled = rows.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const at = enabled.indexOf(pick);
      const next = e.key === "ArrowDown" ? at + 1 : at - 1;
      setPick(enabled[(next + enabled.length) % enabled.length]!);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[pick];
      if (row && !row.disabled) pickRow(row.id);
    }
  }

  return (
    <div
      ref={boxRef}
      tabIndex={-1}
      role="menu"
      aria-label="Add context"
      data-testid="add-context-menu"
      onKeyDown={onKeyDown}
      className="absolute bottom-full left-0 z-30 mb-2 w-[336px] rounded-lg border p-1.5 shadow-2xl outline-none"
      style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
    >
      {panel === "root" && (
        <>
          {/* pt-2 against the rows' py-2 and the panel's p-1.5: 14px of air above the first heading,
              matching the 14px under the last row. An uneven inset is what makes a panel read as
              clipped even when nothing is cut. */}
          <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
            What it reads
          </p>
          {rows.slice(0, 2).map((r) => (
            <Row
              key={r.id}
              icon={r.icon}
              title={r.title}
              subtitle={r.subtitle}
              disabled={r.disabled}
              selected={pick === rows.indexOf(r)}
              onPick={() => pickRow(r.id)}
              onHover={() => setPick(rows.indexOf(r))}
            />
          ))}
          <p className="mt-1 border-t px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)", borderColor: "var(--border)" }}>
            How it behaves this turn
          </p>
          {rows.slice(2).map((r) => (
            <Row
              key={r.id}
              icon={r.icon}
              title={r.title}
              subtitle={r.subtitle}
              disabled={r.disabled}
              selected={pick === rows.indexOf(r)}
              onPick={() => pickRow(r.id)}
              onHover={() => setPick(rows.indexOf(r))}
            />
          ))}
        </>
      )}

      {panel === "instruction" && (
        <div className="p-1.5">
          <p className="mb-1.5 text-[11px] font-medium" style={{ color: "var(--text)" }}>
            Requirements for this reply
          </p>
          <textarea
            value={draftInstruction}
            onChange={(e) => setDraftInstruction(e.target.value)}
            rows={4}
            autoFocus
            maxLength={MAX_INSTRUCTION_CHARS}
            placeholder={"e.g. Reply in Bangla. Keep it under 200 words. Assume the SDK is already installed."}
            aria-label="Per-turn instruction"
            data-testid="instruction-input"
            className={`${inputCls} resize-none`}
            style={inputStyle}
          />
          <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }}>
            Sent as its own system message, so the model reads it as a constraint rather than as your
            message. It applies to this turn only — the durable prompt is under ⚙.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              disabled={!draftInstruction.trim()}
              onClick={() => {
                onInstructionChange(draftInstruction.trim());
                setPanel("root");
              }}
            >
              Use for this turn
            </Button>
            {instruction.trim() && (
              <Button
                variant="ghost"
                onClick={() => {
                  onInstructionChange("");
                  setDraftInstruction("");
                  setPanel("root");
                }}
              >
                Remove
              </Button>
            )}
            <button
              type="button"
              className="ml-auto text-[11px]"
              style={{ color: "var(--text-faint)" }}
              onClick={() => setPanel("root")}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {panel === "previous" && (
        <div className="p-1">
          <p className="px-1.5 pb-1.5 text-[11px] font-medium" style={{ color: "var(--text)" }}>
            Reuse an earlier answer
          </p>
          <div className="max-h-[240px] overflow-y-auto">
            {previousOutputs.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onInsertResult(o);
                  onClose();
                }}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-[11px] transition-colors"
                style={{ color: "var(--text-dim)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mt-1 w-full rounded px-2 py-1 text-left text-[11px]"
            style={{ color: "var(--text-faint)" }}
            onClick={() => setPanel("root")}
          >
            ← Back
          </button>
        </div>
      )}
    </div>
  );
}
