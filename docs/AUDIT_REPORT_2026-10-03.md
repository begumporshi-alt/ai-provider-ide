# Architecture & Implementation Audit — AI-Provider Router

> **Audited:** the working tree on 2026-10-03, branch `feat/reasoning-effort-control` —
> `apps/desktop/src-tauri/src` (≈73,000 lines Rust), `apps/desktop/src` (≈36,000 lines TS/TSX),
> `packages/router-core`, `packages/adapter-spec`.
> **Method:** read-only, three independent review passes (structure map, architecture audit,
> implementation review). Every finding cites `file:line` and was read in context, not inferred
> from a grep. Where a finding could not be verified, it says so.
> **Date:** 2026-10-03
> **Companion documents:** [`AUDIT_REPORT_2026-09-27.md`](AUDIT_REPORT_2026-09-27.md) (the
> implementation audit this one follows up), [`SECURITY_AUDIT_2026-09-20.md`](SECURITY_AUDIT_2026-09-20.md),
> [`ARCHITECTURE_AUDIT.md`](ARCHITECTURE_AUDIT.md). This report covers ground those did not:
> the streaming/bridge layer end to end, the resilience checklist, and the in-flight
> reasoning-effort feature.

---

## Executive summary

The architecture is mature and its resilience story is far more complete than a typical local
gateway ships: an ordered failover plan (`planner.rs`), per-key circuit breakers with half-open
windows (`engine.rs`), admission control (8 concurrent + 32 queued, `429` + `Retry-After`),
a per-provider in-flight limiter, split connect/idle/header/first-byte timeouts sized from live
measurements, and an end-to-end cancellation chain. The egress chokepoint, the auth path, and the
two-phase stream contract are all sound and were verified, not assumed.

Two **P1 defects** were found on default configuration, both user-visible hangs or kills:

- **R1** — the Responses dialect's *streaming* path emits no terminal events on a pass-through
  tool-call turn; the stream dies and the client times out.
- **R2** — `FIRST_MSG_TIMEOUT` (30 s) kills healthy long completions for clients that declare no
  tools, because the prose gate holds every delta until end-of-generation.

Two **P2 defects** block the current `feat/reasoning-effort-control` branch: temperature and
forced tool-choice forwarded alongside Anthropic `thinking: enabled` (guaranteed upstream 400),
and `thinkingBudget: 0` sent to Gemini 2.5 Pro (deterministic 400).

Five architectural risks are ranked below. The vault's file-backed design is a **recorded
decision** (D60/D62, `SECURITY.md` 2026-09-26), not drift; the residual backup blast radius is
noted rather than re-litigated.

---

## P1 — critical

### R1. Responses streaming: a pass-through tool-call turn emits no events at all

`core/gateway_responses.rs:345-361` and `:400-402`

In the streaming arm, `BridgeMsg::ToolCalls` collects the calls into `tool_calls` but sets
`tool_pending = true; break;`. The terminal block is gated by
`if !tool_pending { …all output events… } else { return; }` — so the else arm returns having
emitted only `response.created`, `output_item.added` (the message item) and `content_part.added`.
No `function_call` output items, no `response.output_text.done`, no `response.completed`, no
`response.failed`.

Every other dialect handles this correctly: the OpenAI chat handler yields a `tool_calls` delta +
`[DONE]` (`gateway_handlers.rs:188-205`), and the Anthropic handler emits `tool_use` blocks +
`message_delta`/`message_stop` (`gateway_anthropic.rs:440-515`). The non-streaming Responses path
also emits `function_call` items correctly (`gateway_responses.rs:478`). Only the streaming
Responses path is broken, and it is exactly the path a Codex-style client takes: client declares
tools → ownership `Client` → model calls a tool → `PassThrough` → this arm. The client hangs
waiting for a terminal event until it times out.

**Fix direction:** in the `tool_pending` branch, emit `response.output_item.added` /
`function_call_arguments.done` / `response.output_item.done` for each call, then a
`response.completed` whose `output` contains the `function_call` items — mirroring the
non-stream body at `:475-479`. The accumulated `tool_calls` vec is already there; it is just
never emitted.

### R2. `FIRST_MSG_TIMEOUT` kills healthy long completions from tool-less clients

`core/gateway.rs:1336` and `:1369-1414`; `core/bridge_policy.rs:237-240`; `core/router_bridge.rs:300, 319-345`

`Slot::recv` synthesizes a 503 ("the router produced no response within 30000 ms") and the slot's
`Drop` then **cancels the upstream request** if the bridge produces no `BridgeMsg` within 30 s.
But with the default `tools_enabled = true` (`gateway.rs:98`) and a client that declares no tools,
`ProseGate` holds (`hold: ownership == Gateway`, `bridge_policy.rs:239`) every text delta:
`gate.offer()` returns `None`, so `replies.reply` is never called for prose
(`router_bridge.rs:337-344`). The only earlier messages are reasoning deltas (reasoning models
only) and per-turn `Usage` — both of which land only when the first upstream turn **completes**.
For a non-reasoning model, the first `BridgeMsg` therefore arrives at the full end-of-generation
time, and any completion that runs past 30 s — routine for long answers — is killed mid-flight and
reported as an abandoned request. The surrounding invariants (`PLAN_BUDGET` 26 s < 30 s, egress
20 s header timeout) bound candidate *admission* and time-to-headers, not the unbounded body
stream, so none of them protects this case. Clients that declare tools are unaffected (the gate
never holds, first delta arrives within the 20 s header bound); plain chat clients on the default
config are the exposed population.

**Fix direction:** either (a) make the held-gate case send a liveness frame — e.g. reply an empty
`Delta` (already filtered as a non-event by the OpenAI/Anthropic handlers) or a dedicated
heartbeat `BridgeMsg` on the first held chunk; or (b) start the `FIRST_MSG_TIMEOUT` clock from the
first *egress* byte rather than dispatch, by having the bridge reply once when the upstream
response phase succeeds.

---

## P2 — blocks the reasoning-effort branch

The reasoning-effort feature is structurally complete — ingress normalization
(`gateway_normalizer.rs:985-997`) → canonical-first read (`router_bridge.rs:374-388`) →
per-dialect rendering (`interpreter.rs:1186-1208`) → templates — and the budget math is correct
(`thinking_budget`, `interpreter.rs:1167-1179`: budget always `< max_tokens` with the answer
allowance reserved). The remaining exposure is the cross-provider *interaction* constraints.

### R3. Anthropic dialect: `temperature` (and forced `tool_choice`) forwarded alongside `thinking: enabled`

`core/interpreter.rs:496-515` and `:1186-1208`; template at `core/builtin_templates.rs:218-222`

When the caller sets a reasoning level on an Anthropic-dialect provider, `reasoning_values`
renders `thinking: {"type":"enabled","budget_tokens":N}` — but the same request body still
carries the caller's `temperature` (inserted unconditionally at `interpreter.rs:501-503`) and any
`tool_choice` other than `auto`/`none` (mapped at `:512-514`). Anthropic rejects thinking-enabled
requests where `temperature != 1` or `tool_choice` forces a specific tool, so
`reasoning: "high"` + `temperature: 0.7` on any Anthropic-dialect model is a guaranteed upstream
400, which the engine then files as `BAD_REQUEST_SCHEMA` and failover burns candidates on.

**Fix direction:** when `reasoning` renders a non-zero budget for a dialect, suppress/override
`temperature` and clamp `tool_choice` to `auto` — or drop the `thinking` param when the caller
pinned a temperature, so the request degrades to "provider default thinking" instead of failing.

### R4. Gemini dialect: `reasoning: "off"` sends `thinkingBudget: 0`, which Gemini 2.5 Pro rejects

`core/interpreter.rs:1191-1198`; template at `core/builtin_templates.rs:375`

`reasoning_values(Off, …)` yields `{"thinkingBudget": 0}` for the `{{thinkingConfig?}}`
placeholder, and the builtin Gemini dialect declares that placeholder. Gemini's API allows
`thinkingBudget: 0` only on 2.5 **Flash**; 2.5 **Pro** has a minimum budget of 128 and cannot
disable thinking, so `reasoning: "off"` on a Pro model is a deterministic 400. Same defect class
as R3: one shared `Off` rendering for dialects with different off semantics. (The Anthropic
`{"type":"disabled"}` rendering was probed against an aggregator, `agentrouter.org`; worth
re-probing against direct `api.anthropic.com`.)

**Fix direction:** make the off-rendering dialect-specific — Gemini: omit `thinkingConfig` for
Off, or clamp to 128 for Pro-class models; `reasoning_values`'s key list already has the
per-dialect seams.

### R5. A truncated stream records `ok`, and the agent loop treats it as a finished answer

Found live, 2026-10-03 17:03 (`agent_runs` run-1791025437301, ledger row 2788), not by code
reading: the Assistant's model streamed "First, let me check", the provider (vyceai.com's
deepseek endpoint, unstable all day — `TIMEOUT` at 13:43, a mid-loop upstream timeout at 12:55)
closed the stream before any tool call arrived, and the loop's terminal-turn contract — "no tool
calls in the response = final answer" (`agentLoop.ts:128`) — ended the run as a clean
one-iteration success. `agent_runs` recorded `status=ok, iterations=1, tool_calls=0`; the ledger
row said `ok`. The user saw the model announce intent and then go silent, with nothing to read
and nothing to retry. The engine's drained-stream honesty (`NO_OUTPUT`/`PARSE_ERROR` in
`model-router.ts`) only covers streams that carried **nothing**; a stream that carries prose and
then dies is indistinguishable from a complete answer.

**Fix direction:** make the finish signal meaningful — the interpreter should fire `onFinish`
only when the stream declares a finish selector, so *fired with `undefined`* reads as truncated
while *never fired* reads as unknowable; the loop re-asks a truncated iteration (bounded) and
flags the turn; the ok ledger row carries the evidence.

### R6. The thinking knob is a silent no-op when the serving manifest declares no thinking placeholder

Found live 2026-10-03, twice, identically: the Assistant's `thinking: "medium"` on a
**user-edited** agentrouter manifest (anthropic-messages-v1, frozen before the builtin gained
`{{thinking?}}` on 2026-10-02) rendered into nothing — the request template names no `thinking`
field, so `reasoning_values` filled a values map no placeholder ever read. The wire carried no
thinking field at all, the provider's own default did the thinking, and the turn spent the
entire 8192-token output budget on `thinking_delta` with `NO_OUTPUT` for the answer. The knob's
off position was equally unreachable, so the ledger's own advice ("turn thinking off for it")
could not be followed without hand-editing the manifest. This is the industry's known failure
mode for capability-scoped knobs — LiteLLM answers it with per-model capability metadata plus
`drop_params` warnings, OpenRouter with per-model `supported_parameters` — and the shared rule
is: **a knob must never be a silent no-op, and stored adapter config is upgraded in place.**

**Fix direction:** a versioned data migration heals every stored Anthropic-dialect manifest
(the dialect whose off spelling is probed and whose providers default thinking on); the
remaining half — a run-config warning when the chosen model's manifest lacks the placeholder —
is recorded below as open.

---

## P3 — minor

- **`"usage": null` on the non-stream chat path** — `core/gateway_handlers.rs:306`: when the
  provider reported nothing, `usage` serializes as `null` while the streaming path always sends an
  object (zeroed). Some OpenAI-compatible clients read `usage.prompt_tokens` unguarded. Emit the
  zeroed object instead.
- **Streaming `ToolCalls` arm skips the usage chunk and `finish_capture`** —
  `core/gateway_handlers.rs:188-205`: the pass-through tool turn ends without the usage chunk the
  `Done` arm emits and without recording the capture, so tool-only turns are invisible to memory
  capture and clients see no usage. The Anthropic dialect gets this right.
- **`estimate_prompt_tokens_at` counts only string `content`** — `core/context_scope.rs:946-959`:
  array-content and image parts undercount the prompt; the memory budget then over-injects
  relative to the estimate. Documented in the code as the design (retry-without-memory backstops
  it), recorded here for completeness.

---

## Resilience checklist

| Capability | Status | Evidence |
|---|---|---|
| Retry / failover across providers | **Exists** | `planner.rs` ordered candidate plan; `engine.rs:845-926` candidate loop with budget; `AllAttemptsFailed` chain; `failover_enabled` (`router.rs:235, 316-319`) |
| Timeouts | **Exists** | connect/idle/header/first-byte split (`egress.rs:470-560`); per-request `timeout_ms` is a real abort (`router.rs:1363-1390`) |
| Cancellation / abort propagation | **Exists** | disconnect → `Slot::drop` → `bridge.cancel` → egress abort (`gateway.rs:1420, 1457`); cancel checked before limiter acquisition, so a cancelled request never consumes a permit |
| Backpressure | **Exists** | 8 + 32 semaphore → 429 + `Retry-After` (`gateway.rs:40-43, 2171`); per-provider limiter with RAII permits (`limiter.rs`) |
| Rate-limit handling | **Exists** | `Retry-After` parsing, cooldown floor consistent between enforced and reported wait, key round-robin cursors (`router.rs:594-640`) |
| Circuit breaking | **Partial** | per-**key** breaker with half-open window (`engine.rs:1523+`); per-**provider** only static `status == "enabled"` (`is_provider_usable`) — a provider returning 500s is retried at full plan budget every request until someone disables it |
| Idempotency | **Missing** | no `Idempotency-Key` handling in the route table (`gateway.rs:2266-2273`); failover re-sends the same prompt to the next provider (double upstream spend, mitigated only by the spend cap) |
| Health checks | **Partial** | `/health` liveness and UI service discovery exist; no active upstream probing in the serving path — `probe-runner.ts` runs only during onboarding; provider health is purely reactive |
| Observability | **Exists (local)** | `tracing` with env-filter (`bin/aiproviderd.rs:334`), usage ledger, injection log, crash reports, request-id-scoped log lines (`gateway.rs:1385`) |

---

## Security posture

- **Local-server binding: verified.** `gateway::spawn` binds `Ipv4Addr::LOCALHOST` explicitly
  (`gateway.rs:2248-2251`); bind failure is loud with remediation text.
- **Vault: the file-backed store is a recorded decision, not drift.** `vault.rs` (`.secrets.json`,
  mode 600, cross-process `flock`, atomic tmp+rename) replaced the keychain deliberately on
  2026-09-26 — see the drift register D60/D62 and the rewritten `SECURITY.md`, which states
  "a secret on disk is the *design*". **Residual noted, not re-litigated:** mode 600 stops nothing
  running as the user, and backup/sync agents (iCloud, Time Machine) that capture
  `Application Support/dev.aiprovider.router` capture every provider key at once. If that radius
  is ever judged too wide, the shape that removes the prompt-storm objection is one keychain item
  wrapping the file's secret values, plus backup-exclusion metadata.
- **Key exposure to the webview: strong.** Provider secrets never enter the webview — the
  interpreter sends `{{secret}}` sentinels and Rust substitutes at the egress boundary
  (`egress.rs:8-11`); master-key reveal is a Rust-side clipboard copy, never rendered. The
  webview *does* hold a bearer `ui_session_key` (`lib/gateway-client.ts:31`) with full admin scope
  on `/admin/*`; CSP (`default-src 'self'; script-src 'self'`) is the mitigation. A stolen key
  does not expire — short-TTL session keys would close it.
- **CORS: all localhost origins trusted.** Reflected allowlist for `tauri://localhost`,
  `http://localhost*`, `http://127.0.0.1*` (`gateway.rs:2220-2238`); preflight answered before
  auth (correct). A malicious page on a local dev server could read gateway responses. Pinning to
  `tauri://localhost` plus the explicit dev port closes it.
- **Secret leakage in logs: strong where verified, not fully verified.** Memory capture redacts
  credential-shaped strings before rows are written (`capture.rs:252-344` and tests); generator
  audit stores only a `redaction_hash` (`persist.rs:849`); probe reports persisted redacted
  (`persist.rs:780-804`). **Unverified:** that every `tracing` request-path line (e.g. egress
  debug header dumps) is secret-free end to end.
- **Gemini `?key=` query param** (`Gateway.tsx:436`): the key can travel in the URL — inherent to
  Gemini's auth scheme; can land in upstream-side URL logging. Worth a docs note.

---

## Architectural risks, ranked

1. **Dual-language core** (effort: large). `packages/router-core` is both the reference spec *and*
   a live runtime dependency of the webview (`store.ts` imports `runContractSuite`,
   `validateImport`); the manifest interpreter and execution engine still run TS-side while
   `planner.rs`, `limiter.rs`, `engine.rs` are line-ported copies held in parity by tests, not by
   construction. Every bug class exists twice — the byte-index/char-boundary fix (`893b3e7`) is
   exactly a JS/Rust semantics gap. Path: declare Rust canonical for the serving path, migrate the
   webview runtime uses to Tauri commands, shrink router-core to spec + golden tests.
2. **No provider-level circuit breaker** (effort: medium). Per-key breakers exist
   (`engine.rs:1523+`, `KeyBlock::Breaker/Cooling`); per-provider there is only the static
   enabled flag. Extend `HealthTracker` with per-provider open/half-open state consulted by
   `order_carriers`.
3. **CORS origin breadth + non-expiring `ui_session_key`** (effort: small/medium). Both
   correspond to a webview compromise; see the security section.
4. **No idempotency semantics on `/v1`; failover double-spend is silent** (effort: medium).
   Document at-least-once semantics, add a dedup window keyed on request hash for non-streaming
   POSTs, surface per-request attempt-chain spend in the ledger UI.
5. **`engine.rs` is becoming a god module** (4,076 lines): HealthTracker, the error taxonomy, the
   image path, and plan-budget logic live together. Decompose before cohesion degrades further.

## Extensibility

Adding a **provider** is easy and data-driven: manifest overlays over three frozen dialect
templates (`builtin-templates.ts:3, 423-425`; Rust mirror `builtin_templates.rs:491-498`), with
runtime staging/activation and version history. Adding a **dialect** means code in two languages —
the dual-implementation tax is paid exactly there. Hardcoded logic that should be data-driven:
little; the client-gate marker lists (`client_gate.rs:19-31`) are fine at current size.

---

## Verified sound (spot-checks)

- **"Cause outranks status code"** (recent fix): `reason_from_body` (`engine.rs:281-307`) extracts
  the provider's own `error.code`/`message`; `AllAttemptsFailed::describe` (`engine.rs:980-1003`)
  embeds it per chain entry; `gateway_status`/`gateway_status_for_attempts`
  (`bridge_policy.rs:120-140`) keep the last-attempt status authoritative for client-attributable
  codes only, with 401/403/5xx/0 folded to 502 so the client never blames its own credentials.
- **Context-window math**: `model_context.rs` clamps absurd windows at write and read time;
  `plan_budget_for` (`context_scope.rs:970-976`) uses `saturating_sub` and reserves declared
  `max_tokens` first. `UsageTokens`' `None`-vs-`Some(0)` cached-token distinction is enforced to
  the ledger with a compile-time exhaustive-literal guard.
- **Concurrency**: no mutex held across an await in the shared-state paths; `ReplyHandle` avoids
  the `Arc` reference cycle; blocking work (spend gate, tool execution) is on `spawn_blocking`
  (`gateway.rs:1653-1662`, `router_bridge.rs:523-542`).
- **Retry logic**: no duplicate-send risk — a mid-stream failure after any delivered chunk/tool
  call rethrows instead of advancing (`attempt_disposition`, `engine.rs:641-649, 1358-1382`); the
  dangerous transport retry was removed with the reasoning documented (`egress.rs:589-614`).
- **Two-phase stream contract** (`adapter.rs:508-532`): response-phase refusal vs mid-stream break
  is encoded in the type system; every consumer respects it.
- **`StreamObservation`** (`adapter.rs:264-465`): counted, capped, char-boundary-safe stream
  evidence distinguishing "provider sent nothing" from "manifest can't read it" from "model
  reasoned and never answered".

## Could not verify

- Whether `tracing` output is comprehensively secret-free on every request-path line.
- The QuickJS sandbox's actual escape resistance (`sandbox.rs` / `js_host.rs` read at
  module-comment level only).
- Whether queued (not yet routed) requests have their own wait timeout distinct from
  `Retry-After`.

---

## Fix status (updated 2026-10-03)

| ID | Severity | Status |
|---|---|---|
| R1 | P1 | **Fixed 2026-10-03** — `gateway_responses.rs`'s `tool_pending` branch now emits the same terminal sequence the text arm emits (`output_item.added` / `function_call_arguments.done` / `output_item.done` per call, then `response.completed`), with the calls additionally placed as top-level `function_call` items in the terminal `output` — where the Responses contract puts them. Pinned by `responses_stream_tool_calls_reach_a_terminal_event` (gateway_tests), which fails against the old code with "missing response.completed". The test bridge's `responses` arm now honours the pass-through contract it stands in for. |
| R2 | P1 | **Fixed 2026-10-03** — new `BridgeMsg::Liveness` variant; the bridge replies with it whenever `ProseGate` holds a chunk, so the first-message bound is disarmed by evidence the bridge is working rather than by the turn completing. Every dialect's handler ignores it deliberately (ten match sites, compiler-driven). Pinned twice: `held_prose_announces_a_liveness_frame_per_chunk` + `passing_mode_announces_no_liveness` (router_bridge — the emission), and `a_liveness_frame_disarms_the_first_message_bound` (gateway_tests — the property, with the bound shortened to 100 ms against a 400 ms pause). An empty-`Delta` frame was rejected: only the chat handler filters empty deltas; Gemini and Anthropic would have forwarded it to the wire. |
| R3 | P2 | **Fixed 2026-10-03** — when the caller's reasoning knob renders `thinking: enabled` **and** the dialect's template declares `{{thinking?}}`, the interpreter now (a) drops the caller's `temperature` entirely — the two fields together are a 400 on Anthropic-dialect providers — and (b) clamps a forced `tool_choice` to `{"type":"auto"}` rather than mapping a named tool through `toolChoiceMap`, since a tool the model cannot skip is incompatible with a thinking turn that may answer without calling anything. Thinking-off requests are byte-identical to before. Pinned by `a_thinking_enabled_request_drops_the_temperature_and_clamps_the_tool_choice` (interpreter), which asserts the on-case fields are absent and the off-case temperature and forced choice are forwarded unchanged; falsified by removing the guard (temperature reappears). The TS reference renders `Off`/on with the same table but has no equivalent guard — recorded as drift, see the drift register. |
| R4 | P2 | **Fixed 2026-10-03** — `reasoning_values`' `Off` rendering is now per-dialect where it matters: Anthropic keeps its probed `{"type":"disabled"}` (both engines' tests pin that spelling), and the Gemini `thinkingConfig` key is **omitted** instead of sending `thinkingBudget: 0`, which Gemini 2.5 Pro (128 floor, thinking cannot be disabled) rejects with a 400. The tradeoff is recorded in the code: 2.5 Flash loses explicit-off and falls back to the provider's own default. Pinned by `reasoning_off_omits_the_gemini_thinking_config` (interpreter): `Off` yields no `thinkingConfig` on a `{{thinkingConfig?}}` template, `High` still yields `thinkingBudget ≥ 1024`. **The TS reference still sends both keys** — left as-is deliberately under the don't-move-the-reference-under-a-port rule; the divergence is registered in the drift register (`07-drift-register.md`). |
| R5 | P2 | **Fixed 2026-10-03** (same day, found live) — the finish signal is now meaningful end to end. **Interpreter:** `onFinish` fires only when the stream declares a finish selector (`stream.finish`/`responseFinish`) or a reason was seen, so *fired with `undefined`* is readable as truncated and *never fired* as unknowable — pinned by two `dialect-messages` specs (declared-but-absent fires `undefined`; selector-less never fires). **Agent loop:** a truncated iteration is re-asked up to twice (`TRUNCATION_RETRIES`), then accepted with `done.truncated` / `result.truncated` so the UI can say what happened — pinned by three `agentLoop` specs (recovered on re-ask, flagged after the cap, one-call passthrough when no selector is declared), falsified by stashing the two src files (1 + 3 failures against the old code). **Assistant:** a truncated turn records a `done` step with `ok=false` reading "stream truncated", and the in-flight bubble announces each re-ask. **Ledger:** the ok row now carries `failure_detail` naming the truncation when the stream was cut — status stays `ok` because text *was* served, but the evidence travels with it. Not covered: providers that close cleanly without any finish mechanism are untouched; the `NO_OUTPUT` case (the whole output budget spent on reasoning, measured live the same day on agentrouter/deepseek) keeps its existing classification — that is a budget problem, not a truncation one. |
| R6 | P2 | **Fixed 2026-10-03** (same day, found live) — data migration `0022_manifest_thinking_placeholder` (`store.rs`): every stored manifest whose body is the `anthropic-messages-v1` dialect and whose `generateText.requestTemplate` lacks the key gains `"thinking": "{{thinking?}}"` — the optional placeholder, so unset still means the provider's own default. Anthropic dialect only, deliberately: its off spelling is probed and it is the dialect that defaults thinking on; the OpenAI/Gemini templates stay untouched (injecting `reasoning_effort` into a request a provider has never seen is a 400 risk with no measured failure behind it). Pinned by `the_thinking_placeholder_reaches_anthropic_manifests_that_predate_it` (a legacy manifest heals, a pre-declared one is byte-identical, an openai-dialect one is untouched), and the version-sequence assertions move to 22. **NO_OUTPUT fallback (LiteLLM's fallbacks pattern, added after a third live reproduction):** the agent loop re-asks a turn whose thinking channel carried text but whose answer did not — the `NO_OUTPUT` class, measured three times 2026-10-03 on agentrouter/deepseek-v4-flash at exactly the 8192-token cap — **once with thinking forced off**, the one lever that works even against a provider that ignores budget tokens; the Assistant's run-config level yields to the loop's forced off, and a turn that answers nothing even without thinking fails loudly instead of ending in an empty bubble. Pinned by three `agentLoop` specs (recovered with `reasoning: "off"` on the wire, loud failure after the fallback, no fallback without the reasoning predicate), falsified by stashing the loop (2 failures against the old code). **Open half:** the run-config UI still lets a knob be set that a manifest cannot carry — a warning when the chosen model's manifest declares no thinking placeholder is the remaining honesty work. |

Gates after the fixes (final run, 2026-10-03): `cargo fmt` clean repo-wide ·
`cargo clippy --lib --tests -- -D warnings` clean (the pre-existing failures from the
half-landed web-search work in `web.rs`/`tools.rs`/`adapter.rs` were cleared in the same pass —
the held key-tier chain marked `#[allow(dead_code)]`, the chain's backend type factored into a
`DynSearchBackend` alias, `adapter.rs`'s duplicated text branch merged, `tools.rs`'s manual
prefix strips and test-only `Write` import fixed) · `cargo test --lib` **1498 passed / 0
failed** · `cargo check --no-default-features --all-targets` green (D17).

| ID | Severity | Status |
|---|---|---|
| M1 | P3 | **Open** — `"usage": null` on non-stream chat path |
| M2 | P3 | **Open** — streaming tool-call arm skips usage chunk and capture |
| M3 | P3 | Recorded (documented design tradeoff) — token estimate undercounts array/image content |
| S1 | Security | **Open** — CORS trusts all localhost origins |
| S2 | Security | **Open** — `ui_session_key` does not expire |
| S3 | Security | Noted — Gemini `?key=` in URLs; needs a docs note |
| A1 | Architecture | **Open** — dual-language core consolidation |
| A2 | Architecture | **Open** — provider-level circuit breaker |
| A3 | Architecture | **Open** — idempotency semantics on `/v1` |
| A4 | Architecture | **Open** — `engine.rs` decomposition |
