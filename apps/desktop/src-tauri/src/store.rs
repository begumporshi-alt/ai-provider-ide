//! sql-store (L0): SQLite access + THE single migration runner (§4). Direct rusqlite rather
//! than tauri-plugin-sql so the ordered NNNN_name.sql runner, integrity checks, and the
//! WAL/pragma init live in one audited place (DECISIONS.md 2026-09-15).

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
)];

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
    pub fn migrate(&self) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        // Bootstrap table first: it records history, so it must exist before any migration.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
        )?;
        let current: i64 = conn
            .query_row("SELECT COALESCE(MAX(version),0) FROM schema_version", [], |r| r.get(0))
            .unwrap_or(0);
        for (idx, (name, sql)) in MIGRATIONS.iter().enumerate() {
            let version = (idx + 1) as i64;
            if version <= current {
                continue;
            }
            let tx = conn
                .transaction()
                .map_err(|e| StoreError::Migration(name.to_string(), e.to_string()))?;
            let applied: Result<(), rusqlite::Error> = (|| {
                tx.execute_batch(sql)?;
                let now = chrono_now_ms();
                tx.execute(
                    "INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)",
                    rusqlite::params![version, name, now],
                )?;
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
        // 0001 schema_v1_1 .. 0005 agent_runs
        assert_eq!(info.schema_version, 5);
        // All v1.1 tables exist (§4), plus the R4 gateway-keys, P4 context-graph, P5 skills and
        // P6 agent-run tables.
        let conn = s.conn.lock().unwrap();
        for table in [
            "providers", "api_keys", "manifests", "models_cache", "model_aliases",
            "ledger", "ledger_rollups", "drift_events", "onboarding_sessions",
            "generator_audit", "settings", "gateway_keys",
            "context_nodes", "context_edges", "skills",
            "agent_runs", "agent_steps",
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
}
