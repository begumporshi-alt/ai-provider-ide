import { describe, expect, it } from "vitest";
import { claimsDone, deriveMetrics, pairInvocations, parseArgs } from "../src/trace";
import { TEST_POLICY, call, done, refused, result, said, trace } from "./fakes";

describe("parseArgs", () => {
  it("treats an absent argument list as no arguments, not as a parse failure", () => {
    // A tool that takes no arguments stores an empty detail. Calling that "unparsed" would put a
    // working call in the same bucket as a truncated one, and the difference is the whole finding.
    expect(parseArgs(null)).toEqual({ args: {}, unparsed: false });
    expect(parseArgs("")).toEqual({ args: {}, unparsed: false });
    expect(parseArgs("   ")).toEqual({ args: {}, unparsed: false });
  });

  it("flags malformed arguments rather than throwing them away", () => {
    expect(parseArgs('{"path":')).toEqual({ args: {}, unparsed: true });
    expect(parseArgs("[1,2]")).toEqual({ args: {}, unparsed: true });
    expect(parseArgs("null")).toEqual({ args: {}, unparsed: true });
    expect(parseArgs('"a string"')).toEqual({ args: {}, unparsed: true });
  });

  it("passes a real argument object through", () => {
    expect(parseArgs('{"command":"pnpm test"}')).toEqual({ args: { command: "pnpm test" }, unparsed: false });
  });
});

describe("pairInvocations", () => {
  it("pairs by tool name against the earliest unanswered call, not by position", () => {
    // Two interleaved read_file calls. Position-based pairing would hand read_file#1 the result of
    // read_file#2 and report a failure that never happened.
    const steps = [
      call(1, "read_file", { path: "a" }, 0),
      call(2, "read_file", { path: "b" }, 1),
      result(3, "read_file", true, "contents of a", 2),
      result(4, "read_file", true, "contents of b", 3),
    ];
    const inv = pairInvocations(steps);
    expect(inv).toHaveLength(2);
    expect(inv[0]?.resultSeq).toBe(3);
    expect(inv[1]?.resultSeq).toBe(4);
    expect(inv.every((i) => i.resultSeq !== null), "both calls answered").toBe(true);
  });

  it("reports a call with no result as unanswered rather than dropping it", () => {
    const inv = pairInvocations([call(1, "run_command", { command: "pnpm test" })]);
    expect(inv).toHaveLength(1);
    expect(inv[0]?.resultSeq).toBeNull();
    expect(inv[0]?.ok).toBeNull();
  });

  it("marks a refusal as denied and not as a tool failure", () => {
    const inv = pairInvocations([call(1, "write_file", {}), refused(2, "write_file")]);
    expect(inv[0]?.denied).toBe(true);
    expect(inv[0]?.ok).toBe(false);
  });

  it("ignores a result with no call behind it", () => {
    expect(pairInvocations([result(1, "read_file", true)])).toEqual([]);
  });
});

describe("deriveMetrics", () => {
  it("counts a refusal separately from a failure", () => {
    const t = trace({
      id: "r1",
      steps: [
        call(1, "write_file", {}),
        refused(2, "write_file"),
        call(3, "read_file", {}),
        result(4, "read_file", false, "ENOENT"),
      ],
    });
    const m = deriveMetrics(t, TEST_POLICY);
    expect(m.deniedCalls).toBe(1);
    expect(m.toolFailures).toBe(1);
    expect(m.toolCalls).toBe(2);
  });

  it("measures repetition as identical arguments, and names the first call of the streak", () => {
    const t = trace({
      id: "r2",
      steps: [
        call(1, "search_files", { q: "x" }),
        result(2, "search_files", true, "none"),
        call(3, "search_files", { q: "x" }),
        result(4, "search_files", true, "none"),
        call(5, "search_files", { q: "x" }),
        result(6, "search_files", true, "none"),
        call(7, "search_files", { q: "y" }),
        result(8, "search_files", true, "hit"),
      ],
    });
    const m = deriveMetrics(t, TEST_POLICY);
    expect(m.toolCalls).toBe(4);
    expect(m.distinctToolCalls).toBe(2);
    expect(m.repeatRatio).toBeCloseTo(0.5, 10);
    expect(m.longestRepeatRun).toMatchObject({ name: "search_files", count: 3, firstSeq: 1 });
  });

  it("reports no repeat run when nothing repeated", () => {
    const t = trace({
      id: "r3",
      steps: [call(1, "a", { i: 1 }), result(2, "a", true), call(3, "a", { i: 2 }), result(4, "a", true)],
    });
    expect(deriveMetrics(t, TEST_POLICY).longestRepeatRun).toBeNull();
  });

  it("counts only verification calls made before the completion claim", () => {
    // A check run *after* the agent said it was finished cannot have backed the claim. Counting it
    // would let a run look verified by work it did after the fact.
    const t = trace({
      id: "r4",
      steps: [
        call(1, "run_command", { command: "pnpm test" }),
        result(2, "run_command", true, "3 passed"),
        said(3, "All done, tests pass."),
        done(4),
        call(5, "run_command", { command: "pnpm test" }),
        result(6, "run_command", true, "3 passed"),
      ],
    });
    const m = deriveMetrics(t, TEST_POLICY);
    expect(m.verificationCalls).toBe(1);
    expect(m.claimedDone).toBe(true);
    expect(m.firstDoneSeq).toBe(4);
  });

  it("does not treat a build command as verification when the predicate says otherwise", () => {
    const t = trace({
      id: "r5",
      steps: [call(1, "run_command", { command: "ls -la" }), result(2, "run_command", true)],
    });
    expect(deriveMetrics(t, TEST_POLICY).verificationCalls).toBe(0);
  });

  it("leaves duration unknown when the run never reported an end", () => {
    const t = trace({ id: "r6", status: "running", endedAt: null, steps: [call(1, "a")] });
    const m = deriveMetrics(t, TEST_POLICY);
    expect(m.durationMs).toBeNull();
    expect(m.unansweredCalls).toBe(1);
  });

  it("reports zero repetition rather than NaN when the agent called nothing", () => {
    const m = deriveMetrics(trace({ id: "r7", steps: [said(1, "hello")] }), TEST_POLICY);
    expect(m.toolCalls).toBe(0);
    expect(m.repeatRatio).toBe(0);
  });
});

describe("claimsDone", () => {
  it("is false when the run produced no assistant text at all", () => {
    // The NO_OUTPUT shape: the model reasoned through its budget and sent nothing. That is a failure
    // to answer, not a premature claim of success, and the two need different fixes.
    const m = deriveMetrics(trace({ id: "r8", steps: [call(1, "a"), result(2, "a", true)] }), TEST_POLICY);
    expect(m.finalAssistantText).toBeNull();
    expect(claimsDone(m, TEST_POLICY)).toBe(false);
  });

  it("is true on a bare completion claim and false on an honest negative", () => {
    const yes = deriveMetrics(trace({ id: "r9", steps: [said(1, "Done — it's fixed.")] }), TEST_POLICY);
    const no = deriveMetrics(trace({ id: "r10", steps: [said(1, "This is not done yet.")] }), TEST_POLICY);
    expect(claimsDone(yes, TEST_POLICY)).toBe(true);
    expect(claimsDone(no, TEST_POLICY)).toBe(false);
  });
});
