/**
 * Stage 03 — **Diagnose**, part one: what a single run shows.
 *
 * A detector is a pure function from one run to zero or more hits. Each hit carries a
 * **provisional** root cause and the list of causes it could still turn out to be. That split is
 * the whole method: no single run can tell you whether an agent failed because the model is weak
 * or because the instructions are weak — both produce the same transcript. What distinguishes them
 * is comparison across runs, which is `diagnose.ts`'s job. A detector that named one cause
 * outright would be laundering a guess into a fact before any comparison happened.
 *
 * Every hit also carries the step seqs it rests on. An empty evidence list is not a style problem;
 * the investigator role rejects the finding, because an assertion AXIOM cannot point at is the
 * exact defect AXIOM exists to catch in the agent.
 */
import { claimsDone, parseArgs, type DetectorPolicy } from "./trace";
import type { DetectorId, Evidence, RootCause, RunMetrics, RunTrace, Severity } from "./types";

export interface DetectorThresholds {
  /** Identical (name, args) calls in a row before the run counts as stuck. */
  repeatStreak: number;
  /** Failures of one tool — args may differ — before the tool itself counts as unreliable. */
  toolFailureCount: number;
  /** Approval-gate refusals in one run before the agent counts as fighting its own boundary. */
  deniedCount: number;
  /** Fraction of the iteration ceiling at which a run counts as runaway rather than thorough. */
  iterationRatio: number;
  /** Identical successful reads of the same target before it counts as forgotten context. */
  rereadCount: number;
}

export const DEFAULT_THRESHOLDS: DetectorThresholds = {
  repeatStreak: 3,
  toolFailureCount: 3,
  deniedCount: 3,
  iterationRatio: 0.8,
  rereadCount: 2,
};

export interface DetectorHit {
  detector: DetectorId;
  title: string;
  severity: Severity;
  /**
   * The cause the evidence in *this* run supports, before any cross-run comparison. Typed to exclude
   * `model` on purpose: no single transcript can distinguish a weak model from weak instructions, so
   * a detector that named the model would be laundering a guess into a fact. Only `diagnose`'s
   * cross-model differential may assign it, and the type is what makes that rule hold when someone
   * adds the tenth detector.
   */
  provisionalCause: Exclude<RootCause, "model">;
  /** Causes still in play. `diagnose` narrows this; a hit with none is already unambiguous. */
  alternatives: RootCause[];
  evidence: Evidence;
  /** The metric this moves, so a proposal can be aimed at an eval that measures it. */
  metric: string | null;
}

export interface DetectorInput {
  trace: RunTrace;
  metrics: RunMetrics;
  policy: DetectorPolicy;
  thresholds: DetectorThresholds;
  /** The iteration ceiling the run was actually given, from its version's loop params. */
  maxIterations: number;
}

type Detector = (input: DetectorInput) => DetectorHit[];

function ev(trace: RunTrace, steps: number[], note: string): Evidence {
  return { runId: trace.id, steps, note };
}

/**
 * Where a hit points when there are no tool calls to point at.
 *
 * Both budget detectors quote invocations, and a run can exhaust its budget or its tokens without
 * ever calling a tool — a loop that reasons and re-reasons is the clearest example. An empty `steps`
 * list is rejected by the investigator, so the hit would be dropped and the run's real defect would
 * go unreported. The transcript's last step is the run's own ending, which is always the right thing
 * to point at when there is nothing else. Empty only when the trace itself is empty, where there is
 * genuinely nothing to cite.
 */
function anchor(trace: RunTrace, seqs: number[]): number[] {
  if (seqs.length > 0) return seqs;
  let last: number | null = null;
  for (const s of trace.steps) if (last === null || s.seq > last) last = s.seq;
  return last === null ? [] : [last];
}

/**
 * Claimed the work was done, did work, and ran nothing that checks it.
 *
 * The dangerous shape, and the one the loop's own verification gate exists to catch. When it still
 * appears in a trace there are two explanations and one run cannot separate them: the gate never
 * fired (orchestration — e.g. the claim landed in the budget's final round, which is exempt by
 * design) or it fired and the model re-claimed without verifying (prompt or model). `diagnose`
 * separates them by asking whether the same thing happens on other models.
 */
const prematureSuccess: Detector = ({ trace, metrics, policy }) => {
  if (!metrics.claimedDone) return [];
  if (!claimsDone(metrics, policy)) return [];
  if (metrics.verificationCalls > 0) return [];
  if (metrics.toolCalls === 0) return [];
  const doneSeq = metrics.firstDoneSeq ?? trace.steps.length;
  return [
    {
      detector: "premature-success",
      title: "Claimed completion after doing work, with no check that the work holds",
      severity: "critical",
      provisionalCause: "prompt",
      alternatives: ["model", "orchestration"],
      evidence: ev(
        trace,
        [doneSeq],
        `${metrics.toolCalls} tool calls, ${metrics.verificationCalls} of them evidence-producing, then a completion claim at seq ${doneSeq}.`,
      ),
      metric: "verificationCalls",
    },
  ];
};

/**
 * Claimed completion having done nothing at all. Separated from `premature-success` because the
 * fix differs: unverified work is a missing check, whereas this is an answer manufactured from the
 * prompt alone, and no amount of tooling changes a run that never reached for a tool.
 */
const verificationAbsent: Detector = ({ trace, metrics, policy }) => {
  if (!metrics.claimedDone) return [];
  if (!claimsDone(metrics, policy)) return [];
  if (metrics.toolCalls > 0) return [];
  const doneSeq = metrics.firstDoneSeq ?? trace.steps.length;
  return [
    {
      detector: "verification-absent",
      title: "Asserted the task was complete without calling a single tool",
      severity: "critical",
      provisionalCause: "prompt",
      alternatives: ["model"],
      evidence: ev(trace, [doneSeq], "Zero tool calls in the whole run; the claim is the answer itself."),
      metric: "verificationCalls",
    },
  ];
};

/**
 * The same call, byte-identical, several times in a row. The agent is not adapting: whatever the
 * last result said, the next decision was the same decision.
 */
const toolLoop: Detector = ({ trace, metrics, thresholds }) => {
  const run = metrics.longestRepeatRun;
  if (run === null || run.count < thresholds.repeatStreak) return [];
  const seqs = metrics.invocations
    .filter((i) => i.name === run.name && i.args === run.args)
    .map((i) => i.seq);
  return [
    {
      detector: "tool-loop",
      title: `Called ${run.name} ${run.count} times with identical arguments`,
      severity: "major",
      provisionalCause: "orchestration",
      alternatives: ["prompt", "tool"],
      evidence: ev(trace, seqs, "Identical arguments produce identical results; repeating is not a new attempt."),
      metric: "repeatRatio",
    },
  ];
};

/**
 * One tool failing repeatedly, with *differing* arguments each time. Distinct from `tool-loop` on
 * purpose: identical repetition is the agent failing to adapt, whereas varied attempts that all
 * fail point at the tool or the integration behind it — "broken integration" in the spec's sense.
 */
const retryStorm: Detector = ({ trace, metrics, thresholds }) => {
  const failedByName = new Map<string, number[]>();
  for (const inv of metrics.invocations) {
    if (inv.ok !== false || inv.denied === true) continue;
    const list = failedByName.get(inv.name);
    if (list) list.push(inv.seq);
    else failedByName.set(inv.name, [inv.seq]);
  }
  const hits: DetectorHit[] = [];
  for (const [name, seqs] of failedByName) {
    if (seqs.length < thresholds.toolFailureCount) continue;
    const distinctArgs = new Set(
      metrics.invocations.filter((i) => i.name === name && seqs.includes(i.seq)).map((i) => i.args),
    ).size;
    hits.push({
      detector: "retry-storm",
      title: `${name} failed ${seqs.length} times across ${distinctArgs} distinct argument sets`,
      severity: "major",
      provisionalCause: distinctArgs > 1 ? "tool" : "orchestration",
      alternatives: distinctArgs > 1 ? ["infra", "prompt"] : ["tool", "prompt"],
      evidence: ev(
        trace,
        seqs,
        distinctArgs > 1
          ? "Varied arguments all failed — the tool or its integration is the common factor, not the agent's choice."
          : "Same arguments each time — see tool-loop; counted here because the calls also failed.",
      ),
      metric: "toolFailures",
    });
  }
  return hits;
};

/**
 * The approval gate refused the agent repeatedly. Either the agent was not told where its boundary
 * is, or the boundary is wrong for the task it was given. Both are configuration, not model.
 */
const deniedStorm: Detector = ({ trace, metrics, thresholds }) => {
  if (metrics.deniedCalls < thresholds.deniedCount) return [];
  const seqs = metrics.invocations.filter((i) => i.denied === true).map((i) => i.seq);
  const names = [...new Set(metrics.invocations.filter((i) => i.denied === true).map((i) => i.name))];
  return [
    {
      detector: "denied-storm",
      title: `${metrics.deniedCalls} tool calls refused (${names.join(", ")})`,
      severity: "major",
      provisionalCause: "prompt",
      alternatives: ["tool", "orchestration"],
      evidence: ev(trace, seqs, "A refusal is a boundary the agent kept walking into rather than around."),
      metric: "deniedCalls",
    },
  ];
};

/**
 * A call whose own result says the arguments were wrong. The matcher is a heuristic and is stated
 * as one: it looks for the words a schema or argument validator complains with. That makes it
 * falsifiable — read the matched result text in the evidence and see whether it really was an
 * argument complaint — which is the standard the rest of this package holds itself to.
 */
const ARGUMENT_COMPLAINT =
  /\b(?:invalid|unexpected|unknown|missing|required|must be|expected|not a valid|unrecogni[sz]ed)\b[\s\S]{0,80}\b(?:argument|parameter|field|option|tool|command|value|type)\b/i;

const wrongTool: Detector = ({ trace, metrics }) => {
  const seqs: number[] = [];
  const samples: string[] = [];
  for (const inv of metrics.invocations) {
    if (inv.ok !== false || inv.denied === true) continue;
    const text = inv.resultDetail ?? "";
    if (!ARGUMENT_COMPLAINT.test(text)) continue;
    seqs.push(inv.seq);
    if (samples.length < 2) samples.push(text.slice(0, 160));
  }
  if (seqs.length === 0) return [];
  return [
    {
      detector: "wrong-tool",
      title: `${seqs.length} calls rejected on their arguments`,
      severity: "minor",
      provisionalCause: "tool",
      alternatives: ["prompt", "model"],
      evidence: ev(trace, seqs, `Result text read as an argument complaint, e.g. "${samples[0] ?? ""}"`),
      metric: "toolFailures",
    },
  ];
};

/**
 * Successful, identical re-reads of something the agent had already been given. The observable
 * signature of context loss: the information was in the transcript and the agent went and fetched
 * it again. Only *successful* reads count — re-reading after a failure is a retry, not a lapse.
 *
 * Restricted to read-shaped tools. Re-running a build or a test with the same arguments is normal
 * work, and counting it as forgetfulness would make this detector fire on exactly the verification
 * behaviour AXIOM is trying to encourage.
 */
const READ_TOOLS = new Set(["read_file", "list_dir", "file_info", "read_document", "read_image", "glob", "search_files"]);

const contextLoss: Detector = ({ trace, metrics, thresholds }) => {
  const seen = new Map<string, number[]>();
  for (const inv of metrics.invocations) {
    if (!READ_TOOLS.has(inv.name)) continue;
    if (inv.ok !== true) continue;
    const key = `${inv.name}\u0000${inv.args}`;
    const list = seen.get(key);
    if (list) list.push(inv.seq);
    else seen.set(key, [inv.seq]);
  }
  const hits: DetectorHit[] = [];
  for (const [key, seqs] of seen) {
    if (seqs.length < thresholds.rereadCount) continue;
    const name = key.split("\u0000")[0] ?? "?";
    hits.push({
      detector: "context-loss",
      title: `${name} re-read ${seqs.length} times with identical arguments, successfully each time`,
      severity: "minor",
      provisionalCause: "memory",
      alternatives: ["prompt", "model"],
      evidence: ev(trace, seqs, "The first read succeeded, so the answer was already in the transcript."),
      metric: "repeatRatio",
    });
  }
  return hits;
};

/**
 * The run consumed its budget. Two shapes are folded into one detector because they share a fix:
 * hitting the iteration ceiling, or spending tokens out of proportion to the tool calls that
 * produced anything. `waste` is the token half, `runaway` the ceiling half.
 */
const runaway: Detector = ({ trace, metrics, thresholds, maxIterations }) => {
  const ceiling = Math.max(1, Math.floor(maxIterations * thresholds.iterationRatio));
  if (metrics.iterations < ceiling) return [];
  return [
    {
      detector: "runaway",
      title: `Used ${metrics.iterations} of ${maxIterations} iterations`,
      severity: trace.status === "error" ? "critical" : "major",
      provisionalCause: "orchestration",
      alternatives: ["prompt", "model"],
      evidence: ev(
        trace,
        anchor(trace, metrics.invocations.slice(-3).map((i) => i.seq)),
        `At or past ${thresholds.iterationRatio * 100}% of the ceiling; ended '${trace.status}'.`,
      ),
      metric: "iterations",
    },
  ];
};

const waste: Detector = ({ trace, metrics, maxIterations }) => {
  // Tokens per unit of forward progress. A run that burns 40k tokens to make two distinct calls is
  // spending on reasoning that is not becoming action. The ceiling-relative form keeps the threshold
  // meaningful for both a 40-iteration budget and a 250-iteration one.
  if (metrics.totalTokens <= 0) return [];
  const perCall = metrics.distinctToolCalls > 0 ? metrics.totalTokens / metrics.distinctToolCalls : metrics.totalTokens;
  const allowance = 2000 * Math.max(1, maxIterations / 10);
  if (perCall < allowance) return [];
  return [
    {
      detector: "waste",
      title: `${metrics.totalTokens} tokens for ${metrics.distinctToolCalls} distinct tool calls`,
      severity: "minor",
      provisionalCause: "prompt",
      alternatives: ["model", "orchestration"],
      evidence: ev(
        trace,
        anchor(trace, metrics.invocations.slice(0, 3).map((i) => i.seq)),
        `${Math.round(perCall)} tokens per distinct call against an allowance of ${Math.round(allowance)}.`,
      ),
      metric: "totalTokens",
    },
  ];
};

export const DETECTORS: readonly Detector[] = [
  prematureSuccess,
  verificationAbsent,
  toolLoop,
  retryStorm,
  deniedStorm,
  wrongTool,
  contextLoss,
  runaway,
  waste,
];

export function runDetectors(input: DetectorInput): DetectorHit[] {
  return DETECTORS.flatMap((d) => d(input));
}

/**
 * A run whose tool results were never stored in full is a run AXIOM can only partly see. The host
 * truncates a result to 500 characters; nothing in the trace says so, so the limit is restated here
 * wherever an autopsy quotes one. Reporting the ceiling is what keeps "no problem found" from
 * reading as "no problem exists".
 */
export const RESULT_TRUNCATION_CHARS = 500;

export function resultWasTruncated(detail: string | null): boolean {
  return detail !== null && detail.length >= RESULT_TRUNCATION_CHARS;
}

/** Exported for the `wrong-tool` detector's own tests: does this result text read as an argument complaint? */
export function readsAsArgumentComplaint(detail: string | null): boolean {
  if (detail === null) return false;
  return ARGUMENT_COMPLAINT.test(detail);
}

export { parseArgs };
