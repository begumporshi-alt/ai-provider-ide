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
  // Per-endpoint static request headers (v1.1 amendment 2026-09-29). Until this existed the
  // catalogue call carried **only** the auth headers, so a gateway that gates on client identity
  // could not be satisfied on `/models` even when `generateText` could. Measured on
  // `agentrouter.org`: `GET /v1/models` with no recognised `User-Agent` answers
  // `401 unauthorized_client_error` ("unauthorized client detected") regardless of the key, and
  // the same key is then judged normally once the header is present. That gateway is the
  // motivating case, and `listModels` is the call every probe, ping and catalog refresh makes —
  // so without this the whole provider is unreachable while `generateText` looks configured.
  headers: z.record(z.string()).optional(),
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

/**
 * Maps the internal OpenAI role vocabulary to the dialect's own roles.
 *
 * # Why this is a grammar field, not a code branch
 *
 * The assistant and agent loop both speak OpenAI roles internally:
 * `user | assistant | system | tool`. Three of the four are portable, but the dialects
 * disagree on the rest:
 *  - Anthropic has no `system` in `messages`; it is a top-level request param.
 *  - Anthropic's `tool` role is `user` (tool results are injected as user turns).
 *  - Gemini uses `user | model | user`<sup>†</sup> for tool results.
 *
 * A hardcoded `if dialect === "anthropic"` inside the interpreter is the drift this
 * repository keeps rediscovering (§1.3). `messagesRoleMap` makes the role translation
 * declarative: the grammar carries the mapping, the interpreter applies it. A new dialect
 * only adds a row to the map — no interpreter edit, no branch, nothing to forget.
 *
 * `system` is special-cased out by omitting it from the map's output: when the value
 * for `"system"` is `null`, the interpreter hoists those messages into the dialect's
 * system field (top-level `system` for Anthropic, a separate param for Gemini). The
 * OpenAI dialect maps `"system" -> "system"` (a pass-through).
 *
 * <sup>†</sup> Gemini's `function.response` is wrapped as a `user` role; this is the
 * correct mapping, not a lossy one — the `tool_call_id` is dropped because Gemini's
 * turn-by-turn shape carries no such concept.
 */
const MESSAGES_ROLE_MAP = z.record(z.string().min(1), z.string().min(1).nullable());
// `null` value means "hoist to the dialect's system field"; a string means "translate role to this".
// OpenAI's own map is all pass-throughs including system->system.

export const GENERATE_TEXT_ENDPOINT = z.object({
  method: z.literal("POST"),
  // May carry a `{{model}}` placeholder (Gemini dials `/v1beta/models/{model}:generateContent`);
  // the interpreter substitutes the caller's model, URL-encoded. `streamPath` (below) carries one
  // the same way.
  path: z.string(),
  headers: z.record(z.string()).optional(), // per-endpoint static request headers (v1.1)
  // Values are "{{x}}", "{{x?}}", literals, or NESTED STRUCTURES containing them (Gemini's
  // generationConfig): renderTemplate resolves placeholders at any depth. Top-level keys stay
  // whitelist-bound (REQUEST_FIELD_WHITELIST); nesting adds shape, not trust.
  requestTemplate: z.record(z.unknown()),
  // v1.1 amendment (2026-09-30): declarative dialect shaping of the request body.
  //
  // `messagesRoleMap` maps the internal OpenAI role vocabulary to the dialect's own.
  // A `null` value means "hoist to the dialect's system field" — Anthropic has no `system`
  // in its `messages` array; it is a top-level request param, so `system` messages are
  // extracted out and assembled into that param. The OpenAI dialect maps every role to itself.
  //
  // See `normalizeDialectMessages` in the interpreter for the one implementation.
  messagesRoleMap: MESSAGES_ROLE_MAP.optional(),
  // The request body field that receives hoisted system messages (e.g. `"system"` for Anthropic).
  // When absent, hoisted system content is dropped — a dialect without a system channel
  // simply cannot accept one.
  systemField: z.string().optional(),
  // v1.1 amendment (2026-09-30): declarative `tool_choice` translation.
  // Maps the internal OpenAI tool_choice forms ("none", "auto", "function") to the dialect's own.
  // A `null` value means "omit tool_choice entirely for this form". A string is a literal value
  // the interpreter substitutes. When absent, toolChoice passes through untouched (OpenAI dialect).
  toolChoiceMap: z.record(z.string(), z.unknown()).optional(),
  // **A dialect may stream at a different endpoint than it dials unarily.** Gemini's unary
  // generateText is `:generateContent`; its SSE stream is
  // `:streamGenerateContent?alt=sse` — same endpoint family, different path, and no body field
  // can express that difference. When the caller asks to stream and this is set, the
  // interpreter dials this path instead of `path`.
  streamPath: z.string().optional(),
  // v1.1 amendment (2026-09-30): where the dialect puts its finish_reason on the response.
  // Optional — a dialect that omits it simply never surfaces a finish reason.
  responseFinish: Selector.optional(),
  // `toolCalls` (v1.1 amendment 2026-09-17): where a real tool call sits in the response.
  // Optional and dialect-specific — a manifest that omits it simply never reports tool
  // calls, which is the pre-amendment behaviour.
  responseMap: z.object({
    text: Selector,
    usage: Selector.optional(),
    toolCalls: Selector.optional(),
    // **The usage block's own field names, when the dialect does not speak OpenAI's.** The
    // interpreter reads `prompt_tokens` / `completion_tokens` off whatever object `usage`
    // selects; Gemini's usageMetadata says `promptTokenCount` / `candidatesTokenCount`. A
    // dialect without this override simply has OpenAI field names — and one with unmatched
    // names would report zero tokens forever, silently zeroing cost and defeating any spend cap.
    // Values are FIELD NAMES inside the usage object, not `$` selectors.
    usageKeys: z
      .object({ prompt: z.string(), completion: z.string(), cached: z.string().optional() })
      .optional(),
  }),
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
      // **A provider credential must not cross the network in cleartext.** `z.string().url()`
      // accepts `http:`, so before 2026-09-27 a baseUrl of `http://api.example.com/v1` validated
      // cleanly and the egress then attached the key and the prompt to a plaintext request.
      // `egress::require_secure_scheme` (Rust) is the enforcement point; this is the form-level
      // refusal, so the operator learns at input time rather than at the first request. `http`
      // stays legal for loopback, which is a primary use case — Ollama is on 11434, LM Studio on
      // 1234 — and the predicate mirrors `egress::is_local` (the whole 127/8 block, plus
      // `localhost` and `::1`).
      baseUrl: z
        .string()
        .url()
        .refine(
          (v) => {
            // **A validator must not throw.** `.refine` runs whether or not `.url()` passed, so an
            // unguarded `new URL(v)` turned a *validation failure* into an exception — the caller
            // got a `TypeError` instead of `{success:false}`, and the pre-existing "rejects a
            // non-URL" case started throwing. `URL.canParse` would be tidier but is Safari 17+,
            // and this bundle targets macOS 11. try/catch works everywhere.
            let u: URL;
            try {
              u = new URL(v);
            } catch {
              return false; // not a URL at all; `.url()` has already reported it
            }
            if (u.protocol === "https:") return true;
            // `new URL().hostname` serialises an IPv6 host **with** its brackets, so `[::1]` is
            // the form that actually arrives here — `"::1"` alone would silently refuse every
            // IPv6-loopback provider. Both are accepted, matching `egress::is_local`.
            const h = u.hostname;
            if (h === "localhost" || h === "::1" || h === "[::1]") return true;
            const o = h.split(".");
            return o.length === 4 && o[0] === "127" && o.every((p) => /^\d{1,3}$/.test(p) && +p <= 255);
          },
          {
            message:
              "baseUrl must be https unless the host is loopback — a provider key would otherwise cross the network in cleartext",
          },
        ),
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
