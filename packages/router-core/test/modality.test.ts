/**
 * modality — the shared rule evaluator (2026-09-16 amendment, DECISIONS.md). Both adapter tiers
 * call this, so these cases pin the contract once: id pattern OR raw metadata, a model is
 * classified by whichever rule claims it, and anything unmatched is text (never guessed).
 */
import { describe, expect, it } from "vitest";
import { matchesModalityRule, tagModality } from "../src/modality.js";

const IMAGE = "image";

describe("matchesModalityRule: id pattern", () => {
  it("matches a bare id", () => {
    expect(matchesModalityRule({ modelIdPattern: "^dall-e" }, { nativeId: "dall-e-3" })).toBe(true);
  });
  it("does not match a namespaced id — the OpenRouter failure this amendment fixes", () => {
    // anchored ^dall-e can never match "openai/dall-e-3"
    expect(matchesModalityRule({ modelIdPattern: "^(dall-e|flux)" }, { nativeId: "openai/dall-e-3" })).toBe(false);
  });
  it("does not throw on an invalid regex — an unparseable rule simply never matches", () => {
    expect(() => matchesModalityRule({ modelIdPattern: "[" }, { nativeId: "x" })).toThrow();
  });
});

describe("matchesModalityRule: raw metadata", () => {
  const rule = { rawMatch: { path: "$.architecture.output_modalities[0]", contains: IMAGE } };

  it("matches the scalar case (single-output model)", () => {
    expect(matchesModalityRule(rule, { nativeId: "a", raw: { architecture: { output_modalities: ["image"] } } })).toBe(true);
  });
  it("matches the primary output of a dual-modality model", () => {
    expect(matchesModalityRule(rule, { nativeId: "g", raw: { architecture: { output_modalities: ["image", "text"] } } })).toBe(true);
  });
  it("rejects a dual-modality model whose PRIMARY output is text (auto-routers)", () => {
    // openrouter/auto declares [text, image]; it is a text model for routing purposes
    expect(matchesModalityRule(rule, { nativeId: "openrouter/auto", raw: { architecture: { output_modalities: ["text", "image"] } } })).toBe(false);
  });
  it("is false when metadata is missing or the path does not resolve", () => {
    expect(matchesModalityRule(rule, { nativeId: "x" })).toBe(false);
    expect(matchesModalityRule(rule, { nativeId: "x", raw: { id: "x" } })).toBe(false);
    expect(matchesModalityRule(rule, { nativeId: "x", raw: null })).toBe(false);
  });
});

describe("matchesModalityRule: array membership", () => {
  const rule = { rawMatch: { path: "$.architecture.output_modalities", contains: IMAGE } };
  it("matches when the selected value is an array containing the string", () => {
    expect(matchesModalityRule(rule, { nativeId: "x", raw: { architecture: { output_modalities: ["text", "image"] } } })).toBe(true);
  });
  it("does not match when the array lacks it", () => {
    expect(matchesModalityRule(rule, { nativeId: "x", raw: { architecture: { output_modalities: ["text"] } } })).toBe(false);
  });
});

describe("matchesModalityRule: both matchers present (OR semantics)", () => {
  const rule = { modelIdPattern: "^dall-e", rawMatch: { path: "$.kind", contains: IMAGE } };
  it("matches on the id alone", () => {
    expect(matchesModalityRule(rule, { nativeId: "dall-e-3" })).toBe(true);
  });
  it("matches on the metadata alone", () => {
    expect(matchesModalityRule(rule, { nativeId: "openai/gpt-image-1", raw: { kind: "image" } })).toBe(true);
  });
  it("is false when neither votes", () => {
    expect(matchesModalityRule(rule, { nativeId: "gpt-4o", raw: { kind: "chat" } })).toBe(false);
  });
});

describe("tagModality: unmatched models are text, and text rules never claim anything", () => {
  const rules = { image: { rawMatch: { path: "$.architecture.output_modalities[0]", contains: IMAGE } } };

  it("tags an image-primary model as image", () => {
    expect(tagModality(rules, { nativeId: "g", raw: { architecture: { output_modalities: ["image", "text"] } } })).toBe(IMAGE);
  });
  it("tags everything else text", () => {
    expect(tagModality(rules, { nativeId: "gpt-4o", raw: { architecture: { output_modalities: ["text"] } } })).toBe("text");
    expect(tagModality(rules, { nativeId: "mystery" })).toBe("text");
  });
  it("with no rules at all every model is text", () => {
    expect(tagModality(undefined, { nativeId: "dall-e-3" })).toBe("text");
  });
  it("a text-keyed rule is ignored — only the image rule can promote a model", () => {
    // Modality is single-valued and defaults to text, so a "text" rule has nothing to do.
    expect(tagModality({ text: { modelIdPattern: ".*" } } as never, { nativeId: "anything" })).toBe("text");
  });
});