import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, DETECTORS, runDetectors } from "../src/detectors";
import { diagnose, observe } from "../src/diagnose";
import { deriveMetrics } from "../src/trace";
import type { Finding, RunTrace } from "../src/types";
import { TEST_POLICY, call, done, result, said, trace } from "./fakes";

/** A run that does work and then claims it holds without checking — the defect under test. */
function premature(id: string, model: string, prompt: string, status: RunTrace["status"] = "ok"): RunTrace {
  return trace({
    id,
    model,
    prompt,
    status,
    steps: [
      call(1, "write_file", { path: "a.ts" }),
      result(2, "write_file", true),
      said(3, "Done — the bug is fixed."),
      done(4),
    ],
  });
}

/** The same task done properly: a verification call before the claim. */
function verified(id: string, model: string, prompt: string): RunTrace {
  return trace({
    id,
    model,
    prompt,
    steps: [
      call(1, "write_file", { path: "a.ts" }),
      result(2, "write_file", true),
      call(3, "run_command", { command: "pnpm test" }),
      result(4, "run_command", true, "3 passed"),
      said(5, "Done — the tests pass."),
      done(6),
    ],
  });
}

const TASK = "Fix the parser bug";

function run(runs: RunTrace[]): Finding[] {
  return diagnose({ runs, policy: TEST_POLICY, maxIterations: 40 }).findings;
}

function only(findings: Finding[], detector: Finding["detector"]): Finding {
  const f = findings.filter((x) => x.detector === detector);
  expect(f).toHaveLength(1);
  return f[0] as Finding;
}

describe("the model differential", () => {
  it("confirms a model limit only when another model ran the same task and did not fail", () => {
    const f = only(run([premature("a", "weak/model", TASK), verified("b", "strong/model", TASK)]), "premature-success");
    expect(f.rootCause).toBe("model");
    expect(f.differential).toBe(true);
    expect(f.rationale).toContain("weak/model");
    expect(f.rationale).toContain("strong/model");
  });

  it("rules the model out when every model that ran the task failed", () => {
    const f = only(run([premature("a", "one/model", TASK), premature("b", "two/model", TASK)]), "premature-success");
    expect(f.rootCause).toBe("prompt");
    expect(f.differential).toBe(true);
    expect(f.rationale).toMatch(/every model that ran this task/);
  });

  it("leaves the cause provisional and says so when only one model was observed", () => {
    const f = only(run([premature("a", "one/model", TASK)]), "premature-success");
    expect(f.rootCause).toBe("prompt");
    expect(f.differential).toBe(false);
    expect(f.rationale).toMatch(/hypothesis/);
    expect(f.rationale).toMatch(/second model/);
  });

  it("never lets a single run blame the model, whatever the detector", () => {
    // The type forbids it; this is the runtime check that the type is not lying.
    const shapes: RunTrace[] = [
      premature("a", "m", TASK),
      trace({ id: "b", prompt: TASK, steps: [said(1, "complete"), done(2)] }),
      trace({ id: "c", prompt: TASK, iterations: 40, promptTokens: 60_000, steps: [said(1, "hmm"), done(2)] }),
    ];
    for (const t of shapes) {
      for (const h of runDetectors({
        trace: t,
        metrics: deriveMetrics(t, TEST_POLICY),
        policy: TEST_POLICY,
        thresholds: DEFAULT_THRESHOLDS,
        maxIterations: 40,
      })) {
        expect(h.provisionalCause).not.toBe("model");
      }
    }
    expect(DETECTORS.length).toBe(9);
  });
});

describe("repetition on one model", () => {
  it("records a failure that reproduces in every run as systematic", () => {
    const f = only(run([premature("a", "m", TASK), premature("b", "m", TASK)]), "premature-success");
    expect(f.occurrences).toBe(2);
    expect(f.rationale).toMatch(/systematic/);
    expect(f.differential).toBe(false);
  });

  it("records a failure that appears in some runs as intermittent", () => {
    const f = only(
      run([premature("a", "m", TASK), verified("b", "m", TASK), verified("c", "m", TASK)]),
      "premature-success",
    );
    expect(f.occurrences).toBe(1);
    expect(f.rationale).toMatch(/intermittent/);
    expect(f.rationale).toMatch(/1 of 3/);
  });
});

describe("grouping", () => {
  it("does not merge two differently-worded tasks into one finding", () => {
    const findings = run([premature("a", "m", "Task one"), premature("b", "m", "Task two")]);
    expect(findings.filter((f) => f.detector === "premature-success")).toHaveLength(2);
  });

  it("groups runs with no prompt by model rather than merging all of them", () => {
    const findings = run([premature("a", "m1", ""), premature("b", "m2", "")]);
    const hits = findings.filter((f) => f.detector === "premature-success");
    expect(hits).toHaveLength(2);
    // Two models, two different tasks-by-model: neither can be a differential of the other.
    expect(hits.every((f) => f.differential === false)).toBe(true);
  });

  it("caps the evidence list and says how much it left out", () => {
    const runs = Array.from({ length: 7 }, (_, i) => premature(`r${i}`, "m", TASK));
    const f = only(run(runs), "premature-success");
    expect(f.occurrences).toBe(7);
    expect(f.evidence).toHaveLength(6);
    const last = f.evidence[5];
    expect(last?.steps).toEqual([]);
    expect(last?.note).toMatch(/2 further occurrences omitted/);
    // The investigator exempts exactly this row from its "name a step" rule.
    expect(last?.note).toContain("omitted");
  });
});

describe("severity and ordering", () => {
  it("takes the worst severity across the group", () => {
    // A runaway that ended in error is critical; the same detector on a clean exit is major.
    const runs = [
      trace({ id: "a", prompt: TASK, iterations: 40, status: "error", steps: [call(1, "x"), result(2, "x", true)] }),
      trace({ id: "b", prompt: TASK, iterations: 40, status: "ok", steps: [call(1, "x"), result(2, "x", true)] }),
    ];
    const f = only(run(runs), "runaway");
    expect(f.severity).toBe("critical");
    expect(f.occurrences).toBe(2);
  });

  it("sorts critical first, then by how often it happened", () => {
    const findings = run([
      premature("a", "m", "Task one"),
      premature("b", "m", "Task one"),
      trace({ id: "c", prompt: "Task two", iterations: 40, steps: [call(1, "x"), result(2, "x", true)] }),
      trace({ id: "d", prompt: "Task three", iterations: 40, steps: [call(1, "y"), result(2, "y", true)] }),
    ]);
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.occurrences).toBe(2);
    const majors = findings.filter((f) => f.severity === "major");
    expect(majors.length).toBeGreaterThan(0);
  });
});

describe("the report", () => {
  it("counts what it examined, what was clean, and what it found", () => {
    const report = diagnose({
      runs: [premature("a", "m", TASK), verified("b", "m", TASK), verified("c", "m", TASK)],
      policy: TEST_POLICY,
      maxIterations: 40,
    });
    expect(report.runsExamined).toBe(3);
    expect(report.runsClean).toBe(2);
    expect(report.totalHits).toBe(1);
    expect(report.findings).toHaveLength(1);
  });

  it("reports a clean set of runs as having no findings, not as having passed", () => {
    const report = diagnose({
      runs: [verified("a", "m", TASK)],
      policy: TEST_POLICY,
      maxIterations: 40,
    });
    expect(report.findings).toHaveLength(0);
    expect(report.runsClean).toBe(1);
  });

  it("gives every finding a distinct id", () => {
    const findings = run([premature("a", "m", "one"), premature("b", "m", "two")]);
    expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
  });

  it("gives the same recurring finding the same id on the next pass, so the register updates one row", () => {
    // The store deduplicates by id; a fresh id per pass would append a duplicate for a problem that
    // never went away. Two passes over the same run, built through different inputs, must agree.
    const first = run([premature("a", "m", TASK)]);
    const second = run([premature("a", "m", TASK)]);
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(first[0]?.id).toMatch(/^finding-premature-success-/);
  });
});

describe("observe", () => {
  it("reduces each run to metrics without changing the run count or order", () => {
    const runs = [premature("a", "m", TASK), verified("b", "m", TASK)];
    const observed = observe(runs, TEST_POLICY);
    expect(observed).toHaveLength(2);
    expect(observed[0]?.trace.id).toBe("a");
    expect(observed[0]?.metrics.claimedDone).toBe(true);
    expect(observed[0]?.metrics.verificationCalls).toBe(0);
    expect(observed[1]?.metrics.verificationCalls).toBe(1);
  });
});
