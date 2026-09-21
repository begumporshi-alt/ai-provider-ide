/**
 * Capture-queue drain (§3.3). Pins the three properties the queue promises:
 *   - a row is completed only after its atoms are stored, and released when the call fails
 *   - a row is never distilled twice, and never dropped on the floor by a crash
 *   - nothing the drain writes is auto-scoped — binding stays a deliberate act
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../../store";
import { drainOnce, resetDrain, startCaptureDrain, stopCaptureDrain } from "./drain";

const claim = vi.spyOn(store, "captureClaim");
const complete = vi.spyOn(store, "captureComplete");
const release = vi.spyOn(store, "captureRelease");
const requeue = vi.spyOn(store, "captureRequeueStale");
const purge = vi.spyOn(store, "capturePurgeFinished");
const captureMemories = vi.spyOn(store, "captureMemories");
const sessionMemories = vi.spyOn(store, "sessionMemories");
const assignScope = vi.spyOn(store, "assignMemoryScope");

function row(over: Partial<store.PendingRow> = {}): store.PendingRow {
  return {
    id: 1,
    session_id: "s-1",
    scope_user: "local",
    scope_project: "p1",
    scope_agent: "cursor",
    content_class: "fact",
    user_text: "we settled on Postgres for the store",
    asst_text: "Understood — Postgres it is.",
    model: null,
    attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  resetDrain();
  vi.clearAllMocks();
  claim.mockResolvedValue([]);
  complete.mockResolvedValue(true);
  release.mockResolvedValue(true);
  requeue.mockResolvedValue(0);
  purge.mockResolvedValue(0);
  captureMemories.mockResolvedValue(1);
  sessionMemories.mockResolvedValue([]);
});

afterEach(() => {
  stopCaptureDrain();
});

describe("drainOnce", () => {
  it("distils a claimed batch and completes every row", async () => {
    claim.mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);
    const generate = vi.fn().mockResolvedValue('["Uses Postgres"]');
    const r = await drainOnce("openai/gpt-4o", { generate });

    expect(r.claimed).toBe(2);
    expect(r.distilled).toBe(2);
    expect(r.released).toBe(0);
    expect(r.atoms).toBe(2);
    expect(complete).toHaveBeenCalledWith(1);
    expect(complete).toHaveBeenCalledWith(2);
    expect(release).not.toHaveBeenCalled();
  });

  it("prompts with the exchange the host stored, not a window of its own", async () => {
    claim.mockResolvedValue([row({ user_text: "postgres it is", asst_text: "agreed" })]);
    const generate = vi.fn().mockResolvedValue('["Uses Postgres"]');
    await drainOnce("openai/gpt-4o", { generate });
    const prompt = generate.mock.calls[0]![1] as string;
    expect(prompt).toContain("postgres it is");
    expect(prompt).toContain("agreed");
  });

  it("gives a row back instead of completing it when the call fails", async () => {
    claim.mockResolvedValue([row({ id: 7 })]);
    const generate = vi.fn().mockRejectedValue(new Error("upstream 500"));
    const r = await drainOnce("openai/gpt-4o", { generate });

    expect(r.distilled).toBe(0);
    expect(r.released).toBe(1);
    expect(release).toHaveBeenCalledWith(7);
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes a row that distilled into nothing durable", async () => {
    claim.mockResolvedValue([row({ id: 3 })]);
    const generate = vi.fn().mockResolvedValue("[]");
    const r = await drainOnce("openai/gpt-4o", { generate });
    expect(r.distilled).toBe(1);
    expect(r.atoms).toBe(0);
    expect(complete).toHaveBeenCalledWith(3);
  });

  it("claims nothing when no model is configured, so attempts are not burned", async () => {
    const generate = vi.fn();
    const r = await drainOnce(null, { generate });
    expect(r.skipped).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not run two passes at once", async () => {
    claim.mockResolvedValue([row()]);
    const generate = vi.fn().mockResolvedValue("[]");
    const [first, second] = await Promise.all([
      drainOnce("openai/gpt-4o", { generate }),
      drainOnce("openai/gpt-4o", { generate }),
    ]);
    expect(first.claimed).toBe(1);
    expect(second.skipped).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("recovers rows stranded by an interrupted batch before claiming", async () => {
    requeue.mockResolvedValue(2);
    claim.mockResolvedValue([row()]);
    const generate = vi.fn().mockResolvedValue("[]");
    const r = await drainOnce("openai/gpt-4o", { generate });
    expect(r.requeued).toBe(2);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("prefers the model that served the request over the configured one", async () => {
    claim.mockResolvedValue([row({ model: "anthropic/claude" })]);
    const generate = vi.fn().mockResolvedValue("[]");
    await drainOnce("openai/gpt-4o", { generate });
    expect(generate.mock.calls[0]![0]).toBe("anthropic/claude");
  });

  it("writes atoms under the row's session, capture-only", async () => {
    claim.mockResolvedValue([row({ session_id: "s-42" })]);
    const generate = vi.fn().mockResolvedValue('["Uses Postgres"]');
    await drainOnce("openai/gpt-4o", { generate });

    expect(captureMemories).toHaveBeenCalledTimes(1);
    const items = captureMemories.mock.calls[0]![0];
    expect(items[0]).toMatchObject({ layer: "L1", text: "Uses Postgres", session_id: "s-42" });
    // The row carries a project scope, and the drain must not apply it: an atom becomes injectable
    // only when someone scopes it on purpose (§4b).
    expect(assignScope).not.toHaveBeenCalled();
  });

  it("survives a host that refuses the whole batch", async () => {
    claim.mockRejectedValue(new Error("db locked"));
    const r = await drainOnce("openai/gpt-4o", { generate: vi.fn() });
    expect(r.claimed).toBe(0);
  });
});

describe("startCaptureDrain", () => {
  it("polls on an interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      claim.mockResolvedValue([]);
      startCaptureDrain(() => "openai/gpt-4o", 1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(claim).toHaveBeenCalledTimes(4);

      stopCaptureDrain();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(claim).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent, so a remount cannot double the polling", () => {
    vi.useFakeTimers();
    try {
      claim.mockResolvedValue([]);
      startCaptureDrain(() => "openai/gpt-4o", 1_000);
      startCaptureDrain(() => "openai/gpt-4o", 1_000);
      stopCaptureDrain();
      expect(purge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
