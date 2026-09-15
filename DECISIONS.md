# DECISIONS — AI-Provider IDE

> Decision, date, options, rationale, revisit trigger. Append-only.

## 2026-09-15 — Build starts at Phase 0 (scaffold + decisions spike)

- **Decision:** Follow ARCHITECTURE.md §9 order: Phase 0 scaffold, then Phase 1 host infra +
  router core. Provider-facts spike results are recorded below rather than deferred.
- **Revisit if:** any phase reveals the plan's ordering was wrong.

## 2026-09-15 — Provider facts (spike, pinned from ARCHITECTURE.md §8)

- **b.ai:** base URL `https://api.b.ai/v1`, anthropic-messages dialect (user's own working
  config confirms). Model list via the anthropic `/v1/models` surface; pricing unknown → ledger
  shows cost "unknown", not zero. Revisit if the onboarding probe against a real key disagrees.
- **OpenCode Zen:** PINNED by live probe 2026-09-15 — base URL
  `https://opencode.ai/zen/v1`, OpenAI-compatible (`/v1/chat/completions`, `/v1/models`;
  also exposes `/v1/responses` and `/v1/messages` dialects). `/v1/models` returns 200
  unauthenticated; chat auth is Bearer-key style. The Phase 3 probe re-verifies with the
  user's real key.
- **OpenRouter:** standard OpenAI-compatible plus its own `/api/v1/models` catalog.

## 2026-09-15 — Monorepo layout frozen as specified

- **Decision:** `apps/desktop` (Tauri 2, react-ts template, identifier `dev.aiprovider.ide`),
  `packages/router-core` (`@aiprovider/router`), `packages/adapter-spec`. Ports defined in
  router-core (`HttpPort`, `KeyVaultPort`, `StorePort`) mirror ARCHITECTURE.md §1.3 hard rules.
- **Rationale:** keeps the router UI-agnostic and unit-testable with fake ports (spec req. 9).
- **Revisit if:** build tooling forces a different split (e.g., Vite/Tauri workspace conflicts).

## 2026-09-15 — React 19 (template default) accepted over spec's "React 18"

- **Options:** pin React 18 per ARCHITECTURE.md §6, or accept create-tauri-app's React 19.
- **Decision:** React 19 — the spec's version was indicative, not a directive; nothing in the
  design depends on 18-specific APIs, and 19 is the current stable.
- **Revisit if:** a UI dependency we need is 18-only.

## 2026-09-15 — Manifest grammar v1.1 & compatibility contract remain FROZEN documents

- **Decision:** no changes to ARCHITECTURE.md §2.6 / §3.4 / §3.5 during scaffold; Phase 1
  implements them as written.
- **Revisit if:** contract-suite tests expose an ambiguity — then amend here first, then docs,
  then code.
