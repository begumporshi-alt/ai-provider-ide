/**
 * A parts array SERIALIZED INTO the content string, not as one.
 *
 * Measured bug (2026-10-07 → 2026-10-10): the provider `vice` (vyceai.com) intermittently answers
 * with its own wire format as the answer, so `choices[0].message.content` is the *string*
 * `[{"text":"…","type":"text"}]` — escaped newlines and all — and the transcript showed JSON
 * instead of prose. 5 of that provider's 59 recorded replies; 0 of 463 from `agent-router` and
 * 0 of 173 from `agnes`, the same model family behind different providers.
 *
 * Three facts said the string came from upstream rather than from anything in this repo: one
 * instance is **invalid JSON** (the model left a quote unescaped inside its own text), one is
 * pretty-printed with raw newlines, and the key order is `text` before `type` while every array
 * this app builds is `type` first. `JSON.stringify` cannot emit any of those.
 *
 * The Rust mirror is `interpreter.rs::decode_serialized_parts`, which is where the Assistant's own
 * path reads it. This one covers the declarative engine, still live for probes and onboarding.
 */
import { describe, expect, it } from "vitest";
import { decodeSerializedParts } from "../src/manifest-interpreter.js";

describe("decodeSerializedParts", () => {
  it("recovers a well-formed parts array serialized into a string", () => {
    expect(decodeSerializedParts('[{"text":"Hello there","type":"text"}]')).toBe("Hello there");
  });

  /**
   * The instance that prompted the fix, byte for byte — including the unescaped quote that makes it
   * invalid JSON. A `JSON.parse`-only version passes the test above and fails this one, which is
   * exactly how a fix can look right and leave the reported message on screen.
   */
  it("recovers the malformed instance, including the text past the stray quote", () => {
    const raw =
      '[{"text":"Excellent! Building a 3D world is doable.\\n\\n## The Silent Earth\\n\\n' +
      'Since we\'re exploring a world without humans, I\'ll create a post-human Earth ecosystem.\\n\\n' +
      '- Natural growth/regeneration systems"is this direction you want?", "type":"text"}]';
    const out = decodeSerializedParts(raw);
    expect(out).toBeDefined();
    expect(out!.startsWith("Excellent! Building a 3D world is doable.")).toBe(true);
    // NOT cut at the stray quote — the reason the closing quote is found from the right.
    expect(out!.includes('regeneration systems"is this direction you want?')).toBe(true);
    expect(out!.includes('"type"')).toBe(false);
    // Escaped newlines became real ones.
    expect(out!.includes("\n")).toBe(true);
    expect(out!.includes("\\n")).toBe(false);
  });

  it("recovers a pretty-printed array — raw newlines, which no serializer here emits", () => {
    expect(decodeSerializedParts('[{\n  "text": "Absolutely!",\n  "type": "text"\n}]')).toBe(
      "Absolutely!",
    );
  });

  it("accepts `type` first, the order this app's own arrays use", () => {
    expect(decodeSerializedParts('[{"type":"text","text":"type-first works"}]')).toBe(
      "type-first works",
    );
  });

  /**
   * The guard: prose, and JSON a user actually asked for, must pass through untouched. A `text`
   * field plus anything else is somebody's data, not a wrapper.
   */
  it("leaves everything that is not a parts wrapper alone", () => {
    for (const raw of [
      "Just prose. No JSON here.",
      "A list: [1, 2, 3]",
      '[{"id":1,"text":"a user\'s own JSON"}]',
      '[{"text":"no type, but an extra key","id":7}]',
      '[{"type":"image","text":"not a text block"}]',
      '[{"text":"unterminated"',
      "[]",
      "",
    ]) {
      expect(decodeSerializedParts(raw), `must not rewrite: ${raw}`).toBeUndefined();
    }
  });
});
