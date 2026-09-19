/**
 * Playground — a router diagnostic console, not a chatbot (UI_UX_PLAN.md §3): model picker,
 * streaming assistant text, a STOP button (cancellation, spec req. 9), and after every
 * request the calm summary line (`✓ 421ms · OpenRouter · key-03` / `↻ 1 fallback`) with an
 * expandable per-attempt route trace. Acceptance criterion 4: text + image end-to-end.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { catalog, registry, router } from "../store";
import { fetchImageUrl } from "../ipc-client";
import { useUi } from "../ui-state";
import { Button, EmptyState, Modal, inputCls, inputStyle } from "../components/atoms";
import { parseAssistantStream, type ToolSegment } from "../lib/assistant-stream";
import { runAgentLoop, AGENT_TOOLS, createTauriToolHost, fetchToolsPolicy, type ToolsPolicy, type AgentEvent } from "../lib/tools";
import type { ChatMessage, ToolCall } from "@aiprovider/router-core";
import { startSession, type Recorder } from "../lib/context/recorder";

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant turn that requested tool calls, so the next turn can replay them. */
  tool_calls?: unknown;
  /** Set on a tool result turn, linking it to its originating call. */
  tool_call_id?: string;
}

/**
 * Agent-mode system prompt. Unlike the no-tools guard (which suppresses tool-call markup),
 * this one tells the model it DOES have tools and how to use them — confined to the workspace
 * root the user sets. It is deliberately terse; the sandbox, not the prompt, is the enforcement.
 */
const AGENT_SYSTEM =
  "You are an agent inside AI-Provider Router. You have file and shell tools confined to the " +
  "workspace root the user specified. Complete the task by calling tools: read_file and " +
  "list_dir to inspect, write_file to create or edit, run_command for allowlisted commands. " +
  "Prefer inspecting before editing. Never ask the user to run a command — call the tool. " +
  "Stop calling tools once the task is done and give a concise final answer.";

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
 * Record one agent turn into the context graph: the user message, each following message, and
 * for every tool call a skill node plus the artifact its result produced.
 *
 * A tool result is recorded as an artifact because that is what it is to the model — context it
 * was handed, not something it said. That distinction is the whole reason the graph has two node
 * kinds instead of one.
 */
function recordAgentTurn(rec: Recorder, userText: string, messages: ChatMessage[], model: string): string {
  const user = rec.node("message", clip(userText, 120), { role: "user", model });
  let prev: string | null = null;
  const skillByCall = new Map<string, string>();

  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "tool") {
      const artifact = rec.node("artifact", clip(content, 80), { tool_call_id: m.tool_call_id });
      const skill = m.tool_call_id ? skillByCall.get(m.tool_call_id) : undefined;
      rec.edge(skill ?? prev ?? user, artifact, "produced");
      continue;
    }
    const node = rec.node("message", clip(content, 120), { role: m.role, model });
    rec.edge(prev ?? user, node, "follows");
    // `tool_calls` is `unknown` in the core's message type: the wire shape varies by dialect
    // and the core does not commit to one. The agent loop normalises to OpenAI's shape.
    const calls = (m.tool_calls as ToolCall[] | undefined) ?? [];
    for (const c of calls) {
      const skill = rec.node("skill", c.name ?? "tool");
      rec.edge(node, skill, "used");
      if (c.id) skillByCall.set(c.id, skill);
    }
    prev = node;
  }
  return prev ?? user;
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
 * Guard against the mercury-2.5 failure: Playground declares no tools, and a model handed a
 * toolless request will sometimes invent tool-call markup from its agentic training data.
 * Saying so outright in the system turn stops it at the source. Off = raw model behaviour,
 * which is what you want when probing a provider's own prompting.
 */
const NO_TOOLS_SYSTEM =
  "You are answering inside AI-Provider Router's Playground — a plain chat console. " +
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

export function PlaygroundScreen() {
  const tick = useUi((s) => s.tick);
  const [tab, setTab] = useState<"text" | "image">("text");
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">Playground</h1>
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
      {tab === "text" ? <Chat key={tick} /> : <ImageBox />}
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
          Playground has no tool layer — this was model output, not a real function call.
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

function Chat() {
  const [model, setModel] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [noTools, setNoTools] = useState(true);
  const [agentMode, setAgentMode] = useState(false);
  const [root, setRoot] = useState("");
  const [policy, setPolicy] = useState<ToolsPolicy | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ call: ToolCall; args: Record<string, unknown>; resolve: (ok: boolean) => void } | null>(null);
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  const [streamedText, setStreamedText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // P4: the context graph is recorded as the conversation happens. One recorder per mounted
  // Playground; the last recorded node carries the thread forward turn to turn.
  const ctxRef = useRef<Recorder | null>(null);
  if (!ctxRef.current) ctxRef.current = startSession();
  const lastNodeRef = useRef<string | null>(null);

  const def = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.text ?? "";
  const chosen = model || def;

  // Surface the live sandbox allowlist once when agent mode is first enabled.
  const onToggleAgent = (next: boolean) => {
    setAgentMode(next);
    if (next && !policy) fetchToolsPolicy().then(setPolicy).catch(() => setPolicy(null));
  };

  // Per-call confirmation gate: suspend the loop until the user allows or denies.
  const confirmGate = useCallback(
    (call: ToolCall, args: Record<string, unknown>) =>
      new Promise<boolean>((resolve) => setPendingConfirm({ call, args, resolve })),
    [],
  );

  const handleAgentEvent = useCallback((ev: AgentEvent) => {
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
      setMsgs((m) => [...m, { role: "assistant", content: "" }]);
      setStreamedText("");
      setAgentItems([]);
      const host = createTauriToolHost(root.trim());
      // Replay prior turns verbatim — including assistant turns that carry tool_calls and the
      // tool-result turns that answer them — so the model keeps its chaining context.
      const history: ChatMessage[] = msgs
        .filter((m) => m.content.trim().length > 0 || (m.role === "assistant" && m.tool_calls))
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })) as ChatMessage[];
      try {
        const { text: finalText, messages } = await runAgentLoop({
          model: chosen,
          messages: history,
          system: AGENT_SYSTEM,
          registry: AGENT_TOOLS,
          generate: (req, opts) => router.generateText(req, opts),
          host,
          confirm: confirmGate,
          onEvent: handleAgentEvent,
          signal: ac.signal,
        });
        setMsgs(
          messages.map((m) => ({
            role: m.role as Msg["role"],
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
        );
        void finalText;
        lastNodeRef.current = recordAgentTurn(ctxRef.current!, text, messages, chosen);
        void ctxRef.current!.flush();
        setTrace({ ms: Date.now() - t0, fallbacks: [], provider: "agent" });
      } catch (e) {
        if (ac.signal.aborted) {
          setTrace({ ms: Date.now() - t0, fallbacks: [], error: "stopped by you" });
        } else {
          setTrace({ ms: Date.now() - t0, fallbacks: [], error: (e as Error).message });
        }
      } finally {
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
    let streamed = "";
    try {
      // A stopped or failed turn leaves an empty assistant bubble behind; replaying it would
      // send { role: "assistant", content: "" }, which most providers reject with 400.
      const history = msgs
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));
      const exec = await router.generateText(
        {
          model: chosen,
          messages: [
            ...(noTools ? [{ role: "system" as const, content: NO_TOOLS_SYSTEM }] : []),
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
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
          <input type="checkbox" checked={noTools} onChange={(e) => setNoTools(e.target.checked)} disabled={agentMode} />
          tell the model it has no tools
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
          <input type="checkbox" checked={agentMode} onChange={(e) => onToggleAgent(e.target.checked)} />
          agent mode
        </label>
      </div>

      {agentMode && (
        <div className="mb-2 flex items-center gap-2">
          <span className="shrink-0 text-[11px]" style={{ color: "var(--text-dim)" }}>root</span>
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="/absolute/path the tools are confined to"
            className={`${inputCls} flex-1`}
            style={inputStyle}
          />
        </div>
      )}
      {agentMode && policy && (
        <div className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          sandbox: {policy.programs.slice(0, 10).join(", ")}… · git without push/pull/fetch/clone · capped at {policy.max_command_ms}ms · {policy.max_output_bytes / 1024}KB out
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
          <Button variant="primary" disabled={!chosen || (agentMode && !root.trim())} onClick={() => void send()}>Send</Button>
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
  const preview = content.replace(/\n/g, " ").slice(0, 70);
  return (
    <div className="rounded border px-2.5 py-1.5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      <button className="mono text-[11px]" style={{ color: "var(--text-dim)" }} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} tool result{open ? "" : ` · ${preview}${content.length > 70 ? "…" : ""}`}
      </button>
      {open && (
        <pre className="mono mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px]" style={{ color: "var(--text)" }}>{content}</pre>
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
