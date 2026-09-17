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
          text: "$.content[0].text",
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
      textHeaders: { "HTTP-Referer": "{{appUrl}}", "X-Title": "AI-Provider IDE" },
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
};
