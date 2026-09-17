# Gateway Flexibility Improvement Plan

**Goal:** Make the AI-Provider IDE gateway flexible enough to serve WorkBuddy, Claude Code, Codex, zcode/z.ai, Cursor, and any other OpenAI-compatible AI coding IDE — by adopting proven patterns from OmniRoute's gateway architecture.

**Date:** 2026-09-17
**Reference:** OmniRoute v3.8.50 (shallow clone at `/tmp/OmniRoute`)

---

## 1. Current State

Our gateway is a thin relay between external clients and the router core:

- **Rust side** (`apps/desktop/src-tauri/src/gateway_cmds.rs`): HTTP server on `127.0.0.1:{port}/v1`, master-key auth, event bridge to webview.
- **Webview side** (`apps/desktop/src/gateway-bridge.ts`): Receives `gateway-request` events, calls `router.generateText()`, streams text chunks back.
- **Router core** (`packages/router-core/src/execution-engine.ts`): Forwards `tools`, `toolChoice`, `responseFormat`, `onToolCall` to upstream adapters.
- **Supported endpoints:** `/v1/chat/completions`, `/v1/models`, `/v1/images/generations`.

**What's missing:**
- No request normalization (roles, tool schemas, message shapes).
- No response translation (SSE tool-call reassembly, reasoning content, finish_reason).
- No client-specific adaptations (Claude Code tool names, Codex Responses API, z.ai quirks).
- No `stream: false` support in the bridge (`generateText` always streams).
- No `/v1/responses` endpoint (needed by Codex and newer OpenAI clients).
- Tool calls from upstream are received via `onToolCall` but are **not forwarded** to the gateway client — only text chunks are streamed back.
- No JSON 404 for unknown `/v1/*` routes (catches fall through to HTML 404).

This is why WorkBuddy using `mercury-2.5` through our gateway receives **no real tools** — the gateway forwards them upstream, but when the model emits tool calls, they are swallowed on the return path. The model then hallucinates pseudo-tool-call markup (`<|tool_call_start|>`, `execute_command`) because it was trained on tool transcripts but has no structured tool channel.

---

## 2. What OmniRoute Does Differently

OmniRoute's gateway serves 352+ providers to clients including Claude Code, Codex, Cursor, Cline, and Copilot. Its flexibility comes from **10 architectural patterns** we should adopt:

| # | Pattern | OmniRoute Implementation | Our Gap |
|---|---------|--------------------------|---------|
| 1 | **Hub-and-spoke translator** | `translateRequest`: source format -> OpenAI -> target format. `translateResponse`: target -> OpenAI -> source. | No translation layer at all. |
| 2 | **Multi-format SSE parser** | `parseSSEToOpenAIResponse`, `parseSSEToClaudeResponse`, `parseSSEToResponsesOutput` — each accumulates tool_calls, reasoning, usage. | Only raw text chunks forwarded. |
| 3 | **Role normalizer** | `normalizeRoles`: developer->system, system->user for incompatible providers, model->assistant, GLM-version-aware. | No role normalization. |
| 4 | **Tool schema sanitizer** | `sanitizeOpenAITool`: strips null from enum, ensures root `type: "object"`, flattens tuple items, keeps `additionalProperties` open. | Tool schemas forwarded as-is; strict upstreams reject them. |
| 5 | **Tool-call safety pipeline** | `ensureToolCallIds`, `fixMissingToolResponses`, `stripOrphanedToolResults`, `coerceToolSchemas`. | No tool-call hygiene. |
| 6 | **Client-specific adaptations** | Claude Code: tool-name remapping (TitleCase), third-party cloak. Codex: Responses API normalization. z.ai: dedicated executor. | No client detection or adaptation. |
| 7 | **Reasoning replay cache** | Re-injects `reasoning_content` for DeepSeek/Kimi/Qwen thinking models on multi-turn. | No reasoning handling. |
| 8 | **Client-aware request threading** | `_targetFormat`, `_provider`, `_preserveCacheControl`, `_ensureUserTurn` flags via credentials object. | No client-context threading. |
| 9 | **Robust SSE streaming** | `withEarlyStreamKeepalive`, startup/error/keepalive frames, abort propagation. | Basic streaming only. |
| 10 | **Responses API support** | Full `/v1/responses` endpoint with `input`, `max_output_tokens`, `reasoning`, `store`, `function_call` item reassembly. | Only Chat Completions. |

---

## 3. Implementation Plan

### Phase 1: Request Normalization Layer (Foundation)

**Goal:** Sanitize and normalize every incoming request before it reaches the router core.

#### 3.1 Create `packages/router-core/src/gateway-normalizer.ts`

A pure-function normalization pipeline (no I/O, fully testable):

```typescript
export interface NormalizeOptions {
  /** Detected client type from User-Agent / headers */
  clientHint?: "workbuddy" | "claude-code" | "codex" | "zcode" | "cursor" | "generic";
  /** Provider the request will be routed to (for provider-specific quirks) */
  targetProvider?: string;
  /** Model native id */
  targetModel?: string;
  /** Preserve OpenAI developer role (default: false for non-OpenAI providers) */
  preserveDeveloperRole?: boolean;
  /** Preserve cache_control markers (for Claude Code) */
  preserveCacheControl?: boolean;
}

export function normalizeGatewayRequest(
  body: Record<string, unknown>,
  opts: NormalizeOptions
): Record<string, unknown>;
```

**Pipeline steps (in order):**

1. **Role normalization** (`normalizeRoles`)
   - `developer` -> `system` unless `preserveDeveloperRole` AND target is OpenAI-compatible.
   - `model` -> `assistant`.
   - `system` -> merge into first `user` message for providers that reject it (configurable per provider).
   - Ensure system message is at index 0 for strict providers.

2. **Tool-call id safety** (`ensureToolCallIds`)
   - Every `tool_calls` entry in assistant messages must have an `id`.
   - Generate deterministic ids if missing (hash of index + name + args prefix).
   - Normalize to 9-char ids for providers like Mistral (configurable).

3. **Tool response hygiene** (`fixMissingToolResponses`, `stripOrphanedToolResults`)
   - If a tool call lacks a matching tool result, insert an empty `{"role": "tool", "content": ""}` placeholder.
   - Strip orphaned tool results that have no matching tool call in the preceding assistant turn.

4. **Tool schema sanitization** (`sanitizeOpenAITools`)
   - Recursively walk JSON Schema in each tool's `parameters`:
     - Strip `null`/`undefined` from `enum` arrays.
     - Ensure root `type: "object"` if missing and no `anyOf`/`oneOf`/`allOf`.
     - Coerce tuple-form `items: [...]` to single schema.
     - Keep opaque object schemas open (`properties: {}`, `additionalProperties: true`).
     - Filter `required[]` to keys that exist in `properties`.
   - Sanitize tool descriptions (strip markdown images, truncate if >1024 chars for strict providers).

5. **Message shape fixes**
   - If `messages` is missing but `input` is present (Responses API shape), promote `input` -> `messages`.
   - Convert string `content` to `[{type: "text", text: content}]` for providers that require array form.
   - Ensure last message role is `user` before adding tool results (some providers require user turn after tool calls).

6. **Client-specific request adaptations**
   - **Claude Code**: Remap tool names lowercase -> TitleCase (`bash` -> `Bash`, `read` -> `Read`, ...). Track renames in `_toolNameMap` for response restoration. Skip Anthropic server-side tool types (`web_search_20250305`, `bash_20250124`, ...).
   - **Codex**: Promote `reasoning_effort` -> `reasoning: {effort}`. Handle `store` marker. Map `max_completion_tokens` -> `max_output_tokens`.
   - **zcode/z.ai**: Ensure at least one `user` turn exists (GLM-family rejects message arrays with no user role). Convert `developer` -> `system` unconditionally.

**Test strategy:** Pure functions = fast unit tests. Cover every pipeline step with edge cases (empty messages, missing tool ids, malformed schemas, enum with nulls).

#### 3.2 Wire normalizer into gateway bridge

In `apps/desktop/src/gateway-bridge.ts`, before calling `router.generateText()`:

```typescript
import { normalizeGatewayRequest, detectClient } from "@aiprovider/router/gateway-normalizer";

// Detect client from headers (passed through by Rust gateway)
const clientHint = detectClient(req.headers);
const normalizedBody = normalizeGatewayRequest(req.body, {
  clientHint,
  // targetProvider / targetModel resolved by router after planning
});
```

The Rust gateway must forward select headers (User-Agent, X-Client-Name, etc.) in the `gateway-request` event payload.

---

### Phase 2: Response Translation & Tool-Call Reassembly

**Goal:** Parse upstream SSE into structured OpenAI-compatible chunks, reassemble tool calls, and forward them to the gateway client.

#### 2.1 Create `packages/router-core/src/gateway-sse-parser.ts`

Three parsers corresponding to the three upstream formats our adapters may return:

```typescript
export interface ParsedChunk {
  /** Text delta (may be empty string for tool-only chunks) */
  text?: string;
  /** Reasoning content delta (for thinking models) */
  reasoning?: string;
  /** Accumulated tool calls (complete when finish_reason === "tool_calls") */
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** Finish reason if this is the terminal chunk */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  /** Usage if present on terminal chunk */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Whether this is the terminal chunk */
  done?: boolean;
}

/** Parse a single SSE data line from an OpenAI Chat Completions stream */
export function parseOpenAIChatDelta(json: unknown, state: AccumulatorState): ParsedChunk | null;

/** Parse a single SSE data line from an Anthropic Messages stream */
export function parseClaudeDelta(json: unknown, state: AccumulatorState): ParsedChunk | null;

/** Parse a single SSE data line from an OpenAI Responses stream */
export function parseResponsesDelta(json: unknown, state: AccumulatorState): ParsedChunk | null;
```

**Accumulator state** (per-request, stored in gateway bridge):

```typescript
interface AccumulatorState {
  messageId: string | null;
  model: string | null;
  textBuf: string;
  reasoningBuf: string;
  toolCalls: Map<string, { id: string; index: number; type: string; function: { name: string; arguments: string } }>;
  finishReason: string | null;
  usage: unknown;
  // Claude-specific
  contentBlocks: Map<number, { type: string; text?: string; thinking?: string; inputJson?: string; id?: string; name?: string }>;
  // Responses-specific
  outputItems: Map<number, unknown>;
  funcArgsBuf: Record<string, string>;
}
```

**OpenAI Chat Completions accumulation logic** (from OmniRoute `sseParser.ts`):

```typescript
// For each delta.tool_calls[]:
const key = Number.isInteger(tc.index) ? `idx:${tc.index}` : `id:${String(tc.id)}`;
const existing = state.toolCalls.get(key);
if (!existing) {
  state.toolCalls.set(key, {
    id: tc.id != null ? String(tc.id) : null,
    index: Number.isInteger(tc.index) ? tc.index : state.toolCalls.size,
    type: tc.type || "function",
    function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" }
  });
} else {
  existing.id = existing.id || (tc.id != null ? String(tc.id) : null);
  if (tc.function?.name) existing.function.name = tc.function.name;
  existing.function.arguments += tc.function?.arguments || "";
}
```

**On terminal chunk** (finish_reason present or `[DONE]`):
- Sort tool calls by index.
- If any tool calls exist, set `finishReason: "tool_calls"`.
- Emit a special gateway chunk format that includes the complete tool_calls array.

#### 2.2 Adapt gateway bridge to emit structured chunks

Current bridge:
```typescript
for await (const chunk of exec.chunks) {
  await invoke("gateway_chunk", { requestId, text: chunk });
}
```

New bridge (conceptual):
```typescript
const state = initAccumulatorState();
for await (const rawChunk of exec.chunks) {
  const parsed = parseOpenAIChatDelta(JSON.parse(rawChunk), state);
  if (parsed?.text) {
    await invoke("gateway_chunk", { requestId, text: parsed.text });
  }
  if (parsed?.toolCalls && parsed.finishReason === "tool_calls") {
    await invoke("gateway_tool_calls", { requestId, toolCalls: parsed.toolCalls });
  }
  if (parsed?.usage) {
    await invoke("gateway_usage", { requestId, usage: parsed.usage });
  }
}
```

**Important:** The upstream adapter already returns OpenAI-shaped SSE (since our adapters normalize to OpenAI). So we only need the `parseOpenAIChatDelta` parser for the common case. The Claude/Responses parsers are needed when we add native Claude or Responses adapters later.

#### 2.3 Add `gateway_tool_calls` command to Rust

In `apps/desktop/src-tauri/src/gateway_cmds.rs`:

```rust
#[tauri::command]
pub fn gateway_tool_calls(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    tool_calls_json: String,
) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&tool_calls_json).map_err(|e| e.to_string())?;
    state.core.reply(request_id, BridgeMsg::ToolCalls(v));
    Ok(())
}
```

In `src/gateway/mod.rs` (or wherever `BridgeMsg` is defined), add:
```rust
enum BridgeMsg {
    Delta(String),
    ToolCalls(serde_json::Value),
    Result(serde_json::Value),
    Done,
    Error { status: u16, message: String },
}
```

The Rust HTTP handler then translates `BridgeMsg::ToolCalls` into an SSE chunk:
```
data: {"choices":[{"delta":{"tool_calls":[...]},"finish_reason":"tool_calls"}]}

data: [DONE]

```

For **non-streaming** requests (`stream: false`), the Rust side buffers all chunks and assembles a single JSON response with `choices[0].message.tool_calls`.

---

### Phase 3: Client Detection & Per-Client Adaptation

**Goal:** Detect which IDE client is calling and apply format-specific fixes.

#### 3.1 Client detection

Create `packages/router-core/src/gateway-client-detector.ts`:

```typescript
export type ClientHint = "workbuddy" | "claude-code" | "codex" | "zcode" | "cursor" | "generic";

export function detectClient(headers: Record<string, string>): ClientHint {
  const ua = (headers["user-agent"] || "").toLowerCase();
  if (ua.includes("workbuddy")) return "workbuddy";
  if (ua.includes("claude-code") || ua.includes("anthropic")) return "claude-code";
  if (ua.includes("codex") || headers["x-codex-client"] != null) return "codex";
  if (ua.includes("z.ai") || ua.includes("zcode")) return "zcode";
  if (ua.includes("cursor")) return "cursor";
  return "generic";
}
```

**Rust side:** Forward `User-Agent`, `X-Client-Name`, `X-Codex-Client`, and `Accept` headers in the `gateway-request` event.

#### 3.2 Per-client response adaptations

In `gateway-normalizer.ts` options, `clientHint` drives these behaviors:

| Client | Request Fix | Response Fix |
|--------|-------------|--------------|
| **Claude Code** | Tool names: lowercase -> TitleCase. Preserve `cache_control`. | Restore tool names: TitleCase -> lowercase via `_toolNameMap`. |
| **Codex** | Promote `reasoning_effort` -> `reasoning`. Map `max_completion_tokens` -> `max_output_tokens`. | Normalize `reasoning` blocks back to text. |
| **zcode/z.ai** | Ensure at least one `user` turn. `developer` -> `system`. | None specific. |
| **WorkBuddy** | No special request fix (uses OpenAI format natively). | Ensure `tool_calls` are complete before emitting `[DONE]`. |
| **Cursor** | Cursor-specific tool schema tweaks if needed. | None specific. |

---

### Phase 4: Responses API Endpoint (`/v1/responses`)

**Goal:** Support the OpenAI Responses API — required by Codex and newer clients.

#### 4.1 Add route in Rust gateway

In the Rust HTTP router, add `/v1/responses` -> same bridge, but set `kind: "responses"` in the `BridgeRequest`.

#### 4.2 Add handler in gateway bridge

```typescript
if (req.kind === "responses") {
  // Normalize Responses input shape -> Chat Completions shape
  const chatBody = responsesToChatCompletions(req.body);
  // ...then call router.generateText with normalized body
}
```

**Normalization** (`responsesToChatCompletions`):
- `input` (string | array) -> `messages` array.
- `max_output_tokens` -> `max_tokens`.
- `text.format` -> `response_format`.
- `reasoning.effort` -> `reasoning_effort`.
- `tools` (Responses shape: `{type: "function", name, parameters}`) -> Chat Completions shape: `{type: "function", function: {name, parameters}}`.
- `tool_choice: {type: "function", name}` -> `tool_choice: {type: "function", function: {name}}`.

**Response translation** (chat completions -> responses):
- `choices[0].message.content` -> `output[0].content[0].text`.
- `choices[0].message.tool_calls` -> `output[]` function_call items.
- `usage` -> `usage`.

This is a large item. It can be deferred until a concrete client requires it, but the bridge architecture should reserve the `kind: "responses"` path.

---

### Phase 5: Robustness & Observability

#### 5.1 JSON 404 for unknown routes

Add a catch-all handler in the Rust HTTP router (or in the webview bridge) that returns:
```json
{ "error": { "message": "Unknown API route: /v1/...", "type": "not_found", "code": "unknown_route" } }
```

#### 5.2 SSE keepalive frames

For slow upstreams, emit periodic SSE comments or empty deltas to prevent client timeouts:
```
:keepalive

data: {"choices":[{"delta":{},"index":0}]}

```

#### 5.3 Error-only SSE detection

If upstream returns `text/event-stream` with an error payload but no content chunks, extract the error message and return a proper JSON error instead of a generic 502.

#### 5.4 Request/response logging

Add a `gateway-logger` that logs normalized request shape and response metadata (without key material) for debugging client compatibility issues.

---

## 4. File-Level Implementation Checklist

### New files
- [ ] `packages/router-core/src/gateway-normalizer.ts` — request normalization pipeline
- [ ] `packages/router-core/src/gateway-normalizer.test.ts` — unit tests for normalizer
- [ ] `packages/router-core/src/gateway-sse-parser.ts` — SSE delta parsers + accumulator state
- [ ] `packages/router-core/src/gateway-sse-parser.test.ts` — unit tests for parsers
- [ ] `packages/router-core/src/gateway-client-detector.ts` — client detection from headers
- [ ] `packages/router-core/src/gateway-client-detector.test.ts` — tests for detection
- [ ] `packages/router-core/src/gateway-responses-translator.ts` — Responses <-> Chat Completions

### Modified files
- [ ] `apps/desktop/src/gateway-bridge.ts` — wire normalizer, parser, tool-call emission
- [ ] `apps/desktop/src-tauri/src/gateway_cmds.rs` — add `gateway_tool_calls`, forward headers
- [ ] `apps/desktop/src-tauri/src/gateway/mod.rs` — add `BridgeMsg::ToolCalls` variant
- [ ] `packages/router-core/src/model-router.ts` — expose `generateText` with `stream: false` option
- [ ] `packages/router-core/src/execution-engine.ts` — support `stream: false` in `executeText`

---

## 5. Testing Strategy

1. **Unit tests** (fast, no network):
   - Normalizer: every pipeline step with 10+ edge cases each.
   - SSE parser: feed recorded SSE streams from real providers, assert parsed chunks.
   - Client detector: every known UA string.

2. **Integration tests** (local gateway, mock upstream):
   - Start gateway, send requests with `curl`, assert responses.
   - Tool-call round-trip: send tools, receive tool_calls, send tool results, receive final text.

3. **Client compatibility tests** (end-to-end):
   - Configure WorkBuddy to use our gateway as custom provider. Run a skill creation task. Assert no pseudo-tool-call markup.
   - Configure Claude Code with our gateway. Run `claude` in a repo. Assert tool calls work.
   - Configure Codex CLI. Run `codex`. Assert Responses API works.

---

## 6. Appendix: OmniRoute Pattern Index

For reference, here is where each pattern lives in the OmniRoute source:

| Pattern | File | Lines |
|---------|------|-------|
| Hub-and-spoke translator | `open-sse/translator/index.ts` | 307-800 |
| SSE parser (OpenAI Chat) | `open-sse/handlers/sseParser.ts` | 160-305 |
| SSE parser (Claude) | `open-sse/handlers/sseParser.ts` | 311-491 |
| SSE parser (Responses) | `open-sse/handlers/sseParser.ts` | 640-834 |
| Role normalizer | `open-sse/services/roleNormalizer.ts` | 1-288 |
| Tool schema sanitizer | `open-sse/services/toolSchemaSanitizer.ts` | 1-182 |
| Tool-call helpers | `open-sse/translator/helpers/toolCallHelper.ts` | — |
| Claude Code tool remapper | `open-sse/services/claudeCodeToolRemapper.ts` | 1-478 |
| Client detection | `src/sse/handlers/chat.ts` (UA parsing) | — |
| Early stream keepalive | `open-sse/utils/earlyStreamKeepalive.ts` | — |
| Request admission / rate limiting | `src/shared/middleware/chatBodyAdmission.ts` | — |
| Proxy / authz pipeline | `src/proxy.ts` | 1-53 |
| Chat completions route | `src/app/api/v1/chat/completions/route.ts` | 1-283 |
| Catch-all 404 | `src/app/api/v1/[...omnirouteCatchAll]/route.ts` | 1-55 |
| Responses route | `src/app/api/v1/responses/route.ts` | — |

---

## 7. Immediate Next Steps

1. **Start with Phase 1** (`gateway-normalizer.ts`) — it is pure TypeScript, requires no Rust changes, and can be unit-tested immediately.
2. **Parallel: add `gateway_tool_calls` to Rust** — small surface change, unblocks Phase 2.
3. **Phase 2** (`gateway-sse-parser.ts`) — wire into bridge, test with mock upstream.
4. **Phase 3** (client detection) — add once a concrete client (WorkBuddy, Claude Code) is being tested.
5. **Phase 4** (Responses API) — defer until Codex or another Responses-native client is a priority.
