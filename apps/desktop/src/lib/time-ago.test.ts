import { describe, expect, it } from "vitest";
import { exactTime, timeAgo } from "./time-ago";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const mins = (n: number) => n * 60_000;
const days = (n: number) => n * 86_400_000;

describe("timeAgo", () => {
  it("names the recent past in the largest whole unit", () => {
    expect(timeAgo(NOW - 5_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - mins(5), NOW)).toBe("5m ago");
    expect(timeAgo(NOW - mins(180), NOW)).toBe("3h ago");
    expect(timeAgo(NOW - days(3), NOW)).toBe("3d ago");
    expect(timeAgo(NOW - days(14), NOW)).toBe("2w ago");
  });

  it("falls back to a date beyond a month", () => {
    expect(timeAgo(NOW - days(60), NOW)).toContain("22");
  });

  it("treats a missing or future timestamp honestly", () => {
    expect(timeAgo(0, NOW)).toBe("unknown time");
    expect(timeAgo(Number.NaN, NOW)).toBe("unknown time");
    // A clock-skewed store can carry a future mtime; "just now" is the honest reading.
    expect(timeAgo(NOW + mins(5), NOW)).toBe("just now");
  });
});

describe("exactTime", () => {
  it("carries the full timestamp, and names a missing one", () => {
    expect(exactTime(0)).toBe("unknown time");
    expect(exactTime(NOW)).toContain("2026");
  });
});
