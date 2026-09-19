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
const MIGRATIONS: &[(&str, &str)] = &[(
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
)];

/// Backfills that need real logic — grouping, weight merging, FK-safe re-keying — and so cannot be
/// expressed as one SQL batch.
///
/// Ordered *after* every entry in `MIGRATIONS`, so a step here takes the version
/// `MIGRATIONS.len() + idx + 1`. Keeping the two lists separate rather than interleaved means the
/// SQL list stays a literal list of schemas; the numbering is the only coupling, and it is
/// asserted by `migrations_apply_once_and_are_idempotent`.
const DATA_MIGRATIONS: &[(&str, fn(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>)] =
    &[("0007_stable_memory_node_ids", backfill_stable_memory_node_ids)];

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
fn load_legacy_memory_nodes(
    tx: &rusqlite::Transaction<'_>,
) -> rusqlite::Result<Vec<LegacyNode>> {
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
            tx.commit()
                .map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
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
            tx.commit()
                .map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_once_and_are_idempotent() {
        let dir = std::env::temp_dir().join(format!("aip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(&dir).expect("open+migrate");
        s.migrate().expect("second migrate is a no-op");
        let info = s.info().unwrap();
        // 0001 schema_v1_1 .. 0006 memories, then the 0007 data migration.
        assert_eq!(info.schema_version, 7);
        // The two lists must stay numbered as one sequence: a data migration that reused a SQL
        // version number would be silently skipped on every database that already had it.
        assert_eq!(7, MIGRATIONS.len() as i64 + DATA_MIGRATIONS.len() as i64);
        // All v1.1 tables exist (§4), plus the R4 gateway-keys, P4 context-graph, P5 skills,
        // P6 agent-run and P7 memory tables. `memories_fts` is a virtual table, so it shows up
        // in sqlite_master as a table too — assert it, because BM25 recall silently returns
        // nothing if the FTS index was never created.
        let conn = s.conn.lock().unwrap();
        for table in [
            "providers", "api_keys", "manifests", "models_cache", "model_aliases",
            "ledger", "ledger_rollups", "drift_events", "onboarding_sessions",
            "generator_audit", "settings", "gateway_keys",
            "context_nodes", "context_edges", "skills",
            "agent_runs", "agent_steps",
            "memories", "memories_fts",
        ] {
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [table], |r| r.get(0))
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
            conn.execute("DELETE FROM schema_version WHERE version = 7", []).unwrap();
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
            .query_row("SELECT COUNT(*) FROM context_nodes WHERE id='memory:s-1:7'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "a recorded migration must not re-run");
        let versions: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version WHERE version=7", [], |r| r.get(0))
            .unwrap();
        assert_eq!(versions, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
