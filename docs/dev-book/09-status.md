# 09 — Status

**As of 2026-09-23**, against `031ae4f`.

> **This is the one chapter expected to age quickly, and the only one where staleness is normal.** Every other
> chapter states a rule that changes only when someone decides to change it. This one states where the work
> stands. **When you finish an item, move it — do not leave it here looking current.** The dated evidence trail
> lives in [`../PRODUCT_COMPLETION_PLAN.md`](../PRODUCT_COMPLETION_PLAN.md); this is the live snapshot.

## Working and verified

Each of these has a test, a gate step, or a measurement behind it — not just a merged commit.

| Area | State | Evidence |
|---|---|---|
| Gateway ingress | 4 dialects, SSE streaming, **8 routes** (7 OpenAI-compatible + `GET /health`) | `core/gateway.rs:1938-1945` |
| Rotation and failover | Per-key cooldowns, circuit breakers, 6-attempt bound | `core/gateway_tests.rs`, [08](08-flows.md) |
| Capacity control | 8 in flight, 32 queued, `429` on overflow | `MAX_CONCURRENT` / `MAX_QUEUED`, `gateway.rs:39-41` |
| Adapter tiers | Builtin templates, manifest interpreter, QuickJS sandbox | `router-core`, Tier-2 review screen |
| Onboarding | Deterministic fingerprint path, AI fallback, contract-gated | `onboarding-e2e.test.ts` |
| Drift and repair | Detection window, patch flow, versioned rollback | `drift-repair-e2e.test.ts` |
| Secrets | Keychain-only, key-blind TypeScript, one-shot reveal | Invariants 1–2, `key-leak-grep` in CI |
| Memory | Scoped recall, capture queue, retention, supersession | Migration 0014, `memory.spec.ts` |
| Agent loop | Sandboxed tools, visible step trail | `agent-turn.spec.ts`, `tauri/tools.rs` |
| Gateway keys | Per-app keys, **per-app monthly budgets**, global monthly spend cap | `tauri/commands.rs`, `gateway_keys` table (0017) |
| Ledger | Tokens, cost, latency, error class, prompt-cache `cached_tokens`, per-app `app_key_id` | Migrations 0015–0016 — 18 columns. 0015 is live: 1530 rows, every one `cached_tokens IS NULL` by design. **0016 is in the source but not in the installed database** — measured 2026-09-23, the live DB sits at `schema_version` 15, so `ledger.app_key_id` does not exist there yet and attribution begins on the first launch after a rebuild |
| Schema | 17 versions, count asserted, rewind-tested | `core/store.rs:1009-1013` |
| Headless service — Phase 1 | Rust split into `core/` (Tauri-independent) and `tauri/`; **`core/` no longer compiles Tauri at all** — `default = ["app"]` with both Tauri crates `optional` and every `tauri` mention behind `#[cfg(feature = "app")]`, so `cargo build --bin aiproviderd --no-default-features` drops `tauri`/`wry`/WebKitGTK from the graph entirely. `aiproviderd` builds and serves `GET /health` → 200 `{"status":"ok"}` on macOS, Windows and Linux. **Does not serve completions** — the router core is still TypeScript in a webview, so every completion route answers 503 by design | `src/bin/aiproviderd.rs`, `src/core/`, `src/tauri/`; [10](10-headless-service.md) §2.1.1; CI job `headless-service`, which now builds with `--no-default-features` and installs no GTK/WebKit. Acceptance audited in [10](10-headless-service.md) §2.1.2: 8 of the prompt's 9 criteria hold as written, and the ninth (`pnpm build` "produces a working Tauri app") is false as written — it is met by the real bundler command, now a CI step |
| Governance | Apache-2.0, changelog, security policy, weekly audit, and a **self-verifying** release workflow — the preflight refuses an unprovisioned build and the artefact is read back and must be notarized | `LICENSE`, `.github/workflows/`, `scripts/release-preflight.sh`, `scripts/verify-release-signature.sh` |
| Doc links | Every relative link and image in every markdown file resolves | `scripts/check-doc-links.mjs`, a gate step |
| Rust lints | `cargo clippy --all-targets -- -D warnings` is clean | 64 → 0 on 2026-09-22; two were real dead branches, not style |
| Rust formatting | `cargo fmt --check` is clean under `apps/desktop/src-tauri/rustfmt.toml` | 354 hunks rewritten once on 2026-09-22, then converged to 0. A stock config would have rewritten 638 |
| Tests | **460** TS unit (18 adapter-spec · 249 router-core · 193 desktop) · **27** end-to-end · **104** browser · **712** Rust | Browser and Rust re-measured 2026-09-23 after 0017 (+6 and +8); TS unit unchanged. Rust re-measured 2026-09-24 at **712** after increments 11b–13 (489 → 712: planner +29, ledger +16, router +50, and the rest across `engine.rs`, `pricing.rs` and the 0017 work) |
| Coverage | **43.8%** statements · 37.3% branches · 31.1% functions · 45.4% lines, weighted across the three packages | `pnpm test:coverage`; a report, **not** a gate step — [`../PRODUCT_COMPLETION_PLAN.md`](../PRODUCT_COMPLETION_PLAN.md) §4.2 |

## Gaps

Real absences, with the reason each one is absent.

| Gap | Why it is not closed |
|---|---|
| **Release not provisionable yet** | **Blocked, not pending.** The pipeline is complete and self-verifying; what it needs is a **paid Apple Developer Program membership** ($99/year), which is the only thing that can issue a Developer ID Application certificate. Measured 2026-09-23: the login keychain holds exactly **one** codesigning identity, `AI-Provider IDE Dev Signing`, and it is **self-signed** (subject == issuer) — a local dev certificate that cannot notarize. So no route to a notarized release exists until the membership does, and no code change can substitute for it. See `CONTRIBUTING.md`, "Releasing" |

**The release row was reworded on 2026-09-23, and the rewording is the finding.** It read "no notarized
release", which named the *symptom* and implied the pipeline was missing. The pipeline was not missing — it
was **unfalsifiable**, and that was the actual defect: `tauri build` succeeds with no Apple secrets at all and
emits an **ad-hoc signed** app, so a tag push produced a green job and a draft Release containing something
macOS refuses to launch. The docs warned about it in prose and nothing enforced it.

Two guards now enforce it. `release-preflight.sh` runs first, costs about a second, and fails when a secret is
absent, when the `.p12` will not open with the given password, or when `bundle.macOS.signingIdentity` is pinned
in `tauri.conf.json` — the rule no other job can catch, because nothing outside `release.yml` runs a full
`tauri build`. `verify-release-signature.sh` reads the artefacts back afterwards and asserts the signature is
not ad-hoc, the authority is a `Developer ID Application`, the hardened-runtime bit is set, `spctl` accepts the
artefact **as** `Notarized Developer ID`, the notarization ticket is stapled, and the same three signature
properties hold for **every Mach-O inside the bundle** — added 2026-09-23, because a second `[[bin]]` is copied
into `Contents/MacOS/` undeclared while the bundle-level checks describe only the main executable. If it fails, the job goes red
and the draft is deleted.

**`codesign --verify` is not sufficient, and this was measured rather than assumed.** On an ad-hoc bundle it
prints `valid on disk` and `satisfies its Designated Requirement` and **exits 0** — an ad-hoc signature is a
valid signature. The checks that separate the two states are `spctl` (exit 3 vs 0), `stapler validate` (exit 65
vs 0), the `CodeDirectory` flags word (`0x2(adhoc)` vs `0x12a00(…,runtime)`) and the `Authority=` chain. A
verifier that stops at `codesign` is decoration.

**What "blocked" means in practice, because it is a real constraint and not a formality.** The release workflow
no longer produces **any** downloadable artefact until the certificate exists. That is the guards working as
intended — a tag push fails in about a second at the preflight, naming the missing secrets, rather than emitting
an ad-hoc draft. The workflow triggers on `v*` tags and on `workflow_dispatch`, but both paths run the
preflight, so there is no way to route around it from inside the pipeline.

**Local builds are unaffected, and that is the fallback.** `pnpm --filter ai-provider-router-desktop tauri build`
still produces a working `.app` — ad-hoc signed, which is correct for running on your own machine. Measured
2026-09-23: about 4 minutes, succeeds completely, and only the DMG step fails (`hdiutil`), which is why
`REFERENCE.md` says to take the `.app` and ignore that error. Such a bundle can be zipped and shared by hand,
but a recipient is met with the unidentified-developer warning and has to override Gatekeeper explicitly — which
is exactly the experience the pipeline now refuses to ship as a release.

**The membership is the gate, and it is a purchase, not a task.** Everything downstream is already written down
in `CONTRIBUTING.md`: create the Developer ID certificate, export the `.p12`, base64 it, create an app-specific
password, set five repository secrets, then tag. None of that can start first.

**"No per-app budgets" left this table on 2026-09-23 and is now closed.** It was three parts, and only the
last was the one the row implied — attribution, a cap column, enforcement. All three shipped. The reasoning is
kept rather than deleted, because the *order* was the finding.

**"No auto context compression" left this table on 2026-09-23 and is now closed.** The failure was real:
neither caller trimmed anything, so a long session failed at the provider with a context-length error. Tier 1
fixes the overflow by dropping the oldest **complete turns** until the prompt fits. Three properties make that
safe rather than merely smaller, and all three are pinned by tests: the `system` turn survives (it carries the
client's instructions and, on the gateway, the injected memory block); the **newest** turn survives even when it
alone exceeds the budget, because dropping it would answer a question the user did not ask; and a turn boundary
only ever falls on a `user` message, so an assistant `tool_calls` turn and the `tool` results answering it are
always dropped together — providers reject a result whose originating call is gone.

**Why one implementation and not two.** The gateway and the assistant look like separate features, and treating
them as two would have put a truncation rule in each. Both converge on `router.generateText` — the gateway
through `gateway-bridge.ts`, the assistant through `runAgentLoop` — so the trim lives there once, and the two
cannot drift. The budget is the narrowest *known* window across the failover plan rather than the first
candidate's, because failover may serve the request from any of them; a plan where no model published a window
falls back to `DEFAULT_CONTEXT_WINDOW`, which under-sends rather than overflows.

**Tier 2 — summarization — also landed 2026-09-23.** `compressWithSummary` replaces the dropped turns with a
compact summary rather than discarding them. The assistant wires `createSummarizer` into every agent turn: a
second call to the same model with `skipCompression: true` — without that flag, the summarizer would compress,
which would summarize, which would compress: an unbounded chain. Three properties are tested: the summary
lands in the system prefix so it survives any later trim; the summarizer receives exactly the dropped
messages; and a failed summarizer falls back to Tier 1 truncation without failing the request. The gateway
stays on Tier 1 (stateless, latency-sensitive).

**"No per-app budgets" understates itself.** Measured against the live database, the cap was not the first
missing piece — attribution was. Two different columns are called `key_id`: `ledger.key_id` is the *provider*
credential (`api_keys.id`), which **713 of 1297** gateway rows join, while the gateway's own app key
(`gateway_keys.id`) was joined by **0** rows and held by no column at all. The database holds exactly one app
key — `ak-fc85…`, labelled "Work buddy" — and it was attributable to nothing. A budget therefore had nothing
to sum. The work is three parts, and only the last is the one the row implies.

**Part 1 — attribution — landed 2026-09-23.** Migration 0016 adds the nullable `ledger.app_key_id`; the write
path carries it (`LedgerRow`, now `deny_unknown_fields`, so a misspelled key is an error rather than a silent
`NULL`); and the producer chain is connected end to end — `check_gateway_key` now returns the identity it was
already computing, all six dispatch sites put it on `BridgeRequest`, `gateway-bridge.ts` hands it to
`router.generateText`/`generateImage`, and `store.ts` maps it. A column alone proves nothing, which is this
project's own rule, so the chain was traced rather than assumed. Four tests cover it, each falsified before
being trusted. **Caveat:** it attributes rows written from now on; the existing rows stay `NULL`, and nothing
can reconstruct which app paid for them.

**Part 2 — the cap column — landed 2026-09-23 (migration 0017).** `gateway_keys.cap_micros`, nullable, with
clearing storing `NULL` rather than `0` so there is one spelling of "no budget" instead of two that behave
identically until something queries `IS NULL`. The migration also adds `idx_ledger_app_key_ts ON
ledger(app_key_id, ts)` — the index 0016 explicitly declined to ship, on the grounds that a column with no
consumer should not arrive with an index for a query nobody had written. 0017 is that consumer.

**Part 3 — enforcement — landed with it.** `SpendProvider` was `Arc<dyn Fn() -> (i64, i64)>`, **zero
arguments**, so the gate could not tell callers apart. It is now `Fn(Option<&str>) -> SpendLimits`, carrying
both the global pair and the app's, because the two limits are independent and neither is derivable from the
other: with a $10 global cap and a $100 app cap, one app can breach the global limit while far under its own,
so a minimum of the two is wrong. `spend_gate` checks the global cap first, then the per-app cap, and the two
refusals carry **different codes** — `spend_cap_exceeded` and `app_budget_exceeded`. Both are `402
insufficient_quota`, so a client branching on `error.type` alone could not tell "the owner's budget is gone"
from "this one app's slice is gone", and those have opposite remedies.

**Seven falsification probes, one at a time.** Each failed exactly the tests naming its mechanism and left the
others passing. One probe falsified a claim this very section had written: defaulting a missing app cap to `0`
turns out to be *harmless while the `cap > 0` guard stands*, because the guard short-circuits first — so the
two are independent defences, and the test pins the observable property rather than either mechanism. The
comment says so now, where before it asserted a mechanism that does not exist.

**Three rows left this table on 2026-09-22.**

**"No formatter gate"** — `cargo fmt --check` now runs in both mirrors, first in the Rust block. It failed on
adoption for a measurable reason rather than a stylistic one: the host is written in a compact "one line if it
fits" style — `Self { start: Instant::now(), budget, missed_at: None }` — which a stock rustfmt config explodes
one item per line. Adding `use_small_heuristics = "Max"` cut the churn from **638 hunks / 42.2% of the host to
354 / 30.1%**, and that is what made the blame cost payable. The reasoning lives in
`apps/desktop/src-tauri/rustfmt.toml` rather than in a commit message nobody will read again.

**"No coverage measurement"** — `pnpm test:coverage` now prints one weighted figure across the three packages
(43.8% statements). Note that this closed as a *measurement*, not as enforcement: it is deliberately not a gate
step, for the reason given in [`../PRODUCT_COMPLETION_PLAN.md`](../PRODUCT_COMPLETION_PLAN.md) §4.2.

**"Audit level pinned at `high`"** — the two moderate advisories shared one root cause, a `vitest`
devDependency whose patched line was a whole major version away, and the bump to `^4.1.11` cleared it with **no
test changes at all**: the vitest configs used only long-stable options, and all 460 tests passed on 4.1.11 as
written. So `--audit-level` rose from `high` to `moderate` in both mirrors. The gate is stricter than it was,
and nothing was weakened to get there.

## Parked or unfinished

| Item | State |
|---|---|
| **`thinking` blocks** | Not started, and not startable yet. Measured 2026-09-23: four drop sites, no protocol field to carry it, and nothing to test it against |
| **`previous_response_id`** | Closed as not applicable — Codex points at a different gateway, and sets `wire_api = "responses"` with `disable_response_storage = true` |
| **Headless Phase 2 — the router core in Rust** | **Increments 1–13 landed 2026-09-24.** `core/engine.rs` holds the port's pure core: the error taxonomy, `COOLDOWN_FLOOR_MS`, the shortest-wait fold, and `HealthTracker` — so the floor the tracker *enforces* and the wait the client is *told* share one constant. `Bridge::dispatch` now takes a `ReplyHandle` instead of the bridge reaching back for the core, so a Rust bridge can answer at all and the core↔bridge cycle is unrepresentable. `AllAttemptsFailed` has a home and its wait arithmetic delegates to that same fold instead of repeating it, and `attempt_budget` pins the rule that a budget the caller named as zero stays zero rather than becoming the default six — the difference a falsy test erases. `core/limiter.rs` is the per-provider cap (audit R3) and the **first increment that adds a behaviour rather than relocating one**: `per_provider_concurrency` appeared nowhere in the Rust tree, so the gateway had the one global semaphore and none of the per-provider isolation it exists to provide. Its release is RAII, its check and its increment share one lock because a literal port of the TypeScript check-then-act would race, and `clamp_concurrency` preserves zero as the documented "unlimited" while rejecting a negative that would *behave* as unlimited while displaying as a bound. **Increment 6 lands the loop's per-attempt policy** — `AttemptError`/`FailureKind`, `classify_attempt_error`, `AttemptDisposition`, `attempt_outcome`, `records_key_health`, `saturated_outcome` and `candidate_gate` — which is everything `executeText` decides *between* attempts, and the last piece that needs no adapter layer. It states one rule where the TypeScript spells two (D19), and it pins the R3 skip convention — `RATE_LIMITED`/`429`, recorded in the fallback chain and deliberately **not** in key health — which the limiter previously had no consumer to define. **Increment 7 lands the adapter seam and the image loop** — `core/adapter.rs` (`Cancel`, `ImageArgs`, `ImageReply`, `AdapterInstance`, `AdapterFactory`) plus `engine::execute_image` over it, the first increment to cross the "no I/O, no async" line that increments 1–6 held deliberately. The seam is the **image half** only, and on purpose: `generateText`'s `TextArgs` carries four `unknown`s (`messages`, `tools`, `toolChoice`, `responseFormat`) and an `onUsage` callback that is load-bearing — dropping it is how every gateway response came to report `usage: null` — and a Rust port of that callback would introduce a second usage shape beside `BridgeMsg::Usage`, which is the two-spellings defect this register keeps finding. So the text half waits for that shape to be decided rather than being invented here. **Increment 8 decides that shape and nothing else** — `core/usage.rs` holds `UsageTokens`, the crate's single three-field home for token counts (`prompt_tokens`, `completion_tokens`, `cached_tokens: Option<u64>`), which is what `on_usage` will hand over. It was taken first because it is the blocker rather than a detail: the crate's only usage type, `BridgeMsg::Usage`, carries two of the three fields, so a porter reusing it would silently stop recording the measurement migration 0015 exists to take (D23). The module keeps the absence/zero distinction at the *type* level rather than in a comment, keeps `None` out of the ledger as SQL `NULL` instead of a forged `0`, and its tests' exhaustive literals make a fourth field a compile error rather than a silent drop — which is the only mechanism that can see a field nobody has written yet. 80 tests, `cargo test` **575/0**, and six falsifications more than increment 7's forty-two: five that fail a named test and one that the compiler rejects outright. **Increment 9 lands the text half of the seam** — `ToolCall`, `TextArgs<'a>` and `AdapterInstance::generate_text` — so `AdapterInstance` is whole for both members the engine calls, and the five it does not call stay absent by statement rather than by omission. It is pull-based (`BoxStream`, matching the TypeScript's `AsyncGenerator`) where the crate's *other* text path is push-based (`ReplyHandle` + `mpsc`), and the reason is cancellation: a pull stream is driven by the engine, so the engine owns the stop rather than every adapter remembering a flag. Its two-phase return is the design rather than an implementation detail — awaiting the future is the response phase, where a refusal is `Err`, and polling the stream is the mid-stream phase, where a break is an `Err` *item* because the consumer already holds text and a clean `Err` would invite the retry that duplicates it. Adding the member broke exactly one implementor outside the new code, **at compile time** — the image double in `engine.rs` — which is the method-shaped analogue of increment 8's exhaustive literal, and the reason neither trait method has a default body. 8 tests, `cargo test` **583/0**, and eight falsifications: six that fail a named test and two the compiler rejects outright — an implementor missing the member, and the usage callback reverted to a two-field payload. The eighth test exists because the double's first draft fired its callbacks during the *future* — the non-stream branch's behaviour behind a `stream: true` field — which would have blessed a consumer that read usage without draining; it now fires at exhaustion, in the source's order. **Increment 10 lands the loop over the seam** — `engine::execute_text`, with `ExecuteTextArgs`, `TextSuccess` and `TextFailure` — the last piece of Phase 2. Its one deviation from the source is that it is a **sink** (`on_chunk`) rather than the TypeScript's pull generator, and the deviation is structural rather than convenient: the source's `yield` sits inside an `await`-driven retry loop that a Rust port would have to hand-roll as a state machine (there is no `async-stream`, and this port may not add one), and a `BoxStream` has nowhere to throw the `AllAttemptsFailedError` the source raises *inside* its generator (`:141-143`) — the alternatives being a wider item type, or leaving the caller to infer exhaustion from an empty stream, which is how a failed request becomes a `200` with no body. The cost is stated rather than hidden: a caller can no longer stop early by not draining; it cancels instead, which the loop honours at `:80` and `:133`. `TextFailure` carries `attempts` and `usage` on every variant because `model-router.ts`'s `catch` reads `exec.served()`, `exec.fallbackChain()` and `exec.usage()` on the failing path (`:488`, `:517-519`), and `Cancelled` is its own variant rather than an empty `Ok` because the source `return`s from the generator instead of throwing and the caller writes a different ledger row for each (`:451`). **Two borrow-checker findings, and the first was a diagnosis of mine that the evidence reversed:** `TextArgs` does *not* need two lifetimes — built, then measured against a 60-line reproduction and falsified; what fails is handing the seam a `&mut dyn FnMut` taken off a field of the caller's own argument struct, which pins the borrow to that field's declared lifetime and forces it to outlive the retry loop, and the fix is a local closure at the call site with the seam left exactly as increment 9 declared it. `TextArgs`' payloads are now borrowed rather than owned, because owned payloads meant a deep copy of the whole conversation *per attempt*. Thirteen tests, `cargo test` **596/0**, and thirteen falsifications — every one a red test and not one a compiler rejection, which is a first for this register and follows from the two phases being one type on both sides of the seam. **Phase 3 opens with increments 11a and 11b, and neither touches async, I/O or SQLite.** 11a is `core/pricing.rs` (335 lines, 12 tests, `cargo test` **596 → 608**) — micro-USD per 1M tokens as an `i64`, with "unknown" as `None` and never `Some(0)`, because a provider that publishes no pricing is a different fact from one that publishes free and a zero makes it the cheapest carrier in any `cost_spread` ordering; the harness found three things reading did not, the sharpest being that Rust's `?` is not TypeScript's `??`, so a `?` chain over the four pricing spellings returned from the function on the first miss and silently demoted every `input`/`output` catalog to "unknown". 11b is `core/planner.rs` (~740 lines, 29 tests, `cargo test` **608 → 637**) — `build_plan`, `resolve_wanted`, `strip_client_namespace`, `order_keys`, `order_carriers`, and `Candidate` moved here from `core::engine`, redeeming the promise increment 7's doc-comment made when it parked the type there. The context is a **trait**, not a struct of `&dyn Fn` fields: a field holding `&'a dyn Fn(..)` forces every test to keep its closures alive longer than the context built from them, and a borrow
of an inline closure is a borrow of a temporary. Three divergences are provably behaviour-preserving and each is pinned: `rem_euclid` replaces JavaScript's `%` *plus* its negative `slice` indices (the same rotation, total rather than sign-dependent); the TypeScript's `if (!ctx.pricingFor)` guard is unobservable once an absent price is `None`, so `pricing_for` is a required method with no default rather than an `Option`-wrapped one; and the dedup key is a tuple rather than a space-joined string. Two source behaviours are kept and pinned: one carrier asking for `cost_spread` reorders every other carrier, and a **disabled** provider still claims its own qualifier, which suppresses the bare-id fallback and can empty the plan. 22 falsifications, all red tests. **Increment 13 closes the phase, and the gap this row parked.** `core/router.rs` is the router glue — `generateText`, `generateImage`, `complete`, `listModels`, `systemAiAvailable`, `syncConcurrency` and the `plan` helper — and `AttemptOutcome` now names the provider and key it tried. It closed in the shape this row said was *not* the cheap one: two fields (`provider_slug`, `key_label`) rather than a joined `slug/label` string, because `fallbackChainJson` needs three separate JSON fields and re-splitting would break on a label containing the separator. The cost the note predicted was real and was paid — `AttemptOutcome` is no longer `Copy`. `RouterError::Text` is boxed, on this module's own measurement rather than by inheriting the `#[allow]` `execute_text` carries: the error outgrows the payload by 8× to 77× on four of its five returns, where the engine's `Ok` arm carries the same 536-byte payload the failure does. Three findings came from failing tests rather than from reading — `complete`'s terminal error was `NoRoute`, which `gatewayStatus` maps to `404` where the source answers `500`; the first fall-through test asserted a per-key retry the source does not have (it falls through per *model*); and the image failure path writes no ledger row at all, because `generateImage` has no `wrapLedger`. 12/12 falsifications. Scoped in [10](10-headless-service.md) §7 — the port is 1,114 lines, not the 229 the plan implied |
| **`ApiKeyRow.cooldown_until` has no writer** | Mapped through three layers (`store.ts:460,473`, `api_keys_list`, `HealthTracker.is_key_usable`) and written by none: all four `updateKey` call sites pass `status`, `lastTestedAt`, or both (measured 2026-09-23), and nothing assigns the field directly. The check that reads it is unreachable, and its unit is pinned only by the TypeScript comparing it against `Date.now()`. Same family as `NULL` ≠ `0` — two layers agreeing about a field no layer sets |
| **`core/`'s tests are Tauri-free too** (D17, fixed) | Both mirrors used to build `--no-default-features` *without* `--all-targets`, so the lib's `cfg(test)` code was never compiled in that configuration — and it did not compile: **33 errors**, the first at `persist.rs:2349` calling `list_drift_events`, defined behind `#[cfg(feature = "app")]` at `persist.rs:825`. The *shipping* code was Tauri-free, so the Phase 1 claim held for what it was about; the tests were not. **Closed 2026-09-23:** the three test modules in `persist.rs` that call app-gated readers carry the same gate (four tests individually, the two trail modules wholesale since every test in them needs it), `gateway_tests.rs`'s helper that went dead once they were gated carries it too, and both mirrors gained a `Headless targets check` step — `cargo check --no-default-features --all-targets`. Measured after: **0 errors, 0 warnings**, `cargo test` still **541 / 0** so no test was lost, and a `cfg(test)` probe naming `tauri::AppHandle` fails the check with `E0433` **with** `--all-targets` and passes **without** it — the flag is the whole of the difference. This matters more each increment, because every Phase 2 increment adds `cfg(test)` code to `core/` |
| **A test named for idempotence does not test it** (D18) | `release is idempotent — a double release cannot leak capacity` (`concurrency.test.ts:134-142`) still passes with the `released` flag deleted from `concurrency.ts` — measured 2026-09-23, 1 passed and 272 skipped. With a cap of 1 the count is already 0 and the entry already deleted after the first release, so the second and third calls take the "delete at zero" branch again and change nothing; the property only bites with **two** permits held, where the count drops from 2 to 0 while the other permit is still in flight. The code is correct — only the test's claim is broader than its check. The Rust port keeps the test for fidelity, marks it weak in place, and carries the property in `an_explicit_release_followed_by_drop_counts_once`, whose falsification fires |
| **A failure's class depends on which branch of the loop caught it** (D19) | `executeText` spells the classification of a caught attempt error **twice**, and the two spellings are not the same rule. `execution-engine.ts:113` (the already-emitted path) tests only `classify(status) === "OK"`; `:118` (the not-yet-emitted path) additionally forces `PARSE_ERROR` whenever the failure kind is `mid-stream`. Measured 2026-09-23 by executing the real `classify` against both expressions: a mid-stream `429` is `RATE_LIMITED` under `:113` and `PARSE_ERROR` under `:118`, and a mid-stream `503` is `SERVER_ERROR` under `:113` and `PARSE_ERROR` under `:118` — two divergences — while the input a producer actually emits (mid-stream, status `200`) agrees. That agreement is not the two rules meeting; it is one constant at the throw site: `manifest-interpreter.ts:360` is `new ManifestHttpError(200, JSON.stringify(err), "mid-stream")`, and it is the only one of the three `ManifestHttpError` construction sites that is not `kind: "response"` (`:246` and `:304` both pass a real status), so the divergence is **latent rather than live** — no reachable input separates the branches today. It is not cosmetic either: `:113` is the branch that skips `recordResult`, so under that spelling a mid-stream `429` would classify as the one class that cools a key, and then never cool it. The Rust port (increment 6) states the rule once, takes the `:118` spelling because it does not depend on a constant chosen at a throw site, and pins the choice with `the_two_spellings_agree_only_because_the_midstream_producer_reports_two_hundred`. **Recorded, not fixed** — the TypeScript is left exactly as written, so the reference the port is measured against does not move under it. Register: D19 |
| **A Phase 4 note cited a file that does not contain the flag, and claimed a Rust guard that does not exist** (D20, fixed) | `10-headless-service.md:866-867` said "The `skipCompression` flag (`gateway-bridge.ts:102`) prevents infinite recursion — the same flag exists in the Rust port". Both halves are false, measured 2026-09-23. `gateway-bridge.ts` contains no `skipCompression`, no `compress` and no `summar` — the citation points into a doc comment about `GATEWAY_WINDOW`; the flag actually lives at `model-router.ts:108` and `:134`, set by the caller at `Assistant.tsx:100`. And `src-tauri` has no path that compresses the *client's* `messages` — the gateway forwards them verbatim. **The evidence here was too strong and was corrected 2026-09-23:** the tree is not without a compression path, it is without *this* one. `context_scope.rs:884-1020` estimates tokens (`estimate_tokens`, `estimate_prompt_tokens`), sizes a budget (`plan_budget_for`) and drops what will not fit (`rank`, `trim`, `compose_block`), and `inject_context` runs it on the gateway's read path — but that path compresses *recalled memory* into a system message, never the conversation, and `skipCompression`'s recursion guard has no counterpart at all. Phase 4 has not started, so the guard cannot be in place — and a reader planning Phase 4 would have concluded it was, and left it out. **Fixed:** the citation is corrected and the flag is now marked a Phase 4 deliverable rather than an existing one. Register: D20 |
| **The client-facing `usage` object reports less than the system knows** | `BridgeMsg::Usage` is `{ prompt_tokens, completion_tokens }` (`gateway.rs:365-368`) — there is no field to receive a third value — and the webview's `onUsage` callback, **the same callback that fills the ledger with `cached_tokens`**, passes only two of the three fields it holds (`gateway-bridge.ts:302-303`). So no dialect's response can carry a cached-token count: not `prompt_tokens_details.cached_tokens` (OpenAI), not `cache_read_input_tokens` (Anthropic), not `cachedContentTokenCount` (Gemini) — although the ledger records it for all three, by D8's chain, which was traced and found complete. `persist.rs:485-489` states the measurement exists to answer "whether caching is available to us at all", and a client cannot see it. **Separately, `total_tokens` appears in exactly one of the two response modes per dialect — and they are opposite modes:** OpenAI's streaming chunk has it (`gateway_handlers.rs:143`) while its non-streaming body does not (`:260`, `:267`); Gemini's non-streaming body has it (`gateway_gemini.rs:384`) while its streaming finish chunks do not (`:258`, `:290`). `total_tokens` is derivable by a client, so that half is cosmetic; a cached-token count is not derivable from anything the client receives. The fix is one field in Rust plus one line in TypeScript, but it changes the HTTP response body, which §8.2 protects for this phase — recorded rather than applied. **The port-side half closed 2026-09-23:** `core::usage::UsageTokens` (increment 8) is the three-field home the headless engine will use, so the Rust router cannot repeat the loss by reaching for the crate's only usage type — but that closes the *porter's* half only and leaves this entry's client-facing half exactly where it was. Register: D23 |

**Two rows left this table on 2026-09-22.** **rustfmt adoption** moved to "Working and verified" — it is now a
gate. **`IDE/`** was removed: a file count showed it held none at all, only an empty `IDE/.workbuddy-ai/memory/`
skeleton from a session that ran with the wrong working directory, so `rmdir` closed it with nothing at risk.
The hesitation on that row was about the directory's *name*, and the measurement retired it.

**"Quality-only, and last by design" was the wrong label for `thinking` blocks.** The measurement says the item
is not *low priority* but *not yet measurable* — a different thing, with a different next action. The drop is
deliberate and documented (`gateway_anthropic.rs:204-206`): "Anything else (thinking, images) has no OpenAI
equivalent here and is dropped rather than guessed at." What the old label hid is that **four separate things**
are dropped, not one — the `thinking: {type, budget_tokens}` request parameter (no passthrough in
`to_chat_body`), `thinking` blocks in history, every non-stream response, and the stream, which multiplexes only
`text` and `tool_use` (`:393`, `:446`). The bridge cannot carry it either: `BridgeMsg` has no reasoning variant,
so this is a Rust *and* TypeScript protocol change. And there is nothing to verify it against — **0 of 455**
cached models mention reasoning, so no provider in this install can exercise it. Same shape as `cache_control`,
which the plan also parked as blocked on measurement: measure, decide, rework, and the measurement is not
available.

## Needs improvement

Not gaps — things that work but carry a cost worth stating.

**The gateway's availability is bound to the webview's *process*, not to its window.** It bridges into the
TypeScript core, so a reloading or crashed renderer means `503` for every client, and quitting the app takes
the gateway with it. What closing the window does *not* do is stop it: `hideOnClose` defaults on, so the window
hides and the gateway keeps serving, with the tray as the way back. Headless service mode — the gateway
detached from any window *and* from the app process — is [under way: Phase 1 landed 2026-09-23](10-headless-service.md),
and `aiproviderd` starts and serves `GET /health` with no window and no Tauri app.

**The dependency half of the split closed on 2026-09-23, and it is a stronger claim than the source
half.** Phase 1 originally made `core/` Tauri-free in *source* only: `persist` still carried 28
`#[tauri::command]` attributes, `egress::stream` still took a `tauri::ipc::Channel`, and `Cargo.toml`
kept `tauri` unconditional — so `cargo build --bin aiproviderd` compiled Tauri, and the Linux CI job
had to install WebKitGTK to let it. The package now declares `default = ["app"]`, both Tauri crates are
`optional`, and every `tauri` mention in `core/` sits behind `#[cfg(feature = "app")]`. Measured:
`cargo tree --no-default-features --edges all | grep -ci 'webkit|wry|gtk'` → **0**; the feature-less
release binary is **380 KB smaller** (4,073,968 B vs 4,454,336 B, the difference being Tauri not
linked); `cargo check --no-default-features` is warning-free; `cargo test` still 489 passed / 0 failed.
The Linux job builds with `--no-default-features` and installs no GTK/WebKit. Two things this does
**not** do: `tauri-build` still compiles, because Cargo has no optional build-dependencies, so
`[build-dependencies]` cannot be feature-gated even though `build.rs` no longer calls
`tauri_build::build()` without the feature; and the `Bridge` trait itself is untouched — `aiproviderd`
still installs `HeadlessBridge`, which discards every dispatch, so the 503 contract is unchanged.

**This row stays, and Phase 1 is why.** What Phase 1 does not do is serve completions. The router core is
still TypeScript in a hidden webview, reached through the `Bridge` trait, and the standalone service has
nothing to bridge to — so it installs a bridge that discards every dispatch and every completion route answers
503. The gateway's availability is still bound to a webview until Phase 2 ports the router core to Rust. The
503 contract mitigates it; it does not solve it.

**The two recall paths differ on exactly one axis, and it reads as a bug.** Gateway recall is scoped and
excludes unscoped atoms; Assistant recall passes `None`. Every atom is born unscoped, so gateway recall returns
nothing until a human binds scope. Measured live corpus: **0 versus 14**. The asymmetry is deliberate and the
drain must not auto-bind — but a user comparing the two screens will reasonably conclude the gateway is broken.

**Docs had drifted behind code in ten measured places.** All ten are closed and tracked in
[07](07-drift-register.md). The durable fix is the register plus the change checklist, not a one-off sweep — and
as of 2026-09-22 one of those classes is checked by the gate rather than by a person. A closed register is not a
clean bill of health, though. Two of its entries are worth reading as warnings:

- **D8** — the *edit* that closed it proved only that a column existed. The producer chain behind that column
  had to be traced separately before the entry could honestly be called fixed.
- **D10** — found on 2026-09-22 while reading the gateway lifecycle to *assess the backlog*, not while looking
  for drift. The register was already closed at the time. That is the argument for keeping it beside the code
  rather than trusting a periodic sweep.

That distinction is the pattern the register exists to make visible.

**Single window, no auto-updater, macOS only.** Windows and Linux are untested; the bundler targets were
narrowed to what is actually built. Updates are manual, by decision — the v1-era updater docs described a
mechanism nobody had built and described it wrongly, so they were deleted rather than fixed.

## How to re-verify this page

```bash
PATH="$HOME/.cargo/bin:$PATH" pnpm ci:local          # the whole gate
sqlite3 "file:$HOME/Library/Application Support/dev.aiprovider.router/ai-provider-router.db?mode=ro" \
  "SELECT MAX(version) FROM schema_version;"          # expect 15
sqlite3 "file:$HOME/Library/Application Support/dev.aiprovider.router/ai-provider-router.db?mode=ro" \
  "SELECT COUNT(*) FROM pragma_table_info('ledger') WHERE name='cached_tokens';"   # expect 1
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings  # expect clean
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin aiproviderd --release --no-default-features
cargo tree  --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features --edges all | grep -ci 'webkit|wry|gtk'  # expect 0
```

Counts in this chapter came from the tree, not from other docs — the documented test counts had drifted twice
before this page existed. If you re-measure and get a different number, **update the number here rather than
assuming the code changed.**
