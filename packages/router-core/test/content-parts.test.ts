/**
 * Content parts: what an image is worth to the router, and how it becomes a dialect's wire shape.
 *
 * Two failure modes are worth pinning here, because both are silent:
 *
 *   1. **An image measured as its base64.** The compressor decides what conversation to drop from
 *      `estimateTokens`, so counting a 100 KB picture as ~25 000 tokens makes it discard real turns
 *      to make room for a file that costs the model a few hundred. The first test is that guard.
 *   2. **A dialect shape that is almost right.** `{type:"image_url", url}` and
 *      `{type:"image_url", image_url:{url}}` differ by one nesting level and only the second works;
 *      assertions here are on the rendered body fragment, not on the template.
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_PLACEHOLDER,
  countImageParts,
  renderContentParts,
  shapeMessageContent,
  textOfContent,
  userContent,
} from "../src/content-parts.js";
import { renderTemplate } from "../src/template.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import type { ContentPart } from "../src/ports.js";

/** 1×1 PNG, the smallest real image that exists. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("textOfContent is the router's own flattening", () => {
  it("passes a plain string through", () => {
    expect(textOfContent("hello")).toBe("hello");
    expect(textOfContent("")).toBe("");
    expect(textOfContent(undefined)).toBe("");
    expect(textOfContent(null)).toBe("");
  });

  it("counts an image as a marker, never as its bytes", () => {
    // The load-bearing one. If this ever returns the base64, `estimateTokens` reports tens of
    // thousands of tokens for one picture and the compressor starts dropping conversation.
    const parts: ContentPart[] = [
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", dataBase64: PNG },
    ];
    const text = textOfContent(parts);
    expect(text).toContain("what is this?");
    expect(text).toContain(IMAGE_PLACEHOLDER);
    expect(text).not.toContain(PNG);
    // Order of magnitude, not an exact number: a sentence and a marker is a handful of tokens.
    expect(text.length).toBeLessThan(64);
  });

  it("counts a dialect-shaped image part as an image too", () => {
    // A gateway client forwards its own JSON verbatim, so the array may arrive already in OpenAI
    // (`image_url`) or Anthropic-ish form. Those carry no bare base64 under `data`, but they do
    // carry it under `url`/`source`, and none of it may reach the estimator.
    const openai = [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }];
    expect(textOfContent(openai)).toBe(IMAGE_PLACEHOLDER);
    const anthropic = [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }];
    expect(textOfContent(anthropic)).toBe(IMAGE_PLACEHOLDER);
    const gemini = [{ inlineData: { mimeType: "image/png", data: PNG } }];
    // Unrecognised shape: measured rather than dropped. An unknown part that flattened to "" would
    // claim the message is empty, which is a worse error than an over-estimate.
    expect(textOfContent(gemini)).toContain(PNG);
  });

  it("keeps text parts in order and joins other shapes without crashing", () => {
    expect(textOfContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a b");
    expect(textOfContent(42)).toBe("42");
    expect(textOfContent({ odd: true })).toBe('{"odd":true}');
    // A cyclic object would throw in JSON.stringify; the helper must not take the screen down.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof textOfContent(cyclic)).toBe("string");
  });
});

describe("countImageParts", () => {
  it("counts only images", () => {
    expect(countImageParts("plain")).toBe(0);
    expect(countImageParts([{ type: "text", text: "x" }])).toBe(0);
    expect(countImageParts([{ type: "text", text: "x" }, { type: "image", mediaType: "image/png", dataBase64: PNG }])).toBe(1);
  });
});

describe("userContent chooses the smallest honest shape", () => {
  it("stays a string when there is nothing but text", () => {
    // A plain string is what every provider dialect handles without a part template, so a text-only
    // turn must not be upgraded to an array just because attachments are supported.
    expect(userContent("hi", [])).toBe("hi");
    expect(userContent("", [])).toBe("");
  });

  it("puts the text before the images", () => {
    const c = userContent("what is this?", [{ mediaType: "image/png", dataBase64: PNG }]);
    expect(Array.isArray(c)).toBe(true);
    expect((c as ContentPart[])[0]).toEqual({ type: "text", text: "what is this?" });
    expect((c as ContentPart[])[1]).toEqual({ type: "image", mediaType: "image/png", dataBase64: PNG });
  });

  it("omits an empty text part rather than sending an empty string block", () => {
    const c = userContent("   ", [{ mediaType: "image/png", dataBase64: PNG }]) as ContentPart[];
    expect(c).toHaveLength(1);
    expect(c[0]!.type).toBe("image");
  });
});

describe("renderContentParts applies the dialect's own templates", () => {
  const render = (t: Record<string, unknown>, v: Record<string, unknown>) => renderTemplate(t, v);
  const parts: ContentPart[] = [
    { type: "text", text: "describe" },
    { type: "image", mediaType: "image/png", dataBase64: PNG },
  ];

  it("renders OpenAI's image_url with a data URI", () => {
    const openai = BUILTIN_TEMPLATES["openai-compat"]("https://api.test/v1");
    const out = renderContentParts(parts, openai.endpoints.generateText!.contentPartTemplates, render) as Record<string, unknown>[];
    expect(out[0]).toEqual({ type: "text", text: "describe" });
    expect(out[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
  });

  it("renders Anthropic's base64 source block with the media type beside the bytes", () => {
    const anthropic = BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1");
    const out = renderContentParts(parts, anthropic.endpoints.generateText!.contentPartTemplates, render) as Record<string, unknown>[];
    expect(out[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG },
    });
  });

  it("renders Gemini's inlineData with no type field at all", () => {
    const gemini = BUILTIN_TEMPLATES["gemini-compat"]("https://api.test/v1");
    const out = renderContentParts(parts, gemini.endpoints.generateText!.contentPartTemplates, render) as Record<string, unknown>[];
    expect(out[0]).toEqual({ text: "describe" });
    expect(out[1]).toEqual({ inlineData: { mimeType: "image/png", data: PNG } });
  });

  it("passes parts through untouched when the manifest declares no templates", () => {
    // Neither dropped nor mangled: an untaught dialect may reject these, but it must not lose them.
    const out = renderContentParts(parts, undefined, render);
    expect(out).toEqual(parts);
  });

  it("leaves string content and unknown part types alone", () => {
    expect(renderContentParts("plain", BUILTIN_TEMPLATES["openai-compat"]("u").endpoints.generateText!.contentPartTemplates, render)).toBe("plain");
    const weird = [{ type: "video", url: "x" }];
    const openai = BUILTIN_TEMPLATES["openai-compat"]("u");
    expect(renderContentParts(weird, openai.endpoints.generateText!.contentPartTemplates, render)).toEqual(weird);
  });
});

describe("shapeMessageContent maps whole messages, not the message array", () => {
  const render = (t: Record<string, unknown>, v: Record<string, unknown>) => renderTemplate(t, v);
  const openai = BUILTIN_TEMPLATES["openai-compat"]("u").endpoints.generateText!.contentPartTemplates;
  const msgs = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

  it("renders each message's content", () => {
    // The bug this pins: the renderer was handed the *message array* instead of each message's
    // content, so every message looked like an unknown part type and passed through untouched — a
    // green unit test for `renderContentParts` with a silently unrendered request.
    const out = shapeMessageContent(msgs, openai, undefined, render) as Record<string, unknown>[];
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("returns messages untouched when the dialect declares nothing", () => {
    const out = shapeMessageContent(msgs, undefined, undefined, render);
    expect(out[0]).toBe(msgs[0]); // same object, not a copy: no declaration means no work
  });

  it("renames the content field and wraps a bare string into parts", () => {
    const out = shapeMessageContent(
      [{ role: "user", content: "plain" }],
      openai,
      "parts",
      render,
    ) as Record<string, unknown>[];
    expect(out[0]).toEqual({ role: "user", parts: [{ type: "text", text: "plain" }] });
    expect(out[0]).not.toHaveProperty("content");
  });

  it("leaves an empty content field as an empty array when renaming", () => {
    const out = shapeMessageContent([{ role: "user", content: "" }], openai, "parts", render) as Record<string, unknown>[];
    expect(out[0]!.parts).toEqual([]);
  });

  it("passes non-object entries through", () => {
    expect(shapeMessageContent(["nonsense"], openai, "parts", render)).toEqual(["nonsense"]);
  });
});
