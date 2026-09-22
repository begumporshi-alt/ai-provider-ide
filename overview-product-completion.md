# Overview — what remains to ship this as a product (2026-09-22)

## What was done

Assessed the repo at `3bb7665` against what "a professional, shippable product" requires, and wrote the result
to **`docs/PRODUCT_COMPLETION_PLAN.md`** (305 lines).

Every claim in the plan carries a `file:line` or the command that produced it. External claims were checked
against the Tauri v2 documentation rather than recalled. Nothing was modified except adding that plan.

## The finding, in one line

**The engineering is much further along than the packaging.** Four test suites, a real local gate, an audit
trail and a working gateway — but no licence, no release pipeline, no changelog, no disclosure policy.

## What the evidence showed

| Area | State |
|---|---|
| Licence | **None.** Repo is public (`gh repo view` → `visibility: PUBLIC`), `licenseInfo: null` |
| Release pipeline | **None.** `.github/workflows/` holds only `ci.yml`; it never triggers on tags |
| CI vs the local gate | **CI is weaker.** `ci.yml` has no `pnpm build`; `ci-local.sh:85` does, and says why at `:83-85` |
| Auto-updater | **Documented, not implemented — and the docs are wrong for Tauri v2** |
| Linting | **None anywhere** — no ESLint, Prettier, rustfmt or clippy config |
| Version | Stated in 4 files; root says `0.0.0`, the other three say `1.0.0`, tag is `v1.0.0` |
| Governance | No `LICENSE`, `CHANGELOG`, `CONTRIBUTING`, `SECURITY.md` |
| Docs | 21 root-level `.md` files; `docs/` holds one |

## The three findings worth acting on today

1. **A public repo with no licence is legally all-rights-reserved** — nobody may fork or contribute. This is a
   decision, not a code change, and it is the single highest-leverage item.
2. **`v1.0.0` is a tag with nothing attached.** No release workflow exists, so the app is not downloadable.
3. **The updater docs describe a mechanism that is not there.** `SIGNING.md:35` claims `tauri.conf.json`
   "now includes" an `updater` block — it does not, and in Tauri v2 the block belongs under `plugins.updater`.
   `SIGNING.md:29` exports `TAURI_SIGNING_PUBLIC_KEY`, a variable that does not exist. And
   `generate-updater-keys.sh:9-14` generates an **RSA** pair via `openssl`, while Tauri verifies with
   **minisign/ed25519** keys from `tauri signer generate` — those keys cannot verify an update.

A document that describes update signing incorrectly is worse than no document, because it is the artefact a
future contributor trusts.

## Verified, and *not* a bug

- **`connect-src` omitting `http://127.0.0.1:*` is correct.** There is no `fetch(` in `apps/desktop/src` — the
  UI reaches the gateway over Tauri IPC, not HTTP. `Gateway.tsx:119` only formats the URL for display.
- **Least privilege is genuinely tight.** `capabilities/gateway.json` gives the hidden worker window only
  event listen/unlisten.

## Open decisions (in the plan, §8)

1. Licence — MIT vs Apache-2.0 *(Apache-2.0 recommended)*.
2. Updater — implement properly, or delete the docs/scripts? *(Recommendation: delete now.)*
3. Audience — does this go to other people? This answer changes the remaining work more than any other.
4. `cache_control` — build the `cached_tokens` measurement migration, or keep parked?

## Follow-up

No source file was changed, so no test run was needed. The next action is a decision, not a build.
