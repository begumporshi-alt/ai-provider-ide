/**
 * **Agent Autopsy** — reconstruct why one run went the way it did, step by step.
 *
 * The output is a timeline with an annotation on the steps that matter, a verdict, and — the part
 * that makes it an autopsy rather than a log dump — an explicit list of what AXIOM could not see.
 * A reconstruction that silently omits the ceiling on its own evidence invites the reader to treat
 * "nothing flagged" as "nothing wrong", and the difference between those two is the whole reason
 * the blind spots are printed.
 *
 * Three blind spots are structural, not bugs, and every autopsy carries them when they apply:
 *
 * - **Tool results are stored truncated to 500 characters.** Anything the agent read past that is
 *   invisible here, so a result that looks clean may not have been.
 * - **The loop's verification demand is not a step.** It is an automatic *user* turn, and
 *   `agent_steps` records only assistant/tool/done/denied. An autopsy can see whether the agent
 *   produced evidence; it cannot see whether the loop asked it to.
 * - **A run recorded as `running` never reported an end.** Its duration is unknown — not zero — and
 *   the same picture is left by a session closed mid-run, which is not the same event.
 */
import { RESULT_TRUNCATION_CHARS, resultWasTruncated } from "./detectors";
import { claimsDone, deriveMetrics, type DetectorPolicy } from "./trace";
import type { Finding, RootCause, RunMetrics, RunTrace } from "./types";

export interface AutopsyLine {
  seq: number;
  kind: RunTrace["steps"][number]["kind"];
  label: string | null;
  /** What this step was, in plain words. Never a restatement of the label. */
  summary: string;
  /** The stored text, as AXIOM received it. Untrusted content: render as text, never as markup. */
  detail: string | null;
  truncated: boolean;
  ok: boolean | null;
  /** Milliseconds since the previous step. Null on the first step. */
  gapMs: number | null;
  /** Why this step matters, attached from the findings that name it. */
  annotations: string[];
}

export interface Autopsy {
  runId: string;
  model: string;
  status: RunTrace["status"];
  prompt: string | null;
  versionId: string | null;
  metrics: RunMetrics;
  verdict: string;
  /** The cause of the worst finding attached to this run. Null when nothing fired. */
  cause: RootCause | null;
  lines: AutopsyLine[];
  findings: Finding[];
  blindSpots: string[];
}

const SEVERITY_RANK = { info: 0, minor: 1, major: 2, critical: 3 } as const;

export function autopsy(input: {
  trace: RunTrace;
  policy: DetectorPolicy;
  findings: Finding[];
}): Autopsy {
  const { trace, policy } = input;
  const metrics = deriveMetrics(trace, policy);
  const invBySeq = new Map(metrics.invocations.map((i) => [i.seq, i]));

  const mine = input.findings
    .filter((f) => f.evidence.some((e) => e.runId === trace.id))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const annotationsBySeq = new Map<number, string[]>();
  for (const f of mine) {
    for (const e of f.evidence) {
      if (e.runId !== trace.id) continue;
      for (const seq of e.steps) {
        const list = annotationsBySeq.get(seq);
        const text = `${f.detector}: ${e.note}`;
        if (list) list.push(text);
        else annotationsBySeq.set(seq, [text]);
      }
    }
  }

  const ordered = [...trace.steps].sort((a, b) => a.seq - b.seq);
  const lines: AutopsyLine[] = ordered.map((s, i) => {
    const prev = i > 0 ? ordered[i - 1] : undefined;
    const inv = invBySeq.get(s.seq);
    const detail = s.kind === "tool_call" ? (inv?.args ?? s.detail) : s.detail;
    const base = {
      seq: s.seq,
      kind: s.kind,
      label: s.label,
      detail,
      truncated: resultWasTruncated(s.detail),
      ok: s.kind === "tool_call" ? (inv?.ok ?? null) : s.ok,
      gapMs: prev ? s.ts - prev.ts : null,
      annotations: annotationsBySeq.get(s.seq) ?? [],
    };
    return { ...base, summary: summariseFromInv(base, inv) };
  });

  const blindSpots: string[] = [];
  if (lines.some((l) => l.truncated)) {
    blindSpots.push(
      `At least one tool result was stored truncated to ${RESULT_TRUNCATION_CHARS} characters; the tail of ` +
        `that output is not in this reconstruction.`,
    );
  }
  if (metrics.unansweredCalls > 0) {
    blindSpots.push(
      `${metrics.unansweredCalls} tool call(s) have no recorded result. Either the run ended with them in ` +
        `flight or the write was lost — the trace cannot say which, and a lost write is invisible by design.`,
    );
  }
  if (trace.status === "running") {
    blindSpots.push(
      "This run is recorded as still running, so it has no end time and no duration. A session closed " +
        "mid-run leaves the identical row; nothing here can tell the two apart.",
    );
  }
  blindSpots.push(
    "The loop's verification demand is an automatic user turn and is not recorded as a step, so this " +
      "reconstruction shows whether the agent produced evidence, never whether it was asked to.",
  );
  if (mine.length === 0) {
    blindSpots.push(
      "No detector fired. That is not a finding that the run succeeded — the expectations that would " +
        "prove success live in the eval suite, and this run was not part of one.",
    );
  }

  const worst = mine[0];
  const verdict = buildVerdict(trace, metrics, policy, worst, mine.length);

  return {
    runId: trace.id,
    model: trace.model,
    status: trace.status,
    prompt: trace.prompt,
    versionId: trace.versionId,
    metrics,
    verdict,
    cause: worst?.rootCause ?? null,
    lines,
    findings: mine,
    blindSpots,
  };
}

function summariseFromInv(
  line: Omit<AutopsyLine, "summary">,
  inv: RunMetrics["invocations"][number] | undefined,
): string {
  switch (line.kind) {
    case "assistant":
      return line.detail && line.detail.trim() !== ""
        ? "The agent spoke rather than acted."
        : "An empty assistant turn: no text and no call.";
    case "tool_call": {
      const name = line.label ?? "?";
      // A refusal arrives as a `denied` step and so pairs up like a result; check it first or the
      // unanswered branch below would report a boundary as a lost write.
      if (inv?.denied === true) return `Called ${name}; the approval gate refused it.`;
      if (inv === undefined || inv.resultSeq === null) {
        return `Called ${name}; no result was ever recorded for it — the call never answered.`;
      }
      if (inv.ok === false) return `Called ${name}; it failed.`;
      if (inv.ok === null) return `Called ${name}; whether it worked was never recorded.`;
      return `Called ${name}; it succeeded.`;
    }
    case "tool_result":
      return line.ok === false
        ? `Result for ${line.label ?? "?"}: failure.`
        : `Result for ${line.label ?? "?"}: success.`;
    case "denied":
      return `Refused: ${line.label ?? "?"} was not permitted here.`;
    case "done":
      return "The agent declared the task complete and the loop ended.";
  }
}

function buildVerdict(
  trace: RunTrace,
  metrics: RunMetrics,
  policy: DetectorPolicy,
  worst: Finding | undefined,
  count: number,
): string {
  if (trace.status === "error") {
    return (
      `The run ended in error: ${trace.error ?? "no error text was stored"}. ` +
      (worst ? `Before that, ${worst.title.toLowerCase()} (${worst.occurrences} occurrence(s) overall).` : "")
    );
  }
  if (trace.status === "stopped") {
    return "The run was stopped from outside — a user or another screen aborted it. Nothing here says whether the work was incomplete or merely interrupted.";
  }
  if (worst) {
    return (
      `${worst.title}. Root cause reads as '${worst.rootCause}': ${worst.rationale} ` +
      (count > 1 ? `${count - 1} further finding(s) attach to this run.` : "")
    );
  }
  const claimed = claimsDone(metrics, policy);
  if (claimed && metrics.verificationCalls > 0) {
    return `The agent claimed completion and had run ${metrics.verificationCalls} check(s) beforehand. Nothing fired, and the check is on the record.`;
  }
  return "No detector fired on this run.";
}
