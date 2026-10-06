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
//!   [`browser_screenshot`] are the tool surface (`tool_run` dispatches to them). Snapshot is the
//!   hub: it tags the interactive elements with `data-__cdpidx` attributes and returns a text
//!   outline, and click/fill address elements by those indexes — the same shape browser-use
//!   popularised, because the model can only point at what a previous tool result named.
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

/// The open page connection, kept across tool calls. A `tokio` mutex, not a std one: the guard
/// is held across the socket awaits and must cross the `block_on` boundary.
static CONN: OnceLock<tokio::sync::Mutex<Option<Conn>>> = OnceLock::new();

fn conn_cell() -> &'static tokio::sync::Mutex<Option<Conn>> {
    CONN.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// The dedicated multi-thread runtime, the same bridge `core::web` uses: the tool host is
/// synchronous, and blocking on the ambient runtime would panic.
fn runtime() -> &'static tokio::runtime::Runtime {
    static CELL: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    CELL.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the browser runtime must start")
    })
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

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

/// Drop the cached connection — a dead socket is re-established on the next call, never retried.
fn forget_conn() {
    if let Ok(mut slot) = conn_cell().try_lock() {
        *slot = None;
    }
}

async fn connect(port: u16) -> Result<Conn, String> {
    let pages = list_pages(port).await?;
    let (_, title, ws_url) = pages.first().cloned().expect("list_pages refuses empty");
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("connection lost: cannot attach to \"{title}\": {e}"))?;
    Ok(Conn { ws, next_id: 1, port })
}

/// Run `f` against a live page connection, reconnecting once if the cached socket was dead.
async fn with_page<T>(
    port: u16,
    mut f: impl FnMut(&mut Conn) -> futures_util::future::BoxFuture<'_, Result<T, String>>,
) -> Result<T, String> {
    let cell = conn_cell();
    let mut guard = cell.lock().await;
    for attempt in 0..2 {
        if guard.as_ref().map(|c| c.port) != Some(port) {
            *guard = Some(connect(port).await?);
        }
        let conn = guard.as_mut().expect("just connected");
        match f(conn).await {
            Ok(v) => return Ok(v),
            // The cached socket died (tab closed, Chrome restarted). Reconnect and retry once;
            // a second failure is reported as the truth rather than masked.
            Err(e) if attempt == 0 && e.starts_with("connection lost") => {
                *guard = None;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("the loop returns on both branches")
}

/// One request/response round trip. Events that arrive first (a live page talks constantly) are
/// consumed and discarded — only the reply carrying the matching id resolves this call.
async fn command(conn: &mut Conn, method: &str, params: Value) -> Result<Value, String> {
    use tokio_tungstenite::tungstenite::Message;
    let id = conn.next_id;
    conn.next_id += 1;
    let text = json!({ "id": id, "method": method, "params": params })
        .to_string()
        .into();
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
                let v: Value = serde_json::from_str(t.as_str())
                    .map_err(|e| format!("bad CDP frame: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method} failed: {err}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                // An event or an unrelated reply — consume it and keep waiting.
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
    let r = res
        .get("result")
        .ok_or_else(|| "evaluate returned no result".to_string())?;
    if let Some(desc) = r.get("exceptionDetails") {
        return Err(format!("the page threw: {desc}"));
    }
    Ok(r.get("value").cloned().unwrap_or(Value::Null))
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

fn wrap_err(r: Result<String, String>) -> crate::core::tools::ToolResult {
    match r {
        Ok(text) => crate::core::tools::ToolResult::ok(text),
        Err(e) => {
            forget_conn();
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
    wrap_err(runtime().block_on(with_page(port, move |conn| {
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
    })))
}

/// `browser_snapshot` — the text outline of the page's interactive elements, each with the
/// index that `browser_click` and `browser_fill` address. Those calls fail on a stale index
/// and say to re-snapshot.
pub fn browser_snapshot(args: &Value) -> crate::core::tools::ToolResult {
    let port = port_of(args);
    wrap_err(runtime().block_on(with_page(port, |conn| {
        Box::pin(async move { evaluate(conn, SNAPSHOT_JS).await.map(|v| v.as_str().unwrap_or_default().to_string()) })
    })))
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
    wrap_err(runtime().block_on(with_page(port, |conn| {
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
    wrap_err(runtime().block_on(with_page(port, move |conn| {
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

/// Capture the connected page as a base64 PNG for `browser_screenshot` to save.
pub fn capture_screenshot(args: &Value) -> Result<String, String> {
    let port = port_of(args);
    let out: Result<String, String> = runtime().block_on(with_page(port, |conn| {
        Box::pin(async move {
            let res = command(conn, "Page.captureScreenshot", json!({ "format": "png" })).await?;
            res.get("data")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "the screenshot returned no image data".to_string())
        })
    }));
    if out.is_err() {
        forget_conn();
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

    #[test]
    fn a_dead_debugger_port_is_an_instruction_not_a_stacktrace() {
        // A port nothing listens on. The error is what the model sees when it forgets that the
        // browser must be started first — it has to name the fix.
        let err = runtime().block_on(list_pages(59999)).unwrap_err();
        assert!(err.contains("--remote-debugging-port"), "got: {err}");
    }

    /// Launch a real headless Chrome on a fresh port and profile, return the port. Skips the
    /// caller (Ok without connecting) when Chrome is not installed rather than failing a machine
    /// that cannot run the test at all.
    fn launch_headless_chrome(
        dir: &std::path::Path,
    ) -> Option<(u16, std::process::Child)> {
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
    fn navigate_snapshot_click_fill_screenshot_round_trips_against_chrome() {
        let tmp = std::env::temp_dir().join(format!("aiprovider-chrome-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let Some((mut port, mut child)) = launch_headless_chrome(&tmp) else { return };
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
            assert!(snap.output.contains("button") && snap.output.contains("press me"), "got: {}", snap.output);
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

            let fill = browser_fill(&serde_json::json!({ "element": 1, "text": "typed value", "port": port }));
            assert!(fill.ok, "fill: {:?}", fill.error);
            let after_fill = browser_snapshot(&serde_json::json!({ "port": port }));
            assert!(after_fill.ok);
            assert!(
                after_fill.output.contains("typed value"),
                "the input event must have fired (title = input value): {}",
                after_fill.output
            );

            let png = capture_screenshot(&serde_json::json!({ "port": port })).unwrap();
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD.decode(png.as_bytes()).unwrap();
            assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']), "a real PNG comes back");
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn();
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
        let Some((mut port, mut child)) = launch_headless_chrome(&tmp) else { return };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            browser_navigate(&serde_json::json!({
                "url": "data:text/html,<title>stale-test</title><button>b</button>",
                "port": port,
            }));
            let click = browser_click(&serde_json::json!({ "element": 99, "port": port }));
            assert!(!click.ok, "an absent element must not 'succeed'");
            let reason = click.error.unwrap_or_default();
            assert!(
                reason.contains("browser_snapshot"),
                "the error names the recovery: {reason}"
            );
        }));
        stop_chrome(&mut child);
        let _ = std::fs::remove_dir_all(&tmp);
        forget_conn();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
