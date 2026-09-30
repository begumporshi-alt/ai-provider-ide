/**
 * The Activity row must not contradict itself.
 *
 * The live row that prompted this read `✕ NO_ROUTE` in the status column while the routing chain
 * stored beside it named `agnes · key-01 → BAD_REQUEST_SCHEMA`, and closed with `final: — · — → ✓`
 * — a checkmark on a request that had failed. These tests pin the invariant rather than an
 * example, because the original bug was a *branch* that could print `✓` for any failure at all:
 * asserting one specific failed row would have passed against the very code that shipped it.
 */
import { describe, expect, it } from "vitest";
import { finalLine, formatCost, servedLine, statusTitle, wasServed } from "./format";

const ok = { status: "ok", provider: "Agnes", key: "key-01", errorClass: null, httpStatus: null };
const failedUnserved = { status: "error", provider: "—", key: "—", errorClass: "BAD_REQUEST_SCHEMA", httpStatus: 400 };
const failedServed = { status: "error", provider: "Agnes", key: "key-01", errorClass: "NETWORK", httpStatus: null };

describe("the summary agrees with the status column", () => {
  it("never prints a checkmark on a row that did not succeed", () => {
    // The invariant. Every failure shape, including ones nobody has seen yet.
    const classes = ["BAD_REQUEST_SCHEMA", "AUTH_FAILED", "RATE_LIMITED", "SERVER_ERROR", "TIMEOUT", "NETWORK", "PARSE_ERROR", "CANCELLED", null];
    for (const errorClass of classes) {
      for (const httpStatus of [400, 401, 429, 500, null]) {
        for (const provider of ["—", "Agnes"]) {
          const row = { status: "error", provider, key: provider === "—" ? "—" : "key-01", errorClass, httpStatus };
          expect(finalLine(row), `${errorClass} / HTTP ${httpStatus}`).not.toContain("✓");
          expect(finalLine(row)).toContain("✕");
        }
      }
    }
  });

  it("marks a success with a checkmark and names who served", () => {
    expect(finalLine(ok)).toBe("Agnes · key-01 → ✓");
  });

  it("names the class and the upstream status when nothing served", () => {
    // The exact row from the live ledger. `—` was the old output, and a dash is what made the
    // row ambiguous: it did not say whether a provider had been tried.
    expect(finalLine(failedUnserved)).toBe("no provider served → ✕ BAD_REQUEST_SCHEMA (HTTP 400)");
  });

  it("names the provider when it served and then broke", () => {
    // No HTTP status: a mid-stream failure has no status to report, and inventing one would be
    // the same class of mistake in the other direction.
    expect(finalLine(failedServed)).toBe("Agnes · key-01 → ✕ NETWORK");
  });
});

describe("the detail line does not claim a provider served when none did", () => {
  it("says 'not served' for a request that never reached a provider", () => {
    const line = servedLine(failedUnserved, "agnes/agnes-2.5-flash", "agnes/agnes-2.5-flash", "text");
    // `model` falls back to the requested id when nothing served, so echoing it under "served:"
    // was a third way the row asserted something untrue.
    expect(line).toBe("requested: agnes/agnes-2.5-flash → not served (text)");
    expect(line).not.toContain("served:");
  });

  it("names the serving model on a success", () => {
    expect(servedLine(ok, "auto", "gpt-4o", "text")).toBe("requested: auto → served: gpt-4o (text)");
  });
});

describe("wasServed is the distinction the ledger column carries", () => {
  it("is true only for a success or a row with a named provider", () => {
    expect(wasServed(ok)).toBe(true);
    expect(wasServed(failedServed)).toBe(true); // served, then broke
    expect(wasServed(failedUnserved)).toBe(false); // never served
  });
});

describe("status tooltip", () => {
  it("is absent on a success and carries the raw status on a failure", () => {
    expect(statusTitle(ok)).toBeUndefined();
    expect(statusTitle(failedUnserved)).toBe("BAD_REQUEST_SCHEMA · HTTP 400 · no provider served");
    expect(statusTitle(failedServed)).toBe("NETWORK · no HTTP response · served by Agnes before failing");
  });
});

describe("cost formatting", () => {
  it("distinguishes unknown from free", () => {
    // The whole reason the parameter is nullable. `$0.00` for a model whose provider published no
    // price is a claim the ledger cannot support, and it is the wrong direction: it reads as free.
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).toBe("$0.00");
  });

  it("keeps sub-cent amounts visible instead of rounding them to zero", () => {
    // The common case for a short prompt on a cheap model. Two decimals would print `$0.00` —
    // indistinguishable from the free case above, which is what makes six decimals load-bearing.
    expect(formatCost(11)).toBe("$0.000011");
    expect(formatCost(5_000)).toBe("$0.005000");
    // At a cent and above, four decimals is plenty and the extra digits stop being information.
    expect(formatCost(12_345)).toBe("$0.0123");
    expect(formatCost(2_500_000)).toBe("$2.5000");
  });
});
