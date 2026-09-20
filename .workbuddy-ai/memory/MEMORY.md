# Project memory — AI-Provider Router IDE

**Index only. `REFERENCE.md` here holds the depth — read the matching section first.**

## Non-negotiables
- Verify every edit by reading it back — success messages have lied.
- Prove a spec fails before trusting it passes (flip the code back).
- Measure before recording a cause.
- Never trust a diagnostic message's own asserted cause.
- Sandbox proxy lies: unset `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` on probe *and* app,
  or every call returns `502 upstream connect failed`.
- Bash `grep` shim is unreliable even for plain patterns — use the Grep tool; verify a "not found".
- Use `./node_modules/.bin/tsc`, never `npx tsc`.
- Run JS tests with **managed Node 22** first on PATH.

## Where the depth lives (REFERENCE.md)
| Topic | Section |
|---|---|
| Build / install / verify installed app | Build / install / verify the installed app |
| Testing, counts, vitest include globs | Testing · Test counts |
| Browser harness (`web-test`) | Browser harness |
| Gateway behaviour, error status, keychain | Gateway behaviour · Error status propagation · Keychain |
| Ledger honesty | The ledger must not lie |
| Migrations, live DB | Migrations · Live database |
| Context graph rules | Context graph |
| Skills / orchestrator / memory | Skills · orchestrator · memory engine |
| Sandbox tool policy + audit trail | Sandbox tool policy · Gateway tool audit trail |
| Gate, and why CI is dead | `pnpm ci:local` · CI is dead |
| e2e LIVE, `pnpm install` destructive | Gotchas that each cost real time |
| Version bump, tag, push | Releasing / bumping the version |

## Quick orientation
- Playground screen = **Assistant** (`assistant`, `screens/Assistant.tsx`).
- Gateway is a blind proxy for `system`; **skills are frontend-only** (`Assistant.tsx`).
- Live DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db` —
  `file:…?mode=ro`; version in `schema_version`, not `PRAGMA user_version`.
- Tests: router-core 231 · desktop 151 · Rust `cargo test --lib` **267** · browser 53.
- Gate is `pnpm ci:local`. CI has not started a job since ~2026-09-16 (billing, not code).

## Rules that each cost a bug
- Pass the identity a thing already has; a generated node id is a silent no-op for dedupe. Never
  match nodes on label (80-char truncation).
- `runAgentLoop` returns `{text, messages}` where `messages` EXCLUDES the closing assistant turn.
- A tool failure must never reach the model as `""` — guard at bridge *and* consumer.
- `invalid` is an eviction, not a label (`src/lib/keys/verdict.ts`).
- Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump hardcoded `schema_version` + update the count
  assertion. Rewind tests delete `WHERE version >= N`.
- Nav = three edits: `ui-state.ts`, `Shell.tsx`, `App.tsx`.
- `panic = "abort"` — never write poison handling for `.lock().unwrap()`.
- A debounced save reads state when it **fires** (latest-ref), not when scheduled.
- Clamp user numbers from numbers/numeric strings only.
- Recover from stored data, never invent it.
