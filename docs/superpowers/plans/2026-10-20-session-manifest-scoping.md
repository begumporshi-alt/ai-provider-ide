# Session Manifest: Scoped Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-app Assistant's memory read path respect workspace scope, promote identity facts to global, keep retention running, and add a verified, auditable session manifest on top of the existing four-layer memory system.

**Architecture:** The Rust core already owns scoped recall (`memory::recall_scoped`), scope assignment, retention and the `memories` table. This plan stops routing the Assistant through the unscoped admin recall, adds a scoped list endpoint the Assistant can use for its always-on prefetch and manifest, then adds metadata, capability verification and a pure manifest composer. The gateway request path is not touched; its 15 ms read-only deadline and scoped recall stay exactly as they are.

**Tech Stack:** React 19 + Zustand webview, TypeScript, Vitest, Playwright (`web-test/`), Tauri 2, Rust, rusqlite/SQLite FTS5. No new runtime dependency.

**Spec:** `/Users/tushershikder/Desktop/SESSION-MANIFEST-SPEC.md` — read it together with this plan. The spec's diagnosis is corrected by `docs/superpowers/plans/2026-10-20-session-manifest-scoping.md`'s first five tasks; tasks 6–8 implement the parts of the spec that are genuinely missing.

---

## Global Constraints

- **Absence is not global.** Never treat a NULL project as a wildcard. A scoped read with no resolvable project returns pinned global rows only.
- **Capture is not injection.** New rows stay `Unscoped` until `assign_scope`/`memory_assign_scope` binds them. The only exception is L3 identity captured through `captureCore`, which is explicitly promoted by code.
- **The gateway hot path stays read-only.** Do not add retrieval-count writes to `context_scope::inject_context`; its 15 ms deadline and no-write rule are load-bearing.
- **Migrations append.** SQL migrations go at the end of `MIGRATIONS`; data migrations append to `DATA_MIGRATIONS`. Their versions are `MIGRATIONS.len() + idx + 1`. Never insert in the middle or reuse a number.
- **One workspace key algorithm.** Project keys stay `project_key_from_root` (FNV-1a of the trimmed root path, prefixed `p`). Do not reimplement it in TS except in the web-test shim, where it must match byte-for-byte.
- **No new dependencies.** Use `estimateMessageTokens` from `@aiprovider/router-core` for token accounting.
- **Every task ends green:** `pnpm --filter ai-provider-router-desktop typecheck`, the relevant Vitest/Rust/Playwright tests, then a conventional commit.

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/core/memory.rs` | Scoped listing, metadata fields, retrieval counter, kind classifier |
| `apps/desktop/src-tauri/src/core/gateway_admin.rs` | Admin HTTP bodies/handlers for scoped list and retrieval bump |
| `apps/desktop/src-tauri/src/core/gateway.rs` | Route registration |
| `apps/desktop/src-tauri/src/core/store.rs` | Data migrations 0032 and 0033 |
| `apps/desktop/src-tauri/src/core/retention.rs` | Unconditional retention pass |
| `apps/desktop/src/store.ts` | Wire types and admin calls (`listScopedMemories`, `markMemoriesRetrieved`) |
| `apps/desktop/src/lib/memory/engine.ts` | Scoped `recallContext`, global `captureCore` |
| `apps/desktop/src/lib/memory/manifest.ts` | Pure manifest composer + capability verifier (new) |
| `apps/desktop/src/lib/memory/retention.ts` | Unconditional webview retention pass |
| `apps/desktop/src/lib/chat/turn/ports.ts` | `manifestBlock` request field; manifest tool port |
| `apps/desktop/src/lib/chat/turn/prompt.ts` | Manifest block in both prompt builders |
| `apps/desktop/src/lib/chat/turn/agent-turn.ts` | Pass manifest into system prompt and loop |
| `apps/desktop/src/lib/chat/turn/plain-turn.ts` | Pass manifest into the plain request |
| `apps/desktop/src/lib/tools/registry.ts` | `read_manifest` / `forget_memory` tool specs |
| `apps/desktop/src/lib/tools/agentLoop.ts` | Tool dispatch |
| `apps/desktop/src/lib/tools/types.ts` | `ManifestPorts` |
| `apps/desktop/src/screens/Assistant.tsx` | Build manifest, thread it, render echo card |
| `apps/desktop/src/components/ManifestCard.tsx` | Session manifest echo (new) |
| `apps/desktop/web-test/shim.ts` | Scoped recall/list emulation + project-key hash |
| `apps/desktop/web-test/memory-scope.spec.ts` | End-to-end proof (new) |

---

## Phase A — Make the Assistant's read path scoped

### Task 1: Add the scoped list endpoint and project-root recall

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/memory.rs:583-636` (after `list`)
- Modify: `apps/desktop/src-tauri/src/core/gateway_admin.rs:1057-1086`
- Modify: `apps/desktop/src-tauri/src/core/gateway.rs:2457-2473`
- Test: `apps/desktop/src-tauri/src/core/memory.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces: `memory::list_scoped(store, scope: Option<&RecallScope>, limit: usize, pinned_only: bool) -> Result<Vec<Memory>, String>`
- Produces: `POST /admin/memory/scoped` body `{ project_root, limit?, pinned_only? }`
- Produces: `POST /admin/memory/recall` accepts optional `project_root`

- [ ] **Step 1: Write the failing Rust tests**

Append these tests next to the existing scope tests in `memory.rs` (after `unscoped_recall_still_sees_everything`):

```rust
#[test]
fn scoped_list_returns_only_global_identity_for_a_foreign_project() {
    let (s, d) = temp_store("scope-list-foreign");
    scoped(&s, "name", "L3", "I am Tushu", None, None, 1, 1);
    scoped(&s, "role", "L3", "I am a Software Engineer", None, None, 1, 1);
    scoped(
        &s,
        "tauri",
        "L1",
        "context graph engine lives at apps/desktop/src/lib/context/engine.ts",
        Some("p_tauri"),
        None,
        0,
        0,
    );
    scoped(&s, "stale", "L1", "git clone and git fetch are unavailable", None, None, 0, 0);

    let rows = list_scoped(&s, Some(&scope_of(Some("p_next"), None)), 50, false).unwrap();
    let mut ids: Vec<&str> = rows.iter().map(|m| m.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["name", "role"], "only global identity survives a foreign project");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn scoped_pinned_list_is_the_always_on_header() {
    let (s, d) = temp_store("scope-list-pinned");
    scoped(&s, "name", "L3", "I am Tushu", None, None, 1, 1);
    scoped(&s, "pref", "L1", "prefers terse replies", None, None, 1, 0);

    let rows = list_scoped(&s, Some(&scope_of(Some("p_next"), None)), 50, true).unwrap();
    let ids: Vec<&str> = rows.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["name"], "pinned_only narrows the manifest header");
    let _ = std::fs::remove_dir_all(&d);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml scoped_list -- --nocapture`
Expected: FAIL with `cannot find function list_scoped`.

- [ ] **Step 3: Implement `list_scoped`**

Append to `memory.rs` immediately after `list`:

```rust
/// Rows visible to `scope`, newest first. The Assistant uses this for its always-on
/// prefetch and for the session manifest; `pinned_only` narrows it to the operator's
/// hard constraints.
///
/// L0 is excluded unconditionally. It is verbatim conversation, and a 200-row window dominated
/// by L0 rows would starve the distilled layers the manifest is built from. The gateway's read
/// path makes the same exclusion for the same reason.
///
/// Visibility mirrors `recall_inner` exactly: an explicit global mark, or a project
/// match. An unresolved project sees pinned global rows only — never everything.
/// `scope: None` keeps the old unscoped behaviour for the Memory screen.
pub fn list_scoped(
    store: &Store,
    scope: Option<&RecallScope>,
    limit: usize,
    pinned_only: bool,
) -> Result<Vec<Memory>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT id, layer, text, session_id, subject, created_at, updated_at, pinned,
                scope_user, scope_project, scope_agent, scope_global, superseded_at
         FROM memories WHERE layer <> 'L0' AND superseded_at IS NULL",
    );
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(sc) = scope {
        if let Some(u) = &sc.user {
            args.push(Box::new(u.clone()));
            sql.push_str(&format!(" AND scope_user = ?{}", args.len()));
        }
        match &sc.project {
            Some(p) => {
                args.push(Box::new(p.clone()));
                let project = args.len();
                if let Some(a) = &sc.agent {
                    args.push(Box::new(a.clone()));
                    let agent = args.len();
                    sql.push_str(&format!(
                        " AND (scope_global = 1 OR (scope_project = ?{project} AND (scope_agent IS NULL OR scope_agent = ?{agent})))"
                    ));
                } else {
                    sql.push_str(&format!(" AND (scope_global = 1 OR scope_project = ?{project})"));
                }
            }
            None => sql.push_str(" AND scope_global = 1 AND pinned = 1"),
        }
    }
    if pinned_only {
        sql.push_str(" AND pinned = 1");
    }
    args.push(Box::new(limit as i64));
    sql.push_str(&format!(" ORDER BY pinned DESC, updated_at DESC LIMIT ?{}", args.len()));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())), |r| {
            Ok(Memory {
                id: r.get(0)?,
                layer: r.get(1)?,
                text: r.get(2)?,
                session_id: r.get(3)?,
                subject: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                pinned: r.get::<_, i64>(7)? != 0,
                scope: MemoryScope {
                    user: r.get(8)?,
                    project: r.get(9)?,
                    agent: r.get(10)?,
                    global: r.get::<_, i64>(11)? != 0,
                },
                score: None,
                superseded_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
```

- [ ] **Step 4: Extend the admin recall body and add the scoped list handler**

In `gateway_admin.rs`, replace `MemoryRecallBody` with:

```rust
#[derive(Deserialize)]
pub struct MemoryRecallBody {
    pub query: String,
    pub limit: Option<usize>,
    pub layers: Option<Vec<String>>,
    /// Workspace root; resolved host-side to the same project key the gateway uses.
    /// Omitted means the Memory screen's intentional global search.
    pub project_root: Option<String>,
}

#[derive(Deserialize)]
pub struct ScopedListBody {
    pub project_root: Option<String>,
    pub limit: Option<usize>,
    pub pinned_only: Option<bool>,
}
```

Replace the recall call in `memory_recall_h` with:

```rust
    let scope = body
        .project_root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .and_then(crate::core::context_scope::project_key_from_root)
        .map(|project| memory::RecallScope {
            user: None,
            project: Some(project),
            agent: None,
        });
    let limit = body.limit.unwrap_or(8);
    let result = match scope {
        Some(sc) => memory::recall_scoped(store, &body.query, limit, body.layers.as_deref(), &sc),
        None => memory::recall(store, &body.query, limit, body.layers.as_deref()),
    };
    match result {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not recall: {e}"),
            Some("memory_recall_failed"),
        ),
    }
```

Append the scoped list handler after `memory_recall_h`:

```rust
/// `POST /admin/memory/scoped` — rows visible to one workspace. This is the Assistant's
/// read surface: the same predicate `recall_scoped` applies, without the FTS query, so
/// identity/preferences can ride along even when the user's turn shares no words with them.
pub async fn memory_scoped_list_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<ScopedListBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers).await {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/scoped") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    let Some(project) = body
        .project_root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .and_then(crate::core::context_scope::project_key_from_root)
    else {
        return admin_error(
            StatusCode::BAD_REQUEST,
            "project_root is required and must resolve to a workspace",
            Some("scope_required"),
        );
    };
    let scope = memory::RecallScope {
        user: None,
        project: Some(project),
        agent: None,
    };
    match memory::list_scoped(store, Some(&scope), body.limit.unwrap_or(200), body.pinned_only.unwrap_or(false)) {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not list scoped memories: {e}"),
            Some("memory_scope_list_failed"),
        ),
    }
}
```

- [ ] **Step 5: Register the route**

In `gateway.rs`, after the `/admin/memory/recall` route:

```rust
        .route("/admin/memory/scoped", post(admin::memory_scoped_list_h))
```

Keep it above `/admin/memory/{id}` so the static segment wins.

- [ ] **Step 6: Run the Rust tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml memory:: -- --nocapture`
Expected: PASS, including the two new tests and the existing scope isolation tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/core/memory.rs apps/desktop/src-tauri/src/core/gateway_admin.rs apps/desktop/src-tauri/src/core/gateway.rs
git commit -m "feat(memory): a scoped list endpoint backs the assistant's read path"
```

---

### Task 2: Route the Assistant's recall through the scoped endpoints

**Files:**
- Modify: `apps/desktop/src/store.ts:1607-1616`
- Modify: `apps/desktop/src/lib/memory/engine.ts:408-445`
- Test: `apps/desktop/src/lib/memory/engine.test.ts`

**Interfaces:**
- Consumes: `POST /admin/memory/scoped` and `project_root` on recall (Task 1)
- Produces: `listScopedMemories(scope: { projectRoot: string; limit?: number; pinnedOnly?: boolean }): Promise<Memory[]>`
- Produces: `recallContext(query, { limit?, layers?, root? })`

- [ ] **Step 1: Write the failing engine test**

In `engine.test.ts`, add the spy and reset:

```ts
const listScopedMemories = vi.spyOn(store, "listScopedMemories");
```

Add `listScopedMemories.mockReset();` to `beforeEach`.

Add this test inside `describe("memory engine")`:

```ts
it("scopes both the pinned prefetch and the query recall to the workspace root", async () => {
  listScopedMemories.mockResolvedValue([mem("identity", "L3", "I am Tushu", true)]);
  recallMemories.mockResolvedValue([]);

  const got = await recallContext("fix the build", { root: "/tmp/next-app" });

  expect(listScopedMemories).toHaveBeenCalledWith({
    projectRoot: "/tmp/next-app",
    pinnedOnly: true,
    limit: 50,
  });
  expect(recallMemories).toHaveBeenCalledWith("fix the build", 4, ["L3", "L2"], {
    projectRoot: "/tmp/next-app",
  });
  expect(recallMemories).toHaveBeenCalledWith("fix the build", 8, ["L1"], {
    projectRoot: "/tmp/next-app",
  });
  expect(got.map((m) => m.id)).toEqual(["identity"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/engine.test.ts`
Expected: FAIL — `store.listScopedMemories is not a function`.

- [ ] **Step 3: Add the store call**

In `store.ts`, after `recallMemories`:

```ts
export interface MemoryListScope {
  /** Workspace root. Resolved host-side to the same project key the gateway uses. */
  projectRoot: string;
  limit?: number;
  pinnedOnly?: boolean;
}

/** Scoped listing: the Assistant's read surface. No query, so always-on rows are included. */
export async function listScopedMemories(scope: MemoryListScope): Promise<Memory[]> {
  return fetchAdminAs("POST", "/admin/memory/scoped", arrayOf(isMemory), {
    project_root: scope.projectRoot,
    limit: scope.limit ?? 200,
    pinned_only: scope.pinnedOnly ?? false,
  });
}
```

Add the optional scope to `recallMemories`:

```ts
export async function recallMemories(
  query: string,
  limit = 8,
  layers?: MemoryLayer[],
  scope?: { projectRoot?: string },
): Promise<Memory[]> {
  return fetchAdminAs("POST", "/admin/memory/recall", arrayOf(isMemory), {
    query,
    limit,
    layers: layers ?? null,
    project_root: scope?.projectRoot ?? null,
  });
}
```

- [ ] **Step 4: Scope `recallContext`**

In `engine.ts`, add `listScopedMemories` to the store import and change the options:

```ts
export interface RecallOptions {
  limit?: number;
  layers?: MemoryLayer[];
  /** Workspace root. When set, every read is scoped to that workspace. */
  root?: string;
}

export async function recallContext(
  query: string,
  opts: RecallOptions = {},
): Promise<Memory[]> {
  const limit = Math.max(1, opts.limit ?? 8);
  try {
    const root = opts.root?.trim() || undefined;
    // Scoped: ask for the pinned, in-scope rows directly. The old `listMemories` scan saw
    // every workspace's pinned rows, which is the contamination this path exists to stop.
    const pinned = root
      ? (await listScopedMemories({ projectRoot: root, pinnedOnly: true, limit: 50 })).slice(0, 4)
      : (await listMemories(null, 50)).filter((m) => m.pinned).slice(0, 4);

    let hits: Memory[];
    if (opts.layers && opts.layers.length > 0) {
      hits = await recallMemories(query, limit, opts.layers, root ? { projectRoot: root } : undefined);
    } else {
      const scope = root ? { projectRoot: root } : undefined;
      const abstract = await recallMemories(query, Math.ceil(limit / 2), ["L3", "L2"], scope);
      const remaining = limit - abstract.length;
      const specific =
        remaining > 0 ? await recallMemories(query, remaining, ["L1"], scope) : [];
      hits = [...abstract, ...specific];
    }

    const seen = new Set(pinned.map((m) => m.id));
    const merged = [...pinned];
    for (const m of hits) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    return merged;
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run the memory tests**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/engine.test.ts`
Expected: PASS, including the existing pinned-first and layer-split tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/store.ts apps/desktop/src/lib/memory/engine.ts apps/desktop/src/lib/memory/engine.test.ts
git commit -m "fix(memory): the assistant recalls only the current workspace"
```

---

### Task 3: Wire the workspace root into both turn branches, then prove it end to end

**Files:**
- Modify: `apps/desktop/src/screens/Assistant.tsx:2487,2562`
- Modify: `apps/desktop/web-test/shim.ts` (project-key helper, `memory_recall`, new `memory_scoped`)
- Create: `apps/desktop/web-test/memory-scope.spec.ts`

**Interfaces:**
- Consumes: `recallContext(query, { root })` (Task 2)
- Produces: shim commands `memory_scoped`, scoped `memory_recall`

- [ ] **Step 1: Write the failing Playwright spec**

Create `apps/desktop/web-test/memory-scope.spec.ts`:

```ts
/**
 * The spec's acceptance test, against the harness: seven facts, a foreign workspace, and the
 * assertion that only global identity reaches the model.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

type Call = (...a: unknown[]) => unknown;
interface Host { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }

async function seed(page: Page, layer: string, text: string, pinned = false): Promise<string> {
  return page.evaluate(
    async ({ layer, text, pinned }) => {
      const h = (window as unknown as { __webTest: Host }).__webTest;
      const m = (await h.invoke("memory_capture", {
        layer, text, sessionId: null, subject: null, pinned,
      })) as { id: string };
      return m.id;
    },
    { layer, text, pinned },
  );
}

async function scope(
  page: Page,
  id: string,
  target: { kind: "global" } | { kind: "project"; project: string },
): Promise<void> {
  await page.evaluate(
    async ({ id, target }) => {
      const h = (window as unknown as { __webTest: Host }).__webTest;
      await h.invoke("memory_assign_scope", {
        id,
        scope: {
          kind: target.kind,
          project: target.kind === "project" ? target.project : null,
          agent: null,
        },
      });
    },
    { id, target },
  );
}

/** Last body sent to /chat/completions — the model request. */
async function lastBody(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = (window as unknown as { __webTest: { store: Record<string, Call> } }).__webTest;
    const reqs = h.store["requests"]!() as Array<{ url: string; body: string | null }>;
    return [...reqs].reverse().find((r) => r.url.endsWith("/chat/completions") && r.body)?.body ?? "";
  });
}

test("scoped recall: a foreign workspace's facts never reach the model", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);

  const name = await seed(page, "L3", "I am Tushu", true);
  const role = await seed(page, "L3", "I am a Software Engineer", true);
  await scope(page, name, { kind: "global" });
  await scope(page, role, { kind: "global" });

  const tauri = await seed(page, "L1", "The Tauri context graph engine lives at apps/desktop/src/lib/context/engine.ts");
  const graph = await seed(page, "L1", "ForceGraph.tsx renders the graph");
  const schema = await seed(page, "L2", "The graph has 4 node kinds and 9 edge kinds");
  for (const id of [tauri, graph, schema]) {
    await scope(page, id, { kind: "project", project: "/tmp/tauri-app" });
  }
  // Old capability prose, never scoped: it must stay capture-only.
  await seed(page, "L1", "The assistant cannot run git clone or git fetch");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/)
    .fill("how does the context graph engine work?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => lastBody(page), { timeout: 30_000 }).not.toBe("");

  const text = await lastBody(page);
  expect(text).toContain("I am Tushu");
  expect(text).toContain("I am a Software Engineer");
  // The query matches these words, but their scope is another workspace.
  expect(text).not.toContain("context/engine.ts");
  expect(text).not.toContain("ForceGraph");
  expect(text).not.toContain("git clone");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter ai-provider-router-desktop web-test -- memory-scope.spec.ts`
Expected: FAIL — the Tauri facts and the git claim appear in the request body.

- [ ] **Step 3: Pass the root from both Assistant branches**

In `Assistant.tsx`, replace both `memory: { recall: recallContext, ... }` lines (agent branch at 2487, plain branch at 2562) with:

```ts
          memory: {
            recall: (text: string) => recallContext(text, { root }),
            block: memoryBlock,
            recordRecall,
            remember: rememberTurn,
            distil: distilTurn,
          },
```

`root` is already in scope at both sites. The agent branch's blank-root guard runs before recall, so a blank root never reaches this closure.

- [ ] **Step 4: Teach the shim the project-key algorithm**

In `web-test/shim.ts`, next to `DEFAULT_SCOPE`:

```ts
/** Matches context_scope::project_key_from_root in Rust: FNV-1a over the trimmed root. */
const projectKey = (root: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(root.trim())) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `p${hash.toString(16).padStart(16, "0")}`;
};
```

- [ ] **Step 5: Scope `memory_recall` and add `memory_scoped`**

In `memory_recall`, compute the visible set before scoring:

```ts
      const root = typeof args.project_root === "string" ? args.project_root.trim() : "";
      const project = root ? projectKey(root) : null;
      const visible = memories.filter((m) => {
        if (m.superseded_at != null) return false;
        if (!project) return true; // the Memory screen's intentional global search
        const sc = (m.scope as Row | undefined) ?? DEFAULT_SCOPE;
        return Number(sc.global) === 1 || sc.project === project;
      });
```

Replace the later `memories.filter(...)` with `visible.filter(...)`.

Add this case immediately before `memory_list`:

```ts
    case "memory_scoped": {
      const root = String(args.project_root ?? "").trim();
      if (!root) throw new Error("project_root is required");
      const project = projectKey(root);
      const pinnedOnly = args.pinned_only === true;
      const limit = (args.limit as number) ?? 200;
      return memories
        .filter((m) => m.superseded_at == null)
        .filter((m) => {
          const sc = (m.scope as Row | undefined) ?? DEFAULT_SCOPE;
          return Number(sc.global) === 1 || sc.project === project;
        })
        .filter((m) => !pinnedOnly || Number(m.pinned) === 1)
        .sort((a, b) =>
          Number(b.pinned) - Number(a.pinned) || Number(b.updated_at) - Number(a.updated_at))
        .slice(0, limit)
        .map(wireMemory);
    }
```

Then add the admin route mapping in the shim's HTTP router, next to `case "recall"`:

```ts
    case "scoped": {
      if (method === "POST") {
        const b = (body ?? {}) as Row;
        return dispatch("memory_scoped", {
          project_root: b.project_root ?? null,
          pinned_only: b.pinned_only ?? false,
          limit: b.limit ?? 200,
        });
      }
      break;
    }
```

And forward the new field through the existing recall mapping:

```ts
        return dispatch("memory_recall", {
          query: b.query ?? "", limit: b.limit ?? 8, layers: b.layers ?? null,
          project_root: b.project_root ?? null,
        });
```

- [ ] **Step 6: Run the new spec and the existing memory specs**

First update the existing helper in `memory-recall.spec.ts` so its atom is visible under the new scoped read:

```ts
async function seedL1(page: Page, text: string): Promise<string> {
  return page.evaluate(async (t) => {
    const host = (window as unknown as {
      __webTest: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
    }).__webTest;
    const m = (await host.invoke("memory_capture", {
      layer: "L1", text: t, sessionId: "s-recall", subject: null, pinned: false,
    })) as { id: string };
    await host.invoke("memory_assign_scope", {
      id: m.id, scope: { kind: "global", project: null, agent: null },
    });
    return m.id;
  }, text);
}
```

Run: `pnpm --filter ai-provider-router-desktop web-test -- memory-scope.spec.ts memory-recall.spec.ts`
Expected: PASS. `memory-recall.spec.ts` passes because every seeded atom is global; `memory-scope.spec.ts` proves a project-scoped atom from another root is still excluded.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/screens/Assistant.tsx apps/desktop/web-test/shim.ts apps/desktop/web-test/memory-scope.spec.ts
git commit -m "test(memory): a foreign workspace's facts stay out of the assistant prompt"
```

---

### Task 4: Promote identity rows to global

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/store.rs:328-354` (migration list), add function near `backfill_memory_scope:1054`
- Modify: `apps/desktop/src/lib/memory/engine.ts:532-534`
- Test: `apps/desktop/src-tauri/src/core/store.rs:1732-1736`, `apps/desktop/src/lib/memory/engine.test.ts`

**Interfaces:**
- Produces: data migration `0032_identity_scope`
- Produces: `captureCore` promotes its row through `assignMemoryScope(id, { kind: "global" })`

- [ ] **Step 1: Write the failing tests**

Rust, in `store.rs`'s migration test, change the two 31s to 32 after adding the migration (this is the test that pins the numbering):

```rust
        assert_eq!(info.schema_version, 32);
        assert_eq!(32, MIGRATIONS.len() as i64 + DATA_MIGRATIONS.len() as i64);
```

TypeScript, in `engine.test.ts`:

```ts
const assignMemoryScope = vi.spyOn(store, "assignMemoryScope");
```

Add `assignMemoryScope.mockReset();` to `beforeEach`, and:

```ts
it("marks a new core fact global so it is not capture-only", async () => {
  captureMemory.mockResolvedValue(mem("core-1", "L3", "I am Tushu", true));
  assignMemoryScope.mockResolvedValue(true);

  const m = await captureCore("I am Tushu");

  expect(m?.id).toBe("core-1");
  expect(assignMemoryScope).toHaveBeenCalledWith("core-1", { kind: "global" });
});
```

Import `captureCore` in the test's import list.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml migrations_apply -- --nocapture`
Expected: FAIL — expected 32, found 31.

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/engine.test.ts`
Expected: FAIL — `assignMemoryScope` was not called.

- [ ] **Step 3: Add the data migration**

In `store.rs`, append to `DATA_MIGRATIONS`:

```rust
    ("0032_identity_scope", backfill_identity_scope),
```

Add next to `backfill_memory_scope`:

```rust
/// 0032 — L3 core facts are identity, and identity is the one category that must ride along
/// everywhere. Existing rows were captured before scoping existed, so every one landed
/// capture-only. Promoting the pinned L3 rows is the narrowest backfill that makes "who the
/// user is" visible without promoting project internals.
fn backfill_identity_scope(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE memories
            SET scope_global = 1, scope_project = NULL, scope_agent = NULL
          WHERE layer = 'L3' AND pinned = 1
            AND scope_global = 0 AND scope_project IS NULL",
        [],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Promote new core facts**

In `engine.ts`, import `assignMemoryScope` from `../../store` and change `captureCore`:

```ts
export async function captureCore(text: string): Promise<Memory | null> {
  const m = await captureAndRecord("L3", text, null, { pinned: true });
  if (!m) return null;
  // L3 is identity. Without this it is born capture-only like every other row and never
  // reaches a prompt — the exact failure the scoped read path cannot fix on its own.
  try {
    await assignMemoryScope(m.id, { kind: "global" });
  } catch {
    // The row is still pinned and visible in the Memory screen; a later save can re-scope it.
  }
  return m;
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml store:: -- --nocapture`
Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/core/store.rs apps/desktop/src/lib/memory/engine.ts apps/desktop/src/lib/memory/engine.test.ts
git commit -m "feat(memory): identity is global, project facts stay scoped"
```

---

### Task 5: Keep retention running when the gateway toggle is off

**Files:**
- Modify: `apps/desktop/src/lib/memory/retention.ts:50-63`
- Modify: `apps/desktop/src-tauri/src/core/retention.rs:1-20,85-121,300-310,355-390`
- Test: `apps/desktop/src/lib/memory/retention.test.ts:42-59`

**Interfaces:**
- Produces: `pruneOnce()` and `retention::pass(store, budget)` always prune when a store exists.
- Removes: `RetentionPass.memory_layer_skipped` (no TS consumer) and the `memory_enabled` parameter.

- [ ] **Step 1: Update the failing tests**

In `retention.test.ts`, replace the two "off" cases with one that proves the fix:

```ts
  it("prunes even when the gateway memory toggle is off", async () => {
    enabled.mockResolvedValue(false);
    memories.mockResolvedValue({ l0_expired: 1, l0_ring: 0, decayed: 0 });
    live.mockResolvedValue({ turns_by_count: 0, turns_by_age: 0, sessions_reaped: 0 });

    const r = await pruneOnce();

    expect(r.skipped).toBe(false);
    expect(memories).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(1);
    // The gateway switch is no longer consulted at all.
    expect(enabled).not.toHaveBeenCalled();
  });
```

In `retention.rs`, replace `with_the_layer_off_the_pass_takes_nothing_and_skips` with:

```rust
    #[test]
    fn a_pass_prunes_even_when_the_gateway_toggle_is_off() {
        let (store, d) = temp_store("off");
        seed_stale_memories(&store, 5);
        let budget = PassBudget::new(Duration::from_secs(60));
        let p = pass(Some(&store), &budget).unwrap();
        // The Assistant writes memories independently of the gateway switch, so housekeeping
        // cannot be gated on that switch or the tables grow forever.
        assert!(p.memory.is_some());
        assert!(p.context.is_some());
        assert!(something_removed(&p));
        let _ = std::fs::remove_dir_all(&d);
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/retention.test.ts`
Expected: FAIL — `skipped` is true.
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml retention:: -- --nocapture`
Expected: FAIL to compile — `pass` still takes three arguments.

- [ ] **Step 3: Remove the webview gate**

In `retention.ts`, delete the `gatewayMemoryEnabled` import and change `pruneOnce` to:

```ts
export async function pruneOnce(): Promise<RetentionResult> {
  if (running) return { skipped: true };
  running = true;
  try {
    // Deliberately ungated: the Assistant records memories whether or not the *gateway*
    // memory switch is on, so pruning must run for both writers.
    const memories = await pruneMemories();
    const live = await pruneLiveContext();
    return { memories, live, skipped: false };
  } finally {
    running = false;
  }
}
```

- [ ] **Step 4: Remove the Rust gate**

In `retention.rs`:
- Change the signature to `pub fn pass(store: Option<&Arc<Store>>, budget: &PassBudget) -> Result<RetentionPass, String>`.
- Delete the `if !memory_enabled { out.memory_layer_skipped = true; return Ok(out); }` block.
- Delete `memory_layer_skipped` from `RetentionPass`.
- Change the scheduler call at line 306 to `pass(core.store(), &budget)`.
- Update the module doc's "gated on the memory master toggle" sentence to say pruning is ungated because both writers share the table.
- Update the remaining test calls `pass(None, true, &budget)` → `pass(None, &budget)` and delete `memory_layer_skipped` assertions.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/retention.test.ts`
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml retention:: -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/memory/retention.ts apps/desktop/src/lib/memory/retention.test.ts apps/desktop/src-tauri/src/core/retention.rs
git commit -m "fix(memory): retention runs for the assistant's writer too"
```

---

## Phase B — Metadata, verification and the manifest

### Task 6: Add memory metadata and retrieval accounting

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/store.rs` (migration 0033)
- Modify: `apps/desktop/src-tauri/src/core/memory.rs` (`Memory`, `MemoryInput`, mappers, recall/list filters, `mark_retrieved`)
- Modify: `apps/desktop/src-tauri/src/core/gateway_admin.rs` + `gateway.rs` (`POST /admin/memory/retrieved`)
- Modify: `apps/desktop/src/store.ts` (`Memory` type, `markMemoriesRetrieved`)
- Modify: `apps/desktop/src/lib/memory/engine.ts` (fire-and-forget bump)
- Modify: `apps/desktop/web-test/shim.ts` (metadata defaults + retrieval route)

**Interfaces:**
- Produces: `Memory.kind/source/verified/expires_at/retrieval_count/last_retrieved_at`
- Produces: `mark_retrieved(store, ids: &[String]) -> Result<usize, String>`
- Produces: `markMemoriesRetrieved(ids: string[]): Promise<number>`

- [ ] **Step 1: Write the failing migration test**

In `store.rs`'s migration test, bump 32 → 33 (two places) and add:

```rust
        // 0033 added the manifest metadata; every pre-existing L1-L3 row must have a kind.
        let conn = s.conn.lock().unwrap();
        let untyped: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE layer <> 'L0' AND kind IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untyped, 0);
```

In `memory.rs`'s tests, add:

```rust
#[test]
fn marking_retrieved_bumps_the_counter_once_per_id() {
    let (s, d) = temp_store("retrieved");
    scoped(&s, "a", "L1", "alpha uses Postgres", Some("alpha"), None, 0, 0);
    assert_eq!(mark_retrieved(&s, &["a".into(), "a".into()]).unwrap(), 2);
    let row = list(&s, None, 10).unwrap().into_iter().find(|m| m.id == "a").unwrap();
    assert_eq!(row.retrieval_count, 2);
    assert!(row.last_retrieved_at.is_some());
    let _ = std::fs::remove_dir_all(&d);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml marking_retrieved -- --nocapture`
Expected: FAIL — no `mark_retrieved`, no `retrieval_count`.

- [ ] **Step 3: Add migration 0033**

Append to `DATA_MIGRATIONS`:

```rust
    ("0033_memory_metadata", add_memory_metadata),
```

Add near `backfill_memory_scope`:

```rust
/// 0033 — the fields a manifest needs that the layer model never carried: what an entry is
/// (`kind`), where it came from (`source`), whether a capability claim is still true
/// (`verified`), when it stops applying (`expires_at`), and whether anything ever used it
/// (`retrieval_count`/`last_retrieved_at`).
fn add_memory_metadata(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    for (column, ddl) in [
        ("kind", "ALTER TABLE memories ADD COLUMN kind TEXT"),
        ("source", "ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'inferred'"),
        ("verified", "ALTER TABLE memories ADD COLUMN verified TEXT"),
        ("expires_at", "ALTER TABLE memories ADD COLUMN expires_at INTEGER"),
        (
            "retrieval_count",
            "ALTER TABLE memories ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "last_retrieved_at",
            "ALTER TABLE memories ADD COLUMN last_retrieved_at INTEGER",
        ),
    ] {
        if !table_has_column(tx, "memories", column)? {
            tx.execute_batch(ddl)?;
        }
    }

    // A one-time heuristic, deliberately conservative: L3 is identity; a command/tool
    // availability sentence is a capability; everything else is a fact until something
    // classifies it better. The `verified` column stays NULL until the probe runs.
    let mut stmt = tx.prepare("SELECT id, layer, text FROM memories WHERE kind IS NULL")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (id, layer, text) in rows {
        tx.execute(
            "UPDATE memories SET kind = ?1 WHERE id = ?2",
            rusqlite::params![crate::core::memory::classify_kind(&layer, &text), id],
        )?;
    }
    Ok(())
}
```

Add `classify_kind` to `memory.rs` (not `store.rs`; the migration reaches it through the module path), next to `valid_layer`:

```rust
/// The one-time classifier used by the 0033 backfill and by `capture` when the caller supplies
/// no kind. Deliberately conservative: a mis-typed row is a worse failure than an untyped one.
pub(crate) fn classify_kind(layer: &str, text: &str) -> &'static str {
    if layer == "L0" {
        return "conversation";
    }
    if layer == "L3" {
        return "identity";
    }
    let t = text.to_ascii_lowercase();
    const CAPABILITY: &[&str] = &[
        "git clone", "git fetch", "cannot run", "can't run", "not available",
        "no access", "unable to", "no real shell", "shell is available",
    ];
    if CAPABILITY.iter().any(|p| t.contains(p)) {
        return "capability";
    }
    const PREFERENCE: &[&str] = &[
        "prefers", "prefer ", "likes ", "wants ", "always use", "never use", "concise",
    ];
    if PREFERENCE.iter().any(|p| t.contains(p)) {
        return "preference";
    }
    const DECISION: &[&str] = &[
        "decided", "we will", "we'll", "chosen", "approved", "agreed",
    ];
    if DECISION.iter().any(|p| t.contains(p)) {
        return "decision";
    }
    "project_fact"
}
```

- [ ] **Step 4: Extend `Memory` and `MemoryInput`**

In `memory.rs`, add `#[derive(Default)]` to `Memory` and these fields after `superseded_at`:

```rust
    /// What the row is: identity, preference, decision, project_fact, capability, conversation.
    #[serde(default)]
    pub kind: Option<String>,
    /// How it got here: user_stated, inferred, probe. Defaults to inferred.
    #[serde(default = "default_memory_source")]
    pub source: String,
    /// Capability rows only: live, unverified, contradicted. NULL for everything else.
    #[serde(default)]
    pub verified: Option<String>,
    /// Stop injecting after this instant. NULL means no expiry.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub retrieval_count: i64,
    #[serde(default)]
    pub last_retrieved_at: Option<i64>,
```

Add:

```rust
fn default_memory_source() -> String {
    "inferred".into()
}
```

Extend `MemoryInput` (keeping `deny_unknown_fields`):

```rust
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
```

- [ ] **Step 5: Update every memory row reader**

Add a shared mapper in `memory.rs`:

```rust
/// Column order shared by `list`, `list_scoped` and `session_atoms`:
/// 0 id, 1 layer, 2 text, 3 session_id, 4 subject, 5 created_at, 6 updated_at, 7 pinned,
/// 8 scope_user, 9 scope_project, 10 scope_agent, 11 scope_global, 12 superseded_at,
/// 13 kind, 14 source, 15 verified, 16 expires_at, 17 retrieval_count, 18 last_retrieved_at.
fn memory_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: r.get(0)?,
        layer: r.get(1)?,
        text: r.get(2)?,
        session_id: r.get(3)?,
        subject: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        pinned: r.get::<_, i64>(7)? != 0,
        scope: MemoryScope {
            user: r.get(8)?,
            project: r.get(9)?,
            agent: r.get(10)?,
            global: r.get::<_, i64>(11)? != 0,
        },
        superseded_at: r.get(12)?,
        kind: r.get(13)?,
        source: r.get(14)?,
        verified: r.get(15)?,
        expires_at: r.get(16)?,
        retrieval_count: r.get(17)?,
        last_retrieved_at: r.get(18)?,
        score: None,
    })
}
```

Then:
- In `list` and `list_scoped`, append `, kind, source, verified, expires_at, retrieval_count, last_retrieved_at` before `FROM memories` and replace the inline `Ok(Memory { ... })` closure with `memory_from_row(r)`.
- In `session_atoms`, do the same.
- In `recall_inner`, change the SELECT to put the six new columns immediately after `m.superseded_at` and before `bm25(...) AS score`, then update the inline mapping indexes: 13 kind, 14 source, 15 verified, 16 expires_at, 17 retrieval_count, 18 last_retrieved_at, 19 score.
- In `capture`, the `existing` query reads `kind, source` too so a re-record preserves them; the UPDATE uses `kind = COALESCE(?5, kind), source = COALESCE(?6, source)`, the INSERT writes both, and both `Memory { ... }` constructors carry the resolved values. The exact statements:

```rust
            // Re-record: refresh the timestamp without erasing a classification someone set.
            "UPDATE memories SET updated_at = ?1, pinned = ?2,
                    session_id = COALESCE(?3, session_id), subject = COALESCE(?4, subject),
                    kind = COALESCE(?5, kind), source = COALESCE(?6, source)
              WHERE id = ?7"
```

```rust
            "INSERT INTO memories
                (id, layer, text, session_id, subject, created_at, updated_at, pinned, kind, source)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
```

  A new row resolves `kind` as `input.kind.or(None).unwrap_or_else(|| classify_kind(&input.layer, &text).to_string())` and `source` as `input.source.unwrap_or_else(default_memory_source)`. `verified` stays NULL, `expires_at` stays NULL, `retrieval_count` 0.
- Test constructors at the bottom of `memory.rs` can end with `..Memory::default()`.

- [ ] **Step 6: Filter expired rows and add the retrieval bump**

In `recall_inner`, after collecting rows and before `rerank`:

```rust
    let now = now_ms();
    rows.retain(|m| m.expires_at.map_or(true, |e| e > now));
```

In `list_scoped`, add before the LIMIT parameter:

```rust
    args.push(Box::new(now_ms()));
    sql.push_str(&format!(" AND (expires_at IS NULL OR expires_at > ?{})", args.len()));
```

Add `mark_retrieved`:

```rust
/// Bump the usage counters for the rows a turn actually recalled. Called after the request is
/// already in flight, never on the gateway's hot read path.
pub fn mark_retrieved(store: &Store, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut conn = store.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut n = 0;
    for id in ids {
        n += tx
            .execute(
                "UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?1
                  WHERE id = ?2",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}
```

- [ ] **Step 7: Expose it over the admin API**

In `gateway_admin.rs`:

```rust
#[derive(Deserialize)]
pub struct RetrievedBody {
    pub ids: Vec<String>,
}

pub async fn memory_retrieved_h(
    State(core): State<Arc<GatewayCore>>,
    headers: HeaderMap,
    Json(body): Json<RetrievedBody>,
) -> Response {
    if let Err(r) = authorize(&core, &headers).await {
        return *r;
    }
    let store = match require_store(&core, "POST /admin/memory/retrieved") {
        Ok(s) => s,
        Err(r) => return *r,
    };
    match memory::mark_retrieved(store, &body.ids) {
        Ok(n) => (StatusCode::OK, Json(serde_json::json!({ "updated": n }))).into_response(),
        Err(e) => admin_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not mark retrieved: {e}"),
            Some("memory_retrieved_failed"),
        ),
    }
}
```

Route, before `{id}`:

```rust
        .route("/admin/memory/retrieved", post(admin::memory_retrieved_h))
```

- [ ] **Step 8: Extend the TS type and bump after recall**

In `store.ts`:

```ts
export type MemoryKind =
  | "identity" | "preference" | "decision" | "project_fact" | "capability" | "conversation";

export interface Memory {
  // ...existing fields...
  kind: MemoryKind | null;
  source: string;
  verified: "live" | "unverified" | "contradicted" | null;
  expires_at: number | null;
  retrieval_count: number;
  last_retrieved_at: number | null;
}
```

Add:

```ts
export async function markMemoriesRetrieved(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = expectShapeOr(
    await fetchAdmin("POST", "/admin/memory/retrieved", { ids }),
    (v): v is { updated: number } =>
      typeof v === "object" && v !== null && typeof (v as { updated?: unknown }).updated === "number",
    { updated: 0 },
  );
  return res.updated;
}
```

In `engine.ts`'s `recallContext`, after merging and before returning:

```ts
    if (merged.length > 0) {
      // Fire-and-forget: a usage counter must never delay or fail a turn.
      void markMemoriesRetrieved(merged.map((m) => m.id)).catch(() => 0);
    }
```

- [ ] **Step 9: Teach the web-test shim the new fields**

`memory_capture` and `memory_capture_batch` create rows in the shim, and the manifest tests read them. Add these defaults to every new row:

```ts
        kind: layer === "L3" ? "identity" : layer === "L0" ? "conversation" : "project_fact",
        source: "inferred",
        verified: null,
        expires_at: null,
        retrieval_count: 0,
        last_retrieved_at: null,
```

On re-capture of an existing row, fill the same defaults when absent, mirroring the scope backfill that is already there.

Add the retrieval route mapping next to `case "recall"`:

```ts
    case "retrieved": {
      if (method === "POST") {
        const b = (body ?? {}) as Row;
        return {
          updated: await dispatch("memory_mark_retrieved", {
            ids: Array.isArray(b.ids) ? b.ids.map(String) : [],
          }),
        };
      }
      break;
    }
```

Add the dispatch case:

```ts
    case "memory_mark_retrieved": {
      const ids = (args.ids as string[] | undefined) ?? [];
      let n = 0;
      for (const id of ids) {
        const m = memories.find((x) => x.id === id);
        if (!m) continue;
        m.retrieval_count = Number(m.retrieval_count ?? 0) + 1;
        m.last_retrieved_at = Date.now();
        n += 1;
      }
      return n;
    }
```

- [ ] **Step 10: Run typecheck and both suites**

Run: `pnpm --filter ai-provider-router-desktop typecheck`
Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/`
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml memory:: -- --nocapture`
Expected: PASS. Fix every `Memory` literal the compiler reports by adding `..Memory::default()` or the new fields; the TS guard may need the new fields added as optional.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src-tauri/src/core/store.rs apps/desktop/src-tauri/src/core/memory.rs apps/desktop/src-tauri/src/core/gateway_admin.rs apps/desktop/src-tauri/src/core/gateway.rs apps/desktop/src/store.ts apps/desktop/src/lib/memory/engine.ts apps/desktop/web-test/shim.ts
git commit -m "feat(memory): entries carry kind, provenance, expiry and usage"
```

---

### Task 7: Compose and verify the manifest

**Files:**
- Create: `apps/desktop/src/lib/memory/manifest.ts`
- Create: `apps/desktop/src/lib/memory/manifest.test.ts`
- Modify: `apps/desktop/src/lib/chat/turn/ports.ts:113-135`
- Modify: `apps/desktop/src/lib/chat/turn/prompt.ts:97-177`
- Modify: `apps/desktop/src/lib/chat/turn/agent-turn.ts:227-236`
- Modify: `apps/desktop/src/lib/chat/turn/plain-turn.ts:87-97`
- Modify: `apps/desktop/src/screens/Assistant.tsx` (build + pass)
- Modify: `apps/desktop/web-test/memory-scope.spec.ts` (manifest assertions)

**Interfaces:**
- Produces: `composeManifest(memories, snapshot, budgetTokens?, now?): ComposedManifest`
- Produces: `verifyCapability(text, snapshot): Verification`
- Produces: `buildManifest(root, mode, deps): Promise<ComposedManifest>`
- Consumes: `listScopedMemories`, `fetchToolsPolicy`, `AGENT_TOOLS`

- [ ] **Step 1: Write the failing pure tests**

Create `manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeManifest, verifyCapability, type CapabilitySnapshot } from "./manifest";
import type { Memory } from "../../store";

const snap = (over: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  mode: "agent",
  tools: ["read_file", "write_file", "run_command"],
  gitSubcommands: ["status", "clone", "fetch", "commit"],
  ...over,
});

const mem = (
  id: string,
  kind: Memory["kind"],
  text: string,
  over: Partial<Memory> = {},
): Memory => ({
  id,
  layer: kind === "identity" ? "L3" : "L1",
  text,
  session_id: null,
  subject: null,
  created_at: 1,
  updated_at: 1,
  pinned: false,
  scope: { user: "local", project: null, agent: null, global: true },
  superseded_at: null,
  kind,
  source: "inferred",
  verified: null,
  expires_at: null,
  retrieval_count: 0,
  last_retrieved_at: null,
  ...over,
});

describe("verifyCapability", () => {
  it("contradicts a 'cannot clone' claim when the sandbox allows clone", () => {
    expect(verifyCapability("The assistant cannot run git clone or git fetch", snap()))
      .toBe("contradicted");
  });

  it("confirms the claim in plain chat, where no tools exist", () => {
    expect(verifyCapability("The assistant cannot run git clone", snap({ mode: "plain", tools: [], gitSubcommands: [] })))
      .toBe("live");
  });

  it("leaves an unclassifiable claim unverified", () => {
    expect(verifyCapability("Tushu lives in Dhaka", snap())).toBe("unverified");
  });
});

describe("composeManifest", () => {
  it("orders identity, user-stated preference, decision, live capability, then recency", () => {
    const out = composeManifest(
      [
        mem("fact", "project_fact", "project fact", { updated_at: 99 }),
        mem("cap", "capability", "The assistant can run git clone", { updated_at: 50 }),
        mem("dec", "decision", "we will use SQLite", { updated_at: 10 }),
        mem("pref", "preference", "prefers terse replies", { source: "user_stated", updated_at: 5 }),
        mem("id", "identity", "I am Tushu", { updated_at: 1 }),
      ],
      snap(),
      10_000,
    );

    const order = out.entries.filter((e) => e.included).map((e) => e.id);
    expect(order).toEqual(["id", "pref", "dec", "cap", "fact"]);
  });

  it("drops expired rows and keeps contradicted capabilities out of the prompt", () => {
    const out = composeManifest(
      [
        mem("expired", "project_fact", "old fact", { expires_at: 10 }),
        mem("stale", "capability", "cannot run git clone"),
      ],
      snap(),
      10_000,
      100,
    );

    expect(out.entries.map((e) => e.id)).not.toContain("expired");
    const stale = out.entries.find((e) => e.id === "stale")!;
    expect(stale.verified).toBe("contradicted");
    expect(stale.included).toBe(false);
    expect(out.block).not.toContain("cannot run git clone");
  });

  it("stops at the token budget rather than truncating a line", () => {
    const big = Array.from({ length: 50 }, (_, i) =>
      mem(`f${i}`, "project_fact", `fact number ${i} `.repeat(10), { updated_at: i }),
    );
    const out = composeManifest(big, snap(), 100, 100);
    expect(out.tokens).toBeLessThanOrEqual(100);
    expect(out.entries.filter((e) => e.included).length).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the composer**

Create `manifest.ts`:

```ts
import { estimateMessageTokens } from "@aiprovider/router-core";
import type { Memory, MemoryKind } from "../../store";

export type Verification = "live" | "unverified" | "contradicted";

export interface CapabilitySnapshot {
  mode: "agent" | "plain";
  tools: readonly string[];
  gitSubcommands: readonly string[];
}

export interface ManifestEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  source: string;
  writtenAt: number;
  scope: { project: string | null; agent: string | null; global: boolean };
  expiresAt?: number;
  verified: Verification;
  included: boolean;
}

export interface ComposedManifest {
  entries: ManifestEntry[];
  block: string;
  tokens: number;
}

export const MANIFEST_BUDGET_TOKENS = 400;

const NEGATED = /\b(cannot|can't|can not|unable to|not available|no access|blocked from|does not work|doesn't work)\b/i;
const AFFIRMED = /\b(can|able to|works|available)\b/i;

/** Verify one capability sentence against the tools and sandbox this turn actually has. */
export function verifyCapability(text: string, snap: CapabilitySnapshot): Verification {
  const git = text.match(/\bgit\s+(clone|fetch|pull|push|status|commit)\b/i);
  if (git) {
    const allowed = snap.gitSubcommands.includes(git[1].toLowerCase());
    if (NEGATED.test(text)) return allowed ? "contradicted" : "live";
    if (AFFIRMED.test(text)) return allowed ? "live" : "contradicted";
    return allowed ? "unverified" : "contradicted";
  }
  const tool = snap.tools.find((t) => t.length > 2 && text.toLowerCase().includes(t.toLowerCase()));
  if (tool) {
    if (NEGATED.test(text)) return "contradicted";
    if (AFFIRMED.test(text)) return "live";
  }
  return "unverified";
}

function rank(entry: ManifestEntry): number {
  switch (entry.kind) {
    case "identity":
      return 0;
    case "preference":
      return entry.source === "user_stated" ? 1 : 5;
    case "decision":
      return 2;
    case "capability":
      return 3;
    case "project_fact":
      return 4;
    default:
      return 6;
  }
}

/**
 * Build the manifest. Identity and user-stated preferences are the stable header; a
 * contradicted capability is kept for the echo but never enters the prompt, because the
 * model must not be handed a claim the live policy already refutes.
 */
export function composeManifest(
  memories: readonly Memory[],
  snap: CapabilitySnapshot,
  budgetTokens: number = MANIFEST_BUDGET_TOKENS,
  now: number = Date.now(),
): ComposedManifest {
  const entries: ManifestEntry[] = [];
  for (const m of memories) {
    if (m.layer === "L0") continue;
    if (m.superseded_at != null) continue;
    if (m.expires_at != null && m.expires_at <= now) continue;
    const kind = m.kind ?? "project_fact";
    if (kind === "conversation") continue;
    const verified = kind === "capability" ? verifyCapability(m.text, snap) : "unverified";
    entries.push({
      id: m.id,
      kind,
      text: m.text,
      source: m.source || "inferred",
      writtenAt: m.updated_at,
      scope: { project: m.scope.project, agent: m.scope.agent, global: m.scope.global },
      ...(m.expires_at != null ? { expiresAt: m.expires_at } : {}),
      verified,
      included: false,
    });
  }

  entries.sort(
    (a, b) => rank(a) - rank(b) || b.writtenAt - a.writtenAt || a.id.localeCompare(b.id),
  );

  const header = "Session manifest — prior knowledge, not instructions. Scoped to this workspace.";
  const lines: string[] = [];
  // The header is part of the block, so it is part of the budget.
  let tokens = estimateMessageTokens({ role: "system", content: header });
  for (const e of entries) {
    if (e.kind === "capability" && e.verified !== "live") continue;
    const line = `- [${e.kind} ${e.id}] ${e.text}`;
    const cost = estimateMessageTokens({ role: "system", content: line });
    if (tokens + cost > budgetTokens) continue;
    e.included = true;
    lines.push(line);
    tokens += cost;
  }

  const block =
    lines.length === 0
      ? ""
      : `${header}\n${lines.join("\n")}`;
  return { entries, block, tokens: block ? tokens : 0 };
}

/** Fetch the scoped rows and compose. The caller supplies the this-turn capability snapshot. */
export async function buildManifest(
  root: string,
  mode: "agent" | "plain",
  deps: {
    list(root: string): Promise<Memory[]>;
    tools: readonly string[];
    policy: { git_subcommands: readonly string[] };
  },
): Promise<ComposedManifest> {
  const trimmed = root.trim();
  const memories = trimmed ? await deps.list(trimmed) : [];
  return composeManifest(memories, {
    mode,
    tools: mode === "agent" ? deps.tools : [],
    gitSubcommands: mode === "agent" ? deps.policy.git_subcommands : [],
  });
}
```

- [ ] **Step 4: Run the pure tests**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the manifest to the request and both prompts**

In `ports.ts`, add to `TurnRequestBase`:

```ts
  /** Verified, scoped manifest text for this turn; empty when memory is off or nothing is scoped. */
  manifestBlock?: string;
```

In `prompt.ts`, add `manifest?: string` to `AgentSystemParts` and insert it before `recalledMemory`:

```ts
    (parts.manifest ? `\n\n${parts.manifest}` : "") +
    (parts.recalledMemory ? `\n\n${parts.recalledMemory}` : "") +
```

For the plain path, add a `manifestMsg` parameter between `systemPromptText` and `recallMsg`:

```ts
export function buildPlainRequestMessages(
  systemPromptText: string | undefined,
  manifestMsg: string | undefined,
  recallMsg: string | undefined,
  perTurn: string,
  history: ChatMessage[],
  userTurn: Pick<Msg, "content" | "attachments" | "imageReadings" | "imagesReadBy">,
): ChatMessage[] {
  return [
    ...(systemPromptText ? [{ role: "system" as const, content: systemPromptText }] : []),
    ...(manifestMsg ? [{ role: "system" as const, content: manifestMsg }] : []),
    ...(recallMsg ? [{ role: "system" as const, content: recallMsg }] : []),
    // ...unchanged
  ];
}
```

Update every `buildPlainRequestMessages(...)` call in `prompt.test.ts` to pass `undefined` for the new second argument, then add this assertion to the same file:

```ts
it("puts the manifest above the recalled block so stable knowledge reads first", () => {
  const out = buildPlainRequestMessages(
    "system", "Session manifest", "Context recalled from memory", "", [],
    { content: "hi", attachments: [] },
  );
  const system = out.filter((m) => m.role === "system").map((m) => m.content);
  expect(system).toEqual(["system", "Session manifest", "Context recalled from memory"]);
});
```

- [ ] **Step 6: Pass it through both branches**

In `agent-turn.ts`, add `manifest: req.manifestBlock` to the `buildAgentSystem({...})` call.
In `plain-turn.ts`, add `req.manifestBlock` as the second argument to `buildPlainRequestMessages`.

- [ ] **Step 7: Build the manifest in the Assistant**

At the top of `runTurn`, after the root guard and before the agent/plain branch:

```ts
    let manifest: ComposedManifest | null = null;
    if (useMemory && root.trim()) {
      manifest = await buildManifest(root.trim(), agentMode ? "agent" : "plain", {
        list: (r) => listScopedMemories({ projectRoot: r, limit: 200 }),
        tools: AGENT_TOOLS.map((t) => t.name),
        policy: await fetchToolsPolicy().catch(() => ({ git_subcommands: [] as string[] })),
      }).catch(() => ({
        entries: [],
        block: "",
        tokens: 0,
      }));
      manifestRef.current = manifest;
      setManifest(manifest);
    }
```

Add the imports (`AGENT_TOOLS`, `fetchToolsPolicy`, `listScopedMemories`, `buildManifest`, `ComposedManifest`) and the state/ref:

```ts
  const [manifest, setManifest] = useState<ComposedManifest | null>(null);
  const manifestRef = useRef<ComposedManifest | null>(null);
```

Pass `manifestBlock: manifest?.block ?? ""` in both the `runAgentTurn` and `runPlainTurn` request literals.

- [ ] **Step 8: Extend the Playwright proof**

In `memory-scope.spec.ts`, after the existing body assertions add:

```ts
  expect(text).toContain("Session manifest");
  expect(text).toContain("identity");
```

Then add a second test that seeds a capability claim and asserts the echo marks it stale while the prompt does not carry the claim:

```ts
test("a contradicted capability stays out of the prompt", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  const cap = await seed(page, "L1", "The assistant cannot run git clone or git fetch");
  await scope(page, cap, { kind: "global" });

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/).fill("what can you do?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => lastBody(page), { timeout: 30_000 }).not.toBe("");
  const body = await lastBody(page);

  // The row is scoped global, so it reaches the composer. The probe sees that `git clone`
  // is in the sandbox allowlist and marks the claim contradicted; a contradicted capability
  // is echoed to the user but never sent to the model. The unit test pins the verdict; this
  // pins the prompt-side exclusion.
  expect(body).toContain("Session manifest");
  expect(body).not.toContain("cannot run git clone");
});
```

- [ ] **Step 9: Run typecheck and the specs**

Run: `pnpm --filter ai-provider-router-desktop typecheck`
Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/memory/`
Run: `pnpm --filter ai-provider-router-desktop web-test -- memory-scope.spec.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/lib/memory/manifest.ts apps/desktop/src/lib/memory/manifest.test.ts apps/desktop/src/lib/chat/turn apps/desktop/src/screens/Assistant.tsx apps/desktop/web-test/memory-scope.spec.ts
git commit -m "feat(memory): a scoped manifest verifies capability claims at compose time"
```

---

### Task 8: Echo the manifest and expose `read_manifest` / `forget_memory`

**Files:**
- Create: `apps/desktop/src/components/ManifestCard.tsx`
- Modify: `apps/desktop/src/lib/tools/registry.ts:760-827`
- Modify: `apps/desktop/src/lib/tools/types.ts:205-215`
- Modify: `apps/desktop/src/lib/tools/agentLoop.ts:1553-1625`
- Modify: `apps/desktop/src/lib/chat/turn/agent-turn.ts:69-73,314`
- Modify: `apps/desktop/src/screens/Assistant.tsx:3266,3407`
- Test: `apps/desktop/src/lib/tools/registry.test.ts`, `apps/desktop/web-test/memory-scope.spec.ts`

**Interfaces:**
- Produces: `ManifestPorts { read(): Promise<ManifestToolEntry[]>; forget(id: string): Promise<boolean> }`
- Produces: tools `read_manifest` (read) and `forget_memory` (mutate)

- [ ] **Step 1: Write the failing registry test**

In `registry.test.ts`:

```ts
it("exposes the manifest tools and keeps delete out of subagents", () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  expect(names).toContain("read_manifest");
  expect(names).toContain("forget_memory");
  expect(subagentTools(false).map((t) => t.name)).not.toContain("forget_memory");
  expect(toolEffect("forget_memory")).toBe("mutate");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/tools/registry.test.ts`
Expected: FAIL — names not found.

- [ ] **Step 3: Add the tool specs**

In `registry.ts`, after `read_session`:

```ts
  {
    name: "read_manifest",
    effect: "read",
    description:
      "Read this session's manifest: the scoped identity, preferences, decisions and verified capabilities the assistant was given. Each entry has a stable id you can quote to the user. Use it when asked what you remember or where a belief came from.",
    parameters: { properties: {} },
  },
  {
    name: "forget_memory",
    effect: "mutate",
    description:
      "Delete one memory by id. Only call this when the user explicitly asks to forget it. The id comes from read_manifest or a recall card.",
    parameters: {
      properties: {
        id: { type: "string", description: "The memory id to delete." },
      },
      required: ["id"],
    },
  },
```

Add both to `SUBAGENT_NEVER`:

```ts
  "read_manifest",
  "forget_memory",
```

- [ ] **Step 4: Add the port type and thread it**

In `types.ts`:

```ts
export interface ManifestToolEntry {
  id: string;
  kind: string;
  text: string;
  scope: string;
  verified: string | null;
}

/** The manifest tools' seam: read the session's composed manifest, delete one entry by id. */
export interface ManifestPorts {
  read(): Promise<ManifestToolEntry[]>;
  forget(id: string): Promise<boolean>;
}
```

Add to `AgentLoopOptions`:

```ts
  /** Behind `read_manifest` / `forget_memory`. Absent means both tools refuse. */
  manifest?: ManifestPorts;
```

Add to `AgentTurnRequest`:

```ts
  manifest?: Parameters<typeof runAgentLoop>[0]["manifest"];
```

Pass it at the `runAgentLoop({...})` call in `agent-turn.ts`: `manifest: req.manifest`, next to `sessions: req.sessions`.

- [ ] **Step 5: Dispatch the tools**

In `agentLoop.ts`, destructure `manifest` from the options next to `sessions`, and add a branch after the session-tool branch:

```ts
            } else if (name === "read_manifest" || name === "forget_memory") {
              if (!manifest) {
                resultText = "the session manifest is not available in this run.";
                ok = false;
              } else if (name === "read_manifest") {
                const entries = await manifest.read();
                resultText = entries.length
                  ? `${entries.length} manifest entr${entries.length === 1 ? "y" : "ies"}:\n\n${JSON.stringify(entries, null, 2)}`
                  : "the session manifest is empty.";
                ok = true;
              } else {
                const id = typeof args.id === "string" ? args.id.trim() : "";
                if (!id) {
                  resultText = 'forget_memory needs an "id" — get one from read_manifest.';
                  ok = false;
                } else {
                  const forgotten = await manifest.forget(id);
                  resultText = forgotten
                    ? `forgot ${id}; it will not be injected again.`
                    : `no memory with id ${id}.`;
                  ok = forgotten;
                }
              }
            }
```

- [ ] **Step 6: Build the port and render the echo card**

Create `ManifestCard.tsx` as specified in the component code below:

```tsx
import type { ComposedManifest } from "../lib/memory/manifest";

/**
 * The user-facing half of the manifest: what the assistant was told it knows, with the ids it
 * can be asked to forget. Rendered once per session, above the transcript, not per turn.
 */
export function ManifestCard({
  manifest,
  onForget,
}: {
  manifest: ComposedManifest;
  onForget?: (id: string) => void;
}) {
  if (manifest.entries.length === 0) return null;
  const active = manifest.entries.filter((e) => e.included).length;
  const stale = manifest.entries.filter((e) => e.verified === "contradicted").length;
  return (
    <details
      className="mb-3 rounded-lg border px-3 py-2 text-[12px]"
      style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
      data-testid="manifest-card"
    >
      <summary className="cursor-pointer select-none">
        Session manifest · {active} active
        {stale > 0 ? ` · ${stale} stale capabilit${stale === 1 ? "y" : "ies"}` : ""}
      </summary>
      <ul className="mt-2 space-y-1">
        {manifest.entries.map((e) => (
          <li key={e.id} className="flex items-start gap-2">
            <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]" style={{ background: "var(--surface-2)" }}>
              {e.kind}
            </span>
            <span className={e.verified === "contradicted" ? "line-through opacity-70" : ""}>
              {e.text}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[10px]" style={{ color: "var(--text-faint)" }}>
              {e.id}
            </span>
            {onForget ? (
              <button
                type="button"
                aria-label={`Forget ${e.id}`}
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={() => onForget(e.id)}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
```

In `Assistant.tsx`:
- Import `ManifestCard` and `forgetMemory`.
- Add the port object near the state:

```ts
  const manifestPort = useMemo(
    () => ({
      read: async () =>
        (manifestRef.current?.entries ?? []).map((e) => ({
          id: e.id,
          kind: e.kind,
          text: e.text,
          scope: e.scope.global
            ? "global"
            : e.scope.project
              ? `project:${e.scope.project}`
              : "unscoped",
          verified: e.kind === "capability" ? e.verified : null,
        })),
      forget: async (id: string) => {
        const ok = await forgetMemory(id);
        if (ok) {
          const next = manifestRef.current
            ? {
                ...manifestRef.current,
                entries: manifestRef.current.entries.filter((e) => e.id !== id),
              }
            : null;
          manifestRef.current = next;
          setManifest(next);
        }
        return ok;
      },
    }),
    [],
  );
```

Pass `manifest: manifestPort` in the `runAgentTurn` request.

Render above the transcript map (immediately before `{msgs.map((m, i) =>` at line 3266):

```tsx
        {manifest && manifest.entries.length > 0 ? (
          <ManifestCard
            manifest={manifest}
            onForget={(id) => {
              void manifestPort.forget(id);
            }}
          />
        ) : null}
```

- [ ] **Step 7: Extend the Playwright test**

In `memory-scope.spec.ts`, add:

```ts
test("the manifest card lists entries and forgets one by id", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  const id = await seed(page, "L3", "I am Tushu", true);
  await scope(page, id, { kind: "global" });

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/).fill("hello");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.getByTestId("manifest-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: `Forget ${id}` }).click();
  await expect(card.getByText("I am Tushu")).toHaveCount(0);
});
```

- [ ] **Step 8: Run all affected tests**

Run: `pnpm --filter ai-provider-router-desktop typecheck`
Run: `pnpm --filter ai-provider-router-desktop test -- src/lib/tools/registry.test.ts src/lib/memory/`
Run: `pnpm --filter ai-provider-router-desktop web-test -- memory-scope.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/components/ManifestCard.tsx apps/desktop/src/lib/tools apps/desktop/src/lib/chat/turn/agent-turn.ts apps/desktop/src/screens/Assistant.tsx apps/desktop/web-test/memory-scope.spec.ts
git commit -m "feat(assistant): the session manifest is visible and deletable by id"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Scoped injection, cross-project leakage impossible | 1, 2, 3 |
| Capability entries never trusted as text | 6, 7 |
| Manifest visible + `read_manifest` + delete by id | 7, 8 |
| Budget ~400 tokens, deterministic order | 7 |
| Phase 0 (stop mismatched scope, capability unverified) | 2, 3, 6 |
| Phase 1 (instrument injection) | 6 (`retrieval_count`, `last_retrieved_at`); per-entry injection log remains open and is not claimed |
| Phase 2 (scope + expiresAt, backfill) | 1, 4, 6 (scope already existed; only expiry is new) |
| Phase 3 (capability probe) | 7 |
| Phase 4 (echo/read/delete) | 8 |
| Retention decay | 5 fixes the gate; `expires_at` gives an explicit stop date. Automatic "N sessions unretrieved → dormant" is **not** implemented here and must not be claimed. |

**Deliberate omissions (documented, not hidden)**

- No per-entry injection log table. Task 6 records retrieval counts per memory; it does not log each injection event with a request id. The spec's instrumentation phase therefore remains partially open.
- No semantic search/embeddings. Out of scope in the spec and in this repo's design.
- The manifest is composed per turn, not cached for the session. One scoped SQLite read per turn is cheap; caching would need invalidation on every memory write and is not worth it before the read path is correct.
- The gateway path is unchanged. External clients already get scoped recall; the manifest is an Assistant feature in this plan.

**Type consistency**

`listScopedMemories` is used with `{ projectRoot, pinnedOnly, limit }` in Tasks 2, 3 and 7. `composeManifest` takes `readonly Memory[]` and returns `ComposedManifest` in Tasks 7 and 8. `ManifestPorts` uses `ManifestToolEntry` in Tasks 8. `Memory.kind` is `MemoryKind | null` in the composer and assigned by the Rust migration in Task 6.

---

## Final verification

```bash
pnpm --filter ai-provider-router-desktop typecheck
pnpm --filter ai-provider-router-desktop test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter ai-provider-router-desktop web-test -- memory-scope.spec.ts memory-recall.spec.ts memory.spec.ts memory-moments.spec.ts
```

Expected: all green. `memory-scope.spec.ts` is the before/after proof: it fails against the current code because the Tauri facts and the git claim reach the prompt, and passes after Tasks 1–3.
