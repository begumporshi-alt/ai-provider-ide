//! Tauri command surface.
//!
//! Trust note (diff-review 2026-09-15): Tauri 2 capability files ACL plugin/core commands,
//! NOT app-defined commands — every command below is callable from the webview. The webview
//! is therefore treated as UNTRUSTED here: no raw secret reads, no allowlist mutation, no
//! raw SQL, vault accounts restricted to `key:*`, and egress pairs secret_ref to its own
//! provider host (see egress.rs).

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::context;
use crate::crash_report;
use crate::egress::{self, EgressRequest, EgressState, StreamEvent};
use crate::memory;
use crate::orchestrator;
use crate::skills;
use crate::store::{self, Store};
use crate::vault;

#[derive(Debug, serde::Serialize)]
pub struct CommandError(pub String);

impl From<egress::EgressError> for CommandError {
    fn from(e: egress::EgressError) -> Self {
        CommandError(e.to_string())
    }
}
impl From<vault::VaultError> for CommandError {
    fn from(e: vault::VaultError) -> Self {
        CommandError(e.to_string())
    }
}
impl From<crate::store::StoreError> for CommandError {
    fn from(e: crate::store::StoreError) -> Self {
        match e {
            crate::store::StoreError::Sql(inner) => CommandError(ui_db_error(&inner)),
            crate::store::StoreError::Io(inner) => {
                tracing::warn!("store io error (detail withheld from the UI): {inner}");
                CommandError(match inner.kind() {
                    std::io::ErrorKind::NotFound => {
                        "a required file or folder is missing".to_string()
                    }
                    std::io::ErrorKind::PermissionDenied => "permission was denied".to_string(),
                    std::io::ErrorKind::AlreadyExists => "that already exists".to_string(),
                    _ => "a file operation failed".to_string(),
                })
            }
            // A migration carries its own id, which is safe and is the one thing the operator
            // needs — the rest of the detail is SQL.
            crate::store::StoreError::Migration(id, detail) => {
                tracing::warn!("migration {id} failed: {detail}");
                CommandError(format!("migration {id} failed"))
            }
        }
    }
}
impl From<rusqlite::Error> for CommandError {
    fn from(e: rusqlite::Error) -> Self {
        CommandError(ui_db_error(&e))
    }
}

/// What the webview is told when the store fails.
///
/// rusqlite's `Display` is honest, and that is exactly the problem — measured, not assumed:
///
/// | failure | `e.to_string()` |
/// |---|---|
/// | cannot open | `unable to open database file: /Users/<account>/Library/…/ai-provider-router.db` |
/// | bad SQL | `near "FROM": syntax error in SELECT FROM WHERE at offset 7` |
/// | missing column | `no such column: nope in SELECT nope FROM t at offset 7` |
///
/// All three carry something the person using the app does not need: an absolute path that
/// names the account, or the schema's own table and column names. None of it helps them decide
/// what to do next. So the detail is logged host-side and the boundary returns a stable
/// sentence that still names the *class* of failure.
///
/// Deliberately not applied to hand-written messages (`context::record`'s "unknown node kind")
/// — those are already written for a person to read, and sanitising them would strip the one
/// thing that makes them useful.
fn ui_db_error(e: &rusqlite::Error) -> String {
    tracing::warn!("store error (detail withheld from the UI): {e}");
    match e {
        // The SQL text is embedded in this variant by construction.
        rusqlite::Error::SqlInputError { .. } => "an internal query failed".to_string(),
        rusqlite::Error::SqliteFailure(ffi, _) => match ffi.code {
            rusqlite::ErrorCode::CannotOpen => "the database could not be opened".to_string(),
            rusqlite::ErrorCode::NotADatabase => {
                "the database file is not a valid database".to_string()
            }
            rusqlite::ErrorCode::DatabaseBusy => "the database is busy; try again".to_string(),
            rusqlite::ErrorCode::DiskFull => "the disk is full".to_string(),
            rusqlite::ErrorCode::ReadOnly => "the database is read-only".to_string(),
            rusqlite::ErrorCode::ConstraintViolation => {
                "the change was rejected by a database constraint".to_string()
            }
            _ => "a database error occurred".to_string(),
        },
        rusqlite::Error::QueryReturnedNoRows => "no matching row was found".to_string(),
        _ => "a database error occurred".to_string(),
    }
}

/// `CommandError` is serialized to the webview (Tauri requires `Serialize`). It also implements
/// `Display` so non-command callers — e.g. `gateway_cmds`, which needs a `String` error — can
/// reuse `persist::*` helpers through the ordinary `?`/`map_err` idiom instead of reaching into
/// the tuple field. One error type, two surfaces.
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<CommandError> for String {
    fn from(e: CommandError) -> Self {
        e.0
    }
}

/// All webview-facing vault accounts must be provider keys (`key:<keyId>`); the gateway
/// `masterkey` account is host-only (invariant 10).
fn check_account(account: &str) -> Result<(), CommandError> {
    if account.starts_with("key:") {
        Ok(())
    } else {
        Err(CommandError("vault account namespace not permitted".into()))
    }
}

// ---------- vault:* ----------

/// Store a provider key. TS never reads the secret back except via the Rust-side one-shot
/// reveal flow (invariant 14) — there is intentionally NO `vault_get` command. The egress
/// gateway reads it internally.
#[tauri::command]
pub fn vault_put(account: String, secret: String) -> Result<(), CommandError> {
    check_account(&account)?;
    vault::put(&account, &secret).map_err(Into::into)
}

#[tauri::command]
pub fn vault_delete(account: String) -> Result<(), CommandError> {
    check_account(&account)?;
    vault::delete(&account).map_err(Into::into)
}

#[tauri::command]
pub fn vault_has(account: String) -> Result<bool, CommandError> {
    check_account(&account)?;
    let found = vault::get(&account).map(|v| v.is_some())?;
    Ok(found)
}

// ---------- egress:* ----------

#[tauri::command]
pub async fn egress_request(
    state: State<'_, Arc<EgressState>>,
    req: EgressRequest,
) -> Result<egress::EgressResponse, CommandError> {
    egress::request(&state, req).await.map_err(Into::into)
}

#[tauri::command]
pub async fn egress_stream(
    state: State<'_, Arc<EgressState>>,
    req: EgressRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), CommandError> {
    egress::stream(&state, req, on_event).await.map_err(Into::into)
}

/// Invariant-3 carve-out: fetch a provider-returned URL (an imageUrl) as base64, scoped to
/// that response, never an allowlist entry. No secret involved.
#[tauri::command]
pub async fn egress_fetch_image(
    state: State<'_, Arc<EgressState>>,
    req: egress::ImageFetchRequest,
) -> Result<egress::ImageFetchResponse, CommandError> {
    egress::fetch_image(&state, req).await.map_err(Into::into)
}

// NOTE: no egress_allow_host / egress_deny_host commands. The allowlist is mutated only by
// provider CRUD host-side (persist.rs) — a compromised webview cannot open new destinations.

// ---------- store:* ----------
// Narrow surface only: the webview gets structured queries, never raw SQL (invariant 12).

#[tauri::command]
pub fn store_info(store: State<'_, Arc<Store>>) -> Result<store::StoreInfo, CommandError> {
    store.info().map_err(Into::into)
}

#[tauri::command]
pub fn settings_set(
    store: State<'_, Arc<Store>>,
    key: String,
    value_json: String,
) -> Result<(), CommandError> {
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![key, value_json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn settings_get(
    store: State<'_, Arc<Store>>,
    key: String,
) -> Result<Option<String>, CommandError> {
    let conn = store.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT value_json FROM settings WHERE key = ?")?;
    let mut rows = stmt.query_map([key], |r| r.get::<_, String>(0))?;
    match rows.next() {
        Some(v) => Ok(Some(v?)),
        None => Ok(None),
    }
}

/// Return the app data directory from the store's DB path (parent of the .db file).
fn app_data_dir(store: &store::Store) -> std::path::PathBuf {
    std::path::PathBuf::from(&store.path).parent().map(|p| p.to_path_buf()).unwrap_or_default()
}

// ---------- context graph (P4) ----------
// Nodes and edges are recorded in one batch so a turn is never half-present.

#[tauri::command]
pub fn context_record(
    store: State<'_, Arc<Store>>,
    nodes: Vec<context::ContextNode>,
    edges: Vec<context::ContextEdge>,
) -> Result<(), CommandError> {
    context::record(&store, &nodes, &edges).map_err(CommandError)
}

#[tauri::command]
pub fn context_graph(
    store: State<'_, Arc<Store>>,
    limit: usize,
) -> Result<context::ContextGraph, CommandError> {
    context::graph(&store, limit).map_err(CommandError)
}

#[tauri::command]
pub fn context_clear(store: State<'_, Arc<Store>>) -> Result<(), CommandError> {
    context::clear(&store).map_err(CommandError)
}

#[tauri::command]
pub fn history_sessions(
    store: State<'_, Arc<Store>>,
    limit: usize,
) -> Result<Vec<context::HistorySession>, CommandError> {
    context::sessions(&store, limit).map_err(CommandError)
}

#[tauri::command]
pub fn history_timeline(
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<context::HistoryTimeline, CommandError> {
    context::timeline(&store, &session_id).map_err(CommandError)
}

// ---------- skills (P5) ----------
// Skills are procedures, not capabilities: nothing here can widen the agent's tool surface.

#[tauri::command]
pub fn skills_list(store: State<'_, Arc<Store>>) -> Result<Vec<skills::Skill>, CommandError> {
    skills::list(&store).map_err(CommandError)
}

/// The builtin catalog, whether or not each entry is installed — so a revoked builtin can be
/// reinstalled deliberately rather than sneaking back on its own.
#[tauri::command]
pub fn skills_catalog() -> Vec<skills::Skill> {
    skills::catalog()
}

#[tauri::command]
pub fn skills_install(
    store: State<'_, Arc<Store>>,
    slug: String,
    name: String,
    description: String,
    body: String,
) -> Result<skills::Skill, CommandError> {
    skills::install(&store, slug, name, description, body).map_err(CommandError)
}

#[tauri::command]
pub fn skills_uninstall(store: State<'_, Arc<Store>>, slug: String) -> Result<(), CommandError> {
    skills::uninstall(&store, &slug).map_err(CommandError)
}

#[tauri::command]
pub fn skills_set_enabled(
    store: State<'_, Arc<Store>>,
    slug: String,
    enabled: bool,
) -> Result<(), CommandError> {
    skills::set_enabled(&store, &slug, enabled).map_err(CommandError)
}

/// Parse pasted `SKILL.md` text without installing it, so the UI can show what would be added.
#[tauri::command]
pub fn skills_parse(text: String) -> skills::ParsedSkill {
    skills::parse_skill_md(&text)
}

#[tauri::command]
pub fn skills_slugify(name: String) -> String {
    skills::slugify(&name)
}

// ---------- agent orchestrator (P6) ----------
// A record of what ran, not a scheduler of what should. Steps append as they happen so a run
// that dies midway is still inspectable.

#[tauri::command]
pub fn agent_runs_list(
    store: State<'_, Arc<Store>>,
    limit: usize,
) -> Result<Vec<orchestrator::AgentRun>, CommandError> {
    orchestrator::runs(&store, limit).map_err(CommandError)
}

#[tauri::command]
pub fn agent_run_start(
    store: State<'_, Arc<Store>>,
    id: String,
    session_id: Option<String>,
    model: String,
    prompt: Option<String>,
) -> Result<(), CommandError> {
    orchestrator::start(&store, id, session_id, model, prompt).map_err(CommandError)
}

#[tauri::command]
pub fn agent_step_append(
    store: State<'_, Arc<Store>>,
    // Tauri converts camelCase JS keys (`runId`) to snake_case Rust params, so these must stay
    // snake_case — naming them `runId` compiles but the invoke then fails on a missing argument.
    run_id: String,
    kind: String,
    label: Option<String>,
    detail: Option<String>,
    ok: Option<bool>,
) -> Result<(), CommandError> {
    orchestrator::step(&store, &run_id, kind, label, detail, ok).map_err(CommandError)
}

#[tauri::command]
pub fn agent_run_finish(
    store: State<'_, Arc<Store>>,
    run_id: String,
    status: String,
    iterations: i64,
    error: Option<String>,
) -> Result<(), CommandError> {
    orchestrator::finish(&store, &run_id, status, iterations, error).map_err(CommandError)
}

#[tauri::command]
pub fn agent_run_steps(
    store: State<'_, Arc<Store>>,
    run_id: String,
) -> Result<Vec<orchestrator::AgentStep>, CommandError> {
    orchestrator::steps(&store, &run_id).map_err(CommandError)
}

// ---------- memory (P7) ----------
// Four layers — L0 raw conversation, L1 atoms, L2 scenarios, L3 core. BM25 recall through
// FTS5, so no embedding model and no second process. Distillation is done in the webview
// (it owns the gateway client); the host only stores and ranks.

#[tauri::command]
pub fn memory_capture(
    store: State<'_, Arc<Store>>,
    layer: String,
    text: String,
    session_id: Option<String>,
    subject: Option<String>,
    pinned: Option<bool>,
) -> Result<memory::Memory, CommandError> {
    memory::capture(
        &store,
        &memory::MemoryInput { layer, text, session_id, subject, pinned: pinned.unwrap_or(false) },
    )
    .map_err(CommandError)
}

#[tauri::command]
pub fn memory_capture_batch(
    store: State<'_, Arc<Store>>,
    items: Vec<memory::MemoryInput>,
) -> Result<usize, CommandError> {
    memory::capture_batch(&store, &items).map_err(CommandError)
}

#[tauri::command]
pub fn memory_recall(
    store: State<'_, Arc<Store>>,
    query: String,
    limit: Option<usize>,
    layers: Option<Vec<String>>,
) -> Result<Vec<memory::Memory>, CommandError> {
    memory::recall(&store, &query, limit.unwrap_or(8), layers.as_deref()).map_err(CommandError)
}

#[tauri::command]
pub fn memory_list(
    store: State<'_, Arc<Store>>,
    layer: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<memory::Memory>, CommandError> {
    memory::list(&store, layer.as_deref(), limit.unwrap_or(200)).map_err(CommandError)
}

#[tauri::command]
pub fn memory_forget(store: State<'_, Arc<Store>>, id: String) -> Result<bool, CommandError> {
    memory::forget(&store, &id).map_err(CommandError)
}

#[tauri::command]
pub fn memory_set_pinned(
    store: State<'_, Arc<Store>>,
    id: String,
    pinned: bool,
) -> Result<bool, CommandError> {
    memory::set_pinned(&store, &id, pinned).map_err(CommandError)
}

#[tauri::command]
pub fn memory_update(
    store: State<'_, Arc<Store>>,
    id: String,
    text: String,
) -> Result<bool, CommandError> {
    memory::update(&store, &id, &text).map_err(CommandError)
}

/// Wire shape for `memory_assign_scope`. Flat rather than a tagged enum because this crosses into
/// TypeScript, where a Rust enum variant is an awkward thing to construct.
#[derive(Debug, Deserialize)]
pub struct MemoryScopeInput {
    /// `project` | `global` | `unscoped`.
    pub kind: String,
    pub project: Option<String>,
    pub agent: Option<String>,
}

/// Bind a memory to a scope. This is the review surface: an atom is never injectable until someone
/// puts it in a project or marks it global on purpose.
#[tauri::command]
pub fn memory_assign_scope(
    store: State<'_, Arc<Store>>,
    id: String,
    scope: MemoryScopeInput,
) -> Result<bool, CommandError> {
    let assignment = match scope.kind.trim().to_ascii_lowercase().as_str() {
        "project" => memory::ScopeAssignment::Project {
            // An absent project falls through to `assign_scope`'s "project scope is empty"
            // refusal rather than being silently defaulted here.
            project: scope.project.unwrap_or_default(),
            agent: scope.agent,
        },
        "global" => memory::ScopeAssignment::Global,
        "unscoped" => memory::ScopeAssignment::Unscoped,
        other => return Err(CommandError(format!("unknown scope kind '{other}'"))),
    };
    memory::assign_scope(&store, &id, assignment).map_err(CommandError)
}

#[tauri::command]
pub fn memory_session_atoms(
    store: State<'_, Arc<Store>>,
    session_id: String,
    layer: String,
    limit: Option<usize>,
) -> Result<Vec<memory::Memory>, CommandError> {
    memory::session_atoms(&store, &session_id, &layer, limit.unwrap_or(200)).map_err(CommandError)
}

#[tauri::command]
pub fn memory_clear(store: State<'_, Arc<Store>>) -> Result<(), CommandError> {
    memory::clear(&store).map_err(CommandError)
}

/// Bound the live-context tables: turn ring per session, TTL on turns, TTL on idle sessions.
///
/// A command rather than something the request path does, because pruning there would add a second
/// write to the hottest code in the app. Scheduling it on idle is Phase 5; until then the host can
/// call it and nothing grows without limit in between.
#[tauri::command]
pub fn gateway_prune_live_context(
    store: State<'_, Arc<Store>>,
) -> Result<crate::gateway::session_context::PruneStats, CommandError> {
    crate::gateway::session_context::prune(&store).map_err(CommandError)
}

/// §6.2 retention for the `memories` table: L0 TTL and ring, L1/L2 decay. Pinned and L3 are exempt.
///
/// Separate from `gateway_prune_live_context` because the two tables have completely different
/// retention policies, and one stats struct covering both would hide which rule removed what.
#[tauri::command]
pub fn gateway_prune_memories(
    store: State<'_, Arc<Store>>,
) -> Result<memory::MemoryPruneStats, CommandError> {
    memory::prune(&store).map_err(CommandError)
}

#[tauri::command]
pub fn memory_stats(store: State<'_, Arc<Store>>) -> Result<memory::MemoryStats, CommandError> {
    memory::stats(&store).map_err(CommandError)
}

/// §6.4.3: mark one memory as superseded by another. The old row is kept, not deleted.
///
/// Errors on a pinned or L3 row — §6.4.5 forbids quietly replacing either, and that refusal is the
/// whole reason conflicts are surfaced to a human rather than resolved here.
#[tauri::command]
pub fn memory_supersede(
    store: State<'_, Arc<Store>>,
    old: String,
    new: String,
) -> Result<bool, CommandError> {
    memory::supersede(&store, &old, &new).map_err(CommandError)
}

/// §6.4.3: undo a supersession. The row was never deleted, so this only makes it reachable again.
#[tauri::command]
pub fn memory_unsupersede(store: State<'_, Arc<Store>>, id: String) -> Result<bool, CommandError> {
    memory::unsupersede(&store, &id).map_err(CommandError)
}

/// §6.4.5: what the Memory screen has to put in front of a human.
#[tauri::command]
pub fn memory_conflicts(
    store: State<'_, Arc<Store>>,
) -> Result<Vec<memory::Conflict>, CommandError> {
    memory::conflicts(&store).map_err(CommandError)
}

// ── capture queue drain (§3.3) ──────────────────────────────────────────────
//
// The host enqueues at `BridgeMsg::Done` and never calls a model. The webview pulls a batch,
// distils it, and reports back here. Splitting it this way is what keeps distillation — the most
// expensive and least reliable step — off the request path entirely: a slow, broken or offline
// model delays learning, never a response.

#[tauri::command]
pub fn capture_claim(
    store: State<'_, Arc<Store>>,
) -> Result<Vec<crate::capture::PendingRow>, CommandError> {
    crate::capture::claim(&store).map_err(CommandError)
}

#[tauri::command]
pub fn capture_complete(store: State<'_, Arc<Store>>, id: i64) -> Result<bool, CommandError> {
    crate::capture::complete(&store, id).map_err(CommandError)
}

#[tauri::command]
pub fn capture_release(store: State<'_, Arc<Store>>, id: i64) -> Result<bool, CommandError> {
    crate::capture::release(&store, id).map_err(CommandError)
}

#[tauri::command]
pub fn capture_requeue_stale(store: State<'_, Arc<Store>>) -> Result<usize, CommandError> {
    crate::capture::requeue_stale(&store).map_err(CommandError)
}

#[tauri::command]
pub fn capture_queue_status(
    store: State<'_, Arc<Store>>,
) -> Result<crate::capture::QueueStatus, CommandError> {
    crate::capture::queue_status(&store).map_err(CommandError)
}

#[tauri::command]
pub fn capture_purge_finished(store: State<'_, Arc<Store>>) -> Result<usize, CommandError> {
    crate::capture::purge_finished(&store).map_err(CommandError)
}

// ── per-principal memory policy (§4a) ───────────────────────────────────────
//
// Which client may use memory, independent of whether the machine does. `enabled: null` means
// "inherit the master switch", and the master switch still beats every row here — turning memory
// off globally has to remain a single, unambiguous act.

#[tauri::command]
pub fn memory_principal_list(
    store: State<'_, Arc<Store>>,
) -> Result<Vec<crate::gateway::principal::PrincipalRow>, CommandError> {
    crate::gateway::principal::list(&store).map_err(CommandError)
}

#[derive(Debug, Deserialize)]
pub struct PrincipalPolicyInput {
    pub principal: String,
    /// `true` | `false` for an override, `null` to return to inheriting.
    pub enabled: Option<bool>,
}

#[tauri::command]
pub fn memory_principal_set(
    store: State<'_, Arc<Store>>,
    policy: PrincipalPolicyInput,
) -> Result<bool, CommandError> {
    match policy.enabled {
        Some(on) => crate::gateway::principal::set(&store, &policy.principal, on),
        None => crate::gateway::principal::clear(&store, &policy.principal),
    }
    .map_err(CommandError)
}

// ── model context-window cache (§3.4) ───────────────────────────────────────
//
// The webview owns the catalog, so it publishes the numbers and the host reads them. Nothing here
// is on the critical path of a request that has no memory to inject — the lookup is one indexed
// read of a tiny table, and a miss degrades to the conservative default.

/// Publish windows for the models the catalog knows. An upsert, because a refresh covers one
/// provider and must not drop another's rows.
#[tauri::command]
pub fn router_model_context_replace(
    store: State<'_, Arc<Store>>,
    rows: Vec<crate::gateway::model_context::ModelContextInput>,
) -> Result<usize, CommandError> {
    crate::gateway::model_context::upsert(&store, &rows).map_err(CommandError)
}

/// How many models the gateway can plan a budget against. Shown in the UI because "why is so
/// little memory being injected" is otherwise unanswerable: with zero rows every request plans
/// against the 8k default.
#[tauri::command]
pub fn router_model_context_count(store: State<'_, Arc<Store>>) -> Result<usize, CommandError> {
    crate::gateway::model_context::count(&store).map_err(CommandError)
}

// ── crash reporting (L0 — local only, no external telemetry) ─────────────────

#[tauri::command]
pub fn crash_count(store: State<'_, Arc<store::Store>>) -> Result<usize, CommandError> {
    Ok(crash_report::crash_count(&app_data_dir(&store)))
}

#[tauri::command]
pub fn crash_list(store: State<'_, Arc<store::Store>>) -> Result<Vec<String>, CommandError> {
    Ok(crash_report::list_crash_reports(&app_data_dir(&store)))
}

#[tauri::command]
pub fn crash_read(
    store: State<'_, Arc<store::Store>>,
    id: String,
) -> Result<Option<crash_report::CrashReport>, CommandError> {
    Ok(crash_report::read_crash_report(&app_data_dir(&store), &id))
}

#[tauri::command]
pub fn crash_clear(store: State<'_, Arc<store::Store>>, id: String) -> Result<bool, CommandError> {
    Ok(crash_report::clear_crash_report(&app_data_dir(&store), &id))
}

#[tauri::command]
pub fn crash_clear_all(store: State<'_, Arc<store::Store>>) -> Result<usize, CommandError> {
    Ok(crash_report::clear_all_crash_reports(&app_data_dir(&store)))
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        vault_put,
        vault_delete,
        vault_has,
        egress_request,
        egress_stream,
        egress_fetch_image,
        store_info,
        settings_set,
        settings_get,
        crate::persist::providers_list,
        crate::persist::provider_upsert,
        crate::persist::provider_delete,
        crate::persist::api_keys_list,
        crate::persist::api_key_upsert,
        crate::persist::api_key_delete,
        crate::persist::manifests_active,
        crate::persist::manifest_upsert_active,
        crate::persist::models_cache_replace,
        crate::persist::models_cache_list,
        crate::persist::aliases_replace,
        crate::persist::aliases_list,
        crate::persist::ledger_append,
        crate::persist::ledger_recent,
        crate::persist::ledger_rollup_run,
        context_record,
        context_graph,
        context_clear,
        history_sessions,
        history_timeline,
        skills_list,
        skills_catalog,
        skills_install,
        skills_uninstall,
        skills_set_enabled,
        skills_parse,
        skills_slugify,
        agent_runs_list,
        agent_run_start,
        agent_step_append,
        agent_run_finish,
        agent_run_steps,
        crate::gateway_cmds::gateway_status,
        crate::gateway_cmds::get_tools_enabled,
        crate::gateway_cmds::set_tools_enabled,
        // Audit H1b: gateway-side mutation is opt-in.
        crate::gateway_cmds::get_tools_mutation_enabled,
        crate::gateway_cmds::set_tools_mutation_enabled,
        crate::gateway_cmds::gateway_enable,
        crate::gateway_cmds::gateway_disable,
        crate::gateway_cmds::gateway_key_generate,
        crate::gateway_cmds::gateway_key_copy,
        crate::gateway_cmds::gateway_key_revoke,
        // Audit R4: per-app gateway keys + monthly spend cap.
        crate::gateway_cmds::gateway_app_key_create,
        crate::gateway_cmds::gateway_app_keys,
        crate::gateway_cmds::gateway_app_key_revoke,
        crate::gateway_cmds::gateway_app_key_delete,
        // 0017: the per-app budget. Kept beside the key commands rather than with the global cap,
        // because it is a property of one key — the same ownership rule that put the global cap on
        // Control and the keys on Local Gateway.
        crate::gateway_cmds::gateway_app_key_cap_set,
        crate::gateway_cmds::gateway_spend_status,
        crate::gateway_cmds::gateway_spend_cap_set,
        crate::gateway_cmds::gateway_heartbeat,
        crate::gateway_cmds::gateway_worker_error,
        crate::gateway_cmds::gateway_chunk,
        crate::gateway_cmds::gateway_result,
        crate::gateway_cmds::gateway_done,
        crate::gateway_cmds::gateway_error,
        crate::gateway_cmds::gateway_tool_calls,
        crate::gateway_cmds::gateway_usage,
        crate::gateway_cmds::gateway_set_workspace_root,
        crate::gateway_cmds::gateway_get_workspace_root,
        crate::gateway_cmds::gateway_project_key,
        crate::gateway_cmds::gateway_memory_enabled,
        crate::gateway_cmds::gateway_set_memory_enabled,
        crate::gateway_cmds::gateway_injection_stats,
        crate::gateway_cmds::gateway_log_tail,
        crate::gateway_cmds::gateway_tool_run,
        crate::workbuddy::workbuddy_sync,
        crate::workbuddy::workbuddy_status,
        crate::workbuddy::workbuddy_set_models,
        crate::persist::onboarding_save,
        crate::persist::onboarding_latest_active,
        crate::persist::generator_audit_record,
        crate::persist::generator_audit_list,
        crate::persist::drift_event_record,
        crate::persist::drift_event_resolve,
        crate::persist::drift_events_list,
        crate::persist::manifests_history,
        crate::persist::manifest_stage,
        crate::persist::manifest_activate,
        crate::persist::config_export,
        crate::persist::config_import,
        crate::persist::diagnostics_bundle,
        crate::tools::tools_policy,
        crate::tools::tools_check_root,
        crate::tools::tools_default_root,
        crate::tools::tool_run,
        memory_capture,
        memory_capture_batch,
        memory_recall,
        memory_list,
        memory_forget,
        memory_set_pinned,
        memory_assign_scope,
        memory_update,
        memory_session_atoms,
        memory_clear,
        gateway_prune_live_context,
        gateway_prune_memories,
        memory_supersede,
        memory_unsupersede,
        memory_conflicts,
        memory_stats,
        capture_claim,
        capture_complete,
        capture_release,
        capture_requeue_stale,
        capture_queue_status,
        capture_purge_finished,
        memory_principal_list,
        memory_principal_set,
        router_model_context_replace,
        router_model_context_count,
        // Crash reporting (local-only, no external telemetry)
        crate::commands::crash_count,
        crate::commands::crash_list,
        crate::commands::crash_read,
        crate::commands::crash_clear,
        crate::commands::crash_clear_all,
    ]
}

#[cfg(test)]
mod ui_error_tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aip-uierr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("temp dir");
        d
    }

    /// The path is the leak: it names the account, and it is the whole string rusqlite produced
    /// for a database it could not open.
    #[test]
    fn a_database_that_cannot_be_opened_does_not_name_its_path() {
        let dir = temp_dir("open");
        let db = dir.join(format!("secret-{}-path", whoamiish())).join("db.sqlite");
        let err = rusqlite::Connection::open(&db).expect_err("a missing parent must fail");
        assert!(err.to_string().contains("secret"), "the raw error really does carry the path");
        let ui = ui_db_error(&err);
        assert!(!ui.contains("secret"), "path leaked to the UI: {ui}");
        assert!(!ui.contains('/'), "path leaked to the UI: {ui}");
        assert_eq!(ui, "the database could not be opened");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn whoamiish() -> String {
        std::env::var("USER").unwrap_or_else(|_| "someone".to_string())
    }

    #[test]
    fn bad_sql_does_not_reach_the_ui_with_the_statement_in_it() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        // The statement text is echoed back in the error verbatim, which is the leak: it names
        // the table the schema actually has.
        let err = c
            .prepare("SELECT api_secret FROM private_table WHERE FROM")
            .expect_err("malformed SQL must fail");
        assert!(err.to_string().contains("private_table"), "raw error carries the SQL: {err}");
        let ui = ui_db_error(&err);
        assert!(!ui.contains("private_table"), "SQL leaked to the UI: {ui}");
        assert!(!ui.contains("api_secret"), "SQL leaked to the UI: {ui}");
    }

    #[test]
    fn a_missing_column_does_not_name_the_table() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE keys (id TEXT PRIMARY KEY);").unwrap();
        let err = c.prepare("SELECT api_secret FROM keys").expect_err("unknown column");
        let ui = ui_db_error(&err);
        assert!(!ui.contains("api_secret"), "column leaked to the UI: {ui}");
        assert!(!ui.contains("keys"), "table leaked to the UI: {ui}");
    }

    #[test]
    fn a_corrupt_database_is_still_actionable() {
        // The one case where the class of failure IS the advice: the UI tells the operator to
        // restore from a backup. Scrubbing it to "a database error occurred" would be a
        // regression, not a hardening.
        let dir = temp_dir("corrupt");
        let db = dir.join("db.sqlite");
        std::fs::write(&db, vec![0u8; 4096]).unwrap();
        let err = (|| -> rusqlite::Result<()> {
            let c = rusqlite::Connection::open(&db)?;
            c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
            Ok(())
        })()
        .expect_err("a zeroed file is not a database");
        let ui = ui_db_error(&err);
        assert!(ui.contains("not a valid database"), "was: {ui}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_migration_failure_names_the_migration_but_not_the_sql() {
        let e = crate::store::StoreError::Migration(
            "0007_ledger_error_class".into(),
            "near \"FROM\": syntax error in UPDATE ledger SET FROM WHERE".into(),
        );
        let ui: CommandError = e.into();
        assert_eq!(ui.0, "migration 0007_ledger_error_class failed");
        assert!(!ui.0.contains("UPDATE"), "SQL leaked to the UI: {}", ui.0);
    }

    #[test]
    fn an_io_failure_names_only_its_kind() {
        let e = crate::store::StoreError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "No such file or directory (os error 2)",
        ));
        let ui: CommandError = e.into();
        assert_eq!(ui.0, "a required file or folder is missing");
    }

    #[test]
    fn a_hand_written_message_passes_through_untouched() {
        // Sanitising these would strip the one thing that makes them useful: they come from the
        // module, not from rusqlite, and they are already written for a person to read. The
        // guard is that this class of message still names what was wrong.
        let dir = temp_dir("handwritten");
        let s = crate::store::Store::open(&dir).expect("open");
        let node = context::ContextNode {
            id: "n1".into(),
            kind: "vibe".into(),
            label: "x".into(),
            source: "ui".into(),
            session_id: None,
            ts: 1,
            meta_json: None,
        };
        let err = context::record(&s, &[node], &[]).expect_err("an unknown kind is refused");
        assert!(err.contains("unknown node kind 'vibe'"), "was: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
