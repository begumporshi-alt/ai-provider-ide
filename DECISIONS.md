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

## 2026-09-16 — LIVE verification pass (self-driven, mock provider over the real stack)

Method: local mock OpenAI-compatible provider (apps/desktop/e2e/mock-provider.mjs, port
18787 — localhost is egress-allowlisted by design) + seeded keychain/DB; every request
still travels the full production path (UI/axum -> router core -> egress -> HTTP).

Verified LIVE in the running app:
- Criterion 1: 5 provider cards, keys masked (••••ey-A style), lifecycle buttons work
- Criterion 2 (rotation): dead key A attempted -> AUTH_FAILED -> key B served silently;
  ledger chain shows it; the request still 'ok'
- Criterion 3 (failover): mock-1's healthy key disabled -> bare model served by mock2;
  qualified model mock/mock-fast correctly pinned to mock-1 and failed LOUDLY with a
  named attempts list (the §3.4 qualified-vs-bare semantics both ways)
- Criterion 4: streamed SSE chat + non-stream chat.completion + b64 image generation,
  all through the gateway (Playground UI typing blocked for automation — router path
  identical, source tag differs only)
- Criterion 5: grep of app-data dir = 0 key-pattern hits; api_keys holds key:* refs only
- Criterion 8: curl with master key streams; wrong key 401; rotation kills old key
  instantly (per-request keychain read); port-squat by another app (AI Hub on 8787)
  surfaced as the loud invariant-16 error + remediation UI, worked around via port 8791
- Criterion 10: Activity screen renders 9 ledger rows with source=gateway attribution,
  per-key/provider columns, ↻ 1 fallback chips, ✕ NO_ROUTE failure row

Bugs found & fixed during the live pass (all with regression coverage where applicable):
- keyring v3 -> v2 (see above; root cause of the user's 'invalid (HTTP 0)')
- alias priority sort was DESC — reversed the intended primary-provider-first routing
  (§3.4); fixed to ASC + regression test
- React StrictMode double-mounted the gateway bridge -> every request routed twice
  (duplicated chunks + ledger rows); bridge is now idempotent
- streaming 401/429 classified as NETWORK (error-event race in ipc-client): text() now
  waits for the error event so the engine sees the real status -> AUTH_FAILED reaches
  the health tracker (auth breaker works)
- Test-button errors now surface the real message; addProvider made atomic (ghost
  provider rollback); first key promotes draft -> pending (allowlist)
- Gateway port choice persists across restarts (settings table)

Left for a human (typing into the webview is blocked for automation):
- Playground chat via the UI (one message closes criterion 4's UI half + a source=ui row)
- The Stop button mid-stream (cancellation is covered by Rust + core tests)

## 2026-09-16 — Phase 3 (deterministic onboarding) complete + LIVE-verified

Built (§2.1-2.4, deterministic path only — the AI path is Phase 4):
- probe-runner: free-only GET/POST{} matrix (OPTIONS rejected by the egress method
  whitelist — POST {} proves route existence + captures the 401 challenge, validation
  400s never reach a model), bodies reduced to shapes by redaction before anything persists
- redaction: values -> {key: type} shapes, key-shaped regex scrub, size cap (§2.3)
- fingerprinter: openai-compat / anthropic-compat / unknown from probe evidence, template
  pinned to the user baseUrl (§2.4)
- contract-suite: free checks auto (auth+models), paid checks behind explicit consent
  (max_tokens:1 text, minimal image only if claimed)
- onboarding-orchestrator: §2.1 state machine with persistence; onboarding_sessions resume
  across restarts; unknown dialect -> failed with Phase-4 guidance
- screen-onboarding wizard: Connect -> Probe -> Identify -> Test -> Review -> Enable,
  always cancellable (cancellation removes provider row + keychain entry), resume banner
- Rust: onboarding_save/onboarding_latest_active commands; provider_delete now cascades
  keychain cleanup (SQL cascade removed rows but left vault entries — §7 hygiene gap)

LIVE-verified end-to-end in the running app (mock provider, resume-driven):
resume banner -> Test step auto-runs free checks through REAL egress+keychain -> Review
(2/2) -> Approve & Enable -> provider card Enabled, models_cache populated (mock-fast
text + sd-mock-1 image), session terminal state enabled.

Live bugs found & fixed during the wizard test:
- resume provider lookup was by baseUrl alone — ambiguous when providers share a host
  (it enabled the WRONG provider); now providerId travels in the session detail, with
  name+baseUrl as a unique-match fallback only
- resumed sessions could lack a manifest in state while the provider row had one
  registered; enable now recovers it from the adapter runtime
- onboarding_save inserts one row per save when no id is tracked; the wizard now reuses
  the row id

Suites: 48 TS tests (6 + 42) + 19 Rust green; typecheck + key-leak grep clean.
Criterion 7 status: deterministic path live-proven; the fresh-install (typed) run is a
one-minute human pass away.

## 2026-09-16 — Gateway v1.1: multi-dialect ingress (OpenAI Chat + Anthropic Messages)

- **User-directive raised:** "the IDE is not built for OpenAI compatibility only — support
  all possible compatibilities." Agreed scope for now: **OpenAI Chat surface + Anthropic
  Messages surface** (/v1/messages + x-api-key auth, full message_start/content_block_delta/
  message_stop SSE framing); OpenAI Responses and Gemini generateContent land as follow-ups.
- **Why now:** the egress side already speaks anthropic-compat to providers; with b.ai in the
  sketch, ingressing Anthropic makes Claude Code / anthropic-sdk apps use the whole router —
  symmetric to egress, and a one-phase build.
- **Architecture:** translation lives at the gateway edge (ingress dialect -> normalized
  router call), NOT inside the router core — the core stays one surface; each new ingress
  dialect is one handler + one test pack. Extension point noted in ARCHITECTURE.md §7.
- **Auth:** master key accepted via `Authorization: Bearer` OR `x-api-key` (constant-time,
  same throttle). Errors on /v1/messages use Anthropic's error envelope.
- **Verified:** 3 Rust tests (non-stream shape, stream framing, system/bad-request) + live
  curl through the running app (22 Rust total). §3.4 compatibility contract updated.
- **Revisit when:** a user needs Responses/Gemini ingress — same edge-translation pattern,
  no core change.

## 2026-09-16 — Gateway v1.1 extended: OpenAI Responses + Gemini ingress

Per the multi-dialect decision above, /v1/responses and /v1beta/models/*:generateContent
(+ :streamGenerateContent?alt=sse) are live: contents/parts and input/instructions
translation at the edge; Gemini legacy ?key= accepted via the same master-key check.
x-goog-api-key and x-api-key and Bearer all authenticate the single master key.
V1 limits (recorded): Responses tool/events beyond the text-output lifecycle are refused;
Gemini streaming requires alt=sse; function-declaration surfaces are refused explicitly.
5 new Rust integration tests (27 total); all four surfaces live-verified via curl through
the running app (Chat + Responses + Messages + Gemini, stream + non-stream).

## 2026-09-16 — Phase 5 (self-healing) complete + fully LIVE-verified, incl. rollback

Built: DriftMonitor (§2.10 sliding window: >=5 drift-class errors / 15 min / >=2 models,
with the succeeds-elsewhere isolation check and 1-per-hour cooldown; manual health-check
bypasses it), RepairOrchestrator (re-probe -> deterministic re-fingerprint -> AI patch
prompt carrying old manifest + failing assertions -> contract-gated best-of-2), router
onAttempt hook, host drift_events/manifests_history/manifest_stage/manifest_activate
commands, and the Providers UI: repairing badge + banner, Review-repair modal (evidence +
checks + Approve & apply / Keep current), adapter history with one-click rollback.
Two real bugs fixed during test authoring: cooldown blocked the FIRST trigger ever;
RepairOrchestrator forgot to pass `http` (AI candidates went unchecked).

Fully live-verified in the running app with NO human input:
flip an enabled provider's shape -> traffic -> provider marked repairing (failover kept
users served), drift_event recorded; background plan: re-fingerprint no-match -> oracle
System AI generated a corrected manifest through the real AiTextPort exclusion route
(generator_audit rows); Approve & apply -> manifest v2 (ai-patched) active, traffic
returned to the provider ("drift-v2:dgpt"), drift_events resolved 'repaired v2',
card back to Enabled; Check health -> history shows v2 active + v1; "roll back to this"
-> v1 active again and a request proves v1 now fails with the OLD chain shape and
failover catches it (ledger NOT_FOUND -> served by another provider). Criterion 9 closed.

V1 limitations (recorded): the AI patch prompt gives candidates via the general generator,
not a dedicated patch-only prompt (feedback carries the old manifest — good enough for v1);
scheduled weekly re-probe is on-start + manual only (a real scheduler lands with the
headless service mode in v2). 55 TS tests (6+49) + 29 Rust green.

## 2026-09-16 — Phase 6a: config export/import + diagnostics bundle (req. 14)

Host commands `config_export` / `config_import` / `diagnostics_bundle` (persist.rs), wired to
store actions and a Settings > Config & diagnostics section (clipboard-based export/import —
no new fs/dialog plugins; the file round-trip is the user's editor/OS).

Safety model, layered (audit H7):
- Export reads ONLY structured columns; keys serialize as id/label/secretRef/hint. A test
  asserts no `"secret"`-named field and no key-like material appears in the export JSON.
- Import rejects ANY `secret`-named field found in the RAW JSON value, before deserializing
  into typed structs — scanning typed structs after parse would be theater, since serde
  drops unknown fields. The webview's TS `validateImport` runs first for friendly errors;
  the host check is the trust boundary (the webview is untrusted).
- Imported providers land `draft`, keys `invalid`: nothing routes until keys are re-entered
  and tested on the new machine. Existing providers/aliases are skipped (never silently
  overwrite a live setup). The `gateway` setting is machine-local and never imported.
  All-or-nothing transaction.

TS side: `packages/router-core/src/config.ts` (formatVersion 1, findSecretFields recursive,
row sanity) + 6 vitest cases. Rust side: `config_export_import_safety` test (draft/invalid
forcing, gateway-setting exclusion, idempotent re-import, raw-secret rejection applies
nothing). 30 Rust + 61 TS tests, typecheck + key-leak grep clean.
