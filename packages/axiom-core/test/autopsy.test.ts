import { describe, expect, it } from "vitest";
import { autopsy } from "../src/autopsy";
import { RESULT_TRUNCATION_CHARS } from "../src/detectors";
import type { RunTrace } from "../src/types";
import { TEST_POLICY, aFinding, call, done, refused, result, said, trace } from "./fakes";

/** Two calls, both answered, then a claim and an end: a run with nothing structurally wrong with it. */
function healthy(): RunTrace {
  return trace({
    id: "r1",
    model: "test/model",
    prompt: "Fix the bug",
    steps: [
      call(1, "read_file", { path: "a.ts" }, 0),
      result(2, "read_file", true, "export const a = 1;", 5),
      call(3, "run_command", { command: "pnpm test" }, 40),
      result(4, "run_command", true, "2 passed", 900),
      said(5, "Fixed and the tests pass.", 950),
      done(6, 960),
    ],
  });
}

/** The run the autopsy exists for: two calls, no check, and a claim of success. */
function overclaiming(): RunTrace {
  return trace({
    id: "r2",
    prompt: "Fix the bug",
    steps: [
      call(1, "read_file", { path: "a.ts" }, 0),
      result(2, "read_file", true, "export const a = 1;", 5),
      call(3, "edit_file", { path: "a.ts" }, 100),
      result(4, "edit_file", true, "written", 120),
      said(5, "Done, the bug is fixed.", 130),
      done(6, 140),
    ],
  });
}

const PREMATURE = aFinding({
  id: "f1",
  severity: "critical",
  detector: "premature-success",
  title: "Claimed completion with no check",
  rootCause: "prompt",
  rationale: "The transcript ends in a claim and contains no verification call.",
  evidence: [{ runId: "r2", steps: [5], note: "claimed done after two edits and no check" }],
});

function of(t: RunTrace, findings = [PREMATURE]) {
  return autopsy({ trace: t, policy: TEST_POLICY, findings });
}

describe("autopsy — timeline", () => {
  it("orders the steps by seq even when the trace stored them out of order", () => {
    const shuffled = trace({
      id: "r3",
      steps: [done(3, 30), call(1, "read_file", {}, 10), result(2, "read_file", true, "ok", 20)],
    });
    expect(of(shuffled, []).lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("reports the gap from the previous step, and none for the first", () => {
    const lines = of(healthy(), []).lines;
    expect(lines[0]?.gapMs).toBeNull();
    expect(lines[1]?.gapMs).toBe(5);
    expect(lines[3]?.gapMs).toBe(860);
  });

  it("reads a tool call's arguments and outcome from the invocation, not from the raw step", () => {
    const lines = of(healthy(), []).lines;
    expect(lines[0]?.detail).toBe(JSON.stringify({ path: "a.ts" }));
    expect(lines[0]?.ok).toBe(true);
    expect(lines[0]?.summary).toBe("Called read_file; it succeeded.");
  });

  it("says so when a call's outcome was never recorded, and lists it as something it could not see", () => {
    const dangling = trace({
      id: "r4",
      status: "error",
      error: "connection reset",
      steps: [call(1, "web_fetch", { url: "https://example.com" }, 0)],
    });
    const a = of(dangling, []);
    expect(a.lines[0]?.summary).toBe("Called web_fetch; no result was ever recorded for it — the call never answered.");
    expect(a.blindSpots.join(" ")).toMatch(/1 tool call\(s\) have no recorded result/);
    expect(a.blindSpots.join(" ")).toMatch(/a lost write is invisible by design/);
  });

  it("separates a call that answered without a recorded outcome from one that never answered", () => {
    const t = trace({
      id: "r4b",
      steps: [
        call(1, "read_file", { path: "a.ts" }, 0),
        { seq: 2, kind: "tool_result", label: "read_file", detail: "contents", ok: null, ts: 1 },
      ],
    });
    expect(of(t, []).lines[0]?.summary).toBe("Called read_file; whether it worked was never recorded.");
  });

  it("distinguishes a refusal by the approval gate from a failure inside the tool", () => {
    const deniedRun = trace({
      id: "r5",
      steps: [
        call(1, "run_command", { command: "rm -rf build" }, 0),
        refused(2, "run_command", 1),
        call(3, "read_file", { path: "a.ts" }, 2),
        result(4, "read_file", false, "ENOENT", 3),
      ],
    });
    const lines = of(deniedRun, []).lines;
    expect(lines[0]?.summary).toBe("Called run_command; the approval gate refused it.");
    expect(lines[1]?.summary).toBe("Refused: run_command was not permitted here.");
    expect(lines[3]?.summary).toBe("Result for read_file: failure.");
  });

  it("describes an empty assistant turn as the waste it is rather than as speech", () => {
    const empty = trace({ id: "r6", steps: [said(1, "   ", 0), done(2, 1)] });
    expect(of(empty, []).lines[0]?.summary).toBe("An empty assistant turn: no text and no call.");
  });

  it("flags a result the store truncated, because the tail is not in the reconstruction", () => {
    const long = "x".repeat(RESULT_TRUNCATION_CHARS);
    const t = trace({ id: "r7", steps: [call(1, "read_file", {}, 0), result(2, "read_file", true, long, 1)] });
    const a = of(t, []);
    expect(a.lines[1]?.truncated).toBe(true);
    expect(a.blindSpots.join(" ")).toMatch(new RegExp(`truncated to ${RESULT_TRUNCATION_CHARS} characters`));
  });

  it("does not flag a result one character short of the truncation point", () => {
    const t = trace({
      id: "r8",
      steps: [call(1, "read_file", {}, 0), result(2, "read_file", true, "x".repeat(RESULT_TRUNCATION_CHARS - 1), 1)],
    });
    expect(of(t, []).lines[1]?.truncated).toBe(false);
  });
});

describe("autopsy — annotations", () => {
  it("attaches a finding's note to the exact steps it names", () => {
    const lines = of(overclaiming()).lines;
    expect(lines[4]?.annotations).toEqual(["premature-success: claimed done after two edits and no check"]);
    expect(lines[3]?.annotations).toEqual([]);
  });

  it("stacks both notes when two findings name the same step", () => {
    const second = aFinding({
      id: "f2",
      detector: "waste",
      severity: "minor",
      title: "Said the same thing twice",
      rootCause: "prompt",
      rationale: "Two assistant turns repeat the same sentence.",
      evidence: [{ runId: "r2", steps: [5], note: "the claim is repeated verbatim" }],
    });
    const notes = of(overclaiming(), [PREMATURE, second]).lines[4]?.annotations ?? [];
    expect(notes).toContain("premature-success: claimed done after two edits and no check");
    expect(notes).toContain("waste: the claim is repeated verbatim");
  });

  it("ignores findings about other runs, so a busy register cannot annotate the wrong transcript", () => {
    const elsewhere = aFinding({ id: "f9", evidence: [{ runId: "other-run", steps: [1], note: "not this one" }] });
    const a = of(overclaiming(), [elsewhere]);
    expect(a.findings).toEqual([]);
    expect(a.lines.every((l) => l.annotations.length === 0)).toBe(true);
  });

  it("exempts the omitted-occurrences row from annotating anything, since it names no step", () => {
    const omitted = aFinding({ id: "f3", evidence: [{ runId: "r2", steps: [], note: "2 further occurrences omitted from this list" }] });
    expect(of(overclaiming(), [omitted]).lines.every((l) => l.annotations.length === 0)).toBe(true);
  });
});

describe("autopsy — verdict", () => {
  it("names the worst finding and its cause, and counts what else attached", () => {
    const a = of(overclaiming());
    expect(a.verdict).toMatch(/Claimed completion with no check/);
    expect(a.verdict).toMatch(/Root cause reads as 'prompt'/);
    expect(a.cause).toBe("prompt");
  });

  it("says how many further findings attach, so a reader does not have to count the list", () => {
    const second = aFinding({ id: "f2", severity: "minor", detector: "waste", evidence: [{ runId: "r2", steps: [5], note: "n" }] });
    expect(of(overclaiming(), [PREMATURE, second]).verdict).toMatch(/1 further finding\(s\) attach to this run/);
  });

  it("takes the cause from the most severe finding rather than the first one stored", () => {
    const minor = aFinding({ id: "f2", severity: "minor", rootCause: "orchestration", evidence: [{ runId: "r2", steps: [1], note: "n" }] });
    const critical = aFinding({ id: "f3", severity: "critical", rootCause: "tool", evidence: [{ runId: "r2", steps: [3], note: "n" }] });
    const a = of(overclaiming(), [minor, critical]);
    expect(a.cause).toBe("tool");
    expect(a.findings[0]?.id).toBe("f3");
  });

  it("reports an errored run as an error first, with what preceded it second", () => {
    const t = trace({ id: "r2", status: "error", error: "upstream 500", steps: [said(1, "Done, the bug is fixed.", 0)] });
    const a = of(t);
    expect(a.verdict).toMatch(/^The run ended in error: upstream 500/);
    expect(a.verdict).toMatch(/Before that, claimed completion with no check/);
  });

  it("says when an errored run stored no error text, rather than printing nothing", () => {
    const t = trace({ id: "r9", status: "error", error: null, steps: [] });
    expect(of(t, []).verdict).toMatch(/no error text was stored/);
  });

  it("reports a stopped run as interrupted, and refuses to guess whether the work was finished", () => {
    const t = trace({ id: "r10", status: "stopped", steps: [call(1, "read_file", {}, 0), result(2, "read_file", true, "ok", 1)] });
    expect(of(t, []).verdict).toMatch(/stopped from outside/);
    expect(of(t, []).verdict).toMatch(/Nothing here says whether the work was incomplete/);
  });

  it("credits a claim that a recorded check backs, instead of reporting a clean run as a silent one", () => {
    const a = of(healthy(), []);
    expect(a.verdict).toMatch(/claimed completion and had run 1 check\(s\) beforehand/);
    expect(a.cause).toBeNull();
  });

  it("falls back to the bare statement when nothing fired and nothing was claimed", () => {
    const t = trace({ id: "r11", steps: [call(1, "read_file", {}, 0), result(2, "read_file", true, "ok", 1)] });
    expect(of(t, []).verdict).toBe("No detector fired on this run.");
  });
});

describe("autopsy — blind spots", () => {
  it("always says that the loop's verification demand is invisible here", () => {
    expect(of(healthy(), []).blindSpots.join(" ")).toMatch(/verification demand is an automatic user turn/);
  });

  it("says that no detector firing is not a finding that the run succeeded", () => {
    // The distinction the whole module exists to keep visible.
    const spots = of(healthy(), []).blindSpots.join(" ");
    expect(spots).toMatch(/No detector fired\. That is not a finding that the run succeeded/);
    expect(spots).toMatch(/this run was not part of one/);
  });

  it("omits that caveat once a finding has fired, because then something did look", () => {
    expect(of(overclaiming()).blindSpots.join(" ")).not.toMatch(/No detector fired/);
  });

  it("reports a still-running record as having no duration, and admits it cannot tell why", () => {
    const t = trace({ id: "r12", status: "running", endedAt: null, steps: [call(1, "read_file", {}, 0)] });
    const a = of(t, []);
    expect(a.metrics.durationMs).toBeNull();
    expect(a.blindSpots.join(" ")).toMatch(/recorded as still running/);
    expect(a.blindSpots.join(" ")).toMatch(/A session closed mid-run leaves the identical row/);
  });

  it("carries the run's identity and metrics through unchanged, so the screen need not re-derive them", () => {
    const a = of(healthy(), []);
    expect(a.runId).toBe("r1");
    expect(a.model).toBe("test/model");
    expect(a.prompt).toBe("Fix the bug");
    expect(a.metrics.toolCalls).toBe(2);
    expect(a.metrics.verificationCalls).toBe(1);
  });
});
