//! Gateway command surface + production bridge (§3.3). The production Bridge emits Tauri
//! events into the webview (where the router core runs); the webview answers via the
//! gateway_* commands. Master-key reveal is clipboard-only from Rust (invariant 14): the
//! key never appears in webview-observable state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::core::gateway::{
    self, webview_ready, Beat, Bridge, BridgeMsg, BridgeRequest, GatewayCore, ReplyHandle,
};
use crate::core::injection_log::InjectionStats;
use crate::core::store::Store;

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
    /// The store, so a gateway tool call can be recorded in the context graph. Nothing on the
    /// request path reads it — it exists only to give the audit path somewhere to write, which
    /// is why it is the last field and the last thing anyone thinks about.
    pub store: Arc<Store>,
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
    /// `replies` is unused here, and that is the shape of this bridge rather than an oversight:
    /// the webview answers through separate Tauri commands (`gateway_result` and friends), which
    /// resolve the core out of managed state and call `GatewayCore::reply`. The handle exists so
    /// the *other* bridges — the headless Rust one above all — have a way back that is a
    /// parameter instead of a wiring step.
    fn dispatch(&self, req: BridgeRequest, _replies: ReplyHandle) {
        let _ =
            self.app.emit_to(EventTarget::webview_window(GATEWAY_WINDOW), "gateway-request", &req);
    }
    fn cancel(&self, request_id: u64) {
        let _ = self.app.emit_to(
            EventTarget::webview_window(GATEWAY_WINDOW),
            "gateway-cancel",
            serde_json::json!({ "requestId": request_id }),
        );
    }

    /// Ready exactly when the worker's beat is fresh — the whole reason the question exists.
    ///
    /// This bridge dispatches into a webview window that macOS suspends when it is hidden, so
    /// "can you answer?" and "has the worker reported in recently?" are the same question here.
    /// The core cannot answer it: the beat is a fact about the webview, and the core would have to
    /// assume that every bridge shares it. `Beat` carries the bound's inputs rather than a
    /// pre-decided `bool` so that this stays *this bridge's* rule.
    ///
    /// Delegates to `webview_ready` rather than writing the comparison here, so that this — the one
    /// implementation that serves production traffic and the only one no test can construct —
    /// shares its answer with the doubles that *are* tested.
    fn ready(&self, beat: Beat) -> bool {
        webview_ready(beat)
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
    let core =
        GatewayCore::new(Arc::new(EventBridge { app: app.clone() }), gateway::vault_key_provider())
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
                    .with_spend(gateway::vault_spend_provider(store.clone()))
                    // Memory/context layer: the request path needs the store to reach the FTS5
                    // recall index. `None` when no store is managed (a harness), which degrades the
                    // layer to "no memory" rather than panicking — same rule as the two above.
                    .with_store(store),
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
        has_key: matches!(state.core.master_key_state(), gateway::MasterKeyLookup::Ready(_)),
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
    log_to_file(&app, &format!("enable: listener bound in {}ms", t_bind.elapsed().as_millis()));
    state.core.set_running(true);
    let bound = handle.addr.port();
    *state.server.lock().unwrap() = Some(handle);
    log_to_file(&app, &format!("enabled on port {bound}"));
    // Keep the entry we publish into third-party clients current: url/port, key, and the
    // capability fields that nobody should have to hand-maintain. Best-effort — a client
    // config we cannot write must never stop the gateway from serving.
    //
    // Off this command's own thread. The keychain read inside is slow after a rebuild — macOS
    // re-validates the ACL against the new code signature, measured at 18-39s — and inline it
    // delayed `gateway_enable` by exactly that, so pressing Start hung for the same stretch.
    //
    // It also *races the startup probe*, which reads the same keychain on its own thread. Two
    // concurrent reads contend for one ACL prompt and one of them comes back empty; the sync
    // loses because it retrieves the secret while the probe only checks existence. The result
    // was `no gateway key yet` on the first launch after every rebuild, so newly added models
    // waited a launch to appear. Waiting the keychain out removes the race without having to
    // order the two readers against each other.
    if let Some(store) = app.try_state::<Arc<Store>>() {
        let sync_app = app.clone();
        let sync_store = store.inner().clone();
        std::thread::spawn(move || sync_workbuddy_with_retry(&sync_app, &sync_store));
    }
    spawn_watchdog(app, state);
    Ok(bound)
}

/// How long to wait for the keychain to settle before reporting the sync as skipped.
///
/// Sized against the measurement: the cold-ACL read took 39s, so 45s clears it with margin. The
/// wait costs nothing — it is a sleeping thread, not a blocked command.
const SYNC_KEY_WAIT: Duration = Duration::from_secs(45);
const SYNC_KEY_POLL: Duration = Duration::from_secs(3);

/// Whether a sync failure is the transient "keychain not ready" one rather than a real problem.
///
/// Split out so the distinction is testable without a keychain. Getting it wrong in the
/// permissive direction would retry a genuine misconfiguration for the whole wait and then report
/// it, which is how a real error hides behind a retry loop.
fn is_key_not_ready(err: &str) -> bool {
    err == crate::tauri::workbuddy::NO_KEY_YET
}

/// Publish our entries, retrying while the keychain ACL settles.
fn sync_workbuddy_with_retry(app: &AppHandle, store: &Arc<Store>) {
    let deadline = std::time::Instant::now() + SYNC_KEY_WAIT;
    loop {
        match crate::tauri::workbuddy::sync(store) {
            Ok(r) => {
                log_to_file(
                    app,
                    &format!(
                        "workbuddy sync: {} published, {} stale removed",
                        r.updated, r.removed
                    ),
                );
                return;
            }
            Err(e) if is_key_not_ready(&e) && std::time::Instant::now() < deadline => {
                std::thread::sleep(SYNC_KEY_POLL);
            }
            Err(e) => {
                log_to_file(app, &format!("workbuddy sync skipped: {e}"));
                return;
            }
        }
    }
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
pub fn gateway_key_generate(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    let _key = state.core.rotate_master_key()?;
    gateway::copy_master_key()
}

#[tauri::command]
pub fn gateway_key_copy() -> Result<(), String> {
    gateway::copy_master_key()
}

#[tauri::command]
pub fn gateway_key_revoke(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    state.core.revoke_master_key()
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
    crate::core::vault::put(&account, &secret).map_err(|e| e.to_string())?;
    if let Err(e) = crate::core::persist::gateway_key_insert(&store, &id, &label) {
        // Roll back the keychain entry: a secret with no row is an unrevokable ghost.
        let _ = crate::core::vault::delete(&account);
        return Err(e.to_string());
    }
    // No provider refresh needed: the key provider re-reads the active ids per request, so the
    // new key works on the very next call without a restart.
    if let Err(e) = gateway::copy_text(&secret) {
        // The key is the ONLY copy of the secret — if it never reaches the clipboard the user
        // can't use it, so unwind both stores rather than leave a credential nobody holds.
        let _ = crate::core::vault::delete(&account);
        let _ = crate::core::persist::gateway_key_delete(&store, &id);
        return Err(e);
    }
    Ok(AppKeyCreated { id, label })
}

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
#[derive(serde::Serialize)]
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

#[tauri::command]
pub fn gateway_app_keys(store: State<'_, Arc<Store>>) -> Result<Vec<AppKeyView>, String> {
    let rows = crate::core::persist::gateway_keys_list(&store).map_err(|e| e.to_string())?;
    let spend = crate::core::persist::month_spend_by_app(&store);
    Ok(rows
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
        .collect())
}

/// 0017: set one app's monthly budget in micro-USD. `0` — or anything negative — clears it.
///
/// The value is passed through rather than clamped here: `gateway_key_cap_set` owns the
/// normalization (`<= 0` → `NULL`), and clamping in two places is how two spellings of "uncapped"
/// get introduced.
#[tauri::command]
pub fn gateway_app_key_cap_set(
    store: State<'_, Arc<Store>>,
    id: String,
    cap_micros: i64,
) -> Result<(), String> {
    crate::core::persist::gateway_key_cap_set(&store, &id, cap_micros).map_err(|e| e.to_string())
}

/// Revoke one app key. Takes effect on the next request — the master key and every other app
/// key are untouched, which is the whole point (audit R4).
#[tauri::command]
pub fn gateway_app_key_revoke(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    crate::core::persist::gateway_key_revoke(&store, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gateway_app_key_delete(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    crate::core::persist::gateway_key_delete(&store, &id).map_err(|e| e.to_string())
}

/// Short random id — not security-sensitive (the secret is the key), just collision-resistant.
fn uuid_like() -> String {
    use rand::Rng as _;
    (0..16).map(|_| format!("{:x}", rand::rngs::OsRng.gen_range(0..16))).collect()
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
    let month = crate::core::persist::month_spend_micros(&store);
    let cap = crate::core::persist::spend_cap_micros(&store).unwrap_or(0);
    Ok(SpendStatus { month_micros: month, cap_micros: cap, capped: cap > 0 && month >= cap })
}

/// Set the monthly cap in micro-USD. `0` disables it.
#[tauri::command]
pub fn gateway_spend_cap_set(store: State<'_, Arc<Store>>, cap_micros: i64) -> Result<(), String> {
    crate::core::persist::spend_cap_set(&store, cap_micros.max(0)).map_err(|e| e.to_string())
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

/// Audit H1b: whether gateway-side tools may mutate the workspace (`write_file`, `run_command`).
/// Read-only tools stay available regardless. Defaults to false — see `GatewayCore`.
#[tauri::command]
pub fn get_tools_mutation_enabled(state: State<'_, Arc<GatewayState>>) -> Result<bool, String> {
    Ok(state.core.is_tools_mutation_enabled())
}

#[tauri::command]
pub fn set_tools_mutation_enabled(
    enabled: bool,
    state: State<'_, Arc<GatewayState>>,
) -> Result<(), String> {
    state.core.set_tools_mutation_enabled(enabled);
    Ok(())
}

/// Set the workspace root for local tool execution (write_file, mkdir, run_command).
/// Must be called before tools are used in gateway mode.
/// Set the workspace root. Split out of the command so the refusal is testable without an
/// `AppHandle` — this one does not log, so there is nothing to inject.
pub(crate) fn set_gateway_workspace_root(
    state: &Arc<GatewayState>,
    root: &str,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(root);
    // Validate at set time, not only at call time. `tool_run` re-validates on every call, so
    // accepting a bad root was never a breach — but `gateway_get_workspace_root` reported it as
    // set, and the refusal then surfaced mid-request as a tool error the model had to interpret.
    // Storing the canonical path also freezes `..` and symlinks: what is set is what is used.
    let canonical = crate::core::tools::validate_root(&path)?;
    state.core.set_workspace_root(canonical);
    Ok(())
}

#[tauri::command]
pub fn gateway_set_workspace_root(
    state: State<'_, Arc<GatewayState>>,
    root: String,
) -> Result<(), String> {
    set_gateway_workspace_root(&state, &root)
}

/// Get the current workspace root, or null if not set.
#[tauri::command]
pub fn gateway_get_workspace_root(
    state: State<'_, Arc<GatewayState>>,
) -> Result<Option<String>, String> {
    Ok(state.core.workspace_root().map(|p| p.to_string_lossy().to_string()))
}

/// The project scope the gateway will resolve for an incoming request: a hash of the workspace
/// root, not the path itself.
///
/// The Memory screen needs this to scope a memory to "this project" — the hash lives on the host
/// and duplicating FNV-1a in TypeScript would be a second implementation of a value that has to
/// match exactly, or a memory scoped from the UI would never be visible to the request path.
#[tauri::command]
pub fn gateway_project_key(state: State<'_, Arc<GatewayState>>) -> Result<Option<String>, String> {
    Ok(state.core.workspace_root().and_then(|p| {
        crate::core::gateway::context_scope::project_key_from_root(&p.to_string_lossy())
    }))
}

/// The memory/context layer's master switch.
///
/// Off by default. With it off the gateway performs **no memory reads and no memory writes** — that
/// is the ship-blocking acceptance criterion in §9, so the toggle is not a cosmetic one: it is the
/// thing that makes the layer safe to ship behind. The UI turning it on is an explicit act, and the
/// request path consults it on every request rather than caching it at startup.
#[tauri::command]
pub fn gateway_memory_enabled(state: State<'_, Arc<GatewayState>>) -> Result<bool, String> {
    Ok(state.core.memory_enabled())
}

#[tauri::command]
pub fn gateway_set_memory_enabled(
    state: State<'_, Arc<GatewayState>>,
    enabled: bool,
) -> Result<bool, String> {
    state.core.set_memory_enabled(enabled);
    Ok(state.core.memory_enabled())
}

/// What the memory layer has actually done since launch.
///
/// The `AIP-Memory` response header already reports this — per request, to the client — and nowhere
/// else. So the operator running the gateway had no way to answer "why didn't the model know X"
/// short of attaching a proxy to their own machine. This is that view.
///
/// Read-only: nothing here changes behaviour. In-memory and process-scoped, so it resets when the
/// app restarts — deliberate, because the question it answers is "what is happening now", and the
/// memory path is built never to block a request, so its telemetry must not touch SQLite either.
/// See `injection_log`.
#[tauri::command]
pub fn gateway_injection_stats(
    state: State<'_, Arc<GatewayState>>,
) -> Result<InjectionStats, String> {
    Ok(state.core.injection_stats())
}

/// One-line digest of a tool call's arguments for the audit log.
///
/// The arguments are simultaneously the most useful thing to record and the most dangerous.
/// `write_file` carries the entire file body in `content`; `edit_file` carries the old and new
/// text. Logging those verbatim would make the audit trail the leak it exists to catch — a model
/// asked to write a `.env` would write the secret twice, once to the workspace and once to
/// `gateway.log` in plaintext. So bodies become a length. Paths, patterns, and the `run_command`
/// program and argv ARE logged: they are what an operator needs to see what was attempted, and
/// the Assistant's confirmation modal already shows them, so the log is no wider than the UI.
///
/// Pure, and deliberately not a method on the command, so it can be tested without an
/// `AppHandle` — the same reason `gateway_tool_refusal` lives on `GatewayCore`.
fn tool_arg_digest(name: &str, args: &serde_json::Value) -> String {
    const MAX_ARG_CHARS: usize = 300;
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let raw = match name {
        // Lengths, never bodies: the content IS the user's data.
        "write_file" => format!("path={path} content={}B", value_len(args.get("content"))),
        "edit_file" => format!(
            "path={path} old={}B new={}B",
            value_len(args.get("old")),
            value_len(args.get("new"))
        ),
        "run_command" => format!(
            "program={} args={}",
            args.get("program").and_then(|v| v.as_str()).unwrap_or("?"),
            args.get("args").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string())
        ),
        "search_files" => format!(
            "path={path} pattern={}",
            args.get("pattern").and_then(|v| v.as_str()).unwrap_or("?")
        ),
        "read_file" | "file_info" | "list_dir" | "mkdir" => format!("path={path}"),
        // An unrecognised tool is not a reason to log blindly, but it is also not a reason to
        // log nothing: fall back to the whole object, still bounded below.
        _ => args.to_string(),
    };
    truncate_chars(&raw, MAX_ARG_CHARS)
}

/// Size of a JSON value as it would land on disk.
fn value_len(v: Option<&serde_json::Value>) -> usize {
    match v {
        Some(serde_json::Value::String(s)) => s.len(),
        Some(other) => other.to_string().len(),
        None => 0,
    }
}

/// Truncate on a char boundary, not a byte one: `&raw[..n]` panics mid-UTF-8, and a model
/// writing a multi-byte filename is enough to reach it.
fn truncate_chars(s: &str, max: usize) -> String {
    let total = s.chars().count();
    if total <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…(+{} chars)", total - max)
    }
}

/// Record one gateway tool call in the context graph, fire-and-forget.
///
/// Spawned, never awaited: `context::record` takes `store.conn.lock()` — the same connection the
/// ledger writes to — so awaiting it inline would put a lock acquisition on the request path and
/// let a slow graph write stall the tool call the model is waiting on. Spawned, a failed write
/// can only ever lose a graph node, never the result.
///
/// `session_id` is None on purpose. `context::sessions` excludes unsessioned nodes, so a gateway
/// call appears in the Context graph without inventing a History row that has no messages in it.
///
/// The node carries the digest, not the result: for `read_file` the result IS the file's
/// contents, and the graph is written to disk in plaintext.
fn record_gateway_tool_call(
    store: Arc<Store>,
    request_id: u64,
    tool: &str,
    digest: &str,
    ok: bool,
    out_bytes: usize,
    refused: bool,
) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let node = crate::core::context::ContextNode {
        id: format!("gateway:{request_id}:{tool}:{ts}"),
        // `skill` is the kind the Assistant already uses for a tool call, and the closed set of
        // four kinds is deliberate — a tool call is not a fifth kind of thing.
        kind: "skill".into(),
        label: tool.into(),
        source: "gateway".into(),
        session_id: None,
        ts,
        meta_json: Some(
            serde_json::json!({
                "request_id": request_id,
                "ok": ok,
                "out_bytes": out_bytes,
                "refused": refused,
                "args": digest,
            })
            .to_string(),
        ),
    };
    std::thread::spawn(move || {
        let _ = crate::core::context::record(&store, &[node], &[]);
    });
}

/// Execute a gateway tool call: gate it, run it, record it, log it.
///
/// Split out of the Tauri command so the whole path is testable without an `AppHandle` — the
/// same reason `gateway_tool_refusal` lives on `GatewayCore`. `log` is a closure rather than an
/// `Option<&AppHandle>` so a test can capture the line and assert its shape instead of skipping
/// it; the audit format is part of what this function promises.
pub(crate) fn run_gateway_tool(
    state: &Arc<GatewayState>,
    log: &dyn Fn(&str),
    request_id: u64,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<crate::core::tools::ToolResult, String> {
    let root = state.core.workspace_root().ok_or_else(|| {
        "workspace root not set — call gateway_set_workspace_root first".to_string()
    })?;

    // Audit H1b: the Assistant asks before every call; the gateway cannot — there is no UI on
    // that path. So mutation is gated here, host-side, where no caller can talk past it.
    if let Some(reason) = state.core.gateway_tool_refusal(&tool_name) {
        // A refused call is the most worth recording — it is the one that did not happen.
        let digest = tool_arg_digest(&tool_name, &arguments);
        // A refused call is the most worth recording — it is the one that did not happen.
        record_gateway_tool_call(
            state.store.clone(),
            request_id,
            &tool_name,
            &digest,
            false,
            0,
            true,
        );
        log(&format!(
            "tool req={request_id} tool={tool_name} args={digest} -> REFUSED: {}",
            truncate_chars(&reason, 200)
        ));
        return Ok(crate::core::tools::ToolResult {
            ok: false,
            output: String::new(),
            error: Some(reason),
        });
    }

    // Audit trail. A gateway tool call is model-driven action on the user's filesystem with no
    // human in the loop; if it is never written down it cannot be reviewed after the fact.
    //
    // Written AFTER the call so it can carry the outcome, and carrying the request id so a line
    // can be tied back to the request that produced it. The result's *body* is deliberately not
    // logged — for `read_file` it is the file's contents — only whether it worked, how big it
    // was, and a bounded error.
    let log_name = tool_name.clone();
    let digest = tool_arg_digest(&tool_name, &arguments);
    let req = crate::core::tools::ToolRunRequest {
        name: tool_name,
        arguments,
        root: root.to_string_lossy().to_string(),
    };
    let result = crate::core::tools::tool_run(req);
    record_gateway_tool_call(
        state.store.clone(),
        request_id,
        &log_name,
        &digest,
        result.ok,
        result.output.len(),
        false,
    );
    log(&format!(
        "tool req={request_id} tool={log_name} root={} args={digest} -> ok={} out={}B err={}",
        root.display(),
        result.ok,
        result.output.len(),
        result.error.as_deref().map(|e| truncate_chars(e, 200)).unwrap_or_else(|| "-".to_string())
    ));
    Ok(result)
}

/// Execute a tool call locally (write_file, read_file, list_dir, run_command).
/// Returns the result to the bridge for re-dispatch back to the model.
#[tauri::command]
pub fn gateway_tool_run(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<crate::core::tools::ToolResult, String> {
    let log = |line: &str| log_to_file(&app, line);
    run_gateway_tool(&state, &log, request_id, tool_name, arguments)
}

/// Webview liveness heartbeat (2s cadence from bridge.ts): proves the router core answers.
#[tauri::command]
pub fn gateway_heartbeat(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
) -> Result<(), String> {
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
    let Ok(mut f) =
        std::fs::OpenOptions::new().create(true).append(true).open(dir.join("gateway.log"))
    else {
        return;
    };
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "{secs} {line}");
}

/// How much of the tail to read. The log is appended to for the life of the install, so reading it
/// whole to show twenty lines would grow without bound.
const LOG_TAIL_BYTES: u64 = 128 * 1024;

/// One line of `gateway.log`, split into its timestamp and its text.
#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GatewayLogLine {
    /// Unix **milliseconds**, or `None` for a line that does not start with a timestamp. The file
    /// stores seconds; converting here keeps the UI from having to know the format.
    pub ts_ms: Option<u64>,
    pub text: String,
}

/// Split a log tail into lines, oldest first, at most `limit` of them.
///
/// Pure and separate from the file read so it is testable without an `AppHandle` — the same
/// reasoning as `tool_arg_digest` beside it.
///
/// `truncated_head` says whether the read started mid-file. When it did, the first line is a
/// fragment of a line that began before the window and is dropped: half a line reads as a corrupt
/// line, and finding the real boundary would mean reading forwards from the start, which is the
/// unbounded read this exists to avoid. When the whole file fit in the window, the first line is
/// complete and must survive — dropping it there would silently eat the oldest line on every short
/// log, which is the bug this flag exists to prevent.
pub(crate) fn parse_log_tail(
    text: &str,
    limit: usize,
    truncated_head: bool,
) -> Vec<GatewayLogLine> {
    // The floor lives here, not in `gateway_log_tail`, because this is the function the floor is a
    // property *of* — and the command cannot be unit-tested without an `AppHandle`, so a floor
    // enforced only there would be an untested rule. The ceiling stays in the command: it is a
    // policy about scraping, not about parsing.
    let limit = limit.max(1);
    let mut lines: Vec<&str> = text.lines().collect();
    if truncated_head && !lines.is_empty() {
        lines.remove(0);
    }
    let start = lines.len().saturating_sub(limit);
    lines[start..]
        .iter()
        .map(|raw| {
            // `log_to_file` writes `{unix_secs} {text}`.
            let (ts_ms, body) = match raw.split_once(' ') {
                Some((head, rest))
                    if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) =>
                {
                    (head.parse::<u64>().ok().map(|s| s * 1_000), rest)
                }
                _ => (None, *raw),
            };
            GatewayLogLine {
                ts_ms,
                // A second bound after the one `tool_arg_digest` applies: `log_to_file` is also
                // called with format strings built elsewhere, and a model controls part of what
                // reaches this file.
                text: truncate_chars(body, 500),
            }
        })
        .collect()
}

/// The tail of `{app_data_dir}/gateway.log`, oldest line first.
///
/// The tool audit trail has been written since 2026-09-20 with no way to read it back, which made
/// it evidence nobody could consult — the log existed to answer "what did an agent do on this
/// machine", and the only answer was a file path the UI never mentioned.
///
/// Bounded at both ends: at most `limit` lines (capped), read from the last `LOG_TAIL_BYTES`.
#[tauri::command]
pub fn gateway_log_tail(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<GatewayLogLine>, String> {
    use std::io::{Read as _, Seek as _};
    use tauri::Manager as _;

    /// A caller asking for more than this is not reading a log, it is scraping one.
    const MAX_LIMIT: usize = 1_000;
    // Only the ceiling. The floor of one is `parse_log_tail`'s, so it is enforced where it is
    // tested rather than in a command no unit test can reach.
    let limit = limit.unwrap_or(200).min(MAX_LIMIT);

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut f = match std::fs::File::open(dir.join("gateway.log")) {
        Ok(f) => f,
        // No log yet is not an error — a gateway that has never run has nothing to report, and
        // this screen must not show a failure for it.
        Err(_) => return Ok(Vec::new()),
    };

    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let truncated_head = len > LOG_TAIL_BYTES;
    if truncated_head {
        f.seek(std::io::SeekFrom::Start(len - LOG_TAIL_BYTES)).map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    // Lossy is required, not lazy: seeking to a byte offset can land mid-codepoint.
    let text = String::from_utf8_lossy(&buf);
    Ok(parse_log_tail(&text, limit, truncated_head))
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
    state
        .core
        .reply(request_id, BridgeMsg::ToolCalls(crate::core::gateway::normalize_tool_calls(v)));
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
pub fn gateway_chunk(
    state: State<'_, Arc<GatewayState>>,
    request_id: u64,
    text: String,
) -> Result<(), String> {
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
    retry_after_ms: Option<u64>,
) -> Result<(), String> {
    state.core.reply(request_id, BridgeMsg::Error { status, message, retry_after_ms });
    Ok(())
}

pub fn manage(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let core = build_core(app.handle());
    // `app.manage(store)` already ran in lib.rs setup, so the state is there; this clones the
    // Arc rather than moving it, because every other command still needs the same store.
    let store = (*app.state::<Arc<Store>>()).clone();
    app.manage(Arc::new(GatewayState { core, server: Mutex::new(None), store }));
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

#[cfg(test)]
mod log_tail_tests {
    use super::*;

    /// The reason the reader is bounded: the log is appended to forever and the UI wants the end.
    #[test]
    fn only_the_last_lines_are_returned_oldest_first() {
        let got = parse_log_tail("1 a\n2 b\n3 c\n4 d\n", 2, false);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].text, "c");
        assert_eq!(got[1].text, "d");
        // Seconds on disk, milliseconds on the wire — the conversion is the reader's job.
        assert_eq!(got[0].ts_ms, Some(3_000));
    }

    /// A tail read from the middle of the file starts mid-line. Showing that fragment reads as a
    /// corrupt line, so it goes — but only when the read really did start mid-file. Dropping it
    /// unconditionally would silently eat the oldest line of every log short enough to fit.
    #[test]
    fn a_fragment_at_the_head_is_dropped_only_when_the_read_was_truncated() {
        let text = "alf a line\n2 a whole line\n";

        let cut = parse_log_tail(text, 10, true);
        assert_eq!(cut.len(), 1);
        assert_eq!(cut[0].text, "a whole line");

        let whole = parse_log_tail(text, 10, false);
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[0].text, "alf a line");
    }

    /// A line with no timestamp is still evidence. `log_to_file` is called from paths that do not
    /// stamp their lines, and dropping those would hide exactly the startup evidence it exists for.
    ///
    /// The lines it asserts on are placed **after the first**, and neither the length nor the first
    /// line is referenced: put the untimed line first and this test also fails whenever the
    /// head-fragment rule breaks, so a failure here could mean either thing.
    #[test]
    fn a_line_without_a_timestamp_is_kept() {
        let got = parse_log_tail("1 first\nno stamp here\n3 a stamped line\n", 10, false);
        let untimed =
            got.iter().find(|l| l.text == "no stamp here").expect("the untimed line survives");
        assert_eq!(untimed.ts_ms, None);
        // And a stamped neighbour is still stamped, so "no timestamp" is this line's property
        // rather than the parser having given up on stamps altogether.
        assert_eq!(got.iter().find(|l| l.text == "a stamped line").unwrap().ts_ms, Some(3_000));
    }

    /// A model controls part of what reaches the log, so one line must not grow without bound —
    /// and the cut has to land on a char boundary or it panics mid-UTF-8.
    ///
    /// Selected by content for the same reason as the test above.
    #[test]
    fn a_very_long_line_is_capped_on_a_char_boundary() {
        let got = parse_log_tail(&format!("1 short\n2 {}", "é".repeat(2_000)), 10, false);
        let long = got.iter().find(|l| l.text.starts_with('é')).expect("the long line survives");
        assert_eq!(long.ts_ms, Some(2_000));
        assert!(long.text.chars().count() < 600, "capped, got {}", long.text.chars().count());
        assert!(long.text.starts_with('é'), "the cut is on a char boundary");
    }

    /// `limit` is a floor of one, not zero: a caller asking for nothing is a bug, and returning
    /// the newest line is the more useful reading of it.
    #[test]
    fn a_zero_limit_still_returns_one_line() {
        assert_eq!(parse_log_tail("1 a\n2 b\n", 0, false).len(), 1);
    }

    /// An empty log is not an error and not a blank line.
    #[test]
    fn an_empty_tail_returns_nothing() {
        assert!(parse_log_tail("", 10, false).is_empty());
        assert!(parse_log_tail("", 10, true).is_empty());
    }
}

#[cfg(test)]
mod sync_retry_tests {
    use super::*;

    /// The retry must fire on exactly one error, and the failure that matters is the permissive
    /// one: retrying a real problem hides it for the whole wait and then reports it anyway, which
    /// reads as a hang rather than as a misconfiguration.
    #[test]
    fn only_the_missing_key_error_is_worth_waiting_for() {
        assert!(is_key_not_ready(crate::tauri::workbuddy::NO_KEY_YET));

        assert!(!is_key_not_ready("cannot read /nope/models.json: No such file or directory"));
        // Near-misses must not match — the comparison is exact on purpose.
        assert!(!is_key_not_ready("no gateway key"));
        assert!(!is_key_not_ready(""));
    }
}

#[cfg(test)]
mod tool_audit_tests {
    use super::*;

    fn args(json: serde_json::Value) -> serde_json::Value {
        json
    }

    /// The whole reason the digest exists: a `write_file` body is the user's data, and the log
    /// is a plaintext file. Recording it would make the audit trail the leak it exists to catch.
    #[test]
    fn a_written_body_is_logged_as_a_length_never_as_content() {
        let secret = "OPENAI_API_KEY=sk-live-DEADBEEFnotarealkey";
        let a = args(serde_json::json!({ "path": "app/.env", "content": secret }));
        let d = tool_arg_digest("write_file", &a);
        assert!(d.contains("path=app/.env"), "the path is what matters: {d}");
        assert!(d.contains(&format!("content={}B", secret.len())), "length not body: {d}");
        assert!(!d.contains("sk-live"), "the secret must not reach the log: {d}");
    }

    #[test]
    fn edit_file_logs_both_lengths_and_neither_body() {
        let a = args(serde_json::json!({ "path": "a.txt", "old": "hunter2", "new": "*******" }));
        let d = tool_arg_digest("edit_file", &a);
        assert!(d.contains("old=7B"), "{d}");
        assert!(d.contains("new=7B"), "{d}");
        assert!(!d.contains("hunter2"), "neither side of the edit is logged: {d}");
    }

    /// `run_command` is the tool whose arguments matter most — it is the one that executes — and
    /// the Assistant already shows them in the confirmation modal, so the log is no wider.
    #[test]
    fn run_command_logs_the_program_and_argv() {
        let a = args(serde_json::json!({ "program": "git", "args": ["status", "--short"] }));
        let d = tool_arg_digest("run_command", &a);
        assert!(d.contains("program=git"), "{d}");
        assert!(d.contains("status"), "argv is the point of the record: {d}");
    }

    /// Read tools have no body to protect, so the path is recorded verbatim.
    #[test]
    fn read_tools_log_their_path() {
        let a = args(serde_json::json!({ "path": "src/lib/x.ts" }));
        assert_eq!(tool_arg_digest("read_file", &a), "path=src/lib/x.ts");
        let s = args(serde_json::json!({ "pattern": "TODO", "path": "src" }));
        assert_eq!(tool_arg_digest("search_files", &s), "path=src pattern=TODO");
    }

    /// A model controls the string, so a pathological one must not wedge an unbounded line into
    /// the log — and the truncation must not panic on a multi-byte char boundary.
    #[test]
    fn an_oversized_argument_is_bounded_and_survives_multibyte_text() {
        let huge = "é".repeat(5000);
        let a = args(serde_json::json!({ "path": huge }));
        let d = tool_arg_digest("read_file", &a);
        assert!(d.chars().count() < 400, "bounded: {}", d.chars().count());
        assert!(d.contains("+"), "the cut is marked, not silent: {d}");
    }

    #[test]
    fn truncate_chars_leaves_short_strings_alone() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("hello", 5), "hello");
        assert_eq!(truncate_chars("hello", 2), "he…(+3 chars)");
    }

    /// A workspace root of `/` or `$HOME` must be refused when it is SET, not discovered later
    /// as a tool error mid-request. `tool_run` re-validates, so this was never a breach — it was
    /// a root the getter reported as set while every call refused it.
    #[test]
    fn a_bad_workspace_root_is_refused_at_set_time() {
        assert!(crate::core::tools::validate_root(std::path::Path::new("/")).is_err());
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            assert!(crate::core::tools::validate_root(std::path::Path::new(&home)).is_err());
        }
        for d in ["/System", "/usr", "/bin", "/sbin", "/etc", "/private"] {
            assert!(
                crate::core::tools::validate_root(std::path::Path::new(d)).is_err(),
                "{d} must be refused"
            );
        }
    }

    fn temp_ctx_store(tag: &str) -> (Arc<Store>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-gwctx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(Store::open(&dir).unwrap()), dir)
    }

    /// The reason `GatewayState` carries a store at all: a gateway tool call becomes reviewable
    /// in the Context screen instead of living only in a flat text log.
    #[test]
    fn a_gateway_tool_call_is_recorded_in_the_context_graph() {
        let (store, _dir) = temp_ctx_store("record");
        record_gateway_tool_call(store.clone(), 42, "read_file", "path=a.txt", true, 10, false);

        // Spawned, so poll — but bound the wait so a regression fails instead of hanging.
        let found = (0..200).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(10));
            crate::core::context::graph(&store, 100)
                .ok()?
                .nodes
                .into_iter()
                .find(|n| n.id.starts_with("gateway:42:"))
        });
        let node = found.expect("the call is recorded");
        assert_eq!(node.kind, "skill", "a tool call, not a new node kind");
        assert_eq!(node.source, "gateway", "distinguishable from Assistant activity");
        assert_eq!(node.label, "read_file");
        assert!(node.session_id.is_none(), "unsessioned — it belongs to the graph, not History");
        let meta = node.meta_json.as_deref().unwrap_or("{}");
        assert!(meta.contains("path=a.txt"), "the digest is kept: {meta}");
        assert!(meta.contains("\"out_bytes\":10"), "{meta}");
    }

    /// Unsessioned nodes are excluded from `sessions()`, which is the whole point: a gateway
    /// tool call must not invent a History row containing no messages.
    #[test]
    fn a_recorded_gateway_call_does_not_invent_a_history_session() {
        let (store, _dir) = temp_ctx_store("nosession");
        record_gateway_tool_call(store.clone(), 7, "list_dir", "path=.", true, 3, false);
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            if !crate::core::context::graph(&store, 100).unwrap().nodes.is_empty() {
                break;
            }
        }
        assert!(
            crate::core::context::sessions(&store, 50).unwrap().is_empty(),
            "no phantom History session"
        );
    }

    /// A refused call is the one most worth recording — it is the action that did NOT happen.
    #[test]
    fn a_refused_call_is_recorded_as_refused() {
        let (store, _dir) = temp_ctx_store("refused");
        record_gateway_tool_call(store.clone(), 9, "run_command", "program=rm", false, 0, true);
        let found = (0..200).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(10));
            crate::core::context::graph(&store, 100)
                .ok()?
                .nodes
                .into_iter()
                .find(|n| n.id.starts_with("gateway:9:"))
        });
        let node = found.expect("a refused call is recorded too");
        let meta = node.meta_json.as_deref().unwrap_or("{}");
        assert!(meta.contains("\"refused\":true"), "{meta}");
        assert!(meta.contains("\"ok\":false"), "{meta}");
    }
}
