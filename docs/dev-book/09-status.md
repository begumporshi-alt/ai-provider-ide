# 09 — Status

**As of 2026-09-23**, against `8795cd5`.

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
| Headless service — Phase 1 | Rust split into `core/` (Tauri-independent) and `tauri/`; **`core/` no longer compiles Tauri at all** — `default = ["app"]` with both Tauri crates `optional` and every `tauri` mention behind `#[cfg(feature = "app")]`, so `cargo build --bin aiproviderd --no-default-features` drops `tauri`/`wry`/WebKitGTK from the graph entirely. `aiproviderd` builds and serves `GET /health` → 200 `{"status":"ok"}` on macOS, Windows and Linux. **Does not serve completions** — the router core is still TypeScript in a webview, so every completion route answers 503 by design | `src/bin/aiproviderd.rs`, `src/core/`, `src/tauri/`; [10](10-headless-service.md) §2.1.1; CI job `headless-service`, which now builds with `--no-default-features` and installs no GTK/WebKit |
| Governance | Apache-2.0, changelog, security policy, weekly audit, and a **self-verifying** release workflow — the preflight refuses an unprovisioned build and the artefact is read back and must be notarized | `LICENSE`, `.github/workflows/`, `scripts/release-preflight.sh`, `scripts/verify-release-signature.sh` |
| Doc links | Every relative link and image in every markdown file resolves | `scripts/check-doc-links.mjs`, a gate step |
| Rust lints | `cargo clippy --all-targets -- -D warnings` is clean | 64 → 0 on 2026-09-22; two were real dead branches, not style |
| Rust formatting | `cargo fmt --check` is clean under `apps/desktop/src-tauri/rustfmt.toml` | 354 hunks rewritten once on 2026-09-22, then converged to 0. A stock config would have rewritten 638 |
| Tests | **460** TS unit (18 adapter-spec · 249 router-core · 193 desktop) · **27** end-to-end · **104** browser · **489** Rust | Browser and Rust re-measured 2026-09-23 after 0017 (+6 and +8); TS unit unchanged |
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
artefact **as** `Notarized Developer ID`, and the notarization ticket is stapled. If it fails, the job goes red
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
