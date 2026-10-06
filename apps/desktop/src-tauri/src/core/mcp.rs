//! MCP (Model Context Protocol) client support (2026-10-06).
//!
//! External MCP servers declare tools over JSON-RPC 2.0; this module connects to the configured
//! ones (stdio transport: newline-delimited JSON over the child's stdin/stdout), lists their
//! tools, and executes calls — so a server the user points the app at joins the Assistant's tool
//! surface without a line of new integration code per server.
//!
//! Architectural placement, the same split as `core::tools`: everything lives here, Tauri-free,
//! so the headless daemon reaches the same client; `tauri/mcp_cmds.rs` holds zero-behaviour
//! command wrappers. The Assistant-side registry merge and the `mcp_*` name dispatch live in the
//! webview (`lib/tools/mcp.ts` / `mcp-client.ts`).
//!
//! Deliberate MVP boundaries, recorded rather than hidden:
//!
//! - **stdio transport only.** Streamable HTTP servers come later; the connection object is
//!   shaped so a second transport can join without renaming the concept.
//! - **Assistant-side only.** The gateway's sandbox registry (`core/tool_registry.rs`) stays
//!   static: gateway clients own their tools, and auto-advertising third-party tools to every
//!   OpenAI-compatible client is a product decision, not a default.
//! - **No mid-call cancellation.** A `tools/call` runs to its timeout; the loop's Stop still
//!   works at the next tool boundary. The sandbox's `running_children` registry exists for a
//!   follow-up if long MCP calls ever need the Stop button mid-flight.
//! - **No `resources/` or `prompts/`** — tools only.
//!
//! Effect discipline: an MCP tool's `readOnlyHint` annotation is a *hint from the server*, so it
//! only ever relaxes the tool toward `read`; absence fails closed to `mutate`, exactly like
//! `toolEffect` treats a name it does not know. Approval therefore asks before any MCP call the
//! server did not mark read-only, which is the only safe default for third-party code.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::core::store::Store;
use crate::core::tools::ToolResult;

/// The `settings` row this module owns. The row is exclusively ours, so writes replace the whole
/// value — no read-modify-write merge, unlike the shared rows where that matters.
pub const SETTINGS_KEY: &str = "mcp";

const INIT_TIMEOUT_MS: u64 = 10_000;
const LIST_TIMEOUT_MS: u64 = 15_000;
const CALL_TIMEOUT_MS: u64 = 120_000;
/// Cursor-loop bound: a server that keeps handing back a `nextCursor` must not turn one listing
/// into an infinite conversation.
const MAX_LIST_PAGES: usize = 50;

/// One configured MCP server, as the user wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// Short identifier used in tool names (`mcp_{id}_{tool}`). Constrained to
    /// `[A-Za-z0-9_-]` so the composite name stays unambiguous to read.
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// The whole `settings` row body.
#[derive(Debug, Serialize, Deserialize, Default)]
struct ServersFile {
    #[serde(default)]
    servers: Vec<McpServerConfig>,
}

/// One discovered tool, as the webview registry bridge consumes it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    /// The tool's own name inside the server.
    pub tool: String,
    /// The registry name the model sees: `mcp_{server}_{tool}`.
    pub full_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The server's `readOnlyHint`. A hint, not a guarantee — which is why the approval policy
    /// treats it as the only thing that can soften `mutate` toward `read`, never the reverse.
    pub read_only: bool,
    /// JSON Schema `{properties, required}`, coerced from the server's `inputSchema`.
    pub parameters: Value,
}

/// What a refresh found: the live tools, and per-server failures that did not stop the others.
/// One broken server must not hide the tools of the nine healthy ones.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    pub tools: Vec<McpToolInfo>,
    pub failures: Vec<String>,
}

// ---------- config ----------

/// The configured servers. Absence and corruption collapse together (the tolerant-read
/// convention): an unusable row reads as "no servers configured", and the next save rewrites it.
pub fn servers_config(store: &Store) -> Vec<McpServerConfig> {
    let raw: Option<String> = {
        let conn = store.conn.lock().unwrap();
        conn.query_row(
            "SELECT value_json FROM settings WHERE key = ?",
            [SETTINGS_KEY],
            |r| r.get(0),
        )
        .ok()
    };
    let Some(raw) = raw else { return Vec::new() };
    serde_json::from_str::<ServersFile>(&raw).unwrap_or_default().servers
}

/// Validate and save the server list. Ids are constrained so `mcp_{id}_{tool}` stays readable
/// and no two servers can collide on a prefix split that would matter if a name were ever parsed.
pub fn save_servers_config(store: &Store, servers: &[McpServerConfig]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for s in servers {
        if s.id.is_empty() || s.id.len() > 32 {
            return Err(format!("server id {:?} must be 1-32 characters", s.id));
        }
        if !s.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(format!(
                "server id {:?} may only use letters, digits, '_' and '-'",
                s.id
            ));
        }
        if !seen.insert(s.id.clone()) {
            return Err(format!("duplicate server id {:?}", s.id));
        }
        if s.command.trim().is_empty() {
            return Err(format!("server {:?} needs a command", s.id));
        }
    }
    let body = serde_json::to_string(&ServersFile { servers: servers.to_vec() })
        .map_err(|e| e.to_string())?;
    let conn = store.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![SETTINGS_KEY, body],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- the client ----------

/// One live stdio connection: the child, its pipes, and a monotonically increasing request id.
/// Requests and calls are serialized through the state mutex — one in-flight JSON-RPC exchange
/// per process, which is all a single-user desktop client needs and the simplest way to keep
/// response ids matched to their asks.
pub struct McpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // A dropped connection must not leave a server process behind: whatever killed the map
        // entry (config removal, respawn, app exit path that drops state) is the verdict.
        let _ = self.child.start_kill();
    }
}

impl McpClient {
    /// Spawn the server process and run the initialize handshake. The child's environment is
    /// scrubbed to the same pass-through set the tool sandbox uses, plus the user's configured
    /// env — a server the user configured gets the secrets it was given, and nothing else.
    pub async fn spawn(cfg: &McpServerConfig) -> Result<McpClient, String> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Null, not piped: a chatty server writing to a full stderr pipe no one drains would
            // deadlock. Its stderr is its own business; our errors say which server failed.
            .stderr(Stdio::null())
            .env_clear();
        for key in ["PATH", "HOME", "TMPDIR", "LANG"] {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        // Same isolation as the sandbox's run_command: the server and anything it spawns sit in
        // their own process group, so a kill reaches the whole tree.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().process_group(0);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start MCP server {:?}: {e}", cfg.id))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP server {:?} gave no stdin", cfg.id))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP server {:?} gave no stdout", cfg.id))?;

        let mut client = McpClient {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        };
        client
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "ai-provider-router", "version": env!("CARGO_PKG_VERSION") },
                }),
                INIT_TIMEOUT_MS,
            )
            .await?;
        // The notification that completes the handshake. No id, no response expected.
        client.notify("notifications/initialized").await?;
        Ok(client)
    }

    /// One JSON-RPC request, matched to its response by id. Notifications and responses for
    /// other ids (leftovers from a timed-out earlier call) are skipped as they arrive.
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let mut line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            .to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("{method}: the server closed stdin ({e})"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("{method}: could not flush stdin ({e})"))?;

        let wait = async {
            loop {
                let mut buf = String::new();
                let n = self
                    .stdout
                    .read_line(&mut buf)
                    .await
                    .map_err(|e| format!("{method}: read failed ({e})"))?;
                if n == 0 {
                    return Err(format!("{method}: the server closed its output"));
                }
                // One message per line is the stdio transport's contract; a line that does not
                // parse is noise from a sloppy server, skipped rather than fatal.
                let Ok(v) = serde_json::from_str::<Value>(buf.trim()) else { continue };
                if v.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(err) = v.get("error") {
                    let message = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown JSON-RPC error");
                    return Err(format!("{method}: {message}"));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
        };
        tokio::time::timeout(Duration::from_millis(timeout_ms), wait)
            .await
            .map_err(|_| format!("{method}: no reply within {timeout_ms} ms"))?
    }

    /// One notification: fire and forget, no id, no response.
    async fn notify(&mut self, method: &str) -> Result<(), String> {
        let mut line = json!({ "jsonrpc": "2.0", "method": method }).to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("{method}: the server closed stdin ({e})"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("{method}: could not flush stdin ({e})"))
    }

    /// The server's tools, following cursors.
    async fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let result = self.request("tools/list", params, LIST_TIMEOUT_MS).await?;
            if let Some(page) = result.get("tools").and_then(Value::as_array) {
                tools.extend(page.iter().cloned());
            }
            match result.get("nextCursor").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => return Ok(tools),
            }
        }
        Err(format!(
            "tools/list did not finish within {MAX_LIST_PAGES} pages — the server's cursor loop does not end"
        ))
    }

    /// One tool call. Text content parts are concatenated; a part of any other type is reported
    /// as a placeholder so the model knows something came back that it cannot read as text.
    /// Transport failures are `Err` — a wedged pipe is worth one respawn-and-retry, while a
    /// genuine `isError` from the server is the tool's answer and must not be retried.
    async fn call_tool(&mut self, name: &str, arguments: &Value) -> Result<ToolResult, String> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
                CALL_TIMEOUT_MS,
            )
            .await?;
        let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let mut text = String::new();
        if let Some(parts) = result.get("content").and_then(Value::as_array) {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    Some(other) => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&format!("[non-text content of type {other:?} arrived — not rendered]"));
                    }
                    None => {}
                }
            }
        }
        // A call that succeeded and said nothing still owes the model a readable result — the
        // same honesty rule run_command applies to empty output.
        if text.is_empty() && !is_error {
            text = "(no output)".to_string();
        }
        Ok(ToolResult { ok: !is_error, output: text, error: None })
    }
}

/// Build the wire description of one tool from its `tools/list` entry. Returns `None` for an
/// entry without a name — a tool the model cannot be told to call is not a tool.
fn tool_info(server: &str, entry: &Value) -> Option<McpToolInfo> {
    let tool = entry.get("name").and_then(Value::as_str)?;
    if tool.is_empty() {
        return None;
    }
    let read_only = entry
        .pointer("/annotations/readOnlyHint")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // Only an object schema passes through; anything else the server declares becomes an empty
    // object schema, which the model reads as "no arguments" rather than as an uncallable tool.
    let schema_is_object =
        entry.get("inputSchema").and_then(|s| s.get("type")).and_then(Value::as_str) == Some("object");
    let parameters = if schema_is_object {
        let s = entry.get("inputSchema").expect("checked above");
        json!({
            "properties": s.get("properties").cloned().unwrap_or(json!({})),
            "required": s.get("required").cloned().unwrap_or(json!([])),
        })
    } else {
        json!({ "properties": {}, "required": [] })
    };
    Some(McpToolInfo {
        server: server.to_string(),
        tool: tool.to_string(),
        full_name: format!("mcp_{server}_{tool}"),
        description: entry
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        read_only,
        parameters,
    })
}

// ---------- shared state ----------

/// The live connections, keyed by server id. Managed once at app setup; the headless service
/// would construct its own.
#[derive(Default)]
pub struct McpState {
    clients: tokio::sync::Mutex<HashMap<String, McpClient>>,
}

impl McpState {
    /// (Re)list every enabled server's tools. A server that fails is reported in `failures` and
    /// costs the healthy servers nothing; connections for servers no longer configured or
    /// disabled are dropped (killing their processes via `Drop`).
    pub async fn refresh(&self, store: &Store) -> RefreshOutcome {
        let enabled: Vec<McpServerConfig> = servers_config(store)
            .into_iter()
            .filter(|s| s.enabled)
            .collect();
        let mut tools = Vec::new();
        let mut failures = Vec::new();
        let live: std::collections::HashSet<String> =
            enabled.iter().map(|s| s.id.clone()).collect();

        let mut clients = self.clients.lock().await;
        clients.retain(|id, _| live.contains(id));

        for cfg in &enabled {
            let listed = match clients.get_mut(&cfg.id) {
                Some(client) => match client.list_tools().await {
                    Ok(t) => Ok(t),
                    Err(e) => {
                        // The connection is wedged (dead child, wedged pipe): throw it away and
                        // try once from a fresh process before giving up on this server.
                        clients.remove(&cfg.id);
                        match McpClient::spawn(cfg).await {
                            Ok(mut fresh) => fresh.list_tools().await,
                            Err(spawn_err) => Err(format!("{e}; respawn also failed: {spawn_err}")),
                        }
                    }
                },
                None => match McpClient::spawn(cfg).await {
                    Ok(mut fresh) => {
                        let r = fresh.list_tools().await;
                        if r.is_ok() {
                            clients.insert(cfg.id.clone(), fresh);
                        }
                        r
                    }
                    Err(e) => Err(e),
                },
            };
            match listed {
                Ok(entries) => {
                    let mut count = 0;
                    for entry in &entries {
                        if let Some(info) = tool_info(&cfg.id, entry) {
                            tools.push(info);
                            count += 1;
                        }
                    }
                    if count == 0 {
                        failures.push(format!("server {:?} listed no tools", cfg.id));
                    }
                }
                Err(e) => {
                    failures.push(format!("server {:?}: {e}", cfg.id));
                    clients.remove(&cfg.id);
                }
            }
        }
        RefreshOutcome { tools, failures }
    }

    /// One tool call. A connection that died between refresh and call is respawned once — a tool
    /// call should not fail just because the user sat idle past the server's lifetime. A genuine
    /// `isError` from the server is the tool's answer and is returned as-is, never retried.
    pub async fn call(
        &self,
        store: &Store,
        server: &str,
        tool: &str,
        arguments: Value,
    ) -> ToolResult {
        let Some(cfg) = servers_config(store)
            .into_iter()
            .find(|s| s.id == server && s.enabled)
        else {
            return ToolResult::err(format!("unknown or disabled MCP server \"{server}\""));
        };

        let mut clients = self.clients.lock().await;
        let outcome = match clients.get_mut(server) {
            Some(client) => client.call_tool(tool, &arguments).await,
            None => {
                return match McpClient::spawn(&cfg).await {
                    Ok(mut fresh) => {
                        let r = fresh.call_tool(tool, &arguments).await;
                        if r.is_ok() {
                            clients.insert(server.to_string(), fresh);
                        }
                        r.unwrap_or_else(|e| ToolResult::err(&e))
                    }
                    Err(e) => ToolResult::err(&e),
                };
            }
        };
        match outcome {
            Ok(result) => result,
            Err(first) => {
                clients.remove(server);
                match McpClient::spawn(&cfg).await {
                    Ok(mut fresh) => {
                        let retry = fresh.call_tool(tool, &arguments).await;
                        if retry.is_ok() {
                            clients.insert(server.to_string(), fresh);
                        }
                        retry.unwrap_or_else(|second| {
                            ToolResult::err(format!("{first}; respawn also failed: {second}"))
                        })
                    }
                    Err(spawn_err) => {
                        ToolResult::err(format!("{first}; respawn also failed: {spawn_err}"))
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal but real MCP server: the handshake, one page of tools, and calls that answer,
    /// fail, and stay silent. Written to a temp dir and spawned through the same code path a
    /// configured server takes — a mock would not prove the framing works.
    const TEST_SERVER: &str = r#"
import sys, json

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

TOOLS = [
    {"name": "echo", "description": "echoes its argument",
     "inputSchema": {"type": "object",
                     "properties": {"text": {"type": "string"}},
                     "required": ["text"]}},
    {"name": "tick", "description": "a read-only tool",
     "annotations": {"readOnlyHint": True},
     "inputSchema": {"type": "object", "properties": {}}},
]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if "id" not in msg:
        continue
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"],
              "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                         "serverInfo": {"name": "test", "version": "0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": TOOLS}})
    elif method == "tools/call":
        params = msg.get("params", {})
        if params.get("name") == "echo":
            send({"jsonrpc": "2.0", "id": msg["id"],
                  "result": {"content": [{"type": "text",
                                          "text": "echo: " + params.get("arguments", {}).get("text", "")}],
                             "isError": False}})
        elif params.get("name") == "silent":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [], "isError": False}})
        else:
            send({"jsonrpc": "2.0", "id": msg["id"],
                  "result": {"content": [{"type": "text", "text": "no such tool here"}],
                             "isError": True}})
    else:
        send({"jsonrpc": "2.0", "id": msg["id"],
              "error": {"code": -32601, "message": "method not found"}})
"#;

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aiprovider-mcp-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_server(dir: &std::path::Path) -> std::path::PathBuf {
        let script = dir.join("mcp_test_server.py");
        std::fs::write(&script, TEST_SERVER).unwrap();
        script
    }

    fn server_config(id: &str, script: &std::path::Path) -> McpServerConfig {
        McpServerConfig {
            id: id.to_string(),
            command: "python3".to_string(),
            args: vec![script.display().to_string()],
            env: BTreeMap::new(),
            enabled: true,
        }
    }

    #[test]
    fn the_server_config_round_trips_validates_and_tolerates_garbage() {
        let dir = scratch_dir("cfg");
        let store = Store::open(&dir).unwrap();

        assert!(servers_config(&store).is_empty(), "no row means no servers");

        let servers = vec![
            server_config("alpha", std::path::Path::new("/tmp/x.py")),
            McpServerConfig {
                id: "beta".into(),
                command: "node".into(),
                args: vec!["server.js".into()],
                env: BTreeMap::from([("TOKEN".into(), "t".into())]),
                enabled: false,
            },
        ];
        save_servers_config(&store, &servers).unwrap();
        assert_eq!(servers_config(&store), servers);

        // Validation: duplicate ids and hostile id characters are refused before they can make
        // `mcp_{id}_{tool}` ambiguous or unreadable.
        let mut dup = servers.clone();
        dup.push(server_config("alpha", std::path::Path::new("/tmp/y.py")));
        assert!(save_servers_config(&store, &dup).is_err(), "duplicate id refused");
        let mut hostile = servers.clone();
        hostile[0].id = "a b.c".into();
        assert!(save_servers_config(&store, &hostile).is_err(), "hostile id refused");

        // A corrupt row reads as "no servers" rather than taking the feature down.
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("UPDATE settings SET value_json = 'not json' WHERE key = 'mcp'", []).unwrap();
        }
        assert!(servers_config(&store).is_empty(), "garbage collapses to empty");
    }

    #[test]
    fn a_tool_entry_becomes_a_wire_tool_with_a_fail_closed_effect() {
        let info = tool_info(
            "srv",
            &json!({
                "name": "search",
                "description": "finds things",
                "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] },
            }),
        )
        .expect("a named entry is a tool");
        assert_eq!(info.full_name, "mcp_srv_search");
        assert_eq!(info.server, "srv");
        assert_eq!(info.tool, "search");
        assert_eq!(info.description.as_deref(), Some("finds things"));
        assert!(!info.read_only, "no hint is fail-closed to mutate");
        assert_eq!(info.parameters["required"], json!(["q"]));

        let hinted = tool_info(
            "srv",
            &json!({ "name": "t", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object" } }),
        )
        .unwrap();
        assert!(hinted.read_only, "the hint is the only path to read");

        let coerced = tool_info("srv", &json!({ "name": "t", "inputSchema": { "type": "string" } })).unwrap();
        assert_eq!(coerced.parameters, json!({ "properties": {}, "required": [] }),
            "a non-object schema becomes an empty object schema, not an uncallable tool");

        assert!(tool_info("srv", &json!({ "description": "no name" })).is_none());
    }

    #[tokio::test]
    async fn a_real_stdio_server_initializes_lists_and_answers() {
        let dir = scratch_dir("live");
        let script = write_server(&dir);
        let cfg = server_config("test", &script);

        let mut client = McpClient::spawn(&cfg).await.expect("the handshake completes");
        let tools = client.list_tools().await.expect("tools/list");
        assert_eq!(tools.len(), 2, "got {:?}", tools);

        let echo = tool_info("test", &tools[0]).expect("echo is a tool");
        assert_eq!(echo.full_name, "mcp_test_echo");
        assert!(!echo.read_only);
        let tick = tool_info("test", &tools[1]).expect("tick is a tool");
        assert!(tick.read_only, "readOnlyHint travels");

        let ok = client.call_tool("echo", &json!({ "text": "hi" })).await.expect("the call reaches the server");
        assert!(ok.ok);
        assert_eq!(ok.output, "echo: hi");

        // A server-side isError is the tool's answer, not a transport failure.
        let failed = client.call_tool("no_such", &json!({})).await.expect("the call still reaches the server");
        assert!(!failed.ok);
        assert_eq!(failed.output, "no such tool here");

        let silent = client.call_tool("silent", &json!({})).await.expect("the call reaches the server");
        assert!(silent.ok);
        assert_eq!(silent.output, "(no output)", "empty output is reported, not passed through as nothing");
    }

    #[tokio::test]
    async fn refresh_lists_the_healthy_server_and_reports_the_broken_one() {
        let dir = scratch_dir("refresh");
        let script = write_server(&dir);
        let store = Store::open(&dir).unwrap();

        let servers = vec![
            server_config("good", &script),
            McpServerConfig {
                id: "broken".into(),
                command: "aiprovider-definitely-not-a-binary".into(),
                args: vec![],
                env: BTreeMap::new(),
                enabled: true,
            },
            {
                let mut disabled = server_config("off", &script);
                disabled.enabled = false;
                disabled
            },
        ];
        save_servers_config(&store, &servers).unwrap();

        let state = McpState::default();
        let outcome = state.refresh(&store).await;

        let names: Vec<&str> = outcome.tools.iter().map(|t| t.full_name.as_str()).collect();
        assert!(names.contains(&"mcp_good_echo"), "got {names:?}");
        assert!(names.contains(&"mcp_good_tick"), "got {names:?}");
        assert!(
            !names.iter().any(|n| n.starts_with("mcp_off_")),
            "a disabled server is not listed"
        );
        assert_eq!(outcome.failures.len(), 1, "got {:?}", outcome.failures);
        assert!(outcome.failures[0].contains("broken"), "the failure names its server: {:?}", outcome.failures);

        // And a call routes to the right server by id.
        let called = state
            .call(&store, "good", "echo", json!({ "text": "again" }))
            .await;
        assert!(called.ok, "the refresh left a live connection behind");
        assert_eq!(called.output, "echo: again");

        let unknown = state.call(&store, "ghost", "echo", json!({})).await;
        assert!(!unknown.ok, "an unknown server is a result, not a panic");
    }
}
