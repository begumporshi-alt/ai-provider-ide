//! Gateway command surface + production bridge (§3.3). The production Bridge emits Tauri
//! events into the webview (where the router core runs); the webview answers via the
//! gateway_* commands. Master-key reveal is clipboard-only from Rust (invariant 14): the
//! key never appears in webview-observable state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::gateway::{self, Bridge, BridgeMsg, BridgeRequest, GatewayCore};
use crate::store::Store;

/// R1: label of the dedicated window that hosts the router core for gateway requests. Keeping
/// the bridge out of the UI window is what stops UI render work — and UI HMR reloads — from
/// touching in-flight gateway requests.
pub const GATEWAY_WINDOW: &str = "gateway";

/// How long the worker window must stay on screen before it can be hidden.
///
/// This is not a guess. Measured on macOS 15 with a 2s timer and the UI window hidden, the
/// JS in a worker window behaves like this:
///
/// | how the window was shown                  | ticks over 24s |
/// |-------------------------------------------|----------------|
/// | never ordered in (`visible(false)`)       | 0  — suspended |
/// | `orderFront` + `orderOut` immediately     | 0  — suspended |
/// | `orderFront` + `orderOut` after 16ms      | 0  — suspended |
/// | `orderFront` + `orderOut` after 300ms     | 8  — alive     |
/// | `orderFront` + `orderOut` after 1000ms    | 8  — alive     |
///
/// macOS suspends the JS of a webview whose window was never really composited, and it only
/// unfreezes once nothing else is on screen — which is precisely when the gateway is meant to
/// be serving. tao's `visible(false)` skips `makeKeyAndOrderFront` entirely
/// (`tao/platform_impl/macos/window.rs:630`), so the old `.visible(false)` produced row 1:
/// the worker ran while the UI was up and died the moment the app went to the background.
///
/// Parking the window off-screen does **not** avoid this: macOS clamps windows back into the
/// visible area (a window requested at x=-4000 lands at x=480). So the warm-up is a real,
/// brief appearance, and `WORKER_WARMUP_MS` is its cost. 1000ms is 3x the proven minimum.
const WORKER_WARMUP_MS: u64 = 1_000;

/// Warm-up window size — small and undecorated, so the unavoidable appearance is as
/// unobtrusive as it can be.
const WORKER_WARMUP_W: f64 = 220.0;
const WORKER_WARMUP_H: f64 = 140.0;

pub struct GatewayState {
    pub core: Arc<GatewayCore>,
    pub server: Mutex<Option<gateway::ServerHandle>>,
}

impl GatewayState {
    /// True when a listener is bound but the gateway is not supposed to be serving.
    ///
    /// Narrowed from `!is_available()`. That test also fired on a merely *sleeping* worker, and
    /// tearing the listener down then was the wrong repair twice over: the socket was healthy,
    /// and `await_core` revives a sleeping worker on demand in ~50ms anyway. The state that
    /// actually needs rebuilding is the one where a listener outlived the operator's intent —
    /// e.g. an enable that half-failed — because nothing else will ever tear it down.
    pub fn has_stale_server(&self) -> bool {
        self.server.lock().unwrap().is_some() && !self.core.is_running()
    }
}

/// Production bridge: dispatch/cancel flow as events to the gateway worker window.
///
/// `emit_to` is load-bearing here, not stylistic: `emit` broadcasts to *every* webview, and
/// both windows hydrate a router core. With a broadcast each request would be answered twice —
/// two upstream calls, two ledger rows, two streams to the client.
struct EventBridge {
    app: AppHandle,
}

impl Bridge for EventBridge {
    fn dispatch(&self, req: BridgeRequest) {
        let _ = self.app.emit_to(
            EventTarget::webview_window(GATEWAY_WINDOW),
            "gateway-request",
            &req,
        );
    }
    fn cancel(&self, request_id: u64) {
        let _ = self.app.emit_to(
            EventTarget::webview_window(GATEWAY_WINDOW),
            "gateway-cancel",
            serde_json::json!({ "requestId": request_id }),
        );
    }
}

/// R1: create the gateway worker window if it is not already up. Idempotent.
///
/// Failure is returned rather than swallowed: without this window nothing answers gateway
/// requests, so a silent fallback would look like a running gateway that 503s on everything.
pub fn ensure_bridge_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(GATEWAY_WINDOW).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, GATEWAY_WINDOW, WebviewUrl::App("gateway.html".into()))
        .title("AI-Provider Router — gateway worker")
        // `visible(true)` is load-bearing, not an oversight — see `WORKER_WARMUP_MS`. The
        // window has to be composited once or macOS never lets its JS run while the app is
        // in the background. `focused(false)` keeps it from stealing key-window status:
        // tao then uses `orderFront` rather than `makeKeyAndOrderFront`, which is the same
        // path the measurements in `WORKER_WARMUP_MS` were taken on.
        .visible(true)
        .focused(false)
        .decorations(false)
        .inner_size(WORKER_WARMUP_W, WORKER_WARMUP_H)
        .build()
        .map_err(|e| format!("gateway worker window failed to start: {e}"))?;
    hide_worker_after_warmup(app);
    // The worker window ends up hidden, so the renderer's heartbeat is subject to the OS
    // throttling that HEARTBEAT_STALE_HIDDEN_MS exists to absorb.
    if let Some(state) = app.try_state::<Arc<GatewayState>>() {
        state.core.set_hidden(true);
    }
    Ok(())
}

/// Re-composite an existing worker window.
///
/// `ensure_bridge_window` is idempotent and returns early when the window is already up, which
/// is right for creation but wrong for recovery: a window that has been hidden long enough can
/// have its JS suspended by the OS, and showing it again is what resumes it. Called on every
/// start so a second Start revives a stalled worker rather than trusting one that has gone
/// quiet.
pub fn warm_bridge_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(GATEWAY_WINDOW) {
        // `show()` only — deliberately no `set_focus()`. Stealing key-window status from
        // whatever the operator is using would be a worse bug than the one we are fixing.
        let _ = win.show();
    }
    hide_worker_after_warmup(app);
}

/// Retire the warm-up window once it has been on screen long enough to count as displayed.
///
/// After this the window is hidden for the rest of the session, but its webview keeps
/// running — which is the whole point: the gateway serves with no window on screen.
fn hide_worker_after_warmup(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(WORKER_WARMUP_MS));
        if let Some(win) = app.get_webview_window(GATEWAY_WINDOW) {
            let _ = win.hide();
        }
    });
}

pub fn build_core(app: &AppHandle) -> Arc<GatewayCore> {
    // The request path can re-warm the worker window itself, so a lapsed heartbeat becomes a
    // short wait rather than a 503. (The watchdog does the same, but once a minute at most.)
    let warm_app = app.clone();
    let core = GatewayCore::new(
        Arc::new(EventBridge { app: app.clone() }),
        gateway::vault_key_provider(),
    )
    .with_warm(Arc::new(move || warm_bridge_window(&warm_app)));
    // R4: per-app keys + monthly spend cap, both store-backed. `try_state` because setup order
    // is not guaranteed for every caller (a harness may build a core with no Store managed);
    // in that case the gateway degrades to master-key-only and uncapped rather than panicking.
    // The setters (`set_app_keys` / `set_spend`) take over at runtime when a key is created or
    // revoked, so the change applies on the next request without rebuilding this core.
    match app.try_state::<Arc<Store>>() {
        Some(store) => {
            let store = store.inner().clone();
            Arc::new(
                core.with_app_keys(gateway::vault_app_key_provider(store.clone()))
                    .with_spend(gateway::vault_spend_provider(store)),
            )
        }
        None => Arc::new(core),
    }
}

// ---------- commands ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    /// Whether the operator asked the gateway to serve. Deliberately *not* `is_available()`:
    /// a hidden worker's beat stops after ~8 idle minutes (see `HEARTBEAT_STALE_HIDDEN_MS`), and
    /// reporting that as "stopped" made the UI contradict itself — Start appeared dead while the
    /// socket was bound and serving. Sleeping is `worker_awake: false`, not `running: false`.
    pub running: bool,
    pub port: u16,
    pub has_key: bool,
    pub endpoint_url: String,
    /// R1: the window is hidden and the gateway is serving in the background. Lets the UI
    /// show real state instead of inferring it ("if you can read this, it isn't hidden").
    pub background: bool,
    /// Whether the worker's beat is inside its bound — i.e. it is awake right now rather than
    /// merely reachable. False here is routine and self-healing: the next request revives it.
    pub worker_awake: bool,
    /// Milliseconds since the worker last reported in. Exposed because "stopped" is ambiguous
    /// without it: `running: false` can mean the operator stopped it, or that the worker's
    /// heartbeat lapsed underneath a socket that is still bound. The age tells you which.
    pub heartbeat_age_ms: u64,
    /// Why the worker page failed, if it did. It runs in an invisible window, so anything it
    /// threw used to land in a console nobody can open.
    pub worker_error: Option<String>,
}

#[tauri::command]
pub fn gateway_status(state: State<'_, Arc<GatewayState>>) -> Result<GatewayStatus, String> {
    let port = state.core.port();
    Ok(GatewayStatus {
        running: state.core.is_running(),
        port,
        has_key: gateway::vault_key_provider()().is_some(),
        endpoint_url: format!("http://127.0.0.1:{port}/v1"),
        background: state.core.is_hidden(),
        worker_awake: state.core.beat_is_fresh(),
        heartbeat_age_ms: state.core.heartbeat_age_ms(),
        worker_error: state.core.worker_error(),
    })
}

#[tauri::command]
pub async fn gateway_enable(app: AppHandle, port: Option<u16>) -> Result<u16, String> {
    // AppHandle + inner().clone(): State<'_, _> in async commands hits the 'static
    // lifetime bound (classic Tauri E0700); cloning the Arc sidesteps it.
    let state = app.state::<Arc<GatewayState>>().inner().clone();

    // A bound socket is not a working gateway. The heartbeat can lapse while the listener is
    // still up — a suspended worker renderer, a page that failed to boot — and then the UI
    // shows "Stopped" while `server` is still `Some`. Reporting the port and returning left
    // Start doing nothing at exactly the moment the operator needs it, so tear the stale
    // listener down and bring it back up instead.
    if state.has_stale_server() {
        log_to_file(
            &app,
            &format!(
                "re-enabling over a stale listener (no heartbeat for {}ms)",
                state.core.heartbeat_age_ms()
            ),
        );
        if let Some(handle) = state.server.lock().unwrap().take() {
            let _ = handle.shutdown.send(());
        }
        state.core.set_running(false);
    }
    if state.server.lock().unwrap().is_some() {
        // Already up and healthy: report the bound port (idempotent).
        return Ok(state.core.port());
    }
    // R1: the bridge lives in its own window; bring it up before the socket accepts traffic,
    // so no request can arrive with nothing listening.
    //
    // Staged logging, and it is not decoration: this path can *hang* rather than fail — creating
    // a webview window from a spawned task during startup races the main thread's event loop —
    // and a hang produces no error and no log line, so "the app started without a gateway" was
    // indistinguishable from a slow start. With these two markers the log says which step never
    // finished.
    log_to_file(&app, "enable: starting");
    let t_window = std::time::Instant::now();
    ensure_bridge_window(&app)?;
    log_to_file(
        &app,
        &format!("enable: worker window ready in {}ms", t_window.elapsed().as_millis()),
    );
    // Re-warm even when the window already existed: macOS can suspend the JS of a window that
    // has been hidden for a while, and re-compositing it is what resumes the heartbeat.
    warm_bridge_window(&app);
    let t_bind = std::time::Instant::now();
    let handle = gateway::spawn(state.core.clone(), port.unwrap_or(gateway::DEFAULT_PORT)).await?;
    log_to_file(
        &app,
        &format!("enable: listener bound in {}ms", t_bind.elapsed().as_millis()),
    );
    state.core.set_running(true);
    let bound = handle.addr.port();
    *state.server.lock().unwrap() = Some(handle);
    log_to_file(&app, &format!("enabled on port {bound}"));
    // Keep the entry we publish into third-party clients current: url/port, key, and the
    // capability fields that nobody should have to hand-maintain. Best-effort — a client
    // config we cannot write must never stop the gateway from serving.
    if let Some(store) = app.try_state::<Arc<Store>>() {
        match crate::workbuddy::sync(store.inner()) {
            Ok(r) => log_to_file(
                &app,
                &format!("workbuddy sync: {} published, {} stale removed", r.updated, r.removed),
            ),
            Err(e) => log_to_file(&app, &format!("workbuddy sync skipped: {e}")),
        }
    }
    spawn_watchdog(app, state);
    Ok(bound)
}

/// At most one watchdog loop per serving period.
///
/// This is defence, not a fix for an observed symptom — worth saying plainly, because the obvious
/// story is wrong. The old loop could not fire within 60s of `last_warm`, and it anchored
/// `last_warm` at *spawn*, so a lapse beginning shortly after an enable waited out the remainder
/// of that window. Checked against the log: of 40 fires, only 3 exceeded the 30s bound (57.6s,
/// 62.5s, 96.4s), and all three are rate-limit cases — 60s exactly since the previous fire, or 7s
/// and 16s since the last `enabled on port`. **Zero** were caused by several loops coexisting.
///
/// Loops do not pile up in the normal path either: `gateway_enable` returns early while serving,
/// and a disable makes the old loop exit on its next poll. What remains is a narrow race — the
/// stale-listener teardown clears `server` and a new loop may spawn before the old one has polled
/// — and with the loop now log-only that would show up as duplicate lines for one episode. Cheap
/// to preclude, so preclude it.
///
/// The flag is cleared on the way out so a disable/enable cycle still gets a fresh loop.
static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);

/// Record a worker lapse so it leaves a trace — without trying to repair it.
///
/// This used to re-composite the worker window. That was the right instinct while the beat was
/// the only recovery path, but it is not one any more: `await_core` revives a sleeping worker
/// from the request that needs it, in ~50ms, without an operator waiting. All the proactive
/// re-warm added was a 220x140 window appearing on screen, and because the beat stops on
/// *idleness* (see `HEARTBEAT_STALE_HIDDEN_MS`) that flash was the normal case on an idle
/// gateway, not an error case — roughly once every 8.5 minutes, indefinitely.
///
/// The record is still worth keeping. A lapse no request ever came along to fix would
/// otherwise be invisible, and "the gateway went quiet at 3am" is exactly what this log is for.
fn spawn_watchdog(app: AppHandle, state: Arc<GatewayState>) {
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return; // one loop is already watching this serving period
    }
    tokio::spawn(async move {
        let mut reported = false;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if state.server.lock().unwrap().is_none() {
                WATCHDOG_STARTED.store(false, Ordering::SeqCst); // arm a fresh loop for the next one
                return; // stopped by the operator
            }
            if state.core.beat_is_fresh() {
                reported = false; // armed again for the next episode
                continue;
            }
            if reported {
                continue; // one line per episode, not one per poll
            }
            reported = true;
            log_to_file(
                &app,
                &format!(
                    "watchdog: worker beat stale for {}ms — asleep, revives on the next request",
                    state.core.heartbeat_age_ms()
                ),
            );
        }
    });
}

#[tauri::command]
pub fn gateway_disable(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    if let Some(handle) = state.server.lock().unwrap().take() {
        let _ = handle.shutdown.send(());
    }
    state.core.set_running(false);
    Ok(())
}

/// Generate (or rotate) the master key. The value goes straight to the clipboard — the
/// webview only learns "it happened" (invariants 10, 14).
#[tauri::command]
pub fn gateway_key_generate() -> Result<(), String> {
    let _key = gateway::generate_master_key()?;
    gateway::copy_master_key()
}

#[tauri::command]
pub fn gateway_key_copy() -> Result<(), String> {
    gateway::copy_master_key()
}

#[tauri::command]
pub fn gateway_key_revoke() -> Result<(), String> {
    gateway::revoke_master_key()
}

// ---------- audit R4: per-app gateway keys ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppKeyCreated {
    pub id: String,
    pub label: String,
}

/// Create a per-app key: crypto-random secret -> keychain -> clipboard (shown once).
/// The secret is never returned to the webview and never persisted to SQLite (invariant 14).
#[tauri::command]
pub fn gateway_app_key_create(
    store: State<'_, Arc<Store>>,
    label: String,
) -> Result<AppKeyCreated, String> {
    let id = format!("ak-{}", uuid_like());
    let secret = gateway::generate_random_key();
    let account = format!("{}{}", gateway::APP_KEY_PREFIX, id);
    crate::vault::put(&account, &secret).map_err(|e| e.to_string())?;
    if let Err(e) = crate::persist::gateway_key_insert(&store, &id, &label) {
        // Roll back the keychain entry: a secret with no row is an unrevokable ghost.
        let _ = crate::vault::delete(&account);
        return Err(e.to_string());
    }
    // No provider refresh needed: the key provider re-reads the active ids per request, so the
    // new key works on the very next call without a restart.
    if let Err(e) = gateway::copy_text(&secret) {
        // The key is the ONLY copy of the secret — if it never reaches the clipboard the user
        // can't use it, so unwind both stores rather than leave a credential nobody holds.
        let _ = crate::vault::delete(&account);
        let _ = crate::persist::gateway_key_delete(&store, &id);
        return Err(e);
    }
    Ok(AppKeyCreated { id, label })
}

#[tauri::command]
pub fn gateway_app_keys(store: State<'_, Arc<Store>>) -> Result<Vec<crate::persist::GatewayKeyRow>, String> {
    crate::persist::gateway_keys_list(&store).map_err(|e| e.to_string())
}

/// Revoke one app key. Takes effect on the next request — the master key and every other app
/// key are untouched, which is the whole point (audit R4).
#[tauri::command]
pub fn gateway_app_key_revoke(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    crate::persist::gateway_key_revoke(&store, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gateway_app_key_delete(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    crate::persist::gateway_key_delete(&store, &id).map_err(|e| e.to_string())
}

/// Short random id — not security-sensitive (the secret is the key), just collision-resistant.
fn uuid_like() -> String {
    use rand::Rng as _;
    (0..16)
        .map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16)))
        .collect()
}

// ---------- audit R4: monthly spend cap ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendStatus {
    /** Micro-USD spent this calendar month (UTC). */
    pub month_micros: i64,
    /** Configured cap; 0 = disabled. */
    pub cap_micros: i64,
    pub capped: bool,
}

#[tauri::command]
pub fn gateway_spend_status(store: State<'_, Arc<Store>>) -> Result<SpendStatus, String> {
    let month = crate::persist::month_spend_micros(&store);
    let cap = crate::persist::spend_cap_micros(&store).unwrap_or(0);
    Ok(SpendStatus { month_micros: month, cap_micros: cap, capped: cap > 0 && month >= cap })
}

/// Set the monthly cap in micro-USD. `0` disables it.
#[tauri::command]
pub fn gateway_spend_cap_set(store: State<'_, Arc<Store>>, cap_micros: i64) -> Result<(), String> {
    crate::persist::spend_cap_set(&store, cap_micros.max(0)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tools_enabled(state: State<'_, Arc<GatewayState>>) -> Result<bool, String> {
    Ok(state.core.is_tools_enabled())
}

#[tauri::command]
pub fn set_tools_enabled(enabled: bool, state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    state.core.set_tools_enabled(enabled);
    Ok(())
}

/// Set the workspace root for local tool execution (write_file, mkdir, run_command).
/// Must be called before tools are used in gateway mode.
#[tauri::command]
pub fn gateway_set_workspace_root(
    state: State<'_, Arc<GatewayState>>,
    root: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(&root);
    if !path.exists() {
        return Err(format!("workspace root does not exist: {}", root));
    }
    state.core.set_workspace_root(path);
    Ok(())
}

/// Get the current workspace root, or null if not set.
#[tauri::command]
pub fn gateway_get_workspace_root(
    state: State<'_, Arc<GatewayState>>,
) -> Result<Option<String>, String> {
    Ok(state.core.workspace_root().map(|p| p.to_string_lossy().to_string()))
}

/// Execute a tool call locally (write_file, read_file, list_dir, run_command).
/// Returns the result to the bridge for re-dispatch back to the model.
#[tauri::command]
pub fn gateway_tool_run(
    state: State<'_, Arc<GatewayState>>,
    _request_id: u64,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<crate::tools::ToolResult, String> {
    let root = state
        .core
        .workspace_root()
        .ok_or_else(|| "workspace root not set — call gateway_set_workspace_root first".to_string())?;
    let req = crate::tools::ToolRunRequest {
        name: tool_name,
        arguments,
        root: root.to_string_lossy().to_string(),
    };
    Ok(crate::tools::tool_run(req))
}

/// Webview liveness heartbeat (2s cadence from bridge.ts): proves the router core answers.
#[tauri::command]
pub fn gateway_heartbeat(app: AppHandle, state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    // Logged only after a gap, so steady-state beats (every ~2s) stay quiet while the two
    // interesting cases are recorded: the worker coming up for the first time, and it
    // recovering after the OS or an error had stopped it.
    let quiet_for = state.core.heartbeat_age_ms();
    if quiet_for > 5_000 {
        log_to_file(&app, &format!("worker reported in after {quiet_for}ms quiet"));
    }
    state.core.heartbeat();
    state.core.set_worker_error(None);
    Ok(())
}

/// Append a line to `{app_data_dir}/gateway.log`.
///
/// The worker runs in a window nobody can see and the release build has no console, so
/// without this a misbehaving gateway leaves no trace anywhere. Best-effort: diagnostics
/// must never be the reason the gateway fails to start.
///
/// `pub(crate)` because the startup restore path needs it too. That path used to report only
/// through `tracing`, which a release GUI build discards — so "the app came up without a
/// gateway" left literally no evidence, and a silent failure looked identical to a slow start.
pub(crate) fn log_to_file(app: &AppHandle, line: &str) {
    use std::io::Write as _;
    use tauri::Manager as _;
    let Ok(dir) = app.path().app_data_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("gateway.log"))
    else {
        return;
    };
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "{secs} {line}");
}

/// The worker page reporting that it failed to boot.
///
/// It runs in a window nobody can ever see, so an exception during `bootstrap()` or
/// `startGatewayBridge()` used to land in a console that cannot be opened — the only symptom
/// was a gateway that silently stopped answering a few seconds after Start. This gives that
/// failure somewhere to go: it is logged host-side and surfaced in `gateway_status`.
#[tauri::command]
pub fn gateway_worker_error(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
    message: String,
) -> Result<(), String> {
    log_to_file(&app, &format!("worker error: {message}"));
    state.core.set_worker_error(Some(message));
    Ok(())
}

/// Structured tool calls from the webview router for one bridged request.
#[tauri::command]
pub fn gateway_tool_calls(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    tool_calls_json: String,
) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&tool_calls_json).map_err(|e| e.to_string())?;
    // Normalised here, at the single point where tool calls enter the gateway, so every
    // dialect's reader (OpenAI, Anthropic, Responses, Gemini) gets the shape it looks for.
    state.core.reply(request_id, BridgeMsg::ToolCalls(crate::gateway::normalize_tool_calls(v)));
    Ok(())
}

/// Token usage from the webview router for one bridged request.
#[tauri::command]
pub fn gateway_usage(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Usage { prompt_tokens, completion_tokens });
    Ok(())
}

/// Replies from the webview router for one bridged request.
#[tauri::command]
/// One streamed chunk.
///
/// Errors when nobody is listening any more. That is the bridge's only backpressure signal,
/// and it is what stops a runaway tool loop: the bridge aborts on a failed chunk, so a request
/// whose client has gone cannot keep buying upstream tokens.
pub fn gateway_chunk(state: State<'_, Arc<GatewayState>>, request_id: u64, text: String) -> Result<(), String> {
    if state.core.reply(request_id, BridgeMsg::Delta(text)) {
        Ok(())
    } else {
        Err(format!("request {request_id} is no longer active"))
    }
}

#[tauri::command]
pub fn gateway_result(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    body_json: String,
) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&body_json).map_err(|e| e.to_string())?;
    state.core.reply(request_id, BridgeMsg::Result(v));
    Ok(())
}

#[tauri::command]
pub fn gateway_done(state: State<'_, Arc<GatewayState>>, request_id: u64) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Done);
    Ok(())
}

#[tauri::command]
pub fn gateway_error(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    status: u16,
    message: String,
) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Error { status, message });
    Ok(())
}

pub fn manage(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let core = build_core(app.handle());
    app.manage(Arc::new(GatewayState { core, server: Mutex::new(None) }));
    Ok(())
}

/// §4 rollup job on startup (idempotent; errors never block boot).
pub fn run_rollup(store: &Arc<Store>) {
    let Ok(conn) = store.conn.lock() else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let month_from = now - 62 * 24 * 3600 * 1000;
    let _ = conn.execute(
        "INSERT INTO ledger_rollups (month, provider_id, model, modality, requests, failures, tokens_in, tokens_out, cost_estimate_micros)
         SELECT strftime('%Y-%m', ts/1000, 'unixepoch') AS month,
                COALESCE(provider_id,''), model, modality,
                COUNT(*), SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),
                SUM(tokens_in), SUM(tokens_out), SUM(cost_estimate_micros)
         FROM ledger WHERE ts < ?1
         GROUP BY month, provider_id, model, modality
         ON CONFLICT(month, provider_id, model, modality) DO UPDATE SET
           requests=excluded.requests, failures=excluded.failures,
           tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
           cost_estimate_micros=excluded.cost_estimate_micros",
        rusqlite::params![month_from],
    );
    let cutoff = now - 90 * 24 * 3600 * 1000;
    let _ = conn.execute("DELETE FROM ledger WHERE ts < ?1", rusqlite::params![cutoff]);
}
