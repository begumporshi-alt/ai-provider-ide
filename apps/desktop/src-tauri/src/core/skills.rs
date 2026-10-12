/**
 * Skills (P5) — installable procedures, not tools.
 *
 * A skill is a markdown document: YAML frontmatter (name, description) plus a body of
 * instructions. It adds no capability the agent did not already have — the sandbox still only
 * allows the four tools in tools.rs. What it adds is *procedure*: how to go about a task the
 * user names in one word.
 *
 * That distinction matters for trust. Because a skill cannot widen the tool surface, the only
 * thing review has to establish is whether you want these instructions in your context — which
 * is why the body is stored, displayed before install, and shown again in the UI afterwards.
 *
 * Bodies live in the database rather than in files. They are small, they need to be listed and
 * filtered constantly, and keeping them in one store means uninstall is a single row delete
 * instead of a recursive delete on a user-supplied path.
 */
use serde::{Deserialize, Serialize};

use crate::core::store::Store;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Skill {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// `builtin` ships with the app and can be reinstalled after removal; `user` was added by
    /// the operator and is gone for good once revoked.
    pub source: String,
    pub body: String,
    pub enabled: bool,
    pub installed_at: i64,
}

/// Skills that ship with the app. Deliberately procedural: each one says how to approach a task
/// using tools the agent already has, and none of them claims a new one.
///
/// The set is kept small because every enabled entry costs a line in the agent's system prompt on
/// every turn, and a long menu makes the model choose worse. A skill earns its place by changing
/// what the agent does, not by describing what it knows — which is why these carry the lessons
/// that were paid for in this codebase (a protocol leak, a byte-sliced string) rather than general
/// advice. Read them as one table: a slug, a trigger, and the procedure that follows.
const BUILTINS: &[(&str, &str, &str, &str)] = &[
    (
        "byte-slice-panic",
        "Byte slice panic",
        "Diagnose a Rust crash from slicing a string at a byte index inside a character.",
        "A Rust process dies instead of reporting an error — often seen as a window that\n\
         disappears, or a crash that reproduces only in the packaged build.\n\n\
         1. Read the panic literally: the cut was at byte N, and bytes N..M are one multi-byte\n   \
         character sliced in half.\n\
         2. Check the release profile for `panic = \"abort\"`: it turns a contained panic into a\n   \
         process death, which is why a release-only crash is this bug until proven otherwise.\n\
         3. Audit the whole family, not just the failing line: `s[..n]`, `s[a..b]`, `s[n..]`,\n   \
         `truncate`, `split_at`, `split_off`, `drain`, `insert`, and byte slices cast back to\n   \
         `str`.\n\
         4. Suspect a clip at a length cap: `len - 1` plus an ellipsis puts a three-byte\n   \
         character across the boundary, which is why the same offset fails on every row rather\n   \
         than on rare input.\n\
         5. Walk the cut back to a character boundary before slicing, reusing the codebase's\n   \
         existing helper if it has one. A second copy of a known-correct helper is how the count\n   \
         grows.\n\
         6. Do not fix it by catching the panic, moving the cap, or `chars().take(n)` — that\n   \
         silently turns a byte cap into a character cap. Never strip non-ASCII from user data.\n\
         7. Prove the trigger before fixing: dump the bytes around the cap for the failing rows\n   \
         and assert the offset is not a boundary. Write the test, watch it panic, then fix it.\n\
         8. Cover a 4-byte character straddling the cap, and a cap that is not a multiple of 3\n   \
         or 4. Assert the output is valid UTF-8, within the cap plus the suffix, and that short\n   \
         input comes back untouched.",
    ),
    (
        "code-review",
        "Code review",
        "Review a change for correctness, security and clarity before it lands.",
        "Review the change the user points at.\n\n\
         1. Read the changed files. If a diff or branch is named, inspect that first.\n\
         2. Look for, in this order: correctness bugs, unhandled errors, security problems\n   \
         (injection, secrets in source, unvalidated input), then clarity.\n\
         3. Report as a short list: file, line, what is wrong, why it matters. Severity first.\n\
         4. Do not restate what the code does. Do not praise it.\n\
         5. If you find nothing, say so plainly rather than inventing minor style notes.",
    ),
    (
        "commit-message",
        "Commit message",
        "Write a conventional commit message from what actually changed.",
        "Write a commit message for the pending change.\n\n\
         1. Inspect the change; do not guess from the branch name.\n\
         2. First line: `type(scope): summary`, imperative, under 72 characters.\n   \
         Types: feat, fix, refactor, docs, test, chore.\n\
         3. Body: why the change was needed, not what it did — the diff already says what.\n\
         4. Note anything a reviewer must check.\n\
         5. Output only the message. Do not run git commit.",
    ),
    (
        "error-notes",
        "Error notes",
        "Record a diagnosed error and its fix, so no session diagnoses the same thing twice.",
        "Record an error once it is fixed, in one notes file kept with the project.\n\n\
         1. Write the entry at resolution time. An error still being diagnosed, or whose fix is\n   \
         not confirmed, is not an entry yet.\n\
         2. Search the notes for the same symptom before writing. If it is already there, add a\n   \
         dated recurrence line to that entry instead of a second entry.\n\
         3. One entry per error, in this order: date, the error output (its first lines, enough\n   \
         to recognize it), root cause, the fix, the exact commands, the files, and tags to\n   \
         search on.\n\
         4. Write the root cause as why it happened, not what it looked like. Write the fix in\n   \
         the imperative, as what was applied.\n\
         5. Record how the fix was verified — the test, command or output that proved it.\n\
         6. Never put secrets, tokens or credentials in an entry.\n\
         7. Skip trivia: a typo, a one-line slip, a failure only this machine will ever hit.\n\
         8. When an error appears, search the notes before diagnosing from scratch, and apply the\n   \
         recorded fix if it fits. If a recorded fix no longer works, say so and correct that\n   \
         entry rather than quietly starting over.",
    ),
    (
        "explain-code",
        "Explain code",
        "Explain a file, module or symbol to someone seeing it for the first time.",
        "Explain the code the user names.\n\n\
         1. Read it before explaining it. Never explain from the filename.\n\
         2. Lead with the one thing it is for, in a sentence.\n\
         3. Then the shape: entry points, the main data flow, and what it depends on.\n\
         4. Call out anything surprising or non-obvious — that is the part worth reading.\n\
         5. Say when you are unsure. A confident wrong explanation is worse than a gap.",
    ),
    (
        "fix-to-skill",
        "Capture the fix",
        "Turn a fix that just worked into a skill draft the operator can install.",
        "Turn a fix that just worked into a skill the operator can install.\n\n\
         This app cannot install a skill into itself. The deliverable is a complete draft — slug,\n\
         name, description, body — written out in the reply, ready to paste into the skills\n\
         screen.\n\n\
         1. Offer this only when the fix is applied and confirmed, non-trivial, and could recur.\n   \
         Skip typos, one-line tweaks and one-off configuration.\n\
         2. Reconstruct from this conversation: what was broken and how it showed, the root\n   \
         cause, the change or commands that fixed it, and how it was verified.\n\
         3. Name the trigger — the framework, file kind, error pattern or situation where this\n   \
         applies again.\n\
         4. Generalize. Strip project names, absolute paths and one-off values, replacing them\n   \
         with what the next user supplies.\n\
         5. Write the draft in the house format: a kebab-case slug, a two- or three-word name, a\n   \
         one-sentence description, and a body of one opening imperative sentence plus a numbered\n   \
         procedure of four to eight steps.\n\
         6. Put the durable insight in the body — symptom, root cause, steps, verification, edge\n   \
         cases — not a transcript of this session.\n\
         7. Present the whole draft in one pasteable block, and say plainly that it still needs\n   \
         installing. Never claim it is installed.\n\
         8. If the user declines, drop it and do not raise it again for this fix.",
    ),
    (
        "grill-plan",
        "Grill the plan",
        "Interview the user in rounds until a plan or design is settled, before any work starts.",
        "Interview the user until the plan is settled. Do not start work before that.\n\n\
         1. Map the work as a tree: the trunk is the goal, each branch is a decision (approach,\n   \
         scope, constraint, priority), and the branches below wait on the ones above.\n\
         2. Work it in rounds. A round is every decision whose prerequisites are already settled.\n\
         3. Ask the whole round at once. Number the questions and keep one decision in each —\n   \
         never combine two.\n\
         4. Give every question two to four concrete options and your recommendation, with each\n   \
         trade-off stated plainly.\n\
         5. Facts are yours to find. Look up anything the files or commands can answer; never ask\n   \
         the user for something you can verify yourself.\n\
         6. Decisions belong to the user. Ask, then wait. Do not answer your own question and act\n   \
         on it.\n\
         7. Settle the answers, recompute the round, ask the next one. Repeat until nothing is\n   \
         left and nothing has been silently assumed.\n\
         8. Confirm the shared understanding in a sentence, then start.\n\
         9. Do not use this when the request is already specific enough to act on. The gap it\n   \
         closes is between the request and the plan.",
    ),
    (
        "lean-reading",
        "Lean reading",
        "Keep context lean while exploring code and running commands, without losing information.",
        "Keep the context lean while reading code and running commands.\n\n\
         1. Read a file whole only when it is short — roughly under 150 lines — or is a config or\n   \
         data file. Round trips cost more than the tokens they save.\n\
         2. For anything larger, map it first: search for definitions, exported names and\n   \
         signatures, then read only the range around what you need.\n\
         3. Never read again what is already in this conversation. To confirm one fact, search\n   \
         for that fact.\n\
         4. Gather several facts from one file in a single read that covers them all, not one\n   \
         read each.\n\
         5. Verify your own edits with a diff, not by re-reading the file.\n\
         6. Keep command output lean: filter it, take the tail, pass the quiet flag. On success a\n   \
         one-line summary is enough; on failure the last lines hold the error.\n\
         7. Never pull generated files, lockfiles, build output or logs into the conversation.",
    ),
    (
        "protocol-leak-triage",
        "Protocol leak triage",
        "Diagnose raw protocol syntax leaking into visible model output, and fix it at the seam.",
        "Model output renders raw protocol syntax instead of prose — a JSON content-parts array\n\
         printed literally, in-band tool-call markup, or a chat-template sentinel.\n\n\
         1. Prove whose string it is before touching code. Pull the text from where the\n   \
         transcript is stored and try to parse it as the shape it claims to be.\n\
         2. Suspect the provider when it almost parses but does not: a serializer cannot emit an\n   \
         unescaped quote inside a string, and your own encoders are compact with a fixed key\n   \
         order — so pretty printing or reordered keys point upstream.\n\
         3. Group the offending messages by model and by provider. One model clean through one\n   \
         provider and dirty through another puts the fault in the provider, or a relay in front\n   \
         of it, not in the model and not in this client.\n\
         4. Fix at the seam where provider text becomes a message, once per engine, streaming\n   \
         included — never in the renderer, the store, or a token counter, and never by loosening\n   \
         a security boundary or asking the model to stop.\n\
         5. Decode strictly first: accept only when the whole value parses and every element\n   \
         carries exactly the expected text keys. Anything else, including JSON a user asked for,\n   \
         passes through untouched.\n\
         6. Salvage only after strict parsing fails, using the last quote before the next key:\n   \
         trim, strip a trailing comma, strip the quote, then unescape. A first-quote scan cuts\n   \
         real prose short at the first apostrophe inside the text.\n\
         7. Never decode per stream chunk. Hold back only while the buffer is a prefix of the\n   \
         opening marker, release it when it diverges, flush at end of stream even with no\n   \
         terminator, and fall back to the raw buffer on any path that cannot decode.\n\
         8. Verify with the malformed instance verbatim as a fixture, a false positive that\n   \
         merely has a text field of its own, a reply that starts with the marker and must still\n   \
         stream chunk by chunk, and a stream that ends without a terminator.",
    ),
    (
        "screen-design-brief",
        "Screen design brief",
        "Settle a screen's layout pattern, primary interaction and visible chrome before building it.",
        "Build or restructure a screen or component.\n\n\
         1. Before writing markup, leave a three-line note at the top of the file: the layout\n   \
         pattern, the single primary interaction, and what is visible before any scroll.\n\
         2. Choose the layout from the content: a constrained centred column for forms and\n   \
         settings, a wider one for dense tables, a full-height column with a pinned input and\n   \
         only the output scrolling for anything whose main act is composing text.\n\
         3. Order the page by the primary interaction: main controls first on configure screens,\n   \
         search and filters at the top on read screens, live status first on monitoring ones.\n\
         4. Keep one title, one primary action and one status indicator above the fold. If all\n   \
         three need a scroll, the screen is too dense — pull one up.\n\
         5. Reuse the components and variables already in the tree. Do not write a second input,\n   \
         modal, badge or empty state, and never hardcode a colour: every colour is a token, so a\n   \
         theme change stays in one place.\n\
         6. Spend one accent colour per screen, and reserve success, warning and danger tokens\n   \
         for status meaning only.\n\
         7. Let the screen that opens a modal own it. Separate list rows with borders rather than\n   \
         wrapping each row in a card — cards are for genuinely distinct groups.",
    ),
    (
        "subagent-dispatch",
        "Dispatch sub-agents",
        "Decide when to delegate to a sub-agent, and brief it so it can work from nothing.",
        "Delegate to a sub-agent only where it genuinely helps, and brief it fully.\n\n\
         1. Do the work directly when it is a question, a lookup, or a single-file edit. The\n   \
         overhead of delegation is larger than the saving.\n\
         2. Delegate when the work is broad or heavy: sweeping many files to answer one question,\n   \
         an independent review, a deep search, a second opinion on a design.\n\
         3. A sub-agent starts with an empty context and does not see this conversation. Its\n   \
         brief must carry the whole task: what to do, the file paths, the specific questions, the\n   \
         constraints, and what to return.\n\
         4. Ask for facts, not approval. 'Find where X calls Y' works; 'is this correct?' invites\n   \
         a confident guess.\n\
         5. Issue independent sub-agents in one batch so they run at the same time. One per\n   \
         message runs them one after another.\n\
         6. Never run two sub-agents that will edit the same files or the same state at once.\n   \
         Sequence those, or keep one of them read-only.\n\
         7. Keep the batch small — one or two that match the task. Fanning out everything buries\n   \
         the answer in reports.\n\
         8. Keep working while a sub-agent runs; do not sit idle on the thing that exists only to\n   \
         wait.\n\
         9. Report its findings as findings, attribute them, and never present a sub-agent's guess\n   \
         as verified fact.",
    ),
    (
        "test-writer",
        "Write tests",
        "Write focused tests for a module, covering behaviour rather than implementation.",
        "Write tests for the module the user names.\n\n\
         1. Read the module and any existing tests. Match the conventions already there.\n\
         2. Cover behaviour: normal path, edge cases, and the error cases the code claims to\n   \
         handle. Do not test private internals.\n\
         3. One assertion group per test. Name each test after the behaviour, not the method.\n\
         4. Write the file, then run the suite if the project has a runner available.\n\
         5. Report what you covered and, honestly, what you did not.",
    ),
    (
        "verify-before-done",
        "Verify before done",
        "Prove the work before calling it complete, and report the check that proved it.",
        "Before reporting any task complete.\n\n\
         1. Name the check that would prove this works: the test, the command, the request, the\n   \
         exact output to look for. If there is no such check, say so instead of implying one\n   \
         passed.\n\
         2. Run it freshly, after the last edit. A run from before the change proves nothing.\n\
         3. Read the output, not the exit code alone. A suite that reports '0 tests' passed\n   \
         nothing.\n\
         4. Change nothing between the verifying run and the report. If you touch the code again,\n   \
         run the check again.\n\
         5. When the check fails, report the failure with its output. Never describe an unverified\n   \
         change as working, and never soften a failure into 'should work now'.\n\
         6. When the check cannot be run — no runner, no credentials, no device — say plainly\n   \
         what was not verified and what the user must do to verify it.\n\
         7. Report in one line what was verified and by what, then what remains unverified. A\n   \
         passing build is not a passing test.",
    ),
];

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row(r: &rusqlite::Row<'_>) -> Result<Skill, rusqlite::Error> {
    Ok(Skill {
        id: r.get(0)?,
        slug: r.get(1)?,
        name: r.get(2)?,
        description: r.get(3)?,
        version: r.get(4)?,
        source: r.get(5)?,
        body: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        installed_at: r.get(8)?,
    })
}

const SELECT: &str =
    "SELECT id, slug, name, description, version, source, body, enabled, installed_at FROM skills";

/// Installed skills: user skills first, then builtins, each block ordered by name.
pub fn list(store: &Store) -> Result<Vec<Skill>, String> {
    seed_missing(store)?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{SELECT} ORDER BY source DESC, name ASC"))
        .map_err(|e| e.to_string())?;
    // Bound explicitly rather than returned as a tail expression: a chained `?` in tail
    // position keeps the borrowing temporary alive past the guard's drop.
    let rows = stmt.query_map([], row).map_err(|e| e.to_string())?;
    let out = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(out)
}

/// Settings key recording which builtin slugs have already been seeded into this database.
const SEEDED_KEY: &str = "skills_seeded_builtins";

/// The original boolean flag, still read and still written. Read, so an upgraded database does not
/// re-seed the builtins its operator deliberately revoked; written, so an older build that only
/// knows the flag cannot seed over the top of this one.
const LEGACY_SEEDED_KEY: &str = "skills_seeded";

/// The catalog as it shipped before it grew. Used once, to interpret a database that predates
/// [`SEEDED_KEY`] — never as a statement about the current catalog.
const ORIGINAL_SLUGS: &[&str] = &["code-review", "commit-message", "explain-code", "test-writer"];

/// Read one `settings` value, distinguishing "no such row" from a read that failed.
fn setting(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    match conn.query_row("SELECT value_json FROM settings WHERE key = ?1", [key], |r| r.get(0)) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The builtin slugs this database has already been given.
///
/// A database that predates the record is interpreted rather than assumed. If it carries the old
/// flag it holds the original catalog and nothing else, so that is what gets recorded: recording
/// the current catalog instead would claim ownership of builtins the operator never saw, and the
/// ones they had revoked would come back `ON CONFLICT DO NOTHING`-aside — which is exactly the
/// trap this mechanism exists to avoid. When in doubt, record less: the cost is a builtin being
/// placed a second time, the cost of the other error is a revoke button that does not stick.
///
/// A record that cannot be parsed is treated as absent, which sends it down the same cautious path
/// (the flag reading, or nothing on a fresh database). A read that *failed* is not treated as
/// absent: the fallback re-plants the newer builtins, so answering a database error with it could
/// resurrect one the operator revoked. That one is returned.
fn seeded_slugs(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    if let Some(raw) = setting(conn, SEEDED_KEY)? {
        if let Ok(slugs) = serde_json::from_str::<Vec<String>>(&raw) {
            return Ok(slugs);
        }
    }
    if setting(conn, LEGACY_SEEDED_KEY)?.is_some_and(|v| v == "1") {
        return Ok(ORIGINAL_SLUGS.iter().map(|s| (*s).to_string()).collect());
    }
    Ok(Vec::new())
}

/**
 * Seed the builtins this database has not been given yet.
 *
 * Seeding on every read would quietly undo the operator's revocation: remove a builtin and it
 * would reappear on the next refresh, which makes the revoke button a lie. So the seeding is
 * recorded — one `settings` row naming the slugs already placed here — and only the builtins
 * missing from that record are inserted.
 *
 * Recording per slug rather than as one flag is what lets the catalog grow. A revoked builtin
 * stays revoked and a disabled one stays disabled (both are recorded, and the conflict clause
 * never touches `enabled`), while a builtin added in a later release still lands on a database
 * that was seeded long ago. Without it, `BUILTINS` would only ever reach a fresh install — the
 * catalog is what an upgraded one sees — and new entries would have to be installed by hand.
 *
 * Two limits worth knowing. An already-placed row is never updated, so a later release that
 * *edits* a builtin's text does not reach an install that has it — revoke it and reinstall from
 * the catalog to pick up a changed body. And a slug is recorded as placed even when the insert was
 * suppressed by a row already there (an operator's own skill that happens to share the slug); that
 * skill keeps its place, and reinstalling the builtin from the catalog is the way back.
 */
fn seed_missing(store: &Store) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut known = seeded_slugs(&conn)?;
    let legacy_recorded = setting(&conn, LEGACY_SEEDED_KEY)?.is_some();

    let mut planted = false;
    for (slug, name, description, body) in BUILTINS {
        if known.iter().any(|k| k.as_str() == *slug) {
            continue;
        }
        conn.execute(
            "INSERT INTO skills (id, slug, name, description, version, source, body, enabled, installed_at)
             VALUES (?1,?2,?3,?4,'0.1.0','builtin',?5,1,?6)
             ON CONFLICT(slug) DO NOTHING",
            rusqlite::params![format!("builtin:{slug}"), slug, name, description, body, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        known.push((*slug).to_string());
        planted = true;
    }
    // The steady state: everything accounted for and both records already on disk. `list()` runs
    // on every agent turn, so a write here would be a write per turn for no change.
    if !planted && legacy_recorded {
        return Ok(());
    }

    let json = serde_json::to_string(&known).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1,?2)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![SEEDED_KEY, json],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1,'1')
         ON CONFLICT(key) DO UPDATE SET value_json='1'",
        rusqlite::params![LEGACY_SEEDED_KEY],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The builtin catalog, whether or not each entry is currently installed.
pub fn catalog() -> Vec<Skill> {
    BUILTINS
        .iter()
        .map(|(slug, name, description, body)| Skill {
            id: format!("builtin:{slug}"),
            slug: (*slug).to_string(),
            name: (*name).to_string(),
            description: (*description).to_string(),
            version: "0.1.0".into(),
            source: "builtin".into(),
            body: (*body).to_string(),
            enabled: false,
            installed_at: 0,
        })
        .collect()
}

/// Install a user skill. Rejects an empty name or body up front: a skill with no instructions
/// is not a skill, and letting one in would put an empty section in the agent's context.
pub fn install(
    store: &Store,
    slug: String,
    name: String,
    description: String,
    body: String,
) -> Result<Skill, String> {
    if slug.trim().is_empty() || name.trim().is_empty() || body.trim().is_empty() {
        return Err("a skill needs a slug, a name and instructions".into());
    }
    // Reinstalling a builtin from the catalog must restore it as a builtin, not turn it into a
    // user skill — otherwise the catalog and the installed list would disagree about its origin.
    let is_builtin = BUILTINS.iter().any(|(s, _, _, _)| *s == slug);
    let rec = Skill {
        id: if is_builtin { format!("builtin:{slug}") } else { format!("user:{slug}") },
        slug,
        name,
        description,
        version: "0.1.0".into(),
        source: if is_builtin { "builtin" } else { "user" }.into(),
        body,
        enabled: true,
        installed_at: now_ms(),
    };
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO skills (id, slug, name, description, version, source, body, enabled, installed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(slug) DO UPDATE SET
           name=excluded.name, description=excluded.description, body=excluded.body,
           source=excluded.source, installed_at=excluded.installed_at",
        rusqlite::params![
            rec.id, rec.slug, rec.name, rec.description, rec.version, rec.source,
            rec.body, rec.enabled as i64, rec.installed_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(rec)
}

/// Uninstall by slug — the `delete` on the Skills screen. No-op for a slug that is not installed:
/// uninstalling twice should not be an error, because the second call is the operator confirming a
/// state that already holds. The row goes; a builtin's catalog entry stays, which is what lets it
/// be installed again (see `catalog()`).
pub fn uninstall(store: &Store, slug: &str) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM skills WHERE slug = ?1", rusqlite::params![slug])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_enabled(store: &Store, slug: &str, enabled: bool) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE skills SET enabled = ?2 WHERE slug = ?1",
        rusqlite::params![slug, enabled as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Split `SKILL.md` text into frontmatter fields and body.
///
/// Tolerant on purpose: a missing or malformed frontmatter block is not an error, it is a skill
/// whose name has to be inferred. Rejecting it would punish a file that is otherwise perfectly
/// usable, and the caller shows the parsed result for confirmation either way.
pub fn parse_skill_md(text: &str) -> ParsedSkill {
    let mut name = String::new();
    let mut description = String::new();
    let mut body = text.to_string();

    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            body = rest[end + 4..].trim_start_matches('\n').to_string();
            for line in front.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
                    match k.trim() {
                        "name" => name = v,
                        "description" => description = v,
                        _ => {}
                    }
                }
            }
        }
    }
    ParsedSkill { name, description, body }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// Slug from a name: lowercase, alphanumeric and dashes only. Empty input yields a generated
/// slug rather than an empty one, because the slug is the skill's identity.
pub fn slugify(name: &str) -> String {
    let s: String =
        name.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_string();
    let collapsed: String = {
        let mut out = String::new();
        let mut last_dash = false;
        for c in s.chars() {
            if c == '-' {
                if !last_dash {
                    out.push(c);
                }
                last_dash = true;
            } else {
                out.push(c);
                last_dash = false;
            }
        }
        out
    };
    if collapsed.is_empty() {
        format!("skill-{}", now_ms())
    } else {
        collapsed
    }
}

#[cfg(test)]
mod skill_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-skill-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    /// The seeding record as stored, or `""` when there is none.
    fn seeded_record(s: &Store) -> String {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value_json FROM settings WHERE key = 'skills_seeded_builtins'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default()
    }

    #[test]
    fn every_builtin_body_is_a_numbered_procedure() {
        // The bodies are hand-wrapped string literals, so the failure mode is mechanical: a
        // continuation that swallowed a newline, a stray escape left in the text, or a wrapped
        // line that begins with something the model reads as a step number. This checks the shape
        // of every entry at once rather than trusting the table to have been edited carefully.
        for (slug, name, description, body) in BUILTINS {
            assert!(!name.trim().is_empty(), "{slug} has no name");
            assert!(!description.trim().is_empty(), "{slug} has no description");
            assert!(!body.contains('\\'), "{slug} carries a stray escape");
            assert!(
                body.lines().all(|l| !l.ends_with(' ')),
                "{slug} has a line with trailing space"
            );
            // The opening line names the trigger, and it is allowed to wrap: it is the paragraph
            // that has to read as a sentence, not the physical line.
            let opener = body.split("\n\n").next().unwrap_or_default();
            assert!(
                opener.starts_with(char::is_uppercase) && opener.ends_with('.'),
                "{slug} does not open with a sentence: {opener:?}"
            );

            // Steps numbered 1..n, in order, each on its own line. A continuation line that begins
            // with digits and a dot is caught here too — it reads as a step and would renumber the
            // procedure in the model's eyes.
            let numbers: Vec<usize> = body
                .lines()
                .filter_map(|line| {
                    let t = line.trim_start();
                    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if digits.is_empty() {
                        return None;
                    }
                    // `get` rather than a slice index: digits are ASCII, so this is a boundary,
                    // and a check that cannot panic is worth the extra word.
                    t.get(digits.len()..).filter(|rest| rest.starts_with(". "))?;
                    digits.parse::<usize>().ok()
                })
                .collect();
            assert!(numbers.len() >= 4, "{slug} has only {} steps", numbers.len());
            assert_eq!(
                numbers,
                (1..=numbers.len()).collect::<Vec<_>>(),
                "{slug} steps are not numbered 1..n in order"
            );
        }
    }

    #[test]
    fn builtins_are_present_without_an_install() {
        let (s, d) = temp_store("seed");
        let all = list(&s).unwrap();
        assert_eq!(all.len(), BUILTINS.len(), "expected the whole builtin catalog");
        let slugs: Vec<&str> = all.iter().map(|k| k.slug.as_str()).collect();
        for (slug, _, _, _) in BUILTINS {
            assert!(slugs.contains(slug), "{slug} missing from {slugs:?}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A database as an older build left it: the original builtins with `revoked` left out, the old
    /// boolean flag stamped, and — when `corrupt_record` — an unreadable per-slug record on top.
    fn legacy_store(tag: &str, corrupt_record: bool, revoked: &str) -> (Store, std::path::PathBuf) {
        let (s, d) = temp_store(tag);
        {
            let conn = s.conn.lock().unwrap();
            for (slug, name, description, body) in BUILTINS {
                if !ORIGINAL_SLUGS.contains(slug) || *slug == revoked {
                    continue; // not shipped by that build, or revoked by the operator
                }
                conn.execute(
                    "INSERT INTO skills (id, slug, name, description, version, source, body, enabled, installed_at)
                     VALUES (?1,?2,?3,?4,'0.1.0','builtin',?5,1,0)",
                    rusqlite::params![format!("builtin:{slug}"), slug, name, description, body],
                )
                .unwrap();
            }
            conn.execute("INSERT INTO settings (key, value_json) VALUES ('skills_seeded','1')", [])
                .unwrap();
            if corrupt_record {
                conn.execute(
                    "INSERT INTO settings (key, value_json) VALUES ('skills_seeded_builtins','not json')",
                    [],
                )
                .unwrap();
            }
        }
        (s, d)
    }

    #[test]
    fn a_builtin_added_later_lands_on_an_already_seeded_database() {
        // The catalog grows across releases, but the old seeding stamped a boolean and stopped, so a
        // new entry would reach fresh installs only. This stands up a database as an older build
        // left it — the four original builtins, one of them revoked, and the old flag — and checks
        // that the ones added since are recognized as unplaced and land, while the revoked one
        // stays revoked.
        let (s, d) = legacy_store("upgrade", false, "test-writer");

        let all = list(&s).unwrap();
        let slugs: Vec<&str> = all.iter().map(|k| k.slug.as_str()).collect();
        assert!(!slugs.contains(&"test-writer"), "the revoked original stayed revoked: {slugs:?}");
        for (slug, _, _, _) in BUILTINS {
            if *slug == "test-writer" {
                continue;
            }
            assert!(slugs.contains(slug), "{slug} never reached the upgraded database");
        }
        // And everything placed is recorded. Under-recording here looks harmless on this read —
        // `ON CONFLICT DO NOTHING` absorbs the re-insert — and only surfaces later, as a revoked
        // builtin coming back, so the record is asserted rather than inferred from the rows.
        let recorded: Vec<String> = serde_json::from_str(&seeded_record(&s)).unwrap();
        for (slug, _, _, _) in BUILTINS {
            assert!(recorded.iter().any(|r| r == slug), "{slug} was not recorded");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_builtin_revoked_after_an_upgrade_stays_revoked_too() {
        // The second upgrade: a record already exists, so the seeding extends it rather than
        // deriving it. A revoked slug has to survive that extension, which is the case the
        // legacy-flag test cannot reach — there the revoked slug is one the fallback names anyway.
        let (s, d) = temp_store("revoke-after-upgrade");
        list(&s).unwrap();
        uninstall(&s, "grill-plan").unwrap();
        assert!(!list(&s).unwrap().iter().any(|k| k.slug == "grill-plan"), "gone");
        assert!(
            seeded_record(&s).contains("grill-plan"),
            "the record still names it — that is what keeps it gone"
        );
        assert!(!list(&s).unwrap().iter().any(|k| k.slug == "grill-plan"), "still gone");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_record_falls_back_to_the_original_catalog() {
        // A record that cannot be parsed is treated as absent, and absence beside the legacy flag
        // means the original four. Pinning it because the fallback decides between two different
        // failures: read the record as the current catalog and the newer builtins never land at all
        // (13 rows expected, 3 present); read it as nothing and the revoked original comes back
        // (test-writer present).
        let (s, d) = legacy_store("corrupt-record", true, "test-writer");
        let all = list(&s).unwrap();
        let slugs: Vec<&str> = all.iter().map(|k| k.slug.as_str()).collect();
        assert_eq!(all.len(), BUILTINS.len() - 1, "the newer builtins still land: {slugs:?}");
        assert!(!slugs.contains(&"test-writer"), "the revoked original stayed revoked");
        let recorded: Vec<String> = serde_json::from_str(&seeded_record(&s)).unwrap();
        assert_eq!(recorded.len(), BUILTINS.len(), "and the record is rebuilt whole");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_builtin_seeded_once_is_not_seeded_again_on_the_next_read() {
        // `list()` runs on every agent turn, so the steady state has to be a pure read. Asserting
        // the record's value is not enough — rewriting identical bytes would pass that — so this
        // asserts the connection wrote nothing at all.
        let (s, d) = temp_store("idempotent");
        list(&s).unwrap();
        let first = seeded_record(&s);
        let changes_before = s.conn.lock().unwrap().total_changes();
        list(&s).unwrap();
        assert_eq!(first, seeded_record(&s), "the record is stable across reads");
        assert_eq!(
            changes_before,
            s.conn.lock().unwrap().total_changes(),
            "the steady-state read wrote to the database"
        );
        assert_eq!(list(&s).unwrap().len(), BUILTINS.len());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_revoked_builtin_stays_revoked() {
        // Seeding on every read would make the revoke button a lie: remove a builtin and it
        // would reappear on the next refresh.
        let (s, d) = temp_store("revoke-sticks");
        list(&s).unwrap();
        uninstall(&s, "code-review").unwrap();
        assert!(
            !list(&s).unwrap().iter().any(|k| k.slug == "code-review"),
            "revoking is respected across reads"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_revoked_builtin_can_be_reinstalled_from_the_catalog() {
        let (s, d) = temp_store("reinstall");
        list(&s).unwrap();
        uninstall(&s, "code-review").unwrap();
        let entry = catalog().into_iter().find(|k| k.slug == "code-review").unwrap();
        install(&s, entry.slug, entry.name, entry.description, entry.body).unwrap();
        let back = list(&s).unwrap();
        let it = back.iter().find(|k| k.slug == "code-review").unwrap();
        assert_eq!(it.source, "builtin", "reinstalled as a builtin, not demoted to user");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn installing_and_revoking_a_user_skill() {
        let (s, d) = temp_store("user");
        install(&s, "mine".into(), "Mine".into(), "does a thing".into(), "step one".into())
            .unwrap();
        assert!(list(&s).unwrap().iter().any(|k| k.slug == "mine"));
        uninstall(&s, "mine").unwrap();
        assert!(!list(&s).unwrap().iter().any(|k| k.slug == "mine"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn revoking_twice_is_not_an_error() {
        let (s, d) = temp_store("twice");
        uninstall(&s, "ghost").unwrap();
        uninstall(&s, "ghost").unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_skill_without_instructions_is_refused() {
        let (s, d) = temp_store("empty");
        assert!(install(&s, "x".into(), "X".into(), "d".into(), "   ".into()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn disabling_a_skill_keeps_it_but_drops_it_from_the_prompt() {
        let (s, d) = temp_store("disable");
        let before = list(&s).unwrap().iter().filter(|k| k.enabled).count();
        set_enabled(&s, "code-review", false).unwrap();
        let after = list(&s).unwrap().iter().filter(|k| k.enabled).count();
        assert_eq!(after, before - 1, "dropped from the prompt-eligible set");
        assert!(list(&s).unwrap().iter().any(|k| k.slug == "code-review"), "still installed");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn frontmatter_is_split_from_the_body() {
        let p = parse_skill_md("---\nname: Do It\ndescription: does it\n---\nfirst line\nsecond");
        assert_eq!(p.name, "Do It");
        assert_eq!(p.description, "does it");
        assert_eq!(p.body, "first line\nsecond");
    }

    #[test]
    fn a_file_with_no_frontmatter_is_still_usable() {
        let p = parse_skill_md("just instructions");
        assert_eq!(p.body, "just instructions");
        assert!(p.name.is_empty(), "name is inferred by the caller, not invented here");
    }

    #[test]
    fn slugify_is_stable_and_never_empty() {
        assert_eq!(slugify("Code Review"), "code-review");
        assert_eq!(slugify("  Weird!!  Name  "), "weird-name");
        assert!(!slugify("!!!").is_empty());
    }
}
