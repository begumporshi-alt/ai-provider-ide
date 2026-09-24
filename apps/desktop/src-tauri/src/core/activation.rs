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
//! # The builtin profiles, and which of the two sources wins
//!
//! The loop runs **over providers**, and for each one it first tries
//! [`crate::core::builtin_templates::provider_profile`] by **slug** — three builtin manifests
//! (`openrouter`, `opencode`, `b.ai`) built from the two ported templates — falling back to that
//! provider's active manifest row. That is the reference's `store.ts:367-381` verbatim, and the
//! branch's absence was **D41**, measured 2026-09-24 and closed 2026-09-25.
//!
//! Two facets, only the first of which D41 recorded:
//!
//! 1. **A builtin provider with no manifest row went unregistered.** `addProvider` writes the
//!    provider row *before* the manifest row (`store.ts:495-502`), and its `catch` rolls back
//!    in-memory state only — so a failure between the two leaves a row-less provider permanently.
//! 2. **A builtin provider with a row was served the *stale* stored one.** The row is written once,
//!    at creation, with `version: 1`; nothing re-seeds it on upgrade. The reference ignores that
//!    row for a builtin slug and serves the *current* profile, so any template change between
//!    releases is served by the reference and not by the old port. This facet needs no failure to
//!    reach — it holds for every builtin provider from the second release onwards.
//!
//! **The slug is the key, not `type`.** `store.ts:368` is `PROVIDER_PROFILES[p.slug]`, so a provider
//! typed `manifest` whose slug is `openrouter` is served by its profile in the reference. Keying on
//! `type` would diverge in the other direction, and the divergence would be invisible for the same
//! reason this one was: no builtin provider is installed on the machine anyone has measured.
//!
//! **On the profile path the destination is `providers.base_url`**, which is the column the
//! allowlist is derived from — so a builtin provider cannot trip D46. See
//! [`crate::core::builtin_templates`] for why that is a property of the composition and not of the
//! check.

use std::collections::HashMap;

use serde_json::Value;

use crate::core::adapter_runtime::AdapterRuntime;
use crate::core::builtin_templates;
use crate::core::egress::{host_is_permitted, AllowList};
use crate::core::error::CommandError;
use crate::core::persist::{manifests_active_rows, providers_rows, ManifestRow, ProviderRow};
use crate::core::store::Store;

/// One provider that could not be made to serve.
///
/// `version` is `Some` only when a **manifest row** was the thing that failed: the table holds every
/// version and an operator reading a skip needs to know *which* row it was — "provider X" alone
/// names three candidates. It is `None` for a provider with no row at all, and for one served from
/// a builtin profile, where there is no version because there is no row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub provider_id: String,
    pub version: Option<i64>,
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

/// Register every provider into the runtime, skipping the ones that cannot be built or cannot be
/// reached.
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
    let providers = providers_rows(store)?;
    let rows = manifests_active_rows(store)?;

    // The reference's `manifests.find(x => x.providerId === p.id)` (`store.ts:373`). The unique
    // index `uq_manifests_one_active` makes the lookup unambiguous; `or_insert` keeps the first row
    // should that index ever be violated, which is what `find` does.
    let mut by_provider: HashMap<&str, &ManifestRow> = HashMap::new();
    for row in &rows {
        by_provider.entry(row.provider_id.as_str()).or_insert(row);
    }

    let mut out = Activation::default();
    for p in &providers {
        match register_provider(runtime, allow, p, by_provider.get(p.id.as_str()).copied()) {
            Ok(()) => out.registered.push(p.id.clone()),
            Err(skip) => out.skipped.push(Skipped {
                provider_id: p.id.clone(),
                version: skip.version,
                reason: skip.reason,
            }),
        }
    }
    out.registered.sort();
    Ok(out)
}

/// What went wrong for one provider, before its id is attached by [`activate`].
///
/// Carrying `version` here as well is what keeps the two `None`s apart: "the profile failed" and
/// "there was no row" are both versionless for entirely different reasons, and only the reason
/// string says which.
struct Skip {
    version: Option<i64>,
    reason: String,
}

/// One provider: its builtin profile if its slug has one, otherwise its active manifest row.
///
/// **The profile is tried first, and the row is the fallback** — `store.ts:368-372`, then `:373-380`.
/// A provider whose slug has a profile therefore *ignores* its stored row, which is the second
/// facet of D41: the row is a snapshot from creation time and the profile is current code.
fn register_provider(
    runtime: &AdapterRuntime,
    allow: &AllowList,
    p: &ProviderRow,
    row: Option<&ManifestRow>,
) -> Result<(), Skip> {
    if let Some(body) = builtin_templates::provider_profile(&p.slug, &p.base_url) {
        check_destination(allow, &body).map_err(|reason| Skip { version: None, reason })?;
        return runtime.register(&p.id, &body).map_err(|reason| Skip { version: None, reason });
    }

    // An unknown slug with no row: nothing will serve this provider.
    //
    // **This is reported, and that is a deliberate, additive divergence** — the reference's loop
    // falls off the end silently (`store.ts:373` finds nothing and the body is skipped). Silence is
    // what made D41 invisible: the symptom arrives later as `no active manifest for provider …` on
    // every request, from a different module, with no mention of the launch that could have named
    // it. Reporting it here is the same argument as D46's — say it once, at boot, with a name.
    let Some(row) = row else {
        return Err(Skip { version: None, reason: no_row_reason(&p.slug) });
    };

    // The three row failures collapse into one `Err` because the caller treats them identically,
    // but the reason says which it was — "is not JSON" names a corrupt row, the allowlist message
    // names a destination the egress will refuse, and anything else names a manifest that parsed
    // and could not be built.
    let body: Value = serde_json::from_str(&row.body_json).map_err(|e| Skip {
        version: Some(row.version),
        reason: format!("body_json is not JSON: {e}"),
    })?;
    check_destination(allow, &body)
        .map_err(|reason| Skip { version: Some(row.version), reason })?;
    runtime.register(&p.id, &body).map_err(|reason| Skip { version: Some(row.version), reason })
}

/// The reason for a provider that has neither a profile nor a row.
///
/// It names the slug, because the slug is what decided there was no profile — and it names the
/// write order, because a provider in this state is usually a half-finished `addProvider` rather
/// than a manifest the operator deleted.
fn no_row_reason(slug: &str) -> String {
    format!(
        "no builtin profile for slug `{slug}` and no active manifest row — nothing will serve this \
         provider, and every request for it will answer `no active manifest for provider …`. \
         `addProvider` writes the provider row before the manifest row (`store.ts:495-502`), so a \
         failure between the two leaves exactly this state; re-creating the provider writes both"
    )
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

    use crate::core::adapter::{AdapterFactory, Cancel};
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
        assert_eq!(act.skipped[0].version, Some(1));
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

    // ---------- the builtin profiles (D41) ----------

    /// Insert a provider with a **chosen slug and base URL**.
    ///
    /// The existing `insert` helper ties slug and base URL to the provider id, which is right for
    /// the row-fallback tests and useless for the profiles: the profile branch is keyed on the slug
    /// and dials `base_url`, so a test that could not choose either would exercise neither.
    fn insert_provider(conn: &rusqlite::Connection, provider_id: &str, slug: &str, base_url: &str) {
        conn.execute(
            "INSERT INTO providers (id, slug, name, base_url, status, rotation_strategy, created_at, updated_at)
             VALUES (?1, ?2, ?2, ?3, 'enabled', 'round_robin', 1, 1)",
            params![provider_id, slug, base_url],
        )
        .unwrap();
    }

    /// **The profile wins over the stored row.** This is the second facet of D41, and the one that
    /// needs no failure to reach.
    ///
    /// The stored row is deliberately a `kind: "code"` manifest with no `code.source`, which
    /// **cannot be built into an adapter**. So the outcome names the winner without any accessor:
    /// if the row were used, `register` would fail and the provider would land in `skipped`; if the
    /// profile is used, it registers. A test that read a field off the built adapter would be able
    /// to pass on a copy the request path never sees — this cannot, because there is no adapter
    /// unless the profile won.
    #[test]
    fn a_builtin_provider_is_served_by_its_profile_not_its_stored_row() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert_provider(&conn, "p1", "openrouter", "https://one.test/v1");
            insert(&conn, "p1", 1, &code_without_source(), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable store activates");
        assert_eq!(act.registered, vec!["p1".to_string()], "the profile won");
        assert!(act.skipped.is_empty(), "the unusable row was never consulted: {:?}", act.skipped);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The first facet of D41, inverted: a builtin provider with no manifest row is served.**
    ///
    /// `addProvider` writes the provider row before the manifest row (`store.ts:495-502`), so a
    /// failure between the two leaves a provider that the reference serves from its profile and the
    /// old port served from nothing. The assertion is the symptom itself: `for_provider` used to
    /// answer `Err("no active manifest for provider p1")` for every request.
    #[tokio::test]
    async fn a_builtin_provider_with_no_manifest_row_is_still_served() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert_provider(&conn, "p1", "openrouter", "https://one.test/v1");
            // No manifest row at all.
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable store activates");
        assert_eq!(act.registered, vec!["p1".to_string()]);
        assert!(act.skipped.is_empty(), "{:?}", act.skipped);
        // The symptom, named: this is what a request used to get.
        let adapter = rt.for_provider("p1").await.expect("the provider serves");
        assert!(adapter.capabilities().text, "the profile's own declaration");
        // And the OpenRouter profile declares images, which the stored-row path could not have
        // supplied — there is no stored row.
        assert!(adapter.capabilities().image, "the profile declares an image endpoint");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The profile dials the provider row's base URL**, not the template's own default.
    ///
    /// The observable is `check_destination`, which is the same predicate production uses. The row
    /// is allowlisted and the *provider row* is not, so the only way this can be skipped is if the
    /// base URL came from the provider row — the reference's `withBaseUrl`.
    #[test]
    fn a_builtin_profile_dials_the_provider_rows_base_url() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert_provider(&conn, "p1", "openrouter", "https://not-allowlisted.example/v1");
            insert(&conn, "p1", 1, &declarative("https://one.test/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a refusal is not a store failure");
        assert!(act.registered.is_empty(), "nothing was registered");
        assert_eq!(act.skipped.len(), 1);
        let reason = &act.skipped[0].reason;
        assert!(
            reason.contains("not-allowlisted.example"),
            "the profile dials providers.base_url, not the row's: {reason}"
        );
        assert_eq!(act.skipped[0].version, None, "no row was involved");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The converse, and the half that proves the row's base URL is **not** consulted at all.
    #[test]
    fn a_builtin_profile_ignores_the_stored_rows_base_url() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert_provider(&conn, "p1", "openrouter", "https://one.test/v1");
            insert(&conn, "p1", 1, &declarative("https://not-allowlisted.example/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable store activates");
        assert_eq!(
            act.registered,
            vec!["p1".to_string()],
            "the row's refused host never reached the check: {:?}",
            act.skipped
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **A provider with neither a profile nor a row is reported**, which the reference does not do.
    ///
    /// Silence is what made D41 invisible: the symptom surfaced later, from a different module, as
    /// `no active manifest for provider …` on every request. The reason names the slug, because the
    /// slug is what decided there was no profile, and names the write order, because a provider in
    /// this state is usually a half-finished `addProvider`.
    #[test]
    fn a_provider_with_no_profile_and_no_row_is_reported_by_slug() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert_provider(&conn, "p1", "custom-thing", "https://one.test/v1");
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable store activates");
        assert!(act.registered.is_empty());
        assert_eq!(act.skipped.len(), 1);
        assert_eq!(act.skipped[0].provider_id, "p1");
        assert_eq!(act.skipped[0].version, None, "there is no row to name a version of");
        let reason = &act.skipped[0].reason;
        assert!(reason.contains("custom-thing"), "the reason names the slug: {reason}");
        assert!(
            reason.contains("no active manifest for provider"),
            "the reason names the symptom the operator would otherwise see: {reason}"
        );
        assert!(!act.is_complete(), "a provider nothing serves is not a complete activation");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **Every profile is reachable through activation**, not just the one the fixtures favour.
    ///
    /// `PROFILE_SLUGS` exists so a test can walk the table instead of trusting a sample; a `b.ai`
    /// arm that were dropped would leave every other test green, because they all use
    /// `openrouter`. The observable is `capabilities`: only OpenRouter declares an image endpoint.
    #[tokio::test]
    async fn every_builtin_slug_registers_without_a_manifest_row() {
        for slug in crate::core::builtin_templates::PROFILE_SLUGS {
            let (store, dir) = tmp_store();
            {
                let conn = store.conn.lock().unwrap();
                insert_provider(&conn, "p1", slug, "https://one.test/v1");
            }
            let rt = runtime();
            let act =
                activate(&rt, &store, &allow()).unwrap_or_else(|e| panic!("{slug} activates: {e}"));
            assert_eq!(act.registered, vec!["p1".to_string()], "slug {slug}");
            let adapter =
                rt.for_provider("p1").await.unwrap_or_else(|e| panic!("{slug} serves: {e}"));
            assert_eq!(
                adapter.capabilities().image,
                slug == "openrouter",
                "{slug} declares image: {}",
                adapter.capabilities().image
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// **The fallback is unchanged for a provider with no profile**: the stored row still supplies
    /// the manifest, and its own declaration is what gets registered.
    ///
    /// This is the contrast that makes the profile tests mean something — without it, "the profile
    /// won" would be indistinguishable from "nothing ever reads the row".
    #[tokio::test]
    async fn a_provider_with_no_profile_is_still_served_from_its_stored_row() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            insert_provider(&conn, "p1", "custom-thing", "https://one.test/v1");
            insert(&conn, "p1", 1, &declarative_with_images("https://one.test/v1"), true);
        }
        let rt = runtime();
        let act = activate(&rt, &store, &allow()).expect("a readable store activates");
        assert_eq!(act.registered, vec!["p1".to_string()]);
        let adapter = rt.for_provider("p1").await.expect("the provider serves");
        assert!(adapter.capabilities().image, "the row's own declaration is what was registered");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A declarative manifest that declares an image capability — the contrast fixture for the
    /// capability assertions above, which need a row whose declaration differs from the profile's.
    fn declarative_with_images(base_url: &str) -> String {
        let mut v: serde_json::Value = serde_json::from_str(&declarative(base_url)).unwrap();
        v["capabilities"]["image"] = serde_json::Value::Bool(true);
        v.to_string()
    }
}
