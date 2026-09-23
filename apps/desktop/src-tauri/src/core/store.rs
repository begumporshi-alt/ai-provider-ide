//! sql-store (L0): SQLite access + THE single migration runner (§4). Direct rusqlite rather
//! than tauri-plugin-sql so the ordered NNNN_name.sql runner, integrity checks, and the
//! WAL/pragma init live in one audited place (DECISIONS.md 2026-09-15).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("migration {0} failed: {1}")]
    Migration(String, String),
}

/// Ordered migrations. Forward-only; never edit an applied migration (§4).
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_schema_v1_1",
        r#"
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  type              TEXT,
  base_url          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending','enabled','disabled','repairing')),
  rotation_strategy TEXT NOT NULL DEFAULT 'round_robin'
                    CHECK (rotation_strategy IN ('round_robin','lru','priority','cost_spread')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  secret_ref     TEXT NOT NULL,
  secret_hint    TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','cooldown','invalid','disabled')),
  priority       INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
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
  context_window    INTEGER,
  capabilities_json TEXT,
  pricing_json      TEXT,
  fetched_at        INTEGER NOT NULL,
  raw_json          TEXT,
  UNIQUE (provider_id, native_id)
);
CREATE INDEX idx_models_provider_modality ON models_cache(provider_id, modality);

CREATE TABLE model_aliases (
  alias           TEXT NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  native_model_id TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (alias, provider_id)
);
CREATE INDEX idx_aliases_alias ON model_aliases(alias);

CREATE TABLE ledger (
  id                INTEGER PRIMARY KEY,
  ts                INTEGER NOT NULL,
  modality          TEXT NOT NULL CHECK (modality IN ('text','image')),
  source            TEXT NOT NULL DEFAULT 'ui'
                    CHECK (source IN ('ui','gateway','generator')),
  provider_id       TEXT,
  key_id            TEXT,
  requested_model   TEXT,
  model             TEXT NOT NULL,
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
CREATE INDEX idx_ledger_drift ON ledger(provider_id, ts)
  WHERE error_class IN ('NOT_FOUND','BAD_REQUEST_SCHEMA','PARSE_ERROR','AUTH_FAILED');

CREATE TABLE ledger_rollups (
  month              TEXT NOT NULL,
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
  updated_at                 INTEGER NOT NULL,
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
"#,
    ),
    (
        // 0002 — audit R4. Per-app gateway keys: one revocable credential per consuming app, so a
        // leaked or retired client can be cut off WITHOUT rotating the master key (which would
        // break every other app). Metadata + revocation live here; the secret lives in the OS
        // keychain under `gwkey:<id>` and is shown once, never persisted.
        "0002_gateway_keys",
        r#"
CREATE TABLE gateway_keys (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_gateway_keys_active ON gateway_keys(revoked_at);
"#,
    ),
    (
        "0003_context_graph",
        r#"
CREATE TABLE context_nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('artifact','memory','skill','message')),
  label      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('ui','gateway','engine')),
  session_id TEXT,
  ts         INTEGER NOT NULL,
  meta_json  TEXT
);
CREATE INDEX idx_context_nodes_kind ON context_nodes(kind);
CREATE INDEX idx_context_nodes_ts ON context_nodes(ts);
CREATE INDEX idx_context_nodes_session ON context_nodes(session_id);

CREATE TABLE context_edges (
  id        TEXT PRIMARY KEY,
  from_id   TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  to_id     TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('produced','used','recalled','follows','references','routes_to','served_by','aliases','backed_by')),
  weight    REAL NOT NULL DEFAULT 1,
  ts        INTEGER NOT NULL,
  meta_json TEXT
);
CREATE INDEX idx_context_edges_from ON context_edges(from_id);
CREATE INDEX idx_context_edges_to ON context_edges(to_id);
-- One edge of a given kind between the same pair. Re-recording bumps weight instead of
-- duplicating, so a repeated relation reads as a stronger one rather than as more clutter.
CREATE UNIQUE INDEX uq_context_edges ON context_edges(from_id, to_id, kind);
"#,
    ),
    (
        "0004_skills",
        r#"
CREATE TABLE skills (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '0.1.0',
  source       TEXT NOT NULL CHECK (source IN ('builtin','user')),
  body         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  installed_at INTEGER NOT NULL
);
CREATE INDEX idx_skills_enabled ON skills(enabled);
"#,
    ),
    (
        "0005_agent_runs",
        r#"
CREATE TABLE agent_runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','error','stopped')),
  prompt      TEXT,
  iterations  INTEGER NOT NULL DEFAULT 0,
  tool_calls  INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  error       TEXT
);
CREATE INDEX idx_agent_runs_started ON agent_runs(started_at DESC);

CREATE TABLE agent_steps (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('assistant','tool_call','tool_result','done','denied')),
  label   TEXT,
  detail  TEXT,
  ok      INTEGER,
  ts      INTEGER NOT NULL
);
CREATE INDEX idx_agent_steps_run ON agent_steps(run_id, seq);
CREATE UNIQUE INDEX uq_agent_steps_seq ON agent_steps(run_id, seq);
"#,
    ),
    (
        "0006_memories",
        r#"
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  layer       TEXT NOT NULL CHECK (layer IN ('L0','L1','L2','L3')),
  text        TEXT NOT NULL,
  session_id  TEXT,
  subject     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1))
);
CREATE INDEX idx_memories_layer ON memories(layer, updated_at DESC);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX idx_memories_session ON memories(session_id);

-- BM25 recall. External-content FTS5 keeps one copy of the text: the triggers below are the
-- only thing that keeps the index honest, so any future write path must go through them.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
"#,
    ),
];

/// Backfills that need real logic — grouping, weight merging, FK-safe re-keying — and so cannot be
/// expressed as one SQL batch.
///
/// Ordered *after* every entry in `MIGRATIONS`, so a step here takes the version
/// `MIGRATIONS.len() + idx + 1`. Keeping the two lists separate rather than interleaved means the
/// A data migration: the name it is keyed by, and the function that applies it.
///
/// Factored out of `DATA_MIGRATIONS` — inline, this is a three-deep generic that no reader parses
/// at a glance (clippy::type_complexity).
type DataMigration = (&'static str, fn(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>);

/// SQL list stays a literal list of schemas; the numbering is the only coupling, and it is
/// asserted by `migrations_apply_once_and_are_idempotent`.
const DATA_MIGRATIONS: &[DataMigration] = &[
    ("0007_stable_memory_node_ids", backfill_stable_memory_node_ids),
    ("0008_ledger_error_class", backfill_ledger_error_class),
    ("0009_memory_scope", backfill_memory_scope),
    ("0010_live_context", backfill_live_context),
    ("0011_capture_queue", backfill_capture_queue),
    ("0012_principal_policy", backfill_principal_policy),
    ("0013_model_context", backfill_model_context),
    ("0014_superseded_at", backfill_superseded_at),
    ("0015_ledger_cached_tokens", backfill_ledger_cached_tokens),
    ("0016_ledger_app_key", backfill_ledger_app_key),
    ("0017_gateway_key_cap", backfill_gateway_key_cap),
];

/// One legacy graph node, paired with the stable id it should have carried.
struct LegacyNode {
    old_id: String,
    new_id: String,
    label: String,
    source: String,
    session_id: Option<String>,
    ts: i64,
    meta_json: Option<String>,
}

/// Re-key memory graph nodes written before the stable-id fix.
///
/// Every recording path used to mint a fresh sequence id (`memory:<session>:<n>`), so a single
/// memory could appear as several nodes and the host's edge-weight accumulator
/// (`weight = MIN(weight + excluded.weight, 50)`) never fired — every `recalled` edge stayed at
/// weight 1. Deriving the node id from the memory id fixed new writes, but it cannot heal the old
/// ones: they keep the old shape forever and the same fact reappears under the new shape.
///
/// Each node's own `meta_json` carried `memoryId`, so the intended key is *recoverable exactly*
/// rather than guessed. Matching on the label instead would be wrong twice over: it is truncated
/// to 80 characters, and two distinct memories may share a label.
fn backfill_stable_memory_node_ids(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    let legacy = load_legacy_memory_nodes(tx)?;
    if legacy.is_empty() {
        return Ok(());
    }

    // One surviving node per stable id, dated from the first time we saw the memory. The earliest
    // sighting is the honest one: the later rows are duplicates, not later facts.
    let mut reps: BTreeMap<&str, &LegacyNode> = BTreeMap::new();
    for n in &legacy {
        match reps.get(n.new_id.as_str()) {
            Some(prev) if prev.ts <= n.ts => {}
            _ => {
                reps.insert(n.new_id.as_str(), n);
            }
        }
    }

    {
        let mut ins = tx.prepare(
            "INSERT OR IGNORE INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
             VALUES (?1,'memory',?2,?3,?4,?5,?6)",
        )?;
        for n in reps.values() {
            ins.execute(rusqlite::params![
                n.new_id,
                n.label,
                n.source,
                n.session_id,
                n.ts,
                n.meta_json
            ])?;
        }
    }

    // Collapse the legacy edges onto the stable targets, summing weight the same way the host
    // does: a relation recorded five times should read as a strong one, not as five of them.
    let mut merged: BTreeMap<(String, String, String), (f64, i64)> = BTreeMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT e.from_id,
                    'memory:' || json_extract(n.meta_json,'$.memoryId') AS new_to,
                    e.kind, e.weight, e.ts
               FROM context_edges e
               JOIN context_nodes n ON n.id = e.to_id
               JOIN memories m ON m.id = json_extract(n.meta_json,'$.memoryId')
              WHERE n.kind = 'memory'
                AND n.id <> 'memory:' || json_extract(n.meta_json,'$.memoryId')",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (from, to, kind, weight, ts) = row?;
            let slot = merged.entry((from, to, kind)).or_insert((0.0, ts));
            slot.0 += weight;
            slot.1 = slot.1.min(ts);
        }
    }

    // Drop the legacy edges *before* re-creating them. Otherwise a target that already has an
    // edge of the same kind would be updated and then inserted, double-counting the weight.
    tx.execute(
        "DELETE FROM context_edges
          WHERE to_id IN (SELECT n.id FROM context_nodes n
                           JOIN memories m ON m.id = json_extract(n.meta_json,'$.memoryId')
                          WHERE n.kind = 'memory'
                            AND n.id <> 'memory:' || json_extract(n.meta_json,'$.memoryId'))",
        [],
    )?;

    {
        let mut upd = tx.prepare(
            "UPDATE context_edges SET weight = MIN(weight + ?4, 50)
              WHERE from_id = ?1 AND to_id = ?2 AND kind = ?3",
        )?;
        let mut ins = tx.prepare(
            "INSERT INTO context_edges (id, from_id, to_id, kind, weight, ts, meta_json)
             VALUES ('e:' || ?1 || '->' || ?2 || ':' || ?3, ?1, ?2, ?3, ?4, ?5, NULL)",
        )?;
        for ((from, to, kind), (weight, ts)) in &merged {
            // `MIN(..., 50)` matches the host's ceiling, so a merged edge cannot exceed what a
            // freshly accumulated one could reach.
            let weight = weight.min(50.0);
            if upd.execute(rusqlite::params![from, to, kind, weight])? == 0 {
                ins.execute(rusqlite::params![from, to, kind, weight, ts])?;
            }
        }
    }

    // Only now are the legacy nodes unreferenced, so the FK has nothing left to cascade.
    {
        let mut del = tx.prepare("DELETE FROM context_nodes WHERE id = ?1")?;
        for n in &legacy {
            del.execute(rusqlite::params![n.old_id])?;
        }
    }
    Ok(())
}

/// Every memory node whose id is not the stable `memory:<memoryId>` it should be, resolved through
/// `meta_json`. A node whose memory no longer exists is deliberately *not* returned: there is no
/// correct stable id to give it, and inventing one would be worse than leaving the row alone.
fn load_legacy_memory_nodes(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<Vec<LegacyNode>> {
    let mut stmt = tx.prepare(
        "SELECT n.id,
                'memory:' || json_extract(n.meta_json,'$.memoryId') AS new_id,
                n.label, n.source, n.session_id, n.ts, n.meta_json
           FROM context_nodes n
           JOIN memories m ON m.id = json_extract(n.meta_json,'$.memoryId')
          WHERE n.kind = 'memory'
            AND n.id <> 'memory:' || json_extract(n.meta_json,'$.memoryId')",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(LegacyNode {
            old_id: r.get(0)?,
            new_id: r.get(1)?,
            label: r.get(2)?,
            source: r.get(3)?,
            session_id: r.get(4)?,
            ts: r.get(5)?,
            meta_json: r.get(6)?,
        })
    })?;
    rows.collect()
}

#[derive(Serialize)]
pub struct StoreInfo {
    pub path: String,
    pub schema_version: i64,
}

pub struct Store {
    pub conn: Mutex<Connection>,
    pub(crate) path: String,
}

impl Store {
    /// Open (or create) the DB in the app data dir with the §4 hygiene pragmas.
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("ai-provider-router.db");
        let conn = Connection::open(&path)?;
        // foreign_keys OFF by default in SQLite — without this every FK is decorative (§4).
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        let s = Self { conn: Mutex::new(conn), path: path.display().to_string() };
        s.migrate()?;
        s.integrity_check()?;
        Ok(s)
    }

    /// The single migration runner: apply ordered migrations inside transactions,
    /// recording history in schema_version.
    ///
    /// SQL migrations are numbered 1..N by their position, and data migrations continue from
    /// there. Each step commits in its own transaction, so a failure part-way leaves the earlier
    /// steps applied and recorded — resuming re-runs only what is missing.
    pub fn migrate(&self) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        // Bootstrap table first: it records history, so it must exist before any migration.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
        )?;
        let current: i64 = conn
            .query_row("SELECT COALESCE(MAX(version),0) FROM schema_version", [], |r| r.get(0))
            .unwrap_or(0);

        let mut version = 0i64;
        for (name, sql) in MIGRATIONS.iter() {
            version += 1;
            if version <= current {
                continue;
            }
            let tx = conn
                .transaction()
                .map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
            let applied: Result<(), rusqlite::Error> = (|| {
                tx.execute_batch(sql)?;
                record_migration(&tx, version, name)?;
                Ok(())
            })();
            applied.map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
            tx.commit().map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
        }

        for (name, run) in DATA_MIGRATIONS.iter() {
            version += 1;
            if version <= current {
                continue;
            }
            let tx = conn
                .transaction()
                .map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
            let applied: Result<(), rusqlite::Error> = (|| {
                run(&tx)?;
                record_migration(&tx, version, name)?;
                Ok(())
            })();
            applied.map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
            tx.commit().map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
        }
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(StoreError::Migration(
                "integrity_check".into(),
                format!("database corrupt: {ok} — restore from backup offered at startup (§4)"),
            ));
        }
        Ok(())
    }

    pub fn info(&self) -> Result<StoreInfo, StoreError> {
        let conn = self.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("SELECT COALESCE(MAX(version),0) FROM schema_version", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(StoreInfo { path: self.path.clone(), schema_version: version })
    }
}

/// Record an applied step. Lives beside the runner so both migration kinds are stamped identically.
fn record_migration(
    tx: &rusqlite::Transaction<'_>,
    version: i64,
    name: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)",
        rusqlite::params![version, name, chrono_now_ms()],
    )?;
    Ok(())
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Recover the error class of ledger rows written before the failure path recorded it.
///
/// `wrapLedger`'s catch wrote the literal `NO_ROUTE` for *every* failure, while storing the real
/// class in `fallback_chain_json` on the same row — so a row contradicted itself: the status column
/// read "no route" beside a chain naming a provider, a key and `BAD_REQUEST_SCHEMA`. The writer is
/// fixed, but these rows keep the wrong string forever unless they are repaired.
///
/// The intended value is *recoverable exactly*, not guessed: the last chain entry is the attempt
/// that decided the outcome — the same entry `wrapLedger` reads — and its `cls` is the class. Two
/// things are deliberately left alone:
///
///   - Rows whose chain is empty. `NO_ROUTE` is what that means, so they are already correct.
///   - `http_status`. The chain never carried it, so it stays NULL rather than being invented.
///
/// Parsed in Rust rather than with `json_extract` so a single unparsable row is skipped instead of
/// aborting the migration: a failed migration fails `Store::open`, which is app startup.
fn backfill_ledger_error_class(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    let mut recovered: Vec<(String, i64)> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, fallback_chain_json FROM ledger
              WHERE error_class = 'NO_ROUTE' AND fallback_chain_json IS NOT NULL",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let raw: String = row.get(1)?;
            let Ok(chain) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
                continue;
            };
            let Some(cls) = chain.last().and_then(|a| a.get("cls")).and_then(|c| c.as_str()) else {
                continue;
            };
            // A chain whose own last entry says NO_ROUTE agrees with the column; leave it.
            if cls.is_empty() || cls == "NO_ROUTE" {
                continue;
            }
            recovered.push((cls.to_string(), id));
        }
    }
    if recovered.is_empty() {
        return Ok(());
    }
    let mut upd = tx.prepare("UPDATE ledger SET error_class = ?1 WHERE id = ?2")?;
    for (cls, id) in &recovered {
        upd.execute(rusqlite::params![cls, id])?;
    }
    Ok(())
}

/// 0009: scope dimensions on `memories`, for the gateway memory/context layer.
///
/// `user x project x agent`, plus an explicit `scope_global` flag. **Absence is not global** — three
/// independent reviewers of the design flagged nullable-means-global as a contamination engine,
/// because the header-less IDE is the common case and would otherwise degrade to "global" and leak
/// one repo's context into another. A row is injectable only via an explicit project match or an
/// explicit global mark.
///
/// Every query in `memory.rs` names its columns, so widening the table cannot shift a row's shape
/// under a reader. The FTS5 index declares only `text` and is external-content, so it is unaffected;
/// its three triggers remain the only thing keeping it honest.
///
/// Existing rows land at `scope_project = NULL, scope_global = 0` — i.e. **not injectable**. That is
/// deliberate: they were captured by the Assistant with no project context, and silently promoting
/// them to global is exactly the leak this schema exists to prevent.
fn backfill_memory_scope(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    for (column, ddl) in [
        ("scope_user", "ALTER TABLE memories ADD COLUMN scope_user TEXT NOT NULL DEFAULT 'local'"),
        ("scope_project", "ALTER TABLE memories ADD COLUMN scope_project TEXT"),
        ("scope_agent", "ALTER TABLE memories ADD COLUMN scope_agent TEXT"),
        ("scope_global", "ALTER TABLE memories ADD COLUMN scope_global INTEGER NOT NULL DEFAULT 0 CHECK (scope_global IN (0,1))"),
    ] {
        if !table_has_column(tx, "memories", column)? {
            tx.execute_batch(ddl)?;
        }
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_memories_scope
           ON memories(scope_user, scope_project, scope_agent, updated_at DESC);",
    )
}

/// Live context: sessions, a bounded ring of turns per session, and the state an agent pushes
/// (open files, current plan). Design §3.2.
///
/// Deliberately **not** `context_nodes`: that table is the Context screen's display graph — closed
/// four-kind node set, no scoping, no retention — and pushing verbatim agent turns into it would
/// destroy both the screen and its `graph(limit)` window.
///
/// A data migration, not a schema migration, because appending to `MIGRATIONS` would shift every
/// data-migration version: those are numbered `MIGRATIONS.len() + idx + 1`.
fn backfill_live_context(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS router_sessions (
           id            TEXT PRIMARY KEY,
           scope_user    TEXT NOT NULL DEFAULT 'local',
           scope_project TEXT,
           scope_agent   TEXT,
           title         TEXT,
           turn_count    INTEGER NOT NULL DEFAULT 0,
           created_at    INTEGER NOT NULL,
           last_seen_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_router_sessions_seen
           ON router_sessions(last_seen_at DESC);

         -- Bounded ring per session. Pruned by count and by age; never grows without limit.
         CREATE TABLE IF NOT EXISTS session_turns (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           session_id TEXT NOT NULL REFERENCES router_sessions(id) ON DELETE CASCADE,
           seq        INTEGER NOT NULL,
           role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
           text       TEXT NOT NULL,
           ts         INTEGER NOT NULL,
           UNIQUE (session_id, seq)
         );
         CREATE INDEX IF NOT EXISTS idx_session_turns
           ON session_turns(session_id, seq DESC);

         -- Live context the agent pushes: open files, cursor position, current plan.
         CREATE TABLE IF NOT EXISTS session_state (
           session_id TEXT PRIMARY KEY REFERENCES router_sessions(id) ON DELETE CASCADE,
           open_files TEXT,
           extra_json TEXT,
           updated_at INTEGER NOT NULL
         );",
    )
}

/// Async capture queue (design §3.3), extended for the §3.5 rules.
///
/// `request_id` is UNIQUE so distillation is idempotent (§3.5.5) — a replay hits the constraint
/// instead of producing a second row. `content_class` and the three scope columns are written once
/// at enqueue and never updated, so a turn distilled after its project changed cannot be re-scoped
/// (§3.5.4).
///
/// There is deliberately **no** principal column: an internal turn is never enqueued at all
/// (§3.5.6), so there is nothing to record.
fn backfill_capture_queue(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_pending (
           id            INTEGER PRIMARY KEY AUTOINCREMENT,
           request_id    TEXT NOT NULL UNIQUE,
           session_id    TEXT,
           scope_user    TEXT NOT NULL DEFAULT 'local',
           scope_project TEXT,
           scope_agent   TEXT,
           content_class TEXT NOT NULL DEFAULT 'fact'
                           CHECK (content_class IN ('fact','preference','decision','instruction')),
           user_text     TEXT NOT NULL,
           asst_text     TEXT,
           model         TEXT,
           status        TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','processing','done','failed')),
           attempts      INTEGER NOT NULL DEFAULT 0,
           created_at    INTEGER NOT NULL,
           claimed_at    INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_memory_pending ON memory_pending(status, id);",
    )
}

/// Per-principal memory policy (§4a). One row per agent identity, and **no row means "inherit the
/// master switch"** — not "allowed". A default-deny table would need a row for every IDE that has
/// ever connected before memory worked for anyone, which is the same absence-as-a-decision trap the
/// scope columns were designed to avoid.
///
/// Precedence is operator over client: a client's `AIP-Memory: on` cannot switch on what the
/// operator switched off here, and the master switch still gates everything.
fn backfill_principal_policy(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_principal_policy (
           principal  TEXT PRIMARY KEY,
           enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
           updated_at INTEGER NOT NULL
         );",
    )
}

/// Per-model context-window cache (design §3.4). Rust cannot see the TS catalog — it lives in the
/// webview, with provider selection and key handling — so the webview publishes the one number the
/// request path needs and the host reads it here.
///
/// Rows are upserted per provider, never bulk-replaced: a refresh of one provider must not drop
/// another's. `chars_per_token` is nullable and stays so — a model with no measured ratio uses the
/// conservative default estimator rather than a stored guess.
fn backfill_model_context(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS router_model_context (
           model_key       TEXT PRIMARY KEY,
           context_window  INTEGER NOT NULL CHECK (context_window > 0),
           chars_per_token REAL,
           updated_at      INTEGER NOT NULL
         );",
    )
}

/// §6.4.3: a superseded row keeps its record rather than being deleted, so a reversal is
/// recoverable and the Context graph's edges stay valid. `NULL` means live.
fn backfill_superseded_at(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    if !table_has_column(tx, "memories", "superseded_at")? {
        tx.execute_batch("ALTER TABLE memories ADD COLUMN superseded_at INTEGER;")?;
    }
    Ok(())
}

/// 0015 — prompt caching was a cost question with no evidence behind it. Nothing recorded whether
/// an upstream served any part of a prompt from its own cache, so "add `cache_control`" could not
/// be tested in either direction: the ledger showed the *shape* of the problem (agnes-2.5-flash:
/// 648 requests, ~35.9M input tokens against ~213K output) but never whether the provider had
/// already been caching and we simply were not asking for it.
///
/// **Nullable on purpose.** The column exists to answer *"does this provider report caching at
/// all?"*, and `NOT NULL DEFAULT 0` would make "never reports it" indistinguishable from "reports
/// zero" — collapsing the one distinction the measurement exists to draw. `NULL` = not reported.
fn backfill_ledger_cached_tokens(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    if !table_has_column(tx, "ledger", "cached_tokens")? {
        tx.execute_batch("ALTER TABLE ledger ADD COLUMN cached_tokens INTEGER;")?;
    }
    Ok(())
}

/// 0016 — per-app attribution. A per-app budget cannot be summed from anything the ledger held.
///
/// The monthly cap is global on purpose (`month_spend_micros`: "the user sets a budget on what they
/// pay, not on one client"), so this is a different axis rather than a narrowing of that one. But
/// the gateway's own app key — `gateway_keys.id` — was held by **no column at all**: measured
/// 2026-09-23, 713 of 792 gateway rows join `api_keys` through `key_id`, and **zero** join
/// `gateway_keys`. `key_id` is the *provider* credential, so a per-app figure had nothing to sum.
///
/// **Nullable, and that is the design.** Only `source='gateway'` rows carry an app key: `ui` and
/// `generator` rows are not attributable to one, and the rows written before this migration cannot
/// be backfilled because nothing recorded the key at the time. `NULL` therefore means "not
/// attributable to an app", which is the honest value — a `NOT NULL DEFAULT ''` would invent a key
/// that no row actually used, and would read as a real one in every later SUM.
///
/// The column is named `app_key_id` rather than a second `key_id` deliberately: the two columns
/// this table would otherwise have called `key_id` mean different things, which is what made the
/// gap hard to see in the first place.
///
/// **No index here, on purpose.** The per-app SUM that will need one on `(app_key_id, ts)` — the
/// same shape as the existing `idx_ledger_provider_ts` — does not exist yet, and a column with no
/// consumer should not arrive with an index for a query nobody has written. The enforcement change
/// adds it, and this note is here so that step does not have to rediscover why.
fn backfill_ledger_app_key(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    if !table_has_column(tx, "ledger", "app_key_id")? {
        tx.execute_batch("ALTER TABLE ledger ADD COLUMN app_key_id TEXT;")?;
    }
    Ok(())
}

/// 0017 — the cap itself, plus the index the enforcement query needs.
///
/// 0016 recorded *who* paid. This records *how much they are allowed to*, which is the half the
/// global cap could not express: `settings.spend.capMicrosPerMonth` compares one `month_micros`
/// against one `cap_micros`, so a runaway consumer could spend the owner's whole budget while
/// every other app sat idle. A cap on the key is the narrow instrument that was missing.
///
/// **Nullable, and `NULL` is the only representation of "no cap".** `gateway_key_cap_set`
/// normalizes `<= 0` to `NULL` rather than storing a zero, so the column never carries two
/// spellings of the same state — the defect that makes a later SUM ambiguous. (The global cap
/// collapses `<= 0` at *read* time instead, because its value lives in a JSON blob where a legacy
/// `0` may already exist; a new column has no such history to honour.)
///
/// **The index belongs here, not in 0016, and 0016 says so** — it declined to ship a column with
/// an index for a query nobody had written. This is that query: `SUM(cost_estimate_micros) WHERE
/// app_key_id = ? AND ts >= <month start>`, which is the same shape as the existing
/// `idx_ledger_provider_ts` and would otherwise be a full scan on every gateway request.
///
/// The `CREATE INDEX` is deliberately unguarded. `app_key_id` is guaranteed to exist by now:
/// 0016 precedes this step in the same pass, and any database already past 0016 got the column on
/// the launch that applied it. If it somehow does not exist, failing loudly is right — a silent
/// skip would leave the gate doing full scans with no symptom to notice.
fn backfill_gateway_key_cap(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    if !table_has_column(tx, "gateway_keys", "cap_micros")? {
        tx.execute_batch("ALTER TABLE gateway_keys ADD COLUMN cap_micros INTEGER;")?;
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_ledger_app_key_ts ON ledger(app_key_id, ts);",
    )?;
    Ok(())
}

/// Guarded so the migration can be re-run against a table that already carries the column — an
/// `ALTER TABLE ADD COLUMN` for an existing column is an error, and a failed migration fails
/// `Store::open`, which is app startup.
fn table_has_column(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    column: &str,
) -> rusqlite::Result<bool> {
    let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<Vec<_>, _>>()?;
    Ok(names.iter().any(|n| n == column))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 0009 exists so the gateway memory layer can filter by scope. The important half is the
    /// default: a row written with no scope is **not** injectable, because absence is not global.
    #[test]
    fn memory_rows_carry_scope_and_default_to_not_injectable() {
        let dir = std::env::temp_dir().join(format!("aip-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");
        let conn = s.conn.lock().unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(memories)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for c in ["scope_user", "scope_project", "scope_agent", "scope_global"] {
            assert!(cols.iter().any(|x| x == c), "memories is missing {c}");
        }

        conn.execute(
            "INSERT INTO memories (id, layer, text, created_at, updated_at)
             VALUES ('m1','L1','an old assistant atom',1,1)",
            [],
        )
        .unwrap();
        let (project, global): (Option<String>, i64) = conn
            .query_row("SELECT scope_project, scope_global FROM memories WHERE id='m1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(project, None, "no project means unresolved, not global");
        assert_eq!(global, 0, "and unresolved is not injectable");
    }

    /// The ring has to be enforced by the schema, not by a caller remembering to prune: a turn
    /// table that grows without limit is the failure this design explicitly guards against.
    #[test]
    fn live_context_tables_exist_and_a_session_turn_ring_is_bounded() {
        let dir = std::env::temp_dir().join(format!("aip-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");
        let conn = s.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO router_sessions (id, scope_user, scope_project, created_at, last_seen_at)
             VALUES ('s1','local','p1',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_turns (session_id, seq, role, text, ts) VALUES ('s1',1,'user','hi',1)",
            [],
        )
        .unwrap();
        // The same (session_id, seq) twice is a replay; the UNIQUE constraint is what makes
        // recording idempotent rather than duplicating a turn on a retry.
        assert!(
            conn.execute(
                "INSERT INTO session_turns (session_id, seq, role, text, ts) VALUES ('s1',1,'user','hi',1)",
                [],
            )
            .is_err(),
            "a repeated (session_id, seq) is rejected"
        );
        assert!(
            conn.execute(
                "INSERT INTO session_turns (session_id, seq, role, text, ts) VALUES ('nope',1,'user','hi',1)",
                [],
            )
            .is_err(),
            "a turn cannot outlive its session"
        );
        conn.execute(
            "INSERT INTO session_state (session_id, open_files, updated_at) VALUES ('s1','[]',1)",
            [],
        )
        .unwrap();

        // Re-migrating must not fail: app startup runs this on every launch.
        drop(conn);
        s.migrate().expect("live-context migration is idempotent");
    }

    #[test]
    fn migrations_apply_once_and_are_idempotent() {
        let dir = std::env::temp_dir().join(format!("aip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");
        s.migrate().expect("second migrate is a no-op");
        let info = s.info().unwrap();
        // 0001 schema_v1_1 .. 0006 memories, then the 0007..0017 data migrations.
        assert_eq!(info.schema_version, 17);
        // The two lists must stay numbered as one sequence: a data migration that reused a SQL
        // version number would be silently skipped on every database that already had it.
        assert_eq!(17, MIGRATIONS.len() as i64 + DATA_MIGRATIONS.len() as i64);
        // All v1.1 tables exist (§4), plus the R4 gateway-keys, P4 context-graph, P5 skills,
        // P6 agent-run and P7 memory tables. `memories_fts` is a virtual table, so it shows up
        // in sqlite_master as a table too — assert it, because BM25 recall silently returns
        // nothing if the FTS index was never created.
        let conn = s.conn.lock().unwrap();
        for table in [
            "providers",
            "api_keys",
            "manifests",
            "models_cache",
            "model_aliases",
            "ledger",
            "ledger_rollups",
            "drift_events",
            "onboarding_sessions",
            "generator_audit",
            "settings",
            "gateway_keys",
            "context_nodes",
            "context_edges",
            "skills",
            "agent_runs",
            "agent_steps",
            "memories",
            "memories_fts",
            "router_sessions",
            "session_turns",
            "session_state",
            "memory_pending",
            "memory_principal_policy",
            "router_model_context",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "missing table {table}");
        }
        // Pragmas per §4.
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
        let jm: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(jm.to_lowercase(), "wal");
        // FK cascade works (delete provider -> keys go).
        conn.execute(
            "INSERT INTO providers (id, slug, name, base_url, created_at, updated_at) VALUES ('p','s','n','https://x.test',1,1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO api_keys (id, provider_id, label, secret_ref, added_at) VALUES ('k','p','l','ref',1)",
            [],
        ).unwrap();
        conn.execute("DELETE FROM providers WHERE id='p'", []).unwrap();
        let keys: i64 = conn.query_row("SELECT COUNT(*) FROM api_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(keys, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 0015 exists to answer one question: **does an upstream report prompt caching at all?**
    ///
    /// That question is only answerable if "not reported" and "reported zero" are different
    /// values, so the column must be nullable and must carry no default. `NOT NULL DEFAULT 0`
    /// would have made every provider look like a provider that caches nothing — which is the
    /// finding the measurement was supposed to be able to falsify.
    #[test]
    fn ledger_cached_tokens_is_nullable_and_stays_null_when_unreported() {
        let dir = std::env::temp_dir().join(format!("aip-cached-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");

        let conn = s.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(ledger)").unwrap();
        let cols: Vec<(String, i64, Option<String>)> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let cached = cols
            .iter()
            .find(|(n, _, _)| n == "cached_tokens")
            .expect("ledger is missing cached_tokens");
        assert_eq!(cached.1, 0, "cached_tokens must be nullable (notnull=0)");
        assert!(cached.2.is_none(), "cached_tokens must carry no default, so absence stays NULL");

        // A row that says nothing about caching keeps NULL rather than being coerced to 0.
        conn.execute(
            "INSERT INTO ledger (ts, modality, model, status) VALUES (1,'text','gpt-4o','ok')",
            [],
        )
        .unwrap();
        let v: Option<i64> =
            conn.query_row("SELECT cached_tokens FROM ledger", [], |r| r.get(0)).unwrap();
        assert_eq!(v, None, "an unreported cache must stay NULL, not become 0");
        // `stmt` still borrows `conn`, so it has to be dropped before `conn` can be moved.
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 0016 — attribution. The same trap as 0015, one table over, and the reason it is worth a
    /// test of its own: a column that is present but never populated is indistinguishable from one
    /// that is populated, right up until something sums it and gets zero. So this asserts the
    /// column's *shape* (nullable, no default) and that a value written through it round-trips.
    #[test]
    fn ledger_app_key_is_nullable_and_carries_no_default() {
        let dir = std::env::temp_dir().join(format!("aip-appkey-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");

        let conn = s.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(ledger)").unwrap();
        let cols: Vec<(String, i64, Option<String>)> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let app_key =
            cols.iter().find(|(n, _, _)| n == "app_key_id").expect("ledger is missing app_key_id");
        assert_eq!(app_key.1, 0, "app_key_id must be nullable (notnull=0)");
        assert!(
            app_key.2.is_none(),
            "app_key_id must carry no default, so an unattributed row stays NULL"
        );

        // A row that names no app — a `ui` row, or any row written before this migration — keeps
        // NULL rather than being coerced to an empty key that would later sum as though real.
        conn.execute(
            "INSERT INTO ledger (ts, modality, model, status) VALUES (1,'text','gpt-4o','ok')",
            [],
        )
        .unwrap();
        let v: Option<String> =
            conn.query_row("SELECT app_key_id FROM ledger", [], |r| r.get(0)).unwrap();
        assert_eq!(v, None, "an unattributed row must stay NULL, not become an empty key");

        // Present-but-unwritable would satisfy everything above, so write through it as well.
        conn.execute("UPDATE ledger SET app_key_id='gk-1'", []).unwrap();
        let v: Option<String> =
            conn.query_row("SELECT app_key_id FROM ledger", [], |r| r.get(0)).unwrap();
        assert_eq!(v.as_deref(), Some("gk-1"), "app_key_id must accept a value");
        // `stmt` still borrows `conn`, so it has to be dropped before `conn` can be moved.
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 0017 — the per-app cap column and the index the gate reads it with.
    ///
    /// Two separate claims, both of which can be false while the migration reports success. The
    /// **column** must be nullable with no default, because `NULL` is how "this app has no cap"
    /// is spelled; a `NOT NULL DEFAULT 0` would make every app look capped at zero and refuse
    /// every request. The **index** is the difference between the gate's per-app SUM being an
    /// indexed range scan and being a full table scan on every single gateway request — invisible
    /// in behaviour, and therefore invisible in every test that does not look for it.
    #[test]
    fn gateway_key_cap_is_nullable_and_the_app_key_index_exists() {
        let dir = std::env::temp_dir().join(format!("aip-keycap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");

        let conn = s.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(gateway_keys)").unwrap();
        let cols: Vec<(String, i64, Option<String>)> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let cap = cols
            .iter()
            .find(|(n, _, _)| n == "cap_micros")
            .expect("gateway_keys is missing cap_micros");
        assert_eq!(cap.1, 0, "cap_micros must be nullable (notnull=0)");
        assert!(cap.2.is_none(), "cap_micros must carry no default, so an uncapped key stays NULL");

        // A key created the ordinary way must not arrive capped.
        conn.execute(
            "INSERT INTO gateway_keys (id, label, created_at) VALUES ('ak-1','cursor',1)",
            [],
        )
        .unwrap();
        let v: Option<i64> = conn
            .query_row("SELECT cap_micros FROM gateway_keys WHERE id='ak-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, None, "a new key must be uncapped, not capped at zero");

        // Present-but-unwritable would satisfy everything above, so write through it as well.
        conn.execute("UPDATE gateway_keys SET cap_micros=2500000 WHERE id='ak-1'", []).unwrap();
        let v: Option<i64> = conn
            .query_row("SELECT cap_micros FROM gateway_keys WHERE id='ak-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, Some(2_500_000), "cap_micros must accept a value");

        // The index the enforcement SUM needs. Named exactly, because a missing index degrades
        // silently — the query still answers, just by scanning every ledger row per request.
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_ledger_app_key_ts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1, "the per-app spend SUM needs idx_ledger_app_key_ts");

        // `stmt` still borrows `conn`, so it has to be dropped before `conn` can be moved.
        drop(stmt);
        drop(conn);
        // Re-migrating must not fail: app startup runs this on every launch.
        s.migrate().expect("0017 is idempotent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_has_no_fks_by_design_history_survives() {
        let dir = std::env::temp_dir().join(format!("aip-test-2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).unwrap();
        let conn = s.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, slug, name, base_url, created_at, updated_at) VALUES ('p','s','n','https://x.test',1,1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO ledger (ts, modality, model, status, provider_id) VALUES (1,'text','gpt-4o','ok','p')",
            [],
        ).unwrap();
        conn.execute("DELETE FROM providers WHERE id='p'", []).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM ledger", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "ledger history must survive provider deletion (§7)");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Open a store, seed the pre-fix graph shape, then rewind `schema_version` so the next
    /// `migrate()` re-runs the 0007 backfill over it. Rewinding rather than calling the backfill
    /// directly is deliberate: it exercises the real runner path, including version numbering.
    ///
    /// The fixture mirrors the shape actually found in the live database — two nodes for one
    /// memory (one from capture, one from recall) plus a single node for another.
    fn store_with_legacy_memory_nodes(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");
        {
            let conn = s.conn.lock().unwrap();
            for (id, text) in
                [("m-L3-aaa", "Hi, i am Tushu"), ("m-L3-bbb", "I am a Software Engineer.")]
            {
                conn.execute(
                    "INSERT INTO memories (id, layer, text, created_at, updated_at) VALUES (?1,'L3',?2,1,1)",
                    rusqlite::params![id, text],
                )
                .unwrap();
            }
            for (id, label, mem, ts) in [
                ("memory:s-1:1", "Hi, i am Tushu", "m-L3-aaa", 1000),
                ("memory:s-1:5", "Hi, i am Tushu", "m-L3-aaa", 2000),
                ("memory:s-1:2", "I am a Software Engineer.", "m-L3-bbb", 1500),
            ] {
                conn.execute(
                    "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                     VALUES (?1,'memory',?2,'engine','s-1',?3,?4)",
                    rusqlite::params![
                        id,
                        label,
                        ts,
                        format!("{{\"layer\":\"L3\",\"memoryId\":\"{mem}\"}}")
                    ],
                )
                .unwrap();
            }
            for (id, kind, label, ts) in [
                ("message:s-1:3", "message", "hi", 500),
                ("artifact:s-1:9", "artifact", "notes", 600),
            ] {
                conn.execute(
                    "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                     VALUES (?1,?2,?3,'ui','s-1',?4,NULL)",
                    rusqlite::params![id, kind, label, ts],
                )
                .unwrap();
            }
            // `>= 7`, not `= 7`. The runner skips a step when `version <= MAX(version)`, so once a
            // later migration exists, deleting only 0007 leaves the max at 0008 and this rewind is
            // silently a no-op — the fixture then asserts against un-backfilled data and the test
            // fails for a reason that has nothing to do with the backfill. Rewinding a migration
            // that is no longer the last one must delete the whole tail.
            conn.execute("DELETE FROM schema_version WHERE version >= 7", []).unwrap();
        }
        (s, dir)
    }

    fn memory_node_ids(s: &Store) -> Vec<String> {
        let conn = s.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id FROM context_nodes WHERE kind='memory' ORDER BY id").unwrap();
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        ids
    }

    #[test]
    fn a_legacy_memory_node_is_rekeyed_to_its_stable_id() {
        let (s, dir) = store_with_legacy_memory_nodes("rekey");
        s.migrate().expect("backfill runs");

        // Three legacy nodes, two distinct memories: the duplicates collapse to one node each.
        assert_eq!(memory_node_ids(&s), vec!["memory:m-L3-aaa", "memory:m-L3-bbb"]);

        let conn = s.conn.lock().unwrap();
        // The survivor keeps the *earliest* sighting. Dated from the duplicate's timestamp, the
        // graph would claim we learned the fact later than we did.
        let ts: i64 = conn
            .query_row("SELECT ts FROM context_nodes WHERE id='memory:m-L3-aaa'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ts, 1000);
        // Non-memory nodes are untouched.
        let others: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM context_nodes WHERE kind IN ('message','artifact')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(others, 2);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rekeying_merges_edge_weight_instead_of_doubling_it() {
        let (s, dir) = store_with_legacy_memory_nodes("merge");
        {
            let conn = s.conn.lock().unwrap();
            // A node written *after* the fix, so the stable id already exists. This is the case the
            // backfill has to merge into rather than duplicate. The node has to be inserted first
            // because the edge below references it and foreign keys are enforced.
            conn.execute(
                "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                 VALUES ('memory:m-L3-aaa','memory','Hi, i am Tushu','engine','s-1',2500,
                         '{\"layer\":\"L3\",\"memoryId\":\"m-L3-aaa\"}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO context_edges (id, from_id, to_id, kind, weight, ts)
                 VALUES ('e:message:s-1:3->memory:m-L3-aaa:recalled','message:s-1:3','memory:m-L3-aaa','recalled',2.0,900)",
                [],
            )
            .unwrap();
            // ...plus a legacy edge from the same message to the duplicate node.
            conn.execute(
                "INSERT INTO context_edges (id, from_id, to_id, kind, weight, ts)
                 VALUES ('e:message:s-1:3->memory:s-1:1:recalled','message:s-1:3','memory:s-1:1','recalled',3.0,800)",
                [],
            )
            .unwrap();
        }
        s.migrate().expect("backfill runs");

        {
            let conn = s.conn.lock().unwrap();
            let mut stmt =
                conn.prepare("SELECT to_id, weight FROM context_edges ORDER BY to_id").unwrap();
            let edges = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            // One edge at 5.0. The failure mode this guards is 7.0 — updating the existing edge
            // and then inserting the merged one over it.
            assert_eq!(edges, vec![("memory:m-L3-aaa".to_string(), 5.0)]);
            // The post-fix node is left exactly as it was. The backfill re-keys; it does not
            // rewrite data a user may already have seen.
            let ts: i64 = conn
                .query_row("SELECT ts FROM context_nodes WHERE id='memory:m-L3-aaa'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(ts, 2500);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merged_edge_weight_is_capped_like_the_host_caps_it() {
        let (s, dir) = store_with_legacy_memory_nodes("cap");
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                 VALUES ('memory:m-L3-aaa','memory','Hi, i am Tushu','engine','s-1',2500,
                         '{\"layer\":\"L3\",\"memoryId\":\"m-L3-aaa\"}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO context_edges (id, from_id, to_id, kind, weight, ts)
                 VALUES ('e:message:s-1:3->memory:m-L3-aaa:recalled','message:s-1:3','memory:m-L3-aaa','recalled',40.0,900)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO context_edges (id, from_id, to_id, kind, weight, ts)
                 VALUES ('e:message:s-1:3->memory:s-1:1:recalled','message:s-1:3','memory:s-1:1','recalled',30.0,800)",
                [],
            )
            .unwrap();
        }
        s.migrate().expect("backfill runs");

        let conn = s.conn.lock().unwrap();
        let w: f64 = conn
            .query_row("SELECT weight FROM context_edges WHERE to_id='memory:m-L3-aaa'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(w, 50.0, "merged weight must respect the host's ceiling");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_legacy_node_whose_memory_is_gone_is_left_alone() {
        let (s, dir) = store_with_legacy_memory_nodes("orphan");
        {
            let conn = s.conn.lock().unwrap();
            // `meta_json` names a memory that no longer exists, so there is no correct stable id.
            conn.execute(
                "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                 VALUES ('memory:s-1:8','memory','a fact since deleted','engine','s-1',1200,
                         '{\"layer\":\"L0\",\"memoryId\":\"m-L0-gone\"}')",
                [],
            )
            .unwrap();
        }
        s.migrate().expect("backfill runs");

        let ids = memory_node_ids(&s);
        assert!(
            ids.contains(&"memory:s-1:8".to_string()),
            "an unresolvable node must survive rather than be re-keyed to a guess: {ids:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_backfill_does_not_run_twice() {
        let (s, dir) = store_with_legacy_memory_nodes("once");
        s.migrate().expect("backfill runs");
        {
            let conn = s.conn.lock().unwrap();
            // A legacy-shaped node written *after* the backfill has been recorded.
            conn.execute(
                "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                 VALUES ('memory:s-1:7','memory','Hi, i am Tushu','engine','s-1',3000,
                         '{\"layer\":\"L3\",\"memoryId\":\"m-L3-aaa\"}')",
                [],
            )
            .unwrap();
        }
        s.migrate().expect("second migrate is a no-op");

        let conn = s.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM context_nodes WHERE id='memory:s-1:7'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1, "a recorded migration must not re-run");
        let versions: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version WHERE version=7", [], |r| r.get(0))
            .unwrap();
        assert_eq!(versions, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn error_class_of(conn: &rusqlite::Connection, id: i64) -> Option<String> {
        conn.query_row("SELECT error_class FROM ledger WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }

    /// Seed ledger rows in the shape the old failure path wrote — `error_class` forced to
    /// `NO_ROUTE` while the real class sits in `fallback_chain_json` on the same row — then rewind
    /// `schema_version` so the next `migrate()` re-runs the 0008 backfill over them.
    ///
    /// The cases are the ones the live database actually contained, plus the three that must be
    /// left alone: a chain that really is empty, one that cannot be parsed, and a row that already
    /// carries its real class.
    fn store_with_legacy_ledger(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");
        {
            let conn = s.conn.lock().unwrap();
            for (id, status, cls, chain) in [
                (
                    1,
                    "error",
                    Some("NO_ROUTE"),
                    Some(r#"[{"provider":"agnes","key":"key-01","cls":"BAD_REQUEST_SCHEMA"}]"#),
                ),
                // Two attempts: the last one decided the outcome, so AUTH_FAILED is the answer.
                (
                    2,
                    "error",
                    Some("NO_ROUTE"),
                    Some(
                        r#"[{"provider":"a","key":"k1","cls":"NETWORK"},{"provider":"b","key":"k2","cls":"AUTH_FAILED"}]"#,
                    ),
                ),
                // Genuinely no route: nothing was attempted, so the column is already right.
                (3, "error", Some("NO_ROUTE"), Some("[]")),
                (4, "error", Some("NO_ROUTE"), None),
                // Unparsable: skipped, never fatal — a failed migration fails `Store::open`.
                (5, "error", Some("NO_ROUTE"), Some("{ not json")),
                // A success, and an error that already carries its real class: both untouched.
                (6, "ok", None, Some("[]")),
                (
                    7,
                    "error",
                    Some("SERVER_ERROR"),
                    Some(r#"[{"provider":"c","key":"k3","cls":"SERVER_ERROR"}]"#),
                ),
            ] {
                conn.execute(
                    "INSERT INTO ledger (id, ts, modality, source, requested_model, model, status,
                                         error_class, latency_ms, tokens_in, tokens_out,
                                         cost_estimate_micros, fallback_chain_json)
                     VALUES (?1, ?1, 'text', 'ui', 'm', 'm', ?2, ?3, 5, 0, 0, 0, ?4)",
                    rusqlite::params![id, status, cls, chain],
                )
                .unwrap();
            }
            // Same rule as the 0007 fixture: rewind the tail, not just this version.
            conn.execute("DELETE FROM schema_version WHERE version >= 8", []).unwrap();
        }
        (s, dir)
    }

    #[test]
    fn a_legacy_no_route_row_recovers_its_real_class() {
        let (s, dir) = store_with_legacy_ledger("ledgercls");
        s.migrate().expect("backfill runs");

        let conn = s.conn.lock().unwrap();
        // Recovered from the chain stored on the same row, not guessed.
        assert_eq!(error_class_of(&conn, 1).as_deref(), Some("BAD_REQUEST_SCHEMA"));
        // The LAST attempt decided the outcome — the same entry `wrapLedger` itself reads. A
        // backfill that took the first entry instead would disagree with the writer.
        assert_eq!(error_class_of(&conn, 2).as_deref(), Some("AUTH_FAILED"));
        // Left alone: an empty chain is exactly what `NO_ROUTE` means.
        assert_eq!(error_class_of(&conn, 3).as_deref(), Some("NO_ROUTE"));
        assert_eq!(error_class_of(&conn, 4).as_deref(), Some("NO_ROUTE"));
        // Left alone: one bad row must not abort the migration, because that fails app startup.
        assert_eq!(error_class_of(&conn, 5).as_deref(), Some("NO_ROUTE"));
        // Untouched: a success, and a row that already carried its real class.
        assert_eq!(error_class_of(&conn, 6), None);
        assert_eq!(error_class_of(&conn, 7).as_deref(), Some("SERVER_ERROR"));

        // `http_status` is NOT invented: the chain never carried it, so it stays NULL. Writing a
        // plausible-looking number here would repeat the very mistake this migration repairs.
        let hs: Option<i64> =
            conn.query_row("SELECT http_status FROM ledger WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(hs, None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
