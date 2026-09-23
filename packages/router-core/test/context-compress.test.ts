/**
 * Auto context compression.
 *
 * The three properties here are the ones that make truncation *safe* rather than merely
 * smaller. A compression that fits the budget but drops the system prompt, or answers a
 * question the user never asked, or hands a provider a tool result whose originating call is
 * gone, is worse than the overflow it was meant to prevent — and the third one fails as a 400
 * from the provider rather than as anything visible here.
 *
 * So each of those is pinned directly, and the tool-pairing one is checked across *every*
 * budget rather than one hand-picked value, because a bug that only fires at one size is
 * exactly the kind a single case misses.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/ports.js";
import { compressMessages, estimateTokens, promptBudget } from "../src/context-compress.js";

const msg = (
  role: ChatMessage["role"],
  content: string,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({ role, content, ...extra });

/** A message of roughly `n` tokens, so a budget can be expressed in the same units. */
const sized = (role: ChatMessage["role"], tokens: number): ChatMessage =>
  msg(role, "x".repeat(Math.max(0, tokens * 4)));

describe("promptBudget", () => {
  it("reserves a declared maxTokens rather than a guessed fraction", () => {
    expect(promptBudget(100_000, 4_000)).toBe(96_000);
  });

  it("falls back to a share of the window when the caller declared none", () => {
    expect(promptBudget(100_000)).toBe(75_000);
  });

  it("never goes negative — a window smaller than its own reserve floors at zero", () => {
    expect(promptBudget(1_000, 5_000)).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("counts a multimodal content array rather than reading it as empty", () => {
    const array = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    } as unknown as ChatMessage;
    expect(estimateTokens([array])).toBeGreaterThan(estimateTokens([msg("user", "")]));
  });

  it("tolerates a message with no content at all", () => {
    expect(estimateTokens([{ role: "assistant" } as unknown as ChatMessage])).toBeGreaterThan(0);
  });
});

describe("compressMessages", () => {
  it("returns the messages untouched when they already fit", () => {
    const all = [msg("system", "sys"), msg("user", "hi")];
    const r = compressMessages(all, estimateTokens(all));
    expect(r.compressed).toBe(false);
    expect(r.dropped).toBe(0);
    expect(r.messages).toEqual(all);
  });

  it("handles an empty array", () => {
    const r = compressMessages([], 10);
    expect(r.messages).toEqual([]);
    expect(r.compressed).toBe(false);
  });

  it("handles a single message — there is no older turn to drop", () => {
    const r = compressMessages([msg("user", "only")], 1);
    expect(r.compressed).toBe(false);
    expect(r.messages).toEqual([msg("user", "only")]);
  });

  it("does not mutate the caller's array", () => {
    const input = [msg("system", "sys"), msg("user", "old"), msg("user", "new")];
    const copy = [...input];
    compressMessages(input, 1);
    expect(input).toEqual(copy);
  });

  it("keeps the system turn — dropping it changes what the model is asked to do", () => {
    const system = msg("system", "you are a careful assistant");
    const r = compressMessages([system, msg("user", "old"), msg("user", "new")], 1);
    expect(r.messages[0]).toEqual(system);
  });

  it("drops the oldest turn first and stops as soon as the prompt fits", () => {
    const system = msg("system", "sys");
    const oldQ = msg("user", "old question");
    const oldA = msg("assistant", "old answer");
    const newQ = msg("user", "new question");
    // Exactly what is left after the oldest turn goes.
    const budget = estimateTokens([system, newQ]);

    const r = compressMessages([system, oldQ, oldA, newQ], budget);
    expect(r.compressed).toBe(true);
    expect(r.messages).toEqual([system, newQ]);
    expect(r.dropped).toBe(2);
    expect(r.afterTokens).toBeLessThanOrEqual(budget);
  });

  it("keeps the newest turn even when it alone exceeds the budget", () => {
    // Dropping it would answer a question the user did not ask, which is worse than overflow.
    const system = msg("system", "sys");
    const newest = sized("user", 5_000);
    const r = compressMessages([system, msg("user", "old"), newest], 1);
    expect(r.messages).toEqual([system, newest]);
  });

  it("never strips a system-only request — there is no turn to drop", () => {
    const onlySystem = [sized("system", 4_000)];
    const r = compressMessages(onlySystem, 1);
    expect(r.compressed).toBe(false);
    expect(r.messages).toEqual(onlySystem);
  });

  it("never leaves a tool result orphaned from its call, at any budget", () => {
    const convo: ChatMessage[] = [
      msg("system", "sys"),
      msg("user", "q1"),
      msg("assistant", "", { tool_calls: [{ id: "c1", name: "read" }] }),
      msg("tool", "r1", { tool_call_id: "c1" }),
      msg("user", "q2"),
      msg("assistant", "", { tool_calls: [{ id: "c2", name: "write" }] }),
      msg("tool", "r2", { tool_call_id: "c2" }),
      msg("user", "q3"),
    ];

    for (let budget = 0; budget <= estimateTokens(convo) + 20; budget += 1) {
      const r = compressMessages(convo, budget);
      const called = new Set<string>();
      for (const m of r.messages) {
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls as Array<{ id?: string }>) {
            if (c?.id) called.add(c.id);
          }
        }
      }
      for (const m of r.messages) {
        if (m.role === "tool") expect(called.has(m.tool_call_id ?? "")).toBe(true);
      }
      // The newest turn survives at every budget too.
      expect(r.messages[r.messages.length - 1]?.content).toBe("q3");
    }
  });

  it("drops an assistant tool-call turn and its results as one unit", () => {
    const system = msg("system", "sys");
    const oldQ = msg("user", "q1");
    const call = msg("assistant", "", { tool_calls: [{ id: "c1" }] });
    const result = msg("tool", "r1", { tool_call_id: "c1" });
    const newQ = msg("user", "q2");

    const budget = estimateTokens([system, newQ]);
    const r = compressMessages([system, oldQ, call, result, newQ], budget);
    // The call and its result went together: neither is present, and the newest turn is.
    expect(r.messages).toEqual([system, newQ]);
  });

  it("reports the budget it was given, and what compression achieved", () => {
    const all = [msg("user", "a"), msg("user", "b")];
    const r = compressMessages(all, 5);
    expect(r.budget).toBe(5);
    expect(r.beforeTokens).toBe(estimateTokens(all));
    expect(r.afterTokens).toBe(estimateTokens(r.messages));
    expect(r.afterTokens).toBeLessThanOrEqual(r.budget);
  });
});
