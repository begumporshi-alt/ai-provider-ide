//! Tauri application entry point. Was `src/lib.rs` before the core/tauri split; the module
//! declarations it used to carry now live in `src/lib.rs`, so the bare `store::`, `vault::` and
//! `gateway_cmds::` names below are re-bound here rather than rewritten at every call site.

use std::sync::{Arc, RwLock};

use tauri::Manager;

use crate::core::{crash_report, egress, gateway, store, vault};
use crate::tauri::{commands, gateway_cmds};

/// Seed the egress allowlist from registered provider base URLs. Only statuses that can
/// actually serve (pending/enabled/repairing) are allowed (invariant 9: no stale grants).
fn initial_allow_hosts(store: &store::Store) -> std::collections::HashSet<String> {
    let conn = store.conn.lock().unwrap();
    let mut hosts = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn
        .prepare("SELECT base_url FROM providers WHERE status IN ('pending','enabled','repairing')")
    {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for row in rows.flatten() {
                if let Ok(u) = reqwest::Url::parse(&row) {
                    if let Some(h) = u.host_str() {
                        hosts.insert(h.to_lowercase());
                    }
                }
            }
        }
    }
    hosts
}

/// §4 startup hygiene: probe every key's secret_ref against the keychain; on a miss mark the
/// key 'invalid' so the Providers screen can run the re-enter-key flow (audit H7). The raw
/// secret is never read out — only existence is checked, host-side.
fn probe_key_refs(store: &store::Store) {
    let refs: Vec<(String, String)> = {
        let conn = store.conn.lock().unwrap();
        let Ok(mut stmt) =
            conn.prepare("SELECT id, secret_ref FROM api_keys WHERE status != 'invalid'")
        else {
            return;
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    };
    let mut missing = Vec::new();
    for (id, account) in refs {
        if let Ok(None) = vault::get(&account) {
            missing.push(id);
        }
    }
    if !missing.is_empty() {
        let conn = store.conn.lock().unwrap();
        for id in missing {
            let _ = conn.execute(
                "UPDATE api_keys SET status = 'invalid' WHERE id = ?1",
                rusqlite::params![id],
            );
        }
    }
}

/// R1 background mode: closing the window hides the app instead of quitting, so the gateway
/// keeps serving. The tray is the way back — and the only way out that doesn't require
/// Activity Monitor — so if it cannot be built we deliberately leave close-to-quit in place.
/// Stranding a running process with no UI is worse than the problem this solves.
fn build_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItemBuilder::with_id("show", "Open AI-Provider Router").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).item(&show).separator().item(&quit).build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("AI-Provider Router")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    // Reuse the bundled app icon; a tray with no icon is invisible on most platforms.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show_window(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The decision `hide_on_close` makes, split from the `AppHandle` so it can be tested without a
/// Tauri app — the house pattern for anything a command or hook wraps.
///
/// **The default is ON.** Background mode is the whole point of shipping this, and a user who
/// wants close-to-quit can turn it off in the Gateway screen. Every unusable input (no row,
/// unparseable JSON, key absent, key not a bool) also resolves to ON, and that is deliberate: a
/// gateway that quietly stops serving because a settings row was malformed is a worse failure
/// than one that keeps running.
///
/// Pinned by `hide_on_close_defaults_on_and_only_an_explicit_false_turns_it_off`.
fn hide_on_close_from(raw: Option<&str>) -> bool {
    match raw.and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok()) {
        Some(v) => v.get("hideOnClose").and_then(|b| b.as_bool()).unwrap_or(true),
        None => true,
    }
}

/// R1: read the persisted preference, then apply `hide_on_close_from`.
fn hide_on_close(app: &tauri::AppHandle) -> bool {
    use tauri::Manager as _;
    let Some(store) = app.try_state::<std::sync::Arc<store::Store>>() else {
        return true;
    };
    let raw: Option<String> = store.conn.lock().ok().and_then(|conn| {
        conn.query_row("SELECT value_json FROM settings WHERE key='background'", [], |r| r.get(0))
            .ok()
    });
    hide_on_close_from(raw.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing (stderr JSON on debug, plain text on release)
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_env_filter(std::env::var("GW_LOG").unwrap_or_else(|_| "info".to_string()))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // L0 services: OS keychain (via keyring), egress gateway, sql-store.
            //
            // Every step below is marked in `gateway.log` rather than `tracing`. A release GUI
            // build has no console, and a *hang* in this closure is worse than a failure: the
            // process stays alive with no window, no socket and no message, so "the gateway
            // didn't come back" is indistinguishable from "it is still starting". The last
            // marker written names the step that never returned.
            let data_dir = app.path().app_data_dir()?;
            // Install the panic hook now that we know the real app data dir.
            // This captures panics that happen after setup completes (the common case).
            // Panics during setup itself will print to stderr but won't produce a report —
            // that's an acceptable tradeoff since such panics are rare and obvious.
            crash_report::install_panic_hook(data_dir.clone());
            crate::tauri::gateway_cmds::log_to_file(app.handle(), "startup: opening store");
            let store = Arc::new(
                store::Store::open(&data_dir).map_err(|e| format!("store init failed: {e}"))?,
            );
            crate::tauri::gateway_cmds::log_to_file(app.handle(), "startup: store opened");
            // Deferred off the startup path deliberately. This reads the OS keychain, and a
            // keychain read can *block* on an authorization prompt — which is exactly what happens
            // after the app is rebuilt or reinstalled, because macOS re-checks the stored ACL
            // against the new code signature. Run inline here it blocked `setup()` before any
            // window existed, so the prompt had nowhere to appear and the process simply sat
            // there: alive, no window, no socket, and no log line past this one. Off the startup
            // path the app is up and the prompt is answerable.
            //
            // It also holds no store lock across the keychain read, so moving it cannot deadlock
            // against the restore task that now runs beside it.
            let probe_app = app.handle().clone();
            let probe_store = store.clone();
            std::thread::spawn(move || {
                probe_key_refs(&probe_store);
                crate::tauri::gateway_cmds::log_to_file(&probe_app, "startup: key refs probed");
            });
            let allow = Arc::new(egress::AllowList(RwLock::new(initial_allow_hosts(&store))));
            let egress_state = Arc::new(egress::EgressState::new(allow, store.clone()));
            gateway_cmds::run_rollup(&store);
            crate::tauri::gateway_cmds::log_to_file(app.handle(), "startup: rollup done");
            // Read before `store` is handed to `app.manage` — after that it is gone.
            let startup = gateway::gateway_startup(&store);
            app.manage(store);
            app.manage(egress_state);
            gateway_cmds::manage(app)?;
            crate::tauri::gateway_cmds::log_to_file(app.handle(), "startup: state managed");
            // R1: tray is best-effort. On failure we log and fall through with close-to-quit
            // intact, so the app can never end up running with no way to reach it.
            if let Err(e) = build_tray(app.handle()) {
                tracing::warn!("tray icon unavailable — close will quit: {e}");
            }
            crate::tauri::gateway_cmds::log_to_file(
                app.handle(),
                &format!("startup: tray done, gateway_startup={startup:?}"),
            );
            // Bring the listener up — on the port it was serving on, or on the default when the
            // user has never chosen. Best-effort: a failure here must never stop the UI from
            // opening, so it is logged and dropped.
            //
            // `Default` starting the listener is not a convenience. Since the pure-HTTP migration
            // (dev-book §10 decision 2) every screen reaches the gateway over `fetch()`, so with
            // nothing bound the app is unusable rather than merely degraded: measured 2026-09-25,
            // onboarding's first write failed with `TypeError: Failed to fetch` and `bootstrap()`
            // reported the database as corrupt. `Off` — the user said so — is still honoured.
            //
            // Logged to `gateway.log`, not just `tracing`. A release GUI build has no console, so
            // the tracing-only version of this left "the app came up without a gateway" with no
            // evidence anywhere — which is exactly how a silent failure passes for a slow start.
            if let Some(port) = startup.port() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    crate::tauri::gateway_cmds::log_to_file(
                        &handle,
                        &format!("auto-start: requested port {port}"),
                    );
                    // A listener with no master key refuses *everything* with 401 —
                    // `check_gateway_key` tests the master key before it ever looks at an app key,
                    // so even the UI's own session credential cannot get in. Starting one without
                    // a key would therefore be a surface that looks healthy and serves nothing,
                    // which is worse than no surface at all.
                    //
                    // `Absent` only, never `Unavailable`: the second means the keychain did not
                    // answer, and generating there would rotate a key that already exists.
                    if let Some(state) = handle
                        .try_state::<std::sync::Arc<crate::tauri::gateway_cmds::GatewayState>>()
                    {
                        if matches!(state.core.master_key_state(), gateway::MasterKeyLookup::Absent)
                        {
                            match state.core.rotate_master_key() {
                                Ok(_) => crate::tauri::gateway_cmds::log_to_file(
                                    &handle,
                                    "auto-start: generated the first master key",
                                ),
                                Err(e) => crate::tauri::gateway_cmds::log_to_file(
                                    &handle,
                                    &format!("auto-start: master key generation FAILED: {e}"),
                                ),
                            }
                        }
                    }
                    match crate::tauri::gateway_cmds::gateway_enable(handle.clone(), Some(port))
                        .await
                    {
                        Ok(bound) => {
                            tracing::info!("gateway restored on port {bound}");
                            crate::tauri::gateway_cmds::log_to_file(
                                &handle,
                                &format!("auto-start: serving on port {bound}"),
                            );
                        }
                        Err(e) => {
                            tracing::warn!("gateway auto-start failed: {e}");
                            crate::tauri::gateway_cmds::log_to_file(
                                &handle,
                                &format!("auto-start FAILED: {e}"),
                            );
                        }
                    }
                });
            }
            crate::tauri::gateway_cmds::log_to_file(app.handle(), "startup: setup complete");
            Ok(())
        })
        .invoke_handler(commands::handlers())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // R1: closing the UI window must not end the process. The gateway is a socket in
            // this process, not a renderer, so it keeps serving regardless.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if label == "main" && hide_on_close(app) {
                    use tauri::Manager as _;
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                        tracing::info!("window hidden — gateway still serving in background");
                    }
                }
            }
            // R1: macOS Dock icon click / Finder reopen — the discoverable way back.
            // `RunEvent::Reopen` is macOS-only in Tauri, so it is gated for cross-platform builds.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::hide_on_close_from;

    /// D10. `hide_on_close` decides whether the gateway keeps serving after the window closes —
    /// the headline feature of R1 — and until 2026-09-22 nothing tested it: the symbol appeared
    /// in exactly two places, its definition and its call site. The `AppHandle` half is a
    /// settings read; this half is the decision, and it is the half that carries the default.
    ///
    /// Falsified before it was trusted: flipping the `None` arm to `false` fails the first case.
    #[test]
    fn hide_on_close_defaults_on_and_only_an_explicit_false_turns_it_off() {
        // Nothing stored, or the store is unreachable. ON.
        assert!(hide_on_close_from(None));

        // The one input that turns it off, plus its explicit counterpart.
        assert!(!hide_on_close_from(Some(r#"{"hideOnClose":false}"#)));
        assert!(hide_on_close_from(Some(r#"{"hideOnClose":true}"#)));

        // Present but unusable. Every one of these must fall back to ON — quietly stopping the
        // gateway because a settings row was malformed is the worse failure.
        assert!(hide_on_close_from(Some("{}")), "key absent");
        assert!(hide_on_close_from(Some(r#"{"hideOnClose":null}"#)), "explicit null");
        assert!(hide_on_close_from(Some(r#"{"hideOnClose":"false"}"#)), "string, not bool");
        assert!(hide_on_close_from(Some(r#"{"hideOnClose":0}"#)), "number, not bool");
        assert!(hide_on_close_from(Some("not json")), "unparseable");
        assert!(hide_on_close_from(Some("null")), "JSON null");
        assert!(hide_on_close_from(Some("")), "empty string");

        // A sibling key must not be mistaken for the preference.
        assert!(hide_on_close_from(Some(r#"{"other":false}"#)), "unrelated key");
    }
}
