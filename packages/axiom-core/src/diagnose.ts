/**
 * Stage 03 — **Diagnose**, part two: the root-cause engine.
 *
 * This is the module the spec's central rule lives in — *"AXIOM should not assume every failure
 * requires a stronger model"* — and the rule is enforced structurally rather than by exhortation.
 * `model` is the one root cause that **cannot** be assigned from a single run: `DetectorHit`'s type
 * excludes it from `provisionalCause`, so a detector cannot even express the guess. It is only
 * assigned here, and only when a differential supports it — the same task, run on more than one
 * model, failing on one and passing on another. Absent that comparison the cause stays wherever the
 * detector's evidence put it, and the finding says in plain words that the differential was
 * unavailable.
 *
 * The reasoning is deliberately small. Three comparisons, in order:
 *
 * 1. **Across models, same task.** Fails everywhere → the fault travels with the configuration, so
 *    `model` is ruled out. Fails on one while others pass → `model` is confirmed, and the finding
 *    names both the model that failed and the ones that did not.
 * 2. **Across repetitions, same model, same task.** A failure that appears in some repeats and not
 *    others is stochastic; one that appears in all of them is systematic. This does not change the
 *    cause but it changes how much weight the proposal stage gives it, and it is recorded.
 * 3. **Nowhere to compare.** One model, one run. The provisional cause stands, marked provisional.
 *
 * Grouping is by the run's prompt, matched exactly. That is a real limit and it is stated rather
 * than hidden: two runs of "the same" task worded differently are not grouped, so a differential
 * that should have been available sometimes is not. Widening the key to a task id is the fix, and
 * it needs the host to stamp one onto `agent_runs` — which it does not do today.
 */
import { DEFAULT_THRESHOLDS, runDetectors, type DetectorHit, type DetectorThresholds } from "./detectors";
import { hash32 } from "./hash";
import type { DetectorPolicy } from "./trace";
import { deriveMetrics } from "./trace";
import type { Finding, RootCause, RunMetrics, RunTrace, Severity } from "./types";

/** Evidence kept per finding. Bounded because a finding with 400 evidence rows is unreadable, and
 *  because the count that matters is `occurrences`, not the length of the list. */
const MAX_EVIDENCE_PER_FINDING = 5;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, major: 2, critical: 3 };

export interface ObservedRun {
  trace: RunTrace;
  metrics: RunMetrics;
}

export interface DiagnoseInput {
  runs: RunTrace[];
  policy: DetectorPolicy;
  thresholds?: DetectorThresholds;
  /** The iteration ceiling those runs were given. Without it `runaway` cannot know what "full" is. */
  maxIterations: number;
}

/**
 * The id of a recurring finding: its detector plus a hash of the group it was found in. Deliberately
 * **not** minted per pass — the engine re-diagnoses the same history on every pass, and the store
 * carries a finding that keeps recurring as one row whose `occurrences` count moves, which only
 * works if the next pass produces the same id for the same problem. A fresh id per pass would turn
 * the register into an append log of duplicates while reading as a deduplicated one.
 */
export function findingId(detector: Finding["detector"], groupKey: string): string {
  return `finding-${detector}-${hash32(groupKey)}`;
}

export interface DiagnoseReport {
  findings: Finding[];
  runsExamined: number;
  runsClean: number;
  /** Runs whose detector hits were all folded into a finding — kept so a count can be audited. */
  totalHits: number;
}

interface Group {
  detector: Finding["detector"];
  key: string;
  hits: DetectorHit[];
  traces: RunTrace[];
}

function groupKey(trace: RunTrace): string {
  // A null or blank prompt gives nothing to compare against, so those runs group by model instead.
  // Grouping them by detector alone would merge unrelated work into one finding and report a
  // pattern that is really two.
  const p = trace.prompt?.trim();
  return p ? `task:${p}` : `model:${trace.model}`;
}

interface CauseResolution {
  cause: RootCause;
  rationale: string;
  /** True when a real comparison decided the cause; false when it stayed provisional. */
  differential: boolean;
}

function resolveCause(group: Group, runsForKey: RunTrace[]): CauseResolution {
  const hit = group.hits[0];
  const provisional = hit?.provisionalCause ?? "prompt";

  const failedModels = [...new Set(group.traces.map((t) => t.model))].sort();
  const allModels = [...new Set(runsForKey.map((t) => t.model))].sort();
  const passedModels = allModels.filter((m) => !failedModels.includes(m));

  // 1 — the model differential. Needs at least two models to have run this task, and at least one
  // of them to have *not* produced this hit; otherwise there is nothing to contrast.
  if (allModels.length >= 2) {
    if (passedModels.length === 0) {
      // `provisional` cannot be `model` — the detector's type forbids it — so this branch is not
      // "the model is ruled out", it is "the comparison found no model to blame".
      return {
        cause: provisional,
        differential: true,
        rationale:
          `Fired on every model that ran this task (${failedModels.join(", ")}), so the fault travels ` +
          `with the configuration rather than the model. The comparison rules a model limit out; ` +
          `'${provisional}' is what is left.`,
      };
    }
    return {
      cause: "model",
      differential: true,
      rationale:
        `Fired on ${failedModels.join(", ")} while ${passedModels.join(", ")} ran the same task without it. ` +
        `A failure that follows one model and not another is a model limit, and no prompt edit fixes it — ` +
        `the comparison, not an opinion, is what says so.`,
    };
  }

  // 2 — repetition on one model. Does not move the cause; records whether the failure is systematic.
  if (runsForKey.length >= 2 && group.traces.length === runsForKey.length) {
    return {
      cause: provisional,
      differential: false,
      rationale:
        `Reproduced in ${group.traces.length} of ${group.traces.length} runs of this task on ` +
        `${failedModels[0] ?? "?"}, so it is systematic rather than a one-off — but only one model was ` +
        `observed, so '${provisional}' is provisional: a second model could still show this is a model limit.`,
    };
  }
  if (runsForKey.length >= 2) {
    return {
      cause: provisional,
      differential: false,
      rationale:
        `Appeared in ${group.traces.length} of ${runsForKey.length} runs of this task on ` +
        `${failedModels[0] ?? "?"}, so it is intermittent. Only one model was observed, so '${provisional}' ` +
        `is provisional and the intermittency is itself the thing to explain.`,
    };
  }

  // 3 — nothing to compare against.
  return {
    cause: provisional,
    differential: false,
    rationale:
      `One run of this task, on one model (${failedModels[0] ?? "?"}). No differential was available, so ` +
      `'${provisional}' is the detector's reading of this transcript alone — treat it as a hypothesis. ` +
      `Running the same task on a second model is what would settle it.`,
  };
}

/** Stage 01's output: every run reduced to its metrics. `diagnose` calls this internally; it is
 *  exported because the capability map and the autopsy read the same reduction. */
export function observe(runs: RunTrace[], policy: DetectorPolicy): ObservedRun[] {
  return runs.map((trace) => ({ trace, metrics: deriveMetrics(trace, policy) }));
}

/**
 * Runs every detector over every run, groups the hits, and resolves each group's root cause.
 */
export function diagnose(input: DiagnoseInput): DiagnoseReport {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const observed = input.runs.map((trace) => ({
    trace,
    metrics: deriveMetrics(trace, input.policy),
  }));

  const byKey = new Map<string, RunTrace[]>();
  for (const o of observed) {
    const k = groupKey(o.trace);
    const list = byKey.get(k);
    if (list) list.push(o.trace);
    else byKey.set(k, [o.trace]);
  }

  const groups = new Map<string, Group>();
  let totalHits = 0;
  const runsWithHits = new Set<string>();

  for (const o of observed) {
    const hits = runDetectors({
      trace: o.trace,
      metrics: o.metrics,
      policy: input.policy,
      thresholds,
      maxIterations: input.maxIterations,
    });
    totalHits += hits.length;
    if (hits.length > 0) runsWithHits.add(o.trace.id);
    for (const hit of hits) {
      const key = `${hit.detector}\u0000${groupKey(o.trace)}`;
      const g = groups.get(key);
      if (g) {
        g.hits.push(hit);
        g.traces.push(o.trace);
      } else {
        groups.set(key, { detector: hit.detector, key: groupKey(o.trace), hits: [hit], traces: [o.trace] });
      }
    }
  }

  const findings: Finding[] = [];
  for (const g of groups.values()) {
    const runsForKey = byKey.get(g.key) ?? g.traces;
    const resolved = resolveCause(g, runsForKey);
    const severity = g.hits.reduce<Severity>(
      (worst, h) => (SEVERITY_RANK[h.severity] > SEVERITY_RANK[worst] ? h.severity : worst),
      "info",
    );
    const first = g.hits[0];
    const evidence = g.hits.slice(0, MAX_EVIDENCE_PER_FINDING).map((h) => h.evidence);
    const omitted = g.hits.length - evidence.length;
    if (omitted > 0) {
      evidence.push({
        runId: g.traces[0]?.id ?? "?",
        steps: [],
        note: `${omitted} further occurrences omitted from this list; occurrences carries the true count.`,
      });
    }
    findings.push({
      id: findingId(g.detector, g.key),
      detector: g.detector,
      title: first?.title ?? g.detector,
      severity,
      rootCause: resolved.cause,
      rationale: resolved.rationale,
      differential: resolved.differential,
      evidence,
      occurrences: g.hits.length,
      metric: first?.metric ?? null,
    });
  }

  // Critical first, then by how often it happened. A finding that fires on every run outranks a
  // rarer one of the same severity because it is the one a fix will actually move.
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.occurrences - a.occurrences);

  return {
    findings,
    runsExamined: observed.length,
    runsClean: observed.length - runsWithHits.size,
    totalHits,
  };
}
