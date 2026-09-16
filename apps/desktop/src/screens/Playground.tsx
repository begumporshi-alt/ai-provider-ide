/**
 * Playground — a router diagnostic console, not a chatbot (UI_UX_PLAN.md §3): model picker,
 * streaming assistant text, a STOP button (cancellation, spec req. 9), and after every
 * request the calm summary line (`✓ 421ms · OpenRouter · key-03` / `↻ 1 fallback`) with an
 * expandable per-attempt route trace. Acceptance criterion 4: text + image end-to-end.
 */
import { useMemo, useRef, useState } from "react";
import { catalog, registry, router } from "../store";
import { fetchImageUrl } from "../ipc-client";
import { useUi } from "../ui-state";
import { Button, EmptyState, inputCls, inputStyle } from "../components/atoms";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

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

function Chat() {
  const [model, setModel] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const def = (router.settings as typeof router.settings & { defaults?: Record<string, string> }).defaults?.text ?? "";
  const chosen = model || def;

  async function send() {
    const text = input.trim();
    if (!text || busy || !chosen) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setBusy(true);
    setTrace(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = Date.now();
    let streamed = "";
    try {
      const exec = await router.generateText(
        { model: chosen, messages: [...msgs.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: text }] },
        { signal: ac.signal },
      );
      for await (const chunk of exec.chunks) {
        streamed += chunk;
        setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: streamed } : x)));
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      }
      const served = exec.served();
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
      </div>
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
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: m.role === "user" ? "var(--info)" : "var(--success)" }}>
              {m.role}
            </div>
            <div className="whitespace-pre-wrap text-[13px]" style={{ color: "var(--text)" }}>{m.content}</div>
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
            {trace.provider && <span style={{ color: "var(--text-dim)" }}>· {trace.provider}{trace.key ? ` · ${trace.key}` : ""}</span>}
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
          placeholder="Send a message through the router… (Enter to send)"
          className={`${inputCls} resize-none`}
          style={inputStyle}
        />
        {busy ? (
          <Button variant="danger" onClick={() => abortRef.current?.abort()}>■ Stop</Button>
        ) : (
          <Button variant="primary" disabled={!chosen} onClick={() => void send()}>Send</Button>
        )}
      </div>
    </div>
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
