# 08 — Flows

Two flows. One is what happens to a **request**; the other is what a person **does**. They are worth reading
together, because most confusing behaviour is one of them being mistaken for the other.

## Application flow — one routed request

![Gateway request pipeline: auth, capacity, context and memory, upstream dispatch, response finalization](../../diagrams/memory-context-gateway-read-path.svg)

**Six stages, and every one of them runs before the provider is contacted.** (The stage count grew from five
on 2026-10-04/05: spend moved out of auth's shadow, and idempotency became its own gate.)

| Stage | What happens |
|---|---|
| 1 · Auth | Master key, then per-app keys (`gwkey:ak-*`). Bearer for OpenAI-style callers, `x-api-key` for Anthropic, `x-goog-api-key` for Gemini. A `401` here is the healthy answer to a bad key |
| 2 · Spend + idempotency | After auth, the spend gate (`402 spend_cap_exceeded` global, `402 app_budget_exceeded` per-app). A non-streaming request carrying an `Idempotency-Key` then reserves: a replay answers the cached body with `Idempotency-Replayed: true`, a same-key-different-body conflict answers `409`, and streaming + key is a `400` |
| 3 · Capacity | `try_slot` — 8 in flight, 32 queued. Overflow is a `429`, not a stall |
| 4 · Context + memory | `inject_context` under a 15 ms budget. Scoped recall of L1–L3; a skip carries its reason on a header. The Assistant sends `AIP-Memory: off` and does its own recall |
| 5 · Capture + upstream | `prepare_capture`, then `core.dispatch` into the Rust `RouterBridge`, then the provider through a 6-header allowlist |
| 6 · Response | `finish_capture` plus memory headers. The terminal SSE chunk carries `finish_reason`, `usage` and `served_by` — the provider attribution the Activity screen shows |

**All four ingress dialects converge on one canonical chat body before dispatch.** That is why stage 3 has a
single implementation rather than four, and why memory injection is not dialect-specific.

### Inside stage 4 — the attempt loop

![Attempt loop: plan, attempt, classify, cool the key and advance, or stream to the client](../../diagrams/attempt-loop.svg)

The single most misread part of the design: **rotation and failover are the same mechanism.** Each attempt on
the plan — the next key, or the next provider — *is* the retry. There is no separate hidden retry loop.

- A `401` or `429` **cools the key** rather than deprioritising it, and the planner **drops** cooled keys. So
  the earliest a client can be served is when the *first* cooled key frees up — which is why the client-facing
  `Retry-After` is the **shortest** named wait, not the longest.
- A whole plan is bounded at **6 attempts** (and a `PLAN_BUDGET` of 26 s bounds the whole chain below the
  gateway's own 30 s first-message timeout).
- Drift is **not** a per-request signal: the Rust monitor (`core/drift.rs`) reads the ledger on the 30-minute
  retention pass and flags a provider whose **1-hour window** holds drift-class failures while the same
  requested model *succeeded elsewhere* — see [02](02-architecture.md).

### The other flows

| Flow | Diagram |
|---|---|
| System overview — layers, router, gateway, key-blind egress | [`../diagrams/architecture.html`](../../diagrams/architecture.html) |
| Master-key generation and endpoint URL setup | [`../diagrams/gateway.html`](../../diagrams/gateway.html) |
| Auto-onboarding a new provider (self-construction) | [`../diagrams/self-construction.html`](../../diagrams/self-construction.html) |
| Memory write path — capture, queue, distillation, L0–L3 | [`../diagrams/memory-context-gateway-write-path.svg`](../../diagrams/memory-context-gateway-write-path.svg) |

## User flow — first run, then the daily loop

![User flow: four first-run steps, then a repeating loop of use, observe and tune](../../diagrams/user-flow.svg)

### First run — once

| Step | You do | Under the hood |
|---|---|---|
| 1 · Add a provider | Quick add for known profiles (OpenRouter, OpenCode Zen, b.ai), Manual for any OpenAI- or Anthropic-compatible base URL, or Guided setup for anything else | Guided setup tries the **deterministic** path first: free probes, dialect fingerprinting against the builtin templates, OpenAPI discovery when a spec is served. The AI generator runs only if that fails, and it never sees a key or a raw response body |
| 2 · Add a key | One key per provider, entered on the Providers screen | The vault write happens in Rust. The webview holds only a `secretRef`, and the one-shot reveal never enters webview-observable state |
| 3 · Enable and verify | Contract tests run against the provider with your key, then you approve | `pingKey`, then `listModels`, then a minimal text call. Paid calls require explicit consent with an estimated cost. The provider stays `pending` until you confirm, and the report is kept on its card |
| 4 · Browse models | Model Browser, Text and Image tabs, alias priority, per-capability defaults | Discovery goes through the adapter and is cached with a TTL. Entries are exposed as `provider-slug/native-id`; a bare ID resolves through the alias map. Nothing is an image model unless a manifest declares it |

**Step 3 is the milestone.** The AI-assisted onboarding path stays locked until one provider is live and
contract-tested — the bootstrap problem, resolved deterministically rather than by AI. OpenRouter and OpenCode
Zen are OpenAI-compatible, so the realistic first run needs no AI at all.

### Daily loop — repeats

| Step | You do | Under the hood |
|---|---|---|
| 5 · Use it | Chat and image generation in the Assistant, or point ZCode, Claude Code, Cursor, a script or a chat UI at the local gateway — the Gateway screen's **Connect your IDE** panel mints a per-app key and prints the exact config for each | Every path hits the same router with the same rotation and failover — the Assistant is a gateway client now too, over loopback HTTP. The Assistant recalls **unscoped**; the gateway path recalls **scoped** and injects into the canonical body. Per-app gateway keys let you revoke one client without rotating the master key |
| 6 · Observe | Activity, History, and the drift events on a provider card | The ledger records tokens, cost, latency and error class per request, including `cached_tokens` where a provider reports it. `source` attribution separates UI, gateway and internal generator traffic |
| 7 · Tune | Control, Memory, Skills, Agents | Control is the switchboard for cross-cutting switches — one place, not a mirror per screen. Memory atoms are born unscoped and need a human to bind scope before scoped recall can return them |

### Two things that surprise people

**A stopped gateway refuses fast — and serving without a window is a choice you make.** The gateway lives in
the Rust host, not the webview, so it does not die with the window; but quitting the app still stops it. The
supported way to serve with no window open is the headless `aiproviderd` launchd agent (default port 8800,
[10](10-headless-service.md)) — the app detects it at boot and delegates instead of double-binding. Either
way, a listener that is not up answers `503` + `Retry-After: 1` immediately rather than queueing.

**Memory recall looks broken on the gateway path and is not.** Every atom is born unscoped, and scoped recall
excludes unscoped rows. Until a human binds scope, gateway recall legitimately returns nothing. Measured live
corpus when this was written: **0 scoped versus 14 unscoped**. The Assistant shows the 14, which makes the
gateway look broken by comparison.

## Next

[09 Status](09-status.md) — where the project actually stands today.
