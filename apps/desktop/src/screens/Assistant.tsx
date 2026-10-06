/**
 * Assistant — a router console for talking to any routed model (UI_UX_PLAN.md §3): model picker,
 * streaming assistant text, a STOP button (cancellation, spec req. 9), and after every
 * request the calm summary line (`✓ 421ms · OpenRouter · key-03` / `↻ 1 fallback`) with an
 * expandable per-attempt route trace. Acceptance criterion 4: text + image end-to-end.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  catalog,
  listSkills,
  registry,
  router,
  loadHistorySessions,
  resumeSession,
  historyMaxSeq,
  setSessionTitle as saveSessionTitle,
  type HistorySession,
} from "../store";
import { selectableModels } from "../lib/models/selectable";
import { fetchImageUrl } from "../ipc-client";
import { invoke } from "@tauri-apps/api/core";
import { fetchAdmin } from "../lib/gateway-client";
import { gatewayGenerate, gatewayGenerateImage } from "../lib/gateway-turn";
import { useUi } from "../ui-state";
import { Button, Modal, inputCls, inputStyle } from "../components/atoms";
import { Markdown } from "../components/Markdown";
import { Composer, type Attachment, type InlinedText } from "../components/Composer";
import { parseListing, type MentionCandidate } from "../lib/chat/mentions";
import { parseAssistantStream, type ToolSegment } from "../lib/assistant-stream";
import { editPoint, retryPoint } from "../lib/chat/actions";
import { instructionSystemText } from "../lib/chat/context-blocks";
import { createTauriToolHost, fetchToolsPolicy, fetchDefaultRoot, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP, type ToolsPolicy, type AgentEvent } from "../lib/tools";
import {
  APPROVAL_MODES, INITIAL_APPROVAL, revertPlan,
  type ApprovalMode, type ApprovalState, type RunChangeSet,
} from "../lib/tools";
import { ApproveModal, type ApprovalChoice } from "../components/ApproveModal";
import { ChangeSetReview } from "../components/ChangeSetReview";
import { AssistantCapsule, type TodoItem } from "../components/AssistantCapsule";
import { DiffView } from "../components/DiffView";
import {
  fileChangeFor,
  groupSearchMatches,
  groupToolRuns,
  indexToolCalls,
  isSearchResult,
  type ToolCallRef,
  type ToolStep,
} from "../lib/tools/render";
import type { ChatMessage, ReasoningEffort, ToolCall, UsageTokens } from "@aiprovider/router-core";
import {
  estimateTokens, DEFAULT_CONTEXT_WINDOW, textOfContent, compressWithSummary, type CatalogModel,
} from "@aiprovider/router-core";
import { formatCost } from "../lib/ledger/format";
import { chargeSessionUsage, emptySessionUsage } from "../lib/ledger/session-usage";
import { shortcutFor } from "../lib/keys/shortcuts";
import { activeSession, startSession, type Recorder } from "../lib/context/recorder";
import { endRun, newRunId, recordStep, registerAbort, startRun } from "../lib/agent/orchestrator";
import {
  distilTurn, memoryBlock, recallContext, recordRecall, rememberTurn,
} from "../lib/memory/engine";
import { newMsgId, replayHistory, withIds, type Msg } from "../lib/chat/turn/messages";
import {
  agentSystem, AGENT_SYSTEM, NO_TOOLS_SYSTEM, PLAN_APPROVED_TURN,
} from "../lib/chat/turn/prompt";
import { tryParseArgs } from "../lib/chat/turn/graph-record";
import { runPlainTurn } from "../lib/chat/turn/plain-turn";
import { runAgentTurn } from "../lib/chat/turn/agent-turn";
import { beginTurn, currentTurn } from "../lib/chat/turn/controller";
import type { Trace } from "../lib/chat/turn/ports";

/**
 * Tier 2 summarizer — what the assistant hands to `generateText` so dropped context becomes a
 * summary rather than vanishing.
 *
 * Three decisions worth stating, because each is a way this could go wrong:
 *
 *  - **`skipCompression` on the inner call.** Without it, producing a summary would compress,
 *    which would summarize, which would compress. That flag is the only thing breaking the
 *    chain.
 *  - **The input is capped.** The dropped turns are precisely the ones that did not fit, so
 *    feeding them back verbatim can overflow the summarizer's own request. Clipping is not a
 *    correctness measure — a summary is lossy either way — it is what stops the fix from
 *    becoming the next overflow.
 *  - **Failure is already handled, here by doing nothing.** A throw is caught inside
 *    `compressWithSummary`, which falls back to Tier 1 truncation, so this function may fail
 *    freely and the request still goes out.
 *
 * The call is ledgered like any other: it spends real tokens, and a summarizer that concealed
 * its own cost would make the spend numbers lie.
 */
const SUMMARIZER_INPUT_CHARS = 12_000;
const SUMMARIZER_MAX_TOKENS = 300;
const SUMMARY_PROMPT =
  "Summarise the conversation above for an assistant that must continue it. Keep decisions, " +
  "names, numbers, file paths and anything still pending. Plain prose, no preamble, no headings.";

function createSummarizer(model: string): (dropped: ChatMessage[]) => Promise<string> {
  return async (dropped) => {
    const transcript = dropped
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, SUMMARIZER_INPUT_CHARS);
    // A1 Phase 1: served by the gateway engine, so the summarizer's spend lands in the same
    // ledger the gateway writes — the "ledgered like any other" comment below is now literal.
    const exec = await gatewayGenerate({
      model,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
      maxTokens: SUMMARIZER_MAX_TOKENS,
    });
    let out = "";
    for await (const chunk of exec.chunks) out += chunk;
    return out.trim();
  };
}

interface AgentItem {
  name: string;
  args: Record<string, unknown>;
  status: "calling" | "ok" | "error" | "denied";
  result?: string;
}

/**
 * Compact token counts for a strip that has to share a line with the composer.
 *
 * Local rather than shared because there is no other copy to agree with: `Activity` prints raw
 * `tokensIn/tokensOut` in a table cell that has the width for them, and this one does not.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
}


/**
 * One switch row inside the run-configuration panel: setting name on the left, pill switch on
 * the right. The accessible name is always the full setting name — the same names the inline
 * controls used to carry — so the specs and screen readers keep matching them; `displayLabel`
 * only shortens the visible text.
 */
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
 */
function StepBudget({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  // Follow the value when it changes from outside this field — hydration, or a reset.
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    // The raw string, not `Number(draft)`: an emptied field must read as "no answer" and fall
    // back to the default, and `Number("")` is 0 — which would clamp to the minimum and turn a
    // cleared box into a one-step loop that returns an empty answer and reports success.
    const next = clampIterations(draft);
    onChange(next);
    setDraft(String(next));
  };

  return (
    // The run-configuration panel's step budget, under the agent switches it belongs to. The
    // accessible name stays "tool steps" (aria-label wins over the label's visible text), so the
    // spec that fills this field keeps matching.
    <label
      className={`flex items-center gap-1.5 ${disabled ? "opacity-50" : ""}`}
      style={{ color: "var(--text-dim)" }}
      title={
        disabled
          ? "only applies in agent mode — without tools there is nothing to step through"
          : `how many rounds of tool calls one turn may take (1–${MAX_ITERATIONS_CAP}); the loop also stops as soon as the model answers without calling a tool`
      }
    >
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
  );
}

/**
 * The system-prompt editor.
 *
 * Three prompts, because the screen has three: the no-tools guard, the agent instructions, and a
 * plain-chat prompt that only applies when the guard is off. They are separate fields rather than
 * one because the choice between them is the switches' job — a single field would have to be
 * rewritten every time the user toggled agent mode, losing whatever the other mode said.
 *
 * Every field starts empty and empty means **the built-in default**. Pre-filling the textareas with
 * the constants would look identical and behave differently: the first keystroke would fork the
 * built-in prompt into a stored copy, so a later improvement to the constant would never reach a
 * user who had opened the editor and typed one character. A placeholder shows what will be used
 * without claiming it.
 */
function SystemPromptEditor({
  customSystem,
  customNoTools,
  customAgent,
  searchProvider,
  hasSearchKey,
  onChangeSearchProvider,
  onSaveSearchKey,
  onChangeSystem,
  onChangeNoTools,
  onChangeAgent,
  onClose,
}: {
  customSystem: string;
  customNoTools: string;
  customAgent: string;
  searchProvider: "none" | "brave" | "tavily";
  hasSearchKey: boolean;
  onChangeSearchProvider: (v: "none" | "brave" | "tavily") => void;
  onSaveSearchKey: (key: string) => void;
  onChangeSystem: (v: string) => void;
  onChangeNoTools: (v: string) => void;
  onChangeAgent: (v: string) => void;
  onClose: () => void;
}) {
  const ta = "mono w-full rounded border p-2 text-[11px]";
  const taStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" } as const;
  const [keyDraft, setKeyDraft] = useState("");
  const field = (
    label: string,
    hint: string,
    value: string,
    onChange: (v: string) => void,
    fallback: string,
  ) => (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>{label}</span>
        <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>{hint}</span>
        {value && (
          <button
            type="button"
            className="ml-auto text-[10px] underline decoration-dotted"
            style={{ color: "var(--text-dim)" }}
            onClick={() => onChange("")}
            title="Drop your copy and go back to the built-in prompt"
          >
            reset to default
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallback}
        rows={5}
        className={`${ta} resize-y`}
        style={taStyle}
        aria-label={`${label} — blank uses the built-in prompt`}
      />
    </div>
  );
  return (
    <Modal title="System prompts" onClose={onClose} width={620}>
      <p className="mb-3 text-[11px]" style={{ color: "var(--text-dim)" }}>
        Blank fields use the built-in prompt, shown greyed as the placeholder. These are stored with
        the Assistant's settings and apply to every new turn.
      </p>
      {field(
        "no-tools guard",
        "prepended while “tell the model it has no tools” is on",
        customNoTools,
        onChangeNoTools,
        NO_TOOLS_SYSTEM,
      )}
      {field(
        "agent instructions",
        "used in agent mode; the workspace root is appended after it",
        customAgent,
        onChangeAgent,
        AGENT_SYSTEM,
      )}
      {field(
        "plain chat",
        "used when the no-tools guard is off and agent mode is off",
        customSystem,
        onChangeSystem,
        "(no system prompt is sent unless you write one)",
      )}
      <div className="mb-3 rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>
            Web search API key (optional)
          </span>
          {hasSearchKey && (
            <span className="text-[10px]" style={{ color: "var(--success)" }}>
              a key is saved
            </span>
          )}
        </div>
        <p className="mb-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
          Search works without one (keyless, with fallback backends). Adding a Brave or Tavily key
          puts that provider first in the chain — far more reliable under load. The key goes to the
          OS vault; it is never readable back here and never reaches the model or the transcript.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={searchProvider}
            onChange={(e) => onChangeSearchProvider(e.target.value as "none" | "brave" | "tavily")}
            className="rounded border bg-transparent px-2 py-1 text-[11px]"
            style={{ borderColor: "var(--border)", color: "var(--text)" }}
            aria-label="Search key provider"
          >
            <option value="none">None (keyless)</option>
            <option value="brave">Brave Search</option>
            <option value="tavily">Tavily</option>
          </select>
          <input
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={hasSearchKey ? "replace the saved key…" : "paste an API key"}
            disabled={searchProvider === "none"}
            className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[11px] disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--text)" }}
            aria-label="Search API key"
          />
          <button
            type="button"
            onClick={() => {
              onSaveSearchKey(keyDraft.trim());
              setKeyDraft("");
            }}
            disabled={searchProvider === "none" || !keyDraft.trim()}
            className="shrink-0 rounded-md border px-2 py-1 text-[11px] transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
            style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
          >
            Save
          </button>
        </div>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

/**
 * The Assistant's settings, persisted under the `assistant` key.
 *
 * They are settings rather than per-session state because they describe how the user wants the
 * screen to behave, not what this one conversation is doing — and the workspace root in
 * particular is something nobody wants to retype. Same shape the Gateway and Background screens
 * use: one JSON blob per screen, read on mount, written on change.
 */
interface AssistantSettings {
  root?: string;
  agentMode?: boolean;
  useMemory?: boolean;
  noTools?: boolean;
  /** Ceiling on tool-calling rounds in one turn. Stored raw; clamped on read, because a value
   *  written by a future build may sit outside today's bounds and must not crash the screen. */
  maxIterations?: number;
  /** Per-request model parameters. `null` means "unset — send the provider's default", and is
   *  deliberately distinct from absent: the write below serialises with `JSON.stringify`, which
   *  DROPS an `undefined` key, so a cleared field saved as `undefined` would leave the previous
   *  value in the row and silently restore it on the next load. */
  temperature?: number | null;
  maxTokens?: number | null;
  /**
   * How much the model should think, per request. `null`/absent means "unset — leave the
   * provider's own default", the same convention as the two fields above and for the same
   * reason: clearing it has to overwrite the stored level, not vanish from the row.
   *
   * Validated against `THINKING_LEVELS` on read rather than trusted, like `approvalMode`: an
   * unknown string from a future build would otherwise be rendered as a selected value the
   * select cannot show, and reach the wire as no field at all — a silent downgrade.
   */
  thinking?: ReasoningEffort | null;
  /** Editable system prompts. Empty or absent = the built-in constant; also written as "" for the
   *  same reason as above (a cleared prompt has to overwrite the stored one). */
  systemPrompt?: string;
  noToolsSystem?: string;
  agentSystem?: string;
  /**
   * Phase 5 approval mode.
   *
   * Persisted, like `agentMode`: it is how the user wants the screen to behave, and re-choosing it
   * every launch would be a setting that is not one. Plan mode is deliberately NOT persisted — it
   * is an intent for one pass, and a launch that quietly refused every write because of a flag
   * left on in a previous session would be a very confusing way to lose an afternoon.
   */
  approvalMode?: ApprovalMode;
  /**
   * Optional web-search key tier. Only the PROVIDER lives here; the key itself goes to the
   * vault (`websearch` account, `<provider>|<key>`), because a credential is not settings data.
   * Absent = keyless search, the default.
   */
  searchProvider?: "brave" | "tavily" | null;
  /** The chosen text model as a qualified id (`slug/native`). Empty/absent = the store default. */
  model?: string;
}

const ASSISTANT_SETTINGS_KEY = "assistant";

/**
 * The thinking levels the composer offers, in the order they render. `""` — the provider's own
 * default — is deliberately NOT in this list: it is the unset state of the select, rendered as
 * its own option, so "unset" is a real chooseable value rather than a missing one that a future
 * build could mistake for a level.
 */
const THINKING_LEVELS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"];

async function loadAssistantSettings(): Promise<AssistantSettings> {
  try {
    // The keyed route answers an **object**; the IPC command answered a JSON *string*. The
    // `JSON.parse` that used to sit here is gone with the transport rather than kept as a no-op —
    // parsing an object would throw, and the `catch` below would turn that into "no settings".
    const parsed: unknown = await fetchAdmin("GET", `/admin/settings/${ASSISTANT_SETTINGS_KEY}`);
    return parsed && typeof parsed === "object" ? (parsed as AssistantSettings) : {};
  } catch {
    return {}; // no stored settings is not an error — it is the first run
  }
}

function saveAssistantSettings(s: AssistantSettings): void {
  // Fire and forget: a failed write must not stop the user from using the screen.
  //
  // A **merge** now, where the IPC command was a whole-row UPSERT: a key another writer added
  // between this call and the write survives. Nothing else writes the `assistant` row today, so the
  // difference is invisible here — and it is the direction that cannot lose data.
  void fetchAdmin("POST", `/admin/settings/${ASSISTANT_SETTINGS_KEY}`, s).catch(() => undefined);
}

export function AssistantScreen() {
  // `Chat` subscribes to the tick itself (the skills block re-reads on it), so this shell does
  // not — and not subscribing is what keeps a store bump from tearing down the transcript.
  const [tab, setTab] = useState<"text" | "image" | "root">("text");
  // The DOM node the session features portal into (see the title row). State, not a ref: Chat has
  // to re-render once the node exists, which a ref callback + setState gives us for free.
  const [sessionSlot, setSessionSlot] = useState<HTMLDivElement | null>(null);
  // The switches live here, above `Chat`, so switching Chat/Image does not silently reset them.
  // `Chat` unmounts on a tab switch; how the user has configured the screen outliving that is
  // the difference between "the tab changed" and "my settings changed".
  const [noTools, setNoTools] = useState(true);
  const [agentMode, setAgentMode] = useState(false);
  // P5: how the agent's tool calls are gated. `ask` is today's behaviour and the default, so a
  // user who never opens the control gets exactly what they had.
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
  // P5: plan mode — a pass that may not modify the workspace, whose answer is a plan to approve.
  // Session-scoped and never persisted; see the note in `AssistantSettings`.
  const [planMode, setPlanMode] = useState(false);
  // P7: memory is on by default but switchable. Recalling and distilling on every turn changes
  // what the model sees and costs a second call, so it has to be possible to turn it off.
  const [useMemory, setUseMemory] = useState(true);
  // Whether the run-configuration panel (the sliders icon beside "Add context") is open. The five
  // behaviour switches it holds keep their state above `Chat` — only the door lives here.
  const [runConfigOpen, setRunConfigOpen] = useState(false);
  // The tool-step ceiling. It is a setting rather than a constant because it is the one knob
  // that trades cost against thoroughness per run: a one-shot question wants 1, a real refactor
  // across a repo doesn't finish in 8.
  const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
  const [temperature, setTemperature] = useState<number | "">("");
  const [maxTokens, setMaxTokens] = useState<number | "">("");
  // The thinking level. `""` is "unset" — send no field and leave the provider's own default,
  // which is the behaviour of every build before this one, so an untouched screen is unchanged.
  const [thinking, setThinking] = useState<ReasoningEffort | "">("");
  // System-prompt editor state — a string means "editing", null means "closed".
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");
  const [customNoToolsSystem, setCustomNoToolsSystem] = useState("");
  const [customAgentSystem, setCustomAgentSystem] = useState("");
  // The web-search key tier: which provider (if any) the search chain should lead with, and
  // whether a key is already in the vault (the key itself is never readable back from the
  // webview — `vault_has` only, by design).
  const [searchProvider, setSearchProvider] = useState<"none" | "brave" | "tavily">("none");
  const [hasSearchKey, setHasSearchKey] = useState(false);
  const [root, setRoot] = useState("");
  // A root that will not work is worth saying before the run, not after it. An unusable root
  // used to reach the model as a blank tool result, which reads as "the agent is broken" rather
  // than "the path you typed does not exist" — and the model echoes that back.
  const [rootError, setRootError] = useState<string | null>(null);
  // Nothing is written until the stored settings have been read. Without this the first render
  // would save the defaults over whatever the user had actually chosen.
  const [hydrated, setHydrated] = useState(false);
  // The chosen text model, lifted out of `Chat` so the Run configuration card can own the whole
  // "where does this go" column (mock layout): the picker, the provider chip and the routed badge
  // are one control. `Chat` becomes a pure consumer of `chosen`. `def` is the same store default
  // `Chat` used to fall back to before the lift.
  const [model, setModel] = useState("");
  const [pickerNonce, setPickerNonce] = useState(0);
  // The sandbox policy is a screen-level fact — what the host confines agent runs to — shown in
  // the card's Advanced column. `Chat` used to fetch it lazily in agent mode; fetching once on
  // mount costs one host call and lets the card disclose the sandbox before the first run.
  const [sandboxPolicy, setSandboxPolicy] = useState<ToolsPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchToolsPolicy()
      .then((p) => {
        if (!cancelled) setSandboxPolicy(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate: stored settings first, then the host's default workspace, then empty.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stored, fallback] = await Promise.all([loadAssistantSettings(), fetchDefaultRoot()]);
      if (cancelled) return;
      if (typeof stored.noTools === "boolean") setNoTools(stored.noTools);
      if (typeof stored.agentMode === "boolean") setAgentMode(stored.agentMode);
      if (typeof stored.useMemory === "boolean") setUseMemory(stored.useMemory);
      // Clamped, not trusted: the stored JSON is ours but not written by this build.
      if (stored.maxIterations != null) setMaxIterations(clampIterations(stored.maxIterations));
      // A stored `null` is a real value here — it is how "unset" survives the round trip — so the
      // tests are explicitly for `null` first and then for a usable number. A blank field and a
      // field holding 0 are different requests: 0 is a real temperature.
      if (stored.temperature === null) setTemperature("");
      else if (typeof stored.temperature === "number" && stored.temperature >= 0 && stored.temperature <= 2) {
        setTemperature(stored.temperature);
      }
      if (stored.maxTokens === null) setMaxTokens("");
      else if (typeof stored.maxTokens === "number" && stored.maxTokens > 0) setMaxTokens(Math.round(stored.maxTokens));
      // Validated against the known levels, never trusted: a word a future build invented would
      // otherwise be stored as a selection the select cannot show, or reach the wire as no field
      // while the UI claimed a level. Anything unrecognised stays unset, which is the honest
      // reading of "this build does not know that level".
      if (THINKING_LEVELS.includes(stored.thinking as ReasoningEffort)) setThinking(stored.thinking as ReasoningEffort);
      if (typeof stored.systemPrompt === "string") setCustomSystemPrompt(stored.systemPrompt);
      if (typeof stored.noToolsSystem === "string") setCustomNoToolsSystem(stored.noToolsSystem);
      if (typeof stored.agentSystem === "string") setCustomAgentSystem(stored.agentSystem);
      // Validated against the known ids rather than trusted: an unknown string from a future
      // build would otherwise reach `decide()` and match none of its branches, which reads as
      // "ask every time" — a silent downgrade the user could not see.
      if (APPROVAL_MODES.some((m) => m.id === stored.approvalMode)) setApprovalMode(stored.approvalMode!);
      if (stored.searchProvider === "brave" || stored.searchProvider === "tavily") setSearchProvider(stored.searchProvider);
      // A model choice survives a remount like every other setting — without this, coming back to
      // the screen reset the picker and Send sat disabled until the user re-picked.
      if (typeof stored.model === "string") setModel(stored.model);
      void invoke("vault_has", { account: "websearch" })
        .then((has) => setHasSearchKey(Boolean(has)))
        .catch(() => undefined);
      setRoot(stored.root ?? fallback ?? "");
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One literal, not one per write site. The switches used to be serialised twice — adding a
  // field meant editing both, and forgetting one saved a settings object with the new key
  // missing, which reads back as "the user never changed it".
  const saveAll = useCallback(
    () => saveAssistantSettings({
      root, agentMode, useMemory, noTools, maxIterations, approvalMode,
      // Always written, empty string included: a model the picker cleared has to overwrite the
      // stored one, not vanish from the row.
      model,
      // `null`, never `undefined`, for an unset field. `JSON.stringify` omits an undefined key, so
      // an omitted one leaves the previously stored value in the row — clearing "max tokens" would
      // look like it worked and then quietly come back on the next load.
      temperature: typeof temperature === "number" ? temperature : null,
      maxTokens: typeof maxTokens === "number" ? maxTokens : null,
      // `null` for unset, for the same round-trip reason as the two above.
      thinking: thinking === "" ? null : thinking,
      // Always written, empty string included: same reason, for the three prompts.
      systemPrompt: customSystemPrompt,
      noToolsSystem: customNoToolsSystem,
      agentSystem: customAgentSystem,
      // `null` for "none" — a cleared provider has to overwrite the stored one, not vanish.
      searchProvider: searchProvider === "none" ? null : searchProvider,
    }),
    [root, agentMode, useMemory, noTools, maxIterations, approvalMode, model, temperature, maxTokens, thinking,
      customSystemPrompt, customNoToolsSystem, customAgentSystem, searchProvider],
  );

  // The debounced write below must serialise the state as it is WHEN IT FIRES, not as it was
  // when it was scheduled. `setTimeout(saveAll, 400)` captures the `saveAll` of the render that
  // scheduled it, and this effect only re-runs on `root` — so a switch toggled inside the
  // debounce window was written, then overwritten with the pre-toggle snapshot. A human is
  // slower than 400 ms and never saw it; a driver is not, and the setting silently reverted.
  const latestSave = useRef(saveAll);
  latestSave.current = saveAll;

  // Persist. The switches are single clicks, so they are written immediately — and so is the
  // model pick, which is what makes it survive a remount.
  useEffect(() => {
    if (!hydrated) return;
    saveAll();
    // `root` is written by the debounced effect below; depending on it here would write twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, agentMode, useMemory, noTools, maxIterations, approvalMode, model, temperature, maxTokens, thinking,
      customSystemPrompt, customNoToolsSystem, customAgentSystem]);

  // ...but the root is typed one character at a time, so it is debounced instead.
  useEffect(() => {
    if (!hydrated) return;
    const t = window.setTimeout(() => latestSave.current(), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, root]);

  // Judge the workspace root against the same rule the host enforces.
  useEffect(() => {
    if (!agentMode || !root.trim()) {
      setRootError(null);
      return;
    }
    let cancelled = false;
    invoke("tools_check_root", { root: root.trim() })
      .then(() => {
        if (!cancelled) setRootError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = String(e);
        // "I could not check" is not "I checked and it is unusable" — an older backend without
        // this command must not be the reason Send is disabled.
        setRootError(/not found/i.test(msg) ? null : msg);
      });
    return () => {
      cancelled = true;
    };
  }, [agentMode, root]);

  // Where this screen's turns go. Same shape `Chat` used to compute: an explicit pick wins, the
  // store's default text model is the fallback.
  const textDef = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.text ?? "";
  const chosenText = model || textDef;

  // The run toolbar (user's layout): one sliders icon beside "Add context" opens the
  // run-configuration panel — agent mode, memory, approval, plan mode, the no-tools guard and the
  // step budget in one place — instead of five inline controls crowding the composer row. Every
  // control is this component's state; `Chat` only gives the panel its seat in the row. The icon
  // carries the state at a glance: accent while agent mode is on, a dot whenever anything differs
  // from its default — hiding the switches must not hide their effect.
  const runConfigDirty =
    agentMode || planMode || !useMemory || !noTools || approvalMode !== "ask" || maxIterations !== DEFAULT_MAX_ITERATIONS;
  const runToolbar = (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="Run configuration"
        aria-expanded={runConfigOpen}
        onClick={() => setRunConfigOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors"
        style={{
          borderColor: agentMode || runConfigOpen ? "var(--accent)" : "var(--border)",
          color: agentMode ? "var(--accent)" : "var(--text-dim)",
        }}
        title="Agent mode, memory, approval, plan mode, tools and steps for this run"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M4 7h9M17.5 7H20M4 12h1.5M10 12h10M4 17h9M17.5 17H20" />
          <circle cx="15" cy="7" r="2.2" />
          <circle cx="7.5" cy="12" r="2.2" />
          <circle cx="15" cy="17" r="2.2" />
        </svg>
        {/* aria-hidden: the dot is decoration — the state it signals is read from the panel. */}
        {runConfigDirty && <span aria-hidden="true" className="h-1 w-1 rounded-full" style={{ background: "var(--accent)" }} />}
      </button>
      {runConfigOpen && (
        <>
          {/* The outside-click catcher. The composer sits at the screen's bottom, so the panel
              opens UPWARD from the row — a downward dropdown would be clipped. */}
          <div data-testid="run-config-overlay" className="fixed inset-0 z-40" onClick={() => setRunConfigOpen(false)} />
          <div
            role="dialog"
            aria-label="Run configuration"
            className="absolute bottom-full left-0 z-50 mb-1.5 w-80 rounded-lg border p-1.5 shadow-lg"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRunConfigOpen(false);
            }}
          >
            <RunSwitchRow label="Agent mode" checked={agentMode} onChange={setAgentMode} />
            <RunSwitchRow label="Memory" checked={useMemory} onChange={setUseMemory} />
            <div className="px-2 py-1.5">
              <ApprovalPicker mode={approvalMode} onChange={setApprovalMode} disabled={!agentMode} />
              {agentMode && planMode && (
                // The pairing is the whole reason this appears: plan mode subtracts permissions
                // and never grants them, so a plan pass that reads without being clicked through
                // needs the mode above it to say so. Living next to the approval select it names,
                // not as a stray line above the transcript.
                <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }} data-testid="plan-mode-hint">
                  Plan mode refuses every write, whatever the approval mode. Pair it with “auto-approve reads”
                  for a pass that explores without asking.
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
            <div className="mt-1 border-t px-2 pt-2" style={{ borderColor: "var(--border)" }}>
              <StepBudget value={maxIterations} onChange={setMaxIterations} disabled={!agentMode} />
            </div>
          </div>
        </>
      )}
    </div>
  );
  const modelCorner = (
    <ModelPicker modality="text" value={chosenText} onChange={setModel} openNonce={pickerNonce} />
  );

  return (
    // Full width, not `max-w-6xl`: at this app's 13px root font 6xl is ~940px, which is what made
    // the screen read as a narrow strip — the mock runs the assistant edge to edge inside the
    // shell's padding.
    <div className="flex h-full w-full flex-col" data-testid="assistant-column">
      {/* The title row carries the session features (portal from `Chat`, which owns their state —
          the slot here is where they render) and the three tabs. Root setup moved into its own tab
          with a folder browser, which freed this row for the session controls. */}
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-[16px] font-semibold tracking-tight">Assistant</h1>
        <div ref={setSessionSlot} className="flex min-w-0 flex-1 items-center gap-2" />
        {agentMode && root.trim() ? (
          // In agent mode the root is the one fact the transcript can't show, so it stays visible
          // here as a chip that opens the Root tab — the pane is one click away either way.
          <button
            type="button"
            onClick={() => setTab("root")}
            className="nav-icon-btn flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
            style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
            title={`${root}${rootError ? ` — ${rootError}` : " — open the Root tab"}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
              <path d="M3.5 7.5h6l2 2.5h9v8.5h-17v-11Z" />
            </svg>
            <span className="max-w-[180px] truncate">{root.split("/").filter(Boolean).pop() ?? root}</span>
          </button>
        ) : null}
        <div className="ml-auto flex gap-1 rounded-lg border p-0.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          {(["text", "image", "root"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="rounded-md px-3 py-1 text-[12px] font-medium transition-colors"
              style={tab === t ? { background: "var(--surface-2)", color: "var(--text)" } : { color: "var(--text-dim)" }}
            >
              {t === "text" ? "Chat" : t === "image" ? "Image" : "Root"}
            </button>
          ))}
        </div>
      </div>
      {/* No `key={tick}` here. Keying on the tick remounted Chat on every store bump, which
          wiped the conversation mid-session — a settings save took the transcript with it.
          Re-rendering is enough: the skills block re-reads on `tick` through its own effect,
          and the model list comes from the store. */}
      {/* Both panels stay mounted; the inactive one is hidden with CSS. Switching tabs used to
          UNMOUNT `Chat`, which took the transcript with it (Chat → Image → Chat lost the whole
          visible conversation and started blank) and orphaned an in-flight turn: its
          AbortController lived in the component that had just been destroyed, so the run could not
          be cancelled and its Stop button was gone. Keeping both mounted preserves the transcript,
          the run and its Stop button. */}
      <div className={tab === "text" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <Chat
          noTools={noTools}
          agentMode={agentMode}
          useMemory={useMemory}
          maxIterations={maxIterations}
          approvalMode={approvalMode}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
          temperature={temperature}
          maxTokens={maxTokens}
          thinking={thinking}
          onTemperatureChange={setTemperature}
          onMaxTokensChange={setMaxTokens}
          onThinkingChange={setThinking}
          systemPrompt={customSystemPrompt || undefined}
          noToolsSystem={customNoToolsSystem || undefined}
          agentSystemPrompt={customAgentSystem || undefined}
          root={root}
          rootError={rootError}
          chosen={chosenText}
          onOpenModelPicker={() => setPickerNonce((n) => n + 1)}
          toolbar={runToolbar}
          corner={modelCorner}
          sessionSlot={sessionSlot}
          onEditPrompts={() => setEditingPrompt("system")}
          onSwitchToImageTab={() => setTab("image")}
          active={tab === "text"}
        />
      </div>
      <div className={tab === "image" ? "min-h-0 flex-1" : "hidden"}>
        <ImageBox />
      </div>
      <div className={tab === "root" ? "min-h-0 flex-1" : "hidden"}>
        <RootPane
          root={root}
          rootError={rootError}
          sandboxPolicy={sandboxPolicy}
          onSetRoot={setRoot}
        />
      </div>
      {editingPrompt !== null && (
        <SystemPromptEditor
          customSystem={customSystemPrompt}
          customNoTools={customNoToolsSystem}
          customAgent={customAgentSystem}
          searchProvider={searchProvider}
          hasSearchKey={hasSearchKey}
          onChangeSearchProvider={(v) => {
            setSearchProvider(v);
            if (v === "none") {
              void invoke("vault_delete", { account: "websearch" })
                .then(() => setHasSearchKey(false))
                .catch(() => undefined);
            }
          }}
          onSaveSearchKey={(key) => {
            void invoke("vault_put", { account: "websearch", secret: `${searchProvider}|${key}` })
              .then(() => setHasSearchKey(true))
              .catch(() => undefined);
          }}
          onChangeSystem={setCustomSystemPrompt}
          onChangeNoTools={setCustomNoToolsSystem}
          onChangeAgent={setCustomAgentSystem}
          onClose={() => setEditingPrompt(null)}
        />
      )}
    </div>
  );
}

/**
 * The model chooser.
 *
 * It offers **two forms** of an id, and the difference is not cosmetic — see
 * `lib/models/selectable.ts`. A qualified `slug/native` pins one provider; a bare native id lets
 * the router plan every enabled carrier, which is the only form `failoverEnabled` can act on.
 * Until this used `selectableModels`, every option was qualified, so `failoverEnabled: true` was
 * inert here and a provider failing ~29% of requests ended the request instead of failing over.
 *
 * `tick` rather than `registry.listProviders().length`: the option list now depends on provider
 * *status* (a bare entry is withheld when only one carrier is enabled), and a length is blind to a
 * status change. `Settings.tsx` already reads `tick` for exactly this reason.
 */
function ModelPicker({
  value,
  onChange,
  modality,
  openNonce = 0,
}: {
  value: string;
  onChange: (v: string) => void;
  modality: "text" | "image";
  /** Bumped from outside (`/model`) to open the panel; the picker keeps ownership of its own state. */
  openNonce?: number;
}) {
  const tick = useUi((s) => s.tick);
  const [open, setOpen] = useState(false);
  // Opening on a *change* of the nonce, not on a truthy value: the second `/model` has to open it
  // again, and a boolean would already be true by then.
  const seenNonce = useRef(openNonce);
  useEffect(() => {
    if (openNonce === seenNonce.current) return;
    seenNonce.current = openNonce;
    setOpen(true);
  }, [openNonce]);
  const [q, setQ] = useState("");
  const models = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    const isEnabled = (pid: string) => registry.getProvider(pid)?.status === "enabled";
    return selectableModels(catalog.forModality(modality), catalog.aliases, slugOf, isEnabled);
  }, [tick, modality]);
  const filtered = useMemo(
    () => models.filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase())),
    [models, q],
  );
  const current = models.find((m) => m.id === value)?.label ?? value;
  if (!models.length) return <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>no {modality} models — connect a provider</span>;
  return (
    <div className="relative">
      {/* A native select cannot be searched, and the catalog outgrew one: dozens of qualified ids
          plus their bare forms scroll past the visible options. A picker panel with a search box
          keeps the same ids and adds the one thing a select never had. */}
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQ(""); }}
        aria-label={`Model: ${current} — open picker`}
        aria-expanded={open}
        className="flex max-w-[340px] items-center gap-2 rounded border px-2 py-1 text-[12px]"
        style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
      >
        <span className="mono truncate">{current || "pick a model…"}</span>
        <span style={{ color: "var(--text-faint)" }}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-8 z-50 w-[380px] rounded border p-2 shadow-lg"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
            role="listbox"
            aria-label="Pick a model"
          >
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by model or provider slug…"
              className="mb-2 w-full rounded border px-2 py-1 text-[12px] outline-none"
              style={{ background: "var(--bg)", borderColor: "var(--border)" }}
            />
            <div className="max-h-64 overflow-y-auto">
              {filtered.map((m) => (
                <button
                  key={m.id}
                  role="option"
                  aria-selected={m.id === value}
                  className="mono block w-full truncate rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:opacity-80"
                  style={{
                    background: m.id === value ? "var(--surface)" : "transparent",
                    color: m.id === value ? "var(--text)" : "var(--text-dim)",
                  }}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  {m.label}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="px-2 py-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
                  No model matches “{q}”.
                </p>
              )}
            </div>
            <p className="mt-1 px-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
              {filtered.length} of {models.length} models
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A tool call the model emitted in-band. The router has no tool-execution layer yet, so this is
 * rendered as an inert, clearly-labelled block rather than silently dropped (which would hide
 * what the model was trying to do) or shown raw (which is what caused the mercury-2.5 report).
 */
function ToolCallChip({ seg }: { seg: ToolSegment }) {
  const entries = Object.entries(seg.params);
  return (
    <div
      className="mb-2 rounded border px-2.5 py-2"
      style={{ borderColor: "var(--warn)", background: "var(--surface-2)" }}
    >
      <div className="mono text-[11px]" style={{ color: "var(--warn)" }}>
        {seg.complete ? "tool call (not executed)" : "tool call… (streaming)"} · {seg.name ?? "unknown"}
      </div>
      {entries.map(([k, v]) => (
        <div key={k} className="mono mt-1 text-[11px] break-all" style={{ color: "var(--text-dim)" }}>
          <span style={{ color: "var(--text-faint)" }}>{k}: </span>
          {v.length > 400 ? `${v.slice(0, 400)}…` : v}
        </div>
      ))}
      {seg.complete && (
        <div className="mt-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Assistant has no tool layer — this was model output, not a real function call.
        </div>
      )}
    </div>
  );
}

/** Assistant output: prose as-is, in-band tool-call blocks surfaced instead of leaked raw. */
function AssistantContent({ raw }: { raw: string }) {
  const segs = useMemo(() => parseAssistantStream(raw), [raw]);
  if (segs.length === 0) {
    return <span className="text-[13px]" style={{ color: "var(--text-faint)" }}>…</span>;
  }
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <Markdown key={i} source={s.text} />
        ) : (
          <ToolCallChip key={i} seg={s} />
        ),
      )}
    </>
  );
}

/**
 * The empty-state suggestion cards. Each carries the prompt it will drop into the draft — the
 * visible text names the task, the prompt is what actually lands in the composer (via
 * `ComposerProps.seed`), so the card's copy and the model's instructions can say different things
 * without either lying.
 */
const SUGGESTIONS: readonly { icon: string; title: string; blurb: string; prompt: string }[] = [
  {
    icon: "code",
    title: "Explain this codebase",
    blurb: "Get a clear explanation of how this project works.",
    prompt: "Explain this codebase: what it does, how it is structured, and where the key entry points are.",
  },
  {
    icon: "bug",
    title: "Find and fix a bug",
    blurb: "Locate issues and propose fixes with code changes.",
    prompt: "Find a bug in this project, explain the root cause, and propose a fix with code changes.",
  },
  {
    icon: "doc",
    title: "Summarize recent changes",
    blurb: "Review commits, PRs, or file updates.",
    prompt: "Summarize recent changes in this workspace: commits, pull requests, or file updates.",
  },
];

/** The card glyphs, kept inline rather than an icon file for three paths. */
function SuggestionIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    code: <path d="m8.5 8-4 4 4 4m7-8 4 4-4 4M13.5 5l-3 14" />,
    bug: (
      <>
        <circle cx="12" cy="13" r="5" />
        <path d="M12 8V6.5M8.5 9 6.5 7m11 2 2-2M7 13H4.5m15 0H17M8.5 17l-2 2m11-2 2 2" />
      </>
    ),
    doc: <path d="M7 3.5h7l4 4V20.5H7v-17Zm7 0v4h4M10 12h5m-5 3.5h5" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden="true"
    >
      {paths[name] ?? paths.doc}
    </svg>
  );
}

/**
 * The Root tab: set the agent's workspace root by browsing instead of typing.
 *
 * The browser walks the real filesystem through `tools_list_dirs` — immediate child directories
 * only, one level per click — which exists precisely because the sandboxed `list_dir` must never
 * escape the current root. Typing a path stays available above the browser: some roots are faster
 * typed than clicked to, and the input is the same controlled value the rest of the screen reads.
 */
function RootPane({
  root,
  rootError,
  sandboxPolicy,
  onSetRoot,
}: {
  root: string;
  rootError: string | null;
  sandboxPolicy: ToolsPolicy | null;
  onSetRoot: (path: string) => void;
}) {
  const parentOf = (p: string) => {
    const t = p.replace(/\/+$/, "");
    const i = t.lastIndexOf("/");
    return i <= 0 ? "/" : t.slice(0, i) || "/";
  };
  // Start the browse at the current root's parent, so the first thing you see is the folder you
  // are already in, among its siblings — the fastest route to "somewhere next to where I was".
  const [browsePath, setBrowsePath] = useState(() => parentOf(root.trim() || "/"));
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDirs(null);
    setLoadError(null);
    invoke<string[]>("tools_list_dirs", { path: browsePath })
      .then((d) => {
        if (!cancelled) setDirs(d);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [browsePath]);

  const here = browsePath === root.trim();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" data-testid="root-pane">
      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
        <span className="shrink-0">Root:</span>
        <input
          value={root}
          onChange={(e) => onSetRoot(e.target.value)}
          placeholder="/absolute/path"
          title={rootError ?? "Workspace root the agent's tools are confined to"}
          className="min-w-0 flex-1 rounded border px-2 py-1 text-[12px]"
          style={rootError ? { ...inputStyle, borderColor: "var(--danger)" } : inputStyle}
          aria-invalid={rootError ? true : undefined}
        />
      </div>
      {rootError ? (
        <p className="-mt-2 text-[11px]" style={{ color: "var(--danger)" }} data-testid="root-pane-error">{rootError}</p>
      ) : (
        <p className="-mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          An absolute path. Agent tools — reading, writing, shell — are confined to this folder; {sandboxPolicy ? `the sandbox allows ${sandboxPolicy.programs.length} programs, capped at ${Math.round(sandboxPolicy.max_command_ms / 100) / 10}s per command.` : "the sandbox allowlist applies inside it."}
        </p>
      )}
      <div className="rounded-xl border" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => setBrowsePath(parentOf(browsePath))}
            disabled={browsePath === "/"}
            aria-label="Go up one level"
            title="Parent folder"
            className="nav-icon-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-40"
            style={{ color: "var(--text-dim)" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M12 19V5m-6 6 6-6 6 6" />
            </svg>
          </button>
          <span className="mono min-w-0 flex-1 truncate text-[12px]" title={browsePath}>
            {browsePath}
          </span>
          <button
            type="button"
            onClick={() => onSetRoot(browsePath)}
            disabled={here}
            className={`nav-icon-btn flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-60`}
            style={here ? { borderColor: "var(--border)", color: "var(--success)" } : { borderColor: "var(--border)", color: "var(--accent)" }}
          >
            {here ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                <path d="m4.5 12.5 5 5 10-11" />
              </svg>
            ) : null}
            {here ? "Current root" : "Set as root"}
          </button>
        </div>
        <div className="grid max-h-[340px] grid-cols-2 gap-1 overflow-y-auto p-2 sm:grid-cols-3">
          {dirs === null && !loadError && (
            <div className="col-span-full px-2 py-3">
              <span className="spinner" role="status" aria-label="Listing folders" />
            </div>
          )}
          {loadError && (
            <p className="col-span-full px-2 py-3 text-[11px]" style={{ color: "var(--danger)" }}>
              {loadError}
            </p>
          )}
          {dirs?.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setBrowsePath(`${browsePath === "/" ? "" : browsePath}/${d}`)}
              className="nav-item flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px]"
              style={{ color: "var(--text-dim)" }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true">
                <path d="M3.5 7.5h6l2 2.5h9v8.5h-17v-11Z" />
              </svg>
              <span className="truncate">{d}</span>
            </button>
          ))}
          {dirs?.length === 0 && (
            <p className="col-span-full px-2 py-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
              No subfolders here — this is a leaf. Set it as the root, or go up a level.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * `noTools`, `agentMode`, `useMemory` and `root` are owned by `AssistantScreen`, which renders
 * the switches under the title and persists all four as settings. `Chat` only consumes them —
 * one source of truth, and a tab switch cannot silently reset what the user chose.
 */
function Chat({
  noTools,
  agentMode,
  useMemory,
  maxIterations,
  approvalMode,
  planMode,
  onPlanModeChange,
  temperature,
  maxTokens,
  thinking,
  onTemperatureChange,
  onMaxTokensChange,
  onThinkingChange,
  systemPrompt,
  noToolsSystem,
  agentSystemPrompt,
  root,
  rootError,
  chosen,
  onOpenModelPicker,
  toolbar,
  corner,
  sessionSlot,
  onEditPrompts,
  onSwitchToImageTab,
  active,
}: {
  noTools: boolean;
  agentMode: boolean;
  useMemory: boolean;
  maxIterations: number;
  /** P5: how tool calls are gated. The mode itself lives in `AssistantScreen` (it is persisted);
   *  the trust the user grants from the modal is per-session state held here. */
  approvalMode: ApprovalMode;
  planMode: boolean;
  /** Called to leave plan mode — the executing pass runs with it off. */
  onPlanModeChange: (v: boolean) => void;
  /** Owned by `AssistantScreen`, like `root` — see the note on the composer strip below. */
  temperature: number | "";
  maxTokens: number | "";
  /** How much the model should think, or `""` for the provider's own default. Owned by
   *  `AssistantScreen` for the same reason as the two above. */
  thinking: ReasoningEffort | "";
  onTemperatureChange: (v: number | "") => void;
  onMaxTokensChange: (v: number | "") => void;
  onThinkingChange: (v: ReasoningEffort | "") => void;
  systemPrompt?: string;
  noToolsSystem?: string;
  /** Named `agentSystemPrompt` rather than `agentSystem`: the latter is the module-level builder
   *  this component still has to call, and a same-named prop silently shadows it. */
  agentSystemPrompt?: string;
  root: string;
  rootError: string | null;
  /** The resolved text model (explicit pick or store default), owned by `AssistantScreen` so the
   *  composer's toolbar and this transcript can never disagree about where a turn goes. */
  chosen: string;
  /** Opens the picker from outside (`/model`). The picker itself lives in the toolbar; Chat only
   *  triggers it. */
  onOpenModelPicker: () => void;
  /** The run controls (mode toggles) rendered into the composer's action row — built by
   *  `AssistantScreen`, which owns their state; see `ComposerProps.toolbar`. */
  toolbar?: ReactNode;
  /** The model picker, pinned to the composer's top-right corner; see `ComposerProps.corner`. */
  corner?: ReactNode;
  /**
   * The title row's session slot: when present, this component's session controls portal into it
   * (see `sessionControls`). `HTMLDivElement | null` — null until the title row has committed.
   */
  sessionSlot: HTMLDivElement | null;
  onEditPrompts: () => void;
  /** Switch the AssistantScreen to the Image tab (`/image`). */
  onSwitchToImageTab: () => void;
  /** Whether this panel is the visible tab. Keyboard actions are gated on it: the Image tab keeps
   *  `Chat` mounted but `hidden`, so a shortcut bound here would otherwise fire (and focus an
   *  invisible composer) while the user is looking at the Image tab. */
  active: boolean;
}) {
  const tick = useUi((s) => s.tick);
  // P8: the composer, so a shortcut (and the palette's "Focus the composer") can put the caret in
  // it without reaching into the DOM by id.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The empty-state suggestion cards fill the draft through this. `{ text, nonce }` claimed by the
  // composer (see `ComposerProps.seed`); bumping the nonce re-fills even when the text is identical,
  // which is what clicking the same card twice has to do.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | undefined>(undefined);
  // (`model` lives in `AssistantScreen` now — see the note on the `chosen` prop — so the Run
  // configuration card and this transcript cannot disagree about where a turn goes.)
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    // Cross-screen resume used to be seeded here as a raw transcript, while the recorder quietly
    // kept pointing at whichever session was open before — the on-screen turns and the recorded
    // session disagreed. The resume is now a session id (see `resumeSessionId`); the mount effect
    // below adopts it through the same path as the session chip.
    return [];
  });
  // Per-message interaction state. `copiedId` is keyed by message id (not text) so two identical
  // messages do not both flash "copied"; `editingId` is the user turn currently open in the inline
  // editor.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [finishReason, setFinishReason] = useState<string | undefined>(undefined);
  const [showTrace, setShowTrace] = useState(false);
  const [busy, setBusy] = useState(false);
  // The draft itself lives in `Composer` (it also owns attachments and the two menus). This is a
  // read-only mirror, reported on each keystroke, for the two things the parent needs it for: the
  // context meter's estimate of what the next send will contain, and nothing else.
  const [draftText, setDraftText] = useState("");
  /**
   * The per-turn instruction from the composer's "Add context" menu.
   *
   * Held here rather than inside `Composer` for the same reason `draftText` is: it is a system
   * message the next send will carry, and the context meter has to count it. It belongs to one turn
   * — cleared by the composer after a send — and never to the session, which is what separates it
   * from the durable prompt under ⚙.
   */
  const [turnInstruction, setTurnInstruction] = useState("");
  /** A one-line notice: a refused attachment, a mention that matched nothing. */
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ call: ToolCall; args: Record<string, unknown>; resolve: (choice: ApprovalChoice) => void } | null>(null);
  /**
   * P5: the trust the user has granted from the approval modal — this tool, or everything.
   *
   * Session-scoped and held here rather than in `AssistantScreen`: it is a decision about *this*
   * conversation (and, for "this session", expires with the app anyway), not a persisted setting.
   * The mode is the persisted half; see `AssistantSettings`.
   */
  const [granted, setGranted] = useState<{ trustedTools: ReadonlySet<string>; allowAll: boolean }>({
    trustedTools: new Set(),
    allowAll: false,
  });
  /** P5: what the finished run changed, for `ChangeSetReview`. Null until a run touches something. */
  const [runChanges, setRunChanges] = useState<RunChangeSet | null>(null);
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  /** The task list the model maintains through `todo_write`, rendered by the floating capsule.
   *  Session-scoped: a New chat clears it, a resumed one starts empty until the model writes a
   *  new list (the transcript of the old session is context, not live state). */
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [streamedText, setStreamedText] = useState("");
  /**
   * The agent run's reasoning so far. Live-only, exactly like `streamedText`: it describes the run
   * in flight, and the transcript that replaces it when the run ends is rebuilt from the loop's
   * messages. It exists so a run that spends 40 s thinking shows *that it is thinking* rather than
   * a still status line.
   */
  const [streamedReasoning, setStreamedReasoning] = useState("");
  // P7: usage capture for the context meter and token/cost readout.
  const [lastUsage, setLastUsage] = useState<UsageTokens | null>(null);
  // Tokens this agent run has spent so far — every model call in the loop reports, and the live
  // status line sums them. `lastUsage` stays the single-request readout the meter's tooltip uses.
  const [runUsage, setRunUsage] = useState<{ tokensIn: number; tokensOut: number }>({ tokensIn: 0, tokensOut: 0 });
  // `unpricedRows`/`rows` are the honesty inputs for the cost figure: a total that silently skips
  // the requests whose model published no price is a number the user cannot tell apart from a
  // complete one, and this app treats "unknown" and "free" as different facts everywhere else.
  const [sessionCost, setSessionCost] = useState<{ micros: number; rows: number; unpriced: number }>({
    micros: 0,
    rows: 0,
    unpriced: 0,
  });
  const [sessionTokensIn, setSessionTokensIn] = useState(0);
  const [sessionTokensOut, setSessionTokensOut] = useState(0);
  // The in-flight turn (abort handle + approval gate) lives at module level — lib/chat/turn/
  // controller — so it outlives this screen: the Agents dashboard's stop button is the remote
  // control for a run still in flight, reached precisely by navigating away from here.
  // True from the moment Stop is clicked until the run actually unwinds. With the sandbox's
  // `tool_cancel` in place the gap is short — a running command is signalled SIGINT (then
  // SIGKILL) and the stream aborts immediately — but it is not zero, and naming it is what keeps
  // the click from ever feeling ignored.
  const [stopping, setStopping] = useState(false);
  const stopRun = useCallback(() => {
    const turn = currentTurn();
    if (!turn) return;
    setStopping(true);
    turn.stop();
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  // P4: the context graph is recorded as the conversation happens. `activeSession` rather than
  // `startSession` so any remount — switching tabs, for one — reuses the open session instead of
  // fragmenting one conversation into unrelated threads.
  const ctxRef = useRef<Recorder | null>(null);
  if (!ctxRef.current) ctxRef.current = activeSession();
  const lastNodeRef = useRef<string | null>(null);
  // Phase 4 — the session bar. `sessionId` has to be state, not read once: a New chat and a resume
  // both swap the recorder underneath, and the title is keyed by whichever session is current.
  const [sessionId, setSessionId] = useState(() => ctxRef.current!.sessionId);
  const [sessionTitle, setSessionTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  // P5: enabled skills are appended to the agent's instructions. Re-read on every tick so
  // installing or revoking a skill changes the agent's behaviour without restarting the app.
  const [skillsBlock, setSkillsBlock] = useState("");
  useEffect(() => {
    listSkills()
      .then((all) => {
        const active = all.filter((s) => s.enabled);
        setSkillsBlock(
          active.length === 0
            ? ""
            : "\n\nInstalled skills — when the task matches one, follow its procedure:\n\n"
              + active.map((s) => `## ${s.name}\n${s.description}\n\n${s.body}`).join("\n\n"),
        );
      })
      .catch(() => undefined);
  }, [tick]);

  // P7: aggregate session cost/tokens from the usage the turns themselves report.
  //
  // Pre-A1 this re-read the in-memory ledger after every turn. Post-A1 the Assistant's rows are
  // written host-side as `source: "gateway"` — the same source every external client's rows carry,
  // with no app key on those rows to tell them apart — so a ledger read can no longer say what
  // *this* session spent (it would either show nothing or silently include ZCode's traffic). Each
  // `runTurn` branch therefore charges its own usage as the turn completes: the plain path from the
  // terminal usage chunk, the agent path once per completed model call. A turn whose stream died
  // before the usage chunk reports nothing — honest, since those tokens were mostly never billed.
  const sessionUsageRef = useRef(emptySessionUsage());
  const addSessionUsage = useCallback(
    (tokensIn: number, tokensOut: number, provider: string | undefined, model: string | undefined) => {
      // Same rule Activity's rows use: a turn's cost is only meaningful when the catalog knows a
      // price for the model that actually served it (the served ids are exactly what pricingFor
      // wants — provider id + native id, per the bridge's Served frame). Without this check an
      // unpriced model contributes 0 and the total reads as though the request were free.
      const pricing = provider && model ? catalog.pricingFor(provider, model) : undefined;
      sessionUsageRef.current = chargeSessionUsage(sessionUsageRef.current, { tokensIn, tokensOut, pricing });
      const u = sessionUsageRef.current;
      setSessionCost({ micros: u.micros, rows: u.rows, unpriced: u.unpriced });
      setSessionTokensIn(u.tokensIn);
      setSessionTokensOut(u.tokensOut);
    },
    [],
  );

  /**
   * The cost cell: an exact total, a lower bound, or "unknown".
   *
   * Three states rather than one number, because collapsing them is how a cost readout lies. A
   * partial sum is marked `≥ …` so the user knows a request is missing from it, and traffic with no
   * price at all renders as `—` (unknown) rather than `$0.00` (free).
   */
  const costLabel =
    sessionCost.rows === 0
      ? formatCost(0)
      : sessionCost.unpriced === sessionCost.rows
        ? formatCost(null)
        : `${sessionCost.unpriced > 0 ? "≥ " : ""}${formatCost(sessionCost.micros)}`;

  // P8: keep the palette honest about "New chat" — it is refused while a turn runs (same reason
  // `newChat` guards on `busy`: re-entering the loop mid-stream interleaves two runs into one
  // transcript), so the palette needs to know.
  const setAssistantBusy = useUi((s) => s.setAssistantBusy);
  useEffect(() => {
    setAssistantBusy(busy);
  }, [busy, setAssistantBusy]);
  // Cleared on unmount and only on unmount, so leaving the Assistant does not leave a stale "a turn
  // is running" behind for the palette to report on another screen.
  //
  // Deliberately NOT an abort. Unmounting is how the user reaches the Agents dashboard, whose stop
  // button is the supported remote control for a run still in flight — an agent parked on its
  // approval gate is stoppable from there and nowhere else (pinned by web-test/agent-approval
  // "stopping a run parked on the approval gate unblocks it", which an abort here breaks: the run
  // dies before the dashboard can offer its stop). A run abandoned this way still finishes and is
  // recorded host-side; it is not an orphan, and killing it on navigation would be the bug.
  useEffect(() => () => setAssistantBusy(false), [setAssistantBusy]);

  // P8: the palette's one-shot intents. The request is *claimed* here — consumed only once this
  // component has decided it is the addressee — so a command fired from another screen survives the
  // mount that navigation causes, and is not replayed on some later mount because it is gone.
  const pendingIntent = useUi((s) => s.pendingIntent);
  const consumeIntent = useUi((s) => s.consumeIntent);
  // The latest `newChat`, read through a ref so the effect below does not re-bind on every render
  // (`newChat` closes over `busy` and the recorder, so it is a new function each time).
  const latestNewChat = useRef(newChat);
  latestNewChat.current = newChat;
  useEffect(() => {
    if (pendingIntent?.kind === "new-chat") {
      consumeIntent();
      latestNewChat.current();
    } else if (pendingIntent?.kind === "focus-composer") {
      consumeIntent();
      inputRef.current?.focus();
    }
    // An intent addressed at another screen is left alone: whoever owns it is responsible for
    // clearing it, and clearing it here would drop a request that screen has not seen yet.
  }, [pendingIntent, consumeIntent]);

  // P8: the Assistant's own keys — new chat and stop. They live here rather than in the global host
  // because only this component knows whether a turn is running, and a "stop" that fired with
  // nothing to stop would be a shortcut that lies about what it did.
  //
  // The handler reads through refs and is bound once per `active` change: its dependencies are
  // `busy`, `newChat` and the abort controller, all of which change constantly while streaming.
  const keyActions = useRef<{ newChat: () => void; stop: () => void; busy: boolean }>({
    newChat, stop: () => undefined, busy,
  });
  keyActions.current = { newChat, stop: stopRun, busy };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // A dialog owns Escape. The check works because this listener is registered before the
      // dialog's own (the Assistant is mounted first), so at this moment the store still reports the
      // overlay as open — and Escape must dismiss the dialog rather than cancel the run behind it.
      if (useUi.getState().overlay !== null) return;
      const hit = shortcutFor(e);
      if (!hit) return;
      const actions = keyActions.current;
      if (hit.id === "new-chat") {
        e.preventDefault();
        actions.newChat();
      } else if (hit.id === "stop" && actions.busy) {
        // Only while a turn is running: otherwise Escape keeps whatever meaning it had (the inline
        // message editor's cancel, for one) instead of being swallowed by the Assistant.
        e.preventDefault();
        actions.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Sticky follow. Auto-scrolling on every token made reading scrollback mid-stream impossible —
  // the view snapped back down before you could read a line. Now we follow only while the user is
  // already at the bottom; scrolling up detaches, and a "jump to latest" pill re-attaches. The
  // `atBottomRef` mirror lets the async streaming loop read the latest value without a stale
  // closure (the loop was started by a render that predates the scroll).
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const STICK_THRESHOLD_PX = 48;
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const stickToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  // Follow new content (streamed text, tool events, appended turns) while anchored at the bottom.
  useEffect(() => {
    stickToBottom();
  }, [msgs, streamedText, agentItems, stickToBottom]);

  // P7: context window for the chosen model. Same rule as the request path
  // (`model-router.ts`): the narrowest window published by *any* carrier of this model, because
  // failover may serve the request from any of them. Two rules for one model is how the meter and
  // the router end up disagreeing about the same conversation.
  //
  // `null` when no carrier published a window. The catalog is the only source that knows, and the
  // conservative default the router falls back to is a safety choice for the *request*, not a fact
  // about the model — showing it here would state a capacity nothing ever claimed. Measured: 58 of
  // 82 catalog rows carry no window, and every one of them read as "8,192" in this meter while the
  // router was separately planning against 200k for the same model.
  const modelWindow = useMemo(() => {
    if (!chosen) return null;
    const nativeId = chosen.includes("/") ? chosen.split("/").slice(1).join("/") : chosen;
    const windows = catalog
      .all()
      .filter((m) => m.nativeId === nativeId && m.modality === "text")
      .map((m) => m.contextWindow)
      .filter((w): w is number => typeof w === "number" && w > 0);
    return windows.length > 0 ? Math.min(...windows) : null;
  }, [chosen, tick]);
  // P7: estimated prompt tokens for the NEXT send — the system turn the mode implies, the replayed
  // history, the per-turn instruction, and the draft in the composer. The system turn is included
  // because it is not small: the agent prompt plus the installed skills' bodies run to hundreds of
  // tokens, and leaving them out would understate the one number the meter exists to report. What is
  // still outside the estimate, and why: the recalled memory block (computed at send time), the tool
  // definitions in agent mode, and the contents of `@`-referenced files (read at send time, so only
  // the reference itself is in the draft this counts).
  const currentPromptTokens = useMemo(() => {
    if (!draftText.trim() && msgs.length === 0) return 0;
    const base = agentMode
      ? agentSystem(root, agentSystemPrompt) + skillsBlock
      : noTools
        ? (noToolsSystem || NO_TOOLS_SYSTEM)
        : (systemPrompt ?? "");
    // Counted because it is a system message of its own on both send paths; a meter that ignored a
    // constraint the user just set would be wrong at exactly the moment they are watching it.
    const perTurn = instructionSystemText(turnInstruction);
    const systemText = perTurn ? `${base}\n\n${perTurn}` : base;
    const all: ChatMessage[] = [
      ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
      ...replayHistory(msgs),
      ...(draftText.trim() ? [{ role: "user" as const, content: draftText }] : []),
    ];
    return estimateTokens(all);
  }, [msgs, draftText, turnInstruction, tick, agentMode, noTools, root, agentSystemPrompt, skillsBlock, noToolsSystem, systemPrompt]);
  // P7: context meter — fraction of the window consumed, or `null` when no carrier published a
  // window. A bar scaled to a number the catalog never claimed would be the same invention in a
  // different shape.
  const contextUsedRatio =
    modelWindow === null ? null : Math.min(1, currentPromptTokens / modelWindow);

  /**
   * The composer's "Previous results" row: earlier answers in this conversation, newest first.
   *
   * Assistant turns only, and only ones that carry text — a turn that failed or is still streaming
   * offers nothing to reuse, and listing it would make the row a list of placeholders. Numbered by
   * order of appearance, because two answers to similar questions read alike and the number is what
   * lets the user tell them apart in a menu of truncations.
   */
  const previousOutputs = useMemo(() => {
    const out: { id: string; label: string; text: string }[] = [];
    let n = 0;
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      const text = m.content.trim();
      if (!text) continue;
      n += 1;
      const flat = text.replace(/\s+/g, " ");
      out.push({
        id: m.id,
        label: `Answer ${n} · ${flat.length > 70 ? `${flat.slice(0, 70)}…` : flat}`,
        text: m.content,
      });
    }
    return out.reverse();
  }, [msgs]);
  // Join each tool result to the call that declared it, so the transcript can render an
  // `edit_file`/`write_file` as the change itself. The arguments live on the assistant turn, not
  // the tool turn, so this pairing is the only way the completed transcript can show a diff.
  const callById = useMemo(() => indexToolCalls(msgs), [msgs]);

  // Group a turn's tool traffic. An assistant turn that requested calls and the tool turns that
  // answered them are one step of the run: they render as one card, and the answered tool turns are
  // consumed so they cannot *also* appear as anonymous "tool result" bubbles of their own.
  const toolRuns = useMemo(() => groupToolRuns(msgs), [msgs]);

  // Per-call approval gate: consult the policy, and suspend the loop for a modal only when the
  // policy says the user has to decide.
  //
  // The state read here is a ref reassigned every render, for the same reason `keyActions` is: the
  // gate is handed to `runAgentLoop` once, at the start of a run, so a gate that closed over
  // `approvalMode` would keep asking about reads after the user switched to auto-approve
  // mid-run. Reading the latest value is also what makes a modal's "always allow this tool" take
  // effect on the *next* call of the same run, which is the only reason that button exists.
  const approvalRef = useRef<ApprovalState>({ ...INITIAL_APPROVAL, mode: approvalMode });
  approvalRef.current = { mode: approvalMode, planMode, trustedTools: granted.trustedTools, allowAll: granted.allowAll };

  const handleAgentEvent = useCallback((ev: AgentEvent) => {
    if (ev.type === "assistant") {
      setStreamedText((t) => t + ev.text);
    } else if (ev.type === "truncation_retry") {
      // The abandoned attempt's partial prose is dropped, not concatenated: the retry's text is
      // the answer being built, and two attempts joined would read as one sentence the model
      // never said. The notice stays as the bubble's prefix until the retry's own text appends
      // after it; a truncated `done` records the outcome in the run's steps.
      setStreamedText("⏳ the model's stream ended early — re-asking…\n\n");
    } else if (ev.type === "no_output_retry") {
      // The model reasoned through its whole output budget and never answered. Thinking off is
      // the one lever that works even against a provider that ignores budget tokens, so the
      // fallback forces it and the bubble says why.
      setStreamedText("⏳ the model answered with thinking only — re-asking with thinking off…\n\n");
    } else if (ev.type === "reasoning") {
      // Accumulated, not replaced: an agent turn is several round-trips and the panel shows the
      // whole run's deliberation, the same way `streamedText` shows the whole run's prose.
      setStreamedReasoning((t) => t + ev.text);
    } else if (ev.type === "tool_call") {
      setAgentItems((l) => [...l, { name: ev.call.name ?? "?", args: tryParseArgs(ev.call.arguments), status: "calling" }]);
      // The progress capsule's data source: `todo_write` carries the whole list in its arguments,
      // so the panel can update the moment the call arrives rather than after the result lands.
      if ((ev.call.name ?? "") === "todo_write") {
        const parsed = tryParseArgs(ev.call.arguments);
        const list = parsed?.todos;
        if (Array.isArray(list)) {
          setTodos(
            list
              .filter((t): t is { content: string; status: TodoItem["status"] } =>
                typeof t?.content === "string" &&
                (t?.status === "pending" || t?.status === "in_progress" || t?.status === "completed"))
              .map((t) => ({ content: t.content, status: t.status })),
          );
        }
      }
    } else if (ev.type === "tool_result") {
      setAgentItems((l) => {
        const copy = [...l];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].status === "calling") {
            copy[i] = { ...copy[i], status: /denied|refused/i.test(ev.result) ? "denied" : ev.ok ? "ok" : "error", result: ev.result };
            break;
          }
        }
        return copy;
      });
    }
  }, []);

  /**
   * The one turn runner. A fresh send, a retry and an edit-&-resend all funnel through here, so
   * they cannot drift in how they build history, record the context graph or surface the trace.
   * `baseMsgs` is the transcript BEFORE this turn — the whole thing for a send, the truncated
   * prefix for a retry or an edit. The user turn and the assistant placeholder are appended here;
   * callers must not append them themselves.
   */
  async function runTurn(
    text: string,
    baseMsgs: Msg[],
    attachments: Attachment[] = [],
    inlined: InlinedText[] = [],
    instruction = "",
  ) {
    const trimmed = text.trim();
    // Shaped once, used by both paths. An empty instruction yields an empty string, so a turn with
    // no constraint carries no extra system message on either branch.
    const perTurn = instructionSystemText(instruction);
    // An image-only turn is a real turn: the composer allows sending one, so the guard must too.
    if ((!trimmed && attachments.length === 0) || busy || !chosen) return;
    const userMsg: Msg = {
      id: newMsgId(),
      role: "user",
      content: trimmed,
      ...(attachments.length ? { attachments } : {}),
      ...(inlined.length ? { inlined } : {}),
    };
    const assistantMsg: Msg = { id: newMsgId(), role: "assistant", content: "" };
    setMsgs([...baseMsgs, userMsg, assistantMsg]);
    // A send, retry or edit is a deliberate action: re-anchor to the bottom even if the user had
    // scrolled up, so the reply they just asked for is what they see arrive.
    atBottomRef.current = true;
    setAtBottom(true);
    setBusy(true);
    setTrace(null);
    setFinishReason(undefined);
    const turn = beginTurn(
      {
        approvalState: () => approvalRef.current,
        escalate: (next) => {
          approvalRef.current = next;
          setGranted({ trustedTools: next.trustedTools, allowAll: next.allowAll });
        },
      },
      { onConfirmRequest: setPendingConfirm, onConfirmCleared: () => setPendingConfirm(null) },
    );
    const ac = turn.controller;
    const t0 = Date.now();

    // ---- Agent mode: run the loop, execute tools through the sandbox, confirm each call. ----
    if (agentMode) {
      if (!root.trim()) {
        // Undo the optimistic append: the turn never ran, so it must not sit in the transcript.
        setMsgs(baseMsgs);
        setTrace({ ms: 0, fallbacks: [], error: "set a workspace root before using agent mode" });
        setBusy(false);
        setStopping(false);
        turn.finish();
        return;
      }
      // The turn engine (lib/chat/turn/agent-turn) runs the whole branch against injected ports:
      // run record, checkpoint host, confirm gate, graph recording, memory, trace, change set.
      await runAgentTurn(
        {
          text: trimmed,
          baseMsgs,
          attachments,
          model: chosen,
          perTurn,
          useMemory,
          signal: ac.signal,
          startedAt: t0,
          assistantMsgId: assistantMsg.id,
          root,
          customAgentPrompt: agentSystemPrompt,
          skillsBlock,
          planMode,
          temperature: typeof temperature === "number" ? temperature : undefined,
          maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
          thinking,
          maxIterations: clampIterations(maxIterations),
          controller: ac,
          confirm: (call, args) => turn.confirm(call, args),
        },
        {
          generate: gatewayGenerate,
          recorder: ctxRef.current!,
          lastNode: lastNodeRef,
          memory: { recall: recallContext, block: memoryBlock, recordRecall, remember: rememberTurn, distil: distilTurn },
          providerName: (id) => registry.getProvider(id)?.name,
          patchMsg: (id, patch) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x))),
          onTrace: setTrace,
          onFinishReason: setFinishReason,
          onLastUsage: setLastUsage,
          onBusy: setBusy,
          onStopping: setStopping,
          clearAbort: () => turn.finish(),
          chargeUsage: addSessionUsage,
          now: Date.now,
          orchestrator: { newRunId, startRun, registerAbort, recordStep, endRun },
          makeBaseHost: (r) => createTauriToolHost(r),
          onAgentEvent: handleAgentEvent,
          onAgentStart: () => {
            setStreamedText("");
            setStreamedReasoning("");
            setAgentItems([]);
            setRunUsage({ tokensIn: 0, tokensOut: 0 });
          },
          onRunUsageAdded: (tin, tout) =>
            setRunUsage((r) => ({ tokensIn: r.tokensIn + tin, tokensOut: r.tokensOut + tout })),
          onReplaceTranscript: setMsgs,
          fillIfEmpty: (id, note) =>
            setMsgs((m) => m.map((x) => (x.id === id && !x.content.trim() ? { ...x, content: note } : x))),
          onRunChanges: setRunChanges,
          clearRunUi: () => {
            setPendingConfirm(null);
            setAgentItems([]);
            setStreamedText("");
            setStreamedReasoning("");
          },
        },
      );
      return;
    }

    // ---- Plain chat (no tools): stream and render as before. ----
    // The turn engine (lib/chat/turn/plain-turn) runs the whole branch against injected ports;
    // this is the sink of set* calls the inline code used to make, one-for-one.
    await runPlainTurn(
      {
        text: trimmed,
        baseMsgs,
        attachments,
        model: chosen,
        perTurn,
        useMemory,
        systemPromptText: noTools ? (noToolsSystem || NO_TOOLS_SYSTEM) : systemPrompt,
        // The run-config inputs are `number | ""` (blank = provider default); the engine's
        // request type wants `undefined` for absent, so the guard moves to the call site.
        temperature: typeof temperature === "number" ? temperature : undefined,
        maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
        thinking,
        signal: ac.signal,
        startedAt: t0,
        assistantMsgId: assistantMsg.id,
      },
      {
        generate: gatewayGenerate,
        recorder: ctxRef.current!,
        lastNode: lastNodeRef,
        memory: { recall: recallContext, block: memoryBlock, recordRecall, remember: rememberTurn, distil: distilTurn },
        providerName: (id) => registry.getProvider(id)?.name,
        patchMsg: (id, patch) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x))),
        onTrace: setTrace,
        onFinishReason: setFinishReason,
        onLastUsage: setLastUsage,
        onBusy: setBusy,
        onStopping: setStopping,
        clearAbort: () => turn.finish(),
        chargeUsage: addSessionUsage,
        now: Date.now,
      },
    );
    return;
  }

  /**
   * A fresh send from the composer, which has already resolved the draft: mentions expanded,
   * attachments read. Nothing to clear here — the composer owns the text it just handed over, and
   * clearing it here too is how the two would drift.
   */
  function send(text: string, attachments: Attachment[], inlined: InlinedText[], instruction = "") {
    if (busy || !chosen) return;
    void runTurn(text, msgs, attachments, inlined, instruction);
  }

  /**
   * P5: approve the plan and run it for real.
   *
   * The approval ref is updated **before** `send`, and that order is the whole trick: `send` starts
   * the run synchronously, and the gate for that run reads the ref. Turning plan mode off with
   * `setPlanMode(false)` alone would not have taken effect until the next render — after the run
   * had already begun — so the executing pass would refuse its own first write and the user would
   * watch the agent fail to do the thing they just approved.
   */
  function approvePlan() {
    approvalRef.current = { ...approvalRef.current, planMode: false };
    onPlanModeChange(false);
    void runTurn(PLAN_APPROVED_TURN, msgs);
  }

  /**
   * P5: put back the files this run touched.
   *
   * Writes go through the **plain** host, not the checkpointing one: reverting is not part of the
   * run being reverted, and re-checkpointing it would let a second revert "revert the revert" back
   * to the state the user just rejected.
   *
   * Every outcome is reported. A revert that silently skipped a file — because the sandbox refused
   * the path, or because the old contents were never readable — would leave the user believing the
   * workspace was restored when it was not.
   */
  async function revertRun() {
    if (!runChanges) return;
    const plan = revertPlan(runChanges);
    const host = createTauriToolHost(root.trim());
    const failed: string[] = [];
    for (const op of plan.ops) {
      try {
        const r = await host.run("write_file", { path: op.path, content: op.content });
        if (!r.ok) failed.push(op.path);
      } catch {
        failed.push(op.path);
      }
    }
    const restored = plan.ops.length - failed.length;
    // Honest in both directions: what was restored, what could not be, and what was never tracked.
    const parts = [`reverted ${restored} of ${plan.ops.length} file${plan.ops.length === 1 ? "" : "s"}`];
    if (failed.length) parts.push(`could not restore ${failed.join(", ")}`);
    for (const s of plan.skipped) parts.push(`${s.path}: ${s.reason}`);
    if (runChanges.untracked.length) parts.push("commands it ran are not undone");
    setRunChanges(null);
    setNotice(`revert this run — ${parts.join("; ")}`);
  }

  function copyMessage(m: Msg) {
    void navigator.clipboard.writeText(m.content);
    setCopiedId(m.id);
    window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 2000);
  }

  function startEdit(m: Msg) {
    setEditingId(m.id);
    setEditDraft(m.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
  }

  /**
   * Truncate at turn `i` and re-run its prompt. The discarded tail is the point: a retry replaces
   * a bad reply rather than appending a second one. The index walk lives in `lib/chat/actions` so
   * it is unit-tested rather than embedded here.
   */
  function retryTurn(i: number) {
    const point = retryPoint(msgs, i);
    if (!point) return;
    // The prompt's images ride along: dropping them made the retry a question without its
    // attachments, and the model answered a turn it could no longer see.
    void runTurn(point.text, point.prefix, point.attachments ?? []);
  }

  /** Commit the inline editor: drop this user turn and everything after it, then resend edited. */
  function submitEdit(i: number) {
    const text = editDraft.trim();
    if (!text) return;
    const prefix = editPoint(msgs, i);
    // The editor changes text only, so the dropped turn's attachments are re-sent with the edited
    // prompt — the same carry `retryTurn` does, for the same reason.
    const attachments = msgs[i]?.attachments ?? [];
    cancelEdit();
    void runTurn(text, prefix, attachments);
  }

  /**
   * Drop this turn and everything after it. Only the visible transcript is truncated — the context
   * graph is an append-only record of what happened, so the abandoned turns stay in History.
   */
  function deleteFrom(i: number) {
    setMsgs((m) => m.slice(0, i));
  }

  /**
   * Continue this conversation from `i` in a NEW session. The prefix is kept so the follow-up has
   * its context, and the graph restarts so the two threads do not interleave nodes under one id.
   */
  function forkFrom(i: number) {
    const prefix = msgs.slice(0, i + 1).map((m) => ({ ...m }));
    ctxRef.current = startSession();
    lastNodeRef.current = null;
    setMsgs(prefix);
    setTrace(null);
    setFinishReason(undefined);
  }

  // ---- Phase 4: session bar -------------------------------------------------------------

  const refreshSessions = useCallback(() => {
    void loadHistorySessions(50).then(setSessions).catch(() => undefined);
  }, []);

  // Keep the list fresh, and adopt the current session's stored title whenever it changes.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions, sessionId, tick]);

  // Adopt the current session's stored title — but only ONCE per session. Re-adopting on every
  // `sessions` change clobbered a title the user had just typed (the list is refreshed
  // asynchronously, so it is briefly stale), which is why the guard is a "loaded for" ref rather
  // than a plain dependency.
  const titleLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (renaming) return;
    if (titleLoadedFor.current === sessionId) return;
    const mine = sessions.find((s) => s.session_id === sessionId);
    // An empty list means "not loaded yet", not "untitled" — wait for the list to arrive.
    if (!mine && sessions.length === 0) return;
    titleLoadedFor.current = sessionId;
    setSessionTitle(mine?.title ?? "");
  }, [sessions, sessionId, renaming]);

  // A remount used to keep recording into the open session while showing an empty transcript —
  // the chip said "that conversation", the pane said nothing. Switching screens unmounts this
  // component (App.tsx renders one screen at a time), so on the way back in, the open session's
  // stored turns are re-read exactly the way a resume rebuilds them. Once per mount, and only
  // when the stored session actually has turns — a brand-new session restores nothing.
  const restoredOnMount = useRef(false);
  useEffect(() => {
    if (restoredOnMount.current) return;
    restoredOnMount.current = true;
    // A "Continue in Assistant" handed over from History wins: adopt that session (recorder,
    // session id, stored turns) instead of restoring the singleton's own.
    const intent = useUi.getState().resumeSessionId;
    useUi.getState().setResumeSessionId(undefined);
    if (intent) {
      void (async () => {
        try {
          const [resumed, seq] = await Promise.all([resumeSession(intent), historyMaxSeq(intent)]);
          const rec = startSession(intent, seq);
          ctxRef.current = rec;
          lastNodeRef.current = null;
          setSessionId(rec.sessionId);
          setMsgs(withIds(resumed as Omit<Msg, "id">[]));
        } catch {
          return; // same policy as openSession: an unreadable session is not an error wall
        }
      })();
      return;
    }
    const sid = ctxRef.current!.sessionId;
    void resumeSession(sid)
      .then((resumed) => {
        if (resumed.length > 0) setMsgs(withIds(resumed as Omit<Msg, "id">[]));
      })
      .catch(() => undefined);
    // Mount only: afterwards the transcript is owned by the turn runner and the session actions.
  }, []);

  /**
   * Start a fresh conversation. The recorder is replaced, not merely cleared, so the new turns are
   * recorded under a new session id — otherwise the abandoned thread would keep growing.
   */
  function newChat() {
    if (busy) return; // an in-flight turn is not something to discard on a stray click
    const rec = startSession();
    ctxRef.current = rec;
    lastNodeRef.current = null;
    setSessionId(rec.sessionId);
    setMsgs([]);
    setTrace(null);
    setFinishReason(undefined);
    setAgentItems([]);
    setTodos([]);
    setStreamedText("");
    setStreamedReasoning("");
    setEditingId(null);
    setEditDraft("");
    setSessionTitle("");
    setSwitcherOpen(false);
    useUi.getState().setResumeSessionId(undefined);
  }

  /**
   * Resume a past session — by continuing it in place, not forking.
   *
   * The recorder previously started under a NEW session id, because reusing the old id would
   * restart the node sequence from 1 and upsert over that session's existing nodes. The collision
   * was real, but forking was the wrong cure: every visit to an old session manufactured a
   * same-named duplicate, and History filled up with empty shells. The recorder now seeds its
   * sequence past what the session already has stored (`history_max_seq`), so the session id —
   * and the user's mental model of "I am back in that conversation" — survives intact. An explicit
   * fork ("⑂ fork" on a message) remains available where a split is actually wanted.
   */
  async function openSession(sid: string) {
    if (busy) return;
    setSwitcherOpen(false);
    if (sid === sessionId) return;
    let resumed: Awaited<ReturnType<typeof resumeSession>>;
    let seq = 0;
    try {
      resumed = await resumeSession(sid);
      seq = await historyMaxSeq(sid);
    } catch {
      return; // an unreadable session is not worth an error wall; leave the transcript as it was
    }
    const rec = startSession(sid, seq);
    ctxRef.current = rec;
    lastNodeRef.current = null;
    setSessionId(sid);
    setMsgs(withIds(resumed as Omit<Msg, "id">[]));
    setTrace(null);
    setFinishReason(undefined);
    setEditingId(null);
    // The session keeps its own name — it IS that session, not a copy. `titleLoadedFor` is
    // stamped so the async list refresh cannot adopt a stale value over it.
    titleLoadedFor.current = sid;
    setSessionTitle(sessions.find((s) => s.session_id === sid)?.title ?? "");
  }

  function commitTitle() {
    const t = titleDraft.trim();
    setRenaming(false);
    // The panel only existed to reach the rename field; the name is settled, so close it and let
    // the chip carry the new title alone.
    setSwitcherOpen(false);
    // Mark this session as adopted BEFORE the list refreshes, so the loading effect cannot adopt
    // the still-stale (pre-rename) value and undo what the user just typed.
    titleLoadedFor.current = sessionId;
    setSessionTitle(t);
    // Fire and forget: a failed rename must not block the screen, and the History screen will show
    // the stored value on its next read either way.
    void saveSessionTitle(sessionId, t).then(refreshSessions).catch(() => undefined);
  }

  const ok = trace && !trace.error && trace.fallbacks.length === 0;
  /**
   * Whether the chosen model accepts images, read from the catalog.
   *
   * Three states reach the UI and all three matter: `true` enables attachment, `false` refuses it,
   * and `undefined` (a catalog that never mentioned modalities) refuses it *and says so differently*
   * — the user of a provider that simply does not publish capabilities should read "unknown", not
   * "cannot", or they will conclude their model is worse than it is.
   */
  const chosenVision = useMemo(() => {
    if (!chosen) return undefined;
    const nativeId = chosen.includes("/") ? chosen.split("/")[1]! : chosen;
    const row = catalog.all().find((m: CatalogModel) => m.nativeId === nativeId && m.modality === "text");
    return row?.supportsVision;
  }, [chosen, tick]);

  /**
   * The workspace tools, for `@`-mentions. `null` when there is no usable root, which is what the
   * composer turns into "set a workspace root to reference files with @" rather than an empty menu.
   */
  const mentionHost = useMemo(
    () => (root.trim() && !rootError ? createTauriToolHost(root.trim()) : null),
    [root, rootError],
  );

  const listWorkspaceFiles = useCallback(async (): Promise<MentionCandidate[]> => {
    if (!mentionHost) return [];
    // `list_dir` recursive, matched on PATH: an `@` reference names a file, and a content search
    // would offer files whose *contents* mention the typed word — a different question. The listing
    // is a formatted string (`file <path>`), so it is parsed by `parseListing` rather than split on
    // whitespace, which a path containing a space would break.
    const res = await mentionHost.run("list_dir", { path: ".", recursive: true });
    if (!res.ok) return [];
    return parseListing(res.output).slice(0, 2000);
  }, [mentionHost]);

  const readWorkspaceFile = useCallback(
    async (path: string): Promise<string | null> => {
      if (!mentionHost) return null;
      const res = await mentionHost.run("read_file", { path });
      return res.ok ? res.output : null;
    },
    [mentionHost],
  );

  /**
   * `/compact`: summarise the older turns now instead of waiting for the router to do it when the
   * next request no longer fits.
   *
   * It reuses the same compressor the router applies on the way out (`compressWithSummary`), so the
   * result is the shape the model would have seen anyway — a labelled summary plus the recent turns.
   * The difference is that the user asked for it, and can watch the transcript shrink.
   */
  const compactNow = useCallback(async () => {
    if (busy || msgs.length === 0) return;
    setNotice(null);
    // Compaction sizes itself off the conservative default when no window is published. That is the
    // *request* path, where under-sending is the safe direction — unlike the meter, which must not
    // present the same default as the model's capacity.
    const budget = Math.max(256, Math.floor((modelWindow ?? DEFAULT_CONTEXT_WINDOW) * 0.75));
    try {
      const result = await compressWithSummary(replayHistory(msgs), budget, createSummarizer(chosen));
      if (!result.compressed) {
        setNotice("Nothing to compact — the conversation already fits in the context window.");
        return;
      }
      const kept: Msg[] = result.messages.map((m) => ({
        id: newMsgId(),
        role: m.role as Msg["role"],
        content: textOfContent(m.content),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      }));
      setMsgs(kept);
      setNotice(`Compacted ${result.dropped} earlier message${result.dropped === 1 ? "" : "s"} into a summary.`);
    } catch (e) {
      setNotice(`Could not compact: ${(e as Error).message}`);
    }
  }, [busy, msgs, modelWindow, chosen]);

  // The session controls, extracted from the old in-Chat session bar so they can portal into the
  // title row. Their state stays here on purpose: a session is its transcript — New/reset,
  // resume, and the per-session title are all operations on `msgs` and `sessionId`, which only
  // this component owns.
  //
  // One control, one concept: the chip names the conversation you are in, and opening it is the
  // single place where renaming, starting fresh, and resuming an old one happen — three actions
  // about the same thing (which conversation is this?) should not be three separate affordances
  // in the chrome.
  const sessionControls = (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        className="nav-item flex w-full min-w-0 items-center gap-1 truncate rounded-md px-1 py-0.5 text-left text-[15px] font-semibold tracking-tight"
        style={{ color: sessionTitle ? "var(--text)" : "var(--text-faint)" }}
        aria-haspopup="menu"
        aria-expanded={switcherOpen}
        onClick={() => {
          refreshSessions();
          setSwitcherOpen((v) => !v);
        }}
        title="Open this session’s name, a new session, or a previous one"
      >
        <span className="min-w-0 flex-1 truncate">{sessionTitle || "untitled session"}</span>
        {/* aria-hidden: the chevron is decoration — the chip is identified by the session name
            itself, which is what the specs and screen readers key on. */}
        <span className="shrink-0 text-[11px] font-normal" style={{ color: "var(--text-faint)" }} aria-hidden="true">
          ▾
        </span>
      </button>
      {switcherOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setSwitcherOpen(false)} />
          <div
            className="absolute left-0 top-9 z-50 max-h-80 w-72 overflow-y-auto rounded border p-1 shadow-lg"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
            role="menu"
            aria-label="Session actions"
          >
            {renaming ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") setRenaming(false);
                }}
                placeholder="name this session…"
                aria-label="Session title"
                className="mb-1 w-full rounded border px-2 py-1 text-[12px]"
                style={inputStyle}
              />
            ) : (
              <button
                type="button"
                aria-label="Rename session"
                className="mb-1 block w-full truncate rounded px-2 py-1.5 text-left text-[13px] font-medium transition-opacity hover:opacity-80"
                style={{ color: "var(--text-dim)" }}
                onClick={() => {
                  setTitleDraft(sessionTitle);
                  setRenaming(true);
                }}
                title="Name this session"
              >
                {sessionTitle || "name this session…"}
                {/* aria-hidden: the glyph is decoration — this row is reached as "Rename session",
                    and a named "✎" would make its accessible name ambiguous. */}
                <span className="ml-1 text-[11px] font-normal" style={{ color: "var(--text-faint)" }} aria-hidden="true">
                  ✎
                </span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              className="block w-full rounded px-2 py-1.5 text-left text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ color: "var(--accent)" }}
              onClick={newChat}
              title="Start a new chat"
            >
              ＋ New session
            </button>
            <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
            {sessions.length === 0 ? (
              <p className="px-2 py-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
                No sessions recorded yet — this one appears once a turn is sent.
              </p>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.session_id}
                  role="menuitem"
                  className="block w-full rounded px-2 py-1.5 text-left text-[12px] transition-opacity hover:opacity-80"
                  style={{ color: s.session_id === sessionId ? "var(--accent)" : "var(--text-dim)" }}
                  onClick={() => void openSession(s.session_id)}
                  title={s.title || s.preview}
                >
                  <span className="block truncate">{s.title || s.preview || "(no text)"}</span>
                  <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                    {new Date(s.started_ts).toLocaleString()} · {s.turns} turns
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Session features (Phase 4): which conversation this is, what it is called, and how to
          start or switch one — portaled into the title row's slot, where the user asked them to
          live. The portal keeps both truths intact: the DOM sits up in the chrome, the state (the
          transcript a New or resume acts on) stays here in `Chat`. */}
      {sessionSlot && createPortal(sessionControls, sessionSlot)}

      {/* The model row and the workspace-root field moved up into the Run configuration card
          (AssistantScreen): the picker, the provider chip and the sandbox facts are one column
          there, and this transcript starts directly under the session bar. */}
      <div className="relative min-h-0 flex-1">
        <AssistantCapsule root={root} todos={todos} busy={busy} />
        <div
          ref={listRef}
          onScroll={onListScroll}
          // Borderless, like the mock: the conversation floats on the background instead of sitting
          // in a boxed panel, so the chat area owns its full height and the hero centers in it.
          className="h-full overflow-y-auto px-1"
        >
        {msgs.length === 0 && !busy && (
          // The empty state (mock: "What would you like to build?"). One staggered entrance via
          // `.aip-rise`, then static — a transcript that replays its own animation on every store
          // bump would read as broken. The wrapper centers with `m-auto` rather than
          // `justify-center`: center-justified content taller than the scroll panel clips its TOP
          // out of scroll reach, which is exactly where the headline lives. `m-auto` keeps the
          // centering when it fits and degrades to top-aligned scroll when it does not. The hint
          // line states what actually happens on this screen: the answer streams, and the trace
          // line under it names the routed provider and any fallbacks — which is why "rotation and
          // failover are silent" from the old copy survives as "routed provider … appear below each
          // answer" rather than being dropped.
          <div className="flex min-h-full flex-col">
            {/* Compact vertical rhythm: the whole hero has to fit inside the chat area on a
                ~1000px-tall window, or the cards clip against the composer. The `m-auto` wrapper
                still centers it when it fits and degrades to scroll when it cannot. */}
            <div className="m-auto flex w-full max-w-3xl flex-col items-center px-4 py-5 text-center">
            <div
              className="aip-rise hero-glow mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border"
              style={{ borderColor: "var(--border)" }}
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
              >
                <path d="M4 5.5h13v9H9l-5 4v-13Z" />
                <path d="m17.5 14.5 1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1 1-2.4Z" fill="var(--accent)" stroke="none" />
              </svg>
            </div>
            <h2 className="aip-rise aip-rise-1 text-[22px] font-semibold tracking-tight">
              What would you like to build?
            </h2>
            <p className="aip-rise aip-rise-1 mt-1 text-[13px]" style={{ color: "var(--text-dim)" }}>
              Ask a question, run a task, or work with files in your project.
            </p>
            <div className="aip-rise aip-rise-2 mt-5 grid w-full max-w-3xl gap-3 sm:grid-cols-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => setSeed({ text: s.prompt, nonce: Date.now() })}
                  className="nav-item rounded-xl border p-3.5 text-left transition-transform enabled:active:scale-[0.99]"
                  style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
                >
                  <span className="mb-2.5 flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                    <SuggestionIcon name={s.icon} />
                  </span>
                  <span className="block text-[13px] font-semibold">{s.title}</span>
                  <span className="mt-1 block text-[12px] leading-snug" style={{ color: "var(--text-dim)" }}>
                    {s.blurb}
                  </span>
                </button>
              ))}
            </div>
            <p className="aip-rise aip-rise-3 mt-4 flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-faint)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 11v5m0-8.5h.01" />
              </svg>
              Responses stream live; routed provider and tool activity appear below each answer.
            </p>
            </div>
          </div>
        )}
        {msgs.map((m, i) =>
          // A tool turn already shown inside its turn's group card: rendering it again here is what
          // produced the flat run of anonymous "tool result" bubbles.
          toolRuns.consumed.has(i) ? null : (
          <div key={m.id} className="group mb-3">
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: m.role === "user" ? "var(--info)" : m.role === "tool" ? "var(--warn)" : "var(--success)" }}>
              {m.role}
            </div>
            {editingId === m.id ? (
              <div>
                <textarea
                  autoFocus
                  value={editDraft}
                  rows={Math.min(14, Math.max(2, editDraft.split("\n").length))}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitEdit(i);
                    }
                    if (e.key === "Escape") cancelEdit();
                  }}
                  className={`${inputCls} resize-none`}
                  style={inputStyle}
                />
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Button variant="primary" onClick={() => submitEdit(i)}>Save &amp; resend</Button>
                  <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
                  <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                    everything after this message is discarded
                  </span>
                </div>
              </div>
            ) : m.role === "tool" ? (
              <ToolResultBubble content={m.content} call={m.tool_call_id ? callById.get(m.tool_call_id) : undefined} />
            ) : m.role === "assistant" ? (
              agentMode && i === msgs.length - 1 && busy ? (
                <AgentLive
                  raw={streamedText}
                  reasoning={streamedReasoning}
                  items={agentItems}
                  waiting={pendingConfirm?.call.name ?? null}
                  stopping={stopping}
                  usage={runUsage}
                />
              ) : (
                // A turn that only requested tools has no prose of its own. Rendering the
                // empty-content placeholder there is what left a bare "…" under a tool call —
                // indistinguishable from a model that answered with nothing.
                <>
                  {/* The reasoning leads the answer, folded away — the order the model produced it
                      in. A turn that reasoned and then answered shows both; a turn that reasoned
                      and ran out of output budget shows the reasoning instead of the empty bubble
                      it used to show, which is the difference between "nothing happened" and
                      "here is what it was doing". */}
                  {m.reasoning ? (
                    <ReasoningPanel text={m.reasoning} streaming={busy && i === msgs.length - 1} />
                  ) : null}
                  {m.content.trim() ? <AssistantContent raw={m.content} /> : null}
                </>
              )
            ) : (
              <>
                {/* P3: what this turn was sent with, above the text — the images are part of the
                    question, and a transcript that showed only the words would misrepresent what the
                    model was asked. */}
                {(m.attachments?.length ?? 0) > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1.5">
                    {m.attachments!.map((a) => (
                      <img
                        key={a.id}
                        alt={a.name}
                        src={`data:${a.mediaType};base64,${a.dataBase64}`}
                        title={`${a.name} · ${Math.max(1, Math.round(a.bytes / 1024))} KB`}
                        className="max-h-32 rounded border"
                        style={{ borderColor: "var(--border)" }}
                        data-testid="sent-image"
                      />
                    ))}
                  </div>
                )}
                <Markdown source={m.content} />
                {(m.inlined?.length ?? 0) > 0 && (
                  <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }}>
                    inlined {m.inlined!.map((f) => f.path).join(", ")}
                  </p>
                )}
              </>
            )}
            {toolRuns.byAssistant.has(i) && <ToolRunGroup steps={toolRuns.byAssistant.get(i)!} />}
            {editingId !== m.id && (
              <MessageActions
                disabled={busy}
                copied={copiedId === m.id}
                onCopy={() => copyMessage(m)}
                onRetry={m.role === "assistant" && i > 0 ? () => retryTurn(i) : undefined}
                onEdit={m.role === "user" ? () => startEdit(m) : undefined}
                onFork={i > 0 ? () => forkFrom(i) : undefined}
                onDelete={i > 0 ? () => deleteFrom(i) : undefined}
              />
            )}
          </div>
        ))}
        </div>
        {/* `msgs.length > 0` — an empty transcript's hero is taller than the chat area on short
            windows, which detached the scroll anchor and floated this pill over the suggestion
            cards. There is nothing to jump to until the first message exists. */}
        {!atBottom && msgs.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1 text-[11px] shadow-lg transition-opacity hover:opacity-90"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text-dim)" }}
            title="Scroll to the newest message"
          >
            ↓ jump to latest
          </button>
        )}
      </div>
      {/* P5: plan mode's approve step. Shown only once a plan pass has finished — during the run
          there is nothing to approve yet, and the button would start a second run on top of the
          first (which is what `busy` guards against everywhere else on this screen). */}
      {agentMode && planMode && !busy && msgs.length > 0 && (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
          style={{ borderColor: "var(--info)", background: "var(--surface)" }}
          data-testid="plan-approve"
        >
          <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
            Plan mode — the agent could read but not write. Approving runs the plan for real.
          </span>
          <Button variant="primary" onClick={approvePlan}>
            Approve plan &amp; execute
          </Button>
        </div>
      )}

      {/* P5: what this run changed. Shown after it ends, including after a stop or a failure —
          those runs have still written whatever they got to. */}
      {!busy && runChanges && (runChanges.files.length > 0 || runChanges.untracked.length > 0) && (
        <ChangeSetReview
          set={runChanges}
          busy={busy}
          onKeep={() => setRunChanges(null)}
          onRevert={() => void revertRun()}
        />
      )}

      {trace && (
        <div className="mt-2 text-[12px]">
          <button className="flex items-center gap-2" onClick={() => setShowTrace((v) => !v)}>
            <span style={{ color: trace.error ? "var(--danger)" : ok ? "var(--success)" : "var(--warn)" }}>
              {trace.error ? "✕" : ok ? "✓" : "↻"}
            </span>
            <span className="mono">{trace.ms}ms</span>
            {trace.provider && <span style={{ color: "var(--text-dim)" }}>· {trace.provider}</span>}
            {trace.fallbacks.length > 0 && (
              <span style={{ color: "var(--warn)" }}>· {trace.fallbacks.length} fallback{trace.fallbacks.length === 1 ? "" : "s"}</span>
            )}
            {trace.error && <span style={{ color: "var(--danger)" }}>{trace.error}</span>}
            {finishReason === "length" && (
              <span className="mono" style={{ color: "var(--warn)" }}>· truncated</span>
            )}
            {(trace.fallbacks.length > 0 || showTrace) && (
              <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>{showTrace ? "▾" : "▸"}</span>
            )}
          </button>
          {showTrace && trace.fallbacks.length > 0 && (
            <ul className="mono mt-1 ml-4 text-[11px]" style={{ color: "var(--text-dim)" }}>
              {trace.fallbacks.map((f, i) => (
                <li key={i}>attempt {i + 1}: {f.provider} · {f.key} → {f.cls}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* P7: what this turn will actually be sent with. The model picker above says where it goes,
          this says how. Blank means "the provider's own default", which is why the fields are empty
          rather than zeroed: 0 is a real temperature and 1 is a real maxTokens, and neither means
          "unset".
          The values live in `AssistantScreen` rather than in local state here, for the same reason
          `root` does: hydration finishes after this component has already mounted, so a local copy
          seeded from the prop at mount would ignore everything the stored settings said and show a
          blank field where the user's saved value belongs. */}
      {/* The per-request readouts (temp, max tokens, context meter, ledger totals) and the
          model/sandbox chips moved below the composer — the mock's status strip. Above the
          composer only the transcript's own notices remain. */}


      {/* P3: the composer owns the draft, the attachments and the two menus. It is disabled — not
          hidden — when the turn cannot run, so the reason stays visible next to a live box. */}
      {(notice || (agentMode && (!root.trim() || !!rootError))) && (
        <p className="mt-2 text-[11px]" style={{ color: notice ? "var(--warn)" : "var(--danger)" }} data-testid="composer-notice">
          {notice ?? "Set a workspace root before using agent mode."}
        </p>
      )}
      <div className="mt-2">
        <Composer
          textareaRef={inputRef}
          busy={busy}
          agentMode={agentMode}
          vision={chosenVision}
          modelLabel={chosen || "the current model"}
          onSend={send}
          onStop={stopRun}
          onClear={newChat}
          onOpenModelPicker={onOpenModelPicker}
          onSwitchToImageTab={onSwitchToImageTab}
          onCompact={() => void compactNow()}
          listFiles={mentionHost ? listWorkspaceFiles : null}
          readFile={mentionHost ? readWorkspaceFile : null}
          onNotice={setNotice}
          onDraftChange={setDraftText}
          onInstructionChange={setTurnInstruction}
          previousOutputs={previousOutputs}
          seed={seed}
          toolbar={toolbar}
          corner={corner}
          sendDisabled={!chosen || (agentMode && (!root.trim() || !!rootError))}
        />
      </div>

      {/* The status strip (mock): what this run will use and what it has cost, under the composer.
          The chips at left are state; the meters at right are the same context/ledger readouts the
          params row above the composer used to carry — moved, not lost, and every control in it
          keeps the aria-label it had. */}
      <div
        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-[11px]"
        style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        {/* The routed badge moved here from the old card's Model & Provider column: a bare model
            id is the only form failover can act on, and the strip is where per-request facts live. */}
        {!chosen.includes("/") && chosen ? (
          <span
            className="flex items-center gap-1 rounded-md border px-1.5 py-0.5"
            style={{ borderColor: "var(--border)", color: "var(--success)" }}
            title="A bare model id lets the router plan every enabled carrier and fail over between them"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
              <path d="m4.5 12.5 5 5 10-11" />
            </svg>
            Routed (failover enabled)
          </span>
        ) : null}
        <span className="h-4 w-px" style={{ background: "var(--border)" }} aria-hidden="true" />
        <label className="flex items-center gap-1">
          temp
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => {
              const v = e.target.value;
              onTemperatureChange(v === "" ? "" : Math.max(0, Math.min(2, Number(v))));
            }}
            placeholder="default"
            disabled={busy}
            aria-label="Temperature for this request (blank uses the provider default)"
            className="mono no-spin w-16 rounded border px-1 py-0.5 text-[11px]"
            style={inputStyle}
          />
        </label>
        <label className="flex items-center gap-1">
          max tokens
          <input
            type="number"
            min={1}
            step={64}
            value={maxTokens}
            onChange={(e) => {
              const v = e.target.value;
              onMaxTokensChange(v === "" ? "" : Math.max(1, Math.round(Number(v))));
            }}
            placeholder="default"
            disabled={busy}
            aria-label="Maximum response tokens for this request (blank uses the provider default)"
            className="mono no-spin w-20 rounded border px-1 py-0.5 text-[11px]"
            style={inputStyle}
          />
        </label>
        {/* The thinking level. It sits here, beside temperature and max tokens, because it is the
            same kind of thing: a per-request parameter whose blank means "the provider's own
            default". It is also the answer to a failure this app used to file as a parse error —
            a model that thinks by default can spend the whole output budget and never write an
            answer, and `off` is the escape hatch where the provider has one. */}
        <label className="flex items-center gap-1">
          thinking
          <select
            value={thinking}
            onChange={(e) => onThinkingChange(e.target.value as ReasoningEffort | "")}
            disabled={busy}
            aria-label="How much the model should think before answering (default uses the provider's own setting)"
            title="Sent as the field this provider's dialect declares (Anthropic thinking, OpenAI reasoning_effort, Gemini thinkingConfig). Below 'default', 'off' asks the provider to disable thinking where it has a way to — where it has none, nothing is sent and its own default stands."
            data-testid="thinking-select"
            className="mono rounded border px-1 py-0.5 text-[11px]"
            style={inputStyle}
          >
            <option value="">default</option>
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onEditPrompts}
          className="underline decoration-dotted"
          title="Edit the system prompts this screen sends"
        >
          ✎ system prompt
        </button>
        {/* Context meter. Position and colour together, because the colour alone is a claim the
            user cannot check: the numbers say how full the window is and the bar makes it skimmable.
            With no published window there is no share to state, so it says so instead of inventing
            a denominator. */}
        <span
          className="ml-auto flex items-center gap-1.5"
          title={
            `${currentPromptTokens.toLocaleString()} estimated prompt tokens` +
            (modelWindow === null
              ? ` — no context window is published for ${chosen || "the default model"}, so the share used cannot be shown`
              : ` of ${modelWindow.toLocaleString()} window for ${chosen || "the default model"}`) +
            // `?? 0` is not defensive noise: `UsageTokens` declares both counts as required, but the
            // interpreter passes whatever the provider's usage block actually had (`usageOf` returns
            // `undefined` for a missing field), so a provider that omits one reaches here as
            // `prompt_tokens: undefined` and an unguarded `.toLocaleString()` would throw while
            // rendering — turning a missing usage line into a broken screen.
            (lastUsage ? ` · the last request actually reported ${(lastUsage.prompt_tokens ?? 0).toLocaleString()} in` : "")
          }
        >
          <span>context</span>
          <span className="h-1.5 w-24 overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
            <span
              className="block h-full"
              style={{
                // A sliver for any non-zero share, so "nearly empty" is visible at all; a true zero
                // stays zero rather than claiming a percent that is not there — and an unpublished
                // window fills nothing, because there is no percent to draw.
                width:
                  contextUsedRatio === null || currentPromptTokens === 0
                    ? "0%"
                    : `${Math.max(1, Math.round(contextUsedRatio * 100))}%`,
                background:
                  contextUsedRatio === null
                    ? "var(--text-faint)"
                    : contextUsedRatio > 0.9
                      ? "var(--danger)"
                      : contextUsedRatio > 0.7
                        ? "var(--warn)"
                        : "var(--success)",
              }}
            />
          </span>
          <span className="mono">
            {formatTokens(currentPromptTokens)} / {modelWindow === null ? "unknown" : formatTokens(modelWindow)}
          </span>
        </span>
        {/* Session totals from the ledger. "Σ" and the tooltip say *this app's whole ledger*, not
            just this conversation — the in-memory ledger has no session column to scope by. */}
        <span
          className="mono"
          title={
            "Totals for the turns this screen has sent since it opened, as reported on each turn's wire usage — Activity shows every request the gateway routed, including other clients" +
            (sessionCost.unpriced > 0
              ? ` · ${sessionCost.unpriced} of ${sessionCost.rows} used a model with no published price, so the cost is a lower bound`
              : "")
          }
        >
          Σ {formatTokens(sessionTokensIn)} in · {formatTokens(sessionTokensOut)} out · {costLabel}
        </span>
      </div>

      {pendingConfirm && (
        <ApproveModal
          name={pendingConfirm.call.name ?? "?"}
          args={pendingConfirm.args}
          onResolve={(choice) => {
            pendingConfirm.resolve(choice);
            setPendingConfirm(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-message actions, revealed on hover (and on focus, so they are keyboard-reachable).
 *
 * Every action that re-runs or truncates a turn is disabled while a turn is in flight: re-entering
 * the loop mid-stream would interleave two runs and both would write to the same transcript. The
 * caller decides which actions apply to which role by passing or omitting each handler.
 */
function MessageActions({
  disabled,
  copied,
  onCopy,
  onRetry,
  onEdit,
  onFork,
  onDelete,
}: {
  disabled: boolean;
  copied: boolean;
  onCopy: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onFork?: () => void;
  onDelete?: () => void;
}) {
  const btn =
    "rounded px-1.5 py-0.5 text-[10px] transition-opacity opacity-60 hover:opacity-100 disabled:opacity-30 disabled:hover:opacity-30";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <button type="button" className={btn} style={{ color: "var(--text-dim)" }} disabled={disabled} onClick={onCopy} title="Copy this message">
        {copied ? "✓ copied" : "copy"}
      </button>
      {onRetry && (
        <button type="button" className={btn} style={{ color: "var(--accent)" }} disabled={disabled} onClick={onRetry} title="Discard this reply and regenerate it">
          ↻ retry
        </button>
      )}
      {onEdit && (
        <button type="button" className={btn} style={{ color: "var(--text-dim)" }} disabled={disabled} onClick={onEdit} title="Edit this message and resend">
          ✎ edit
        </button>
      )}
      {onFork && (
        <button type="button" className={btn} style={{ color: "var(--text-dim)" }} disabled={disabled} onClick={onFork} title="Continue from here in a new session, keeping this point as context">
          ⑂ fork
        </button>
      )}
      {onDelete && (
        <button type="button" className={btn} style={{ color: "var(--danger)" }} disabled={disabled} onClick={onDelete} title="Delete this message and everything after it">
          🗑 delete from here
        </button>
      )}
    </div>
  );
}

/** A step of a live run: the shared shape, plus the outcome only a run in flight knows. */
type UIStep = ToolStep & { status?: AgentItem["status"] };

/** A call's arguments as one line — `path: src/a.ts · pattern: todo` — with long values clipped. */
function argSummary(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
    if (!s) continue;
    parts.push(`${k}: ${s.replace(/\s+/g, " ").slice(0, 64)}`);
    if (parts.length === 2) break;
  }
  return parts.join(" · ");
}

const STEP_GLYPH: Record<AgentItem["status"], string> = { calling: "▶", ok: "✓", denied: "✕", error: "⚠" };
const STEP_COLOR: Record<AgentItem["status"], string> = {
  calling: "var(--info)", ok: "var(--success)", denied: "var(--warn)", error: "var(--danger)",
};

/**
 * A turn's tool calls, grouped into one card (one card per turn, not per call).
 *
 * The transcript used to render every call and every result as its own flat bubble: the tool's
 * *name* never appeared on a persisted result (only "tool result · …"), a 442-line file read put
 * raw HTML in the column, and a turn that made three calls read as three anonymous blocks. One
 * card per turn names every call, keeps the output behind a disclosure, and still shows a file
 * edit's diff outright — that being the part worth seeing without asking.
 */
function ToolRunGroup({ steps, live = false }: { steps: UIStep[]; live?: boolean }) {
  const [open, setOpen] = useState(live);
  const failed = steps.filter((s) => s.status === "error" || s.status === "denied").length;
  const running = steps.some((s) => s.status === "calling");
  const known = steps.some((s) => s.status !== undefined);
  // Neutral until something measures otherwise: a green "✓ 4 ran" on a replayed transcript would
  // be a claim no one checked.
  const color = !known ? "var(--border)" : failed ? "var(--danger)" : running ? "var(--info)" : "var(--success)";
  const label = steps.length === 1 ? "1 tool call" : `${steps.length} tool calls`;
  const outcome = !known ? "" : running ? " · running" : failed ? ` · ✕ ${failed} failed` : " · ✓ ran";
  return (
    <div className="mt-1.5 rounded border" style={{ borderColor: color, background: "var(--surface-2)" }}>
      <button
        type="button"
        className="mono flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]"
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ color: "var(--text-faint)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: known && !failed && !running ? "var(--success)" : "var(--text-dim)" }}>{label}{outcome}</span>
      </button>
      <div className="px-2.5 pb-1.5">
        {steps.map((s, i) => {
          const change = fileChangeFor(s.name, s.args);
          const glyph = s.status ? STEP_GLYPH[s.status] : "↳";
          const stepColor = s.status ? STEP_COLOR[s.status] : "var(--text-faint)";
          const summary = argSummary(s.args);
          return (
            <div key={i} className={i > 0 ? "mt-1.5 border-t pt-1.5" : ""} style={{ borderColor: "var(--border)" }}>
              <div className="mono flex items-baseline gap-1.5 text-[11px]">
                <span style={{ color: stepColor }}>{glyph}</span>
                <span style={{ color: "var(--text)" }}>{s.name}</span>
                {summary && <span className="truncate" style={{ color: "var(--text-faint)" }}>{summary}</span>}
              </div>
              {change ? (
                <div className="mt-1">
                  <DiffView change={change} />
                  {/* The diff is what the call *would* write, which is exactly why the result line
                      has to stay beside it: a refused `write_file` (plan mode, a denied approval)
                      never touched the file, and a bare diff would present it as done. The old
                      per-turn bubble showed this line; dropping it here was a regression the browser
                      suite caught (agent-approval.spec.ts, "in PLAN MODE"). */}
                  {s.result !== undefined && (
                    <div className="mono mt-0.5 truncate text-[10px]" style={{ color: "var(--text-faint)" }}>
                      {s.result.trim() ? s.result.replace(/\s+/g, " ").slice(0, 120) : "(no output)"}
                    </div>
                  )}
                </div>
              ) : open ? (
                <>
                  {Object.entries(s.args).map(([k, v]) => (
                    <div key={k} className="mono mt-1 break-all text-[11px]" style={{ color: "var(--text-dim)" }}>
                      <span style={{ color: "var(--text-faint)" }}>{k}: </span>
                      {typeof v === "string" ? (v.length > 600 ? `${v.slice(0, 600)}…` : v) : JSON.stringify(v)}
                    </div>
                  ))}
                  {s.result !== undefined && (
                    <pre className="mono mt-1 max-h-52 overflow-auto whitespace-pre-wrap text-[11px]" style={{ color: "var(--text-dim)" }}>{s.result}</pre>
                  )}
                </>
              ) : (
                // Collapsed still says what came back — one line, so a failure or an empty result
                // cannot hide behind a disclosure the user has no reason to open.
                s.result !== undefined && (
                  <div className="mono mt-0.5 truncate text-[10px]" style={{ color: "var(--text-faint)" }}>
                    {s.result.trim() ? s.result.replace(/\s+/g, " ").slice(0, 120) : "(no output)"}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact, collapsible view of a tool-result turn persisted in the transcript. */
function ToolResultBubble({ content, call }: { content: string; call?: ToolCallRef }) {
  const [open, setOpen] = useState(false);
  // An empty result used to render as "tool result · " with nothing after it — indistinguishable
  // from a collapsed result the user simply had not opened, and the reason a run could end with
  // "the tool results came back empty" and no clue why. Say it outright.
  const empty = content.trim().length === 0;
  const preview = content.replace(/\n/g, " ").slice(0, 70);

  // A file mutation renders as the change itself. This is why the result is paired with its call:
  // the arguments are on the assistant turn, so without the pairing the tool turn is just text.
  const change = call ? fileChangeFor(call.name, call.args) : null;
  if (change) {
    return (
      <div>
        <DiffView change={change} />
        {!empty && (
          <div className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>{preview}{content.length > 70 ? "…" : ""}</div>
        )}
      </div>
    );
  }

  const groups = call && isSearchResult(call.name) ? groupSearchMatches(content) : [];

  return (
    <div className="rounded border px-2.5 py-1.5" style={{ borderColor: empty ? "var(--warn)" : "var(--border)", background: "var(--surface-2)" }}>
      <button className="mono text-[11px]" style={{ color: "var(--text-dim)" }} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} tool result
        {open ? "" : ` · ${empty ? "(no output)" : `${preview}${content.length > 70 ? "…" : ""}`}`}
      </button>
      {open && (
        <div className="mono mt-1 max-h-60 overflow-auto text-[11px]" style={{ color: "var(--text)" }}>
          {empty ? (
            "(no output — the tool returned nothing, and said nothing about why)"
          ) : groups.length > 0 ? (
            // A search result is a list of hits; grouping by file is what makes it readable
            // instead of one undifferentiated run of `path:line: text`.
            <div className="space-y-1">
              {groups.map((g) => (
                <div key={g.file}>
                  <div style={{ color: "var(--text-dim)" }}>
                    {g.file} <span style={{ color: "var(--text-faint)" }}>({g.hits.length})</span>
                  </div>
                  {g.hits.map((h, i) => (
                    <div key={i} className="break-all pl-3" style={{ color: "var(--text-dim)" }}>{h}</div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <Markdown source={content} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The model's reasoning, folded away above its answer.
 *
 * Reasoning models stream their deliberation as a separate channel (`thinking_delta` on Anthropic,
 * `reasoning_content` on the OpenAI-compatible gateways). It is not the answer and must not read as
 * one — hence folded, labelled, and visually subordinate. But it must not be *discarded* either,
 * which is what the app did until 2026-10-02: `chunkMap.delta` is `$.delta.text`, so every thinking
 * delta was dropped, and a turn whose reasoning outran its output budget arrived as nothing at all.
 * The ledger filed it `PARSE_ERROR` against a manifest that was correct, and the user watched an
 * empty bubble fill the screen for 46 seconds while 25 000 characters of the model's actual work
 * went past unread.
 *
 * Open while streaming and closed afterwards, unless the reader says otherwise. Streaming reasoning
 * is the only evidence that a long turn is progressing rather than hung; a *finished* reasoning
 * block is mostly noise on top of the answer, so it collapses itself once there is an answer to
 * read. Either way the character count stays visible, because 25 000 characters and 40 characters
 * are different findings.
 */
function ReasoningPanel({ text, streaming }: { text: string; streaming?: boolean }) {
  // `null` = the reader has not expressed a preference, so follow the stream. An explicit toggle
  // then sticks, including through the moment streaming ends.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? Boolean(streaming);
  return (
    <div
      className="mb-1.5 rounded border"
      style={{ borderColor: "var(--border)" }}
      data-testid="reasoning-panel"
    >
      <button
        type="button"
        onClick={() => setChoice(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px]"
        style={{ color: "var(--text-dim)" }}
        data-testid="reasoning-toggle"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>{streaming ? "Thinking…" : "Thought process"}</span>
        <span style={{ color: "var(--text-faint)" }}>
          · {text.length.toLocaleString()} characters
        </span>
      </button>
      {open && (
        <div
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t px-2 py-1.5 text-[11px]"
          style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
          data-testid="reasoning-body"
        >
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * The live status line (2026-10-02).
 *
 * Replaces the bare "…" an in-flight turn showed while nothing had streamed yet — the three dots
 * the user could not read anything from. One line, two ends: the left says what the run is doing
 * right now (waiting on you / stopping / running a named tool / thinking), the right carries the
 * live-only metrics — elapsed time, tokens the run has spent so far, and the stop hint. They
 * vanish when the turn ends because this component unmounts with it, which is the point: the
 * metrics describe the run, not the transcript.
 *
 * No progress bar and no percentage: the loop has no known denominator, and every other coding
 * agent that tried one (Cursor, Copilot, Cline, Claude Code) settled on exactly this verb +
 * metrics line instead.
 */
function AgentStatus({
  items,
  waiting,
  stopping,
  usage,
}: {
  items: AgentItem[];
  waiting: string | null;
  stopping: boolean;
  usage: { tokensIn: number; tokensOut: number };
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  // The call in flight, if any — it is the one a "is it hung?" glance is really about, so it is
  // the one the status line names. Elapsed for it comes for free: the last "calling" item started
  // when the tool_call event arrived, and the timer above started when the run did.
  const running = items.length > 0 && items[items.length - 1]!.status === "calling" ? items[items.length - 1]! : null;
  const summary = running ? argSummary(running.args) : "";
  return (
    <div className="mono flex flex-wrap items-baseline gap-x-2 text-[11px]" data-testid="agent-status">
      {/* role="status" so the activity change is announced — but it sits on this span only, never
          on the metrics, which re-render every second and would flood a live region. */}
      <span role="status" style={{ color: waiting ? "var(--warn)" : "var(--info)" }}>
        {waiting
          ? `Waiting for you — ${waiting} needs approval`
          : stopping
            ? "Stopping — cancelling the step in flight"
            : running
              ? `Running ${running.name}`
              : "Thinking…"}
      </span>
      {running && summary && (
        <span className="truncate" style={{ color: "var(--text-faint)" }}>{summary}</span>
      )}
      <span className="ml-auto whitespace-nowrap" style={{ color: "var(--text-faint)" }}>
        {formatElapsed(elapsed)}
        {usage.tokensOut > 0 ? ` · ↑ ${formatTokens(usage.tokensOut)} tokens` : ""}
        {/* While the approval modal is up, Escape belongs to the modal (deny), not to stop. */}
        {!waiting && " · Esc to stop"}
      </span>
    </div>
  );
}

/** Compact elapsed clock for the status line: "47s", then "1m 42s" past the minute. */
function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

/** Live view of an in-flight agent turn: the status line, streamed text plus this turn's calls, grouped as they run. */
function AgentLive({
  raw,
  reasoning,
  items,
  waiting,
  stopping,
  usage,
}: {
  raw: string;
  reasoning: string;
  items: AgentItem[];
  waiting: string | null;
  stopping: boolean;
  usage: { tokensIn: number; tokensOut: number };
}) {
  // The same card the finished turn will render, so a run does not change shape the moment it
  // ends — the live view simply knows each call's status and the transcript does not.
  const steps: UIStep[] = items.map((it) => ({
    name: it.name,
    args: it.args,
    call: { name: it.name, args: it.args },
    ...(it.result !== undefined ? { result: it.result } : {}),
    status: it.status,
  }));
  return (
    <>
      <AgentStatus items={items} waiting={waiting} stopping={stopping} usage={usage} />
      {/* Above the prose, folded, open while it streams — the run's own record of what it is
          working through. A reasoning-heavy round-trip is otherwise a status line that has not
          changed for 40 seconds, which reads as a hang. */}
      {reasoning.trim() ? <ReasoningPanel text={reasoning} streaming /> : null}
      {raw.trim() ? <Markdown source={raw} /> : null}
      {steps.length > 0 && <ToolRunGroup steps={steps} live />}
    </>
  );
}

/* The per-call gate used to live here as `ConfirmModal` — allow/deny and nothing else. It is now
   `components/ApproveModal`, because the answer set grew a scope (this call / this tool / this
   session) and the component has one job worth testing on its own. */

/**
 * The approval-mode picker (Phase 5).
 *
 * A `<select>` rather than three radio buttons: the row already carries a checkbox group and a
 * number field, and the mode is the one control here that changes what the others *mean* — it
 * reads better as a named choice with its consequence spelled out underneath.
 */
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

function ImageBox() {
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; base64?: string; ms: number; provider?: string; key?: string } | null>(null);
  const [shown, setShown] = useState<string | null>(null); // data: URI once the bytes are in hand
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  // A generation can take tens of seconds; without this there was no way out but to wait for it.
  const abortRef = useRef<AbortController | null>(null);
  const def = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.image ?? "";
  const chosen = model || def;

  async function go() {
    if (!prompt.trim() || !chosen || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    setResult(null);
    setShown(null);
    setFetchNote(null);
    const t0 = Date.now();
    setProgress("Queued at the router…");
    const timer = window.setTimeout(() => setProgress("Waiting for the provider…"), 1500);
    try {
      // A1 Phase 2: served by the gateway's OpenAI-shaped image route, like every client.
      const res = await gatewayGenerateImage({ model: chosen, prompt: prompt.trim() }, { signal: ac.signal });
      setProgress("");
      setResult({ ...res, ms: Date.now() - t0, provider: chosen.split("/")[0] });

      if (res.base64) {
        setShown(`data:image/png;base64,${res.base64}`);
      } else if (res.url) {
        // Provider-returned URL (e.g. a CDN link). The webview CSP blocks it directly; pull
        // the bytes through the host's scoped fetch (invariant 3 carve-out, no secret sent).
        setFetchNote("fetching the image through the host…");
        try {
          setShown(await fetchImageUrl(res.url));
          setFetchNote(null);
        } catch (e) {
          setFetchNote(`could not load the image (${(e as Error).message}) — the link below still works`);
        }
      }
    } catch (e) {
      // A user-initiated stop is not a failure to report in red — it is the thing they asked for.
      setProgress("");
      setError(ac.signal.aborted ? "stopped by you" : (e as Error).message);
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="mb-3 flex items-center gap-2">
        <ModelPicker modality="image" value={chosen} onChange={setModel} />
        {registry.listProviders().length === 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            image models come from providers whose catalog tags them (dall-e / flux / sd / imagen / seedream / nano-banana patterns)
          </span>
        )}
      </div>
      <textarea
        className={`${inputCls} mb-2 resize-none`}
        style={inputStyle}
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="A tiny lighthouse on a stormy cliff, painterly…"
      />
      <div className="flex items-center gap-3">
        {busy ? (
          <Button variant="danger" onClick={() => abortRef.current?.abort()}>■ Stop</Button>
        ) : (
          <Button variant="primary" disabled={!chosen || !prompt.trim()} onClick={() => void go()}>Generate</Button>
        )}
        {progress && <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>{progress}</span>}
        {fetchNote && <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>{fetchNote}</span>}
      </div>
      {error && <p className="mt-3 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}
      {result && (
        <div className="mt-3">
          <p className="mono mb-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
            ✓ {result.ms}ms · {result.provider}{result.key ? ` · ${result.key}` : ""}
          </p>
          {shown && <img alt="generated" src={shown} className="max-h-80 rounded border" style={{ borderColor: "var(--border)" }} />}
          {result.url && (
            <p className="mono mt-1 text-[11px] break-all" style={{ color: "var(--text-faint)" }}>{result.url}</p>
          )}
        </div>
      )}
    </div>
  );
}
