import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWaitingNotice } from "./waiting";

describe("startWaitingNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("stays silent before the first delay", () => {
    const paint = vi.fn();
    const stop = startWaitingNotice(paint, "deepseek-v4-flash", {
      afterMs: 10_000,
      everyMs: 5_000,
    });
    vi.advanceTimersByTime(9_999);
    expect(paint).not.toHaveBeenCalled();
    stop();
  });

  it("paints, then updates the elapsed count", () => {
    const paint = vi.fn();
    const stop = startWaitingNotice(paint, "deepseek-v4-flash", {
      afterMs: 10_000,
      everyMs: 5_000,
    });

    vi.advanceTimersByTime(10_000);
    expect(paint).toHaveBeenLastCalledWith("Still waiting on deepseek-v4-flash (10s)…");

    vi.advanceTimersByTime(5_000);
    expect(paint).toHaveBeenLastCalledWith("Still waiting on deepseek-v4-flash (15s)…");
    stop();
  });

  it("stops painting once stopped, and stopping twice is harmless", () => {
    const paint = vi.fn();
    const stop = startWaitingNotice(paint, "m", { afterMs: 1_000, everyMs: 1_000 });
    vi.advanceTimersByTime(2_000);
    const calls = paint.mock.calls.length;

    stop();
    stop();
    vi.advanceTimersByTime(10_000);
    expect(paint).toHaveBeenCalledTimes(calls);
  });
});
