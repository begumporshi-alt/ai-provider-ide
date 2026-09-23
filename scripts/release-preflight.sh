#!/usr/bin/env bash
# Release preflight — refuses to start a release build that cannot produce a signed,
# notarized artifact.
#
# Why this exists: `tauri build` succeeds with no Apple secrets at all, and emits an
# ad-hoc signed app. Before this guard, a tag push with unprovisioned secrets produced a
# green job and a draft Release containing something macOS refuses to launch. The failure
# surfaced on a user's machine, not in CI. `docs/dev-book/05-workflow.md` warned about it
# in prose; nothing enforced it.
#
# This runs BEFORE the build, so a missing or malformed credential costs seconds instead
# of a 20-minute universal build. It never prints a secret value — only names and shapes.
#
# Usage: scripts/release-preflight.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json"

FAILURES=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

echo "== Release preflight"

# ---------------------------------------------------------------------------
# 1. Required secrets are present and non-empty.
#
# APPLE_SIGNING_IDENTITY is deliberately NOT required: tauri derives it from the
# certificate. Requiring it would fail a correct setup.
# ---------------------------------------------------------------------------
REQUIRED=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
MISSING=()
for name in "${REQUIRED[@]}"; do
  if [ -z "${!name:-}" ]; then
    MISSING+=("$name")
  fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  ok "all ${#REQUIRED[@]} required secrets are set"
else
  bad "${#MISSING[@]} required secret(s) missing: ${MISSING[*]}"
  echo "        Set them with: gh secret set <NAME>   (see CONTRIBUTING.md, 'Releasing')"
fi

# ---------------------------------------------------------------------------
# 2. The certificate actually decodes and opens with the given password.
#
# Catches the two mistakes that a presence check cannot: a truncated paste, and a
# certificate/password mismatch. Both would otherwise survive until the build's
# signing step and fail there, far from the cause.
# ---------------------------------------------------------------------------
if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  P12_TMP="$(mktemp -t aip-provider-cert)"
  # shellcheck disable=SC2064
  trap "rm -f '$P12_TMP'" EXIT

  if printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$P12_TMP" 2>/dev/null \
     && [ -s "$P12_TMP" ]; then
    ok "APPLE_CERTIFICATE is valid base64 ($(wc -c < "$P12_TMP" | tr -d ' ') bytes of DER)"
    if openssl pkcs12 -in "$P12_TMP" -passin "pass:$APPLE_CERTIFICATE_PASSWORD" \
         -nokeys -noout >/dev/null 2>&1; then
      ok "the .p12 opens with APPLE_CERTIFICATE_PASSWORD"
    else
      bad "the .p12 does NOT open with APPLE_CERTIFICATE_PASSWORD (wrong password, or not a .p12)"
    fi
  else
    bad "APPLE_CERTIFICATE is not valid base64 — re-export and re-paste it"
  fi
fi

# ---------------------------------------------------------------------------
# 3. No signing identity is pinned in tauri.conf.json.
#
# This is the rule that CI cannot otherwise catch: no job outside release.yml runs a
# full `tauri build`, so a pinned identity is invisible to every other check and a
# green push would prove nothing about signing. Enforced here, mechanically.
# ---------------------------------------------------------------------------
if [ -f "$CONF" ]; then
  PINNED=$(node -e '
    const c = require(process.argv[1]);
    const mac = (c.bundle && c.bundle.macOS) || {};
    const v = mac.signingIdentity;
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$CONF" 2>/dev/null || echo "__PARSE_ERROR__")

  if [ "$PINNED" = "__PARSE_ERROR__" ]; then
    bad "could not parse $CONF to check for a pinned signing identity"
  elif [ -n "$PINNED" ]; then
    bad "bundle.macOS.signingIdentity is pinned to '$PINNED' in tauri.conf.json"
    echo "        Signing must come from the environment. Remove the pin — see CONTRIBUTING.md."
  else
    ok "no signing identity pinned in tauri.conf.json"
  fi
else
  bad "missing $CONF"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "release-preflight: OK — the release can be signed and notarized."
  exit 0
fi
echo "release-preflight: $FAILURES check(s) FAILED — refusing to build an unsigned release." >&2
exit 1
