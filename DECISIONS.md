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

## 2026-09-15 — v1.1 grammar amendment: `stream.stopWhen` / `stream.ignoreWhen` (condition objects)

- **Decision:** Anthropic's stream terminates on an event (`type=message_stop`), not a
  finish_reason field. Added `stopWhen: {path, equals}` (+ `ignoreWhen`) to the stream spec
  as a v1.1 amendment, implemented in the interpreter. The `finish` selector stays for
  OpenAI-style streams.
- **Rationale:** keeps anthropic-compat a pure DATA profile; without it the template needs a
  code path, breaking §2.8's tiering promise.
- **Revisit if:** a dialect needs richer event logic than equality — likely Tier-2, not a
  grammar explosion.

## 2026-09-15 — RouterFacade.generateText returns `{ chunks }` of strings, not `AsyncIterable<TextChunk>`

- **Options:** literal spec signature (`Promise<AsyncIterable<TextChunk>>`), or a small stream
  object exposing `chunks` plus serving/fallback-chain attribution (what §3.1's ledger needs).
- **Decision:** stream object (`TextExecution`) — criteria 3/10 require the caller to see WHICH
  provider/key served and the fallback chain; a bare iterable can't carry that without
  side-channels. `TextChunk` kept as a string alias for the spec's shape.
- **Revisit if:** a consumer needs the exact spec signature — trivial adapter.

## 2026-09-15 — Cursor rotation advanced per-request in the Router, not per-attempt

- **Decision:** round-robin cursor advances on stream completion (success), per provider.
- **Rationale:** mid-stream failures shouldn't rotate everyone off a partially-good key.

## 2026-09-15 — Phase 1 TS core acceptance: criteria 2, 3, 4 (core-level) pass on fake ports

- **Verified:** `packages/router-core/test/acceptance.test.ts` — 15 tests: rotation past a 401
  key with silent success (2), provider failover + fallback chain visible in ledger +
  failover-disabled flag (3), openai-compat + anthropic-compat streaming + image url/b64 (4),
  mid-stream cancellation, key-blindness header guard (invariants 1–2), alias auto-derivation
  (§3.4). `pnpm typecheck` + `pnpm test` green workspace-wide.

## 2026-09-16 — keyring v3 -> v2 (macOS data-protection keychain breaks dev builds)

- **Decision:** pin `keyring = "2"` for the vault.
- **Evidence (live probes, 2026-09-16):** with v3, `set_password` returns Ok but the item is
  invisible to every other process (`get_password` -> NoEntry from a second run of the SAME
  binary; `security find-generic-password` sees nothing). v3 defaults to the macOS
  data-protection keychain, which requires a stable code-signing identity/entitlement —
  `tauri dev`'s ad-hoc binary has neither. v2 writes the classic file-based login keychain:
  cross-process reads work, CLI-visible, matches the macos-adhoc-keychain-reject skill.
  Symptom in-app: every provider key Test failed as `invalid (HTTP 0)` ("secret not found in
  keychain").
- **Revisit if:** shipping a signed + entitled release bundle (Developer ID with an
  application-identifier entitlement) — then v3's DP keychain becomes the better choice.
  ARCHITECTURE.md §6 amended accordingly.
- **Note:** secrets written by the v3 build sit orphaned in the DP keychain (unreadable,
  invisible); harmless, and the user is rotating the real keys anyway.

## 2026-09-16 — smoke-driven fixes from the first live run

- Test-button errors now surface the real message (was: "invalid (HTTP 0)" swallowing the
  egress error class).
- `addProvider` is atomic: duplicate slug rejected up front; host-persist failure rolls back
  the in-memory registry (ghost-provider bug found live: re-adding OpenRouter left an
  in-memory provider the host refused, "no active manifest").
- First key on a draft provider promotes it to `pending` so the egress allowlist admits the
  host immediately (draft hosts were un-routable, Test could never succeed).
