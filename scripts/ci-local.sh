#!/usr/bin/env bash
# Local mirror of the step set in .github/workflows/ci.yml, plus the
# `headless-service` job's feature-less build (see the `Headless service build` step below).
#
# Why this exists: CI runs on macos-14, but from ~2026-09-16 to 2026-09-21 it never started a job
# — every run failed in ~8s with "the job was not started because recent account payments have
# failed". That was the account's Actions billing, which applies to *private* usage. The repo is
# public now, so minutes are free and CI runs again: 3-7 minutes, real results. A ~9-second
# "failure" is that old signature, not a test result.
#
# It still earns its place. It runs the same step set as ci.yml -- plus the `headless-service`
# job's feature-less build, which ci.yml runs as a separate 3-OS job -- so it answers "would CI
# pass?" in a few minutes rather than waiting on a runner queue, and it is the only gate if
# Actions is unavailable again.
#
# Usage:
#   bash scripts/ci-local.sh                 # the whole gate
#   bash scripts/ci-local.sh --skip-browser  # omit the Playwright harness (~48s)
#   bash scripts/ci-local.sh --install       # also run `pnpm install --frozen-lockfile` first
#
# --install is OFF by default on purpose. CI runs it because it starts from an empty checkout;
# a working tree already has node_modules, and here the install is not merely redundant but
# destructive: the sandbox broker denies pnpm's symlink writes (ERR_PNPM_CODEBUDDY_BROKER_DENY,
# EEXIST), and it fails *half way through* having already unlinked entries -- it left
# packages/{adapter-spec,router-core}/node_modules/typescript missing, which broke `pnpm
# typecheck` with MODULE_NOT_FOUND. Run it only when dependencies genuinely changed, and be
# ready to re-link by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
TAURI_MANIFEST="apps/desktop/src-tauri/Cargo.toml"
SKIP_BROWSER=0
DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-browser) SKIP_BROWSER=1 ;;
    --install)      DO_INSTALL=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The sandbox proxy makes every outbound call fail with "502 upstream connect failed", which
# looks like a broken upstream rather than a proxy that should not be there.
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

FAILED=()
step() {
  local name="$1"; shift
  printf '\n=== %s ===\n' "$name"
  if "$@"; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"
    FAILED+=("$name")
  fi
}

# --- Preflight ------------------------------------------------------------------------------
# Node 18 exposes globalThis.crypto, so probing for it does not detect this. But under Node 18
# every crypto.randomUUID() in provider-registry.ts throws "crypto is not defined" and 27
# router-core tests fail in a way that looks exactly like a regression. Node >= 19 is required.
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 19 ]; then
  echo "ERROR: node $NODE_MAJOR detected; this workspace needs Node >= 19." >&2
  echo "       Under Node 18 the test suite dies with 'crypto is not defined'." >&2
  echo "       Put the managed Node first:" >&2
  echo "         export PATH=\"\$HOME/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin:\$PATH\"" >&2
  exit 1
fi
echo "node $(node -v)"

# --- Gate -----------------------------------------------------------------------------------
if [ "$DO_INSTALL" -eq 1 ]; then
  step "Install JS deps"      pnpm install --frozen-lockfile
else
  echo "SKIP pnpm install (default; pass --install to run it)"
fi
# `--audit-level=moderate`, raised from `high` on 2026-09-22 when the vitest bump landed and cleared
# GHSA-82fw-gwwq-j7x9 (vulnerable >=2.1.0 <4.1.11; vitest is now ^4.1.11 in all three manifests).
# See docs/PRODUCT_COMPLETION_PLAN.md §3.2.
# Second, to mirror ci.yml exactly (drift register D5). A bad advisory should fail the gate in
# seconds, not after the whole suite has run.
step "Dependency audit"       pnpm audit --audit-level=moderate
step "Typecheck"              pnpm typecheck
step "Unit tests"             pnpm test
# Both mirrors now build the bundle, and they are not the same check. `pnpm build` is
# `build:clean && tsc && vite build` -- TypeScript and Vite only, no cargo and no bundler -- so
# a bundling error survives it. Measured 2026-09-23: adding a second `[[bin]]` broke
# `tauri build` with "failed to find main binary" while `pnpm build`, `cargo check`, `cargo
# test`, `cargo clippy` and `cargo fmt --check` were ALL green. See drift register D14.
step "Build"                  pnpm build
# `--bundles app` deliberately skips the DMG step, which needs AppleScript and is not what this
# gate is testing. `tauri build` runs `beforeBuildCommand` (`pnpm build`) itself, so the step
# above is a fast-fail for the frontend rather than a prerequisite for this one.
step "Tauri build"            pnpm --filter ai-provider-router-desktop tauri build --bundles app
step "Key-leak grep"          pnpm key-leak-grep
step "Single TypeScript ver"  pnpm check-ts-version
step "One product version"    pnpm check-version-sync
# A relative link or image that does not resolve is invisible until someone clicks it.
# See docs/dev-book/07-drift-register.md D9.
step "Doc links resolve"      pnpm check-doc-links
# `docs:book` validates structure as well as rendering, and it is a *different* check from the one
# above: `check-doc-links` resolves links, this parses tables and rejects a row that disagrees with
# its header. Measured 2026-09-23: an escaped pipe written inside a code span split one row into
# four cells, `docs:book` failed, and every other step in this gate stayed green -- which is how a
# broken table reaches a reader looking like a merely ugly one. It runs after the link check so a
# dead link is reported before a render error.
step "Dev book builds"        pnpm docs:book

if command -v cargo >/dev/null 2>&1; then
  # Stated, not assumed. The lint set moves with the toolchain -- 1.88 was clean here and 1.98
  # found four more lints -- so the gate should say which toolchain it ran against rather than
  # leave that to be inferred from the lints. The Rust half of the `node -v` line above.
  rustc --version
  # Formatting first: it is the cheapest check in this block and the only one that is
  # a no-op whenever the tree is already formatted. `--check` never writes a file.
  # The config it reads is apps/desktop/src-tauri/rustfmt.toml -- see that file for
  # why `use_small_heuristics = "Max"` is the one non-default setting.
  step "Rust fmt"             cargo fmt   --manifest-path "$ROOT/$TAURI_MANIFEST" --check
  step "Rust check"           cargo check --manifest-path "$ROOT/$TAURI_MANIFEST"
  # `--all-targets` and `-D warnings`, matching ci.yml exactly (drift register D5). The test
  # targets matter: the two dead branches this step was added to clear were both invisible to a
  # lib-only lint, and one of them sat on a path no test reached.
  step "Rust clippy"          cargo clippy --manifest-path "$ROOT/$TAURI_MANIFEST" --all-targets -- -D warnings
  step "Rust tests"           cargo test  --manifest-path "$ROOT/$TAURI_MANIFEST"
  # The service must build with the Tauri glue switched off -- that is the entire claim of the
  # `app` feature, and it is a different build from the default one above: `default = ["app"]`
  # means the flagless command still compiles Tauri. Mirrors the `headless-service` CI job,
  # which passes the same flag on all three platforms. Without this, the local gate answers
  # "would CI pass?" with a no for the one job it does not model.
  step "Headless service build" cargo build --manifest-path "$ROOT/$TAURI_MANIFEST" --bin aiproviderd --release --no-default-features
  # D17. The build above compiles the *binary*, and a binary target does not compile the lib's
  # `cfg(test)` code -- so a `cfg(test)` dependency on the gated-out `app` feature stayed invisible.
  # There were 33 of them: `persist.rs`'s three test modules call app-gated readers, and one shared
  # test helper went dead once those were gated. `--all-targets` compiles the test target in the
  # same configuration, which is what makes "`core/` is Tauri-free" cover the tests too. The flag is
  # the whole of the difference from the step above, and it is the flag whose absence was D17.
  step "Headless targets check" cargo check --manifest-path "$ROOT/$TAURI_MANIFEST" --no-default-features --all-targets
  # ci.yml's `headless-service` job has four steps and this gate models three. The third asserts
  # the binary *starts*, not merely that it builds -- and building is not starting: a change that
  # links but dies on startup passed this gate and failed CI. `--version` is the whole of the
  # assertion on purpose; ci.yml records why (no port, no keychain approval, no store, so it cannot
  # flake, and it still proves the binary links). Path resolution is the part that already broke
  # once in CI: `working-directory` there is `apps/desktop/src-tauri`, so this resolves the same
  # way the build step above does rather than against the repo root, and a missing binary is a
  # named error rather than a bare `command not found`. ci.yml also probes `aiproviderd.exe` for
  # its Windows leg; there is no `.exe` to find here. The job's first step is a Linux-only apt
  # install with no local counterpart by design.
  headless_binary_runs() {
    local bin="$ROOT/apps/desktop/src-tauri/target/release/aiproviderd"
    test -f "$bin" || { echo "service binary not found at $bin" >&2; return 1; }
    "$bin" --version
  }
  step "Service binary runs"  headless_binary_runs
else
  echo "SKIP Rust check/tests — cargo not on PATH (export PATH=\"\$HOME/.cargo/bin:\$PATH\")"
  FAILED+=("Rust (cargo missing)")
fi

if [ "$SKIP_BROWSER" -eq 0 ]; then
  # A stale test-results dir is read back as evidence of a run that did not happen.
  if [ -d apps/desktop/test-results ]; then
    mv apps/desktop/test-results "/tmp/ci-local-test-results-$(date +%s)"
  fi
  step "Install Playwright"   pnpm --filter ai-provider-router-desktop exec playwright install chromium
  step "Live-UI tests"        pnpm --filter ai-provider-router-desktop web-test
else
  echo "SKIP browser tests (--skip-browser)"
fi

# --- Summary --------------------------------------------------------------------------------
printf '\n================ GATE ================\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "ALL GREEN — this is what CI would report."
  exit 0
fi
echo "FAILED (${#FAILED[@]}):"
printf '  - %s\n' "${FAILED[@]}"
exit 1
