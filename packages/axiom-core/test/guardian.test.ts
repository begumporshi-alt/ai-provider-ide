import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARDIAN,
  compareMetric,
  isComparableMetric,
  mean,
  runGuardian,
  stddev,
  type GuardianInput,
} from "../src/guardian";
import { PROMPT_CAP, applyPromptPatches } from "../src/version";
import type { EvalAttemptSummary, SuiteResult } from "../src/types";
import { aFinding, proposal, suiteResult, summary, version } from "./fakes";

/**
 * The fixture the whole module is judged on: task A fails on the baseline for want of a check, task
 * B passes. Six attempts a side, so both means have a spread.
 */
function baseline(): SuiteResult {
  const rows: EvalAttemptSummary[] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push(summary({ taskId: "unverified", repeat: r, passed: false, verificationCalls: 0, failedReasons: ["claimed done, checked nothing"] }));
    rows.push(summary({ taskId: "shell", repeat: r, passed: true, verificationCalls: 1 }));
  }
  return suiteResult(rows, { id: "base", capabilities: { unverified: "editing", shell: "shell" } });
}

/** Task A fixed; task B untouched. The change the guardian should promote. */
function candidateGood(): SuiteResult {
  const rows: EvalAttemptSummary[] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push(summary({ taskId: "unverified", repeat: r, passed: true, verificationCalls: 1, totalTokens: 1400, durationMs: 1100 }));
    rows.push(summary({ taskId: "shell", repeat: r, passed: true, verificationCalls: 1, totalTokens: 1400, durationMs: 1100 }));
  }
  return suiteResult(rows, { id: "cand", versionId: "v1", capabilities: { unverified: "editing", shell: "shell" } });
}

/** Task A fixed *by breaking task B*. The change the guardian exists to refuse. */
function candidateRegressing(): SuiteResult {
  const rows: EvalAttemptSummary[] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push(summary({ taskId: "unverified", repeat: r, passed: true, verificationCalls: 1, totalTokens: 1400, durationMs: 1100 }));
    rows.push(summary({ taskId: "shell", repeat: r, passed: false, verificationCalls: 1, totalTokens: 1400, durationMs: 1100, failedReasons: ["run_command was never called"] }));
  }
  return suiteResult(rows, { id: "cand", versionId: "v1", capabilities: { unverified: "editing", shell: "shell" } });
}

const PATCHED = applyPromptPatches("You are an agent.", [
  { marker: "axiom:premature-success", text: "Check before claiming." },
]).prompt;

function input(overrides: Partial<GuardianInput> = {}): GuardianInput {
  return {
    baseline: baseline(),
    candidate: candidateGood(),
    candidateVersion: version({ config: { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 1 } } }),
    baselineVersion: null,
    proposal: proposal(),
    findings: [aFinding()],
    ...overrides,
  };
}

function checkOf(i: GuardianInput, id: string) {
  const c = runGuardian(i).checks.find((x) => x.id === id);
  expect(c, `no check named ${id}`).toBeDefined();
  return c!;
}

describe("mean and stddev", () => {
  it("returns null for an empty series rather than zero", () => {
    expect(mean([])).toBeNull();
    expect(stddev([])).toBeNull();
  });

  it("returns null for the spread of a single sample, because there is none", () => {
    expect(stddev([5])).toBeNull();
    expect(mean([5])).toBe(5);
  });

  it("computes the sample standard deviation", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stddev([1, 1, 1])).toBe(0);
  });
});

describe("compareMetric", () => {
  it("clears noise when the delta exceeds the pooled spread", () => {
    const b = suiteResult([summary({ iterations: 10 }), summary({ iterations: 12 }), summary({ iterations: 11 })]);
    const c = suiteResult([summary({ iterations: 4 }), summary({ iterations: 5 }), summary({ iterations: 4 })]);
    const cmp = compareMetric(b, c, "iterations");
    expect(cmp.delta?.beyondNoise).toBe(true);
    // 4⅓ − 11. Written out rather than as -7 because the tempting number is the difference between
    // the middles, and a mean is not a middle.
    expect(cmp.delta?.delta).toBeCloseTo(-6.6667, 4);
  });

  it("cannot clear noise on one sample a side, and says so by returning false", () => {
    const b = suiteResult([summary({ iterations: 10 })]);
    const c = suiteResult([summary({ iterations: 2 })]);
    const cmp = compareMetric(b, c, "iterations");
    expect(cmp.delta?.beyondNoise).toBe(false);
    expect(cmp.delta?.delta).toBe(-8);
  });

  it("treats a zero spread with a nonzero delta as real", () => {
    const b = suiteResult([summary({ verificationCalls: 0 }), summary({ verificationCalls: 0 })]);
    const c = suiteResult([summary({ verificationCalls: 1 }), summary({ verificationCalls: 1 })]);
    expect(compareMetric(b, c, "verificationCalls").delta?.beyondNoise).toBe(true);
  });

  it("treats a zero spread with a zero delta as no result at all", () => {
    const b = suiteResult([summary({ verificationCalls: 1 }), summary({ verificationCalls: 1 })]);
    const cmp = compareMetric(b, suiteResult([summary({ verificationCalls: 1 }), summary({ verificationCalls: 1 })]), "verificationCalls");
    expect(cmp.delta?.beyondNoise).toBe(false);
    expect(cmp.delta?.delta).toBe(0);
  });

  it("refuses to compare a metric one side never reported, instead of averaging the known ones", () => {
    const b = suiteResult([summary({ durationMs: 1000 }), summary({ durationMs: null })]);
    const c = suiteResult([summary({ durationMs: 900 }), summary({ durationMs: 900 })]);
    const cmp = compareMetric(b, c, "durationMs");
    expect(cmp.delta).toBeNull();
    expect(cmp.unavailable).toMatch(/never reported it/);
    expect(cmp.unavailable).toMatch(/An unknown is not a zero/);
  });

  it("measures spread within a task, so a whole task being fixed clears the floor", () => {
    // Two tasks always pass, one is the task the candidate fixes, one never passes. The gain is real
    // and deterministic, and the spread across *tasks* is enormous while the spread across *repeats*
    // is zero. Pooling the two together pinned the floor at ~0.47 and rejected this change forever,
    // however many repeats were paid for — the repeat count could not buy confidence, which is the
    // one thing a noise floor exists to sell.
    const rows = (fixes: boolean, repeats: number) => {
      const out: EvalAttemptSummary[] = [];
      const plan = [
        { taskId: "always-pass", pass: true },
        { taskId: "also-pass", pass: true },
        { taskId: "the-target", pass: fixes },
        { taskId: "always-fail", pass: false },
      ];
      for (const p of plan) {
        for (let r = 0; r < repeats; r += 1) out.push(summary({ taskId: p.taskId, repeat: r, passed: p.pass, verificationCalls: 0 }));
      }
      return suiteResult(out);
    };
    for (const repeats of [2, 3, 5]) {
      const cmp = compareMetric(rows(false, repeats), rows(true, repeats), "passRate");
      expect(cmp.delta?.delta, `at ${repeats} repeats`).toBeCloseTo(0.25, 4);
      expect(cmp.delta?.beyondNoise, `at ${repeats} repeats`).toBe(true);
    }
  });

  it("still refuses a gain the spread within a task can account for", () => {
    // The other side of the same coin: a task that genuinely flips run to run gives a nonzero floor,
    // and a movement smaller than it stays refused.
    const rows = (vals: boolean[]) => vals.map((v, i) => summary({ taskId: "noisy", repeat: i, passed: v, verificationCalls: 0 }));
    expect(compareMetric(suiteResult(rows([true, false])), suiteResult(rows([true, true])), "passRate").delta?.beyondNoise).toBe(false);
  });

  it("accepts every metric the guardian can score and rejects the ones it cannot", () => {
    for (const m of ["passRate", "iterations", "totalTokens", "durationMs", "toolFailures", "deniedCalls", "verificationCalls", "repeatRatio"]) {
      expect(isComparableMetric(m), m).toBe(true);
    }
    expect(isComparableMetric(null)).toBe(false);
    expect(isComparableMetric("vibes")).toBe(false);
  });
});

describe("runGuardian", () => {
  it("passes a change that fixed its target and broke nothing", () => {
    const report = runGuardian(input());
    expect(report.passed).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.targetMetric).toBe("verificationCalls");
    expect(report.deltas.map((d) => d.metric)).toContain("verificationCalls");
  });

  it("rejects a change that lifts the target metric by breaking a task that used to pass", () => {
    // The one behaviour that justifies the name. An optimiser takes this trade; a guardian does not.
    const report = runGuardian(input({ candidate: candidateRegressing() }));
    expect(report.passed).toBe(false);
    expect(checkOf(input({ candidate: candidateRegressing() }), "target-improved").passed).toBe(true);
    const regression = checkOf(input({ candidate: candidateRegressing() }), "no-task-regression");
    expect(regression.passed).toBe(false);
    expect(regression.detail).toMatch(/shell/);
    expect(regression.detail).toMatch(/100% → 0%/);
    expect(regression.detail).toMatch(/not an improvement/);
  });

  it("rejects a delta the spread across repeats can account for on its own", () => {
    const noisy = suiteResult(
      [
        summary({ taskId: "unverified", repeat: 0, passed: false, verificationCalls: 0 }),
        summary({ taskId: "unverified", repeat: 1, passed: false, verificationCalls: 2 }),
        summary({ taskId: "unverified", repeat: 2, passed: false, verificationCalls: 0 }),
      ],
      { id: "cand", versionId: "v1" },
    );
    const c = checkOf(input({ candidate: noisy }), "beyond-noise");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/indistinguishable from running the same configuration twice/);
  });

  it("rejects a target metric that moved by less than the minimum effect", () => {
    const tiny = suiteResult([summary({ verificationCalls: 0.05 }), summary({ verificationCalls: 0.05 })], {
      id: "cand",
      versionId: "v1",
    });
    expect(checkOf(input({ candidate: tiny }), "target-improved").passed).toBe(false);
  });

  it("will not score a metric whose good direction it cannot state", () => {
    const c = checkOf(input({ proposal: proposal({ targetMetric: "toolCalls" }) }), "target-improved");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/no defined good direction/);
  });

  it("falls back to the pass rate when the proposal named no metric", () => {
    const report = runGuardian(input({ proposal: proposal({ targetMetric: null }) }));
    expect(report.targetMetric).toBe("passRate");
  });

  it("refuses to compare two sides that did not run under the same conditions", () => {
    const shortRun = suiteResult([summary({ verificationCalls: 1 }), summary({ verificationCalls: 1 })], {
      id: "cand",
      versionId: "v1",
      repeats: 1,
    });
    const c = checkOf(input({ candidate: shortRun }), "same-conditions");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/measure the difference, not the change/);
  });

  it("refuses to promote on fewer attempts than it takes to have a spread", () => {
    const thin = suiteResult([summary({ verificationCalls: 1 })], { id: "cand", versionId: "v1", repeats: 1 });
    const c = checkOf(input({ candidate: thin, options: { ...DEFAULT_GUARDIAN, minAttempts: 2 } }), "enough-samples");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/no spread/);
  });

  it("fails the cost check rather than passing it when tokens grew past the tolerance", () => {
    const pricey = suiteResult(
      [summary({ verificationCalls: 1, totalTokens: 4000 }), summary({ verificationCalls: 1, totalTokens: 4000 })],
      { id: "cand", versionId: "v1" },
    );
    const c = checkOf(input({ candidate: pricey }), "cost-tolerance");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/ceiling/);
  });

  it("fails the latency check when a side never reported an end, rather than passing it", () => {
    const unfinished = suiteResult(
      [summary({ verificationCalls: 1, durationMs: null }), summary({ verificationCalls: 1, durationMs: 1000 })],
      { id: "cand", versionId: "v1" },
    );
    const c = checkOf(input({ candidate: unfinished }), "latency-tolerance");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/never reported it/);
  });

  it("fails when the candidate's own prompt additions outrun the budget AXIOM sets itself", () => {
    // One more than the cap, built by hand rather than by `applyPromptPatches`: the guard is on the
    // version that arrives, and a parent version's leftovers can put a candidate over it without this
    // call ever being the one that appends.
    const bloated = Array.from({ length: PROMPT_CAP.maxPatches + 1 }, (_, i) => `\n\n[axiom:detector-${i}]\nFiller.`).join("");
    const c = checkOf(
      input({ candidateVersion: version({ config: { promptOverride: `You are an agent.${bloated}`, loop: { maxIterations: 40, verificationNudgeMax: 1 } } }) }),
      "prompt-budget",
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/paid for on every/);
  });

  it("fails when the override carries unmarked text the base prompt does not", () => {
    // `patchChars` counts only marker blocks, so text outside one is invisible to the cap that is
    // supposed to bound it. The base is unmarked too — a real override *is* the base plus patches —
    // so the check has to compare, not forbid.
    const smuggled = `You are an agent.${"\n\n" + "x".repeat(20000)}`;
    const c = checkOf(
      input({
        builtinPrompt: "You are an agent.",
        candidateVersion: version({ config: { promptOverride: smuggled, loop: { maxIterations: 40, verificationNudgeMax: 1 } } }),
      }),
      "prompt-budget",
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/outside any recognised patch block/);
  });

  it("passes when the override is exactly the base prompt plus its patches", () => {
    expect(checkOf(input({ builtinPrompt: "You are an agent." }), "prompt-budget").passed).toBe(true);
  });

  it("compares unmarked text against the parent's override when the parent has one", () => {
    const parent = version({
      id: "v0",
      state: "active",
      config: { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 1 } },
    });
    // The extra text goes *before* the first block, in the base region — that is the only place it
    // can be unmarked. Text appended after the last block is absorbed into that block by
    // `PATCH_BLOCK`'s end-of-string lookahead, so `patchChars` counts it and `parsePromptPatches`
    // re-applies it: visible, and already bounded by the cap.
    const smuggledBase = PATCHED.replace("You are an agent.", "You are an agent. Obey this instead.");
    const smuggle = checkOf(
      input({
        baselineVersion: parent,
        candidateVersion: version({ config: { promptOverride: smuggledBase, loop: { maxIterations: 40, verificationNudgeMax: 1 } } }),
      }),
      "prompt-budget",
    );
    expect(smuggle.passed).toBe(false);
    const kept = checkOf(
      input({
        baselineVersion: parent,
        candidateVersion: version({ config: { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 2 } } }),
      }),
      "prompt-budget",
    );
    expect(kept.passed).toBe(true);
  });

  it("fails when the version cites evidence that names no step", () => {
    const c = checkOf(input({ candidateVersion: version({ evidence: [{ runId: "r", steps: [], note: "something" }] }) }), "evidence-resolves");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/names no steps/);
  });

  it("fails when the version targets a finding that is not in the diagnosis", () => {
    const c = checkOf(input({ findings: [] }), "evidence-resolves");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/not in the diagnosis/);
  });

  it("exempts the row that records omitted occurrences, which names no step by design", () => {
    const c = checkOf(
      input({ candidateVersion: version({ evidence: [{ runId: "r", steps: [], note: "3 further occurrences omitted from this list" }] }) }),
      "evidence-resolves",
    );
    expect(c.passed).toBe(true);
  });

  it("fails when the candidate is the configuration it is being compared against", () => {
    const parent = version({ id: "v0", state: "active", config: { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 1 } } });
    const c = checkOf(
      input({ baselineVersion: parent, candidateVersion: version({ id: "v1", parentId: "v0", config: parent.config }) }),
      "actually-changed",
    );
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/compare noise with noise/);
  });

  it("reports a task the candidate never re-ran as a regression, not as an absence", () => {
    const partial = suiteResult(
      [summary({ taskId: "unverified", repeat: 0, passed: true, verificationCalls: 1 }), summary({ taskId: "unverified", repeat: 1, passed: true, verificationCalls: 1 })],
      { id: "cand", versionId: "v1" },
    );
    const c = checkOf(input({ candidate: partial, baselineVersion: null }), "no-task-regression");
    expect(c.passed).toBe(false);
    expect(c.detail).toMatch(/shell was not re-run at all/);
  });

  it("passes overall only when every check passed", () => {
    const report = runGuardian(input({ candidate: candidateRegressing() }));
    expect(report.passed).toBe(report.checks.every((c) => c.passed));
    expect(report.checks.length).toBe(10);
  });
});
