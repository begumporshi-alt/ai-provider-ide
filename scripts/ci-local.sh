#!/usr/bin/env bash
# Local mirror of .github/workflows/ci.yml.
#
# Why this exists: CI runs on macos-14, but from ~2026-09-16 to 2026-09-21 it never started a job
# — every run failed in ~8s with "the job was not started because recent account payments have
# failed". That was the account's Actions billing, which applies to *private* usage. The repo is
# public now, so minutes are free and CI runs again: 3-7 minutes, real results. A ~9-second
# "failure" is that old signature, not a test result.
#
# It still earns its place. It runs the same steps in the same order as ci.yml, so it answers
# "would CI pass?" in ~3 minutes rather than waiting on a runner queue, and it is the only gate if
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
step "Typecheck"              pnpm typecheck
step "Unit tests"             pnpm test
# ci.yml has no build step at all, so nothing in CI would catch a bundle that no
# longer compiles -- typecheck passing does not mean vite can bundle it.
step "Build"                  pnpm build
step "Key-leak grep"          pnpm key-leak-grep
step "Single TypeScript ver"  pnpm check-ts-version

if command -v cargo >/dev/null 2>&1; then
  step "Rust check"           cargo check --manifest-path "$ROOT/$TAURI_MANIFEST"
  step "Rust tests"           cargo test  --manifest-path "$ROOT/$TAURI_MANIFEST"
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
