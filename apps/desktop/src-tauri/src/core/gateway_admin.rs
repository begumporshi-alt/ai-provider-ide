//! Admin HTTP routes for the gateway (dev-book §10 §5.3, and the CRUD routes Phase 6 step 4 adds).
//!
//! These are the routes the UI calls instead of `invoke`. Under the settled §10 decision 2 —
//! **pure HTTP** — the UI is a client like any other, and these handlers are the whole of what it
//! can reach. They live in `core/` because the headless service (`aiproviderd`) serves them too:
//! a route that only existed inside the Tauri app would be unavailable the moment the app stops
//! running its own gateway, which is the exact state Phase 6 is moving toward.
//!
//! **Authentication is the external one, not a new one.** Every handler calls the same
//! `check_gateway_key` the `/v1/*` routes use, so a caller needs the master key (or an app key)
//! and gets the same refusals. The UI holds the master key in memory for the session — see the
//! decision entry in §10.
//!
//! **The store is optional and that is not an error to hide.** `GatewayCore::store()` is `None`
//! for cores built without one (every existing test). A route that needs it answers 503 naming
//! itself, rather than panicking or answering an empty list that looks like "nothing configured".
//!
//! **These routes do not touch the clipboard.** The IPC `gateway_app_key_create` copied the new
//! secret to the clipboard and returned only metadata, because a headless process has no clipboard
//! and the secret had to reach the user somehow. Here the secret is **returned once** in the
//! response and the UI copies it — one behaviour for both the in-app and headless case, and the
//! clipboard stays a UI concern.
//!
//! **The settings write is a merge, not a replace.** `settings_set` is a whole-row UPSERT, so a
//! caller that writes only the keys it knows erases the rest — the loss the `gateway` settings
//! row is most exposed to, because it is one JSON object shared by the listener, the tool
//! switches, and whatever comes next. The merge lived in TypeScript (`patchGatewaySettings`);
//! moving it here makes it atomic instead of a read-modify-write across the network.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use crate::core::context;
use crate::core::gateway::{
    check_gateway_key, err, openai_error, peer_ip, GatewayCore, APP_KEY_PREFIX,
};
use crate::core::memory;
use crate::core::persist;
use crate::core::store::Store;

/// The settings row these routes own. The listener (`port`, `enabled`) and the tool switches
/// share one object — see the module note on why the write merges.
const GATEWAY_SETTINGS_KEY: &str = "gateway";

/// One per-app key as the screen needs it: the stored metadata, plus the two numbers the budget
/// control renders.
///
/// `monthMicros` is joined here rather than fetched per row by the UI, so listing the keys stays
/// one grouped query instead of one per key — the shape that makes a screen's cost scale with the
/// number of apps configured.
///
/// A field on this struct is not wiring: `store.ts` reads `capMicros` and `monthMicros`, and a
/// rename here would leave the screen rendering `undefined` with nothing failing to compile.
/// `web-test/shim.ts` carries the same shape, which is what makes the pair checkable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppKeyView {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    /// 0017: this app's own monthly budget in micro-USD. `None` = uncapped.
    pub cap_micros: Option<i64>,
    /// Month-to-date spend attributed to this app. Zero for a key that has not served a request
    /// since attribution landed — not an error, and not evidence the key is unused.
    pub month_micros: i64,
}

/// What `POST /admin/keys` returns: the metadata **and the secret, exactly once**.
///
/// The secret is the only copy that will ever exist — it is stored in the keychain, not in SQLite,
/// and this response is the one moment it crosses the wire. The UI copies it to the clipboard and
/// must not persist it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppKeyCreated {
    pub id: String,
    pub label: String,
    /// Present once, in this response only. Never stored in SQLite (invariant 14).
    pub secret: String,
}

/// 0017: monthly spend, this calendar month (UTC), against the global cap.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendStatus {
    /// Micro-USD spent this calendar month (UTC).
    pub month_micros: i64,
    /// Configured cap; 0 = disabled.
    pub cap_micros: i64,
    pub capped: bool,
}

/// The store a route needs, or a 503 that names the route.
///
/// Deliberately a 503 and not a panic: `GatewayCore::store()` is `None` for every core built by
/// `new()` without `with_store`, which is most of the existing test suite. A route reached on such
/// a core is misconfigured, and the caller must be able to tell that apart from "empty".
/// The `Err` variant is boxed: an axum `Response` is large enough that returning it inline trips
/// `clippy::result_large_err`, and a guard that refuses is the common case here, not a rare one.
fn require_store<'a>(core: &'a GatewayCore, route: &str) -> Result<&'a Arc<Store>, Box<Response>> {
    match core.store() {
        Some(s) => Ok(s),
        None => Err(Box::new(err(
            StatusCode::SERVICE_UNAVAILABLE,
            openai_error(
                &format!("{route} is unavailable: this gateway was started without a store"),
                "service_unavailable",
                Some("no_store"),
            ),
        ))),
    }
}

/// Authenticate and resolve the store — the two things every admin route opens with.
fn authorize(core: &GatewayCore, headers: &HeaderMap) -> Result<(), Box<Response>> {
    // Identity discarded: none of these routes dispatch a request, so none of them bill anyone.
    // The check is still made, because an unauthenticated answer is a statement that the route
    // exists — the reason the 404 and 405 refusals authenticate too.
    check_gateway_key(core, headers, peer_ip(headers)).map_err(|r| Box::new(r.openai()))?;
    Ok(())
}

fn admin_error(status: StatusCode, message: &str, code: Option<&str>) -> Response {
    err(status, openai_error(message, "invalid_request", code))
}

// ── GET /admin/settings ────────────────────────────────────────────────────

/// The gateway settings row, as an object. `{}` when there is no row, and `{}` when the row is
/// unparseable — a corrupt row must not take a screen down, and it must not be reported as an
/// error either, because there is nothing the caller can do about it.
pub async fn settings_get_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/settings") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    (StatusCode::OK, Json(read_gateway_settings(store))).into_response()
}

/// The stored gateway settings, defaulting to an empty object on absence **or** corruption.
///
/// Both collapse to `{}` on purpose. They are different faults, but the caller's recovery is the
/// same (treat every field as unset), and distinguishing them here would put a "your settings are
/// corrupt" decision in a function with no screen to show it on.
pub(crate) fn read_gateway_settings(store: &Store) -> Value {
    let conn = store.conn.lock().unwrap();
    let raw: Option<String> = conn
        .query_row("SELECT value_json FROM settings WHERE key = ?", [GATEWAY_SETTINGS_KEY], |r| {
            r.get(0)
        })
        .ok();
    drop(conn);
    match raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        Some(Value::Object(o)) => Value::Object(o),
        _ => json!({}),
    }
}

// ── POST /admin/settings ───────────────────────────────────────────────────

/// Merge a patch into the gateway settings row and answer with the result.
///
/// The merge is the point, and it is here rather than in TypeScript because the row is one object
/// shared by unrelated concerns. A client-side merge is a read-modify-write across the network:
/// two admin writes in flight lose one, and the loser is a field neither writer mentioned.
pub async fn settings_set_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(patch): Json<Value>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/settings") {
        Ok(s) => s,
        Err(r) => return *r,
    };

    let Value::Object(patch) = patch else {
        return admin_error(
            StatusCode::BAD_REQUEST,
            "POST /admin/settings expects a JSON object",
            Some("not_an_object"),
        );
    };

    let mut current = match read_gateway_settings(store) {
        Value::Object(o) => o,
        _ => serde_json::Map::new(),
    };
    for (k, v) in patch {
        current.insert(k, v);
    }
    let merged = Value::Object(current);

    let written = serde_json::to_string(&merged).unwrap_or_else(|_| "{}".to_string());
    let conn = store.conn.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![GATEWAY_SETTINGS_KEY, written],
    );
    drop(conn);
    match res {
        Ok(_) => (StatusCode::OK, Json(merged)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not write the gateway settings: {e}"),
            Some("settings_write_failed"),
        ),
    }
}

// ── GET /admin/keys ────────────────────────────────────────────────────────

pub async fn keys_list_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/keys") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let rows = match persist::gateway_keys_list(store) {
        Ok(r) => r,
        Err(e) => {
            return admin_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("could not list app keys: {e}"),
                Some("keys_list_failed"),
            )
        }
    };
    let spend = persist::month_spend_by_app(store);
    let views: Vec<AppKeyView> = rows
        .into_iter()
        .map(|k| AppKeyView {
            month_micros: spend.get(&k.id).copied().unwrap_or(0),
            id: k.id,
            label: k.label,
            created_at: k.created_at,
            last_used_at: k.last_used_at,
            revoked_at: k.revoked_at,
            cap_micros: k.cap_micros,
        })
        .collect();
    (StatusCode::OK, Json(views)).into_response()
}

// ── POST /admin/keys ───────────────────────────────────────────────────────

/// Create a per-app key: crypto-random secret -> keychain -> SQLite row -> returned once.
///
/// The ordering is the IPC command's, and the rollbacks are why: a secret with no row is an
/// unrevokable ghost, and a row with no secret is a credential nobody holds. There is no
/// clipboard step here — see the module note.
pub async fn key_create_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/keys") {
        Ok(s) => s,
        Err(r) => return *r,
    };

    let label = match body.get("label").and_then(|v| v.as_str()) {
        Some(l) if !l.trim().is_empty() => l.to_string(),
        _ => {
            return admin_error(
                StatusCode::BAD_REQUEST,
                "POST /admin/keys requires a non-empty `label`",
                Some("missing_label"),
            )
        }
    };

    let id = format!("ak-{}", uuid_like());
    let secret = crate::core::gateway::generate_random_key();
    let account = format!("{APP_KEY_PREFIX}{id}");

    if let Err(e) = crate::core::vault::put(&account, &secret) {
        return admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not store the key in the keychain: {e}"),
            Some("keychain_write_failed"),
        );
    }
    if let Err(e) = persist::gateway_key_insert(store, &id, &label) {
        // Roll back the keychain entry: a secret with no row is an unrevokable ghost.
        let _ = crate::core::vault::delete(&account);
        return admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not record the key: {e}"),
            Some("key_insert_failed"),
        );
    }
    // No provider refresh needed: the key provider re-reads the active ids per request, so the
    // new key works on the very next call without a restart.
    (StatusCode::OK, Json(AppKeyCreated { id, label, secret })).into_response()
}

/// Short random id — not security-sensitive (the secret is the key), just collision-resistant.
fn uuid_like() -> String {
    use rand::Rng as _;
    (0..16).map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16))).collect()
}

// ── DELETE /admin/keys/:id ─────────────────────────────────────────────────

/// Revoke one app key. Takes effect on the next request — the master key and every other app key
/// are untouched, which is the whole point (audit R4).
pub async fn key_revoke_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "DELETE /admin/keys/:id") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::gateway_key_revoke(store, &id) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not revoke the key: {e}"),
            Some("key_revoke_failed"),
        ),
    }
}

// ── GET /admin/spend ───────────────────────────────────────────────────────

// ── Config CRUD: providers ─────────────────────────────────────────────────
//
// Provider writes are the one kind of config CRUD that is not a pure row change: the egress
// allowlist derives from `providers.base_url`, so a row written without updating it produces a
// provider the gateway will refuse to dial. That is D46's divergence, created by the CRUD path
// rather than by a stale manifest, which is why `GatewayCore` carries the list.

pub async fn providers_list_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/providers") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::providers_rows(store) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list providers: {e}"),
            Some("providers_list_failed"),
        ),
    }
}

pub async fn provider_upsert_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(p): Json<persist::ProviderRow>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/providers") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    if let Err(e) = persist::provider_upsert_row(store, &p) {
        return admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not write the provider: {e}"),
            Some("provider_upsert_failed"),
        );
    }
    if let Some(allow) = core.allowlist() {
        persist::sync_allow_for_provider(allow, store, &p.id);
    }
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

pub async fn provider_delete_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "DELETE /admin/providers/{id}") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let secret_refs = match persist::provider_delete_row(store, &id) {
        Ok(v) => v,
        Err(e) => {
            return admin_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("could not delete the provider: {e}"),
                Some("provider_delete_failed"),
            )
        }
    };
    // §7 hygiene: the SQL cascade removed the key rows, so the keychain entries go too.
    for account in secret_refs {
        let _ = crate::core::vault::delete(&account);
    }
    // A stale grant must not survive the row it came from (invariant 9).
    if let Some(allow) = core.allowlist() {
        persist::recompute_allow(allow, store);
    }
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

pub async fn spend_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/spend") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let month = persist::month_spend_micros(store);
    let cap = persist::spend_cap_micros(store).unwrap_or(0);
    (
        StatusCode::OK,
        Json(SpendStatus { month_micros: month, cap_micros: cap, capped: cap > 0 && month >= cap }),
    )
        .into_response()
}

// ── Config CRUD: api-keys ──────────────────────────────────────────────────

pub async fn api_keys_list_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/api-keys") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::api_keys_rows(store, None) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list api keys: {e}"),
            Some("api_keys_list_failed"),
        ),
    }
}

pub async fn api_key_upsert_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(k): Json<persist::ApiKeyRow>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/api-keys") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::api_key_upsert_row(store, &k) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not write the api key: {e}"),
            Some("api_key_upsert_failed"),
        ),
    }
}

pub async fn api_key_delete_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "DELETE /admin/api-keys/{id}") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::api_key_delete_row(store, &id) {
        Ok(secret_ref) => {
            if let Some(account) = secret_ref {
                let _ = crate::core::vault::delete(&account);
            }
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not delete the api key: {e}"),
            Some("api_key_delete_failed"),
        ),
    }
}

// ── Config CRUD: manifests ─────────────────────────────────────────────────

pub async fn manifests_list_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/manifests") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::manifests_active_rows(store) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list manifests: {e}"),
            Some("manifests_list_failed"),
        ),
    }
}

pub async fn manifest_upsert_active_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(m): Json<persist::ManifestRow>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/manifests") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::manifest_upsert_active_row(store, &m) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not write the manifest: {e}"),
            Some("manifest_upsert_failed"),
        ),
    }
}

#[derive(Deserialize)]
pub struct ManifestActivateBody {
    pub version: i64,
}

pub async fn manifest_activate_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ManifestActivateBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/manifests/{id}/activate") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::manifest_activate_row(store, &id, body.version) {
        Ok(previous) => {
            (StatusCode::OK, Json(json!({ "previousVersion": previous }))).into_response()
        }
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not activate the manifest: {e}"),
            Some("manifest_activate_failed"),
        ),
    }
}

// ── Config CRUD: models cache ──────────────────────────────────────────────

pub async fn models_cache_list_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/models-cache") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::models_cache_rows(store) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list models cache: {e}"),
            Some("models_cache_list_failed"),
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsCacheReplaceBody {
    pub provider_id: String,
    pub rows: Vec<persist::ModelRow>,
}

pub async fn models_cache_replace_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<ModelsCacheReplaceBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/models-cache") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::models_cache_replace_rows(store, &body.provider_id, &body.rows) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not replace the models cache: {e}"),
            Some("models_cache_replace_failed"),
        ),
    }
}

// ── Config CRUD: aliases ───────────────────────────────────────────────────

pub async fn aliases_list_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/aliases") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::aliases_rows(store) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list aliases: {e}"),
            Some("aliases_list_failed"),
        ),
    }
}

pub async fn aliases_replace_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(rows): Json<Vec<persist::AliasRow>>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/aliases") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match persist::aliases_replace_rows(store, &rows) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not replace aliases: {e}"),
            Some("aliases_replace_failed"),
        ),
    }
}

// ── Config CRUD: ledger ────────────────────────────────────────────────────

pub async fn ledger_recent_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/ledger") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let limit = params.get("limit").and_then(|s| s.parse::<i64>().ok());
    match persist::ledger_recent_rows(store, limit) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not read the ledger: {e}"),
            Some("ledger_read_failed"),
        ),
    }
}

// ── Memory (P7) ────────────────────────────────────────────────────────────
//
// Memory is service-owned, not app-owned. `core/memory.rs` and `core/context_scope.rs` are both
// Rust and both available to the headless binary, and the gateway already injects a memory block
// at system position 0 on every request (§5.5, the `AIP-Memory` header). So the headless service
// could *use* memory before these routes existed; what it could not do is let anyone *manage* it.
//
// **Two spellings on one surface, and it is not a mistake.** The `persist::*` rows above are
// camelCase (symmetric read+write registry rows). `memory::MemoryInput` is **snake_case with
// `deny_unknown_fields`** — see the note on that struct: serde's default silently turns a
// misspelled key into `None`, which is exactly how `memory_capture_batch` dropped `session_id`
// for months and disabled the per-session ring cap in `prune`. These routes reuse the struct
// rather than reshaping it, so the wire spelling cannot drift from the one the tests pin.
//
// **Capture is not injection.** A row is born `Unscoped`, which is capture-only and never
// injected; `assign_scope` is the only way in, and it is a deliberate human act. Nothing here
// auto-binds — an auto-bound atom would make the header-less client degrade to global.

/// `GET /admin/memory` — the Memory screen's list, filtered by layer.
///
/// The query is read as a raw map for the same reason as `memory_session_atoms_h`: a typed
/// `Query` extractor rejects before `authorize` ever runs, so a malformed query would be answered
/// by a route that has not checked who is asking.
pub async fn memory_list_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/memory") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let layer = params.get("layer").map(|s| s.as_str());
    let limit = params.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200);
    match memory::list(store, layer, limit) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list memories: {e}"),
            Some("memory_list_failed"),
        ),
    }
}

/// `POST /admin/memory` — capture one. The body is `memory::MemoryInput` verbatim.
pub async fn memory_capture_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(input): Json<memory::MemoryInput>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::capture(store, &input) {
        Ok(m) => (StatusCode::OK, Json(m)).into_response(),
        Err(e) => admin_error(
            StatusCode::BAD_REQUEST,
            &format!("could not capture the memory: {e}"),
            Some("memory_capture_failed"),
        ),
    }
}

/// `POST /admin/memory/batch` — capture several in one transaction.
pub async fn memory_capture_batch_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(items): Json<Vec<memory::MemoryInput>>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/batch") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::capture_batch(store, &items) {
        Ok(n) => (StatusCode::OK, Json(json!({ "captured": n }))).into_response(),
        Err(e) => admin_error(
            StatusCode::BAD_REQUEST,
            &format!("could not capture the memories: {e}"),
            Some("memory_capture_batch_failed"),
        ),
    }
}

/// `POST /admin/memory/recall` — BM25 recall. A POST because `layers` is an array; a GET would
/// force it into a delimiter-encoded string for no reason.
#[derive(Deserialize)]
pub struct MemoryRecallBody {
    pub query: String,
    pub limit: Option<usize>,
    pub layers: Option<Vec<String>>,
}

pub async fn memory_recall_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<MemoryRecallBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/recall") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::recall(store, &body.query, body.limit.unwrap_or(8), body.layers.as_deref()) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not recall: {e}"),
            Some("memory_recall_failed"),
        ),
    }
}

/// `DELETE /admin/memory/{id}` — forget one.
pub async fn memory_forget_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "DELETE /admin/memory/{id}") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::forget(store, &id) {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not forget the memory: {e}"),
            Some("memory_forget_failed"),
        ),
    }
}

/// `PUT /admin/memory/{id}` — rewrite the text of one.
#[derive(Deserialize)]
pub struct MemoryUpdateBody {
    pub text: String,
}

pub async fn memory_update_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MemoryUpdateBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "PUT /admin/memory/{id}") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::update(store, &id, &body.text) {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not update the memory: {e}"),
            Some("memory_update_failed"),
        ),
    }
}

/// `POST /admin/memory/{id}/pin` — pinning exempts a row from retention.
#[derive(Deserialize)]
pub struct MemoryPinBody {
    pub pinned: bool,
}

pub async fn memory_set_pinned_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MemoryPinBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/{id}/pin") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::set_pinned(store, &id, body.pinned) {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not pin the memory: {e}"),
            Some("memory_pin_failed"),
        ),
    }
}

/// `POST /admin/memory/{id}/scope` — the review surface. Flat, not a tagged enum, for the same
/// reason `MemoryScopeInput` is: a Rust enum variant is an awkward thing to construct in TS.
#[derive(Deserialize)]
pub struct MemoryScopeBody {
    /// `project` | `global` | `unscoped`.
    pub kind: String,
    pub project: Option<String>,
    pub agent: Option<String>,
}

pub async fn memory_assign_scope_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MemoryScopeBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/{id}/scope") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let assignment = match body.kind.trim().to_ascii_lowercase().as_str() {
        // An absent project falls through to `assign_scope`'s own "project scope is empty"
        // refusal rather than being silently defaulted here.
        "project" => memory::ScopeAssignment::Project {
            project: body.project.unwrap_or_default(),
            agent: body.agent,
        },
        "global" => memory::ScopeAssignment::Global,
        "unscoped" => memory::ScopeAssignment::Unscoped,
        other => {
            return admin_error(
                StatusCode::BAD_REQUEST,
                &format!("unknown scope kind '{other}'"),
                Some("unknown_scope_kind"),
            )
        }
    };
    match memory::assign_scope(store, &id, assignment) {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::BAD_REQUEST,
            &format!("could not bind the memory: {e}"),
            Some("memory_scope_failed"),
        ),
    }
}

/// `GET /admin/memory/session/{session_id}` — one session's atoms, which is what the per-session
/// ring cap in `prune` keys on.
///
/// The query is read as a raw map rather than a typed struct **because an extractor runs before
/// the handler body**. A typed `Query<{ layer: String }>` rejects a request with no `layer` with a
/// 400 that never reaches `authorize` — so a malformed request gets an answer from a route that
/// has not checked who is asking. Parsing after auth keeps the rule the auth test pins: nothing
/// on this surface answers before it authenticates.
pub async fn memory_session_atoms_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/memory/session/{session_id}") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let Some(layer) = params.get("layer").map(|s| s.as_str()) else {
        return admin_error(
            StatusCode::BAD_REQUEST,
            "GET /admin/memory/session/{session_id} needs a `layer`",
            Some("missing_layer"),
        );
    };
    let limit = params.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200);
    match memory::session_atoms(store, &session_id, layer, limit) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not read the session's atoms: {e}"),
            Some("memory_session_failed"),
        ),
    }
}

/// `DELETE /admin/memory` — wipe the table. No scope filter, and that is the point: a partial
/// clear would leave the operator unable to say what is still remembered.
pub async fn memory_clear_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "DELETE /admin/memory") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::clear(store) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not clear memory: {e}"),
            Some("memory_clear_failed"),
        ),
    }
}

/// `GET /admin/memory/stats` — per-layer counts plus how many rows are actually injectable.
pub async fn memory_stats_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/memory/stats") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::stats(store) {
        Ok(s) => (StatusCode::OK, Json(s)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not read memory stats: {e}"),
            Some("memory_stats_failed"),
        ),
    }
}

/// §6.4.3 — mark one memory superseded by another. The old row is kept, not deleted.
#[derive(Deserialize)]
pub struct MemorySupersedeBody {
    pub old: String,
    pub new: String,
}

pub async fn memory_supersede_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<MemorySupersedeBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/supersede") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    // A pinned or L3 row is refused by `supersede` itself (§6.4.5), and that refusal is a 400
    // here rather than a silent false: the caller asked for an act the policy forbids.
    match memory::supersede(store, &body.old, &body.new) {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::BAD_REQUEST,
            &format!("could not supersede: {e}"),
            Some("memory_supersede_failed"),
        ),
    }
}

/// §6.4.3 — undo a supersession. The row was never deleted, so this only makes it reachable again.
pub async fn memory_unsupersede_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/{id}/unsupersede") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::unsupersede(store, &id) {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not unsupersede: {e}"),
            Some("memory_unsupersede_failed"),
        ),
    }
}

/// §6.4.5 — what the Memory screen has to put in front of a human.
pub async fn memory_conflicts_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/memory/conflicts") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::conflicts(store) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not read conflicts: {e}"),
            Some("memory_conflicts_failed"),
        ),
    }
}

/// §6.2 retention. A POST rather than something the request path does: pruning there would add a
/// second write to the hottest code in the app.
pub async fn memory_prune_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/prune") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::prune(store) {
        Ok(s) => (StatusCode::OK, Json(s)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not prune: {e}"),
            Some("memory_prune_failed"),
        ),
    }
}

/// Which client may use memory, independent of whether the machine does. The master switch still
/// beats every row here — turning memory off globally has to remain one unambiguous act.
pub async fn memory_principal_list_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/memory/principals") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match crate::core::gateway::principal::list(store) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list principals: {e}"),
            Some("principal_list_failed"),
        ),
    }
}

/// `enabled: null` returns the principal to inheriting the master switch.
#[derive(Deserialize)]
pub struct PrincipalPolicyBody {
    pub principal: String,
    pub enabled: Option<bool>,
}

pub async fn memory_principal_set_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<PrincipalPolicyBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/principals") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let res = match body.enabled {
        Some(on) => crate::core::gateway::principal::set(store, &body.principal, on),
        None => crate::core::gateway::principal::clear(store, &body.principal),
    };
    match res {
        Ok(v) => (StatusCode::OK, Json(json!({ "ok": v }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not set the principal policy: {e}"),
            Some("principal_set_failed"),
        ),
    }
}

// ── Context graph (P4) ─────────────────────────────────────────────────────
//
// Nodes and edges are recorded in one batch so a turn is never half-present. The gateway writes
// here during a request (`gateway_cmds.rs`), so the headless service needs the write path, not
// just the read.
//
// The History screen's own two commands (`history_sessions`, `history_timeline`) are deliberately
// **not** ported: 26e's scope correction measured them as app-owned UI state, not service data.

#[derive(Deserialize)]
pub struct ContextRecordBody {
    pub nodes: Vec<context::ContextNode>,
    pub edges: Vec<context::ContextEdge>,
}

pub async fn context_record_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<ContextRecordBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/context") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    // `context::record` refuses an unknown node kind, and that is a 400: the caller named a kind
    // the graph does not have, which is a caller error, not a server fault.
    match context::record(store, &body.nodes, &body.edges) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::BAD_REQUEST,
            &format!("could not record the context: {e}"),
            Some("context_record_failed"),
        ),
    }
}

pub async fn context_graph_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "GET /admin/context") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let limit = params.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200);
    match context::graph(store, limit) {
        Ok(g) => (StatusCode::OK, Json(g)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not read the context graph: {e}"),
            Some("context_graph_failed"),
        ),
    }
}

pub async fn context_clear_h(State(core): State<Arc<GatewayCore>>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&core, &headers) {
        return *r;
    }
    let store = match require_store(&core, "DELETE /admin/context") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match context::clear(store) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not clear the context graph: {e}"),
            Some("context_clear_failed"),
        ),
    }
}
