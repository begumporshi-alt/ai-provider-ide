//! Structured persistence commands. The webview gets typed CRUD functions with fixed SQL —
//! never raw statements (invariant 12). Row shapes match packages/router-core domain.ts
//! (camelCase wire format). Provider CRUD also maintains the egress allowlist host-side —
//! the webview has NO command that mutates it (diff-review Blocker 2).

use std::sync::Arc;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::CommandError;
use crate::store::Store;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- providers ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub r#type: Option<String>,
    pub base_url: String,
    pub status: String,
    pub rotation_strategy: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn providers_list(store: State<'_, Arc<Store>>) -> Result<Vec<ProviderRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, slug, name, type, base_url, status, rotation_strategy, created_at, updated_at FROM providers ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ProviderRow {
            id: r.get(0)?,
            slug: r.get(1)?,
            name: r.get(2)?,
            r#type: r.get(3)?,
            base_url: r.get(4)?,
            status: r.get(5)?,
            rotation_strategy: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
pub fn provider_upsert(
    store: State<'_, Arc<Store>>,
    egress: State<'_, Arc<crate::egress::EgressState>>,
    p: ProviderRow,
) -> Result<(), CommandError> {
    {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, slug, name, type, base_url, status, rotation_strategy, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET slug=?2, name=?3, type=?4, base_url=?5, status=?6, rotation_strategy=?7, updated_at=?9",
            params![p.id, p.slug, p.name, p.r#type, p.base_url, p.status, p.rotation_strategy, p.created_at, p.updated_at],
        )?;
    }
    sync_allow_for_provider(&egress, &store, &p.id);
    Ok(())
}

#[tauri::command]
pub fn provider_delete(
    store: State<'_, Arc<Store>>,
    egress: State<'_, Arc<crate::egress::EgressState>>,
    id: String,
) -> Result<(), CommandError> {
    // §7 hygiene: the SQL cascade removes key ROWS; the keychain entries must go too,
    // in the same operation.
    let secret_refs: Vec<String> = {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT secret_ref FROM api_keys WHERE provider_id = ?1")?;
        let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        rows.flatten().collect()
    };
    {
        let conn = store.conn.lock().unwrap();
        conn.execute("DELETE FROM providers WHERE id = ?1", params![id])?; // cascades (§7)
    }
    for account in secret_refs {
        let _ = crate::vault::delete(&account);
    }
    recompute_allow(&egress, &store);
    Ok(())
}

/// Recompute the allowlist entry for one provider (host allowed only while its status is
/// pending/enabled/repairing).
pub fn sync_allow_for_provider(
    egress: &crate::egress::EgressState,
    store: &Store,
    provider_id: &str,
) {
    let conn = store.conn.lock().unwrap();
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT base_url, status FROM providers WHERE id = ?1",
            params![provider_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    drop(conn);
    if let Some((base_url, status)) = row {
        if let Some(host) = reqwest::Url::parse(&base_url).ok().and_then(|u| u.host_str().map(str::to_lowercase)) {
            if matches!(status.as_str(), "pending" | "enabled" | "repairing") {
                egress.allow.allow(&host);
            } else {
                // disabled/draft: stop permitting egress to it once other live providers
                // don't share the host.
                recompute_allow(egress, store);
            }
        }
    }
}

/// Full allowlist recompute from current provider rows (authoritative; called after deletes
/// and status changes so no stale grant survives — invariant 9).
pub fn recompute_allow(egress: &crate::egress::EgressState, store: &Store) {
    let desired: std::collections::HashSet<String> = {
        let conn = store.conn.lock().unwrap();
        let hosts: Vec<String> = conn
            .prepare("SELECT base_url FROM providers WHERE status IN ('pending','enabled','repairing')")
            .map(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect::<Vec<String>>())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        hosts
            .into_iter()
            .filter_map(|u| reqwest::Url::parse(&u).ok().and_then(|x| x.host_str().map(str::to_lowercase)))
            .collect()
    }; // conn dropped here before touching the allowlist lock (no deadlock, no borrow)
    let mut cur = egress.allow.0.write().unwrap();
    *cur = desired;
}

// ---------- api keys ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRow {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub secret_ref: String,
    #[serde(default)]
    pub secret_hint: Option<String>,
    pub status: String,
    pub priority: i64,
    #[serde(default)]
    pub cooldown_until: Option<i64>,
    pub added_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub last_tested_at: Option<i64>,
}

#[tauri::command]
pub fn api_keys_list(store: State<'_, Arc<Store>>, provider_id: Option<String>) -> Result<Vec<ApiKeyRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let sql = "SELECT id, provider_id, label, secret_ref, secret_hint, status, priority, cooldown_until, added_at, last_used_at, last_tested_at FROM api_keys".to_string()
        + if provider_id.is_some() { " WHERE provider_id = ?1" } else { "" };
    let mut stmt = conn.prepare(&sql)?;
    let map = |r: &rusqlite::Row| {
        Ok(ApiKeyRow {
            id: r.get(0)?,
            provider_id: r.get(1)?,
            label: r.get(2)?,
            secret_ref: r.get(3)?,
            secret_hint: r.get(4)?,
            status: r.get(5)?,
            priority: r.get(6)?,
            cooldown_until: r.get(7)?,
            added_at: r.get(8)?,
            last_used_at: r.get(9)?,
            last_tested_at: r.get(10)?,
        })
    };
    let rows = match provider_id {
        Some(pid) => stmt.query_map(params![pid], map)?.collect::<Result<Vec<_>, _>>()?,
        None => stmt.query_map([], map)?.collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

#[tauri::command]
pub fn api_key_upsert(store: State<'_, Arc<Store>>, k: ApiKeyRow) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO api_keys (id, provider_id, label, secret_ref, secret_hint, status, priority, cooldown_until, added_at, last_used_at, last_tested_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(id) DO UPDATE SET label=?3, status=?6, priority=?7, cooldown_until=?8, last_used_at=?10, last_tested_at=?11",
        params![k.id, k.provider_id, k.label, k.secret_ref, k.secret_hint, k.status, k.priority, k.cooldown_until, k.added_at, k.last_used_at, k.last_tested_at],
    )?;
    Ok(())
}

#[tauri::command]
pub fn api_key_delete(store: State<'_, Arc<Store>>, id: String) -> Result<(), CommandError> {
    // Deleting a key removes its keychain entry in the same operation (§7 hygiene).
    let conn = store.conn.lock().unwrap();
    let secret_ref: Option<String> = conn
        .query_row("SELECT secret_ref FROM api_keys WHERE id = ?1", params![id], |r| r.get(0))
        .ok();
    conn.execute("DELETE FROM api_keys WHERE id = ?1", params![id])?;
    drop(conn);
    if let Some(account) = secret_ref {
        let _ = crate::vault::delete(&account);
    }
    Ok(())
}

// ---------- manifests ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestRow {
    pub id: String,
    pub provider_id: String,
    pub version: i64,
    pub origin: String,
    pub body_json: String,
    #[serde(default)]
    pub contract_result_json: Option<String>,
    pub created_at: i64,
    pub is_active: bool,
}

#[tauri::command]
pub fn manifests_active(store: State<'_, Arc<Store>>) -> Result<Vec<ManifestRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, provider_id, version, origin, body_json, contract_result_json, created_at, is_active FROM manifests WHERE is_active = 1",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ManifestRow {
            id: r.get(0)?,
            provider_id: r.get(1)?,
            version: r.get(2)?,
            origin: r.get(3)?,
            body_json: r.get(4)?,
            contract_result_json: r.get(5)?,
            created_at: r.get(6)?,
            is_active: r.get::<_, i64>(7)? == 1,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
pub fn manifest_upsert_active(store: State<'_, Arc<Store>>, m: ManifestRow) -> Result<(), CommandError> {
    let mut conn = store.conn.lock().unwrap();
    // One transaction: deactivation + activation must be atomic, or a mid-way failure
    // could leave zero active manifests despite uq_manifests_one_active.
    let tx = conn.transaction()?;
    tx.execute("UPDATE manifests SET is_active = 0 WHERE provider_id = ?1", params![m.provider_id])?;
    tx.execute(
        "INSERT INTO manifests (id, provider_id, version, origin, body_json, contract_result_json, created_at, is_active)
         VALUES (?1,?2,?3,?4,?5,?6,?7,1)
         ON CONFLICT(provider_id, version) DO UPDATE SET origin=?4, body_json=?5, contract_result_json=?6, is_active=1",
        params![m.id, m.provider_id, m.version, m.origin, m.body_json, m.contract_result_json, m.created_at],
    )?;
    tx.commit()?;
    Ok(())
}

// ---------- model catalog + aliases ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub provider_id: String,
    pub native_id: String,
    pub modality: String,
    #[serde(default)]
    pub context_window: Option<i64>,
    pub fetched_at: i64,
}

#[tauri::command]
pub fn models_cache_replace(store: State<'_, Arc<Store>>, provider_id: String, rows: Vec<ModelRow>) -> Result<(), CommandError> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM models_cache WHERE provider_id = ?1", params![provider_id])?;
    for r in rows {
        let id = format!("{}:{}", r.provider_id, r.native_id);
        tx.execute(
            "INSERT INTO models_cache (id, provider_id, native_id, modality, context_window, fetched_at) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(provider_id, native_id) DO UPDATE SET modality=?4, context_window=?5, fetched_at=?6",
            params![id, r.provider_id, r.native_id, r.modality, r.context_window, r.fetched_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn models_cache_list(store: State<'_, Arc<Store>>) -> Result<Vec<ModelRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT provider_id, native_id, modality, context_window, fetched_at FROM models_cache")?;
    let rows = stmt.query_map([], |r| {
        Ok(ModelRow {
            provider_id: r.get(0)?,
            native_id: r.get(1)?,
            modality: r.get(2)?,
            context_window: r.get(3)?,
            fetched_at: r.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRow {
    pub alias: String,
    pub provider_id: String,
    pub native_model_id: String,
    pub priority: i64,
}

#[tauri::command]
pub fn aliases_replace(store: State<'_, Arc<Store>>, rows: Vec<AliasRow>) -> Result<(), CommandError> {
    let mut conn = store.conn.lock().unwrap();
    // Transaction: a half-applied replace would wipe the failover map (§4).
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM model_aliases", [])?;
    for a in rows {
        tx.execute(
            "INSERT INTO model_aliases (alias, provider_id, native_model_id, priority) VALUES (?1,?2,?3,?4)",
            params![a.alias, a.provider_id, a.native_model_id, a.priority],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn aliases_list(store: State<'_, Arc<Store>>) -> Result<Vec<AliasRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT alias, provider_id, native_model_id, priority FROM model_aliases ORDER BY priority DESC")?;
    let rows = stmt.query_map([], |r| {
        Ok(AliasRow {
            alias: r.get(0)?,
            provider_id: r.get(1)?,
            native_model_id: r.get(2)?,
            priority: r.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

// ---------- ledger ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub ts: i64,
    pub modality: String,
    pub source: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub requested_model: Option<String>,
    pub model: String,
    pub status: String,
    #[serde(default)]
    pub http_status: Option<i64>,
    #[serde(default)]
    pub error_class: Option<String>,
    #[serde(default)]
    pub latency_ms: Option<i64>,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost_estimate_micros: i64,
    #[serde(default)]
    pub fallback_chain_json: Option<String>,
}

#[tauri::command]
pub fn ledger_append(store: State<'_, Arc<Store>>, e: LedgerRow) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO ledger (ts, modality, source, provider_id, key_id, requested_model, model, status, http_status, error_class, latency_ms, tokens_in, tokens_out, cost_estimate_micros, fallback_chain_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![e.ts, e.modality, e.source, e.provider_id, e.key_id, e.requested_model, e.model, e.status, e.http_status, e.error_class, e.latency_ms, e.tokens_in, e.tokens_out, e.cost_estimate_micros, e.fallback_chain_json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn ledger_recent(store: State<'_, Arc<Store>>, limit: Option<i64>) -> Result<Vec<LedgerRow>, CommandError> {
    let limit = limit.unwrap_or(100).clamp(1, 1000);
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT ts, modality, source, provider_id, key_id, requested_model, model, status, http_status, error_class, latency_ms, tokens_in, tokens_out, cost_estimate_micros, fallback_chain_json
         FROM ledger ORDER BY ts DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(LedgerRow {
            ts: r.get(0)?,
            modality: r.get(1)?,
            source: r.get(2)?,
            provider_id: r.get(3)?,
            key_id: r.get(4)?,
            requested_model: r.get(5)?,
            model: r.get(6)?,
            status: r.get(7)?,
            http_status: r.get(8)?,
            error_class: r.get(9)?,
            latency_ms: r.get(10)?,
            tokens_in: r.get(11)?,
            tokens_out: r.get(12)?,
            cost_estimate_micros: r.get(13)?,
            fallback_chain_json: r.get(14)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Nightly/on-start rollup job (§4): aggregate complete months into ledger_rollups
/// (idempotent ON CONFLICT DO UPDATE). Kept as one fixed statement.
#[tauri::command]
pub fn ledger_rollup_run(store: State<'_, Arc<Store>>) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    let month_from = now_ms() - 62 * 24 * 3600 * 1000; // only complete months older than ~2 mo
    conn.execute(
        "INSERT INTO ledger_rollups (month, provider_id, model, modality, requests, failures, tokens_in, tokens_out, cost_estimate_micros)
         SELECT strftime('%Y-%m', ts/1000, 'unixepoch') AS month,
                COALESCE(provider_id,'') AS provider_id, model, modality,
                COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures,
                SUM(tokens_in), SUM(tokens_out), SUM(cost_estimate_micros)
         FROM ledger
         WHERE ts < ?1
         GROUP BY month, provider_id, model, modality
         ON CONFLICT(month, provider_id, model, modality) DO UPDATE SET
           requests=excluded.requests, failures=excluded.failures,
           tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
           cost_estimate_micros=excluded.cost_estimate_micros",
        params![month_from],
    )?;
    // Raw entries kept 90 days (§4); only after they've been rolled up.
    let cutoff = now_ms() - 90 * 24 * 3600 * 1000;
    conn.execute(
        "DELETE FROM ledger WHERE ts < ?1 AND ts < ?2",
        params![cutoff, month_from],
    )?;
    Ok(())
}

// ---------- onboarding sessions (§2.1: wizard resumes after restart) ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingRow {
    #[serde(default)]
    pub id: Option<i64>,
    pub input_json: String,               // {name, baseUrl, docsUrl} — NEVER the key (§2.3)
    #[serde(default)]
    pub detail_json: Option<String>,      // redacted report + fingerprint + manifest + contract
    pub state: String,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[tauri::command]
pub fn onboarding_save(store: State<'_, Arc<Store>>, row: OnboardingRow) -> Result<i64, CommandError> {
    let now = now_ms();
    let conn = store.conn.lock().unwrap();
    match row.id {
        Some(id) => {
            conn.execute(
                "UPDATE onboarding_sessions SET updated_at=?2, input_json=?3, probe_report_redacted_json=?4, state=?5, outcome=?6 WHERE id=?1",
                params![id, now, row.input_json, row.detail_json, row.state, row.outcome],
            )?;
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO onboarding_sessions (created_at, updated_at, input_json, probe_report_redacted_json, state, outcome) VALUES (?1,?1,?2,?3,?4,?5)",
                params![now, row.input_json, row.detail_json, row.state, row.outcome],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
pub fn onboarding_latest_active(store: State<'_, Arc<Store>>) -> Result<Option<OnboardingRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, input_json, COALESCE(probe_report_redacted_json,'null'), state, outcome \
         FROM onboarding_sessions \
         WHERE state NOT IN ('enabled','failed') \
         ORDER BY updated_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map([], |r| {
        Ok(OnboardingRow {
            id: Some(r.get(0)?),
            input_json: r.get(1)?,
            detail_json: Some(r.get(2)?),
            state: r.get(3)?,
            outcome: r.get(4)?,
        })
    })?;
    match rows.next() {
        Some(v) => Ok(Some(v?)),
        None => Ok(None),
    }
}
