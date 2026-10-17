import { describe, expect, it } from "vitest";
import {
  ASSUMED_TOKENS_PER_CALL,
  DEFAULT_REPEATS,
  PaidRunRefusedError,
  authorizePaidRun,
  checkTask,
  estimateCost,
  evaluateSuite,
  type EvaluateOptions,
} from "../src/evaluate";
import { deriveMetrics } from "../src/trace";
import type { AgentRunnerPort, AxiomPorts } from "../src/ports";
import type { EvalSuite, RunTrace } from "../src/types";
import {
  TEST_LOOP,
  TEST_POLICY,
  call,
  createTestPorts,
  done,
  refused,
  result,
  said,
  trace,
  withConsent,
  withPrices,
} from "./fakes";

const SUITE: EvalSuite = {
  id: "s1",
  name: "Two capabilities",
  tasks: [
    {
      id: "t1",
      capability: "file-edit",
      prompt: "Fix the parser",
      expect: [{ kind: "verified-done" }, { kind: "status-equals", status: "ok" }],
    },
    {
      id: "t2",
      capability: "shell",
      prompt: "Run the build",
      expect: [{ kind: "tool-was-called", name: "run_command" }],
    },
  ],
};

const SCRIPTS = {
  t1: {
    calls: [
      { name: "write_file", args: { path: "a.ts" } },
      { name: "run_command", args: { command: "pnpm test" }, result: "3 passed" },
    ],
    finalText: "Done — the tests pass.",
  },
  t2: {
    calls: [{ name: "run_command", args: { command: "pnpm build" }, result: "built" }],
    finalText: "Built.",
  },
};

function opts(overrides: Partial<EvaluateOptions> = {}): EvaluateOptions {
  return {
    suite: SUITE,
    model: "test/model",
    config: { promptOverride: null, loop: TEST_LOOP },
    versionId: "builtin",
    policy: TEST_POLICY,
    ...overrides,
  };
}

function check(t: RunTrace, suite = SUITE) {
  const task = suite.tasks.find((x) => x.prompt === t.prompt) ?? suite.tasks[0]!;
  return checkTask(task, t, deriveMetrics(t, TEST_POLICY), TEST_POLICY);
}

describe("checkTask", () => {
  it("passes verified-done when an evidence-producing call preceded the claim", () => {
    const t = trace({
      id: "a",
      prompt: "Fix the parser",
      steps: [
        call(1, "write_file", { path: "a.ts" }),
        result(2, "write_file", true),
        call(3, "run_command", { command: "pnpm test" }),
        result(4, "run_command", true, "3 passed"),
        said(5, "Done — the tests pass."),
        done(6),
      ],
    });
    expect(check(t).passed).toBe(true);
  });

  it("fails verified-done on a claim nothing backs up, and says what is missing", () => {
    const t = trace({
      id: "a",
      prompt: "Fix the parser",
      steps: [call(1, "write_file", {}), result(2, "write_file", true), said(3, "Done, fixed."), done(4)],
    });
    const c = check(t);
    expect(c.passed).toBe(false);
    expect(c.failed[0]?.reason).toMatch(/no evidence-producing call preceded the claim/);
  });

  it("passes verified-done when the agent makes no claim at all — there is nothing to back up", () => {
    const t = trace({ id: "a", prompt: "Fix the parser", steps: [call(1, "write_file", {}), result(2, "write_file", true)] });
    expect(check(t).passed).toBe(true);
  });

  it("does not count a verification call that came after the claim", () => {
    const t = trace({
      id: "a",
      prompt: "Fix the parser",
      steps: [
        call(1, "write_file", {}),
        result(2, "write_file", true),
        said(3, "Done, fixed."),
        done(4),
        call(5, "run_command", { command: "pnpm test" }),
        result(6, "run_command", true),
      ],
    });
    expect(check(t).passed).toBe(false);
  });

  it("reports a status mismatch with the error text, truncated", () => {
    const t = trace({
      id: "a",
      prompt: "Fix the parser",
      status: "error",
      error: "x".repeat(400),
      steps: [done(1)],
    });
    const reason = check(t).failed.find((f) => f.expectation.kind === "status-equals")?.reason ?? "";
    expect(reason).toContain("ended 'error'");
    expect(reason).toContain("…");
    expect(reason.length).toBeLessThan(200);
  });

  it("reports a run that produced no text at all as having no text, not as a mismatch", () => {
    const suite: EvalSuite = {
      id: "s",
      name: "n",
      tasks: [{ id: "t", capability: "c", prompt: "Fix the parser", expect: [{ kind: "final-text-matches", pattern: "ok" }] }],
    };
    const t = trace({ id: "a", prompt: "Fix the parser", steps: [done(1)] });
    expect(check(t, suite).failed[0]?.reason).toMatch(/no assistant text/);
  });

  it("checks tool-was-called, tool-not-called and no-tool-loop against the transcript", () => {
    const suite: EvalSuite = {
      id: "s",
      name: "n",
      tasks: [
        {
          id: "t",
          capability: "c",
          prompt: "Fix the parser",
          expect: [
            { kind: "tool-was-called", name: "write_file" },
            { kind: "tool-not-called", name: "run_command" },
            { kind: "no-tool-loop" },
          ],
        },
      ],
    };
    const good = trace({ id: "a", prompt: "Fix the parser", steps: [call(1, "write_file", {}), result(2, "write_file", true)] });
    expect(check(good, suite).passed).toBe(true);

    const looped = trace({
      id: "b",
      prompt: "Fix the parser",
      steps: [
        call(1, "write_file", { p: 1 }),
        result(2, "write_file", true),
        call(3, "write_file", { p: 1 }),
        result(4, "write_file", true),
        call(5, "write_file", { p: 1 }),
        result(6, "write_file", true),
        call(7, "run_command", { command: "ls" }),
        result(8, "run_command", true),
      ],
    });
    const c = check(looped, suite);
    expect(c.failed.map((f) => f.expectation.kind)).toEqual(["tool-not-called", "no-tool-loop"]);
  });

  it("fails a task on a crossed budget even when every expectation passed", () => {
    const suite: EvalSuite = {
      id: "s",
      name: "n",
      tasks: [
        {
          id: "t",
          capability: "c",
          prompt: "Fix the parser",
          expect: [{ kind: "tool-was-called", name: "write_file" }],
          budget: { maxIterations: 2, maxToolCalls: 1, maxTokens: 10 },
        },
      ],
    };
    const t = trace({
      id: "a",
      prompt: "Fix the parser",
      iterations: 5,
      promptTokens: 100,
      completionTokens: 0,
      steps: [
        call(1, "write_file", {}),
        result(2, "write_file", true),
        call(3, "read_file", {}),
        result(4, "read_file", true),
      ],
    });
    const c = check(t, suite);
    expect(c.failed).toHaveLength(0);
    expect(c.passed).toBe(false);
    // Kept apart from `failed` on purpose: the right answer at five times the cost is a different
    // result, and folding the two hides which one happened.
    expect(c.budgetExceeded).toHaveLength(3);
  });

  it("treats a refusal as a call that happened, so tool-not-called still fails", () => {
    const suite: EvalSuite = {
      id: "s",
      name: "n",
      tasks: [{ id: "t", capability: "c", prompt: "p", expect: [{ kind: "tool-not-called", name: "run_command" }] }],
    };
    const t = trace({ id: "a", prompt: "p", steps: [call(1, "run_command", {}), refused(2, "run_command")] });
    expect(check(t, suite).failed[0]?.reason).toMatch(/called anyway/);
  });
});

describe("estimateCost", () => {
  it("quotes tasks × repeats, from a stated assumption when there is no history", () => {
    const ports = withPrices(createTestPorts(SCRIPTS), { prompt: 3, completion: 15 });
    const e = estimateCost(ports, opts({ repeats: 3 }));
    expect(e.calls).toBe(6);
    expect(e.tasks).toBe(2);
    expect(e.repeats).toBe(3);
    expect(e.assumedTokensPerCall).toEqual(ASSUMED_TOKENS_PER_CALL);
    // 6 calls × 4000 prompt tokens at $3/M, plus 6 × 900 completion at $15/M.
    expect(e.usd).toBeCloseTo((24_000 / 1e6) * 3 + (5_400 / 1e6) * 15, 10);
  });

  it("reports an unknown price as null rather than as free", () => {
    const ports = createTestPorts(SCRIPTS);
    expect(estimateCost(ports, opts()).usd).toBeNull();
  });

  it("prefers the suite's own measured history over the assumption", async () => {
    const ports = withPrices(createTestPorts(SCRIPTS), { prompt: 3, completion: 15 });
    const first = await evaluateSuite(ports, opts({ repeats: 1 }));
    const stored = await ports.results.listSuiteResults({ suiteId: SUITE.id });
    expect(stored).toHaveLength(1);
    const e = estimateCost(ports, opts({ repeats: 1 }), [first.result]);
    expect(e.assumedTokensPerCall.prompt).toBe(first.result.cost.promptTokens / first.result.attemptSummaries.length);
    expect(e.assumedTokensPerCall.prompt).not.toBe(ASSUMED_TOKENS_PER_CALL.prompt);
  });
});

describe("the consent gate", () => {
  it("does not ask for a runner that costs nothing", async () => {
    const ports = withConsent(createTestPorts(SCRIPTS), true);
    expect(await authorizePaidRun(ports, opts())).toBeNull();
    expect(ports.asked).toHaveLength(0);
  });

  it("refuses a paid run when no consent mechanism was wired up", async () => {
    const ports = createTestPorts(SCRIPTS, { paid: true });
    let caught: unknown = null;
    try {
      await authorizePaidRun(ports, opts());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PaidRunRefusedError);
    const err = caught as PaidRunRefusedError;
    expect(err.estimate?.calls).toBe(6);
    expect(err.message).toMatch(/no consent mechanism/);
    expect(ports.runner.runs).toHaveLength(0);
  });

  it("refuses a paid run the user declined", async () => {
    const ports = withConsent(createTestPorts(SCRIPTS, { paid: true }), false);
    await expect(authorizePaidRun(ports, opts())).rejects.toThrow(/declined/);
    expect(ports.asked).toHaveLength(1);
  });

  it("shows the estimate it then spends against", async () => {
    const ports = withConsent(withPrices(createTestPorts(SCRIPTS, { paid: true }), { prompt: 3, completion: 15 }), true);
    const estimate = await authorizePaidRun(ports, opts({ repeats: 2 }));
    expect(estimate?.calls).toBe(4);
    expect(ports.asked[0]?.usd).toBe(estimate?.usd);
    expect(ports.asked[0]?.usd).not.toBeNull();
  });

  it("never runs the suite when consent was refused", async () => {
    const ports = withConsent(createTestPorts(SCRIPTS, { paid: true }), false);
    await expect(evaluateSuite(ports, opts())).rejects.toThrow(PaidRunRefusedError);
    expect(ports.runner.runs).toHaveLength(0);
    expect(await ports.results.listSuiteResults()).toHaveLength(0);
  });
});

describe("evaluateSuite", () => {
  it("defaults to three repeats, because one sample of a stochastic agent has no spread", () => {
    expect(DEFAULT_REPEATS).toBe(3);
  });

  it("runs task-major and sequentially, so latency stays comparable", async () => {
    const order: string[] = [];
    const ports = createTestPorts(SCRIPTS, { onRun: (r) => order.push(`${r.task.id}:${r.config.promptOverride === null ? "base" : "patched"}`) });
    const run = await evaluateSuite(ports, opts({ repeats: 3 }));
    expect(run.attempts).toHaveLength(6);
    expect(order).toEqual(["t1:base", "t1:base", "t1:base", "t2:base", "t2:base", "t2:base"]);
    expect(run.result.attemptSummaries.map((a) => `${a.taskId}.${a.repeat}`)).toEqual([
      "t1.0",
      "t1.1",
      "t1.2",
      "t2.0",
      "t2.1",
      "t2.2",
    ]);
  });

  it("stores the result, with a pass rate over attempts and not over tasks", async () => {
    const ports = createTestPorts({
      ...SCRIPTS,
      t2: { calls: [{ name: "read_file", args: {} }], finalText: "Read it." },
    });
    const run = await evaluateSuite(ports, opts({ repeats: 2 }));
    expect(run.result.passRate).toBe(0.5);
    expect(run.result.tasks.map((t) => [t.taskId, t.passRate])).toEqual([
      ["t1", 1],
      ["t2", 0],
    ]);
    const stored = await ports.results.listSuiteResults({ suiteId: SUITE.id, versionId: "builtin" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(run.result.id);
  });

  it("sums the tokens it actually spent", async () => {
    const ports = createTestPorts(SCRIPTS);
    const run = await evaluateSuite(ports, opts({ repeats: 1 }));
    const expected = run.attempts.reduce((n, a) => n + a.trace.promptTokens, 0);
    expect(run.result.cost.promptTokens).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("returns what it measured but stores nothing when the run was stopped", async () => {
    const ac = new AbortController();
    const ports = createTestPorts(SCRIPTS, {
      onRun: () => {
        if (ports.runner.runs.length >= 2) ac.abort();
      },
    });
    const run = await evaluateSuite(ports, opts({ repeats: 3, signal: ac.signal }));
    expect(run.aborted).toBe(true);
    expect(run.attempts.length).toBeGreaterThan(0);
    expect(run.attempts.length).toBeLessThan(6);
    // A partial result matches every key `benchmark` reuses on, so storing it would let a
    // half-finished baseline be compared against a complete candidate later.
    expect(await ports.results.listSuiteResults()).toHaveLength(0);
  });

  it("leaves the mean duration null when an attempt never reported an end", async () => {
    const unfinished: AgentRunnerPort = {
      paid: false,
      async run(req): Promise<RunTrace> {
        return trace({ id: `u-${req.task.id}`, prompt: req.task.prompt, endedAt: null, steps: [done(1)] });
      },
    };
    const ports: AxiomPorts = { ...createTestPorts(SCRIPTS), runner: unfinished };
    const run = await evaluateSuite(ports, opts({ repeats: 2 }));
    expect(run.result.tasks.every((t) => t.meanDurationMs === null)).toBe(true);
    expect(run.result.attemptSummaries.every((a) => a.durationMs === null)).toBe(true);
  });

  it("carries the failure reason in the words a user reads", async () => {
    const ports = createTestPorts({
      ...SCRIPTS,
      t1: { calls: [{ name: "write_file", args: {} }], finalText: "Done, it is fixed." },
    });
    const run = await evaluateSuite(ports, opts({ repeats: 1 }));
    const t1 = run.result.attemptSummaries.find((a) => a.taskId === "t1");
    expect(t1?.passed).toBe(false);
    expect(t1?.failedReasons[0]).toMatch(/claimed completion/);
    expect(t1?.failedReasons[0]).toMatch(/no evidence-producing call/);
  });
});
