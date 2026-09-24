//! Structured persistence commands. The webview gets typed CRUD functions with fixed SQL —
//! never raw statements (invariant 12). Row shapes match packages/router-core domain.ts
//! (camelCase wire format). Provider CRUD also maintains the egress allowlist host-side —
//! the webview has NO command that mutates it (diff-review Blocker 2).

use std::collections::HashMap;
// Only the `#[tauri::command]` wrappers below hold an `Arc<Store>` (Tauri managed state).
#[cfg(feature = "app")]
use std::sync::Arc;

use rusqlite::params;
use serde::{Deserialize, Serialize};
// `json!`/`Value` are used by the export/import surface and its tests, all of which need `app`.
#[cfg(feature = "app")]
use serde_json::{json, Value};
#[cfg(feature = "app")]
use tauri::State;

use crate::core::error::CommandError;
use crate::core::store::Store;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- providers ----------

/// `Clone` is here for the planner: `build_plan` builds a `Candidate` per usable key, and a
/// candidate owns its three rows (`core::planner`), so one provider row is cloned once per key of
/// that provider. The TypeScript shares a reference instead.
#[derive(Serialize, Deserialize, Debug, Clone)]
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

// ---------- store -> router readers ----------
//
// **Four readers, each a pair, and the split is what lets the headless service route.** Every one
// of these began life as a `#[tauri::command]` taking `State<'_, Arc<Store>>`, which is a shape a
// headless launch cannot produce — so `RouterStore::hydrate`, whose whole purpose is to be built
// from already-read rows, had no production caller at all (D39). The body never needed the
// `State`: it locks `store.conn` and runs a query. So each became an un-gated `*_rows` function
// over `&Store`, with the command left behind as a one-line delegate.
//
// The pattern is not new here — `gateway_keys_list` (`:966`), `active_gateway_key_ids` (`:946`),
// `gateway_key_cap` (`:1007`) and `month_spend_micros` (`:1057`) are all un-gated and
// `&Store`-shaped already, and `gateway_keys_list` has no command at all. What this block does is
// apply the same shape to the four readers the router actually needs.
//
// **The command names are wire names.** `providers_list`, `api_keys_list`, `models_cache_list` and
// `aliases_list` are what the webview's `invoke` calls, so they keep their names and their
// signatures; only their bodies moved.

/// Every provider row. See the section note above.
pub fn providers_rows(store: &Store) -> Result<Vec<ProviderRow>, CommandError> {
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

#[cfg(feature = "app")]
#[tauri::command]
pub fn providers_list(store: State<'_, Arc<Store>>) -> Result<Vec<ProviderRow>, CommandError> {
    providers_rows(&store)
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn provider_upsert(
    store: State<'_, Arc<Store>>,
    egress: State<'_, Arc<crate::core::egress::EgressState>>,
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

#[cfg(feature = "app")]
#[tauri::command]
pub fn provider_delete(
    store: State<'_, Arc<Store>>,
    egress: State<'_, Arc<crate::core::egress::EgressState>>,
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
        let _ = crate::core::vault::delete(&account);
    }
    recompute_allow(&egress, &store);
    Ok(())
}

/// Recompute the allowlist entry for one provider (host allowed only while its status is
/// pending/enabled/repairing).
pub fn sync_allow_for_provider(
    egress: &crate::core::egress::EgressState,
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
        if let Some(host) =
            reqwest::Url::parse(&base_url).ok().and_then(|u| u.host_str().map(str::to_lowercase))
        {
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
pub fn recompute_allow(egress: &crate::core::egress::EgressState, store: &Store) {
    let desired: std::collections::HashSet<String> = {
        let conn = store.conn.lock().unwrap();
        let hosts: Vec<String> = conn
            .prepare(
                "SELECT base_url FROM providers WHERE status IN ('pending','enabled','repairing')",
            )
            .map(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .map(|rows| rows.flatten().collect::<Vec<String>>())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        hosts
            .into_iter()
            .filter_map(|u| {
                reqwest::Url::parse(&u).ok().and_then(|x| x.host_str().map(str::to_lowercase))
            })
            .collect()
    }; // conn dropped here before touching the allowlist lock (no deadlock, no borrow)
    let mut cur = egress.allow.0.write().unwrap();
    *cur = desired;
}

// ---------- api keys ----------

#[derive(Serialize, Deserialize, Debug, Clone)]
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

/// Every key row, optionally narrowed to one provider. See the section note above.
///
/// Takes `Option<&str>` rather than `Option<String>`: the hydration path passes `None`, and a
/// caller that already holds an owned id should not have to clone it to ask.
pub fn api_keys_rows(
    store: &Store,
    provider_id: Option<&str>,
) -> Result<Vec<ApiKeyRow>, CommandError> {
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

#[cfg(feature = "app")]
#[tauri::command]
pub fn api_keys_list(
    store: State<'_, Arc<Store>>,
    provider_id: Option<String>,
) -> Result<Vec<ApiKeyRow>, CommandError> {
    api_keys_rows(&store, provider_id.as_deref())
}

#[cfg(feature = "app")]
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

#[cfg(feature = "app")]
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
        let _ = crate::core::vault::delete(&account);
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

/// Every **active** manifest row — at most one per provider, which
/// `uq_manifests_one_active` enforces.
///
/// **The `is_active = 1` filter is the whole function, and it is why this is a reader rather than a
/// query the caller writes.** The table keeps one row per *version* and only one of them is live, so
/// a caller that forgot the filter would be handed every version ever staged and would let an old
/// one win by iteration order — a silent rollback of the operator's activation, which is exactly
/// the mistake `manifest_activate` exists to make impossible.
///
/// The headless split, for the reason the section note at the top of this file gives: the body never
/// needed the `State`, so this reads a `&Store` and the command below is a one-line delegate.
pub fn manifests_active_rows(store: &Store) -> Result<Vec<ManifestRow>, CommandError> {
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

#[cfg(feature = "app")]
#[tauri::command]
pub fn manifests_active(store: State<'_, Arc<Store>>) -> Result<Vec<ManifestRow>, CommandError> {
    manifests_active_rows(&store)
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn manifest_upsert_active(
    store: State<'_, Arc<Store>>,
    m: ManifestRow,
) -> Result<(), CommandError> {
    let mut conn = store.conn.lock().unwrap();
    // One transaction: deactivation + activation must be atomic, or a mid-way failure
    // could leave zero active manifests despite uq_manifests_one_active.
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE manifests SET is_active = 0 WHERE provider_id = ?1",
        params![m.provider_id],
    )?;
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub provider_id: String,
    pub native_id: String,
    pub modality: String,
    #[serde(default)]
    pub context_window: Option<i64>,
    pub fetched_at: i64,
    /// Normalized pricing as JSON (`{prompt, completion}` in micro-USD per 1M tokens), or NULL
    /// when the provider published none. Persisted because the catalog is only re-fetched every
    /// 24h: without it, every launch after a refresh reads back a catalog with no prices, and
    /// cost — and therefore the monthly spend cap — goes dark until the next manual refresh.
    #[serde(default)]
    pub pricing_json: Option<String>,
    /// What the model can do, as JSON (`{"reasoning":true}`), or NULL when the provider did not
    /// say. Persisted for the same reason as pricing: the gateway worker never re-lists, so an
    /// unpersisted capability is one the gateway cannot report to a client.
    #[serde(default)]
    pub capabilities_json: Option<String>,
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn models_cache_replace(
    store: State<'_, Arc<Store>>,
    provider_id: String,
    rows: Vec<ModelRow>,
) -> Result<(), CommandError> {
    let mut conn = store.conn.lock().unwrap();
    replace_models(&mut conn, &provider_id, &rows).map_err(Into::into)
}

/// Every cached model row. See the section note above.
///
/// The query itself was already split out into `list_models(conn)` for testability; this is the
/// `&Store`-shaped sibling the hydration path needs, and `list_models` loses its `app` gate with it.
pub fn models_cache_rows(store: &Store) -> Result<Vec<ModelRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    list_models(&conn).map_err(Into::into)
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn models_cache_list(store: State<'_, Arc<Store>>) -> Result<Vec<ModelRow>, CommandError> {
    models_cache_rows(&store)
}

/// The cache write, split out of the command so it can be tested without a Tauri `State`.
/// `pricing_json` rides along because the catalog is re-fetched only once per 24h: a launch
/// that hydrates from this table and finds no price will price every request as unknown,
/// which zeroes cost and leaves the monthly spend cap unable to fire.
#[cfg(feature = "app")]
fn replace_models(
    conn: &mut rusqlite::Connection,
    provider_id: &str,
    rows: &[ModelRow],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM models_cache WHERE provider_id = ?1", params![provider_id])?;
    for r in rows {
        let id = format!("{}:{}", r.provider_id, r.native_id);
        tx.execute(
            "INSERT INTO models_cache (id, provider_id, native_id, modality, context_window, fetched_at, pricing_json, capabilities_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(provider_id, native_id) DO UPDATE SET modality=?4, context_window=?5, fetched_at=?6, pricing_json=?7, capabilities_json=?8",
            params![id, r.provider_id, r.native_id, r.modality, r.context_window, r.fetched_at, r.pricing_json, r.capabilities_json],
        )?;
    }
    tx.commit()
}

fn list_models(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<ModelRow>> {
    let mut stmt = conn.prepare("SELECT provider_id, native_id, modality, context_window, fetched_at, pricing_json, capabilities_json FROM models_cache")?;
    let rows = stmt.query_map([], |r| {
        Ok(ModelRow {
            provider_id: r.get(0)?,
            native_id: r.get(1)?,
            modality: r.get(2)?,
            context_window: r.get(3)?,
            fetched_at: r.get(4)?,
            pricing_json: r.get(5)?,
            capabilities_json: r.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRow {
    pub alias: String,
    pub provider_id: String,
    pub native_model_id: String,
    pub priority: i64,
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn aliases_replace(
    store: State<'_, Arc<Store>>,
    rows: Vec<AliasRow>,
) -> Result<(), CommandError> {
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

/// Every model alias. See the section note above.
pub fn aliases_rows(store: &Store) -> Result<Vec<AliasRow>, CommandError> {
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

#[cfg(feature = "app")]
#[tauri::command]
pub fn aliases_list(store: State<'_, Arc<Store>>) -> Result<Vec<AliasRow>, CommandError> {
    aliases_rows(&store)
}

// ---------- ledger ----------

/// One row of the usage ledger, as sent by the webview.
///
/// `deny_unknown_fields` is not cosmetic here. Serde ignores unknown keys by default, so a
/// misspelled `appKeyId` from the TypeScript sender would deserialize to `None` and write `NULL`
/// on every row — the feature would look like it worked while recording nothing at all. That is
/// exactly the shape migration 0015 left behind: 1530 rows `NULL`, reported as "0". `memory.rs:142`
/// carries the same attribute for the same reason, and this payload is the one the app-key
/// attribution now rides on.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerRow {
    pub ts: i64,
    pub modality: String,
    pub source: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    /// The gateway app key that paid for this row (`gateway_keys.id`), when the request arrived
    /// through the gateway.
    ///
    /// **Not the same thing as `key_id`**, which is the *provider* credential — two different ids
    /// that both answer to "key", which is what made the attribution gap hard to see. `None` is the
    /// honest value for a `ui` or `generator` row, and for every row written before migration 0016.
    #[serde(default)]
    pub app_key_id: Option<String>,
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
    /// Prompt tokens the upstream served from its own cache, when it reports them.
    ///
    /// `None` is the load-bearing value here, not `0`: it means the provider reported no cache
    /// block at all, which is a different finding from reporting a zero. `ledger.cached_tokens`
    /// is nullable for the same reason (migration 0015).
    #[serde(default)]
    pub cached_tokens: Option<i64>,
    #[serde(default)]
    pub fallback_chain_json: Option<String>,
}

/// The one place a ledger row is written.
///
/// Split out of the command so the column list and the bound values can be tested *together*. A
/// `#[tauri::command]` taking `State` cannot be called from a unit test, and an INSERT no test can
/// reach is how 0015's column ended up present, nullable, correctly shaped — and empty.
///
/// **`pub` and un-gated since 25d**, for the reason D39 gave: it has always taken a plain
/// `&Connection` and touched no Tauri type, so the `app` gate was inherited from its caller rather
/// than earned. `core::ledger::StoreLedgerSink` is the other caller — the headless service writes
/// ledger rows without a command to go through.
pub fn ledger_insert(conn: &rusqlite::Connection, e: &LedgerRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ledger (ts, modality, source, provider_id, key_id, app_key_id, requested_model, model, status, http_status, error_class, latency_ms, tokens_in, tokens_out, cost_estimate_micros, cached_tokens, fallback_chain_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![e.ts, e.modality, e.source, e.provider_id, e.key_id, e.app_key_id, e.requested_model, e.model, e.status, e.http_status, e.error_class, e.latency_ms, e.tokens_in, e.tokens_out, e.cost_estimate_micros, e.cached_tokens, e.fallback_chain_json],
    )?;
    Ok(())
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn ledger_append(store: State<'_, Arc<Store>>, e: LedgerRow) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    ledger_insert(&conn, &e)?;
    Ok(())
}

/// The ledger's read statement. It lives next to the mapper below and is used by the command *and*
/// by the round-trip test, so the test drives the real statement rather than a copy that can drift.
#[cfg(feature = "app")]
const LEDGER_SELECT: &str = "SELECT ts, modality, source, provider_id, key_id, app_key_id, requested_model, model, status, http_status, error_class, latency_ms, tokens_in, tokens_out, cost_estimate_micros, cached_tokens, fallback_chain_json
         FROM ledger ORDER BY ts DESC LIMIT ?1";

/// Map one `ledger` row to its wire shape.
///
/// Split out of the command so the mapping can be tested. `r.get(5)` is a *position*, not a name:
/// adding `app_key_id` to the SELECT without shifting every index after it would have returned the
/// requested model in the app-key field, and the compiler would have been perfectly happy about it.
#[cfg(feature = "app")]
fn ledger_row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<LedgerRow> {
    Ok(LedgerRow {
        ts: r.get(0)?,
        modality: r.get(1)?,
        source: r.get(2)?,
        provider_id: r.get(3)?,
        key_id: r.get(4)?,
        app_key_id: r.get(5)?,
        requested_model: r.get(6)?,
        model: r.get(7)?,
        status: r.get(8)?,
        http_status: r.get(9)?,
        error_class: r.get(10)?,
        latency_ms: r.get(11)?,
        tokens_in: r.get(12)?,
        tokens_out: r.get(13)?,
        cost_estimate_micros: r.get(14)?,
        cached_tokens: r.get(15)?,
        fallback_chain_json: r.get(16)?,
    })
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn ledger_recent(
    store: State<'_, Arc<Store>>,
    limit: Option<i64>,
) -> Result<Vec<LedgerRow>, CommandError> {
    let limit = limit.unwrap_or(100).clamp(1, 1000);
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(LEDGER_SELECT)?;
    let rows = stmt.query_map(params![limit], ledger_row_from)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Nightly/on-start rollup job (§4): aggregate complete months into ledger_rollups
/// (idempotent ON CONFLICT DO UPDATE). Kept as one fixed statement.
#[cfg(feature = "app")]
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
    conn.execute("DELETE FROM ledger WHERE ts < ?1 AND ts < ?2", params![cutoff, month_from])?;
    Ok(())
}

// ---------- onboarding sessions (§2.1: wizard resumes after restart) ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingRow {
    #[serde(default)]
    pub id: Option<i64>,
    pub input_json: String, // {name, baseUrl, docsUrl} — NEVER the key (§2.3)
    #[serde(default)]
    pub detail_json: Option<String>, // redacted report + fingerprint + manifest + contract
    pub state: String,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn onboarding_save(
    store: State<'_, Arc<Store>>,
    row: OnboardingRow,
) -> Result<i64, CommandError> {
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

#[cfg(feature = "app")]
#[tauri::command]
pub fn onboarding_latest_active(
    store: State<'_, Arc<Store>>,
) -> Result<Option<OnboardingRow>, CommandError> {
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

// ---------- generator audit (§2.5) ----------

#[cfg(feature = "app")]
#[tauri::command]
pub fn generator_audit_record(
    store: State<'_, Arc<Store>>,
    e: GeneratorAuditRow,
) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO generator_audit (ts, model_used, prompt_tokens, completion_tokens, redaction_hash) VALUES (?1,?2,?3,?4,?5)",
        params![now_ms(), e.model_used, e.prompt_tokens, e.completion_tokens, e.redaction_hash],
    )?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorAuditRow {
    pub model_used: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub redaction_hash: String,
}

/// One recorded generation, as read back for the audit card.
///
/// Deliberately a different type from `GeneratorAuditRow`: this one carries the `id` and the host's
/// `ts`, and the write shape must not, or a caller could backdate an entry or collide ids.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorAuditEntry {
    pub id: i64,
    pub ts_ms: i64,
    pub model_used: String,
    /// **Estimated, not measured.** Both producers send `chars / 4`. The column is named `tokens`
    /// and this DTO keeps that name, but the card must not present the number as a tokenizer count.
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub redaction_hash: String,
}

/// A caller asking for more than this is not reading a trail, it is scraping one.
#[cfg(feature = "app")]
const AUDIT_MAX_LIMIT: usize = 500;

/// Read the generation audit, newest first.
///
/// Extracted from the command because a `#[tauri::command]` needs a `State` and cannot be
/// unit-tested — the house pattern (REFERENCE.md §Tauri commands).
///
/// `ORDER BY ts DESC, id DESC`: `ts` is `now_ms()` and two generations in the same millisecond are
/// ordinary, so ordering on the clock alone would leave their order to SQLite. `id` is the rowid and
/// is monotonic, which makes the tie deterministic — the same rule that forbids ordering two captures
/// on the clock without a tiebreak.
///
/// The floor of one matches `gateway_log_tail`'s. Two readers of two trails, sitting on the same
/// screen, should not disagree about what `limit: 0` means.
#[cfg(feature = "app")]
pub(crate) fn list_generator_audit(
    store: &Store,
    limit: usize,
) -> Result<Vec<GeneratorAuditEntry>, CommandError> {
    let limit = limit.clamp(1, AUDIT_MAX_LIMIT);
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, ts, model_used, prompt_tokens, completion_tokens, redaction_hash \
         FROM generator_audit ORDER BY ts DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit as i64], |r| {
        Ok(GeneratorAuditEntry {
            id: r.get(0)?,
            ts_ms: r.get(1)?,
            model_used: r.get(2)?,
            prompt_tokens: r.get(3)?,
            completion_tokens: r.get(4)?,
            redaction_hash: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The AI generation trail, newest first — see `list_generator_audit`.
#[cfg(feature = "app")]
#[tauri::command]
pub fn generator_audit_list(
    store: State<'_, Arc<Store>>,
    limit: Option<usize>,
) -> Result<Vec<GeneratorAuditEntry>, CommandError> {
    list_generator_audit(&store, limit.unwrap_or(50))
}

// ---------- drift events + repair staging (§2.10, Phase 5) ----------

#[cfg(feature = "app")]
#[tauri::command]
pub fn drift_event_record(
    store: State<'_, Arc<Store>>,
    provider_id: String,
    trigger_json: String,
) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO drift_events (provider_id, detected_at, trigger_json) VALUES (?1,?2,?3)",
        params![provider_id, now_ms(), trigger_json],
    )?;
    Ok(())
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn drift_event_resolve(
    store: State<'_, Arc<Store>>,
    provider_id: String,
    resolution: String,
) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "UPDATE drift_events SET resolution=?2, resolved_at=?3 WHERE provider_id=?1 AND resolution IS NULL",
        params![provider_id, resolution, now_ms()],
    )?;
    Ok(())
}

/// A caller asking for more than this is not reading a trail, it is scraping one.
#[cfg(feature = "app")]
const DRIFT_MAX_LIMIT: usize = 500;

/// One recorded drift event, as read back for the history card.
///
/// `trigger_json` is passed through raw: it is the host's own `DriftEvidence` blob, and the card renders
/// a summary from it rather than the reader inventing a shape. `resolution` and `resolved_at` are
/// `Option` because an open event has neither — "still drifting" versus "repaired" is the whole reason
/// the row exists, so the read shape must be able to express both.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriftEventEntry {
    pub id: i64,
    pub provider_id: String,
    pub detected_at: i64,
    pub trigger_json: String,
    pub resolution: Option<String>,
    pub resolved_at: Option<i64>,
}

/// Read the drift history, newest first.
///
/// Extracted from the command because a `#[tauri::command]` needs a `State` and cannot be unit-tested —
/// the house pattern (REFERENCE.md §Tauri commands).
///
/// `ORDER BY detected_at DESC, id DESC`: two events in the same millisecond are ordinary — a detection
/// and the repair that answers it can land together — so ordering on the clock alone would leave their
/// order to SQLite. `id` is the rowid and is monotonic, which makes the tie deterministic. Same rule,
/// same reason, as `list_generator_audit`.
///
/// `COALESCE(trigger_json,'{}')` rather than a nullable field: the column *is* nullable, and the other
/// reader of this table (`diagnostics_json`) already coalesces, so the two agree. An empty object parses
/// to an empty summary instead of failing the row.
///
/// The floor of one matches the other two trail readers. Three readers of three trails on one screen
/// must not disagree about what `limit: 0` means.
#[cfg(feature = "app")]
pub(crate) fn list_drift_events(
    store: &Store,
    limit: usize,
) -> Result<Vec<DriftEventEntry>, CommandError> {
    let limit = limit.clamp(1, DRIFT_MAX_LIMIT);
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, provider_id, detected_at, COALESCE(trigger_json,'{}'), resolution, resolved_at \
         FROM drift_events ORDER BY detected_at DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit as i64], |r| {
        Ok(DriftEventEntry {
            id: r.get(0)?,
            provider_id: r.get(1)?,
            detected_at: r.get(2)?,
            trigger_json: r.get(3)?,
            resolution: r.get(4)?,
            resolved_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The recorded drift history, newest first — see `list_drift_events`.
#[cfg(feature = "app")]
#[tauri::command]
pub fn drift_events_list(
    store: State<'_, Arc<Store>>,
    limit: Option<usize>,
) -> Result<Vec<DriftEventEntry>, CommandError> {
    list_drift_events(&store, limit.unwrap_or(50))
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn manifests_history(
    store: State<'_, Arc<Store>>,
    provider_id: String,
) -> Result<Vec<ManifestRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, provider_id, version, origin, body_json, contract_result_json, created_at, is_active FROM manifests WHERE provider_id = ?1 ORDER BY version DESC",
    )?;
    let rows = stmt.query_map(params![provider_id], |r| {
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

/// Stage a repair candidate as a NEW version without activating it (human confirms first).
#[cfg(feature = "app")]
#[tauri::command]
pub fn manifest_stage(store: State<'_, Arc<Store>>, m: ManifestRow) -> Result<i64, CommandError> {
    let conn = store.conn.lock().unwrap();
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version),0)+1 FROM manifests WHERE provider_id = ?1",
        params![m.provider_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO manifests (id, provider_id, version, origin, body_json, contract_result_json, created_at, is_active) VALUES (?1,?2,?3,?4,?5,?6,?7,0)",
        params![m.id, m.provider_id, next, m.origin, m.body_json, m.contract_result_json, m.created_at],
    )?;
    Ok(next)
}

/// Activate a staged manifest; returns the previously-active version for one-click rollback.
#[cfg(feature = "app")]
#[tauri::command]
pub fn manifest_activate(
    store: State<'_, Arc<Store>>,
    provider_id: String,
    version: i64,
) -> Result<Option<i64>, CommandError> {
    let mut conn = store.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let previous: Option<i64> = tx
        .query_row(
            "SELECT version FROM manifests WHERE provider_id=?1 AND is_active=1",
            params![provider_id],
            |r| r.get(0),
        )
        .ok();
    tx.execute("UPDATE manifests SET is_active=0 WHERE provider_id=?1", params![provider_id])?;
    let changed = tx.execute(
        "UPDATE manifests SET is_active=1 WHERE provider_id=?1 AND version=?2",
        params![provider_id, version],
    )?;
    if changed == 0 {
        return Err(CommandError(format!(
            "manifest v{version} not found for provider {provider_id}"
        )));
    }
    tx.commit()?;
    Ok(previous)
}

// ---------- audit R4: per-app gateway keys + monthly spend cap ----------
//
// Threat model: the gateway exposes the user's PAID credentials to local apps behind one key.
// (a) Per-app keys let one consumer be cut off without rotating the master key (which would
//     break every other connected app).
// (b) The spend cap bounds a runaway consumer (an agent loop in a connected IDE) — the ledger
//     already tracks cost, so month-to-date is a single SUM.
//
// Split: metadata + revocation live in SQLite (auditable, survives restart); the secret lives
// in the OS keychain and is shown once. So nothing here ever holds a credential.

/// Ids of every non-revoked per-app key. Read per request so revocation is immediate.
pub fn active_gateway_key_ids(store: &Store) -> Result<Vec<String>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id FROM gateway_keys WHERE revoked_at IS NULL")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayKeyRow {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    /// 0017: this app's own monthly cap in micro-USD. `None` = uncapped. Never `Some(0)` — see
    /// `gateway_key_cap_set`.
    pub cap_micros: Option<i64>,
}

pub fn gateway_keys_list(store: &Store) -> Result<Vec<GatewayKeyRow>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, label, created_at, last_used_at, revoked_at, cap_micros FROM gateway_keys ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(GatewayKeyRow {
                id: r.get(0)?,
                label: r.get(1)?,
                created_at: r.get(2)?,
                last_used_at: r.get(3)?,
                revoked_at: r.get(4)?,
                cap_micros: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 0017: set or clear one app's monthly cap, in micro-USD.
///
/// `<= 0` **clears** the cap and stores `NULL` rather than a zero. Two spellings of "uncapped"
/// would make the column ambiguous the moment anything sums or compares it, and the ambiguity
/// would be invisible: both values behave identically until a query uses `IS NULL` to mean
/// "no cap was ever set", at which point the zeros quietly fall on the wrong side.
///
/// A cap on a key that does not exist is an error rather than a silent no-op, mirroring
/// `gateway_key_revoke`: an update that changed no row reported success for nothing.
pub fn gateway_key_cap_set(store: &Store, id: &str, cap_micros: i64) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    let stored = if cap_micros > 0 { Some(cap_micros) } else { None };
    let changed =
        conn.execute("UPDATE gateway_keys SET cap_micros=?2 WHERE id=?1", params![id, stored])?;
    if changed == 0 {
        return Err(CommandError(format!("gateway key not found: {id}")));
    }
    Ok(())
}

/// One app's cap, or `None` when it has none. Read by the spend gate on every gateway request.
pub fn gateway_key_cap(store: &Store, id: &str) -> Option<i64> {
    let conn = store.conn.lock().ok()?;
    conn.query_row("SELECT cap_micros FROM gateway_keys WHERE id=?1", params![id], |r| {
        r.get::<_, Option<i64>>(0)
    })
    .ok()
    .flatten()
    .filter(|cap| *cap > 0)
}

/// Register a key row. The caller generates the secret, copies it to the clipboard, and stores
/// it in the keychain — this only records that it exists.
pub fn gateway_key_insert(store: &Store, id: &str, label: &str) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO gateway_keys (id, label, created_at) VALUES (?1, ?2, ?3)",
        params![id, label, now_ms()],
    )?;
    Ok(())
}

pub fn gateway_key_revoke(store: &Store, id: &str) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    let changed = conn.execute(
        "UPDATE gateway_keys SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL",
        params![id, now_ms()],
    )?;
    if changed == 0 {
        return Err(CommandError("gateway key not found or already revoked".into()));
    }
    Ok(())
}

/// Hard delete (row + keychain entry). Prefer `revoke` — deleting loses the audit trail.
pub fn gateway_key_delete(store: &Store, id: &str) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute("DELETE FROM gateway_keys WHERE id=?1", params![id])?;
    crate::core::vault::delete(&format!("{}{}", crate::core::gateway::APP_KEY_PREFIX, id)).ok();
    Ok(())
}

/// Month-to-date spend in micro-USD, at the UTC month boundary.
///
/// Scope: all ledger rows, whatever the `source` (ui / gateway / generator). A cap that only
/// counted gateway traffic would be silently understated by Assistant usage — the user sets a
/// budget on what they pay, not on one client.
///
/// The boundary is computed in SQL rather than by hand: month lengths vary, and a hand-rolled
/// calendar conversion is exactly the kind of off-by-one that silently mis-bills. `start of
/// month` + `utc` gives the first instant of the current UTC month.
pub fn month_spend_micros(store: &Store) -> i64 {
    let conn = match store.conn.lock() {
        Ok(c) => c,
        Err(_) => return 0,
    };
    conn.query_row(
        "SELECT COALESCE(SUM(cost_estimate_micros), 0) FROM ledger
         WHERE ts >= CAST(strftime('%s', 'now', 'start of month', 'utc') AS INTEGER) * 1000",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// One app's month-to-date spend in micro-USD.
///
/// The same UTC month boundary and the same "all sources" scope as `month_spend_micros`; the only
/// difference is the `app_key_id` predicate. Rows written before 0016 carry `NULL` there, so an
/// app's total starts from the first request made after attribution was connected — which is the
/// honest number, because nothing can reconstruct which app paid before that.
///
/// Served by `idx_ledger_app_key_ts`, added in 0017 for exactly this query.
pub fn app_month_spend_micros(store: &Store, app_key_id: &str) -> i64 {
    let conn = match store.conn.lock() {
        Ok(c) => c,
        Err(_) => return 0,
    };
    conn.query_row(
        "SELECT COALESCE(SUM(cost_estimate_micros), 0) FROM ledger
         WHERE app_key_id = ?1
           AND ts >= CAST(strftime('%s', 'now', 'start of month', 'utc') AS INTEGER) * 1000",
        params![app_key_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Every app's month-to-date spend, keyed by `gateway_keys.id`.
///
/// One grouped query rather than one per key: the screen renders a row per key, so a per-key query
/// would make that screen's cost scale with the number of apps configured. A key with no
/// attributed spend is simply absent — the caller reads a missing entry as zero, which is the same
/// answer the SQL would have given.
pub fn month_spend_by_app(store: &Store) -> HashMap<String, i64> {
    let conn = match store.conn.lock() {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    let mut stmt = match conn.prepare(
        "SELECT app_key_id, COALESCE(SUM(cost_estimate_micros), 0) FROM ledger
         WHERE app_key_id IS NOT NULL
           AND ts >= CAST(strftime('%s', 'now', 'start of month', 'utc') AS INTEGER) * 1000
         GROUP BY app_key_id",
    ) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .and_then(|it| it.collect::<Result<Vec<_>, _>>());
    match rows {
        Ok(v) => v.into_iter().collect(),
        Err(_) => HashMap::new(),
    }
}

/// One settings row, parsed, or `None` when it is absent or unreadable.
///
/// **The core-side sibling of the `settings_get` command.** That command is `app`-gated and hands
/// back the raw `String`; a launch has no webview to hand it to, and both core readers that want
/// a settings row — [`spend_cap_micros`] below and `RouterSettings::from_store` in `core::router`
/// — want it parsed. `None` covers three cases the callers treat identically: no row, a `NULL`,
/// and a value that does not parse. The only honest thing to do with a settings row that cannot
/// be read is to keep the default.
///
/// It takes the key as an argument rather than being one reader per key because the keys are the
/// webview's (`store.ts`), not this crate's: `'router'`, `'gateway'`, `'spend'`, `'background'`.
pub fn setting_value(store: &Store, key: &str) -> Option<serde_json::Value> {
    let conn = store.conn.lock().unwrap();
    let raw: Option<String> =
        conn.query_row("SELECT value_json FROM settings WHERE key=?1", [key], |r| r.get(0)).ok();
    serde_json::from_str(&raw?).ok()
}

/// Spend cap in micro-USD, or `None` when disabled.
///
/// `0` and a negative value both read as "no cap"; folding them here means no caller has to
/// repeat the comparison.
pub fn spend_cap_micros(store: &Store) -> Option<i64> {
    let cap = setting_value(store, "spend")?.get("capMicrosPerMonth")?.as_i64()?;
    if cap <= 0 {
        None
    } else {
        Some(cap)
    }
}

pub fn spend_cap_set(store: &Store, cap_micros: i64) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES ('spend', ?1)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        params![serde_json::json!({ "capMicrosPerMonth": cap_micros }).to_string()],
    )?;
    Ok(())
}

// Four tests below carry `#[cfg(feature = "app")]` because the readers they exercise are
// app-gated; the others compile without the feature, which is the point of
// `cargo check --no-default-features --all-targets` — see D17.
// (Deliberately not a count: it was "the other ten" until 25b added an eleventh, and a number in
// a comment is a second place to remember.)
#[cfg(test)]
mod persist_tests {
    use super::*;

    fn tmp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-p5-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    #[test]
    fn manifest_versioning_stage_activate_rollback() {
        let (store, dir) = tmp_store("ver");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO providers (id,slug,name,base_url,status,created_at,updated_at) VALUES ('p','s','n','https://x.test','enabled',1,1)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO manifests (id,provider_id,version,origin,body_json,created_at,is_active) VALUES ('m1','p',1,'builtin-template','{}',1,1)",
                [],
            ).unwrap();
        }
        let next = {
            let conn = store.conn.lock().unwrap();
            let n: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(version),0)+1 FROM manifests WHERE provider_id='p'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            conn.execute(
                "INSERT INTO manifests (id,provider_id,version,origin,body_json,created_at,is_active) VALUES ('m2','p',?1,'ai-patched','{}',1,0)",
                rusqlite::params![n],
            ).unwrap();
            n
        };
        assert_eq!(next, 2);
        // activate staged v2 -> returns previous v1
        {
            let mut conn = store.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let prev: Option<i64> = tx
                .query_row(
                    "SELECT version FROM manifests WHERE provider_id='p' AND is_active=1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            assert_eq!(prev, Some(1));
            tx.execute("UPDATE manifests SET is_active=0 WHERE provider_id='p'", []).unwrap();
            tx.execute("UPDATE manifests SET is_active=1 WHERE provider_id='p' AND version=2", [])
                .unwrap();
            tx.commit().unwrap();
        }
        // exactly one active, and rollback target exists
        let conn = store.conn.lock().unwrap();
        let active: Vec<i64> = conn
            .prepare("SELECT version FROM manifests WHERE is_active=1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(active, vec![2]);
        let hist: i64 = conn
            .query_row("SELECT COUNT(*) FROM manifests WHERE provider_id='p'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hist, 2);
        // uq_manifests_one_active prevents two actives
        let dup = conn.execute("INSERT INTO manifests (id,provider_id,version,origin,body_json,created_at,is_active) VALUES ('m3','p',3,'ai-patched','{}',1,1)", []);
        assert!(dup.is_err(), "unique partial index must reject a second active manifest");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "app")]
    #[test]
    fn model_pricing_survives_the_cache_round_trip() {
        let (store, dir) = tmp_store("pricing");
        {
            let mut conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO providers (id,slug,name,base_url,status,created_at,updated_at) VALUES ('p','s','n','https://x.test','enabled',1,1)",
                [],
            ).unwrap();
            let rows = vec![
                ModelRow {
                    provider_id: "p".into(),
                    native_id: "openai/gpt-4o-mini".into(),
                    modality: "text".into(),
                    context_window: None,
                    fetched_at: 1,
                    pricing_json: Some(r#"{"prompt":150000,"completion":600000}"#.into()),
                    capabilities_json: Some(r#"{"reasoning":false}"#.into()),
                },
                ModelRow {
                    provider_id: "p".into(),
                    native_id: "some/free-model".into(),
                    modality: "text".into(),
                    context_window: None,
                    fetched_at: 1,
                    pricing_json: None,
                    capabilities_json: None,
                },
            ];
            replace_models(&mut conn, "p", &rows).unwrap();
            let back = list_models(&conn).unwrap();
            assert_eq!(back.len(), 2);

            // The priced row comes back priced — this is what the ledger reads after a restart.
            let priced = back.iter().find(|r| r.native_id == "openai/gpt-4o-mini").unwrap();
            assert_eq!(
                priced.pricing_json.as_deref(),
                Some(r#"{"prompt":150000,"completion":600000}"#)
            );

            // An unpriced row stays NULL. Writing 0 here would make "unknown" read as "free".
            let unpriced = back.iter().find(|r| r.native_id == "some/free-model").unwrap();
            assert_eq!(unpriced.pricing_json, None);

            // A refresh that no longer carries pricing overwrites the old price rather than
            // leaving a stale one behind.
            let refreshed = vec![ModelRow {
                provider_id: "p".into(),
                native_id: "openai/gpt-4o-mini".into(),
                modality: "text".into(),
                context_window: None,
                fetched_at: 2,
                pricing_json: None,
                capabilities_json: None,
            }];
            replace_models(&mut conn, "p", &refreshed).unwrap();
            let back = list_models(&conn).unwrap();
            assert_eq!(back.len(), 1);
            assert_eq!(back[0].pricing_json, None);
            assert_eq!(
                back[0].capabilities_json, None,
                "a refresh with no capability data must clear it, not leave a stale claim"
            );
            assert_eq!(back[0].fetched_at, 2);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drift_events_record_and_resolve() {
        let (store, dir) = tmp_store("drift");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO providers (id,slug,name,base_url,status,created_at,updated_at) VALUES ('p','s','n','https://x.test','enabled',1,1)",
                [],
            ).unwrap();
            conn.execute("INSERT INTO drift_events (provider_id, detected_at, trigger_json) VALUES ('p',1,'{\"errors\":5}')", []).unwrap();
        }
        let open: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM drift_events WHERE resolution IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(open, 1);
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("UPDATE drift_events SET resolution='repaired', resolved_at=2 WHERE provider_id='p' AND resolution IS NULL", []).unwrap();
        }
        let open2: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM drift_events WHERE resolution IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(open2, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "app")]
    #[test]
    fn config_export_import_safety() {
        let (store, dir) = tmp_store("cfg");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO providers (id,slug,name,base_url,status,rotation_strategy,created_at,updated_at) VALUES ('p','acme','Acme','https://acme.test/v1','enabled','round_robin',1,1)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO api_keys (id,provider_id,label,secret_ref,secret_hint,status,priority,added_at) VALUES ('k','p','key-01','key:ref-1','7A2F','active',0,1)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO manifests (id,provider_id,version,origin,body_json,created_at,is_active) VALUES ('m','p',1,'builtin-template','{}',1,1)",
                [],
            ).unwrap();
            conn.execute("INSERT INTO settings (key,value_json) VALUES ('router','{\"failoverEnabled\":true}')", []).unwrap();
            conn.execute(
                "INSERT INTO settings (key,value_json) VALUES ('gateway','{\"port\":8787}')",
                [],
            )
            .unwrap();
        }

        // export: carries the reference, never a secret; gateway setting is machine-local but exported
        let snap = {
            let conn = store.conn.lock().unwrap();
            config_export_rows(&conn).unwrap()
        };
        assert_eq!(snap.format_version, 1);
        assert_eq!(snap.providers.len(), 1);
        assert_eq!(snap.keys.len(), 1);
        assert_eq!(snap.keys[0].secret_ref, "key:ref-1");
        let snap_json = serde_json::to_string(&snap).unwrap();
        assert!(!snap_json.contains("sk-"), "no raw secret material in export");
        assert!(!snap_json.contains("\"secret\""), "no secret-named field in export");

        // import into a fresh store: providers -> draft, keys -> invalid (audit H7)
        let (store2, dir2) = tmp_store("cfg2");
        {
            let mut conn = store2.conn.lock().unwrap();
            let mut snap2: ImportSnapshot =
                serde_json::from_value(serde_json::to_value(&snap).unwrap()).unwrap();
            // force a live status in the source; import must still land as draft
            snap2.providers[0].status = "enabled".into();
            let applied = config_import_checked(&mut conn, &snap2).unwrap();
            assert_eq!(applied.providers, 1);
            assert_eq!(applied.keys, 1);
            let status: String = conn
                .query_row("SELECT status FROM providers WHERE id='p'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(status, "draft", "imported providers must land as draft");
            let kstatus: String = conn
                .query_row("SELECT status FROM api_keys WHERE id='k'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(kstatus, "invalid", "imported keys must land as invalid");
            let gw: Option<String> = conn
                .query_row("SELECT value_json FROM settings WHERE key='gateway'", [], |r| r.get(0))
                .ok();
            assert_eq!(gw, None, "gateway (machine-local) setting must never be imported");

            // re-import the same snapshot: idempotent, nothing duplicated
            let again = config_import_checked(&mut conn, &snap2).unwrap();
            assert_eq!((again.providers, again.keys), (0, 0));
        }

        // rejection: a raw payload carrying a `secret` field fails loud, applies nothing
        let (store3, dir3) = tmp_store("cfg3");
        {
            let conn = store3.conn.lock().unwrap();
            let mut raw = serde_json::to_value(&snap).unwrap();
            raw["keys"][0]["secret"] = serde_json::json!("sk-live-123");
            match parse_import(raw) {
                Ok(_) => panic!("secret-bearing snapshot must be rejected"),
                Err(e) => assert!(e.0.contains("raw secret fields"), "got: {}", e.0),
            }
            let n: i64 =
                conn.query_row("SELECT COUNT(*) FROM providers", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "rejected import must apply nothing");
        }

        // diagnostics: rows present but no body/secret columns
        {
            let conn = store.conn.lock().unwrap();
            let bundle = diagnostics_json(&conn).unwrap();
            assert!(bundle.contains("\"schemaVersion\""));
            assert!(!bundle.contains("sk-"));
        }

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
        let _ = std::fs::remove_dir_all(&dir3);
    }

    // ---------- audit R4: gateway key metadata + spend cap ----------

    /// A revoked key disappears from the *active* set but stays in the list — the audit trail
    /// is the point of revocation over deletion. Double-revoke is an error, not a no-op.
    #[test]
    fn gateway_keys_revoke_is_immediate_and_idempotency_checked() {
        let (store, dir) = tmp_store("gk");
        gateway_key_insert(&store, "ak-1", "Cursor").unwrap();
        gateway_key_insert(&store, "ak-2", "Claude Code").unwrap();
        assert_eq!(active_gateway_key_ids(&store).unwrap().len(), 2);

        gateway_key_revoke(&store, "ak-1").unwrap();
        let active = active_gateway_key_ids(&store).unwrap();
        assert_eq!(active, vec!["ak-2".to_string()], "revocation is immediate");

        let rows = gateway_keys_list(&store).unwrap();
        assert_eq!(rows.len(), 2, "revoked rows are retained");
        let one = rows.iter().find(|r| r.id == "ak-1").unwrap();
        assert!(one.revoked_at.is_some());
        assert_eq!(one.label, "Cursor");

        assert!(
            gateway_key_revoke(&store, "ak-1").is_err(),
            "revoking twice must report, not silently succeed"
        );
        assert!(gateway_key_revoke(&store, "ak-nope").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gateway_key_delete_removes_row() {
        let (store, dir) = tmp_store("gkd");
        gateway_key_insert(&store, "ak-1", "tmp").unwrap();
        gateway_key_delete(&store, "ak-1").unwrap();
        assert!(gateway_keys_list(&store).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The **writer**, not the schema. `ledger.app_key_id` being present and correctly shaped says
    /// nothing about whether anything ever writes to it — migration 0015 left a column in exactly
    /// that state behind: present, nullable, right, and `NULL` on all 1530 rows, which a summary
    /// then reported as "0".
    #[cfg(feature = "app")]
    #[test]
    fn ledger_insert_writes_the_app_key_and_leaves_it_null_when_absent() {
        let (store, dir) = tmp_store("appkey");
        let row = |app_key_id: Option<&str>| LedgerRow {
            ts: 1,
            modality: "text".into(),
            source: "gateway".into(),
            provider_id: Some("p".into()),
            key_id: Some("ak-1".into()),
            app_key_id: app_key_id.map(str::to_string),
            requested_model: Some("m".into()),
            model: "m".into(),
            status: "ok".into(),
            http_status: Some(200),
            error_class: None,
            latency_ms: Some(5),
            tokens_in: 1,
            tokens_out: 1,
            cost_estimate_micros: 10,
            cached_tokens: None,
            fallback_chain_json: None,
        };
        {
            let conn = store.conn.lock().unwrap();
            ledger_insert(&conn, &row(Some("gk-1"))).unwrap();
            // A `ui` row — and every row written before 0016 — names no app. It must stay NULL
            // rather than be coerced into an empty string that would later sum as a real key.
            ledger_insert(&conn, &row(None)).unwrap();
        }
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT app_key_id FROM ledger ORDER BY id").unwrap();
        let got: Vec<Option<String>> =
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(got, vec![Some("gk-1".to_string()), None]);

        // The provider credential still lands in its own column. Collapsing the two is the mistake
        // `app_key_id` exists to undo, so a passing test must not have done it by accident.
        let key_id: Option<String> =
            conn.query_row("SELECT key_id FROM ledger WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(key_id.as_deref(), Some("ak-1"));
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The guard that makes attribution enforceable rather than merely conventional. Without
    /// `deny_unknown_fields`, a misspelled `appKeyId` from the webview deserializes to `None` and
    /// writes `NULL` on every row — the feature looks like it works while recording nothing, and
    /// nothing anywhere reports a problem.
    #[test]
    fn a_ledger_row_with_an_unknown_key_is_rejected() {
        let known = serde_json::json!({
            "ts": 1, "modality": "text", "source": "gateway", "model": "m", "status": "ok",
            "tokensIn": 0, "tokensOut": 0, "costEstimateMicros": 0,
        });
        assert!(serde_json::from_value::<LedgerRow>(known).is_ok(), "the known shape must parse");

        let mut misspelled = serde_json::json!({
            "ts": 1, "modality": "text", "source": "gateway", "model": "m", "status": "ok",
            "tokensIn": 0, "tokensOut": 0, "costEstimateMicros": 0,
        });
        // `appKey`, not `appKeyId`: exactly the kind of slip that would otherwise be swallowed.
        misspelled["appKey"] = serde_json::json!("gk-1");
        assert!(
            serde_json::from_value::<LedgerRow>(misspelled).is_err(),
            "a misspelled app key must be loud, not silently dropped"
        );
    }

    /// The read path, driven through the same statement and mapper the command uses.
    ///
    /// Every column is given a *distinct* value on purpose. The failure this exists to catch is a
    /// shifted index, and two columns holding the same value would let an off-by-one pass.
    #[cfg(feature = "app")]
    #[test]
    fn ledger_recent_maps_every_column_to_its_own_field() {
        let (store, dir) = tmp_store("map");
        {
            let conn = store.conn.lock().unwrap();
            ledger_insert(
                &conn,
                &LedgerRow {
                    ts: 11,
                    modality: "text".into(),
                    source: "gateway".into(),
                    provider_id: Some("prov-1".into()),
                    key_id: Some("key-1".into()),
                    app_key_id: Some("app-1".into()),
                    requested_model: Some("req-1".into()),
                    model: "mod-1".into(),
                    status: "ok".into(),
                    http_status: Some(201),
                    error_class: Some("cls-1".into()),
                    latency_ms: Some(7),
                    tokens_in: 13,
                    tokens_out: 17,
                    cost_estimate_micros: 19,
                    cached_tokens: Some(23),
                    fallback_chain_json: Some("chain-1".into()),
                },
            )
            .unwrap();
        }
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare(LEDGER_SELECT).unwrap();
        let got = stmt.query_row(params![1], ledger_row_from).unwrap();

        assert_eq!(got.ts, 11);
        assert_eq!(got.modality, "text");
        assert_eq!(got.source, "gateway");
        assert_eq!(got.provider_id.as_deref(), Some("prov-1"));
        assert_eq!(got.key_id.as_deref(), Some("key-1"), "key_id is the provider credential");
        assert_eq!(got.app_key_id.as_deref(), Some("app-1"), "app_key_id is the gateway app key");
        assert_eq!(got.requested_model.as_deref(), Some("req-1"));
        assert_eq!(got.model, "mod-1");
        assert_eq!(got.status, "ok");
        assert_eq!(got.http_status, Some(201));
        assert_eq!(got.error_class.as_deref(), Some("cls-1"));
        assert_eq!(got.latency_ms, Some(7));
        assert_eq!(got.tokens_in, 13);
        assert_eq!(got.tokens_out, 17);
        assert_eq!(got.cost_estimate_micros, 19);
        assert_eq!(got.cached_tokens, Some(23));
        assert_eq!(got.fallback_chain_json.as_deref(), Some("chain-1"));
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cap round-trips, and 0 means "disabled" rather than "zero budget" — that
    /// distinction is what keeps an empty Settings field from bricking the gateway.
    #[test]
    fn spend_cap_round_trip_and_zero_means_disabled() {
        let (store, dir) = tmp_store("cap");
        assert_eq!(spend_cap_micros(&store), None, "unset cap = disabled");
        spend_cap_set(&store, 5_000_000).unwrap();
        assert_eq!(spend_cap_micros(&store), Some(5_000_000));
        spend_cap_set(&store, 9_000_000).unwrap();
        assert_eq!(spend_cap_micros(&store), Some(9_000_000), "set must upsert");
        spend_cap_set(&store, 0).unwrap();
        assert_eq!(spend_cap_micros(&store), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `setting_value` is the one reader of the `settings` table, and the three ways a row can be
    /// unreadable are one answer: absent.
    ///
    /// The malformed case is the point of the test. `settings_set` is a whole-row upsert of
    /// whatever the webview hands it, so a row that is not JSON is reachable — and a launch that
    /// treated one as an error would refuse to start over a setting it could have ignored. This
    /// test compiles without the `app` feature on purpose: `setting_value` is what the headless
    /// launch reads its settings through, so it is exactly the code that must not need the glue.
    #[test]
    fn setting_value_parses_and_treats_an_unreadable_row_as_absent() {
        let (store, dir) = tmp_store("setval");
        assert_eq!(setting_value(&store, "router"), None, "no row");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key,value_json) VALUES ('router','{\"failoverEnabled\":false}')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO settings (key,value_json) VALUES ('gateway','not json')", [])
                .unwrap();
        }
        let v = setting_value(&store, "router").expect("a stored object parses");
        assert_eq!(v.get("failoverEnabled").and_then(serde_json::Value::as_bool), Some(false));
        assert_eq!(setting_value(&store, "gateway"), None, "malformed is absent, not an error");
        assert_eq!(setting_value(&store, "never-written"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Month-to-date must be a calendar month in UTC, not "last N days". A row from two
    /// months ago is excluded even though it is well inside any 90-day retention window.
    #[test]
    fn month_spend_counts_only_the_current_utc_month() {
        let (store, dir) = tmp_store("spend");
        let now = now_ms();
        let two_months_ago = now - 62 * 24 * 3600 * 1000;
        {
            let conn = store.conn.lock().unwrap();
            for (ts, cost) in [(now, 100_i64), (now, 250_i64), (two_months_ago, 999_i64)] {
                conn.execute(
                    "INSERT INTO ledger (ts, modality, source, provider_id, model, status, tokens_in, tokens_out, cost_estimate_micros)
                     VALUES (?1,'text','gateway','p','m','ok',1,1,?2)",
                    params![ts, cost],
                )
                .unwrap();
            }
        }
        assert_eq!(month_spend_micros(&store), 350, "only the current UTC month counts");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 0017: the per-app cap round-trips, `<= 0` clears it, and a missing key is an error.
    ///
    /// The last one is the point of the test. `UPDATE ... WHERE id=?` that matches nothing is not
    /// a failure in SQL — it changes zero rows and reports success — so a cap set against a key the
    /// UI has already deleted would be acknowledged and then silently absent, which is the worst
    /// shape: the operator believes a budget is in force and none is.
    #[test]
    fn per_app_cap_round_trips_and_clears_and_rejects_an_unknown_key() {
        let (store, dir) = tmp_store("appcap");
        gateway_key_insert(&store, "ak-1", "cursor").unwrap();

        assert_eq!(gateway_key_cap(&store, "ak-1"), None, "a new key has no cap");
        gateway_key_cap_set(&store, "ak-1", 2_500_000).unwrap();
        assert_eq!(gateway_key_cap(&store, "ak-1"), Some(2_500_000));
        gateway_key_cap_set(&store, "ak-1", 4_000_000).unwrap();
        assert_eq!(gateway_key_cap(&store, "ak-1"), Some(4_000_000), "set must overwrite");

        gateway_key_cap_set(&store, "ak-1", 0).unwrap();
        assert_eq!(gateway_key_cap(&store, "ak-1"), None, "0 clears the cap");
        gateway_key_cap_set(&store, "ak-1", 7_000_000).unwrap();
        gateway_key_cap_set(&store, "ak-1", -5).unwrap();
        assert_eq!(gateway_key_cap(&store, "ak-1"), None, "a negative clears it too");

        assert!(
            gateway_key_cap_set(&store, "ak-nope", 1_000).is_err(),
            "a cap on a key that does not exist must report, not silently no-op"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Clearing a cap stores `NULL`, never `0`. Both read as "uncapped" today, so this can only be
    /// caught by looking at the stored value — which is exactly why it needs a test: the moment
    /// anything queries `cap_micros IS NULL` to mean "no cap was ever set", the zeros land on the
    /// wrong side of it and nothing in the behaviour changes to warn anyone.
    #[test]
    fn clearing_a_per_app_cap_stores_null_not_zero() {
        let (store, dir) = tmp_store("appcapnull");
        gateway_key_insert(&store, "ak-1", "cursor").unwrap();
        gateway_key_cap_set(&store, "ak-1", 0).unwrap();

        let conn = store.conn.lock().unwrap();
        let raw: Option<i64> = conn
            .query_row("SELECT cap_micros FROM gateway_keys WHERE id='ak-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, None, "clearing must store NULL, not 0 — one spelling, not two");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Per-app spend is scoped by **two** things at once, and a test that only varied one would
    /// pass against an implementation that ignored the other. So the same app has an out-of-month
    /// row and a second app has an in-month row, and neither may leak into the answer.
    #[test]
    fn app_month_spend_is_scoped_by_app_and_by_month() {
        let (store, dir) = tmp_store("appspend");
        let now = now_ms();
        let two_months_ago = now - 62 * 24 * 3600 * 1000;
        {
            let conn = store.conn.lock().unwrap();
            for (app, ts, cost) in [
                (Some("ak-1"), now, 100_i64),
                (Some("ak-1"), two_months_ago, 999_i64), // wrong month
                (Some("ak-2"), now, 250_i64),            // wrong app
                (None, now, 777_i64),                    // unattributed: belongs to no app
            ] {
                conn.execute(
                    "INSERT INTO ledger (ts, modality, source, provider_id, model, status, tokens_in, tokens_out, cost_estimate_micros, app_key_id)
                     VALUES (?1,'text','gateway','p','m','ok',1,1,?2,?3)",
                    params![ts, cost, app],
                )
                .unwrap();
            }
        }
        assert_eq!(app_month_spend_micros(&store, "ak-1"), 100, "only ak-1, only this month");
        assert_eq!(app_month_spend_micros(&store, "ak-2"), 250);
        assert_eq!(app_month_spend_micros(&store, "ak-nobody"), 0, "an unseen app spent nothing");

        // The grouped read must agree with the per-key one, or the list screen and the gate would
        // report different numbers for the same app — the drift this pair of functions exists to
        // avoid. The unattributed row appears under no key at all.
        let by_app = month_spend_by_app(&store);
        assert_eq!(by_app.get("ak-1"), Some(&100));
        assert_eq!(by_app.get("ak-2"), Some(&250));
        assert_eq!(by_app.len(), 2, "an unattributed row is nobody's spend");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------- config export/import + diagnostics (spec req. 14, Phase 6) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSnapshot {
    pub format_version: u32,
    pub exported_at: i64,
    pub providers: Vec<ProviderRow>,
    pub keys: Vec<ExportKey>,
    pub manifests: Vec<ExportManifest>,
    pub aliases: Vec<AliasRow>,
    pub settings: Vec<SettingRow>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportKey {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub secret_ref: String,
    pub secret_hint: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportManifestRow {
    pub id: String,
    pub provider_id: String,
    pub version: i64,
    pub origin: String,
    pub body_json: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSnapshot {
    pub format_version: u32,
    pub providers: Vec<ProviderRow>,
    pub keys: Vec<ExportKey>,
    pub manifests: Vec<ImportManifestRow>,
    #[serde(default)]
    pub aliases: Vec<AliasRow>,
    #[serde(default)]
    pub settings: Vec<SettingRow>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    pub key: String,
    pub value_json: String,
}

#[cfg(feature = "app")]
#[tauri::command]
pub fn config_export(store: State<'_, Arc<Store>>) -> Result<ExportSnapshot, CommandError> {
    // Secrets NEVER leave the keychain: keys export as id/label/ref/hint only.
    let conn = store.conn.lock().unwrap();
    Ok(config_export_rows(&conn)?)
}

#[cfg(feature = "app")]
fn config_export_rows(conn: &rusqlite::Connection) -> Result<ExportSnapshot, rusqlite::Error> {
    let providers = {
        let mut stmt = conn.prepare("SELECT id, slug, name, type, base_url, status, rotation_strategy, created_at, updated_at FROM providers ORDER BY created_at")?;
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
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let keys = {
        let mut stmt =
            conn.prepare("SELECT id, provider_id, label, secret_ref, secret_hint FROM api_keys")?;
        let rows = stmt.query_map([], |r| {
            Ok(ExportKey {
                id: r.get(0)?,
                provider_id: r.get(1)?,
                label: r.get(2)?,
                secret_ref: r.get(3)?,
                secret_hint: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let manifests = {
        let mut stmt = conn.prepare(
            "SELECT id, provider_id, version, origin, body_json FROM manifests WHERE is_active = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ExportManifest {
                id: r.get(0)?,
                provider_id: r.get(1)?,
                version: r.get(2)?,
                origin: r.get(3)?,
                body_json: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let aliases = {
        let mut stmt = conn
            .prepare("SELECT alias, provider_id, native_model_id, priority FROM model_aliases")?;
        let rows = stmt.query_map([], |r| {
            Ok(AliasRow {
                alias: r.get(0)?,
                provider_id: r.get(1)?,
                native_model_id: r.get(2)?,
                priority: r.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let settings = {
        let mut stmt = conn.prepare("SELECT key, value_json FROM settings")?;
        let rows =
            stmt.query_map([], |r| Ok(SettingRow { key: r.get(0)?, value_json: r.get(1)? }))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    Ok(ExportSnapshot {
        format_version: 1,
        exported_at: now_ms(),
        providers,
        keys,
        manifests,
        aliases,
        settings,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub id: String,
    pub provider_id: String,
    pub version: i64,
    pub origin: String,
    pub body_json: String,
}

/// Reject any `secret`-named key anywhere in the snapshot (defense in depth: the webview's
/// TS validator scans the raw text first; this scans the deserialized Rust structs so a
/// hand-crafted invoke can't bypass the UI check).
#[cfg(feature = "app")]
fn find_secret_keys(v: &serde_json::Value, path: String, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                let p = format!("{path}.{k}");
                if k == "secret" {
                    out.push(p.clone());
                }
                find_secret_keys(val, p, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                find_secret_keys(item, format!("{path}[{i}]"), out);
            }
        }
        _ => {}
    }
}

/// Apply an imported snapshot. Safety contract: providers land as `draft` and keys as
/// `invalid` so the re-enter-key flow runs before anything can route (audit H7). Existing
/// providers are skipped (never silently overwrite a live setup); a fresh install applies
/// everything. All-or-nothing: one transaction. The command takes the RAW JSON value so
/// the host-side secret scan sees exactly what arrived — typed structs can't carry a
/// smuggled `secret` field, so scanning them would be theater.
#[cfg(feature = "app")]
#[tauri::command]
pub fn config_import(
    store: State<'_, Arc<Store>>,
    raw: serde_json::Value,
) -> Result<ImportApplied, CommandError> {
    let snap = parse_import(raw)?;
    let mut conn = store.conn.lock().unwrap();
    config_import_checked(&mut conn, &snap)
}

#[cfg(feature = "app")]
fn parse_import(raw: serde_json::Value) -> Result<ImportSnapshot, CommandError> {
    let mut secret_paths = Vec::new();
    find_secret_keys(&raw, "$".to_string(), &mut secret_paths);
    if !secret_paths.is_empty() {
        return Err(CommandError(format!(
            "raw secret fields present (rejected): {}",
            secret_paths.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
        )));
    }
    serde_json::from_value(raw).map_err(|e| CommandError(e.to_string()))
}

#[cfg(feature = "app")]
fn config_import_checked(
    conn: &mut rusqlite::Connection,
    snap: &ImportSnapshot,
) -> Result<ImportApplied, CommandError> {
    if snap.format_version != 1 {
        return Err(CommandError(format!("unsupported formatVersion {}", snap.format_version)));
    }
    let tx = conn.transaction()?;
    let mut providers = 0usize;
    let mut keys = 0usize;
    for p in &snap.providers {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM providers WHERE id=?1 OR slug=?2",
            params![p.id, p.slug],
            |r| r.get(0),
        )?;
        if exists > 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO providers (id, slug, name, type, base_url, status, rotation_strategy, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,'draft',?6,?7,?8)",
            params![p.id, p.slug, p.name, p.r#type, p.base_url, p.rotation_strategy, p.created_at, p.updated_at],
        )?;
        providers += 1;
    }
    for k in &snap.keys {
        let exists: i64 =
            tx.query_row("SELECT COUNT(*) FROM api_keys WHERE id=?1", params![k.id], |r| r.get(0))?;
        if exists > 0 {
            continue;
        }
        // Only import keys whose provider exists (skipped or new).
        let has_provider: i64 = tx.query_row(
            "SELECT COUNT(*) FROM providers WHERE id=?1",
            params![k.provider_id],
            |r| r.get(0),
        )?;
        if has_provider == 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO api_keys (id, provider_id, label, secret_ref, secret_hint, status, priority, cooldown_until, added_at) VALUES (?1,?2,?3,?4,?5,'invalid',0,NULL,?6)",
            params![k.id, k.provider_id, k.label, k.secret_ref, k.secret_hint, now_ms()],
        )?;
        keys += 1;
    }
    for m in &snap.manifests {
        let has_provider: i64 = tx.query_row(
            "SELECT COUNT(*) FROM providers WHERE id=?1",
            params![m.provider_id],
            |r| r.get(0),
        )?;
        if has_provider == 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO manifests (id, provider_id, version, origin, body_json, created_at, is_active) VALUES (?1,?2,?3,?4,?5,?6,0) ON CONFLICT(provider_id, version) DO UPDATE SET body_json=excluded.body_json",
            params![m.id, m.provider_id, m.version, m.origin, m.body_json, now_ms()],
        )?;
    }
    for a in &snap.aliases {
        // never overwrite a live alias on this machine; imported providers only
        let has_provider: i64 = tx.query_row(
            "SELECT COUNT(*) FROM providers WHERE id=?1",
            params![a.provider_id],
            |r| r.get(0),
        )?;
        if has_provider == 0 {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO model_aliases (alias, provider_id, native_model_id, priority) VALUES (?1,?2,?3,?4)",
            params![a.alias, a.provider_id, a.native_model_id, a.priority],
        )?;
    }
    for s in &snap.settings {
        if s.key == "gateway" {
            continue; // never import port/gateway settings (machine-local)
        }
        tx.execute(
            "INSERT INTO settings (key, value_json) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            params![s.key, s.value_json],
        )?;
    }
    tx.commit()?;
    Ok(ImportApplied { providers, keys })
}

#[derive(Serialize)]
pub struct ImportApplied {
    pub providers: usize,
    pub keys: usize,
}

/// Diagnostics bundle: scrubbed recent state for bug reports — no request/response bodies,
/// no header values, no secrets (invariants 1-2 hold because this reads rows, never vault).
#[cfg(feature = "app")]
#[tauri::command]
pub fn diagnostics_bundle(store: State<'_, Arc<Store>>) -> Result<String, CommandError> {
    let conn = store.conn.lock().unwrap();
    Ok(diagnostics_json(&conn)?)
}

#[cfg(feature = "app")]
fn diagnostics_json(conn: &rusqlite::Connection) -> Result<String, rusqlite::Error> {
    // Scrubbed bug-report bundle: ledger rows + drift events + schema version.
    // No bodies, no header values, no secrets — only stored columns (req. 14).
    let recent: Vec<Value>;
    {
        let mut stmt = conn.prepare(
            "SELECT ts, modality, source, COALESCE(provider_id,''), model, status, COALESCE(error_class,''), COALESCE(latency_ms,0), COALESCE(fallback_chain_json,'[]') FROM ledger ORDER BY ts DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |r| {
            let chain: String = r.get(8)?;
            Ok(json!({
                "ts": r.get::<_, i64>(0)?, "modality": r.get::<_, String>(1)?,
                "source": r.get::<_, String>(2)?, "providerId": r.get::<_, String>(3)?,
                "model": r.get::<_, String>(4)?, "status": r.get::<_, String>(5)?,
                "errorClass": r.get::<_, String>(6)?, "latencyMs": r.get::<_, i64>(7)?,
                "chain": serde_json::from_str::<Value>(&chain).unwrap_or(Value::Null),
            }))
        })?;
        recent = rows.collect::<Result<Vec<_>, _>>()?;
    }
    let drift: Vec<Value>;
    {
        let mut stmt = conn.prepare(
            "SELECT provider_id, detected_at, COALESCE(trigger_json,'{}'), COALESCE(resolution,'') FROM drift_events ORDER BY detected_at DESC LIMIT 50",
        )?;
        drift = stmt
            .query_map([], |r| {
                let trig: String = r.get(2)?;
                Ok(json!({
                    "providerId": r.get::<_, String>(0)?, "detectedAt": r.get::<_, i64>(1)?,
                    "trigger": serde_json::from_str::<Value>(&trig).unwrap_or(Value::Null),
                    "resolution": r.get::<_, String>(3)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }
    let ver: i64 = conn
        .query_row("SELECT COALESCE(MAX(version),0) FROM schema_version", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(json!({
        "generatedAt": now_ms(),
        "schemaVersion": ver,
        "recentRequests": recent,
        "driftEvents": drift,
    })
    .to_string())
}

// Every test here exercises an app-gated reader (`list_generator_audit`), so the module carries the same
// gate. Without it the test target cannot compile under `--no-default-features --all-targets`,
// which is the configuration that proves `core/` is Tauri-free — see D17.
#[cfg(all(test, feature = "app"))]
mod generator_audit_tests {
    use super::*;

    fn tmp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-gen-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    /// Insert with an **explicit** timestamp. `now_ms()` on two consecutive calls usually lands in the
    /// same millisecond, so a test that let the host stamp these could not tell the ordering rule from
    /// the tiebreak rule.
    fn record_at(store: &Store, model: &str, ts: i64) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO generator_audit (ts, model_used, prompt_tokens, completion_tokens, redaction_hash) \
             VALUES (?1,?2,?3,?4,?5)",
            params![ts, model, 10i64, 20i64, "deadbeef"],
        )
        .unwrap();
    }

    #[test]
    fn the_newest_generation_comes_first() {
        let (store, dir) = tmp_store("order");
        record_at(&store, "oldest", 1_000);
        record_at(&store, "middle", 2_000);
        record_at(&store, "newest", 3_000);

        let got = list_generator_audit(&store, 10).unwrap();
        assert_eq!(
            got.iter().map(|e| e.model_used.as_str()).collect::<Vec<_>>(),
            vec!["newest", "middle", "oldest"]
        );
        // The read shape carries the host's stamp, which the write shape deliberately cannot set.
        assert_eq!(got[0].ts_ms, 3_000);
        assert!(got[0].id > got[2].id, "ids are the rowid and increase with insertion");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two generations in the same millisecond are ordinary — a repair plan and its patch, or two
    /// candidates in one wizard run. Ordering on the clock alone would leave their order to SQLite.
    #[test]
    fn a_tie_on_the_timestamp_is_broken_by_the_newer_row() {
        let (store, dir) = tmp_store("tie");
        record_at(&store, "first", 5_000);
        record_at(&store, "second", 5_000);

        let got = list_generator_audit(&store, 10).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].model_used, "second", "the later insert wins the tie");
        assert_eq!(got[1].model_used, "first");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_limit_keeps_the_newest_and_drops_the_rest() {
        let (store, dir) = tmp_store("limit");
        record_at(&store, "one", 1_000);
        record_at(&store, "two", 2_000);
        record_at(&store, "three", 3_000);

        let got = list_generator_audit(&store, 2).unwrap();
        assert_eq!(
            got.iter().map(|e| e.model_used.as_str()).collect::<Vec<_>>(),
            vec!["three", "two"],
            "a tail read that dropped the recent end would be useless"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same floor as `gateway_log_tail`: a caller asking for nothing is a bug, and the newest
    /// entry is the more useful reading of it. Two readers of two trails on one screen must not
    /// disagree about what `limit: 0` means.
    #[test]
    fn a_zero_limit_still_returns_one_entry() {
        let (store, dir) = tmp_store("zero");
        record_at(&store, "only", 1_000);
        assert_eq!(list_generator_audit(&store, 0).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The ceiling is a real bound, not a comment: asking for more than `AUDIT_MAX_LIMIT` must return
    /// the cap rather than the table.
    #[test]
    fn the_ceiling_is_enforced() {
        let (store, dir) = tmp_store("ceiling");
        {
            let conn = store.conn.lock().unwrap();
            for i in 0..(AUDIT_MAX_LIMIT + 1) {
                conn.execute(
                    "INSERT INTO generator_audit (ts, model_used, prompt_tokens, completion_tokens, redaction_hash) \
                     VALUES (?1,?2,?3,?4,?5)",
                    params![i as i64, "m", 1i64, 1i64, "h"],
                )
                .unwrap();
            }
        }

        let got = list_generator_audit(&store, 10_000).unwrap();
        assert_eq!(got.len(), AUDIT_MAX_LIMIT);
        // The newest survived the cap, which is the point of capping the read rather than the write.
        assert_eq!(got[0].ts_ms, AUDIT_MAX_LIMIT as i64);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_trail_is_empty_not_an_error() {
        let (store, dir) = tmp_store("empty");
        assert!(list_generator_audit(&store, 50).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// Every test here exercises an app-gated reader (`list_drift_events`), so the module carries the same
// gate. Without it the test target cannot compile under `--no-default-features --all-targets`,
// which is the configuration that proves `core/` is Tauri-free — see D17.
#[cfg(all(test, feature = "app"))]
mod drift_history_tests {
    use super::*;

    /// `foreign_keys` is ON (`store.rs:508`), so the FK to `providers` is enforced and a drift row cannot
    /// exist without its provider. Seeding one is a precondition of every test here, not scaffolding for
    /// one of them.
    fn tmp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-drift-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir).unwrap();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO providers (id, slug, name, base_url, created_at, updated_at) \
                 VALUES ('p','p-slug','P','https://x',0,0)",
                [],
            )
            .unwrap();
        }
        (store, dir)
    }

    /// Insert with an **explicit** timestamp. `now_ms()` on two consecutive calls usually lands in the
    /// same millisecond, so a test that let the host stamp these could not tell the ordering rule from
    /// the tiebreak rule.
    fn event_at(store: &Store, ts: i64, trigger: &str) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO drift_events (provider_id, detected_at, trigger_json) VALUES ('p',?1,?2)",
            params![ts, trigger],
        )
        .unwrap();
    }

    fn resolve_open(store: &Store, resolution: &str, ts: i64) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "UPDATE drift_events SET resolution=?1, resolved_at=?2 WHERE resolution IS NULL",
            params![resolution, ts],
        )
        .unwrap();
    }

    #[test]
    fn the_newest_drift_event_comes_first() {
        let (store, dir) = tmp_store("order");
        event_at(&store, 1_000, r#"{"errors":5}"#);
        event_at(&store, 2_000, r#"{"errors":6}"#);
        event_at(&store, 3_000, r#"{"errors":7}"#);

        let got = list_drift_events(&store, 10).unwrap();
        assert_eq!(
            got.iter().map(|e| e.detected_at).collect::<Vec<_>>(),
            vec![3_000, 2_000, 1_000]
        );
        assert_eq!(got[0].trigger_json, r#"{"errors":7}"#);
        assert!(got[0].id > got[2].id, "ids are the rowid and increase with insertion");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A detection and the repair that answers it can land in one millisecond. Ordering on the clock
    /// alone would leave their order to SQLite.
    #[test]
    fn a_tie_on_the_detection_time_is_broken_by_the_newer_row() {
        let (store, dir) = tmp_store("tie");
        event_at(&store, 5_000, r#"{"errors":1}"#);
        event_at(&store, 5_000, r#"{"errors":2}"#);

        let got = list_drift_events(&store, 10).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].trigger_json, r#"{"errors":2}"#, "the later insert wins the tie");
        assert_eq!(got[1].trigger_json, r#"{"errors":1}"#);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The distinction the row exists for. An open event and a repaired one must not read alike, and
    /// neither may read as a *missing* value — `None` here means "still drifting", not "unknown".
    #[test]
    fn an_open_event_is_unresolved_and_a_repaired_one_carries_its_resolution() {
        let (store, dir) = tmp_store("resolution");
        event_at(&store, 1_000, r#"{"errors":5}"#);
        event_at(&store, 2_000, r#"{"errors":5}"#);
        resolve_open(&store, "repaired v2", 3_000);

        let got = list_drift_events(&store, 10).unwrap();
        assert_eq!(got.len(), 2);
        // Both were open, so both were resolved by the same statement — the host's own semantics.
        assert!(got.iter().all(|e| e.resolution.as_deref() == Some("repaired v2")));
        assert!(got.iter().all(|e| e.resolved_at == Some(3_000)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `trigger_json` is nullable, and the other reader of this table coalesces. A NULL must not drop
    /// the row from the trail or fail the whole call — losing the event is the exact failure this
    /// reader exists to prevent.
    #[test]
    fn a_null_trigger_reads_as_an_empty_object_rather_than_failing() {
        let (store, dir) = tmp_store("nulltrigger");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO drift_events (provider_id, detected_at, trigger_json) VALUES ('p',1,NULL)",
                [],
            )
            .unwrap();
        }

        let got = list_drift_events(&store, 10).unwrap();
        assert_eq!(got.len(), 1, "the row is kept, not dropped");
        assert_eq!(got[0].trigger_json, "{}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The same floor as `gateway_log_tail` and `list_generator_audit`. Three readers of three trails
    /// on one screen must not disagree about what `limit: 0` means.
    #[test]
    fn a_zero_limit_still_returns_one_entry() {
        let (store, dir) = tmp_store("zero");
        event_at(&store, 1_000, "{}");
        assert_eq!(list_drift_events(&store, 0).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The ceiling is a real bound, not a comment: asking for more than `DRIFT_MAX_LIMIT` must return
    /// the cap rather than the table.
    #[test]
    fn the_ceiling_is_enforced() {
        let (store, dir) = tmp_store("ceiling");
        {
            let conn = store.conn.lock().unwrap();
            for i in 0..(DRIFT_MAX_LIMIT + 1) {
                conn.execute(
                    "INSERT INTO drift_events (provider_id, detected_at, trigger_json) VALUES ('p',?1,'{}')",
                    params![i as i64],
                )
                .unwrap();
            }
        }

        let got = list_drift_events(&store, 10_000).unwrap();
        assert_eq!(got.len(), DRIFT_MAX_LIMIT);
        // The newest survived the cap, which is the point of capping the read rather than the write.
        assert_eq!(got[0].detected_at, DRIFT_MAX_LIMIT as i64);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_history_is_empty_not_an_error() {
        let (store, dir) = tmp_store("empty");
        assert!(list_drift_events(&store, 50).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
