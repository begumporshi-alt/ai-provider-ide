/**
 * Declarative adapter manifest — grammar v1.1 (ARCHITECTURE.md §2.6).
 *
 * This is the FROZEN grammar. It is deliberately a tiny, lintable, safe-by-construction
 * subset: JSONPath-ish selectors + `{{placeholder}}` templating, no expressions, no eval.
 * zod validates anything produced by the Generator AI before it is ever interpreted
 * (runtime validation of AI output is security-relevant — spec §7).
 */
import { z } from "zod";

export const MODALITY_RULE = z.object({
  modelIdPattern: z.string(), // regex string; model ids matching => this modality
});

export const MANIFEST_ENDPOINT_AUTH_HEADER = z.object({
  name: z.string().min(1),
  prefix: z.string().optional(), // e.g. "Bearer"
});

/** A JSONPath selector within the supported subset (see router-core/jsonpath.ts). */
const Selector = z.string().startsWith("$");

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

export const GENERATE_TEXT_ENDPOINT = z.object({
  method: z.literal("POST"),
  path: z.string(),
  headers: z.record(z.string()).optional(), // per-endpoint static request headers (v1.1)
  requestTemplate: z.record(z.string()), // values are "{{x}}", "{{x?}}", or literals
  responseMap: z.object({ text: Selector, usage: Selector.optional() }),
  stream: z
    .object({
      protocol: z.literal("sse"),
      chunkMap: z.object({ delta: Selector }),
      errorMap: z.record(z.string()).optional(), // v1.1 mid-stream errors
      finish: Selector.optional(),
      // v1.1 amendment 2026-09-15 (DECISIONS.md): dialect-portable stream control.
      // chunkMap yields nothing on non-chunk events, so:
      //   stopWhen   — events that END the stream (e.g. anthropic message_stop)
      //   ignoreWhen — events whose mismatched chunkMap must not classify as PARSE_ERROR
      stopWhen: StreamCondition.optional(),
      ignoreWhen: StreamCondition.optional(),
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

export const ADAPTER_MANIFEST_V1_1 = z.object({
  manifestVersion: z.literal(1),
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
});

export type AdapterManifest = z.infer<typeof ADAPTER_MANIFEST_V1_1>;
export type GenerateTextEndpoint = z.infer<typeof GENERATE_TEXT_ENDPOINT>;
export type ListModelsEndpoint = z.infer<typeof LIST_MODELS_ENDPOINT>;
export type GenerateImageEndpoint = z.infer<typeof GENERATE_IMAGE_ENDPOINT>;

/** Whitelisted request-body fields per endpoint — a hostile manifest cannot smuggle extras
 *  (invariant 4: generator picks mappings, lint bounds the surface). */
export const REQUEST_FIELD_WHITELIST: Record<string, ReadonlySet<string>> = {
  generateText: new Set([
    "model", "messages", "stream", "max_tokens", "temperature",
  ]),
  generateImage: new Set(["model", "prompt", "size"]),
  listModels: new Set<string>(),
};
