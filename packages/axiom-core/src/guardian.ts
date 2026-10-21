/**
 * Stage 06 — **Validate**. The Regression Guardian.
 *
 * The rule this module exists to enforce is the one the spec states last, and the only one that
 * really matters:
 *
 * > AXIOM must not mark an agent as improved merely because the agent says it has improved. It must
 * > demonstrate measurable gains on independent evaluations while preserving safety and previously
 * > working capabilities.
 *
 * Three consequences shape the code.
 *
 * **A gain must clear the noise floor.** The agent samples from a model, so two runs of the same
 * configuration differ. A delta smaller than the spread across repeats is not a result, and the
 * guardian says so rather than reporting it as an improvement. This is also why fewer than two
 * attempts is a hard failure and not a small sample: with one attempt there is no spread to compare
 * against, so *no* delta can be shown to be real. The spread is pooled **within** each task
 * (`valuesByTask`), never across tasks: two tasks that differ in difficulty are not noise, and
 * averaging them in makes the floor a measure of suite heterogeneity that no repeat count can lower.
 *
 **Preserving what worked is a separate check from improving what didn't.** A change that lifts the
 * targeted metric and breaks two previously-passing tasks is rejected. That is the whole point of
 * calling it a guardian: an optimiser would take the trade.
 *
 * **Incomparable is a failure, not a pass.** When latency or cost cannot be compared — an attempt
 * that never reported an end, a suite run at a different repeat count — the check fails with the
 * reason. A check that passes because it could not run is the negative assertion on an
 * auto-dismissing surface that the conventions chapter warns about: it can never fail, so it never
 * tells you anything.
 */
import { countPatches, patchChars, PROMPT_CAP, unmarkedChars, type Proposal } from "./version";
import type { AgentVersion, EvalAttemptSummary, Finding, GuardianCheck, MetricDelta, SuiteResult } from "./types";

/** The metrics a validation run can compare. Each is derived from stored attempt summaries only. */
export type ComparableMetric =
  | "passRate"
  | "iterations"
  | "totalTokens"
  | "durationMs"
  | "toolCalls"
  | "toolFailures"
  | "deniedCalls"
  | "verificationCalls"
  | "repeatRatio";

const HIGHER_IS_BETTER: ReadonlySet<ComparableMetric> = new Set(["passRate", "verificationCalls"]);
const LOWER_IS_BETTER: ReadonlySet<ComparableMetric> = new Set([
  "iterations",
  "totalTokens",
  "durationMs",
  "toolFailures",
  "deniedCalls",
  "repeatRatio",
]);

export interface GuardianOptions {
  /** Smallest target-metric movement that counts. Absolute, in the metric's own units. */
  minEffect: number;
  /** How much more the candidate may spend, as a fraction. 0.25 = a quarter more tokens. */
  maxCostGrowth: number;
  /** How much slower the candidate may be, as a fraction. */
  maxLatencyGrowth: number;
  /** Fewest attempts per side. Below this there is no spread, so nothing can be shown to be real. */
  minAttempts: number;
}

export const DEFAULT_GUARDIAN: GuardianOptions = {
  minEffect: 0.1,
  maxCostGrowth: 0.25,
  maxLatencyGrowth: 0.25,
  minAttempts: 2,
};

export function isComparableMetric(m: string | null): m is ComparableMetric {
  return m !== null && (HIGHER_IS_BETTER.has(m as ComparableMetric) || LOWER_IS_BETTER.has(m as ComparableMetric) || m === "toolCalls");
}

function values(r: SuiteResult, m: ComparableMetric): (number | null)[] {
  return r.attemptSummaries.map((a) => valuesOf(a, m));
}

/**
 * The same values, grouped by the task each attempt belongs to.
 *
 * The grouping is the whole point of this function. The spread the noise floor is meant to measure
 * is the model sampling differently run to run **on the same task**. Spread across different tasks is
 * difficulty — a property of the suite, not of the run — and it does not shrink when repeats are
 * added, because adding repeats adds equal numbers of easy and hard attempts. Pooling the two
 * together makes the floor a measure of how heterogeneous the suite is, and on `passRate` it pinned
 * at ~0.47 while the real gain was 0.25, so a change that fixed a whole task could never be promoted
 * however many repeats the user paid for.
 */
function valuesByTask(r: SuiteResult, m: ComparableMetric): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const a of r.attemptSummaries) {
    const v = valuesOf(a, m);
    if (v === null) continue;
    const list = groups.get(a.taskId);
    if (list) list.push(v);
    else groups.set(a.taskId, [v]);
  }
  return groups;
}

function valuesOf(a: EvalAttemptSummary, m: ComparableMetric): number | null {
  switch (m) {
    case "passRate":
      return a.passed ? 1 : 0;
    case "iterations":
      return a.iterations;
    case "totalTokens":
      return a.totalTokens;
    case "durationMs":
      return a.durationMs;
    case "toolCalls":
      return a.toolCalls;
    case "toolFailures":
      return a.toolFailures;
    case "deniedCalls":
      return a.deniedCalls;
    case "verificationCalls":
      return a.verificationCalls;
    case "repeatRatio":
      return a.repeatRatio;
  }
}

/**
 * Variance pooled **within** tasks, from every group that has at least two attempts.
 *
 * Degrees-of-freedom weighted (each task contributes its own `n - 1`), which is why it is computed
 * from sums of squared deviations rather than by averaging the per-task standard deviations: the
 * second weights a 2-repeat task the same as a 5-repeat one.
 *
 * `null` when no group has two attempts — the same refusal `stddev` makes, for the same reason.
 */
function withinTaskSpread(groups: readonly Map<string, number[]>[]): number | null {
  let ss = 0;
  let df = 0;
  for (const groupsOfOneSide of groups) {
    for (const vals of groupsOfOneSide.values()) {
      if (vals.length < 2) continue;
      const mu = mean(vals);
      if (mu === null) continue;
      for (const v of vals) ss += (v - mu) ** 2;
      df += vals.length - 1;
    }
  }
  return df === 0 ? null : Math.sqrt(ss / df);
}

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation. Returns null below two values: the spread of one sample is undefined,
 *  and reporting 0 would claim a certainty the data does not have. */
export function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (m === null) return null;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export interface MetricComparison {
  delta: MetricDelta | null;
  /** Why there is no delta. Null when there is one. */
  unavailable: string | null;
}

export function compareMetric(baseline: SuiteResult, candidate: SuiteResult, m: ComparableMetric): MetricComparison {
  const bAll = values(baseline, m);
  const cAll = values(candidate, m);
  const bMissing = bAll.filter((v): v is null => v === null).length;
  const cMissing = cAll.filter((v): v is null => v === null).length;
  if (bMissing > 0 || cMissing > 0) {
    return {
      delta: null,
      unavailable:
        `${m} could not be compared: ${bMissing} baseline and ${cMissing} candidate attempt(s) never reported it. ` +
        `An unknown is not a zero, and averaging only the known ones would invent a number.`,
    };
  }
  const b = bAll as number[];
  const c = cAll as number[];
  const bm = mean(b);
  const cm = mean(c);
  if (bm === null || cm === null) return { delta: null, unavailable: `${m} has no attempts to compare.` };
  const delta = cm - bm;
  // The spread pooled within tasks, not across them — see `valuesByTask`. Across tasks it measures
  // how heterogeneous the suite is, which is not noise and does not shrink with repeats.
  const pooled = withinTaskSpread([valuesByTask(baseline, m), valuesByTask(candidate, m)]);
  // With fewer than two attempts on any task there is no spread to pool, and the caller — not this
  // function — decides what that means; `beyondNoise` is false, so an unreplicated comparison can
  // never be the reason a change is promoted.
  const beyondNoise = pooled === null ? false : pooled === 0 ? delta !== 0 : Math.abs(delta) > pooled;
  return {
    delta: { metric: m, baseline: bm, candidate: cm, delta, beyondNoise },
    unavailable: null,
  };
}

function improved(m: ComparableMetric, delta: number): boolean {
  if (HIGHER_IS_BETTER.has(m)) return delta > 0;
  if (LOWER_IS_BETTER.has(m)) return delta < 0;
  // `toolCalls` has no good direction: more calls can mean more verification or more thrashing.
  // Refusing to score it is the honest answer, and the check that consumes this says so.
  return false;
}

export interface GuardianInput {
  baseline: SuiteResult;
  candidate: SuiteResult;
  candidateVersion: AgentVersion;
  baselineVersion: AgentVersion | null;
  proposal: Proposal;
  /** The findings the proposal targeted, so evidence can be resolved rather than assumed. */
  findings: Finding[];
  /**
   * The host's built-in system prompt, when the caller has one to hand.
   *
   * `buildCandidate` stores `applyPromptPatches(basePrompt, [patch]).prompt` as the override, so a
   * real override carries the whole base — unmarked, and legitimately so. Supplying the base is what
   * lets `prompt-budget` tell "the base it claims to amend" from "text appended that no marker can
   * see". Omitted, the check bounds patch size only and says so by staying silent on the rest rather
   * than inventing a base to compare against.
   */
  builtinPrompt?: string;
  options?: GuardianOptions;
}

export interface GuardianReport {
  checks: GuardianCheck[];
  deltas: MetricDelta[];
  passed: boolean;
  /** The metric the proposal was judged on, after falling back to the pass rate. */
  targetMetric: ComparableMetric | null;
}

function check(id: string, label: string, passed: boolean, detail: string): GuardianCheck {
  return { id, label, passed, detail };
}

export function runGuardian(input: GuardianInput): GuardianReport {
  const opts = input.options ?? DEFAULT_GUARDIAN;
  const { baseline, candidate } = input;
  const checks: GuardianCheck[] = [];
  const deltas: MetricDelta[] = [];

  // 1 — are the two even comparable?
  const sameConditions =
    baseline.suiteId === candidate.suiteId && baseline.model === candidate.model && baseline.repeats === candidate.repeats;
  checks.push(
    check(
      "same-conditions",
      "Both sides ran the same suite, on the same model, at the same repeat count",
      sameConditions,
      sameConditions
        ? `Suite ${candidate.suiteId}, model ${candidate.model}, ${candidate.repeats} repeat(s) each.`
        : `Baseline was suite ${baseline.suiteId}/${baseline.model}/${baseline.repeats}x; candidate was ` +
          `${candidate.suiteId}/${candidate.model}/${candidate.repeats}x. A difference on any of those makes the ` +
          `comparison measure the difference, not the change.`,
    ),
  );

  // 2 — enough samples for a spread to exist.
  const enough = baseline.attemptSummaries.length >= opts.minAttempts && candidate.attemptSummaries.length >= opts.minAttempts;
  checks.push(
    check(
      "enough-samples",
      `At least ${opts.minAttempts} attempts on each side`,
      enough,
      enough
        ? `${baseline.attemptSummaries.length} baseline and ${candidate.attemptSummaries.length} candidate attempts.`
        : `${baseline.attemptSummaries.length} baseline and ${candidate.attemptSummaries.length} candidate attempts. ` +
          `With fewer than ${opts.minAttempts} there is no spread, so no delta can be shown to be more than sampling noise.`,
    ),
  );

  // 3 — nothing that worked may stop working.
  const regressions: string[] = [];
  for (const b of baseline.tasks) {
    const c = candidate.tasks.find((t) => t.taskId === b.taskId);
    if (!c) {
      regressions.push(`${b.taskId} was not re-run at all`);
      continue;
    }
    if (c.passRate < b.passRate) {
      regressions.push(`${b.taskId} (${b.capability}): ${pct(b.passRate)} → ${pct(c.passRate)}`);
    }
  }
  checks.push(
    check(
      "no-task-regression",
      "No task that passed on the baseline passes less often on the candidate",
      regressions.length === 0,
      regressions.length === 0
        ? `All ${baseline.tasks.length} task(s) held or improved.`
        : `${regressions.length} regression(s): ${regressions.join("; ")}. An improvement bought with a capability ` +
          `that used to work is not an improvement, whatever the headline metric says.`,
    ),
  );

  // 4/5 — did the thing it was meant to fix actually move, and by more than noise?
  const targetMetric = resolveTargetMetric(input.proposal);
  if (targetMetric === null) {
    checks.push(
      check(
        "target-improved",
        "The targeted metric moved in the intended direction",
        false,
        `The proposal names metric '${input.proposal.targetMetric ?? "(none)"}', which has no defined good ` +
          `direction. AXIOM will not score a metric it cannot say which way is better.`,
      ),
    );
  } else {
    const cmp = compareMetric(baseline, candidate, targetMetric);
    if (cmp.delta) deltas.push(cmp.delta);
    if (cmp.delta === null) {
      checks.push(check("target-improved", "The targeted metric moved in the intended direction", false, cmp.unavailable ?? "unknown"));
      checks.push(check("beyond-noise", "The movement is larger than the spread across repeats", false, cmp.unavailable ?? "unknown"));
    } else {
      const d = cmp.delta;
      const moved = improved(targetMetric, d.delta) && Math.abs(d.delta) >= opts.minEffect;
      checks.push(
        check(
          "target-improved",
          "The targeted metric moved in the intended direction",
          moved,
          `${targetMetric}: ${fmt(d.baseline)} → ${fmt(d.candidate)} (${d.delta >= 0 ? "+" : ""}${fmt(d.delta)}), ` +
            `needing at least ${fmt(opts.minEffect)} in the ${HIGHER_IS_BETTER.has(targetMetric) ? "upward" : "downward"} direction.`,
        ),
      );
      checks.push(
        check(
          "beyond-noise",
          "The movement is larger than the spread across repeats",
          d.beyondNoise,
          d.beyondNoise
            ? `${targetMetric} moved ${fmt(Math.abs(d.delta))}, more than the pooled spread across repeats.`
            : `${targetMetric} moved ${fmt(Math.abs(d.delta))}, which the spread across repeats can account for on its own. ` +
              `This is indistinguishable from running the same configuration twice.`,
        ),
      );
    }
  }

  // 6 — cost.
  const costCmp = compareMetric(baseline, candidate, "totalTokens");
  if (costCmp.delta) deltas.push(costCmp.delta);
  if (costCmp.delta === null) {
    checks.push(check("cost-tolerance", `Token spend within ${pct(opts.maxCostGrowth)} of baseline`, false, costCmp.unavailable ?? "unknown"));
  } else {
    const limit = costCmp.delta.baseline * (1 + opts.maxCostGrowth);
    const ok = costCmp.delta.candidate <= limit;
    checks.push(
      check(
        "cost-tolerance",
        `Token spend within ${pct(opts.maxCostGrowth)} of baseline`,
        ok,
        `${fmt(costCmp.delta.baseline)} → ${fmt(costCmp.delta.candidate)} tokens per attempt; ceiling ${fmt(limit)}.`,
      ),
    );
  }

  // 7 — latency.
  const latCmp = compareMetric(baseline, candidate, "durationMs");
  if (latCmp.delta) deltas.push(latCmp.delta);
  if (latCmp.delta === null) {
    checks.push(check("latency-tolerance", `Wall time within ${pct(opts.maxLatencyGrowth)} of baseline`, false, latCmp.unavailable ?? "unknown"));
  } else {
    const limit = latCmp.delta.baseline * (1 + opts.maxLatencyGrowth);
    const ok = latCmp.delta.candidate <= limit;
    checks.push(
      check(
        "latency-tolerance",
        `Wall time within ${pct(opts.maxLatencyGrowth)} of baseline`,
        ok,
        `${fmt(latCmp.delta.baseline)}ms → ${fmt(latCmp.delta.candidate)}ms per attempt; ceiling ${fmt(limit)}ms.`,
      ),
    );
  }

  // 8 — AXIOM's own footprint on the prompt.
  const prompt = input.candidateVersion.config.promptOverride ?? "";
  const chars = patchChars(prompt);
  const patches = countPatches(prompt);
  const capOk = chars <= PROMPT_CAP.maxPatchChars && patches <= PROMPT_CAP.maxPatches;
  // A marker the cap cannot see is a character the cap does not count, so the cap alone cannot bound
  // the prompt: `patchChars` skips everything outside a block. The base prompt is not the problem —
  // a real override *is* the base plus patches, so it is legitimately unmarked — and the question
  // worth asking is whether the candidate added unmarked text beyond the base it claims to amend.
  // With no base to compare against (a caller that supplied none) this half stands down rather than
  // inventing one; `pipeline` always supplies `builtinPrompt`, so production never takes that path.
  const base = input.baselineVersion?.config.promptOverride ?? input.builtinPrompt ?? null;
  const unmarked = unmarkedChars(prompt);
  const baseUnmarked = base === null ? null : unmarkedChars(base);
  const baseOk = baseUnmarked === null || unmarked === baseUnmarked;
  const paidFor = `Every character is paid for on every subsequent turn, so a fix that bloats the prompt trades one waste for another.`;
  checks.push(
    check(
      "prompt-budget",
      `AXIOM's additions stay within ${PROMPT_CAP.maxPatchChars} characters and ${PROMPT_CAP.maxPatches} patches, and add no text the markers cannot see`,
      capOk && baseOk,
      baseOk
        ? `${patches} patch(es), ${chars} characters added to the system turn. ${paidFor}`
        : `The override carries ${unmarked.length} unmarked character(s) where the base it amends has ${baseUnmarked!.length}, ` +
          `so it contains text outside any recognised patch block — invisible to the cap, and not re-applied at send time. ` +
          `${patches} patch(es), ${chars} characters of counted patch text. ${paidFor}`,
    ),
  );

  // 9 — evidence resolves. A version justified by nothing is a guess with a version number.
  const evidenceProblems: string[] = [];
  if (input.candidateVersion.evidence.length === 0) evidenceProblems.push("the version cites no evidence");
  for (const e of input.candidateVersion.evidence) {
    if (e.steps.length === 0 && !e.note.includes("omitted")) {
      evidenceProblems.push(`evidence for run ${e.runId} names no steps`);
    }
  }
  const known = new Set(input.findings.map((f) => f.id));
  for (const id of input.candidateVersion.targetsFindingIds) {
    if (!known.has(id)) evidenceProblems.push(`targets finding ${id}, which is not in the diagnosis`);
  }
  checks.push(
    check("evidence-resolves", "Every claim the version rests on points at something real", evidenceProblems.length === 0,
      evidenceProblems.length === 0
        ? `${input.candidateVersion.evidence.length} evidence row(s), ${input.candidateVersion.targetsFindingIds.length} targeted finding(s), all resolving.`
        : evidenceProblems.join("; "),
    ),
  );

  // 10 — the candidate is actually different. Comparing a configuration with itself measures the
  // noise floor and reports it as a result.
  const changed = configDiffers(input.baselineVersion?.config ?? null, input.candidateVersion.config);
  checks.push(
    check("actually-changed", "The candidate differs from its parent", changed, changed
      ? describeConfigDiff(input.baselineVersion?.config ?? null, input.candidateVersion.config)
      : "The candidate's configuration is identical to the baseline's, so a validation run would compare noise with noise."),
  );

  return { checks, deltas, passed: checks.every((c) => c.passed), targetMetric };
}

function resolveTargetMetric(p: Proposal): ComparableMetric | null {
  if (p.targetMetric !== null && isComparableMetric(p.targetMetric) && p.targetMetric !== "toolCalls") return p.targetMetric;
  // Falling back to the pass rate is a fallback, not a preference: it is the only metric with an
  // unambiguous direction that every suite produces. The check's detail records that it was used.
  if (p.targetMetric === null) return "passRate";
  return null;
}

function configDiffers(a: AgentVersion["config"] | null, b: AgentVersion["config"]): boolean {
  if (a === null) return true;
  return (
    a.promptOverride !== b.promptOverride ||
    a.loop.maxIterations !== b.loop.maxIterations ||
    a.loop.verificationNudgeMax !== b.loop.verificationNudgeMax
  );
}

function describeConfigDiff(a: AgentVersion["config"] | null, b: AgentVersion["config"]): string {
  if (a === null) return "The baseline is the built-in configuration; the candidate departs from it.";
  const parts: string[] = [];
  if (a.loop.maxIterations !== b.loop.maxIterations) parts.push(`maxIterations ${a.loop.maxIterations}→${b.loop.maxIterations}`);
  if (a.loop.verificationNudgeMax !== b.loop.verificationNudgeMax) {
    parts.push(`verificationNudgeMax ${a.loop.verificationNudgeMax}→${b.loop.verificationNudgeMax}`);
  }
  if (a.promptOverride !== b.promptOverride) {
    const before = a.promptOverride === null ? "the built-in prompt" : `${patchChars(a.promptOverride)} characters of AXIOM patches`;
    parts.push(`prompt: ${before} → ${b.promptOverride === null ? "the built-in prompt" : `${patchChars(b.promptOverride)} characters of AXIOM patches`}`);
  }
  return parts.length > 0 ? parts.join("; ") : "differ";
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}
