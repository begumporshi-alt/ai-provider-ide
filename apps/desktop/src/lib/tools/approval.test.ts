/**
 * approval.test.ts — the gate's specification, asserted as behaviour rather than as inspection.
 *
 * The acceptance criterion for Phase 5 is stated as a pair of observable facts: *"in
 * 'auto-approve reads' a `read_file` runs with no modal but `write_file` still prompts"*. So the
 * tests below are written as those sentences. A test that only checked `decide()` returned the
 * right enum would pass while the wiring ran the wrong tool's effect.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES, INITIAL_APPROVAL, decide, modeApprovesWrites, withAllowAll, withTrustedTool,
} from "./approval";
import { AGENT_TOOLS, toolEffect } from "./registry";

function state(patch: Partial<Parameters<typeof decide>[0]> = {}) {
  return { ...INITIAL_APPROVAL, ...patch };
}

describe("toolEffect", () => {
  it("classifies the mutating tools as mutations and the rest as reads", () => {
    const mutate = AGENT_TOOLS.filter((t) => t.effect === "mutate").map((t) => t.name).sort();
    // `http_request` sends data out and `apply_patch` rewrites files, so both are gated like
    // the file writers even though neither name says "write".
    expect(mutate).toEqual(["apply_patch", "edit_file", "http_request", "mkdir", "run_command", "write_file"]);
  });

  it("answers `mutate` for a name the registry does not know", () => {
    // Fail closed. If an unrecognised name read as `read`, "auto-approve reads" would be a mode
    // that runs an unvetted tool without asking — the opposite of what the mode promises.
    expect(toolEffect("delete_everything")).toBe("mutate");
    expect(toolEffect(undefined)).toBe("mutate");
    expect(toolEffect(null)).toBe("mutate");
  });
});

describe("auto-approve reads — the acceptance criterion", () => {
  const s = state({ mode: "auto-reads" });

  it("runs read_file with no prompt", () => {
    expect(decide(s, "read_file")).toEqual({ action: "allow" });
    expect(decide(s, "search_files")).toEqual({ action: "allow" });
    expect(decide(s, "list_dir")).toEqual({ action: "allow" });
    expect(decide(s, "file_info")).toEqual({ action: "allow" });
  });

  it("still prompts for write_file", () => {
    expect(decide(s, "write_file")).toEqual({ action: "ask" });
    expect(decide(s, "edit_file")).toEqual({ action: "ask" });
    expect(decide(s, "mkdir")).toEqual({ action: "ask" });
    expect(decide(s, "run_command")).toEqual({ action: "ask" });
  });

  it("never auto-approves a write in any mode but yolo", () => {
    expect(modeApprovesWrites("ask")).toBe(false);
    expect(modeApprovesWrites("auto-reads")).toBe(false);
    expect(modeApprovesWrites("yolo")).toBe(true);
  });
});

describe("ask every time", () => {
  it("prompts even for a read — this is the behaviour the mode is named for", () => {
    expect(decide(state(), "read_file")).toEqual({ action: "ask" });
    expect(decide(state(), "write_file")).toEqual({ action: "ask" });
  });
});

describe("yolo", () => {
  it("runs everything", () => {
    const s = state({ mode: "yolo" });
    for (const t of AGENT_TOOLS) expect(decide(s, t.name), t.name).toEqual({ action: "allow" });
  });
});

describe("remembered answers", () => {
  it("'always allow this tool' covers that tool and only that tool", () => {
    const s = withTrustedTool(state(), "run_command");
    expect(decide(s, "run_command")).toEqual({ action: "allow" });
    expect(decide(s, "write_file")).toEqual({ action: "ask" });
  });

  it("'allow for this session' covers everything, including tools trusted on no list", () => {
    const s = withAllowAll(state());
    expect(decide(s, "write_file")).toEqual({ action: "allow" });
    expect(decide(s, "run_command")).toEqual({ action: "allow" });
  });

  it("trusting a tool does not mutate the state the caller still holds", () => {
    // The modal resolves from a closure over the previous state; if `withTrustedTool` mutated it,
    // the render that had already read `trustedTools` would disagree with the store.
    const before = state();
    withTrustedTool(before, "write_file");
    expect(before.trustedTools.size).toBe(0);
  });
});

describe("plan mode", () => {
  it("refuses a mutation with a reason that says what to do instead", () => {
    const v = decide(state({ planMode: true, mode: "yolo" }), "write_file");
    expect(v.action).toBe("deny");
    if (v.action === "deny") {
      expect(v.reason).toContain("write_file");
      expect(v.reason).toContain("PLAN MODE");
      // The reason must not be the generic "the user denied this": the user was never asked, and
      // the model would respond by rephrasing the same call instead of proposing a plan.
      expect(v.reason).not.toContain("denied by the user");
      expect(v.reason).toContain("plan");
    }
  });

  it("outranks yolo — 'propose first' cannot be switched off by the mode underneath it", () => {
    expect(decide(state({ planMode: true, mode: "yolo" }), "edit_file").action).toBe("deny");
    expect(decide(state({ planMode: true, mode: "yolo" }), "run_command").action).toBe("deny");
  });

  it("outranks a session-wide allow", () => {
    expect(decide(withAllowAll(state({ planMode: true })), "write_file").action).toBe("deny");
  });

  it("outranks a tool the user trusted earlier", () => {
    const s = withTrustedTool(state({ planMode: true }), "write_file");
    expect(decide(s, "write_file").action).toBe("deny");
  });

  it("does not grant reads that the mode underneath withholds", () => {
    // Plan mode subtracts. If it also auto-approved reads, "ask every time" + plan mode would be
    // a session whose gate the user cannot predict from the two labels they picked.
    const s = state({ mode: "ask", planMode: true });
    expect(decide(s, "read_file")).toEqual({ action: "ask" });
  });

  it("is quiet about reads when paired with auto-approve reads", () => {
    const s = state({ mode: "auto-reads", planMode: true });
    expect(decide(s, "read_file")).toEqual({ action: "allow" });
    expect(decide(s, "search_files")).toEqual({ action: "allow" });
    expect(decide(s, "write_file").action).toBe("deny");
  });
});

describe("APPROVAL_MODES", () => {
  it("offers the three modes the plan names, each explained", () => {
    expect(APPROVAL_MODES.map((m) => m.id)).toEqual(["ask", "auto-reads", "yolo"]);
    for (const m of APPROVAL_MODES) expect(m.hint.trim().length).toBeGreaterThan(20);
  });

  it("starts on the safest mode", () => {
    expect(INITIAL_APPROVAL.mode).toBe("ask");
    expect(INITIAL_APPROVAL.allowAll).toBe(false);
    expect(INITIAL_APPROVAL.planMode).toBe(false);
  });
});
