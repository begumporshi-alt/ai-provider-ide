/**
 * Compare (2026-10-06): one prompt, several models, side by side.
 *
 * The additive feature the audit roadmap named. It exists because model choice is an empirical
 * question — which model answers *this* prompt well, how fast, at what cost — and the only way
 * the app could answer it before was to ask each model in a separate chat and eyeball four
 * transcripts.
 *
 * Serving reuses the existing path with no new backend surface: every lane is a `gatewayGenerate`
 * call (the same ingress chat uses), driven by the pure lane runner (`lib/compare/lane.ts`).
 * Lanes run concurrently and own their state — none of the Assistant's singletons (transcript,
 * graph recorder, memory, busy gate) are touched, which is what makes parallel lanes safe.
 * Nothing is persisted: a compare run is an experiment, not a conversation.
 */
import { useMemo, useRef, useState } from "react";
import { estimateCostMicros } from "@aiprovider/router-core";
import { catalog, registry } from "../store";
import { gatewayGenerate } from "../lib/gateway-turn";
import { runCompareLane, type LaneState } from "../lib/compare/lane";
import { selectableModels } from "../lib/models/selectable";
import { usd } from "../lib/format";
import { Markdown } from "../components/Markdown";
import { Button, inputCls, inputStyle } from "../components/atoms";
import { useUi } from "../ui-state";

const MAX_LANES = 4;

interface CompareLane {
  id: string;
  model: string;
}

let laneSeq = 0;
function newLane(model = ""): CompareLane {
  laneSeq += 1;
  return { id: `lane-${laneSeq}`, model };
}

export function CompareScreen() {
  const tick = useUi((s) => s.tick);
  const [prompt, setPrompt] = useState("");
  const [lanes, setLanes] = useState<CompareLane[]>(() => [newLane(), newLane()]);
  const [results, setResults] = useState<Record<string, LaneState>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllers = useRef<AbortController[]>([]);

  const options = useMemo(() => {
    void tick;
    const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
    const isEnabled = (pid: string) => registry.getProvider(pid)?.status === "enabled";
    return selectableModels(catalog.forModality("text"), catalog.aliases, slugOf, isEnabled);
  }, [tick]);

  const stop = () => {
    for (const c of controllers.current) c.abort();
  };

  const run = () => {
    const chosen = lanes.filter((l) => l.model);
    if (running || !prompt.trim() || chosen.length === 0) {
      setError(
        chosen.length === 0
          ? "Pick at least one model to compare."
          : "Type a prompt first — the same text goes to every lane.",
      );
      return;
    }
    setError(null);
    const controller = new AbortController();
    controllers.current = [controller];
    const initial: Record<string, LaneState> = {};
    for (const lane of chosen) initial[lane.id] = { status: "running", text: "", firstByteMs: null, totalMs: null, usage: null, served: null, error: null };
    setResults(initial);
    setRunning(true);
    // Concurrent lanes, one promise each; the last settle clears the busy flag. Per-lane `onUpdate`
    // writes only that lane's slot, so lanes cannot clobber each other's state.
    void Promise.all(
      chosen.map((lane) =>
        runCompareLane({
          model: lane.model,
          prompt,
          generate: gatewayGenerate,
          signal: controller.signal,
          onUpdate: (s) => setResults((prev) => ({ ...prev, [lane.id]: s })),
        }),
      ),
    ).finally(() => setRunning(false));
  };

  const shown = lanes.filter((l) => results[l.id] !== undefined || running);
  const columns = Math.max(1, Math.min(shown.length, MAX_LANES));

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-[20px] font-semibold">Compare</h1>
      <p className="mb-4 text-[12px]" style={{ color: "var(--text-faint)" }}>
        One prompt, every lane in parallel, side by side. Nothing is saved — this is a workbench, not a
        conversation.
      </p>

      <div className="mb-3">
        <textarea
          className={`${inputCls} h-24 w-full`}
          style={inputStyle}
          placeholder="The prompt every model receives…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {lanes.map((lane, i) => (
          <span key={lane.id} className="flex items-center gap-1">
            <select
              aria-label={`Model for lane ${i + 1}`}
              className={`${inputCls} min-w-[220px]`}
              style={inputStyle}
              value={lane.model}
              onChange={(e) => setLanes(lanes.map((l) => (l.id === lane.id ? { ...l, model: e.target.value } : l)))}
            >
              <option value="">model…</option>
              {lane.model && !options.some((o) => o.id === lane.model) && (
                <option value={lane.model}>{lane.model}</option>
              )}
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            {lanes.length > 1 && (
              <button
                aria-label={`Remove lane ${i + 1}`}
                className="rounded border px-1.5 py-0.5 text-[11px]"
                style={{ borderColor: "var(--border)", color: "var(--text-faint)", background: "transparent" }}
                onClick={() => setLanes(lanes.filter((l) => l.id !== lane.id))}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {lanes.length < MAX_LANES && (
          <Button ariaLabel="Add a model lane" onClick={() => setLanes([...lanes, newLane()])}>
            + lane
          </Button>
        )}
        <span className="grow" />
        {running ? (
          <Button variant="danger" onClick={stop}>Stop all</Button>
        ) : (
          <Button variant="primary" onClick={run}>Run</Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 text-[12px]" style={{ color: "var(--danger, #e5484d)" }}>{error}</p>
      )}

      {Object.keys(results).length === 0 ? (
        <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          Pick two or more models, type a prompt, and hit Run — answers stream side by side with latency,
          token and cost figures underneath each.
        </p>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {shown.map((lane) => (
            <LaneCard key={lane.id} lane={lane} state={results[lane.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

function LaneCard({ lane, state }: { lane: CompareLane; state: LaneState | undefined }) {
  if (!state) return null;
  const slugOf = (pid: string) => registry.getProvider(pid)?.slug ?? pid;
  // Cost follows the same honesty rule the session cost strip uses: priced only when the catalog
  // knows a price for the model that actually SERVED the lane — the served ids, not the requested
  // one — and an unpriced model says "unpriced" rather than rendering a fake $0.
  const pricing =
    state.usage && state.served?.provider && state.served?.model
      ? catalog.pricingFor(state.served.provider, state.served.model)
      : undefined;
  const micros =
    state.usage && pricing
      ? estimateCostMicros(pricing, state.usage.prompt_tokens, state.usage.completion_tokens)
      : undefined;

  const statusLabel =
    state.status === "running" ? "streaming…"
    : state.status === "stopped" ? "stopped"
    : state.status === "error" ? "failed"
    : "done";
  const statusColor =
    state.status === "error" ? "var(--danger, #e5484d)"
    : state.status === "stopped" ? "var(--warn)"
    : state.status === "running" ? "var(--info)"
    : "var(--success)";

  return (
    <div className="flex min-h-[200px] flex-col rounded-md border p-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="mono min-w-0 truncate text-[12px]" style={{ color: "var(--text)" }}>
          {lane.model || "—"}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: statusColor }}>{statusLabel}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "error" ? (
          <p role="alert" className="text-[12px]" style={{ color: "var(--danger, #e5484d)" }}>{state.error}</p>
        ) : state.text.trim() ? (
          <Markdown source={state.text} />
        ) : (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
            {state.status === "running" ? "waiting for the first token…" : "(no answer)"}
          </p>
        )}
      </div>

      <div className="mt-2 border-t pt-2 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {state.firstByteMs !== null && <span>first token {state.firstByteMs} ms</span>}
          {state.totalMs !== null && <span>total {state.totalMs} ms</span>}
          {state.usage && (
            <span>
              {state.usage.prompt_tokens} in · {state.usage.completion_tokens} out
            </span>
          )}
          {micros !== undefined ? (
            <span>{usd(micros)}</span>
          ) : state.usage ? (
            <span>unpriced</span>
          ) : null}
        </div>
        {state.served?.provider && (
          <div className="mt-0.5">
            served by {slugOf(state.served.provider)}
            {state.served.model ? ` · ${state.served.model}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
