import { describe, expect, it } from "vitest";
import { runGuardian, type GuardianReport } from "../src/guardian";
import { conveneRoles, critique, investigate, reviewArchitecture, verify, type RoleInput } from "../src/roles";
import { PROMPT_CAP, applyPromptPatches } from "../src/version";
import type { EvalAttemptSummary, EvalSuite, SuiteResult } from "../src/types";
import { aFinding, proposal, suiteResult, summary, version } from "./fakes";

/**
 * The same two-task fixture the guardian is judged on, so a role's verdict here says something about
 * a comparison that could actually have detected a regression.
 */
const SUITE: EvalSuite = {
  id: "s1",
  name: "Two capabilities",
  tasks: [
    { id: "unverified", capability: "editing", prompt: "Fix the bug", expect: [{ kind: "verified-done" }] },
    { id: "shell", capability: "shell", prompt: "Run the tests", expect: [{ kind: "tool-was-called", name: "run_command" }] },
  ],
};

const CAPS = { unverified: "editing", shell: "shell" };

function baseline(): SuiteResult {
  const rows: EvalAttemptSummary[] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push(summary({ taskId: "unverified", repeat: r, passed: false, verificationCalls: 0, failedReasons: ["claimed done, checked nothing"] }));
    rows.push(summary({ taskId: "shell", repeat: r, passed: true, verificationCalls: 1 }));
  }
  return suiteResult(rows, { id: "base", suiteId: "s1", capabilities: CAPS });
}

function candidate(): SuiteResult {
  const rows: EvalAttemptSummary[] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push(summary({ taskId: "unverified", repeat: r, passed: true, verificationCalls: 1, totalTokens: 1400, durationMs: 1100 }));
    rows.push(summary({ taskId: "shell", repeat: r, passed: true, verificationCalls: 1, totalTokens: 1400, durationMs: 1100 }));
  }
  return suiteResult(rows, { id: "cand", suiteId: "s1", versionId: "v1", capabilities: CAPS });
}

function candidateRegressing(): SuiteResult {
  const rows: EvalAttemptSummary[] = [];
  for (let r = 0; r < 3; r += 1) {
    rows.push(summary({ taskId: "unverified", repeat: r, passed: true, verificationCalls: 1, totalTokens: 1400, durationMs: 1100 }));
    rows.push(summary({ taskId: "shell", repeat: r, passed: false, verificationCalls: 1, totalTokens: 1400, durationMs: 1100, failedReasons: ["run_command was never called"] }));
  }
  return suiteResult(rows, { id: "cand", suiteId: "s1", versionId: "v1", capabilities: CAPS });
}

const PATCHED = applyPromptPatches("You are an agent.", [
  { marker: "axiom:premature-success", text: "Check before claiming." },
]).prompt;

function patchedVersion(): ReturnType<typeof version> {
  return version({ config: { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 1 } } });
}

/**
 * The guardian runs for real unless a test overrides it. A role test that stubbed the report would be
 * testing the stub.
 */
function input(overrides: Partial<RoleInput> = {}): RoleInput {
  const base: RoleInput = {
    proposal: proposal(),
    findings: [aFinding()],
    suite: SUITE,
    baseline: baseline(),
    candidate: candidate(),
    baselineVersion: null,
    candidateVersion: patchedVersion(),
    guardian: runGuardian({
      baseline: baseline(),
      candidate: candidate(),
      candidateVersion: patchedVersion(),
      baselineVersion: null,
      proposal: proposal(),
      findings: [aFinding()],
    }),
    ...overrides,
  };
  return base;
}

/** Rewrite one field of a real report, so the recomputation has something to disagree with. */
function corrupt(report: GuardianReport, deltas: GuardianReport["deltas"]): GuardianReport {
  return { ...report, deltas };
}

describe("investigator", () => {
  it("approves a proposal whose every claim points at a step in a real run", () => {
    expect(investigate(input()).approve).toBe(true);
  });

  it("objects to a proposal that targets a finding the diagnosis does not contain", () => {
    const v = investigate(input({ proposal: proposal({ targetsFindingIds: ["f99"] }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/f99.*does not contain/);
  });

  it("objects to a proposal that targets nothing, because then it fixes nothing", () => {
    const v = investigate(input({ proposal: proposal({ targetsFindingIds: [] }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/targets no finding/);
  });

  it("objects to a finding that cites no evidence at all", () => {
    const v = investigate(input({ findings: [aFinding({ evidence: [] })] }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/cites no evidence/);
  });

  it("objects to a finding that names a run without naming a step in it", () => {
    const v = investigate(input({ findings: [aFinding({ evidence: [{ runId: "run-1", steps: [], note: "it happened" }] })] }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/without naming a single step/);
  });

  it("exempts the row that records omitted occurrences, which names no step by design", () => {
    const v = investigate(
      input({ findings: [aFinding({ evidence: [{ runId: "run-1", steps: [], note: "3 further occurrences omitted from this list" }] })] }),
    );
    expect(v.approve).toBe(true);
  });

  it("objects to acting on one run with no comparison available", () => {
    const v = investigate(input({ findings: [aFinding({ occurrences: 1, differential: false })] }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/hypothesis/);
    expect(v.objections.join(" ")).toMatch(/not fine to act on/);
  });

  it("accepts one run when a differential backs it, because then it is two observations", () => {
    expect(investigate(input({ findings: [aFinding({ occurrences: 1, differential: true })] })).approve).toBe(true);
  });

  it("objects to a proposal that carries no evidence forward into the version", () => {
    const v = investigate(input({ proposal: proposal({ evidence: [] }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/carries no evidence/);
  });
});

describe("architect", () => {
  it("approves a prompt patch for a fault the prompt owns", () => {
    expect(reviewArchitecture(input()).approve).toBe(true);
  });

  it("refuses to promote a recommendation, because there is nothing in it to promote", () => {
    const v = reviewArchitecture(
      input({ proposal: proposal({ actuator: "manual", patch: undefined, blockedReason: "No actuator over memory." }) }),
    );
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/recommendation, not a change/);
  });

  it("refuses a configuration change offered as the fix for a model limit", () => {
    // The spec's central rule, held by a role rather than by a comment.
    const v = reviewArchitecture(input({ proposal: proposal({ rootCause: "model" }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/attributes this to the model/);
  });

  it("refuses to raise a budget in response to the budget being blown", () => {
    const v = reviewArchitecture(
      input({
        proposal: proposal({
          actuator: "loop-params",
          detector: "runaway",
          patch: undefined,
          loop: { field: "maxIterations", from: 40, to: 60 },
        }),
      }),
    );
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/buys more of the behaviour that was diagnosed/);
  });

  it("allows a loop change that does not buy more of what was diagnosed", () => {
    const v = reviewArchitecture(
      input({
        proposal: proposal({
          actuator: "loop-params",
          detector: "premature-success",
          patch: undefined,
          loop: { field: "verificationNudgeMax", from: 1, to: 2 },
        }),
        candidateVersion: version({ config: { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 2 } } }),
      }),
    );
    expect(v.approve).toBe(true);
  });

  it("refuses a version that differs from its parent in two places", () => {
    const v = reviewArchitecture(
      input({
        baselineVersion: version({ id: "v0", state: "retired", config: { promptOverride: "You are an agent.", loop: { maxIterations: 40, verificationNudgeMax: 1 } } }),
        candidateVersion: version({ config: { promptOverride: PATCHED, loop: { maxIterations: 60, verificationNudgeMax: 1 } } }),
      }),
    );
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/2 places \(prompt, maxIterations\)/);
    expect(v.objections.join(" ")).toMatch(/nothing will say which edit moved them/);
  });

  it("refuses a version identical to its parent, which would compare noise with noise", () => {
    const cfg = { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 1 } };
    const v = reviewArchitecture(input({ baselineVersion: version({ id: "v0", state: "retired", config: cfg }), candidateVersion: version({ config: cfg }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/byte-identical to its parent/);
  });

  it("says nothing about the diff when there is no parent to diff against", () => {
    expect(reviewArchitecture(input({ baselineVersion: null })).objections.join(" ")).not.toMatch(/parent/);
  });

  it("refuses a rationale too short to have reasoned about anything", () => {
    const v = reviewArchitecture(input({ proposal: proposal({ rationale: "Looks bad." }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/too short/);
  });

  it("leaves the prompt budget to the guardian rather than checking it twice", () => {
    const bloated = Array.from({ length: PROMPT_CAP.maxPatches + 1 }, (_, i) => `\n\n[axiom:detector-${i}]\nFiller.`).join("");
    const v = reviewArchitecture(
      input({
        baselineVersion: version({ id: "v0", state: "retired", config: { promptOverride: "You are an agent.", loop: { maxIterations: 40, verificationNudgeMax: 1 } } }),
        candidateVersion: version({ config: { promptOverride: `You are an agent.${bloated}`, loop: { maxIterations: 40, verificationNudgeMax: 1 } } }),
      }),
    );
    // One differing field, so the architect has nothing to say. The budget is the guardian's check,
    // and duplicating it here would be a second place for the number to rot.
    expect(v.approve).toBe(true);
  });
});

describe("critic", () => {
  it("approves a comparison that could have detected a regression", () => {
    expect(critique(input()).approve).toBe(true);
  });

  it("objects to a suite with one task, where no-regression passes by having nothing to check", () => {
    const v = critique(input({ suite: { ...SUITE, tasks: [SUITE.tasks[0]!] } }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/1 task\(s\)/);
    expect(v.objections.join(" ")).toMatch(/nothing for a regression to show up in/);
  });

  it("objects to fewer than three repeats, where the noise floor is itself uncertain", () => {
    const thin = suiteResult(
      [
        summary({ taskId: "unverified", repeat: 0, passed: false, verificationCalls: 0 }),
        summary({ taskId: "shell", repeat: 0, passed: true, verificationCalls: 1 }),
      ],
      { id: "base", suiteId: "s1", capabilities: CAPS },
    );
    const v = critique(input({ baseline: thin }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/1 repeat\(s\)/);
  });

  it("objects when every baseline attempt passed, because there is nothing to improve", () => {
    const clean = suiteResult(
      [
        summary({ taskId: "unverified", repeat: 0, passed: true, verificationCalls: 1 }),
        summary({ taskId: "shell", repeat: 0, passed: true, verificationCalls: 1 }),
      ],
      { id: "base", suiteId: "s1", capabilities: CAPS },
    );
    const v = critique(input({ baseline: clean }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/no failure to fix/);
    expect(v.objections.join(" ")).toMatch(/sampling variation with a direction/);
  });

  it("objects when every task measures one capability", () => {
    const v = critique(
      input({
        suite: {
          ...SUITE,
          tasks: [
            { id: "unverified", capability: "editing", prompt: "Fix", expect: [{ kind: "verified-done" }] },
            { id: "shell", capability: "editing", prompt: "Run", expect: [{ kind: "tool-was-called", name: "run_command" }] },
          ],
        },
      }),
    );
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/measure one capability/);
  });

  it("objects to adding instructions to an agent that already passes everything", () => {
    const perfect = suiteResult(
      [
        summary({ taskId: "unverified", repeat: 0, passed: true, verificationCalls: 1 }),
        summary({ taskId: "unverified", repeat: 1, passed: true, verificationCalls: 1 }),
        summary({ taskId: "unverified", repeat: 2, passed: true, verificationCalls: 1 }),
        summary({ taskId: "shell", repeat: 0, passed: true, verificationCalls: 1 }),
        summary({ taskId: "shell", repeat: 1, passed: true, verificationCalls: 1 }),
        summary({ taskId: "shell", repeat: 2, passed: true, verificationCalls: 1 }),
      ],
      { id: "base", suiteId: "s1", capabilities: CAPS },
    );
    const v = critique(input({ baseline: perfect }));
    expect(v.objections.join(" ")).toMatch(/costs context on every future turn/);
    expect(v.objections.join(" ")).toMatch(/withdrawn, not promoted/);
  });
});

describe("verifier", () => {
  it("approves when the guardian passed and the arithmetic recomputes to the same numbers", () => {
    expect(verify(input()).approve).toBe(true);
  });

  it("objects to every guardian check that failed, quoting its label", () => {
    const regressing = candidateRegressing();
    const report = runGuardian({
      baseline: baseline(),
      candidate: regressing,
      candidateVersion: patchedVersion(),
      baselineVersion: null,
      proposal: proposal(),
      findings: [aFinding()],
    });
    const v = verify(input({ candidate: regressing, guardian: report }));
    expect(v.approve).toBe(false);
    // The objection quotes the check's label and detail, not its id: it is text a user reads inside
    // the decision record, and the ids are already on `decision.checks` for anything that needs to map.
    expect(v.objections.join(" ")).toMatch(/No task that passed on the baseline passes less often/);
    expect(v.objections.join(" ")).toMatch(/1 regression\(s\): shell/);
  });

  it("recomputes the target metric from the raw attempts and objects when the guardian's number differs", () => {
    const i = input();
    const wrong = corrupt(
      i.guardian,
      i.guardian.deltas.map((d) => (d.metric === i.guardian.targetMetric ? { ...d, candidate: d.candidate + 10 } : d)),
    );
    const v = verify({ ...i, guardian: wrong });
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/Recomputing verificationCalls from the raw attempts/);
  });

  it("objects when the guardian scored the proposal on a metric it reported no delta for", () => {
    const i = input();
    const v = verify({ ...i, guardian: corrupt(i.guardian, []) });
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/reported no delta for verificationCalls/);
  });

  it("recomputes the noise floor and objects when it disagrees about clearing it", () => {
    const i = input();
    const flipped = corrupt(
      i.guardian,
      i.guardian.deltas.map((d) => (d.metric === i.guardian.targetMetric ? { ...d, beyondNoise: !d.beyondNoise } : d)),
    );
    const v = verify({ ...i, guardian: flipped });
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/disagrees with the guardian on whether the change clears noise/);
  });

  it("objects to putting a version that is already active to a validation run", () => {
    const v = verify(input({ candidateVersion: version({ state: "active", config: { promptOverride: PATCHED, loop: { maxIterations: 40, verificationNudgeMax: 1 } } }) }));
    expect(v.approve).toBe(false);
    expect(v.objections.join(" ")).toMatch(/rewrite history rather than extend it/);
  });
});

describe("conveneRoles", () => {
  it("returns all four, in the order they read", () => {
    const roles = conveneRoles(input());
    expect(roles.map((r) => r.role)).toEqual(["investigator", "architect", "critic", "verifier"]);
    expect(roles.every((r) => r.approve)).toBe(true);
  });

  it("blocks the promotion when the candidate bought its metric by breaking a task", () => {
    // Promotion needs all four approvals, so one objection is enough — the assertion is that there is
    // one, not that every role noticed.
    const regressing = candidateRegressing();
    const report = runGuardian({
      baseline: baseline(),
      candidate: regressing,
      candidateVersion: patchedVersion(),
      baselineVersion: null,
      proposal: proposal(),
      findings: [aFinding()],
    });
    const roles = conveneRoles(input({ candidate: regressing, guardian: report }));
    expect(roles.some((r) => !r.approve)).toBe(true);
  });
});
