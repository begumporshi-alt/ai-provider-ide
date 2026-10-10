/**
 * vision.test.ts — who does the looking, and what the answering model is told.
 *
 * The failure this file guards against is not a crash: it is an image quietly reaching a model that
 * cannot see it (so the answer confidently ignores the screenshot), or a reading handed over as if
 * the answering model had looked itself (so it talks about "the image I can see").
 */
import { describe, expect, it } from "vitest";
import { imageContextBlock, pickVisionModel } from "./vision";

const allEnabled = () => true;

function model(id: string, providerId: string, supportsVision?: boolean) {
  return { id, providerId, nativeId: id.split("/")[1] ?? id, ...(supportsVision === undefined ? {} : { supportsVision }) };
}

describe("pickVisionModel", () => {
  it("prefers the configured default when its provider is enabled", () => {
    expect(
      pickVisionModel({
        preferred: "top-tools/vision-x",
        models: [model("top-tools/vision-x", "top-tools", true), model("other/vision-y", "other", true)],
        isEnabled: allEnabled,
      }),
    ).toBe("top-tools/vision-x");
  });

  /**
   * An explicit choice wins even without the declaration: capability metadata is published
   * inconsistently, and the person who set a vision helper has told us it can see. Falling back to
   * auto-pick here would silently ignore their configuration.
   */
  it("honours the configured default even when its row declares nothing", () => {
    expect(
      pickVisionModel({
        preferred: "vice/deepseek-v4-flash",
        models: [model("vice/deepseek-v4-flash", "vice"), model("other/vision-y", "other", true)],
        isEnabled: allEnabled,
      }),
    ).toBe("vice/deepseek-v4-flash");
  });

  it("falls back to the first enabled model that declares vision", () => {
    expect(
      pickVisionModel({
        models: [model("a/text-only", "a", false), model("b/vision", "b", true), model("c/vision", "c", true)],
        isEnabled: allEnabled,
      }),
    ).toBe("b/vision");
  });

  it("skips a disabled provider, even when it declares vision", () => {
    expect(
      pickVisionModel({
        models: [model("off/vision", "off", true), model("on/vision", "on", true)],
        isEnabled: (pid) => pid === "on",
      }),
    ).toBe("on/vision");
  });

  it("skips a model that declares no vision", () => {
    expect(
      pickVisionModel({ models: [model("a/text-only", "a")], isEnabled: allEnabled }),
    ).toBeNull();
  });

  it("ignores a stale configured default and still finds a usable one", () => {
    // The saved id may name a deleted model or a disabled provider; neither should strand the turn.
    expect(
      pickVisionModel({
        preferred: "gone/model",
        models: [model("on/vision", "on", true)],
        isEnabled: allEnabled,
      }),
    ).toBe("on/vision");
  });

  it("resolves a configured BARE native id to the qualified model that can serve it", () => {
    expect(
      pickVisionModel({
        preferred: "vision-x",
        models: [model("slug/vision-x", "slug", true)],
        isEnabled: allEnabled,
      }),
    ).toBe("slug/vision-x");
  });

  it("returns null when nothing can look, so the caller can say so", () => {
    expect(pickVisionModel({ models: [], isEnabled: allEnabled })).toBeNull();
  });
});

describe("imageContextBlock", () => {
  const readings = [{ name: "Screenshot 2026-10-10.png", description: "A settings dialog…" }];

  it("attributes the reading and forbids the claim of having seen the image", () => {
    const block = imageContextBlock(readings, "top-tools/DeepSeek-V4-Flash-Vision-Exp");
    expect(block).toContain('read-by="top-tools/DeepSeek-V4-Flash-Vision-Exp"');
    expect(block).toContain("you cannot");
    expect(block).toContain("do not claim to have seen the images themselves");
  });

  it("names each image and carries its text inside a delimited block", () => {
    const block = imageContextBlock(readings, "m");
    expect(block).toContain('<image name="Screenshot 2026-10-10.png">');
    expect(block).toContain("A settings dialog…");
    expect(block.trimEnd().endsWith("</images>")).toBe(true);
  });

  it("keeps several images apart rather than running them together", () => {
    const block = imageContextBlock(
      [
        { name: "one.png", description: "first" },
        { name: "two.png", description: "second" },
      ],
      "m",
    );
    expect(block).toContain('<image name="one.png">\nfirst\n</image>');
    expect(block).toContain('<image name="two.png">\nsecond\n</image>');
  });
});
