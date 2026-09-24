//! The activation path: read the store's active manifests and put them into an `AdapterRuntime`.
//!
//! This is the port of `store.ts:367-381` — the loop inside `bootstrap()` that turns persisted rows
//! into live adapters. [`crate::core::adapter_runtime`] deliberately does not read the store; its
//! module note names this module as the business it leaves alone. So this is the other half, and it
//! is the only place in the crate that reads `manifests.body_json` in order to register an adapter.
//!
//! # A manifest that cannot become an adapter is skipped, not fatal
//!
//! The reference wraps the register in a `try`/`catch` whose body is a comment — *"corrupt
//! manifest: leave unregistered; Phase 5 drift/repair surfaces it"* (`store.ts:377-379`). Activation
//! is a **launch**, and a launch that refused to start because one provider of three had a bad
//! manifest would trade a degraded service for no service. So [`activate`] returns both what it
//! registered and what it skipped, with the reason for each skip, and the caller decides.
//!
//! **The boundary it relies on is `register`'s, not this module's.** `AdapterRuntime::register`
//! builds before it swaps, so a manifest that fails to build leaves the previous adapter serving and
//! returns `Err` (D32). Activation's contribution is only the decision to keep going — which is why
//! a re-activation of a healthy runtime cannot take a provider down.
//!
//! # A destination the egress will refuse is the third reason to skip
//!
//! Added 2026-09-24, and it closes **D46**. Activation now takes the egress allowlist and refuses a
//! manifest whose host the request path would refuse anyway — see [`check_destination`] for why the
//! two authorities diverge and why the host check is sufficient rather than a sample. The reason it
//! belongs *here* rather than in the egress is the same reason the corrupt-manifest case does: a
//! launch is the last moment at which the problem can be reported once, with a name, instead of once
//! per request with the wrong one.
//!
//! # What activation is not: the builtin profiles
//!
//! The reference's loop runs **over providers**, and for each one it first tries
//! `PROVIDER_PROFILES[slug]` — three builtin manifests (`openrouter`, `opencode`, `b.ai`) built from
//! the two ported templates — falling back to that provider's active manifest row. **There is no
//! Rust `PROVIDER_PROFILES`**: the `openai_compat` / `anthropic_compat` values in
//! `core::manifest_view` are test fixtures, and no production type holds the three profiles.
//!
//! This module therefore iterates **manifest rows** rather than providers. That is the honest
//! subset, and it is not a guess — measured against the installed database on 2026-09-24, there are
//! **two** providers, both `type='manifest'`, both carrying an active row, and **no builtin provider
//! is installed**, so the two agree on this machine. They would not agree on one that had an
//! OpenRouter provider whose slug has no manifest row: that provider is served by its profile in
//! the reference and would go unregistered here. Recorded in the drift register rather than left for
//! increment 25e to discover.

use serde_json::Value;

use crate::core::adapter_runtime::AdapterRuntime;
use crate::core::egress::{host_is_permitted, AllowList};
use crate::core::error::CommandError;
use crate::core::persist::{manifests_active_rows, ManifestRow};
use crate::core::store::Store;

/// One manifest that was read and could not become an adapter.
///
/// `version` is carried because the table holds every version and an operator reading a skip needs
/// to know *which* row failed — "provider X" alone names three candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub provider_id: String,
    pub version: i64,
    pub reason: String,
}

/// What one activation did.
///
/// **Both halves are returned because both are decisions the caller has to make.** `skipped` is not
/// a log line: a launch has to decide whether to start degraded, and the operator has to be able to
/// see which provider is missing and why.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Activation {
    /// The provider ids now registered in the runtime, sorted.
    pub registered: Vec<String>,
    pub skipped: Vec<Skipped>,
}

impl Activation {
    /// Whether nothing was skipped. A launch treats a partial activation as a warning rather than a
    /// failure, and this is the whole of that decision.
    pub fn is_complete(&self) -> bool {
        self.skipped.is_empty()
    }
}

/// Register every active manifest into the runtime, skipping the ones that cannot be built or
/// cannot be reached.
///
/// **The store read is the only failure that propagates**, and that is the one asymmetry worth
/// naming: a database this process cannot read is not a degraded launch, it is no launch, so it is
/// an `Err`. A manifest that cannot be *parsed*, *built*, or *dialled* is a fact about one provider,
/// and it is recorded in [`Activation::skipped`] instead — the reference's `catch`.
///
/// `allow` is the egress allowlist, and taking it here is what closes **D46** — see
/// [`check_destination`].
pub fn activate(
    runtime: &AdapterRuntime,
    store: &Store,
    allow: &AllowList,
) -> Result<Activation, CommandError> {
    let rows = manifests_active_rows(store)?;
    let mut out = Activation::default();
    for row in rows {
        match register_row(runtime, allow, &row) {
            Ok(()) => out.registered.push(row.provider_id),
            Err(reason) => out.skipped.push(Skipped {
                provider_id: row.provider_id,
                version: row.version,
                reason,
            }),
        }
    }
    out.registered.sort();
    Ok(out)
}

/// One row: parse, check the destination, then register.
///
/// The three failures collapse into one `Err` because the caller treats them identically, but the
/// reason says which it was — "is not JSON" names a corrupt row, the allowlist message names a
/// destination the egress will refuse, and anything else names a manifest that parsed and could not
/// be built.
fn register_row(
    runtime: &AdapterRuntime,
    allow: &AllowList,
    row: &ManifestRow,
) -> Result<(), String> {
    let body: Value =
        serde_json::from_str(&row.body_json).map_err(|e| format!("body_json is not JSON: {e}"))?;
    check_destination(allow, &body)?;
    runtime.register(&row.provider_id, &body)
}

/// Refuse a manifest whose destination the egress will not dial — **D46, closed at the boot path**.
///
/// # Why this is here as well as in `check_url`
///
/// The allowlist is derived from `providers.base_url` (`persist::recompute_allow`) while the adapter
/// dials `manifest.provider.baseUrl` (`manifest::join_url`). The two are written together by the
/// generator, so they agree on any install nobody has edited — and they can be made to disagree by
/// editing one and not the other, which is what a custom-base-URL or proxy feature would do.
///
/// When they disagree the request is refused by `check_url` **per attempt**, and the attempt layer
/// reports that as `NETWORK` — a `502` whose message blames the provider for a local policy refusal.
/// Measured 2026-09-24: 56 of 56 requests answered `502 … [agnes/key-01:NETWORK -> agnes/Key-02:NETWORK]`
/// while the stub's own counter did not move once. **The reachability does not change here** — a
/// provider that cannot be dialled could not be dialled before either. What changes is that it is
/// said **once, at boot, with a name**, instead of once per request with the wrong one.
///
/// # Why the host is `provider.baseUrl`'s and nothing else
///
/// Because `join_url` **unconditionally prefixes** the base: `join_url(base, path)` is `base + path`
/// for every path, including one that looks absolute. So the host of every URL this manifest can
/// dial is the host of `provider.baseUrl`, and checking that one host is sufficient rather than a
/// sample. (An image URL *returned by* a provider is a different destination and is still checked by
/// `check_url` at fetch time; this function does not claim to cover it.)
///
/// # Why a missing or unparseable base is `Ok`
///
/// So this check cannot mask a different error with a misleading reason. A manifest with no
/// `provider.baseUrl` fails `ManifestInterpreter::new` a moment later, and that message is the one
/// worth reading; returning `Ok` here hands the row to `register`, which names the real problem.
fn check_destination(allow: &AllowList, body: &Value) -> Result<(), String> {
    let Some(host) = body
        .get("provider")
        .and_then(|p| p.get("baseUrl"))
        .and_then(Value::as_str)
        .and_then(|base| reqwest::Url::parse(base).ok())
        .and_then(|url| url.host_str().map(str::to_lowercase))
    else {
        return Ok(());
    };
    if host_is_permitted(allow, &host) {
        return Ok(());
    }
    Err(format!(
        "the manifest dials host `{host}`, which the egress allowlist does not permit — every \
         request would be refused locally and reported as a network failure. The allowlist is \
         populated from `providers.base_url`, so the provider row and this manifest disagree. \
         Re-point one of them at the other's host (or delete and re-create the provider, which \
         writes both)"
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures_util::future::BoxFuture;
    use rusqlite::params;
    use serde_json::json;

    use crate::core::adapter::Cancel;
    use crate::core::http_port::{HttpError, HttpPort, HttpRequest, HttpResponse};

    use super::*;

    /// A port that is never used.
    ///
    /// Activation only *builds* adapters; it serves no request. A port that panicked on use would be
    /// the stronger fixture, but a panic on a task would surface as a confusing failure, so this one
    /// answers an empty 200 — and because nothing is asserted on what was sent, a test that did
    /// start making requests would fail on its own claims rather than here.
    struct NoPort;

    impl HttpPort for NoPort {
        fn request<'a>(
            &'a self,
            _req: HttpRequest,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
            Box::pin(async move {
                Ok(HttpResponse {
                    status: 200,
                    headers: BTreeMap::new(),
                    body: String::new(),
                    lines: None,
                })
            })
        }
    }

    fn runtime() -> AdapterRuntime {
        AdapterRuntime::new(std::sync::Arc::new(NoPort))
    }

    /// An allowlist permitting the hosts these fixtures dial.
    ///
    /// The tempting shortcut — pointing every fixture at `127.0.0.1` so `is_local` permits it — is
    /// the one to avoid: it would make all of these tests pass through the local branch and stop
    /// exercising the allowlist at all, and the one test that *is* about the allowlist needs a
    /// remote host to mean anything.
    fn allow() -> AllowList {
        let a = AllowList::default();
        for h in ["one.test", "two.test", "good.test", "api.example.com"] {
            a.allow(h);
        }
        a
    }

    /// A store on disk. The directory is `AtomicUsize`-suffixed rather than `pid + tag`: two tests
    /// that picked the same tag would open the same file, and one would fail with `DatabaseBusy` for
    /// a reason that has nothing to do with what it is testing.
    fn tmp_store() -> (Store, std::path::PathBuf) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aip-activation-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    /// A declarative manifest that `ManifestInterpreter::new` accepts — the OpenRouter template's
    /// shape, and the same fixture `core::adapter_runtime`'s tests use.
    fn declarative(base_url: &str) -> String {
        json!({
            "manifestVersion": 1,
            "kind": "declarative",
            "dialect": "openai-chat-v1",
            "provider": {
                "baseUrl": base_url,
                "auth": { "headers": [{ "name": "Authorization", "prefix": "Bearer" }] }
            },
            "endpoints": {
                "listModels": {
                    "method": "GET",
                    "path": "/models",
                    "map": { "models": "$.data[*].id", "raw": "$.data[*]" }
                },
                "generateText": {
                    "method": "POST",
                    "path": "/chat/completions",
                    "requestTemplate": {
                        "model": "{{model}}",
                        "messages": "{{messages}}",
                        "stream": "{{stream}}"
                    },
                    "responseMap": { "text": "$.choices[0].message.content" }
                }
            },
            "capabilities": { "text": true, "image": false }
        })
        .to_string()
    }

    /// A `kind: "code"` manifest with no `code.source` — it parses, and `build` refuses it.
    fn code_without_source() -> String {
        json!({
            "manifestVersion": 1,
            "kind": "code",
            "dialect": "custom-code-v1",
            "provider": { "baseUrl": "https://api.example.com/v1/" },
            "endpoints": {},
            "capabilities": { "text": true, "image": true }
        })
        .to_string()
    }

    /// Insert one provider and one manifest row. The provider is inserted because the column is a
    /// foreign key — a fixture of manifests with no providers could not exist in production.
    fn insert(
        conn: &rusqlite::Connection,
        provider_id: &str,
        version: i64,
        body: &str,
        active: bool,
    ) {
        conn.execute(
            "INSERT OR IGNORE INTO providers (id, slug, name, base_url, status, rotation_strategy, created_at, updated_at)
             VALUES (?1, ?1, ?1, 'https://example.invalid/v1', 'enabled', 'round_robin', 1, 1)",
            params![provider_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO manifests (id, provider_id, version, origin, body_json, created_at, is_active)
             VALUES (?1, ?2, ?3, 'ai-generated', ?4, 1, ?5)",
            params![
                format!("{provider_id}-v{version}"),
                provider_id,
                version,
                body,
                if active { 1 } else { 0 }
            ],
        )
        .unwrap();
    }

    /// Every active row becomes an adapter, and the report names them sorted.
    #[test]
    fn activation_registers_every_active_manifest() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "p1", 1, &declarative("https://one.test/v1"), true);
            insert(&conn, "p2", 1, &declarative("https://two.test/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable database activates");
        assert_eq!(act.registered, vec!["p1".to_string(), "p2".to_string()]);
        assert!(act.skipped.is_empty(), "nothing was skipped");
        assert!(act.is_complete());
        assert_eq!(rt.registered(), vec!["p1".to_string(), "p2".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The `is_active = 1` filter is the reader's whole job, and this is the test that can see it.
    ///
    /// The inactive row is **malformed JSON on purpose**, so "was the row read?" has an observable
    /// answer: a read row that cannot be parsed lands in `skipped`. If the filter were dropped, v1
    /// would be read and `skipped` would not be empty — and if v1 were well-formed instead, dropping
    /// the filter would be invisible, because the last write would win by iteration order and the
    /// test would pass for the wrong reason.
    #[test]
    fn activation_reads_only_the_active_version() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "p1", 1, "{not json", false);
            insert(&conn, "p1", 2, &declarative("https://two.test/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable database activates");
        assert_eq!(act.registered, vec!["p1".to_string()], "the active version registered");
        assert!(
            act.skipped.is_empty(),
            "the inactive row was never read — a superseded version must not be activated"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A corrupt row is skipped and the loop continues — the reference's `catch`, and the reason a
    /// launch is degraded rather than dead.
    #[test]
    fn activation_skips_a_corrupt_manifest_and_keeps_going() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "bad", 1, "{not json", true);
            insert(&conn, "good", 1, &declarative("https://good.test/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a corrupt row is not a store failure");
        assert_eq!(act.registered, vec!["good".to_string()], "the healthy provider still serves");
        assert_eq!(act.skipped.len(), 1, "one row was skipped");
        assert_eq!(act.skipped[0].provider_id, "bad");
        assert_eq!(act.skipped[0].version, 1);
        assert!(act.skipped[0].reason.contains("is not JSON"), "{}", act.skipped[0].reason);
        assert!(!act.is_complete());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A manifest that parses but cannot be built is skipped the same way. `register`'s own failure
    /// is what surfaces — activation adds only the decision to continue.
    #[test]
    fn activation_skips_a_manifest_that_fails_to_build() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "p1", 1, &code_without_source(), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a build failure is not a store failure");
        assert!(act.registered.is_empty(), "nothing was registered");
        assert_eq!(act.skipped.len(), 1);
        // The reason is `register`'s, verbatim — activation does not rewrite it.
        assert!(
            act.skipped[0].reason.contains("code.source"),
            "the build's own reason is carried: {}",
            act.skipped[0].reason
        );
        assert!(rt.registered().is_empty(), "the runtime is unchanged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database with no manifests is an empty activation, not an error. A first launch is exactly
    /// this: no provider can be served, and the router says "no route" rather than failing to build.
    #[test]
    fn activation_on_an_empty_database_registers_nothing() {
        let (store, dir) = tmp_store();
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("no rows is not a failure");
        assert!(act.registered.is_empty());
        assert!(act.skipped.is_empty());
        assert!(act.is_complete());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Re-activating a healthy runtime must not take a provider down: a manifest that fails to build
    /// leaves the previous adapter serving, which is `register`'s boundary (D32) and the reason a
    /// launch can call this more than once.
    #[test]
    fn reactivating_a_provider_that_now_fails_leaves_the_previous_adapter_serving() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "p1", 1, &declarative("https://one.test/v1"), true);
        }
        let rt = runtime();
        assert_eq!(activate(&rt, &store, &allow()).unwrap().registered, vec!["p1".to_string()]);

        // The operator activates a broken v2.
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("UPDATE manifests SET is_active = 0 WHERE provider_id = 'p1'", [])
                .unwrap();
            insert(&conn, "p1", 2, &code_without_source(), true);
        }
        let act = activate(&rt, &store, &allow()).unwrap();
        assert!(act.registered.is_empty(), "v2 was skipped");
        assert_eq!(act.skipped.len(), 1);
        assert_eq!(
            rt.registered(),
            vec!["p1".to_string()],
            "the v1 adapter is still serving — a bad activation is not an outage"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **D46.** A manifest naming a host the egress will not dial is skipped **by name** at
    /// activation, instead of registering and then answering a `502 … :NETWORK` per request.
    ///
    /// The two assertions are deliberately different claims. `registered.is_empty()` is that nothing
    /// was activated; the reason check is that the *report* is the useful part — the whole defect was
    /// a report that blamed the provider, so a fix that skipped silently would have moved the
    /// problem rather than solved it. That the host and the operator's action are both named is what
    /// makes this a fix rather than a relocation.
    #[test]
    fn a_manifest_whose_host_is_not_allowlisted_is_skipped_by_name() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "p1", 1, &declarative("https://not-allowlisted.example/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a refusal is not a store failure");
        assert!(act.registered.is_empty(), "nothing was registered");
        assert_eq!(act.skipped.len(), 1);
        let reason = &act.skipped[0].reason;
        assert!(
            reason.contains("not-allowlisted.example"),
            "the reason must name the host that was refused: {reason}"
        );
        assert!(
            reason.contains("allowlist"),
            "the reason must name the allowlist, not the provider's health: {reason}"
        );
        assert!(
            rt.registered().is_empty(),
            "a provider that could never be dialled must not be reachable"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other half of the predicate: a local provider needs no allowlist entry at all, because
    /// `is_local` permits it — Ollama and LM Studio are the reason that branch exists.
    ///
    /// Run against an **empty** allowlist on purpose. If the check consulted only `contains`, this
    /// would be skipped, and a local provider would stop working on every fresh install.
    #[test]
    fn a_localhost_manifest_needs_no_allowlist_entry() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert(&conn, "p1", 1, &declarative("http://127.0.0.1:8799/v1"), true);
        }
        let rt = runtime();
        let act =
            activate(&rt, &store, &AllowList::default()).expect("a readable database activates");
        assert_eq!(
            act.registered,
            vec!["p1".to_string()],
            "localhost is permitted unconditionally"
        );
        assert!(act.skipped.is_empty(), "{:?}", act.skipped);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The check must not mask a different error.** A manifest with no `provider.baseUrl` has no
    /// host to check, so `check_destination` declines to have an opinion and `register` names the
    /// real problem.
    ///
    /// This is the assertion that keeps the new check from *lowering* diagnosability: without it,
    /// "there is no host" could be reported as "the host is not allowlisted", which would send the
    /// operator to the allowlist for a malformed manifest.
    #[test]
    fn a_manifest_with_no_base_url_is_left_to_register_to_refuse() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            let body = json!({
                "manifestVersion": 1,
                "kind": "declarative",
                "dialect": "openai-chat-v1",
                "provider": { "auth": { "headers": [] } },
                "endpoints": {},
                "capabilities": { "text": true, "image": false }
            })
            .to_string();
            insert(&conn, "p1", 1, &body, true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a build failure is not a store failure");
        assert_eq!(act.skipped.len(), 1);
        let reason = &act.skipped[0].reason;
        assert!(
            !reason.contains("allowlist"),
            "the destination check has no host to judge and must stay out of the way: {reason}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
