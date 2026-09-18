# MASTER PROMPT — AI-Provider Router

> **Source of truth:** hand-drawn notebook sketch, 2026-09-15
> (`~/Desktop/WhatsApp Image 2026-09-15 at 17.06.43.jpeg`), analyzed via ChatGPT vision.
> Everything marked **[SKETCH]** is explicit in the drawing. Everything marked **[DEFAULT]** is a
> sensible engineering default not present in the drawing — confirm or override before building.
> *Correction 2026-09-15: the vision analysis misread the third provider's handwriting as
> "Bolt"; the user confirmed it is **b.ai** (an Anthropic-compatible AI provider).*
>
> **Full architecture:** [ARCHITECTURE.md](ARCHITECTURE.md) — layered design, the self-construction
> engine, storage schema, security invariants, and the phased build plan.

---

## 1. Mission

Build **AI-Provider Router** — a local-first application that gives one unified interface to the
user's own third-party AI providers. The user brings their own API keys for multiple providers;
a central **Model Router** abstracts all provider differences away so the rest of the app talks
to a single, normalized AI layer ("Custom AI to 3rd party" — your own keys, third-party models).

The core idea from the sketch: **the app never talks to providers directly — it talks to the
Model Router, and the Router talks to providers.**

## 2. Architecture (from the sketch)

```
                          ┌─────────────────────────┐
                          │     AI-Provider Router     │
                          └────────────┬────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │      AI Providers       │
                          │                         │
                          │  OpenRouter             │
                          │   ├─ ApiKey - 1         │
                          │   ├─ ApiKey - 2         │
                          │   └─ ApiKey - 3         │
                          │                         │
                          │  OpenCode               │
                          │   ├─ ApiKey - 1         │
                          │   ├─ ApiKey - 2         │
                          │   └─ ApiKey - 3         │
                          │                         │
                          │  b.ai                   │
                          │   ├─ ApiKey - 1         │
                          │   ├─ ApiKey - 2         │
                          │   └─ ApiKey - 3         │
                          └────────────┬────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │      Model Router       │
                          └────────────┬────────────┘
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
               ┌─────────────────┐           ┌─────────────────┐
               │   Text Models   │           │  Image Models   │
               └─────────────────┘           └─────────────────┘
```

## 3. Domain model

| Entity | Fields | Notes |
|---|---|---|
| **Provider** | `id`, `name`, `type` (openrouter / opencode / b.ai / custom), `apiKeys[]`, `enabled`, `status` | **[SKETCH]** at least 3 providers: OpenRouter, OpenCode, b.ai |
| **ApiKey** | `id`, `providerId`, `label`, `secretRef` (never the raw secret), `status` (active / rate-limited / invalid), `addedAt`, `lastUsedAt` | **[SKETCH]** every provider has exactly 3 key slots; **[DEFAULT]** keys are add/remove/reorder, not fixed at 3 |
| **Model** | `id`, `providerId`, `modality` (text / image), `contextWindow`, `capabilities`, `pricing` | **[SKETCH]** two categories: Text Models and Image Models |
| **RouterConfig** | routing rules, default model per modality, failover policy | **[SKETCH]** the router exists; policy details **[DEFAULT]** |

## 4. Functional requirements

### Explicit in the sketch — non-negotiable

1. **[SKETCH]** Multiple third-party AI providers are supported simultaneously (OpenRouter,
   OpenCode, b.ai at minimum; architecture must make adding a 4th provider trivial).
2. **[SKETCH]** Each provider holds **multiple API keys** (3 slots drawn) — the key is a
   first-class entity, not a single credential string per provider.
3. **[SKETCH]** A central **Model Router** sits between the app and all providers.
4. **[SKETCH]** The router serves two model categories: **Text Models** and **Image Models**.
5. **[SKETCH]** Provider blocks connect to the router at the key level (arrows leave from key
   rows) — routing decisions involve choosing provider **and** key, not just provider.

### Engineering defaults — not in the sketch, recommended

6. **[DEFAULT] Key rotation & failover:** when a key hits a rate limit / 401 / 5xx, the router
   transparently retries with the next key of that provider; when all keys of a provider fail,
   fail over to the next provider that carries the requested model.
7. **[DEFAULT] Model discovery:** fetch each provider's model catalog and cache it locally;
   let the user refresh. Tag every model with its modality (text / image).
8. **[DEFAULT] Key validation:** "Test" action per key (cheap ping request) with clear
   valid / invalid / rate-limited feedback.
9. **[DEFAULT] Unified request API** used by the rest of the app — nothing else may import
   provider SDKs. Every request is **cancellable** (a stop signal propagates from the UI,
   the gateway, or app shutdown down to the provider stream):
   ```ts
   router.generateText(req: TextRequest, opts?: { signal?: AbortSignal }): Promise<AsyncIterable<TextChunk>>
   router.generateImage(req: ImageRequest, opts?: { signal?: AbortSignal }): Promise<ImageResult>
   router.listModels(modality?: Modality): Promise<ModelInfo[]>
   ```
10. **[DEFAULT] Streaming** for text responses; progress feedback for image generation.
11. **[DEFAULT] Usage ledger:** per-request record (provider, key, model, tokens, latency,
    cost if pricing known) visible in a Usage panel.
12. **[USER-DIRECTIVE] Auto-provider onboarding & self-construction:** the IDE can
    **automatically add and set up ANY new AI provider** — not just the built-in three. The
    user supplies minimal input (name, base URL, API key, optionally a docs URL); the IDE
    probes the provider's API (its own HTTP client — secrets never sent to any AI), generates
    a **declarative adapter manifest**, validates it with contract tests using the user's key,
    and registers the provider after human confirmation. This requires an **AI model inside
    the IDE** (the "System AI", routed through the Model Router itself) so it can
    **self-construct** integrations on demand. Full pipeline, manifest schema, bootstrap
    resolution, and sandboxed code-adapter fallback: see [ARCHITECTURE.md](ARCHITECTURE.md) §2.
13. **[USER-DIRECTIVE] Local Gateway — one endpoint + one master key for every app:** the IDE
    exposes the whole Model Router as an **OpenAI-compatible local endpoint**
    (`http://127.0.0.1:8787/v1` — `/v1/chat/completions`, `/v1/models`, `/v1/images/generations`).
    On first enable the IDE **generates a master key** (crypto-random, `sk-aip-…`, stored in
    the OS keychain, shown once, rotatable — rotation kills the old key instantly — and
    revocable). External apps (Cursor, scripts, chat UIs) paste the endpoint URL + master key
    and can then use **all configured providers** through that one URL, with the same key
    rotation and provider failover as the IDE's own UI. Binds `127.0.0.1` only; LAN sharing
    is an explicit opt-in with a warning. Flow and details: [ARCHITECTURE.md](ARCHITECTURE.md) §3.3.
14. **[DEFAULT] Config export & diagnostics:** export/import the full configuration as JSON
    (providers, manifests, aliases, settings, `secret_ref`s — never keychain secrets; secrets
    are re-entered on import with a guided flow), plus a user-initiated diagnostics bundle
    (scrubbed logs) for bug reports — the telemetry-free replacement for crash reporting.

## 5. Screens / UX

1. **AI Providers** (management) — card per provider (name, logo, enabled toggle, health dot);
   under each card, its API-key rows (masked `••••`, status chip, Test button, add/remove).
   The layout mirrors the sketch's provider blocks.
2. **Model Browser** — two tabs or grouped sections: **Text Models** and **Image Models**;
   filter by provider; set default model per modality.
3. **Router Settings** — failover on/off, rotation strategy (round-robin / least-recently-used /
   priority order), default models, per-phase timeouts (connect / first-byte / idle-stream),
   concurrency caps, and the **System AI** pick (which provider/model powers self-construction).
4. **Usage / Activity** — recent requests, which key served them, failures and fallbacks that
   occurred (the ledger from req. 11).
5. **Playground** **[DEFAULT]** — a chat box (text) and an image box to try any routed model
   without writing code. This is the fastest way to demo the whole pipeline.
6. **Add Provider wizard** **[USER-DIRECTIVE]** — the auto-onboarding flow: enter name,
   base URL, key (+ optional docs URL) → watch the IDE probe, fingerprint, generate the
   adapter manifest, and run contract tests → review a summary (manifest, test results,
   estimated validation cost) → confirm to enable.
7. **Local Gateway settings** **[USER-DIRECTIVE]** — enable the gateway, pick the port, see
   and copy the endpoint URL (`http://127.0.0.1:8787/v1`), generate / rotate / revoke the
   master key (shown once), test the connection, and copy paste-ready presets for common
   apps (Cursor, Continue, openai-python `base_url`).

## 6. Security — hard requirements

- API keys are stored in the **OS keychain** (via the Rust host's `keyring` crate — `keytar`
  is archived; the webview never touches a raw key), never in
  plaintext config files, never logged, never sent anywhere except their own provider endpoint.
- Masked display everywhere except a one-shot reveal on explicit user action.
- All provider traffic goes directly from the user's machine to the provider — no middleman
  server, no telemetry.

## 7. Confirmed stack (per ARCHITECTURE.md)

- **Desktop shell:** Tauri 2 with a Rust host layer (owns all network egress, the OS keychain,
  and SQLite — the webview is key-blind and CORS-blocked from providers by design).
- **UI:** React + TypeScript + Tailwind (matches a provider-card / dashboard style UI).
- **Core:** a UI-agnostic TypeScript package — `packages/router-core` (published as
  `@aiprovider/router-core`) containing providers, key management, routing, and failover — fully
  unit-testable without the UI; `packages/adapter-spec` holds the manifest schema.
- **Provider adapters:** one adapter interface (`listModels`, `generateText`, `generateImage`,
  `pingKey`), implemented per provider (OpenRouter, OpenCode, b.ai, + a generic
  OpenAI-compatible adapter covering most third parties).

## 8. Acceptance criteria

1. I can add all three drawn providers, each with 3 keys, and see them as cards.
2. Disabling the first key makes requests silently succeed via the second key (rotation works).
3. Disabling every OpenRouter key makes a text request succeed via another provider carrying
   the same model (failover works, and the activity log shows it happened).
4. Text and image generation both work end-to-end from the Playground through the router.
5. No API key is ever written to disk in plaintext (verify: grep app data dir).
6. Adding a new provider is **data-only for OpenAI/Anthropic-compatible providers** (the
   wizard suffices); anything else is one adapter manifest + one registration entry — no UI
   changes needed either way.
7. **Self-construction bootstrap:** on a fresh install with zero AI configured, I add an
   OpenAI-compatible provider through the wizard (probe → fingerprint → template → contract
   tests → confirm) and complete a Playground request — no code, no app update.
8. **Gateway:** `curl` with the master key streams a completion through
   `http://127.0.0.1:8787/v1`; a wrong key returns 401; rotating the master key kills the old
   key immediately.
9. **Self-healing:** when a mock provider changes its response shape, the drift is detected,
   a manifest patch is generated and confirmed, and rollback to the previous version works.
10. **Attribution:** a week of mixed IDE + gateway traffic is queryable in the Usage screen
    with per-source (ui / gateway / generator) attribution.

## 9. Out of scope for v1

- Team/shared key vaults, cloud sync.
- Fine-tuning or training features.
- Non-text/image modalities (audio/video) — the router design must leave room, but don't build.
- Billing dashboards beyond the simple usage ledger.

## 10. Glossary

- **Provider** — a third-party AI service (OpenRouter, OpenCode, b.ai, …).
- **Key slot** — one API credential belonging to a provider; a provider has several.
- **Model Router** — the single gateway all AI requests go through; picks provider → key → model.
- **Modality** — Text or Image (the two categories drawn).

---

### Build order (mirrors ARCHITECTURE.md §9)

0. **Decisions spike:** pin b.ai + OpenCode Zen facts; freeze the compatibility contract,
   manifest grammar v1.1, and gateway bridge contract; scaffold the monorepo + CI.
1. Rust host layer: `keychain-vault` + `egress-gateway` (credential injection, host allowlist)
   + SQLite schema v1.1 with the migration runner.
2. `packages/router-core`: manifest schema + interpreter, `openai-compat`/`anthropic-compat`
   templates, routing with key rotation, provider failover, cancellation, and the ledger —
   unit-tested with fake ports.
3. Desktop shell + core screens: Providers (incl. a minimal manual add form), Models,
   Playground (with stop button), Usage, Router Settings — CSP + capability scoping from day one.
4. **Local Gateway** (entry-gated by an SSE-through-IPC spike): axum server, master-key
   lifecycle, Gateway settings screen, Rust integration tests.
5. Deterministic onboarding: probe runner + dialect fingerprinter + wizard (no AI needed —
   also solves the bootstrap problem).
6. AI-assisted self-construction: adapter generator (System AI route, best-of-N manifests,
   contract-gated) + human confirmation.
7. Self-healing: drift detection, manifest patching, versioned rollback.
8. Tier-2 sandboxed code adapters + hardening (config export, diagnostics, signing, updater,
   E2E) — full acceptance pass 1–10.
