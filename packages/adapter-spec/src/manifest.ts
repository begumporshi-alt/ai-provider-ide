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
 * How to read ONE tool-call block (v1.1 amendment 2026-10-01).
 *
 * The companion of `responseMap.toolCalls`, which selects the array; this describes a member of it.
 * Paths here are dotted field paths inside a block, not `$` selectors — see `tool-shaping.ts` for
 * why that is a different language on purpose.
 *
 * **OpenAI and Anthropic deliberately do not declare it.** Their shapes are what the interpreter's
 * original reader already implements, and that reader is kept for a manifest that declares nothing;
 * re-expressing a working path in a new abstraction is where a refactor silently changes behaviour.
 * This field exists for a dialect the hardcoded reader cannot express — Gemini, whose blocks carry
 * no `type` and whose arguments are already an object. The two dialects' shapes, for reference:
 *
 *   OpenAI    discriminator {path:"type", equals:"function"}, id "id",
 *             name "function.name", arguments "function.arguments", argumentsFormat json-string
 *   Anthropic discriminator {path:"type", equals:"tool_use"}, id "id",
 *             name "name", arguments "input", argumentsFormat object
 *   Gemini    discriminator {path:"functionCall", present:true},
 *             name "functionCall.name", arguments "functionCall.args", argumentsFormat object,
 *             streamedAs whole
 */
const TOOL_CALL_SHAPE = z.object({
  discriminator: z
    .object({
      path: z.string().min(1),
      equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      // "This field exists at all" — the only test Gemini can support, since its parts carry no
      // `type` to compare against. See the comment on `ToolCallDiscriminator.present`.
      present: z.boolean().optional(),
    })
    .optional(),
  id: z.string().optional(),
  name: z.string().min(1),
  arguments: z.string().min(1),
  // `json-string` = the value is JSON *text* (OpenAI's `function.arguments`); `object` = the value
  // is already the arguments object (Gemini's `args`, Anthropic's `input`). The internal shape
  // carries JSON text, so an object is serialised on the way in.
  argumentsFormat: z.enum(["json-string", "object"]).optional(),
  // How a streamed call arrives: `fragments` = pieces of one JSON string to concatenate (OpenAI);
  // `whole` = each event carries a complete call (Gemini).
  streamedAs: z.enum(["fragments", "whole"]).optional(),
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
  // v1.1 amendment (2026-10-01): declarative rendering of multimodal content parts.
  //
  // Keyed by the *internal* part type (`"text"`, `"image"`), each value is a request-body fragment
  // whose placeholders are resolved per part: `{{text}}` for a text part, and `{{mediaType}}`,
  // `{{dataBase64}}` or `{{dataUri}}` for an image. Values are nested structures, so a dialect's own
  // wrapping is expressible (`source.data` for Anthropic, `inlineData.data` for Gemini) without the
  // interpreter knowing any dialect by name.
  //
  // The three dialects carry an image in three shapes — OpenAI an `image_url.url` data URI, Anthropic
  // a base64 `source` block, Gemini `inlineData` — which is precisely the case `messagesRoleMap`
  // already answers for roles: **the grammar carries the mapping, the interpreter applies it.** A
  // manifest that declares nothing passes parts through unchanged, and nothing is dropped: an
  // undeclared dialect may reject the request, but it will not silently lose the user's image.
  //
  // v1.1 amendment (2026-10-01): two further keys, `"toolCall"` and `"toolResult"`, carry a
  // *replayed* tool turn. They are keyed by internal names, deliberately NOT by a dialect's own
  // block type — a rendered Anthropic block already has `type: "tool_use"`, and a key of that name
  // would make `renderContentParts` render it a second time. Available values: `{{id}}`,
  // `{{name}}`, and `{{arguments}}` / `{{argumentsObject}}` for a call; `{{id}}`, `{{name}}`,
  // `{{text}}` / `{{response}}` for a result. Declaring NEITHER leaves the OpenAI `tool_calls`
  // sibling field and `role:"tool"` results exactly as they were, which is what OpenAI needs.
  contentPartTemplates: z.record(z.string(), z.record(z.unknown())).optional(),
  // v1.1 amendment (2026-10-01): declarative tool DECLARATIONS.
  //
  // The `{{tools}}` placeholder ships the caller's OpenAI-shaped array
  // (`[{type:"function", function:{name, description, parameters}}]`) verbatim, which is right for
  // OpenAI and Anthropic and wrong for Gemini: Gemini nests declarations one level down, as
  // `tools: [{functionDeclarations:[{name, description, parameters}]}]`, with no `type`/`function`
  // wrapping (see `declaration_to_openai` in `core/gateway_gemini.rs`, the same mapping read the
  // other way). Keyed by the *internal* tool type (`"function"`), each value is a fragment whose
  // placeholders are resolved per tool: `{{name}}`, `{{description}}`, `{{parameters}}`.
  //
  // The outer wrapping is the request template's job, not this field's — `renderTemplate` already
  // resolves placeholders inside nested structures, so a dialect states it once there
  // (`tools: { functionDeclarations: "{{tools?}}" }`) instead of this field having to express both
  // the per-tool shape and the array's container.
  //
  // A manifest that declares nothing passes the caller's array through untouched.
  toolDeclarationTemplates: z.record(z.string(), z.record(z.unknown())).optional(),
  // The single container the dialect wraps its whole declarations array in, with the declarations
  // at `{{declarations}}`. Gemini needs `tools: [{functionDeclarations: […]}]`, and this cannot be
  // written in the request template: `renderTemplate` recurses into objects but not arrays, and an
  // array literal there is passed through as an unresolved literal.
  //
  // Stating it here rather than in the template also makes the empty case come out right by
  // construction. `tools: { functionDeclarations: "{{tools?}}" }` in the template would still emit
  // `tools: {}` when there are no tools — the optional placeholder omits its own field and leaves
  // the enclosing object behind — so a tool-less request would carry an empty object where the
  // grammar promised omission. With the wrapper declared here, "no tools" makes the whole value
  // `undefined` and `{{tools?}}` omits the field outright.
  toolDeclarationWrapper: z.record(z.string(), z.unknown()).optional(),
  // The field name this dialect uses for a message's content. Absent means the universal `content`;
  // Gemini declares `"parts"`, which is also a *shape* difference — its parts must be an array even
  // when the message is one line of text — so the interpreter wraps a string in a text part when
  // this is declared. A rename without that wrapping would produce `parts: "hi"`, which no provider
  // accepts; the two belong to one declaration.
  contentField: z.string().optional(),
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
    // v1.1 amendment (2026-10-01): the FIELD SHAPE of a tool-call block.
    //
    // `toolCalls` says *where* the blocks are; this says how to read one. Without it the reader was
    // hardcoded to OpenAI's and Anthropic's shapes — a block is a tool call when it has
    // `type: "tool_use"` or `type: "function"`, and its arguments are at `function.arguments` or
    // `input`. Gemini's `{functionCall:{name, args}}` has no `type` and no such field, so pointing
    // `toolCalls` at its parts produced a nameless, argument-less call rather than an error.
    //
    // Paths are dotted field paths **within one block** (`"function.name"`), not `$` selectors —
    // the selector has already chosen the array. See `tool-shaping.ts`.
    toolCallShape: TOOL_CALL_SHAPE.optional(),
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
    // `toolConfig` (2026-10-01) is Gemini's own channel for the same caller-supplied value
    // `tool_choice` carries — a generation manifest puts the caller's tool_choice through
    // `{{toolChoice?}}`, and the dialect's field name for it is `toolConfig`. It is on the same
    // trust footing as `tools`/`tool_choice`: the manifest can only say *where* the caller's value
    // goes, never invent one. Leaving it out would have made every generated Gemini manifest fail
    // lint with "request field is not whitelisted", i.e. the whitelist would have blocked the only
    // shape this dialect can use.
    "toolConfig",
  ]),
  generateImage: new Set(["model", "prompt", "size"]),
  listModels: new Set<string>(),
};

/**
 * Known gap in `generateText`'s whitelist (found 2026-10-01 while adding `toolConfig`): it is
 * OpenAI-shaped. A gemini-compat manifest fails lint on three counts because of it — `contents` and
 * `generationConfig` are not listed, and `/v1beta/{{model}}:generateContent` fails the URL-path
 * regex on its colon. Builtins are not linted, so nothing is broken at runtime; what is broken is
 * that a *generated* Gemini manifest can never pass, which is the path the linter exists for.
 * Left as found: widening it means deciding whether a colon belongs in the path grammar, which is a
 * grammar decision rather than part of the tool-shaping work that surfaced it.
 */
