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
use crate::core::activation;
use crate::core::store::Store;
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
pub fn merge(
    existing: Option<&str>,
    ours: &[Value],
    our_endpoint: &str,
) -> Result<(String, usize, usize), String> {
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
                return Err(
                    "neither a list nor {\"models\":[...]}; refusing to overwrite it".into()
                );
            }
        }
    };

    let kept: Vec<Value> =
        all.iter().filter(|e| !is_ours(e, &our_ids, our_endpoint)).cloned().collect();
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

/**
 * Whether a manifest forwards the caller's tool definitions upstream.
 *
 * Ground truth for "does this model support tools *through us*", and the only source that can
 * answer it: a provider's catalog rarely publishes the fact, and even when it does, what
 * decides the outcome is whether OUR adapter puts `tools` on the wire. A manifest whose
 * `requestTemplate` has no `tools` field drops every tool definition silently — the model then
 * imitates tool calls as raw text and, given a tool-shaped system prompt, can loop until the
 * user cancels. Claiming `supportsToolCall: true` on such a model is exactly what causes that.
 *
 * It takes a parsed manifest rather than a row's text because **the question is about the manifest
 * that serves the provider, and that is not always the row** — see [`tool_support`].
 */
fn manifest_forwards_tools(manifest: &Value) -> bool {
    manifest
        .get("endpoints")
        .and_then(|e| e.get("generateText"))
        .and_then(|g| g.get("requestTemplate"))
        .and_then(|t| t.get("tools"))
        .is_some()
}

/// Manifests are per-provider, not per-model, so a provider's text manifest says nothing about
/// its image models. Without the modality guard an image model inherits `supportsToolCall: true`
/// from a sibling text manifest and a client then offers it tools it cannot call.
/// True when the model's own id says it is not a text model, whatever the catalog claims.
fn id_marks_non_text(native_id: &str) -> bool {
    let lower = native_id.to_ascii_lowercase();
    ["-image", "/image", "-video", "/video"].iter().any(|m| lower.contains(m))
}

/**
 * Tool support for one model, read from the manifest that **serves** its provider.
 *
 * `None` means unknown, and the caller must treat unknown as false: a client acts on this flag,
 * and promising tool calls that will be dropped on the floor is far worse than not offering them.
 * (Same rule as `supportsReasoning`.)
 *
 * # The manifest is the serving one, not the stored row
 *
 * For most providers those are the same document. For a builtin slug they are not: activation
 * registers the *profile* and ignores the row (D41, facet 2), so a row without a `tools` field
 * would have this answer `false` about an adapter that in fact forwards tools. Both halves of the
 * question "which manifest serves this provider" therefore come from
 * `activation::serving_manifest` — the same function that decides what gets registered (**D49**).
 */
fn tool_support(store: &Store, native_id: &str) -> Option<bool> {
    // A provider's catalog is not always honest about modality: Agnes publishes its image and
    // video models as `text`, so the modality guard below cannot see them. The id can. Offering
    // tools to an image model is precisely what produces the runaway tool-call text this file
    // exists to prevent, so the id wins over the catalog when the two disagree.
    if id_marks_non_text(native_id) {
        return Some(false);
    }
    let conn = store.conn.lock().ok()?;
    // The manifest row is OUTER-joined rather than inner: a builtin provider may have no row at
    // all and still be served by its profile, and an inner join would answer "unknown" — which
    // the caller reads as false — for a provider that is serving and forwarding tools right now.
    let (slug, base_url, row) = conn
        .query_row(
            "SELECT p.slug, p.base_url, m.version, m.body_json
             FROM models_cache c
             JOIN providers p ON p.id = c.provider_id
             LEFT JOIN manifests m ON m.provider_id = c.provider_id AND m.is_active = 1
             WHERE c.native_id = ?1 AND c.modality = 'text'
             ORDER BY (c.context_window IS NULL), (c.capabilities_json IS NULL) LIMIT 1",
            rusqlite::params![native_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?.zip(r.get::<_, Option<String>>(3)?),
                ))
            },
        )
        .ok()?;
    let serving = activation::serving_manifest(
        &slug,
        &base_url,
        row.as_ref().map(|(version, body_json)| (body_json.as_str(), *version)),
    )
    .ok()??;
    Some(manifest_forwards_tools(&serving.body))
}

/**
 * The display name we publish for one model: provenance AND identity in a single string.
 *
 * Two requirements pull on this, and both are the operator's:
 *  - the `ai-provider router` marker has to survive, because it is how he tells at a glance
 *    which rows are served by this gateway rather than by one of his other providers;
 *  - the model id has to be in there too, because six rows all reading "ai-provider router"
 *    made the picker unusable — and that is how a model with no tool support got selected by
 *    accident, producing the runaway tool-call text this file's `supportsToolCall` fix answers.
 *
 * Because the id is de-duplicated before it reaches here, these names are unique by
 * construction — which is why `name` is generated rather than preserved. Preserving it would
 * only work if every preserved name happened to carry both facts, and his did not.
 */
pub fn display_name(id: &str) -> String {
    format!("ai-provider router · {id}")
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

/**
 * What the operator asked to publish, or `None` if they have never set it.
 *
 * `None` and `Some(vec![])` are deliberately different. An explicit empty list means "publish
 * nothing"; if that were re-seeded from the client file, unpublishing would silently undo
 * itself — the entry would come straight back on the next launch.
 */
fn configured_models(store: &Store) -> Option<Vec<String>> {
    let conn = store.conn.lock().ok()?;
    let raw: String = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key=?1",
            rusqlite::params![SETTINGS_KEY],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|m| m.as_str().map(str::to_string)).collect())
}

/// First run only: adopt entries that already point at us, so taking over a hand-written entry
/// needs no configuration at all.
fn seed_from(existing: Option<&str>, our_endpoint: &str) -> Vec<String> {
    existing
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|v| {
            let arr = v
                .as_array()
                .cloned()
                .or_else(|| v.get("models").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            arr.iter()
                .filter(|e| matches!(e.get("url").and_then(Value::as_str), Some(u) if u == our_endpoint))
                .filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `(models, needs_persisting)` — persisted only when we seeded, so an explicit choice is never
/// overwritten by a guess.
fn resolve_models(
    store: &Store,
    existing: Option<&str>,
    our_endpoint: &str,
) -> (Vec<String>, bool) {
    match configured_models(store) {
        Some(list) => (list, false),
        None => (seed_from(existing, our_endpoint), true),
    }
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

/// Returned when the master key cannot be read from the keychain yet.
///
/// Transient, not fatal, and worth naming: the caller retries on this and only this, so a shared
/// constant keeps the retry from silently decoupling if the wording ever changes.
pub const NO_KEY_YET: &str = "no gateway key yet";

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

    let (models, needs_persisting) = resolve_models(store, existing.as_deref(), &our_endpoint);

    // Empty is a real state, not a skip: publishing nothing must still remove the entries we
    // previously put there, or "unpublish" would leave a stale model in the client's picker.
    let key = if models.is_empty() {
        None
    } else {
        Some(
            crate::core::vault::get(crate::core::gateway::MASTER_ACCOUNT)
                .ok()
                .flatten()
                .ok_or_else(|| NO_KEY_YET.to_string())?,
        )
    };

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
        let Some(key) = key.as_deref() else { break };
        let (ctx, reasoning, modality) = catalog_facts(store, id);
        let old = prior.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str()));
        // `vendor` is still the operator's to choose; `name` is ours, because it has to carry
        // two facts at once (see `display_name`).
        let pick = |k: &str, fallback: &str| -> String {
            old.and_then(|e| e.get(k))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_string()
        };
        ours.push(json!({
            "id": id,
            "name": display_name(id),
            "vendor": pick("vendor", "AI-Provider Router"),
            "url": our_endpoint,
            "apiKey": key,
            "maxInputTokens": ctx.unwrap_or(FALLBACK_MAX_INPUT_TOKENS),
            "maxOutputTokens": DEFAULT_MAX_OUTPUT_TOKENS,
            // Unknown capability is reported as false only here, at the client boundary: a
            // client acts on this flag, and "cannot reason" is the safe claim to make.
            "supportsReasoning": reasoning.unwrap_or(false),
            // NOT hardcoded true. A model whose adapter drops `tools` cannot answer a tool
            // call, and saying otherwise makes the client send tools the model never sees —
            // it then role-plays them as inline text and can run away. Unknown is false.
            "supportsToolCall": tool_support(store, id).unwrap_or(false),
            "supportsImages": modality.as_deref() == Some("image"),
            "useCustomProtocol": false,
        }));
    }

    let (serialized, updated, removed) = merge(existing.as_deref(), &ours, &our_endpoint)?;
    write_atomic(&path, &serialized)?;

    // Remember what we published, but only when we seeded it — an explicit choice stands.
    if needs_persisting {
        let conn = store.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            rusqlite::params![SETTINGS_KEY, json!({ "models": models }).to_string()],
        )
        .map_err(|e| e.to_string())?;
    }

    let note = if models.is_empty() {
        Some("nothing published — our entries were removed from the client".into())
    } else {
        None
    };
    Ok(WorkbuddySyncResult {
        path: path.display().to_string(),
        endpoint: our_endpoint,
        models,
        updated,
        removed,
        note,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbuddyStatus {
    /// Models currently published into the client, in the order they were chosen.
    pub published: Vec<String>,
    pub path: String,
    pub endpoint: String,
    /// False when the client's config file is not there (yet) — not an error, just nothing to
    /// keep in sync yet.
    pub client_present: bool,
}

#[tauri::command]
pub fn workbuddy_status(store: tauri::State<'_, Arc<Store>>) -> Result<WorkbuddyStatus, String> {
    let path = models_path().ok_or_else(|| "cannot resolve $HOME".to_string())?;
    Ok(WorkbuddyStatus {
        published: configured_models(store.inner()).unwrap_or_default(),
        endpoint: endpoint(gateway_port(store.inner())),
        client_present: path.exists(),
        path: path.display().to_string(),
    })
}

/// Publish exactly this list, and rewrite the client's file now rather than waiting for the
/// next launch.
#[tauri::command]
pub fn workbuddy_set_models(
    store: tauri::State<'_, Arc<Store>>,
    models: Vec<String>,
) -> Result<WorkbuddySyncResult, String> {
    let store = store.inner();
    {
        // Keep the order the operator chose; drop empties and duplicates.
        let mut seen = std::collections::HashSet::new();
        let clean: Vec<String> = models
            .into_iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty() && seen.insert(m.clone()))
            .collect();
        let conn = store.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            rusqlite::params![SETTINGS_KEY, json!({ "models": clean }).to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    sync(store)
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
        vec![
            json!({"id": "openai/gpt-4o-mini", "url": "http://127.0.0.1:8787/v1/chat/completions"}),
        ]
    }

    #[test]
    fn adds_to_a_bare_list_and_leaves_others_alone() {
        let existing = r#"[{"id":"other","url":"https://api.b.ai/v1/chat/completions"}]"#;
        let (out, updated, removed) =
            merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
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
        let (out, _, _) =
            merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("models").is_some(), "must write back as {{\"models\":[...]}}");
        assert_eq!(v["models"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn replaces_our_previous_entry_instead_of_duplicating() {
        let existing = r#"[{"id":"openai/gpt-4o-mini","url":"http://127.0.0.1:8787/v1/chat/completions","maxInputTokens":1}]"#;
        let (out, updated, removed) =
            merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1);
        assert_eq!(updated, 1);
        assert_eq!(removed, 1);
    }

    #[test]
    fn drops_a_stale_entry_that_points_at_us_but_is_no_longer_published() {
        let existing = r#"[{"id":"old-model","url":"http://127.0.0.1:8787/v1/chat/completions"}]"#;
        let (out, _, removed) =
            merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap().as_array().unwrap().clone();
        assert_eq!(removed, 1);
        assert!(arr.iter().all(|e| e["id"] != "old-model"));
    }

    #[test]
    fn leaves_a_different_local_proxy_alone() {
        // Another gateway on another port is not ours to touch.
        let existing = r#"[{"id":"glm-5.3","url":"http://127.0.0.1:8899/v1/chat/completions"}]"#;
        let (out, _, removed) =
            merge(Some(existing), &ours(), "http://127.0.0.1:8787/v1/chat/completions").unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap().as_array().unwrap().clone();
        assert_eq!(removed, 0);
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn refuses_to_overwrite_a_file_it_cannot_parse() {
        assert!(merge(
            Some("not json at all"),
            &ours(),
            "http://127.0.0.1:8787/v1/chat/completions"
        )
        .is_err());
        assert!(merge(
            Some(r#"{"something":"else"}"#),
            &ours(),
            "http://127.0.0.1:8787/v1/chat/completions"
        )
        .is_err());
    }

    fn tmp_store(tag: &str) -> (crate::core::store::Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wb-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        (crate::core::store::Store::open(&dir).unwrap(), dir)
    }

    /// One provider with one cached text model, and an active manifest row only if `body_json`
    /// is `Some`.
    ///
    /// `None` is not a degenerate fixture: `addProvider` writes the provider row before the
    /// manifest row (`store.ts:495-502`) and its `catch` rolls back in-memory state only, so a
    /// builtin provider can be served by its profile with no row in the table at all.
    fn store_with(
        tag: &str,
        slug: &str,
        base_url: &str,
        body_json: Option<&str>,
    ) -> (crate::core::store::Store, std::path::PathBuf) {
        let (store, dir) = tmp_store(tag);
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO providers (id, slug, name, base_url, status, rotation_strategy,
                                        created_at, updated_at)
                 VALUES ('p1', ?1, 'P', ?2, 'enabled', 'round_robin', 0, 0)",
                rusqlite::params![slug, base_url],
            )
            .unwrap();
            if let Some(body) = body_json {
                conn.execute(
                    "INSERT INTO manifests (id, provider_id, version, origin, body_json,
                                            created_at, is_active)
                     VALUES ('m1', 'p1', 1, 'builtin-template', ?1, 0, 1)",
                    rusqlite::params![body],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO models_cache (id, provider_id, native_id, modality, fetched_at, raw_json)
                 VALUES ('c1', 'p1', 'openai/gpt-4o-mini', 'text', 0, '{}')",
                [],
            )
            .unwrap();
        }
        (store, dir)
    }

    const EP: &str = "http://127.0.0.1:8787/v1/chat/completions";

    #[test]
    fn seeds_from_an_entry_already_pointing_at_us() {
        let (store, dir) = tmp_store("seed");
        assert_eq!(configured_models(&store), None, "nothing configured yet");
        let existing =
            r#"[{"id":"openai/gpt-4o-mini","url":"http://127.0.0.1:8787/v1/chat/completions"}]"#;
        let (got, persist) = resolve_models(&store, Some(existing), EP);
        assert_eq!(got, vec!["openai/gpt-4o-mini".to_string()]);
        assert!(persist, "a seeded list must be remembered");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_explicit_empty_list_is_not_re_seeded() {
        // The whole point: unpublishing everything must stick. Re-seeding from the client file
        // would resurrect the entry on the next launch.
        let (store, dir) = tmp_store("empty");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value_json) VALUES ('workbuddy', ?1)",
                rusqlite::params![r#"{"models":[]}"#],
            )
            .unwrap();
        }
        let existing =
            r#"[{"id":"openai/gpt-4o-mini","url":"http://127.0.0.1:8787/v1/chat/completions"}]"#;
        let (got, persist) = resolve_models(&store, Some(existing), EP);
        assert!(got.is_empty());
        assert!(!persist, "an explicit choice must not be overwritten by a guess");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remembers_the_published_list_so_a_later_run_needs_no_seed() {
        let (store, dir) = tmp_store("mem");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value_json) VALUES ('workbuddy', ?1)",
                rusqlite::params![r#"{"models":["openai/gpt-4o-mini"]}"#],
            )
            .unwrap();
        }
        // No existing client file at all — the persisted list is what makes this work.
        let (got, persist) = resolve_models(&store, None, EP);
        assert_eq!(got, vec!["openai/gpt-4o-mini".to_string()]);
        assert!(!persist, "already persisted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn manifest_with_template(tpl: &str) -> Value {
        let template: Value = serde_json::from_str(tpl).unwrap();
        json!({ "manifestVersion": 1, "endpoints": { "generateText": { "requestTemplate": template } } })
    }

    #[test]
    fn tool_support_comes_from_the_manifest_not_a_guess() {
        // The bug this closes: a manifest with no `tools` field drops the caller's tool
        // definitions, yet the client was told `supportsToolCall: true` regardless.
        assert!(manifest_forwards_tools(&manifest_with_template(
            r#"{"model":"{{model}}","tools":"{{tools?}}"}"#
        )));
        assert!(!manifest_forwards_tools(&manifest_with_template(
            r#"{"model":"{{model}}","messages":"{{messages}}"}"#
        )));
        // A manifest that declares no endpoints at all says nothing either way — never true.
        assert!(!manifest_forwards_tools(&json!({})));
    }

    #[test]
    fn a_builtin_provider_reports_tool_support_from_its_profile_not_its_row() {
        // D49. Activation registers the profile and ignores the row for a builtin slug, so a row
        // that drops `tools` used to make this answer `false` about an adapter that forwards them.
        // The row here is the discriminating fixture: it is a perfectly valid manifest that simply
        // does not forward tools, so `true` can only have come from the profile.
        let (store, dir) = store_with(
            "profile-wins",
            "openrouter",
            "https://openrouter.ai/api/v1",
            Some(&manifest_with_template(r#"{"model":"{{model}}"}"#).to_string()),
        );
        assert_eq!(
            tool_support(&store, "openai/gpt-4o-mini"),
            Some(true),
            "the profile is what is registered, so it is what must be reported"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_builtin_provider_with_no_manifest_row_still_reports_tool_support() {
        // Same question, reachable without any failure: `addProvider` writes the provider row
        // first. An inner join to `manifests` answers "unknown" here, which the caller reads as
        // false — the outer join is load-bearing, not cosmetic.
        let (store, dir) = store_with("no-row", "b.ai", "https://api.b.ai", None);
        assert_eq!(tool_support(&store, "openai/gpt-4o-mini"), Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_provider_without_a_profile_still_answers_from_its_row_in_both_directions() {
        // The guard against the fix being "a builtin is always true": everyone else is still
        // decided by their stored manifest, and it can say no.
        let (store, dir) = store_with(
            "row-only-yes",
            "agnes",
            "https://api.agnes.test",
            Some(
                &manifest_with_template(r#"{"model":"{{model}}","tools":"{{tools?}}"}"#)
                    .to_string(),
            ),
        );
        assert_eq!(tool_support(&store, "openai/gpt-4o-mini"), Some(true));
        let _ = std::fs::remove_dir_all(&dir);

        let (store, dir) = store_with(
            "row-only-no",
            "agnes",
            "https://api.agnes.test",
            Some(&manifest_with_template(r#"{"model":"{{model}}"}"#).to_string()),
        );
        assert_eq!(tool_support(&store, "openai/gpt-4o-mini"), Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_row_that_is_not_json_is_unknown_rather_than_either_answer() {
        // Unknown is what the caller turns into `false`; a panic or a `true` here would both be
        // claims this gateway has not earned.
        let (store, dir) =
            store_with("corrupt", "agnes", "https://api.agnes.test", Some("not json"));
        assert_eq!(tool_support(&store, "openai/gpt-4o-mini"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_image_model_never_advertises_tool_support_even_if_the_catalog_says_text() {
        // Agnes publishes its image and video models as modality 'text', so the SQL guard alone
        // would let them inherit supportsToolCall from the provider's text manifest. The id is
        // the honest signal here.
        assert!(id_marks_non_text("agnes-image-2.0-flash"));
        assert!(id_marks_non_text("agnes-video-2.5"));
        assert!(id_marks_non_text("google/gemini-2.5-flash-image"));
        assert!(!id_marks_non_text("agnes-2.5-flash"));
        assert!(!id_marks_non_text("openai/gpt-4o-mini"));
    }

    #[test]
    fn a_display_name_carries_provenance_and_identity() {
        // Both halves are load-bearing: the marker says "served by this gateway", the id says
        // which model. Six rows sharing only the marker were indistinguishable in the picker.
        let name = display_name("agnes-2.5-flash");
        assert!(name.starts_with("ai-provider router"), "provenance marker: {name}");
        assert!(name.ends_with("agnes-2.5-flash"), "model identity: {name}");
    }

    #[test]
    fn published_names_are_unique_by_construction() {
        // Ids are de-duplicated before they reach the sync, and each name embeds its id.
        let ids = [
            "openai/gpt-4o-mini",
            "agnes-2.5-flash",
            "agnes-3.0-flash",
            "agnes-2.5-pro-beta",
            "agnes-2.5-pro-alpha",
            "agnes-image-2.0-flash",
        ];
        let names: Vec<String> = ids.iter().map(|i| display_name(i)).collect();
        assert_eq!(names.iter().collect::<std::collections::HashSet<_>>().len(), ids.len());
    }

    #[test]
    fn publishing_nothing_removes_our_entry() {
        let existing = r#"[{"id":"openai/gpt-4o-mini","url":"http://127.0.0.1:8787/v1/chat/completions"},
                           {"id":"other","url":"https://api.b.ai/v1/chat/completions"}]"#;
        let (out, updated, removed) = merge(Some(existing), &[], EP).unwrap();
        let arr = serde_json::from_str::<Value>(&out).unwrap().as_array().unwrap().clone();
        assert_eq!(updated, 0);
        assert_eq!(removed, 1);
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], "other", "only our entry goes");
    }
}
