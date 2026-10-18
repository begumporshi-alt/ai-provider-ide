/**
 * Stages 04–05 — **Design** and **Modify**.
 *
 * Design answers "what would actually fix this", and the honest answer is often "nothing I can
 * apply". v1 has two actuators — the system prompt and two loop parameters — and six root causes.
 * Rather than stretching a prompt patch over a cause it cannot address, `design` emits a `manual`
 * proposal that says what actuator would be needed. A recommendation AXIOM labels as a
 * recommendation is useful; the same recommendation dressed up as a change it applied is the
 * premature success claim this whole package exists to detect.
 *
 * Modify is deliberately conservative in one specific way. **The prompt is the actuator most likely
 * to be abused**, because appending an instruction always looks like progress and never fails
 * loudly — it just makes the system turn longer, which costs context on every subsequent turn and
 * shows up nowhere as an error. So patches are idempotent by marker, capped by count and by
 * characters, and a cap that bites produces a refusal rather than a silently truncated prompt.
 * AXIOM has a detector for context waste; it would be a poor showing to trip it.
 */
import type { IdPort } from "./ports";
import type { Actuator, AgentConfig, AgentVersion, DetectorId, Evidence, Finding, LoopParams, RootCause } from "./types";

export type ProposalActuator = Actuator | "manual";

/**
 * The two fields a patch contributes to a prompt.
 *
 * Split out from `PromptPatch` because the app needs to re-apply a stored version's patches on top
 * of whatever system prompt it is composing, and a patch read back *out of* a prompt cannot supply a
 * `detector` honestly — the marker is the only trace the prompt keeps. A function that only writes
 * `marker` and `text` should not demand a field it never reads.
 */
export interface PromptPatchBlock {
  marker: string;
  text: string;
}

/**
 * The marker makes a patch idempotent. Without it, promoting the same fix twice appends it twice —
 * and because a duplicated instruction still reads as sensible prose, nothing would ever complain.
 */
export interface PromptPatch extends PromptPatchBlock {
  detector: DetectorId;
}

export interface LoopParamChange {
  field: keyof LoopParams;
  from: number;
  to: number;
}

export interface Proposal {
  id: string;
  actuator: ProposalActuator;
  title: string;
  /** Why this actuator, for this root cause, on this evidence. */
  rationale: string;
  rootCause: RootCause;
  detector: DetectorId;
  targetsFindingIds: string[];
  /** The metric a validation run has to move for this proposal to count as having worked. */
  targetMetric: string | null;
  evidence: Evidence[];
  patch?: PromptPatch;
  loop?: LoopParamChange;
  /** Set when `actuator` is `manual`: what is missing, in words a user can act on. */
  blockedReason?: string;
}

/**
 * The instructions AXIOM knows how to add. Each one is written to be *checkable* — it names the
 * observable behaviour, not a virtue — because an instruction like "be careful" cannot be validated
 * by any suite and would make the whole loop unverifiable.
 */
export const PATCH_LIBRARY: Readonly<Partial<Record<DetectorId, Omit<PromptPatch, "marker">>>> = {
  "premature-success": {
    detector: "premature-success",
    text:
      "Before you state that work is complete, run one check whose output could contradict you — the " +
      "project's tests, a typecheck, a build — and quote what it printed. If nothing was changed, say " +
      "that instead of claiming success.",
  },
  "verification-absent": {
    detector: "verification-absent",
    text:
      "A statement about the state of the workspace is a claim that needs a tool call behind it. If you " +
      "have not called a tool, you have not looked, and the answer must say so rather than assert an outcome.",
  },
  "tool-loop": {
    detector: "tool-loop",
    text:
      "If a call has returned the same result twice, a third identical call is not another attempt. Change " +
      "the approach, or report what is blocking you.",
  },
  "retry-storm": {
    detector: "retry-storm",
    text:
      "When the same tool has failed twice with different arguments, stop calling it. Report the failure and " +
      "its output rather than spending the rest of the budget on a third variant.",
  },
  "denied-storm": {
    detector: "denied-storm",
    text:
      "A refused tool call is a boundary, not an obstacle. Do not retry it or route around it through another " +
      "tool; say what you needed and why you could not have it.",
  },
  "wrong-tool": {
    detector: "wrong-tool",
    text:
      "Read a tool's error text before retrying. When it names an argument, the argument is wrong — fix that, " +
      "do not resubmit the same call.",
  },
  "context-loss": {
    detector: "context-loss",
    text:
      "Do not re-read a file you have already read successfully; its contents are still in this transcript. " +
      "Answer from what is above rather than fetching it again.",
  },
  runaway: {
    detector: "runaway",
    text:
      "Budget your steps. If you are many calls in without the task getting measurably closer, stop and report " +
      "what is done, what is not, and what is blocking it.",
  },
  waste: {
    detector: "waste",
    text: "Answer in the fewest words that carry the information. Do not restate what you already said.",
  },
};

/** The most a loop parameter may be raised to. A ceiling that only moves up is not a ceiling. */
export const VERIFICATION_NUDGE_HARD_MAX = 3;

function loopRule(detector: DetectorId, loop: LoopParams): LoopParamChange | null {
  switch (detector) {
    case "premature-success":
    case "verification-absent": {
      if (loop.verificationNudgeMax >= VERIFICATION_NUDGE_HARD_MAX) return null;
      return {
        field: "verificationNudgeMax",
        from: loop.verificationNudgeMax,
        to: loop.verificationNudgeMax + 1,
      };
    }
    default:
      // Raising `maxIterations` is the obvious move for a runaway and the wrong one: it buys more
      // of the behaviour that was diagnosed, at a higher cost, and reports the extra spend as an
      // improvement. There is no loop parameter that fixes a stuck agent, so say so.
      return null;
  }
}

const ACTUATORS: Readonly<Record<RootCause, readonly ProposalActuator[]>> = {
  prompt: ["prompt"],
  orchestration: ["loop-params", "prompt"],
  tool: ["prompt", "manual"],
  memory: ["manual"],
  model: ["manual"],
  infra: ["manual"],
};

const BLOCKED_REASON: Readonly<Record<RootCause, string>> = {
  model:
    "No configuration change addresses a model limit, and the differential in this finding's rationale names " +
    "the models that did not fail the task. Switching model is the user's decision and the user's money.",
  memory:
    "Fixing this needs an actuator over the memory store — retrieval, retention or scoping. v1 has none, so " +
    "the finding is reported rather than applied.",
  tool:
    "The fix belongs in the tool or its integration, which v1 cannot modify, and the patch library has no " +
    "instruction for this detector. A prompt patch that only made the agent give up sooner would reduce the " +
    "failure count while leaving the broken tool broken — which the guardian would then read as an improvement.",
  infra:
    "This is an infrastructure fault. Changing the agent would treat the symptom and hide the cause.",
  prompt: "No patch exists for this detector.",
  orchestration: "No loop parameter addresses this detector.",
};

export interface DesignInput {
  findings: Finding[];
  active: AgentConfig;
  ids: IdPort;
  /** Cap the number of proposals so one bad run cannot generate a dozen changes at once. */
  limit?: number;
}

/**
 * Turn findings into proposals. One proposal per finding: bundling several fixes into one version
 * would make the validation run unable to say which of them worked, which is the error the
 * conventions chapter names for tests and which applies unchanged here.
 */
export function design(input: DesignInput): Proposal[] {
  const limit = input.limit ?? 5;
  const out: Proposal[] = [];

  for (const f of input.findings) {
    if (out.length >= limit) break;
    const proposal = buildProposal(f, input.active, input.ids);
    if (proposal) out.push(proposal);
  }
  return out;
}

function buildProposal(f: Finding, active: AgentConfig, ids: IdPort): Proposal | null {
  const base = {
    id: ids.next("proposal"),
    rootCause: f.rootCause,
    detector: f.detector,
    targetsFindingIds: [f.id],
    targetMetric: f.metric,
    evidence: f.evidence,
  };

  for (const actuator of ACTUATORS[f.rootCause]) {
    if (actuator === "prompt") {
      const entry = PATCH_LIBRARY[f.detector];
      if (!entry) continue;
      return {
        ...base,
        actuator,
        title: `Add an instruction addressing ${f.detector}`,
        rationale:
          `Root cause reads as '${f.rootCause}', and the actuator for that is the system prompt. ` +
          `${f.rationale} The patch names an observable behaviour so a validation run can tell whether it worked.`,
        patch: { marker: `axiom:${f.detector}`, detector: entry.detector, text: entry.text },
      };
    }
    if (actuator === "loop-params") {
      const change = loopRule(f.detector, active.loop);
      if (!change) continue;
      return {
        ...base,
        actuator,
        title: `Raise ${change.field} from ${change.from} to ${change.to}`,
        rationale:
          `Root cause reads as '${f.rootCause}': the loop gave up before the agent could comply. ` +
          `${f.rationale} The ceiling is capped at ${VERIFICATION_NUDGE_HARD_MAX} so this can only ever be a bounded change.`,
        loop: change,
      };
    }
    return {
      ...base,
      actuator: "manual",
      title: `${f.detector}: reported, not applied`,
      rationale: f.rationale,
      blockedReason: BLOCKED_REASON[f.rootCause],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Modify — building a candidate version
// ---------------------------------------------------------------------------

export const PROMPT_CAP = {
  /** How many AXIOM patches may be present at once. */
  maxPatches: 6,
  /** Total characters of patch text. The base prompt is not counted; it is not ours to shrink. */
  maxPatchChars: 2400,
};

export interface PatchApplication {
  prompt: string;
  applied: PromptPatchBlock[];
  /** Already present. Not an error — it means an earlier version fixed this and was kept. */
  alreadyPresent: PromptPatchBlock[];
  /** Refused by the cap. Reported because a silent refusal is a change that did not happen. */
  refused: { patch: PromptPatchBlock; reason: string }[];
}

export function countPatches(prompt: string): number {
  return (prompt.match(PATCH_BLOCK) ?? []).length;
}

/**
 * A patch block, from its marker to the next one or the end. Digits are in the character class
 * because the cap this pattern enforces must not depend on the spelling of a detector id: a marker
 * the pattern fails to match is a patch `countPatches` cannot see, and an unseen patch is one the
 * cap will let through.
 */
const PATCH_BLOCK = /\n\n\[axiom:[a-z0-9-]+\]\n[\s\S]*?(?=\n\n\[axiom:[a-z0-9-]+\]\n|$)/g;

/** Characters AXIOM has added to this prompt. The base is excluded: it is not ours to shrink. */
export function patchChars(prompt: string): number {
  let total = 0;
  for (const m of prompt.matchAll(PATCH_BLOCK)) total += (m[0] ?? "").length;
  return total;
}

/**
 * The part of a prompt that is **not** inside a recognised patch block.
 *
 * A real candidate's `promptOverride` is the **base prompt plus** its patches (`buildCandidate`
 * appends to `basePrompt`), so the base is legitimately unmarked and must not be forbidden. What is
 * worth asking is the complementary question to `patchChars`: has anything been added that the
 * marker scan cannot see, and therefore cannot count, cap, or re-apply at send time? Comparing this
 * text against the base version's answers it exactly.
 */
export function unmarkedChars(prompt: string): string {
  return prompt.replace(PATCH_BLOCK, "");
}

/**
 * Append patches to a base prompt. Idempotent by marker, and capped — see the module comment for
 * why the cap produces a refusal rather than a truncated prompt.
 */
export function applyPromptPatches(base: string, patches: PromptPatchBlock[], cap = PROMPT_CAP): PatchApplication {
  const applied: PromptPatchBlock[] = [];
  const alreadyPresent: PromptPatchBlock[] = [];
  const refused: PatchApplication["refused"] = [];
  let prompt = base;

  for (const p of patches) {
    if (prompt.includes(p.marker)) {
      alreadyPresent.push(p);
      continue;
    }
    // Counted from the prompt rather than from `applied`: the prompt already carries the patches
    // this call added *and* any an ancestor version left there, and the cap is on how many the
    // system turn holds, not on how many this one call appended. Adding the two together — the
    // obvious way to write it — counts every new patch twice and quietly halves the limit.
    if (countPatches(prompt) >= cap.maxPatches) {
      refused.push({ patch: p, reason: `the prompt already carries ${cap.maxPatches} AXIOM patches` });
      continue;
    }
    const block = `\n\n[${p.marker}]\n${p.text}`;
    if (patchChars(prompt) + block.length > cap.maxPatchChars) {
      refused.push({ patch: p, reason: `adding it would take AXIOM's patch text past ${cap.maxPatchChars} characters` });
      continue;
    }
    prompt += block;
    applied.push(p);
  }
  return { prompt, applied, alreadyPresent, refused };
}

/**
 * The inverse of `applyPromptPatches`: the AXIOM blocks a prompt already carries.
 *
 * The app does not run a stored `promptOverride` verbatim. That would be correct while the base is
 * the built-in system prompt and wrong the moment a user edits their own prompt in settings — the
 * override would quietly discard their edit, and the agent AXIOM benchmarked would stop being the
 * agent the user runs. So the version travels as its patches, and the base is whatever the app
 * composes today. Round-tripped by `version.test.ts`, because a parse that lost a character would
 * produce a prompt that still reads as sensible prose.
 */
export function parsePromptPatches(prompt: string): PromptPatchBlock[] {
  const out: PromptPatchBlock[] = [];
  for (const m of prompt.matchAll(PATCH_BLOCK)) {
    // A block is exactly what `applyPromptPatches` appended: `\n\n[marker]\ntext`.
    const inner = (m[0] ?? "").replace(/^\n\n/, "");
    const close = inner.indexOf("]\n");
    if (close <= 0) continue;
    out.push({ marker: inner.slice(1, close), text: inner.slice(close + 2) });
  }
  return out;
}

export interface CandidateInput {
  id: string;
  parent: AgentVersion | null;
  proposal: Proposal;
  /** The parent's prompt, or the host's built-in `AGENT_SYSTEM` when the parent has no override. */
  basePrompt: string;
  createdAt: number;
}

export type CandidateResult = { ok: true; version: AgentVersion } | { ok: false; refusal: string };

/**
 * Build the candidate version a proposal implies. **Candidate, never active**: nothing here calls
 * `setState`, so building a version changes nothing about the agent until the guardian promotes it.
 */
export function buildCandidate(input: CandidateInput): CandidateResult {
  const { proposal, parent } = input;
  if (proposal.actuator === "manual") {
    return { ok: false, refusal: proposal.blockedReason ?? "This proposal is a recommendation, not a change." };
  }

  const baseConfig: AgentConfig = parent
    ? parent.config
    : { promptOverride: null, loop: { maxIterations: 40, verificationNudgeMax: 1 } };

  if (proposal.actuator === "prompt" && proposal.patch) {
    const base = baseConfig.promptOverride ?? input.basePrompt;
    const result = applyPromptPatches(base, [proposal.patch]);
    if (result.applied.length === 0) {
      // Already present means an ancestor version carries this patch and it demonstrably did not fix
      // the finding. Re-applying it would produce a version identical to its parent, and a validation
      // run comparing the two would measure nothing at all.
      return {
        ok: false,
        refusal:
          result.refused.length > 0
            ? `Refused: ${result.refused[0]?.reason ?? "the prompt cap"}.`
            : `The prompt already carries this patch (${proposal.patch.marker}) and the finding still fires. ` +
              `A new version identical to its parent would measure nothing.`,
      };
    }
    return {
      ok: true,
      version: {
        id: input.id,
        parentId: parent?.id ?? null,
        createdAt: input.createdAt,
        config: { ...baseConfig, promptOverride: result.prompt },
        reason: proposal.title,
        targetsFindingIds: proposal.targetsFindingIds,
        evidence: proposal.evidence,
        state: "candidate",
        decisionId: null,
      },
    };
  }

  if (proposal.actuator === "loop-params" && proposal.loop) {
    const { field, to } = proposal.loop;
    return {
      ok: true,
      version: {
        id: input.id,
        parentId: parent?.id ?? null,
        createdAt: input.createdAt,
        config: { ...baseConfig, loop: { ...baseConfig.loop, [field]: to } },
        reason: proposal.title,
        targetsFindingIds: proposal.targetsFindingIds,
        evidence: proposal.evidence,
        state: "candidate",
        decisionId: null,
      },
    };
  }

  return { ok: false, refusal: "The proposal names an actuator but carries no change to apply." };
}
