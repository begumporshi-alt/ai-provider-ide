# COUNT_TOKENS_PLAN — add `/v1/messages/count_tokens` to the local gateway

Date: 2026-09-22
Status: ✅ IMPLEMENTED
Owner: Jarvi

## Why

Claude Code (and other Anthropic-SDK clients) call `POST /v1/messages/count_tokens` to
estimate input size before sending a real `messages` request — to respect context windows,
budget tokens, and pre-flight the prompt. Our gateway has no such route:

- Route table (`gateway.rs:1716-1722`) defines six routes. `count_tokens` is not among them.
- A hit on that path falls to `unknown_route` (`gateway_handlers.rs:274`), which authenticates
  then returns `404 {"route not found","not_found","unknown_route"}`.
- So every token-count call a Claude-Code-style client makes against our gateway gets a 404.

External evidence this is a real surface, not hypothetical: the community `claude-code-proxy`
implements `POST /v1/messages/count_tokens` with a 4-chars-per-token estimation — a proxy only
implements what its client actually calls.

Severity is low–medium: Claude Code tolerates a missing/unavailable count endpoint by falling back
to its own estimate, which is why the missing route did not surface as the visible ZCode symptom
(the 429s did). But it is still unprofessional to 404 every count call, and a client that does not
gracefully fall back would break.

## Approach: estimate locally, no upstream round-trip

Count tokens *in the gateway* and answer immediately. Do **not** forward to a provider's
count endpoint:

- No upstream dependency — the route works even when no provider is healthy.
- No latency — a count call should be near-instant; forwarding to a model adds seconds.
- Matches the community-proxy behaviour (pure estimation).
- The Anthropic endpoint itself is an estimate; providers do not expose exact counts for the
  structured content shape. Accuracy is the least of the goals here — the point is that a client
  gets a *number it can reason about* instead of a 404.

Estimation formula (kept deliberately simple and matching the reference proxy):
`tokens ≈ ceil(total_text_chars / 4)`, over the same text the request would actually send.

## What text to count

Count the same content the real request carries, i.e. everything `to_chat_body`
(`gateway_anthropic.rs:112`) would forward:

1. `system` — either a bare string, or an array of `{"text": ...}` content blocks (Claude Code
   sends the array form).
2. `messages[]` — for each message, `content`:
   - bare string → count it;
   - array of blocks → count each block's `text` field:
     - `type:"text"` → `text`
     - `type:"tool_use"` → the serialized `input` + `name` (the call's payload is real tokens)
     - `type:"tool_result"` → its `content` (string, or array of text blocks)
     - `type:"image"` → add a fixed image-budget constant (see below)
   - drop `cache_control` markers (non-tokens, per existing convention).

This mirrors `to_chat_body` so the estimate tracks what actually gets sent. Do **not** reuse
`to_chat_body` directly (it returns an OpenAI-normalized body and returns `Option`, swallowing
the missing-`model` case); instead add a small `count_text_chars(&Value) -> usize` helper that
walks the raw Anthropic `system` + `messages` and sums characters. That keeps the count
independent of translation success.

### Image handling

Images are not 4-chars-per-token. Use a flat per-image constant, as a documented approximation:
`IMAGE_TOKENS = 1024` per `type:"image"` block (conservative; real values vary by size/aspect and
Anthropic bills by bucketed pixel bands, but a fixed constant is sufficient for a pre-flight
estimate and matches what lightweight proxies do). Note it in the code so it is easy to tune.

## Endpoint contract

Request body (subset of the Anthropic count_tokens shape we care about):
```json
{ "model": "…", "system": "…|[…]", "messages": [ … ], "tools": [ … ] }
```
`tools` also costs input tokens when present. If `tools` is non-empty, fold each tool's JSON text
in at the same 4-chars/token rate — tools are part of the prompt bytes the model sees.

Response:
```json
{ "input_tokens": <number> }
```
The Anthropic `count_tokens` response is `{"input_tokens": N}`. Return exactly that. Status 200.

## Code locations (all in `apps/desktop/src-tauri/src`)

1. `gateway_anthropic.rs`
   - `fn count_text_chars(req: &Value) -> usize` — walk `system` + `messages` (+ `tools`), sum chars,
     plus `IMAGE_TOKENS` per image block. Pure function, testable.
   - `pub(crate) async fn count_tokens_h(State(core), headers, body) -> Response` —
     - `check_gateway_key` → `r.anthropic()` (auth before any work, invariant 10, mirrors
       `messages_h`/`unknown_route`).
     - parse body to `Value`; on parse failure → `err(BAD_REQUEST, anthropic_error("invalid JSON body","invalid_request_error"))`.
     - `model` is *accepted but unused* (count is model-agnostic); do not reject an unknown model —
       a count call should not 404 on model id, so clients can probe freely.
     - compute `input_tokens = count_text_chars(&req) / 4` (integer division is fine for an estimate;
       use `saturating` math so a 0-char body yields 0, not a panic).
     - return `(StatusCode::OK, axum::Json(json!({"input_tokens": n}))).into_response()`.

2. `gateway.rs` (route registration, ~line 1720)
   - Add `.route("/v1/messages/count_tokens", post(count_tokens_h))` to the `axum::Router::new()`
     chain, next to the existing `.route("/v1/messages", post(messages_h))`.
   - Add `count_tokens_h` to the `anthropic::` use list (`gateway.rs:1618` imports
     `anthropic::messages_h`; add the new symbol).
   - Order matters: register `/v1/messages/count_tokens` so it is matched before the `fallback`;
     axum matches on full path, so no conflict with `/v1/messages`.

## What must NOT change

- The router core stays provider-agnostic — this is edge-dialect translation, symmetric to the
  other Anthropic ingress (DECISIONS.md 2026-09-16 note in `gateway_anthropic.rs:22`).
- No new dependencies (only `serde_json::json!`, already imported).
- No ledger entry: `count_tokens` is a no-cost probe; the ledger records billed model calls, not
  estimates. Do **not** add a ledger row or `tokens_in` here.
- No retry-after: success path returns 200; the only non-200 is the gate refusal, which already
  carries `retry_after` via `GateRefusal` — reuse `r.anthropic()`, don't invent a new one.

## Testing (Rust, in the existing `gateway` test module)

Place under `gateway_tests.rs` (the `#[cfg(test)]` module wired at `gateway.rs:1623`).

1. **Basic count** — POST a body with `system` string + two string `messages`, known length; assert
   `input_tokens == ceil(chars/4)`.
2. **system as block array** — Claude Code's array form; assert it counts the concatenated text.
3. **tool_use block** — message content array with a `tool_use`; assert its `input` JSON chars are
   counted.
4. **image block** — one `type:"image"` block; assert it contributes the flat `IMAGE_TOKENS`.
5. **auth gate** — no/invalid key → 401 `authentication_error` envelope (proves auth precedes work).
6. **malformed body** — invalid JSON → 400 `invalid_request_error`.
7. **tools counted** — body with `tools` array; assert folding them in raises the count.

Build the router the same way the existing handler tests do (bind `axum::Router` on a
`tokio` port, or call the handler via `Router::new().route(…).into_make_service()` + a test
client — match the established pattern in `gateway_tests.rs` rather than inventing one).

Falsification discipline: before trusting each test, confirm it fails without the new route
(i.e. the first run against a router that does *not* register `count_tokens` returns 404 — that
is the regression guard that the fix exists at all).

## Build / verify

- `PATH="$HOME/.cargo/bin:$PATH"` prefix on the cargo gate — cargo is not on default PATH here
  (`FAILED (1): Rust (cargo missing)` otherwise).
- `pnpm ci:local` is the full gate (core 241 · vitest 193 · Rust `--lib` 470 · browser 98).
  For a targeted run: `cargo test -p <desktop crate>` filtered to the new tests, then `cargo test --lib`.
- Confirm the route is live. **Take the port from Control → Local Gateway, not from `DEFAULT_PORT`**:
  the compiled default is `8787` (`gateway.rs:33`) but it is overridden by `settings.gateway`, which
  on this machine is `8800` — so a hardcoded `8787` targets whatever else holds that port.
  ```
  PORT=$(sqlite3 "file:$HOME/Library/Application Support/dev.aiprovider.router/ai-provider-router.db?mode=ro" \
    "SELECT json_extract(value_json,'$.port') FROM settings WHERE key='gateway';")
  curl -s -X POST "http://127.0.0.1:$PORT/v1/messages/count_tokens" -H "Authorization: Bearer <master>" -H "Content-Type: application/json" -d '{"model":"x","messages":[{"role":"user","content":"hello world"}]}'
  ```
  must return `{"input_tokens": N}`, not 404.

## Effort

Small. One pure helper (~30 lines), one handler (~25 lines), one `.route(...)` line, one import.
No schema, no migration, no core change. The tests are the bulk of the work.
