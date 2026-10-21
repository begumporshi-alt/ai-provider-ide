# Related Sessions: Cross-Agent Discovery & Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Assistant's session manifest discover, search, and import conversations from other AI coding agents (zcode, claude code, codex, qoder, plus our own router app), so prior work done in another tool becomes scoped, verified manifest material instead of a starting-from-scratch.

**Architecture:** Read-only Rust adapters (`core/agent_sources.rs`) normalize each agent's on-disk store behind one `AgentSource` trait. Discovery and search fan out over admin routes; import copies a capped, scrubbed, provenance-stamped snapshot into `session_messages` so every existing session tool works on it unchanged. The manifest composer gains a `related_sessions` section (separate ~120-token budget) fed by tier-1/tier-2 matches for the current root.

**Tech Stack:** Rust (rusqlite read-only, serde_json for JSONL), existing admin HTTP surface, existing `session_messages`/FTS5 stack, TS composer + registry + agentLoop patterns already shipped in the manifest work. No new dependencies.

**Spec:** This plan implements the "related sessions" feature agreed in conversation on 2026-10-20. Decisions locked by the user: (1) add a `root` column to `session_messages`; (2) skip VS Code Copilot in v1; (3) ship agent-facing tools together with the UI; (4) Workbuddy ships as an empty adapter. The on-disk recon (2026-10-20) established every store location below.

## Global Constraints

- **Foreign stores are read-only.** No adapter ever writes to another agent's data. The zcode DB is live (`-wal` present): open with `file:...?mode=ro` or copy-then-read; never hold a write lock.
- **Absence is not global** (inherited from the manifest work): a related-sessions read without a resolvable root returns keyword matches only, never "everything".
- **Import is per-session consent.** Nothing imports automatically; only an explicit user click or an approved `load_session` tool call imports.
- **Scrub before store.** The same secret-scrub the capture path applies runs over imported text before it lands in `session_messages`.
- **Migrations append.** 0034 follows 0033; version pins move together (`MIGRATIONS.len() + DATA_MIGRATIONS.len()`).
- **No new dependencies.** No new runtime crates or npm packages.
- **Every task ends green:** focused tests → relevant suite → `pnpm --filter ai-provider-router-desktop typecheck` → conventional commit. Do not stage `scratch/`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/core/agent_sources.rs` (new) | `AgentSource` trait, `SessionRef`, per-agent adapters, registry, search |
| `apps/desktop/src-tauri/src/core/agent_sources_tests.rs` (new) | Adapter + normalization tests against fixture files |
| `apps/desktop/src-tauri/src/core/gateway_admin.rs` | Admin handlers: list/search/import |
| `apps/desktop/src-tauri/src/core/gateway.rs` | Route registration |
| `apps/desktop/src-tauri/src/core/store.rs` | Migration 0034 (`root` on `session_messages`) |
| `apps/desktop/src-tauri/src/core/context.rs` | `SessionMessageRow.root`, append/read plumbing |
| `apps/desktop/src/store.ts` | `SessionMessageRow.root`, admin calls for sources |
| `apps/desktop/src/lib/memory/manifest.ts` | `related_sessions` section in composer |
| `apps/desktop/src/components/ManifestCard.tsx` | Related-sessions block with Load buttons |
| `apps/desktop/src/lib/tools/registry.ts` | `search_agents`, `load_session` specs |
| `apps/desktop/src/lib/tools/types.ts` | `AgentSourcePorts` |
| `apps/desktop/src/lib/tools/agentLoop.ts` | Tool dispatch |
| `apps/desktop/src/lib/chat/turn/agent-turn.ts` | Thread the port |
| `apps/desktop/src/screens/Assistant.tsx` | Build the section, wire the port, pass root on append |
| `apps/desktop/web-test/shim.ts` | Source emulation + fixture sessions |
| `apps/desktop/web-test/related-sessions.spec.ts` (new) | End-to-end proof |

---

### Task 1: The `AgentSource` trait, adapters, and the registry

**Files:**
- Create: `apps/desktop/src-tauri/src/core/agent_sources.rs`
- Create: `apps/desktop/src-tauri/src/core/agent_sources_tests.rs` (referenced via `#[cfg(test)]` module)
- Modify: `apps/desktop/src-tauri/src/core/mod.rs` (add `pub mod agent_sources;`)
- Test: fixtures under `apps/desktop/src-tauri/tests/fixtures/agent_sources/` (new)

**Interfaces:**
- Produces: `pub struct SessionRef { source: String, native_id: String, title: Option<String>, root: Option<String>, updated_at: i64, turn_estimate: usize, preview: String, native_path: String, readable: bool, note: Option<String> }`
- Produces: `pub struct NormalizedTurn { role: String, content: String, ts: i64, label: Option<String> }`
- Produces: `pub trait AgentSource { fn name(&self) -> &'static str; fn list(&self) -> Result<Vec<SessionRef>, String>; fn read(&self, native_id: &str) -> Result<Vec<NormalizedTurn>, String>; }`
- Produces: `pub fn all_sources() -> Vec<Box<dyn AgentSource>>` — zcode, claude, codex, qoder, router, workbuddy (empty stub), gemini (empty stub)

- [ ] **Step 1: Create the fixtures**

Create `apps/desktop/src-tauri/tests/fixtures/agent_sources/` with four minimal files whose shapes mirror the recon:

`claude-session.jsonl`:
```json
{"type":"user","sessionId":"c1a1a1a1-0000-0000-0000-000000000001","cwd":"/tmp/proj-alpha","timestamp":"2026-10-01T10:00:00Z","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"fix the flaky test"}}
{"type":"assistant","sessionId":"c1a1a1a1-0000-0000-0000-000000000001","cwd":"/tmp/proj-alpha","timestamp":"2026-10-01T10:00:05Z","uuid":"u2","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"The retry loop raced the fixture teardown. Patched."}]}}
```

`codex-session.jsonl`:
```json
{"type":"session_meta","session_id":"c0d3x000-0000-0000-0000-000000000002","cwd":"/tmp/proj-alpha","timestamp":"2026-10-02T09:00:00Z","originator":"codex_cli_rs","cli_version":"0.1.0","id":"c0d3x000-0000-0000-0000-000000000002","source":"vscode","thread_source":null,"base_instructions":null,"context_window":null,"dynamic_tools":null,"history_mode":null,"model_provider":null}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"input_text","text":"Ran the suite; two tests still flake on CI."}]},"timestamp":"2026-10-02T09:00:10Z"}
```

`qoder-session.jsonl`:
```json
{"type":"user","sessionId":"q0000000-0000-0000-0000-000000000003","cwd":"/tmp/proj-beta","timestamp":"2026-10-03T11:00:00Z","uuid":"q1","parentUuid":null,"message":{"role":"user","content":"why is the build slow?"}}
{"type":"assistant","sessionId":"q0000000-0000-0000-0000-000000000003","cwd":"/tmp/proj-beta","timestamp":"2026-10-03T11:00:07Z","uuid":"q2","parentUuid":"q1","message":{"role":"assistant","content":[{"type":"text","text":"The typecheck runs twice; dedupe the plugin."}]}}
```

`zcode-session.jsonl` (rollout shape, for the fallback path; the primary zcode adapter is SQLite and is tested against a temp store built with the real schema):
```json
{"type":"model_io_session","sessionId":"z0000000-0000-0000-0000-000000000004","startedAt":"2026-10-04T12:00:00Z","request":{"messages":[{"role":"user","content":"outline the release notes"}]},"response":{"content":"Draft: three highlights."},"model":"test-model","attempt":1,"durationMs":100,"completedAt":"2026-10-04T12:00:02Z","querySource":"test","requestId":"r1","traceId":"t1","turnId":"1"}
```

- [ ] **Step 2: Write the failing trait + adapter tests**

In `agent_sources_tests.rs` (registered from `agent_sources.rs` as `#[cfg(test)] mod tests;` with `#[path = "../tests/agent_sources_tests.rs"]`):

```rust
use super::*;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent_sources").join(name)
}

#[test]
fn the_claude_adapter_reads_a_transcript_and_resolves_its_root() {
    let src = ClaudeSource::new(fixture("claude-session.jsonl").parent().unwrap().to_path_buf());
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
    let src = CodexSource::new(fixture("codex-session.jsonl").parent().unwrap().to_path_buf());
    let refs = src.list().unwrap();
    assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-alpha"));
    let turns = src.read(&refs[0].native_id).unwrap();
    assert!(turns.iter().any(|t| t.content.contains("two tests still flake")));
}

#[test]
fn the_qoder_adapter_reads_the_claude_like_envelope() {
    let src = QoderSource::new(fixture("qoder-session.jsonl").parent().unwrap().to_path_buf());
    let refs = src.list().unwrap();
    assert_eq!(refs[0].source, "qoder");
    assert_eq!(refs[0].root.as_deref(), Some("/tmp/proj-beta"));
}

#[test]
fn an_unreadable_or_missing_store_reports_unavailable_not_an_error() {
    let src = ClaudeSource::new(PathBuf::from("/nonexistent/does-not-exist"));
    let refs = src.list().unwrap();
    assert!(refs.is_empty(), "a missing store yields zero refs, not a failure");
}

#[test]
fn the_registry_lists_every_source_including_the_empty_stubs() {
    let names: Vec<&str> = all_sources().iter().map(|s| s.name()).collect();
    assert_eq!(names, vec!["zcode", "claude", "codex", "qoder", "router", "workbuddy", "gemini"]);
    for s in all_sources() {
        let _ = s.list().unwrap(); // every adapter must succeed (possibly empty), never throw
    }
}

#[test]
fn content_longer_than_the_preview_is_clipped() {
    let src = ClaudeSource::new(fixture("claude-session.jsonl").parent().unwrap().to_path_buf());
    let refs = src.list().unwrap();
    assert!(refs[0].preview.chars().count() <= 200);
}
```

- [ ] **Step 3: Run them to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent_sources -- --nocapture`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the trait and adapters**

`agent_sources.rs` — key decisions to implement exactly:

- `SessionRef.preview`: first 200 chars of the first user message.
- Claude/qoder share one JSONL reader parameterized by directory + source name: iterate `*.jsonl` in `~/.claude/projects/**` (claude) or `~/.qoder/projects/**` (qoder); for each file, read the first line carrying `cwd` and the first `type:"user"` line for the preview; `native_id` = file stem; `updated_at` = file mtime; `turn_estimate` = count of lines whose `type` is `user` or `assistant`. `read()` streams the file line by line and maps: `type:"user"` → `role:"user"`, `type:"assistant"` → `role:"assistant"`; extract `message.content` — when it is a string use it, when it is an array join the `text` fields of `{"type":"text"}` parts; tool_use/tool_result/thinking lines become `role:"assistant"` with `label: Some("tool")` / `Some("thinking")` and a flattened text form. Skip `queue-operation`, `attachment`, and unknown types. Timestamps parse as RFC 3339 to epoch ms (hand-rolled parse; no chrono dependency — parse `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)` with a small helper; on failure use file mtime).
- Codex: iterate `~/.codex/sessions/**/*.jsonl`; first line must be `session_meta` — `native_id` = its `session_id`, `root` = its `cwd`. `response_item` lines map by `payload.type`: `message` → role from `payload.role`, text joined from `content[].text`; other payload types → `role:"assistant"`, `label: Some("tool")`, flattened summary. Skip `event_msg`.
- zcode: open `~/.zcode/cli/db/db.sqlite` with `rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY` plus `SQLITE_OPEN_NO_MUTEX`; `list()` runs `SELECT id, COALESCE(title,''), COALESCE(directory,''), time_updated FROM session ORDER BY time_updated DESC LIMIT 500` — never open in write mode, never create the file. `read()` loads `session_entry.data` for the session ordered by `time_created`, parses each JSON blob, and maps by its `type`/`role` fields defensively (the exact payload shape is only verified against the real DB at implementation time — see Task 1 note below). If the DB is missing or locked, return `Ok(vec![])` with `note: Some("store busy or absent")` on the source's status rather than erroring.
- Router: reads our own `session_messages` via the existing `Store` (passed in, not re-opened). `root` comes from the 0034 column; sessions from before it have `root: None` and match only by keyword.
- Workbuddy/gemini: `list()` returns `Ok(vec![])` and `read()` returns `Ok(vec![])` — the empty stubs. Their `SessionRef` never appears; the UI shows "no sessions found" for them.
- Every adapter resolves `~` via `std::env::var("HOME")` (fall back to empty and report unavailable when unset).
- `all_sources()` returns the seven adapters in the fixed order the test pins.

**Implementation-time verification note:** before writing the zcode `session_entry.data` mapping, run one read-only query against the live DB (`sqlite3 ~/.zcode/cli/db/db.sqlite "SELECT data FROM session_entry LIMIT 2"`) and record the actual JSON keys in the adapter's doc comment. If the shape differs from the assumption above, adjust the mapping to what is actually stored — the trait contract does not change.

- [ ] **Step 5: Run the tests to green**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent_sources -- --nocapture`
Expected: PASS. Then `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/core/agent_sources.rs apps/desktop/src-tauri/src/core/agent_sources_tests.rs apps/desktop/src-tauri/src/core/mod.rs apps/desktop/src-tauri/tests/fixtures/agent_sources
git commit -m "feat(sources): read-only adapters for every agent's session store"
```

---

### Task 2: Admin routes — list, search, import

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/gateway_admin.rs` (append handlers)
- Modify: `apps/desktop/src-tauri/src/core/gateway.rs` (routes after the memory block, before `/admin/memory/{id}` ordering comment)
- Modify: `apps/desktop/src-tauri/src/core/mod.rs` if re-exports are needed
- Test: `apps/desktop/src-tauri/src/core/gateway_tests.rs` (follow its existing harness patterns)

**Interfaces:**
- Produces: `GET /admin/sources` → `{ sources: [{ name, available, note?, session_count }] }`
- Produces: `GET /admin/sources/{name}/sessions?root=<filter>&q=<query>&limit=` → `{ sessions: SessionRef[] }` (when `q` is present, searches across ALL sources; when absent, lists that source only, filtered by `root` when given)
- Produces: `POST /admin/sources/import` body `{ source, native_id }` → `{ session_id, turns, truncated }`

- [ ] **Step 1: Write the failing handler tests**

In `gateway_tests.rs`, following the file's existing authenticated-request harness:

```rust
#[tokio::test]
async fn sources_list_reports_every_agent_with_availability() {
    let s = start_with_store().await;
    let res = s.authed_get("/admin/sources").await;
    assert!(res.status().is_success());
    let body: serde_json::Value = res.json().await.unwrap();
    let names: Vec<&str> = body["sources"].as_array().unwrap()
        .iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["zcode", "claude", "codex", "qoder", "router", "workbuddy", "gemini"]);
    // Every entry carries availability; the stubs report zero sessions without erroring.
    for src in body["sources"].as_array().unwrap() {
        assert!(src["available"].is_boolean());
    }
}

#[tokio::test]
async fn sources_search_requires_a_query_or_returns_the_source_listing() {
    let s = start_with_store().await;
    let res = s.authed_get("/admin/sources/claude/sessions").await;
    assert!(res.status().is_success()); // listing without q is fine
    let res = s.authed_get("/admin/sources/nope/sessions").await;
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn sources_import_rejects_an_unknown_source_and_requires_consent_fields() {
    let s = start_with_store().await;
    let res = s.authed_post("/admin/sources/import", &serde_json::json!({
        "source": "nope", "native_id": "x"
    })).await;
    assert_eq!(res.status(), 404);
}
```

Adjust the helper names to what `gateway_tests.rs` actually exposes (it has an authenticated client builder; reuse it).

- [ ] **Step 2: Run them to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml sources_ -- --nocapture`
Expected: FAIL — routes do not exist (404 where success is expected).

- [ ] **Step 3: Implement the handlers**

In `gateway_admin.rs`:

- `sources_list_h`: build `all_sources()`, call `list()` per source (each already returns `Ok(vec![])` when unavailable), map to `{ name, available: !refs.is_empty() || store_present, note, session_count }`. The router source reports `available` from its own store handle.
- `source_sessions_h`: `Path<String>` for the source name; unknown → 404 `unknown_source`. Query params: `root` (exact-match filter after canonicalization), `q` (when present, run the search across **all** sources: lowercase substring match over `title`, `preview`, and `root`, then rank by same-root-first, then `updated_at` desc; cap 50), `limit` (default 25, cap 100).
- `source_import_h`: body `{ source, native_id }`. Unknown source → 404. Resolve the adapter, `read(native_id)`, then:
  - **Scrub** every turn's content with the same routine `capture.rs` uses for secrets (call it; do not duplicate it).
  - **Cap** total imported text at 2 MB; set `truncated: true` and append a final synthetic turn `"[import truncated at the size cap; the original session is intact in <source>]"` when exceeded.
  - Mint `session_id = format!("imp-{source}-{}", short_hash(native_id))` — deterministic, so re-importing the same session is idempotent (the `(session_id, seq)` primary key makes the second write a no-op).
  - Map `NormalizedTurn` → `SessionMessageRow`: `role` as-is (`user|assistant|tool` — anything else becomes `assistant`), `content` = turn text (for labeled turns prefix `[tool: …] ` / `[thinking] `), `ts` = turn epoch ms, `model` = NULL, `tool_calls`/`tool_call_id`/`attachments`/`reasoning` = NULL, `root` = the session's resolved root (Task 3's column; write it now and let Task 3 add the column — order the tasks so this lands after).
  - Write through `context::append_session_messages`. Also write a title row via the existing `set_session_title` path: `"<source>: <first user preview, 60 chars>"`.
  - Respond `{ session_id, turns: <count>, truncated }`.
- All three handlers `authorize` first, like every admin route.

- [ ] **Step 4: Register the routes**

In `gateway.rs`, in the admin section (before the `/admin/memory/{id}` block is fine; any position before the catch-alls works since these are distinct prefixes):

```rust
        .route("/admin/sources", get(admin::sources_list_h))
        .route("/admin/sources/{name}/sessions", get(admin::source_sessions_h))
        .route("/admin/sources/import", post(admin::source_import_h))
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml sources_ -- --nocapture`
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml admin_routes_refuse -- --nocapture` (auth regression)
Expected: PASS. Add the three new routes to `admin_routes_refuse_without_the_master_key`'s enumeration (the Task-1-of-manifest-work pattern):

```rust
        ("GET", "/admin/sources", json!(null)),
        ("GET", "/admin/sources/claude/sessions", json!(null)),
        ("POST", "/admin/sources/import", json!({ "source": "claude", "native_id": "x" })),
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/core/gateway_admin.rs apps/desktop/src-tauri/src/core/gateway.rs apps/desktop/src-tauri/src/core/gateway_tests.rs
git commit -m "feat(sources): admin surface to list, search and import agent sessions"
```

---

### Task 3: Record the workspace root on our own sessions (migration 0034)

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/store.rs` (migration 0034 + version pins)
- Modify: `apps/desktop/src-tauri/src/core/context.rs` (`SessionMessageRow.root`, append/read SQL)
- Modify: `apps/desktop/src-tauri/src/tauri/commands.rs` if the row shape flows through command signatures (it should not — the row type carries it)
- Test: `apps/desktop/src-tauri/src/core/store.rs` migration test, `context.rs` row round-trip test

**Interfaces:**
- Produces: `session_messages.root TEXT` (nullable; NULL = recorded before 0034 or unknown)
- Produces: `SessionMessageRow { …, root: Option<String> }` — serde `default`, so existing callers compile unchanged

- [ ] **Step 1: Write the failing tests**

In `store.rs`'s migration test, bump every `33` pin to `34` (there are three: the schema_version assert, the `MIGRATIONS.len() + DATA_MIGRATIONS.len()` assert, and the AXIOM re-migration test — grep `schema_version` and the sum expression to catch all), and add:

```rust
        // 0034 added the workspace root to session_messages.
        let has_root: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('session_messages') WHERE name = 'root'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n > 0)
            .unwrap();
        assert!(has_root);
```

In `context.rs`'s transcript tests (the file has round-trip tests for `append_session_messages`; extend one):

```rust
    let rows = vec![SessionMessageRow {
        session_id: "s-root".into(), seq: 1, role: "user".into(),
        content: "hello".into(), tool_calls: None, tool_call_id: None,
        reasoning: None, attachments: None, model: None, ts: 1,
        root: Some("/tmp/proj-alpha".into()),
    }];
    append_session_messages(&store, &rows).unwrap();
    let back = session_messages(&store, "s-root").unwrap();
    assert_eq!(back[0].root.as_deref(), Some("/tmp/proj-alpha"));
```

Match the actual helper/function names in `context.rs`; the assertion is the contract.

- [ ] **Step 2: Run them to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml migrations_apply -- --nocapture`
Expected: FAIL — 33 ≠ 34.

- [ ] **Step 3: Add migration 0034 and the column**

In `store.rs`, append to `DATA_MIGRATIONS`:

```rust
    ("0034_session_root", add_session_messages_root),
```

Add the function near `create_session_messages`:

```rust
/// 0034 — the workspace root a session belongs to, recorded on its transcript rows.
///
/// Without it our own past sessions can only be matched to a workspace by keyword overlap, which
/// is the weakest tier of the related-sessions search. New rows carry the Assistant root from the
/// turn they were written in; rows from before the column read NULL and stay keyword-only.
fn add_session_messages_root(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    if !table_has_column(tx, "session_messages", "root")? {
        tx.execute_batch("ALTER TABLE session_messages ADD COLUMN root TEXT")?;
    }
    Ok(())
}
```

In `context.rs`: add `#[serde(default)] pub root: Option<String>` to `SessionMessageRow`; extend `append_session_messages`'s INSERT and the read SELECT to include `root`; every row constructor maps it.

- [ ] **Step 4: Record the root at write time**

In `apps/desktop/src/screens/Assistant.tsx`, `appendTranscript` builds `SessionMessageRow`s from the turn — pass `root: root.trim() || null` on each row (the `root` state is in scope at the call site). Update the TS `SessionMessageRow` type in `store.ts` with `root?: string | null`.

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml store:: context:: -- --nocapture`
Run: `pnpm --filter ai-provider-router-desktop typecheck`
Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/core/store.rs apps/desktop/src-tauri/src/core/context.rs apps/desktop/src/store.ts apps/desktop/src/screens/Assistant.tsx
git commit -m "feat(sessions): the workspace root rides on the durable transcript"
```

---

### Task 4: TS surface — sources client, composer section, card block

**Files:**
- Modify: `apps/desktop/src/store.ts` (wire types + admin calls)
- Modify: `apps/desktop/src/lib/memory/manifest.ts` (composer section)
- Modify: `apps/desktop/src/lib/memory/manifest.test.ts`
- Modify: `apps/desktop/src/components/ManifestCard.tsx`
- Modify: `apps/desktop/src/screens/Assistant.tsx` (fetch refs, pass to composer, render Load)
- Test: `apps/desktop/src/lib/memory/manifest.test.ts`

**Interfaces:**
- Produces: `listSourceSessions(opts: { source?: string; root?: string; q?: string; limit?: number }): Promise<SourceSessionRef[]>`
- Produces: `importAgentSession(source: string, nativeId: string): Promise<{ session_id: string; turns: number; truncated: boolean }>`
- Produces: `RelatedSession { id, source, title, root, updatedAt, preview }`
- Produces: `ComposedManifest.related: RelatedSession[]` and `MANIFEST_RELATED_BUDGET_TOKENS = 120`

- [ ] **Step 1: Write the failing composer tests**

In `manifest.test.ts`:

```ts
import { composeManifest, type RelatedSession } from "./manifest";

const rel = (over: Partial<RelatedSession> = {}): RelatedSession => ({
  id: "imp-claude-abc",
  source: "claude",
  title: "claude: fix the flaky test",
  root: "/tmp/next-app",
  updatedAt: 100,
  preview: "The retry loop raced the fixture teardown.",
  ...over,
});

it("carries same-workspace related sessions in the manifest", () => {
  const out = composeManifest([], snap(), 10_000, 100, [
    rel({ root: "/tmp/next-app" }),
    rel({ id: "other", source: "codex", root: "/tmp/elsewhere" }),
  ]);
  expect(out.related.map((r) => r.id)).toEqual(["imp-claude-abc"]);
  expect(out.block).not.toContain("fix the flaky test"); // facts block unchanged
  expect(out.relatedBlock).toContain("claude");
  expect(out.relatedBlock).toContain("fix the flaky test");
});

it("keeps the related block inside its own budget", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    rel({ id: `r${i}`, title: `session title number ${i} `.repeat(5), updatedAt: i }));
  const out = composeManifest([], snap(), 10_000, 100, many);
  expect(out.relatedTokens).toBeLessThanOrEqual(120);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/manifest.test.ts`
Expected: FAIL — no `related` parameter.

- [ ] **Step 3: Extend the composer**

In `manifest.ts`:

```ts
export interface RelatedSession {
  id: string;
  source: string;
  title: string;
  root: string | null;
  updatedAt: number;
  preview: string;
}

export const MANIFEST_RELATED_BUDGET_TOKENS = 120;
```

Extend `ComposedManifest` with `related: RelatedSession[]`, `relatedBlock: string`, `relatedTokens: number`. `composeManifest` gains a fifth parameter `related: readonly RelatedSession[] = []`:
- Filter to entries whose `root` matches the snapshot's workspace when the composer knows it — pass the root through `CapabilitySnapshot`? No: add `root?: string` to a new `ManifestScope { root?: string }` parameter object to avoid overloading the capability snapshot. Simplest contract: `composeManifest(memories, snap, budget, now, related, scope?: { root?: string })`; when `scope.root` is set, keep only related entries with `root === scope.root` (tier-1); when absent, keep none (absence is not global).
- Build `relatedBlock` with its own header `Related sessions from other agents — load with load_session if the user asks:` and one line per entry `- [claude] fix the flaky test (imp-claude-abc)`, greedy whole-line within `MANIFEST_RELATED_BUDGET_TOKENS`, same estimator as the fact block. Entries that do not fit stay in `related` for the card but not the block.
- `buildManifest` gains the same trailing parameters and forwards them.

- [ ] **Step 4: Wire the screen and the card**

In `store.ts`:

```ts
export interface SourceSessionRef {
  source: string; native_id: string; title: string | null; root: string | null;
  updated_at: number; turn_estimate: number; preview: string; native_path: string;
}

export async function listSourceSessions(opts: {
  source?: string; root?: string; q?: string; limit?: number;
} = {}): Promise<SourceSessionRef[]> {
  const qs = new URLSearchParams();
  if (opts.source) qs.set("source", opts.source); // unused by the route; kept for clarity
  if (opts.root) qs.set("root", opts.root);
  if (opts.q) qs.set("q", opts.q);
  if (opts.limit) qs.set("limit", String(opts.limit));
  return fetchAdminAs(
    "GET",
    `/admin/sources${opts.source ? `/${encodeURIComponent(opts.source)}` : ""}/sessions?${qs}`,
    arrayOf(isSourceSessionRef),
  );
}

export async function importAgentSession(source: string, nativeId: string) {
  return fetchAdminAs(
    "POST", "/admin/sources/import",
    (v): v is { session_id: string; turns: number; truncated: boolean } =>
      typeof v === "object" && v !== null && typeof (v as { session_id?: unknown }).session_id === "string",
    { source, native_id: nativeId },
  );
}
```

(Adjust the guard to the repo's `expectShapeOr` idiom if that is what sibling calls use.)

In `Assistant.tsx`, inside the manifest-building block added by the manifest work (after `buildManifest` resolves): fetch related refs when `root.trim()` — `listSourceSessions({ q: undefined, root: root.trim(), limit: 8 })` — and pass them as `related` with `scope: { root: root.trim() }`. A failed fetch yields `[]`, never a failed turn. Hold the raw refs in a ref (`relatedRef`) so the card's Load button can call `importAgentSession(ref.source, ref.native_id)` and then surface the returned `session_id` in a toast/status line.

In `ManifestCard.tsx`, add a `related` prop: when non-empty, render a second `<details>` block "Related sessions (N)" listing `source · title · date` with a `Load` button per row calling `onLoad(ref)`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/`
Run: `pnpm --filter ai-provider-router-desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/store.ts apps/desktop/src/lib/memory/manifest.ts apps/desktop/src/lib/memory/manifest.test.ts apps/desktop/src/components/ManifestCard.tsx apps/desktop/src/screens/Assistant.tsx
git commit -m "feat(manifest): related sessions from other agents ride the header"
```

---

### Task 5: The agent-facing tools — `search_agents`, `load_session`

**Files:**
- Modify: `apps/desktop/src/lib/tools/registry.ts` (two specs + `SUBAGENT_NEVER`)
- Modify: `apps/desktop/src/lib/tools/types.ts` (`AgentSourcePorts`)
- Modify: `apps/desktop/src/lib/tools/agentLoop.ts` (dispatch branch)
- Modify: `apps/desktop/src/lib/chat/turn/agent-turn.ts` (thread the port)
- Modify: `apps/desktop/src/screens/Assistant.tsx` (build the port)
- Test: `apps/desktop/src/lib/tools/registry.test.ts`, `apps/desktop/src/lib/tools/approval.test.ts`

**Interfaces:**
- Produces: `AgentSourcePorts { search(q: string, limit: number): Promise<SearchHit[]>; load(source: string, nativeId: string): Promise<{ sessionId: string; turns: number; truncated: boolean }> }`
- Produces: tools `search_agents` (effect `read`), `load_session` (effect `mutate` — it writes rows into our DB)

- [ ] **Step 1: Write the failing registry tests**

In `registry.test.ts` (extend the manifest-tools test's pattern):

```ts
it("exposes the cross-agent tools with the right effects and subagent exclusions", () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  expect(names).toContain("search_agents");
  expect(names).toContain("load_session");
  // load_session writes into the app's own store; it is a mutation like forget_memory.
  expect(toolEffect("load_session")).toBe("mutate");
  expect(toolEffect("search_agents")).toBe("read");
  for (const set of [subagentTools(false), subagentTools(true)]) {
    const sub = set.map((t) => t.name);
    expect(sub).not.toContain("search_agents");
    expect(sub).not.toContain("load_session");
  }
});
```

In `approval.test.ts`, add `"load_session"` to the sorted mutate list (and to the comment).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/tools/registry.test.ts src/lib/tools/approval.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the specs and dispatch**

`registry.ts`, after `forget_memory`:

```ts
  {
    name: "search_agents",
    effect: "read",
    description:
      "Search past sessions across every AI coding agent on this machine (zcode, claude code, codex, qoder, this app). Returns source, title, workspace and a preview per hit. Use it when the user asks about work done in another tool, or before starting something that may have prior art.",
    parameters: {
      properties: {
        query: { type: "string", description: "Words to look for in titles, previews and workspace paths." },
        limit: { type: "number", description: "Optional maximum hits (default 15, capped at 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "load_session",
    effect: "mutate",
    description:
      "Import one session found by search_agents into this app's history so it can be read with read_session. Only call this when the user asks to bring a session in. The id pair comes from search_agents.",
    parameters: {
      properties: {
        source: { type: "string", description: "The source exactly as search_agents returned it." },
        native_id: { type: "string", description: "The session's native id from search_agents." },
      },
      required: ["source", "native_id"],
    },
  },
```

Both names go into `SUBAGENT_NEVER` (a child neither searches the fleet nor imports).

`types.ts`:

```ts
export interface AgentSearchHit {
  source: string;
  nativeId: string;
  title: string | null;
  root: string | null;
  updatedAt: number;
  preview: string;
}

export interface AgentSourcePorts {
  search(query: string, limit: number): Promise<AgentSearchHit[]>;
  load(source: string, nativeId: string): Promise<{ sessionId: string; turns: number; truncated: boolean }>;
}
```

`agentLoop.ts`: destructure `agentSources` from the options; add a branch beside the manifest branch. `search_agents` validates the query (non-empty) and calls `agentSources.search(query, clamp(args.limit, 15, 50))`, formatting hits as one line each: `[<source>] <title or preview> — <root or "no workspace"> (<native_id>)`. `load_session` validates both args, calls `load`, and answers `imported <turns> turns from <source> as <sessionId>; read it with read_session` (plus the truncation notice when `truncated`). Port absent → the standard refusal sentence.

`agent-turn.ts`: add `agentSources?: Parameters<typeof runAgentLoop>[0]["agentSources"]` and pass it through. `Assistant.tsx` builds the port from `listSourceSessions` / `importAgentSession` and passes it in the `runAgentTurn` request.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/tools/`
Run: `pnpm --filter ai-provider-router-desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/tools apps/desktop/src/lib/chat/turn/agent-turn.ts apps/desktop/src/screens/Assistant.tsx
git commit -m "feat(assistant): the agent can search and import other agents' sessions"
```

---

### Task 6: End-to-end proof in the harness

**Files:**
- Modify: `apps/desktop/web-test/shim.ts` (source emulation with two fixture sessions)
- Create: `apps/desktop/web-test/related-sessions.spec.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the before/after proof the manifest work's Task 3 established as this repo's test standard

- [ ] **Step 1: Extend the shim**

Add to the shim's admin router:

```ts
    case "sources": {
      // Two fixture sessions: one in the current workspace, one elsewhere. Mirrors the real
      // adapter surface without spawning real agent stores.
      if (method === "GET" && segs.length === 3 && at(2) === "sources") { /* GET /admin/sources */ }
      if (method === "GET" && segs.length === 5 && at(3) === "sessions") {
        const q = (q.get("q") ?? "").toLowerCase();
        const root = q_root;
        const hits = FIXTURE_SESSIONS.filter((s) =>
          !q || s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q))
          .filter((s) => !root || s.root === root);
        return { sessions: hits };
      }
      if (method === "POST" && segs.length === 3 && at(2) === "import") {
        const b = body as { source: string; native_id: string };
        const hit = FIXTURE_SESSIONS.find((s) => s.source === b.source && s.native_id === b.native_id);
        if (!hit) refuse(404, "no such session", "unknown_session");
        // Import writes real session_messages rows through the shim's existing path.
        const sessionId = `imp-${b.source}-${b.native_id.slice(0, 8)}`;
        await dispatch("transcript_append", { rows: hit.turns.map((t, i) => ({
          session_id: sessionId, seq: i + 1, role: t.role, content: t.content, ts: t.ts,
        })) });
        return { session_id: sessionId, turns: hit.turns.length, truncated: false };
      }
      break;
    }
```

(Write it to match the shim's actual `at()`/`refuse` helpers and route shape.)

- [ ] **Step 2: Write the spec**

`related-sessions.spec.ts`:

```ts
test("related sessions: a foreign agent's session can be searched, imported and read", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  // Ask something whose answer the model can only give by searching: the fixture session's
  // title mentions the retry race, the question does not.
  await page.getByPlaceholder(/Message your assistant/)
    .fill("find the session about the flaky retry test and load it");
  await page.getByRole("button", { name: "Send" }).click();

  const body = await expect.poll(async () => lastBody(page), { timeout: 30_000 }).not.toBe("");
  // The search ran and the import landed in the app's own history.
  expect(body).toContain("search_agents");
});

test("related sessions: the manifest card lists and loads a same-workspace session", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/).fill("hello");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.getByTestId("manifest-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator("summary").click();
  await card.getByRole("button", { name: /Load imp-claude/ }).click();
  // The imported session is now in this app's history switcher.
  await expect(page.getByText(/claude: fix the flaky test/).first()).toBeVisible({ timeout: 30_000 });
});
```

(The first test's exact assertions depend on the mock model's tool behavior; if the mock cannot drive a two-step tool flow, assert on the egress body containing `search_agents` and on the imported session appearing after a direct `importAgentSession` call via `page.evaluate` — state which path the test took.)

- [ ] **Step 3: Run the full affected set**

Run: `pnpm --filter ai-provider-router-desktop typecheck`
Run: `pnpm --filter ai-provider-router-desktop test`
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Run: `pnpm --filter ai-provider-router-desktop web-test -- related-sessions.spec.ts memory-scope.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/web-test/shim.ts apps/desktop/web-test/related-sessions.spec.ts
git commit -m "test(assistant): cross-agent sessions are searchable, importable and readable"
```

---

## Self-Review

**Coverage:** discovery (T1), search + import surface (T2), our-own-sessions matching (T3), manifest section + card (T4), model tools (T5), proof (T6). All four user decisions are encoded: root column (T3), no Copilot (T1's adapter list), tools+UI together (T4+T5), Workbuddy stub (T1).

**Deliberate omissions:** no automatic import, no background sync, no Copilot adapter, no write-back to foreign stores, no embeddings. Keyword search is substring-based in v1 (BM25 over the combined set is a follow-up once SessionRefs are cached).

**Type consistency:** `SessionRef`/`NormalizedTurn` (Rust) ↔ `SourceSessionRef` (TS) field names match the JSON the handlers emit; `RelatedSession` is the composer's own shape, mapped from `SourceSessionRef` at the call site; `AgentSourcePorts` mirrors the two admin calls the port wraps.

## Final verification

```bash
pnpm --filter ai-provider-router-desktop typecheck
pnpm --filter ai-provider-router-desktop test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter ai-provider-router-desktop web-test -- related-sessions.spec.ts memory-scope.spec.ts memory-recall.spec.ts
```
