# STAGE 2 PLAN — plumb longest key cooldown into client-facing Retry-After

Date: 2026-09-22
Status: **IMPLEMENTED, gated, falsified** — see "What shipped" at the end
Owner: Jarvi
Follows: COUNT_TOKENS_PLAN.md (stage 1, DONE)

## Problem statement

Stage 1 fixed the router *internally* — the health tracker now honours the provider's
`Retry-After` when recording per-key cooldowns. But the **client-facing** 429 still returns
`Retry-After: 1` when all keys are cooled, because `BridgeMsg::Error` carries only
`{status, message}` — no cooldown information crosses the Tauri boundary.

The `ensure_retry_after` middleware (`gateway.rs:1696-1705`) is the floor-setter: it inserts
`Retry-After: 1` on *any* 429 that has no existing header. Since no handler ever sets one,
the client always gets `1` regardless of the provider's actual ask. The ZCode burst
(seven 429s in thirteen seconds) is the symptom: the client honours `1`, retries at ~2 s
intervals, and gets hit by the provider again.

## What "plumb the longest key cooldown" means

When the TS core's health tracker reports all-keys-cooled (429 from every key in the plan),
compute the **longest remaining cooldown** across all keys and carry it through to the
Rust handler, which then sets `Retry-After: <seconds>` on the HTTP 429 instead of the
floor `1`.

Example:
```
Key A cools in 58 s
Key B cools in 42 s
Key C cools in 71 s
→ Gateway returns: Retry-After: 71
```

## Change set

### 1. `packages/router-core/src/health-tracker.ts`

Add `maxRemainingCooldownMs(now?: number): number`:
- Iterate all health entries
- For each where `h.cooldownUntil > now`, collect the remaining ms
- Return the max, or 0 if none are in cooldown
- Used by the bridge to know how long to tell the client to wait

### 2. `apps/desktop/src/gateway-bridge.ts`

In the catch block (around line 392), when `executeText` throws
`AllAttemptsFailedError`:

```ts
const cooldownMs = router.healthTracker.maxRemainingCooldownMs();
const status = gatewayStatus(e, msg);
await invoke("gateway_error", {
  requestId: req.requestId,
  status,
  message: msg,
  ...(cooldownMs > 0 ? { retryAfterMs: cooldownMs } : {}),
}).catch(() => undefined);
```

This threads the computed cooldown into the Rust error message.

### 3. `apps/desktop/src-tauri/src/gateway_cmds.rs`

The `gateway_error` command currently takes `(request_id, status, message)`. Add an
optional `retry_after_ms: Option<u64>` parameter. Pass it through to the `BridgeMsg::Error`.

### 4. `apps/desktop/src-tauri/src/gateway.rs`

Add `retry_after_ms: Option<u64>` to the `BridgeMsg::Error` variant:

```rust
pub enum BridgeMsg {
    Delta(String),
    ToolCalls(Value),
    Result(Value),
    Usage { prompt_tokens: u64, completion_tokens: u64 },
    Done,
    Error { status: u16, message: String, retry_after_ms: Option<u64> },
}
```

Update the `matches!` at line 1101 to match the new variant shape.
Update the test `SynthBridge::fail_with` to set `retry_after_ms: None` (it constructs
`BridgeMsg::Error` directly).

### 5. All handlers that pattern-match `BridgeMsg::Error`

Four handlers use this pattern; update all to destructure the new field:
- `chat_h` in `gateway_handlers.rs` (lines ~132, ~188)
- `models_h` in `gateway_handlers.rs` (line ~260)
- `image_h` in `gateway_handlers.rs` (line ~331)
- `messages_h` in `gateway_anthropic.rs` (lines ~405, ~622, ~730)
- `responses_h` in `gateway_responses.rs` (lines ~374, ~461)
- `gemini_h` in `gateway_gemini.rs` (lines ~263, ~321)

The field isn't used in the handler body — it's only destructured to avoid compile errors.
It flows to the `err_ra` path instead of `err` for 429 responses.

### 6. `ensure_retry_after` path (gateway.rs ~line 1289, 1300)

`try_slot` returns `Response` for 429 on capacity/auth-backoff. These already carry their
own `retry_after` (see `err_ra` usage). The new field feeds into the bridge-path 429s
(those coming from `BridgeMsg::Error`), not the slot-path ones.

### 7. Non-streaming handlers: thread retry_after into err_ra

For `chat_h` and `messages_h`, when the bridge returns `BridgeMsg::Error { status: 429, ..., retry_after_ms }`:
- Use `err_ra(status, retry_after_ms.map(|ms| ms.div_ceil(1000).to_string().as_str()).unwrap_or("1"), body)` instead of `err(status, body)`
- This sets the `Retry-After` header on the HTTP response

The streaming handlers already commit to 200, so `Retry-After` doesn't apply (the stream
carries the error event). Leave those unchanged — the `ensure_retry_after` middleware won't
touch a 200 response anyway.

### 8. `web-test/shim.ts`

Add `retryAfterMs` to the `gateway_error` case in the shim, so web tests can verify the
new field flows through.

### 9. Tests

**TS unit test** (`health-tracker.test.ts`):
- Three keys with cooldowns at t=0+10s, t=0+30s, t=0+5s
- Call `maxRemainingCooldownMs()` → expect 30_000
- After the 30s key expires but others remain → expect 10_000

**Rust integration test** (`gateway_tests.rs`):
- Spin up the gateway, set up a health tracker with all keys in cooldown, fire a request,
  confirm the HTTP 429 carries `Retry-After: <longest_cooldown_seconds>` in the response header

**Falsification**: remove the `retry_after_ms` propagation and confirm the test fails
(the header falls back to `ensure_retry_after`'s `1`).

## What must NOT change

- The `HealthTracker` is pure — no I/O, no new dependencies.
- The bridge path (TS→Rust IPC) still uses the same `gateway_error` command, just with an
  extra optional field. Existing callers that don't pass it get `None`, preserving the floor.
- No new Tauri commands — the existing `gateway_error` is extended, not replaced.
- No ledger entries — a rate-limited request is not a billed model call.
- Streaming handlers keep their existing behaviour — `Retry-After` on an already-committed
  200 SSE is meaningless, and the error event payload is unaffected.

## Effort

Medium. ~30 lines in TS (health tracker + bridge), ~50 lines in Rust (enum + 6 handler
updates + tests). The bulk is the handler destructure updates — mechanical but spread
across 6 files.

---

## What shipped (2026-09-22)

The change set above was a plan, not a record. Three things differ in the implementation, and
each difference is an improvement:

1. **The cooldown comes from the failure, not the health tracker.** The plan proposed
   `router.healthTracker.maxRemainingCooldownMs()`. The implementation adds
   `AllAttemptsFailedError.maxRetryAfterMs()` instead — the longest `retry-after` the provider
   named across *this request's* failed attempts. That is the better signal: a global "longest
   remaining cooldown" includes a key cooled by an *earlier* request (say 120 s), so it would
   tell the client to wait 120 s when the key it will actually be routed to is ready in 30 s.
   The error-scoped value describes the retry the client is about to make.
   `HealthTracker.maxRemainingCooldownMs()` had been added but never called; it was removed as
   dead code rather than left looking live.

2. **One shared helper instead of a per-dialect copy.** Rather than open-coding the
   seconds conversion in `chat_h` and `messages_h` only, `gateway.rs` gained `cooldown_secs()`
   (ms → whole seconds, rounding up, never 0) and `err_with_cooldown()` (429 + cooldown →
   `Retry-After`, else plain `err`). All six non-streaming error paths call it — chat, models,
   image, messages, responses, gemini — so no dialect can drift. The streaming paths destructure
   with `..`: the 200 is already committed, so a header is impossible there.

3. **`err_ra` now takes `impl Into<String>`.** It was `&'static str`, which cannot carry a
   computed cooldown. The four existing call sites pass literals and are unaffected.

**Also fixed:** the tree did not compile when this was picked up — 10 errors (8 × `E0027` from
handlers still destructuring the old two-field variant, 2 × `E0308` from the `Cow` /
`&'static str` mismatch). Stage 2 had been started and abandoned mid-edit.

### Verification

- `cargo test --lib` — **470 passed, 0 failed** (466 before the four new tests).
- `pnpm --filter @aiprovider/router-core test` — **239 passed** (237 before the two new tests).
- `pnpm ci:local` — **ALL GREEN**.
- Four new Rust tests, all **falsified first**: `an_upstream_429_reports_the_providers_own_cooldown`
  (71 s), `..._to_an_anthropic_client` (30 s), `..._to_a_gemini_client` (45 s), and
  `a_sub_second_cooldown_never_reports_zero` (400 ms → 1). With `err_with_cooldown` reverted to
  plain `err`, the three cooldown tests fail with `left: "1"` — the middleware floor — while the
  two floor tests keep passing. So the new tests carry the signal and the old ones do not.
- Two new TS tests, **falsified first**: changing `maxRetryAfterMs()` to keep the *last* value
  instead of the max fails with `expected 12000 to be 45000`. The longest value is deliberately
  first in the chain so that probe is caught.

### Not done, deliberately

- **`web-test/shim.ts` was not touched.** The plan asked for a `retryAfterMs` field there. The
  shim's `gateway_error` case is a blind `return null` — it accepts any args and records nothing,
  so adding a field name would be a no-op. Verifying the field at the web layer would need an
  invoke-recording facility the shim does not have. The Rust tests cover the behaviour from the
  bridge message through to the HTTP header.
- **The min-vs-max question is open.** The client is told the *longest* cooldown, but the
  earliest a retry can succeed is the *shortest*, so max over-waits by design. It is conservative
  and matches the plan; whether min would serve clients better is a product decision, not a bug.
