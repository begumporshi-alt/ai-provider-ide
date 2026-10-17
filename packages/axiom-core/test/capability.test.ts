import { describe, expect, it } from "vitest";
import { buildCapabilityMap, describeCapabilityState, toCapabilityAttempts } from "../src/capability";
import { evaluateSuite } from "../src/evaluate";
import type { CapabilityState, EvalSuite } from "../src/types";
import { TEST_LOOP, TEST_POLICY, createTestPorts, type AgentScript } from "./fakes";

/**
 * One suite, four capabilities, each in a different state. Built by actually running the evaluator
 * rather than by hand-assembling a `SuiteResult`, because the map's whole claim is that it reads the
 * same numbers the guardian reads.
 */
const SUITE: EvalSuite = {
  id: "cap",
  name: "Capability map",
  tasks: [
    {
      id: "ok",
      capability: "verified-editing",
      prompt: "Fix and prove it",
      expect: [{ kind: "verified-done" }, { kind: "tool-was-called", name: "run_command" }],
    },
    {
      id: "overclaim",
      capability: "refactoring",
      prompt: "Refactor the module",
      expect: [{ kind: "verified-done" }],
    },
    {
      id: "honest-fail",
      capability: "web-fetch",
      prompt: "Fetch the page",
      expect: [{ kind: "tool-was-called", name: "web_fetch" }],
    },
    {
      id: "half",
      capability: "planning",
      prompt: "Plan the migration",
      expect: [{ kind: "final-text-matches", pattern: "step 3" }],
    },
    {
      id: "ok-2",
      capability: "verified-editing",
      prompt: "Fix the second bug",
      expect: [{ kind: "tool-was-called", name: "run_command" }],
    },
  ],
};

const verified: AgentScript = {
  calls: [
    { name: "write_file", args: { path: "a.ts" } },
    { name: "run_command", args: { command: "pnpm test" }, result: "2 passed" },
  ],
  finalText: "Done — the tests pass.",
};

const SCRIPTS: Record<string, AgentScript> = {
  ok: verified,
  "ok-2": verified,
  // Fails its expectation *and* says it succeeded: the column a pass-rate table hides.
  overclaim: { calls: [{ name: "edit_file", args: {} }], finalText: "Done, the refactor is complete." },
  // Fails and says so. A known hole rather than a lid on one.
  "honest-fail": { calls: [{ name: "read_file", args: {} }], finalText: "I could not fetch it; no network tool answered." },
  half: { calls: [], finalText: "step 1, step 2" },
};

/**
 * The `half` task passes on every other repeat, which is the only way to get a genuinely mixed
 * capability out of a deterministic fixture. Counted per task rather than globally, so the parity
 * does not depend on how many tasks precede it or on the repeat count.
 */
function alternatingRunner(ports: ReturnType<typeof createTestPorts>) {
  const seen = new Map<string, number>();
  const inner = ports.runner;
  return {
    ...ports,
    runner: {
      paid: false,
      async run(req: Parameters<typeof inner.run>[0]) {
        if (req.task.id !== "half") return inner.run(req);
        const n = (seen.get("half") ?? 0) + 1;
        seen.set("half", n);
        return n % 2 === 0 ? inner.run({ ...req, task: { ...req.task, id: "half-pass" } }) : inner.run(req);
      },
    },
  };
}

async function build(repeats = 2) {
  const base = createTestPorts({ ...SCRIPTS, "half-pass": { calls: [], finalText: "step 1, step 2, step 3" } });
  const ports = alternatingRunner(base);
  const run = await evaluateSuite(ports, {
    suite: SUITE,
    model: "test/model",
    config: { promptOverride: null, loop: TEST_LOOP },
    versionId: "builtin",
    policy: TEST_POLICY,
    repeats,
  });
  return buildCapabilityMap({
    result: run.result,
    attempts: toCapabilityAttempts(run.attempts),
    policy: TEST_POLICY,
  });
}

function entry(map: Awaited<ReturnType<typeof build>>, capability: string) {
  const e = map.find((x) => x.capability === capability);
  expect(e, `no capability named ${capability}`).toBeDefined();
  return e!;
}

describe("buildCapabilityMap", () => {
  it("marks a capability reliable when every attempt passed", async () => {
    const map = await build();
    const e = entry(map, "verified-editing");
    expect(e.state).toBe("reliable");
    expect(e.passRate).toBe(1);
    // Two tasks share this capability, and the map counts tasks, not attempts.
    expect(e.tasks).toBe(2);
    expect(e.overclaimRuns).toBe(0);
  });

  it("marks a capability absent when it failed every attempt and said so", async () => {
    const e = entry(await build(), "web-fetch");
    expect(e.state).toBe("absent");
    expect(e.passRate).toBe(0);
    expect(e.overclaimRuns).toBe(0);
  });

  it("marks a capability overclaimed when a failed attempt asserted completion", async () => {
    const e = entry(await build(), "refactoring");
    expect(e.state).toBe("overclaimed");
    expect(e.overclaimRuns).toBe(2);
    expect(e.passRate).toBe(0);
  });

  it("marks a capability unreliable when it passes sometimes", async () => {
    const e = entry(await build(), "planning");
    expect(e.state).toBe("unreliable");
    expect(e.passRate).toBe(0.5);
    expect(e.overclaimRuns).toBe(0);
  });

  it("ranks overclaimed above absent, because a hole with a lid on it is the worse one", async () => {
    const map = await build();
    const order = map.map((e) => e.capability);
    expect(order.indexOf("refactoring")).toBeLessThan(order.indexOf("web-fetch"));
    expect(map[0]?.state).toBe("overclaimed");
    expect(map[map.length - 1]?.state).toBe("reliable");
  });

  it("does not call a passing run an overclaim, however confident its wording", async () => {
    // `verified-editing` claims completion on every attempt and passes every attempt. Believing it
    // is the point of the exercise; only a claim contradicted by the transcript is an overclaim.
    expect(entry(await build(), "verified-editing").overclaimRuns).toBe(0);
  });

  it("says which detectors fired, so the map explains itself", async () => {
    const base = createTestPorts(SCRIPTS, {});
    const run = await evaluateSuite(base, {
      suite: { id: "s", name: "n", tasks: [SUITE.tasks[1]!] },
      model: "test/model",
      config: { promptOverride: null, loop: TEST_LOOP },
      versionId: "builtin",
      policy: TEST_POLICY,
      repeats: 1,
    });
    const map = buildCapabilityMap({
      result: run.result,
      attempts: toCapabilityAttempts(run.attempts),
      policy: TEST_POLICY,
      findings: [
        {
          id: "f1",
          detector: "premature-success",
          title: "t",
          severity: "critical",
          rootCause: "prompt",
          rationale: "r",
          differential: false,
          evidence: [{ runId: run.attempts[0]!.trace.id, steps: [3], note: "n" }],
          occurrences: 1,
          metric: "verificationCalls",
        },
        {
          id: "f2",
          detector: "tool-loop",
          title: "t",
          severity: "major",
          rootCause: "orchestration",
          rationale: "r",
          differential: false,
          // A finding about some other run must not be attributed to this capability.
          evidence: [{ runId: "unrelated", steps: [1], note: "n" }],
          occurrences: 1,
          metric: "repeatRatio",
        },
      ],
    });
    expect(map[0]?.findings).toEqual(["premature-success"]);
  });

  it("falls back to the task id for an attempt whose task is not in the result", () => {
    const map = buildCapabilityMap({
      result: {
        id: "r",
        suiteId: "s",
        versionId: "v",
        model: "m",
        startedAt: 0,
        endedAt: 0,
        repeats: 1,
        tasks: [],
        attemptSummaries: [],
        passRate: 0,
        cost: { promptTokens: 0, completionTokens: 0 },
      },
      attempts: [
        {
          taskId: "orphan",
          passed: false,
          runId: "run-1",
          metrics: {
            durationMs: null,
            toolCalls: 0,
            toolFailures: 0,
            deniedCalls: 0,
            iterations: 1,
            totalTokens: 0,
            distinctToolCalls: 0,
            repeatRatio: 0,
            longestRepeatRun: null,
            claimedDone: false,
            firstDoneSeq: null,
            verificationCalls: 0,
            unansweredCalls: 0,
            assistantTexts: [],
            finalAssistantText: null,
            invocations: [],
          },
        },
      ],
      policy: TEST_POLICY,
    });
    expect(map).toHaveLength(1);
    expect(map[0]?.capability).toBe("orphan");
    expect(map[0]?.state).toBe("absent");
  });
});

describe("describeCapabilityState", () => {
  it("covers all four states", () => {
    const states: CapabilityState[] = ["reliable", "unreliable", "absent", "overclaimed"];
    for (const s of states) expect(describeCapabilityState(s).length).toBeGreaterThan(10);
  });

  it("does not soften the overclaim sentence", () => {
    expect(describeCapabilityState("overclaimed")).toMatch(/unverified/);
  });
});
