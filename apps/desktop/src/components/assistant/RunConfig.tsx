/**
 * The run-configuration controls — the switches and fields that decide how one Assistant turn
 * runs. Extracted from `AssistantScreen` (turn-engine phase 6): the screen owns the state, this
 * component owns the presentation and the small draft-then-commit fields.
 */
import { useEffect, useState } from "react";
import { APPROVAL_MODES, type ApprovalMode } from "../../lib/tools/approval";
import {
  MAX_ITERATIONS_CAP,
  SUBAGENT_RESULT_CAP,
  SUBAGENT_RESULT_CAP_MAX,
  SUBAGENT_RESULT_CAP_MIN,
  clampIterations,
  resolveSubagentResultCap,
} from "../../lib/tools";
import { inputStyle } from "../atoms";

function RunSwitchRow({
  label,
  displayLabel,
  checked,
  onChange,
  disabled,
  note,
}: {
  label: string;
  displayLabel?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** One line under the name — usually why the row is disabled. */
  note?: string;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded px-2 py-1.5 text-[12px] ${disabled ? "opacity-50" : "cursor-pointer"}`}
      style={{ color: "var(--text)" }}
    >
      <span className="min-w-0">
        <span className="block truncate">{displayLabel ?? label}</span>
        {note && (
          <span className="block text-[10px]" style={{ color: "var(--text-faint)" }}>
            {note}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        className="switch shrink-0"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/**
 * Tool-step ceiling for one agent turn.
 *
 * The draft is held as text while the field is focused: clamping on every keystroke would fight
 * the user — typing "12" passes through "1", and clearing the field to retype it would snap back
 * to a number mid-edit. The value is clamped when the edit is finished, not while it is in
 * progress.
 *
 * Two states, both stated on screen rather than left to a tooltip: **a number** means the turn is
 * bounded and carries a clear button, **blank** means it is not counted and says so in words. A
 * blank box that only a hover explains is how this field misled users twice.
 */
function StepBudget({
  value,
  onChange,
  disabled,
}: {
  /** The user's budget, or `null` for no ceiling — see `AgentLoopOptions.maxIterations`. */
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  // `null` renders as an empty field, which is also how the user asks for no limit: the blank
  // state and the unbounded state are the same state, so nothing has to translate between them.
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  // Follow the value when it changes from outside this field — hydration, or a reset.
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);

  const commit = () => {
    // The raw string, not `Number(draft)`: an emptied field means "no limit", and `Number("")` is
    // 0 — which would clamp to the minimum and turn a cleared box into a one-step loop that
    // returns an empty answer and reports success.
    const next = clampIterations(draft);
    onChange(next);
    setDraft(next === null ? "" : String(next));
  };

  return (
    // The run-configuration panel's step budget, under the agent switches it belongs to. The
    // accessible name stays "tool steps" (aria-label wins over the label's visible text), so the
    // spec that fills this field keeps matching.
    //
    // **The blank state is labelled on screen, not only in a tooltip.** "Blank means no limit" lived
    // in the `title` attribute alone, and a field whose meaning is visible only on hover is how this
    // one came to be misread twice — once defaulting to 8, once to a 250 backstop nobody could see.
    // The clear button is the same fix for the action: the stored value is a real `null` rather than
    // an omission, so emptying the box *is* a setting change and should be one click, not a
    // select-all. It sits outside the `<label>` because a button nested in a label also activates the
    // input.
    <span
      className={`flex items-center gap-1.5 ${disabled ? "opacity-50" : ""}`}
      style={{ color: "var(--text-dim)" }}
      title={
        disabled
          ? "only applies in agent mode — without tools there is nothing to step through"
          : `how many rounds of tool calls one turn may take (1–${MAX_ITERATIONS_CAP}), or blank for no limit — the loop stops as soon as the model answers, and a long turn is reminded to wrap up`
      }
    >
      <label className="flex items-center gap-1.5">
        <span className="text-[11px]">Steps</span>
        <input
          type="number"
          min={1}
          max={MAX_ITERATIONS_CAP}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          aria-label="tool steps"
          className="no-spin w-14 rounded-full border px-2 py-0.5 text-center text-[11px]"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
        />
      </label>
      {value === null ? (
        // Reads `value`, not `draft`: mid-edit the box can be empty while a number is still stored,
        // and this label describes what is saved rather than what is being typed.
        <span className="text-[11px] italic opacity-70">no limit</span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-label="clear step budget"
          title="clear the step budget — a turn will not be counted, and stops when the model answers"
          onClick={() => {
            onChange(null);
            setDraft("");
          }}
          className="rounded-full border px-1.5 text-[11px] leading-none"
          style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text-dim)" }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * How much of a sub-agent's summary reaches the parent transcript.
 *
 * Same draft-then-commit shape as `StepBudget`, and for the same reason: clamping per keystroke
 * fights the user, and an emptied field means "the loop's default" — passing the raw string into
 * the clamp is what keeps a blank box from becoming `0` characters of summary.
 */
function SubagentSummaryCap({
  value,
  onChange,
  disabled,
}: {
  /** The user's cap, or `null` for the loop's default — see `AgentLoopOptions.subagentSummaryCap`. */
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);

  const commit = () => {
    // The raw string into the clamp, never `Number(draft)` first: `Number("")` is 0.
    const next = draft.trim() === "" ? null : resolveSubagentResultCap(Number(draft));
    onChange(next);
    setDraft(next === null ? "" : String(next));
  };

  return (
    <label
      className={`flex items-center gap-1.5 ${disabled ? "opacity-50" : ""}`}
      style={{ color: "var(--text-dim)" }}
      title={
        disabled
          ? "only applies in agent mode — without tools there is nothing to delegate"
          : `characters of a sub-agent's summary kept for this conversation (${SUBAGENT_RESULT_CAP_MIN}–${SUBAGENT_RESULT_CAP_MAX}), or blank for the default (${SUBAGENT_RESULT_CAP}) — the point of delegating is that the survey does not land here`
      }
    >
      <span className="text-[11px]">Sub-agent summary</span>
      <input
        type="number"
        min={SUBAGENT_RESULT_CAP_MIN}
        max={SUBAGENT_RESULT_CAP_MAX}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-label="sub-agent summary characters"
        className="no-spin w-16 rounded-full border px-2 py-0.5 text-center text-[11px]"
        style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
      />
    </label>
  );
}

function ApprovalPicker({
  mode,
  onChange,
  disabled,
}: {
  mode: ApprovalMode;
  onChange: (m: ApprovalMode) => void;
  disabled?: boolean;
}) {
  const current = APPROVAL_MODES.find((m) => m.id === mode) ?? APPROVAL_MODES[0]!;
  return (
    // The run toolbar's approval control: the named choice inline with the toggles, its
    // consequence carried by the tooltip rather than a visible hint line — the row has no room
    // for a sentence, and hiding it here would be worse than shortening it.
    <label
      className={`flex items-center gap-1.5 text-[11px] ${disabled ? "opacity-50" : ""}`}
      style={{ color: "var(--text-dim)" }}
      title={current.hint}
    >
      <span>Approval mode</span>
      <select
        value={mode}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ApprovalMode)}
        aria-label="How agent tool calls are approved"
        data-testid="approval-mode"
        className="mono max-w-[150px] rounded-md border px-1.5 py-0.5 text-[11px] disabled:opacity-40"
        style={inputStyle}
      >
        {APPROVAL_MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface RunConfigProps {
  agentMode: boolean;
  setAgentMode: (v: boolean) => void;
  useMemory: boolean;
  setUseMemory: (v: boolean) => void;
  autoCompact: boolean;
  setAutoCompact: (v: boolean) => void;
  approvalMode: ApprovalMode;
  setApprovalMode: (v: ApprovalMode) => void;
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  noTools: boolean;
  setNoTools: (v: boolean) => void;
  subagentsCanWrite: boolean;
  setSubagentsCanWrite: (v: boolean) => void;
  maxIterations: number | null;
  setMaxIterations: (v: number | null) => void;
  subagentsSummaryCap: number | null;
  setSubagentsSummaryCap: (v: number | null) => void;
}

/** The inner panel. The dialog wrapper and the outside-click catcher stay with the toolbar that
 *  opens them; this component only owns the controls. */
export function RunConfig({
  agentMode,
  setAgentMode,
  useMemory,
  setUseMemory,
  autoCompact,
  setAutoCompact,
  approvalMode,
  setApprovalMode,
  planMode,
  setPlanMode,
  noTools,
  setNoTools,
  subagentsCanWrite,
  setSubagentsCanWrite,
  maxIterations,
  setMaxIterations,
  subagentsSummaryCap,
  setSubagentsSummaryCap,
}: RunConfigProps) {
  return (
    <>
      <RunSwitchRow label="Agent mode" checked={agentMode} onChange={setAgentMode} />
      <RunSwitchRow label="Memory" checked={useMemory} onChange={setUseMemory} />
      <RunSwitchRow
        label="Auto-compact long context"
        displayLabel="auto-compact"
        checked={autoCompact}
        onChange={setAutoCompact}
        note={
          autoCompact
            ? "oldest turns are summarized before a turn that would overflow the model window"
            : "off — a long turn may hit the provider's context limit"
        }
      />
      <div className="px-2 py-1.5">
        <ApprovalPicker mode={approvalMode} onChange={setApprovalMode} disabled={!agentMode} />
        {agentMode && planMode && (
          // Plan mode carries its own read policy (2026-10-10): the gate lets reads run and
          // refuses every write, whatever the approval select above says. The old copy told
          // the user to go pair "auto-approve reads" themselves — the design admitting a
          // friction it could just remove. Living next to the approval select it overrides,
          // not as a stray line above the transcript.
          <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }} data-testid="plan-mode-hint">
            Plan mode is read-only: reads and searches run without asking, every write is refused.
          </p>
        )}
      </div>
      <RunSwitchRow
        label="Plan mode"
        checked={planMode}
        onChange={setPlanMode}
        disabled={!agentMode}
        note={agentMode ? undefined : "agent mode only"}
      />
      <RunSwitchRow
        label="tell the model it has no tools"
        displayLabel="no tools"
        checked={noTools}
        onChange={setNoTools}
        disabled={agentMode}
        note={agentMode ? "agent mode provides the tools" : undefined}
      />
      <RunSwitchRow
        label="Sub-agent writes"
        checked={subagentsCanWrite}
        onChange={setSubagentsCanWrite}
        disabled={!agentMode}
        note={
          !agentMode
            ? "agent mode only"
            : subagentsCanWrite
              ? "a delegated sub-agent may modify the workspace; every write still asks your approval"
              : "sub-agents are read-only researchers"
        }
      />
      <div className="mt-1 flex flex-wrap items-center gap-3 border-t px-2 pt-2" style={{ borderColor: "var(--border)" }}>
        <StepBudget value={maxIterations} onChange={setMaxIterations} disabled={!agentMode} />
        <SubagentSummaryCap
          value={subagentsSummaryCap}
          onChange={setSubagentsSummaryCap}
          disabled={!agentMode}
        />
      </div>
    </>
  );
}
