# 09 — Status

**As of 2026-09-22**, against `e4edece`.

> **This is the one chapter expected to age quickly, and the only one where staleness is normal.** Every other
> chapter states a rule that changes only when someone decides to change it. This one states where the work
> stands. **When you finish an item, move it — do not leave it here looking current.** The dated evidence trail
> lives in [`../PRODUCT_COMPLETION_PLAN.md`](../PRODUCT_COMPLETION_PLAN.md); this is the live snapshot.

## Working and verified

Each of these has a test, a gate step, or a measurement behind it — not just a merged commit.

| Area | State | Evidence |
|---|---|---|
| Gateway ingress | 4 dialects, SSE streaming, 7 routes | `gateway.rs:1755-1761` |
| Rotation and failover | Per-key cooldowns, circuit breakers, 6-attempt bound | `gateway_tests.rs`, [08](08-flows.md) |
| Capacity control | 8 in flight, 32 queued, `429` on overflow | `MAX_CONCURRENT` / `MAX_QUEUED`, `gateway.rs:39-41` |
| Adapter tiers | Builtin templates, manifest interpreter, QuickJS sandbox | `router-core`, Tier-2 review screen |
| Onboarding | Deterministic fingerprint path, AI fallback, contract-gated | `onboarding-e2e.test.ts` |
| Drift and repair | Detection window, patch flow, versioned rollback | `drift-repair-e2e.test.ts` |
| Secrets | Keychain-only, key-blind TypeScript, one-shot reveal | Invariants 1–2, `key-leak-grep` in CI |
| Memory | Scoped recall, capture queue, retention, supersession | Migration 0014, `memory.spec.ts` |
| Agent loop | Sandboxed tools, visible step trail | `agent-turn.spec.ts`, `tools.rs` |
| Gateway keys | Per-app keys, monthly spend cap | `commands.rs:713-718`, `gateway_keys` table |
| Ledger | Tokens, cost, latency, error class, prompt-cache `cached_tokens` | Migration 0015, applied 2026-09-22 — 17 columns, 1530 rows preserved, all `NULL` by design |
| Schema | 15 versions, count asserted, rewind-tested | `store.rs:943-946` |
| Governance | Apache-2.0, changelog, security policy, release workflow, weekly audit | `LICENSE`, `.github/workflows/` |
| Doc links | Every relative link and image in every markdown file resolves | `scripts/check-doc-links.mjs`, a gate step |
| Rust lints | `cargo clippy --all-targets -- -D warnings` is clean | 64 → 0 on 2026-09-22; two were real dead branches, not style |
| Rust formatting | `cargo fmt --check` is clean under `apps/desktop/src-tauri/rustfmt.toml` | 354 hunks rewritten once on 2026-09-22, then converged to 0. A stock config would have rewritten 638 |
| Tests | **433** TS unit (18 adapter-spec · 249 router-core · 166 desktop) · **27** end-to-end · **98** browser · **473** Rust | all four re-measured 2026-09-22; the `~425` / `87` this row used to carry were stale |
| Coverage | **43.8%** statements · 37.3% branches · 31.1% functions · 45.4% lines, weighted across the three packages | `pnpm test:coverage`; a report, **not** a gate step — [`../PRODUCT_COMPLETION_PLAN.md`](../PRODUCT_COMPLETION_PLAN.md) §4.2 |

## Gaps

Real absences, with the reason each one is absent.

| Gap | Why it is not closed |
|---|---|
| **No notarized release** | `release.yml` builds a draft, but without the Apple secrets it is ad-hoc signed — fine locally, not fine for a download |
| **No per-app budgets** | The spend cap is global and monthly — one `month_micros` against one `cap_micros`. Per-app keys exist; per-app *limits* do not — and, measured 2026-09-23, no per-app *attribution* either, so a budget would have nothing to sum |

**"No per-app budgets" understates itself.** Measured against the live database, the cap is not the first
missing piece — attribution is. Two different columns are called `key_id`: `ledger.key_id` is the *provider*
credential (`api_keys.id`), which **713 of 792** gateway rows join, while the gateway's own app key
(`gateway_keys.id`) is joined by **0** rows and is held by no column at all. A budget therefore has nothing to
sum. The work is three parts, and only the last is the one the row implies: a migration adding the app key to
the ledger **and the TypeScript router passing it** — a column alone proves nothing, which is this project's
own rule — then a cap column on `gateway_keys`, then enforcement, which changes `SpendProvider`'s signature.
It is `Arc<dyn Fn() -> (i64, i64)>`, **zero arguments**, so the gate cannot tell callers apart today.

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
detached from any window *and* from the app process — is an explicit v2 extension point. Until it exists this
is a desktop app that serves HTTP, not a service. This is the project's main structural risk, and it is
mitigated by the 503 contract rather than solved.

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
```

Counts in this chapter came from the tree, not from other docs — the documented test counts had drifted twice
before this page existed. If you re-measure and get a different number, **update the number here rather than
assuming the code changed.**
