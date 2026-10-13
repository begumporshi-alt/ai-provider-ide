/**
 * `resumeSession` — rows first, graph second (Phase 3, migration 0027).
 *
 * Three claims, and the third is the one that is easy to get wrong:
 *
 * 1. A session recorded since 0027 is restored from `session_messages`, which is the message as it
 *    was sent — including the `tool_calls` / `tool_call_id` pair a provider validates on replay.
 * 2. A session recorded before 0027 (no rows) still resolves, through the graph-derived timeline.
 *    Keeping the fallback is deliberate: a backfill could only invent text the graph never stored.
 * 3. A row whose `tool_calls` is not JSON still yields its message. Dropping the whole message would
 *    lose a turn; inventing `[]` would tell the provider the assistant declared no call, which is a
 *    different and false claim.
 *
 * The transport is mocked at the `invoke` boundary, so the assertions are about the store's own
 * mapping rather than about a hand-rolled fake of it.
 */
import { describe, expect, it, vi } from "vitest";

/** `transcript_list` rows the mock returns; `null` means "no transcript" (the pre-0027 case). */
const h = vi.hoisted(() => ({
  rows: null as unknown,
  timeline: { session_id: "s1", entries: [] as unknown[] },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "transcript_list") {
      if (h.rows === null) throw new Error("no such table: session_messages");
      return h.rows;
    }
    if (cmd === "history_timeline") return h.timeline;
    return undefined;
  },
}));

import { resumeSession } from "./store";

describe("resumeSession", () => {
  it("restores a stored transcript verbatim, tool call and result included", async () => {
    const calls =
      '[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]';
    h.rows = [
      { sessionId: "s1", seq: 1, role: "user", content: "read it", ts: 1 },
      { sessionId: "s1", seq: 2, role: "assistant", content: "", toolCalls: calls, ts: 2 },
      { sessionId: "s1", seq: 3, role: "tool", content: "file body", toolCallId: "call_1", ts: 2 },
    ];

    const out = await resumeSession("s1");
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // The pair, parsed back into the object the wire needs — not the serialized string.
    expect(out[1]!.tool_calls).toEqual(JSON.parse(calls));
    expect(out[2]!.tool_call_id).toBe("call_1");
    expect(out[2]!.content).toBe("file body");
  });

  it("falls back to the graph-derived timeline when the session predates 0027", async () => {
    h.rows = null;
    h.timeline = {
      session_id: "s1",
      entries: [
        { kind: "user", ts: 1, text: "hello", memories: 0 },
        { kind: "assistant", ts: 2, text: "hi there", memories: 0 },
      ],
    };

    const out = await resumeSession("s1");
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("keeps a message whose stored tool_calls is not JSON, without inventing an empty array", async () => {
    h.rows = [
      { sessionId: "s1", seq: 1, role: "assistant", content: "half a call", toolCalls: "{not json", ts: 1 },
    ];

    const out = await resumeSession("s1");
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("half a call");
    // Absent, not `[]`: "the transcript lost this" and "the assistant made no call" are different
    // claims, and only one of them is true here.
    expect(out[0]!.tool_calls).toBeUndefined();
  });
});
