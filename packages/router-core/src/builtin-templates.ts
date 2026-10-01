/**
 * builtin-templates (ARCHITECTURE.md L1) — static dialect manifests for the grammars the
 * v1.1 spec freezes: openai-compat, anthropic-compat and gemini-compat. Provider profiles are thin overlays
 * (baseUrl + quirks) on top. These are DATA, not code paths — a new OpenAI-compatible provider
 * is a profile or a wizard entry, never a release.
 */
import type { AdapterManifest, ModalityRule } from "@aiprovider/adapter-spec";

function openaiCompat(baseUrl: string, extra?: { textHeaders?: Record<string, string>; imageEndpoint?: boolean; imagePath?: string; imageRule?: ModalityRule }): AdapterManifest {
  return {
    manifestVersion: 1,
    kind: "declarative",
    dialect: "openai-chat-v1",
    provider: { baseUrl, auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] } },
    endpoints: {
      listModels: { method: "GET", path: "/models", map: { models: "$.data[*].id", raw: "$.data[*]" } },
      generateText: {
        method: "POST",
        path: "/chat/completions",
        headers: extra?.textHeaders,
        requestTemplate: {
          model: "{{model}}",
          messages: "{{messages}}",
          stream: "{{stream}}",
          max_tokens: "{{maxTokens?}}",
          temperature: "{{temperature?}}",
          // §3.4 tool calling. All three are `{{x?}}`: when the caller supplies no tools the
          // fields are omitted entirely rather than sent as null, which some servers reject.
          tools: "{{tools?}}",
          tool_choice: "{{toolChoice?}}",
          response_format: "{{responseFormat?}}",
        },
        messagesRoleMap: {
          user: "user",
          assistant: "assistant",
          system: "system",
          tool: "tool",
        },
        // v1.1 amendment (2026-10-01): OpenAI carries an image as an `image_url` whose url IS the
        // data URI, so this dialect uses `{{dataUri}}` while Anthropic uses the bare bytes.
        contentPartTemplates: {
          text: { type: "text", text: "{{text}}" },
          image: { type: "image_url", image_url: { url: "{{dataUri}}" } },
        },
        responseMap: {
          text: "$.choices[0].message.content",
          usage: "$.usage",
          toolCalls: "$.choices[0].message.tool_calls",
        },
        responseFinish: "$.choices[0].finish_reason",
        stream: {
          protocol: "sse",
          chunkMap: {
            delta: "$.choices[0].delta.content",
            // Streaming tool calls arrive as fragments indexed by `index`; see
            // manifest-interpreter, which reassembles them before reporting.
            toolCalls: "$.choices[0].delta.tool_calls",
          },
          errorMap: { "$.error": "PASS_THROUGH" },
          finish: "$.choices[0].finish_reason",
          // This dialect omits usage on a stream unless it is explicitly requested. Asking is
          // what makes cost — and therefore the spend cap — non-zero for streamed requests.
          requestUsage: true,
        },
      },
      ...(extra?.imageEndpoint
        ? {
            generateImage: {
              method: "POST" as const,
              path: extra.imagePath ?? "/images/generations",
              requestTemplate: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size?}}" },
              responseMap: { imageB64: "$.data[0].b64_json", imageUrl: "$.data[0].url" },
            },
          }
        : {}),
    },
    capabilities: { text: true, image: Boolean(extra?.imageEndpoint) },
    modalityRules: extra?.imageEndpoint
      ? { image: extra.imageRule ?? { modelIdPattern: "^(dall-e|flux|sd|imagen|seedream|nano-banana)" } }
      : undefined,
    provenance: { origin: "builtin-template", generatorModel: null, createdAt: "1970-01-01T00:00:00Z" },
  };
}

function anthropicCompat(baseUrl: string): AdapterManifest {
  // Anthropic messages dialect: x-api-key auth (the secret), a static anthropic-version
  // header, /v1/messages, and message_stop terminates the stream. All declarative in the
  // v1.1 grammar — no code path of its own.
  return {
    manifestVersion: 1,
    kind: "declarative",
    dialect: "anthropic-messages-v1",
    provider: {
      baseUrl,
      auth: { headers: [{ name: "x-api-key" }] },
    },
    endpoints: {
      listModels: { method: "GET", path: "/models", map: { models: "$.data[*].id", raw: "$.data[*]" } },
      generateText: {
        method: "POST",
        path: "/messages",
        headers: { "anthropic-version": "2023-06-01" },
        requestTemplate: {
          model: "{{model}}",
          // v1.1 amendment (2026-09-30): system messages are hoisted OUT of `messages` and
          // assembled into the top-level `system` field — Anthropic has no `system` role in
          // its messages array. The `messagesRoleMap` declares this (system->null), and the
          // interpreter's `normalizeDialectMessages` does the hoisting at render time.
          messages: "{{messages}}",
          system: "{{system?}}",
          stream: "{{stream}}",
          max_tokens: "{{maxTokens}}", // anthropic REQUIRES max_tokens — not optional here
          // v1.1 amendment: translate the internal OpenAI tool_choice (string "auto"/"none" or
          // {type:"function",function:{name}}) into Anthropic's object form via `toolChoiceMap`.
          //   "none"  -> {type:"const", value:"none"}      (never call tools)
          //   "auto"  -> {type:"const", value:"any"}       (let the model decide; Anthropic's "auto")
          //   "function" -> {type:"tool", name:"<fn>"}     (require exactly this tool)
          tools: "{{tools?}}",
          tool_choice: "{{toolChoice?}}",
        },
        messagesRoleMap: {
          // OpenAI roles -> Anthropic roles. `null` for "system" means HOIST to the system field.
          user: "user",
          assistant: "assistant",
          system: null,
          // Anthropic models tool results as `user` turns. The tool_call_id is dropped because
          // Anthropic's turn-by-turn shape carries no such concept.
          tool: "user",
        },
        systemField: "system",
        // v1.1 amendment (2026-10-01): Anthropic carries an image as a base64 `source` block and a
        // text part as a plain `{type:"text",text}`. There is no data-URI here — the media type and
        // the bytes are separate fields, which is why `ContentPart` keeps them separate too.
        contentPartTemplates: {
          text: { type: "text", text: "{{text}}" },
          image: {
            type: "image",
            source: { type: "base64", media_type: "{{mediaType}}", data: "{{dataBase64}}" },
          },
        },
        toolChoiceMap: {
          // "none" = never call tools → Anthropic's const "none"
          none: { type: "const", value: "none" },
          // "auto" = let the model decide → Anthropic's const "any" (its name for "auto")
          auto: { type: "const", value: "any" },
          // "function" (require specific tool) → Anthropic's {type:"tool", name:"<fn>"}
          // The `{{toolChoice.function.name}}` placeholder is rendered by `renderToolChoiceTemplate`
          // against the original OpenAI tool_choice object.
          function: { type: "tool", name: "{{toolChoice.function.name}}" },
        },
        responseMap: {
          // **The path is the block ARRAY, not block 0.** `content` is a mixed array and which
          // block leads is the provider's choice; a reasoning model puts its `thinking` block
          // first, so `$.content[0].text` is `undefined` on a perfectly good response and the
          // caller receives empty text. Measured 2026-09-29 on `agentrouter.org`. The interpreter
          // selects the text blocks — see `selectText`.
          text: "$.content",
          usage: "$.usage",
          // Non-stream: `content` is a MIXED array (text blocks + tool_use blocks). The
          // jsonpath subset has no filter expressions, so the interpreter filters by
          // block type — see emitToolCalls.
          toolCalls: "$.content",
        },
        // v1.1: where Anthropic puts its finish reason. Non-stream: `stop_reason` is top-level.
        // Stream: Anthropic delivers it on the `message_delta` event as `stop_reason`.
        responseFinish: "$.stop_reason",
        stream: {
          protocol: "sse",
          // content_block_delta events carry {delta:{text}}
          chunkMap: { delta: "$.delta.text" },
          errorMap: { "$.error": "PASS_THROUGH" },
          stopWhen: { path: "$.type", equals: "message_stop" },
          // Anthropic nests `stop_reason` under `delta` on `message_delta` events (unlike the
          // non-stream body where it is top-level). The `responseFinish` selector targets the
          // non-stream shape; `stream.finish` targets the streaming chunk so the reason is
          // captured before the terminating `message_stop` halts the loop.
          finish: "$.delta.stop_reason",
          // Tool use is split across events: content_block_start carries id+name, then one
          // content_block_delta per input_json_delta fragment of the arguments JSON.
          toolCallStream: {
            start: {
              when: { path: "$.content_block.type", equals: "tool_use" },
              id: "$.content_block.id",
              name: "$.content_block.name",
              index: "$.index",
            },
            delta: {
              when: { path: "$.delta.type", equals: "input_json_delta" },
              partial: "$.delta.partial_json",
              index: "$.index",
            },
          },
        },
      },
    },
    capabilities: { text: true, image: false },
    limits: { maxOutputTokens: 8192 },
    provenance: { origin: "builtin-template", generatorModel: null, createdAt: "1970-01-01T00:00:00Z" },
  };
}

/**
 * Gemini's native GenerateContent dialect. The model rides in the PATH (`{{model}}`), streaming
 * happens at a different endpoint (`:streamGenerateContent?alt=sse`) than the unary call, and the
 * usage block speaks its own field names — all three are grammar features this dialect is the
 * reason for. Text only, no tools in v1: function calling exists upstream but its parts-framing
 * has no declarative mapping yet, so the template simply never reports tool calls.
 */
function geminiCompat(baseUrl: string): AdapterManifest {
  return {
    manifestVersion: 1,
    kind: "declarative",
    dialect: "gemini-generate-v1",
    provider: {
      baseUrl,
      auth: { headers: [{ name: "x-goog-api-key" }] },
    },
    endpoints: {
      // `name` entries look like `models/gemini-2.0-flash`, which is exactly the path segment
      // `{{model}}` needs — `/v1beta/{{model}}:generateContent` reassembles without surgery.
      listModels: { method: "GET", path: "/v1beta/models", map: { models: "$.models[*].name", raw: "$.models[*]" } },
      generateText: {
        method: "POST",
        path: "/v1beta/{{model}}:generateContent",
        streamPath: "/v1beta/{{model}}:streamGenerateContent?alt=sse",
        requestTemplate: {
          // v1.1 amendment: Gemini's generateContent has no `system` parameter (unlike
          // Anthropic). System messages are hoisted by `normalizeDialectMessages` (system->null
          // in the role map) but, with no `systemField` declared, `systemContent` comes back
          // undefined and the template simply omits it. The role map still translates
          // assistant->model and tool->user.
          contents: "{{messages}}",
          // v1.1 amendment (2026-10-01): tool declarations. Gemini reads
          // `tools: [{functionDeclarations: [… ]}]` and does **not** read OpenAI's
          // `{type:"function", function:{…}}` wrapping, so before this the tools array was sent and
          // ignored: the model was never told it had any tools. The array's container is declared
          // as `toolDeclarationWrapper` below (an array literal is not expressible in a template),
          // and the per-declaration shape as `toolDeclarationTemplates`.
          tools: "{{tools?}}",
          // Gemini's tool_choice is not a string either — it is `toolConfig.functionCallingConfig`.
          // Without this the OpenAI value would be forwarded as `tool_choice`, which Gemini rejects
          // as an unknown field.
          toolConfig: "{{toolChoice?}}",
          // GenerationConfig carries the knobs the dialect names differently; `maxOutputTokens`
          // is required to be nested, not top-level.
          generationConfig: {
            maxOutputTokens: "{{maxTokens?}}",
            temperature: "{{temperature?}}",
          },
        },
        // One declaration, no `type`/`function` wrapping, `parameters` always present (Gemini
        // rejects a declaration without a parameter schema). Mirrors `declaration_to_openai` in
        // core/gateway_gemini.rs, which performs this same mapping in the other direction.
        toolDeclarationTemplates: {
          function: { name: "{{name}}", description: "{{description}}", parameters: "{{parameters}}" },
        },
        // `tools` is `repeated Tool`, and each Tool carries its own `repeated functionDeclarations`.
        // One container holding every declaration is the form Google documents.
        toolDeclarationWrapper: { functionDeclarations: "{{declarations}}" },
        // v1.1 amendment (2026-10-01): tool_choice, likewise. Gemini's is not a string but
        // `toolConfig.functionCallingConfig.mode`, and a bare "auto" forwarded as `toolConfig` is an
        // unknown-field 400 — which is what the agent loop sends on every tool-enabled request, so
        // this mapping is what makes agent mode reach Gemini at all. Mirrors `tool_choice_to_openai`
        // in core/gateway_gemini.rs (AUTO|ANY|NONE plus an optional forced name).
        toolChoiceMap: {
          none: { functionCallingConfig: { mode: "NONE" } },
          auto: { functionCallingConfig: { mode: "AUTO" } },
          required: { functionCallingConfig: { mode: "ANY" } },
          function: {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: ["{{toolChoice.function.name}}"],
            },
          },
        },
        messagesRoleMap: {
          // Gemini uses `model` for what OpenAI calls `assistant`.
          user: "user",
          assistant: "model",
          // System has no channel on Gemini's generateContent — hoist but discard.
          system: null,
          // Gemini wraps tool results as `user` turns.
          tool: "user",
        },
        // v1.1 amendment (2026-10-01): Gemini's parts carry no `type` at all — the shape itself is
        // the discriminator (`{text}` vs `{inlineData}`), which is why these are per-part templates
        // rather than one fixed structure with a type field to fill in.
        //
        // `toolCall`/`toolResult` are the same idea applied to a *replayed* tool turn. Gemini
        // addresses a tool result to the tool's NAME, which is why the shaper resolves it from the
        // assistant turn that declared the call; and `args`/`response` must be objects, which is
        // why the shaper offers `argumentsObject`/`response` beside the raw strings.
        contentPartTemplates: {
          text: { text: "{{text}}" },
          image: { inlineData: { mimeType: "{{mediaType}}", data: "{{dataBase64}}" } },
          toolCall: { functionCall: { name: "{{name}}", args: "{{argumentsObject}}" } },
          toolResult: { functionResponse: { name: "{{name}}", response: "{{response}}" } },
        },
        // Gemini names a message's content `parts`, and it must be an array of parts even for plain
        // text. Without this declaration every Gemini request carried `content` — a field its
        // generateContent API does not read — so it received no conversation at all. Found while
        // wiring image input (2026-10-01).
        contentField: "parts",
        // Declared (even though empty) so the interpreter knows system hoisting is a no-op
        // rather than "this dialect has no role map at all".
        responseMap: {
          // `parts` is an array; selectText joins the text parts the same way it does for
          // Anthropic's content blocks.
          text: "$.candidates[0].content.parts",
          usage: "$.usageMetadata",
          usageKeys: {
            prompt: "promptTokenCount",
            completion: "candidatesTokenCount",
            cached: "cachedContentTokenCount",
          },
          // v1.1 amendment (2026-10-01): where a tool call sits, and how to read one. A Gemini part
          // is `{functionCall:{name, args}}` with NO `type` — so the discriminator is presence, and
          // `args` is already an object rather than JSON text. Without these two declarations a
          // functionCall part reached the loop as a nameless, argument-less call and the model's
          // request to run a tool was lost without a word.
          toolCalls: "$.candidates[0].content.parts",
          toolCallShape: {
            discriminator: { path: "functionCall", present: true },
            name: "functionCall.name",
            arguments: "functionCall.args",
            argumentsFormat: "object",
            // Gemini sends a complete call per part; there is nothing to concatenate.
            streamedAs: "whole",
          },
        },
        responseFinish: "$.candidates[0].finishReason",
        stream: {
          protocol: "sse",
          // The same `parts` path the unary read uses, and deliberately so: a streamed functionCall
          // is the same shape as a unary one, which is what `streamedAs: "whole"` tells the
          // interpreter — read each event's calls through `toolCallShape`, do not accumulate
          // fragments.
          chunkMap: { delta: "$.candidates[0].content.parts", toolCalls: "$.candidates[0].content.parts" },
          errorMap: { "$.error": "PASS_THROUGH" },
          // No [DONE] sentinel: the server closes the SSE when the turn is over, and
          // finishReason arrives on the last content chunk.
          stopWhen: { path: "$.candidates[0].finishReason", equals: "STOP" },
        },
      },
    },
    capabilities: { text: true, image: false },
    provenance: { origin: "builtin-template", generatorModel: null, createdAt: "1970-01-01T00:00:00Z" },
  };
}

export const BUILTIN_TEMPLATES = {
  "openai-compat": openaiCompat,
  "anthropic-compat": anthropicCompat,
  "gemini-compat": geminiCompat,
} as const;

export type BuiltinTemplateId = keyof typeof BUILTIN_TEMPLATES;

/**
 * Profiles for the three sketch providers. baseUrl values were pinned by the Phase 0
 * provider-facts spike (DECISIONS.md). b.ai uses the anthropic-compat dialect; OpenRouter and
 * OpenCode Zen are OpenAI-compatible.
 */
export const PROVIDER_PROFILES: Record<string, () => AdapterManifest> = {
  openrouter: () =>
    openaiCompat("https://openrouter.ai/api/v1", {
      textHeaders: { "HTTP-Referer": "{{appUrl}}", "X-Title": "AI-Provider Router" },
      imageEndpoint: true,
      // OpenRouter serves image generation from its own Image API, NOT /images/generations.
      imagePath: "/images",
      // OpenRouter namespaces every id (google/gemini-2.5-flash-image), so an id pattern can
      // never classify it — declared id patterns match zero of its 444 models. Its catalog
      // states the capability instead: architecture.output_modalities. Matching element [0]
      // (PRIMARY output) rather than array membership keeps `openrouter/auto` and
      // `auto-beta` — output ["text","image" in that order] — text models, where they belong;
      // the 9 genuine image models lead with "image".
      imageRule: { rawMatch: { path: "$.architecture.output_modalities[0]", contains: "image" } },
    }),
  opencode: () => openaiCompat("https://opencode.ai/zen/v1", { imageEndpoint: false }),
  "b.ai": () => anthropicCompat("https://api.b.ai/v1"),
  /**
   * AgentRouter — an aggregator serving **both** dialects on one host. That single fact is why it
   * cannot be fingerprinted (see `profileForBaseUrl`) and why its dialect is pinned here instead.
   *
   * Measured 2026-09-29 against `agentrouter.org`:
   *
   *  - `GET /v1/models` → `{data:[{id, …, supported_endpoint_types:[…]}]}`; each model names the
   *    endpoints it serves, and `deepseek-v4-flash` lists `["openai","anthropic"]`.
   *  - `POST /v1/messages` (anthropic) → `200` with a real `content` block array.
   *  - `POST /v1/chat/completions` (openai) → `200` whose `content` is **`""`**, with the model's
   *    output in `reasoning_content`. An openai-compat manifest reads text from
   *    `$.choices[0].message.content`, so this route yields empty text through this product.
   *
   * The Anthropic route is therefore the one that works, and that is what this profile pins.
   *
   * **It deliberately carries no `User-Agent`.** The gateway refuses an unrecognised client with
   * `401 unauthorized_client_error` before reading any credential, and a header naming a client it
   * does accept clears that. *Which* client to name is the operator's decision, not a default this
   * product should apply on their behalf — the same line `client-gate.ts` draws when it declines to
   * name a User-Agent in its notice. Auto setup collects it from the operator at the gate panel and
   * applies it to every endpoint; the provider edit form keeps it from then on.
   */
  agentrouter: () => anthropicCompat("https://agentrouter.org/v1"),
};

/** Display names for the profiles above — one source of truth, so the add form cannot drift. */
export const PROVIDER_PROFILE_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  "b.ai": "b.ai",
  agentrouter: "AgentRouter",
};

/**
 * The profile whose base-URL **host** matches `baseUrl`, if there is one.
 *
 * # Why a host lookup exists at all
 *
 * The dialect fingerprinter decides from unauthenticated probes, and there is a shape it provably
 * cannot decide: a host that serves both `/messages` and `/chat/completions`. Its anthropic rule is
 * "a messages endpoint exists **and** no chat-completions" — a negative test, which a dual-dialect
 * aggregator fails by construction. Measured 2026-09-29: probing `agentrouter.org` with the
 * client-gate header supplied returns `401` on both routes, so both "exist", and the verdict is
 * `unknown` with the evidence `["chat/completions endpoint exists","messages endpoint exists"]`.
 *
 * Nothing in an unauthenticated probe can break that tie, so this does not try. It answers a
 * different, answerable question instead: *is this a host whose dialect we have already measured?*
 * For those, the measured answer beats a guess.
 *
 * # The match is on the whole hostname, never a suffix
 *
 * `agentrouter.org.evil.test` is a different host and must not match `agentrouter.org`. Comparing
 * whole hostnames after `URL` parsing is what makes that true — a `endsWith`/`includes` test would
 * hand a lookalike the profile's wiring.
 */
/**
 * Which builtin template a profile was built from, by the dialect string on its manifest.
 *
 * Two entries, kept here beside the templates that define those strings rather than in the caller:
 * a caller that mapped dialects to template ids would hold a copy of a fact this module owns.
 */
const TEMPLATE_BY_DIALECT: Record<string, BuiltinTemplateId> = {
  "openai-chat-v1": "openai-compat",
  "anthropic-messages-v1": "anthropic-compat",
  "gemini-generate-v1": "gemini-compat",
};

export function profileForBaseUrl(
  baseUrl: string,
): { slug: string; templateId: BuiltinTemplateId; manifest: AdapterManifest } | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined; // not a URL — the caller validates separately, and a guess helps nobody
  }
  for (const slug of Object.keys(PROVIDER_PROFILES)) {
    const build = PROVIDER_PROFILES[slug]!;
    let profileHost: string;
    try {
      profileHost = new URL(build().provider.baseUrl).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (profileHost !== host) continue;
    const manifest = build();
    const templateId = TEMPLATE_BY_DIALECT[manifest.dialect];
    // A profile whose dialect has no template is a wiring error, not a runtime condition — but it
    // is answered with "no profile" rather than a throw, because this runs inside setup, where the
    // cost of being wrong is a wizard that cannot be completed at all.
    if (!templateId) continue;
    return { slug, templateId, manifest };
  }
  return undefined;
}
