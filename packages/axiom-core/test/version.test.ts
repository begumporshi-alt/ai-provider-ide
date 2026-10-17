import { describe, expect, it } from "vitest";
import {
  PATCH_LIBRARY,
  PROMPT_CAP,
  VERIFICATION_NUDGE_HARD_MAX,
  applyPromptPatches,
  buildCandidate,
  countPatches,
  design,
  parsePromptPatches,
  patchChars,
  type PromptPatch,
  type PromptPatchBlock,
} from "../src/version";
import type { AgentVersion, DetectorId, Finding, RootCause } from "../src/types";
import { TEST_LOOP, aFinding, sequentialIds } from "./fakes";

const ALL_DETECTORS: DetectorId[] = [
  "premature-success",
  "verification-absent",
  "tool-loop",
  "retry-storm",
  "denied-storm",
  "wrong-tool",
  "context-loss",
  "runaway",
  "waste",
];

const finding = aFinding;

function propose(f: Finding, loop = TEST_LOOP) {
  const out = design({ findings: [f], active: { promptOverride: null, loop }, ids: sequentialIds() });
  expect(out).toHaveLength(1);
  return out[0]!;
}

const patch = (marker: string, text: string, detector: DetectorId = "premature-success"): PromptPatch => ({
  marker,
  detector,
  text,
});

describe("design", () => {
  it("produces one proposal per finding, never a bundle", () => {
    const findings = [finding({ id: "a" }), finding({ id: "b", detector: "tool-loop", metric: "repeatRatio" })];
    const out = design({ findings, active: { promptOverride: null, loop: TEST_LOOP }, ids: sequentialIds() });
    expect(out).toHaveLength(2);
    // Bundling would make the validation run unable to say which edit moved the number.
    expect(out[0]?.targetsFindingIds).toEqual(["a"]);
    expect(out[1]?.targetsFindingIds).toEqual(["b"]);
  });

  it("aims the proposal at the metric the finding named", () => {
    expect(propose(finding()).targetMetric).toBe("verificationCalls");
    expect(propose(finding({ metric: null })).targetMetric).toBeNull();
  });

  it("carries the finding's evidence forward rather than restating it", () => {
    const f = finding();
    expect(propose(f).evidence).toEqual(f.evidence);
  });

  it("gives a prompt cause a prompt patch with a marker", () => {
    const p = propose(finding());
    expect(p.actuator).toBe("prompt");
    expect(p.patch?.marker).toBe("axiom:premature-success");
    expect(p.rationale).toContain("prompt");
    // Long enough to have said something; the architect rejects a rationale under 40 characters.
    expect(p.rationale.length).toBeGreaterThan(40);
  });

  it("prefers a loop parameter for an orchestration cause, and only ever raises the nudge", () => {
    const p = propose(finding({ rootCause: "orchestration" }));
    expect(p.actuator).toBe("loop-params");
    expect(p.loop).toEqual({ field: "verificationNudgeMax", from: 1, to: 2 });
  });

  it("stops raising the nudge at the hard maximum and falls back to an instruction", () => {
    const p = propose(finding({ rootCause: "orchestration" }), { maxIterations: 40, verificationNudgeMax: VERIFICATION_NUDGE_HARD_MAX });
    expect(p.actuator).toBe("prompt");
  });

  it("never proposes buying more of the behaviour it diagnosed", () => {
    // A runaway's obvious fix is a bigger ceiling; that spends more to produce more of the same.
    for (const detector of ["runaway", "waste", "tool-loop"] as DetectorId[]) {
      const p = propose(finding({ detector, rootCause: "orchestration", metric: "iterations" }));
      expect(p.actuator).not.toBe("loop-params");
      expect(p.loop?.field).not.toBe("maxIterations");
    }
  });

  it("reports a model limit as a recommendation, because no configuration edit fixes one", () => {
    const p = propose(finding({ rootCause: "model", differential: true }));
    expect(p.actuator).toBe("manual");
    expect(p.patch).toBeUndefined();
    expect(p.blockedReason).toMatch(/model limit/);
  });

  it.each<[RootCause, RegExp]>([
    ["memory", /memory store/],
    ["infra", /infrastructure/i],
  ])("reports a %s cause as a recommendation rather than stretching a prompt over it", (cause, re) => {
    const p = propose(finding({ rootCause: cause }));
    expect(p.actuator).toBe("manual");
    expect(p.blockedReason).toMatch(re);
  });

  it("has an instruction for every detector, so a prompt cause is never silently dropped", () => {
    for (const detector of ALL_DETECTORS) {
      const p = propose(finding({ detector }));
      expect(p.actuator, detector).toBe("prompt");
      expect(p.patch?.detector, detector).toBe(detector);
      expect(PATCH_LIBRARY[detector], detector).toBeDefined();
    }
  });

  it("caps how many proposals one pass may produce", () => {
    const findings = ALL_DETECTORS.map((d, i) => finding({ id: `f${i}`, detector: d }));
    const out = design({ findings, active: { promptOverride: null, loop: TEST_LOOP }, ids: sequentialIds(), limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("writes instructions that name a behaviour rather than a virtue", () => {
    // "Be careful" cannot be validated by any suite, which would make the loop unverifiable. Every
    // entry has to say something a transcript could confirm or contradict.
    for (const [detector, entry] of Object.entries(PATCH_LIBRARY)) {
      expect(entry, detector).toBeDefined();
      expect(entry!.text.length, detector).toBeGreaterThan(60);
      expect(entry!.text.toLowerCase(), detector).not.toContain("be careful");
    }
  });
});

describe("applyPromptPatches", () => {
  const base = "You are an agent.";

  it("appends a marked block", () => {
    const r = applyPromptPatches(base, [patch("axiom:premature-success", "Check before claiming.")]);
    expect(r.applied).toHaveLength(1);
    expect(r.prompt).toBe(`${base}\n\n[axiom:premature-success]\nCheck before claiming.`);
    expect(countPatches(r.prompt)).toBe(1);
  });

  it("is idempotent by marker, so promoting the same fix twice does not duplicate it", () => {
    const p = patch("axiom:tool-loop", "Stop repeating.");
    const first = applyPromptPatches(base, [p]);
    const second = applyPromptPatches(first.prompt, [p]);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyPresent).toHaveLength(1);
    expect(second.prompt).toBe(first.prompt);
    expect(countPatches(second.prompt)).toBe(1);
  });

  it("refuses at the patch-count cap instead of appending anyway", () => {
    const many = Array.from({ length: PROMPT_CAP.maxPatches + 2 }, (_, i) =>
      patch(`axiom:detector-${i}`, "x".repeat(10)),
    );
    const r = applyPromptPatches(base, many);
    expect(r.applied).toHaveLength(PROMPT_CAP.maxPatches);
    expect(r.refused).toHaveLength(2);
    expect(r.refused[0]?.reason).toMatch(/already carries/);
    expect(countPatches(r.prompt)).toBe(PROMPT_CAP.maxPatches);
  });

  it("counts patches an ancestor version left in the prompt toward the same cap", () => {
    const inherited = applyPromptPatches(
      base,
      Array.from({ length: PROMPT_CAP.maxPatches - 1 }, (_, i) => patch(`axiom:old-${i}`, "x".repeat(10))),
    ).prompt;
    expect(countPatches(inherited)).toBe(PROMPT_CAP.maxPatches - 1);
    const r = applyPromptPatches(inherited, [patch("axiom:new-a", "one more"), patch("axiom:new-b", "one too many")]);
    expect(r.applied).toHaveLength(1);
    expect(r.refused).toHaveLength(1);
    expect(countPatches(r.prompt)).toBe(PROMPT_CAP.maxPatches);
  });

  it("refuses at the character cap rather than truncating an instruction mid-sentence", () => {
    const r = applyPromptPatches(base, [patch("axiom:waste", "y".repeat(PROMPT_CAP.maxPatchChars + 1))]);
    expect(r.applied).toHaveLength(0);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]?.reason).toMatch(/past 2400 characters/);
    expect(r.prompt).toBe(base);
  });

  it("counts only what AXIOM added, never the base prompt", () => {
    const long = "z".repeat(5_000);
    expect(patchChars(long)).toBe(0);
    expect(countPatches(long)).toBe(0);
    const r = applyPromptPatches(long, [patch("axiom:runaway", "Budget your steps.")]);
    expect(patchChars(r.prompt)).toBe(`\n\n[axiom:runaway]\nBudget your steps.`.length);
  });

  it("does not mistake prose that mentions a marker for a patch block", () => {
    const prose = `${base} The marker axiom:tool-loop is discussed in the docs.`;
    expect(countPatches(prose)).toBe(0);
    expect(patchChars(prose)).toBe(0);
  });
});

describe("parsePromptPatches", () => {
  const base = "You are an agent.";

  it("gives back exactly what applyPromptPatches put in", () => {
    // The round trip is the whole reason a version travels as patches. A parse that drops a character
    // still yields prose that reads fine, so nothing downstream would complain — the prompt would
    // just carry a subtly different instruction than the one the benchmark measured.
    const patches = [
      patch("axiom:premature-success", "Run the check before you claim it passes."),
      patch("axiom:tool-loop", "Stop calling the same tool with the same arguments."),
    ];
    const prompt = applyPromptPatches(base, patches).prompt;
    expect(parsePromptPatches(prompt)).toEqual([
      { marker: patches[0]!.marker, text: patches[0]!.text },
      { marker: patches[1]!.marker, text: patches[1]!.text },
    ]);
  });

  it("replays onto a different base without carrying the old one along", () => {
    // The case this exists for: a user edited their own system prompt after AXIOM measured the
    // version. Applying the stored override verbatim would silently discard their edit; replaying
    // the parsed blocks onto today's prompt keeps both.
    const patched = applyPromptPatches(base, [patch("axiom:waste", "Budget your steps.")]).prompt;
    const blocks: PromptPatchBlock[] = parsePromptPatches(patched);
    const custom = "You are a terse assistant. Never pad an answer.";
    const r = applyPromptPatches(custom, blocks);
    expect(r.applied).toHaveLength(1);
    expect(r.prompt).toBe(`${custom}\n\n[axiom:waste]\nBudget your steps.`);
    expect(r.prompt.startsWith(custom)).toBe(true);
  });

  it("keeps a patch whose text spans lines intact", () => {
    const text = "Before you end a turn:\n1. run the check\n2. read its output";
    const prompt = applyPromptPatches(base, [patch("axiom:verification-absent", text)]).prompt;
    expect(parsePromptPatches(prompt)[0]?.text).toBe(text);
  });

  it("is idempotent through the round trip, so a stored version can be re-promoted", () => {
    const once = applyPromptPatches(base, [patch("axiom:tool-loop", "Stop repeating.")]);
    const twice = applyPromptPatches(once.prompt, parsePromptPatches(once.prompt));
    expect(twice.applied).toHaveLength(0);
    expect(twice.alreadyPresent).toHaveLength(1);
    expect(twice.prompt).toBe(once.prompt);
  });

  it("finds nothing in a prompt AXIOM never touched", () => {
    expect(parsePromptPatches(base)).toEqual([]);
    expect(parsePromptPatches(`${base} The marker axiom:tool-loop is discussed in the docs.`)).toEqual([]);
    expect(parsePromptPatches("")).toEqual([]);
  });
});

describe("buildCandidate", () => {
  const basePrompt = "You are an agent.";

  it("builds a candidate, never an active version", () => {
    const r = buildCandidate({
      id: "v2",
      parent: null,
      proposal: propose(finding()),
      basePrompt,
      createdAt: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version.state).toBe("candidate");
    expect(r.version.parentId).toBeNull();
    expect(r.version.decisionId).toBeNull();
    expect(r.version.config.promptOverride).toContain("[axiom:premature-success]");
    expect(r.version.evidence).toHaveLength(1);
    // Nothing here may touch the loop parameters when the change is a prompt.
    expect(r.version.config.loop).toEqual(TEST_LOOP);
  });

  it("parents the candidate to the version it was derived from and builds on that prompt", () => {
    const parent: AgentVersion = {
      id: "v1",
      parentId: null,
      createdAt: 1,
      config: { promptOverride: `${basePrompt}\n\n[axiom:tool-loop]\nStop repeating.`, loop: TEST_LOOP },
      reason: "earlier fix",
      targetsFindingIds: ["f0"],
      evidence: [{ runId: "r", steps: [1], note: "n" }],
      state: "active",
      decisionId: null,
    };
    const r = buildCandidate({ id: "v2", parent, proposal: propose(finding()), basePrompt, createdAt: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version.parentId).toBe("v1");
    expect(countPatches(r.version.config.promptOverride!)).toBe(2);
    expect(r.version.config.promptOverride).toContain("[axiom:tool-loop]");
  });

  it("refuses to build a version identical to its parent, because that measures nothing", () => {
    const p = propose(finding());
    const first = buildCandidate({ id: "v1", parent: null, proposal: p, basePrompt, createdAt: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = buildCandidate({
      id: "v2",
      parent: { ...first.version, state: "active" },
      proposal: propose(finding({ id: "f2" })),
      basePrompt,
      createdAt: 2,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal).toMatch(/identical to its parent/);
  });

  it("refuses a recommendation, which has nothing to apply", () => {
    const r = buildCandidate({ id: "v1", parent: null, proposal: propose(finding({ rootCause: "model" })), basePrompt, createdAt: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toMatch(/model limit/);
  });

  it("applies a loop-parameter change to that field alone", () => {
    const r = buildCandidate({
      id: "v1",
      parent: null,
      proposal: propose(finding({ rootCause: "orchestration" })),
      basePrompt,
      createdAt: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version.config.loop).toEqual({ maxIterations: 40, verificationNudgeMax: 2 });
    expect(r.version.config.promptOverride).toBeNull();
  });

  it("refuses a proposal that names an actuator but carries no change", () => {
    const p = propose(finding());
    const r = buildCandidate({
      id: "v1",
      parent: null,
      proposal: { ...p, patch: undefined },
      basePrompt,
      createdAt: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toMatch(/no change to apply/);
  });

  it("surfaces the cap as the reason, not as a silent no-op", () => {
    const full = Array.from({ length: PROMPT_CAP.maxPatches }, (_, i) => patch(`axiom:d-${i}`, "x".repeat(10)));
    const prompt = applyPromptPatches(basePrompt, full).prompt;
    const parent: AgentVersion = {
      id: "v1",
      parentId: null,
      createdAt: 1,
      config: { promptOverride: prompt, loop: TEST_LOOP },
      reason: "full",
      targetsFindingIds: [],
      evidence: [],
      state: "active",
      decisionId: null,
    };
    const r = buildCandidate({ id: "v2", parent, proposal: propose(finding()), basePrompt, createdAt: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toMatch(/Refused/);
  });
});
