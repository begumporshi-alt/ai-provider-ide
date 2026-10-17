import { describe, expect, it } from "vitest";
import { createAxiom, type AxiomConfig } from "../src/pipeline";
import type { EvalSuite } from "../src/types";
import {
  TEST_LOOP,
  TEST_POLICY,
  createTestPorts,
  trace,
  call,
  result,
  said,
  done,
  proposal,
  suiteResult,
  summary,
  version,
  type AgentScript,
} from "./fakes";

/**
 * Two tasks, two capabilities. One the agent gets wrong, one it gets right — the second exists so a
 * change that buys its metric by breaking something can be caught doing it.
 */
const SUITE: EvalSuite = {
  id: "assistant-core",
  name: "Editing and shell",
  tasks: [
    { id: "unverified", capability: "editing", prompt: "Fix the bug in a.ts", expect: [{ kind: "verified-done" }] },
    {
      id: "shell",
      capability: "shell",
      prompt: "Run the test suite",
      expect: [{ kind: "tool-was-called", name: "run_command" }],
    },
  ],
};

const MODEL = "test/model";

/** Explicit token and duration figures: the guardian's cost and latency ceilings are fractions, and
 *  leaving them to the fixture defaults would make a promote-or-reject outcome depend on how many
 *  tool calls a script happened to contain. */
const CHEAP = { promptTokens: 1000, completionTokens: 300, durationMs: 1000 };
const CHEAPER = { promptTokens: 900, completionTokens: 200, durationMs: 900 };

/** The defect: edits, claims, never checks. The patch makes it check first. */
const OVERCLAIMS: Record<string, AgentScript> = {
  unverified: {
    calls: [
      { name: "read_file", args: { path: "a.ts" } },
      { name: "edit_file", args: { path: "a.ts" } },
    ],
    finalText: "Done, the bug is fixed.",
    ...CHEAP,
    respondsToMarker: "axiom:premature-success",
    then: {
      calls: [
        { name: "read_file", args: { path: "a.ts" } },
        { name: "edit_file", args: { path: "a.ts" } },
        { name: "run_command", args: { command: "pnpm test" }, result: "2 passed" },
      ],
      finalText: "Done — pnpm test printed 2 passed.",
      promptTokens: 1100,
      completionTokens: 350,
      durationMs: 1100,
    },
  },
  shell: {
    calls: [{ name: "run_command", args: { command: "pnpm test" }, result: "2 passed" }],
    finalText: "Tests pass.",
    ...CHEAPER,
  },
};

/**
 * The same defect, and a patch the agent satisfies in the worst available way: told to produce a
 * check, it produces a *cheap* one. The headline metric goes up, and a capability that used to work
 * goes down. This is the fixture the Regression Guardian exists for.
 */
const GAMES_THE_METRIC: Record<string, AgentScript> = {
  ...OVERCLAIMS,
  shell: {
    calls: [{ name: "run_command", args: { command: "pnpm test" }, result: "2 passed" }],
    finalText: "Tests pass.",
    ...CHEAPER,
    respondsToMarker: "axiom:premature-success",
    then: {
      calls: [{ name: "browser_expect", args: { text: "2 passed" } }],
      finalText: "Done — verified.",
      promptTokens: 950,
      completionTokens: 210,
      durationMs: 950,
    },
  },
};

/** Nothing wrong: both tasks check before they claim. */
const CLEAN: Record<string, AgentScript> = {
  unverified: {
    calls: [
      { name: "read_file", args: { path: "a.ts" } },
      { name: "run_command", args: { command: "pnpm test" }, result: "2 passed" },
    ],
    finalText: "Done — pnpm test printed 2 passed.",
    ...CHEAP,
  },
  shell: {
    calls: [{ name: "run_command", args: { command: "pnpm test" }, result: "2 passed" }],
    finalText: "Tests pass.",
    ...CHEAPER,
  },
};

function setup(scripts: Record<string, AgentScript>, config: Partial<AxiomConfig> = {}) {
  const ports = createTestPorts(scripts);
  const axiom = createAxiom(ports, { policy: TEST_POLICY, repeats: 3, ...config });
  return { ports, axiom };
}

function checkOf(checks: { id: string; passed: boolean; detail: string }[], id: string) {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

describe("pipeline — 01 observe", () => {
  it("counts the history it read, including the runs that never reported an end", async () => {
    const { ports, axiom } = setup(CLEAN);
    ports.traces.push(
      trace({ id: "p1", status: "ok", startedAt: 100, endedAt: 900, steps: [call(1, "read_file", {}, 100), result(2, "read_file", true, "ok", 200), done(3, 900)] }),
    );
    ports.traces.push(trace({ id: "p2", status: "error", error: "upstream 500", startedAt: 200, endedAt: 400, steps: [] }));
    ports.traces.push(trace({ id: "p3", status: "running", startedAt: 300, endedAt: null, steps: [call(1, "web_fetch", {}, 300)] }));

    const o = await axiom.observe();
    expect(o.totals).toMatchObject({ runs: 3, ok: 1, error: 1, stopped: 0, unfinished: 1, toolCalls: 2 });
    expect(o.totals.durationMs).toBe(1000);
    expect(o.examinedAt).toBeGreaterThan(0);
  });

  it("reports no duration at all when nothing reported an end, rather than zero", async () => {
    const { ports, axiom } = setup(CLEAN);
    ports.traces.push(trace({ id: "p1", status: "running", endedAt: null, steps: [] }));
    expect((await axiom.observe()).totals.durationMs).toBeNull();
  });
});

describe("pipeline — 02 to 07, the whole loop", () => {
  it("diagnoses a real defect, patches the prompt, and promotes the version that fixed it", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });

    expect(report.diagnosis.findings.map((f) => f.detector)).toContain("premature-success");
    expect(report.attempted?.actuator).toBe("prompt");
    expect(report.attempted?.patch?.marker).toBe("axiom:premature-success");

    expect(report.guardian?.passed).toBe(true);
    expect(report.decision?.decision).toBe("promote");
    expect(report.candidate?.config.promptOverride).toContain("[axiom:premature-success]");

    // The version is immutable and the decision is linked to it, so the chain can be read back.
    const stored = await ports.configs.getVersion(report.candidate!.id);
    expect(stored?.state).toBe("active");
    expect(stored?.decisionId).toBe(report.decision?.id);
    expect((await ports.configs.activeVersion())?.id).toBe(report.candidate?.id);

    // And the map it shows is the candidate's, labelled as such.
    expect(report.capabilityMapOf).toBe("candidate");
    expect(report.capabilityMap.find((c) => c.capability === "editing")?.state).toBe("reliable");
  });

  it("refuses to promote a change that lifts its metric by breaking a capability that used to work", async () => {
    // The test the package is named for. An optimiser takes this trade: verificationCalls goes up,
    // the pass rate on the edited task goes up, and the shell capability is gone.
    const { ports, axiom } = setup(GAMES_THE_METRIC);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });

    const checks = report.decision?.checks ?? [];
    expect(checkOf(checks, "target-improved").passed).toBe(true);
    const regression = checkOf(checks, "no-task-regression");
    expect(regression.passed).toBe(false);
    expect(regression.detail).toMatch(/1 regression\(s\): shell \(shell\): 100% → 0%/);

    expect(report.guardian?.passed).toBe(false);
    expect(report.decision?.decision).toBe("reject");
    expect(report.decision?.roles.some((r) => !r.approve)).toBe(true);

    // Rejected, not deleted: the chain keeps the losing version so the reasoning can be re-read.
    expect((await ports.configs.getVersion(report.candidate!.id))?.state).toBe("rejected");
    expect(await ports.configs.activeVersion()).toBeNull();
    expect((await ports.configs.effectiveConfig()).promptOverride).toBeNull();

    const notDone = report.notDone.join(" ");
    expect(notDone).toMatch(/The candidate was rejected and retained as 'rejected'/);
    expect(notDone).toMatch(/No task that passed on the baseline passes less often/);
    expect((await ports.results.listDecisions()).length).toBe(1);
  });

  it("reports a fault it cannot fix rather than dressing a recommendation up as a change", async () => {
    // A production run of the same task on a second model that did *not* fail is what turns a
    // provisional 'prompt' into a confirmed 'model' — and v1 has no actuator over the model.
    const { ports, axiom } = setup(OVERCLAIMS);
    ports.traces.push(
      trace({
        id: "prod-other-model",
        model: "other/model",
        prompt: "Fix the bug in a.ts",
        steps: [
          call(1, "read_file", { path: "a.ts" }, 0),
          result(2, "read_file", true, "ok", 10),
          call(3, "run_command", { command: "pnpm test" }, 20),
          result(4, "run_command", true, "2 passed", 300),
          said(5, "Done — pnpm test printed 2 passed.", 310),
          done(6, 320),
        ],
      }),
    );

    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    const finding = report.diagnosis.findings.find((f) => f.detector === "premature-success");
    expect(finding?.rootCause).toBe("model");
    expect(finding?.differential).toBe(true);
    expect(finding?.rationale).toMatch(/other\/model ran the same task without it/);

    expect(report.proposals.map((p) => p.actuator)).toEqual(["manual"]);
    expect(report.candidate).toBeNull();
    expect(report.decision).toBeNull();
    expect(report.capabilityMapOf).toBe("baseline");

    const notDone = report.notDone.join(" ");
    expect(notDone).toMatch(/recommendation AXIOM cannot apply in v1/);
    expect(notDone).toMatch(/Switching model is the user's decision and the user's money/);
  });

  it("says there was nothing to propose when nothing failed, instead of reporting a clean run as a fix", async () => {
    const { axiom } = setup(CLEAN);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    expect(report.diagnosis.findings).toEqual([]);
    expect(report.proposals).toEqual([]);
    expect(report.candidate).toBeNull();
    expect(report.notDone.join(" ")).toMatch(/No finding was produced, so there was nothing to propose/);
    expect(report.capabilityMapOf).toBe("baseline");
  });

  it("applies one change per version and names the proposals it left unattempted", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    // A production run with a defect of its own: three identical calls in a row.
    ports.traces.push(
      trace({
        id: "prod-loop",
        prompt: "Fetch the page and summarise it",
        steps: [
          call(1, "web_fetch", { url: "https://example.com" }, 0),
          result(2, "web_fetch", true, "html", 10),
          call(3, "web_fetch", { url: "https://example.com" }, 20),
          result(4, "web_fetch", true, "html", 30),
          call(5, "web_fetch", { url: "https://example.com" }, 40),
          result(6, "web_fetch", true, "html", 50),
          said(7, "Summarised.", 60),
          done(8, 70),
        ],
      }),
    );

    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    expect(report.proposals.length).toBe(2);
    expect(report.attempted?.detector).toBe("premature-success");
    expect(report.notDone.join(" ")).toMatch(/1 further applicable proposal\(s\) were left unattempted/);
    expect(report.notDone.join(" ")).toMatch(/one change per version/);
  });

  it("reuses a stored baseline and says so, instead of paying to reproduce it", async () => {
    // Rejection leaves the active configuration untouched, so the next pass finds the baseline it
    // already measured. Sound — versions are immutable — but it means no fresh eval traces entered
    // the diagnosis, and the report has to say so rather than look like a full second pass.
    const { ports, axiom } = setup(GAMES_THE_METRIC);
    const first = await axiom.improve({ suite: SUITE, model: MODEL });
    expect(first.baseline.versionId).toBe("builtin");
    expect(first.notDone.join(" ")).not.toMatch(/reused from a stored result/);
    const runsAfterFirst = ports.runner.runs.length;

    const second = await axiom.improve({ suite: SUITE, model: MODEL });
    expect(second.notDone.join(" ")).toMatch(/was reused from a stored result rather than re-run/);
    // Only the candidate re-ran; the baseline's six attempts were not reproduced.
    expect(ports.runner.runs.length - runsAfterFirst).toBe(6);
  });
});

describe("pipeline — benchmark reuse", () => {
  it("reuses a stored result for the same suite, version, model and repeat count", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const cfg = { promptOverride: null, loop: TEST_LOOP };
    const first = await axiom.benchmark({ suite: SUITE, model: MODEL, versionId: "builtin", config: cfg });
    const runs = ports.runner.runs.length;
    expect(first.reused).toBe(false);
    expect(runs).toBe(6);

    const second = await axiom.benchmark({ suite: SUITE, model: MODEL, versionId: "builtin", config: cfg });
    expect(second.reused).toBe(true);
    expect(second.result.id).toBe(first.result.id);
    expect(ports.runner.runs.length).toBe(runs);
  });

  it("re-runs when the repeat count differs, because a mean over 3 is not a mean over 1", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const cfg = { promptOverride: null, loop: TEST_LOOP };
    await axiom.benchmark({ suite: SUITE, model: MODEL, versionId: "builtin", config: cfg });
    const again = await axiom.benchmark({ suite: SUITE, model: MODEL, versionId: "builtin", config: cfg, repeats: 1 });
    expect(again.reused).toBe(false);
    expect(again.result.repeats).toBe(1);
    expect(ports.runner.runs.length).toBe(8);
  });

  it("recovers a reused baseline's transcripts from the trace store so the map is still buildable", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const cfg = { promptOverride: null, loop: TEST_LOOP };
    await axiom.benchmark({ suite: SUITE, model: MODEL, versionId: "builtin", config: cfg });
    const reused = await axiom.benchmark({ suite: SUITE, model: MODEL, versionId: "builtin", config: cfg });
    expect(reused.attempts).toEqual([]);
    expect(reused.capabilityAttempts.length).toBe(6);
    expect(ports.runner.runs.length).toBe(6);
  });
});

describe("pipeline — 07 rollback", () => {
  it("restores the parent, retires the promoted version, and deletes neither", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    const promoted = report.candidate!;

    // A second promotion is what gives the chain a parent to go back to. Built by hand rather than
    // by a second defect, because the thing under test is the rollback, not the loop.
    const child = version({
      id: "version-child",
      parentId: promoted.id,
      state: "candidate",
      config: { promptOverride: `${promoted.config.promptOverride}\n\n[axiom:waste]\nBe brief.`, loop: TEST_LOOP },
    });
    await ports.configs.put(child);
    await ports.configs.setState(child.id, "active");
    expect((await ports.configs.activeVersion())?.id).toBe(child.id);

    const r = await axiom.rollback();
    expect(r.refusal).toBeNull();
    expect(r.restored?.id).toBe(promoted.id);
    expect(r.retired?.id).toBe(child.id);
    expect((await ports.configs.activeVersion())?.id).toBe(promoted.id);
    expect((await ports.configs.getVersion(child.id))?.state).toBe("retired");
    expect((await ports.configs.listVersions()).length).toBe(2);
  });

  it("refuses when nothing is active, because the agent is on its built-in configuration", async () => {
    const { axiom } = setup(CLEAN);
    const r = await axiom.rollback();
    expect(r.restored).toBeNull();
    expect(r.refusal).toMatch(/No version is active/);
  });

  it("refuses to roll back a version with no parent, and leaves it active rather than retiring it", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    const r = await axiom.rollback();
    expect(r.restored).toBeNull();
    expect(r.retired?.id).toBe(report.candidate?.id);
    expect(r.refusal).toMatch(/no parent to roll back to/);
    expect((await ports.configs.activeVersion())?.id).toBe(report.candidate?.id);
  });

  it("refuses to guess when the parent is missing from the chain", async () => {
    const { ports, axiom } = setup(CLEAN);
    await ports.configs.put(version({ id: "orphan", parentId: "version-gone", state: "candidate" }));
    await ports.configs.setState("orphan", "active");
    const r = await axiom.rollback();
    expect(r.restored).toBeNull();
    expect(r.refusal).toMatch(/missing from the chain; refusing to guess/);
  });

  it("lists the chain oldest first, so history reads as a sequence", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    await ports.configs.put(
      version({ id: "version-later", parentId: report.candidate!.id, createdAt: report.candidate!.createdAt + 1000 }),
    );
    const ids = (await axiom.history()).map((v) => v.id);
    expect(ids[0]).toBe(report.candidate?.id);
    expect(ids[1]).toBe("version-later");
  });
});

describe("pipeline — autopsy over a stored run", () => {
  it("reconstructs a run the eval produced, with the findings that attach to it", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const report = await axiom.improve({ suite: SUITE, model: MODEL });
    const runId = report.baseline.attemptSummaries.find((a) => !a.passed)!.runId;

    const a = await axiom.autopsyOf(runId);
    expect(a?.runId).toBe(runId);
    expect(a?.findings.map((f) => f.detector)).toContain("premature-success");
    expect(a?.lines.some((l) => l.annotations.length > 0)).toBe(true);
    expect(ports.runner.runs.some((r) => r.id === runId)).toBe(true);
  });

  it("returns nothing for a run id that is not in the store, rather than an empty reconstruction", async () => {
    const { axiom } = setup(CLEAN);
    expect(await axiom.autopsyOf("nope")).toBeNull();
  });
});

/**
 * Stopping a run is a decision, not a failure — but it leaves numbers behind that look like
 * measurements. These two are the difference between a screen the user can abandon safely and one
 * that quietly promotes on a suite nobody finished.
 */
describe("pipeline — a stopped run is reported, never judged", () => {
  /** A production trace with the real defect in it, so the diagnosis has something to propose from
   *  even though the suite itself never ran. Without it, "no candidate" would also be what a clean
   *  agent produces, and the test could not tell the two apart. */
  const pushOverclaim = (ports: ReturnType<typeof createTestPorts>) => {
    ports.traces.push(
      trace({
        id: "prod-1",
        status: "ok",
        startedAt: 100,
        endedAt: 400,
        steps: [
          call(1, "edit_file", { path: "a.ts" }, 100),
          result(2, "edit_file", true, "edited", 150),
          said(3, "Done, the bug is fixed.", 200),
          done(4, 400),
        ],
      }),
    );
  };

  it("reports the partial baseline and builds no candidate, because there is nothing complete to validate against", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    pushOverclaim(ports);
    // The trace store is backed by the runner's own run list, so the pushed production trace is
    // already in it. Counted before the call, because what matters is that the eval added none.
    const runsBefore = ports.runner.runs.length;
    const ac = new AbortController();
    ac.abort();

    const report = await axiom.improve({ suite: SUITE, model: MODEL, signal: ac.signal });

    expect(report.baseline.attemptSummaries).toHaveLength(0);
    expect(ports.runner.runs).toHaveLength(runsBefore);
    // The diagnosis still happened — it read the production trace, which is real — and still
    // produced something to propose. What did not happen is a candidate built on top of it.
    expect(report.diagnosis.findings.map((f) => f.detector)).toContain("premature-success");
    expect(report.proposals.length).toBeGreaterThan(0);
    expect(report.attempted).toBeNull();
    expect(report.candidate).toBeNull();
    expect(report.decision).toBeNull();
    expect(await ports.configs.listVersions()).toHaveLength(0);
    expect(report.notDone.join(" ")).toMatch(/stopped after 0 attempt/);
    // And nothing partial was stored where a later pass would reuse it as a baseline.
    expect(await ports.results.listSuiteResults()).toHaveLength(0);
  });

  it("leaves a candidate undecided when its own run stops, rather than rejecting it for tasks it never ran", async () => {
    const { ports, axiom } = setup(OVERCLAIMS);
    const ac = new AbortController();
    ac.abort();

    const out = await axiom.validate({
      suite: SUITE,
      model: MODEL,
      proposal: proposal(),
      baseline: suiteResult([summary()]),
      baselineVersion: null,
      signal: ac.signal,
    });

    expect(out.guardian).toBeNull();
    expect(out.decision).toBeNull();
    expect(out.refusal).toMatch(/left a candidate with no decision/);
    // Built, and inert: only an 'active' version changes what the agent runs with.
    expect(out.candidate?.state).toBe("candidate");
    const stored = await ports.configs.listVersions();
    expect(stored.map((v) => v.state)).toEqual(["candidate"]);
    expect(await ports.results.listDecisions()).toHaveLength(0);
  });
});
