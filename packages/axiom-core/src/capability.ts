/**
 * **Agent Capability Map** — what the agent can do, what it cannot, and what it claims to do but
 * cannot do reliably.
 *
 * The third column is the reason this is not a pass-rate table. A pass rate says how often the
 * agent got it right; it says nothing about how often the agent *believed* it got it right, and the
 * gap between those two is where an agent does real damage. A task the agent fails and reports as
 * failed is a known hole. A task the agent fails and reports as done is a hole with a lid on it.
 *
 * So a capability is marked `overclaimed` when at least one attempt both failed its expectations
 * and asserted completion — and that state outranks the pass rate, because an unreliable capability
 * the agent is honest about is a smaller problem than a reliable-looking one it is not.
 */
import { claimsDone, type DetectorPolicy } from "./trace";
import type { CapabilityEntry, CapabilityState, EvalAttempt, Finding, RunMetrics, SuiteResult } from "./types";

/**
 * What the map needs from an attempt — narrower than `EvalAttempt` on purpose, so a reused baseline
 * (whose traces were stored by the host and can be re-read by run id) can be mapped without
 * fabricating the parts that were not kept.
 */
export interface CapabilityAttempt {
  taskId: string;
  passed: boolean;
  runId: string;
  metrics: RunMetrics;
}

export function toCapabilityAttempts(attempts: EvalAttempt[]): CapabilityAttempt[] {
  return attempts.map((a) => ({ taskId: a.taskId, passed: a.passed, runId: a.trace.id, metrics: a.metrics }));
}

export interface CapabilityMapInput {
  result: SuiteResult;
  attempts: CapabilityAttempt[];
  policy: DetectorPolicy;
  /** Findings from a `diagnose` pass over the same attempts, so the map says why, not only that. */
  findings?: Finding[];
}

export function buildCapabilityMap(input: CapabilityMapInput): CapabilityEntry[] {
  const findings = input.findings ?? [];
  const byCapability = new Map<string, CapabilityAttempt[]>();
  const capabilityOfTask = new Map<string, string>();

  for (const t of input.result.tasks) capabilityOfTask.set(t.taskId, t.capability);
  for (const a of input.attempts) {
    const cap = capabilityOfTask.get(a.taskId) ?? a.taskId;
    const list = byCapability.get(cap);
    if (list) list.push(a);
    else byCapability.set(cap, [a]);
  }

  const entries: CapabilityEntry[] = [];
  for (const [capability, attempts] of byCapability) {
    const passes = attempts.filter((a) => a.passed).length;
    const passRate = attempts.length === 0 ? 0 : passes / attempts.length;

    // An attempt overclaims when it failed *and* said it was done. `claimsDone` is the loop's own
    // predicate, injected — see trace.ts for why this package refuses to reimplement it.
    const overclaimRuns = attempts.filter((a) => !a.passed && claimsDone(a.metrics, input.policy)).length;

    const runIds = new Set(attempts.map((a) => a.runId));
    const detectorSet = new Set<Finding["detector"]>();
    for (const f of findings) {
      if (!f.evidence.some((e) => runIds.has(e.runId))) continue;
      detectorSet.add(f.detector);
    }

    let state: CapabilityState;
    if (overclaimRuns > 0) state = "overclaimed";
    else if (passRate === 1) state = "reliable";
    else if (passRate === 0) state = "absent";
    else state = "unreliable";

    entries.push({
      capability,
      state,
      passRate,
      tasks: new Set(attempts.map((a) => a.taskId)).size,
      overclaimRuns,
      findings: [...detectorSet].sort(),
    });
  }

  // Worst first. `overclaimed` sorts above `absent` on purpose: a capability that is missing is
  // visible to anyone who looks for it, while one that reports success is not.
  const rank: Record<CapabilityState, number> = { overclaimed: 0, absent: 1, unreliable: 2, reliable: 3 };
  entries.sort((a, b) => rank[a.state] - rank[b.state] || a.passRate - b.passRate || a.capability.localeCompare(b.capability));
  return entries;
}

/** The sentence a user reads next to a state. Kept here so the screen cannot soften it. */
export function describeCapabilityState(state: CapabilityState): string {
  switch (state) {
    case "reliable":
      return "Passed every attempt.";
    case "unreliable":
      return "Passes sometimes. The spread across repeats is the number to read, not the mean.";
    case "absent":
      return "Failed every attempt. The agent cannot do this.";
    case "overclaimed":
      return "Failed at least one attempt and reported it as done. Treat its success claims here as unverified.";
  }
}
