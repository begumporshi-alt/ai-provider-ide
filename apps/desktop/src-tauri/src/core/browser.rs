//! Browser automation over the Chrome DevTools Protocol (2026-10-06).
//!
//! The user launches their own Chrome (or Chromium/Edge) with `--remote-debugging-port=9222`;
//! these tools attach to that browser over CDP and drive the page they already had open. Nothing
//! is spawned and nothing is installed — the tool connects to a browser that is already running,
//! and every error says exactly that when it cannot.
//!
//! # What is here, and what is deliberately not
//!
//! - [`browser_navigate`] / [`browser_snapshot`] / [`browser_click`] / [`browser_fill`] /
//!   [`browser_screenshot`] and [`browser_print`] are the tool surface (`tool_run` dispatches to
//!   them). Snapshot is the hub: it tags the interactive elements with `data-__cdpidx` attributes
//!   and returns a text outline, and click/fill address elements by those indexes — the same shape
//!   browser-use popularised, because the model can only point at what a previous tool result
//!   named.
//! - The connection to the debugger endpoint is kept open across calls in [`CONN`]: a
//!   snapshot-click-fill sequence is three calls against one tab, and re-handshaking per call
//!   would race the page's own navigations. A dead connection (tab closed, Chrome quit) is
//!   dropped on failure, so the next call reconnects instead of caching an error.
//! - There is no JS-injection question here because there is no model-authored JS: every
//!   `Runtime.evaluate` payload below is a constant, or a constant with the model's *text*
//!   interpolated only as a JSON-quoted value argument.
//!
//! # The guard is the loopback rule
//!
//! `core::web` refuses loopback for the *public web* tools; this module is the inverse — it
//! speaks to nothing but `127.0.0.1`. The debugger endpoint is local by definition
//! (`--remote-debugging-port` binds loopback unless overridden), and a non-loopback host here
//! would mean sending page-control commands to some other machine, which is an incident rather
//! than a feature. See [`check_debugger_url`].

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

const DEFAULT_PORT: u16 = 9222;
/// One CDP command, one deadline. A page that does not answer in 15 s is not going to; the model
/// re-snapshots and retries rather than hanging the run.
const CMD_TIMEOUT: Duration = Duration::from_secs(15);
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

// ── the connection ───────────────────────────────────────────────────────────────────────

/// The open page connections, kept across tool calls — one per debugger port, not one global: two
/// browsers (two sessions, two ports) must not steal each other's socket, and a steal is worse
/// than a reconnect because the re-issued `Runtime.enable` makes Chrome replay its buffered
/// console messages, which would resurrect entries the ledger already reported. A tokio mutex,
/// not a std one: the guard is held across the socket awaits and must cross the `block_on`
/// boundary.
static CONNS: OnceLock<tokio::sync::Mutex<std::collections::HashMap<u16, Conn>>> = OnceLock::new();

fn conns_cell() -> &'static tokio::sync::Mutex<std::collections::HashMap<u16, Conn>> {
    CONNS.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The browser runtime, or an early `ToolResult` refusal.
///
/// A macro rather than `?`: these four tools answer a `ToolResult`, not a `Result`, so `?` has
/// nothing to propagate into. A macro rather than a `match` at each call site because that repeated
/// block is exactly what made the original `expect` look like the cheaper option.
macro_rules! rt {
    () => {
        match runtime() {
            Ok(rt) => rt,
            Err(e) => return crate::core::tools::ToolResult::err(e),
        }
    };
}

/// The dedicated multi-thread runtime, the same bridge `core::web` uses: the tool host is
/// synchronous, and blocking on the ambient runtime would panic.
///
/// **Fallible rather than an `expect`.** The init is lazy, so it runs on the *first* browser tool
/// call — that is the request path, not startup — and a panic there would end the process (release
/// builds are `panic = "abort"`) instead of telling the model a thread pool could not be built. The
/// failure is cached alongside the result, so a broken environment is not re-tried per call.
fn runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    static CELL: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    CELL.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| format!("the browser runtime could not start: {e}"))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Conn {
    ws: WsStream,
    next_id: u64,
    port: u16,
}

/// Only `127.0.0.1` — see the module doc. The port is free-text from the tool arguments, so it
/// is a parameter, but the host never is.
fn check_debugger_url(port: u16) -> Result<String, String> {
    if port == 0 {
        return Err("port 0 is not a debugger port".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

/// The list of debuggable targets. Filtered to real pages: the debugger endpoint also lists
/// service workers, iframes and devtools windows, none of which the model should land on.
async fn list_pages(port: u16) -> Result<Vec<(String, String, String)>, String> {
    let base = check_debugger_url(port)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{base}/json/list"))
        .send()
        .await
        .map_err(|_| {
            format!(
                "no browser answered on 127.0.0.1:{port} — start Chrome (or Chromium/Edge) with --remote-debugging-port={port} and open a tab"
            )
        })?;
    let list: Value = res.json().await.map_err(|e| format!("bad target list: {e}"))?;
    let pages: Vec<(String, String, String)> = list
        .as_array()
        .ok_or_else(|| "the target list was not an array".to_string())?
        .iter()
        .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|t| {
            Some((
                t.get("id")?.as_str()?.to_string(),
                t.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                t.get("webSocketDebuggerUrl")?.as_str()?.to_string(),
            ))
        })
        .collect();
    if pages.is_empty() {
        return Err(format!(
            "the browser on port {port} has no open page — open a tab and call again"
        ));
    }
    Ok(pages)
}

/// Drop the cached connection for one port — a dead socket is re-established on the next call,
/// never retried.
fn forget_conn(port: u16) {
    if let Ok(mut conns) = conns_cell().try_lock() {
        conns.remove(&port);
    }
}

async fn connect(port: u16) -> Result<Conn, String> {
    let pages = list_pages(port).await?;
    // Not `.expect("list_pages refuses empty")`: that refusal lives in another function, and a
    // cross-function invariant is one refactor away from being a panic on the request path. The
    // wording matches `list_pages`' own, so the model reads the same instruction either way.
    let (_, title, ws_url) = pages.first().cloned().ok_or_else(|| {
        format!("the browser on port {port} has no open page — open a tab and call again")
    })?;
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("connection lost: cannot attach to \"{title}\": {e}"))?;
    let mut conn = Conn { ws, next_id: 1, port };
    // Turn on the domains the event ledger listens to, before the caller's first command: a page
    // loads the moment `browser_navigate` runs, and the errors it prints on the way are exactly
    // what `browser_console` and `browser_network` exist to report — enabled a frame later, they
    // are already lost.
    for method in ["Runtime.enable", "Network.enable", "Log.enable"] {
        command(&mut conn, method, json!({})).await?;
    }
    Ok(conn)
}

/// Run `f` against a live page connection for this port, reconnecting once if the cached socket
/// was dead.
async fn with_page<T>(
    port: u16,
    mut f: impl FnMut(&mut Conn) -> futures_util::future::BoxFuture<'_, Result<T, String>>,
) -> Result<T, String> {
    let mut conns = conns_cell().lock().await;
    for attempt in 0..2 {
        // The vacant entry is held open across `connect`, which is what `clippy::map_entry` asks for
        // and costs nothing extra here: the whole map is already locked for the duration of this
        // function, so the connect was never racing another caller for the slot.
        if let std::collections::hash_map::Entry::Vacant(slot) = conns.entry(port) {
            let conn = connect(port).await?;
            slot.insert(conn);
        }
        let conn = conns
            .get_mut(&port)
            .ok_or("the browser connection dropped before the call — call again")?;
        match f(conn).await {
            Ok(v) => return Ok(v),
            // The cached socket died (tab closed, Chrome restarted). Drop it and retry once; a
            // second failure is reported as the truth rather than masked.
            Err(e) if attempt == 0 && e.starts_with("connection lost") => {
                conns.remove(&port);
            }
            Err(e) => return Err(e),
        }
    }
    // Written as a return rather than `unreachable!`: the arms above do all return, so this is
    // dead — but "dead" is a property of the loop body, and an edit that adds a third attempt
    // would turn a promise into a process-ending panic on the request path.
    Err("the browser connection could not be established after reconnecting — call again"
        .to_string())
}

/// One request/response round trip. Events that arrive first (a live page talks constantly) are
/// consumed and discarded — only the reply carrying the matching id resolves this call.
async fn command(conn: &mut Conn, method: &str, params: Value) -> Result<Value, String> {
    use tokio_tungstenite::tungstenite::Message;
    let id = conn.next_id;
    conn.next_id += 1;
    let text = json!({ "id": id, "method": method, "params": params }).to_string().into();
    tokio::time::timeout(CMD_TIMEOUT, async {
        conn.ws.send(Message::Text(text)).await.map_err(|e| format!("connection lost: {e}"))?;
        loop {
            let msg = conn
                .ws
                .next()
                .await
                .ok_or_else(|| "connection lost: the debugger closed the socket".to_string())?
                .map_err(|e| format!("connection lost: {e}"))?;
            if let Message::Text(t) = msg {
                let v: Value =
                    serde_json::from_str(t.as_str()).map_err(|e| format!("bad CDP frame: {e}"))?;
                // An event (no `id`) is not noise to discard: console and network entries are
                // what `browser_console` and `browser_network` exist to report. Classify it into
                // the ledger and keep waiting for the reply.
                if v.get("id").is_none() {
                    if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                        record_event(conn.port, method, &v);
                    }
                    continue;
                }
                if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method} failed: {err}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                // An unrelated reply — consume it and keep waiting.
            }
        }
    })
    .await
    .map_err(|_| format!("{method} timed out after {}s", CMD_TIMEOUT.as_secs()))?
}

/// `Runtime.evaluate` with `returnByValue`, the workhorse under every tool below.
async fn evaluate(conn: &mut Conn, expression: &str) -> Result<Value, String> {
    let res = command(
        conn,
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
    )
    .await?;
    let r = res.get("result").ok_or_else(|| "evaluate returned no result".to_string())?;
    if let Some(desc) = r.get("exceptionDetails") {
        return Err(format!("the page threw: {desc}"));
    }
    Ok(r.get("value").cloned().unwrap_or(Value::Null))
}

// ── the event ledger ─────────────────────────────────────────────────────────────────────

/// How many entries the ledger keeps. A chatty page can emit hundreds of console lines; beyond
/// the cap the oldest fall off, because a test session cares about what just happened.
const EVENT_CAP: usize = 500;

#[derive(Clone, Debug, PartialEq)]
enum EventKind {
    Console,
    Net,
}

/// One observed page event, merged: identical consecutive entries collapse into a count rather
/// than spamming the model with the same error twenty times.
#[derive(Clone, Debug, PartialEq)]
struct PageEvent {
    kind: EventKind,
    /// Console level (`error` / `warning` / `log`), or the HTTP method for net entries.
    level: String,
    /// The request URL for net entries; empty for console.
    url: String,
    /// The response status for net entries; 0 means the request never got one (transport failure).
    status: u16,
    text: String,
    count: u32,
}

/// Console and network failures observed while connected, in arrival order, per debugger port —
/// a second browser (another port) has another page, and its history is not this page's. The read
/// loop is the only writer (every command drains the socket, so nothing can be recorded out of
/// order) and the report tools are the only readers. Global, not per-`Conn`: a reconnect must not
/// erase what the page said before its socket died — only a *different* port starts a fresh
/// ledger, which falls out of the keying.
static EVENTS: OnceLock<std::sync::Mutex<std::collections::HashMap<u16, EventLedger>>> =
    OnceLock::new();

/// Record one event into the port's ledger, created on first use. The whole map locks per event:
/// events are milliseconds apart and the lock is uncontended, so a per-entry guard (unstable
/// `MutexGuard::map`) buys nothing.
fn record_event(port: u16, method: &str, frame: &Value) {
    let map = EVENTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    map.lock().unwrap().entry(port).or_default().record(method, frame);
}

/// Take the port's entries of one kind. A page whose entries were all reported leaves an empty
/// ledger behind, and an empty ledger is dropped — nothing worth keeping resident.
fn drain_events(port: u16, kind: EventKind) -> Vec<PageEvent> {
    let map = EVENTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = map.lock().unwrap();
    let taken = guard.entry(port).or_default().drain(kind);
    if guard.get(&port).is_some_and(|l| l.items.is_empty()) {
        guard.remove(&port);
    }
    taken
}

#[derive(Default)]
struct EventLedger {
    items: std::collections::VecDeque<PageEvent>,
    /// requestId → "METHOD url", so a `loadingFailed` (which carries neither) can be named.
    net_requests: std::collections::HashMap<String, String>,
}

impl EventLedger {
    fn record(&mut self, method: &str, frame: &Value) {
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        let event = match method {
            "Runtime.consoleAPICalled" => {
                let level = match params.get("type").and_then(|v| v.as_str()) {
                    Some("error") | Some("assert") => "error",
                    Some("warning") => "warning",
                    _ => "log",
                };
                // A RemoteObject carries a plain value, a description, or neither; whatever it
                // has, stringify it the way DevTools would show it.
                let text = params
                    .get("args")
                    .and_then(|a| a.as_array())
                    .map(|args| {
                        args.iter()
                            .map(|a| match a.get("value") {
                                Some(Value::String(s)) => s.clone(),
                                Some(other) => other.to_string(),
                                None => a
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                if text.is_empty() {
                    return;
                }
                PageEvent {
                    kind: EventKind::Console,
                    level: level.into(),
                    url: String::new(),
                    status: 0,
                    text,
                    count: 1,
                }
            }
            // An uncaught exception is the console error a page never chose to print.
            "Runtime.exceptionThrown" => {
                let details = params.get("exceptionDetails").cloned().unwrap_or(Value::Null);
                let text = details
                    .pointer("/exception/description")
                    .and_then(|d| d.as_str())
                    .or_else(|| details.get("text").and_then(|t| t.as_str()))
                    .unwrap_or("unknown exception")
                    .to_string();
                PageEvent {
                    kind: EventKind::Console,
                    level: "error".into(),
                    url: String::new(),
                    status: 0,
                    text,
                    count: 1,
                }
            }
            "Log.entryAdded" => {
                let entry = params.get("entry").cloned().unwrap_or(Value::Null);
                let source = entry.get("source").and_then(|s| s.as_str()).unwrap_or("");
                // Network-sourced log lines ("Failed to load resource…") restate what
                // `Network.loadingFailed` already records — `browser_network` is their home.
                if source == "network" {
                    return;
                }
                PageEvent {
                    kind: EventKind::Console,
                    level: entry.get("level").and_then(|l| l.as_str()).unwrap_or("log").into(),
                    url: String::new(),
                    status: 0,
                    text: entry.get("text").and_then(|t| t.as_str()).unwrap_or_default().into(),
                    count: 1,
                }
            }
            "Network.requestWillBeSent" => {
                if let (Some(id), Some(req)) =
                    (params.get("requestId").and_then(|v| v.as_str()), params.get("request"))
                {
                    let line = format!(
                        "{} {}",
                        req.get("method").and_then(|m| m.as_str()).unwrap_or("GET"),
                        req.get("url").and_then(|u| u.as_str()).unwrap_or("(unknown)")
                    );
                    self.net_requests.insert(id.to_string(), line);
                }
                return;
            }
            "Network.responseReceived" => {
                let status =
                    params.pointer("/response/status").and_then(|s| s.as_u64()).unwrap_or(0) as u16;
                if status < 400 {
                    return;
                }
                let url = params
                    .pointer("/response/url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("(unknown)")
                    .to_string();
                let level = params
                    .get("requestId")
                    .and_then(|id| id.as_str())
                    .and_then(|id| self.net_requests.get(id))
                    .and_then(|line| line.split(' ').next())
                    .unwrap_or("GET")
                    .to_string();
                PageEvent {
                    kind: EventKind::Net,
                    level,
                    url,
                    status,
                    text: String::new(),
                    count: 1,
                }
            }
            "Network.loadingFailed" => {
                let (level, url) = match params.get("requestId").and_then(|id| id.as_str()) {
                    Some(id) => match self.net_requests.get(id) {
                        Some(line) => {
                            let mut parts = line.splitn(2, ' ');
                            (
                                parts.next().unwrap_or("GET").to_string(),
                                parts.next().unwrap_or("(unknown)").to_string(),
                            )
                        }
                        None => ("GET".into(), "(unknown)".into()),
                    },
                    None => ("GET".into(), "(unknown)".into()),
                };
                PageEvent {
                    kind: EventKind::Net,
                    level,
                    url,
                    status: 0,
                    text: params
                        .get("errorText")
                        .and_then(|e| e.as_str())
                        .unwrap_or("failed")
                        .into(),
                    count: 1,
                }
            }
            _ => return,
        };
        // Merge identical consecutive entries, then respect the cap by dropping the oldest.
        if let Some(last) = self.items.back_mut() {
            if last.kind == event.kind
                && last.level == event.level
                && last.url == event.url
                && last.status == event.status
                && last.text == event.text
            {
                last.count += 1;
                return;
            }
        }
        self.items.push_back(event);
        if self.items.len() > EVENT_CAP {
            self.items.pop_front();
        }
    }

    fn drain(&mut self, kind: EventKind) -> Vec<PageEvent> {
        let mut taken = Vec::new();
        let mut kept = std::collections::VecDeque::new();
        for e in self.items.drain(..) {
            if e.kind == kind {
                taken.push(e);
            } else {
                // The other kind's entries go back, in order — each tool consumes only its own.
                kept.push_back(e);
            }
        }
        self.items = kept;
        taken
    }
}

/// Render console entries, oldest first — the way a terminal prints a page's life.
fn format_console(entries: &[PageEvent]) -> String {
    let mut lines = Vec::new();
    for e in entries {
        let times = if e.count > 1 { format!(" ({}×)", e.count) } else { String::new() };
        lines.push(format!("[{}] {}{}", e.level, e.text, times));
    }
    lines.join("\n")
}

/// Render net entries: `[GET 404] url`, or `[GET failed] url — net::ERR_…` for one that never
/// got a response.
fn format_net(entries: &[PageEvent]) -> String {
    entries
        .iter()
        .map(|e| {
            if e.status > 0 {
                format!("[{} {}] {}", e.level, e.status, e.url)
            } else {
                format!("[{} failed] {} — {}", e.level, e.url, e.text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Read everything the page has said since the last report of this kind. The pump commands exist
/// because the socket is only read while a command is in flight: entries that arrived while no
/// tool was running are still sitting in it, and cheap round trips flush them into the ledger.
/// Two pumps with a beat between them, because an event Chrome emits just after a navigate can
/// still be in flight when the first pump's answer lands — the second one is what makes the
/// report settle instead of racing the page.
fn pump_and_drain(port: u16, kind: EventKind) -> Result<Vec<PageEvent>, String> {
    runtime()?.block_on(with_page(port, |conn| {
        Box::pin(async move {
            evaluate(conn, "1").await?;
            tokio::time::sleep(Duration::from_millis(150)).await;
            evaluate(conn, "1").await
        })
    }))?;
    let taken = drain_events(port, kind);
    Ok(taken)
}

// ── the tools ────────────────────────────────────────────────────────────────────────────

fn port_of(args: &Value) -> u16 {
    args.get("port").and_then(|v| v.as_u64()).map(|p| p as u16).unwrap_or(DEFAULT_PORT)
}

/// The snapshot's element-census expression. Tags every visible interactive element with an
/// index and returns the outline the model reads. A constant — the model never writes JS here
/// (see the module doc).
const SNAPSHOT_JS: &str = r#"(() => {
  const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="textbox"],[contenteditable=""],[onclick]';
  const all = Array.from(document.querySelectorAll(sel));
  const vis = all.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const els = vis.slice(0, 200);
  els.forEach((e, i) => e.setAttribute('data-__cdpidx', String(i)));
  const lines = els.map((e, i) => {
    const tag = e.tagName.toLowerCase();
    let label = e.getAttribute('aria-label') || e.value || e.getAttribute('placeholder') || (e.innerText || e.textContent || '');
    label = String(label).replace(/\s+/g, ' ').trim().slice(0, 80);
    const kind = e.getAttribute('role') || (tag === 'input' ? (e.type || 'text') : tag);
    return '[' + i + '] ' + kind + (e.disabled ? ' disabled' : '') + ' "' + label + '"';
  });
  return JSON.stringify({ title: document.title, url: location.href, count: vis.length, lines });
})()"#;

/// Locate a snapshot-tagged element and return its viewport center. Shared by click and fill.
const LOCATE_JS: &str = r#"((idx) => {
  const e = document.querySelector('[data-__cdpidx="' + idx + '"]');
  if (!e) return null;
  e.scrollIntoView({ block: 'center' });
  const r = e.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})"#;

/// Set a value the way React listens for it: the native prototype setter plus `input` and
/// `change` events, so controlled inputs actually update. `text` arrives as a quoted argument,
/// never as JS.
const FILL_JS: &str = r#"((idx, text) => {
  const e = document.querySelector('[data-__cdpidx="' + idx + '"]');
  if (!e) return null;
  e.focus();
  if (e.tagName === 'SELECT') {
    e.value = text;
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return 'selected';
  }
  if (e.isContentEditable) {
    e.textContent = text;
    e.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return 'filled';
  }
  const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(e, text);
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return 'filled';
})"#;

fn wrap_err(port: u16, r: Result<String, String>) -> crate::core::tools::ToolResult {
    match r {
        Ok(text) => crate::core::tools::ToolResult::ok(text),
        Err(e) => {
            forget_conn(port);
            crate::core::tools::ToolResult::err(e)
        }
    }
}

/// `browser_navigate` — point the connected tab at a URL and wait for the load to settle.
pub fn browser_navigate(args: &Value) -> crate::core::tools::ToolResult {
    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return crate::core::tools::ToolResult::err("navigate needs a \"url\""),
    };
    let port = port_of(args);
    wrap_err(
        port,
        rt!().block_on(with_page(port, move |conn| {
            let url = url.clone();
            Box::pin(async move {
                command(conn, "Page.navigate", json!({ "url": url })).await?;
                // Poll readyState instead of trusting navigate's return: it resolves when the frame
                // *starts* loading, and the model wants the page it can already read.
                let deadline = std::time::Instant::now() + LOAD_TIMEOUT;
                loop {
                    let ready = evaluate(conn, "document.readyState").await?;
                    if ready.as_str() == Some("complete") || std::time::Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                evaluate(conn, "JSON.stringify({ title: document.title, url: location.href })")
                    .await
                    .map(|v| v.as_str().unwrap_or_default().to_string())
            })
        })),
    )
}

/// `browser_snapshot` — the text outline of the page's interactive elements, each with the
/// index that `browser_click` and `browser_fill` address. Those calls fail on a stale index
/// and say to re-snapshot.
pub fn browser_snapshot(args: &Value) -> crate::core::tools::ToolResult {
    let port = port_of(args);
    wrap_err(
        port,
        rt!().block_on(with_page(port, |conn| {
            Box::pin(async move {
                evaluate(conn, SNAPSHOT_JS)
                    .await
                    .map(|v| v.as_str().unwrap_or_default().to_string())
            })
        })),
    )
}

/// `browser_click` — real mouse events at the element's center, not a synthetic `.click()`:
/// the page's own event path (hover, focus, React's synthetic system) runs as a user's click.
pub fn browser_click(args: &Value) -> crate::core::tools::ToolResult {
    let idx = match args.get("element").and_then(|v| v.as_u64()) {
        Some(n) => n,
        None => {
            return crate::core::tools::ToolResult::err(
                "click needs an \"element\": the [N] index a browser_snapshot named",
            )
        }
    };
    let port = port_of(args);
    wrap_err(port, rt!().block_on(with_page(port, |conn| {
        Box::pin(async move {
            // The JS stringifies its answer, so `evaluate` hands back a JSON string *inside* a
            // JSON string — the inner one is the coordinates.
            let raw = evaluate(conn, &format!("{LOCATE_JS}({idx})")).await?;
            if raw.is_null() {
                return Err(format!(
                    "no element [{idx}] — the page changed since the snapshot; call browser_snapshot again"
                ));
            }
            let inner = raw.as_str().ok_or_else(|| "locate returned a non-string".to_string())?;
            let pos: Value = serde_json::from_str(inner).map_err(|e| e.to_string())?;
            let (x, y) = (
                pos.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                pos.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            );
            command(conn, "Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 })).await?;
            command(conn, "Input.dispatchMouseEvent", json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 })).await?;
            Ok(format!("clicked [{idx}]"))
        })
    })))
}

/// `browser_fill` — type a value into a snapshot-tagged input, select or contenteditable.
pub fn browser_fill(args: &Value) -> crate::core::tools::ToolResult {
    let idx = match args.get("element").and_then(|v| v.as_u64()) {
        Some(n) => n,
        None => {
            return crate::core::tools::ToolResult::err(
                "fill needs an \"element\": the [N] index a browser_snapshot named",
            )
        }
    };
    let text = match args.get("text").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => {
            return crate::core::tools::ToolResult::err(
                "fill needs a \"text\": the value to put into the element",
            )
        }
    };
    let port = port_of(args);
    // serde_json's string encoder is the quoting boundary: whatever the model sent arrives in
    // the expression as a JSON string literal, not as JS source.
    let quoted = serde_json::to_string(text).expect("String always serializes");
    wrap_err(port, rt!().block_on(with_page(port, move |conn| {
        let quoted = quoted.clone();
        Box::pin(async move {
            let raw = evaluate(conn, &format!("{FILL_JS}({idx}, {quoted})")).await?;
            if raw.is_null() {
                return Err(format!(
                    "no element [{idx}] — the page changed since the snapshot; call browser_snapshot again"
                ));
            }
            Ok(format!("filled [{idx}]"))
        })
    })))
}

/// `browser_console` — the console and log entries the connected page has printed since the last
/// call of this tool. This is the difference between "the click did nothing" and "the click threw
/// ReferenceError": a failing page says why, and until now the model could not hear it.
pub fn browser_console(args: &Value) -> crate::core::tools::ToolResult {
    let port = port_of(args);
    match pump_and_drain(port, EventKind::Console) {
        Ok(entries) if entries.is_empty() => crate::core::tools::ToolResult::ok(
            "no console output since the last browser_console call — the page has been quiet",
        ),
        Ok(entries) => crate::core::tools::ToolResult::ok(format_console(&entries)),
        Err(e) => crate::core::tools::ToolResult::err(e),
    }
}

/// `browser_network` — requests that failed since the last call of this tool: responses with a
/// 4xx/5xx status, and requests that never got one (refused connection, CORS, DNS). Only
/// failures: a test session asks "what broke", not "what loaded".
pub fn browser_network(args: &Value) -> crate::core::tools::ToolResult {
    let port = port_of(args);
    match pump_and_drain(port, EventKind::Net) {
        Ok(entries) if entries.is_empty() => crate::core::tools::ToolResult::ok(
            "no failed requests since the last browser_network call",
        ),
        Ok(entries) => crate::core::tools::ToolResult::ok(format_net(&entries)),
        Err(e) => crate::core::tools::ToolResult::err(e),
    }
}

/// `browser_wait_for` — block until the page's visible text contains `text`, or the deadline
/// passes. Testing is mostly *waiting for something*; without this tool the model could only poll
/// `browser_snapshot` on a guess and hope. The poll reads `innerText` (what a reader sees), not
/// the DOM source, so hidden elements do not count.
pub fn browser_wait_for(args: &Value) -> crate::core::tools::ToolResult {
    let text = match args.get("text").and_then(|v| v.as_str()) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            return crate::core::tools::ToolResult::err(
                "wait_for needs a \"text\": the string to wait for on the page",
            )
        }
    };
    let timeout_ms =
        args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(10_000).clamp(250, 30_000);
    let port = port_of(args);
    // Same quoting boundary as `browser_fill`: the model's text arrives as a JSON string literal,
    // never as JS source.
    let quoted = serde_json::to_string(&text).expect("String always serializes");
    let js = format!(
        "(() => {{ const t = document.body ? document.body.innerText : ''; return t.includes({quoted}) }})()"
    );
    // Not `wrap_err`: a deadline miss is an ordinary outcome, not a dead socket, and forgetting
    // the connection would re-enable the domains on the next call and orphan the entries the page
    // printed in between. Only a connection failure is dropped.
    match rt!().block_on(with_page(port, |conn| {
        // Cloned per call: the closure is `FnMut` (with_page may run it twice on reconnect), and
        // an `async move` that owned `js` would leave it moved out on the second run.
        let js = js.clone();
        let text = text.clone();
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let found = evaluate(conn, &js).await?.as_bool().unwrap_or(false);
                if found {
                    return Ok(format!("\"{text}\" is on the page"));
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "\"{text}\" never appeared within {}ms — re-check the wording with browser_snapshot, \
                         or the page may not be doing what you expect",
                        timeout_ms
                    ));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
    })) {
        Ok(s) => crate::core::tools::ToolResult::ok(s),
        Err(e) => {
            if e.starts_with("connection lost") {
                forget_conn(port);
            }
            crate::core::tools::ToolResult::err(e)
        }
    }
}

/// `browser_expect` — assert, retrying until a deadline, that the page satisfies one of four
/// expectations: visible `text` contains a string, a CSS `element` selector matches, the `url`
/// or `title` contains a string. `browser_wait_for` answers "is it there yet"; a test wants to
/// *assert* — and a failed assertion must be a diagnosis, so every miss says what the page
/// actually showed (its title, its URL, its visible text) instead of a bare "no".
///
/// The quoted string is the boundary: the model's `value` arrives as a JSON string literal, never
/// as JS source — the same rule as `browser_fill` and `browser_wait_for`.
pub fn browser_expect(args: &Value) -> crate::core::tools::ToolResult {
    let kind = match args.get("kind").and_then(|v| v.as_str()) {
        Some(k @ ("text" | "element" | "url" | "title")) => k.to_string(),
        _ => {
            return crate::core::tools::ToolResult::err(
                "expect needs a \"kind\": one of \"text\", \"element\", \"url\", \"title\"",
            )
        }
    };
    let value = match args.get("value").and_then(|v| v.as_str()) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            return crate::core::tools::ToolResult::err(format!(
                "expect needs a \"value\": the {kind} to assert on the page"
            ))
        }
    };
    let timeout_ms =
        args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(10_000).clamp(250, 30_000);
    let port = port_of(args);
    let quoted = serde_json::to_string(&value).expect("String always serializes");
    // Each poll returns one value the loop can judge: text a bool, element a JSON blob with the
    // match count AND the page title (the diagnosis travels with every poll, so a miss needs no
    // second round trip), url/title the current value itself (the contains check happens here,
    // and the failure message quotes what the page was actually showing).
    let js = match kind.as_str() {
        "text" => format!(
            "(() => {{ const t = document.body ? document.body.innerText : ''; return t.includes({quoted}) }})()"
        ),
        "element" => format!(
            "(() => {{ try {{ return JSON.stringify({{ n: document.querySelectorAll({quoted}).length, title: document.title }}) }} catch (e) {{ return JSON.stringify({{ n: -1, title: document.title }}) }} }})()"
        ),
        "url" => "(() => location.href)()".to_string(),
        "title" => "(() => document.title)()".to_string(),
        _ => unreachable!(),
    };
    // Not `wrap_err`: a deadline miss is an ordinary outcome, not a dead socket — same reason as
    // `browser_wait_for`.
    match rt!().block_on(with_page(port, |conn| {
        let js = js.clone();
        let kind = kind.clone();
        let value = value.clone();
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let res = evaluate(conn, &js).await?;
                let mut hit: Option<String> = None;
                let mut observation = String::new();
                match kind.as_str() {
                    "text" => {
                        if res.as_bool().unwrap_or(false) {
                            hit = Some(format!("\"{value}\" is on the page"));
                        }
                    }
                    "element" => {
                        let parsed: Value = serde_json::from_str(res.as_str().unwrap_or("{}"))
                            .unwrap_or(json!({}));
                        let n = parsed.get("n").and_then(|x| x.as_i64()).unwrap_or(-2);
                        let title =
                            parsed.get("title").and_then(|x| x.as_str()).unwrap_or("");
                        if n == -1 {
                            return Err(format!(
                                "\"{value}\" is not a valid CSS selector — check the syntax \
                                 (attribute values need quotes)"
                            ));
                        }
                        if n > 0 {
                            hit = Some(format!(
                                "{} element{} match{} \"{value}\" (page \"{title}\")",
                                n,
                                if n == 1 { "" } else { "s" },
                                if n == 1 { "es" } else { "" },
                            ));
                        } else {
                            observation = format!("the page is \"{title}\"");
                        }
                    }
                    _ => {
                        let cur = res.as_str().unwrap_or("");
                        if cur.contains(&value) {
                            hit = Some(format!(
                                "\"{value}\" is in the {kind} (currently \"{cur}\")"
                            ));
                        } else {
                            observation = format!("currently \"{cur}\"");
                        }
                    }
                }
                if let Some(msg) = hit {
                    return Ok(msg);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(match kind.as_str() {
                        "text" => format!(
                            "\"{value}\" never appeared within {timeout_ms}ms — re-check the wording with browser_snapshot, \
                             or the page may not be doing what you expect"
                        ),
                        "element" => format!(
                            "no element matches \"{value}\" within {timeout_ms}ms — {observation}"
                        ),
                        _ => format!(
                            "\"{value}\" never appeared in the {kind} within {timeout_ms}ms — {observation}"
                        ),
                    });
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
    })) {
        Ok(s) => crate::core::tools::ToolResult::ok(s),
        Err(e) => {
            if e.starts_with("connection lost") {
                forget_conn(port);
            }
            crate::core::tools::ToolResult::err(e)
        }
    }
}

// ── browser_start ────────────────────────────────────────────────────────────────

/// The binaries a `browser_start` may launch, in preference order. Absolute paths on macOS
/// (the .app bundles are not on PATH); program names elsewhere, resolved against PATH.
#[cfg(target_os = "macos")]
fn browser_candidates() -> Vec<&'static str> {
    vec![
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_candidates() -> Vec<&'static str> {
    vec!["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]
}

#[cfg(windows)]
fn browser_candidates() -> Vec<&'static str> {
    vec!["chrome.exe", "msedge.exe", "chromium.exe"]
}

/// The first candidate that exists — an absolute path as-is, a bare name resolved against PATH.
fn find_browser(candidates: &[&str]) -> Option<String> {
    for c in candidates {
        if c.contains('/') {
            if std::path::Path::new(c).exists() {
                return Some(c.to_string());
            }
        } else if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let p = dir.join(c);
                if p.exists() {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

/// `browser_start` — launch the user's browser with the debugger port so the browser tools have
/// something to attach to. The one browser-setup step the tools cannot do for themselves, done
/// for them: nothing here *installs* anything, it launches a browser that is already on the
/// machine.
///
/// The dedicated user-data-dir is not optional. Chrome's process singleton is per profile — a
/// launch that reuses the user's everyday profile while their normal Chrome is running would be
/// silently absorbed by the existing instance and the debugger port would never come up. A
/// separate profile dir guarantees a real new process, at the cost of a fresh profile (no
/// extensions, no history), which is exactly what a test browser should be.
pub fn browser_start(args: &Value) -> crate::core::tools::ToolResult {
    let port = port_of(args);
    browser_start_with(&browser_candidates(), port)
}

fn browser_start_with(candidates: &[&str], port: u16) -> crate::core::tools::ToolResult {
    // A browser already answering is a success, not an error — the recovery loop's second call
    // (start, then navigate again) must not turn into "port already in use".
    if rt!().block_on(list_pages(port)).is_ok() {
        return crate::core::tools::ToolResult::ok(format!(
            "a browser is already answering on 127.0.0.1:{port} — nothing to start, try the call again"
        ));
    }
    let Some(binary) = find_browser(candidates) else {
        return crate::core::tools::ToolResult::err(
            "no Chrome, Chromium, Edge or Brave was found on this machine — install one, or start it \
             yourself with --remote-debugging-port and open a tab",
        );
    };
    let profile = std::env::temp_dir().join(format!("aiprovider-debug-profile-{port}"));
    if let Err(e) = std::fs::create_dir_all(&profile) {
        return crate::core::tools::ToolResult::err(format!(
            "cannot create the debug profile directory: {e}"
        ));
    }
    let child = std::process::Command::new(&binary)
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            return crate::core::tools::ToolResult::err(format!(
                "could not launch {} — start it yourself with --remote-debugging-port={port}: {e}",
                binary
            ))
        }
    };
    // The endpoint answers a beat after the process exists (the same race the test launcher
    // handles), and a hung launch must not hang the tool: bounded poll, then an honest miss.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if rt!().block_on(list_pages(port)).is_ok() {
            // Do not leave a zombie handle: the browser outlives this command by design, the
            // child handle must not keep it reaped-or-not ambiguous.
            let _ = child.try_wait();
            return crate::core::tools::ToolResult::ok(format!(
                "a browser is up on 127.0.0.1:{port} (a fresh debug profile, so the page is blank) — \
                 navigate to the page you want to test"
            ));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            return crate::core::tools::ToolResult::err(format!(
                "{binary} was launched but never answered on 127.0.0.1:{port} within 15s — it may be \
                 showing a first-run dialog, or another instance is holding the profile; start it \
                 yourself with --remote-debugging-port={port} and open a tab"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Capture the connected page as a base64 PNG for `browser_screenshot` to save.
pub fn capture_screenshot(args: &Value) -> Result<String, String> {
    let port = port_of(args);
    let out: Result<String, String> = runtime()?.block_on(with_page(port, |conn| {
        Box::pin(async move {
            let res = command(conn, "Page.captureScreenshot", json!({ "format": "png" })).await?;
            res.get("data")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "the screenshot returned no image data".to_string())
        })
    }));
    if out.is_err() {
        forget_conn(port);
    }
    out
}

/// Render the connected page as a base64 PDF with print media emulated.
///
/// `browser_screenshot` captures the screen; `Page.printToPDF` is the only path that lays out
/// `@media print` and `@page`, which is the whole reason a print check exists. Media emulation is
/// restored to `screen` before the call returns: the connection is cached across tool calls, and
/// a page left in print mode would corrupt every later screenshot and snapshot on that tab.
pub fn print_to_pdf(args: &Value) -> Result<String, String> {
    let port = port_of(args);
    let landscape = args.get("landscape").and_then(|v| v.as_bool()).unwrap_or(false);
    let out: Result<String, String> = runtime()?.block_on(with_page(port, |conn| {
        Box::pin(async move {
            command(conn, "Emulation.setEmulatedMedia", json!({ "media": "print" })).await?;
            let printed = command(
                conn,
                "Page.printToPDF",
                json!({
                    "printBackground": true,
                    "preferCSSPageSize": true,
                    "landscape": landscape,
                }),
            )
            .await;
            // Restore the screen media even when printing failed: a cached connection must not
            // keep the next tool call in print mode.
            let restored =
                command(conn, "Emulation.setEmulatedMedia", json!({ "media": "screen" })).await;
            if let Err(e) = restored {
                return Err(format!("print media could not be restored: {e}"));
            }
            let res = printed?;
            res.get("data")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "printToPDF returned no PDF data".to_string())
        })
    }));
    if out.is_err() {
        forget_conn(port);
    }
    out
}

// ── tests ────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_debugger_url_guard_is_loopback_only() {
        assert!(check_debugger_url(9222).is_ok());
        assert!(check_debugger_url(0).is_err());
    }

    /// The ledger's classification, fed hand-built CDP frames — no browser needed. This is the
    /// test that says the read loop's discards became entries, with the shapes the report tools
    /// format.
    #[test]
    fn console_and_net_frames_classify_into_the_ledger() {
        let mut ledger = EventLedger::default();
        let console = serde_json::json!({
            "method": "Runtime.consoleAPICalled",
            "params": { "type": "error", "args": [{ "type": "string", "value": "boom" }] },
        });
        ledger.record("Runtime.consoleAPICalled", &console);
        ledger.record("Runtime.consoleAPICalled", &console);
        ledger.record(
            "Runtime.exceptionThrown",
            &serde_json::json!({
                "method": "Runtime.exceptionThrown",
                "params": { "exceptionDetails": { "exception": { "description": "TypeError: x is not a function" } } },
            }),
        );
        assert_eq!(
            ledger.items.iter().map(|e| (e.level.as_str(), e.count)).collect::<Vec<_>>(),
            vec![("error", 2), ("error", 1)],
            "identical consecutive entries merge, distinct ones stay apart"
        );

        // A 404 with a known request: method and url both survive.
        ledger.record(
            "Network.requestWillBeSent",
            &serde_json::json!({
                "method": "Network.requestWillBeSent",
                "params": { "requestId": "r1", "request": { "method": "POST", "url": "http://x/api" } },
            }),
        );
        ledger.record(
            "Network.responseReceived",
            &serde_json::json!({
                "method": "Network.responseReceived",
                "params": { "requestId": "r1", "response": { "url": "http://x/api", "status": 404 } },
            }),
        );
        ledger.record(
            "Network.loadingFailed",
            &serde_json::json!({
                "method": "Network.loadingFailed",
                "params": { "requestId": "r2", "errorText": "net::ERR_CONNECTION_REFUSED" },
            }),
        );
        // A 200 is not a failure: it must never reach the report.
        ledger.record(
            "Network.responseReceived",
            &serde_json::json!({
                "method": "Network.responseReceived",
                "params": { "requestId": "r1", "response": { "url": "http://x/api", "status": 200 } },
            }),
        );

        let net = ledger.drain(EventKind::Net);
        assert_eq!(net.len(), 2, "one 404 and one transport failure");
        assert_eq!((net[0].level.as_str(), net[0].status), ("POST", 404));
        assert_eq!(net[1].text, "net::ERR_CONNECTION_REFUSED");
        assert!(
            ledger.drain(EventKind::Console).len() == 2,
            "console entries are untouched by the net drain"
        );
    }

    #[test]
    fn the_report_formats_are_what_the_model_reads() {
        let console = vec![PageEvent {
            kind: EventKind::Console,
            level: "error".into(),
            url: String::new(),
            status: 0,
            text: "boom".into(),
            count: 3,
        }];
        assert_eq!(format_console(&console), "[error] boom (3×)");

        let net = vec![
            PageEvent {
                kind: EventKind::Net,
                level: "GET".into(),
                url: "http://x/404".into(),
                status: 404,
                text: String::new(),
                count: 1,
            },
            PageEvent {
                kind: EventKind::Net,
                level: "GET".into(),
                url: "http://x/refused".into(),
                status: 0,
                text: "net::ERR_CONNECTION_REFUSED".into(),
                count: 1,
            },
        ];
        assert_eq!(
            format_net(&net),
            "[GET 404] http://x/404\n[GET failed] http://x/refused — net::ERR_CONNECTION_REFUSED"
        );
    }

    #[test]
    fn a_dead_debugger_port_is_an_instruction_not_a_stacktrace() {
        // A port nothing listens on. The error is what the model sees when it forgets that the
        // browser must be started first — it has to name the fix.
        let err = runtime().expect("the test runtime").block_on(list_pages(59999)).unwrap_err();
        assert!(err.contains("--remote-debugging-port"), "got: {err}");
    }

    /// Launch a real headless Chrome on a fresh port and profile, return the port. Skips the
    /// caller (Ok without connecting) when Chrome is not installed rather than failing a machine
    /// that cannot run the test at all.
    fn launch_headless_chrome(dir: &std::path::Path) -> Option<(u16, std::process::Child)> {
        let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !std::path::Path::new(chrome).exists() {
            eprintln!("skipping: no Chrome at {chrome}");
            return None;
        }
        let mut child = std::process::Command::new(chrome)
            .args([
                "--headless=new",
                "--no-first-run",
                "--disable-gpu",
                "--remote-debugging-port=0",
            ])
            .arg(format!("--user-data-dir={}", dir.display()))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .ok()?;
        // Port 0 makes Chrome pick a free port and print where it listens on stderr.
        let mut stderr = child.stderr.take().expect("piped");
        let started = std::time::Instant::now();
        let mut buf = Vec::new();
        let port = loop {
            if child.try_wait().map(|s| s.is_some()).unwrap_or(false) {
                eprintln!("skipping: Chrome exited immediately");
                return None;
            }
            let mut chunk = [0u8; 1024];
            use std::io::Read as _;
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => {}
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            let text = String::from_utf8_lossy(&buf);
            if let Some(at) = text.find("DevTools listening on ws://127.0.0.1:") {
                let rest = &text[at + "DevTools listening on ws://127.0.0.1:".len()..];
                let end = rest.find('/').unwrap_or(rest.len());
                break rest[..end].parse::<u16>().ok()?;
            }
            if started.elapsed() > std::time::Duration::from_secs(15) {
                eprintln!("skipping: Chrome never printed its debugger port");
                let _ = child.kill();
                return None;
            }
        };
        // "DevTools listening" on stderr precedes the HTTP endpoint actually answering — under
        // parallel test load the gap is seconds, and a navigate that lands in it reads as "no
        // browser answered". Poll the endpoint before handing the port out.
        let rt = runtime().expect("the test runtime");
        let endpoint = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if rt.block_on(list_pages(port)).is_ok() {
                break;
            }
            if std::time::Instant::now() >= endpoint {
                eprintln!("skipping: the debugger endpoint never answered");
                let _ = child.kill();
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Some((port, child))
    }

    fn stop_chrome(child: &mut std::process::Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The full round trip against a real browser: navigate to a page whose button and input
    /// write into document.title, then snapshot → click → fill → screenshot, each step proved
    /// by what the page itself reports. This is the test that says the CDP client works, not
    /// merely that it compiles.
    #[test]
    fn navigate_snapshot_click_fill_screenshot_and_print_round_trip_against_chrome() {
        let tmp = std::env::temp_dir().join(format!("aiprovider-chrome-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let Some((port, mut child)) = launch_headless_chrome(&tmp) else { return };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let page = format!(
                "data:text/html,<title>cdp-test</title><button onclick=\"document.title='clicked-{}'\">press me</button><input oninput=\"document.title=this.value\" placeholder=\"type here\">",
                std::process::id()
            );
            let nav = browser_navigate(&serde_json::json!({ "url": page, "port": port }));
            assert!(nav.ok, "navigate: {:?}", nav.error);
            assert!(nav.output.contains("cdp-test"), "got: {}", nav.output);

            let snap = browser_snapshot(&serde_json::json!({ "port": port }));
            assert!(snap.ok, "snapshot: {:?}", snap.error);
            // The outline arrives as JSON, so quotes inside it are escaped; the needles here
            // avoid them.
            assert!(
                snap.output.contains("button") && snap.output.contains("press me"),
                "got: {}",
                snap.output
            );
            assert!(snap.output.contains("type here"), "got: {}", snap.output);

            let click = browser_click(&serde_json::json!({ "element": 0, "port": port }));
            assert!(click.ok, "click: {:?}", click.error);
            let after_click = browser_snapshot(&serde_json::json!({ "port": port }));
            assert!(after_click.ok);
            assert!(
                after_click.output.contains("clicked-"),
                "the button's onclick must have run, title should say so: {}",
                after_click.output
            );

            let fill = browser_fill(
                &serde_json::json!({ "element": 1, "text": "typed value", "port": port }),
            );
            assert!(fill.ok, "fill: {:?}", fill.error);
            let after_fill = browser_snapshot(&serde_json::json!({ "port": port }));
            assert!(after_fill.ok);
            assert!(
                after_fill.output.contains("typed value"),
                "the input event must have fired (title = input value): {}",
                after_fill.output
            );

            // The tool, not just the capture: a new timestamped path must reach the workspace,
            // including a directory that does not exist yet (the screenshot regression).
            let root = tmp.to_string_lossy().to_string();
            let shot = crate::core::tools::tool_run(crate::core::tools::ToolRunRequest {
                name: "browser_screenshot".into(),
                arguments: serde_json::json!({
                    "port": port,
                    "path": "images/round-trip.png",
                }),
                root: root.clone(),
            });
            assert!(shot.ok, "screenshot tool: {:?}", shot.error);
            assert!(
                std::fs::read(tmp.join("images/round-trip.png"))
                    .unwrap()
                    .starts_with(&[0x89, b'P', b'N', b'G']),
                "the tool must write a real PNG into a directory that did not exist"
            );

            // Print media is the point: the screen-only marker must be absent from the PDF and
            // the print-only marker present. A screen capture cannot prove either.
            let print_page = "data:text/html,<title>print-test</title><style>.print{display:none}@media print{.screen{display:none}.print{display:block}}</style><div class=\"screen\">SCREENONLY</div><div class=\"print\">PRINTONLY</div>";
            let nav = browser_navigate(&serde_json::json!({ "url": print_page, "port": port }));
            assert!(nav.ok, "print navigate: {:?}", nav.error);
            let printed = crate::core::tools::tool_run(crate::core::tools::ToolRunRequest {
                name: "browser_print".into(),
                arguments: serde_json::json!({
                    "port": port,
                    "path": "documents/round-trip.pdf",
                }),
                root,
            });
            assert!(printed.ok, "print tool: {:?}", printed.error);
            let pdf_path = tmp.join("documents/round-trip.pdf");
            let pdf = std::fs::read(&pdf_path).expect("the PDF must be written");
            assert!(pdf.starts_with(b"%PDF"), "a real PDF comes back");
            let text = pdf_extract::extract_text(&pdf_path).expect("the PDF text must be readable");
            assert!(text.contains("PRINTONLY"), "print media must be rendered: {text}");
            assert!(!text.contains("SCREENONLY"), "screen-only content must be hidden: {text}");
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn(port);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    /// A click on an index the snapshot never gave (or the page has moved past) is a directed
    /// re-snapshot, not a silent success — this is what keeps the model's element ids honest.
    #[test]
    fn click_on_a_stale_index_says_to_re_snapshot() {
        let tmp = std::env::temp_dir().join(format!("aiprovider-chrome-2-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let Some((port, mut child)) = launch_headless_chrome(&tmp) else { return };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            browser_navigate(&serde_json::json!({
                "url": "data:text/html,<title>stale-test</title><button>b</button>",
                "port": port,
            }));
            let click = browser_click(&serde_json::json!({ "element": 99, "port": port }));
            assert!(!click.ok, "an absent element must not 'succeed'");
            let reason = click.error.unwrap_or_default();
            assert!(reason.contains("browser_snapshot"), "the error names the recovery: {reason}");
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn(port);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    /// The three observers against a real page: a console error printed on load, a fetch that 404s
    /// against a throwaway local server, and text that appears 400ms in. This is the test that
    /// says the ledger hears the page — not merely that the frames classify.
    #[test]
    fn console_network_and_wait_report_what_the_page_did() {
        let tmp = std::env::temp_dir().join(format!("aiprovider-chrome-3-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let Some((port, mut child)) = launch_headless_chrome(&tmp) else { return };
        // A one-connection HTTP server that always answers 404 — the network failures need a real
        // response to fail against.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a local port");
        let server_port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = std::io::Read::read(&mut s, &mut buf);
                let _ = std::io::Write::write_all(
                    &mut s,
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
                );
            }
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let page = format!(
                "data:text/html,<title>observer-test</title><script>\
                 console.error('boom 42');\
                 fetch('http://127.0.0.1:{server_port}/missing').catch(()=>{{}});\
                 setTimeout(() => {{ document.body.textContent = 'ready-now'; }}, 400);\
                 </script>",
            );
            let nav = browser_navigate(&serde_json::json!({ "url": page, "port": port }));
            assert!(nav.ok, "navigate: {:?}", nav.error);

            let console = browser_console(&serde_json::json!({ "port": port }));
            assert!(console.ok, "console: {:?}", console.error);
            assert!(
                console.output.contains("boom 42"),
                "the load-time console.error must be in the ledger: {}",
                console.output
            );

            let wait = browser_wait_for(&serde_json::json!({ "text": "ready-now", "port": port }));
            assert!(wait.ok, "the text appears 400ms in, wait_for must see it: {:?}", wait.error);
            let miss = browser_wait_for(
                &serde_json::json!({ "text": "never-written-anywhere", "timeout_ms": 500, "port": port }),
            );
            assert!(!miss.ok, "an absent text must not 'succeed'");
            assert!(
                miss.error.as_deref().unwrap_or_default().contains("never appeared"),
                "the failure names the deadline: {:?}",
                miss.error
            );

            let net = browser_network(&serde_json::json!({ "port": port }));
            assert!(net.ok, "network: {:?}", net.error);
            assert!(
                net.output.contains("127.0.0.1"),
                "the failed fetch must be reported with its URL: {}",
                net.output
            );

            // The drains consumed what they reported: a second console read is quiet.
            let again = browser_console(&serde_json::json!({ "port": port }));
            assert!(again.ok);
            assert!(again.output.contains("no console output"), "got: {}", again.output);
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn(port);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    /// `browser_expect` against a real page: the four kinds hit, a text miss names the deadline,
    /// an element miss diagnoses the page, and a malformed selector fails fast instead of polling.
    #[test]
    fn expect_asserts_the_page_and_misses_say_what_it_showed() {
        let tmp = std::env::temp_dir().join(format!("aiprovider-chrome-4-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let Some((port, mut child)) = launch_headless_chrome(&tmp) else { return };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let page = "data:text/html,<title>expect-test</title>\
                        <button id='go'>go</button>\
                        <span id='late'></span>\
                        <script>setTimeout(() => { document.getElementById('late').textContent = 'loaded-late'; }, 300);</script>";
            let nav = browser_navigate(&serde_json::json!({ "url": page, "port": port }));
            assert!(nav.ok, "navigate: {:?}", nav.error);

            let text = browser_expect(
                &serde_json::json!({ "kind": "text", "value": "loaded-late", "port": port }),
            );
            assert!(text.ok, "late text is retried until it shows: {:?}", text.error);
            assert!(text.output.contains("loaded-late"), "got: {}", text.output);

            let element = browser_expect(
                &serde_json::json!({ "kind": "element", "value": "#go", "port": port }),
            );
            assert!(element.ok, "the selector matches: {:?}", element.error);
            assert!(
                element.output.contains("1 element matches")
                    && element.output.contains("expect-test"),
                "the hit names the count and the page: {}",
                element.output
            );

            let title = browser_expect(
                &serde_json::json!({ "kind": "title", "value": "expect-test", "port": port }),
            );
            assert!(title.ok, "got: {:?}", title.error);
            assert!(title.output.contains("expect-test"), "got: {}", title.output);

            let url = browser_expect(
                &serde_json::json!({ "kind": "url", "value": "data:text/html", "port": port }),
            );
            assert!(url.ok, "got: {:?}", url.error);

            let miss = browser_expect(&serde_json::json!({
                "kind": "element", "value": "#absent", "timeout_ms": 500, "port": port,
            }));
            assert!(!miss.ok, "an absent element must not 'succeed'");
            let reason = miss.error.as_deref().unwrap_or_default();
            assert!(
                reason.contains("no element matches") && reason.contains("expect-test"),
                "the miss diagnoses the page: {reason}"
            );

            let bad = browser_expect(
                &serde_json::json!({ "kind": "element", "value": "#[unclosed", "port": port }),
            );
            assert!(!bad.ok, "an invalid selector must fail fast");
            assert!(
                bad.error.as_deref().unwrap_or_default().contains("not a valid CSS selector"),
                "got: {:?}",
                bad.error
            );

            let bad_kind =
                browser_expect(&serde_json::json!({ "kind": "count", "value": "x", "port": port }));
            assert!(!bad_kind.ok, "an unknown kind must be refused");
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn(port);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    /// `browser_start` with no candidates refuses honestly, and with a browser already answering
    /// on the port it must not spawn a second one — the recovery loop's "start, then navigate
    /// again" depends on the second call reading as success.
    #[test]
    fn start_refuses_without_a_binary_and_answers_when_one_is_already_up() {
        let miss = browser_start_with(&[], 59998);
        assert!(!miss.ok, "no candidate must not 'succeed'");
        assert!(
            miss.error
                .as_deref()
                .unwrap_or_default()
                .contains("no Chrome, Chromium, Edge or Brave"),
            "got: {:?}",
            miss.error
        );

        let tmp = std::env::temp_dir().join(format!("aiprovider-chrome-5-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let Some((port, mut child)) = launch_headless_chrome(&tmp) else { return };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let up = browser_start_with(&["/no/such/browser"], port);
            assert!(up.ok, "an answering browser is success: {:?}", up.error);
            assert!(
                up.output.contains("already answering"),
                "and says it started nothing: {}",
                up.output
            );
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn(port);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    /// The binary finder resolves absolute paths and PATH names, and refuses what is not there.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_binary_finder_finds_what_exists() {
        assert_eq!(find_browser(&["/no/such/beast"]), None);
        assert_eq!(
            find_browser(&["/bin/echo"]).as_deref(),
            Some("/bin/echo"),
            "an absolute path that exists is taken as-is"
        );
        assert!(find_browser(&["ls"]).is_some(), "a PATH name resolves");
    }
}
