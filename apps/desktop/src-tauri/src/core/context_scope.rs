#![allow(dead_code)]
//! Gateway memory & context layer — Phase 1 scaffolding.
//!
//! Design: `GATEWAY_MEMORY_LAYER.md` at the repo root. Phases 1 and 2 are landed: `inject_context`
//! is called on every chat-shaped dispatch, where it strips the gateway-invented `metadata.aip`
//! field, resolves a scope, and — when memory is enabled — recalls, ranks, trims and prepends a
//! memory block. It reports what it did (or why it did nothing) on the response as `AIP-Memory` and
//! `AIP-Memory-Scope`. Everything is behind the host toggle, which defaults to off.
//!
//! Two rules from the design are encoded here because they are cheap to get wrong later:
//!
//!  - **`metadata.aip` is stripped, never forwarded.** It exists because most agent IDEs can set a
//!    base URL and a key but not a custom header; a vendor does not know the field and at least one
//!    dialect rejects unknown body fields. Parsing it and leaving it in place is a day-one bug.
//!  - **An unresolved project is not "global".** Three independent reviewers flagged
//!    nullable-means-global as a contamination engine: the header-less IDE is the *common* case, so
//!    the default would degrade to global and leak repo A's context into repo B. `None` means
//!    unresolved, and unresolved means project-scoped memory is never injected.
//!
//! Phase 1 lands the parsers and the dispatch hook but no recall, so a fair amount of the surface
//! below has no caller yet. It is kept because it is the Phase 2 contract, not because it is
//! speculative — `allow(dead_code)` comes off when the pipeline lands.
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use serde_json::{json, Value};

use crate::core::gateway::GatewayCore;

/// Ceiling on a client-requested memory budget. The gateway owns the safety budget; a client may
/// only ask for less, never more.
pub const MAX_BUDGET_TOKENS: usize = 1500;

/// §5.6: the wall-clock ceiling on the entire memory path.
///
/// Recall is a synchronous BM25 query over SQLite and live context does five reads and writes on
/// the same file; under concurrent IDE traffic both become lock contention, and tail latency there
/// is paid by whoever is waiting on a model answer. The design's instruction is explicit — never
/// let a write or a lock delay the model request — so the path runs against a clock and is
/// abandoned whole rather than trimmed when the clock runs out.
///
/// 15ms sits inside the 10–20ms band the design gives. Being wrong here costs one request its
/// memory block, which is the intended failure mode; the alternative costs every request its
/// latency budget.
#[cfg(not(test))]
pub const MEMORY_DEADLINE: Duration = Duration::from_millis(15);

/// The same budget, widened under `cargo test`.
///
/// 15 ms is a product decision, not something a test can rely on: `cargo test` runs tests in
/// parallel, and a store open plus a recall on a loaded machine can exceed the budget. The failure
/// then reads as `injected=0;reason=deadline`, which looks like a policy bug and is not one — and
/// because it is load-dependent it moved from test to test, so widening one call site only moved the
/// noise rather than removing it. Roughly two dozen tests call `inject_context` as scaffolding for
/// properties about recall, scope and policy; none of them are asserting anything about 15 ms.
///
/// This is the single place the two builds differ, and the deadline is still tested for real:
/// `a_deadline_that_is_already_gone_misses_and_stays_missed` drives `Deadline::new(Duration::ZERO)`
/// directly, and the §5.6 tests call `inject_context_deadline` with explicit budgets — which is what
/// that parameter exists for.
#[cfg(test)]
pub const MEMORY_DEADLINE: Duration = Duration::from_secs(30);

/// A wall-clock budget for the memory path: started once per request, checked at every stage
/// boundary.
///
/// The checks sit *between* stages rather than inside them because the expensive steps are single
/// SQLite calls that cannot be interrupted once started. What the deadline actually bounds is how
/// many of them one request may pay for — which is exactly the contention case it exists for.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    start: Instant,
    budget: Duration,
    /// The stage that was about to run when the clock ran out. Recorded at the first miss and never
    /// overwritten: every later stage misses too, and the name worth logging is the first one.
    missed_at: Option<&'static str>,
}

impl Deadline {
    pub fn new(budget: Duration) -> Self {
        Self { start: Instant::now(), budget, missed_at: None }
    }

    /// Whether `stage` may start. False once the budget is gone, and false for every stage after
    /// that: a path which has missed its deadline is abandoned, not resumed.
    pub fn check(&mut self, stage: &'static str) -> bool {
        if self.start.elapsed() < self.budget {
            return true;
        }
        if self.missed_at.is_none() {
            self.missed_at = Some(stage);
        }
        false
    }

    /// The stage that missed, if any. `None` while the path is still inside budget.
    pub fn missed_at(&self) -> Option<&'static str> {
        self.missed_at
    }

    pub fn budget_ms(&self) -> u64 {
        self.budget.as_millis() as u64
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// Share of the budget long-term memory may take before live context gets the remainder. Memory is
/// scoped and durable, so it is ranked first; live context is rebuildable from the transcript and
/// is what degrades first when the window is tight.
const MEMORY_SHARE: f64 = 0.60;

/// Cap on a client-pushed open-files list. Reused from `session_context` rather than redeclared:
/// a second value for "how many open files is too many" would drift.
const OPEN_FILES_CAP: usize = crate::core::gateway::session_context::OPEN_FILES_CAP;

/// Response header carrying the compact injection status: what happened, or why nothing did.
pub const HDR_MEMORY: &str = "aip-memory";

/// Response header carrying the scope the gateway resolved, so "which project did you think I was
/// in" is answerable. Scope mis-resolution is the single most likely failure of this feature, and
/// the value only ever travels back to the client that told us the scope in the first place.
pub const HDR_MEMORY_SCOPE: &str = "aip-memory-scope";

/// Per-request memory mode. `None` in `RequestMeta` means "not specified, use the host toggle".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryMode {
    Off,
    On,
    /// Recall and inject, but capture nothing.
    Read,
    /// Capture, but inject nothing.
    Write,
}

impl MemoryMode {
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Some(Self::Off),
            "on" => Some(Self::On),
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            _ => None,
        }
    }

    /// Whether this mode permits injecting a memory block.
    pub fn allows_read(self) -> bool {
        matches!(self, Self::On | Self::Read)
    }

    /// Whether this mode permits capturing the turn.
    pub fn allows_write(self) -> bool {
        matches!(self, Self::On | Self::Write)
    }
}

/// A resolved scope. `None` on a dimension means **unresolved**, not global.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Scope {
    /// Effectively constant today (single-user desktop app); modelled for a future service mode.
    pub user: String,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub session: Option<String>,
}

impl Scope {
    /// True only when enough identity exists to read project-scoped memory.
    ///
    /// A session is deliberately not sufficient: IDEs reuse session ids across repositories, so a
    /// session is a correlation key, not a boundary.
    pub fn can_read_project_memory(&self) -> bool {
        self.project.is_some()
    }

    /// `user=local;project=p1a2b3c4;agent=cursor`, with `-` for a dimension that did not resolve.
    /// Unresolved renders as `-` rather than being omitted: a header whose shape shifts between
    /// requests is harder to parse than one that always has the same three keys.
    pub fn as_header_value(&self) -> String {
        let raw = format!(
            "user={};project={};agent={}",
            self.user,
            self.project.as_deref().unwrap_or("-"),
            self.agent.as_deref().unwrap_or("-"),
        );
        sanitize_header_value(&raw)
    }
}

/// Header values must be visible ASCII plus space. A project key is hex, but `agent` falls back to
/// whatever a client put in its `user` field, so it is untrusted input. Illegal characters are
/// dropped rather than allowed to fail at the axum header layer — a malformed client string must
/// never become a 500 on the response path.
fn sanitize_header_value(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').collect()
}

/// What a client asked for, before any defaults are applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestMeta {
    pub session: Option<String>,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub user: Option<String>,
    pub mode: Option<MemoryMode>,
    pub budget: Option<usize>,
    /// Live context the agent pushes. Comma-separated on the wire, `["a","b"]` in `metadata.aip`.
    pub open_files: Option<Vec<String>>,
    /// The caller is the router itself (§3.5.6). Self-declared, but the reserved agent label in
    /// `capture::classify_principal` is checked as well, so a drain that forgets the flag is still
    /// recognised.
    pub internal: bool,
    /// True when any `AIP-*` header or `metadata.aip` key was present, so the caller can tell "the
    /// client opted in" from "the client knows nothing about this feature".
    pub explicit: bool,
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

impl RequestMeta {
    /// Parse the contract from headers first, then from the `metadata.aip` body fallback.
    ///
    /// Headers win when both are present; a client that can set headers is a client that has opted
    /// in deliberately. The body fallback exists only because Cursor/Continue-style clients cannot.
    pub fn parse(headers: &HeaderMap, body: &Value) -> Self {
        let obj = body.as_object();
        let aip = obj.and_then(|o| o.get("metadata")).and_then(|m| m.get("aip"));
        let aip = aip.and_then(|v| v.as_object());

        let pick = |header_name: &str, key: &str| -> Option<String> {
            header(headers, header_name).or_else(|| {
                aip.and_then(|m| {
                    m.get(key)
                        .and_then(Value::as_str)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                })
            })
        };

        let session = pick("aip-session", "session");
        let project = pick("aip-project", "project");
        let agent = pick("aip-agent", "agent");
        let user = pick("aip-user", "user");

        // `pick` already covers the body key, so one call handles header-then-body in order.
        let mode = pick("aip-memory", "memory").and_then(|s| MemoryMode::parse(&s));

        // A client may only ever ask for less than the gateway's own ceiling.
        let budget = pick("aip-memory-budget", "budget")
            .and_then(|s| s.parse::<usize>().ok())
            .map(|n| n.min(MAX_BUDGET_TOKENS))
            .filter(|n| *n > 0);

        // Two shapes for the same value: a header has to be one line, the body can be a real array.
        // Both are optional and neither is required for the feature to work.
        let open_files = pick("aip-open-files", "open_files")
            .map(|s| {
                s.split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .take(OPEN_FILES_CAP)
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty())
            .or_else(|| {
                aip.and_then(|m| m.get("open_files"))
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .take(OPEN_FILES_CAP)
                            .collect::<Vec<_>>()
                    })
                    .filter(|v| !v.is_empty())
            });

        let internal = match pick("aip-internal", "internal") {
            Some(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
            None => aip.and_then(|m| m.get("internal")).and_then(Value::as_bool).unwrap_or(false),
        };

        let explicit = session.is_some()
            || project.is_some()
            || agent.is_some()
            || user.is_some()
            || mode.is_some()
            || budget.is_some()
            || open_files.is_some();

        Self { session, project, agent, user, mode, budget, open_files, internal, explicit }
    }

    /// Apply defaults in the documented order. `agent` additionally falls back to the request's
    /// `user` field, which several clients already populate with a client name.
    ///
    /// `workspace_root` is the last resort for `project` and is hashed rather than used verbatim:
    /// two repos can share a directory name, and the stored scope must be stable across sessions.
    pub fn resolve(&self, body: &Value, workspace_root: Option<&str>) -> Scope {
        let agent = self.agent.clone().or_else(|| {
            body.as_object()
                .and_then(|o| o.get("user"))
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });

        let project =
            self.project.clone().or_else(|| workspace_root.and_then(project_key_from_root));

        Scope {
            user: self.user.clone().unwrap_or_else(|| "local".to_string()),
            project,
            agent,
            session: self.session.clone(),
        }
    }
}

/// FNV-1a. Not cryptographic — it only has to be stable across processes and resistant enough to
/// collisions for scope keys and session ids, where two different inputs sharing a key would be a
/// silent cross-scope leak.
pub fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// Stable, short key for a workspace root. FNV-1a over the path — not crypto, just collision
/// resistant enough to keep two `~/dev/app` directories from sharing a scope.
pub fn project_key_from_root(root: &str) -> Option<String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!("p{:016x}", fnv1a(trimmed)))
}

/// Remove the gateway-invented `metadata.aip` object before dispatch.
///
/// Only the `aip` key goes; a client's own `metadata` (tracing ids, user tags) is passed through
/// untouched. The wrapping object is dropped as well once empty, so a vendor never sees a key we
/// invented.
pub fn strip_aip_metadata(body: &mut Value) -> bool {
    let Some(obj) = body.as_object_mut() else {
        return false;
    };
    let Some(md) = obj.get_mut("metadata").and_then(|v| v.as_object_mut()) else {
        return false;
    };
    let removed = md.remove("aip").is_some();
    if md.is_empty() {
        obj.remove("metadata");
    }
    removed
}

/// Why injection did or did not happen. Reported on the response so "why didn't the model know X"
/// is answerable without guesswork.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    Disabled,
    /// §4a: the master switch is on, but this principal is not allowed to use memory.
    PrincipalOff,
    ClientOff,
    /// The caller asked for the write half only (`aip-memory: write`), so there was nothing to
    /// recall. Distinct from `ClientOff`, which means the caller opted out of memory entirely —
    /// collapsing the two made an operator hunt for a client that had disabled memory when in fact
    /// one had merely declined to be read back to.
    WriteOnly,
    NoProject,
    NoCandidates,
    BelowFloor,
    Deadline,
    Injected,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::PrincipalOff => "principal_off",
            Self::ClientOff => "client_off",
            Self::WriteOnly => "write_only",
            Self::NoProject => "no_project",
            Self::NoCandidates => "no_candidates",
            Self::BelowFloor => "below_floor",
            Self::Deadline => "deadline",
            Self::Injected => "injected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectionOutcome {
    pub injected: bool,
    pub reason: SkipReason,
    pub items: usize,
    /// Live-context turns injected alongside the memory block. Reported separately because the two
    /// come from different stores and "memory was empty but context was not" is a real case.
    pub context: usize,
    pub tokens: usize,
    /// The resolved scope, already formatted for `HDR_MEMORY_SCOPE`.
    pub scope: String,
}

impl InjectionOutcome {
    /// One compact value rather than the four separate headers the design first specified
    /// (`-Injected` / `-Tokens` / `-Items` / `-Degraded`). Two independent reviewers argued for a
    /// single status field, and they are right: every extra header is a string build on the hot
    /// path and no caller reads four of them.
    ///
    /// `injected=1;items=7;tokens=412` or `injected=0;reason=below_floor`. `ctx=N` is appended only
    /// when live-context turns were injected, so the common case stays short.
    pub fn status_value(&self) -> String {
        if !self.injected {
            return format!("injected=0;reason={}", self.reason.as_str());
        }
        let base = format!("injected=1;items={};tokens={}", self.items, self.tokens);
        if self.context > 0 {
            format!("{base};ctx={}", self.context)
        } else {
            base
        }
    }
}

/// Attach the memory headers to a finished response. Both values go through `HeaderValue`, and an
/// unparseable one is dropped rather than propagated — the response has already been earned by this
/// point and telemetry is not worth failing it for.
pub fn apply_memory_headers(resp: &mut Response, outcome: &InjectionOutcome) {
    if let Ok(v) = HeaderValue::from_str(&outcome.status_value()) {
        resp.headers_mut().insert(HDR_MEMORY, v);
    }
    if let Ok(v) = HeaderValue::from_str(&outcome.scope) {
        resp.headers_mut().insert(HDR_MEMORY_SCOPE, v);
    }
}

/// The single injection point, called by every chat-shaped ingress handler after dialect
/// translation and before `bridge.dispatch`.
///
/// `source` is the **original ingress body**, `body` is the **canonical body about to be
/// dispatched**. They are the same object on the OpenAI path and different objects on the three
/// translated dialects — `to_chat_body` and its siblings rebuild the request from scratch and drop
/// unknown fields, so a `metadata.aip` written by a Claude Code or Gemini client never survives
/// translation. Reading the contract from the canonical body alone would silently ignore the body
/// fallback for exactly the header-less clients it exists to serve.
///
/// Phase 1: strips `metadata.aip` and returns `Disabled`/`ClientOff`. Everything else in the
/// pipeline (recall, rank, trim, compose) lands in Phase 2 behind the same signature, so no caller
/// changes when it does.
///
/// This function must never fail the request. Any error path returns an outcome, not a `Result`.
pub fn inject_context(
    core: &GatewayCore,
    headers: &HeaderMap,
    source: Option<&Value>,
    body: &mut Value,
) -> InjectionOutcome {
    inject_context_deadline(core, headers, source, body, MEMORY_DEADLINE)
}

/// `inject_context` with an explicit deadline. Production always passes `MEMORY_DEADLINE` (§5.6);
/// the parameter exists so a test can force an overrun deterministically, rather than by seeding
/// enough memories to make recall genuinely slow and hoping.
pub fn inject_context_deadline(
    core: &GatewayCore,
    headers: &HeaderMap,
    source: Option<&Value>,
    body: &mut Value,
    deadline_budget: Duration,
) -> InjectionOutcome {
    // §5.6: the clock starts before the first byte of work, so the deadline covers the whole memory
    // path and not merely the part that is convenient to bound.
    let mut deadline = Deadline::new(deadline_budget);

    // Read everything from the source inside one block. `src` may alias `body` (the OpenAI path
    // passes `None`), so the immutable borrow has to end before `body` is mutated below.
    let (meta, scope) = {
        let src: &Value = source.unwrap_or(&*body);
        let meta = RequestMeta::parse(headers, src);
        let root: Option<String> = core.workspace_root().map(|p| p.to_string_lossy().into_owned());
        let scope = meta.resolve(src, root.as_deref());
        (meta, scope)
    };
    strip_aip_metadata(body);

    // Resolved once and carried on every outcome: the response header reports the scope the gateway
    // actually used, including when nothing was injected. That is the whole point of reporting it —
    // "why didn't the model know X" is almost always "the scope resolved to something you did not
    // expect", and that is invisible if the header only appears on success.
    let scope_hdr = scope.as_header_value();
    let skip = |reason: SkipReason| InjectionOutcome {
        injected: false,
        reason,
        items: 0,
        context: 0,
        tokens: 0,
        scope: scope_hdr.clone(),
    };
    // §5.6: a miss is logged, not silent. Without the log a contended database looks like "memory
    // stopped working" with nothing to correlate it against, and the stage name is what separates
    // "recall got slow" from "live context is fighting for the write lock".
    let miss = |d: &Deadline| -> InjectionOutcome {
        tracing::warn!(
            elapsed_ms = d.elapsed_ms(),
            budget_ms = d.budget_ms(),
            stage = d.missed_at().unwrap_or("?"),
            scope = %scope_hdr,
            "memory path missed its deadline — dispatching without memory"
        );
        skip(SkipReason::Deadline)
    };

    // §4a: the operator's decision, then the client's. A client cannot switch on what the operator
    // switched off — the request carries the client's preference, but the gateway is not the
    // client's to configure.
    //
    // The app key is only resolved with memory on: off by default has to mean no extra work, and
    // resolving one means reading the app-key map.
    let app_key = if core.memory_enabled() {
        core.key_principal_for(crate::core::gateway::presented_key(headers))
    } else {
        None
    };
    let operator_allows = crate::core::gateway::principal::allows(
        core.memory_enabled(),
        core.store().map(|s| s.as_ref()),
        scope.agent.as_deref(),
        app_key.as_deref(),
    );
    let mode = match meta.mode {
        Some(m) if operator_allows => m,
        // An explicit client request against a principal the operator disabled is refused, not
        // honoured: `Some(_)` here means the client asked for memory and may not have it.
        Some(_) => MemoryMode::Off,
        None if operator_allows => MemoryMode::On,
        None => MemoryMode::Off,
    };

    if !mode.allows_read() {
        return skip(if !core.memory_enabled() {
            SkipReason::Disabled
        } else if !operator_allows {
            SkipReason::PrincipalOff
        } else if matches!(meta.mode, Some(MemoryMode::Write)) {
            SkipReason::WriteOnly
        } else {
            SkipReason::ClientOff
        });
    }

    // ---- recall → rank → trim → compose ----
    //
    // Every step below is fallible and every failure degrades to "no memory block". Nothing on this
    // path may return an error to the client.
    let Some(store) = core.store() else {
        return skip(SkipReason::NoCandidates);
    };
    // An unresolved project is not a reason to bail: `recall_scoped` already narrows that case to
    // pinned global rows. Bailing here would silently drop the hard constraints, which is the one
    // category that most needs to survive.

    // §5.6, check 1: from here to the composed block the path can touch SQLite — the window lookup,
    // the freeze map, and recall. Named for recall because that is the expensive one.
    if !deadline.check("recall") {
        return miss(&deadline);
    }

    // §3.4: the real window when we know it. Against a 200k model the old flat 8192 made 25% of
    // "what is left" a rounding error; against a small one it was generous. The ceiling below still
    // bounds the block, so a large window cannot over-inject — it only stops starving recall.
    let mw = crate::core::gateway::model_context::lookup(
        core.store().map(|s| s.as_ref()),
        body.get("model").and_then(Value::as_str),
    );
    let planned = plan_budget_for(body, mw.window, mw.chars_per_token);
    let budget = meta.budget.unwrap_or(planned).min(MAX_BUDGET_TOKENS);
    let memory_budget = ((budget as f64) * MEMORY_SHARE) as usize;

    let freeze_key = freeze_key(&scope, &meta, app_key.as_deref());
    let (memory_block, items, had_candidates) = match core.frozen_memory(&freeze_key, memory_budget)
    {
        // §5.5: a hit skips recall entirely, and that is the point rather than an optimisation —
        // the block has to come out byte-identical, and the only way to guarantee that is to not
        // recompute it.
        Some(f) => (f.block, f.items, f.had_candidates),
        None => {
            let rscope = crate::core::memory::RecallScope {
                user: Some(scope.user.clone()),
                project: scope.project.clone(),
                agent: scope.agent.clone(),
            };
            // L0 is excluded by default: it is verbatim conversation, so injecting it ships one
            // vendor's session to another. Opting in is deliberate and per-scope (design §0.4).
            let layers = [String::from("L1"), String::from("L2"), String::from("L3")];
            let rows = match crate::core::memory::recall_scoped(
                store,
                &recall_query(body),
                20,
                Some(&layers),
                &rscope,
            ) {
                Ok(r) => r,
                Err(_) => return skip(SkipReason::NoCandidates),
            };

            let mut candidates: Vec<Candidate> = rows
                .into_iter()
                .map(|m| Candidate { id: m.id, layer: m.layer, text: m.text, pinned: m.pinned })
                .collect();
            // No memory is not a reason to stop: live context stands on its own, and a first
            // request in a new project legitimately has no atoms yet but still has turns and open
            // files.
            let had = !candidates.is_empty();
            if had {
                rank(&mut candidates);
            }
            let chosen = trim(&candidates, memory_budget);
            let block = compose_block(&chosen);
            let items = chosen.len();
            // §5.5: frozen only when there is something to freeze. An empty result would otherwise
            // pin "nothing to recall" for the whole TTL, and the first atom anyone distilled in a
            // new project would stay invisible for ten minutes.
            if !block.is_empty() {
                core.freeze_memory(freeze_key, block.clone(), items, estimate_tokens(&block), had);
            }
            (block, items, had)
        }
    };

    // ---- live context ----
    //
    // Shares the same budget and the same insertion point. Every step is fallible and every failure
    // degrades to "no context block" — the memory block above already stands on its own.
    //
    // §5.6, check 2: live context is five reads and writes on the same connection, so it is the
    // stage most likely to be waiting on a lock. Refusing to start it is the whole point — the
    // writes are what the deadline is protecting the model call from.
    if !deadline.check("context") {
        return miss(&deadline);
    }
    let (context_block, context_items) = live_context(
        store,
        &meta,
        &scope,
        body,
        budget.saturating_sub(estimate_tokens(&memory_block)),
        app_key.as_deref(),
    );

    // §5.6, check 3: the last chance to decide, before the client's body is mutated. A block that
    // took too long to build is not worth shipping — the request goes out as it arrived.
    if !deadline.check("prepend") {
        return miss(&deadline);
    }

    let mut block = memory_block;
    block.push_str(&context_block);
    if block.is_empty() {
        // Distinguish "there was nothing to inject" from "there was something and it did not fit" —
        // the two send the operator to completely different fixes.
        return skip(if had_candidates {
            SkipReason::BelowFloor
        } else {
            SkipReason::NoCandidates
        });
    }

    let tokens = estimate_tokens(&block);
    if !prepend_system_message(body, &block) {
        return skip(SkipReason::NoCandidates);
    }

    InjectionOutcome {
        injected: true,
        reason: SkipReason::Injected,
        items,
        context: context_items,
        tokens,
        scope: scope_hdr,
    }
}

/// §5.5: what a composed memory block is frozen under — the design's `(scope, session)`.
///
/// Note what is deliberately **not** in it: the query. Freezing across queries is the entire point.
/// A block that re-ranks per request changes bytes at system position 0 every time, which
/// invalidates the provider's cached prefix on every call — the failure §5.5 exists to prevent.
/// The cost is staleness inside the TTL: a session that changes topic keeps the earlier block until
/// it expires.
///
/// The principal is part of the session half of this key, so two callers cannot share a frozen
/// block any more than they can share a session.
fn freeze_key(scope: &Scope, meta: &RequestMeta, principal: Option<&str>) -> String {
    format!(
        "{}|{}",
        scope.as_header_value(),
        crate::core::gateway::session_context::resolve_session(meta, scope, principal)
    )
}

/// Everything the capture queue needs that is known *before* the model answers.
///
/// Split from `finish_capture` because the SSE branches build a `'static` stream and therefore
/// cannot borrow the request body. Preparing first also avoids a second clone of what may be a
/// large prompt — only this small struct crosses into the stream.
pub struct PreparedCapture {
    store: Arc<crate::core::store::Store>,
    request_id: String,
    session: String,
    scope: Scope,
    user_text: String,
    model: String,
    principal: crate::core::capture::Principal,
    writes_allowed: bool,
    involves_tools: bool,
}

/// Compute the capture inputs for an exchange. `None` when there is no store, which is the
/// no-memory-configured case and is not an error.
pub fn prepare_capture(
    core: &GatewayCore,
    headers: &HeaderMap,
    body: &Value,
    request_id: u64,
) -> Option<PreparedCapture> {
    let store = core.store()?.clone();
    let meta = RequestMeta::parse(headers, body);
    let root: Option<String> = core.workspace_root().map(|p| p.to_string_lossy().into_owned());
    let scope = meta.resolve(body, root.as_deref());
    // §4a: the same operator-over-client precedence as the read path. A principal denied memory
    // must not have its turns recorded either — otherwise "off" would still mean "quietly learning
    // from you". Read before the struct is built, because `store` moves into it.
    let app_key = if core.memory_enabled() {
        core.key_principal_for(crate::core::gateway::presented_key(headers))
    } else {
        None
    };
    let operator_allows = crate::core::gateway::principal::allows(
        core.memory_enabled(),
        Some(store.as_ref()),
        scope.agent.as_deref(),
        app_key.as_deref(),
    );
    Some(PreparedCapture {
        store,
        request_id: crate::core::capture::request_id(request_id),
        session: crate::core::gateway::session_context::resolve_session(
            &meta,
            &scope,
            app_key.as_deref(),
        ),
        user_text: recall_query(body),
        model: body.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
        principal: crate::core::capture::classify_principal(&scope, meta.internal),
        writes_allowed: meta.mode.map(|m| m.allows_write()).unwrap_or(true) && operator_allows,
        // §3.5.1 is decided against what the client sent, before any text is synthesized.
        involves_tools: crate::core::capture::involves_tools(body),
        scope,
    })
}

/// Offer the finished exchange to the capture queue. Called when the worker signals `Done`.
///
/// Never fails the caller, and no model call happens here — the queue is drained by the webview.
pub fn finish_capture(prep: &PreparedCapture, asst_text: &str) -> crate::core::capture::Enqueue {
    use crate::core::capture::{enqueue, CaptureRequest};
    enqueue(
        &prep.store,
        &CaptureRequest {
            request_id: &prep.request_id,
            session_id: Some(&prep.session),
            scope: &prep.scope,
            user_text: &prep.user_text,
            asst_text: Some(asst_text),
            model: Some(&prep.model),
            principal: prep.principal,
            writes_allowed: prep.writes_allowed,
            had_tools: prep.involves_tools,
        },
    )
}

/// Record the incoming tail, then compose the live-context block for what is left of the budget.
///
/// Returns `(block, turn_count)`. Recording is best-effort: a failed write costs the next request
/// some context, not this one its response.
fn live_context(
    store: &Arc<crate::core::store::Store>,
    meta: &RequestMeta,
    scope: &Scope,
    body: &Value,
    budget: usize,
    principal: Option<&str>,
) -> (String, usize) {
    let sess = crate::core::gateway::session_context::resolve_session(meta, scope, principal);
    if crate::core::gateway::session_context::touch_session(store, &sess, scope).is_err() {
        return (String::new(), 0);
    }

    if meta.mode.map(|m| m.allows_write()).unwrap_or(true) {
        let _ = crate::core::gateway::session_context::record_turns(store, &sess, body);
    }
    if let Some(files) = &meta.open_files {
        let _ = crate::core::gateway::session_context::set_state(store, &sess, Some(files), None);
    }

    let mut open_files: Vec<String> = Vec::new();
    if let Ok(Some(st)) = crate::core::gateway::session_context::get_state(store, &sess) {
        open_files = st.open_files;
    }

    let Ok(recent) = crate::core::gateway::session_context::recent_turns(store, &sess, 12) else {
        return (String::new(), 0);
    };
    // §5.4: the client replays its own transcript, so anything it already sent is dropped rather
    // than appearing twice.
    let incoming = crate::core::gateway::session_context::incoming_hashes(body);
    let turns = crate::core::gateway::session_context::without_duplicates(recent, &incoming);

    // Newest first until the budget runs out, then back to chronological for the prompt.
    let mut chosen: Vec<crate::core::gateway::session_context::Turn> = Vec::new();
    let mut used = if open_files.is_empty() {
        0
    } else {
        estimate_tokens(&open_files.join(", ")) + BULLET_OVERHEAD_TOKENS
    };
    for t in turns.into_iter().rev() {
        let cost = estimate_tokens(&t.text) + BULLET_OVERHEAD_TOKENS;
        if used + cost > budget {
            break;
        }
        used += cost;
        chosen.push(t);
    }
    chosen.reverse();

    if open_files.is_empty() && chosen.is_empty() {
        return (String::new(), 0);
    }
    (compose_context_block(&open_files, &chosen), chosen.len())
}

// ---------- budget ----------

/// Used until `router_model_context` (design §3.4) lands and the real per-model window is known.
/// Being wrong low is safe — it under-injects. Being wrong high overflows the window.
pub const DEFAULT_WINDOW_TOKENS: usize = 8192;

/// No tokenizer in Rust and adding one is a new dependency for a number that only has to be safe.
/// 3.5 chars/token over-estimates typical prose and JSON, and over-estimating under-injects — the
/// correct direction to be wrong in.
pub const CHARS_PER_TOKEN: f64 = 3.5;

/// Share of the remaining window that memory may take. Raised from 10% after review: 10% of an 8k
/// window and 10% of a 200k window are not the same behavioural cost, and the ceiling below is what
/// actually protects the top end.
const MEMORY_FRACTION: f64 = 0.25;

const RESERVE_FRACTION: f64 = 0.20;
/// Overhead per injected bullet, so the estimate accounts for the marker and newline too.
const BULLET_OVERHEAD_TOKENS: usize = 8;
/// One memory is clipped to this before it is considered at all.
const MAX_ITEM_CHARS: usize = 300;

pub fn estimate_tokens(text: &str) -> usize {
    (text.chars().count() as f64 / CHARS_PER_TOKEN).ceil() as usize
}

/// Rough size of the client's own prompt. Only string content is counted — a Rust-side estimate over
/// a mixed dialect body will undercount, which is why the design calls for retry-without-memory on an
/// upstream context-length error.
pub fn estimate_prompt_tokens_at(body: &Value, chars_per_token: f64) -> usize {
    body.get("messages")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    let text = m.get("content").and_then(Value::as_str).unwrap_or("");
                    (text.chars().count() as f64 / chars_per_token).ceil() as usize + 4
                })
                .sum()
        })
        .unwrap_or(0)
}

pub fn estimate_prompt_tokens(body: &Value) -> usize {
    estimate_prompt_tokens_at(body, CHARS_PER_TOKEN)
}

/// `min(25% of what is left, MAX_BUDGET_TOKENS)`. `max_tokens` is honoured when the client declares
/// one, rather than assuming a flat fraction of the window.
///
/// `window` and `chars_per_token` come from `router_model_context` (§3.4) when the model is known.
/// The default-window form below is what tests and any caller without a store use.
pub fn plan_budget_for(body: &Value, window: usize, chars_per_token: f64) -> usize {
    let declared = body.get("max_tokens").and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
    let reserve = if declared > 0 { declared } else { (window as f64 * RESERVE_FRACTION) as usize };
    let avail = window.saturating_sub(reserve + estimate_prompt_tokens_at(body, chars_per_token));
    ((avail as f64) * MEMORY_FRACTION) as usize
}

pub fn plan_budget(body: &Value) -> usize {
    plan_budget_for(body, DEFAULT_WINDOW_TOKENS, CHARS_PER_TOKEN)
}

// ---------- rank, trim, compose ----------

/// One memory headed for the prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub layer: String,
    pub text: String,
    pub pinned: bool,
}

/// Pinned first. A **stable** sort — `sort_by_key` is stable too, so this is observably identical
/// to the `sort_by` it replaced — so everything else keeps the order `recall_scoped` produced,
/// which is already relevance band, then recency, then distillation level.
///
/// Pinned means *retention and eligibility*, not truth precedence: a stale pin must not outrank a
/// newer correction on relevance, it only guarantees the row survives pruning and a tight budget.
pub fn rank(candidates: &mut [Candidate]) {
    candidates.sort_by_key(|c| std::cmp::Reverse(c.pinned));
}

/// Greedy fill in rank order. Pinned rows are always taken — the review's point was that a single
/// short pinned atom ("this repo uses X, never do Y") is exactly what must survive a tight budget,
/// and a blanket floor dropped it. Everything else competes for what is left.
///
/// Items are dropped whole rather than split mid-sentence; only the text is clipped, and only to
/// `MAX_ITEM_CHARS`.
pub fn trim<'a>(candidates: &'a [Candidate], budget: usize) -> Vec<&'a Candidate> {
    let cost = |c: &Candidate| estimate_tokens(&c.text) + BULLET_OVERHEAD_TOKENS;
    let mut used = 0usize;
    let mut out: Vec<&'a Candidate> = Vec::new();
    for c in candidates {
        let t = cost(c);
        if c.pinned {
            used = used.saturating_add(t);
            out.push(c);
            continue;
        }
        if used + t <= budget {
            used += t;
            out.push(c);
        }
    }
    out
}

/// Vendor-neutral block. Plain prose, no tool markup, no dialect-specific syntax — structured enough
/// to be ignorable, plain enough that no provider chokes on it.
pub fn compose_block(items: &[&Candidate]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut s = String::from("<memory>\n");
    for c in items {
        let flat: String = c.text.chars().take(MAX_ITEM_CHARS).collect();
        s.push_str("- ");
        s.push_str(&flat.replace('\n', " "));
        s.push('\n');
    }
    s.push_str("</memory>\n");
    s
}

/// Live context block: what the agent has open and the last thing that was said.
///
/// Deliberately a separate block from memory. The two have different provenance and different
/// retention — an operator reviews atoms, session turns expire on their own — and an agent can tell
/// "this is a fact I told you" from "this is what we were just doing".
pub fn compose_context_block(
    open_files: &[String],
    turns: &[crate::core::gateway::session_context::Turn],
) -> String {
    if open_files.is_empty() && turns.is_empty() {
        return String::new();
    }
    let mut s = String::from("<context>\n");
    if !open_files.is_empty() {
        let list: String = open_files.join(", ").chars().take(MAX_ITEM_CHARS).collect();
        s.push_str("open files: ");
        s.push_str(&list);
        s.push('\n');
    }
    for t in turns {
        let flat: String = t.text.chars().take(MAX_ITEM_CHARS).collect();
        s.push_str("- ");
        s.push_str(t.role.as_str());
        s.push_str(": ");
        s.push_str(&flat.replace('\n', " "));
        s.push('\n');
    }
    s.push_str("</context>\n");
    s
}

/// The last user turn, used as the recall query. Coding-agent prompts are "run it again" / "fix the
/// failing test", so this is a weak query — the design calls for extracting identifiers and paths
/// from it (§5.2) before BM25 sees it. That extraction is Phase 2b; the raw tail is the floor.
pub fn recall_query(body: &Value) -> String {
    let Some(ms) = body.get("messages").and_then(Value::as_array) else {
        return String::new();
    };
    ms.iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|m| m.get("content").and_then(Value::as_str))
        .unwrap_or("")
        .chars()
        .take(MAX_QUERY_CHARS)
        .collect()
}

const MAX_QUERY_CHARS: usize = 500;

/// Prepend the block as a system message. Inserted at position 0 rather than merged into an existing
/// system message: merging would put gateway-owned text inside a message the client believes it
/// controls.
pub fn prepend_system_message(body: &mut Value, block: &str) -> bool {
    let Some(ms) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return false;
    };
    ms.insert(0, json!({ "role": "system", "content": block }));
    true
}

#[cfg(test)]
mod context_scope_tests {
    use super::*;
    use axum::response::IntoResponse;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // `'static` because `HeaderMap::insert` only accepts `&'static str` keys; every caller passes
    // literals, which are promoted.
    fn hdr(pairs: &'static [(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn headers_win_over_the_body_fallback() {
        let h = hdr(&[("aip-project", "from-header")]);
        let body = json!({"metadata": {"aip": {"project": "from-body"}}});
        let meta = RequestMeta::parse(&h, &body);
        assert_eq!(meta.project.as_deref(), Some("from-header"));
        assert!(meta.explicit);
    }

    #[test]
    fn the_body_fallback_is_used_when_no_headers_arrive() {
        let h = HeaderMap::new();
        let body =
            json!({"metadata": {"aip": {"project": "ai-provider-router", "agent": "cursor"}}});
        let meta = RequestMeta::parse(&h, &body);
        assert_eq!(meta.project.as_deref(), Some("ai-provider-router"));
        assert_eq!(meta.agent.as_deref(), Some("cursor"));
        assert!(meta.explicit);
    }

    #[test]
    fn a_client_with_no_contract_is_not_treated_as_opting_in() {
        let meta = RequestMeta::parse(&HeaderMap::new(), &json!({"model": "m", "messages": []}));
        assert!(!meta.explicit);
        assert_eq!(meta.project, None);
    }

    #[test]
    fn an_unrecognised_mode_is_ignored_rather_than_guessed() {
        let h = hdr(&[("aip-memory", "sometimes")]);
        assert_eq!(RequestMeta::parse(&h, &json!({})).mode, None);
        assert_eq!(
            RequestMeta::parse(&hdr(&[("aip-memory", "READ")]), &json!({})).mode,
            Some(MemoryMode::Read)
        );
    }

    #[test]
    fn a_client_budget_is_clamped_to_the_gateway_ceiling() {
        let h = hdr(&[("aip-memory-budget", "900000")]);
        assert_eq!(RequestMeta::parse(&h, &json!({})).budget, Some(MAX_BUDGET_TOKENS));
        assert_eq!(
            RequestMeta::parse(&hdr(&[("aip-memory-budget", "0")]), &json!({})).budget,
            None
        );
    }

    #[test]
    fn metadata_aip_is_stripped_and_other_metadata_survives() {
        let mut body =
            json!({"model": "m", "metadata": {"aip": {"project": "p"}, "trace_id": "t1"}});
        assert!(strip_aip_metadata(&mut body));
        let md = body.get("metadata").unwrap();
        assert!(md.get("aip").is_none(), "the invented field never reaches a vendor");
        assert_eq!(md.get("trace_id").unwrap().as_str(), Some("t1"));
    }

    #[test]
    fn an_emptied_metadata_object_is_removed_entirely() {
        let mut body = json!({"model": "m", "metadata": {"aip": {"project": "p"}}});
        strip_aip_metadata(&mut body);
        assert!(body.get("metadata").is_none());
    }

    #[test]
    fn stripping_a_body_without_metadata_is_a_no_op() {
        let mut body = json!({"model": "m", "messages": []});
        assert!(!strip_aip_metadata(&mut body));
        assert_eq!(body, json!({"model": "m", "messages": []}));
    }

    #[test]
    fn an_unresolved_project_is_not_global() {
        let meta = RequestMeta::parse(&HeaderMap::new(), &json!({"messages": []}));
        let scope = meta.resolve(&json!({}), None);
        assert_eq!(scope.project, None);
        assert!(!scope.can_read_project_memory());
    }

    #[test]
    fn a_session_alone_does_not_open_project_memory() {
        let meta = RequestMeta::parse(&hdr(&[("aip-session", "s-1")]), &json!({}));
        let scope = meta.resolve(&json!({}), None);
        assert!(scope.session.is_some());
        assert!(!scope.can_read_project_memory(), "a session is not a project boundary");
    }

    #[test]
    fn the_workspace_root_supplies_a_stable_hashed_project() {
        let meta = RequestMeta::parse(&HeaderMap::new(), &json!({}));
        let a = meta.resolve(&json!({}), Some("/Users/t/dev/alpha")).project.unwrap();
        let b = meta.resolve(&json!({}), Some("/Users/t/dev/alpha")).project.unwrap();
        let c = meta.resolve(&json!({}), Some("/Users/t/dev/beta")).project.unwrap();
        assert_eq!(a, b, "the same root always yields the same key");
        assert_ne!(a, c, "two roots never share a scope");
    }

    #[test]
    fn agent_falls_back_to_the_requests_user_field() {
        let meta = RequestMeta::parse(&HeaderMap::new(), &json!({"user": "cursor"}));
        let scope = meta.resolve(&json!({"user": "cursor"}), None);
        assert_eq!(scope.agent.as_deref(), Some("cursor"));
    }

    fn cand(id: &str, text: &str, pinned: bool) -> Candidate {
        Candidate { id: id.into(), layer: "L1".into(), text: text.into(), pinned }
    }

    #[test]
    fn the_token_estimator_over_estimates() {
        // Over-estimating is the safe direction: it under-injects rather than overflowing.
        assert_eq!(estimate_tokens(&"x".repeat(35)), 10);
        assert!(estimate_tokens("hello world") >= 3);
    }

    #[test]
    fn pinned_ranks_first_and_the_rest_keep_their_order() {
        let mut v =
            vec![cand("a", "first", false), cand("p", "pinned", true), cand("b", "second", false)];
        rank(&mut v);
        assert_eq!(v[0].id, "p");
        assert_eq!(v[1].id, "a", "a stable sort preserves recall order for the unpinned");
        assert_eq!(v[2].id, "b");
    }

    /// The review's point: a short pinned atom is exactly what must survive a tight budget, and the
    /// original blanket floor dropped it.
    #[test]
    fn pinned_survives_a_budget_that_fits_nothing_else() {
        let v = vec![
            cand("big", &"x".repeat(4000), false),
            cand("p", "never run migrations by hand", true),
        ];
        let got = trim(&v, 8);
        let ids: Vec<&str> = got.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["p"]);
    }

    #[test]
    fn unpinned_items_stop_at_the_budget() {
        let v = vec![
            cand("a", &"x".repeat(70), false),
            cand("b", &"y".repeat(70), false),
            cand("c", &"z".repeat(70), false),
        ];
        // ~20 tokens each + 8 overhead, so a 40-token budget fits one.
        let got = trim(&v, 40);
        assert_eq!(got.len(), 1, "greedy fill stops rather than overflowing: {}", got.len());
    }

    #[test]
    fn the_composed_block_is_delimited_and_bulleted() {
        let v = [cand("a", "uses Postgres", false)];
        let refs: Vec<&Candidate> = v.iter().collect();
        let block = compose_block(&refs);
        assert!(block.starts_with("<memory>\n"));
        assert!(block.contains("- uses Postgres"));
        assert!(block.ends_with("</memory>\n"));
        assert_eq!(compose_block(&[]), "");
    }

    #[test]
    fn an_overlong_memory_is_clipped_not_dropped() {
        let v = [cand("a", &"x".repeat(900), false)];
        let refs: Vec<&Candidate> = v.iter().collect();
        let block = compose_block(&refs);
        assert!(block.len() < 400, "clipped to MAX_ITEM_CHARS: {}", block.len());
    }

    #[test]
    fn the_recall_query_is_the_last_user_turn() {
        let body = json!({"messages": [
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "an answer"},
            {"role": "user", "content": "now fix the failing test"}
        ]});
        assert_eq!(recall_query(&body), "now fix the failing test");
    }

    #[test]
    fn the_block_is_prepended_rather_than_merged_into_a_client_system_message() {
        let mut body = json!({"messages": [{"role": "system", "content": "you are helpful"}]});
        assert!(prepend_system_message(&mut body, "<memory>\n- x\n</memory>\n"));
        let ms = body["messages"].as_array().unwrap();
        assert_eq!(ms.len(), 2);
        assert_eq!(ms[0]["content"], "<memory>\n- x\n</memory>\n");
        assert_eq!(
            ms[1]["content"], "you are helpful",
            "the client's own system text is untouched"
        );
    }

    #[test]
    fn a_declared_max_tokens_reserve_shrinks_the_budget() {
        let tight = json!({"messages": [], "max_tokens": 8000});
        let loose = json!({"messages": [], "max_tokens": 16});
        assert!(
            plan_budget(&tight) < plan_budget(&loose),
            "a big output reservation leaves less room"
        );
    }

    #[test]
    fn a_larger_client_prompt_leaves_less_room_for_memory() {
        let small = json!({"messages": [{"role": "user", "content": "hi"}]});
        let big = json!({"messages": [{"role": "user", "content": "x".repeat(20000)}]});
        assert!(plan_budget(&big) < plan_budget(&small));
    }

    #[test]
    fn modes_gate_read_and_write_independently() {
        assert!(MemoryMode::On.allows_read() && MemoryMode::On.allows_write());
        assert!(MemoryMode::Read.allows_read() && !MemoryMode::Read.allows_write());
        assert!(!MemoryMode::Write.allows_read() && MemoryMode::Write.allows_write());
        assert!(!MemoryMode::Off.allows_read() && !MemoryMode::Off.allows_write());
    }

    /// `write` asks for the capture half only, so there is nothing to read back. It used to be
    /// reported as `client_off`, which reads as "this app turned memory off" — measured live, that
    /// sent an operator hunting for a client that had opted out when one had merely declined recall.
    #[test]
    fn write_only_is_reported_as_such_not_as_the_client_opting_out() {
        let core = core();
        core.set_memory_enabled(true);
        let mut body = json!({"model": "m", "messages": [{"role": "user", "content": "hi"}]});
        let out = inject_context(&core, &hdr(&[("aip-memory", "write")]), None, &mut body);
        assert!(!out.injected, "capture-only injects nothing");
        assert_eq!(out.reason, SkipReason::WriteOnly);
        assert_eq!(out.status_value(), "injected=0;reason=write_only");
    }

    /// The distinction the new reason exists for: a real opt-out is still `client_off`.
    #[test]
    fn an_explicit_opt_out_is_still_reported_as_client_off() {
        let core = core();
        core.set_memory_enabled(true);
        let mut body = json!({"model": "m", "messages": [{"role": "user", "content": "hi"}]});
        let out = inject_context(&core, &hdr(&[("aip-memory", "off")]), None, &mut body);
        assert_eq!(out.reason, SkipReason::ClientOff, "opting out is not the same as capture-only");
        assert_eq!(out.status_value(), "injected=0;reason=client_off");
    }

    // ---------- response contract ----------

    struct NoopBridge;
    impl crate::core::gateway::Bridge for NoopBridge {
        fn dispatch(&self, _req: crate::core::gateway::BridgeRequest) {}
        fn cancel(&self, _request_id: u64) {}
    }

    /// A core with no store and no workspace root: the default state, and the state the
    /// off-by-default guarantee has to hold in.
    fn core() -> GatewayCore {
        GatewayCore::new(std::sync::Arc::new(NoopBridge), std::sync::Arc::new(|| Some("k".into())))
    }

    /// The ship-blocking acceptance from design §9: with memory off, behaviour is byte-identical to
    /// a gateway without this feature. The only permitted difference is the strip of `metadata.aip`,
    /// which is a field the gateway itself invented.
    #[test]
    fn with_the_toggle_off_the_body_is_byte_identical() {
        let core = core();
        let mut body = json!({"model": "m", "messages": [{"role": "user", "content": "hi"}]});
        let before = body.clone();
        let out = inject_context(&core, &HeaderMap::new(), None, &mut body);
        assert!(!out.injected);
        assert_eq!(out.reason, SkipReason::Disabled);
        assert_eq!(body, before);
    }

    /// Reported on a skip too, not only on success: "why didn't the model know X" is usually "the
    /// scope resolved to something you did not expect", which is invisible if the header only ever
    /// appears alongside an injection.
    ///
    /// A fresh `GatewayCore` already has `default_workspace_root()` set, so project is never empty
    /// here. The test only asserts shape, not exact values, because the default root is environment-
    /// dependent.
    #[test]
    fn the_scope_is_reported_when_nothing_was_injected() {
        let core = core();
        let mut body = json!({"model": "m", "messages": []});
        let out = inject_context(&core, &HeaderMap::new(), None, &mut body);
        assert!(out.scope.starts_with("user=local;"), "user dimension is always present");
        assert!(out.scope.contains("project="), "project dimension is present even when defaulted");
        assert!(out.scope.contains("agent="), "agent dimension is present even when unset");
        assert_eq!(out.status_value(), "injected=0;reason=disabled");
    }

    #[test]
    fn a_resolved_scope_renders_all_three_dimensions() {
        let h = hdr(&[("aip-project", "ai-provider-router"), ("aip-agent", "cursor")]);
        let meta = RequestMeta::parse(&h, &json!({}));
        let scope = meta.resolve(&json!({}), None);
        assert_eq!(scope.as_header_value(), "user=local;project=ai-provider-router;agent=cursor");
    }

    /// `agent` falls back to a client's `user` field, which is untrusted input. A newline there is
    /// header injection, so it must be dropped rather than allowed to reach the wire.
    #[test]
    fn an_agent_name_with_control_characters_cannot_inject_a_header() {
        let scope = Scope {
            user: "local".into(),
            project: Some("p1".into()),
            agent: Some("cursor\r\nAIP-Memory: injected=1".into()),
            session: None,
        };
        let v = scope.as_header_value();
        assert!(!v.contains('\r') && !v.contains('\n'));
        assert!(
            axum::http::HeaderValue::from_str(&v).is_ok(),
            "the sanitised value is always legal"
        );
    }

    #[test]
    fn the_status_header_reports_what_was_injected() {
        let out = InjectionOutcome {
            injected: true,
            reason: SkipReason::Injected,
            items: 7,
            context: 0,
            tokens: 412,
            scope: "user=local;project=p1;agent=cursor".into(),
        };
        assert_eq!(out.status_value(), "injected=1;items=7;tokens=412");

        let with_ctx = InjectionOutcome { context: 3, ..out.clone() };
        assert_eq!(with_ctx.status_value(), "injected=1;items=7;tokens=412;ctx=3");
    }

    #[test]
    fn both_headers_land_on_a_finished_response() {
        let out = InjectionOutcome {
            injected: false,
            reason: SkipReason::BelowFloor,
            items: 0,
            context: 0,
            tokens: 0,
            scope: "user=local;project=p1;agent=-".into(),
        };
        let mut r = axum::Json(json!({"ok": true})).into_response();
        apply_memory_headers(&mut r, &out);
        let h = r.headers();
        assert_eq!(h.get(HDR_MEMORY).unwrap(), "injected=0;reason=below_floor");
        assert_eq!(h.get(HDR_MEMORY_SCOPE).unwrap(), "user=local;project=p1;agent=-");
    }

    /// The read path end to end, with the toggle actually on and a row actually in the table.
    /// Everything above exercises one stage in isolation, or the guaranteed-off case; this is the
    /// only test that proves a block reaches the body.
    ///
    /// It also pins the reason the pipeline was dry: the atom has to be scoped on purpose first.
    /// An unscoped capture is invisible to every scope, so seeding without `assign_scope` would
    /// silently produce a passing-looking "no candidates" instead of a real injection.
    #[test]
    fn a_scoped_memory_reaches_the_body_when_the_toggle_is_on() {
        let dir = std::env::temp_dir().join(format!("aip-inject-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = crate::core::store::Store::open(&dir).unwrap();

        // The core resolves `project` from the workspace root, so the row has to be bound to the
        // hash of that same root to be visible.
        let root = crate::core::gateway::default_workspace_root().unwrap();
        let project = project_key_from_root(&root.to_string_lossy()).unwrap();

        let m = crate::core::memory::capture(
            &store,
            &crate::core::memory::MemoryInput {
                layer: "L1".into(),
                text: "this project uses Postgres for the database".into(),
                session_id: None,
                subject: None,
                pinned: false,
            },
        )
        .unwrap();
        assert!(crate::core::memory::assign_scope(
            &store,
            &m.id,
            crate::core::memory::ScopeAssignment::Project { project: project.clone(), agent: None },
        )
        .unwrap());

        let core = core().with_store(std::sync::Arc::new(store));
        core.set_memory_enabled(true);

        let mut body = json!({"model": "m", "messages": [
            {"role": "user", "content": "what database does this project use"}
        ]});
        let out = inject_context(&core, &HeaderMap::new(), None, &mut body);

        assert!(out.injected, "expected an injection, got {}", out.status_value());
        assert!(out.items >= 1);
        let ms = body["messages"].as_array().unwrap();
        assert_eq!(ms[0]["role"], "system", "the block is prepended, not merged");
        let block = ms[0]["content"].as_str().unwrap();
        assert!(block.starts_with("<memory>"), "block: {block}");
        assert!(block.contains("Postgres"), "the recalled atom is in the block: {block}");
        assert!(out.scope.contains(&format!("project={project}")), "scope: {}", out.scope);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The counterpart to the test above: the same setup with an **unscoped** atom must inject
    /// nothing. This is what makes the previous test meaningful rather than tautological.
    #[test]
    fn an_unscoped_memory_is_not_injected_even_with_the_toggle_on() {
        let dir = std::env::temp_dir().join(format!("aip-inject-unscoped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = crate::core::store::Store::open(&dir).unwrap();

        crate::core::memory::capture(
            &store,
            &crate::core::memory::MemoryInput {
                layer: "L1".into(),
                text: "this project uses Postgres for the database".into(),
                session_id: None,
                subject: None,
                pinned: false,
            },
        )
        .unwrap();

        let core = core().with_store(std::sync::Arc::new(store));
        core.set_memory_enabled(true);

        let mut body = json!({"model": "m", "messages": [
            {"role": "user", "content": "what database does this project use"}
        ]});
        let out = inject_context(&core, &HeaderMap::new(), None, &mut body);

        assert!(!out.injected);
        assert_eq!(out.reason, SkipReason::NoCandidates);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1, "no system message was added");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §3.4, on the request path: the same request must behave differently once the model's real
    /// window is known. Against a prompt most of the way through an 8k window there is nothing left
    /// to spend, so memory is dropped entirely; against the window that same model actually has,
    /// there is. This is the defect the cache exists to fix, so the test asserts the before and the
    /// after in one place rather than trusting the arithmetic.
    #[test]
    fn a_known_window_lets_a_large_prompt_still_carry_memory() {
        let dir = std::env::temp_dir().join(format!("aip-window-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
        let root = crate::core::gateway::default_workspace_root().unwrap();
        let project = project_key_from_root(&root.to_string_lossy()).unwrap();
        let m = crate::core::memory::capture(
            &store,
            &crate::core::memory::MemoryInput {
                layer: "L1".into(),
                text: "this project uses Postgres for the database".into(),
                session_id: None,
                subject: None,
                pinned: false,
            },
        )
        .unwrap();
        crate::core::memory::assign_scope(
            &store,
            &m.id,
            crate::core::memory::ScopeAssignment::Project { project, agent: None },
        )
        .unwrap();

        let core = core().with_store(store.clone());
        core.set_memory_enabled(true);

        // ~8.6k tokens of prompt: more than an 8k window minus its output reserve. The real question
        // is a separate trailing turn because recall reads the last user turn — padding the question
        // itself would make BM25 search for "word word word" and find nothing.
        let fat = "word ".repeat(6_000);
        let body = || {
            json!({"model": "openrouter/gpt-4o", "messages": [
                {"role": "user", "content": fat},
                {"role": "user", "content": "what database does this project use"}
            ]})
        };

        // Before: the host has no window for this model, plans against 8192, and finds no room.
        let mut before = body();
        let out = inject_context(&core, &HeaderMap::new(), None, &mut before);
        assert!(
            !out.injected,
            "with no known window, an 8.6k prompt leaves nothing: {}",
            out.status_value()
        );

        // After: the catalog publishes the real window and the same request gets memory.
        let n = crate::core::gateway::model_context::upsert(
            &store,
            &[crate::core::gateway::model_context::ModelContextInput {
                model_key: "openrouter/gpt-4o".into(),
                context_window: 200_000,
                chars_per_token: None,
            }],
        )
        .unwrap();
        assert_eq!(n, 1);

        let mut after = body();
        let out = inject_context(&core, &HeaderMap::new(), None, &mut after);
        assert!(out.injected, "{}", out.status_value());
        assert!(out.items >= 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4a, on the request path rather than in the policy module alone: one principal's refusal must
    /// not become everybody's, the client must not be able to override the operator, and the reason
    /// has to be distinguishable from "memory is off" in the response header.
    #[test]
    fn a_principal_denied_memory_is_refused_even_when_it_asks_for_it() {
        let dir = std::env::temp_dir().join(format!("aip-principal-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
        let root = crate::core::gateway::default_workspace_root().unwrap();
        let project = project_key_from_root(&root.to_string_lossy()).unwrap();
        let m = crate::core::memory::capture(
            &store,
            &crate::core::memory::MemoryInput {
                layer: "L1".into(),
                text: "this project uses Postgres for the database".into(),
                session_id: None,
                subject: None,
                pinned: false,
            },
        )
        .unwrap();
        crate::core::memory::assign_scope(
            &store,
            &m.id,
            crate::core::memory::ScopeAssignment::Project { project, agent: None },
        )
        .unwrap();

        let core = core().with_store(store.clone());
        core.set_memory_enabled(true);

        let body = || {
            json!({"model": "m", "messages": [
                {"role": "user", "content": "what database does this project use"}
            ]})
        };

        // Plain `inject_context`: this test is about per-principal policy, not about the clock.
        // `MEMORY_DEADLINE` is widened under `cfg(test)` so the production budget cannot turn this
        // into a flake — see the constant.
        // Before any policy: both principals are treated as inheriting, so both inject.
        let mut ok = body();
        let out = inject_context(&core, &hdr(&[("aip-agent", "cursor")]), None, &mut ok);
        assert!(out.injected, "no row means inherit: {}", out.status_value());

        assert!(crate::core::gateway::principal::set(&store, "cursor", false).unwrap());

        // The denied principal is refused, and says why — not "disabled", which would send the
        // operator hunting for a master switch that is on.
        let mut denied = body();
        let out = inject_context(&core, &hdr(&[("aip-agent", "cursor")]), None, &mut denied);
        assert!(!out.injected);
        assert_eq!(out.reason, SkipReason::PrincipalOff);

        // And it stays refused when the client explicitly asks: the client is not the authority.
        let mut asked = body();
        let out = inject_context(
            &core,
            &hdr(&[("aip-agent", "cursor"), ("aip-memory", "on")]),
            None,
            &mut asked,
        );
        assert!(!out.injected, "a client cannot switch on what the operator switched off");
        assert_eq!(out.reason, SkipReason::PrincipalOff);

        // One refusal is not a global one.
        let mut other = body();
        let out = inject_context(&core, &hdr(&[("aip-agent", "zed")]), None, &mut other);
        assert!(out.injected, "{}", out.status_value());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §4a app-key principal fixtures: memory on, one recallable memory, and a set of app keys
    /// behind a provider that behaves like the vault-backed one (counts calls, honours `gateway_keys`).
    fn keyed_core(
        tag: &str,
        keys: &'static [(&'static str, &'static str)],
    ) -> (GatewayCore, Arc<crate::core::store::Store>, Arc<AtomicUsize>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-ctx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
        let root = crate::core::gateway::default_workspace_root().unwrap();
        let project = project_key_from_root(&root.to_string_lossy()).unwrap();
        let m = crate::core::memory::capture(
            &store,
            &crate::core::memory::MemoryInput {
                layer: "L1".into(),
                text: "this project uses Postgres for the database".into(),
                session_id: None,
                subject: None,
                pinned: false,
            },
        )
        .unwrap();
        crate::core::memory::assign_scope(
            &store,
            &m.id,
            crate::core::memory::ScopeAssignment::Project { project, agent: None },
        )
        .unwrap();

        let reads = Arc::new(AtomicUsize::new(0));
        let (r, s2) = (reads.clone(), store.clone());
        let all: Vec<crate::core::gateway::AppKey> = keys
            .iter()
            .map(|(id, sec)| crate::core::gateway::AppKey {
                id: (*id).into(),
                secret: (*sec).into(),
            })
            .collect();
        let core = core().with_store(store.clone()).with_app_keys(Arc::new(move || {
            r.fetch_add(1, Ordering::SeqCst);
            let active = crate::core::persist::active_gateway_key_ids(&s2).unwrap_or_default();
            all.iter().filter(|k| active.contains(&k.id)).cloned().collect()
        }));
        core.set_memory_enabled(true);
        (core, store, reads, dir)
    }

    /// Off by default has to mean no extra work, and resolving an app-key principal means reading
    /// the app-key map. With memory off that read must not happen at all.
    #[test]
    fn a_disabled_layer_does_not_read_the_app_key_map() {
        let (core, _store, reads, dir) = keyed_core("offkeys", &[("ak-1", "sk-aip-app1")]);
        core.set_memory_enabled(false);
        let mut body = json!({"model": "m", "messages": [
            {"role": "user", "content": "what database does this project use"}
        ]});
        let out = inject_context(
            &core,
            &hdr(&[("authorization", "Bearer sk-aip-app1")]),
            None,
            &mut body,
        );
        assert!(!out.injected);
        assert_eq!(out.reason, SkipReason::Disabled);
        assert_eq!(reads.load(Ordering::SeqCst), 0, "off must not cost a keychain read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The case the app-key principal exists for: a client that presents a key and sends no
    /// `AIP-Agent` label. Until the key is resolved it has no name at all, so no operator policy
    /// can reach it.
    #[test]
    fn a_client_with_only_a_key_is_governed_by_a_policy_on_that_key() {
        let (core, store, _reads, dir) =
            keyed_core("keyonly", &[("ak-1", "sk-aip-app1"), ("ak-2", "sk-aip-app2")]);
        crate::core::persist::gateway_key_insert(&store, "ak-1", "an unnamed ide").unwrap();
        crate::core::persist::gateway_key_insert(&store, "ak-2", "another ide").unwrap();
        let body = || {
            json!({"model": "m", "messages": [
                {"role": "user", "content": "what database does this project use"}
            ]})
        };

        // No label, no policy: both identities are absent, so this inherits.
        let mut ok = body();
        let out =
            inject_context(&core, &hdr(&[("authorization", "Bearer sk-aip-app1")]), None, &mut ok);
        assert!(out.injected, "no row means inherit: {}", out.status_value());

        // Denied by key — the whole feature. Without the resolved id this client is unnameable.
        let key1 = crate::core::gateway::principal::key_principal("ak-1");
        assert!(crate::core::gateway::principal::set(&store, &key1, false).unwrap());
        let mut denied = body();
        let out = inject_context(
            &core,
            &hdr(&[("authorization", "Bearer sk-aip-app1")]),
            None,
            &mut denied,
        );
        assert!(!out.injected);
        assert_eq!(out.reason, SkipReason::PrincipalOff);

        // A different key is untouched — one refusal is not a global one.
        let mut other = body();
        let out = inject_context(
            &core,
            &hdr(&[("authorization", "Bearer sk-aip-app2")]),
            None,
            &mut other,
        );
        assert!(out.injected, "{}", out.status_value());

        // And a secret we do not recognise names nobody, so no row can reach it and it inherits.
        // This core's master key is "k", so this bearer is simply unknown — it is *not* the master
        // key. Calling it "sk-aip-master" here used to imply otherwise, which made the assertion
        // pass for a reason that had nothing to do with the master key. The master key's own
        // identity is covered by `the_master_key_is_governable_by_a_policy_on_its_own_name`.
        let mut unknown = body();
        let out = inject_context(
            &core,
            &hdr(&[("authorization", "Bearer sk-aip-unknown")]),
            None,
            &mut unknown,
        );
        assert!(out.injected, "an unnameable caller inherits: {}", out.status_value());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reason there are two identities rather than one winner: a client holding a denied key
    /// must not get memory back by attaching an unlisted label to the same request.
    #[test]
    fn an_unlisted_label_does_not_rescue_a_denied_key() {
        let (core, store, _reads, dir) = keyed_core("rescue", &[("ak-1", "sk-aip-app1")]);
        crate::core::persist::gateway_key_insert(&store, "ak-1", "cursor").unwrap();
        let key1 = crate::core::gateway::principal::key_principal("ak-1");
        assert!(crate::core::gateway::principal::set(&store, &key1, false).unwrap());
        let mut body = json!({"model": "m", "messages": [
            {"role": "user", "content": "what database does this project use"}
        ]});
        // The key is denied; the label "cursor" has no row and would inherit on its own.
        let out = inject_context(
            &core,
            &hdr(&[("authorization", "Bearer sk-aip-app1"), ("aip-agent", "cursor")]),
            None,
            &mut body,
        );
        assert!(!out.injected, "either identity may deny");
        assert_eq!(out.reason, SkipReason::PrincipalOff);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The master key is the caller most operators actually hand out, so it has to be governable.
    /// Before it had a name, traffic presenting it with no `AIP-Agent` label had no identity at all
    /// — and absence inherits, so an operator who had disabled every other caller would still have
    /// been serving memory to it.
    #[test]
    fn the_master_key_is_governable_by_a_policy_on_its_own_name() {
        let (core, store, _reads, dir) = keyed_core("masterkey", &[("ak-1", "sk-aip-app1")]);
        crate::core::persist::gateway_key_insert(&store, "ak-1", "an ide").unwrap();
        let body = || {
            json!({"model": "m", "messages": [
                {"role": "user", "content": "what database does this project use"}
            ]})
        };
        // This core's master key is "k" — see `core()`.
        let master = hdr(&[("authorization", "Bearer k")]);

        let mut before = body();
        let out = inject_context(&core, &master, None, &mut before);
        assert!(out.injected, "no row means inherit: {}", out.status_value());

        let mk = crate::core::gateway::principal::master_principal();
        assert!(crate::core::gateway::principal::set(&store, &mk, false).unwrap());
        let mut denied = body();
        let out = inject_context(&core, &master, None, &mut denied);
        assert!(!out.injected, "the master key can be denied");
        assert_eq!(out.reason, SkipReason::PrincipalOff);

        // One refusal is not a global one: an app key is untouched.
        let mut app = body();
        let out =
            inject_context(&core, &hdr(&[("authorization", "Bearer sk-aip-app1")]), None, &mut app);
        assert!(out.injected, "{}", out.status_value());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other half of "a denied principal is denied": the write path. A caller denied memory
    /// must not have its turns recorded either — otherwise "off" would still mean quietly learning
    /// from it, which is the thing the policy exists to prevent.
    #[test]
    fn a_denied_master_key_is_denied_on_the_write_path_too() {
        let (core, store, _reads, dir) = keyed_core("masterwrite", &[("ak-1", "sk-aip-app1")]);
        crate::core::persist::gateway_key_insert(&store, "ak-1", "an ide").unwrap();
        let body = json!({"model": "m", "messages": [
            {"role": "user", "content": "remember that this project uses Postgres"}
        ]});
        let master = hdr(&[("authorization", "Bearer k")]);

        let before = prepare_capture(&core, &master, &body, 1).unwrap();
        assert!(before.writes_allowed, "no row means inherit");

        let mk = crate::core::gateway::principal::master_principal();
        assert!(crate::core::gateway::principal::set(&store, &mk, false).unwrap());
        let after = prepare_capture(&core, &master, &body, 2).unwrap();
        assert!(!after.writes_allowed, "a denied principal must not be learned from");

        // And an app key is untouched.
        let other =
            prepare_capture(&core, &hdr(&[("authorization", "Bearer sk-aip-app1")]), &body, 3)
                .unwrap();
        assert!(other.writes_allowed, "one refusal is not a global one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn store_core(tag: &str) -> (GatewayCore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-ctx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
        let core = core().with_store(store);
        core.set_memory_enabled(true);
        (core, dir)
    }

    /// Phase 3's acceptance: a second request in the same session carries the previous turn, and
    /// does **not** repeat the turn the client just sent itself (§5.4).
    #[test]
    fn live_context_from_a_previous_request_reaches_the_body() {
        let (core, dir) = store_core("carry");

        let mut first =
            json!({"model": "m", "messages": [{"role": "user", "content": "hello there"}]});
        let out1 = inject_context(&core, &HeaderMap::new(), None, &mut first);
        assert!(!out1.injected, "the first request has no prior context: {}", out1.status_value());

        let mut second = json!({"model": "m", "messages": [{"role": "user", "content": "now fix the failing test"}]});
        let out2 = inject_context(&core, &HeaderMap::new(), None, &mut second);
        assert!(out2.injected, "{}", out2.status_value());

        let block = second["messages"][0]["content"].as_str().unwrap();
        assert!(block.contains("<context>"), "block: {block}");
        assert!(block.contains("hello there"), "the earlier turn is carried forward: {block}");
        assert!(
            !block.contains("now fix the failing test"),
            "the turn the client just sent is not echoed back at it: {block}"
        );
        assert_eq!(out2.context, 1);
        assert_eq!(out2.items, 0, "no memories were seeded, so this is context alone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The push half of the contract: an agent that cannot set scope can still say what it has open,
    /// and that survives to the next request.
    #[test]
    fn open_files_pushed_by_the_agent_reach_the_next_request() {
        let (core, dir) = store_core("files");
        let h = hdr(&[("aip-open-files", "src/main.rs, src/lib.rs")]);

        let mut first =
            json!({"model": "m", "messages": [{"role": "user", "content": "look at this"}]});
        inject_context(&core, &h, None, &mut first);

        let mut second =
            json!({"model": "m", "messages": [{"role": "user", "content": "and now this"}]});
        let out = inject_context(&core, &HeaderMap::new(), None, &mut second);
        assert!(out.injected, "{}", out.status_value());
        let block = second["messages"][0]["content"].as_str().unwrap();
        assert!(block.contains("open files: src/main.rs, src/lib.rs"), "block: {block}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- §5.6: the hard deadline ----------

    #[test]
    fn a_deadline_that_is_already_gone_misses_and_stays_missed() {
        let mut d = Deadline::new(Duration::ZERO);
        assert!(!d.check("recall"));
        assert!(!d.check("context"), "once missed, no later stage is allowed to start either");
        assert_eq!(d.missed_at(), Some("recall"), "the first miss is the one recorded");
    }

    #[test]
    fn a_generous_deadline_passes_every_stage() {
        let mut d = Deadline::new(Duration::from_secs(30));
        assert!(d.check("recall") && d.check("context") && d.check("prepend"));
        assert_eq!(d.missed_at(), None);
    }

    /// The acceptance for §5.6. Two claims, and the second is the one that is easy to get wrong:
    ///
    ///  1. a request whose memory path cannot finish in time is dispatched without memory — not
    ///     with partial memory, and not after waiting;
    ///  2. the miss is detected *before* live context runs, so the request also leaves nothing
    ///     behind. A deadline that aborts the read but still lets the session writes through
    ///     protects nothing, because the writes are the thing contending for the lock.
    #[test]
    fn a_request_that_misses_its_deadline_is_dispatched_without_memory_and_writes_nothing() {
        let (core, dir) = store_core("deadline");
        let body =
            |text: &str| json!({"model": "m", "messages": [{"role": "user", "content": text}]});

        // Zero budget: the clock is gone before recall can be paid for.
        let mut first = body("hello there");
        let before = first.clone();
        let out =
            inject_context_deadline(&core, &HeaderMap::new(), None, &mut first, Duration::ZERO);
        assert!(!out.injected);
        assert_eq!(out.reason, SkipReason::Deadline);
        assert_eq!(out.status_value(), "injected=0;reason=deadline");
        assert_eq!(first, before, "the request still goes out, exactly as it arrived");

        // Nothing was recorded, so the next request — with a real budget — finds no prior turn.
        // Remove the deadline and this becomes 1, because "hello there" would have been stored.
        let mut second = body("what next");
        let out2 = inject_context_deadline(
            &core,
            &HeaderMap::new(),
            None,
            &mut second,
            Duration::from_secs(30),
        );
        assert_eq!(
            out2.context,
            0,
            "the aborted request recorded nothing: {}",
            out2.status_value()
        );

        // Control: the same machinery with a real budget both injects and records.
        let mut third = body("and then");
        let out3 = inject_context_deadline(
            &core,
            &HeaderMap::new(),
            None,
            &mut third,
            Duration::from_secs(30),
        );
        assert_eq!(out3.context, 1, "{}", out3.status_value());
        let block = third["messages"][0]["content"].as_str().unwrap();
        assert!(block.contains("what next"), "the recorded turn is carried: {block}");
        assert!(!block.contains("hello there"), "the aborted turn never landed: {block}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- §5.5: prompt-cache stability ----------

    /// The `<memory>…</memory>` slice of an injected block.
    ///
    /// Live context is concatenated *after* it and legitimately changes on every request, so
    /// comparing whole system messages would say nothing about whether the memory bytes held still.
    fn memory_part(block: &str) -> String {
        match (block.find("<memory>"), block.find("</memory>")) {
            (Some(s), Some(e)) => block[s..e + "</memory>".len()].to_string(),
            _ => String::new(),
        }
    }

    #[test]
    fn a_frozen_block_that_no_longer_fits_the_budget_is_not_served() {
        let core = core();
        core.freeze_memory("k".into(), "<memory>\n- x\n</memory>\n".into(), 1, 40, true);
        assert!(core.frozen_memory("k", 40).is_some());
        assert!(
            core.frozen_memory("k", 39).is_none(),
            "a tighter budget forces a re-compose; shipping an oversized block is a correctness bug"
        );
        assert!(core.frozen_memory("other", 40).is_none(), "a different scope has its own block");
    }

    /// Expiry, deterministically. A zero TTL means every entry is already expired, so no test has to
    /// sleep ten minutes to prove the clock works.
    #[test]
    fn a_zero_ttl_expires_every_frozen_block_immediately() {
        let core = core();
        core.freeze_memory("k".into(), "<memory>\n- x\n</memory>\n".into(), 1, 1, true);
        assert!(core.frozen_memory("k", 99).is_some(), "the default TTL still serves it");
        core.set_memory_freeze_ttl(Duration::ZERO);
        assert!(core.frozen_memory("k", 99).is_none(), "an expired entry is dropped, not served");
    }

    /// §5.5, the acceptance end to end: a block composed once is served byte-identical for the rest
    /// of its TTL even when the corpus changes underneath it, and stops being served once the TTL
    /// is gone.
    ///
    /// The discriminator is the pinned atom added between the two requests — pinned ranks first, so
    /// absent the freeze the second block would lead with it and the bytes would change. That is
    /// also why this cannot be proved with a single request.
    #[test]
    fn a_frozen_block_is_served_unchanged_until_its_ttl_expires() {
        let dir = std::env::temp_dir().join(format!("aip-freeze-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
        let root = crate::core::gateway::default_workspace_root().unwrap();
        let project = project_key_from_root(&root.to_string_lossy()).unwrap();
        let add = |text: &str, pinned: bool| {
            let m = crate::core::memory::capture(
                &store,
                &crate::core::memory::MemoryInput {
                    layer: "L1".into(),
                    text: text.into(),
                    session_id: None,
                    subject: None,
                    pinned,
                },
            )
            .unwrap();
            crate::core::memory::assign_scope(
                &store,
                &m.id,
                crate::core::memory::ScopeAssignment::Project {
                    project: project.clone(),
                    agent: None,
                },
            )
            .unwrap();
        };
        add("this project uses Postgres for the database", false);

        let core = core().with_store(store.clone());
        core.set_memory_enabled(true);

        // Three different phrasings of the same question. They have to differ: §5.4 drops the turn
        // the client just sent, so a repeated message would carry no live context at all and the
        // "memory is the prefix" assertion below would have nothing to compare against.
        let body = |q: &str| json!({"model": "m", "messages": [{"role": "user", "content": q}]});

        let mut first = body("what database does this project use");
        let out1 = inject_context(&core, &HeaderMap::new(), None, &mut first);
        assert!(out1.injected, "{}", out1.status_value());
        let b1 = first["messages"][0]["content"].as_str().unwrap().to_string();
        let mem1 = memory_part(&b1);
        assert!(mem1.contains("Postgres"), "block: {b1}");

        // A pinned atom that outranks everything already there.
        add("the database is Postgres and never MySQL, hard constraint", true);

        let mut second = body("which database is it again");
        let out2 = inject_context(&core, &HeaderMap::new(), None, &mut second);
        assert!(out2.injected, "{}", out2.status_value());
        let b2 = second["messages"][0]["content"].as_str().unwrap().to_string();
        assert_eq!(mem1, memory_part(&b2), "the frozen block is served byte-identical: {b2}");

        // The stable part has to be the *prefix* — that is the entire premise. A provider caches the
        // longest matching prefix, so memory-before-context is load-bearing, not cosmetic.
        assert!(
            b2.find("<memory>").unwrap() < b2.find("<context>").unwrap(),
            "memory precedes context, so the cached prefix covers it: {b2}"
        );

        // TTL gone: recall runs again and the new atom appears.
        core.set_memory_freeze_ttl(Duration::ZERO);
        let mut third = body("what database should I connect to");
        let out3 = inject_context(&core, &HeaderMap::new(), None, &mut third);
        let b3 = third["messages"][0]["content"].as_str().unwrap().to_string();
        assert_ne!(mem1, memory_part(&b3), "an expired freeze is not served: {b3}");
        assert!(b3.contains("never MySQL"), "the new atom is picked up: {b3}");
        assert!(out3.items > out1.items, "{} vs {}", out3.status_value(), out1.status_value());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §5.5.1 end to end. With the freeze disabled, two identical requests must still produce
    /// byte-identical memory blocks — that is what the deterministic tie-break buys, and it is the
    /// only place the claim is observable, because with the freeze on the bytes are identical by
    /// construction.
    #[test]
    fn two_identical_requests_compose_the_same_memory_block() {
        let dir = std::env::temp_dir().join(format!("aip-sameblock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::core::store::Store::open(&dir).unwrap());
        let root = crate::core::gateway::default_workspace_root().unwrap();
        let project = project_key_from_root(&root.to_string_lossy()).unwrap();
        // Atoms that tie on every ranking key: identical text, same layer, captured in the same run.
        for _ in 0..3 {
            let m = crate::core::memory::capture(
                &store,
                &crate::core::memory::MemoryInput {
                    layer: "L1".into(),
                    text: "the database is postgres".into(),
                    session_id: None,
                    subject: None,
                    pinned: false,
                },
            )
            .unwrap();
            crate::core::memory::assign_scope(
                &store,
                &m.id,
                crate::core::memory::ScopeAssignment::Project {
                    project: project.clone(),
                    agent: None,
                },
            )
            .unwrap();
        }

        let core = core().with_store(store);
        core.set_memory_enabled(true);
        // No freeze: anything stable below comes from determinism and nothing else.
        core.set_memory_freeze_ttl(Duration::ZERO);

        let body = || {
            json!({"model": "m", "messages": [
                {"role": "user", "content": "what database is it"}
            ]})
        };
        let mut a = body();
        inject_context(&core, &HeaderMap::new(), None, &mut a);
        let mut b = body();
        inject_context(&core, &HeaderMap::new(), None, &mut b);
        let ma = memory_part(a["messages"][0]["content"].as_str().unwrap());
        let mb = memory_part(b["messages"][0]["content"].as_str().unwrap());
        assert!(!ma.is_empty(), "something was injected");
        assert_eq!(ma, mb, "identical requests compose identical bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §8 of the design: nothing gateway-invented reaches a provider. `forwarded_headers` builds a
    /// fresh map from a six-entry allowlist, so an `aip-*` name can only ever appear on the way
    /// back out — but the claim is worth pinning now that these headers exist.
    #[test]
    fn no_memory_header_is_in_the_forwarded_set() {
        let mut h = HeaderMap::new();
        h.insert(HDR_MEMORY, "injected=1".parse().unwrap());
        h.insert(HDR_MEMORY_SCOPE, "user=local".parse().unwrap());
        let fwd = crate::core::gateway::forwarded_headers(&h);
        assert!(!fwd.contains_key(HDR_MEMORY));
        assert!(!fwd.contains_key(HDR_MEMORY_SCOPE));
    }
}
