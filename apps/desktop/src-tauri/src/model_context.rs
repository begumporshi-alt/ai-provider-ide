//! Per-model context-window cache (design §3.4).
//!
//! The gateway sizes the injected block against the model's window, and Rust cannot see the TS
//! catalog — the catalog lives in the webview, where provider selection, key handling and fallback
//! already are. Duplicating that here would mean a second provider stack in Rust just to read one
//! number. So the webview publishes the numbers it already has and the host reads them.
//!
//! Two properties that matter more than freshness:
//!
//! - **Absence degrades to the conservative default, never to zero and never to a guess at the top
//!   end.** An unknown model gets `DEFAULT_WINDOW_TOKENS`, which under-injects. Being wrong low costs
//!   a slightly less useful answer; being wrong high overflows the window and fails the request.
//! - **A stale row is better than no row.** The catalog is refetched roughly daily; a window does not
//!   change meaningfully in between, so an old value is still far better than 8192 for a 200k model.
//!
//! An alias that arrives unqualified (a bare `gpt-4o` with no provider prefix) will not match a
//! qualified key and falls back to the default. That is the correct direction to fail, and resolving
//! aliases here would mean duplicating the alias table's precedence rules in Rust.
use rusqlite::params;
use serde::Deserialize;

use crate::store::Store;

/// Largest window we will believe. A provider that publishes something absurd is more likely to
/// have a units bug than a ten-million-token model, and believing it would blow the budget — which
/// is capped separately, but the reserve below is not.
const MAX_WINDOW: i64 = 2_000_000;

/// One row as the webview sends it. The key is the qualified id used in requests, `slug/nativeId`.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelContextInput {
    pub model_key: String,
    pub context_window: i64,
    pub chars_per_token: Option<f64>,
}

/// What the budget planner needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelWindow {
    pub window: usize,
    pub chars_per_token: f64,
}

impl Default for ModelWindow {
    fn default() -> Self {
        Self {
            window: crate::gateway::context_scope::DEFAULT_WINDOW_TOKENS,
            chars_per_token: crate::gateway::context_scope::CHARS_PER_TOKEN,
        }
    }
}

/// Publish a set of windows. An upsert, not a replace: the webview refreshes one provider at a
/// time, so wiping the table would drop every other provider's rows the moment any one refreshed.
pub fn upsert(store: &Store, entries: &[ModelContextInput]) -> Result<usize, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut written = 0usize;
    for e in entries {
        let key = e.model_key.trim();
        // A non-positive or absurd window is treated as unknown rather than stored: writing it
        // would make the next request plan against a number that cannot be right.
        if key.is_empty() || e.context_window <= 0 || e.context_window > MAX_WINDOW {
            continue;
        }
        let cpt = e.chars_per_token.filter(|v| v.is_finite() && *v > 0.5 && *v < 20.0);
        let n = conn
            .execute(
                "INSERT INTO router_model_context (model_key, context_window, chars_per_token, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(model_key) DO UPDATE SET context_window = excluded.context_window,
                                                      chars_per_token = excluded.chars_per_token,
                                                      updated_at = excluded.updated_at",
                params![key, e.context_window, cpt, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        written += n;
    }
    Ok(written)
}

/// Read one model's window. `None` for the store (a harness) or for an unknown model yields the
/// conservative default — see the module note.
pub fn lookup(store: Option<&Store>, model: Option<&str>) -> ModelWindow {
    let Some(store) = store else { return ModelWindow::default() };
    let Some(key) = model.map(str::trim).filter(|m| !m.is_empty()) else {
        return ModelWindow::default();
    };
    let Ok(conn) = store.conn.lock() else { return ModelWindow::default() };
    let row: Option<(i64, Option<f64>)> = conn
        .query_row(
            "SELECT context_window, chars_per_token FROM router_model_context WHERE model_key = ?1",
            params![key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((window, cpt)) = row else { return ModelWindow::default() };
    ModelWindow {
        window: if window > 0 && window <= MAX_WINDOW {
            window as usize
        } else {
            crate::gateway::context_scope::DEFAULT_WINDOW_TOKENS
        },
        chars_per_token: cpt
            .filter(|v| v.is_finite() && *v > 0.5 && *v < 20.0)
            .unwrap_or(crate::gateway::context_scope::CHARS_PER_TOKEN),
    }
}

/// Diagnostic: how many models the host can actually plan against.
pub fn count(store: &Store) -> Result<usize, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM router_model_context", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod model_context_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-mctx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    fn entry(key: &str, window: i64) -> ModelContextInput {
        ModelContextInput { model_key: key.into(), context_window: window, chars_per_token: None }
    }

    #[test]
    fn a_known_model_plans_against_its_own_window() {
        let (s, d) = temp_store("known");
        assert_eq!(upsert(&s, &[entry("openrouter/gpt-4o", 128_000)]).unwrap(), 1);
        let got = lookup(Some(&s), Some("openrouter/gpt-4o"));
        assert_eq!(got.window, 128_000);
        // And an unknown model falls back rather than to zero: under-injecting is the safe way to
        // be wrong.
        assert_eq!(
            lookup(Some(&s), Some("nobody/whatever")).window,
            crate::gateway::context_scope::DEFAULT_WINDOW_TOKENS
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn refreshing_one_provider_does_not_drop_the_others() {
        let (s, d) = temp_store("upsert");
        upsert(&s, &[entry("a/one", 8_000)]).unwrap();
        upsert(&s, &[entry("b/two", 200_000)]).unwrap();
        assert_eq!(count(&s).unwrap(), 2, "an upsert is not a replace");
        assert_eq!(lookup(Some(&s), Some("a/one")).window, 8_000);
        assert_eq!(lookup(Some(&s), Some("b/two")).window, 200_000);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A provider with a units bug publishes something absurd. Storing it would make every request
    /// plan against a number that cannot be right.
    #[test]
    fn an_implausible_window_is_refused_rather_than_stored() {
        let (s, d) = temp_store("absurd");
        assert_eq!(
            upsert(&s, &[entry("x/huge", 999_999_999), entry("x/neg", -1), entry("x/zero", 0)])
                .unwrap(),
            0,
            "none of these are believable"
        );
        assert_eq!(count(&s).unwrap(), 0);
        assert_eq!(
            lookup(Some(&s), Some("x/huge")).window,
            crate::gateway::context_scope::DEFAULT_WINDOW_TOKENS
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_char_ratio_outside_any_sane_range_is_ignored() {
        let (s, d) = temp_store("cpt");
        upsert(
            &s,
            &[ModelContextInput {
                model_key: "m/1".into(),
                context_window: 32_000,
                chars_per_token: Some(0.0),
            }],
        )
        .unwrap();
        let got = lookup(Some(&s), Some("m/1"));
        assert_eq!(got.window, 32_000);
        assert_eq!(got.chars_per_token, crate::gateway::context_scope::CHARS_PER_TOKEN);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_store_or_no_model_degrades_to_the_default() {
        assert_eq!(lookup(None, Some("m/1")), ModelWindow::default());
        let (s, d) = temp_store("none");
        assert_eq!(lookup(Some(&s), None), ModelWindow::default());
        assert_eq!(lookup(Some(&s), Some("  ")), ModelWindow::default());
        let _ = std::fs::remove_dir_all(&d);
    }
}
