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

  it("carries the retried prompt's attachments back to the caller", () => {
    // A vision turn retried without its images is a question the model can no longer see
    // (measured 2026-10-05 — regenerate dropped the images).
    const image = { mediaType: "image/png", dataBase64: "aGVsbG8=" };
    const msgs: (Turn & { attachments?: { mediaType: string; dataBase64: string }[] })[] = [
      u("text only"),
      a("ok"),
      { role: "user", content: "what is in this picture?", attachments: [image] },
      a("a red square"),
    ];
    const point = retryPoint(msgs, 3)!;
    expect(point.text).toBe("what is in this picture?");
    expect(point.attachments).toEqual([image]);
  });

  it("carries undefined attachments for a plain turn (no images to re-send)", () => {
    const point = retryPoint([u("plain"), a("reply")], 1)!;
    expect(point.attachments).toBeUndefined();
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
