# Code & Security Audit — AI-Provider Router

> **Audited:** the working tree at commit on 2026-09-27 — `apps/desktop/src-tauri/src` (≈63,300 lines Rust),
> `apps/desktop/src` (≈15,700 lines TS/TSX), `packages/router-core`, `packages/adapter-spec`,
> CI workflows, Tauri config, and dependency manifests.
> **Method:** read-only. Every finding below cites `file:line` and was re-verified against the file
> contents rather than inferred. Instrument checks were re-run where a first reading looked wrong
> (see *Method notes* at the end).
> **Date:** 2026-09-27
> **Companion documents:** [`AUDIT_REPORT.md`](AUDIT_REPORT.md) audits the *specification* (2026-09-15, pre-code).
> This report audits the *implementation* and supersedes it for anything about code.

---

## Fix status (updated 2026-09-27, same day)

Eight findings were fixed immediately after this report was written — four in the first pass, then M1,
M2, and M3+M8 together. **The findings below are kept as the record of what was found; read this table for what
is still open.** Leaving the report un-updated would have made it an instance of the very drift it
audits.

| ID | Status | What changed |
|---|---|---|
| **H1** | **Fixed** | `egress::require_secure_scheme` (`core/egress.rs`) refuses `http` to any non-loopback host, and is applied in `check_url`, `fetch_image`, **and the image client's redirect policy** — a hop could previously downgrade `https` → `http` after the initial check passed. `adapter-spec`'s `baseUrl` gained the matching refine, so the form refuses at input time rather than at the first request. 3 new Rust tests and 5 new TS cases; the loopback carve-out (Ollama 11434, LM Studio 1234, IPv6 `[::1]`) is pinned, as is the lookalike-host case (`127.0.0.1.evil.example`). |
| **H2** | **Fixed** | `Models.tsx`'s `togglePublish` adopts **only** the host's answer and surfaces a failure in `--danger` instead of rendering the optimistic value. The `.catch(() => null)` → adopt-the-local-guess fallback is gone, and the comment that contradicted it with it. |
| **H3** | **Fixed** | `SECURITY.md` rewritten against the file vault: it now states the mode-600 file and that a secret on disk is the *design*, drops the deleted worker-window bullet, drops the impossible keychain-prompt paragraph, and adds the loopback `/admin/*` surface and the UI session credential to the in-scope list. |
| **M7** | **Fixed** | `objc2`, `objc2-foundation`, `eventsource-parser` and `router-core`'s unused `zod` removed; `pnpm-lock.yaml` refreshed. The sweep also corrected `docs/ARCHITECTURE.md`'s dependency table and a **fifth D42-class** stale comment in `tauri/mod.rs:1` that D42's own sweep had missed. |
| **M1** | **Fixed on the auth path; residual recorded** | The two **uncached** reads on the authenticated request path — the per-app key scan and the spend gate — now run on the blocking pool. `check_gateway_key` became `async` and gained `app_keys_blocking` / `spend_gate_blocking` (`gateway.rs`); `egress::build` offloads `check_secret_host` **and** the vault read in one hop via a new `Store::offload`. 10 direct call sites plus 52 `authorize` routes updated. **Residual:** `principal::allows` / `key_principal_for` in `context_scope.rs` stay inline — both sit behind the **off-by-default** memory toggle, so a disabled layer performs *zero* database reads; the reasoning and the two rejected alternatives are recorded at the call site. |
| **M2** | **Fixed on the request path; the trade-off is now recorded** | A census that blanks `#[cfg(test)]` regions found **11** production panic sites where this report's Evidence listed 9 — it had missed `ledger.rs:151`, a **non-lock** `.unwrap()` on the usage-ledger append. The **8** reachable from a request are now fallible: `sandbox.rs`'s two `Regex::new` calls report a lint error instead of aborting (through a new `compile_patterns` seam, so the arm is reachable from a test), `js_number_to_string` is total for non-finite input, `to_base36` no longer needs `from_utf8`, the two `as_object` unwraps in tool sanitising are gone, and `ledger.append` returns an error. The **3** that remain are construction-time by design (`Egress`'s two clients, the Tauri builder) — all three run before any request exists. The abort trade-off and its blast radius are recorded in `dev-book/06-conventions.md`, and the 2026-09-20 census this report leaned on is corrected in `SECURITY_AUDIT_2026-09-20.md` H3. |
| **M3** | **Fixed** | `gateway-client.ts`'s unguarded `JSON.parse(raw) as { port?: number }` is now read through a new `portFrom(v)` that accepts numeric strings and rejects non-ports, with `parseHostJsonOr` supplying `{}` for a corrupt row. A plain strict guard was **rejected** here: it reads a hand-edited `{"port":"9123"}` as invalid and falls back to `8787`, which is a regression against the old `as` — and it would have re-created the closed-port symptom this fix exists to prevent. Skipping the whole-row check also tolerates the extra `enabled`/`toolsEnabled` keys a real row carries. 7 specs in `gateway-client.base-url.test.ts`. |
| **M8** | **Fixed — and the finding's own census was wrong** | This section says "six sites"; the real count is **~37** asserted `fetchAdmin` results in `store.ts` alone (22 `as Promise<…>`, 15 `as {…}`, plus the modality cast), re-derived by reading the file rather than recited from this report. All are converted. New `lib/host-boundary.ts` — which **imports nothing**, so `gateway-client.ts` can use it without an import cycle — supplies the primitives and `HostShapeError`; `lib/host-guards.ts` holds 16 guards as the runtime twins of `store.ts`'s interfaces. **Two policies, not one:** strict-throw for reads that feed rendering, default-fallback for boolean-flag/optional reads, where a missing field is already the safe answer. `HostShapeError extends Error`, **not** `TypeError`, because `isUnreachable(e)` is `e instanceof TypeError` — extending it would have made a shape mismatch degrade silently at boot instead of failing loudly. The modality cast is now a type predicate. 37 specs across 3 new files; both fixes falsified by reverting each in turn. |
| **M4** | **Fixed — and the finding's own recommendation was flawed** | The staleness gate was `FileStamp { modified, len }`, and metadata is not a fingerprint: a same-length rewrite on the same timestamp compares equal, so the early return kept serving the superseded secret. **Measured:** it does not arise spontaneously on macOS/APFS (**0 collisions in 5000** same-length rewrites; **1500/1500** distinct mtimes), but it is **deterministic on any filesystem** — the new test *constructs* the collision with `set_modified`, and it was **red** against the old stamp and green against content comparison. It also arises by itself on Linux, where timestamps come from the coarse clock — and Linux is a supported target, because `ci.yml`'s `headless-service` matrix builds this binary on `ubuntu-latest`. **The recommendation below is wrong:** "add a content hash (the file is small and is already being `stat`ed)" — being `stat`ed is not being *read*, and hashing requires reading, which is the cost the stamp exists to avoid; the `(mtime, len, inode)` alternative is the same metadata class. The fix taken is a fourth option the report did not consider: **compare the file's bytes** and parse only on difference, which deletes `FileStamp` outright. **A second defect closed with it:** the old gate latched the new stamp *before* reading, so one transient read failure emptied the cache and then compared equal forever — `NotFound` now clears the map while any other error changes nothing and is retried. `cargo fmt` and `cargo clippy -D warnings` clean; vault tests 10/10. |
| **M5** | **Relabelled — and the finding's delete option was not available** | The finding offered "delete them and their test, or mark them `@deprecated`". **Deletion would have broken three register entries and one increment's evidence.** `dev-book/07-drift-register.md` D32/D33/D34 each close with *"the TypeScript is left exactly as written, so the reference the port is measured against does not move under it"*, and increment 22 pinned the Rust port's hash helpers *"by running the original in Node rather than by reading it"* (`generateToolCallId(0, "read", "{}")` → `call_tcdq4k`). The file is a **frozen oracle**, not dead code. So the *exports* went instead of the module: `index.ts:57-58` re-exported five functions, a type, and `detectClient`/`ClientHint`, and **nothing but each module's own spec imported any of them** — an export with no importer is a promise the package cannot keep, since a consumer reaching for one would be reaching for code no request path runs. Both module headers now name the Rust authority (`core/gateway_normalizer.rs`, reached from `core/router_bridge.rs`) and state they are not on a production path. **Both header rewrites are line-count-preserving on purpose:** the Rust port and this dev book cite these files **by line number** (`gateway-normalizer.ts:596-602`, `:513-516`; `gateway-normalizer.test.ts:375-382`, `:380`), so a prepended header would have silently invalidated every one of them — the D69 "recipe that no longer resolves" class. Verified after the edit: the header is exactly 16 lines and both citations still resolve to the reverse-map construction and the `reasoning_effort` guard. |

**Gates after the fixes:** `cargo clippy --all-targets -D warnings` clean · `cargo fmt --check` clean
· `cargo test --lib` **1340 passed / 0 failed** · `pnpm typecheck` clean across 3 workspaces ·
`pnpm test` 46 test files green · `check-doc-links` 127/127 · `docs:book` builds ·
`key-leak-grep` OK · `check-version-sync` OK · `cargo check --no-default-features --all-targets` clean.

**Both M1 offloads were falsified, not assumed.** Stubbing `app_keys_blocking` to `Vec::new()` turns
**8** tests red; stubbing `spend_gate_blocking` to `None` turns **4** red. This matters because a
refactor whose new path is covered only by *direct unit calls* can pass while the request path
diverges — these fail through the real handler (`post_chat(&s, "sk-aip-app1")`), which is the
transport the change actually rewired.

**Gate status, later on 2026-09-27.** `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`
are clean, and `cargo test --lib vault::` is **10/10**. The **full** `cargo test --lib` is
**1343 passed / 2 failed**, both in `core::egress::stall_tests`, both asserting the same property with
the same symptom — `connections: 2` where `1` is expected, i.e. a retry after a status was already on
the sink. **Neither is from this audit's work**: re-run single-threaded, those two pass and a *different*
test in the same module fails instead, so the failing set moves with scheduling. The retry/budget logic
they exercise is uncommitted egress work (increments 34/35). **Whether this is a timing-sensitive
harness or a genuine race between "the sink got the status" and "the retry decision" has not been
measured** — it is recorded as open rather than as flakiness, and it should be diagnosed before those
commits are pushed.

**Still open:** M6 and the Low table.

**The egress failures were diagnosed the same day, and the defect was in the tests.** `silent_listener`
in `core/egress.rs`'s `stall_tests` wrote its response head **on accept, without reading the request**,
which races the client's request write: hyper can observe a response before it has finished writing,
classify the dial as a pre-response transport error, and retry — so `connections` read `2`. **Measured
rather than labelled flaky:** 4 of 10 single-threaded runs red before the fix, 0 of 10 after, and the
failing test moved between runs, which is what a schedule-dependent race looks like. The listener now
drains the request head before answering, which is what a real server does — the old shape exercised a
sequence the production path cannot produce, so the code under test was behaving correctly on an input
the harness invented. **The product was never implicated**, which is consistent with the operator's
end-to-end portfolio build through the router.

**A second vault defect, found while fixing M4's neighbour and fixed the same day.** `put`/`delete` are
read-modify-write over the *whole* file, and two processes write it by design (`aiproviderd` mints
`masterkey`; the app writes `gwkey:ak-ui` and provider keys) with nothing excluding them. It failed in
**both** directions at once, measured by a new two-process test: **(1)** both processes wrote the same
`.secrets.json.tmp`, so one `rename`d it out from under the other and the loser's `save` failed outright
— **26 of 50** `put`s returned `No such file or directory`; **(2)** where neither errored, the whole-map
`save` discarded the other's entry — **25 of 50** accounts were gone, with both calls returning `Ok`. The
fix is `std::fs::File::lock` (`flock` on unix, `LockFileEx` on Windows) over the read-modify-write,
**with no new dependency**: std stabilised file locking in Rust 1.89 and this toolchain is 1.98.1, so
the alternative — a lockfile protocol, or a crate — was avoidable. One in-process mutex accompanies it,
because a concurrent `get` calls `load`, whose `*map = fresh` is a *replace*, and could otherwise erase
a `put`'s un-saved mutation. **Falsified both ways on identical test code:** with the lock stubbed out
the new test is **3/3 red**; with it, **5/5 green**. The kernel releases the lock when the holder dies,
so there is no stale-lock state to age out or steal — and the lock file is never unlinked, which is
load-bearing rather than incidental: a probe that removed and re-created it locked a *different inode*
and excluded nobody.

**Swept — and the sweep found a second tier: 338 stale references across 46 files, not ~100 in code.** D60 and
D62 swept the *documents* and the *user-facing strings*. D62's verification was scoped **and calibrated** —
`grep -rni keychain apps/desktop/src apps/desktop/web-test` → 0, with a control grep proving the instrument
reports presence — and that scope excluded `src-tauri/`, `packages/`, `e2e/`, `README.md` and all of `docs/`.
Re-censused with the same instrument: **338 lines across 46 files**. Every tier is now swept except the
deliberately-historical, leaving **190 lines across 30 files**, each of which is one of: a dated record
(`DECISIONS.md`, `CHANGELOG.md`, the drift register, the dated audits, `LIVE_GATEWAY_TEST_2026-09-22.md`), a
correct statement of the keychain's **absence** (`SECURITY.md`, `README.md`, `MASTER_PROMPT.md`,
`ARCHITECTURE.md:736`), a code-signing reference (`CONTRIBUTING.md:87`, `09-status.md:42`), a plan-era
checklist row (`ARCHITECTURE.md:906`, inside the Phase 1 plan), or a deliberate pre-27a marker
(`gateway_cmds.rs`'s three, `vault.rs`'s two). `AGENT_PROMPT_HEADLESS_SERVICE.md` was swept and then
**reverted**: its content is a point-in-time snapshot — it cites 104 Rust tests against today's 1346, and its
"Today" section describes a state since completed — so rewriting it would misrepresent what was planned and
when. The user-visible site went first: `core/egress.rs:37`'s `SecretMissing` and its mirror at
`e2e/host-http.ts:108` now name the secrets file, with `ui_session.rs`'s test name, fixture string and
assertion moved together.

**Two claims the sweep got wrong, and the rule each confirms.** (1) `03-contracts.md` re-pointed the `503` row
at "the `masterkey` account is not in the secrets file yet" — preserving the old sentence's *structure* while
swapping its mechanism, and **inverting the codes**: `Absent` answers **401 `no master key configured`**, and
`503` means the read did not complete (`gateway.rs:1543-1557`). A noun swap that preserves a false structure is
not a sweep. (2) `06-conventions.md` carried the **superseded** panic count — "found nine" where the census
found **eleven** — this report's own Evidence figure surviving next to its own correction.

**One bound left unsized rather than re-justified.** `gateway_cmds.rs`'s `SYNC_KEY_WAIT = 45 s` was sized
against a pre-27a keychain read measured at 18-39 s. That mechanism is gone and nothing measures the vault's
slow path, so the bound is now recorded as **unsized** — retained because its cost is a sleeping thread, not
because 45 s is known to be right — rather than re-argued from a measurement that no longer describes
anything. Its old explanation of the `no gateway key yet` race is likewise recorded as **unexplained** rather
than re-supplied.

---

## Verdict

**This is an unusually well-engineered codebase, and the audit found no critical vulnerability.**
The security-critical surfaces — gateway authentication, the egress allowlist, the tool executor
sandbox, and secret storage — are each built to a standard well above typical desktop-app code, and
several are accompanied by tests that pin the *specific* failure mode they were written to prevent.

The findings that matter are not holes in the security model. They are **one correctness defect that
silently reports success on failure**, **one missing input constraint that lets a credential leave in
cleartext**, and **a security policy document that now describes a design the code no longer has** —
plus a set of consistency, dead-code, and tooling gaps that will compound if left.

| Severity | Count | Theme |
|---|---|---|
| **Critical** | 0 | — |
| **High** | 3 | Cleartext credential path; swallowed host-write; stale security policy |
| **Medium** | 8 | Blocking SQLite on the async runtime; panic-fatality; unguarded parses; unused deps; no TS lint gate |
| **Low** | 11 | Constant-time nit; orphaned secrets; missing cleanup; duplicated constants; dead code; the remaining unvalidated JSON boundaries |

---

## High

### H1 — A remote provider configured over `http://` sends the API key in cleartext

**Evidence.**
- `packages/adapter-spec/src/manifest.ts:133` — `baseUrl: z.string().url()`. Zod's `.url()` accepts
  **any** scheme, including `http:`.
- `apps/desktop/src/lib/providers/manual-manifest.ts:73` — `provider: { baseUrl: input.url, ... }`,
  passed through unmodified.
- `apps/desktop/src-tauri/src/core/persist.rs:107` — `base_url` stored verbatim; no scheme check on
  the write path.
- `apps/desktop/src-tauri/src/core/egress.rs:220-227` — `check_url` parses the URL and checks the
  **host** only. `matches!(u.scheme(), "http" | "https")` appears at `egress.rs:983`, but that is
  inside `hosts_in_body` (the image carve-out scanner), not the enforcement path.
- `egress.rs:262` `inject_secret` then attaches the provider credential to that request.

**Impact.** A user who configures a remote provider as `http://…` (a typo, a copied internal URL, or
a hostile setup instruction) transmits their provider API key and full prompt in cleartext over the
network. The allowlist does not help: the host is legitimately the provider's.

**Recommendation.** Enforce the scheme in `check_url`, where the allowlist decision already lives, so
there is one authority:

```rust
// http is legitimate for loopback (Ollama:11434, LM Studio:1234) and must stay permitted.
if url.scheme() != "https" && !is_local(host) {
    return Err(EgressError::InsecureScheme(url.scheme().into()));
}
```

Mirror the same rule in `manifest.ts` (`z.string().url().refine(...)`) so the form rejects it before
persistence, and surface a clear message rather than a generic validation error.

---

### H2 — A failed host write is reported to the user as success

**Evidence.** `apps/desktop/src/screens/Models.tsx:34-43`:

```ts
const res = await workbuddySetModels(next).catch(() => null);
// Trust the host's answer rather than the local guess — it dedupes and is the thing that
// actually wrote the file.
setPublished(res ? res.models : next);
```

**Impact.** When `workbuddySetModels` **fails**, `res` is `null` and the code falls back to `next` —
the local guess. The UI therefore renders the toggle as applied while the client's config file was
never written. The comment states the opposite of what the fallback does. This is precisely the
"a swallowed write is invisible to every reader" class this project has already identified and
guarded against elsewhere (`trail-health`, `writeTrail`).

**Recommendation.** Distinguish the two outcomes instead of collapsing them:

```ts
try {
  const res = await workbuddySetModels(next);
  setPublished(res.models);           // authority is the host
} catch (e) {
  setError(String(e));                // surface it; do NOT adopt the optimistic value
}
```

The same `.catch(() => null)` → adopt-local-value shape should be swept for across
`Memory.tsx:232`, `Context.tsx:63-64`, `Models.tsx:31`, `Agents.tsx:69,77`, `Assistant.tsx:648` —
there the failure is at least visible as stale data, but the class is one helper away from being fixed.

---

### H3 — `SECURITY.md` describes a credential model the code no longer has

**Evidence.** `SECURITY.md` states three things that are now false:

| Claim | Location | Reality |
|---|---|---|
| "holds provider credentials in the OS keychain" | `SECURITY.md:19-20` | `core/vault.rs:1-10` — "Raw secrets live in `<data_dir>/.secrets.json` (mode 600)… **not** the OS keychain"; the `keyring` crate was removed in increment 27a. |
| "Keys live in the OS keychain, so a key written to disk is a bug by definition" | `SECURITY.md:30-31` | The exact inverse. A secret **is** on disk by design; the control is file mode 600, not the keychain. |
| "the hidden worker window's capability set beyond event listen/unlisten" | `SECURITY.md:37-39` | No worker window exists. `grep` for `WebviewWindowBuilder`/`WindowBuilder` returns **no matches**; `gateway.rs:1411-1415` records that "25f deleted the webview". `capabilities/default.json` scopes `windows: ["main"]` only. |
| "until you approve it every gateway request answers `503 master key unavailable`. That prompt is expected" | `SECURITY.md:66-69` | There is no keychain prompt to approve. `vault.rs` needs no code-signing identity. |

**Impact.** Two distinct costs. A reporter who reads the policy will mis-scope their research (the
worker window they are told to attack does not exist) and mis-assess what they find (a key on disk
is presented as a bug by definition, when it is the documented design). And the stated *in-scope*
surface no longer matches the implemented one, so a genuine gap in the current model can be argued
out of scope by citing a document that is itself out of date. For a security policy this is a
correctness defect, not cosmetics.

**Recommendation.** Rewrite the "What this project is", "In scope", and "Distribution and signing"
sections against the file vault: state the mode-600 file, state that a world-readable `.secrets.json`
**is** a finding, drop the worker-window bullet, drop the keychain-prompt paragraph, and add the
current privileged surface (`/admin/*` on the loopback listener, the UI session credential from
`ui_session.rs`). The project already runs a `check-doc-links` gate; a short `check-doc-claims` step
grepping for removed names (`keychain`, `worker window`) would have caught this — the same technique
that caught the last three doc drifts.

---

## Medium

### M1 — Synchronous SQLite under a `std::sync::Mutex`, called directly from async handlers

**Evidence.** `core/store.rs:504` — `conn: Mutex<rusqlite::Connection>`. Every `persist::*`,
`capture::*`, `memory::*` and `session_context::*` function is synchronous and takes that lock; they
are called directly from `async` axum handlers — e.g. `gateway.rs:1571 core.app_keys()` →
`persist::active_gateway_key_stamps`, and `egress.rs:235 check_secret_host` (which runs on the
request path before every credentialed egress). `grep` found exactly **one** `spawn_blocking` at the
time of this audit (`core/router_bridge.rs:489`); the count is **four** as of the fix below.

**Impact.** A blocking `stat`/`fsync`/`SELECT` on a Tokio worker thread stalls that worker. The
gateway admits 8 concurrent requests (`try_slot`, `gateway.rs:1424`), so this degrades rather than
deadlocks — but the vault deliberately performs a `stat` on **every** secret read
(`vault.rs:143-145`), and that sits on the auth path, so its latency is added to every request under
the same lock that serialises all database access.

**Recommendation.** Two options, in order of cost/benefit:
1. **Cheapest:** wrap the auth-path and spend-gate DB reads in `tokio::task::spawn_blocking`. These
   are the hot ones; the UI CRUD commands can stay synchronous.
2. **Structural:** hold `Connection` in a small blocking pool (`tokio-rusqlite`, or a hand-rolled
   worker + channel) so no async thread ever owns the mutex.

Given the documented 8-permit bound, option 1 is proportionate; option 2 is the right call only if
concurrency is raised.

**Fixed 2026-09-27 — option 1, taken literally.** The reads named above are off the reactor:
`check_secret_host` and the vault read share one `Store::offload` hop inside `egress::build`, and the
per-app key scan and the spend gate are resolved by `app_keys_blocking` / `spend_gate_blocking` from
an `async` `check_gateway_key`. The UI CRUD command surface was deliberately left synchronous, per the
recommendation. Two details were found while implementing rather than while auditing:

- **The vault read had to move *with* `check_secret_host`, not after it.** It `stat`s and may read a
  file, so leaving it inline would have kept a blocking call on the same path — moving one of two
  blocking calls is not a fix, and would have made the offload look complete while it was not.
- **The memory path is a deliberate residual, and its *condition* is what makes that defensible.**
  `principal::allows` and `key_principal_for` (`context_scope.rs:549`) stay synchronous. Both are
  reached only with the memory toggle **on**; with it off — the default — `key_principal_for` is never
  called and `allows` returns on its first line without opening the store, so a disabled layer costs
  **zero** database reads. Offloading them would require either resolving scope outside
  `inject_context` (a second authority free to drift from the one inside it) or making that function
  `async` (converting the ~33 synchronous tests that use it as scaffolding). `Deadline` already states
  the same trade: it bounds *how many* SQLite calls a request pays for, not how long one takes.

The change is a refactor, so the suite's test count is unchanged (1340) — which is precisely the case
where a green suite proves nothing. Both offloads were therefore **falsified**: stubbing
`app_keys_blocking` to `Vec::new()` turns **8** tests red, and stubbing `spend_gate_blocking` to
`None` turns **4** red, all through the real handler (`post_chat(&s, "sk-aip-app1")`) rather than
through direct calls to the helpers.

### M2 — `panic = "abort"` makes every panic a whole-process outage

**Evidence.** `Cargo.toml:136-141` — `panic = "abort"` under `[profile.release]` only. Production
`expect()` calls that can panic: `egress.rs:898,913` (`reqwest` client construction),
`sandbox.rs:267,304` (`Regex::new(…).expect("a FORBIDDEN pattern must compile")`, reached on the
first code-adapter lint), `sandbox.rs:622-623`, `gateway_normalizer.rs:406,764,772`.

**Impact.** Under `abort`, one panic terminates the gateway for **every** client, not just the
request that triggered it. The mitigating fact is worth stating precisely: `panic = "abort"` also
means a poisoned mutex can never be *observed*, so the ≈200 production `.lock().unwrap()` calls are
effectively infallible in release — they are not the risk. The `expect()` calls are.

**Recommendation.** Convert the request-reachable `expect()`s to fallible paths returning
`ToolResult::err`/`EgressError` (the tool executor's own contract is "never panics on model input" —
`sandbox.rs` should honour it). If abort-on-panic is a deliberate availability trade-off, record it
in the dev-book as a decision with its blast radius, so it is not re-litigated.

### M3 — Unguarded `JSON.parse` on a persisted settings row

**Evidence.** `apps/desktop/src/lib/gateway-client.ts:58-60`:

```ts
const raw = await invoke<string | null>("settings_get", { key: "gateway" });
const s = raw ? (JSON.parse(raw) as { port?: number }) : {};
```

**Impact.** A corrupt or hand-edited `gateway` row throws inside `gatewayBaseUrl()`, which is awaited
by `sendAdmin` — so **every** `/admin/*` call fails with an unrelated parse error, and the failure
looks like a network fault. Reachability is narrow (this branch is taken only when `gateway_status`
returns no usable port, `gateway-client.ts:54`), which is why it is Medium rather than High. Compare
`store.ts:457-461`, where the same shape *is* guarded.

**Recommendation.** Wrap in `try/catch` and fall through to the `8787` default. The same treatment
applies to `store.ts:330` (`JSON.parse(row.bodyJson)`), which is unguarded where its twin at
`store.ts:457-461` is not.

### M4 — The vault reload stamp can miss a same-length rewrite

**Evidence.** `core/vault.rs:36-40,151-158` — staleness is detected by comparing
`FileStamp { modified, len }`. `mtime` granularity is coarse on some filesystems; a rotated secret of
identical length written inside one tick leaves the stamp unchanged, and the process keeps serving
the old value.

**Impact.** Bounded and self-inflicted: this is the mechanism that exists to make a cross-process
revoke take effect without a restart (`vault.rs:284-295` pins that). A missed tick reintroduces the
stale-credential window the fix closed, for one rotation. It fails **closed** for a revoke only if
the reload is missed; it fails **open** in the sense that a revoked key keeps authenticating briefly.

**Recommendation.** Add a cheap content hash to `FileStamp` (the file is small and is already being
`stat`ed), or compare `(mtime, len, inode)` and treat an equal stamp as "unverified" once per N
seconds. A hash makes the check exact for negligible cost.

### M5 — Two normalizers, one of them dead, in a repo with two live routers

**Evidence.** `packages/router-core/src/gateway-normalizer.ts` (26.8 KB) and
`gateway-client-detector.ts` are re-exported at `packages/router-core/src/index.ts:57-58`, but a
repo-wide search finds their only importer is
`packages/router-core/test/gateway-normalizer.test.ts:9-10`. The normalizer that actually serves
requests is Rust: `core/gateway_normalizer.rs:140`.

**Impact.** This is the headline architectural concern, and it is now sharper than "two routers":
the Rust gateway and the TS `router-core` are **two live implementations of the same normalization
contract**, and the TS one is no longer exercised by any production path. A future OpenAI-compat fix
applied to the live Rust normalizer will not be seen by the TS copy, and the TS copy has a green
test suite asserting the old behaviour.

**Recommendation.** Decide the TS modules' fate explicitly — either delete them and their test, or
mark them `@deprecated` in `index.ts` with a pointer to the Rust authority. Do not leave a tested
module that no request path reaches; a passing test on dead code reads as coverage.

### M6 — 15,700 lines of TypeScript with no linter

**Evidence.** No `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, or `biome.json` anywhere in the
repo (searched to depth 3, excluding `node_modules`). The TS gate is `tsc` only
(`apps/desktop/package.json:12`), plus `noUnusedLocals`/`noUnusedParameters`.

**Impact.** `tsc` cannot see the bug classes this codebase actually contains. Floating promises,
missing `useEffect` dependencies, `any` escapes, and unsafe assertions are all invisible to it —
and the parallel frontend scan found instances of each (see L4, M8). The Rust side runs clippy with
`-D warnings`; the TS side has no equivalent, which is an asymmetry rather than a policy.

**Recommendation.** Add ESLint with `typescript-eslint` recommended-type-checked plus
`react-hooks` and `@typescript-eslint/no-floating-promises`, and wire it into `ci.yml` beside
`pnpm typecheck`. Prettier is optional given the code's consistent formatting, but the lint rules
are not.

### M7 — Unused dependencies

**Evidence.** Verified by searching the whole crate/package, not just `src`:

| Dependency | Declared at | References found |
|---|---|---|
| `objc2` | `Cargo.toml:131` | **0** (also 0 for `NSProcessInfo`, `beginActivity`, `App Nap` outside `Cargo.lock`) |
| `objc2-foundation` | `Cargo.toml:132` | **0** |
| `eventsource-parser` | `packages/router-core/package.json:18` | **0** (only the `package.json` line itself) |
| `zod` | `packages/router-core/package.json:17` | **0** in `router-core/src`; the only real import is `packages/adapter-spec/src/manifest.ts:9` |

**Impact.** The `objc2` pair is the interesting one: the Cargo comment says they exist for "App Nap
suppression. The worker webview is hidden…" — and the worker webview was deleted (25f). The
dependencies outlived their only consumer. That is a live example of the deletion-sweep problem: the
code was removed, the justification comment and the manifest entry were not.

**Recommendation.** Remove all four. Then grep for the names you removed — `objc2`, `App Nap`,
`worker webview` — across `Cargo.toml`, the dev-book, and `SECURITY.md` (which still promises a
worker window: H3).

### M8 — Untrusted host JSON asserted into domain types

> **Correction (2026-09-27, when the fix landed):** the census below is wrong — there are **~37**
> asserted `fetchAdmin` results in `store.ts` alone, not six, and the line numbers listed had already
> drifted. It is left as written, because the understated count is itself part of the finding: a scan
> that finds six of thirty-seven sites is not a scan. **This is now fixed** — see the fix-status table.

**Evidence.** `apps/desktop/src/store.ts:405-410` — `fetchAdmin("GET", "/admin/providers") as
Promise<HostProviderRow[]>` (six sites, `:327`, `:337`, `:435`, `:458`), and
`m.modality as CatalogModel["modality"]` at `:435`.

**Impact.** The IPC boundary correctly returns `unknown`, and `store.ts:457-461` shows the codebase
knows how to validate — but these six sites assert instead. A host-side shape change becomes a
runtime `undefined` deep inside rendering rather than a clear error at the boundary. The app's own
memory records this exact lesson: "a `#[tauri::command]` arg, a serde field and the Rust→webview
`BridgeRequest` are different boundaries".

**Recommendation.** Run the existing zod schemas (already a dependency) over these six responses, or
add a tiny `parseOrThrow<T>` helper. The cost is a few lines; the benefit is that a boundary
mismatch fails where it happens.

---

## Low

| # | Finding | Evidence | Recommendation |
|---|---|---|---|
| L1 | `constant_time_eq` truncates its length guard: `(a.len() ^ b.len()) as u8`. A length difference that is a multiple of 256 reads as equal. Not exploitable (the byte loop still catches a NUL-free mismatch), but the guard is not what it reads as. | `core/gateway.rs:1479` | Accumulate into `usize`, or drop the length term entirely and rely on the loop with `black_box`. |
| L2 | A failed secret delete is discarded, leaving an orphaned entry in `.secrets.json`. | `persist.rs:149,317,1216`; `gateway_admin.rs:360,483,604` (`let _ = vault::delete(...)`) | Log at `warn` with the account name, and retry once. An orphaned secret is a credential that outlives its row. |
| L3 | No unmount cleanup for the in-flight assistant stream; `setState` continues after unmount on both the stream and the agent-event handler. | `Assistant.tsx:623,712,1009` (`abortRef` only aborted by the Stop button) | Abort in a `useEffect` cleanup, and guard the setters with the existing mounted/generation ref. |
| L4 | Overlapping async reads write the same state with no generation guard, so an older response can land last. The pattern exists elsewhere in the same codebase. | `Memory.tsx:219-235`, `Context.tsx:62-65`, `Models.tsx:25-32`; contrast `Providers.tsx:788` (`const gen = useRef(0)`) | Apply the `Providers.tsx` generation-counter pattern. |
| L5 | `#[allow(...)]` without a written reason. The repo's convention (and its clippy comment in `ci.yml`) is that every allow carries one. | `engine.rs:914,983`, `gateway.rs:1407`, `js_host.rs:517`, `memory.rs:1053`, `gateway_responses.rs:211` | Add the one-line reason, or drop the allow. |
| L6 | Duplicated constants that must not drift: `CHARS_PER_TOKEN = 4` re-derived as `Math.round(a.promptChars / 4)`; port `8787` in three files; the `2500 ms` poll interval in two. | `store.ts:190-191` vs `context-compress.ts:42`; `gateway-client.ts:60`, `Gateway.tsx:93,204`, `Control.tsx:510-511`; `Gateway.tsx:101`, `Control.tsx:504` | Import the constant from one module. `CHARS_PER_TOKEN` is the load-bearing one — a token estimate that disagrees with the compressor is a budget bug. |
| L7 | Two status classifiers implementing the same rule. | `lib/keys/verdict.ts:34` vs `packages/router-core/src/errors.ts:29` | Keep one; have the other delegate. |
| L8 | String-built SQL in a codebase that parameterizes everywhere else. Safe today — all five callers pass literals — but the shape invites a mistake. | `core/store.rs:910` (`format!("PRAGMA table_info({table})")`) | Accept a const enum of table names, or add an `assert!(table.chars().all(|c| c.is_ascii_alphanumeric() \|\| c == '_'))`. |
| L9 | Truncating casts on the gateway port. | `core/gateway.rs:2003` (`port as u16` from `as_u64`), `tauri/workbuddy.rs:248` | `u16::try_from(...)` with a clear error. |
| L10 | `rand 0.8` (0.9 is current; `OsRng`/`gen_range` are renamed there). The other pins (`rusqlite 0.32`, `rquickjs 0.9`) are deliberate and documented — leave them. | `Cargo.toml:120` | Bump when convenient; no security impact, key material is already 128-bit from `OsRng` (`gateway.rs:1899`). |
| L11 | The shape-assertion class M8 named survives at the *other* JSON boundaries: `JSON.parse(…) as X` over persisted row columns and IPC results. Every one of these **is** wrapped in `try/catch` (several also validate after parsing), so they survive malformed JSON — but not *well-formed JSON of the wrong shape*, which still flows through typed as `X`. Blast radius is lower than M8's: these feed display strings and best-effort parses, and `parseMeta<T>` is a deliberate generic escape hatch. Found while fixing M8, by checking the scope boundary instead of assuming it. | `ipc-client.ts:163`; `screens/{Context,Activity,Providers,Assistant,Onboarding}.tsx`; `lib/tools/agentLoop.ts:64`; `lib/context/engine.ts:60`; `lib/memory/engine.ts:133,319` | Where a guard already exists in `lib/host-guards.ts`, run it; otherwise add one. Keep `parseMeta<T>` generic, but document it as the deliberate exception so it is not copied. |

---

## What is genuinely strong (verified, not assumed)

Stated because a credible audit has to record what it could not break.

- **Gateway binding.** `core/gateway.rs:2045,2201` — `SocketAddr::from((Ipv4Addr::LOCALHOST, port))`.
  Loopback only, with no LAN option to misconfigure. `SECURITY.md`'s claim here is accurate.
- **Credential comparison.** Every comparison uses `constant_time_eq` and the app-key loop
  deliberately does not break early (`gateway.rs:1566-1576`), so there is no length or first-byte
  oracle. The brute-force backoff is applied *after* the key check, so a valid credential is never
  throttled by someone else's failures (`gateway.rs:1578-1596`) — and the TS retry logic in
  `gateway-client.ts:110-119` understands that, with the reasoning written down.
- **Egress allowlist.** `AllowList` is a lowercased exact-match `HashSet` (`egress.rs:77-90`) — no
  substring or suffix bypass. `is_local` **parses** `Ipv4Addr` rather than prefix-matching, so
  `127.evil.example` and `127.0.0.1.5` stay remote (`egress.rs:103-110`). `check_secret_host` joins
  `api_keys → providers` to enforce secret↔host pairing (`egress.rs:230-259`). The image carve-out
  is scoped, expiring, and never widens the allowlist — and there is a test asserting exactly that
  (`egress.rs:1183`).
- **Tool executor.** Program allowlist, a `git` subcommand gate that excludes every network
  subcommand (`tools.rs:54-62`), an argument-level path-escape guard (`tools.rs:776-782`),
  `env_clear()` with an explicit `PATH`, a timeout with kill, and output truncation
  (`tools.rs:637-690`).
- **Zero `unsafe`** in the entire Rust crate, and **zero** `panic!`/`todo!`/`unimplemented!` in
  production code.
- **Secrets never reach TypeScript.** The UI session credential lives in a module-level `let`
  (`gateway-client.ts:24`), never `localStorage`/`sessionStorage`/cookies, with the reason stated.
- **Vault.** Atomic write via `write → chmod 600 → rename` (`vault.rs:171-193`), and it re-reads on
  stamp change so a cross-process mint *and* a cross-process revoke both take effect without a
  restart — with tests pinning both directions (`vault.rs:263-295`).
- **CI is stronger than most production repos.** `clippy -D warnings` and `rustfmt --check`,
  `pnpm audit --audit-level=moderate`, RustSec on a weekly cron (so an advisory against unchanged
  code still fires), a doc-link resolver, a dev-book structural validator, an `otool` check that the
  bundled service binary links no WebKit, a key-leak grep, and a version-sync check. The comments
  next to each step record the *specific* failure that step was added to catch.

---

## Recommended order of work

1. **H1** — enforce `https` for non-loopback hosts in `check_url` and the manifest schema. One
   function, one test, closes a cleartext credential path.
2. **H2** — stop treating a failed host write as success in `Models.tsx`; sweep the same
   `.catch(() => null)` → adopt-local shape.
3. **H3** — rewrite `SECURITY.md` against the file vault; delete the worker-window and keychain-prompt
   paragraphs.
4. **M7** — remove the four unused dependencies, then grep the removed names (`objc2`, `App Nap`,
   `worker webview`) across docs, because the deletion's doc sweep is larger than the set of files it
   edits.
5. **M6** — add ESLint with the type-checked ruleset. **Correction (2026-09-27):** the rationale
   originally given here — that it "would have caught M3, M8, L3 and L4 mechanically" — **does not hold
   for M3/M8**, and that claim was the only reason M6 was ranked this high. `fetchAdmin` returns
   `Promise<unknown>`, and the `no-unsafe-*` family targets **`any`**, not `unknown`: asserting
   `unknown as T` triggers nothing, and `JSON.parse`'s `any`, narrowed by `as T`, leaves no `any` to
   flag. What type-checked linting *would* catch is **L4** (floating promises), **L3** in part
   (`exhaustive-deps`), and `no-explicit-any`. **Status: a prediction, not a measurement** — derived
   from the rule semantics and the read signature, not from a lint run; settling it costs the first ten
   minutes of the work. M6 is still worth doing, but as a **preventive instrument over a cleaned tree**
   — so do **M5** first, or every finding on the dead normalizer gets triaged twice.
6. **M2** — convert request-reachable `expect()`s to fallible returns. (The `spawn_blocking` half of
   this item, **M1**, is done — see the M1 section for what was offloaded and what was left.)
7. **M5** — decide the dead TS normalizer's fate; do not leave a green test on unreached code.
8. **M4**, then the Low table.

---

## Method notes

Three instrument failures were caught and corrected during this audit, and they are recorded because
each would have produced a wrong finding:

1. **A dependency-usage scan returned `0` for every crate**, including `tokio` and `rusqlite`. The
   cause was BSD `grep` rejecting `\b` in ERE — an *empty* instrument, not a real absence. Re-run
   with plain patterns, it reported `tokio=393`, `rusqlite=147`. The all-zero result was discarded.
2. **A `grep` using `\|` alternation returned false zeros** for `quickjs` and `zod` in
   `router-core/src`, contradicting an earlier per-pattern count. The alternation form is unreliable
   in this shell; the claim was re-verified with the Grep tool, which found `quickjs-emscripten-core`
   genuinely in use (`code-adapter.ts:41-49`) and `zod` genuinely unused there.
3. **`objc2` was nearly reported as used** on the strength of its presence in `Cargo.lock`. It is
   there transitively via Tauri, which says nothing about the *direct* declaration. The finding was
   confirmed only after searching the crate for `objc2`, `NSProcessInfo`, `beginActivity` and
   `App Nap` and finding zero hits outside the lockfile.

Every High and Medium finding was verified by reading the cited file, not by inference from a
summary. Where a claim is bounded by reachability (M3, L1), the bound is stated rather than implied.
