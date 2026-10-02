/**
 * Project files — pick workspace files without having to already know their paths.
 *
 * The `@`-mention menu can reference a file, but only once the user has typed enough of its name to
 * match. That is a fine completion and a poor browser: it cannot answer "what is in this repo?" or
 * "what is under src/lib?". This panel answers both, then hands back `@path` references — the same
 * token the mention menu produces, so the send-time expansion, the truncation reporting and the
 * "not found" notice are all the ones that already exist rather than a second implementation.
 *
 * It offers **files only**. `list_dir` reports directories and `read_file` refuses them, so the
 * listing the composer already receives has them stripped (`parseListing`); offering a folder would
 * offer a reference that can only fail at send time. Folders and globs are Phase 3.
 */
import { useEffect, useMemo, useState } from "react";
import { matchMentions, type MentionCandidate } from "../lib/chat/mentions";
import { Button, Modal, inputCls, inputStyle } from "./atoms";

export interface ProjectFilePickerProps {
  /** The workspace listing. Loaded here, not passed in: this panel is the only reason to need it. */
  loadFiles: () => Promise<MentionCandidate[]>;
  /** Paths already referenced in the draft, shown as selected-and-locked so they are not added twice. */
  alreadyReferenced: readonly string[];
  onAdd: (paths: string[]) => void;
  onClose: () => void;
}

export function ProjectFilePicker({ loadFiles, alreadyReferenced, onAdd, onClose }: ProjectFilePickerProps) {
  const [files, setFiles] = useState<MentionCandidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    loadFiles()
      .then((all) => { if (live) setFiles(all); })
      // An unreadable listing is an empty panel with an explanation, not an error wall: the user can
      // still type an `@` reference by hand, and the picker should not be the thing that blocks them.
      .catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [loadFiles]);

  const already = useMemo(() => new Set(alreadyReferenced), [alreadyReferenced]);
  // A generous limit: this is a browse surface, not a completion menu, so truncating to eight would
  // hide most of a real repository. The scroll container is what bounds it visually.
  const shown = useMemo(() => (files ? matchMentions(files, query, 200) : []), [files, query]);

  function toggle(path: string) {
    if (already.has(path)) return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const chosen = [...selected];

  return (
    <Modal title="Project files" onClose={onClose} width={560}>
      <div data-testid="project-file-picker">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or path…"
          aria-label="Filter project files"
          data-testid="project-file-search"
          autoFocus
          className={inputCls}
          style={inputStyle}
        />

        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Workspace files"
          className="my-3 max-h-[320px] overflow-y-auto rounded border"
          style={{ borderColor: "var(--border)" }}
        >
          {files === null && (
            <p className="p-3 text-[12px]" style={{ color: "var(--text-faint)" }}>Reading the workspace…</p>
          )}
          {files !== null && shown.length === 0 && (
            <p className="p-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
              {files.length === 0
                ? "The workspace listing is empty. Set a workspace root, or type an @ reference by hand."
                : `No file matches “${query}”.`}
            </p>
          )}
          {shown.map((f) => {
            const isAlready = already.has(f.path);
            const isSelected = isAlready || selected.has(f.path);
            return (
              <button
                key={f.path}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-testid="project-file-option"
                onClick={() => toggle(f.path)}
                disabled={isAlready}
                className="mono flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors disabled:opacity-50"
                style={{
                  background: isSelected ? "var(--surface-2)" : "transparent",
                  color: isSelected ? "var(--text)" : "var(--text-dim)",
                }}
              >
                {/* The mark is a character, not a colour alone: a selected row must be readable to
                    someone who cannot distinguish the two background shades. */}
                <span aria-hidden="true" className="w-3 shrink-0" style={{ color: "var(--accent)" }}>
                  {isSelected ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                {isAlready && (
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>already added</span>
                )}
                {!isAlready && typeof f.bytes === "number" && (
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>
                    {Math.max(1, Math.round(f.bytes / 1024))} KB
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Files are referenced as <span className="mono">@path</span> and read at send time, so a file
          too large to send whole says so in the message instead of arriving half-read.
        </p>

        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={chosen.length === 0} onClick={() => { onAdd(chosen); onClose(); }}>
            {chosen.length === 0 ? "Add references" : `Add ${chosen.length} reference${chosen.length === 1 ? "" : "s"}`}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {chosen.length > 0 && (
            <button
              type="button"
              className="ml-auto text-[11px]"
              style={{ color: "var(--text-faint)" }}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
