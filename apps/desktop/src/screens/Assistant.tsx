/**
 * Assistant — a router console for talking to any routed model (UI_UX_PLAN.md §3): model picker,
 * streaming assistant text, a STOP button (cancellation, spec req. 9), and after every
 * request the calm summary line (`✓ 421ms · OpenRouter · key-03` / `↻ 1 fallback`) with an
 * expandable per-attempt route trace. Acceptance criterion 4: text + image end-to-end.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  catalog,
  listSkills,
  registry,
  router,
  loadHistorySessions,
  resumeSession,
  setSessionTitle as saveSessionTitle,
  type HistorySession,
} from "../store";
import { selectableModels } from "../lib/models/selectable";
import { fetchImageUrl } from "../ipc-client";
import { invoke } from "@tauri-apps/api/core";
import { fetchAdmin } from "../lib/gateway-client";
import { useUi } from "../ui-state";
import { Button, EmptyState, Modal, inputCls, inputStyle } from "../components/atoms";
import { Markdown } from "../components/Markdown";
import { Composer, type Attachment, type InlinedText } from "../components/Composer";
import { parseListing, type MentionCandidate } from "../lib/chat/mentions";
import { parseAssistantStream, type ToolSegment } from "../lib/assistant-stream";
import { editPoint, retryPoint } from "../lib/chat/actions";
import { runAgentLoop, AGENT_TOOLS, createTauriToolHost, fetchToolsPolicy, fetchDefaultRoot, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP, type ToolsPolicy, type AgentEvent } from "../lib/tools";
import {
  APPROVAL_MODES, INITIAL_APPROVAL, decide, withAllowAll, withTrustedTool,
  RunCheckpoint, createCheckpointingHost, revertPlan,
  type ApprovalMode, type ApprovalState, type RunChangeSet,
} from "../lib/tools";
import { ApproveModal, type ApprovalChoice } from "../components/ApproveModal";
import { ChangeSetReview } from "../components/ChangeSetReview";
import { toolCallName } from "../lib/tools/wire";
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
import type { ChatMessage, ToolCall, UsageTokens } from "@aiprovider/router-core";
import {
  estimateTokens, DEFAULT_CONTEXT_WINDOW, userContent, textOfContent, compressWithSummary, type CatalogModel,
} from "@aiprovider/router-core";
import { listLedger } from "../store";
import { formatCost } from "../lib/ledger/format";
import { shortcutFor } from "../lib/keys/shortcuts";
import { activeSession, startSession, type Recorder } from "../lib/context/recorder";
import { endRun, newRunId, recordStep, registerAbort, startRun } from "../lib/agent/orchestrator";
import {
  distilTurn, memoryBlock, recallContext, recordRecall, rememberTurn,
} from "../lib/memory/engine";

interface Msg {
  /** Stable identity. The transcript is truncated, re-run and forked by position, so rendering
   *  must key on something that survives an edit — an array index does not. */
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant turn that requested tool calls, so the next turn can replay them. */
  tool_calls?: unknown;
  /** Set on a tool result turn, linking it to its originating call. */
  tool_call_id?: string;
  /**
   * Images this user turn was sent with (P3). Kept on the transcript, not only on the request,
   * because a follow-up turn has to replay them: "what about the second one?" is unanswerable if the
   * picture vanished from history the moment it was sent. The bytes are already in memory (they came
   * from the composer), so this costs no extra read.
   */
  attachments?: Attachment[];
  /** Names of workspace files inlined into this turn, for the transcript's own labelling. */
  inlined?: InlinedText[];
}

/** Monotonic within a session; combined with a timestamp so a resumed transcript cannot collide
 *  with ids minted in this run. */
let msgSeq = 0;
function newMsgId(): string {
  msgSeq += 1;
  return `m-${Date.now().toString(36)}-${msgSeq}`;
}

/** Assign ids to messages that arrived without them (a resumed transcript from History). */
function withIds(msgs: ReadonlyArray<Omit<Msg, "id">>): Msg[] {
  return msgs.map((m) => ({ ...m, id: newMsgId() }));
}

/**
 * Replay prior turns for a follow-up request — the one place both the agent and the plain-chat
 * paths build history from.
 *
 * `tool_calls` and `tool_call_id` have to survive the replay, not just `role` and `content`. A
 * tool-result message without its `tool_call_id` is rejected by every OpenAI-compatible provider
 * with HTTP 400, and the assistant turn that asked for it is meaningless without `tool_calls`.
 *
 * These were two separate mappings and only the agent's kept the tool fields, so any session that
 * had used agent mode failed on the *next plain message* with `BAD_REQUEST_SCHEMA` — the request
 * was refused for replaying a tool result the provider could not match to a call. Keeping one
 * mapping is the point: the bug was the divergence, not either version of the filter.
 *
 * The filter also drops the empty assistant bubble a stopped or failed turn leaves behind —
 * `{ role: "assistant", content: "" }` is rejected with 400 by most providers too.
 */
function replayHistory(msgs: Msg[]): ChatMessage[] {
  return msgs
    // A turn carrying an image has text too (the question), so the filter's usual test still holds;
    // an image-only turn is kept by the second clause rather than dropped as "empty".
    .filter((m) => m.content.trim().length > 0 || (m.role === "assistant" && m.tool_calls) || (m.attachments?.length ?? 0) > 0)
    .map((m) => ({
      role: m.role,
      // Rebuilt as content parts so the image travels with its turn. `userContent` returns a plain
      // string when there are no attachments, which is what keeps an ordinary turn a string.
      content: userContent(m.content, (m.attachments ?? []).map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 }))),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })) as ChatMessage[];
}

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
    const exec = await router.generateText(
      {
        model,
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: transcript },
        ],
        maxTokens: SUMMARIZER_MAX_TOKENS,
      },
      { skipCompression: true, source: "ui" },
    );
    let out = "";
    for await (const chunk of exec.chunks) out += chunk;
    return out.trim();
  };
}

/**
 * Agent-mode system prompt. Unlike the no-tools guard (which suppresses tool-call markup),
 * this one tells the model it DOES have tools and how to use them — confined to the workspace
 * root the user sets. It is deliberately terse; the sandbox, not the prompt, is the enforcement.
 */
const AGENT_SYSTEM =
  "You are an agent inside AI-Provider Router. You have file and shell tools confined to the " +
  "workspace root the user specified. Complete the task by calling tools: search_files to find " +
  "where something is, read_file (with offset/limit for large files) and list_dir to inspect, " +
  "file_info to check a path exists, edit_file to change one exact snippet, write_file to " +
  "create a whole file, mkdir to make a directory, run_command for allowlisted commands. " +
  "Prefer inspecting before editing, and prefer edit_file over rewriting a whole file. " +
  "Never ask the user to run a command — call the tool. " +
  "Stop calling tools once the task is done and give a concise final answer.";

/**
 * The agent's system prompt, plus where it actually is.
 *
 * Without the root, "what is the exact path?" is a question the agent cannot answer: it has to
 * spend a tool call on `pwd`, and if that call is denied or fails it reports that it cannot tell.
 * The root is the user's own setting, so naming it costs nothing and answers the question outright.
 */
function agentSystem(root: string, custom?: string): string {
  const base = custom && custom.trim() ? custom.trim() : AGENT_SYSTEM;
  const r = root.trim();
  if (!r) return base;
  return (
    base +
    `\n\nYour workspace root is: ${r}. Every relative path resolves inside it — answer questions ` +
    `about the path from this rather than spending a tool call on \`pwd\`.`
  );
}

interface AgentItem {
  name: string;
  args: Record<string, unknown>;
  status: "calling" | "ok" | "error" | "denied";
  result?: string;
}

/**
 * Plan mode's system prompt (Phase 5).
 *
 * The prompt is not the enforcement — the approval gate refuses every mutation itself, and would
 * refuse them even if this text were deleted. Saying it anyway is what makes the pass *useful*:
 * a model that is asked to research and is silently blocked at its first edit spends its tool
 * budget rediscovering that it cannot write, and then answers with an apology. Told up front, it
 * proposes instead.
 */
const PLAN_MODE_SYSTEM =
  "\n\nPLAN MODE — this pass may not modify the workspace. Every writing tool (write_file, " +
  "edit_file, mkdir, run_command) will be refused. Use the read-only tools (read_file, list_dir, " +
  "search_files, file_info) to understand the task, then answer with the plan you intend to carry " +
  "out: numbered steps, the exact files each step changes, and anything you would need to confirm. " +
  "Do not attempt a write, and do not ask the user to apply it for you.";

/** The user turn that starts the executing pass after a plan is approved. Phrased as the user's
 *  own words rather than a hidden instruction, because it is replayed in every later turn. */
const PLAN_APPROVED_TURN = "The plan is approved — carry it out now.";

/** Graph labels are identifiers, not content — a 400-character node is unreadable on canvas. */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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
 * Record what one agent turn produced: each message after the user's, and for every tool call a
 * skill node plus the artifact its result produced.
 *
 * A tool result is recorded as an artifact because that is what it is to the model — context it
 * was handed, not something it said. That distinction is the whole reason the graph has two node
 * kinds instead of one.
 *
 * `userNode` and `produced` are both supplied by the caller, and both matter:
 *
 *   - `userNode` is the id of the node the caller already created for this turn's prompt. The
 *     caller needs that node before the run starts (recall edges anchor to it), so creating a
 *     second one here would put the same prompt in the graph twice.
 *   - `produced` is only what THIS turn added. `runAgentLoop` seeds its working copy from the
 *     replayed history and hands the whole transcript back, so passing that verbatim would
 *     re-record every earlier turn as brand-new nodes on every turn.
 */
function recordAgentTurn(rec: Recorder, userNode: string, produced: ChatMessage[], model: string): string {
  let prev: string = userNode;
  const skillByCall = new Map<string, string>();

  for (const m of produced) {
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "tool") {
      const artifact = rec.node("artifact", clip(content, 80), { tool_call_id: m.tool_call_id });
      const skill = m.tool_call_id ? skillByCall.get(m.tool_call_id) : undefined;
      rec.edge(skill ?? prev, artifact, "produced");
      continue;
    }
    // `tool_calls` is `unknown` in the core's message type: the wire shape varies by dialect
    // and the core does not commit to one. A stored transcript may hold either the flat internal
    // shape or OpenAI's nested one (the agent loop writes the latter), so the name is read
    // tolerantly rather than assuming whichever shape the current writer produces.
    const calls = (m.tool_calls as ToolCall[] | undefined) ?? [];
    const node = rec.node("message", clip(content, 120), {
      role: m.role,
      model,
      tool_calls: calls.length ? calls : undefined,
    });
    rec.edge(prev, node, "follows");
    for (const c of calls) {
      const skill = rec.node("skill", toolCallName(c));
      rec.edge(node, skill, "used");
      if (c.id) skillByCall.set(c.id, skill);
    }
    prev = node;
  }
  return prev;
}

function tryParseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Guard against the mercury-2.5 failure: Assistant declares no tools, and a model handed a
 * toolless request will sometimes invent tool-call markup from its agentic training data.
 * Saying so outright in the system turn stops it at the source. Off = raw model behaviour,
 * which is what you want when probing a provider's own prompting.
 */
const NO_TOOLS_SYSTEM =
  "You are answering inside AI-Provider Router's Assistant — a plain chat console. " +
  "You have no tools, functions, plugins, or file/shell access of any kind. " +
  "Never emit tool-call markup (for example <tool_call>, <|tool_call_start|>, or <function=...>). " +
  "When a request would need a tool, say so in plain prose and describe the steps instead.";

interface Trace {
  ms: number;
  provider?: string;
  key?: string;
  model?: string;
  fallbacks: { provider: string; key: string; cls: string }[];
  error?: string;
  finishReason?: string;
}

/**
 * One of the screen's behavioural switches — agent mode, memory, the no-tools guard.
 *
 * These sit under the title rather than beside the model picker because they are not
 * per-request choices: the picker changes what this one message is sent to, these change how the
 * screen behaves for everything after. Grouping them with the picker buried a screen-level
 * setting among request-level controls.
 */
function OptionCheck({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-1.5 text-[11px] ${disabled ? "opacity-50" : "cursor-pointer"}`}
      style={{ color: "var(--text-dim)" }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
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
    <label
      className={`flex items-center gap-1.5 text-[11px] ${disabled ? "opacity-50" : "cursor-pointer"}`}
      style={{ color: "var(--text-dim)" }}
      title={
        disabled
          ? "only applies in agent mode — without tools there is nothing to step through"
          : `how many rounds of tool calls one turn may take (1–${MAX_ITERATIONS_CAP}); the loop also stops as soon as the model answers without calling a tool`
      }
    >
      tool steps
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
        className="w-14 rounded border px-1 py-0.5 text-[11px]"
        style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
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
  onChangeSystem,
  onChangeNoTools,
  onChangeAgent,
  onClose,
}: {
  customSystem: string;
  customNoTools: string;
  customAgent: string;
  onChangeSystem: (v: string) => void;
  onChangeNoTools: (v: string) => void;
  onChangeAgent: (v: string) => void;
  onClose: () => void;
}) {
  const ta = "mono w-full rounded border p-2 text-[11px]";
  const taStyle = { background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" } as const;
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
}

const ASSISTANT_SETTINGS_KEY = "assistant";

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
  const [tab, setTab] = useState<"text" | "image">("text");
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
  // The tool-step ceiling. It is a setting rather than a constant because it is the one knob
  // that trades cost against thoroughness per run: a one-shot question wants 1, a real refactor
  // across a repo doesn't finish in 8.
  const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
  const [temperature, setTemperature] = useState<number | "">("");
  const [maxTokens, setMaxTokens] = useState<number | "">("");
  // System-prompt editor state — a string means "editing", null means "closed".
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");
  const [customNoToolsSystem, setCustomNoToolsSystem] = useState("");
  const [customAgentSystem, setCustomAgentSystem] = useState("");
  const [root, setRoot] = useState("");
  // The workspace the host offers as a default, remembered so the UI can say "this is the
  // default" instead of silently filling a field the user did not fill.
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  // A root that will not work is worth saying before the run, not after it. An unusable root
  // used to reach the model as a blank tool result, which reads as "the agent is broken" rather
  // than "the path you typed does not exist" — and the model echoes that back.
  const [rootError, setRootError] = useState<string | null>(null);
  // Nothing is written until the stored settings have been read. Without this the first render
  // would save the defaults over whatever the user had actually chosen.
  const [hydrated, setHydrated] = useState(false);

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
      if (typeof stored.systemPrompt === "string") setCustomSystemPrompt(stored.systemPrompt);
      if (typeof stored.noToolsSystem === "string") setCustomNoToolsSystem(stored.noToolsSystem);
      if (typeof stored.agentSystem === "string") setCustomAgentSystem(stored.agentSystem);
      // Validated against the known ids rather than trusted: an unknown string from a future
      // build would otherwise reach `decide()` and match none of its branches, which reads as
      // "ask every time" — a silent downgrade the user could not see.
      if (APPROVAL_MODES.some((m) => m.id === stored.approvalMode)) setApprovalMode(stored.approvalMode!);
      setDefaultRoot(fallback);
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
      // `null`, never `undefined`, for an unset field. `JSON.stringify` omits an undefined key, so
      // an omitted one leaves the previously stored value in the row — clearing "max tokens" would
      // look like it worked and then quietly come back on the next load.
      temperature: typeof temperature === "number" ? temperature : null,
      maxTokens: typeof maxTokens === "number" ? maxTokens : null,
      // Always written, empty string included: same reason, for the three prompts.
      systemPrompt: customSystemPrompt,
      noToolsSystem: customNoToolsSystem,
      agentSystem: customAgentSystem,
    }),
    [root, agentMode, useMemory, noTools, maxIterations, approvalMode, temperature, maxTokens,
      customSystemPrompt, customNoToolsSystem, customAgentSystem],
  );

  // The debounced write below must serialise the state as it is WHEN IT FIRES, not as it was
  // when it was scheduled. `setTimeout(saveAll, 400)` captures the `saveAll` of the render that
  // scheduled it, and this effect only re-runs on `root` — so a switch toggled inside the
  // debounce window was written, then overwritten with the pre-toggle snapshot. A human is
  // slower than 400 ms and never saw it; a driver is not, and the setting silently reverted.
  const latestSave = useRef(saveAll);
  latestSave.current = saveAll;

  // Persist. The switches are single clicks, so they are written immediately.
  useEffect(() => {
    if (!hydrated) return;
    saveAll();
    // `root` is written by the debounced effect below; depending on it here would write twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, agentMode, useMemory, noTools, maxIterations, approvalMode, temperature, maxTokens,
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

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col" data-testid="assistant-column">
      <div className="mb-2 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">Assistant</h1>
        <div className="ml-auto flex gap-1 rounded border p-0.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          {(["text", "image"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="rounded px-2.5 py-1 text-[12px]"
              style={tab === t ? { background: "var(--surface-2)", color: "var(--text)" } : { color: "var(--text-dim)" }}
            >
              {t === "text" ? "Chat" : "Image"}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <OptionCheck label="agent mode" checked={agentMode} onChange={setAgentMode} />
        <OptionCheck label="memory" checked={useMemory} onChange={setUseMemory} />
        <OptionCheck
          label="tell the model it has no tools"
          checked={noTools}
          onChange={setNoTools}
          disabled={agentMode}
        />
        <StepBudget
          value={maxIterations}
          onChange={setMaxIterations}
          disabled={!agentMode}
        />
        <ApprovalPicker
          mode={approvalMode}
          onChange={setApprovalMode}
          disabled={!agentMode}
        />
        <OptionCheck
          label="plan mode"
          checked={planMode}
          onChange={setPlanMode}
          disabled={!agentMode}
        />
      </div>
      {agentMode && planMode && (
        // The pairing is the whole reason this appears: plan mode subtracts permissions and never
        // grants them, so a plan pass that reads without being clicked through needs the mode
        // above it to say so. Without this line the user gets asked about every read and reads
        // that as plan mode being broken.
        <p className="-mt-2 mb-2 text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="plan-mode-hint">
          Plan mode refuses every write, whatever the approval mode. Pair it with “auto-approve reads”
          for a pass that explores without asking.
        </p>
      )}
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
          onTemperatureChange={setTemperature}
          onMaxTokensChange={setMaxTokens}
          systemPrompt={customSystemPrompt || undefined}
          noToolsSystem={customNoToolsSystem || undefined}
          agentSystemPrompt={customAgentSystem || undefined}
          root={root}
          rootError={rootError}
          defaultRoot={defaultRoot}
          onRootChange={setRoot}
          onEditPrompts={() => setEditingPrompt("system")}
          onSwitchToImageTab={() => setTab("image")}
          active={tab === "text"}
        />
      </div>
      <div className={tab === "image" ? "min-h-0 flex-1" : "hidden"}>
        <ImageBox />
      </div>
      {editingPrompt !== null && (
        <SystemPromptEditor
          customSystem={customSystemPrompt}
          customNoTools={customNoToolsSystem}
          customAgent={customAgentSystem}
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
  onTemperatureChange,
  onMaxTokensChange,
  systemPrompt,
  noToolsSystem,
  agentSystemPrompt,
  root,
  rootError,
  defaultRoot,
  onRootChange,
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
  onTemperatureChange: (v: number | "") => void;
  onMaxTokensChange: (v: number | "") => void;
  systemPrompt?: string;
  noToolsSystem?: string;
  /** Named `agentSystemPrompt` rather than `agentSystem`: the latter is the module-level builder
   *  this component still has to call, and a same-named prop silently shadows it. */
  agentSystemPrompt?: string;
  root: string;
  rootError: string | null;
  defaultRoot: string | null;
  onRootChange: (v: string) => void;
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
  const [model, setModel] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    const resume = useUi.getState().resumeTranscript;
    if (resume) {
      useUi.getState().setResumeTranscript(undefined);
      return withIds(resume as Omit<Msg, "id">[]);
    }
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
  /** A one-line notice: a refused attachment, a mention that matched nothing. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped by `/model` to open the picker, which owns its own open state. */
  const [pickerNonce, setPickerNonce] = useState(0);
  const [policy, setPolicy] = useState<ToolsPolicy | null>(null);
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
  const [streamedText, setStreamedText] = useState("");
  const [showPolicy, setShowPolicy] = useState(false);
  // P7: usage capture for the context meter and token/cost readout.
  const [lastUsage, setLastUsage] = useState<UsageTokens | null>(null);
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
  const abortRef = useRef<AbortController | null>(null);
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
  // P6: the run currently being recorded, and the iteration count the loop reports when it ends.
  const runIdRef = useRef<string | null>(null);
  const iterationsRef = useRef(0);
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

  // P7: aggregate session cost/tokens from the in-memory ledger.
  //
  // Called at the end of every turn rather than only from an effect on `tick`: a ledger append
  // does not bump the store tick (the sink is a detached `fetchAdmin`), so a tick-only readout
  // showed the totals from *before* the turn the user just watched finish. The effect below keeps
  // it live for traffic this screen did not initiate.
  const refreshUsageTotals = useCallback(() => {
    let micros = 0;
    let rows = 0;
    let unpriced = 0;
    let inTokens = 0;
    let outTokens = 0;
    for (const e of listLedger()) {
      if (e.source === "ui" && e.status === "ok") {
        rows += 1;
        // Same rule Activity's rows use: a ledger row's cost is only meaningful when the catalog
        // knows a price for that model. Without this check an unpriced model contributes 0 and the
        // total reads as though the request were free.
        if (catalog.pricingFor(e.providerId ?? "", e.model)) micros += e.costEstimateMicros ?? 0;
        else unpriced += 1;
        inTokens += e.tokensIn ?? 0;
        outTokens += e.tokensOut ?? 0;
      }
    }
    setSessionCost({ micros, rows, unpriced });
    setSessionTokensIn(inTokens);
    setSessionTokensOut(outTokens);
  }, []);

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

  useEffect(() => {
    refreshUsageTotals();
  }, [tick, refreshUsageTotals]);

  // P8: keep the palette honest about "New chat" — it is refused while a turn runs (same reason
  // `newChat` guards on `busy`: re-entering the loop mid-stream interleaves two runs into one
  // transcript), so the palette needs to know.
  const setAssistantBusy = useUi((s) => s.setAssistantBusy);
  useEffect(() => {
    setAssistantBusy(busy);
  }, [busy, setAssistantBusy]);
  // Cleared on unmount and only on unmount, so leaving the Assistant does not leave a stale "a turn
  // is running" behind for the palette to report on another screen.
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
  keyActions.current = { newChat, stop: () => abortRef.current?.abort(), busy };
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

  // Surface the live sandbox allowlist once when agent mode is first enabled.
  useEffect(() => {
    if (!agentMode || policy) return;
    void fetchToolsPolicy().then(setPolicy).catch(() => setPolicy(null));
  }, [agentMode, policy]);

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

  const def = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.text ?? "";
  const chosen = model || def;
  // P7: context window for the chosen model — looked up from the catalog. A qualified id
  // `slug/native` needs to resolve the provider to find the catalog row; a bare id scans all carriers.
  const modelWindow = useMemo(() => {
    if (!chosen) return DEFAULT_CONTEXT_WINDOW;
    const rows = catalog.all();
    const nativeId = chosen.includes("/") ? chosen.split("/")[1]! : chosen;
    const matching = rows.find((m) => m.nativeId === nativeId && m.modality === "text");
    return typeof matching?.contextWindow === "number" && matching.contextWindow > 0
      ? matching.contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  }, [chosen, tick]);
  // P7: estimated prompt tokens for the NEXT send — the system turn the mode implies, the replayed
  // history, and the draft in the composer. The system turn is included because it is not small:
  // the agent prompt plus the installed skills' bodies run to hundreds of tokens, and leaving them
  // out would understate the one number the meter exists to report. Two things are still outside
  // the estimate, both by nature: the recalled memory block (computed at send time) and, in agent
  // mode, the tool definitions.
  const currentPromptTokens = useMemo(() => {
    if (!draftText.trim() && msgs.length === 0) return 0;
    const systemText = agentMode
      ? agentSystem(root, agentSystemPrompt) + skillsBlock
      : noTools
        ? (noToolsSystem || NO_TOOLS_SYSTEM)
        : (systemPrompt ?? "");
    const all: ChatMessage[] = [
      ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
      ...replayHistory(msgs),
      ...(draftText.trim() ? [{ role: "user" as const, content: draftText }] : []),
    ];
    return estimateTokens(all);
  }, [msgs, draftText, tick, agentMode, noTools, root, agentSystemPrompt, skillsBlock, noToolsSystem, systemPrompt]);
  // P7: context meter — fraction of the window consumed.
  const contextUsedRatio = Math.min(1, currentPromptTokens / modelWindow);
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

  const confirmGate = useCallback(
    async (call: ToolCall, args: Record<string, unknown>) => {
      const name = call.name ?? "?";
      const verdict = decide(approvalRef.current, name);
      // Plan mode refuses writes itself, and does so without a modal: a prompt here would let the
      // user approve exactly the write plan mode exists to prevent, one click away from a mode
      // they chose for a reason.
      if (verdict.action === "allow") return { allow: true };
      if (verdict.action === "deny") return { allow: false, reason: verdict.reason };
      const choice = await new Promise<ApprovalChoice>((resolve) => setPendingConfirm({ call, args, resolve }));
      if (choice.allow && choice.scope !== "once") {
        // Applied to the ref **and** to state. State is what the render reads; the ref is what the
        // very next call of this same run reads, and `setGranted` is not applied until React
        // re-renders — which the loop does not wait for. Without the ref, "always allow this tool"
        // would ask about the same tool again on the immediately following call.
        const next = choice.scope === "session"
          ? withAllowAll(approvalRef.current)
          : withTrustedTool(approvalRef.current, name);
        approvalRef.current = next;
        setGranted({ trustedTools: next.trustedTools, allowAll: next.allowAll });
      }
      return { allow: choice.allow };
    },
    [],
  );

  const handleAgentEvent = useCallback((ev: AgentEvent) => {
    // P6: every event is appended to the run record as it arrives, not batched at the end, so a
    // run that is stopped or crashes is still fully inspectable from the dashboard.
    const run = runIdRef.current;
    if (run) {
      if (ev.type === "tool_call") {
        recordStep(run, "tool_call", ev.call.name ?? "?", ev.call.arguments ?? undefined);
      } else if (ev.type === "tool_result") {
        // `refused` as well as `denied`: plan mode refuses a write on its own behalf, and the two
        // are the same thing to the reader ("the agent did not run this") while being different
        // things to them ("you said no" / "the mode said no"). Both render as "denied" here and the
        // full sentence is in the recorded step. Without `refused` in this test every plan-mode
        // refusal painted the caller's block as an unexpected failure.
        const denied = /denied|refused/i.test(ev.result);
        recordStep(run, denied ? "denied" : "tool_result", ev.call.name ?? "?", ev.result.slice(0, 500), ev.ok);
      } else if (ev.type === "done") {
        iterationsRef.current = ev.iterations;
        recordStep(run, "done", ev.iterations ? `${ev.iterations} iterations` : "done", undefined, true);
      }
    }
    if (ev.type === "assistant") {
      setStreamedText((t) => t + ev.text);
    } else if (ev.type === "tool_call") {
      setAgentItems((l) => [...l, { name: ev.call.name ?? "?", args: tryParseArgs(ev.call.arguments), status: "calling" }]);
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
  ) {
    const trimmed = text.trim();
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
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = Date.now();

    // ---- Agent mode: run the loop, execute tools through the sandbox, confirm each call. ----
    if (agentMode) {
      if (!root.trim()) {
        // Undo the optimistic append: the turn never ran, so it must not sit in the transcript.
        setMsgs(baseMsgs);
        setTrace({ ms: 0, fallbacks: [], error: "set a workspace root before using agent mode" });
        setBusy(false);
        abortRef.current = null;
        return;
      }
      setStreamedText("");
      setAgentItems([]);
      // The previous run's review is about to be superseded — and leaving it up while a new run
      // writes the same files would offer a revert that restores a state two runs old.
      setRunChanges(null);
      // P6: open the run record before the first call, and register this controller so the
      // orchestrator dashboard can stop the run even though it did not start it.
      const runId = newRunId();
      runIdRef.current = runId;
      iterationsRef.current = 0;
      startRun({ runId, sessionId: ctxRef.current?.sessionId ?? null, model: chosen, prompt: trimmed });
      registerAbort(runId, ac);
      // P5: the run's checkpoint. Every write this run makes goes through the wrapping host, which
      // reads the file's previous contents *before* the write — that is what makes both the review
      // diff and "revert this run" show what actually changed rather than what the model claimed.
      const checkpoint = new RunCheckpoint();
      const host = createCheckpointingHost(createTauriToolHost(root.trim()), checkpoint);
      // The user's node is created here rather than inside recordAgentTurn, because the recall
      // edges need an anchor before the run starts. Same shape as the plain-chat branch below:
      // one node per turn, reused by everything that needs to point at it.
      const rec = ctxRef.current!;
      const userNode = rec.node("message", clip(trimmed, 120), { role: "user", model: chosen });
      if (lastNodeRef.current) rec.edge(lastNodeRef.current, userNode, "follows");
      // P7: recall before the run so the agent starts from what is already known. Awaited,
      // because the recalled block has to be in the system prompt before the first call.
      const recalled = useMemory ? await recallContext(trimmed) : [];
      if (recalled.length > 0) recordRecall(userNode, recalled);
      // Replay prior turns verbatim — including assistant turns that carry tool_calls and the
      // tool-result turns that answer them — so the model keeps its chaining context.
      const history: ChatMessage[] = [
        ...replayHistory(baseMsgs),
        {
          role: "user",
          content: userContent(trimmed, attachments.map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 }))),
        },
      ];
      try {
        const { text: finalText, messages } = await runAgentLoop({
          model: chosen,
          messages: history,
          system: agentSystem(root, agentSystemPrompt) + skillsBlock + (memoryBlock(recalled) ? `\n\n${memoryBlock(recalled)}` : "") + (planMode ? PLAN_MODE_SYSTEM : ""),
          registry: AGENT_TOOLS,
          // Tier 2: when this request has to drop context, the dropped turns are summarized
          // rather than discarded. One summarizer per run, built against the chosen model.
          // P7: pass through per-request temperature/maxTokens and capture usage for the meter.
          generate: (req, opts) =>
            router.generateText(
              {
                ...req,
                ...(typeof temperature === "number" ? { temperature } : {}),
                ...(typeof maxTokens === "number" ? { maxTokens } : {}),
                onUsage: (u) => {
                  req.onUsage?.(u);
                  setLastUsage(u);
                },
              },
              { ...opts, summarize: createSummarizer(chosen) },
            ),
          host,
          // Clamped again at the call site: this is the number that actually bounds the spend,
          // and it is reached from a setting that a future build may have written differently.
          maxIterations: clampIterations(maxIterations),
          confirm: confirmGate,
          onEvent: handleAgentEvent,
          onFinish: setFinishReason,
          signal: ac.signal,
        });
        // The loop terminates the moment it sees an answer with no tool calls, but it does NOT
        // append that final assistant turn — `text` is the answer and `messages` is what came
        // before. Append it so the UI and the context graph both see the closing line.
        const fullMessages: ChatMessage[] = [...messages, { role: "assistant", content: finalText }];
        setMsgs(
          fullMessages.map((m) => ({
            id: newMsgId(),
            role: m.role as Msg["role"],
            // `textOfContent`: the agent loop's transcript includes the user turn we sent, which
            // carries parts when it had images. The transcript stores text; the images stay on the
            // turn that owns them (and the graph records the text, as before).
            content: textOfContent(m.content),
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
        );
        void finalText;
        // Only this turn's messages. `runAgentLoop` seeds its working copy from `history` and
        // returns the whole transcript, so slicing off the replayed prefix is what keeps an
        // earlier turn from being re-recorded — and keeps the graph linear in turns.
        lastNodeRef.current = recordAgentTurn(rec, userNode, fullMessages.slice(history.length), chosen);
        // P7: remember the exchange, then distil it. Distillation is deliberately not awaited —
        // it is an extra model call, and a slow or failing one must not hold up the answer the
        // user is already reading.
      if (useMemory) {
        void rememberTurn(ctxRef.current!.sessionId, trimmed, finalText).then(() =>
          distilTurn(ctxRef.current!.sessionId, chosen),
        ).catch(() => { /* memory distillation is best-effort */ });
      }
      endRun(runId, "ok", iterationsRef.current);
        setTrace({ ms: Date.now() - t0, fallbacks: [], provider: "agent" });
      } catch (e) {
        // The turn's own bubble, not only the trace line. A failed agent run left an empty
        // assistant turn behind, which rendered as a bare "…" — indistinguishable from a model that
        // had not answered yet — with the only clue a thin red line above the composer.
        const fill = (note: string) =>
          setMsgs((m) => m.map((x) => (x.id === assistantMsg.id && !x.content.trim() ? { ...x, content: note } : x)));
        if (ac.signal.aborted) {
          endRun(runId, "stopped", iterationsRef.current);
          setTrace({ ms: Date.now() - t0, fallbacks: [], error: "stopped by you" });
          fill("⚠ stopped by you — this turn did not finish. Send again, or retry it from the message actions.");
        } else {
          endRun(runId, "error", iterationsRef.current, (e as Error).message);
          setTrace({ ms: Date.now() - t0, fallbacks: [], error: (e as Error).message });
          fill(`⚠ ${(e as Error).message}`);
        }
      } finally {
        // Flush here, not on the success path only. The user's node — and any recall edges
        // anchored to it — is created before the run starts, so a stopped or failed run would
        // otherwise leave those nodes buffered and silently prepend them to the next turn's
        // batch. Same policy as the plain-chat branch: a partial turn is still a turn.
        void ctxRef.current!.flush();
        runIdRef.current = null;
        setBusy(false);
        setPendingConfirm(null);
        setAgentItems([]);
        setStreamedText("");
        abortRef.current = null;
        // P5: publish the change set in `finally`, not on the success path. A run the user stopped
        // or that threw has still written every file it got to before that, and those are exactly
        // the writes someone wants to take back — hiding them because the turn did not finish would
        // make "revert this run" unavailable in the only case it matters most.
        setRunChanges(checkpoint.empty ? null : checkpoint.snapshot());
        // Every iteration wrote a ledger row; the totals are stale until they are re-read.
        refreshUsageTotals();
      }
      return;
    }

    // ---- Plain chat (no tools): stream and render as before. ----
    const rec = ctxRef.current!;
    const userNode = rec.node("message", clip(trimmed, 120), { role: "user", model: chosen });
    if (lastNodeRef.current) rec.edge(lastNodeRef.current, userNode, "follows");
    // P7: recall before answering. Awaited, because the block has to be in the request.
    const recalled = useMemory ? await recallContext(trimmed) : [];
    if (recalled.length > 0) recordRecall(userNode, recalled);
    let streamed = "";
    try {
      // The same replay the agent path uses. Sharing it is the fix: this path used to map only
      // {role, content}, so a session that had used agent mode sent its tool results with no
      // tool_call_id and the provider answered 400.
      const history = replayHistory(baseMsgs);
      // Recalled memory goes in its own system message, never spliced into the user's text:
      // the model must be able to tell the difference between what was just said and what was
      // remembered from an earlier conversation.
      const recallMsg = memoryBlock(recalled);
      const systemPromptText = noTools ? (noToolsSystem || NO_TOOLS_SYSTEM) : systemPrompt;
      const exec = await router.generateText(
        {
          model: chosen,
          messages: [
            ...(systemPromptText ? [{ role: "system" as const, content: systemPromptText }] : []),
            ...(recallMsg ? [{ role: "system" as const, content: recallMsg }] : []),
            ...history,
            // The user's own turn, as parts when it carries images — `userContent` returns a plain
            // string otherwise, so an ordinary message is still an ordinary message.
            {
              role: "user" as const,
              content: userContent(trimmed, attachments.map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 }))),
            },
          ],
          onFinish: setFinishReason,
          // P7: per-request params, and the provider's own token report for the meter's tooltip
          // (estimate vs what the request actually cost). The running totals are NOT accumulated
          // here — they are read back from the ledger, which is the same record the Usage screen
          // shows; incrementing both would double-count every turn.
          ...(typeof temperature === "number" ? { temperature } : {}),
          ...(typeof maxTokens === "number" ? { maxTokens } : {}),
          onUsage: setLastUsage,
        },
        { signal: ac.signal },
      );
      for await (const chunk of exec.chunks) {
        streamed += chunk;
        setMsgs((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, content: streamed } : x)));
        // Scroll is handled by the sticky-follow effect on `msgs` — following per token here would
        // also fight the user when they have scrolled up to read.
      }
      const served = exec.served();
      const assistantNode = rec.node("message", clip(streamed, 120) || "(empty)", {
        role: "assistant",
        model: served?.model.nativeId ?? chosen,
        provider: served?.provider.id,
      });
      rec.edge(userNode, assistantNode, "follows");
      lastNodeRef.current = assistantNode;
      setTrace({
        ms: Date.now() - t0,
        provider: served ? registry.getProvider(served.provider.id)?.name : undefined,
        key: served?.key.label,
        model: served?.model.nativeId,
        fallbacks: exec.fallbackChain().map((a) => ({
          provider: registry.getProvider(a.candidate.provider.id)?.name ?? a.candidate.provider.slug,
          key: a.candidate.key.label, cls: a.cls,
        })),
        // **A stream the user stopped is not a success**, and this path reaches here without
        // throwing: the engine's loop returns on an aborted signal rather than raising, so the
        // `catch` below never sees it and the trace printed `✓ 680ms` for a cancelled request. That
        // reads as "the model finished early" — the user's own action attributed to the provider.
        // The partial text is still kept (a partial turn is a turn), but the line says who ended it.
        ...(ac.signal.aborted ? { error: "stopped by you" } : {}),
      });
    } catch (e) {
      if (ac.signal.aborted) {
        setTrace({ ms: Date.now() - t0, fallbacks: [], error: "stopped by you" });
      } else {
        setTrace({ ms: Date.now() - t0, fallbacks: [], error: (e as Error).message });
        setMsgs((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, content: streamed || `⚠ ${(e as Error).message}` } : x)));
      }
    } finally {
      // Flush even on error or stop: a partial turn is still a turn, and the graph is a record
      // of what happened, not of what succeeded.
      void ctxRef.current!.flush();
      // P7: remember whatever was actually said, including a failed or stopped turn — an
      // exchange the user abandoned is still part of the record. Distillation is not awaited.
      if (useMemory) {
        void rememberTurn(ctxRef.current!.sessionId, trimmed, streamed).then(() =>
          distilTurn(ctxRef.current!.sessionId, chosen),
        ).catch(() => { /* memory distillation is best-effort */ });
      }
      setBusy(false);
      abortRef.current = null;
      // The ledger row for this turn is already written (the sink append is awaited inside the
      // router's wrapped stream, before the `for await` above returns), so re-reading now shows
      // this turn's tokens and cost rather than the previous turn's.
      refreshUsageTotals();
    }
  }

  /**
   * A fresh send from the composer, which has already resolved the draft: mentions expanded,
   * attachments read. Nothing to clear here — the composer owns the text it just handed over, and
   * clearing it here too is how the two would drift.
   */
  function send(text: string, attachments: Attachment[], inlined: InlinedText[]) {
    if (busy || !chosen) return;
    void runTurn(text, msgs, attachments, inlined);
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
    void runTurn(point.text, point.prefix);
  }

  /** Commit the inline editor: drop this user turn and everything after it, then resend edited. */
  function submitEdit(i: number) {
    const text = editDraft.trim();
    if (!text) return;
    const prefix = editPoint(msgs, i);
    cancelEdit();
    void runTurn(text, prefix);
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
    setStreamedText("");
    setEditingId(null);
    setEditDraft("");
    setSessionTitle("");
    setSwitcherOpen(false);
    useUi.getState().setResumeTranscript(undefined);
  }

  /**
   * Resume a past session. Its transcript is seeded for context, but the recorder starts *fresh*:
   * reusing the old id would restart the node sequence from 1 and upsert over that session's
   * existing nodes. Same semantics as History's "Continue in Assistant".
   */
  async function openSession(sid: string) {
    if (busy) return;
    setSwitcherOpen(false);
    let resumed: Awaited<ReturnType<typeof resumeSession>>;
    try {
      resumed = await resumeSession(sid);
    } catch {
      return; // an unreadable session is not worth an error wall; leave the transcript as it was
    }
    const rec = startSession();
    ctxRef.current = rec;
    lastNodeRef.current = null;
    setSessionId(rec.sessionId);
    setMsgs(withIds(resumed as Omit<Msg, "id">[]));
    setTrace(null);
    setFinishReason(undefined);
    setEditingId(null);
    // Carry the resumed thread's name into the bar, so it is clear WHICH conversation was opened.
    // The recorder is still a new session, so this label is deliberately transient: editing it
    // writes a title for the continuation.
    titleLoadedFor.current = rec.sessionId;
    setSessionTitle(sessions.find((s) => s.session_id === sid)?.title ?? "");
  }

  function commitTitle() {
    const t = titleDraft.trim();
    setRenaming(false);
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
    const budget = Math.max(256, Math.floor(modelWindow * 0.75));
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Session bar (Phase 4): which conversation this is, what it is called, and how to start or
          switch one without leaving the screen. */}
      <div className="mb-2 flex items-center gap-2">
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
            className="min-w-0 flex-1 rounded border px-2 py-0.5 text-[12px]"
            style={inputStyle}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[12px]"
            style={{ color: sessionTitle ? "var(--text)" : "var(--text-faint)" }}
            onClick={() => {
              setTitleDraft(sessionTitle);
              setRenaming(true);
            }}
            title="Click to name this session"
          >
            {sessionTitle || "untitled session — click to name it"}
          </button>
        )}
        <div className="relative shrink-0">
          <Button
            variant="ghost"
            ariaLabel="Switch session"
            onClick={() => {
              refreshSessions();
              setSwitcherOpen((v) => !v);
            }}
          >
            Sessions ▾
          </Button>
          {switcherOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSwitcherOpen(false)} />
              <div
                className="absolute right-0 top-8 z-50 max-h-80 w-72 overflow-y-auto rounded border p-1 shadow-lg"
                style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
                role="menu"
                aria-label="Recent sessions"
              >
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
        <Button variant="ghost" onClick={newChat} disabled={busy} ariaLabel="Start a new chat">
          ＋ New
        </Button>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <ModelPicker modality="text" value={chosen} onChange={setModel} openNonce={pickerNonce} />
        <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{chosen || "—"}</span>
        {/* The switches are under the title now (AssistantScreen) — this row is per-request
            only: what this message is sent to. */}
      </div>

      {agentMode && (
        <div className="mb-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px]" style={{ color: "var(--text-dim)" }}>root</span>
            <input
              value={root}
              onChange={(e) => onRootChange(e.target.value)}
              placeholder="/absolute/path the tools are confined to"
              className={`${inputCls} flex-1`}
              style={rootError ? { ...inputStyle, borderColor: "var(--danger)" } : inputStyle}
              aria-invalid={rootError ? true : undefined}
            />
          </div>
          {rootError ? (
            <p className="mt-1 text-[11px]" style={{ color: "var(--danger)" }}>{rootError}</p>
          ) : root.trim() && root.trim() === defaultRoot ? (
            // Say it is the default. A filled field the user did not fill is otherwise
            // indistinguishable from one they did, and the agent will write there.
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
              default workspace — tools are confined to this folder
            </p>
          ) : null}
        </div>
      )}
      {agentMode && policy && (
        // `--text-dim`, not `--text-faint`: this line states the actual limits a run is held to, and
        // a reviewer reading a screenshot of the screen called it "nearly illegible" (2026-10-01) —
        // a policy nobody can read is not a policy that was disclosed.
        <div className="mb-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
          <button className="underline decoration-dotted" onClick={() => setShowPolicy((v) => !v)}>
            sandbox · {policy.programs.length} programs · git without push/pull/fetch/clone · capped at {policy.max_command_ms}ms · {policy.max_output_bytes / 1024}KB out
          </button>
          {showPolicy && (
            <div className="mono mt-1 break-all">{policy.programs.join(", ")}</div>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onListScroll}
          className="h-full overflow-y-auto rounded-md border p-3"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
        {msgs.length === 0 && !busy && (
          <EmptyState title="Try any routed model. Text streams through the router — rotation and failover are silent; the line below the answer shows what actually happened." />
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
                <AgentLive raw={streamedText} items={agentItems} />
              ) : (
                // A turn that only requested tools has no prose of its own. Rendering the
                // empty-content placeholder there is what left a bare "…" under a tool call —
                // indistinguishable from a model that answered with nothing.
                m.content.trim() ? <AssistantContent raw={m.content} /> : null
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
        {!atBottom && (
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
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
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
            className="mono w-16 rounded border px-1 py-0.5 text-[11px]"
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
            className="mono w-20 rounded border px-1 py-0.5 text-[11px]"
            style={inputStyle}
          />
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
            user cannot check: the numbers say how full the window is and the bar makes it skimmable. */}
        <span
          className="ml-auto flex items-center gap-1.5"
          title={
            `${currentPromptTokens.toLocaleString()} estimated prompt tokens of ${modelWindow.toLocaleString()} ` +
            `window for ${chosen || "the default model"}` +
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
                // stays zero rather than claiming a percent that is not there.
                width: currentPromptTokens === 0 ? "0%" : `${Math.max(1, Math.round(contextUsedRatio * 100))}%`,
                background:
                  contextUsedRatio > 0.9 ? "var(--danger)" : contextUsedRatio > 0.7 ? "var(--warn)" : "var(--success)",
              }}
            />
          </span>
          <span className="mono">
            {formatTokens(currentPromptTokens)} / {formatTokens(modelWindow)}
          </span>
        </span>
        {/* Session totals from the ledger. "Σ" and the tooltip say *this app's whole ledger*, not
            just this conversation — the in-memory ledger has no session column to scope by. */}
        <span
          className="mono"
          title={
            "Totals for every request this app has routed (the ledger's in-memory window), not only this conversation" +
            (sessionCost.unpriced > 0
              ? ` · ${sessionCost.unpriced} of ${sessionCost.rows} used a model with no published price, so the cost is a lower bound`
              : "")
          }
        >
          Σ {formatTokens(sessionTokensIn)} in · {formatTokens(sessionTokensOut)} out · {costLabel}
        </span>
      </div>


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
          onStop={() => abortRef.current?.abort()}
          onClear={newChat}
          onOpenModelPicker={() => setPickerNonce((n) => n + 1)}
          onSwitchToImageTab={onSwitchToImageTab}
          onCompact={() => void compactNow()}
          listFiles={mentionHost ? listWorkspaceFiles : null}
          readFile={mentionHost ? readWorkspaceFile : null}
          onNotice={setNotice}
          onDraftChange={setDraftText}
          sendDisabled={!chosen || (agentMode && (!root.trim() || !!rootError))}
        />
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

/** Live view of an in-flight agent turn: streamed text plus this turn's calls, grouped as they run. */
function AgentLive({ raw, items }: { raw: string; items: AgentItem[] }) {
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
      <Markdown source={raw || "…"} />
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
    <label className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
      <span>approval</span>
      <select
        value={mode}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ApprovalMode)}
        aria-label="How agent tool calls are approved"
        data-testid="approval-mode"
        className="mono rounded border px-1 py-0.5 text-[11px] disabled:opacity-40"
        style={inputStyle}
      >
        {APPROVAL_MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <span style={{ color: "var(--text-faint)" }} title={current.hint}>
        {current.hint}
      </span>
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
      const res = await router.generateImage({ model: chosen, prompt: prompt.trim() }, { signal: ac.signal });
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
