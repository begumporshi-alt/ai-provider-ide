/**
 * Memory engine behaviour (P7). Pins the four properties that would otherwise break silently:
 *   - a model reply that ignores the JSON instruction yields nothing, never a thrown parse
 *   - recall is layered: distilled layers get their share before the raw ones
 *   - pinned memories survive recall even when BM25 ranks them last
 *   - the injected block is labeled and bounded, so recall cannot eat the prompt
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../../store";
import type { Memory } from "../../store";
import {
  DEFAULT_CONTEXT_BUDGET,
  MAX_ATOM_CHARS,
  SCENARIO_EVERY,
  captureCore,
  distilScenarios,
  distilTurn,
  editCore,
  memoryBlock,
  parseAtoms,
  parseScenarios,
  recallContext,
  recordRecall,
  rememberTurn,
  resetDistillation,
} from "./engine";
import { startSession } from "../context/recorder";

const captureMemories = vi.spyOn(store, "captureMemories");
const captureMemory = vi.spyOn(store, "captureMemory");
const recallMemories = vi.spyOn(store, "recallMemories");
const listMemories = vi.spyOn(store, "listMemories");
const sessionMemories = vi.spyOn(store, "sessionMemories");
const updateMemory = vi.spyOn(store, "updateMemory");
const recordContext = vi.spyOn(store, "recordContext");

function mem(id: string, layer: Memory["layer"], text: string, pinned = false): Memory {
  return {
    id, layer, text, session_id: "s", subject: null,
    created_at: 1, updated_at: 1, pinned, score: -1,
  };
}

describe("memory engine", () => {
  beforeEach(() => {
    captureMemories.mockReset();
    captureMemory.mockReset();
    recallMemories.mockReset();
    listMemories.mockReset();
    sessionMemories.mockReset();
    updateMemory.mockReset();
    recordContext.mockReset();
    captureMemories.mockResolvedValue(0);
    captureMemory.mockResolvedValue(mem("m", "L1", "x"));
    recallMemories.mockResolvedValue([]);
    listMemories.mockResolvedValue([]);
    sessionMemories.mockResolvedValue([]);
    updateMemory.mockResolvedValue(true);
    recordContext.mockResolvedValue();
    startSession("mem-test");
  });

  describe("parseAtoms", () => {
    it("reads a bare JSON array", () => {
      expect(parseAtoms('["Tushu prefers concise answers", "Dhaka is GMT+6"]')).toEqual([
        "Tushu prefers concise answers",
        "Dhaka is GMT+6",
      ]);
    });

    it("survives prose the model wrapped around the array", () => {
      const reply = 'Sure! Here are the facts:\n```json\n["a fact"]\n```\nHope that helps.';
      expect(parseAtoms(reply)).toEqual(["a fact"]);
    });

    it("returns nothing rather than throwing on garbage", () => {
      for (const bad of ["", "no json here", "[unterminated", "{not an array}", "null"]) {
        expect(parseAtoms(bad)).toEqual([]);
      }
    });

    it("drops non-strings and clamps oversized atoms", () => {
      const long = "y".repeat(MAX_ATOM_CHARS + 50);
      expect(parseAtoms(`["ok", 42, null, "${long}"]`)).toHaveLength(2);
      expect(parseAtoms(`["${long}"]`)[0]).toHaveLength(MAX_ATOM_CHARS);
    });
  });

  describe("distilTurn", () => {
    beforeEach(() => resetDistillation());

    /** Accumulate a full batch the way three real turns would. */
    async function threeTurns(): Promise<void> {
      await rememberTurn("s", "q1", "a1");
      await rememberTurn("s", "q2", "a2");
      await rememberTurn("s", "q3", "a3");
    }

    it("stores the atoms the model extracted", async () => {
      const generate = vi.fn().mockResolvedValue('["Lives in Dhaka", "Prefers terse replies"]');
      await threeTurns();
      const got = await distilTurn("s", "m/1", generate);
      expect(got).toEqual(["Lives in Dhaka", "Prefers terse replies"]);
      const stored = captureMemories.mock.calls.filter((c) => (c[0][0] as { layer: string }).layer === "L1");
      expect(stored).toHaveLength(1);
      expect(stored[0]![0][0]).toMatchObject({ layer: "L1", text: "Lives in Dhaka", sessionId: "s" });
    });

    it("does not call the model until a full batch has accumulated", async () => {
      const generate = vi.fn().mockResolvedValue('["x"]');
      await rememberTurn("s", "q1", "a1");
      expect(await distilTurn("s", "m/1", generate)).toEqual([]);
      await rememberTurn("s", "q2", "a2");
      expect(await distilTurn("s", "m/1", generate)).toEqual([]);
      expect(generate).not.toHaveBeenCalled();
      await rememberTurn("s", "q3", "a3");
      await distilTurn("s", "m/1", generate);
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it("distils the accumulated window, not just the latest turn", async () => {
      const generate = vi.fn().mockResolvedValue("[]");
      await threeTurns();
      await distilTurn("s", "m/1", generate);
      const prompt = generate.mock.calls[0]![1] as string;
      expect(prompt).toContain("q1");
      expect(prompt).toContain("q3");
    });

    it("keeps the window when the call fails, so the next batch retries it", async () => {
      const generate = vi.fn().mockRejectedValue(new Error("upstream 500"));
      await threeTurns();
      await expect(distilTurn("s", "m/1", generate)).resolves.toEqual([]);
      generate.mockResolvedValue('["recovered"]');
      await rememberTurn("s", "q4", "a4");
      expect(await distilTurn("s", "m/1", generate)).toEqual(["recovered"]);
    });

    it("writes nothing when the model finds nothing durable", async () => {
      const generate = vi.fn().mockResolvedValue("[]");
      await threeTurns();
      await distilTurn("s", "m/1", generate);
      const stored = captureMemories.mock.calls.filter((c) => (c[0][0] as { layer: string }).layer === "L1");
      expect(stored).toHaveLength(0);
    });

    it("does not call out at all when there is no model configured", async () => {
      const generate = vi.fn();
      await threeTurns();
      await expect(distilTurn("s", "", generate)).resolves.toEqual([]);
      expect(generate).not.toHaveBeenCalled();
    });
  });

  describe("rememberTurn", () => {
    it("writes both sides of the exchange as L0", async () => {
      await rememberTurn("s", "question", "answer");
      const items = captureMemories.mock.calls[0]![0];
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ layer: "L0", text: "question", subject: "user" });
      expect(items[1]).toMatchObject({ layer: "L0", text: "answer", subject: "assistant" });
    });

    it("swallows a write failure", async () => {
      captureMemories.mockRejectedValueOnce(new Error("db locked"));
      await expect(rememberTurn("s", "a", "b")).resolves.toBeUndefined();
    });
  });

  describe("distilScenarios", () => {
    beforeEach(() => resetDistillation());

    /** Make `sessionMemories` return n atoms in the layer, oldest first. */
    function atomsInSession(count: number) {
      sessionMemories.mockResolvedValue(
        Array.from({ length: count }, (_, i) => mem(`a${i}`, "L1", `atom ${i}`)),
      );
    }

    it("does not call the model until SCENARIO_EVERY new atoms have piled up", async () => {
      const generate = vi.fn();
      atomsInSession(SCENARIO_EVERY - 1);
      expect(await distilScenarios("s", "m/1", generate)).toBe(0);
      expect(generate).not.toHaveBeenCalled();
    });

    it("distils a window of new atoms when the threshold is crossed", async () => {
      const generate = vi.fn().mockResolvedValue(
        JSON.stringify([{ subject: "router work", text: "we are fixing the gateway" }]),
      );
      atomsInSession(SCENARIO_EVERY + 2);
      const written = await distilScenarios("s", "m/1", generate);
      expect(written).toBe(1);
      expect(captureMemories).toHaveBeenCalledTimes(1);
      const stored = captureMemories.mock.calls[0]![0];
      expect(stored[0]).toMatchObject({
        layer: "L2",
        text: "we are fixing the gateway",
        subject: "router work",
        sessionId: "s",
      });
      // First pass: every atom is unseen, so the prompt contains all of them.
      const firstPrompt = generate.mock.calls[0]![1] as string;
      expect(firstPrompt).toContain("atom 0");
      expect(firstPrompt).toContain(`atom ${SCENARIO_EVERY + 1}`);
      // Second pass, only after six *new* atoms have piled up: the previous batch is excluded.
      // After the first pass consumed 8 atoms, the next pass fires only when there are at least
      // SCENARIO_EVERY atoms past the recorded cursor of 8 — i.e. 14 or more.
      sessionMemories.mockResolvedValue(
        Array.from({ length: SCENARIO_EVERY + 8 }, (_, i) => mem(`b${i}`, "L1", `new ${i}`)),
      );
      await distilScenarios("s", "m/1", generate);
      const secondPrompt = generate.mock.calls[1]![1] as string;
      // First pass consumed atoms 0..7 (cursor now at 8); the second pass starts at index 8.
      expect(secondPrompt).toContain("new 8");
      expect(secondPrompt).toContain("new 13");
      expect(secondPrompt).not.toContain("new 0");
      expect(secondPrompt).not.toContain("new 7");
    });

    it("does not refire on the very next call until another SCENARIO_EVERY arrive", async () => {
      const generate = vi.fn().mockResolvedValue(
        JSON.stringify([{ subject: "x", text: "y" }]),
      );
      atomsInSession(SCENARIO_EVERY);
      await distilScenarios("s", "m/1", generate);
      expect(generate).toHaveBeenCalledTimes(1);
      // No new atoms between calls.
      await distilScenarios("s", "m/1", generate);
      expect(generate).toHaveBeenCalledTimes(1);
      // Six more arrive -> next pass fires.
      sessionMemories.mockResolvedValue([
        ...Array.from({ length: SCENARIO_EVERY * 2 }, (_, i) => mem(`a${i}`, "L1", `atom ${i}`)),
      ]);
      await distilScenarios("s", "m/1", generate);
      expect(generate).toHaveBeenCalledTimes(2);
    });

    it("rolls back the cursor when the call fails so the next pass retries the same atoms", async () => {
      const generate = vi.fn().mockRejectedValue(new Error("500"));
      atomsInSession(SCENARIO_EVERY);
      expect(await distilScenarios("s", "m/1", generate)).toBe(0);
      generate.mockResolvedValue(JSON.stringify([{ subject: "x", text: "y" }]));
      // Same atoms, no new ones.
      await distilScenarios("s", "m/1", generate);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(captureMemories).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when the model finds nothing groupable", async () => {
      const generate = vi.fn().mockResolvedValue("[]");
      atomsInSession(SCENARIO_EVERY);
      expect(await distilScenarios("s", "m/1", generate)).toBe(0);
      expect(captureMemories).not.toHaveBeenCalled();
    });

    it("does not call out at all when there is no model configured", async () => {
      const generate = vi.fn();
      atomsInSession(SCENARIO_EVERY);
      expect(await distilScenarios("s", "", generate)).toBe(0);
      expect(generate).not.toHaveBeenCalled();
    });
  });

  describe("parseScenarios", () => {
    it("reads a bare JSON array", () => {
      const got = parseScenarios(JSON.stringify([
        { subject: "router work", text: "we are fixing the gateway" },
        { subject: "writing style", text: "lead with the conclusion" },
      ]));
      expect(got).toEqual([
        { subject: "router work", text: "we are fixing the gateway" },
        { subject: "writing style", text: "lead with the conclusion" },
      ]);
    });

    it("survives prose the model wrapped around the JSON", () => {
      const reply = "Sure!\n```json\n[{\"subject\":\"x\",\"text\":\"y\"}]\n```";
      expect(parseScenarios(reply)).toEqual([{ subject: "x", text: "y" }]);
    });

    it("clamps long texts and drops entries with empty subject or text", () => {
      const long = "y".repeat(500);
      expect(
        parseScenarios(JSON.stringify([
          { subject: "ok", text: "good" },
          { subject: "", text: "no subject" },
          { subject: "no text", text: "" },
          { subject: "long", text: long },
        ])),
      ).toEqual([
        { subject: "ok", text: "good" },
        { subject: "long", text: `${"y".repeat(399)}…` },
      ]);
    });

    it("returns nothing rather than throwing on garbage", () => {
      for (const bad of ["", "no json", "[unterminated", "{not an array}", "null"]) {
        expect(parseScenarios(bad)).toEqual([]);
      }
    });
  });

  describe("L3 core profile", () => {
    it("captureCore pins the fact so it always rides along in recall", async () => {
      captureMemory.mockResolvedValue({ ...mem("core1", "L3", "Lives in Dhaka"), pinned: true });
      const m = await captureCore("Lives in Dhaka");
      expect(captureMemory).toHaveBeenCalledWith(
        expect.objectContaining({ layer: "L3", text: "Lives in Dhaka", pinned: true }),
      );
      expect(m).not.toBeNull();
    });

    it("editCore routes through updateMemory and survives a missing id", async () => {
      updateMemory.mockResolvedValueOnce(true);
      expect(await editCore("m1", "new text")).toBe(true);
      updateMemory.mockRejectedValueOnce(new Error("missing"));
      expect(await editCore("missing", "x")).toBe(false);
    });
  });

  describe("recallContext", () => {
    it("gives the distilled layers first refusal on half the budget", async () => {
      recallMemories.mockImplementation(async (_q, _limit, layers) => {
        if (layers && layers.includes("L3")) return [mem("a", "L3", "core")];
        return [mem("b", "L1", "atom"), mem("c", "L0", "raw")];
      });
      const hits = await recallContext("anything", { limit: 4 });
      expect(hits.map((m) => m.id)).toEqual(["a", "b", "c"]);
      const abstractCall = recallMemories.mock.calls.find((c) => (c[2] ?? []).includes("L3"));
      expect(abstractCall?.[1]).toBe(2); // half of a limit of 4
    });

    it("lets the specific layers use whatever the abstract ones did not", async () => {
      recallMemories.mockImplementation(async (_q, _limit, layers) => {
        if (layers && layers.includes("L3")) return [];
        return [mem("b", "L1", "atom")];
      });
      await recallContext("q", { limit: 6 });
      const specificCall = recallMemories.mock.calls.find((c) => (c[2] ?? []).includes("L1"));
      expect(specificCall?.[1]).toBe(6); // abstract returned nothing, so specifics get it all
    });

    it("honours an explicit layer filter without the two-pass dance", async () => {
      recallMemories.mockResolvedValue([mem("a", "L2", "scenario")]);
      await recallContext("q", { limit: 4, layers: ["L2"] });
      expect(recallMemories).toHaveBeenCalledTimes(1);
      expect(recallMemories.mock.calls[0]?.[2]).toEqual(["L2"]);
    });

    it("prepends pinned memories even when BM25 never ranked them", async () => {
      listMemories.mockResolvedValue([mem("p", "L1", "pinned fact", true)]);
      recallMemories.mockResolvedValue([mem("a", "L1", "relevant")]);
      const hits = await recallContext("q");
      expect(hits[0]?.id).toBe("p");
      expect(hits).toHaveLength(2);
    });

    it("deduplicates a pinned memory that BM25 also returned", async () => {
      listMemories.mockResolvedValue([mem("p", "L1", "same", true)]);
      recallMemories.mockResolvedValue([mem("p", "L1", "same", true)]);
      expect(await recallContext("q")).toHaveLength(1);
    });

    it("returns nothing instead of throwing when recall fails", async () => {
      recallMemories.mockRejectedValue(new Error("fts corrupt"));
      await expect(recallContext("q")).resolves.toEqual([]);
    });
  });

  describe("memoryBlock", () => {
    it("is labeled so the model cannot mistake memory for current input", () => {
      const block = memoryBlock([mem("a", "L1", "Lives in Dhaka")]);
      expect(block).toContain("recalled from memory");
      expect(block).toContain("- [L1] Lives in Dhaka");
    });

    it("is empty when there is nothing to say", () => {
      expect(memoryBlock([])).toBe("");
    });

    it("stops at the budget rather than growing without bound", () => {
      const many = Array.from({ length: 40 }, (_, i) => mem(`m${i}`, "L1", `fact number ${i}`.padEnd(90, ".")));
      const block = memoryBlock(many, 300);
      expect(block.length).toBeLessThanOrEqual(300 + 200);
      expect(block.split("\n").length).toBeLessThan(many.length);
    });

    it("never returns a header with no lines under it", () => {
      const one = mem("a", "L1", "z".repeat(DEFAULT_CONTEXT_BUDGET + 10));
      expect(memoryBlock([one])).toBe("");
    });
  });

  describe("graph integration", () => {
    it("records recalled memories as memory nodes with a recalled edge", async () => {
      const rec = startSession("mem-graph");
      const msg = rec.node("message", "what do you know about me?");
      recordRecall(msg, [mem("a", "L1", "Lives in Dhaka"), mem("b", "L3", "Prefers terse replies")]);
      await rec.flush();

      const [nodes, edges] = recordContext.mock.calls[0]!;
      expect(nodes.filter((n) => n.kind === "memory")).toHaveLength(2);
      expect(edges).toHaveLength(2);
      for (const e of edges) {
        expect(e).toMatchObject({ from_id: msg, kind: "recalled" });
      }
      expect(nodes.find((n) => n.kind === "memory")?.meta_json).toContain('"layer"');
    });

    it("adds no memory node when there was no recall", async () => {
      const rec = startSession("mem-empty");
      const msg = rec.node("message", "hi");
      recordRecall(msg, []);
      await rec.flush();
      const [nodes, edges] = recordContext.mock.calls[0]!;
      expect(nodes.filter((n) => n.kind === "memory")).toHaveLength(0);
      expect(edges).toHaveLength(0);
    });
  });
});
