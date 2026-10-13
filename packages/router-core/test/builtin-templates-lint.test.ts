/**
 * Every shipped dialect template must pass the lint its own dialect requires.
 *
 * `lintManifest` carries the shaping gate: for a known dialect it refuses a manifest that omits the
 * fields that dialect cannot work without (`REQUIRED_SHAPING` in `adapter-generator.ts`), on the
 * grounds that a manifest reaching a provider unshaped does not fail loudly — it sends a body the
 * provider rejects, or one it silently misreads.
 *
 * **The builtins were long exempt from that gate in practice, and nothing said so.** They are
 * constructed in code rather than generated, so nothing ever ran the lint over them — which is a gap
 * with teeth rather than a formality: the rule the wizard enforces on a user's provider was never
 * checked against the templates the product ships for the three dialects it knows best. The drift
 * register recorded the *symptom* ("a generated gemini-compat manifest cannot pass `lintManifest`")
 * as a claim about generated manifests; the question this file answers is the prior one — do our own
 * templates satisfy our own rule?
 *
 * It is a loop rather than three cases on purpose: a fourth builtin, or a new requirement added to
 * `REQUIRED_SHAPING`, is covered the moment it exists instead of the moment someone remembers.
 */
import { describe, expect, it } from "vitest";
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { lintManifest } from "../src/adapter-generator.js";

const BASE_URL = "https://api.test/v1";

describe("the shipped dialect templates pass the lint their dialects require", () => {
  it("covers every builtin, so a new one cannot be added without a lint verdict", () => {
    // The guard is the loop below plus this list: a template added to the map is linted, and an
    // entry removed from the map is caught here rather than by a reader noticing a missing case.
    expect(Object.keys(BUILTIN_TEMPLATES).sort()).toEqual([
      "anthropic-compat",
      "gemini-compat",
      "openai-compat",
    ]);
  });

  for (const [id, make] of Object.entries(BUILTIN_TEMPLATES)) {
    it(`${id} lints clean for its own dialect`, () => {
      const manifest = make(BASE_URL) as unknown as AdapterManifest;
      expect(lintManifest(manifest, BASE_URL)).toEqual([]);
    });
  }
});
