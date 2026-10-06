/**
 * Compare-lane runner tests (2026-10-06) — node env, fake generate, no Tauri.
 */
import { describe, expect, it, vi } from "vitest";
import { runCompareLane, type LaneState } from "./lane";
import type { GatewayExec, GatewayGenerateRequest } from "../gateway-turn";

function fakeExec(chunks: string[], opts: { usage?: { prompt_tokens: number; completion_tokens: number }; served?: Partial<import("../gateway-turn").ServedBy> } = {}): GatewayExec {
  return {
    chunks: (async function* () {
      for (const c of chunks) yield c;
    })(),
    reasoning: () => "",
    served: () => opts.served,
  };
}

describe("runCompareLane", () => {
  it("streams the answer, emits on every chunk, and ends done with latencies", async () => {
    const updates: LaneState[] = [];
    const generate = vi.fn(async (req: GatewayGenerateRequest) => {
      req.onUsage?.({ prompt_tokens: 11, completion_tokens: 7 });
      return fakeExec(["hel", "lo"]);
    });

    const out = await runCompareLane({
      model: "sysai/m1",
      prompt: "hi",
      generate: generate as unknown as Parameters<typeof runCompareLane>[0]["generate"],
      onUpdate: (s) => updates.push(s),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    const sent = (generate.mock.calls[0]![0] as GatewayGenerateRequest).messages;
    expect(sent).toEqual([{ role: "user", content: "hi" }]);
    expect(out.status).toBe("done");
    expect(out.text).toBe("hello");
    expect(out.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7 });
    expect(out.totalMs).not.toBeNull();
    expect(out.firstByteMs).not.toBeNull();
    // One emission per observable event — the usage callback here, then each chunk, then the
    // final settle in `finally`.
    expect(updates.map((u) => u.text)).toEqual(["", "hel", "hello", "hello"]);
  });

  it("carries served_by attribution through", async () => {
    const out = await runCompareLane({
      model: "m",
      prompt: "hi",
      generate: async () => fakeExec(["ok"], { served: { provider: "p1", model: "m1", key: "k1" } }),
    });
    expect(out.served).toEqual({ provider: "p1", model: "m1", key: "k1" });
  });

  it("surfaces a serving failure as an error lane, never a thrown promise", async () => {
    const out = await runCompareLane({
      model: "m",
      prompt: "hi",
      generate: async () => {
        throw new Error("gateway is stopped");
      },
    });
    expect(out.status).toBe("error");
    expect(out.error).toBe("gateway is stopped");
    expect(out.totalMs).not.toBeNull();
  });

  it("keeps partial text and marks the lane stopped when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const out = await runCompareLane({
      model: "m",
      prompt: "hi",
      generate: async () => ({
        chunks: (async function* () {
          yield "par";
          controller.abort();
          yield "tial";
        })(),
        reasoning: () => "",
        served: () => undefined,
      }),
      signal: controller.signal,
    });
    expect(out.status).toBe("stopped");
    expect(out.text).toBe("par");
  });
});
