# DECISIONS — AI-Provider Router

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

- **Decision:** `apps/desktop` (Tauri 2, react-ts template, identifier `dev.aiprovider.router`),
  `packages/router-core` (`@aiprovider/router-core`), `packages/adapter-spec`. Ports defined in
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

## 2026-09-16 — v1.1 grammar amendment: `modalityRules` may match raw model metadata; `map.raw` is consumed

- **Decision:** `MODALITY_RULE` gains an optional second matcher,
  `rawMatch: {path: <JSONPath>, contains: <string>}`, evaluated against the raw model object
  the provider's listModels returned (the entry at `map.raw`, see below). A rule matches when
  EITHER matcher succeeds; `modelIdPattern` stays required-or-present for existing manifests,
  now optional as long as one matcher exists. `listModels` now consumes the `map.raw`
  selector — declared in v1.1 but never read — and passes it through `ModelEntry.raw`;
  `tagModality` takes the full `ModelEntry` so rules can see it.
  `rawMatch.contains` matches when the selected value equals the string, OR (when the
  selected value is an array) contains it.
- **Rationale:** OpenRouter namespaces every model id (`google/gemini-2.5-flash-image`), so
  the id-pattern matcher tagged none of its 11 image-output models and the Playground's Image
  tab stayed empty — even though the provider's own catalog states
  `architecture.output_modalities`. Vendor-prefixed ids are the norm for aggregators, so this
  recurs; matching the provider's own metadata is the honest fix and keeps the profile pure
  DATA. Matching on `$.architecture.output_modalities[0]` (primary output) rather than array
  membership keeps `openrouter/auto` — output `[text, image]` — a text model, where it belongs.
- **Revisit if:** a provider only signals image capability on a separate endpoint (e.g.
  OpenRouter's dedicated `/images/models` list, whose 52 entries are mostly absent from the
  main catalog) — that needs a discovery-side change (second listModels source), not a rule
  shape; or if dual-modality models (`text+image`) should appear in BOTH router categories
  (today `modality` is single-valued per model).
- **Endpoint correction (same pass, live-probed 2026-09-16):** OpenRouter serves image
  generation from its own Image API — `POST /api/v1/images` — not the OpenAI-compatible
  `/images/generations`. Both paths 404 on GET and return the gateway's 401 on POST, so the
  route cannot be distinguished unauthenticated; the docs are explicit. Retrieval shape is
  `{created, data:[{b64_json, media_type}], usage}` — **no `url` field**, stateful b64 only.
  The profile pins `imagePath: "/images"`; the responseMap's `imageUrl` simply never resolves
  (harmless — `imageB64` carries the payload and the interpreter already treats both as
  optional). `openaiCompat` gained `imagePath`/`imageRule` overlays so the OpenAI-compatible
  default (`/images/generations` + id-pattern rule) is unchanged for every other profile and
  for both mock providers.
- **Evidence for the discriminator (live, same pass):** of OpenRouter's 444 catalog models,
  exactly 9 lead their `output_modalities` with `image`; 11 contain `image` anywhere, the two
  extras being `openrouter/auto` and `openrouter/auto-beta` at `["text","image"]` — text
  routers. Zero model ids match the shared id pattern, confirming an id rule could never have
  classified this catalog.
- **Also fixed in this pass (latent, found while mapping call sites):**
  `contract-suite.ts` selected its paid image probe with
  `a ?? b ?? c ? d : e`, which groups as `(a ?? b ?? c) ? d : e` — every image probe collapsed
  to `models[0]`, a text model. Now `entries.find(tagModality === "image")`, so the paid check
  bills and exercises an actually-image model, and metadata rules get a vote.


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

## 2026-09-17 — Tool-calling plumbing completed; in-band pseudo-tokens quarantined in the UI

Trigger: mercury-2.5 (chosen in Playground) answered "create a skill" with raw markup —
`<|tool_call_start|> <function=Bash> <parameter=command> mkdir -p ~/.zcode/skills/…` — painted
verbatim into the transcript. Mercury 2.5 DOES support native tool calling, so this was never a
model limitation. The `.zcode/skills/...` path was a model hallucination, not app configuration
(nothing in this repo references `.zcode`).

Three separate app-side breaks, all fixed:
1. `ModelRouter.generateText` accepted `TextRequest.tools/toolChoice/responseFormat` and then
   dropped them — `engine.executeText` was called without them. Silent downgrade of every
   tool-capable provider to a toolless request.
2. `builtin-templates` did not declare `tools` / `tool_choice` / `response_format` in
   `requestTemplate`, so `renderTemplate` never emitted them even once forwarded. Added as
   `{{x?}}` (omitted, never null) and whitelisted in `REQUEST_FIELD_WHITELIST` — the values are
   caller-supplied placeholders, so invariant 4 is unchanged: a hostile manifest still cannot
   smuggle body params of its own.
3. The SSE loop read only `delta.content`, which is null on tool-call chunks, so a tool-calling
   response streamed as an EMPTY transcript. Added optional `toolCalls` selectors to
   `chunkMap` and `responseMap`, and an `onToolCall` side channel on `TextRequest`.

**Decision: `onToolCall`, not a tagged chunk union.** `TextChunk` stays a string (see the
2026-09-15 decision below). A tool call is structured, and `arguments` arrives as fragments
indexed by `index` that must be reassembled before use, so it cannot be interleaved into a
string stream without corrupting both. The callback keeps the existing protocol intact and is
a no-op for callers that do not register a handler.
**Deferred (now resolved, same day):** anthropic-compat streamed tool calls report via a
`toolCallStream` descriptor (start/delta by `index`) added to builtin-templates; `emitToolCalls`
reassembles `input_json_delta` fragments, so BOTH dialects stream tool calls end-to-end.
Non-stream always worked. See the 2026-09-17 agent-mode entry for the execution layer.

UI: `apps/desktop/src/lib/assistant-stream.ts` quarantines in-band pseudo-tokens into inert
labelled cards instead of leaking them as text (still required — a toolless Playground session,
or a model ignoring the guard, can still emit them). Plain chat sends a no-tools system turn by
default; a separate **agent mode** sends the tool registry and runs a real execution loop with
per-call confirmation (entry below). Playground also no longer replays empty assistant turns left
behind by Stop/failure, which providers reject with 400.

Tests: `packages/router-core/test/tool-calling.test.ts` (4) + `apps/desktop/src/lib/
assistant-stream.test.ts` (7). 118 router-core + 18 adapter-spec + 7 desktop unit tests pass;
typecheck and vite build clean.

## 2026-09-17 — Tool execution layer built (Rust sandbox + TS registry/agent loop + Playground agent mode)

Authorized build ("build i want everything what is necessary") closing the tool-calling story
end-to-end. The host — not the model, not the UI — is the enforcement boundary, in three layers:

1. **Sandboxed Rust tool host** (`apps/desktop/src-tauri/src/tools.rs`; compiled, 9 unit tests
   pass). Four tools: `read_file`, `write_file`, `list_dir`, `run_command`. Four rules:
   - NO SHELL — `Command::new(prog).args(argv)`, never `sh -c`; `; | &&` and `$( )` are inert text.
   - ALLOWLIST — fixed executable set; `git` restricted to non-network subcommands
     (push/pull/fetch/clone refused).
   - ROOT CONFINEMENT — `resolve_within` canonicalizes and requires the resolved path to stay
     under the workspace root, defeating `..` and outward symlinks; re-checked after any create.
   - BOUNDED — 60s wall-clock timeout (kill via a shared `Arc<Mutex<Child>>`, since `wait_with_output`
     consumes self), 64KB output cap, scrubbed environment (no ambient secrets leak into the transcript).
   Exposed as Tauri commands `tool_run` / `tools_policy`; registered in `commands.rs::handlers()`.
2. **TS tool registry + agent loop** (`apps/desktop/src/lib/tools/`). `AGENT_TOOLS` is the single
   source of truth, mirroring the 4 Rust handlers 1:1; `registryToOpenAI` renders the OpenAI
   `tools` array (`additionalProperties:false`). `runAgentLoop` is fully injectable (fake
   `generate` + fake `host` in tests) and returns `{ text, messages }` so multi-turn agent chats
   replay tool turns (assistant `tool_calls` + `tool` results) correctly. `onToolCall` feeds calls
   in; `confirm` pauses per call.
3. **Playground agent mode** (`src/screens/Playground.tsx`). Toggle + workspace-root input + live
   sandbox-allowlist line; per-call **Allow/Deny** modal before any execution; tool results render
   as collapsible bubbles; in-flight turns show live tool-call cards. Plain chat still defaults to
   the no-tools guard.

Verification: 44 Rust lib tests (9 tool-host + 35 existing) + 11 desktop unit tests (7
assistant-stream + 4 agent-loop) green; all router-core/adapter-spec suites green; `tsc --noEmit`
and `vite build` clean.

**Convention learned (this session):** the `Edit` tool intermittently reported success without
persisting the change on this project; mitigated by re-reading the edited region before trusting
it / before compiling.

## 2026-09-17 (later) — Tool-host test-isolation bug fixed

Verification pass after the build surfaced a latent defect: `list_dir_stays_inside_the_root`
passed in isolation but **failed under `cargo test`** (parallel run). Root cause: the test
`root()` helper keyed its temp dir on `std::process::id()` only, so all 9 tool-host tests shared
one directory; each test's `remove_dir_all` at the top clobbered a concurrent sibling's fixtures
(a test created `a/b`, then a parallel `root()` wiped `a` before `do_list_dir` ran → "not a
directory"). Fix: an `AtomicU64` per-`root()` suffix gives every test a distinct, non-wiped dir.
Sandbox logic was correct throughout; this was purely test harness state.

Re-verified green end-to-end: 44 Rust lib tests (10 incl. 9 tool-host) + 38 desktop TS tests
(11 unit incl. 4 agent-loop + 7 assistant-stream, 27 e2e) + 119 router-core + 18 adapter-spec.
`cargo` is not on the default PATH here — invoke via `~/.cargo/bin/cargo` (rustup stable
aarch64, 1.88.0).

## 2026-09-18 — Project renamed AI-Provider IDE → AI-Provider Router

- **Decision:** the user-specified name "ai-provider router" is normalized to
  **`ai-provider-router`** everywhere (hyphenated; display form "AI-Provider Router"). Applied
  to the repo package name, the desktop app package, the Tauri `productName`/window title, the
  bundle identifier, the keychain service, the SQLite filename, the Rust crate + lib name, and
  all four design documents plus the four diagram sources.
- **Package naming:** `@aiprovider/router` → **`@aiprovider/router-core`** (the old name
  collided conceptually with the directory `packages/router-core` and with the runtime
  `ModelRouter`; the suffix matches the directory). `@aiprovider/adapter-spec` is unchanged.
  Rust crate `desktop` → `ai-provider-router`; lib `desktop_lib` → `ai_provider_router_lib`.
- **Identifiers renamed (accepted consequence):** `dev.aiprovider.ide` → `dev.aiprovider.router`,
  keychain service `ai-provider-ide` → `ai-provider-router`, DB `ai-provider-ide.db` →
  `ai-provider-router.db`. **This orphans any existing install's data**: on macOS the app-data
  directory is keyed by identifier, so a previously installed build loses its providers, keys,
  manifests, and ledger. Keys are NOT deleted — they remain in the login keychain under the old
  service name and must be re-entered. Accepted because the app is pre-release and no migration
  runner exists yet.
- **Revisit if:** a signed release is being cut with real users — then ship a one-time migration
  (copy DB to the new path; re-register keychain entries under the new service).
- **Also fixed in this pass:** `apps/desktop/src-tauri/dev.db` was untracked and not ignored —
  `*.db`/`*.db-shm`/`*.db-wal` added to `.gitignore`.
- **Filter selectors had to follow the rename (easy to miss):** the desktop package name is what
  `pnpm --filter <name>` matches, so renaming it silently broke three call sites — root
  `package.json` `"dev": "pnpm --filter desktop tauri dev"` and two CI steps
  (`playwright install`, `web-test`). All three now use `ai-provider-router-desktop`. **Any
  future app-package rename must update these too**; `pnpm --filter ./apps/desktop` (path form)
  would be rename-proof if this recurs.
- **Verified green after the rename:** typecheck clean in all three TS projects; 181 router-core
  + 18 adapter-spec + 38 desktop + 53 Rust tests pass; `vite build` clean with zero occurrences
  of the old name in the bundle; `key-leak-grep` OK; `pnpm --filter ai-provider-router-desktop`
  resolves. Full write-up in [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md).
- **Tooling note:** `pnpm` was not installed on this machine; installed `pnpm@10.12.4` to match
  `packageManager`. Root `node_modules/.bin` is empty in this workspace — invoke per-package
  binaries (`packages/router-core/node_modules/.bin/tsc`, etc.).

## 2026-09-18 — R3: per-provider concurrency caps, enforced in the CORE not the gateway edge

- **Options:** (a) a per-provider semaphore at the axum gateway ingress, (b) a per-provider cap
  in the router core consulted per candidate.
- **Decision:** **(b)**. The gateway cannot know which provider will serve a request until the
  router has planned it — so a cap at ingress could only reject (503/429) or queue, neither of
  which helps the caller. Enforcing it in the core means a saturated provider is **skipped in the
  plan**, so the request fails over to a provider that can actually serve it.
- **Design:** `ProviderLimiter` (`packages/router-core/src/concurrency.ts`) with
  `settings.perProviderConcurrency` (default 4; `0` = unlimited). Skipped candidates are recorded
  as `RATE_LIMITED` outcomes so the fallback chain stays honest. Permits release in a `finally`
  on every path (success, classified failure, mid-stream throw) and release is idempotent — a
  double release must never leak capacity.
- **Why not just lower the global bound:** a global bound cannot see providers; one degraded
  provider could still occupy all 40 slots and defeat failover. That was the finding.
- **Revisit if:** real traffic shows the default 4 is too tight for bursty single-provider
  setups, or if a headless mode (R1) moves execution off the webview — then re-evaluate whether
  the cap belongs beside the gateway's `MAX_TOTAL`.

## 2026-09-18 — R2: cost attribution — canonical unit is micro-USD per 1M tokens

- **Problem:** `ledger.cost_estimate_micros` was always 0. `pricing_json` was stored but never
  read; `cost_spread` rotation fell back to priority because no price was ever available.
- **Decision:** canonical unit = **micro-USD per 1M tokens** (integer). Micros because the ledger
  column is `cost_estimate_micros INTEGER`; per-1M because per-token prices are ~1e-7 and round
  to zero in any integer representation (0.00000015 USD/token -> 150_000 micros per 1M tokens).
- **Unknown ≠ free.** `parsePricing` returns `undefined` and `estimateCostMicros` returns
  `undefined` (never 0) when a provider publishes no price. Most Anthropic-compatible catalogs
  and b.ai publish none. The UI renders "—", not "$0.00". This distinction is the whole point —
  conflating them overstates what the app knows.
- **Surfaces:** `ModelCatalog` captures `pricing` per model from the provider's raw catalog entry
  (OpenRouter `pricing.{prompt,completion}`; also `input/output` and `*_cost_per_token`);
  `ModelRouter` computes real cost into the ledger; `cost_spread` now orders carriers
  cheapest-first, opt-in via `PlanContext.pricingFor` so existing ordering is untouched;
  Activity gained a Cost column (6 decimals for sub-cent requests).
- **Known limitation (accepted):** unknown-vs-free is resolved at render time from the in-memory
  catalog, not persisted per row. A durable fix is a `cost_known` column via migration `0002`.
- **Revisit if:** non-USD pricing appears (would need an FX step at cache-write time), or image
  generation needs per-image pricing (images carry no token counts today, so cost stays 0).

## 2026-09-18 — Audit R4: per-app gateway keys + monthly spend cap

**Context.** The gateway exposes the user's paid credentials to arbitrary local apps behind one
master key. Before this change: no budget, no per-app keys, no way to cut off one consumer
without rotating the master key (which breaks every other connected app).

**Decisions**

- **Split storage.** Key *metadata* (label, created, revoked) goes in SQLite (migration
  `0002_gateway_keys`); the *secret* goes in the OS keychain under `gwkey:<id>`. SQLite is
  auditable and survives restart; the keychain is where secrets belong. Nothing in the DB ever
  holds credential material — same invariant as `api_keys.secret_ref`.
- **Secret never crosses the DOM.** `gateway_app_key_create` generates → keychain → clipboard
  (Rust `arboard`) and returns only `{id, label}`. If the clipboard write fails the keychain
  entry and the row are both rolled back, so no credential exists that nobody holds.
- **Revocation over deletion.** `revoke` sets `revoked_at` and keeps the row; `delete` is a
  separate explicit action. `active_gateway_key_ids` filters on `revoked_at IS NULL` and is
  re-read per request, so revocation lands on the next request without a restart.
- **402, not 429/403, when the cap is hit.** 402 is the one status clients already read as "out
  of credit", so a runaway agent loop stops retrying instead of hammering the endpoint.
- **Cap is checked after auth.** A 402 discloses the configured budget and current spend; that
  must not be reachable by an unauthenticated caller on the loopback port.
- **Cap scope = every ledger row**, not just `source='gateway'`. A cap that ignored Playground
  and generator usage would be silently understated. Stated in the UI copy: it is a ceiling on
  what you pay, not on one client.
- **Month boundary computed in SQL** (`strftime('%s','now','start of month','utc')`), not by
  hand-rolled calendar math — month lengths vary, and that is exactly the off-by-one that
  mis-bills.
- **Micro-USD is the only money unit** across the stack, matching `router-core/pricing.ts`.
  Cap 0 means *disabled*, not "zero budget" — otherwise an empty Settings field bricks the
  gateway.

**Behaviour change found by a test (not by reading).** The brute-force backoff used to run
*before* the key was checked, so one bad credential throttled every caller on the loopback for
500ms+ — with per-app keys, one misconfigured app locks out all the others. Moved to the
failure path: a valid key always gets through (and clears the counter), repeat failures are
still throttled at the same bound.

**Known limitation (accepted):** no per-consumer *request-rate* limit. One app key can still
monopolise the global semaphore. Needs a per-key token bucket — a different mechanism, deferred
to v1.1.

## 2026-09-18 — Audit R1 (partial): background mode — the gateway outlives the window

**Context.** Every gateway request ran in the webview's JS event loop, so the gateway died with
the window. Three consequences were listed: dies with the window, unavailable during HMR reload,
inherits renderer responsiveness. This change fixes the first; the other two need a real
headless core (v2).

**Decisions**

- **Scope: lifetime decoupling, not execution decoupling.** Running `router-core` outside a
  renderer means a Node sidecar or a Rust port — a packaging + IPC epic. Shipping the lifetime
  fix now captures most of the user-visible value ("my gateway stops when I close the window")
  at a fraction of the risk. Recorded as PARTIAL, not RESOLVED, and the audit says what's left.
- **Tray is mandatory, not decorative.** A hidden app with no UI is unreachable — worse than the
  original problem. So tray construction failure is handled by *logging a warning and leaving
  close-to-quit intact*, never by hiding anyway.
- **Default ON.** Background mode is the point of the feature; a user who wants close-to-quit can
  turn it off. Preference lives in `settings.background.hideOnClose`.
- **Hidden-window heartbeat bound relaxes 6s → 30s.** macOS throttles timers in a hidden window;
  a fixed 6s bound would 503 every background request. Entering background stamps the heartbeat
  so the grace window starts fresh rather than mid-interval. Leaving background restores 6s — a
  renderer that died while hidden is still detected, just more slowly.
- **`RunEvent::Reopen` is `#[cfg(target_os = "macos")]`** in Tauri 2, so the match arm is gated.
  CI is macOS-only, but this keeps a Linux/Windows build from breaking.

**Cost.** Two Cargo features on `tauri`: `tray-icon` and `image-png` (the latter so the tray
reuses the bundled icon instead of shipping a second one).

**Explicitly not verified.** That macOS keeps a hidden WKWebView's `setInterval` firing. The 15x
margin is designed to absorb throttling, but this needs one manual check — start the gateway,
close the window, curl the endpoint. If it 503s, widen `HEARTBEAT_STALE_HIDDEN_MS` or keep the
window off-screen instead of hidden. Flagged in ARCHITECTURE_AUDIT.md rather than left implicit.

## 2026-09-18 — Audit R6: one TypeScript across the workspace (6.0.3, exact pin)

**Decision: unify upward on 6.0.3, pinned exactly, plus a CI guard.**

- **Direction settled by experiment, not taste.** Before touching a manifest I ran desktop's
  6.0.3 binary against both packages' tsconfigs — both clean. So the packages moved up; nothing
  moved down. Had router-core failed, the answer would have been different.
- **Exact pin (`6.0.3`), not `~6.0.3`.** A range lets *resolved* versions diverge even when the
  declared strings match — the same drift, one level lower down. For a compiler, deliberate
  upgrades are the right default anyway.
- **The guard is the fix; matching versions is only the cleanup.** `scripts/check-ts-version.sh`
  (`pnpm check-ts-version`, wired into CI) fails on: two packages declaring different versions,
  a range instead of an exact pin, or a lockfile resolving more than one TypeScript.
  Negative-tested — reverting one package to `~5.8.0` exits 1 and names the file.

**Lockfile:** regenerated with `pnpm install --lockfile-only` (no node_modules churn).
`typescript@5.8.3` pruned; `pnpm install --frozen-lockfile` verified.

**Environment gotcha worth remembering (cost me a repair step).** `pnpm install` fails here with
`ERR_PNPM_CODEBUDDY_BROKER_DENY` (symlink EEXIST) — but it does not fail atomically: it removed
`node_modules/typescript` from both packages before erroring, leaving a dangling `.bin/tsc`.
- For lockfile-only changes always use `pnpm install --lockfile-only`.
- If a full install fails, check for dangling bins and repoint the symlink into the pnpm store
  rather than reinstalling:
  `ln -sfn ../../../node_modules/.pnpm/typescript@<v>/node_modules/typescript <pkg>/node_modules/typescript`

## 2026-09-18 — Audit R8: gateway.rs split by wire dialect

**The finding named the wrong files.** R8 flagged `store.ts` and `commands.rs` with a "~1.5k LOC"
trigger. Measured: store.ts 545, commands.rs 270. Neither qualifies. The real concentration was
`gateway.rs` at 2,389 lines — auth, four wire dialects, the tool loop, capacity and the spend gate
in one file, i.e. the widest blast radius in the repo. Re-measuring before acting changed what
the task actually was. **Lesson: audit findings age; verify the trigger condition before
executing the fix.**

**Decisions**

- **Cut by dialect, not by size.** The split follows the wire protocol boundary (OpenAI Chat /
  models / images, Anthropic Messages, OpenAI Responses, Gemini) so a framing change to one
  cannot touch another. An arbitrary "first 800 lines / rest" cut would split nothing coherent.
- **Nothing became `pub`.** Rust lets a child module reach the parent's private items, so
  `check_gateway_key`, `try_slot`, `err`, `openai_error`, `peer_ip`, `forwarded_headers` and
  `map_generic_to_status` stay private in `gateway.rs` and each dialect imports them. Only the
  seven handler entry points went `pub(crate)` — the surface `spawn()` routes to.
- **`#[path]` for clean module names.** Files are `gateway_<dialect>.rs` (sorts together in a
  directory listing) but modules are `anthropic`, `gemini`, `handlers`, `responses` — no
  `gateway::gateway_anthropic` stutter.
- **Tests not split.** They exercise the HTTP surface end to end, so per-dialect test files
  would duplicate the harness. Kept as one `gateway_tests.rs` declared via
  `#[path = "gateway_tests.rs"] mod tests;` so `use super::*` still resolves to `gateway`.

**Verification:** 69 Rust tests pass unchanged (including all four dialect integration tests),
no new compiler warnings. Committed as its own commit so the mechanical move is reviewable
separately from any behaviour change.

## 2026-09-18 — Audit R1 (execution half): dedicated gateway window

**Chosen over true headless.** A real sidecar needs a bundled Node runtime (and macOS
notarisation for it) *plus* the entire host command surface — egress, vault, store, ledger,
settings, tools — re-plumbed over a new IPC transport, because a sidecar cannot use Tauri
`invoke`. That is weeks and high-risk. A dedicated hidden webview captures both stated symptoms
at a fraction of the cost.

**Decisions**

- **One window owns the bridge.** Rust creates it on `gateway_enable` via
  `WebviewWindowBuilder`; the UI window no longer starts the bridge at all.
  *(It was created `visible(false)`; that turned out to be fatal — see the next entry.)*
- **`emit_to`, never `emit`.** `emit` broadcasts to every webview and both windows hydrate a
  router core — each request would be answered twice: two upstream calls, two ledger rows, two
  streams. This is the one change in this work that would have caused silent, expensive
  misbehaviour if gotten wrong.
- **Self-guarding over CI-guarding.** `startGatewayBridge` refuses to start outside the
  `gateway` window rather than relying on a lint rule. Also stops a stray heartbeat from
  keeping the core looking alive after the worker dies.
- **The staleness bound follows the bridge host, not the UI window.** The worker is hidden by
  design, so 30s is the production bound and restoring the UI no longer clears it.
- **Vite needs a second input.** Without `build.rollupOptions.input` including `gateway.html`,
  the production build omits the page and the worker window loads a 404. Verified:
  `dist/gateway.html` is emitted and the bundle contains no React.

**Accepted limitation:** not actually headless — still a webview, still TypeScript. Editing
`router-core` still reloads the worker in dev (no HMR in production builds). True headless is
v2.

**Open assumption (unchanged, now load-bearing for two features):** that macOS keeps a hidden
webview running JS. One check covers both this and background mode: start the gateway, close
the window, `curl http://127.0.0.1:8787/v1/models`.

---

## 2026-09-18 (later) — the hidden-webview assumption was measured, and it failed

The open assumption above was load-bearing for two shipped features. Instead of leaving it for
a manual check, it was measured with a standalone AppKit/WKWebView harness — a hidden window
whose JS posts a timestamp every 2s, with the "UI" window hidden after a warm-up phase.

**Result: the assumption is false as written.** A webview whose window was never composited has
its JS suspended, and it stays suspended precisely when nothing else is on screen:

| how the window is shown                    | ticks / 24s |      |
|--------------------------------------------|-------------|------|
| never ordered in (`visible(false)`)        | 0           | dead |
| `orderFront` + `orderOut` immediately      | 0           | dead |
| `orderFront` + `orderOut` after 16ms       | 0           | dead |
| `orderFront` + `orderOut` after 300ms      | 8           | alive |
| `orderFront` + `orderOut` after 1000ms     | 8           | alive |

tao's `visible(false)` never calls `makeKeyAndOrderFront` (`tao/.../macos/window.rs:630`), so
the worker window was row 1: it ran while the UI was on screen and died the moment the app went
to the background. **This was a regression** — background mode had worked when the bridge lived
in the always-displayed UI window. The dedicated worker window silently broke it.

**Explicitly ruled out:**

- *App Nap.* Suppressing it changed nothing, so this is WebKit, not power management.
- *Parking the window off-screen.* macOS clamps windows back into the visible area (requested
  `x = -4000` → actual `x = 480`). There is no invisible warm-up.

**Fix:** create the worker window visible, undecorated and small, then hide it after
`WORKER_WARMUP_MS = 1000` — 3x the proven 300ms minimum. After that it keeps running with no
window on screen. `focused(false)` makes tao use `orderFront` instead of
`makeKeyAndOrderFront`, so the warm-up does not steal key status.

**Cost accepted:** a ~220x140 undecorated window is briefly visible when the gateway starts,
once per session. The alternatives were worse — a window that is never displayed does not work
at all, off-screen parking is impossible, and reverting to the UI-window bridge would undo this
entry's whole point.

**Decisions**

- **Measure, do not assume.** The assumption had been written down twice as "verified by a
  manual check not yet performed". It was wrong. A 60-line harness settled in minutes what a
  paragraph of hedging could not.
- **Put the numbers in the code.** The measurement table lives in a comment next to
  `WORKER_WARMUP_MS`, so the next person who sees a magic 1000 knows why it cannot be 0.
- **Keep the liveness bound finite.** A suspended renderer must still be detectable. Measured
  cadence is ~0.33/s with a 3.0s worst gap; the 30s bound therefore has 10x headroom, which is
  also recorded in the code.
- **No test.** This is platform behaviour, untestable in CI. The harness output is the evidence.

**Lesson:** "hidden" is not one state. A window that was never shown and a window that was
shown and then hidden behave completely differently, and only the second keeps running JS.
Any future change that creates a Tauri window hidden-from-birth needs the same warm-up.

---

## 2026-09-18 (later) — the gateway tool loop: two modes, owned by whoever declared the tools

Auditing tool use found the gateway loop was half-built. Four defects, all real:

1. **Tools executed twice.** On `ToolCalls` the handler emitted the calls to the client *and*
   the bridge independently ran them in the sandbox. With Claude Code or Cursor as the client,
   a `write_file` landed twice.
2. **Local execution could never answer.** Both stream and non-stream handlers `break` on
   `ToolCalls` and `drop(slot)`, so the `FollowUp` arm was unreachable and
   `re_dispatch_with_tool_results` was dead code — exactly the "never used" warning. The
   gateway ran the tool and threw the result away.
3. **Unbounded.** The bridge loop was `while (true)` with no cap (the in-app `agentLoop.ts`
   has `maxIterations = 8`; the gateway bridge does not use it), and `gateway_chunk` always
   returned `Ok`, so there was no backpressure. A model that kept calling tools looped forever
   with nobody listening.
4. **Re-dispatch omitted the assistant `tool_calls` turn**, so upstream would have rejected
   the follow-up anyway.

**Fix — one rule decides everything: whoever declares the tools owns them.**

- **Pass-through** (client sent its own `tools`): emit the calls on the wire and end the
  request. Never execute them — the client already will. This is what professional routers do
  for coding agents.
- **Gateway** (client sent no tools, gateway tool toggle on): supply the sandboxed registry,
  execute in the Rust host, feed results back, keep going until the model stops. The client
  only sees the final answer.

Mercury-2.5 inline markers are neither: they are not part of any client tool contract, so they
are always executed locally and filtered from the client-visible stream.

**Decisions**

- **Delete rather than repair the dead mechanism.** `BridgeMsg::FollowUp`, `ToolResult`,
  `gateway_re_dispatch`, `gateway_followup` and `re_dispatch_with_tool_results` are gone. The
  bridge owns the loop; a second dispatch mechanism was the source of the confusion.
- **`reply()` returns whether anyone was listening.** That is now the bridge's only
  backpressure signal, and it is what stops a runaway loop — `gateway_chunk` fails and the
  bridge aborts.
- **Cap at 8 iterations**, matching `agentLoop.ts`. Bounded cost when a model will not stop.
- **Push the assistant `tool_calls` turn before the results.** Providers reject a `tool`
  message that answers nothing.
- **Emit tool calls *awaited* before `gateway_done`.** Both go down the same channel; if Done
  landed first the client would see a finished request with no calls in it.
- **The sandbox default root is now `~/AI-Provider-Router-Workspace`,** not the process
  working directory (which is `/` for a Finder-launched app) and not `$HOME`. A write-capable
  sandbox must not silently default to either.

**Verified:** 82 Rust tests (5 new: pass-through stream terminates without a stop finish,
pass-through non-stream returns `tool_calls`, `reply` reports no listener, safe workspace
default, fresh core uses it) + 261 TS. `cargo check` is now warning-free. `dist/gateway.html`
still emitted with no React in the bundle.

---

## Tools default to ON, not OFF (2026-09-18)

The gateway tool toggle shipped defaulting to **off**, which stripped `tools`, `tool_choice` and
`response_format` from every request before it left the process.

For a router that coding agents are pointed at, that default is actively hostile and silently so.
An agent that declares tools gets none forwarded. An agent that declares none gets no gateway
fallback either. Either way the failure mode is a model that quietly cannot use tools, with
nothing in the response explaining why.

**Both modes are safe with the flag on**, which is the whole argument:

- pass-through — client declares tools, they go upstream, the *client* executes them. The gateway
  runs nothing.
- gateway — client declares none, the gateway supplies its registry and executes inside the Rust
  sandbox, rooted at `~/AI-Provider-Router-Workspace`.

Neither mode executes anything the client did not ask for, and the sandbox root is a dedicated
folder rather than `$HOME` or the process CWD. There is no containment argument for defaulting
to off.

**So off is now opt-in.** It survives because some clients break on tool parameters they do not
recognise, not as a safety default.

**Also:** the UI initial state mirrors the Rust default so the toggle does not flash "Disabled"
for a beat before the invoke resolves, and the label changed from "Forward tools parameters" to
**"Gateway tools"** — it now covers both modes, and the old name described only one of them.

---

## The gateway returned empty completions: chunks are text, not JSON (2026-09-18)

Found while writing the first tests for the gateway bridge. Every answer the gateway produced
was empty.

**The bug.** The bridge did `JSON.parse(rawChunk)` on each streamed chunk and `continue`d when
that threw. Chunks are not JSON. The adapter resolves the provider's SSE/JSON itself and yields
decoded `delta` strings (`manifest-interpreter`: `yield delta`); the e2e suite asserts
`collect(exec.chunks) === "Hello, world!"`. So the parse threw on every single chunk, and
`continue` skipped everything below it — `turnText`, `emitProse`, and the mercury marker scan.
`gateway_chunk` was never called, so Rust had no deltas to stream back.

**Why it survived.** Tool calls are unaffected, because they do not travel in chunks: the
interpreter reports them on `onToolCall` in a `finally` once the stream ends, and the bridge
already collected them there. A tool-calling conversation looked like it worked. A plain chat
request silently returned nothing. Two consumers disagreed about the chunk contract and nobody
noticed — `Playground.tsx` did `streamed += chunk` (text), the bridge did `JSON.parse` (JSON).

**Fix.** Treat a chunk as text. Deleted the `parseOpenAIChatDelta` / `parseClaudeDelta` /
accumulator path — it could never have matched — and the now-unreachable `finish_reason`
fallback. Usage still reaches the client through `onUsage`, which the interpreter does invoke.

**The bridge is now tested.** `src/gateway-bridge.test.ts` drives the real loop with the Tauri
IPC layer and the model mocked, so the part that only ever ran in a webview is covered
headlessly: gateway mode, pass-through, tools off, the 8-iteration cap, abort-on-backpressure.

**Corollary: the client sees the preamble.** The header claimed gateway mode shows the client
"only the final answer" — true only because nothing was emitted at all. With prose flowing, a
model that says "on it: " before a tool call streams that too. Making the old claim true would
mean buffering turn text until the model stops asking, which loses it on an abort or at the
iteration cap, where there is nothing else to show. The stream stays faithful; tool calls and
their results stay server-side.

**Lesson:** when two consumers disagree about a data contract, one of them is dead code that has
never run. `JSON.parse` inside a `catch { continue }` is invisible — it converts "wrong shape"
into "silently dropped", and it took a test that asserts on output, not on absence of a crash,
to surface it.

---

## Gateway mode shows only the settled answer (2026-09-18)

A gateway-mode run spans several model turns, and only the last one is an answer. Text from a
turn that goes on to call a tool is a preamble the client never asked for, so it is held back
and dropped when the next turn starts. Pass-through and tools-off still stream immediately —
neither has a follow-up turn to wait for.

Two consequences had to be solved, or this would have shipped a worse bug than it fixed:

- **Backpressure.** `gateway_chunk` failing was the only signal that the client is still
  connected. Holding text back removed it, so a client that disconnected mid-run would have
  paid for all 8 remaining turns. The bridge now probes with an *empty* chunk before every
  turn after the first, and Rust drops empty deltas instead of putting them on the wire. Net
  effect: disconnect detection costs one turn instead of being immediate — bounded, not
  unbounded.
- **The iteration ceiling.** There is no settled answer at the cap, but the last turn is
  released anyway. A client that receives nothing cannot distinguish "gave up" from "broke".

## Dead code removed (2026-09-18)

`gateway-sse-parser.ts` (~300 lines + ~400 lines of tests) is gone, along with its export and
the plan snippet that prescribed the buggy `JSON.parse(rawChunk)` pattern — now marked
REJECTED in `docs/gateway-flexibility-plan.md` with what was wrong and why. Recoverable from
git if the Claude/Responses dialect work needs it.
