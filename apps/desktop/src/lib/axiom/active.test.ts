/**
 * What a send actually takes from AXIOM.
 *
 * These specs drive the real store wrapper through a faked `invoke`, because the property that
 * matters is the one at the boundary: the host hands back `{ config, versionId }`, and the turn wants
 * prompt *blocks* plus one loop number. A test that stubbed `axiomActiveConfig` would be asserting
 * the stub's shape against itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  active: null as unknown,
  fail: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "settings_get") return null;
    if (cmd !== "axiom_active_config") return undefined;
    if (h.fail) throw new Error("no such table: axiom_versions");
    return h.active;
  },
}));

vi.mock("../gateway-client", async () => await import("../gateway-client.fake"));

import { applyPromptPatches } from "@aiprovider/axiom-core";
import { NO_AXIOM_TURN, activeAxiomTurn } from "./active";

const LOOP = { maxIterations: 40, verificationNudgeMax: 2 };

beforeEach(() => {
  h.active = { config: { promptOverride: null, loop: LOOP }, versionId: null };
  h.fail = false;
});

describe("activeAxiomTurn", () => {
  it("carries the promoted loop number through to the turn", async () => {
    expect(await activeAxiomTurn()).toEqual({ patches: [], verificationNudgeMax: 2 });
  });

  it("hands back the blocks of a stored prompt, not the prompt", async () => {
    // The stored override is a whole prompt: whatever base the app composed when the version was
    // built, plus AXIOM's blocks. Running it verbatim would discard a system prompt the user has
    // edited since, so only the blocks travel.
    const stored = applyPromptPatches("You are an agent. Older base.", [
      { marker: "axiom:premature-success", text: "Run the check first." },
    ]).prompt;
    h.active = { config: { promptOverride: stored, loop: LOOP }, versionId: "v3" };
    const out = await activeAxiomTurn();
    expect(out.patches).toEqual([{ marker: "axiom:premature-success", text: "Run the check first." }]);
    expect(out.patches[0]?.text).not.toContain("Older base");
  });

  it("runs the turn unchanged when the host cannot answer", async () => {
    // A supervision layer that can break the agent it supervises is worse than no supervision layer:
    // the user pressed send, and "AXIOM's table is missing" is not a reason to refuse them.
    h.fail = true;
    expect(await activeAxiomTurn()).toEqual(NO_AXIOM_TURN);
    expect(NO_AXIOM_TURN.patches).toEqual([]);
    expect(NO_AXIOM_TURN.verificationNudgeMax).toBeUndefined();
  });
});
