import { describe, it, expect } from "vitest";
import { chargeSessionUsage, emptySessionUsage } from "./session-usage";

const PRICED = { prompt: 300, completion: 600 }; // micro-USD per million tokens

describe("chargeSessionUsage", () => {
  it("sums tokens and rows across turns", () => {
    let u = emptySessionUsage();
    u = chargeSessionUsage(u, { tokensIn: 100, tokensOut: 20, pricing: PRICED });
    u = chargeSessionUsage(u, { tokensIn: 50, tokensOut: 30, pricing: PRICED });
    expect(u).toMatchObject({ rows: 2, unpriced: 0, tokensIn: 150, tokensOut: 50 });
  });

  it("prices a turn from the served model's catalog entry", () => {
    // 1M in × 300 micro-USD/M + 1M out × 600 micro-USD/M = 300 + 600 = 900 micro-USD.
    const u = chargeSessionUsage(emptySessionUsage(), { tokensIn: 1_000_000, tokensOut: 1_000_000, pricing: PRICED });
    expect(u.micros).toBe(900);
  });

  it("counts an unpriced turn as a row with no micros — unknown, not free", () => {
    const u = chargeSessionUsage(emptySessionUsage(), { tokensIn: 100, tokensOut: 20 });
    expect(u).toMatchObject({ micros: 0, rows: 1, unpriced: 1, tokensIn: 100, tokensOut: 20 });
  });

  it("keeps a mixed session's micros a lower bound, per the honesty rules", () => {
    let u = chargeSessionUsage(emptySessionUsage(), { tokensIn: 1_000_000, tokensOut: 0, pricing: PRICED });
    u = chargeSessionUsage(u, { tokensIn: 500, tokensOut: 0 }); // unpriced
    expect(u).toMatchObject({ micros: 300, rows: 2, unpriced: 1, tokensIn: 1_000_500 });
  });

  it("charges a zero-token turn as a row (usage arrived, nothing was billed)", () => {
    const u = chargeSessionUsage(emptySessionUsage(), { tokensIn: 0, tokensOut: 0, pricing: PRICED });
    expect(u).toMatchObject({ micros: 0, rows: 1, unpriced: 0 });
  });
});
