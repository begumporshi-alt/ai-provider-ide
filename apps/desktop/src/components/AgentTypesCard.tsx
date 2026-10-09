/**
 * Agent types card — the management half of the Subagents screen, for user-authored
 * `dispatch_agent` specialists.
 *
 * Each specialist is one JSON file in the app's data dir (`agents/<id>.json`, written by the
 * host's `agent_def_*` commands); this card is thin CRUD over those files, the same shape the
 * MCP-servers list in Settings keeps: a typed array, a per-row enable toggle, a remove with
 * confirm, and a search box (the Models screen's filter pattern). What the model sees of a
 * specialist — its id, name, and description, routed through `dispatch_agent`'s `agent`
 * argument — is authored here; the tool allowlist can only ever *narrow* the read-effect set,
 * which the guard in `lib/agents/defs.ts` enforces at parse time.
 *
 * Files the guard rejects do not vanish: they render as warning rows with their reason, because
 * a definition the user wrote that silently never dispatches is a bug report waiting to happen.
 *
 * A card on the Subagents screen rather than a screen of its own: definitions and the runs they
 * produced answer the same question ("what can the agent delegate to, and what did it do"), so
 * they belong on one screen.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Modal, inputCls, inputStyle } from "./atoms";
import { useUi } from "../ui-state";
import { agentDefDelete, agentDefSave, agentDefSetEnabled, agentDefsList, type AgentDefFile } from "../store";
import { allowableToolNames, isValidDefId, parseSubagentDef, parseSubagentDefs, type SubagentDef } from "../lib/agents/defs";

interface Draft {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  maxIterations: string;
}

const EMPTY_DRAFT: Draft = { id: "", name: "", description: "", systemPrompt: "", tools: [], model: "", maxIterations: "" };

export function AgentTypesCard() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [rows, setRows] = useState<AgentDefFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // null in the modal = new
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    agentDefsList()
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, [tick]);

  const { defs, skipped } = useMemo(() => parseSubagentDefs(rows ?? []), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return defs;
    return defs.filter(
      (d) => d.id.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
    );
  }, [defs, query]);

  const save = async (draft: Draft) => {
    const def: SubagentDef = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt,
      ...(draft.tools.length ? { tools: draft.tools } : {}),
      model: draft.model.trim() || null,
      ...(draft.maxIterations.trim() ? { maxIterations: Number(draft.maxIterations) } : {}),
      enabled: true,
    };
    // The screen shows the guard's own rejection instead of letting the host guess: a def the
    // parse guard would skip is one the user needs to fix now, in this modal.
    const probe = parseSubagentDefForSave(def);
    if (probe) {
      setError(probe);
      return;
    }
    try {
      await agentDefSave(def.id, JSON.stringify(def, null, 2));
      setEditing(null);
      setError(null);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = async (def: SubagentDef) => {
    try {
      await agentDefSetEnabled(def.id, !def.enabled);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await agentDefDelete(id);
      setConfirmingId(null);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const beginEdit = (def: SubagentDef) => {
    setEditingId(def.id);
    setEditing({
      id: def.id,
      name: def.name,
      description: def.description,
      systemPrompt: def.systemPrompt,
      tools: def.tools ?? [],
      model: def.model ?? "",
      maxIterations: def.maxIterations !== undefined ? String(def.maxIterations) : "",
    });
  };

  const toolNames = allowableToolNames();
  // What "all read tools" means numerically: the read-effect set minus the two the loop itself
  // strips from every sub-agent (delegation and todos). The badge must not count tools the
  // child can never receive.
  const defaultToolCount = toolNames.filter((t) => t !== "dispatch_agent" && t !== "todo_write").length;

  return (
    <section aria-label="Agent types" data-testid="agent-types-card">
      {/* Toolbar in the ZCode-subagents shape: identity left, search and "New" right. */}
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-[16px] font-semibold">Agent types</h2>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {defs.length} specialist{defs.length === 1 ? "" : "s"} · {defs.filter((d) => d.enabled).length} enabled
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
              style={{ color: "var(--text-faint)" }}
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <input
              className={`${inputCls} w-56 pl-8`}
              style={inputStyle}
              placeholder="Search agent types…"
              aria-label="Search agent types"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            ariaLabel="Add agent type"
            onClick={() => {
              setEditingId(null);
              setEditing({ ...EMPTY_DRAFT });
            }}
          >
            ＋ New
          </Button>
        </div>
      </div>

      <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
        Specialists the agent can delegate to with <span className="mono">dispatch_agent</span> — the built-in set
        ships with the app, and each one is a JSON file in the app's data directory, editable by hand as well as
        here. A specialist can narrow the read-only toolset, run on its own model, and carry its own step budget;
        it can never gain write tools or spawn further sub-agents. Click a card to edit it.
      </p>

      {error && (
        <div className="mb-3 rounded border px-3 py-2 text-[12px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {rows !== null && defs.length === 0 && skipped.length === 0 && (
        <EmptyState
          title={
            "No agent types yet. The built-in researcher is always available to dispatch_agent; add a " +
            "specialist here when a kind of task deserves its own instructions, tools, or model."
          }
        />
      )}

      {skipped.length > 0 && (
        <div className="mb-3 rounded border px-3 py-2 text-[12px]" style={{ borderColor: "var(--warn)" }}>
          <p className="mb-1 font-medium" style={{ color: "var(--warn)" }}>
            {skipped.length} definition file{skipped.length === 1 ? "" : "s"} could not be loaded:
          </p>
          {skipped.map((s) => (
            <p key={s.fileName} className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
              {s.fileName}.json — {s.error}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {filtered.map((def) => (
          <div
            key={def.id}
            className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
            data-testid="agent-type-row"
          >
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: agentColor(def.id) + "22", color: agentColor(def.id) }}
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5">
                <rect x="5" y="8" width="14" height="10" rx="2.5" />
                <path d="M12 8V5m0 0a1.5 1.5 0 1 0-.01-3 1.5 1.5 0 0 0 .01 3ZM9 13h.01M15 13h.01" />
              </svg>
            </div>
            <div
              className="min-w-0 flex-1 cursor-pointer"
              onClick={() => beginEdit(def)}
              title={`Click to edit ${def.name}`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-semibold">{def.name}</span>
                <span
                  className="rounded-full border px-1.5 py-px text-[10px]"
                  style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
                >
                  {def.model ?? "Inherit"}
                </span>
                <span
                  className="rounded-full border px-1.5 py-px text-[10px]"
                  style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
                >
                  {def.tools?.length ?? defaultToolCount} tools
                </span>
              </div>
              <p className="line-clamp-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
                {def.description}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={def.enabled}
              aria-label={def.enabled ? `Disable ${def.name}` : `Enable ${def.name}`}
              title={def.enabled ? "Disable — the model will not be offered this specialist" : "Enable"}
              onClick={() => void toggle(def)}
              className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
              style={{ background: def.enabled ? "var(--accent)" : "var(--surface-2)", border: "1px solid var(--border)" }}
            >
              <span
                className={`absolute top-[1px] h-[16px] w-[16px] rounded-full shadow transition-all ${def.enabled ? "left-[18px]" : "left-[1px]"}`}
                style={{ background: "#fff" }}
              />
            </button>
            <button
              type="button"
              aria-label={`Remove ${def.name}`}
              title={`Remove ${def.name}`}
              onClick={() => setConfirmingId(def.id)}
              className="shrink-0 rounded p-1 transition-opacity hover:opacity-80"
              style={{ color: "var(--text-faint)" }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M4 7h16M9.5 7V4.5h5V7m-8.5 0 1 13.5h10L18.5 7" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {editing !== null && (
        <Modal
          title={editingId ? `Edit ${editingId}` : "Add agent type"}
          onClose={() => setEditing(null)}
        >
          <div className="flex flex-col gap-2">
            <label className="text-[12px]">
              Id <span style={{ color: "var(--text-faint)" }}>(lowercase letters, digits, - or _ — what the model passes as "agent")</span>
              <input
                className={`${inputCls} mt-1 w-full`}
                style={inputStyle}
                value={editing.id}
                disabled={editingId !== null}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
              />
            </label>
            <label className="text-[12px]">
              Name
              <input className={`${inputCls} mt-1 w-full`} style={inputStyle} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="text-[12px]">
              Description <span style={{ color: "var(--text-faint)" }}>(shown to the model, so it can route to this specialist)</span>
              <input className={`${inputCls} mt-1 w-full`} style={inputStyle} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label className="text-[12px]">
              System prompt
              <textarea
                className={`${inputCls} mt-1 h-28 w-full resize-y`}
                style={inputStyle}
                value={editing.systemPrompt}
                onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
              />
            </label>
            <fieldset className="text-[12px]">
              <legend style={{ color: "var(--text-faint)" }}>Tools (none checked = all read tools)</legend>
              <div className="mt-1 grid max-h-32 grid-cols-2 gap-1 overflow-y-auto rounded border p-2" style={{ borderColor: "var(--border)" }}>
                {toolNames.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={editing.tools.includes(t)}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          tools: e.target.checked ? [...editing.tools, t] : editing.tools.filter((x) => x !== t),
                        })
                      }
                    />
                    <span className="mono">{t}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-2">
              <label className="flex-1 text-[12px]">
                Model <span style={{ color: "var(--text-faint)" }}>(blank = inherit the session model)</span>
                <input className={`${inputCls} mt-1 w-full`} style={inputStyle} value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} placeholder="provider/model" />
              </label>
              <label className="w-28 text-[12px]">
                Rounds
                <input className={`${inputCls} mt-1 w-full`} style={inputStyle} value={editing.maxIterations} onChange={(e) => setEditing({ ...editing, maxIterations: e.target.value })} placeholder="12" />
              </label>
            </div>
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save(editing)} disabled={!isValidDefId(editing.id.trim())}>
                {editingId ? "Save" : "Add agent type"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmingId !== null && (
        <Modal title={`Remove ${confirmingId}?`} onClose={() => setConfirmingId(null)}>
          <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
            The file <span className="mono">{confirmingId}.json</span> is deleted. Runs it already served stay on the
            Agents and Subagents ledgers.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingId(null)}>
              Cancel
            </Button>
            <Button variant="danger" ariaLabel="Confirm remove" onClick={() => void remove(confirmingId)}>
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Run the same guard the loader runs, but for a def being saved from this card. Returns the
 *  rejection reason, or null when the def parses clean. (The loader takes raw rows; here the
 *  def is already typed, so it goes through one wrapper.) */
function parseSubagentDefForSave(def: SubagentDef): string | null {
  const got = parseSubagentDef({ ...def });
  return "error" in got ? got.error : null;
}

/** A stable per-agent accent, capsule-style: the same id always hashes to the same hue, with no
 *  state to keep in step — the way ZCode tags each agent with a color dot. */
const AGENT_COLORS = ["#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f59e0b", "#14b8a6", "#ec4899", "#64748b"];

function agentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length]!;
}
