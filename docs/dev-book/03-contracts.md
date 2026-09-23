# 03 — Contracts

The interfaces and invariants that other code, other tools, and other people depend on. **A change here is a
breaking change until you have shown it is not.**

## The invariants

Numbered as in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §5, which remains their canonical statement. Each one
is testable, and each is here because breaking it is a security or correctness regression rather than a bug.

| # | Invariant | Why it holds |
|---|---|---|
| 1 | Raw secrets live only in the OS keychain; the DB stores `secret_ref` only | A database is a file that gets copied, backed up and shared |
| 2 | The TypeScript layer is key-blind; only the Rust egress gateway injects credentials | One audited egress path instead of N |
| 3 | All egress flows through that one module, with a host allowlist | The allowlist is what makes "no telemetry" mechanical |
| 4 | The generator never changes hosts — manifest lint pins `baseUrl` to user input | A hostile provider must not be able to redirect egress |
| 5 | Everything destined for the generator passes `redaction` first | Probe content is untrusted input |
| 6 | Key reveal is one-shot and explicit | Masked everywhere else |
| 7 | Paid validation calls require explicit consent with an estimated cost | The user's money, the user's decision |
| 8 | Sandboxed code adapters get no filesystem, no direct network, no eval | Defence in depth, not the only boundary |
| 9 | No telemetry | Structurally true because of #3, not by policy |
| 10 | The master key is a keychain secret, not config; rotation kills the old key instantly | Shown once, never in the DB or logs |
| 11 | The gateway binds `127.0.0.1` by default; LAN exposure is an explicit opt-in with a warning | The warning must say the key and prompts transit in cleartext |
| 12 | The webview is hardened, not trusted — strict CSP, per-window capabilities | `egress:*` is scoped to the context that needs it |
| 13 | Untrusted content renders as text, always | No `dangerouslySetInnerHTML`, no unsanitised markdown-HTML |
| 14 | Key reveal never passes through the webview DOM | See #2 — the reveal is a Rust-side action |
| 15 | Gateway auth is throttled and constant-time | Master-key comparison is constant-time |
| 16 | Port squatting is detected loudly, and the residual risk is documented in the UI | A fixed default port is a deliberate v1 trade-off |

**One carve-out to #3, stated rather than hidden:** a URL returned *in the body of a same-request response* —
an `imageUrl` from an image generation — may be fetched by the egress gateway, scoped to that request only and
never persisted to the allowlist.

## The HTTP surface

Eight routes, registered in `core/gateway.rs:1938-1945`. Seven are the OpenAI-compatible surface below,
every one of which translates to a single canonical
OpenAI-shaped chat body before dispatch, which is why memory injection has one shape at four call sites rather
than four implementations.

| Route | Method | Dialect |
|---|---|---|
| `/v1/models` | GET | OpenAI — merged catalog, qualified IDs |
| `/v1/chat/completions` | POST | OpenAI Chat |
| `/v1/images/generations` | POST | OpenAI Images |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/messages/count_tokens` | POST | Anthropic token counting |
| `/v1/responses` | POST | OpenAI Responses (Codex-style) |
| `/v1beta/models/{*tail}` | POST | Gemini `generateContent` and `:streamGenerateContent` |

The eighth is `GET /health`, added 2026-09-23 for the standalone service (`aiproviderd`) and for the UI's
service discovery. It is the **one unauthenticated route** and returns `{"status":"ok"}` — nothing else. It
answers before any key is produced because a client that does not yet hold one must still be able to find the
service; the seven above, and both the 404 and 405 refusals, all authenticate first, because an
unauthenticated answer is a statement that the route exists.

`/v1/embeddings` is out of scope for v1; the modality enum is the extension point.

### Merged model IDs

Catalog entries are exposed as `<provider-slug>/<native-id>` — `openrouter/gpt-4o`, `b.ai/qwen3-flash`. A **bare
ID** resolves through `model_aliases`: exactly one healthy provider carries it → it serves; several do → alias
priority decides; none → an error that names the qualified alternatives. Do not invent a resolution rule here;
the alias map is the only mechanism.

## Status-code semantics

**Read the body before concluding anything.** There are three different `429`s and two different `503`s.

| Status | Body / meaning | Where |
|---|---|---|
| `401` | Invalid or revoked key. **A healthy gateway answers 401 to a bad key** | key check |
| `429` | `"router at capacity"` — the gateway's own admission ceiling was hit | `core/gateway.rs:1302`, `:1315` |
| `429` | `"too many failed auth attempts — backing off"` — 30s backoff after repeated bad keys | `core/gateway.rs:1437` |
| `429` | Upstream `RATE_LIMITED`, including a cooled key's wait | execution engine |
| `503` | `"AI-Provider Router core unavailable — is the app open?"` — the webview is gone | `core/gateway.rs:1668` |
| `503` | `"master key unavailable"` — **the keychain entry has not been approved yet** | master-key check |

> **`503 master key unavailable` is not a bug, and it precedes authentication.** After reinstalling the app,
> macOS prompts once before the app may read its own keychain entry. Until you approve it, *every* request —
> unauthenticated ones included — answers `503`, because the master-key check runs before auth. A `401` is the
> signal that the gateway is healthy.

### The client-facing `Retry-After` is the shortest wait, not the longest

The route planner **drops** a cooled key rather than deprioritising it, so the earliest a retry can be served is
when the *first* cooled key frees up. The gateway used to report the last one's wait, which told clients to wait
longer than necessary. The value is still floored so a client is never told to retry into an open window.

## The compatibility contract

"OpenAI-compatible" is specified rather than assumed, and **unsupported fields error loudly instead of being
silently dropped**.

| Field | v1 behaviour |
|---|---|
| `model`, `messages`, `stream`, `max_tokens` | Supported, mapped through the manifest |
| `temperature` | Supported when the manifest allows it |
| `tools`, `tool_choice`, `response_format` | **Explicit `400`** with a clear message — never silently dropped |
| `n`, `logprobs`, `user`, anything else unknown | Ignored, **with a warning recorded in the ledger entry** |
| Error shape | OpenAI-style: `{"error": {"message", "type", "code"}}` |

Anthropic and Gemini ingress re-frame errors into their own envelopes: `429` → `rate_limit_error`, `503` →
`overloaded_error` (asserted in `core/gateway_tests.rs`).

## Concurrency and timeouts

One "request timeout" cannot serve every phase, so the budget is per phase.

| Budget | Default |
|---|---|
| Connect | 10 s |
| First byte | 30 s |
| Idle stream | 60 s, reset on every chunk — long generations are not "timed out" at 30 s |
| Max attempts per request | 6, across the whole plan |
| Backoff | Jittered exponential, honouring `Retry-After` |
| Per-provider concurrency cap | 4, with a bounded queue |

### Concurrency is two semaphores, not one

`MAX_CONCURRENT = 8`, `MAX_QUEUED = 32`, `MAX_TOTAL = 40`. Two separate semaphores in `core/gateway.rs`:

- `permits` (`MAX_TOTAL`) — **admits** the request.
- `dispatch` (`MAX_CONCURRENT`) — **routes** it to the core.

**The wait between the two is the queue.** Conflating them into one semaphore removes the bounded queue and
changes the `429` behaviour, which is asserted by a test that saturates both.

**Each attempt on the plan IS the retry.** There is no separate hidden retry loop; rotation and failover are
the same mechanism.

## The IPC surface

125 commands, registered in `tauri/commands.rs::handlers()`. Grouped by module:

| Module | Count | Covers |
|---|---|---|
| `commands` (local) | 53 | vault, egress, store, settings, context, history, skills, agent, memory, capture |
| `gateway_cmds` | 32 | gateway lifecycle, keys, spend, tools, memory switch, logs, worker callbacks |
| `persist` | 28 | providers, keys, manifests, catalog, aliases, ledger, onboarding, audit, drift, config |
| `tools` | 4 | tool policy, root checks, `tool_run` |
| `workbuddy` | 3 | sync, status, model set |

Two rules, both of which have cost a blank screen before:

1. **Every new `#[tauri::command]` needs a `apps/desktop/web-test/shim.ts` case the same day.** The shim throws
   on unknown commands, the screens swallow the error, and the screen goes blank with no message.
2. **A `#[tauri::command]` argument and a serde field are different boundaries.** Only *nested* payloads go
   through serde, and serde ignores unknown keys by default. Every nested payload gets
   `deny_unknown_fields`. `shim.ts::toRustArgs` renames top-level keys only.

**Identity is two strings, and either may deny:** the `AIP-Agent` label and `key:<id>`. Request paths must use
`core.app_keys()` rather than `AppKeyProvider`, which is memoised and will serve a stale list.

## Next

[04 Data model](04-data-model.md) — the schema these contracts are persisted in.
