/**
 * The seven stages, wired end to end.
 *
 * ```
 * 01 Observe   → traces from the agent's own history
 * 02 Evaluate  → a suite run against a configuration, repeated, measured
 * 03 Diagnose  → detectors per run, then a differential across runs
 * 04 Design    → one proposal per finding, actuator chosen by root cause
 * 05 Modify    → a candidate version, immutable, parented, never active on creation
 * 06 Validate  → the guardian's arithmetic and four roles' objections
 * 07 Evolve    → promote or reject, and keep the old version so it can be rolled back to
 * ```
 *
 * Two properties make the loop trustworthy rather than merely automated.
 *
 * **Versions are immutable, so a measurement is reusable.** A `SuiteResult` is keyed by the
 * `versionId` that produced it, and a version's configuration never changes after it is written.
 * So a baseline measured once is a baseline forever, and `improve` looks one up before spending
 * money to reproduce it. That is not a cache with a TTL waiting to go stale — it is a fact about an
 * object that cannot change.
 *
 * **Nothing is promoted on the agent's own word.** The decision comes from `runGuardian` plus four
 * roles, over a suite whose expectations read the transcript. An agent that says "fixed" and is not
 * believed is the whole subject of this package; it would be a strange design to believe it here.
 */
import { autopsy, type Autopsy } from "./autopsy";
import { buildCapabilityMap, toCapabilityAttempts, type CapabilityAttempt, type CapabilityMapInput } from "./capability";
import { diagnose, observe, type DiagnoseReport, type ObservedRun } from "./diagnose";
import { DEFAULT_THRESHOLDS, type DetectorThresholds } from "./detectors";
import { DEFAULT_REPEATS, evaluateSuite, type EvaluateOptions } from "./evaluate";
import { DEFAULT_GUARDIAN, runGuardian, type GuardianOptions, type GuardianReport } from "./guardian";
import { hash32 } from "./hash";
import type { AxiomPorts } from "./ports";
import { conveneRoles } from "./roles";
import { deriveMetrics, type DetectorPolicy } from "./trace";
import { buildCandidate, design, type Proposal } from "./version";
import type {
  AgentConfig,
  AgentVersion,
  CapabilityEntry,
  EvalAttempt,
  EvalSuite,
  Finding,
  PromotionDecision,
  RunTrace,
  SuiteResult,
} from "./types";

/**
 * The family name for the configuration AXIOM found in place — the built-in prompt and the loop's
 * compiled-in parameters. It has no row of its own, because inventing one would mean writing a
 * version nobody chose.
 *
 * Results are not keyed by this constant but by `builtinVersionId` below, which is content-keyed:
 * the built-in configuration changes when the code changes, and a baseline measured against
 * yesterday's prompt must not be reused as a baseline for today's.
 */
export const BUILTIN_VERSION_ID = "builtin";

/**
 * The reusable key for a builtin measurement: a hash of the built-in prompt and the loop
 * parameters the benchmark would run with. When the code changes either, the hash changes, the
 * reuse lookup in `benchmark` misses, and the baseline is measured again — sound, because the
 * only thing that made reuse sound was that the configuration could not change underneath it.
 */
export function builtinVersionId(prompt: string, loop: { maxIterations: number; verificationNudgeMax: number }): string {
  return `builtin-${hash32(`${prompt}\n${loop.maxIterations}:${loop.verificationNudgeMax}`)}`;
}

export interface AxiomConfig {
  /** The agent loop's own predicates. Required — see trace.ts for why there is no default. */
  policy: DetectorPolicy;
  thresholds?: DetectorThresholds;
  guardian?: Partial<GuardianOptions>;
  repeats?: number;
  /**
   * How many production runs `observe` reads. Bounded because an audit that loads every run ever
   * recorded is an audit that does not finish.
   */
  runLimit?: number;
  maxProposals?: number;
}

export interface Observation {
  runs: RunTrace[];
  observed: ObservedRun[];
  examinedAt: number;
  totals: {
    runs: number;
    ok: number;
    error: number;
    stopped: number;
    /** Recorded as running and never ended — which is also what a session closed mid-run leaves. */
    unfinished: number;
    toolCalls: number;
    totalTokens: number;
    /** Null when no run reported an end. Not zero. */
    durationMs: number | null;
  };
}

export interface BenchmarkOutcome {
  result: SuiteResult;
  attempts: EvalAttempt[];
  /** What the capability map can be built from, whether the run was fresh or reused. */
  capabilityAttempts: CapabilityAttempt[];
  reused: boolean;
  /**
   * True when this outcome's numbers came from a run that stopped early. Surfaced because the caller
   * has to treat them differently: worth reading, not worth measuring against (see `SuiteRun.aborted`).
   * Always false for a reused result — a stored one is by construction a run that finished.
   */
  aborted: boolean;
}

export interface ValidationResult {
  candidate: AgentVersion | null;
  candidateResult: SuiteResult | null;
  candidateAttempts: CapabilityAttempt[];
  guardian: GuardianReport | null;
  decision: PromotionDecision | null;
  /** Set instead of a decision when nothing could be put to the test. */
  refusal: string | null;
}

export interface ImproveReport {
  observation: Observation;
  diagnosis: DiagnoseReport;
  baseline: SuiteResult;
  proposals: Proposal[];
  attempted: Proposal | null;
  candidate: AgentVersion | null;
  candidateResult: SuiteResult | null;
  guardian: GuardianReport | null;
  decision: PromotionDecision | null;
  capabilityMap: CapabilityEntry[];
  /** Whose numbers the map above shows. A map with no label is a map the reader will misattribute. */
  capabilityMapOf: "baseline" | "candidate" | "none";
  /**
   * What AXIOM did not do, and why. Reported explicitly because a summary listing only what happened
   * reads as a summary of everything, and the gap is the part a user needs.
   */
  notDone: string[];
}

export interface Axiom {
  observe(): Promise<Observation>;
  diagnoseOf(runs: RunTrace[], maxIterations: number): DiagnoseReport;
  autopsyOf(runId: string): Promise<Autopsy | null>;
  benchmark(opts: {
    suite: EvalSuite;
    model: string;
    versionId: string;
    config: AgentConfig;
    repeats?: number;
    signal?: AbortSignal;
  }): Promise<BenchmarkOutcome>;
  capabilityMap(input: CapabilityMapInput): CapabilityEntry[];
  propose(input: { findings: Finding[]; active: AgentConfig }): Proposal[];
  validate(input: {
    suite: EvalSuite;
    model: string;
    proposal: Proposal;
    baseline: SuiteResult;
    baselineVersion: AgentVersion | null;
    /**
     * The id the baseline's numbers are keyed under, when the caller already knows it. When the
     * baseline is the built-in configuration this is the content-keyed form from `builtinVersionId`,
     * not the `BUILTIN_VERSION_ID` family name — a decision should name the configuration its
     * numbers actually came from.
     */
    baselineId?: string;
    signal?: AbortSignal;
  }): Promise<ValidationResult>;
  improve(input: { suite: EvalSuite; model: string; signal?: AbortSignal }): Promise<ImproveReport>;
  rollback(): Promise<{ restored: AgentVersion | null; retired: AgentVersion | null; refusal: string | null }>;
  history(): Promise<AgentVersion[]>;
}

export function createAxiom(ports: AxiomPorts, config: AxiomConfig): Axiom {
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
  const guardianOpts: GuardianOptions = { ...DEFAULT_GUARDIAN, ...(config.guardian ?? {}) };
  const repeats = config.repeats ?? DEFAULT_REPEATS;
  const runLimit = config.runLimit ?? 200;

  async function observeRuns(): Promise<Observation> {
    const runs = await ports.traces.listRuns({ limit: runLimit });
    const observed = observe(runs, config.policy);
    const durations = observed.map((o) => o.metrics.durationMs).filter((d): d is number => d !== null);
    const count = (s: RunTrace["status"]) => runs.filter((r) => r.status === s).length;
    return {
      runs,
      observed,
      examinedAt: ports.clock.now(),
      totals: {
        runs: runs.length,
        ok: count("ok"),
        error: count("error"),
        stopped: count("stopped"),
        unfinished: count("running"),
        toolCalls: observed.reduce((n, o) => n + o.metrics.toolCalls, 0),
        totalTokens: observed.reduce((n, o) => n + o.metrics.totalTokens, 0),
        durationMs: durations.length === 0 ? null : durations.reduce((s, d) => s + d, 0),
      },
    };
  }

  /**
   * Recover what the capability map needs from a reused baseline. The host stores eval runs in
   * `agent_runs`, so the transcripts are usually still there behind the summary's `runId`. When they
   * are not — a fixture runner that never persisted — the map comes back empty and `improve` says so
   * rather than presenting an empty map as a clean bill of health.
   */
  async function recoverAttempts(result: SuiteResult): Promise<CapabilityAttempt[]> {
    const out: CapabilityAttempt[] = [];
    for (const s of result.attemptSummaries) {
      const trace = await ports.traces.getRun(s.runId);
      if (!trace) continue;
      out.push({ taskId: s.taskId, passed: s.passed, runId: s.runId, metrics: deriveMetrics(trace, config.policy) });
    }
    return out;
  }

  async function benchmark(opts: {
    suite: EvalSuite;
    model: string;
    versionId: string;
    config: AgentConfig;
    repeats?: number;
    signal?: AbortSignal;
  }): Promise<BenchmarkOutcome> {
    const n = opts.repeats ?? repeats;
    // Reuse is sound because a version is immutable: the configuration that produced a stored result
    // is the configuration this call would run.
    const prior = await ports.results.listSuiteResults({ suiteId: opts.suite.id, versionId: opts.versionId });
    const reusable = prior.find((r) => r.model === opts.model && r.repeats === n);
    if (reusable) {
      return { result: reusable, attempts: [], capabilityAttempts: await recoverAttempts(reusable), reused: true, aborted: false };
    }

    const evalOpts: EvaluateOptions = {
      suite: opts.suite,
      model: opts.model,
      config: opts.config,
      versionId: opts.versionId,
      policy: config.policy,
      repeats: n,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const run = await evaluateSuite(ports, evalOpts);
    return {
      result: run.result,
      attempts: run.attempts,
      capabilityAttempts: toCapabilityAttempts(run.attempts),
      reused: false,
      aborted: run.aborted,
    };
  }

  async function validate(input: {
    suite: EvalSuite;
    model: string;
    proposal: Proposal;
    baseline: SuiteResult;
    baselineVersion: AgentVersion | null;
    baselineId?: string;
    signal?: AbortSignal;
  }): Promise<ValidationResult> {
    const nothing: ValidationResult = {
      candidate: null,
      candidateResult: null,
      candidateAttempts: [],
      guardian: null,
      decision: null,
      refusal: null,
    };
    if (input.proposal.actuator === "manual") {
      return { ...nothing, refusal: input.proposal.blockedReason ?? "This proposal is a recommendation; there is nothing to apply." };
    }

    const basePrompt = await ports.configs.builtinPrompt();
    const built = buildCandidate({
      id: ports.ids.next("version"),
      parent: input.baselineVersion,
      proposal: input.proposal,
      basePrompt,
      createdAt: ports.clock.now(),
    });
    if (!built.ok) return { ...nothing, refusal: built.refusal };

    await ports.configs.put(built.version);
    const cand = await benchmark({
      suite: input.suite,
      model: input.model,
      versionId: built.version.id,
      config: built.version.config,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // A stopped run is reported, never judged. Comparing a candidate that got through half its tasks
    // against a complete baseline would read as a regression the candidate did not cause, and the
    // decision would then be recorded as though it had been measured. The version stays a
    // 'candidate' — built, undecided — which is inert: only an 'active' version changes what runs.
    if (cand.aborted) {
      return {
        candidate: built.version,
        candidateResult: cand.result,
        candidateAttempts: cand.capabilityAttempts,
        guardian: null,
        decision: null,
        refusal:
          `The candidate's run stopped before every task had been attempted, so ${built.version.id} was left ` +
          `a candidate with no decision rather than judged on numbers that are missing tasks.`,
      };
    }

    const findings = await ports.results.listFindings();
    const guardian = runGuardian({
      baseline: input.baseline,
      candidate: cand.result,
      candidateVersion: built.version,
      baselineVersion: input.baselineVersion,
      proposal: input.proposal,
      findings,
      // The base the candidate's override was built on. `buildCandidate` appended to exactly this
      // string, so the guardian can tell a patch from text the markers cannot see.
      builtinPrompt: basePrompt,
      options: guardianOpts,
    });

    const roles = conveneRoles({
      proposal: input.proposal,
      findings,
      suite: input.suite,
      baseline: input.baseline,
      candidate: cand.result,
      baselineVersion: input.baselineVersion,
      candidateVersion: built.version,
      guardian,
    });

    const promote = guardian.passed && roles.every((r) => r.approve);
    const decision: PromotionDecision = {
      id: ports.ids.next("decision"),
      candidateId: built.version.id,
      baselineId: input.baselineId ?? input.baselineVersion?.id ?? BUILTIN_VERSION_ID,
      model: input.model,
      decidedAt: ports.clock.now(),
      decision: promote ? "promote" : "reject",
      checks: guardian.checks,
      roles,
      deltas: guardian.deltas,
    };

    // 07 Evolve. The losing version is kept, not deleted: rollback is only possible because the
    // thing rolled back to was never destroyed.
    await ports.results.putDecision(decision);
    await ports.configs.linkDecision(built.version.id, decision.id);
    await ports.configs.setState(built.version.id, promote ? "active" : "rejected");
    if (promote && input.baselineVersion) {
      await ports.configs.setState(input.baselineVersion.id, "retired");
    }

    return {
      candidate: built.version,
      candidateResult: cand.result,
      candidateAttempts: cand.capabilityAttempts,
      guardian,
      decision,
      refusal: null,
    };
  }

  async function improve(input: { suite: EvalSuite; model: string; signal?: AbortSignal }): Promise<ImproveReport> {
    const notDone: string[] = [];
    const observation = await observeRuns();
    const active = await ports.configs.effectiveConfig();
    const baselineVersion = await ports.configs.activeVersion();
    // Content-keyed when the baseline is the built-in configuration, so an app update that changed
    // the built-in prompt or the loop defaults cannot silently reuse a baseline measured against
    // what the configuration used to be.
    const versionId = baselineVersion?.id ?? builtinVersionId(await ports.configs.builtinPrompt(), active.loop);

    const base = await benchmark({
      suite: input.suite,
      model: input.model,
      versionId,
      config: active,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // The diagnosis reads both histories: what the agent did in production, and what it did under
    // the suite. Production runs are where the real failures are; suite runs are where they become
    // comparable, because the same prompt went to more than one configuration.
    const diagnosis = diagnose({
      runs: [...observation.runs, ...base.attempts.map((a) => a.trace)],
      policy: config.policy,
      thresholds,
      maxIterations: active.loop.maxIterations,
    });
    await ports.results.putFindings(diagnosis.findings);

    if (base.capabilityAttempts.length === 0) {
      notDone.push(
        "The baseline's attempt transcripts could not be recovered, so the capability map's overclaim column " +
          "cannot be filled from it — an unbacked success claim needs the transcript, not the summary.",
      );
    }
    if (base.reused) {
      notDone.push(
        `The baseline for ${input.suite.id} on ${input.model} was reused from a stored result rather than ` +
          `re-run. Sound because versions are immutable, but it means no fresh eval traces entered the diagnosis.`,
      );
    }

    const proposals = design({ findings: diagnosis.findings, active, ids: ports.ids, limit: config.maxProposals });
    for (const p of proposals) {
      if (p.actuator === "manual") notDone.push(`${p.title}: ${p.blockedReason ?? "no actuator applies"}`);
    }

    const baselineMap = buildCapabilityMap({
      result: base.result,
      attempts: base.capabilityAttempts,
      policy: config.policy,
      findings: diagnosis.findings,
    });

    if (base.aborted) {
      notDone.push(
        `The baseline run stopped after ${base.result.attemptSummaries.length} attempt(s), so the pass rate shown is of ` +
          `what ran rather than of the whole suite, and no candidate was built from the proposals above — validating ` +
          `one against a half-measured baseline would produce a decision no measurement supports.`,
      );
      return {
        observation,
        diagnosis,
        baseline: base.result,
        proposals,
        attempted: null,
        candidate: null,
        candidateResult: null,
        guardian: null,
        decision: null,
        capabilityMap: baselineMap,
        capabilityMapOf: baselineMap.length > 0 ? "baseline" : "none",
        notDone,
      };
    }

    const applicable = proposals.filter((p) => p.actuator !== "manual");
    const target = applicable[0];
    if (!target) {
      notDone.push(
        proposals.length === 0
          ? "No finding was produced, so there was nothing to propose."
          : "Every finding mapped to a recommendation AXIOM cannot apply in v1, so no candidate was built.",
      );
      return {
        observation,
        diagnosis,
        baseline: base.result,
        proposals,
        attempted: null,
        candidate: null,
        candidateResult: null,
        guardian: null,
        decision: null,
        capabilityMap: baselineMap,
        capabilityMapOf: baselineMap.length > 0 ? "baseline" : "none",
        notDone,
      };
    }
    if (applicable.length > 1) {
      notDone.push(
        `${applicable.length - 1} further applicable proposal(s) were left unattempted: one change per version, ` +
          `because a version carrying two edits cannot be attributed when the numbers move.`,
      );
    }

    const v = await validate({
      suite: input.suite,
      model: input.model,
      proposal: target,
      baseline: base.result,
      baselineVersion,
      baselineId: versionId,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (v.refusal) notDone.push(`No candidate was validated: ${v.refusal}`);
    if (v.decision?.decision === "reject") {
      const blocking = [
        ...v.decision.checks.filter((c) => !c.passed).map((c) => c.label),
        ...v.decision.roles.filter((r) => !r.approve).map((r) => `${r.role} (${r.objections.length} objection(s))`),
      ];
      notDone.push(
        `The candidate was rejected and retained as 'rejected' rather than deleted. Blocked by: ${blocking.join("; ")}.`,
      );
    }
    if (v.decision?.decision === "promote") {
      notDone.push(
        "Promotion changes which configuration is active; it re-runs nothing already recorded. Findings from " +
          "before the promotion stay in the register until a later pass re-examines them.",
      );
    }

    const candidateMap =
      v.candidateResult && v.candidateAttempts.length > 0
        ? buildCapabilityMap({
            result: v.candidateResult,
            attempts: v.candidateAttempts,
            policy: config.policy,
            findings: diagnosis.findings,
          })
        : null;

    return {
      observation,
      diagnosis,
      baseline: base.result,
      proposals,
      attempted: target,
      candidate: v.candidate,
      candidateResult: v.candidateResult,
      guardian: v.guardian,
      decision: v.decision,
      capabilityMap: candidateMap ?? baselineMap,
      capabilityMapOf: candidateMap ? "candidate" : baselineMap.length > 0 ? "baseline" : "none",
      notDone,
    };
  }

  async function rollback() {
    const active = await ports.configs.activeVersion();
    if (!active) {
      return { restored: null, retired: null, refusal: "No version is active; the agent is running its built-in configuration." };
    }
    if (active.parentId === null) {
      return {
        restored: null,
        retired: active,
        refusal: `Version ${active.id} has no parent to roll back to. Retiring it would restore the built-in configuration.`,
      };
    }
    const parent = await ports.configs.getVersion(active.parentId);
    if (!parent) {
      return { restored: null, retired: null, refusal: `Parent ${active.parentId} is missing from the chain; refusing to guess.` };
    }
    await ports.configs.setState(active.id, "retired");
    await ports.configs.setState(parent.id, "active");
    return { restored: parent, retired: active, refusal: null };
  }

  return {
    observe: observeRuns,
    diagnoseOf: (runs, maxIterations) => diagnose({ runs, policy: config.policy, thresholds, maxIterations }),
    autopsyOf: async (runId) => {
      const trace = await ports.traces.getRun(runId);
      if (!trace) return null;
      const findings = await ports.results.listFindings();
      return autopsy({ trace, policy: config.policy, findings });
    },
    benchmark,
    capabilityMap: (i) => buildCapabilityMap(i),
    propose: (i) => design({ findings: i.findings, active: i.active, ids: ports.ids, limit: config.maxProposals }),
    validate,
    improve,
    rollback,
    history: () => ports.configs.listVersions(),
  };
}
