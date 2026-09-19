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

use crate::store::Store;

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

/// Skills that ship with the app. Deliberately few and deliberately procedural: each one says
/// how to approach a task using tools the agent already has, and none of them claims a new one.
const BUILTINS: &[(&str, &str, &str, &str)] = &[
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

/// Installed skills, newest first.
pub fn list(store: &Store) -> Result<Vec<Skill>, String> {
    seed_once(store)?;
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

/**
 * Seed the builtin catalog exactly once per database.
 *
 * Re-seeding on every read would quietly undo the operator's revocation: remove a builtin and
 * it would reappear on the next refresh, which makes the revoke button a lie. Seeding once and
 * recording that fact in `settings` means a revoked builtin stays revoked — and can still be
 * reinstalled deliberately, because the catalog is still available (`catalog()`).
 */
fn seed_once(store: &Store) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let already: bool = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = 'skills_seeded'",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(|v| v == "1")
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    for (slug, name, description, body) in BUILTINS {
        conn.execute(
            "INSERT INTO skills (id, slug, name, description, version, source, body, enabled, installed_at)
             VALUES (?1,?2,?3,?4,'0.1.0','builtin',?5,1,?6)
             ON CONFLICT(slug) DO NOTHING",
            rusqlite::params![format!("builtin:{slug}"), slug, name, description, body, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES ('skills_seeded','1')
         ON CONFLICT(key) DO UPDATE SET value_json='1'",
        [],
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

/// Revoke by slug. No-op for a slug that is not installed: revoking twice should not be an
/// error, because the second call is the operator confirming a state that already holds.
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

/// Bodies of the enabled skills, ready to be appended to an agent prompt.
pub fn enabled_bodies(store: &Store) -> Result<Vec<(String, String)>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT name, body FROM skills WHERE enabled = 1 ORDER BY name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let out = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(out)
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
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
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

    #[test]
    fn builtins_are_present_without_an_install() {
        let (s, d) = temp_store("seed");
        let all = list(&s).unwrap();
        assert!(all.len() >= 4, "expected the builtin catalog, got {}", all.len());
        assert!(all.iter().any(|k| k.slug == "code-review"));
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
        install(&s, "mine".into(), "Mine".into(), "does a thing".into(), "step one".into()).unwrap();
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
        list(&s).unwrap();
        let before = enabled_bodies(&s).unwrap().len();
        set_enabled(&s, "code-review", false).unwrap();
        assert_eq!(enabled_bodies(&s).unwrap().len(), before - 1);
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
