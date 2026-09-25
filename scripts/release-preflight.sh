#!/usr/bin/env bash
# Release preflight — validates the Apple credential state before starting the build.
#
# Two valid states:
#   1. No Apple secrets set → the build will be ad-hoc signed. macOS Gatekeeper
#      will refuse to launch an ad-hoc app from an unidentified developer, so a
#      release without secrets is useful for development and self-distribution
#      on your own machine only. It is NOT a publicly distributable artefact.
#   2. All Apple secrets set → full Developer ID signing + notarization.
#      A draft Release that macOS will launch on other Macs.
#
# A half-configured state (some secrets present, others missing) is a defect:
# the build would sign with whatever is available and fail at notarization
# (the one step that actually proves the artefact is safe), producing a
# green job and a broken draft. This script catches that.
#
# This runs BEFORE the build, so a missing credential costs seconds instead
# of a 20-minute universal build. It never prints a secret value — only names
# and shapes.
#
# Usage: scripts/release-preflight.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json"

FAILURES=0
ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info(){ printf '  \033[33mINFO\033[0m  %s\n' "$1"; }

echo "== Release preflight"

# ---------------------------------------------------------------------------
# 1. Determine the credential state: ad-hoc or full.
#
# APPLE_SIGNING_IDENTITY is deliberately not counted in "all present": tauri
# derives it from the certificate, so requiring it would fail a correct setup.
# The five that matter are the ones without a derivation path.
# ---------------------------------------------------------------------------
REQUIRED=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
PRESENT=()
MISSING=()
for name in "${REQUIRED[@]}"; do
  if [ -n "${!name:-}" ]; then
    PRESENT+=("$name")
  else
    MISSING+=("$name")
  fi
done

if [ "${#PRESENT[@]}" -eq 0 ]; then
  info "No Apple credentials detected — the build will be ad-hoc signed."
  info "macOS Gatekeeper will refuse to launch an ad-hoc app from an unidentified developer."
  info "This is fine for self-distribution on your own machine; it is not a publicly distributable release."
  info "To produce a notarized, distributable release, set all five required secrets:"
  info "  ${REQUIRED[*]}"
  info "  (See CONTRIBUTING.md, 'Releasing' for how to obtain them.)"
elif [ "${#PRESENT[@]}" -eq "${#REQUIRED[@]}" ]; then
  ok "all ${#REQUIRED[@]} required secrets are set — full Developer ID signing + notarization will be attempted"
else
  bad "${#PRESENT[@]}/${#REQUIRED[@]} required secrets present: ${PRESENT[*]}"
  echo "        Missing: ${MISSING[*]}"
  echo "        All five required for notarization: ${REQUIRED[*]}"
  echo "        Either set them all (for a distributable release) or clear them all (for ad-hoc)."
  echo "        Half-configured credentials produce a build that signs but cannot notarize —"
  echo "        a green job and a broken draft release. See CONTRIBUTING.md, 'Releasing'."
fi

# ---------------------------------------------------------------------------
# 2. Validate the certificate, but only when both cert and password are present.
#
# In ad-hoc mode (no secrets) there is nothing to validate — the build will
# be ad-hoc signed and there is no certificate to check.
#
# In full mode, catch the two mistakes that a presence check cannot: a
# truncated base64 paste, and a certificate/password mismatch. Both would
# otherwise survive until the build's signing step and fail there, far
# from the cause.
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
# This rule holds in both ad-hoc and full modes: signing must come from the
# environment, never from the config. A pinned identity would be invisible
# to every check except this one, because no job outside release.yml runs a
# full `tauri build`.
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
  if [ "${#PRESENT[@]}" -eq "${#REQUIRED[@]}" ]; then
    echo "release-preflight: OK — full Developer ID signing + notarization will be attempted."
  else
    echo "release-preflight: OK — ad-hoc signed build (no notarization)."
  fi
  exit 0
fi
echo "release-preflight: $FAILURES check(s) FAILED — refusing to build with half-configured credentials." >&2
exit 1
