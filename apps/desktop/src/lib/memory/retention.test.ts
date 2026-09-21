/**
 * Idle retention (§6.2). Pins the two properties the scheduler is responsible for:
 *   - both tables are pruned, and a pass never overlaps another
 *   - with memory off host-side nothing is touched at all
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../../store";
import { pruneOnce, resetRetention, startRetention, stopRetention } from "./retention";

const enabled = vi.spyOn(store, "gatewayMemoryEnabled");
const memories = vi.spyOn(store, "pruneMemories");
const live = vi.spyOn(store, "pruneLiveContext");

const NO_MEMORY = { l0_expired: 0, l0_ring: 0, decayed: 0 };
const NO_LIVE = { turns_by_count: 0, turns_by_age: 0, sessions_reaped: 0 };

beforeEach(() => {
  resetRetention();
  vi.clearAllMocks();
  enabled.mockResolvedValue(true);
  memories.mockResolvedValue(NO_MEMORY);
  live.mockResolvedValue(NO_LIVE);
});

afterEach(() => {
  stopRetention();
  vi.useRealTimers();
});

describe("pruneOnce", () => {
  it("prunes both tables and reports what each removed", async () => {
    memories.mockResolvedValue({ l0_expired: 3, l0_ring: 5, decayed: 2 });
    live.mockResolvedValue({ turns_by_count: 7, turns_by_age: 1, sessions_reaped: 4 });
    const r = await pruneOnce();
    expect(r.skipped).toBe(false);
    expect(r.memories).toEqual({ l0_expired: 3, l0_ring: 5, decayed: 2 });
    expect(r.live).toEqual({ turns_by_count: 7, turns_by_age: 1, sessions_reaped: 4 });
    expect(memories).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("touches nothing when memory is off", async () => {
    enabled.mockResolvedValue(false);
    const r = await pruneOnce();
    expect(r.skipped).toBe(true);
    expect(memories).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });

  /**
   * The off-by-default guarantee includes deletes. A user who never switched memory on must not
   * have rows removed because a toggle read failed open — so an error reads as "off".
   */
  it("treats a failed toggle read as off rather than pruning anyway", async () => {
    enabled.mockRejectedValue(new Error("ipc down"));
    const r = await pruneOnce();
    expect(r.skipped).toBe(true);
    expect(memories).not.toHaveBeenCalled();
  });

  it("does not run a second pass on top of a running one", async () => {
    let release: (v: store.MemoryPruneStats) => void = () => undefined;
    memories.mockImplementation(
      () => new Promise<store.MemoryPruneStats>((res) => (release = res)),
    );
    const first = pruneOnce();
    const second = await pruneOnce();
    expect(second.skipped, "a prune is a table scan; two at once would fight").toBe(true);
    // The first pass only reaches `pruneMemories` after the toggle read settles, so wait for the
    // call before releasing it — otherwise `release` is still the no-op it was initialised to.
    await vi.waitFor(() => expect(memories).toHaveBeenCalledTimes(1));
    release(NO_MEMORY);
    await first;
    expect(memories).toHaveBeenCalledTimes(1);
  });
});

describe("startRetention", () => {
  it("runs once immediately and then on the interval", async () => {
    vi.useFakeTimers();
    startRetention(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(memories).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(memories).toHaveBeenCalledTimes(2);
    stopRetention();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(memories, "stopping clears the timer").toHaveBeenCalledTimes(2);
  });

  it("is idempotent — a second start does not add a second timer", async () => {
    vi.useFakeTimers();
    startRetention(1_000);
    startRetention(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    // Once at start, once on the tick — a second timer would make it three or more.
    expect(memories).toHaveBeenCalledTimes(2);
    stopRetention();
  });
});
