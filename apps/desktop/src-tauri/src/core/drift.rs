//! Drift detection for the serving path — the Rust half of the drift monitor.
//!
//! The TypeScript monitor (`packages/router-core/src/drift-monitor.ts`) watched the TS engine's
//! attempts and triggered the repair flow: a provider fails for a model that **another provider
//! is serving fine** ("succeeded elsewhere"), the event is recorded, and the provider goes to
//! `repairing` for the UI's repair flow. A1's consolidation moved all production generation to
//! the gateway, which left that monitor blind to real traffic — recorded in D95's close-out as
//! the one piece of product logic the Rust side still owed. This module is that piece.
//!
//! **The trigger reads the ledger, not in-memory attempts.** The serving path already writes
//! every request to the ledger with provider attribution, status, and error class; a monitor
//! that reads those rows needs no new hooks on the request path. The rule matches the TS
//! monitor's, sharpened by the schema's own definition of a drift-class failure — the partial
//! index `idx_ledger_drift` names exactly the classes that mean "this provider broke" rather
//! than "this provider was busy": `NOT_FOUND`, `BAD_REQUEST_SCHEMA`, `PARSE_ERROR`,
//! `AUTH_FAILED`. A 429 is a cooldown's business, not drift's.
//!
//! **The writes are the same two the TS monitor's `onTrigger` made**: one open `drift_events`
//! row (the evidence blob is the `DriftEvidence` shape the Providers screen's drift card
//! parses) and the provider flipped to `repairing`, which is what the repair flow's UI gates
//! on. One open event per provider — a provider already flagged is not re-flagged every pass.
use crate::core::store::Store;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde_json::json;

/// How far back the ledger is consulted. The TS monitor used the same hour.
pub const WINDOW_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, PartialEq)]
pub struct DriftTrigger {
    pub provider_id: String,
    pub provider_slug: String,
    pub requested_model: String,
    pub failures: i64,
    /// A provider that served the same requested model successfully inside the window — the
    /// "elsewhere" half of the rule, and the reason this is drift rather than an outage.
    pub elsewhere_provider_id: String,
}

/// Evaluate the drift rule over the ledger window and open events for what it finds. Returns
/// the triggers it raised. Idempotent within a window: a provider with an unresolved event is
/// skipped, so N passes over the same failure raise one event.
pub fn evaluate(store: &Store, now: i64) -> Result<Vec<DriftTrigger>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let window_start = now - WINDOW_MS;

    let mut stmt = conn
        .prepare(
            "SELECT l.provider_id, p.slug, l.requested_model, COUNT(*) AS failures
               FROM ledger l JOIN providers p ON p.id = l.provider_id
              WHERE l.ts > ?1
                AND l.status != 'ok'
                AND l.error_class IN ('NOT_FOUND','BAD_REQUEST_SCHEMA','PARSE_ERROR','AUTH_FAILED')
                AND l.provider_id IS NOT NULL
                AND l.requested_model IS NOT NULL
                AND p.status = 'enabled'
              GROUP BY l.provider_id, l.requested_model",
        )
        .map_err(|e| e.to_string())?;
    let candidates = stmt
        .query_map(params![window_start], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut out = Vec::new();
    for (provider_id, slug, model, failures) in candidates {
        // One open event per provider: the drift card's row *is* the flag, and a provider under
        // repair must not be re-flagged (and re-flipped) on every pass.
        let open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM drift_events WHERE provider_id = ?1 AND resolution IS NULL",
                params![provider_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if open > 0 {
            continue;
        }

        // The elsewhere half: a success for the same requested model via a different provider,
        // newest first. Without it the failure is an outage, and outages are the cooldowns' and
        // breakers' business.
        let elsewhere: Option<String> = conn
            .query_row(
                "SELECT provider_id FROM ledger
                  WHERE ts > ?1 AND status = 'ok' AND requested_model = ?2
                    AND provider_id IS NOT NULL AND provider_id != ?3
                  ORDER BY ts DESC LIMIT 1",
                params![window_start, model, provider_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(elsewhere) = elsewhere else {
            continue;
        };

        // The evidence blob the Providers screen's drift card parses — DriftEvidence's shape.
        let evidence = json!({
            "providerId": provider_id,
            "providerSlug": slug,
            "errors": failures,
            "models": [model],
            "windowMs": WINDOW_MS,
            "detectedAt": now,
        });
        conn.execute(
            "INSERT INTO drift_events (provider_id, detected_at, trigger_json) VALUES (?1,?2,?3)",
            rusqlite::params![provider_id, now, evidence.to_string()],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE providers SET status = 'repairing' WHERE id = ?1",
            rusqlite::params![provider_id],
        )
        .map_err(|e| e.to_string())?;
        out.push(DriftTrigger {
            provider_id,
            provider_slug: slug,
            requested_model: model,
            failures,
            elsewhere_provider_id: elsewhere,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod drift_tests {
    use super::*;
    use crate::core::store::Store;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-drift-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    fn seed_provider(store: &Store, id: &str, slug: &str, status: &str) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO providers (id, slug, name, base_url, status, created_at, updated_at) VALUES (?1,?2,?3,'http://x/v1',?4,1,1)",
            rusqlite::params![id, slug, slug, status],
        )
        .unwrap();
    }

    /// One ledger row. `error_class` is what the drift rule reads, so it is the only optional
    /// the seeds bother to set beyond the identity columns.
    fn ledger_row(
        store: &Store,
        ts: i64,
        provider: Option<&str>,
        model: &str,
        status: &str,
        class: Option<&str>,
    ) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO ledger (ts, modality, source, provider_id, requested_model, model, status, error_class)
             VALUES (?1,'text','gateway',?2,?3,?4,?5,?6)",
            rusqlite::params![ts, provider, model, model, status, class],
        )
        .unwrap();
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    #[test]
    fn a_drift_class_failure_with_elsewhere_success_opens_an_event_and_flags_repairing() {
        let (s, d) = temp_store("trigger");
        let now = now_ms();
        seed_provider(&s, "p1", "broken", "enabled");
        seed_provider(&s, "p2", "healthy", "enabled");
        ledger_row(&s, now - 1_000, Some("p1"), "shared-model", "error", Some("PARSE_ERROR"));
        ledger_row(&s, now - 2_000, Some("p2"), "shared-model", "ok", None);

        let triggers = evaluate(&s, now).unwrap();
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].provider_id, "p1");
        assert_eq!(triggers[0].elsewhere_provider_id, "p2");

        // The two writes the TS monitor's onTrigger made, verbatim.
        let conn = s.conn.lock().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM providers WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "repairing");
        let (n, blob): (i64, String) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(trigger_json), '') FROM drift_events WHERE provider_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        drop(conn);
        assert_eq!(n, 1);
        assert!(blob.contains("\"providerSlug\":\"broken\""), "the card's blob shape: {blob}");
        assert!(blob.contains("\"errors\":1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_open_event_is_not_duplicated_by_the_next_pass() {
        let (s, d) = temp_store("dedup");
        let now = now_ms();
        seed_provider(&s, "p1", "broken", "enabled");
        seed_provider(&s, "p2", "healthy", "enabled");
        ledger_row(&s, now - 1_000, Some("p1"), "shared-model", "error", Some("PARSE_ERROR"));
        ledger_row(&s, now - 2_000, Some("p2"), "shared-model", "ok", None);

        assert_eq!(evaluate(&s, now).unwrap().len(), 1);
        assert_eq!(evaluate(&s, now).unwrap().len(), 0, "one open event per provider");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_elsewhere_success_is_an_outage_not_drift() {
        let (s, d) = temp_store("outage");
        let now = now_ms();
        seed_provider(&s, "p1", "only", "enabled");
        ledger_row(&s, now - 1_000, Some("p1"), "lonely-model", "error", Some("AUTH_FAILED"));
        assert!(evaluate(&s, now).unwrap().is_empty());
        let conn = s.conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM drift_events", [], |r| r.get(0)).unwrap();
        drop(conn);
        assert_eq!(n, 0, "outages belong to the cooldowns and breakers");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_resolved_event_can_trigger_again_and_busy_errors_are_not_drift() {
        let (s, d) = temp_store("resolve");
        let now = now_ms();
        seed_provider(&s, "p1", "flaky", "enabled");
        seed_provider(&s, "p2", "healthy", "enabled");
        ledger_row(&s, now - 1_000, Some("p1"), "shared-model", "error", Some("PARSE_ERROR"));
        ledger_row(&s, now - 2_000, Some("p2"), "shared-model", "ok", None);
        // A resolved event does not stand in the way of re-detection.
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO drift_events (provider_id, detected_at, trigger_json, resolution, resolved_at)
                 VALUES ('p1', 1, '{}', 'fixed', 2)",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            evaluate(&s, now).unwrap().len(),
            1,
            "resolved events do not suppress re-detection"
        );

        // The schema's own drift-class rule: a 429-class failure (error_class RATE_LIMITED or
        // none at all) is the cooldowns' business, whatever the elsewhere-half says.
        let (s2, d2) = temp_store("busy");
        seed_provider(&s2, "p1", "busy", "enabled");
        seed_provider(&s2, "p2", "healthy", "enabled");
        ledger_row(&s2, now - 1_000, Some("p1"), "shared-model", "error", Some("RATE_LIMITED"));
        ledger_row(&s2, now - 2_000, Some("p2"), "shared-model", "ok", None);
        assert!(evaluate(&s2, now).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&d2);
    }
}
