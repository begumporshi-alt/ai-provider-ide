/**
 * Test doubles for AXIOM's ports.
 *
 * The important one is `createScriptedRunner`. An end-to-end test of a self-improvement loop is worth
 * nothing if the "improvement" cannot change the agent's behaviour — so the scripted agent reads the
 * configuration it is handed and behaves differently when a patch is present. That makes the loop's
 * central claim testable in the only way that counts: the candidate configuration produces a
 * different transcript, and the guardian measures the difference.
 *
 * `TEST_POLICY` is a **double**, not a copy. The real predicates live in
 * `apps/desktop/src/lib/tools/agentLoop.ts` and are injected by the host; this one is deliberately
 * simpler so a test can predict it. If it ever drifts toward being a faithful reimplementation, that
 * is the bug the module comment in `src/trace.ts` warns about, and it should be deleted instead.
 */
import type { DetectorPolicy } from "../src/trace";
import type { AgentRunnerPort, AxiomPorts, ClockPort, CostEstimate, IdPort, TraceSourcePort } from "../src/ports";
import { MemoryConfigStore, MemoryResultStore, createClock } from "../src/inmemory";
import type { Proposal } from "../src/version";
import type {
  AgentVersion,
  EvalAttemptSummary,
  EvalTask,
  Finding,
  RunStatus,
  RunTrace,
  SuiteResult,
  TraceStep,
} from "../src/types";

export const TEST_POLICY: DetectorPolicy = {
  claimsCompletion: (text) => {
    const t = text.trim();
    if (t === "") return false;
    if (/\b(?:not|isn't|aren't|won't|doesn't|didn't|can't|cannot)\s+(?:yet\s+)?(?:done|fixed|complete|finished|working|passing)\b/i.test(t)) {
      return false;
    }
    return /\b(?:done|fixed|complete|completed|finished|works|working|passing|verified)\b/i.test(t);
  },
  isVerificationCall: (name, args) => {
    if (name === "browser_expect") return true;
    if (name !== "run_command") return false;
    return /\b(?:test|tests|build|typecheck|tsc|lint)\b/i.test(String(args.command ?? ""));
  },
};

export interface ScriptCall {
  name: string;
  args?: Record<string, unknown>;
  /** Default true. `false` records a failing result. */
  ok?: boolean;
  result?: string;
  /** Refused by the approval gate rather than failed by the tool. */
  denied?: boolean;
  /** Milliseconds this call took. Defaults to 10. */
  ms?: number;
}

export interface AgentScript {
  calls: ScriptCall[];
  finalText: string;
  status?: RunStatus;
  error?: string | null;
  iterations?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  /**
   * When the configuration's effective prompt contains this marker, `then` runs instead. That is how
   * a test models "the instruction changed the behaviour" without a model in the loop.
   */
  respondsToMarker?: string;
  then?: AgentScript;
}

export interface ScriptedRunnerOptions {
  paid?: boolean;
  /** Scripts keyed by model, then task id. Overrides `scripts` for that model. */
  byModel?: Record<string, Record<string, AgentScript>>;
  /** Called for every run, so a test can assert what the agent was actually handed. */
  onRun?: (req: { task: EvalTask; model: string; config: { promptOverride: string | null } }) => void;
}

export interface ScriptedRunner extends AgentRunnerPort {
  readonly runs: RunTrace[];
}

let seqCounter = 0;

function resolveScript(
  scripts: Record<string, AgentScript>,
  opts: ScriptedRunnerOptions,
  taskId: string,
  model: string,
  promptOverride: string | null,
): AgentScript | null {
  const fromModel = opts.byModel?.[model]?.[taskId];
  let script = fromModel ?? scripts[taskId] ?? null;
  // Follow the patch chain: a script may hand off to another when its marker is present, and that
  // other may hand off again. Bounded so a cycle in a fixture fails loudly instead of hanging.
  for (let guard = 0; guard < 8 && script; guard += 1) {
    if (!script.respondsToMarker || !script.then) return script;
    if (promptOverride !== null && promptOverride.includes(script.respondsToMarker)) script = script.then;
    else return script;
  }
  return script;
}

function buildTrace(script: AgentScript, task: EvalTask, model: string, clock: ClockPort): RunTrace {
  const runId = `run-${(seqCounter += 1)}`;
  const startedAt = clock.now();
  const steps: TraceStep[] = [];
  let seq = 1;
  let t = startedAt;

  for (const c of script.calls) {
    steps.push({ seq: seq++, kind: "tool_call", label: c.name, detail: JSON.stringify(c.args ?? {}), ok: null, ts: t });
    t += c.ms ?? 10;
    if (c.denied === true) {
      steps.push({ seq: seq++, kind: "denied", label: c.name, detail: c.result ?? "refused by the approval gate", ok: false, ts: t });
    } else {
      steps.push({
        seq: seq++,
        kind: "tool_result",
        label: c.name,
        detail: c.result ?? (c.ok === false ? "failed" : "ok"),
        ok: c.ok ?? true,
        ts: t,
      });
    }
    t += c.ms ?? 10;
  }

  if (script.finalText !== "") {
    steps.push({ seq: seq++, kind: "assistant", label: null, detail: script.finalText, ok: null, ts: t });
  }
  const status = script.status ?? "ok";
  if (status === "ok" || status === "error") {
    steps.push({ seq: seq++, kind: "done", label: null, detail: null, ok: null, ts: t });
  }

  const calls = script.calls.length;
  return {
    id: runId,
    sessionId: null,
    parentRunId: null,
    model,
    prompt: task.prompt,
    status,
    iterations: script.iterations ?? Math.max(1, calls),
    startedAt,
    endedAt: script.durationMs === undefined ? t : startedAt + script.durationMs,
    error: script.error ?? null,
    promptTokens: script.promptTokens ?? 1000 + calls * 100,
    completionTokens: script.completionTokens ?? 200 + calls * 20,
    steps,
    versionId: null,
  };
}

export function createScriptedRunner(
  scripts: Record<string, AgentScript>,
  opts: ScriptedRunnerOptions = {},
  clock: ClockPort = { now: () => Date.now() },
): ScriptedRunner {
  const runs: RunTrace[] = [];
  return {
    paid: opts.paid ?? false,
    runs,
    async run(req) {
      opts.onRun?.({ task: req.task, model: req.model, config: { promptOverride: req.config.promptOverride } });
      const script = resolveScript(scripts, opts, req.task.id, req.model, req.config.promptOverride);
      if (!script) throw new Error(`no script for task ${req.task.id} on model ${req.model}`);
      const built = buildTrace(script, req.task, req.model, clock);
      runs.push(built);
      return built;
    },
  };
}

/**
 * A trace source over an array it does **not** copy, so runs a scripted runner appends later are
 * visible to it. That liveness is the point: `recoverAttempts` re-reads eval traces by run id, and a
 * source that snapshotted at construction would report every eval run as missing.
 */
export function createMemoryTraceSource(runs: RunTrace[]): TraceSourcePort & { push(r: RunTrace): void } {
  const store = runs;
  return {
    push: (r) => store.push(r),
    async listRuns(o) {
      let out = [...store];
      if (o?.sessionId !== undefined && o.sessionId !== null) out = out.filter((r) => r.sessionId === o.sessionId);
      if (o?.sinceTs !== undefined) out = out.filter((r) => r.startedAt >= (o.sinceTs as number));
      out.sort((a, b) => b.startedAt - a.startedAt);
      return o?.limit ? out.slice(0, o.limit) : out;
    },
    async getRun(id) {
      return store.find((r) => r.id === id) ?? null;
    },
  };
}

/** A trace assembled by hand, for detector tests that need one specific shape. */
export function trace(overrides: Partial<RunTrace> & { id: string }): RunTrace {
  return {
    sessionId: null,
    parentRunId: null,
    model: "test/model",
    prompt: null,
    status: "ok",
    iterations: 1,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    error: null,
    promptTokens: 0,
    completionTokens: 0,
    steps: [],
    versionId: null,
    ...overrides,
  };
}

export function call(seq: number, name: string, args: Record<string, unknown> = {}, ts = 0): TraceStep {
  return { seq, kind: "tool_call", label: name, detail: JSON.stringify(args), ok: null, ts };
}

export function result(seq: number, name: string, ok: boolean, detail = "", ts = 0): TraceStep {
  return { seq, kind: "tool_result", label: name, detail, ok, ts };
}

export function said(seq: number, text: string, ts = 0): TraceStep {
  return { seq, kind: "assistant", label: null, detail: text, ok: null, ts };
}

export function done(seq: number, ts = 0): TraceStep {
  return { seq, kind: "done", label: null, detail: null, ok: null, ts };
}

export function refused(seq: number, name: string, ts = 0): TraceStep {
  return { seq, kind: "denied", label: name, detail: "refused", ok: false, ts };
}

export function sequentialIds(prefixMarker = "t"): IdPort {
  let n = 0;
  return { next: (p) => `${p}-${prefixMarker}-${(n += 1)}` };
}

// ---------------------------------------------------------------------------
// A whole port set, for the stage tests that need more than one
// ---------------------------------------------------------------------------

/** Stands in for `AGENT_SYSTEM`. Deliberately short: the prompt-budget check counts characters. */
export const TEST_BUILTIN_PROMPT = "You are an agent. Call tools, then answer.";

export const TEST_LOOP = { maxIterations: 40, verificationNudgeMax: 1 };

export interface TestPorts extends AxiomPorts {
  runner: ScriptedRunner;
  configs: MemoryConfigStore;
  results: MemoryResultStore;
  traces: TraceSourcePort & { push(r: RunTrace): void };
}

/**
 * Wire a full port set over the in-memory stores and a scripted runner. Every stage test that needs
 * persistence, ids and a clock builds the same thing, and building it once is what keeps a fixture
 * bug from being repeated in nine files.
 */
export function createTestPorts(
  scripts: Record<string, AgentScript>,
  opts: ScriptedRunnerOptions = {},
): TestPorts {
  const runner = createScriptedRunner(scripts, opts);
  return {
    runner,
    configs: new MemoryConfigStore(TEST_BUILTIN_PROMPT),
    results: new MemoryResultStore(),
    traces: createMemoryTraceSource(runner.runs),
    ids: sequentialIds(),
    clock: createClock(),
  };
}

/** Add a price book, so a test can assert the consent gate quotes a number rather than nothing. */
export function withPrices(ports: TestPorts, usdPerMillion: { prompt: number; completion: number }): TestPorts {
  return {
    ...ports,
    prices: {
      estimate: (_model, promptTokens, completionTokens) => ({
        usd: (promptTokens / 1e6) * usdPerMillion.prompt + (completionTokens / 1e6) * usdPerMillion.completion,
      }),
    },
  };
}

/** A consent port that records what it was shown and answers `answer`. */
export function withConsent(ports: TestPorts, answer: boolean): TestPorts & { asked: CostEstimate[] } {
  const asked: CostEstimate[] = [];
  return {
    ...ports,
    asked,
    consent: {
      async request(estimate) {
        asked.push(estimate);
        return answer;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Result fixtures, for the guardian and role tests that compare two suite runs
// ---------------------------------------------------------------------------

let summaryCounter = 0;

export function summary(overrides: Partial<EvalAttemptSummary> = {}): EvalAttemptSummary {
  summaryCounter += 1;
  return {
    taskId: "t1",
    repeat: 0,
    model: "test/model",
    passed: true,
    failedReasons: [],
    budgetExceeded: [],
    runId: `run-s${summaryCounter}`,
    iterations: 3,
    totalTokens: 1200,
    durationMs: 1000,
    toolCalls: 2,
    toolFailures: 0,
    deniedCalls: 0,
    verificationCalls: 0,
    repeatRatio: 0,
    ...overrides,
  };
}

/**
 * A `SuiteResult` derived from its attempt summaries, so the task-level pass rates and the overall
 * one cannot disagree with the rows the guardian actually reads.
 */
export function suiteResult(
  summaries: EvalAttemptSummary[],
  overrides: Partial<SuiteResult> & { capabilities?: Record<string, string> } = {},
): SuiteResult {
  const { capabilities, ...rest } = overrides;
  const byTask = new Map<string, EvalAttemptSummary[]>();
  for (const s of summaries) {
    const list = byTask.get(s.taskId);
    if (list) list.push(s);
    else byTask.set(s.taskId, [s]);
  }
  return {
    id: "sr",
    suiteId: "s1",
    versionId: "builtin",
    model: "test/model",
    startedAt: 0,
    endedAt: 1,
    repeats: Math.max(1, ...summaries.map((s) => s.repeat + 1)),
    tasks: [...byTask.entries()].map(([taskId, list]) => ({
      taskId,
      capability: capabilities?.[taskId] ?? taskId,
      model: list[0]?.model ?? "test/model",
      attempts: list.length,
      passes: list.filter((s) => s.passed).length,
      passRate: list.filter((s) => s.passed).length / list.length,
      meanIterations: list.reduce((n, s) => n + s.iterations, 0) / list.length,
      meanTokens: list.reduce((n, s) => n + s.totalTokens, 0) / list.length,
      meanDurationMs: list.every((s) => s.durationMs !== null)
        ? list.reduce((n, s) => n + (s.durationMs ?? 0), 0) / list.length
        : null,
    })),
    attemptSummaries: summaries,
    passRate: summaries.length === 0 ? 0 : summaries.filter((s) => s.passed).length / summaries.length,
    cost: {
      promptTokens: summaries.reduce((n, s) => n + s.totalTokens, 0),
      completionTokens: 0,
    },
    ...rest,
  };
}

export function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    id: "v1",
    parentId: null,
    createdAt: 1,
    config: { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } },
    reason: "Raise verificationNudgeMax from 1 to 2",
    targetsFindingIds: ["f1"],
    evidence: [{ runId: "run-1", steps: [4], note: "two tool calls, then a claim" }],
    state: "candidate",
    decisionId: null,
    ...overrides,
  };
}

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    actuator: "prompt",
    title: "Add an instruction addressing premature-success",
    rationale:
      "Root cause reads as 'prompt', and the actuator for that is the system prompt. One run, one model, " +
      "so this is a hypothesis worth testing.",
    rootCause: "prompt",
    detector: "premature-success",
    targetsFindingIds: ["f1"],
    targetMetric: "verificationCalls",
    evidence: [{ runId: "run-1", steps: [4], note: "two tool calls, then a claim" }],
    patch: { marker: "axiom:premature-success", detector: "premature-success", text: "Check before claiming." },
    ...overrides,
  };
}

export function aFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    detector: "premature-success",
    title: "Claimed completion with no check",
    severity: "critical",
    rootCause: "prompt",
    rationale: "One run of this task, on one model. No differential was available.",
    differential: false,
    evidence: [{ runId: "run-1", steps: [4], note: "two tool calls, then a claim" }],
    occurrences: 2,
    metric: "verificationCalls",
    ...overrides,
  };
}
