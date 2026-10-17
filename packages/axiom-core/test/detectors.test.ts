import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  RESULT_TRUNCATION_CHARS,
  readsAsArgumentComplaint,
  resultWasTruncated,
  runDetectors,
  type DetectorHit,
  type DetectorInput,
} from "../src/detectors";
import { deriveMetrics } from "../src/trace";
import type { DetectorId, RunTrace, TraceStep } from "../src/types";
import { TEST_POLICY, call, done, refused, result, said, trace } from "./fakes";

/** Run the detectors over a hand-built trace and pick out one detector's hits. */
function hitsFor(t: RunTrace, maxIterations = 40): DetectorHit[] {
  const input: DetectorInput = {
    trace: t,
    metrics: deriveMetrics(t, TEST_POLICY),
    policy: TEST_POLICY,
    thresholds: DEFAULT_THRESHOLDS,
    maxIterations,
  };
  return runDetectors(input);
}

function pick(hits: DetectorHit[], id: DetectorId): DetectorHit[] {
  return hits.filter((h) => h.detector === id);
}

/** An n-step trace of call/result pairs, for the shapes several detectors share. */
function calls(steps: TraceStep[], extra: TraceStep[] = []): RunTrace {
  return trace({ id: "r", steps: [...steps, ...extra] });
}

describe("premature-success", () => {
  it("fires when the agent did work and then claimed it held, without checking", () => {
    const t = calls(
      [
        call(1, "write_file", { path: "a.ts" }),
        result(2, "write_file", true),
        said(3, "Done — the bug is fixed."),
        done(4),
      ],
    );
    const hits = pick(hitsFor(t), "premature-success");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("critical");
    expect(hits[0]?.evidence.steps).toEqual([4]);
    expect(hits[0]?.metric).toBe("verificationCalls");
  });

  it("does not fire when something evidence-producing ran before the claim", () => {
    const t = calls([
      call(1, "write_file", { path: "a.ts" }),
      result(2, "write_file", true),
      call(3, "run_command", { command: "pnpm test" }),
      result(4, "run_command", true, "3 passed"),
      said(5, "Done — the tests pass."),
      done(6),
    ]);
    expect(pick(hitsFor(t), "premature-success")).toHaveLength(0);
  });

  it("does not fire when the final answer declines to claim success", () => {
    const t = calls([
      call(1, "write_file", { path: "a.ts" }),
      result(2, "write_file", true),
      said(3, "This is not fixed yet — the build still fails."),
      done(4),
    ]);
    expect(pick(hitsFor(t), "premature-success")).toHaveLength(0);
  });

  it("names model and orchestration as still-possible causes, because one run cannot separate them", () => {
    const t = calls([call(1, "edit_file", {}), result(2, "edit_file", true), said(3, "fixed"), done(4)]);
    const hit = pick(hitsFor(t), "premature-success")[0];
    expect(hit?.provisionalCause).toBe("prompt");
    expect(hit?.alternatives).toEqual(expect.arrayContaining(["model", "orchestration"]));
  });
});

describe("verification-absent", () => {
  it("fires on a completion claim from a run that never called a tool", () => {
    const t = calls([said(1, "All done, the task is complete."), done(2)]);
    const hits = pick(hitsFor(t), "verification-absent");
    expect(hits).toHaveLength(1);
    // And not also as premature-success: the fix for "checked nothing" differs from "did nothing".
    expect(pick(hitsFor(t), "premature-success")).toHaveLength(0);
  });

  it("does not fire on a run that produced no answer at all", () => {
    const t = trace({ id: "r", status: "error", steps: [] });
    expect(pick(hitsFor(t), "verification-absent")).toHaveLength(0);
  });
});

describe("tool-loop", () => {
  const loop = (n: number): TraceStep[] => {
    const steps: TraceStep[] = [];
    let seq = 1;
    for (let i = 0; i < n; i += 1) {
      steps.push(call(seq++, "search_files", { query: "TODO" }));
      steps.push(result(seq++, "search_files", true, "0 matches"));
    }
    return steps;
  };

  it("fires at the threshold streak of identical calls", () => {
    const hits = pick(hitsFor(calls(loop(3))), "tool-loop");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toContain("3 times");
  });

  it("does not fire one call short of the threshold", () => {
    expect(pick(hitsFor(calls(loop(2))), "tool-loop")).toHaveLength(0);
  });

  it("does not fire on repetition with differing arguments", () => {
    const steps = [
      call(1, "search_files", { query: "a" }),
      result(2, "search_files", true),
      call(3, "search_files", { query: "b" }),
      result(4, "search_files", true),
      call(5, "search_files", { query: "c" }),
      result(6, "search_files", true),
    ];
    expect(pick(hitsFor(calls(steps)), "tool-loop")).toHaveLength(0);
  });

  it("provisionally blames orchestration and leaves prompt and tool open", () => {
    const hit = pick(hitsFor(calls(loop(4))), "tool-loop")[0];
    expect(hit?.provisionalCause).toBe("orchestration");
    expect(hit?.alternatives).toEqual(expect.arrayContaining(["prompt", "tool"]));
  });
});

describe("retry-storm", () => {
  const failing = (args: Record<string, unknown>[]): TraceStep[] => {
    const steps: TraceStep[] = [];
    let seq = 1;
    for (const a of args) {
      steps.push(call(seq++, "run_command", a));
      steps.push(result(seq++, "run_command", false, "exit 1"));
    }
    return steps;
  };

  it("blames the tool when varied arguments all fail", () => {
    const hits = pick(hitsFor(calls(failing([{ command: "a" }, { command: "b" }, { command: "c" }]))), "retry-storm");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.provisionalCause).toBe("tool");
  });

  it("blames orchestration when the same arguments fail again", () => {
    const hits = pick(
      hitsFor(calls(failing([{ command: "a" }, { command: "a" }, { command: "a" }]))),
      "retry-storm",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.provisionalCause).toBe("orchestration");
  });

  it("does not count approval-gate refusals as tool failures", () => {
    const steps = [
      call(1, "run_command", { command: "a" }),
      refused(2, "run_command"),
      call(3, "run_command", { command: "b" }),
      refused(4, "run_command"),
      call(5, "run_command", { command: "c" }),
      refused(6, "run_command"),
    ];
    expect(pick(hitsFor(calls(steps)), "retry-storm")).toHaveLength(0);
  });

  it("does not fire below the failure threshold", () => {
    expect(pick(hitsFor(calls(failing([{ command: "a" }, { command: "b" }]))), "retry-storm")).toHaveLength(0);
  });
});

describe("denied-storm", () => {
  const denials = (n: number): TraceStep[] => {
    const steps: TraceStep[] = [];
    let seq = 1;
    for (let i = 0; i < n; i += 1) {
      steps.push(call(seq++, "run_command", { command: `rm -rf /tmp/x${i}` }));
      steps.push(refused(seq++, "run_command"));
    }
    return steps;
  };

  it("fires when the agent keeps walking into its own boundary", () => {
    const hits = pick(hitsFor(calls(denials(3))), "denied-storm");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.provisionalCause).toBe("prompt");
    expect(hits[0]?.evidence.steps).toEqual([1, 3, 5]);
  });

  it("does not fire on a single legitimate refusal", () => {
    expect(pick(hitsFor(calls(denials(1))), "denied-storm")).toHaveLength(0);
  });
});

describe("wrong-tool", () => {
  it("fires on a result that reads as an argument complaint", () => {
    const steps = [
      call(1, "edit_file", { old: "x" }),
      result(2, "edit_file", false, "invalid arguments: missing required field 'new_string'"),
    ];
    const hits = pick(hitsFor(calls(steps)), "wrong-tool");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence.note).toContain("missing required field");
  });

  it("does not fire on an ordinary failure", () => {
    const steps = [call(1, "run_command", {}), result(2, "run_command", false, "exit code 1")];
    expect(pick(hitsFor(calls(steps)), "wrong-tool")).toHaveLength(0);
  });

  it("does not fire on a refusal, whose text is the gate's and not the tool's", () => {
    const steps = [call(1, "run_command", {}), refused(2, "run_command")];
    expect(pick(hitsFor(calls(steps)), "wrong-tool")).toHaveLength(0);
  });
});

describe("context-loss", () => {
  it("fires on a successful re-read of something already in the transcript", () => {
    const steps = [
      call(1, "read_file", { path: "a.ts" }),
      result(2, "read_file", true, "contents"),
      call(3, "write_file", { path: "b.ts" }),
      result(4, "write_file", true),
      call(5, "read_file", { path: "a.ts" }),
      result(6, "read_file", true, "contents"),
    ];
    const hits = pick(hitsFor(calls(steps)), "context-loss");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.provisionalCause).toBe("memory");
  });

  it("does not fire when the first read failed, because then it is a retry", () => {
    const steps = [
      call(1, "read_file", { path: "a.ts" }),
      result(2, "read_file", false, "ENOENT"),
      call(3, "read_file", { path: "a.ts" }),
      result(4, "read_file", true, "contents"),
    ];
    expect(pick(hitsFor(calls(steps)), "context-loss")).toHaveLength(0);
  });

  it("does not fire on a re-run verification command, which is the behaviour AXIOM wants", () => {
    const steps = [
      call(1, "run_command", { command: "pnpm test" }),
      result(2, "run_command", true, "1 passed"),
      call(3, "edit_file", {}),
      result(4, "edit_file", true),
      call(5, "run_command", { command: "pnpm test" }),
      result(6, "run_command", true, "1 passed"),
    ];
    expect(pick(hitsFor(calls(steps)), "context-loss")).toHaveLength(0);
  });
});

describe("runaway", () => {
  it("fires at 80% of the ceiling the run was actually given", () => {
    const t = trace({ id: "r", iterations: 32, steps: [call(1, "a"), result(2, "a", true), done(3)] });
    expect(pick(hitsFor(t, 40), "runaway")).toHaveLength(1);
    expect(pick(hitsFor(t, 100), "runaway")).toHaveLength(0);
  });

  it("escalates to critical when the run also ended in error", () => {
    const t = trace({ id: "r", status: "error", iterations: 40, steps: [call(1, "a"), result(2, "a", true)] });
    expect(pick(hitsFor(t, 40), "runaway")[0]?.severity).toBe("critical");
  });

  it("still points at a step when the budget was burned without a single tool call", () => {
    // A reasoning loop that never acts is the clearest runaway there is, and it has no invocation to
    // cite. Without the anchor the investigator would reject the hit and the defect would vanish.
    const t = trace({ id: "r", iterations: 40, steps: [said(1, "thinking"), said(2, "still thinking"), done(3)] });
    const hit = pick(hitsFor(t, 40), "runaway")[0];
    expect(hit?.evidence.steps).toEqual([3]);
  });
});

describe("waste", () => {
  it("fires when tokens per distinct call outrun the allowance", () => {
    const t = trace({
      id: "r",
      promptTokens: 9_000,
      completionTokens: 1_000,
      steps: [call(1, "read_file", { path: "a" }), result(2, "read_file", true), done(3)],
    });
    const hits = pick(hitsFor(t, 40), "waste");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence.note).toContain("10000 tokens per distinct call");
  });

  it("does not fire on a run that turned its tokens into calls", () => {
    const steps: TraceStep[] = [];
    let seq = 1;
    for (let i = 0; i < 20; i += 1) {
      steps.push(call(seq++, "read_file", { path: `f${i}` }));
      steps.push(result(seq++, "read_file", true));
    }
    const t = trace({ id: "r", promptTokens: 8_000, completionTokens: 1_000, steps });
    expect(pick(hitsFor(t, 40), "waste")).toHaveLength(0);
  });

  it("does not fire on a run that reported no tokens, because absent is not zero-cost", () => {
    const t = trace({ id: "r", promptTokens: 0, completionTokens: 0, steps: [done(1)] });
    expect(pick(hitsFor(t, 40), "waste")).toHaveLength(0);
  });
});

describe("every hit", () => {
  it("carries evidence that names at least one step", () => {
    // The package's own standard, applied to itself: an assertion AXIOM cannot point at is the
    // defect it exists to catch in the agent.
    const shapes: RunTrace[] = [
      calls([call(1, "write_file", {}), result(2, "write_file", true), said(3, "done, fixed"), done(4)]),
      calls([said(1, "complete"), done(2)]),
      trace({ id: "r", iterations: 40, promptTokens: 50_000, steps: [said(1, "hmm"), done(2)] }),
    ];
    for (const t of shapes) {
      for (const h of hitsFor(t, 40)) {
        expect(h.evidence.runId).toBe(t.id);
        expect(h.evidence.steps.length).toBeGreaterThan(0);
        expect(h.evidence.note.length).toBeGreaterThan(0);
        expect(h.alternatives).not.toContain(h.provisionalCause);
      }
    }
  });
});

describe("the result-text helpers", () => {
  it("treats a result at the storage ceiling as truncated", () => {
    expect(resultWasTruncated("x".repeat(RESULT_TRUNCATION_CHARS))).toBe(true);
    expect(resultWasTruncated("x".repeat(RESULT_TRUNCATION_CHARS - 1))).toBe(false);
    expect(resultWasTruncated(null)).toBe(false);
  });

  it("matches argument complaints by shape, not by tool name", () => {
    expect(readsAsArgumentComplaint("unexpected parameter 'foo'")).toBe(true);
    expect(readsAsArgumentComplaint("command not found: pnpm")).toBe(false);
    expect(readsAsArgumentComplaint(null)).toBe(false);
  });
});
