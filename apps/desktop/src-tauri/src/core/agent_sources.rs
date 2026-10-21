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
use serde::Serialize;
use serde_json::Value;

use crate::core::store::Store;

/// How much of the first user message is kept as a searchable preview.
pub const PREVIEW_CHARS: usize = 200;
/// How much of one tool result is kept when a session is read.
const TOOL_OUTPUT_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub source: String,
    pub native_id: String,
    pub title: Option<String>,
    pub root: Option<String>,
    pub updated_at: i64,
    /// The UI's `turns` (the wire contract the manifest card and its guards read), not a second
    /// estimate: the field is named for the adapter's job, and serialized for the consumer's.
    #[serde(rename = "turns")]
    pub turn_estimate: usize,
    pub preview: String,
    pub native_path: String,
    pub readable: bool,
    pub note: Option<String>,
    /// Set by the listing handlers when this session's derived id already has transcript rows.
    /// `None` means "not checked" — an adapter never writes to our store and cannot know.
    pub import_id: Option<String>,
}

/// The id `POST /admin/sources/import` derives for a foreign session.
///
/// Deterministic on purpose: re-importing the same session upserts the same rows instead of
/// minting a duplicate history. It lives here so the list handlers (which mark already-imported
/// rows) and the import handlers (which mint the id) cannot drift apart.
pub fn imported_session_id(source: &str, native_id: &str) -> String {
    format!("imp-{}-{:016x}", source, crate::core::gateway::context_scope::fnv1a(native_id))
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

/// What `admin_sources_list` returns: the host's view of one adapter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceListing {
    pub name: String,
    pub available: bool,
    pub session_count: usize,
    pub note: Option<String>,
}

/// What `admin_source_import` returns: the derived session id and the turn count stored.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub session_id: String,
    pub turns: usize,
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

/// Stream one JSONL file, handing each parsed line to `visit` in order.
///
/// Streaming rather than `read_to_end`: a Claude or Codex transcript with tool output reaches tens
/// of megabytes, and a `Vec<Value>` of that is several times the file in memory — while `list()`
/// touches every discovered file on every call. Returning `false` stops the walk, which is what
/// lets a reader dismiss a non-target rollout after its header line.
fn for_each_json_line(path: &Path, mut visit: impl FnMut(Value) -> bool) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if !visit(value) {
                return;
            }
        }
    }
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

/// What one envelope actually was, beyond its declared role.
///
/// A Claude `type:"user"` line can carry nothing but a `tool_result`, and an assistant line can be
/// pure reasoning. Reporting those as ordinary prose would import machine output as something the
/// human said — the role/label pair is what keeps the distinction.
fn envelope_label(parts: &Value) -> Option<&'static str> {
    let items = parts.as_array()?;
    let kinds: Vec<&str> =
        items.iter().filter_map(|p| p.get("type").and_then(Value::as_str)).collect();
    if kinds.is_empty() {
        return None;
    }
    let only = |allowed: &[&str]| kinds.iter().all(|k| allowed.contains(k));
    if only(&["tool_use", "tool_result"]) {
        return Some("tool");
    }
    if only(&["thinking"]) {
        return Some("thinking");
    }
    None
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
            // One streaming pass per file: keep only what a listing needs, then drop the handle.
            let mut root: Option<String> = None;
            let mut preview = String::new();
            let mut title = None;
            // The file mtime is only a fallback: a transcript's last envelope is older than the
            // file's write time, so folding the mtime into a running max would erase every real
            // timestamp.
            let mut parsed_ts: Option<i64> = None;
            let mut turns = 0usize;
            let mut looks_like_transcript = false;
            for_each_json_line(&path, |line| {
                let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
                if line.get("sessionId").is_some() && (kind == "user" || kind == "assistant") {
                    looks_like_transcript = true;
                }
                if kind == "user" || kind == "assistant" {
                    turns += 1;
                }
                if root.is_none() {
                    root = line.get("cwd").and_then(Value::as_str).map(str::to_string);
                }
                if let Some(ts) = line.get("timestamp").and_then(Value::as_str).and_then(rfc3339_ms)
                {
                    parsed_ts = Some(parsed_ts.map_or(ts, |cur| cur.max(ts)));
                }
                if kind == "user" && preview.is_empty() {
                    let text = line.get("message").map(message_text).unwrap_or_default();
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        preview = clip(trimmed, PREVIEW_CHARS);
                        title = Some(clip(trimmed, 60));
                    }
                }
                true
            });
            let updated = parsed_ts.unwrap_or_else(|| mtime_ms(&path));
            // A claude/qoder project dir should hold only its own transcripts, but a stray JSONL
            // must not become a session: require the envelope's session id and a real turn.
            if !looks_like_transcript {
                continue;
            }
            let native_id =
                path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            if native_id.is_empty() {
                continue;
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
                import_id: None,
            });
        }
        out.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
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
        let fallback_ts = mtime_ms(&path);
        for_each_json_line(&path, |line| {
            let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
            if kind != "user" && kind != "assistant" {
                return true;
            }
            let message = line.get("message").unwrap_or(&Value::Null);
            let text = message_text(message);
            if text.trim().is_empty() {
                return true;
            }
            // A user envelope holding only a tool_result is machine output, not something the
            // human typed; the label is what the importer keys off to keep the distinction.
            let label = envelope_label(message.get("content").unwrap_or(&Value::Null));
            let role = if label == Some("tool") { "assistant" } else { kind };
            turns.push(NormalizedTurn {
                role: role.to_string(),
                content: text,
                // Per-turn, never the file mtime: this turn's own stamp, or the fallback only
                // when the envelope carries none.
                ts: line
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(rfc3339_ms)
                    .unwrap_or(fallback_ts),
                label: label.map(str::to_string),
            });
            true
        });
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
            // One streaming pass: the metadata line comes first in a rollout file.
            let mut native_id = String::new();
            let mut root: Option<String> = None;
            let mut preview = String::new();
            let mut title = None;
            // Parsed timestamps only; the mtime is a fallback, never a contender for the max.
            let mut parsed_ts: Option<i64> = None;
            let mut turns = 0usize;
            for_each_json_line(&path, |line| {
                if line.get("type").and_then(Value::as_str) == Some("session_meta") {
                    if native_id.is_empty() {
                        native_id = line
                            .get("session_id")
                            .or_else(|| line.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        root = line.get("cwd").and_then(Value::as_str).map(str::to_string);
                    }
                    return true;
                }
                if line.get("type").and_then(Value::as_str) == Some("response_item") {
                    turns += 1;
                    if preview.is_empty() {
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
                if let Some(ts) = line.get("timestamp").and_then(Value::as_str).and_then(rfc3339_ms)
                {
                    parsed_ts = Some(parsed_ts.map_or(ts, |cur| cur.max(ts)));
                }
                true
            });
            let updated = parsed_ts.unwrap_or_else(|| mtime_ms(&path));
            if native_id.is_empty() {
                continue;
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
                import_id: None,
            });
        }
        out.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
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
            // A rollout file names its session on line one. Checking the header and stopping on
            // the first non-matching file is what keeps a read from parsing the whole tree.
            let mut is_target = false;
            let mut header_checked = false;
            let fallback_ts = mtime_ms(&path);
            for_each_json_line(&path, |line| {
                if !header_checked {
                    header_checked = true;
                    is_target = line.get("type").and_then(Value::as_str) == Some("session_meta")
                        && line
                            .get("session_id")
                            .or_else(|| line.get("id"))
                            .and_then(Value::as_str)
                            == Some(native_id);
                }
                if !is_target {
                    return false;
                }
                if line.get("type").and_then(Value::as_str) != Some("response_item") {
                    return true;
                }
                let payload = line.get("payload").unwrap_or(&Value::Null);
                let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
                let ts = line
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(rfc3339_ms)
                    .unwrap_or(fallback_ts);
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
                true
            });
            if is_target {
                break;
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
        let rows = match stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        }) {
            Ok(rows) => rows,
            // A store that cannot answer is unavailable, not a broken endpoint: one agent's
            // failure must not take the combined search down with it.
            Err(_) => return Ok(Vec::new()),
        };
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
                import_id: None,
            });
        }
        Ok(out)
    }

    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        let Some(conn) = self.open() else {
            return Ok(Vec::new());
        };
        let mut stmt = match conn.prepare(
            "SELECT m.id, m.time_created, m.data, COALESCE(p.data,'')
             FROM message m LEFT JOIN part p ON p.message_id = m.id
             WHERE m.session_id = ?1 ORDER BY m.sequence, p.sequence",
        ) {
            Ok(s) => s,
            // Same contract as `list`: an unreadable store is unavailable, not an error.
            Err(_) => return Ok(Vec::new()),
        };
        let rows = match stmt.query_map([native_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        }) {
            Ok(rows) => rows,
            Err(_) => return Ok(Vec::new()),
        };

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
        let Ok(conn) = store.conn.lock() else {
            return Ok(Vec::new());
        };
        let has_root = conn.prepare("SELECT root FROM session_messages LIMIT 1").is_ok();
        // Four queries total, not one per session: this holds the app's global store mutex, so an
        // N+1 here would stall every write while the search runs.
        let base = match conn.prepare(
            "SELECT session_id, MAX(ts), COUNT(*) FROM session_messages
             GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT 500",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })
                .map(|rows| rows.flatten().collect::<Vec<_>>())
                .unwrap_or_default(),
            Err(_) => return Ok(Vec::new()),
        };

        let mut previews: HashMap<String, String> = HashMap::new();
        // A correlated MIN subquery rather than `GROUP BY … HAVING seq = MIN(seq)`: the latter
        // relies on SQLite's bare-column behaviour and is easy to get subtly wrong.
        if let Ok(mut stmt) = conn.prepare(
            "SELECT m.session_id, m.content FROM session_messages m
             WHERE m.role = 'user'
               AND m.seq = (SELECT MIN(s.seq) FROM session_messages s
                            WHERE s.session_id = m.session_id AND s.role = 'user')",
        ) {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            {
                for (id, content) in rows.flatten() {
                    previews.insert(id, content);
                }
            }
        }

        let mut titles: HashMap<String, String> = HashMap::new();
        if let Ok(mut stmt) = conn.prepare("SELECT session_id, title FROM session_titles") {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            {
                for (id, title) in rows.flatten() {
                    titles.insert(id, title);
                }
            }
        }

        let mut roots: HashMap<String, String> = HashMap::new();
        if has_root {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT session_id, root FROM session_messages
                 WHERE root IS NOT NULL GROUP BY session_id",
            ) {
                if let Ok(rows) =
                    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                {
                    for (id, root) in rows.flatten() {
                        roots.insert(id, root);
                    }
                }
            }
        }

        let out = base
            .into_iter()
            .map(|(session_id, updated, turns)| {
                let preview = previews.get(&session_id).cloned().unwrap_or_default();
                SessionRef {
                    source: "router".into(),
                    title: titles.get(&session_id).cloned(),
                    root: roots.get(&session_id).cloned(),
                    native_id: session_id,
                    updated_at: updated,
                    turn_estimate: turns as usize,
                    preview: clip(&preview, PREVIEW_CHARS),
                    native_path: "session_messages".into(),
                    readable: true,
                    note: None,
                    import_id: None,
                }
            })
            .collect();
        Ok(out)
    }

    fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String> {
        let Some(store) = &self.store else {
            return Ok(Vec::new());
        };
        let Ok(conn) = store.conn.lock() else {
            return Ok(Vec::new());
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT role, content, ts FROM session_messages
             WHERE session_id = ?1 ORDER BY seq",
        ) else {
            return Ok(Vec::new());
        };
        let Ok(rows) = stmt.query_map([native_id], |r| {
            Ok(NormalizedTurn { role: r.get(0)?, content: r.get(1)?, ts: r.get(2)?, label: None })
        }) else {
            return Ok(Vec::new());
        };
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
        // Two fixtures live in this directory: the conversation and a long-preview case.
        assert_eq!(refs.len(), 2);
        let session = refs.iter().find(|r| r.root.as_deref() == Some("/tmp/proj-alpha")).unwrap();
        assert_eq!(session.source, "claude");
        assert!(session.preview.contains("flaky test"));
        let turns = src.read(&session.native_id).unwrap();
        assert_eq!(turns.len(), 5);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[4].role, "assistant");
        assert!(turns[4].content.contains("raced the fixture teardown"));
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
        // DDL transcribed from the live store (`sqlite3 'file:…?mode=ro' '.schema message'`,
        // 2026-10-20): the NOT NULLs and the `sequence` columns the adapter orders by are real,
        // so a mapping that drifted from the host schema would fail here rather than in
        // production.
        conn.execute_batch(
            r#"
CREATE TABLE session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        time_created integer not null,
        time_updated integer not null
      );
CREATE TABLE message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer);
CREATE TABLE part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      , sequence integer);
INSERT INTO session VALUES ('s1','p','w',NULL,'slug','/tmp/proj-alpha',NULL,'release notes','1',NULL,900,1000);
INSERT INTO message VALUES ('m1','s1',900,900,'{"role":"user"}',0);
INSERT INTO message VALUES ('m2','s1',950,950,'{"role":"assistant"}',1);
INSERT INTO part VALUES ('p1','m1','s1',900,900,'{"type":"text","text":"outline the release notes"}',0);
INSERT INTO part VALUES ('p2','m2','s1',950,950,'{"type":"text","text":"Draft: three highlights."}',0);
"#,
        ).unwrap();
        drop(conn);

        let src = ZcodeSource::at(db);
        let refs = src.list().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-alpha"));
        assert!(refs[0].preview.contains("outline the release notes"));
        let turns = src.read("s1").unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[1].content, "Draft: three highlights.");
        // Milliseconds since the host stores epoch millis; a seconds/millis mix-up shows here.
        assert_eq!(turns[0].ts, 900);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tool_only_envelope_imports_as_a_labeled_tool_turn() {
        let src = JsonlSource::at("claude", fixture("claude"));
        let turns = src.read("claude-session").unwrap();
        let tool = turns
            .iter()
            .find(|t| t.content.contains("src/retry.spec.ts:42"))
            .expect("the tool_result envelope is present");
        assert_eq!(tool.role, "assistant", "a tool result is not something the human typed");
        assert_eq!(tool.label.as_deref(), Some("tool"));
        let thinking = turns
            .iter()
            .find(|t| t.content.contains("teardown looks racy"))
            .expect("the thinking text is present");
        assert_eq!(thinking.label.as_deref(), Some("thinking"));
    }

    #[test]
    fn an_unreadable_or_missing_store_reports_unavailable_not_an_error() {
        let missing = PathBuf::from("/nonexistent/does-not-exist");
        for src in [
            Box::new(JsonlSource::at("claude", missing.clone())) as Box<dyn AgentSource>,
            Box::new(JsonlSource::at("qoder", missing.clone())),
            Box::new(CodexSource::at(missing.clone())),
            Box::new(ZcodeSource::at(missing.join("db.sqlite"))),
        ] {
            assert!(src.list().unwrap().is_empty(), "{} must degrade to empty", src.name());
            assert!(src.read("anything").unwrap().is_empty());
        }
    }

    #[test]
    fn the_registry_lists_every_source_in_the_ui_order() {
        let names: Vec<&str> = all_sources(None).iter().map(|s| s.name()).collect();
        assert_eq!(
            names,
            vec!["zcode", "claude", "codex", "qoder", "router", "workbuddy", "gemini"]
        );
        for source in all_sources(None) {
            assert!(source.list().is_ok(), "{} must never fail its listing", source.name());
        }
        let empty: Vec<Vec<SessionRef>> =
            all_sources(None).into_iter().map(|s| s.list().unwrap()).collect();
        // The two stubs are always empty; the real ones depend on this machine.
        assert!(empty[5].is_empty() && empty[6].is_empty());
    }

    #[test]
    fn previews_are_clipped_rather_than_truncated_mid_token() {
        let src = JsonlSource::at("claude", fixture("claude"));
        let refs = src.list().unwrap();
        let long = refs
            .iter()
            .find(|r| r.root.as_deref() == Some("/tmp/proj-long"))
            .expect("the long fixture is listed");
        // 400 x's in the source become PREVIEW_CHARS characters plus the ellipsis marker.
        assert_eq!(long.preview.chars().count(), PREVIEW_CHARS + 1);
        assert!(long.preview.ends_with('…'));
    }

    #[test]
    fn the_router_adapter_reads_its_own_transcript() {
        let dir = std::env::temp_dir().join(format!("aip-router-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = crate::core::store::Store::open(&dir).expect("open");
        {
            let conn = store.conn.lock().unwrap();
            conn.execute_batch(
                // Two user turns: the preview must be the FIRST one, which is what the
                // correlated MIN subquery pins.
                "INSERT INTO session_messages (session_id, seq, role, content, ts)
                 VALUES ('s-own',1,'user','why is the build slow',100),
                        ('s-own',2,'assistant','the typecheck runs twice',200),
                        ('s-own',3,'user','and the tests too',300);
                 INSERT INTO session_titles (session_id, title, updated_at)
                 VALUES ('s-own','build speed', 100);",
            )
            .unwrap();
        }
        let src = RouterSource::new(Some(Arc::new(store)));
        let refs = src.list().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].title.as_deref(), Some("build speed"));
        assert!(refs[0].preview.starts_with("why is the build slow"));
        let turns = src.read("s-own").unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[1].role, "assistant");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn jsonl_turns_keep_their_own_timestamps() {
        let src = JsonlSource::at("claude", fixture("claude"));
        let turns = src.read("claude-session").unwrap();
        // Not the file mtime: the envelope's own stamp, in epoch milliseconds.
        assert_eq!(turns[0].ts, rfc3339_ms("2026-10-01T10:00:00Z").unwrap());
        assert_eq!(turns[4].ts, rfc3339_ms("2026-10-01T10:00:09Z").unwrap());
        assert!(turns[0].ts < turns[4].ts);
    }

    #[test]
    fn a_non_target_rollout_is_dismissed_after_its_header() {
        let dir = std::env::temp_dir().join(format!("aip-codex-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // Two rollouts; the wanted one sorts second, so a reader that stops at the first
        // non-match still finds it.
        fs::write(
            dir.join("a-meta.jsonl"),
            "{\"type\":\"session_meta\",\"session_id\":\"other\",\"cwd\":\"/tmp/x\"}\n\
             {\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"wrong session\"}]},\"timestamp\":\"2026-10-01T00:00:00Z\"}\n",
        )
        .unwrap();
        fs::write(
            dir.join("b-meta.jsonl"),
            "{\"type\":\"session_meta\",\"session_id\":\"wanted\",\"cwd\":\"/tmp/y\"}\n\
             {\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"right session\"}]},\"timestamp\":\"2026-10-02T00:00:00Z\"}\n",
        )
        .unwrap();
        let src = CodexSource::at(dir.clone());
        let turns = src.read("wanted").unwrap();
        assert_eq!(turns.len(), 1);
        assert!(turns[0].content.contains("right session"));
        let _ = fs::remove_dir_all(&dir);
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
        let newest = &refs[0];
        assert!(newest.preview.len() > 10, "the live preview requires the real data/text keys");
        assert!(
            newest.updated_at > 1_600_000_000_000,
            "session.time_updated is epoch milliseconds, got {}",
            newest.updated_at
        );
        let turns = src.read(&newest.native_id).unwrap();
        assert!(!turns.is_empty(), "the newest session should have a readable transcript");
        assert!(
            turns.iter().any(|t| t.role == "user"),
            "a real transcript contains the user's prompts"
        );
        assert!(
            turns.iter().any(|t| t.ts > 1_600_000_000_000),
            "message.time_created is epoch milliseconds"
        );
    }
}
