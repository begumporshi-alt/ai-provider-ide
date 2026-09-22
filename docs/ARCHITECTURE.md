# ARCHITECTURE — AI-Provider Router

> Complete architecture, including the **self-construction engine** (auto-provider onboarding).
> Built from the notebook sketch spec ([MASTER_PROMPT.md](MASTER_PROMPT.md)) plus the user
> directive: *the IDE can automatically add and set up any new AI provider; an AI model is
> required inside the IDE so it can self-construct if needed.*
>
> Status: greenfield, pre-scaffold · Pattern: layered modular monolith + hexagonal router core
> + registry/plugin adapter subsystem · Stack: Tauri 2 + React + TypeScript + Rust host
>
> **Visual diagrams:** [diagrams/architecture.html](diagrams/architecture.html) (system overview —
> layers, router, gateway, key-blind egress) · [diagrams/self-construction.html](diagrams/self-construction.html)
> (auto-onboarding pipeline for any new provider) · [diagrams/gateway.html](diagrams/gateway.html)
> (master key generation + endpoint URL setup flow)

---

## Executive Summary

AI-Provider Router is a local-first desktop application that turns the user's own third-party AI
provider accounts (OpenRouter, OpenCode, b.ai, plus any future provider) into a single
normalized AI layer. Every request flows through a central Model Router that picks provider,
API key, and model, with transparent key rotation and provider failover, and exposes exactly
two model categories: Text and Image.

The differentiating requirement is **self-construction**: the IDE embeds its own AI (routed
through the Model Router itself) that can automatically onboard any unknown provider by probing
its API, classifying its dialect, generating a declarative adapter manifest, and validating it
with contract tests before human confirmation. The resulting Adapter-Generator → Router →
Adapters cycle is broken with a three-layer adapter stratification — static built-in dialect
templates at the bottom (no AI needed, which also solves the bootstrap problem), declarative
manifests in the middle (data interpreted by a single runtime interpreter), and sandboxed
generated code adapters only as a last resort.

A **Local Gateway** completes the picture: a Rust HTTP server inside the app exposes the whole
router as one OpenAI-compatible endpoint (`http://127.0.0.1:<port>/v1`) guarded by a
**locally generated master key**. The port is **configurable** (Control → Local Gateway), not a
constant: the compiled default is `8787`, but AI Hub v2 also claims 8787 and slides up when it loses,
so this machine runs **`8800`**. Read it from `settings.gateway.port` rather than assuming either.
Any third-party app — Cursor, scripts, chat UIs — can use
every configured provider through that single URL and single credential, with the same key
rotation and failover as the IDE's own UI ("custom AI to 3rd party").

Stack adjustment vs. the spec: `keytar` is archived (Dec 2022) — replaced by the Rust `keyring`
crate, with all outbound HTTP routed through a **Rust egress gateway** that performs credential
injection so the TypeScript layer never holds a raw secret.

---

## 1. Layered Architecture

Dependency rule: arrows only point downward.

```
L4  Presentation        React screens (Providers, Models, Assistant, Usage,
                         Router Settings, Onboarding Wizard)
L3  Application         Provider Registry svc, Onboarding Orchestrator,
                         Drift Monitor, Model Catalog svc, Usage Ledger svc
L2  Router Core         Model Router, Route Planner, Health Tracker,
                         Execution Engine, Adapter Runtime
L1  Adapter Layer       Manifest Interpreter (one generic adapter),
                         Builtin Dialect Templates, Sandbox Runtime,
                         Adapter Generator, Contract Suite
L0  Host Infrastructure Egress Gateway (Rust/reqwest), Keychain Vault
                         (Rust/keyring), SQLite Store, OS Keychain
```

*Layering is deliberately relaxed, not strict:* the rule "arrows point downward" governs the
majority of the graph, but L3 services may call L1 components directly
(`onboarding-orchestrator` → probe/generator/contract, `drift-monitor` → generator) because
those L1 modules are the pipeline's tools. This is by design — don't "fix" it.

### 1.1 Process topology

Two runtimes inside one desktop process:

- **Webview (TypeScript):** React UI + the entire `@aiprovider/router-core` package. UI-agnostic;
  talks to the host only through narrow ports implemented over Tauri IPC commands and channels.
- **Rust host:** the only code allowed to touch the network with credentials, the OS keychain,
  and SQLite. Exposes typed commands (`vault:*`, `egress:*`, `store:*`) and streams responses
  back via Tauri `Channel`s. Also runs the **Local Gateway** — an axum HTTP server exposing the
  router as an OpenAI-compatible endpoint (`/v1/chat/completions`, `/v1/models`,
  `/v1/images/generations`) authenticated by the master key; it validates the key against the
  keychain in Rust, then bridges the request into the router core over internal IPC. The
  gateway serves while the IDE runs (a future service mode could keep it alive headless).

Why HTTP lives in Rust: the Tauri webview origin cannot `fetch()` provider APIs directly
(providers don't send CORS headers). All egress goes through the Rust egress gateway — which is
also the single audited place enforcing the security invariants (credential injection, host
allowlisting, secret scrubbing).

### 1.2 Module map

| Module | Layer | Purpose |
|---|---|---|
| `ui-shell` | L4 | App shell, screen routing, global state |
| `screen-providers` | L4 | Provider cards, key rows, Test/add/remove (mirrors the sketch) |
| `screen-models` | L4 | Model Browser, Text/Image tabs, defaults |
| `screen-assistant` | L4 | Text chat + image box against any routed model |
| `screen-usage` | L4 | Ledger view, failures and fallbacks |
| `screen-router-settings` | L4 | Failover, rotation strategy, timeouts, system-AI pick |
| `screen-gateway` | L4 | Local Gateway settings: enable, port/endpoint URL, master key generate/rotate/revoke, copy presets for popular apps |
| `screen-onboarding` | L4 | Auto-Provider Onboarding wizard (probe → manifest → tests → confirm) |
| `ipc-client` | L4 | THE only UI↔core bridge: typed Tauri commands/events + `RouterFacade` |
| `provider-registry` | L3 | Provider/key CRUD, lifecycle states (draft → pending → enabled → disabled → repairing) |
| `key-vault-service` | L3 | Key-blind secret management by `secretRef`; secrets reach the user only via the Rust-side one-shot reveal (invariant 14), never through TS state |
| `model-catalog` | L3 | Discovery via adapters, local cache, modality tagging, alias map (auto-derives aliases for identical native IDs across providers + manual editor) |
| `usage-ledger` | L3 | Append per-request entries; query for Usage screen; cost estimate |
| `onboarding-orchestrator` | L3 | The pipeline state machine for auto-onboarding |
| `drift-monitor` | L3 | Error classification, drift detection, repair orchestration |
| `model-router` | L2 | Public facade: `generateText` / `generateImage` / `listModels`; system routes |
| `route-planner` | L2 | Expand request → ordered candidate plan `(provider, key, model)`; rotation strategies |
| `health-tracker` | L2 | Per-key and per-provider circuit breakers, cooldowns, status chips |
| `execution-engine` | L2 | Attempt loop: try candidate, classify error, rotate key → fail over provider |
| `adapter-runtime` | L2 | Resolve provider → adapter instance; adapter lifecycle & hot-swap |
| `manifest-interpreter` | L1 | THE generic adapter: executes any declarative manifest |
| `builtin-templates` | L1 | Static dialect manifests: `openai-compat`, `anthropic-compat` + provider profiles |
| `sandbox-runtime` | L1 | Executes generated CODE adapters in QuickJS-WASM (host functions only) |
| `adapter-generator` | L1 | Probe report → dialect classification → manifest synthesis/patching (AI-assisted) |
| `probe-runner` | L1 | Deterministic endpoint/auth probing of a candidate provider |
| `redaction` | L1 | Structure-only scrubber for anything destined for the Generator AI or logs |
| `contract-suite` | L1 | Conformance tests: `pingKey`, `listModels`, minimal text/image gen |
| `egress-gateway` (Rust) | L0 | ALL outbound HTTP: credential injection, host allowlist, SSE→channel streaming |
| `local-gateway` (Rust) | L0 | OpenAI-compatible local endpoint: master-key auth, request → router bridge, SSE streaming out |
| `keychain-vault` (Rust) | L0 | OS keychain CRUD via `keyring` v3; one-shot reveal; stores the master key |
| `sql-store` (Rust) | L0 | SQLite access + migrations |

### 1.3 Connectivity graph

```
screen-* ──typed IPC──> ipc-client ──fn call──> model-router facade
                                                    │
     ┌──────────────────────────────────────────────┼───────────────────────────┐
     ▼                                              ▼                           ▼
provider-registry ──refs──> key-vault-service   route-planner ──plans──> execution-engine
     │                          │                    ▲   ▲                    │
     │                          │            model-catalog  health-tracker     ├─attempts─> adapter-runtime
     │                          │                                              │                ├─manifest──> manifest-interpreter
     ▼                          ▼                                              │                └─code──────> sandbox-runtime
  sql-store <──store-port──────┤                                              ▼
                              keychain-vault (Rust) <────────── secretRef ── egress-gateway (Rust) <──http-port── manifest-interpreter
                                  │                                               │        sandbox-runtime
                                  └── raw secret (memory only) ────────────────────┘
execution-engine ──entries──> usage-ledger ──> sql-store
execution-engine ──error stats──> drift-monitor ──repair──> adapter-generator ──AI req──> model-router (system route)
onboarding-orchestrator ──> probe-runner ──http──> egress-gateway
onboarding-orchestrator ──> adapter-generator ──redacted report──> (AI via router)
onboarding-orchestrator ──> contract-suite ──> adapter-runtime
onboarding-orchestrator ──register manifest──> provider-registry
model-router ──stream chunks──(Tauri Channel)──> ipc-client ──> screen-assistant
external apps ──HTTP, Bearer master key──> local-gateway (Rust) ──auth ok──> model-router
local-gateway ──verify key──> keychain-vault
```

Hard rules encoded in the graph:
- UI never imports anything except `ipc-client`.
- Only `egress-gateway` (Rust) ever combines a `secretRef` with an HTTP request — the TS layer
  is key-blind by construction.
- Only `adapter-generator` and `drift-monitor` call the Router "from below"; they depend on an
  `AiTextPort` interface the Router implements (dependency inversion), never Router internals.

---

## 2. The Self-Construction Engine (auto-provider onboarding)

### 2.1 Pipeline

```
User: name, baseUrl, apiKey, [docsUrl]                     (apiKey → straight to keychain-vault)
  ▼
[1] probe-runner ──GET/OPTIONS probes──> egress-gateway ──> candidate provider
        │  endpoint matrix (/v1/models, /models, /v1/chat/completions, /v1/messages,
        │  /openapi.json, /docs), auth-style probes (401 + WWW-Authenticate, Bearer/x-api-key/…)
        ▼
    raw ProbeReport (values REDACTED by `redaction` → structure only; secrets never present)
  ▼
[2] dialect-fingerprinter (deterministic, NO AI)
        ├── matches openai-compat / anthropic-compat signature? ──> instantiate builtin template
        └── openapi.json present? ──> derive endpoints directly from spec
                │ success → jump to [4]                     ← THE BOOTSTRAP PATH
  ▼ (no match)
[3] adapter-generator: AiTextPort.complete(redacted report + docs excerpt)
        │  via model-router SYSTEM ROUTE (excludeProviderIds=[candidate])
        │  best-of-N candidates → zod schema validation → manifest lint (host pinned to user input)
        ▼
    draft AdapterManifest (declarative)
  ▼
[4] contract-suite with user's key: pingKey → listModels → minimal text (PAID: consent)
        → minimal image if claimed (PAID: consent) → pass/fail report per candidate
  ▼
[5] provider-registry: register provider (status=pending) + manifest (version 1, origin tag)
  ▼
[6] HUMAN CONFIRMATION (review: manifest summary, test results, cost) ──> Enable
  ▼
[7] model-catalog discovery → Text/Image tagging → provider live; Generator feature unlocks
```

Pipeline state machine:
`collect-input → probing → fingerprinting → (template-instantiated | ai-generating) → linting →
contract-testing → pending-registration → human-confirmation → enabled` — every state persisted
in `onboarding_sessions` so the wizard resumes after an app restart. Failures are recoverable:
contract failure shows the failing assertion and allows "regenerate with feedback".

### 2.2 Probe design (deterministic, free-first)

- **Free probes (always):** GET on a matrix of candidate model-list paths, `GET /openapi.json`
  and `/docs` (OpenAPI discovery — when present, endpoints derive without AI), unauthenticated
  request to capture `401` + `WWW-Authenticate`, header-variant authenticated GETs.
- **Paid probes (never automatic):** only inside contract testing, behind explicit consent with
  estimated cost (`max_tokens: 1`, smallest image size).

### 2.3 Redaction contract — what the AI may and may not see

The Generator AI receives exactly: endpoint paths and methods tried, status codes, response
**JSON schemas** (keys and types, values stripped), auth header *names* (not values), SSE event
shapes, and an optional excerpt of the provider's **public docs** (scrubbed). `redaction`
enforces: no response bodies, no header values, a regex scrub for key-shaped strings
(`sk-…`, `Bearer …`, high-entropy tokens), and a size cap. Probe content is untrusted input
(prompt-injection surface); the Generator's output is validated strictly against the manifest
schema and lint rules, so a hostile provider cannot smuggle a host change or an exfiltration
endpoint through the manifest.

### 2.4 Dialect fingerprinting (the deterministic path)

| Signature | Template |
|---|---|
| `GET /v1/models` → `{data:[{id,…}]}`, `POST /v1/chat/completions` exists, SSE `data:` chunks | `openai-compat` |
| `/v1/messages` + `x-api-key` + `anthropic-version` header | `anthropic-compat` |
| OpenAPI document present | derive manifest from the spec, then template fallback |

Template instantiation = copy the template manifest, pin the user's `baseUrl`, attach the key
ref — no AI involved. Expected to cover the large majority of real providers (OpenRouter and
OpenCode Zen are both OpenAI-compatible; Ollama and LM Studio too, giving free local-model
support as a side effect).

### 2.5 AI generation path (only when fingerprinting fails)

- Prompt = manifest schema + few-shot examples of known dialects + redacted probe report
  (+ docs excerpt).
- **Best-of-N:** up to 3 candidate manifests; each zod-validated, linted, contract-tested;
  ranking = contract pass score, then specificity, then simplicity.
- Runs on the user-picked **System AI** model (Router Settings), defaulting to a cheap strong
  text model. Requests bounded (`maxTokens`, timeout) and audited in `generator_audit`
  (token counts + redaction hash — never content).

### 2.6 Declarative adapter manifest (schema v1.1)

```jsonc
{
  "manifestVersion": 1,
  "dialect": "openai-chat-v1",
  "provider": {
    "baseUrl": "https://openrouter.ai/api/v1",     // pinned to USER input; generator cannot change it
    "auth": { "headers": [                          // v1.1: multiple auth headers (e.g. api-key + organization)
      { "name": "Authorization", "prefix": "Bearer" }
    ] }
  },
  "endpoints": {
    "listModels":  { "method": "GET",  "path": "/models",
                     "pagination": { "style": "openai-cursor" },  // v1.1: follow paged model lists
                     "map": { "models": "$.data[*].id", "raw": "$.data[*]" } },
    "generateText":{ "method": "POST", "path": "/chat/completions",
                     "headers": { "HTTP-Referer": "{{appUrl}}", "X-Title": "AI-Provider Router" },
                                                                       // v1.1: static extra request headers
                     "requestTemplate": { "model": "{{model}}", "messages": "{{messages}}",
                                          "stream": "{{stream}}",
                                          "max_tokens": "{{maxTokens?}}" },
                                                                       // v1.1: "?" suffix = omit the field
                                                                       // entirely when unset (sending null
                                                                       // breaks some servers)
                     "responseMap": { "text": "$.choices[0].message.content", "usage": "$.usage" },
                     "stream": { "protocol": "sse",
                                 "chunkMap": { "delta": "$.choices[0].delta.content" },
                                 "errorMap": { "$.error": "PASS_THROUGH" },
                                                                       // v1.1: mid-stream error events under
                                                                       // a 200 status, classified into the
                                                                       // §2.10 taxonomy
                                 "finish": "$.choices[0].finish_reason" } },
    "generateImage":{ "method": "POST", "path": "/images/generations",
                      "requestTemplate": { "model": "{{model}}", "prompt": "{{prompt}}" },
                      "responseMap": { "imageB64": "$.data[0].b64_json",
                                       "imageUrl": "$.data[0].url" } }
  },
  "capabilities": { "text": true, "image": true },
  "modalityRules": { "image": { "modelIdPattern": "^(dall-e|flux|sd|imagen)" } },
  "limits": { "maxOutputTokens": 8192 },
  "provenance": { "origin": "builtin-template|ai-generated|ai-patched|user-edited",
                  "generatorModel": null, "contractResult": { /* pass/fail detail */ },
                  "createdAt": "...", "validatedAt": "..." }
}
```

The mapping language is a deliberately tiny, versioned subset of JSONPath selectors plus
`{{placeholder}}` templating — documented, lintable, safe by construction (no expressions, no
eval). v1.1 additions (from the audit, frozen with Phase 1): **multiple auth headers**,
**per-endpoint static request headers**, **conditional field omission** (`{{field?}}`),
**`stream.errorMap`** for mid-stream errors, and **model-list pagination**. Manifest lint also
enforces a **whitelist of permitted request-body fields per endpoint** (a hostile manifest
cannot smuggle extra body parameters) and bounds OpenAPI-derived path counts/lengths. If a
provider cannot be expressed in this grammar, fall to Tier 2.

### 2.7 Tier-2 fallback: sandboxed code adapters

Only when no declarative manifest can express the provider (exotic auth dance, non-JSON
framing, WebSocket-only streaming). The Generator emits a JS module implementing the adapter
interface; it executes in **QuickJS compiled to WASM** with host functions limited to: `http`
(routed through the egress gateway, same allowlist), `log` (scrubbed), `clock`, `random`. No
filesystem, no DOM, no Node APIs, no dynamic import; hard execution timeouts, a WASM memory
cap, and a rate limit on the `http` host function (a hostile generated adapter cannot hammer
endpoints or exhaust memory within its timeout). Stored versioned
in SQLite, never executed before passing the contract suite, always human-confirmed. Deliberately
the last resort (Phase 6).

### 2.8 The circular dependency — Adapter Generator → Router → Adapters — broken three ways

The naive cycle: the Generator needs an AI model (Router) → the Router needs adapters → new
adapters come from the Generator.

1. **Stratification (structural break).**
   ```
   Tier 0  Builtin dialect templates   static data shipped with the app, zero AI, zero runtime deps
   Tier 1  Declarative manifests       inert DATA, executed by ONE ManifestInterpreter at runtime
   Tier 2  Sandbox code adapters       generated JS, executed by SandboxRuntime (last resort)
   ```
   The Router's only compile-time dependencies are the ManifestInterpreter and the
   SandboxRuntime — both fixed, shipped code. The Generator's *output* is inert data, not a live
   dependency. At runtime the graph is a DAG: `Generator → Router → existing adapters`.

2. **Dependency inversion (module-level break).** `adapter-generator` imports only:
   ```ts
   interface AiTextPort {
     complete(req: { prompt: string; system?: string; maxTokens: number;
                     timeoutMs: number; excludeProviderIds: string[] }): Promise<string>;
   }
   ```
   `model-router` implements it. No import cycle is even possible in the package graph.

3. **Bootstrap guard + exclusion rule (temporal break).** The Generator is disabled until at
   least one provider is live via a Tier-0 template, and every Generator AI request carries
   `excludeProviderIds` containing the provider being onboarded or repaired — the Router can
   never be asked to serve a generation through the very adapter that does not exist yet.

### 2.9 The bootstrap problem — resolution

Self-construction needs a working AI model, but the first provider has no adapter yet:

1. **Tier-0 templates require no AI.** First provider onboards via fingerprinting +
   `openai-compat`/`anthropic-compat` templates — fully deterministic, works on a fresh
   install with zero AI. OpenRouter (the obvious first provider) is OpenAI-compatible, so the
   realistic first-run experience needs no AI at all.
2. **The Generator is availability-gated.** The wizard shows the AI-assisted path as disabled
   with an explanation ("Add any OpenAI-compatible provider first") until
   `router.health.systemAiAvailable === true` (≥1 enabled provider with a passing text
   contract test and ≥1 active key).
3. **System route is user-configurable and healthy-first.** Router Settings picks which
   provider/model powers the Generator; the planner prefers it, falls back to any healthy text
   provider, always applies `excludeProviderIds`.

### 2.10 Self-healing / drift detection and repair

- **Error taxonomy** (execution-engine): `AUTH_FAILED` (401/403), `RATE_LIMITED` (429, honors
  `Retry-After`), `NOT_FOUND` (404 on a declared endpoint), `BAD_REQUEST_SCHEMA` (400 with
  field errors), `PARSE_ERROR` (response doesn't match `responseMap`), `SERVER_ERROR` (5xx),
  `TIMEOUT`. Only `NOT_FOUND`, `BAD_REQUEST_SCHEMA`, `PARSE_ERROR`, and provider-wide
  `AUTH_FAILED` count as drift signals.
- **Detection:** sliding window per provider — default trigger: ≥5 drift-class errors within
  15 minutes affecting ≥2 models, while the same models succeed via other providers (isolates
  provider-side change from our bug). Plus a scheduled weekly re-probe and a manual
  "Repair provider" action.
- **Repair flow:** mark provider `repairing` (failover keeps requests flowing) → re-probe →
  deterministic re-fingerprint first → if still failing, Generator produces a manifest **patch**
  (old manifest + new redacted probe report + failing assertions; `excludeProviderIds=[P]`) →
  contract suite → staged as a new manifest **version** → human confirmation → hot-swap in
  `adapter-runtime` → previous version retained for one-click rollback. Rate-limited: at most
  one auto-re-probe per provider per hour; repairs always human-confirmed. If the broken
  provider is the user's ONLY provider, AI-assisted repair has no candidate model
  (`excludeProviderIds`) — the flow falls back to deterministic re-fingerprinting only, with
  an explanatory message ("AI-assisted repair needs a second healthy provider").

---

## 3. Data Flows

### 3.1 Text generation (streaming, with rotation and failover)

```
User (Assistant)
  │  router.generateText({ model | capability, messages, stream: true })
  ▼
model-router ──> route-planner
  │                │ plan = [ (OpenRouter,key1,gpt-4o), (OpenRouter,key2,gpt-4o),
  │                │           (OpenCode,key1,gpt-4o-alias), ... ]        modality=text
  ▼                ▼
execution-engine ──attempt 1──> adapter-runtime ──manifest──> manifest-interpreter
  │                                │
  │                                └─http-port: { secretRef:k1, POST /v1/chat/completions, no auth }
  │                                        │
  │                                        ▼
  │                                egress-gateway (Rust): resolve k1 → keychain → inject
  │                                "Authorization: Bearer •••" → provider host allowlist check
  │                                        │  SSE stream
  │  401/429 ◄────────────────────────────┘
  ▼
health-tracker: mark key1 (invalid | cooldown=Retry-After) ──> execution-engine advances plan
  │
  ├─ attempt 2 (OpenRouter,key2) … all keys fail ──> provider breaker opens ──> failover
  ├─ attempt 3 (OpenCode,key1) ── 200 SSE ── chunks via Tauri Channel ──> ipc-client ──> Assistant
  └─ usage-ledger.append({ provider, key, model, tokens, latency, fallbackChain:[OR→OR→OC], ok })
```

### 3.2 Image generation

```
User (Assistant) ──router.generateImage({ model, prompt, size })──> model-router
  ▼
route-planner (modality=image, via model-catalog modality tags)
  ▼
execution-engine ──> manifest-interpreter (image endpoint mapping: b64_json | url)
  │                    └─http-port ──> egress-gateway (credential injection) ──> provider
  ▼
ImageResult { data, mime, provider, keyId, latency }  ── progress events ──> Assistant
usage-ledger.append({ modality: "image", … })
```

### 3.3 External app via the Local Gateway (master key + endpoint URL)

```
Any app (Cursor · VS Code ext · scripts · chat UI)
  │  POST http://127.0.0.1:<port>/v1/chat/completions
  │  Authorization: Bearer sk-aip-…            (the master key)
  ▼
local-gateway (Rust, axum)
  │  1. validate master key against keychain-vault   → 401 on invalid/revoked
  │  2. parse the OpenAI-compatible request (model, messages, stream)
  ▼
model-router            ← identical path to internal requests:
  │                        plan (provider, key, model) → attempt → rotate on 429/401
  │                        → fail over provider → normalize
  ▼
egress-gateway → provider → SSE stream flows back: provider → egress → router
                 → local-gateway → the external app
usage-ledger.append({ ..., source: "gateway" })
```

**Master key lifecycle.** Generated in-app on first enable (crypto-random, `sk-aip-…`
format), stored in the OS keychain (account `masterkey`), displayed once with a copy button,
never written to the DB or logs. Rotate = generate a new key (old one dies instantly);
revoke = disable the gateway. Reveal is one-shot, like provider keys.

**Endpoint URL setup.** Gateway Settings: enable toggle, port picker (default 8787), the full
endpoint URL shown for copying (`http://127.0.0.1:<port>/v1`, the configured port — not a fixed one),
a "test connection" button, and
copy-paste presets for common tools (Cursor, Continue, openai-python base_url override). Binds
`127.0.0.1` only by default; LAN sharing is a separate explicit opt-in with a warning.

### 3.4 Compatibility contract (the OpenAI-compatible surface)

The gateway's value proposition is "OpenAI-compatible" — so the exact surface is specified, not
assumed (audit H2):

| Field | v1 decision |
|---|---|
| `model`, `messages`, `stream`, `max_tokens` | **Supported**, mapped through the manifest |
| `temperature` | **Supported** (passed through when the manifest allows it) |
| `tools`, `tool_choice`, `response_format` | **Not in v1** → explicit `400` with a clear message ("tool calls are not supported yet") — never silently dropped |
| `n`, `logprobs`, `user`, everything else unknown | **Ignored**, with a warning recorded in the ledger entry |
| `/v1/messages` (Anthropic Messages dialect) | **Supported (v1.1, 2026-09-16)** — Claude Code / anthropic-sdk ingress: `x-api-key` auth accepted, messages translated, replies re-framed as Anthropic events; `tools`/`tool_choice` refused with the Anthropic error envelope |
| `/v1/models` | **Supported** — merged catalog, qualified IDs |
| `/v1/responses` | **Supported (v1.1, 2026-09-16)** — Codex-style ingress: `input`/`instructions` translated; streaming emits `response.created → …output_text.delta → …completed` |
| Gemini `/v1beta/models/<m>:generateContent[:stream]` | **Supported (v1.1)** — `x-goog-api-key` or `?key=`; `contents/parts` translation; SSE via `?alt=sse` |
| `/v1/embeddings` | **Out of scope for v1** (extension point: the modality enum) |
| Error shape | OpenAI-style: `{"error": {"message", "type", "code"}}` |

**Merged `/v1/models` ID scheme.** Catalog entries are exposed as qualified IDs
`<provider-slug>/<native-id>` (e.g. `openrouter/gpt-4o`, `b.ai/qwen3.8-flash`). A **bare ID**
(`gpt-4o`) resolves through `model_aliases`: if exactly one healthy provider carries it, it
serves; if several do, the alias priority order decides; if none, a clear 404-style error names
the qualified alternatives. The Model Browser shows and edits this mapping.

### 3.5 Gateway bridge contract (availability, cancellation, concurrency)

The gateway bridges external HTTP into the webview-hosted router core — the failure modes are
specified, not left implicit (audit H1):

- **Core unavailable** (webview reloading/crashed/closed): the axum gateway answers
  **`503` + `Retry-After: 1`** immediately; no request is queued against a dead core.
- **Cancellation:** every request carries an abort signal. A client disconnecting mid-stream
  propagates: axum disconnect → internal IPC abort → execution-engine stops the attempt →
  egress stream is closed to the provider. The same mechanism backs the Assistant "stop"
  button and app shutdown (`router.generateText(req, { signal })`).
- **Concurrency:** max concurrent routed requests (default 8) with a bounded queue (default 32);
  overflow answers `429` + `Retry-After`. Excess load degrades gracefully instead of stalling
  the webview.
- **Window policy (v1):** single-window app. The gateway serves while the app runs; closing the
  window stops the gateway, and the Gateway settings screen says so plainly. A headless
  service/menu-bar mode is an explicit **v1 non-goal** (extension point noted in §7).
- **Entry gate:** Phase 2b starts only after an end-to-end **SSE-through-IPC spike** proves a
  streamed completion round-trips through the bridge under load (including a mid-stream
  disconnect).

### 3.6 Routing, timeout & concurrency policy

One "request timeout" cannot serve every phase (audit M4) — the route-planner and
execution-engine implement a per-phase budget:

| Budget | Default | Notes |
|---|---|---|
| Connect | 10 s | TCP/TLS to the provider |
| First byte | 30 s | covers model queueing |
| Idle stream | 60 s | resets on every SSE chunk — long generations are not "timed out" at 30 s |
| Total per attempt | none | bounded by the budgets above |
| Max attempts per request | 6 | across the whole plan (rotation + failover combined) |
| Backoff | jittered exponential | on `RATE_LIMITED`/`SERVER_ERROR`, honoring `Retry-After` |
| Per-provider concurrency cap | 4 | with a bounded queue; protects all consumers from one fan-out app |

Retries vs. rotation: each attempt on the plan (next key or next provider) IS the retry — there
is no separate hidden retry loop. Per-app gateway keys (traffic attribution, revoking one
abusive app) are a **stated v1 limitation** — one master key for now.

---

## 4. Storage Design

**SQLite** (app-data dir; `tauri-plugin-sql` in production, `better-sqlite3` in unit tests,
both behind `store-port`). **One migration runner** behind `store-port` applies ordered
`NNNN_name.sql` files (each in a transaction — SQLite DDL is transactional) and records history
in `schema_version`; forward-only, never edit an applied migration. A single runner — not the
plugin's own migration list — avoids test/production schema split-brain (audit M14).

Schema **v1.1** (audit C1, H6, M13 applied — full constraints, indices, rollups):

```sql
-- Conventions: all timestamps are INTEGER Unix milliseconds (UTC);
-- cost_estimate_micros is micro-USD (pricing_json normalized to USD at cache-write time).

CREATE TABLE schema_version (            -- migration history
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  type              TEXT,                -- adapter tier: 'builtin' | 'manifest' | 'sandbox'
  base_url          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending','enabled','disabled','repairing')),
  rotation_strategy TEXT NOT NULL DEFAULT 'round_robin'
                    CHECK (rotation_strategy IN ('round_robin','lru','priority','cost_spread')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);                                      -- no `enabled` column: derived from status

CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  secret_ref     TEXT NOT NULL,          -- keychain account `key:<id>`; NEVER the secret
  secret_hint    TEXT,                   -- last 4 chars only; feeds the re-enter-key UX
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','cooldown','invalid','disabled')),
  priority       INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,                -- NULL = none; survives restart
  added_at       INTEGER NOT NULL,
  last_used_at   INTEGER,
  last_tested_at INTEGER
);
CREATE INDEX idx_api_keys_plan ON api_keys(provider_id, status, priority);

CREATE TABLE manifests (
  id                   TEXT PRIMARY KEY,
  provider_id          TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  version              INTEGER NOT NULL,
  origin               TEXT NOT NULL
                       CHECK (origin IN ('builtin-template','ai-generated','ai-patched','user-edited')),
  body_json            TEXT NOT NULL,
  contract_result_json TEXT,
  created_at           INTEGER NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  UNIQUE (provider_id, version)
);
CREATE UNIQUE INDEX uq_manifests_one_active ON manifests(provider_id) WHERE is_active = 1;

CREATE TABLE models_cache (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  native_id         TEXT NOT NULL,
  modality          TEXT NOT NULL CHECK (modality IN ('text','image')),
  context_window    INTEGER,             -- provider's published prompt budget
  capabilities_json TEXT,                -- {"reasoning":bool}; what we publish to clients
  pricing_json      TEXT,                -- {prompt,completion} micro-USD per 1M tokens
  fetched_at        INTEGER NOT NULL,
  raw_json          TEXT,                -- unused: never written, never read
  UNIQUE (provider_id, native_id)
);
CREATE INDEX idx_models_provider_modality ON models_cache(provider_id, modality);

CREATE TABLE model_aliases (             -- NO FK to models_cache: a cache refresh must not
  alias           TEXT NOT NULL,         -- destroy the failover map; dangling native_model_id
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  native_model_id TEXT NOT NULL,         -- = "unverified, resolve at plan time"
  priority        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (alias, provider_id)
);
CREATE INDEX idx_aliases_alias ON model_aliases(alias);

CREATE TABLE ledger (                    -- append-only log: NO FKs (soft refs — history
  id                INTEGER PRIMARY KEY, -- survives provider/key deletion)
  ts                INTEGER NOT NULL,
  modality          TEXT NOT NULL CHECK (modality IN ('text','image')),
  source            TEXT NOT NULL DEFAULT 'ui'
                    CHECK (source IN ('ui','gateway','generator')),   -- replaces `internal`
  provider_id       TEXT,
  key_id            TEXT,
  requested_model   TEXT,                -- the alias the caller asked for
  model             TEXT NOT NULL,       -- the native model that actually served
  status            TEXT NOT NULL,
  http_status       INTEGER,
  error_class       TEXT,
  latency_ms        INTEGER,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  cost_estimate_micros INTEGER NOT NULL DEFAULT 0,
  fallback_chain_json  TEXT
);
CREATE INDEX idx_ledger_ts ON ledger(ts);
CREATE INDEX idx_ledger_provider_ts ON ledger(provider_id, ts);
CREATE INDEX idx_ledger_drift ON ledger(provider_id, ts)   -- the §2.10 sliding window
  WHERE error_class IN ('NOT_FOUND','BAD_REQUEST_SCHEMA','PARSE_ERROR','AUTH_FAILED');

CREATE TABLE ledger_rollups (            -- monthly aggregates, kept indefinitely
  month              TEXT NOT NULL,      -- 'YYYY-MM' UTC
  provider_id        TEXT NOT NULL,
  model              TEXT NOT NULL,
  modality           TEXT NOT NULL CHECK (modality IN ('text','image')),
  requests           INTEGER NOT NULL,
  failures           INTEGER NOT NULL,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  cost_estimate_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, provider_id, model, modality)
);

CREATE TABLE drift_events (
  id           INTEGER PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  detected_at  INTEGER NOT NULL,
  trigger_json TEXT,
  resolution   TEXT,
  resolved_at  INTEGER
);
CREATE INDEX idx_drift_provider_time ON drift_events(provider_id, detected_at);

CREATE TABLE onboarding_sessions (
  id                         INTEGER PRIMARY KEY,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,   -- resume picks the most recent session
  input_json                 TEXT NOT NULL,
  probe_report_redacted_json TEXT,
  candidates_json            TEXT,
  state                      TEXT NOT NULL
                             CHECK (state IN ('collect_input','probing','fingerprinting',
                               'template_instantiated','ai_generating','linting',
                               'contract_testing','pending_registration',
                               'human_confirmation','enabled')),
  outcome                    TEXT
);
CREATE INDEX idx_onboarding_recent ON onboarding_sessions(updated_at DESC);

CREATE TABLE generator_audit (
  id                INTEGER PRIMARY KEY,
  ts                INTEGER NOT NULL,
  session_id        INTEGER REFERENCES onboarding_sessions(id) ON DELETE SET NULL,
  model_used        TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  redaction_hash    TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
```

**Retention & rollups.** Raw ledger entries are kept 90 days; a nightly (or on-start) job
aggregates complete months into `ledger_rollups` (idempotent `INSERT … ON CONFLICT DO UPDATE`)
and deletes raw rows past the cutoff. Drift windows only ever read 15 minutes of raw rows —
rollups never affect drift detection. No request/response bodies are stored by default
(privacy + size); opt-in capture per assistant session.

**Local-file hygiene.** Every connection (both drivers) sets
`journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000` (SQLite defaults
`foreign_keys` OFF — without this every FK above is decorative). On open: `integrity_check`;
on quit or daily: `VACUUM INTO` a dated backup, keep the last 7; on corruption, offer restore
from the newest good backup. A user-initiated **config export** (JSON: providers, manifests,
aliases, settings, `secret_ref`s — never keychain values) provides a portable,
human-inspectable disaster-recovery path.

**OS keychain** (Rust `keyring` v3, service `ai-provider-router`, accounts `key:<keyId>` for
provider keys and `masterkey` for the Local Gateway master key): the only home of raw secrets.
Linux requires Secret Service (gnome-keyring/KWallet) — surfaced as a
first-run check; macOS Keychain and Windows Credential Manager work out of the box.

**Restore on a new machine.** A restored DB references keychain accounts that do not exist
there (audit H7). On startup, the key-vault service probes every `secret_ref`; on a miss it
sets `api_keys.status='invalid'` and the Providers screen shows a re-enter-key flow per key
(the `secret_hint` last-4-chars makes this usable). Importing a config export does the same
probe before the provider is enabled.

**Why this split:** the DB is corruptible, copyable, backed up — therefore it holds only
references. A CI test greps the app-data dir and logs for key patterns after every E2E run
(enforces acceptance criterion 5).

---

## 5. Security Invariants (numbered, testable)

1. **Raw secrets live only in the OS keychain.** The DB stores `secret_ref` only.
2. **The TypeScript layer is key-blind by construction.** Credential injection happens only in
   the Rust egress gateway: TS sends `{secretRef, request-without-auth}`; Rust resolves the
   keychain entry, injects the header, sends, drops the value. The Generator AI — and any code
   in the webview — cannot leak a key it can never read.
3. **All egress flows through one audited module** (egress-gateway) enforcing: destination host
   ∈ the user-supplied baseUrl of a registered provider or a provider being onboarded
   (allowlisted at input time), plus user-supplied docs URLs during onboarding. **One
   carve-out:** a URL returned *in the body of a same-request response* (e.g. an `imageUrl`
   from an image generation) may be fetched by the egress gateway scoped to that request only —
   never persisted to the allowlist. Localhost providers permitted — the allowlist derives from
   user-registered baseUrls.
4. **The Generator never changes hosts.** Manifest lint pins `baseUrl` to the user-entered
   value; the AI selects paths, headers, and mappings only.
5. **Everything destined for the Generator AI passes `redaction`** — structure-only probe
   reports, docs scrubbed, size-capped. Audited without content (hashes + token counts).
6. **One-shot reveal only:** masked display everywhere; revealing is an explicit user action.
7. **Paid validation calls require explicit consent** with estimated cost.
8. **Sandboxed code adapters get no filesystem, no direct network, no eval**, hard timeouts,
   egress via the same gateway allowlist.
9. **No telemetry.** The egress allowlist makes this mechanically true, not aspirational.
10. **The master key is a keychain secret, not config.** Generated locally (crypto-random),
    stored under the `masterkey` keychain account, shown once, never in the DB or logs.
    Rotation kills the old key instantly; the gateway answers 401 before any routing work.
11. **The Local Gateway binds `127.0.0.1` only by default.** LAN exposure is a separate
    explicit opt-in with a warning; the gateway authenticates every request (Bearer master
    key) before it touches the router or any provider credential.
12. **The webview is hardened, not trusted.** A strict CSP (no remote content); Tauri 2
    capability files scope every command namespace to the exact window/frame that needs it —
    `egress:*` is callable only from the router-core context, and the `tauri-plugin-sql`
    surface is restricted to `store-port` commands rather than raw SQL from webview JS.
13. **Untrusted content renders as text, always.** Model output, provider/model strings, error
    messages, and docs excerpts never enter the DOM as HTML (no `dangerouslySetInnerHTML`,
    no markdown-HTML passthrough without sanitization).
14. **Key reveal never passes through the webview DOM.** The one-shot reveal is a Rust-side
    native dialog/copy action; the secret is never placed in webview-observable state.
15. **Gateway auth is throttled and constant-time.** Per-source exponential backoff after
    repeated key failures; master-key comparison is constant-time. The LAN opt-in warning
    states explicitly that the master key and all prompts transit in cleartext HTTP.
16. **Port squatting is detected, and the residual risk is documented in the UI.** A bind
    failure on the configured port is a loud error with remediation; the Gateway settings note
    that a local process could theoretically squat the port (fixed default port 8787 is a
    deliberate v1 trade-off for predictable URLs).

---

## 6. Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| Tauri 2 | Desktop shell, Rust host, IPC, channels | Rust host needed anyway for keychain/CORS-free egress/sandbox |
| React 18 + TypeScript + Vite + Tailwind | UI | Per spec |
| pnpm workspaces | `apps/desktop`, `packages/router-core`, `packages/adapter-spec` | Keeps core UI-agnostic, independently testable |
| zod | Manifest schema, IPC payload validation | Runtime validation of AI output is security-relevant |
| eventsource-parser | SSE parsing in `manifest-interpreter` | |
| zustand | UI client state | Server-ish state lives in core |
| vitest | Unit tests of router core with fake ports | |
| mock OpenAI-compatible server (Fastify, test-only) | Contract-suite double + E2E rotation/failover tests | Also used by CI key-leak grep test |
| Playwright + tauri-driver | E2E | Phase 3+; macOS is tauri-driver's weakest platform — UI logic is E2E'd with Playwright against the Vite dev server, true app E2E runs tauri-driver on Linux CI |
| Rust: reqwest + tokio | `egress-gateway` — all outbound HTTP, streaming | Own client = credential injection + allowlist control |
| Rust: axum | `local-gateway` — OpenAI-compatible local endpoint, master-key auth | Serves external apps; streams SSE out |
| Rust: keyring v2 | `keychain-vault` | v3's macOS data-protection keychain breaks unsigned dev builds (secrets unreadable cross-process) — see DECISIONS.md 2026-09-16; revisit at signed-release time. `keytar` archived Dec 2022 — rejected |
| tauri-plugin-sql (SQLite) | `sql-store` + migrations | Behind `store-port` |
| quickjs-emscripten | Tier-2 sandbox for generated code adapters | Phase 6 |
| No telemetry/analytics SDK | — | Deliberate |

---

## 7. Extension Points

- **Modality enum** — `text | image` now; `audio | video` later touches the enum, one manifest
  endpoint block, and one browser tab. Router internals are modality-agnostic.
- **Dialect templates** — a template is data; new ones ship without code changes.
- **Manifest schema versions** — `manifestVersion` + per-version interpreter; old manifests keep working.
- **Routing strategies** — `RotationStrategy` interface; add new ones without touching the planner.
- **Sandbox host functions** — the Tier-2 capability surface can grow independently.
- **Contract test packs** — each new test applies to all adapters at once.
- **Screens** — any new screen is a new consumer of `ipc-client`; nothing else changes.
- **Provider profiles** — thin overlays on templates for provider-specific quirks.
- **Headless service mode** — the Local Gateway detached from the app window (menu-bar /
  launch-agent), a v2 extension once the §3.5 bridge contract is proven in practice.
- **Gateway ingress dialects** — each external compatibility surface (OpenAI Chat, Anthropic
  Messages; Responses and Gemini later) is one axum handler translating to the normalized
  router call; the router core itself stays single-surface (§3.4 v1.1).

**Lifecycle & hygiene (v1 decisions, from the audit):** port-conflict on 8787 is a loud error
with remediation UX; deleting a key removes its keychain entry in the same transaction;
deleting a provider cascades keys/manifests/catalog rows (ledger history is preserved — it has
no FKs by design); Assistant conversations persist per session only (v1); models-cache TTL
24 h with manual refresh and stale-fallback; the app is single-window (a second window would
instantiate a second router core — rejected); i18n and a11y beyond platform defaults are
declared **non-goals for v1**; a single master key (no per-app keys) is a **stated v1
limitation**.

---

## 8. Gaps, Risks & Open Questions

- **b.ai — RESOLVED (was misread as "Bolt").** The third drawn provider is **b.ai** (confirmed
  by the user 2026-09-15). It is an Anthropic-compatible AI provider (base URL
  `https://api.b.ai/v1`, anthropic-messages dialect; the user's own working config carries
  models `qwen3.8-flash` and `hy3`). Pin exact auth style, model-list endpoint, and pricing in
  the Phase 0/1 provider-facts spike; otherwise no open question remains. *(The original sketch
  analysis misread the handwriting as "Bolt" — bolt.new exposes no LLM API, which raised the
  earlier question.)*
- **OpenCode** — OpenCode Zen offers pay-per-request model access (likely OpenAI-compatible);
  exact base URL/auth to pin during Phase 1 from their docs. **Open question 2.**
- **Declarative grammar expressiveness** — some providers won't fit the manifest subset;
  mitigated by Tier-2 sandbox and graceful UX. **Major.**
- **AI-generated manifest quality** — mitigated by best-of-N, contract gates, human
  confirmation, versioned rollback; residual risk handled by drift repair. **Major.**
- **Prompt injection via probe/docs content** — mitigated by structure-only redaction, strict
  schema validation, host pinning. **Major — addressed head-on.**
- **Generator bootstrap dead-end** if the user's only provider is non-standard — the wizard
  explains the prerequisite clearly. **Minor.**
- **Linux keychain absence on headless setups** — first-run check + clear error. **Minor.**
- **E2E testing of rotation/failover** — local mock OpenAI-compatible server. **Major.**
- App signing/notarization + updater — **minor for v1, major before sharing.**

Risks added from the 2026-09-15 audit, each now carried by a design section:

- **Webview-hosted core as the gateway's availability bottleneck** — mitigated by the bridge
  contract (§3.5: 503 semantics, concurrency bound, window policy) and the Phase 2b entry
  spike. **Major until the spike passes.**
- **Provider-semantics divergence breaking the OpenAI-compat promise** (tool calls, parameter
  handling) — mitigated by the explicit compatibility contract (§3.4: unsupported fields error
  loudly, never silently). **Major.**
- **Runaway spend via gateway consumers** — per-provider concurrency caps (§3.6) bound it; the
  usage ledger with `source` attribution makes it visible; per-app keys + budgets are the
  follow-up. **Medium.**
- **Model-ID collision in the merged catalog** — resolved by qualified IDs + alias priority
  (§3.4). **Designed against.**
- **`quickjs-emscripten` maintenance/escape surface** — Tier 2 is last-resort and Phase 6;
  the WASM sandbox is defense-in-depth, not the only boundary. **Low.**
- **Localhost port squatting** (a local process binding 8787 first) — detected loudly,
  residual risk documented in the UI (invariant 16). **Low.**

---

## 9. Build Plan

**Phase 0 — Scaffold + decisions spike (S)**
- pnpm monorepo: `apps/desktop` (Tauri 2 + React + Vite + Tailwind), `packages/router-core`, `packages/adapter-spec`
- CI: typecheck, vitest, lint, key-leak grep test stub
- **Provider-facts spike:** pin b.ai's auth style, model-list endpoint, and pricing; pin
  OpenCode Zen's base URL/auth (both already proven to exist — facts, not unknowns)
- **Decisions recorded:** compatibility contract (§3.4), manifest grammar v1.1 freeze (§2.6),
  gateway bridge contract (§3.5), webview hardening setup (invariants 12–14)

**Phase 1 — Host infrastructure + router core (L)**
- `keychain-vault` (keyring v3) + `egress-gateway` (reqwest, credential injection, allowlist, channel streaming)
- Domain types, ports (`HttpPort`, `KeyVaultPort`, `StorePort`), SQLite **schema v1.1 + the
  single migration runner + WAL/backup/pragma init** (§4)
- Manifest schema v1.1 + `manifest-interpreter` + `openai-compat`/`anthropic-compat` templates + contract suite (vs mock server)
- `provider-registry`, `route-planner` (rotation strategies, **timeout/concurrency policy §3.6, cancellation signals**), `health-tracker`, `execution-engine`, `usage-ledger` (**with rollup job**) — unit-tested with fake ports, including alias auto-derivation tests
- Acceptance criteria 2, 3, 5 pass at the core level (mock server)

**Phase 2a — Shell + core screens (L)**
- `ui-shell`, `ipc-client`, CSP + capability scoping from day one (invariants 12–14)
- `screen-providers` (cards, key rows, Test, **minimal manual add-provider form** — superseded
  by the Phase 3 wizard) — acceptance criterion 1
- `screen-models` (discovery, Text/Image tabs, defaults, alias editor), `screen-assistant` (text then image, **stop button**) — criterion 4
- `screen-usage` (with `source` attribution), `screen-router-settings` (incl. system-AI pick)

**Phase 2b — Local Gateway (M) — entry-gated by the SSE-through-IPC spike (§3.5)**
- Spike first: end-to-end streamed completion through the bridge under load, incl. mid-stream
  disconnect cancellation
- `local-gateway` (axum, master-key auth with throttling/constant-time, `/v1/*` → router
  bridge, SSE out, 503/429 semantics) + `screen-gateway` (enable, port/endpoint URL,
  generate/rotate/revoke master key, copy presets)
- **Rust integration tests** for the gateway against the Phase 1 mock server + key-leak grep
  wired into this phase's CI — criteria 8, 10

**Phase 3 — Deterministic onboarding (M)**
- `probe-runner`, `redaction`, dialect fingerprinter, OpenAPI discovery
- `onboarding-orchestrator` state machine + `screen-onboarding` wizard (template path end-to-end) — criterion 7
- Bootstrap guard UX ("AI-assisted path unlocks after first provider")

**Phase 4 — AI-assisted self-construction (L)**
- `adapter-generator`: `AiTextPort` system route (exclusion rule), prompt pack, best-of-N, lint (host pinning, request-field whitelist), contract-gated ranking
- Human-confirmation review screen; `generator_audit`
- OpenRouter + OpenCode provider profiles; b.ai profile (anthropic-compat overlay)

**Phase 5 — Self-healing (M)**
- Error taxonomy + drift windows in execution-engine/`drift-monitor`
- Patch generation flow, manifest versioning, hot-swap, rollback UI, scheduled re-probe, manual "Repair" — criterion 9

**Phase 6 — Tier-2 sandbox + hardening (L)**
- `sandbox-runtime` (QuickJS-WASM, host functions, timeouts, memory cap, http rate limit) + code-adapter contract gates
- Config export/import + diagnostics bundle; streaming batching; app signing/updater; E2E suite — full acceptance pass 1–10

### Acceptance-criteria traceability

| Spec criterion | Delivered by |
|---|---|
| 1. Three providers, 3 keys, cards | Phase 2a (`screen-providers`, registry) |
| 2. Key rotation transparent | Phase 1 (`route-planner`, `execution-engine`) |
| 3. Provider failover + visible in log | Phase 1 + 2a (fallback chains in ledger → `screen-usage`) |
| 4. Text + image end-to-end via Assistant | Phase 2a |
| 5. No plaintext keys on disk | Phase 1 (invariants 1–2, CI grep test) |
| 6. New provider = data, no UI change | Phase 1 manifests + Phase 3 wizard; OpenAI/Anthropic-compatible providers need only the wizard |
| 7. Zero-AI bootstrap: fresh install → wizard → Assistant request | Phase 3 (fingerprint → template → contract → confirm) |
| 8. Gateway: curl + master key streams; wrong key 401; rotation kills old key | Phase 2b |
| 9. Drift: detect → patch → confirm → rollback | Phase 5 |
| 10. Gateway traffic queryable with source attribution | Phase 1 (`ledger.source`) + 2b |
