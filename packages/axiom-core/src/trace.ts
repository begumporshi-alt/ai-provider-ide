/**
 * Stage 01 — **Observe**. Turns a stored run into numbers a detector can argue with.
 *
 * The one design decision here that is not obvious: AXIOM does **not** re-implement the agent
 * loop's own judgements. Whether a sentence "claims completion" and whether a tool call "counts
 * as evidence" are already decided, tested and shipped in `apps/desktop/src/lib/tools/agentLoop.ts`
 * (`claimsCompletion`, `isVerificationCall`, `VERIFICATION_DEMAND`). A second copy in this package
 * would be a rule kept in two places, and the dev book's answer to that is not "be careful" — it
 * is that one of them is a copy and will rot. So the host injects them through `DetectorPolicy`
 * and this package refuses to guess. Tests inject a fake policy; there is deliberately no default,
 * because a default is the copy that rots.
 *
 * What this module *does* own is the part the loop never had a reason to compute: pairing calls
 * with results, counting repeats, and reducing a run to a `RunMetrics` that can be compared across
 * versions.
 */
import type { RunMetrics, RunTrace, ToolInvocation, TraceStep } from "./types";

/**
 * The agent loop's own predicates, injected by the host. See the module comment for why these are
 * a port rather than a reimplementation.
 */
export interface DetectorPolicy {
  /** Pass `claimsCompletion` from `agentLoop.ts`. */
  claimsCompletion(text: string): boolean;
  /** Pass `isVerificationCall` from `agentLoop.ts`. `args` is the parsed call arguments. */
  isVerificationCall(name: string, args: Record<string, unknown>): boolean;
}

/**
 * A `tool_call` step's `detail` is the raw arguments JSON exactly as the model built it. It can be
 * absent (a tool with no arguments), malformed (a truncated tool call the loop retried), or a
 * non-object. All three must produce `{}` rather than throw: a run whose arguments failed to parse
 * is precisely the run worth diagnosing, and losing it here would hide the interesting case.
 *
 * The failure is recorded on the invocation as `argsUnparsed` so a detector can tell "no
 * arguments" from "arguments we could not read" — the same distinction the data model chapter
 * insists on for nullable columns.
 */
export function parseArgs(detail: string | null): { args: Record<string, unknown>; unparsed: boolean } {
  if (detail === null || detail.trim() === "") return { args: {}, unparsed: false };
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, unparsed: false };
    }
    return { args: {}, unparsed: true };
  } catch {
    return { args: {}, unparsed: true };
  }
}

/**
 * Pair every `tool_call` with the `tool_result` or `denied` step that answered it.
 *
 * Matching is by tool name against the **earliest** unanswered call of that name, not by position:
 * `fan_out` and `dispatch_agent` interleave several calls to the same tool, and position-based
 * pairing mis-attributes a result to the wrong call — which then reads as a failure that did not
 * happen. A call left unmatched at the end is reported as unanswered rather than dropped, because
 * "the run ended with a call in flight" is a finding, not noise.
 */
export function pairInvocations(steps: TraceStep[]): ToolInvocation[] {
  const out: ToolInvocation[] = [];
  const pendingByName = new Map<string, number[]>();

  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  for (const s of ordered) {
    if (s.kind === "tool_call") {
      const name = s.label ?? "?";
      const { unparsed } = parseArgs(s.detail);
      const inv: ToolInvocation = {
        seq: s.seq,
        name,
        args: s.detail ?? "",
        ok: null,
        resultSeq: null,
        resultDetail: null,
        ...(unparsed ? { argsUnparsed: true } : {}),
      };
      const idx = out.push(inv) - 1;
      const q = pendingByName.get(name);
      if (q) q.push(idx);
      else pendingByName.set(name, [idx]);
      continue;
    }
    if (s.kind === "tool_result" || s.kind === "denied") {
      const name = s.label ?? "?";
      const q = pendingByName.get(name);
      const idx = q?.shift();
      if (idx === undefined) continue;
      const inv = out[idx];
      if (!inv) continue;
      inv.ok = s.kind === "denied" ? false : (s.ok ?? null);
      inv.resultSeq = s.seq;
      // The host truncates a result to 500 characters before storing it. That is a real ceiling on
      // what an autopsy can see, and it is surfaced rather than papered over: a detector reading
      // this text knows the tail is missing.
      inv.resultDetail = s.detail;
      inv.denied = s.kind === "denied";
    }
  }
  return out;
}

export function deriveMetrics(trace: RunTrace, policy: DetectorPolicy): RunMetrics {
  const invocations = pairInvocations(trace.steps);
  const assistantTexts = [...trace.steps]
    .sort((a, b) => a.seq - b.seq)
    .filter((s) => s.kind === "assistant")
    .map((s) => s.detail ?? "")
    .filter((t) => t !== "");

  const toolCalls = invocations.length;
  const keys = invocations.map((i) => `${i.name}\u0000${i.args}`);
  const distinctToolCalls = new Set(keys).size;

  let longestRepeatRun: RunMetrics["longestRepeatRun"] = null;
  let streak = 0;
  let streakStart = 0;
  for (let i = 0; i < invocations.length; i += 1) {
    const cur = keys[i];
    const prev = i > 0 ? keys[i - 1] : undefined;
    if (cur !== undefined && cur === prev) streak += 1;
    else {
      streak = 1;
      streakStart = i;
    }
    const inv = invocations[i];
    if (streak >= 2 && inv && (longestRepeatRun === null || streak > longestRepeatRun.count)) {
      // `firstSeq` is the first call of the streak, not the latest: an autopsy annotates the moment
      // the agent stopped adapting, which is the first repetition, not the last.
      const first = invocations[streakStart];
      longestRepeatRun = { name: inv.name, args: inv.args, count: streak, firstSeq: first ? first.seq : inv.seq };
    }
  }

  const doneSteps = trace.steps.filter((s) => s.kind === "done");
  const firstDoneSeq = doneSteps.length > 0 ? Math.min(...doneSteps.map((s) => s.seq)) : null;

  let verificationCalls = 0;
  for (const inv of invocations) {
    if (firstDoneSeq !== null && inv.seq > firstDoneSeq) continue;
    const { args } = parseArgs(inv.args);
    if (policy.isVerificationCall(inv.name, args)) verificationCalls += 1;
  }

  return {
    durationMs: trace.endedAt === null ? null : trace.endedAt - trace.startedAt,
    toolCalls,
    toolFailures: invocations.filter((i) => i.ok === false && !i.denied).length,
    deniedCalls: invocations.filter((i) => i.denied === true).length,
    iterations: trace.iterations,
    totalTokens: trace.promptTokens + trace.completionTokens,
    distinctToolCalls,
    repeatRatio: toolCalls === 0 ? 0 : 1 - distinctToolCalls / toolCalls,
    longestRepeatRun,
    claimedDone: doneSteps.length > 0,
    firstDoneSeq,
    verificationCalls,
    unansweredCalls: invocations.filter((i) => i.resultSeq === null).length,
    assistantTexts,
    finalAssistantText: assistantTexts.length > 0 ? (assistantTexts[assistantTexts.length - 1] ?? null) : null,
    invocations,
  };
}

/**
 * Whether the run's final answer asserts completion. Exposed separately from `deriveMetrics`
 * because two detectors need it and the metric struct is already wide — and because a run with no
 * assistant text at all is *not* a completion claim, which is the `NO_OUTPUT` shape the loop
 * retries rather than a premature success.
 */
export function claimsDone(metrics: RunMetrics, policy: DetectorPolicy): boolean {
  const text = metrics.finalAssistantText;
  if (text === null) return false;
  return policy.claimsCompletion(text);
}
