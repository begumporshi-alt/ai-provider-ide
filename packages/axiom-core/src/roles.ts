/**
 * **Multi-Agent Evaluator** — four independent reviews of a proposed upgrade.
 *
 * A note on what "agent" means here, because overstating it would be exactly the kind of claim this
 * package exists to catch. In v1 these are four **deterministic analytic passes** over the same
 * evidence, each with a different question and a different power to block. They are not four model
 * calls, and that is a deliberate choice rather than a shortcut: a gate that samples is a gate you
 * cannot reproduce, and a promotion decision that changes next Tuesday for no reason is worse than
 * a weaker one that holds still. An LLM-backed critic can be added later behind the `AgentRunnerPort`
 * as an *additional* objection source; it should never be the thing that approves.
 *
 * What makes them independent is that they do not share a conclusion. The guardian owns the
 * arithmetic — did the number move, by more than noise. The roles own the question of whether that
 * arithmetic is the right question:
 *
 * | Role | Question | Blocks on |
 * |---|---|---|
 * | investigator | Does the diagnosis rest on evidence that resolves? | claims pointing at nothing |
 * | architect | Is this the right *kind* of change for this cause? | a config edit for a model limit |
 * | critic | What is this comparison unable to see? | a suite that cannot detect the regression |
 * | verifier | Is the arithmetic right, recomputed from the raw attempts? | any guardian check failing |
 *
 * Only the verifier's approval is sufficient; all four are necessary. The architect is the one that
 * carries the spec's central rule — *"do not assume every failure requires a stronger model"* — and
 * it cuts both ways: it refuses to promote a model switch, and it refuses to let a prompt patch stand
 * in for a fault that is not the prompt's.
 */
import { mean, stddev, type GuardianReport } from "./guardian";
import type { Proposal } from "./version";
import type { AgentVersion, EvalSuite, Finding, RoleId, RoleVerdict, SuiteResult } from "./types";

export interface RoleInput {
  proposal: Proposal;
  findings: Finding[];
  suite: EvalSuite;
  baseline: SuiteResult;
  candidate: SuiteResult;
  /** The version the baseline numbers came from — the candidate's parent. Null when the baseline is
   *  the built-in configuration, which has no version row of its own. */
  baselineVersion: AgentVersion | null;
  candidateVersion: AgentVersion;
  guardian: GuardianReport;
}

function verdict(role: RoleId, objections: string[]): RoleVerdict {
  return { role, approve: objections.length === 0, objections };
}

/**
 * Does the diagnosis rest on evidence that resolves?
 *
 * The structural mirror of the rule AXIOM applies to the agent: a claim you cannot point at does not
 * stand. Every finding the proposal targets must exist, must cite at least one run, and must name the
 * steps within it. The one exception is the row that records *omitted* occurrences, which by design
 * names no steps because it stands for the ones not listed.
 */
export function investigate(i: RoleInput): RoleVerdict {
  const objections: string[] = [];
  const known = new Map(i.findings.map((f) => [f.id, f]));

  if (i.proposal.targetsFindingIds.length === 0) {
    objections.push("The proposal targets no finding, so there is nothing it claims to fix.");
  }

  for (const id of i.proposal.targetsFindingIds) {
    const f = known.get(id);
    if (!f) {
      objections.push(`It targets finding ${id}, which the diagnosis does not contain.`);
      continue;
    }
    if (f.evidence.length === 0) objections.push(`Finding ${id} ("${f.title}") cites no evidence at all.`);
    for (const e of f.evidence) {
      if (e.steps.length === 0 && !e.note.includes("omitted")) {
        objections.push(`Finding ${id} cites run ${e.runId} without naming a single step in it.`);
      }
    }
    if (!f.differential && f.occurrences === 1) {
      objections.push(
        `Finding ${id} rests on one run and no comparison was available, so its cause ('${f.rootCause}') is a ` +
          `hypothesis. That is fine to report and not fine to act on: gather a second model or a second run first.`,
      );
    }
  }

  if (i.proposal.evidence.length === 0) objections.push("The proposal itself carries no evidence forward.");
  return verdict("investigator", objections);
}

/**
 * Is this the right kind of change for this cause?
 */
export function reviewArchitecture(i: RoleInput): RoleVerdict {
  const objections: string[] = [];
  const p = i.proposal;

  if (p.actuator === "manual") {
    objections.push(
      `This proposal is a recommendation, not a change — ${p.blockedReason ?? "no actuator applies"}. ` +
        `There is nothing to promote.`,
    );
  }

  if (p.rootCause === "model") {
    objections.push(
      "The diagnosis attributes this to the model. No prompt or loop parameter fixes a model limit, and " +
        "pretending otherwise produces a version that changes the agent and leaves the failure in place.",
    );
  }

  if (p.actuator === "loop-params" && p.loop) {
    const raises = p.loop.to > p.loop.from;
    const buysMore = p.detector === "runaway" || p.detector === "waste" || p.detector === "tool-loop";
    if (raises && buysMore) {
      objections.push(
        `Raising ${p.loop.field} in response to '${p.detector}' buys more of the behaviour that was diagnosed, ` +
          `at a higher cost, and would report the extra spend as an improvement.`,
      );
    }
  }

  // One change per version. A version that differs from its parent in two places cannot be
  // attributed: if the numbers move, nothing says which edit moved them.
  const parent = i.baselineVersion;
  if (parent) {
    const a = parent.config;
    const b = i.candidateVersion.config;
    const differing: string[] = [];
    if (a.promptOverride !== b.promptOverride) differing.push("prompt");
    if (a.loop.maxIterations !== b.loop.maxIterations) differing.push("maxIterations");
    if (a.loop.verificationNudgeMax !== b.loop.verificationNudgeMax) differing.push("verificationNudgeMax");
    if (differing.length > 1) {
      objections.push(
        `The candidate differs from its parent in ${differing.length} places (${differing.join(", ")}). If the ` +
          `numbers move, nothing will say which edit moved them — split it into one version per change.`,
      );
    }
    if (differing.length === 0) {
      objections.push("The candidate is byte-identical to its parent, so a validation run compares noise with noise.");
    }
  }

  if (p.rationale.trim().length < 40) {
    objections.push("The proposal's rationale is too short to have reasoned about anything.");
  }

  return verdict("architect", objections);
}

/**
 * What is this comparison unable to see?
 *
 * The critic does not ask whether the change worked — the guardian did that. It asks whether the
 * experiment could have told. A suite with one task cannot detect a regression, because there is
 * nothing else to regress. A baseline in which nothing failed has no headroom, so any movement is
 * noise wearing a direction. And a single repeat has no spread, which makes the guardian's noise
 * floor uncomputable rather than small.
 */
export function critique(i: RoleInput): RoleVerdict {
  const objections: string[] = [];

  if (i.suite.tasks.length < 2) {
    objections.push(
      `The suite has ${i.suite.tasks.length} task(s). With fewer than two there is nothing for a regression to ` +
        `show up in, so the guardian's no-regression check passes by having nothing to check.`,
    );
  }

  if (i.baseline.repeats < 3) {
    objections.push(
      `${i.baseline.repeats} repeat(s) per task. A mean over fewer than three samples of a stochastic agent is ` +
        `thin enough that the noise floor it produces is itself uncertain.`,
    );
  }

  const baselineFailures = i.baseline.attemptSummaries.filter((a) => !a.passed).length;
  if (baselineFailures === 0) {
    objections.push(
      "Every baseline attempt passed. There is no failure to fix, so any difference the candidate shows is " +
        "sampling variation with a direction attached to it.",
    );
  }

  const capabilityTasks = new Set(i.suite.tasks.map((t) => t.capability));
  if (capabilityTasks.size === 1 && i.suite.tasks.length > 1) {
    objections.push(
      `All ${i.suite.tasks.length} tasks measure one capability. A change that trades another capability away ` +
        `would be invisible here — widen the suite before trusting the no-regression check.`,
    );
  }

  if (i.proposal.actuator === "prompt" && i.baseline.passRate === 1) {
    objections.push(
      "Adding instructions to an agent that already passes everything costs context on every future turn and " +
        "has nothing to improve. The patch should be withdrawn, not promoted.",
    );
  }

  return verdict("critic", objections);
}

/**
 * Recompute the guardian's arithmetic from the raw attempts and approve only if it agrees and every
 * check passed.
 *
 * The independence is literal rather than nominal: this function does not read `guardian.deltas`. It
 * goes back to `attemptSummaries`, recomputes the means and the pooled spread with the same exported
 * helpers, and compares. A guardian that mis-derived a delta is caught here; a guardian and a
 * verifier that shared a buggy private helper would not be, which is why the helpers are exported and
 * tested on their own.
 */
export function verify(i: RoleInput): RoleVerdict {
  const objections: string[] = [];

  for (const c of i.guardian.checks) {
    if (!c.passed) objections.push(`${c.label} — ${c.detail}`);
  }

  const target = i.guardian.targetMetric;
  if (target !== null) {
    const pick = (r: SuiteResult, field: keyof SuiteResult["attemptSummaries"][number]): number[] =>
      r.attemptSummaries.map((a) => {
        if (field === "passed") return a.passed ? 1 : 0;
        const v = a[field];
        return typeof v === "number" ? v : NaN;
      });
    const fieldFor = metricField(target);
    if (fieldFor !== null) {
      const b = pick(i.baseline, fieldFor).filter((n) => !Number.isNaN(n));
      const c = pick(i.candidate, fieldFor).filter((n) => !Number.isNaN(n));
      const bm = mean(b);
      const cm = mean(c);
      const bs = stddev(b);
      const cs = stddev(c);
      if (bm !== null && cm !== null) {
        const reported = i.guardian.deltas.find((d) => d.metric === target);
        if (!reported) {
          objections.push(`The guardian reported no delta for ${target} although it scored the proposal on it.`);
        } else {
          if (Math.abs(reported.baseline - bm) > 1e-9 || Math.abs(reported.candidate - cm) > 1e-9) {
            objections.push(
              `Recomputing ${target} from the raw attempts gives ${bm} → ${cm}, not the guardian's ` +
                `${reported.baseline} → ${reported.candidate}.`,
            );
          }
          const pooled = bs !== null && cs !== null ? Math.sqrt((bs * bs + cs * cs) / 2) : null;
          const shouldBeBeyond = pooled === null ? false : pooled === 0 ? cm - bm !== 0 : Math.abs(cm - bm) > pooled;
          if (shouldBeBeyond !== reported.beyondNoise) {
            objections.push(
              `Recomputing the spread for ${target} disagrees with the guardian on whether the change clears noise.`,
            );
          }
        }
      }
    }
  }

  if (i.candidateVersion.state !== "candidate") {
    objections.push(
      `The version is already '${i.candidateVersion.state}'. Only a candidate can be put to a validation run; ` +
        `promoting an active or retired version would rewrite history rather than extend it.`,
    );
  }

  return verdict("verifier", objections);
}

function metricField(m: string): keyof SuiteResult["attemptSummaries"][number] | null {
  switch (m) {
    case "passRate":
      return "passed";
    case "iterations":
      return "iterations";
    case "totalTokens":
      return "totalTokens";
    case "durationMs":
      return "durationMs";
    case "toolCalls":
      return "toolCalls";
    case "toolFailures":
      return "toolFailures";
    case "deniedCalls":
      return "deniedCalls";
    case "verificationCalls":
      return "verificationCalls";
    case "repeatRatio":
      return "repeatRatio";
    default:
      return null;
  }
}

/** All four, in the order they read: what is claimed, whether it fits, what is missing, whether it holds. */
export function conveneRoles(i: RoleInput): RoleVerdict[] {
  return [investigate(i), reviewArchitecture(i), critique(i), verify(i)];
}
