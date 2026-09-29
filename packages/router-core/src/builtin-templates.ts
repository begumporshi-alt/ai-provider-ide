/**
 * builtin-templates (ARCHITECTURE.md L1) — static dialect manifests for the two grammars the
 * v1.1 spec freezes: openai-compat and anthropic-compat. Provider profiles are thin overlays
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
        responseMap: {
          text: "$.choices[0].message.content",
          usage: "$.usage",
          toolCalls: "$.choices[0].message.tool_calls",
        },
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
          messages: "{{messages}}",
          stream: "{{stream}}",
          max_tokens: "{{maxTokens}}", // anthropic REQUIRES max_tokens — not optional here
          // Anthropic's tool_choice is an object, not a string; pass-through, so the caller
          // supplies the dialect's own shape.
          tools: "{{tools?}}",
          tool_choice: "{{toolChoice?}}",
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
        stream: {
          protocol: "sse",
          // content_block_delta events carry {delta:{text}}
          chunkMap: { delta: "$.delta.text" },
          errorMap: { "$.error": "PASS_THROUGH" },
          stopWhen: { path: "$.type", equals: "message_stop" },
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

export const BUILTIN_TEMPLATES = {
  "openai-compat": openaiCompat,
  "anthropic-compat": anthropicCompat,
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
