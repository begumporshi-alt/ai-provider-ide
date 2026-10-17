/**
 * Stage 02 — **Evaluate**, part two: running a suite and turning the runs into numbers.
 *
 * Two things here are load-bearing and easy to mistake for ceremony.
 *
 * **Repeats.** An agent backed by a sampling model is a stochastic process, so one run of one task
 * is a sample of size one. Every comparison the guardian makes later is a comparison of means, and
 * a mean over one sample has no spread — which is why `repeats` defaults to 3 rather than 1, and
 * why the guardian refuses to promote on a delta it cannot distinguish from noise. Running once and
 * reporting the result as a measurement is the exact error this prevents.
 *
 * **Consent before spend.** Invariant #7 requires explicit consent with an estimated cost for a paid
 * validation call, and an evaluation is dozens of them. The estimate is built from the suite's own
 * history when there is one and from a stated assumption when there is not; either way the number
 * the user approves is the number shown. A runner that declares `paid: false` — a fixture, a replay
 * of stored traces — skips the gate, because gating free runs trains people to click through it.
 */
import type { AxiomPorts, CostEstimate } from "./ports";
import { DEFAULT_THRESHOLDS } from "./detectors";
import { claimsDone, deriveMetrics, type DetectorPolicy } from "./trace";
import { describeExpectation } from "./suite";
import type {
  AgentConfig,
  EvalAttempt,
  EvalAttemptSummary,
  EvalSuite,
  EvalTask,
  EvalTaskResult,
  FailedExpectation,
  RunMetrics,
  RunTrace,
  SuiteResult,
  SuiteRun,
} from "./types";

/**
 * Thrown rather than returned when a paid evaluation cannot be authorized. An exception is the
 * right shape because the alternative — a result object with a `refused` flag — gets read as a
 * result, and a refusal is the absence of one.
 */
export class PaidRunRefusedError extends Error {
  readonly estimate: CostEstimate | null;
  constructor(message: string, estimate: CostEstimate | null) {
    super(message);
    this.name = "PaidRunRefusedError";
    this.estimate = estimate;
  }
}

export interface EvaluateOptions {
  suite: EvalSuite;
  model: string;
  config: AgentConfig;
  versionId: string;
  policy: DetectorPolicy;
  /** Samples per task. Below 2 the guardian cannot compute a spread, and says so. */
  repeats?: number;
  signal?: AbortSignal;
}

export const DEFAULT_REPEATS = 3;

/**
 * The per-call token assumption used when the suite has no history. Deliberately ordinary rather
 * than generous: an estimate that is wildly high gets dismissed, and one that is wildly low gets
 * approved and then exceeded. The real number replaces it after the first run.
 */
export const ASSUMED_TOKENS_PER_CALL = { prompt: 4000, completion: 900 };

/**
 * What a cost estimate actually depends on. Narrower than `EvaluateOptions` on purpose: an estimate
 * is asked for *before* a run exists, when there is no candidate configuration and no version id to
 * put in one. Demanding them here would force every caller to invent placeholders — a fake config
 * whose only job is to satisfy a signature is a fake config that can later be mistaken for a real one.
 */
export type CostEstimateInput = Pick<EvaluateOptions, "suite" | "model" | "repeats">;

export function estimateCost(ports: AxiomPorts, opts: CostEstimateInput, prior?: SuiteResult[]): CostEstimate {
  const repeats = opts.repeats ?? DEFAULT_REPEATS;
  const calls = opts.suite.tasks.length * repeats;

  // Prefer the suite's own measured history: it is the only estimate that has ever been right.
  const usable = (prior ?? []).filter((r) => r.attemptSummaries.length > 0);
  let prompt = ASSUMED_TOKENS_PER_CALL.prompt;
  let completion = ASSUMED_TOKENS_PER_CALL.completion;
  if (usable.length > 0) {
    let p = 0;
    let c = 0;
    let n = 0;
    for (const r of usable) {
      const perAttemptPrompt = r.cost.promptTokens / Math.max(1, r.attemptSummaries.length);
      const perAttemptCompletion = r.cost.completionTokens / Math.max(1, r.attemptSummaries.length);
      p += perAttemptPrompt;
      c += perAttemptCompletion;
      n += 1;
    }
    prompt = Math.ceil(p / n);
    completion = Math.ceil(c / n);
  }

  const priced = ports.prices?.estimate(opts.model, prompt * calls, completion * calls);
  return {
    model: opts.model,
    tasks: opts.suite.tasks.length,
    repeats,
    calls,
    usd: priced ? priced.usd : null,
    assumedTokensPerCall: { prompt, completion },
  };
}

/**
 * Ask before spending. Returns silently when the runner is free; throws when it is paid and there
 * is no way to ask, because "no consent mechanism was wired up" must not default to "consent given".
 */
export async function authorizePaidRun(ports: AxiomPorts, opts: EvaluateOptions): Promise<CostEstimate | null> {
  if (!ports.runner.paid) return null;
  const prior = await ports.results.listSuiteResults({ suiteId: opts.suite.id });
  const estimate = estimateCost(ports, opts, prior);
  if (!ports.consent) {
    throw new PaidRunRefusedError(
      `This evaluation would make ${estimate.calls} paid model call(s) on ${estimate.model}, and no consent ` +
        `mechanism is available to authorize it. Refusing rather than assuming yes.`,
      estimate,
    );
  }
  const ok = await ports.consent.request(estimate);
  if (!ok) {
    throw new PaidRunRefusedError(`The user declined ${estimate.calls} paid model call(s) on ${estimate.model}.`, estimate);
  }
  return estimate;
}

export interface TaskCheck {
  failed: FailedExpectation[];
  budgetExceeded: string[];
  passed: boolean;
}

/**
 * Judge one attempt. Every branch reads the transcript; none asks the agent what it thinks.
 */
export function checkTask(task: EvalTask, trace: RunTrace, metrics: RunMetrics, policy: DetectorPolicy): TaskCheck {
  const failed: FailedExpectation[] = [];
  task.expect.forEach((e, index) => {
    const reason = expectationFailure(e, trace, metrics, policy);
    if (reason !== null) failed.push({ index, expectation: e, reason });
  });

  const budgetExceeded: string[] = [];
  const b = task.budget;
  if (b) {
    if (b.maxIterations !== undefined && metrics.iterations > b.maxIterations) {
      budgetExceeded.push(`${metrics.iterations} iterations over a budget of ${b.maxIterations}`);
    }
    if (b.maxTokens !== undefined && metrics.totalTokens > b.maxTokens) {
      budgetExceeded.push(`${metrics.totalTokens} tokens over a budget of ${b.maxTokens}`);
    }
    if (b.maxToolCalls !== undefined && metrics.toolCalls > b.maxToolCalls) {
      budgetExceeded.push(`${metrics.toolCalls} tool calls over a budget of ${b.maxToolCalls}`);
    }
  }

  return { failed, budgetExceeded, passed: failed.length === 0 && budgetExceeded.length === 0 };
}

function expectationFailure(
  e: EvalTask["expect"][number],
  trace: RunTrace,
  metrics: RunMetrics,
  policy: DetectorPolicy,
): string | null {
  switch (e.kind) {
    case "status-equals":
      return trace.status === e.status
        ? null
        : `the run ended '${trace.status}'${trace.error ? ` with error "${truncate(trace.error, 120)}"` : ""}`;
    case "final-text-matches": {
      const text = metrics.finalAssistantText;
      if (text === null) return "the run produced no assistant text at all";
      // Compiled here rather than at parse time because the same suite object is reused across
      // attempts; parseSuite has already proved it compiles, so this cannot throw for a valid suite.
      return new RegExp(e.pattern).test(text) ? null : `the final answer did not match /${e.pattern}/`;
    }
    case "tool-was-called":
      return metrics.invocations.some((i) => i.name === e.name) ? null : `${e.name} was never called`;
    case "tool-not-called":
      return metrics.invocations.some((i) => i.name === e.name) ? `${e.name} was called anyway` : null;
    case "no-tool-loop": {
      const run = metrics.longestRepeatRun;
      if (run === null || run.count < DEFAULT_THRESHOLDS.repeatStreak) return null;
      return `${run.name} was called ${run.count} times with identical arguments`;
    }
    case "verified-done": {
      // Passes when the agent made no completion claim — there is nothing to back up. Fails only on
      // the dangerous shape: a claim, and no check that could have contradicted it.
      if (!claimsDone(metrics, policy)) return null;
      return metrics.verificationCalls > 0
        ? null
        : "the agent claimed completion and no evidence-producing call preceded the claim";
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function summarise(a: EvalAttempt): EvalAttemptSummary {
  return {
    taskId: a.taskId,
    repeat: a.repeat,
    model: a.model,
    passed: a.passed,
    failedReasons: a.failed.map((f) => `${describeExpectation(f.expectation)} — but ${f.reason}`),
    budgetExceeded: a.budgetExceeded,
    runId: a.trace.id,
    iterations: a.metrics.iterations,
    totalTokens: a.metrics.totalTokens,
    durationMs: a.metrics.durationMs,
    toolCalls: a.metrics.toolCalls,
    toolFailures: a.metrics.toolFailures,
    deniedCalls: a.metrics.deniedCalls,
    verificationCalls: a.metrics.verificationCalls,
    repeatRatio: a.metrics.repeatRatio,
  };
}

function taskResult(taskId: string, capability: string, model: string, attempts: EvalAttempt[]): EvalTaskResult {
  const passes = attempts.filter((a) => a.passed).length;
  const durations = attempts.map((a) => a.metrics.durationMs).filter((d): d is number => d !== null);
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  return {
    taskId,
    capability,
    model,
    attempts: attempts.length,
    passes,
    passRate: attempts.length === 0 ? 0 : passes / attempts.length,
    meanIterations: mean(attempts.map((a) => a.metrics.iterations)),
    meanTokens: mean(attempts.map((a) => a.metrics.totalTokens)),
    // Null when nothing reported an end. Averaging the known ones and calling it the mean would
    // silently treat an unfinished run as instantaneous.
    meanDurationMs: durations.length === attempts.length && durations.length > 0 ? mean(durations) : null,
  };
}

/**
 * Run the whole suite. Attempts are sequential: a paid evaluation run in parallel spends the same
 * money faster and makes latency incomparable between versions, and latency is one of the axes the
 * guardian compares on.
 *
 * A runner that throws is not caught. Fabricating an attempt for a run that never happened would put
 * a number in the results that no transcript backs, and the three attempts already paid for are
 * returned to nobody — which is the honest outcome for a suite that could not be completed. An abort
 * is different: it is a decision, the attempts that did happen are real, and they are returned with
 * `aborted: true` and left unstored. See `SuiteRun`.
 */
export async function evaluateSuite(ports: AxiomPorts, opts: EvaluateOptions): Promise<SuiteRun> {
  await authorizePaidRun(ports, opts);
  const repeats = Math.max(1, opts.repeats ?? DEFAULT_REPEATS);
  const startedAt = ports.clock.now();
  const attempts: EvalAttempt[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let aborted = false;

  outer: for (const task of opts.suite.tasks) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      if (opts.signal?.aborted) {
        aborted = true;
        break outer;
      }
      const trace = await ports.runner.run({
        task,
        model: opts.model,
        config: opts.config,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const metrics = deriveMetrics(trace, opts.policy);
      const check = checkTask(task, trace, metrics, opts.policy);
      promptTokens += trace.promptTokens;
      completionTokens += trace.completionTokens;
      attempts.push({
        taskId: task.id,
        repeat,
        model: opts.model,
        passed: check.passed,
        failed: check.failed,
        budgetExceeded: check.budgetExceeded,
        metrics,
        trace,
      });
    }
  }

  const summaries = attempts.map(summarise);
  const tasks = opts.suite.tasks.map((t) =>
    taskResult(t.id, t.capability, opts.model, attempts.filter((a) => a.taskId === t.id)),
  );
  const result: SuiteResult = {
    id: ports.ids.next("suite-result"),
    suiteId: opts.suite.id,
    versionId: opts.versionId,
    model: opts.model,
    startedAt,
    endedAt: ports.clock.now(),
    repeats,
    tasks,
    attemptSummaries: summaries,
    passRate: summaries.length === 0 ? 0 : summaries.filter((s) => s.passed).length / summaries.length,
    cost: { promptTokens, completionTokens },
  };

  if (!aborted) await ports.results.putSuiteResult(result);
  return { result, attempts, aborted };
}
