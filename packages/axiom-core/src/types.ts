/**
 * AXIOM — the domain model.
 *
 * Everything AXIOM knows about an agent is one of four things: a **trace** of what it did, a
 * **finding** about why that was wrong, a **version** of its configuration, or a **decision**
 * about whether one version may replace another. Those four are defined here and nowhere else;
 * the stages import them rather than redeclaring near-copies.
 *
 * Two rules shape the types:
 *
 * 1. **A claim carries its evidence.** `Finding.evidence` and `AgentVersion.evidence` are not
 *    optional decoration — the investigator role rejects a finding whose evidence does not
 *    resolve to real steps, and the guardian rejects a promotion whose evidence is empty. An
 *    assertion AXIOM cannot point at is the same defect AXIOM exists to catch in the agent.
 * 2. **"Not reported" is never flattened into zero.** `endedAt`, `durationMs` and the price
 *    estimate are nullable/undefined rather than defaulted, for the reason the data model
 *    chapter gives for `cached_tokens`: a measurement that cannot distinguish "absent" from
 *    "zero" cannot falsify itself.
 */

// ---------------------------------------------------------------------------
// Traces — what the agent did
// ---------------------------------------------------------------------------

/** Mirrors `agent_steps.kind` in the host schema. */
export type StepKind = "assistant" | "tool_call" | "tool_result" | "done" | "denied";

/** Mirrors `agent_runs.status`. `running` means the end was never observed, not that it is live. */
export type RunStatus = "running" | "ok" | "error" | "stopped";

export interface TraceStep {
  seq: number;
  kind: StepKind;
  /** The tool name on a `tool_call`/`tool_result`/`denied` step; free text on `assistant`. */
  label: string | null;
  /** Arguments or output text. Untrusted model/tool content — rendered as text, never as markup. */
  detail: string | null;
  ok: boolean | null;
  /** Epoch ms. */
  ts: number;
}

export interface RunTrace {
  id: string;
  sessionId: string | null;
  /** The delegating run, when this one was spawned by `dispatch_agent`. Null is a top-level run. */
  parentRunId: string | null;
  model: string;
  prompt: string | null;
  status: RunStatus;
  iterations: number;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  promptTokens: number;
  completionTokens: number;
  steps: TraceStep[];
  /** The agent version in force when this ran. Null predates AXIOM's tracking. */
  versionId: string | null;
}

/** One call the agent made, reduced to what the detectors compare. */
export interface ToolInvocation {
  seq: number;
  name: string;
  /** The raw arguments text, exactly as stored. Compared byte-wise to find repeats. */
  args: string;
  /** Set when `args` was present but could not be parsed as a JSON object — a truncated call. */
  argsUnparsed?: boolean;
  ok: boolean | null;
  /** Set when the approval gate refused the call rather than the tool failing. */
  denied?: boolean;
  /** The matching `tool_result`, when one arrived. Absent means the call never answered. */
  resultSeq: number | null;
  /** The result text. Truncated to 500 characters by the host before it was stored. */
  resultDetail: string | null;
}

export interface RunMetrics {
  durationMs: number | null;
  toolCalls: number;
  toolFailures: number;
  deniedCalls: number;
  iterations: number;
  totalTokens: number;
  /** Distinct (name, args) pairs — the denominator of `repeatRatio`. */
  distinctToolCalls: number;
  /** `1 - distinct/total`. Zero when the agent made no tool calls at all. */
  repeatRatio: number;
  /** The longest streak of byte-identical calls, or null when nothing repeated. */
  longestRepeatRun: { name: string; args: string; count: number; firstSeq: number } | null;
  /** A `done` step exists — the agent said it finished. Whether it *was* finished is a finding. */
  claimedDone: boolean;
  /** Seq of the first `done` step, or null when the agent never claimed completion. */
  firstDoneSeq: number | null;
  /**
   * Calls that count as evidence — the loop's own `isVerificationCall`, applied to the trace.
   * The loop's *demand* for evidence is not observable here: it is an automatic user turn, and
   * `agent_steps` records only assistant/tool/done/denied. This counts the answer, not the ask.
   */
  verificationCalls: number;
  /** Calls that never got a `tool_result` or a `denied` — the run ended or the bridge dropped them. */
  unansweredCalls: number;
  /** Every `assistant` step's text, in order. Context-loss detection reads this, not the prompt. */
  assistantTexts: string[];
  /** The last `assistant` step's text — the answer the user actually received. */
  finalAssistantText: string | null;
  invocations: ToolInvocation[];
}

// ---------------------------------------------------------------------------
// Findings — why that was wrong
// ---------------------------------------------------------------------------

export type DetectorId =
  | "premature-success"
  | "tool-loop"
  | "retry-storm"
  | "context-loss"
  | "verification-absent"
  | "waste"
  | "wrong-tool"
  | "runaway"
  | "denied-storm";

/**
 * Where the fault actually is. The whole point of the enum: "the model is weak" is one of six
 * answers, and the other five are cheaper to fix. `diagnose` must name the differential that
 * chose one — see `Finding.rationale`.
 */
export type RootCause = "model" | "prompt" | "memory" | "tool" | "orchestration" | "infra";

export type Severity = "info" | "minor" | "major" | "critical";

export interface Evidence {
  runId: string;
  /** Step seqs the claim rests on. An empty list is a defect the investigator role reports. */
  steps: number[];
  note: string;
}

export interface Finding {
  id: string;
  detector: DetectorId;
  title: string;
  severity: Severity;
  rootCause: RootCause;
  /**
   * The differential that decided `rootCause` — what was compared, and what the comparison
   * showed. A finding without one is an opinion, and the investigator role treats it as such.
   */
  rationale: string;
  /**
   * True when a real comparison settled the cause — the same task on more than one model, failing
   * on some and passing on others. False when the cause is one detector's reading of one transcript.
   * Surfaced because "the model is the problem" is a claim a user will spend money on, and they
   * are entitled to know whether it was measured or inferred.
   */
  differential: boolean;
  evidence: Evidence[];
  /** Number of runs exhibiting this. One run is an anecdote; the guardian weighs the two apart. */
  occurrences: number;
  /** The metric this finding moves, so `design` can target an eval at it. */
  metric: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation — the independent measure
// ---------------------------------------------------------------------------

export type Expectation =
  | { kind: "status-equals"; status: RunStatus }
  | { kind: "final-text-matches"; pattern: string }
  | { kind: "tool-was-called"; name: string }
  | { kind: "tool-not-called"; name: string }
  | { kind: "no-tool-loop" }
  /** Done was claimed *and* an evidence-producing call preceded it. The spec's core rule. */
  | { kind: "verified-done" };

export interface EvalTask {
  id: string;
  /** Grouping key for the capability map. Several tasks may share one capability. */
  capability: string;
  prompt: string;
  expect: Expectation[];
  /** Exceeding a budget fails the task even when the answer is right — cost is a correctness axis. */
  budget?: { maxIterations?: number; maxTokens?: number; maxToolCalls?: number };
  tags?: string[];
}

export interface EvalSuite {
  id: string;
  name: string;
  tasks: EvalTask[];
}

export interface FailedExpectation {
  index: number;
  expectation: Expectation;
  reason: string;
}

export interface EvalAttempt {
  taskId: string;
  repeat: number;
  model: string;
  passed: boolean;
  failed: FailedExpectation[];
  /**
   * Budget lines crossed, in words. Kept apart from `failed` because a task can satisfy every
   * expectation and still be a failure — the right answer at four times the cost is not the same
   * result, and folding the two together hides which one happened.
   */
  budgetExceeded: string[];
  metrics: RunMetrics;
  trace: RunTrace;
}

/**
 * The persistable half of an attempt. The full `EvalAttempt` carries the whole trace, which is
 * what an autopsy needs and what a database row should not: the host already stores eval runs in
 * `agent_runs`, so keeping a second copy here would be a fact in two places. `runId` is the join.
 */
export interface EvalAttemptSummary {
  taskId: string;
  repeat: number;
  model: string;
  passed: boolean;
  failedReasons: string[];
  budgetExceeded: string[];
  runId: string;
  iterations: number;
  totalTokens: number;
  durationMs: number | null;
  /**
   * The detector metrics the guardian compares, denormalised onto the summary. Without them a
   * proposal aimed at `verificationCalls` could only be judged by the pass rate, which would let a
   * change pass by fixing an unrelated task while leaving its actual target untouched.
   */
  toolCalls: number;
  toolFailures: number;
  deniedCalls: number;
  verificationCalls: number;
  repeatRatio: number;
}

export interface EvalTaskResult {
  taskId: string;
  capability: string;
  model: string;
  attempts: number;
  passes: number;
  passRate: number;
  meanIterations: number;
  meanTokens: number;
  /** Null when no attempt reported an end — not zero. */
  meanDurationMs: number | null;
}

export interface SuiteResult {
  id: string;
  suiteId: string;
  /** The agent version that produced these numbers. A result with no version cannot be compared. */
  versionId: string;
  model: string;
  startedAt: number;
  endedAt: number;
  repeats: number;
  tasks: EvalTaskResult[];
  attemptSummaries: EvalAttemptSummary[];
  passRate: number;
  cost: { promptTokens: number; completionTokens: number };
}

/** What `evaluateSuite` hands back: the light record to store, and the traces to inspect. */
export interface SuiteRun {
  result: SuiteResult;
  attempts: EvalAttempt[];
  /**
   * True when the run stopped before every task had been attempted `repeats` times — an abort, or a
   * runner that threw part way through. Such a result is **not persisted**: `benchmark` reuses a
   * stored result whenever suite, version, model and repeat count match, and a partial one matches
   * all four, so storing it would let a half-finished baseline be compared against a complete
   * candidate later. The numbers are still returned, because a stopped run is worth reading; they
   * are just not worth measuring against.
   */
  aborted: boolean;
}

// ---------------------------------------------------------------------------
// Capability map — what it can do, cannot do, and claims but cannot
// ---------------------------------------------------------------------------

export type CapabilityState = "reliable" | "unreliable" | "absent" | "overclaimed";

export interface CapabilityEntry {
  capability: string;
  state: CapabilityState;
  passRate: number;
  tasks: number;
  /**
   * Set when the agent asserted completion on a task whose expectations then failed — the
   * "claims to do but fails to accomplish reliably" column of the spec, which is the one a
   * pass-rate table hides.
   */
  overclaimRuns: number;
  /** Detectors that fired on this capability's tasks, so the map says *why*, not only *that*. */
  findings: DetectorId[];
}

// ---------------------------------------------------------------------------
// Versions — the thing that changes
// ---------------------------------------------------------------------------

/** What AXIOM can actually actuate in v1. Everything else is a recommendation, never a write. */
export type Actuator = "prompt" | "loop-params";

export interface LoopParams {
  maxIterations: number;
  verificationNudgeMax: number;
}

export interface AgentConfig {
  /** Null means "the built-in `AGENT_SYSTEM`", not "no system prompt". */
  promptOverride: string | null;
  loop: LoopParams;
}

export type VersionState = "candidate" | "active" | "retired" | "rejected";

export interface AgentVersion {
  id: string;
  /** Null for the root version — the configuration AXIOM found when it was first pointed here. */
  parentId: string | null;
  createdAt: number;
  config: AgentConfig;
  /** Why this version exists, in the words of whoever proposed it. */
  reason: string;
  targetsFindingIds: string[];
  evidence: Evidence[];
  state: VersionState;
  /** Present once a promotion decision has been made about this version. */
  decisionId: string | null;
}

// ---------------------------------------------------------------------------
// Decisions — whether a version may replace another
// ---------------------------------------------------------------------------

export type RoleId = "investigator" | "architect" | "critic" | "verifier";

export interface RoleVerdict {
  role: RoleId;
  approve: boolean;
  objections: string[];
}

export interface GuardianCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface PromotionDecision {
  id: string;
  candidateId: string;
  baselineId: string;
  model: string;
  decidedAt: number;
  decision: "promote" | "reject";
  checks: GuardianCheck[];
  roles: RoleVerdict[];
  /** Baseline-versus-candidate per metric, kept so the decision can be re-read later. */
  deltas: MetricDelta[];
}

export interface MetricDelta {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  /**
   * Whether the delta clears the noise floor. A change measured once on a stochastic agent is
   * not a result; this is the flag that says so, and the guardian refuses to promote on a
   * targeted metric that fails it.
   */
  beyondNoise: boolean;
}
