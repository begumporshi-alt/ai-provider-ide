# 04 — Data model

The schema is the part of this project that is hardest to change later, because migrations are **forward-only**
and a released database exists on other people's machines.

## Where the database lives

```
~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db
```

The bundle identifier `dev.aiprovider.router` (from `tauri.conf.json`) determines that path, so a rename would
orphan local data. That has happened once already and was accepted rather than migrated — see `DECISIONS.md`,
"R5 accepted: the rename orphans local data".

| File | What it is |
|---|---|
| `ai-provider-router.db` | The database |
| `…-wal`, `…-shm` | Write-ahead log and shared memory — WAL is on, so these always exist |
| `gateway.log` | Gateway log, next to the data rather than in the app bundle |
| `ai-provider-router.db.pre-<version>-<timestamp>.bak` | An observed backup naming convention. **Not enforced in code** — the app offers a restore on startup but nothing in `src-tauri/` or `scripts/` writes this name, so treat it as a convention a human or a session followed |

> **The database is gitignored.** A fresh clone starts empty. That is correct, not a bug.

## Pragmas

Set on open, and asserted by a test rather than assumed:

| Pragma | Value | Why |
|---|---|---|
| `foreign_keys` | `1` | Off by default in SQLite; cascade deletes depend on it |
| `journal_mode` | `wal` | Concurrent reads while the gateway writes ledger rows |

## Tables

28 tables (27 `CREATE TABLE` + the `memories_fts` virtual table), plus `sqlite_sequence` and four FTS shadow
tables (`memories_fts_data`, `_idx`, `_docsize`, `_config`), which is why `sqlite_master` reports 33.

The authoritative list is the array in the `migrations_apply_once_and_are_idempotent` test in `core/store.rs`. **If
you add a table, add it there too** — that assertion is what catches a migration that silently did not run.

| Subsystem | Tables |
|---|---|
| Providers and keys | `providers`, `api_keys`, `manifests` |
| Model catalog | `models_cache`, `model_aliases` |
| Usage | `ledger`, `ledger_rollups` |
| Self-healing | `drift_events`, `onboarding_sessions` (+ `onboarding_sessions_fixed`, the 0019 rebuild), `generator_audit` |
| Gateway | `gateway_keys`, `settings`, `idempotency_keys` |
| Context graph | `context_nodes`, `context_edges` |
| Skills | `skills` |
| Agent loop | `agent_runs`, `agent_steps` |
| Memory | `memories`, `memories_fts` |
| Live session context | `router_sessions`, `session_turns`, `session_state`, `session_titles`, `memory_pending`, `memory_principal_policy`, `router_model_context` |
| Migrations | `schema_version` |

### Two things about specific tables

- **`ledger` has no foreign keys, by design.** Deleting a provider cascades its keys, manifests and catalog
  rows, but ledger history is preserved — spend history that disappears when a provider is removed is worse
  than a dangling reference.
- **`memories_fts` must be asserted.** BM25 recall silently returns nothing if the FTS index was never created,
  which looks identical to "no memories match".

## Migration rules

There are **two lists** and they are numbered as **one sequence**:

```rust
const MIGRATIONS: &[(&str, &str)] = &[ … ];                 // 0001..0006, SQL
const DATA_MIGRATIONS: &[(&str, fn(&Transaction) -> Result<()>)] = &[ … ];  // 0007..0023, Rust
```

A data migration's version is `MIGRATIONS.len() + idx + 1`. The pair is asserted at **23** total
(`store.rs`, `assert_eq!(info.schema_version, 23)`).

**The trap:** appending a new SQL migration to `MIGRATIONS` shifts the version number of **every** data
migration by one. On any database that already applied them, each data migration would then be re-run under a
number it has already passed — or silently skipped. This is why `0010_live_context` was added as a *data*
migration rather than appended to `MIGRATIONS`. See the comment at `core/store.rs:702`.

Checklist for a migration:

1. Add to the correct list, in order.
2. Bump the version expectation in `migrations_apply_once_and_are_idempotent` (`assert_eq!(info.schema_version, N)`).
3. Update `assert_eq!(N, MIGRATIONS.len() + DATA_MIGRATIONS.len())`.
4. Add any new table to the existence array.
5. A rewind test deletes `WHERE version >= N` and re-migrates, to prove it is idempotent.

Migrations run on every app launch and must be safe to re-run.

## Current state of the live database

**The 2026-09-22/23 snapshot below is kept as a lesson, not as current state** — its point was the gap
between "defined in code" and "applied to the live database", which is a gap every reader should know exists.
Code sits at `schema_version` **23** (`0023_idempotency_keys`, added 2026-10-04); the live database on any
given machine is at whatever version its last-launched build applied, and the migration runner closes the gap
on the next launch. That is the mechanism; the story below is why the distinction once mattered:

| | Before the rebuild | After (2026-09-22) |
|---|---|---|
| `schema_version` in the live DB | **14** (`0014_superseded_at`) | **15** (`0015_ledger_cached_tokens`) |
| Migration versions defined in code | **15** | **15** |
| `ledger.cached_tokens` in the live DB | **absent** | **present** — nullable, no default |
| `ledger` rows | 1530 | **1530**, every one `cached_tokens IS NULL` |

The migration had never been applied here, because it landed in the same day's work and the installed bundle had
not been rebuilt since. So the prompt-cache measurement — whose whole purpose is to accumulate `cached_tokens`
across real traffic — could not produce a single row until the app was reinstalled. That was
[07](07-drift-register.md) D8, now closed.

All 1530 rows predate the column, so `NULL` is the correct value for every one of them. **That is not the same
as "the providers reported zero cached tokens"** — see the next section. Closing D8 made the column *writable*;
it did not produce any data. The same trap then recurred with `0016_ledger_app_key` (per-app attribution wrote
nothing until the bundle shipped it), which is why this section states the rule and keeps one example rather
than tracking the current version in prose — for that, read `store.rs`'s assertion, which cannot go stale.

## Identifier rules

**A database-lifetime-unique ID must not come from a per-process counter.** `next_id` restarts at 1 on every
launch, so a counter-based ID collides with an earlier row. IDs carry a **boot marker**.

**Never match a node on its label.** Labels are truncated to 80 characters, so two different nodes can share
one. Pass the identity a thing already has.

## Nullable means "not reported", and that is the point

The `cached_tokens` column is **nullable with no default, on purpose**. `NULL` means the provider reported no
cache block at all; `0` means it reported caching and the value was zero. Those are different findings, and
telling them apart is the entire reason the column exists.

Had it been `NOT NULL DEFAULT 0`, every provider would look like a provider that caches nothing — and the
question "would sending `cache_control` help?" could not be answered in **either** direction. That is a
measurement that cannot falsify itself, which is worse than no measurement.

The general rule: **when adding a column whose absence is informative, make it nullable and add no default.**

## Memory scoping and supersession

Two behaviours that surprise people, both deliberate.

- **Every memory atom is born unscoped.** `capture`'s INSERT does not set the scope columns; `assign_scope` is
  the only way in. A human must bind scope. The capture drain must **not** auto-bind — there is a test that
  fails if it does.
- **Scoped recall excludes unscoped atoms**, which is why the gateway path returns nothing until a human binds
  scope. This is the single axis on which the gateway and Assistant recall paths differ. Measured live corpus
  when this was written: 0 versus 14.
- **`superseded_at`** (migration 0014) is excluded from `recall_inner`, `session_atoms` and `stats.injectable`,
  but **not** from `list` — superseded rows stay visible so they can be un-superseded. Superseding a pinned or
  L3 row is refused.

## Retention

Three schedulers, over different tables — knowing which is which explains most "when does X get deleted"
questions:

1. **`persist::retention_job`** (Rust; boot + every 24 h, in both the app and the `aiproviderd` daemon) —
   monthly ledger rollups, raw-ledger deletion past 90 days (only after rollup), agent-run aging (finished
   >30 d deleted; `running` >7 d deleted, because a status we did not observe is unknown), and the idempotency
   prune. Until 2026-10-04 this job existed but nothing called it in the daemon, which is exactly the defect
   the daemon wiring closed.
2. **`core/retention.rs`** (Rust; every 30 min per core, 5 s pass budget, 500-row chunks, single-flight) —
   memory and live-context prunes, plus the drift evaluation. Runs only while a core is alive, and only one
   scheduler per core no matter how many times the gateway is re-enabled.
3. **The webview timer** (`src/lib/memory/retention.ts`, started in `App.tsx` so no single screen owns it) —
   a bounded belt-and-braces pass when the desktop UI is open; the daemon has no webview, which is why (1)
   and (2) live in Rust.

Both the capture queue and the memory tables are filled by **gateway** traffic, not by the app's own chat
(the Assistant sends `AIP-Memory: off`).

## Next

[05 Workflow](05-workflow.md) — the gate that proves a change to any of this is safe.
