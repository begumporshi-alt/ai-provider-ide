import { describe, expect, it } from "vitest";
import { composeManifest, verifyCapability, type CapabilitySnapshot } from "./manifest";
import type { Memory } from "../../store";

const snap = (over: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  mode: "agent",
  tools: ["read_file", "write_file", "run_command"],
  gitSubcommands: ["status", "clone", "fetch", "commit"],
  ...over,
});

const mem = (
  id: string,
  kind: Memory["kind"],
  text: string,
  over: Partial<Memory> = {},
): Memory => ({
  id,
  layer: kind === "identity" ? "L3" : "L1",
  text,
  session_id: null,
  subject: null,
  created_at: 1,
  updated_at: 1,
  pinned: false,
  scope: { user: "local", project: null, agent: null, global: true },
  superseded_at: null,
  kind,
  source: "inferred",
  verified: null,
  expires_at: null,
  retrieval_count: 0,
  last_retrieved_at: null,
  ...over,
});

describe("verifyCapability", () => {
  it("contradicts a 'cannot clone' claim when the sandbox allows clone", () => {
    expect(verifyCapability("The assistant cannot run git clone or git fetch", snap()))
      .toBe("contradicted");
  });

  it("treats 'unavailable' as negation, not as the affirmative 'available'", () => {
    expect(verifyCapability("git clone is unavailable in this build", snap()))
      .toBe("contradicted");
  });

  it("returns unverified when the capability snapshot is empty", () => {
    // Absence of evidence is not evidence of inability. A blank snapshot is a caller that could
    // not read the policy — not a sandbox that forbids everything. Calling this `live` is how the
    // stale claim the manifest exists to remove would be re-injected verbatim.
    expect(
      verifyCapability(
        "The assistant cannot run git clone",
        snap({ mode: "plain", tools: [], gitSubcommands: [] }),
      ),
    ).toBe("unverified");
  });

  it("leaves an unclassifiable claim unverified", () => {
    expect(verifyCapability("Tushu lives in Dhaka", snap())).toBe("unverified");
  });
});

describe("composeManifest", () => {
  it("orders identity, user-stated preference, decision, live capability, then recency", () => {
    const out = composeManifest(
      [
        mem("fact", "project_fact", "project fact", { updated_at: 99 }),
        mem("cap", "capability", "The assistant can run git clone", { updated_at: 50 }),
        mem("dec", "decision", "we will use SQLite", { updated_at: 10 }),
        mem("pref", "preference", "prefers terse replies", { source: "user_stated", updated_at: 5 }),
        mem("id", "identity", "I am Tushu", { updated_at: 1 }),
      ],
      snap(),
      10_000,
    );

    const order = out.entries.filter((e) => e.included).map((e) => e.id);
    expect(order).toEqual(["id", "pref", "dec", "cap"]);
    // Project facts are query-shaped: they stay in `entries` for the echo, but the block leaves
    // them to recall rather than crowding the header with them.
    const fact = out.entries.find((e) => e.id === "fact")!;
    expect(fact.included).toBe(false);
    expect(out.block).not.toContain("project fact");
  });

  it("keeps project facts out of the block so recall owns them", () => {
    const out = composeManifest(
      [mem("fact", "project_fact", "the graph has 4 node kinds")],
      snap(),
      10_000,
    );
    expect(out.block).toBe("");
    expect(out.entries.map((e) => e.id)).toEqual(["fact"]);
  });

  it("drops expired rows and keeps contradicted capabilities out of the prompt", () => {
    const out = composeManifest(
      [
        mem("expired", "project_fact", "old fact", { expires_at: 10 }),
        mem("stale", "capability", "cannot run git clone"),
      ],
      snap(),
      10_000,
      100,
    );

    expect(out.entries.map((e) => e.id)).not.toContain("expired");
    const stale = out.entries.find((e) => e.id === "stale")!;
    expect(stale.verified).toBe("contradicted");
    expect(stale.included).toBe(false);
    expect(out.block).not.toContain("cannot run git clone");
  });

  it("stops at the token budget rather than truncating a line", () => {
    const big = Array.from({ length: 50 }, (_, i) =>
      mem(`d${i}`, "decision", `decision number ${i} `.repeat(10), { updated_at: i }),
    );
    const out = composeManifest(big, snap(), 100, 100);
    expect(out.tokens).toBeLessThanOrEqual(100);
    expect(out.entries.filter((e) => e.included).length).toBeLessThan(50);
  });
});
