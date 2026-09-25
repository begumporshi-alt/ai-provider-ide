/**
 * Assistant — a router console for talking to any routed model (UI_UX_PLAN.md §3): model picker,
 * streaming assistant text, a STOP button (cancellation, spec req. 9), and after every
 * request the calm summary line (`✓ 421ms · OpenRouter · key-03` / `↻ 1 fallback`) with an
 * expandable per-attempt route trace. Acceptance criterion 4: text + image end-to-end.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { catalog, listSkills, registry, router } from "../store";
import { fetchImageUrl } from "../ipc-client";
import { invoke } from "@tauri-apps/api/core";
import { fetchAdmin } from "../lib/gateway-client";
import { useUi } from "../ui-state";
import { Button, EmptyState, Modal, inputCls, inputStyle } from "../components/atoms";
import { parseAssistantStream, type ToolSegment } from "../lib/assistant-stream";
import { runAgentLoop, AGENT_TOOLS, createTauriToolHost, fetchToolsPolicy, fetchDefaultRoot, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP, type ToolsPolicy, type AgentEvent } from "../lib/tools";
import { toolCallName } from "../lib/tools/wire";
import type { ChatMessage, ToolCall } from "@aiprovider/router-core";
import { activeSession, type Recorder } from "../lib/context/recorder";
import { endRun, newRunId, recordStep, registerAbort, startRun } from "../lib/agent/orchestrator";
import {
  distilTurn, memoryBlock, recallContext, recordRecall, rememberTurn,
} from "../lib/memory/engine";

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant turn that requested tool calls, so the next turn can replay them. */
  tool_calls?: unknown;
  /** Set on a tool result turn, linking it to its originating call. */
  tool_call_id?: string;
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
    .filter((m) => m.content.trim().length > 0 || (m.role === "assistant" && m.tool_calls))
    .map((m) => ({
      role: m.role,
      content: m.content,
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
function agentSystem(root: string): string {
  const r = root.trim();
  if (!r) return AGENT_SYSTEM;
  return (
    AGENT_SYSTEM +
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

/** Graph labels are identifiers, not content — a 400-character node is unreadable on canvas. */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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
    const node = rec.node("message", clip(content, 120), { role: m.role, model });
    rec.edge(prev, node, "follows");
    // `tool_calls` is `unknown` in the core's message type: the wire shape varies by dialect
    // and the core does not commit to one. A stored transcript may hold either the flat internal
    // shape or OpenAI's nested one (the agent loop writes the latter), so the name is read
    // tolerantly rather than assuming whichever shape the current writer produces.
    const calls = (m.tool_calls as ToolCall[] | undefined) ?? [];
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
  // P7: memory is on by default but switchable. Recalling and distilling on every turn changes
  // what the model sees and costs a second call, so it has to be possible to turn it off.
  const [useMemory, setUseMemory] = useState(true);
  // The tool-step ceiling. It is a setting rather than a constant because it is the one knob
  // that trades cost against thoroughness per run: a one-shot question wants 1, a real refactor
  // across a repo doesn't finish in 8.
  const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
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
    () => saveAssistantSettings({ root, agentMode, useMemory, noTools, maxIterations }),
    [root, agentMode, useMemory, noTools, maxIterations],
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
  }, [hydrated, agentMode, useMemory, noTools, maxIterations]);

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
    <div className="mx-auto flex h-full max-w-3xl flex-col">
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
      </div>
      {/* No `key={tick}` here. Keying on the tick remounted Chat on every store bump, which
          wiped the conversation mid-session — a settings save took the transcript with it.
          Re-rendering is enough: the skills block re-reads on `tick` through its own effect,
          and the model list comes from the store. */}
      {tab === "text" ? (
        <Chat
          noTools={noTools}
          agentMode={agentMode}
          useMemory={useMemory}
          maxIterations={maxIterations}
          root={root}
          rootError={rootError}
          defaultRoot={defaultRoot}
          onRootChange={setRoot}
        />
      ) : (
        <ImageBox />
      )}
    </div>
  );
}

function ModelPicker({ value, onChange, modality }: { value: string; onChange: (v: string) => void; modality: "text" | "image" }) {
  const models = useMemo(() => {
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    return catalog.forModality(modality).map((m) => `${slugOf(m.providerId)}/${m.nativeId}`);
  }, [modality, registry.listProviders().length]);
  if (!models.length) return <span className="text-[12px] text-zinc-500">no {modality} models — connect a provider</span>;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded border px-2 py-1 text-[12px]" style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}>
      {!models.includes(value) && <option value={value}>{value || "pick a model…"}</option>}
      {models.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
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
          <div key={i} className="whitespace-pre-wrap text-[13px]" style={{ color: "var(--text)" }}>
            {s.text}
          </div>
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
  root,
  rootError,
  defaultRoot,
  onRootChange,
}: {
  noTools: boolean;
  agentMode: boolean;
  useMemory: boolean;
  maxIterations: number;
  root: string;
  rootError: string | null;
  defaultRoot: string | null;
  onRootChange: (v: string) => void;
}) {
  const tick = useUi((s) => s.tick);
  const [model, setModel] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [policy, setPolicy] = useState<ToolsPolicy | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ call: ToolCall; args: Record<string, unknown>; resolve: (ok: boolean) => void } | null>(null);
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  const [streamedText, setStreamedText] = useState("");
  const [showPolicy, setShowPolicy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // P4: the context graph is recorded as the conversation happens. `activeSession` rather than
  // `startSession` so any remount — switching tabs, for one — reuses the open session instead of
  // fragmenting one conversation into unrelated threads.
  const ctxRef = useRef<Recorder | null>(null);
  if (!ctxRef.current) ctxRef.current = activeSession();
  const lastNodeRef = useRef<string | null>(null);
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

  // Surface the live sandbox allowlist once when agent mode is first enabled.
  useEffect(() => {
    if (!agentMode || policy) return;
    void fetchToolsPolicy().then(setPolicy).catch(() => setPolicy(null));
  }, [agentMode, policy]);

  // Follow the turn as it arrives. The plain-chat path scrolls itself while streaming, but agent
  // mode grows the transcript from tool events too and used to leave the newest line offscreen.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [streamedText, agentItems]);

  const def = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.text ?? "";
  const chosen = model || def;

  // Per-call confirmation gate: suspend the loop until the user allows or denies.
  const confirmGate = useCallback(
    (call: ToolCall, args: Record<string, unknown>) =>
      new Promise<boolean>((resolve) => setPendingConfirm({ call, args, resolve })),
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
        const denied = ev.result.includes("denied");
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
            copy[i] = { ...copy[i], status: ev.result.includes("denied") ? "denied" : ev.ok ? "ok" : "error", result: ev.result };
            break;
          }
        }
        return copy;
      });
    }
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy || !chosen) return;
    setInput("");
    setBusy(true);
    setTrace(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = Date.now();

    // ---- Agent mode: run the loop, execute tools through the sandbox, confirm each call. ----
    if (agentMode) {
      if (!root.trim()) {
        setTrace({ ms: 0, fallbacks: [], error: "set a workspace root before using agent mode" });
        setBusy(false);
        abortRef.current = null;
        return;
      }
      // Mirror the new turn into `msgs` so the UI shows it; `history` is what we actually send,
      // so it must include this turn too — building it from the stale `msgs` closure (as the
      // non-agent branch does NOT do) was a real bug: the model never saw the user's prompt.
      setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
      setStreamedText("");
      setAgentItems([]);
      // P6: open the run record before the first call, and register this controller so the
      // orchestrator dashboard can stop the run even though it did not start it.
      const runId = newRunId();
      runIdRef.current = runId;
      iterationsRef.current = 0;
      startRun({ runId, sessionId: ctxRef.current?.sessionId ?? null, model: chosen, prompt: text });
      registerAbort(runId, ac);
      const host = createTauriToolHost(root.trim());
      // The user's node is created here rather than inside recordAgentTurn, because the recall
      // edges need an anchor before the run starts. Same shape as the plain-chat branch below:
      // one node per turn, reused by everything that needs to point at it.
      const rec = ctxRef.current!;
      const userNode = rec.node("message", clip(text, 120), { role: "user", model: chosen });
      if (lastNodeRef.current) rec.edge(lastNodeRef.current, userNode, "follows");
      // P7: recall before the run so the agent starts from what is already known. Awaited,
      // because the recalled block has to be in the system prompt before the first call.
      const recalled = useMemory ? await recallContext(text) : [];
      if (recalled.length > 0) recordRecall(userNode, recalled);
      // Replay prior turns verbatim — including assistant turns that carry tool_calls and the
      // tool-result turns that answer them — so the model keeps its chaining context.
      const history: ChatMessage[] = [...replayHistory(msgs), { role: "user", content: text }];
      try {
        const { text: finalText, messages } = await runAgentLoop({
          model: chosen,
          messages: history,
          system: agentSystem(root) + skillsBlock + (memoryBlock(recalled) ? `\n\n${memoryBlock(recalled)}` : ""),
          registry: AGENT_TOOLS,
          // Tier 2: when this request has to drop context, the dropped turns are summarized
          // rather than discarded. One summarizer per run, built against the chosen model.
          generate: (req, opts) =>
            router.generateText(req, { ...opts, summarize: createSummarizer(chosen) }),
          host,
          // Clamped again at the call site: this is the number that actually bounds the spend,
          // and it is reached from a setting that a future build may have written differently.
          maxIterations: clampIterations(maxIterations),
          confirm: confirmGate,
          onEvent: handleAgentEvent,
          signal: ac.signal,
        });
        // The loop terminates the moment it sees an answer with no tool calls, but it does NOT
        // append that final assistant turn — `text` is the answer and `messages` is what came
        // before. Append it so the UI and the context graph both see the closing line.
        const fullMessages: ChatMessage[] = [...messages, { role: "assistant", content: finalText }];
        setMsgs(
          fullMessages.map((m) => ({
            role: m.role as Msg["role"],
            content: m.content,
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
          void rememberTurn(ctxRef.current!.sessionId, text, finalText).then(() =>
            distilTurn(ctxRef.current!.sessionId, chosen),
          );
        }
        endRun(runId, "ok", iterationsRef.current);
        setTrace({ ms: Date.now() - t0, fallbacks: [], provider: "agent" });
      } catch (e) {
        if (ac.signal.aborted) {
          endRun(runId, "stopped", iterationsRef.current);
          setTrace({ ms: Date.now() - t0, fallbacks: [], error: "stopped by you" });
        } else {
          endRun(runId, "error", iterationsRef.current, (e as Error).message);
          setTrace({ ms: Date.now() - t0, fallbacks: [], error: (e as Error).message });
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
      }
      return;
    }

    // ---- Plain chat (no tools): stream and render as before. ----
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    const rec = ctxRef.current!;
    const userNode = rec.node("message", clip(text, 120), { role: "user", model: chosen });
    if (lastNodeRef.current) rec.edge(lastNodeRef.current, userNode, "follows");
    // P7: recall before answering. Awaited, because the block has to be in the request.
    const recalled = useMemory ? await recallContext(text) : [];
    if (recalled.length > 0) recordRecall(userNode, recalled);
    let streamed = "";
    try {
      // The same replay the agent path uses. Sharing it is the fix: this path used to map only
      // {role, content}, so a session that had used agent mode sent its tool results with no
      // tool_call_id and the provider answered 400.
      const history = replayHistory(msgs);
      // Recalled memory goes in its own system message, never spliced into the user's text:
      // the model must be able to tell the difference between what was just said and what was
      // remembered from an earlier conversation.
      const recallMsg = memoryBlock(recalled);
      const exec = await router.generateText(
        {
          model: chosen,
          messages: [
            ...(noTools ? [{ role: "system" as const, content: NO_TOOLS_SYSTEM }] : []),
            ...(recallMsg ? [{ role: "system" as const, content: recallMsg }] : []),
            ...history,
            { role: "user" as const, content: text },
          ],
        },
        { signal: ac.signal },
      );
      for await (const chunk of exec.chunks) {
        streamed += chunk;
        setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: streamed } : x)));
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
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
      });
    } catch (e) {
      if (ac.signal.aborted) {
        setTrace({ ms: Date.now() - t0, fallbacks: [], error: "stopped by you" });
      } else {
        setTrace({ ms: Date.now() - t0, fallbacks: [], error: (e as Error).message });
        setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: streamed || `⚠ ${(e as Error).message}` } : x)));
      }
    } finally {
      // Flush even on error or stop: a partial turn is still a turn, and the graph is a record
      // of what happened, not of what succeeded.
      void ctxRef.current!.flush();
      // P7: remember whatever was actually said, including a failed or stopped turn — an
      // exchange the user abandoned is still part of the record. Distillation is not awaited.
      if (useMemory) {
        void rememberTurn(ctxRef.current!.sessionId, text, streamed).then(() =>
          distilTurn(ctxRef.current!.sessionId, chosen),
        );
      }
      setBusy(false);
      abortRef.current = null;
    }
  }

  const ok = trace && !trace.error && trace.fallbacks.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center gap-2">
        <ModelPicker modality="text" value={chosen} onChange={setModel} />
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
        <div className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          <button className="underline decoration-dotted" onClick={() => setShowPolicy((v) => !v)}>
            sandbox · {policy.programs.length} programs · git without push/pull/fetch/clone · capped at {policy.max_command_ms}ms · {policy.max_output_bytes / 1024}KB out
          </button>
          {showPolicy && (
            <div className="mono mt-1 break-all">{policy.programs.join(", ")}</div>
          )}
        </div>
      )}

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border p-3"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        {msgs.length === 0 && !busy && (
          <EmptyState title="Try any routed model. Text streams through the router — rotation and failover are silent; the line below the answer shows what actually happened." />
        )}
        {msgs.map((m, i) => (
          <div key={i} className="mb-3">
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: m.role === "user" ? "var(--info)" : m.role === "tool" ? "var(--warn)" : "var(--success)" }}>
              {m.role}
            </div>
            {m.role === "tool" ? (
              <ToolResultBubble content={m.content} />
            ) : m.role === "assistant" ? (
              agentMode && i === msgs.length - 1 && busy ? (
                <AgentLive raw={streamedText} items={agentItems} />
              ) : (
                <AssistantContent raw={m.content} />
              )
            ) : (
              <div className="whitespace-pre-wrap text-[13px]" style={{ color: "var(--text)" }}>{m.content}</div>
            )}
          </div>
        ))}
      </div>
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
      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={agentMode ? "Describe a task for the agent… (Enter to send)" : "Send a message through the router… (Enter to send)"}
          className={`${inputCls} resize-none`}
          style={inputStyle}
        />
        {busy ? (
          <Button variant="danger" onClick={() => abortRef.current?.abort()}>■ Stop</Button>
        ) : (
          <Button variant="primary" disabled={!chosen || (agentMode && (!root.trim() || !!rootError))} onClick={() => void send()}>Send</Button>
        )}
      </div>

      {pendingConfirm && (
        <ConfirmModal
          name={pendingConfirm.call.name ?? "?"}
          args={pendingConfirm.args}
          onResolve={(allow) => {
            pendingConfirm.resolve(allow);
            setPendingConfirm(null);
          }}
        />
      )}
    </div>
  );
}

/** Compact, collapsible view of a tool-result turn persisted in the transcript. */
function ToolResultBubble({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  // An empty result used to render as "tool result · " with nothing after it — indistinguishable
  // from a collapsed result the user simply had not opened, and the reason a run could end with
  // "the tool results came back empty" and no clue why. Say it outright.
  const empty = content.trim().length === 0;
  const preview = content.replace(/\n/g, " ").slice(0, 70);
  return (
    <div className="rounded border px-2.5 py-1.5" style={{ borderColor: empty ? "var(--warn)" : "var(--border)", background: "var(--surface-2)" }}>
      <button className="mono text-[11px]" style={{ color: "var(--text-dim)" }} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} tool result
        {open ? "" : ` · ${empty ? "(no output)" : `${preview}${content.length > 70 ? "…" : ""}`}`}
      </button>
      {open && (
        <pre className="mono mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px]" style={{ color: "var(--text)" }}>
          {empty ? "(no output — the tool returned nothing, and said nothing about why)" : content}
        </pre>
      )}
    </div>
  );
}

/** Live view of an in-flight agent turn: streamed text plus the tool calls as they run. */
function AgentLive({ raw, items }: { raw: string; items: AgentItem[] }) {
  const colorOf = (s: AgentItem["status"]) =>
    s === "calling" ? "var(--info)" : s === "denied" ? "var(--warn)" : s === "ok" ? "var(--success)" : "var(--danger)";
  return (
    <>
      <div className="whitespace-pre-wrap text-[13px]" style={{ color: "var(--text)" }}>
        {raw || <span style={{ color: "var(--text-faint)" }}>…</span>}
      </div>
      {items.map((it, i) => (
        <div key={i} className="mt-2 rounded border px-2.5 py-2" style={{ borderColor: colorOf(it.status), background: "var(--surface-2)" }}>
          <div className="mono text-[11px]" style={{ color: "var(--text)" }}>
            {it.status === "calling" ? "▶ running" : it.status === "denied" ? "✕ denied" : it.status === "ok" ? "✓ ran" : "⚠ error"} · {it.name}
          </div>
          {Object.entries(it.args).map(([k, v]) => (
            <div key={k} className="mono mt-1 break-all text-[11px]" style={{ color: "var(--text-dim)" }}>
              <span style={{ color: "var(--text-faint)" }}>{k}: </span>
              {typeof v === "string" ? (v.length > 300 ? `${v.slice(0, 300)}…` : v) : JSON.stringify(v)}
            </div>
          ))}
          {it.result !== undefined && (
            <pre className="mono mt-1 max-h-52 overflow-auto whitespace-pre-wrap text-[11px]" style={{ color: "var(--text-dim)" }}>{it.result}</pre>
          )}
        </div>
      ))}
    </>
  );
}

/** Per-call confirmation gate. The agent loop awaits the user's choice before executing. */
function ConfirmModal({ name, args, onResolve }: { name: string; args: Record<string, unknown>; onResolve: (ok: boolean) => void }) {
  return (
    <Modal title="Allow this tool call?" onClose={() => onResolve(false)}>
      <div className="mono mb-2 text-[12px]" style={{ color: "var(--warn)" }}>{name}</div>
      <pre className="mono mb-3 max-h-56 overflow-auto rounded border p-2 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--text-dim)", background: "var(--surface-2)" }}>{JSON.stringify(args, null, 2)}</pre>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onResolve(false)}>Deny</Button>
        <Button variant="primary" onClick={() => onResolve(true)}>Allow</Button>
      </div>
    </Modal>
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
  const def = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.image ?? "";
  const chosen = model || def;

  async function go() {
    if (!prompt.trim() || !chosen || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setShown(null);
    setFetchNote(null);
    const t0 = Date.now();
    setProgress("Queued at the router…");
    const timer = window.setTimeout(() => setProgress("Waiting for the provider…"), 1500);
    try {
      const res = await router.generateImage({ model: chosen, prompt: prompt.trim() });
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
      setError((e as Error).message);
    } finally {
      clearTimeout(timer);
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
        {busy ? <Button variant="danger" disabled>Generating…</Button> : <Button variant="primary" disabled={!chosen || !prompt.trim()} onClick={() => void go()}>Generate</Button>}
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
