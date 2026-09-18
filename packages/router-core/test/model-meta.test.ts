/**
 * Catalog metadata parsers.
 *
 * These feed the entry the gateway publishes into third-party clients, where a wrong answer is
 * a silent failure: claiming reasoning a model cannot produce, or truncating a long prompt
 * because no input cap was published. So "unknown" must stay distinguishable from "no".
 */
import { describe, expect, it } from "vitest";
import { parseContextWindow, parseReasoningSupport } from "../src/model-meta.js";

describe("parseContextWindow", () => {
  it("reads OpenRouter's context_length", () => {
    expect(parseContextWindow({ context_length: 128000 })).toBe(128000);
  });

  it("accepts a numeric string, the way several catalogs publish it", () => {
    expect(parseContextWindow({ context_length: "200000" })).toBe(200000);
  });

  it("falls back across the common spellings", () => {
    expect(parseContextWindow({ context_window: 32000 })).toBe(32000);
    expect(parseContextWindow({ max_context_length: 8000 })).toBe(8000);
  });

  it("returns undefined when the provider published none — never a guess", () => {
    expect(parseContextWindow({ id: "x" })).toBeUndefined();
    expect(parseContextWindow(null)).toBeUndefined();
  });

  it("rejects nonsense rather than passing it through", () => {
    expect(parseContextWindow({ context_length: 0 })).toBeUndefined();
    expect(parseContextWindow({ context_length: -1 })).toBeUndefined();
    expect(parseContextWindow({ context_length: "not a number" })).toBeUndefined();
  });
});

describe("parseReasoningSupport", () => {
  it("reads OpenRouter's supported_parameters", () => {
    expect(parseReasoningSupport({ supported_parameters: ["tools", "reasoning"] })).toBe(true);
  });

  it("matches the thinking spelling too", () => {
    expect(parseReasoningSupport({ supported_parameters: ["thinking"] })).toBe(true);
  });

  it("says false for a model that advertises no reasoning parameter", () => {
    expect(parseReasoningSupport({ supported_parameters: ["tools", "temperature"] })).toBe(false);
  });

  it("accepts a plain boolean when that is what the catalog publishes", () => {
    expect(parseReasoningSupport({ supports_reasoning: true })).toBe(true);
    expect(parseReasoningSupport({ reasoning: false })).toBe(false);
  });

  it("returns undefined when the provider does not say — unknown is not false", () => {
    expect(parseReasoningSupport({ id: "x" })).toBeUndefined();
    expect(parseReasoningSupport({ supported_parameters: [] })).toBeUndefined();
    expect(parseReasoningSupport(undefined)).toBeUndefined();
  });

  it("reads the real OpenRouter shape for a non-reasoning model", () => {
    // gpt-4o-mini advertises tools but not reasoning: the case that made a hand-written
    // `supportsReasoning: true` wrong.
    const raw = { id: "openai/gpt-4o-mini", context_length: 128000, supported_parameters: ["tools", "max_tokens"] };
    expect(parseReasoningSupport(raw)).toBe(false);
    expect(parseContextWindow(raw)).toBe(128000);
  });
});
