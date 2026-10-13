/**
 * Dialect-shaping conformance — the TypeScript half (2026-10-13).
 *
 * The manifest interpreter exists twice: `@aiprovider/router-core` is the reference, and
 * `apps/desktop/src-tauri/src/core/dialect_shaping.rs` is the port the gateway actually serves
 * with. Both execute the scenarios in `conformance/dialect-scenarios.json`, so the shaping rules
 * are pinned to each other by construction rather than by a comment claiming the port matches.
 *
 * Why this matters more than a normal unit test: the gateway path is what every external client
 * (Cursor, Claude Code, a script) exercises, while the reference is what the probe/fingerprint
 * wizard and the whole `router-core` suite are written against. A divergence means a manifest the
 * wizard validated behaves differently once it is served — the failure mode the drift register
 * keeps recording.
 *
 * The driver lives here rather than beside the reference implementation for a mundane reason:
 * `packages/router-core`'s `tsconfig` carries no node types, so `node:fs` does not typecheck
 * there, and this package already has the same pattern (`tools/agentLoop.conformance.test.ts`).
 * The corpus file is shared, which is what matters.
 *
 * The comparison rule (drop null-valued keys recursively) is stated in the corpus header and
 * applied identically here and in the Rust driver.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attachToolParts,
  blockField,
  normalizeDialectMessages,
  readToolCalls,
  renderTemplate,
  shapeMessageContent,
  shapeToolDeclarations,
  textOfContent,
  translateFinishReason,
  type ContentPartTemplates,
  type ToolCallShape,
  type ToolDeclarationTemplates,
} from "@aiprovider/router-core";

/** The reference engine's own values type, taken from its signature rather than re-declared. */
type TemplateValues = Parameters<typeof renderTemplate>[1];
/** One adapter from this package's renderer to the shape the shaping functions take. */
const render = (template: Record<string, unknown>, values: Record<string, unknown>) =>
  renderTemplate(template, values as TemplateValues);

const CORPUS = fileURLToPath(new URL("../../conformance/dialect-scenarios.json", import.meta.url));

interface Scenario {
  name: string;
  kind: string;
  [k: string]: unknown;
}

const scenarios: Scenario[] = JSON.parse(readFileSync(CORPUS, "utf8")).scenarios;

/**
 * Drop null-valued object keys, recursively.
 *
 * Rust serialises `Option::None` as an explicit `null` where TypeScript omits an absent optional
 * key (a `ToolCall` with no id is `{id:null,…}` there and `{…}` here). Absence is the thing these
 * scenarios are *not* testing, so both drivers normalise it away before comparing.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

/** Run one scenario through the reference implementation. Mirrors the Rust driver's dispatch. */
function actual(s: Scenario): unknown {
  switch (s.kind) {
    case "normalizeMessages": {
      const { messages, systemContent } = normalizeDialectMessages(
        s.messages as unknown[],
        s.roleMap as Record<string, string | null> | undefined,
        s.systemField as string | undefined,
      );
      return { messages, systemContent };
    }
    case "readToolCalls":
      return readToolCalls(s.blocks, s.shape as ToolCallShape);
    case "textOfContent":
      return textOfContent(s.content);
    case "blockField":
      return blockField(s.block, s.path as string) ?? null;
    case "finishReason":
      return translateFinishReason(s.reason as string, s.map as Record<string, unknown> | undefined);
    // The renderer seam: this side's shaping functions take rendering as a callback, so the driver
    // passes the package's own `renderTemplate` — the reference engine the Rust `template.rs` is a
    // port of. See the corpus header for why that is stated rather than hidden.
    case "shapeToolDeclarations":
      return shapeToolDeclarations(
        s.tools,
        s.templates as ToolDeclarationTemplates | undefined,
        render,
        s.wrapper as Record<string, unknown> | undefined,
      );
    case "shapeMessageContent":
      return shapeMessageContent(
        s.messages as unknown[],
        s.templates as ContentPartTemplates | undefined,
        s.contentField as string | undefined,
        render,
      );
    case "attachToolParts": {
      const templates = (s.templates ?? {}) as { toolCall?: Record<string, unknown>; toolResult?: Record<string, unknown> };
      return attachToolParts(s.messages as unknown[], templates, render);
    }
    default:
      throw new Error(`unknown scenario kind: ${s.kind}`);
  }
}

describe("dialect shaping conformance (reference side)", () => {
  it("runs every scenario in the shared corpus", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const s of scenarios) {
    it(s.name, () => {
      expect(normalize(actual(s))).toEqual(normalize(s.expect));
    });
  }
});
