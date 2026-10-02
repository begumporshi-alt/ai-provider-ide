/**
 * The Assistant's floating capsule (2026-10-02).
 *
 * One collapsible widget pinned to the transcript's right edge, holding the two run-alongside
 * readouts the transcript itself has no room for:
 *
 *   - GIT TOOLS — the workspace repository's live state (branch, ahead/behind, the +/- line
 *     counts, the changed files) and the "Commit & push" action. Data comes from the
 *     `git_summary` Tauri command; the action from `git_commit_push`. Both wrap the same
 *     scrubbed-environment git execution the model's sandbox uses (core::tools), so the capsule
 *     and the agent can never disagree about what the workspace looks like.
 *
 *   - PROGRESS — the task list the model maintains through the `todo_write` tool. The list lives
 *     in `Chat` (parsed straight off the tool-call events); this component only renders it.
 *
 * Collapsed it is a small pill, so an idle session keeps the transcript clean. Expanded it is a
 * card in the style of the rest of the screen: Tailwind for layout, CSS variables for color.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

interface GitFileEntry {
  path: string;
  status: string;
}

interface GitSummary {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  files: GitFileEntry[];
}

const OPEN_KEY = "aip.assistant.capsule.open";

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveOpen(v: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {
    /* private mode: the capsule just stops remembering */
  }
}

export function AssistantCapsule({ root, todos, busy }: { root: string; todos: TodoItem[]; busy: boolean }) {
  const [open, setOpen] = useState(loadOpen);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitNote, setCommitNote] = useState<{ ok: boolean; text: string } | null>(null);
  const activeTodo = todos.find((t) => t.status === "in_progress");
  const done = todos.filter((t) => t.status === "completed").length;

  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (!root.trim()) {
        setSummary(null);
        setGitError(null);
        return;
      }
      try {
        const s = await invoke<GitSummary>("git_summary", { root });
        if (alive) {
          setSummary(s);
          setGitError(null);
        }
      } catch (e) {
        if (alive) setGitError(String(e));
      }
    };
    void read();
    return () => {
      alive = false;
    };
  }, [root, open, busy]);

  const dirty = summary?.files.length ?? 0;

  const commitAndPush = async () => {
    if (!message.trim() || committing) return;
    setCommitting(true);
    setCommitNote(null);
    try {
      const text = await invoke<string>("git_commit_push", { root, message: message.trim() });
      setCommitNote({ ok: true, text });
      setMessage("");
      const s = await invoke<GitSummary>("git_summary", { root });
      setSummary(s);
    } catch (e) {
      setCommitNote({ ok: false, text: String(e) });
    } finally {
      setCommitting(false);
    }
  };

  if (!open) {
    return (
      <div className="absolute right-3 top-2 z-30 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            saveOpen(true);
          }}
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-lg transition-opacity hover:opacity-90"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text-dim)" }}
          title="Git tools & progress"
          data-testid="assistant-capsule-open"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
            <circle cx="6" cy="6" r="2.2" />
            <circle cx="6" cy="18" r="2.2" />
            <circle cx="18" cy="9" r="2.2" />
            <path d="M6 8.2v7.6M18 11.2c0 3-3 3.6-6 4" />
          </svg>
          {dirty > 0 && (
            <span className="rounded-full px-1.5 text-[10px]" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              {dirty}
            </span>
          )}
          {activeTodo && <span className="spinner h-2.5 w-2.5" aria-hidden="true" />}
        </button>
      </div>
    );
  }

  return (
    <div
      className="absolute right-3 top-2 z-30 flex w-72 flex-col rounded-xl border shadow-xl"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      data-testid="assistant-capsule"
    >
      {/* --- Git tools --- */}
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>
          Git tools
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            saveOpen(false);
          }}
          className="text-[12px]"
          style={{ color: "var(--text-faint)" }}
          aria-label="Collapse"
          title="Collapse"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="m6 9 6-6 6 6M6 15l6 6 6-6" />
          </svg>
        </button>
      </div>

      <div className="px-3 pb-2.5 pt-1.5">
        {!root.trim() ? (
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            Set a workspace root to see its repository here.
          </p>
        ) : gitError ? (
          <p className="text-[11px]" style={{ color: "var(--danger)" }}>
            {gitError}
          </p>
        ) : !summary ? (
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            Reading the repository…
          </p>
        ) : !summary.isRepo ? (
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            Not a git repository.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
                  <circle cx="6" cy="6" r="2.2" />
                  <circle cx="6" cy="18" r="2.2" />
                  <circle cx="18" cy="9" r="2.2" />
                  <path d="M6 8.2v7.6M18 11.2c0 3-3 3.6-6 4" />
                </svg>
                <span className="mono truncate" style={{ color: "var(--text)" }}>{summary.branch || "—"}</span>
              </span>
              {(summary.ahead > 0 || summary.behind > 0) && (
                <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {summary.ahead > 0 && <span style={{ color: "var(--success)" }}>↑{summary.ahead} </span>}
                  {summary.behind > 0 && <span style={{ color: "var(--warn)" }}>↓{summary.behind}</span>}
                </span>
              )}
            </div>

            <div className="mt-1.5 flex items-center justify-between text-[12px]">
              <span style={{ color: "var(--text-dim)" }}>
                Changes{dirty > 0 && <span className="mono ml-1 text-[11px]">{dirty} file{dirty === 1 ? "" : "s"}</span>}
              </span>
              {(summary.insertions > 0 || summary.deletions > 0) && (
                <span className="mono text-[11px]">
                  <span style={{ color: "var(--success)" }}>+{summary.insertions}</span>{" "}
                  <span style={{ color: "var(--danger)" }}>−{summary.deletions}</span>
                </span>
              )}
            </div>

            {summary.files.length > 0 && (
              <ul className="mono mt-1.5 max-h-28 space-y-0.5 overflow-y-auto text-[10.5px]" style={{ color: "var(--text-dim)" }}>
                {summary.files.map((f) => (
                  <li key={f.path} className="flex items-center gap-1.5">
                    <span className="w-3 shrink-0" style={{ color: f.status === "?" ? "var(--info)" : "var(--warn)" }}>
                      {f.status}
                    </span>
                    <span className="truncate" title={f.path}>{f.path}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2.5 flex items-center gap-1.5">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitAndPush();
                }}
                placeholder="Commit message"
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-[11px] outline-none"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
                data-testid="capsule-commit-message"
              />
              <button
                type="button"
                onClick={() => void commitAndPush()}
                disabled={committing || !message.trim()}
                className="shrink-0 rounded-md border px-2 py-1 text-[11px] transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
                data-testid="capsule-commit-push"
              >
                {committing ? "…" : "Commit & push"}
              </button>
            </div>
            {commitNote && (
              <p className="mt-1 text-[10.5px]" style={{ color: commitNote.ok ? "var(--success)" : "var(--danger)" }}>
                {commitNote.text}
              </p>
            )}
          </>
        )}
      </div>

      {/* --- Progress --- */}
      {todos.length > 0 && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>
              Progress
            </span>
            <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
              {done}/{todos.length}
            </span>
          </div>
          <ul className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto">
            {todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-[11.5px] leading-snug">
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {t.status === "completed" ? (
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" style={{ color: "var(--success)" }} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9.5" fill="var(--success)" stroke="none" opacity="0.15" />
                      <circle cx="12" cy="12" r="9.5" />
                      <path d="m8 12.5 2.6 2.6L16 9.5" />
                    </svg>
                  ) : t.status === "in_progress" ? (
                    <span className="spinner h-3 w-3" aria-hidden="true" />
                  ) : (
                    <span className="block h-3 w-3 rounded-full border" style={{ borderColor: "var(--border)" }} aria-hidden="true" />
                  )}
                </span>
                <span
                  className={t.status === "completed" ? "line-through" : ""}
                  style={{ color: t.status === "pending" ? "var(--text-faint)" : "var(--text-dim)" }}
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
