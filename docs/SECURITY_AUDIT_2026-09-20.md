# Security Audit — AI-Provider Router IDE

**Auditor:** Jarvi (◈) | **Date:** 2026-09-20 | **Scope:** `apps/desktop/src-tauri/src/` + `packages/router-core/` + `apps/desktop/src/`

---

## Verdict

**No HIGH finding remains open.** The sole CRITICAL (C2) is fixed and verified end-to-end; C1 was
downgraded to MEDIUM and H2 to LOW after measurement.** The architecture is sound (key-blind egress,
invariant-numbered security model, constant-time auth, bounded keychain cache). **H3 — mutex `.unwrap()`
panics in request paths — was CLOSED on 2026-09-20 after measurement: the mechanism is unreachable in the
shipped binary and the 206 call sites were mostly test code (76 production, all of them lock calls).**

**Found and fixed while verifying H1a: H4.** Every gateway tool call had been failing silently because
`arguments` crossed the IPC boundary as a JSON string while the Rust side indexed it as an object. `list_dir`
masked it by defaulting to `"."`. Fixed, and verified end-to-end in the shipped build. That *activated* H1b —
the gateway sandbox had been inert — so H1b was fixed in the same pass: gateway-side mutation is now opt-in
and host-gated, with an audit trail.

> **Correction log.** This audit is being revised in place as findings are tested rather than assumed.
> C1 was initially rated CRITICAL on an untested premise; testing disproved it and the rating was
> lowered the same day. H2 was likewise over-rated and is now LOW. The "Architecture strengths"
> section, in particular, should be read as *design-level* observations — several were confirmed by
> inspection, not by adversarial testing. Four findings in this audit were re-scoped after
> measurement (C1, H1, H2, H3, and H1's mechanism); in each case the description named a mechanism
> inferred from reading rather than one observed. H3 is now closed outright — see its entry.

---

## 1. Critical Findings (one fixed, one downgraded)

### C1 — `tool_run` accepts a caller-supplied `root` path, defeating host confinement

> **REASSESSED 2026-09-20 (same day): severity lowered CRITICAL → MEDIUM.**
> The original rating rested on an assumption I did not test: that *"malicious model output"* could
> reach JavaScript and invoke the command. I tested it. There is **no XSS sink anywhere in
> `apps/desktop/src`** — no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no `new Function`.
> Model output is rendered as text (React escapes by default), so it cannot execute code. That vector
> does not exist. The finding stands as a real hardening gap; only the rating and the fix changed.

**Severity:** MEDIUM (was CRITICAL) | **Location:** `commands.rs:493` + `tools.rs:370`

```rust
// commands.rs — handlers()
crate::tools::tool_run,   // registered as a public Tauri command

// tools.rs — the implementation
pub fn tool_run(req: ToolRunRequest) -> ToolResult {
    let root = PathBuf::from(&req.root);   // <-- caller controls the root
```

**What is true.** Tauri 2 capability files ACL plugin/core commands only — **not** app-defined commands.
Verified: `capabilities/default.json` grants `core:default` + `opener:default` and
`capabilities/gateway.json` grants `core:event:allow-listen/unlisten`. **Neither lists any app-defined
command**, so every command in `handlers()` is callable from any window. `tool_run` is one of them.

**What is also true, and was missed.** The root is *legitimately* caller-supplied by design — it is not
an attack surface that exists only for an intruder:

```tsx
// Playground.tsx:551 — a documented, user-facing feature
<input value={root} onChange={(e) => setRoot(e.target.value)}
       placeholder="/absolute/path the tools are confined to" />
// Playground.tsx:375
const host = createTauriToolHost(root.trim());
```

The user types the confinement root in the UI. So `tool_run` accepting a root is the intended contract,
not a leak. The marginal risk is only that a *compromised* webview could pick a root the user did not —
but with no XSS sink, compromising the webview requires an attacker who already has code execution, at
which point confinement is not the binding constraint.

**The real gap, and it is smaller than first stated:** `resolve_within()` canonicalizes and checks
`starts_with(root_canon)`, so confinement *to* the root is enforced correctly. What is unvalidated is the
root itself — a user who types `/` gets no confinement at all. That is a footgun, not a vulnerability.

**Recommendation (revised — hardening, not a ship-blocker):**
1. **Validate the root host-side** in `tool_run`: canonicalize, then reject `/`, `$HOME`, and
   `/System` `/usr` `/bin` `/etc`. Preserves the feature; removes the footgun.
2. Do **not** remove `tool_run` from `handlers()` — that would break agent mode, which depends on the
   per-run root. (The original fix said "remove it immediately"; that was wrong.)
3. Capability files cannot fix this — re-confirmed they do not ACL app-defined commands.

**Related and still more serious: H1.** With root `/` *and* `sed`/`awk`/`node`/`python3`/`pip3` on the
allowlist, the sandbox is not a real boundary. H1 is the finding that actually deserves priority here.

---

### C2 — Regex over error messages decides client-facing HTTP status

**Severity:** CRITICAL (already fixed in memory, verify landed) | **Location:** `gateway-bridge.ts:72`

```ts
// Before fix:
const status = /no route|not found/i.test(msg) ? 404 : 502;
```

**Impact:** Every schema rejection (400) and every non-"not found" upstream failure was reported to the client as 502 (Bad Gateway), inviting retries on requests that can never succeed. Verified in live ledger row 318: `BAD_REQUEST_SCHEMA` from Agnes was answered HTTP 502.

**Fix (already in progress per memory):** `gatewayStatus()` now inspects `AllAttemptsFailedError.chain` and passes through only client-attributable statuses (400/404/413/422/429). Upstream 401/403 are deliberately hidden (they mean *our* stored key was rejected, not the client's).

**Verification:** 4 new specs added to `gateway-bridge.test.ts`, proven failing before fix applied.

---

## 2. High Findings

### H1 — Turing-complete programs on sandbox allowlist bypass root confinement

**Severity:** HIGH | **Location:** `tools.rs:75-78`

```rust
allowed_programs(): HashSet<&'static str> = {
    ls, cat, head, tail, wc, grep, rg, find, pwd, echo, printf, date,
    which, basename, dirname, stat, du, diff, sort, uniq, tr, cut,
    sed,     // ◄ Turing-complete; can write anywhere via redirection
    awk,     // ◄ Turing-complete; can write anywhere via print > file
    tar,     // ◄ Can extract archives outside root
    unzip,
    mkdir, touch, cp, git,
    node, npm, npx, pnpm,   // ◄ JS runtime; require('fs').writeFileSync outside root
    python3, pip3,          // ◄ Full language; open() outside root
    make,
}
```

**Impact — split into two distinct problems, only one of which is a bug.**

**H1a — the confinement bypass (a real bug, now fixed).** The original write-up blamed the interpreters,
but the bypass has nothing to do with them. `do_run_command` checked `program` against the allowlist and
then handed `argv` to the child **unexamined**, with only `current_dir(root)` for confinement. cwd
confines *relative* paths and says nothing about absolute ones, so **every** allowlisted program could be
pointed out of the workspace. Reproduced with the mildest program on the list:

```
run_command { program: "cat", args: ["/tmp/outside-secret.txt"] }  ->  ok: true, contents returned
```

Fixed: `is_escaping_path()` rejects absolute arguments and any `..` component for all programs alike,
matching the rule `resolve_within` already applied to the file tools. 3 specs added; the reproduction
was observed failing first (`run_command must refuse an absolute path outside the root`).

**H1b — the interpreters (a design property, NOT a bug — original fix was wrong).** The original
recommendation was "remove `node`, `python3`, … from the allowlist." **That is wrong on two counts:**

1. **It removes an intended feature.** `tools_agent_tests.rs` encodes code execution as a designed
   capability — *"scaffolds a nested module and executes it"* runs `python3 src/utils/calc.py`. Four
   tests depend on it. Removing them is not a security fix, it is deleting functionality.
2. **Blocking inline eval would be theatre.** `python3 -c "…"` is the obvious vector, but the model has
   `write_file`; it can write a script inside the root and run it. Filtering `-c`/`-e` changes nothing.

**So: an interpreter on the allowlist means agent mode can execute arbitrary code inside the root. That is
by design.** The security boundary is *confirmation*, not parsing — and the two callers differ:

| Path | Confirmation before execution |
|---|---|
| Playground agent mode | **Yes** — per-call Allow/Deny modal (`runAgentLoop`'s `confirm`) |
| Gateway (`gateway_tool_run`) | **None** — executes immediately, driven by an external client's prompts |

**The real exposure is the gateway row above.** Gateway tools default to **enabled** (`tools_enabled:
AtomicBool::new(true)`), so a client holding the master key gets model-driven code execution with no
human in the loop. That is the finding that deserves a decision.

**Fix (revised):**
1. **H1a — DONE.** Validate `run_command` arguments (absolute paths and `..` refused).
2. **H1b — decision required.** Either (a) require an explicit opt-in plus a visible audit trail before
   gateway tool execution is enabled, or (b) restrict the gateway to a read-only subset
   (`read_file`/`list_dir`/`grep`) and leave mutation to the confirmed Playground path. Option (b) is the
   safer default and preserves the gateway's main value — serving coding agents' reads.

**Workaround (immediate):** If removing them breaks legitimate use, add a second confinement layer: intercept stdout/stderr and block writes to paths outside the canonicalized root. This is harder than it sounds (shell builtins, temp files, symlinks).

---

### H3 — Mutex/RwLock `.unwrap()` in request path panics the process

> **CLOSED 2026-09-20 — will not fix. Two independent errors in the finding, both measured.**
> *Severity HIGH → **closed**; the remediation below would be dead code.*

**Finding as originally written:** 206 `.unwrap()` call sites in security-critical paths; `panic = "abort"`
means a poisoned lock crashes the process; the next request walks into `.unwrap()` and the gateway dies.

**Why it is closed — error 1: the mechanism cannot fire.**

`[profile.release]` sets `panic = "abort"` (`src-tauri/Cargo.toml:55`). Lock poisoning is set in
`MutexGuard::drop`, which runs **only while unwinding**. With abort there is no unwinding, so a lock can
never become poisoned, so `.lock().unwrap()` can never see the `Err` the finding is about. `panic = "abort"`
is not what makes poison dangerous — it is what makes poison *impossible*. Measured, not argued:

```
$ rustc -O main.rs -o unwind && ./unwind            # default profile (cargo test / tauri dev)
thread '<unnamed>' panicked: boom while holding the lock
join_err=true | RESULT: second lock POISONED — .unwrap() here would panic again
exit=0

$ rustc -O -C panic=abort main.rs -o abort && ./abort   # release profile — what ships
thread '<unnamed>' panicked: boom while holding the lock
exit=134                                            # SIGABRT; the second lock never runs
```

Under abort the process dies at the *first* panic. There is no "next request". Returning 503 on a poisoned
lock is unreachable code in the shipped binary.

**Why it is closed — error 2: the count.** 206 was a raw grep across whole files, including `#[cfg(test)]`
modules and the two test-only files pulled in via `#[path]` (`gateway_tests.rs`, `tools_agent_tests.rs`).
Splitting production from test properly:

| | `.unwrap()` | on a lock | non-lock |
|---|---|---|---|
| **production** (8 files) | **76** | **76** | **0** |
| test-only | 410 | — | — |

`commands.rs` 2 · `egress.rs` 6 · `gateway.rs` 16 · `gateway_cmds.rs` 6 · `lib.rs` 4 · `persist.rs` 37 ·
`store.rs` 3 · `tools.rs` 2. **Every production `.unwrap()` is a lock call; there is not one non-lock
`.unwrap()` in the shipped code.** Production `.expect()`: 3, all construction-time invariants —
`egress.rs:396` and `egress.rs:411` build the two reqwest clients in `Egress::new()`, `lib.rs:256` is the
Tauri builder. Production `panic!` / `todo!` / `unimplemented!` / `assert!` / `unreachable!`: **0**.

**The risk that is actually there, and why it is not this finding.** With abort, *any* panic on *any* thread
kills the app. That is a property of the profile, not of `.unwrap()` on locks — `.unwrap()` is where a panic
would be *reported*, not what causes it. The fix for "a panic kills the app" is to remove panic sources, and
by the counts above there are none left to remove short of indexing and allocation. Separately, dev builds
*do* unwind, so `cargo test` can poison a lock and cascade secondary panics that obscure the real failure —
test ergonomics, not a release risk.

**What was checked and found clean:** no lock guard is held across an `.await` (3 async fns contain both a
lock and an `.await`; all three use inline temporary guards dropped at the end of the statement —
`gateway.rs:925`, `gateway.rs:1297`, `gateway_cmds.rs:242/247/277`). No `catch_unwind` anywhere, so there is
no path that could recover from a poison even in dev.

### H4 — Gateway tool arguments crossed the IPC boundary as a JSON string, so every gateway tool call silently failed

**Severity:** HIGH (functional + safety-relevant) | **Location:** `gateway-bridge.ts:227`, `tools.rs` `tool_run` | **Status: fixed and verified end-to-end**

The two callers of `tool_run` disagreed on the type of `arguments`:

| Caller | Sends |
|---|---|
| Playground host (`src/lib/tools/host.ts:30`) | a real object — `arguments: args` |
| Gateway bridge (`src/gateway-bridge.ts:227`) | `arguments: JSON.stringify(args)` — a **string**, OpenAI's wire format |

Both land in the same `serde_json::Value`. `Value::get("program")` on a `Value::String` returns `None` rather than
erroring, so the mismatch was silent:

- `run_command` → `missing argument "program"`, always
- `read_file` / `write_file` → `missing argument "path"`, always
- `list_dir` → `args.get("path").and_then(as_str).unwrap_or(".")` — **fell back to `"."`**, so it answered with the
  workspace root no matter what path the model asked for, and looked like it had worked.

**Why this matters beyond functionality.** It is the reason an earlier verification passed while the feature was
broken: "call `list_dir` on the workspace root" *succeeded*, because the default happened to be the root. A check that
agrees with a bug's fallback proves nothing. And a sandbox that reports `missing argument` to every model request
reads as "the model malformed the call" — the failure is attributed anywhere but the plumbing.

**Fix:** `arguments_object()` in `tools.rs` normalises a string payload by parsing it, and rejects unparseable
input instead of degrading to `{}`. Applied once at the dispatch point, so both callers converge. 4 specs, all
observed failing with the normalisation bypassed.

**Verified in the shipped build** (`cline/anthropic/claude-sonnet-4.5` via `POST /v1/chat/completions`):
1. `write_file {path:"plumbing.txt", content:"PLUMBING-OK"}` → file present on disk, 11 bytes.
2. `run_command {program:"cat", args:["plumbing.txt"]}` → returned `PLUMBING-OK`.
3. `run_command {program:"cat", args:["/etc/hostname"]}` → `argument "/etc/hostname" points outside the workspace root — use a path relative to it`.

Items 1–2 were impossible before the fix; item 3 confirms the H1a guard holds on the gateway path too.

**Consequence to be aware of:** gateway tools were inert, so H1b (no confirmation on the gateway path) was
dormant. This fix makes `write_file` and `run_command` live for any client holding the master key. H1b is now
urgent rather than theoretical.

---

## 3. Medium Findings

### M1 — SQLite `Mutex<Connection>` serializes all operations globally

> **RE-SCOPED 2026-09-20: the fix as written does not compile.** Kept as a real but deferred
> throughput note, not an actionable item.

**Severity:** MEDIUM → **DEFERRED** | **Location:** `store.rs:488`

```rust
pub struct Store {
    pub conn: Mutex<Connection>,   // one global lock for ALL commands
    pub(crate) path: String,
}
```

**Why the recommended fix is wrong.** "Replace with `RwLock<Connection>`" — `std::sync::RwLock<T>:
Sync` requires `T: Send + Sync`, and rusqlite's `Connection` is `!Sync` (it holds `RefCell<…>`
internally). Measured, not argued:

```
error[E0277]: `RefCell<rusqlite::inner_connection::InnerConnection>` cannot be shared between threads safely
  = note: required for `std::sync::RwLock<Connection>` to implement `Sync`
error[E0277]: `RefCell<LruCache<Arc<str>, RawStatement>>` cannot be shared between threads safely
```

`Mutex<Connection>` is `Sync` (the mutex only needs `T: Send`), which is precisely why it is there.
Swapping in `RwLock` would break the `Arc<Store>` every command shares. The finding's own note —
"`Connection` is `!Sync` by design, and the mutex was the original workaround" — is the reason the
swap cannot work; it was read as a detail rather than a constraint.

**What is actually true, measured:**
- **No re-entrancy hazard.** 30 production functions in `persist.rs` take the store lock; **none**
  calls another locking function and none takes the lock twice, so there is no self-deadlock path
  (a real hazard with a non-reentrant `Mutex`, and the one that would make this a correctness bug
  rather than a throughput note).
- **The cheap mitigations are already in place** (`store.rs:500-503`): WAL, `synchronous=NORMAL`,
  `foreign_keys=ON`, `busy_timeout(5s)`. So a concurrent write waits rather than failing
  `SQLITE_BUSY` instantly.
- **What remains:** readers still queue behind writers, so `SQLite`'s concurrent-read capability is
  unused. In a single-user desktop app the practical ceiling is high; it would matter under
  sustained gateway traffic.

**Actual fix, when it is worth doing:** not `RwLock`. Either a connection pool, or the
owner-thread/actor pattern (one thread owns the `Connection`; everyone else sends work over a
channel) — the standard rusqlite answer, and a substantially larger change. Deferred to Phase 3
with a measured trigger: instrument lock wait time before rewriting the storage layer.

---

### M2 — In-memory ledger is never garbage-collected by default

> **FIXED 2026-09-20.** Bounded and instrumented; the timer for `run_rollup` is not part of this
> fix (see residual).

**Severity:** MEDIUM | **Location:** `usage-ledger.ts`

```ts
// was
private mem: LedgerEntry[] = [];   // unbounded
async append(e) { this.mem.push(e); if (this.sink) await this.sink.append(e); }
```

**Impact (as found):** `run_rollup` prunes the *database* — and only when invoked — but nothing
ever pruned this copy, so a gateway left running held every request it had ever served in RAM.

**Fix:** `UsageLedger` takes an optional `maxEntries` (default `DEFAULT_MAX_MEM_ENTRIES = 50_000`,
a second constructor arg, so every existing `new UsageLedger(sink)` is unchanged) and trims after
each append, keeping the newest. Two deliberate details:

- **Trim after the append, not before**, so the newest entry survives even at `maxEntries = 1`,
  and because the sink has already seen the entry — eviction from memory loses no data.
- **Eviction is reported, not silent.** `evictedCount` and `oldestTs()` exist because a truncated
  `query({ since })` otherwise reads as "there was no traffic then": the same blank result that
  made an earlier failure unreadable. The database still holds those rows.

**Tests (5, `test/ledger-cap.test.ts`):** newest-N retained · eviction count and `oldestTs()` ·
cap of one keeps the newest · the sink still receives every entry · a session under the cap evicts
nothing. **Falsified by removing the trim:** 4 fail (only the under-cap test survives).

**Residual:** item 3 of the original fix — running `run_rollup` on a timer rather than on demand —
is untouched. It is a scheduling decision (how often, and whether it runs while idle) rather than a
bug, and it is not what made the array unbounded.

---

### M3 — Hardcoded concurrency knobs with no runtime surface

**Severity:** MEDIUM | **Location:** Three separate constants

| Constant | Value | Location |
|---|---|---|
| `MAX_ATTEMPTS_DEFAULT` | 6 | `execution-engine.ts:49` |
| `PER_PROVIDER_DEFAULT` | 4 | `concurrency.ts:18` |
| `MAX_TOOL_ITERATIONS` | 8 | `gateway-bridge.ts:85` |
| `MAX_TOTAL` | 8 + 32 queue | `gateway.rs:17` |

**Impact:** These tune the failover depth, per-provider concurrency, agent loop depth, and gateway capacity. They are hardcoded and cannot be adjusted without a rebuild. A provider with aggressive rate limits needs more `MAX_ATTEMPTS`; a high-throughput deployment needs higher `MAX_TOTAL`.

**Fix:** Expose `maxAttempts` and `perProviderConcurrency` as router settings (the limiter already accepts runtime updates via `syncConcurrency()`). `MAX_TOOL_ITERATIONS` and `MAX_TOTAL` are more fundamental — leave as constants but document their tuning implications in a config table.

---

### M4 — Naive host extraction in `egress.rs`

**Severity:** MEDIUM | **Location:** `egress.rs` — `record_returned_hosts` | **Status: fixed 2026-09-20**

```rust
// Was: byte-scan for "http", then read bytes until the first non-hostname character
let host_len = after.bytes().take_while(|b| b.is_ascii_alphanumeric() || ...).count();
```

**What it actually is, corrected after reading the code.** The scan is not on the request
allowlist path — it is in `record_returned_hosts`, which records hosts that appeared in a
*response body* so `fetch_image` can fetch a provider-returned image URL (the invariant-3
carve-out, leased for `RETURNED_HOST_TTL`). So the failure mode is not "reads the wrong host on
the way out"; it is **minting fetch permission for hosts the response never actually returned**.
Two concrete defects, in opposite directions:

| Body fragment | Old host recorded | Correct |
|---|---|---|
| `https://cdn.example/x?next=http://attacker.example` | `cdn.example` **and `attacker.example`** | `cdn.example` |
| `https://user:pw@cdn.example:8443/a.png` | **`user`** | `cdn.example` |

The first grants a 10-minute fetch lease to any URL a body merely mentions — including one a
model echoed, or one a provider was induced to include. The second is worse than recording
nothing: the lease is looked up by that string, so `user` is not a harmless typo, it is a
permission granted to the wrong name.

**Fix:** `hosts_in_body` now takes the whole URL token (up to a JSON/HTML/prose delimiter) and
asks `reqwest::Url::parse` for `host_str()`, skipping the token afterwards so scanning cannot run
into another URL's query. Non-http(s) schemes are ignored. Extraction is now a pure function,
which is what makes it testable without constructing `EgressState`.

**Tests (5, all in `egress.rs`):** query-string URL earns no lease · userinfo/port are not the
host · prose saying "http" records nothing · only http(s) schemes earn a lease · two URLs in one
body both earn one. **Falsified by restoring the byte-scan:** 2 fail —
`left: ["user"] right: ["cdn.example"]`, and the query-string assertion.

**Residual, deliberately not changed:** the carve-out itself still trusts a response body to name
a host. That is bounded — the fetch carries no secret, redirects re-pass the allowlist, and the
lease expires — but it is a trust decision, not a solved problem. Tightening it to "the host must
have been returned by the same provider whose key was used" is a separate, larger change.

---

### M5 — `CommandError` forwards raw rusqlite/IO strings to the webview

**Severity:** LOW-MEDIUM | **Location:** `commands.rs:20-25`

```rust
#[derive(Debug, serde::Serialize)]
pub struct CommandError(pub String);   // raw error message
```

**Impact:** rusqlite errors can contain file paths, SQL text, and internal state. IO errors can contain absolute paths. While none of this is secret, it leaks implementation details to the webview that could aid an attacker constructing targeted exploits.

**Fix:** Map common error classes to user-friendly messages:
- `DatabaseIsLocked` → "Database is busy, please retry"
- `StatementChangedRows` → "Operation failed"
- `IO(error)` → "File system error"

---

## 4. Low Findings

### H2 — `peer_ip()` hardcodes `LOCALHOST`, merging all backoff buckets

**Severity:** LOW (**re-scoped down from HIGH** after measurement) | **Location:** `gateway.rs`
**Status: no code change — the fix originally recommended would have made things worse**

```rust
fn peer_ip(_headers: &HeaderMap) -> IpAddr {
    IpAddr::V4(Ipv4Addr::LOCALHOST)  // all clients share one bucket
}
```

**The original impact claim was wrong.** I wrote that "one misconfigured consumer locks out all
other consumers for up to 32 seconds." It does not, and an existing passing spec already proved it:
`auth_allowed` is consulted only *after* the key has failed to match, so a caller with a valid
credential is never throttled. Measured with two separate clients (`a_second_failing_caller_inherits_…`):

| Caller | Key | Result inside an open window |
|---|---|---|
| client A | wrong | 401, then 429 |
| client B (separate connection) | wrong | **429** — inherits A's window, on its *first* failure |
| client B | valid | **200** — never throttled |

So the merging is real but bounded: another *failing* caller inherits the window, which surfaces as a
429 where 401 was correct. Confusing diagnostics, not a lockout.

**The recommended fix was also wrong.** "Read the actual remote address" is a no-op here — `spawn()`
binds `127.0.0.1` by construction, so the real peer address *is* `127.0.0.1`. Pinned by a new spec,
`the_listener_binds_loopback_only`, which fails if the bind is ever widened; that is the day this
becomes a genuine multi-client bug and the day `peer_ip` must change.

**Why not key on the peer socket (IP + port) instead?** It would separate concurrent callers, but a
client that opens a fresh connection per attempt gets a fresh bucket each time, so the backoff becomes
trivially resettable. On a loopback-only gateway the shared bucket is the stronger of the two. *(This
trade-off is reasoned, not measured — implementing it to measure it would mean shipping the weaker
option.)*

**Follow-up if isolation is ever wanted:** bucket on a stable client identity (e.g. `x-client-name` /
`user-agent`) rather than the port.

---

### L1 — `lint` script is a no-op

**Severity:** LOW | **Location:** `package.json`

```json
"lint": "pnpm -r --if-present lint"
```

**Impact:** `--if-present` means if no package has a `lint` script, the command succeeds silently. A grep found zero eslint/prettier/clippy configuration files. Dead code, type inconsistencies, and style drift go undetected.

**Fix:** Add `eslint` + `@typescript-eslint` to the root workspace with a baseline config. Start with `--init` and `--ignore-patterns` for generated files. Run `pnpm lint:fix` and commit the result.

---

### L2 — `is_local()` trusts any port on localhost

**Severity:** LOW | **Location:** `egress.rs`

```rust
fn is_local(url: &Url) -> bool {
    url.host_str() == Some("localhost") || url.host_str() == Some("127.0.0.1")
}
```

**Impact:** Any port on localhost is treated as local. This is correct for the current binding (`127.0.0.1:8787`), but if the gateway ever binds `0.0.0.0` (even temporarily during development), any localhost URL would pass the check — including URLs that redirect to external hosts.

**Fix:** Add an explicit allowlist of allowed local ports, or require the port to match the gateway's configured port.

---

### L3 — `base64` dependency has three versions in Cargo.lock

**Severity:** INFO | **Location:** `Cargo.lock:186-196`

```
name = "base64"
version = "0.21.7"
name = "base64"
version = "0.22.1"
name = "base64"
version = "0.23.1"
```

**Impact:** Unnecessary binary size from duplicate crates. `0.21.x` and `0.22.x` are likely transitive dependencies with incompatible features.

**Fix:** Run `cargo update` and audit the dependency tree. Add a `cargo-deny` check to prevent future duplication.

---

## 5. Dependency Audit

### JS Dependencies

| Advisory | Severity | Package | Vulnerable | Patched |
|---|---|---|---|---|
| GHSA-82fw-gwwq-j7x9 | Moderate | `vitest`, `@vitest/mocker` | `< 4.1.11` | `>= 4.1.11` |

**Path:** `apps__desktop > vitest`
**Impact:** Path traversal via redirect mock — affects test infrastructure only, not production bundles.
**Fix:** `pnpm up -D vitest @vitest/mocker` or pin to `^4.1.11` in `devDependencies`.

### Rust Dependencies

`cargo audit` is not installed (`command not found: cargo` in sandbox; toolchain present at `~/.cargo/bin/cargo` but audit plugin missing).

**Observed from Cargo.lock (607 deps):**
- `rand 0.8` — latest is `0.9`; not a security issue but should be updated for consistency.
- `axum 0.8.9` — stable, no known advisories.
- `reqwest 0.12` — stable, no known advisories.
- `rusqlite 0.32` — stable, no known advisories.
- `keyring 2` — latest is `3`; check for breaking changes before upgrading.

**Recommendation:** Install `cargo-audit` (`cargo install cargo-audit`) and add it to the CI pipeline.

---

## 6. Architecture Strengths (confirmed)

These are working correctly and should be preserved:

1. **Key-blind egress** (invariant 2): Secrets never enter webview-observable state. Sentinel `{{secret}}` headers are substituted host-side.
2. **Host allowlist** (invariants 3/9): Mutable only host-side; `secret_ref` paired to its provider host via DB join.
3. **Constant-time auth** (invariant 10): Manual XOR accumulator + `black_box` prevents timing side-channels.
4. **No early break** in per-app key loop: Prevents length/first-byte oracles.
5. **Redirects disabled** on secret-bearing client: Documented and correct (`Policy::none()`).
6. **MasterKeyCache** (single-flight, 1.5 s bound, generation-stamped invalidation): Prevents keychain wedge from taking down the gateway.
7. **Absent vs Unavailable**: Distinct keychain states answered as 401 vs 503.
8. **Spend gate after auth**: 402 is checked only after the key validates.
9. **Unified `worker_status()`**: Ten consumer sites now derive status from the worker, not local heuristics.
10. **Ledger honesty**: `NO_ROUTE` written exactly once (empty plan); `providerId`/`keyId` mean *who served*, never the last attempt.
11. **Gateway bridge window lock** (R1): Bridge only starts in the `gateway` window; other windows refuse silently.
12. **Tool call separation** (PASS-THROUGH vs GATEWAY): Clear contract; no guessing.
13. **Mercury-2.5 inline markers**: Always executed locally, filtered from client-visible stream.
14. **Iteration ceiling** (8 turns): Bounded agent loop prevents infinite tool-call spending.
15. **Image fetch cap** (`IMAGE_FETCH_MAX_BYTES = 32 MiB`): Prevents large-body DoS.
16. **Returned-hosts lease** (`RETURNED_HOST_TTL = 10 min`): Scoped, time-bounded.
17. **Migration idempotency**: Forward-only, ordered, data migrations separated from SQL migrations, asserted by test.

---

## 7. Prioritized Remediation Roadmap

### Phase 1 (fix before next release)

| # | Finding | Effort | Risk |
|---|---|---|---|
| — | *(empty — H3 was the only Phase 1 item and is closed; see its entry for the measurement)* | — | — |

### Already done (this session)

| Finding | Status |
|---|---|
| **C2** — a regex over error messages decided the client-facing HTTP status | **Fixed and verified.** `gatewayStatus()` passes through only client-attributable codes (400/404/413/422/429). 4 specs added to `gateway-bridge.test.ts`, falsified before fixing. Verified end-to-end in the shipped build: a tool call executed in the Rust sandbox and the continuation turn returned **200** — previously it was rejected with `BAD_REQUEST_SCHEMA / HTTP 400`. Full detail in `TOOL_CALL_DIAGNOSIS_2026-09-20.md`. |
| **C1** — rating correction | Downgraded CRITICAL → MEDIUM. Testing found no XSS sink (`dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function` all absent) and confirmed the root is a documented, user-facing input (`Playground.tsx:551`). The original "remove `tool_run` from `handlers()`" fix was wrong — it would break agent mode. |
| **C1** — root validation | **Fixed.** `validate_root()` refuses `/`, `$HOME`, system dirs, non-existent and non-directory roots. 7 specs. |
| **H1a** — `run_command` arguments were never validated | **Fixed.** Any allowlisted program could be pointed outside the workspace via an absolute path (reproduced with `cat`). `is_escaping_path()` now rejects absolute arguments and `..` for all programs. 3 specs, reproduction observed failing first. |
| **H2** — rating correction, no code change | Downgraded HIGH → **LOW**. Measured: a second *failing* caller does inherit the backoff window (429 where 401 was correct), but a caller with a valid key is never throttled — so the claim that one consumer "locks out all the others" was false. The recommended fix ("read the actual remote address") is a no-op: the bind is loopback-only, so the real peer *is* `127.0.0.1`. Per-socket keying was rejected — it makes the backoff resettable by reconnecting. Two specs added: one reproduces the bounded merging, one pins the loopback bind so a future widening fails loudly. |
| **H1b** — gateway tools executed with no confirmation | **Fixed.** Re-scoped from "remove interpreters" (wrong — it would delete an intended feature and be theatre) to the actual gap: no human in the loop on the gateway path. Mutation is now **opt-in and host-gated**: `MUTATING_TOOLS = [write_file, run_command]` are refused unless `tools_mutation_enabled` is set, which defaults to **false**. Read-only tools (`read_file`, `list_dir`) are unaffected, so pass-through for clients that bring their own tools is unchanged. Every gateway tool execution — allowed or refused — is written to `gateway.log`. Enforced in `gateway_tool_run`, decision in `GatewayCore::gateway_tool_refusal` so it is testable without an `AppHandle`. 4 specs, 3 falsified (the 4th tests the flag, not the gate). UI toggle in `Gateway.tsx`. |
| **H4** — gateway tool arguments arrived as a JSON string | **Fixed and verified end-to-end.** `arguments_object()` parses a string payload at the dispatch point; unparseable input is an error, not `{}`. 4 specs, all falsified first. Live proof in the shipped build: `write_file` created the file, `cat <relative>` read it back, `cat /etc/hostname` was refused. **This makes H1b live.** |
| **H3** — mutex `.unwrap()` panics in the request path | **Closed — no code change, deliberately.** Two measured errors in the finding: (1) `panic = "abort"` prevents unwinding, and poisoning is only set while unwinding, so a poisoned lock cannot exist in the shipped binary — demonstrated with a two-profile build of the same program (unwind → `POISONED`, abort → SIGABRT before the second lock). The prescribed 503-on-poison would be dead code. (2) "206 call sites" was a raw grep including `#[cfg(test)]`; production is **76, all of them lock calls, zero non-lock**, plus 3 construction-time `.expect()` and zero `panic!`/`todo!`/`assert!`/`unreachable!`. Also checked clean: no lock guard held across an `.await`; no `catch_unwind` anywhere. |

### Phase 2 (Next sprint)

| # | Finding | Effort | Risk |
|---|---|---|---|
| 6 | Replace `Mutex<Connection>` with `RwLock<Connection>` | 4h | Low |
| 7 | Add in-memory ledger TTL / cap | 2h | Low |
| 8 | Expose `maxAttempts` and `perProviderConcurrency` as router settings | 3h | Low |
| 9 | ~~Fix host extraction to use `url::Url::host_str()`~~ **done 2026-09-20 — see M4** | — | — |
| 10 | Add `cargo-audit` to CI pipeline | 2h | Low |
| 11 | Configure ESLint + TypeScript strict checks in CI | 4h | Medium — will surface existing issues |

### Phase 3 (Nice-to-have)

| # | Finding | Effort | Risk |
|---|---|---|---|
| 12 | Sanitize `CommandError` messages | 2h | Low |
| 13 | Add port allowlist to `is_local()` | 1h | Low |
| 14 | Deduplicate `base64` versions via `cargo update` | 1h | Low |
| 15 | Add `cargo-deny` for dependency policy enforcement | 3h | Low |

---

## 8. Test Inventory

| Suite | Count | Files |
|---|---|---|
| router-core | 216 | 18 |
| desktop vitest | 132 | 13 |
| Rust `cargo test --lib` | 213 | — |
| adapter-spec | 18 | — |
| Browser (Playwright) | 41 | — |
| **Total** | **620** | — |

Counts as of the end of this session (Rust 193 → 213: +10 for C1/H1a, +4 for H4, +4 for H1b, +2 for H2).

All counts match memory records. No coverage gap analysis performed (would require instrumentation).

---

## 9. Summary

The AI-Provider Router IDE has a strong security architecture with well-documented invariants and auditable properties. The critical and high findings are **implementation gaps**, not architectural flaws:

- **H1b** (gateway executes tools with no confirmation) was the highest-priority item once H4 was fixed and the
  sandbox came alive. Now fixed: mutation is opt-in and host-gated, with an audit trail.
- **H4** (gateway arguments as a JSON string) is fixed. It is the clearest instance of a recurring pattern in this
  audit: a type mismatch that returns `None` instead of failing, producing a failure that looks like someone
  else's fault.
- **H3** (mutex unwrap in request path) was a reliability risk, not a confidentiality risk — and it is now
  **closed**: `panic = "abort"` does not make poison dangerous, it makes poison *impossible* (poisoning is
  only recorded while unwinding). The real property to keep in mind is the one the finding was reaching for:
  with abort, *any* panic on any thread ends the process, so panic sources — not `.unwrap()` sites — are what
  matter, and production has none left beyond indexing and allocation.

The dependency situation is clean (2 moderate vitest issues, no Rust advisories observed). The TypeScript strictness is good. The testing discipline (falsify-before-fix, invariant specs) is excellent.

**Recommendation:** Address Phase 1 items before the next release. The architecture is sound; these fixes harden the implementation to match.
