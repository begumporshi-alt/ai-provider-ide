/**
 * Declarative adapter manifest — grammar v1.1 (ARCHITECTURE.md §2.6).
 *
 * This is the FROZEN grammar. It is deliberately a tiny, lintable, safe-by-construction
 * subset: JSONPath-ish selectors + `{{placeholder}}` templating, no expressions, no eval.
 * zod validates anything produced by the Generator AI before it is ever interpreted
 * (runtime validation of AI output is security-relevant — spec §7).
 */
import { z } from "zod";

/** A JSONPath selector within the supported subset (see router-core/jsonpath.ts). */
const Selector = z.string().startsWith("$");

/**
 * How a model is classified into a modality (v1.1; `rawMatch` added by the 2026-09-16
 * amendment, DECISIONS.md). A rule matches when EITHER matcher succeeds:
 *  - `modelIdPattern` — regex over the native model id (bare ids: `dall-e-3`);
 *  - `rawMatch` — the provider's own model metadata, selected from the raw object returned
 *    by `listModels.map.raw`. `contains` matches when the selected value equals the string,
 *    or is an array containing it. Namespaced catalogs (OpenRouter) are the motivating case:
 *    `{path: "$.architecture.output_modalities[0]", contains: "image"}`.
 */
export const MODALITY_RULE = z
  .object({
    modelIdPattern: z.string().optional(),
    rawMatch: z.object({ path: Selector, contains: z.string() }).optional(),
  })
  .refine((r) => r.modelIdPattern !== undefined || r.rawMatch !== undefined, {
    message: "a modality rule needs modelIdPattern or rawMatch",
  });

export type ModalityRule = z.infer<typeof MODALITY_RULE>;

export const MANIFEST_ENDPOINT_AUTH_HEADER = z.object({
  name: z.string().min(1),
  prefix: z.string().optional(), // e.g. "Bearer"
});

export const LIST_MODELS_ENDPOINT = z.object({
  method: z.literal("GET"),
  path: z.string(),
  pagination: z
    .object({ style: z.enum(["none", "openai-cursor"]).default("none") })
    .optional(),
  map: z.object({ models: Selector, raw: Selector.optional() }),
});

/** Equality condition against a selector: matches when selectOne(json, path) === value. */
const StreamCondition = z.object({ path: Selector, equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) });

/**
 * How a dialect frames a tool call ACROSS stream events (v1.1 amendment 2026-09-17).
 *
 * Needed because not every dialect delivers a tool call as one object the way OpenAI does
 * (`delta.tool_calls`, handled by `chunkMap.toolCalls`). Anthropic splits it over events:
 *
 *   content_block_start -> { content_block: { type: "tool_use", id, name } }
 *   content_block_delta -> { delta: { type: "input_json_delta", partial_json: "{ \"pa" } }
 *
 * So the grammar needs a start-event (id/name) and a delta-event (argument fragment), each
 * recognized by a condition, plus the block index that ties them together. `index` is
 * optional: dialects with one tool call per event may omit it.
 */
const TOOL_CALL_STREAM = z.object({
  start: z.object({
    when: StreamCondition,
    id: Selector.optional(),
    name: Selector.optional(),
    index: Selector.optional(),
  }),
  delta: z.object({
    when: StreamCondition,
    partial: Selector,
    index: Selector.optional(),
  }),
});

export const GENERATE_TEXT_ENDPOINT = z.object({
  method: z.literal("POST"),
  path: z.string(),
  headers: z.record(z.string()).optional(), // per-endpoint static request headers (v1.1)
  requestTemplate: z.record(z.string()), // values are "{{x}}", "{{x?}}", or literals
  // `toolCalls` (v1.1 amendment 2026-09-17): where a real tool call sits in the response.
  // Optional and dialect-specific — a manifest that omits it simply never reports tool
  // calls, which is the pre-amendment behaviour.
  responseMap: z.object({ text: Selector, usage: Selector.optional(), toolCalls: Selector.optional() }),
  stream: z
    .object({
      protocol: z.literal("sse"),
      chunkMap: z.object({ delta: Selector, toolCalls: Selector.optional() }),
      errorMap: z.record(z.string()).optional(), // v1.1 mid-stream errors
      finish: Selector.optional(),
      // v1.1 amendment 2026-09-15 (DECISIONS.md): dialect-portable stream control.
      // chunkMap yields nothing on non-chunk events, so:
      //   stopWhen   — events that END the stream (e.g. anthropic message_stop)
      //   ignoreWhen — events whose mismatched chunkMap must not classify as PARSE_ERROR
      stopWhen: StreamCondition.optional(),
      ignoreWhen: StreamCondition.optional(),
      // Multi-event tool-call framing (anthropic-compat). Mutually exclusive in practice
      // with chunkMap.toolCalls; if both are declared, toolCallStream wins.
      toolCallStream: TOOL_CALL_STREAM.optional(),
      // Ask the provider for a usage block on the stream. OpenAI-shaped servers omit usage
      // entirely unless asked, so without this every streamed request reports zero tokens —
      // which silently zeroes cost and defeats any spend cap. Always paired with
      // `responseMap.usage`, which is what actually reads the block off the final chunk.
      requestUsage: z.boolean().optional(),
    })
    .optional(),
});

export const GENERATE_IMAGE_ENDPOINT = z.object({
  method: z.literal("POST"),
  path: z.string(),
  headers: z.record(z.string()).optional(),
  requestTemplate: z.record(z.string()),
  responseMap: z.object({
    imageB64: Selector.optional(),
    imageUrl: Selector.optional(),
  }),
});

export const CODE_ADAPTER = z.object({
  source: z.string().min(1).max(64_000), // the JS module text — executed ONLY in the QuickJS sandbox (§2.7)
  entry: z.literal("adapter"), // reserved: v1 always exports `adapter`
});

export const ADAPTER_MANIFEST_V1_1 = z
  .object({
    manifestVersion: z.literal(1),
    kind: z.enum(["declarative", "code"]).default("declarative"),
    dialect: z.string().min(1),
    provider: z.object({
      baseUrl: z.string().url(),
      auth: z.object({
        headers: z.array(MANIFEST_ENDPOINT_AUTH_HEADER).min(1), // v1.1: multiple auth headers
      }),
    }),
    endpoints: z.object({
      listModels: LIST_MODELS_ENDPOINT.optional(),
      generateText: GENERATE_TEXT_ENDPOINT.optional(),
      generateImage: GENERATE_IMAGE_ENDPOINT.optional(),
    }),
    code: CODE_ADAPTER.optional(),
    capabilities: z.object({ text: z.boolean(), image: z.boolean() }),
    modalityRules: z
      .record(z.enum(["text", "image"]), MODALITY_RULE)
      .optional(),
    limits: z
      .object({ maxOutputTokens: z.number().int().positive().optional() })
      .optional(),
    provenance: z.object({
      origin: z.enum(["builtin-template", "ai-generated", "ai-patched", "user-edited"]),
      generatorModel: z.string().nullable(),
      contractResult: z.unknown().optional(),
      createdAt: z.string(),
      validatedAt: z.string().optional(),
    }),
  })
  .superRefine((m, ctx) => {
    if (m.kind === "code") {
      if (!m.code) {
        ctx.addIssue({ code: "custom", message: 'kind "code" requires a code adapter body', path: ["code"] });
      }
    } else if (!m.code && (!m.endpoints.generateText || !m.endpoints.listModels)) {
      // declarative manifests must carry at least the text path (pre-existing expectation
      // from the contract suite; now stated in the grammar)
      ctx.addIssue({ code: "custom", message: "declarative manifests require endpoints.listModels and endpoints.generateText", path: ["endpoints"] });
    }
    if (m.code && m.kind !== "code") {
      ctx.addIssue({ code: "custom", message: "code bodies require kind: code", path: ["code"] });
    }
  });

export type AdapterManifest = z.infer<typeof ADAPTER_MANIFEST_V1_1>;
export type GenerateTextEndpoint = z.infer<typeof GENERATE_TEXT_ENDPOINT>;
export type ListModelsEndpoint = z.infer<typeof LIST_MODELS_ENDPOINT>;
export type GenerateImageEndpoint = z.infer<typeof GENERATE_IMAGE_ENDPOINT>;

/** Whitelisted request-body fields per endpoint — a hostile manifest cannot smuggle extras
 *  (invariant 4: generator picks mappings, lint bounds the surface). */
export const REQUEST_FIELD_WHITELIST: Record<string, ReadonlySet<string>> = {
  // `tools` / `tool_choice` / `response_format` (2026-09-17) carry CALLER-supplied values via
  // {{tools?}} placeholders — the manifest can only say "put the caller's tools here", it
  // cannot invent them. Same trust level as `messages`, so whitelisting them does not weaken
  // invariant 4 (a hostile manifest still cannot smuggle arbitrary body params of its own).
  generateText: new Set([
    "model", "messages", "stream", "max_tokens", "temperature",
    "tools", "tool_choice", "response_format",
  ]),
  generateImage: new Set(["model", "prompt", "size"]),
  listModels: new Set<string>(),
};
