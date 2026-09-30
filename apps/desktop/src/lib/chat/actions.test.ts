import { describe, expect, it } from "vitest";
import { editPoint, retryPoint, type Turn } from "./actions";

const u = (content: string): Turn => ({ role: "user", content });
const a = (content: string): Turn => ({ role: "assistant", content });
const t = (content: string): Turn => ({ role: "tool", content });

describe("retryPoint", () => {
  it("returns the prompt and the history before it for a plain turn", () => {
    const msgs = [u("first"), a("answer one"), u("second"), a("answer two")];
    expect(retryPoint(msgs, 3)).toEqual({
      text: "second",
      prefix: [u("first"), a("answer one")],
    });
  });

  it("excludes the retried user turn from the prefix (runTurn re-appends it)", () => {
    const msgs = [u("only"), a("reply")];
    const point = retryPoint(msgs, 1)!;
    expect(point.text).toBe("only");
    expect(point.prefix).toEqual([]);
  });

  it("skips tool results and picks the nearest user turn above them", () => {
    // Agent shape: user, assistant(tool_calls), tool, tool, assistant(final)
    const msgs = [u("do it"), a(""), t("result a"), t("result b"), a("done")];
    expect(retryPoint(msgs, 4)).toEqual({ text: "do it", prefix: [] });
  });

  it("returns null when there is no user turn before the index", () => {
    expect(retryPoint([a("orphan")], 1)).toBeNull();
    expect(retryPoint([], 0)).toBeNull();
  });
});

describe("editPoint", () => {
  it("keeps everything strictly before the edited user turn", () => {
    const msgs = [u("one"), a("a1"), u("two"), a("a2")];
    expect(editPoint(msgs, 2)).toEqual([u("one"), a("a1")]);
  });

  it("is empty when the first turn is edited", () => {
    expect(editPoint([u("one"), a("a1")], 0)).toEqual([]);
  });
});
