/**
 * One compare lane (2026-10-06).
 *
 * Multi-model compare fires the SAME prompt at several models in parallel and shows the answers
 * side by side. A lane is one model's answer: the runner drives `gatewayGenerate` (the same
 * serving path chat uses), accumulates the stream, measures the two latencies that matter —
 * time-to-first-byte (responsiveness) and total (throughput) — and captures the terminal usage
 * and `served_by` attribution exactly once.
 *
 * Deliberately NOT `runPlainTurn`: that engine is wired into the transcript, the graph recorder,
 * memory recall and the busy gate — all singletons a parallel screen must not touch. A lane is
 * port-injected and stateless the way the memory distiller's one-shot call is, which is what
 * makes N concurrent lanes safe. Pure and Tauri-free, so it is node-testable.
 */
import type { GatewayExec, GatewayGenerateRequest, ServedBy } from "../gateway-turn";

export type LaneStatus = "running" | "done" | "stopped" | "error";

export interface LaneState {
  status: LaneStatus;
  text: string;
  /** Milliseconds from send to the first non-empty chunk — null until one arrives. */
  firstByteMs: number | null;
  /** Milliseconds from send to settle. */
  totalMs: number | null;
  /** The terminal usage chunk, when the upstream reported one. */
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  served: ServedBy | null;
  error: string | null;
}

export interface CompareLaneRequest {
  model: string;
  prompt: string;
  /** The generate port — `gatewayGenerate` in production, a fake in tests. */
  generate: (req: GatewayGenerateRequest, opts?: { signal?: AbortSignal }) => Promise<GatewayExec>;
  signal?: AbortSignal;
  /** Called after every mutation, so the screen can render per-chunk without polling. */
  onUpdate?: (state: LaneState) => void;
}

export function initialLaneState(): LaneState {
  return { status: "running", text: "", firstByteMs: null, totalMs: null, usage: null, served: null, error: null };
}

export async function runCompareLane(req: CompareLaneRequest): Promise<LaneState> {
  const state = initialLaneState();
  const started = Date.now();
  const emit = () => req.onUpdate?.({ ...state });

  try {
    const exec = await req.generate(
      {
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        // The terminal chunk is the only place usage rides, so the gateway hands it over here.
        onUsage: (u) => {
          state.usage = u;
          emit();
        },
      },
      { signal: req.signal },
    );
    for await (const chunk of exec.chunks) {
      if (req.signal?.aborted) break;
      if (state.firstByteMs === null && chunk.length > 0) state.firstByteMs = Date.now() - started;
      state.text += chunk;
      emit();
    }
    state.served = exec.served() ?? null;
    state.status = req.signal?.aborted ? "stopped" : "done";
  } catch (e) {
    if (req.signal?.aborted) {
      state.status = "stopped";
    } else {
      state.status = "error";
      state.error = e instanceof Error ? e.message : String(e);
    }
  } finally {
    state.totalMs = Date.now() - started;
    emit();
  }
  return state;
}
