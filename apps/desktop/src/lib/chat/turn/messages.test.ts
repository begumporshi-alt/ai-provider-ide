import { describe, it, expect } from "vitest";
import { newMsgId, replayHistory, withIds, type Msg } from "./messages";
import type { Attachment } from "../../../components/Composer";

const image: Attachment = { id: "att-1", name: "shot.png", mediaType: "image/png", dataBase64: "aGVsbG8=", bytes: 5 };

const user = (content: string, extra: Partial<Msg> = {}): Msg => ({ id: newMsgId(), role: "user", content, ...extra });
const assistant = (content: string, extra: Partial<Msg> = {}): Msg => ({ id: newMsgId(), role: "assistant", content, ...extra });

describe("replayHistory", () => {
  it("keeps tool_calls and tool_call_id across the replay (the 400-fix invariant)", () => {
    const msgs = [
      user("run ls"),
      assistant("", { tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] }),
      { id: newMsgId(), role: "tool" as const, content: "alpha.txt", tool_call_id: "call_1" },
      assistant("here is the listing"),
    ];
    const out = replayHistory(msgs);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(out[1]).toHaveProperty("tool_calls");
    expect(out[2]).toMatchObject({ tool_call_id: "call_1", content: "alpha.txt" });
  });

  it("drops the empty assistant bubble a stopped turn leaves behind", () => {
    const msgs = [user("hi"), assistant("")];
    expect(replayHistory(msgs).map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps an image-only turn (attachments make it non-empty even with no text)", () => {
    const msgs = [user("", { attachments: [image] })];
    const out = replayHistory(msgs);
    expect(out).toHaveLength(1);
    // The image travels as content parts, not as a string.
    expect(Array.isArray(out[0]!.content)).toBe(true);
  });

  it("rebuilds an ordinary turn as a plain string, not parts", () => {
    const out = replayHistory([user("plain text")]);
    expect(out[0]!.content).toBe("plain text");
  });

  it("keeps the reasoning-less assistant turn with tool_calls even when content is empty", () => {
    const msgs = [assistant("", { tool_calls: [{ id: "c", type: "function", function: { name: "ls", arguments: "{}" } }] })];
    expect(replayHistory(msgs)).toHaveLength(1);
  });
});

describe("withIds", () => {
  it("mints ids for resumed turns and keeps minting monotonically after", () => {
    const resumed = withIds([{ role: "user", content: "old" } as Omit<Msg, "id">]);
    expect(resumed[0]!.id).toBeTruthy();
    expect(newMsgId()).not.toBe(resumed[0]!.id);
  });
});
