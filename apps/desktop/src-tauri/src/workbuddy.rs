/**
 * workbuddy.rs — keep this gateway's entry in a third-party client's custom-model list correct
 * without anyone hand-editing JSON.
 *
 * Why this exists: pointing WorkBuddy at the gateway means writing an entry into its model
 * list by hand, and getting `supportsReasoning` / `maxInputTokens` / `maxOutputTokens` right by
 * hand. Get them wrong and the failure is silent — WorkBuddy asks gpt-4o-mini for reasoning it
 * cannot produce, or truncates a long prompt against a default cap. Worse, the url and apiKey
 * go stale the moment the gateway moves port or the key is rotated.
 *
 * So the gateway maintains its own entry: every launch (the gateway auto-restores, so this runs
 * on startup) rewrites it from the catalog and the keychain. Facts come from `models_cache`, so
 * they are the provider's, not our guesses.
 *
 * Scope discipline: we only ever touch entries that are ours. Anything else in the file — the
 * user's other providers — is left byte-for-byte alone, and a file we cannot parse is an error,
 * never something to overwrite.
 */
use crate::store::Store;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Where WorkBuddy AI keeps custom models. Confirmed empirically: an entry added through its
/// own UI lands here and appears in the picker. `~/.codebuddy/models.json` is referenced in the
/// bundle but was NOT the file being read.
const MODELS_REL: &str = ".workbuddy-ai/models.json";

/// Settings key: which models to publish. Held here rather than inferred so the choice survives
/// a port change and does not depend on the client file still being readable.
const SETTINGS_KEY: &str = "workbuddy";

/// Used only when the catalog says nothing about the prompt budget.
pub const FALLBACK_MAX_INPUT_TOKENS: i64 = 128_000;
/// Not published by any catalog we read; a conservative ceiling that avoids truncation.
pub const DEFAULT_MAX_OUTPUT_TOKENS: i64 = 16_384;

fn models_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(MODELS_REL))
}

pub fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1/chat/completions")
}

fn is_ours(entry: &Value, our_ids: &[String], our_endpoint: &str) -> bool {
    let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
    if our_ids.iter().any(|m| m == id) {
        return true;
    }
    // Left over from an earlier sync: same endpoint, no longer published. A renamed model or a
    // moved port would otherwise leave a dead entry in the picker forever.
    matches!(entry.get("url").and_then(Value::as_str), Some(u) if u == our_endpoint)
}

/**
 * Merge our entries into the client's config, preserving everything else.
 *
 * Returns `(serialized, updated, removed)`.
 *
 * The file is accepted as either a bare list or `{"models":[...]}` and is written back in
 * whichever shape it arrived in — we are a guest in someone else's config file.
 */
pub fn merge(existing: Option<&str>, ours: &[Value], our_endpoint: &str) -> Result<(String, usize, usize), String> {
    let our_ids: Vec<String> = ours
        .iter()
        .filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    let (all, wrapped): (Vec<Value>, bool) = match existing {
        None | Some("") => (Vec::new(), false),
        Some(raw) => {
            let parsed: Value = serde_json::from_str(raw)
                .map_err(|e| format!("not valid JSON ({e}); refusing to overwrite it"))?;
            if let Some(arr) = parsed.as_array() {
                (arr.clone(), false)
            } else if let Some(arr) = parsed.get("models").and_then(Value::as_array) {
                (arr.clone(), true)
            } else {
                return Err("neither a list nor {\"models\":[...]}; refusing to overwrite it".into());
            }
        }
    };

    let kept: Vec<Value> = all
        .iter()
        .filter(|e| !is_ours(e, &our_ids, our_endpoint))
        .cloned()
        .collect();
    let removed = all.len() - kept.len();

    let mut out = kept;
    out.extend(ours.iter().cloned());
    let body = if wrapped { json!({ "models": out }) } else { Value::Array(out) };
    let serialized = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    Ok((serialized, ours.len(), removed))
}

/// Catalog facts for one model: prompt budget, reasoning support, modality.
fn catalog_facts(store: &Store, native_id: &str) -> (Option<i64>, Option<bool>, Option<String>) {
    let conn = match store.conn.lock() {
        Ok(c) => c,
        Err(_) => return (None, None, None),
    };
    let row = conn.query_row(
        "SELECT context_window, capabilities_json, modality FROM models_cache
         WHERE native_id = ?1
         ORDER BY (context_window IS NULL), (capabilities_json IS NULL) LIMIT 1",
        rusqlite::params![native_id],
        |r| {
            Ok((
                r.get::<_, Option<i64>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    );
    let (ctx, caps, modality) = match row {
        Ok(v) => v,
        Err(_) => return (None, None, None),
    };
    let reasoning = caps
        .as_deref()
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .and_then(|v| v.get("reasoning").and_then(Value::as_bool));
    (ctx, reasoning, Some(modality))
}

fn gateway_port(store: &Store) -> u16 {
    let conn = match store.conn.lock() {
        Ok(c) => c,
        Err(_) => return 8787,
    };
    conn.query_row("SELECT value_json FROM settings WHERE key='gateway'", [], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|v| serde_json::from_str::<Value>(&v).ok())
    .and_then(|v| v.get("port").and_then(Value::as_u64))
    .map(|p| p as u16)
    .unwrap_or(8787)
}

/// The models to publish. Persisted, and seeded on first run from whatever already points at
/// our endpoint — so adopting an existing hand-written entry needs no configuration at all.
fn published_models(store: &Store, existing: Option<&str>, our_endpoint: &str) -> Vec<String> {
    let conn = store.conn.lock().ok();
    let stored: Vec<String> = conn
        .as_ref()
        .and_then(|c| {
            c.query_row("SELECT value_json FROM settings WHERE key=?1", rusqlite::params![SETTINGS_KEY], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        })
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| v.get("models").and_then(Value::as_array).cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    drop(conn);
    if !stored.is_empty() {
        return stored;
    }

    // First run: adopt entries that already point at us, rather than publishing nothing.
    existing
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|v| {
            let arr = v.as_array().cloned().or_else(|| v.get("models").and_then(Value::as_array).cloned());
            arr.unwrap_or_default()
                .iter()
                .filter(|e| matches!(e.get("url").and_then(Value::as_str), Some(u) if u == our_endpoint))
                .filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    // Same directory, so rename is atomic on the same filesystem: a crash mid-write cannot
    // leave the client with a half-written model list.
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbuddySyncResult {
    pub path: String,
    pub endpoint: String,
    pub models: Vec<String>,
    pub updated: usize,
    pub removed: usize,
    /// Set when we deliberately wrote nothing (no models to publish, no key yet).
    pub note: Option<String>,
}

/// Rewrite our entries. Safe to call repeatedly; failures are returned, never swallowed here.
pub fn sync(store: &Arc<Store>) -> Result<WorkbuddySyncResult, String> {
    let path = models_path().ok_or_else(|| "cannot resolve $HOME".to_string())?;
    let port = gateway_port(store);
    let our_endpoint = endpoint(port);

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };

    let models = published_models(store, existing.as_deref(), &our_endpoint);
    if models.is_empty() {
        return Ok(WorkbuddySyncResult {
            path: path.display().to_string(),
            endpoint: our_endpoint,
            models,
            updated: 0,
            removed: 0,
            note: Some("no models published yet — add one through the app first".into()),
        });
    }

    let key = crate::vault::get(crate::gateway::MASTER_ACCOUNT)
        .ok()
        .flatten()
        .ok_or_else(|| "no gateway key yet".to_string())?;

    // Existing entries, so a name or vendor the user chose is kept rather than overwritten.
    let prior: Vec<Value> = existing
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|v| {
            v.as_array()
                .cloned()
                .or_else(|| v.get("models").and_then(Value::as_array).cloned())
                .unwrap_or_default()
        })
        .unwrap_or_default();

    let mut ours = Vec::new();
    for id in &models {
        let (ctx, reasoning, modality) = catalog_facts(store, id);
        let old = prior.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str()));
        let pick = |k: &str, fallback: &str| -> String {
            old.and_then(|e| e.get(k))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_string()
        };
        ours.push(json!({
            "id": id,
            "name": pick("name", "ai-provider router"),
            "vendor": pick("vendor", "AI-Provider Router"),
            "url": our_endpoint,
            "apiKey": key,
            "maxInputTokens": ctx.unwrap_or(FALLBACK_MAX_INPUT_TOKENS),
            "maxOutputTokens": DEFAULT_MAX_OUTPUT_TOKENS,
            // Unknown capability is reported as false only here, at the client boundary: a
            // client acts on this flag, and "cannot reason" is the safe claim to make.
            "supportsReasoning": reasoning.unwrap_or(false),
            "supportsToolCall": true,
            "supportsImages": modality.as_deref() == Some("image"),
            "useCustomProtocol": false,
        }));
    }

    let (serialized, updated, removed) = merge(existing.as_deref(), &ours, &our_endpoint)?;
    write_atomic(&path, &serialized)?;

    // Remember what we published so a later run does not depend on the client file.
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![SETTINGS_KEY, json!({ "models": models }).to_string()],
    )
    .map_err(|e| e.to_string())?;

    Ok(WorkbuddySyncResult {
        path: path.display().to_string(),
        endpoint: our_endpoint,
        models,
        updated,
        removed,
        note: None,
    })
}

#[tauri::command]
pub fn workbuddy_sync(store: tauri::State<'_, Arc<Store>>) -> Result<WorkbuddySyncResult, String> {
    sync(store.inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ours() -> Vec<Value> {
        vec![json!({"id": "openai/gpt-4o-mini", "url": "http://127.0.0.1:8787/v1/chat/completions"})]
    }

    #[test]
    fn adds_to_a_bare_list_and_leaves_others_alone() {
        let existing = r#"[{"id":"other","url":"https://api.b.ai/v1/chat/completions"}]"#;
        let (out, updated, removed) = merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(updated, 1);
        assert_eq!(removed, 0);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], "other");
        assert_eq!(arr[1]["id"], "openai/gpt-4o-mini");
    }

    #[test]
    fn preserves_the_wrapped_shape() {
        let existing = r#"{"models":[{"id":"other","url":"https://x/v1/chat/completions"}]}"#;
        let (out, _, _) = merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("models").is_some(), "must write back as {{\"models\":[...]}}");
        assert_eq!(v["models"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn replaces_our_previous_entry_instead_of_duplicating() {
        let existing = r#"[{"id":"openai/gpt-4o-mini","url":"http://127.0.0.1:8787/v1/chat/completions","maxInputTokens":1}]"#;
        let (out, updated, removed) = merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1);
        assert_eq!(updated, 1);
        assert_eq!(removed, 1);
    }

    #[test]
    fn drops_a_stale_entry_that_points_at_us_but_is_no_longer_published() {
        let existing = r#"[{"id":"old-model","url":"http://127.0.0.1:8787/v1/chat/completions"}]"#;
        let (out, _, removed) = merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap().as_array().unwrap().clone();
        assert_eq!(removed, 1);
        assert!(arr.iter().all(|e| e["id"] != "old-model"));
    }

    #[test]
    fn leaves_a_different_local_proxy_alone() {
        // Another gateway on another port is not ours to touch.
        let existing = r#"[{"id":"glm-5.3","url":"http://127.0.0.1:8899/v1/chat/completions"}]"#;
        let (out, _, removed) = merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap().as_array().unwrap().clone();
        assert_eq!(removed, 0);
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn refuses_to_overwrite_a_file_it_cannot_parse() {
        assert!(merge(Some("not json at all"), &ours(), "http://127.0.0.1:8787/v1/chat/completions").is_err());
        assert!(merge(Some(r#"{"something":"else"}"#), &ours(), "http://127.0.0.1:8787/v1/chat/completions").is_err());
    }

    #[test]
    fn seeds_from_an_entry_already_pointing_at_us() {
        let dir = std::env::temp_dir().join(format!("wb-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = crate::store::Store::open(&dir).unwrap();
        let existing = r#"[{"id":"openai/gpt-4o-mini","url":"http://127.0.0.1:8787/v1/chat/completions"}]"#;
        let got = published_models(&store, Some(existing), "http://127.0.0.1:8787/v1/chat/completions");
        assert_eq!(got, vec!["openai/gpt-4o-mini".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remembers_the_published_list_so_a_later_run_needs_no_seed() {
        let dir = std::env::temp_dir().join(format!("wb-mem-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = crate::store::Store::open(&dir).unwrap();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value_json) VALUES ('workbuddy', ?1)",
                rusqlite::params![r#"{"models":["openai/gpt-4o-mini"]}"#],
            )
            .unwrap();
        }
        // No existing client file at all — the persisted list is what makes this work.
        let got = published_models(&store, None, "http://127.0.0.1:8787/v1/chat/completions");
        assert_eq!(got, vec!["openai/gpt-4o-mini".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
