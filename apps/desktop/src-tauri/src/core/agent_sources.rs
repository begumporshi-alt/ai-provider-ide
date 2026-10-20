//! Read-only adapters over every AI coding agent's session store.
//!
//! Each agent keeps conversations in a different place and shape. This module is the one place
//! that knows those differences: `AgentSource` exposes `list`/`read`, and every adapter degrades
//! to an empty result rather than a failure when its store is missing, locked, or unreadable.
//!
//! **zcode (verified against the live DB on 2026-10-20).** The transcript is not in
//! `session_entry` — that table is runtime state (model selection, workspace checkpoints). The
//! index is `session(id, title, directory, time_updated)`; the transcript is
//! `message(id, session_id, time_created, data)` where `data.role` is `user|assistant` and
//! `data.path.cwd` records the workspace, plus `part(message_id, data)` where `data.type` is
//! `text|tool|reasoning|…`. The database is live (`-wal` present), so it is opened READ_ONLY and
//! never created.
//!
//! **claude code / qoder.** `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` and
//! `~/.qoder/projects/<encoded-cwd>/<uuid>.jsonl`. The `cwd` field on each line is the root;
//! the directory name is only a hint (its dash encoding is lossy).
//!
//! **codex.** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; the first line is `session_meta`
//! with `session_id` and `cwd`, then `response_item` lines carry the conversation.
//!
//! **router.** Our own `session_messages`, grouped by session id. Rows recorded before migration
//! 0034 have no root and match only by keyword.
//!
//! Workbuddy and gemini have no conversation store on this machine; they ship as empty adapters
//! so the UI can say "nothing found" instead of "broken".

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::core::store::Store;

/// How much of the first user message is kept as a searchable preview.
pub const PREVIEW_CHARS: usize = 200;
/// How much of one tool result is kept when a session is read.
const TOOL_OUTPUT_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRef {
    pub source: String,
    pub native_id: String,
    pub title: Option<String>,
    pub root: Option<String>,
    pub updated_at: i64,
    pub turn_estimate: usize,
    pub preview: String,
    pub native_path: String,
    pub readable: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedTurn {
    pub role: String,
    pub content: String,
    pub ts: i64,
    pub label: Option<String>,
}

pub trait AgentSource {
    fn name(&self) -> &'static str;
    fn list(&self) -> Result<Vec<SessionRef>, String>;
    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String>;
}

// ---------- shared helpers ----------

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn clip(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_lines(path: &Path) -> Vec<Value> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect()
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            items.iter().map(value_text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n")
        }
        Value::Object(map) => {
            map.get("text").and_then(Value::as_str).map(str::to_string).unwrap_or_default()
        }
        _ => String::new(),
    }
}

/// Extract the prose of one message envelope. Text parts survive; tool parts become labeled
/// lines; reasoning is kept but labeled, so an import never mistakes a thought for an answer.
fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text") => part.get("text").and_then(Value::as_str).map(str::to_string),
                Some("input_text") | Some("output_text") => {
                    part.get("text").and_then(Value::as_str).map(str::to_string)
                }
                Some("tool_use") => Some(format!(
                    "[tool: {}]",
                    part.get("name").and_then(Value::as_str).unwrap_or("?")
                )),
                Some("tool_result") => {
                    let body = part.get("content").map(value_text).unwrap_or_default();
                    Some(format!("[tool result] {}", clip(&body, TOOL_OUTPUT_CHARS)))
                }
                Some("thinking") => part
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(|t| format!("[thinking] {}", clip(t, TOOL_OUTPUT_CHARS))),
                _ => None,
            })
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// RFC 3339 → epoch milliseconds. Hand-rolled because the crate deliberately carries no date
/// dependency; a malformed stamp falls back to the file mtime at the call site.
fn rfc3339_ms(input: &str) -> Option<i64> {
    let s = input.trim();
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;

    let (time, offset_secs) = if let Some(t) = rest.strip_suffix('Z') {
        (t, 0i64)
    } else if let Some((t, off)) = rest.rsplit_once('+') {
        (t, parse_offset(off)?)
    } else if let Some((t, off)) = rest.rsplit_once('-') {
        (t, -parse_offset(off)?)
    } else {
        (rest, 0)
    };

    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let sec_part = t.next()?;
    let (sec_str, frac) = sec_part.split_once('.').unwrap_or((sec_part, ""));
    let second: i64 = sec_str.parse().ok()?;
    let millis: i64 = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().take(3).collect();
        format!("{digits:0<3}").parse().ok()?
    };

    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) - offset_secs) * 1_000 + millis)
}

fn parse_offset(value: &str) -> Option<i64> {
    let (h, m) = value.split_once(':')?;
    Some(h.parse::<i64>().ok()? * 3_600 + m.parse::<i64>().ok()? * 60)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------- claude code / qoder ----------

pub struct JsonlSource {
    name: &'static str,
    base: Option<PathBuf>,
}

impl JsonlSource {
    pub fn claude() -> Self {
        Self { name: "claude", base: home().map(|h| h.join(".claude/projects")) }
    }

    pub fn qoder() -> Self {
        Self { name: "qoder", base: home().map(|h| h.join(".qoder/projects")) }
    }

    pub fn at(name: &'static str, base: PathBuf) -> Self {
        Self { name, base: Some(base) }
    }
}

impl AgentSource for JsonlSource {
    fn name(&self) -> &'static str {
        self.name
    }

    fn list(&self) -> Result<Vec<SessionRef>, String> {
        let Some(base) = &self.base else {
            return Ok(Vec::new());
        };
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut files = Vec::new();
        collect_jsonl(base, &mut files, 0);
        let mut out = Vec::new();
        for path in files {
            let lines = json_lines(&path);
            if lines.is_empty() {
                continue;
            }
            // A claude/qoder project dir should hold only its own transcripts, but a stray JSONL
            // must not become a session: require the envelope's session id and a real turn.
            let looks_like_transcript = lines.iter().any(|l| {
                l.get("sessionId").is_some()
                    && matches!(
                        l.get("type").and_then(Value::as_str),
                        Some("user") | Some("assistant")
                    )
            });
            if !looks_like_transcript {
                continue;
            }
            let native_id =
                path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            if native_id.is_empty() {
                continue;
            }
            let root =
                lines.iter().find_map(|l| l.get("cwd").and_then(Value::as_str)).map(str::to_string);
            let mut preview = String::new();
            let mut title = None;
            let mut updated = mtime_ms(&path);
            let mut turns = 0usize;
            for line in &lines {
                let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "user" || kind == "assistant" {
                    turns += 1;
                }
                if let Some(ts) = line.get("timestamp").and_then(Value::as_str).and_then(rfc3339_ms)
                {
                    updated = updated.max(ts);
                }
                if kind == "user" && preview.is_empty() {
                    let text = line.get("message").map(message_text).unwrap_or_default();
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        preview = clip(trimmed, PREVIEW_CHARS);
                        title = Some(clip(trimmed, 60));
                    }
                }
            }
            out.push(SessionRef {
                source: self.name.into(),
                native_id,
                title,
                root,
                updated_at: updated,
                turn_estimate: turns,
                preview,
                native_path: path.display().to_string(),
                readable: true,
                note: None,
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        let Some(base) = &self.base else {
            return Ok(Vec::new());
        };
        let mut files = Vec::new();
        collect_jsonl(base, &mut files, 0);
        let Some(path) =
            files.into_iter().find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(native_id))
        else {
            return Ok(Vec::new());
        };
        let mut turns = Vec::new();
        for line in json_lines(&path) {
            let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
            if kind != "user" && kind != "assistant" {
                continue;
            }
            let text = line.get("message").map(message_text).unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            turns.push(NormalizedTurn {
                role: kind.to_string(),
                content: text,
                ts: line
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(rfc3339_ms)
                    .unwrap_or_else(|| mtime_ms(&path)),
                label: None,
            });
        }
        Ok(turns)
    }
}

// ---------- codex ----------

pub struct CodexSource {
    base: Option<PathBuf>,
}

impl CodexSource {
    pub fn new() -> Self {
        Self { base: home().map(|h| h.join(".codex/sessions")) }
    }

    pub fn at(base: PathBuf) -> Self {
        Self { base: Some(base) }
    }
}

impl Default for CodexSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSource for CodexSource {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn list(&self) -> Result<Vec<SessionRef>, String> {
        let Some(base) = &self.base else {
            return Ok(Vec::new());
        };
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut files = Vec::new();
        collect_jsonl(base, &mut files, 0);
        let mut out = Vec::new();
        for path in files {
            let lines = json_lines(&path);
            let Some(meta) = lines
                .iter()
                .find(|l| l.get("type").and_then(Value::as_str) == Some("session_meta"))
            else {
                continue;
            };
            let native_id = meta
                .get("session_id")
                .or_else(|| meta.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if native_id.is_empty() {
                continue;
            }
            let root = meta.get("cwd").and_then(Value::as_str).map(str::to_string);
            let mut preview = String::new();
            let mut title = None;
            let mut updated = mtime_ms(&path);
            let mut turns = 0usize;
            for line in &lines {
                if line.get("type").and_then(Value::as_str) == Some("response_item") {
                    turns += 1;
                }
                if let Some(ts) = line.get("timestamp").and_then(Value::as_str).and_then(rfc3339_ms)
                {
                    updated = updated.max(ts);
                }
                if preview.is_empty()
                    && line.get("type").and_then(Value::as_str) == Some("response_item")
                {
                    let payload = line.get("payload").unwrap_or(&Value::Null);
                    if payload.get("type").and_then(Value::as_str) == Some("message")
                        && payload.get("role").and_then(Value::as_str) == Some("user")
                    {
                        let text = payload.get("content").map(value_text).unwrap_or_default();
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            preview = clip(trimmed, PREVIEW_CHARS);
                            title = Some(clip(trimmed, 60));
                        }
                    }
                }
            }
            out.push(SessionRef {
                source: "codex".into(),
                native_id,
                title,
                root,
                updated_at: updated,
                turn_estimate: turns,
                preview,
                native_path: path.display().to_string(),
                readable: true,
                note: None,
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        let Some(base) = &self.base else {
            return Ok(Vec::new());
        };
        let mut files = Vec::new();
        collect_jsonl(base, &mut files, 0);
        let mut turns = Vec::new();
        for path in files {
            let lines = json_lines(&path);
            let is_target = lines.iter().any(|l| {
                l.get("type").and_then(Value::as_str) == Some("session_meta")
                    && l.get("session_id").or_else(|| l.get("id")).and_then(Value::as_str)
                        == Some(native_id)
            });
            if !is_target {
                continue;
            }
            for line in &lines {
                if line.get("type").and_then(Value::as_str) != Some("response_item") {
                    continue;
                }
                let payload = line.get("payload").unwrap_or(&Value::Null);
                let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
                let ts = line
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(rfc3339_ms)
                    .unwrap_or_else(|| mtime_ms(&path));
                if kind == "message" {
                    let role = payload
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("assistant")
                        .to_string();
                    let text = payload.get("content").map(value_text).unwrap_or_default();
                    if !text.trim().is_empty() {
                        turns.push(NormalizedTurn { role, content: text, ts, label: None });
                    }
                } else {
                    let body = payload
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| kind.to_string());
                    turns.push(NormalizedTurn {
                        role: "assistant".into(),
                        content: format!("[tool: {body}]"),
                        ts,
                        label: Some("tool".into()),
                    });
                }
            }
        }
        Ok(turns)
    }
}

// ---------- zcode ----------

pub struct ZcodeSource {
    db: Option<PathBuf>,
}

impl ZcodeSource {
    pub fn new() -> Self {
        Self { db: home().map(|h| h.join(".zcode/cli/db/db.sqlite")) }
    }

    pub fn at(db: PathBuf) -> Self {
        Self { db: Some(db) }
    }

    fn open(&self) -> Option<Connection> {
        let path = self.db.as_ref()?;
        if !path.is_file() {
            return None;
        }
        Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
    }
}

impl Default for ZcodeSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSource for ZcodeSource {
    fn name(&self) -> &'static str {
        "zcode"
    }

    fn list(&self) -> Result<Vec<SessionRef>, String> {
        let Some(conn) = self.open() else {
            return Ok(Vec::new());
        };
        let mut stmt = match conn.prepare(
            "SELECT s.id, COALESCE(s.title,''), COALESCE(s.directory,''), s.time_updated,
                    (SELECT COUNT(*) FROM message m
                      WHERE m.session_id = s.id
                        AND json_extract(m.data,'$.role') IN ('user','assistant'))
             FROM session s ORDER BY s.time_updated DESC LIMIT 500",
        ) {
            Ok(s) => s,
            Err(_) => return Ok(Vec::new()),
        };
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows.flatten() {
            let (id, title, directory, updated, turns) = row;
            let preview = first_user_part(&conn, &id).unwrap_or_default();
            out.push(SessionRef {
                source: "zcode".into(),
                native_id: id,
                title: if title.trim().is_empty() { Some(clip(&preview, 60)) } else { Some(title) },
                root: if directory.trim().is_empty() { None } else { Some(directory) },
                updated_at: updated,
                turn_estimate: turns as usize,
                preview: clip(&preview, PREVIEW_CHARS),
                native_path: self.db.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
                readable: true,
                note: None,
            });
        }
        Ok(out)
    }

    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        let Some(conn) = self.open() else {
            return Ok(Vec::new());
        };
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.time_created, m.data, COALESCE(p.data,'')
                 FROM message m LEFT JOIN part p ON p.message_id = m.id
                 WHERE m.session_id = ?1 ORDER BY m.sequence, p.sequence",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([native_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, (i64, String, Vec<String>)> = HashMap::new();
        for row in rows.flatten() {
            let (id, ts, data, part) = row;
            let entry = groups.entry(id.clone()).or_insert_with(|| {
                order.push(id.clone());
                (ts, data, Vec::new())
            });
            if !part.is_empty() {
                entry.2.push(part);
            }
        }

        let mut turns = Vec::new();
        for id in order {
            let Some((ts, data, parts)) = groups.remove(&id) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            let role = meta.get("role").and_then(Value::as_str).unwrap_or("assistant").to_string();
            let mut content = String::new();
            for part in parts {
                let Ok(part) = serde_json::from_str::<Value>(&part) else {
                    continue;
                };
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                let text = match kind {
                    "text" => {
                        part.get("text").and_then(Value::as_str).unwrap_or_default().to_string()
                    }
                    "reasoning" => format!(
                        "[thinking] {}",
                        clip(
                            part.get("text").and_then(Value::as_str).unwrap_or_default(),
                            TOOL_OUTPUT_CHARS
                        )
                    ),
                    "tool" => {
                        let tool = part.get("tool").and_then(Value::as_str).unwrap_or("?");
                        let output = part
                            .get("state")
                            .and_then(|s| s.get("output"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        format!("[tool: {tool}] {}", clip(output, TOOL_OUTPUT_CHARS))
                    }
                    _ => String::new(),
                };
                if !text.trim().is_empty() {
                    if !content.is_empty() {
                        content.push('\n');
                    }
                    content.push_str(text.trim_end());
                }
            }
            if content.trim().is_empty() {
                continue;
            }
            turns.push(NormalizedTurn { role, content, ts, label: None });
        }
        Ok(turns)
    }
}

fn first_user_part(conn: &Connection, session_id: &str) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.data FROM message m JOIN part p ON p.message_id = m.id
             WHERE m.session_id = ?1
               AND json_extract(m.data,'$.role') = 'user'
               AND json_extract(p.data,'$.type') = 'text'
             ORDER BY m.sequence, p.sequence LIMIT 1",
        )
        .ok()?;
    let data: String = stmt.query_row([session_id], |r| r.get(0)).ok()?;
    let value: Value = serde_json::from_str(&data).ok()?;
    value.get("text").and_then(Value::as_str).map(str::to_string)
}

// ---------- router (this app) ----------

pub struct RouterSource {
    store: Option<Arc<Store>>,
}

impl RouterSource {
    pub fn new(store: Option<Arc<Store>>) -> Self {
        Self { store }
    }
}

impl AgentSource for RouterSource {
    fn name(&self) -> &'static str {
        "router"
    }

    fn list(&self) -> Result<Vec<SessionRef>, String> {
        let Some(store) = &self.store else {
            return Ok(Vec::new());
        };
        let conn = store.conn.lock().map_err(|e| e.to_string())?;
        let has_root = conn.prepare("SELECT root FROM session_messages LIMIT 1").is_ok();
        let mut stmt = conn
            .prepare(
                "SELECT session_id, MIN(ts), MAX(ts), COUNT(*)
                 FROM session_messages GROUP BY session_id
                 ORDER BY MAX(ts) DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows.flatten() {
            let (session_id, started, updated, turns) = row;
            let preview: String = conn
                .query_row(
                    "SELECT content FROM session_messages
                     WHERE session_id = ?1 AND role = 'user' ORDER BY seq LIMIT 1",
                    [&session_id],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM session_titles WHERE session_id = ?1",
                    [&session_id],
                    |r| r.get(0),
                )
                .ok()
                .flatten();
            let root: Option<String> = if has_root {
                conn.query_row(
                    "SELECT root FROM session_messages
                     WHERE session_id = ?1 AND root IS NOT NULL LIMIT 1",
                    [&session_id],
                    |r| r.get(0),
                )
                .ok()
            } else {
                None
            };
            let _ = started;
            out.push(SessionRef {
                source: "router".into(),
                native_id: session_id,
                title,
                root,
                updated_at: updated,
                turn_estimate: turns as usize,
                preview: clip(&preview, PREVIEW_CHARS),
                native_path: "session_messages".into(),
                readable: true,
                note: None,
            });
        }
        Ok(out)
    }

    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        let Some(store) = &self.store else {
            return Ok(Vec::new());
        };
        let conn = store.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT role, content, ts FROM session_messages
                 WHERE session_id = ?1 ORDER BY seq",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([native_id], |r| {
                Ok(NormalizedTurn {
                    role: r.get(0)?,
                    content: r.get(1)?,
                    ts: r.get(2)?,
                    label: None,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }
}

// ---------- empty stubs ----------

pub struct EmptySource {
    name: &'static str,
}

impl AgentSource for EmptySource {
    fn name(&self) -> &'static str {
        self.name
    }

    fn list(&self) -> Result<Vec<SessionRef>, String> {
        Ok(Vec::new())
    }

    fn read(&self, _native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        Ok(Vec::new())
    }
}

/// The one registry. The order is the UI's order and is pinned by a test.
pub fn all_sources(store: Option<Arc<Store>>) -> Vec<Box<dyn AgentSource>> {
    vec![
        Box::new(ZcodeSource::new()),
        Box::new(JsonlSource::claude()),
        Box::new(CodexSource::new()),
        Box::new(JsonlSource::qoder()),
        Box::new(RouterSource::new(store)),
        Box::new(EmptySource { name: "workbuddy" }),
        Box::new(EmptySource { name: "gemini" }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent_sources").join(name)
    }

    #[test]
    fn the_claude_adapter_reads_a_transcript_and_resolves_its_root() {
        let src = JsonlSource::at("claude", fixture("claude"));
        let refs = src.list().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source, "claude");
        assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-alpha"));
        assert!(refs[0].preview.contains("flaky test"));
        let turns = src.read(&refs[0].native_id).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[1].role, "assistant");
        assert!(turns[1].content.contains("raced the fixture teardown"));
    }

    #[test]
    fn the_codex_adapter_reads_session_meta_and_response_items() {
        let src = CodexSource::at(fixture("codex"));
        let refs = src.list().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-alpha"));
        let turns = src.read(&refs[0].native_id).unwrap();
        assert!(turns.iter().any(|t| t.content.contains("two tests still flake")));
    }

    #[test]
    fn the_qoder_adapter_reads_the_claude_like_envelope() {
        let src = JsonlSource::at("qoder", fixture("qoder"));
        let refs = src.list().unwrap();
        assert_eq!(refs[0].source, "qoder");
        assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-beta"));
    }

    #[test]
    fn the_zcode_adapter_reads_the_message_and_part_tables() {
        let dir = std::env::temp_dir().join(format!("aip-zcode-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("db.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, sequence INTEGER);
             INSERT INTO session VALUES ('s1','release notes','/tmp/proj-alpha', 1000);
             INSERT INTO message VALUES ('m1','s1',900,'{\"role\":\"user\"}',0);
             INSERT INTO message VALUES ('m2','s1',950,'{\"role\":\"assistant\"}',1);
             INSERT INTO part VALUES ('p1','m1','{\"type\":\"text\",\"text\":\"outline the release notes\"}',0);
             INSERT INTO part VALUES ('p2','m2','{\"type\":\"text\",\"text\":\"Draft: three highlights.\"}',0);",
        ).unwrap();
        drop(conn);

        let src = ZcodeSource::at(db);
        let refs = src.list().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-alpha"));
        assert!(refs[0].preview.contains("outline the release notes"));
        let turns = src.read("s1").unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].content, "Draft: three highlights.");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_or_missing_store_reports_unavailable_not_an_error() {
        let src = JsonlSource::at("claude", PathBuf::from("/nonexistent/does-not-exist"));
        assert!(src.list().unwrap().is_empty());
        assert!(src.read("anything").unwrap().is_empty());
    }

    #[test]
    fn the_registry_lists_every_source_in_the_ui_order() {
        let names: Vec<&str> = all_sources(None).iter().map(|s| s.name()).collect();
        assert_eq!(
            names,
            vec!["zcode", "claude", "codex", "qoder", "router", "workbuddy", "gemini"]
        );
        for source in all_sources(None) {
            assert!(source.list().unwrap().is_empty() || source.name() != "workbuddy");
        }
    }

    #[test]
    fn previews_and_content_stay_bounded() {
        let src = JsonlSource::at("claude", fixture("claude"));
        let refs = src.list().unwrap();
        assert!(refs[0].preview.chars().count() <= PREVIEW_CHARS + 1);
    }

    #[test]
    fn an_rfc3339_stamp_parses_to_epoch_millis() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_ms("2026-10-01T10:00:00Z"), Some(1_790_848_800_000));
        assert_eq!(rfc3339_ms("2026-10-01T10:00:00.250Z"), Some(1_790_848_800_250));
        assert_eq!(rfc3339_ms("not a date"), None);
    }

    /// Reads the real zcode store on this machine. Ignored in CI because it depends on the
    /// developer's `~/.zcode/cli/db/db.sqlite`; run with `--ignored` to prove the live WAL
    /// database opens read-only and yields a transcript.
    #[test]
    #[ignore = "reads the real zcode store"]
    fn live_zcode_store_is_readable() {
        let src = ZcodeSource::new();
        let refs = src.list().unwrap();
        assert!(!refs.is_empty(), "the live store should expose sessions");
        let turns = src.read(&refs[0].native_id).unwrap();
        assert!(!turns.is_empty(), "the newest session should have a readable transcript");
    }
}
