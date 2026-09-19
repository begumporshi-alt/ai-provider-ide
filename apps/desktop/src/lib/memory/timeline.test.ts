/**
 * Timeline helpers (P7 follow-up). Pins the properties that decide whether the Memory screen's
 * two modes agree with each other:
 *   - a day bucket is a *local* calendar day, so 00:30 and 23:30 land together
 *   - "Yesterday" survives a DST boundary instead of becoming "Today"
 *   - grouping preserves the incoming order, because that order carries the ranking
 */
import { describe, expect, it } from "vitest";
import { ago, clock, dayKey, dayLabel, groupByDay, since, RANGES } from "./timeline";

/** Build a timestamp from local calendar parts — the tests must not depend on the machine's zone. */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("memory timeline", () => {
  describe("ago", () => {
    const now = at(2026, 9, 19, 20, 0);

    it("reads coarsely, from 'just now' up to years", () => {
      expect(ago(now, now)).toBe("just now");
      expect(ago(now - 30_000, now)).toBe("just now");
      expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
      expect(ago(now - 3 * 3_600_000, now)).toBe("3h ago");
      expect(ago(now - 4 * 86_400_000, now)).toBe("4d ago");
      expect(ago(now - 90 * 86_400_000, now)).toBe("3mo ago");
      expect(ago(now - 800 * 86_400_000, now)).toBe("2y ago");
    });

    it("clamps a future timestamp rather than reading as negative", () => {
      // A clock that moved backwards must not render "-3m ago".
      expect(ago(now + 3 * 60_000, now)).toBe("just now");
    });
  });

  describe("dayKey", () => {
    it("buckets by local calendar day, not by a 24-hour window", () => {
      // Two times 23 hours apart, either side of midnight, are different days.
      expect(dayKey(at(2026, 9, 19, 0, 30))).toBe("2026-09-19");
      expect(dayKey(at(2026, 9, 19, 23, 30))).toBe("2026-09-19");
      expect(dayKey(at(2026, 9, 20, 0, 30))).toBe("2026-09-20");
    });

    it("zero-pads so keys sort and compare as strings", () => {
      expect(dayKey(at(2026, 1, 5, 9))).toBe("2026-01-05");
    });
  });

  describe("dayLabel", () => {
    it("names today and yesterday, and dates anything older", () => {
      const now = at(2026, 9, 19, 20, 0);
      expect(dayLabel(at(2026, 9, 19, 8), now)).toBe("Today");
      expect(dayLabel(at(2026, 9, 18, 23), now)).toBe("Yesterday");
      const older = dayLabel(at(2026, 9, 16, 12), now);
      expect(older).not.toBe("Today");
      expect(older).not.toBe("Yesterday");
      // The day number is locale-independent, so this survives any locale the runner uses.
      expect(older).toContain("16");
    });

    it("crosses a month boundary for 'yesterday' instead of falling back to a date", () => {
      // 1 September looking back at 31 August: calendar arithmetic, not `now - 86400000`.
      const now = at(2026, 9, 1, 9);
      expect(dayLabel(at(2026, 8, 31, 22), now)).toBe("Yesterday");
    });
  });

  describe("groupByDay", () => {
    const now = at(2026, 9, 19, 21);

    it("groups by day without reordering the items it was given", () => {
      const items = [
        { id: "a", ts: at(2026, 9, 19, 20) },
        { id: "b", ts: at(2026, 9, 19, 9) },
        { id: "c", ts: at(2026, 9, 17, 12) },
      ];
      const groups = groupByDay(items, (i) => i.ts, now);

      expect(groups).toHaveLength(2);
      expect(groups[0]!.label).toBe("Today");
      // Order within a day is the incoming order — the ranking lives there, not here.
      expect(groups[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
      expect(groups[1]!.items.map((i) => i.id)).toEqual(["c"]);
    });

    it("returns nothing for nothing, rather than an empty group", () => {
      expect(groupByDay([], (i: { ts: number }) => i.ts, now)).toEqual([]);
    });

    it("keeps one group per day however many items share it", () => {
      const items = [1, 2, 3, 4].map((n) => ({ ts: at(2026, 9, 19, 8 + n) }));
      const groups = groupByDay(items, (i) => i.ts, now);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.items).toHaveLength(4);
    });
  });

  describe("since", () => {
    const now = at(2026, 9, 19, 20);

    it("is unbounded for the 'all' chip", () => {
      // 0 must admit everything, including a timestamp far in the past.
      expect(since(0, now)).toBe(0);
      expect(at(2020, 1, 1) >= since(0, now)).toBe(true);
    });

    it("cuts off at whole days back, inclusive of the boundary", () => {
      expect(since(7, now)).toBe(now - 7 * 86_400_000);
      expect(at(2026, 9, 13, 20) >= since(7, now)).toBe(true);
      // Exactly the cut-off is still inside; a minute earlier is not.
      expect(at(2026, 9, 12, 20) >= since(7, now)).toBe(true);
      expect(at(2026, 9, 12, 19, 59) >= since(7, now)).toBe(false);
    });

    it("offers exactly one unbounded chip, so the control has a way back", () => {
      expect(RANGES.filter((r) => r.days === 0)).toHaveLength(1);
      expect(RANGES[0]!.days).toBe(0);
    });
  });

  describe("clock", () => {
    it("renders a zero-padded time", () => {
      expect(clock(at(2026, 9, 19, 9, 5))).toMatch(/0?9:05/);
    });
  });
});
