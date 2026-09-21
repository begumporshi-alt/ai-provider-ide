/**
 * trail-health — whether the recorded trails are complete.
 *
 * Three trail-writing commands record work that has already happened: `generator_audit_record` (the
 * adapters the assistant wrote), `drift_event_record` (a detection) and `drift_event_resolve` (the
 * repair that answered it). They were called from **four** sites — the generator trail has two
 * producers, the wizard and drift repair — and every one was issued with `.catch(() => undefined)`,
 * which is right: a repair that applied correctly must not report failure because its *record* did not
 * land, or the lost row would cost a lost repair.
 *
 * It is also how a trail becomes a lie. Each of those tables now has a reader that claims
 * completeness ("Every adapter the assistant wrote", "Every time a provider was detected drifting"),
 * and a read cannot detect a write that never happened — a dropped row is simply absent. So the
 * swallow stays and the *failure* is kept here, and the cards that make the claim render it.
 *
 * **Scoped per trail, deliberately.** A single global counter would make both cards wrong: the
 * generation-audit card would announce a lost drift write, and the drift card a lost generation
 * write. Each card may only make claims about its own table.
 *
 * A store rather than a plain module record because the failure has no other way to reach the screen:
 * it does not move `ui-state`'s `tick` (which tracks router-core state, not this), and the write that
 * failed is the write that would have shown the row. Subscribing is the whole mechanism.
 *
 * Session-scoped. The counts are per launch and the copy says so — persisting them would need a table
 * to record failures of writing to tables, which is the joke the design is trying to avoid.
 *
 * **Two shapes, because the two failures differ.** A lost *row* is an omission, so it is counted. A
 * lost *ending* is not an omission: the row is there, and it says `running`. The Agents screen
 * explains that state with a *cause* — "the app was closed mid-run" — which a failed finish write
 * makes false. The status is not in doubt, though: `endRun` was handed it. Only the write failed. So
 * that failure is kept per run and the row can still show what happened.
 *
 * **The run trail (`agent_run`) counts a lost run once, not once per write.** A run whose *start* did
 * not land makes every later step append fail too — a foreign key in Rust, `unknown run` in the shim
 * — so counting each failure would turn one lost run into 1 + N. The orchestrator therefore reports a
 * lost step only for a run whose start was recorded; a step of a run that never existed is the *same*
 * failure as that run's start, and the count stays 1. The end failure is not counted at all: whether
 * the row exists or not, it is the run's own ending, which `unrecordedEnd` already reports.
 */
import { create } from "zustand";

export type TrailId = "generator_audit" | "drift" | "agent_run";

interface TrailHealth {
  counts: Record<TrailId, number>;
  lastMessage: Record<TrailId, string | null>;
  /** Run id -> the status the loop reported, for endings whose finish write did not land. */
  unrecordedEnd: Record<string, string>;
  noteFailure: (trail: TrailId, message: string) => void;
  noteUnrecordedEnd: (runId: string, status: string) => void;
}

export const useTrailHealth = create<TrailHealth>((set) => ({
  counts: { generator_audit: 0, drift: 0, agent_run: 0 },
  lastMessage: { generator_audit: null, drift: null, agent_run: null },
  unrecordedEnd: {},
  noteFailure: (trail, message) =>
    set((s) => ({
      counts: { ...s.counts, [trail]: s.counts[trail] + 1 },
      lastMessage: { ...s.lastMessage, [trail]: message },
    })),
  noteUnrecordedEnd: (runId, status) =>
    set((s) => ({ unrecordedEnd: { ...s.unrecordedEnd, [runId]: status } })),
}));

/**
 * Report a trail write that did not land, from outside React.
 *
 * `store.ts` is a plain module — it has no hook to call — so it reaches the store's imperative
 * handle. Everything the cards read is `useTrailHealth`, so a failure noted here reaches them
 * through the same subscription as any other write.
 */
export function noteTrailFailure(trail: TrailId, message: string): void {
  useTrailHealth.getState().noteFailure(trail, message);
}

/**
 * Report a run whose ending was observed but not written. Same reason as `noteTrailFailure`:
 * `lib/agent/orchestrator.ts` is a plain module, and the Agents screen reads through the subscription.
 */
export function noteUnrecordedEnd(runId: string, status: string): void {
  useTrailHealth.getState().noteUnrecordedEnd(runId, status);
}
